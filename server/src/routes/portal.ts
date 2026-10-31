import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { customerScope, requireAuth, requireRole } from '../middleware/auth';
import { startOfDay } from '../lib/dates';
import { loadPricingContext, priceSubscription, subscriptionPricingInclude } from '../services/pricing';

const router = Router();
router.use(requireAuth, requireRole('CUSTOMER'));

// Customer home: balances, payments and a "next bill" card per active subscription.
router.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const customerId = customerScope(req)!;
    const today = startOfDay();
    const [customer, subs, open, payments] = await Promise.all([
      prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { name: true, email: true, phone: true, gstin: true, state: true, address: true } }),
      prisma.subscription.findMany({
        where: { customerId, status: { in: ['ACTIVE', 'PAUSED', 'QUOTATION', 'CONFIRMED'] } },
        include: subscriptionPricingInclude,
        orderBy: { id: 'desc' },
        take: 20,
      }),
      prisma.invoice.findMany({
        where: { customerId, status: 'CONFIRMED' },
        select: { id: true, number: true, total: true, amountPaid: true, dueDate: true },
        orderBy: { dueDate: 'asc' },
      }),
      prisma.payment.findMany({
        where: { invoice: { customerId } },
        select: { id: true, amount: true, method: true, paidAt: true, invoice: { select: { id: true, number: true } } },
        orderBy: { paidAt: 'desc' },
        take: 10,
      }),
    ]);

    const nextBills = [];
    for (const sub of subs) {
      if (sub.status !== 'ACTIVE' || !sub.nextBillingDate) continue;
      const ctx = await loadPricingContext(prisma, sub.nextBillingDate);
      const priced = priceSubscription(sub, ctx);
      nextBills.push({ subscriptionId: sub.id, number: sub.number, plan: sub.plan.name, date: sub.nextBillingDate, ...priced });
    }

    res.json({
      customer,
      subscriptions: subs.map((s) => ({
        id: s.id,
        number: s.number,
        status: s.status,
        plan: { name: s.plan.name, billingPeriod: s.plan.billingPeriod, pausable: s.plan.pausable, closable: s.plan.closable },
        nextBillingDate: s.nextBillingDate,
        expiryDate: s.expiryDate,
      })),
      balanceDue: open.reduce((s, i) => s + i.total - i.amountPaid, 0),
      overdue: open.filter((i) => i.dueDate < today).reduce((s, i) => s + i.total - i.amountPaid, 0),
      openInvoices: open.length,
      recentPayments: payments,
      nextBills,
    });
  }),
);

const profileSchema = z.object({
  phone: z.string().trim().max(20).optional().nullable(),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/, 'Enter a valid GSTIN')
    .optional()
    .nullable()
    .or(z.literal('')),
  state: z.string().trim().max(50).optional().nullable(),
  address: z.string().trim().max(500).optional().nullable(),
});

// Customers can update their own billing details (name and email stay with staff).
router.put(
  '/profile',
  asyncHandler(async (req, res) => {
    const data = profileSchema.parse(req.body);
    const customer = await prisma.customer.update({
      where: { id: customerScope(req)! },
      data: { phone: data.phone || null, gstin: data.gstin || null, state: data.state || null, address: data.address || null },
      select: { name: true, email: true, phone: true, gstin: true, state: true, address: true },
    });
    res.json(customer);
  }),
);

export default router;
