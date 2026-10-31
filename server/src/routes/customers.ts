import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, conflict, notFound } from '../lib/errors';
import { requireAuth, staffOnly } from '../middleware/auth';
import { idParam, optionalString, pageResult, paging } from '../lib/paging';
import { createToken, hashPassword } from '../lib/password';
import { queueEmail } from '../lib/outbox';
import { config } from '../config';
import { addDays, startOfDay } from '../lib/dates';

const router = Router();
router.use(requireAuth, staffOnly);

const customerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
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

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = paging(req);
    const q = optionalString(req.query.q);
    const where: Prisma.CustomerWhereInput = q
      ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] }
      : {};
    const [data, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        skip,
        take,
        orderBy: { name: 'asc' },
        include: { user: { select: { id: true } }, _count: { select: { subscriptions: true } } },
      }),
      prisma.customer.count({ where }),
    ]);
    res.json(pageResult(data.map(({ user, ...c }) => ({ ...c, hasPortal: !!user })), total, page, pageSize));
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUnique({
      where: { id: idParam(req) },
      include: {
        user: { select: { id: true } },
        subscriptions: { select: { id: true, number: true, status: true, plan: { select: { name: true } } }, orderBy: { id: 'desc' }, take: 50 },
      },
    });
    if (!customer) throw notFound('Customer not found');
    res.json({ ...customer, risk: await riskReasons(customer.id) });
  }),
);

// Simple, explainable at-risk rules (no model): late payments, ignored reminders,
// paused subscriptions and recent cancellations.
async function riskReasons(customerId: number) {
  const today = startOfDay();
  const [overdue, ignored, paused, cancelled] = await Promise.all([
    prisma.invoice.count({ where: { customerId, status: 'CONFIRMED', dueDate: { lt: today } } }),
    prisma.invoice.count({ where: { customerId, status: 'CONFIRMED', reminderStage: { gte: 3 } } }),
    prisma.subscription.count({ where: { customerId, status: 'PAUSED' } }),
    prisma.subscription.count({ where: { customerId, status: 'CLOSED', closedAt: { gte: addDays(today, -30) } } }),
  ]);
  const reasons: string[] = [];
  if (overdue) reasons.push(`${overdue} overdue invoice${overdue > 1 ? 's' : ''}`);
  if (ignored) reasons.push(`${ignored} invoice${ignored > 1 ? 's' : ''} past the overdue reminder`);
  if (paused) reasons.push(`${paused} paused subscription${paused > 1 ? 's' : ''}`);
  if (cancelled) reasons.push('Cancelled a subscription in the last 30 days');
  return reasons;
}

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = customerSchema.parse(req.body);
    res.status(201).json(await prisma.customer.create({ data: { ...data, gstin: data.gstin || null } }));
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = customerSchema.parse(req.body);
    res.json(await prisma.customer.update({ where: { id: idParam(req) }, data: { ...data, gstin: data.gstin || null } }));
  }),
);

// Gives a staff-created customer portal access. They set their own password
// through a one-time link sent to their email, which proves they own it.
router.post(
  '/:id/invite',
  asyncHandler(async (req, res) => {
    const customer = await prisma.customer.findUnique({ where: { id: idParam(req) }, include: { user: true } });
    if (!customer) throw notFound('Customer not found');
    if (customer.user) throw conflict('This customer already has portal access');
    if (await prisma.user.findUnique({ where: { email: customer.email } })) {
      throw conflict('Another account already uses this email');
    }
    const { token, hash } = createToken();
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: customer.email,
          name: customer.name,
          role: 'CUSTOMER',
          customerId: customer.id,
          // Unusable random password until they set one via the link.
          passwordHash: await hashPassword(crypto.randomBytes(32).toString('hex')),
        },
      });
      await tx.passwordReset.create({
        data: { userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000) },
      });
      await queueEmail(
        {
          to: customer.email,
          kind: 'PORTAL_INVITE',
          subject: `Your ${config.companyName} customer portal`,
          body: `Hi ${customer.name},\n\nYou now have access to the customer portal, where you can see your subscriptions, invoices and payments.\n\nSet your password here (valid for 48 hours, single use):\n${config.clientUrl}/reset-password?token=${token}`,
        },
        tx,
      );
    });
    res.json({ ok: true });
  }),
);

export default router;
