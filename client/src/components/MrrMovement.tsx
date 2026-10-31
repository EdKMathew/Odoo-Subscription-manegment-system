import { qs } from '../lib/api';
import { useApi } from '../lib/hooks';
import { inr, inrShort } from '../lib/format';
import { Card } from './ui';

type Kind = 'NEW' | 'EXPANSION' | 'CONTRACTION' | 'CHURN' | 'CHURN_INVOLUNTARY' | 'PAUSE' | 'REACTIVATION';

const ROWS: { kind: Kind; label: string; hint: string }[] = [
  { kind: 'NEW', label: 'New', hint: 'Subscriptions activated' },
  { kind: 'EXPANSION', label: 'Expansion', hint: 'Upgrades and added seats' },
  { kind: 'REACTIVATION', label: 'Reactivation', hint: 'Resumed or recovered after payment' },
  { kind: 'CONTRACTION', label: 'Contraction', hint: 'Downgrades and removed seats' },
  { kind: 'PAUSE', label: 'Paused', hint: 'Paused by the customer' },
  { kind: 'CHURN', label: 'Voluntary churn', hint: 'Cancelled by choice' },
  { kind: 'CHURN_INVOLUNTARY', label: 'Involuntary churn', hint: 'Suspended for non-payment' },
];

// Where monthly recurring revenue came from and where it went in the selected range.
export function MrrMovement({ from, to }: { from: string; to: string }) {
  const { data } = useApi<{ movement: Record<Kind, { mrr: number; count: number }>; net: number }>(`/reports/mrr-movement${qs({ from, to })}`);
  if (!data) return null;
  const max = Math.max(1, ...ROWS.map((r) => Math.abs(data.movement[r.kind].mrr)));

  return (
    <Card
      title="MRR movement"
      actions={
        <span className={`text-sm font-semibold tabular ${data.net >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
          Net {data.net >= 0 ? '+' : '−'}
          {inrShort(Math.abs(data.net))}
        </span>
      }
    >
      <div className="space-y-2.5">
        {ROWS.map((r) => {
          const v = data.movement[r.kind];
          const positive = v.mrr >= 0;
          const width = `${Math.max(v.mrr ? 2 : 0, (Math.abs(v.mrr) / max) * 100)}%`;
          return (
            <div key={r.kind} className="grid grid-cols-[9rem_1fr_6.5rem] items-center gap-3 text-sm" title={`${r.hint}: ${v.count} subscriptions, ${inr(v.mrr)}`}>
              <div>
                <p className="font-medium text-slate-700">{r.label}</p>
                <p className="text-[11px] text-slate-400">{v.count} subs</p>
              </div>
              <div className="h-2.5 rounded-full bg-slate-100">
                <div className={`h-2.5 rounded-full ${positive ? 'bg-emerald-500' : 'bg-red-400'}`} style={{ width }} />
              </div>
              <span className={`text-right tabular ${positive ? 'text-emerald-700' : 'text-red-600'}`}>
                {v.mrr > 0 ? '+' : v.mrr < 0 ? '−' : ''}
                {inrShort(Math.abs(v.mrr))}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

interface Collections {
  revenueAtRisk: { mrr: number; subscriptions: number };
  recovery: { rate: number | null; recoveredCount: number; recoveredAmount: number; stillOpenCount: number; stillOpenAmount: number };
  suspended: number;
}

// Dunning results: revenue at risk from unpaid invoices and how much was recovered.
export function CollectionsCard() {
  const { data } = useApi<Collections>('/reports/collections');
  if (!data) return null;
  return (
    <Card title="Collections">
      <div className="grid grid-cols-3 gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Revenue at risk</p>
          <p className="mt-1 text-xl font-semibold text-amber-600 tabular">{inrShort(data.revenueAtRisk.mrr)}</p>
          <p className="text-xs text-slate-500">MRR of {data.revenueAtRisk.subscriptions} active subs with overdue invoices</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Recovery rate</p>
          <p className="mt-1 text-xl font-semibold text-emerald-600 tabular">{data.recovery.rate == null ? '—' : `${Math.round(data.recovery.rate * 100)}%`}</p>
          <p className="text-xs text-slate-500">
            {data.recovery.recoveredCount} overdue invoices paid after reminders ({inrShort(data.recovery.recoveredAmount)})
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Suspended</p>
          <p className="mt-1 text-xl font-semibold tabular">{data.suspended}</p>
          <p className="text-xs text-slate-500">Resume automatically when paid</p>
        </div>
      </div>
    </Card>
  );
}
