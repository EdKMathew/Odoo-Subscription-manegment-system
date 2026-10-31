import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, HttpError } from '../lib/errors';
import { createToken, hashPassword, hashToken, passwordSchema, verifyPassword } from '../lib/password';
import { clearSession, issueSession, requireAuth } from '../middleware/auth';
import { queueEmail } from '../lib/outbox';
import { config } from '../config';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again in a few minutes' },
});

// bcrypt hash of a random string, compared against when the email is unknown.
const DUMMY_HASH = '$2a$12$rmYI/JYlVh6GXYgWm8cMUuQOeI.yacevjTmyC3wT1lR5SPBLiR.X6';

const emailSchema =z.string().trim().toLowerCase().email('Enter a valid email').max(254);

const signupSchema = z.object({
  name: z.string().trim().min(2, 'Name is too short').max(100),
  email: emailSchema,
  password: passwordSchema,
  phone: z.string().trim().max(20).optional(),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/, 'Enter a valid GSTIN')
    .optional()
    .or(z.literal('')),
  state: z.string().trim().max(50).optional(),
});

// Public signup always creates a customer account. Staff and admins are created by an admin.
router.post(
  '/signup',
  authLimiter,
  asyncHandler(async (req, res) => {
    const data = signupSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw new HttpError(409, 'An account with this email already exists');

    const passwordHash = await hashPassword(data.password);
    const user = await prisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({
        data: {
          name: data.name,
          email: data.email,
          phone: data.phone || null,
          gstin: data.gstin || null,
          state: data.state || null,
        },
      });
      return tx.user.create({
        data: { name: data.name, email: data.email, passwordHash, role: 'CUSTOMER', customerId: customer.id },
      });
    });

    issueSession(res, user.id);
    res.status(201).json({ user: publicUser(user) });
  }),
);

const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) });

router.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    // Same message and similar timing for unknown email and wrong password so accounts can't be enumerated.
    const ok = (await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH)) && user && user.active;
    if (!ok) throw new HttpError(401, 'Invalid email or password');
    issueSession(res, user.id);
    res.json({ user: publicUser(user) });
  }),
);

router.post('/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: req.user });
  }),
);

router.post(
  '/forgot-password',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email } = z.object({ email: emailSchema }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && user.active) {
      const { token, hash } = createToken();
      await prisma.$transaction([
        // Only the latest link should work.
        prisma.passwordReset.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } }),
        prisma.passwordReset.create({
          data: { userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + config.resetTokenMinutes * 60_000) },
        }),
      ]);
      const link = `${config.clientUrl}/reset-password?token=${token}`;
      await queueEmail({
        to: user.email,
        kind: 'PASSWORD_RESET',
        subject: 'Reset your password',
        body: `Hi ${user.name},\n\nUse this link to reset your password. It expires in ${config.resetTokenMinutes} minutes and can only be used once.\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`,
      });
    }
    // Always the same response, whether or not the email exists.
    res.json({ ok: true, message: 'If an account exists for that email, a reset link has been sent.' });
  }),
);

router.post(
  '/reset-password',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { token, password } = z
      .object({ token: z.string().regex(/^[a-f0-9]{64}$/, 'Invalid reset link'), password: passwordSchema })
      .parse(req.body);
    const reset = await prisma.passwordReset.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
      throw badRequest('This reset link is invalid or has expired');
    }
    const passwordHash = await hashPassword(password);
    // Mark used in the same statement that checks it, so the link can't be used twice concurrently.
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordReset.updateMany({
        where: { id: reset.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) throw badRequest('This reset link is invalid or has expired');
      await tx.user.update({ where: { id: reset.userId }, data: { passwordHash, passwordChangedAt: new Date() } });
    });
    res.json({ ok: true });
  }),
);

function publicUser(u: { id: number; email: string; name: string; role: string; customerId: number | null }) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, customerId: u.customerId };
}

export default router;
