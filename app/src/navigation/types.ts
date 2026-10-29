import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';

/**
 * Every route in the app — one per route in client/src/App.jsx.
 *
 * Param names are the web's query-string / path names; every param that
 * comes from a URL is optional and a string, because a deep link can carry
 * anything or nothing; screens validate what they read.
 *
 * Web redirect aliases are not routes here — they are paths that resolve to
 * a route (navigation/webPaths.ts):
 *   /wishlist, /favorites        → Watchlist
 *   /accounts, /funds            → Wallet
 *   /affiliate, /partner, /ib-room → Partner
 *   /plans, /bonuses             → Plans
 *   /option-chain                → Options
 *
 * EquityHub's web has no /broker, /fno, /explore/india, /explore/crypto or
 * /oauth/callback (Indian markets only, no broker connect, no broker login),
 * so neither does the app.
 *
 * Not ported: /preview/order-modal (a dev-only preview page) and /download
 * (the web's "Download the app" page — this is the app).
 */

export type ProfileTab = 'profile' | 'kyc' | 'security' | 'devices';
export type HelpdeskTab = 'chat' | 'faq' | 'tickets' | 'new';
export type WalletAction = 'deposit' | 'withdraw' | 'transfer';
/** A section of Explore a link can open at — `/explore#market-news`. */
export type ExploreSection = 'market-news';

export type RootStackParamList = {
  /* ── Signed-out only ─────────────────────────────────────────────── */
  /** `/` for a visitor — the marketing landing (App.jsx RootRoute). */
  Landing: undefined;
  /** `/login` — Login.jsx reads no query. */
  Login: undefined;
  /** `/register?ref=` — a referral code from a partner link. */
  Register: { ref?: string } | undefined;
  ForgotPassword: undefined;

  /* ── Public: reachable signed in or out, as on the web ──────────── */
  /** `/reset-password?token=` */
  ResetPassword: { token?: string } | undefined;
  /** `/verify-email?token=` — opened from the email, often while signed in. */
  VerifyEmail: { token?: string } | undefined;
  /** `/page/:slug` — admin-authored CMS page. */
  CmsPage: { slug: string };
  /** `/news` */
  News: undefined;
  /** `/news/:slug` */
  NewsArticle: { slug: string };

  /* ── Signed-in (the web's <ProtectedRoute><Layout>) ─────────────── */
  Dashboard: undefined;
  /**
   * `/explore`. `section` is the web's `#market-news` anchor (MarketNewsCard's
   * "More news →"): the page opens scrolled to that section.
   */
  Explore: { section?: ExploreSection } | undefined;
  /** `/markets?view=most-traded|sectors|…&sector=indices|stocks|futures|…` */
  MarketList: { view?: string; sector?: string } | undefined;
  /** `/positions` — the open positions and pending orders (the web's mobile nav). */
  Positions: undefined;
  /** `/options?underlying=NIFTY&expiry=2026-10-27` — the option chain. */
  Options: { underlying?: string; expiry?: string } | undefined;
  /** `/watchlist?share=<code>` — a shared-watchlist import link. */
  Watchlist: { share?: string } | undefined;
  /** `/trade?symbol=RELIANCE&view=terminal` — no header, no tabs. */
  Trade: { symbol?: string; view?: 'terminal' } | undefined;
  /** `/stock/:symbol` */
  StockDetail: { symbol: string };
  Orders: undefined;
  Reports: undefined;
  /**
   * `/alerts?symbol=` — StockDetail.jsx emits the symbol and the web's
   * PriceAlerts ignores it (PORT-RULINGS, "emitted but never read"). It is
   * carried here so the port can prefill the create form, or ignore it
   * deliberately.
   */
  Alerts: { symbol?: string } | undefined;
  /** `/partner`, `/affiliate`, `/ib-room` — all render Partner on the web. */
  Partner: undefined;
  /** `/plans`, `/bonuses` */
  Plans: undefined;
  /**
   * `/bonus-wallet` — and `/subscription-wallet`, which the web now
   * redirects here: the Main Wallet is retired and the Bonus Wallet bills
   * plans and takes Add Funds.
   */
  BonusWallet: undefined;
  /** `/copy-trading` */
  CopyTrading: undefined;
  /** `/copy-trading/trader/:id?account=` */
  TraderDashboard: { id: string; account?: string };
  /**
   * `/wallet?action=deposit|withdraw|transfer` opens that panel (Wallet.jsx
   * reads it). `view` is emitted by WalletSidebar and read by nothing on the
   * web (PORT-RULINGS); it is carried for the port to honour or drop.
   */
  Wallet: { action?: WalletAction; view?: string } | undefined;
  /** `/accounts/new` */
  NewAccountTiers: undefined;
  /** `/accounts/new/:tierCode` */
  NewAccountConfigure: { tierCode: string };
  /** `/profile?tab=kyc|security|devices` */
  Profile: { tab?: ProfileTab } | undefined;
  /** `/helpdesk?tab=&q=` */
  Helpdesk: { tab?: HelpdeskTab; q?: string } | undefined;
  /** `/helpdesk/chat` */
  HelpdeskChat: undefined;
  Feedback: undefined;
};

