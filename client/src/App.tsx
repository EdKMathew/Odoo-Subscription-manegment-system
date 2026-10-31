import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { homeFor, useAuth, type Role } from './lib/auth';
import { Spinner } from './components/ui';
import { Layout } from './components/Layout';
import { ForgotPasswordPage, LoginPage, ResetPasswordPage, SignupPage } from './pages/auth/AuthPages';
import { Dashboard } from './pages/staff/Dashboard';
import { SubscriptionDetail, SubscriptionList, SubscriptionNew } from './pages/staff/Subscriptions';
import { InvoiceDetail, InvoiceList } from './pages/staff/Invoices';
import { BillingRun, Outbox, Overdue, Renewals } from './pages/staff/Billing';
import { CustomerDetail, CustomerList } from './pages/staff/Customers';
import { Plans, Products } from './pages/staff/Catalog';
import { Pricing } from './pages/staff/Pricing';
import { Templates } from './pages/staff/Templates';
import { Users } from './pages/staff/Users';
import { PortalHome, QuoteAccept } from './pages/portal/Portal';
import { Reconcile } from './pages/staff/Reconcile';

// Client-side guard for navigation only; every API route enforces roles on the server.
function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return <>{children}</>;
}

function Home() {
  const { user, loading } = useAuth();
  if (loading) return <Spinner />;
  return <Navigate to={user ? homeFor(user.role) : '/login'} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/quote/:token" element={<QuoteAccept />} />

      <Route
        path="/app"
        element={
          <RequireRole roles={['ADMIN', 'STAFF']}>
            <Layout />
          </RequireRole>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="subscriptions" element={<SubscriptionList />} />
        <Route path="subscriptions/new" element={<SubscriptionNew />} />
        <Route path="subscriptions/:id" element={<SubscriptionDetail />} />
        <Route path="customers" element={<CustomerList />} />
        <Route path="customers/:id" element={<CustomerDetail />} />
        <Route path="renewals" element={<Renewals />} />
        <Route path="invoices" element={<InvoiceList />} />
        <Route path="invoices/:id" element={<InvoiceDetail />} />
        <Route path="billing" element={<BillingRun />} />
        <Route path="overdue" element={<Overdue />} />
        <Route path="outbox" element={<Outbox />} />
        <Route path="reconcile" element={<Reconcile />} />
        <Route path="products" element={<Products />} />
        <Route path="plans" element={<Plans />} />
        <Route path="templates" element={<Templates />} />
        <Route path="pricing" element={<Pricing />} />
        <Route
          path="users"
          element={
            <RequireRole roles={['ADMIN']}>
              <Users />
            </RequireRole>
          }
        />
      </Route>

      <Route
        path="/portal"
        element={
          <RequireRole roles={['CUSTOMER']}>
            <Layout portal />
          </RequireRole>
        }
      >
        <Route index element={<PortalHome />} />
        <Route path="subscriptions" element={<SubscriptionList portal />} />
        <Route path="subscriptions/:id" element={<SubscriptionDetail portal />} />
        <Route path="invoices" element={<InvoiceList portal />} />
        <Route path="invoices/:id" element={<InvoiceDetail portal />} />
      </Route>

      <Route path="*" element={<Home />} />
    </Routes>
  );
}
