/**
 * The instrument page's numbers — checked against the WEB'S OWN SOURCE.
 *
 * Each block lifts a slice of EquityHub's client/src/pages/StockDetail.jsx,
 * runs it with `new Function`, and runs this app's version
 * (utils/stockDetail) on the same server-shaped inputs. If either side
 * changes, the test fails.
 *
 * Where the port differs on purpose — no invented figures, "—" for an
 * absent number — the test pins the difference. Every quote is in rupees.
 */
import fs from 'fs';
import path from 'path';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));

import { STOCK_CHART_RANGES } from '@/api/market.api';
import {
  adaptFundamentals,
  adaptOrderBook,
  normaliseCandles,
  trimLeadingFlat,
} from '@/types/market';
import type { Candle, Instrument } from '@/types/trading';
import { EMPTY } from '@/utils/money';
import {
  STOCK_TABS,
  candleCloseMs,
  candleRangeLabel,
  changeLabel,
  chartModel,
  crfmt,
  depthRows,
  depthSummary,
  financialBars,
  financialView,
  fmtFinLabel,
  fmtPx,
  fmtQty,
  fundamentalRows,
  indexAtX,
  kfmt,
  livePriceOf,
  newsEmptyText,
  newsMeta,
  niceCeil,
  performanceMetrics,
  rangePosition,
  rsi14,
  selectionInfo,
  selectionLabel,
  selectionRangeLabel,
  similarInstruments,
  sma,
  stockCurrency,
  stockFigures,
  stockNewsAgo,
  stockPrecision,
  technicalsView,
  week52,
  type FinMode,
} from '@/utils/stockDetail';
import { adaptInstrument } from '@/api/instruments.api';

const ROOT = path.join(__dirname, '../../..');
const readLf = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const SD = readLf(path.join(ROOT, 'client/src/pages/StockDetail.jsx'));
const FORMAT = readLf(path.join(ROOT, 'client/src/utils/format.js'));

const between = (src: string, start: string, end: string, from = 0): string => {
  const a = src.indexOf(start, from);
  if (a < 0) throw new Error(`slice start moved: ${start}`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`slice end moved: ${end}`);
  return src.slice(a, b);
};
const through = (src: string, start: string, end: string, from = 0): string => between(src, start, end, from) + end;
const at = (src: string, marker: string): number => {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error(`marker moved: ${marker}`);
  return i;
};
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const lift = <T,>(params: string[], body: string): ((...args: unknown[]) => T) =>
  new Function(...params, body) as (...args: unknown[]) => T;

/** The web's fmtNum — en-IN grouping for everything. */
const webFmtNum = lift<(v: unknown, d?: number) => string>(
  [],
  `${through(FORMAT, 'export const fmtNum = ', '\n};').replace('export ', '')}\nreturn fmtNum;`,
)();

/* ══ Fixtures, as the server sends them ═══════════════════════════════ */

// On the server's weekly bucket grid (epoch-aligned, 604 800 s — a Thursday,
// 2019-10-31) and in the past: normaliseCandles snaps to the grid and drops
// anything stamped after now, so a fixture must sit on both sides of that.
const T0 = 2600 * 604_800 * 1000;
interface RawCandle { openTime: string; closeTime: string; open: string; high: string; low: string; close: string; volume: string }
const rawSeries = (n: number, stepMin: number, px: (i: number) => number, vol: (i: number) => number = () => 1000): RawCandle[] =>
  Array.from({ length: n }, (_, i) => {
    const o = T0 + i * stepMin * 60_000;
    const c = px(i);
    const op = px(Math.max(0, i - 1));
    return {
      openTime: new Date(o).toISOString(),
      closeTime: new Date(o + stepMin * 60_000).toISOString(),
      open: op.toFixed(2),
      high: (Math.max(op, c) + 1.25).toFixed(2),
      low: (Math.min(op, c) - 0.75).toFixed(2),
      close: c.toFixed(2),
      volume: String(vol(i)),
    };
  });
const wave = (i: number): number => Math.round((120 + 9 * Math.sin(i / 4) + i * 0.35) * 100) / 100;
const RAW_DAY = rawSeries(80, 5, wave, (i) => 100 + i * 7);
const RAW_WEEKS = rawSeries(230, 7 * 24 * 60, (i) => Math.round((900 - i * 1.5 + 20 * Math.cos(i / 9)) * 100) / 100, (i) => 5000 + i);
const appCandles = (raw: RawCandle[], tf: string): Candle[] => normaliseCandles(raw, tf);

