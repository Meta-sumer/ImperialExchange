/**
 * Stage 3 integration: the market / portfolio routes are plugged into the
 * one registry, the chrome slots hold their components, every web path the
 * product emits for these screens resolves to the right route with the
 * params the screen reads, and the market screens mount and draw their
 * EquityHub states — Explore (India-only segments, Market News), the Option
 * Chain (Index / Stocks / Commodity tabs, expiries, Dhan analytics, the
 * Greeks toggle, polling, tap-to-trade) and the Watchlist.
 */
import 'react-native-gesture-handler/jestSetup';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React, { act, type ComponentType } from 'react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// Whole screens mount here; under a full parallel run one can take longer
// than jest's 5 s default, and a timed-out mount leaves the next test a
// stale renderer.
jest.setTimeout(30_000);

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

jest.mock('@/websocket/ws', () => ({
  wsClient: {
    connect: () => {},
    disconnect: () => {},
    subscribe: () => () => {},
    onAuthError: () => () => {},
    onStateChange: () => () => {},
    getState: () => 'closed',
  },
}));

// Native modules the registered screens import (no native binary in jest).
jest.mock('react-native-webview', () => ({ WebView: () => null }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('expo-image-picker', () => ({
  getCameraPermissionsAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  UIImagePickerPreferredAssetRepresentationMode: { Automatic: 'automatic', Compatible: 'compatible', Current: 'current' },
}));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(async () => true), shareAsync: jest.fn(async () => {}) }));
jest.mock('expo-file-system', () => ({
  File: jest.fn().mockImplementation(() => ({ create: jest.fn(), write: jest.fn(), text: jest.fn(async () => ''), uri: 'file:///x' })),
  Paths: { cache: 'file:///cache' },
}));

jest.mock('@/store/selectedAccount', () => {
  const { create } = jest.requireActual('zustand');
  const useSelectedAccountStore = create(() => ({
    accounts: [],
    selectedId: null,
    loading: false,
    error: null,
    userId: null,
    load: jest.fn(async () => {}),
    select: jest.fn(),
    reset: jest.fn(),
  }));
  return { useSelectedAccountStore, selectSelectedAccount: () => null };
});

jest.mock('@/hooks/useUsdInr', () => ({ useUsdInr: () => null }));

jest.mock('@/api/dashboard.api', () => {
  const actual = jest.requireActual('@/api/dashboard.api');
  return {
    ...actual,
    useDashboard: jest.fn(),
    fetchLifetimeStats: jest.fn(async () => actual.adaptLifetimeStats({})),
    fetchPerformanceSeries: jest.fn(async () => actual.adaptSeries({})),
  };
});

jest.mock('@/api/trading.api', () => {
  const actual = jest.requireActual('@/api/trading.api');
  return {
    ...actual,
    fetchPositions: jest.fn(async () => []),
    fetchPositionHistory: jest.fn(async () => ({
      items: [],
      summary: actual.EMPTY_HISTORY_SUMMARY,
      pagination: { page: 1, limit: 6, total: 0, pages: 1 },
    })),
    retainAccountMetrics: jest.fn(() => () => {}),
    closeAllPositions: jest.fn(),
  };
});

jest.mock('@/api/instruments.api', () => {
  const actual = jest.requireActual('@/api/instruments.api');
  return {
    ...actual,
    useInstruments: () => ({ rows: [], loading: false, error: null }),
    fetchInstrument: jest.fn(async () => null),
    searchOptionContracts: jest.fn(async () => []),
  };
});

jest.mock('@/api/watchlist.api', () => {
  const actual = jest.requireActual('@/api/watchlist.api');
  return { ...actual, useWatchlists: jest.fn() };
});

jest.mock('@/api/market.api', () => {
  const actual = jest.requireActual('@/api/market.api');
  return { ...actual, fetchFnoUnderlyings: jest.fn(), fetchOptionChain: jest.fn() };
});

jest.mock('@/api/news.api', () => {
  const actual = jest.requireActual('@/api/news.api');
  return { ...actual, fetchMarketNews: jest.fn(async () => []) };
});

