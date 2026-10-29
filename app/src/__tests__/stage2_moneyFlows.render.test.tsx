/**
 * Render tests for EquityHub's money flows: DepositView, WithdrawView and the
 * withdrawal-methods manager, each mounted in a real native stack with the
 * overlay layer and the confirm provider, the API modules replaced by
 * in-memory stand-ins. Covers what a pure-logic test cannot: which step is
 * on screen, what a button is allowed to do, and which call went out with
 * what — including that Razorpay's verify is posted only from Checkout's
 * success handler, and never for a mock order.
 *
 * No network, no device.
 */
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React, { act, useState } from 'react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

jest.mock('react-native-webview', () => {
  const R = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return { WebView: (p: object) => R.createElement(View, { ...p, testID: 'webview' }) };
});

jest.mock('@/services/proofImage', () => ({ pickProofImage: jest.fn() }));

// The live channels, as in-memory emitters: `mockLive.wallet.forEach(f => f())`
// is a `user:wallet` frame; `foreground` is the app coming back.
const mockLive = {
  wallet: new Set<() => void>(),
  positions: new Set<() => void>(),
  foreground: new Set<() => void>(),
};
jest.mock('@/websocket/channels', () => {
  const R = jest.requireActual('react');
  return {
    subscribeWallet: (cb: () => void) => { mockLive.wallet.add(cb); return () => { mockLive.wallet.delete(cb); }; },
    subscribePositions: (cb: () => void) => { mockLive.positions.add(cb); return () => { mockLive.positions.delete(cb); }; },
    useForeground: (cb: () => void) => {
      const ref = R.useRef(cb);
      ref.current = cb;
      R.useEffect(() => {
        const f = (): void => ref.current();
        mockLive.foreground.add(f);
        return () => { mockLive.foreground.delete(f); };
      }, []);
    },
  };
});

jest.mock('@/store/selectedAccount', () => {
  const { create } = jest.requireActual('zustand');
  const useSelectedAccountStore = create(() => ({
    accounts: [],
    selectedId: null,
    loading: false,
    error: null,
    load: jest.fn(async () => {}),
    select: jest.fn(),
    reset: jest.fn(),
  }));
  return { useSelectedAccountStore };
});

jest.mock('@/api/account.api', () => ({ accountApi: { listPlans: jest.fn() } }));

jest.mock('@/api/wallet.api', () => ({
  walletApi: {
    balances: jest.fn(),
    withdrawals: jest.fn(),
    depositDetails: jest.fn(),
    createDeposit: jest.fn(),
    razorpayOrder: jest.fn(),
    razorpayVerify: jest.fn(),
    createWithdrawal: jest.fn(),
    withdrawalMethods: jest.fn(),
    addWithdrawalMethod: jest.fn(),
    removeWithdrawalMethod: jest.fn(),
  },
}));

/* eslint-disable import/first */
import * as Clipboard from 'expo-clipboard';

import { accountApi } from '@/api/account.api';
import { walletApi } from '@/api/wallet.api';
import { ConfirmProvider, PortalHost } from '@/components/ui';
import { toast, toastStore } from '@/components/ui/toast';
import { WithdrawalMethodsView } from '@/components/wallet/WithdrawalMethods';
import type { RootStackParamList } from '@/navigation/types';
import { DepositView } from '@/screens/wallet/views/DepositView';
import { WithdrawView } from '@/screens/wallet/views/WithdrawView';
import { pickProofImage } from '@/services/proofImage';
import { useSelectedAccountStore } from '@/store/selectedAccount';
import { ThemeProvider } from '@/theme';
import { toAccountPlan, toUserAccount } from '@/types/user';
import {
  toDepositDetails,
  toWalletBalance,
  toWithdrawal,
  toWithdrawalMethod,
} from '@/types/wallet';
import { DEPOSIT_METHODS_FAILED, RAZORPAY_NOT_SET_UP, REMOVE_METHOD_CONFIRM } from '@/utils/fundsFlows';
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

const W = walletApi as unknown as Record<string, jest.Mock>;
const A = accountApi as unknown as Record<string, jest.Mock>;

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

