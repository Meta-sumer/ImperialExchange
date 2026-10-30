import React, { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  Line,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
  Text as SvgText,
} from 'react-native-svg';

import { FillSvg } from '@/components/common/FillSvg';
import { AppText } from '@/components/ui';

/**
 * The landing page's artwork — client/src/pages/Landing.jsx: the feature
 * icons and their gradient tiles, the hero chart, the market clusters
 * (NSE / BSE coins, CE / PE coins, gold bars and an oil barrel, the index
 * chart), the security shield, the step and security icons. Paths, colours
 * and gradients are the web's.
 *
 * CSS gradients are drawn as SVG gradients through FillSvg (a stretched
 * absolute layer — see FillSvg for why not `absoluteFill` on the Svg). The
 * web's gradient TEXT (`background-clip: text`) has no React Native
 * equivalent; GradientText colours each letter along the gradient instead,
 * which reads the same on a word or two.
 */

/* ── Motion ──────────────────────────────────────────────────────────── */

/**
 * The OS "reduce motion" setting — Landing.jsx's
 * `@media (prefers-reduced-motion: reduce)` turns its animations off.
 */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = React.useState(false);
  useEffect(() => {
    let on = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((v) => { if (on) setReduce(!!v); })
      .catch(() => { /* animate */ });
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v: boolean) => setReduce(!!v));
    return () => { on = false; sub?.remove?.(); };
  }, []);
  return reduce;
}

/** A looping 0→1→0 driver — the web's float-a / float-b / lnd-dot keyframes. */
export function useLoop(durationMs: number, enabled: boolean): Animated.Value {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!enabled) { v.setValue(0); return undefined; }
    const half = durationMs / 2;
    const anim = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: half, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(v, { toValue: 0, duration: half, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    anim.start();
    return () => anim.stop();
  }, [durationMs, enabled, v]);
  return v;
}

/* ── Gradients ───────────────────────────────────────────────────────── */

export type GradientStop = readonly [offset: number, color: string];

/**
 * A gradient behind anything — the web's `linear-gradient(…)`. Two colours
 * (`from` / `to`) or `stops`; diagonal (135deg) unless `horizontal` (90deg).
 */
