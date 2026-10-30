/**
 * The Trade terminal's decisions (src/screens/trade/tradeLogic and friends)
 * — against EquityHub's own code where it can be lifted from Trade.jsx, and
 * pinned where the port differs on purpose (no synthetic depth, unknown
 * figures before the wallet answers).
 */
import fs from 'fs';
import path from 'path';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));

import { quickTradeQuote } from '@/charts/components/ChartToolbar';
import { orderModifyFields } from '@/screens/trade/components/TradeDialogs';
import { settingsHits } from '@/screens/trade/components/panels/ToolPanels';
import {
  DEFAULT_SYMBOL,
  MARKET_SEGMENTS,
  MOVER_CATS,
  aboutFor,
  accountFreeBalances,
  ageLabel,
  chartOrderRows,
  chartPositionRows,
  closeAllMessage,
  closeReasonInfo,
  closeTab,
  deriveBidAsk,
  depthView,
  distanceFromMarket,
  equityFigures,
  feeColumns,
  fillPnls,
  groupPositions,
  instrumentCategories,
  instrumentRows,
  leverageText,
  livePositionRow,
  maxLeverageLabel,
  orderTypeLabel,
  pendingSummary,
  performanceFigures,
  pickWalletFree,
  priceText,
  rankMovers,
  reconcileFilter,
  rejectedAt,
  rejectionText,
  restoreTabs,
  rowMeta,
  segmentLabel,
  summarisePositions,
  ticketShort,
  tradesFor,
  viewForSymbol,
  visibleRows,
  withTab,
  type LivePositionRow,
} from '@/screens/trade/tradeLogic';
import { clampBottom, restorePanes } from '@/screens/trade/tradeViewStore';
import type { Instrument, Order, Position } from '@/types/trading';

const ROOT = path.join(__dirname, '../../..');
const TRADE = fs.readFileSync(path.join(ROOT, 'client/src/pages/Trade.jsx'), 'utf8').replace(/\r\n/g, '\n');
const PRICE_CHART = fs.readFileSync(path.join(ROOT, 'client/src/components/PriceChart.jsx'), 'utf8').replace(/\r\n/g, '\n');
const between = (src: string, start: string, end: string): string => {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`slice start moved: ${start}`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`slice end moved: ${end}`);
  return src.slice(a, b);
};
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const lift = <T,>(params: string[], body: string): T => new Function(...params, body) as unknown as T;
/** Trade.jsx's segOf / catOf, for slices that call them (empty when the web build has none). */
const SEG_HELPERS = TRADE.includes('const segOf = ') ? between(TRADE, 'const segOf = ', 'const MARKET_SEGMENTS = [') : '';
/** The web terminal's segment chips — Trade.jsx MOVER_CATS, without 'All'. */
const WEB_SEGMENTS = (lift<() => { key: string; label: string }[]>(
  [],
  `${between(TRADE, 'const MOVER_CATS = [', '];')}];\nreturn MOVER_CATS;`,
)()).filter((c) => c.key !== 'ALL');

const position = (over: Partial<Position> = {}): Position => ({
  id: 'p1', accountId: 'a1', symbol: 'RELIANCE', side: 'BUY', positionSide: 'LONG', status: 'OPEN', quantity: '10', closedQuantity: '0',
  entryPrice: '2500', markPrice: '2501', leverage: 5, margin: '5000', realizedPnl: '0', unrealizedPnl: '10', commission: '0', swap: '0', openedAt: '2026-09-30T09:00:00Z', ...over,
} as Position);
const order = (over: Partial<Order> = {}): Order => ({
  id: 'o1', accountId: 'a1', symbol: 'RELIANCE', side: 'BUY', type: 'LIMIT', status: 'PENDING', quantity: '5', filledQuantity: '0', price: '2480', leverage: 5, createdAt: '2026-09-30T09:00:00Z', ...over,
} as Order);
const inst = (symbol: string, category: string, extra: Partial<Instrument> = {}): Instrument => ({
  id: symbol, symbol, name: `${symbol} name`, category, lastPrice: '10', spreadValue: '0.02', spreadType: 'FIXED', pricePrecision: 2, ...extra,
} as Instrument);

it('the terminal opens on NIFTY (Trade.jsx DEFAULT_SYMBOL)', () => {
  expect(TRADE).toContain(`const DEFAULT_SYMBOL = '${DEFAULT_SYMBOL}'`);
});