const RAW_INST = {
  _id: 'i1', symbol: 'RELIANCE', name: 'Reliance Industries', category: 'STOCK', exchange: 'NSE',
  quoteCurrency: 'INR', pricePrecision: 2, lastPrice: '2890.5', tickSize: '0.05', upperCircuit: '3179.55', lowerCircuit: '2601.45',
};
const INST = adaptInstrument(RAW_INST);

const RAW_FUND = {
  yahooSymbol: 'RELIANCE.NS', currency: 'INR', lastPrice: 2890.5, prevClose: 2875.2, dayHigh: 2901, dayLow: 2860,
  week52High: 3217.9, week52Low: 2220.3, volume: 5123456.5, marketCap: 1.955e13, peRatio: 28.456, eps: 101.57, pbRatio: 2.34,
  bookValue: 1234.5, roe: 0.0912, debtToEquity: 36.4, dividendYield: 0.0034, revenueGrowth: 0.071, earningsGrowth: -0.052,
  finQuarterly: [
    { label: '3Q2025', revenue: 2.31e12, profit: 1.8e11 },
    { label: '4Q2025', revenue: 2.44e12, profit: 1.91e11 },
    { label: '1Q2026', revenue: 2.52e12, profit: 1.75e11 },
    { label: '2Q2026', revenue: 2.61e12, profit: 1.99e11 },
  ],
  finYearly: [
    { label: '2022', revenue: 7.9e12, profit: 6.7e11 },
    { label: '2023', revenue: 8.8e12, profit: 7.3e11 },
    { label: '2024', revenue: 9.1e12, profit: 7.9e11 },
    { label: '2025', revenue: 9.6e12, profit: 8.1e11 },
  ],
};
const FUND = adaptFundamentals(RAW_FUND);

/* ══ Constants ════════════════════════════════════════════════════════ */

describe('ranges and tabs — StockDetail.jsx TF_MAP / TF_LIST / TABS', () => {
  const TF_MAP = lift<Record<string, { timeframe: string; limit: number }>>([], `${between(SD, 'const TF_MAP = ', ';\nconst TF_LIST')};\nreturn TF_MAP;`)();
  const TF_LIST = lift<string[]>([], `${through(SD, 'const TF_LIST = ', '];')}\nreturn TF_LIST;`)();
  const TABS = lift<string[]>([], `${through(SD, 'const TABS = ', '];')}\nreturn TABS;`)();

  it('the nine range chips, in order, ask for the same candles', () => {
    expect(STOCK_CHART_RANGES.map((r) => r.id)).toEqual(TF_LIST);
    for (const r of STOCK_CHART_RANGES) expect({ timeframe: r.timeframe, limit: r.limit }).toEqual(TF_MAP[r.id]);
  });

  it('the four tabs, in order and wording', () => {
    expect([...STOCK_TABS]).toEqual(TABS);
  });
});

describe('trimLeadingFlat — drops the leading carry-forward run, keeps one lead-in', () => {
  const web = lift<(c: unknown[]) => Array<{ close: string }>>([], `${through(SD, 'function trimLeadingFlat(candles) {', '\n}\n')}\nreturn trimLeadingFlat;`)();
  const flatThenReal: RawCandle[] = [
    ...rawSeries(6, 5, () => 100, () => 0),
    ...rawSeries(10, 5, (i) => 101 + i).map((c, i) => ({ ...c, openTime: new Date(T0 + (6 + i) * 300_000).toISOString() })),
  ];
  it.each([
    ['a flat pre-open run', flatThenReal],
    ['no flat run', RAW_DAY],
    ['all flat', rawSeries(5, 5, () => 50, () => 0)],
    ['too short', rawSeries(2, 5, () => 50, () => 0)],
  ])('%s', (_label, raw) => {
    const mine = trimLeadingFlat(appCandles(raw, '5m')).map((c) => c.close);
    expect(mine).toEqual(web(raw).map((c) => Number(c.close)));
  });
});

/* ══ Header figures ═══════════════════════════════════════════════════ */

