/**
 * What the chart can show — ported from client/src/components/PriceChart.jsx
 * (CHART_TYPES, TF_OPTIONS, MA_DEFS, INDICATOR_DEFAULTS, DEFAULT_CHART_PREFS,
 * buildIndicatorList) and client/src/components/indicatorCatalog.js.
 *
 * The indicator MODEL is the web's, so a set saved by one client means the
 * same on the other:
 *   indicators[key] === true                          → on, default params
 *   indicators[key] === { color, lineWidth, lineStyle, length } → on, custom
 *   falsy / absent                                    → off
 * A moving average's period is part of its key (`ema21`).
 *
 * The WebView runtime (src/charts/runtime/chart.js) keeps its own copy of
 * the MA codes and colours next to the maths; stage5_chartRuntime pins the
 * two together.
 */

export type ChartType =
  | 'candles' | 'bars' | 'hollowCandles' | 'line' | 'lineMarkers'
  | 'stepLine' | 'area' | 'baseline' | 'histogram' | 'heikinAshi';

export const CHART_TYPES: readonly { id: ChartType; label: string }[] = [
  { id: 'candles', label: 'Candles' },
  { id: 'bars', label: 'Bars' },
  { id: 'hollowCandles', label: 'Hollow Candles' },
  { id: 'line', label: 'Line' },
  { id: 'lineMarkers', label: 'Line with Markers' },
  { id: 'stepLine', label: 'Step Line' },
  { id: 'area', label: 'Area' },
  { id: 'baseline', label: 'Baseline' },
  { id: 'histogram', label: 'Columns / Histogram' },
  { id: 'heikinAshi', label: 'Heikin Ashi' },
];

export const isChartType = (v: unknown): v is ChartType =>
  typeof v === 'string' && CHART_TYPES.some((t) => t.id === v);

export const chartTypeLabel = (id: ChartType): string =>
  CHART_TYPES.find((t) => t.id === id)?.label ?? 'Candles';

/** PriceChart.jsx:824 — the chart's own timeframes (the Trade page's). */
export const TF_OPTIONS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type ChartTimeframe = (typeof TF_OPTIONS)[number];
export const isChartTimeframe = (v: unknown): v is ChartTimeframe =>
  typeof v === 'string' && (TF_OPTIONS as readonly string[]).includes(v);

/* ── Indicators ───────────────────────────────────────────────────────── */

export interface IndicatorParams {
  color?: string;
  lineWidth?: number;
  lineStyle?: number;
  length?: number;
}
export type IndicatorValue = boolean | IndicatorParams;
export type IndicatorMap = Record<string, IndicatorValue | undefined>;

export const CATEGORIES = ['Trend', 'Momentum', 'Volatility', 'Volume', 'Oscillators'] as const;
export type IndicatorCategory = (typeof CATEGORIES)[number];

export interface MaType {
  code: string;
  name: string;
  color: string;
  /** The default period (indicatorCatalog.js). */
  def: number;
  /** The presets PriceChart.jsx:12 knows; any period 1–1000 is allowed. */
  periods: readonly number[];
}

export const MA_TYPES: readonly MaType[] = [
  { code: 'ema', name: 'EMA', color: '#1D4ED8', def: 21, periods: [5, 8, 9, 10, 12, 13, 15, 20, 21, 26, 30, 34, 50, 55, 89, 100, 150, 200] },
  { code: 'sma', name: 'SMA', color: '#F59E0B', def: 20, periods: [5, 8, 10, 13, 15, 20, 21, 25, 30, 34, 50, 55, 89, 100, 150, 200] },
  { code: 'wma', name: 'WMA', color: '#22C55E', def: 20, periods: [9, 14, 20, 21, 30, 34, 50, 55, 89, 100, 200] },
  { code: 'hma', name: 'HMA', color: '#EC4899', def: 21, periods: [9, 14, 16, 21, 34, 55, 89, 100] },
  { code: 'dema', name: 'DEMA', color: '#14B8A6', def: 21, periods: [9, 14, 20, 21, 34, 50, 100, 200] },
  { code: 'tema', name: 'TEMA', color: '#8B5CF6', def: 21, periods: [9, 14, 20, 21, 34, 50, 100, 200] },
  { code: 'smma', name: 'SMMA', color: '#0EA5E9', def: 21, periods: [7, 10, 14, 21, 34, 50, 100, 200] },
  { code: 'vwma', name: 'VWMA', color: '#F97316', def: 20, periods: [14, 20, 30, 50, 89, 100, 200] },
  { code: 'alma', name: 'ALMA', color: '#A855F7', def: 21, periods: [9, 14, 21, 34, 50, 100, 200] },
];

