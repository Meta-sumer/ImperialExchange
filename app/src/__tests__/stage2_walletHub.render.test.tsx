/**
 * Render tests for the Wallet hub: WalletScreen mounted in a real native
 * stack, with the REAL api modules talking to a scripted axios adapter (so
 * every request the screen makes is recorded), and in-memory stand-ins for
 * the auth store, the account store, the socket, the file system, sharing
 * and the clipboard. The money-flow views (another area's files) are stubs
 * that expose their onDone / onCancel.
 *
 * Covers what pure logic cannot: which view is on screen, which calls went
 * out with what, where a tap goes, and what the live refresh re-fetches.
 * No network, no device.
 */
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import React, { act, type ComponentType } from 'react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});

jest.mock('@/websocket/ws', () => {
  const listeners = new Map<string, Set<(d: unknown) => void>>();
  return {
    wsClient: {
      subscribe: (ch: string, cb: (d: unknown) => void) => {
        if (!listeners.has(ch)) listeners.set(ch, new Set());
        listeners.get(ch)!.add(cb);
        return () => { listeners.get(ch)?.delete(cb); };
      },
      mockEmit: (ch: string, data: unknown) => { for (const cb of [...(listeners.get(ch) ?? [])]) cb(data); },
      mockChannels: () => [...listeners.entries()].filter(([, s]) => s.size > 0).map(([k]) => k),
      getState: () => 'live',
      onStateChange: () => () => {},
      connect: () => {},
      disconnect: () => {},
    },
  };
});

jest.mock('@/store/auth', () => {
  const { create } = jest.requireActual('zustand');
  const useAuthStore = create(() => ({
    user: {
      id: 'u1',
      email: 'ravi@example.com',
      firstName: 'Ravi',
      lastName: 'Kumar',
      name: 'Ravi Kumar',
      role: 'USER',
      phone: '+91 98765 43210',
      kycStatus: 'APPROVED',
      twoFactorEnabled: true,
      raw: {},
    },
    status: 'authenticated',
    error: null,
  }));
  return { useAuthStore };
});

jest.mock('@/store/selectedAccount', () => {
  const { create } = jest.requireActual('zustand');
  const useSelectedAccountStore = create(() => ({
    accounts: [],
    selectedId: null,
    loading: false,
    error: null,
    load: jest.fn(async () => {}),
    select: () => {},
    reset: () => {},
  }));
  return { useSelectedAccountStore };
});

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

const mockWritten: { uri: string; content: string }[] = [];
jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' },
  File: class {
    uri: string;

    constructor(dir: string, name: string) { this.uri = `${dir}/${name}`; }

    create() { /* created */ }

    write(content: string) { mockWritten.push({ uri: this.uri, content }); }
  },
}));
const mockShared: string[] = [];
jest.mock('expo-sharing', () => ({
  isAvailableAsync: async () => true,
  shareAsync: async (uri: string) => { mockShared.push(uri); },
}));

/* The money-flow views belong to another area; stubs expose their callbacks.
   A function DECLARATION, so it is hoisted above the (hoisted) jest.mock calls. */
function mockStubView(name: string): (p: { onDone?: () => void; onCancel?: () => void }) => React.ReactElement {
  const R = jest.requireActual('react') as typeof React;
  const { Text: T, Pressable } = jest.requireActual('react-native') as typeof import('react-native');
  return ({ onDone, onCancel }) =>
    R.createElement(R.Fragment, null,
      R.createElement(T, null, `${name}-stub`),
      onDone ? R.createElement(Pressable, { onPress: onDone, accessibilityLabel: `${name} done` }, R.createElement(T, null, 'stub-done')) : null,
      onCancel ? R.createElement(Pressable, { onPress: onCancel, accessibilityLabel: `${name} cancel` }, R.createElement(T, null, 'stub-cancel')) : null);
}
jest.mock('@/screens/wallet/views/DepositView', () => ({ DepositView: mockStubView('DepositView') }));
jest.mock('@/screens/wallet/views/WithdrawView', () => ({ WithdrawView: mockStubView('WithdrawView') }));
jest.mock('@/screens/wallet/views/TransferView', () => ({ TransferView: mockStubView('TransferView') }));
/* Wallet → Withdrawal Methods opens the manager as a modal (EquityHub's openMethods). */
function mockStubModal(name: string): (p: { open: boolean; onClose: () => void }) => React.ReactElement | null {
  const R = jest.requireActual('react') as typeof React;
  const { Text: T, Pressable } = jest.requireActual('react-native') as typeof import('react-native');
  return ({ open, onClose }) => (open
    ? R.createElement(R.Fragment, null,
      R.createElement(T, null, `${name}-open`),
      R.createElement(Pressable, { onPress: onClose, accessibilityLabel: `${name}-close` }, R.createElement(T, null, 'close')))
    : null);
}
jest.mock('@/components/wallet/WithdrawalMethods', () => ({ WithdrawalMethodsModal: mockStubModal('WithdrawalMethodsModal') }));

/* eslint-disable import/first */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { api } from '@/api/client';
import { resetAccountMetrics } from '@/api/trading.api';
import { toastStore } from '@/components/ui/toast';
import type { RootStackParamList, ScreenName } from '@/navigation/types';
import { WalletScreen } from '@/screens/wallet/WalletScreen';
import { useSelectedAccountStore } from '@/store/selectedAccount';
import { ThemeProvider } from '@/theme';
import { toUserAccount } from '@/types/user';
import { notesStorageKey } from '@/utils/walletLogic';
import { wsClient } from '@/websocket/ws';
/* eslint-enable import/first */

