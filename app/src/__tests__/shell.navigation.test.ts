/**
 * The route table and the auth gate — the parts of navigation that decide
 * WHERE a URL or a tap lands, pinned without a navigator.
 *
 * Every expectation below is read off client/src/App.jsx or Layout.jsx; a
 * comment names the line when the reason is not obvious.
 */
import {
  isImpersonationUrl,
  parseUrl,
  pathForRoute,
  resolveWebPath,
  type AnyRoute,
} from '@/navigation/webPaths';
import { accessOf, APP_SCREENS, GUEST_SCREENS, PUBLIC_SCREENS } from '@/navigation/types';
import { isNavActive, MOBILE_NAV, PRIMARY_NAV } from '@/navigation/chrome/primaryNav';

jest.mock('@/store/auth', () => {
  const { create } = jest.requireActual('zustand');
  return { useAuthStore: create(() => ({ status: 'idle' })) };
});

// eslint-disable-next-line import/first
import { nextIdentity, resolveGate, routeForAuth, stackFor, useAuthGate } from '@/navigation/authGate';
// eslint-disable-next-line import/first
import { useAuthStore } from '@/store/auth';

describe('parseUrl', () => {
  it('reads a web path, a web URL and the app scheme the same way', () => {
    const want = { segments: ['stock', 'RELIANCE'], query: { x: '1' }, fragment: {} };
    expect(parseUrl('/stock/RELIANCE?x=1')).toEqual(want);
    expect(parseUrl('https://trading.example.com/stock/RELIANCE?x=1')).toEqual(want);
    expect(parseUrl('equityhub://stock/RELIANCE?x=1')).toEqual(want);
    expect(parseUrl('stock/RELIANCE?x=1')).toEqual(want);
  });

  it('decodes segments and values, and survives a malformed escape', () => {
    expect(parseUrl('/stock/M%26M').segments).toEqual(['stock', 'M&M']);
    expect(parseUrl('/helpdesk?q=margin+call').query.q).toBe('margin call');
    expect(parseUrl('/stock/%E0%A4').segments).toEqual(['stock', '%E0%A4']);
  });

  it('parses the fragment as pairs, a bare anchor as a key', () => {
    expect(parseUrl('/x#a=1&b=2').fragment).toEqual({ a: '1', b: '2' });
    expect(parseUrl('/explore#market-news').fragment).toEqual({ 'market-news': '' });
  });
});

