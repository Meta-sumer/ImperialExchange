import type {
  AccountMetrics,
  Decimal,
  DashboardSummary,
  Position,
  PositionHistorySummary,
  SeriesBucket,
} from '@/types/trading';
import type { UserAccount } from '@/types/user';
import type { Deposit, LedgerEntry, WalletBalance, WalletTransaction, Withdrawal, CreditTransaction } from '@/types/wallet';
import { isRealMoney } from '@/utils/accountType';
import { fmtMoney, fmtNum } from '@/utils/money';

/**
 * EquityHub's Wallet page rules — client/src/pages/Wallet.jsx (the hub, the
 * Account Details view), components/AccountOverview.jsx,
 * components/TransactionHistory.jsx, components/WalletSidebar.jsx and
 * utils/dateRange.js — as plain functions, so the screens stay layout and
 * every rule can be pinned against the web's own source
 * (__tests__/stage2_walletHub.logic.test.ts).
 *
 * EquityHub is INR-only: every figure here is rupees, summed as numbers.
 *
 * Where this deliberately differs from the web, the function says so:
 *
 *   1. Real money is `isRealMoney` (PORT-RULINGS §3).
 *   2. Trading equity, free/used margin, floating P&L and margin level are
 *      the SERVER's (GET /trading/account-metrics, PORT-RULINGS §1). The web
 *      re-derives them in the page from wallet rows and live ticks.
 *   3. "All Time" in the history filter means all time. The web's
 *      matchesDateRange still applies custom From/To dates that are no
 *      longer on screen once the user switches back to "All Time".
 */

