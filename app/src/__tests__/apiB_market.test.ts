/**
 * Market data: the adapters shared by REST and the socket, the catalogue
 * merge, and the endpoints' request shapes. No network — every request goes
 * to an in-test axios adapter.
 */
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';

import { api } from '@/api/client';
import {
  adaptInstrument,
  catalogCounts,
  fetchInstrument,
  fetchInstruments,
  fetchRecommended,
  filterCatalog,
  isOptionLikeQuery,
  mergeCatalogWithMarketWatch,
  inSearchCategory,
  loadInstruments,
  pushRecent,
  searchInstruments,
  searchOptionContracts,
} from '@/api/instruments.api';
import { fetchCandles, fetchFnoUnderlyings, fetchOptionChain, fetchOrderBook, withLiveQuote } from '@/api/market.api';
import { fetchMarketNews, loadMarketNews, marketNewsForTab, marketNewsTimeAgo, useMarketNewsStore } from '@/api/news.api';
import {
  adaptCalendarEvent,
  adaptCandle,
  adaptGlobalAlert,
  adaptMarketNews,
  adaptOrderBook,
  adaptPriceAlert,
  adaptTicker,
  adaptWatchlist,
  mergeTicker,
  normaliseCandles,
  priceAlertStatus,
  trimLeadingFlat,
} from '@/types/market';
import { adaptFrame, CHANNEL } from '@/websocket/channels';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

/* ── A fake server ────────────────────────────────────────────────────── */

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

/* ── Candles ──────────────────────────────────────────────────────────── */

describe('candles', () => {
  it('reads the server shape: ISO openTime, decimal-string prices', () => {
    const c = adaptCandle({ openTime: '2026-01-01T00:00:30.000Z', open: '1.1', high: '1.2', low: '1.0', close: '1.15', volume: '7' }, 60);
    expect(c).toEqual({ time: Date.parse('2026-01-01T00:00:00Z') / 1000, open: 1.1, high: 1.2, low: 1, close: 1.15, volume: 7 });
  });

  it('never Date.parses a numeric time (V8 reads 2000 as a year)', () => {
    expect(adaptCandle({ time: 2000, open: 1, high: 1, low: 1, close: 1 })?.time).toBe(2000);
  });

  it('drops a candle with no close rather than drawing a zero', () => {
    expect(adaptCandle({ openTime: '2026-01-01T00:00:00Z', open: '1', high: '1', low: '1' })).toBeNull();
  });

  it('sorts, drops the future and keeps the LATEST row per bucket', () => {
    const now = Date.parse('2026-01-01T00:10:00Z') / 1000;
    const out = normaliseCandles({
      data: [
        { openTime: '2026-01-01T00:02:00Z', open: 1, high: 1, low: 1, close: 2 },
        { openTime: '2026-01-01T00:01:00Z', open: 1, high: 1, low: 1, close: 1 },
        { openTime: '2026-01-01T00:02:30Z', open: 1, high: 1, low: 1, close: 3 },
        { openTime: '2026-01-01T09:00:00Z', open: 1, high: 1, low: 1, close: 9 },
      ],
    }, '1m', now);
    expect(out.map((c) => c.close)).toEqual([1, 3]);
  });

  it('trims a leading flat carry-forward run but keeps one lead-in', () => {
    const flat = (t: number) => ({ time: t, open: 5, high: 5, low: 5, close: 5, volume: 0 });
    const real = (t: number, c: number) => ({ time: t, open: c, high: c, low: c, close: c, volume: 10 });
    const out = trimLeadingFlat([flat(1), flat(2), flat(3), real(4, 6), real(5, 7)]);
    expect(out.map((c) => c.time)).toEqual([3, 4, 5]);
    // Daily bars carry volume — untouched.
    const daily = [real(1, 5), real(2, 5), real(3, 6)];
    expect(trimLeadingFlat(daily)).toEqual(daily);
  });

  it('GET /instruments/:symbol/candles with timeframe + limit, symbol encoded', async () => {
    serve(() => ({ data: { success: true, data: [{ openTime: '2020-01-01T00:00:00Z', open: '1', high: '2', low: '0.5', close: '1.5' }] } }));
    const out = await fetchCandles('nifty 50', '1d', 24);
    expect(calls[0]?.url).toBe('/instruments/NIFTY%2050/candles');
    expect(calls[0]?.params).toEqual({ timeframe: '1d', limit: 24 });
    expect(out).toHaveLength(1);
  });
});

