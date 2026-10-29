import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dimensions,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import Svg, { ClipPath, Defs, G, Line, LinearGradient, Path, Rect, Circle, Stop } from 'react-native-svg';

import { AppText, Checkbox, ErrorView } from '@/components/ui';
import { useTheme } from '@/theme';
import type { Candle } from '@/types/trading';
import { fmtNum } from '@/utils/money';
import {
  STOCK_COLORS,
  candleCloseMs,
  candleRangeLabel,
  chartModel,
  fmtChartDateTime,
  fmtPx,
  indexAtX,
  selectionInfo,
  selectionLabel,
  selectionRangeLabel,
  type ChartMode,
  type ChartModel,
  type ChartSelection,
  type StockCurrency,
} from '@/utils/stockDetail';

/**
 * StockChart — StockDetail.jsx:993-1136: line and candlestick modes, a
 * crosshair with a price / date readout, a selected range showing the return
 * between two points, and an optional volume pane. Drawn with
 * react-native-svg, in pixels at the measured width.
 *
 * Touch in place of the mouse:
 *   • one finger — the hover crosshair, following the finger; lifting it
 *     clears it (the web's mouseleave). Touching also clears a selection,
 *     as the web's click does.
 *   • two fingers — the drag-selected range, between the fingers; it stays
 *     after they lift, until the next touch.
 * A vertical swipe that starts on the chart still scrolls the page.
 */

export const CHART_HEIGHT = 320;