describe('header figures — StockDetail.jsx:142-153', () => {
  const web = lift<Record<string, unknown>>(
    ['inst', 'live', 'candles'],
    `${through(SD, 'const prec = Math.min(inst?.pricePrecision', "const cur = '₹';")}
     return { prec, lastPrice, openPrice, change, pct, up, dayLow, dayHigh, isEquity, cur };`,
  );

  it.each([
    ['no tick: last close of the range', null],
    ['a live tick wins', { lastPrice: 131.4 }],
    ['a tick below the open', { lastPrice: 90.05 }],
  ])('%s', (_label, live) => {
    const w = web(RAW_INST, live, RAW_DAY);
    const f = stockFigures(appCandles(RAW_DAY, '5m'), livePriceOf(live), INST);
    expect(f.lastPrice).toBeCloseTo(w.lastPrice as number, 10);
    expect(f.openPrice).toBeCloseTo(w.openPrice as number, 10);
    expect(f.change).toBeCloseTo(w.change as number, 10);
    expect(f.pct).toBeCloseTo(w.pct as number, 10);
    expect(f.up).toBe(w.up);
    expect(f.dayLow).toBe(w.dayLow);
    expect(f.dayHigh).toBe(w.dayHigh);
    expect(stockPrecision(INST)).toBe(w.prec);
  });

  it('no candles: the row price, and the range collapses onto it', () => {
    const w = web(RAW_INST, null, []);
    const f = stockFigures([], null, INST);
    expect(f.lastPrice).toBe(w.lastPrice);
    expect(f.dayLow).toBe(w.dayLow);
    expect(f.change).toBe(0);
  });

  it('DIFFERENCE: nothing known is "—", not the web\'s ₹0.00', () => {
    const w = web({ ...RAW_INST, lastPrice: undefined }, null, []);
    expect(w.lastPrice).toBe(0);
    const f = stockFigures([], null, { lastPrice: null });
    expect(f.lastPrice).toBeNull();
    expect(fmtPx(f.lastPrice, 2, stockCurrency(INST))).toBe(EMPTY);
  });

  it.each([
    [{ category: 'STOCK', exchange: 'NSE', quoteCurrency: null }],
    [{ category: 'STOCK', exchange: 'BSE' }],
    [{ category: 'INDEX', exchange: 'NSE', quoteCurrency: 'INR' }],
    [{ category: 'COMMODITY', exchange: 'MCX' }],
    [{ category: 'INDEX', exchange: 'NFO', segment: 'OPT' }],
    [null],
  ])('every quote is in rupees — %j', (inst) => {
    expect(web(inst, null, []).cur).toBe('₹');
    expect(stockCurrency(inst as never)).toEqual({ symbol: '₹', group: 'INR' });
  });

  it.each([[0, 2], [undefined, 2], [1, 1], [4, 4], [8, 5]])('precision %s → %s', (p, want) => {
    expect(web({ pricePrecision: p }, null, []).prec).toBe(want);
    expect(stockPrecision({ pricePrecision: p } as never)).toBe(want);
  });

  it('the change line reads as the web builds it', () => {
    const cur = stockCurrency(INST);
    const up = stockFigures(appCandles(RAW_DAY, '5m'), 131.4, INST);
    const w = web(RAW_INST, { lastPrice: 131.4 }, RAW_DAY);
    const webLine = `${w.up ? '' : '-'}${w.cur as string}${webFmtNum(Math.abs(w.change as number), 2)} (${w.up ? '+' : ''}${(w.pct as number).toFixed(2)}%)`;
    expect(changeLabel(up, 2, cur)).toBe(webLine);
    const down = stockFigures(appCandles(RAW_DAY, '5m'), 90.05, INST);
    const w2 = web(RAW_INST, { lastPrice: 90.05 }, RAW_DAY);
    expect(changeLabel(down, 2, cur)).toBe(`-₹${webFmtNum(Math.abs(w2.change as number), 2)} (${(w2.pct as number).toFixed(2)}%)`);
  });

  it('a tick without a number is ignored, as the web\'s Number.isFinite guard', () => {
    expect(livePriceOf({ lastPrice: null })).toBeNull();
    expect(livePriceOf({ lastPrice: 'abc' })).toBeNull();
    expect(livePriceOf({ lastPrice: '12.5' })).toBe(12.5);
  });
});

/* ══ Overview ═════════════════════════════════════════════════════════ */

describe('Fundamentals grid — StockDetail.jsx:342-354', () => {
  const web = lift<Array<[string, string]>>(
    ['fund', 'cur', 'prec', 'fmtNum'],
    `${between(SD, 'const dash = (v, fmt)', 'const QTY = (r)')}\nreturn FUND;`,
  );

  it('₹: every label and value matches (a toFixed figure over 999 gains its separator)', () => {
    const w = web(RAW_FUND, '₹', 2, webFmtNum);
    // DIFFERENCE (CONTRACT §9 — no toFixed for display): the web prints
    // `bookValue.toFixed(2)` ungrouped; the port groups it like every figure.
    expect(w.find(([k]) => k === 'Book Value')).toEqual(['Book Value', '1234.50']);
    const want = w.map(([k, v]): [string, string] => (k === 'Book Value' ? [k, '1,234.50'] : [k, v]));
    expect(fundamentalRows(FUND, stockCurrency(INST), 2)).toEqual(want);
  });

  it('no fundamentals: every row is "—"', () => {
    expect(fundamentalRows(null, stockCurrency(INST), 2)).toEqual(web(null, '₹', 2, webFmtNum));
    expect(fundamentalRows(adaptFundamentals({}), stockCurrency(INST), 2).every(([, v]) => v === EMPTY)).toBe(true);
  });

  it('a large market cap groups the Indian way, as the web', () => {
    const big = adaptFundamentals({ marketCap: 3.1e16 });
    const row = fundamentalRows(big, stockCurrency(INST), 2)[0];
    expect(row).toEqual(['Market Cap', '₹3,10,00,00,000Cr']);
    expect(web({ marketCap: 3.1e16 }, '₹', 2, webFmtNum)[0]).toEqual(row);
  });
});

