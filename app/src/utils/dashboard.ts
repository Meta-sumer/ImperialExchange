import type { LifetimeStatsQuery, PerformanceMetric } from '@/api/dashboard.api';
import type {
  CloseAllResult,
  DashboardSummary,
  Instrument,
  LifetimeStats,
  Position,
  SeriesBucket,
} from '@/types/trading';
import type { UserAccount } from '@/types/user';
import { isDemoLike, isRealMoney } from '@/utils/accountType';
import { CURRENCY_SYMBOL, EMPTY, fmtMoney, fmtNum, fmtPnl, fmtSigned } from '@/utils/money';
import { isCalendarDate } from '@/utils/walletLogic';

/**
 * The Portfolio page's logic — EquityHub's client/src/pages/Dashboard.jsx —
 * as pure functions, so every number and label it decides can be pinned
 * against the web without a renderer (__tests__/apiB_portfolio).
 *
 * EquityHub is INR-only: every balance, P&L and position value the API
 * returns is rupees, so nothing here converts. Money goes through
 * utils/money (₹, Indian grouping) and `fmtSigned` is the web's
 * `useMoney().signed`.
 *
 * ── WHERE THIS DELIBERATELY DIFFERS FROM THE WEB ──────────────────────
 * 1. A figure that has not arrived reads "—" (utils/money), not ₹0.00: an
 *    account's balance before /wallet/balances answers is unknown, not zero.
 * 2. Today's realised P&L per account pages through the history (the server
 *    clamps a page to 200; the web asked for 500 and dropped the rest).
 * 3. The closed-trades Account column looks the number up in the trader's
 *    own accounts; the web read `t.accountNumber`, which history rows never
 *    carry, so it always showed the id's last six.
 * 4. A negative Charges total (a net swap credit) prints its sign once; the
 *    web's `-${money(charges)}` would print "--₹".
 * ──────────────────────────────────────────────────────────────────────
 */

/* ── Numbers ──────────────────────────────────────────────────────────── */

const n0 = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** `+12.34%` / `-1.20%` — the web's `${pos ? '+' : ''}${pct.toFixed(2)}%`. */
export const signedPct = (pct: number): string => `${pct >= 0 ? '+' : ''}${fmtNum(pct, 2)}%`;

/**
 * Quantity as the web prints it: `qty.toLocaleString('en-US',
 * { maximumFractionDigits: 6 })` — grouped, trailing zeros dropped.
 */
export const fmtQty = (value: unknown, maxDecimals = 6): string => {
  const n = n0(value);
  const fixed = Math.abs(n).toFixed(maxDecimals).replace(/\.?0+$/, '');
  const [whole = '0', frac] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 && fixed !== '0' ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
};

/* ── Header ───────────────────────────────────────────────────────────── */