const toasts = (): string[] => toastStore.getState().toasts.map((x) => `${x.type}:${x.message}`);

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const Stack = createNativeStackNavigator<RootStackParamList>();

function Stub({ route }: { route: { name: string } }): React.JSX.Element {
  return <Text>{`route:${route.name}`}</Text>;
}

let renderer: Renderer | null = null;

const mount = async (el: React.ReactElement): Promise<Renderer> => {
  function WalletRoute(): React.JSX.Element {
    return el;
  }
  await act(async () => {
    renderer = create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>
          <NavigationContainer>
            <PortalHost>
              <ConfirmProvider>
                <Stack.Navigator screenOptions={{ headerShown: false, animation: 'none' }}>
                  <Stack.Screen name="Wallet" component={WalletRoute as never} />
                  <Stack.Screen name="Helpdesk" component={Stub as never} />
                  <Stack.Screen name="NewAccountTiers" component={Stub as never} />
                </Stack.Navigator>
              </ConfirmProvider>
            </PortalHost>
          </NavigationContainer>
        </ThemeProvider>
      </SafeAreaProvider>,
    );
  });
  await settle();
  return renderer as unknown as Renderer;
};

const text = (): string => textOf(renderer?.toJSON() ?? null);

/** The nearest pressable around a node matching `pred` (the LAST match — overlays render last). */
const pressableBy = (pred: (n: TestNode) => boolean, first = false): TestNode => {
  const all = (renderer as Renderer).root.findAll(pred);
  const direct = all.filter((x) => typeof x.props.onPress === 'function');
  if (direct.length) return (first ? direct[0] : direct[direct.length - 1]) as TestNode;
  let n: TestNode | null | undefined = first ? all[0] : all[all.length - 1];
  while (n && typeof n.props.onPress !== 'function') n = n.parent;
  if (!n) throw new Error('pressable not found');
  return n;
};
const byText = (s: string, first = false): TestNode => pressableBy((x) => x.props.children === s, first);
const byLabel = (s: string): TestNode => pressableBy((x) => x.props.accessibilityLabel === s, true);
const byTestId = (s: string): TestNode => pressableBy((x) => x.props.testID === s, true);
const has = (testID: string): boolean => (renderer as Renderer).root.findAll((n) => n.props.testID === testID).length > 0;

const press = async (node: TestNode): Promise<void> => {
  if (node.props.disabled) throw new Error('pressed a disabled control');
  await act(async () => { (node.props.onPress as () => void)(); });
  await settle();
};

const inputs = (): TestNode[] => (renderer as Renderer).root.findAll((n) => n.type === 'TextInput');
const inputBy = (pred: (n: TestNode) => boolean): TestNode => {
  const n = inputs().find(pred);
  if (!n) throw new Error('input not found');
  return n;
};
const type = async (node: TestNode, value: string): Promise<void> => {
  await act(async () => { (node.props.onChangeText as (s: string) => void)(value); });
  await settle();
};

/* ── Fixtures ──────────────────────────────────────────────────────── */

const LIVE = toUserAccount({ _id: 'a1', accountNumber: '100234', accountType: 'STANDARD', baseCurrency: 'INR' });
const DEMO = toUserAccount({ _id: 'd1', accountNumber: '900001', accountType: 'DEMO', baseCurrency: 'INR', nickname: 'Practice' });

const DETAILS = toDepositDetails({
  UPI: { upiId: 'pay@okaxis', payeeName: 'EquityHub', feePercent: 1, minWithdrawal: 1000 },
  BANK: { accountName: 'EquityHub Pvt', accountNumber: '001122', ifsc: 'HDFC0000001', bankName: 'HDFC', withdrawalEnabled: false },
  RAZORPAY: { enabled: true },
  custom: [],
});

const METHODS = [
  toWithdrawalMethod({ id: 'u1', type: 'UPI', status: 'VERIFIED', isVerified: true, label: 'My UPI', maskedDestination: 'r**@ok' }),
  toWithdrawalMethod({ id: 'b1', type: 'BANK', status: 'VERIFIED', isVerified: true, label: 'HDFC Salary', maskedDestination: 'HDFC ••1122' }),
  toWithdrawalMethod({ id: 'p1', type: 'UPI', status: 'PENDING', label: 'New UPI', maskedDestination: 'n**@ok' }),
];