describe('Market depth — StockDetail.jsx:381-384 and DepthCol', () => {
  const web = lift<{ bidTotal: number; askTotal: number; buyPct: number }>(
    ['depth'],
    `const QTY = (r) => Number(r.quantity ?? r.qty ?? 0);\n${between(SD, 'const bidTotal = depth.bids', '\n\n  const similar')}\nreturn { bidTotal, askTotal, buyPct };`,
  );
  const RAW_BOOK = {
    bids: [[2890.45, 120], [2890.4, 50], [2890.35, 300], [2890.3, 10], [2890.25, 75], [2890.2, 999]],
    asks: [{ price: '2890.55', quantity: '80' }, { price: '2890.6', quantity: '40' }],
  };

  it('totals and the buy share, over every level the book carries', () => {
    const book = adaptOrderBook(RAW_BOOK, 'RELIANCE');
    const webDepth = {
      bids: RAW_BOOK.bids.map(([price, quantity]) => ({ price, quantity })),
      asks: RAW_BOOK.asks,
    };
    const w = web(webDepth);
    const d = depthSummary(book);
    expect(d.bidTotal).toBe(w.bidTotal);
    expect(d.askTotal).toBe(w.askTotal);
    expect(d.buyPct).toBeCloseTo(w.buyPct, 10);
  });

  it('an empty book is 50 / 50 with "No depth" rows — and no invented levels', () => {
    const d = depthSummary(adaptOrderBook({ bids: [], asks: [] }));
    expect(d).toMatchObject({ bidTotal: 0, askTotal: 0, buyPct: 50 });
    expect(depthRows(d.bids)).toEqual([]);
    // The web synthesises a random book here (OverviewTab `depth` + `pulse`).
    expect(SD).toContain('Math.random() * 3800');
  });

  it('a column shows the first five, bars against the column\'s largest', () => {
    const rows = depthRows(adaptOrderBook(RAW_BOOK).bids);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.qty)).toEqual([120, 50, 300, 10, 75]);
    expect(rows[2]?.widthPct).toBeCloseTo((300 / 999) * 100, 10);
  });

  it('quantities: the web\'s bare toLocaleString — up to three decimals', () => {
    const inr = stockCurrency(INST);
    expect(fmtQty(1234567, inr)).toBe((1234567).toLocaleString('en-IN'));
    expect(fmtQty(0.52349, inr)).toBe((0.52349).toLocaleString('en-IN'));
    expect(fmtQty(12.5, inr)).toBe('12.5');
    expect(fmtQty(1234567.25, inr)).toBe('12,34,567.25');
  });
});

describe('Performance — RangeBar and metrics', () => {
  const webPos = lift<number>(['value', 'v1', 'v2'], `${through(SD, 'const pos = v2 > v1', ': 50;')}\nreturn pos;`);

  it.each([[2890, 2860, 2901], [2800, 2860, 2901], [3000, 2860, 2901], [10, 10, 10], [5, 9, 3]])(
    'marker for %s in [%s, %s]',
    (v, lo, hi) => { expect(rangePosition(v, lo, hi)).toBe(webPos(v, lo, hi)); },
  );

  it('DIFFERENCE: an unknown end has no marker (the web invents dayLow × 0.72)', () => {
    expect(rangePosition(100, null, 120)).toBeNull();
    expect(week52(null)).toEqual({ low: null, high: null });
    expect(week52(FUND)).toEqual({ low: 2220.3, high: 3217.9 });
    expect(SD).toContain('fund?.week52Low ?? dayLow * 0.72');
  });

  it('the five metrics, real values', () => {
    const candles = appCandles(RAW_DAY, '5m');
    const f = stockFigures(candles, null, INST);
    const m = performanceMetrics(f, FUND, INST, candles, stockCurrency(INST), 2);
    expect(m).toEqual([
      ['Open price', `₹${webFmtNum(f.openPrice, 2)}`],
      ['Previous close', `₹${webFmtNum(2875.2, 2)}`],
      ['Live volume', (5123456.5).toLocaleString('en-IN')],
      ['Lower circuit', `₹${webFmtNum(2601.45, 2)}`],
      ['Upper circuit', `₹${webFmtNum(3179.55, 2)}`],
    ]);
  });

  it('without Yahoo: volume is the candles\' sum (the web\'s own fallback); the rest is "—"', () => {
    const candles = appCandles(RAW_DAY, '5m');
    const f = stockFigures(candles, null, INST);
    const bare = adaptInstrument({ ...RAW_INST, upperCircuit: null, lowerCircuit: '0' });
    const m = performanceMetrics(f, null, bare, candles, stockCurrency(INST), 2);
    const sum = RAW_DAY.reduce((s, c) => s + Number(c.volume), 0);
    expect(m).toEqual([
      ['Open price', `₹${webFmtNum(f.openPrice, 2)}`],
      ['Previous close', EMPTY],
      ['Live volume', sum.toLocaleString('en-IN')],
      ['Lower circuit', EMPTY],
      ['Upper circuit', EMPTY],
    ]);
    // The web shows the range's open as "Previous close" and ±10% as circuits.
    expect(SD).toContain('fund?.prevClose ?? openPrice');
    expect(SD).toContain('lastPrice * 0.9');
  });
});