export function Gradient({
  from,
  to,
  stops,
  id,
  horizontal = false,
  style,
}: {
  from?: string;
  to?: string;
  stops?: ReadonlyArray<GradientStop>;
  id: string;
  horizontal?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const list: ReadonlyArray<GradientStop> = stops ?? [[0, from ?? '#000000'], [1, to ?? from ?? '#000000']];
  return (
    <FillSvg style={style} preserveAspectRatio="none" viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="1" y2={horizontal ? '0' : '1'}>
          {list.map(([o, c]) => <Stop key={`${o}-${c}`} offset={o} stopColor={c} />)}
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100" height="100" fill={`url(#${id})`} />
    </FillSvg>
  );
}

/**
 * A soft radial glow — `radial-gradient(circle, <color>, transparent 70%)`
 * at `opacity`, filling its box (the caller sizes and places it).
 */
export function Glow({
  color,
  opacity = 1,
  id,
  cx = '50%',
  cy = '50%',
  fade = 0.7,
  style,
}: {
  color: string;
  opacity?: number;
  id: string;
  cx?: string;
  cy?: string;
  /** Where the colour has faded out, 0–1 of the radius. */
  fade?: number;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  return (
    <FillSvg style={style}>
      <Defs>
        <RadialGradient id={id} cx={cx} cy={cy} r="50%">
          <Stop offset="0" stopColor={color} stopOpacity={opacity} />
          <Stop offset={fade} stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
    </FillSvg>
  );
}

/** The tiles' top-left highlight — `radial-gradient(120% 80% at 30% 12%, rgba(255,255,255,.45), transparent 60%)`. */
export function Shine({ id, strength = 0.45 }: { id: string; strength?: number }): React.JSX.Element {
  return (
    <FillSvg>
      <Defs>
        <RadialGradient id={id} cx="30%" cy="12%" rx="120%" ry="80%" fx="30%" fy="12%">
          <Stop offset="0" stopColor="#FFFFFF" stopOpacity={strength} />
          <Stop offset="0.6" stopColor="#FFFFFF" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
    </FillSvg>
  );
}

const hexRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** The colour `t` (0–1) of the way from `a` to `b`. */
export const mixHex = (a: string, b: string, t: number): string => {
  const [r1, g1, b1] = hexRgb(a);
  const [r2, g2, b2] = hexRgb(b);
  const c = (x: number, y: number): string => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
};

/**
 * Landing.jsx's gradient words (`linear-gradient(90deg, from, to)` clipped
 * to the text): each letter takes its place along the gradient. Nested in a
 * parent text, it inherits the parent's size and weight.
 */
export function GradientText({ text, from, to }: { text: string; from: string; to: string }): React.JSX.Element {
  const chars = Array.from(text);
  const last = Math.max(1, chars.length - 1);
  return (
    <Text accessibilityLabel={text}>
      {chars.map((ch, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <Text key={i} style={{ color: mixHex(from, to, i / last) }}>{ch}</Text>
      ))}
    </Text>
  );
}

/** Landing.jsx `grad` — the headline blue. */
export const BLUE_GRAD: readonly [string, string] = ['#1D4ED8', '#3B82F6'];

/* ── Feature tiles ───────────────────────────────────────────────────── */

/** Landing.jsx FEAT_GRAD — per-feature tile gradients (135deg). */
export const FEAT_GRAD: Readonly<Record<string, readonly [string, string]>> = {
  bolt: ['#FBBF24', '#F97316'],
  chart: ['#38BDF8', '#3B82F6'],
  copy: ['#A78BFA', '#6366F1'],
  shield: ['#34D399', '#059669'],
  coins: ['#FB7185', '#EC4899'],
  support: ['#22D3EE', '#0EA5E9'],
  globe: ['#60A5FA', '#2563EB'],
  lock: ['#34D399', '#10B981'],
  rupee: ['#FBBF24', '#F59E0B'],
  clock: ['#22D3EE', '#3B82F6'],
  grid: ['#A78BFA', '#8B5CF6'],
  deposit: ['#34D399', '#059669'],
  risk: ['#FB7185', '#F43F5E'],
  phone: ['#818CF8', '#6366F1'],
  _default: ['#60A5FA', '#3B82F6'],
};

/** Landing.jsx FEAT_SH — each tile's matching soft shadow. */
export const FEAT_SH: Readonly<Record<string, string>> = {
  bolt: 'rgba(249,115,22,0.40)',
  chart: 'rgba(59,130,246,0.40)',
  copy: 'rgba(99,102,241,0.40)',
  shield: 'rgba(16,185,129,0.40)',
  coins: 'rgba(236,72,153,0.40)',
  support: 'rgba(14,165,233,0.40)',
  risk: 'rgba(244,63,94,0.40)',
  phone: 'rgba(99,102,241,0.40)',
};

/**
 * A rounded gradient tile holding a white icon, with the web's coloured
 * shadow (`0 8px 18px <shadow>`, or `0 10px 22px` on the larger tiles) and,
 * when `shine`, the top-left highlight.
 */
export function GradTile({
  icon,
  size = 48,
  radius = 12,
  colors,
  shadow,
  shine = false,
  iconSize = 24,
  id,
  children,
}: {
  icon?: string;
  size?: number;
  radius?: number;
  colors?: ReadonlyArray<GradientStop> | readonly [string, string];
  shadow?: string;
  shine?: boolean;
  iconSize?: number;
  id: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const pair = (icon ? FEAT_GRAD[icon] : undefined) ?? FEAT_GRAD._default ?? ['#60A5FA', '#3B82F6'];
  const stops: ReadonlyArray<GradientStop> = colors
    ? (typeof colors[0] === 'string'
      ? [[0, (colors as readonly [string, string])[0]], [1, (colors as readonly [string, string])[1]]]
      : (colors as ReadonlyArray<GradientStop>))
    : [[0, pair[0]], [1, pair[1]]];
  const sh = shadow ?? (icon ? FEAT_SH[icon] : undefined) ?? 'rgba(59,130,246,0.35)';
  const big = size >= 56;
  return (
    <View style={[styles.tileWrap, { width: size, height: size, borderRadius: radius, backgroundColor: stops[0]?.[1], boxShadow: `0 ${big ? 10 : 8}px ${big ? 22 : 18}px ${sh}` }]}>
      <View style={[styles.tile, { width: size, height: size, borderRadius: radius }]}>
        <Gradient stops={stops} id={`g-${id}`} />
        {shine ? <Shine id={`s-${id}`} /> : null}
        {children ?? (icon ? <FeatureIcon name={icon} color="#FFFFFF" size={iconSize} /> : null)}
      </View>
    </View>
  );
}

/* ── Icons ───────────────────────────────────────────────────────────── */

const strokeOf = (color: string, strokeWidth = 1.8) =>
  ({ stroke: color, strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' });

/**
 * Landing.jsx FeatureIcon (24 × 24, stroke 1.8) — plus the StepIcon,
 * SecIcon and the market rail's chevrons, which share its grid.
 */
export function FeatureIcon({ name, color, size = 24, strokeWidth }: { name: string; color: string; size?: number; strokeWidth?: number }): React.JSX.Element {
  const s = strokeOf(color, strokeWidth);
  const body = ((): React.ReactNode => {
    switch (name) {
      case 'bolt': return <Path d="M13 2L3 14h8l-1 8 10-12h-8z" {...s} />;
      case 'chart': return <><Path d="M3 3v18h18" {...s} /><Path d="M7 15l4-4 4 4 6-7" {...s} /></>;
      case 'copy': return <><Rect x="9" y="9" width="11" height="11" rx="2" {...s} /><Path d="M5 15V5a2 2 0 0 1 2-2h10" {...s} /></>;
      case 'shield': return <><Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" {...s} /><Path d="M9 12l2 2 4-4" {...s} /></>;
      case 'coins': return <><Ellipse cx="12" cy="6" rx="8" ry="3" {...s} /><Path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" {...s} /><Path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" {...s} /></>;
      case 'support': return <><Circle cx="12" cy="12" r="9" {...s} /><Path d="M5 19l2-3M19 19l-2-3" {...s} /><Path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5" {...s} /><Line x1="12" y1="16" x2="12.01" y2="16" {...s} /></>;
      case 'clock': return <><Circle cx="12" cy="12" r="9" {...s} /><Path d="M12 7v5l3.5 2" {...s} /></>;
      case 'gift': return <><Path d="M20 12v9H4v-9" {...s} /><Rect x="2" y="7" width="20" height="5" rx="1" {...s} /><Path d="M12 22V7" {...s} /><Path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" {...s} /><Path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" {...s} /></>;
      case 'globe': return <><Circle cx="12" cy="12" r="9" {...s} /><Path d="M3 12h18" {...s} /><Path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z" {...s} /></>;
      case 'lock': return <><Rect x="4" y="11" width="16" height="9" rx="2" {...s} /><Path d="M8 11V7a4 4 0 0 1 8 0v4" {...s} /></>;
      case 'rupee':
      case 'dollar': return <SvgText x="6" y="18" fontSize="17" fontWeight="800" fill={color}>₹</SvgText>;
      case 'grid': return <><Rect x="3" y="3" width="7" height="7" rx="1.5" {...s} /><Rect x="14" y="3" width="7" height="7" rx="1.5" {...s} /><Rect x="3" y="14" width="7" height="7" rx="1.5" {...s} /><Rect x="14" y="14" width="7" height="7" rx="1.5" {...s} /></>;
      case 'deposit': return <><Path d="M12 3v11" {...s} /><Path d="M8 10l4 4 4-4" {...s} /><Rect x="3" y="17" width="18" height="4" rx="1" {...s} /></>;
      case 'risk': return <><Path d="M12 3l9 16H3z" {...s} /><Path d="M12 10v4" {...s} /><Line x1="12" y1="17" x2="12.01" y2="17" {...s} /></>;
      case 'phone': return <><Rect x="6" y="2" width="12" height="20" rx="2.5" {...s} /><Line x1="10" y1="18" x2="14" y2="18" {...s} /></>;
      case 'percent': return <><Line x1="19" y1="5" x2="5" y2="19" {...s} /><Circle cx="6.5" cy="6.5" r="2.5" {...s} /><Circle cx="17.5" cy="17.5" r="2.5" {...s} /></>;
      // StepIcon
      case 'user': return <><Circle cx="12" cy="8" r="4" {...s} /><Path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" {...s} /></>;
      case 'verify': return <><Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" {...s} /><Path d="M9 12l2 2 4-4" {...s} /></>;
      case 'wallet': return <><Rect x="3" y="6" width="18" height="13" rx="2.5" {...s} /><Path d="M3 10.5h18" {...s} /><Circle cx="16.5" cy="14.5" r="1.3" fill={color} /></>;
      case 'trend': return <><Path d="M3 17l6-6 4 4 8-8" {...s} /><Path d="M17 7h4v4" {...s} /></>;
      // SecIcon
      case 'card': return <><Rect x="2" y="5" width="20" height="14" rx="2" {...s} /><Path d="M2 10h20" {...s} /><Path d="M6 15h4" {...s} /></>;
      case 'secShield': return <><Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" {...s} /><Path d="M9.5 12l2 2 3.5-3.5" {...s} /></>;
      case 'audit': return <><Rect x="5" y="3" width="14" height="18" rx="2" {...s} /><Path d="M9 8h6M9 12h4" {...s} /><Path d="M14.5 16.5l1.4 1.4 2.6-3" {...s} /></>;
      // The market rail's prev / next, and the step connector.
      case 'chevronLeft': return <Path d="M15 6l-6 6 6 6" {...s} />;
      case 'chevronRight': return <Path d="M9 6l6 6-6 6" {...s} />;
      default: return <Circle cx="12" cy="12" r="9" {...s} />;
    }
  })();
  return <Svg width={size} height={size} viewBox="0 0 24 24">{body}</Svg>;
}

/** The testimonials pill's heart. */
export function Heart({ color, size = 13 }: { color: string; size?: number }): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        fill={color}
        d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
      />
    </Svg>
  );
}

/* ── The hero chart ──────────────────────────────────────────────────── */

const AnimatedPath = Animated.createAnimatedComponent(Path);

const LINE = 'M0,150 L30,140 L60,148 L90,120 L120,128 L150,96 L180,104 L210,72 L240,80 L270,52 L300,60 L330,34 L360,40';
const CANDLES: ReadonlyArray<readonly [number, number, number, number]> = [
  [40, 70, 35, 75], [60, 85, 55, 90], [50, 78, 45, 80], [72, 96, 66, 100], [60, 80, 58, 84],
  [78, 104, 70, 110], [92, 120, 86, 124], [80, 108, 74, 112], [100, 132, 94, 138], [120, 150, 112, 156],
  [108, 138, 102, 144], [128, 160, 120, 168],
];

/**
 * Landing.jsx ChartSVG — the decorative price chart: the area, the line
 * (drawn in over 2.4 s — `lnd-line`), the candles and the pulsing last-price
 * dot (`lnd-dot`). Stretched to its box, as the web's `preserveAspectRatio="none"`.
 */
export function HeroChart({ height = 160, id = 'hero' }: { height?: number; id?: string }): React.JSX.Element {
  const reduce = useReduceMotion();
  const draw = useRef(new Animated.Value(reduce ? 0 : 900)).current;
  const pulse = useLoop(1600, !reduce);
  useEffect(() => {
    if (reduce) { draw.setValue(0); return undefined; }
    const anim = Animated.timing(draw, { toValue: 0, duration: 2400, easing: Easing.out(Easing.cubic), useNativeDriver: false });
    anim.start();
    return () => anim.stop();
  }, [draw, reduce]);
  const dotOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.3] });
  return (
    <View style={{ height }}>
      <Svg width="100%" height={height} viewBox="0 0 360 180" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={`lndFill-${id}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#1D4ED8" stopOpacity="0.22" />
            <Stop offset="1" stopColor="#1D4ED8" stopOpacity="0" />
          </LinearGradient>
        </Defs>
        <Path d={`${LINE} L360,180 L0,180 Z`} fill={`url(#lndFill-${id})`} />
        <AnimatedPath
          d={LINE}
          fill="none"
          stroke="#1D4ED8"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="900"
          strokeDashoffset={draw}
        />
        {CANDLES.map((c, i) => {
          const x = 14 + i * 29;
          const col = i % 3 !== 1 ? '#00C853' : '#FF3B57';
          const a = 180 - c[1];
          const b = 180 - c[0];
          return (
            // eslint-disable-next-line react/no-array-index-key
            <G key={i} opacity={0.85}>
              <Line x1={x} y1={180 - c[3]} x2={x} y2={180 - c[2]} stroke={col} strokeWidth="1.4" />
              <Rect x={x - 4} y={Math.min(a, b)} width="8" height={Math.max(4, Math.abs(b - a))} rx="1.5" fill={col} />
            </G>
          );
        })}
      </Svg>
      {/* The pulsing dot at (330, 34) of 360 × 180 — a view, so it stays round when the chart stretches. */}
      <Animated.View
        pointerEvents="none"
        style={[styles.dot, { left: `${(330 / 360) * 100}%`, top: `${(34 / 180) * 100}%`, opacity: dotOpacity }]}
      />
    </View>
  );
}

/* ── Market clusters ─────────────────────────────────────────────────── */

/**
 * Landing.jsx Coin — a minted-coin token: radial gradient disc, white rim,
 * inner ring, top shine, and its label.
 */
function Coin({ from, to, label, fontSize, id }: { from: string; to: string; label: string; fontSize: number; id: string }): React.JSX.Element {
  return (
    <View style={[styles.coin, { backgroundColor: to }]}>
      <Svg width={48} height={48} viewBox="0 0 48 48" style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id={`c-${id}`} cx="32%" cy="22%" r="100%" fx="32%" fy="22%">
            <Stop offset="0" stopColor={from} />
            <Stop offset="0.82" stopColor={to} />
          </RadialGradient>
          <RadialGradient id={`cs-${id}`} cx="32%" cy="22%" rx="58%" ry="42%" fx="32%" fy="22%">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.55} />
            <Stop offset="0.72" stopColor="#FFFFFF" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx="24" cy="24" r="23" fill={`url(#c-${id})`} stroke="#FFFFFF" strokeWidth="2" />
        <Circle cx="24" cy="24" r="19.5" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1.5" />
        <Circle cx="24" cy="24" r="22" fill={`url(#cs-${id})`} />
      </Svg>
      <AppText style={[styles.coinLabel, { fontSize, lineHeight: fontSize + 2 }]} color="#FFFFFF">{label}</AppText>
    </View>
  );
}

function GoldBars(): React.JSX.Element {
  return (
    <Svg width={40} height={32} viewBox="0 0 40 32">
      <Defs>
        <LinearGradient id="ldgoldF" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#FCD34D" /><Stop offset="1" stopColor="#C2740A" /></LinearGradient>
      </Defs>
      <G stroke="#92400E" strokeWidth="0.6" strokeLinejoin="round">
        <Path d="M3 30h13l-1.4-6H4.4z" fill="url(#ldgoldF)" />
        <Path d="M4.4 24h11.2l2.2-2.6H6.6z" fill="#FDE68A" />
        <Path d="M21 30h13l-1.4-6H22.4z" fill="url(#ldgoldF)" />
        <Path d="M22.4 24h11.2l2.2-2.6H24.6z" fill="#FDE68A" />
        <Path d="M12 22h13l-1.4-6H13.4z" fill="url(#ldgoldF)" />
        <Path d="M13.4 16h11.2l2.2-2.6H15.6z" fill="#FEF3C7" />
      </G>
    </Svg>
  );
}

function OilBarrel(): React.JSX.Element {
  return (
    <Svg width={26} height={32} viewBox="0 0 26 32">
      <Defs>
        <LinearGradient id="ldbarrel" x1="0" y1="0" x2="1" y2="0"><Stop offset="0" stopColor="#1E293B" /><Stop offset="0.5" stopColor="#0B1220" /><Stop offset="1" stopColor="#020617" /></LinearGradient>
      </Defs>
      <Rect x="4" y="4" width="18" height="24" rx="3.4" fill="url(#ldbarrel)" />
      <Ellipse cx="13" cy="4.6" rx="9" ry="2.6" fill="#334155" />
      <Path d="M8.5 4.6v23" stroke="rgba(255,255,255,0.16)" strokeWidth="2" strokeLinecap="round" />
      <Rect x="4" y="10.4" width="18" height="1.9" rx="0.6" fill="#F59E0B" opacity={0.9} />
      <Rect x="4" y="19.4" width="18" height="1.9" rx="0.6" fill="#F59E0B" opacity={0.9} />
      <Path d="M13 13.4c1.8 2 2.9 3.5 2.9 4.9a2.9 2.9 0 0 1-5.8 0c0-1.4 1.1-2.9 2.9-4.9z" fill="#FBBF24" />
    </Svg>
  );
}

function IndexChart(): React.JSX.Element {
  return (
    <Svg width={46} height={32} viewBox="0 0 46 32">
      <Defs>
        <LinearGradient id="ldbarG" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#4ADE80" /><Stop offset="1" stopColor="#15803D" /></LinearGradient>
        <LinearGradient id="ldbarB" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#60A5FA" /><Stop offset="1" stopColor="#1D4ED8" /></LinearGradient>
        <LinearGradient id="ldbarV" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#C084FC" /><Stop offset="1" stopColor="#7C3AED" /></LinearGradient>
      </Defs>
      <Rect x="3" y="18" width="5.5" height="11" rx="1.4" fill="url(#ldbarG)" />
      <Rect x="11.5" y="12" width="5.5" height="17" rx="1.4" fill="url(#ldbarB)" />
      <Rect x="20" y="15" width="5.5" height="14" rx="1.4" fill="url(#ldbarV)" />
      <Rect x="28.5" y="8" width="5.5" height="21" rx="1.4" fill="url(#ldbarB)" />
      <Rect x="37" y="13" width="5.5" height="16" rx="1.4" fill="url(#ldbarG)" />
      <Path d="M5.7 16 L14.2 10 L22.7 13.5 L31.2 6.5 L39.7 11" fill="none" stroke="#64748B" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M37.6 9.2 L40.3 10.3 L38.7 12.6 Z" fill="#64748B" />
    </Svg>
  );
}

/** Landing.jsx MarketCluster — the art above each market card. */
export function MarketCluster({ name }: { name: string }): React.JSX.Element {
  switch (name) {
    case 'Stocks':
      return (
        <View style={styles.overlap}>
          <Coin from="#60A5FA" to="#1D4ED8" label="NSE" fontSize={11} id="nse" />
          <View style={styles.neg12}><Coin from="#FB7185" to="#E11D48" label="BSE" fontSize={11} id="bse" /></View>
        </View>
      );
    case 'Large Caps':
      return (
        <View style={styles.overlap}>
          <Coin from="#34D399" to="#059669" label="₹" fontSize={14} id="lc1" />
          <View style={styles.neg12}><Coin from="#60A5FA" to="#2563EB" label="50" fontSize={12} id="lc2" /></View>
        </View>
      );
    case 'Banking':
      return (
        <View style={styles.overlap}>
          <Coin from="#60A5FA" to="#1E40AF" label="HDFC" fontSize={9} id="bk1" />
          <View style={styles.neg12}><Coin from="#FDBA74" to="#EA580C" label="ICICI" fontSize={9} id="bk2" /></View>
        </View>
      );
    case 'IT & Tech':
      return (
        <View style={styles.overlap}>
          <Coin from="#94A3B8" to="#111827" label="TCS" fontSize={10} id="it1" />
          <View style={styles.neg12}><Coin from="#7DD3FC" to="#0284C7" label="INFY" fontSize={9} id="it2" /></View>
        </View>
      );
    case 'Commodities':
      return (
        <View style={[styles.overlap, styles.gap6]}>
          <GoldBars />
          <OilBarrel />
        </View>
      );
    case 'Indices':
    default:
      return <IndexChart />;
  }
}

/* ── Security ────────────────────────────────────────────────────────── */

/** Landing.jsx ShieldHero — the glowing shield with its padlock. */
export function ShieldArt(): React.JSX.Element {
  return (
    <View style={styles.shieldWrap}>
      <Glow color="#3B82F6" opacity={0.5} id="shieldGlow" cy="58%" fade={0.65} />
      <View>
        <Svg width={96} height={104} viewBox="0 0 96 104">
          <Defs>
            <LinearGradient id="ldShield" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#60A5FA" /><Stop offset="0.5" stopColor="#3B82F6" /><Stop offset="1" stopColor="#1E3A8A" /></LinearGradient>
            <LinearGradient id="ldShieldEdge" x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor="#BFDBFE" /><Stop offset="1" stopColor="#2563EB" /></LinearGradient>
            <RadialGradient id="ldShieldShine" cx="50%" cy="30%" r="60%"><Stop offset="0" stopColor="#BFDBFE" stopOpacity={0.85} /><Stop offset="1" stopColor="#BFDBFE" stopOpacity={0} /></RadialGradient>
          </Defs>
          <Path d="M48 4 L86 18 V52 C86 78 68 92 48 100 C28 92 10 78 10 52 V18 Z" fill="url(#ldShieldEdge)" />
          <Path d="M48 11 L79 22 V52 C79 74 64 86 48 93 C32 86 17 74 17 52 V22 Z" fill="url(#ldShield)" />
          <Path d="M48 11 L79 22 V41 C70 31 58 27 48 27 Z" fill="url(#ldShieldShine)" opacity={0.55} />
          <Rect x="38" y="50" width="20" height="16" rx="3" fill="#EAF2FF" />
          <Path d="M41 50 v-4 a7 7 0 0 1 14 0 v4" fill="none" stroke="#EAF2FF" strokeWidth="3.4" />
          <Circle cx="48" cy="57" r="2.6" fill="#1E3A8A" />
          <Rect x="47" y="58.5" width="2" height="4.5" rx="1" fill="#1E3A8A" />
        </Svg>
      </View>
    </View>
  );
}

/** Five gold stars. */
export function Stars({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <View style={styles.stars} accessibilityLabel="5 stars">
      {[0, 1, 2, 3, 4].map((i) => (
        <Svg key={i} width={size} height={size} viewBox="0 0 24 24">
          <Path fill="#F59E0B" d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.8 5.9 21.2l1.5-6.8L2.2 9.7l6.9-.7z" />
        </Svg>
      ))}
    </View>
  );
}

/** Landing.jsx Check — the small tick. */
export function CheckDot({ color, size = 13 }: { color: string; size?: number }): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M20 6L9 17l-5-5" stroke={color} strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

/** A line of text that keeps to one line in a mockup. */
export function Mono({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }): React.JSX.Element {
  return <Text numberOfLines={1} style={style}>{children}</Text>;
}

const styles = StyleSheet.create({
  tileWrap: {},
  tile: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  overlap: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center' },
  neg12: { marginLeft: -12 },
  gap6: { gap: 6 },
  coin: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 7px 16px rgba(15,23,42,0.30)',
  },
  coinLabel: { fontWeight: '900', textAlign: 'center' },
  dot: { position: 'absolute', width: 8, height: 8, marginLeft: -4, marginTop: -4, borderRadius: 4, backgroundColor: '#1D4ED8' },
  shieldWrap: { width: 112, height: 112, alignItems: 'center', justifyContent: 'center' },
  stars: { flexDirection: 'row', gap: 2 },
});
