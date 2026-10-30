import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { fetchCandles } from '@/api/market.api';
import { loadCalendarConfig, loadLiveCalendar, mergeAdminEvents, useCalendarStore } from '@/api/news.api';
import { useFooterLogoUrl } from '@/components/cms/CmsFooter';
import { AppText, useConfirm } from '@/components/ui';
import { alpha, useTheme } from '@/theme';
import type { Candle, Instrument, OrderSide } from '@/types/trading';
import { subscribeCandles } from '@/websocket/channels';

import {
  activeIndicatorKeys,
  legendRows,
  removeIndicator,
  type ChartPrefs,
  type ChartTimeframe,
  type ChartType,
  type IndicatorMap,
} from './chartCatalog';
import { buildChartHtml } from './chartHtml';
import {
  buildPills,
  buildPriceLines,
  chartCalendarEvents,
  nextCalendarEvent,
  parsePillKey,
  type CalendarFilters,
  type ChartOrderRow,
  type ChartPositionRow,
  type OrderPreviewInput,
  type OverlayInput,
  type PendingPreviewInput,
  type PillKind,
  type TradeMarkerInput,
} from './chartOverlays';
import {
  hydrateChartPrefs,
  readCachedCandles,
  readDrawings,
  useChartPrefsStore,
  writeCachedCandles,
  writeDrawings,
} from './chartPersistence';
import type { ChartDrawing, ToolItem } from './chartTools';
import { ChartContextSheet, TextPromptModal } from './components/ChartSheets';
import { ChartSettingsSheet } from './components/ChartSettingsSheet';
import { ChartToolbar } from './components/ChartToolbar';
import { DrawingMenuSheet } from './components/DrawingMenuSheet';
import { DRAWING_RAIL_WIDTH, DrawingRail } from './components/DrawingRail';
import { IndicatorSettingsSheet, IndicatorsSheet, editTargetForKey, type EditTarget } from './components/IndicatorSheets';
import { ToolIcon } from './components/chartGlyphs';
import { TradingViewDemo } from './components/TradingViewDemo';
import { deliverScript, parseFromChart, type ChartSync, type DrawState, type PillColors, type ScaleCommand, type SubPalette, type ToChart } from './protocol';

/**
 * The price chart — client/src/components/PriceChart.jsx for React Native.
 *
 * The chart itself is lightweight-charts inside a WebView (src/charts/
 * runtime, inlined — no network needed to draw). This component owns
 * everything around it: the header, the drawing rail, every sheet, the data
 * (history from /instruments/:symbol/candles, the forming bar from
 * `candles:SYM:TF`), persistence, and the translation of a pill drag / tap
 * into an action for the screen to perform. It never calls a trading
 * endpoint itself — `onPillAction` does, on the Trade screen, exactly as
 * PriceChart.jsx hands its callbacks up to Trade.jsx.
 *
 * Live work pauses while the screen is out of focus or the app is in the
 * background, and re-reads the history when it comes back so the gap the
 * socket missed is filled.
 */

export type PillAction =
  | { type: 'edit'; target: 'position' | 'order'; id: string }
  | { type: 'close'; target: 'position' | 'order'; id: string; level: PillKind }
  | { type: 'move'; target: 'position' | 'order'; id: string; level: PillKind; price: number; live: boolean };

export interface ChartMarkersConfig {
  signals: boolean;
  hmr: boolean;
  calendar: boolean;
  calendarFilters: CalendarFilters;
}

