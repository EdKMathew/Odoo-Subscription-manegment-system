import type { Prisma } from '@prisma/client';
import { nextNumber } from '../lib/numbering';
import { formatINR } from '../lib/money';
import type { AuthUser } from '../middleware/auth';
import type { PricedInvoice, PricedLine } from './pricing';

type Tx = Prisma.TransactionClient;

export async function issueCreditNote(
  tx: Tx,
  input: { customerId: number; subscriptionId?: number | null; invoiceId?: number | null; reason: string; total: number; taxAmount: number },
  actor: AuthUser | null,
) {
  return tx.creditNote.create({
    data: {
      number: await nextNumber(tx, 'CN'),
      customerId: input.customerId,
      subscriptionId: input.subscriptionId ?? null,
      invoiceId: input.invoiceId ?? null,
      reason: input.reason,
      total: input.total,
      taxAmount: input.taxAmount,
      remaining: input.total,
      createdById: actor?.id ?? null,
    },
  });
}

// Uses the customer's open credit notes (oldest first) to reduce an invoice that is
// about to be created. Returns the adjusted invoice and which credits were used.
// Credit lines are negative and carry their share of tax so GST totals stay correct.
export async function applyOpenCredits(tx: Tx, customerId: number, priced: PricedInvoice) {
  const credits = await tx.creditNote.findMany({
    where: { customerId, status: 'OPEN', remaining: { gt: 0 } },
    orderBy: { createdAt: 'asc' },
  });
  let room = priced.total;
  const lines: PricedLine[] = [];
  const used: { id: number; amount: number; remaining: number }[] = [];
  for (const c of credits) {
    if (room <= 0) break;
    const amount = Math.min(room, c.remaining);
    const tax = c.total > 0 ? Math.round((amount * c.taxAmount) / c.total) : 0;
    lines.push({
      productId: null,
      description: `Credit note ${c.number}`,
      explanation: `${c.reason} · ${formatINR(amount)} of ${formatINR(c.total)} credit applied`,
      quantity: 1,
      unitPrice: -(amount - tax),
      discountAmount: 0,
      taxRateBp: 0,
      taxAmount: -tax,
      amount: -amount,
    });
    used.push({ id: c.id, amount, remaining: c.remaining - amount });
    room -= amount;
  }
  if (!used.length) return { priced, used };
  const creditTotal = used.reduce((s, u) => s + u.amount, 0);
  const creditTax = lines.reduce((s, l) => s - l.taxAmount, 0);
  return {
    priced: {
      ...priced,
      lines: [...priced.lines, ...lines],
      subtotal: priced.subtotal - (creditTotal - creditTax),
      taxTotal: priced.taxTotal - creditTax,
      total: priced.total - creditTotal,
    },
    used,
  };
}

// Records that the credits were consumed by the given invoice.
export async function markCreditsUsed(tx: Tx, invoiceId: number, used: { id: number; remaining: number }[]) {
  for (const u of used) {
    await tx.creditNote.update({
      where: { id: u.id },
      data: {
        remaining: u.remaining,
        status: u.remaining > 0 ? 'OPEN' : 'APPLIED',
        appliedToInvoices: { connect: { id: invoiceId } },
      },
    });
  }
}