const onDone = jest.fn();
const onCancel = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  toastStore.setState({ toasts: [] });
  useSelectedAccountStore.setState({ accounts: [LIVE, DEMO], loading: false, error: null } as never);
  W.balances!.mockResolvedValue([
    toWalletBalance({ _id: 'w1', accountId: 'a1', currency: 'INR', balance: '25000', locked: '5000', free: '20000' }),
    toWalletBalance({ _id: 'w2', accountId: 'd1', currency: 'INR', balance: '100000', locked: '0', free: '100000' }),
  ]);
  W.withdrawals!.mockResolvedValue([]);
  W.depositDetails!.mockResolvedValue(DETAILS);
  W.withdrawalMethods!.mockResolvedValue(METHODS);
  W.createDeposit!.mockResolvedValue({});
  W.createWithdrawal!.mockResolvedValue({});
  A.listPlans!.mockResolvedValue([toAccountPlan({ code: 'STANDARD', name: 'Standard', minDeposit: 2000, isActive: true })]);
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = null;
  toast.dismiss();
});

/* ══ Deposit ══════════════════════════════════════════════════════════ */

describe('DepositView', () => {
  it('a practice account: no proof step, credited on the spot, in INR', async () => {
    await mount(<DepositView onDone={onDone} onCancel={onCancel} />);
    expect(text()).toContain('Add Funds');
    expect(text()).toContain('Select an account');
    expect(text()).toContain('₹1,00,000.00');
    await press(byLabel('Practice'));
    expect(text()).toContain('of 4');
    await press(byText('Continue →'));
    expect(text()).toContain('Choose payment method');
    expect(text()).not.toContain('Pay to these details');
    await press(byText('Continue →'));
    await press(byText('₹1,000'));
    expect(text()).toContain('Demo accounts are credited instantly. No payment is collected.');
    await press(byText('Continue →'));
    expect(text()).toContain('Demo funds credit instantly.');
    await press(byText('Add to Demo Account'));
    expect(W.createDeposit).toHaveBeenCalledWith({ accountId: 'd1', currency: 'INR', amount: '1000', method: 'UPI' });
    expect(toasts()).toContain('success:₹1,000.00 added to demo account!');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a live account: pay-to details, the admin fee, the tier floor, proof, then a pending deposit', async () => {
    (pickProofImage as jest.Mock).mockResolvedValue({
      ok: true,
      image: { dataUrl: 'data:image/jpeg;base64,AAAA', mimeType: 'image/jpeg', uri: 'file:///proof.jpg' },
    });
    await mount(<DepositView onDone={onDone} onCancel={onCancel} />);
    expect(text()).toContain('of 5');
    await press(byText('Continue →'));
    expect(text()).toContain('Pay to these details');
    expect(text()).toContain('pay@okaxis');
    // The tier's ₹2,000 floor binds over UPI's (none).
    expect(text()).toContain('Min · ₹2,000.00 (account tier)');
    await press(byLabel('Copy UPI ID'));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('pay@okaxis');
    expect(toasts()).toContain('success:UPI ID copied');

    await press(byText('Continue →'));
    await type(inputBy((n) => n.props.testID === 'deposit-amount'), '1500');
    expect(text()).toContain('⚠ Minimum deposit for the STANDARD plan is ₹2,000.00. You entered ₹1,500.00 — please increase the amount.');
    expect(byText('Continue →').props.disabled).toBe(true);
    await type(inputBy((n) => n.props.testID === 'deposit-amount'), '5000');
    // UPI's 1% fee: ₹50 off, ₹4,950 received.
    expect(text()).toContain('₹50.00');
    expect(text()).toContain('₹4,950.00');
    await press(byText('Continue →'));
    expect(text()).toContain('Upload payment proof');
    expect(byText('Continue →').props.disabled).toBe(true);

    await press(byLabel('Upload payment screenshot'));
    expect(text()).toContain('Screenshot ready');
    await type(inputBy((n) => n.props.placeholder === 'e.g. 4123456789012'), 'UTR98765');
    await type(inputBy((n) => n.props.placeholder === 'As on bank / UPI'), 'Ravi Kumar');
    await type(inputBy((n) => n.props.placeholder === 'yourname@upi'), 'ravi@okhdfc');
    await press(byText('Continue →'));
    expect(text()).toContain('Admin will verify your screenshot within 1–24 hours.');
    await press(byText('Confirm Deposit'));
    expect(W.createDeposit).toHaveBeenCalledWith({
      accountId: 'a1',
      currency: 'INR',
      amount: '5000',
      method: 'UPI',
      txReference: 'UTR98765',
      senderName: 'Ravi Kumar',
      senderUpiId: 'ravi@okhdfc',
      screenshot: 'data:image/jpeg;base64,AAAA',
      screenshotMimeType: 'image/jpeg',
    });
    expect(toasts()).toContain('success:Deposit submitted — pending admin verification');
  });

  it('no method is offered until the admin’s list lands; a failed list says so', async () => {
    let resolve: (d: unknown) => void = () => {};
    W.depositDetails!.mockReturnValue(new Promise((r) => { resolve = r; }));
    await mount(<DepositView onDone={onDone} onCancel={onCancel} />);
    await press(byText('Continue →'));
    expect(has('deposit-method-UPI')).toBe(false);
    expect(byText('Continue →').props.disabled).toBe(true);
    await act(async () => { resolve(DETAILS); });
    await settle();
    expect(has('deposit-method-UPI')).toBe(true);
    expect(byText('Continue →').props.disabled).toBeFalsy();
    await act(async () => { renderer?.unmount(); });

    W.depositDetails!.mockRejectedValue(new Error('Network Error'));
    await mount(<DepositView onDone={onDone} onCancel={onCancel} />);
    await press(byText('Continue →'));
    expect(text()).toContain(DEPOSIT_METHODS_FAILED);
    expect(byText('Continue →').props.disabled).toBe(true);
  });

  it('Razorpay: a mock-provider order is never opened, and never verified', async () => {
    W.razorpayOrder!.mockResolvedValue({ depositId: 'x', orderId: 'mock_1727_ab', amount: 5000, currency: 'INR', keyId: 'rzp_test_x' });
    await mount(<DepositView onDone={onDone} onCancel={onCancel} />);
    await press(byText('Continue →'));
    await press(byTestId('deposit-method-RAZORPAY'));
    expect(text()).not.toContain('Pay to these details');
    await press(byText('Continue →'));
    await type(inputBy((n) => n.props.testID === 'deposit-amount'), '5000');
    await press(byText('Continue →'));
    expect(text()).toContain('Instant credit — powered by Razorpay.');
    await press(byText('Pay ₹5,000.00 via Razorpay'));
    expect(W.razorpayOrder).toHaveBeenCalledWith({ accountId: 'a1', currency: 'INR', amount: '5000' });
    expect(toasts()).toContain(`error:${RAZORPAY_NOT_SET_UP}`);
    expect(has('webview')).toBe(false);
    expect(W.razorpayVerify).not.toHaveBeenCalled();
  });

  it('Razorpay: a live order opens Checkout; only its success handler verifies', async () => {
    W.razorpayOrder!.mockResolvedValue({ depositId: 'd9', orderId: 'order_ABC', amount: 5000, currency: 'INR', keyId: 'rzp_live_x' });
    W.razorpayVerify!.mockResolvedValue({ depositId: 'd9', status: 'COMPLETED', alreadyCredited: false });
    await mount(<DepositView onDone={onDone} onCancel={onCancel} />);
    await press(byText('Continue →'));
    await press(byTestId('deposit-method-RAZORPAY'));
    await press(byText('Continue →'));
    await type(inputBy((n) => n.props.testID === 'deposit-amount'), '5000');
    await press(byText('Continue →'));
    await press(byText('Pay ₹5,000.00 via Razorpay'));

    const web = (renderer as Renderer).root.findAll((n) => n.props.testID === 'webview')[0];
    expect(web).toBeDefined();
    const html = (web?.props.source as { html: string }).html;
    expect(html).toContain('"order_id":"order_ABC"');
    expect(html).toContain('"amount":500000');
    expect(W.razorpayVerify).not.toHaveBeenCalled();
    await act(async () => {
      (web?.props.onMessage as (e: unknown) => void)({
        nativeEvent: { data: JSON.stringify({ type: 'success', orderId: 'order_ABC', paymentId: 'pay_1', signature: 'sig_1' }) },
      });
    });
    await settle();
    expect(W.razorpayVerify).toHaveBeenCalledWith({ orderId: 'order_ABC', paymentId: 'pay_1', signature: 'sig_1' });
    expect(toasts()).toContain('success:₹5,000.00 credited');
    expect(onDone).toHaveBeenCalled();
  });

  it('a rail the admin hid is not offered, and the choice falls back', async () => {
    W.depositDetails!.mockResolvedValue(toDepositDetails({ UPI: { enabled: false }, BANK: { accountName: 'T', accountNumber: '1', ifsc: 'X' } }));
    await mount(<DepositView onDone={onDone} onCancel={onCancel} />);
    await press(byText('Continue →'));
    expect(has('deposit-method-UPI')).toBe(false);
    expect(text()).toContain('Bank A/C');
  });

  it('account cards follow a wallet event', async () => {
    await mount(<DepositView onDone={onDone} onCancel={onCancel} />);
    expect(text()).toContain('₹25,000.00');
    W.balances!.mockResolvedValue([toWalletBalance({ accountId: 'a1', currency: 'INR', balance: '30000', free: '30000' })]);
    await act(async () => { for (const f of [...mockLive.wallet]) f(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 350)); });
    await settle();
    expect(text()).toContain('₹30,000.00');
  });

  it('no accounts: says so instead of an empty grid', async () => {
    useSelectedAccountStore.setState({ accounts: [] } as never);
    await mount(<DepositView onDone={onDone} onCancel={onCancel} />);
    expect(text()).toContain('No accounts yet');
    await press(byText('+ Create Account'));
    expect(text()).toContain('route:NewAccountTiers');
  });
});

