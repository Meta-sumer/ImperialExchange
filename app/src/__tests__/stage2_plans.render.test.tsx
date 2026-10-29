/**
 * Render tests for Plans, NewAccountTiers and NewAccountConfigure: each
 * screen mounted in a real native stack with the overlay layer and the
 * confirm provider, the API modules and the account store replaced by
 * in-memory stand-ins. Covers what a logic test cannot: what is on screen,
 * which call went out with what, and where the screen went next.
 *
 * No network, no device.
 */
import { createNavigationContainerRef, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React, { act, type ComponentType } from 'react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));

jest.mock('@/store/selectedAccount', () => {
  const { create } = jest.requireActual('zustand');
  const useSelectedAccountStore = create(() => ({
    accounts: [],
    selectedId: null,
    load: jest.fn(async () => {}),
    select: jest.fn(),
    reset: jest.fn(),
  }));
  return { useSelectedAccountStore };
});

jest.mock('@/api/subscription.api', () => {
  const actual = jest.requireActual('@/api/subscription.api');
  return {
    ...actual,
    subscriptionApi: {
      plans: jest.fn(),
      me: jest.fn(),
      history: jest.fn(),
      subscribe: jest.fn(),
      cancel: jest.fn(),
      renew: jest.fn(),
    },
  };
});

jest.mock('@/api/account.api', () => {
  const actual = jest.requireActual('@/api/account.api');
  return {
    ...actual,
    accountApi: { ...actual.accountApi, listPlans: jest.fn(), create: jest.fn() },
    createAccountFromWizard: jest.fn(),
  };
});

jest.mock('@/api/wallet.api', () => ({ walletApi: { balances: jest.fn(), usdInr: jest.fn(async () => ({ rate: null, source: null, ts: null })) } }));

// Another area's component; stubbed so this suite tests only these screens.
jest.mock('@/components/wallet/WalletNav', () => {
  const R = jest.requireActual('react');
  const { Text: T } = jest.requireActual('react-native');
  return { WalletNav: ({ activeId }: { activeId: string | null }) => R.createElement(T, null, `WalletNav:${String(activeId)}`) };
});

/* eslint-disable import/first */
import { accountApi, createAccountFromWizard } from '@/api/account.api';
import { subscriptionApi } from '@/api/subscription.api';
import { walletApi } from '@/api/wallet.api';
import { ConfirmProvider, PortalHost } from '@/components/ui';
import { toastStore } from '@/components/ui/toast';
import type { RootStackParamList, ScreenName } from '@/navigation/types';
import { NewAccountConfigureScreen } from '@/screens/accounts/NewAccountConfigureScreen';
import { NewAccountTiersScreen } from '@/screens/accounts/NewAccountTiersScreen';
import { PlansScreen } from '@/screens/plans/PlansScreen';
import { useSelectedAccountStore } from '@/store/selectedAccount';
import { ThemeProvider } from '@/theme';
import { toMySubscription, toPlan } from '@/types/subscription';
import { toAccountPlan, toUserAccount } from '@/types/user';
import { toWalletBalance, toWalletTransaction } from '@/types/wallet';
import { fmtPlanDate } from '@/utils/plans';
/* eslint-enable import/first */

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

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

const Stack = createNativeStackNavigator<RootStackParamList>();
const navRef = createNavigationContainerRef<RootStackParamList>();

function Stub({ route }: { route: { name: string; params?: object } }): React.JSX.Element {
  return <Text>{`route:${route.name}:${JSON.stringify(route.params ?? {})}`}</Text>;
}

const ROUTES: ScreenName[] = ['Plans', 'NewAccountTiers', 'NewAccountConfigure', 'Wallet', 'BonusWallet'];

let renderer: Renderer | null = null;

const mount = async <N extends ScreenName>(
  name: N,
  Screen: ComponentType<never>,
  params?: RootStackParamList[N],
  below: ScreenName[] = [],
  opts: { strict?: boolean } = {},
): Promise<Renderer> => {
  const initialState = {
    index: below.length,
    routes: [...below.map((n) => ({ name: n })), { name, params }],
  };
  const tree = (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>
        <NavigationContainer ref={navRef} initialState={initialState as never}>
          <PortalHost>
            <ConfirmProvider>
              <Stack.Navigator screenOptions={{ headerShown: false, animation: 'none' }}>
                {ROUTES.map((r) => (
                  <Stack.Screen key={r} name={r} component={(r === name ? Screen : Stub) as ComponentType} />
                ))}
              </Stack.Navigator>
            </ConfirmProvider>
          </PortalHost>
        </NavigationContainer>
      </ThemeProvider>
    </SafeAreaProvider>
  );
  await act(async () => {
    // StrictMode replays every effect's cleanup + setup once, as Fast
    // Refresh does on each edit — a screen must survive that.
    renderer = create(opts.strict ? <React.StrictMode>{tree}</React.StrictMode> : tree);
  });
  await settle();
  return renderer as unknown as Renderer;
};

const screenText = (r: Renderer): string => textOf(r.toJSON());

/** The nearest pressable around the text node that reads exactly `text`. */
const byText = (r: Renderer, text: string, index = 0): TestNode | undefined => {
  let n: TestNode | null | undefined = r.root.findAll((x) => x.props.children === text)[index];
  while (n && typeof n.props.onPress !== 'function') n = n.parent;
  return n ?? undefined;
};

const byLabel = (r: Renderer, label: string): TestNode | undefined =>
  r.root.findAll((x) => x.props.accessibilityLabel === label && typeof x.props.onPress === 'function')[0];

const press = async (node: TestNode | undefined): Promise<void> => {
  if (!node) throw new Error('node not found');
  await act(async () => { (node.props.onPress as () => void)(); });
  await settle();
};

const isDisabled = (node: TestNode | undefined): boolean =>
  !!node && (node.props.disabled === true || (node.props.accessibilityState as { disabled?: boolean } | undefined)?.disabled === true);

const inputs = (r: Renderer): TestNode[] => r.root.findAll((n) => n.type === 'TextInput');

const type = async (node: TestNode | undefined, value: string): Promise<void> => {
  if (!node) throw new Error('input not found');
  await act(async () => { (node.props.onChangeText as (s: string) => void)(value); });
  await settle();
};

const toasts = (): string[] => toastStore.getState().toasts.map((t) => `${t.type}:${t.message}`);

const axiosError = (status: number, error: Record<string, unknown>): unknown => ({
  isAxiosError: true,
  message: 'Request failed',
  response: { status, data: { success: false, error } },
});

const subs = subscriptionApi as unknown as Record<'plans' | 'me' | 'history' | 'subscribe' | 'cancel' | 'renew', jest.Mock>;
const listPlans = accountApi.listPlans as unknown as jest.Mock;
const createAccount = createAccountFromWizard as unknown as jest.Mock;
const balances = walletApi.balances as unknown as jest.Mock;
const storeLoad = (): jest.Mock => useSelectedAccountStore.getState().load as unknown as jest.Mock;

/* ── Fixtures, as the server sends them, through the app's own adapters ─ */

const RAW_FREE = { _id: 'p1', code: 'FREE', name: 'Free', description: 'Get started', monthlyPrice: '0', yearlyPrice: '0', limits: { maxAccounts: 1, maxDevices: 1 }, features: {}, highlights: ['1 trading account', 'Copy trading access'] };
const RAW_PREMIUM = { _id: 'p2', code: 'PREMIUM', name: 'Premium', description: 'For active traders', monthlyPrice: '29.99', yearlyPrice: '299', badge: 'Most Popular', limits: { maxAccounts: 5, maxDevices: 3 }, features: { apiAccess: true, maintenanceFee: true }, highlights: ['5 trading accounts', 'Copy-Trading pro', 'API access'] };
const RAW_VIP = { _id: 'p3', code: 'VIP', name: 'VIP', monthlyPrice: '99', yearlyPrice: '990', limits: { maxAccounts: null, maxDevices: null }, features: { customSupport: true, apiAccess: true }, highlights: ['Unlimited accounts'] };
const RAW_POSTPAID = { _id: 'p4', code: 'POSTPAID', name: 'Post Paid', monthlyPrice: '0', yearlyPrice: '0', limits: {}, features: { postPaid: true, maintenanceFee: true }, postPaidRates: { perDevicePerMonth: 5, perAccountPerMonth: 10, minimumMonthlyFee: 25, currency: 'INR' }, highlights: [] };
const PLANS = [RAW_FREE, RAW_PREMIUM, RAW_VIP, RAW_POSTPAID].map(toPlan);

const me = (over: { subscription?: unknown; effectivePlan?: unknown; balance?: string; isLowBalance?: boolean } = {}): unknown =>
  toMySubscription({
    subscription: over.subscription ?? null,
    effectivePlan: over.effectivePlan ?? RAW_FREE,
    wallet: null,
    billingSource: 'BONUS_WALLET',
    // The Bonus Wallet — plans are billed from it (subscriptionWallet is its deprecated alias).
    billingWallet: { _id: 'w1', type: 'BONUS', balance: over.balance ?? '50', currency: 'INR', autoRenew: true, isLowBalance: over.isLowBalance ?? false },
  });

const HISTORY = [
  { _id: 'h1', transactionType: 'DEBIT', reason: 'SUBSCRIPTION_CHARGE', amount: '29.99', currency: 'INR', status: 'SUCCESS', note: 'Subscription · Premium (monthly)', createdAt: '2026-09-01T10:00:00Z' },
  { _id: 'h2', transactionType: 'CREDIT', reason: 'DEPOSIT', amount: '100', currency: 'INR', status: 'SUCCESS', createdAt: '2026-09-02T10:00:00Z' },
  { _id: 'h3', transactionType: 'REFUND', reason: 'REFUND', amount: '10', currency: 'INR', status: 'PENDING', createdAt: '2026-09-03T10:00:00Z' },
].map(toWalletTransaction);

const RAW_TIERS = [
  { _id: 't1', code: 'STANDARD', name: 'Standard', description: 'Everyday trading', minDeposit: 100, maxLeverage: 100, feeKind: 'PCT_OF_VALUE', feeDisplay: '0.005% of trade value', isActive: true },
  { _id: 't2', code: 'STANDARD_IC', name: 'Standard IC', minDeposit: 0, maxLeverage: 50, feeKind: 'FIXED_PER_TRADE', buyCloseOnly: true, isActive: true },
  { _id: 't3', code: 'PRO', name: 'Pro', minDeposit: 1000, maxLeverage: null, feeKind: 'PCT_OF_PROFIT', feeDisplay: '10% of profit', badge: 'Most Popular', isActive: true },
  { _id: 't4', code: 'FREE', name: 'Free', minDeposit: 0, maxLeverage: 0, feeKind: 'PCT_OF_VALUE', isActive: true },
  { _id: 't5', code: 'LEGACY', name: 'Legacy', minDeposit: 0, maxLeverage: 200, feeKind: 'PCT_OF_VALUE', isActive: true },
];
const TIERS = RAW_TIERS.map(toAccountPlan);

const ACCOUNTS = [
  toUserAccount({ _id: 'a1', accountNumber: 'TA1', accountType: 'STANDARD' }),
  toUserAccount({ _id: 'a2', accountNumber: 'TA2', accountType: 'DEMO' }),
];

beforeEach(() => {
  jest.clearAllMocks();
  toastStore.setState({ toasts: [] });
  useSelectedAccountStore.setState({ accounts: ACCOUNTS } as never);
  subs.plans.mockResolvedValue(PLANS);
  subs.me.mockResolvedValue(me());
  subs.history.mockResolvedValue(HISTORY);
  subs.subscribe.mockResolvedValue(null);
  subs.cancel.mockResolvedValue(null);
  listPlans.mockResolvedValue(TIERS);
  createAccount.mockResolvedValue({ ...ACCOUNTS[0], minDepositHint: null });
  balances.mockImplementation(async (id: string) => [
    toWalletBalance({ _id: `w-${id}`, accountId: id, currency: 'INR', balance: id === 'a1' ? '40' : '100000', locked: '0', free: '0' }),
  ]);
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = null;
});

/* ══ Plans ═══════════════════════════════════════════════════════════ */

describe('PlansScreen', () => {
  it('shows the plan, the Main Wallet it is billed from, the cards, the comparison and the plan billing history', async () => {
    // Ten days out from now, so "in N days" does not depend on the run date.
    const nextBilling = new Date(Date.now() + 10 * 86400000).toISOString();
    subs.me.mockResolvedValue(me({
      subscription: { _id: 's1', planCode: 'PREMIUM', status: 'ACTIVE', billingCycle: 'MONTHLY', expiresAt: nextBilling },
      effectivePlan: RAW_PREMIUM,
      isLowBalance: true,
    }));
    const r = await mount('Plans', PlansScreen as ComponentType<never>);
    const text = screenText(r);
    expect(subs.history).toHaveBeenCalledWith({ limit: 100 });
    expect(text).toContain('Plans & Pricing');
    expect(text).toContain('Upgrade for lower trading fees, more accounts, premium support, and exclusive perks.');
    // The Current Subscription card — EquityHub's "Next Billing Date", not "Renews …".
    expect(text).toContain('Current Subscription');
    expect(text).toContain('Started On');
    expect(text).toContain(`Next Billing Date ${fmtPlanDate(nextBilling)} in 10 days`);
    expect(text).toContain('Amount Collected');
    expect(text).toContain('Monthly Subscription');
    expect(text).toContain('Remaining Deposit');
    expect(text).toContain('This is a monthly plan, billed each cycle from your Main Wallet.');
    expect(text).toContain('Plan Details');
    expect(text).toContain('How Postpaid Works');
    expect(text).not.toMatch(/Renews|Next bill /);
    expect(text).toContain('Cancel subscription');
    expect(text).toContain('Billing Source: Main Wallet');
    expect(text).toContain('Low');
    expect(text).toContain('₹50.00');
    expect(text).toContain('Top up →');
    expect(text).toContain('⚠ Ensure sufficient balance is available in your Main Wallet before the renewal date.');
    // Cards
    expect(text).toContain('✓ Current plan');
    expect(text).toContain('Most Popular');
    expect(text).toContain('Pay as you trade');
    expect(text).toContain('₹29.99');
    expect(text).toContain('/ month');
    expect(text).toContain('per device / month');
    expect(text).toContain('₹5');
    expect(text).toContain('₹25/month');
    expect(text).toContain('Switch to Free');
    expect(text).toContain('Activate Post Paid');
    expect(text).toContain('Insufficient balance'); // VIP at ₹99 against ₹50
    expect(text).toContain('Top up to upgrade →');
    // Copy-trading bullets are hidden.
    expect(text).toContain('5 trading accounts');
    expect(text).not.toContain('Copy-Trading pro');
    expect(text).not.toContain('Copy trading access');
    // Comparison
    expect(text).toContain('Compare features');
    for (const label of ['Maintenance fee', 'Trading accounts', 'All instruments', '24/7 access', 'API access', 'Devices login', 'Support']) {
      expect(text).toContain(label);
    }
    expect(text).toContain('Unlimited');
    expect(text).toContain('Dedicated');
    // Billing & Subscription History: the plan-period timeline, rebuilt from
    // plan charges only — the deposit and the refund are not periods.
    expect(text).toContain('Billing & Subscription History');
    expect(text).toContain('Total Billing −₹29.99');
    // The charge has no planCode; as the newest one it adopts the plan running now.
    expect(text).toContain('PREMIUM MONTHLY Active Premium Monthly Plan Monthly Subscription −₹29.99');
    expect(text).toContain('Showing 1 to 1 of 1 records');
    expect(text).not.toContain('₹100.00');
    expect(text).not.toContain('₹10.00');
  });

  it('pays for a plan from the Main Wallet after the confirmation, then reloads', async () => {
    const r = await mount('Plans', PlansScreen as ComponentType<never>);
    await press(byText(r, 'Pay from wallet · ₹29.99'));
    let text = screenText(r);
    expect(text).toContain('Confirm subscription');
    expect(text).toContain('Amount due');
    expect(text).toContain('After payment');
    expect(text).toContain('₹20.01');
    expect(text).toContain('Plan purchases and renewals are deducted from your Main Wallet (INR) immediately.');
    expect(text).not.toContain('Old Main Wallet');
    expect(subs.subscribe).not.toHaveBeenCalled();

    await press(byText(r, 'Pay ₹29.99 & subscribe'));
    expect(subs.subscribe).toHaveBeenCalledWith({ planCode: 'PREMIUM', billingCycle: 'MONTHLY' });
    expect(toasts()).toContain('success:Subscribed to Premium · 29.99 deducted from your Main Wallet');
    expect(subs.plans).toHaveBeenCalledTimes(2);
    text = screenText(r);
    expect(text).not.toContain('Confirm subscription');
  });

  it('bills yearly when Yearly is on', async () => {
    subs.me.mockResolvedValue(me({ balance: '500' }));
    const r = await mount('Plans', PlansScreen as ComponentType<never>);
    await press(byLabel(r, 'Bill yearly'));
    let text = screenText(r);
    expect(text).toContain('/ year');
    expect(text).toContain('₹299');
    // VIP is ₹990 a year against ₹500.
    expect(isDisabled(byText(r, 'Insufficient balance'))).toBe(true);
    await press(byText(r, 'Pay from wallet · ₹299.00'));
    text = screenText(r);
    expect(text).toContain('Yearly');
    expect(text).toContain('₹201.00');
    await press(byText(r, 'Pay ₹299.00 & subscribe'));
    expect(subs.subscribe).toHaveBeenCalledWith({ planCode: 'PREMIUM', billingCycle: 'YEARLY' });
    expect(toasts()).toContain('success:Subscribed to Premium · 299.00 deducted from your Main Wallet');
  });

  it('the confirm button is disabled when the wallet cannot cover the price', async () => {
    subs.me.mockResolvedValue(me({ balance: '30' }));
    const r = await mount('Plans', PlansScreen as ComponentType<never>);
    await press(byText(r, 'Pay from wallet · ₹29.99'));
    expect(isDisabled(byText(r, 'Pay ₹29.99 & subscribe'))).toBe(false);
    await act(async () => { renderer?.unmount(); });
    // The card itself refuses when the balance is short, so the modal is never reached.
    subs.me.mockResolvedValue(me({ balance: '29.98' }));
    const r2 = await mount('Plans', PlansScreen as ComponentType<never>);
    expect(screenText(r2)).not.toContain('Pay from wallet · ₹29.99');
    expect(isDisabled(byText(r2, 'Insufficient balance'))).toBe(true);
  });

  it('a 402 opens the recharge prompt with the server figures, and "Add funds" goes to the Main Wallet', async () => {
    subs.subscribe.mockRejectedValueOnce(axiosError(402, {
      code: 'INSUFFICIENT_SUBSCRIPTION_BALANCE',
      message: 'Insufficient balance',
      details: { balance: '20', needed: '29.99', shortfall: '9.99', currency: 'INR' },
    }));
    const r = await mount('Plans', PlansScreen as ComponentType<never>);
    await press(byText(r, 'Pay from wallet · ₹29.99'));
    await press(byText(r, 'Pay ₹29.99 & subscribe'));
    const text = screenText(r);
    expect(text).toContain('Recharge required');
    expect(text).toContain('Not enough balance in your Main Wallet to subscribe to Premium.');
    expect(text).toContain('₹20.00');
    expect(text).toContain('₹9.99');
    expect(text).not.toContain('Confirm subscription');
    expect(toasts().filter((t) => t.startsWith('error:'))).toEqual([]);
    await press(byText(r, 'Add funds →'));
    expect(screenText(r)).toContain('route:BonusWallet:{}');
  });

  it('an unaffordable plan is disabled and offers the top-up link', async () => {
    const r = await mount('Plans', PlansScreen as ComponentType<never>);
    expect(isDisabled(byText(r, 'Insufficient balance'))).toBe(true);
    await press(byText(r, 'Top up to upgrade →'));
    // Plans are billed from the Bonus Wallet, so the top-up goes there.
    expect(screenText(r)).toContain('route:BonusWallet:{}');
  });

  it('switching to Free asks first and sends no payment method', async () => {
    subs.me.mockResolvedValue(me({ subscription: { _id: 's1', planCode: 'PREMIUM', status: 'ACTIVE' }, effectivePlan: RAW_PREMIUM }));
    const r = await mount('Plans', PlansScreen as ComponentType<never>);
    await press(byText(r, 'Switch to Free'));
    expect(screenText(r)).toContain('Switch to Free? Your paid features will end immediately.');
    await press(byText(r, 'Confirm'));
    expect(subs.subscribe).toHaveBeenCalledWith({ planCode: 'FREE', billingCycle: 'MONTHLY' });
    expect(toasts()).toContain('success:Switched to Free');
  });

  it('Post-Paid: a cancelled confirm sends nothing and leaves the buttons live', async () => {
    const r = await mount('Plans', PlansScreen as ComponentType<never>);
    await press(byText(r, 'Activate Post Paid'));
    expect(screenText(r)).toContain("Activate Post Paid? You'll be billed per trade plus a monthly maintenance fee.");
    await press(byText(r, 'Cancel'));
    expect(subs.subscribe).not.toHaveBeenCalled();
    expect(isDisabled(byText(r, 'Activate Post Paid'))).toBe(false);
    await press(byText(r, 'Activate Post Paid'));
    await press(byText(r, 'Confirm'));
    expect(subs.subscribe).toHaveBeenCalledWith({ planCode: 'POSTPAID', billingCycle: 'MONTHLY' });
    expect(toasts()).toContain('success:Post Paid activated');
  });

  it('cancels the subscription with the web reason after the confirm', async () => {
    subs.me.mockResolvedValue(me({ subscription: { _id: 's1', planCode: 'PREMIUM', status: 'ACTIVE' }, effectivePlan: RAW_PREMIUM }));
    const r = await mount('Plans', PlansScreen as ComponentType<never>);
    await press(byText(r, 'Cancel subscription'));
    expect(screenText(r)).toContain('Cancel your subscription? You will be downgraded to Free at the end of your billing period.');
    await press(byText(r, 'Confirm'));
    expect(subs.cancel).toHaveBeenCalledWith('User requested');
    expect(toasts()).toContain('success:Subscription cancelled');
  });

  it('a failed load shows the server’s message with a retry; a failed history does not', async () => {
    subs.plans.mockRejectedValueOnce(axiosError(500, { message: 'Plans are unavailable' }));
    const r = await mount('Plans', PlansScreen as ComponentType<never>);
    expect(screenText(r)).toContain('Plans are unavailable');
    // Told once, by the ErrorView — not a toast on top of it.
    expect(toasts()).toEqual([]);
    await press(byText(r, 'Try again'));
    expect(screenText(r)).toContain('Plans & Pricing');

    await act(async () => { renderer?.unmount(); });
    subs.history.mockRejectedValueOnce(new Error('boom'));
    const r2 = await mount('Plans', PlansScreen as ComponentType<never>);
    // BillingHistory.jsx's empty row; the rest of the page still renders.
    expect(screenText(r2)).toContain('No subscription history yet.');
    expect(screenText(r2)).toContain('Compare features');
  });
});

/* ══ NewAccountTiers ═════════════════════════════════════════════════ */

describe('NewAccountTiersScreen', () => {
  it('groups the tiers, shows what the user holds, and continues with the chosen tier', async () => {
    const r = await mount('NewAccountTiers', NewAccountTiersScreen as ComponentType<never>);
    expect(storeLoad()).toHaveBeenCalled();
    const text = screenText(r);
    expect(text).toContain('WalletNav:null');
    expect(text).toContain('Open account');
    for (const g of ['Standard accounts', 'Professional accounts', 'Free accounts', 'Other']) expect(text).toContain(g);
    expect(text).toContain('✓ 1');
    // NewAccountTiers.jsx: `fmtMoney(minDep, 'INR', 0)` — whole rupees.
    expect(text).toContain('Min deposit ₹100');
    expect(text).toContain('Min deposit ₹1,000');
    expect(text).not.toContain('USD');
    expect(text).toContain('No min');
    expect(text).toContain('1:100');
    expect(text).toContain('1:Unlimited');
    expect(text).toContain('Commission · Percentage — 0.005% of trade value');
    expect(text).toContain('Charges · Percentage of Profit — 10% of profit');
    expect(text).toContain('Buy-close only');
    expect(text).toContain('Buy / Sell · no restrictions');
    // The first tier is preselected.
    expect(text).toContain('Selected:');

    await press(byText(r, 'Pro'));
    await press(byText(r, 'Continue →'));
    expect(screenText(r)).toContain('route:NewAccountConfigure:{"tierCode":"PRO"}');
  });

  it('continues with the preselected first tier', async () => {
    const r = await mount('NewAccountTiers', NewAccountTiersScreen as ComponentType<never>);
    await press(byText(r, 'Continue →'));
    expect(screenText(r)).toContain('route:NewAccountConfigure:{"tierCode":"STANDARD"}');
  });

  it('an empty catalogue says so and offers no Continue', async () => {
    listPlans.mockResolvedValueOnce([]);
    const r = await mount('NewAccountTiers', NewAccountTiersScreen as ComponentType<never>);
    const text = screenText(r);
    expect(text).toContain('No tiers available. Ask an admin to enable some.');
    expect(text).not.toContain('Continue →');
  });

  it('a failed catalogue load shows the error and retries', async () => {
    listPlans.mockRejectedValueOnce(axiosError(500, { message: 'Catalogue down' }));
    const r = await mount('NewAccountTiers', NewAccountTiersScreen as ComponentType<never>);
    expect(screenText(r)).toContain('Catalogue down');
    await press(byText(r, 'Try again'));
    expect(screenText(r)).toContain('Standard accounts');
  });

  it('the back arrow goes to the Wallet', async () => {
    const r = await mount('NewAccountTiers', NewAccountTiersScreen as ComponentType<never>);
    await press(byLabel(r, 'Back'));
    expect(screenText(r)).toContain('route:Wallet:{}');
  });
});

/* ══ NewAccountConfigure ═════════════════════════════════════════════ */

describe('NewAccountConfigureScreen', () => {
  // After creating, the web goes to `/wallet?view=accounts` — not a Wallet
  // view, so it opens on its default (overview); the app goes to the Wallet as is.
  it('a real account: tier defaults, the below-minimum warning, the web payload, then the Wallet', async () => {
    const r = await mount('NewAccountConfigure', NewAccountConfigureScreen as ComponentType<never>, { tierCode: 'STANDARD' }, ['NewAccountTiers']);
    const text = screenText(r);
    expect(text).toContain('New Standard Account');
    expect(text).toContain('Account configuration');
    expect(text).toContain('Min ₹100 · 1:100 · Fee Commission · Percentage — 0.005% of trade value');
    expect(text).toContain('✓ 1 active');
    expect(text).toContain('start with a ₹1,00,000 virtual seed.');
    // Real money only: ₹40 on the STANDARD account; the demo's ₹1,00,000 does not count.
    expect(text).toContain('Below minimum deposit');
    expect(text).toContain('₹40.00');
    expect(text).toContain('Tier needs  ₹100');
    expect(text).toContain('₹60.00');
    expect(text).toContain('This tier caps leverage at');
    expect(text).toContain('1:100');
    // INR-only: a fixed field, not a picker.
    expect(text).toContain('Base currency INR (₹) Fixed');
    expect(inputs(r)[0]?.props.value).toBe('Standard');

    await press(byText(r, 'Create Real Account'));
    expect(createAccount).toHaveBeenCalledWith({ accountType: 'STANDARD', baseCurrency: 'INR', leverage: 100, nickname: 'Standard' });
    expect(toasts()).toContain('success:Standard account created');
    expect(storeLoad().mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screenText(r)).toContain('route:Wallet:{}');
  });

  it('demo mode: practice nickname, fixed 1:Unlimited, no warning, the demo payload', async () => {
    const r = await mount('NewAccountConfigure', NewAccountConfigureScreen as ComponentType<never>, { tierCode: 'STANDARD' });
    await press(byText(r, 'Demo Account'));
    const text = screenText(r);
    expect(inputs(r)[0]?.props.value).toBe('Standard Practice');
    expect(text).toContain('Fixed');
    expect(text).toContain('Demo accounts always run at');
    expect(text).not.toContain('Below minimum deposit');
    await press(byText(r, 'Create Demo Account'));
    // The chosen tier rides along in tierCode, as the web sends it.
    expect(createAccount).toHaveBeenCalledWith({
      accountType: 'DEMO', tierCode: 'STANDARD', baseCurrency: 'INR', leverage: 999999, nickname: 'Standard Practice', initialBalance: 100000,
    });
    expect(toasts()).toContain('success:Demo account created');
  });

  it('keeps a typed nickname across mode changes', async () => {
    const r = await mount('NewAccountConfigure', NewAccountConfigureScreen as ComponentType<never>, { tierCode: 'STANDARD' });
    await type(inputs(r)[0], 'My book');
    await press(byText(r, 'Demo Account'));
    expect(inputs(r)[0]?.props.value).toBe('My book');
    await press(byText(r, 'Real Account'));
    expect(inputs(r)[0]?.props.value).toBe('My book');
  });

  it('the leverage ladder locks above the cap, and Custom is clamped to it', async () => {
    const r = await mount('NewAccountConfigure', NewAccountConfigureScreen as ComponentType<never>, { tierCode: 'STANDARD' });
    await press(byLabel(r, 'Leverage'));
    const locked = r.root.findAll((n) => n.props.accessibilityLabel === '1:200, locked' && typeof n.props.onPress === 'function')[0];
    expect(isDisabled(locked)).toBe(true);
    expect(r.root.findAll((n) => n.props.accessibilityLabel === '1:Unlimited, locked').length).toBeGreaterThan(0);
    await press(byLabel(r, '1:50'));
    expect(screenText(r)).toContain('1:50');

    await press(byLabel(r, 'Leverage'));
    await press(byLabel(r, 'Custom'));
    expect(screenText(r)).toContain('Custom · 1:50');
    const custom = r.root.findAll((n) => n.type === 'TextInput' && n.props.accessibilityLabel === 'Custom leverage')[0];
    await type(custom, '150');
    expect(screenText(r)).toContain('Custom · 1:100');

    await press(byText(r, 'Create Real Account'));
    expect(createAccount).toHaveBeenCalledWith(expect.objectContaining({ accountType: 'STANDARD', leverage: 100 }));
  });

  it('an uncapped tier defaults to 1:Unlimited and sends 999999; base currency is fixed at INR', async () => {
    const r = await mount('NewAccountConfigure', NewAccountConfigureScreen as ComponentType<never>, { tierCode: 'PRO' });
    const text = screenText(r);
    expect(text).toContain('1:Unlimited');
    expect(text).not.toContain('This tier caps leverage at');
    // Nothing to pick: the web shows "INR (₹)" with a Fixed badge.
    expect(byLabel(r, 'Base currency')).toBeUndefined();
    expect(text).toContain('INR (₹)');
    await press(byText(r, 'Create Real Account'));
    expect(createAccount).toHaveBeenCalledWith({ accountType: 'PRO', baseCurrency: 'INR', leverage: 999999, nickname: 'Pro' });
  });

  it('shows the server’s refusal and stays on the form', async () => {
    createAccount.mockRejectedValueOnce(axiosError(403, {
      code: 'PLAN_LIMIT_REACHED',
      message: 'Your FREE plan allows max 1 accounts (you have 1). Upgrade to add more.',
    }));
    const r = await mount('NewAccountConfigure', NewAccountConfigureScreen as ComponentType<never>, { tierCode: 'STANDARD' });
    await press(byText(r, 'Create Real Account'));
    expect(toasts()).toContain('error:Your FREE plan allows max 1 accounts (you have 1). Upgrade to add more.');
    expect(screenText(r)).toContain('Account configuration');
  });

  it('an unknown tier toasts the web message and goes back to the tier list', async () => {
    const r = await mount('NewAccountConfigure', NewAccountConfigureScreen as ComponentType<never>, { tierCode: 'NOPE' });
    expect(toasts()).toContain('error:Plan "NOPE" not found');
    expect(screenText(r)).toContain('route:NewAccountTiers:{}');
  });

  it('"← Change tier" returns to the tier list already in the stack', async () => {
    const r = await mount('NewAccountConfigure', NewAccountConfigureScreen as ComponentType<never>, { tierCode: 'STANDARD' }, ['NewAccountTiers']);
    await press(byText(r, '← Change tier'));
    expect(screenText(r)).toContain('route:NewAccountTiers:{}');
    expect(screenText(r)).not.toContain('Account configuration');
  });
});

/* ══ Review fixes ════════════════════════════════════════════════════ */

describe('survives an effect replay (StrictMode / Fast Refresh)', () => {
  it('Plans still lands its data', async () => {
    const r = await mount('Plans', PlansScreen as ComponentType<never>, undefined, [], { strict: true });
    expect(screenText(r)).toContain('Plans & Pricing');
  });

  it('NewAccountTiers still lands its data', async () => {
    const r = await mount('NewAccountTiers', NewAccountTiersScreen as ComponentType<never>, undefined, [], { strict: true });
    expect(screenText(r)).toContain('Standard accounts');
  });

  it('NewAccountConfigure still lands its data', async () => {
    const r = await mount('NewAccountConfigure', NewAccountConfigureScreen as ComponentType<never>, { tierCode: 'STANDARD' }, [], { strict: true });
    expect(screenText(r)).toContain('Account configuration');
  });
});

/** Two taps delivered before React re-renders (both in one act). */
const doubleTap = async (node: TestNode | undefined): Promise<void> => {
  if (!node) throw new Error('node not found');
  const onPress = node.props.onPress as () => void;
  await act(async () => { onPress(); onPress(); });
  await settle();
};

/** Every style object from `node` up to (not beyond) the screen component `top`. */
const ancestorStyles = (node: TestNode | undefined, top: unknown): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  const flat = (s: unknown): void => {
    if (!s) return;
    if (Array.isArray(s)) { s.forEach(flat); return; }
    if (typeof s === 'object') out.push(s as Record<string, unknown>);
  };
  for (let n = node ?? null; n && n.type !== top; n = n.parent) {
    // Pressable's style is a function of its pressed state.
    const st = n.props.style;
    flat(typeof st === 'function' ? (st as (s: { pressed: boolean }) => unknown)({ pressed: false }) : st);
  }
  return out;
};