export type ScreenName = keyof RootStackParamList;

/** Screens only a visitor sees. Signed in, these links resolve to Explore. */
export const GUEST_SCREENS = ['Landing', 'Login', 'Register', 'ForgotPassword'] as const satisfies readonly ScreenName[];

/** Screens reachable either way — public routes on the web. */
export const PUBLIC_SCREENS = [
  'ResetPassword',
  'VerifyEmail',
  'CmsPage',
  'News',
  'NewsArticle',
] as const satisfies readonly ScreenName[];

/**
 * Screens behind the web's ProtectedRoute, in App.jsx order — except
 * Explore, which leads: the first screen of the group is where a signed-in
 * app opens (RootRoute's `<Navigate to="/explore" />`).
 */
export const APP_SCREENS = [
  'Explore',
  'Dashboard',
  'MarketList',
  'Watchlist',
  'Trade',
  'StockDetail',
  'Options',
  'Positions',
  'Orders',
  'Reports',
  'Alerts',
  'Partner',
  'Plans',
  'BonusWallet',
  'CopyTrading',
  'TraderDashboard',
  'Wallet',
  'NewAccountTiers',
  'NewAccountConfigure',
  'Profile',
  'Helpdesk',
  'HelpdeskChat',
  'Feedback',
] as const satisfies readonly ScreenName[];

export type GuestScreen = (typeof GUEST_SCREENS)[number];
export type PublicScreen = (typeof PUBLIC_SCREENS)[number];
export type AppScreen = (typeof APP_SCREENS)[number];

export type Access = 'guest' | 'public' | 'app';

const GUEST = new Set<string>(GUEST_SCREENS);
const PUBLIC = new Set<string>(PUBLIC_SCREENS);

export const accessOf = (name: ScreenName): Access =>
  (GUEST.has(name) ? 'guest' : PUBLIC.has(name) ? 'public' : 'app');

/** Props a registered screen component receives. */
export type AppScreenProps<N extends ScreenName> = NativeStackScreenProps<RootStackParamList, N>;

export type AppNavigation = NativeStackNavigationProp<RootStackParamList>;

/**
 * The typed navigation object. Use this, not a bare `useNavigation()`, so a
 * wrong route name or a missing param is a compile error:
 *
 *   const nav = useAppNavigation();
 *   nav.navigate('StockDetail', { symbol: 'RELIANCE' });
 */
export const useAppNavigation = (): AppNavigation => useNavigation<AppNavigation>();

/** The typed route: `const { params } = useAppRoute<'StockDetail'>();` */
export const useAppRoute = <N extends ScreenName>(): RouteProp<RootStackParamList, N> =>
  useRoute<RouteProp<RootStackParamList, N>>();

declare global {
  // Registers the param list app-wide, so even an untyped useNavigation()
  // and <Link screen=…> are checked against it.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParamList {}
  }
}
