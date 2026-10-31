import { useState, type FormEvent } from 'react';
import { api, qs, type Page } from '../../lib/api';
import { useApi, useDebounced } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { date, inr, period, toInputDate } from '../../lib/format';
import { Alert, Badge, Button, Card, Checkbox, Field, Input, Modal, PageHeader, Pager, Select, Spinner, Table, Td, Textarea } from '../../components/ui';

interface AttrValue {
  id: number;
  value: string;
  priceExtra: number;
  attribute?: { id: number; name: string };
}
interface Attribute {
  id: number;
  name: string;
  values: AttrValue[];
}
interface Product {
  id: number;
  name: string;
  type: string;
  salesPrice: number;
  costPrice?: number;
  notes: string | null;
  active: boolean;
  taxRule: { id: number; name: string; rateBp: number } | null;
  variants: { id: number; name: string; active: boolean; values: { attributeValue: AttrValue }[] }[];
}

export function Products() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebounced(q);
  const { data, loading, reload } = useApi<Page<Product>>(`/catalog/products${qs({ q: term, page })}`);
  const attrs = useApi<{ data: Attribute[] }>('/catalog/attributes');
  const [editing, setEditing] = useState<Partial<Product> | null>(null);
  const [variantFor, setVariantFor] = useState<Product | null>(null);
  const [attrOpen, setAttrOpen] = useState(false);

  const removeVariant = async (id: number) => {
    await api.del(`/catalog/variants/${id}`);
    reload();
  };

  return (
    <>
      <PageHeader
        title="Products"
        sub="Products, their variants and attribute price extras"
        actions={
          isAdmin && (
            <>
              <Button variant="secondary" onClick={() => setAttrOpen(true)}>
                Attributes
              </Button>
              <Button onClick={() => setEditing({ type: 'SERVICE', active: true })}>New product</Button>
            </>
          )
        }
      />
      <Card padded={false}>
        <div className="border-b border-slate-100 p-3">
          <Input placeholder="Search products" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="max-w-xs" />
        </div>
        {loading && !data ? (
          <Spinner />
        ) : (
          <Table head={['Product', 'Type', 'Sales price', 'Cost', 'Tax', 'Variants', '']} empty={data?.data.length === 0}>
            {data?.data.map((p) => (
              <tr key={p.id} className="align-top hover:bg-slate-50">
                <Td>
                  <p className="font-medium">{p.name}</p>
                  {p.notes && <p className="text-xs text-slate-500">{p.notes}</p>}
                  {!p.active && <Badge value="CLOSED" label="Archived" />}
                </Td>
                <Td>{p.type === 'SERVICE' ? 'Service' : 'Goods'}</Td>
                <Td className="tabular">{inr(p.salesPrice)}</Td>
                <Td className="tabular">{p.costPrice != null ? inr(p.costPrice) : '—'}</Td>
                <Td>{p.taxRule ? p.taxRule.name : <span className="text-xs text-slate-400">Default</span>}</Td>
                <Td className="whitespace-normal">
                  <div className="flex flex-col gap-1">
                    {p.variants
                      .filter((v) => v.active)
                      .map((v) => {
                        const extra = v.values.reduce((s, x) => s + x.attributeValue.priceExtra, 0);
                        return (
                          <span key={v.id} className="flex items-center gap-2 text-xs">
                            <span className="rounded bg-slate-100 px-1.5 py-0.5">{v.name}</span>
                            {extra > 0 && <span className="text-slate-500">+{inr(extra)}</span>}
                            {isAdmin && (
                              <button className="text-slate-400 hover:text-red-600" onClick={() => removeVariant(v.id)} aria-label="Remove variant">
                                ✕
                              </button>
                            )}
                          </span>
                        );
                      })}
                    {isAdmin && (
                      <button className="text-left text-xs font-medium text-brand-600" onClick={() => setVariantFor(p)}>
                        + Add variant
                      </button>
                    )}
                  </div>
                </Td>
                <Td>
                  {isAdmin && (
                    <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                      Edit
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
        {data && <Pager page={data.page} pages={data.pages} total={data.total} onPage={setPage} />}
      </Card>
      {editing && <ProductForm product={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {variantFor && attrs.data && (
        <VariantForm product={variantFor} attributes={attrs.data.data} onClose={() => setVariantFor(null)} onSaved={() => { setVariantFor(null); reload(); }} />
      )}
      {attrOpen && <AttributeManager attributes={attrs.data?.data ?? []} onClose={() => setAttrOpen(false)} onSaved={attrs.reload} />}
    </>
  );
}

function ProductForm({ product, onClose, onSaved }: { product: Partial<Product>; onClose: () => void; onSaved: () => void }) {
  const taxes = useApi<{ data: { id: number; name: string; active: boolean }[] }>('/catalog/tax-rules');
  const [form, setForm] = useState({
    name: product.name ?? '',
    type: product.type ?? 'SERVICE',
    salesPrice: product.salesPrice != null ? String(product.salesPrice / 100) : '',
    costPrice: product.costPrice != null ? String(product.costPrice / 100) : '0',
    notes: product.notes ?? '',
    taxRuleId: product.taxRule?.id ? String(product.taxRule.id) : '',
    active: product.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { ...form, salesPrice: Number(form.salesPrice), costPrice: Number(form.costPrice), taxRuleId: form.taxRuleId ? Number(form.taxRuleId) : null, notes: form.notes || null };
      if (product.id) await api.put(`/catalog/products/${product.id}`, body);
      else await api.post('/catalog/products', body);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={product.id ? 'Edit product' : 'New product'}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Name">
          <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Type">
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="SERVICE">Service</option>
              <option value="GOODS">Goods</option>
            </Select>
          </Field>
          <Field label="Sales price (₹)">
            <Input type="number" step="0.01" min="0" required value={form.salesPrice} onChange={(e) => setForm({ ...form, salesPrice: e.target.value })} />
          </Field>
          <Field label="Cost price (₹)">
            <Input type="number" step="0.01" min="0" value={form.costPrice} onChange={(e) => setForm({ ...form, costPrice: e.target.value })} />
          </Field>
        </div>
        <Field label="Tax rule" hint="Leave as default to use the default tax rule">
          <Select value={form.taxRuleId} onChange={(e) => setForm({ ...form, taxRuleId: e.target.value })}>
            <option value="">Default</option>
            {taxes.data?.data.filter((t) => t.active).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Notes">
          <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
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

function VariantForm({ product, attributes, onClose, onSaved }: { product: Product; attributes: Attribute[]; onClose: () => void; onSaved: () => void }) {
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = Object.values(picked).filter(Boolean).map(Number);
  const extra = attributes.flatMap((a) => a.values).filter((v) => ids.includes(v.id)).reduce((s, v) => s + v.priceExtra, 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/catalog/products/${product.id}/variants`, { attributeValueIds: ids });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`New variant of ${product.name}`}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {attributes.length === 0 && <Alert kind="info">Create an attribute first (e.g. Brand → Odoo +₹560).</Alert>}
        {attributes.map((a) => (
          <Field key={a.id} label={a.name}>
            <Select value={picked[a.id] ?? ''} onChange={(e) => setPicked({ ...picked, [a.id]: e.target.value })}>
              <option value="">—</option>
              {a.values.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.value}
                  {v.priceExtra ? ` (+${inr(v.priceExtra)})` : ''}
                </option>
              ))}
            </Select>
          </Field>
        ))}
        <p className="text-sm text-slate-600">
          Unit price: {inr(product.salesPrice)} + {inr(extra)} = <strong>{inr(product.salesPrice + extra)}</strong>
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!ids.length}>
            Add variant
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function AttributeManager({ attributes, onClose, onSaved }: { attributes: Attribute[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [values, setValues] = useState([{ value: '', priceExtra: '0' }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/catalog/attributes', { name, values: values.filter((v) => v.value).map((v) => ({ value: v.value, priceExtra: Number(v.priceExtra) })) });
      setName('');
      setValues([{ value: '', priceExtra: '0' }]);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Attributes" wide>
      <div className="mb-5 space-y-2">
        {attributes.map((a) => (
          <div key={a.id} className="text-sm">
            <span className="font-medium">{a.name}:</span>{' '}
            {a.values.map((v) => `${v.value}${v.priceExtra ? ` (+${inr(v.priceExtra)})` : ''}`).join(', ')}
          </div>
        ))}
        {!attributes.length && <p className="text-sm text-slate-500">No attributes yet.</p>}
      </div>
      <form onSubmit={submit} className="space-y-3 border-t border-slate-100 pt-4">
        {error && <Alert>{error}</Alert>}
        <Field label="New attribute name">
          <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Brand" />
        </Field>
        {values.map((v, i) => (
          <div key={i} className="grid grid-cols-2 gap-2">
            <Input placeholder="Value (e.g. Odoo)" value={v.value} onChange={(e) => setValues(values.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
            <Input type="number" step="0.01" min="0" placeholder="Price extra ₹" value={v.priceExtra} onChange={(e) => setValues(values.map((x, j) => (j === i ? { ...x, priceExtra: e.target.value } : x)))} />
          </div>
        ))}
        <div className="flex justify-between">
          <Button type="button" size="sm" variant="ghost" onClick={() => setValues([...values, { value: '', priceExtra: '0' }])}>
            + Add value
          </Button>
          <Button type="submit" loading={busy}>
            Create attribute
          </Button>
        </div>
      </form>
    </Modal>
  );
}

interface Plan {
  id: number;
  name: string;
  price: number;
  billingPeriod: string;
  minQuantity: number;
  availableFrom: string | null;
  availableTo: string | null;
  autoClose: boolean;
  closable: boolean;
  pausable: boolean;
  renewable: boolean;
  active: boolean;
  _count?: { subscriptions: number };
}

export function Plans() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const { data, loading, reload } = useApi<{ data: Plan[] }>('/catalog/plans');
  const [editing, setEditing] = useState<Partial<Plan> | null>(null);

  return (
    <>
      <PageHeader title="Plans" sub="Billing period, minimum quantity, availability and plan rules" actions={isAdmin && <Button onClick={() => setEditing({})}>New plan</Button>} />
      <Card padded={false}>
        {loading && !data ? (
          <Spinner />
        ) : (
          <Table head={['Plan', 'Price', 'Period', 'Min qty', 'Available', 'Rules', 'Subs', '']} empty={data?.data.length === 0}>
            {data?.data.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50">
                <Td>
                  <span className="font-medium">{p.name}</span> {!p.active && <Badge value="CLOSED" label="Inactive" />}
                </Td>
                <Td className="tabular">{inr(p.price)}</Td>
                <Td>{period[p.billingPeriod]}</Td>
                <Td className="tabular">{p.minQuantity}</Td>
                <Td className="text-xs">
                  {p.availableFrom || p.availableTo ? `${date(p.availableFrom)} – ${date(p.availableTo)}` : 'Always'}
                </Td>
                <Td className="text-xs">{[p.pausable && 'Pausable', p.closable && 'Closable', p.renewable && 'Renewable', p.autoClose && 'Auto-close'].filter(Boolean).join(', ')}</Td>
                <Td className="tabular">{p._count?.subscriptions ?? 0}</Td>
                <Td>
                  {isAdmin && (
                    <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                      Edit
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {editing && <PlanForm plan={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function PlanForm({ plan, onClose, onSaved }: { plan: Partial<Plan>; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: plan.name ?? '',
    price: plan.price != null ? String(plan.price / 100) : '0',
    billingPeriod: plan.billingPeriod ?? 'MONTHLY',
    minQuantity: String(plan.minQuantity ?? 1),
    availableFrom: toInputDate(plan.availableFrom),
    availableTo: toInputDate(plan.availableTo),
    autoClose: plan.autoClose ?? false,
    closable: plan.closable ?? true,
    pausable: plan.pausable ?? false,
    renewable: plan.renewable ?? true,
    active: plan.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const flag = (k: 'autoClose' | 'closable' | 'pausable' | 'renewable' | 'active') => (v: boolean) => setForm({ ...form, [k]: v });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { ...form, price: Number(form.price), minQuantity: Number(form.minQuantity), availableFrom: form.availableFrom || null, availableTo: form.availableTo || null };
      if (plan.id) await api.put(`/catalog/plans/${plan.id}`, body);
      else await api.post('/catalog/plans', body);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={plan.id ? 'Edit plan' : 'New plan'}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Name">
          <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Base price (₹)" hint="Recurring fee per period">
            <Input type="number" step="0.01" min="0" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
          </Field>
          <Field label="Billing period">
            <Select value={form.billingPeriod} onChange={(e) => setForm({ ...form, billingPeriod: e.target.value })}>
              {Object.entries(period).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Min quantity">
            <Input type="number" min="1" value={form.minQuantity} onChange={(e) => setForm({ ...form, minQuantity: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Available from">
            <Input type="date" value={form.availableFrom} onChange={(e) => setForm({ ...form, availableFrom: e.target.value })} />
          </Field>
          <Field label="Available to">
            <Input type="date" value={form.availableTo} onChange={(e) => setForm({ ...form, availableTo: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Checkbox label="Pausable" hint="Customer can pause" checked={form.pausable} onChange={flag('pausable')} />
          <Checkbox label="Closable" hint="Customer can cancel from portal" checked={form.closable} onChange={flag('closable')} />
          <Checkbox label="Renewable" hint="Shows on renewal radar" checked={form.renewable} onChange={flag('renewable')} />
          <Checkbox label="Auto-close" hint="Close automatically at expiry" checked={form.autoClose} onChange={flag('autoClose')} />
          <Checkbox label="Active" checked={form.active} onChange={flag('active')} />
        </div>
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