describe('individual trades of a netted position — Trade.jsx PositionsTable tradesFor', () => {
  const web = lift<(allFills: unknown[], p: unknown) => { _id: string; _dq: number; avgFillPrice: unknown }[]>(
    ['allFills', 'p'],
    `${between(TRADE, 'const tradesFor = (p) => {', '\n  };\n')}\n  };\nreturn tradesFor(p);`,
  );
  const fills = [
    { id: 'f1', _id: 'f1', symbol: 'RELIANCE', side: 'BUY', filledQuantity: '6', quantity: '6', avgFillPrice: '2490', filledAt: '2026-09-30T08:00:00Z', createdAt: '2026-09-30T08:00:00Z' },
    { id: 'f2', _id: 'f2', symbol: 'RELIANCE', side: 'BUY', filledQuantity: '7', quantity: '7', avgFillPrice: '2510', filledAt: '2026-09-30T08:30:00Z', createdAt: '2026-09-30T08:30:00Z' },
    { id: 'f3', _id: 'f3', symbol: 'RELIANCE', side: 'SELL', filledQuantity: '1', quantity: '1', avgFillPrice: '2400', filledAt: '2026-09-30T08:40:00Z', createdAt: '2026-09-30T08:40:00Z' },
    { id: 'f4', _id: 'f4', symbol: 'TCS', side: 'BUY', filledQuantity: '1', quantity: '1', avgFillPrice: '3900', filledAt: '2026-09-30T08:45:00Z', createdAt: '2026-09-30T08:45:00Z' },
  ];

  it('the newest same-side fills adding up to the open size, the last clamped — as the web', () => {
    const p = position();
    const mine = tradesFor(p, fills as unknown as Order[]);
    const theirs = web(fills, { ...p, _id: p.id });
    expect(mine.map((r) => [r.id, r.qty, r.price])).toEqual(theirs.map((r) => [r._id, r._dq, Number(r.avgFillPrice)]));
    expect(mine.map((r) => r.qty)).toEqual([7, 3]);
  });

  it('with no matching fill, the position itself', () => {
    expect(tradesFor(position({ symbol: 'INFY' }), fills as unknown as Order[])).toEqual([{ id: 'p1', side: 'BUY', qty: 10, price: 2500, at: '2026-09-30T09:00:00Z' }]);
  });

  it('each fill\'s P&L share sums to the group\'s', () => {
    const rows = tradesFor(position(), fills as unknown as Order[]);
    const shares = fillPnls(rows, 'BUY', 2520, 150, 10);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(150);
  });
});

describe('positions panel — Trade.jsx SidebarPositions', () => {
  const liveRows = (list: Position[]): LivePositionRow[] => list.map((p) => livePositionRow(p, {}, null, 'bid'));
  const list = [
    position({ id: 'a', quantity: '10', entryPrice: '2500', unrealizedPnl: '20' }),
    position({ id: 'b', quantity: '30', entryPrice: '2510', unrealizedPnl: '-10' }),
    position({ id: 'c', side: 'SELL', positionSide: 'SHORT', quantity: '5', entryPrice: '2600', unrealizedPnl: '5' }),
  ];

  it('groups by symbol + side with weighted entry and P&L — as the web', () => {
    const web = lift<(positions: unknown[]) => { key: string; totalQty: number; gPnl: number; avgEntry: number; gPnlPct: number }[]>(
      ['positions'],
      `${between(TRADE, '  const groupMap = new Map();', '  const fmtQty = ')}\nreturn groups;`,
    );
    const mine = groupPositions(liveRows(list));
    const theirs = web(list.map((p) => ({ ...p, _id: p.id })));
    expect(mine.map((g) => [g.key, g.totalQty, g.pnl, g.avgEntry, g.pnlPct])).toEqual(theirs.map((g) => [g.key, g.totalQty, g.gPnl, g.avgEntry, g.gPnlPct]));
    expect(mine.map((g) => g.key)).toEqual(['RELIANCE|BUY', 'RELIANCE|SELL']);
  });

  it('the summary card — as the web', () => {
    const web = lift<(positions: unknown[]) => { totalPnl: number; winners: number; losers: number; pnlPctTotal: number }>(
      ['positions'],
      `${between(TRADE, 'const totalPnl     = positions.reduce', '// ── Group positions by symbol')}\nreturn { totalPnl, winners, losers, pnlPctTotal };`,
    );
    const theirs = web(list);
    expect(summarisePositions(liveRows(list))).toEqual({ open: 3, totalPnl: theirs.totalPnl, pnlPct: theirs.pnlPctTotal, winners: theirs.winners, losers: theirs.losers });
    expect([theirs.totalPnl, theirs.winners, theirs.losers]).toEqual([15, 2, 1]);
  });
});