describe('a second tap before the re-render sends nothing', () => {
  it('"Pay ₹X & subscribe" debits the Main Wallet once', async () => {
    let release: () => void = () => {};
    subs.subscribe.mockImplementationOnce(() => new Promise((res) => { release = () => res(null); }));
    const r = await mount('Plans', PlansScreen as ComponentType<never>);
    await press(byText(r, 'Pay from wallet · ₹29.99'));
    await doubleTap(byText(r, 'Pay ₹29.99 & subscribe'));
    expect(subs.subscribe).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
    await settle();
    expect(toasts()).toContain('success:Subscribed to Premium · 29.99 deducted from your Main Wallet');
  });

  it('the guard is released after a failure, so the user can try again', async () => {
    subs.subscribe.mockRejectedValueOnce(axiosError(500, { message: 'Try later' }));
    const r = await mount('Plans', PlansScreen as ComponentType<never>);
    await press(byText(r, 'Pay from wallet · ₹29.99'));
    await press(byText(r, 'Pay ₹29.99 & subscribe'));
    expect(toasts()).toContain('error:Try later');
    await press(byText(r, 'Pay ₹29.99 & subscribe'));
    expect(subs.subscribe).toHaveBeenCalledTimes(2);
  });

  it('"Create Real Account" opens one account', async () => {
    let release: () => void = () => {};
    createAccount.mockImplementationOnce(() => new Promise((res) => { release = () => res({ ...ACCOUNTS[0], minDepositHint: null }); }));
    const r = await mount('NewAccountConfigure', NewAccountConfigureScreen as ComponentType<never>, { tierCode: 'STANDARD' }, ['Wallet', 'NewAccountTiers']);
    await doubleTap(byText(r, 'Create Real Account'));
    expect(createAccount).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
    await settle();
    expect(screenText(r)).toContain('route:Wallet:{}');
  });

  it('after a refusal the Create button works again', async () => {
    createAccount.mockRejectedValueOnce(axiosError(400, { message: 'Nope' }));
    const r = await mount('NewAccountConfigure', NewAccountConfigureScreen as ComponentType<never>, { tierCode: 'STANDARD' });
    await press(byText(r, 'Create Real Account'));
    expect(toasts()).toContain('error:Nope');
    await press(byText(r, 'Create Real Account'));
    expect(createAccount).toHaveBeenCalledTimes(2);
  });
});

