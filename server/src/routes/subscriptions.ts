import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Prisma, SubscriptionStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, conflict, notFound } from '../lib/errors';
import { customerScope, requireAuth, staffOnly } from '../middleware/auth';
import { idParam, optionalString, pageResult, paging } from '../lib/paging';
import { nextNumber } from '../lib/numbering';
import { addDays, startOfDay } from '../lib/dates';
import { createToken, hashToken } from '../lib/password';
import { queueEmail } from '../lib/outbox';
import { formatINR } from '../lib/money';
import { config } from '../config';
import { assertTransition, logEvent } from '../services/subscriptions';
import { loadPricingContext, priceSubscription, subscriptionPricingInclude } from '../services/pricing';

const router = Router();

const statuses = ['DRAFT', 'QUOTATION', 'CONFIRMED', 'ACTIVE', 'PAUSED', 'CLOSED'] as const;

// ---------- Public quote view / accept (the token in the link is the credential) ----------

const quoteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Invalid link');

async function findQuoteByToken(token: string) {
  const sub = await prisma.subscription.findUnique({
    where: { acceptTokenHash: hashToken(tokenSchema.parse(token)) },
    include: subscriptionPricingInclude,
  });
  if (!sub) throw notFound('This quotation link is invalid');
  return sub;
}

router.get(
  '/quote/:token',
  quoteLimiter,
  asyncHandler(async (req, res) => {
    const sub = await findQuoteByToken(req.params.token);
    const ctx = await loadPricingContext(prisma, new Date());
    const priced = priceSubscription(sub, ctx);
    res.json({
      number: sub.number,
      status: sub.status,
      customerName: sub.customer.name,
      plan: { name: sub.plan.name, billingPeriod: sub.plan.billingPeriod },
      startDate: sub.startDate,
      expiryDate: sub.expiryDate,
      quoteExpiresAt: sub.quoteExpiresAt,
      acceptedAt: sub.acceptedAt,
      company: config.companyName,
      ...priced,
    });
  }),
);

router.post(
  '/quote/:token/accept',
  quoteLimiter,
  asyncHandler(async (req, res) => {
    const sub = await findQuoteByToken(req.params.token);
    if (sub.status !== 'QUOTATION') throw conflict('This quotation has already been handled');
    if (sub.quoteExpiresAt && sub.quoteExpiresAt < new Date()) throw conflict('This quotation has expired');
    await prisma.$transaction(async (tx) => {
      const updated = await tx.subscription.updateMany({
        where: { id: sub.id, status: 'QUOTATION' },
        data: { status: 'CONFIRMED', acceptedAt: new Date() },
      });
      if (updated.count !== 1) throw conflict('This quotation has already been handled');
      await logEvent(
        tx,
        sub.id,
        { type: 'STATUS', fromStatus: 'QUOTATION', toStatus: 'CONFIRMED', message: 'Quotation accepted by customer via link' },
        null,
      );
    });
    res.json({ ok: true, status: 'CONFIRMED' });
  }),
);

// ---------- Authenticated routes ----------

