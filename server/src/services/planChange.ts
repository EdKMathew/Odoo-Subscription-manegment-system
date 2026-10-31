import { prisma } from '../lib/prisma';
import { badRequest, conflict, notFound } from '../lib/errors';
import { addDays, addPeriod, DAY_MS, startOfDay } from '../lib/dates';
import { nextNumber } from '../lib/numbering';
import { formatINR } from '../lib/money';
import type { AuthUser } from '../middleware/auth';
import { loadPricingContext, priceSubscription, subscriptionPricingInclude, type PricedInvoice } from './pricing';
import { logEvent, monthlyValue } from './subscriptions';
import { applyOpenCredits, issueCreditNote, markCreditsUsed } from './credits';

// Plan changes on an active subscription.
// Upgrade (higher monthly value): starts today. The unused part of the period
// already invoiced becomes a credit note, a new billing cycle starts on the new
// plan, and the credit is deducted from that first invoice.
// Downgrade: scheduled for the next billing date, so the customer keeps what
// they paid for; the billing run switches the plan then.
async function plan(subscriptionId: number, planId: number) {
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId }, include: subscriptionPricingInclude });
  if (!sub) throw notFound('Subscription not found');
  if (sub.status !== 'ACTIVE' || !sub.nextBillingDate) throw conflict('Only active subscriptions can change plan');
  if (sub.planId === planId) throw badRequest('This is already the current plan');
  const target = await prisma.plan.findUnique({ where: { id: planId } });
  const now = new Date();
  if (!target || !target.active) throw badRequest('Plan not found');
  if ((target.availableFrom && target.availableFrom > now) || (target.availableTo && target.availableTo < now)) {
    throw badRequest('That plan is not available right now');
  }
  const qty = sub.lines.reduce((s, l) => s + l.quantity, 0);
  if (qty < target.minQuantity) throw badRequest(`${target.name} needs a minimum quantity of ${target.minQuantity}`);

  const before = monthlyValue(sub.plan, sub.lines);
  const after = monthlyValue(target, sub.lines);
  const kind: 'UPGRADE' | 'DOWNGRADE' = after > before ? 'UPGRADE' : 'DOWNGRADE';
  const today = startOfDay();

  let credit: { amount: number; tax: number; explanation: string; invoiceId: number } | null = null;
  let invoice: PricedInvoice | null = null;
  if (kind === 'UPGRADE') {
    // Unused share of the invoice covering the current period.
    const periodEnd = startOfDay(sub.nextBillingDate);
    const periodStart = addPeriod(periodEnd, sub.plan.billingPeriod, -1);
    const current = await prisma.invoice.findFirst({
      where: { subscriptionId, status: { in: ['DRAFT', 'CONFIRMED', 'PAID'] }, periodStart: { gte: periodStart, lt: periodEnd } },
      orderBy: { periodStart: 'desc' },
    });
    const periodDays = Math.max(1, Math.round((periodEnd.getTime() - periodStart.getTime()) / DAY_MS));
    const unusedDays = Math.min(periodDays, Math.max(0, Math.round((periodEnd.getTime() - today.getTime()) / DAY_MS)));
    if (current && unusedDays > 0 && current.total > 0) {
      const amount = Math.round((current.total * unusedDays) / periodDays);
      credit = {
        amount,
        tax: Math.round((amount * current.taxTotal) / current.total),
        explanation: `${unusedDays} of ${periodDays} unused days on ${current.number}`,
        invoiceId: current.id,
      };
    }
    const ctx = await loadPricingContext(prisma, today);
    invoice = priceSubscription({ ...sub, plan: target }, ctx);
  }
  return { sub, target, kind, before, after, credit, invoice, today };
}

