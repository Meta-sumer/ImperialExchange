import React from 'react';
import Svg, { Path } from 'react-native-svg';

import { useTheme } from '@/theme';

/**
 * The inline icons Explore.jsx draws from its own `I` map (Explore.jsx:32-61)
 * that the kit's Icon set does not carry — sector and product glyphs, the
 * change-pill arrows, the row pencil. Paths are the web's, 24×24, stroke
 * 1.8 with round caps, like the kit's.
 */
const PATHS = {
  bookmark: ['M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'],
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
  arrowUp: ['M7 17l10-10', 'M7 7h10v10'],
  arrowDn: ['M17 7L7 17', 'M17 17H7V7'],
  chevron: ['M9 18l6-6-6-6'],
  copy: [
    'M20 7H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z',
    'M16 21V5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2',
  ],
  signal: ['M2 12h4', 'M10 7h4', 'M18 2h4', 'M2 18h4', 'M10 13h4', 'M18 8h4'],
  bank: ['M3 21h18', 'M5 21V10', 'M9 21V10', 'M15 21V10', 'M19 21V10', 'M2 10l10-7 10 7'],
  ingot: ['M4 8h16l-2 12H6z', 'M6 4h12l2 4H4z'],
  barrel: ['M5 3h14v18H5z', 'M5 8h14', 'M5 16h14', 'M5 3c0 2 2 2 2 2h10s2 0 2-2'],
  stars: ['M3 21V3', 'M3 13l4-4 4 3 6-7 4 4', 'M3 21h18'],
  layers: ['M12 2l10 6-10 6L2 8z', 'M2 14l10 6 10-6', 'M2 11l10 6 10-6'],
  bolt: ['M13 2L3 14h7l-1 8 10-12h-7z'],
  bot: ['M9 8h6', 'M12 2v4', 'M5 12h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z', 'M9 16h0', 'M15 16h0'],
  doller: ['M12 1v22', 'M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6'],
  diamond: ['M6 3h12l4 6-10 12L2 9z', 'M2 9h20', 'M12 3l4 6-4 12-4-12z'],
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  headset: [
    'M3 14v-2a9 9 0 0 1 18 0v2',
    'M21 14v3a2 2 0 0 1-2 2h-1v-7h1a2 2 0 0 1 2 2z',
    'M3 14v3a2 2 0 0 0 2 2h1v-7H5a2 2 0 0 0-2 2z',
  ],
  close: ['M18 6L6 18', 'M6 6l12 12'],
  check: ['M20 6L9 17l-5-5'],
  caret: ['M6 9l6 6 6-6'],
  // The row's "Modify" pencil (Explore.jsx:1297).
  pencil: ['M12 20h9', 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z'],
} as const;

export type ExploreGlyphName = keyof typeof PATHS;

export function ExploreGlyph({
  name,
  size = 18,
  color,
  strokeWidth = 1.8,
}: {
  name: ExploreGlyphName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}): React.JSX.Element {
  const t = useTheme();
  const stroke = color ?? t.colors.textSecondary;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {PATHS[name].map((d) => (
        <Path key={d} d={d} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </Svg>
  );
}
