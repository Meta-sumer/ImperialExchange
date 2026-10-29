/**
 * Alerts, the Portfolio dashboard, Reports exports and the economic
 * calendar. No network, no file system — both are faked.
 *
 * The dashboard block checks the app against EQUITYHUB'S OWN SOURCE —
 * client/src/pages/Dashboard.jsx, utils/format.js, hooks/useMoney.js and the
 * backend controllers — not a re-typed copy: slices of the shipped web file
 * are lifted and run with `new Function` on the same inputs as the app's
 * utils/dashboard. If either side changes, the test fails. Where the port
 * differs on purpose, the difference is pinned instead of hidden.
 */
import fs from 'fs';
import path from 'path';

import { AxiosError, type InternalAxiosRequestConfig } from 'axios';

import {
  acknowledgeCurrent,
  createPriceAlert,
  fetchPriceAlerts,
  resetGlobalAlerts,
  useGlobalAlertStore,
  validatePriceAlert,
  visibleGlobalAlerts,
} from '@/api/alerts.api';
import { api, errorMessage } from '@/api/client';
import {
  adaptDashboard,
  adaptLifetimeStats,
  adaptSeries,
  fetchLifetimeStats,
  fetchPerformanceSeries,
  lifetimeStatsParams,
} from '@/api/dashboard.api';
import {
  actualTone,
  adminToCalendarEvent,
  calendarSectionEvents,
  calendarUpcomingEvents,
  groupCalendarByDay,
  sortAroundToday,
} from '@/api/news.api';
import { exportParams, exportReportCsv, fetchReportCsv, reportsWinRate } from '@/api/reports.api';
import { adaptPosition } from '@/api/trading.api';
import type { EconomicEvent as AdminEvent } from '@/types/cms';
import { adaptCalendarEvent, adaptPagination, type CalendarEvent } from '@/types/market';
import type { Instrument } from '@/types/trading';
import { toUserAccount } from '@/types/user';
import {
  accountRows,
  ALLOC_COLORS,
  ALLOC_KEYS,
  allocationOf,
  allocKeyOf,
  CAT_NAME,
  chartHeadline,
  chartStrip,
  CLOSED_PNL_HEADING,
  closedTradeView,
  fmtChartHeadline,
  hasMoreHistory,
  heroFigures,
  heroTexts,
  liveBalanceOf,
  livePosition,
  statsAccountOptions,
  statsRows,
  TODAY_HISTORY_MAX_PAGES,
  TODAY_HISTORY_PAGE,
  tooltipLines,
  type AccountScope,
} from '@/utils/dashboard';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const mockWritten: { uri: string; content: string }[] = [];
jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' },
  File: class {
    uri: string;

    constructor(dir: string, name: string) { this.uri = `${dir}/${name}`; }

    create() { /* created */ }

    write(content: string) { mockWritten.push({ uri: this.uri, content }); }
  },
}));
const mockShared: string[] = [];
jest.mock('expo-sharing', () => ({
  isAvailableAsync: async () => true,
  shareAsync: async (uri: string) => { mockShared.push(uri); },
}));

type Reply = { status?: number; data: unknown };
let calls: InternalAxiosRequestConfig[] = [];

const serve = (handler: (c: InternalAxiosRequestConfig) => Reply): void => {
  calls = [];
  api.defaults.adapter = async (config) => {
    calls.push(config);
    const r = handler(config);
    const response = { data: r.data, status: r.status ?? 200, statusText: '', headers: {}, config };
    if (response.status >= 400) {
      throw new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, null, response);
    }
    return response;
  };
};

const body = (c: InternalAxiosRequestConfig | undefined): unknown =>
  (typeof c?.data === 'string' ? JSON.parse(c.data) : c?.data);

/* ── EquityHub's source ───────────────────────────────────────────────── */

const ROOT = path.join(__dirname, '../../..');
/** LF only, so a CRLF checkout slices the same as this one. */
const readLf = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const web = (p: string): string => readLf(path.join(ROOT, 'client/src', p));
const backend = (p: string): string => readLf(path.join(ROOT, 'backend/src', p));
const appFile = (p: string): string => path.join(__dirname, '..', p);

/** The text from `start` up to (not including) `end`, or a loud failure. */
const between = (src: string, start: string, end: string, from = 0): string => {
  const a = src.indexOf(start, from);
  if (a < 0) throw new Error(`slice start moved: ${start}`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`slice end moved: ${end}`);
  return src.slice(a, b);
};

/** As `between`, without the `start` marker itself. */
const after = (src: string, start: string, end: string, from = 0): string =>
  between(src, start, end, from).slice(start.length);

const DASHBOARD = web('pages/Dashboard.jsx');
const FORMAT = web('utils/format.js');
const USE_MONEY = web('hooks/useMoney.js');

const stripExport = (s: string): string => s.replace(/export const /g, 'const ');

type Num = number | string;
interface WebMoney {
  fmtMoney: (v: Num) => string;
  money: (v: Num) => string;
  signed: (v: Num) => string;
  fmtMoneyBoth: (v: Num, cur?: string, rate?: null, withSign?: boolean) => { primary: string; secondary: string };
}

/** format.js fmtNum / fmtMoney / fmtMoneyBoth and useMoney's money / signed, as shipped. */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const W = new Function(`
  ${stripExport(between(FORMAT, 'export const CURRENCY_SYMBOL', 'export const fmtPrice'))}
  ${stripExport(between(FORMAT, 'export const fmtMoney', '/** Rupee amount'))}
  ${stripExport(between(FORMAT, 'const inrResult', '/**\n * Legacy name kept'))}
  ${stripExport(between(FORMAT, 'export const fmtMoneyBoth', '/** Instrument price'))}
  ${between(USE_MONEY, 'const toNum', 'const MONEY')}
  return { fmtMoney, money, signed, fmtMoneyBoth };
`)() as WebMoney;

