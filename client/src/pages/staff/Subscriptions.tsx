import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs, type Page } from '../../lib/api';
import { useApi, useDebounced } from '../../lib/hooks';
import { date, dateTime, inr, period, toInputDate } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Pager, Select, Spinner, Table, Td, Textarea } from '../../components/ui';
import { BillBreakdown, type Priced } from '../../components/BillBreakdown';
import { PlanChangeModal } from '../../components/PlanChange';

interface SubRow {
  id: number;
  number: string;
  status: string;
  startDate: string | null;
  expiryDate: string | null;
  nextBillingDate: string | null;
  customer: { id: number; name: string };
  plan: { id: number; name: string; billingPeriod: string };
}

const STATUSES = ['DRAFT', 'QUOTATION', 'CONFIRMED', 'ACTIVE', 'PAUSED', 'CLOSED'];

export function SubscriptionList({ portal }: { portal?: boolean }) {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const term = useDebounced(q);
  const status = params.get('status') ?? '';
  const page = Number(params.get('page') ?? 1);
  const { data, loading, error } = useApi<Page<SubRow>>(`/subscriptions${qs({ status, q: term, page })}`);
  const base = portal ? '/portal' : '/app';

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
        title="Subscriptions"
        sub={portal ? 'Your plans and their status' : 'Every subscription and where it stands'}
        actions={!portal && <Link to="/app/subscriptions/new"><Button>New subscription</Button></Link>}
      />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <Input placeholder="Search number or customer" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
          <Select value={status} onChange={(e) => update('status', e.target.value)} className="max-w-[180px]">
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
        </div>
        {error && <div className="p-3"><Alert>{error}</Alert></div>}
        {loading && !data ? (
          <Spinner />
        ) : (
          <Table head={['Number', 'Customer', 'Plan', 'Status', 'Next bill', 'Expires']} empty={data?.data.length === 0}>
            {data?.data.map((s) => (
              <tr key={s.id} className="hover:bg-slate-50">
                <Td>
                  <Link to={`${base}/subscriptions/${s.id}`} className="font-medium text-brand-700 hover:underline">
                    {s.number}
                  </Link>
                </Td>
                <Td>{s.customer.name}</Td>
                <Td>
                  {s.plan.name} <span className="text-xs text-slate-400">· {period[s.plan.billingPeriod]}</span>
                </Td>
                <Td>
                  <Badge value={s.status} />
                </Td>
                <Td className="tabular">{date(s.nextBillingDate)}</Td>
                <Td className="tabular">{date(s.expiryDate)}</Td>
              </tr>
            ))}
          </Table>
        )}
        {data && <Pager page={data.page} pages={data.pages} total={data.total} onPage={(p) => update('page', String(p))} />}
      </Card>
    </>
  );
}

interface SubDetail {
  id: number;
  number: string;
  status: string;
  startDate: string | null;
  expiryDate: string | null;
  nextBillingDate: string | null;
  paymentTermDays: number;
  quoteExpiresAt: string | null;
  acceptedAt: string | null;
  closeReason: string | null;
  notes: string | null;
  customer: { id: number; name: string; email: string; state: string | null; gstin: string | null };
  plan: { id: number; name: string; billingPeriod: string; pausable: boolean; closable: boolean; autoClose: boolean; renewable: boolean };
  lines: { id: number; description: string; quantity: number; unitPrice: number; variant: { name: string } | null }[];
  events: { id: number; type: string; message: string; actorName: string | null; createdAt: string }[];
  invoices: { id: number; number: string; status: string; total: number; amountPaid: number; dueDate: string; periodStart: string }[];
  nextBill: Priced | null;
  suspendedAt: string | null;
  pendingPlan: { id: number; name: string } | null;
  renewal: { id: number; number: string; status: string } | null;
  renewalOf: { id: number; number: string } | null;
  creditNotes: { id: number; number: string; reason: string; total: number; remaining: number; status: string; createdAt: string }[];
}

const ACTIONS: Record<string, { to: string; label: string; variant?: 'primary' | 'secondary' | 'danger' }[]> = {
  DRAFT: [{ to: 'QUOTATION', label: 'Send quotation' }],
  QUOTATION: [{ to: 'CONFIRMED', label: 'Mark confirmed' }],
  CONFIRMED: [{ to: 'ACTIVE', label: 'Activate' }],
  ACTIVE: [
    { to: 'PAUSED', label: 'Pause', variant: 'secondary' },
    { to: 'CLOSED', label: 'Close', variant: 'danger' },
  ],
  PAUSED: [
    { to: 'ACTIVE', label: 'Resume' },
    { to: 'CLOSED', label: 'Close', variant: 'danger' },
  ],
};

