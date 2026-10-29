import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

import { isChartTimeframe, isChartType, type ChartTimeframe, type ChartType, type IndicatorMap } from '@/charts/chartCatalog';
import { DEFAULT_SYNC, getLayout, type SyncState } from '@/charts/chartLayouts';

import type { ChartViewMaps } from './tradeLogic';

/**
 * What the Trade terminal remembers — Trade.jsx's localStorage keys, on
 * AsyncStorage, same names so a reader can grep one and find the other:
 *
 *   tradepro:trade-tabs              the open symbol tabs
 *   tradepro:chart-layout / -sync / -panes   the multi-chart layout
 *   tradepro:chart-{ind,type,tf}-by-symbol:v1  each instrument's own view
 *   tradepro:chart-timeframe / chart-type / chart-indicators:v1  the old
 *                                    globals (first-run migration only)
 *   tradepro:bottom-panel            the book's height / collapsed
 *   tradepro:hide-balance            the account pill's mask
 *   tradepro:tradeFilter             the instruments panel's filter
 *
 * Loaded once per session (`hydrateTradeView`), written on every change.
 * Nothing here is sensitive.
 */

export const KEYS = {
  tabs: 'tradepro:trade-tabs',
  layout: 'tradepro:chart-layout',
  sync: 'tradepro:chart-sync',
  panes: 'tradepro:chart-panes',
  indBySymbol: 'tradepro:chart-ind-by-symbol:v1',
  ctBySymbol: 'tradepro:chart-type-by-symbol:v1',
  tfBySymbol: 'tradepro:chart-tf-by-symbol:v1',
  legacyTf: 'tradepro:chart-timeframe',
  legacyCt: 'tradepro:chart-type',
  legacyInd: 'tradepro:chart-indicators:v1',
  bottom: 'tradepro:bottom-panel',
  hideBalance: 'tradepro:hide-balance',
  filter: 'tradepro:tradeFilter',
} as const;

export interface PaneState {
  symbol: string;
  timeframe: ChartTimeframe;
  chartType?: ChartType;
  indicators?: IndicatorMap;
}

export interface BottomState { height: number; collapsed: boolean }

export const BOTTOM_MIN = 60;
export const BOTTOM_MAX = 640;
export const BOTTOM_DEFAULT = 240;

export const clampBottom = (raw: unknown): BottomState => {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const h = Number(r.height);
  return { height: Math.max(80, Math.min(BOTTOM_MAX, Number.isFinite(h) && h > 0 ? h : BOTTOM_DEFAULT)), collapsed: Boolean(r.collapsed) };
};

interface TradeViewState {
  hydrated: boolean;
  savedTabs: unknown;
  layoutId: string;
  sync: SyncState;
  panes: PaneState[];
  maps: ChartViewMaps;
  legacy: { indicators: IndicatorMap; chartType: string | null; timeframe: string | null };
  bottom: BottomState;
  hideBalance: boolean;
  filter: string;
}

const EMPTY: TradeViewState = {
  hydrated: false,
  savedTabs: null,
  layoutId: '1',
  sync: { ...DEFAULT_SYNC },
  panes: [],
  maps: { ind: {}, ct: {}, tf: {} },
  legacy: { indicators: {}, chartType: null, timeframe: null },
  bottom: { height: BOTTOM_DEFAULT, collapsed: false },
  hideBalance: false,
  filter: 'ALL',
};

export const useTradeViewStore = create<TradeViewState>(() => ({ ...EMPTY }));

const write = (key: string, value: unknown): void => {
  AsyncStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)).catch(() => { /* best-effort */ });
};

const parse = (raw: string | null): unknown => {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

const asMap = <V>(v: unknown): Record<string, V> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, V>) : {});

/** Eight panes, each defaulting to the page symbol (Trade.jsx:87-92). */
export const restorePanes = (saved: unknown, symbol: string, timeframe: ChartTimeframe): PaneState[] => {
  const list = Array.isArray(saved) ? saved : [];
  return Array.from({ length: 8 }, (_, i) => {
    const p = list[i] as Record<string, unknown> | undefined;
    if (p && typeof p.symbol === 'string' && p.symbol) {
      return {
        symbol: p.symbol,
        timeframe: isChartTimeframe(p.timeframe) ? p.timeframe : timeframe,
        ...(isChartType(p.chartType) ? { chartType: p.chartType } : {}),
        ...(p.indicators && typeof p.indicators === 'object' ? { indicators: p.indicators as IndicatorMap } : {}),
      };
    }
    return { symbol, timeframe };
  });
};

