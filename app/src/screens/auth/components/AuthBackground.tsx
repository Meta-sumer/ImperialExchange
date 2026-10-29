import { useIsFocused } from '@react-navigation/native';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Defs, G, Line, LinearGradient, Polyline, RadialGradient, Rect, Stop } from 'react-native-svg';

import { useTheme } from '@/theme';

import {
  CANDLE_COUNT,
  GRID,
  SCROLL_PX_PER_MS,
  advanceCandles,
  candleWidth,
  chartGeometry,
  gridLinesX,
  seedCandles,
  shiftsAt,
  type Candle,
} from '../logic/candles';

/**
 * AuthShell.jsx AuthBackground — the live "trading" backdrop behind the
 * auth card: a gradient, a faint grid, a scrolling candlestick chart with a
 * glowing close line, then a tinted overlay and a vignette, all following the
 * theme.
 *
 * ── HOW IT MOVES ──────────────────────────────────────────────────────
 * The web repaints a canvas every frame. Here the chart is one SVG layer
 * translated on the NATIVE driver, continuously, never reset. React only
 * re-renders when a whole candle has scrolled off: it drops that candle and
 * moves the layer's origin right by one candle width in the same commit, so
 * the two cancel and nothing jumps however late the re-render lands.
 *
 * It stops when the screen is not focused (another auth screen is on top)
 * and never starts under "Reduce motion" — the web's prefers-reduced-motion.
 *
 * The web also layers an optional `/trading-bg.mp4` over the canvas; that
 * file is not shipped (client/public has none), so on the web the canvas is
 * what everyone sees, and it is what is drawn here.
 * ──────────────────────────────────────────────────────────────────────
 */

interface Stroke { color: string; opacity: number }

interface Palette {
  g0: string;
  g1: string;
  grid: Stroke;
  up: Stroke;
  down: Stroke;
  line: Stroke;
  overlay: { color: string; opacity: number; offset: number }[];
  vignette: Stroke;
}

// AuthShell.jsx `pal`, `overlay` and `vignette`, with each rgba() split into
// colour + opacity (react-native-svg takes opacity separately).
const DARK: Palette = {
  g0: '#0B1220',
  g1: '#0F1B33',
  grid: { color: '#94A3B8', opacity: 0.06 },
  up: { color: '#00C853', opacity: 0.5 },
  down: { color: '#FF3B57', opacity: 0.5 },
  line: { color: '#3B82F6', opacity: 0.9 },
  overlay: [
    { color: '#0B1220', opacity: 0.84, offset: 0 },
    { color: '#0F172A', opacity: 0.7, offset: 0.45 },
    { color: '#1D4ED8', opacity: 0.5, offset: 1 },
  ],
  vignette: { color: '#020617', opacity: 0.5 },
};

const LIGHT: Palette = {
  g0: '#EAF1FF',
  g1: '#F6F9FF',
  grid: { color: '#1D4ED8', opacity: 0.06 },
  up: { color: '#00C853', opacity: 0.45 },
  down: { color: '#FF3B57', opacity: 0.4 },
  line: { color: '#1D4ED8', opacity: 0.75 },
  overlay: [
    { color: '#FFFFFF', opacity: 0.6, offset: 0 },
    { color: '#DBEAFE', opacity: 0.45, offset: 0.55 },
    { color: '#BFDBFE', opacity: 0.4, offset: 1 },
  ],
  vignette: { color: '#94A3B8', opacity: 0.18 },
};

/** Candles drawn past the right edge, for a re-render that lands late. */
const SLACK = 6;
/** One native animation segment; the next continues from where it ended. */
const SEGMENT_MS = 10 * 60 * 1000;