const numOf = (v: Decimal | number | null | undefined): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const numOrNull = (v: Decimal | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const ts = (d: string | null | undefined): number => {
  const t = d ? Date.parse(d) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/* ══ The hub: views, the nav rail, deep links ══════════════════════════ */

/** Every item of the web's wallet rail (WalletSidebar.jsx NAV_ITEMS). */
export type WalletViewId =
  | 'details'
  | 'overview'
  | 'grow'
  | 'withdraw'
  | 'withdrawal-methods'
  | 'transfer'
  | 'bonus'
  | 'history';

/**
 * The items that live inside the Wallet hub (the Bonus Wallet is a page).
 * The retired Main Wallet's item ('subscription') is gone from the rail.
 */
export type WalletHubView = Exclude<WalletViewId, 'bonus'>;

export interface WalletNavItem {
  id: WalletViewId;
  label: string;
  /** Items with their own page navigate instead of switching the view. */
  route: 'BonusWallet' | null;
  /** Withdrawal Methods opens the manager (a modal) instead of a view. */
  opensMethods?: boolean;
}

/** WalletSidebar.jsx NAV_ITEMS, in order and word for word. */
export const WALLET_NAV_ITEMS: readonly WalletNavItem[] = [
  { id: 'details', label: 'Account Details', route: null },
  { id: 'overview', label: 'Account Overview', route: null },
  { id: 'grow', label: 'Deposit Funds', route: null },
  { id: 'withdraw', label: 'Withdraw Funds', route: null },
  { id: 'withdrawal-methods', label: 'Withdrawal Methods', route: null, opensMethods: true },
  { id: 'transfer', label: 'Internal Transfer', route: null },
  { id: 'bonus', label: 'Main Wallet', route: 'BonusWallet' },
  { id: 'history', label: 'Transaction History', route: null },
];

/** The landing view — Wallet.jsx `useState('overview')`. */
export const DEFAULT_WALLET_VIEW: WalletHubView = 'overview';

const HUB_VIEWS: ReadonlySet<string> = new Set(
  WALLET_NAV_ITEMS.filter((i) => i.route === null).map((i) => i.id),
);

export const isHubView = (v: unknown): v is WalletHubView =>
  typeof v === 'string' && HUB_VIEWS.has(v);

/** `/wallet?action=` → the view it opens. */
export const VIEW_FOR_ACTION = {
  deposit: 'grow',
  withdraw: 'withdraw',
  transfer: 'transfer',
} as const satisfies Record<string, WalletHubView>;

/**
 * The view a deep link asks for — Wallet.jsx honours both `?action=` and
 * `?view=<id>` (the sidebar's links). `withdrawal-methods` is returned as
 * is: the hub opens the manager for it rather than switching views.
 * Anything unknown is ignored rather than trusted.
 */
export const deepLinkView = (
  params: { action?: string | null; view?: string | null } | null | undefined,
): WalletHubView | null => {
  const action = params?.action ?? '';
  if (Object.prototype.hasOwnProperty.call(VIEW_FOR_ACTION, action)) {
    return VIEW_FOR_ACTION[action as keyof typeof VIEW_FOR_ACTION];
  }
  const view = params?.view;
  return isHubView(view) ? view : null;
};

/** The Recent Transactions strip sits under every view but the overview. */
export const showsRecentStrip = (view: WalletHubView): boolean => view !== 'overview';

/** On the history view "View All" would point back at itself. */
export const showsViewAll = (view: WalletHubView): boolean => view !== 'history';

/* ══ What the page knows ═══════════════════════════════════════════════ */

/** The hub's own loads (Wallet.jsx load(), the account list aside). */
export type WalletSource =
  | 'balances' | 'deposits' | 'withdrawals' | 'ledger' | 'positions' | 'subscriptions' | 'bonusTx' | 'credit';

/**
 * The sources that have answered at least once. A figure is shown once its
 * source has answered; until then it is a dash — not "₹0.00", which on a
 * money screen reads as "you have nothing".
 */
export type SourceReady = Readonly<Partial<Record<WalletSource, true>>>;

/** Same object when nothing changes, so a re-load does not re-render for nothing. */
export const markReady = (ready: SourceReady, source: WalletSource): SourceReady =>
  (ready[source] ? ready : { ...ready, [source]: true });

/** Each source's latest failure, by source; absent once its latest request succeeded. */
export type SourceErrors = Readonly<Partial<Record<WalletSource, string>>>;

/**
 * Record the outcome of a source's LATEST request: its message, or `null`
 * for a success (which clears an earlier failure). Same object when nothing
 * changes.
 */
export const withSourceError = (
  errors: SourceErrors,
  source: WalletSource,
  message: string | null,
): SourceErrors => {
  if (message === null) {
    if (!(source in errors)) return errors;
    const next: Partial<Record<WalletSource, string>> = { ...errors };
    delete next[source];
    return next;
  }
  return errors[source] === message ? errors : { ...errors, [source]: message };
};

/**
 * Request sequencing per source. Several loads can be in flight at once — a
 * socket nudge, a pull-to-refresh, the return from another screen, a
 * finished deposit — and responses do not come back in the order they were
 * asked for. Only the answer to a source's NEWEST request may land.
 */
export interface SourceSequencer {
  /** Start a request for `source`; the returned check says whether it is still the newest. */
  begin(source: WalletSource): () => boolean;
}

export const createSourceSequencer = (): SourceSequencer => {
  const latest: Partial<Record<WalletSource, number>> = {};
  return {
    begin(source) {
      const mine = (latest[source] ?? 0) + 1;
      latest[source] = mine;
      return () => latest[source] === mine;
    },
  };
};

/**
 * What is known about the account list. An empty list is "no accounts" only
 * once the list has answered: before that it is a guess, and after a failed
 * load it is wrong — telling a user with accounts to create their first one
 * is how a transient 401 turns into a duplicate account.
 */
export type AccountsState = 'loading' | 'error' | 'ready';

export const accountsStateOf = (p: {
  count: number;
  loading: boolean;
  error: string | null | undefined;
  pageLoading: boolean;
}): AccountsState => {
  if (p.count > 0) return 'ready';
  if (p.error) return 'error';
  return p.loading || p.pageLoading ? 'loading' : 'ready';
};

/* ══ Trading figures (the server's) ════════════════════════════════════ */

/** Live accounts — PORT-RULINGS §3; never `accountType === 'REAL'`. */
export const realAccounts = <A extends Pick<UserAccount, 'accountType'>>(accounts: readonly A[]): A[] =>
  accounts.filter((a) => isRealMoney(a.accountType));

export type MetricsById = Readonly<Record<string, AccountMetrics | null | undefined>>;

export interface TradingTotals {
  /**
   * False while any live account's server figures are missing (still
   * loading, or the request failed). A sum over some accounts is not the
   * total, so the screen shows a dash rather than a partial figure.
   */
  complete: boolean;
  balance: number;
  equity: number;
  free: number;
  used: number;
  unrealized: number;
  /**
   * The LOWEST server margin level among live accounts that have margin in
   * use, or null when none does. The web shows one consolidated level,
   * Σequity / Σlocked; margin is called per account, so a pooled ratio can
   * read "Safe" while one account sits at its margin call.
   */
  marginLevel: number | null;
}

export const tradingTotals = (
  accounts: readonly Pick<UserAccount, 'id' | 'accountType'>[],
  metricsById: MetricsById,
): TradingTotals => {
  let complete = true;
  let balance = 0;
  let equity = 0;
  let free = 0;
  let used = 0;
  let unrealized = 0;
  let marginLevel: number | null = null;
  for (const a of realAccounts(accounts)) {
    const m = metricsById[a.id];
    if (!m) { complete = false; continue; }
    balance += numOf(m.balance);
    equity += numOf(m.equity);
    free += numOf(m.freeMargin);
    used += numOf(m.usedMargin);
    unrealized += numOf(m.unrealizedPnl);
    // riskService answers '0' when no margin is in use; only an account with
    // margin in use has a level at all (it may legitimately be ≤ 0).
    if (numOf(m.usedMargin) > 0) {
      const lvl = numOf(m.marginLevel);
      marginLevel = marginLevel === null ? lvl : Math.min(marginLevel, lvl);
    }
  }
  return { complete, balance, equity, free, used, unrealized, marginLevel };
};

export interface MetricsFailure { accountId: string; error: string }

/**
 * Live accounts whose server figures failed and have never arrived — the
 * screen has to say why its trading figures are dashes.
 */
export const metricsFailures = (
  liveIds: readonly string[],
  byAccount: Readonly<Record<string, { metrics: unknown; error: string | null } | undefined>>,
): MetricsFailure[] =>
  liveIds.flatMap((accountId) => {
    const e = byAccount[accountId];
    return e && !e.metrics && e.error ? [{ accountId, error: e.error }] : [];
  });

/** AccountOverview.jsx — "Safe" at or above 100%, "At risk" below. */
export const marginNote = (level: number | null): { label: string; tone: 'bull' | 'bear' } | null =>
  (level === null ? null : level >= 100 ? { label: 'Safe', tone: 'bull' } : { label: 'At risk', tone: 'bear' });

export interface OverviewAccountRow {
  account: UserAccount;
  /** The server's figures, or null until they land. */
  metrics: AccountMetrics | null;
  /** Floating P&L as a share of the balance, or null without figures. */
  pct: number | null;
}

/** "Your Trading Accounts" — live accounts only. */
export const overviewAccountRows = (
  accounts: readonly UserAccount[],
  metricsById: MetricsById,
): OverviewAccountRow[] =>
  realAccounts(accounts).map((account) => {
    const metrics = metricsById[account.id] ?? null;
    if (!metrics) return { account, metrics: null, pct: null };
    const bal = numOf(metrics.balance);
    const pnl = numOf(metrics.unrealizedPnl);
    return { account, metrics, pct: bal > 0 ? (pnl / bal) * 100 : 0 };
  });

/* ══ Deposits and withdrawals ══════════════════════════════════════════ */

const SETTLED = ['CONFIRMED', 'COMPLETED', 'APPROVED'];
const IN_FLIGHT = ['PENDING', 'PROCESSING'];

export const isSettledStatus = (s: unknown): boolean => SETTLED.includes(String(s).toUpperCase());
export const isPendingStatus = (s: unknown): boolean => IN_FLIGHT.includes(String(s).toUpperCase());

export interface MoneyFlows {
  totalDeposits: number;
  totalWithdrawals: number;
  pendingWithdrawals: number;
}

/** AccountOverview.jsx's totals over the real records — rupees, summed. */
export const moneyFlows = (
  deposits: readonly Pick<Deposit, 'status' | 'amount'>[],
  withdrawals: readonly Pick<Withdrawal, 'status' | 'amount'>[],
): MoneyFlows => {
  const sum = (list: readonly { status: string; amount: Decimal }[], keep: (s: string) => boolean): number =>
    list.filter((r) => keep(r.status)).reduce((s, r) => s + numOf(r.amount), 0);
  return {
    totalDeposits: sum(deposits, isSettledStatus),
    totalWithdrawals: sum(withdrawals, isSettledStatus),
    pendingWithdrawals: sum(withdrawals, isPendingStatus),
  };
};

/* ══ Positions, win rate, trades ═══════════════════════════════════════ */

/**
 * "Open Positions — N Winning · M Losing". The sign is the server's floating
 * P&L (PORT-RULINGS §2). A flat position counts as winning, as on the web.
 */
export const openPositionCounts = (
  positions: readonly Pick<Position, 'unrealizedPnl' | 'isBroker'>[],
): { open: number; winning: number; losing: number } => {
  const platform = positions.filter((p) => !p.isBroker);
  const winning = platform.filter((p) => numOf(p.unrealizedPnl) >= 0).length;
  return { open: platform.length, winning, losing: platform.length - winning };
};

/** The dashboard's win rate, else the closed-trade summary's. */
export const overviewWinRate = (
  dashboard: Pick<DashboardSummary, 'pnl'> | null,
  closed: Pick<PositionHistorySummary, 'wins' | 'losses'> | null,
): number | null => {
  const dash = dashboard?.pnl.winRate;
  if (dash !== null && dash !== undefined) return dash;
  if (closed && closed.wins + closed.losses > 0) return (closed.wins / (closed.wins + closed.losses)) * 100;
  return null;
};

export const overviewTotalTrades = (
  closed: Pick<PositionHistorySummary, 'totalTrades'> | null,
  dashboard: Pick<DashboardSummary, 'trades'> | null,
): number => closed?.totalTrades ?? dashboard?.trades.totalLive ?? 0;

/* ══ Performance ═══════════════════════════════════════════════════════ */

/** AccountOverview.jsx — the range dropdown. */
export const PERF_RANGES = [
  { value: '1w', label: 'This Week' },
  { value: '1m', label: 'This Month' },
  { value: '1y', label: 'This Year' },
] as const;
export type PerfRange = (typeof PERF_RANGES)[number]['value'];

/** The headline: the selected series' net profit. */
export const perfNet = (buckets: readonly Pick<SeriesBucket, 'netProfit'>[]): number =>
  buckets.reduce((s, b) => s + (Number(b.netProfit) || 0), 0);

/** …as a share of equity. */
export const perfPct = (net: number, equity: number): number =>
  (equity > 0 ? (net / equity) * 100 : 0);

/** A lifetime-stats window's net. */
export const rangeNet = (s: { netProfit: Decimal } | null | undefined): number =>
  (s ? numOf(s.netProfit) : 0);

/** A percentage with its sign, as AccountOverview prints them: "+1.25%" / "-0.40%". */
export const signedPct = (pct: number): string => `${pct >= 0 ? '+' : ''}${fmtNum(pct, 2)}%`;

/** "↑ +1.25%" / "↓ -0.40%", or null under half a basis point. */
export const trendPct = (pct: number | null | undefined): string | null => {
  if (pct === null || pct === undefined || !(Math.abs(pct) > 0.005)) return null;
  return `${pct >= 0 ? '↑ +' : '↓ '}${fmtNum(pct, 2)}%`;
};

/**
 * The area chart's paths over the buckets' cumulative equity, in a W×H box.
 * Null under two points — "Not enough data yet".
 */
export const areaChartPaths = (
  values: readonly number[],
  W: number,
  H: number,
): { line: string; area: string; positive: boolean } | null => {
  if (values.length < 2) return null;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;
  const x = (i: number): number => (i / (values.length - 1)) * W;
  const y = (v: number): number => H - ((v - min) / span) * H;
  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return { line, area: `${line} L${W},${H} L0,${H} Z`, positive: last >= first };
};

/** Every ceil(n/5)-th bucket label under the chart. */
export const chartLabels = <B extends Pick<SeriesBucket, 'label'>>(buckets: readonly B[]): B[] => {
  const step = Math.ceil(buckets.length / 5);
  return buckets.filter((_, i) => i % step === 0);
};

/* ══ Recent money movements ════════════════════════════════════════════ */

export type MoneyMoveKind = 'deposit' | 'withdraw';

export type MoneyMove =
  | { kind: 'deposit'; row: Deposit }
  | { kind: 'withdraw'; row: Withdrawal };

/**
 * Deposits and withdrawals, newest first (Wallet.jsx keeps 12 for the
 * strip; AccountOverview keeps them all and shows 5 / 8).
 */
export const recentMoves = (
  deposits: readonly Deposit[],
  withdrawals: readonly Withdrawal[],
  limit?: number,
): MoneyMove[] => {
  const all: MoneyMove[] = [
    ...deposits.map((row): MoneyMove => ({ kind: 'deposit', row })),
    ...withdrawals.map((row): MoneyMove => ({ kind: 'withdraw', row })),
  ].sort((a, b) => ts(b.row.createdAt) - ts(a.row.createdAt));
  return limit === undefined ? all : all.slice(0, limit);
};

/**
 * Which wallet a deposit / withdrawal moved — AccountOverview.jsx
 * `walletTypeOf`. 'subscription' is the retired Main Wallet; only old rows
 * carry it.
 */
export const moveWalletLabel = (m: MoneyMove): string => {
  const w = String((m.kind === 'deposit' ? m.row.targetWallet : m.row.source) || 'trading').toLowerCase();
  if (w === 'bonus') return 'Main Wallet';
  if (w === 'subscription') return MAIN_WALLET_CLOSED;
  return 'Trading Account';
};

/** The strip's method column, capitalised like its CSS `capitalize`. */
export const recentMethodText = (method: string | null | undefined): string => {
  if (!method) return '—';
  return method.replace(/(^|\s)(\S)/g, (_m, sp: string, ch: string) => `${sp}${ch.toUpperCase()}`);
};

/** The strip's Transaction ID — the last twelve characters of the record id. */
export const shortTxId = (id: string | null | undefined): string => (id ? id.slice(-12) : '—');

/** AccountOverview TxStatus — CONFIRMED reads "Success", the rest are title-cased. */
export const txStatusLabel = (status: string | null | undefined): string => {
  const s = String(status || '').toUpperCase();
  return s === 'CONFIRMED' ? 'Success' : s.charAt(0) + s.slice(1).toLowerCase();
};

/** The hexes AccountOverview / TransactionHistory paint each status in. */
export interface StatusColors { dot: string; fg: string }

const SLATE: StatusColors = { dot: '#64748B', fg: '#475569' };
const STATUS_COLORS: Readonly<Record<string, StatusColors>> = {
  COMPLETED: { dot: '#16A34A', fg: '#15803D' },
  CONFIRMED: { dot: '#16A34A', fg: '#15803D' },
  APPROVED: { dot: '#16A34A', fg: '#15803D' },
  PROCESSING: { dot: '#2563EB', fg: '#1D4ED8' },
  PENDING: { dot: '#D97706', fg: '#B45309' },
  // Credit transactions (TransactionHistory.jsx StatusPill): part-paid is in progress, settled is done.
  PARTIALLY_SETTLED: { dot: '#2563EB', fg: '#1D4ED8' },
  SETTLED: { dot: '#16A34A', fg: '#15803D' },
  REJECTED: { dot: '#DC2626', fg: '#B91C1C' },
  CANCELLED: SLATE,
};

export const statusColors = (status: string | null | undefined): StatusColors =>
  STATUS_COLORS[String(status || '').toUpperCase()] ?? SLATE;

/** TransactionHistory.jsx STATUS_COLOR — the Status filter's leading dot. */
const STATUS_DOT: Readonly<Record<string, string>> = {
  COMPLETED: '#16A34A',
  CONFIRMED: '#16A34A',
  APPROVED: '#16A34A',
  DONE: '#16A34A',
  PROCESSING: '#2563EB',
  PENDING: '#D97706',
  PARTIALLY_SETTLED: '#2563EB',
  SETTLED: '#16A34A',
  REJECTED: '#DC2626',
  CANCELLED: '#94A3B8',
};

export const statusDotColor = (status: string | null | undefined): string =>
  STATUS_DOT[String(status).toUpperCase()] ?? '#94A3B8';

/** Wallet.jsx StatusBadge — the strip's own palette. */
const STRIP_STATUS: Readonly<Record<string, StatusColors>> = {
  PENDING: { dot: '#3B82F6', fg: '#1D4ED8' },
  APPROVED: { dot: '#3B82F6', fg: '#1D4ED8' },
  PROCESSING: { dot: '#3B82F6', fg: '#1D4ED8' },
  CONFIRMED: { dot: '#10B981', fg: '#047857' },
  COMPLETED: { dot: '#10B981', fg: '#047857' },
  SETTLED: { dot: '#10B981', fg: '#047857' },
  PARTIALLY_SETTLED: { dot: '#3B82F6', fg: '#1D4ED8' },
  REJECTED: { dot: '#EF4444', fg: '#B91C1C' },
  CANCELLED: { dot: '#6B7280', fg: '#4B5563' },
};

export const stripStatusColors = (status: string | null | undefined): StatusColors | null =>
  STRIP_STATUS[String(status || '')] ?? null;

/* ══ Dates ═════════════════════════════════════════════════════════════ */

/**
 * `toLocaleString`, guarded. Dates use the device's locale and time zone
 * (PORT-RULINGS §5); `locale` is only for tests that compare with the web's
 * hard-coded one.
 */
const localeString = (d: Date, locale: string | undefined, opts: Intl.DateTimeFormatOptions): string => {
  try {
    return d.toLocaleString(locale, opts);
  } catch {
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }
};

const upperMeridiem = (s: string): string => s.replace(/\b(am|pm)\b/i, (x) => x.toUpperCase());

const validDate = (value: string | number | Date | null | undefined): Date | null => {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** TransactionHistory.jsx fmtDateTime — "13 Jul 2026, 10:09:36 PM". */
export const fmtTxnDateTime = (value: string | number | Date | null | undefined, locale?: string): string => {
  const d = validDate(value);
  if (!d) return '-';
  return upperMeridiem(localeString(d, locale, {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  }));
};

/** AccountOverview.jsx fmtDT — "13 Jul 2026, 10:09 PM". */
export const fmtOverviewDateTime = (value: string | number | Date | null | undefined, locale?: string): string => {
  const d = validDate(value);
  if (!d) return '-';
  return upperMeridiem(localeString(d, locale, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
  }));
};

/** Wallet.jsx fmtDate — the web pins 'en-IN'; the device's own locale here. */
export const fmtLocalDateTime = (value: string | number | Date | null | undefined, locale?: string): string => {
  const d = validDate(value);
  if (!d) return '-';
  return localeString(d, locale, {});
};

/* ══ Account Details ═══════════════════════════════════════════════════ */

/** Wallet.jsx AccountDetailsView `fullName`. */
export const fullNameOf = (user: { firstName?: string | null; lastName?: string | null } | null | undefined): string =>
  [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Trader';

/** The avatar's initials. */
export const initialsOf = (name: string | null | undefined): string =>
  (name || 'T').split(' ').map((s) => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

/** The KYC pill. */
export const kycMeta = (status: string | null | undefined): { tint: string; label: string } => {
  const kyc = status || 'NOT_STARTED';
  if (kyc === 'APPROVED') return { tint: '#16A34A', label: 'Verified' };
  if (kyc === 'PENDING') return { tint: '#3B82F6', label: 'Under Review' };
  return { tint: '#DC2626', label: 'Not verified' };
};

/** A rename just saved wins until the refetch lands. */
export const accountDisplayName = (
  a: Pick<UserAccount, 'id' | 'nickname' | 'accountNumber'>,
  overrides: Readonly<Record<string, string>>,
): string => overrides[a.id] ?? (a.nickname || a.accountNumber);

/** The card's two-letter tile. */
export const accountTile = (displayName: string | null | undefined): string =>
  (displayName || 'A').slice(0, 2).toUpperCase();

/** Over the plan's account cap. */
export const isSuspendedAccount = (a: Pick<UserAccount, 'planSuspendedAt'>): boolean => !!a.planSuspendedAt;

/**
 * An account's balance across its wallet rows — Wallet.jsx
 * `accountTotalUsd(balances, a._id, 'balance')`, a plain rupee sum.
 */
export const accountBalance = (
  balances: readonly Pick<WalletBalance, 'accountId' | 'balance'>[],
  accountId: string,
): number =>
  balances
    .filter((b) => String(b.accountId) === String(accountId))
    .reduce((s, b) => s + numOf(b.balance), 0);

/* ══ Transaction history (TransactionHistory.jsx) ══════════════════════ */

const METHOD_LABEL: Readonly<Record<string, string>> = {
  UPI: 'UPI',
  BANK: 'Bank Transfer',
  CRYPTO: 'Crypto',
  CARD: 'Card',
  RAZORPAY: 'Razorpay',
  DEMO: 'Wallet Balance',
  MANUAL: 'Manual',
};

const LEDGER_TYPE: Readonly<Record<string, string>> = {
  TRADE_OPEN: 'Trade Open',
  TRADE_CLOSE: 'Trade Close',
  FEE: 'Fee',
  ADJUSTMENT: 'Adjustment',
  TRANSFER: 'Internal Transfer',
  INTERNAL_TRANSFER_OUT: 'Transfer Sent',
  INTERNAL_TRANSFER_IN: 'Transfer Received',
  DEPOSIT: 'Deposit',
  WITHDRAWAL: 'Withdrawal',
  CONVERSION: 'Conversion',
};

/** TransactionHistory.jsx BONUS_REASON_LABEL. */
const BONUS_REASON_LABEL: Readonly<Record<string, string>> = {
  REFERRAL_COMMISSION: 'Referral Commission',
  REFERRAL_DEPOSIT_BONUS: 'Referral Deposit Bonus',
  PARTNER_COMMISSION: 'Partner Commission',
  REVENUE_SHARE: 'Revenue Share',
  DEPOSIT_BONUS: 'Deposit Bonus',
  ADMIN_CREDIT: 'Main Wallet Credit',
  ADMIN_DEBIT: 'Main Wallet Debit',
  DEPOSIT: 'Main Wallet Deposit',
  WITHDRAWAL: 'Main Wallet Withdrawal',
  REFUND: 'Main Wallet Refund',
  TRANSFER_IN: 'Transfer to Main Wallet',
  TRANSFER_OUT: 'Transfer to Wallet',
  COPY_PERFORMANCE_FEE: 'Copy Trading Commission',
  // Plans are billed from the Bonus Wallet.
  SUBSCRIPTION_CHARGE: 'Subscription Charge',
  RENEWAL: 'Subscription Renewal',
};

/** The plan-billing reasons (TransactionHistory.jsx PLAN_REASONS). */
const PLAN_REASONS: readonly string[] = ['SUBSCRIPTION_CHARGE', 'RENEWAL'];

/**
 * The retired Main Wallet's name in history: its old rows still show,
 * read-only, under it (TransactionHistory.jsx MAIN_CLOSED).
 */
export const MAIN_WALLET_CLOSED = 'Old Main Wallet (closed)';

/** TransactionHistory.jsx SUB_REASON_LABEL — the old Main Wallet rows. */
const SUB_REASON_LABEL: Readonly<Record<string, string>> = {
  SUBSCRIPTION_CHARGE: 'Subscription Charge',
  RENEWAL: 'Subscription Renewal',
  ADMIN_DEBIT: 'Subscription Debit',
  DEPOSIT: 'Subscription Deposit',
  ADMIN_CREDIT: 'Subscription Credit',
  REFUND: 'Subscription Refund',
  WITHDRAWAL: 'Subscription Withdrawal',
};

export const methodLabel = (m: string | null | undefined): string =>
  METHOD_LABEL[String(m || '').toUpperCase()] ?? (m ? String(m) : 'System');

/** TXN-XXXXXXXXXXXX. */
export const txnDisplayId = (raw: string | null | undefined): string =>
  `TXN-${String(raw || '').slice(-12).toUpperCase().padStart(12, '0')}`;

/** utils/ticket.js ticketShort — `#69EBF9`, the one rendering of an order id. */
export const ticketShort = (id: string | null | undefined, fallback = '—'): string =>
  (id ? `#${String(id).slice(-6).toUpperCase()}` : fallback);

export type HistoryKind = 'deposit' | 'withdrawal' | 'ledger' | 'subscription' | 'bonus' | 'credit';
/** Which wallet a row belongs to — the Accounts filter's `wallet:` choices. */
export type WalletScope = 'trading' | 'subscription' | 'bonus' | (string & {});

export interface HistoryRow {
  id: string;
  kind: HistoryKind;
  date: string | null;
  /** Signed: money out is negative whatever the record says. */
  amount: number;
  currency: string;
  status: string;
  type: string;
  method: string;
  /** May carry "\n" before a detail, as the web lays it out. */
  receivedFrom: string;
  destination: string;
  description: string;
  accountId: string | null;
  /** The raw ledger type (for the category); null on every other row. */
  ledgerType: string | null;
  /** The record's referenceId — a trade / fee row's order (`rowTicket`). */
  referenceId: string | null;
  /** The wallet's REALIZED balance around the movement, when known. */
  beforeBal: number | null;
  afterBal: number | null;
  walletScope: WalletScope;
  /** A Bonus Wallet row's reason (plan charges count as Subscription); null elsewhere. */
  reason?: string | null;
  category: string;
}

export type RowSansCategory = Omit<HistoryRow, 'category'>;

const flat = (v: unknown): string => String(v ?? '').split('\n').join(' ').trim();

/**
 * A deposit / withdrawal's own description — "Withdrawal via UPI ·
 * ₹5,000.00 · from Standard Account (694807545) · to UPI ID user@ok", and
 * the note after it when there is one.
 */
export const movementDescription = (p: {
  kind: 'deposit' | 'withdrawal';
  method: string;
  amount: Decimal | number | null | undefined;
  account: string;
  counterparty: string;
  note: string | null | undefined;
}): string => {
  const word = p.kind === 'withdrawal' ? 'Withdrawal' : 'Deposit';
  const parts = [`${word} via ${p.method}`];
  const amt = Math.abs(numOf(p.amount));
  if (amt > 0) parts.push(fmtMoney(amt));
  const from = p.kind === 'withdrawal' ? p.account : p.counterparty;
  const to = p.kind === 'withdrawal' ? p.counterparty : p.account;
  if (from) parts.push(`from ${from}`);
  if (to) parts.push(`to ${to}`);
  const built = parts.join(' · ');
  const note = String(p.note ?? '').trim();
  return note ? `${built} · ${note}` : built;
};

/** A ledger row's balance before: `balanceBefore`, else `balanceAfter − signed amount`. */
export const ledgerBefore = (l: Pick<LedgerEntry, 'balanceBefore' | 'balanceAfter' | 'amount'>): number | null => {
  const before = numOrNull(l.balanceBefore);
  if (before !== null) return before;
  const after = numOrNull(l.balanceAfter);
  return after !== null ? after - numOf(l.amount) : null;
};

/** Account id → "Standard Account (694807545)", the label every row names it by. */
export const accountNames = (
  accounts: readonly Pick<UserAccount, 'id' | 'nickname' | 'accountNumber' | 'accountType'>[],
): Map<string, string> => {
  const m = new Map<string, string>();
  for (const a of accounts) {
    const name = a.nickname || a.accountType || 'Account';
    const num = a.accountNumber ? String(a.accountNumber) : '';
    m.set(String(a.id), num && num !== name ? `${name} (${num})` : (num || name));
  }
  return m;
};

export interface BalanceSnap { before: number | null; after: number | null }

/**
 * Realized-balance snapshots for deposit / withdrawal rows, keyed by the
 * record id: the matching trading-wallet DEPOSIT / WITHDRAWAL ledger row,
 * and — for a Main / Bonus payout, which has no ledger row — the wallet
 * debit that funded it (its `referenceId` is the withdrawal's id).
 */
export const balanceSnapshots = (
  ledger: readonly LedgerEntry[],
  walletTxs: readonly WalletTransaction[],
): Map<string, BalanceSnap> => {
  const out = new Map<string, BalanceSnap>();
  for (const e of ledger) {
    if (e.referenceId && (e.type === 'DEPOSIT' || e.type === 'WITHDRAWAL')) {
      out.set(String(e.referenceId), { before: ledgerBefore(e), after: numOrNull(e.balanceAfter) });
    }
  }
  for (const t of walletTxs) {
    // A Bonus Wallet deposit's credit carries the deposit id in `paymentRef`.
    const ref = t.referenceId || (String(t.reason || '').toUpperCase() === 'DEPOSIT' ? t.paymentRef : null);
    if (!ref) continue;
    const after = numOrNull(t.balanceAfter);
    if (after === null) continue;
    const amt = Math.abs(numOf(t.amount));
    const isDebit = String(t.transactionType || '').toUpperCase() === 'DEBIT';
    out.set(String(ref), { before: isDebit ? after + amt : after - amt, after });
  }
  return out;
};

export const normalizeDeposit = (
  d: Deposit,
  snaps: ReadonlyMap<string, BalanceSnap> = new Map(),
  names: ReadonlyMap<string, string> = new Map(),
): RowSansCategory => {
  const method = String(d.method || '').toUpperCase();
  let receivedFrom = 'External';
  if (method === 'UPI') receivedFrom = d.senderUpiId ? `UPI ID\n${d.senderUpiId}` : 'UPI ID';
  else if (method === 'BANK') receivedFrom = 'Bank Account';
  else if (method === 'CRYPTO') receivedFrom = 'Crypto Wallet';
  else if (method === 'CARD') receivedFrom = 'Card';
  const snap = snaps.get(d.id);
  // A deposit credits the wallet it targeted: the TRADING ACCOUNT's wallet
  // unless it was a Bonus Wallet top-up — or an old request for the retired
  // Main Wallet, which is credited to the Bonus Wallet.
  const target = String(d.targetWallet || 'trading').toLowerCase();
  const acct = target === 'bonus' ? 'Main Wallet'
    : target === 'subscription' ? MAIN_WALLET_CLOSED
      : ((d.accountId && names.get(String(d.accountId))) || 'Trading Account');
  return {
    id: d.id,
    kind: 'deposit',
    date: d.createdAt,
    amount: numOf(d.amount),
    currency: d.currency || 'INR',
    status: d.status || 'PENDING',
    type: 'Deposit',
    method: methodLabel(d.method),
    receivedFrom,
    destination: acct,
    description: movementDescription({
      kind: 'deposit', method: methodLabel(d.method), amount: d.amount, account: acct, counterparty: flat(receivedFrom), note: d.note,
    }),
    accountId: d.accountId,
    ledgerType: null,
    referenceId: null,
    beforeBal: snap ? snap.before : null,
    afterBal: snap ? snap.after : null,
    walletScope: String(d.targetWallet || 'trading').toLowerCase(),
  };
};

export const normalizeWithdrawal = (
  w: Withdrawal,
  snaps: ReadonlyMap<string, BalanceSnap> = new Map(),
  names: ReadonlyMap<string, string> = new Map(),
): RowSansCategory => {
  const method = String(w.method || '').toUpperCase();
  let destination = w.destination || 'External';
  if (method === 'UPI') destination = w.upiId ? `UPI ID\n${w.upiId}` : (w.destination || 'UPI ID');
  else if (method === 'BANK') destination = w.destination || 'Bank Account';
  else if (method === 'CRYPTO') destination = w.destination || 'Crypto Wallet';
  const snap = snaps.get(w.id);
  // `source` is the authority on where the money came from: Bonus (and old
  // Main Wallet) payouts carry no accountId.
  const source = String(w.source || 'TRADING').toUpperCase();
  const acct = source === 'SUBSCRIPTION' ? MAIN_WALLET_CLOSED
    : source === 'BONUS' ? 'Main Wallet'
      : ((w.accountId && names.get(String(w.accountId))) || 'Trading Account');
  return {
    id: w.id,
    kind: 'withdrawal',
    date: w.createdAt,
    amount: -Math.abs(numOf(w.amount)),
    currency: w.currency || 'INR',
    status: w.status || 'PENDING',
    type: 'Withdrawal',
    method: methodLabel(w.method),
    receivedFrom: acct,
    destination,
    description: movementDescription({
      kind: 'withdrawal', method: methodLabel(w.method), amount: w.amount, account: acct, counterparty: flat(destination), note: w.note,
    }),
    accountId: w.accountId,
    ledgerType: null,
    referenceId: null,
    beforeBal: snap ? snap.before : null,
    afterBal: snap ? snap.after : null,
    walletScope: String(w.source || 'trading').toLowerCase(),
  };
};

export const normalizeLedger = (
  l: LedgerEntry,
  names: ReadonlyMap<string, string> = new Map(),
): RowSansCategory => {
  const type = LEDGER_TYPE[l.type] ?? (l.type || 'Other');
  const amt = numOf(l.amount);
  const cp = l.counterparty?.name;
  const acct = (l.accountId && names.get(String(l.accountId))) || 'Trading Account';
  let receivedFrom = '-';
  let destination = '-';
  let method = 'System';
  // Every ledger row moves the TRADING ACCOUNT's own wallet: margin is
  // locked, P&L settled, fees charged and transfers land inside it, so the
  // account itself is the source or destination.
  if (l.type === 'TRADE_OPEN') { receivedFrom = acct; destination = 'Locked margin'; }
  else if (l.type === 'TRADE_CLOSE') {
    if (amt >= 0) { receivedFrom = 'Market'; destination = acct; }
    else { receivedFrom = acct; destination = 'Market'; }
  } else if (l.type === 'FEE') { receivedFrom = acct; destination = 'System'; }
  else if (l.type === 'ADJUSTMENT') {
    // A wallet top-up from this account debits it (a refund credits it back).
    const ref = String(l.referenceType || '');
    const other = ref.startsWith('bonus_wallet') ? 'Main Wallet'
      : ref.startsWith('subscription_wallet') ? MAIN_WALLET_CLOSED : 'System';
    if (amt >= 0) { receivedFrom = other; destination = acct; } else { receivedFrom = acct; destination = other; }
  }
  else if (l.type === 'INTERNAL_TRANSFER_OUT') { method = 'Internal'; receivedFrom = acct; destination = cp || 'User Wallet'; }
  else if (l.type === 'INTERNAL_TRANSFER_IN') { method = 'Internal'; receivedFrom = cp || 'User Wallet'; destination = acct; }
  else if (l.type === 'TRANSFER') {
    method = 'Internal';
    receivedFrom = amt >= 0 ? 'Wallet' : acct;
    destination = amt >= 0 ? acct : 'Wallet';
  }
  return {
    id: l.id,
    kind: 'ledger',
    date: l.createdAt,
    amount: amt,
    currency: l.currency || 'INR',
    status: 'COMPLETED',
    type,
    method,
    receivedFrom,
    destination,
    description: l.note || type,
    accountId: l.accountId,
    ledgerType: l.type,
    referenceId: l.referenceId,
    beforeBal: ledgerBefore(l),
    afterBal: numOrNull(l.balanceAfter),
    walletScope: 'trading',
  };
};

const titleCase = (s: string): string =>
  s.split('_').map((x) => x.charAt(0) + x.slice(1).toLowerCase()).join(' ');

/**
 * An old, read-only row of the retired Main Wallet — plan charges, top-ups,
 * refunds — named "Main Wallet (closed)".
 */
export const normalizeSubscription = (t: WalletTransaction): RowSansCategory => {
  const isCredit = t.transactionType === 'CREDIT' || t.transactionType === 'REFUND';
  const amt = (isCredit ? 1 : -1) * Math.abs(numOf(t.amount));
  const reason = String(t.reason || 'SUBSCRIPTION_CHARGE').toUpperCase();
  const type = SUB_REASON_LABEL[reason]
    ?? `Subscription ${reason.replace(/_/g, ' ').toLowerCase()}`.replace(/\b\w/g, (c) => c.toUpperCase());
  const after = numOrNull(t.balanceAfter);
  return {
    id: t.id,
    kind: 'subscription',
    date: t.createdAt,
    amount: amt,
    currency: t.currency || 'INR',
    status: 'COMPLETED',
    type,
    method: MAIN_WALLET_CLOSED,
    receivedFrom: isCredit ? 'Deposit' : MAIN_WALLET_CLOSED,
    destination: isCredit ? MAIN_WALLET_CLOSED : 'Subscription',
    description: t.note || (t.planCode ? `${t.planCode}${t.billingCycle ? ` · ${t.billingCycle}` : ''}` : type),
    accountId: null,
    ledgerType: null,
    referenceId: t.referenceId,
    afterBal: after,
    beforeBal: after !== null ? after - amt : null,
    walletScope: 'subscription',
  };
};

/**
 * A Bonus Wallet transaction — earnings, copy-trading fees and funds added in;
 * plan charges, transfers and withdrawals out.
 */
export const normalizeBonus = (t: WalletTransaction): RowSansCategory => {
  const isCredit = String(t.transactionType).toUpperCase() === 'CREDIT';
  const amt = isCredit ? Math.abs(numOf(t.amount)) : -Math.abs(numOf(t.amount));
  const reason = String(t.reason || (isCredit ? 'BONUS_CREDIT' : 'BONUS_DEBIT')).toUpperCase();
  const type = BONUS_REASON_LABEL[reason] ?? titleCase(reason);
  const isPlan = PLAN_REASONS.includes(reason);
  const ok = String(t.status || 'SUCCESS').toUpperCase() === 'SUCCESS';
  const after = numOrNull(t.balanceAfter);
  return {
    id: t.id,
    kind: 'bonus',
    date: t.createdAt,
    amount: amt,
    currency: t.currency || 'INR',
    status: ok ? 'COMPLETED' : String(t.status).toUpperCase(),
    type,
    method: 'Main Wallet',
    receivedFrom: isCredit ? type : 'Main Wallet',
    destination: isCredit ? 'Main Wallet' : isPlan ? 'Subscription' : (t.note || 'Withdrawal'),
    description: t.note || (isPlan && t.planCode ? `${t.planCode}${t.billingCycle ? ` · ${t.billingCycle}` : ''}` : type),
    accountId: null,
    ledgerType: null,
    referenceId: t.referenceId,
    afterBal: after,
    beforeBal: after !== null ? after - amt : null,
    walletScope: 'bonus',
    reason,
  };
};

/**
 * A deposit or withdrawal the desk processed ON CREDIT (admin → Credit
 * Ledger) — TransactionHistory.jsx normalizeCredit. The wallet moved when
 * the credit was granted (that ledger leg is the row's balance snapshot); the
 * row carries the status and what is still owed until the admin records the
 * payment(s). A deposit credit is money in (the user owes the desk); a
 * withdrawal credit is money out (the desk owes the user).
 */
export const normalizeCredit = (
  c: CreditTransaction,
  snaps: ReadonlyMap<string, BalanceSnap> = new Map(),
  names: ReadonlyMap<string, string> = new Map(),
): RowSansCategory => {
  const isDeposit = c.kind === 'DEPOSIT';
  const gross = Math.abs(numOf(c.amount));
  const amt = isDeposit ? gross : -gross;
  const acct = (c.accountId && names.get(String(c.accountId))) || 'Trading Account';
  const cancelled = String(c.status).toUpperCase() === 'CANCELLED';
  const parts = cancelled
    ? ['Cancelled — wallet movement reversed']
    : [`Settled ${fmtMoney(numOf(c.settledAmount))} of ${fmtMoney(gross)}`, `Outstanding ${fmtMoney(numOf(c.outstanding))}`];
  const remarks = String(c.remarks ?? '').trim();
  if (remarks) parts.push(remarks);
  const snap = snaps.get(c.id);
  return {
    id: c.id,
    kind: 'credit',
    date: c.createdAt,
    amount: amt,
    currency: c.currency || 'INR',
    status: String(c.status || 'PENDING').toUpperCase(),
    type: isDeposit ? 'Credit Deposit' : 'Credit Withdrawal',
    method: 'Credit',
    receivedFrom: isDeposit ? 'Desk (on credit)' : acct,
    destination: isDeposit ? acct : 'Payout (on credit)',
    description: parts.join(' · '),
    accountId: c.accountId,
    ledgerType: null,
    referenceId: null,
    beforeBal: snap ? snap.before : null,
    afterBal: snap ? snap.after : null,
    walletScope: 'trading',
  };
};

/** The full set the Type filter always offers. */
export const TYPE_CATEGORIES: readonly string[] = [
  'Deposit',
  'Withdrawal',
  'Credit',
  'Transfer - Internal',
  'Transfer - External',
  'Transfer - Wallet to Account',
  'Transfer - Account to Wallet',
  'Transfer - Wallet to Wallet',
  'Trade Open',
  'Trade Close',
  'Fee',
  'Commission',
  'Charge',
  'Subscription',
  'Investment',
  'Main Wallet',
  'Referral Commission Earned',
  'Referral Deposit Bonus',
  'Others',
];

/** Every status a row can carry. */
export const ALL_STATUSES: readonly string[] = ['PENDING', 'PROCESSING', 'CONFIRMED', 'APPROVED', 'COMPLETED', 'PARTIALLY_SETTLED', 'SETTLED', 'REJECTED', 'CANCELLED'];

/** Exactly one category per row. */
export const categoryOf = (row: RowSansCategory): string => {
  if (row.kind === 'subscription') return 'Subscription';
  if (row.kind === 'credit') return 'Credit';
  if (row.kind === 'bonus' && PLAN_REASONS.includes(String(row.reason || '').toUpperCase())) return 'Subscription';
  if (row.kind === 'deposit') return 'Deposit';
  if (row.kind === 'withdrawal') return 'Withdrawal';
  const t = row.ledgerType;
  if (t === 'TRANSFER') return 'Transfer - Internal';
  if (t === 'INTERNAL_TRANSFER_OUT' || t === 'INTERNAL_TRANSFER_IN') return 'Transfer - External';
  if (t === 'TRADE_OPEN') return 'Trade Open';
  if (t === 'TRADE_CLOSE') return 'Trade Close';
  if (t === 'FEE') return 'Fee';
  const s = `${row.type} ${row.description}`.toLowerCase();
  if (s.includes('wallet to account')) return 'Transfer - Wallet to Account';
  if (s.includes('account to wallet')) return 'Transfer - Account to Wallet';
  if (s.includes('wallet to wallet')) return 'Transfer - Wallet to Wallet';
  if (s.includes('referral') && s.includes('commission')) return 'Referral Commission Earned';
  if (s.includes('referral') && (s.includes('deposit') || s.includes('bonus'))) return 'Referral Deposit Bonus';
  if (s.includes('commission')) return 'Commission';
  // Main Wallet (internally the Bonus Wallet) movements: the row kind decides,
  // since their labels no longer say "bonus"; a top-up's ledger leg says "main wallet".
  if (row.kind === 'bonus' || s.includes('bonus') || s.includes('main wallet')) return 'Main Wallet';
  if (s.includes('charge')) return 'Charge';
  if (s.includes('invest')) return 'Investment';
  return 'Others';
};

/** A row's order ticket, or null when it carries no reference. */
export const rowTicket = (row: Pick<HistoryRow, 'referenceId'>): string | null =>
  (row.referenceId ? ticketShort(row.referenceId) : null);

/** The description with the order ticket on the front, unless it already names it. */
export const rowDescription = (row: Pick<HistoryRow, 'description' | 'referenceId'>): string => {
  const desc = String(row.description || '').trim();
  const tkt = rowTicket(row);
  if (!tkt || desc.includes(tkt)) return desc;
  return desc ? `order ${tkt} · ${desc}` : `order ${tkt}`;
};

/**
 * One list from every source, newest first. Ledger DEPOSIT / WITHDRAWAL
 * postings are dropped — they duplicate the request records — but their
 * balances are harvested for those rows. A Bonus (or old Main) wallet's
 * WITHDRAWAL debit is dropped too: the payout already appears as its
 * Withdrawal row; a later REFUND stays. Likewise an approved wallet deposit
 * is its Deposit row, so the wallet credit it produced (`paymentRef` = the
 * deposit id) is dropped. /subscriptions/history tags each row with its
 * wallet: the MAIN rows are the retired Main Wallet's (read-only, "Main
 * Wallet (closed)"); the BONUS rows are plan charges the Bonus ledger
 * already holds, so only those it did not load are kept. A row without a
 * date sorts last.
 */
export const buildHistoryRows = (
  deposits: readonly Deposit[],
  withdrawals: readonly Withdrawal[],
  ledger: readonly LedgerEntry[],
  subscriptions: readonly WalletTransaction[] = [],
  bonusTx: readonly WalletTransaction[] = [],
  accounts: readonly Pick<UserAccount, 'id' | 'nickname' | 'accountNumber' | 'accountType'>[] = [],
  creditTx: readonly CreditTransaction[] = [],
): HistoryRow[] => {
  const names = accountNames(accounts);
  const snaps = balanceSnapshots(ledger, [...subscriptions, ...bonusTx]);
  const isWithdrawalLeg = (t: WalletTransaction): boolean => String(t.reason || '').toUpperCase() === 'WITHDRAWAL';
  const depositIds = new Set(deposits.map((x) => String(x.id)));
  const isDepositLeg = (t: WalletTransaction): boolean =>
    String(t.reason || '').toUpperCase() === 'DEPOSIT' && !!t.paymentRef && depositIds.has(String(t.paymentRef));
  const bonusIds = new Set(bonusTx.map((t) => String(t.id)));
  return [
    ...deposits.map((d) => normalizeDeposit(d, snaps, names)),
    ...withdrawals.map((w) => normalizeWithdrawal(w, snaps, names)),
    ...ledger.filter((e) => e.type !== 'DEPOSIT' && e.type !== 'WITHDRAWAL').map((e) => normalizeLedger(e, names)),
    ...subscriptions
      .filter((t) => t.wallet !== 'BONUS' && !isWithdrawalLeg(t) && !isDepositLeg(t))
      .map(normalizeSubscription),
    ...[...bonusTx, ...subscriptions.filter((t) => t.wallet === 'BONUS' && !bonusIds.has(String(t.id)))]
      .filter((t) => !isWithdrawalLeg(t) && !isDepositLeg(t))
      .map(normalizeBonus),
    ...creditTx.map((c) => normalizeCredit(c, snaps, names)),
  ]
    .map((r) => ({ ...r, category: categoryOf(r) }))
    .sort((a, b) => ts(b.date) - ts(a.date));
};

/** Every known status, then any unexpected one the data carries. */
export const statusOptionsOf = (rows: readonly Pick<HistoryRow, 'status'>[]): string[] => {
  const present = new Set(rows.map((r) => r.status).filter(Boolean));
  const extra = [...present].filter((s) => !ALL_STATUSES.includes(s)).sort();
  return [...ALL_STATUSES, ...extra];
};

/* ── Date ranges (client/src/utils/dateRange.js) ─────────────────────── */

export const DAY_MS = 24 * 60 * 60 * 1000;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Local midnight of `value`'s calendar day ('YYYY-MM-DD' | Date | ISO), or null. */
export const dayStart = (value: string | Date | null | undefined): Date | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && YMD.test(value.trim())) {
    const [y = 0, m = 1, d = 1] = value.trim().split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
};

/** The exclusive upper bound — local start of the next day. */
export const nextDayStart = (value: string | Date | null | undefined): Date | null => {
  const s = dayStart(value);
  return s ? new Date(s.getTime() + DAY_MS) : null;
};

/** [startOfDay(from), startOfNextDay(to)) — From == To is that whole day. */
export const inCustomRange = (
  value: string | null | undefined,
  from: string | Date | null | undefined,
  to: string | Date | null | undefined,
): boolean => {
  const t = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(t)) return false;
  const s = dayStart(from);
  if (s && t < s.getTime()) return false;
  const e = nextDayStart(to);
  if (e && t >= e.getTime()) return false;
  return true;
};

/** A preset key → its day-aligned bounds (dateRange.js presetRange). */
export const presetRange = (range: string, now: Date = new Date()): { from: Date | null; to: Date | null } => {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const ago = (n: number): Date => new Date(today.getTime() - n * DAY_MS);
  switch (String(range || '').toLowerCase()) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: ago(1), to: ago(1) };
    case '7d': case 'last7': return { from: ago(6), to: today };
    case '30d': case 'last30': return { from: ago(29), to: today };
    case '90d': case 'last90': return { from: ago(89), to: today };
    case '3m': { const f = new Date(today); f.setMonth(f.getMonth() - 3); return { from: f, to: today }; }
    case '6m': { const f = new Date(today); f.setMonth(f.getMonth() - 6); return { from: f, to: today }; }
    case '1y': { const f = new Date(today); f.setFullYear(f.getFullYear() - 1); return { from: f, to: today }; }
    case 'week': case 'thisweek': { const f = new Date(today); f.setDate(f.getDate() - ((f.getDay() + 6) % 7)); return { from: f, to: today }; }
    case 'month': case 'thismonth': return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: today };
    case 'year': case 'thisyear': return { from: new Date(now.getFullYear(), 0, 1), to: today };
    default: return { from: null, to: null };
  }
};

