/**
 * Render smoke tests for the shell: the real navigator, header, pill rail,
 * profile menu, confirm and toasts, mounted together. Pure-logic tests
 * cannot catch a provider in the wrong order or a header that throws; this
 * does.
 *
 * Stores and API modules are replaced with in-memory stand-ins, the screen
 * registry with ComingSoonScreen everywhere (the auth screens belong to
 * another agent), and Linking is RN's jest mock — no network, no device.
 */
import React, { act } from 'react';
import { Linking, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// The whole navigator mounts here; under a full parallel run a test can take
// longer than jest's 5 s default.
jest.setTimeout(30_000);

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));

jest.mock('@/store/auth', () => {
  const { create } = jest.requireActual('zustand');
  const useAuthStore = create(() => ({
    user: null,
    status: 'idle',
    error: null,
    bootstrap: jest.fn(async () => {}),
    logout: jest.fn(async () => { useAuthStore.setState({ user: null, status: 'unauthenticated' }); }),
    exitImpersonation: jest.fn(async () => {}),
  }));
  return { useAuthStore };
});

jest.mock('@/store/selectedAccount', () => {
  const { create } = jest.requireActual('zustand');
  const useSelectedAccountStore = create((set: (p: object) => void) => ({
    accounts: [
      { id: 'a1', accountNumber: '100234', accountType: 'STANDARD', baseCurrency: 'INR', nickname: null },
      { id: 'a2', accountNumber: '900001', accountType: 'DEMO', baseCurrency: 'INR', nickname: 'Practice' },
    ],
    selectedId: 'a1',
    select: (id: string) => set({ selectedId: id }),
    load: async () => {},
    reset: () => {},
  }));
  return { useSelectedAccountStore };
});

jest.mock('@/api/trading.api', () => ({
  fetchPositions: async () => [],
  fetchOpenOrders: async () => [],
}));

// The profile menu's Balance — GET /wallet/equity, the selected account's floating balance.
const mockEquity = jest.fn(async () => [
  { accountId: 'a1', currency: 'INR', balance: '1000', unrealizedPnl: '234.5', equity: '1234.5', usedMargin: '0', free: '1000', freeMargin: '1234.5', marginLevel: null, status: 'ACTIVE', stoppedOut: false },
  { accountId: 'a2', currency: 'INR', balance: '500000', unrealizedPnl: '0', equity: '500000', usedMargin: '0', free: '500000', freeMargin: '500000', marginLevel: null, status: 'ACTIVE', stoppedOut: false },
]);
jest.mock('@/api/wallet.api', () => ({ walletApi: { equity: () => mockEquity() } }));

jest.mock('@/websocket/ws', () => ({ wsClient: { disconnect: jest.fn(), subscribe: () => () => {} } }));

jest.mock('@/navigation/screenRegistry', () => {
  const { ComingSoonScreen } = jest.requireActual('@/screens/common/ComingSoonScreen');
  const { APP_SCREENS, GUEST_SCREENS, PUBLIC_SCREENS } = jest.requireActual('@/navigation/types');
  const screenRegistry: Record<string, unknown> = {};
  for (const n of [...GUEST_SCREENS, ...PUBLIC_SCREENS, ...APP_SCREENS]) screenRegistry[n] = ComingSoonScreen;
  return { screenRegistry };
});

/* eslint-disable import/first */
import { engineRunning } from '@/components/chrome/notificationStore';
import { ConfirmProvider, PortalHost, ToastHost, toast, useConfirm } from '@/components/ui';
import { useAuthGate } from '@/navigation/authGate';
import { AppNavigation } from '@/navigation/AppNavigation';
import { useChrome } from '@/navigation/chrome/chromeState';
import { useAuthStore } from '@/store/auth';
import { ThemeProvider } from '@/theme';
/* eslint-enable import/first */

// react-test-renderer ships without types here; this is the slice used.
interface TestNode {
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
  // Linking's initial URL, the container's first render, effects, timers.
  for (let i = 0; i < 4; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
};

const byLabel = (r: Renderer, label: string): TestNode | undefined =>
  r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];

/** The nearest pressable around the element whose text is exactly `text`. */
const byText = (r: Renderer, text: string): TestNode | undefined => {
  let n: TestNode | null | undefined = r.root.findAll((x) => x.props.children === text)[0];
  while (n && typeof n.props.onPress !== 'function') n = n.parent;
  return n ?? undefined;
};

/** Every rail pill and bottom tab, in tree order. */
const tabNodes = (r: Renderer): TestNode[] =>
  r.root.findAll((n) => n.props.accessibilityRole === 'tab' && typeof n.props.onPress === 'function');
const tabLabels = (r: Renderer): string[] => tabNodes(r).map((n) => String(n.props.accessibilityLabel));
/**
 * The screen on top. The stack keeps the screens under it mounted (only the
 * top one is visible on a device), and renders the top one last — so its
 * two strip pills and five tabs are the last seven.
 */
