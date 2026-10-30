/**
 * Render tests for the signed-out screens — the landing page and the auth
 * pages: each one mounted in a real native stack, with the auth store, the
 * auth API and the public instrument feed replaced by in-memory stand-ins.
 * Covers the flows a pure-logic test cannot: which step is on screen, which
 * call went out with what, and where the screen went next.
 *
 * No network, no device.
 */
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React, { act, type ComponentType } from 'react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));

jest.mock('@/store/auth', () => {
  const { create } = jest.requireActual('zustand');
  const useAuthStore = create(() => ({
    user: null,
    status: 'unauthenticated',
    error: null,
    login: jest.fn(),
    register: jest.fn(),
    bootstrap: jest.fn(async () => {}),
    refreshUser: jest.fn(async () => {}),
  }));
  return { useAuthStore };
});

jest.mock('@/api/auth.api', () => {
  const actual = jest.requireActual('@/api/auth.api');
  return {
    ...actual,
    authApi: {
      forgotPassword: jest.fn(),
      verifyResetOtp: jest.fn(),
      resetPasswordWithOtp: jest.fn(),
      confirmPasswordReset: jest.fn(),
      verifyEmail: jest.fn(),
    },
  };
});

// The landing page's public feed (/instruments/watchlist).
jest.mock('@/api/instruments.api', () => ({ fetchMarketWatch: jest.fn(async () => []) }));

// The CMS footer reads the network; it has tests of its own.
jest.mock('@/navigation/chromeSlots', () => ({ PageFooter: null }));

jest.mock('@/navigation/linking', () => ({
  navigateToPath: jest.fn(() => true),
  LINK_PREFIXES: ['imperialexchange://'],
}));

jest.mock('@/services/tokenStore', () => ({ getAccessToken: jest.fn(() => null) }));

/* eslint-disable import/first */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authApi } from '@/api/auth.api';
import { fetchMarketWatch } from '@/api/instruments.api';
import { toastStore } from '@/components/ui/toast';
import { navigateToPath } from '@/navigation/linking';
import type { RootStackParamList, ScreenName } from '@/navigation/types';
import { ForgotPasswordScreen } from '@/screens/auth/ForgotPasswordScreen';
import { LoginScreen } from '@/screens/auth/LoginScreen';
import { LandingScreen } from '@/screens/landing/LandingScreen';
import { RegisterScreen } from '@/screens/auth/RegisterScreen';
import { ResetPasswordScreen } from '@/screens/auth/ResetPasswordScreen';
import { VerifyEmailScreen } from '@/screens/auth/VerifyEmailScreen';
import { getAccessToken } from '@/services/tokenStore';
import { useAuthStore } from '@/store/auth';
import { ThemeProvider } from '@/theme';
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
  for (let i = 0; i < 4; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
};

type AuthMock = {
  login: jest.Mock;
  register: jest.Mock;
  bootstrap: jest.Mock;
  refreshUser: jest.Mock;
};
const store = (): AuthMock => useAuthStore.getState() as unknown as AuthMock;
const api = authApi as unknown as Record<string, jest.Mock>;

const toasts = (): string[] => toastStore.getState().toasts.map((t) => `${t.type}:${t.message}`);

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

const Stack = createNativeStackNavigator<RootStackParamList>();

/** Every other route is a stub that prints its name and params. */
function Stub({ route }: { route: { name: string; params?: object } }): React.JSX.Element {
  return <Text>{`route:${route.name}:${JSON.stringify(route.params ?? {})}`}</Text>;
}

const ROUTES: ScreenName[] = ['Landing', 'Login', 'Register', 'ForgotPassword', 'ResetPassword', 'VerifyEmail'];

let renderer: Renderer | null = null;

const mount = async <N extends ScreenName>(
  name: N,
  Screen: ComponentType<never>,
  params?: RootStackParamList[N],
  below: ScreenName[] = [],
): Promise<Renderer> => {
  const initialState = {
    index: below.length,
    routes: [...below.map((n) => ({ name: n })), { name, params }],
  };
  await act(async () => {
    renderer = create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>
          <NavigationContainer initialState={initialState as never}>
            <Stack.Navigator screenOptions={{ headerShown: false, animation: 'none' }}>
              {ROUTES.map((r) => (
                <Stack.Screen key={r} name={r} component={(r === name ? Screen : Stub) as ComponentType} />
              ))}
            </Stack.Navigator>
          </NavigationContainer>
        </ThemeProvider>
      </SafeAreaProvider>,
    );
  });
  await settle();
  return renderer as unknown as Renderer;
};

