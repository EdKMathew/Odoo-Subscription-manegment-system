import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, conflict, notFound } from '../lib/errors';
import { customerScope, requireAuth, staffOnly } from '../middleware/auth';
import { idParam, optionalString, pageResult, paging } from '../lib/paging';
import { startOfDay } from '../lib/dates';
import { formatINR } from '../lib/money';
import { queueEmail } from '../lib/outbox';
import { config } from '../config';
import { logEvent } from '../services/subscriptions';
import { invoicePdfInclude, renderInvoicePdf } from '../services/pdf';

const router = Router();
router.use(requireAuth);

// Paid / Outstanding / Overdue, derived from the due date and amount paid.
export function paymentState(inv: { status: string; total: number; amountPaid: number; dueDate: Date }) {
  if (inv.status === 'CANCELLED') return 'CANCELLED';
  if (inv.status === 'DRAFT') return 'DRAFT';
  if (inv.amountPaid >= inv.total) return 'PAID';
  return inv.dueDate < startOfDay() ? 'OVERDUE' : 'OUTSTANDING';
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = paging(req);
    const status = z.enum(['DRAFT', 'CONFIRMED', 'PAID', 'CANCELLED', 'OVERDUE']).optional().parse(req.query.status || undefined);
    const q = optionalString(req.query.q);
    const ownCustomer = customerScope(req);
    const where: Prisma.InvoiceWhereInput = {
      ...(ownCustomer ? { customerId: ownCustomer, status: { not: 'DRAFT' } } : {}),
      ...(status === 'OVERDUE'
        ? { status: 'CONFIRMED', dueDate: { lt: startOfDay() } }
        : status
          ? { status }
          : {}),
      ...(q
        ? {
            OR: [
              { number: { contains: q, mode: 'insensitive' } },
              { customer: { name: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    // A customer filtering by DRAFT must still never see drafts.
    if (ownCustomer && status === 'DRAFT') return res.json(pageResult([], 0, page, pageSize));
    const [rows, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        skip,
        take,
        orderBy: { id: 'desc' },
        select: {
          id: true,
          number: true,
          status: true,
          issueDate: true,
          dueDate: true,
          total: true,
          amountPaid: true,
          customer: { select: { id: true, name: true } },
          subscription: { select: { id: true, number: true } },
        },
      }),
      prisma.invoice.count({ where }),
    ]);
    res.json(pageResult(rows.map((r) => ({ ...r, paymentState: paymentState(r) })), total, page, pageSize));
  }),
);

async function loadInvoice(req: Parameters<typeof customerScope>[0]) {
  const ownCustomer = customerScope(req);
  const inv = await prisma.invoice.findUnique({ where: { id: idParam(req) }, include: invoicePdfInclude });
  if (!inv || (ownCustomer && (inv.customerId !== ownCustomer || inv.status === 'DRAFT'))) throw notFound('Invoice not found');
  return inv;
}

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const inv = await loadInvoice(req);
    res.json({ ...inv, paymentState: paymentState(inv) });
  }),
);

router.get(
  '/:id/pdf',
  asyncHandler(async (req, res) => {
    const inv = await loadInvoice(req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${inv.number}.pdf"`);
    renderInvoicePdf(inv).pipe(res);
  }),
);

// Confirmed invoices are never edited; mistakes are fixed by cancelling and re-issuing.
router.post(
  '/:id/confirm',
  staffOnly,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const inv = await prisma.invoice.findUnique({ where: { id } });
    if (!inv) throw notFound('Invoice not found');
    await prisma.$transaction(async (tx) => {
      const r = await tx.invoice.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'CONFIRMED', confirmedAt: new Date() } });
      if (r.count !== 1) throw conflict('Only draft invoices can be confirmed');
      if (inv.subscriptionId) await logEvent(tx, inv.subscriptionId, { type: 'INVOICE', message: `Invoice ${inv.number} confirmed` }, req.user!);
    });
    res.json({ ok: true });
  }),
);

