import type { ScreenName } from '../types';
import type { AnyRoute } from '../webPaths';

/**
 * The primary destinations — client/src/components/Layout.jsx PRIMARY_NAV,
 * in order, with the same labels:
 *
 *   Explore · Option Chain · Watchlist · Portfolio · Wallets · Copy Trading
 *
 * plus MOBILE_ONLY_NAV's Positions, which the web's phone strip slots in
 * after Portfolio (MOBILE_NAV) — "on mobile there is no right rail and the
 * terminal is several taps away, which is the case this entry exists for".
 *
 * On a phone the web draws MOBILE_NAV as one horizontally scrolling pill
 * strip under the header. This app splits it: the five a trader goes back and
 * forth between most are a bottom tab bar, where a thumb reaches them, and
 * the rest stay on the pill strip (BOTTOM_TABS, RAIL_NAV below).
 */
export interface NavItem {
  key: string;
  label: string;
  route: AnyRoute;
  badge?: string;
}

/** Layout.jsx PRIMARY_NAV, verbatim. */
export const PRIMARY_NAV: readonly NavItem[] = [
  { key: 'explore', label: 'Explore', route: { name: 'Explore' } },
  { key: 'options', label: 'Option Chain', route: { name: 'Options' } },
  { key: 'watchlist', label: 'Watchlist', route: { name: 'Watchlist' } },
  { key: 'portfolio', label: 'Portfolio', route: { name: 'Dashboard' } },
  { key: 'wallets', label: 'Wallets', route: { name: 'Wallet' } },
  { key: 'copy', label: 'Copy Trading', route: { name: 'CopyTrading' } },
];

/** Layout.jsx MOBILE_ONLY_NAV. */
export const POSITIONS_NAV: NavItem = { key: 'positions', label: 'Positions', route: { name: 'Positions' } };

/** Layout.jsx MOBILE_NAV: Positions right after Portfolio, with the other "my money" pages. */
export const MOBILE_NAV: readonly NavItem[] = (() => {
  const i = PRIMARY_NAV.findIndex((x) => x.route.name === 'Dashboard');
  const at = i < 0 ? PRIMARY_NAV.length : i + 1;
  return [...PRIMARY_NAV.slice(0, at), POSITIONS_NAV, ...PRIMARY_NAV.slice(at)];
})();

/**
 * The phone's bottom tabs, in this order. The web has no tab bar; this is
 * where the app departs from it.
 */
export const BOTTOM_TAB_KEYS: readonly string[] = ['explore', 'options', 'positions', 'portfolio', 'wallets'];

export const BOTTOM_TABS: readonly NavItem[] = BOTTOM_TAB_KEYS
  .map((k) => MOBILE_NAV.find((item) => item.key === k))
  .filter((item): item is NavItem => !!item);

/** The pill strip under the header: what the bottom bar does not carry, in MOBILE_NAV order. */
export const RAIL_NAV: readonly NavItem[] = MOBILE_NAV.filter((item) => !BOTTOM_TAB_KEYS.includes(item.key));

/**
 * The section pages — every route the strip or the bottom tabs open. They are
 * top level, switched between rather than drilled into, so the header draws
 * no back chevron on them even when the stack has pages underneath; a page
 * opened FROM one (a stock, a deposit) keeps it. Android's back still works.
 */
export const SECTION_ROUTES: ReadonlySet<string> = new Set(MOBILE_NAV.map((item) => item.route.name));

/**
 * NavLink's isActive, for a route instead of a pathname: each destination is
 * one route, and its query (an underlying, a share code) does not change
 * which section you are in.
 */
export const isNavActive = (
  item: NavItem,
  current: { name: string; params?: object | undefined },
): boolean => item.route.name === (current.name as ScreenName);