type WebInst = { symbol: string; name?: string; category?: string; exchange?: string | null; segment?: string | null; pricePrecision?: number };
type WebPos = Record<string, unknown> & { symbol: string; accountId: string; unrealizedPnl: number; notional: number; _inst?: WebInst };

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const webAllocKeyOf = new Function(`${between(DASHBOARD, 'function allocKeyOf(p) {', '\nconst fmtCloseTime')}\nreturn allocKeyOf;`)() as
  (p: { symbol: string; category?: string; _inst?: WebInst }) => string;

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const webLivePositions = new Function(
  'positions', 'priceMap', 'instruments',
  `return ${between(DASHBOARD, 'const livePositions = useMemo(() => ', ', [positions, priceMap, instruments]);').slice('const livePositions = useMemo(() => '.length)};`,
) as (positions: unknown[], priceMap: Record<string, number>, instruments: WebInst[]) => WebPos[];

const ALLOC_SLICE_FROM = DASHBOARD.indexOf('function AssetAllocationCard');
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const webAllocation = new Function(
  'filtered', 'allocKeyOf',
  between(DASHBOARD, 'const b = {}; let tot = 0;', '  }, [filtered]);', ALLOC_SLICE_FROM),
) as (filtered: WebPos[], allocKeyOf: typeof webAllocKeyOf) => { entries: [string, number][]; total: number };

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const webHero = new Function(
  'data', 'priceMap',
  `${between(DASHBOARD, '  const liveByCur = ', '  const todayPnl = ')}\nreturn { liveBalance, unrealized, equity };`,
) as (data: unknown, priceMap: Record<string, number>) => { liveBalance: number; unrealized: number; equity: number };

const STATS_FROM = DASHBOARD.indexOf('function PortfolioStats');
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const webStatsRows = new Function(
  'stats', 'fmtMoney',
  `${between(DASHBOARD, '  const sign = (n) =>', '\n  return (', STATS_FROM)}\nreturn rows;`,
) as (stats: unknown, fmtMoney: WebMoney['fmtMoney']) => { label: string; value: string; tone?: string; emphasis?: boolean }[];

const CHART_FROM = DASHBOARD.indexOf('function PortfolioChart');
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const webStrip = new Function(
  'buckets', 'sumStats', 'dashFromParent', 'signed', 'money',
  `${between(DASHBOARD, '  const netVals = ', '\n  return (', CHART_FROM)}\nreturn STRIP;`,
) as (buckets: unknown[], sumStats: unknown, dash: unknown, signed: WebMoney['signed'], money: WebMoney['money']) =>
  { label: string; value: string | number }[];

const TABLE_FROM = DASHBOARD.indexOf('function AccountsTable');
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const webAccountRows = new Function(
  'accounts', 'sel', 'balances', 'positions', 'todayByAcc',
  `${between(DASHBOARD, 'const toUsd = ', '\n', TABLE_FROM)}
   ${between(DASHBOARD, 'const isDemo = ', '\n', TABLE_FROM)}
   ${between(DASHBOARD, '  const rows = accounts.filter((a) => {', '\n  const options = [', TABLE_FROM)}
   return rows;`,
) as (accounts: unknown[], sel: string, balances: unknown[], positions: WebPos[], todayByAcc: Record<string, number>) =>
  { a: { _id: string }; bal: number; flo: number; equity: number; pct: number; today: number; openN: number }[];

/* ══ Price alerts ═════════════════════════════════════════════════════ */

describe('price alerts', () => {
  it('validates in the modal’s own words', () => {
    expect(validatePriceAlert({ symbol: 'RELIANCE', targetPrice: ' ' })).toBe('Symbol and target price are required');
    expect(validatePriceAlert({ symbol: '', targetPrice: '1.1' })).toBe('Symbol and target price are required');
    expect(validatePriceAlert({ symbol: 'RELIANCE', targetPrice: '2500' })).toBeNull();
  });

  it('posts the form as the web does', async () => {
    serve(() => ({ status: 201, data: { success: true, data: { _id: 'a1', symbol: 'RELIANCE', direction: 'ABOVE', targetPrice: '2500' } } }));
    const a = await createPriceAlert({ symbol: 'RELIANCE', direction: 'ABOVE', targetPrice: ' 2500 ' });
    expect(body(calls[0])).toEqual({ symbol: 'RELIANCE', direction: 'ABOVE', targetPrice: '2500', note: '', repeatable: false });
    expect(a.id).toBe('a1');
  });

  it('filters on active only when asked', async () => {
    serve(() => ({ data: { success: true, data: [] } }));
    await fetchPriceAlerts();
    await fetchPriceAlerts({ active: false });
    expect(calls[0]?.params).toBeUndefined();
    expect(calls[1]?.params).toEqual({ active: 'false' });
  });
});

/* ══ Global alerts ════════════════════════════════════════════════════ */

describe('global alert popup', () => {
  const g = (id: string) => ({
    id, title: id, message: '', priority: 'INFO' as const, requireAcknowledgement: true, repeatDisplay: false, createdAt: null,
  });

  beforeEach(() => resetGlobalAlerts());

  it('OK dismisses locally even when the acknowledge fails, and the next one shows', async () => {
    useGlobalAlertStore.setState({ pending: [g('a'), g('b')] });
    serve(() => ({ status: 500, data: { error: { message: 'down' } } }));
    await acknowledgeCurrent();
    expect(calls[0]?.url).toBe('/alerts/a/acknowledge');
    expect(visibleGlobalAlerts(useGlobalAlertStore.getState()).map((x) => x.id)).toEqual(['b']);
  });

  it('a repeat-display alert re-served by the poll stays dismissed this session', () => {
    useGlobalAlertStore.setState({ pending: [g('a'), g('b')], dismissed: ['a'] });
    expect(visibleGlobalAlerts(useGlobalAlertStore.getState()).map((x) => x.id)).toEqual(['b']);
  });
});

