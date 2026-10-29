import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { api } from '@/api/client';
import { bool, num, rows, str, strOrNull } from '@/types/api';
import { decOrNull, isoOrNull } from '@/types/market';
import type {
  CurrencyTotals,
  DashboardSummary,
  Decimal,
  LifetimeStats,
  OrderSide,
  PerformanceSeries,
  SeriesBucket,
  SeriesGrain,
} from '@/types/trading';
import { subscribeForeground, subscribeWallet } from '@/websocket/channels';

/**
 * The Portfolio dashboard's server figures — `/user/dashboard`,
 * `/user/dashboard/lifetime-stats` and `/user/dashboard/monthly-series`
 * (routes/user.js → dashboardController). Call sites: Dashboard.jsx,
 * AccountOverview.jsx, MarketList.jsx.
 *
 * EquityHub is INR-only, so every figure is rupees. `equity.live` and
 * `unrealizedPnl` are rolled up across ALL live accounts and priced off each
 * instrument's lastPrice; `equity.openPositions` is sent so the page can
 * re-mark the floating P&L tick by tick (utils/dashboard heroFigures).
 */

type Raw = Record<string, unknown>;

const asRaw = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

const payload = (body: unknown): unknown => {
  const env = asRaw(body);
  return 'data' in env ? env.data : body;
};

/** A server-formatted decimal ("123.45"), or '0.00' when absent — its own zero. */
const money = (v: unknown): string => decOrNull(v) ?? '0.00';

const count = (v: unknown): number => num(v) ?? 0;

const sideOf = (v: unknown): OrderSide => (str(v).toUpperCase() === 'SELL' ? 'SELL' : 'BUY');

/* ── Account filter ───────────────────────────────────────────────────── */

/**
 * The account dropdown's values (Dashboard.jsx:696-699). '' is every
 * account; the two sentinels are resolved server-side with the same
 * not-demo rule as PORT-RULINGS §3 (dashboardController.resolveAccountIds).
 */
export const DASHBOARD_ACCOUNT = {
  ALL: '',
  ALL_REAL: 'ALL_REAL',
  ALL_DEMO: 'ALL_DEMO',
} as const;

/** The stats card's windows, in the web's order and wording. */
export const STATS_TIME_RANGES = [
  { id: 0, label: 'Lifetime' },
  { id: 7, label: 'Last 7 days' },
  { id: 30, label: 'Last 30 days' },
  { id: 90, label: 'Last 90 days' },
  { id: 365, label: 'Last year' },
] as const;

/** The performance chart's ranges; the server picks the bucket grain. */
export const PERFORMANCE_RANGES = [
  { id: '1d', label: '1D' },
  { id: '1w', label: '1W' },
  { id: '1m', label: '1M' },
  { id: '3m', label: '3M' },
  { id: '1y', label: '1Y' },
  { id: 'all', label: 'ALL' },
] as const;
export type PerformanceRange = (typeof PERFORMANCE_RANGES)[number]['id'];

/** The performance chart's tabs — which bucket field each one plots. */
export const PERFORMANCE_METRICS = [
  { id: 'netProfit', label: 'Net profit', type: 'area' },
  { id: 'closedOrders', label: 'Closed orders', type: 'bar' },
  { id: 'tradingVolume', label: 'Trading volume', type: 'histogram' },
  { id: 'equity', label: 'Equity', type: 'curve' },
] as const;
export type PerformanceMetric = (typeof PERFORMANCE_METRICS)[number]['id'];

/* ── Adapters ─────────────────────────────────────────────────────────── */

const currencyTotals = (v: unknown): CurrencyTotals => {
  const out: CurrencyTotals = {};
  for (const [cur, t] of Object.entries(asRaw(v))) {
    const r = asRaw(t);
    out[cur.toUpperCase()] = { balance: num(r.balance) ?? 0, locked: num(r.locked) ?? 0, free: num(r.free) ?? 0 };
  }
  return out;
};

