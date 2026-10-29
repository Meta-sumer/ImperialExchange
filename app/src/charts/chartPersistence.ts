import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

import type { Candle } from '@/types/trading';

import { DEFAULT_CHART_PREFS, mergeChartPrefs, type ChartPrefs } from './chartCatalog';
import type { ChartDrawing } from './chartTools';

/**
 * What the chart remembers between sessions — the web's localStorage keys,
 * on AsyncStorage:
 *
 *   tradepro:chart-prefs:v1            chart settings (PriceChart.jsx:851)
 *   chartDrawingToolbar.collapsed      the drawing rail (ChartDrawingToolbar.jsx)
 *   tradepro:drawings:v4:<SYMBOL>      drawings per symbol (useChartDrawings.js:39)
 *   tradepro:candles:v1:<SYM>:<TF>     the last 300 candles (PriceChart.jsx:169)
 *
 * The candle cache is per key here (the web keeps one blob of 40 keys and
 * re-parses it on every write); an index key keeps the same 40-entry cap.
 * Nothing here is sensitive.
 */

export const CHART_PREFS_KEY = 'tradepro:chart-prefs:v1';
export const DRAW_COLLAPSED_KEY = 'chartDrawingToolbar.collapsed';
export const drawingsKey = (symbol: string): string => `tradepro:drawings:v4:${symbol || 'GLOBAL'}`;
export const candleCacheKey = (symbol: string, timeframe: string): string => `tradepro:candles:v1:${symbol}:${timeframe}`;
const CANDLE_INDEX_KEY = 'tradepro:candles:v1:index';
export const CANDLE_CACHE_MAX_KEYS = 40;
export const CANDLE_CACHE_BARS = 300;

/* ── chart settings + rail state ─────────────────────────────────────── */

interface ChartPrefsState {
  prefs: ChartPrefs;
  drawCollapsed: boolean;
  hydrated: boolean;
  setPref: (patch: Partial<ChartPrefs>) => void;
  replacePrefs: (next: ChartPrefs) => void;
  setDrawCollapsed: (v: boolean) => void;
}

const writeJson = (key: string, value: unknown): void => {
  AsyncStorage.setItem(key, JSON.stringify(value)).catch(() => { /* best-effort */ });
};

export const useChartPrefsStore = create<ChartPrefsState>((set, get) => ({
  prefs: { ...DEFAULT_CHART_PREFS },
  drawCollapsed: false,
  hydrated: false,
  setPref: (patch) => {
    const next = { ...get().prefs, ...patch };
    set({ prefs: next });
    writeJson(CHART_PREFS_KEY, next);
  },
  replacePrefs: (next) => {
    set({ prefs: { ...next } });
    writeJson(CHART_PREFS_KEY, next);
  },
  setDrawCollapsed: (v) => {
    set({ drawCollapsed: v });
    AsyncStorage.setItem(DRAW_COLLAPSED_KEY, v ? '1' : '0').catch(() => { /* best-effort */ });
  },
}));

let prefsHydration: Promise<void> | null = null;

/** Load the saved settings once; safe to call from every chart mount. */
export const hydrateChartPrefs = (): Promise<void> => {
  if (prefsHydration) return prefsHydration;
  prefsHydration = (async () => {
    try {
      const [raw, collapsed] = await Promise.all([
        AsyncStorage.getItem(CHART_PREFS_KEY),
        AsyncStorage.getItem(DRAW_COLLAPSED_KEY),
      ]);
      let parsed: unknown = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      useChartPrefsStore.setState({ prefs: mergeChartPrefs(parsed), drawCollapsed: collapsed === '1', hydrated: true });
    } catch {
      useChartPrefsStore.setState({ hydrated: true });
    }
  })();
  return prefsHydration;
};

/* ── drawings ────────────────────────────────────────────────────────── */

export const isDrawing = (v: unknown): v is ChartDrawing => {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return typeof d.id === 'string' && typeof d.kind === 'string' && Array.isArray(d.pts);
};

export const readDrawings = async (symbol: string): Promise<ChartDrawing[]> => {
  try {
    const raw = await AsyncStorage.getItem(drawingsKey(symbol));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isDrawing) : [];
  } catch {
    return [];
  }
};

export const writeDrawings = (symbol: string, drawings: readonly ChartDrawing[]): void => {
  writeJson(drawingsKey(symbol), drawings);
};

/* ── candle cache ────────────────────────────────────────────────────── */

const memCandles = new Map<string, Candle[]>();

const isCandle = (v: unknown): v is Candle => {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return ['time', 'open', 'high', 'low', 'close'].every((k) => typeof c[k] === 'number' && Number.isFinite(c[k]));
};

export const readCachedCandles = async (symbol: string, timeframe: string): Promise<Candle[] | null> => {
  const key = candleCacheKey(symbol, timeframe);
  const mem = memCandles.get(key);
  if (mem) return mem;
  try {
    const raw = await AsyncStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return null;
    const list = parsed.filter(isCandle);
    if (!list.length) return null;
    memCandles.set(key, list);
    return list;
  } catch {
    return null;
  }
};

/** The next index after writing `key`: most-recent last, capped (FIFO eviction). */
export const nextCandleIndex = (index: readonly string[], key: string, max = CANDLE_CACHE_MAX_KEYS): { index: string[]; evict: string[] } => {
  const without = index.filter((k) => k !== key);
  const next = [...without, key];
  const evict = next.length > max ? next.slice(0, next.length - max) : [];
  return { index: next.slice(next.length - Math.min(next.length, max)), evict };
};

let indexChain: Promise<void> = Promise.resolve();

export const writeCachedCandles = (symbol: string, timeframe: string, candles: readonly Candle[]): void => {
  if (!candles.length) return;
  const key = candleCacheKey(symbol, timeframe);
  const trimmed = candles.slice(-CANDLE_CACHE_BARS);
  memCandles.set(key, trimmed);
  // Serialised so two quick writes cannot interleave their index updates.
  indexChain = indexChain.then(async () => {
    try {
      let index: string[] = [];
      try {
        const raw = await AsyncStorage.getItem(CANDLE_INDEX_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) index = parsed.filter((k): k is string => typeof k === 'string');
      } catch { index = []; }
      const { index: next, evict } = nextCandleIndex(index, key);
      await AsyncStorage.setItem(key, JSON.stringify(trimmed));
      await AsyncStorage.setItem(CANDLE_INDEX_KEY, JSON.stringify(next));
      if (evict.length) await AsyncStorage.multiRemove(evict);
    } catch { /* the cache is best-effort */ }
  });
};

/** For tests and sign-out. */
export const clearCandleMemory = (): void => { memCandles.clear(); };
