import { CommonActions } from '@react-navigation/native';
import React, { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type LayoutRectangle } from 'react-native';

import { AppText, Badge } from '@/components/ui';
import { useTheme } from '@/theme';
import { useFnoAvailable } from '@/store/features';

import { navigationRef } from '../navigationRef';
import { isNavActive, RAIL_NAV, type NavItem } from './primaryNav';

/**
 * The phone nav strip — Layout.jsx's `md:hidden` MOBILE_NAV strip under the
 * header. A full-width row carrying the primary destinations the bottom tab
 * bar does not (Watchlist, Copy Trading) as pills, scrolling horizontally
 * when they do not fit, with the active one tinted `bg-primary-500/10
 * text-primary-600`. Hidden on Trade (the terminal takes the viewport); the
 * navigator simply does not draw the header there.
 *
 * One thing the web lacked: the active pill is scrolled into view, so a deep
 * link never lands with the lit pill off the edge.
 */
export function PillRail({ current }: { current: { name: string; params?: object } }): React.JSX.Element {
  const t = useTheme();
  const fno = useFnoAvailable();
  const items = fno ? RAIL_NAV : RAIL_NAV.filter((i) => i.route.name !== 'Options');
  const scroller = useRef<ScrollView>(null);
  const frames = useRef<Partial<Record<string, LayoutRectangle>>>({});
  const activeKey = items.find((i) => isNavActive(i, current))?.key ?? null;

  useEffect(() => {
    const f = activeKey ? frames.current[activeKey] : undefined;
    if (f) scroller.current?.scrollTo({ x: Math.max(0, f.x - 12), animated: false });
  }, [activeKey]);

  const go = (item: NavItem): void => {
    if (!navigationRef.isReady()) return;
    // `pop`: go back to the destination if it is already in the stack
    // rather than piling up copies — tapping the strip should feel like
    // switching section, not drilling deeper.
    navigationRef.dispatch(CommonActions.navigate(item.route.name, item.route.params, { pop: true }));
  };

  return (
    <View style={[styles.wrap, { backgroundColor: t.colors.surface, borderBottomColor: t.colors.borderDark }]}>
      <ScrollView
        ref={scroller}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        accessibilityRole="tablist"
      >
        {items.map((item) => {
          const active = item.key === activeKey;
          return (
            <Pressable
              key={item.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={item.badge ? `${item.label}, ${item.badge}` : item.label}
              onLayout={(e) => {
                frames.current[item.key] = e.nativeEvent.layout;
                if (active) scroller.current?.scrollTo({ x: Math.max(0, e.nativeEvent.layout.x - 12), animated: false });
              }}
              onPress={() => { if (!active) go(item); }}
              style={({ pressed }) => [
                styles.pill,
                {
                  borderRadius: t.radius.lg,
                  backgroundColor: active ? t.colors.primarySoft : pressed ? t.colors.bgHover : 'transparent',
                },
              ]}
            >
              <AppText
                variant="body"
                weight="600"
                color={active ? t.colors.primaryText : t.colors.textSecondary}
              >
                {item.label}
              </AppText>
              {item.badge ? <Badge label={item.badge} tone="primary" solid size="xs" /> : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderBottomWidth: 1 },
  // px-3 py-2 gap-1
  row: { paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  // px-3 py-1.5 text-sm font-semibold
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6 },
});
