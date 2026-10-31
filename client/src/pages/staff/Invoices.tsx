import { useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, qs, type Page } from '../../lib/api';
import { useApi, useDebounced } from '../../lib/hooks';
import { date, dateTime, inr, titleCase, toInputDate } from '../../lib/format';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Pager, Select, Spinner, Table, Td } from '../../components/ui';
import { BillBreakdown } from '../../components/BillBreakdown';
import { CreditNoteModal } from '../../components/PlanChange';

interface InvoiceRow {
  id: number;
  number: string;
  status: string;
  paymentState: string;
  issueDate: string;
  dueDate: string;
  total: number;
  amountPaid: number;
  customer: { id: number; name: string };
  subscription: { id: number; number: string } | null;
}

export function InvoiceList({ portal }: { portal?: boolean }) {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const term = useDebounced(q);
  const status = params.get('status') ?? '';
  const page = Number(params.get('page') ?? 1);
  const { data, loading, error, reload } = useApi<Page<InvoiceRow>>(`/invoices${qs({ status, q: term, page })}`);
  const base = portal ? '/portal' : '/app';
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const confirmAll = async () => {
    if (!window.confirm(`Confirm all ${data?.total ?? ''} draft invoices?`)) return;
    setConfirming(true);
    try {
      const r = await api.post<{ confirmed: number }>('/invoices/confirm-drafts', {});
      setNotice(`${r.confirmed} invoices confirmed.`);
      reload();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setConfirming(false);
    }
  };

  const update = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== 'page') next.delete('page');
    setParams(next);
  };

  return (
    <>
      <PageHeader
        title="Invoices"
        sub={portal ? 'Your invoices and what you owe' : 'Draft, confirmed, paid and cancelled invoices'}
        actions={
          !portal &&
          status === 'DRAFT' &&
          !!data?.total && (
            <Button loading={confirming} onClick={confirmAll}>
              Confirm all drafts
            </Button>
          )
        }
      />
      {notice && <div className="mb-4"><Alert kind="info">{notice}</Alert></div>}
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <Input placeholder="Search number or customer" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
          <Select value={status} onChange={(e) => update('status', e.target.value)} className="max-w-[180px]">
            <option value="">All</option>
            {!portal && <option value="DRAFT">Draft</option>}
            <option value="CONFIRMED">Confirmed (unpaid)</option>
            <option value="OVERDUE">Overdue</option>
            <option value="PAID">Paid</option>
            <option value="CANCELLED">Cancelled</option>
          </Select>
        </div>
        {error && <div className="p-3"><Alert>{error}</Alert></div>}
        {loading && !data ? (
          <Spinner />
        ) : (
          <Table head={['Number', ...(portal ? [] : ['Customer']), 'Issued', 'Due', 'Total', 'Balance', 'Status']} empty={data?.data.length === 0}>
            {data?.data.map((i) => (
              <tr key={i.id} className="hover:bg-slate-50">
                <Td>
                  <Link to={`${base}/invoices/${i.id}`} className="font-medium text-brand-700 hover:underline">
                    {i.number}
                  </Link>
                </Td>
                {!portal && <Td>{i.customer.name}</Td>}
                <Td className="tabular">{date(i.issueDate)}</Td>
                <Td className="tabular">{date(i.dueDate)}</Td>
                <Td className="tabular">{inr(i.total)}</Td>
                <Td className="tabular">{inr(i.total - i.amountPaid)}</Td>
                <Td>
                  <Badge value={i.paymentState} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
        {data && <Pager page={data.page} pages={data.pages} total={data.total} onPage={(p) => update('page', String(p))} />}
      </Card>
    </>
  );
}

interface InvoiceDetailData {
  id: number;
  number: string;
  status: string;
  paymentState: string;
  issueDate: string;
  dueDate: string;
  periodStart: string;
  periodEnd: string;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  amountPaid: number;
  taxSplit: 'INTRA' | 'INTER';
  sentAt: string | null;
  customer: { id: number; name: string; email: string; gstin: string | null; state: string | null };
  subscription: { number: string; plan: { name: string } } | null;
  subscriptionId: number | null;
  lines: { id: number; description: string; explanation: string; quantity: number; unitPrice: number; discountAmount: number; taxRateBp: number; taxAmount: number; amount: number }[];
  payments: { id: number; amount: number; method: string; paidAt: string; note: string | null; reference: string | null }[];
  creditNotes: { id: number; number: string; reason: string; total: number; remaining: number; status: string; createdAt: string }[];
}

export function InvoiceDetail({ portal }: { portal?: boolean }) {
  const { id } = useParams();
  const { data, error, loading, reload } = useApi<InvoiceDetailData>(`/invoices/${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [paying, setPaying] = useState(false);
  const [crediting, setCrediting] = useState(false);

  const act = async (action: string, label: string) => {
    if (action === 'cancel' && !window.confirm('Cancel this invoice? This cannot be undone.')) return;
    setBusy(action);
    setMsg(null);
    try {
      await api.post(`/invoices/${id}/${action}`);
      setMsg({ kind: 'success', text: label });
      reload();
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <Spinner />;
  if (error) return <Alert>{error}</Alert>;
  if (!data) return null;
  const balance = data.total - data.amountPaid;
  const base = portal ? '/portal' : '/app';

  return (
    <>
      <PageHeader
        title={data.number}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <Badge value={data.paymentState} />
            <span>
              {data.customer.name}
              {data.subscription && <> · {data.subscription.number}</>}
            </span>
          </span>
        }
        actions={
          <>
            <a href={`/api/invoices/${data.id}/pdf`}>
              <Button variant="secondary">Download PDF</Button>
            </a>
            {!portal && data.customer.gstin && (data.status === 'CONFIRMED' || data.status === 'PAID') && (
              <a href={`/api/invoices/${data.id}/einvoice`} title="GST e-invoice (IRN) JSON for upload to the Invoice Registration Portal">
                <Button variant="secondary">E-invoice JSON</Button>
              </a>
            )}
            {!portal && data.status === 'DRAFT' && (
              <Button loading={busy === 'confirm'} onClick={() => act('confirm', 'Invoice confirmed')}>
                Confirm
              </Button>
            )}
            {!portal && data.status === 'CONFIRMED' && (
              <>
                <Button variant="secondary" loading={busy === 'send'} onClick={() => act('send', `Invoice emailed to ${data.customer.email}`)}>
                  Send
                </Button>
                <Button onClick={() => setPaying(true)}>Record payment</Button>
              </>
            )}
            {!portal && (data.status === 'DRAFT' || data.status === 'CONFIRMED') && data.amountPaid === 0 && (
              <Button variant="danger" loading={busy === 'cancel'} onClick={() => act('cancel', 'Invoice cancelled')}>
                Cancel
              </Button>
            )}
          </>
        }
      />
      {msg && <div className="mb-4"><Alert kind={msg.kind}>{msg.text}</Alert></div>}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Lines" className="lg:col-span-2">
          <BillBreakdown priced={data} defaultOpen />
        </Card>
        <div className="space-y-5">
          <Card title="Summary">
            <dl className="space-y-2.5 text-sm">
              <Row k="Issued" v={date(data.issueDate)} />
              <Row k="Due" v={date(data.dueDate)} />
              <Row k="Period" v={`${date(data.periodStart)} – ${date(data.periodEnd)}`} />
              <Row k="Total" v={inr(data.total)} />
              <Row k="Paid" v={inr(data.amountPaid)} />
              <Row k="Balance due" v={<span className={balance > 0 && data.paymentState === 'OVERDUE' ? 'text-red-600' : ''}>{inr(balance)}</span>} />
              {data.customer.gstin && <Row k="Customer GSTIN" v={data.customer.gstin} />}
              <Row k="Tax type" v={data.taxSplit === 'INTER' ? 'IGST (inter-state)' : 'CGST + SGST'} />
              {data.sentAt && <Row k="Last sent" v={dateTime(data.sentAt)} />}
              {data.subscriptionId && !portal && (
                <Row k="Subscription" v={<Link className="text-brand-700 hover:underline" to={`${base}/subscriptions/${data.subscriptionId}`}>{data.subscription?.number}</Link>} />
              )}
            </dl>
          </Card>
          <Card title="Payments" actions={!portal && (data.status === 'CONFIRMED' || data.status === 'PAID') && <Button size="sm" variant="ghost" onClick={() => setCrediting(true)}>Issue credit note</Button>}>
            {data.payments.length === 0 ? (
              <p className="text-sm text-slate-500">No payments yet.</p>
            ) : (
              <ul className="space-y-3">
                {data.payments.map((p) => (
                  <li key={p.id} className="text-sm">
                    <div className="flex justify-between">
                      <span className="font-medium">{titleCase(p.method)}</span>
                      <span className="tabular">{inr(p.amount)}</span>
                    </div>
                    <p className="text-xs text-slate-500">
                      {date(p.paidAt)}
                      {p.reference && <> · Ref {p.reference}</>}
                      {p.note && <> · {p.note}</>}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {data.creditNotes.length > 0 && (
            <Card title="Credit notes">
              <ul className="space-y-3 text-sm">
                {data.creditNotes.map((c) => (
                  <li key={c.id}>
                    <div className="flex justify-between gap-3">
                      <span className="font-medium">{c.number}</span>
                      <span className="tabular">{inr(c.total)}</span>
                    </div>
                    <p className="text-xs text-slate-500">
                      {date(c.createdAt)} · {c.reason} · {c.status === 'APPLIED' ? 'deducted from a later invoice' : `${inr(c.remaining)} to deduct from the next invoice`}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
      {crediting && (
        <CreditNoteModal
          invoiceId={data.id}
          max={data.total - data.creditNotes.reduce((s, c) => s + (c.status === 'VOID' ? 0 : c.total), 0)}
          onClose={() => setCrediting(false)}
          onDone={(text) => {
            setCrediting(false);
            setMsg({ kind: 'success', text });
            reload();
          }}
        />
      )}
      <PaymentModal open={paying} onClose={() => setPaying(false)} invoiceId={data.id} balance={balance} onDone={() => { setPaying(false); setMsg({ kind: 'success', text: 'Payment recorded' }); reload(); }} />
    </>
  );
}

function PaymentModal({ open, onClose, invoiceId, balance, onDone }: { open: boolean; onClose: () => void; invoiceId: number; balance: number; onDone: () => void }) {
  const [form, setForm] = useState({ amount: '', method: 'UPI', paidAt: toInputDate(new Date()), reference: '', note: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/invoices/${invoiceId}/payments`, {
        amount: Number(form.amount),
        method: form.method,
        paidAt: form.paidAt,
        reference: form.reference || null,
        note: form.note || null,
      });
      setForm({ ...form, amount: '', reference: '', note: '' });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Record payment">
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Amount (₹)" hint={<>Balance due {inr(balance)}. Partial payments are fine. <button type="button" className="font-medium text-brand-600" onClick={() => setForm({ ...form, amount: String(balance / 100) })}>Pay full</button></>}>
          <Input type="number" step="0.01" min="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Method">
            <Select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              {['UPI', 'BANK_TRANSFER', 'CARD', 'CASH', 'CHEQUE'].map((m) => (
                <option key={m} value={m}>
                  {titleCase(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date">
            <Input type="date" required value={form.paidAt} max={toInputDate(new Date())} onChange={(e) => setForm({ ...form, paidAt: e.target.value })} />
          </Field>
        </div>
        <Field label="Reference">
          <Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="UTR / cheque no." />
        </Field>
        <Field label="Note">
          <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Record
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex justify-between gap-3">
    <dt className="text-slate-500">{k}</dt>
    <dd className="text-right font-medium tabular">{v}</dd>
  </div>
);