router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = paging(req);
    const status = z.enum(statuses).optional().parse(req.query.status || undefined);
    const q = optionalString(req.query.q);
    const ownCustomer = customerScope(req);
    const where: Prisma.SubscriptionWhereInput = {
      // Drafts are internal; customers only see subscriptions once quoted.
      ...(ownCustomer ? { customerId: ownCustomer, status: { not: 'DRAFT' as const } } : {}),
      ...(status && !(ownCustomer && status === 'DRAFT') ? { status } : {}),
      ...(q
        ? {
            OR: [
              { number: { contains: q, mode: 'insensitive' } },
              { customer: { name: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [data, total] = await Promise.all([
      prisma.subscription.findMany({
        where,
        skip,
        take,
        orderBy: { id: 'desc' },
        select: {
          id: true,
          number: true,
          status: true,
          startDate: true,
          expiryDate: true,
          nextBillingDate: true,
          customer: { select: { id: true, name: true } },
          plan: { select: { id: true, name: true, billingPeriod: true } },
        },
      }),
      prisma.subscription.count({ where }),
    ]);
    res.json(pageResult(data, total, page, pageSize));
  }),
);

async function loadOwned(req: Parameters<typeof customerScope>[0], id: number) {
  const ownCustomer = customerScope(req);
  const sub = await prisma.subscription.findUnique({ where: { id }, include: subscriptionPricingInclude });
  // Customers get a 404 (not 403) for other people's subscriptions so ids can't be probed.
  if (!sub || (ownCustomer && (sub.customerId !== ownCustomer || sub.status === 'DRAFT'))) throw notFound('Subscription not found');
  return sub;
}

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const sub = await loadOwned(req, idParam(req));
    const [events, invoices] = await Promise.all([
      prisma.subscriptionEvent.findMany({ where: { subscriptionId: sub.id }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.invoice.findMany({
        where: { subscriptionId: sub.id },
        orderBy: { periodStart: 'desc' },
        take: 50,
        select: { id: true, number: true, status: true, total: true, amountPaid: true, dueDate: true, periodStart: true, periodEnd: true },
      }),
    ]);
    const ctx = await loadPricingContext(prisma, sub.nextBillingDate ?? new Date());
    const nextBill = sub.status === 'CLOSED' ? null : priceSubscription(sub, ctx);
    res.json({ ...sub, acceptTokenHash: undefined, events, invoices, nextBill });
  }),
);

const lineSchema = z.object({
  productId: z.coerce.number().int().positive(),
  variantId: z.coerce.number().int().positive().optional().nullable(),
  quantity: z.coerce.number().int().min(1).max(100000),
  unitPrice: z.coerce.number().min(0).max(10_000_000).transform((r) => Math.round(r * 100)).optional(),
});

const subscriptionSchema = z.object({
  customerId: z.coerce.number().int().positive(),
  planId: z.coerce.number().int().positive().optional(),
  templateId: z.coerce.number().int().positive().optional(),
  startDate: z.coerce.date().optional().nullable(),
  expiryDate: z.coerce.date().optional().nullable(),
  paymentTermDays: z.coerce.number().int().min(0).max(365).default(15),
  notes: z.string().trim().max(1000).optional().nullable(),
  lines: z.array(lineSchema).max(50).default([]),
});

// Validates plan, products and variants and builds line rows with prices from the catalog.
async function buildLines(input: z.infer<typeof subscriptionSchema>) {
  let planId = input.planId;
  let lines = input.lines;
  let expiryDate = input.expiryDate ?? null;
  if (input.templateId) {
    const tpl = await prisma.quoteTemplate.findUnique({ where: { id: input.templateId }, include: { lines: true } });
    if (!tpl) throw badRequest('Template not found');
    planId = planId ?? tpl.planId;
    if (!lines.length) lines = tpl.lines.map((l) => ({ productId: l.productId, variantId: l.variantId, quantity: l.quantity }));
    if (!expiryDate && tpl.durationDays && input.startDate) expiryDate = addDays(input.startDate, tpl.durationDays);
  }
  if (!planId) throw badRequest('Choose a plan or a quotation template');
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan || !plan.active) throw badRequest('Plan not found');
  const now = new Date();
  if ((plan.availableFrom && plan.availableFrom > now) || (plan.availableTo && plan.availableTo < now)) {
    throw badRequest('This plan is not available right now');
  }
  if (!lines.length) throw badRequest('Add at least one product line');

  const products = await prisma.product.findMany({
    where: { id: { in: lines.map((l) => l.productId) }, active: true },
    include: { variants: { where: { active: true } } },
  });
  const rows = lines.map((l) => {
    const product = products.find((p) => p.id === l.productId);
    if (!product) throw badRequest(`Product ${l.productId} not found`);
    if (l.variantId && !product.variants.some((v) => v.id === l.variantId)) {
      throw badRequest(`Variant does not belong to ${product.name}`);
    }
    return {
      productId: product.id,
      variantId: l.variantId ?? null,
      description: product.name,
      quantity: l.quantity,
      unitPrice: l.unitPrice ?? product.salesPrice,
    };
  });
  const qty = rows.reduce((s, r) => s + r.quantity, 0);
  if (qty < plan.minQuantity) throw badRequest(`This plan needs a minimum quantity of ${plan.minQuantity}`);
  if (input.startDate && expiryDate && expiryDate <= input.startDate) throw badRequest('Expiry must be after the start date');
  return { plan, rows, expiryDate };
}

router.post(
  '/',
  staffOnly,
  asyncHandler(async (req, res) => {
    const input = subscriptionSchema.parse(req.body);
    if (!(await prisma.customer.findUnique({ where: { id: input.customerId } }))) throw badRequest('Customer not found');
    const { plan, rows, expiryDate } = await buildLines(input);
    const sub = await prisma.$transaction(async (tx) => {
      const created = await tx.subscription.create({
        data: {
          number: await nextNumber(tx, 'SUB'),
          customerId: input.customerId,
          planId: plan.id,
          startDate: input.startDate ?? null,
          expiryDate,
          paymentTermDays: input.paymentTermDays,
          notes: input.notes ?? null,
          createdById: req.user!.id,
          lines: { create: rows },
        },
      });
      await logEvent(tx, created.id, { type: 'CREATED', toStatus: 'DRAFT', message: `Created on plan ${plan.name}` }, req.user!);
      return created;
    });
    res.status(201).json(sub);
  }),
);

// Only drafts can be edited; after that the terms are locked.
router.put(
  '/:id',
  staffOnly,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const input = subscriptionSchema.parse(req.body);
    const existing = await prisma.subscription.findUnique({ where: { id } });
    if (!existing) throw notFound('Subscription not found');
    if (existing.status !== 'DRAFT') throw conflict('Only draft subscriptions can be edited');
    const { plan, rows, expiryDate } = await buildLines(input);
    await prisma.$transaction(async (tx) => {
      await tx.subscriptionLine.deleteMany({ where: { subscriptionId: id } });
      await tx.subscription.update({
        where: { id },
        data: {
          customerId: input.customerId,
          planId: plan.id,
          startDate: input.startDate ?? null,
          expiryDate,
          paymentTermDays: input.paymentTermDays,
          notes: input.notes ?? null,
          lines: { create: rows },
        },
      });
      await logEvent(tx, id, { type: 'EDITED', message: 'Draft updated' }, req.user!);
    });
    res.json({ ok: true });
  }),
);