// These mount a whole navigator and wait on real timers (debounces, delayed
// answers). Other suites run beside them and can starve the CPU; jest's 5s
// default then times a test out mid-way and its continuation trips over the
// renderer afterEach has already unmounted.
jest.setTimeout(30_000);

// react-test-renderer ships without types here; this is the slice used.
interface TestNode {
  type: unknown;
  props: Record<string, unknown>;
  parent: TestNode | null;
  findAll(pred: (n: TestNode) => boolean): TestNode[];
}
interface Renderer { root: TestNode; toJSON(): unknown; unmount(): void }
// eslint-disable-next-line @typescript-eslint/no-require-imports
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
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
};
const wait = async (ms: number): Promise<void> => {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  await settle();
};

const ws = wsClient as unknown as { mockEmit: (ch: string, d: unknown) => void; mockChannels: () => string[] };
const toasts = (): string[] => toastStore.getState().toasts.map((t) => `${t.type}:${t.message}`);

/* ── The scripted server ──────────────────────────────────────────────── */

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number, hour = 9): string => {
  const d = new Date(Date.now() - days * DAY);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

const RAW_ACCOUNTS = [
  { _id: 'acc1', accountNumber: '100234', accountType: 'STANDARD', baseCurrency: 'INR', leverage: 100 },
  { _id: 'acc2', accountNumber: '100777', accountType: 'PRO', baseCurrency: 'INR', leverage: 200, nickname: 'Swing', planSuspendedAt: '2026-09-01T00:00:00Z' },
  { _id: 'acc3', accountNumber: '900001', accountType: 'DEMO', baseCurrency: 'INR', leverage: 500, nickname: 'Practice' },
];

const LEDGER = [
  { _id: '64cccccccccccccccccccc01', accountId: 'acc1', type: 'TRADE_OPEN', amount: '-3.2', currency: 'INR', note: 'Margin for RELIANCE', createdAt: ago(0, 8) },
  { _id: '64cccccccccccccccccccc02', accountId: 'acc1', type: 'INTERNAL_TRANSFER_OUT', amount: '-20', currency: 'INR', counterparty: { userId: 'u9', name: 'Asha Rao' }, createdAt: ago(3) },
  ...Array.from({ length: 20 }, (_, i) => ({
    _id: `64dddddddddddddddddddd${String(i).padStart(2, '0')}`, accountId: 'acc2', type: 'FEE', amount: '-0.5', currency: 'INR', createdAt: ago(10 + i),
  })),
];

/** A per-account read gets that account's rows only, as the server filters them. */
const forAccount = <T extends { accountId: string }>(c: InternalAxiosRequestConfig, rows: T[]): T[] => {
  const id = (c.params as Record<string, unknown> | undefined)?.accountId;
  return id ? rows.filter((r) => r.accountId === id) : rows;
};

const SERVER: Record<string, (c: InternalAxiosRequestConfig) => unknown> = {
  // Credit transactions (deposits / withdrawals on credit): none in these fixtures.
  '/wallet/credit': () => ({ items: [], summary: { outstandingReceivable: '0', outstandingPayable: '0', pendingCount: 0 } }),
  // Per-account reads (`?accountId=`) feed the account figures (fetchAccountMetrics).
  '/wallet/balances': (c) => forAccount(c, [
    { _id: 'w1', accountId: 'acc1', currency: 'INR', balance: '1000', locked: '200', free: '800' },
    { _id: 'w2', accountId: 'acc2', currency: 'INR', balance: '500', locked: '0', free: '500' },
    { _id: 'w3', accountId: 'acc3', currency: 'INR', balance: '100000', locked: '0', free: '100000' },
  ]),
  '/wallet/deposits': () => [
    { _id: '64aaaaaaaaaaaaaaaaaaaa01', accountId: 'acc1', method: 'BANK', amount: '100', currency: 'INR', status: 'CONFIRMED', note: 'Salary top-up', createdAt: ago(1) },
    { _id: '64aaaaaaaaaaaaaaaaaaaa02', accountId: 'acc1', method: 'UPI', senderUpiId: 'ravi@okhdfc', amount: '8800', currency: 'INR', status: 'PENDING', createdAt: ago(2) },
  ],
  '/wallet/withdrawals': () => [
    { _id: '64bbbbbbbbbbbbbbbbbbbb01', accountId: 'acc1', method: 'BANK', destination: 'HDFC ••1234', amount: '25', currency: 'INR', status: 'PENDING', createdAt: ago(0, 7) },
  ],
  '/wallet/ledger': () => LEDGER,
  // Wallet.jsx load(): the Main and Bonus ledgers feed Transaction History.
  '/subscriptions/history': () => [],
  '/bonus-wallet/history': () => [],
  // acc1: 1000 balance + 100 floating = 1100 equity on 200 margin (550%).
  '/trading/positions': (c) => forAccount(c, [
    { _id: 'p1', accountId: 'acc1', symbol: 'RELIANCE', side: 'BUY', quantity: '1', entryPrice: '2900', margin: '150', unrealizedPnl: '105', status: 'OPEN' },
    { _id: 'p2', accountId: 'acc1', symbol: 'TCS', side: 'SELL', quantity: '1', entryPrice: '4100', margin: '50', unrealizedPnl: '-5', status: 'OPEN' },
  ]),
  '/trading/positions/history': () => ({ items: [], summary: { totalTrades: 9, totalLot: 3, netPnl: 20, wins: 6, losses: 3 }, pagination: {} }),
  '/user/dashboard': () => ({ pnl: { winRate: 62.5 }, trades: { totalLive: 9 } }),
  '/user/dashboard/lifetime-stats': (c) => ({ netProfit: String((c.params as Record<string, string>).days === '7' ? '12.5' : '40') }),
  '/user/dashboard/monthly-series': () => ({ grain: 'day', range: '1m', buckets: [
    { key: 'a', label: 'Sep 1', netProfit: 10, equity: 10 },
    { key: 'b', label: 'Sep 2', netProfit: -4, equity: 6 },
    { key: 'c', label: 'Sep 3', netProfit: 14, equity: 20 },
  ] }),
  '/partner/volume-dashboard': () => ({ totalCommissionEarned: '99', paidCommission: '15', monthlyCommission: '7', walletCurrency: 'INR' }),
  '/bonus-wallet': () => ({ _id: 'bw', balance: '40', currency: 'INR', totalEarnings: '120' }),
};

interface Call { method: string; url: string; params: Record<string, unknown>; body: unknown }
let calls: Call[] = [];
let failing = new Set<string>();
/**
 * One-shot scripted answers, per URL, consumed in request order: each may be
 * delayed, so two overlapping loads can be made to answer out of order.
 */
let scripted: Record<string, { delay: number; data: unknown }[]> = {};
let patchReply: { status: number; data: unknown } = { status: 200, data: { success: true, data: { _id: 'acc1', nickname: 'Swing Book' } } };

beforeAll(() => {
  api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const call: Call = {
      method: String(config.method ?? 'get').toUpperCase(),
      url: config.url ?? '',
      params: (config.params as Record<string, unknown> | undefined) ?? {},
      body: typeof config.data === 'string' ? JSON.parse(config.data) : config.data,
    };
    calls.push(call);
    const respond = (status: number, data: unknown) => {
      const response = { data, status, statusText: '', headers: {}, config };
      if (status >= 400) throw new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, null, response);
      return response;
    };
    const script = scripted[call.url]?.shift();
    if (script) {
      if (script.delay > 0) await new Promise((r) => setTimeout(r, script.delay));
      return respond(200, { success: true, data: script.data });
    }
    const perAccount = call.params.accountId !== undefined;
    if (failing.has(call.url) || (perAccount && failing.has(`${call.url}?accountId`))) {
      return respond(500, { success: false, error: { message: `${call.url} is down` } });
    }
    if (call.method === 'PATCH') return respond(patchReply.status, patchReply.data);
    const handler = SERVER[call.url];
    if (!handler) return respond(404, { success: false, error: { message: `no route ${call.url}` } });
    return respond(200, { success: true, data: handler(config) });
  };
});