const ON_TOP = 7;
const litTabs = (r: Renderer): string[] =>
  tabNodes(r)
    .slice(-ON_TOP)
    .filter((n) => (n.props.accessibilityState as { selected?: boolean } | undefined)?.selected)
    .map((n) => String(n.props.accessibilityLabel));

const press = async (node: TestNode | undefined): Promise<void> => {
  if (!node) throw new Error('node not found');
  await act(async () => { (node.props.onPress as () => void)(); });
  await settle();
};

const signIn = (user: Record<string, unknown> = {}): void => {
  useAuthStore.setState({
    user: { id: 'u1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', ...user },
    status: 'authenticated',
  } as never);
};

// App.tsx's providers, with a phone's metrics so insets resolve without a device.
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const Shell = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <SafeAreaProvider initialMetrics={METRICS}><ThemeProvider>{children}</ThemeProvider></SafeAreaProvider>
);

let renderer: Renderer | null = null;

const mount = async (): Promise<Renderer> => {
  await act(async () => {
    renderer = create(<Shell><AppNavigation /></Shell>);
  });
  await settle();
  return renderer as unknown as Renderer;
};

beforeEach(() => {
  useAuthStore.setState({ user: null, status: 'idle' } as never);
  useAuthGate.setState({ resolved: null, hadSession: false, pending: null, identity: null });
  useChrome.setState({ profileOpen: false });
  (Linking.getInitialURL as jest.Mock).mockResolvedValue(null);
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = null;
  toast.dismiss();
});

