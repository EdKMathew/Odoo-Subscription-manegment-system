import { prisma } from '../lib/prisma';
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
  return { sent };
}