export function AuthBackground(): React.JSX.Element {
  const t = useTheme();
  const pal = t.isDark ? DARK : LIGHT;
  const focused = useIsFocused();

  const [size, setSize] = useState({ w: 0, h: 0 });
  const [reduced, setReduced] = useState(false);
  const [chart, setChart] = useState<{ candles: Candle[]; shifts: number }>(() => ({
    candles: seedCandles(CANDLE_COUNT),
    shifts: 0,
  }));
  const [segment, setSegment] = useState(0);

  const tx = useRef(new Animated.Value(0)).current;
  /** Where the layer is, as of the last time the animation was stopped. */
  const position = useRef(0);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (alive) setReduced(v); })
      .catch(() => { /* assume motion is fine */ });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { alive = false; sub.remove(); };
  }, []);

  // A new width is a new candle width: start the chart over.
  useEffect(() => {
    position.current = 0;
    tx.setValue(0);
    setChart({ candles: seedCandles(CANDLE_COUNT), shifts: 0 });
  }, [size.w, tx]);

  useEffect(() => {
    if (!size.w || !size.h || reduced || !focused) return undefined;
    const cw = candleWidth(size.w);
    const from = position.current;
    const startedAt = Date.now();
    const at = (): number => from - SCROLL_PX_PER_MS * (Date.now() - startedAt);

    const anim = Animated.timing(tx, {
      toValue: from - SCROLL_PX_PER_MS * SEGMENT_MS,
      duration: SEGMENT_MS,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    anim.start(({ finished }) => {
      if (!finished) return;
      position.current = from - SCROLL_PX_PER_MS * SEGMENT_MS;
      setSegment((s) => s + 1);
    });

    const tick = (): void => {
      const want = shiftsAt(at(), cw);
      setChart((c) => (want > c.shifts
        ? { candles: advanceCandles(c.candles, Math.min(want - c.shifts, CANDLE_COUNT)), shifts: want }
        : c));
    };
    const timer = setInterval(tick, Math.max(50, cw / SCROLL_PX_PER_MS));

    return () => {
      clearInterval(timer);
      // Stopping a native animation reports its value asynchronously; the
      // position is a function of time, so take it from the clock instead
      // and pin the value there, ready for the next start.
      const now = at();
      anim.stop();
      position.current = now;
      tx.setValue(now);
    };
  }, [size.w, size.h, reduced, focused, segment, tx]);

  const onLayout = (e: LayoutChangeEvent): void => {
    const { width, height } = e.nativeEvent.layout;
    const w = Math.round(width);
    const h = Math.round(height);
    setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
  };

  const cw = candleWidth(size.w || 1);
  const layerWidth = size.w + (SLACK + 2) * cw + GRID;
  const geo = useMemo(
    () => chartGeometry(chart.candles, size.w, size.h, SLACK),
    [chart.candles, size.w, size.h],
  );
  const origin = chart.shifts * cw;
  const vLines = useMemo(() => gridLinesX(origin, layerWidth), [origin, layerWidth]);
  const hLines = useMemo(() => {
    const ys: number[] = [];
    for (let y = 0; y < size.h; y += GRID) ys.push(y);
    return ys;
  }, [size.h]);

  // CSS `radial-gradient(circle at 50% 35%, …)` reaches the farthest corner.
  const vr = Math.hypot(size.w / 2, size.h * 0.65);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={onLayout}>
      {size.w > 0 && size.h > 0 ? (
        <>
          <Svg width={size.w} height={size.h} style={StyleSheet.absoluteFill}>
            <Defs>
              <LinearGradient id="authBg" x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0" stopColor={pal.g0} />
                <Stop offset="1" stopColor={pal.g1} />
              </LinearGradient>
            </Defs>
            <Rect x={0} y={0} width={size.w} height={size.h} fill="url(#authBg)" />
            <G stroke={pal.grid.color} strokeOpacity={pal.grid.opacity} strokeWidth={1}>
              {hLines.map((y) => <Line key={y} x1={0} y1={y} x2={size.w} y2={y} />)}
            </G>
          </Svg>

          <Animated.View
            style={{
              position: 'absolute',
              top: 0,
              left: origin,
              width: layerWidth,
              height: size.h,
              transform: [{ translateX: tx }],
            }}
          >
            <Svg width={layerWidth} height={size.h}>
              <G stroke={pal.grid.color} strokeOpacity={pal.grid.opacity} strokeWidth={1}>
                {vLines.map((x) => <Line key={x} x1={x} y1={0} x2={x} y2={size.h} />)}
              </G>
              {geo.shapes.map((c, i) => {
                const s = c.up ? pal.up : pal.down;
                // Keyed by slot, not by candle: a shift re-uses every node.
                return (
                  <G key={i}>
                    <Line
                      x1={c.x}
                      y1={c.wickTop}
                      x2={c.x}
                      y2={c.wickBottom}
                      stroke={s.color}
                      strokeOpacity={s.opacity}
                      strokeWidth={1.3}
                    />
                    <Rect
                      x={c.x - geo.cw * 0.3}
                      y={c.bodyTop}
                      width={geo.cw * 0.6}
                      height={c.bodyHeight}
                      fill={s.color}
                      fillOpacity={s.opacity}
                    />
                  </G>
                );
              })}
              {geo.closeLine ? (
                <>
                  {/* The canvas's shadowBlur glow, as a wide faint stroke underneath. */}
                  <Polyline
                    points={geo.closeLine}
                    fill="none"
                    stroke={pal.line.color}
                    strokeOpacity={pal.line.opacity * 0.25}
                    strokeWidth={7}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  <Polyline
                    points={geo.closeLine}
                    fill="none"
                    stroke={pal.line.color}
                    strokeOpacity={pal.line.opacity}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </>
              ) : null}
            </Svg>
          </Animated.View>

          <Svg width={size.w} height={size.h} style={StyleSheet.absoluteFill}>
            <Defs>
              <LinearGradient id="authOverlay" x1="0" y1="0" x2="1" y2="1">
                {pal.overlay.map((s) => (
                  <Stop key={s.offset} offset={String(s.offset)} stopColor={s.color} stopOpacity={s.opacity} />
                ))}
              </LinearGradient>
              <RadialGradient
                id="authVignette"
                cx={size.w / 2}
                cy={size.h * 0.35}
                r={vr}
                fx={size.w / 2}
                fy={size.h * 0.35}
                gradientUnits="userSpaceOnUse"
              >
                <Stop offset="0" stopColor={pal.vignette.color} stopOpacity={0} />
                <Stop offset="1" stopColor={pal.vignette.color} stopOpacity={pal.vignette.opacity} />
              </RadialGradient>
            </Defs>
            <Rect x={0} y={0} width={size.w} height={size.h} fill="url(#authOverlay)" />
            <Rect x={0} y={0} width={size.w} height={size.h} fill="url(#authVignette)" />
          </Svg>
        </>
      ) : null}
    </View>
  );
}
