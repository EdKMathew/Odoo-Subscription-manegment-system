import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs, type Page } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { date, dateTime, inr, inrShort } from '../../lib/format';
import { Alert, Badge, Button, Card, PageHeader, Pager, Select, Spinner, Stat, Table, Td } from '../../components/ui';
import { useAuth } from '../../lib/auth';

interface RunResult {
  runId?: number;
  dryRun: boolean;
  invoiceCount: number;
  totalAmount: number;
  taxAmount: number;
  discountAmount: number;
  skippedAlreadyBilled: number;
  closed: number;
  flagged: { subscriptionId: number; number: string; customer: string; reasons: string[] }[];
  items: { subscriptionId: number; number: string; customer: string; total: number; periodStart: string }[];
}

export function BillingRun() {
  const runs = useApi<{ data: { id: number; runAt: string; triggeredBy: string; invoiceCount: number; totalAmount: number; flaggedCount: number }[] }>('/billing/runs');
  const [preview, setPreview] = useState<RunResult | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState<'dry' | 'real' | 'reminders' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? 'dry' : 'real');
    setError(null);
    try {
      const r = await api.post<RunResult>('/billing/run', { dryRun });
      if (dryRun) {
        setPreview(r);
        setResult(null);
      } else {
        setResult(r);
        setPreview(null);
        runs.reload();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const [confirming, setConfirming] = useState(false);
  const confirmRun = async (billingRunId: number) => {
    setConfirming(true);
    setError(null);
    try {
      const r = await api.post<{ confirmed: number }>('/invoices/confirm-drafts', { billingRunId });
      setResult(null);
      setNotice(`${r.confirmed} invoices confirmed and ready to send.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setConfirming(false);
    }
  };

  const sendReminders = async () => {
    setBusy('reminders');
    setError(null);
    try {
      const r = await api.post<{ sent: number; suspended: number }>('/billing/reminders');
      setNotice(`${r.sent} payment reminders sent${r.suspended ? `, ${r.suspended} subscriptions suspended after the grace period` : ''}. See the Outbox.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const shown = result ?? preview;

  return (
    <>
      <PageHeader
        title="Billing run"
        sub="Creates invoices for every active subscription whose billing date has arrived. Runs nightly; preview first to check before anything is created."
        actions={
          <>
            <Button variant="ghost" loading={busy === 'reminders'} onClick={sendReminders} title="Due-soon, due-today and overdue reminders">
              Send reminders
            </Button>
            <Button variant="secondary" loading={busy === 'dry'} onClick={() => run(true)}>
              Preview (dry run)
            </Button>
            <Button loading={busy === 'real'} disabled={!preview} title={!preview ? 'Preview first' : undefined} onClick={() => run(false)}>
              Generate invoices
            </Button>
          </>
        }
      />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {notice && <div className="mb-4"><Alert kind="info">{notice}</Alert></div>}
      {result && (
        <div className="mb-4">
          <Alert kind="success">
            Created {result.invoiceCount} draft invoices for {inr(result.totalAmount)}.
            {result.skippedAlreadyBilled > 0 && ` ${result.skippedAlreadyBilled} periods were already billed and skipped.`}
            {result.closed > 0 && ` ${result.closed} expired subscriptions were closed.`}{' '}
            <Link to="/app/invoices?status=DRAFT" className="font-medium underline">
              Review drafts
            </Link>
            {result.invoiceCount > 0 && result.runId && (
              <Button size="sm" className="ml-3" loading={confirming} onClick={() => confirmRun(result.runId!)}>
                Confirm all {result.invoiceCount}
              </Button>
            )}
          </Alert>
        </div>
      )}
      {preview && (
        <div className="mb-4">
          <Alert kind={preview.flagged.length ? 'warning' : 'info'}>
            Preview: {preview.invoiceCount} invoices, {inrShort(preview.totalAmount)}, {preview.flagged.length} flagged. Nothing has been created yet.
          </Alert>
        </div>
      )}

      {shown && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Invoices" value={shown.invoiceCount} />
            <Stat label="Total" value={inrShort(shown.totalAmount)} />
            <Stat label="Tax" value={inrShort(shown.taxAmount)} />
            <Stat label="Discounts" value={inrShort(shown.discountAmount)} />
          </div>
          {shown.flagged.length > 0 && (
            <Card title={`Flagged for review (${shown.flagged.length})`} padded={false}>
              <Table head={['Subscription', 'Customer', 'Why']}>
                {shown.flagged.map((f) => (
                  <tr key={f.subscriptionId}>
                    <Td>
                      <Link to={`/app/subscriptions/${f.subscriptionId}`} className="font-medium text-brand-700 hover:underline">
                        {f.number}
                      </Link>
                    </Td>
                    <Td>{f.customer}</Td>
                    <Td className="whitespace-normal">
                      <div className="flex flex-wrap gap-1">
                        {f.reasons.map((r) => (
                          <span key={r} className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800 ring-1 ring-amber-200">
                            {r}
                          </span>
                        ))}
                      </div>
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>
          )}
          <Card title={`Invoices ${shown.dryRun ? 'to be created' : 'created'}`} padded={false}>
            <Table head={['Subscription', 'Customer', 'Period start', 'Amount']} empty={!shown.items.length}>
              {shown.items.map((i) => (
                <tr key={`${i.subscriptionId}-${i.periodStart}`}>
                  <Td>{i.number}</Td>
                  <Td>{i.customer}</Td>
                  <Td className="tabular">{date(i.periodStart)}</Td>
                  <Td className="tabular">{inr(i.total)}</Td>
                </tr>
              ))}
            </Table>
            {shown.invoiceCount > shown.items.length && <p className="px-4 py-2 text-xs text-slate-500">Showing first {shown.items.length}.</p>}
          </Card>
        </div>
      )}

      <Card title="Recent runs" padded={false} className="mt-5">
        {runs.loading && !runs.data ? (
          <Spinner />
        ) : (
          <Table head={['When', 'By', 'Invoices', 'Amount', 'Flagged']} empty={runs.data?.data.length === 0}>
            {runs.data?.data.map((r) => (
              <tr key={r.id}>
                <Td>{dateTime(r.runAt)}</Td>
                <Td>{r.triggeredBy}</Td>
                <Td className="tabular">{r.invoiceCount}</Td>
                <Td className="tabular">{inr(r.totalAmount)}</Td>
                <Td className="tabular">{r.flaggedCount}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

export function Outbox() {
  const [kind, setKind] = useState('');
  const { data, loading } = useApi<{ data: { id: number; to: string; subject: string; body: string; kind: string; createdAt: string }[] }>(`/billing/outbox${qs({ kind })}`);
  const [open, setOpen] = useState<number | null>(null);
  const { user } = useAuth();
  return (
    <>
      <PageHeader title="Outbox" sub="Every email the system has sent: quotations, pre-debit notices, receipts and reminders." actions={
        <Select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All emails</option>
          <option value="QUOTATION">Quotations</option>
          <option value="PRE_DEBIT_NOTICE">Pre-debit notices</option>
          <option value="INVOICE">Invoices</option>
          <option value="PAYMENT_RECEIPT">Receipts</option>
          <option value="PAYMENT_REMINDER">Reminders</option>
          <option value="SUSPENSION">Suspensions</option>
          <option value="PASSWORD_RESET">Password resets</option>
          <option value="PORTAL_INVITE">Portal invites</option>
        </Select>
      } />
      {user?.role !== 'ADMIN' && <div className="mb-4"><Alert kind="info">Password links are hidden for staff.</Alert></div>}
      <Card padded={false}>
        {loading && !data ? (
          <Spinner />
        ) : (
          <ul className="divide-y divide-slate-100">
            {data?.data.length === 0 && <li className="px-4 py-10 text-center text-sm text-slate-500">No emails yet.</li>}
            {data?.data.map((e) => (
              <li key={e.id}>
                <button className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-slate-50" onClick={() => setOpen(open === e.id ? null : e.id)}>
                  <Badge value={e.kind} label={e.kind.replace(/_/g, ' ').toLowerCase()} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{e.subject}</span>
                  <span className="text-xs text-slate-500">
                    {e.to} · {dateTime(e.createdAt)}
                  </span>
                </button>
                {open === e.id && <pre className="mx-4 mb-3 whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 font-sans text-sm text-slate-700">{e.body}</pre>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

interface OverdueRow {
  id: number;
  number: string;
  dueDate: string;
  total: number;
  balance: number;
  daysOverdue: number;
  customer: { id: number; name: string; email: string };
  subscription: { id: number; number: string } | null;
}

export function Overdue() {
  const [params, setParams] = useSearchParams();
  const bucket = params.get('bucket') ?? '';
  const page = Number(params.get('page') ?? 1);
  const { data, loading } = useApi<Page<OverdueRow>>(`/reports/overdue${qs({ bucket, page })}`);
  const set = (b: string) => setParams(b ? { bucket: b } : {});
  return (
    <>
      <PageHeader title="Overdue invoices" sub="Receivables past their due date, grouped the way finance reads them" />
      <div className="mb-3 flex flex-wrap gap-2">
        {['', '0-30', '31-60', '61-90', '90+'].map((b) => (
          <Button key={b} size="sm" variant={bucket === b ? 'primary' : 'secondary'} onClick={() => set(b)}>
            {b ? `${b} days` : 'All'}
          </Button>
        ))}
      </div>
      <Card padded={false}>
        {loading && !data ? (
          <Spinner />
        ) : (
          <Table head={['Invoice', 'Customer', 'Due', 'Days overdue', 'Balance']} empty={data?.data.length === 0}>
            {data?.data.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <Td>
                  <Link to={`/app/invoices/${r.id}`} className="font-medium text-brand-700 hover:underline">
                    {r.number}
                  </Link>
                </Td>
                <Td>{r.customer.name}</Td>
                <Td className="tabular">{date(r.dueDate)}</Td>
                <Td className={r.daysOverdue > 60 ? 'font-medium text-red-600 tabular' : 'tabular'}>{r.daysOverdue}</Td>
                <Td className="tabular">{inr(r.balance)}</Td>
              </tr>
            ))}
          </Table>
        )}
        {data && <Pager page={data.page} pages={data.pages} total={data.total} onPage={(p) => setParams({ ...(bucket ? { bucket } : {}), page: String(p) })} />}
      </Card>
    </>
  );
}

export function Renewals() {
  const navigate = useNavigate();
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const renew = async (id: number) => {
    setError(null);
    try {
      const r = await api.post<{ id: number }>(`/subscriptions/${id}/renew`);
      navigate(`/app/subscriptions/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const [page, setPage] = useState(1);
  const [drafting, setDrafting] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const { data, loading, reload } = useApi<Page<{
      id: number;
      number: string;
      expiryDate: string;
      customer: { id: number; name: string };
      plan: { name: string; renewable: boolean };
      renewal: { id: number; number: string; status: string } | null;
    }>>(
    `/reports/renewals${qs({ days, page })}`,
  );
  const draftDue = async () => {
    setDrafting(true);
    setError(null);
    try {
      const r = await api.post<{ drafted: number }>('/billing/renewals');
      setInfo(r.drafted ? `${r.drafted} renewal drafts created, ready to send as quotations.` : 'All renewals due in the next 30 days are already drafted.');
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDrafting(false);
    }
  };
  return (
    <>
      <PageHeader title="Renewal radar" sub="Active subscriptions reaching their expiry date, so renewals aren't left to whoever notices first" />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {info && <div className="mb-4"><Alert kind="success">{info}</Alert></div>}
      <div className="mb-3 flex flex-wrap gap-2">
        {[7, 30, 60].map((d) => (
          <Button key={d} size="sm" variant={days === d ? 'primary' : 'secondary'} onClick={() => { setDays(d); setPage(1); }}>
            Next {d} days
          </Button>
        ))}
        <Button size="sm" variant="secondary" className="ml-auto" loading={drafting} onClick={draftDue} title="Also runs every night at 01:00">
          Draft all renewals due in 30 days
        </Button>
      </div>
      <Card padded={false}>
        {loading && !data ? (
          <Spinner />
        ) : (
          <Table head={['Subscription', 'Customer', 'Plan', 'Expires', 'In', '']} empty={data?.data.length === 0}>
            {data?.data.map((s) => {
              const left = Math.ceil((new Date(s.expiryDate).getTime() - Date.now()) / 86_400_000);
              return (
                <tr key={s.id} className="hover:bg-slate-50">
                  <Td>
                    <Link to={`/app/subscriptions/${s.id}`} className="font-medium text-brand-700 hover:underline">
                      {s.number}
                    </Link>
                  </Td>
                  <Td>{s.customer.name}</Td>
                  <Td>{s.plan.name}</Td>
                  <Td className="tabular">{date(s.expiryDate)}</Td>
                  <Td className={left <= 7 ? 'font-medium text-red-600 tabular' : 'tabular'}>{left} days</Td>
                  <Td>
                    {s.renewal ? (
                      <Link to={`/app/subscriptions/${s.renewal.id}`} className="text-xs font-medium text-brand-600">
                        {s.renewal.number} ({s.renewal.status.toLowerCase()})
                      </Link>
                    ) : s.plan.renewable ? (
                      <Button size="sm" variant="secondary" onClick={() => renew(s.id)}>
                        Draft renewal
                      </Button>
                    ) : (
                      <span className="text-xs text-slate-400">Not renewable</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
        {data && <Pager page={data.page} pages={data.pages} total={data.total} onPage={setPage} />}
      </Card>
    </>
  );
}