describe('NewAccountConfigure — the action bar does not cover the form', () => {
  it('sits in flow under the scroll view (nothing absolute), and the form leaves the bottom inset to it', async () => {
    const r = await mount('NewAccountConfigure', NewAccountConfigureScreen as ComponentType<never>, { tierCode: 'STANDARD' });
    const create = byText(r, 'Create Real Account');
    expect(create).toBeDefined();
    expect(ancestorStyles(create, NewAccountConfigureScreen).some((s) => s.position === 'absolute')).toBe(false);
    // The bar is not inside the ScrollView that holds the fields…
    const scrolls = r.root.findAll((n) => n.type === 'RCTScrollView' || (typeof n.type === 'function' && (n.type as { displayName?: string }).displayName === 'ScrollView'));
    const nickname = inputs(r)[0];
    const inside = (node: TestNode | undefined, container: TestNode): boolean => {
      for (let n = node ?? null; n; n = n.parent) if (n === container) return true;
      return false;
    };
    const formScroll = scrolls.find((s) => inside(nickname, s));
    expect(formScroll).toBeDefined();
    expect(inside(create, formScroll as TestNode)).toBe(false);
    // …and it takes the bottom safe-area inset (34 in these metrics) itself.
    expect(ancestorStyles(create, NewAccountConfigureScreen).some((s) => s.paddingBottom === 8 + METRICS.insets.bottom)).toBe(true);
  });
});

