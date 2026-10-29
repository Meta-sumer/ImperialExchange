/**
 * Render tests for Transfer Funds: the real view, kit, portal and toasts,
 * with the account store, the wallet api and the socket replaced by
 * in-memory stand-ins. Covers what a pure-logic test cannot: what is on
 * screen at each step, which call went out with what, and when.
 *
 * No network, no device.
 */
import React, { act } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

jest.mock('@/store/selectedAccount', () => {
  const { create } = jest.requireActual('zustand');
  const useSelectedAccountStore = create(() => ({
    accounts: [
      { id: 'a1', accountNumber: '100234', accountType: 'STANDARD', baseCurrency: 'INR', nickname: null },
      { id: 'a2', accountNumber: '100777', accountType: 'PRO', baseCurrency: 'INR', nickname: 'Swing' },
      { id: 'd1', accountNumber: '900001', accountType: 'DEMO', baseCurrency: 'INR', nickname: 'Practice' },
    ],
    selectedId: 'a1',
    loading: false,
    error: null,
    load: jest.fn(async () => {}),
  }));
  return { useSelectedAccountStore };
});

jest.mock('@/api/wallet.api', () => ({
  walletApi: {
    balances: jest.fn(),
    bonusWallet: jest.fn(),
    transfer: jest.fn(),
    peerTransferSettings: jest.fn(),
    searchRecipients: jest.fn(),
    transferToUser: jest.fn(),
  },
}));

jest.mock('@/websocket/ws', () => {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  return {
    __handlers: handlers,
    wsClient: {
      subscribe: (channel: string, cb: (d: unknown) => void) => {
        if (!handlers.has(channel)) handlers.set(channel, new Set());
        handlers.get(channel)?.add(cb);
        return () => { handlers.get(channel)?.delete(cb); };
      },
      getState: () => 'idle',
      onStateChange: () => () => {},
    },
  };
});

/* eslint-disable import/first */
import { AppState, type AppStateStatus } from 'react-native';

import { walletApi } from '@/api/wallet.api';
import { PortalHost, toast } from '@/components/ui';
import { toastStore } from '@/components/ui/toast';
import { TransferView } from '@/screens/wallet/views/TransferView';
import { useSelectedAccountStore } from '@/store/selectedAccount';
import { ThemeProvider } from '@/theme';
/* eslint-enable import/first */

const STORE_AT_START = useSelectedAccountStore.getState();

// react-test-renderer ships without types here; this is the slice used.
interface TestNode {
  type: unknown;
  props: Record<string, unknown>;
  parent: TestNode | null;
  findAll(pred: (n: TestNode) => boolean): TestNode[];
}
interface Renderer { root: TestNode; toJSON(): unknown; unmount(): void; update(el: React.ReactElement): void }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { create } = require('react-test-renderer') as { create: (el: React.ReactElement) => Renderer };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const wsHandlers = (require('@/websocket/ws') as { __handlers: Map<string, Set<(d: unknown) => void>> }).__handlers;

const api = walletApi as unknown as Record<string, jest.Mock>;

const textOf = (node: unknown): string => {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  const n = node as { children?: unknown };
  return textOf(n.children ?? null);
};
/** Whitespace-normalised, so nested <Text> runs read as one sentence. */
const screenText = (r: Renderer): string => textOf(r.toJSON()).replace(/\s+/g, ' ');

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  }
};

const wait = async (ms: number): Promise<void> => {
  await act(async () => { await new Promise((res) => setTimeout(res, ms)); });
  await settle();
};

/** The nearest pressable around the element whose text is exactly `text`. */
const byText = (r: Renderer, text: string): TestNode | undefined => {
  let n: TestNode | null | undefined = r.root.findAll((x) => x.props.children === text)[0];
  while (n && typeof n.props.onPress !== 'function') n = n.parent;
  return n ?? undefined;
};

/** A kit <Button> by its title (a Modal's `title` has no onPress, so it never matches). */
const button = (r: Renderer, title: string): TestNode | undefined =>
  r.root.findAll((n) => n.props.title === title && typeof n.props.onPress === 'function')[0];

/** A Select trigger / labelled control. */
const byLabel = (r: Renderer, label: string): TestNode | undefined =>
  r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];

const field = (r: Renderer, placeholder: string): TestNode | undefined =>
  r.root.findAll((n) => n.type === 'TextInput' && n.props.placeholder === placeholder)[0];

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

/** Open a Select and pick the row that reads `option`. */
const choose = async (r: Renderer, label: string, option: string): Promise<void> => {
  await press(byLabel(r, label));
  const rows = r.root.findAll((x) => x.props.children === option);
  let n: TestNode | null | undefined = rows[rows.length - 1];
  while (n && typeof n.props.onPress !== 'function') n = n.parent;
  await press(n ?? undefined);
  await wait(250); // the sheet's exit animation
};

