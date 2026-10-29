/**
 * Render tests for the Bonus Wallet screen — which took over the retired Main
 * Wallet's job: Add Funds, plan billing (auto-renew, the low-balance
 * warning) and withdrawals, beside its earnings — mounted in a real
 * native stack with the real overlay layer, API modules and stores. HTTP goes
 * to a recording adapter (nothing leaves the process); the socket hooks, the
 * withdrawal-method picker and the pay-to / proof widgets (another area's
 * components, pinned by their contract) are stand-ins.
 *
 * Covers what pure-logic tests cannot: which step is on screen, which call
 * went out with what body, what the user is told, and where they go next.
 */
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { InternalAxiosRequestConfig } from 'axios';
import React, { act, type ComponentType } from 'react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

jest.mock('@/store/auth', () => {
  const { create } = jest.requireActual('zustand');
  const useAuthStore = create(() => ({ user: null, status: 'authenticated', error: null }));
  return { useAuthStore };
});

jest.mock('@/websocket/ws', () => ({ wsClient: { subscribe: () => () => {}, disconnect: () => {} } }));

jest.mock('@/websocket/channels', () => {
  const handlers: Record<string, () => void> = {};
  return {
    __handlers: handlers,
    useChannel: (ch: string, cb: () => void) => { handlers[ch] = cb; },
    useForeground: () => {},
  };
});

jest.mock('@/components/wallet/WithdrawalMethods', () => {
  const { Pressable, Text: T, View } = jest.requireActual('react-native');
  const R = jest.requireActual('react');
  const seen: { destinations?: string[] } = {};
  function VerifiedDestinationList(p: { destinations: { id: string; label: string }[]; value: string; onChange: (id: string) => void }) {
    seen.destinations = p.destinations.map((d) => d.id);
    return R.createElement(View, null,
      R.createElement(T, null, `picked:${p.value || 'none'}`),
      ...p.destinations.map((d) => R.createElement(Pressable, { key: d.id, onPress: () => p.onChange(d.id), accessibilityLabel: `pick-${d.id}` }, R.createElement(T, null, d.label))));
  }
  return { VerifiedDestinationList, __seen: seen };
});

jest.mock('@/components/wallet/PayToCard', () => {
  const { Pressable, Text: T, View } = jest.requireActual('react-native');
  const R = jest.requireActual('react');
  function PayToCard(p: { rail: { rows: { label: string; value: string }[] } | null; label: string }) {
    if (!p.rail) return R.createElement(T, null, `Payment details for ${p.label} aren't set up yet.`);
    return R.createElement(View, null, p.rail.rows.map((r) => R.createElement(T, { key: r.label }, `${r.label}: ${r.value}`)));
  }
  function ProofPicker(p: { value: unknown; onChange: (v: unknown) => void }) {
    return p.value
      ? R.createElement(T, null, 'Screenshot ready')
      : R.createElement(Pressable, {
        accessibilityLabel: 'Upload payment screenshot',
        onPress: () => p.onChange({ dataUrl: 'data:image/jpeg;base64,QUJD', mimeType: 'image/jpeg', uri: 'file:///proof.jpg' }),
      }, R.createElement(T, null, 'Upload'));
  }
  return { PayToCard, ProofPicker };
});

/* eslint-disable import/first */
import { api } from '@/api/client';
import { PortalHost, toast } from '@/components/ui';
import { toastStore } from '@/components/ui/toast';
import type { RootStackParamList, ScreenName } from '@/navigation/types';
import { BonusWalletScreen } from '@/screens/wallet/BonusWalletScreen';
import { useSelectedAccountStore } from '@/store/selectedAccount';
import { ThemeProvider } from '@/theme';
import { toUserAccount } from '@/types/user';
import { fmtYmd, toYmd } from '@/utils/userWallets';
/* eslint-enable import/first */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const channels = require('@/websocket/channels') as { __handlers: Record<string, () => void> };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const picker = require('@/components/wallet/WithdrawalMethods') as { __seen: { destinations?: string[] } };

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
  for (let i = 0; i < 5; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
};
const wait = async (ms: number): Promise<void> => {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  await settle();
};

/* ── HTTP ─────────────────────────────────────────────────────────────── */

interface Call { method: string; url: string; params: unknown; body: Record<string, unknown> | undefined }
const calls: Call[] = [];
type Reply = { status?: number; data: unknown };
let routes: Record<string, (c: Call) => Reply | Promise<Reply>> = {};

/** A reply the test releases by hand — to look at the screen while a call is in flight. */
const deferred = (): { promise: Promise<Reply>; resolve: (r: Reply) => void } => {
  let resolve: (r: Reply) => void = () => {};
  const promise = new Promise<Reply>((res) => { resolve = res; });
  return { promise, resolve };
};

const ok = (data: unknown): Reply => ({ data: { success: true, data } });
const fail = (status: number, message: string, code?: string, details?: unknown): Reply =>
  ({ status, data: { success: false, error: { message, code, details } } });

