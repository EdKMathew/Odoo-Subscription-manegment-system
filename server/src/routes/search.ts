import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { customerScope, requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// Quick search across subscriptions, invoices and customers (Ctrl+K).
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = z.string().trim().min(1).max(60).safeParse(req.query.q);
    if (!q.success) return res.json({ subscriptions: [], invoices: [], customers: [] });
    const term = q.data;
    const own = customerScope(req);
    const contains = { contains: term, mode: 'insensitive' as const };

    const [subscriptions, invoices, customers] = await Promise.all([
      prisma.subscription.findMany({
        where: { ...(own ? { customerId: own, status: { not: 'DRAFT' } } : {}), OR: [{ number: contains }, { customer: { name: contains } }] },
        select: { id: true, number: true, status: true, customer: { select: { name: true } } },
        take: 6,
        orderBy: { id: 'desc' },
      }),
      prisma.invoice.findMany({
        where: {
          ...(own ? { customerId: own, status: { not: 'DRAFT' } } : {}),
          OR: [{ number: contains }, { customer: { name: contains } }],
        },
        select: { id: true, number: true, status: true, total: true, customer: { select: { name: true } } },
        take: 6,
        orderBy: { id: 'desc' },
      }),
      own
        ? Promise.resolve([])
        : prisma.customer.findMany({
            where: { OR: [{ name: contains }, { email: contains }] },
            select: { id: true, name: true, email: true },
            take: 6,
            orderBy: { name: 'asc' },
          }),
    ]);
    res.json({ subscriptions, invoices, customers });
  }),
);

export default router;
