import { CommonActions } from '@react-navigation/native';
import React, { useEffect, useState, type ReactNode } from 'react';
import { Keyboard, Platform, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText, Icon, type IconName } from '@/components/ui';
import { useTheme } from '@/theme';
import { useFnoAvailable } from '@/store/features';

import { navigationRef } from '../navigationRef';
import { BOTTOM_TABS, isNavActive, type NavItem } from './primaryNav';

/**
 * The phone's bottom tab bar: Explore, Option Chain, Positions, Portfolio,
 * Wallets.
 *
 * The web has none — on a phone it draws every primary destination
 * (Layout.jsx MOBILE_NAV) on the pill strip under the header. Here the five
 * a trader moves between most moved down, where a thumb reaches them, and
 * the strip keeps the rest (Watchlist, Copy Trading).
 *
 * It is drawn by the navigator's screenLayout under every signed-in page
 * that has the app header — so not on Trade, which owns the viewport, and
 * not on the sign-in pages. A tab goes to the same route the web's link
 * does, with `pop`, so tapping a tab switches section instead of stacking
 * copies.
 *
 * The bar takes the bottom safe-area inset itself, and the page above it is
 * told the inset is zero — as the impersonation banner does for the top — so
 * the two are not both padded for the home indicator.
 */

const ICONS: Record<string, IconName> = {
  explore: 'globe',
  options: 'layers',
  positions: 'trendingUp',
  portfolio: 'hexagon',
  wallets: 'wallet',
};

const go = (item: NavItem): void => {
  if (!navigationRef.isReady()) return;
  navigationRef.dispatch(CommonActions.navigate(item.route.name, item.route.params, { pop: true }));
};

/** Out of the way while typing: over the keyboard it only squeezes the form. */
function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setShown(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}

export function BottomTabBar({ current }: { current: { name: string; params?: object } }): React.JSX.Element | null {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardShown();
  // No F&O on this backend → no Option Chain tab (store/features).
  const fno = useFnoAvailable();
  const tabs = fno ? BOTTOM_TABS : BOTTOM_TABS.filter((i) => i.route.name !== 'Options');
  if (keyboard) return null;

  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.bar,
        { backgroundColor: t.colors.surface, borderTopColor: t.colors.borderDark, paddingBottom: insets.bottom },
      ]}
    >
      {tabs.map((item) => {
        const active = isNavActive(item, current);
        const color = active ? t.colors.primaryText : t.colors.textMuted;
        return (
          <Pressable
            key={item.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={item.label}
            onPress={() => { if (!active) go(item); }}
            style={({ pressed }) => [styles.tab, pressed ? { backgroundColor: t.colors.bgHover } : null]}
          >
            <View style={[styles.iconWrap, { backgroundColor: active ? t.colors.primarySoft : 'transparent', borderRadius: t.radius.lg }]}>
              <Icon name={ICONS[item.key] ?? 'terminal'} size={22} color={color} strokeWidth={active ? 2.2 : 1.8} />
            </View>
            <AppText variant="caption" weight={active ? '700' : '600'} color={color} numberOfLines={1} adjustsFontSizeToFit>
              {item.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A page with the bar under it, the page told the bar has the bottom inset. */
export function WithBottomTabs({
  current,
  children,
}: {
  current: { name: string; params?: object };
  children: ReactNode;
}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.flex}>
      <SafeAreaInsetsContext.Provider value={{ ...insets, bottom: 0 }}>
        <View style={styles.flex}>{children}</View>
      </SafeAreaInsetsContext.Provider>
      <BottomTabBar current={current} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  bar: { flexDirection: 'row', borderTopWidth: 1 },
  tab: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center', paddingTop: 6, paddingBottom: 6, paddingHorizontal: 2, gap: 2 },
  iconWrap: { paddingHorizontal: 12, paddingVertical: 3 },
});