/** Page-level reads only: the per-account figure reads carry `accountId`. */
const count = (url: string, method = 'GET'): number =>
  calls.filter((c) => c.url === url && c.method === method && c.params.accountId === undefined).length;

/* ── Mounting ─────────────────────────────────────────────────────────── */

const METRICS_FRAME = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const Stack = createNativeStackNavigator<RootStackParamList>();
const navRef = createNavigationContainerRef<RootStackParamList>();

function Stub({ route }: { route: { name: string; params?: object } }): React.JSX.Element {
  return <Text>{`route:${route.name}:${JSON.stringify(route.params ?? {})}`}</Text>;
}

const OTHERS: ScreenName[] = ['BonusWallet', 'Helpdesk', 'NewAccountTiers', 'Profile', 'Plans'];

let renderer: Renderer | null = null;

const mount = async (params?: RootStackParamList['Wallet']): Promise<Renderer> => {
  await act(async () => {
    renderer = create(
      <SafeAreaProvider initialMetrics={METRICS_FRAME}>
        <ThemeProvider>
          <NavigationContainer ref={navRef} initialState={{ index: 0, routes: [{ name: 'Wallet', params }] } as never}>
            <Stack.Navigator screenOptions={{ headerShown: false, animation: 'none' }}>
              <Stack.Screen name="Wallet" component={WalletScreen as ComponentType} />
              {OTHERS.map((n) => <Stack.Screen key={n} name={n} component={Stub as ComponentType} />)}
            </Stack.Navigator>
          </NavigationContainer>
        </ThemeProvider>
      </SafeAreaProvider>,
    );
  });
  await settle();
  return renderer as unknown as Renderer;
};

const text = (r: Renderer): string => textOf(r.toJSON());

/** The nearest pressable around the text node that reads exactly `t`. */
const byText = (r: Renderer, t: string, index = 0): TestNode | undefined => {
  let n: TestNode | null | undefined = r.root.findAll((x) => x.props.children === t)[index];
  while (n && typeof n.props.onPress !== 'function') n = n.parent;
  return n ?? undefined;
};
const byLabel = (r: Renderer, label: string, index = 0): TestNode | undefined =>
  r.root.findAll((x) => x.props.accessibilityLabel === label && (typeof x.props.onPress === 'function' || typeof x.props.onChangeText === 'function'))[index];