/* ══ Dashboard: the api adapters ══════════════════════════════════════ */

describe('dashboard api', () => {
  it('an empty body reads as zeros and nulls, never NaN — INR by default', () => {
    const d = adaptDashboard({});
    expect(d.balance).toMatchObject({ live: '0.00', primaryCurrency: 'INR', liveByCurrency: {} });
    expect(d.pnl.winRate).toBeNull();
    expect(d.trades.openLive).toBe(0);
    expect(d.recentActivity).toEqual([]);
  });

  it('carries the server strings and the rupee wallet totals through', () => {
    const d = adaptDashboard({
      balance: { live: '152000.25', liveByCurrency: { inr: { balance: 152000.25, locked: 1000, free: 151000.25 } }, primaryCurrency: 'INR' },
      pnl: { winRate: 62.5, loss: '-40.00' },
      recentActivity: [{ id: 't1', symbol: 'reliance', side: 'SELL', price: '2450.5', quantity: '10', executedAt: '2026-01-01T00:00:00Z' }],
    });
    expect(d.balance.liveByCurrency.INR).toEqual({ balance: 152000.25, locked: 1000, free: 151000.25 });
    expect(d.pnl).toMatchObject({ winRate: 62.5, loss: '-40.00' });
    expect(d.recentActivity[0]).toMatchObject({ symbol: 'RELIANCE', side: 'SELL', price: '2450.5' });
  });

  it('a custom range wins over the preset window', () => {
    expect(lifetimeStatsParams({ days: 30, fromDate: '2026-01-01', toDate: '2026-01-31', accountId: 'ALL_REAL' }))
      .toEqual({ fromDate: '2026-01-01', toDate: '2026-01-31', accountId: 'ALL_REAL' });
    expect(lifetimeStatsParams({ days: 7 })).toEqual({ days: '7' });
    expect(lifetimeStatsParams({ days: 0 })).toEqual({});
  });

  it('lifetime stats keep the signed loss', () => {
    expect(adaptLifetimeStats({ loss: '-12.50', closedOrders: 4 })).toMatchObject({ loss: '-12.50', closedOrders: 4, profit: '0.00' });
  });

  it('lifetime stats carry EquityHub’s charges and net-after-charges P&L (dashboardController)', async () => {
    const ctl = backend('controllers/dashboardController.js');
    const getLifetime = between(ctl, 'const getLifetimeStats', 'const getMonthlySeries');
    expect(getLifetime).toContain('charges: charges.toFixed(2)');
    expect(getLifetime).toContain('netPnl: netPnl.toFixed(2)');
    expect(getLifetime).toContain('const netPnl = netProfit - charges;');

    serve(() => ({ data: { success: true, data: { netProfit: '1500.00', charges: '120.40', netPnl: '1379.60' } } }));
    const s = await fetchLifetimeStats({ days: 30 });
    expect(calls[0]?.params).toEqual({ days: '30' });
    expect(s).toMatchObject({ netProfit: '1500.00', charges: '120.40', netPnl: '1379.60' });
    // The server's no-accounts answer sends neither — they read as zero, not NaN.
    expect(adaptLifetimeStats({ netProfit: '0.00' })).toMatchObject({ charges: '0.00', netPnl: '0.00' });
  });

  it('series buckets are read as sent, labels verbatim', async () => {
    serve(() => ({ data: { success: true, data: { grain: 'day', range: '1w', buckets: [{ key: '2026-01-01', label: 'Jan 1', tsStart: 1, netProfit: 5, equity: 5 }] } } }));
    const s = await fetchPerformanceSeries({ range: '1w', accountId: 'a1' });
    expect(calls[0]?.params).toEqual({ range: '1w', accountId: 'a1' });
    expect(s).toMatchObject({ grain: 'day', buckets: [{ label: 'Jan 1', netProfit: 5, loss: 0 }] });
    expect(adaptSeries({ buckets: [] }).grain).toBe('month');
  });
});

/* ══ Dashboard: what EquityHub's page does not have ═══════════════════ */

