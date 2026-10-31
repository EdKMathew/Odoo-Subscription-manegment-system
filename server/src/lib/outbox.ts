import { prisma } from './prisma';
import type { Prisma } from '@prisma/client';

// Emails are written to an outbox table instead of being sent, so they can be
// reviewed on the Outbox screen.
export async function queueEmail(
  email: { to: string; subject: string; body: string; kind: string },
  tx: Prisma.TransactionClient = prisma,
) {
  await tx.outboxEmail.create({ data: email });
}