// Drafts a renewal: a new subscription with the same plan and lines, starting
// when the current one expires, ready to be sent as a quotation.
router.post(
  '/:id/renew',
  staffOnly,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const sub = await prisma.subscription.findUnique({ where: { id }, include: { plan: true, lines: true } });
    if (!sub) throw notFound('Subscription not found');
    if (!sub.plan.renewable) throw conflict('This plan is not renewable');
    if (!sub.expiryDate) throw conflict('This subscription has no expiry date to renew from');
    if (sub.status !== 'ACTIVE' && sub.status !== 'PAUSED') throw conflict('Only active or paused subscriptions can be renewed');
    const length = sub.startDate ? sub.expiryDate.getTime() - sub.startDate.getTime() : null;
    const renewal = await prisma.$transaction(async (tx) => {
      const created = await tx.subscription.create({
        data: {
          number: await nextNumber(tx, 'SUB'),
          customerId: sub.customerId,
          planId: sub.planId,
          startDate: sub.expiryDate,
          expiryDate: length ? new Date(sub.expiryDate!.getTime() + length) : null,
          paymentTermDays: sub.paymentTermDays,
          notes: `Renewal of ${sub.number}`,
          createdById: req.user!.id,
          lines: {
            create: sub.lines.map((l) => ({
              productId: l.productId,
              variantId: l.variantId,
              description: l.description,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
            })),
          },
        },
      });
      await logEvent(tx, created.id, { type: 'CREATED', toStatus: 'DRAFT', message: `Drafted as renewal of ${sub.number}` }, req.user!);
      await logEvent(tx, sub.id, { type: 'RENEWAL', message: `Renewal drafted as ${created.number}` }, req.user!);
      return created;
    });
    res.status(201).json(renewal);
  }),
);

