import { useState, type FormEvent } from 'react';
import { api, type Page } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { date, inr, toInputDate } from '../../lib/format';
import { Alert, Badge, Button, Card, Checkbox, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td } from '../../components/ui';

interface TaxRule {
  id: number;
  name: string;
  rateBp: number;
  isDefault: boolean;
  active: boolean;
}
interface Discount {
  id: number;
  name: string;
  type: 'PERCENT' | 'FIXED';
  value: number;
  scope: 'SUBSCRIPTION' | 'PRODUCTS';
  minPurchase: number;
  minQuantity: number;
  startDate: string | null;
  endDate: string | null;
  usageLimit: number | null;
  usedCount: number;
  active: boolean;
  products: { product: { id: number; name: string } }[];
}

export function Pricing() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const taxes = useApi<{ data: TaxRule[] }>('/catalog/tax-rules');
  const discounts = useApi<{ data: Discount[] }>('/discounts');
  const [tax, setTax] = useState<Partial<TaxRule> | null>(null);
  const [discount, setDiscount] = useState<Partial<Discount> | null>(null);

  const discountState = (d: Discount) => {
    const now = new Date();
    if (!d.active) return <Badge value="CLOSED" label="Inactive" />;
    if (d.endDate && new Date(d.endDate) < now) return <Badge value="CLOSED" label="Expired" />;
    if (d.usageLimit != null && d.usedCount >= d.usageLimit) return <Badge value="CLOSED" label="Used up" />;
    if (d.startDate && new Date(d.startDate) > now) return <Badge value="QUOTATION" label="Scheduled" />;
    return <Badge value="ACTIVE" label="Live" />;
  };

  return (
    <>
      <PageHeader title="Taxes & discounts" sub={isAdmin ? 'Applied automatically to every invoice line' : 'Only admins can change these'} />
      <div className="space-y-5">
        <Card title="Tax rules" padded={false} actions={isAdmin && <Button size="sm" onClick={() => setTax({ active: true })}>New tax rule</Button>}>
          {taxes.loading && !taxes.data ? (
            <Spinner />
          ) : (
            <Table head={['Name', 'Rate', 'Default', 'Status', '']} empty={taxes.data?.data.length === 0}>
              {taxes.data?.data.map((t) => (
                <tr key={t.id}>
                  <Td className="font-medium">{t.name}</Td>
                  <Td className="tabular">{t.rateBp / 100}%</Td>
                  <Td>{t.isDefault ? <Badge value="CONFIRMED" label="Default" /> : ''}</Td>
                  <Td>{t.active ? <Badge value="ACTIVE" label="Active" /> : <Badge value="CLOSED" label="Inactive" />}</Td>
                  <Td>{isAdmin && <Button size="sm" variant="ghost" onClick={() => setTax(t)}>Edit</Button>}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Discounts" padded={false} actions={isAdmin && <Button size="sm" onClick={() => setDiscount({ type: 'PERCENT', scope: 'SUBSCRIPTION', active: true })}>New discount</Button>}>
          {discounts.loading && !discounts.data ? (
            <Spinner />
          ) : (
            <Table head={['Name', 'Value', 'Applies to', 'Conditions', 'Dates', 'Used', 'Status', '']} empty={discounts.data?.data.length === 0}>
              {discounts.data?.data.map((d) => (
                <tr key={d.id}>
                  <Td className="font-medium">{d.name}</Td>
                  <Td className="tabular">{d.type === 'PERCENT' ? `${d.value / 100}%` : inr(d.value)}</Td>
                  <Td className="whitespace-normal text-xs">{d.scope === 'SUBSCRIPTION' ? 'Whole subscription' : d.products.map((p) => p.product.name).join(', ')}</Td>
                  <Td className="text-xs">
                    {[d.minPurchase > 0 && `Min ${inr(d.minPurchase)}`, d.minQuantity > 0 && `Min qty ${d.minQuantity}`].filter(Boolean).join(' · ') || '—'}
                  </Td>
                  <Td className="text-xs">
                    {d.startDate && d.endDate
                      ? `${date(d.startDate)} – ${date(d.endDate)}`
                      : d.endDate
                        ? `Until ${date(d.endDate)}`
                        : d.startDate
                          ? `From ${date(d.startDate)}`
                          : 'No end'}
                  </Td>
                  <Td className="tabular">
                    {d.usedCount}
                    {d.usageLimit != null && ` / ${d.usageLimit}`}
                  </Td>
                  <Td>{discountState(d)}</Td>
                  <Td>{isAdmin && <Button size="sm" variant="ghost" onClick={() => setDiscount(d)}>Edit</Button>}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
      {tax && <TaxForm rule={tax} onClose={() => setTax(null)} onSaved={() => { setTax(null); taxes.reload(); }} />}
      {discount && <DiscountForm discount={discount} onClose={() => setDiscount(null)} onSaved={() => { setDiscount(null); discounts.reload(); }} />}
    </>
  );
}

function TaxForm({ rule, onClose, onSaved }: { rule: Partial<TaxRule>; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: rule.name ?? '', rate: rule.rateBp != null ? String(rule.rateBp / 100) : '', isDefault: rule.isDefault ?? false, active: rule.active ?? true });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { ...form, rate: Number(form.rate) };
      if (rule.id) await api.put(`/catalog/tax-rules/${rule.id}`, body);
      else await api.post('/catalog/tax-rules', body);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={rule.id ? 'Edit tax rule' : 'New tax rule'}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="GST 18%" />
          </Field>
          <Field label="Rate (%)">
            <Input type="number" step="0.01" min="0" max="100" required value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} />
          </Field>
        </div>
        <Checkbox label="Default" hint="Used for products without their own tax rule" checked={form.isDefault} onChange={(v) => setForm({ ...form, isDefault: v })} />
        <Checkbox label="Active" checked={form.active} onChange={(v) => setForm({ ...form, active: v })} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DiscountForm({ discount, onClose, onSaved }: { discount: Partial<Discount>; onClose: () => void; onSaved: () => void }) {
  const products = useApi<Page<{ id: number; name: string }>>('/catalog/products?pageSize=100');
  const [form, setForm] = useState({
    name: discount.name ?? '',
    type: discount.type ?? 'PERCENT',
    value: discount.value != null ? String(discount.value / 100) : '',
    scope: discount.scope ?? 'SUBSCRIPTION',
    productIds: discount.products?.map((p) => p.product.id) ?? ([] as number[]),
    minPurchase: discount.minPurchase ? String(discount.minPurchase / 100) : '0',
    minQuantity: String(discount.minQuantity ?? 0),
    startDate: toInputDate(discount.startDate),
    endDate: toInputDate(discount.endDate),
    usageLimit: discount.usageLimit != null ? String(discount.usageLimit) : '',
    active: discount.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState<{ affected: number; reductionPerCycle: number } | null>(null);

  const body = () => ({
    ...form,
    value: Number(form.value),
    minPurchase: Number(form.minPurchase),
    minQuantity: Number(form.minQuantity),
    startDate: form.startDate || null,
    endDate: form.endDate || null,
    usageLimit: form.usageLimit ? Number(form.usageLimit) : null,
    productIds: form.scope === 'PRODUCTS' ? form.productIds : [],
  });

  const preview = async () => {
    setBusy(true);
    setError(null);
    try {
      setImpact(await api.post('/discounts/preview', body()));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (discount.id) await api.put(`/discounts/${discount.id}`, body());
      else await api.post('/discounts', body());
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={discount.id ? 'Edit discount' : 'New discount'} wide>
      <form onSubmit={submit} className="space-y-4" onChange={() => setImpact(null)}>
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name">
            <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Type">
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as 'PERCENT' | 'FIXED' })}>
              <option value="PERCENT">Percentage</option>
              <option value="FIXED">Fixed amount</option>
            </Select>
          </Field>
          <Field label={form.type === 'PERCENT' ? 'Percent off' : 'Amount off (₹)'}>
            <Input type="number" step="0.01" min="0.01" max={form.type === 'PERCENT' ? 100 : undefined} required value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
          </Field>
        </div>
        <Field label="Applies to">
          <Select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as 'SUBSCRIPTION' | 'PRODUCTS' })}>
            <option value="SUBSCRIPTION">Whole subscription</option>
            <option value="PRODUCTS">Specific products</option>
          </Select>
        </Field>
        {form.scope === 'PRODUCTS' && (
          <div className="grid max-h-36 grid-cols-2 gap-2 overflow-y-auto rounded-lg border border-slate-200 p-3">
            {products.data?.data.map((p) => (
              <Checkbox
                key={p.id}
                label={p.name}
                checked={form.productIds.includes(p.id)}
                onChange={(v) => setForm({ ...form, productIds: v ? [...form.productIds, p.id] : form.productIds.filter((x) => x !== p.id) })}
              />
            ))}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Min purchase (₹)">
            <Input type="number" min="0" step="0.01" value={form.minPurchase} onChange={(e) => setForm({ ...form, minPurchase: e.target.value })} />
          </Field>
          <Field label="Min quantity">
            <Input type="number" min="0" value={form.minQuantity} onChange={(e) => setForm({ ...form, minQuantity: e.target.value })} />
          </Field>
          <Field label="Start">
            <Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
          </Field>
          <Field label="End">
            <Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Usage limit" hint="Number of invoices it can apply to. Empty for unlimited.">
            <Input type="number" min="1" value={form.usageLimit} onChange={(e) => setForm({ ...form, usageLimit: e.target.value })} />
          </Field>
          <div className="pt-6">
            <Checkbox label="Active" checked={form.active} onChange={(v) => setForm({ ...form, active: v })} />
          </div>
        </div>
        {impact && (
          <Alert kind={impact.reductionPerCycle > 0 ? 'warning' : 'info'}>
            Applies to <strong>{impact.affected}</strong> active subscriptions, <strong>−{inr(impact.reductionPerCycle)}</strong> per billing cycle.
          </Alert>
        )}
        <div className="flex justify-between gap-2">
          <Button type="button" variant="secondary" onClick={preview} loading={busy && !impact}>
            Preview impact
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
