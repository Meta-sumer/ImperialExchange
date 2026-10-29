import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Line } from 'react-native-svg';

import { AppText } from '@/components/ui';
import { StockChip } from '@/components/stock/StockChip';
import { makeStyles, useTheme } from '@/theme';
import type { Fundamentals } from '@/types/market';
import { EMPTY } from '@/utils/money';
import {
  FIN_MODES,
  STOCK_COLORS,
  crfmt,
  financialView,
  fmtSignedPct,
  kfmt,
  type FinMode,
  type StockCurrency,
} from '@/utils/stockDetail';

/**
 * "Financial performance" — StockDetail.jsx:549-650: Quarterly / Yearly
 * revenue and profit bars from Yahoo (in crore), the selected period's
 * figures with growth over the one before, and the 1Y / 3Y growth table.
 *
 * With no Yahoo figures the web draws five made-up quarters; here the card
 * says there is nothing to show. "All Financials ›" is not ported: on the
 * web it is a plain label that looks like a link and goes nowhere.
 */

const CHART_H = 208; // h-52
const AXIS_W = 40; // w-10

function Pct({ v, decimals, bold }: { v: number | null; decimals: number; bold?: boolean }): React.JSX.Element {
  if (v === null) return <AppText variant="small" tone="muted">{EMPTY}</AppText>;
  return (
    <AppText variant={bold ? 'bodyStrong' : 'small'} weight={bold ? '700' : undefined} tone={v >= 0 ? 'bull' : 'bear'}>
      {fmtSignedPct(v, decimals)}
    </AppText>
  );
}

