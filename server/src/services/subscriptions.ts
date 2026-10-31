import type { Prisma, SubscriptionStatus } from '@prisma/client';
import { conflict, forbidden } from '../lib/errors';
import type { AuthUser } from '../middleware/auth';

type Tx = Prisma.TransactionClient;

// The only transitions the system allows. Anything else is rejected.
export const TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  DRAFT: ['QUOTATION'],
  QUOTATION: ['CONFIRMED'],
  CONFIRMED: ['ACTIVE'],
  ACTIVE: ['PAUSED', 'CLOSED'],
  PAUSED: ['ACTIVE', 'CLOSED'],
  CLOSED: [],
};

export function assertTransition(
  from: SubscriptionStatus,
  to: SubscriptionStatus,
  plan: { pausable: boolean; closable: boolean },
  actor: AuthUser | null,
) {
  if (!TRANSITIONS[from].includes(to)) {
    throw conflict(`Cannot move a subscription from ${from} to ${to}`);
  }
  if (to === 'PAUSED' && !plan.pausable) throw conflict('This plan does not allow pausing');
  // Plan-level "closable" controls whether the customer can close it themselves.
  if (to === 'CLOSED' && actor?.role === 'CUSTOMER' && !plan.closable) {
    throw forbidden('This plan cannot be cancelled from the portal, please contact us');
  }
}

export async function logEvent(
  tx: Tx,
  subscriptionId: number,
  event: { type: string; message: string; fromStatus?: string; toStatus?: string },
  actor: AuthUser | null,
) {
  await tx.subscriptionEvent.create({
    data: {
      subscriptionId,
      ...event,
      actorId: actor?.id ?? null,
      actorName: actor ? `${actor.name} (${actor.role.toLowerCase()})` : 'System',
    },
  });
}