/* eslint-disable import/first */
import { adaptDashboard, useDashboard } from '@/api/dashboard.api';
import { fetchFnoUnderlyings, fetchOptionChain } from '@/api/market.api';
import { fetchMarketNews, useMarketNewsStore } from '@/api/news.api';
import { useWatchlists } from '@/api/watchlist.api';
import { GlobalAlertPopup } from '@/components/alerts/GlobalAlertPopup';
import { HeaderBell as BellComponent, NotificationEngineKeeper } from '@/components/chrome/HeaderBell';
import { HeaderSearch as SearchComponent } from '@/components/chrome/HeaderSearch';
import { WatchlistModalProvider } from '@/components/market/WatchlistModal';
import { ConfirmProvider, PortalHost } from '@/components/ui';
import { AppProviders, GlobalOverlays, HeaderBell, HeaderSearch } from '@/navigation/chromeSlots';
import { screenRegistry } from '@/navigation/screenRegistry';
import { APP_SCREENS, GUEST_SCREENS, PUBLIC_SCREENS, type RootStackParamList, type ScreenName } from '@/navigation/types';
import { resolveWebPath } from '@/navigation/webPaths';
import { AlertsScreen } from '@/screens/alerts/AlertsScreen';
import { ComingSoonScreen } from '@/screens/common/ComingSoonScreen';
import { DashboardScreen } from '@/screens/dashboard/DashboardScreen';
import { ExploreScreen } from '@/screens/explore/ExploreScreen';
import { MarketListScreen } from '@/screens/markets/MarketListScreen';
import { OptionChainScreen } from '@/screens/markets/OptionChainScreen';
import { StockDetailScreen } from '@/screens/markets/StockDetailScreen';
import { NewsArticleScreen } from '@/screens/news/NewsArticleScreen';
import { NewsScreen } from '@/screens/news/NewsScreen';
import { OrdersScreen } from '@/screens/orders/OrdersScreen';
import { ReportsScreen } from '@/screens/reports/ReportsScreen';
import { WatchlistScreen } from '@/screens/watchlist/WatchlistScreen';
import { ThemeProvider } from '@/theme';
import { adaptFnoUnderlyings, adaptOptionChain, adaptWatchlist } from '@/types/market';
import { encodeWatchlist } from '@/utils/watchlistShare';
/* eslint-enable import/first */

/* ── The registry ─────────────────────────────────────────────────────── */

const STAGE3: Record<string, ComponentType<never>> = {
  Dashboard: DashboardScreen,
  Explore: ExploreScreen,
  MarketList: MarketListScreen,
  Watchlist: WatchlistScreen,
  StockDetail: StockDetailScreen,
  Options: OptionChainScreen,
  Alerts: AlertsScreen,
  News: NewsScreen,
  NewsArticle: NewsArticleScreen,
  Reports: ReportsScreen,
  Orders: OrdersScreen,
};
const AUTH = ['Login', 'Register', 'ForgotPassword', 'ResetPassword', 'VerifyEmail'];
const STAGE2 = ['Wallet', 'BonusWallet', 'Plans', 'NewAccountTiers', 'NewAccountConfigure', 'Profile'];

describe('screenRegistry after stage 3', () => {
  const all: ScreenName[] = [...GUEST_SCREENS, ...PUBLIC_SCREENS, ...APP_SCREENS];

  it.each(Object.entries(STAGE3))('%s renders its ported screen, not ComingSoon', (name, component) => {
    const registered = screenRegistry[name as ScreenName] as unknown;
    expect(registered).toBe(component);
    expect(registered).not.toBe(ComingSoonScreen);
  });

  // The exact ported set is pinned by the latest stage's integration test;
  // here: every route through stage 3 is still ported.
  it('the auth, stage 2 and stage 3 routes are all off ComingSoon', () => {
    // EquityHub's App.jsx renders 34 distinct pages (/subscription-wallet now redirects to /bonus-wallet); /preview/order-modal and
    // /download are not ported.
    expect(all).toHaveLength(32);
    const ported = all.filter((n) => (screenRegistry[n] as unknown) !== ComingSoonScreen);
    expect(ported).toEqual(expect.arrayContaining([...AUTH, ...STAGE2, ...Object.keys(STAGE3)]));
  });
});