const inputs = (r: Renderer): TestNode[] => r.root.findAll((n) => n.type === 'TextInput');

const type = async (node: TestNode | undefined, value: string): Promise<void> => {
  if (!node) throw new Error('input not found');
  await act(async () => { (node.props.onChangeText as (s: string) => void)(value); });
  await settle();
};

const blur = async (node: TestNode | undefined): Promise<void> => {
  if (!node) throw new Error('input not found');
  await act(async () => { (node.props.onBlur as (() => void) | undefined)?.(); });
};

/** The nearest pressable around the text node that reads exactly `text`. */
const byText = (r: Renderer, text: string): TestNode | undefined => {
  let n: TestNode | null | undefined = r.root.findAll((x) => x.props.children === text)[0];
  while (n && typeof n.props.onPress !== 'function') n = n.parent;
  return n ?? undefined;
};

/**
 * The form's "Sign In" — the last one on the page. From 640 wide (jest's
 * window is 750) the marketing header draws its own "Sign In" link too,
 * as LandingHeader.jsx does.
 */
const signInButton = (r: Renderer): TestNode | undefined => {
  const hits = r.root.findAll((x) => x.props.children === 'Sign In');
  let n: TestNode | null | undefined = hits[hits.length - 1];
  while (n && typeof n.props.onPress !== 'function') n = n.parent;
  return n ?? undefined;
};

const press = async (node: TestNode | undefined): Promise<void> => {
  if (!node) throw new Error('node not found');
  await act(async () => { (node.props.onPress as () => void)(); });
  await settle();
};

beforeEach(async () => {
  jest.clearAllMocks();
  // Register remembers a partner's code across visits; start each test clean.
  await AsyncStorage.clear();
  useAuthStore.setState({ user: null, status: 'unauthenticated', error: null } as never);
  (getAccessToken as jest.Mock).mockReturnValue(null);
  toastStore.setState({ toasts: [] });
  (fetchMarketWatch as jest.Mock).mockResolvedValue([]);
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = null;
});

describe('LoginScreen', () => {
  it('shows the web copy, the stacked logo, and refuses an empty form without calling the server', async () => {
    const r = await mount('Login', LoginScreen as ComponentType<never>);
    const text = textOf(r.toJSON());
    expect(text).toContain('Sign in to your trading account');
    // No demo-credentials hint, no broker buttons, no code field.
    expect(text).not.toMatch(/Demo:|continue with|Authenticator/);
    expect(inputs(r)).toHaveLength(2);
    expect(inputs(r)[0]?.props.placeholder).toBe('you@example.com');
    // BrandMark: the stacked lockup (icon over the wordmark), as the web's auth pages.
    const art = r.root.findAll((n) => n.type === 'Image').map((n) => JSON.stringify(n.props.source ?? ''));
    expect(art.some((s) => s.includes('imperialexchange-logo-stacked'))).toBe(true);
    await press(signInButton(r));
    const after = textOf(r.toJSON());
    expect(after).toContain('Email is required');
    expect(after).toContain('Password is required');
    expect(store().login).not.toHaveBeenCalled();
  });

  it('signs in with the email lower-cased and the password — nothing else', async () => {
    store().login.mockResolvedValueOnce(undefined);
    const r = await mount('Login', LoginScreen as ComponentType<never>);
    const [email, password] = inputs(r);
    await type(email, 'Trader@Example.COM');
    await type(password, 'Trader@12345');
    await press(signInButton(r));
    expect(store().login).toHaveBeenCalledWith('trader@example.com', 'Trader@12345');
    expect(store().login.mock.calls[0]).toHaveLength(2);
    expect(toasts()).toContain('success:Welcome back');
  });

  it('shows the server’s refusal', async () => {
    store().login.mockRejectedValueOnce({ isAxiosError: true, response: { status: 401, data: { error: { message: 'Invalid credentials' } } } });
    const r = await mount('Login', LoginScreen as ComponentType<never>);
    const [email, password] = inputs(r);
    await type(email, 'a@b.co');
    await type(password, 'password1');
    await press(signInButton(r));
    expect(toasts()).toContain('error:Invalid credentials');
  });

  it('offers a retry when a stored session could not be restored', async () => {
    (getAccessToken as jest.Mock).mockReturnValue('stored');
    useAuthStore.setState({ error: 'Network Error' } as never);
    const r = await mount('Login', LoginScreen as ComponentType<never>);
    expect(textOf(r.toJSON())).toContain('Network Error');
    await press(byText(r, 'Retry'));
    expect(store().bootstrap).toHaveBeenCalled();
  });
});