export function FinancialPerformance({ fund, cur }: { fund: Fundamentals | null; cur: StockCurrency }): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  const [mode, setMode] = useState<FinMode>('Quarterly');
  const [sel, setSel] = useState<number | null>(null);
  const v = financialView(fund, mode, sel);
  const pctDecimals = mode === 'Quarterly' ? 2 : 0;

  return (
    <View>
      <AppText variant="h3" weight="700" style={s.title}>Financial performance</AppText>
      <View style={s.modes}>
        {FIN_MODES.map((m) => (
          <StockChip key={m} label={m} active={mode === m} onPress={() => { setMode(m); setSel(null); }} />
        ))}
      </View>

      <View style={s.card}>
        {v.selBar ? (
          <>
            <AppText variant="caption" weight="700" tone="muted" style={s.upper}>{v.selBar.label}</AppText>
            <View style={s.figures}>
              <View>
                <View style={s.legend}>
                  <View style={[s.dot, { backgroundColor: STOCK_COLORS.revenue }]} />
                  <AppText variant="caption" tone="muted" style={s.upper}>Revenue (Cr)</AppText>
                </View>
                <View style={s.valueRow}>
                  <AppText variant="h3" weight="700" mono>{crfmt(v.selBar.rev, cur)} </AppText>
                  <Pct v={v.revG} decimals={pctDecimals} />
                </View>
              </View>
              <View>
                <View style={s.legend}>
                  <View style={[s.dot, { backgroundColor: STOCK_COLORS.profit }]} />
                  <AppText variant="caption" tone="muted" style={s.upper}>Profit (Cr)</AppText>
                </View>
                <View style={s.valueRow}>
                  <AppText variant="h3" weight="700" mono>{crfmt(v.selBar.pr, cur)} </AppText>
                  <Pct v={v.prG} decimals={pctDecimals} />
                </View>
              </View>
            </View>

            <View style={s.chart}>
              <View style={[StyleSheet.absoluteFill, { right: AXIS_W }]}>
                <Svg width="100%" height={CHART_H} style={StyleSheet.absoluteFill}>
                  {v.ticks.map((tick) => {
                    const yy = CHART_H - (tick / v.niceMax) * CHART_H;
                    const yLine = Math.min(CHART_H - 0.5, Math.max(0.5, yy));
                    return (
                      <Line key={tick} x1="0" x2="100%" y1={yLine} y2={yLine} stroke={t.colors.borderSubtle} strokeDasharray="4 4" strokeWidth={1} />
                    );
                  })}
                </Svg>
                <View style={s.bars}>
                  {v.bars.map((b, i) => {
                    const on = i === v.selIdx;
                    return (
                      <Pressable
                        // eslint-disable-next-line react/no-array-index-key
                        key={i}
                        accessibilityRole="button"
                        accessibilityLabel={b.label}
                        accessibilityState={{ selected: on }}
                        onPress={() => setSel(i)}
                        style={s.barGroup}
                      >
                        <View style={[s.bar, { height: `${Math.max(0, (b.rev / v.niceMax) * 100)}%`, backgroundColor: on ? STOCK_COLORS.revenue : STOCK_COLORS.revenueDim }]} />
                        <View style={[s.bar, { height: `${Math.max(0, (b.pr / v.niceMax) * 100)}%`, backgroundColor: on ? STOCK_COLORS.profit : STOCK_COLORS.profitDim }]} />
                      </Pressable>
                    );
                  })}
                </View>
              </View>
              <View style={s.axis}>
                {v.ticks.map((tick) => (
                  <AppText
                    key={tick}
                    variant="micro"
                    tone="muted"
                    style={[s.axisLabel, { bottom: (tick / v.niceMax) * CHART_H - 7 }]}
                  >
                    {kfmt(tick)}
                  </AppText>
                ))}
              </View>
            </View>
            <View style={s.labels}>
              {v.bars.map((b, i) => (
                <AppText
                  // eslint-disable-next-line react/no-array-index-key
                  key={i}
                  variant="caption"
                  align="center"
                  weight={i === v.selIdx ? '700' : undefined}
                  tone={i === v.selIdx ? 'primary' : 'muted'}
                  style={s.flex1}
                  numberOfLines={1}
                >
                  {b.label}
                </AppText>
              ))}
            </View>
          </>
        ) : (
          <AppText variant="body" tone="muted" align="center" style={s.none}>
            {`No ${mode === 'Quarterly' ? 'quarterly' : 'yearly'} financials available.`}
          </AppText>
        )}
      </View>

      <View style={s.growth}>
        {v.growth.map((g) => (
          <View key={g.title} style={s.growthBlock}>
            <View style={[s.growthHead, { borderBottomColor: t.colors.borderSubtle }]}>
              <AppText variant="caption" weight="700" tone="muted" style={s.upper}>{g.title}</AppText>
              <AppText variant="caption" weight="700" tone="muted" style={s.upper}>Value</AppText>
            </View>
            <View style={s.growthRow}>
              <AppText variant="body" tone="secondary">1Y (TTM)</AppText>
              <Pct v={g.one} decimals={0} bold />
            </View>
            <View style={s.growthRow}>
              <AppText variant="body" tone="secondary">3Y CAGR</AppText>
              <Pct v={g.three} decimals={0} bold />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  title: { marginBottom: t.space.lg },
  modes: { flexDirection: 'row', gap: t.space.sm, marginBottom: t.space.lg },
  card: { borderWidth: 1, borderColor: t.colors.borderDark, borderRadius: t.radius.xxl, padding: t.space.xl },
  upper: { textTransform: 'uppercase', letterSpacing: 0.6 },
  figures: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.xxxl, marginTop: 6 },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: 2 },
  chart: { height: CHART_H, marginTop: t.space.xxl },
  bars: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', alignItems: 'flex-end' },
  barGroup: { flex: 1, height: '100%', flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 6 },
  bar: { width: 20, borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  axis: { position: 'absolute', right: 0, top: 0, bottom: 0, width: AXIS_W },
  axisLabel: { position: 'absolute', right: 0 },
  labels: { flexDirection: 'row', marginTop: t.space.sm, paddingRight: AXIS_W },
  flex1: { flex: 1 },
  none: { paddingVertical: t.space.xxxl },
  growth: { marginTop: t.space.xxl, gap: t.space.lg },
  growthBlock: {},
  growthHead: { flexDirection: 'row', justifyContent: 'space-between', paddingBottom: t.space.sm, borderBottomWidth: 1 },
  growthRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
}));