/* ── Tickers and depth ────────────────────────────────────────────────── */

describe('ticker', () => {
  it('keeps absent fields null — a zero bid is a price, an absent one is not', () => {
    const t = adaptTicker('reliance', { lastPrice: '100.5', ts: 1 });
    expect(t).toMatchObject({ symbol: 'RELIANCE', lastPrice: '100.5', bid: null, change24h: null });
  });

  it('a lastPrice-only tick does not blank the day range from a richer one', () => {
    const rich = adaptTicker('X', { lastPrice: '10', dayHigh: '12', dayLow: '9', change24h: 1.5, source: 'BINANCE_TICKER' });
    const thin = adaptTicker('X', { lastPrice: '11' });
    expect(mergeTicker(rich, thin)).toMatchObject({ lastPrice: '11', dayHigh: '12', dayLow: '9', change24h: 1.5 });
  });

  it('overlays a tick on an instrument row without losing untouched fields', () => {
    const inst = adaptInstrument({ symbol: 'NIFTY', lastPrice: '1.1', dayHigh: '1.2' });
    const live = withLiveQuote(inst, adaptTicker('NIFTY', { lastPrice: '1.15' }));
    expect(live.lastPrice).toBe('1.15');
    expect(live.dayHigh).toBe('1.2');
  });
});

describe('order book', () => {
  it('reads tuples and objects, and unwraps the REST envelope', () => {
    const book = adaptOrderBook({ data: { bids: [['1.1', '5'], { price: '1.0', quantity: '2', count: 3 }], asks: [{ price: 'x' }] } }, 'nifty');
    expect(book.symbol).toBe('NIFTY');
    expect(book.bids).toEqual([
      { price: '1.1', quantity: '5', count: 1 },
      { price: '1.0', quantity: '2', count: 3 },
    ]);
    expect(book.asks).toEqual([]); // an unpriceable level is dropped
  });

  it('asks for the depth only when given', async () => {
    serve(() => ({ data: { success: true, data: { bids: [], asks: [] } } }));
    await fetchOrderBook('RELIANCE', 5);
    await fetchOrderBook('RELIANCE');
    expect(calls[0]?.params).toEqual({ depth: 5 });
    expect(calls[1]?.params).toBeUndefined();
  });
});

