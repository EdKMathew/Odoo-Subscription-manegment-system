import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { onResponseTime } from '../lib/api';
import { CommandPalette } from './CommandPalette';

interface NavItem {
  to: string;
  label: string;
  adminOnly?: boolean;
}

const staffNav: { group: string; items: NavItem[] }[] = [
  { group: 'Overview', items: [{ to: '/app', label: 'Dashboard' }] },
  {
    group: 'Sales',
    items: [
      { to: '/app/subscriptions', label: 'Subscriptions' },
      { to: '/app/customers', label: 'Customers' },
      { to: '/app/renewals', label: 'Renewal radar' },
    ],
  },
  {
    group: 'Billing',
    items: [
      { to: '/app/invoices', label: 'Invoices' },
      { to: '/app/billing', label: 'Billing run' },
      { to: '/app/overdue', label: 'Overdue' },
      { to: '/app/reconcile', label: 'Bank matching' },
      { to: '/app/outbox', label: 'Outbox' },
    ],
  },
  {
    group: 'Configuration',
    items: [
      { to: '/app/products', label: 'Products' },
      { to: '/app/plans', label: 'Plans' },
      { to: '/app/templates', label: 'Quote templates' },
      { to: '/app/pricing', label: 'Taxes & discounts' },
      { to: '/app/users', label: 'Users', adminOnly: true },
    ],
  },
];

const portalNav: { group: string; items: NavItem[] }[] = [
  {
    group: 'My account',
    items: [
      { to: '/portal', label: 'Overview' },
      { to: '/portal/subscriptions', label: 'Subscriptions' },
      { to: '/portal/invoices', label: 'Invoices' },
    ],
  },
];

export function Layout({ portal }: { portal?: boolean }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [rt, setRt] = useState<string | null>(null);

  useEffect(() => onResponseTime(setRt), []);
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const nav = portal ? portalNav : staffNav;

  const sidebar: ReactNode = (
    <nav className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-5 py-5">
        <img src="/favicon.svg" alt="" className="h-7 w-7" />
        <span className="text-lg font-semibold tracking-tight">SubFlow</span>
      </div>
      <button
        onClick={() => setPalette(true)}
        className="mx-3 mb-3 flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
      >
        Search…
        <kbd className="rounded border border-slate-300 bg-white px-1.5 text-[10px] font-medium">Ctrl K</kbd>
      </button>
      <div className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {nav.map((g) => (
          <div key={g.group}>
            <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{g.group}</p>
            {g.items
              .filter((i) => !i.adminOnly || user?.role === 'ADMIN')
              .map((i) => (
                <NavLink
                  key={i.to}
                  to={i.to}
                  end={i.to === '/app' || i.to === '/portal'}
                  className={({ isActive }) =>
                    `block rounded-lg px-2.5 py-1.5 text-sm ${isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`
                  }
                >
                  {i.label}
                </NavLink>
              ))}
          </div>
        ))}
      </div>
      <div className="border-t border-slate-200 px-4 py-3">
        <p className="truncate text-sm font-medium">{user?.name}</p>
        <p className="truncate text-xs text-slate-500">
          {user?.email} · {user?.role.toLowerCase()}
        </p>
        <button
          onClick={async () => {
            await logout();
            navigate('/login');
          }}
          className="mt-2 text-xs font-medium text-slate-500 hover:text-red-600"
        >
          Log out
        </button>
      </div>
    </nav>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-slate-900/40" />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5 lg:hidden">
          <button onClick={() => setOpen(true)} className="rounded p-1.5 text-slate-600 hover:bg-slate-100" aria-label="Open menu">
            ☰
          </button>
          <span className="font-semibold">SubFlow</span>
          <button onClick={() => setPalette(true)} className="rounded p-1.5 text-slate-600 hover:bg-slate-100" aria-label="Search">
            ⌕
          </button>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
            <Outlet />
          </div>
        </main>
        {rt && (
          <div className="pointer-events-none fixed bottom-3 right-3 rounded-full bg-slate-900/80 px-2.5 py-1 text-[11px] font-medium text-white tabular" title="Server time for the last request">
            API {rt}
          </div>
        )}
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} portal={portal} />
    </div>
  );
}
