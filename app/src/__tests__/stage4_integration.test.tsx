/**
 * Stage 4 integration: the social / partner / support / public routes are
 * plugged into the registry, the page footer slot holds the CMS footer, the
 * web paths for these screens resolve with the params the screens read, and
 * each screen mounts and draws its main states.
 *
 * EquityHub has no Broker Terminal (no broker connect, no /broker route, no
 * backend/src/brokers): the broker screen, its order pad and their tests are
 * gone, and this file pins that they stay gone.
 */
import 'react-native-gesture-handler/jestSetup';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as fs from 'fs';
import * as path from 'path';
import React, { act, type ComponentType } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
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
  File: jest.fn().mockImplementation(() => ({ create: jest.fn(), write: jest.fn(), text: jest.fn(async () => ''), base64: jest.fn(async () => ''), uri: 'file:///x' })),
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

jest.mock('@/api/feedback.api', () => ({
  feedbackApi: {
    categories: jest.fn(async () => []),
    list: jest.fn(async () => []),
    submit: jest.fn(async () => ({ id: 't1', status: 'OPEN' })),
  },
}));
jest.mock('@/api/cms.api', () => {
  const actual = jest.requireActual('@/api/cms.api');
  return {
    ...actual,
    cmsApi: {
      ...actual.cmsApi,
      page: jest.fn(),
      footer: jest.fn(async () => ({ links: [], config: { brand: null, logoUrl: null, tagline: null, address: null, copyright: null, socials: {}, customSocials: [] } })),
      knowledgeBase: jest.fn(async () => [
        { id: 'kb-default-withdrawals', q: 'How long do withdrawals take?', a: 'UPI: ≤ 2 hours.', tag: 'Funds', link: '/wallet', videoUrl: null },
      ]),
    },
  };
});
jest.mock('@/api/helpdesk.api', () => {
  const actual = jest.requireActual('@/api/helpdesk.api');
  return {
    ...actual,
    helpdeskApi: {
      uploadConfig: jest.fn(async () => ({ enabled: true, maxFileMB: 5, maxTotalMB: 0, maxFiles: 0, allowedExtensions: [], blockedExtensions: [] })),
      conversation: jest.fn(async () => ({ conversation: { id: 'c1', userId: 'u1', managerId: null, unread: 0, status: null }, counterpart: null, messages: [] })),
      messagesBefore: jest.fn(async () => []),
      messagesAfter: jest.fn(async () => []),
      send: jest.fn(),
      markSeen: jest.fn(async () => {}),
      typing: jest.fn(async () => {}),
    },
  };
});
jest.mock('@/api/partner.api', () => {
  const actual = jest.requireActual('@/api/partner.api');
  return { ...actual, partnerApi: { ...actual.partnerApi, volumeDashboard: jest.fn(), commissions: jest.fn(async () => []) } };
});
jest.mock('@/api/copyTrading.api', () => {
  const actual = jest.requireActual('@/api/copyTrading.api');
  return {
    ...actual,
    copyTradingApi: {
      ...actual.copyTradingApi,
      leaderboard: jest.fn(async () => []),
      feed: jest.fn(async () => []),
      myCopies: jest.fn(async () => []),
      myProfile: jest.fn(async () => null),
      myBoxes: jest.fn(async () => []),
      archivedBoxes: jest.fn(async () => []),
      trader: jest.fn(async () => null),
      traderPositions: jest.fn(async () => []),
      traderHistory: jest.fn(async () => ({ items: [], total: 0, page: 1, limit: 10, pages: 1 })),
    },
  };
});
jest.mock('@/api/instruments.api', () => {
  const actual = jest.requireActual('@/api/instruments.api');
  return { ...actual, fetchMarketWatch: jest.fn(async () => []), searchInstruments: jest.fn(async () => []) };
});

