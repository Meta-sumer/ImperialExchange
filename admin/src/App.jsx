import { useEffect, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from './store/auth';
import { canUserAccessPath, roleHome } from './config/roles';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import GlobalAlertPopup from './components/GlobalAlertPopup';

import Login from './pages/Login';

// Every admin page is its own chunk. They were all static imports, so the
// whole panel — 40 pages — downloaded before the login form could paint.
// Login stays eager: it is the first screen a signed-out admin sees, and a
// chunk for it would only add a round-trip.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Portfolio = lazy(() => import('./pages/Portfolio'));
const Users = lazy(() => import('./pages/Users'));
const Accounts = lazy(() => import('./pages/Accounts'));
const Instruments = lazy(() => import('./pages/Instruments'));
const RecommendedMarkets = lazy(() => import('./pages/RecommendedMarkets'));
const MarketExposure = lazy(() => import('./pages/MarketExposure'));
const Orders = lazy(() => import('./pages/Orders'));
const CmsPages = lazy(() => import('./pages/CmsPages'));
const CmsNews = lazy(() => import('./pages/CmsNews'));
const EconomicCalendar = lazy(() => import('./pages/EconomicCalendar'));
const KnowledgeBase = lazy(() => import('./pages/KnowledgeBase'));
const GlobalAlerts = lazy(() => import('./pages/GlobalAlerts'));
const Withdrawals = lazy(() => import('./pages/Withdrawals'));
const Deposits = lazy(() => import('./pages/Deposits'));
const Finance = lazy(() => import('./pages/Finance'));
const Audit = lazy(() => import('./pages/Audit'));
const AuditLog = lazy(() => import('./pages/AuditLog'));
const Reports = lazy(() => import('./pages/Reports'));
const ExecutionStats = lazy(() => import('./pages/ExecutionStats'));
const DataFeeds = lazy(() => import('./pages/DataFeeds'));
const Settings = lazy(() => import('./pages/Settings'));
const Payments = lazy(() => import('./pages/Payments'));
const Plans = lazy(() => import('./pages/Plans'));
const AccountPlans = lazy(() => import('./pages/AccountPlans'));
const SubscriptionWallets = lazy(() => import('./pages/SubscriptionWallets'));
const BonusWallets = lazy(() => import('./pages/BonusWallets'));
const UserTransfers = lazy(() => import('./pages/UserTransfers'));
const Partners = lazy(() => import('./pages/Partners'));
const CreditLedger = lazy(() => import('./pages/CreditLedger'));
const BankAccounts = lazy(() => import('./pages/BankAccounts'));
const Admins = lazy(() => import('./pages/Admins'));
const Managers = lazy(() => import('./pages/Managers'));
const ManagerPermissions = lazy(() => import('./pages/ManagerPermissions'));
const AdminAccess = lazy(() => import('./pages/AdminAccess'));
const Assignments = lazy(() => import('./pages/Assignments'));
const ManagerDashboard = lazy(() => import('./pages/ManagerDashboard'));
const HierarchyTree = lazy(() => import('./pages/HierarchyTree'));
const ManagerChats = lazy(() => import('./pages/ManagerChats'));
const SupportTickets = lazy(() => import('./pages/SupportTickets'));

// Shown while a route chunk is fetched. <100ms warm, <500ms on a cold load.
const RouteFallback = () => (
  <div className="min-h-[60vh] flex items-center justify-center">
    <div className="flex flex-col items-center gap-3">
      <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      <div className="text-xs text-text-muted">Loading…</div>
    </div>
  </div>
);
// Centralized, path-driven role gate. Looks up the current route's allow-list
// from the single source of truth (config/roles) and bounces a disallowed
// role to ITS OWN home — never an error screen. This is what keeps a MANAGER
// off /dashboard (→ /my-users) and admins off super-admin-only pages.
function RoleGate({ children }) {
  const { user } = useAuthStore();
  const { pathname } = useLocation();
  if (!user) return null; // ProtectedRoute handles the unauthenticated case
  // Permission-aware: a manager hitting a disabled module's URL is bounced to
  // their home (403 effect) — direct URL access can't bypass a toggled-off
  // permission. Backend middleware blocks the APIs regardless.
  if (!canUserAccessPath(user, pathname)) {
    return <Navigate to={roleHome(user.role)} replace />;
  }
  return children;
}

// Auth + chrome + role gate, applied uniformly to every protected route.
const wrap = (el) => (
  <ProtectedRoute>
    <Layout>
      <RoleGate>
        <Suspense fallback={<RouteFallback />}>{el}</Suspense>
      </RoleGate>
    </Layout>
  </ProtectedRoute>
);

// Sends a signed-in user to their role home, and a signed-out user to login.
// Used for "/" and any unknown path so nobody ever lands on a page they
// can't use.
function HomeRedirect() {
  const { user, loading } = useAuthStore();
  if (loading) return null;
  return <Navigate to={user ? roleHome(user.role) : '/login'} replace />;
}

export default function App() {
  const { init, refresh } = useAuthStore();
  useEffect(() => { init(); }, []);
  // Apply Manager Access Control changes without a logout: re-pull /auth/me on
  // tab focus and every 60s so toggled permissions / disabled access take
  // effect promptly for a signed-in manager.
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    const id = setInterval(refresh, 60000);
    return () => { window.removeEventListener('focus', onFocus); clearInterval(id); };
  }, [refresh]);

  return (
    <>
    <GlobalAlertPopup />
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<ProtectedRoute><HomeRedirect /></ProtectedRoute>} />

      {/* Operations / money / insights / infra — gated to admins by default
          via ROUTE_ACCESS's DEFAULT_ROUTE_ROLES (managers are bounced home). */}
      <Route path="/dashboard" element={wrap(<Dashboard />)} />
      <Route path="/portfolio" element={wrap(<Portfolio />)} />
      <Route path="/users" element={wrap(<Users />)} />
      <Route path="/accounts" element={wrap(<Accounts />)} />
      <Route path="/instruments" element={wrap(<Instruments />)} />
      <Route path="/recommended-markets" element={wrap(<RecommendedMarkets />)} />
      <Route path="/market-exposure" element={wrap(<MarketExposure />)} />
      <Route path="/orders" element={wrap(<Orders />)} />
      <Route path="/cms-pages" element={wrap(<CmsPages />)} />
      <Route path="/cms-news" element={wrap(<CmsNews />)} />
      <Route path="/economic-calendar" element={wrap(<EconomicCalendar />)} />
      <Route path="/knowledge-base" element={wrap(<KnowledgeBase />)} />
      <Route path="/global-alerts" element={wrap(<GlobalAlerts />)} />
      <Route path="/withdrawals" element={wrap(<Withdrawals />)} />
      <Route path="/deposits" element={wrap(<Deposits />)} />
      <Route path="/finance" element={wrap(<Finance />)} />
      <Route path="/audit-compliance" element={wrap(<Audit />)} />
      <Route path="/audit" element={wrap(<AuditLog />)} />
      <Route path="/reports" element={wrap(<Reports />)} />
      <Route path="/execution" element={wrap(<ExecutionStats />)} />
      <Route path="/data-feeds" element={wrap(<DataFeeds />)} />
      <Route path="/plans" element={wrap(<Plans />)} />
      <Route path="/account-plans" element={wrap(<AccountPlans />)} />
      <Route path="/subscription-wallets" element={wrap(<SubscriptionWallets />)} />
      <Route path="/bonus-wallets" element={wrap(<BonusWallets />)} />
      <Route path="/user-transfers" element={wrap(<UserTransfers />)} />
      <Route path="/partners" element={wrap(<Partners />)} />
      <Route path="/credit" element={wrap(<CreditLedger />)} />
      <Route path="/bank-accounts" element={wrap(<BankAccounts />)} />

      {/* Hierarchy / manager scope — role-gated by ROUTE_ACCESS. */}
      <Route path="/admins" element={wrap(<Admins />)} />
      <Route path="/managers" element={wrap(<Managers />)} />
      <Route path="/assignments" element={wrap(<Assignments />)} />
      <Route path="/hierarchy-tree" element={wrap(<HierarchyTree />)} />
      <Route path="/access-control" element={wrap(<ManagerPermissions />)} />
      <Route path="/admin-access" element={wrap(<AdminAccess />)} />
      <Route path="/my-users" element={wrap(<ManagerDashboard />)} />
      <Route path="/support-chats" element={wrap(<ManagerChats />)} />
      <Route path="/support-tickets" element={wrap(<SupportTickets />)} />

      <Route path="/payments" element={wrap(<Payments />)} />
      <Route path="/settings" element={wrap(<Settings />)} />

      <Route path="*" element={<HomeRedirect />} />
    </Routes>
    </>
  );
}