export interface CustomRange { from: string; to: string }

/**
 * A preset or a custom range. DIFFERS from dateRange.js on 'all': the web
 * still applies `custom` there. All time is all time here.
 */
export const matchesDateRange = (
  value: string | null | undefined,
  range: string,
  custom: CustomRange | null | undefined,
  now: Date = new Date(),
): boolean => {
  const r = String(range || 'all').toLowerCase();
  if (r === 'all') return true;
  if (r === 'custom') return inCustomRange(value, custom?.from, custom?.to);
  const { from, to } = presetRange(r, now);
  return inCustomRange(value, from, to);
};

/** A real calendar day written YYYY-MM-DD (typed text can say 2026-02-31). */
export const isCalendarDate = (value: string): boolean => {
  const s = value.trim();
  if (!YMD.test(s)) return false;
  const [y = 0, m = 0, d = 0] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
};

/** Why a typed custom-range date cannot be used, or null. */
export const customDateError = (value: string): string | null => {
  const s = value.trim();
  if (s.length < 10) return null;
  return isCalendarDate(s) ? null : 'Enter a real date as YYYY-MM-DD';
};

/** A half-typed or impossible date is not a bound. */
export const cleanCustomRange = (c: CustomRange): CustomRange => ({
  from: isCalendarDate(c.from) ? c.from.trim() : '',
  to: isCalendarDate(c.to) ? c.to.trim() : '',
});

