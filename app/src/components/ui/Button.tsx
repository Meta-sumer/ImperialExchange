import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useTheme, type AppTheme } from '@/theme';

import { AppText } from './AppText';
import { Icon, type IconName } from './Icon';

/**
 * Buttons, from index.css's `.btn-*` classes.
 *
 *   primary   .btn-primary   #1D4ED8, #1E40AF pressed, white label
 *   secondary .btn-secondary card surface, hairline border
 *   ghost     .btn-ghost     transparent, border, primary border on press
 *   danger    .btn-bear      #FF3B57, #E62E48 pressed
 *   bull      .btn-bull      #00C853, #00A847 pressed — BUY
 *
 * `danger` and `bear` are the same button: the web uses `.btn-bear` for
 * both SELL and destructive confirms, and ConfirmProvider's danger button
 * is `bg-bear`.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'bull' | 'bear';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  title: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Shown instead of the title while loading, e.g. "Saving…". */
  loadingTitle?: string;
  leftIcon?: IconName;
  rightIcon?: IconName;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}

interface Look { bg: string; bgPressed: string; border: string; borderPressed: string; fg: string }

const look = (t: AppTheme, v: ButtonVariant): Look => {
  const c = t.colors;
  switch (v) {
    case 'primary':
      return { bg: c.primary, bgPressed: c.primaryPressed, border: c.primary, borderPressed: c.primaryPressed, fg: c.onPrimary };
    case 'secondary':
      return { bg: c.bgCard, bgPressed: c.bgHover, border: c.borderDark, borderPressed: c.borderDark, fg: c.textPrimary };
    case 'ghost':
      return { bg: 'transparent', bgPressed: c.bgHover, border: c.borderDark, borderPressed: c.primary, fg: c.textSecondary };
    case 'bull':
      return { bg: c.bull, bgPressed: t.tw.bullPressed, border: c.bull, borderPressed: t.tw.bullPressed, fg: c.onPrimary };
    case 'danger':
    case 'bear':
    default:
      return { bg: c.bear, bgPressed: t.tw.bearPressed, border: c.bear, borderPressed: t.tw.bearPressed, fg: c.onPrimary };
  }
};

const SIZE: Record<ButtonSize, { px: number; py: number; text: 'small' | 'body' | 'title'; icon: number; minH: number }> = {
  sm: { px: 12, py: 6, text: 'small', icon: 14, minH: 32 },
  // .btn — px-4 py-2 text-sm. 44 is the platform minimum touch target, and
  // py-2 on a 20px line is 36, so the height is raised rather than the pad.
  md: { px: 16, py: 8, text: 'body', icon: 16, minH: 44 },
  lg: { px: 20, py: 12, text: 'title', icon: 18, minH: 50 },
};

export function Button({
  title,
  variant = 'primary',
  size = 'md',
  loading = false,
  loadingTitle,
  leftIcon,
  rightIcon,
  fullWidth,
  disabled,
  style,
  ...rest
}: ButtonProps): React.JSX.Element {
  const t = useTheme();
  const l = look(t, variant);
  const sz = SIZE[size];
  const inactive = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: loading }}
      disabled={inactive}
      {...rest}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: sz.minH,
          paddingHorizontal: sz.px,
          paddingVertical: sz.py,
          borderRadius: t.radius.lg,
          backgroundColor: pressed ? l.bgPressed : l.bg,
          borderColor: pressed ? l.borderPressed : l.border,
          // disabled:opacity-50, the web's convention for every button.
          opacity: disabled && !loading ? 0.5 : 1,
        },
        fullWidth ? styles.full : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={l.fg} />
      ) : leftIcon ? (
        <Icon name={leftIcon} size={sz.icon} color={l.fg} />
      ) : null}
      <AppText variant={sz.text} weight="600" color={l.fg} numberOfLines={1}>
        {loading && loadingTitle ? loadingTitle : title}
      </AppText>
      {rightIcon && !loading ? <Icon name={rightIcon} size={sz.icon} color={l.fg} /> : null}
    </Pressable>
  );
}

/** A square icon-only button — the header's `p-2 rounded-lg` controls. */
export function IconButton({
  name,
  onPress,
  accessibilityLabel,
  size = 18,
  color,
  disabled,
  style,
}: {
  name: IconName;
  onPress?: () => void;
  accessibilityLabel: string;
  size?: number;
  color?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={6}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.iconBtn,
        { borderRadius: t.radius.lg, backgroundColor: pressed ? t.colors.bgHover : 'transparent' },
        disabled ? styles.dim : null,
        style,
      ]}
    >
      <View>
        <Icon name={name} size={size} color={color ?? t.colors.textSecondary} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
  },
  full: { alignSelf: 'stretch' },
  iconBtn: { padding: 8, alignItems: 'center', justifyContent: 'center' },
  dim: { opacity: 0.5 },
});
