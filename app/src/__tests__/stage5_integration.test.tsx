/**
 * Stage 5 integration: the Trade terminal is plugged in, /trade resolves
 * with its params, and the screen — mounted for real over a stubbed HTTP
 * layer, so useTradeBook and the wallet hooks all run — draws the book, the
 * equity strip (EquityHub's Trade.jsx equityNums, from the wallet's free
 * balance and the open positions) and the chart bridge, and turns every
 * chart action into the request EquityHub's web sends for it.
 *
 * The chart WebView is a capturing stub: the test reads what the screen
 * injects into it and fires the messages the runtime would post back.
 */
import 'react-native-gesture-handler/jestSetup';
import fs from 'fs';
import path from 'path';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React, { act, type ComponentType } from 'react';
import { AppState, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { InternalAxiosRequestConfig } from 'axios';

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
jest.mock('react-native-webview', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof React;
  const store: { props: Record<string, unknown> | null; injected: string[] } = { props: null, injected: [] };
  (globalThis as unknown as { __mockWeb: typeof store }).__mockWeb = store;
  const WebView = R.forwardRef((props: Record<string, unknown>, ref) => {
    if (props.testID === 'chart-webview') store.props = props;
    R.useImperativeHandle(ref, () => ({ injectJavaScript: (s: string) => { store.injected.push(s); } }));
    return null;
  });
  return { WebView };
});
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(async () => true), shareAsync: jest.fn(async () => {}) }));
jest.mock('expo-file-system', () => ({
  File: jest.fn().mockImplementation(() => ({ create: jest.fn(), write: jest.fn(), text: jest.fn(async () => ''), uri: 'file:///x' })),
  Paths: { cache: 'file:///cache' },
}));
jest.mock('@/store/selectedAccount', () => {
  const { create } = jest.requireActual('zustand');
  const account = {
    id: 'a1', accountNumber: '100200', accountType: 'STANDARD', customTypeName: null, baseCurrency: 'INR', leverage: 5,
    isActive: true, isTradingEnabled: true, nickname: 'Main', group: null, status: 'ACTIVE', createdAt: null, raw: {},
  };
  const useSelectedAccountStore = create(() => ({
    accounts: [account], selectedId: 'a1', loading: false, error: null, userId: 'u1',
    load: jest.fn(async () => {}), select: jest.fn(), reset: jest.fn(),
  }));
  return {
    useSelectedAccountStore,
    selectSelectedAccount: (s: { accounts: unknown[]; selectedId: string | null }) => s.accounts.find((a) => (a as { id: string }).id === s.selectedId) ?? s.accounts[0] ?? null,
  };
});

/* eslint-disable import/first */
import { api } from '@/api/client';
import { resetAccountMetrics } from '@/api/trading.api';
import { useInstrumentStore } from '@/api/instruments.api';
import { ConfirmProvider, PortalHost } from '@/components/ui';
import { toastStore } from '@/components/ui/toast';
import { screenRegistry } from '@/navigation/screenRegistry';
import { APP_SCREENS, GUEST_SCREENS, PUBLIC_SCREENS, type RootStackParamList, type ScreenName } from '@/navigation/types';
import { resolveWebPath } from '@/navigation/webPaths';
import { ComingSoonScreen } from '@/screens/common/ComingSoonScreen';
import { TradeScreen } from '@/screens/trade/TradeScreen';
import { __resetTradeViewForTests } from '@/screens/trade/tradeViewStore';
import { useTradeSettings } from '@/store/tradeSettings';
import { ThemeProvider } from '@/theme';
/* eslint-enable import/first */

// Each test mounts the whole terminal; on a loaded machine that alone can take seconds.
jest.setTimeout(30_000);
// The app is in the foreground, as on a device: the terminal's wallet and
// leverage reads run only while it is (the jest AppState starts unknown).
Object.defineProperty(AppState, 'currentState', { configurable: true, get: () => 'active' });

interface TestNode { type: unknown; props: Record<string, unknown>; parent: TestNode | null; children: (TestNode | string)[]; findAll(pred: (n: TestNode) => boolean): TestNode[] }
interface Renderer { root: TestNode; toJSON(): unknown; unmount(): void }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { create } = require('react-test-renderer') as { create: (el: React.ReactElement) => Renderer };

const web = (): { props: Record<string, unknown> | null; injected: string[] } => (globalThis as unknown as { __mockWeb: { props: Record<string, unknown> | null; injected: string[] } }).__mockWeb;

