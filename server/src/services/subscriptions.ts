import type { BillingPeriod, Prisma, SubscriptionStatus } from '@prisma/client';
import { conflict, forbidden } from '../lib/errors';
import { monthlyFactor } from '../lib/dates';
import { nextNumber } from '../lib/numbering';
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

// MRR movement categories recorded on subscription events.
export type MrrKind = 'NEW' | 'EXPANSION' | 'CONTRACTION' | 'CHURN' | 'CHURN_INVOLUNTARY' | 'PAUSE' | 'REACTIVATION';

// Monthly recurring value of a subscription: plan fee plus lines, normalised to a month.
// Matches the SQL used for the MRR total on the dashboard.
export function monthlyValue(plan: { price: number; billingPeriod: BillingPeriod }, lines: { quantity: number; unitPrice: number }[]) {
  const perPeriod = plan.price + lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  return Math.round(perPeriod * monthlyFactor[plan.billingPeriod]);
}

export async function logEvent(
  tx: Tx,
  subscriptionId: number,
  event: { type: string; message: string; fromStatus?: string; toStatus?: string; mrrKind?: MrrKind; mrrDelta?: number },
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

// Drafts a renewal: a new subscription with the same plan and lines, starting
// when the current one expires, ready to be sent as a quotation.
export async function draftRenewal(
  tx: Tx,
  sub: Prisma.SubscriptionGetPayload<{ include: { plan: true; lines: true } }>,
  actor: AuthUser | null,
) {
  if (!sub.plan.renewable) throw conflict('This plan is not renewable');
  if (!sub.expiryDate) throw conflict('This subscription has no expiry date to renew from');
  if (sub.status !== 'ACTIVE' && sub.status !== 'PAUSED') throw conflict('Only active or paused subscriptions can be renewed');
  const existing = await tx.subscription.findUnique({ where: { renewalOfId: sub.id }, select: { number: true } });
  if (existing) throw conflict(`A renewal is already drafted as ${existing.number}`);

  const length = sub.startDate ? sub.expiryDate.getTime() - sub.startDate.getTime() : null;
  const created = await tx.subscription.create({
    data: {
      number: await nextNumber(tx, 'SUB'),
      customerId: sub.customerId,
      planId: sub.planId,
      renewalOfId: sub.id,
      startDate: sub.expiryDate,
      expiryDate: length ? new Date(sub.expiryDate.getTime() + length) : null,
      paymentTermDays: sub.paymentTermDays,
      notes: `Renewal of ${sub.number}`,
      createdById: actor?.id ?? null,
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
  await logEvent(tx, created.id, { type: 'CREATED', toStatus: 'DRAFT', message: `Drafted as renewal of ${sub.number}` }, actor);
  await logEvent(tx, sub.id, { type: 'RENEWAL', message: `Renewal drafted as ${created.number}` }, actor);
  return created;
}