const toasts = (): string[] => toastStore.getState().toasts.map((t) => `${t.type}:${t.message}`);

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

const BALANCES = [
  { id: 'w1', accountId: 'a1', currency: 'INR', balance: '120', locked: '20', free: '100', updatedAt: null },
  { id: 'w2', accountId: 'a2', currency: 'INR', balance: '20.5', locked: '0', free: '20.5', updatedAt: null },
  { id: 'w3', accountId: 'd1', currency: 'INR', balance: '10000', locked: '0', free: '10000', updatedAt: null },
];
const BONUS = { id: 'b', balance: '10', currency: 'INR', autoRenew: true, gracePeriodDays: null, lowBalanceThreshold: '0', isLowBalance: false, updatedAt: null };
const JANE = { id: 'u2', name: 'Jane Doe', email: 'j@d.co', userUid: 'USR100245', referralCode: null, avatarUrl: null };

let renderer: Renderer | null = null;
const onDone = jest.fn();
const onOpenAccount = jest.fn();

const tree = (refreshKey?: number): React.ReactElement => (
  <SafeAreaProvider initialMetrics={METRICS}>
    <ThemeProvider>
      <PortalHost>
        <TransferView onDone={onDone} refreshKey={refreshKey} onOpenAccount={onOpenAccount} />
      </PortalHost>
    </ThemeProvider>
  </SafeAreaProvider>
);

const mount = async (refreshKey?: number): Promise<Renderer> => {
  await act(async () => {
    renderer = create(tree(refreshKey));
  });
  await settle();
  return renderer as unknown as Renderer;
};

beforeEach(() => {
  jest.clearAllMocks();
  useSelectedAccountStore.setState(STORE_AT_START, true);
  toastStore.setState({ toasts: [] });
  api.balances?.mockResolvedValue(BALANCES);
  api.bonusWallet?.mockResolvedValue(BONUS);
  api.peerTransferSettings?.mockResolvedValue({ enabled: true, min: '10', max: '500', feePercent: '1.5' });
  api.searchRecipients?.mockResolvedValue([JANE]);
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  toast.dismiss(); // clears the auto-dismiss timers too
  renderer = null;
});

/* ══ Between my accounts ════════════════════════════════════════════════ */