/* eslint-disable import/first */
import { cmsApi } from '@/api/cms.api';
import { feedbackApi } from '@/api/feedback.api';
import { partnerApi } from '@/api/partner.api';
import { CmsFooter } from '@/components/cms/CmsFooter';
import { ConfirmProvider, PortalHost } from '@/components/ui';
import { PageFooter } from '@/navigation/chromeSlots';
import { screenRegistry } from '@/navigation/screenRegistry';
import { APP_SCREENS, GUEST_SCREENS, PUBLIC_SCREENS, type RootStackParamList, type ScreenName } from '@/navigation/types';
import { resolveWebPath } from '@/navigation/webPaths';
import { CmsPageScreen } from '@/screens/cms/CmsPageScreen';
import { ComingSoonScreen } from '@/screens/common/ComingSoonScreen';
import { CopyTradingScreen } from '@/screens/copy/CopyTradingScreen';
import { TraderDashboardScreen } from '@/screens/copy/TraderDashboardScreen';
import { FeedbackScreen } from '@/screens/feedback/FeedbackScreen';
import { HelpdeskChatScreen } from '@/screens/helpdesk/HelpdeskChatScreen';
import { HelpdeskScreen } from '@/screens/helpdesk/HelpdeskScreen';
import { LandingScreen } from '@/screens/landing/LandingScreen';
import { PartnerScreen } from '@/screens/partner/PartnerScreen';
import { ThemeProvider } from '@/theme';
import { toVolumeDashboard } from '@/types/partner';
/* eslint-enable import/first */

/* ── The registry ─────────────────────────────────────────────────────── */

const STAGE4: Record<string, ComponentType<never>> = {
  Landing: LandingScreen,
  CmsPage: CmsPageScreen,
  CopyTrading: CopyTradingScreen,
  TraderDashboard: TraderDashboardScreen,
  Partner: PartnerScreen,
  Helpdesk: HelpdeskScreen,
  HelpdeskChat: HelpdeskChatScreen,
  Feedback: FeedbackScreen,
};

describe('screenRegistry after stage 4', () => {
  const all: ScreenName[] = [...GUEST_SCREENS, ...PUBLIC_SCREENS, ...APP_SCREENS];

  it.each(Object.entries(STAGE4))('%s renders its ported screen, not ComingSoon', (name, component) => {
    const registered = screenRegistry[name as ScreenName] as unknown;
    expect(registered).toBe(component);
    expect(registered).not.toBe(ComingSoonScreen);
  });

  it('no stage 4 route renders ComingSoon (the full list lives in stage5_integration)', () => {
    // EquityHub's App.jsx renders 34 distinct pages (/subscription-wallet now redirects to /bonus-wallet); /preview/order-modal and
    // /download are not ported.
    expect(all).toHaveLength(32);
    const left = all.filter((n) => (screenRegistry[n] as unknown) === ComingSoonScreen);
    expect(left).toEqual(expect.not.arrayContaining(Object.keys(STAGE4)));
  });

  it('the page footer slot holds the CMS footer', () => {
    expect(PageFooter).toBe(CmsFooter);
  });

  it('has no Broker, F&O home or broker-login route — EquityHub dropped them', () => {
    for (const gone of ['Broker', 'Fno', 'OAuthCallback']) {
      expect(all).not.toContain(gone);
      expect(Object.keys(screenRegistry)).not.toContain(gone);
    }
  });

  it('ships no broker module — no api/broker, no screens/broker, no components/broker', () => {
    const src = path.join(__dirname, '..');
    for (const p of ['api/broker.api.ts', 'types/broker.ts', 'screens/broker', 'components/broker']) {
      expect({ p, exists: fs.existsSync(path.join(src, p)) }).toEqual({ p, exists: false });
    }
  });
});

describe('web paths reach the stage 4 screens with the params they read', () => {
  it.each([
    ['/', 'Landing', undefined],
    ['/page/terms', 'CmsPage', { slug: 'terms' }],
    ['/copy-trading', 'CopyTrading', undefined],
    ['/copy-trading/trader/u1?account=a1', 'TraderDashboard', { id: 'u1', account: 'a1' }],
    ['/partner', 'Partner', undefined],
    ['/affiliate', 'Partner', undefined],
    ['/ib-room', 'Partner', undefined],
    ['/helpdesk', 'Helpdesk', undefined],
    ['/helpdesk?tab=tickets&q=kyc', 'Helpdesk', { tab: 'tickets', q: 'kyc' }],
    ['/helpdesk/chat', 'HelpdeskChat', undefined],
    ['/feedback', 'Feedback', undefined],
  ] as const)('%s → %s', (p, name, params) => {
    const route = resolveWebPath(p);
    expect(route.name).toBe(name);
    if (params) expect(route.params).toMatchObject(params);
  });
});