export interface StockChartProps {
  candles: readonly Candle[];
  /** The candles' timeframe — a candle closes one bucket after it opens. */
  timeframe: string;
  mode: ChartMode;
  up: boolean;
  cur: StockCurrency;
  prec: number;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

/** The part that does not move with the finger, so a scrub redraws only the overlay. */
const ChartBody = memo(function ChartBody({
  model,
  candles,
  mode,
  showVol,
  baselineColor,
}: {
  model: ChartModel;
  candles: readonly Candle[];
  mode: ChartMode;
  showVol: boolean;
  baselineColor: string;
}): React.JSX.Element {
  const { x, y, bw, padX, padR, W, H, closes, stroke, vMax, volH } = model;
  const first = closes[0] ?? 0;
  return (
    <G>
      <Line x1={padX} x2={W - padR} y1={y(first)} y2={y(first)} stroke={baselineColor} strokeDasharray="3 5" strokeWidth={1} />
      {mode === 'line' ? (
        <Path d={model.line} fill="none" stroke={stroke} strokeWidth={2} />
      ) : (
        candles.map((c, i) => {
          const col = c.close >= c.open ? STOCK_COLORS.up : STOCK_COLORS.down;
          const top = y(Math.max(c.open, c.close));
          const bot = y(Math.min(c.open, c.close));
          return (
            // eslint-disable-next-line react/no-array-index-key
            <G key={i}>
              <Line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke={col} strokeWidth={1} />
              <Rect x={x(i) - bw / 2} y={top} width={bw} height={Math.max(1, bot - top)} fill={col} />
            </G>
          );
        })
      )}
      {showVol ? candles.map((c, i) => {
        const vh = (Number(c.volume || 0) / vMax) * volH;
        return (
          <Rect
            // eslint-disable-next-line react/no-array-index-key
            key={`v${i}`}
            x={x(i) - bw / 2}
            y={H - 8 - vh}
            width={bw}
            height={vh}
            fill={c.close >= c.open ? STOCK_COLORS.up : STOCK_COLORS.down}
            opacity={0.35}
          />
        );
      }) : null}
    </G>
  );
});

export function StockChart({ candles, timeframe, mode, up, cur, prec, loading, error, onRetry }: StockChartProps): React.JSX.Element {
  const t = useTheme();
  const [width, setWidth] = useState(() => Math.max(0, Dimensions.get('window').width - 2 * t.space.gutter));
  const [hover, setHover] = useState<number | null>(null);
  const [sel, setSel] = useState<ChartSelection | null>(null);
  const [showVol, setShowVol] = useState(false);
  const multi = useRef(false);

  // New candles (another range, a refresh) make old indexes meaningless.
  useEffect(() => { setHover(null); setSel(null); }, [candles]);

  const n = candles.length;
  const model = useMemo(
    () => chartModel(candles, mode, showVol, up, Math.max(1, width), CHART_HEIGHT),
    [candles, mode, showVol, up, width],
  );

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w > 0) setWidth((prev) => (prev === w ? prev : w));
  }, []);

  const track = useCallback((e: GestureResponderEvent, start: boolean) => {
    const touches = e.nativeEvent.touches ?? [];
    const t0 = touches[0];
    const t1 = touches[1];
    if (t0 && t1) {
      multi.current = true;
      setHover(null);
      setSel({ a: indexAtX(model, t0.locationX), b: indexAtX(model, t1.locationX) });
      return;
    }
    if (multi.current) return;
    const i = indexAtX(model, e.nativeEvent.locationX);
    if (start) setSel(null);
    setHover((prev) => (prev === i ? prev : i));
  }, [model]);

  const end = useCallback(() => {
    multi.current = false;
    setHover(null);
    setSel((s) => (s && s.a === s.b ? null : s));
  }, []);

  if (n < 2) {
    return (
      <View style={[styles.empty, { height: CHART_HEIGHT, borderColor: t.colors.borderSubtle, borderRadius: t.radius.xl }]}>
        {loading ? (
          <AppText variant="body" tone="muted">Loading chart…</AppText>
        ) : error ? (
          <ErrorView compact error={error} onRetry={onRetry} />
        ) : (
          <AppText variant="body" tone="muted">No price data for this range.</AppText>
        )}
      </View>
    );
  }

  const info = selectionInfo(sel, model.closes);
  const hc = candles[hover ?? n - 1] ?? candles[n - 1];
  const surface = t.colors.surface;
  const baselineColor = t.isDark ? t.colors.borderDark : STOCK_COLORS.baseline;

  return (
    <View>
      {mode === 'candle' && hc ? (
        <View style={styles.ohlcRow}>
          <View style={styles.ohlc}>
            <AppText variant="body" tone="muted" mono>Price</AppText>
            <AppText variant="body" mono>O <AppText variant="body" weight="700" mono>{fmtNum(hc.open, prec, cur.group)}</AppText></AppText>
            <AppText variant="body" tone="bull" mono>H {fmtNum(hc.high, prec, cur.group)}</AppText>
            <AppText variant="body" tone="bear" mono>L {fmtNum(hc.low, prec, cur.group)}</AppText>
            <AppText variant="body" tone={hc.close >= hc.open ? 'bull' : 'bear'} mono>C {fmtNum(hc.close, prec, cur.group)}</AppText>
          </View>
          <Checkbox label="Volume" value={showVol} onValueChange={setShowVol} />
        </View>
      ) : null}
      <View
        testID="stock-chart"
        onLayout={onLayout}
        style={{ height: CHART_HEIGHT }}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => true}
        onResponderGrant={(e) => track(e, true)}
        onResponderStart={(e) => track(e, false)}
        onResponderMove={(e) => track(e, false)}
        onResponderRelease={end}
        onResponderTerminate={end}
      >
        <Svg width={model.W} height={CHART_HEIGHT} pointerEvents="none">
          <Defs>
            <LinearGradient id="scFill" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0%" stopColor={model.stroke} stopOpacity={0.16} />
              <Stop offset="100%" stopColor={model.stroke} stopOpacity={0} />
            </LinearGradient>
            {info && mode === 'line' ? (
              <ClipPath id="scSelClip">
                <Rect x={model.x(info.lo)} y={0} width={Math.max(0, model.x(info.hi) - model.x(info.lo))} height={CHART_HEIGHT} />
              </ClipPath>
            ) : null}
          </Defs>
          <ChartBody model={model} candles={candles} mode={mode} showVol={showVol} baselineColor={baselineColor} />
          {info ? (
            <G>
              {mode === 'line' ? (
                <Path d={model.area} fill="url(#scFill)" clipPath="url(#scSelClip)" />
              ) : (
                <Rect
                  x={model.x(info.lo)}
                  y={model.padT}
                  width={model.x(info.hi) - model.x(info.lo)}
                  height={model.plotB - model.padT}
                  fill={model.stroke}
                  opacity={0.07}
                />
              )}
              {[info.lo, info.hi].map((i) => (
                <Line key={`l${i}`} x1={model.x(i)} x2={model.x(i)} y1={model.padT} y2={model.plotB} stroke={STOCK_COLORS.crosshair} strokeWidth={1} />
              ))}
              {[info.lo, info.hi].map((i) => (
                <Circle key={`d${i}`} cx={model.x(i)} cy={model.y(model.closes[i] ?? 0)} r={4} fill={model.stroke} stroke={surface} strokeWidth={1.5} />
              ))}
            </G>
          ) : hover !== null ? (
            <G>
              <Line x1={model.x(hover)} x2={model.x(hover)} y1={model.padT} y2={model.plotB} stroke={STOCK_COLORS.crosshair} strokeWidth={1} />
              {mode === 'line' ? (
                <Circle cx={model.x(hover)} cy={model.y(model.closes[hover] ?? 0)} r={4} fill={model.stroke} stroke={surface} strokeWidth={1.5} />
              ) : null}
            </G>
          ) : null}
        </Svg>

        {mode === 'candle' && hover !== null && !info && candles[hover] ? (
          <View
            pointerEvents="none"
            style={[styles.dateTag, { left: Math.min(Math.max(0, model.x(hover) - 80), Math.max(0, model.W - 160)) }]}
          >
            <AppText
              variant="caption"
              weight="500"
              tone="secondary"
              style={[styles.dateTagText, { backgroundColor: t.alpha(surface, 0.9), borderRadius: t.radius.sm }]}
              numberOfLines={1}
            >
              {candleRangeLabel(candles[hover] as Candle, timeframe)}
            </AppText>
          </View>
        ) : null}

        {info ? (
          <View pointerEvents="none" style={[styles.tip, tipStyle(t)]}>
            <AppText variant="body" weight="700" mono tone={info.ch >= 0 ? 'bull' : 'bear'}>{selectionLabel(info, prec, cur)}</AppText>
            <AppText variant="micro" tone="muted">
              {selectionRangeLabel(candles[info.lo] as Candle, candles[info.hi] as Candle, timeframe)}
            </AppText>
          </View>
        ) : hover !== null && mode === 'line' && candles[hover] ? (
          <View pointerEvents="none" style={[styles.tip, tipStyle(t)]}>
            <AppText variant="body" weight="700" mono>{fmtPx(model.closes[hover], prec, cur)}</AppText>
            <AppText variant="micro" tone="muted">{fmtChartDateTime(candleCloseMs(candles[hover] as Candle, timeframe))}</AppText>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const tipStyle = (t: ReturnType<typeof useTheme>) => ({
  backgroundColor: t.colors.surface,
  borderColor: t.colors.borderDark,
  borderRadius: t.radius.md,
  ...t.shadow.card,
});

const styles = StyleSheet.create({
  empty: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  ohlcRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  ohlc: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
  dateTag: { position: 'absolute', top: 0, width: 160, alignItems: 'center' },
  dateTagText: { paddingHorizontal: 6 },
  tip: { position: 'absolute', top: 8, left: 8, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6 },
});
