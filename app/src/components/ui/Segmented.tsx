import React from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from './AppText';

/**
 * A segmented control — the web's button groups (BUY/SELL mode, range
 * pickers like 1D / 1W / 1M, MARKET/LIMIT). Active segment takes the same
 * `bg-primary-500/10 text-primary-600` wash as the nav pills, so "selected"
 * looks the same everywhere in the app.
 */
export interface SegmentOption<V extends string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SegmentedProps<V extends string> {
  options: SegmentOption<V>[];
  value: V;
  onChange: (value: V) => void;
  size?: 'sm' | 'md';
  /** Stretch segments to fill the row. Off for short pickers. */
  fill?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Segmented<V extends string>({
  options,
  value,
  onChange,
  size = 'md',
  fill = true,
  style,
}: SegmentedProps<V>): React.JSX.Element {
  const t = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.row,
        { backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark, borderRadius: t.radius.lg },
        style,
      ]}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active, disabled: !!o.disabled }}
            disabled={o.disabled}
            onPress={() => { if (!active) onChange(o.value); }}
            style={({ pressed }) => [
              styles.seg,
              fill ? styles.fill : null,
              {
                paddingVertical: size === 'sm' ? 4 : 7,
                paddingHorizontal: size === 'sm' ? 8 : 12,
                borderRadius: t.radius.md,
                backgroundColor: active ? t.colors.primarySoft : pressed ? t.colors.bgHover : 'transparent',
                opacity: o.disabled ? 0.45 : 1,
              },
            ]}
          >
            <AppText
              variant={size === 'sm' ? 'small' : 'body'}
              weight={active ? '700' : '600'}
              color={active ? t.colors.primaryText : t.colors.textSecondary}
              numberOfLines={1}
            >
              {o.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', borderWidth: 1, padding: 3, gap: 2 },
  seg: { alignItems: 'center', justifyContent: 'center' },
  fill: { flex: 1 },
});
