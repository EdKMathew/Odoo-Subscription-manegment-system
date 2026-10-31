import { useState } from 'react';
import { inr } from '../lib/format';

export interface PricedLine {
  description: string;
  explanation: string;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  taxRateBp: number;
  taxAmount: number;
  amount: number;
}

export interface Priced {
  lines: PricedLine[];
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  taxSplit: 'INTRA' | 'INTER';
}

// Shows each line in plain English with a "Why this amount?" toggle.
export function BillBreakdown({ priced, defaultOpen }: { priced: Priced; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const half = Math.round(priced.taxTotal / 2);
  return (
    <div>
      <div className="space-y-3">
        {priced.lines.map((l, i) => (
          <div key={i} className="flex justify-between gap-4 text-sm">
            <div className="min-w-0">
              <p className="font-medium text-slate-800">{l.description}</p>
              {open && <p className="mt-0.5 text-xs text-slate-500">{l.explanation}</p>}
            </div>
            <span className="shrink-0 tabular">{inr(l.amount)}</span>
          </div>
        ))}
      </div>
      <dl className="mt-4 space-y-1 border-t border-slate-100 pt-3 text-sm">
        <Line k="Subtotal" v={inr(priced.subtotal)} />
        {priced.discountTotal > 0 && <Line k="Discounts" v={`− ${inr(priced.discountTotal)}`} className="text-emerald-600" />}
        {priced.taxSplit === 'INTER' ? (
          <Line k="IGST" v={inr(priced.taxTotal)} />
        ) : (
          <>
            <Line k="CGST" v={inr(half)} />
            <Line k="SGST" v={inr(priced.taxTotal - half)} />
          </>
        )}
        <Line k="Total" v={inr(priced.total)} className="pt-1 text-base font-semibold" />
      </dl>
      <button onClick={() => setOpen(!open)} className="mt-3 text-xs font-medium text-brand-600 hover:text-brand-700">
        {open ? 'Hide breakdown' : 'Why this amount?'}
      </button>
    </div>
  );
}

const Line = ({ k, v, className }: { k: string; v: string; className?: string }) => (
  <div className={`flex justify-between ${className ?? ''}`}>
    <dt className="text-slate-500">{k}</dt>
    <dd className="tabular">{v}</dd>
  </div>
);