describe('Plans — back from a top-up', () => {
  it('reloads on return, so a plan the new balance covers is payable at once', async () => {
    const r = await mount('Plans', PlansScreen as ComponentType<never>);
    expect(isDisabled(byText(r, 'Insufficient balance'))).toBe(true); // VIP ₹99 against ₹50
    expect(subs.me).toHaveBeenCalledTimes(1);

    await press(byText(r, 'Top up →'));
    expect(screenText(r)).toContain('route:BonusWallet:{}');
    subs.me.mockResolvedValue(me({ balance: '500' }));
    await act(async () => { navRef.goBack(); });
    await settle();

    expect(subs.me).toHaveBeenCalledTimes(2);
    const text = screenText(r);
    expect(text).toContain('₹500.00');
    expect(text).toContain('Pay from wallet · ₹99.00');
    expect(text).not.toContain('Insufficient balance');
  });

  it('does not load twice on first arrival', async () => {
    await mount('Plans', PlansScreen as ComponentType<never>);
    expect(subs.plans).toHaveBeenCalledTimes(1);
  });

  it('an overtaken refresh does not land on top of a newer one', async () => {
    const r = await mount('Plans', PlansScreen as ComponentType<never>);
    // Refresh #1 (slow, old balance) then refresh #2 (fast, new balance).
    let releaseOld: () => void = () => {};
    subs.me
      .mockImplementationOnce(() => new Promise((res) => { releaseOld = () => res(me({ balance: '1' })); }))
      .mockResolvedValueOnce(me({ balance: '777' }));
    await press(byText(r, 'Top up →'));
    await act(async () => { navRef.goBack(); });
    await press(byText(r, 'Top up →'));
    await act(async () => { navRef.goBack(); });
    await settle();
    expect(screenText(r)).toContain('₹777.00');
    await act(async () => { releaseOld(); });
    await settle();
    expect(screenText(r)).toContain('₹777.00');
    expect(screenText(r)).not.toContain('₹1.00');
  });
});

