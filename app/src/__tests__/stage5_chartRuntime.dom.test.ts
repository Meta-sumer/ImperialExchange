/**
 * @jest-environment jsdom
 */
/**
 * The chart WebView, booted for real: the vendored lightweight-charts build
 * and the bundled runtime, evaluated in jsdom against the markup
 * buildChartHtml() ships, then driven with the same messages PriceChart
 * sends. jsdom has no canvas, so the 2D context is a recording stub and the
 * box sizes are fixed — the chart cannot paint, but every code path from a
 * message to the DOM (and back out through ReactNativeWebView.postMessage)
 * runs exactly as on a phone.
 */
import { buildChartHtml } from '@/charts/chartHtml';
import { CHART_RUNTIME_SOURCE } from '@/charts/runtime/generated';
import { CHART_LIBRARY_SOURCE } from '@/charts/vendor/chartLibrary';

type Posted = Record<string, unknown> & { type: string };

const posted: Posted[] = [];
const W = 360;
const H = 420;

const fakeCtx = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => {
  const store: Record<string | symbol, unknown> = {};
  return new Proxy(store, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'canvas') return canvas;
      if (prop === 'measureText') return (t: string) => ({ width: String(t).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop: () => undefined });
      if (prop === 'getLineDash') return () => [];
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (prop === 'getTransform') return () => ({ a: 1, d: 1 });
      return () => undefined;
    },
    set(target, prop, value) { target[prop] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
};

const send = (msg: Record<string, unknown>): void => {
  (window as unknown as { __aatReceive: (s: string) => void }).__aatReceive(JSON.stringify(msg));
};
const errors = (): Posted[] => posted.filter((m) => m.type === 'error');
const last = (type: string): Posted | undefined => [...posted].reverse().find((m) => m.type === type);

const candles = (n: number, start = Math.floor(Date.now() / 1000 / 60) * 60 - n * 60): { time: number; open: number; high: number; low: number; close: number; volume: number }[] =>
  Array.from({ length: n }, (_, i) => {
    const o = 1.08 + Math.sin(i / 7) * 0.004;
    const c = o + Math.cos(i / 5) * 0.001;
    return { time: start + i * 60, open: o, high: Math.max(o, c) + 0.0006, low: Math.min(o, c) - 0.0006, close: c, volume: 100 + i };
  });

const pointer = (type: string, target: EventTarget, x: number, y: number): void => {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, { clientX: x, clientY: y, pointerId: 7, button: 0 });
  target.dispatchEvent(ev);
};

beforeAll(() => {
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe(): void { /* */ } unobserve(): void { /* */ } disconnect(): void { /* */ } };
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) { return fakeCtx(this); } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => W, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => H, configurable: true });
  Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: W, height: H, right: W, bottom: H, toJSON: () => ({}) }) as DOMRect;
  (window as unknown as { ReactNativeWebView: unknown }).ReactNativeWebView = { postMessage: (s: string) => { posted.push(JSON.parse(s) as Posted); } };

  const html = buildChartHtml('light');
  const body = html.slice(html.indexOf('<body'), html.indexOf('<script>')).replace(/^<body[^>]*>/, '');
  document.documentElement.setAttribute('data-mode', 'light');
  document.body.innerHTML = body;
  // eslint-disable-next-line no-eval
  (0, eval)(CHART_LIBRARY_SOURCE);
  // eslint-disable-next-line no-eval
  (0, eval)(CHART_RUNTIME_SOURCE);
});

const PREFS = {
  scaleMode: 'normal', invert: false, autoScale: true, alignLabels: true, lastValueVisible: true, countdown: true,
  dayOfWeek: false, hours24: true, secondsVisible: false, gridLines: true, diagnostics: true,
  upColor: '#26A69A', downColor: '#EF5350', tpColor: '#10b981', slColor: '#ef4444', entryColor: '#EAB308', buyColor: '#22C55E', sellColor: '#EF4444',
};
const PILL_COLORS = { tp: '#10b981', sl: '#ef4444', entry: '#EAB308', buy: '#22C55E', sell: '#EF4444' };