describe('chrome slots after stage 3', () => {
  it('holds the search, the bell, the alert popup and the watchlist sheet provider', () => {
    expect(HeaderSearch).toBe(SearchComponent);
    expect(HeaderBell).toBe(BellComponent);
    // The keeper holds the bell's engine now the bell is only in the profile menu.
    expect(GlobalOverlays).toEqual([GlobalAlertPopup, NotificationEngineKeeper]);
    expect(AppProviders).toEqual([WatchlistModalProvider]);
  });
});

/* ── Deep links ───────────────────────────────────────────────────────── */

describe('web paths reach the stage 3 screens with the params they read', () => {
  it.each([
    ['/dashboard', 'Dashboard', undefined],
    ['/explore', 'Explore', undefined],
    ['/explore#market-news', 'Explore', { section: 'market-news' }],
    ['/markets', 'MarketList', undefined],
    ['/markets?view=most-traded&sector=indices', 'MarketList', { view: 'most-traded', sector: 'indices' }],
    ['/positions', 'Positions', undefined],
    ['/watchlist', 'Watchlist', undefined],
    ['/wishlist', 'Watchlist', undefined],
    ['/favorites', 'Watchlist', undefined],
    ['/watchlist?share=abc', 'Watchlist', { share: 'abc' }],
    ['/stock/RELIANCE', 'StockDetail', { symbol: 'RELIANCE' }],
    ['/options?underlying=NIFTY', 'Options', { underlying: 'NIFTY' }],
    ['/options?underlying=CRUDEOIL&expiry=2026-11-17', 'Options', { underlying: 'CRUDEOIL', expiry: '2026-11-17' }],
    ['/option-chain', 'Options', undefined],
    ['/alerts', 'Alerts', undefined],
    ['/news', 'News', undefined],
    ['/news/rbi-holds-rates', 'NewsArticle', { slug: 'rbi-holds-rates' }],
    ['/reports', 'Reports', undefined],
    ['/orders', 'Orders', undefined],
  ] as const)('%s → %s', (path, name, params) => {
    const route = resolveWebPath(path);
    expect(route.name).toBe(name);
    if (params) expect(route.params).toMatchObject(params);
  });
});

/* ── Rendering the integration-pass screens ───────────────────────────── */

interface TestNode {
  type: unknown;
  props: Record<string, unknown>;
  parent: TestNode | null;
  findAll(pred: (n: TestNode) => boolean): TestNode[];
}
interface Renderer { root: TestNode; toJSON(): unknown; unmount(): void }
const { create } = require('react-test-renderer') as { create: (el: React.ReactElement) => Renderer };

const textOf = (node: unknown): string => {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  const n = node as { children?: unknown };
  return textOf(n.children ?? null);
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
};

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const Stack = createNativeStackNavigator<RootStackParamList>();

function Stub({ route }: { route: { name: string; params?: object } }): React.JSX.Element {
  return <Text>{`route:${route.name}:${JSON.stringify(route.params ?? {})}`}</Text>;
}

let renderer: Renderer | null = null;

const mount = async <N extends ScreenName>(name: N, Screen: ComponentType<never>, params?: RootStackParamList[N]): Promise<Renderer> => {
  const routes: ScreenName[] = [name, ...(['Trade', 'Wallet', 'Profile', 'Explore', 'Reports'] as ScreenName[]).filter((r) => r !== name)];
  const tree = (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>
        <NavigationContainer initialState={{ index: 0, routes: [{ name, params }] } as never}>
          <PortalHost>
            <ConfirmProvider>
              <Stack.Navigator screenOptions={{ headerShown: false, animation: 'none' }}>
                {routes.map((r) => (
                  <Stack.Screen key={r} name={r} component={(r === name ? Screen : Stub) as ComponentType} />
                ))}
              </Stack.Navigator>
            </ConfirmProvider>
          </PortalHost>
        </NavigationContainer>
      </ThemeProvider>
    </SafeAreaProvider>
  );
  await act(async () => { renderer = create(tree); });
  await settle();
  return renderer as unknown as Renderer;
};

afterEach(async () => {
  if (renderer) {
    const r = renderer;
    renderer = null;
    await act(async () => { r.unmount(); });
  }
});

const SUMMARY = adaptDashboard({
  user: { firstName: 'Asha', lastName: 'Rao', kycStatus: 'APPROVED' },
  balance: { live: '1000', primaryCurrency: 'USD', liveByCurrency: { USD: { balance: '1000' } } },
  equity: { unrealizedPnl: '25', openPositions: [] },
  pnl: { realizedToday: '10', winRate: 62.5 },
});