const transitionSchema = z.object({
  to: z.enum(statuses),
  reason: z.string().trim().max(500).optional(),
});

router.post(
  '/:id/transition',
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { to, reason } = transitionSchema.parse(req.body);
    const sub = await loadOwned(req, id);
    const actor = req.user!;

    // Customers can only pause, resume or cancel their own active subscriptions,
    // or accept their own quotation.
    if (actor.role === 'CUSTOMER') {
      const allowed: SubscriptionStatus[] = ['PAUSED', 'ACTIVE', 'CLOSED', 'CONFIRMED'];
      if (!allowed.includes(to) || (to === 'ACTIVE' && sub.status !== 'PAUSED')) {
        throw conflict('This action is not available from the portal');
      }
    }
    assertTransition(sub.status, to, sub.plan, actor);
    if (to === 'CONFIRMED' && sub.quoteExpiresAt && sub.quoteExpiresAt < new Date()) {
      throw conflict('This quotation has expired');
    }

    const today = startOfDay();
    const data: Prisma.SubscriptionUpdateInput = { status: to };
    let message = `Status changed from ${sub.status} to ${to}`;
    let acceptLink: string | null = null;

    if (to === 'QUOTATION') {
      const tpl = await prisma.quoteTemplate.findFirst({ where: { planId: sub.planId }, orderBy: { id: 'asc' } });
      const { token, hash } = createToken();
      data.acceptTokenHash = hash;
      data.quoteExpiresAt = addDays(new Date(), tpl?.validityDays ?? config.quoteAcceptDays);
      acceptLink = `${config.clientUrl}/quote/${token}`;
      message = 'Quotation sent to customer';
    }
    if (to === 'CONFIRMED') {
      data.acceptedAt = new Date();
      message = actor.role === 'CUSTOMER' ? 'Quotation accepted by customer' : 'Quotation confirmed';
    }
    if (to === 'ACTIVE' && sub.status === 'CONFIRMED') {
      const start = sub.startDate && sub.startDate > today ? startOfDay(sub.startDate) : today;
      data.startDate = start;
      data.nextBillingDate = start;
      message = 'Subscription activated';
    }
    if (to === 'ACTIVE' && sub.status === 'PAUSED') {
      // Resume: billing continues from today; discounts kept while paused still apply.
      data.pausedAt = null;
      if (!sub.nextBillingDate || sub.nextBillingDate < today) data.nextBillingDate = today;
      message = 'Subscription resumed';
    }
    if (to === 'PAUSED') {
      data.pausedAt = new Date();
      message = reason ? `Subscription paused: ${reason}` : 'Subscription paused';
    }
    if (to === 'CLOSED') {
      data.closedAt = new Date();
      data.closeReason = reason ?? null;
      data.nextBillingDate = null;
      message = reason ? `Subscription closed: ${reason}` : 'Subscription closed';
    }

    await prisma.$transaction(async (tx) => {
      // Guard against two people changing the status at the same time.
      const updated = await tx.subscription.updateMany({ where: { id, status: sub.status }, data: data as Prisma.SubscriptionUpdateManyMutationInput });
      if (updated.count !== 1) throw conflict('This subscription was changed by someone else, please refresh');
      await logEvent(tx, id, { type: 'STATUS', fromStatus: sub.status, toStatus: to, message }, actor);
      if (acceptLink) {
        const ctx = await loadPricingContext(tx, new Date());
        const priced = priceSubscription(sub, ctx);
        await queueEmail(
          {
            to: sub.customer.email,
            kind: 'QUOTATION',
            subject: `Quotation ${sub.number} from ${config.companyName}`,
            body: `Hi ${sub.customer.name},\n\nYour quotation ${sub.number} for ${sub.plan.name} is ready. Total per billing period: ${formatINR(priced.total)}.\n\nReview and accept it here:\n${acceptLink}\n\nThis link is valid until ${(data.quoteExpiresAt as Date).toDateString()}.`,
          },
          tx,
        );
      }
    });
    res.json({ ok: true, status: to });
  }),
);

export default router;
