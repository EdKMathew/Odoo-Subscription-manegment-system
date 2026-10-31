import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useDebounced } from '../lib/hooks';
import { inr } from '../lib/format';
import { Badge } from './ui';

interface Results {
  subscriptions: { id: number; number: string; status: string; customer: { name: string } }[];
  invoices: { id: number; number: string; status: string; total: number; customer: { name: string } }[];
  customers: { id: number; name: string; email: string }[];
}

// Ctrl+K quick search for subscriptions, invoices and customers.
export function CommandPalette({ open, onClose, portal }: { open: boolean; onClose: () => void; portal?: boolean }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Results | null>(null);
  const term = useDebounced(q, 200);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) {
      setQ('');
      setResults(null);
    }
  }, [open]);

  useEffect(() => {
    if (!term.trim()) return setResults(null);
    let live = true;
    api.get<Results>(`/search?q=${encodeURIComponent(term)}`).then((r) => live && setResults(r)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [term]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const base = portal ? '/portal' : '/app';
  const go = (path: string) => {
    onClose();
    navigate(path);
  };
  const empty = results && !results.subscriptions.length && !results.invoices.length && !results.customers.length;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 pt-[12vh]" onMouseDown={onClose}>
      <div className="w-full max-w-xl overflow-hidden rounded-xl bg-white shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by number or name…"
          className="w-full border-b border-slate-200 px-4 py-3.5 text-base outline-none"
        />
        <div className="max-h-[50vh] overflow-y-auto p-2">
          {!results && <p className="px-3 py-6 text-center text-sm text-slate-400">Type a subscription, invoice or customer</p>}
          {empty && <p className="px-3 py-6 text-center text-sm text-slate-400">No matches</p>}
          {results?.subscriptions.length ? <Group label="Subscriptions" /> : null}
          {results?.subscriptions.map((s) => (
            <Row key={`s${s.id}`} onClick={() => go(`${base}/subscriptions/${s.id}`)}>
              <span className="font-medium">{s.number}</span>
              <span className="truncate text-slate-500">{s.customer.name}</span>
              <Badge value={s.status} />
            </Row>
          ))}
          {results?.invoices.length ? <Group label="Invoices" /> : null}
          {results?.invoices.map((i) => (
            <Row key={`i${i.id}`} onClick={() => go(`${base}/invoices/${i.id}`)}>
              <span className="font-medium">{i.number}</span>
              <span className="truncate text-slate-500">
                {i.customer.name} · {inr(i.total)}
              </span>
              <Badge value={i.status} />
            </Row>
          ))}
          {results?.customers.length ? <Group label="Customers" /> : null}
          {results?.customers.map((c) => (
            <Row key={`c${c.id}`} onClick={() => go(`/app/customers/${c.id}`)}>
              <span className="font-medium">{c.name}</span>
              <span className="truncate text-slate-500">{c.email}</span>
            </Row>
          ))}
        </div>
      </div>
    </div>
  );
}

const Group = ({ label }: { label: string }) => <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>;

const Row = ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
  <button onClick={onClick} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100">
    {children}
  </button>
);