/* ══ Withdraw ═════════════════════════════════════════════════════════ */

describe('WithdrawView', () => {
  it('a live withdrawal: the rails open for payouts, the rail’s minimum, a verified destination, by id only', async () => {
    W.withdrawals!.mockResolvedValue([
      toWithdrawal({ _id: 'x1', amount: '500', currency: 'INR', method: 'UPI', destination: 'r**@ok', status: 'PENDING', createdAt: '2026-10-01T10:00:00Z' }),
    ]);
    await mount(<WithdrawView onDone={onDone} onCancel={onCancel} />);
    expect(text()).toContain('Withdraw from');
    // Free, not balance, and the locked part named.
    expect(text()).toContain('₹20,000.00');
    expect(text()).toContain('Available · ₹5,000.00 locked in open positions');
    expect(text()).toContain('Recent Withdrawals');
    expect(text()).toContain('500.00');
    await press(byText('Continue →'));
    expect(text()).toContain('Choose withdrawal method');
    // BANK is closed for payouts; Razorpay is open (no withdrawal switch → its deposit one).
    expect(has('withdraw-method-UPI')).toBe(true);
    expect(has('withdraw-method-BANK')).toBe(false);
    expect(has('withdraw-method-RAZORPAY')).toBe(true);
    expect(text()).toContain('Min · ₹1,000.00');
    await press(byText('Continue →'));
    expect(text()).toContain('How much would you like to withdraw?');
    await type(inputBy((n) => n.props.testID === 'withdraw-amount'), '500');
    expect(text()).toContain('Minimum withdrawal for UPI is ₹1,000.00');
    expect(byText('Continue →').props.disabled).toBe(true);
    await type(inputBy((n) => n.props.testID === 'withdraw-amount'), '25000');
    expect(text()).toContain('Exceeds your available balance');
    await press(byText('MAX'));
    expect(inputBy((n) => n.props.testID === 'withdraw-amount').props.value).toBe('20000.00');
    await type(inputBy((n) => n.props.testID === 'withdraw-amount'), '2000');
    await press(byText('Continue →'));
    expect(text()).toContain('Withdrawal method');
    // Only the VERIFIED UPI destination — not the pending one, not the bank.
    expect(text()).toContain('My UPI');
    expect(text()).not.toContain('New UPI');
    expect(text()).not.toContain('HDFC Salary');
    expect(byText('Continue →').props.disabled).toBe(true);
    await press(byTestId('destination-u1'));
    await press(byText('Continue →'));
    expect(text()).toContain('Funds will be locked immediately on submit. Admin verifies and releases within 1–24 hours.');
    expect(text()).toContain('r**@ok');
    await press(byText('Request Withdrawal of ₹2,000.00'));
    expect(W.createWithdrawal).toHaveBeenCalledWith({ accountId: 'a1', currency: 'INR', amount: '2000', withdrawalMethodId: 'u1' });
    expect(toasts()).toContain('success:Withdrawal request submitted — admin will process within 24 hours');
    expect(onDone).toHaveBeenCalled();
  });

  it('a practice withdrawal skips method and destination and sends the rail only', async () => {
    await mount(<WithdrawView onDone={onDone} onCancel={onCancel} />);
    await press(byLabel('Practice'));
    expect(text()).toContain('of 3');
    expect(text()).toContain('Demo withdrawals are processed instantly — no payment details or admin review needed.');
    await press(byText('Continue →'));
    await type(inputBy((n) => n.props.testID === 'withdraw-amount'), '100');
    await press(byText('Continue →'));
    await press(byText('Withdraw ₹100.00 instantly'));
    expect(W.createWithdrawal).toHaveBeenCalledWith({ accountId: 'd1', currency: 'INR', amount: '100', method: 'UPI' });
    expect(toasts()).toContain('success:Demo withdrawal completed instantly');
  });

  it('no verified destination on the rail: the web’s words, and Add opens the manager', async () => {
    W.withdrawalMethods!.mockResolvedValue([METHODS[2]!]);
    await mount(<WithdrawView onDone={onDone} onCancel={onCancel} />);
    await press(byText('Continue →'));
    await press(byText('Continue →'));
    await type(inputBy((n) => n.props.testID === 'withdraw-amount'), '2000');
    await press(byText('Continue →'));
    expect(text()).toContain('No verified UPI method available.');
    expect(text()).toContain('New destinations cannot be entered here.');
    await press(byText('+ Add Withdrawal Method'));
    expect(text()).toContain('Only');
    expect(text()).toContain('methods can be used to withdraw. New methods are verified by our team.');
  });

  it('a method refused as no longer verified: the list is re-read and the flow goes back to Destination', async () => {
    W.createWithdrawal!.mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { error: { code: 'WITHDRAWAL_METHOD_NOT_VERIFIED', message: 'This withdrawal method is not verified yet.' } } },
    });
    await mount(<WithdrawView onDone={onDone} onCancel={onCancel} />);
    await press(byText('Continue →'));
    await press(byText('Continue →'));
    await type(inputBy((n) => n.props.testID === 'withdraw-amount'), '2000');
    await press(byText('Continue →'));
    await press(byTestId('destination-u1'));
    await press(byText('Continue →'));
    W.withdrawalMethods!.mockResolvedValue([METHODS[2]!]);
    const reads = W.withdrawalMethods!.mock.calls.length;
    await press(byText('Request Withdrawal of ₹2,000.00'));
    expect(toasts()).toContain('error:This withdrawal method is not verified yet.');
    expect(W.withdrawalMethods!.mock.calls.length).toBeGreaterThan(reads);
    expect(text()).toContain('No verified UPI method available.');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('re-reads balances and withdrawals on the hub pull-to-refresh (refreshKey)', async () => {
    let bump: () => void = () => {};
    function Harness(): React.JSX.Element {
      const [k, setK] = useState(0);
      bump = () => setK((n) => n + 1);
      return <WithdrawView onDone={onDone} onCancel={onCancel} refreshKey={k} />;
    }
    await mount(<Harness />);
    expect(W.balances).toHaveBeenCalledTimes(1);
    await act(async () => { bump(); });
    await settle();
    expect(W.balances).toHaveBeenCalledTimes(2);
    expect(W.withdrawals).toHaveBeenCalledTimes(2);
  });
});