describe('dashboard — EquityHub has no broker card, no FX, no pushed metrics', () => {
  const dashboardSources = (): { file: string; text: string }[] => {
    const dir = appFile('screens/dashboard');
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    return [...walk(dir), appFile('utils/dashboard.ts'), appFile('api/dashboard.api.ts')]
      .map((file) => ({ file, text: readLf(file) }));
  };

  it('the web page renders no DhanFundsCard and no ExecutionBadge — and neither does the app', () => {
    expect(DASHBOARD).not.toMatch(/DhanFundsCard|ExecutionBadge/);
    expect(fs.existsSync(appFile('screens/dashboard/components/DhanFundsCard.tsx'))).toBe(false);
    for (const { file, text } of dashboardSources()) {
      expect({ file, hit: /DhanFundsCard|ExecutionBadge|fundsWithBroker|brokerApi/.test(text) }).toEqual({ file, hit: false });
    }
  });

  it('INR only: no USD, no FX rate, no conversion anywhere in the dashboard', () => {
    expect(DASHBOARD).not.toMatch(/useFxRate|fxRate\s*[,)}=]|\bUSD\b(?!\.)/.source.length ? /useFxRate/ : /$^/);
    expect(between(DASHBOARD, 'function AccountsTable', 'function RecentClosedTrades'))
      .toContain('const toUsd = (a) => Number(a) || 0;');
    for (const { file, text } of dashboardSources()) {
      expect({ file, hit: /\bUSD\b|fxRate|useUsdInr|toPrimary|accountMoney/.test(text) }).toEqual({ file, hit: false });
    }
  });

  it('no `user:account` METRICS subscription — EquityHub’s backend has no /trading/account-metrics', () => {
    expect(DASHBOARD).not.toContain("'user:account'");
    expect(backend('routes/trading.js')).not.toContain('account-metrics');
    for (const { file, text } of dashboardSources()) {
      expect({ file, hit: /AccountMetrics|account-metrics|subscribeAccountMetrics/.test(text) }).toEqual({ file, hit: false });
    }
  });

  it('the dashboard re-reads on `user:wallet` only; `user:positions` re-reads the positions list', () => {
    const wsEffect = between(DASHBOARD, '// ── WS auto-refresh on wallet events', '// ── Subscribe to live ticker');
    expect(wsEffect).toContain("wsClient.subscribe('user:wallet', refetch)");
    expect(wsEffect).not.toContain("wsClient.subscribe('user:positions'");
    const api = readLf(appFile('api/dashboard.api.ts'));
    const hook = between(api, 'export function useDashboard', '\n}\n');
    expect(hook).toContain('subscribeWallet(');
    expect(hook).not.toContain('subscribePositions(');
  });
});

/* ══ Dashboard: the hero band ═════════════════════════════════════════ */

describe('dashboard hero — a plain rupee sum, re-marked tick by tick', () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    balance: { live: '0.00', liveByCurrency: { INR: { balance: 152000.25, locked: 0, free: 0 }, inr2: { balance: 1000, locked: 0, free: 0 } }, primaryCurrency: 'INR' },
    equity: {
      unrealizedPnl: '4000.00',
      openPositions: [
        { symbol: 'RELIANCE', side: 'BUY', quantity: '10', entryPrice: '2400' },
        { symbol: 'NIFTY27OCT2624000CE', side: 'SELL', quantity: '75', entryPrice: '120' },
      ],
    },
    pnl: { realizedToday: '-250.50', winRate: 55 },
    ...over,
  });

  it.each([
    ['no ticks yet: the server’s floating figure', {}],
    ['a tick for only some positions: still the server’s', { RELIANCE: 2460 }],
    ['a tick for every position: re-marked', { RELIANCE: 2460, NIFTY27OCT2624000CE: 101.5 }],
  ] as const)('%s', (_name, priceMap) => {
    const w = webHero(raw(), priceMap);
    const app = heroFigures({ summary: adaptDashboard(raw()), priceMap });
    expect(app.balance).toBeCloseTo(w.liveBalance, 6);
    expect(app.unrealized).toBeCloseTo(w.unrealized, 6);
    expect(app.equity).toBeCloseTo(w.equity, 6);
  });

  it('balance.live wins when the server has it; zero sums every wallet row, no conversion', () => {
    expect(liveBalanceOf(adaptDashboard(raw({ balance: { live: '5000.00', liveByCurrency: { INR: { balance: 9 } } } })).balance)).toBe(5000);
    expect(liveBalanceOf(adaptDashboard(raw()).balance)).toBeCloseTo(153000.25, 6);
    expect(webHero(raw({ balance: { live: '5000.00', liveByCurrency: {} } }), {}).liveBalance).toBe(5000);
  });

  it('prints like the web: equity and balance as money, the P&L tiles with a sign', () => {
    for (const pm of [{}, { RELIANCE: 2300, NIFTY27OCT2624000CE: 150 }] as Record<string, number>[]) {
      const w = webHero(raw(), pm);
      const h = heroFigures({ summary: adaptDashboard(raw()), priceMap: pm });
      const text = heroTexts(h);
      expect(text.equity).toBe(W.fmtMoneyBoth(w.equity).primary);
      expect(text.floating).toBe(W.fmtMoneyBoth(w.unrealized, 'INR', null, true).primary);
      expect(text.today).toBe(W.fmtMoneyBoth(-250.5, 'INR', null, true).primary);
      expect(text.balance).toBe(W.fmtMoney(w.liveBalance));
    }
    expect(heroTexts({ equity: 0, unrealized: 0, today: 1234567.5, balance: 0 }))
      .toEqual({ equity: '₹0.00', floating: '₹0.00', today: '+₹12,34,567.50', balance: '₹0.00' });
  });

  it('the balance footer is one figure — no per-currency chips, no “(= …)” line', () => {
    const band = between(DASHBOARD, '{/* Balance footer */}', '{/* ── Lifetime portfolio stats block');
    expect(band).toContain('{fmtMoney(liveBalance)}');
    expect(band).not.toMatch(/secondary|liveByCur\)|currencySymbol/);
  });
});

/* ══ Dashboard: the trading summary ═══════════════════════════════════ */

