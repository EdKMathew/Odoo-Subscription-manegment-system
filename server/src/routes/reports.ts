import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { requireAuth, staffOnly } from '../middleware/auth';
import { pageResult, paging } from '../lib/paging';
import { addDays, startOfDay } from '../lib/dates';

const router = Router();
router.use(requireAuth, staffOnly);

const n = (v: unknown) => Number(v ?? 0);

const rangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// All totals are computed in SQL so they stay fast at 10k+ subscriptions.
router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const { from, to } = rangeSchema.parse(req.query);
    const today = startOfDay();
    const rangeFrom = from ?? new Date(today.getFullYear(), today.getMonth(), 1);
    const rangeTo = to ? addDays(startOfDay(to), 1) : addDays(today, 1);

    const [statusCounts, revenue, ar, aging, mrr, monthly, renewals] = await Promise.all([
      prisma.$queryRaw<{ status: string; count: bigint }[]>`
        SELECT "status", COUNT(*) AS count FROM "Subscription" GROUP BY "status"`,
      prisma.$queryRaw<{ total: bigint | null; count: bigint }[]>`
        SELECT SUM("amount") AS total, COUNT(*) AS count FROM "Payment"
        WHERE "paidAt" >= ${rangeFrom} AND "paidAt" < ${rangeTo}`,
      prisma.$queryRaw<{ outstanding: bigint | null; overdue: bigint | null; overdue_count: bigint; open_count: bigint }[]>`
        SELECT
          SUM("total" - "amountPaid") AS outstanding,
          SUM(CASE WHEN "dueDate" < ${today} THEN "total" - "amountPaid" ELSE 0 END) AS overdue,
          COUNT(*) FILTER (WHERE "dueDate" < ${today}) AS overdue_count,
          COUNT(*) AS open_count
        FROM "Invoice" WHERE "status" = 'CONFIRMED'`,
      prisma.$queryRaw<{ bucket: string; amount: bigint; count: bigint }[]>`
        SELECT
          CASE
            WHEN ${today}::date - "dueDate"::date <= 30 THEN '0-30'
            WHEN ${today}::date - "dueDate"::date <= 60 THEN '31-60'
            WHEN ${today}::date - "dueDate"::date <= 90 THEN '61-90'
            ELSE '90+'
          END AS bucket,
          SUM("total" - "amountPaid") AS amount,
          COUNT(*) AS count
        FROM "Invoice" WHERE "status" = 'CONFIRMED' AND "dueDate" < ${today}
        GROUP BY bucket`,
      // Monthly recurring revenue: every billing period converted to a monthly figure.
      prisma.$queryRaw<{ mrr: number | null }[]>`
        SELECT SUM(
          (p."price" + COALESCE(l.line_total, 0)) *
          CASE p."billingPeriod" WHEN 'DAILY' THEN 30 WHEN 'WEEKLY' THEN 52.0 / 12 WHEN 'MONTHLY' THEN 1 ELSE 1.0 / 12 END
        )::float AS mrr
        FROM "Subscription" s
        JOIN "Plan" p ON p."id" = s."planId"
        LEFT JOIN (
          SELECT "subscriptionId", SUM("quantity" * "unitPrice") AS line_total FROM "SubscriptionLine" GROUP BY "subscriptionId"
        ) l ON l."subscriptionId" = s."id"
        WHERE s."status" = 'ACTIVE'`,
      prisma.$queryRaw<{ month: string; collected: bigint }[]>`
        SELECT to_char(date_trunc('month', "paidAt"), 'YYYY-MM') AS month, SUM("amount") AS collected
        FROM "Payment" WHERE "paidAt" >= ${new Date(today.getFullYear(), today.getMonth() - 5, 1)}
        GROUP BY 1 ORDER BY 1`,
      prisma.subscription.count({ where: { status: 'ACTIVE', expiryDate: { gte: today, lte: addDays(today, 30) } } }),
    ]);

    const byStatus = Object.fromEntries(statusCounts.map((r) => [r.status, n(r.count)]));
    const buckets = ['0-30', '31-60', '61-90', '90+'].map((b) => {
      const row = aging.find((a) => a.bucket === b);
      return { bucket: b, amount: n(row?.amount), count: n(row?.count) };
    });

    res.json({
      range: { from: rangeFrom, to: addDays(rangeTo, -1) },
      activeSubscriptions: byStatus.ACTIVE ?? 0,
      byStatus,
      revenueCollected: n(revenue[0]?.total),
      paymentsCount: n(revenue[0]?.count),
      outstanding: n(ar[0]?.outstanding),
      openInvoices: n(ar[0]?.open_count),
      overdueAmount: n(ar[0]?.overdue),
      overdueInvoices: n(ar[0]?.overdue_count),
      mrr: Math.round(n(mrr[0]?.mrr)),
      aging: buckets,
      monthlyCollections: monthly.map((m) => ({ month: m.month, collected: n(m.collected) })),
      renewalsNext30: renewals,
    });
  }),
);


