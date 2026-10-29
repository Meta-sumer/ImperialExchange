import React, { useEffect, useRef } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type LayoutRectangle,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from './AppText';

/**
 * A tab bar — the web's in-page tabs (Profile: Profile / KYC / Security /
 * Devices, Helpdesk: Chat / FAQ / Tickets / New, Wallet sidebar views).
 *
 *   underline  index.css `.topnav-link-active` — primary-600 bold text with a
 *              3px primary-500 bar under it. The default.
 *   pill       the nav-pill look (`bg-primary-500/10 text-primary-600`).
 *
 * Scrolls horizontally when the tabs do not fit, and keeps the active tab
 * in view — the web's `overflow-x-auto no-scrollbar` rails, minus the
 * "silently hidden off the edge" failure Layout.jsx:344-352 describes.
 */
export interface TabItem<K extends string> {
  key: K;
  label: string;
  /** A count or short tag after the label (unread chats, NEW). */
  badge?: string | number | null;
}

export interface TabsProps<K extends string> {
  tabs: TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  variant?: 'underline' | 'pill';
  /** Lay tabs out edge to edge instead of scrolling. For 2–4 short tabs. */
  fill?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  variant = 'underline',
  fill = false,
  style,
}: TabsProps<K>): React.JSX.Element {
  const t = useTheme();
  const scroller = useRef<ScrollView>(null);
  const frames = useRef<Partial<Record<string, LayoutRectangle>>>({});

  // Keep the active tab on screen when it changes from outside (a deep link
  // to ?tab=security lands with Security visible, not scrolled away).
  useEffect(() => {
    const f = frames.current[value];
    if (f && scroller.current) scroller.current.scrollTo({ x: Math.max(0, f.x - 24), animated: true });
  }, [value]);

  const items = tabs.map((tab) => {
    const active = tab.key === value;
    const underline = variant === 'underline';
    return (
      <Pressable
        key={tab.key}
        accessibilityRole="tab"
        accessibilityState={{ selected: active }}
        onLayout={(e) => { frames.current[tab.key] = e.nativeEvent.layout; }}
        onPress={() => onChange(tab.key)}
        style={({ pressed }) => [
          styles.tab,
          fill ? styles.fill : null,
          underline
            ? { paddingVertical: 12 }
            : {
              paddingVertical: 6,
              borderRadius: t.radius.lg,
              backgroundColor: active ? t.colors.primarySoft : pressed ? t.colors.bgHover : 'transparent',
            },
        ]}
      >
        <View style={styles.labelRow}>
          <AppText
            variant="body"
            weight={active ? '700' : '600'}
            color={active ? t.colors.primaryText : t.colors.textSecondary}
            numberOfLines={1}
          >
            {tab.label}
          </AppText>
          {tab.badge != null && tab.badge !== '' && tab.badge !== 0 ? (
            <View style={[styles.badge, { backgroundColor: t.colors.primary }]}>
              <AppText variant="micro" weight="700" color={t.colors.onPrimary}>{String(tab.badge)}</AppText>
            </View>
          ) : null}
        </View>
        {underline && active ? (
          <View style={[styles.bar, { backgroundColor: t.colors.primary }]} />
        ) : null}
      </Pressable>
    );
  });

  const border = variant === 'underline'
    ? { borderBottomWidth: 1, borderBottomColor: t.colors.borderSubtle }
    : null;

  if (fill) {
    return <View accessibilityRole="tablist" style={[styles.row, border, style]}>{items}</View>;
  }
  return (
    <View style={[border, style]}>
      <ScrollView
        ref={scroller}
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="tablist"
        contentContainerStyle={styles.row}
      >
        {items}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 4 },
  tab: { paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  fill: { flex: 1 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badge: { minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  bar: { position: 'absolute', left: 12, right: 12, bottom: 0, height: 3, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
});
