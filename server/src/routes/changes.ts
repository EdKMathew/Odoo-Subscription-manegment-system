import { Router, type Request } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, conflict, notFound } from '../lib/errors';
import { customerScope, requireAuth, staffOnly } from '../middleware/auth';
import { idParam } from '../lib/paging';
import { addDays, addPeriod, DAY_MS, startOfDay } from '../lib/dates';
import { nextNumber } from '../lib/numbering';
import { formatINR } from '../lib/money';
import { priceSubscription, subscriptionPricingInclude, type PricedLine, type SubscriptionForPricing } from '../services/pricing';
import { logEvent, monthlyValue } from '../services/subscriptions';
import { applyPlanChange, previewPlanChange } from '../services/planChange';

// Mid-cycle quantity changes on an active subscription.
// Increases are charged now for the days left in the current period (prorated);
// decreases take effect from the next billing date, with no refund for the current period.
const router = Router();
router.use(requireAuth);

const changeSchema = z.object({
  lines: z
    .array(z.object({ lineId: z.number().int().positive(), quantity: z.number().int().min(1).max(100000) }))
    .min(1)
    .max(50),
});

async function buildChange(id: number, input: z.infer<typeof changeSchema>) {
  const sub = await prisma.subscription.findUnique({ where: { id }, include: subscriptionPricingInclude });
  if (!sub) throw notFound('Subscription not found');
  if (sub.status !== 'ACTIVE' || !sub.nextBillingDate) throw conflict('Only active subscriptions can be changed mid-cycle');

  const today = startOfDay();
  const periodEnd = startOfDay(sub.nextBillingDate);
  const periodStart = addPeriod(periodEnd, sub.plan.billingPeriod, -1);
  const periodDays = Math.max(1, Math.round((periodEnd.getTime() - periodStart.getTime()) / DAY_MS));
  const remainingDays = Math.min(periodDays, Math.max(0, Math.round((periodEnd.getTime() - today.getTime()) / DAY_MS)));
  const ratio = remainingDays / periodDays;

  const newQty = new Map(input.lines.map((l) => [l.lineId, l.quantity]));
  for (const lineId of newQty.keys()) {
    if (!sub.lines.some((l) => l.id === lineId)) throw badRequest('Line does not belong to this subscription');
  }
  const totalAfter = sub.lines.reduce((s, l) => s + (newQty.get(l.id) ?? l.quantity), 0);
  if (totalAfter < sub.plan.minQuantity) throw badRequest(`This plan needs a minimum quantity of ${sub.plan.minQuantity}`);

  const increases = sub.lines.filter((l) => (newQty.get(l.id) ?? l.quantity) > l.quantity);
  const decreases = sub.lines
    .filter((l) => (newQty.get(l.id) ?? l.quantity) < l.quantity)
    .map((l) => ({ lineId: l.id, description: l.description, from: l.quantity, to: newQty.get(l.id)!, effective: periodEnd }));

  // Price only the added units, then scale by the share of the period left.
  const extraOnly = {
    ...sub,
    plan: { ...sub.plan, price: 0 },
    lines: increases.map((l) => ({ ...l, quantity: newQty.get(l.id)! - l.quantity })),
  } as SubscriptionForPricing;
  const defaultTax = await prisma.taxRule.findFirst({ where: { isDefault: true, active: true } });
  const full = priceSubscription(extraOnly, { defaultTax, discounts: [] });

  const charges: PricedLine[] = full.lines.map((l) => {
    const taxable = Math.round((l.amount - l.taxAmount) * ratio);
    const taxAmount = Math.round(l.taxAmount * ratio);
    return {
      ...l,
      description: `${l.description} (added mid-cycle)`,
      explanation: `${l.explanation} · prorated ${remainingDays}/${periodDays} days`,
      unitPrice: Math.round(l.unitPrice * ratio),
      discountAmount: 0,
      taxAmount,
      amount: taxable + taxAmount,
    };
  });
  const subtotal = charges.reduce((s, l) => s + l.amount - l.taxAmount, 0);
  const taxTotal = charges.reduce((s, l) => s + l.taxAmount, 0);

  return {
    sub,
    newQty,
    preview: {
      periodStart,
      periodEnd,
      periodDays,
      remainingDays,
      charges,
      subtotal,
      taxTotal,
      total: subtotal + taxTotal,
      taxSplit: full.taxSplit,
      decreases,
    },
  };
}

router.post(
  '/:id/preview',
  staffOnly,
  asyncHandler(async (req, res) => {
    const { preview } = await buildChange(idParam(req), changeSchema.parse(req.body));
    res.json(preview);
  }),
);

router.post(
  '/:id/apply',
  staffOnly,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { sub, newQty, preview } = await buildChange(id, changeSchema.parse(req.body));
    const invoice = await prisma.$transaction(async (tx) => {
      for (const [lineId, quantity] of newQty) {
        await tx.subscriptionLine.update({ where: { id: lineId }, data: { quantity } });
      }
      const changes = sub.lines
        .filter((l) => newQty.has(l.id) && newQty.get(l.id) !== l.quantity)
        .map((l) => `${l.description} ${l.quantity} → ${newQty.get(l.id)}`)
        .join(', ');
      if (!changes) throw badRequest('Nothing changed');
      let created = null;
      if (preview.total > 0) {
        const now = new Date();
        created = await tx.invoice.create({
          data: {
            number: await nextNumber(tx, 'INV'),
            subscriptionId: id,
            customerId: sub.customerId,
            status: 'DRAFT',
            // Exact timestamp keeps it separate from the regular invoice for this period.
            periodStart: now,
            periodEnd: addDays(preview.periodEnd, -1),
            dueDate: addDays(startOfDay(now), sub.paymentTermDays),
            subtotal: preview.subtotal,
            taxTotal: preview.taxTotal,
            total: preview.total,
            taxSplit: preview.taxSplit,
            lines: { create: preview.charges },
          },
        });
      }
      const mrrDelta =
        monthlyValue(sub.plan, sub.lines.map((l) => ({ ...l, quantity: newQty.get(l.id) ?? l.quantity }))) - monthlyValue(sub.plan, sub.lines);
      await logEvent(
        tx,
        id,
        {
          type: 'CHANGE',
          message: `Quantities changed: ${changes}${created ? `. Prorated invoice ${created.number} for ${formatINR(created.total)}` : ''}${preview.decreases.length ? '. Reductions apply from the next billing date' : ''}`,
          mrrKind: mrrDelta >= 0 ? 'EXPANSION' : 'CONTRACTION',
          mrrDelta,
        },
        req.user!,
      );
      return created;
    });
    res.json({ ok: true, invoiceId: invoice?.id ?? null });
  }),
);

// ---------- Plan changes (staff, or the customer for downgrades) ----------

const planSchema = z.object({ planId: z.number().int().positive() });

async function ownedSubscription(req: Request, id: number) {
  const own = customerScope(req);
  if (own) {
    const sub = await prisma.subscription.findUnique({ where: { id }, select: { customerId: true, status: true } });
    if (!sub || sub.customerId !== own || sub.status === 'DRAFT') throw notFound('Subscription not found');
  }
}

router.post(
  '/:id/plan-preview',
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    await ownedSubscription(req, id);
    res.json(await previewPlanChange(id, planSchema.parse(req.body).planId));
  }),
);

router.post(
  '/:id/plan-apply',
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    await ownedSubscription(req, id);
    res.json(await applyPlanChange(id, planSchema.parse(req.body).planId, req.user!));
  }),
);

export default router;
