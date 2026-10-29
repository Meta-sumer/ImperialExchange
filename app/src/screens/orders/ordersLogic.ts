import type { UnifiedHistoryQuery } from '@/api/trading.api';
import type { Pagination } from '@/types/market';
import type { HistoryRecord, Instrument, PositionHistorySummary, RecordType } from '@/types/trading';
import { isDemoLike } from '@/utils/accountType';
import type { DateRange } from '@/utils/dateFilter';
import { fmtMoney, fmtNum, fmtPrice } from '@/utils/money';
import { fmtLocalDateTime } from '@/utils/walletLogic';

/**
 * Trade History — the Orders page's logic, ported from EquityHub's
 * client/src/pages/Orders.jsx. No React here, so every rule tests without a
 * renderer. The screen is OrdersScreen.tsx.
 *
 * Every record an account has finished with, in one list: closed positions,
 * plus the orders that were cancelled or rejected and so never became
 * positions — GET /trading/history, which unions and pages the two
 * collections server-side and projects an order into the position shape.
 * A field an order cannot have (close price, commission, P/L) is null and
 * shows as a dash, never 0.
 */

/* ── Filters ──────────────────────────────────────────────────────────── */

/** The ID picker's "every account that matches the TYPE filter". */
export const ALL_ACCOUNTS = 'all';

/** TYPE — REAL is any tier that is not DEMO / VIRTUAL. */
export type AccountTypeFilter = 'all' | 'REAL' | 'DEMO';
export type SideFilter = '' | 'BUY' | 'SELL';

export const TYPE_FILTER_OPTIONS: readonly { value: AccountTypeFilter; label: string }[] = [
  { value: 'all', label: 'ALL' },
  { value: 'REAL', label: 'REAL' },
  { value: 'DEMO', label: 'DEMO' },
];

export const SIDE_FILTER_OPTIONS: readonly { value: SideFilter; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'BUY', label: 'BUY' },
  { value: 'SELL', label: 'SELL' },
];

/**
 * The single Status control (Orders.jsx STATUS_OPTIONS). A value is EITHER a
 * record type (lowercase) OR a close reason (uppercase, the backend's
 * whitelist) — one control, because a close reason belongs to a trade that
 * opened, so pairing one with "Cancelled" could only ever return nothing.
 * `group` is the <optgroup> heading.
 */
export const TRADE_GROUP = 'Closed trades';
export const ORDER_GROUP = 'Never opened';
export const STATUS_OPTIONS: readonly { value: string; label: string; group?: string }[] = [
  { value: '', label: 'All records' },
  { value: 'closed', label: 'Any close reason', group: TRADE_GROUP },
  { value: 'MANUAL', label: 'Manual close', group: TRADE_GROUP },
  { value: 'ADMIN', label: 'Closed by admin', group: TRADE_GROUP },
  { value: 'TAKE_PROFIT', label: 'Take Profit', group: TRADE_GROUP },
  { value: 'STOP_LOSS', label: 'Stop Loss', group: TRADE_GROUP },
  { value: 'TRAILING_STOP', label: 'Trailing Stop', group: TRADE_GROUP },
  // Both spellings — the engine writes STOP_OUT.
  { value: 'STOP_OUT', label: 'Stop-out', group: TRADE_GROUP },
  { value: 'MARGIN_STOPOUT', label: 'Margin Stop-out (legacy)', group: TRADE_GROUP },
  { value: 'NEGATIVE_BALANCE', label: 'Neg-balance Protection', group: TRADE_GROUP },
  { value: 'cancelled', label: 'Cancelled orders', group: ORDER_GROUP },
  { value: 'rejected', label: 'Rejected orders', group: ORDER_GROUP },
];
export const STATUS_GROUPS: readonly string[] = [TRADE_GROUP, ORDER_GROUP];

/** Which values name a record set rather than a close reason. */
export const RECORD_TYPES: ReadonlySet<string> = new Set(['closed', 'cancelled', 'rejected']);

