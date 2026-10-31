import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { date, dateTime, inr, period, titleCase } from '../../lib/format';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Spinner, Stat } from '../../components/ui';
import { BillBreakdown, type Priced } from '../../components/BillBreakdown';

interface Profile {
  name: string;
  email: string;
  phone: string | null;
  gstin: string | null;
  state: string | null;
  address: string | null;
}

interface Overview {
  customer: Profile;
  subscriptions: {
    id: number;
    number: string;
    status: string;
    plan: { name: string; billingPeriod: string };
    nextBillingDate: string | null;
    expiryDate: string | null;
    pendingPlan: { name: string } | null;
    suspended: boolean;
  }[];
  creditBalance: number;
  credits: { id: number; number: string; reason: string; total: number; remaining: number }[];
  balanceDue: number;
  overdue: number;
  openInvoices: number;
  recentPayments: { id: number; amount: number; method: string; paidAt: string; invoice: { id: number; number: string } }[];
  nextBills: (Priced & { subscriptionId: number; number: string; plan: string; date: string })[];
}

export function PortalHome() {
  const { data, loading, error } = useApi<Overview>('/portal/overview');
  if (loading && !data) return <Spinner />;
  if (error) return <Alert>{error}</Alert>;
  if (!data) return null;

  return (
    <>
      <PageHeader title={`Hello, ${data.customer.name}`} sub="Your subscriptions, upcoming charges and payments" />
      {data.subscriptions.some((s) => s.suspended) && (
        <div className="mb-4">
          <Alert kind="warning">
            A subscription is suspended because an invoice is long overdue. Pay the overdue invoice and it resumes automatically with your current pricing.
          </Alert>
        </div>
      )}
      {data.overdue > 0 && (
        <div className="mb-4">
          <Alert>
            You have {inr(data.overdue)} overdue.{' '}
            <Link to="/portal/invoices?status=OVERDUE" className="font-medium underline">
              View invoices
            </Link>
          </Alert>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Balance due" value={inr(data.balanceDue)} sub={`${data.openInvoices} open invoices`} tone={data.overdue > 0 ? 'red' : undefined} />
        <Stat label="Active subscriptions" value={data.subscriptions.filter((s) => s.status === 'ACTIVE').length} />
        {data.creditBalance > 0 && <Stat label="Credit balance" value={inr(data.creditBalance)} sub="Taken off your next invoice" tone="green" />}
        <Stat label="Last payment" value={data.recentPayments[0] ? inr(data.recentPayments[0].amount) : '—'} sub={data.recentPayments[0] ? date(data.recentPayments[0].paidAt) : undefined} />
      </div>

      {data.nextBills.length > 0 && (
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          {data.nextBills.map((b) => (
            <Card key={b.subscriptionId} title={<span>Next bill · {b.plan}</span>}>
              <div className="mb-4 flex items-end justify-between">
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Estimated amount</p>
                  <p className="text-2xl font-semibold tabular">{inr(b.total)}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Billing date</p>
                  <p className="font-medium">{date(b.date)}</p>
                </div>
              </div>
              <BillBreakdown priced={b} />
              <p className="mt-3 text-xs text-slate-500">You'll get a pre-debit notice with the exact amount before you're charged.</p>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card title="Subscriptions" actions={<Link to="/portal/subscriptions" className="text-xs font-medium text-brand-600">View all</Link>}>
          {data.subscriptions.length === 0 ? (
            <p className="text-sm text-slate-500">No subscriptions yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.subscriptions.map((s) => (
                <li key={s.id}>
                  <Link to={`/portal/subscriptions/${s.id}`} className="flex items-center justify-between gap-3 py-2.5 hover:bg-slate-50">
                    <div>
                      <p className="text-sm font-medium">{s.plan.name}</p>
                      <p className="text-xs text-slate-500">
                        {s.number} · {period[s.plan.billingPeriod]}
                        {s.pendingPlan && <> · switching to {s.pendingPlan.name} on {date(s.nextBillingDate)}</>}
                      </p>
                    </div>
                    {s.suspended ? <Badge value="OVERDUE" label="Suspended" /> : <Badge value={s.status} />}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <ProfileCard profile={data.customer} />
        <Card title="Recent payments">
          {data.recentPayments.length === 0 ? (
            <p className="text-sm text-slate-500">No payments yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.recentPayments.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div>
                    <Link to={`/portal/invoices/${p.invoice.id}`} className="font-medium text-brand-700 hover:underline">
                      {p.invoice.number}
                    </Link>
                    <p className="text-xs text-slate-500">
                      {date(p.paidAt)} · {titleCase(p.method)}
                    </p>
                  </div>
                  <span className="tabular">{inr(p.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

// Billing details the customer can keep up to date; the state decides CGST+SGST or IGST.
function ProfileCard({ profile }: { profile: Profile }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ phone: profile.phone ?? '', gstin: profile.gstin ?? '', state: profile.state ?? '', address: profile.address ?? '' });
  const [saved, setSaved] = useState(profile);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSaved(await api.put<Profile>('/portal/profile', form));
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Billing details" actions={!editing && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>}>
      {editing ? (
        <form onSubmit={save} className="space-y-3">
          {error && <Alert>{error}</Alert>}
          <div className="grid grid-cols-2 gap-3">
            <Field label="State">
              <Input value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} />
            </Field>
            <Field label="Phone">
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </Field>
          </div>
          <Field label="GSTIN">
            <Input value={form.gstin} maxLength={15} onChange={(e) => setForm({ ...form, gstin: e.target.value })} />
          </Field>
          <Field label="Address">
            <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={busy}>
              Save
            </Button>
          </div>
        </form>
      ) : (
        <dl className="space-y-2 text-sm">
          {[
            ['Email', saved.email],
            ['Phone', saved.phone],
            ['State', saved.state],
            ['GSTIN', saved.gstin],
            ['Address', saved.address],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-slate-500">{k}</dt>
              <dd className="text-right font-medium">{v || '—'}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

interface Quote extends Priced {
  number: string;
  status: string;
  customerName: string;
  plan: { name: string; billingPeriod: string };
  startDate: string | null;
  expiryDate: string | null;
  quoteExpiresAt: string | null;
  acceptedAt: string | null;
  company: string;
}

// Public page opened from the quotation email. The token in the URL is the only credential.
export function QuoteAccept() {
  const { token } = useParams();
  const { data, error, loading, reload } = useApi<Quote>(`/subscriptions/quote/${token}`);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);

  const accept = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`/subscriptions/quote/${token}/accept`);
      setAccepted(true);
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const expired = data?.quoteExpiresAt && new Date(data.quoteExpiresAt) < new Date();

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <div className="mb-6 flex items-center gap-2">
        <img src="/favicon.svg" alt="" className="h-7 w-7" />
        <span className="text-lg font-semibold">{data?.company ?? 'SubFlow'}</span>
      </div>
      {loading && !data && <Spinner />}
      {error && <Alert>{error}</Alert>}
      {data && (
        <Card>
          <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Quotation</p>
              <h1 className="text-xl font-semibold">{data.number}</h1>
              <p className="text-sm text-slate-500">For {data.customerName}</p>
            </div>
            <Badge value={data.status} />
          </div>
          <div className="mb-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <Info k="Plan" v={`${data.plan.name} (${period[data.plan.billingPeriod]})`} />
            <Info k="Starts" v={date(data.startDate)} />
            <Info k="Valid until" v={date(data.quoteExpiresAt)} />
          </div>
          <BillBreakdown priced={data} defaultOpen />
          <p className="mt-2 text-xs text-slate-500">Amount per billing period ({period[data.plan.billingPeriod].toLowerCase()}).</p>
          <div className="mt-6 border-t border-slate-100 pt-5">
            {actionError && <div className="mb-3"><Alert>{actionError}</Alert></div>}
            {accepted || data.status !== 'QUOTATION' ? (
              <Alert kind="success">
                {data.acceptedAt ? `Accepted on ${dateTime(data.acceptedAt)}.` : 'This quotation has been handled.'} Thank you!
              </Alert>
            ) : expired ? (
              <Alert kind="warning">This quotation has expired. Please contact us for a new one.</Alert>
            ) : (
              <Button onClick={accept} loading={busy} className="w-full sm:w-auto">
                Accept quotation
              </Button>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

const Info = ({ k, v }: { k: string; v: string }) => (
  <div>
    <p className="text-xs text-slate-500">{k}</p>
    <p className="font-medium">{v}</p>
  </div>
);