describe('between my accounts', () => {
  it('shows the web copy and the source’s free balance, gates Review, confirms and posts the web body', async () => {
    const r = await mount();
    let text = screenText(r);
    expect(text).toContain('Transfer Funds');
    expect(text).toContain('Move funds instantly between your trading accounts and your Main Wallet.');
    expect(text).toContain('Transfer to Main Wallet');
    expect(text).not.toContain('Old Main Wallet');
    expect(text).toContain('100234 · STANDARD');
    expect(text).toContain('Swing · PRO');
    expect(text).toContain('Free: ₹100.00');
    expect(button(r, 'Review Transfer →')?.props.disabled).toBe(true);

    await type(field(r, '0.00'), '150');
    expect(screenText(r)).toContain('Exceeds source account balance');
    expect(button(r, 'Review Transfer →')?.props.disabled).toBe(true);

    await type(field(r, '0.00'), '5O.0.0'); // a stray letter and a second point never reach the field
    expect(field(r, '0.00')?.props.value).toBe('5.00');
    await type(field(r, '0.00'), '50');
    text = screenText(r);
    expect(text).not.toContain('Exceeds source account balance');
    expect(button(r, 'Review Transfer →')?.props.disabled).toBe(false);

    await press(button(r, 'Review Transfer →'));
    text = screenText(r);
    expect(text).toContain('Confirm Transfer');
    expect(text).toContain('Move ₹50.00 from 100234 to Swing ?');

    api.transfer?.mockResolvedValueOnce({ from: 'a1', to: 'a2', amount: '50', currency: 'INR' });
    await press(button(r, 'Confirm Transfer'));
    expect(api.transfer).toHaveBeenCalledTimes(1);
    expect(api.transfer).toHaveBeenCalledWith({ fromAccountId: 'a1', toAccountId: 'a2', currency: 'INR', amount: '50' });
    expect(toasts()).toContain('success:Transfer completed');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(field(r, '0.00')?.props.value).toBe('');
    // The view refreshes its own figures too.
    expect(api.balances).toHaveBeenCalledTimes(2);
    expect(api.bonusWallet).toHaveBeenCalledTimes(2);
  });

  it('"Transfer to Main Wallet", a fixed INR, and the Main Wallet as a source', async () => {
    const r = await mount();
    await press(byText(r, 'Transfer to Main Wallet'));
    let text = screenText(r);
    expect(text).toContain('Main Wallet · INR');
    expect(text).not.toContain('Transfer to Main Wallet');
    // No currency picker: EquityHub moves INR only.
    expect(text).toContain('INR (₹)');
    await type(field(r, '0.00'), '10');
    await press(button(r, 'Review Transfer →'));
    expect(screenText(r)).toContain('Move ₹10.00 from 100234 to Main Wallet ?');
    api.transfer?.mockResolvedValueOnce({ from: 'a1', to: 'bonus', amount: '10', currency: 'INR' });
    await press(button(r, 'Confirm Transfer'));
    expect(api.transfer).toHaveBeenCalledWith({ fromAccountId: 'a1', toAccountId: 'bonus', currency: 'INR', amount: '10' });

    // From: live accounts, the Bonus Wallet, then demo accounts — no Main Wallet.
    await press(byLabel(r, 'From'));
    text = screenText(r);
    expect(text).toContain('Main Wallet · INR');
    expect(text).toContain('Practice · DEMO');
    expect(text).not.toContain('Old Main Wallet');
    let n: TestNode | null | undefined = r.root.findAll((x) => x.props.children === 'Main Wallet · INR').slice(-1)[0];
    while (n && typeof n.props.onPress !== 'function') n = n.parent;
    await press(n ?? undefined);
    await wait(250);
    // The destination can no longer be the source: it moves to the first live account.
    await type(field(r, '0.00'), '10');
    text = screenText(r);
    expect(text).toContain('Balance: ₹10.00');
    expect(button(r, 'Review Transfer →')?.props.disabled).toBe(false);
    await press(button(r, 'Review Transfer →'));
    expect(screenText(r)).toContain('Move ₹10.00 from Main Wallet to 100234 ?');
    api.transfer?.mockResolvedValueOnce({ from: 'bonus', to: 'a1', amount: '10', currency: 'INR' });
    await press(button(r, 'Confirm Transfer'));
    expect(api.transfer).toHaveBeenLastCalledWith({ fromAccountId: 'bonus', toAccountId: 'a1', currency: 'INR', amount: '10' });
  });

  it('a demo account only reaches other demo accounts — here none, so nothing to review', async () => {
    const r = await mount();
    await choose(r, 'From', 'Practice · DEMO');
    const text = screenText(r);
    expect(text).toContain('Free: ₹10,000.00');
    expect(text).toContain('Demo accounts can only transfer to other demo accounts.');
    expect(text).toContain('No eligible account');
    await type(field(r, '0.00'), '10');
    expect(button(r, 'Review Transfer →')?.props.disabled).toBe(true);
    // The shortcut moves a demo source to a live account before targeting the Bonus Wallet.
    await press(byText(r, 'Transfer to Main Wallet'));
    expect(screenText(r)).not.toContain('Demo accounts can only transfer to other demo accounts.');
    expect(screenText(r)).toContain('Free: ₹100.00');
    expect(button(r, 'Review Transfer →')?.props.disabled).toBe(false);
  });
  it('a demo / live mix the server refuses is shown in its words', async () => {
    const r = await mount();
    await choose(r, 'To', 'Main Wallet · INR');
    await type(field(r, '0.00'), '10');
    await press(button(r, 'Review Transfer →'));
    api.transfer?.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 400, data: { error: { code: 'PRACTICE_TRANSFER_NOT_ALLOWED', message: 'Practice (demo) accounts can only transfer to other practice accounts.' } } },
    });
    await press(button(r, 'Confirm Transfer'));
    expect(api.transfer).toHaveBeenCalledWith({ fromAccountId: 'a1', toAccountId: 'bonus', currency: 'INR', amount: '10' });
    expect(toasts()).toContain('error:Practice (demo) accounts can only transfer to other practice accounts.');
  });
  it('the To list never offers the source itself', async () => {
    const r = await mount();
    const count = (label: string): number => r.root.findAll((x) => x.props.children === label).length;
    const sourceBefore = count('100234 · STANDARD');
    await press(byLabel(r, 'To'));
    // The sheet lists Swing and the Bonus Wallet, not 100234 (the source).
    expect(count('Main Wallet · INR')).toBeGreaterThan(0);
    expect(count('100234 · STANDARD')).toBe(sourceBefore);
    expect(screenText(r)).not.toContain('Source and destination must be different accounts.');
  });
  it('a refused transfer shows the server’s words and keeps the confirm open', async () => {
    const r = await mount();
    await type(field(r, '0.00'), '20');
    await press(button(r, 'Review Transfer →'));
    api.transfer?.mockRejectedValueOnce({ isAxiosError: true, response: { status: 402, data: { error: { message: 'Insufficient balance' } } } });
    await press(button(r, 'Confirm Transfer'));
    expect(toasts()).toContain('error:Insufficient balance');
    expect(onDone).not.toHaveBeenCalled();
    expect(button(r, 'Confirm Transfer')).toBeDefined();
  });

  it('the hub’s pull-to-refresh reloads the balances and the Main Wallet snapshot', async () => {
    const r = await mount(0);
    expect(api.balances).toHaveBeenCalledTimes(1);
    api.balances?.mockResolvedValueOnce([{ ...BALANCES[0], free: '12' }, BALANCES[1]]);
    await act(async () => { r.update(tree(1)); });
    await settle();
    expect(api.balances).toHaveBeenCalledTimes(2);
    expect(api.bonusWallet).toHaveBeenCalledTimes(2);
    expect(screenText(r)).toContain('Free: ₹12.00');
  });

  it('a wallet event reloads the balances', async () => {
    const r = await mount();
    expect(screenText(r)).toContain('Free: ₹100.00');
    api.balances?.mockResolvedValueOnce([{ ...BALANCES[0], free: '64.25' }, BALANCES[1]]);
    await act(async () => { for (const cb of wsHandlers.get('user:wallet') ?? []) cb({ event: 'UPDATED' }); });
    await wait(600);
    expect(api.balances).toHaveBeenCalledTimes(2);
    expect(screenText(r)).toContain('Free: ₹64.25');
  });
});

