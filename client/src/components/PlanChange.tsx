import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/hooks';
import { date, inr, period } from '../lib/format';
import { Alert, Button, Field, Input, Modal, Select } from './ui';
import { BillBreakdown, type Priced } from './BillBreakdown';

interface PlanOption {
  id: number;
  name: string;
  price: number;
  billingPeriod: string;
  active: boolean;
}

export interface PlanChangePreview {
  kind: 'UPGRADE' | 'DOWNGRADE';
  fromPlan: string;
  toPlan: string;
  effectiveDate: string;
  monthlyBefore: number;
  monthlyAfter: number;
  credit: { amount: number; explanation: string } | null;
  invoice: Priced | null;
}

// Switch plan with the money shown first: upgrades start now with credit for the
// unused part of the current period; downgrades start on the next billing date.
export function PlanChangeModal({
  subscriptionId,
  currentPlanId,
  downgradeOnly,
  onClose,
  onDone,
}: {
  subscriptionId: number;
  currentPlanId: number;
  downgradeOnly?: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const plans = useApi<{ data: PlanOption[] }>('/catalog/plans');
  const [planId, setPlanId] = useState('');
  const [preview, setPreview] = useState<PlanChangePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (apply: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (apply) {
        const r = await api.post<{ message: string }>(`/changes/${subscriptionId}/plan-apply`, { planId: Number(planId) });
        onDone(r.message);
      } else {
        setPreview(await api.post<PlanChangePreview>(`/changes/${subscriptionId}/plan-preview`, { planId: Number(planId) }));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const options = plans.data?.data.filter((p) => p.active && p.id !== currentPlanId) ?? [];
  const blocked = downgradeOnly && preview?.kind === 'UPGRADE';

  return (
    <Modal open onClose={onClose} title={downgradeOnly ? 'Switch to a smaller plan' : 'Change plan'} wide>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="New plan">
          <Select
            value={planId}
            onChange={(e) => {
              setPlanId(e.target.value);
              setPreview(null);
            }}
          >
            <option value="">Choose a plan</option>
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {inr(p.price)} {period[p.billingPeriod].toLowerCase()}
              </option>
            ))}
          </Select>
        </Field>
        {preview && (
          <div className="space-y-3 rounded-lg border border-slate-200 p-4 text-sm">
            <p>
              <span className="font-medium">{preview.kind === 'UPGRADE' ? 'Upgrade' : 'Downgrade'}</span> from {preview.fromPlan} to {preview.toPlan}, effective{' '}
              <span className="font-medium">{date(preview.effectiveDate)}</span>.
            </p>
            <p className="text-slate-600">
              Monthly value {inr(preview.monthlyBefore)} → {inr(preview.monthlyAfter)}
            </p>
            {preview.credit && (
              <p className="text-emerald-700">
                Credit for unused time: {inr(preview.credit.amount)} <span className="text-xs text-slate-500">({preview.credit.explanation})</span>
              </p>
            )}
            {preview.invoice && (
              <div>
                <p className="mb-2 font-medium">Charged today</p>
                <BillBreakdown priced={preview.invoice} defaultOpen />
              </div>
            )}
            {preview.kind === 'DOWNGRADE' && <p className="text-slate-600">No charge now. Your current plan stays until then.</p>}
            {blocked && <Alert kind="info">Upgrades are handled by our team. Please contact us.</Alert>}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={!planId} loading={busy && !preview} onClick={() => run(false)}>
            Preview
          </Button>
          <Button disabled={!preview || blocked} loading={busy && !!preview} onClick={() => run(true)}>
            Confirm change
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// Staff: issue a credit note against a confirmed or paid invoice.
export function CreditNoteModal({ invoiceId, max, onClose, onDone }: { invoiceId: number; max: number; onClose: () => void; onDone: (msg: string) => void }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ number: string }>(`/invoices/${invoiceId}/credit-note`, { amount: Number(amount), reason });
      onDone(`Credit note ${r.number} issued. It will be deducted from the customer's next invoice.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Issue credit note">
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <p className="text-sm text-slate-600">Confirmed invoices are never edited. A credit note records the correction and is taken off the next invoice automatically.</p>
        <Field label="Amount (₹, including tax)" hint={`Up to ${inr(max)}`}>
          <Input type="number" step="0.01" min="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Reason">
          <Input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Service outage on 12 Oct" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Issue credit note
          </Button>
        </div>
      </form>
    </Modal>
  );
}
