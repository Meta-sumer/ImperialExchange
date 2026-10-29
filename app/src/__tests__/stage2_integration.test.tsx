/**
 * Stage 2 integration: the seven ported routes are plugged into the one
 * registry, every web path the product emits for them lands on the ported
 * screen with the params the screen reads, and the wallet pages' shared
 * rail moves through the native stack the way the app's own pill rail does.
 *
 * The area suites (stage2_walletHub / moneyFlows / transfer / userWallets /
 * plans / profile) test each screen alone, with the registry mocked or the
 * screen mounted directly; this file is the seam between them.
 */
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
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

/* eslint-disable import/first */
import { WalletNav } from '@/components/wallet/WalletNav';
import { screenRegistry } from '@/navigation/screenRegistry';
import { APP_SCREENS, GUEST_SCREENS, PUBLIC_SCREENS, type RootStackParamList, type ScreenName } from '@/navigation/types';
import { pathForRoute, resolveWebPath } from '@/navigation/webPaths';
import { NewAccountConfigureScreen } from '@/screens/accounts/NewAccountConfigureScreen';
import { NewAccountTiersScreen } from '@/screens/accounts/NewAccountTiersScreen';
import { ComingSoonScreen } from '@/screens/common/ComingSoonScreen';
import { PlansScreen } from '@/screens/plans/PlansScreen';
import { ProfileScreen } from '@/screens/profile/ProfileScreen';
import { BonusWalletScreen } from '@/screens/wallet/BonusWalletScreen';
import { WalletScreen } from '@/screens/wallet/WalletScreen';
import { WithdrawalMethodsView as HubMethodsView } from '@/screens/wallet/views/WithdrawalMethodsView';
import { WithdrawalMethodsView } from '@/components/wallet/WithdrawalMethods';
import { ThemeProvider } from '@/theme';
import { initialProfileTab } from '@/utils/profile';
import { WALLET_NAV_ITEMS, deepLinkView } from '@/utils/walletLogic';
/* eslint-enable import/first */

/* ── The registry ─────────────────────────────────────────────────────── */

const STAGE2: Record<string, ComponentType<never>> = {
  Wallet: WalletScreen,
  BonusWallet: BonusWalletScreen,
  Plans: PlansScreen,
  NewAccountTiers: NewAccountTiersScreen,
  NewAccountConfigure: NewAccountConfigureScreen,
  Profile: ProfileScreen,
};
const AUTH = ['Login', 'Register', 'ForgotPassword', 'ResetPassword', 'VerifyEmail'];

describe('screenRegistry after stage 2', () => {
  const all: ScreenName[] = [...GUEST_SCREENS, ...PUBLIC_SCREENS, ...APP_SCREENS];

  it.each(Object.entries(STAGE2))('%s renders its ported screen, not ComingSoon', (name, component) => {
    const registered = screenRegistry[name as ScreenName] as unknown;
    expect(registered).toBe(component);
    expect(registered).not.toBe(ComingSoonScreen);
  });

  // The exact ported set is pinned by the latest stage's integration test
  // (stage3_integration); here: every stage 1–2 route is still ported.
  it('the auth and stage 2 routes are all off ComingSoon', () => {
    // EquityHub's App.jsx renders 34 distinct pages (/subscription-wallet now redirects to /bonus-wallet); /preview/order-modal and
    // /download are not ported.
    expect(all).toHaveLength(32);
    const ported = all.filter((n) => (screenRegistry[n] as unknown) !== ComingSoonScreen);
    expect(ported).toEqual(expect.arrayContaining([...AUTH, ...Object.keys(STAGE2)]));
  });

  it('the hub renders the contract path of the Withdrawal Methods view — the shared component, re-exported', () => {
    expect(HubMethodsView).toBe(WithdrawalMethodsView);
  });
});

/* ── Deep links ───────────────────────────────────────────────────────── */

describe('web paths reach the stage 2 screens with the params they read', () => {
  it.each([
    ['/wallet', 'Wallet', undefined],
    ['/accounts', 'Wallet', undefined],
    ['/funds', 'Wallet', undefined],
    ['/wallet?action=deposit', 'Wallet', { action: 'deposit' }],
    ['/wallet?view=history', 'Wallet', { view: 'history' }],
    // <Navigate to="/bonus-wallet" replace /> — the Main Wallet is retired.
    ['/subscription-wallet', 'BonusWallet', undefined],
    ['/bonus-wallet', 'BonusWallet', undefined],
    ['/plans', 'Plans', undefined],
    ['/bonuses', 'Plans', undefined],
    ['/accounts/new', 'NewAccountTiers', undefined],
    ['/accounts/new/PRO_IC', 'NewAccountConfigure', { tierCode: 'PRO_IC' }],
    ['/profile', 'Profile', undefined],
    ['/profile?tab=kyc', 'Profile', { tab: 'kyc' }],
  ] as const)('%s → %s', (path, name, params) => {
    const route = resolveWebPath(path);
    expect(route.name).toBe(name);
    expect(route.params).toEqual(params);
    expect(screenRegistry[route.name] as unknown).toBe(STAGE2[name]);
  });

  it('the Wallet opens the view a link names — ?action= as the web, ?view= as its sidebar emits', () => {
    expect(deepLinkView(resolveWebPath('/wallet?action=deposit').params as never)).toBe('grow');
    expect(deepLinkView(resolveWebPath('/wallet?action=withdraw').params as never)).toBe('withdraw');
    expect(deepLinkView(resolveWebPath('/wallet?action=transfer').params as never)).toBe('transfer');
    expect(deepLinkView(resolveWebPath('/wallet?view=withdrawal-methods').params as never)).toBe('withdrawal-methods');
    // A view that is a page of its own, or nothing, lands on the default view.
    expect(deepLinkView(resolveWebPath('/wallet?view=bonus').params as never)).toBeNull();
    expect(deepLinkView(resolveWebPath('/funds').params as never)).toBeNull();
  });

  it('Profile opens the tab a link names, and the default tab for none or garbage', () => {
    expect(initialProfileTab((resolveWebPath('/profile?tab=security').params as { tab?: never } | undefined)?.tab)).toBe('security');
    expect(resolveWebPath('/profile?tab=nope').params).toBeUndefined();
    expect(initialProfileTab(undefined)).toBe('profile');
  });

  it('every stage 2 route round-trips through its canonical path', () => {
    const routes: { name: ScreenName; params?: object }[] = [
      { name: 'Wallet', params: { view: 'history' } },
      { name: 'BonusWallet' },
      { name: 'Plans' },
      { name: 'NewAccountTiers' },
      { name: 'NewAccountConfigure', params: { tierCode: 'STANDARD' } },
      { name: 'Profile', params: { tab: 'devices' } },
    ];
    for (const r of routes) {
      const back = resolveWebPath(pathForRoute(r));
      expect(back.name).toBe(r.name);
      expect(back.params).toEqual(r.params);
    }
  });
});

