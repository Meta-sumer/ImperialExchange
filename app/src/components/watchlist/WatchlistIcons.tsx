import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

/**
 * The watchlist pages' inline SVGs, verbatim from Watchlist.jsx,
 * WatchlistButton.jsx and AddToWatchlistModal.jsx — the ones the kit's
 * `Icon` set does not carry (bookmark, pin, grip, dots, share, upload, pen,
 * move). Stroke icons take the kit's look: round caps, 24-unit viewBox.
 */

export type WatchGlyph =
  | 'bookmark'
  | 'pin'
  | 'dotsVertical'
  | 'dotsHorizontal'
  | 'grip'
  | 'share'
  | 'upload'
  | 'pen'
  | 'duplicate'
  | 'move'
  | 'trash'
  | 'plus'
  | 'check'
  | 'close'
  | 'search'
  | 'arrowUp'
  | 'arrowDown'
  | 'arrowLeft'
  | 'arrowRight'
  | 'trade';

export interface WatchIconProps {
  name: WatchGlyph;
  size?: number;
  color: string;
  /** Bookmark / pin: the saved / pinned state fills the shape. */
  filled?: boolean;
  strokeWidth?: number;
}

export function WatchIcon({ name, size = 16, color, filled = false, strokeWidth = 2 }: WatchIconProps): React.JSX.Element {
  const stroke = { stroke: color, strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  switch (name) {
    case 'bookmark':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" {...stroke} fill={filled ? color : 'none'} />
        </Svg>
      );
    case 'pin':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M12 17v5" {...stroke} />
          <Path d="M9 10.76V5h6v5.76l3 2.24v3H6v-3z" {...stroke} fill={filled ? color : 'none'} />
        </Svg>
      );
    case 'dotsVertical':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Circle cx={12} cy={5} r={1.6} fill={color} />
          <Circle cx={12} cy={12} r={1.6} fill={color} />
          <Circle cx={12} cy={19} r={1.6} fill={color} />
        </Svg>
      );
    case 'dotsHorizontal':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Circle cx={5} cy={12} r={1.6} fill={color} />
          <Circle cx={12} cy={12} r={1.6} fill={color} />
          <Circle cx={19} cy={12} r={1.6} fill={color} />
        </Svg>
      );
    case 'grip':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          {[6, 12, 18].map((cy) => (
            <React.Fragment key={cy}>
              <Circle cx={9} cy={cy} r={1.5} fill={color} />
              <Circle cx={15} cy={cy} r={1.5} fill={color} />
            </React.Fragment>
          ))}
        </Svg>
      );
    case 'share':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Circle cx={18} cy={5} r={3} {...stroke} />
          <Circle cx={6} cy={12} r={3} {...stroke} />
          <Circle cx={18} cy={19} r={3} {...stroke} />
          <Path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" {...stroke} />
        </Svg>
      );
    case 'upload':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" {...stroke} />
          <Path d="M17 8l-5-5-5 5" {...stroke} />
          <Path d="M12 3v12" {...stroke} />
        </Svg>
      );
    case 'pen':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M12 20h9" {...stroke} />
          <Path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" {...stroke} />
        </Svg>
      );
    case 'duplicate':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Rect x={9} y={9} width={13} height={13} rx={2} {...stroke} />
          <Path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" {...stroke} />
        </Svg>
      );
    case 'move':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M5 12h14" {...stroke} />
          <Path d="M13 6l6 6-6 6" {...stroke} />
        </Svg>
      );
    case 'trash':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M3 6h18" {...stroke} />
          <Path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" {...stroke} />
          <Path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" {...stroke} />
        </Svg>
      );
    case 'plus':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M12 5v14M5 12h14" {...stroke} />
        </Svg>
      );
    case 'check':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M20 6 9 17l-5-5" {...stroke} />
        </Svg>
      );
    case 'close':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M18 6 6 18M6 6l12 12" {...stroke} />
        </Svg>
      );
    case 'search':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Circle cx={11} cy={11} r={8} {...stroke} />
          <Path d="M21 21l-4.35-4.35" {...stroke} />
        </Svg>
      );
    case 'arrowUp':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M12 19V5" {...stroke} />
          <Path d="M5 12l7-7 7 7" {...stroke} />
        </Svg>
      );
    case 'arrowDown':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M12 5v14" {...stroke} />
          <Path d="M19 12l-7 7-7-7" {...stroke} />
        </Svg>
      );
    case 'arrowLeft':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M19 12H5" {...stroke} />
          <Path d="M12 19l-7-7 7-7" {...stroke} />
        </Svg>
      );
    case 'arrowRight':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M5 12h14" {...stroke} />
          <Path d="M12 5l7 7-7 7" {...stroke} />
        </Svg>
      );
    case 'trade':
    default:
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d="M3 17l6-6 4 4 8-8" {...stroke} />
          <Path d="M14 7h7v7" {...stroke} />
        </Svg>
      );
  }
}
