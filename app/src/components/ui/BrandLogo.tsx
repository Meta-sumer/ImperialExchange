import React from 'react';
import { Image, View, type ImageSourcePropType, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';

/**
 * The Imperial Exchange logo, ported from client/src/components/BrandLogo.jsx.
 *
 * The artwork is cut from the brand's supplied logo (eye mark over the
 * IMPERIAL / EXCHANGE wordmark and the "Trade · Invest · Grow" tagline): a
 * horizontal lockup (eye beside the wordmark) for headers, the stacked badge
 * as designed, and the eye alone. The art sits on its own navy ground, so
 * one file serves light and dark surfaces alike — no theme twin is needed.
 *
 * `tile` is kept for callers written against the old white-background JPEG;
 * the art carries its own ground now, so it needs no tile.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const FULL = require('./assets/imperialexchange-logo.png');
const STACKED = require('./assets/imperialexchange-logo-stacked.png');
const ICON = require('./assets/imperialexchange-icon.png');
/* eslint-enable @typescript-eslint/no-require-imports */

const ART = {
  full: { light: FULL, dark: FULL, w: 1342, h: 384 },
  stacked: { light: STACKED, dark: STACKED, w: 900, h: 750 },
  icon: { light: ICON, dark: ICON, w: 256, h: 256 },
} as const;

export function BrandLogo({
  variant = 'full',
  height = 36,
  style,
}: {
  variant?: 'icon' | 'full' | 'stacked';
  height?: number;
  /** No longer needed (the art carries its own ground); accepted and ignored. */
  tile?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  const art = ART[variant];
  const width = Math.round((art.w / art.h) * height);
  return (
    <View accessibilityRole="image" accessibilityLabel="Imperial Exchange" style={[{ width, height, borderRadius: Math.round(height * 0.12), overflow: 'hidden' }, style]}>
      <Image
        source={(t.isDark ? art.dark : art.light) as ImageSourcePropType}
        resizeMode="contain"
        style={{ width, height }}
      />
    </View>
  );
}
