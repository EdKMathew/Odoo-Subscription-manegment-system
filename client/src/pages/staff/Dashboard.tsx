import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../lib/hooks';
import { qs } from '../../lib/api';
import { inr, inrShort, toInputDate } from '../../lib/format';
import { Card, Field, Input, PageHeader, Spinner, Stat, Alert } from '../../components/ui';
import { CollectionsCard, MrrMovement } from '../../components/MrrMovement';

interface Summary {
  activeSubscriptions: number;
  byStatus: Record<string, number>;
  revenueCollected: number;
  paymentsCount: number;
  outstanding: number;
  openInvoices: number;
  overdueAmount: number;
  overdueInvoices: number;
  mrr: number;
  aging: { bucket: string; amount: number; count: number }[];
  monthlyCollections: { month: string; collected: number }[];
  renewalsNext30: number;
}

const monthStart = () => {
  const d = new Date();
  return toInputDate(new Date(d.getFullYear(), d.getMonth(), 1, 12));
};

export function Dashboard() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(toInputDate(new Date()));
  const { data, error, loading } = useApi<Summary>(`/reports/summary${qs({ from, to })}`);

  return (
    <>
      <PageHeader
        title="Dashboard"
        sub="Recurring revenue, collections and receivables at a glance"
        actions={
          <div className="flex items-end gap-2">
            <Field label="From">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To">
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
        }
      />
      {error && <Alert>{error}</Alert>}
      {loading && !data && <Spinner />}
      {data && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Active subscriptions" value={data.activeSubscriptions.toLocaleString('en-IN')} sub={`${data.byStatus.PAUSED ?? 0} paused`} />
            <Stat label="MRR" value={inrShort(data.mrr)} sub="All periods normalised to monthly" />
            <Stat label="Revenue collected" value={inrShort(data.revenueCollected)} sub={`${data.paymentsCount} payments in range`} tone="green" />
            <Stat label="Outstanding" value={inrShort(data.outstanding)} sub={`${data.openInvoices} open invoices`} />
          </div>
          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Collections, last 6 months" className="lg:col-span-2">
              <Bars rows={data.monthlyCollections} />
            </Card>
            <Card title="Overdue" actions={<Link to="/app/overdue" className="text-xs font-medium text-brand-600">View all</Link>}>
              <p className={`text-2xl font-semibold tabular ${data.overdueAmount > 0 ? 'text-red-600' : ''}`}>{inr(data.overdueAmount)}</p>
              <p className="text-xs text-slate-500">{data.overdueInvoices} invoices past due</p>
              <div className="mt-4 space-y-2">
                {data.aging.map((a) => (
                  <Link key={a.bucket} to={`/app/overdue?bucket=${a.bucket}`} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50">
                    <span className="text-slate-600">{a.bucket} days</span>
                    <span className="tabular">
                      {inr(a.amount)} <span className="text-xs text-slate-400">({a.count})</span>
                    </span>
                  </Link>
                ))}
              </div>
            </Card>
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <MrrMovement from={from} to={to} />
            <CollectionsCard />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Subscriptions by status">
              <div className="grid grid-cols-3 gap-3 text-center">
                {['DRAFT', 'QUOTATION', 'CONFIRMED', 'ACTIVE', 'PAUSED', 'CLOSED'].map((s) => (
                  <Link key={s} to={`/app/subscriptions?status=${s}`} className="rounded-lg border border-slate-100 py-3 hover:bg-slate-50">
                    <p className="text-lg font-semibold tabular">{(data.byStatus[s] ?? 0).toLocaleString('en-IN')}</p>
                    <p className="text-xs text-slate-500">{s.charAt(0) + s.slice(1).toLowerCase()}</p>
                  </Link>
                ))}
              </div>
            </Card>
            <Card title="Renewals" actions={<Link to="/app/renewals" className="text-xs font-medium text-brand-600">Renewal radar</Link>}>
              <p className="text-2xl font-semibold tabular">{data.renewalsNext30}</p>
              <p className="text-sm text-slate-500">active subscriptions expire in the next 30 days</p>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

function Bars({ rows }: { rows: { month: string; collected: number }[] }) {
  if (!rows.length) return <p className="py-8 text-center text-sm text-slate-400">No payments yet</p>;
  const max = Math.max(...rows.map((r) => r.collected), 1);
  return (
    <div className="flex h-48 items-end gap-3">
      {rows.map((r) => (
        <div key={r.month} className="flex flex-1 flex-col items-center gap-1.5">
          <span className="text-[11px] text-slate-500 tabular">{inrShort(r.collected)}</span>
          <div className="w-full max-w-12 rounded-t-md bg-brand-500" style={{ height: `${Math.max(4, (r.collected / max) * 140)}px` }} />
          <span className="text-[11px] text-slate-500">
            {new Date(r.month + '-01').toLocaleDateString('en-IN', { month: 'short' })}
          </span>
        </div>
      ))}
    </div>
  );
}