export function SubscriptionDetail({ portal }: { portal?: boolean }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApi<SubDetail>(`/subscriptions/${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [changing, setChanging] = useState(false);
  const [planChange, setPlanChange] = useState<'any' | 'down' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const base = portal ? '/portal' : '/app';

  const transition = async (to: string, why?: string) => {
    setBusy(to);
    setActionError(null);
    try {
      await api.post(`/subscriptions/${id}/transition`, { to, reason: why || undefined });
      setClosing(null);
      setReason('');
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <Spinner />;
  if (error) return <Alert>{error}</Alert>;
  if (!data) return null;

  const actions = (portal ? portalActions(data) : ACTIONS[data.status] ?? []).filter(
    (a) => a.to !== 'PAUSED' || data.plan.pausable,
  );
  const canRenew = !portal && !data.renewal && data.plan.renewable && !!data.expiryDate && (data.status === 'ACTIVE' || data.status === 'PAUSED');

  const renew = async () => {
    setBusy('renew');
    setActionError(null);
    try {
      const r = await api.post<{ id: number }>(`/subscriptions/${id}/renew`);
      navigate(`/app/subscriptions/${r.id}`);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title={data.number}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <Badge value={data.status} />
            <span>
              {data.customer.name} · {data.plan.name} ({period[data.plan.billingPeriod]})
            </span>
          </span>
        }
        actions={
          <>
            {!portal && data.status === 'ACTIVE' && (
              <>
                <Button variant="secondary" onClick={() => setChanging(true)}>
                  Change quantities
                </Button>
                <Button variant="secondary" onClick={() => setPlanChange('any')}>
                  Change plan
                </Button>
              </>
            )}
            {portal && data.status === 'ACTIVE' && (
              <Button variant="secondary" onClick={() => setPlanChange('down')}>
                Switch plan
              </Button>
            )}
            {canRenew && (
              <Button variant="secondary" loading={busy === 'renew'} onClick={renew}>
                Draft renewal
              </Button>
            )}
            {actions.map((a) => (
              <Button
                key={a.to}
                variant={a.variant ?? 'primary'}
                loading={busy === a.to}
                onClick={() => (a.to === 'CLOSED' || a.to === 'PAUSED' ? setClosing(a.to) : transition(a.to))}
              >
                {a.label}
              </Button>
            ))}
          </>
        }
      />
      {actionError && <div className="mb-4"><Alert>{actionError}</Alert></div>}
      {notice && <div className="mb-4"><Alert kind="success">{notice}</Alert></div>}
      {data.suspendedAt && (
        <div className="mb-4">
          <Alert kind="warning">
            Suspended on {date(data.suspendedAt)} because an invoice is long overdue. It resumes automatically, with the same pricing, as soon as the overdue invoice is paid.
          </Alert>
        </div>
      )}
      {data.pendingPlan && (
        <div className="mb-4">
          <Alert kind="info">
            Switching to {data.pendingPlan.name} on {date(data.nextBillingDate)}. The current plan stays until then.
          </Alert>
        </div>
      )}
      {(data.renewal || data.renewalOf) && (
        <div className="mb-4">
          <Alert kind="info">
            {data.renewal && (
              <>
                Renewal drafted as{' '}
                <Link className="font-medium underline" to={`${base}/subscriptions/${data.renewal.id}`}>
                  {data.renewal.number}
                </Link>{' '}
                ({data.renewal.status.toLowerCase()}).
              </>
            )}
            {data.renewalOf && (
              <>
                Renewal of{' '}
                <Link className="font-medium underline" to={`${base}/subscriptions/${data.renewalOf.id}`}>
                  {data.renewalOf.number}
                </Link>
                .
              </>
            )}
          </Alert>
        </div>
      )}
      {data.status === 'QUOTATION' && (
        <div className="mb-4">
          <Alert kind="info">
            Quotation sent to {data.customer.email}. The customer can accept it from the link in their email
            {data.quoteExpiresAt && <> until {date(data.quoteExpiresAt)}</>}.
          </Alert>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="Lines" padded={false}>
            <Table head={['Product', 'Qty', 'Unit price', 'Subtotal']}>
              {data.lines.map((l) => (
                <tr key={l.id}>
                  <Td>
                    {l.description}
                    {l.variant && <span className="text-xs text-slate-500"> · {l.variant.name}</span>}
                  </Td>
                  <Td className="tabular">{l.quantity}</Td>
                  <Td className="tabular">{inr(l.unitPrice)}</Td>
                  <Td className="tabular">{inr(l.unitPrice * l.quantity)}</Td>
                </tr>
              ))}
            </Table>
          </Card>

          {data.nextBill && (
            <Card title={data.status === 'ACTIVE' ? `Next bill · ${date(data.nextBillingDate)}` : 'Amount per billing period'}>
              <BillBreakdown priced={data.nextBill} />
            </Card>
          )}

          <Card title="Invoices" padded={false}>
            <Table head={['Number', 'Period', 'Total', 'Paid', 'Status']} empty={data.invoices.length === 0}>
              {data.invoices.map((i) => (
                <tr key={i.id} className="hover:bg-slate-50">
                  <Td>
                    <Link to={`${base}/invoices/${i.id}`} className="font-medium text-brand-700 hover:underline">
                      {i.number}
                    </Link>
                  </Td>
                  <Td className="tabular">{date(i.periodStart)}</Td>
                  <Td className="tabular">{inr(i.total)}</Td>
                  <Td className="tabular">{inr(i.amountPaid)}</Td>
                  <Td>
                    <Badge value={i.status} />
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Details">
            <dl className="space-y-2.5 text-sm">
              <Row k="Customer" v={portal ? data.customer.name : <Link className="text-brand-700 hover:underline" to={`/app/customers/${data.customer.id}`}>{data.customer.name}</Link>} />
              <Row k="Start date" v={date(data.startDate)} />
              <Row k="Expiry date" v={date(data.expiryDate)} />
              <Row k="Next billing" v={date(data.nextBillingDate)} />
              <Row k="Payment terms" v={`${data.paymentTermDays} days`} />
              {data.acceptedAt && <Row k="Accepted" v={dateTime(data.acceptedAt)} />}
              {data.closeReason && <Row k="Close reason" v={data.closeReason} />}
              <Row
                k="Plan rules"
                v={[data.plan.pausable && 'Pausable', data.plan.closable && 'Closable', data.plan.renewable && 'Renewable', data.plan.autoClose && 'Auto-close'].filter(Boolean).join(', ') || '—'}
              />
            </dl>
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
                      {c.reason} · {c.status === 'APPLIED' ? 'used on a later invoice' : `${inr(c.remaining)} left to apply`}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {!portal || data.events.length ? (
            <Card title="Timeline">
              <ol className="relative space-y-4 border-l border-slate-200 pl-4">
                {data.events.map((e) => (
                  <li key={e.id} className="text-sm">
                    <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-brand-500" />
                    <p className="text-slate-800">{e.message}</p>
                    <p className="text-xs text-slate-500">
                      {dateTime(e.createdAt)} · {e.actorName ?? 'System'}
                    </p>
                  </li>
                ))}
              </ol>
            </Card>
          ) : null}
        </div>
      </div>

      {changing && <ChangeModal sub={data} onClose={() => setChanging(false)} onDone={() => { setChanging(false); reload(); }} />}
      {planChange && (
        <PlanChangeModal
          subscriptionId={data.id}
          currentPlanId={data.plan.id}
          downgradeOnly={portal}
          onClose={() => setPlanChange(null)}
          onDone={(msg) => {
            setPlanChange(null);
            setNotice(msg);
            reload();
          }}
        />
      )}
      <Modal
        open={!!closing}
        onClose={() => setClosing(null)}
        title={closing === 'PAUSED' ? 'Pause subscription' : portal ? 'Cancel subscription' : 'Close subscription'}
      >
        {portal && closing === 'CLOSED' && data.status === 'ACTIVE' ? (
          <div className="mb-4 space-y-3 rounded-lg border border-brand-100 bg-brand-50 p-3 text-sm text-brand-700">
            {data.plan.pausable && (
              <div>
                <p className="font-medium">Need a break instead?</p>
                <p className="mt-0.5">Pause and keep your current pricing and discounts. Resume any time.</p>
                <Button size="sm" className="mt-2" onClick={() => setClosing('PAUSED')}>
                  Pause instead
                </Button>
              </div>
            )}
            <div>
              <p className="font-medium">Paying for more than you use?</p>
              <p className="mt-0.5">Switch to a smaller plan from your next billing date instead of cancelling.</p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                onClick={() => {
                  setClosing(null);
                  setPlanChange('down');
                }}
              >
                See smaller plans
              </Button>
            </div>
          </div>
        ) : null}
        <Field label={closing === 'PAUSED' ? 'Reason (optional)' : 'Why are you leaving? (optional)'}>
          <Select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Choose a reason</option>
            <option>Too expensive</option>
            <option>Not using it enough</option>
            <option>Switching to another provider</option>
            <option>Temporary break</option>
            <option>Missing features</option>
            <option>Other</option>
          </Select>
        </Field>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setClosing(null)}>
            Keep subscription
          </Button>
          <Button variant={closing === 'CLOSED' ? 'danger' : 'primary'} loading={!!busy} onClick={() => transition(closing!, reason)}>
            {closing === 'PAUSED' ? 'Pause' : portal ? 'Cancel subscription' : 'Close'}
          </Button>
        </div>
      </Modal>
    </>
  );
}

interface ChangePreview extends Priced {
  periodDays: number;
  remainingDays: number;
  periodEnd: string;
  charges: Priced['lines'];
  decreases: { lineId: number; description: string; from: number; to: number; effective: string }[];
}

// Mid-cycle quantity change with the proration shown before anything is saved.
function ChangeModal({ sub, onClose, onDone }: { sub: SubDetail; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState<Record<number, string>>(Object.fromEntries(sub.lines.map((l) => [l.id, String(l.quantity)])));
  const [preview, setPreview] = useState<ChangePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const body = () => ({ lines: sub.lines.map((l) => ({ lineId: l.id, quantity: Number(qty[l.id]) })) });

  const run = async (apply: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (apply) {
        await api.post(`/changes/${sub.id}/apply`, body());
        onDone();
      } else {
        setPreview(await api.post<ChangePreview>(`/changes/${sub.id}/preview`, body()));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Change quantities" wide>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <p className="text-sm text-slate-600">Increases are charged now for the days left in this period. Decreases apply from the next billing date.</p>
        {sub.lines.map((l) => (
          <div key={l.id} className="flex items-center justify-between gap-3">
            <span className="text-sm">
              {l.description}
              {l.variant && <span className="text-xs text-slate-500"> · {l.variant.name}</span>}
            </span>
            <Input
              type="number"
              min={1}
              className="w-24"
              value={qty[l.id]}
              onChange={(e) => {
                setQty({ ...qty, [l.id]: e.target.value });
                setPreview(null);
              }}
            />
          </div>
        ))}
        {preview && (
          <div className="rounded-lg border border-slate-200 p-4">
            <p className="mb-3 text-sm font-medium">
              {preview.remainingDays} of {preview.periodDays} days left in this period
            </p>
            {preview.charges.length ? (
              <BillBreakdown priced={{ ...preview, lines: preview.charges, discountTotal: 0 }} defaultOpen />
            ) : (
              <p className="text-sm text-slate-500">No charge now.</p>
            )}
            {preview.decreases.map((d) => (
              <p key={d.lineId} className="mt-2 text-sm text-slate-600">
                {d.description}: {d.from} → {d.to} from {date(d.effective)}
              </p>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => run(false)} loading={busy && !preview}>
            Preview
          </Button>
          <Button onClick={() => run(true)} loading={busy && !!preview} disabled={!preview}>
            {preview && preview.total > 0 ? `Apply and invoice ${inr(preview.total)}` : 'Apply'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function portalActions(s: SubDetail) {
  const a: { to: string; label: string; variant?: 'primary' | 'secondary' | 'danger' }[] = [];
  if (s.status === 'QUOTATION') a.push({ to: 'CONFIRMED', label: 'Accept quotation' });
  if (s.status === 'ACTIVE' && s.plan.pausable) a.push({ to: 'PAUSED', label: 'Pause', variant: 'secondary' });
  if (s.status === 'PAUSED') a.push({ to: 'ACTIVE', label: 'Resume' });
  if ((s.status === 'ACTIVE' || s.status === 'PAUSED') && s.plan.closable) a.push({ to: 'CLOSED', label: 'Cancel', variant: 'danger' });
  return a;
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex justify-between gap-3">
    <dt className="text-slate-500">{k}</dt>
    <dd className="text-right font-medium">{v}</dd>
  </div>
);

interface Option {
  id: number;
  name: string;
}
interface ProductOpt extends Option {
  salesPrice: number;
  variants: { id: number; name: string; active: boolean }[];
}

export function SubscriptionNew() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [params] = useSearchParams();
  const [customerQ, setCustomerQ] = useState('');
  const customerTerm = useDebounced(customerQ);
  const customers = useApi<Page<Option & { email: string }>>(`/customers${qs({ q: customerTerm, pageSize: 50 })}`);
  const preset = useApi<Option & { email: string }>(params.get('customerId') ? `/customers/${params.get('customerId')}` : null);
  const plans = useApi<{ data: (Option & { billingPeriod: string; minQuantity: number; active: boolean })[] }>('/catalog/plans');
  const products = useApi<Page<ProductOpt>>('/catalog/products?pageSize=100');
  const templates = useApi<{ data: (Option & { planId: number })[] }>('/templates');

  const [form, setForm] = useState({
    customerId: params.get('customerId') ?? '',
    planId: '',
    templateId: '',
    startDate: toInputDate(new Date()),
    expiryDate: '',
    paymentTermDays: '15',
    notes: '',
  });
  const [lines, setLines] = useState<{ productId: string; variantId: string; quantity: string }[]>([{ productId: '', variantId: '', quantity: '1' }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!form.templateId) return;
    const tpl = templates.data?.data.find((t) => String(t.id) === form.templateId);
    if (tpl) setForm((f) => ({ ...f, planId: String(tpl.planId) }));
  }, [form.templateId, templates.data]);

  const productMap = useMemo(() => new Map(products.data?.data.map((p) => [String(p.id), p]) ?? []), [products.data]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        customerId: Number(form.customerId),
        planId: form.planId ? Number(form.planId) : undefined,
        templateId: form.templateId ? Number(form.templateId) : undefined,
        startDate: form.startDate || null,
        expiryDate: form.expiryDate || null,
        paymentTermDays: Number(form.paymentTermDays),
        notes: form.notes || null,
        lines: lines
          .filter((l) => l.productId)
          .map((l) => ({ productId: Number(l.productId), variantId: l.variantId ? Number(l.variantId) : null, quantity: Number(l.quantity) })),
      };
      const sub = await api.post<{ id: number }>('/subscriptions', body);
      navigate(`/app/subscriptions/${sub.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!user) return null;
  return (
    <>
      <PageHeader title="New subscription" sub="Starts as a draft. Send it as a quotation when it's ready." />
      <form onSubmit={submit} className="space-y-5">
        {error && <Alert>{error}</Alert>}
        <Card title="Customer and plan">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Customer">
              <Input placeholder="Search customers…" value={customerQ} onChange={(e) => setCustomerQ(e.target.value)} className="mb-2" />
              <Select required value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
                <option value="">Select customer</option>
                {preset.data && !customers.data?.data.some((c) => c.id === preset.data!.id) && (
                  <option value={preset.data.id}>
                    {preset.data.name} ({preset.data.email})
                  </option>
                )}
                {customers.data?.data.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.email})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Quotation template" hint="Fills plan and lines from a template">
              <Select value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })}>
                <option value="">No template</option>
                {templates.data?.data.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Plan">
              <Select required={!form.templateId} value={form.planId} onChange={(e) => setForm({ ...form, planId: e.target.value })}>
                <option value="">Select plan</option>
                {plans.data?.data
                  .filter((p) => p.active)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {period[p.billingPeriod]}
                      {p.minQuantity > 1 ? ` · min qty ${p.minQuantity}` : ''}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Payment terms (days)">
              <Input type="number" min={0} max={365} value={form.paymentTermDays} onChange={(e) => setForm({ ...form, paymentTermDays: e.target.value })} />
            </Field>
            <Field label="Start date">
              <Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            </Field>
            <Field label="Expiry date" hint="Leave empty for no end date">
              <Input type="date" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} />
            </Field>
          </div>
        </Card>
        <Card title="Products" actions={<Button type="button" size="sm" variant="secondary" onClick={() => setLines([...lines, { productId: '', variantId: '', quantity: '1' }])}>Add line</Button>}>
          {form.templateId && <p className="mb-3 text-xs text-slate-500">Leave lines empty to use the template's products.</p>}
          <div className="space-y-3">
            {lines.map((l, i) => {
              const p = productMap.get(l.productId);
              return (
                <div key={i} className="grid grid-cols-12 gap-2">
                  <Select className="col-span-12 sm:col-span-5" value={l.productId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, productId: e.target.value, variantId: '' } : x)))}>
                    <option value="">Select product</option>
                    {products.data?.data.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {inr(p.salesPrice)}
                      </option>
                    ))}
                  </Select>
                  <Select className="col-span-6 sm:col-span-4" value={l.variantId} disabled={!p?.variants.length} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, variantId: e.target.value } : x)))}>
                    <option value="">{p?.variants.length ? 'No variant' : '—'}</option>
                    {p?.variants
                      .filter((v) => v.active)
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                  </Select>
                  <Input className="col-span-4 sm:col-span-2" type="number" min={1} value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
                  <Button type="button" variant="ghost" className="col-span-2 sm:col-span-1" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove line">
                    ✕
                  </Button>
                </div>
              );
            })}
          </div>
        </Card>
        <Card title="Notes">
          <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Card>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => navigate(-1)}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Create draft
          </Button>
        </div>
      </form>
    </>
  );
}