describe('live P&L (Trade.jsx positionsWithLivePnl)', () => {
  it('re-marks at the tick with the server formula; no tick → the server figure', () => {
    expect(livePositionRow(position(), { RELIANCE: 2503 }, null, 'bid').pnlLive).toBeCloseTo(30);
    expect(livePositionRow(position({ side: 'SELL', positionSide: 'SHORT' }), { RELIANCE: 2503 }, null, 'bid').pnlLive).toBeCloseTo(-30);
    expect(livePositionRow(position({ unrealizedPnl: '4.2' }), {}, null, 'bid').pnlLive).toBe(4.2);
  });

  it('the active symbol follows Settings → Price source', () => {
    const active = { symbol: 'RELIANCE', bid: 2502, ask: 2504 };
    expect(livePositionRow(position(), { RELIANCE: 2503 }, active, 'bid').markLive).toBe(2502);
    expect(livePositionRow(position(), { RELIANCE: 2503 }, active, 'ask').markLive).toBe(2504);
    expect(livePositionRow(position(), { RELIANCE: 2503 }, active, 'mid').markLive).toBeCloseTo(2503);
  });

  it('the chart gets every row, with the live P&L', () => {
    const rows = [livePositionRow(position(), {}, null, 'bid'), livePositionRow(position({ id: 'b', stopLoss: '2400' }), { RELIANCE: 2510 }, null, 'bid')];
    expect(chartPositionRows(rows).map((r) => [r.id, r.stopLoss, r.pnl])).toEqual([['p1', null, 10], ['b', '2400', 100]]);
    expect(chartOrderRows([order(), order({ id: 'o2', type: 'STOP', stopPrice: '2550' })]).map((o) => [o.id, o.price, o.stopPrice])).toEqual([['o1', '2480', null], ['o2', '2480', '2550']]);
  });
});

describe('account figures — Trade.jsx equityNums', () => {
  const web = lift<(walletFree: unknown, positionsWithLivePnl: unknown[], positions: unknown[]) => { equity: number; free: number; balance: number; used: number; marginLevel: number | null }>(
    ['walletFree', 'positionsWithLivePnl', 'positions'],
    `${between(TRADE, '    const walletAvail = Number(walletFree || 0);', '    return {\n      equity,')}\nreturn { equity, free: freeMargin, balance, used: usedMargin, marginLevel };`,
  );
  const rows = [
    { entryPrice: '2500', quantity: '10', leverage: 5, pnlLive: 30 },
    { entryPrice: '100', quantity: '50', leverage: 1, pnlLive: -20 },
  ];

  it('used = Σ entry × qty / leverage, balance = free + used, equity = balance + P&L — as the web', () => {
    const mine = equityFigures(10_000, rows);
    const theirs = web('10000', rows.map((r) => ({ ...r, unrealizedPnl: r.pnlLive })), rows);
    expect(mine).toEqual({ currency: 'INR', ...theirs });
    expect([mine.used, mine.balance, mine.equity, mine.free, mine.marginLevel]).toEqual([10_000, 20_000, 20_010, 10_010, 200.1]);
  });

  it('no position open: no margin in use, so no margin level (not 0%)', () => {
    expect(equityFigures(500, [])).toEqual({ currency: 'INR', equity: 500, balance: 500, free: 500, used: 0, marginLevel: null });
  });

  it('before the wallet answers, every figure is unknown (the web shows ₹0.00)', () => {
    expect(equityFigures(null, rows)).toEqual({ currency: 'INR', equity: null, balance: null, free: null, used: null, marginLevel: null });
  });

  it('wallet free: the base-currency row, else the first; free, else balance', () => {
    const balances = [{ currency: 'USD', free: '5', balance: '5' }, { currency: 'INR', free: '1200.5', balance: '1500' }] as never[];
    expect(pickWalletFree(balances, 'INR')).toBe(1200.5);
    expect(pickWalletFree(balances, 'EUR')).toBe(5);
    expect(pickWalletFree([{ currency: 'INR', free: null, balance: '900' }] as never[], 'INR')).toBe(900);
    expect(pickWalletFree([], 'INR')).toBe(0);
    expect(pickWalletFree(null, 'INR')).toBeNull();
  });

  it('the account switcher: each account\'s base-currency free balance', () => {
    const balances = [
      { accountId: 'a1', currency: 'INR', free: '100' },
      { accountId: 'a2', currency: 'INR', free: '250.5' },
      { accountId: 'a3', currency: 'INR', free: null },
    ] as never[];
    expect(accountFreeBalances(balances, [{ id: 'a1', baseCurrency: 'INR' }, { id: 'a2', baseCurrency: 'INR' }, { id: 'a3', baseCurrency: 'INR' }, { id: 'a4', baseCurrency: 'INR' }]))
      .toEqual({ a1: 100, a2: 250.5 });
  });

  it('leverage text — `1:${accLeverage}`', () => {
    expect(TRADE).toContain("['Account leverage', `1:${accLeverage}`]");
    expect([leverageText(100), leverageText(5), leverageText(null), leverageText(0)]).toEqual(['1:100', '1:5', '—', '—']);
  });
});