/** Dashboard.jsx:143. */
export const dashboardName = (user: { firstName?: string | null; lastName?: string | null } | null | undefined): string =>
  [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Trader';

/** Dashboard.jsx:194-196. */
export const dashboardSubtitle = (name: string): string =>
  `${name} · Equity, P&L, open positions and activity — all in one view`;

/** Dashboard.jsx:199-217 — three states, no banner. */
export type KycChip = 'verified' | 'review' | 'verify';

export const kycChipOf = (status: string | null | undefined): KycChip =>
  (status === 'APPROVED' ? 'verified' : status === 'PENDING' ? 'review' : 'verify');

/** The chip's words. */
export const KYC_CHIP_LABEL: Readonly<Record<KycChip, string>> = {
  verified: 'KYC Verified',
  review: 'KYC Under Review',
  verify: 'Verify Identity',
};

/* ── Hero band ────────────────────────────────────────────────────────── */

/**
 * Dashboard.jsx:146-155 — the live balance. `balance.live` when the server
 * has it; only when it is zero are the per-currency rows summed. INR-only:
 * every row is rupees, so it is a plain sum.
 */
export const liveBalanceOf = (balance: Pick<DashboardSummary['balance'], 'live' | 'liveByCurrency'>): number => {
  const direct = n0(balance.live);
  if (direct !== 0) return direct;
  return Object.values(balance.liveByCurrency).reduce((sum, t) => {
    const bal = Number(t?.balance || 0);
    return Number.isFinite(bal) ? sum + bal : sum;
  }, 0);
};

export interface HeroFigures {
  balance: number;
  /** Floating P&L. */
  unrealized: number;
  equity: number;
  /** Realised today (closed). */
  today: number;
  eqPct: number;
  todayPct: number;
  winRate: number | null;
  /** Where the floating figure came from: re-marked with live ticks, or the dashboard read. */
  source: 'ticks' | 'summary';
}

/**
 * The hero band's figures (Dashboard.jsx:146-169, 240-241).
 *
 * Floating P&L: once a tick has arrived for EVERY live open position the
 * server listed (`equity.openPositions` — sent so the client can re-mark
 * tick by tick), it is (mark − entry) × qty summed, the server's own formula
 * (dashboardController); until then the dashboard's `equity.unrealizedPnl`.
 * Equity is balance + floating.
 */
export const heroFigures = (p: {
  summary: Pick<DashboardSummary, 'balance' | 'equity' | 'pnl'>;
  priceMap: Readonly<Record<string, number | undefined>>;
}): HeroFigures => {
  const { summary, priceMap } = p;
  const balance = liveBalanceOf(summary.balance);
  const open = summary.equity.openPositions;
  const liveUnrealized = open.reduce((sum, pos) => {
    const mark = Number(priceMap[pos.symbol] ?? 0);
    if (!mark) return sum;
    const entry = Number(pos.entryPrice);
    const qty = Number(pos.quantity);
    return sum + (pos.side === 'BUY' ? (mark - entry) * qty : (entry - mark) * qty);
  }, 0);
  // `!= null`, as the web: any tick counts, even one that marks nothing.
  const haveAllTicks = open.length > 0 && open.every((pos) => priceMap[pos.symbol] != null);
  const unrealized = haveAllTicks ? liveUnrealized : n0(summary.equity.unrealizedPnl);
  const equity = balance + unrealized;
  const today = n0(summary.pnl.realizedToday);
  return {
    balance,
    unrealized,
    equity,
    today,
    eqPct: equity > 0 ? (unrealized / equity) * 100 : 0,
    todayPct: equity > 0 ? (today / equity) * 100 : 0,
    winRate: summary.pnl.winRate,
    source: haveAllTicks ? 'ticks' : 'summary',
  };
};

/**
 * The hero's three money figures as the web prints them: equity with
 * `fmtMoneyBoth(equity)` (no plus), the two P&L tiles with its `withSign`
 * (a plus on a gain, nothing on zero) — exactly utils/money fmtPnl.
 */
export const heroTexts = (h: Pick<HeroFigures, 'equity' | 'unrealized' | 'today' | 'balance'>): {
  equity: string; floating: string; today: string; balance: string;
} => ({
  equity: fmtMoney(h.equity),
  floating: fmtPnl(h.unrealized),
  today: fmtPnl(h.today),
  balance: fmtMoney(h.balance),
});

/** PnlTile — the ↑/↓ chip shows only for a move worth printing. */
export const showsPct = (pct: number | null | undefined): pct is number =>
  typeof pct === 'number' && Number.isFinite(pct) && Math.abs(pct) > 0.005;

/** Dashboard.jsx:280 — `${winRate.toFixed(0)}%`, a dash when undecided. */
export const winRateLabel = (w: number | null | undefined): string =>
  (w === null || w === undefined || !Number.isFinite(w) ? EMPTY : `${fmtNum(w, 0)}%`);

/** Dashboard.jsx:278 — the Win Rate cell's dot. */
export const winRateTone = (w: number | null | undefined): 'none' | 'bull' | 'bear' =>
  (w === null || w === undefined ? 'none' : w >= 50 ? 'bull' : 'bear');

/* ── Trading summary (PortfolioStats) ─────────────────────────────────── */

export type StatTone = 'bull' | 'bear' | 'neutral';

export interface StatRow {
  label: string;
  value: string;
  tone: StatTone;
  emphasis?: boolean;
}

/** What the stats card reads: lifetime-stats, with EquityHub's two extra figures. */
export type StatsSource = Partial<LifetimeStats> & { charges?: unknown; netPnl?: unknown };

const toneOf = (n: number): StatTone => (n > 0 ? 'bull' : n < 0 ? 'bear' : 'neutral');

/**
 * Dashboard.jsx:537-566 — the ten cells, in the web's order and words.
 * `sign(n)` there is `(n > 0 ? '+' : '') + fmtMoney(n)`: utils/money fmtPnl.
 * `netPnl` is the net AFTER charges (dashboardController.getLifetimeStats).
 */
export const statsRows = (stats: StatsSource | null): StatRow[] => {
  const num = (k: keyof StatsSource): number => n0(stats?.[k] || 0);
  const netProfit = num('netProfit');
  const profit = num('profit');
  const loss = num('loss');
  const unrealized = num('unrealizedPnl');
  const closedOrders = n0(stats?.closedOrders || 0);
  const profitable = n0(stats?.profitable || 0);
  const unprofitable = n0(stats?.unprofitable || 0);
  const tradingVolume = num('tradingVolume');
  const lossDisp = Math.abs(loss);
  const charges = num('charges');
  const netPnl = num('netPnl');
  return [
    { label: 'Net profit', value: fmtPnl(netProfit), tone: toneOf(netProfit), emphasis: true },
    { label: 'Net P&L', value: fmtPnl(netPnl), tone: toneOf(netPnl), emphasis: true },
    { label: 'Profit', value: `+${fmtMoney(profit)}`, tone: 'bull' },
    { label: 'Loss', value: `-${fmtMoney(lossDisp)}`, tone: 'bear' },
    { label: 'Charges', value: charges < 0 ? `+${fmtMoney(-charges)}` : `-${fmtMoney(charges)}`, tone: 'bear' },
    { label: 'Unrealised P/L', value: fmtPnl(unrealized), tone: toneOf(unrealized) },
    { label: 'Closed orders', value: fmtNum(closedOrders, 0), tone: 'neutral' },
    { label: 'Profitable', value: fmtNum(profitable, 0), tone: 'bull' },
    { label: 'Unprofitable', value: fmtNum(unprofitable, 0), tone: 'bear' },
    { label: 'Trading volume', value: fmtMoney(tradingVolume), tone: 'neutral' },
  ];
};

export interface StatsFilter {
  /** 0 = lifetime. */
  days: number;
  custom: boolean;
  /** The APPLIED custom range (YYYY-MM-DD), not the drafts. */
  from: string;
  to: string;
  /** '' | 'ALL_REAL' | 'ALL_DEMO' | an account id. */
  accountId: string;
}

/**
 * Dashboard.jsx:520-527. Custom mode with no range applied yet asks for
 * lifetime, exactly as the web does.
 */
export const statsQuery = (f: StatsFilter): LifetimeStatsQuery => {
  const q: LifetimeStatsQuery = {};
  if (f.custom && f.from && f.to) {
    q.fromDate = f.from;
    q.toDate = f.to;
  } else if (!f.custom && f.days) {
    q.days = f.days;
  }
  if (f.accountId) q.accountId = f.accountId;
  return q;
};

/**
 * The web's Apply is enabled once both native date inputs hold a date, and
 * their min/max keep From ≤ To. Typed text has neither guarantee, so both
 * must be real calendar days in order.
 */
export const canApplyCustomRange = (from: string, to: string): boolean =>
  isCalendarDate(from) && isCalendarDate(to) && from.trim() <= to.trim();

export interface Option { value: string; label: string }

/** Dashboard.jsx:616-633 — the stats card's account dropdown. Every account is INR. */
export const statsAccountOptions = (
  accounts: readonly Pick<UserAccount, 'id' | 'accountType' | 'nickname' | 'accountNumber'>[],
): Option[] => [
  { value: '', label: 'All accounts' },
  ...(accounts.some((a) => isRealMoney(a.accountType)) ? [{ value: 'ALL_REAL', label: 'All Real Accounts' }] : []),
  ...(accounts.some((a) => isDemoLike(a.accountType)) ? [{ value: 'ALL_DEMO', label: 'All Demo Accounts' }] : []),
  ...accounts.map((a) => ({ value: a.id, label: `${a.nickname || a.accountNumber} · INR` })),
];

/* ── Analytics chart (PortfolioChart) ─────────────────────────────────── */

/** Dashboard.jsx:1203-1214 — a "nice" axis step (1, 2, 5, 10, 20, 50, …). */
export const niceStep = (raw: number): number => {
  if (raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const m = raw / base;
  let nice: number;
  if (m <= 1) nice = 1;
  else if (m <= 2) nice = 2;
  else if (m <= 5) nice = 5;
  else nice = 10;
  return nice * base;
};

/**
 * Dashboard.jsx:1216-1222 — compact axis labels (1.5k, 12k, 2.5M). Axis
 * ticks only; figures a trader reads go through utils/money.
 */
export const fmtAxis = (n: number): string => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
};

export interface Point { x: number; y: number }

/** Dashboard.jsx:1183-1200 — Catmull-Rom as cubic Béziers. */
export const smoothPathFromPoints = (pts: readonly Point[]): string => {
  const first = pts[0];
  if (!first) return '';
  if (pts.length === 1) return `M ${first.x} ${first.y}`;
  let d = `M ${first.x} ${first.y}`;
  const tension = 0.5;
  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i] as Point;
    const p0 = pts[i - 1] ?? p1;
    const p2 = pts[i + 1] as Point;
    const p3 = pts[i + 2] ?? p2;
    const cp1x = p1.x + ((p2.x - p0.x) / 6) * tension * 2;
    const cp1y = p1.y + ((p2.y - p0.y) / 6) * tension * 2;
    const cp2x = p2.x - ((p3.x - p1.x) / 6) * tension * 2;
    const cp2y = p2.y - ((p3.y - p1.y) / 6) * tension * 2;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
};

