import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { inr } from '../../lib/format';
import { Alert, Button, Card, PageHeader, Table, Td } from '../../components/ui';

interface Row {
  row: number;
  date: string;
  description: string;
  amount: number;
  match: { invoiceId: number; number: string; customer: string; balance: number } | null;
  confidence: number;
  reason: string;
}

const tone = (c: number) => (c >= 0.9 ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : c >= 0.7 ? 'bg-sky-50 text-sky-700 ring-sky-200' : 'bg-amber-50 text-amber-800 ring-amber-200');

// Upload a bank statement CSV, review suggested invoice matches, approve them as payments.
export function Reconcile() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [approved, setApproved] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState('');

  const upload = async (file: File) => {
    setError(null);
    setDone(null);
    if (file.size > 800_000) return setError('File is too large (max 800 KB)');
    setBusy(true);
    setFileName(file.name);
    try {
      const csv = await file.text();
      const r = await api.post<{ rows: Row[] }>('/reconcile/preview', { csv });
      setRows(r.rows);
      // Pre-approve only high-confidence matches; staff decide on the rest.
      setApproved(new Set(r.rows.filter((x) => x.match && x.confidence >= 0.9).map((x) => x.row)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!rows) return;
    setBusy(true);
    setError(null);
    try {
      const matches = rows
        .filter((r) => r.match && approved.has(r.row))
        .map((r) => ({ invoiceId: r.match!.invoiceId, amount: Math.min(r.amount, r.match!.balance), date: r.date, reference: r.description }));
      const res = await api.post<{ applied: number; results: { ok: boolean; error?: string }[] }>('/reconcile/apply', { matches });
      const failed = res.results.filter((x) => !x.ok);
      setDone(`${res.applied} payments recorded.${failed.length ? ` ${failed.length} failed: ${failed[0].error}` : ''}`);
      setRows(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (row: number) => {
    const next = new Set(approved);
    if (next.has(row)) next.delete(row);
    else next.add(row);
    setApproved(next);
  };

  return (
    <>
      <PageHeader title="Bank matching" sub="Upload a bank statement and match credits to open invoices instead of scrolling through it by hand" />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {done && <div className="mb-4"><Alert kind="success">{done} <Link to="/app/invoices?status=PAID" className="font-medium underline">View paid invoices</Link></Alert></div>}
      <Card>
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-300 px-4 py-8 text-center hover:border-brand-500 hover:bg-brand-50/40">
          <span className="text-sm font-medium text-slate-700">{fileName || 'Choose a CSV bank statement'}</span>
          <span className="text-xs text-slate-500">Columns: Date, Description (or Narration), Amount (or Credit)</span>
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
      </Card>
      {rows && (
        <Card
          className="mt-5"
          padded={false}
          title={`${rows.filter((r) => r.match).length} of ${rows.length} credits matched`}
          actions={
            <Button onClick={apply} loading={busy} disabled={!approved.size}>
              Record {approved.size} payments
            </Button>
          }
        >
          <Table head={['', 'Date', 'Bank description', 'Amount', 'Matched invoice', 'Confidence']}>
            {rows.map((r) => (
              <tr key={r.row} className={r.match ? '' : 'opacity-60'}>
                <Td>
                  <input type="checkbox" disabled={!r.match} checked={approved.has(r.row)} onChange={() => toggle(r.row)} className="h-4 w-4 rounded border-slate-300 text-brand-600" aria-label="Approve match" />
                </Td>
                <Td className="tabular">{r.date}</Td>
                <Td className="max-w-xs truncate" >{r.description}</Td>
                <Td className="tabular">{inr(r.amount)}</Td>
                <Td>
                  {r.match ? (
                    <>
                      <Link to={`/app/invoices/${r.match.invoiceId}`} className="font-medium text-brand-700 hover:underline">
                        {r.match.number}
                      </Link>
                      <span className="block text-xs text-slate-500">
                        {r.match.customer} · balance {inr(r.match.balance)}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-slate-400">No match</span>
                  )}
                </Td>
                <Td>
                  {r.match && (
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone(r.confidence)}`} title={r.reason}>
                      {Math.round(r.confidence * 100)}% · {r.reason}
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}
