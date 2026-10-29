import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Icon } from './Icon';

/**
 * The web's Toggle (NotificationCenter.jsx, TradeSettingsPanel.jsx):
 * a w-9 h-5 track, primary when on and border-dark when off, with a white
 * 16px knob. Drawn rather than using the platform Switch so it looks the
 * same on both platforms and in both themes — the knob is `keep-white` on
 * the web for the same reason.
 */
export function Toggle({
  value,
  onValueChange,
  disabled,
  accessibilityLabel,
}: {
  value: boolean;
  onValueChange?: (next: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}): React.JSX.Element {
  const t = useTheme();
  const x = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(x, { toValue: value ? 1 : 0, duration: 150, useNativeDriver: true }).start();
  }, [value, x]);

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={() => onValueChange?.(!value)}
      style={[
        styles.track,
        { backgroundColor: value ? t.colors.primary : t.colors.borderDark, opacity: disabled ? 0.5 : 1 },
      ]}
    >
      <Animated.View
        style={[
          styles.knob,
          { transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [2, 18] }) }] },
        ]}
      />
    </Pressable>
  );
}

/**
 * A settings row: label (+ optional description) with a Toggle on the right.
 * The whole row is the touch target, as the web's `<button>` Toggle row is.
 */
export function SwitchRow({
  label,
  description,
  value,
  onValueChange,
  disabled,
  style,
}: {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.colors.bgHover : 'transparent' }, style]}
    >
      <View style={styles.text}>
        <AppText variant="body">{label}</AppText>
        {description ? <AppText variant="small" tone="muted">{description}</AppText> : null}
      </View>
      {/* The row owns the press; the toggle is the indicator. */}
      <View pointerEvents="none">
        <Toggle value={value} disabled={disabled} />
      </View>
    </Pressable>
  );
}

/** A checkbox row — TradeSettingsPanel's calendar impact filters. */
export function Checkbox({
  label,
  value,
  onValueChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      style={[styles.check, { opacity: disabled ? 0.5 : 1 }]}
    >
      <View
        style={[
          styles.box,
          {
            borderColor: value ? t.colors.primary : t.colors.borderDark,
            backgroundColor: value ? t.colors.primary : t.colors.inputBg,
            borderRadius: 4,
          },
        ]}
      >
        {value ? <Icon name="check" size={12} color={t.colors.onPrimary} strokeWidth={3} /> : null}
      </View>
      <AppText variant="body">{label}</AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: { width: 36, height: 20, borderRadius: 10, justifyContent: 'center' },
  knob: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 1.5,
    elevation: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    minHeight: 44,
  },
  text: { flex: 1, minWidth: 0 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  box: { width: 18, height: 18, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
});