export interface YScale { yMax: number; yMin: number; ticks: number[] }

/** Dashboard.jsx:718-737 — symmetric around zero when the data crosses it. */
export const yScaleFor = (buckets: readonly SeriesBucket[], metric: PerformanceMetric): YScale => {
  if (!buckets.length) return { yMax: 4, yMin: 0, ticks: [0, 1, 2, 3, 4] };
  const vals = buckets.map((b) => Number(b[metric] || 0));
  const minV = Math.min(0, ...vals);
  const maxV = Math.max(0, ...vals);
  const span = Math.max(Math.abs(minV), Math.abs(maxV), 4);
  const tickStep = niceStep(span / 4);
  const top = Math.ceil(span / tickStep) * tickStep;
  if (minV < 0) return { yMax: top, yMin: -top, ticks: [-top, -top / 2, 0, top / 2, top] };
  return { yMax: top, yMin: 0, ticks: [0, top / 4, top / 2, (3 * top) / 4, top] };
};

export interface ChartPad { top: number; right: number; bottom: number; left: number }

/** The web draws 920 × 300 with this padding (Dashboard.jsx:740-741). */
export const WEB_CHART = { width: 920, height: 300, pad: { top: 18, right: 28, bottom: 32, left: 44 } } as const;

export interface ChartGeometry {
  width: number;
  height: number;
  pad: ChartPad;
  innerW: number;
  innerH: number;
  slot: number;
  barW: number;
  yOf: (v: number) => number;
  cxOf: (i: number) => number;
}

