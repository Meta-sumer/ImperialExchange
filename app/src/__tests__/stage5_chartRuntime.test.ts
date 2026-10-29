/**
 * The chart WebView runtime — checked against the WEB'S OWN SOURCE.
 *
 * The runtime (src/charts/runtime/*.js) runs inside the chart WebView, so it
 * is plain JavaScript and is bundled into generated.ts by
 * scripts/build-chart-runtime.mjs. This file pins:
 *
 *   • the bundle — generated.ts must be exactly the current sources, so a
 *     runtime edit without a rebuild fails here, not on a phone;
 *   • the maths — every indicator, the candle clean-up, Heikin Ashi, the
 *     diagnostics audit and the measure tool's stats, run beside the web's
 *     own functions (lifted with `new Function`) on the same candles;
 *   • the catalogues — tool groups, layouts, the indicator catalogue and
 *     list, chart-settings defaults — deep-equal to the web's.
 */
import fs from 'fs';
import path from 'path';

import { CHART_RUNTIME_FILES, CHART_RUNTIME_SOURCE } from '@/charts/runtime/generated';
import { DEFAULT_CHART_PREFS, INDICATORS, INDICATOR_LIST, MA_TYPES, labelForActive, parseMaKey, applyIndicatorSettings, sanitizeLength, mergeChartPrefs } from '@/charts/chartCatalog';
import { GROUPS, CURSORS, RAIL, TOOL_META, HAS_FILL, HAS_STYLE, HAS_WIDTH, TEXT_TOOLS, railGroups, engineMeta } from '@/charts/chartTools';
import { LAYOUTS, DEFAULT_SYNC, SYNC_FIELDS, cellFrame, getLayout } from '@/charts/chartLayouts';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const I = require('@/charts/runtime/indicators.js') as Record<string, (...a: unknown[]) => unknown>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const C = require('@/charts/runtime/candles.js') as {
  fillCandleGaps: (c: unknown[], tf: number, now?: number) => Cndl[];
  analyzeCandles: (c: unknown[], tf: number, now?: number) => unknown;
  toHeikinAshi: (c: unknown[]) => unknown[];
  mergeLiveCandle: (c: Cndl[], raw: unknown, tf: number, now?: number) => { candles: Cndl[]; point: Cndl; action: string; bulk: boolean } | null;
  medianClose: (c: Cndl[]) => number;
  MAX_BAR_MOVE: number;
  MAX_GAP_FILL_SEC: number;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const D = require('@/charts/runtime/drawings.js') as { measureStats: (d: unknown, c: unknown[], p: number) => unknown; normalize: (d: unknown, m: unknown) => Record<string, unknown> };

interface Cndl { time: number; open: number; high: number; low: number; close: number; volume: number }

const APP = path.join(__dirname, '../..');
const ROOT = path.join(APP, '..');
const readLf = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const between = (src: string, start: string, end: string, from = 0): string => {
  const a = src.indexOf(start, from);
  if (a < 0) throw new Error(`slice start moved: ${start}`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`slice end moved: ${end}`);
  return src.slice(a, b);
};
const through = (src: string, start: string, end: string): string => between(src, start, end) + end;
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const lift = <T,>(body: string): T => (new Function(body) as () => T)();

const PRICE_CHART = readLf(path.join(ROOT, 'client/src/components/PriceChart.jsx'));

/* ── fixtures: a deterministic, realistic walk ── */
const makeCandles = (n: number, start = 1_700_000_040, tf = 60): Cndl[] => {
  const out: Cndl[] = [];
  let px = 100;
  let seed = 7;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = Math.max(1, o + (rnd() - 0.48) * 2);
    const h = Math.max(o, c) + rnd();
    const l = Math.min(o, c) - rnd();
    out.push({ time: start + i * tf, open: o, high: h, low: l, close: c, volume: Math.round(rnd() * 1000) });
    px = c;
  }
  return out;
};
const CANDLES = makeCandles(260);
const CLOSES = CANDLES.map((c) => c.close);