let hydration: Promise<void> | null = null;

export const hydrateTradeView = (): Promise<void> => {
  if (hydration) return hydration;
  hydration = (async () => {
    const keys = Object.values(KEYS);
    let pairs: readonly (readonly [string, string | null])[] = [];
    try { pairs = await AsyncStorage.multiGet(keys); } catch { pairs = []; }
    const get = (k: string): string | null => pairs.find(([key]) => key === k)?.[1] ?? null;
    const layout = get(KEYS.layout);
    const syncRaw = asMap<boolean>(parse(get(KEYS.sync)));
    useTradeViewStore.setState({
      hydrated: true,
      savedTabs: parse(get(KEYS.tabs)),
      layoutId: getLayout(layout).id,
      sync: { ...DEFAULT_SYNC, ...Object.fromEntries(Object.entries(syncRaw).filter(([k, v]) => k in DEFAULT_SYNC && typeof v === 'boolean')) } as SyncState,
      panes: Array.isArray(parse(get(KEYS.panes))) ? (parse(get(KEYS.panes)) as PaneState[]) : [],
      maps: {
        ind: asMap<IndicatorMap>(parse(get(KEYS.indBySymbol))),
        ct: asMap<string>(parse(get(KEYS.ctBySymbol))),
        tf: asMap<string>(parse(get(KEYS.tfBySymbol))),
      },
      legacy: {
        indicators: asMap<boolean>(parse(get(KEYS.legacyInd))) as IndicatorMap,
        chartType: get(KEYS.legacyCt),
        timeframe: get(KEYS.legacyTf),
      },
      bottom: clampBottom(parse(get(KEYS.bottom))),
      hideBalance: get(KEYS.hideBalance) === '1',
      filter: get(KEYS.filter) || 'ALL',
    });
  })();
  return hydration;
};

/** Tests only. */
export const __resetTradeViewForTests = (): void => {
  hydration = null;
  useTradeViewStore.setState({ ...EMPTY });
};

export const tradeView = {
  setTabs: (tabs: readonly string[]): void => { write(KEYS.tabs, tabs); },
  setLayout: (id: string): void => { useTradeViewStore.setState({ layoutId: id }); write(KEYS.layout, id); },
  setSync: (sync: SyncState): void => { useTradeViewStore.setState({ sync }); write(KEYS.sync, sync); },
  setPanes: (panes: PaneState[]): void => { useTradeViewStore.setState({ panes }); write(KEYS.panes, panes); },
  /** Remember `symbol`'s view (per-instrument maps + the globals the web also writes). */
  rememberView: (symbol: string, view: { chartType: ChartType; indicators: IndicatorMap; timeframe: ChartTimeframe }): void => {
    const { maps } = useTradeViewStore.getState();
    const next: ChartViewMaps = {
      ind: { ...maps.ind, [symbol]: view.indicators },
      ct: { ...maps.ct, [symbol]: view.chartType },
      tf: { ...maps.tf, [symbol]: view.timeframe },
    };
    useTradeViewStore.setState({ maps: next });
    write(KEYS.indBySymbol, next.ind);
    write(KEYS.ctBySymbol, next.ct);
    write(KEYS.tfBySymbol, next.tf);
    write(KEYS.legacyCt, view.chartType);
    write(KEYS.legacyTf, view.timeframe);
  },
  setBottom: (bottom: BottomState): void => { useTradeViewStore.setState({ bottom }); write(KEYS.bottom, bottom); },
  setHideBalance: (v: boolean): void => { useTradeViewStore.setState({ hideBalance: v }); write(KEYS.hideBalance, v ? '1' : '0'); },
  setFilter: (f: string): void => { useTradeViewStore.setState({ filter: f }); write(KEYS.filter, f); },
};