export interface IndicatorDef {
  key: string;
  name: string;
  cat: IndicatorCategory;
  /** Drawn on the price pane (true) or in its own sub-pane. */
  overlay: boolean;
  color: string;
  /** The settings' "Length" field; absent when the indicator has none. */
  defLength?: number;
}

export const INDICATORS: readonly IndicatorDef[] = [
  { key: 'vwap', name: 'VWAP', cat: 'Volume', overlay: true, color: '#7C3AED' },
  { key: 'linreg', name: 'Linear Regression', cat: 'Trend', overlay: true, color: '#0D9488', defLength: 14 },
  { key: 'psar', name: 'Parabolic SAR', cat: 'Trend', overlay: true, color: '#DC2626' },
  { key: 'supertrend', name: 'SuperTrend', cat: 'Trend', overlay: true, color: '#0891B2', defLength: 10 },
  { key: 'bb', name: 'Bollinger Bands', cat: 'Volatility', overlay: true, color: '#0EA5E9', defLength: 20 },
  { key: 'donchian', name: 'Donchian Channels', cat: 'Volatility', overlay: true, color: '#10B981', defLength: 20 },
  { key: 'keltner', name: 'Keltner Channels', cat: 'Volatility', overlay: true, color: '#F97316', defLength: 20 },
  { key: 'envelopes', name: 'Envelopes', cat: 'Volatility', overlay: true, color: '#64748B', defLength: 20 },
  { key: 'rsi', name: 'RSI', cat: 'Oscillators', overlay: false, color: '#8B5CF6', defLength: 14 },
  { key: 'stoch', name: 'Stochastic', cat: 'Oscillators', overlay: false, color: '#3B82F6', defLength: 14 },
  { key: 'wr', name: 'Williams %R', cat: 'Oscillators', overlay: false, color: '#DB2777', defLength: 14 },
  { key: 'cci', name: 'CCI', cat: 'Oscillators', overlay: false, color: '#7C3AED', defLength: 20 },
  { key: 'macd', name: 'MACD', cat: 'Momentum', overlay: false, color: '#2DD4BF' },
  { key: 'atr', name: 'ATR', cat: 'Volatility', overlay: false, color: '#0EA5E9', defLength: 14 },
  { key: 'volume', name: 'Volume', cat: 'Volume', overlay: false, color: '#26A69A' },
];

/**
 * The flat, sorted list the multi-chart toolbar toggles (PriceChart.jsx:889
 * buildIndicatorList): every MA preset, then the rest. Labels differ from
 * the catalogue's in two places on the web ("RSI", "Volume"), kept.
 */