describe('the bundle', () => {
  it('generated.ts is the current runtime sources, in order (run scripts/build-chart-runtime.mjs)', () => {
    const dir = path.join(APP, 'src/charts/runtime');
    const expected = CHART_RUNTIME_FILES
      .map((f) => `/* ── ${f} ── */\n${fs.readFileSync(path.join(dir, f), 'utf8')}`)
      .join('\n;\n');
    expect(CHART_RUNTIME_FILES).toEqual(['indicators.js', 'candles.js', 'drawings.js', 'chart.js']);
    expect(CHART_RUNTIME_SOURCE === expected).toBe(true);
  });

  it('postinstall rebuilds it', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.postinstall).toContain('build-chart-runtime.mjs');
  });
});

describe('indicators — the web\'s utils/indicators.js, function for function', () => {
  const src = readLf(path.join(ROOT, 'client/src/utils/indicators.js')).replace(/export const /g, 'const ');
  const names = ['sma', 'ema', 'rsi', 'macd', 'bollinger', 'vwap', 'stochastic', 'atr', 'williamsR', 'cci', 'donchian', 'keltner', 'wma', 'hma', 'dema', 'tema', 'smma', 'vwma', 'alma', 'envelopes', 'linreg', 'psar', 'supertrend'];
  const web = lift<Record<string, (...a: unknown[]) => unknown>>(`${src}\nreturn { ${names.join(', ')} };`);

  it('exports the same set', () => {
    expect(Object.keys(I).sort()).toEqual([...names].sort());
  });

  const closeCases: [string, unknown[]][] = [
    ['sma', [CLOSES, 20]], ['ema', [CLOSES, 21]], ['rsi', [CLOSES, 14]], ['macd', [CLOSES, 12, 26, 9]],
    ['bollinger', [CLOSES, 20, 2]], ['wma', [CLOSES, 20]], ['hma', [CLOSES, 21]], ['dema', [CLOSES, 21]],
    ['tema', [CLOSES, 21]], ['smma', [CLOSES, 21]], ['alma', [CLOSES, 21]], ['envelopes', [CLOSES, 20, 2]],
    ['linreg', [CLOSES, 14]], ['sma', [CLOSES.slice(0, 5), 20]], ['rsi', [CLOSES.slice(0, 10), 14]],
  ];
  it.each(closeCases)('%s on closes matches', (name, args) => {
    expect(I[name]?.(...args)).toEqual(web[name]?.(...args));
  });

  const candleCases: [string, unknown[]][] = [
    ['vwap', [CANDLES]], ['stochastic', [CANDLES, 14, 3]], ['atr', [CANDLES, 14]], ['williamsR', [CANDLES, 14]],
    ['cci', [CANDLES, 20]], ['donchian', [CANDLES, 20]], ['keltner', [CANDLES, 20, 2, 10]], ['vwma', [CANDLES, 20]],
    ['psar', [CANDLES]], ['supertrend', [CANDLES, 10, 3]], ['atr', [CANDLES.slice(0, 10), 14]],
  ];
  it.each(candleCases)('%s on candles matches', (name, args) => {
    expect(I[name]?.(...args)).toEqual(web[name]?.(...args));
  });
});

