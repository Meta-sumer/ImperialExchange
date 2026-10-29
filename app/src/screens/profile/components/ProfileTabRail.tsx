import React, { useCallback, useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, type LayoutRectangle } from 'react-native';

import { AppText } from '@/components/ui';
import type { ProfileTab } from '@/navigation/types';
import { useTheme } from '@/theme';
import { PROFILE_TAB_ITEMS } from '@/utils/profile';

import { ProfileIcon, type ProfileIconName } from './ProfileIcons';

/** Profile.jsx — each tab's icon. */
const TAB_ICON: Readonly<Record<ProfileTab, ProfileIconName>> = {
  profile: 'user',
  kyc: 'shieldCheck',
  security: 'lock',
  devices: 'monitor',
};

/**
 * Profile.jsx — the page's own tab rail, not the kit's Tabs: a
 * `.card p-1.5` strip that scrolls sideways (`overflow-x-auto no-scrollbar`),
 * each tab an icon and a label, the active one solid primary with white text
 * and a soft blue shadow, the others secondary text on a hover tint.
 *
 * The active tab is kept in view: when it changes from outside, and as the
 * rail is first laid out (a link to ?tab=devices lands with "Active
 * Sessions" visible). The first layout arrives after the mount's effects
 * have run, so the tab's own onLayout does the reveal for the open tab.
 */
export function ProfileTabRail({
  value,
  onChange,
}: {
  value: ProfileTab;
  onChange: (tab: ProfileTab) => void;
}): React.JSX.Element {
  const t = useTheme();
  const scroller = useRef<ScrollView>(null);
  const frames = useRef<Partial<Record<ProfileTab, LayoutRectangle>>>({});
  const current = useRef(value);
  current.current = value;

  const reveal = useCallback((key: ProfileTab, animated: boolean): void => {
    const f = frames.current[key];
    if (f && scroller.current) scroller.current.scrollTo({ x: Math.max(0, f.x - 24), animated });
  }, []);

  useEffect(() => { reveal(value, true); }, [value, reveal]);

  return (
    <ScrollView
      ref={scroller}
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      style={[
        styles.card,
        { backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark, borderRadius: t.radius.xl },
        t.shadow.card,
      ]}
      contentContainerStyle={styles.row}
    >
      {PROFILE_TAB_ITEMS.map((item) => {
        const active = item.key === value;
        const fg = active ? t.colors.onPrimary : t.colors.textSecondary;
        return (
          <Pressable
            key={item.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onLayout={(e) => {
              frames.current[item.key] = e.nativeEvent.layout;
              if (item.key === current.current) reveal(item.key, false);
            }}
            onPress={() => onChange(item.key)}
            style={({ pressed }) => [
              styles.tab,
              { borderRadius: t.radius.lg },
              active
                ? [
                  { backgroundColor: t.colors.primary },
                  // shadow-[0_4px_12px_rgba(29,78,216,0.25)]
                  styles.activeShadow,
                ]
                : { backgroundColor: pressed ? t.colors.bgHover : 'transparent' },
            ]}
          >
            <ProfileIcon name={TAB_ICON[item.key]} size={16} color={fg} />
            <AppText variant="body" weight="600" color={fg} numberOfLines={1}>{item.label}</AppText>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: { flexGrow: 0, borderWidth: 1 },
  row: { flexDirection: 'row', gap: 4, padding: 6 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  activeShadow: {
    shadowColor: '#1D4ED8',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 3,
  },
});
