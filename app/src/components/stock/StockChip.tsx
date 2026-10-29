import React from 'react';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { AppText } from '@/components/ui';
import { useTheme } from '@/theme';

/**
 * The page's pill chip — the range chips and the Quarterly / Yearly switch:
 * `rounded-full text-[12px] font-bold border`, active
 * `border-primary-600 text-primary-600 bg-primary-500/10`, idle
 * `border-border-dark text-text-secondary bg-white`.
 */
export function StockChip({
  label,
  active,
  onPress,
  minWidth,
  style,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  minWidth?: number;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          minWidth,
          borderColor: active ? t.colors.primaryText : t.colors.borderDark,
          backgroundColor: active ? t.colors.primarySoft : pressed ? t.colors.bgHover : t.colors.surface,
        },
        style,
      ]}
    >
      <AppText variant="small" weight="700" align="center" color={active ? t.colors.primaryText : t.colors.textSecondary}>
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