/** Dashboard.jsx:742-749, for any drawing size. */
export const chartGeometry = (
  width: number,
  height: number,
  pad: ChartPad,
  count: number,
  scale: Pick<YScale, 'yMax' | 'yMin'>,
): ChartGeometry => {
  const innerW = Math.max(1, width - pad.left - pad.right);
  const innerH = Math.max(1, height - pad.top - pad.bottom);
  const n = Math.max(1, count);
  const slot = innerW / n;
  const barW = Math.min(22, slot * 0.55);
  const yRange = scale.yMax - scale.yMin || 1;
  return {
    width,
    height,
    pad,
    innerW,
    innerH,
    slot,
    barW,
    yOf: (v) => pad.top + innerH * (1 - (v - scale.yMin) / yRange),
    cxOf: (i) => pad.left + slot * i + slot / 2,
  };
};

/** The smooth line through the active metric (area + curve tabs). */
export const linePath = (buckets: readonly SeriesBucket[], metric: PerformanceMetric, g: ChartGeometry): string =>
  smoothPathFromPoints(buckets.map((b, i) => ({ x: g.cxOf(i), y: g.yOf(Number(b[metric] || 0)) })));

/** Dashboard.jsx:786-793 — the line closed down to the baseline. */
export const areaPath = (line: string, count: number, g: ChartGeometry, yMin: number): string => {
  if (!line || !count) return '';
  const baseY = g.yOf(yMin < 0 ? 0 : yMin);
  return `${line} L ${g.cxOf(count - 1)} ${baseY} L ${g.cxOf(0)} ${baseY} Z`;
};

/** One bar (closed orders / volume); null for a zero bucket, which draws nothing. */
export const barRect = (
  value: number,
  i: number,
  g: ChartGeometry,
): { x: number; y: number; width: number; height: number } | null => {
  if (!value) return null;
  const y = g.yOf(value);
  const y0 = g.yOf(0);
  return { x: g.cxOf(i) - g.barW / 2, y: Math.min(y, y0), width: g.barW, height: Math.max(2, Math.abs(y0 - y)) };
};

/**
 * Which x labels to draw. The web: every bucket up to 8, every other one up
 * to 14, else every ⌈n/8⌉-th, plus the last (Dashboard.jsx:1086). A phone
 * passes the `maxLabels` that fit, and a stride label crowding the last one
 * is dropped so the two do not overprint.
 */
export const xLabelStride = (count: number, maxLabels = 8): number => {
  if (count <= maxLabels) return 1;
  if (maxLabels === 8 && count <= 14) return 2;
  return Math.ceil(count / maxLabels);
};

export const visibleXLabels = (count: number, maxLabels = 8, dropCrowded = false): number[] => {
  const stride = xLabelStride(count, maxLabels);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (i % stride === 0 || i === count - 1) out.push(i);
  }
  if (dropCrowded && out.length >= 2) {
    const last = out[out.length - 1] as number;
    const prev = out[out.length - 2] as number;
    if (last - prev < stride / 2 && last !== prev) out.splice(out.length - 2, 1);
  }
  return out;
};

export const hasNonZero = (buckets: readonly SeriesBucket[], metric: PerformanceMetric): boolean =>
  buckets.length > 0 && buckets.some((b) => Number(b[metric] || 0) !== 0);

export interface ChartHeadline { value: number; fmt: 'money' | 'int'; tone: StatTone }

/** Dashboard.jsx:752-768. */
export const chartHeadline = (buckets: readonly SeriesBucket[], metric: PerformanceMetric): ChartHeadline | null => {
  if (!buckets.length) return null;
  if (metric === 'equity') {
    const last = buckets[buckets.length - 1]?.equity ?? 0;
    return { value: last, fmt: 'money', tone: last >= 0 ? 'bull' : 'bear' };
  }
  if (metric === 'closedOrders') {
    return { value: buckets.reduce((s, b) => s + Number(b.closedOrders || 0), 0), fmt: 'int', tone: 'neutral' };
  }
  if (metric === 'tradingVolume') {
    return { value: buckets.reduce((s, b) => s + Number(b.tradingVolume || 0), 0), fmt: 'money', tone: 'neutral' };
  }
  const total = buckets.reduce((s, b) => s + Number(b.netProfit || 0), 0);
  return { value: total, fmt: 'money', tone: total >= 0 ? 'bull' : 'bear' };
};

/** Dashboard.jsx:770-774. */
export const fmtChartHeadline = (h: ChartHeadline | null): string => {
  if (!h) return EMPTY;
  if (h.fmt === 'int') return fmtNum(h.value, 0);
  return fmtMoney(h.value);
};

export interface StripCell { label: string; value: string; tone: 'bull' | 'bear' | 'primary' }

/**
 * Dashboard.jsx:801-819 — Best Day / Worst Day / Win Rate / Profit Factor /
 * Total Trades. `lifetime` is the all-accounts lifetime stats; `dash` the
 * dashboard summary the page already holds (the web passes it down rather
 * than fetch it twice).
 */