describe('Similar stocks — StockDetail.jsx:386-388', () => {
  const web = lift<Array<{ symbol: string }>>(['instruments', 'symbol', 'inst'], `${through(SD, 'const similar = (instruments || [])', '.slice(0, 6);')}\nreturn similar;`);
  const rows = [
    { symbol: 'RELIANCE', category: 'STOCK' }, { symbol: 'TCS', category: 'STOCK' }, { symbol: 'EURUSD', category: 'FOREX' },
    ...Array.from({ length: 8 }, (_, i) => ({ symbol: `S${i}`, category: 'STOCK' })), { symbol: 'BTCUSD', category: 'CRYPTO' },
  ];
  it.each([
    ['a stock', 'RELIANCE', { category: 'STOCK' }],
    ['forex', 'GBPUSD', { category: 'FOREX' }],
    ['before the row loads (defaults to STOCK)', 'TCS', null],
  ])('%s', (_l, sym, inst) => {
    expect(similarInstruments(rows as Instrument[], sym, inst?.category).map((r) => r.symbol))
      .toEqual(web(rows, sym, inst).map((r) => r.symbol));
  });

  it('DIFFERENCE: no invented "Market cap" column; every row is in rupees', () => {
    expect(SD).toContain('p * 4.2e8 / 1e7');
    expect(fmtPx('3890.5', 2, stockCurrency({ category: 'STOCK', exchange: 'NSE' } as never))).toBe('₹3,890.50');
  });
});

/* ══ Financial performance ════════════════════════════════════════════ */