router.post(
  '/:id/cancel',
  staffOnly,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const inv = await prisma.invoice.findUnique({ where: { id } });
    if (!inv) throw notFound('Invoice not found');
    if (inv.amountPaid > 0) throw conflict('This invoice has payments recorded and cannot be cancelled');
    await prisma.$transaction(async (tx) => {
      const r = await tx.invoice.updateMany({
        where: { id, status: { in: ['DRAFT', 'CONFIRMED'] }, amountPaid: 0 },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      if (r.count !== 1) throw conflict('This invoice cannot be cancelled');
      if (inv.subscriptionId) await logEvent(tx, inv.subscriptionId, { type: 'INVOICE', message: `Invoice ${inv.number} cancelled` }, req.user!);
    });
    res.json({ ok: true });
  }),
);

router.post(
  '/:id/send',
  staffOnly,
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const inv = await prisma.invoice.findUnique({ where: { id }, include: { customer: true } });
    if (!inv) throw notFound('Invoice not found');
    if (inv.status === 'DRAFT' || inv.status === 'CANCELLED') throw conflict('Confirm the invoice before sending it');
    await queueEmail({
      to: inv.customer.email,
      kind: 'INVOICE',
      subject: `Invoice ${inv.number} from ${config.companyName}`,
      body: `Hi ${inv.customer.name},\n\nInvoice ${inv.number} for ${formatINR(inv.total)} is due on ${inv.dueDate.toDateString()}.\nBalance due: ${formatINR(inv.total - inv.amountPaid)}.\n\nYou can view and download it from your customer portal: ${config.clientUrl}/portal/invoices/${inv.id}`,
    });
    await prisma.invoice.update({ where: { id }, data: { sentAt: new Date() } });
    res.json({ ok: true });
  }),
);

const paymentSchema = z.object({
  amount: z.coerce.number().positive().max(100_000_000).transform((r) => Math.round(r * 100)),
  method: z.enum(['CASH', 'BANK_TRANSFER', 'UPI', 'CARD', 'CHEQUE']),
  paidAt: z.coerce.date().refine((d) => d <= new Date(Date.now() + 60_000), 'Payment date cannot be in the future'),
  note: z.string().trim().max(500).optional().nullable(),
  reference: z.string().trim().max(100).optional().nullable(),
});

// Partial payments are allowed; the invoice becomes PAID once fully covered.
export async function recordPayment(invoiceId: number, input: z.infer<typeof paymentSchema>, actor: { id: number; name: string; role: 'ADMIN' | 'STAFF' | 'CUSTOMER'; email: string; customerId: number | null }) {
  return prisma.$transaction(async (tx) => {
    // Lock the invoice row so two concurrent payments can't overpay it.
    const rows = await tx.$queryRaw<{ id: number }[]>`SELECT "id" FROM "Invoice" WHERE "id" = ${invoiceId} FOR UPDATE`;
    if (!rows.length) throw notFound('Invoice not found');
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { customer: true } });
    if (inv.status !== 'CONFIRMED') throw conflict('Payments can only be recorded against confirmed, unpaid invoices');
    const outstanding = inv.total - inv.amountPaid;
    if (input.amount > outstanding) throw badRequest(`Amount is more than the balance due (${formatINR(outstanding)})`);
    const payment = await tx.payment.create({ data: { ...input, invoiceId, recordedById: actor.id } });
    const amountPaid = inv.amountPaid + input.amount;
    const paid = amountPaid >= inv.total;
    await tx.invoice.update({ where: { id: invoiceId }, data: { amountPaid, status: paid ? 'PAID' : 'CONFIRMED' } });
    if (inv.subscriptionId) {
      await logEvent(
        tx,
        inv.subscriptionId,
        { type: 'PAYMENT', message: `Payment of ${formatINR(input.amount)} by ${input.method.replace('_', ' ').toLowerCase()} on ${inv.number}${paid ? ' (fully paid)' : ''}` },
        actor,
      );
    }
    await queueEmail(
      {
        to: inv.customer.email,
        kind: 'PAYMENT_RECEIPT',
        subject: `Payment received for ${inv.number}`,
        body: `Hi ${inv.customer.name},\n\nWe received ${formatINR(input.amount)} on ${input.paidAt.toDateString()} against invoice ${inv.number}.\nRemaining balance: ${formatINR(inv.total - amountPaid)}.\n\nThank you.`,
      },
      tx,
    );
    return payment;
  });
}

router.post(
  '/:id/payments',
  staffOnly,
  asyncHandler(async (req, res) => {
    const payment = await recordPayment(idParam(req), paymentSchema.parse(req.body), req.user!);
    res.status(201).json(payment);
  }),
);

export default router;