/* ── Rendering ────────────────────────────────────────────────────────── */

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

function Stub({ route }: { route: { name: string } }): React.JSX.Element {
  return <Text>{`route:${route.name}`}</Text>;
}

let renderer: Renderer | null = null;

const OTHER_ROUTES: ScreenName[] = ['Login', 'Register', 'Explore', 'CopyTrading', 'Helpdesk', 'Profile', 'Landing', 'Wallet'];

const mount = async <N extends ScreenName>(name: N, Screen: ComponentType<never>, params?: RootStackParamList[N]): Promise<Renderer> => {
  const routes: ScreenName[] = [name, ...OTHER_ROUTES.filter((r) => r !== name)];
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

const pressText = async (r: Renderer, text: string): Promise<void> => {
  let n: TestNode | null | undefined = r.root.findAll((x) => x.props.children === text)[0];
  while (n && typeof n.props.onPress !== 'function') n = n.parent;
  if (!n) throw new Error(`no pressable "${text}"`);
  await act(async () => { (n?.props.onPress as () => void)(); });
  await settle();
};

describe('Landing', () => {
  it('draws the marketing page with its calls to action and the static ticker', async () => {
    const r = await mount('Landing', LandingScreen as ComponentType<never>);
    const text = textOf(r.toJSON());
    expect(text).toContain('Forever');
    expect(text).toContain('Start trading free →');
    expect(text).toContain('Why Choose Imperial Exchange?');
    expect(text).toContain('How It Works');
    await pressText(r, 'Start trading free →');
    expect(textOf(r.toJSON())).toContain('route:Register');
  });

  it('the header stays put above the scroll (LandingHeader sticky) and firms up once scrolled', async () => {
    // On the emulator the header scrolled away and the page slid under the status bar.
    const r = await mount('Landing', LandingScreen as ComponentType<never>);
    const header = r.root.findAll((n) => typeof n.type === 'string' && n.props.testID === 'landing-header')[0];
    expect(header).toBeDefined();
    for (let p = header?.parent ?? null; p; p = p.parent) expect(p.type).not.toBe(ScrollView);
    const look = (): Record<string, unknown> => StyleSheet.flatten(header?.props.style as never) as Record<string, unknown>;
    expect(look().borderBottomColor).toBe('transparent');
    const scroll = r.root.findAll((n) => n.type === ScrollView && typeof n.props.onScroll === 'function')[0];
    // window.scrollY > 8, as the web decides it.
    await act(async () => { (scroll?.props.onScroll as (e: unknown) => void)({ nativeEvent: { contentOffset: { x: 0, y: 40 } } }); });
    expect(look().borderBottomColor).not.toBe('transparent');
    await act(async () => { (scroll?.props.onScroll as (e: unknown) => void)({ nativeEvent: { contentOffset: { x: 0, y: 4 } } }); });
    expect(look().borderBottomColor).toBe('transparent');
  });
});

describe('CMS page', () => {
  const page = cmsApi.page as jest.Mock;

  it('draws a published page', async () => {
    page.mockResolvedValue({
      id: 'p1', title: 'Terms of Service', slug: 'terms', content: '<p>Be nice.</p>', visibility: 'PUBLIC',
      featuredImageUrl: null, seoTitle: null, seoDescription: null, metaKeywords: [], publishedAt: null, updatedAt: '2026-09-01T10:00:00Z',
    });
    const r = await mount('CmsPage', CmsPageScreen as ComponentType<never>, { slug: 'terms' });
    const text = textOf(r.toJSON());
    expect(text).toContain('Terms of Service');
    expect(text).toContain('Be nice.');
  });

  it('an AUTH page read signed out says "Members only"', async () => {
    page.mockRejectedValue({ response: { status: 401, data: { error: { code: 'AUTH_REQUIRED' } } } });
    const r = await mount('CmsPage', CmsPageScreen as ComponentType<never>, { slug: 'vip' });
    expect(textOf(r.toJSON())).toContain('Members only');
  });

  it('a missing page says "Page not found"', async () => {
    page.mockRejectedValue({ response: { status: 404 } });
    const r = await mount('CmsPage', CmsPageScreen as ComponentType<never>, { slug: 'gone' });
    expect(textOf(r.toJSON())).toContain('Page not found');
  });
});

describe('Feedback', () => {
  it('refuses a short subject, then sends what the server reads', async () => {
    const submit = feedbackApi.submit as jest.Mock;
    submit.mockClear();
    const r = await mount('Feedback', FeedbackScreen as ComponentType<never>);
    expect(textOf(r.toJSON())).toContain('Leave Feedback');
    expect(textOf(r.toJSON())).toContain('No submissions yet.');
    await pressText(r, 'Send Feedback');
    expect(submit).not.toHaveBeenCalled();

    const inputs = r.root.findAll((n) => typeof n.props.onChangeText === 'function' && n.props.placeholder !== undefined);
    const subject = inputs.find((n) => n.props.placeholder === 'One-line summary');
    const message = inputs.find((n) => String(n.props.placeholder).startsWith('Steps to reproduce'));
    await act(async () => { (subject?.props.onChangeText as (v: string) => void)('Chart freezes'); });
    await act(async () => { (message?.props.onChangeText as (v: string) => void)('The chart stops updating after an hour.'); });
    await pressText(r, 'Send Feedback');
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      category: 'FEATURE', subject: 'Chart freezes', message: 'The chart stops updating after an hour.', rating: null, page: '/feedback',
    }));
  });
});

