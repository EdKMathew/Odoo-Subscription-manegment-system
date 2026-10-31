import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import { date } from '../../lib/format';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td } from '../../components/ui';
import { PasswordChecklist, passwordRules } from '../auth/AuthPages';

interface StaffUser {
  id: number;
  name: string;
  email: string;
  role: string;
  active: boolean;
  createdAt: string;
}

// Admin only: create staff accounts and deactivate them.
export function Users() {
  const { user } = useAuth();
  const { data, loading, reload } = useApi<{ data: StaffUser[] }>('/users');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (u: StaffUser) => {
    setError(null);
    try {
      await api.patch(`/users/${u.id}`, { active: !u.active });
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <PageHeader title="Users" sub="Staff and admin accounts. Customers sign up through the portal." actions={<Button onClick={() => setCreating(true)}>New staff user</Button>} />
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      <Card padded={false}>
        {loading && !data ? (
          <Spinner />
        ) : (
          <Table head={['Name', 'Email', 'Role', 'Created', 'Status', '']}>
            {data?.data.map((u) => (
              <tr key={u.id}>
                <Td className="font-medium">{u.name}</Td>
                <Td>{u.email}</Td>
                <Td>
                  <Badge value={u.role} />
                </Td>
                <Td>{date(u.createdAt)}</Td>
                <Td>{u.active ? <Badge value="ACTIVE" label="Active" /> : <Badge value="CLOSED" label="Deactivated" />}</Td>
                <Td>
                  {u.id !== user?.id && (
                    <Button size="sm" variant="ghost" onClick={() => toggle(u)}>
                      {u.active ? 'Deactivate' : 'Reactivate'}
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {creating && <CreateUser onClose={() => setCreating(false)} onSaved={() => { setCreating(false); reload(); }} />}
    </>
  );
}

function CreateUser({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'STAFF' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!passwordRules.every((r) => r.test(form.password))) return setError('Password does not meet the requirements');
    setBusy(true);
    setError(null);
    try {
      await api.post('/users', form);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="New staff user">
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Name">
          <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Email">
          <Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Temporary password">
          <Input type="password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
          <PasswordChecklist password={form.password} />
        </Field>
        <Field label="Role">
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="STAFF">Staff</option>
            <option value="ADMIN">Admin</option>
          </Select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}
