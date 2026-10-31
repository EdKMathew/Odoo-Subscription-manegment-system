import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, notFound } from '../lib/errors';
import { adminOnly, requireAuth, staffOnly } from '../middleware/auth';
import { idParam, optionalString, pageResult, paging } from '../lib/paging';

const router = Router();
router.use(requireAuth);

const money = z.coerce.number().min(0).max(10_000_000).transform((r) => Math.round(r * 100));

// ---------- Tax rules (admin defines, applied automatically) ----------

router.get(
  '/tax-rules',
  staffOnly,
  asyncHandler(async (_req, res) => {
    res.json({ data: await prisma.taxRule.findMany({ orderBy: { id: 'asc' } }) });
  }),
);

const taxSchema = z.object({
  name: z.string().trim().min(1).max(60),
  rate: z.coerce.number().min(0).max(100).transform((r) => Math.round(r * 100)),
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
});

router.post(
  '/tax-rules',
  adminOnly,
  asyncHandler(async (req, res) => {
    const { rate, ...rest } = taxSchema.parse(req.body);
    const rule = await prisma.$transaction(async (tx) => {
      if (rest.isDefault) await tx.taxRule.updateMany({ data: { isDefault: false } });
      return tx.taxRule.create({ data: { ...rest, rateBp: rate } });
    });
    res.status(201).json(rule);
  }),
);

router.put(
  '/tax-rules/:id',
  adminOnly,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { rate, ...rest } = taxSchema.parse(req.body);
    const rule = await prisma.$transaction(async (tx) => {
      if (rest.isDefault) await tx.taxRule.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
      return tx.taxRule.update({ where: { id }, data: { ...rest, rateBp: rate } });
    });
    res.json(rule);
  }),
);

// ---------- Products ----------

const productSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(['SERVICE', 'GOODS']).default('SERVICE'),
  salesPrice: money,
  costPrice: money.default(0),
  notes: z.string().trim().max(1000).optional().nullable(),
  taxRuleId: z.coerce.number().int().positive().optional().nullable(),
  active: z.boolean().default(true),
});

router.get(
  '/products',
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = paging(req);
    const q = optionalString(req.query.q);
    const isStaff = req.user!.role !== 'CUSTOMER';
    const where = {
      ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}),
      ...(isStaff ? {} : { active: true }),
    };
    const [data, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take,
        orderBy: { name: 'asc' },
        // Customers never see cost price.
        select: {
          id: true,
          name: true,
          type: true,
          salesPrice: true,
          costPrice: isStaff,
          notes: true,
          active: true,
          taxRule: { select: { id: true, name: true, rateBp: true } },
          variants: {
            select: { id: true, name: true, active: true, values: { select: { attributeValue: { include: { attribute: true } } } } },
          },
        },
      }),
      prisma.product.count({ where }),
    ]);
    res.json(pageResult(data, total, page, pageSize));
  }),
);

router.post(
  '/products',
  adminOnly,
  asyncHandler(async (req, res) => {
    const data = productSchema.parse(req.body);
    res.status(201).json(await prisma.product.create({ data }));
  }),
);

router.put(
  '/products/:id',
  adminOnly,
  asyncHandler(async (req, res) => {
    const data = productSchema.parse(req.body);
    res.json(await prisma.product.update({ where: { id: idParam(req) }, data }));
  }),
);

// ---------- Attributes and variants ----------

router.get(
  '/attributes',
  asyncHandler(async (_req, res) => {
    res.json({ data: await prisma.attribute.findMany({ include: { values: true }, orderBy: { name: 'asc' } }) });
  }),
);

const attributeSchema = z.object({
  name: z.string().trim().min(1).max(60),
  values: z
    .array(z.object({ value: z.string().trim().min(1).max(60), priceExtra: money.default(0) }))
    .min(1)
    .max(50),
});

router.post(
  '/attributes',
  adminOnly,
  asyncHandler(async (req, res) => {
    const { name, values } = attributeSchema.parse(req.body);
    const attribute = await prisma.attribute.create({
      data: { name, values: { create: values } },
      include: { values: true },
    });
    res.status(201).json(attribute);
  }),
);

const variantSchema = z.object({
  attributeValueIds: z.array(z.coerce.number().int().positive()).min(1).max(10),
});

// A variant is a combination of attribute values; its price extra is the sum of theirs.
router.post(
  '/products/:id/variants',
  adminOnly,
  asyncHandler(async (req, res) => {
    const productId = idParam(req);
    const { attributeValueIds } = variantSchema.parse(req.body);
    const values = await prisma.attributeValue.findMany({
      where: { id: { in: attributeValueIds } },
      include: { attribute: true },
    });
    if (values.length !== new Set(attributeValueIds).size) throw badRequest('Unknown attribute value');
    if (new Set(values.map((v) => v.attributeId)).size !== values.length) {
      throw badRequest('Pick only one value per attribute');
    }
    if (!(await prisma.product.findUnique({ where: { id: productId } }))) throw notFound('Product not found');
    const variant = await prisma.productVariant.create({
      data: {
        productId,
        name: values.map((v) => `${v.attribute.name}: ${v.value}`).join(', '),
        values: { create: values.map((v) => ({ attributeValueId: v.id })) },
      },
      include: { values: { include: { attributeValue: true } } },
    });
    res.status(201).json(variant);
  }),
);

router.delete(
  '/variants/:id',
  adminOnly,
  asyncHandler(async (req, res) => {
    await prisma.productVariant.update({ where: { id: idParam(req) }, data: { active: false } });
    res.json({ ok: true });
  }),
);

// ---------- Plans ----------

const planSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    price: money,
    billingPeriod: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
    minQuantity: z.coerce.number().int().min(1).max(100000).default(1),
    availableFrom: z.coerce.date().optional().nullable(),
    availableTo: z.coerce.date().optional().nullable(),
    autoClose: z.boolean().default(false),
    closable: z.boolean().default(true),
    pausable: z.boolean().default(false),
    renewable: z.boolean().default(true),
    active: z.boolean().default(true),
  })
  .refine((p) => !p.availableFrom || !p.availableTo || p.availableFrom <= p.availableTo, {
    message: 'Available-from must be before available-to',
    path: ['availableTo'],
  });

router.get(
  '/plans',
  asyncHandler(async (req, res) => {
    const isStaff = req.user!.role !== 'CUSTOMER';
    const plans = await prisma.plan.findMany({
      where: isStaff ? {} : { active: true },
      orderBy: { price: 'asc' },
      include: { _count: { select: { subscriptions: true } } },
    });
    res.json({ data: plans });
  }),
);

router.post(
  '/plans',
  adminOnly,
  asyncHandler(async (req, res) => {
    res.status(201).json(await prisma.plan.create({ data: planSchema.parse(req.body) }));
  }),
);

router.put(
  '/plans/:id',
  adminOnly,
  asyncHandler(async (req, res) => {
    res.json(await prisma.plan.update({ where: { id: idParam(req) }, data: planSchema.parse(req.body) }));
  }),
);

export default router;