describe('RegisterScreen', () => {
  it('applies a referral code from the link', async () => {
    const r = await mount('Register', RegisterScreen as ComponentType<never>, { ref: ' abc12345 ' });
    const text = textOf(r.toJSON());
    expect(text).toContain('Referral applied');
    expect(text).toContain('ABC12345');
    expect(text).toContain('· from link');
    const referral = inputs(r).find((n) => n.props.placeholder === 'ABC12345');
    expect(referral?.props.value).toBe('ABC12345');
  });

  it('refuses an incomplete form with every error at once', async () => {
    const r = await mount('Register', RegisterScreen as ComponentType<never>);
    await press(byText(r, 'Create Account'));
    const text = textOf(r.toJSON());
    expect(toasts()).toContain('error:Please fix the highlighted fields');
    expect(text).toContain('First name is required');
    expect(text).toContain('Email is required');
    expect(text).toContain('Pick a country');
    expect(store().register).not.toHaveBeenCalled();
  });

  it('clears a visited field’s error live as it becomes valid', async () => {
    const r = await mount('Register', RegisterScreen as ComponentType<never>);
    const first = inputs(r)[0];
    await blur(first);
    await settle();
    expect(textOf(r.toJSON())).toContain('First name is required');
    await type(inputs(r)[0], 'Asha');
    expect(textOf(r.toJSON())).not.toContain('First name is required');
  });

  it('puts a duplicate email under the email field', async () => {
    store().register.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 409, data: { error: { code: 'DUPLICATE_EMAIL', message: 'Email already registered' } } },
    });
    const r = await mount('Register', RegisterScreen as ComponentType<never>);
    const [first, , email, , password] = inputs(r);
    await type(first, 'Asha');
    await type(email, 'asha@example.com');
    await type(password, 'Secret123');
    // The country picker: choose through its onChange.
    const select = r.root.findAll((n) => typeof n.props.onChange === 'function' && Array.isArray(n.props.options))[0];
    await act(async () => { (select?.props.onChange as (v: string) => void)('IN'); });
    await settle();
    await press(byText(r, 'Create Account'));
    expect(store().register).toHaveBeenCalledWith(expect.objectContaining({
      email: 'asha@example.com', firstName: 'Asha', country: 'IN', referralCode: '',
    }));
    expect(textOf(r.toJSON())).toContain('This email is already registered');
    expect(toasts()).toContain('error:Email already registered');
  });
});

describe('ForgotPasswordScreen', () => {
  it('walks email → code → new password → done, then back to Login', async () => {
    api.forgotPassword?.mockResolvedValue('If an account exists for this email, an OTP has been sent.');
    api.verifyResetOtp?.mockResolvedValue('ticket-1');
    api.resetPasswordWithOtp?.mockResolvedValue('ok');
    const r = await mount('ForgotPassword', ForgotPasswordScreen as ComponentType<never>, undefined, ['Login']);

    await press(byText(r, 'Send code'));
    expect(textOf(r.toJSON())).toContain('Email is required');
    expect(api.forgotPassword).not.toHaveBeenCalled();

    await type(inputs(r)[0], 'Asha@Example.com');
    await press(byText(r, 'Send code'));
    expect(api.forgotPassword).toHaveBeenCalledWith('asha@example.com');
    expect(textOf(r.toJSON())).toContain('Enter verification code');
    expect(textOf(r.toJSON())).toMatch(/Resend in\s+60\s*s/);

    // A pasted code fills all six boxes and submits itself.
    await type(inputs(r)[0], '123456');
    expect(api.verifyResetOtp).toHaveBeenCalledWith('asha@example.com', '123456');
    expect(textOf(r.toJSON())).toContain('Set a new password');

    const [pwd, confirm] = inputs(r);
    await type(pwd, 'Secret12!');
    await type(confirm, 'Secret12?');
    expect(textOf(r.toJSON())).toContain('Passwords do not match');
    await type(inputs(r)[1], 'Secret12!');
    await press(byText(r, 'Update password'));
    expect(api.resetPasswordWithOtp).toHaveBeenCalledWith('ticket-1', 'Secret12!');
    expect(textOf(r.toJSON())).toContain('Password updated');
    expect(toasts()).toContain('success:Password updated successfully.');

    await press(byText(r, 'Go to login'));
    expect(textOf(r.toJSON())).toContain('route:Login');
  });

  it('a dead reset ticket starts over from the email', async () => {
    api.forgotPassword?.mockResolvedValue('sent');
    api.verifyResetOtp?.mockResolvedValue('ticket-1');
    api.resetPasswordWithOtp?.mockRejectedValue({
      isAxiosError: true,
      response: { status: 401, data: { error: { code: 'RESET_TOKEN_INVALID', message: 'Your reset session has expired. Please start again.' } } },
    });
    const r = await mount('ForgotPassword', ForgotPasswordScreen as ComponentType<never>);
    await type(inputs(r)[0], 'a@b.co');
    await press(byText(r, 'Send code'));
    await type(inputs(r)[0], '654321');
    await type(inputs(r)[0], 'Secret12!');
    await type(inputs(r)[1], 'Secret12!');
    await press(byText(r, 'Update password'));
    expect(toasts()).toContain('error:Your reset session has expired. Please start again.');
    expect(textOf(r.toJSON())).toContain('Forgot password?');
  });

  it('a wrong code clears the boxes and stays on the code step', async () => {
    api.forgotPassword?.mockResolvedValue('sent');
    api.verifyResetOtp?.mockRejectedValue({ isAxiosError: true, response: { status: 400, data: { error: { message: 'Incorrect code. 4 attempts left.' } } } });
    const r = await mount('ForgotPassword', ForgotPasswordScreen as ComponentType<never>);
    await type(inputs(r)[0], 'a@b.co');
    await press(byText(r, 'Send code'));
    await type(inputs(r)[0], '111111');
    expect(toasts()).toContain('error:Incorrect code. 4 attempts left.');
    expect(inputs(r).map((n) => n.props.value)).toEqual(['', '', '', '', '', '']);
    expect(textOf(r.toJSON())).toContain('Enter verification code');
  });
});