export const adaptDashboard = (rawIn: unknown): DashboardSummary => {
  const r = asRaw(rawIn);
  const u = asRaw(r.user);
  const bal = asRaw(r.balance);
  const eq = asRaw(r.equity);
  const pnl = asRaw(r.pnl);
  const acc = asRaw(r.accounts);
  const tr = asRaw(r.trades);
  return {
    user: {
      firstName: strOrNull(u.firstName),
      lastName: strOrNull(u.lastName),
      email: strOrNull(u.email),
      kycStatus: strOrNull(u.kycStatus),
      twoFactorEnabled: bool(u.twoFactorEnabled),
    },
    balance: {
      live: money(bal.live),
      demo: money(bal.demo),
      liveByCurrency: currencyTotals(bal.liveByCurrency),
      demoByCurrency: currencyTotals(bal.demoByCurrency),
      // The server's own fallback when the user has no wallet at all.
      primaryCurrency: (str(bal.primaryCurrency) || 'INR').toUpperCase(),
    },
    equity: {
      live: money(eq.live),
      unrealizedPnl: money(eq.unrealizedPnl),
      openPositions: rows<unknown>(eq.openPositions).map((p) => {
        const x = asRaw(p);
        return {
          symbol: str(x.symbol).toUpperCase(),
          side: sideOf(x.side),
          quantity: decOrNull(x.quantity) ?? '0',
          entryPrice: decOrNull(x.entryPrice) ?? '0',
        };
      }),
    },
    pnl: {
      realizedToday: money(pnl.realizedToday),
      realizedLifetime: money(pnl.realizedLifetime),
      // null = nothing decided yet. Not 0%.
      winRate: num(pnl.winRate),
      profit: money(pnl.profit),
      loss: money(pnl.loss),
      netProfit: money(pnl.netProfit),
      tradingVolume: money(pnl.tradingVolume),
    },
    accounts: { live: count(acc.live), demo: count(acc.demo) },
    trades: {
      totalLive: count(tr.totalLive),
      totalLiveToday: count(tr.totalLiveToday),
      totalDemo: count(tr.totalDemo),
      totalDemoToday: count(tr.totalDemoToday),
      openLive: count(tr.openLive),
      openDemo: count(tr.openDemo),
      closedLive: count(tr.closedLive),
      closedLiveToday: count(tr.closedLiveToday),
      winningLive: count(tr.winningLive),
      winningLiveToday: count(tr.winningLiveToday),
      losingLive: count(tr.losingLive),
      losingLiveToday: count(tr.losingLiveToday),
    },
    notifications: { unread: count(asRaw(r.notifications).unread) },
    recentActivity: rows<unknown>(r.recentActivity).map((a) => {
      const x = asRaw(a);
      return {
        id: str(x.id) || str(x._id),
        symbol: str(x.symbol).toUpperCase(),
        side: sideOf(x.side),
        price: decOrNull(x.price) ?? '0',
        quantity: decOrNull(x.quantity) ?? '0',
        executedAt: isoOrNull(x.executedAt),
        routing: strOrNull(x.routing),
      };
    }),
  };
};

/**
 * GET /user/dashboard/lifetime-stats — the eight figures every caller reads,
 * plus EquityHub's two (dashboardController.getLifetimeStats): `charges`,
 * the commissions + swap booked on the closes, and `netPnl`, the net profit
 * AFTER them (`netProfit` is gross). The server's no-accounts answer leaves
 * both out; they read '0.00' then, like every other absent figure.
 */
export interface DashboardLifetimeStats extends LifetimeStats {
  charges: Decimal;
  netPnl: Decimal;
}

export const adaptLifetimeStats = (rawIn: unknown): DashboardLifetimeStats => {
  const r = asRaw(rawIn);
  return {
    netProfit: money(r.netProfit),
    profit: money(r.profit),
    loss: money(r.loss),
    unrealizedPnl: money(r.unrealizedPnl),
    closedOrders: count(r.closedOrders),
    profitable: count(r.profitable),
    unprofitable: count(r.unprofitable),
    tradingVolume: money(r.tradingVolume),
    charges: money(r.charges),
    netPnl: money(r.netPnl),
  };
};

const GRAINS: readonly string[] = ['hour', 'day', 'week', 'month'];

