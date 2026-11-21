import '@fontsource/manrope/latin-400.css';
import '@fontsource/manrope/latin-600.css';
import './styles/app.css';
import './styles/elevation.css';
import './styles/centre.css';
import './lib/theme';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createBrowserRouter, createRoutesFromElements, Link, Navigate, Outlet, Route, RouterProvider, useLocation, useParams,
} from 'react-router';
import { AuthProvider, useAuth } from './app/auth';
import { CentreProvider, useMyCentres, useCentre, useCentreBySlug } from './app/centre';
import { Shell } from './app/Shell';
import { Empty, Loading, Notice, ToastProvider } from './components/ui';
import { LoginPage, SetNewPassword, SetupCentre } from './features/auth/AuthPages';
import { Dashboard } from './features/dashboard/Dashboard';
import { LandingPage } from './features/landing/LandingPage';
import { errorMessage } from './lib/errors';

const BookPage = lazy(() => import('./features/booking/BookPage').then((m) => ({ default: m.BookPage })));
const TicketPage = lazy(() => import('./features/booking/TicketPage').then((m) => ({ default: m.TicketPage })));
const BookingsPage = lazy(() => import('./features/booking/BookingsPage').then((m) => ({ default: m.BookingsPage })));
const DesignerPage = lazy(() => import('./features/floor/DesignerPage').then((m) => ({ default: m.DesignerPage })));
const PricesPage = lazy(() => import('./features/prices/PricesPage').then((m) => ({ default: m.PricesPage })));
const BillsPage = lazy(() => import('./features/billing/BillsPage').then((m) => ({ default: m.BillsPage })));
const BillPage = lazy(() => import('./features/billing/BillPage').then((m) => ({ default: m.BillPage })));
const ShiftPage = lazy(() => import('./features/shift/ShiftPage').then((m) => ({ default: m.ShiftPage })));
const TvPage = lazy(() => import('./features/tv/TvPage').then((m) => ({ default: m.TvPage })));
const FloorPage = lazy(() => import('./features/floor/FloorPage').then((m) => ({ default: m.FloorPage })));
const CustomersPage = lazy(() => import('./features/customers/CustomersPage').then((m) => ({ default: m.CustomersPage })));
const CustomerDetail = lazy(() => import('./features/customers/CustomerDetail').then((m) => ({ default: m.CustomerDetail })));
const TeamPage = lazy(() => import('./features/team/TeamPage').then((m) => ({ default: m.TeamPage })));
const InventoryPage = lazy(() => import('./features/inventory/InventoryPage').then((m) => ({ default: m.InventoryPage })));
const ExpensesPage = lazy(() => import('./features/expenses/ExpensesPage').then((m) => ({ default: m.ExpensesPage })));
const SettingsPage = lazy(() => import('./features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })));

// Refuse to render inside a frame.
if (window.top !== window.self) {
  document.documentElement.style.display = 'none';
  throw new Error('Framing is not allowed');
}

window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { name?: string; message?: string } | undefined;
  if ((r?.name === 'InvalidStateError' || r?.name === 'AbortError') && /transition/i.test(r.message ?? '')) e.preventDefault();
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});

function Splash() {
  return <div className="center-screen" aria-busy="true"><span className="spinner" /></div>;
}

function RequireAuth() {
  const { session, loading, recovering } = useAuth();
  const location = useLocation();
  if (loading) return <Splash />;
  if (recovering) return <SetNewPassword />;
  if (!session) {
    // Keep the link they opened, so sign-in brings them back to it.
    const next = location.pathname + location.search;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <Outlet />;
}

/** Signed out: landing page. Signed in: straight to the centre. */
function Root() {
  const { session, loading, recovering } = useAuth();
  if (loading) return <Splash />;
  if (recovering) return <SetNewPassword />;
  if (!session) return <LandingPage />;
  return <Home />;
}

function Home() {
  const centres = useMyCentres();
  if (centres.isPending) return <Splash />;
  if (centres.error) return <div className="center-screen"><Notice tone="bad">{errorMessage(centres.error)}</Notice></div>;
  if (centres.data.length === 0) return <Navigate to="/setup" replace />;
  const saved = localStorage.getItem('xs-arena');
  const pick = centres.data.find((s) => s.slug === saved) ?? centres.data[0];
  return <Navigate to={`/s/${pick.slug}`} replace />;
}

function CentreLayout() {
  const { slug } = useParams();
  const ctx = useCentreBySlug(slug);
  if (ctx.isPending) return <Splash />;
  if (ctx.error) return <div className="center-screen"><Notice tone="bad">{errorMessage(ctx.error)}</Notice></div>;
  if (!ctx.data) {
    return <div className="center-screen"><Empty title="Centre not found"><Link className="btn" to="/">Go home</Link></Empty></div>;
  }
  try { localStorage.setItem('xs-arena', ctx.data.centre.slug); } catch { /* storage blocked */ }
  return <CentreProvider value={ctx.data}><Shell /></CentreProvider>;
}

function Allow({ perm, children }: { perm?: string; children: ReactNode }) {
  const { can } = useCentre();
  if (perm && !can(perm)) return <Empty title="No access">Ask the centre owner for access.</Empty>;
  return <Suspense fallback={<Loading rows={5} />}>{children}</Suspense>;
}

const router = createBrowserRouter(
  createRoutesFromElements(
    <>
      <Route path="/" element={<Root />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/tv" element={<Suspense fallback={<Splash />}><TvPage /></Suspense>} />
      <Route path="/b/:slug" element={<Suspense fallback={<Splash />}><BookPage /></Suspense>} />
      <Route path="/t/:token" element={<Suspense fallback={<Splash />}><TicketPage /></Suspense>} />
      <Route element={<RequireAuth />}>
        <Route path="/setup" element={<SetupCentre />} />
        <Route path="/s/:slug" element={<CentreLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="floor" element={<Allow perm="floor.operate"><FloorPage /></Allow>} />
          <Route path="bookings" element={<Allow perm="floor.operate"><BookingsPage /></Allow>} />
          <Route path="designer" element={<Allow perm="floor.design"><DesignerPage /></Allow>} />
          <Route path="prices" element={<Allow><PricesPage /></Allow>} />
          <Route path="bills" element={<Allow perm="billing.create"><BillsPage /></Allow>} />
          <Route path="bills/:billId" element={<Allow><BillPage /></Allow>} />
          <Route path="shift" element={<Allow perm="floor.operate"><ShiftPage /></Allow>} />
          <Route path="customers" element={<Allow><CustomersPage /></Allow>} />
          <Route path="customers/:customerId" element={<Allow><CustomerDetail /></Allow>} />
          <Route path="snacks" element={<Allow><InventoryPage /></Allow>} />
          <Route path="expenses" element={<Allow perm="expenses.manage"><ExpensesPage /></Allow>} />
          <Route path="team" element={<Allow><TeamPage /></Allow>} />
          <Route path="settings" element={<Allow><SettingsPage /></Allow>} />
          <Route path="*" element={<Empty title="Page not found" />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </>,
  ),
  { basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/' },
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
