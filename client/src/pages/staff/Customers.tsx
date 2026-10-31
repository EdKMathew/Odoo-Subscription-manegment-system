import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, qs, type Page } from '../../lib/api';
import { useApi, useDebounced } from '../../lib/hooks';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Pager, Spinner, Table, Td, Textarea } from '../../components/ui';

interface Customer {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  gstin: string | null;
  state: string | null;
  address: string | null;
  hasPortal?: boolean;
  _count?: { subscriptions: number };
}

export function CustomerList() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebounced(q);
  const { data, loading, reload } = useApi<Page<Customer>>(`/customers${qs({ q: term, page })}`);
  const [editing, setEditing] = useState<Partial<Customer> | null>(null);

  return (
    <>
      <PageHeader title="Customers" actions={<Button onClick={() => setEditing({})}>New customer</Button>} />
      <Card padded={false}>
        <div className="border-b border-slate-100 p-3">
          <Input placeholder="Search name or email" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="max-w-xs" />
        </div>
        {loading && !data ? (
          <Spinner />
        ) : (
          <Table head={['Name', 'Email', 'State', 'GSTIN', 'Subscriptions', 'Portal']} empty={data?.data.length === 0}>
            {data?.data.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50">
                <Td>
                  <Link to={`/app/customers/${c.id}`} className="font-medium text-brand-700 hover:underline">
                    {c.name}
                  </Link>
                </Td>
                <Td>{c.email}</Td>
                <Td>{c.state ?? '—'}</Td>
                <Td className="font-mono text-xs">{c.gstin ?? '—'}</Td>
                <Td className="tabular">{c._count?.subscriptions ?? 0}</Td>
                <Td>{c.hasPortal ? <Badge value="ACTIVE" label="Yes" /> : <span className="text-xs text-slate-400">No</span>}</Td>
              </tr>
            ))}
          </Table>
        )}
        {data && <Pager page={data.page} pages={data.pages} total={data.total} onPage={setPage} />}
      </Card>
      <CustomerForm customer={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
    </>
  );
}

function CustomerForm({ customer, onClose, onSaved }: { customer: Partial<Customer> | null; onClose: () => void; onSaved: () => void }) {
  if (!customer) return null;
  return <CustomerFormInner customer={customer} onClose={onClose} onSaved={onSaved} />;
}

function CustomerFormInner({ customer, onClose, onSaved }: { customer: Partial<Customer>; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Partial<Customer>>(customer);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof Customer) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name: form.name, email: form.email, phone: form.phone || null, gstin: form.gstin || '', state: form.state || null, address: form.address || null };
      if (customer.id) await api.put(`/customers/${customer.id}`, body);
      else await api.post('/customers', body);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={customer.id ? 'Edit customer' : 'New customer'}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Name">
          <Input required value={form.name ?? ''} onChange={set('name')} />
        </Field>
        <Field label="Email">
          <Input type="email" required value={form.email ?? ''} onChange={set('email')} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone">
            <Input value={form.phone ?? ''} onChange={set('phone')} />
          </Field>
          <Field label="State" hint="Decides CGST+SGST or IGST">
            <Input value={form.state ?? ''} onChange={set('state')} />
          </Field>
        </div>
        <Field label="GSTIN">
          <Input value={form.gstin ?? ''} onChange={set('gstin')} maxLength={15} />
        </Field>
        <Field label="Address">
          <Textarea rows={2} value={form.address ?? ''} onChange={set('address')} />
        </Field>
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

export function CustomerDetail() {
  const { id } = useParams();
  const { data, loading, reload } = useApi<
    Customer & { user: { id: number } | null; risk: string[]; subscriptions: { id: number; number: string; status: string; plan: { name: string } }[] }
  >(`/customers/${id}`);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading && !data) return <Spinner />;
  if (!data) return null;

  const invite = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.post(`/customers/${data.id}/invite`);
      setMsg({ kind: 'success', text: `Portal invite sent to ${data.email}` });
      reload();
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title={data.name}
        sub={data.email}
        actions={
          <>
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
            {!data.user && (
              <Button variant="secondary" loading={busy} onClick={invite}>
                Invite to portal
              </Button>
            )}
            <Link to={`/app/subscriptions/new?customerId=${data.id}`}>
              <Button>New subscription</Button>
            </Link>
          </>
        }
      />
      {msg && <div className="mb-4"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      {data.risk.length > 0 && (
        <div className="mb-4">
          <Alert kind="warning">
            <span className="font-semibold">At risk:</span> {data.risk.join(' · ')}
          </Alert>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Details">
          <dl className="space-y-2.5 text-sm">
            {[
              ['Phone', data.phone],
              ['State', data.state],
              ['GSTIN', data.gstin],
              ['Address', data.address],
              ['Portal access', data.user ? 'Yes' : 'No'],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-slate-500">{k}</dt>
                <dd className="text-right font-medium">{v || '—'}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card title="Subscriptions" padded={false} className="lg:col-span-2">
          <Table head={['Number', 'Plan', 'Status']} empty={data.subscriptions.length === 0}>
            {data.subscriptions.map((s) => (
              <tr key={s.id} className="hover:bg-slate-50">
                <Td>
                  <Link to={`/app/subscriptions/${s.id}`} className="font-medium text-brand-700 hover:underline">
                    {s.number}
                  </Link>
                </Td>
                <Td>{s.plan.name}</Td>
                <Td>
                  <Badge value={s.status} />
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
      <CustomerForm customer={editing ? data : null} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />
    </>
  );
}
