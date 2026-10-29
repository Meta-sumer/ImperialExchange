import React from 'react';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Line, Path, Rect } from 'react-native-svg';

import { useTheme } from '@/theme';
import { STOCK_COLORS } from '@/utils/stockDetail';

/**
 * The instrument page's inline stroke icons, path data verbatim from
 * StockDetail.jsx. They are not in the kit's icon set (which carries the
 * header's icons), and they are used only here.
 */
export const STOCK_ICON_PATHS = {
  /** "Options chain". */
  link: ['M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1', 'M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1'],
  /** "Set a price alert". */
  bell: ['M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.7 21a2 2 0 0 1-3.4 0'],
  /** "Add to watchlist". */
  bookmark: ['M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'],
  /** The "Terminal" link. */
  bars: ['M6 4v16M10 8v8M14 6v12M18 10v4'],
  /** The floating Trade button. */
  trade: ['M3 3v18h18', 'M7 14l4-4 3 3 5-6'],
  /** A news row's ↗. */
  external: ['M7 17L17 7M9 7h8v8'],
  /** "All Financials ›" and similar. */
  chevronRight: ['M9 6l6 6-6 6'],
} as const;

export type StockIconName = keyof typeof STOCK_ICON_PATHS;

export function StockIcon({
  name,
  size = 16,
  color,
  strokeWidth = 1.8,
}: {
  name: StockIconName;
  size?: number;
  color: string;
  strokeWidth?: number;
}): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {STOCK_ICON_PATHS[name].map((d) => (
        <Path key={d} d={d} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      ))}
    </Svg>
  );
}

/**
 * The chart-mode toggle's glyph — StockDetail.jsx:250-254. In line mode it
 * offers candles (a green and an orange candle); in candle mode, a line.
 */
export function ChartModeGlyph({ mode, size = 16 }: { mode: 'line' | 'candle'; size?: number }): React.JSX.Element {
  if (mode === 'line') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Line x1="7" y1="3" x2="7" y2="21" stroke={STOCK_COLORS.up} strokeWidth={1.5} strokeLinecap="round" />
        <Rect x="4.5" y="7" width="5" height="8" fill={STOCK_COLORS.up} />
        <Line x1="16" y1="3" x2="16" y2="21" stroke={STOCK_COLORS.down} strokeWidth={1.5} strokeLinecap="round" />
        <Rect x="13.5" y="10" width="5" height="7" fill={STOCK_COLORS.down} />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M3 15l4-5 4 3 5-8 5 6" stroke={STOCK_COLORS.up} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

/**
 * The page's round outline button — `w-9 h-9 rounded-full border
 * border-border-dark`. `accessibilityLabel` is the web's `title`.
 */
export function RoundIconButton({
  accessibilityLabel,
  onPress,
  children,
  size = 36,
  style,
  testID,
}: {
  accessibilityLabel: string;
  onPress: () => void;
  children: React.ReactNode;
  size?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        styles.round,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderColor: t.colors.borderDark,
          backgroundColor: pressed ? t.colors.bgHover : 'transparent',
        },
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  round: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
});
