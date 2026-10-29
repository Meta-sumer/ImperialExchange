import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { useThemeStore } from '../store/theme';
import { useSelectedAccount } from '../store/selectedAccount';
import SearchModal from './SearchModal';
import InstrumentStrip from './InstrumentStrip';
import BrandLogo from './BrandLogo';
import NotificationCenter from './NotificationCenter';
import CmsFooter from './CmsFooter';
import { api } from '../services/api';
import { wsClient } from '../services/ws';
import { useFxRate } from '../hooks/useFxRate';
import useFloatingBalance from '../hooks/useFloatingBalance';
import { useDisplayCurrency } from '../store/displayCurrency';
import { useDisplayRates } from '../hooks/useDisplayRates';
import { fmtNum } from '../utils/format';
import { accountTierLabel } from '../utils/accountTypes';

// Inline SVG icons — kept inline so we don't pull in another icon library.
const Icon = ({ d, size = 18, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
    {Array.isArray(d) ? d.map((path, i) => <path key={i} d={path} />) : <path d={d} />}
  </svg>
);
const I = {
  search:   <Icon d={['M21 21l-4.35-4.35', 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16z']} />,
  bell:     <Icon d={['M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.73 21a2 2 0 0 1-3.46 0']} />,
  chevron:  <Icon d="M6 9l6 6 6-6" />,
  wallet:   <Icon d={['M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1', 'M16 12h4']} />,
  reports:  <Icon d={['M9 12h6', 'M9 16h6', 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6']} />,
  help:     <Icon d={['M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z', 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01']} />,
  settings: <Icon d={['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z']} />,
  logout:   <Icon d={['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9']} />,
  user:     <Icon d={['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z']} />,
  menu:     <Icon d={['M3 12h18', 'M3 6h18', 'M3 18h18']} />,
  close:    <Icon d={['M18 6L6 18', 'M6 6l12 12']} />,
};

// Primary top-nav categories — sit in the brand header.
const PRIMARY_NAV = [
  { to: '/explore', label: 'Explore' },
  { to: '/watchlist', label: 'Watchlist' },
  { to: '/dashboard', label: 'Portfolio' },
  { to: '/wallet', label: 'Wallets' },
  { to: '/copy-trading', label: 'Copy Trading' },
];

// Secondary nav was removed — these destinations now live in Explore's
// "Products & Tools" section instead. Kept as an empty array so the
// mobile flyout spread (`...SECONDARY_NAV`) and any other consumers
// don't need a conditional.
const SECONDARY_NAV = [];

// Mobile flyout only.
//
// On desktop the positions panel is already on screen — the Explore right
// rail shows it, and the Terminal has it permanently — so a header link
// would be redundant and cost a slot in a full header. On mobile there is no
// right rail and the terminal is several taps away, which is the case this
// entry exists for.
const MOBILE_ONLY_NAV = [{ to: '/positions', label: 'Positions' }];

// Ordered mobile list: Positions sits with the other "my money"
// destinations rather than being appended after Copy Trading.
const MOBILE_NAV = (() => {
  const i = PRIMARY_NAV.findIndex((x) => x.to === '/dashboard');
  const at = i < 0 ? PRIMARY_NAV.length : i + 1;
  return [...PRIMARY_NAV.slice(0, at), ...MOBILE_ONLY_NAV, ...PRIMARY_NAV.slice(at), ...SECONDARY_NAV];
})();

export default function Layout({ children }) {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [profileOpen, setProfileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const profileRef = useRef(null);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);

  // Click-outside for the profile menu — keeps the dropdown lightweight
  // without bringing in a popover library.
  useEffect(() => {
    if (!profileOpen) return;
    const onDoc = (e) => {
      if (profileRef.current && !profileRef.current.contains(e.target)) {
        setProfileOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [profileOpen]);

  // Always reopen the profile menu with the account list collapsed.
  useEffect(() => { if (!profileOpen) setAcctSwitchOpen(false); }, [profileOpen]);

  // Collapse menus on route change so the menu doesn't linger after nav.
  useEffect(() => {
    setProfileOpen(false);
  }, [location.pathname]);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  // Global ⌘/Ctrl+K to open the search modal. "/" also opens unless the user
  // is typing in a real input — matches Groww/GitHub/Linear muscle memory.
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (e.key === '/' && !mod) {
        const tag = (e.target?.tagName || '').toLowerCase();
        const isEditable = tag === 'input' || tag === 'textarea' || e.target?.isContentEditable;
        if (!isEditable) {
          e.preventDefault();
          setSearchOpen(true);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Trader';
  const initials = (fullName || 'T').split(' ').map((s) => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

  // Total REAL balance — sums the live free balance across every REAL
  // account the user owns (DEMO/VIRTUAL excluded). Re-fetched on any
  // 'wallet' WS event so deposits/withdrawals propagate to the chip in
  // real time. Currency is taken from the first REAL account; if you
  // have REAL accounts in mixed currencies this still shows the sum
  // (assumes the accountant view is roughly base-currency normalised).
  // Per-account real balances kept as {currency, free} parts so each is
  // FX-converted to USD at render time before summing. Raw-summing mixed
  // INR + USD accounts (and labelling the total with the first account's
  // currency) was the balance-mismatch bug — a USD account's $89.61 showed
  // up as "₹89.61" and then "$0.93".
  const [realParts, setRealParts] = useState(null); // null = loading, [] = no real accounts
  // Ref so the profile-menu poll (below) can re-run the same loader.
  const loadEquityRef = useRef(null);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      try {
        // FLOATING balance per account (equity = realized balance + Σ open-position
        // uPnL). The profile "Balance" shows this live figure — what the user would
        // have if they closed now — NOT the fixed realized balance (that stays in the
        // terminal footer "Balance" + transaction history). Each row carries
        // { accountId, currency, balance, equity, unrealizedPnl, free }.
        const { data } = await api.get('/wallet/equity');
        if (cancelled) return;
        setRealParts(data?.data || []);
      } catch (_) { /* keep prior */ }
    };
    loadEquityRef.current = load;
    load();
    const u1 = wsClient.subscribe('user:wallet', load);
    const u2 = wsClient.subscribe('user:positions', load); // open/close moves equity
    return () => { cancelled = true; u1 && u1(); u2 && u2(); loadEquityRef.current = null; };
  }, [user]);

  // While the profile menu is open, refresh the floating balance every few
  // seconds so live P&L ticks (position WS events fire on open/close, not on
  // every price move). No background cost while the menu is closed.
  useEffect(() => {
    if (!profileOpen || !user) return;
    loadEquityRef.current && loadEquityRef.current();
    const id = setInterval(() => { loadEquityRef.current && loadEquityRef.current(); }, 5000);
    return () => clearInterval(id);
  }, [profileOpen, user]);

  // ── Active-account switcher (shared with the Trade terminal) ──────────
  // The full account list drives the "Switch account" section in the profile
  // menu. Selecting one writes the shared store, so the Trade page's
  // positions/orders/balances re-scope to it instantly.
  const selectedAccountId = useSelectedAccount((s) => s.accountId);
  const setSelectedAccountId = useSelectedAccount((s) => s.setAccountId);
  // REAL-TIME floating balance for the CURRENTLY SELECTED account — recomputed
  // on every price tick (not just on open/close). Keyed on the account id, so
  // switching accounts re-scopes cleanly and account A's ticks never leak into
  // account B's number. Returns rows shaped like /wallet/equity, or null loading.
  const liveSelRows = useFloatingBalance(selectedAccountId);
  const [accountList, setAccountList] = useState([]);
  // The account list is collapsed by default — it opens only when the user
  // clicks the "Switch account" row, so the profile menu stays compact.
  const [acctSwitchOpen, setAcctSwitchOpen] = useState(false);
  const formatAccountLabel = (a) => {
    if (!a) return '';
    const type = String(a.accountType || '').toUpperCase();
    return a.nickname || a.label || a.name ||
      (type ? type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Account');
  };
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const loadAccounts = async () => {
      try {
        const { data } = await api.get('/user/accounts');
        if (cancelled) return;
        const list = data?.data || [];
        setAccountList(list);
        // Seed a default selection if none is set yet (first account) — keeps
        // the menu's active highlight and the Trade page in agreement.
        if (!selectedAccountId && list.length) setSelectedAccountId(list[0]._id);
        // If the saved selection no longer exists, snap to the first account.
        else if (selectedAccountId && list.length && !list.some((a) => a._id === selectedAccountId)) {
          setSelectedAccountId(list[0]._id);
        }
      } catch (_) { /* keep prior */ }
    };
    loadAccounts();
    // Refresh the list on wallet events (a new account may have been created).
    const unsub = wsClient.subscribe('user:wallet', loadAccounts);
    return () => { cancelled = true; unsub && unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // ── DISPLAY-CURRENCY conversion (presentation only) ──────────────────
  // The account + wallet stay in USD; the user picks a DISPLAY currency and we
  // convert at render time. Default USD. `rate` (USD→INR) only normalizes any
  // legacy INR-denominated wallet row back to USD before re-converting.
  const fxRate = useFxRate();
  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
  const displayCode = useDisplayCurrency((s) => s.code);
  const setDisplayCode = useDisplayCurrency((s) => s.setCode);
  const { currencies: displayCurrencies, rateFor, symbolFor } = useDisplayRates();
  const displayRate = rateFor(displayCode);      // 1 USD = displayRate <displayCode>
  const displaySymbol = symbolFor(displayCode);

  // Normalize any wallet-row amount → USD (USD as-is; legacy INR ÷ rate; other
  // currencies 1:1, matching the backend), then convert USD → display currency.
  const toUsd = (v, ccy) => {
    const n = Number(v) || 0;
    const c = String(ccy || 'USD').toUpperCase();
    if (c === 'USD') return n;
    if (c === 'INR') return rate > 0 ? n / rate : n;
    return n;
  };
  const toDisplay = (v, ccy) => toUsd(v, ccy) * (displayRate || 1);

  // Prefer the tick-live rows for the selected account; fall back to the polled
  // /wallet/equity snapshot until the live hook has loaded. Both are shaped the same.
  const selBals = liveSelRows != null
    ? liveSelRows
    : (realParts || []).filter((b) => String(b.accountId) === String(selectedAccountId));
  const balLoading = liveSelRows == null && realParts == null;
  // FLOATING balance (USD base) = equity; convert to the display currency.
  const selUsd = selBals.reduce((s, b) => s + toUsd(b.equity ?? b.balance, b.currency), 0);
  const selDisplay = selUsd * (displayRate || 1);
  const balanceLabel = balLoading ? '—' : `${displaySymbol}${fmtNum(selDisplay, 2)}`;
  // Show the USD base as a subline whenever the display currency isn't USD.
  const balanceSubLabel = balLoading || displayCode === 'USD' ? '' : `≈ $${fmtNum(selUsd, 2)} USD`;
  // Per-account floating balance (display currency) for the switch-account rows.
  const acctDisplay = new Map();
  for (const b of (realParts || [])) {
    acctDisplay.set(String(b.accountId), (acctDisplay.get(String(b.accountId)) || 0) + toDisplay(b.equity ?? b.balance, b.currency));
  }

  const isActive = (to) => location.pathname === to;

  return (
    <div className="min-h-screen bg-white text-text-primary flex flex-col overflow-x-clip">
      {/* ── Primary header — logo, primary nav, search, bell, profile.
          Hidden entirely on /trade so the terminal owns the full viewport. */}
      <header className={`${location.pathname === '/trade' ? 'hidden' : 'sticky top-0 z-40 bg-white border-b border-border-dark'}`}>
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 h-20 flex items-center gap-4">
          {/* Brand — the full Imperial Exchange lockup image (icon + wordmark + tagline). */}
          <Link to="/explore" className="flex items-center shrink-0">
            {/* 64px tall renders 183px WIDE at the 2500/874 lockup aspect — a quarter
                of the header on a 768px tablet, where all six nav items still
                have to fit. BrandLogo sets its height inline, so the important
                modifier is what overrides it; lg restores the desktop size. */}
            <BrandLogo size={64} className="shrink-0 !h-11 lg:!h-16" />
          </Link>

          {/* Primary nav — pill-style highlight (matches mobile flyout). min-w-0
              + overflow-x-auto so on a tight width (e.g. mobile "Desktop site")
              the nav scrolls internally instead of shoving the right cluster
              (bell + profile) off-screen where the root's overflow-x-clip hides it. */}
          <nav className="hidden md:flex items-center gap-1 ml-4 min-w-0 overflow-x-auto no-scrollbar">
            {PRIMARY_NAV.map((item) => (
              <NavLink
                key={item.label}
                to={item.to}
                className={({ isActive: a }) =>
                  `relative px-3 py-2 rounded-lg text-sm font-semibold transition-colors inline-flex items-center gap-1.5 ${
                    a ? 'bg-primary-500/10 text-primary-600' : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                  }`
                }
              >
                {item.label}
                {item.badge && (
                  <span className="text-[9px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary-500 text-white">
                    {item.badge}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>

          {/* Search trigger — Groww-style input pill with the Ctrl+K hint
              sitting RIGHT-aligned inside, not as a separate badge. */}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="Open search"
            className="hidden lg:flex flex-1 min-w-0 max-w-md ml-auto items-center gap-3 overflow-hidden bg-white hover:bg-bg-card border border-border-dark rounded-full px-4 py-2 text-sm text-text-muted transition-colors"
          >
            <span className="text-text-muted">{I.search}</span>
            <span className="flex-1 min-w-0 text-left truncate">Search markets…</span>
            <span className="hidden lg:inline text-[11px] text-text-muted font-medium">
              Ctrl+K
            </span>
          </button>

          {/* Right cluster — mobile search + terminal CTA + theme + bell + profile.
              shrink-0 so it's NEVER pushed off-screen (the root clips overflow). */}
          <div className="flex items-center gap-2 ml-auto lg:ml-0 shrink-0">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label="Open search"
              className="lg:hidden p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              {I.search}
            </button>
            {/* Terminal CTA — simple bordered button matching the
                old secondary-nav style. Trade page auto-enters
                fullscreen on the `?view=terminal` query flag.
                Hidden on mobile — burger menu has the regular Trade
                entry. */}
            <Link
              to="/trade?view=terminal"
              title="Open trading terminal"
              className="hidden sm:inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border-dark hover:border-primary-500/50 hover:bg-primary-500/5 text-text-primary text-[13px] font-medium transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 4h6v6H4z" />
                <path d="M14 4h6v6h-6z" />
                <path d="M4 14h6v6H4z" />
                <path d="M14 14h6v6h-6z" />
              </svg>
              {/* The icon carries it at tablet width; the word costs ~60px. */}
              <span className="hidden lg:inline">Terminal</span>
            </Link>
            <button
              type="button"
              onClick={toggleTheme}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              aria-label="Toggle theme"
              className="p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              {theme === 'dark' ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
              )}
            </button>
            <NotificationCenter />

            <div className="relative" ref={profileRef}>
              <button
                type="button"
                onClick={() => setProfileOpen((o) => !o)}
                className="group flex items-center gap-2 p-1 pr-1.5 rounded-full hover:bg-bg-hover transition-all"
                aria-haspopup="true"
                aria-expanded={profileOpen}
              >
                <span className="relative shrink-0">
                  <span
                    className="w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-bold tracking-wide ring-2 ring-white transition-shadow group-hover:ring-primary-500/30"
                    style={{
                      background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 55%, #1E3A8A 100%)',
                      boxShadow: '0 2px 8px rgba(29, 78, 216, 0.35)',
                      color: '#FFFFFF',
                    }}
                  >
                    {initials}
                  </span>
                  {/* Online status dot — green with a white ring so it pops
                      against any background. */}
                  <span
                    className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full ring-2 ring-white"
                    style={{ background: '#16A34A' }}
                    title="Online"
                  />
                </span>
                <span className="hidden sm:inline text-text-muted group-hover:text-text-primary transition-colors">
                  {I.chevron}
                </span>
              </button>

              {profileOpen && (
                <div
                  className="absolute right-0 mt-2 w-72 z-50 bg-white border border-border-dark rounded-xl shadow-elevated overflow-hidden"
                  role="menu"
                >
                  <div className="px-4 py-3 border-b border-border-subtle">
                    <div className="text-sm font-semibold text-text-primary truncate">{fullName}</div>
                    <div className="text-xs text-text-muted truncate">{user?.email || ''}</div>
                  </div>

                  {/* Switch account — collapsed by default; clicking the row
                      opens the list. Shares the same store as the Trade
                      terminal, so picking one here re-scopes the Trade page's
                      positions / orders / balances to that account instantly. */}
                  {accountList.length > 0 && (
                    <div className="border-b border-border-subtle">
                      <button
                        type="button"
                        onClick={() => setAcctSwitchOpen((o) => !o)}
                        className="w-full flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-bg-hover transition-colors"
                        role="menuitem"
                        aria-expanded={acctSwitchOpen}
                      >
                        <div className="flex items-center gap-3 min-w-0 text-sm text-text-primary">
                          <span className="text-text-muted">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>
                          </span>
                          <div className="min-w-0">
                            <div className="font-medium">Switch account</div>
                            <div className="text-[10px] text-text-muted truncate">
                              {formatAccountLabel(accountList.find((a) => a._id === selectedAccountId)) || 'Select an account'}
                            </div>
                          </div>
                        </div>
                        <span className={`text-text-muted transition-transform ${acctSwitchOpen ? 'rotate-180' : ''}`}>
                          {I.chevron}
                        </span>
                      </button>
                      {acctSwitchOpen && (
                      <div className="px-2 pb-2 max-h-52 overflow-y-auto flex flex-col gap-0.5">
                        {accountList.map((a) => {
                          const type = String(a.accountType || '').toUpperCase();
                          const isDemo = type === 'DEMO' || type === 'VIRTUAL';
                          const active = a._id === selectedAccountId;
                          const label = a.nickname || a.label || a.name ||
                            (type ? type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Account');
                          return (
                            <button
                              key={a._id}
                              type="button"
                              onClick={() => { setSelectedAccountId(a._id); setProfileOpen(false); }}
                              className={`w-full flex items-center justify-between gap-2 px-2 py-2 rounded-lg text-left transition-colors ${active ? 'bg-primary-500/10' : 'hover:bg-bg-hover'}`}
                              role="menuitem"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${active ? 'bg-primary-500' : 'bg-border-dark'}`} />
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-sm font-medium text-text-primary truncate">{label}</span>
                                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${isDemo ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
                                      {isDemo ? 'DEMO' : 'LIVE'}
                                    </span>
                                  </div>
                                  <div className="text-[10px] text-text-muted truncate">
                                    {[a.baseCurrency || 'USD', a.accountNumber, accountTierLabel(a)].filter(Boolean).join(' · ')}
                                  </div>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 flex-shrink-0">
                                {acctDisplay.has(String(a._id)) && (
                                  <span className="text-[11px] font-bold text-text-primary font-mono tabular-nums" title="Floating balance (incl. open P&L)">
                                    {displaySymbol}{fmtNum(acctDisplay.get(String(a._id)), 2)}
                                  </span>
                                )}
                                {active && (
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary-500">
                                    <path d="M20 6L9 17l-5-5" />
                                  </svg>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      )}
                    </div>
                  )}

                  <div
                    className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-bg-hover transition-colors"
                    title="Selected account floating balance (real-time)"
                  >
                    <Link to="/wallet" className="flex items-center gap-3 text-sm text-text-primary" role="menuitem">
                      <span className="text-text-muted">{I.wallet}</span>
                      Balance
                    </Link>
                    <div className="flex items-center gap-2">
                      <div className="text-right">
                        <div className="text-xs font-bold text-text-primary font-mono tabular-nums">{balanceLabel}</div>
                        {balanceSubLabel && (
                          <div className="text-[10px] font-mono text-text-muted">{balanceSubLabel}</div>
                        )}
                      </div>
                      {/* DISPLAY-currency selector — presentation only. The account
                          + wallet stay in USD; this just re-converts what's shown. */}
                      <select
                        value={displayCode}
                        onChange={(e) => setDisplayCode(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label="Display currency"
                        className="text-[11px] font-semibold bg-bg-hover border border-border-subtle rounded px-1.5 py-1 text-text-primary cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary-500"
                      >
                        {(displayCurrencies && displayCurrencies.length ? displayCurrencies : [{ code: 'USD' }]).map((c) => (
                          <option key={c.code} value={c.code}>{c.code}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <Link
                    to="/reports"
                    className="flex items-center gap-3 px-4 py-2.5 text-sm text-text-primary hover:bg-bg-hover transition-colors"
                    role="menuitem"
                  >
                    <span className="text-text-muted">{I.reports}</span>
                    Reports
                  </Link>

                  <Link
                    to="/helpdesk"
                    className="flex items-center gap-3 px-4 py-2.5 text-sm text-text-primary hover:bg-bg-hover transition-colors"
                    role="menuitem"
                  >
                    <span className="text-text-muted">{I.help}</span>
                    Support
                  </Link>

                  <Link
                    to="/helpdesk/chat"
                    className="flex items-center gap-3 px-4 py-2.5 text-sm text-text-primary hover:bg-bg-hover transition-colors"
                    role="menuitem"
                  >
                    <span className="text-text-muted">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                    </span>
                    Chat with Support
                  </Link>

                  <Link
                    to="/profile"
                    className="flex items-center gap-3 px-4 py-2.5 text-sm text-text-primary hover:bg-bg-hover transition-colors"
                    role="menuitem"
                  >
                    <span className="text-text-muted">{I.settings}</span>
                    Settings
                  </Link>

                  <button
                    type="button"
                    onClick={handleLogout}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-bear hover:bg-bear/5 transition-colors border-t border-border-subtle"
                    role="menuitem"
                  >
                    <span>{I.logout}</span>
                    Log Out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Horizontal instruments rail — replaces the old secondary
            nav strip. Renders a live, ticker-driven pill for every
            tradable instrument so users can jump straight to /trade
            with one click. Hidden on /trade so the terminal can claim
            the full vertical viewport below the primary header. */}
        {location.pathname !== '/trade' && (
          // Hidden on phones — the instrument rail's pills overflow horizontally
          // and pushed the whole page into a sideways scroll on mobile (mobile
          // already has its own nav strip + search). Shown from sm up, where it's
          // contained (overflow-hidden) so it scrolls within its own rail only.
          <div className="hidden sm:block border-t border-border-subtle bg-bg-card">
            <div className="max-w-[1400px] mx-auto min-w-0 overflow-hidden">
              <InstrumentStrip />
            </div>
          </div>
        )}
      </header>

      {/* ── Mobile nav strip — always visible, horizontal scroll if it
          overflows. Same pill-style active state as the desktop nav so
          users get consistent visual feedback across viewports. */}
      {location.pathname !== '/trade' && (
        <div className="imp-subnav md:hidden sticky top-20 z-30 border-b border-border-dark bg-white max-w-full overflow-hidden">
          <nav className="flex items-center gap-1 px-3 py-2 overflow-x-auto no-scrollbar min-w-0 max-w-full">
            {MOBILE_NAV.map((item, idx) => (
              <NavLink
                key={`${item.to}-${idx}`}
                to={item.to}
                className={({ isActive: a }) =>
                  `shrink-0 px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                    a ? 'bg-primary-500/10 text-primary-600' : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      )}

      {/* ── Main content — Groww-style centered container, white surface.
          /trade is a pro terminal that wants every pixel — it gets a
          thin-padded full-bleed container that uses a flex chain so the
          page locks to exactly (viewport - header) with no overflow.
          Everything else stays at the comfortable 1400px reading width. */}
      <main className={`flex-1 ${location.pathname === '/trade' ? 'flex flex-col overflow-hidden' : ''}`}>
        {location.pathname === '/trade' ? (
          // No padding — Trade page is locked to `h-screen` and applies
          // its own slim `p-2` inner padding.
          <div className="flex-1 flex flex-col min-h-0">{children}</div>
        ) : (
          <>
            {/* overflow-x-CLIP (not hidden): clips horizontal overflow without
                turning this wrapper into a scroll container. `overflow-x: hidden`
                forces overflow-y to compute to `auto`, which makes this the
                nearest scrolling ancestor and breaks every `position: sticky`
                child (e.g. the WalletSidebar). `clip` avoids that. */}
            <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-6 min-w-0 overflow-x-clip">{children}</div>
            {/* CMS-driven footer — links managed entirely from the admin panel. */}
            <CmsFooter />
          </>
        )}
      </main>

      {/* Global search modal — mounted once at the layout level */}
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
