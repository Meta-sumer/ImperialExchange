import { CommonActions, type LinkingOptions } from '@react-navigation/native';
import Constants from 'expo-constants';
import { Linking } from 'react-native';

import { WEB_ORIGIN } from '@/constants/env';

import { isAuthed, routeForAuth, setPendingRoute, stackFor } from './authGate';
import { startImpersonationFromLink } from './impersonationState';
import { navigationRef } from './navigationRef';
import type { RootStackParamList } from './types';
import { isImpersonationUrl, pathForRoute, resolveWebPath, type AnyRoute } from './webPaths';

/**
 * Deep links.
 *
 * Every URL is resolved by webPaths.ts — the transcription of App.jsx's
 * route table — rather than by React Navigation's pattern config, because
 * the web's table has things a pattern config cannot say: redirects that
 * drop the query (/wishlist), aliases (/ib-room → Partner), a param that
 * lives in the fragment (/explore#market-news → the news section), and a
 * redirect that is a different path (/option-chain → /options).
 *
 * Accepted:
 *   equityhub://stock/RELIANCE      the app scheme (app.json `scheme`)
 *   https://<web origin>/stock/RELIANCE   when EXPO_PUBLIC_WEB_ORIGIN (or
 *                                         expo.extra.webOrigin) names the web
 *                                         app's origin, so a link copied from
 *                                         the browser opens the same screen
 *   equityhub://imp?token=…&info=…  admin "View As User" — consumed
 *   …/#imp=…&info=…                       here, never navigated
 */

const scheme = typeof Constants.expoConfig?.scheme === 'string' ? Constants.expoConfig.scheme : 'imperialexchange';

// WEB_ORIGIN is the one web-origin setting; api/partner builds referral
// links on the same value, so a link the app hands out opens the app again.
export const LINK_PREFIXES: string[] = [`${scheme}://`, ...(WEB_ORIGIN ? [WEB_ORIGIN] : [])];

/** URLs that are actions, not destinations. True when consumed. */
const consumeSpecial = (url: string): boolean => {
  if (isImpersonationUrl(url)) return startImpersonationFromLink(url);
  return false;
};

/** The navigation state for a web path, given who is signed in. */
const stateForPath = (path: string) => {
  const authed = isAuthed();
  const { target, pending } = routeForAuth(resolveWebPath(path), authed);
  if (pending) setPendingRoute(pending);
  return stackFor(target, authed);
};

export const linking: LinkingOptions<RootStackParamList> = {
  prefixes: LINK_PREFIXES,

  async getInitialURL() {
    const url = await Linking.getInitialURL();
    if (!url || consumeSpecial(url)) return null;
    return url;
  },

  subscribe(listener) {
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (!consumeSpecial(url)) listener(url);
    });
    return () => sub.remove();
  },

  getStateFromPath: (path) => stateForPath(path) as ReturnType<NonNullable<LinkingOptions<RootStackParamList>['getStateFromPath']>>,

  getPathFromState(state) {
    const route = state.routes[state.index ?? state.routes.length - 1];
    return route ? pathForRoute({ name: route.name as AnyRoute['name'], params: route.params }) : '/';
  },

  /**
   * A link that arrives while the app is running navigates to its screen —
   * going back to it if it is already in the stack — instead of the
   * default, which RESETS the whole stack for any two-route state and would
   * throw away where the user was.
   */
  getActionFromState(state) {
    const route = state.routes[state.index ?? state.routes.length - 1];
    if (!route) return undefined;
    return CommonActions.navigate(route.name, route.params, { pop: true });
  },
};

/**
 * Navigate by WEB PATH — for a CMS page's links, a notification's `link`,
 * a server-sent redirect, anything that speaks the web's URLs:
 *
 *   navigateToPath('/stock/RELIANCE');
 *   navigateToPath('/wallet?action=deposit');
 *
 * Aliases and redirects resolve as on the web. A protected path while
 * signed out goes to Login and is taken after sign-in. Returns false before
 * the navigator is ready.
 */
export const navigateToPath = (path: string): boolean => {
  if (!navigationRef.isReady()) return false;
  if (consumeSpecial(path)) return true;
  const authed = isAuthed();
  const { target, pending } = routeForAuth(resolveWebPath(path), authed);
  if (pending) setPendingRoute(pending);
  navigationRef.dispatch(CommonActions.navigate(target.name, target.params, { pop: true }));
  return true;
};