/** The record set a Status value asks for — a close reason implies closed trades. */
export const viewFor = (status: string): RecordType =>
  (RECORD_TYPES.has(status) ? status as RecordType : (status ? 'closed' : 'all'));

/** The close reason a Status value carries, or '' for a record type. */
export const closeReasonFor = (status: string): string => (RECORD_TYPES.has(status) ? '' : status);

/** The web's page size. */
export const TRADE_HISTORY_PAGE_SIZE = 30;

export interface OrdersFilters {
  /** An account id, or ALL_ACCOUNTS. */
  accountId: string;
  type: AccountTypeFilter;
  /** Upper-cased as typed. */
  symbol: string;
  side: SideFilter;
  /** A STATUS_OPTIONS value. */
  status: string;
  range: DateRange;
  page: number;
}

interface AccountLike { id: string; accountType: string; accountNumber: string }

/** The accounts the ID picker offers under a TYPE filter. */
export const accountsForType = <A extends Pick<AccountLike, 'accountType'>>(
  accounts: readonly A[],
  type: AccountTypeFilter,
): A[] => {
  if (type === 'DEMO') return accounts.filter((a) => isDemoLike(a.accountType));
  if (type === 'REAL') return accounts.filter((a) => !isDemoLike(a.accountType));
  return [...accounts];
};

/** A picked account that drops out of the TYPE-filtered list snaps back to "all". */
export const reconcileAccountId = (
  accountId: string,
  filtered: readonly Pick<AccountLike, 'id'>[],
): string => (accountId === ALL_ACCOUNTS || filtered.some((a) => a.id === accountId) ? accountId : ALL_ACCOUNTS);

/**
 * The query Orders.jsx builds. A specific account → that id; "all" with a
 * TYPE filter → the filtered ids as a list; "all" with no TYPE → no account
 * at all (the server takes every account of the user).
 *
 * Returns null when nothing CAN match — a TYPE filter with no account of
 * that type. DOCUMENTED DIVERGENCE: the web sends `accountIds=` (empty),
 * which the server reads as "no filter", so DEMO with no demo account listed
 * every REAL trade under a DEMO heading. Here that is an empty history.
 */
export const historyQueryFor = (
  f: OrdersFilters,
  filteredAccounts: readonly Pick<AccountLike, 'id'>[],
): UnifiedHistoryQuery | null => {
  const q: UnifiedHistoryQuery = {
    page: f.page,
    limit: TRADE_HISTORY_PAGE_SIZE,
    recordType: viewFor(f.status),
  };
  const reason = closeReasonFor(f.status);
  if (f.symbol) q.symbol = f.symbol;
  if (f.side) q.side = f.side;
  if (reason) q.closeReason = reason;
  if (f.range.fromDate) q.from = f.range.fromDate;
  if (f.range.toDate) q.to = f.range.toDate;
  if (f.accountId !== ALL_ACCOUNTS) {
    q.accountId = f.accountId;
  } else if (f.type !== 'all') {
    if (!filteredAccounts.length) return null;
    q.accountIds = filteredAccounts.map((a) => a.id);
  }
  return q;
};

/* ── Cells ────────────────────────────────────────────────────────────── */

/** utils/ticket.js `ticketShort` — `#69EBF9`, the one rendering of an id on every screen. */
export const ticketShort = (id: string | null | undefined, fallback = '—'): string =>
  (id ? `#${String(id).slice(-6).toUpperCase()}` : fallback);

/** A closed trade (vs an order that never opened). */
export const isTrade = (r: Pick<HistoryRecord, 'kind'>): boolean => r.kind !== 'ORDER';

/** The size traded: what closed when anything did, else the order size. */
export const sizeOf = (r: Pick<HistoryRecord, 'closedQuantity' | 'quantity'>): string =>
  (Number(r.closedQuantity) > 0 ? String(r.closedQuantity) : r.quantity);

/**
 * Orders.jsx `fmtLot`: lot sizes can be tiny (0.001), and two decimals would
 * collapse them to "0.00", so the precision widens for small sizes.
 */