const press = async (node: TestNode | undefined): Promise<void> => {
  if (!node) throw new Error('node not found');
  await act(async () => { (node.props.onPress as () => void)(); });
  await settle();
};
const type = async (node: TestNode | undefined, value: string): Promise<void> => {
  if (!node) throw new Error('input not found');
  await act(async () => { (node.props.onChangeText as (s: string) => void)(value); });
  await settle();
};
const submit = async (node: TestNode | undefined): Promise<void> => {
  if (!node) throw new Error('input not found');
  await act(async () => { (node.props.onSubmitEditing as () => void)(); });
  await settle();
};

const accountStore = (): { load: jest.Mock } => useSelectedAccountStore.getState() as unknown as { load: jest.Mock };

beforeEach(async () => {
  calls = [];
  failing = new Set();
  scripted = {};
  patchReply = { status: 200, data: { success: true, data: { _id: 'acc1', nickname: 'Swing Book' } } };
  mockWritten.length = 0;
  mockShared.length = 0;
  (Clipboard.setStringAsync as jest.Mock).mockClear();
  accountStore().load.mockClear();
  useSelectedAccountStore.setState({ accounts: RAW_ACCOUNTS.map(toUserAccount), loading: false, error: null } as never);
  toastStore.setState({ toasts: [] });
  resetAccountMetrics();
  await AsyncStorage.clear();
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = null;
});

/* ══ Overview ══════════════════════════════════════════════════════════ */

describe('WalletScreen — the overview (landing view)', () => {
  it('loads every source the web loads, and the account list from the shared store', async () => {
    await mount();
    for (const url of ['/wallet/balances', '/wallet/deposits', '/wallet/withdrawals', '/wallet/ledger', '/trading/positions']) {
      expect(count(url)).toBeGreaterThanOrEqual(1);
    }
    expect(calls.find((c) => c.url === '/wallet/ledger')?.params).toEqual({ limit: 100 });
    expect(calls.some((c) => c.url === '/trading/positions' && Object.keys(c.params).length === 0)).toBe(true);
    expect(accountStore().load).toHaveBeenCalled();
    for (const url of ['/bonus-wallet', '/partner/volume-dashboard', '/user/dashboard', '/trading/positions/history', '/user/dashboard/monthly-series']) {
      expect(count(url)).toBeGreaterThanOrEqual(1);
    }
    // The Main Wallet is retired: nothing reads it.
    expect(count('/subscription-wallet')).toBe(0);
    expect(calls.filter((c) => c.url === '/user/dashboard/lifetime-stats').map((c) => c.params.days).sort()).toEqual(['30', '365', '7']);
  });

  it('asks the server for the LIVE accounts’ figures only, and shows them', async () => {
    const r = await mount();
    // EquityHub has no metrics route: each live account's balances and positions are read.
    for (const url of ['/wallet/balances', '/trading/positions']) {
      const ids = new Set(calls.filter((c) => c.url === url && c.params.accountId !== undefined).map((c) => c.params.accountId));
      expect([...ids].sort()).toEqual(['acc1', 'acc2']);
    }

    const s = text(r);
    expect(s).toContain('Account Overview');
    expect(s).toContain('Manage your funds, view balance and wallet history');
    // 40 Bonus Wallet + (1100 + 500) live equity; the demo account's 100,000 is not in it.
    expect(s).toContain('₹1,640.00');
    expect(s).toContain('₹1,600.00');
    expect(s).toContain('₹40.00');
    expect(s).toContain('Main Wallet');
    expect(s).toContain('Available Balance · plans are billed from here');
    expect(s).not.toContain('Old Main Wallet');
    expect(s).not.toContain('Referral / IB Wallet');
    expect(s).toContain('Overall Trading Summary');
    expect(s).toContain('₹1,400.00'); // free margin
    expect(s).toContain('₹200.00'); // used margin
    expect(s).toContain('550.00%');
    expect(s).toContain('● Safe');
    expect(s).toContain('+₹100.00'); // today's P&L
    expect(s).toContain('1 Winning · 1 Losing');
    expect(s).toContain('62.50%');
    expect(s).toContain('6 Wins · 3 Losses');
    expect(s).toContain('₹120.00'); // lifetime earnings (main wallet)
    expect(s).toContain('₹15.00');
    expect(s).toContain('+₹20.00'); // performance: 10 - 4 + 14
    expect(s).toContain('+₹12.50'); // this week
    expect(s).toContain('100234');
    expect(s).toContain('100777');
    expect(s).not.toContain('900001');
    expect(s).toContain('Recent Wallet Transactions');
    // Rupees, as they are — no conversion anywhere.
    expect(s).toContain('+₹8,800.00');
    // No strip or support line on the overview (Wallet.jsx:432).
    expect(s).not.toContain('Need help?');
  });

  it('keeps each live account’s figures live, and releases them on the way out', async () => {
    await mount();
    // The figures are re-read on the user-wide wallet and position events.
    expect(ws.mockChannels()).toEqual(expect.arrayContaining(['user:wallet', 'user:positions']));
    await act(async () => { renderer?.unmount(); });
    renderer = null;
    expect(ws.mockChannels()).not.toContain('user:positions');
  });

  it('header buttons and "View All Accounts" switch views; the wallet cards open their pages', async () => {
    const r = await mount();
    await press(byText(r, 'Withdraw'));
    expect(text(r)).toContain('WithdrawView-stub');
    await press(byLabel(r, 'Account Overview'));
    await press(byText(r, 'View All Accounts →'));
    expect(text(r)).toContain('Profile, trading accounts, KYC status, and security settings.');
    await press(byLabel(r, 'Account Overview'));
    await press(byText(r, 'Add Funds'));
    expect(text(r)).toContain('route:BonusWallet');
  });
});

