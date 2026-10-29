import type {
  HelpdeskTab,
  ProfileTab,
  RootStackParamList,
  ScreenName,
  WalletAction,
} from './types';

/**
 * Web paths ⇄ app routes.
 *
 * The web's router table (client/src/App.jsx) is transcribed here as one
 * function each way, so that every URL the product already emits — an email
 * link, a CMS page's href, a push notification's `link`, a shared watchlist
 * — lands on the same screen in the app as it does in a browser, redirects
 * and aliases included.
 *
 * Pure and synchronous: the linking config, `navigateToPath()` and the
 * tests all call it the same way.
 */

/** A route with params of the right type for its name. */
export type AnyRoute = {
  [N in ScreenName]: undefined extends RootStackParamList[N]
    ? { name: N; params?: RootStackParamList[N] }
    : { name: N; params: RootStackParamList[N] };
}[ScreenName];

export interface ParsedUrl {
  segments: string[];
  query: Record<string, string>;
  /**
   * `#a=1&b=2` parsed the same way; a bare anchor (`#market-news`) is a key
   * with an empty value.
   */
  fragment: Record<string, string>;
}

const safeDecode = (s: string): string => {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
};

const parsePairs = (s: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of s.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = safeDecode(eq < 0 ? part : part.slice(0, eq));
    const v = eq < 0 ? '' : safeDecode(part.slice(eq + 1));
    // First one wins, as URLSearchParams.get does.
    if (k && !(k in out)) out[k] = v;
  }
  return out;
};

/**
 * Split any of these into segments, query and fragment:
 *   /stock/RELIANCE?x=1                       a web path
 *   https://trading.example.com/stock/RELIANCE  a web URL
 *   equityhub://stock/RELIANCE          the app scheme (host = 1st segment)
 *   stock/RELIANCE                            what React Navigation passes
 *
 * Hand-written rather than `new URL()`: React Native's URL polyfill does
 * not implement searchParams.get on every version, and a custom scheme's
 * "host" is really the first path segment.
 */
