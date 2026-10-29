import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, BackHandler, PanResponder, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { errorMessage } from '@/api/client';
import { fetchInstrument, fetchMarketWatch, recordRecentlyViewed, useInstruments } from '@/api/instruments.api';
import { useOrderBook, withLiveQuote } from '@/api/market.api';
import {
  cancelOrder as apiCancelOrder,
  closeAllPositions,
  closePosition as apiClosePosition,
  fetchOrderHistory,
  isBenignOrderModifyError,
  modifyOrder,
  modifyPosition,
  partialClosePosition,
  placeOrder,
  useTradeBook,
} from '@/api/trading.api';
import { walletApi } from '@/api/wallet.api';
import { INDICATOR_LIST, activeIndicatorKeys, type ChartTimeframe, type ChartType, type IndicatorMap } from '@/charts/chartCatalog';
import { cellFrame, getLayout, type SyncKey } from '@/charts/chartLayouts';
import { PREVIEW_ID, type OrderPreviewInput, type PendingPreviewInput } from '@/charts/chartOverlays';
import { PriceChart, type PillAction } from '@/charts/PriceChart';
import { ChartToolbar } from '@/charts/components/ChartToolbar';
import { IndicatorsSheet } from '@/charts/components/IndicatorSheets';
import { LayoutPickerButton } from '@/charts/components/LayoutPicker';
import { SearchModal } from '@/components/chrome/SearchModal';
import { useWatchlistModal } from '@/components/market/WatchlistModal';
import { OrderForm, type ExternalLevels, type OrderPreview, type PendingPricePreview } from '@/components/trade/OrderForm';
import { PositionSlTpModal } from '@/components/trade/PositionSlTpModal';
import { useAccountWallets, useCoalescedTicker, useLeverageState } from '@/components/trade/orderForm/hooks';
import { AppText, BottomSheet, LoadingView, orderToast, toast, useConfirm } from '@/components/ui';
import type { AppScreenProps } from '@/navigation/types';
import { selectSelectedAccount, useSelectedAccountStore } from '@/store/selectedAccount';
import { useTradeSettings } from '@/store/tradeSettings';
import { alpha, useAppearance, useTheme } from '@/theme';
import type { Order, OrderSide } from '@/types/trading';
import { isDemoLike } from '@/utils/accountType';
import { useWatchlists } from '@/api/watchlist.api';

import { TradeBook, type BookTab } from './components/TradeBook';
import { AccountMenuSheet, EquityBar, PendingOrderModifyModal, type OrderModifyFields } from './components/TradeDialogs';
import { TradePanelsSheet, type PanelTab } from './components/TradePanelsSheet';
import { TradeTopBar, type ShowToggles } from './components/TradeTopBar';
import { PendingPanel, PositionsPanel } from './components/panels/BookPanels';
import { AboutPanel, DepthPanel, DetailsPanel, InstrumentsPanel, MoversPanel, PerformancePanel } from './components/panels/MarketPanels';
import { TradeSettingsPanel } from './components/panels/ToolPanels';
import {
  DEFAULT_SYMBOL,
  VISIBLE_SUBSCRIBE_CAP,
  accountFreeBalances,
  chartOrderRows,
  chartPositionRows,
  closeAllMessage,
  closeTab as closeTabIn,
  equityFigures,
  instrumentCategories,
  instrumentRows,
  livePositionRow,
  pickWalletFree,
  rankMovers,
  reconcileFilter,
  restoreTabs,
  viewForSymbol,
  visibleRows,
  withTab,
  type InstrumentRow,
  type LivePositionRow,
  type MoverOverlay,
} from './tradeLogic';
import { BOTTOM_DEFAULT, BOTTOM_MIN, hydrateTradeView, restorePanes, tradeView, useTradeViewStore, type PaneState } from './tradeViewStore';
import { useLiveBoard } from './useLiveBoard';

/**
 * The Trade terminal — EquityHub's client/src/pages/Trade.jsx.
 *
 * Layout on a phone, top to bottom: the terminal's own top bar (symbol
 * tabs, account chip, deposit — the app header is hidden here, as on the
 * web); the chart, one pane or a multi-chart grid under a shared toolbar;
 * the Open / Pending / Closed / Rejected book on a drag-to-resize split; the
 * equity strip. "Place Order" opens the order ticket as a sheet (the web's
 * phone layout); the web's desktop side panels open as a sheet from
 * "Panels". Fullscreen hides everything but the chart.
 *
 * Every action a pill, a row or a panel takes reaches the same endpoint the
 * web's does, with the same guards: close-all and cancel-all confirm first,
 * and a pending-order edit that lost a race with a fill refreshes quietly.
 * The account figures are Trade.jsx's own (tradeLogic equityFigures), from
 * the wallet's free balance re-read on every refresh.
 *
 * Deliberate differences, where each is written up: the numbers
 * (tradeLogic.ts — no synthetic depth, unknown before the wallet answers);
 * the chart (chartOverlays.ts buildPills — an SL / TP pill keeps the real
 * entry; runtime/chart.js applyPrefs — colours reach hollow candles and
 * Heikin Ashi; runtime/drawings.js — touch in place of mouse and keyboard);
 * the phone layout (TradeTopBar, TradePanelsSheet). Two live on this screen:
 *   • A search pick opens a tab here (SearchModal onPick). Trade.jsx means a
 *     pick to re-point the chart, but its SearchModal leaves for
 *     /stock/:symbol.
 *   • A link's symbol is upper-cased: `/trade?symbol=reliance` opens RELIANCE
 *     (the web looks up "reliance" and finds nothing).
 */

const useAppActive = (): boolean => {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => setActive(st === 'active'));
    return () => sub.remove();
  }, []);
  return active;
};

export function TradeScreen(props: AppScreenProps<'Trade'>): React.JSX.Element {
  const hydrated = useTradeViewStore((s) => s.hydrated);
  useEffect(() => { void hydrateTradeView(); }, []);
  if (!hydrated) return <LoadingView label="Loading terminal…" />;
  return <TradeTerminal {...props} />;
}