describe('ResetPasswordScreen', () => {
  it('without a token: the invalid-link card', async () => {
    const r = await mount('ResetPassword', ResetPasswordScreen as ComponentType<never>);
    expect(textOf(r.toJSON())).toContain('Invalid reset link');
    await press(byText(r, 'Request a new link'));
    expect(navigateToPath).toHaveBeenCalledWith('/forgot-password');
  });

  it('with a token: checks, then confirms and returns to Login', async () => {
    api.confirmPasswordReset?.mockResolvedValue(undefined);
    const r = await mount('ResetPassword', ResetPasswordScreen as ComponentType<never>, { token: 'tok' }, ['Login']);
    await type(inputs(r)[0], 'short');
    await press(byText(r, 'Reset password'));
    expect(toasts()).toContain('error:Password must be at least 8 characters');
    await type(inputs(r)[0], 'longenough');
    await type(inputs(r)[1], 'different1');
    await press(byText(r, 'Reset password'));
    expect(toasts()).toContain('error:Passwords do not match');
    await type(inputs(r)[1], 'longenough');
    await press(byText(r, 'Reset password'));
    expect(api.confirmPasswordReset).toHaveBeenCalledWith('tok', 'longenough');
    expect(toasts()).toContain('success:Password reset. Please log in.');
    expect(textOf(r.toJSON())).toContain('route:Login');
  });
});

describe('VerifyEmailScreen', () => {
  it('verifies on arrival', async () => {
    api.verifyEmail?.mockResolvedValue(undefined);
    const r = await mount('VerifyEmail', VerifyEmailScreen as ComponentType<never>, { token: 'vt' });
    expect(api.verifyEmail).toHaveBeenCalledWith('vt');
    expect(textOf(r.toJSON())).toContain('Email verified!');
    await press(byText(r, 'Go to Dashboard'));
    expect(navigateToPath).toHaveBeenCalledWith('/dashboard');
  });

  it('refreshes a signed-in user after verifying', async () => {
    useAuthStore.setState({ status: 'authenticated' } as never);
    api.verifyEmail?.mockResolvedValue(undefined);
    await mount('VerifyEmail', VerifyEmailScreen as ComponentType<never>, { token: 'vt' });
    expect(store().refreshUser).toHaveBeenCalled();
  });

  it('shows the server’s reason, or the web’s default', async () => {
    api.verifyEmail?.mockRejectedValue({ response: { data: { error: { message: 'Invalid or expired token' } } } });
    const r = await mount('VerifyEmail', VerifyEmailScreen as ComponentType<never>, { token: 'vt' });
    expect(textOf(r.toJSON())).toContain('Verification failed');
    expect(textOf(r.toJSON())).toContain('Invalid or expired token');
    await press(byText(r, 'Resend email'));
    expect(navigateToPath).toHaveBeenCalledWith('/profile');
  });

  it('no token in the link', async () => {
    const r = await mount('VerifyEmail', VerifyEmailScreen as ComponentType<never>);
    expect(textOf(r.toJSON())).toContain('Missing verification token in URL.');
    expect(api.verifyEmail).not.toHaveBeenCalled();
  });
});