const textOf = (node: unknown): string => {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return textOf((node as { children?: unknown }).children ?? null);
};
/** The text under one node only (the tree's toJSON() would be the whole screen). */
const nodeText = (node: TestNode | string | undefined): string => {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  return node.children.map(nodeText).join(' ');
};
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

/* ── The server, as far as the terminal asks it ── */

const INSTRUMENT = {
  _id: 'i1', symbol: 'RELIANCE', name: 'Reliance Industries', category: 'STOCK', exchange: 'NSE', segment: 'EQ', lastPrice: '2500.00', bid: '2499.95', ask: '2500.05',
  pricePrecision: 2, quoteCurrency: 'INR', baseCurrency: 'INR', spreadType: 'FIXED', spreadValue: '0.10', minOrderSize: '1', lotSize: 1, tickSize: '0.05', maxLeverage: 5, isActive: true,
};
const POSITION = {
  _id: 'p1', accountId: 'a1', symbol: 'RELIANCE', side: 'BUY', positionSide: 'LONG', status: 'OPEN', quantity: '10', closedQuantity: '0',
  entryPrice: '2450.00', markPrice: '2500.00', leverage: 5, margin: '4900', realizedPnl: '0', unrealizedPnl: '500', commission: '0', swap: '0',
  stopLoss: '2400.00', productType: 'INTRADAY', openedAt: '2026-09-30T04:00:00Z',
};
const ORDER = {
  _id: 'o1', accountId: 'a1', symbol: 'RELIANCE', side: 'BUY', type: 'LIMIT', status: 'PENDING', quantity: '5', filledQuantity: '0', price: '2420.00', leverage: 5, createdAt: '2026-09-30T04:10:00Z',
};
const REJECTED = {
  _id: 'r1', accountId: 'a1', symbol: 'RELIANCE', side: 'SELL', type: 'MARKET', status: 'REJECTED', quantity: '3', filledQuantity: '0', rejectionReason: 'SEGMENT_DISABLED', createdAt: '2026-09-30T04:20:00Z',
};

type Reply = { status?: number; data: unknown };
let calls: InternalAxiosRequestConfig[] = [];
const bodyOf = (c: InternalAxiosRequestConfig): unknown => (typeof c.data === 'string' ? JSON.parse(c.data) : c.data);
const served = (method: string, urlPart: string): InternalAxiosRequestConfig[] =>
  calls.filter((c) => (c.method ?? 'get').toLowerCase() === method && String(c.url).includes(urlPart));

const route = (c: InternalAxiosRequestConfig): Reply => {
  const url = String(c.url);
  const m = (c.method ?? 'get').toLowerCase();
  if (m === 'get') {
    if (url === '/instruments') return { data: { success: true, data: [INSTRUMENT] } };
    if (url.includes('/candles')) return { data: { success: true, data: [] } };
    if (url.includes('/trading/orders/open')) return { data: { success: true, data: [ORDER] } };
    if (url.includes('/trading/orders/history')) return { data: { success: true, data: { items: [REJECTED], pagination: { page: 1, limit: 50, total: 1, pages: 1 } } } };
    if (url.includes('/trading/positions/history')) return { data: { success: true, data: { items: [], pagination: { page: 1, limit: 50, total: 0, pages: 1 } } } };
    if (url.includes('/trading/positions')) return { data: { success: true, data: [POSITION] } };
    if (url.includes('/wallet/balances')) return { data: { success: true, data: [{ accountId: 'a1', currency: 'INR', balance: '100000', locked: '4900', free: '95100' }] } };
    if (url.includes('/user/leverage')) return { data: { success: true, data: { effectiveLeverage: 5 } } };
    return { data: { success: true, data: [] } };
  }
  if (m === 'post' && url.includes('/close-all')) return { data: { success: true, data: { closed: 1, total: 1, failed: [] } } };
  if (m === 'put' && url.includes('/trading/positions/')) return { data: { success: true, data: POSITION } };
  if (m === 'put' && url.includes('/trading/orders/')) return { data: { success: true, data: ORDER } };
  if (m === 'delete') return { data: { success: true, data: { ...ORDER, status: 'CANCELLED' } } };
  return { data: { success: true, data: {} } };
};

