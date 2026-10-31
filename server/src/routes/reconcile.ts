import { Router } from 'express';
import express from 'express';
import Papa from 'papaparse';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest } from '../lib/errors';
import { requireAuth, staffOnly } from '../middleware/auth';
import { recordPayment } from './invoices';

const router = Router();
router.use(requireAuth, staffOnly);

interface StatementRow {
  row: number;
  date: string;
  description: string;
  amount: number;
}

const pick = (rec: Record<string, string>, names: string[]) => {
  const key = Object.keys(rec).find((k) => names.includes(k.trim().toLowerCase()));
  return key ? rec[key] : undefined;
};

// Accepts the common bank export columns: date, description/narration/reference, amount/credit.
function parseStatement(csv: string): StatementRow[] {
  const parsed = Papa.parse<Record<string, string>>(csv.trim(), { header: true, skipEmptyLines: true });
  if (!parsed.data.length) throw badRequest('The file has no rows');
  const rows: StatementRow[] = [];
  parsed.data.slice(0, 2000).forEach((rec, i) => {
    const rawAmount = pick(rec, ['amount', 'credit', 'deposit', 'credit amount']);
    const amount = Math.round(Number(String(rawAmount ?? '').replace(/[₹,\s]/g, '')) * 100);
    if (!Number.isFinite(amount) || amount <= 0) return; // debits and blank rows are ignored
    rows.push({
      row: i + 2,
      date: (pick(rec, ['date', 'txn date', 'transaction date', 'value date']) ?? '').trim(),
      description: (pick(rec, ['description', 'narration', 'reference', 'remarks', 'particulars']) ?? '').trim().slice(0, 300),
      amount,
    });
  });
  if (!rows.length) throw badRequest('No credit rows found. Expected columns: date, description, amount');
  return rows;
}

// Generic words that say nothing about who paid.
const STOP = new Set(['customer', 'ltd', 'pvt', 'private', 'limited', 'the', 'and', 'india', 'services', 'neft', 'imps', 'rtgs', 'upi', 'from', 'payment', 'transfer']);
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));

// Matches each bank credit to an open invoice: by invoice number in the reference,
// then exact amount + customer name, then exact amount alone, then fuzzy name match.
router.post(
  '/preview',
  express.json({ limit: '1mb' }),
  asyncHandler(async (req, res) => {
    const { csv } = z.object({ csv: z.string().min(1).max(900_000) }).parse(req.body);
    const rows = parseStatement(csv);
    const open = await prisma.invoice.findMany({
      where: { status: 'CONFIRMED' },
      select: { id: true, number: true, total: true, amountPaid: true, customer: { select: { name: true } } },
    });
    const byNumber = new Map(open.map((i) => [i.number.toUpperCase(), i]));
    const used = new Set<number>();

    const results = rows.map((r) => {
      const balanceOf = (i: (typeof open)[number]) => i.total - i.amountPaid;
      const candidates = open.filter((i) => !used.has(i.id));
      let match: (typeof open)[number] | undefined;
      let confidence = 0;
      let reason = '';

      const num = r.description.toUpperCase().match(/INV-?\d{1,8}/);
      if (num) {
        const key = num[0].includes('-') ? num[0] : num[0].replace('INV', 'INV-');
        const padded = key.replace(/INV-(\d+)/, (_, d: string) => `INV-${d.padStart(6, '0')}`);
        match = byNumber.get(padded);
        if (match && !used.has(match.id)) {
          confidence = r.amount <= balanceOf(match) ? 0.99 : 0.8;
          reason = 'Invoice number in reference';
        } else match = undefined;
      }
      if (!match) {
        const desc = words(r.description);
        const sameAmount = candidates.filter((i) => balanceOf(i) === r.amount);
        const named = sameAmount.filter((i) => [...words(i.customer.name)].some((w) => desc.has(w)));
        if (named.length === 1) {
          match = named[0];
          confidence = 0.9;
          reason = 'Exact amount and customer name';
        } else if (sameAmount.length === 1) {
          match = sameAmount[0];
          confidence = 0.7;
          reason = 'Exact amount (only one open invoice)';
        } else {
          let best = 0;
          for (const i of candidates) {
            if (r.amount > balanceOf(i)) continue;
            const name = words(i.customer.name);
            const overlap = [...name].filter((w) => desc.has(w)).length / Math.max(1, name.size);
            if (overlap > best) {
              best = overlap;
              match = i;
            }
          }
          if (match && best >= 0.5) {
            confidence = Math.round(best * 50) / 100;
            reason = 'Customer name looks similar';
          } else match = undefined;
        }
      }
      if (match) used.add(match.id);
      return {
        ...r,
        match: match
          ? { invoiceId: match.id, number: match.number, customer: match.customer.name, balance: match.total - match.amountPaid }
          : null,
        confidence,
        reason,
      };
    });

    res.json({
      rows: results,
      matched: results.filter((r) => r.match).length,
      unmatched: results.filter((r) => !r.match).length,
    });
  }),
);

const applySchema = z.object({
  matches: z
    .array(
      z.object({
        invoiceId: z.number().int().positive(),
        amount: z.number().int().positive(),
        date: z.string().max(40),
        reference: z.string().max(300).optional(),
      }),
    )
    .min(1)
    .max(500),
});

// Records approved matches as bank-transfer payments. Each is validated like a manual payment.
router.post(
  '/apply',
  asyncHandler(async (req, res) => {
    const { matches } = applySchema.parse(req.body);
    const results = [];
    for (const m of matches) {
      const parsed = new Date(m.date);
      const paidAt = Number.isNaN(parsed.getTime()) || parsed > new Date() ? new Date() : parsed;
      try {
        await recordPayment(
          m.invoiceId,
          { amount: m.amount, method: 'BANK_TRANSFER', paidAt, reference: m.reference?.slice(0, 100) ?? null, note: 'Matched from bank statement' },
          req.user!,
        );
        results.push({ invoiceId: m.invoiceId, ok: true });
      } catch (err) {
        results.push({ invoiceId: m.invoiceId, ok: false, error: (err as Error).message });
      }
    }
    res.json({ applied: results.filter((r) => r.ok).length, results });
  }),
);

export default router;
