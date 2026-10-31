import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest } from '../lib/errors';
import { adminOnly, requireAuth, staffOnly } from '../middleware/auth';
import { idParam } from '../lib/paging';
import { loadPricingContext, priceSubscription, subscriptionPricingInclude } from '../services/pricing';

const router = Router();
router.use(requireAuth);

const discountSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    type: z.enum(['PERCENT', 'FIXED']),
    value: z.coerce.number().positive().max(10_000_000),
    scope: z.enum(['SUBSCRIPTION', 'PRODUCTS']).default('SUBSCRIPTION'),
    productIds: z.array(z.coerce.number().int().positive()).max(200).default([]),
    minPurchase: z.coerce.number().min(0).max(10_000_000).default(0).transform((r) => Math.round(r * 100)),
    minQuantity: z.coerce.number().int().min(0).max(100000).default(0),
    startDate: z.coerce.date().optional().nullable(),
    endDate: z.coerce.date().optional().nullable(),
    usageLimit: z.coerce.number().int().min(1).max(1_000_000).optional().nullable(),
    active: z.boolean().default(true),
  })
  .refine((d) => d.type !== 'PERCENT' || d.value <= 100, { message: 'Percentage cannot exceed 100', path: ['value'] })
  .refine((d) => d.scope !== 'PRODUCTS' || d.productIds.length > 0, { message: 'Pick at least one product', path: ['productIds'] })
  .refine((d) => !d.startDate || !d.endDate || d.startDate <= d.endDate, { message: 'Start must be before end', path: ['endDate'] })
  // Percent stored in basis points, fixed amounts in paise.
  .transform(({ value, ...d }) => ({ ...d, value: Math.round(value * 100) }));

router.get(
  '/',
  staffOnly,
  asyncHandler(async (_req, res) => {
    const data = await prisma.discount.findMany({
      orderBy: { id: 'desc' },
      include: { products: { include: { product: { select: { id: true, name: true } } } } },
    });
    res.json({ data });
  }),
);

// Discounts are admin-only.
router.post(
  '/',
  adminOnly,
  asyncHandler(async (req, res) => {
    const { productIds, ...data } = discountSchema.parse(req.body);
    const discount = await prisma.discount.create({
      data: { ...data, products: { create: productIds.map((productId) => ({ productId })) } },
    });
    res.status(201).json(discount);
  }),
);

router.put(
  '/:id',
  adminOnly,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { productIds, ...data } = discountSchema.parse(req.body);
    const discount = await prisma.$transaction(async (tx) => {
      await tx.discountProduct.deleteMany({ where: { discountId: id } });
      return tx.discount.update({
        where: { id },
        data: { ...data, products: { create: productIds.map((productId) => ({ productId })) } },
      });
    });
    res.json(discount);
  }),
);

// Impact preview: before a rule goes live, show how many active subscriptions it
// would touch and how much it would take off per billing cycle.
router.post(
  '/preview',
  adminOnly,
  asyncHandler(async (req, res) => {
    const { productIds, ...data } = discountSchema.parse(req.body);
    const now = new Date();
    if (data.endDate && data.endDate < now) throw badRequest('This discount has already ended');
    const ctx = await loadPricingContext(prisma, now);
    const candidate = {
      ...data,
      id: -1,
      usedCount: 0,
      usageLimit: null,
      startDate: null,
      endDate: null,
      createdAt: now,
      products: productIds.map((productId) => ({ discountId: -1, productId })),
    };
    let affected = 0;
    let reduction = 0;
    const batch = 500;
    for (let cursor = 0; ; ) {
      const subs = await prisma.subscription.findMany({
        where: { status: 'ACTIVE', id: { gt: cursor } },
        include: subscriptionPricingInclude,
        orderBy: { id: 'asc' },
        take: batch,
      });
      if (!subs.length) break;
      for (const sub of subs) {
        const before = priceSubscription(sub, ctx);
        const after = priceSubscription(sub, { ...ctx, discounts: [...ctx.discounts, candidate] });
        const diff = before.total - after.total;
        if (diff > 0) {
          affected++;
          reduction += diff;
        }
      }
      cursor = subs[subs.length - 1].id;
    }
    res.json({ affected, reductionPerCycle: reduction, usageLimit: data.usageLimit ?? null });
  }),
);

export default router;