export const chartStrip = (
  buckets: readonly SeriesBucket[],
  lifetime: Pick<LifetimeStats, 'profit' | 'loss' | 'closedOrders'> | null,
  dash: Pick<DashboardSummary, 'pnl' | 'trades'> | null,
): StripCell[] => {
  const netVals = buckets.map((b) => Number(b.netProfit || 0));
  const bestDay = netVals.length ? Math.max(...netVals) : 0;
  const worstDay = netVals.length ? Math.min(...netVals) : 0;
  const winRate = dash?.pnl.winRate;
  const pfProfit = Number(lifetime?.profit ?? dash?.pnl.profit ?? 0);
  const pfLoss = Math.abs(Number(lifetime?.loss ?? dash?.pnl.loss ?? 0));
  const profitFactor = pfLoss > 0 ? pfProfit / pfLoss : null;
  const totalTrades = lifetime?.closedOrders ?? dash?.trades.totalLive ?? dash?.trades.closedLive ?? 0;
  return [
    { label: 'Best Day', value: fmtSigned(Math.max(bestDay, 0)), tone: 'bull' },
    { label: 'Worst Day', value: fmtMoney(Math.min(worstDay, 0)), tone: 'bear' },
    { label: 'Win Rate', value: winRate !== null && winRate !== undefined ? `${fmtNum(Number(winRate), 2)}%` : EMPTY, tone: 'primary' },
    { label: 'Profit Factor', value: profitFactor !== null ? fmtNum(profitFactor, 2) : EMPTY, tone: 'primary' },
    { label: 'Total Trades', value: fmtNum(totalTrades, 0), tone: 'primary' },
  ];
};

export interface TooltipLine { label: string; value: string; tone: 'bull' | 'bear' | 'primary'; total?: boolean }

/** Dashboard.jsx:1133-1160 — the hovered (here: tapped) bucket's card. */
export const tooltipLines = (b: SeriesBucket, metric: PerformanceMetric, metricLabel: string): TooltipLine[] => {
  if (metric === 'netProfit') {
    return [
      { label: 'Profit', value: `+${fmtMoney(b.profit)}`, tone: 'bull' },
      { label: 'Loss', value: fmtMoney(b.loss), tone: 'bear' },
      {
        label: 'Net',
        value: `${b.netProfit >= 0 ? '+' : ''}${fmtMoney(b.netProfit)}`,
        tone: b.netProfit >= 0 ? 'bull' : 'bear',
        total: true,
      },
    ];
  }
  return [{
    label: metricLabel,
    value: metric === 'closedOrders' ? fmtNum(b.closedOrders, 0) : fmtMoney(Number(b[metric] || 0)),
    tone: 'primary',
  }];
};

/** Which bucket a tap at `x` (in drawing coordinates) lands on, or null outside the plot. */
export const bucketAt = (x: number, g: ChartGeometry, count: number): number | null => {
  if (!count) return null;
  const i = Math.floor((x - g.pad.left) / g.slot);
  return i >= 0 && i < count ? i : null;
};

/* ── Asset allocation buckets ─────────────────────────────────────────── */

/** EquityHub's buckets — Indian market segments (Dashboard.jsx:106). */
export const ALLOC_KEYS = ['STOCK', 'INDEX', 'FUTURE', 'OPTION', 'COMMODITY', 'OTHER'] as const;
export type AllocKey = (typeof ALLOC_KEYS)[number];

/** Dashboard.jsx:1381 — the card's own palette. */
export const ALLOC_COLORS: Readonly<Record<AllocKey, string>> = {
  FUTURE: '#3B82F6',
  INDEX: '#22C55E',
  COMMODITY: '#F59E0B',
  OPTION: '#8B5CF6',
  STOCK: '#38BDF8',
  OTHER: '#9CA3AF',
};

/** Dashboard.jsx:1355. */
export const CAT_NAME: Readonly<Record<AllocKey, string>> = {
  STOCK: 'Stocks',
  INDEX: 'Indices',
  FUTURE: 'Futures',
  OPTION: 'Options',
  COMMODITY: 'Commodities',
  OTHER: 'Other',
};

export interface AllocSource {
  symbol: string;
  /** The position's category (the instrument's when the position has none). */
  category?: string | null;
  instrument?: Pick<Instrument, 'segment' | 'exchange' | 'category'> | null;
}

/**
 * Dashboard.jsx:1361-1371 `allocKeyOf`. Options are also recognised by
 * symbol (NIFTY27OCT2624000CE) because option contracts are not in the
 * cached instrument catalogue; any MCX contract (futures included) is a
 * commodity; the remaining futures (NFO/BFO) are Futures.
 */
export const allocKeyOf = (p: AllocSource): AllocKey => {
  const inst = p.instrument ?? null;
  const seg = String(inst?.segment || '').toUpperCase();
  const sym = String(p.symbol || '').toUpperCase();
  const cat = String(p.category || inst?.category || '').toUpperCase();
  if (seg === 'OPT' || /\d(CE|PE)$/.test(sym)) return 'OPTION';
  if (String(inst?.exchange || '').toUpperCase() === 'MCX' || cat === 'COMMODITY') return 'COMMODITY';
  if (seg === 'FUT' || /FUT$/.test(sym)) return 'FUTURE';
  if (cat === 'INDEX' || cat === 'STOCK') return cat;
  return 'OTHER';
};

/* ── Positions ────────────────────────────────────────────────────────── */

/**
 * One open position as the cards draw it (Dashboard.jsx:95-103).
 *
 * The mark is the live tick when one has arrived, else the server's
 * `markPrice`. P&L at a tick is re-marked with the server's own formula
 * (orderController.listPositions: (mark − entry) × qty for a long, the
 * reverse for a short — sign by positionSide, PORT-RULINGS §2); with no tick
 * it is the server's `unrealizedPnl`, which is the same formula at its mark.
 */
