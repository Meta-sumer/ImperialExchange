import React from 'react';
import { Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { AppText } from '@/components/ui';
import { useTheme } from '@/theme';

/**
 * The markets pages' rounded tab pills.
 *
 *   'brand'    TopMoversCard (MarketList.jsx:565-578): text-xs, active
 *              `bg-primary-500/10 border-primary-500/30 text-primary-600`.
 *   'neutral'  FnoHome's Tabs (FnoHome.jsx:326-342): text-sm semibold,
 *              active `bg-bg-hover border-border-dark text-text-primary`.
 *
 * Scrolls sideways if the pills outgrow the row.
 */
export function PillTabs<K extends string>({
  tabs,
  value,
  onChange,
  look = 'neutral',
  style,
}: {
  tabs: readonly { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
  look?: 'brand' | 'neutral';
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  const brand = look === 'brand';
  return (
    <View style={[styles.wrap, style]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} accessibilityRole="tablist">
        {tabs.map((tab) => {
          const active = tab.key === value;
          const bg = active
            ? (brand ? t.colors.primarySoft : t.colors.bgHover)
            : (brand ? t.colors.surface : 'transparent');
          const border = active
            ? (brand ? t.alpha(t.colors.primary, 0.3) : t.colors.borderDark)
            : (brand ? t.colors.borderDark : 'transparent');
          const color = active
            ? (brand ? t.colors.primaryText : t.colors.textPrimary)
            : (brand ? t.colors.textSecondary : t.colors.textMuted);
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => onChange(tab.key)}
              style={({ pressed }) => [
                styles.pill,
                brand ? styles.pillBrand : styles.pillNeutral,
                { backgroundColor: pressed && !active ? t.colors.bgHover : bg, borderColor: border },
              ]}
            >
              <AppText
                variant={brand ? 'small' : 'bodyStrong'}
                weight={brand ? (active ? '600' : '400') : '600'}
                color={color}
                numberOfLines={1}
              >
                {tab.label}
              </AppText>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pill: { borderWidth: 1, borderRadius: 999 },
  pillBrand: { paddingHorizontal: 12, paddingVertical: 6 },
  pillNeutral: { paddingHorizontal: 16, paddingVertical: 6 },
});