/** TransactionHistory.jsx DATE_PRESETS, in order. */
export const DATE_PRESETS: readonly { key: string; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 Days' },
  { key: '30d', label: 'Last 30 Days' },
  { key: '90d', label: 'Last 90 Days' },
  { key: '3m', label: 'Last 3 Months' },
  { key: '6m', label: 'Last 6 Months' },
  { key: '1y', label: 'Last 1 Year' },
  { key: 'all', label: 'All Time' },
  { key: 'custom', label: 'Custom Range' },
];

/** An unknown key reads as "All Time". */
export const datePresetLabel = (key: string): string =>
  (DATE_PRESETS.find((p) => p.key === key) ?? DATE_PRESETS[8] ?? { label: 'All Time' }).label;

/* ── Filtering, paging, exporting ────────────────────────────────────── */

export interface HistoryFilter {
  range: string;
  custom: CustomRange;
  /** 'all', a trading account id, or 'wallet:subscription' / 'wallet:bonus'. */
  accountId: string;
  types: readonly string[];
  statuses: readonly string[];
  search: string;
}

/**
 * TransactionHistory.jsx `filtered`. A `wallet:` choice filters by the
 * wallet a row belongs to; the search covers the short ticket and the raw
 * reference too, so "726B5A", "#726B5A" and the full id all find a row.
 */