/* ══ Loading and errors ═════════════════════════════════════════════════ */

describe('loading and errors', () => {
  it('waits for the balances, and offers a retry when they fail', async () => {
    let fail: (e: unknown) => void = () => {};
    api.balances?.mockImplementationOnce(() => new Promise((_res, rej) => { fail = rej; }));
    const r = await mount();
    expect(screenText(r)).toContain('Loading…');
    expect(field(r, '0.00')).toBeUndefined();

    await act(async () => { fail({ isAxiosError: true, response: { status: 500, data: { error: { message: 'Wallet service down' } } } }); });
    await settle();
    expect(screenText(r)).toContain("Couldn't load balances");
    expect(screenText(r)).toContain('Wallet service down');

    await press(button(r, 'Try again'));
    expect(api.balances).toHaveBeenCalledTimes(2);
    expect(screenText(r)).toContain('Free: ₹100.00');
  });

  it('a Main Wallet snapshot that fails shows a dash, not ₹0.00, and Review stays off', async () => {
    api.bonusWallet?.mockRejectedValueOnce(new Error('down'));
    const r = await mount();
    await choose(r, 'From', 'Main Wallet · INR');
    await type(field(r, '0.00'), '5');
    const text = screenText(r);
    expect(text).toContain('Balance: —');
    expect(text).not.toContain('Exceeds source account balance');
    expect(button(r, 'Review Transfer →')?.props.disabled).toBe(true);
  });
});

/* ══ Send to another user ═══════════════════════════════════════════════ */