describe('option chain — instrumentController.optionChain / fnoUnderlyings', () => {
  it('asks for the underlying, the expiry and the kind, and reads strikes × CE / PE with Dhan stats', async () => {
    serve(() => ({
      data: {
        success: true,
        data: {
          underlying: 'NIFTY',
          kind: 'INDEX',
          exchange: 'NFO',
          expiry: '2026-10-27',
          expiries: ['2026-10-27', '2026-11-03', '2026-11-10', '2026-11-24'],
          expiryDate: '2026-10-27T10:00:00.000Z',
          spot: { symbol: 'NIFTY', name: 'Nifty 50', lastPrice: 25012.4 },
          future: { symbol: 'NIFTY27OCT26FUT', lastPrice: 25060, expiryDate: '2026-10-27T10:00:00.000Z' },
          lotSize: 75,
          contractUnit: null,
          tickSize: 0.05,
          atmStrike: 25000,
          strikes: [
            { strike: 25050, CE: { symbol: 'NIFTY27OCT2625050CE', lastPrice: 80.5, prevPrice: 70, tradingEnabled: true }, PE: null },
            {
              strike: 25000,
              CE: { symbol: 'NIFTY27OCT2625000CE', lastPrice: 110, prevPrice: 100, tradingEnabled: false, stats: { oi: 120000, oiChange: -500, volume: 9000, iv: 12.4, delta: 0.52, theta: -11.2, gamma: 0.0012, vega: 9.8 } },
              PE: { symbol: 'NIFTY27OCT2625000PE', lastPrice: 95, stats: { oi: null, oiChange: null } },
            },
          ],
          analytics: { source: 'DHAN', asOf: '2026-10-22T09:00:00.000Z', underlyingPrice: 25011, ceOi: 120000, peOi: 90000, pcr: 0.75, maxPain: 25000 },
        },
      },
    }));
    const chain = await fetchOptionChain('nifty', '2026-10-27', 'INDEX');
    expect(calls[0]?.url).toBe('/instruments/option-chain');
    expect(calls[0]?.params).toEqual({ underlying: 'NIFTY', expiry: '2026-10-27', kind: 'INDEX' });
    expect(chain).toMatchObject({
      underlying: 'NIFTY', kind: 'INDEX', exchange: 'NFO', expiry: '2026-10-27', lotSize: 75, atmStrike: 25000,
      spot: { symbol: 'NIFTY', name: 'Nifty 50', lastPrice: '25012.4', isFuture: false },
      future: { symbol: 'NIFTY27OCT26FUT', lastPrice: '25060' },
      analytics: { source: 'DHAN', pcr: 0.75, maxPain: 25000, ceOi: 120000, peOi: 90000 },
    });
    expect(chain.expiries).toHaveLength(4);
    // Ascending by strike, whatever order the server sent.
    expect(chain.strikes.map((r) => r.strike)).toEqual([25000, 25050]);
    expect(chain.strikes[0]?.CE).toMatchObject({ lastPrice: '110', tradingEnabled: false, stats: { oi: 120000, oiChange: -500, iv: 12.4, gamma: 0.0012 } });
    // A figure Dhan did not send is null, never 0.
    expect(chain.strikes[0]?.PE?.stats).toMatchObject({ oi: null, oiChange: null, delta: null });
    expect(chain.strikes[1]?.CE?.stats).toBeNull();
    expect(chain.strikes[1]?.PE).toBeNull();
  });

  it('an LTP-only chain (no Dhan) has no analytics; no expiry or kind is sent when there is none', async () => {
    serve(() => ({ data: { data: { underlying: 'CRUDEOIL', kind: 'COMMODITY', expiries: [], strikes: [], analytics: null, spot: { symbol: 'CRUDEOIL19NOV26FUT', lastPrice: 5342, isFuture: true } } } }));
    const chain = await fetchOptionChain('CRUDEOIL');
    expect(calls[0]?.params).toEqual({ underlying: 'CRUDEOIL' });
    expect(chain.analytics).toBeNull();
    expect(chain.spot?.isFuture).toBe(true);
  });

  it('the picker: segments (absent switch = on) and every underlying with its expiries and futures', async () => {
    serve(() => ({
      data: {
        data: {
          segments: { indiaOnly: true, indexFutures: true, indexOptions: true, stockFutures: true, stockOptions: false, mcxFutures: true },
          underlyings: [
            { underlying: 'NIFTY', kind: 'INDEX', exchange: 'NFO', name: 'Nifty 50', lotSize: 75, optionExpiries: ['2026-10-27', '2026-11-03'], futures: [{ symbol: 'NIFTY27OCT26FUT', expiryDate: '2026-10-27T10:00:00Z', lastPrice: 25060 }], spot: { symbol: 'NIFTY', lastPrice: 25012 } },
            { underlying: 'reliance', kind: 'STOCK', exchange: 'NFO', optionExpiries: [], futures: [] },
            { kind: 'INDEX' },
          ],
        },
      },
    }));
    const m = await fetchFnoUnderlyings();
    expect(calls[0]?.url).toBe('/instruments/fno/underlyings');
    expect(m.segments).toEqual({ indiaOnly: true, indexFutures: true, indexOptions: true, stockFutures: true, stockOptions: false, mcxFutures: true, mcxOptions: true });
    expect(m.underlyings.map((u) => u.underlying)).toEqual(['NIFTY', 'RELIANCE']);
    expect(m.underlyings[0]).toMatchObject({ kind: 'INDEX', name: 'Nifty 50', optionExpiries: ['2026-10-27', '2026-11-03'], futures: [{ symbol: 'NIFTY27OCT26FUT', lastPrice: '25060' }] });
    // A nameless underlying is named after itself.
    expect(m.underlyings[1]?.name).toBe('RELIANCE');
  });
});

/* ── Instruments ──────────────────────────────────────────────────────── */

