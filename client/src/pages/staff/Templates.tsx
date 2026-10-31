import { useState, type FormEvent } from 'react';
import { api, type Page } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { period } from '../../lib/format';
import { Alert, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td } from '../../components/ui';

interface Template {
  id: number;
  name: string;
  validityDays: number;
  durationDays: number | null;
  plan: { id: number; name: string; billingPeriod: string };
  lines: { id: number; quantity: number; product: { id: number; name: string }; variant: { id: number; name: string } | null }[];
}

export function Templates() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const { data, loading, reload } = useApi<{ data: Template[] }>('/templates');
  const [editing, setEditing] = useState<Partial<Template> | null>(null);

  const remove = async (id: number) => {
    if (!window.confirm('Delete this template?')) return;
    await api.del(`/templates/${id}`);
    reload();
  };

  return (
    <>
      <PageHeader title="Quotation templates" sub="Reusable plan + product bundles with a validity period" actions={isAdmin && <Button onClick={() => setEditing({})}>New template</Button>} />
      <Card padded={false}>
        {loading && !data ? (
          <Spinner />
        ) : (
          <Table head={['Template', 'Plan', 'Products', 'Valid for', 'Duration', '']} empty={data?.data.length === 0}>
            {data?.data.map((t) => (
              <tr key={t.id} className="align-top hover:bg-slate-50">
                <Td className="font-medium">{t.name}</Td>
                <Td>
                  {t.plan.name} <span className="text-xs text-slate-400">· {period[t.plan.billingPeriod]}</span>
                </Td>
                <Td className="whitespace-normal text-xs">
                  {t.lines.map((l) => (
                    <div key={l.id}>
                      {l.quantity} × {l.product.name}
                      {l.variant && ` (${l.variant.name})`}
                    </div>
                  ))}
                </Td>
                <Td>{t.validityDays} days</Td>
                <Td>{t.durationDays ? `${t.durationDays} days` : 'Open-ended'}</Td>
                <Td>
                  {isAdmin && (
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(t.id)}>
                        Delete
                      </Button>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {editing && <TemplateForm template={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function TemplateForm({ template, onClose, onSaved }: { template: Partial<Template>; onClose: () => void; onSaved: () => void }) {
  const plans = useApi<{ data: { id: number; name: string }[] }>('/catalog/plans');
  const products = useApi<Page<{ id: number; name: string; variants: { id: number; name: string; active: boolean }[] }>>('/catalog/products?pageSize=100');
  const [form, setForm] = useState({
    name: template.name ?? '',
    planId: template.plan ? String(template.plan.id) : '',
    validityDays: String(template.validityDays ?? 30),
    durationDays: template.durationDays ? String(template.durationDays) : '',
  });
  const [lines, setLines] = useState(
    template.lines?.map((l) => ({ productId: String(l.product.id), variantId: l.variant ? String(l.variant.id) : '', quantity: String(l.quantity) })) ?? [{ productId: '', variantId: '', quantity: '1' }],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: form.name,
        planId: Number(form.planId),
        validityDays: Number(form.validityDays),
        durationDays: form.durationDays ? Number(form.durationDays) : null,
        lines: lines.filter((l) => l.productId).map((l) => ({ productId: Number(l.productId), variantId: l.variantId ? Number(l.variantId) : null, quantity: Number(l.quantity) })),
      };
      if (template.id) await api.put(`/templates/${template.id}`, body);
      else await api.post('/templates', body);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={template.id ? 'Edit template' : 'New template'} wide>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Plan">
            <Select required value={form.planId} onChange={(e) => setForm({ ...form, planId: e.target.value })}>
              <option value="">Select plan</option>
              {plans.data?.data.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Quote valid for (days)">
            <Input type="number" min="1" value={form.validityDays} onChange={(e) => setForm({ ...form, validityDays: e.target.value })} />
          </Field>
          <Field label="Subscription length (days)" hint="Sets the expiry date. Empty for open-ended.">
            <Input type="number" min="1" value={form.durationDays} onChange={(e) => setForm({ ...form, durationDays: e.target.value })} />
          </Field>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-700">Products</p>
          {lines.map((l, i) => {
            const p = products.data?.data.find((x) => String(x.id) === l.productId);
            return (
              <div key={i} className="grid grid-cols-12 gap-2">
                <Select className="col-span-12 sm:col-span-5" value={l.productId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, productId: e.target.value, variantId: '' } : x)))}>
                  <option value="">Select product</option>
                  {products.data?.data.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
                <Select className="col-span-6 sm:col-span-4" value={l.variantId} disabled={!p?.variants.length} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, variantId: e.target.value } : x)))}>
                  <option value="">No variant</option>
                  {p?.variants.filter((v) => v.active).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
                <Input className="col-span-4 sm:col-span-2" type="number" min="1" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
                <Button type="button" variant="ghost" className="col-span-2 sm:col-span-1" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove">
                  ✕
                </Button>
              </div>
            );
          })}
          <Button type="button" size="sm" variant="ghost" onClick={() => setLines([...lines, { productId: '', variantId: '', quantity: '1' }])}>
            + Add product
          </Button>
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