describe('send to another user', () => {
  const RECIPIENT = "Enter recipient's User ID (e.g. USR100245)";

  it('limits, a debounced User-ID search, the fee on top, confirm and send', async () => {
    const r = await mount();
    await press(byText(r, 'Send to another user'));
    let text = screenText(r);
    expect(text).toContain('Send funds from one of your live trading accounts to another registered user — they receive it in their trading account.');
    expect(text).toContain('From account');
    expect(text).toContain('Free: ₹100.00');
    expect(text).toContain('Min ₹10.00 · Max ₹500.00 · Fee 1.5%');
    expect(api.peerTransferSettings).toHaveBeenCalledTimes(1);

    // One character: no search. Two keystrokes inside 250 ms: one search.
    await type(field(r, RECIPIENT), 'U');
    await wait(300);
    expect(api.searchRecipients).not.toHaveBeenCalled();
    await type(field(r, RECIPIENT), 'US');
    await type(field(r, RECIPIENT), 'USR1');
    expect(screenText(r)).toContain('Searching…');
    await wait(300);
    expect(api.searchRecipients).toHaveBeenCalledTimes(1);
    expect(api.searchRecipients).toHaveBeenCalledWith('USR1', { limit: 8 });
    text = screenText(r);
    expect(text).toContain('Jane Doe');
    expect(text).toContain('USR100245');
    expect(text).toContain('JD');

    await press(byText(r, 'Jane Doe'));
    expect(field(r, RECIPIENT)).toBeUndefined();
    expect(screenText(r)).toContain('Change');

    await type(field(r, '0.00'), '100');
    text = screenText(r);
    expect(text).toContain('You send ₹100.00');
    expect(text).toContain('Fee 1.5% ₹1.50');
    expect(text).toContain('Total debit ₹101.50');
    expect(text).toContain('estimate');
    expect(text).toContain('Exceeds free balance (₹100.00)');
    expect(button(r, 'Review Transfer →')?.props.disabled).toBe(true);

    await type(field(r, '0.00'), '5');
    expect(screenText(r)).toContain('Below minimum transfer amount');
    await type(field(r, '0.00'), '600');
    expect(screenText(r)).toContain('Above maximum transfer amount');

    await type(field(r, '0.00'), '50');
    await type(field(r, 'Visible to recipient'), ' Rent ');
    expect(button(r, 'Review Transfer →')?.props.disabled).toBe(false);
    await press(button(r, 'Review Transfer →'));
    text = screenText(r);
    expect(text).toContain('Amount ₹50.00');
    expect(text).toContain('Fee (1.5%) ₹0.75');
    expect(text).toContain('You pay ₹50.75');
    expect(text).toContain('Note: "Rent"');
    expect(text).toContain('Sent from 100234. Jane Doe receives it in their trading account.');

    api.transferToUser?.mockResolvedValueOnce({ referenceId: 'r1', toUserId: 'u2', recipientName: 'Jane Doe', currency: 'INR', amount: '50', fee: '0.75', totalDebited: '50.75', createdAt: null });
    await press(button(r, 'Confirm & Send'));
    expect(api.transferToUser).toHaveBeenCalledTimes(1);
    expect(api.transferToUser).toHaveBeenCalledWith({ fromAccountId: 'a1', currency: 'INR', amount: '50', note: 'Rent', recipientUserId: 'u2' });
    expect(toasts()).toContain('success:Sent ₹50.00 to Jane Doe');
    expect(onDone).toHaveBeenCalledTimes(1);
    // The form is cleared for the next one.
    expect(field(r, RECIPIENT)?.props.value).toBe('');
    expect(field(r, '0.00')?.props.value).toBe('');
  });

  it('"Change" drops the recipient and a cut-short search does not leave "Searching…" behind', async () => {
    const r = await mount();
    await press(byText(r, 'Send to another user'));
    await type(field(r, RECIPIENT), 'USR1');
    await wait(300);
    await press(byText(r, 'Jane Doe'));
    await press(byText(r, 'Change'));
    expect(field(r, RECIPIENT)?.props.value).toBe('');
    await type(field(r, RECIPIENT), 'US');
    await type(field(r, RECIPIENT), 'U');
    await wait(300);
    expect(screenText(r)).not.toContain('Searching…');
  });

  it('says when nobody matches, and why a search failed', async () => {
    api.searchRecipients?.mockResolvedValueOnce([]);
    const r = await mount();
    await press(byText(r, 'Send to another user'));
    await type(field(r, RECIPIENT), 'USR9');
    await wait(300);
    expect(screenText(r)).toContain('No users found.');

    api.searchRecipients?.mockRejectedValueOnce({ isAxiosError: true, response: { status: 429, data: { error: { message: 'Too many requests' } } } });
    await type(field(r, RECIPIENT), 'USR99');
    await wait(300);
    const text = screenText(r);
    expect(text).toContain('Too many requests');
    expect(text).not.toContain('No users found.');
  });

  it('the source is one of the live trading accounts — no Main Wallet, no Main Wallet, no demo account', async () => {
    const r = await mount();
    await press(byText(r, 'Send to another user'));
    await press(byLabel(r, 'From account'));
    const text = screenText(r);
    expect(text).toContain('Swing · PRO');
    expect(text).not.toContain('Main Wallet');
    expect(text).not.toContain('Old Main Wallet');
    expect(text).not.toContain('900001');
    expect(text).not.toContain('Practice');
    expect(text).toContain('INR (₹)');
  });

  it('with no live account there is no source: it says so, offers to open one, and Review stays off', async () => {
    useSelectedAccountStore.setState({
      accounts: [{ id: 'd1', accountNumber: '900001', accountType: 'DEMO', baseCurrency: 'INR', nickname: 'Practice' }],
    } as never);
    const r = await mount();
    await press(byText(r, 'Send to another user'));
    const text = screenText(r);
    expect(text).toContain('No live trading account');
    expect(text).toContain('Transfers are sent from a live trading account.');
    expect(text).not.toContain('Free:');
    await type(field(r, RECIPIENT), 'USR1');
    await wait(300);
    await press(byText(r, 'Jane Doe'));
    await type(field(r, '0.00'), '20');
    expect(button(r, 'Review Transfer →')?.props.disabled).toBe(true);
    await press(byText(r, 'Open one →'));
    expect(onOpenAccount).toHaveBeenCalledTimes(1);
  });
  it('when the admin has turned peer transfers off, says so and offers no form', async () => {
    api.peerTransferSettings?.mockResolvedValueOnce({ enabled: false, min: '0', max: '0', feePercent: '0' });
    const r = await mount();
    await press(byText(r, 'Send to another user'));
    const text = screenText(r);
    expect(text).toContain('Peer transfers are currently disabled');
    expect(text).toContain('User-to-user transfers have been turned off by the platform administrator. Try again later.');
    expect(field(r, RECIPIENT)).toBeUndefined();
  });

  it('a refused peer transfer shows the server’s words', async () => {
    const r = await mount();
    await press(byText(r, 'Send to another user'));
    await type(field(r, RECIPIENT), 'USR1');
    await wait(300);
    await press(byText(r, 'Jane Doe'));
    await type(field(r, '0.00'), '20');
    await press(button(r, 'Review Transfer →'));
    api.transferToUser?.mockRejectedValueOnce({ isAxiosError: true, response: { status: 400, data: { error: { message: 'Cannot transfer to yourself' } } } });
    await press(button(r, 'Confirm & Send'));
    expect(toasts()).toContain('error:Cannot transfer to yourself');
    expect(onDone).not.toHaveBeenCalled();
  });
});

