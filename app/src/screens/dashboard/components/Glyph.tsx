import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

/**
 * The inline stroke icons Dashboard.jsx draws for itself (its `Svg`,
 * `ShieldIcon`, `CheckIcon`, `WalletIcon`, `ChartIcon`, `InfoIcon` and the
 * hero tiles' glyphs), with the web's exact paths. The kit's Icon set is the
 * chrome's; these belong to this page only.
 */
type Shape =
  | { p: string }
  | { c: [number, number, number] }
  | { r: [number, number, number, number, number] };

const GLYPHS = {
  chart: [{ p: 'M3 3v18h18' }, { p: 'M7 14l4-4 4 4 5-7' }],
  trendUp: [{ p: 'M3 17l6-6 4 4 8-8' }, { p: 'M14 7h7v7' }],
  dollar: [{ p: 'M12 2v20' }, { p: 'M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6' }],
  card: [{ r: [2, 6, 20, 14, 2] }, { p: 'M2 10h20' }],
  shield: [{ p: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }],
  check: [{ p: 'M20 6 9 17 4 12' }],
  wallet: [{ p: 'M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1' }, { p: 'M16 12h4' }],
  arrowRight: [{ p: 'M5 12h14' }, { p: 'M13 6l6 6-6 6' }],
  caretUp: [{ p: 'M6 15l6-6 6 6' }],
  caretDown: [{ p: 'M6 9l6 6 6-6' }],
  info: [{ c: [12, 12, 10] }, { p: 'M12 16v-4' }, { p: 'M12 8h.01' }],
  alert: [{ c: [12, 12, 10] }, { p: 'M12 8v4' }, { p: 'M12 16h.01' }],
} satisfies Record<string, readonly Shape[]>;

export type GlyphName = keyof typeof GLYPHS;

export function Glyph({
  name,
  size = 14,
  color,
  strokeWidth = 2,
}: {
  name: GlyphName;
  size?: number;
  color: string;
  strokeWidth?: number;
}): React.JSX.Element {
  const shapes: readonly Shape[] = GLYPHS[name];
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {shapes.map((s, i) => {
        if ('p' in s) return <Path key={i} d={s.p} />;
        if ('c' in s) return <Circle key={i} cx={s.c[0]} cy={s.c[1]} r={s.c[2]} />;
        return <Rect key={i} x={s.r[0]} y={s.r[1]} width={s.r[2]} height={s.r[3]} rx={s.r[4]} />;
      })}
    </Svg>
  );
}