export interface PriceChartProps {
  symbol: string;
  timeframe: ChartTimeframe;
  onTimeframeChange: (tf: ChartTimeframe) => void;
  instrument: Instrument | null;
  chartType: ChartType;
  onChartTypeChange: (t: ChartType) => void;
  indicators: IndicatorMap;
  onIndicatorsChange: (next: IndicatorMap) => void;
  positions?: readonly ChartPositionRow[];
  orders?: readonly ChartOrderRow[];
  pendingPreview?: PendingPreviewInput | null;
  orderPreview?: OrderPreviewInput | null;
  show?: OverlayInput['show'];
  markers?: ChartMarkersConfig;
  /** Entry / exit markers for the symbol's trades (buildTradeMarkers). */
  tradeMarkers?: readonly TradeMarkerInput[];
  timeZone?: string;
  quote?: { bid: number | null; ask: number | null; last: number | null } | null;
  onPillAction?: (a: PillAction) => void;
  onPickSymbol?: () => void;
  hideHeader?: boolean;
  hideDrawingToolbar?: boolean;
  orderSide?: OrderSide | null;
  onOrderSideChange?: (side: OrderSide) => void;
  hideQuickTrade?: boolean;
  openPositionsCount?: number;
  onCloseAll?: () => void;
  toolbarExtra?: React.ReactNode;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  sync?: ChartSync;
  onCrosshair?: (time: number | null, price: number | null) => void;
  onRange?: (from: number, to: number) => void;
  crosshairIn?: { time: number | null; price: number | null; n: number } | null;
  rangeIn?: { from: number; to: number; n: number } | null;
  /** Extra pause on top of focus / app state (e.g. a hidden multi-chart pane). */
  paused?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const NO_SHOW: OverlayInput['show'] = { positions: false, tpsl: false, stopLimit: false, orderPreview: false };
const NO_TRADES: readonly TradeMarkerInput[] = [];
const NO_MARKERS: ChartMarkersConfig = { signals: false, hmr: false, calendar: false, calendarFilters: { high: true, medium: true, low: false, lowest: false } };

const useAppActive = (): boolean => {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => setActive(st === 'active'));
    return () => sub.remove();
  }, []);
  return active;
};

/** Pills minus their live P&L — a change here is structural and is sent at once. */
const pillSignature = (pills: ReturnType<typeof buildPills>): string =>
  pills.map((p) => `${p.key}@${p.price}:${p.quickTp ? 1 : 0}${p.quickSl ? 1 : 0}`).join('|');