describe('Financial performance — StockDetail.jsx:535-580', () => {
  const helpers = `${through(SD, 'function niceCeil(v) {', '\n}\n')}\n${through(SD, 'function fmtFinLabel(l) {', '\n}\n')}`;
  const webNice = lift<(v: number) => number>([], `${helpers}\nreturn niceCeil;`)();
  const webLabel = lift<(l: string) => string>([], `${helpers}\nreturn fmtFinLabel;`)();
  const web = lift<Record<string, unknown>>(
    ['fund', 'mode', 'sel'],
    `${helpers}\n${between(SD, "const raw = mode === 'Quarterly'", '\n\n  const kfmt')}
     return { bars, selIdx, revG, prG, niceMax, ticks, cagrRev: cagr('revenue'), cagrPr: cagr('profit'), rev1y, pr1y, usedPlaceholder: !raw.length };`,
  );

  it.each([0, 0.3, 1, 1.2, 1.5, 1.9, 2.5, 4.2, 6, 6.99, 9.5, 12, 260, 26104.3, 1e9])('niceCeil(%s)', (v) => {
    expect(niceCeil(v)).toBe(webNice(v));
  });
  it.each(['1Q2025', '4Q2019', '2024', 'TTM', '', 'Q1'])('fmtFinLabel(%j)', (l) => {
    expect(fmtFinLabel(l)).toBe(webLabel(l));
  });

  it.each([
    ['Quarterly', null], ['Quarterly', 0], ['Quarterly', 2], ['Quarterly', 9],
    ['Yearly', null], ['Yearly', 1],
  ] as Array<[FinMode, number | null]>)('%s, selected %s', (mode, sel) => {
    const w = web(RAW_FUND, mode, sel);
    const v = financialView(FUND, mode, sel);
    expect(v.bars).toEqual(w.bars);
    expect(v.selIdx).toBe(w.selIdx);
    expect(v.revG).toBe(w.revG);
    expect(v.prG).toBe(w.prG);
    expect(v.niceMax).toBe(w.niceMax);
    expect(v.ticks).toEqual(w.ticks);
    expect(v.growth[0]?.three).toBe(w.cagrRev);
    expect(v.growth[1]?.three).toBe(w.cagrPr);
    expect(v.growth[0]?.one).toBe(w.rev1y);
    expect(v.growth[1]?.one).toBe(w.pr1y);
  });

  it('labels and crore figures', () => {
    const webFmt = lift<{ kfmt: (v: number) => string; crfmt: (v: number) => string }>(
      ['cur'],
      `${through(SD, 'const kfmt =', "toLocaleString('en-IN')}`;")}\nreturn { kfmt, crfmt };`,
    )('₹');
    for (const v of [0, 999, 26104.3, 250000, 1234567.8]) {
      expect(kfmt(v)).toBe(webFmt.kfmt(v));
      expect(crfmt(v, stockCurrency(INST))).toBe(webFmt.crfmt(v));
    }
  });

  it('DIFFERENCE: no Yahoo figures → no bars, where the web draws five made-up quarters', () => {
    const w = web(null, 'Quarterly', null);
    expect(w.usedPlaceholder).toBe(true);
    expect((w.bars as unknown[]).length).toBe(5);
    expect(financialBars(null, 'Quarterly')).toEqual([]);
    const v = financialView(null, 'Quarterly', null);
    expect(v.selBar).toBeNull();
    expect(v.growth.map((g) => [g.one, g.three])).toEqual([[null, null], [null, null]]);
  });

  it('3Y CAGR needs three positive years', () => {
    const two = adaptFundamentals({ finYearly: RAW_FUND.finYearly.slice(0, 2) });
    expect(financialView(two, 'Yearly', null).growth[0]?.three).toBeNull();
    const loss = adaptFundamentals({ finYearly: [{ label: '2023', revenue: 1, profit: -5 }, { label: '2024', revenue: 2, profit: 1 }, { label: '2025', revenue: 3, profit: 2 }] });
    expect(web({ finYearly: [{ label: '2023', revenue: 1, profit: -5 }, { label: '2024', revenue: 2, profit: 1 }, { label: '2025', revenue: 3, profit: 2 }] }, 'Yearly', null).cagrPr).toBeNull();
    expect(financialView(loss, 'Yearly', null).growth[1]?.three).toBeNull();
  });
});

/* ══ Technicals ═══════════════════════════════════════════════════════ */

describe('Technicals — StockDetail.jsx:653-703', () => {
  const smaRsi = between(SD, 'const sma = ', 'function TechnicalsTab');
  const webSma = lift<(a: number[], n: number) => number | null>([], `${smaRsi}\nreturn sma;`)();
  const webRsi = lift<(a: number[]) => number | null>([], `${smaRsi}\nreturn rsi14;`)();
  const web = lift<{ signal: string; sigColor: string; rows: Array<[string, string, string, boolean | null]>; mas: Array<[string, number]>; r: number | null }>(
    ['candles', 'lastPrice', 'cur', 'prec', 'fund', 'dayLow', 'dayHigh', 'fmtNum'],
    `${smaRsi}\n${between(SD, 'const closes = candles.map((c) => Number(c.close));', '  return (', at(SD, 'function TechnicalsTab('))}
     return { signal, sigColor, rows, mas, r };`,
  );

  it('SMA and RSI(14) on the same closes', () => {
    const closes = RAW_WEEKS.map((c) => Number(c.close));
    for (const n of [5, 20, 50, 200, 500]) expect(sma(closes, n)).toBe(webSma(closes, n));
    for (const k of [10, 14, 15, 30, 230]) expect(rsi14(closes.slice(0, k))).toBe(webRsi(closes.slice(0, k)));
    const rising = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(rsi14(rising)).toBe(100);
    expect(webRsi(rising)).toBe(100);
  });

  it.each([
    ['1D, 80 bars (SMA 20/50, RSI)', RAW_DAY, '5m', null],
    ['1D with a live tick far above', RAW_DAY, '5m', 400],
    ['3Y, 230 weekly bars (all three SMAs)', RAW_WEEKS, '1w', null],
    ['too few bars for anything', RAW_DAY.slice(0, 10), '5m', null],
  ])('%s', (_l, raw, tf, live) => {
    const candles = appCandles(raw, tf);
    const f = stockFigures(candles, live, INST);
    const w = web(raw, f.lastPrice, '₹', 2, RAW_FUND, f.dayLow, f.dayHigh, webFmtNum);
    const v = technicalsView(candles, f.lastPrice, FUND, f.dayLow, f.dayHigh, stockCurrency(INST), 2);
    expect(v.signal).toBe(w.signal);
    expect(v.signalColor).toBe(w.sigColor);
    expect(v.rows.map((r) => [r.indicator, r.value, r.signal, r.positive])).toEqual(w.rows);
    const bullish = w.mas.filter(([, m]) => (f.lastPrice as number) >= m).length;
    expect(v.summary).toBe(`${bullish} of ${w.mas.length} moving averages bullish${w.r != null ? ` · RSI ${w.r.toFixed(0)}` : ''}`);
    expect(v.footnote).toBe(`Computed live from ${raw.length} price candles. Not investment advice.`);
  });

  it('without Yahoo there is no 52-week row', () => {
    const candles = appCandles(RAW_DAY, '5m');
    const f = stockFigures(candles, null, INST);
    const w = web(RAW_DAY, f.lastPrice, '₹', 2, null, f.dayLow, f.dayHigh, webFmtNum);
    const v = technicalsView(candles, f.lastPrice, null, f.dayLow, f.dayHigh, stockCurrency(INST), 2);
    expect(v.rows.map((r) => r.indicator)).toEqual(w.rows.map((r) => r[0]));
    expect(v.rows.some((r) => r.indicator === '52-week range')).toBe(false);
  });
});