describe('AppNavigation', () => {
  it('shows the boot splash until the first bootstrap settles', async () => {
    const r = await mount();
    expect(textOf(r.toJSON())).toContain('Loading…');
    expect(textOf(r.toJSON())).not.toContain('Option Chain');
  });

  it('signed out: the Landing route, no app header', async () => {
    useAuthStore.setState({ status: 'unauthenticated' } as never);
    const r = await mount();
    const text = textOf(r.toJSON());
    expect(text).toContain('Landing');
    expect(text).not.toContain('Portfolio');
  });

  it('signed in: Explore, with the header, the strip and the bottom tabs', async () => {
    signIn();
    const r = await mount();
    const text = textOf(r.toJSON());
    expect(text).toContain('/explore');
    for (const label of ['Explore', 'Option Chain', 'Watchlist', 'Portfolio', 'Positions', 'Wallets', 'Copy Trading']) {
      expect(text).toContain(label);
    }
    // None of MetaTrading's destinations.
    for (const gone of ['Forex', 'Crypto', 'F&O', 'Broker']) expect(text).not.toContain(gone);
    expect(text).toContain('AL'); // avatar initials
    // The strip first (under the header), the bottom tabs last; Explore lit
    // on the home page.
    expect(tabLabels(r)).toEqual([
      'Watchlist', 'Copy Trading',
      'Explore', 'Option Chain', 'Positions', 'Portfolio', 'Wallets',
    ]);
    expect(litTabs(r)).toEqual(['Explore']);
  });

  it('switching section from the strip or a tab draws no back chevron', async () => {
    signIn();
    const r = await mount();
    for (const label of ['Portfolio', 'Positions', 'Wallets', 'Watchlist', 'Copy Trading', 'Option Chain', 'Explore']) {
      // eslint-disable-next-line no-await-in-loop
      await press(byLabel(r, label));
      expect({ label, back: byLabel(r, 'Back') }).toEqual({ label, back: undefined });
    }
  });

  it('Positions has its own page, with the tabs under it', async () => {
    signIn();
    const r = await mount();
    await press(byLabel(r, 'Positions'));
    expect(textOf(r.toJSON())).toContain('/positions');
    expect(litTabs(r)).toEqual(['Positions']);
  });

  it('the bell is in the profile menu, before its close button — not in the header', async () => {
    signIn();
    const r = await mount();
    expect(byLabel(r, 'Notifications')).toBeUndefined();
    // Its engine runs for the whole session, not only while the menu is open.
    expect(engineRunning()).toBe(true);
    await press(byLabel(r, 'Account menu'));
    // The menu's header: up from its title to the first box holding a "Close".
    const pressables = (n: TestNode): string[] => n
      .findAll((x) => typeof x.props.onPress === 'function' && ['Notifications', 'Close'].includes(String(x.props.accessibilityLabel)))
      .map((x) => String(x.props.accessibilityLabel));
    let header: TestNode | null = r.root.findAll((n) => n.props.children === 'Ada Lovelace')[0] ?? null;
    while (header && !pressables(header).includes('Close')) header = header.parent;
    expect(header).not.toBeNull();
    const labels = pressables(header as TestNode);
    // One bell, first; the menu's × after it (its IconButton and the Pressable
    // inside both carry the label, so "Close" is counted more than once).
    expect(labels.filter((l) => l === 'Notifications')).toHaveLength(1);
    expect(labels[0]).toBe('Notifications');
    expect(labels.slice(1)).toContain('Close');
  });

  it('a bottom tab opens its page and lights; a strip pill lights itself and no tab', async () => {
    signIn();
    const r = await mount();
    await press(byLabel(r, 'Option Chain'));
    expect(textOf(r.toJSON())).toContain('/options');
    expect(litTabs(r)).toEqual(['Option Chain']);
    await press(byLabel(r, 'Watchlist'));
    expect(textOf(r.toJSON())).toContain('/watchlist');
    expect(litTabs(r)).toEqual(['Watchlist']);
    // The tabs are still there under a strip page, none of them lit.
    expect(tabLabels(r)).toContain('Explore');
  });

  it('Trade owns the viewport: no header, no rail, no tabs', async () => {
    signIn();
    (Linking.getInitialURL as jest.Mock).mockResolvedValue('imperialexchange://trade');
    const r = await mount();
    expect(textOf(r.toJSON())).toContain('/trade');
    // Explore is mounted under it (a deep link opens with home underneath):
    // its nine are the only ones — Trade itself carries none.
    expect(tabLabels(r)).toHaveLength(ON_TOP);
  });

  it('the rail navigates', async () => {
    signIn();
    const r = await mount();
    await press(byLabel(r, 'Portfolio'));
    expect(textOf(r.toJSON())).toContain('/dashboard');
  });

  it('the avatar opens the profile menu with the web sections', async () => {
    signIn();
    const r = await mount();
    await press(byLabel(r, 'Account menu'));
    const text = textOf(r.toJSON());
    for (const label of ['Ada Lovelace', 'ada@example.com', 'Switch account', 'Balance', 'Reports',
      'Support', 'Chat with Support', 'Settings', 'Trading Terminal', 'Log Out']) {
      expect(text).toContain(label);
    }
    // The SELECTED account's floating balance, from GET /wallet/equity, in rupees.
    expect(mockEquity).toHaveBeenCalled();
    const balance = r.root.findAll((n) => n.props.testID === 'profile-balance')[0];
    expect(textOf(balance?.props.children ?? null)).toBe('₹1,234.50');
    expect(text).not.toContain('$');
  });

  it('opens a deep link on its screen, with home underneath', async () => {
    signIn();
    (Linking.getInitialURL as jest.Mock).mockResolvedValue('imperialexchange://stock/RELIANCE');
    const r = await mount();
    const text = textOf(r.toJSON());
    expect(text).toContain('Stock Detail');
    expect(text).toContain('/stock/RELIANCE');
    expect(byLabel(r, 'Back')).toBeDefined();
  });

  it('parks a protected link behind Login, then takes it after sign-in', async () => {
    useAuthStore.setState({ status: 'unauthenticated' } as never);
    (Linking.getInitialURL as jest.Mock).mockResolvedValue('imperialexchange://wallet?action=deposit');
    const r = await mount();
    expect(textOf(r.toJSON())).toContain('/login');
    await act(async () => { signIn(); });
    await settle();
    expect(textOf(r.toJSON())).toContain('/wallet?action=deposit');
  });

  it('a change of user under a live session rebuilds the screens at Explore', async () => {
    signIn();
    const r = await mount();
    await press(byLabel(r, 'Wallets'));
    expect(textOf(r.toJSON())).toContain('/wallet');
    // A "View As User" link: same status, different person.
    await act(async () => { signIn({ id: 'u2', firstName: 'Grace', lastName: 'Hopper' }); });
    await settle();
    const text = textOf(r.toJSON());
    expect(text).not.toContain('/wallet');
    expect(text).toContain('/explore');
    expect(text).toContain('GH');
  });

  it('signing out lands on Login, not the landing page', async () => {
    signIn();
    const r = await mount();
    await act(async () => { useAuthStore.setState({ user: null, status: 'unauthenticated' } as never); });
    await settle();
    expect(textOf(r.toJSON())).toContain('/login');
  });
});

describe('overlays', () => {
  function Asker({ onAnswer }: { onAnswer: (v: boolean) => void }): React.JSX.Element {
    const confirm = useConfirm();
    return (
      <Text
        accessibilityLabel="ask"
        onPress={() => { void confirm({ title: 'Close all?', message: 'This closes every position.', danger: true }).then(onAnswer); }}
      >
        ask
      </Text>
    );
  }

  it('useConfirm shows the dialog and resolves with the choice', async () => {
    const answers: boolean[] = [];
    await act(async () => {
      renderer = create(
        <Shell>
          <PortalHost>
            <ConfirmProvider>
              <Asker onAnswer={(v) => answers.push(v)} />
            </ConfirmProvider>
          </PortalHost>
        </Shell>,
      );
    });
    const r = renderer as unknown as Renderer;
    await press(byLabel(r, 'ask'));
    expect(textOf(r.toJSON())).toContain('This closes every position.');
    await press(byText(r, 'Confirm'));
    expect(answers).toEqual([true]);
  });

  it('ToastHost draws queued toasts', async () => {
    await act(async () => {
      renderer = create(<Shell><PortalHost><ToastHost /></PortalHost></Shell>);
    });
    await act(async () => { toast.error('Insufficient free margin'); });
    expect(textOf((renderer as unknown as Renderer).toJSON())).toContain('Insufficient free margin');
  });
});