beforeAll(() => {
  api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const call: Call = {
      method: String(config.method ?? 'get').toUpperCase(),
      url: config.url ?? '',
      params: config.params,
      body: typeof config.data === 'string' ? JSON.parse(config.data) : config.data,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.url}`];
    const r = route ? await route(call) : ok({});
    const status = r.status ?? 200;
    if (status >= 400) {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw { isAxiosError: true, message: `Request failed with status code ${status}`, config, response: { status, data: r.data, headers: {}, config } };
    }
    return { data: r.data, status, statusText: 'OK', headers: {}, config };
  };
});

const posted = (url: string): Call[] => calls.filter((c) => c.method === 'POST' && c.url === url);
const got = (url: string): Call[] => calls.filter((c) => c.method === 'GET' && c.url === url);
const toasts = (): string[] => toastStore.getState().toasts.map((t) => `${t.type}:${t.message}`);

/* ── Mounting ─────────────────────────────────────────────────────────── */

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const Stack = createNativeStackNavigator<RootStackParamList>();

function Stub({ route }: { route: { name: string; params?: object } }): React.JSX.Element {
  return <Text>{`route:${route.name}:${JSON.stringify(route.params ?? {})}`}</Text>;
}

const ROUTES: ScreenName[] = ['BonusWallet', 'Plans', 'NewAccountTiers', 'Wallet'];
let renderer: Renderer | null = null;
const navRef = createNavigationContainerRef<RootStackParamList>();

const mount = async (name: 'BonusWallet' = 'BonusWallet'): Promise<Renderer> => {
  const Screen = BonusWalletScreen as ComponentType;
  await act(async () => {
    renderer = create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>
          <NavigationContainer ref={navRef} initialState={{ index: 0, routes: [{ name }] } as never}>
            <PortalHost>
              <Stack.Navigator screenOptions={{ headerShown: false, animation: 'none' }}>
                {ROUTES.map((r) => (
                  <Stack.Screen key={r} name={r} component={(r === name ? Screen : Stub) as ComponentType} />
                ))}
              </Stack.Navigator>
            </PortalHost>
          </NavigationContainer>
        </ThemeProvider>
      </SafeAreaProvider>,
    );
  });
  await settle();
  return renderer as unknown as Renderer;
};

const screenText = (r: Renderer): string => textOf(r.toJSON());

/** The nearest pressable around the text node that reads exactly `text`. */
const byText = (r: Renderer, text: string): TestNode | undefined => {
  let n: TestNode | null | undefined = r.root.findAll((x) => x.props.children === text)[0];
  while (n && typeof n.props.onPress !== 'function') n = n.parent;
  return n ?? undefined;
};
const byLabel = (r: Renderer, label: string): TestNode | undefined =>
  r.root.findAll((x) => x.props.accessibilityLabel === label && typeof x.props.onPress === 'function')[0];
const input = (r: Renderer, pred: (p: Record<string, unknown>) => boolean): TestNode | undefined =>
  r.root.findAll((x) => x.type === 'TextInput' && pred(x.props))[0];

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
const isDisabled = (node: TestNode | undefined): boolean => {
  if (!node) throw new Error('node not found');
  return node.props.disabled === true || (node.props.accessibilityState as { disabled?: boolean } | undefined)?.disabled === true;
};

/* ── Fixtures ─────────────────────────────────────────────────────────── */

const inDays = (d: number): string => new Date(Date.now() + d * 86400000 + 3600000).toISOString();

/** GET /bonus-wallet — plans are billed from it, so it carries the plan-billing settings. */
const BILLING_WALLET = {
  _id: 'bw1', balance: '250.75', currency: 'INR', autoRenew: true, gracePeriodDays: 3,
  // The server's flag: bonusWalletService.isLowBalance (threshold ≥ balance).
  lowBalanceThreshold: '300', isLowBalance: true, updatedAt: '2026-09-28T10:00:00Z',
  totalEarnings: '100', totalReferralEarnings: '60', totalPartnerEarnings: '25', totalRevenueShare: '10', totalBonusRewards: '5',
};
const ME = {
  subscription: { planCode: 'PRO', status: 'ACTIVE', billingCycle: 'MONTHLY', expiresAt: inDays(5), nextBillingAt: null },
  effectivePlan: { code: 'PRO', name: 'Pro' },
};
const BILLING_HISTORY = [
  { _id: 'bt0000000001', transactionType: 'CREDIT', reason: 'DEPOSIT', status: 'SUCCESS', amount: '100', balanceAfter: '250.75', note: 'From trading account 100234', createdAt: '2026-09-27T10:00:00Z' },
  { _id: 'bt0000000002', transactionType: 'DEBIT', reason: 'SUBSCRIPTION_CHARGE', status: 'SUCCESS', amount: '49', planCode: 'PREMIUM', billingCycle: 'MONTHLY', note: 'Subscription · Premium (monthly)', createdAt: '2026-09-26T10:00:00Z' },
  { _id: 'bt0000000003', transactionType: 'CREDIT', reason: 'COPY_PERFORMANCE_FEE', status: 'SUCCESS', amount: '12', note: 'Copy fee', createdAt: '2026-09-25T10:00:00Z' },
];
const DEPOSIT_DETAILS = {
  UPI: { upiId: 'pay@okaxis', payeeName: 'Equity Hub', enabled: true, withdrawalEnabled: false, minDeposit: 100 },
  // Closed for deposits, still paying out — said explicitly: with no stored
  // withdrawal switch the deposit one would decide (the shared rule).
  BANK: { enabled: false, withdrawalEnabled: true },
  RAZORPAY: { enabled: false },
  custom: [
    { id: 'cash', label: 'Cash Deposit', emoji: '💵', minDeposit: 2500, withdrawalEnabled: false, fields: [{ label: 'Branch', value: 'Andheri' }] },
    { id: 'blank', label: 'Blank Rail', withdrawalEnabled: false, fields: [] },
  ],
};
const METHODS = [
  { _id: 'wm1', type: 'BANK', label: 'HDFC Salary', status: 'VERIFIED', isVerified: true, maskedDestination: '•••• 6789' },
  { _id: 'wm2', type: 'UPI', label: 'GPay', status: 'VERIFIED', isVerified: true, maskedDestination: 'r•••@okhdfc' },
  { _id: 'wm3', type: 'BANK', label: 'Pending', status: 'PENDING', isVerified: false, maskedDestination: '•••• 0001' },
];

const baseRoutes = (): Record<string, (c: Call) => Reply | Promise<Reply>> => ({
  'GET /bonus-wallet': () => ok(BILLING_WALLET),
  'GET /bonus-wallet/history': () => ok(BILLING_HISTORY),
  'GET /subscriptions/me': () => ok(ME),
  'GET /wallet/deposit-details': () => ok(DEPOSIT_DETAILS),
  'GET /withdrawal-methods': () => ok(METHODS),
  'GET /wallet/balances': () => ok([
    { _id: 'b1', accountId: 'pro', currency: 'INR', balance: '120.5', locked: '0', free: '120.5' },
    { _id: 'b2', accountId: 'std', currency: 'INR', balance: '9', locked: '0', free: '9' },
  ]),
});

beforeEach(() => {
  calls.length = 0;
  routes = baseRoutes();
  toastStore.setState({ toasts: [] });
  useSelectedAccountStore.setState({ accounts: [], selectedId: null, userId: null });
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = null;
  // Toast auto-dismiss timers would hold the process open.
  toast.dismiss();
});

/* ══ Bonus Wallet — Add Funds, plan billing, withdraw ═════════════════ */

describe('BonusWalletScreen — Add Funds, plan billing, withdraw (the retired Main Wallet\'s job)', () => {
  it('shows the wallet, Add Funds and Withdraw, the subscription tiles, the low-balance warning and the history', async () => {
    const r = await mount('BonusWallet');
    const text = screenText(r);
    expect(got('/bonus-wallet')).toHaveLength(1);
    expect(got('/subscriptions/me')).toHaveLength(1);
    expect(got('/bonus-wallet/history')[0]?.params).toEqual({ limit: 100 });
    // Nothing reads the retired Main Wallet.
    expect(calls.filter((c) => c.url.startsWith('/subscription-wallet'))).toEqual([]);

    expect(text).toContain('Main Wallet');
    expect(text).toContain('Holds your referral and partner earnings, copy-trading fees and the funds you add. Your plans are billed from here. Add funds or withdraw anytime.');
    expect(text).toContain('₹250.75');
    expect(byText(r, 'Add Funds')).toBeDefined();
    expect(byText(r, 'Withdraw')).toBeDefined();
    // Plan · status · cycle.
    expect(text).toContain('Subscription');
    expect(text).toContain('Pro');
    expect(text).toContain('Active');
    expect(text).toContain('monthly billing');
    // Counts down to the plan's expiry, and shows its date.
    expect(text).toMatch(/5d \d+h/);
    expect(text).toContain(new Date(ME.subscription.expiresAt as string).toLocaleDateString());
    expect(text).toContain('Enabled');
    expect(text).toContain('Plan renewals are deducted from this Main Wallet. 3-day grace period.');
    expect(text).toContain('⚠ Low balance — ensure sufficient funds in your Main Wallet before your renewal date.');
    // History: a deposit, a plan charge and a copy-trading fee, by their labels.
    expect(text).toContain('Transaction History');
    expect(text).toContain('3 records');
    expect(text).toContain('Deposit');
    expect(text).toContain('+₹100.00');
    expect(text).toContain('From trading account 100234');
    expect(text).toContain('Subscription Charge');
    expect(text).toContain('-₹49.00');
    expect(text).toContain('Copy Trading Commission');
    // No renew button: the web never calls POST /subscriptions/renew.
    expect(text).not.toMatch(/Renew now/i);
  });

  it('the low-balance warning follows the server\'s flag, and its Add Funds opens the sheet', async () => {
    routes['GET /bonus-wallet'] = () => ok({ ...BILLING_WALLET, isLowBalance: false });
    const quiet = await mount('BonusWallet');
    expect(screenText(quiet)).not.toContain('⚠ Low balance');
    await act(async () => { renderer?.unmount(); });
    routes['GET /bonus-wallet'] = () => ok(BILLING_WALLET);
    const r = await mount('BonusWallet');
    const links = r.root.findAll((x) => x.props.children === 'Add Funds');
    expect(links.length).toBeGreaterThanOrEqual(2);
    let n: TestNode | null | undefined = links[links.length - 1];
    while (n && typeof n.props.onPress !== 'function') n = n.parent;
    await press(n ?? undefined);
    expect(screenText(r)).toContain('Add funds to Main Wallet');
  });

  it('"Manage plans →" opens Plans, and coming back reloads the wallet', async () => {
    const r = await mount('BonusWallet');
    expect(got('/bonus-wallet')).toHaveLength(1);
    await press(byText(r, 'Manage plans →'));
    expect(screenText(r)).toContain('route:Plans');
    await act(async () => { navRef.goBack(); });
    await settle();
    // A plan bought on Plans moved money: the web remounts the page, this reloads it.
    expect(got('/bonus-wallet')).toHaveLength(2);
    expect(got('/subscriptions/me')).toHaveLength(2);
  });

  it('turns auto-renew off, says so, and reloads', async () => {
    routes['POST /bonus-wallet/auto-renew'] = () => ok({ autoRenew: false });
    const r = await mount('BonusWallet');
    await press(byLabel(r, 'Auto-renew'));
    expect(posted('/bonus-wallet/auto-renew')[0]?.body).toEqual({ enabled: false });
    expect(toasts()).toContain('success:Auto-renew disabled');
    expect(got('/bonus-wallet')).toHaveLength(2);
  });

  it('the switch shows the server\'s answer at once — not the old state until the reload lands', async () => {
    routes['POST /bonus-wallet/auto-renew'] = () => ok({ autoRenew: false });
    const r = await mount('BonusWallet');
    expect(screenText(r)).toContain('Enabled');
    const reload = deferred();
    routes['GET /bonus-wallet'] = () => reload.promise;
    await press(byLabel(r, 'Auto-renew'));
    expect(toasts()).toContain('success:Auto-renew disabled');
    // The follow-up GET is still in flight: the tile already agrees with the toast.
    expect(got('/bonus-wallet')).toHaveLength(2);
    expect(screenText(r)).toContain('Disabled');
    expect(screenText(r)).not.toContain('Enabled');
    await act(async () => { reload.resolve(ok({ ...BILLING_WALLET, autoRenew: false })); });
    await settle();
    expect(screenText(r)).toContain('Disabled');
  });

  it('shows the server\'s refusal when the wallet cannot load, and retries', async () => {
    routes['GET /bonus-wallet'] = () => fail(503, 'Wallet service is unavailable');
    const r = await mount('BonusWallet');
    expect(screenText(r)).toContain('Wallet service is unavailable');
    expect(screenText(r)).not.toContain('₹0.00');
    routes['GET /bonus-wallet'] = () => ok(BILLING_WALLET);
    await press(byText(r, 'Try again') ?? byText(r, 'Retry'));
    expect(screenText(r)).toContain('₹250.75');
  });

  it('says the history failed rather than "No transactions yet"', async () => {
    routes['GET /bonus-wallet/history'] = () => fail(500, 'History unavailable');
    const r = await mount('BonusWallet');
    expect(screenText(r)).toContain('History unavailable');
    expect(screenText(r)).not.toContain('No transactions yet');
  });

  it('shows "No transactions yet" for an empty history', async () => {
    routes['GET /bonus-wallet/history'] = () => ok([]);
    const r = await mount('BonusWallet');
    expect(screenText(r)).toContain('No transactions yet');
    expect(screenText(r)).toContain('0 records');
  });

  it('Add Funds — a manual UPI deposit, through all four steps', async () => {
    routes['POST /bonus-wallet/manual-deposit'] = () => ok({ depositId: 'd1', status: 'PENDING', amount: '100', currency: 'INR', method: 'UPI' });
    const r = await mount('BonusWallet');
    await press(byText(r, 'Add Funds'));
    let text = screenText(r);
    expect(text).toContain('Add funds to Main Wallet');
    expect(text).toContain('Pick how you want to fund this wallet.');
    expect(got('/wallet/deposit-details')).toHaveLength(1);
    // BANK is switched off by the admin; the custom rails and the transfer are offered.
    expect(text).toContain('Cash Deposit');
    expect(text).toContain('Blank Rail');
    expect(text).toContain('Trading account');
    expect(text).not.toContain('Bank Transfer');
    expect(isDisabled(byText(r, 'Continue →'))).toBe(true);

    await press(byLabel(r, 'UPI'));
    await press(byText(r, 'Continue →'));
    // Step 2: amount, with the rail's own minimum.
    expect(screenText(r)).toContain('Minimum ₹100.00');
    const amount = input(r, (p) => p.accessibilityLabel === 'Amount');
    await type(amount, '50');
    expect(isDisabled(byText(r, 'Continue →'))).toBe(true);
    await press(byText(r, '₹500'));
    expect(input(r, (p) => p.accessibilityLabel === 'Amount')?.props.value).toBe('500');
    await type(input(r, (p) => p.accessibilityLabel === 'Amount'), '100');
    expect(isDisabled(byText(r, 'Continue →'))).toBe(false);
    await press(byText(r, 'Continue →'));

    // Step 3: where to pay (the Add Funds labels), reference, sender, proof.
    text = screenText(r);
    expect(text).toContain('UPI ID: pay@okaxis');
    expect(text).toContain('Name: Equity Hub');
    expect(text).toContain('Send ');
    expect(text).toContain('₹100.00');
    expect(text).toContain(' via UPI to the details above, then upload proof. An admin will verify and credit your Main Wallet.');
    expect(isDisabled(byText(r, 'Continue →'))).toBe(true);
    await type(input(r, (p) => p.placeholder === 'UPI reference number'), 'UTR998877');
    await type(input(r, (p) => p.placeholder === 'username@upi'), 'ravi@okhdfc');
    expect(isDisabled(byText(r, 'Continue →'))).toBe(true);
    await press(byLabel(r, 'Upload payment screenshot'));
    expect(screenText(r)).toContain('Screenshot ready');
    await press(byText(r, 'Continue →'));

    // Step 4: review, then submit.
    text = screenText(r);
    expect(text).toContain('📱 UPI');
    expect(text).toContain('UTR998877');
    expect(text).toContain('Attached');
    expect(text).toContain('Submission goes to admin for verification. You\'ll get a notification when the deposit is credited.');
    await press(byText(r, 'Submit deposit'));
    expect(posted('/bonus-wallet/manual-deposit')[0]?.body).toEqual({
      amount: 100,
      currency: 'INR',
      method: 'UPI',
      txReference: 'UTR998877',
      senderUpiId: 'ravi@okhdfc',
      screenshot: 'data:image/jpeg;base64,QUJD',
      screenshotMimeType: 'image/jpeg',
    });
    expect(toasts()).toContain('success:Deposit submitted — pending admin verification');
    expect(got('/bonus-wallet')).toHaveLength(2);
  });

  it('Add Funds — a rail with nothing set up warns by its label; a custom rail keeps its own minimum', async () => {
    const r = await mount('BonusWallet');
    await press(byText(r, 'Add Funds'));
    await press(byLabel(r, 'Blank Rail'));
    await press(byText(r, 'Continue →'));
    await type(input(r, (p) => p.accessibilityLabel === 'Amount'), '10');
    await press(byText(r, 'Continue →'));
    expect(screenText(r)).toContain('Payment details for Blank Rail aren\'t set up yet.');
    await press(byText(r, '← Back'));
    await press(byText(r, '← Back'));
    await press(byLabel(r, 'Cash Deposit'));
    await press(byText(r, 'Continue →'));
    expect(screenText(r)).toContain('Minimum ₹2,500.00');
  });

  it('Add Funds — the instant transfer from the oldest live account', async () => {
    useSelectedAccountStore.setState({
      accounts: [
        toUserAccount({ _id: 'demo', accountNumber: '900001', accountType: 'DEMO', createdAt: '2020-01-01T00:00:00Z' }),
        toUserAccount({ _id: 'std', accountNumber: '100500', accountType: 'STANDARD', createdAt: '2025-01-01T00:00:00Z' }),
        toUserAccount({ _id: 'pro', accountNumber: '100234', accountType: 'PRO', nickname: 'Pro Acc', createdAt: '2024-01-01T00:00:00Z' }),
      ],
    });
    routes['POST /bonus-wallet/deposit'] = () => ok({ wallet: { balance: '255.75', currency: 'INR' } });
    const r = await mount('BonusWallet');
    await press(byText(r, 'Add Funds'));
    await press(byLabel(r, 'Trading account'));
    expect(screenText(r)).toContain('Instant');
    await press(byText(r, 'Continue →'));
    expect(screenText(r)).toContain('Minimum ₹1.00');
    await type(input(r, (p) => p.accessibilityLabel === 'Amount'), '5');
    await press(byText(r, 'Continue →'));
    expect(got('/wallet/balances')).toHaveLength(1);
    const text = screenText(r);
    expect(text).toContain('From trading account');
    // Oldest live account pre-selected, with its base-currency balance; DEMO never offered.
    expect(text).toContain('Pro Acc · ₹120.50');
    await press(byText(r, 'Continue →'));
    expect(screenText(r)).toContain('Funds transfer instantly. Your trading account is debited and your Main Wallet credited in one step.');
    expect(screenText(r)).toContain('Pro Acc');
    await press(byText(r, 'Transfer ₹5.00'));
    expect(posted('/bonus-wallet/deposit')[0]?.body).toEqual({ amount: 5, sourceAccountId: 'pro' });
    expect(toasts()).toContain('success:₹5.00 moved to Main Wallet');
  });

  const LIVE_ACCOUNTS = (): ReturnType<typeof toUserAccount>[] => [
    toUserAccount({ _id: 'std', accountNumber: '100500', accountType: 'STANDARD', createdAt: '2025-01-01T00:00:00Z' }),
    toUserAccount({ _id: 'pro', accountNumber: '100234', accountType: 'PRO', nickname: 'Pro Acc', createdAt: '2024-01-01T00:00:00Z' }),
  ];

  const toSourceStep = async (r: Renderer): Promise<void> => {
    await press(byText(r, 'Add Funds'));
    await press(byLabel(r, 'Trading account'));
    await press(byText(r, 'Continue →'));
    await type(input(r, (p) => p.accessibilityLabel === 'Amount'), '5');
    await press(byText(r, 'Continue →'));
  };

  it('Add Funds — a failed balances call reads "—" beside each account, never ₹0.00', async () => {
    useSelectedAccountStore.setState({ accounts: LIVE_ACCOUNTS() });
    routes['GET /wallet/balances'] = () => fail(500, 'Balances unavailable');
    const r = await mount('BonusWallet');
    await toSourceStep(r);
    const text = screenText(r);
    // The oldest live account is still pre-selected; its balance is unknown.
    expect(text).toContain('Pro Acc · —');
    expect(text).not.toContain('₹0.00');
  });

  it('Add Funds — a source picked while the balances load is kept when they land', async () => {
    useSelectedAccountStore.setState({ accounts: LIVE_ACCOUNTS() });
    const balances = deferred();
    routes['GET /wallet/balances'] = () => balances.promise;
    routes['POST /bonus-wallet/deposit'] = () => ok({ wallet: { balance: '255.75', currency: 'INR' } });
    const r = await mount('BonusWallet');
    await toSourceStep(r);
    // In flight: the accounts are listed (from the store) with unknown balances.
    expect(screenText(r)).not.toContain('₹0.00');
    await press(byLabel(r, 'From trading account'));
    await press(byText(r, '100500 · —'));
    await wait(250);
    await act(async () => {
      balances.resolve(ok([
        { _id: 'b1', accountId: 'pro', currency: 'INR', balance: '120.5' },
        { _id: 'b2', accountId: 'std', currency: 'INR', balance: '9' },
      ]));
    });
    await settle();
    // The user's pick stands; the pre-selection of the oldest did not undo it.
    expect(screenText(r)).toContain('100500 · ₹9.00');
    await press(byText(r, 'Continue →'));
    await press(byText(r, 'Transfer ₹5.00'));
    expect(posted('/bonus-wallet/deposit')[0]?.body).toEqual({ amount: 5, sourceAccountId: 'std' });
  });

  it('Add Funds — a short trading wallet names the account and what it holds', async () => {
    useSelectedAccountStore.setState({
      accounts: [toUserAccount({ _id: 'pro', accountNumber: '100234', accountType: 'PRO', createdAt: '2024-01-01T00:00:00Z' })],
    });
    routes['POST /bonus-wallet/deposit'] = () => fail(402, 'Insufficient balance', 'INSUFFICIENT_TRADING_BALANCE', {
      accountNumber: '100234', currency: 'INR', available: '3.2',
    });
    const r = await mount('BonusWallet');
    await press(byText(r, 'Add Funds'));
    await press(byLabel(r, 'Trading account'));
    await press(byText(r, 'Continue →'));
    await type(input(r, (p) => p.accessibilityLabel === 'Amount'), '50');
    await press(byText(r, 'Continue →'));
    await press(byText(r, 'Continue →'));
    await press(byText(r, 'Transfer ₹50.00'));
    expect(toasts()).toContain('error:Not enough in 100234 — available ₹3.2.');
    // The sheet stays open for another try.
    expect(screenText(r)).toContain('Add funds to Main Wallet');
  });

  it('Add Funds — with no live account, offers to open one', async () => {
    useSelectedAccountStore.setState({
      accounts: [toUserAccount({ _id: 'demo', accountNumber: '900001', accountType: 'DEMO' })],
    });
    const r = await mount('BonusWallet');
    await press(byText(r, 'Add Funds'));
    await press(byLabel(r, 'Trading account'));
    await press(byText(r, 'Continue →'));
    await type(input(r, (p) => p.accessibilityLabel === 'Amount'), '5');
    await press(byText(r, 'Continue →'));
    expect(screenText(r)).toContain('No live trading account yet. ');
    expect(isDisabled(byText(r, 'Continue →'))).toBe(true);
    await press(byText(r, 'Open one →'));
    await wait(250);
    expect(screenText(r)).toContain('route:NewAccountTiers');
  });

  it('Withdraw — the admin\'s open rails, the verified destinations on the chosen one, then { amount, withdrawalMethodId }', async () => {
    routes['POST /bonus-wallet/withdraw'] = () => ok({ withdrawalId: 'w1', status: 'PENDING', amount: '250.75', currency: 'INR', balance: '0' });
    const r = await mount('BonusWallet');
    await press(byText(r, 'Withdraw'));
    const text = screenText(r);
    expect(got('/wallet/deposit-details').length).toBeGreaterThan(0);
    expect(got('/withdrawal-methods')).toHaveLength(1);
    expect(text).toContain('Withdraw from Main Wallet');
    expect(text).toContain('Amount (INR)');
    expect(text).toContain('Available: ');
    expect(text).toContain('Withdrawals are reviewed by our team. The amount is held immediately, paid out on approval, and automatically refunded if rejected.');
    // UPI payouts are closed by the admin: only Bank is a rail, and only the
    // verified Bank destination is offered (the first is pre-selected).
    expect(byLabel(r, 'Bank Transfer')).toBeDefined();
    expect(byLabel(r, 'UPI')).toBeUndefined();
    expect(picker.__seen.destinations).toEqual(['wm1']);
    expect(text).toContain('picked:wm1');

    await type(input(r, (p) => p.accessibilityLabel === 'Amount (INR)'), '300');
    expect(screenText(r)).toContain('Amount exceeds your balance');
    expect(isDisabled(byText(r, 'Request Withdrawal'))).toBe(true);
    await press(byLabel(r, 'MAX'));
    expect(input(r, (p) => p.accessibilityLabel === 'Amount (INR)')?.props.value).toBe('250.75');
    expect(isDisabled(byText(r, 'Request Withdrawal'))).toBe(false);
    await press(byText(r, 'Request Withdrawal'));
    expect(posted('/bonus-wallet/withdraw')[0]?.body).toEqual({ amount: 250.75, withdrawalMethodId: 'wm1' });
    expect(toasts()).toContain('success:Withdrawal requested — pending admin approval');
  });

  it('Withdraw — the two fixable refusals get an instruction, anything else the server\'s words', async () => {
    let next: Reply = fail(403, 'KYC verification must be approved before withdrawing funds.', 'KYC_REQUIRED');
    routes['POST /bonus-wallet/withdraw'] = () => next;
    const r = await mount('BonusWallet');
    await press(byText(r, 'Withdraw'));
    await type(input(r, (p) => p.accessibilityLabel === 'Amount (INR)'), '10');
    await press(byText(r, 'Request Withdrawal'));
    expect(toasts()).toContain('error:Complete KYC verification first (Profile → KYC).');
    next = fail(400, 'Withdrawal blocked: your net trading P&L for this month is negative.', 'WITHDRAWAL_BLOCKED_MONTHLY_PNL');
    await press(byText(r, 'Request Withdrawal'));
    expect(toasts()).toContain('error:Withdrawal blocked: your net trading P&L for this month is negative.');
    next = fail(400, 'Payout service is unavailable');
    await press(byText(r, 'Request Withdrawal'));
    expect(toasts()).toContain('error:Payout service is unavailable');
  });

  it('Withdraw — with no verified destination on the rail, "Add a … method →" goes to Wallet → Withdrawal Methods', async () => {
    routes['GET /withdrawal-methods'] = () => ok(METHODS.filter((m) => m.type !== 'BANK' || !m.isVerified));
    const r = await mount('BonusWallet');
    await press(byText(r, 'Withdraw'));
    expect(screenText(r)).toContain('No verified Bank Transfer yet');
    expect(isDisabled(byText(r, 'Request Withdrawal'))).toBe(true);
    await press(byText(r, 'Add a Bank Transfer method →'));
    await wait(250);
    expect(screenText(r)).toContain('route:Wallet:{"view":"withdrawal-methods"}');
  });
});

/* ══ Bonus Wallet ══════════════════════════════════════════════════════ */

describe('BonusWalletScreen', () => {
  const today = new Date();
  const at = (daysAgo: number, h: number, m = 0): string =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, h, m).toISOString();
  const BONUS_WALLET = {
    balance: '42.5', currency: 'INR', totalEarnings: '100', totalReferralEarnings: '60',
    totalPartnerEarnings: '25', totalRevenueShare: '10', totalBonusRewards: '5',
    autoRenew: true, gracePeriodDays: 3, lowBalanceThreshold: '0', isLowBalance: false,
  };
  const BONUS_HISTORY = [
    { _id: 'aaaa00000000001111', transactionType: 'CREDIT', reason: 'REFERRAL_COMMISSION', status: 'SUCCESS', amount: '12.5', balanceAfter: '42.5', note: 'From user Asha', createdAt: at(0, 23, 30) },
    { _id: 'aaaa00000000002222', transactionType: 'CREDIT', reason: 'PARTNER_COMMISSION', amount: '3', balanceAfter: '30', note: null, createdAt: at(2, 9) },
    { _id: 'aaaa00000000003333', transactionType: 'DEBIT', reason: 'TRANSFER_OUT', status: 'SUCCESS', amount: '5', balanceAfter: '27', note: 'To trading account 100234', createdAt: at(3, 9) },
    { _id: 'aaaa00000000004444', transactionType: 'DEBIT', reason: 'WITHDRAWAL', status: 'PENDING', amount: '10', balanceAfter: '32', note: 'Withdrawal request · UPI', createdAt: at(4, 9) },
  ];

  beforeEach(() => {
    routes['GET /bonus-wallet'] = () => ok(BONUS_WALLET);
    routes['GET /bonus-wallet/history'] = () => ok(BONUS_HISTORY);
  });

  it('shows the balance, lifetime earnings, the four tiles and the history', async () => {
    const r = await mount('BonusWallet');
    const text = screenText(r);
    expect(got('/bonus-wallet/history')[0]?.params).toEqual({ limit: 100 });
    // The Subscription tiles read the plan.
    expect(got('/subscriptions/me')).toHaveLength(1);
    expect(text).toContain('Main Wallet');
    expect(text).toContain('₹42.50');
    expect(text).toContain('Lifetime earnings: ');
    expect(text).toContain('₹100.00');
    for (const [label, v] of [['Total Referral Earnings', '₹60.00'], ['Total Partner Earnings', '₹25.00'], ['Total Revenue Share', '₹10.00'], ['Total Bonus Rewards', '₹5.00']]) {
      expect(text).toContain(label);
      expect(text).toContain(v);
    }
    expect(text).not.toContain('⚠ Low balance');
    expect(text).toContain('Transaction History');
    expect(text).toContain('4 records');
    expect(text).toContain('Referral Commission');
    expect(text).toContain('+₹12.50');
    expect(text).toContain('Internal Transfer Out');
    expect(text).toContain('-₹5.00');
    expect(text).toContain('Withdrawal');
    expect(text).toContain('00000000001111'.slice(-10));
  });

  it('filters by search, direction and type, and clears', async () => {
    const r = await mount('BonusWallet');
    await type(input(r, (p) => p.placeholder === 'Search description or ID...'), 'asha');
    expect(screenText(r)).toContain('1 of 4 record');
    expect(screenText(r)).not.toContain('Internal Transfer Out');
    await type(input(r, (p) => p.placeholder === 'Search description or ID...'), '');

    await press(byLabel(r, 'Direction'));
    await press(byText(r, 'Debit (-)'));
    await wait(250);
    expect(screenText(r)).toContain('2 of 4 records');
    expect(screenText(r)).not.toContain('Referral Commission');

    await press(byLabel(r, 'Type'));
    await press(byText(r, 'Referral Commission'));
    await wait(250);
    expect(screenText(r)).toContain('No transactions match your filters. ');
    await press(byText(r, 'Clear filters'));
    expect(screenText(r)).toContain('4 records');
  });

  it('the date range is inclusive: From = To = today keeps today\'s late-evening credit', async () => {
    const r = await mount('BonusWallet');
    const ymd = toYmd(today);
    await press(byLabel(r, 'From date'));
    await press(byLabel(r, fmtYmd(ymd)));
    await wait(250);
    await press(byLabel(r, 'To date'));
    await press(byLabel(r, fmtYmd(ymd)));
    await wait(250);
    const text = screenText(r);
    expect(text).toContain('1 of 4 record');
    expect(text).toContain('Referral Commission');
    expect(text).toContain('Clear');
  });

  it('reloads when the server announces an earning', async () => {
    const r = await mount('BonusWallet');
    expect(got('/bonus-wallet')).toHaveLength(1);
    routes['GET /bonus-wallet'] = () => ok({ ...BONUS_WALLET, balance: '55' });
    await act(async () => { channels.__handlers['user:bonusWallet']?.(); });
    await settle();
    expect(got('/bonus-wallet')).toHaveLength(2);
    expect(screenText(r)).toContain('₹55.00');
  });

  it('withdraws to a verified method through /bonus-wallet/withdraw', async () => {
    routes['POST /bonus-wallet/withdraw'] = () => ok({ withdrawalId: 'w2', status: 'PENDING', amount: '40', currency: 'INR', balance: '2.5' });
    const r = await mount('BonusWallet');
    await press(byText(r, 'Withdraw'));
    expect(screenText(r)).toContain('Withdraw from Main Wallet');
    await type(input(r, (p) => p.accessibilityLabel === 'Amount (INR)'), '40');
    expect(screenText(r)).toContain('picked:wm1');
    await press(byText(r, 'Request Withdrawal'));
    expect(posted('/bonus-wallet/withdraw')[0]?.body).toEqual({ amount: 40, withdrawalMethodId: 'wm1' });
    expect(toasts()).toContain('success:Withdrawal requested — pending admin approval');
    expect(got('/bonus-wallet')).toHaveLength(2);
  });

  it('MAX on a decimal.js balance fills the cent-floored amount, and that is what is posted', async () => {
    // A revenue share (`fee × pct / 100`) leaves the server a 30-digit
    // balance. Number() of it rounds UP to 10.333333333333334, which the
    // server's gte(balance, amount) refuses; MAX must never ask for that.
    routes['GET /bonus-wallet'] = () => ok({ ...BONUS_WALLET, balance: '10.3333333333333333333333333333' });
    routes['POST /bonus-wallet/withdraw'] = () => ok({ withdrawalId: 'w3', status: 'PENDING', amount: '10.33', currency: 'INR', balance: '0.0033333333333333333333333333' });
    const r = await mount('BonusWallet');
    await press(byText(r, 'Withdraw'));
    await press(byLabel(r, 'MAX'));
    expect(input(r, (p) => p.accessibilityLabel === 'Amount (INR)')?.props.value).toBe('10.33');
    expect(isDisabled(byText(r, 'Request Withdrawal'))).toBe(false);
    await press(byText(r, 'Request Withdrawal'));
    expect(posted('/bonus-wallet/withdraw')[0]?.body).toEqual({ amount: 10.33, withdrawalMethodId: 'wm1' });
  });

  it('an empty history says where earnings will come from', async () => {
    routes['GET /bonus-wallet/history'] = () => ok([]);
    const r = await mount('BonusWallet');
    expect(screenText(r)).toContain('No transactions yet. Earnings, copy-trading fees, funds you add and plan charges will appear here.');
    expect(screenText(r)).toContain('0 records');
    // No filters over nothing.
    expect(input(r, (p) => p.placeholder === 'Search description or ID...')).toBeUndefined();
  });
});