export const adaptSeries = (rawIn: unknown): PerformanceSeries => {
  const r = asRaw(rawIn);
  const grain = str(r.grain).toLowerCase();
  return {
    grain: (GRAINS.includes(grain) ? grain : 'month') as SeriesGrain,
    // Absent when the user has no accounts (the server answers early).
    range: str(r.range),
    buckets: rows<unknown>(r.buckets).map((b): SeriesBucket => {
      const x = asRaw(b);
      return {
        key: str(x.key),
        label: str(x.label),
        tsStart: num(x.tsStart) ?? 0,
        netProfit: num(x.netProfit) ?? 0,
        profit: num(x.profit) ?? 0,
        loss: num(x.loss) ?? 0,
        closedOrders: num(x.closedOrders) ?? 0,
        tradingVolume: num(x.tradingVolume) ?? 0,
        equity: num(x.equity) ?? 0,
      };
    }),
  };
};

/* ── Endpoints ────────────────────────────────────────────────────────── */

/** GET /user/dashboard — the headline tiles, counts and recent fills. */
export const fetchDashboard = async (): Promise<DashboardSummary> => {
  const res = await api.get('/user/dashboard');
  return adaptDashboard(payload(res.data));
};

export interface LifetimeStatsQuery {
  /** Trades closed in the last N days; 0 or absent is lifetime. */
  days?: number;
  /** YYYY-MM-DD. A custom range wins over `days`; the whole `toDate` day counts. */
  fromDate?: string;
  toDate?: string;
  /** An account id, or a DASHBOARD_ACCOUNT sentinel. */
  accountId?: string;
}

/** The query exactly as Dashboard.jsx builds it. Exported for tests. */
export const lifetimeStatsParams = (q: LifetimeStatsQuery): Record<string, string> => {
  const p: Record<string, string> = {};
  if (q.fromDate && q.toDate) {
    p.fromDate = q.fromDate;
    p.toDate = q.toDate;
  } else if (q.days) {
    p.days = String(q.days);
  }
  if (q.accountId) p.accountId = q.accountId;
  return p;
};

/** GET /user/dashboard/lifetime-stats — the filterable stats card. */
export const fetchLifetimeStats = async (q: LifetimeStatsQuery = {}): Promise<DashboardLifetimeStats> => {
  const res = await api.get('/user/dashboard/lifetime-stats', { params: lifetimeStatsParams(q) });
  return adaptLifetimeStats(payload(res.data));
};

/**
 * GET /user/dashboard/monthly-series — the performance chart. Bucket labels
 * are formatted by the server and are shown verbatim.
 */
export const fetchPerformanceSeries = async (
  q: { range?: PerformanceRange; accountId?: string } = {},
): Promise<PerformanceSeries> => {
  const params: Record<string, string> = { range: q.range ?? '1y' };
  if (q.accountId) params.accountId = q.accountId;
  const res = await api.get('/user/dashboard/monthly-series', { params });
  return adaptSeries(payload(res.data));
};

/* ── Live dashboard ───────────────────────────────────────────────────── */

/** Dashboard.jsx polls every 15s while the tab is visible. */
export const DASHBOARD_POLL_MS = 15_000;

/**
 * `/user/dashboard`, kept current the way Dashboard.jsx keeps it: a 15s poll
 * that stops while the app is backgrounded (the web: tab hidden) and fires
 * once on return, plus a re-pull on every `user:wallet` event. Not on
 * `user:positions`: EquityHub's page dropped that subscription (every fill
 * and close also moves the wallet, so it fired a second identical request);
 * the page re-reads its positions list on it instead. A failed refresh
 * keeps the last figures.
 */
export function useDashboard(): {
  data: DashboardSummary | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const d = await fetchDashboard();
      if (alive.current) setData(d);
    } catch { /* keep the previous figures */ }
    finally { if (alive.current) setLoading(false); }
  }, []);

  useEffect(() => {
    alive.current = true;
    let poll: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!poll) poll = setInterval(() => { void refresh(); }, DASHBOARD_POLL_MS); };
    const stop = () => { if (poll) { clearInterval(poll); poll = null; } };

    void refresh();
    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (s) => { if (s !== 'active') stop(); });
    const offFg = subscribeForeground(() => { void refresh(); start(); });
    const offWallet = subscribeWallet(() => { void refresh(); });
    return () => {
      alive.current = false;
      stop();
      sub.remove();
      offFg();
      offWallet();
    };
  }, [refresh]);

  return { data, loading, refresh };
}