/* ══ Review fixes ═══════════════════════════════════════════════════════ */

describe('review fixes', () => {
  const RECIPIENT = "Enter recipient's User ID (e.g. USR100245)";

  const pickJane = async (r: Renderer): Promise<void> => {
    await type(field(r, RECIPIENT), 'USR1');
    await wait(300);
    await press(byText(r, 'Jane Doe'));
  };

  it('a trader with no active accounts keeps a half-filled peer transfer through an account-list reload, and can send once one arrives', async () => {
    useSelectedAccountStore.setState({ accounts: [], loading: false, error: null });
    const r = await mount();
    await press(byText(r, 'Send to another user'));
    expect(screenText(r)).toContain('No live trading account');
    await pickJane(r);
    await type(field(r, '0.00'), '20');
    expect(button(r, 'Review Transfer →')?.props.disabled).toBe(true);

    // The shared store re-fetches on every wallet event and flips `loading`.
    await act(async () => { useSelectedAccountStore.setState({ loading: true }); });
    await settle();
    expect(screenText(r)).not.toContain('Loading…');

    // …and a re-fetch that fails keeps the form too.
    await act(async () => { useSelectedAccountStore.setState({ loading: false, error: 'Network Error' }); });
    await settle();
    expect(screenText(r)).not.toContain("Couldn't load your accounts");
    expect(screenText(r)).toContain('Jane Doe');
    expect(field(r, '0.00')?.props.value).toBe('20');

    // A live account arrives: it becomes the source.
    await act(async () => {
      useSelectedAccountStore.setState({
        error: null,
        accounts: [{ id: 'a1', accountNumber: '100234', accountType: 'STANDARD', baseCurrency: 'INR', nickname: null }],
      } as never);
    });
    await settle();
    expect(screenText(r)).toContain('Free: ₹100.00');
    await press(button(r, 'Review Transfer →'));
    api.transferToUser?.mockResolvedValueOnce({ referenceId: 'r1', toUserId: 'u2', recipientName: 'Jane Doe', currency: 'INR', amount: '20', fee: '0.3', totalDebited: '20.3', createdAt: null });
    await press(button(r, 'Confirm & Send'));
    expect(api.transferToUser).toHaveBeenCalledWith({ fromAccountId: 'a1', currency: 'INR', amount: '20', recipientUserId: 'u2' });
  });
  it('the first account-list load still shows its spinner and its error', async () => {
    useSelectedAccountStore.setState({ accounts: [], loading: true, error: null });
    const r = await mount();
    expect(screenText(r)).toContain('Loading…');
    await act(async () => { useSelectedAccountStore.setState({ loading: false, error: 'Network Error' }); });
    await settle();
    expect(screenText(r)).toContain("Couldn't load your accounts");
  });

  it('a Main Wallet balance that failed to load offers a retry, and the retry unblocks Review', async () => {
    api.bonusWallet?.mockRejectedValueOnce(new Error('down'));
    const r = await mount();
    await choose(r, 'From', 'Main Wallet · INR');
    await choose(r, 'To', 'Swing · PRO');
    await type(field(r, '0.00'), '5');
    let text = screenText(r);
    expect(text).toContain('Balance: —');
    expect(text).toContain('Retry');
    expect(button(r, 'Review Transfer →')?.props.disabled).toBe(true);

    await press(byLabel(r, 'Retry loading the balance'));
    text = screenText(r);
    expect(api.bonusWallet).toHaveBeenCalledTimes(2);
    expect(text).toContain('Balance: ₹10.00');
    expect(text).not.toContain('Retry');
    expect(button(r, 'Review Transfer →')?.props.disabled).toBe(false);
  });

  it('a peer confirm that stopped being valid closes on "Confirm & Send" and the form says why, instead of doing nothing', async () => {
    const r = await mount();
    await press(byText(r, 'Send to another user'));
    await pickJane(r);
    await type(field(r, '0.00'), '50');
    await press(button(r, 'Review Transfer →'));
    expect(button(r, 'Confirm & Send')).toBeDefined();

    // A wallet event lands while the sheet is open: the source now has ₹10 free.
    api.balances?.mockResolvedValueOnce([{ ...BALANCES[0], free: '10' }, BALANCES[1]]);
    await act(async () => { for (const cb of wsHandlers.get('user:wallet') ?? []) cb({ event: 'UPDATED' }); });
    await wait(600);

    await press(button(r, 'Confirm & Send'));
    await wait(250);
    expect(api.transferToUser).not.toHaveBeenCalled();
    expect(button(r, 'Confirm & Send')).toBeUndefined();
    expect(screenText(r)).toContain('Exceeds free balance (₹10.00)');
  });

  it('when the last account leaves the list, the pickers drop it rather than keep an unlisted id', async () => {
    const r = await mount();
    await press(byText(r, 'Transfer to Main Wallet'));
    await type(field(r, '0.00'), '10');
    expect(button(r, 'Review Transfer →')?.props.disabled).toBe(false);

    await act(async () => {
      useSelectedAccountStore.setState({ accounts: [] } as never);
    });
    await settle();
    const text = screenText(r);
    expect(text).toContain('Select…');
    expect(text).not.toContain('Free:');
    expect(button(r, 'Review Transfer →')?.props.disabled).toBe(true);
  });

  it('a live source that leaves the list falls to the first demo account — and then only demo destinations', async () => {
    const r = await mount();
    await act(async () => {
      useSelectedAccountStore.setState({
        accounts: [{ id: 'd1', accountNumber: '900001', accountType: 'DEMO', baseCurrency: 'INR', nickname: 'Practice' }],
      } as never);
    });
    await settle();
    const text = screenText(r);
    expect(text).toContain('Practice · DEMO');
    expect(text).toContain('No eligible account');
    expect(text).toContain('Demo accounts can only transfer to other demo accounts.');
    await type(field(r, '0.00'), '10');
    expect(button(r, 'Review Transfer →')?.props.disabled).toBe(true);
  });
  it('a self confirm closes when the account list moves its source away, and nothing is posted', async () => {
    const r = await mount();
    await type(field(r, '0.00'), '10');
    await press(button(r, 'Review Transfer →'));
    expect(screenText(r)).toContain('Move ₹10.00 from 100234 to Swing ?');

    // a1 is suspended (user:accounts) — the store's list no longer has it,
    // and the re-seed puts the first remaining account in From.
    await act(async () => {
      useSelectedAccountStore.setState({
        accounts: [{ id: 'a2', accountNumber: '100777', accountType: 'PRO', baseCurrency: 'INR', nickname: 'Swing' }],
      } as never);
    });
    await wait(250);
    expect(button(r, 'Confirm Transfer')).toBeUndefined();
    expect(api.transfer).not.toHaveBeenCalled();
    // Swing takes From; the destination can no longer be Swing, so it is the Bonus Wallet.
    expect(screenText(r)).toContain('Swing · PRO');
    expect(screenText(r)).toContain('Main Wallet · INR');
  });

  it('a peer confirm closes when the account list moves its source away — no debit from an account the trader never picked', async () => {
    const r = await mount();
    await press(byText(r, 'Send to another user'));
    await pickJane(r);
    await type(field(r, '0.00'), '15');
    await press(button(r, 'Review Transfer →'));
    expect(button(r, 'Confirm & Send')).toBeDefined();

    await act(async () => {
      useSelectedAccountStore.setState({
        accounts: [{ id: 'a2', accountNumber: '100777', accountType: 'PRO', baseCurrency: 'INR', nickname: 'Swing' }],
      } as never);
    });
    await wait(250);
    expect(button(r, 'Confirm & Send')).toBeUndefined();
    expect(api.transferToUser).not.toHaveBeenCalled();
    // The form now shows the account it would debit, and its balance.
    const text = screenText(r);
    expect(text).toContain('Swing · PRO');
    expect(text).toContain('Free: ₹20.50');
  });

  it('a failed limits read is said, the confirm total says the fee is not in it, and Retry loads the limits', async () => {
    api.peerTransferSettings?.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: { error: { message: 'down' } } } });
    const r = await mount();
    await press(byText(r, 'Send to another user'));
    let text = screenText(r);
    expect(text).toContain("Couldn't load the transfer limits and fee. The server applies them when you send.");
    expect(text).not.toContain('Min ₹10.00');

    // The web's permissive defaults still let the trader go on (the server enforces the caps)…
    await pickJane(r);
    await type(field(r, '0.00'), '20');
    await press(button(r, 'Review Transfer →'));
    text = screenText(r);
    expect(text).toContain('You pay ₹20.00');
    // …but "You pay" does not pretend to be the debit.
    expect(text).toContain('The fee could not be loaded, so it is not included');
    await press(button(r, 'Cancel'));
    await wait(250);

    await press(byLabel(r, 'Retry loading the transfer limits'));
    text = screenText(r);
    expect(api.peerTransferSettings).toHaveBeenCalledTimes(2);
    expect(text).not.toContain("Couldn't load the transfer limits");
    expect(text).toContain('Min ₹10.00 · Max ₹500.00 · Fee 1.5%');

    await press(button(r, 'Review Transfer →'));
    text = screenText(r);
    expect(text).toContain('You pay ₹20.30');
    expect(text).toContain('Fee shown is an estimate');
    expect(text).not.toContain('The fee could not be loaded');
  });

  it('the hub’s pull-to-refresh reads the limits again; a re-read that fails keeps the ones on screen', async () => {
    const r = await mount(0);
    await press(byText(r, 'Send to another user'));
    expect(api.peerTransferSettings).toHaveBeenCalledTimes(1);
    expect(screenText(r)).toContain('Min ₹10.00 · Max ₹500.00 · Fee 1.5%');

    api.peerTransferSettings?.mockResolvedValueOnce({ enabled: true, min: '5', max: '0', feePercent: '0' });
    await act(async () => { r.update(tree(1)); });
    await settle();
    expect(api.peerTransferSettings).toHaveBeenCalledTimes(2);
    expect(screenText(r)).toContain('Min ₹5.00');

    api.peerTransferSettings?.mockRejectedValueOnce(new Error('down'));
    await act(async () => { r.update(tree(2)); });
    await settle();
    expect(api.peerTransferSettings).toHaveBeenCalledTimes(3);
    const text = screenText(r);
    expect(text).toContain('Min ₹5.00');
    expect(text).not.toContain("Couldn't load the transfer limits");
  });

  it('"Try again" on failed balances shows the spinner while the retry is out', async () => {
    api.balances?.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: { error: { message: 'Wallet service down' } } } });
    const r = await mount();
    expect(screenText(r)).toContain("Couldn't load balances");

    let answer: (rows: unknown) => void = () => {};
    api.balances?.mockImplementationOnce(() => new Promise((res) => { answer = res; }));
    await press(button(r, 'Try again'));
    let text = screenText(r);
    expect(text).toContain('Loading…');
    expect(text).not.toContain("Couldn't load balances");

    await act(async () => { answer(BALANCES); });
    await settle();
    text = screenText(r);
    expect(text).toContain('Free: ₹100.00');
  });

  it('a recipient photo that will not load falls back to the initials', async () => {
    api.searchRecipients?.mockResolvedValueOnce([{ ...JANE, avatarUrl: 'https://cdn.example.com/jane.png' }]);
    const r = await mount();
    await press(byText(r, 'Send to another user'));
    await type(field(r, RECIPIENT), 'USR1');
    await wait(300);
    const img = r.root.findAll((n) => n.type === 'Image' && typeof n.props.onError === 'function')[0];
    expect(img?.props.source).toEqual({ uri: 'https://cdn.example.com/jane.png' });
    expect(screenText(r)).not.toContain('JD');

    await act(async () => { (img?.props.onError as () => void)(); });
    await settle();
    expect(screenText(r)).toContain('JD');
  });

  it('returning to the foreground reloads the balances and the Main Wallet snapshot', async () => {
    const handlers: ((s: AppStateStatus) => void)[] = [];
    // AppState is a jest mock here; capture the 'change' listeners and hand
    // back a subscription whose remove() the hook can call.
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((type, cb) => {
      if (type === 'change') handlers.push(cb as (s: AppStateStatus) => void);
      return { remove: () => {} } as ReturnType<typeof AppState.addEventListener>;
    });
    try {
      const r = await mount();
      expect(api.balances).toHaveBeenCalledTimes(1);
      api.balances?.mockResolvedValueOnce([{ ...BALANCES[0], free: '42' }, BALANCES[1]]);
      await act(async () => { for (const h of handlers) h('background'); });
      await act(async () => { for (const h of handlers) h('active'); });
      await settle();
      expect(api.balances).toHaveBeenCalledTimes(2);
      expect(api.bonusWallet).toHaveBeenCalledTimes(2);
      expect(screenText(r)).toContain('Free: ₹42.00');
    } finally {
      spy.mockRestore();
    }
  });
});
