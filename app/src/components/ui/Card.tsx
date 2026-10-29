import React, { type ReactNode } from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';

/**
 * index.css `.card` and `.panel`.
 *
 *   card   bg-bg-card border border-border-dark rounded-xl shadow-card
 *   panel  bg-bg-panel border border-border-dark rounded-xl (no shadow)
 *   plain  the white surface with a hairline — the web's many `bg-white
 *          border rounded-xl` boxes that are not `.card`
 *
 * Pass `onPress` for a tappable card (the web's `hover:` rows); it gets the
 * hover wash as its pressed state.
 */
export interface CardProps {
  children?: ReactNode;
  variant?: 'card' | 'panel' | 'plain';
  /** Inner padding. `true` is p-4 (16); a number is used as-is; `false` is none. */
  padded?: boolean | number;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

export function Card({
  children,
  variant = 'card',
  padded = true,
  onPress,
  accessibilityLabel,
  style,
}: CardProps): React.JSX.Element {
  const t = useTheme();
  const bg = variant === 'panel' ? t.colors.bgPanel : variant === 'plain' ? t.colors.surface : t.colors.bgCard;
  const base: ViewStyle = {
    backgroundColor: bg,
    borderWidth: 1,
    borderColor: t.colors.borderDark,
    borderRadius: t.radius.xl,
    padding: padded === true ? t.space.lg : padded === false ? 0 : padded,
    ...(variant === 'card' ? t.shadow.card : null),
  };

  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        style={({ pressed }) => [base, pressed ? { backgroundColor: t.colors.bgHover } : null, style]}
      >
        {children}
      </Pressable>
    );
  }
  return <View style={[base, style]}>{children}</View>;
}