export const lotDecimals = (qty: string | number | null | undefined): number => {
  const abs = Math.abs(Number(qty));
  if (!Number.isFinite(abs) || abs === 0) return 2;
  return abs >= 0.01 ? 2 : abs >= 0.001 ? 3 : abs >= 0.0001 ? 4 : 5;
};

export const fmtLot = (qty: string | number | null | undefined): string => {
  const n = Number(qty);
  if (!Number.isFinite(n) || n === 0) return '0.00';
  return fmtNum(n, lotDecimals(n));
};

/** The dash an absent cell shows (Orders.jsx `none`). */
export const NONE = '—';

/**
 * A price cell. The web prints every price with five decimals; the port uses
 * the INSTRUMENT'S own precision when the catalogue knows the symbol, and
 * the web's five otherwise. Absent → '—'.
 */
export const fmtRowPrice = (
  value: string | null | undefined,
  instrument: Pick<Instrument, 'pricePrecision'> | null | undefined,
): string => {
  if (!value) return NONE;
  return fmtPrice(value, instrument?.pricePrecision ?? 5);
};

/** Commission / Charge (the swap) — two decimals for a trade, a dash for an order. */
export const fmtFee = (r: Pick<HistoryRecord, 'kind'>, value: string | null | undefined): string =>
  (isTrade(r) ? fmtNum(value || '0', 2) : NONE);

/** P/L: "+₹12.30" / "-₹4.10" for a trade (zero reads "+₹0.00"); a dash for an order. */
export const pnlText = (r: Pick<HistoryRecord, 'kind' | 'realizedPnl'>): string => {
  if (!isTrade(r)) return NONE;
  const n = Number(r.realizedPnl || 0);
  const v = Number.isFinite(n) ? n : 0;
  return `${v >= 0 ? '+' : '-'}${fmtMoney(Math.abs(v))}`;
};

/** 'bull' / 'bear' for a trade's P/L; null for an order (no colour). */
export const pnlTone = (r: Pick<HistoryRecord, 'kind' | 'realizedPnl'>): 'bull' | 'bear' | null =>
  (isTrade(r) ? (Number(r.realizedPnl || 0) >= 0 ? 'bull' : 'bear') : null);