export const INDICATOR_LIST: readonly { key: string; label: string; color: string }[] = [
  ...MA_TYPES.flatMap((d) => d.periods.map((p) => ({ key: `${d.code}${p}`, label: `${d.name} ${p}`, color: d.color }))),
  { key: 'bb', label: 'Bollinger Bands', color: '#0EA5E9' },
  { key: 'donchian', label: 'Donchian Channels', color: '#10B981' },
  { key: 'keltner', label: 'Keltner Channels', color: '#F97316' },
  { key: 'envelopes', label: 'Envelopes', color: '#64748B' },
  { key: 'vwap', label: 'VWAP', color: '#7C3AED' },
  { key: 'linreg', label: 'Linear Regression', color: '#0D9488' },
  { key: 'psar', label: 'Parabolic SAR', color: '#DC2626' },
  { key: 'supertrend', label: 'SuperTrend', color: '#0891B2' },
  { key: 'volume', label: 'Volume', color: 'rgba(38, 166, 154, 0.45)' },
  { key: 'rsi', label: 'RSI', color: '#8B5CF6' },
  { key: 'macd', label: 'MACD', color: '#2DD4BF' },
  { key: 'stoch', label: 'Stochastic', color: '#3B82F6' },
  { key: 'atr', label: 'ATR', color: '#0EA5E9' },
  { key: 'wr', label: 'Williams %R', color: '#DB2777' },
  { key: 'cci', label: 'CCI', color: '#7C3AED' },
].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));

export const LINE_STYLES: readonly { value: number; label: string }[] = [
  { value: 0, label: 'Solid' },
  { value: 1, label: 'Dashed' },
  { value: 2, label: 'Dotted' },
];

const MA_BY_CODE: Record<string, MaType> = Object.fromEntries(MA_TYPES.map((m) => [m.code, m]));

/** `ema21` → { code, period, def }; null for anything else (indicatorCatalog.js). */
export const parseMaKey = (key: string | null | undefined): { code: string; period: number; def: MaType } | null => {
  const m = /^([a-z]+?)(\d+)$/.exec(key || '');
  if (!m || !m[1] || !m[2]) return null;
  const def = MA_BY_CODE[m[1]];
  return def ? { code: m[1], period: Number(m[2]), def } : null;
};

export const cfgOf = (indicators: IndicatorMap, key: string): IndicatorParams => {
  const v = indicators[key];
  return v && typeof v === 'object' ? v : {};
};

/** "EMA (21)", "RSI (14)", "VWAP" (indicatorCatalog.js labelForActive). */
export const labelForActive = (key: string, cfg?: IndicatorParams): string => {
  const ma = parseMaKey(key);
  if (ma) return `${ma.def.name} (${ma.period})`;
  const ind = INDICATORS.find((i) => i.key === key);
  if (!ind) return key;
  const len = cfg?.length || ind.defLength;
  return len ? `${ind.name} (${len})` : ind.name;
};

export const categoryForKey = (key: string): IndicatorCategory => {
  if (parseMaKey(key)) return 'Trend';
  return INDICATORS.find((i) => i.key === key)?.cat ?? 'Trend';
};

/** The dot colour: the user's, else the catalogue's. */
export const indicatorColor = (indicators: IndicatorMap, key: string): string => {
  const own = cfgOf(indicators, key).color;
  if (own) return own;
  const ma = parseMaKey(key);
  if (ma) return ma.def.color;
  return INDICATORS.find((i) => i.key === key)?.color ?? '#1D4ED8';
};

/** Active keys, sorted by label — the legend's and the panel's order. */
export const activeIndicatorKeys = (indicators: IndicatorMap): string[] =>
  Object.keys(indicators)
    .filter((k) => !!indicators[k])
    .sort((a, b) => labelForActive(a, cfgOf(indicators, a)).localeCompare(labelForActive(b, cfgOf(indicators, b))));

export interface LegendRow { key: string; label: string; color: string }

export const legendRows = (indicators: IndicatorMap): LegendRow[] =>
  activeIndicatorKeys(indicators).map((key) => ({
    key,
    label: labelForActive(key, cfgOf(indicators, key)),
    color: indicatorColor(indicators, key),
  }));

/** What the settings sheet edits. */
export interface IndicatorTarget {
  type: 'ma' | 'ind';
  ma?: MaType;
  ind?: IndicatorDef;
}

export interface IndicatorApply {
  period?: number;
  length?: number;
  color: string;
  lineWidth: number;
  lineStyle: number;
}

/**
 * IndicatorsPanel.jsx applyModal: an MA whose period changed MOVES to its new
 * key; every other indicator keeps its key and stores its params.
 */