/* ── The wallet rail in the stack ─────────────────────────────────────── */

// react-test-renderer ships without types here; this is the slice used.
interface TestNode {
  props: Record<string, unknown>;
  findAll(pred: (n: TestNode) => boolean): TestNode[];
}
interface Renderer { root: TestNode; unmount(): void }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { create } = require('react-test-renderer') as { create: (el: React.ReactElement) => Renderer };

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const Stack = createNativeStackNavigator<RootStackParamList>();
const navRef = createNavigationContainerRef<RootStackParamList>();

/** The hub stand-in: its rail navigates (no onSelect), like any wallet-family page. */
function WalletStub({ route }: { route: { params?: object } }): React.JSX.Element {
  return (
    <>
      <Text>{`Wallet:${JSON.stringify(route.params ?? {})}`}</Text>
      <WalletNav activeId={null} />
    </>
  );
}
const BonusWallet = (): React.JSX.Element => <WalletNav activeId="bonus" />;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
};

let renderer: Renderer | null = null;
afterEach(() => {
  act(() => { renderer?.unmount(); });
  renderer = null;
});

const mountStack = async (routes: { name: ScreenName }[]): Promise<Renderer> => {
  await act(async () => {
    renderer = create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>
          <NavigationContainer ref={navRef} initialState={{ index: routes.length - 1, routes } as never}>
            <Stack.Navigator screenOptions={{ headerShown: false, animation: 'none' }}>
              <Stack.Screen name="Wallet" component={WalletStub as ComponentType} />
              <Stack.Screen name="BonusWallet" component={BonusWallet} />
            </Stack.Navigator>
          </NavigationContainer>
        </ThemeProvider>
      </SafeAreaProvider>,
    );
  });
  await settle();
  return renderer as unknown as Renderer;
};

/** The pill in the FOCUSED screen (a native stack keeps the ones below mounted). */
const pill = (r: Renderer, label: string): TestNode => {
  const all = r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
  const last = all[all.length - 1];
  if (!last) throw new Error(`no pill ${label}`);
  return last;
};
const tap = async (node: TestNode): Promise<void> => {
  await act(async () => { (node.props.onPress as () => void)(); });
  await settle();
};
const stack = (): { name: string; params?: object }[] =>
  (navRef.getRootState()?.routes ?? []).map((r) => ({ name: r.name, params: r.params as object | undefined }));

describe('WalletNav moves through the stack like the app pill rail (pop: true)', () => {
  it('a hub view from the Main Wallet goes BACK to the Wallet underneath, on that view', async () => {
    const r = await mountStack([{ name: 'Wallet' }, { name: 'BonusWallet' }]);
    await tap(pill(r, 'Account Overview'));
    expect(stack()).toEqual([{ name: 'Wallet', params: { view: 'overview' } }]);
  });

  it('Main Wallet from the Wallet returns to the Main Wallet already open instead of stacking a copy', async () => {
    const r = await mountStack([{ name: 'BonusWallet' }, { name: 'Wallet' }]);
    await tap(pill(r, 'Main Wallet'));
    expect(stack().map((s) => s.name)).toEqual(['BonusWallet']);
  });

  it('the rail has no item for the retired (old) Main Wallet', async () => {
    const r = await mountStack([{ name: 'BonusWallet' }]);
    expect(() => pill(r, 'Old Main Wallet')).toThrow();
    expect(WALLET_NAV_ITEMS.map((i) => i.label)).not.toContain('Old Main Wallet');
    expect(WALLET_NAV_ITEMS.map((i) => i.route)).not.toContain('SubscriptionWallet');
  });

  it('with no Wallet in the stack (a deep link straight to /bonus-wallet) it opens one on the view', async () => {
    const r = await mountStack([{ name: 'BonusWallet' }]);
    await tap(pill(r, 'Deposit Funds'));
    expect(stack()).toEqual([{ name: 'BonusWallet', params: undefined }, { name: 'Wallet', params: { view: 'grow' } }]);
  });

  it('every hub item on the rail is a view the Wallet opens from ?view=', () => {
    for (const item of WALLET_NAV_ITEMS) {
      if (item.route) continue;
      expect(deepLinkView({ view: item.id })).toBe(item.id);
    }
  });
});
