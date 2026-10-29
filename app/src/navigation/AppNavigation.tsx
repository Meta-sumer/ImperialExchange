import { NavigationContainer } from '@react-navigation/native';
import React, { useMemo, type ReactNode } from 'react';

import { ConfirmProvider, LoadingView, PortalHost, ToastHost } from '@/components/ui';
import { navigationTheme, useTheme } from '@/theme';

import { useAuthGate } from './authGate';
import { ImpersonationFrame } from './chrome/ImpersonationBanner';
import { ProfileMenu } from './chrome/ProfileMenu';
import { AppProviders, GlobalOverlays } from './chromeSlots';
import { linking } from './linking';
import { navigationRef } from './navigationRef';
import { RootNavigator } from './RootNavigator';

/**
 * Everything between the boot gate and the screens.
 *
 * ── ORDER, AND WHY ────────────────────────────────────────────────────
 *   boot splash      until the FIRST bootstrap settles. The container is
 *                    not mounted before then on purpose: it resolves the
 *                    launch URL the moment it mounts, and resolving
 *                    "/wallet" needs to know whether anyone is signed in.
 *   NavigationContainer  linking, theme, the ref.
 *   PortalHost       the overlay layer, INSIDE the container so a modal's
 *                    content can still navigate.
 *   ConfirmProvider  inside PortalHost (it renders a modal).
 *   ImpersonationFrame   the read-only banner, above the headers.
 *   AppProviders     slot: WatchlistModalProvider and friends.
 *   RootNavigator
 *   GlobalOverlays   slot: GlobalAlertPopup.
 *   ProfileMenu      once for the whole app, signed in only.
 *   ToastHost        last, so toasts sit above every modal.
 * ──────────────────────────────────────────────────────────────────────
 */

function Providers({ children }: { children: ReactNode }): React.JSX.Element {
  return AppProviders.reduceRight<React.JSX.Element>(
    (inner, Provider, i) => <Provider key={i}>{inner}</Provider>,
    <>{children}</>,
  );
}

export function AppNavigation(): React.JSX.Element {
  const t = useTheme();
  const auth = useAuthGate((s) => s.resolved);
  const navTheme = useMemo(() => navigationTheme(t), [t]);

  if (auth === null) return <LoadingView fullScreen />;

  return (
    <NavigationContainer
      ref={navigationRef}
      linking={linking}
      theme={navTheme}
      fallback={<LoadingView fullScreen />}
    >
      <PortalHost>
        <ConfirmProvider>
          <ImpersonationFrame>
            <Providers>
              <RootNavigator auth={auth} />
            </Providers>
            {GlobalOverlays.map((Overlay, i) => <Overlay key={i} />)}
          </ImpersonationFrame>
          {auth === 'authenticated' ? <ProfileMenu /> : null}
        </ConfirmProvider>
        <ToastHost />
      </PortalHost>
    </NavigationContainer>
  );
}
