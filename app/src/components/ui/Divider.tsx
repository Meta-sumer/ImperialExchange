import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';

/**
 * A hairline — the web's `border-b border-border-subtle` separators.
 * `strong` uses border-dark, the heavier rule under the header and cards.
 */
export function Divider({
  vertical = false,
  strong = false,
  inset = 0,
  spacing = 0,
  style,
}: {
  vertical?: boolean;
  strong?: boolean;
  /** Indent from the leading edge (or top, when vertical). */
  inset?: number;
  /** Margin on both sides of the rule. */
  spacing?: number;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  const color = strong ? t.colors.borderDark : t.colors.borderSubtle;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={[
        vertical
          ? { width: 1, alignSelf: 'stretch', marginTop: inset, marginHorizontal: spacing }
          : { height: 1, marginLeft: inset, marginVertical: spacing },
        { backgroundColor: color },
        style,
      ]}
    />
  );
}