beforeEach(() => {
  calls = [];
  api.defaults.adapter = async (config) => {
    calls.push(config);
    const r = route(config);
    return { data: r.data, status: r.status ?? 200, statusText: '', headers: {}, config };
  };
  __resetTradeViewForTests();
  resetAccountMetrics();
  toastStore.setState({ toasts: [] });
  useTradeSettings.getState().reset();
  useInstrumentStore.setState({ rows: [], loadedAt: 0, loading: false, error: null } as never);
  web().props = null;
  web().injected = [];
});

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const Stack = createNativeStackNavigator<RootStackParamList>();
function Stub({ route: r }: { route: { name: string } }): React.JSX.Element { return <Text>{`route:${r.name}`}</Text>; }
let renderer: Renderer | null = null;

const mount = async (params: RootStackParamList['Trade']): Promise<Renderer> => {
  const tree = (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>
        <NavigationContainer initialState={{ index: 0, routes: [{ name: 'Trade', params }] } as never}>
          <PortalHost>
            <ConfirmProvider>
              <Stack.Navigator screenOptions={{ headerShown: false, animation: 'none' }}>
                <Stack.Screen name="Trade" component={TradeScreen as ComponentType} />
                {(['Dashboard', 'Wallet', 'Reports'] as const).map((n) => <Stack.Screen key={n} name={n} component={Stub as ComponentType} />)}
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

/**
 * A RENDERED node with this testID. Host nodes only: a closed BottomSheet
 * still carries its testID prop while drawing nothing (Modal returns null),
 * so matching composites would find sheets that are not open.
 */
const byTestId = (r: Renderer, id: string): TestNode | undefined =>
  r.root.findAll((n) => typeof n.type === 'string' && n.props.testID === id)[0];
const press = async (node: TestNode | undefined): Promise<void> => {
  let n: TestNode | null | undefined = node;
  while (n && typeof n.props.onPress !== 'function') n = n.parent;
  if (!n) throw new Error('nothing pressable');
  await act(async () => { (n?.props.onPress as () => void)(); });
  await settle();
};
const chartSays = async (msg: Record<string, unknown>): Promise<void> => {
  const onMessage = web().props?.onMessage as ((e: { nativeEvent: { data: string } }) => void) | undefined;
  if (!onMessage) throw new Error('chart WebView not mounted');
  await act(async () => { onMessage({ nativeEvent: { data: JSON.stringify(msg) } }); });
  await settle();
};
const injectedOfType = (type: string): Record<string, unknown>[] =>
  web().injected
    .map((s) => /__aatReceive\((".*")\);true;$/.exec(s)?.[1])
    .filter((s): s is string => !!s)
    .map((s) => JSON.parse(JSON.parse(s) as string) as Record<string, unknown>)
    .filter((m) => m.type === type);

/* ── registry + paths ── */

describe('screenRegistry after stage 5', () => {
  it('every route is ported — nothing renders ComingSoon; Trade and Positions are registered', () => {
    const all: ScreenName[] = [...GUEST_SCREENS, ...PUBLIC_SCREENS, ...APP_SCREENS];
    expect(all.filter((n) => (screenRegistry[n] as unknown) === ComingSoonScreen)).toEqual([]);
    expect(screenRegistry.Trade).toBe(TradeScreen);
    expect(all).toContain('Positions');
  });

  it.each([
    ['/trade', { name: 'Trade' }],
    // The path keeps the URL's text, as the web's params.get('symbol') does; the screen upper-cases it.
    ['/trade?symbol=reliance', { name: 'Trade', params: { symbol: 'reliance' } }],
    ['/trade?symbol=NIFTY&view=terminal', { name: 'Trade', params: { symbol: 'NIFTY', view: 'terminal' } }],
  ])('%s', (p, want) => {
    expect(resolveWebPath(p)).toMatchObject(want);
  });
});

/* ── the terminal ── */

describe('the Trade terminal', () => {
  it('draws the top bar, the book with its counts (Rejected included), and Trade.jsx\'s equity figures', async () => {
    // A lower-case link symbol lands on the upper-case instrument.
    const r = await mount({ symbol: 'reliance' });
    const text = textOf(r.toJSON());
    expect(byTestId(r, 'trade-topbar')).toBeDefined();
    expect(byTestId(r, 'trade-tab-RELIANCE')).toBeDefined();
    expect(text).toContain('Open');
    expect(text).toContain('Pending');
    expect(text).toContain('Rejected');
    // equityNums: used = 2450 × 10 / 5 = 4,900; balance = free 95,100 + used;
    // equity = balance + the live P&L (mid 2,500 → +500); free = equity − used.
    const equity = nodeText(byTestId(r, 'equity-bar'));
    expect(equity).toContain('₹1,00,500.00');
    expect(equity).toContain('₹1,00,000.00');
    expect(equity).toContain('₹95,600.00');
    expect(equity).toContain('₹4,900.00');
    expect(equity).toContain('2051.02%');
    // The rejected order, with the server's reason.
    await press(byTestId(r, 'book-tab-rejected'));
    expect(byTestId(r, 'book-rejected-r1')).toBeDefined();
    expect(textOf(r.toJSON())).toContain('SEGMENT_DISABLED');
  });

  it('the chart: init on ready, the book\'s rows as pills', async () => {
    await mount({ symbol: 'RELIANCE' });
    await chartSays({ type: 'ready', version: 1 });
    const init = injectedOfType('init')[0];
    expect(init).toMatchObject({ symbol: 'RELIANCE', name: 'Reliance Industries', precision: 2, chartType: 'candles', timeframe: '1m' });
    const pills = injectedOfType('pills').pop() as { pills: { key: string }[] } | undefined;
    expect(pills?.pills.map((p) => p.key).sort()).toEqual(['order:o1:entry', 'pos:p1:entry', 'pos:p1:sl']);
  });

  it('dragging a stop commits PUT /trading/positions/:id at the instrument\'s precision', async () => {
    await mount({ symbol: 'RELIANCE' });
    await chartSays({ type: 'ready', version: 1 });
    await chartSays({ type: 'pillCommit', key: 'pos:p1:sl', price: 2412.345678 });
    const put = served('put', '/trading/positions/p1');
    expect(put).toHaveLength(1);
    expect(bodyOf(put[0] as InternalAxiosRequestConfig)).toEqual({ stopLoss: '2412.35' });
    expect(toastStore.getState().toasts.map((t) => t.message)).toContain('SL updated to 2412.35');
  });

  it('a new TP from the entry pill, a re-priced LIMIT, a removed SL, a cancelled order', async () => {
    await mount({ symbol: 'RELIANCE' });
    await chartSays({ type: 'ready', version: 1 });
    await chartSays({ type: 'pillCommit', key: 'pos:p1:tp:new', price: 2600 });
    expect(bodyOf(served('put', '/trading/positions/p1').pop() as InternalAxiosRequestConfig)).toEqual({ takeProfit: '2600.00' });
    await chartSays({ type: 'pillCommit', key: 'order:o1:entry', price: 2415.5 });
    expect(bodyOf(served('put', '/trading/orders/o1').pop() as InternalAxiosRequestConfig)).toEqual({ price: '2415.50' });
    await chartSays({ type: 'pillClose', key: 'pos:p1:sl' });
    expect(bodyOf(served('put', '/trading/positions/p1').pop() as InternalAxiosRequestConfig)).toEqual({ stopLoss: null });
    await chartSays({ type: 'pillClose', key: 'order:o1:entry' });
    expect(served('delete', '/trading/orders/o1')).toHaveLength(1);
  });

  it('a live drag of a position level is sent silently; the order-form preview never reaches the server', async () => {
    await mount({ symbol: 'RELIANCE' });
    await chartSays({ type: 'ready', version: 1 });
    const before = calls.length;
    await chartSays({ type: 'pillCommit', key: 'pos:p1:sl', price: 2410, live: true });
    expect(served('put', '/trading/positions/p1')).toHaveLength(1);
    expect(toastStore.getState().toasts).toEqual([]);
    await chartSays({ type: 'pillCommit', key: 'preview:order:entry', price: 2440 });
    await chartSays({ type: 'pillClose', key: 'preview:order:sl' });
    expect(calls.slice(before).filter((c) => (c.method ?? '').toLowerCase() !== 'get')).toHaveLength(1);
  });

  it('tapping a pill opens the SL / TP editor for that position', async () => {
    const r = await mount({ symbol: 'RELIANCE' });
    await chartSays({ type: 'ready', version: 1 });
    await chartSays({ type: 'pillTap', key: 'pos:p1:entry' });
    expect(byTestId(r, 'position-sltp-modal')).toBeDefined();
  });

  it('Close All confirms, then closes this account\'s positions', async () => {
    const r = await mount({ symbol: 'RELIANCE' });
    await press(byTestId(r, 'book-close-all'));
    // Nothing leaves before the trader confirms.
    expect(served('post', '/trading/positions/close-all')).toHaveLength(0);
    const confirmBtn = r.root.findAll((n) => n.props.children === 'Close all' && typeof n.props.onPress !== 'undefined')[0]
      ?? r.root.findAll((n) => n.props.children === 'Close all')[0];
    expect(confirmBtn).toBeDefined();
    await press(confirmBtn);
    const post = served('post', '/trading/positions/close-all');
    expect(post).toHaveLength(1);
    expect(bodyOf(post[0] as InternalAxiosRequestConfig)).toEqual({ accountId: 'a1' });
  });

  it('Place Order opens the order ticket; fullscreen hides the terminal chrome', async () => {
    const r = await mount({ symbol: 'RELIANCE' });
    await press(byTestId(r, 'place-order-fab'));
    expect(byTestId(r, 'trade-order-sheet')).toBeDefined();
    expect(byTestId(r, 'order-volume')).toBeDefined();
    await act(async () => { renderer?.unmount(); });
    renderer = null;
    const f = await mount({ symbol: 'RELIANCE', view: 'terminal' });
    expect(byTestId(f, 'trade-topbar')).toBeUndefined();
    expect(byTestId(f, 'trade-book')).toBeUndefined();
  });

  describe('the chart\'s Buy / Sell chip (Trade.jsx:1713-1745)', () => {
    const TRADE = fs.readFileSync(path.join(__dirname, '../../../client/src/pages/Trade.jsx'), 'utf8').replace(/\r\n/g, '\n');
    const between = (src: string, start: string, end: string): string => {
      const a = src.indexOf(start);
      if (a < 0) throw new Error(`slice start moved: ${start}`);
      const b = src.indexOf(end, a + start.length);
      if (b < 0) throw new Error(`slice end moved: ${end}`);
      return src.slice(a + start.length, b);
    };
    // The keys of the web's one-click body, read from its source.
    const oneClick = between(TRADE, 'const placeOneClickOrder = useCallback(async (side) => {', '}, [account, instrument]);');
    const WEB_KEYS = [...between(oneClick, "api.post('/trading/orders', {", '});').matchAll(/^\s*(\w+)\s*[,:]/gm)].map((m) => m[1]);

    it('one-click on: a market order with exactly the web\'s body — min size, the account\'s leverage', async () => {
      expect(WEB_KEYS).toEqual(['accountId', 'symbol', 'side', 'orderMode', 'quantity', 'leverage', 'idempotencyKey']);
      useTradeSettings.getState().set('trading.openOrderMode', 'oneClick');
      const r = await mount({ symbol: 'RELIANCE' });
      await press(byTestId(r, 'quick-buy'));
      const post = served('post', '/trading/orders');
      expect(post).toHaveLength(1);
      const body = bodyOf(post[0] as InternalAxiosRequestConfig) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([...WEB_KEYS].sort());
      expect(body).toMatchObject({ accountId: 'a1', symbol: 'RELIANCE', side: 'BUY', orderMode: 'MARKET', quantity: '1', leverage: 5 });
      expect(typeof body.idempotencyKey).toBe('string');
      expect(byTestId(r, 'trade-order-sheet')).toBeUndefined();
    });

    it('one-click off: the chip opens the ticket and sends nothing', async () => {
      const r = await mount({ symbol: 'RELIANCE' });
      await press(byTestId(r, 'quick-sell'));
      expect(served('post', '/trading/orders')).toHaveLength(0);
      expect(byTestId(r, 'trade-order-sheet')).toBeDefined();
    });

    it('fullscreen never fires from the chip, even with one-click on', async () => {
      useTradeSettings.getState().set('trading.openOrderMode', 'oneClick');
      const r = await mount({ symbol: 'RELIANCE', view: 'terminal' });
      await press(byTestId(r, 'quick-buy'));
      expect(served('post', '/trading/orders')).toHaveLength(0);
      expect(byTestId(r, 'trade-order-sheet')).toBeDefined();
    });
  });

  it('the side panels open on positions and switch to depth', async () => {
    // NSE depth is shown only while the market is open. Pin the clock to a
    // Wednesday 11:30 IST (only Date is faked — the test's own timers run) so
    // the test does not fail outside market hours.
    jest.useFakeTimers({
      now: new Date('2026-09-30T06:00:00Z'),
      doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'nextTick', 'hrtime', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback'],
    });
    try {
    const r = await mount({ symbol: 'RELIANCE' });
    await press(byTestId(r, 'open-panels'));
    expect(byTestId(r, 'panel-positions')).toBeDefined();
    await press(byTestId(r, 'panel-tab-depth'));
    expect(byTestId(r, 'panel-depth')).toBeDefined();
    expect(textOf(r.toJSON())).toContain('LIVE TOP-OF-BOOK · NO DEPTH FROM THIS FEED');
    } finally {
      jest.useRealTimers();
    }
  });
});