/* ══ News ═════════════════════════════════════════════════════════════ */

describe('News — StockDetail.jsx:706-736', () => {
  const webAgo = lift<(iso: string | null) => string>([], `${through(SD, 'const timeAgo = (iso) => {', '\n};')}\nreturn timeAgo;`)();
  const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
  afterEach(() => { jest.restoreAllMocks(); });

  it.each([0, 20, 59, 61, 3599, 3600, 7300, 86399, 86400, 400000, 9e6])('%s seconds ago', (sec) => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const iso = new Date(NOW - sec * 1000).toISOString();
    expect(stockNewsAgo(iso, NOW)).toBe(webAgo(iso));
  });

  it('meta line and empty copy', () => {
    const iso = new Date(NOW - 2 * 3600_000).toISOString();
    expect(newsMeta({ publisher: 'Reuters', publishedAt: iso }, NOW)).toBe('Reuters · 2h ago');
    expect(newsMeta({ publisher: 'Reuters', publishedAt: null }, NOW)).toBe('Reuters');
    expect(newsMeta({ publisher: null, publishedAt: iso }, NOW)).toBe(' · 2h ago');
    expect(SD).toContain('No recent news for {name}.');
    expect(newsEmptyText('Reliance Industries')).toBe('No recent news for Reliance Industries.');
  });
});

/* ══ Positions ════════════════════════════════════════════════════════ */

describe('Positions tab — StockDetail.jsx', () => {
  it('the fourth tab is this symbol\'s positions panel; the F&O tab is gone', () => {
    expect(SD).toContain('<PositionsPanel symbol={symbol} />');
    expect(SD).not.toContain('function FnoTab(');
    expect(STOCK_TABS[3]).toBe('Positions');
    expect([...STOCK_TABS]).not.toContain('F&O');
  });
});

/* ══ Chart ════════════════════════════════════════════════════════════ */

