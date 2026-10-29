import React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AppText, BottomSheet } from '@/components/ui';
import { alpha, useTheme } from '@/theme';

/**
 * The terminal's side panels — Trade.jsx's right-hand icon strip and 280px
 * panel (2186-2979), which the web shows only from 1024px up. On a phone
 * they open as one sheet: the same nine tabs in the same order, the same
 * titles and counts, the chosen tab remembered while the screen lives.
 */

export type PanelTab = 'positions' | 'watchlist' | 'details' | 'about' | 'performance' | 'depth' | 'pending' | 'hotlist' | 'settings';

export const PANEL_TABS: readonly { id: PanelTab; label: string; title: string }[] = [
  { id: 'positions', label: 'Positions', title: 'Open Positions' },
  { id: 'watchlist', label: 'Instruments', title: 'Instruments' },
  { id: 'details', label: 'Details', title: 'Symbol Details' },
  { id: 'about', label: 'About', title: 'About' },
  { id: 'performance', label: 'Performance', title: 'Performance' },
  { id: 'depth', label: 'Depth', title: 'Market Depth' },
  { id: 'pending', label: 'Pending', title: 'Pending Orders' },
  { id: 'hotlist', label: 'Movers', title: 'Top Movers' },
  { id: 'settings', label: 'Settings', title: 'Settings' },
];

export function TradePanelsSheet({
  open,
  tab,
  onTab,
  onClose,
  counts,
  children,
}: {
  open: boolean;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
  counts: Partial<Record<PanelTab, number>>;
  children: React.ReactNode;
}): React.JSX.Element {
  const t = useTheme();
  const active = PANEL_TABS.find((x) => x.id === tab) ?? PANEL_TABS[0];
  const count = counts[tab];
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      bodyPadding={0}
      testID="trade-panels"
      title={(
        <View style={s.title}>
          <AppText variant="micro" weight="800" style={s.caps}>{(active?.title ?? '').toUpperCase()}</AppText>
          {count ? <AppText variant="caption" weight="700" tone="secondary">{count}</AppText> : null}
        </View>
      )}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[s.rail, { borderBottomColor: t.colors.borderSubtle }]}>
        {PANEL_TABS.map((x) => {
          const on = x.id === tab;
          return (
            <Pressable
              key={x.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              onPress={() => onTab(x.id)}
              style={[s.tab, { backgroundColor: on ? alpha(t.colors.primary, 0.15) : 'transparent', borderColor: on ? alpha(t.colors.primary, 0.3) : 'transparent' }]}
              testID={`panel-tab-${x.id}`}
            >
              <AppText variant="micro" weight="700" color={on ? t.colors.primaryText : t.colors.textSecondary}>{x.label}</AppText>
            </Pressable>
          );
        })}
      </ScrollView>
      {children}
    </BottomSheet>
  );
}

const s = StyleSheet.create({
  title: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  caps: { letterSpacing: 1.6 },
  rail: { flexDirection: 'row', gap: 6, paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
});