describe('instrument adapter', () => {
  it('a search row (a dozen fields) reads as nulls, never zeros', () => {
    const i = adaptInstrument({ _id: 'a1', symbol: 'reliance', name: 'Reliance', category: 'stock' });
    expect(i).toMatchObject({
      id: 'a1', symbol: 'RELIANCE', category: 'STOCK', lastPrice: null, bid: null, maxLeverage: null,
      leverageOverride: null, fixedVolume: null, tradingEnabled: true, pricePrecision: 2,
    });
    expect(i.raw).toEqual({ _id: 'a1', symbol: 'reliance', name: 'Reliance', category: 'stock' });
  });

  it('reads an option contract and the leverage override window', () => {
    const i = adaptInstrument({
      symbol: 'NIFTY25000CE', optionType: 'ce', strike: 25000, expiryDate: '2026-10-01',
      leverageOverride: { leverage: '50', normalLeverage: 100, endAt: '2026-10-02T00:00:00Z', reason: 'event' },
      fixedVolume: { enabled: true, value: '0.1', source: 'schedule' },
      tradingEnabled: false,
    });
    expect(i.optionType).toBe('CE');
    expect(i.strike).toBe('25000');
    expect(i.leverageOverride).toMatchObject({ leverage: 50, normalLeverage: 100, reason: 'event' });
    expect(i.fixedVolume).toMatchObject({ enabled: true, value: '0.1', source: 'schedule' });
    expect(i.tradingEnabled).toBe(false);
  });

  it('merges the enrichment over the catalogue, the enrichment winning even with null', () => {
    const catalog = [adaptInstrument({ symbol: 'A', lastPrice: '1', bid: '0.9', volume24h: '5', maxLeverage: 100 })];
    const watch = [adaptInstrument({ symbol: 'A', lastPrice: '2', change24h: 3 })];
    const [m] = mergeCatalogWithMarketWatch(catalog, watch);
    expect(m).toMatchObject({ lastPrice: '2', bid: null, change24h: 3, volume24h: '5', maxLeverage: 100 });
  });

  it('GET /instruments passes the filters; a bare array body is tolerated', async () => {
    serve(() => ({ data: [{ symbol: 'X' }, { name: 'no symbol' }] }));
    const out = await fetchInstruments({ category: 'CRYPTO', includeOptions: true });
    expect(calls[0]?.params).toEqual({ category: 'CRYPTO', includeOptions: 'true' });
    expect(out.map((i) => i.symbol)).toEqual(['X']);
  });

  it('an empty search sends nothing', async () => {
    serve(() => ({ data: { data: [] } }));
    expect(await searchInstruments('   ')).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('a detail miss is null, not a crash', async () => {
    serve(() => ({ data: { success: true, data: null } }));
    expect(await fetchInstrument('nope')).toBeNull();
  });

  it('recommended accepts bare symbols and { symbol } rows', async () => {
    serve(() => ({ data: { success: true, data: ['RELIANCE', { symbol: 'NIFTY' }, {}] } }));
    expect(await fetchRecommended()).toEqual(['RELIANCE', 'NIFTY']);
  });

  it('recently viewed promotes, de-duplicates and caps at five', () => {
    expect(pushRecent(['A', 'B', 'C'], 'B')).toEqual(['B', 'A', 'C']);
    expect(pushRecent(['A', 'B', 'C', 'D', 'E'], 'F')).toEqual(['F', 'A', 'B', 'C', 'D']);
    expect(pushRecent(['A'], 'A')).toEqual(['A']);
  });
});

/* ── Socket frames ────────────────────────────────────────────────────── */

describe('channel frames', () => {
  it('builds uppercase channel names', () => {
    expect(CHANNEL.ticker('reliance')).toBe('ticker:RELIANCE');
    expect(CHANNEL.candles('nifty', '1h')).toBe('candles:NIFTY:1h');
  });

  it('a candle frame is snapped to its bucket, with the timeframe read off the channel', () => {
    const e = adaptFrame('candles:NIFTY:5m', { openTime: '2026-01-01T00:07:10Z', open: '1', high: '2', low: '0.5', close: '1.5' });
    expect(e).toEqual({
      symbol: 'NIFTY',
      timeframe: '5m',
      candle: { time: Date.parse('2026-01-01T00:05:00Z') / 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 },
    });
    expect(adaptFrame('candles:NIFTY:5m', { open: 1 })).toBeNull();
  });

  it('a user:account METRICS push carries the server marginLevel, including its "0"', () => {
    const e = adaptFrame('user:account', {
      type: 'METRICS', accountId: 'acc1', equity: '100', usedMargin: '0', marginLevel: '0', openPositions: 2, at: '2026-01-01T00:00:00.000Z',
    });
    expect(e).toMatchObject({
      type: 'METRICS',
      openPositions: 2,
      metrics: { accountId: 'acc1', equity: '100', marginLevel: '0', asOf: '2026-01-01T00:00:00.000Z' },
    });
    expect(adaptFrame('user:account', { type: 'PLAN_ENFORCED' })).toMatchObject({ type: 'OTHER' });
  });

  it('a private nudge passes through as sent; junk becomes {}', () => {
    expect(adaptFrame('user:wallet', { action: 'DEPOSIT', amount: 5 })).toEqual({ action: 'DEPOSIT', amount: 5 });
    expect(adaptFrame('user:wallet', 'junk')).toEqual({});
  });
});

/* ── News, calendar, watchlists, alerts ───────────────────────────────── */

describe('shape adapters', () => {
  it('a Market News story keeps its tags; one without a title is dropped', () => {
    expect(adaptMarketNews({
      id: '1-0', title: 'Sensex up 500 pts', url: 'https://x', source: 'Mint', publishedAt: '2026-10-22T08:00:00Z',
      tags: [{ symbol: 'reliance', name: 'Reliance' }, { name: 'no symbol' }],
    })).toMatchObject({ id: '1-0', source: 'Mint', summary: null, image: null, tags: [{ symbol: 'RELIANCE', name: 'Reliance' }] });
    expect(adaptMarketNews({ url: 'https://x' })).toBeNull();
  });

  it('a live calendar row keeps the server labels verbatim', () => {
    const e = adaptCalendarEvent({
      id: 'USD-NFP', date: '2026-10-02T12:30:00.000Z', country: 'US', currency: 'USD', impact: 'lowest',
      event: 'Bank Holiday', previous: null, previousLabel: '—', actualLabel: null,
    });
    expect(e).toMatchObject({ impact: 'lowest', previousLabel: '—', actualLabel: null, isAdmin: false, ts: Date.parse('2026-10-02T12:30:00Z') });
    expect(adaptCalendarEvent({ event: 'no date' })).toBeNull();
  });

  it('a watchlist keeps server order and counts', () => {
    const wl = adaptWatchlist({ _id: 'w1', name: 'Favorites', isDefault: true, items: [{ _id: 'i1', symbol: 'reliance', pinned: true }] });
    expect(wl).toMatchObject({ id: 'w1', isDefault: true, itemCount: 1, items: [{ id: 'i1', symbol: 'RELIANCE', pinned: true }] });
  });

  it('a fired alert reads Triggered even while paused', () => {
    const a = adaptPriceAlert({ _id: 'p1', symbol: 'nifty', direction: 'below', targetPrice: '1.05', isActive: false, triggeredAt: '2026-01-01T00:00:00Z', triggeredPrice: '1.049' });
    expect(a).toMatchObject({ symbol: 'NIFTY', direction: 'BELOW', targetPrice: '1.05', triggeredPrice: '1.049' });
    expect(priceAlertStatus(a)).toBe('TRIGGERED');
    expect(priceAlertStatus({ triggeredAt: null, isActive: false })).toBe('PAUSED');
    expect(priceAlertStatus({ triggeredAt: null, isActive: true })).toBe('ACTIVE');
  });

  it('a global alert with an unknown priority shows as INFO; one with no id is dropped', () => {
    expect(adaptGlobalAlert({ _id: 'g1', title: 'T', message: '<p>m</p>', priority: 'URGENT' })?.priority).toBe('INFO');
    expect(adaptGlobalAlert({ title: 'T' })).toBeNull();
  });
});

describe('search sheet — EquityHub SearchModal.jsx', () => {
  const rowsIn = [
    adaptInstrument({ symbol: 'TCS', name: 'Tata Consultancy', category: 'STOCK', exchange: 'NSE' }),
    adaptInstrument({ symbol: 'AAPL', name: 'Apple', category: 'STOCK' }),
    adaptInstrument({ symbol: 'NIFTY', name: 'Nifty 50', category: 'INDEX', exchange: 'nse' }),
    adaptInstrument({ symbol: 'CRUDEOIL19NOV26FUT', name: 'Crude Oil Nov Fut', category: 'COMMODITY', exchange: 'MCX', segment: 'FUT' }),
  ];

  it('an option-like query is a strike or CE/PE', () => {
    expect(isOptionLikeQuery('NIFTY 25000')).toBe(true);
    expect(isOptionLikeQuery('nifty ce')).toBe(true);
    expect(isOptionLikeQuery('reliance')).toBe(false);
    expect(isOptionLikeQuery('')).toBe(false);
  });

  it('tabs are Indian market segments, and an MCX future is under Futures AND Commodities', () => {
    const fut = rowsIn[3]!;
    expect(inSearchCategory(fut, 'FUT')).toBe(true);
    expect(inSearchCategory(fut, 'COMMODITY')).toBe(true);
    expect(inSearchCategory(fut, 'STOCK')).toBe(false);
    expect(inSearchCategory(rowsIn[2]!, 'INDEX')).toBe(true);
    expect(inSearchCategory(rowsIn[2]!, 'ALL')).toBe(true);
    expect(catalogCounts(rowsIn, ['TCS', 'GONE'])).toEqual({ ALL: 4, INDEX: 1, STOCK: 2, FUT: 1, COMMODITY: 1, RECOMMENDED: 1 });
  });

  it('recommended keeps the admin order; other tabs are alphabetical by name', () => {
    expect(filterCatalog(rowsIn, { category: 'RECOMMENDED', recommended: ['TCS', 'AAPL'] }).map((r) => r.symbol)).toEqual(['TCS', 'AAPL']);
    expect(filterCatalog(rowsIn, { category: 'ALL' }).map((r) => r.symbol)).toEqual(['AAPL', 'CRUDEOIL19NOV26FUT', 'NIFTY', 'TCS']);
    expect(filterCatalog(rowsIn, { category: 'FUT' }).map((r) => r.symbol)).toEqual(['CRUDEOIL19NOV26FUT']);
    expect(filterCatalog(rowsIn, { category: 'ALL', query: 'tata' }).map((r) => r.symbol)).toEqual(['TCS']);
  });

  it('asks the server for options only on an option-like query, and keeps only OPT rows', async () => {
    serve(() => ({ data: { data: [{ symbol: 'NIFTY25000CE', segment: 'OPT' }, { symbol: 'NIFTY', segment: 'IDX' }] } }));
    expect(await searchOptionContracts('reliance')).toEqual([]);
    expect(calls).toHaveLength(0);
    expect((await searchOptionContracts('nifty 25000')).map((r) => r.symbol)).toEqual(['NIFTY25000CE']);
    expect(calls[0]?.params).toEqual({ q: 'nifty 25000' });
  });
});

describe('Market News feed — components/MarketNews.jsx', () => {
  beforeEach(() => { useMarketNewsStore.setState({ items: null, at: 0 }); });

  it('asks for 60 headlines (and a symbol only when given)', async () => {
    serve(() => ({ data: { data: [{ id: 'a', title: 'A', tags: [] }] } }));
    await fetchMarketNews();
    await fetchMarketNews({ symbol: 'tcs', limit: 5 });
    expect(calls[0]?.url).toBe('/instruments/market-news');
    expect(calls[0]?.params).toEqual({ limit: 60 });
    expect(calls[1]?.params).toEqual({ limit: 5, symbol: 'TCS' });
  });

  it('holds one feed for 5 minutes; a failure answers an empty list, not a spinner', async () => {
    serve(() => ({ data: { data: [{ id: 'a', title: 'A' }] } }));
    expect((await loadMarketNews()).map((n) => n.id)).toEqual(['a']);
    await loadMarketNews();
    expect(calls).toHaveLength(1);
    serve(() => ({ status: 500, data: {} }));
    useMarketNewsStore.setState({ items: null, at: 0 });
    expect(await loadMarketNews()).toEqual([]);
    expect(useMarketNewsStore.getState().items).toEqual([]);
  });

  it('"Stocks in news" is the stories that name a stock', () => {
    const items = [
      { id: '1', title: 'a', url: null, summary: null, image: null, source: null, publishedAt: null, tags: [{ symbol: 'TCS', name: null }] },
      { id: '2', title: 'b', url: null, summary: null, image: null, source: null, publishedAt: null, tags: [] },
    ];
    expect(marketNewsForTab(items, 'all').map((n) => n.id)).toEqual(['1', '2']);
    expect(marketNewsForTab(items, 'stocks').map((n) => n.id)).toEqual(['1']);
    expect(marketNewsForTab(null, 'all')).toEqual([]);
  });

  it('time-ago keeps the web wording', () => {
    const now = Date.parse('2026-01-10T12:00:00Z');
    expect(marketNewsTimeAgo('2026-01-10T11:59:30Z', now)).toBe('Just now');
    expect(marketNewsTimeAgo('2026-01-10T11:55:00Z', now)).toBe('5 min ago');
    expect(marketNewsTimeAgo('2026-01-10T11:00:00Z', now)).toBe('1 hr ago');
    expect(marketNewsTimeAgo('2026-01-10T09:00:00Z', now)).toBe('3 hrs ago');
    expect(marketNewsTimeAgo('2026-01-09T11:00:00Z', now)).toBe('Yesterday');
    expect(marketNewsTimeAgo('2026-01-06T12:00:00Z', now)).toBe('4 days ago');
    expect(marketNewsTimeAgo(null, now)).toBe('');
    expect(marketNewsTimeAgo('not a date', now)).toBe('');
  });
});

describe('catalogue — loadInstruments({ catalogOnly })', () => {
  it('answers a symbol picker with the bare catalogue, skipping /instruments/watchlist', async () => {
    serve(() => ({ data: { data: [{ symbol: 'TCS', name: 'Tata' }] } }));
    const rows = await loadInstruments({ catalogOnly: true });
    expect(rows.map((r) => r.symbol)).toEqual(['TCS']);
    expect(calls.map((c) => c.url)).toEqual(['/instruments']);
  });
});

describe('option chain logic — pages/OptionChain.jsx', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const m = require('@/utils/markets') as typeof import('@/utils/markets');
  const NOW = Date.parse('2026-10-22T06:00:00Z'); // 11:30 IST, Thursday

  it('Indian compact counts, a dash for a figure that was not sent', () => {
    expect([m.compactCount(950), m.compactCount(12500), m.compactCount(325000), m.compactCount(14000000)])
      .toEqual(['950', '12.5K', '3.25L', '1.40Cr']);
    expect(m.compactCount(-4200)).toBe('-4.2K');
    expect(m.compactCount(null)).toBe('—');
    const chg = m.BASE_COLS.find((c) => c.key === 'oiChange');
    expect(chg?.fmt(1500)).toBe('+1.5K');
    expect(chg?.fmt(null)).toBe('—');
  });

  it('the Greeks toggle adds Vol and the four Greeks; no analytics, no columns', () => {
    expect(m.chainColumns(true, false).map((c) => c.label)).toEqual(['OI', 'Chg OI', 'IV']);
    expect(m.chainColumns(true, true).map((c) => c.label)).toEqual(['OI', 'Chg OI', 'IV', 'Vol', 'Δ Delta', 'Θ Theta', 'Γ Gamma', 'V Vega']);
    expect(m.chainColumns(false, true)).toEqual([]);
    expect(m.GREEKS_STORAGE_KEY).toBe('eh:oc:greeks');
    expect(m.OPTION_CHAIN_POLL_MS).toBe(3000);
  });

  it('expiry chips: "27 Oct", days to go in IST', () => {
    expect(m.expiryLabel('2026-10-27')).toBe('27 Oct');
    expect(m.daysTo('2026-10-27', NOW)).toBe(5);
    expect(m.expiryDaysText(m.daysTo('2026-10-22', NOW))).toBe('today');
    expect(m.expiryDaysText(5)).toBe('5d');
  });

  it('the spot divider and the OI bars', () => {
    const row = (strike: number, ce = 0, pe = 0) => ({
      strike,
      CE: { symbol: `C${strike}`, lastPrice: '1', prevPrice: null, tradingEnabled: true, stats: { oi: ce, oiChange: null, volume: null, iv: null, delta: null, theta: null, gamma: null, vega: null } },
      PE: { symbol: `P${strike}`, lastPrice: '1', prevPrice: null, tradingEnabled: true, stats: null },
    });
    const strikes = [row(24900, 100), row(25000, 400), row(25100, 50)];
    expect(m.spotIndexOf(strikes, 25012)).toBe(2);
    expect(m.spotIndexOf(strikes, 26000)).toBe(3);
    expect(m.spotIndexOf(strikes, 0)).toBe(-1);
    expect(m.maxOiOf(strikes)).toBe(400);
    expect([m.oiBarPct(400, 400), m.oiBarPct(4, 400), m.oiBarPct(0, 400), m.oiBarPct(null, 400)]).toEqual([100, 2, 0, 0]);
    expect([m.ceIsItm(24900, 25012), m.peIsItm(24900, 25012), m.peIsItm(25100, 25012), m.ceIsItm(1, 0)]).toEqual([true, false, true, false]);
  });

  it('the summary card and the footnote, in the web words', () => {
    const chain = { lotSize: 100, contractUnit: 'barrels', atmStrike: 5350, expiry: '2026-11-17', analytics: { source: 'DHAN', asOf: null, underlyingPrice: null, ceOi: 125000, peOi: 98000, pcr: 0.78, maxPain: 5300 } };
    expect(m.chainStats(chain as never)).toEqual([
      { label: 'Lot size', value: '100 barrels' },
      { label: 'ATM strike', value: '5,350' },
      { label: 'Expiry', value: '17 Nov 2026' },
      { label: 'PCR (OI)', value: '0.78' },
      { label: 'Max pain', value: '5,300' },
      { label: 'Call OI / Put OI', value: '1.25L / 98.0K' },
    ]);
    expect(m.chainStats(null).map((s) => s.value)).toEqual(['—', '—', '—']);
    expect(m.optionChainFootnote(chain as never)).toBe(
      'Shaded cells are in the money. Premiums are per unit; one lot is 100 barrels, so a lot costs premium × 100. '
      + 'Options can be bought (calls or puts) and sold to close; selling to open (option writing) isn’t available. '
      + 'Open positions are squared off shortly before expiry, and anything still open at expiry settles at intrinsic value.',
    );
    expect(m.inr(25012.4)).toBe('₹25,012.40');
    expect(m.inr(0)).toBe('—');
    expect(m.analyticsCaption(null)).toBe('OI, IV & Greeks via Dhan');
    expect(m.analyticsCaption('2026-10-22T09:00:00Z', () => '2:30:00 pm')).toBe('OI, IV & Greeks via Dhan · 2:30:00 pm');
  });

  it('the picker: tabs with options only, the active kind, the stock option text', () => {
    const u = (underlying: string, kind: 'INDEX' | 'STOCK' | 'COMMODITY', exp: string[], name = underlying) => ({
      underlying, kind, exchange: null, name, lotSize: null, contractUnit: null, optionExpiries: exp, futures: [], spot: null,
    });
    const list = [u('NIFTY', 'INDEX', ['2026-10-27']), u('RELIANCE', 'STOCK', [], 'Reliance Industries'), u('CRUDEOIL', 'COMMODITY', ['2026-11-17'])];
    expect(m.kindsAvailable(list).map((k) => k.label)).toEqual(['Index', 'Commodity (MCX)']);
    expect(m.activeKind(null, null, list)).toBe('INDEX');
    expect(m.activeKind(null, 'COMMODITY', list)).toBe('COMMODITY');
    expect(m.activeKind(list[2]!, 'INDEX', list)).toBe('COMMODITY');
    expect(m.underlyingOptionLabel(list[1]!)).toBe('RELIANCE — Reliance Industries');
    expect(m.underlyingOptionLabel(list[0]!)).toBe('NIFTY');
  });

  it('MCX trades 09:00–23:30 IST on weekdays; NFO follows NSE hours', () => {
    expect(m.chainSession('MCX', 'COMMODITY', new Date('2026-10-22T16:00:00Z'))).toMatchObject({ isOpen: true, label: 'MCX open' }); // 21:30 IST
    expect(m.chainSession('MCX', 'COMMODITY', new Date('2026-10-22T18:15:00Z'))).toMatchObject({ isOpen: false, label: 'Market Closed', detail: 'MCX closes 23:30 IST' }); // 23:45 IST
    expect(m.chainSession('MCX', 'COMMODITY', new Date('2026-10-24T06:00:00Z'))).toMatchObject({ isOpen: false, detail: 'MCX closed on weekends' });
    expect(m.chainSession('NFO', 'INDEX', new Date('2026-10-22T06:00:00Z'))).toMatchObject({ isOpen: true, label: 'NSE open' });
  });
});
