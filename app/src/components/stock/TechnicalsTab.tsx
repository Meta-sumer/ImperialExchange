import React from 'react';
import { View } from 'react-native';

import { AppText } from '@/components/ui';
import { makeStyles, useTheme } from '@/theme';
import type { Fundamentals } from '@/types/market';
import type { Candle } from '@/types/trading';
import { EMPTY } from '@/utils/money';
import { technicalsView, type StockCurrency } from '@/utils/stockDetail';

/**
 * The Technicals tab — StockDetail.jsx:661-703: SMA 20/50/200 and RSI(14)
 * computed from the chart's candles, a Bullish / Bearish / Neutral summary,
 * and the indicator table (as rows on a phone).
 */
export function TechnicalsTab({
  candles,
  lastPrice,
  fund,
  dayLow,
  dayHigh,
  cur,
  prec,
}: {
  candles: readonly Candle[];
  lastPrice: number | null;
  fund: Fundamentals | null;
  dayLow: number | null;
  dayHigh: number | null;
  cur: StockCurrency;
  prec: number;
}): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  const v = technicalsView(candles, lastPrice, fund, dayLow, dayHigh, cur, prec);

  return (
    <View style={s.wrap}>
      <View style={s.summary}>
        <View style={[s.badge, { backgroundColor: v.signalColor }]}>
          <AppText variant="h2" weight="700" color="#FFFFFF">{v.signal[0]}</AppText>
        </View>
        <View style={s.flex1}>
          <AppText variant="caption" weight="700" tone="muted" style={s.upper}>Technical Summary</AppText>
          <AppText variant="h2" weight="700" color={v.signalColor}>{v.signal}</AppText>
          <AppText variant="caption" tone="muted" style={s.mt2}>{v.summary}</AppText>
        </View>
      </View>

      <View style={s.table}>
        <View style={[s.head, { backgroundColor: t.colors.bgHover }]}>
          <AppText variant="micro" weight="700" tone="muted" style={[s.upper, s.colName]}>Indicator</AppText>
          <AppText variant="micro" weight="700" tone="muted" style={[s.upper, s.colValue]} align="right">Value</AppText>
          <AppText variant="micro" weight="700" tone="muted" style={[s.upper, s.colSignal]} align="right">Signal</AppText>
        </View>
        {v.rows.map((r, i) => (
          <View
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            style={[s.row, i > 0 ? { borderTopWidth: 1, borderTopColor: t.colors.borderSubtle } : null]}
          >
            <AppText variant="body" tone="secondary" style={s.colName}>{r.indicator}</AppText>
            <AppText variant="body" mono align="right" style={s.colValue}>{r.value}</AppText>
            <View style={s.colSignal}>
              {r.signal ? (
                <AppText variant="caption" weight="700" align="right" tone={r.positive ? 'bull' : 'bear'}>{r.signal}</AppText>
              ) : (
                <AppText variant="body" tone="muted" align="right">{EMPTY}</AppText>
              )}
            </View>
          </View>
        ))}
      </View>
      <AppText variant="caption" tone="muted">{v.footnote}</AppText>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  wrap: { gap: t.space.xxl },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.space.lg,
    borderWidth: 1,
    borderColor: t.colors.borderDark,
    borderRadius: t.radius.xxl,
    padding: t.space.xl,
  },
  badge: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  flex1: { flex: 1 },
  upper: { textTransform: 'uppercase', letterSpacing: 0.6 },
  mt2: { marginTop: 2 },
  table: { borderWidth: 1, borderColor: t.colors.borderDark, borderRadius: t.radius.xxl, overflow: 'hidden' },
  head: { flexDirection: 'row', paddingHorizontal: t.space.lg, paddingVertical: 10 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: t.space.lg, paddingVertical: t.space.md },
  colName: { flex: 1.1, paddingRight: t.space.sm },
  colValue: { flex: 1.6 },
  colSignal: { flex: 1, alignItems: 'flex-end' },
}));