describe('LandingScreen', () => {
  it('draws the Indian-market page, section by section, with the static INR ticker', async () => {
    const r = await mount('Landing', LandingScreen as ComponentType<never>);
    const text = textOf(r.toJSON());
    for (const s of [
      'NIFTY 50', 'BANK NIFTY', 'SENSEX', 'RELIANCE', '24,118.50',
      'Forever', 'Trusted by traders across India',
      'Bank-level Security', 'NSE & BSE Access', 'Indian markets',
      'Why Choose Imperial Exchange?', 'Live Market Data',
      'Everything a Trader Needs', 'Tight spreads',
      'Built for Every Trader',
      'Stocks', 'Indices', 'Commodities', 'Large Caps', 'Banking', 'IT & Tech', 'NSE & BSE Equities',
      'Imperial Exchange Terminal', 'Open Positions', 'Place Order',
      'Secure Payments', 'Two-Factor Auth',
      'How It Works', 'Verify Identity',
      'Why Traders Love Imperial Exchange', 'Equity Investor', 'Forever Trustable',
      'Ready To Start Your Trading Journey?', 'Trade. Invest. Grow. Imperial Exchange.',
    ]) expect({ s, shown: text.includes(s) }).toEqual({ s, shown: true });
    expect(text).not.toMatch(/BTC|ETH\/USD|Crypto|Forex|Advance AI/);
    expect(r.root.findAll((n) => n.props.testID === 'market-card' && typeof n.type === 'string')).toHaveLength(6);
    // The feed was asked for, once, on arrival.
    expect(fetchMarketWatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Start trading free →', 'Register'],
    ['Sign in', 'Login'],
    ['Explore Platform →', 'Register'],
    ['Start Trading Free →', 'Register'],
  ])('"%s" goes to %s', async (label, route) => {
    const r = await mount('Landing', LandingScreen as ComponentType<never>);
    await press(byText(r, label));
    expect(textOf(r.toJSON())).toContain(`route:${route}`);
  });

  it('the header shows "Sign In" from 640 wide, as LandingHeader.jsx', async () => {
    const r = await mount('Landing', LandingScreen as ComponentType<never>);
    await press(byText(r, 'Sign In'));
    expect(textOf(r.toJSON())).toContain('route:Login');
  });

  it('the live feed replaces the showcase and drives the market cards', async () => {
    (fetchMarketWatch as jest.Mock).mockResolvedValue([
      { symbol: 'TATAMOTORS', category: 'STOCK', segment: 'EQ', exchange: 'NSE', lastPrice: '1012.5', change24h: 1.5, pricePrecision: 2 },
      { symbol: 'NIFTY50', category: 'INDEX', exchange: 'NSE', lastPrice: '25900', change24h: -0.25, pricePrecision: 2 },
    ]);
    const r = await mount('Landing', LandingScreen as ComponentType<never>);
    const text = textOf(r.toJSON());
    expect(text).toContain('TATAMOTORS');
    expect(text).toContain('1,012.50');
    // The showcase's BANKNIFTY level is gone.
    expect(text).not.toContain('58,214.35');
    // Stocks +1.50%, Index F&O -0.25%; the cards with no live rows keep their fallback.
    expect(text).toContain('+1.50%');
    expect(text).toContain('-0.25%');
    expect(text).toContain('+0.38%');
  });

  it('a feed that cannot be reached leaves the showcase up', async () => {
    (fetchMarketWatch as jest.Mock).mockRejectedValue(new Error('offline'));
    const r = await mount('Landing', LandingScreen as ComponentType<never>);
    expect(textOf(r.toJSON())).toContain('51,420.30');
    expect(textOf(r.toJSON())).toContain('+0.62%');
  });

  it('the header is the Imperial Exchange one: the horizontal logo, the theme toggle and Get Started', async () => {
    const r = await mount('Landing', LandingScreen as ComponentType<never>);
    const header = r.root.findAll((n) => n.props.testID === 'landing-header' && typeof n.type === 'string')[0];
    expect(header).toBeDefined();
    const art = (header?.findAll((n) => n.type === 'Image') ?? []).map((n) => JSON.stringify(n.props.source ?? ''));
    expect(art.some((s) => s.includes('imperialexchange-logo'))).toBe(true);
    expect(r.root.findAll((n) => n.props.accessibilityLabel === 'Imperial Exchange home' && typeof n.props.onPress === 'function')).toHaveLength(1);
    await press(byText(r, 'Get Started'));
    expect(textOf(r.toJSON())).toContain('route:Register');
  });
});

