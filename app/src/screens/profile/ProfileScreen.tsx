import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';

import { Screen } from '@/components/ui';
import type { AppScreenProps, ProfileTab } from '@/navigation/types';
import { useAuthStore } from '@/store/auth';
import { initialProfileTab, tabParam } from '@/utils/profile';

import { DevicesTab } from './components/DevicesTab';
import { KycTab } from './components/KycTab';
import { ProfileDetailsTab } from './components/ProfileDetailsTab';
import { ProfileHero } from './components/ProfileHero';
import { ProfileTabRail } from './components/ProfileTabRail';
import { SecurityTab } from './components/SecurityTab';

/**
 * client/src/pages/Profile.jsx — `/profile?tab=profile|kyc|security|devices`.
 *
 * The hero, the tab rail, and one of four tabs:
 *   Profile           email + resend verification, referral, personal info
 *   KYC Verification  status; Step 1 the PAN card (required), Step 2 the
 *                     other documents (locked until a PAN card is on file);
 *                     documents on file
 *   Security          change password (EquityHub has no two-factor sign-in)
 *   Active Sessions   signed-in sessions, this device marked, revoke
 *
 * The tab lives in the route params the way the web keeps it in `?tab=`
 * (dropped for the default tab), so a link or a notification can open a
 * tab directly, and one that arrives while the screen is open switches to
 * it. Pull to refresh re-reads the user and the open tab's list — the
 * web's page reload.
 *
 * The user is also re-read from /auth/me as the screen opens. The web's
 * Profile is usually reached on a fresh page load, whose /auth/me carries
 * the populated `referredBy` and the current KYC / email state; an app
 * session lives for days, and after an in-app sign-in the store holds the
 * login response, whose `referredBy` is a bare id.
 *
 * For the same reason the page re-reads (the user, and the open tab's list)
 * when it is come back to: focused again after another screen was on top
 * (the avatar menu pops back to an existing Profile), or the app brought
 * back from the background — the usual way back from the mail app after
 * following the verification link, or from the camera. Each of those is a
 * fresh page load on the web.
 */
export function ProfileScreen({ navigation, route }: AppScreenProps<'Profile'>): React.JSX.Element {
  const user = useAuthStore((s) => s.user);
  const refreshUser = useAuthStore((s) => s.refreshUser);
  const paramTab = route.params?.tab;
  const [tab, setTabState] = useState<ProfileTab>(() => initialProfileTab(paramTab));
  const [reloadSignal, setReloadSignal] = useState(0);

  // The tab follows the param both ways: a link naming a tab opens it, and
  // one naming none (the avatar menu's "Settings", `/profile`) opens the
  // default tab — setTab writes no param for it — instead of leaving the
  // page on whichever tab was open with the route saying otherwise.
  useEffect(() => {
    setTabState(initialProfileTab(paramTab));
  }, [paramTab]);

  useEffect(() => { void refreshUser(); }, [refreshUser]);

  const setTab = useCallback((next: ProfileTab): void => {
    setTabState(next);
    navigation.setParams({ tab: tabParam(next) });
  }, [navigation]);

  const onUpdate = useCallback(async (): Promise<void> => {
    await refreshUser();
  }, [refreshUser]);

  const onRefresh = useCallback(async (): Promise<void> => {
    setReloadSignal((n) => n + 1);
    await refreshUser();
  }, [refreshUser]);

  const latestRefresh = useRef(onRefresh);
  latestRefresh.current = onRefresh;

  useEffect(() => {
    // Focus after a blur only: the first focus is the mount, already read.
    let away = false;
    const offBlur = navigation.addListener('blur', () => { away = true; });
    const offFocus = navigation.addListener('focus', () => {
      if (!away) return;
      away = false;
      void latestRefresh.current();
    });
    // From the background only — 'inactive' is iOS's notification shade or
    // app switcher peek, not a visit elsewhere.
    let prev: string = AppState.currentState;
    const sub = AppState.addEventListener('change', (next) => {
      const returned = prev === 'background' && next === 'active';
      prev = next;
      if (returned && navigation.isFocused()) void latestRefresh.current();
    });
    return () => {
      offBlur();
      offFocus();
      sub.remove();
    };
  }, [navigation]);

  return (
    <Screen onRefresh={onRefresh} testID="profile-screen">
      <View style={styles.page}>
        <ProfileHero user={user} />

        <ProfileTabRail value={tab} onChange={setTab} />

        {tab === 'profile' ? <ProfileDetailsTab user={user} onUpdate={onUpdate} /> : null}
        {tab === 'kyc' ? <KycTab user={user} onUpdate={onUpdate} reloadSignal={reloadSignal} /> : null}
        {tab === 'security' ? <SecurityTab /> : null}
        {tab === 'devices' ? <DevicesTab reloadSignal={reloadSignal} /> : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  // max-w-[1100px] mx-auto space-y-6 pb-10
  page: { width: '100%', maxWidth: 1100, alignSelf: 'center', gap: 24, paddingBottom: 40 },
});
