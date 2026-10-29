import React from 'react';
import Svg, { Path } from 'react-native-svg';

import type { ExploreTileIcon } from '@/utils/markets';

/**
 * The inline stroke icons the markets pages draw that the kit's Icon set
 * does not carry: ExploreLinksCard's four segment glyphs (MarketList.jsx
 * ExploreLinksCard — Indices, Stocks, Futures, Commodities). Same paths,
 * same 24-unit viewBox.
 */
const PATHS: Record<ExploreTileIcon, string[]> = {
  indices: ['M3 3v18h18', 'M7 14l4-4 4 4 5-7'],
  stocks: ['M3 21h18', 'M5 21V10', 'M9 21V10', 'M15 21V10', 'M19 21V10', 'M2 10l10-7 10 7'],
  futures: ['M12 2l10 6-10 6L2 8z', 'M2 14l10 6 10-6', 'M2 11l10 6 10-6'],
  commodities: ['M4 8h16l-2 12H6z', 'M6 4h12l2 4H4z'],
};

export type MarketIconName = keyof typeof PATHS;

export function MarketIcon({
  name,
  size = 20,
  color,
  strokeWidth = 2,
}: {
  name: MarketIconName;
  size?: number;
  color: string;
  strokeWidth?: number;
}): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {PATHS[name].map((d) => (
        <Path key={d} d={d} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </Svg>
  );
}
