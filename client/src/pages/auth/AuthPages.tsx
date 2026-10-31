import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { homeFor, useAuth, type User } from '../../lib/auth';
import { Alert, Button, Field, Input } from '../../components/ui';

function Shell({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="h-8 w-8" />
          <span className="text-xl font-semibold tracking-tight">SubFlow</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {sub && <p className="mt-1 text-sm text-slate-500">{sub}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

// Mirrors the server rule: more than 8 characters, upper, lower and special.
export const passwordRules = [
  { label: 'More than 8 characters', test: (p: string) => p.length > 8 },
  { label: 'An uppercase letter', test: (p: string) => /[A-Z]/.test(p) },
  { label: 'A lowercase letter', test: (p: string) => /[a-z]/.test(p) },
  { label: 'A special character', test: (p: string) => /[^A-Za-z0-9]/.test(p) },
];

export function PasswordChecklist({ password }: { password: string }) {
  return (
    <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
      {passwordRules.map((r) => {
        const ok = r.test(password);
        return (
          <li key={r.label} className={ok ? 'text-emerald-600' : 'text-slate-400'}>
            {ok ? '✓' : '○'} {r.label}
          </li>
        );
      })}
    </ul>
  );
}

export function LoginPage() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={homeFor(user.role)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ user: User }>('/auth/login', { email, password });
      setUser(r.user);
      navigate(homeFor(r.user.role));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Log in" sub="Manage subscriptions, invoices and payments.">
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Email">
          <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <div className="flex justify-end">
          <Link to="/forgot-password" className="text-sm font-medium text-brand-600 hover:text-brand-700">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" loading={busy} className="w-full">
          Log in
        </Button>
        <p className="text-center text-sm text-slate-500">
          New customer?{' '}
          <Link to="/signup" className="font-medium text-brand-600 hover:text-brand-700">
            Create an account
          </Link>
        </p>
      </form>
    </Shell>
  );
}

export function SignupPage() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '', phone: '', gstin: '', state: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={homeFor(user.role)} replace />;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const valid = passwordRules.every((r) => r.test(form.password));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return setError('Password does not meet the requirements');
    if (form.password !== form.confirm) return setError('Passwords do not match');
    setBusy(true);
    setError(null);
    try {
      const { confirm: _c, ...body } = form;
      const r = await api.post<{ user: User }>('/auth/signup', body);
      setUser(r.user);
      navigate('/portal');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Create your account" sub="Customer portal for your subscriptions and invoices.">
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Name or company">
          <Input required value={form.name} onChange={set('name')} autoComplete="organization" />
        </Field>
        <Field label="Email">
          <Input type="email" required value={form.email} onChange={set('email')} autoComplete="email" />
        </Field>
        <Field label="Password">
          <Input type="password" required value={form.password} onChange={set('password')} autoComplete="new-password" />
          <PasswordChecklist password={form.password} />
        </Field>
        <Field label="Confirm password">
          <Input type="password" required value={form.confirm} onChange={set('confirm')} autoComplete="new-password" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="State">
            <Input value={form.state} onChange={set('state')} placeholder="Kerala" />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} onChange={set('phone')} autoComplete="tel" />
          </Field>
        </div>
        <Field label="GSTIN (optional)" hint="Needed for GST invoices to a business">
          <Input value={form.gstin} onChange={set('gstin')} maxLength={15} />
        </Field>
        <Button type="submit" loading={busy} className="w-full">
          Create account
        </Button>
        <p className="text-center text-sm text-slate-500">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-brand-600 hover:text-brand-700">
            Log in
          </Link>
        </p>
      </form>
    </Shell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ message: string }>('/auth/forgot-password', { email });
      setDone(r.message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Reset your password" sub="We'll email you a link that works once and expires in 30 minutes.">
      {done ? (
        <div className="space-y-4">
          <Alert kind="success">{done}</Alert>
          <Link to="/login" className="text-sm font-medium text-brand-600">
            Back to log in
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <Field label="Email">
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" loading={busy} className="w-full">
            Send reset link
          </Button>
          <Link to="/login" className="block text-center text-sm font-medium text-slate-500">
            Back to log in
          </Link>
        </form>
      )}
    </Shell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!passwordRules.every((r) => r.test(password))) return setError('Password does not meet the requirements');
    if (password !== confirm) return setError('Passwords do not match');
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Choose a new password">
      {done ? (
        <div className="space-y-4">
          <Alert kind="success">Your password has been updated.</Alert>
          <Link to="/login" className="text-sm font-medium text-brand-600">
            Log in
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {!token && <Alert>This reset link is missing its token.</Alert>}
          {error && <Alert>{error}</Alert>}
          <Field label="New password">
            <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <PasswordChecklist password={password} />
          </Field>
          <Field label="Confirm password">
            <Input type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </Field>
          <Button type="submit" loading={busy} disabled={!token} className="w-full">
            Update password
          </Button>
        </form>
      )}
    </Shell>
  );
}
