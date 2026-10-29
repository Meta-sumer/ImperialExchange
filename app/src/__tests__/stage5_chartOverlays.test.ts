/**
 * What the chart draws for the trader's own book (src/charts/chartOverlays)
 * and the bridge's message plumbing (src/charts/protocol) — PriceChart.jsx
 * sections 7, 8 and 8b.
 */
import {
  PREVIEW_ID,
  buildPills,
  buildPriceLines,
  chartCalendarEvents,
  nextCalendarEvent,
  parsePillKey,
  previewRealMatch,
  type ChartOrderRow,
  type ChartPositionRow,
  type OverlayInput,
} from '@/charts/chartOverlays';
import { deliverScript, parseFromChart } from '@/charts/protocol';
import type { CalendarEvent } from '@/types/market';

const PREFS = { tpColor: '#10b981', slColor: '#ef4444', entryColor: '#EAB308', buyColor: '#22C55E', sellColor: '#EF4444' };
const ALL = { positions: true, tpsl: true, stopLimit: true, orderPreview: true };

const pos = (over: Partial<ChartPositionRow> = {}): ChartPositionRow => ({
  id: 'p1', symbol: 'EURUSD', side: 'BUY', quantity: '1000', entryPrice: '1.08', stopLoss: '1.075', takeProfit: '1.09', pnl: 7.5, ...over,
});
const ord = (over: Partial<ChartOrderRow> = {}): ChartOrderRow => ({
  id: 'o1', symbol: 'EURUSD', side: 'SELL', type: 'LIMIT', status: 'PENDING', quantity: '500', price: '1.085', stopPrice: null, stopLoss: null, takeProfit: '1.07', triggeredAt: null, ...over,
});
const input = (over: Partial<OverlayInput> = {}): OverlayInput => ({
  symbol: 'EURUSD', positions: [pos()], orders: [ord()], pendingPreview: null, orderPreview: null, prefs: PREFS, show: ALL, ...over,
});

describe('price lines (PriceChart.jsx:2731-2917)', () => {
  it('position entry / SL / TP, a LIMIT line, keyed as the web keys them', () => {
    const lines = buildPriceLines(input());
    expect(lines.map((l) => [l.key, l.price, l.lineStyle, l.title])).toEqual([
      ['order:o1:limit', 1.085, 0, 'SELL LIM'],
      ['pos:p1:entry', 1.08, 0, ''],
      ['pos:p1:sl', 1.075, 2, ''],
      ['pos:p1:tp', 1.09, 2, ''],
    ]);
    // EquityHub colours an entry line BY SIDE (Buy / Sell colours), as its pill.
    expect(lines.find((l) => l.key === 'pos:p1:entry')?.color).toBe(PREFS.buyColor);
    expect(lines.find((l) => l.key === 'order:o1:limit')?.color).toBe(PREFS.sellColor);
  });

  it('a STOP order draws its trigger (dashed) and, when set, the stop-limit (dotted, no axis label)', () => {
    const lines = buildPriceLines(input({ positions: [], orders: [ord({ type: 'STOP', stopPrice: '1.09', price: '1.091', side: 'BUY' })] }));
    expect(lines.map((l) => [l.key, l.lineStyle, l.axisLabelVisible, l.title])).toEqual([
      ['order:o1:trigger', 2, true, 'BUY STP'],
      ['order:o1:stoplimit', 1, false, 'STP-LIM'],
    ]);
  });

  it('other symbols draw nothing; each toggle strips only its own lines', () => {
    expect(buildPriceLines(input({ symbol: 'GBPUSD' }))).toEqual([]);
    const noTpSl = buildPriceLines(input({ show: { ...ALL, tpsl: false } })).map((l) => l.key);
    expect(noTpSl).toEqual(['order:o1:limit', 'pos:p1:entry']);
    const noPos = buildPriceLines(input({ show: { ...ALL, positions: false } })).map((l) => l.key);
    expect(noPos).toEqual(['order:o1:limit', 'pos:p1:sl', 'pos:p1:tp']);
    const noPending = buildPriceLines(input({ show: { ...ALL, stopLimit: false } })).map((l) => l.key);
    expect(noPending).toEqual(['pos:p1:entry', 'pos:p1:sl', 'pos:p1:tp']);
  });

  it('the form\'s pending line and the order preview; the preview hides once a real order sits at its price', () => {
    const preview = { side: 'BUY' as const, mode: 'LIMIT', entry: 1.079, tp: 1.1, sl: 1.07 };
    const lines = buildPriceLines(input({ positions: [], orders: [], pendingPreview: { side: 'BUY', price: '1.079' }, orderPreview: preview }));
    expect(lines.map((l) => [l.key, l.title, l.color])).toEqual([
      ['preview:form', '↺ BUY', '#10b981'],
      ['preview:entry', '◹ LIMIT', '#22C55E'],
      ['preview:tp', '◹ TP', '#10b981'],
      ['preview:sl', '◹ SL', '#ef4444'],
    ]);
    const landed = [ord({ side: 'BUY', price: '1.07900' })];
    expect(previewRealMatch(preview, landed)).toBe(true);
    expect(buildPriceLines(input({ positions: [], orders: landed, orderPreview: preview })).map((l) => l.key)).toEqual(['order:o1:limit']);
    // Order preview needs BOTH its toggle and Pending on (Trade.jsx:3066).
    expect(buildPriceLines(input({ positions: [], orders: [], orderPreview: preview, show: { ...ALL, orderPreview: false } }))).toEqual([]);
  });
});