describe('market depth — the real book only', () => {
  const book = { bid: null, ask: null, lastPrice: '100', spreadValue: '0.2', spreadType: 'FIXED' } as Pick<Instrument, 'bid' | 'ask' | 'lastPrice' | 'spreadValue' | 'spreadType'>;
  it('no L2: ONE real top-of-book level a side, never a synthesised ladder', () => {
    const d = depthView(null, book, 101);
    expect(d.real).toBe(false);
    expect(d.asks).toEqual([{ price: 101.1, size: null, count: null, topOnly: true }]);
    expect(d.bids).toEqual([{ price: 100.9, size: null, count: null, topOnly: true }]);
    expect(d.totalAskSize).toBe(0);
    expect(d.mid).toBeCloseTo(101);
  });
  it('a real book: asks high→low, cumulative from the spread out, imbalance', () => {
    const d = depthView({
      symbol: 'X', ts: 1, source: null,
      asks: [{ price: '101', quantity: '2', count: 1 }, { price: '102', quantity: '1', count: 1 }],
      bids: [{ price: '100', quantity: '3', count: 1 }, { price: '99', quantity: '1', count: 1 }],
    } as never, book, 100.5);
    expect(d.asks.map((a) => a.price)).toEqual([102, 101]);
    expect(d.askCumul).toEqual([3, 2]);
    expect(d.bidCumul).toEqual([3, 4]);
    expect(d.bidPct).toBeCloseTo(4 / 7 * 100);
    expect(d.spread).toBe(1);
  });
  it('the web fabricates depth here — the port does not', () => {
    expect(TRADE).toContain('Synthesize a 10-level depth ladder');
    const d = depthView(null, book, 101);
    expect(d.asks.length + d.bids.length).toBe(2);
  });
});