export const applyIndicatorSettings = (
  indicators: IndicatorMap,
  target: IndicatorTarget,
  previousKey: string | null,
  params: IndicatorApply,
): IndicatorMap => {
  const next: IndicatorMap = { ...indicators };
  if (target.type === 'ma' && target.ma) {
    const key = `${target.ma.code}${params.period ?? target.ma.def}`;
    if (previousKey && previousKey !== key) delete next[previousKey];
    next[key] = { color: params.color, lineWidth: params.lineWidth, lineStyle: params.lineStyle };
  } else if (target.ind) {
    next[target.ind.key] = {
      color: params.color,
      lineWidth: params.lineWidth,
      lineStyle: params.lineStyle,
      ...(params.length != null ? { length: params.length } : {}),
    };
  }
  return next;
};

export const removeIndicator = (indicators: IndicatorMap, key: string): IndicatorMap => {
  const next = { ...indicators };
  delete next[key];
  return next;
};

/** A typed period / length: whole, 1–1000, else the default (IndicatorSettingsModal.jsx apply). */
export const sanitizeLength = (raw: string, fallback: number): number => {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(1000, n) : fallback;
};

/* ── Chart settings (PriceChart.jsx:852) ──────────────────────────────── */

export type ScaleMode = 'normal' | 'log' | 'percent' | 'indexed';

export interface ChartPrefs {
  scaleMode: ScaleMode;
  invert: boolean;
  autoScale: boolean;
  alignLabels: boolean;
  lastValueVisible: boolean;
  countdown: boolean;
  dayOfWeek: boolean;
  hours24: boolean;
  secondsVisible: boolean;
  gridLines: boolean;
  diagnostics: boolean;
  upColor: string;
  downColor: string;
  tpColor: string;
  slColor: string;
  entryColor: string;
  buyColor: string;
  sellColor: string;
}

export const DEFAULT_CHART_PREFS: ChartPrefs = {
  scaleMode: 'normal',
  invert: false,
  autoScale: true,
  alignLabels: true,
  lastValueVisible: true,
  countdown: false,
  dayOfWeek: false,
  hours24: true,
  secondsVisible: false,
  gridLines: true,
  diagnostics: false,
  upColor: '#26A69A',
  downColor: '#EF5350',
  tpColor: '#10b981',
  slColor: '#ef4444',
  entryColor: '#EAB308',
  buyColor: '#22C55E',
  sellColor: '#EF4444',
};

export const SCALE_MODES: readonly { value: ScaleMode; label: string }[] = [
  { value: 'normal', label: 'Regular' },
  { value: 'log', label: 'Logarithmic' },
  { value: 'percent', label: 'Percent' },
  { value: 'indexed', label: 'Indexed to 100' },
];

/** A saved prefs object, merged over the defaults and typed (readChartPrefs). */
export const mergeChartPrefs = (raw: unknown): ChartPrefs => {
  const out: ChartPrefs = { ...DEFAULT_CHART_PREFS };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(DEFAULT_CHART_PREFS) as (keyof ChartPrefs)[]) {
    const v = r[k];
    const def = DEFAULT_CHART_PREFS[k];
    if (typeof v === typeof def) (out as unknown as Record<string, unknown>)[k] = v;
  }
  if (!SCALE_MODES.some((m) => m.value === out.scaleMode)) out.scaleMode = 'normal';
  return out;
};

/** The palette the chart's line / pill colour pickers offer. */
export const CHART_COLOR_SWATCHES: readonly string[] = [
  '#26A69A', '#10b981', '#22C55E', '#16A34A', '#0EA5E9', '#3B82F6', '#1D4ED8', '#2962FF',
  '#8B5CF6', '#7C3AED', '#EC4899', '#DB2777', '#EF5350', '#ef4444', '#DC2626', '#F97316',
  '#F59E0B', '#EAB308', '#FACC15', '#64748B', '#111827', '#FFFFFF',
];