/** Pull to refresh: the RefreshControl the Screen hands the ScrollView. */
const pullToRefresh = async (r: Renderer): Promise<void> => {
  const rc = r.root.findAll((n) => typeof n.props.onRefresh === 'function' && n.props.refreshing !== undefined)[0];
  if (!rc) throw new Error('no RefreshControl');
  await act(async () => { await (rc.props.onRefresh as () => Promise<void>)(); });
  await settle();
};

describe('one message per failed load', () => {
  it('NewAccountTiers: a failed first load is told by the ErrorView alone; a failed refresh keeps the list and toasts', async () => {
    listPlans.mockRejectedValueOnce(axiosError(500, { message: 'Catalogue down' }));
    const r = await mount('NewAccountTiers', NewAccountTiersScreen as ComponentType<never>);
    expect(screenText(r)).toContain('Catalogue down');
    expect(toasts()).toEqual([]);

    await press(byText(r, 'Try again'));
    expect(screenText(r)).toContain('Standard accounts');
    listPlans.mockRejectedValueOnce(axiosError(500, { message: 'Catalogue down' }));
    await pullToRefresh(r);
    expect(toasts()).toEqual(['error:Catalogue down']);
    expect(screenText(r)).toContain('Standard accounts');
  });

  it('NewAccountConfigure: the same rule', async () => {
    listPlans.mockRejectedValueOnce(axiosError(500, { message: 'Catalogue down' }));
    const r = await mount('NewAccountConfigure', NewAccountConfigureScreen as ComponentType<never>, { tierCode: 'STANDARD' });
    expect(screenText(r)).toContain('Catalogue down');
    expect(toasts()).toEqual([]);

    await press(byText(r, 'Try again'));
    expect(screenText(r)).toContain('Account configuration');
    listPlans.mockRejectedValueOnce(axiosError(500, { message: 'Catalogue down' }));
    await pullToRefresh(r);
    expect(toasts()).toEqual(['error:Catalogue down']);
    expect(screenText(r)).toContain('Account configuration');
  });
});