export interface LivePosition {
  position: Position;
  instrument: Instrument | null;
  mark: number;
  pnl: number;
  /** |qty × mark|, rupees. */
  notional: number;
  /** Upper-case category — the instrument's, else OTHER. */
  category: string;
  /** The Asset Allocation bucket. */
  allocKey: AllocKey;
  /** Display precision: min(pricePrecision || 2, 5). */
  prec: number;
  long: boolean;
}

export const livePosition = (p: Position, tick: number | undefined, inst: Instrument | null | undefined): LivePosition => {
  const entry = n0(p.entryPrice);
  const qty = n0(p.quantity);
  const long = p.positionSide ? p.positionSide === 'LONG' : p.side === 'BUY';
  const hasTick = typeof tick === 'number' && Number.isFinite(tick);
  const serverMark = Number(p.markPrice ?? p.entryPrice);
  const mark = hasTick ? tick : Number.isFinite(serverMark) ? serverMark : entry;
  const pnl = hasTick ? ((long ? (mark - entry) * qty : (entry - mark) * qty) || 0) : n0(p.unrealizedPnl);
  const category = String(inst?.category || 'OTHER').toUpperCase();
  return {
    position: p,
    instrument: inst ?? null,
    mark,
    pnl,
    notional: Math.abs(qty * mark),
    category,
    allocKey: allocKeyOf({ symbol: p.symbol, category, instrument: inst ?? null }),
    prec: Math.min(inst?.pricePrecision || 2, 5),
    long,
  };
};

/** PositionCard / MiniPositionCard's derived percentages (Dashboard.jsx:385-387). */
export const positionPercents = (lp: LivePosition): { pnlPct: number; movePct: number } => {
  const entry = n0(lp.position.entryPrice);
  const qty = n0(lp.position.quantity);
  const cost = qty * entry;
  return {
    pnlPct: entry > 0 && cost !== 0 ? (lp.pnl / cost) * 100 : 0,
    movePct: entry > 0 ? ((lp.mark - entry) / entry) * 100 * (lp.long ? 1 : -1) : 0,
  };
};

/**
 * Dashboard.jsx:421 — the line under the symbol. The card's category is
 * never empty (livePositions defaults it to OTHER), so a position with no
 * catalogue row reads "Other", as on the web.
 */
export const positionSubtitle = (inst: Pick<Instrument, 'name'> | null | undefined, category: string | null | undefined): string => {
  if (inst?.name) return inst.name;
  if (category) return category.charAt(0) + category.slice(1).toLowerCase();
  return 'Position';
};

/** Dashboard.jsx:74-78 — every symbol the page holds. */
export const openSymbols = (
  summary: Pick<DashboardSummary, 'equity'> | null,
  positions: readonly Pick<Position, 'symbol'>[],
): string[] => [...new Set([
  ...(summary?.equity.openPositions ?? []).map((p) => p.symbol),
  ...positions.map((p) => p.symbol),
].filter(Boolean))].sort();

/** The web's `p._id || `${symbol}-${entryPrice}`` React key. */
export const positionKey = (p: Pick<Position, 'id' | 'symbol' | 'entryPrice'>): string => p.id || `${p.symbol}-${p.entryPrice}`;

/* ── Account scope (allocation + accounts table) ──────────────────────── */

export type AccountScope = 'all' | 'real' | 'demo' | (string & {});

export interface ScopeOption { k: AccountScope; label: string }

/** Dashboard.jsx:1429-1434 / 1644-1649. A divider sits before index 3. */
export const accountScopeOptions = (
  accounts: readonly Pick<UserAccount, 'id' | 'accountNumber' | 'accountType'>[],
): ScopeOption[] => [
  { k: 'all', label: 'All Accounts' },
  { k: 'real', label: 'All Real Accounts' },
  { k: 'demo', label: 'All Demo Accounts' },
  ...accounts.map((a) => ({
    k: a.id,
    label: `${a.accountNumber || a.id.slice(-6)} (${isDemoLike(a.accountType) ? 'Demo' : 'Live'})`,
  })),
];

export const scopeLabel = (options: readonly ScopeOption[], scope: AccountScope): string =>
  options.find((o) => o.k === scope)?.label ?? 'All Accounts';

/**
 * Dashboard.jsx:1411-1417 — does a row on `accountId` fall inside the scope?
 * An account the list does not know is "real" to the web's `!isDemo(undefined)`.
 */
export const inScope = (
  accountId: string,
  scope: AccountScope,
  typeById: ReadonlyMap<string, string>,
): boolean => {
  if (scope === 'all') return true;
  const t = typeById.get(String(accountId));
  if (scope === 'real') return !isDemoLike(t);
  if (scope === 'demo') return isDemoLike(t);
  return String(accountId) === scope;
};

/* ── Asset allocation card ────────────────────────────────────────────── */

export interface Allocation { entries: [AllocKey, number][]; total: number }

/** Dashboard.jsx:1419-1427 — per-bucket exposure, largest first. */
export const allocationOf = (items: readonly Pick<LivePosition, 'allocKey' | 'notional'>[]): Allocation => {
  const b: Partial<Record<AllocKey, number>> = {};
  let total = 0;
  for (const p of items) {
    const v = Math.abs(Number(p.notional) || 0);
    b[p.allocKey] = (b[p.allocKey] ?? 0) + v;
    total += v;
  }
  return {
    entries: (Object.entries(b) as [AllocKey, number][]).filter(([, v]) => v > 0).sort((a, c) => c[1] - a[1]),
    total,
  };
};