export function PriceChart(props: PriceChartProps): React.JSX.Element {
  const {
    symbol, timeframe, onTimeframeChange, instrument, chartType, onChartTypeChange, indicators, onIndicatorsChange,
    positions = [], orders = [], pendingPreview = null, orderPreview = null, show = NO_SHOW, markers = NO_MARKERS, tradeMarkers = NO_TRADES,
    timeZone = 'local', quote = null, onPillAction, onPickSymbol, hideHeader = false, hideDrawingToolbar = false,
    sync, onCrosshair, onRange, crosshairIn, rangeIn, paused = false, style, testID,
  } = props;
  const t = useTheme();
  const confirm = useConfirm();
  const appActive = useAppActive();
  const live = appActive && !paused;
  const logoUrl = useFooterLogoUrl();

  const prefs = useChartPrefsStore((s) => s.prefs);
  const drawCollapsed = useChartPrefsStore((s) => s.drawCollapsed);
  const setPref = useChartPrefsStore((s) => s.setPref);
  const replacePrefs = useChartPrefsStore((s) => s.replacePrefs);
  const setDrawCollapsed = useChartPrefsStore((s) => s.setDrawCollapsed);
  useEffect(() => { void hydrateChartPrefs(); }, []);

  const precision = Math.max(0, Math.min(8, Number(instrument?.pricePrecision) || 2));
  const name = hideHeader ? symbol : (instrument?.name || symbol);
  const legendInset = hideDrawingToolbar ? 0 : (drawCollapsed ? 18 : 0);
  const sub: SubPalette = useMemo(() => ({ background: t.colors.bgCard, text: t.colors.textSecondary, grid: t.colors.borderSubtle, border: t.colors.borderDark }), [t]);
  const pillColors: PillColors = useMemo(() => ({ tp: prefs.tpColor, sl: prefs.slColor, entry: prefs.entryColor, buy: prefs.buyColor, sell: prefs.sellColor }), [prefs]);
  const chartSync: ChartSync = useMemo(() => sync ?? { crosshair: false, time: false }, [sync]);

  /* ── the bridge ── */
  const webRef = useRef<WebView>(null);
  const readyRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [webKey, setWebKey] = useState(0);
  const [html] = useState(() => buildChartHtml(t.mode === 'dark' ? 'dark' : 'light'));

  const send = useCallback((msg: ToChart): void => {
    if (!readyRef.current) return;
    webRef.current?.injectJavaScript(deliverScript(msg));
  }, []);

  // Everything `init` needs, as of the latest render.
  const latest = useRef({ prefs, chartType, indicators, precision, symbol, name, timeframe, timeZone, hideHeader, legendInset, pillColors, sync: chartSync, logoUrl, mode: t.mode, sub });
  latest.current = { prefs, chartType, indicators, precision, symbol, name, timeframe, timeZone, hideHeader, legendInset, pillColors, sync: chartSync, logoUrl, mode: t.mode, sub };

  /* ── candles: cache → fetch → live ── */
  const candlesRef = useRef<{ key: string; list: Candle[]; fresh: boolean }>({ key: '', list: [], fresh: false });
  const cacheTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const scheduleCacheWrite = useCallback((sym: string, tf: string): void => {
    if (cacheTimer.current) clearTimeout(cacheTimer.current);
    cacheTimer.current = setTimeout(() => {
      cacheTimer.current = null;
      const { key, list } = candlesRef.current;
      if (key === `${sym}:${tf}` && list.length) writeCachedCandles(sym, tf, list);
    }, 4000);
  }, []);

  const loadHistory = useCallback(async (sym: string, tf: string, fit: boolean): Promise<void> => {
    try {
      const list = await fetchCandles(sym, tf, 500);
      if (candlesRef.current.key !== `${sym}:${tf}`) return;
      candlesRef.current = { key: `${sym}:${tf}`, list, fresh: true };
      setLoadFailed(false);
      send({ type: 'candles', symbol: sym, timeframe: tf, name: latest.current.name, candles: list, fit });
      writeCachedCandles(sym, tf, list);
    } catch {
      if (candlesRef.current.key === `${sym}:${tf}` && !candlesRef.current.list.length) setLoadFailed(true);
    }
  }, [send]);

  useEffect(() => {
    if (!symbol) return undefined;
    const key = `${symbol}:${timeframe}`;
    candlesRef.current = { key, list: [], fresh: false };
    setLoadFailed(false);
    let cancelled = false;
    void readCachedCandles(symbol, timeframe).then((cached) => {
      if (cancelled || candlesRef.current.key !== key || candlesRef.current.fresh || !cached?.length) return;
      candlesRef.current = { key, list: cached, fresh: false };
      send({ type: 'candles', symbol, timeframe, name: latest.current.name, candles: cached, fit: true });
    });
    void loadHistory(symbol, timeframe, true);
    return () => {
      cancelled = true;
      // The switch is exactly when the cache needs the final state.
      if (cacheTimer.current) {
        clearTimeout(cacheTimer.current);
        cacheTimer.current = null;
        const { list } = candlesRef.current;
        if (list.length) writeCachedCandles(symbol, timeframe, list);
      }
    };
  }, [symbol, timeframe, loadHistory, send]);

  // Coming back (focus / foreground): re-read the history, keep the view.
  const wasLive = useRef(live);
  useEffect(() => {
    if (live && !wasLive.current && symbol) void loadHistory(symbol, timeframe, false);
    wasLive.current = live;
  }, [live, symbol, timeframe, loadHistory]);

  // The forming bar, coalesced to one bridge message per ~120 ms.
  useEffect(() => {
    if (!symbol || !live) return undefined;
    const sym = symbol.toUpperCase();
    let pending: Candle | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const push = (c: Candle): void => {
      const cur = candlesRef.current;
      if (cur.key !== `${symbol}:${timeframe}`) return;
      const last = cur.list[cur.list.length - 1];
      if (last && c.time === last.time) cur.list = [...cur.list.slice(0, -1), c];
      else if (!last || c.time > last.time) cur.list = [...cur.list, c];
      send({ type: 'candle', symbol, timeframe, candle: c });
      scheduleCacheWrite(symbol, timeframe);
    };
    const flush = (): void => { timer = null; const c = pending; pending = null; if (c) push(c); };
    const off = subscribeCandles(symbol, timeframe, (e) => {
      if (String(e.symbol).toUpperCase() !== sym || e.timeframe !== timeframe) return;
      // A bar that just closed goes out before the next one starts.
      if (pending && pending.time !== e.candle.time) { const prev = pending; pending = null; push(prev); }
      pending = e.candle;
      if (!timer) timer = setTimeout(flush, 120);
    });
    return () => { off(); if (timer) clearTimeout(timer); flush(); };
  }, [symbol, timeframe, live, send, scheduleCacheWrite]);

  /* ── drawings: per symbol ── */
  const drawingsRef = useRef<ChartDrawing[]>([]);
  const drawSymbolRef = useRef(symbol);
  const drawWrite = useRef<{ timer: ReturnType<typeof setTimeout>; symbol: string; list: ChartDrawing[] } | null>(null);
  const flushDrawings = useCallback((): void => {
    const w = drawWrite.current;
    if (!w) return;
    clearTimeout(w.timer);
    drawWrite.current = null;
    writeDrawings(w.symbol, w.list);
  }, []);
  useEffect(() => {
    flushDrawings();
    drawSymbolRef.current = symbol;
    drawingsRef.current = [];
    let cancelled = false;
    void readDrawings(symbol).then((list) => {
      if (cancelled) return;
      drawingsRef.current = list;
      send({ type: 'drawings', drawings: list });
    });
    return () => { cancelled = true; };
  }, [symbol, send, flushDrawings]);
  useEffect(() => () => flushDrawings(), [flushDrawings]);

  /* ── on ready: the whole state, then deltas ── */
  const onReady = useCallback((): void => {
    readyRef.current = true;
    const l = latest.current;
    webRef.current?.injectJavaScript(deliverScript({
      type: 'init', mode: l.mode === 'dark' ? 'dark' : 'light', sub: l.sub, prefs: l.prefs, chartType: l.chartType,
      indicators: l.indicators, legend: legendRows(l.indicators), precision: l.precision, symbol: l.symbol, name: l.name,
      timeframe: l.timeframe, timeZone: l.timeZone, hideHeader: l.hideHeader, legendInset: l.legendInset,
      pillColors: l.pillColors, sync: l.sync, logoUrl: l.logoUrl,
    }));
    const c = candlesRef.current;
    if (c.list.length && c.key === `${l.symbol}:${l.timeframe}`) {
      send({ type: 'candles', symbol: l.symbol, timeframe: l.timeframe, name: l.name, candles: c.list, fit: true });
    }
    send({ type: 'drawings', drawings: drawingsRef.current });
    setReady(true);
  }, [send]);

  useEffect(() => { if (ready) send({ type: 'theme', mode: t.mode === 'dark' ? 'dark' : 'light', sub }); }, [ready, t.mode, sub, send]);
  useEffect(() => { if (ready) send({ type: 'prefs', prefs, pillColors }); }, [ready, prefs, pillColors, send]);
  useEffect(() => { if (ready) send({ type: 'chartType', chartType }); }, [ready, chartType, send]);
  useEffect(() => { if (ready) send({ type: 'indicators', indicators, legend: legendRows(indicators) }); }, [ready, indicators, send]);
  useEffect(() => {
    if (ready) send({ type: 'meta', precision, name, timeZone, hideHeader, legendInset, logoUrl, sync: chartSync });
  }, [ready, precision, name, timeZone, hideHeader, legendInset, logoUrl, chartSync, send]);

  /* ── lines + pills from the book ── */
  const overlayInput: OverlayInput = useMemo(() => ({
    symbol, positions, orders, pendingPreview, orderPreview, show,
    prefs: { tpColor: prefs.tpColor, slColor: prefs.slColor, entryColor: prefs.entryColor, buyColor: prefs.buyColor, sellColor: prefs.sellColor },
  }), [symbol, positions, orders, pendingPreview, orderPreview, show, prefs]);
  const lines = useMemo(() => (chartType === 'histogram' ? [] : buildPriceLines(overlayInput)), [overlayInput, chartType]);
  const pills = useMemo(() => (chartType === 'histogram' ? [] : buildPills(overlayInput)), [overlayInput, chartType]);

  useEffect(() => { if (ready) send({ type: 'lines', lines }); }, [ready, lines, send]);

  const pillsRef = useRef(pills);
  pillsRef.current = pills;
  const pillSig = useRef('');
  const pillTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!ready) return;
    const sig = pillSignature(pills);
    const flush = (): void => { pillTimer.current = null; send({ type: 'pills', pills: pillsRef.current, colors: pillColors }); };
    if (sig !== pillSig.current) {
      pillSig.current = sig;
      if (pillTimer.current) { clearTimeout(pillTimer.current); pillTimer.current = null; }
      flush();
    } else if (!pillTimer.current) {
      pillTimer.current = setTimeout(flush, 250);
    }
  }, [ready, pills, pillColors, send]);
  useEffect(() => () => { if (pillTimer.current) clearTimeout(pillTimer.current); }, []);

  const quoteRef = useRef(quote);
  quoteRef.current = quote;
  const quoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!ready || !quote || quoteTimer.current) return;
    quoteTimer.current = setTimeout(() => {
      quoteTimer.current = null;
      const q = quoteRef.current;
      if (q) send({ type: 'quote', bid: q.bid, ask: q.ask, last: q.last });
    }, 250);
  }, [ready, quote, send]);
  useEffect(() => () => { if (quoteTimer.current) clearTimeout(quoteTimer.current); }, []);

  /* ── signals / HMR / economic calendar ── */
  // Only while the setting is on — the feed is not needed otherwise.
  useEffect(() => {
    if (!markers.calendar) return;
    void loadLiveCalendar();
    if (!useCalendarStore.getState().configLoaded) void loadCalendarConfig();
  }, [markers.calendar]);
  const [calClock, setCalClock] = useState(() => Date.now());
  const calLive = useCalendarStore((st) => st.live);
  const calAdmin = useCalendarStore((st) => st.adminEvents);
  const calEnabled = useCalendarStore((st) => st.enabled);
  const calEvents = useMemo(() => (calEnabled ? mergeAdminEvents(calLive, calAdmin, calClock, 1000) : []), [calEnabled, calLive, calAdmin, calClock]);
  useEffect(() => {
    if (!markers.calendar) return undefined;
    const id = setInterval(() => setCalClock(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [markers.calendar]);
  const ccys = useMemo(() => [instrument?.baseCurrency, instrument?.quoteCurrency], [instrument?.baseCurrency, instrument?.quoteCurrency]);
  const calMarkers = useMemo(
    () => (markers.calendar && instrument ? chartCalendarEvents(calEvents, ccys, markers.calendarFilters, calClock) : []),
    [markers.calendar, instrument, calEvents, ccys, markers.calendarFilters, calClock],
  );
  const nextEvent = useMemo(
    () => (markers.calendar && instrument ? nextCalendarEvent(calEvents, ccys, markers.calendarFilters, calClock) : null),
    [markers.calendar, instrument, calEvents, ccys, markers.calendarFilters, calClock],
  );
  useEffect(() => {
    if (ready) send({ type: 'overlays', signals: markers.signals, hmr: markers.hmr, calendar: calMarkers, nextEvent, trades: [...tradeMarkers] });
  }, [ready, markers.signals, markers.hmr, calMarkers, nextEvent, tradeMarkers, send]);

  /* ── multi-chart sync in ── */
  useEffect(() => { if (ready && crosshairIn) send({ type: 'crosshair', time: crosshairIn.time, price: crosshairIn.price }); }, [ready, crosshairIn, send]);
  useEffect(() => { if (ready && rangeIn) send({ type: 'range', from: rangeIn.from, to: rangeIn.to }); }, [ready, rangeIn, send]);

  /* ── sheets ── */
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [locks, setLocks] = useState({ manualPrice: false, manualTime: false });
  const [drawState, setDrawState] = useState<DrawState | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [textPrompt, setTextPrompt] = useState<{ tool: string; meta: Pick<ToolItem, 'family' | 'pts' | 'variant' | 'glyph'>; anchor: unknown; initial: string } | null>(null);
  const [tvDemo, setTvDemo] = useState(false);

  const drawSend = useCallback((cmd: string, arg?: Record<string, unknown>): void => {
    send({ type: 'draw', cmd: cmd as never, ...(arg ? { arg } : {}) });
  }, [send]);
  const scale = useCallback((cmd: ScaleCommand): void => send({ type: 'scale', cmd }), [send]);

  const menuDrawing = useMemo((): ChartDrawing | null => {
    if (!menuId) return null;
    if (drawState?.selected && drawState.selected.id === menuId) return drawState.selected;
    return drawingsRef.current.find((d) => d.id === menuId) ?? null;
  }, [menuId, drawState]);

  const onMessage = useCallback((e: WebViewMessageEvent): void => {
    const m = parseFromChart(e.nativeEvent.data);
    if (!m) return;
    switch (m.type) {
      case 'ready': onReady(); break;
      case 'pillTap': {
        const ref = parsePillKey(m.key);
        if (ref && !ref.isNew) onPillAction?.({ type: 'edit', target: ref.target, id: ref.id });
        break;
      }
      case 'pillClose': {
        const ref = parsePillKey(m.key);
        if (ref && !ref.isNew) onPillAction?.({ type: 'close', target: ref.target, id: ref.id, level: ref.kind });
        break;
      }
      case 'pillCommit': {
        const ref = parsePillKey(m.key);
        if (ref && Number.isFinite(m.price)) onPillAction?.({ type: 'move', target: ref.target, id: ref.id, level: ref.kind, price: m.price, live: !!m.live });
        break;
      }
      case 'longPress':
        if (m.drawingId) setMenuId(m.drawingId);
        else { setLocks({ manualPrice: !!m.manualPrice, manualTime: !!m.manualTime }); setContextOpen(true); }
        break;
      case 'scaleLocks': setLocks({ manualPrice: m.manualPrice, manualTime: m.manualTime }); break;
      case 'drawings': {
        drawingsRef.current = m.drawings;
        const sym = drawSymbolRef.current;
        if (drawWrite.current) clearTimeout(drawWrite.current.timer);
        drawWrite.current = { symbol: sym, list: m.drawings, timer: setTimeout(flushDrawings, 400) };
        break;
      }
      case 'drawState': {
        const { type: _type, ...rest } = m;
        setDrawState(rest);
        break;
      }
      case 'drawSettings': setMenuId(m.id); break;
      case 'textPrompt': setTextPrompt({ tool: m.tool, meta: m.meta, anchor: m.anchor, initial: m.initial }); break;
      case 'symbolTap': onPickSymbol?.(); break;
      case 'legendTap':
        if (m.action === 'remove') onIndicatorsChange(removeIndicator(latest.current.indicators, m.key));
        else setEditTarget(editTargetForKey(latest.current.indicators, m.key));
        break;
      case 'crosshair': onCrosshair?.(m.time, m.price); break;
      case 'range': onRange?.(m.from, m.to); break;
      case 'error': if (__DEV__) console.warn('[chart]', m.message, m.where ?? ''); break;
      default: break;
    }
  }, [onReady, onPillAction, flushDrawings, onPickSymbol, onIndicatorsChange, onCrosshair, onRange]);

  const restart = useCallback((): void => {
    readyRef.current = false;
    setReady(false);
    setWebKey((k) => k + 1);
  }, []);

  const railVisible = !hideDrawingToolbar && !drawCollapsed;
  const canvasBg = t.mode === 'dark' ? '#0F1623' : '#FFFFFF';

  return (
    <View style={[s.root, { backgroundColor: canvasBg }, style]} testID={testID ?? 'price-chart'}>
      {!hideHeader ? (
        <ChartToolbar
          chartType={chartType}
          onChartType={onChartTypeChange}
          indicatorCount={activeIndicatorKeys(indicators).length}
          onOpenIndicators={() => setIndicatorsOpen(true)}
          timeframe={timeframe}
          onTimeframe={onTimeframeChange}
          instrument={instrument}
          precision={precision}
          orderSide={props.orderSide ?? null}
          onOrderSideChange={props.onOrderSideChange}
          hideQuickTrade={props.hideQuickTrade}
          openPositionsCount={props.openPositionsCount}
          onCloseAll={props.onCloseAll}
          extra={props.toolbarExtra}
          symbol={symbol}
          tvDemo={tvDemo}
          onToggleTvDemo={() => setTvDemo((v) => !v)}
          fullscreen={props.fullscreen}
          onToggleFullscreen={props.onToggleFullscreen}
        />
      ) : null}

      <View style={s.body}>
        {railVisible ? (
          <View style={[s.railCol, { width: DRAWING_RAIL_WIDTH }]}>
            <DrawingRail
              state={drawState}
              collapsed={false}
              onCollapse={setDrawCollapsed}
              send={drawSend}
              onEditSelected={() => { if (drawState?.selectedId) setMenuId(drawState.selectedId); }}
              confirm={confirm}
            />
          </View>
        ) : null}
        <View style={s.chartCol}>
          <WebView
            key={webKey}
            ref={webRef}
            source={{ html }}
            originWhitelist={['*']}
            onShouldStartLoadWithRequest={(req) => req.url.startsWith('about:') || req.url.startsWith('data:')}
            javaScriptEnabled
            scrollEnabled={false}
            bounces={false}
            overScrollMode="never"
            setSupportMultipleWindows={false}
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
            onMessage={onMessage}
            onRenderProcessGone={restart}
            onContentProcessDidTerminate={restart}
            style={[s.web, { backgroundColor: canvasBg }]}
            containerStyle={{ backgroundColor: canvasBg }}
            testID="chart-webview"
          />
          {!hideDrawingToolbar && drawCollapsed ? (
            <DrawingRail state={drawState} collapsed onCollapse={setDrawCollapsed} send={drawSend} onEditSelected={() => undefined} confirm={confirm} />
          ) : null}
          {loadFailed ? (
            <View style={[s.failed, { backgroundColor: alpha(t.colors.surface, 0.94), borderColor: t.colors.borderDark }]} pointerEvents="box-none">
              <AppText variant="small" tone="muted">Chart data could not be loaded.</AppText>
              <Pressable accessibilityRole="button" onPress={() => { void loadHistory(symbol, timeframe, true); }} hitSlop={8}>
                <AppText variant="smallStrong" tone="brand">Retry</AppText>
              </Pressable>
            </View>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Chart settings"
            onPress={() => setSettingsOpen(true)}
            style={s.gear}
            hitSlop={6}
            testID="chart-settings-btn"
          >
            <ToolIcon name="gear" color={t.colors.textMuted} size={14} />
          </Pressable>
          {tvDemo ? <TradingViewDemo symbol={symbol} timeframe={timeframe} instrument={instrument} /> : null}
        </View>
      </View>

      <IndicatorsSheet
        open={indicatorsOpen}
        indicators={indicators}
        onChange={onIndicatorsChange}
        onEdit={(e) => setEditTarget(e)}
        onClose={() => setIndicatorsOpen(false)}
      />
      <IndicatorSettingsSheet edit={editTarget} indicators={indicators} onChange={onIndicatorsChange} onClose={() => setEditTarget(null)} />
      <ChartSettingsSheet open={settingsOpen} prefs={prefs} onChange={setPref} onReplace={replacePrefs} onClose={() => setSettingsOpen(false)} />
      <ChartContextSheet
        open={contextOpen}
        prefs={prefs}
        manualY={locks.manualPrice}
        manualX={locks.manualTime}
        onSetPref={setPref}
        onScale={scale}
        onMoreSettings={() => setSettingsOpen(true)}
        onClose={() => setContextOpen(false)}
      />
      <DrawingMenuSheet drawing={menuDrawing} onClose={() => setMenuId(null)} send={drawSend} />
      <TextPromptModal
        open={!!textPrompt}
        title={textPrompt?.initial ? 'Note text' : 'Text'}
        initial={textPrompt?.initial ?? ''}
        onClose={() => setTextPrompt(null)}
        onSubmit={(text) => {
          if (textPrompt) drawSend('add', { tool: textPrompt.tool, meta: textPrompt.meta, pts: [textPrompt.anchor], extra: { text } });
        }}
      />
    </View>
  );
}

/** For the shared multi-chart toolbar: the sheets a pane without a header still needs. */
export type { ChartPrefs };

const s = StyleSheet.create({
  root: { flex: 1, minHeight: 0, overflow: 'hidden' },
  body: { flex: 1, flexDirection: 'row', minHeight: 0 },
  railCol: { position: 'relative' },
  chartCol: { flex: 1, minWidth: 0, position: 'relative' },
  web: { flex: 1 },
  gear: { position: 'absolute', right: 4, bottom: 4, width: 24, height: 24, alignItems: 'center', justifyContent: 'center', zIndex: 20 },
  failed: { position: 'absolute', left: 16, right: 16, top: '40%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1 },
});