/* ══ Review pass 2 ═══════════════════════════════════════════════════ */

describe('Plans — one message per failed load', () => {
  it('a failed refresh keeps the page and toasts the server’s message', async () => {
    const r = await mount('Plans', PlansScreen as ComponentType<never>);
    expect(screenText(r)).toContain('Plans & Pricing');
    subs.me.mockRejectedValueOnce(axiosError(500, { message: 'Try again shortly' }));
    await pullToRefresh(r);
    expect(toasts()).toEqual(['error:Try again shortly']);
    expect(screenText(r)).toContain('Plans & Pricing');
    expect(screenText(r)).toContain('Compare features');
  });
});

describe('Plans — the ribbon is drawn above its card on Android', () => {
  /** The absolutely-positioned wrapper around a ribbon's label. */
  const ribbonOf = (r: Renderer, label: string): Record<string, unknown> | undefined => {
    let n: TestNode | null | undefined = r.root.findAll((x) => x.props.children === label)[0];
    for (; n; n = n.parent) {
      const flat = [n.props.style].flat(3).filter(Boolean) as Record<string, unknown>[];
      const merged = Object.assign({}, ...flat) as Record<string, unknown>;
      if (merged.position === 'absolute') return merged;
    }
    return undefined;
  };

  it('outranks the card’s elevation (the popular card is shadow.elevated)', async () => {
    const r = await mount('Plans', PlansScreen as ComponentType<never>);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shadow } = require('@/theme') as { shadow: { card: { elevation: number }; elevated: { elevation: number } } };
    for (const label of ['Most Popular', 'Pay as you trade']) {
      const ribbon = ribbonOf(r, label);
      expect(ribbon).toBeDefined();
      expect(Number(ribbon?.elevation)).toBeGreaterThan(shadow.elevated.elevation);
      expect(Number(ribbon?.elevation)).toBeGreaterThan(shadow.card.elevation);
    }
  });
});