export async function previewPlanChange(subscriptionId: number, planId: number) {
  const p = await plan(subscriptionId, planId);
  // Show the first invoice with this credit (and any other open credit) already deducted.
  let invoice = p.invoice;
  if (invoice && p.credit) {
    const creditLine = {
      productId: null,
      description: 'Credit for unused time',
      explanation: p.credit.explanation,
      quantity: 1,
      unitPrice: -(p.credit.amount - p.credit.tax),
      discountAmount: 0,
      taxRateBp: 0,
      taxAmount: -p.credit.tax,
      amount: -Math.min(p.credit.amount, invoice.total),
    };
    const applied = -creditLine.amount;
    invoice = {
      ...invoice,
      lines: [...invoice.lines, { ...creditLine, amount: -applied }],
      subtotal: invoice.subtotal - (applied - p.credit.tax),
      taxTotal: invoice.taxTotal - p.credit.tax,
      total: invoice.total - applied,
    };
  }
  return {
    kind: p.kind,
    fromPlan: p.sub.plan.name,
    toPlan: p.target.name,
    effectiveDate: p.kind === 'UPGRADE' ? p.today : p.sub.nextBillingDate,
    monthlyBefore: p.before,
    monthlyAfter: p.after,
    credit: p.credit ? { amount: p.credit.amount, explanation: p.credit.explanation } : null,
    invoice,
  };
}

export async function applyPlanChange(subscriptionId: number, planId: number, actor: AuthUser) {
  const p = await plan(subscriptionId, planId);
  if (actor.role === 'CUSTOMER' && p.kind === 'UPGRADE') throw conflict('Upgrades are handled by our team. Please contact us.');

  if (p.kind === 'DOWNGRADE') {
    await prisma.$transaction(async (tx) => {
      await tx.subscription.update({ where: { id: subscriptionId }, data: { pendingPlanId: p.target.id } });
      await logEvent(
        tx,
        subscriptionId,
        { type: 'PLAN', message: `Downgrade to ${p.target.name} scheduled for ${p.sub.nextBillingDate!.toDateString()}` },
        actor,
      );
    });
    return { message: `Switching to ${p.target.name} on ${p.sub.nextBillingDate!.toDateString()}. No charge now.` };
  }

  const nextBilling = addPeriod(p.today, p.target.billingPeriod);
  const created = await prisma.$transaction(async (tx) => {
    if (p.credit) {
      await issueCreditNote(
        tx,
        {
          customerId: p.sub.customerId,
          subscriptionId,
          invoiceId: p.credit.invoiceId,
          reason: `Unused time on ${p.sub.plan.name} after upgrade`,
          total: p.credit.amount,
          taxAmount: p.credit.tax,
        },
        actor,
      );
    }
    const { priced, used } = await applyOpenCredits(tx, p.sub.customerId, p.invoice!);
    const now = new Date();
    const invoice = await tx.invoice.create({
      data: {
        number: await nextNumber(tx, 'INV'),
        subscriptionId,
        customerId: p.sub.customerId,
        status: 'DRAFT',
        // Exact timestamp keeps it apart from a regular invoice that started today.
        periodStart: now,
        periodEnd: addDays(nextBilling, -1),
        dueDate: addDays(p.today, p.sub.paymentTermDays),
        subtotal: priced.subtotal,
        discountTotal: priced.discountTotal,
        taxTotal: priced.taxTotal,
        total: priced.total,
        taxSplit: priced.taxSplit,
        lines: { create: priced.lines },
      },
    });
    await markCreditsUsed(tx, invoice.id, used);
    await tx.subscription.update({
      where: { id: subscriptionId },
      data: { planId: p.target.id, pendingPlanId: null, nextBillingDate: nextBilling },
    });
    await logEvent(
      tx,
      subscriptionId,
      {
        type: 'PLAN',
        message: `Upgraded from ${p.sub.plan.name} to ${p.target.name}. Invoice ${invoice.number} for ${formatINR(invoice.total)}${p.credit ? ` after ${formatINR(p.credit.amount)} credit for unused time` : ''}`,
        mrrKind: 'EXPANSION',
        mrrDelta: p.after - p.before,
      },
      actor,
    );
    return invoice;
  });
  return { message: `Upgraded to ${p.target.name}. Invoice ${created.number} for ${formatINR(created.total)} created as a draft.`, invoiceId: created.id };
}
