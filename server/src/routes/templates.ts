import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { adminOnly, requireAuth, staffOnly } from '../middleware/auth';
import { idParam } from '../lib/paging';

const router = Router();
router.use(requireAuth, staffOnly);

const include = {
  plan: { select: { id: true, name: true, billingPeriod: true } },
  lines: {
    include: {
      product: { select: { id: true, name: true, salesPrice: true } },
      variant: { select: { id: true, name: true } },
    },
  },
} as const;

const templateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  planId: z.coerce.number().int().positive(),
  validityDays: z.coerce.number().int().min(1).max(365).default(30),
  durationDays: z.coerce.number().int().min(1).max(3650).optional().nullable(),
  lines: z
    .array(
      z.object({
        productId: z.coerce.number().int().positive(),
        variantId: z.coerce.number().int().positive().optional().nullable(),
        quantity: z.coerce.number().int().min(1).max(100000).default(1),
      }),
    )
    .min(1)
    .max(50),
});

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ data: await prisma.quoteTemplate.findMany({ include, orderBy: { name: 'asc' } }) });
  }),
);

router.post(
  '/',
  adminOnly,
  asyncHandler(async (req, res) => {
    const { lines, ...data } = templateSchema.parse(req.body);
    const tpl = await prisma.quoteTemplate.create({ data: { ...data, lines: { create: lines } }, include });
    res.status(201).json(tpl);
  }),
);

router.put(
  '/:id',
  adminOnly,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { lines, ...data } = templateSchema.parse(req.body);
    const tpl = await prisma.$transaction(async (tx) => {
      await tx.quoteTemplateLine.deleteMany({ where: { templateId: id } });
      return tx.quoteTemplate.update({ where: { id }, data: { ...data, lines: { create: lines } }, include });
    });
    res.json(tpl);
  }),
);

router.delete(
  '/:id',
  adminOnly,
  asyncHandler(async (req, res) => {
    await prisma.quoteTemplate.delete({ where: { id: idParam(req) } });
    res.json({ ok: true });
  }),
);

export default router;