export const parseUrl = (input: string): ParsedUrl => {
  let rest = String(input ?? '').trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
  if (scheme) {
    rest = rest.slice(scheme[0].length);
    // A web URL's host is not part of the route; an app scheme's is.
    if (/^https?$/i.test(scheme[1] ?? '')) {
      const slash = rest.search(/[/?#]/);
      rest = slash < 0 ? '' : rest.slice(slash);
    }
  }
  let fragment = '';
  const hash = rest.indexOf('#');
  if (hash >= 0) { fragment = rest.slice(hash + 1); rest = rest.slice(0, hash); }
  let query = '';
  const q = rest.indexOf('?');
  if (q >= 0) { query = rest.slice(q + 1); rest = rest.slice(0, q); }
  const segments = rest.split('/').filter(Boolean).map(safeDecode);
  return { segments, query: parsePairs(query), fragment: parsePairs(fragment) };
};

const opt = (v: string | undefined): string | undefined => {
  const s = (v ?? '').trim();
  return s === '' ? undefined : s;
};

/** Drop undefined keys; an empty object becomes undefined. */
const clean = <T extends Record<string, unknown>>(o: T): T | undefined => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return Object.keys(out).length ? (out as T) : undefined;
};

const PROFILE_TABS = new Set<ProfileTab>(['profile', 'kyc', 'security', 'devices']);
const HELPDESK_TABS = new Set<HelpdeskTab>(['chat', 'faq', 'tickets', 'new']);
const WALLET_ACTIONS = new Set<WalletAction>(['deposit', 'withdraw', 'transfer']);

const oneOf = <T extends string>(set: Set<T>, v: string | undefined): T | undefined =>
  (v !== undefined && set.has(v as T) ? (v as T) : undefined);

/** App.jsx's catch-all: `<Route path="*" element={<Navigate to="/dashboard" />} />`. */
const FALLBACK: AnyRoute = { name: 'Dashboard' };

/**
 * The route for a web path. Never null — an unknown path lands where the
 * web's catch-all sends it. The root `/` resolves to Landing; the linking
 * layer turns that into Explore for a signed-in user, as RootRoute does.
 */
export const resolveWebPath = (input: string): AnyRoute => {
  const { segments: s, query: q, fragment: f } = parseUrl(input);
  const [a, b, c] = s;
  const n = s.length;
  const exact = (len: number, route: AnyRoute): AnyRoute => (n === len ? route : FALLBACK);

  switch (a) {
    case undefined: return { name: 'Landing' };
    case 'login': return exact(1, { name: 'Login' });
    case 'register': return exact(1, { name: 'Register', params: clean({ ref: opt(q.ref) }) });
    case 'forgot-password': return exact(1, { name: 'ForgotPassword' });
    case 'reset-password': return exact(1, { name: 'ResetPassword', params: clean({ token: opt(q.token) }) });
    case 'verify-email': return exact(1, { name: 'VerifyEmail', params: clean({ token: opt(q.token) }) });
    case 'page': return b && n === 2 ? { name: 'CmsPage', params: { slug: b } } : FALLBACK;
    case 'news':
      if (n === 1) return { name: 'News' };
      return b && n === 2 ? { name: 'NewsArticle', params: { slug: b } } : FALLBACK;
    case 'dashboard': return exact(1, { name: 'Dashboard' });
    // `/explore#market-news` — MarketNewsCard's "More news →".
    case 'explore':
      return exact(1, { name: 'Explore', params: clean({ section: 'market-news' in f ? 'market-news' as const : undefined }) });
    case 'markets': return exact(1, { name: 'MarketList', params: clean({ view: opt(q.view), sector: opt(q.sector) }) });
    case 'positions': return exact(1, { name: 'Positions' });
    case 'options':
      return exact(1, { name: 'Options', params: clean({ underlying: opt(q.underlying), expiry: opt(q.expiry) }) });
    // <Navigate to="/options" replace /> — a redirect drops the query.
    case 'option-chain': return exact(1, { name: 'Options' });
    case 'watchlist': return exact(1, { name: 'Watchlist', params: clean({ share: opt(q.share) }) });
    // <Navigate to="/watchlist" replace /> — a redirect drops the query.
    case 'wishlist':
    case 'favorites': return exact(1, { name: 'Watchlist' });
    case 'trade':
      return exact(1, {
        name: 'Trade',
        params: clean({ symbol: opt(q.symbol), view: q.view === 'terminal' ? 'terminal' as const : undefined }),
      });
    case 'stock': return b && n === 2 ? { name: 'StockDetail', params: { symbol: b } } : FALLBACK;
    case 'orders': return exact(1, { name: 'Orders' });
    case 'reports': return exact(1, { name: 'Reports' });
    case 'alerts': return exact(1, { name: 'Alerts', params: clean({ symbol: opt(q.symbol) }) });
    case 'affiliate':
    case 'partner':
    case 'ib-room': return exact(1, { name: 'Partner' });
    case 'plans':
    case 'bonuses': return exact(1, { name: 'Plans' });
    // <Route path="/main-wallet" …> — the Bonus Wallet, shown as "Main Wallet".
    // /subscription-wallet (the retired wallet) and /bonus-wallet (its earlier
    // URL) are <Navigate> redirects to it on the web.
    case 'main-wallet':
    case 'subscription-wallet':
    case 'bonus-wallet': return exact(1, { name: 'BonusWallet' });
    case 'copy-trading':
      if (n === 1) return { name: 'CopyTrading' };
      if (b === 'trader' && c && n === 3) {
        return { name: 'TraderDashboard', params: { id: c, ...clean({ account: opt(q.account) }) } };
      }
      return FALLBACK;
    case 'wallet':
      return exact(1, {
        name: 'Wallet',
        params: clean({ action: oneOf(WALLET_ACTIONS, q.action), view: opt(q.view) }),
      });
    case 'accounts':
      if (n === 1) return { name: 'Wallet' }; // <Navigate to="/wallet" />
      if (b === 'new' && n === 2) return { name: 'NewAccountTiers' };
      if (b === 'new' && c && n === 3) return { name: 'NewAccountConfigure', params: { tierCode: c } };
      return FALLBACK;
    case 'funds': return exact(1, { name: 'Wallet' });
    case 'profile': return exact(1, { name: 'Profile', params: clean({ tab: oneOf(PROFILE_TABS, q.tab) }) });
    case 'helpdesk':
      if (n === 1) return { name: 'Helpdesk', params: clean({ tab: oneOf(HELPDESK_TABS, q.tab), q: opt(q.q) }) };
      return b === 'chat' && n === 2 ? { name: 'HelpdeskChat' } : FALLBACK;
    case 'feedback': return exact(1, { name: 'Feedback' });
    default: return FALLBACK;
  }
};

const qs = (pairs: Record<string, string | undefined>): string => {
  const parts = Object.entries(pairs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`);
  return parts.length ? `?${parts.join('&')}` : '';
};

const seg = (v: string): string => encodeURIComponent(v);

/**
 * The canonical web path for a route — for a share link, a "copy link", or
 * React Navigation's getPathFromState. The inverse of resolveWebPath.
 */
export const pathForRoute = (route: { name: ScreenName; params?: object }): string => {
  const p = (route.params ?? {}) as Record<string, unknown>;
  const s = (k: string): string | undefined => (typeof p[k] === 'string' ? (p[k] as string) : undefined);
  switch (route.name) {
    case 'Landing': return '/';
    case 'Login': return '/login';
    case 'Register': return `/register${qs({ ref: s('ref') })}`;
    case 'ForgotPassword': return '/forgot-password';
    case 'ResetPassword': return `/reset-password${qs({ token: s('token') })}`;
    case 'VerifyEmail': return `/verify-email${qs({ token: s('token') })}`;
    case 'CmsPage': return `/page/${seg(s('slug') ?? '')}`;
    case 'News': return '/news';
    case 'NewsArticle': return `/news/${seg(s('slug') ?? '')}`;
    case 'Dashboard': return '/dashboard';
    case 'Explore': return s('section') === 'market-news' ? '/explore#market-news' : '/explore';
    case 'MarketList': return `/markets${qs({ view: s('view'), sector: s('sector') })}`;
    case 'Positions': return '/positions';
    case 'Options': return `/options${qs({ underlying: s('underlying'), expiry: s('expiry') })}`;
    case 'Watchlist': return `/watchlist${qs({ share: s('share') })}`;
    case 'Trade': return `/trade${qs({ symbol: s('symbol'), view: s('view') })}`;
    case 'StockDetail': return `/stock/${seg(s('symbol') ?? '')}`;
    case 'Orders': return '/orders';
    case 'Reports': return '/reports';
    case 'Alerts': return `/alerts${qs({ symbol: s('symbol') })}`;
    case 'Partner': return '/partner';
    case 'Plans': return '/plans';
    case 'BonusWallet': return '/main-wallet';
    case 'CopyTrading': return '/copy-trading';
    case 'TraderDashboard': return `/copy-trading/trader/${seg(s('id') ?? '')}${qs({ account: s('account') })}`;
    case 'Wallet': return `/wallet${qs({ action: s('action'), view: s('view') })}`;
    case 'NewAccountTiers': return '/accounts/new';
    case 'NewAccountConfigure': return `/accounts/new/${seg(s('tierCode') ?? '')}`;
    case 'Profile': return `/profile${qs({ tab: s('tab') })}`;
    case 'Helpdesk': return `/helpdesk${qs({ tab: s('tab'), q: s('q') })}`;
    case 'HelpdeskChat': return '/helpdesk/chat';
    case 'Feedback': return '/feedback';
    default: return '/dashboard';
  }
};

/**
 * Is this URL an admin "View As User" link rather than a route?
 *
 * Only the dedicated forms count: the app scheme's `imp` host, or the web
 * form's `#imp=` / `imp=` / `impersonationToken=` parameter. services/
 * impersonation's parser also accepts a bare `token=`, which would make a
 * password-reset link (`/reset-password?token=…`) start a read-only session
 * — so the parser is only ever called after this says yes.
 */
export const isImpersonationUrl = (url: string): boolean => {
  const { segments } = parseUrl(url);
  if (segments[0] === 'imp') return true;
  return /[#&?]imp(?:ersonationToken)?=/.test(url);
};