/* ══ Rail, strip, deep links ═══════════════════════════════════════════ */

describe('WalletScreen — the rail, the strip and deep links', () => {
  it('the strip and support line sit under every view but the overview; no "View All" on the history', async () => {
    const r = await mount();
    await press(byLabel(r, 'Account Details'));
    let s = text(r);
    expect(s).toContain('Recent Transactions');
    expect(s).toContain('Need help?');
    expect(s).toContain('support@tradepro.com');
    expect(s).toContain('Deposit');
    expect(byText(r, 'View All')).toBeDefined();

    await press(byText(r, 'View All'));
    s = text(r);
    expect(s).toContain('View and manage all your transactions in one place.');
    expect(byText(r, 'View All')).toBeUndefined();
  });

  it('the Main Wallet is a page (and the rail has no Main Wallet); Live chat opens the helpdesk', async () => {
    const r = await mount();
    expect(byLabel(r, 'Old Main Wallet')).toBeUndefined();
    await press(byLabel(r, 'Main Wallet'));
    expect(text(r)).toContain('route:BonusWallet');
    await act(async () => { navRef.goBack(); });
    await settle();
    await press(byLabel(r, 'Internal Transfer'));
    await press(byText(r, 'Live chat'));
    expect(text(r)).toContain('route:Helpdesk');
  });

  it.each([
    ['deposit', 'DepositView-stub'],
    ['withdraw', 'WithdrawView-stub'],
    ['transfer', 'TransferView-stub'],
  ] as const)('?action=%s opens that view once, and clears the param', async (action, stub) => {
    const r = await mount({ action });
    expect(text(r)).toContain(stub);
    expect(navRef.getCurrentRoute()?.params).toMatchObject({ action: undefined });
  });

  it('?view= (the web’s sidebar link) is honoured', async () => {
    const r = await mount({ view: 'withdrawal-methods' });
    // Withdrawal Methods is the manager, opened over the page it was asked from.
    expect(text(r)).toContain('WithdrawalMethodsModal-open');
    await press(byLabel(r, 'WithdrawalMethodsModal-close'));
    expect(text(r)).not.toContain('WithdrawalMethodsModal-open');
  });

  it('a finished deposit reloads the page and returns to the overview; cancel just returns', async () => {
    const r = await mount({ action: 'deposit' });
    const before = count('/wallet/balances');
    await press(byLabel(r, 'DepositView done'));
    expect(count('/wallet/balances')).toBeGreaterThan(before);
    expect(text(r)).toContain('Manage your funds, view balance and wallet history');

    await press(byLabel(r, 'Deposit Funds'));
    const again = count('/wallet/balances');
    await press(byLabel(r, 'DepositView cancel'));
    expect(text(r)).toContain('Manage your funds, view balance and wallet history');
    expect(count('/wallet/balances')).toBe(again);
  });
});

/* ══ Live refresh ══════════════════════════════════════════════════════ */

describe('WalletScreen — live', () => {
  it('a user:wallet event re-fetches the page (debounced), without re-asking the store', async () => {
    await mount();
    const before = count('/wallet/balances');
    accountStore().load.mockClear();
    await act(async () => {
      ws.mockEmit('user:wallet', { event: 'UPDATED' });
      ws.mockEmit('user:positions', { event: 'UPDATED' });
    });
    await wait(400);
    expect(count('/wallet/balances')).toBe(before + 1);
    expect(accountStore().load).not.toHaveBeenCalled();
  });

  it('subscribes to the held symbols and re-reads positions on a tick', async () => {
    await mount();
    expect(ws.mockChannels()).toEqual(expect.arrayContaining(['ticker:RELIANCE', 'ticker:TCS']));
    const before = count('/trading/positions');
    await act(async () => { ws.mockEmit('ticker:RELIANCE', { symbol: 'RELIANCE', lastPrice: 1.2 }); });
    await wait(20);
    expect(count('/trading/positions')).toBe(before + 1);
  });

  it('a failed source says so instead of reading as "nothing", with a retry', async () => {
    failing = new Set(['/wallet/deposits']);
    const r = await mount({ view: 'history' });
    expect(text(r)).toContain('Some wallet data could not be loaded');
    expect(text(r)).toContain('/wallet/deposits is down');
    failing = new Set();
    await press(byText(r, 'Retry'));
    expect(text(r)).not.toContain('Some wallet data could not be loaded');
  });
});

/* ══ Account Details ═══════════════════════════════════════════════════ */