describe('resolveWebPath — App.jsx, route for route', () => {
  const cases: Array<[string, AnyRoute]> = [
    ['/', { name: 'Landing' }],
    ['/login', { name: 'Login' }],
    // Login.jsx reads no query on EquityHub (no broker login).
    ['/login?broker_error=Denied', { name: 'Login' }],
    ['/register?ref=ABC123', { name: 'Register', params: { ref: 'ABC123' } }],
    ['/forgot-password', { name: 'ForgotPassword' }],
    ['/reset-password?token=t1', { name: 'ResetPassword', params: { token: 't1' } }],
    ['/verify-email?token=t2', { name: 'VerifyEmail', params: { token: 't2' } }],
    ['/page/terms', { name: 'CmsPage', params: { slug: 'terms' } }],
    ['/news', { name: 'News' }],
    ['/news/rbi-policy', { name: 'NewsArticle', params: { slug: 'rbi-policy' } }],
    ['/dashboard', { name: 'Dashboard' }],
    ['/explore', { name: 'Explore' }],
    ['/explore#market-news', { name: 'Explore', params: { section: 'market-news' } }],
    ['/markets?view=sectors', { name: 'MarketList', params: { view: 'sectors' } }],
    ['/markets?view=most-traded&sector=futures', { name: 'MarketList', params: { view: 'most-traded', sector: 'futures' } }],
    ['/positions', { name: 'Positions' }],
    ['/options?underlying=BANKNIFTY', { name: 'Options', params: { underlying: 'BANKNIFTY' } }],
    ['/options?underlying=NIFTY&expiry=2026-10-27', { name: 'Options', params: { underlying: 'NIFTY', expiry: '2026-10-27' } }],
    ['/watchlist?share=xyz', { name: 'Watchlist', params: { share: 'xyz' } }],
    ['/trade?symbol=RELIANCE&view=terminal', { name: 'Trade', params: { symbol: 'RELIANCE', view: 'terminal' } }],
    ['/stock/RELIANCE', { name: 'StockDetail', params: { symbol: 'RELIANCE' } }],
    ['/orders', { name: 'Orders' }],
    ['/reports', { name: 'Reports' }],
    ['/alerts?symbol=TCS', { name: 'Alerts', params: { symbol: 'TCS' } }],
    ['/bonus-wallet', { name: 'BonusWallet' }],
    ['/copy-trading', { name: 'CopyTrading' }],
    ['/copy-trading/trader/u1?account=a1', { name: 'TraderDashboard', params: { id: 'u1', account: 'a1' } }],
    ['/wallet?action=withdraw', { name: 'Wallet', params: { action: 'withdraw' } }],
    ['/accounts/new', { name: 'NewAccountTiers' }],
    ['/accounts/new/PRO_IC', { name: 'NewAccountConfigure', params: { tierCode: 'PRO_IC' } }],
    ['/profile?tab=kyc', { name: 'Profile', params: { tab: 'kyc' } }],
    ['/helpdesk?tab=tickets&q=kyc', { name: 'Helpdesk', params: { tab: 'tickets', q: 'kyc' } }],
    ['/helpdesk/chat', { name: 'HelpdeskChat' }],
    ['/feedback', { name: 'Feedback' }],
  ];
  it.each(cases)('%s', (path, route) => {
    expect(resolveWebPath(path)).toEqual(route);
  });

  it('follows the redirect aliases, dropping the query as <Navigate> does', () => {
    expect(resolveWebPath('/wishlist?share=xyz')).toEqual({ name: 'Watchlist' });
    expect(resolveWebPath('/favorites')).toEqual({ name: 'Watchlist' });
    expect(resolveWebPath('/accounts')).toEqual({ name: 'Wallet' });
    expect(resolveWebPath('/funds')).toEqual({ name: 'Wallet' });
    // <Route path="/option-chain" element={<Navigate to="/options" replace />} />
    expect(resolveWebPath('/option-chain?underlying=NIFTY')).toEqual({ name: 'Options' });
    // <Route path="/subscription-wallet" element={<Navigate to="/bonus-wallet" replace />} />
    // — the Main Wallet is retired; the Bonus Wallet bills plans and takes Add Funds.
    expect(resolveWebPath('/subscription-wallet')).toEqual({ name: 'BonusWallet' });
    expect(resolveWebPath('/subscription-wallet?x=1')).toEqual({ name: 'BonusWallet' });
  });

  it('sends /affiliate, /partner and /ib-room to Partner, and /bonuses to Plans', () => {
    // App.jsx:127-128,133 — Affiliate.jsx is imported but never rendered.
    for (const p of ['/affiliate', '/partner', '/ib-room']) expect(resolveWebPath(p)).toEqual({ name: 'Partner' });
    expect(resolveWebPath('/plans')).toEqual({ name: 'Plans' });
    expect(resolveWebPath('/bonuses')).toEqual({ name: 'Plans' });
  });

  it('sends anything unknown where the catch-all does — /dashboard', () => {
    for (const p of ['/nope', '/trade/extra', '/explore/mars', '/preview/order-modal', '/download', '/page']) {
      expect(resolveWebPath(p)).toEqual({ name: 'Dashboard' });
    }
  });

  it('has none of the MetaTrading-only routes — EquityHub dropped them', () => {
    for (const p of ['/broker', '/fno', '/explore/india', '/explore/crypto', '/oauth/callback#accessToken=A']) {
      expect(resolveWebPath(p)).toEqual({ name: 'Dashboard' });
    }
  });

  it('ignores tab and action values the page would not accept', () => {
    expect(resolveWebPath('/profile?tab=hax')).toEqual({ name: 'Profile' });
    expect(resolveWebPath('/wallet?action=drain')).toEqual({ name: 'Wallet' });
    expect(resolveWebPath('/trade?view=other')).toEqual({ name: 'Trade' });
  });

});