/** "dd/mm/yyyy, hh:mm:ss am" in the device's time zone; '-' when absent. */
export const formatDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (n: number): string => String(n).padStart(2, '0');
  const h24 = d.getHours();
  const h = h24 % 12 || 12;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}, ${pad(h)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${h24 >= 12 ? 'pm' : 'am'}`;
};

/** Who closed a trade: ADMIN for an admin force-close, else the trader. */
export type ExecutedBy = 'ADMIN' | 'SELF';
export const executedBy = (r: Pick<HistoryRecord, 'closeReason'>): ExecutedBy =>
  (r.closeReason === 'ADMIN' ? 'ADMIN' : 'SELF');

/** Orders.jsx `remarkText` — how a trade closed. */
export const remarkText = (reason: string | null | undefined): string => {
  switch (reason) {
    case 'TAKE_PROFIT': return 'PROFIT TAKEN — Target hit';
    case 'STOP_LOSS': return 'STOP LOSS HIT';
    case 'TRAILING_STOP': return 'TRAILING STOP HIT';
    // The engine writes STOP_OUT; older rows carry MARGIN_STOPOUT.
    case 'STOP_OUT':
    case 'MARGIN_STOPOUT': return 'CLOSED — Stop-out';
    case 'NEGATIVE_BALANCE': return 'NEG-BALANCE PROTECTION';
    case 'EXPIRY': return 'CLOSED — Expired';
    case 'INTRADAY_SQUAREOFF': return 'CLOSED — Intraday square-off';
    case 'INSTRUMENT_DISABLED_FORCE_CLOSE': return 'CLOSED — Instrument disabled';
    case 'COPY_MASTER_CLOSED': return 'CLOSED — Master closed';
    case 'MANUAL': return 'closed by user';
    case 'ADMIN': return 'closed by admin';
    default: return 'N/A';
  }
};

/**
 * Orders.jsx `orderRemark` — why an order never became a position. A
 * rejection's reason wins; a blank one says so rather than guess.
 */
export const orderRemark = (o: Pick<HistoryRecord, 'rejectionReason' | 'status'>): string => {
  if (o.rejectionReason) return o.rejectionReason;
  if (o.status === 'REJECTED') return 'REJECTED — no reason recorded';
  return 'CANCELLED — order withdrawn';
};

/** The REMARKS cell — how a trade closed, or why an order was refused. */
export const remarkFor = (r: Pick<HistoryRecord, 'kind' | 'closeReason' | 'rejectionReason' | 'status'>): string =>
  (isTrade(r) ? remarkText(r.closeReason) : orderRemark(r));

/** The record status pill (Orders.jsx RecordStatusPill): its words and tone. */
export const recordStatus = (r: Pick<HistoryRecord, 'status'>): { label: string; tone: 'bear' | 'neutral' | 'bull' } => {
  const label = r.status || 'CLOSED';
  return { label, tone: r.status === 'REJECTED' ? 'bear' : r.status === 'CANCELLED' ? 'neutral' : 'bull' };
};

/* ── Page state ───────────────────────────────────────────────────────── */

export interface TradeHistoryPage {
  items: HistoryRecord[];
  summary: PositionHistorySummary;
  pagination: Pagination;
}

export const EMPTY_SUMMARY: PositionHistorySummary = { totalTrades: 0, totalLot: 0, netPnl: 0, wins: 0, losses: 0 };

/** The web's initial state. */
export const EMPTY_TRADE_HISTORY: TradeHistoryPage = {
  items: [],
  summary: EMPTY_SUMMARY,
  pagination: { page: 1, limit: TRADE_HISTORY_PAGE_SIZE, total: 0, pages: 0 },
};

/** "Showing n of N trades / records / orders" — the noun follows the record set. */
export const showingText = (shown: number, total: number, status: string): string => {
  const view = viewFor(status);
  return `Showing ${shown} of ${total} ${view === 'closed' ? 'trades' : view === 'all' ? 'records' : 'orders'}`;
};

/**
 * The empty list's line. "Nothing matched" and "nothing exists" are
 * different answers; a close reason narrows to a subset, so it gets the first.
 */
export const emptyText = (status: string): string => {
  const reason = closeReasonFor(status);
  const view = viewFor(status);
  if (reason) return `No closed trades matched ${STATUS_OPTIONS.find((o) => o.value === reason)?.label || 'that status'}.`;
  if (view === 'all') return 'Nothing here yet — closed trades, cancelled and rejected orders all appear in this list.';
  if (view === 'closed') return 'No closed trades yet';
  if (view === 'rejected') return 'No rejected orders — nothing has been refused on this account.';
  return 'No cancelled orders.';
};

/** The summary strip, in the web's order and wording. */
export interface SummaryTile {
  label: string;
  value: string;
  tone: 'bull' | 'bear' | null;
  highlight: boolean;
}

export const summaryTiles = (s: PositionHistorySummary): SummaryTile[] => {
  const net = Number(s.netPnl) || 0;
  return [
    { label: 'Total Trades', value: Number(s.totalTrades).toFixed(2), tone: null, highlight: false },
    { label: 'Total Lot', value: Number(s.totalLot).toFixed(2), tone: null, highlight: false },
    { label: 'Loaded Wins', value: Number(s.wins).toFixed(2), tone: 'bull', highlight: false },
    { label: 'Loaded Losses', value: Number(s.losses).toFixed(2), tone: 'bear', highlight: false },
    {
      label: 'Net P/L',
      value: `${net >= 0 ? '+' : '-'}₹${Math.abs(net).toFixed(2)}`,
      tone: net > 0 ? 'bull' : net < 0 ? 'bear' : null,
      highlight: true,
    },
  ];
};

/** The pager shows only with more than one page; Prev / Next clamp to the ends. */
export const showsPager = (p: Pick<Pagination, 'pages'>): boolean => p.pages > 1;
export const prevPage = (page: number): number => Math.max(1, page - 1);
export const nextPage = (page: number, pages: number): number => Math.min(pages, page + 1);

/** Filters the Clear button resets (the account chip is not one of them). */
export const clearedFilters = (f: OrdersFilters): OrdersFilters => ({
  ...f,
  symbol: '',
  side: '',
  status: '',
  range: { period: null, fromDate: '', toDate: '' },
  page: 1,
});

/* ── Download Report (CSV) ────────────────────────────────────────────── */

const q = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csvRow = (cells: readonly unknown[]): string => cells.map(q).join(',');

export interface TradeHistoryCsvInput {
  rows: readonly HistoryRecord[];
  user: { firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null; mobile?: string | null } | null;
  filters: Pick<OrdersFilters, 'accountId' | 'type' | 'symbol' | 'side' | 'status' | 'range'>;
  /** The picked account, when one is. */
  account: Pick<AccountLike, 'accountNumber'> | null;
  /** How many accounts "All accounts" covers under the TYPE filter. */
  filteredAccountCount: number;
  now: Date;
}

export const CSV_HEADERS = [
  'Order ID', 'Symbol', 'Side', 'Status', 'Size', 'Open Price', 'Close Price',
  'Commission', 'Charge', 'Executed By', 'Remarks', 'Opened At', 'Closed At', 'P/L',
] as const;

/**
 * Orders.jsx `downloadReport`, cell for cell: a metadata banner, a blank
 * line, then the table. Order rows leave the trade-only cells EMPTY rather
 * than writing 0 — a spreadsheet would otherwise sum orders that never
 * opened into a commission or P/L total.
 */
export const buildTradeHistoryCsv = (input: TradeHistoryCsvInput): string => {
  const { rows, user, filters: f, account, filteredAccountCount, now } = input;
  const userName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || '—';
  const accountLabel = f.accountId === ALL_ACCOUNTS
    ? `All accounts (${filteredAccountCount})`
    : (account?.accountNumber || f.accountId);
  const typeLabel = f.type === 'all' ? 'All' : f.type;
  const { fromDate, toDate } = f.range;

  const meta = [
    csvRow(['Trade History Report']),
    csvRow([]),
    csvRow(['Generated at', fmtLocalDateTime(now)]),
    csvRow(['Generated by', userName]),
    csvRow(['Email', user?.email || '—']),
    csvRow(['Phone', user?.phone || user?.mobile || '—']),
    csvRow(['Account', accountLabel]),
    csvRow(['Account type', typeLabel]),
    csvRow(['Date range', fromDate || toDate ? `${fromDate || '—'} → ${toDate || '—'}` : 'All time']),
    csvRow(['Symbol filter', f.symbol || 'Any']),
    csvRow(['Side filter', f.side || 'Any']),
    csvRow(['Status filter', STATUS_OPTIONS.find((o) => o.value === f.status)?.label || 'All records']),
    csvRow(['Rows in file', rows.length]),
    csvRow([]),
  ];

  const data = rows.map((p) => {
    const trade = isTrade(p);
    return csvRow([
      ticketShort(p.id),
      p.symbol,
      p.side,
      p.status || 'CLOSED',
      sizeOf(p),
      p.entryPrice || '',
      p.closePrice || '',
      trade ? (p.commission || '0') : '',
      trade ? (p.swap || '0') : '',
      trade ? executedBy(p) : '',
      remarkFor(p),
      formatDateTime(p.openedAt || p.createdAt),
      formatDateTime(p.closedAt),
      trade ? (p.realizedPnl ?? '') : '',
    ]);
  });

  return [...meta, csvRow(CSV_HEADERS), ...data].join('\n');
};

/** `trade-history_<account>_<YYYY-MM-DDTHH-mm>.csv` — the timestamp is UTC, so files sort by time. */
export const tradeHistoryFilename = (
  f: Pick<OrdersFilters, 'accountId'>,
  account: Pick<AccountLike, 'accountNumber'> | null,
  now: Date,
): string => {
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const tag = f.accountId === ALL_ACCOUNTS ? 'all-accounts' : (account?.accountNumber || f.accountId);
  return `trade-history_${tag}_${ts}.csv`;
};