export const DONUT = { R: 58, SW: 22, cx: 80, cy: 80 } as const;
export const DONUT_C = 2 * Math.PI * DONUT.R;

/** Dashboard.jsx:1437-1439 — one stroked arc per bucket. */
export const donutSegments = (entries: readonly [string, number][], total: number): { cat: string; len: number; off: number }[] => {
  let off = 0;
  return entries.map(([cat, val]) => {
    const len = total > 0 ? (val / total) * DONUT_C : 0;
    const s = { cat, len, off };
    off += len;
    return s;
  });
};

/* ── Accounts table ───────────────────────────────────────────────────── */

export interface AccountRow {
  account: UserAccount;
  demo: boolean;
  /** Σ the account's wallet rows; null until /wallet/balances answers. */
  balance: number | null;
  /** balance + floating; null with the balance. */
  equity: number | null;
  /** Σ the account's open positions' live P&L. */
  floating: number;
  /** floating / balance (0 without a positive balance); null with the balance. */
  pct: number | null;
  /** Realised since local midnight. */
  today: number;
  openN: number;
  positions: LivePosition[];
}

/**
 * Dashboard.jsx:1628-1642 — one row per account in the scope: the wallet
 * balance (/wallet/balances, every row is rupees), the floating P&L of its
 * open positions at the live marks, equity = balance + floating, P&L % of
 * the balance, and today's realised P&L.
 */
export const accountRows = (p: {
  accounts: readonly UserAccount[];
  scope: AccountScope;
  /** null = not loaded (or the read failed). */
  balances: readonly { accountId: string; balance: unknown }[] | null;
  positions: readonly LivePosition[];
  todayByAccount: Readonly<Record<string, number>>;
}): AccountRow[] =>
  p.accounts
    .filter((a) => {
      if (p.scope === 'all') return true;
      if (p.scope === 'real') return !isDemoLike(a.accountType);
      if (p.scope === 'demo') return isDemoLike(a.accountType);
      return String(a.id) === p.scope;
    })
    .map((a) => {
      const balance = p.balances
        ? p.balances.filter((b) => String(b.accountId) === String(a.id)).reduce((s, b) => s + n0(b.balance), 0)
        : null;
      const accPos = p.positions.filter((lp) => String(lp.position.accountId) === String(a.id));
      const floating = accPos.reduce((s, lp) => s + n0(lp.pnl), 0);
      return {
        account: a,
        demo: isDemoLike(a.accountType),
        balance,
        equity: balance === null ? null : balance + floating,
        floating,
        pct: balance === null ? null : balance > 0 ? (floating / balance) * 100 : 0,
        today: n0(p.todayByAccount[String(a.id)] || 0),
        openN: accPos.length,
        positions: accPos,
      };
    });

/** Dashboard.jsx:1625-1626. */
export const liveDemoCounts = (accounts: readonly Pick<UserAccount, 'accountType'>[]): { live: number; demo: number } => {
  const live = accounts.filter((a) => !isDemoLike(a.accountType)).length;
  return { live, demo: accounts.length - live };
};

/** Dashboard.jsx:1611-1613 — today's realised P&L per account. */
export const todayByAccount = (items: readonly Pick<Position, 'accountId' | 'realizedPnl'>[]): Record<string, number> => {
  const m: Record<string, number> = {};
  for (const it of items) {
    const k = String(it.accountId);
    m[k] = (m[k] ?? 0) + Number(it.realizedPnl || 0);
  }
  return m;
};

/** Local midnight as ISO — the web's `start.setHours(0,0,0,0)`. */
export const startOfTodayIso = (now: Date = new Date()): string => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

/** Dashboard.jsx:1585, 1724, 1760 — how an account is named on the row. */
export const accountShortLabel = (a: Pick<UserAccount, 'id' | 'accountNumber'>): string =>
  a.accountNumber || a.id.slice(-6);

/** Dashboard.jsx:1731. */
export const accountTypeLabel = (a: Pick<UserAccount, 'customTypeName' | 'nickname' | 'accountType'>): string =>
  a.customTypeName || a.nickname || a.accountType;

/** Dashboard.jsx:1721 — the two-character tile. */
export const accountTileText = (a: Pick<UserAccount, 'accountNumber'>): string => (a.accountNumber || 'AC').slice(-2);

/** Dashboard.jsx:1586 — the confirm, word for word. */
export const closeAllConfirmText = (label: string): string =>
  `Close ALL open positions on ${label}?\n\nThis places market orders to exit every open position and cannot be undone.`;

/** Dashboard.jsx:1591-1592 — partial outcomes are normal. */
export const closeAllOutcome = (r: CloseAllResult): { ok: boolean; message: string } => {
  if (r.failed.length) return { ok: false, message: `Closed ${r.closed}/${r.total} — ${r.failed.length} failed` };
  const n = r.closed ?? 0;
  return { ok: true, message: `Closed ${n} position${n === 1 ? '' : 's'}` };
};

/* ── Today's realised P&L per account ─────────────────────────────────── */

/**
 * The web asks for `limit: 500`; the server clamps a page to 200
 * (orderController.positionHistory), so a trader with more than 200 closes
 * today had the rest left out. The app pages through instead, up to this
 * many pages.
 */
export const TODAY_HISTORY_PAGE = 200;
export const TODAY_HISTORY_MAX_PAGES = 25;

