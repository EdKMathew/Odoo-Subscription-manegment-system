import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { addDays, addPeriod, startOfDay } from '../lib/dates';
import { nextNumber } from '../lib/numbering';
import { formatINR } from '../lib/money';
import { queueEmail } from '../lib/outbox';
import { config } from '../config';
import { loadPricingContext, priceSubscription, subscriptionPricingInclude, type PricedInvoice } from './pricing';
import { logEvent } from './subscriptions';

export interface BillingFlag {
  subscriptionId: number;
  number: string;
  customer: string;
  reasons: string[];
}

export interface BillingSummary {
  dryRun: boolean;
  runDate: string;
  invoiceCount: number;
  totalAmount: number;
  taxAmount: number;
  discountAmount: number;
  flagged: BillingFlag[];
  skippedAlreadyBilled: number;
  closed: number;
  items: { subscriptionId: number; number: string; customer: string; total: number; periodStart: string }[];
}

const BATCH = 200;
const MAX_PERIODS_PER_RUN = 12;

// Bills every active subscription whose next billing date has arrived.
// With dryRun, nothing is written and the same summary is returned as a preview.
// The unique (subscriptionId, periodStart) constraint makes double billing impossible.
export async function runBilling(opts: { dryRun: boolean; triggeredBy: string; asOf?: Date }): Promise<BillingSummary & { runId?: number }> {
  const today = startOfDay(opts.asOf ?? new Date());
  const ctx = await loadPricingContext(prisma, today);
  const usage = new Map<number, number>();

  const summary: BillingSummary = {
    dryRun: opts.dryRun,
    runDate: today.toISOString(),
    invoiceCount: 0,
    totalAmount: 0,
    taxAmount: 0,
    discountAmount: 0,
    flagged: [],
    skippedAlreadyBilled: 0,
    closed: 0,
    items: [],
  };

  const run = opts.dryRun
    ? null
    : await prisma.billingRun.create({
        data: { dryRun: false, triggeredBy: opts.triggeredBy, invoiceCount: 0, totalAmount: 0, flaggedCount: 0, summary: {} },
      });

  let cursor = 0;
  for (;;) {
    const subs = await prisma.subscription.findMany({
      where: { status: 'ACTIVE', nextBillingDate: { lte: today }, id: { gt: cursor } },
      include: subscriptionPricingInclude,
      orderBy: { id: 'asc' },
      take: BATCH,
    });
    if (!subs.length) break;
    cursor = subs[subs.length - 1].id;

    const lastTotals = await previousTotals(subs.map((s) => s.id));

    for (const sub of subs) {
      // Discounts whose usage limit is used up during this run stop applying.
      const discounts = ctx.discounts.filter((d) => d.usageLimit == null || d.usedCount + (usage.get(d.id) ?? 0) < d.usageLimit);
      let periodStart = startOfDay(sub.nextBillingDate!);
      let periods = 0;

      while (periodStart <= today && periods < MAX_PERIODS_PER_RUN) {
        if (sub.expiryDate && periodStart >= startOfDay(sub.expiryDate)) break;
        const periodEnd = addDays(addPeriod(periodStart, sub.plan.billingPeriod), -1);
        const priced = priceSubscription(sub, { ...ctx, discounts });
        const reasons = flagReasons(priced, lastTotals.get(sub.id), discounts, today);

        if (opts.dryRun) {
          record(summary, sub, priced, periodStart, reasons);
        } else {
          const created = await createInvoice(sub, priced, periodStart, periodEnd, run!.id);
          if (created) record(summary, sub, priced, periodStart, reasons);
          else summary.skippedAlreadyBilled++;
        }
        for (const id of priced.appliedDiscountIds) usage.set(id, (usage.get(id) ?? 0) + 1);
        periodStart = addPeriod(periodStart, sub.plan.billingPeriod);
        periods++;
      }

      if (!opts.dryRun) {
        const expired = sub.expiryDate && periodStart >= startOfDay(sub.expiryDate);
        await prisma.$transaction(async (tx) => {
          if (expired && sub.plan.autoClose) {
            await tx.subscription.update({
              where: { id: sub.id },
              data: { status: 'CLOSED', closedAt: new Date(), closeReason: 'Expired (auto-close)', nextBillingDate: null },
            });
            await logEvent(tx, sub.id, { type: 'STATUS', fromStatus: 'ACTIVE', toStatus: 'CLOSED', message: 'Closed automatically at expiry' }, null);
          } else {
            await tx.subscription.update({ where: { id: sub.id }, data: { nextBillingDate: expired ? null : periodStart } });
          }
        });
        if (expired && sub.plan.autoClose) summary.closed++;
      } else if (sub.expiryDate && periodStart >= startOfDay(sub.expiryDate) && sub.plan.autoClose) {
        summary.closed++;
      }
    }
  }

  if (!opts.dryRun) {
    // Count discount usage so limits are enforced on later runs.
    for (const [id, count] of usage) {
      await prisma.discount.update({ where: { id }, data: { usedCount: { increment: count } } });
    }
    await prisma.billingRun.update({
      where: { id: run!.id },
      data: {
        invoiceCount: summary.invoiceCount,
        totalAmount: summary.totalAmount,
        flaggedCount: summary.flagged.length,
        summary: { ...summary, items: summary.items.slice(0, 200) } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  return { ...summary, items: summary.items.slice(0, 200), runId: run?.id };
}

function record(
  summary: BillingSummary,
  sub: { id: number; number: string; customer: { name: string } },
  priced: PricedInvoice,
  periodStart: Date,
  reasons: string[],
) {
  summary.invoiceCount++;
  summary.totalAmount += priced.total;
  summary.taxAmount += priced.taxTotal;
  summary.discountAmount += priced.discountTotal;
  summary.items.push({ subscriptionId: sub.id, number: sub.number, customer: sub.customer.name, total: priced.total, periodStart: periodStart.toISOString() });
  if (reasons.length) {
    const existing = summary.flagged.find((f) => f.subscriptionId === sub.id);
    if (existing) existing.reasons = [...new Set([...existing.reasons, ...reasons])];
    else summary.flagged.push({ subscriptionId: sub.id, number: sub.number, customer: sub.customer.name, reasons });
  }
}

// Things a finance person should eyeball before invoices go out.
function flagReasons(
  priced: PricedInvoice,
  lastTotal: number | undefined,
  discounts: { id: number; name: string; endDate: Date | null }[],
  today: Date,
) {
  const reasons: string[] = [];
  if (priced.total === 0) reasons.push('Zero amount');
  if (priced.missingTax) reasons.push('Missing tax');
  if (lastTotal && lastTotal > 0 && priced.total > lastTotal * 1.3) {
    reasons.push(`Up ${Math.round(((priced.total - lastTotal) / lastTotal) * 100)}% since last invoice`);
  }
  const soon = addDays(today, 7);
  for (const id of priced.appliedDiscountIds) {
    const d = discounts.find((x) => x.id === id);
    if (d?.endDate && d.endDate <= soon) reasons.push(`Discount "${d.name}" expires soon`);
  }
  return reasons;
}

async function previousTotals(subscriptionIds: number[]) {
  if (!subscriptionIds.length) return new Map<number, number>();
  const rows = await prisma.$queryRaw<{ subscriptionId: number; total: number }[]>`
    SELECT DISTINCT ON ("subscriptionId") "subscriptionId", "total"
    FROM "Invoice"
    WHERE "subscriptionId" IN (${Prisma.join(subscriptionIds)}) AND "status" <> 'CANCELLED'
    ORDER BY "subscriptionId", "periodStart" DESC`;
  return new Map(rows.map((r) => [r.subscriptionId, Number(r.total)]));
}

type SubForBilling = Prisma.SubscriptionGetPayload<{ include: typeof subscriptionPricingInclude }>;

async function createInvoice(sub: SubForBilling, priced: PricedInvoice, periodStart: Date, periodEnd: Date, runId: number) {
  try {
    return await prisma.$transaction(async (tx) => {
      const issueDate = new Date();
      const invoice = await tx.invoice.create({
        data: {
          number: await nextNumber(tx, 'INV'),
          subscriptionId: sub.id,
          customerId: sub.customerId,
          status: 'DRAFT',
          periodStart,
          periodEnd,
          issueDate,
          dueDate: addDays(startOfDay(issueDate), sub.paymentTermDays),
          subtotal: priced.subtotal,
          discountTotal: priced.discountTotal,
          taxTotal: priced.taxTotal,
          total: priced.total,
          taxSplit: priced.taxSplit,
          billingRunId: runId,
          lines: { create: priced.lines },
        },
      });
      await logEvent(
        tx,
        sub.id,
        { type: 'INVOICE', message: `Invoice ${invoice.number} created for ${formatINR(invoice.total)}` },
        null,
      );
      await queueEmail(
        {
          to: sub.customer.email,
          kind: 'PRE_DEBIT_NOTICE',
          subject: `Upcoming charge for ${sub.number}`,
          body: `Hi ${sub.customer.name},\n\nThis is advance notice of your upcoming charge.\n\nMerchant: ${config.companyName}\nAmount: ${formatINR(invoice.total)}\nDue date: ${invoice.dueDate.toDateString()}\nReference: ${invoice.number} / ${sub.number}\nReason: ${sub.plan.name}, period ${periodStart.toDateString()} to ${periodEnd.toDateString()}\n\nYou can see the full breakdown in your customer portal.`,
        },
        tx,
      );
      return invoice;
    });
  } catch (err) {
    // Already billed for this period: the unique constraint stopped a duplicate.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    throw err;
  }
}
