import type { Candle } from '@/types/trading';

import type { ChartPrefs, ChartType, IndicatorMap, LegendRow } from './chartCatalog';
import type { CalendarMarkerInput, NextEventChip, PillSpec, PriceLineSpec, TradeMarkerInput } from './chartOverlays';
import type { ChartDrawing, ToolItem } from './chartTools';

/**
 * The bridge between PriceChart (React Native) and the runtime in the
 * WebView (src/charts/runtime/chart.js). The app sends with
 * `window.__aatReceive(json)`; the runtime answers through
 * `ReactNativeWebView.postMessage`. Both directions are plain JSON.
 */

export interface SubPalette { background: string; text: string; grid: string; border: string }
export interface PillColors { tp: string; sl: string; entry: string; buy: string; sell: string }
export interface ChartSync { crosshair: boolean; time: boolean }

export type ToChart =
  | {
    type: 'init';
    mode: 'light' | 'dark';
    sub: SubPalette;
    prefs: ChartPrefs;
    chartType: ChartType;
    indicators: IndicatorMap;
    legend: LegendRow[];
    precision: number;
    symbol: string;
    name: string;
    timeframe: string;
    timeZone: string;
    hideHeader: boolean;
    legendInset: number;
    pillColors: PillColors;
    sync: ChartSync;
    logoUrl: string;
  }
  | { type: 'theme'; mode: 'light' | 'dark'; sub: SubPalette }
  | { type: 'prefs'; prefs: ChartPrefs; pillColors: PillColors }
  | { type: 'chartType'; chartType: ChartType }
  | { type: 'indicators'; indicators: IndicatorMap; legend: LegendRow[] }
  | { type: 'meta'; precision?: number; name?: string; timeZone?: string; hideHeader?: boolean; legendInset?: number; logoUrl?: string; sync?: ChartSync }
  | { type: 'candles'; symbol: string; timeframe: string; name?: string; candles: Candle[]; fit: boolean }
  | { type: 'candle'; symbol: string; timeframe: string; candle: Candle }
  | { type: 'lines'; lines: PriceLineSpec[] }
  | { type: 'pills'; pills: PillSpec[]; colors: PillColors }
  | { type: 'quote'; bid: number | null; ask: number | null; last: number | null }
  | { type: 'overlays'; signals: boolean; hmr: boolean; calendar: CalendarMarkerInput[]; nextEvent: NextEventChip | null; trades?: TradeMarkerInput[] }
  | { type: 'drawings'; drawings: ChartDrawing[] }
  | { type: 'draw'; cmd: DrawCommand; arg?: Record<string, unknown> }
  | { type: 'scale'; cmd: ScaleCommand }
  | { type: 'crosshair'; time: number | null; price: number | null }
  | { type: 'range'; from: number; to: number };

export type DrawCommand =
  | 'setTool' | 'setEmoji' | 'undo' | 'redo' | 'clearAll' | 'setLocked' | 'setHidden'
  | 'remove' | 'update' | 'toggleLock' | 'duplicate' | 'reorder' | 'select' | 'finalize'
  | 'cancelPending' | 'add' | 'zoomIn' | 'zoomOut' | 'resetZoom';

export type ScaleCommand = 'refresh' | 'autoFit' | 'resetY' | 'resetX' | 'resetAll';

export interface DrawState {
  tool: string;
  canUndo: boolean;
  canRedo: boolean;
  locked: boolean;
  hidden: boolean;
  count: number;
  pending: number;
  selectedId: string | null;
  selected: ChartDrawing | null;
  emoji: string;
}

export type FromChart =
  | { type: 'ready'; version: number }
  | { type: 'error'; message: string; where?: string }
  | { type: 'pillTap'; key: string }
  | { type: 'pillClose'; key: string }
  | { type: 'pillCommit'; key: string; price: number; live?: boolean }
  | { type: 'longPress'; drawingId: string | null; manualPrice?: boolean; manualTime?: boolean }
  | { type: 'scaleLocks'; manualPrice: boolean; manualTime: boolean }
  | { type: 'drawings'; drawings: ChartDrawing[] }
  | ({ type: 'drawState' } & DrawState)
  | { type: 'drawSettings'; id: string }
  | { type: 'textPrompt'; tool: string; meta: Pick<ToolItem, 'family' | 'pts' | 'variant' | 'glyph'>; anchor: { logical: number | null; time: number | null; price: number }; initial: string }
  | { type: 'symbolTap' }
  | { type: 'legendTap'; key: string; action: 'edit' | 'remove' }
  | { type: 'crosshair'; time: number | null; price: number | null }
  | { type: 'range'; from: number; to: number };

const FROM_TYPES: ReadonlySet<string> = new Set([
  'ready', 'error', 'pillTap', 'pillClose', 'pillCommit', 'longPress', 'scaleLocks', 'drawings',
  'drawState', 'drawSettings', 'textPrompt', 'symbolTap', 'legendTap', 'crosshair', 'range',
]);

/** Parse a WebView message; null for anything that is not ours. */
export const parseFromChart = (raw: string): FromChart | null => {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  const type = (v as { type?: unknown }).type;
  return typeof type === 'string' && FROM_TYPES.has(type) ? (v as FromChart) : null;
};

/**
 * The script that delivers one message. The JSON is passed as a string
 * literal (stringified twice) and parsed inside, so no value can break out
 * of the call; the trailing `true` is what injectJavaScript wants.
 */
export const deliverScript = (msg: ToChart): string =>
  `window.__aatReceive && window.__aatReceive(${JSON.stringify(JSON.stringify(msg))});true;`;
