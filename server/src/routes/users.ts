import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, HttpError } from '../lib/errors';
import { hashPassword, passwordSchema } from '../lib/password';
import { adminOnly, requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth, adminOnly);

const userSelect = { id: true, email: true, name: true, role: true, active: true, createdAt: true } as const;

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'STAFF'] } },
      select: userSelect,
      orderBy: { createdAt: 'asc' },
    });
    res.json({ data: users });
  }),
);

const createSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
  password: passwordSchema,
  role: z.enum(['STAFF', 'ADMIN']).default('STAFF'),
});

// Only admins can create staff (and other admins).
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);
    if (await prisma.user.findUnique({ where: { email: data.email } })) {
      throw new HttpError(409, 'An account with this email already exists');
    }
    const user = await prisma.user.create({
      data: { name: data.name, email: data.email, role: data.role, passwordHash: await hashPassword(data.password) },
      select: userSelect,
    });
    res.status(201).json(user);
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    if (id === req.user!.id) throw badRequest('You cannot deactivate your own account');
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target || target.role === 'CUSTOMER') throw new HttpError(404, 'Staff user not found');
    const user = await prisma.user.update({ where: { id }, data: { active }, select: userSelect });
    res.json(user);
  }),
);

export default router;