// MRR movement in the range, built from the MRR change recorded on each
// subscription event: new, expansion, contraction, churn (voluntary and
// involuntary), pauses and reactivations.
router.get(
  '/mrr-movement',
  asyncHandler(async (req, res) => {
    const { from, to } = rangeSchema.parse(req.query);
    const today = startOfDay();
    const rangeFrom = from ?? new Date(today.getFullYear(), today.getMonth(), 1);
    const rangeTo = to ? addDays(startOfDay(to), 1) : addDays(today, 1);

    const rows = await prisma.$queryRaw<{ kind: string; delta: bigint | null; count: bigint }[]>`
      SELECT "mrrKind" AS kind, SUM("mrrDelta") AS delta, COUNT(*) AS count
      FROM "SubscriptionEvent"
      WHERE "mrrKind" IS NOT NULL AND "createdAt" >= ${rangeFrom} AND "createdAt" < ${rangeTo}
      GROUP BY "mrrKind"`;
    const kinds = ['NEW', 'EXPANSION', 'CONTRACTION', 'CHURN', 'CHURN_INVOLUNTARY', 'PAUSE', 'REACTIVATION'] as const;
    const movement = Object.fromEntries(
      kinds.map((k) => {
        const r = rows.find((x) => x.kind === k);
        return [k, { mrr: n(r?.delta), count: n(r?.count) }];
      }),
    ) as Record<(typeof kinds)[number], { mrr: number; count: number }>;
    const net = kinds.reduce((s, k) => s + movement[k].mrr, 0);
    res.json({ movement, net });
  }),
);

// Dunning results: how much overdue money is at risk, and how much of what went
// overdue was recovered after reminders.
router.get(
  '/collections',
  asyncHandler(async (_req, res) => {
    const today = startOfDay();
    const [recovery, atRisk, suspended] = await Promise.all([
      // Invoices that reached the overdue reminder: paid since (recovered) vs still open.
      prisma.$queryRaw<{ status: string; count: bigint; amount: bigint | null }[]>`
        SELECT "status", COUNT(*) AS count, SUM("total") AS amount
        FROM "Invoice" WHERE "reminderStage" >= 3 AND "status" IN ('PAID', 'CONFIRMED')
        GROUP BY "status"`,
      // Monthly revenue of active subscriptions that have an overdue invoice.
      prisma.$queryRaw<{ mrr: number | null; count: bigint }[]>`
        SELECT SUM(
          (p."price" + COALESCE(l.line_total, 0)) *
          CASE p."billingPeriod" WHEN 'DAILY' THEN 30 WHEN 'WEEKLY' THEN 52.0 / 12 WHEN 'MONTHLY' THEN 1 ELSE 1.0 / 12 END
        )::float AS mrr, COUNT(*) AS count
        FROM "Subscription" s
        JOIN "Plan" p ON p."id" = s."planId"
        LEFT JOIN (SELECT "subscriptionId", SUM("quantity" * "unitPrice") AS line_total FROM "SubscriptionLine" GROUP BY 1) l
          ON l."subscriptionId" = s."id"
        WHERE s."status" = 'ACTIVE' AND EXISTS (
          SELECT 1 FROM "Invoice" i WHERE i."subscriptionId" = s."id" AND i."status" = 'CONFIRMED' AND i."dueDate" < ${today}
        )`,
      prisma.subscription.count({ where: { status: 'PAUSED', suspendedAt: { not: null } } }),
    ]);
    const paid = recovery.find((r) => r.status === 'PAID');
    const open = recovery.find((r) => r.status === 'CONFIRMED');
    const recoveredCount = n(paid?.count);
    const openCount = n(open?.count);
    res.json({
      revenueAtRisk: { mrr: Math.round(n(atRisk[0]?.mrr)), subscriptions: n(atRisk[0]?.count) },
      recovery: {
        rate: recoveredCount + openCount ? recoveredCount / (recoveredCount + openCount) : null,
        recoveredCount,
        recoveredAmount: n(paid?.amount),
        stillOpenCount: openCount,
        stillOpenAmount: n(open?.amount),
      },
      suspended,
    });
  }),
);

router.get(
  '/overdue',
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = paging(req);
    const bucket = z.enum(['0-30', '31-60', '61-90', '90+']).optional().parse(req.query.bucket || undefined);
    const today = startOfDay();
    const ranges: Record<string, [number, number]> = { '0-30': [0, 30], '31-60': [31, 60], '61-90': [61, 90], '90+': [91, 100000] };
    const [minDays, maxDays] = bucket ? ranges[bucket] : [0, 100000];
    const where: Prisma.InvoiceWhereInput = {
      status: 'CONFIRMED',
      dueDate: { lt: today, lte: addDays(today, -minDays), gte: addDays(today, -maxDays) },
    };
    const [rows, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        skip,
        take,
        orderBy: { dueDate: 'asc' },
        select: {
          id: true,
          number: true,
          dueDate: true,
          total: true,
          amountPaid: true,
          customer: { select: { id: true, name: true, email: true } },
          subscription: { select: { id: true, number: true } },
        },
      }),
      prisma.invoice.count({ where }),
    ]);
    const data = rows.map((r) => ({
      ...r,
      balance: r.total - r.amountPaid,
      daysOverdue: Math.floor((today.getTime() - startOfDay(r.dueDate).getTime()) / 86_400_000),
    }));
    res.json(pageResult(data, total, page, pageSize));
  }),
);

// Renewal radar: active subscriptions expiring in the next N days.
router.get(
  '/renewals',
  asyncHandler(async (req, res) => {
    const days = z.coerce.number().int().refine((d) => [7, 30, 60].includes(d)).default(30).parse(req.query.days ?? 30);
    const { page, pageSize, skip, take } = paging(req);
    const today = startOfDay();
    const where: Prisma.SubscriptionWhereInput = {
      status: 'ACTIVE',
      expiryDate: { gte: today, lte: addDays(today, days) },
    };
    const [data, total] = await Promise.all([
      prisma.subscription.findMany({
        where,
        skip,
        take,
        orderBy: { expiryDate: 'asc' },
        select: {
          id: true,
          number: true,
          expiryDate: true,
          customer: { select: { id: true, name: true } },
          plan: { select: { id: true, name: true, renewable: true } },
          renewal: { select: { id: true, number: true, status: true } },
        },
      }),
      prisma.subscription.count({ where }),
    ]);
    res.json(pageResult(data, total, page, pageSize));
  }),
);

export default router;