describe('pathForRoute', () => {
  it('is the inverse of resolveWebPath for every canonical path', () => {
    const paths = [
      '/', '/login', '/register?ref=ABC', '/news/x', '/page/terms', '/explore', '/explore#market-news',
      '/markets?view=most-traded&sector=comm', '/options?underlying=CRUDEOIL&expiry=2026-11-17',
      '/positions', '/stock/M%26M', '/trade?symbol=RELIANCE&view=terminal',
      '/copy-trading/trader/u1?account=a1', '/wallet?action=deposit', '/accounts/new/PRO',
      '/profile?tab=security', '/helpdesk?tab=faq&q=kyc', '/helpdesk/chat',
    ];
    for (const p of paths) expect(pathForRoute(resolveWebPath(p))).toBe(p);
  });

  it('gives every screen a path', () => {
    for (const name of [...GUEST_SCREENS, ...PUBLIC_SCREENS, ...APP_SCREENS]) {
      expect(pathForRoute({ name, params: { slug: 's', symbol: 'S', id: 'i', tierCode: 't' } })).toMatch(/^\//);
    }
  });
});

describe('isImpersonationUrl', () => {
  it('accepts the app form and the web form', () => {
    expect(isImpersonationUrl('equityhub://imp?token=abc&info=e30')).toBe(true);
    expect(isImpersonationUrl('https://trading.example.com/#imp=abc&info=e30')).toBe(true);
    expect(isImpersonationUrl('equityhub://x?impersonationToken=abc')).toBe(true);
  });

  it('does NOT treat a password-reset or verify link as one', () => {
    // parseImpersonationLink also matches a bare `token=` — handing it this
    // URL would start a read-only session from a reset email.
    expect(isImpersonationUrl('equityhub://reset-password?token=abc')).toBe(false);
    expect(isImpersonationUrl('https://trading.example.com/verify-email?token=abc')).toBe(false);
  });
});

describe('route access', () => {
  it('puts every screen in exactly one half', () => {
    const all = [...GUEST_SCREENS, ...PUBLIC_SCREENS, ...APP_SCREENS];
    expect(new Set(all).size).toBe(all.length);
    // EquityHub's App.jsx renders 34 distinct pages (/subscription-wallet now redirects to /bonus-wallet) (Positions included);
    // /preview/order-modal and /download are not ported.
    expect(all).toHaveLength(32);
  });

  it('keeps the web public routes public', () => {
    for (const n of ['ResetPassword', 'VerifyEmail', 'CmsPage', 'News', 'NewsArticle'] as const) {
      expect(accessOf(n)).toBe('public');
    }
    expect(accessOf('Login')).toBe('guest');
    expect(accessOf('Wallet')).toBe('app');
  });
});

describe('the auth gate', () => {
  it('parks a protected route and sends a visitor to Login — ProtectedRoute', () => {
    const wallet: AnyRoute = { name: 'Wallet', params: { action: 'deposit' } };
    expect(routeForAuth(wallet, false)).toEqual({ target: { name: 'Login' }, pending: wallet });
    expect(routeForAuth(wallet, true)).toEqual({ target: wallet, pending: null });
  });

  it('sends a signed-in "/" or /login to Explore — RootRoute', () => {
    expect(routeForAuth({ name: 'Landing' }, true)).toEqual({ target: { name: 'Explore' }, pending: null });
    expect(routeForAuth({ name: 'Login' }, true).target).toEqual({ name: 'Explore' });
  });

  it('lets public routes through either way', () => {
    const verify: AnyRoute = { name: 'VerifyEmail', params: { token: 't' } };
    expect(routeForAuth(verify, true).target).toBe(verify);
    expect(routeForAuth(verify, false).target).toBe(verify);
  });

  it('opens a deep link with home underneath, so back has somewhere to go', () => {
    expect(stackFor({ name: 'StockDetail', params: { symbol: 'TCS' } }, true)).toEqual({
      index: 1,
      routes: [{ name: 'Explore' }, { name: 'StockDetail', params: { symbol: 'TCS' } }],
    });
    expect(stackFor({ name: 'Explore', params: { section: 'market-news' } }, true).routes).toHaveLength(1);
    expect(stackFor({ name: 'News' }, false).routes[0]).toEqual({ name: 'Landing' });
  });

  it('moves only on a terminal status, and forgets the pending route on sign-out', () => {
    const start = { resolved: null, hadSession: false, pending: null };
    expect(resolveGate(start, 'loading')).toBeNull();
    expect(resolveGate(start, 'idle')).toBeNull();
    expect(resolveGate(start, 'authenticated')).toEqual({ resolved: 'authenticated', hadSession: true });
    const signedIn = { resolved: 'authenticated' as const, hadSession: true, pending: { name: 'Orders' } as AnyRoute };
    // A re-bootstrap ('loading') must not unmount the app.
    expect(resolveGate(signedIn, 'loading')).toBeNull();
    expect(resolveGate(signedIn, 'unauthenticated')).toEqual({ resolved: 'unauthenticated', pending: null });
  });

  it('keys the signed-in screens by the user, ignoring the null between two users', () => {
    expect(nextIdentity(null, 'u1')).toBe('u1');
    expect(nextIdentity('u1', null)).toBe('u1');
    expect(nextIdentity('u1', undefined)).toBe('u1');
    expect(nextIdentity('u1', 'u2')).toBe('u2');
  });

  it('follows the session store: a "View As User" switch changes the key once', () => {
    const set = (s: object): void => { useAuthStore.setState(s as never); };
    set({ user: { id: 'own' }, status: 'authenticated' });
    expect(useAuthGate.getState()).toMatchObject({ resolved: 'authenticated', identity: 'own' });
    // Impersonation: bootstrap goes 'loading' → 'authenticated' as the target.
    set({ status: 'loading' });
    set({ user: { id: 'viewed' }, status: 'authenticated' });
    expect(useAuthGate.getState()).toMatchObject({ resolved: 'authenticated', identity: 'viewed' });
    // Return to Admin drops the user first — the key must not flip to empty.
    set({ user: null });
    expect(useAuthGate.getState().identity).toBe('viewed');
    set({ user: { id: 'own' } });
    expect(useAuthGate.getState().identity).toBe('own');
  });
});

describe('PRIMARY_NAV — EquityHub Layout.jsx', () => {
  it('has the six destinations in the web order and wording', () => {
    expect(PRIMARY_NAV.map((i) => i.label)).toEqual(['Explore', 'Option Chain', 'Watchlist', 'Portfolio', 'Wallets', 'Copy Trading']);
    expect(PRIMARY_NAV.map((i) => i.route.name)).toEqual(['Explore', 'Options', 'Watchlist', 'Dashboard', 'Wallet', 'CopyTrading']);
  });

  it('MOBILE_NAV slots Positions in right after Portfolio', () => {
    expect(MOBILE_NAV.map((i) => i.label)).toEqual(['Explore', 'Option Chain', 'Watchlist', 'Portfolio', 'Positions', 'Wallets', 'Copy Trading']);
  });

  it('has no MetaTrading destinations', () => {
    const labels = MOBILE_NAV.map((i) => i.label);
    for (const gone of ['Forex', 'Stocks', 'Crypto', 'F&O', 'Broker']) expect(labels).not.toContain(gone);
  });

  it('lights a destination on its route, whatever its params', () => {
    const [explore, options] = PRIMARY_NAV;
    expect(isNavActive(explore!, { name: 'Explore' })).toBe(true);
    expect(isNavActive(explore!, { name: 'Explore', params: { section: 'market-news' } })).toBe(true);
    expect(isNavActive(options!, { name: 'Options', params: { underlying: 'BANKNIFTY' } })).toBe(true);
    expect(isNavActive(options!, { name: 'Explore' })).toBe(false);
  });
});
