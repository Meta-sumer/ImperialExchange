import { CommonActions } from '@react-navigation/native';
import { createNativeStackNavigator, type NativeStackNavigationOptions } from '@react-navigation/native-stack';
import React, { useEffect, type ComponentType } from 'react';

import { ErrorBoundary, ScreenChromeContext } from '@/components/ui';

import { stackFor, takePendingRoute, useAuthGate, type ResolvedAuth } from './authGate';
import { AppHeader } from './chrome/AppHeader';
import { WithBottomTabs } from './chrome/BottomTabBar';
import { useChrome } from './chrome/chromeState';
import { PublicHeader } from './chrome/PublicHeader';
import { PageFooter } from './chromeSlots';
import { navigationRef } from './navigationRef';
import { screenRegistry } from './screenRegistry';
import {
  APP_SCREENS,
  PUBLIC_SCREENS,
  type GuestScreen,
  type PublicScreen,
  type RootStackParamList,
  type ScreenName,
} from './types';

/**
 * The route tree — App.jsx's <Routes>, as one native stack with the
 * signed-in and signed-out halves as conditional groups.
 *
 *   signed in   Explore first (RootRoute sends a signed-in "/" there), the
 *               app header + pill rail, and the bottom tabs (Explore, Option
 *               Chain, Positions, Portfolio, Wallets), on every screen
 *               except Trade.
 *   signed out  Landing first on a cold start (the web's "/" for a
 *               visitor); Login first after a sign-out (the web's
 *               `navigate('/login')` in handleLogout). No header — the auth
 *               pages draw their own shell, as AuthShell does.
 *   public      ResetPassword, VerifyEmail, CmsPage, News, NewsArticle in
 *               both halves, as they are public routes on
 *               the web. CMS and news get the app header when signed in and
 *               the visitor header otherwise — PublicShell.jsx.
 *
 * Signing in or out swaps the group; no screen navigates after login or
 * logout. The `navigationKey` on the public group remounts those screens
 * across the swap, so a news page read signed-out does not keep the visitor
 * header after sign-in.
 *
 * The signed-in groups are also keyed by WHO is signed in (authGate
 * `identity`). Starting or leaving a "View As User" session changes the user
 * without changing the status; the key drops every mounted screen and
 * reopens at Explore, as the web's page load does.
 */

const Stack = createNativeStackNavigator<RootStackParamList>();

/** Public screens that draw a header (the rest are AuthShell pages). */
const PUBLIC_WITH_HEADER = new Set<PublicScreen>(['CmsPage', 'News', 'NewsArticle']);

const GUEST_ORDER_COLD: GuestScreen[] = ['Landing', 'Login', 'Register', 'ForgotPassword'];
const GUEST_ORDER_AFTER_SIGN_OUT: GuestScreen[] = ['Login', 'Landing', 'Register', 'ForgotPassword'];

const appHeader: NativeStackNavigationOptions['header'] = (props) => <AppHeader {...props} />;
const publicHeader: NativeStackNavigationOptions['header'] = (props) => <PublicHeader {...props} />;

// A route's component, as the navigator's loosely typed `component` prop
// wants it; screenRegistry is what keeps each entry honest.
const componentFor = (name: ScreenName): ComponentType => screenRegistry[name] as ComponentType;

export function RootNavigator({ auth }: { auth: ResolvedAuth }): React.JSX.Element {
  const authed = auth === 'authenticated';
  const hadSession = useAuthGate((s) => s.hadSession);
  const userKey = `user:${useAuthGate((s) => s.identity) ?? ''}`;
  const headerHeight = useChrome((s) => s.headerHeight);

  // A protected deep link opened while signed out was parked by the linking
  // layer; take it now — the web's Login.jsx `navigate(from)`. Deferred a
  // tick so the signed-in group is registered before we navigate into it.
  useEffect(() => {
    if (!authed) return undefined;
    const timer = setTimeout(() => {
      const pending = takePendingRoute();
      if (pending && navigationRef.isReady()) {
        navigationRef.dispatch(CommonActions.reset(stackFor(pending, true)));
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [authed]);

  const guestOrder = hadSession ? GUEST_ORDER_AFTER_SIGN_OUT : GUEST_ORDER_COLD;

  return (
    <Stack.Navigator
      screenOptions={{ headerShown: false }}
      screenLayout={({ children, options, route }) => {
        const hasHeader = options.headerShown !== false;
        // Per screen, not per app: a crash in one page leaves the header —
        // and the way out — standing.
        const page = <ErrorBoundary>{children}</ErrorBoundary>;
        return (
          <ScreenChromeContext.Provider value={{ hasHeader, headerHeight, Footer: hasHeader ? PageFooter : null }}>
            {/* The bottom tabs go with the app header: every signed-in page
                but Trade, which owns the viewport. */}
            {authed && hasHeader ? <WithBottomTabs current={route}>{page}</WithBottomTabs> : page}
          </ScreenChromeContext.Provider>
        );
      }}
    >
      {authed ? (
        <Stack.Group navigationKey={userKey} screenOptions={{ headerShown: true, header: appHeader }}>
          {APP_SCREENS.map((name) => (
            <Stack.Screen
              key={name}
              name={name}
              component={componentFor(name)}
              // The terminal owns the whole viewport — Layout.jsx hides the
              // header and the rail on /trade.
              options={name === 'Trade' ? { headerShown: false } : undefined}
            />
          ))}
        </Stack.Group>
      ) : (
        <Stack.Group screenOptions={{ headerShown: false }}>
          {guestOrder.map((name) => (
            <Stack.Screen key={name} name={name} component={componentFor(name)} />
          ))}
        </Stack.Group>
      )}

      <Stack.Group navigationKey={authed ? userKey : 'guest'}>
        {PUBLIC_SCREENS.map((name) => (
          <Stack.Screen
            key={name}
            name={name}
            component={componentFor(name)}
            options={PUBLIC_WITH_HEADER.has(name)
              ? { headerShown: true, header: authed ? appHeader : publicHeader }
              : { headerShown: false }}
          />
        ))}
      </Stack.Group>
    </Stack.Navigator>
  );
}
