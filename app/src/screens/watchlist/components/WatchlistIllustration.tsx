import React from 'react';
import Svg, { Circle, Defs, Line, LinearGradient, Path, Polygon, Stop } from 'react-native-svg';

import { useTheme } from '@/theme';

/**
 * The empty-state art — Watchlist.jsx WatchlistIllustration: a rising line
 * over a dotted grid, ending in a starred marker. The web's fixed greys and
 * white follow the theme here, so it reads on the dark palette too.
 */
export function WatchlistIllustration(): React.JSX.Element {
  const t = useTheme();
  const grid = t.colors.borderDark;
  const brand = t.colors.primary;
  return (
    <Svg width={200} height={128} viewBox="0 0 220 140" fill="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Line x1={10} y1={40} x2={210} y2={40} stroke={grid} strokeWidth={1} strokeDasharray="2 3" />
      <Line x1={10} y1={70} x2={210} y2={70} stroke={grid} strokeWidth={1} strokeDasharray="2 3" />
      <Line x1={10} y1={100} x2={210} y2={100} stroke={grid} strokeWidth={1} strokeDasharray="2 3" />
      <Path d="M20 90 L50 80 L80 65 L110 55 L140 38 L170 28 L200 22" stroke={brand} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d="M20 90 L50 80 L80 65 L110 55 L140 38 L170 28 L200 22 L200 120 L20 120 Z" fill="url(#wishGrad)" opacity={0.18} />
      <Defs>
        <LinearGradient id="wishGrad" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%" stopColor={brand} />
          <Stop offset="100%" stopColor={brand} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Circle cx={200} cy={22} r={13} fill={t.colors.surface} stroke={brand} strokeWidth={2} />
      <Polygon points="200,14 202.2,19.7 208.5,20.1 203.5,24.1 205.2,30 200,26.6 194.8,30 196.5,24.1 191.5,20.1 197.8,19.7" fill={brand} />
    </Svg>
  );
}
