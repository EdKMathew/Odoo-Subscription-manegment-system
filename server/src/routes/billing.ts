import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, conflict } from '../lib/errors';
import { requireAuth, staffOnly } from '../middleware/auth';
import { runBilling } from '../services/billing';
import { sendPaymentReminders } from '../services/reminders';
import { config } from '../config';

const router = Router();
router.use(requireAuth, staffOnly);

let running = false;
const SECRET_KINDS = ['PASSWORD_RESET', 'PORTAL_INVITE'];

const runSchema = z.object({ dryRun: z.boolean().default(true) });

// Dry run returns a preview without writing anything; a real run creates invoices.
router.post(
  '/run',
  asyncHandler(async (req, res) => {
    const { dryRun } = runSchema.parse(req.body);
    if (running) throw conflict('A billing run is already in progress');
    running = true;
    try {
      const result = await runBilling({ dryRun, triggeredBy: `${req.user!.name} (${req.user!.role.toLowerCase()})` });
      res.json(result);
    } finally {
      running = false;
    }
  }),
);

// Runs the payment reminder ladder now instead of waiting for the 09:00 job.
router.post(
  '/reminders',
  asyncHandler(async (_req, res) => {
    res.json(await sendPaymentReminders());
  }),
);

router.get(
  '/runs',
  asyncHandler(async (_req, res) => {
    const runs = await prisma.billingRun.findMany({
      orderBy: { runAt: 'desc' },
      take: 20,
      select: { id: true, runAt: true, triggeredBy: true, invoiceCount: true, totalAmount: true, flaggedCount: true },
    });
    res.json({ data: runs });
  }),
);

router.get(
  '/outbox',
  asyncHandler(async (req, res) => {
    const kind = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind.slice(0, 40) : undefined;
    const emails = await prisma.outboxEmail.findMany({
      where: kind ? { kind } : {},
      orderBy: { id: 'desc' },
      take: 100,
    });
    // Password links are credentials: only an admin on a dev build can see them (for demos).
    const showSecrets = req.user!.role === 'ADMIN' && !config.isProd;
    res.json({
      data: emails.map((e) =>
        SECRET_KINDS.includes(e.kind) && !showSecrets
          ? { ...e, body: e.body.replace(/token=[a-f0-9]+/g, 'token=[hidden]') }
          : e,
      ),
    });
  }),
);

export function isBillingRunning() {
  return running;
}

export function setBillingRunning(v: boolean) {
  running = v;
}

export default router;