describe('Dashboard', () => {
  const dash = useDashboard as jest.Mock;

  it('draws the page from the server summary: header, hero, sections and the empty states', async () => {
    dash.mockReturnValue({ data: SUMMARY, loading: false, refresh: jest.fn(async () => {}) });
    const r = await mount('Dashboard', DashboardScreen as ComponentType<never>);
    const text = textOf(r.toJSON());
    expect(text).toContain('Portfolio');
    expect(text).toContain('Asha Rao · Equity, P&L, open positions and activity — all in one view');
    expect(text).toContain('KYC Verified');
    expect(text).toContain('Add Funds');
    expect(text).toContain('Recent Closed Trades');
    expect(text).toContain('No closed trades yet');
    expect(text).toContain('No open positions');
    // EquityHub has no broker connect: no broker funds card.
    expect(text).not.toContain('Broker Funds');
  });

  it('shows the skeleton while the first read is out', async () => {
    dash.mockReturnValue({ data: null, loading: true, refresh: jest.fn(async () => {}) });
    const r = await mount('Dashboard', DashboardScreen as ComponentType<never>);
    expect(r.root.findAll((n) => n.props.testID === 'dashboard-loading').length).toBeGreaterThan(0);
  });

  it('a failed first read offers Retry, and Retry asks again', async () => {
    const refresh = jest.fn(async () => {});
    dash.mockReturnValue({ data: null, loading: false, refresh });
    const r = await mount('Dashboard', DashboardScreen as ComponentType<never>);
    expect(textOf(r.toJSON())).toContain("Couldn't load your portfolio");
    const retry = r.root.findAll((n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function'
      && textOf((n as unknown as { props: { children?: unknown } }).props.children).includes('Retry'))[0]
      ?? r.root.findAll((n) => typeof n.props.onPress === 'function')[0];
    await act(async () => { (retry?.props.onPress as () => void)(); });
    expect(refresh).toHaveBeenCalled();
  });
});

describe('Watchlist', () => {
  const wl = useWatchlists as jest.Mock;
  const fav = adaptWatchlist({
    _id: 'w1', name: 'Favorites', emoji: '⭐', isDefault: true,
    items: [{ _id: 'i1', symbol: 'RELIANCE', pinned: true }, { _id: 'i2', symbol: 'TCS' }],
  });
  const empty = adaptWatchlist({ _id: 'w2', name: 'Scalping', emoji: '🔥', items: [] });
  const state = (activeId: string, over: Record<string, unknown> = {}) => ({
    watchlists: [fav, empty],
    activeId,
    activeList: [fav, empty].find((w) => w.id === activeId) ?? null,
    loading: false,
    loaded: true,
    setActiveId: jest.fn(),
    createList: jest.fn(),
    renameList: jest.fn(),
    deleteList: jest.fn(),
    duplicateList: jest.fn(),
    reorderLists: jest.fn(async () => {}),
    importWatchlist: jest.fn(async () => fav),
    bulkAddSymbols: jest.fn(),
    removeSymbol: jest.fn(async () => fav),
    reorderSymbols: jest.fn(async () => fav),
    pinSymbol: jest.fn(async () => fav),
    moveSymbol: jest.fn(),
    copySymbol: jest.fn(),
    reload: jest.fn(async () => undefined),
    ...over,
  });

  it('draws the lists as pills and the open list’s symbols as cards', async () => {
    wl.mockReturnValue(state('w1'));
    const r = await mount('Watchlist', WatchlistScreen as ComponentType<never>);
    const text = textOf(r.toJSON());
    expect(text).toContain('My Watchlists');
    expect(text).toContain('⭐ Favorites');
    expect(text).toContain('🔥 Scalping');
    expect(text).toContain('RELIANCE');
    expect(text).toContain('TCS');
    expect(text).toContain('Add Symbol');
  });

  it('an empty list says so and offers to add symbols', async () => {
    wl.mockReturnValue(state('w2'));
    const r = await mount('Watchlist', WatchlistScreen as ComponentType<never>);
    expect(textOf(r.toJSON())).toContain('This watchlist is empty');
  });

  it('no lists at all: the first-run invitation', async () => {
    wl.mockReturnValue(state('', { watchlists: [], activeList: null }));
    const r = await mount('Watchlist', WatchlistScreen as ComponentType<never>);
    expect(textOf(r.toJSON())).toContain('Create your first watchlist');
  });

  it('a ?share= link opens the import, prefilled with the shared list', async () => {
    wl.mockReturnValue(state('w1'));
    const code = encodeWatchlist({ name: 'Shared picks', emoji: '🚀', color: '', items: [{ symbol: 'INFY' }] });
    const r = await mount('Watchlist', WatchlistScreen as ComponentType<never>, { share: code });
    const text = textOf(r.toJSON());
    expect(text).toContain('Import watchlist');
    expect(text).toContain('Shared picks');
    // The catalogue (empty here) does not know INFY, so it is skipped.
    expect(text).toContain('1 unknown skipped');
  });

  it('a broken ?share= link is refused with a toast, and nothing opens', async () => {
    wl.mockReturnValue(state('w1'));
    const r = await mount('Watchlist', WatchlistScreen as ComponentType<never>, { share: '%%%not-a-code' });
    expect(textOf(r.toJSON())).not.toContain('Import watchlist');
  });
});

/* ── Option Chain — pages/OptionChain.jsx ─────────────────────────────── */

const UNDERLYINGS = adaptFnoUnderlyings({
  segments: { indiaOnly: true },
  underlyings: [
    { underlying: 'NIFTY', kind: 'INDEX', exchange: 'NFO', name: 'Nifty 50', lotSize: 75, optionExpiries: ['2026-10-27', '2026-11-03', '2026-11-10', '2026-11-24'], futures: [{ symbol: 'NIFTY27OCT26FUT', lastPrice: 25060 }] },
    { underlying: 'BANKNIFTY', kind: 'INDEX', exchange: 'NFO', name: 'Nifty Bank', optionExpiries: ['2026-10-27'], futures: [] },
    { underlying: 'RELIANCE', kind: 'STOCK', exchange: 'NFO', name: 'Reliance Industries', optionExpiries: ['2026-10-27'], futures: [] },
    { underlying: 'CRUDEOIL', kind: 'COMMODITY', exchange: 'MCX', name: 'CRUDEOIL', optionExpiries: ['2026-11-17'], futures: [] },
  ],
});

const leg = (symbol: string, lastPrice: number, extra: Record<string, unknown> = {}) => ({ symbol, lastPrice, tradingEnabled: true, ...extra });

const NIFTY_CHAIN = adaptOptionChain({
  underlying: 'NIFTY',
  kind: 'INDEX',
  exchange: 'NFO',
  expiry: '2026-10-27',
  expiries: ['2026-10-27', '2026-11-03', '2026-11-10', '2026-11-24'],
  spot: { symbol: 'NIFTY', name: 'Nifty 50', lastPrice: 25012.4 },
  lotSize: 75,
  atmStrike: 25000,
  strikes: [
    { strike: 24950, CE: leg('NIFTY27OCT2624950CE', 140, { stats: { oi: 80000, oiChange: 1200, iv: 12.1, delta: 0.6 } }), PE: leg('NIFTY27OCT2624950PE', 60) },
    { strike: 25000, CE: leg('NIFTY27OCT2625000CE', 110, { stats: { oi: 120000, oiChange: -500, iv: 12.4, delta: 0.52 } }), PE: leg('NIFTY27OCT2625000PE', 95, { tradingEnabled: false }) },
    { strike: 25050, CE: leg('NIFTY27OCT2625050CE', 80), PE: null },
  ],
  analytics: { source: 'DHAN', asOf: '2026-10-22T09:00:00.000Z', ceOi: 200000, peOi: 150000, pcr: 0.75, maxPain: 25000 },
});

describe('Option Chain', () => {
  const underlyings = fetchFnoUnderlyings as jest.Mock;
  const chainFn = fetchOptionChain as jest.Mock;
  beforeEach(() => {
    underlyings.mockReset();
    chainFn.mockReset();
    underlyings.mockResolvedValue(UNDERLYINGS);
    chainFn.mockResolvedValue(NIFTY_CHAIN);
  });

  it('opens on the first index, and draws the chain with the Dhan analytics', async () => {
    const r = await mount('Options', OptionChainScreen as ComponentType<never>);
    expect(chainFn).toHaveBeenCalledWith('NIFTY', null, 'INDEX');
    const text = textOf(r.toJSON());
    for (const s of [
      'Option Chain', 'Index', 'Stocks', 'Commodity (MCX)', 'NIFTY', 'BANKNIFTY', '27 Oct', '24 Nov',
      'Nifty 50', '₹25,012.40', 'Lot size', '75', 'ATM strike', '25,000', '27 Oct 2026', 'PCR (OI)', '0.75',
      'Max pain', 'Call OI / Put OI', '2.00L / 1.50L', 'Calls (CE)', 'Puts (PE)', 'OI', 'Chg OI', 'IV', 'LTP', 'Strike',
      '1.20L', '-500', 'ATM', 'Spot ₹25,012.40', 'NIFTY27OCT26FUT',
    ]) expect({ s, found: text.includes(s) }).toEqual({ s, found: true });
    expect(text).toContain("selling to open (option writing) isn’t available");
    expect(text).toContain('one lot is 75, so a lot costs premium × 75');
    // Greeks off by default.
    expect(text).not.toContain('Δ Delta');
  });

  it('the Greeks toggle adds the Greek columns and is remembered under eh:oc:greeks', async () => {
    const r = await mount('Options', OptionChainScreen as ComponentType<never>);
    const toggle = r.root.findAll((n) => n.props.accessibilityLabel === 'Greeks' && typeof n.props.onPress === 'function')[0];
    await act(async () => { (toggle?.props.onPress as () => void)(); });
    await settle();
    const text = textOf(r.toJSON());
    for (const s of ['Vol', 'Δ Delta', 'Θ Theta', 'Γ Gamma', 'V Vega', '0.52']) expect(text).toContain(s);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const storage = require('@react-native-async-storage/async-storage');
    const AsyncStorage = (storage.default ?? storage) as { getItem: (k: string) => Promise<string | null> };
    expect(await AsyncStorage.getItem('eh:oc:greeks')).toBe('1');
    await act(async () => { (toggle?.props.onPress as () => void)(); });
    expect(await AsyncStorage.getItem('eh:oc:greeks')).toBe('0');
  });

  it('a premium opens that contract on the trade page; a disabled contract does nothing', async () => {
    const r = await mount('Options', OptionChainScreen as ComponentType<never>);
    const off = r.root.findAll((n) => n.props.testID === 'premium-NIFTY27OCT2625000PE' && typeof n.props.onPress === 'function')[0];
    expect(off?.props.disabled).toBe(true);
    const on = r.root.findAll((n) => n.props.testID === 'premium-NIFTY27OCT2625000CE' && typeof n.props.onPress === 'function')[0];
    await act(async () => { (on?.props.onPress as () => void)(); });
    await settle();
    expect(textOf(r.toJSON())).toContain('route:Trade:{"symbol":"NIFTY27OCT2625000CE"}');
  });

  it('an expiry chip and the Commodity tab re-read the chain for that selection', async () => {
    const r = await mount('Options', OptionChainScreen as ComponentType<never>);
    const chip = r.root.findAll((n) => n.props.testID === 'expiry-2026-11-03' && typeof n.props.onPress === 'function')[0];
    await act(async () => { (chip?.props.onPress as () => void)(); });
    await settle();
    expect(chainFn).toHaveBeenLastCalledWith('NIFTY', '2026-11-03', 'INDEX');
    const mcx = r.root.findAll((n) => n.props.accessibilityLabel === 'Commodity (MCX)' && typeof n.props.onPress === 'function')[0];
    await act(async () => { (mcx?.props.onPress as () => void)(); });
    await settle();
    expect(chainFn).toHaveBeenLastCalledWith('CRUDEOIL', null, 'COMMODITY');
  });

  it('a stock opens on the Stocks tab with its select', async () => {
    const r = await mount('Options', OptionChainScreen as ComponentType<never>, { underlying: 'reliance' });
    expect(chainFn).toHaveBeenCalledWith('RELIANCE', null, 'STOCK');
    const text = textOf(r.toJSON());
    expect(text).toContain('Stock');
    expect(text).toContain('RELIANCE — Reliance Industries');
  });

  it('an underlying with no options says so; nothing listed at all says chains are unavailable', async () => {
    const r = await mount('Options', OptionChainScreen as ComponentType<never>, { underlying: 'XYZ' });
    expect(textOf(r.toJSON())).toContain('XYZ has no options listed on EquityHub. Pick an underlying above.');
    expect(chainFn).not.toHaveBeenCalled();
    await act(async () => { r.unmount(); });
    renderer = null;

    underlyings.mockResolvedValue(adaptFnoUnderlyings({ segments: {}, underlyings: [] }));
    const empty = await mount('Options', OptionChainScreen as ComponentType<never>);
    const text = textOf(empty.toJSON());
    expect(text).toContain('Option chains aren’t available right now');
    expect(text).toContain('F&O trading is switched off or today’s contracts haven’t been listed yet. Please check back shortly.');
  });

  it('a failed chain shows the server message; an LTP-only chain has no analytics columns', async () => {
    chainFn.mockRejectedValueOnce({ response: { status: 404, data: { error: { message: 'No option chain for NIFTY — the segment may be switched off or no contracts are listed yet.' } } } });
    const r = await mount('Options', OptionChainScreen as ComponentType<never>);
    expect(textOf(r.toJSON())).toContain('No option chain for NIFTY — the segment may be switched off');
    await act(async () => { r.unmount(); });
    renderer = null;

    chainFn.mockResolvedValue({ ...NIFTY_CHAIN, analytics: null });
    const plain = await mount('Options', OptionChainScreen as ComponentType<never>);
    const text = textOf(plain.toJSON());
    expect(text).toContain('LTP');
    expect(text).not.toContain('Chg OI');
    expect(text).not.toContain('PCR (OI)');
  });
});

/* ── Explore — pages/Explore.jsx ──────────────────────────────────────── */

describe('Explore', () => {
  // The feed is the app-wide news store (api/news.api); a fresh one is served without a request.
  beforeEach(() => {
    useMarketNewsStore.setState({
      at: Date.now(),
      items: [
        { id: 'n1', title: 'Reliance hits a record high', url: 'https://example.com/a', summary: 'Shares rose 3%.', image: null, source: 'Mint', publishedAt: new Date().toISOString(), tags: [{ symbol: 'RELIANCE', name: 'Reliance' }] },
        { id: 'n2', title: 'RBI holds rates', url: 'https://example.com/b', summary: null, image: null, source: 'Economic Times', publishedAt: new Date().toISOString(), tags: [] },
      ],
    });
  });

  it('is one India-only page: no market title, the EquityHub products, and Market News in place of the calendar', async () => {
    const r = await mount('Explore', ExploreScreen as ComponentType<never>);
    const text = textOf(r.toJSON());
    for (const s of ['Most traded', 'Top liquidity across all markets today', 'Market movers', 'Top names by performance over the last 24h.',
      'All categories', 'Products & Tools', 'Trading Terminal', 'Open the pro chart', 'Market News', 'All news', 'Stocks in news',
      'Reliance hits a record high', 'RBI holds rates', 'Mint · Just now', 'RELIANCE']) {
      expect({ s, found: text.includes(s) }).toEqual({ s, found: true });
    }
    for (const gone of ['Global Markets', 'Indian Markets', 'Crypto', 'Forex', 'Economic Calendar', 'Symbols you saved to track']) {
      expect({ gone, found: text.includes(gone) }).toEqual({ gone, found: false });
    }
    // Served from the fresh store, as MarketNews.jsx's module cache does.
    expect(fetchMarketNews).not.toHaveBeenCalled();
  });

  it('"Stocks in news" keeps only the tagged stories', async () => {
    const r = await mount('Explore', ExploreScreen as ComponentType<never>);
    let tab: TestNode | null | undefined = r.root.findAll((n) => n.props.children === 'Stocks in news')[0];
    while (tab && typeof tab.props.onPress !== 'function') tab = tab.parent;
    await act(async () => { (tab?.props.onPress as () => void)(); });
    await settle();
    const text = textOf(r.toJSON());
    expect(text).toContain('Reliance hits a record high');
    expect(text).not.toContain('RBI holds rates');
  });
});