function TradeTerminal({ navigation, route }: AppScreenProps<'Trade'>): React.JSX.Element {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const confirm = useConfirm();
  const { mode: themeMode, toggle: toggleTheme } = useAppearance();
  const focused = useIsFocused();
  const appActive = useAppActive();
  const live = focused && appActive;

  const symbol = String(route.params?.symbol || DEFAULT_SYMBOL).toUpperCase();
  const setSymbol = useCallback((sym: string) => { navigation.setParams({ symbol: sym.toUpperCase() }); }, [navigation]);

  /* ── fullscreen (?view=terminal lands in it, then the flag is dropped) ── */
  const [fullscreen, setFullscreen] = useState(route.params?.view === 'terminal');
  useEffect(() => {
    if (route.params?.view === 'terminal') navigation.setParams({ view: undefined });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!fullscreen) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { setFullscreen(false); return true; });
    return () => sub.remove();
  }, [fullscreen]);

  /* ── symbol tabs ── */
  const [tabs, setTabs] = useState<string[]>(() => restoreTabs(useTradeViewStore.getState().savedTabs, symbol));
  useEffect(() => { tradeView.setTabs(tabs); }, [tabs]);
  useEffect(() => { setTabs((prev) => withTab(prev, symbol)); }, [symbol]);
  const openTab = useCallback((sym: string) => {
    const s = sym.toUpperCase();
    setTabs((prev) => withTab(prev, s));
    setSymbol(s);
  }, [setSymbol]);
  const onCloseTab = (sym: string): void => {
    const r = closeTabIn(tabs, sym, symbol);
    setTabs(r.tabs);
    if (r.nextActive) setSymbol(r.nextActive);
  };
  useEffect(() => { recordRecentlyViewed(symbol); }, [symbol]);

  /* ── instruments ── */
  const { rows: instruments } = useInstruments();
  const [fetched, setFetched] = useState<typeof instruments[number] | null>(null);
  useEffect(() => {
    if (instruments.some((i) => i.symbol === symbol)) { setFetched(null); return undefined; }
    let cancelled = false;
    fetchInstrument(symbol).then((r) => { if (!cancelled) setFetched(r); }).catch(() => { if (!cancelled) setFetched(null); });
    return () => { cancelled = true; };
  }, [symbol, instruments]);
  const instrumentBase = useMemo(
    () => instruments.find((i) => i.symbol === symbol) ?? (fetched && fetched.symbol === symbol ? fetched : null),
    [instruments, symbol, fetched],
  );
  const tick = useCoalescedTicker(symbol, live);
  const instrument = useMemo(() => (instrumentBase ? withLiveQuote(instrumentBase, tick) : null), [instrumentBase, tick]);
  const livePrice = tick?.lastPrice != null ? Number(tick.lastPrice) : (instrument?.lastPrice != null ? Number(instrument.lastPrice) : null);
  const instrumentsBySymbol = useMemo(() => Object.fromEntries(instruments.map((i) => [i.symbol, i])), [instruments]);

  /* ── account, book, money ── */
  const accounts = useSelectedAccountStore((s) => s.accounts);
  const account = useSelectedAccountStore(selectSelectedAccount);
  const selectAccount = useSelectedAccountStore((s) => s.select);
  useEffect(() => {
    const st = useSelectedAccountStore.getState();
    if (!st.accounts.length && !st.loading) void st.load();
  }, []);
  const demo = account ? isDemoLike(account.accountType) : false;
  const book = useTradeBook(account?.id ?? null);
  const refresh = book.refresh;

  const showOnChart = useTradeSettings((s) => s.showOnChart);
  const calendarFilters = useTradeSettings((s) => s.calendarFilters);
  const trading = useTradeSettings((s) => s.trading);
  const autoOneClick = useTradeSettings((s) => s.autoTrading.oneClick);
  const setSetting = useTradeSettings((s) => s.set);
  const oneClickMode = trading.openOrderMode === 'oneClick' || autoOneClick;

  // The wallet's free balance — re-read on every user:wallet event (a fill,
  // a close, a deposit), as Trade.jsx re-reads it after every refresh.
  const walletRows = useAccountWallets(account?.id, live);
  const walletFree = useMemo(() => pickWalletFree(walletRows, account?.baseCurrency), [walletRows, account?.baseCurrency]);
  const leverageState = useLeverageState(live);
  const planLeverage = leverageState?.effectiveLeverage ?? null;
  const hideBalance = useTradeViewStore((s) => s.hideBalance);

  /* ── side panels ── */
  const [panelsOpen, setPanelsOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>('positions');
  const filter = useTradeViewStore((s) => s.filter);
  const [watchSearch, setWatchSearch] = useState('');
  const [moverCat, setMoverCat] = useState('ALL');
  const { watchlists, favoritesList, setActiveId } = useWatchlists();
  const { open: openWatchlistModal } = useWatchlistModal();

  /* ── live prices for the book and the open panel ── */
  const bookSymbols = useMemo(
    () => [...book.positions.map((p) => p.symbol), ...book.openOrders.map((o) => o.symbol)],
    [book.positions, book.openOrders],
  );
  const [boardPrices, setBoardPrices] = useState<Record<string, number>>({});
  const rowsNow = useMemo(() => instrumentRows(instruments, boardPrices), [instruments, boardPrices]);
  const categories = useMemo(() => instrumentCategories(rowsNow), [rowsNow]);
  useEffect(() => {
    const next = reconcileFilter(filter, categories, watchlists, favoritesList?.id ?? null);
    if (next !== filter) tradeView.setFilter(next);
  }, [filter, categories, watchlists, favoritesList?.id]);
  const visible = useMemo(() => visibleRows(rowsNow, filter, watchlists, watchSearch), [rowsNow, filter, watchlists, watchSearch]);
  const [movers, setMovers] = useState<Record<string, MoverOverlay>>({});
  const moverShown = useMemo(() => {
    if (!(panelsOpen && panelTab === 'hotlist')) return [];
    const r = rankMovers(rowsNow, movers, moverCat);
    return [...r.gainers, ...r.losers].map((m) => m.symbol);
  }, [panelsOpen, panelTab, rowsNow, movers, moverCat]);
  const panelSymbols = useMemo(() => {
    if (panelsOpen && panelTab === 'watchlist') return visible.slice(0, VISIBLE_SUBSCRIBE_CAP).map((r) => r.symbol);
    return moverShown;
  }, [panelsOpen, panelTab, visible, moverShown]);
  const board = useLiveBoard(useMemo(() => [...bookSymbols, ...panelSymbols], [bookSymbols, panelSymbols]), live);
  useEffect(() => { setBoardPrices(board.prices); }, [board.prices]);
  useEffect(() => { if (Object.keys(board.overlay).length) setMovers((prev) => ({ ...prev, ...board.overlay })); }, [board.overlay]);
  // Movers: the market watch's 24h figures on open, and every 20 s while open.
  // (The web subscribes to EVERY instrument's ticker instead; on a phone the
  // rows on screen tick live and the rest refresh from the snapshot.)
  useEffect(() => {
    if (!(panelsOpen && panelTab === 'hotlist' && live)) return undefined;
    let cancelled = false;
    const load = (): void => {
      fetchMarketWatch().then((list) => {
        if (cancelled) return;
        const next: Record<string, MoverOverlay> = {};
        for (const r of list) {
          const ch = Number(r.change24h);
          if (Number.isFinite(ch)) next[r.symbol] = { change24h: ch, dayHigh: Number(r.dayHigh), dayLow: Number(r.dayLow), volume24h: Number(r.volume24h), lastPrice: Number(r.lastPrice) };
        }
        setMovers((prev) => ({ ...prev, ...next }));
      }).catch(() => { /* keep what we had */ });
    };
    load();
    const id = setInterval(load, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [panelsOpen, panelTab, live]);

  const priceMap = useMemo(() => {
    const m: Record<string, number | undefined> = { ...boardPrices };
    if (livePrice !== null && Number.isFinite(livePrice)) m[symbol] = livePrice;
    return m;
  }, [boardPrices, livePrice, symbol]);

  const positionsLive: LivePositionRow[] = useMemo(() => {
    const active = instrument ? { symbol, bid: instrument.bid != null ? Number(instrument.bid) : null, ask: instrument.ask != null ? Number(instrument.ask) : null } : null;
    return book.positions.map((p) => livePositionRow(p, priceMap, active, trading.priceSource));
  }, [book.positions, priceMap, instrument, symbol, trading.priceSource]);
  const figures = useMemo(() => equityFigures(walletFree, positionsLive), [walletFree, positionsLive]);
  const chartPositions = useMemo(() => chartPositionRows(positionsLive), [positionsLive]);
  const chartOrders = useMemo(() => chartOrderRows(book.openOrders), [book.openOrders]);

  /* ── the active symbol's chart view, remembered per instrument ── */
  const maps = useTradeViewStore((s) => s.maps);
  const legacy = useTradeViewStore((s) => s.legacy);
  const [view, setView] = useState(() => ({ symbol, ...viewForSymbol(maps, symbol, legacy) }));
  useEffect(() => {
    if (view.symbol === symbol) return;
    tradeView.rememberView(view.symbol, view);
    const st = useTradeViewStore.getState();
    setView({ symbol, ...viewForSymbol(st.maps, symbol, st.legacy) });
  }, [symbol]); // eslint-disable-line react-hooks/exhaustive-deps
  const updateView = useCallback((patch: Partial<{ chartType: ChartType; indicators: IndicatorMap; timeframe: ChartTimeframe }>) => {
    setView((v) => {
      const next = { ...v, ...patch };
      tradeView.rememberView(next.symbol, next);
      return next;
    });
  }, []);

  /* ── multi-chart layout (Trade.jsx:68-282) ── */
  const layoutId = useTradeViewStore((s) => s.layoutId);
  const sync = useTradeViewStore((s) => s.sync);
  const layout = getLayout(layoutId);
  const [panes, setPanes] = useState<PaneState[]>(() => restorePanes(useTradeViewStore.getState().panes, symbol, view.timeframe));
  const [activePane, setActivePane] = useState(0);
  useEffect(() => { tradeView.setPanes(panes); }, [panes]);
  const paneOf = (i: number): PaneState => panes[i] ?? { symbol, timeframe: view.timeframe };
  const activatePane = (i: number): void => {
    if (i === activePane) return;
    const target = paneOf(i);
    setPanes((prev) => { const n = [...prev]; n[activePane] = { symbol, timeframe: view.timeframe, chartType: view.chartType, indicators: view.indicators }; return n; });
    setActivePane(i);
    if (target.symbol !== symbol) openTab(target.symbol);
    updateView({ timeframe: target.timeframe, chartType: target.chartType ?? 'candles', indicators: target.indicators ?? {} });
  };
  const setPaneTimeframe = (i: number, tf: ChartTimeframe): void => {
    if (sync.interval) { updateView({ timeframe: tf }); setPanes((prev) => prev.map((p) => ({ ...p, timeframe: tf }))); return; }
    if (i === activePane) updateView({ timeframe: tf });
    else setPanes((prev) => { const n = [...prev]; n[i] = { ...paneOf(i), timeframe: tf }; return n; });
  };
  useEffect(() => { if (sync.symbol && layout.n > 1) setPanes((prev) => prev.map((p) => ({ ...p, symbol }))); }, [symbol, sync.symbol, layout.n]);
  useEffect(() => { if (sync.interval && layout.n > 1) setPanes((prev) => prev.map((p) => ({ ...p, timeframe: view.timeframe }))); }, [view.timeframe, sync.interval, layout.n]);
  const [crosshairMsg, setCrosshairMsg] = useState<{ src: number; time: number | null; price: number | null; n: number } | null>(null);
  const [rangeMsg, setRangeMsg] = useState<{ src: number; from: number; to: number; n: number } | null>(null);
  const multi = layout.n > 1;
  const chartSync = useMemo(() => ({ crosshair: multi && sync.crosshair, time: multi && (sync.time || sync.dateRange) }), [multi, sync]);

  /* ── the order ticket ── */
  const [orderOpen, setOrderOpen] = useState(false);
  const [orderSide, setOrderSide] = useState<OrderSide | undefined>(undefined);
  const [pendingPreview, setPendingPreview] = useState<PendingPricePreview | null>(null);
  const [orderPreview, setOrderPreview] = useState<OrderPreview | null>(null);
  const [previewExternal, setPreviewExternal] = useState<ExternalLevels | null>(null);
  const nonce = useRef(0);
  const applyPreviewLevel = useCallback((patch: Omit<ExternalLevels, 'nonce'>) => {
    nonce.current += 1;
    setPreviewExternal({ ...patch, nonce: nonce.current });
  }, []);
  useEffect(() => { setPendingPreview(null); setOrderPreview(null); }, [symbol]);

  /* ── dialogs ── */
  const [slTp, setSlTp] = useState<{ kind: 'position' | 'order'; id: string } | null>(null);
  const [modifyTarget, setModifyTarget] = useState<Order | null>(null);
  const [accountMenu, setAccountMenu] = useState(false);
  // Every account's free balance for the switcher — one GET /wallet/balances
  // (all of the user's rows, each tagged with its account), read when the
  // menu opens.
  const [accountBalances, setAccountBalances] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!accountMenu || !accounts.length) return undefined;
    let cancelled = false;
    walletApi.balances()
      .then((rows) => { if (!cancelled) setAccountBalances(accountFreeBalances(rows, accounts)); })
      .catch(() => { /* keep what we had */ });
    return () => { cancelled = true; };
  }, [accountMenu, accounts]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sharedIndicatorsOpen, setSharedIndicatorsOpen] = useState(false);

  /* ── the book's split ── */
  const bottom = useTradeViewStore((s) => s.bottom);
  const [bookTab, setBookTab] = useState<BookTab>('positions');
  const [groupH, setGroupH] = useState(600);
  const [dragH, setDragH] = useState<number | null>(null);
  const bottomH = bottom.collapsed ? 40 : Math.max(BOTTOM_MIN, Math.min(dragH ?? bottom.height, Math.max(BOTTOM_MIN, groupH - 180)));
  const dragStart = useRef(0);
  const splitter = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { dragStart.current = useTradeViewStore.getState().bottom.collapsed ? 40 : useTradeViewStore.getState().bottom.height; },
    onPanResponderMove: (_e, g) => { setDragH(Math.max(BOTTOM_MIN, dragStart.current - g.dy)); },
    onPanResponderRelease: (_e, g) => {
      setDragH(null);
      tradeView.setBottom({ height: Math.max(BOTTOM_MIN, dragStart.current - g.dy), collapsed: false });
    },
    onPanResponderTerminate: () => setDragH(null),
  }), []);

  /* ── fills behind the netted positions (Trade.jsx:4781) ── */
  const [fills, setFills] = useState<Order[] | null>(null);
  const loadFills = useCallback(() => {
    fetchOrderHistory({ accountId: account?.id ?? null })
      .then((list) => setFills(list.filter((o) => o.status === 'FILLED')))
      .catch(() => setFills((prev) => prev ?? []));
  }, [account?.id]);
  const posSig = useMemo(() => book.positions.map((p) => `${p.id}:${p.quantity}`).join('|'), [book.positions]);
  useEffect(() => { setFills(null); }, [account?.id]);
  useEffect(() => { if (posSig && live) loadFills(); }, [posSig, live, loadFills]);

  /* ── actions ── */
  const cancelOrder = useCallback(async (o: Pick<Order, 'id'>) => {
    try { await apiCancelOrder(o.id); toast.success('Order cancelled'); void refresh(); }
    catch (err) { toast.error(errorMessage(err)); }
  }, [refresh]);

  const cancelAllOrders = useCallback(async () => {
    const list = book.openOrders;
    if (!list.length) return;
    const ok = await confirm({ title: 'Cancel all pending orders', message: `Cancel all ${list.length} pending order(s)? This can't be undone.`, confirmText: 'Cancel all', danger: true });
    if (!ok) return;
    const res = await Promise.allSettled(list.map((o) => apiCancelOrder(o.id)));
    const done = res.filter((r) => r.status === 'fulfilled').length;
    if (done) toast.success(`Cancelled ${done} order${done === 1 ? '' : 's'}`);
    if (done < list.length) toast.error(`${list.length - done} could not be cancelled`);
    void refresh();
  }, [book.openOrders, confirm, refresh]);

  const orderModifyError = useCallback((err: unknown) => {
    if (isBenignOrderModifyError(err)) { void refresh(); return; }
    toast.error(errorMessage(err));
  }, [refresh]);

  const closePositionRow = useCallback(async (p: Pick<LivePositionRow, 'id'>): Promise<void> => {
    try {
      await apiClosePosition(p.id);
      toast.success('Position closing');
      void refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, [refresh]);

  const partialClose = useCallback(async (p: Pick<LivePositionRow, 'id'>, qty: number) => {
    try { await partialClosePosition(p.id, String(qty)); toast.success('Trade closed'); void refresh(); }
    catch (err) { toast.error(errorMessage(err)); }
  }, [refresh]);

  const closeAll = useCallback(async () => {
    if (!positionsLive.length) return;
    const ok = await confirm({ title: 'Close all positions', message: `Close all ${positionsLive.length} open position(s)?`, confirmText: 'Close all', danger: true });
    if (!ok) return;
    try {
      const r = closeAllMessage(await closeAllPositions(account?.id ?? null));
      if (r.ok) toast.success(r.text); else toast.error(r.text);
      void refresh();
    } catch (err) { toast.error(errorMessage(err)); }
  }, [positionsLive.length, confirm, account?.id, refresh]);

  const saveOrderModify = useCallback(async (o: Order, fields: OrderModifyFields) => {
    try {
      await modifyOrder(o.id, fields);
      toast.success('Order updated');
      setModifyTarget(null);
      void refresh();
    } catch (err) { orderModifyError(err); }
  }, [refresh, orderModifyError]);

  const prec = Math.max(0, Math.min(8, Number(instrument?.pricePrecision) || 2));
  const fmtLevel = (price: number): string => price.toFixed(prec);

  /** A pill on the chart — Trade.jsx's PriceChart callbacks, one for one. */
  const onPillAction = useCallback((a: PillAction) => {
    if (a.target === 'order' && a.id === PREVIEW_ID) {
      // The draft's × on its entry dismisses the whole preview (the form
      // clears its side); on a level it strips just that level.
      if (a.type === 'close') applyPreviewLevel(a.level === 'entry' ? { cancel: true } : a.level === 'sl' ? { stopLoss: null } : { takeProfit: null });
      else if (a.type === 'move') applyPreviewLevel(a.level === 'entry' ? { price: fmtLevel(a.price) } : a.level === 'sl' ? { stopLoss: fmtLevel(a.price) } : { takeProfit: fmtLevel(a.price) });
      return;
    }
    if (a.type === 'edit') {
      // A position opens the SL / TP modal; a pending order opens the
      // modify modal (price / qty / SL / TP), as on the web.
      if (a.target === 'position') { setSlTp({ kind: 'position', id: a.id }); return; }
      const o = book.openOrders.find((x) => x.id === a.id);
      if (o) setModifyTarget(o);
      return;
    }
    if (a.target === 'position') {
      const p = positionsLive.find((x) => x.id === a.id);
      if (a.type === 'close') {
        if (a.level === 'entry') { if (p) void closePositionRow(p); return; }
        const field = a.level === 'sl' ? { stopLoss: null } : { takeProfit: null };
        modifyPosition(a.id, field)
          .then(() => { toast.success(a.level === 'sl' ? 'SL removed' : 'TP removed'); void refresh(); })
          .catch((e: unknown) => toast.error(errorMessage(e)));
        return;
      }
      if (a.level === 'entry') return;
      const value = fmtLevel(a.price);
      const req = modifyPosition(a.id, a.level === 'sl' ? { stopLoss: value } : { takeProfit: value });
      if (a.live) { req.catch(() => undefined); return; }
      req.then(() => { toast.success(`${a.level === 'sl' ? 'SL' : 'TP'} updated to ${value}`); void refresh(); })
        .catch((e: unknown) => toast.error(errorMessage(e)));
      return;
    }
    // A pending order.
    const o = book.openOrders.find((x) => x.id === a.id);
    if (a.type === 'close') {
      if (a.level === 'entry') { void cancelOrder({ id: a.id }); return; }
      modifyOrder(a.id, a.level === 'sl' ? { stopLoss: null } : { takeProfit: null })
        .then(() => { toast.success(a.level === 'sl' ? 'Order SL removed' : 'Order TP removed'); void refresh(); })
        .catch(orderModifyError);
      return;
    }
    const value = fmtLevel(a.price);
    const body = a.level === 'entry'
      ? (o?.type === 'STOP' ? { stopPrice: value } : { price: value })
      : a.level === 'sl' ? { stopLoss: value } : { takeProfit: value };
    const req = modifyOrder(a.id, body);
    if (a.live) { req.catch(() => undefined); return; }
    req.then(() => {
      toast.success(a.level === 'entry' ? `Order moved to ${value}` : `Order ${a.level === 'sl' ? 'SL' : 'TP'} set to ${value}`);
      void refresh();
    }).catch(orderModifyError);
  }, [applyPreviewLevel, positionsLive, book.openOrders, closePositionRow, cancelOrder, refresh, orderModifyError, prec]); // eslint-disable-line react-hooks/exhaustive-deps

  /** One-click market order from the chart chip (Trade.jsx:1713). */
  const placeOneClickOrder = useCallback(async (side: OrderSide) => {
    if (!account?.id || !instrument) { toast.error('No account / instrument selected'); return; }
    const quantity = String(Number(instrument.minOrderSize) || 0.01);
    const leverage = Math.max(1, Number(account.leverage) || 1);
    try {
      const o = await placeOrder({ accountId: account.id, symbol: instrument.symbol, side, orderMode: 'MARKET', quantity, leverage });
      orderToast(`✓ ${side} ${quantity} ${instrument.symbol} — Order ${o.status}`);
      void refresh();
    } catch (err) { toast.error(errorMessage(err)); }
  }, [account, instrument, refresh]);

  const onOrderSideChange = useCallback((side: OrderSide) => {
    setOrderSide(side);
    // Fullscreen never fires a one-click order from the chip — it opens the ticket.
    if (!fullscreen && oneClickMode) { void placeOneClickOrder(side); return; }
    setOrderOpen(true);
  }, [fullscreen, oneClickMode, placeOneClickOrder]);

  /* ── SL / TP modal target ── */
  const slTpEntity = useMemo(() => {
    if (!slTp) return null;
    if (slTp.kind === 'position') return positionsLive.find((p) => p.id === slTp.id) ?? null;
    return book.openOrders.find((o) => o.id === slTp.id) ?? null;
  }, [slTp, positionsLive, book.openOrders]);

  const submitSlTp = useCallback(async (payload: { takeProfit: string | null; stopLoss: string | null }) => {
    if (!slTp) return;
    try {
      if (slTp.kind === 'order') await modifyOrder(slTp.id, payload);
      else await modifyPosition(slTp.id, payload);
      toast.success(slTp.kind === 'order' ? 'Order updated' : 'Position updated');
      setSlTp(null);
      void refresh();
    } catch (err) {
      if (slTp.kind === 'order') orderModifyError(err); else toast.error(errorMessage(err));
    }
  }, [slTp, refresh, orderModifyError]);

  const slTpPartialClose = useCallback(async (closeQty: number) => {
    if (!slTp || !slTpEntity) return;
    if (slTp.kind === 'order') { void cancelOrder({ id: slTp.id }); setSlTp(null); return; }
    const p = slTpEntity as LivePositionRow;
    const full = Number(p.quantity);
    const qty = Math.min(full, Math.max(0, Number(closeQty)));
    if (!qty) return;
    try {
      if (qty >= full) await apiClosePosition(p.id);
      else await partialClosePosition(p.id, String(qty));
      toast.success(qty >= full ? 'Position closing' : `Closing ${qty} lots`);
      setSlTp(null);
      void refresh();
    } catch (err) { toast.error(errorMessage(err)); }
  }, [slTp, slTpEntity, cancelOrder, refresh]);

  /* ── navigation out ── */
  const goBack = (): void => { navigation.navigate('Dashboard', undefined, { pop: true }); };
  const goDeposit = (): void => { navigation.navigate('Wallet', undefined, { pop: true }); };
  const goWithdraw = (): void => { navigation.navigate('Wallet', { action: 'withdraw' }, { pop: true }); };
  const goReports = (): void => { navigation.navigate('Reports', undefined, { pop: true }); };

  const onToggleShow = (key: keyof ShowToggles): void => {
    if (key === 'stopLimit') {
      const v = !showOnChart.stopLimit;
      setSetting('showOnChart.stopLimit', v);
      setSetting('showOnChart.orderPreview', v);
      return;
    }
    setSetting(`showOnChart.${key}`, !showOnChart[key]);
  };

  /* ── the chart area ── */
  const show = useMemo(() => ({ positions: showOnChart.positions, tpsl: showOnChart.tpsl, stopLimit: showOnChart.stopLimit, orderPreview: showOnChart.orderPreview }), [showOnChart]);
  const markers = useMemo(() => ({ signals: showOnChart.signals, hmr: showOnChart.hmr, calendar: showOnChart.calendar, calendarFilters }), [showOnChart, calendarFilters]);
  const pendingPreviewIn: PendingPreviewInput | null = pendingPreview ? { side: pendingPreview.side, price: pendingPreview.price } : null;
  const orderPreviewIn: OrderPreviewInput | null = orderPreview ? { side: orderPreview.side, mode: orderPreview.mode, entry: orderPreview.entry, tp: orderPreview.tp, sl: orderPreview.sl } : null;
  const quote = useMemo(() => ({
    bid: instrument?.bid != null ? Number(instrument.bid) : null,
    ask: instrument?.ask != null ? Number(instrument.ask) : null,
    last: livePrice,
  }), [instrument?.bid, instrument?.ask, livePrice]);
  const hideQuickTrade = orderOpen;
  const layoutPicker = (
    <LayoutPickerButton
      value={layoutId}
      onChange={tradeView.setLayout}
      sync={sync}
      onSyncChange={(k: SyncKey, v: boolean) => tradeView.setSync({ ...sync, [k]: v })}
    />
  );

  const primaryChart = (
    <PriceChart
      symbol={symbol}
      timeframe={view.timeframe}
      onTimeframeChange={(tf) => (multi ? setPaneTimeframe(activePane, tf) : updateView({ timeframe: tf }))}
      instrument={instrument}
      chartType={view.chartType}
      onChartTypeChange={(ct) => updateView({ chartType: ct })}
      indicators={view.indicators}
      onIndicatorsChange={(next) => updateView({ indicators: next })}
      positions={chartPositions}
      orders={chartOrders}
      pendingPreview={show.stopLimit ? pendingPreviewIn : null}
      orderPreview={orderPreviewIn}
      show={show}
      markers={markers}
      timeZone={trading.timeZone}
      quote={quote}
      onPillAction={onPillAction}
      onPickSymbol={() => setSearchOpen(true)}
      hideHeader={multi}
      orderSide={orderSide ?? null}
      onOrderSideChange={onOrderSideChange}
      hideQuickTrade={hideQuickTrade}
      openPositionsCount={positionsLive.length}
      onCloseAll={() => { void closeAll(); }}
      toolbarExtra={layoutPicker}
      fullscreen={fullscreen}
      onToggleFullscreen={() => setFullscreen((v) => !v)}
      sync={chartSync}
      onCrosshair={(time, price) => setCrosshairMsg((m) => ({ src: activePane, time, price, n: (m?.n ?? 0) + 1 }))}
      onRange={(from, to) => setRangeMsg((m) => ({ src: activePane, from, to, n: (m?.n ?? 0) + 1 }))}
      crosshairIn={crosshairMsg && crosshairMsg.src !== activePane ? { time: crosshairMsg.time, price: crosshairMsg.price, n: crosshairMsg.n } : null}
      rangeIn={rangeMsg && rangeMsg.src !== activePane ? { from: rangeMsg.from, to: rangeMsg.to, n: rangeMsg.n } : null}
      paused={!live}
      testID="trade-chart"
    />
  );

  const [gridBox, setGridBox] = useState({ w: 0, h: 0 });
  const chartArea = !multi ? primaryChart : (
    <View style={s.flex1}>
      <ChartToolbar
        symbolLabel={symbol}
        chartType={view.chartType}
        onChartType={(ct) => updateView({ chartType: ct })}
        indicatorCount={INDICATOR_LIST.filter((i) => !!view.indicators[i.key]).length || activeIndicatorKeys(view.indicators).length}
        onOpenIndicators={() => setSharedIndicatorsOpen(true)}
        timeframe={view.timeframe}
        onTimeframe={(tf) => setPaneTimeframe(activePane, tf)}
        instrument={instrument}
        precision={prec}
        orderSide={orderSide ?? null}
        onOrderSideChange={onOrderSideChange}
        hideQuickTrade={hideQuickTrade}
        extra={layoutPicker}
        fullscreen={fullscreen}
        onToggleFullscreen={() => setFullscreen((v) => !v)}
      />
      <View style={s.flex1} onLayout={(e: LayoutChangeEvent) => setGridBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
        {layout.cells.slice(0, layout.n).map((cell, i) => {
          const f = cellFrame(layout, cell);
          const pane = paneOf(i);
          const on = i === activePane;
          return (
            <View
              key={i}
              onTouchStart={() => activatePane(i)}
              style={[s.cell, {
                left: (f.left / 100) * gridBox.w,
                top: (f.top / 100) * gridBox.h,
                width: (f.width / 100) * gridBox.w,
                height: (f.height / 100) * gridBox.h,
                borderColor: on ? t.colors.primary : alpha(t.colors.borderDark, 0.7),
              }]}
              testID={`chart-pane-${i}`}
            >
              {on ? primaryChart : (
                <PriceChart
                  symbol={pane.symbol}
                  timeframe={pane.timeframe}
                  onTimeframeChange={(tf) => setPaneTimeframe(i, tf)}
                  instrument={instrumentsBySymbol[pane.symbol] ?? null}
                  chartType={pane.chartType ?? 'candles'}
                  onChartTypeChange={(ct) => setPanes((prev) => { const n = [...prev]; n[i] = { ...paneOf(i), chartType: ct }; return n; })}
                  indicators={pane.indicators ?? {}}
                  onIndicatorsChange={(next) => setPanes((prev) => { const n = [...prev]; n[i] = { ...paneOf(i), indicators: next }; return n; })}
                  timeZone={trading.timeZone}
                  onPickSymbol={() => { activatePane(i); setSearchOpen(true); }}
                  hideHeader
                  hideDrawingToolbar
                  sync={chartSync}
                  onCrosshair={(time, price) => setCrosshairMsg((m) => ({ src: i, time, price, n: (m?.n ?? 0) + 1 }))}
                  onRange={(from, to) => setRangeMsg((m) => ({ src: i, from, to, n: (m?.n ?? 0) + 1 }))}
                  crosshairIn={crosshairMsg && crosshairMsg.src !== i ? { time: crosshairMsg.time, price: crosshairMsg.price, n: crosshairMsg.n } : null}
                  rangeIn={rangeMsg && rangeMsg.src !== i ? { from: rangeMsg.from, to: rangeMsg.to, n: rangeMsg.n } : null}
                  paused={!live}
                  testID={`pane-chart-${i}`}
                />
              )}
            </View>
          );
        })}
      </View>
    </View>
  );

  /* ── panel content ── */
  const panelBody = (() => {
    switch (panelTab) {
      case 'positions':
        return (
          <PositionsPanel
            positions={positionsLive}
            activeSymbol={symbol}
            instrumentsBySymbol={instrumentsBySymbol}
            fills={fills}
            onSelect={openTab}
            onClose={(p) => { void closePositionRow(p); }}
            onCloseAll={() => { void closeAll(); }}
            onPartialClose={(p, q) => { void partialClose(p, q); }}
            onLoadFills={loadFills}
          />
        );
      case 'pending':
        return (
          <PendingPanel
            orders={book.openOrders}
            activeSymbol={symbol}
            instrumentsBySymbol={instrumentsBySymbol}
            onCancel={(o) => { void cancelOrder(o); }}
            onCancelAll={() => { void cancelAllOrders(); }}
            onModify={(o) => { openTab(o.symbol); setPanelsOpen(false); setModifyTarget(o); }}
            nowMs={Date.now()}
          />
        );
      case 'watchlist':
        return (
          <InstrumentsPanel
            rows={visible}
            total={visible.length}
            activeSymbol={symbol}
            search={watchSearch}
            onSearch={setWatchSearch}
            filter={filter}
            onFilter={(v) => { tradeView.setFilter(v); if (v.startsWith('wl:')) setActiveId(v.slice(3)); }}
            watchlists={watchlists}
            categories={categories}
            onOpen={openTab}
            onManage={(r: InstrumentRow) => openWatchlistModal(r.symbol, r)}
          />
        );
      case 'details': return <DetailsPanel instrument={instrument} demo={demo} planLeverage={planLeverage} />;
      case 'about': return <AboutPanel instrument={instrument} />;
      case 'performance': return <PerformancePanel instrument={instrument} livePrice={livePrice} demo={demo} planLeverage={planLeverage} />;
      case 'depth': return <DepthPanelLive instrument={instrument} livePrice={livePrice} active={panelsOpen && live} />;
      case 'hotlist': return <MoversPanel rows={rowsNow} overlay={movers} cat={moverCat} onCat={setMoverCat} onOpen={openTab} />;
      case 'settings': return <TradeSettingsPanel />;
      default: return null;
    }
  })();

  const onGroupLayout = (e: LayoutChangeEvent): void => setGroupH(e.nativeEvent.layout.height);

  return (
    <View style={[s.root, { backgroundColor: t.colors.bgDark, paddingTop: insets.top }]} testID="trade-screen">
      {!fullscreen ? (
        <TradeTopBar
          tabs={tabs}
          activeSymbol={symbol}
          instrumentsBySymbol={instrumentsBySymbol}
          onSelectTab={setSymbol}
          onCloseTab={onCloseTab}
          onReorderTabs={(ordered) => setTabs(ordered)}
          onAddTab={() => setSearchOpen(true)}
          account={account}
          equity={figures.equity ?? walletFree}
          hideBalance={hideBalance}
          onOpenAccountMenu={() => setAccountMenu(true)}
          show={{ positions: showOnChart.positions, tpsl: showOnChart.tpsl, stopLimit: showOnChart.stopLimit }}
          onToggleShow={onToggleShow}
          onBack={goBack}
          onDeposit={goDeposit}
          onOpenPanels={() => setPanelsOpen(true)}
          themeMode={themeMode === 'dark' ? 'dark' : 'light'}
          onToggleTheme={toggleTheme}
        />
      ) : null}

      <View style={s.flex1} onLayout={onGroupLayout}>
        <View style={[s.flex1, s.chartBox, { borderColor: t.colors.borderDark }]}>
          {instrument ? chartArea : <LoadingView label="Loading chart…" />}
        </View>
        {!fullscreen ? (
          <>
            <View {...splitter.panHandlers} style={s.handleZone} accessibilityRole="adjustable" accessibilityLabel="Drag to resize" testID="book-handle">
              <View style={[s.handle, { backgroundColor: dragH !== null ? t.colors.primary : t.colors.borderDark }]} />
            </View>
            <View style={[s.bookBox, { height: bottomH, borderColor: t.colors.borderDark, backgroundColor: t.colors.bgCard }]}>
              <TradeBook
                tab={bookTab}
                onTab={setBookTab}
                collapsed={bottom.collapsed}
                onToggleCollapsed={() => tradeView.setBottom({ ...bottom, collapsed: !bottom.collapsed })}
                onMaximize={() => {
                  const maxH = Math.round(groupH * 0.7);
                  tradeView.setBottom({ height: bottom.height >= maxH - 5 ? BOTTOM_DEFAULT : maxH, collapsed: false });
                }}
                positions={positionsLive}
                orders={book.openOrders}
                closed={book.closed}
                rejected={book.rejected}
                instrumentsBySymbol={instrumentsBySymbol}
                livePrices={priceMap}
                onCloseAll={() => { void closeAll(); }}
                onClose={(p) => { void closePositionRow(p); }}
                onPartialClose={(p, q) => { void partialClose(p, q); }}
                onModifyPosition={(p) => setSlTp({ kind: 'position', id: p.id })}
                onModifyOrder={(o) => setSlTp({ kind: 'order', id: o.id })}
                onCancelOrder={(o) => { void cancelOrder(o); }}
                fills={fills}
                onViewHistory={goReports}
              />
            </View>
          </>
        ) : null}
      </View>

      {!fullscreen ? <EquityBar figures={figures} /> : null}
      <View style={{ height: fullscreen ? insets.bottom : Math.max(insets.bottom - 8, 0) }} />

      {!orderOpen ? (
        <View style={[s.fabs, { bottom: (fullscreen ? 16 : 96) + insets.bottom }]} pointerEvents="box-none">
          <Pressable accessibilityRole="button" onPress={() => setPanelsOpen(true)} style={[s.fabSecondary, { backgroundColor: t.colors.surface, borderColor: t.colors.borderDark }]} testID="open-panels">
            <AppText variant="smallStrong">☰ Panels</AppText>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open order panel"
            onPress={() => setOrderOpen(true)}
            style={[s.fab, { backgroundColor: orderSide === 'SELL' ? '#DC2626' : '#059669' }]}
            testID="place-order-fab"
          >
            <AppText variant="bodyStrong" color="#FFFFFF">+ Place Order</AppText>
          </Pressable>
        </View>
      ) : null}

      <BottomSheet open={orderOpen && focused} onClose={() => setOrderOpen(false)} bodyPadding={0} testID="trade-order-sheet">
        {instrument && account ? (
          <OrderForm
            instrument={instrument}
            account={account}
            onPlaced={() => { void refresh(); }}
            onPendingPriceChange={setPendingPreview}
            onPreviewChange={setOrderPreview}
            externalLevels={previewExternal}
            side={orderSide}
            onSideChange={(sd) => setOrderSide(sd ?? undefined)}
            onClose={() => setOrderOpen(false)}
            confirm={confirm}
          />
        ) : (
          <AppText variant="small" tone="muted" align="center" style={s.pad}>{account ? 'Loading order form…' : 'No trading account found.'}</AppText>
        )}
      </BottomSheet>

      {slTpEntity && slTp ? (
        <PositionSlTpModal
          position={slTpEntity}
          kind={slTp.kind}
          instrument={instrumentsBySymbol[slTpEntity.symbol] ?? null}
          free={figures.free ?? undefined}
          onClose={() => setSlTp(null)}
          onSubmit={submitSlTp}
          onPartialClose={slTpPartialClose}
        />
      ) : null}

      <PendingOrderModifyModal
        order={modifyTarget}
        onClose={() => setModifyTarget(null)}
        onSave={saveOrderModify}
        onCancelOrder={(o) => { setModifyTarget(null); void cancelOrder(o); }}
      />

      <AccountMenuSheet
        open={accountMenu}
        onClose={() => setAccountMenu(false)}
        account={account}
        accounts={accounts}
        figures={figures}
        walletFree={walletFree}
        balances={accountBalances}
        leverage={planLeverage}
        hideBalance={hideBalance}
        onHideBalance={tradeView.setHideBalance}
        onSelectAccount={selectAccount}
        onDeposit={() => { setAccountMenu(false); goDeposit(); }}
        onWithdraw={() => { setAccountMenu(false); goWithdraw(); }}
        onHistory={() => { setAccountMenu(false); goReports(); }}
      />

      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} onPick={openTab} />

      <IndicatorsSheet
        open={sharedIndicatorsOpen}
        mode="checklist"
        indicators={view.indicators}
        onChange={(next) => updateView({ indicators: next })}
        onEdit={() => undefined}
        onClose={() => setSharedIndicatorsOpen(false)}
      />

      <TradePanelsSheet
        open={panelsOpen}
        tab={panelTab}
        onTab={setPanelTab}
        onClose={() => setPanelsOpen(false)}
        counts={{ watchlist: visible.length, positions: book.positions.length, pending: book.openOrders.length }}
      >
        {panelBody}
      </TradePanelsSheet>
    </View>
  );
}

/** The depth panel with its own subscription, only while it is on screen (Trade.jsx:901-932). */
function DepthPanelLive({ instrument, livePrice, active }: { instrument: ReturnType<typeof withLiveQuote> | null; livePrice: number | null; active: boolean }): React.JSX.Element {
  const { book } = useOrderBook(active && instrument ? instrument.symbol : null, 20);
  return <DepthPanel instrument={instrument} book={book} livePrice={livePrice} />;
}

const s = StyleSheet.create({
  root: { flex: 1 },
  flex1: { flex: 1, minHeight: 0 },
  chartBox: { borderTopWidth: 0, overflow: 'hidden' },
  cell: { position: 'absolute', borderWidth: 1, borderRadius: 6, overflow: 'hidden' },
  handleZone: { height: 14, alignItems: 'center', justifyContent: 'center' },
  handle: { width: 48, height: 4, borderRadius: 2 },
  bookBox: { borderTopWidth: 1, overflow: 'hidden' },
  fabs: { position: 'absolute', right: 12, left: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fab: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 11, borderRadius: 999, elevation: 4, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
  fabSecondary: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 999, borderWidth: 1, elevation: 2 },
  pad: { padding: 24 },
});