describe('market segments — Trade.jsx MARKET_SEGMENTS', () => {
  const rows = [
    inst('NIFTY', 'INDEX', { exchange: 'NSE' }),
    inst('RELIANCE', 'STOCK', { exchange: 'NSE' }),
    inst('NIFTY26OCTFUT', 'INDEX', { exchange: 'NFO', segment: 'FUT', underlying: 'NIFTY' }),
    inst('NIFTY26OCT24000CE', 'INDEX', { exchange: 'NFO', segment: 'OPT' }),
    inst('CRUDEOIL26OCTFUT', 'COMMODITY', { exchange: 'MCX', segment: 'FUT' }),
  ];

  it('the same three segments and labels as the web; spot rows only, MCX by exchange', () => {
    expect(MARKET_SEGMENTS.map((s) => [s.key, s.label])).toEqual(WEB_SEGMENTS.map((s) => [s.key, s.label]));
    const hits = (r: Instrument): string[] => MARKET_SEGMENTS.filter((s) => s.match(r)).map((s) => s.key);
    expect(rows.map(hits)).toEqual([['INDEX'], ['STOCK'], [], [], ['COMMODITY']]);
    expect(MARKET_SEGMENTS.map((s) => s.label)).toEqual(['Stocks', 'Indices', 'MCX']);
  });

  it('Indices / Stocks are spot only; no Futures chip (an unknown key narrows nothing); MCX under MCX', () => {
    expect(visibleRows(rows, 'INDEX', [], '').map((r) => r.symbol)).toEqual(['NIFTY']);
    expect(visibleRows(rows, 'STOCK', [], '').map((r) => r.symbol)).toEqual(['RELIANCE']);
    expect(visibleRows(rows, 'FUT', [], '').map((r) => r.symbol)).toEqual(rows.map((r) => r.symbol));
    expect(visibleRows(rows, 'COMMODITY', [], '').map((r) => r.symbol)).toEqual(['CRUDEOIL26OCTFUT']);
    expect(visibleRows(rows, 'ALL', [], 'nifty').map((r) => r.symbol)).toEqual(['NIFTY', 'NIFTY26OCTFUT', 'NIFTY26OCT24000CE']);
  });

  it('only segments present in the data are offered (no F&O → no Futures chip)', () => {
    expect(instrumentCategories(rows)).toEqual(['STOCK', 'INDEX', 'COMMODITY']);
    expect(instrumentCategories(rows.slice(0, 2))).toEqual(['STOCK', 'INDEX']);
    expect([segmentLabel('FUT'), segmentLabel('COMMODITY'), segmentLabel('OTHER')]).toEqual(['FUT', 'MCX', 'OTHER']);
    expect(MOVER_CATS.map((c) => c.label)).toEqual(['All', 'Stocks', 'Indices', 'MCX']);
  });
});

describe('instruments panel', () => {
  it('bid / ask from the spread rule — fixed and percentage', () => {
    expect(deriveBidAsk(100, 0.2, 'FIXED')).toEqual({ bid: 99.9, ask: 100.1 });
    const pct = deriveBidAsk(100, 0.002, 'PERCENTAGE');
    expect([pct.bid, pct.ask].map((v) => Number(v.toFixed(6)))).toEqual([99.9, 100.1]);
    const rows = instrumentRows([inst('A', 'STOCK'), inst('B', 'STOCK', { isActive: false })], { A: 11 });
    expect(rows.map((r) => [r.symbol, r.last, Number(r.bid)])).toEqual([['A', 11, 10.99]]);
  });
  it('filter by watchlist or segment, then search within it; a stale filter falls back', () => {
    const rows = [inst('RELIANCE', 'STOCK'), inst('NIFTY', 'INDEX'), inst('TCS', 'STOCK')];
    const lists = [{ id: 'w1', items: [{ symbol: 'NIFTY' }, { symbol: 'TCS' }] }] as never;
    expect(visibleRows(rows, 'wl:w1', lists, '').map((r) => r.symbol)).toEqual(['NIFTY', 'TCS']);
    expect(visibleRows(rows, 'STOCK', lists, 'tc').map((r) => r.symbol)).toEqual(['TCS']);
    expect(reconcileFilter('wl:gone', ['STOCK'], [{ id: 'fav' }], 'fav')).toBe('wl:fav');
    expect(reconcileFilter('wl:gone', ['STOCK'], [], 'fav')).toBe('wl:gone');
    expect(reconcileFilter('FUT', ['INDEX', 'STOCK'], [], null)).toBe('ALL');
    expect(reconcileFilter('STOCK', ['INDEX', 'STOCK'], [], null)).toBe('STOCK');
  });
  it('movers: ranked within the chosen segment, counts per segment', () => {
    const rows = instrumentRows([
      inst('A', 'STOCK', { change24h: 1 }),
      inst('B', 'STOCK', { change24h: -2 }),
      inst('C', 'INDEX', { segment: 'FUT', exchange: 'NFO', change24h: 5 }),
      inst('D', 'COMMODITY', { segment: 'FUT', exchange: 'MCX' }),
    ], {});
    const r = rankMovers(rows, { D: { change24h: -7, dayHigh: 1, dayLow: 1, volume24h: 2_500_000, lastPrice: 3 } }, 'ALL');
    expect(r.gainers.map((m) => m.symbol)).toEqual(['C', 'A', 'B', 'D']);
    expect(r.losers.map((m) => m.symbol)).toEqual(['D', 'B', 'A', 'C']);
    // No Futures segment any more: the two futures count only under ALL (and MCX for the commodity one).
    expect(r.counts).toEqual({ ALL: 4, STOCK: 2, INDEX: 0, COMMODITY: 1 });
    expect(rankMovers(rows, {}, 'STOCK').gainers.map((m) => m.symbol)).toEqual(['A', 'B']);
  });
});

