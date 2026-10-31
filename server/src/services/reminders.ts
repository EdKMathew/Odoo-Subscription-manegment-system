import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { monthlyValue } from './subscriptions';
import { addDays, startOfDay } from '../lib/dates';
import { formatINR } from '../lib/money';
import { config } from '../config';

// Dunning ladder: a reminder 3 days before the due date, on the due date,
// then at +3 and +7 days overdue. An invoice only ever gets the latest stage
// it has reached, and each stage is sent at most once.
const STAGES = [
  { stage: 1, offsetDays: -3, subject: 'Payment due soon', line: 'is due in 3 days' },
  { stage: 2, offsetDays: 0, subject: 'Payment due today', line: 'is due today' },
  { stage: 3, offsetDays: 3, subject: 'Payment overdue', line: 'is now overdue' },
  { stage: 4, offsetDays: 7, subject: 'Final reminder: payment overdue', line: 'is now more than a week overdue' },
];

export async function sendPaymentReminders(asOf = new Date()) {
  const today = startOfDay(asOf);
  let sent = 0;
  // Highest stage first, so an invoice that is 30 days late gets only the final reminder.
  for (const s of [...STAGES].reverse()) {
    const lower = STAGES.find((x) => x.stage === s.stage + 1);
    const invoices = await prisma.invoice.findMany({
      where: {
        status: 'CONFIRMED',
        reminderStage: { lt: s.stage },
        dueDate: {
          lte: addDays(today, -s.offsetDays),
          // Not yet past the next stage's threshold (that stage handles it).
          ...(lower ? { gt: addDays(today, -lower.offsetDays) } : {}),
        },
      },
      select: { id: true, number: true, total: true, amountPaid: true, dueDate: true, customer: { select: { name: true, email: true } } },
      take: 5000,
    });
    if (!invoices.length) continue;
    await prisma.$transaction([
      prisma.invoice.updateMany({ where: { id: { in: invoices.map((i) => i.id) } }, data: { reminderStage: s.stage } }),
      prisma.outboxEmail.createMany({
        data: invoices.map((inv) => ({
          to: inv.customer.email,
          kind: 'PAYMENT_REMINDER',
          subject: `${s.subject}: ${inv.number}`,
          body: `Hi ${inv.customer.name},\n\nInvoice ${inv.number} for ${formatINR(inv.total - inv.amountPaid)} ${s.line} (due ${inv.dueDate.toDateString()}).\n\nYou can view it in your portal: ${config.clientUrl}/portal/invoices/${inv.id}`,
        })),
      }),
    ]);
    sent += invoices.length;
  }
  const { suspended } = await suspendForNonPayment(today);
  return { sent, suspended };
}

// After the final reminder there is a grace period. If an invoice is still unpaid
// SUSPEND_AFTER_DAYS past its due date, the subscription is suspended (paused), not
// closed, so it can come straight back when the customer pays.
export const SUSPEND_AFTER_DAYS = 14;

export async function suspendForNonPayment(today = startOfDay()) {
  const subs = await prisma.subscription.findMany({
    where: {
      status: 'ACTIVE',
      invoices: { some: { status: 'CONFIRMED', dueDate: { lt: addDays(today, -SUSPEND_AFTER_DAYS) } } },
    },
    include: { plan: true, lines: true, customer: { select: { name: true, email: true } } },
    take: 5000,
  });
  if (!subs.length) return { suspended: 0 };
  const now = new Date();
  await prisma.$transaction([
    prisma.subscription.updateMany({
      where: { id: { in: subs.map((s) => s.id) }, status: 'ACTIVE' },
      data: { status: 'PAUSED', pausedAt: now, suspendedAt: now },
    }),
    prisma.subscriptionEvent.createMany({
      data: subs.map((s) => ({
        subscriptionId: s.id,
        type: 'STATUS',
        fromStatus: 'ACTIVE',
        toStatus: 'PAUSED',
        message: `Suspended: invoice unpaid more than ${SUSPEND_AFTER_DAYS} days after the due date`,
        actorName: 'System',
        mrrKind: 'CHURN_INVOLUNTARY',
        mrrDelta: -monthlyValue(s.plan, s.lines),
      })),
    }),
    prisma.outboxEmail.createMany({
      data: subs.map((s) => ({
        to: s.customer.email,
        kind: 'SUSPENSION',
        subject: `Service suspended: ${s.number}`,
        body: `Hi ${s.customer.name},\n\nYour subscription ${s.number} (${s.plan.name}) has been suspended because an invoice is more than ${SUSPEND_AFTER_DAYS} days overdue.\n\nIt has not been cancelled. As soon as the overdue invoice is paid it will resume automatically, with your current pricing.\n\nView your invoices: ${config.clientUrl}/portal/invoices?status=OVERDUE`,
      })),
    }),
  ]);
  return { suspended: subs.length };
}

// Called after a payment: if nothing is badly overdue any more, a suspended
// subscription is restored and counted as recovered revenue.
export async function resumeIfRecovered(tx: Prisma.TransactionClient, subscriptionId: number) {
  const sub = await tx.subscription.findUnique({ where: { id: subscriptionId }, include: { plan: true, lines: true } });
  if (!sub || sub.status !== 'PAUSED' || !sub.suspendedAt) return false;
  const today = startOfDay();
  const stillOverdue = await tx.invoice.count({
    where: { subscriptionId, status: 'CONFIRMED', dueDate: { lt: addDays(today, -SUSPEND_AFTER_DAYS) } },
  });
  if (stillOverdue) return false;
  await tx.subscription.update({
    where: { id: subscriptionId },
    data: {
      status: 'ACTIVE',
      pausedAt: null,
      suspendedAt: null,
      ...(!sub.nextBillingDate || sub.nextBillingDate < today ? { nextBillingDate: today } : {}),
    },
  });
  await tx.subscriptionEvent.create({
    data: {
      subscriptionId,
      type: 'STATUS',
      fromStatus: 'PAUSED',
      toStatus: 'ACTIVE',
      message: 'Resumed automatically after the overdue invoice was paid',
      actorName: 'System',
      mrrKind: 'REACTIVATION',
      mrrDelta: monthlyValue(sub.plan, sub.lines),
    },
  });
  return true;
}