describe('dashboard trading summary — the web’s ten cells in rupees', () => {
  const tone = (t: string | undefined): string => t ?? 'neutral';

  it.each([
    ['a mixed window', {
      netProfit: '12500.50', profit: '20000', loss: '-7499.50', unrealizedPnl: '-320.25',
      closedOrders: 12, profitable: 7, unprofitable: 5, tradingVolume: '1234567.8', charges: '350.75', netPnl: '12149.75',
    }],
    ['a losing window', {
      netProfit: '-800', profit: '200', loss: '-1000', unrealizedPnl: '45', closedOrders: 3, profitable: 1, unprofitable: 2,
      tradingVolume: '50000', charges: '60', netPnl: '-860',
    }],
    ['nothing at all', {}],
  ] as const)('%s', (_name, rawStats) => {
    const w = webStatsRows(rawStats, W.fmtMoney);
    const app = statsRows(adaptLifetimeStats(rawStats));
    expect(app.map((r) => [r.label, r.value, r.tone, !!r.emphasis]))
      .toEqual(w.map((r) => [r.label, r.value, tone(r.tone), !!r.emphasis]));
  });

  it('labels and order: Net profit · Net P&L · Profit · Loss · Charges · Unrealised P/L · … · Trading volume', () => {
    expect(statsRows(null).map((r) => r.label)).toEqual([
      'Net profit', 'Net P&L', 'Profit', 'Loss', 'Charges', 'Unrealised P/L',
      'Closed orders', 'Profitable', 'Unprofitable', 'Trading volume',
    ]);
    expect(statsRows(null).map((r) => r.value).join(' ')).not.toMatch(/USD|\$/);
  });

  it('deliberate: a net swap credit prints its sign once (the web would print “--₹”)', () => {
    const charges = (v: string): string | undefined => statsRows(adaptLifetimeStats({ charges: v })).find((r) => r.label === 'Charges')?.value;
    expect(charges('25.5')).toBe('-₹25.50');
    expect(charges('-25.5')).toBe('+₹25.50');
    expect(webStatsRows({ charges: '-25.5' }, W.fmtMoney).find((r) => r.label === 'Charges')?.value).toBe('--₹25.50');
  });

  it('the account picker reads “<name> · INR”', () => {
    expect(between(DASHBOARD, 'function PortfolioStats', 'function PortfolioChart')).toContain('{a.nickname || a.accountNumber} · INR');
    const accounts = [
      toUserAccount({ _id: 'a1', accountNumber: 'EH1001', accountType: 'STANDARD', nickname: 'Main' }),
      toUserAccount({ _id: 'd1', accountNumber: 'EH9001', accountType: 'DEMO' }),
    ];
    expect(statsAccountOptions(accounts)).toEqual([
      { value: '', label: 'All accounts' },
      { value: 'ALL_REAL', label: 'All Real Accounts' },
      { value: 'ALL_DEMO', label: 'All Demo Accounts' },
      { value: 'a1', label: 'Main · INR' },
      { value: 'd1', label: 'EH9001 · INR' },
    ]);
  });
});

/* ══ Dashboard: the analytics chart ═══════════════════════════════════ */

describe('dashboard analytics chart', () => {
  const bucket = (netProfit: number, extra: Record<string, number> = {}) =>
    ({ key: `k${netProfit}`, label: 'L', tsStart: 0, netProfit, profit: Math.max(netProfit, 0), loss: Math.min(netProfit, 0), closedOrders: 2, tradingVolume: 1000, equity: 5000, ...extra });
  const dashRaw = { pnl: { winRate: 62.5, profit: '900', loss: '-300' }, trades: { totalLive: 30, closedLive: 9 } };

  it.each([
    ['gains and losses', [1200, -300, 0, 450], { lifetime: { profit: '2000', loss: '-500', closedOrders: 12 } }],
    ['only losses: Best Day is +₹0.00', [-100, -50.25], { lifetime: { profit: '0', loss: '-150.25', closedOrders: 2 } }],
    ['only gains: Worst Day is ₹0.00', [10, 20], { lifetime: { profit: '30', loss: '0', closedOrders: 2 } }],
    ['no lifetime read: the strip falls back to the summary', [5], null],
  ] as const)('the strip matches the web: %s', (_name, nets, sumStats) => {
    const rawBuckets = nets.map((n) => bucket(n));
    const w = webStrip(rawBuckets, sumStats, dashRaw, W.signed, W.money);
    const lifetime = sumStats ? adaptLifetimeStats(sumStats.lifetime) : null;
    const app = chartStrip(adaptSeries({ buckets: rawBuckets }).buckets, lifetime, adaptDashboard(dashRaw));
    expect(app.map((c) => [c.label, c.value])).toEqual(w.map((c) => [c.label, String(c.value)]));
  });

  it('the headline and the tapped bucket’s card are money', () => {
    const b = adaptSeries({ buckets: [bucket(-1234.5, { profit: 100, loss: -1334.5, tradingVolume: 250000 })] }).buckets;
    expect(fmtChartHeadline(chartHeadline(b, 'netProfit'))).toBe(W.fmtMoney(-1234.5));
    expect(fmtChartHeadline(chartHeadline(b, 'tradingVolume'))).toBe('₹2,50,000.00');
    expect(fmtChartHeadline(chartHeadline(b, 'closedOrders'))).toBe('2');
    const bucket0 = b[0] as (typeof b)[number];
    expect(tooltipLines(bucket0, 'netProfit', 'Net profit').map((l) => l.value))
      .toEqual([`+${W.fmtMoney(100)}`, W.fmtMoney(-1334.5), W.fmtMoney(-1234.5)]);
    expect(tooltipLines({ ...bucket0, netProfit: 0 }, 'netProfit', 'Net profit')[2]?.value).toBe('+₹0.00');
    expect(tooltipLines(bucket0, 'equity', 'Equity')).toEqual([{ label: 'Equity', value: '₹5,000.00', tone: 'primary' }]);
  });

  it('takes the dashboard summary from the page — no second /user/dashboard read', () => {
    const chart = between(DASHBOARD, 'function PortfolioChart', '// Smooth path through points');
    expect(chart).not.toContain("api.get('/user/dashboard')");
    expect(chart).toContain('const dash = dashFromParent;');
  });
});