describe('the quick-trade chip (PriceChart.jsx)', () => {
  const web = lift<(instrument: unknown, pricePrecision: number) => { bid: number; ask: number; spread: number; prec: number }>(
    ['instrument', 'pricePrecision'],
    `${between(PRICE_CHART, 'const last = Number(instrument.lastPrice) || 0;', '            // Outer wrapper')}\nreturn { bid, ask, spread, prec };`,
  );
  it.each([
    [{ lastPrice: '2500.5', spreadValue: '0.1', spreadType: 'FIXED', pricePrecision: 2 }],
    [{ lastPrice: '24000', spreadValue: '0.001', spreadType: 'PERCENTAGE', pricePrecision: 2 }],
    [{ lastPrice: null, spreadValue: null, spreadType: null, pricePrecision: 0 }],
  ])('%j', (i) => {
    expect(quickTradeQuote(i as never, 2)).toEqual(web(i, 2));
  });
});

describe('rows and money', () => {
  it('ticket, order type, fees', () => {
    expect(ticketShort('66f0a1b2c3d4e5f6a7b8c9d0')).toBe('#B8C9D0');
    expect(ticketShort(null)).toBe('—');
    expect(orderTypeLabel({ side: 'SELL', type: 'STOP' })).toBe('Sell Stop');
    expect(orderTypeLabel({ side: 'BUY', type: 'LIMIT' })).toBe('Buy Limit');
    expect(feeColumns({ commission: '2', swap: '0.5', feeCategory: 'CHARGES' })).toEqual({ comm: 0, charges: 2.5 });
    expect(feeColumns({ commission: '2', swap: '0' })).toEqual({ comm: 2, charges: 0 });
  });
  it('every price is in rupees, grouped the Indian way', () => {
    expect(priceText('1234567.5', 'INR', 2)).toBe('₹12,34,567.50');
    expect(priceText('184.837', 'USD', 3)).toBe('₹184.837');
    expect(priceText(null, 'INR', 2)).toBe('—');
    expect(rowMeta(undefined)).toEqual({ quote: 'INR', prec: 4 });
    expect(rowMeta({ quoteCurrency: 'INR', pricePrecision: 2 })).toEqual({ quote: 'INR', prec: 2 });
  });
  it('pending cards', () => {
    expect(pendingSummary([order(), order({ id: 'b', side: 'SELL', type: 'STOP' }), order({ id: 'c' })])).toEqual({ count: 3, buy: 2, sell: 1, limit: 2, stop: 1 });
    expect(distanceFromMarket(2475, 2500)).toBeCloseTo(-1);
    expect(distanceFromMarket(0, 1)).toBeNull();
    const now = Date.parse('2026-09-30T12:00:00Z');
    expect([ageLabel('2026-09-30T11:59:40Z', now), ageLabel('2026-09-30T11:30:00Z', now), ageLabel('2026-09-30T07:00:00Z', now), ageLabel('2026-09-27T12:00:00Z', now), ageLabel(null, now)])
      .toEqual(['just now', '30m ago', '5h ago', '3d ago', null]);
  });
  it('close-all and leverage labels', () => {
    expect(TRADE).toContain('toast.success(`Closed ${r.closed} position(s)`)');
    expect(closeAllMessage({ closed: 3, total: 3, failed: [] })).toEqual({ ok: true, text: 'Closed 3 position(s)' });
    expect(closeAllMessage({ closed: 1, total: 3, failed: [1, 2] })).toEqual({ ok: false, text: 'Closed 1/3. 2 failed.' });
    expect(maxLeverageLabel({ maxLeverage: 50 }, true, 500)).toBe('1:50 · from instrument');
    expect(maxLeverageLabel({ maxLeverage: null }, true, 500)).toBe('Unlimited · demo');
    expect(maxLeverageLabel({ maxLeverage: null }, false, 500)).toBe('1:500 · from plan');
    expect(maxLeverageLabel({ maxLeverage: null }, false, null)).toBe('1:100 · default');
  });
  it('performance: instrument fields first, candles fill what they lack', () => {
    const f = performanceFigures({ lastPrice: '110', change24h: null, dayHigh: null, dayLow: null, bid: '109.9', ask: '110.1', volume24h: '1000' }, [{ close: 100, high: 101, low: 99 }, { close: 110, high: 112, low: 108 }], null);
    expect(f.change).toBeCloseTo(10);
    expect([f.hi, f.lo]).toEqual([112, 99]);
    expect(f.open24h).toBeCloseTo(100);
    expect(f.spreadBps).toBeCloseTo((0.2 / 110) * 10000);
    expect(f.turnover).toBe(110_000);
  });
});