describe('Helpdesk', () => {
  it('opens on the knowledge base with the articles from the server, and the chat says no manager yet', async () => {
    const r = await mount('Helpdesk', HelpdeskScreen as ComponentType<never>);
    const text = textOf(r.toJSON());
    expect(text).toContain('Knowledge Base');
    expect(text).toContain('How long do withdrawals take?');
    await pressText(r, 'Live Chat');
    expect(textOf(r.toJSON())).toContain('A support manager will be assigned soon');
  });

  it('a ?tab=tickets link opens My Tickets', async () => {
    const r = await mount('Helpdesk', HelpdeskScreen as ComponentType<never>, { tab: 'tickets' });
    expect(textOf(r.toJSON())).toContain('No tickets yet');
  });
});

describe('Partner', () => {
  it('draws the volume dashboard: tier, levels, stats and the referral link', async () => {
    (partnerApi.volumeDashboard as jest.Mock).mockResolvedValue(toVolumeDashboard({
      enabled: true,
      partnerLevel: 'SILVER',
      revenueSharePercent: 20,
      previousMonthVolume: 150000,
      currentMonthVolume: 20000,
      progressPercent: 30,
      nextLevel: { name: 'GOLD', minVolume: 500000, percent: 25 },
      volumeToNextLevel: 350000,
      tiers: [
        { name: 'BRONZE', minVolume: 0, percent: 15 },
        { name: 'SILVER', minVolume: 100000, percent: 20 },
        { name: 'GOLD', minVolume: 500000, percent: 25 },
      ],
      referralCode: 'ABC123',
      walletCurrency: 'USD',
      referralPerformance: [],
      monthlySeries: [],
    }));
    const r = await mount('Partner', PartnerScreen as ComponentType<never>);
    const text = textOf(r.toJSON());
    expect(text).toContain('Silver');
    expect(text).toContain('Partner Levels');
    expect(text).toContain('ABC123');
    expect(text).toContain('No referrals yet — share your link to start earning.');
  });
});

describe('Copy Trading', () => {
  it('with nothing yet: the invitation to become a master and the empty sections', async () => {
    const r = await mount('CopyTrading', CopyTradingScreen as ComponentType<never>);
    const text = textOf(r.toJSON());
    expect(text).toContain('Copy Trading');
    expect(text).toContain('Create a copy box');
    expect(text).toContain('No public copy boxes yet');
  });

  it('an unknown trader profile says it is unavailable', async () => {
    const r = await mount('TraderDashboard', TraderDashboardScreen as ComponentType<never>, { id: 'nobody' });
    expect(textOf(r.toJSON())).toContain('This trader profile is unavailable or private.');
  });
});