/* ══ Dashboard: positions and the allocation donut ════════════════════ */

const INSTRUMENTS: WebInst[] = [
  { symbol: 'RELIANCE', name: 'Reliance Industries', category: 'STOCK', exchange: 'NSE', segment: 'EQ', pricePrecision: 2 },
  { symbol: 'NIFTY', name: 'Nifty 50', category: 'INDEX', exchange: 'NSE', segment: null },
  { symbol: 'BANKNIFTY26OCTFUT', category: 'INDEX', exchange: 'NFO', segment: 'FUT' },
  { symbol: 'CRUDEOIL26NOVFUT', category: 'COMMODITY', exchange: 'MCX', segment: 'FUT' },
  { symbol: 'CRUDEOIL26NOV6000CE', category: 'COMMODITY', exchange: 'MCX', segment: 'OPT' },
  { symbol: 'GOLDM', category: 'STOCK', exchange: 'MCX', segment: 'COMM' },
  { symbol: 'BTCUSDT', category: 'CRYPTO' },
];
const appInst = (w: WebInst): Instrument => ({ id: w.symbol, name: '', ...w, category: w.category ?? 'OTHER' } as Instrument);
const instMap = new Map(INSTRUMENTS.map((i) => [i.symbol, appInst(i)] as const));

describe('dashboard allocation buckets — EquityHub’s Indian segments', () => {
  it('the buckets, names and colours are the web’s', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const evalObj = (src: string): Record<string, unknown> => new Function(`return ${src};`)() as Record<string, unknown>;
    expect(Object.keys(evalObj(after(DASHBOARD, 'const buckets = ', ';\n')))).toEqual([...ALLOC_KEYS]);
    expect(CAT_NAME).toEqual(evalObj(after(DASHBOARD, 'const CAT_NAME = ', ';\n')));
    expect(ALLOC_COLORS).toEqual(evalObj(after(DASHBOARD, 'const ALLOC_COLORS = ', ';\n')));
    expect(CAT_NAME).toEqual({ STOCK: 'Stocks', INDEX: 'Indices', FUTURE: 'Futures', OPTION: 'Options', COMMODITY: 'Commodities', OTHER: 'Other' });
  });

  it.each([
    ['RELIANCE', 'STOCK'],
    ['NIFTY', 'INDEX'],
    ['BANKNIFTY26OCTFUT', 'FUTURE'],
    ['CRUDEOIL26NOVFUT', 'COMMODITY'], // any MCX contract, futures included
    ['CRUDEOIL26NOV6000CE', 'OPTION'], // options win over MCX
    ['GOLDM', 'COMMODITY'], // MCX by exchange, whatever the category says
    ['NIFTY27OCT2624000CE', 'OPTION'], // not in the catalogue: recognised by symbol
    ['BANKNIFTY26OCT52000PE', 'OPTION'],
    ['TATAMOTORS26OCTFUT', 'FUTURE'], // not in the catalogue: by symbol
    ['BTCUSDT', 'OTHER'],
    ['UNLISTED', 'OTHER'],
  ])('%s → %s, as the web’s allocKeyOf', (symbol, key) => {
    const w = INSTRUMENTS.find((i) => i.symbol === symbol);
    const category = w?.category || 'OTHER';
    expect(webAllocKeyOf({ symbol, category, _inst: w })).toBe(key);
    expect(allocKeyOf({ symbol, category, instrument: w ? appInst(w) : null })).toBe(key);
  });
});