describe('Account Details', () => {
  it('shows the profile, every account (suspended flagged) and the security summary', async () => {
    const r = await mount({ view: 'details' });
    const s = text(r);
    expect(s).toContain('Profile, trading accounts, KYC status, and security settings.');
    expect(s).toContain('Ravi Kumar');
    expect(s).toContain('KYC · Verified');
    expect(s).toContain('(3)');
    expect(s).toContain('Live · Real');
    expect(s).toContain('DEMO');
    expect(s).toContain('Suspended');
    expect(s).toContain('Over plan limit. Trading paused; you can still withdraw funds and view the last 3 months of history.');
    expect(s).toContain('₹1,000.00');
    expect(s).toContain('₹1,00,000.00');
    expect(s).toContain('Standard');
    expect(s).toContain('1:200');
    expect(s).toContain('Enabled');
    expect(s).toContain('Login alerts');
    expect(s).toContain('+91 98765 43210');
    await press(byText(r, 'Upgrade plan'));
    expect(text(r)).toContain('route:Plans');
  });

  it('rename: refuses an empty name without a request, then PATCHes the normalised one', async () => {
    const r = await mount({ view: 'details' });
    await press(byLabel(r, 'Rename account'));
    const input = byLabel(r, 'Account name');
    expect(input?.props.value).toBe('100234');
    await type(input, '   ');
    await press(byLabel(r, 'Save name'));
    expect(toasts()).toContain('error:Nickname cannot be empty');
    expect(count('/user/accounts/acc1', 'PATCH')).toBe(0);

    await type(byLabel(r, 'Account name'), '  Swing    Book ');
    await press(byLabel(r, 'Save name'));
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toBe('/user/accounts/acc1');
    expect(patch?.body).toEqual({ nickname: 'Swing Book' });
    expect(toasts()).toContain('success:Account renamed');
    expect(accountStore().load).toHaveBeenCalled();
    expect(text(r)).toContain('Swing Book');
  });

  it('rename: the server’s refusal is shown and the editor stays open', async () => {
    patchReply = { status: 400, data: { success: false, error: { message: 'Nickname must be 40 characters or fewer' } } };
    const r = await mount({ view: 'details' });
    await press(byLabel(r, 'Rename account'));
    await type(byLabel(r, 'Account name'), 'Fine name');
    await press(byLabel(r, 'Save name'));
    expect(toasts()).toContain('error:Nickname must be 40 characters or fewer');
    expect(byLabel(r, 'Account name')).toBeDefined();
    await press(byLabel(r, 'Cancel'));
    expect(byLabel(r, 'Account name')).toBeUndefined();
  });

  it('a failed account load is not "No accounts yet"', async () => {
    useSelectedAccountStore.setState({ accounts: [], loading: false, error: 'Network Error' } as never);
    const r = await mount({ view: 'details' });
    expect(text(r)).toContain('Couldn’t load your accounts');
    expect(text(r)).not.toContain('No accounts yet');
    accountStore().load.mockClear();
    await press(byText(r, 'Retry'));
    expect(accountStore().load).toHaveBeenCalled();
  });

  it('while the list is loading there is no "No accounts yet" either; an empty list offers to create one', async () => {
    useSelectedAccountStore.setState({ accounts: [], loading: true, error: null } as never);
    let r = await mount({ view: 'details' });
    expect(text(r)).not.toContain('No accounts yet');
    await act(async () => { renderer?.unmount(); });

    useSelectedAccountStore.setState({ accounts: [], loading: false, error: null } as never);
    r = await mount({ view: 'details' });
    expect(text(r)).toContain('No accounts yet');
    await press(byText(r, '+ Create Account'));
    expect(text(r)).toContain('route:NewAccountTiers');
  });
});

/* ══ Transaction History ═══════════════════════════════════════════════ */