describe('pills (PriceChart.jsx:2928-3017)', () => {
  it('position pills carry the live P&L on the entry and quick-add only for a missing level', () => {
    const pills = buildPills(input({ positions: [pos({ takeProfit: null })], orders: [] }));
    expect(pills.map((p) => [p.key, p.kind, p.quickTp, p.quickSl])).toEqual([
      ['pos:p1:entry', 'entry', true, false],
      ['pos:p1:sl', 'sl', false, false],
    ]);
    expect(pills[0]?.pnl).toBe(7.5);
    expect(pills[1]).toMatchObject({ entry: 1.08, qty: 1000, side: 'BUY', target: 'position' });
  });

  it('a pending order gets a draggable entry (+ SL / TP); not a partly filled one, nor a fired STOP', () => {
    expect(buildPills(input({ positions: [] })).map((p) => p.key)).toEqual(['order:o1:entry', 'order:o1:tp']);
    expect(buildPills(input({ positions: [], orders: [ord({ status: 'PARTIALLY_FILLED' })] }))).toEqual([]);
    expect(buildPills(input({ positions: [], orders: [ord({ type: 'STOP', stopPrice: '1.09', triggeredAt: '2026-09-30T10:00:00Z' })] }))).toEqual([]);
  });

  it('the order preview is a draft pill on the sentinel id', () => {
    const pills = buildPills(input({ positions: [], orders: [], orderPreview: { side: 'SELL', mode: 'MARKET', entry: 1.08, tp: null, sl: 1.09 } }));
    expect(pills.map((p) => [p.key, p.id, p.orderType, p.preview, p.quickTp, p.quickSl])).toEqual([
      ['preview:order:entry', PREVIEW_ID, 'MARKET', true, true, false],
      ['preview:order:sl', PREVIEW_ID, 'MARKET', true, false, false],
    ]);
  });

  it('with "Open positions" off the SL pill still measures from the real entry (the web measured from 0)', () => {
    const pills = buildPills(input({ orders: [], show: { ...ALL, positions: false } }));
    expect(pills.map((p) => p.key)).toEqual(['pos:p1:sl', 'pos:p1:tp']);
    expect(pills[0]?.entry).toBe(1.08);
  });
});

