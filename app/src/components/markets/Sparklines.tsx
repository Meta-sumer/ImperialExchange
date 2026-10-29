import React, { memo } from 'react';
import { View } from 'react-native';
import Svg, { G, Line, Path, Rect } from 'react-native-svg';

import { LIST_DOWN, LIST_UP, candleSparkMarks, sparkPath, synthSpark } from '@/utils/markets';

import { useSparkCandles } from './sparkCache';

/**
 * MarketList's row sparkline (MarketList.jsx:112-127). Decorative — see
 * utils/markets synthSpark: it is drawn from the sign of the 24h change, not
 * from prices. Shown only where the web shows it (≥ 640 dp).
 */
export const SynthSparkline = memo(function SynthSparkline({
  change,
  seed,
  positive,
  width = 110,
  height = 32,
}: {
  change: unknown;
  seed: number;
  positive: boolean;
  width?: number;
  height?: number;
}): React.JSX.Element | null {
  const d = sparkPath(synthSpark(change, seed), width, height);
  if (!d) return null;
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Path
        d={d}
        fill="none"
        stroke={positive ? LIST_UP : LIST_DOWN}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
});

const CANDLE_UP = '#16A34A';
const CANDLE_DOWN = '#EF4444';
const W = 140;
const H = 48;

/**
 * FnoHome's real candlestick sparkline — the last 24 daily candles
 * (FnoHome.jsx:358-393). Until they arrive, or with fewer than two, an
 * empty 48-dp block holds the card's height, as the web's `h-12` does.
 */
export const CandleSparkline = memo(function CandleSparkline({ symbol }: { symbol: string }): React.JSX.Element {
  const candles = useSparkCandles(symbol);
  const marks = candleSparkMarks(candles, W, H);
  if (!marks) return <View style={{ height: H }} testID={`spark-empty-${symbol}`} />;
  return (
    <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" testID={`spark-${symbol}`}>
      {marks.map((m, i) => {
        const col = m.green ? CANDLE_UP : CANDLE_DOWN;
        return (
          // eslint-disable-next-line react/no-array-index-key
          <G key={i}>
            <Line x1={m.cx} x2={m.cx} y1={m.yHigh} y2={m.yLow} stroke={col} strokeWidth={0.8} />
            <Rect x={m.cx - m.bodyW / 2} y={m.top} width={m.bodyW} height={m.height} fill={col} rx={0.4} />
          </G>
        );
      })}
    </Svg>
  );
});