describe('Transaction History', () => {
  const TOTAL = 2 + 1 + LEDGER.length; // deposits + withdrawals + ledger rows

  it('pages the unified list', async () => {
    const r = await mount({ view: 'history' });
    expect(text(r)).toContain(`Showing 1 to 15 of ${TOTAL} entries`);
    await press(byLabel(r, 'Next page'));
    expect(text(r)).toContain(`Showing 16 to ${TOTAL} of ${TOTAL} entries`);
    await press(byLabel(r, 'Page 1'));
    expect(text(r)).toContain(`Showing 1 to 15 of ${TOTAL} entries`);
  });

  it('filters by search, account, status and date', async () => {
    const r = await mount({ view: 'history' });
    await type(byLabel(r, 'Search transactions'), 'salary');
    expect(text(r)).toContain('Showing 1 to 1 of 1 entries');
    await type(byLabel(r, 'Search transactions'), '');

    await press(byLabel(r, 'Accounts: All Accounts'));
    expect(text(r)).toContain('Select Account');
    await press(byText(r, 'Swing'));
    expect(text(r)).toContain('Showing 1 to 15 of 20 entries');
    await press(byLabel(r, 'Accounts: Swing'));
    await press(byText(r, 'All Accounts'));

    await press(byLabel(r, 'Status: All Selected (9)'));
    await press(byLabel(r, 'Select All'));
    expect(text(r)).toContain('No transactions match your filters');
    await press(byLabel(r, 'PENDING'));
    expect(text(r)).toContain('Showing 1 to 2 of 2 entries');
    await press(byLabel(r, 'Select All'));

    await press(byLabel(r, 'Date Range: All Time'));
    await press(byText(r, 'Today'));
    // Today: the withdrawal and the trade-open posting.
    expect(text(r)).toContain('Showing 1 to 2 of 2 entries');
  });

  it('Main Wallet movements — and the retired Main Wallet\'s old rows, read-only — are in the list', async () => {
    scripted['/subscriptions/history'] = [{ delay: 0, data: [
      { _id: '64eeeeeeeeeeeeeeeeeeee01', wallet: 'MAIN', transactionType: 'DEBIT', reason: 'SUBSCRIPTION_CHARGE', status: 'SUCCESS', amount: '499', balanceAfter: '251', currency: 'INR', createdAt: ago(0, 6) },
      // A Bonus plan charge the Bonus ledger below also carries: listed once.
      { _id: '64ffffffffffffffffffff02', wallet: 'BONUS', transactionType: 'DEBIT', reason: 'SUBSCRIPTION_CHARGE', status: 'SUCCESS', amount: '29.99', balanceAfter: '310.01', planCode: 'PREMIUM', billingCycle: 'MONTHLY', currency: 'INR', createdAt: ago(0, 4) },
    ] }];
    scripted['/bonus-wallet/history'] = [{ delay: 0, data: [
      { _id: '64ffffffffffffffffffff01', transactionType: 'CREDIT', reason: 'REFERRAL_COMMISSION', status: 'SUCCESS', amount: '300', balanceAfter: '340', currency: 'INR', note: 'From user Asha', createdAt: ago(0, 5) },
      { _id: '64ffffffffffffffffffff02', transactionType: 'DEBIT', reason: 'SUBSCRIPTION_CHARGE', status: 'SUCCESS', amount: '29.99', balanceAfter: '310.01', planCode: 'PREMIUM', billingCycle: 'MONTHLY', currency: 'INR', createdAt: ago(0, 4) },
    ] }];
    const r = await mount({ view: 'history' });
    expect(calls.find((c) => c.url === '/subscriptions/history')?.params).toEqual({ limit: 100 });
    expect(calls.find((c) => c.url === '/bonus-wallet/history')?.params).toEqual({ limit: 100 });
    expect(text(r)).toContain(`Showing 1 to 15 of ${TOTAL + 3} entries`);
    let s = text(r);
    expect(s).toContain('Old Main Wallet (closed)');
    expect(s).toContain('-₹499.00');

    // The option in the open dropdown (the rail carries the same words).
    const option = (t: string): TestNode | undefined =>
      r.root.findAll((x) => x.props.accessibilityRole === 'radio' && typeof x.props.onPress === 'function'
        && x.findAll((y) => y.props.children === t).length > 0)[0];
    await press(byLabel(r, 'Accounts: All Accounts'));
    // No Main Wallet choice any more — its old rows show under All Accounts.
    expect(option('Old Main Wallet')).toBeUndefined();
    await press(option('Main Wallet'));
    s = text(r);
    expect(s).toContain('Showing 1 to 2 of 2 entries');
    expect(s).toContain('From user Asha');
    expect(s).toContain('+₹300.00');
    expect(s).toContain('Subscription Charge');
    expect(s).toContain('-₹29.99');
  });

  it('a private note is saved for this user and shown on the row', async () => {
    const r = await mount({ view: 'history' });
    await press(byLabel(r, 'Add note'));
    const input = byLabel(r, 'Note');
    await type(input, '  check this ');
    await submit(byLabel(r, 'Note'));
    expect(text(r)).toContain('check this');
    const stored = JSON.parse((await AsyncStorage.getItem(notesStorageKey('u1'))) ?? '{}') as Record<string, string>;
    expect(Object.values(stored)).toEqual(['check this']);
  });

  it('the details sheet, copy, and export', async () => {
    const r = await mount({ view: 'history' });
    await press(byLabel(r, 'View details'));
    expect(text(r)).toContain('Transaction Details');
    expect(text(r)).toContain('TXN-CCCCCCCCCC01');

    await press(byLabel(r, 'Copy Transaction ID'));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('TXN-CCCCCCCCCC01');

    await press(byLabel(r, 'Export'));
    expect(mockWritten).toHaveLength(1);
    expect(mockWritten[0]?.uri).toMatch(/^file:\/\/\/cache\/transactions-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = mockWritten[0]?.content.split('\n') ?? [];
    expect(lines[0]).toBe('"Date & Time","Transaction ID","Order ID","Amount (INR)","Balance Before (INR)","Balance After (INR)","Status","Type","Payment Method","Received From","Destination","Description","Note"');
    expect(lines).toHaveLength(TOTAL + 1);
    expect(mockShared).toEqual([mockWritten[0]?.uri]);
  });
});

/* ══ Review 2 (adversarial pass) ═══════════════════════════════════════ */

const balancesWith = (acc1Balance: string): unknown[] =>
  (SERVER['/wallet/balances']!({} as InternalAxiosRequestConfig) as Record<string, unknown>[])
    .map((w) => (w.accountId === 'acc1' ? { ...w, balance: acc1Balance } : w));

const storedNotes = async (): Promise<string[]> =>
  Object.values(JSON.parse((await AsyncStorage.getItem(notesStorageKey('u1'))) ?? '{}') as Record<string, string>);

describe('review 2 — overlapping loads', () => {
  it('a slow answer to an OLDER load never lands over a newer one', async () => {
    const r = await mount({ view: 'details' });
    expect(text(r)).toContain('₹1,000.00');
    // Load A (first nudge) is answered slowly with figures from before the
    // change; load B (second nudge) is answered at once with the new ones.
    scripted['/wallet/balances'] = [
      { delay: 1500, data: balancesWith('1234') },
      { delay: 0, data: balancesWith('1500') },
    ];
    const answered: string[] = [];
    await act(async () => { ws.mockEmit('user:wallet', { event: 'UPDATED' }); });
    await wait(330); // the debounce has fired: A is in flight for 1.5s
    expect(scripted['/wallet/balances']).toHaveLength(1);
    await act(async () => { ws.mockEmit('user:wallet', { event: 'UPDATED' }); });
    await wait(330); // B has been asked, and answered at once
    expect(scripted['/wallet/balances']).toHaveLength(0);
    answered.push(text(r).includes('₹1,500.00') ? 'B' : '?');
    await wait(1500); // …and now A's stale answer arrives, last
    answered.push(text(r).includes('₹1,234.00') ? 'A-landed' : 'A-dropped');
    expect(answered).toEqual(['B', 'A-dropped']);
    const s = text(r);
    expect(s).toContain('₹1,500.00');
    expect(s).not.toContain('₹1,234.00');
  });
});

describe('review 2 — coming back from another screen', () => {
  it('re-loads the page and the overview’s own figures, as the web’s fresh mount does', async () => {
    const r = await mount();
    const bonusBefore = count('/bonus-wallet');
    const balancesBefore = count('/wallet/balances');
    expect(text(r)).toContain('₹40.00');
    // Funds added on the Bonus Wallet page.
    scripted['/bonus-wallet'] = [{ delay: 0, data: { _id: 'bw', balance: '345', currency: 'INR', totalEarnings: '120' } }];

    await press(byText(r, 'View Main Wallet History →'));
    expect(text(r)).toContain('route:BonusWallet');
    await act(async () => { navRef.goBack(); });
    await settle();

    expect(count('/bonus-wallet')).toBe(bonusBefore + 1);
    expect(count('/wallet/balances')).toBe(balancesBefore + 1);
    expect(text(r)).toContain('₹345.00');
  });

  it('does not re-load on the first focus (the mount already loaded)', async () => {
    await mount();
    expect(count('/wallet/balances')).toBe(1);
    expect(count('/bonus-wallet')).toBe(1);
  });
});

describe('review 2 — the server’s trading figures', () => {
  it('a failed account-metrics load says why the figures are dashes, and Retry asks again', async () => {
    failing = new Set(['/trading/positions?accountId']);
    const r = await mount();
    let s = text(r);
    expect(s).toContain('Live account figures could not be loaded');
    expect(s).toContain('/trading/positions is down');
    expect(s).not.toContain('₹1,400.00');

    failing = new Set();
    await press(byText(r, 'Retry'));
    s = text(r);
    expect(s).not.toContain('Live account figures could not be loaded');
    expect(s).toContain('₹1,400.00'); // free margin, now the server's
  });

  it('while positions are unknown the KPI shows no "0 Winning · 0 Losing" under its dash', async () => {
    failing = new Set(['/trading/positions']);
    const r = await mount();
    const s = text(r);
    expect(s).toContain('— Winning · — Losing');
    expect(s).not.toContain('0 Winning · 0 Losing');
  });
});

describe('review 2 — private notes are not lost', () => {
  it('opening another row’s note keeps what was typed in the first (the web’s blur saves it)', async () => {
    const r = await mount({ view: 'history' });
    await press(byLabel(r, 'Add note'));
    await type(byLabel(r, 'Note'), '  first draft ');
    // No Done, no blur: the keyboard stays up and the next row's note is tapped.
    await press(byLabel(r, 'Add note'));
    expect(await storedNotes()).toEqual(['first draft']);
    expect(text(r)).toContain('first draft');

    // The × still throws a draft away.
    await type(byLabel(r, 'Note'), 'discard me');
    await press(byLabel(r, 'Cancel note'));
    expect(await storedNotes()).toEqual(['first draft']);
    expect(byLabel(r, 'Note')).toBeUndefined();
  });

  it('switching views with a note open keeps the note', async () => {
    const r = await mount({ view: 'history' });
    await press(byLabel(r, 'Add note'));
    await type(byLabel(r, 'Note'), 'keep me');
    await press(byLabel(r, 'Account Overview'));
    expect(await storedNotes()).toEqual(['keep me']);
  });

  it('an untouched note editor that goes away writes nothing', async () => {
    const r = await mount({ view: 'history' });
    await press(byLabel(r, 'Add note'));
    await press(byLabel(r, 'Account Overview'));
    expect(await AsyncStorage.getItem(notesStorageKey('u1'))).toBeNull();
  });

  it('pressing the × and sliding off it leaves the editor working', async () => {
    const r = await mount({ view: 'history' });
    await press(byLabel(r, 'Add note'));
    await type(byLabel(r, 'Note'), 'held then released');
    const x = r.root.findAll((n) => n.props.accessibilityLabel === 'Cancel note' && typeof n.props.onPressIn === 'function')[0];
    if (!x) throw new Error('× not found');
    await act(async () => { (x.props.onPressIn as () => void)(); });
    // A blur while the × is held is not a save…
    await act(async () => { (byLabel(r, 'Note')?.props.onBlur as () => void)(); });
    await act(async () => { (x.props.onPressOut as () => void)(); });
    await settle();
    expect(byLabel(r, 'Note')).toBeDefined();
    expect(await AsyncStorage.getItem(notesStorageKey('u1'))).toBeNull();
    // …and the editor still saves once the finger leaves the ×.
    await submit(byLabel(r, 'Note'));
    expect(await storedNotes()).toEqual(['held then released']);
    expect(byLabel(r, 'Note')).toBeUndefined();
  });
});