describe('pill keys round-trip', () => {
  it.each([
    ['pos:abc:entry', { target: 'position', id: 'abc', kind: 'entry', isNew: false }],
    ['pos:abc:sl:new', { target: 'position', id: 'abc', kind: 'sl', isNew: true }],
    ['order:o9:tp', { target: 'order', id: 'o9', kind: 'tp', isNew: false }],
    ['order:__preview__:sl:new', { target: 'order', id: PREVIEW_ID, kind: 'sl', isNew: true }],
    ['preview:order:entry', { target: 'order', id: PREVIEW_ID, kind: 'entry', isNew: false }],
  ])('%s', (key, ref) => { expect(parsePillKey(key)).toEqual(ref); });

  it.each(['pos:abc', 'pos:abc:limit', 'order::sl', 'x:1:sl', 'pos:a:sl:new:extra', 'preview:form'])('rejects %s', (key) => {
    expect(parsePillKey(key)).toBeNull();
  });
});

describe('calendar on the chart (PriceChart.jsx:1344-1420)', () => {
  const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
  const ev = (over: Partial<CalendarEvent>): CalendarEvent => ({
    id: String(Math.random()), date: new Date(NOW).toISOString(), ts: NOW, country: 'US', currency: 'USD', impact: 'high',
    event: 'Event', period: '', unit: '', previous: null, consensus: null, forecast: null, actual: null,
    previousLabel: null, consensusLabel: null, forecastLabel: null, actualLabel: null, ...over,
  } as CalendarEvent);
  const FILTERS = { high: true, medium: true, low: false, lowest: false };

  it('markers: ±7 days, the instrument\'s currencies, the chosen impacts; the code is the currency', () => {
    const events = [
      ev({ ts: NOW - 2 * 86_400_000, currency: 'USD', impact: 'high' }),
      ev({ ts: NOW - 8 * 86_400_000, currency: 'USD', impact: 'high' }),
      ev({ ts: NOW + 86_400_000, currency: 'JPY', impact: 'high' }),
      ev({ ts: NOW + 3600_000, currency: 'EUR', impact: 'low' }),
      ev({ ts: NOW + 7200_000, currency: 'EUR', impact: 'medium' }),
    ];
    expect(chartCalendarEvents(events, ['EUR', 'USD'], FILTERS, NOW).map((e) => [e.ts - NOW, e.code, e.impact])).toEqual([
      [-2 * 86_400_000, 'USD', 'high'],
      [7_200_000, 'EUR', 'medium'],
    ]);
    expect(chartCalendarEvents(events, ['EUR'], { high: false, medium: false, low: false, lowest: false }, NOW)).toEqual([]);
  });

  it('the next event: the first matching one ahead, within 14 days', () => {
    const events = [ev({ ts: NOW + 3 * 3600_000, currency: 'EUR', impact: 'medium', event: 'CPI' }), ev({ ts: NOW + 3600_000, currency: 'EUR', impact: 'low', event: 'PPI' }), ev({ ts: NOW + 15 * 86_400_000, currency: 'EUR' })];
    expect(nextCalendarEvent(events, ['EUR', 'USD'], FILTERS, NOW)).toEqual({ ts: NOW + 3 * 3600_000, currency: 'EUR', impact: 'medium', event: 'CPI' });
    expect(nextCalendarEvent(events, ['GBP'], FILTERS, NOW)).toBeNull();
  });
});

describe('the bridge', () => {
  it('delivers JSON as a string literal that cannot break out of the call', () => {
    const script = deliverScript({ type: 'meta', name: 'A"); alert(1); (" </script>' });
    expect(script.startsWith('window.__aatReceive && window.__aatReceive("')).toBe(true);
    expect(script.endsWith(');true;')).toBe(true);
    let got: unknown = null;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    new Function('window', script)({ __aatReceive: (s: string) => { got = JSON.parse(s); } });
    expect(got).toEqual({ type: 'meta', name: 'A"); alert(1); (" </script>' });
  });

  it('accepts only its own messages', () => {
    expect(parseFromChart('{"type":"pillTap","key":"pos:a:sl"}')).toEqual({ type: 'pillTap', key: 'pos:a:sl' });
    expect(parseFromChart('{"type":"hack"}')).toBeNull();
    expect(parseFromChart('nope')).toBeNull();
    expect(parseFromChart('[1]')).toBeNull();
  });
});