describe('dashboard positions, accounts table and donut — same figures as the web', () => {
  const RAW_POSITIONS = [
    { _id: 'p1', accountId: 'a1', symbol: 'RELIANCE', side: 'BUY', quantity: '10', entryPrice: '2400', markPrice: '2450', unrealizedPnl: '500' },
    { _id: 'p2', accountId: 'a1', symbol: 'NIFTY27OCT2624000CE', side: 'SELL', quantity: '75', entryPrice: '120', markPrice: '100', unrealizedPnl: '1500' },
    { _id: 'p3', accountId: 'a2', symbol: 'CRUDEOIL26NOVFUT', side: 'BUY', quantity: '100', entryPrice: '6000', markPrice: '5990', unrealizedPnl: '-1000' },
    { _id: 'p4', accountId: 'd1', symbol: 'BANKNIFTY26OCTFUT', side: 'BUY', quantity: '30', entryPrice: '52000', markPrice: '52100', unrealizedPnl: '3000' },
    { _id: 'p5', accountId: 'a2', symbol: 'BTCUSDT', side: 'SELL', quantity: '0.5', entryPrice: '5000000', markPrice: '5000000', unrealizedPnl: '0' },
  ];
  const PRICES: Record<string, number> = { RELIANCE: 2460.35, CRUDEOIL26NOVFUT: 5980 };
  const RAW_ACCOUNTS = [
    { _id: 'a1', accountNumber: 'EH1001', accountType: 'STANDARD', nickname: 'Main' },
    { _id: 'a2', accountNumber: 'EH1002', accountType: 'PRO' },
    { _id: 'd1', accountNumber: 'EH9001', accountType: 'DEMO' },
    { _id: 'e1', accountNumber: 'EH1003', accountType: 'FREE' },
  ];
  const BALANCES = [
    { accountId: 'a1', currency: 'INR', balance: '100000' },
    { accountId: 'a1', currency: 'INR', balance: '2500.50' },
    { accountId: 'a2', currency: 'INR', balance: '0' },
    { accountId: 'd1', currency: 'INR', balance: '1000000' },
  ];
  const TODAY = { a1: 1200, d1: -300 };

  const webLive = webLivePositions(RAW_POSITIONS, PRICES, INSTRUMENTS);
  const appLive = RAW_POSITIONS.map(adaptPosition).map((p) => livePosition(p, PRICES[p.symbol], instMap.get(p.symbol)));
  const accounts = RAW_ACCOUNTS.map(toUserAccount);

  it('each position: the live P&L, exposure and bucket', () => {
    expect(appLive.map((lp) => [lp.allocKey, lp.notional, lp.pnl]))
      .toEqual(webLive.map((p) => [webAllocKeyOf(p), p.notional, p.unrealizedPnl]).map(([k, n, pnl]) => [k, n, expect.closeTo(pnl as number, 6)]));
  });

  it('the donut: per-bucket rupee totals, largest first', () => {
    const w = webAllocation(webLive, webAllocKeyOf);
    const app = allocationOf(appLive);
    expect(app.total).toBeCloseTo(w.total, 6);
    expect(app.entries.map(([k]) => k)).toEqual(w.entries.map(([k]) => k));
    app.entries.forEach(([, v], i) => expect(v).toBeCloseTo((w.entries[i] as [string, number])[1], 6));
  });

  it.each(['all', 'real', 'demo', 'a2', 'e1'])('accounts table, scope “%s”: balance, equity, floating, P&L %, today', (sel) => {
    const w = webAccountRows(RAW_ACCOUNTS, sel, BALANCES, webLive, TODAY);
    const app = accountRows({ accounts, scope: sel as AccountScope, balances: BALANCES, positions: appLive, todayByAccount: TODAY });
    const pick = (r: { id: string; bal: number | null; flo: number; equity: number | null; pct: number | null; today: number; openN: number }) =>
      [r.id, r.bal, Number(r.flo.toFixed(6)), r.equity === null ? null : Number(r.equity.toFixed(6)), r.pct === null ? null : Number(r.pct.toFixed(6)), r.today, r.openN];
    expect(app.map((r) => pick({ id: r.account.id, bal: r.balance, flo: r.floating, equity: r.equity, pct: r.pct, today: r.today, openN: r.openN })))
      .toEqual(w.map((r) => pick({ id: r.a._id, bal: r.bal, flo: r.flo, equity: r.equity, pct: r.pct, today: r.today, openN: r.openN })));
  });

  it('deliberate: before /wallet/balances answers the balance is unknown (—), not ₹0.00', () => {
    const rows = accountRows({ accounts, scope: 'all', balances: null, positions: appLive, todayByAccount: {} });
    expect(rows.map((r) => [r.balance, r.equity, r.pct])).toEqual(rows.map(() => [null, null, null]));
    expect(rows[0]?.floating).toBeCloseTo(603.5 + 1500, 6);
  });
});

/* ══ Dashboard: recent closed trades and today's history ══════════════ */

describe('dashboard closed trades', () => {
  const closed = (pnl: string) => adaptPosition({
    _id: `c${pnl}`, accountId: 'acc000000a1', symbol: 'RELIANCE', side: 'BUY', quantity: '10', entryPrice: '2400',
    closePrice: '2450.5', realizedPnl: pnl, status: 'CLOSED', closedAt: '2026-10-21T09:30:00Z',
  });

  it('one P&L column, headed “P&L (₹)”, signed like the web', () => {
    const table = between(DASHBOARD, 'function RecentClosedTrades', 'function DashboardSkeleton');
    expect(table.match(/<th[^>]*>P&L \(/g)).toHaveLength(1);
    expect(table).toContain('P&L ({symbol})');
    expect(table).toContain('{signed(pnl)}');
    expect(CLOSED_PNL_HEADING).toBe('P&L (₹)');
    const byId = new Map([['acc000000a1', 'EH1001']]);
    for (const pnl of ['505', '-1234567.5', '0']) {
      expect(closedTradeView(closed(pnl), byId).pnlText).toBe(W.signed(pnl));
    }
    expect(closedTradeView(closed('505'), byId)).toMatchObject({ account: 'EH1001', lot: '10.00', open: '2,400.0000', close: '2,450.5000' });
    expect(closedTradeView(closed('5'), new Map()).account).toBe('0000a1');
  });

  it('the web asks for `summary: 0`, and the pager reads both answers the server can give', () => {
    expect(DASHBOARD.match(/summary: 0 }/g)).toHaveLength(2);
    const ctl = backend('controllers/orderController.js');
    const history = between(ctl, 'const positionHistory', 'const listPositions');
    expect(history).toContain("String(req.query.summary ?? '1') !== '0'");
    expect(history).toContain('{ items, pagination: { page, limit } }');

    const full = new Array(TODAY_HISTORY_PAGE).fill(0);
    // With the summary: the server's page count decides.
    expect(hasMoreHistory(1, { items: full, pagination: adaptPagination({ page: 1, limit: 200, total: 450, pages: 3 }) })).toBe(true);
    expect(hasMoreHistory(3, { items: full.slice(0, 50), pagination: adaptPagination({ page: 3, limit: 200, total: 450, pages: 3 }) })).toBe(false);
    // `summary: 0` sends no count: only a full page can have a successor.
    expect(hasMoreHistory(1, { items: full, pagination: adaptPagination({ page: 1, limit: 200 }) })).toBe(true);
    expect(hasMoreHistory(2, { items: full.slice(0, 120), pagination: adaptPagination({ page: 2, limit: 200 }) })).toBe(false);
    expect(hasMoreHistory(TODAY_HISTORY_MAX_PAGES, { items: full, pagination: adaptPagination({ page: 1, limit: 200 }) })).toBe(false);
  });
});