/* ══ Withdrawal methods ═══════════════════════════════════════════════ */

describe('the withdrawal-methods manager', () => {
  it('lists with status and reason, and removes after the web’s confirm', async () => {
    W.withdrawalMethods!.mockResolvedValue([
      ...METHODS,
      toWithdrawalMethod({ id: 'r1', type: 'BANK', status: 'REJECTED', label: 'Old bank', maskedDestination: 'SBI ••9999', rejectedReason: 'Name mismatch' }),
    ]);
    W.removeWithdrawalMethod!.mockResolvedValue(undefined);
    await mount(<WithdrawalMethodsView />);
    expect(text()).toContain('Withdrawal Methods');
    expect(text()).toContain('UPI ID · r**@ok');
    expect(text()).toContain('Bank Account · HDFC ••1122');
    expect(text()).toContain('Reason: Name mismatch');
    expect(text()).toContain('Verified');
    expect(text()).toContain('Pending');
    await press(byLabel('Remove My UPI'));
    expect(text()).toContain(REMOVE_METHOD_CONFIRM);
    await press(byText('Remove'));
    expect(W.removeWithdrawalMethod).toHaveBeenCalledWith('u1');
    expect(toasts()).toContain('success:Withdrawal method removed');
  });

  it('adds a bank method: the label is required, then the native fields', async () => {
    // Bank payouts open (the shared fixture has them closed).
    W.depositDetails!.mockResolvedValue(toDepositDetails({}));
    W.addWithdrawalMethod!.mockResolvedValue(METHODS[1]);
    await mount(<WithdrawalMethodsView />);
    await press(byText('+ Add Withdrawal Method'));
    await press(byText('Add method'));
    expect(toasts()).toContain('error:Add a label (e.g. "HDFC Salary")');
    await type(inputBy((n) => n.props.placeholder === 'e.g. HDFC Salary'), 'HDFC Salary');
    await type(inputBy((n) => n.props.placeholder === 'Full name as on bank account'), 'Ravi Kumar');
    await type(inputBy((n) => n.props.placeholder === 'e.g. 50100123456789'), '5010 0123');
    await type(inputBy((n) => n.props.placeholder === 'HDFC0001234'), 'hdfc0001234');
    await press(byText('Add method'));
    expect(W.addWithdrawalMethod).toHaveBeenCalledWith({
      type: 'BANK', label: 'HDFC Salary', accountHolderName: 'Ravi Kumar', bankName: '', accountNumber: '50100123', ifsc: 'HDFC0001234',
    });
    expect(toasts()).toContain('success:Method added — pending verification');
  });

  it('a custom rail asks for the admin’s fields and saves a CUSTOM method', async () => {
    W.depositDetails!.mockResolvedValue(toDepositDetails({
      custom: [{ id: 'wise', label: 'Wise', withdrawalFields: [{ label: 'Wise email', placeholder: 'you@wise.com' }] }],
    }));
    W.addWithdrawalMethod!.mockResolvedValue(METHODS[0]);
    await mount(<WithdrawalMethodsView />);
    await press(byText('+ Add Withdrawal Method'));
    await press(byText('Wise'));
    await type(inputBy((n) => n.props.placeholder === 'e.g. HDFC Salary'), 'My Wise');
    await type(inputBy((n) => n.props.placeholder === 'you@wise.com'), ' me@wise.com ');
    await press(byText('Add method'));
    expect(W.addWithdrawalMethod).toHaveBeenCalledWith({ type: 'CUSTOM', label: 'My Wise', methodKey: 'wise', details: { wise_email: 'me@wise.com' } });
  });

  it('empty', async () => {
    W.withdrawalMethods!.mockResolvedValue([]);
    await mount(<WithdrawalMethodsView />);
    expect(text()).toContain('No withdrawal methods yet. Add one to get started.');
  });
});