// Our web build's About pane inlines the category (no `catOf(instrument)` slice to
// lift), so the web comparison is skipped there; the app's own expectations still run.
const HAS_WEB_ABOUT = TRADE.includes('            const cat = catOf(instrument);');
describe('the About pane — Trade.jsx', () => {
  const web = HAS_WEB_ABOUT
    ? lift<(instrument: unknown) => { desc: string; assetClass: string; hours: string }>(
      ['instrument'],
      `${SEG_HELPERS}${between(TRADE, '            const cat = catOf(instrument);', '            return (')}\nreturn { desc, assetClass, hours };`,
    )
    : null;
  (HAS_WEB_ABOUT ? it : it.skip).each([
    ['an index option', { category: 'INDEX', segment: 'OPT', exchange: 'NFO' }],
    ['an index future', { category: 'INDEX', segment: 'FUT', exchange: 'NFO', underlying: 'NIFTY' }],
    ['a stock future', { category: 'STOCK', segment: 'FUT', exchange: 'NFO', underlying: 'RELIANCE' }],
    ['an MCX future', { category: 'COMMODITY', segment: 'FUT', exchange: 'MCX' }],
    ['an NSE stock', { category: 'STOCK', segment: 'EQ', exchange: 'NSE' }],
    ['an MCX spot', { category: 'COMMODITY', exchange: 'MCX' }],
    ['an index', { category: 'INDEX', exchange: 'NSE' }],
    ['anything else', { category: '' }],
  ])('%s — as the web', (_label, i) => {
    expect(aboutFor(i as never)).toEqual(web!(i));
  });
  it('an index future names its underlying', () => {
    expect(aboutFor({ category: 'INDEX', segment: 'FUT', exchange: 'NFO', underlying: 'NIFTY' } as never))
      .toEqual({ desc: 'Index futures contract on NIFTY — trades in lots and expires on its contract date.', hours: 'Exchange hours', assetClass: 'Index futures' });
  });
});

describe('closed and rejected rows — Trade.jsx CLOSE_REASONS / RejectedTable', () => {
  const web = lift<(reason: unknown) => { t: string } | undefined>(
    ['reason'],
    `${between(TRADE, 'const CLOSE_REASONS = {', '\nfunction closeReasonLabel')}\nreturn CLOSE_REASONS[reason];`,
  );
  it.each(['TAKE_PROFIT', 'STOP_LOSS', 'TRAILING_STOP', 'STOP_OUT', 'MARGIN_STOPOUT', 'NEGATIVE_BALANCE', 'EXPIRY', 'INTRADAY_SQUAREOFF', 'INSTRUMENT_DISABLED_FORCE_CLOSE', 'COPY_MASTER_CLOSED', 'MANUAL', 'ADMIN'])(
    '%s — the web\'s label',
    (reason) => {
      expect(closeReasonInfo(reason).text).toBe(web(reason)?.t);
    },
  );
  it('none → a dash; an unknown one shown as what it was, never guessed', () => {
    expect(closeReasonInfo(null)).toEqual({ text: '—', tone: 'muted' });
    expect(closeReasonInfo('SOME_NEW_REASON')).toEqual({ text: 'Some New Reason', tone: 'muted' });
    expect([closeReasonInfo('STOP_OUT').tone, closeReasonInfo('TAKE_PROFIT').tone, closeReasonInfo('ADMIN').tone]).toEqual(['bear', 'bull', 'warn']);
  });
  it('a rejected order\'s reason, or "No reason recorded"; when = last write, else placement', () => {
    expect(TRADE).toContain('No reason recorded');
    expect(rejectionText({ rejectionReason: 'SEGMENT_DISABLED' })).toEqual({ text: 'SEGMENT_DISABLED', recorded: true });
    expect(rejectionText({ rejectionReason: null })).toEqual({ text: 'No reason recorded', recorded: false });
    expect(rejectedAt({ updatedAt: '2026-10-01T10:00:00Z', createdAt: '2026-10-01T09:00:00Z' })).toBe('2026-10-01T10:00:00Z');
    expect(rejectedAt({ updatedAt: null, createdAt: '2026-10-01T09:00:00Z' } as never)).toBe('2026-10-01T09:00:00Z');
  });
});