describe('NewAccountTiers — admin labels that repeat', () => {
  it('shows every chip, with no duplicate-key warning', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    listPlans.mockResolvedValueOnce([
      toAccountPlan({ _id: 'd1', code: 'STANDARD', name: 'Standard', minDeposit: 0, maxLeverage: 100, feeKind: 'PCT_OF_VALUE', instrumentsLabel: 'Included', accessLabel: 'Included', supportLabel: 'Included', isActive: true }),
    ]);
    const r = await mount('NewAccountTiers', NewAccountTiersScreen as ComponentType<never>);
    expect(r.root.findAll((n) => n.props.children === 'Included' && typeof n.type !== 'string').length).toBeGreaterThanOrEqual(3);
    const dupes = errors.mock.calls.filter((c) => c.some((a) => typeof a === 'string' && /same key/i.test(a)));
    errors.mockRestore();
    expect(dupes).toEqual([]);
  });
});

describe('LeverageSelect — the Custom field can be cleared and retyped', () => {
  const customField = (r: Renderer): TestNode | undefined =>
    r.root.findAll((n) => n.type === 'TextInput' && n.props.accessibilityLabel === 'Custom leverage')[0];

  it('an emptied field stays empty (value 1, as the web sends), and 75 typed after it is 75, not 175', async () => {
    const r = await mount('NewAccountConfigure', NewAccountConfigureScreen as ComponentType<never>, { tierCode: 'PRO' });
    await press(byLabel(r, 'Leverage'));
    await press(byLabel(r, 'Custom'));
    expect(customField(r)?.props.value).toBe('999999');

    await type(customField(r), '');
    expect(customField(r)?.props.value).toBe('');
    expect(screenText(r)).toContain('Custom · 1:1'); // the web's `Number('') || 1`

    await type(customField(r), '75');
    expect(customField(r)?.props.value).toBe('75');
    expect(screenText(r)).toContain('Custom · 1:75');

    // Leaving the field shows the value again.
    await act(async () => { (customField(r)?.props.onBlur as () => void)(); });
    expect(customField(r)?.props.value).toBe('75');

    await press(byText(r, 'Create Real Account'));
    expect(createAccount).toHaveBeenCalledWith({ accountType: 'PRO', baseCurrency: 'INR', leverage: 75, nickname: 'Pro' });
  });

  it('over the cap the field reads the cap, as the web’s does', async () => {
    const r = await mount('NewAccountConfigure', NewAccountConfigureScreen as ComponentType<never>, { tierCode: 'STANDARD' });
    await press(byLabel(r, 'Leverage'));
    await press(byLabel(r, 'Custom'));
    await type(customField(r), '');
    await type(customField(r), '150');
    expect(customField(r)?.props.value).toBe('100');
    expect(screenText(r)).toContain('Custom · 1:100');
  });

  it('leaving Custom and coming back shows the value, not an old draft', async () => {
    const r = await mount('NewAccountConfigure', NewAccountConfigureScreen as ComponentType<never>, { tierCode: 'STANDARD' });
    await press(byLabel(r, 'Leverage'));
    await press(byLabel(r, 'Custom'));
    await type(customField(r), '');
    await press(byLabel(r, 'Close custom leverage'));
    expect(customField(r)).toBeUndefined();
    await press(byLabel(r, 'Leverage'));
    await press(byLabel(r, '1:20'));
    await press(byLabel(r, 'Leverage'));
    await press(byLabel(r, 'Custom'));
    expect(customField(r)?.props.value).toBe('20');
  });
});