/**
 * Is there another page to read? With the summary the server counts the
 * pages; asked for `summary: 0` it sends no count (orderController
 * positionHistory), and then only a full page can have a successor.
 */
export const hasMoreHistory = (
  page: number,
  res: { items: readonly unknown[]; pagination: { total: number; pages: number } },
): boolean => {
  if (page >= TODAY_HISTORY_MAX_PAGES) return false;
  if (res.pagination.total > 0) return page < res.pagination.pages;
  return res.items.length >= TODAY_HISTORY_PAGE;
};

/* ── Recent closed trades ─────────────────────────────────────────────── */

/** Dashboard.jsx:1807 — the six most recent closes. */
export const RECENT_CLOSED_LIMIT = 6;

/** Dashboard.jsx:1829 — the one P&L column's heading, `P&L ({symbol})`. */
export const CLOSED_PNL_HEADING = `P&L (${CURRENCY_SYMBOL})`;

export interface ClosedTradeView {
  key: string;
  symbol: string;
  buy: boolean;
  account: string;
  lot: string;
  open: string;
  close: string;
  pnl: number;
  pnlText: string;
}

/**
 * Dashboard.jsx:1838-1858. Prices keep the web's fixed 4 decimals; the P&L
 * is `signed(pnl)` ("+₹0.00" at zero). See the header for the Account column.
 */
export const closedTradeView = (
  t: Position,
  accountNumberById: ReadonlyMap<string, string>,
): ClosedTradeView => {
  const pnl = Number(t.realizedPnl || 0);
  const safe = Number.isFinite(pnl) ? pnl : 0;
  return {
    key: t.id || `${t.symbol}-${t.closedAt ?? ''}`,
    symbol: t.symbol,
    buy: String(t.side).toUpperCase() === 'BUY',
    account: accountNumberById.get(t.accountId) || String(t.accountId || '').slice(-6) || EMPTY,
    lot: fmtNum(t.quantity, 2),
    open: fmtNum(t.entryPrice, 4),
    close: t.closePrice !== null && t.closePrice !== undefined ? fmtNum(t.closePrice, 4) : EMPTY,
    pnl: safe,
    pnlText: fmtSigned(safe),
  };
};

/**
 * Dashboard.jsx:1373-1375 `fmtCloseTime` — "05 Sept 2026, 02:15 PM". The web
 * pins 'en-GB'; the app uses the device locale (PORT-RULINGS §5) with the
 * same fields, and upper-cases am/pm as the web does.
 */
export const fmtCloseTime = (d: string | null | undefined, locale?: string): string => {
  if (!d) return '-';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '-';
  return date
    .toLocaleString(locale, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
    .replace(/\b(am|pm)\b/i, (x) => x.toUpperCase());
};

/* ── Live ticks ───────────────────────────────────────────────────────── */

export interface TickBuffer {
  push(symbol: string, price: number): void;
  /** Deliver what is pending now. */
  flush(): void;
  /** Drop what is pending and stop the timer. */
  cancel(): void;
}

/**
 * Coalesce ticks: the latest price per symbol, delivered at most once per
 * `flushMs`. One state update per window however many symbols ticked.
 */
export const createTickBuffer = (
  flushMs: number,
  onFlush: (prices: Record<string, number>) => void,
): TickBuffer => {
  let pending: Record<string, number> = {};
  let has = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!has) return;
    const out = pending;
    pending = {};
    has = false;
    onFlush(out);
  };
  return {
    push(symbol, price) {
      if (!Number.isFinite(price)) return;
      pending[symbol] = price;
      has = true;
      if (!timer) timer = setTimeout(flush, flushMs);
    },
    flush,
    cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = {};
      has = false;
    },
  };
};

/** Merge a flush into the price map; the same object back when nothing moved. */
export const mergePrices = (
  prev: Readonly<Record<string, number>>,
  next: Readonly<Record<string, number>>,
): Record<string, number> => {
  let changed = false;
  for (const [k, v] of Object.entries(next)) {
    if (prev[k] !== v) { changed = true; break; }
  }
  return changed ? { ...prev, ...next } : (prev as Record<string, number>);
};

/** A tick's price — Dashboard.jsx:83 `Number(tick?.lastPrice ?? tick?.price ?? tick?.last)`. */
export const tickPrice = (tick: { lastPrice?: unknown; price?: unknown; last?: unknown } | null | undefined): number | null => {
  const raw = tick?.lastPrice ?? tick?.price ?? tick?.last;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/* ── Errors ───────────────────────────────────────────────────────────── */

const GENERIC_FAILURE = [/^Request failed/, /^Network Error$/, /^timeout of \d+ms exceeded$/];

/**
 * The server's own words, or null when all there is is the transport's
 * ("Request failed with status code 500"). The web read
 * `e.response.data.message`, which this server never sends (its errors are
 * `{ error: { message } }`), so it always fell to its fallback; the server's
 * reason is shown when there is one, the web's fallback otherwise.
 */
export const serverWords = (message: string | null | undefined): string | null => {
  const m = String(message ?? '').trim();
  if (!m) return null;
  return GENERIC_FAILURE.some((re) => re.test(m)) ? null : m;
};

/** Dashboard.jsx:1594 — a failed Close All. */
export const closeAllFailureText = (message: string | null | undefined): string =>
  serverWords(message) ?? 'Failed to close positions';