describe('the candle pipeline — PriceChart.jsx:228-385', () => {
  const body = [
    through(PRICE_CHART, 'const TF_SECONDS = {', '};'),
    through(PRICE_CHART, 'export const bucketFloor = ', ';'),
    through(PRICE_CHART, 'const MAX_BAR_MOVE = ', ';'),
    through(PRICE_CHART, 'const MAX_GAP_FILL_SEC = ', ';'),
    through(PRICE_CHART, 'export function fillCandleGaps(candles, tfSec) {', '\n}'),
    through(PRICE_CHART, 'export function analyzeCandles(raw, tfSec) {', '\n}'),
    through(PRICE_CHART, 'export function convertToHeikinAshi(candles) {', '\n}'),
  ].join('\n').replace(/export /g, '');
  const web = lift<{ fillCandleGaps: (c: unknown[], tf: number) => Cndl[]; analyzeCandles: (c: unknown[], tf: number) => unknown; convertToHeikinAshi: (c: unknown[]) => unknown[] }>(
    `${body}\nreturn { fillCandleGaps, analyzeCandles, convertToHeikinAshi };`,
  );
  const NOW = 1_700_000_040 + 400 * 60;
  let spy: jest.SpyInstance;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    spy = jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => { spy.mockRestore(); warn.mockRestore(); });

  // Gaps, a duplicate bucket, an inverted bar, a spike, a zero low, a future bar and junk.
  const dirty = (): unknown[] => {
    const c: unknown[] = makeCandles(60).map((x) => ({ ...x }));
    c.splice(10, 3);
    c.splice(20, 0, { ...(c[19] as Cndl), close: (c[19] as Cndl).close + 0.5 });
    const inv = c[25] as Cndl;
    c[25] = { ...inv, high: inv.low - 1, low: inv.high + 1 };
    c[30] = { ...(c[30] as Cndl), high: (c[30] as Cndl).high * 12 };
    c[33] = { ...(c[33] as Cndl), low: 0 };
    c.push({ time: NOW + 3600, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    c.push({ time: Number.NaN, open: 1, high: 1, low: 1, close: 1 });
    c.push(null);
    return c.sort((a, b) => (Number((a as Cndl | null)?.time) || 0) - (Number((b as Cndl | null)?.time) || 0));
  };

  it('fillCandleGaps: repair, dedupe, outlier guard and carry-forward — same result', () => {
    const input = dirty();
    expect(C.fillCandleGaps(JSON.parse(JSON.stringify(input)), 60)).toEqual(web.fillCandleGaps(JSON.parse(JSON.stringify(input)), 60));
    expect(C.fillCandleGaps(CANDLES, 60)).toEqual(web.fillCandleGaps(CANDLES, 60));
  });

  it('fillCandleGaps never invents movement: a filler is flat at the previous close with no volume', () => {
    const out = C.fillCandleGaps([{ time: 60, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 }, { time: 300, open: 1.5, high: 1.6, low: 1.4, close: 1.55, volume: 3 }], 60, 10_000);
    expect(out.map((c) => c.time)).toEqual([60, 120, 180, 240, 300]);
    expect(out[1]).toEqual({ time: 120, open: 1.5, high: 1.5, low: 1.5, close: 1.5, volume: 0 });
  });

  it('a gap longer than MAX_GAP_FILL_SEC (6 h) stays a real gap — no flat plateau', () => {
    expect(C.MAX_GAP_FILL_SEC).toBe(6 * 60 * 60);
    const overnight = [{ time: 600, open: 1, high: 1, low: 1, close: 1, volume: 1 }, { time: 600 + 7 * 3600, open: 2, high: 2, low: 2, close: 2, volume: 1 }];
    expect(C.fillCandleGaps(overnight, 60, 10 ** 9).map((c) => c.time)).toEqual([600, 600 + 7 * 3600]);
    expect(C.fillCandleGaps(overnight, 60, 10 ** 9)).toEqual(web.fillCandleGaps(overnight, 60));
  });

  it('analyzeCandles and Heikin Ashi match', () => {
    const input = dirty();
    expect(C.analyzeCandles(input, 60)).toEqual(web.analyzeCandles(input, 60));
    expect(C.toHeikinAshi(CANDLES)).toEqual(web.convertToHeikinAshi(CANDLES));
  });
});

describe('a live bar (PriceChart.jsx:2246-2342)', () => {
  const base = makeCandles(5, 600, 60);
  const now = 600 + 10 * 60;
  const last = base[4] as Cndl;

  it('same bucket → replaces the forming bar', () => {
    const r = C.mergeLiveCandle(base, { ...last, close: last.close + 0.1 }, 60, now);
    expect(r?.action).toBe('update-current');
    expect(r?.bulk).toBe(false);
    expect(r?.candles).toHaveLength(5);
    expect(r?.candles[4]?.close).toBeCloseTo(last.close + 0.1);
  });

  it('next bucket → appends; a skipped bucket → carry-forward fillers and a bulk set', () => {
    expect(C.mergeLiveCandle(base, { ...last, time: last.time + 60 }, 60, now)?.action).toBe('new');
    const gap = C.mergeLiveCandle(base, { ...last, time: last.time + 180 }, 60, now);
    expect(gap?.action).toBe('new-with-gap-fill');
    expect(gap?.bulk).toBe(true);
    expect(gap?.candles.slice(5, 7).map((c) => [c.time, c.open, c.close, c.volume])).toEqual([[last.time + 60, last.close, last.close, 0], [last.time + 120, last.close, last.close, 0]]);
  });

  it('drops late, future and unusable ticks', () => {
    expect(C.mergeLiveCandle(base, { ...last, time: last.time - 60 }, 60, now)).toBeNull();
    expect(C.mergeLiveCandle(base, { ...last, time: now + 600 }, 60, now)).toBeNull();
    expect(C.mergeLiveCandle(base, { time: last.time, close: 'x' }, 60, now)).toBeNull();
  });

  it('repairs an inverted bar and clamps a > 60% spike to the band', () => {
    const inv = C.mergeLiveCandle(base, { time: last.time, open: 10, high: 5, low: 20, close: 11 }, 60, now);
    const prev = base[3] as Cndl;
    // Relative to the previous close the whole bar is an outlier → clamped into ±60%.
    expect(inv?.point.high).toBeGreaterThanOrEqual(Math.max(inv?.point.open ?? 0, inv?.point.close ?? 0));
    const spike = C.mergeLiveCandle(base, { ...last, time: last.time + 60, open: last.close, high: last.close * 5, low: last.close, close: last.close * 5 }, 60, now);
    expect(spike?.point.high).toBeCloseTo(last.close * (1 + C.MAX_BAR_MOVE));
    expect(spike?.point.close).toBeCloseTo(last.close * (1 + C.MAX_BAR_MOVE));
    expect(prev).toBeDefined();
  });
});

describe('drawings — measure stats (useChartDrawings.js:90)', () => {
  const src = readLf(path.join(ROOT, 'client/src/hooks/useChartDrawings.js'));
  const web = lift<(d: unknown, c: unknown[], p: number) => unknown>(
    `${through(src, 'const measureStats = (d, candles, prec) => {', '\n};')}\nreturn measureStats;`,
  );
  it('the same stats from the same drawing and candles', () => {
    const d = { pts: [{ time: CANDLES[10]?.time, logical: 10, price: 100 }, { time: CANDLES[40]?.time, logical: 40, price: 104.5 }] };
    expect(D.measureStats(d, CANDLES, 2)).toEqual(web(d, CANDLES, 2));
    const noTime = { pts: [{ time: null, logical: 3, price: 1 }, { time: null, logical: 9, price: 0.5 }] };
    expect(D.measureStats(noTime, CANDLES, 5)).toEqual(web(noTime, CANDLES, 5));
  });

  it('a new drawing gets the web defaults for its family', () => {
    // Fib retracements are thin and UNfilled on the web (only the fib channel fills).
    expect(D.normalize({ id: 'x', kind: 'fibretr', pts: [] }, { family: 'fib', pts: 2 })).toMatchObject({ family: 'fib', width: 1, color: '#2962FF', style: 'solid', locked: false });
    expect(D.normalize({ id: 'x', kind: 'fibretr', pts: [] }, { family: 'fib', pts: 2 }).fill).toBeUndefined();
    expect(D.normalize({ id: 'w', kind: 'fibchannel', pts: [] }, { family: 'fibchannel', pts: 3 }).fill).toBe(true);
    expect(D.normalize({ id: 'y', kind: 'highlighter', pts: [] }, { family: 'brush', pts: 'free', variant: 'hl' })).toMatchObject({ width: 12, color: '#FACC15', variant: 'hl' });
    expect(D.normalize({ id: 'z', kind: 'pricerange', pts: [], color: '#000000' }, { family: 'measure', pts: 2 })).toMatchObject({ color: '#000000' });
  });
});

describe('catalogues — deep-equal to the web', () => {
  it('drawing tools (chartTools.js): groups, cursors, rail, meta, style sets', () => {
    const src = readLf(path.join(ROOT, 'client/src/components/chartTools.js')).replace(/export const /g, 'const ');
    const web = lift<Record<string, unknown>>(`${src}\nreturn { GROUPS, CURSORS, RAIL, TOOL_META, HAS_WIDTH, HAS_STYLE, HAS_FILL, TEXT_TOOLS };`);
    expect(JSON.parse(JSON.stringify(GROUPS))).toEqual(web.GROUPS);
    expect(CURSORS.map((c) => [c.tool, c.label])).toEqual((web.CURSORS as { tool: string; label: string }[]).map((c) => [c.tool, c.label]));
    expect(JSON.parse(JSON.stringify(RAIL))).toEqual(web.RAIL);
    expect(JSON.parse(JSON.stringify(TOOL_META))).toEqual(web.TOOL_META);
    expect([...HAS_WIDTH]).toEqual([...(web.HAS_WIDTH as Set<string>)]);
    expect([...HAS_STYLE]).toEqual([...(web.HAS_STYLE as Set<string>)]);
    expect([...HAS_FILL]).toEqual([...(web.HAS_FILL as Set<string>)]);
    expect([...TEXT_TOOLS]).toEqual([...(web.TEXT_TOOLS as Set<string>)]);
    // "88 tools": 83 drawing tools, 4 cursors (incl. the eraser) and the sticker tool.
    const count = GROUPS.reduce((n, g) => n + g.items.length, 0);
    expect(count + CURSORS.length + 1).toBe(88);
  });

  it('the engine gets each tool\'s geometry; searching the rail filters within its groups', () => {
    expect(engineMeta('fibext')).toEqual({ family: 'fib', pts: 3, variant: 'ext' });
    expect(engineMeta('arrowup')).toEqual({ family: 'marker', pts: 1, glyph: '⬆' });
    expect(engineMeta('nope')).toBeNull();
    expect(railGroups('lines', 'pitch').map((g) => g.name)).toEqual(['Pitchforks']);
    expect(railGroups('fib', 'zzz')).toEqual([]);
  });

  it('layouts (chartLayouts.js)', () => {
    const src = readLf(path.join(ROOT, 'client/src/components/chartLayouts.js')).replace(/export const /g, 'const ');
    const web = lift<{ LAYOUTS: unknown; DEFAULT_SYNC: unknown; SYNC_FIELDS: unknown }>(`${src}\nreturn { LAYOUTS, DEFAULT_SYNC, SYNC_FIELDS };`);
    expect(JSON.parse(JSON.stringify(LAYOUTS))).toEqual(web.LAYOUTS);
    expect(DEFAULT_SYNC).toEqual(web.DEFAULT_SYNC);
    expect(JSON.parse(JSON.stringify(SYNC_FIELDS))).toEqual(web.SYNC_FIELDS);
    expect(getLayout('nope').id).toBe('1');
    expect(cellFrame(getLayout('3lr'), [1, 1, 1, 2])).toEqual({ left: 0, top: 0, width: 50, height: 100 });
  });

  it('indicator catalogue (indicatorCatalog.js) and the flat list (PriceChart.jsx buildIndicatorList)', () => {
    const src = readLf(path.join(ROOT, 'client/src/components/indicatorCatalog.js')).replace(/export const /g, 'const ').replace(/export function /g, 'function ');
    const web = lift<{ MA_TYPES: unknown; INDICATORS: unknown; labelForActive: (k: string, c?: unknown) => string }>(`${src}\nreturn { MA_TYPES, INDICATORS, labelForActive };`);
    expect(JSON.parse(JSON.stringify(MA_TYPES))).toEqual(web.MA_TYPES);
    expect(JSON.parse(JSON.stringify(INDICATORS))).toEqual(web.INDICATORS);
    for (const k of ['ema21', 'sma200', 'rsi', 'bb', 'vwap', 'macd', 'unknown']) {
      expect(labelForActive(k, { length: k === 'bb' ? 30 : undefined })).toBe(web.labelForActive(k, { length: k === 'bb' ? 30 : undefined }));
    }
    const listSrc = [
      through(PRICE_CHART, 'const MA_DEFS = [', '];').replace(/fn: \w+,/g, ''),
      through(PRICE_CHART, 'const TV_COLORS = {', '};'),
      through(PRICE_CHART, 'const buildIndicatorList = () => [', '\n].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: \'base\' }));'),
    ].join('\n');
    const webList = lift<() => { key: string; label: string; color: string }[]>(`${listSrc}\nreturn buildIndicatorList;`)();
    expect(INDICATOR_LIST.map((i) => [i.key, i.label, i.color])).toEqual(webList.map((i) => [i.key, i.label, i.color]));
  });

  it('chart settings defaults (PriceChart.jsx:852)', () => {
    const web = lift<Record<string, unknown>>(`${through(PRICE_CHART, 'export const DEFAULT_CHART_PREFS = {', '\n};').replace('export ', '')}\nreturn DEFAULT_CHART_PREFS;`);
    expect(DEFAULT_CHART_PREFS).toEqual(web);
    expect(mergeChartPrefs({ upColor: '#000000', scaleMode: 'bogus', invert: 'yes' })).toEqual({ ...DEFAULT_CHART_PREFS, upColor: '#000000' });
  });

  it('runtime MA codes and colours match the catalogue', () => {
    const chartSrc = fs.readFileSync(path.join(APP, 'src/charts/runtime/chart.js'), 'utf8');
    for (const ma of MA_TYPES) {
      expect(chartSrc).toContain(`${ma.code}: { fn: I.${ma.code}, src: '${ma.code === 'vwma' ? 'candles' : 'closes'}', color: '${ma.color}', name: '${ma.name}' }`);
    }
  });
});

describe('indicator settings (IndicatorsPanel.jsx applyModal)', () => {
  it('an MA whose period changes moves to its new key; others keep theirs', () => {
    const ema = MA_TYPES.find((m) => m.code === 'ema');
    const rsi = INDICATORS.find((i) => i.key === 'rsi');
    if (!ema || !rsi) throw new Error('catalogue');
    const a = applyIndicatorSettings({ ema21: true, rsi: true }, { type: 'ma', ma: ema }, 'ema21', { period: 50, color: '#111111', lineWidth: 2, lineStyle: 1 });
    expect(a).toEqual({ ema50: { color: '#111111', lineWidth: 2, lineStyle: 1 }, rsi: true });
    const b = applyIndicatorSettings(a, { type: 'ind', ind: rsi }, 'rsi', { length: 21, color: '#222222', lineWidth: 1, lineStyle: 0 });
    expect(b.rsi).toEqual({ color: '#222222', lineWidth: 1, lineStyle: 0, length: 21 });
    expect(parseMaKey('ema50')?.period).toBe(50);
    expect(parseMaKey('rsi')).toBeNull();
    expect(sanitizeLength('abc', 14)).toBe(14);
    expect(sanitizeLength('5000', 14)).toBe(1000);
    expect(sanitizeLength('9.6', 14)).toBe(10);
  });
});