/* ══ Reports ══════════════════════════════════════════════════════════ */

describe('reports', () => {
  it('win rate leaves break-even out, as the web prints it', () => {
    expect(reportsWinRate({ wins: 2, losses: 1 })).toBe('66.7');
    expect(reportsWinRate({ wins: 0, losses: 0 })).toBe('0');
  });

  it('a date range is the whole LOCAL day at both ends', () => {
    const p = exportParams({ accountId: 'a1', from: '2026-03-01', to: '2026-03-01' });
    expect(p.accountId).toBe('a1');
    expect(p.from).toBe(new Date(2026, 2, 1, 0, 0, 0).toISOString());
    expect(p.to).toBe(new Date(2026, 2, 1, 23, 59, 59).toISOString());
    expect(exportParams({ from: 'garbage' })).toEqual({});
  });

  it('the CSV stays text, even when it looks like JSON', async () => {
    serve(() => ({ data: 'Date,Symbol\n2026-01-01,RELIANCE' }));
    expect(await fetchReportCsv('orders', { from: '2026-01-01' })).toBe('Date,Symbol\n2026-01-01,RELIANCE');
    expect(calls[0]?.url).toBe('/reports/export/orders.csv');
    expect(calls[0]?.responseType).toBe('text');
  });

  it("a refused export surfaces the server's reason, not 'Request failed'", async () => {
    serve(() => ({ status: 401, data: JSON.stringify({ success: false, error: { code: 'NO_TOKEN', message: 'Authentication required' } }) }));
    const err = await fetchReportCsv('ledger').catch((e: unknown) => e);
    expect(errorMessage(err)).toBe('Authentication required');
  });

  it('writes the file to the cache and opens the share sheet', async () => {
    serve(() => ({ data: 'a,b\n1,2' }));
    const uri = await exportReportCsv('positions');
    expect(uri).toBe('file:///cache/positions.csv');
    expect(mockWritten.at(-1)).toEqual({ uri, content: 'a,b\n1,2' });
    expect(mockShared.at(-1)).toBe(uri);
  });
});

/* ══ The economic calendar ════════════════════════════════════════════ */

describe('economic calendar', () => {
  const NOW = Date.parse('2026-01-10T12:00:00Z');
  const ev = (id: string, iso: string, extra: Record<string, unknown> = {}): CalendarEvent =>
    adaptCalendarEvent({ id, date: iso, event: id, currency: 'INR', country: 'IN', impact: 'high', ...extra }) as CalendarEvent;
  const admin = (id: string, iso: string): AdminEvent => ({
    id, date: iso, country: 'IN', currency: 'INR', impact: 'medium', event: id,
    previous: 1234.5, consensus: null, forecast: 6.5, actual: null, unit: '%',
  });

  const earlierToday = ev('earlierToday', '2026-01-10T08:00:00Z');
  const tomorrow = ev('tomorrow', '2026-01-11T12:30:00Z');
  const nextWeek = ev('nextWeek', '2026-01-17T12:30:00Z');
  const yesterday = ev('yesterday', '2026-01-09T12:30:00Z');
  const lastWeek = ev('lastWeek', '2026-01-03T12:30:00Z');
  const farFuture = ev('farFuture', '2026-03-01T12:30:00Z');

  it('orders today and the future first, soonest first, then the past newest first', () => {
    expect(sortAroundToday([lastWeek, tomorrow, yesterday, earlierToday, nextWeek], NOW).map((e) => e.id))
      .toEqual(['earlierToday', 'tomorrow', 'nextWeek', 'yesterday', 'lastWeek']);
  });

  it('the section window is 3 days back and 14 ahead', () => {
    const out = calendarSectionEvents([lastWeek, tomorrow, yesterday, earlierToday, nextWeek, farFuture], [], NOW);
    expect(out.map((e) => e.id)).toEqual(['earlierToday', 'tomorrow', 'nextWeek', 'yesterday']);
  });

  it('admin events join UNWINDOWED, formatted with their unit', () => {
    const out = calendarSectionEvents([tomorrow], [admin('adminOld', '2025-12-01T10:00:00Z')], NOW);
    expect(out.map((e) => e.id)).toEqual(['tomorrow', 'adminOld']);
    expect(out[1]).toMatchObject({ isAdmin: true, previousLabel: '1,234.5%', forecastLabel: '6.5%', actualLabel: null });
  });

  it('the card lists only what is still to come', () => {
    const out = calendarUpcomingEvents([earlierToday, tomorrow, nextWeek, yesterday], [admin('adminSoon', '2026-01-10T18:00:00Z')], NOW, 2);
    expect(out.map((e) => e.id)).toEqual(['adminSoon', 'tomorrow']);
  });

  it('an undatable admin event is dropped', () => {
    expect(adminToCalendarEvent(admin('bad', 'not a date'))).toBeNull();
  });

  it('groups by UTC day, keeping order', () => {
    const groups = groupCalendarByDay([earlierToday, ev('laterToday', '2026-01-10T20:00:00Z'), tomorrow]);
    expect(groups.map((g) => [g.day, g.events.length])).toEqual([['2026-01-10', 2], ['2026-01-11', 1]]);
  });

  it('actual vs consensus: lower is better for claims and unemployment', () => {
    expect(actualTone({ actual: 230, consensus: 220, event: 'Initial Jobless Claims' })).toBe('miss');
    expect(actualTone({ actual: 0.4, consensus: 0.3, event: 'CPI m/m' })).toBe('beat');
    expect(actualTone({ actual: null, consensus: 0.3, event: 'CPI m/m' })).toBeNull();
  });
});