describe('the chart WebView runtime', () => {
  it('boots and says ready', () => {
    expect(posted.find((m) => m.type === 'ready')).toEqual({ type: 'ready', version: 1 });
    expect(typeof (window as unknown as { __aatReceive: unknown }).__aatReceive).toBe('function');
  });

  it('init + history: no error, the status line names the instrument, the countdown and diagnostics show', () => {
    send({
      type: 'init', mode: 'light', sub: { background: '#F8F9FB', text: '#1F2937', grid: '#E5E7EB', border: '#D1D5DB' },
      prefs: PREFS, chartType: 'candles', indicators: {}, legend: [], precision: 5, symbol: 'EURUSD', name: 'Euro / US Dollar',
      timeframe: '1m', timeZone: 'local', hideHeader: false, legendInset: 0, pillColors: PILL_COLORS, sync: { crosshair: false, time: false }, logoUrl: '',
    });
    send({ type: 'candles', symbol: 'EURUSD', timeframe: '1m', candles: candles(120), fit: true });
    expect(errors()).toEqual([]);
    expect(document.getElementById('aat-status')?.textContent).toContain('Euro / US Dollar');
    expect(document.getElementById('aat-countdown')?.style.display).toBe('block');
    expect(document.getElementById('aat-diag')?.textContent).toContain('Total candles');
  });

  it('a live bar, every chart type, and the theme switch run clean', () => {
    const cs = candles(120);
    const lastBar = cs[cs.length - 1] as (typeof cs)[number];
    send({ type: 'candle', symbol: 'EURUSD', timeframe: '1m', candle: { ...lastBar, close: lastBar.close + 0.0002 } });
    send({ type: 'candle', symbol: 'EURUSD', timeframe: '1m', candle: { ...lastBar, time: lastBar.time + 60 } });
    // A bar for another symbol is ignored, not merged.
    send({ type: 'candle', symbol: 'GBPUSD', timeframe: '1m', candle: { ...lastBar, time: lastBar.time + 120 } });
    for (const ct of ['bars', 'hollowCandles', 'line', 'lineMarkers', 'stepLine', 'area', 'baseline', 'histogram', 'heikinAshi', 'candles']) {
      send({ type: 'chartType', chartType: ct });
      // PriceChart.jsx pushes the live price into the series' last point on
      // every tick — OHLC types widen the bar, value types move the point.
      send({ type: 'quote', bid: lastBar.close - 0.0001, ask: lastBar.close + 0.0001, last: lastBar.close + 0.0003 });
      send({ type: 'quote', bid: lastBar.close - 0.0001, ask: lastBar.close + 0.0001, last: lastBar.close - 0.0009 });
    }
    send({ type: 'theme', mode: 'dark', sub: { background: '#161B22', text: '#ADB5BF', grid: '#21262D', border: '#30363D' } });
    send({ type: 'prefs', prefs: { ...PREFS, scaleMode: 'log', invert: true, gridLines: false, countdown: false }, pillColors: PILL_COLORS });
    expect(errors()).toEqual([]);
    expect(document.documentElement.getAttribute('data-mode')).toBe('dark');
    expect(document.getElementById('aat-countdown')?.style.display).toBe('none');
  });

  it('indicators: overlays, the legend and one sub-pane per oscillator, in the web\'s order', () => {
    send({
      type: 'indicators',
      indicators: { ema21: true, sma50: { color: '#111111', lineWidth: 3 }, bb: true, psar: true, supertrend: true, vwap: true, volume: true, macd: true, rsi: { length: 9 } },
      legend: [{ key: 'ema21', label: 'EMA (21)', color: '#1D4ED8' }, { key: 'rsi', label: 'RSI (9)', color: '#8B5CF6' }],
    });
    expect(errors()).toEqual([]);
    const heads = [...document.querySelectorAll('#aat-subs .aat-sub-head')].map((n) => n.textContent);
    expect(heads).toEqual(['RSI (9)', 'MACD (12, 26, 9)']);
    expect(document.getElementById('aat-legend-rows')?.textContent).toContain('EMA (21)');
    send({ type: 'indicators', indicators: {}, legend: [] });
    expect(document.querySelectorAll('#aat-subs .aat-sub')).toHaveLength(0);
    expect(errors()).toEqual([]);
  });

  it('lines and pills: one pill per descriptor; a tap posts pillTap, × posts pillClose', () => {
    send({ type: 'quote', bid: 1.0801, ask: 1.0803, last: 1.0802 });
    send({
      type: 'lines',
      lines: [
        { key: 'pos:p1:entry', price: 1.08, color: '#EAB308', lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: '' },
        { key: 'pos:p1:sl', price: 1.075, color: '#ef4444', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' },
        { key: 'order:o1:limit', price: 1.07, color: '#10b981', lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: 'BUY LIM' },
      ],
    });
    send({
      type: 'pills',
      colors: PILL_COLORS,
      pills: [
        { key: 'pos:p1:entry', kind: 'entry', target: 'position', id: 'p1', price: 1.08, side: 'BUY', qty: 1000, entry: 1.08, pnl: 12.5, quickTp: true, quickSl: false },
        { key: 'pos:p1:sl', kind: 'sl', target: 'position', id: 'p1', price: 1.075, side: 'BUY', qty: 1000, entry: 1.08, pnl: 0, quickTp: false, quickSl: false },
        { key: 'order:o1:entry', kind: 'entry', target: 'order', id: 'o1', price: 1.07, side: 'BUY', qty: 500, entry: 1.07, pnl: 0, orderType: 'LIMIT', quickTp: true, quickSl: true },
      ],
    });
    expect(errors()).toEqual([]);
    const pills = [...document.querySelectorAll('.aat-pill')] as HTMLElement[];
    expect(pills).toHaveLength(3);
    // The SL pill shows the P&L AT the stop, in rupees: (1.075 − 1.08) × 1000 = −₹5.00.
    expect(pills[1]?.textContent).toContain('SL');
    expect(pills[1]?.textContent).toContain('-₹5.00');
    expect(pills[0]?.textContent).toContain('+₹12.50');
    expect(pills[2]?.textContent).toContain('LIMIT');

    const body = pills[0]?.querySelector('.aat-pill-main') as HTMLElement;
    pointer('pointerdown', body, 100, 100);
    pointer('pointerup', window, 100, 100);
    expect(last('pillTap')).toEqual({ type: 'pillTap', key: 'pos:p1:entry' });

    const x = pills[1]?.querySelector('[data-close]') as HTMLElement;
    pointer('pointerdown', x, 100, 100);
    expect(last('pillClose')).toEqual({ type: 'pillClose', key: 'pos:p1:sl' });
  });

  it('dragging a pill past the click threshold commits a price, never a tap', () => {
    const before = posted.filter((m) => m.type === 'pillTap').length;
    const pill = [...document.querySelectorAll('.aat-pill')][1] as HTMLElement;
    const main = pill.querySelector('.aat-pill-main') as HTMLElement;
    pointer('pointerdown', main, 100, 200);
    pointer('pointermove', window, 100, 240);
    pointer('pointerup', window, 100, 240);
    const commit = last('pillCommit');
    expect(commit?.key).toBe('pos:p1:sl');
    expect(Number.isFinite(Number(commit?.price))).toBe(true);
    expect(posted.filter((m) => m.type === 'pillTap').length).toBe(before);
    expect(errors()).toEqual([]);
  });

  it('+TP on an order pill drags a NEW level on the order', () => {
    const orderPill = [...document.querySelectorAll('.aat-pill')].find((n) => n.textContent?.includes('LIMIT')) as HTMLElement;
    const quick = orderPill.querySelector('[data-quick="tp"]') as HTMLElement;
    pointer('pointerdown', quick, 100, 300);
    pointer('pointermove', window, 100, 250);
    pointer('pointerup', window, 100, 250);
    expect(last('pillCommit')?.key).toBe('order:o1:tp:new');
    // The synthetic pill is gone once dropped.
    expect([...document.querySelectorAll('.aat-pill')]).toHaveLength(3);
  });

  it('legend and symbol taps post their events', () => {
    send({ type: 'indicators', indicators: { rsi: true }, legend: [{ key: 'rsi', label: 'RSI (14)', color: '#8B5CF6' }] });
    (document.querySelector('[data-leg-remove="rsi"]') as HTMLElement).click();
    expect(last('legendTap')).toEqual({ type: 'legendTap', key: 'rsi', action: 'remove' });
    (document.querySelector('[data-leg-edit="rsi"]') as HTMLElement).click();
    expect(last('legendTap')).toEqual({ type: 'legendTap', key: 'rsi', action: 'edit' });
    (document.querySelector('[data-sym]') as HTMLElement).click();
    expect(last('symbolTap')).toEqual({ type: 'symbolTap' });
  });

  it('drawings: load, tool, undo / redo, lock and hide report their state', () => {
    send({
      type: 'drawings',
      drawings: [{ id: 'd1', kind: 'hline', family: 'hline', pts: [{ logical: 50, time: null, price: 1.08 }], color: '#2962FF', width: 2, style: 'solid' }],
    });
    expect(last('drawState')).toMatchObject({ count: 1, canUndo: false, selectedId: null });
    send({ type: 'draw', cmd: 'setTool', arg: { tool: 'trendline', meta: { family: 'trend', pts: 2 } } });
    expect(last('drawState')).toMatchObject({ tool: 'trendline' });
    send({ type: 'draw', cmd: 'add', arg: { tool: 'text', meta: { family: 'text', pts: 1 }, pts: [{ logical: 40, time: null, price: 1.081 }], extra: { text: 'Hello' } } });
    expect(last('drawings')?.drawings).toHaveLength(2);
    expect(last('drawState')).toMatchObject({ count: 2, canUndo: true });
    send({ type: 'draw', cmd: 'undo' });
    expect(last('drawState')).toMatchObject({ count: 1, canRedo: true });
    send({ type: 'draw', cmd: 'redo' });
    expect(last('drawState')).toMatchObject({ count: 2 });
    send({ type: 'draw', cmd: 'setLocked', arg: { value: true } });
    expect(last('drawState')).toMatchObject({ locked: true });
    send({ type: 'draw', cmd: 'setHidden', arg: { value: true } });
    expect(last('drawState')).toMatchObject({ hidden: true });
    send({ type: 'draw', cmd: 'clearAll' });
    expect(last('drawState')).toMatchObject({ count: 0 });
    expect(errors()).toEqual([]);
  });

  it('scale commands, sync messages and overlays run clean', () => {
    for (const cmd of ['refresh', 'autoFit', 'resetY', 'resetX', 'resetAll']) send({ type: 'scale', cmd });
    expect(last('scaleLocks')).toEqual({ type: 'scaleLocks', manualPrice: false, manualTime: false });
    send({ type: 'crosshair', time: null, price: null });
    send({ type: 'range', from: 10, to: 60 });
    send({
      type: 'overlays', signals: true, hmr: true,
      calendar: [{ ts: Date.now() - 30 * 60_000, currency: 'USD', impact: 'high', code: 'USD' }],
      nextEvent: { ts: Date.now() + 90 * 60_000, currency: 'EUR', impact: 'medium', event: 'CPI y/y' },
    });
    expect(document.getElementById('aat-event')?.textContent).toContain('CPI y/y');
    send({ type: 'meta', precision: 3, name: 'EUR/USD', hideHeader: true, legendInset: 18 });
    expect(document.getElementById('aat-legend')?.style.left).toBe('26px');
    expect(errors()).toEqual([]);
  });

  it('a malformed or unknown message is ignored, not thrown', () => {
    const receive = (window as unknown as { __aatReceive: (s: string) => void }).__aatReceive;
    expect(() => receive('not json')).not.toThrow();
    expect(() => receive(JSON.stringify({ type: 'nope' }))).not.toThrow();
    expect(errors()).toEqual([]);
  });
});
