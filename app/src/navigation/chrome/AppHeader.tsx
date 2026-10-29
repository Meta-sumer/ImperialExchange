import { CommonActions } from '@react-navigation/native';
import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';

import { AppText, BrandLogo, IconButton } from '@/components/ui';
import { useAuthStore } from '@/store/auth';
import { avatarGradient, useAppearance, useTheme } from '@/theme';

import { HeaderSearch } from '../chromeSlots';
import { initialsFor } from './accountRows';
import { useChrome } from './chromeState';
import { PillRail } from './PillRail';
import { SECTION_ROUTES } from './primaryNav';

/**
 * The signed-in header — Layout.jsx's sticky `<header>` as a phone shows it,
 * plus the nav strip under it.
 *
 *   [‹] [logo]                        [search] [theme] [avatar]
 *   [Watchlist] [Copy Trading]
 *
 * (Explore, Option Chain, Positions, Portfolio and Wallets are the bottom
 * tabs — BottomTabBar.)
 *
 * The web's phone header carries the search icon (lg:hidden), the theme
 * toggle, NotificationCenter and the profile avatar; here the bell
 * (NotificationCenter) is in the profile menu's header instead, before its ×; the "Terminal" button is `hidden sm:inline-flex` and lives in the
 * profile menu here. The back chevron is the one addition — iOS has no
 * hardware back, and the browser's back button is not part of the page. It
 * is left off the section pages the rail and the tabs switch between
 * (SECTION_ROUTES): switching section is not a step to go back from.
 *
 * native-stack draws one of these per screen; anything that must exist
 * once (the profile menu, the measured height) lives in chromeState.
 */

function Avatar({ initials }: { initials: string }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[styles.avatarRing, { backgroundColor: t.colors.surface }]}>
      <Svg width={36} height={36} style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="avatar" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={avatarGradient[0]} />
            <Stop offset="0.55" stopColor={avatarGradient[1]} />
            <Stop offset="1" stopColor={avatarGradient[2]} />
          </LinearGradient>
        </Defs>
        <Circle cx={18} cy={18} r={18} fill="url(#avatar)" />
      </Svg>
      <AppText variant="small" weight="700" color="#FFFFFF" style={styles.initials}>{initials}</AppText>
      {/* Online status dot — green with a white ring, Layout.jsx:458. */}
      <View style={[styles.dot, { backgroundColor: t.tw.green600, borderColor: t.colors.surface }]} />
    </View>
  );
}

export function AppHeader({ navigation, route, back }: NativeStackHeaderProps): React.JSX.Element {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const user = useAuthStore((s) => s.user);
  const openProfile = useChrome((s) => s.openProfile);
  const setHeaderHeight = useChrome((s) => s.setHeaderHeight);
  const { mode, toggle } = useAppearance();
  const { initials } = initialsFor(user?.firstName, user?.lastName);

  return (
    <View
      onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}
      style={{ backgroundColor: t.colors.surface, paddingTop: insets.top }}
    >
      <View style={[styles.bar, { borderBottomColor: t.colors.borderDark }]}>
        {back && !SECTION_ROUTES.has(route.name) ? (
          <IconButton
            name="chevronLeft"
            accessibilityLabel="Back"
            size={22}
            onPress={() => navigation.goBack()}
            style={styles.back}
          />
        ) : null}
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="EquityHub"
          onPress={() => navigation.dispatch(CommonActions.navigate('Explore', undefined, { pop: true }))}
        >
          <BrandLogo variant="icon" height={38} tile={t.isDark} />
        </Pressable>

        <View style={styles.spacer} />

        {HeaderSearch ? <HeaderSearch /> : null}
        <IconButton
          name={mode === 'dark' ? 'sun' : 'moon'}
          accessibilityLabel={`Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`}
          onPress={toggle}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Account menu"
          accessibilityHint="Switch account, balance, settings and sign out"
          onPress={openProfile}
          hitSlop={4}
          style={({ pressed }) => [styles.avatarBtn, pressed ? { backgroundColor: t.colors.bgHover } : null]}
        >
          <Avatar initials={initials} />
        </Pressable>
      </View>
      <PillRail current={route} />
    </View>
  );
}

const styles = StyleSheet.create({
  // h-16 px-4 gap
  bar: {
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  back: { marginLeft: -10, marginRight: -2 },
  spacer: { flex: 1 },
  avatarBtn: { padding: 2, borderRadius: 999 },
  avatarRing: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  initials: { letterSpacing: 0.4, fontSize: 12 },
  dot: { position: 'absolute', right: -1, bottom: -1, width: 11, height: 11, borderRadius: 6, borderWidth: 2 },
});