describe('tabs and per-instrument views', () => {
  it('tabs: restore, add, close to the neighbour, never the last', () => {
    expect(restoreTabs(['NIFTY', 'RELIANCE'], 'TCS')).toEqual(['NIFTY', 'RELIANCE', 'TCS']);
    expect(restoreTabs('junk', 'TCS')).toEqual(['TCS']);
    expect(withTab(['A'], 'A')).toEqual(['A']);
    expect(closeTab(['A', 'B', 'C'], 'B', 'B')).toEqual({ tabs: ['A', 'C'], nextActive: 'A' });
    expect(closeTab(['A', 'B', 'C'], 'A', 'A')).toEqual({ tabs: ['B', 'C'], nextActive: 'B' });
    expect(closeTab(['A', 'B'], 'B', 'A')).toEqual({ tabs: ['A'], nextActive: null });
    expect(closeTab(['A'], 'A', 'A')).toEqual({ tabs: ['A'], nextActive: null });
  });
  it('a symbol opens with its own view; first run migrates the old globals; a new symbol starts clean', () => {
    const legacy = { indicators: { ema21: true }, chartType: 'bars', timeframe: '15m' };
    expect(viewForSymbol({ ind: {}, ct: {}, tf: {} }, 'NIFTY', legacy)).toEqual({ indicators: { ema21: true }, chartType: 'bars', timeframe: '15m' });
    const maps = { ind: { RELIANCE: { rsi: true } }, ct: { RELIANCE: 'line' }, tf: { RELIANCE: '1h' } };
    expect(viewForSymbol(maps, 'RELIANCE', legacy)).toEqual({ indicators: { rsi: true }, chartType: 'line', timeframe: '1h' });
    expect(viewForSymbol(maps, 'NIFTY', legacy)).toEqual({ indicators: {}, chartType: 'candles', timeframe: '1m' });
    expect(viewForSymbol({ ind: {}, ct: { X: 'bogus' }, tf: { X: '7m' } }, 'X', legacy)).toMatchObject({ chartType: 'candles', timeframe: '1m' });
  });
  it('panes and the book split restore safely', () => {
    const panes = restorePanes([{ symbol: 'TCS', timeframe: '5m', chartType: 'line' }, { symbol: '' }, null], 'NIFTY', '1m');
    expect(panes).toHaveLength(8);
    expect(panes[0]).toEqual({ symbol: 'TCS', timeframe: '5m', chartType: 'line' });
    expect(panes[1]).toEqual({ symbol: 'NIFTY', timeframe: '1m' });
    expect(clampBottom({ height: 5000, collapsed: 1 })).toEqual({ height: 640, collapsed: true });
    expect(clampBottom(null)).toEqual({ height: 240, collapsed: false });
  });
});

describe('dialog helpers', () => {
  it('pending-order modify sends every field; an empty SL / TP clears it (PendingOrderModifyModal.jsx submit)', () => {
    expect(orderModifyFields(false, { price: '2480', qty: '5', sl: '', tp: '2600' })).toEqual({ price: '2480', quantity: '5', stopLoss: null, takeProfit: '2600' });
    expect(orderModifyFields(true, { price: '2550', qty: '5', sl: '2400', tp: '' })).toEqual({ stopPrice: '2550', quantity: '5', stopLoss: '2400', takeProfit: null });
  });
  it('settings search narrows to the matching sections', () => {
    expect(settingsHits('')).toBeNull();
    expect([...(settingsHits('mid price') ?? [])]).toEqual(['trading']);
    expect([...(settingsHits('impact') ?? [])]).toEqual(['calendar']);
    expect(settingsHits('zzz')?.size).toBe(0);
  });
});