describe('StockChart geometry — StockDetail.jsx:1008-1044', () => {
  const web = lift<Record<string, unknown> & { x: (i: number) => number; y: (v: number) => number }>(
    ['candles', 'mode', 'showVol', 'up', 'n'],
    `${between(SD, 'const W = 800, H = 320, PADX = 8, PADR = 48;', '\n\n  const idxFromX')}
     ${between(SD, '  const line = closes.map', '\n\n  let selInfo')}
     return { x, y, bw, vMax, volH, stroke, PADT, PADB, plotB, line, area, yMin, yMax };`,
  );
  const webIdx = lift<(clientX: number) => number>(
    ['wrapRef', 'W', 'PADX', 'PADR', 'n'],
    `${through(SD, 'const idxFromX = (clientX) => {', '\n  };')}\nreturn idxFromX;`,
  );
  const webSel = lift<{ lo: number; hi: number; ch: number; p: number } | null>(
    ['sel', 'closes'],
    `${through(SD, 'let selInfo = null;', '\n  }')}\nreturn selInfo;`,
  );

  it.each([
    ['line', false, true], ['line', true, false], ['candle', false, true], ['candle', true, false],
  ] as Array<['line' | 'candle', boolean, boolean]>)('%s, volume %s, up %s — same coordinates at 800 × 320', (mode, vol, up) => {
    const raw = RAW_WEEKS.slice(0, 52);
    const candles = appCandles(raw, '1w');
    const w = web(raw, mode, vol, up, raw.length);
    const m = chartModel(candles, mode, vol, up, 800, 320);
    expect(m.line).toBe(w.line);
    expect(m.area).toBe(w.area);
    expect(m.bw).toBe(w.bw);
    expect(m.vMax).toBe(w.vMax);
    expect(m.volH).toBe(w.volH);
    expect(m.stroke).toBe(w.stroke);
    expect([m.padT, m.padB, m.plotB, m.yMin, m.yMax]).toEqual([w.PADT, w.PADB, w.plotB, w.yMin, w.yMax]);
    for (const i of [0, 7, 51]) expect(m.x(i)).toBe(w.x(i));
    for (const c of candles.slice(0, 5)) expect(m.y(c.low)).toBe(w.y(c.low));
  });

  it('at phone width the horizontal pads scale with the box, as the stretched viewBox does', () => {
    const candles = appCandles(RAW_DAY, '5m');
    const m = chartModel(candles, 'line', false, true, 360, 320);
    expect(m.padX).toBeCloseTo(8 * 360 / 800, 10);
    expect(m.padR).toBeCloseTo(48 * 360 / 800, 10);
    expect(m.x(0)).toBeCloseTo(m.padX, 10);
    expect(m.x(candles.length - 1)).toBeCloseTo(360 - m.padR, 10);
  });

  it('the candle under a position', () => {
    const n = 80;
    const idx = webIdx({ current: { getBoundingClientRect: () => ({ left: 0, width: 800 }) } }, 800, 8, 48, n);
    const m = chartModel(appCandles(RAW_DAY, '5m'), 'line', false, true, 800, 320);
    for (const px of [-20, 0, 8, 100, 377.3, 700, 752, 799, 900]) expect(indexAtX(m, px)).toBe(idx(px));
  });

  it('the selected return', () => {
    const closes = RAW_DAY.map((c) => Number(c.close));
    for (const sel of [null, { a: 5, b: 5 }, { a: 3, b: 40 }, { a: 60, b: 12 }]) {
      expect(selectionInfo(sel, closes)).toEqual(webSel(sel, closes));
    }
    const info = selectionInfo({ a: 60, b: 12 }, closes)!;
    const cur = stockCurrency(INST);
    expect(selectionLabel(info, 2, cur)).toBe(`${info.ch >= 0 ? '+' : '-'}₹${webFmtNum(Math.abs(info.ch), 2)} (${info.ch >= 0 ? '+' : ''}${info.p.toFixed(2)}%)`);
  });

  it('dates: a candle closes one bucket after it opens (the server\'s closeTime)', () => {
    const [c] = appCandles(RAW_WEEKS.slice(0, 1), '1w');
    expect(candleCloseMs(c!, '1w')).toBe(Date.parse(RAW_WEEKS[0]!.closeTime));
    const [d] = appCandles(RAW_DAY.slice(0, 1), '5m');
    expect(candleCloseMs(d!, '5m')).toBe(Date.parse(RAW_DAY[0]!.closeTime));
  });

  const webDates = lift<{ hoverRange: string | null; span: string | null }>(
    ['candles', 'hover', 'selInfo'],
    `${between(SD, '  const dateOf = (i, end) =>', '\n\n  return (', at(SD, 'let selInfo = null;'))}
     const span = selInfo ? \`\${timeOf(selInfo.lo, false)}, \${dateShortOf(selInfo.lo, false)} - \${timeOf(selInfo.hi, true)}, \${dateShortOf(selInfo.hi, true)}\` : null;
     return { hoverRange, span };`,
  );

  it.each([
    ['a five-minute candle — the date once, then open – close times', RAW_DAY, '5m', 7],
    ['a weekly candle — date and time on both ends', RAW_WEEKS, '1w', 3],
  ] as Array<[string, RawCandle[], string, number]>)('hover label: %s (StockDetail.jsx hoverRange)', (_l, raw, tf, i) => {
    const candles = appCandles(raw, tf);
    const w = webDates(raw, i, null);
    expect(candleRangeLabel(candles[i]!, tf, 'en-IN')).toBe(w.hoverRange);
    expect(w.hoverRange).toContain(' – ');
  });

  it('the drag-selection span: first candle\'s open → last candle\'s close, time then short date', () => {
    const candles = appCandles(RAW_DAY, '5m');
    const w = webDates(RAW_DAY, null, { lo: 4, hi: 30 });
    expect(selectionRangeLabel(candles[4]!, candles[30]!, '5m', 'en-IN')).toBe(w.span);
    expect(webDates(RAW_DAY, null, null)).toEqual({ hoverRange: null, span: null });
  });
});
