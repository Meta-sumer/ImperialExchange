import React, { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { FillSvg } from '@/components/common/FillSvg';
import { AppText } from '@/components/ui';
import { tw } from '@/theme';

import { endImpersonation, useImpersonation } from '../impersonationState';

/**
 * The READ-ONLY banner for an admin "View As User" session, ported from
 * client/src/components/ImpersonationBanner.jsx. Renders nothing for a
 * normal session.
 *
 * On the web it is position:fixed and publishes its height as
 * `--imp-offset` so the sticky header moves down by exactly that much. The
 * equivalent here: the banner takes the top safe-area inset itself and
 * hands everything below it a context in which the top inset is ZERO — so
 * the header (and any header-less screen) starts right under the banner
 * instead of padding for a status bar the banner already covers.
 *
 * "Return to Admin": the web closes the session and goes to /admin/. There
 * is no admin app here, so the session is closed and the app falls back to
 * this device's own sign-in, if any (store/auth exitImpersonation).
 */
export function ImpersonationFrame({ children }: { children: ReactNode }): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const { active, info } = useImpersonation();
  const [leaving, setLeaving] = useState(false);

  if (!active) return <>{children}</>;

  const leave = async (): Promise<void> => {
    if (leaving) return;
    setLeaving(true);
    try { await endImpersonation(); } finally { setLeaving(false); }
  };

  return (
    <View style={styles.flex}>
      <View accessibilityRole="alert" style={[styles.banner, { paddingTop: insets.top + 10 }]}>
        <FillSvg>
          <Defs>
            <LinearGradient id="imp" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor={tw.impersonationFrom} />
              <Stop offset="1" stopColor={tw.impersonationTo} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#imp)" />
        </FillSvg>
        <AppText style={styles.lock} accessibilityElementsHidden>🔒</AppText>
        <View style={styles.text}>
          <AppText variant="small" weight="800" color="#FFFFFF" style={styles.title}>
            VIEWING USER ACCOUNT (READ ONLY)
          </AppText>
          <AppText variant="caption" color="rgba(255,255,255,0.9)" numberOfLines={1}>
            You are impersonating{info?.email ? ` ${String(info.email)}` : ' this user'}. All actions are disabled.
          </AppText>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => { void leave(); }}
          disabled={leaving}
          style={({ pressed }) => [
            styles.exit,
            { backgroundColor: pressed ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.15)', opacity: leaving ? 0.6 : 1 },
          ]}
        >
          <AppText variant="small" weight="700" color="#FFFFFF">
            {leaving ? 'Returning…' : '← Return to Admin'}
          </AppText>
        </Pressable>
      </View>
      <SafeAreaInsetsContext.Provider value={{ ...insets, top: 0 }}>
        <View style={styles.flex}>{children}</View>
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 10,
    overflow: 'hidden',
  },
  lock: { fontSize: 18, lineHeight: 22 },
  text: { flex: 1, minWidth: 0 },
  title: { fontSize: 13, letterSpacing: 0.4 },
  exit: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
});
