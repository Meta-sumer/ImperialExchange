import React from 'react';
import { Image, View, type ImageSourcePropType, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';

/**
 * The EquityHub logo, ported from client/src/components/BrandLogo.jsx.
 *
 * The artwork is the web's own transparent cut-outs (client/public, built
 * from /branding with branding/tools): a horizontal lockup (icon beside the
 * EQUITY/HUB wordmark) for headers, a stacked one (icon over the wordmark)
 * as designed, and the icon alone. Each lockup has a dark-theme twin whose
 * deep-purple wordmark is lifted so it reads on the dark surface.
 *
 * `tile` is kept for callers written against the old white-background JPEG;
 * the art is transparent and theme-aware now, so it needs no tile.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const ART = {
  full: { light: require('./assets/equityhub-logo.png'), dark: require('./assets/equityhub-logo-dark.png'), w: 741, h: 192 },
  stacked: { light: require('./assets/equityhub-logo-stacked.png'), dark: require('./assets/equityhub-logo-stacked-dark.png'), w: 396, h: 420 },
  icon: { light: require('./assets/equityhub-icon.png'), dark: require('./assets/equityhub-icon.png'), w: 256, h: 256 },
} as const;
/* eslint-enable @typescript-eslint/no-require-imports */

export function BrandLogo({
  variant = 'full',
  height = 36,
  style,
}: {
  variant?: 'icon' | 'full' | 'stacked';
  height?: number;
  /** No longer needed (transparent, theme-aware art); accepted and ignored. */
  tile?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  const art = ART[variant];
  const width = Math.round((art.w / art.h) * height);
  return (
    <View accessibilityRole="image" accessibilityLabel="EquityHub" style={[{ width, height }, style]}>
      <Image
        source={(t.isDark ? art.dark : art.light) as ImageSourcePropType}
        resizeMode="contain"
        style={{ width, height }}
      />
    </View>
  );
}