export const filterHistory = (
  rows: readonly HistoryRow[],
  f: HistoryFilter,
  now: Date = new Date(),
): HistoryRow[] => {
  const q = f.search.trim().toLowerCase();
  const custom = cleanCustomRange(f.custom);
  return rows.filter((r) => {
    if (!matchesDateRange(r.date, f.range, custom, now)) return false;
    if (f.accountId.startsWith('wallet:')) {
      if (r.walletScope !== f.accountId.slice(7)) return false;
    } else if (f.accountId !== 'all' && r.accountId !== f.accountId) return false;
    if (!f.types.includes(r.category)) return false;
    if (!f.statuses.includes(r.status)) return false;
    if (q) {
      const hay = `${txnDisplayId(r.id)} ${rowTicket(r) || ''} ${r.referenceId || ''} ${rowDescription(r)} ${r.destination} ${r.receivedFrom} ${r.type} ${r.method}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
};

export const PAGE_SIZES: readonly number[] = [15, 25, 50, 100];

export const totalPagesOf = (count: number, pageSize: number): number => Math.max(1, Math.ceil(count / pageSize));

/** "Showing 1 to 15 of 42 entries". */
export const pageSummary = (page: number, pageSize: number, total: number): string =>
  `Showing ${(page - 1) * pageSize + 1} to ${Math.min(page * pageSize, total)} of ${total} entries`;

/** 1 … 4 5 [6] 7 8 … 20. */
export const pageNumbers = (totalPages: number, current: number, win = 2): (number | '…')[] => {
  const out: (number | '…')[] = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - current) <= win) out.push(i);
    else if (out[out.length - 1] !== '…') out.push('…');
  }
  return out;
};

/** "All Selected (18)" / "3 Selected" / "None Selected". */
export const multiSummary = (optionCount: number, selectedCount: number): string => {
  if (optionCount === 0) return 'None';
  if (selectedCount === optionCount) return `All Selected (${optionCount})`;
  if (selectedCount === 0) return 'None Selected';
  return `${selectedCount} Selected`;
};

/**
 * The Accounts filter's rows — all, the Bonus Wallet, then each account. The
 * retired Main Wallet has no row of its own: its old rows show under All.
 */
export const historyAccountOptions = (
  accounts: readonly Pick<UserAccount, 'id' | 'nickname' | 'accountNumber' | 'accountType'>[],
): { id: string; name: string; sub: string }[] => [
  { id: 'all', name: 'All Accounts', sub: '' },
  { id: 'wallet:bonus', name: 'Main Wallet', sub: 'Earnings, top-ups & plan billing' },
  ...accounts.map((a) => {
    const name = a.nickname || a.accountNumber || a.accountType || 'Account';
    return { id: a.id, name, sub: a.accountNumber && a.accountNumber !== name ? a.accountNumber : '' };
  }),
];

/** "+" for money in, "-" for money out, nothing for zero. */
export const amountSign = (amount: number): string => (amount > 0 ? '+' : amount < 0 ? '-' : '');

/** "+₹5,000.00" — a row's amount as the table prints it. */
export const historyAmountText = (amount: number): string => `${amountSign(amount)}${fmtMoney(Math.abs(amount))}`;

/** "₹12,345.00", or '—' when the balance is not known. */
export const balanceText = (v: number | null): string => (v === null ? '—' : fmtMoney(v));

/**
 * The Details sheet's rows. The third element is the full reference shown
 * under the short Order ID, for support.
 */
export const historyDetailRows = (row: HistoryRow, locale?: string): [string, string, string?][] => [
  ['Transaction ID', txnDisplayId(row.id)],
  ['Date & Time', fmtTxnDateTime(row.date, locale)],
  ['Type', row.type],
  ['Amount', historyAmountText(row.amount)],
  ['Balance Before', balanceText(row.beforeBal)],
  ['Balance After', balanceText(row.afterBal)],
  ['Status', row.status],
  ['Payment Method', row.method],
  ['Received From', String(row.receivedFrom).replace(/\n/g, ' · ')],
  ['Destination', String(row.destination).replace(/\n/g, ' · ')],
  ...(row.referenceId ? [['Order ID', ticketShort(row.referenceId), String(row.referenceId)] as [string, string, string]] : []),
  ['Description', rowDescription(row)],
];

export const CSV_COLUMNS = [
  'Date & Time', 'Transaction ID', 'Order ID', 'Amount (INR)', 'Balance Before (INR)', 'Balance After (INR)',
  'Status', 'Type', 'Payment Method', 'Received From', 'Destination', 'Description', 'Note',
] as const;

/** The web's Export: the FILTERED rows plus the trader's notes. */
export const historyCsv = (
  rows: readonly HistoryRow[],
  notes: Readonly<Record<string, string>>,
  locale?: string,
): string => {
  const esc = (v: unknown): string => `"${String(v ?? '').replace(/\n/g, ' ').replace(/"/g, '""')}"`;
  const lines = [CSV_COLUMNS.map(esc).join(',')];
  for (const r of rows) {
    lines.push([
      fmtTxnDateTime(r.date, locale), txnDisplayId(r.id), rowTicket(r) || '', r.amount.toFixed(2),
      r.beforeBal !== null ? r.beforeBal.toFixed(2) : '', r.afterBal !== null ? r.afterBal.toFixed(2) : '',
      r.status, r.type, r.method, r.receivedFrom, r.destination, rowDescription(r), notes[r.id] || '',
    ].map(esc).join(','));
  }
  return lines.join('\n');
};

/** `transactions-2026-09-29.csv` */
export const historyCsvFilename = (now: Date = new Date()): string =>
  `transactions-${now.toISOString().slice(0, 10)}.csv`;

/* ── Private notes ───────────────────────────────────────────────────── */

/**
 * The web keeps notes in localStorage under one key per BROWSER ('txnNotes'),
 * so whoever signs in next on that machine reads them. On a phone that can
 * change hands they are kept per USER.
 */
export const notesStorageKey = (userId: string): string => `imperialexchange:txnNotes:${userId}`;

/** Tolerant: anything but a flat string map reads as no notes. */
export const parseNotes = (raw: string | null | undefined): Record<string, string> => {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, s] of Object.entries(v as Record<string, unknown>)) if (typeof s === 'string' && s) out[k] = s;
    return out;
  } catch {
    return {};
  }
};

/** saveNote — an empty note deletes. */
export const withNote = (
  notes: Readonly<Record<string, string>>,
  id: string,
  value: string,
): Record<string, string> => {
  const next = { ...notes };
  const v = value.trim();
  if (v) next[id] = v;
  else delete next[id];
  return next;
};
