import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { WatchlistButton } from '@/components/market/WatchlistButton';
import { AppText } from '@/components/ui';
import { alpha, useTheme } from '@/theme';
import type { Instrument, OrderSide } from '@/types/trading';

import { chartTypeLabel, type ChartTimeframe, type ChartType } from '../chartCatalog';
import { ChartTypeSheet, TimeframeSheet } from './ChartSheets';
import { ChartTypeGlyph, ToolIcon } from './chartGlyphs';

/**
 * The chart's header — PriceChart.jsx:3464-3727, and MultiChartToolbar.jsx
 * when `symbolLabel` is set (the shared toolbar over a multi-chart grid).
 * Scrolls sideways on a narrow phone rather than wrapping under the chart.
 */

export interface QuickQuote { bid: number; ask: number; spread: number; prec: number }

/**
 * The Sell / Buy chip's prices: last ± half the spread, PERCENTAGE spreads
 * as a fraction of last — the web chip's own arithmetic (PriceChart.jsx:3594).
 */
export const quickTradeQuote = (instrument: Pick<Instrument, 'lastPrice' | 'spreadValue' | 'spreadType' | 'pricePrecision'>, precision = 2): QuickQuote => {
  const last = Number(instrument.lastPrice) || 0;
  const half = Number(instrument.spreadValue || 0) / 2;
  const bid = instrument.spreadType === 'PERCENTAGE' ? last * (1 - half) : last - half;
  const ask = instrument.spreadType === 'PERCENTAGE' ? last * (1 + half) : last + half;
  return { bid, ask, spread: ask - bid, prec: Math.min(instrument.pricePrecision || precision || 2, 5) };
};

export interface ChartToolbarProps {
  symbolLabel?: string;
  chartType: ChartType;
  onChartType: (t: ChartType) => void;
  indicatorCount: number;
  onOpenIndicators: () => void;
  timeframe: string;
  onTimeframe: (tf: ChartTimeframe) => void;
  instrument: Instrument | null;
  precision: number;
  orderSide?: OrderSide | null;
  onOrderSideChange?: (side: OrderSide) => void;
  hideQuickTrade?: boolean;
  openPositionsCount?: number;
  onCloseAll?: () => void;
  extra?: React.ReactNode;
  symbol?: string;
  tvDemo?: boolean;
  onToggleTvDemo?: () => void;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

function ToolBtn({ onPress, label, active, children, testID }: { onPress: () => void; label: string; active?: boolean; children: React.ReactNode; testID?: string }): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active }}
      onPress={onPress}
      style={({ pressed }) => [s.btn, {
        borderColor: active ? t.colors.primary : t.colors.borderDark,
        backgroundColor: active ? alpha(t.colors.primary, 0.1) : pressed ? t.colors.bgHover : t.colors.surface,
      }]}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

export function ChartToolbar(p: ChartToolbarProps): React.JSX.Element {
  const t = useTheme();
  const [typeOpen, setTypeOpen] = useState(false);
  const [tfOpen, setTfOpen] = useState(false);
  const q = p.instrument && p.onOrderSideChange && !p.hideQuickTrade ? quickTradeQuote(p.instrument, p.precision) : null;

  return (
    <View style={[s.bar, { borderBottomColor: t.colors.borderDark, backgroundColor: t.colors.bgCard }]} testID="chart-toolbar">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row} keyboardShouldPersistTaps="handled">
        <View style={[s.live, { backgroundColor: t.colors.bull }]} />
        {p.symbolLabel ? <AppText variant="caption" weight="700" mono>{p.symbolLabel}</AppText> : null}

        <ToolBtn label="Chart type" onPress={() => setTypeOpen(true)} testID="chart-type-btn">
          <ChartTypeGlyph type={p.chartType} color={t.colors.textMuted} size={14} />
          <AppText variant="caption" weight="600" color={t.colors.textSecondary}>{chartTypeLabel(p.chartType)}</AppText>
          <AppText variant="micro" tone="muted">▾</AppText>
        </ToolBtn>

        <ToolBtn label="Indicators" onPress={p.onOpenIndicators} testID="indicators-btn">
          <ToolIcon name="indicators" color={t.colors.textPrimary} size={12} />
          <AppText variant="caption" weight="600">Indicators</AppText>
          {p.indicatorCount > 0 ? (
            <View style={[s.count, { backgroundColor: t.colors.primary }]}>
              <AppText variant="micro" weight="700" color={t.colors.onPrimary}>{p.indicatorCount}</AppText>
            </View>
          ) : null}
        </ToolBtn>

        <ToolBtn label="Timeframe" onPress={() => setTfOpen(true)} testID="timeframe-btn">
          <ToolIcon name="clock" color={t.colors.textPrimary} size={12} />
          <AppText variant="caption" weight="700">{p.timeframe}</AppText>
          <AppText variant="micro" tone="muted">▾</AppText>
        </ToolBtn>

        {q && p.onOrderSideChange ? (
          <View style={[s.chip, { borderColor: t.colors.borderDark }]} testID="quick-trade">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Sell at bid"
              onPress={() => p.onOrderSideChange?.('SELL')}
              style={[s.side, { backgroundColor: p.orderSide === 'SELL' ? t.colors.bear : alpha(t.colors.bear, 0.1) }]}
              testID="quick-sell"
            >
              <AppText variant="micro" weight="700" color={p.orderSide === 'SELL' ? '#FFFFFF' : t.colors.bear} style={s.sideLbl}>SELL</AppText>
              <AppText variant="micro" weight="700" mono color={p.orderSide === 'SELL' ? '#FFFFFF' : t.colors.bear}>{q.bid.toFixed(q.prec)}</AppText>
            </Pressable>
            <View style={[s.spread, { borderColor: t.colors.borderDark, backgroundColor: t.colors.bgCard }]}>
              <AppText variant="micro" weight="600" mono tone="secondary">{q.spread.toFixed(q.prec)}</AppText>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Buy at ask"
              onPress={() => p.onOrderSideChange?.('BUY')}
              style={[s.side, { backgroundColor: p.orderSide === 'BUY' ? t.colors.primary : alpha(t.colors.primary, 0.1) }]}
              testID="quick-buy"
            >
              <AppText variant="micro" weight="700" color={p.orderSide === 'BUY' ? '#FFFFFF' : t.colors.primaryText} style={s.sideLbl}>BUY</AppText>
              <AppText variant="micro" weight="700" mono color={p.orderSide === 'BUY' ? '#FFFFFF' : t.colors.primaryText}>{q.ask.toFixed(q.prec)}</AppText>
            </Pressable>
          </View>
        ) : null}

        {p.onCloseAll && (p.openPositionsCount ?? 0) > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Close all ${p.openPositionsCount} open position(s)`}
            onPress={p.onCloseAll}
            style={[s.closeAll, { borderColor: alpha(t.colors.bear, 0.3), backgroundColor: alpha(t.colors.bear, 0.1) }]}
            testID="chart-close-all"
          >
            <AppText variant="caption" weight="700" color={t.colors.bear}>✕ Close All</AppText>
            <View style={[s.closeCount, { backgroundColor: alpha(t.colors.bear, 0.2) }]}>
              <AppText variant="micro" weight="800" color={t.colors.bear}>{p.openPositionsCount}</AppText>
            </View>
          </Pressable>
        ) : null}

        {p.extra}

        {p.symbol ? <WatchlistButton symbol={p.symbol} row={p.instrument} variant="toolbar" size={15} persistent /> : null}

        {p.onToggleTvDemo ? (
          <ToolBtn label={p.tvDemo ? 'Back to platform chart' : 'View TradingView demo chart'} active={p.tvDemo} onPress={p.onToggleTvDemo} testID="tv-toggle">
            <ToolIcon name={p.tvDemo ? 'eyeOff' : 'eye'} color={p.tvDemo ? t.colors.primaryText : t.colors.textSecondary} size={15} />
          </ToolBtn>
        ) : null}

        {p.onToggleFullscreen ? (
          <ToolBtn label={p.fullscreen ? 'Exit fullscreen' : 'Fullscreen chart'} onPress={p.onToggleFullscreen} testID="fullscreen-toggle">
            <ToolIcon name={p.fullscreen ? 'collapse' : 'expand'} color={t.colors.textSecondary} size={14} />
          </ToolBtn>
        ) : null}
      </ScrollView>

      <ChartTypeSheet open={typeOpen} value={p.chartType} onPick={p.onChartType} onClose={() => setTypeOpen(false)} />
      <TimeframeSheet open={tfOpen} value={p.timeframe} onPick={p.onTimeframe} onClose={() => setTfOpen(false)} />
    </View>
  );
}

const s = StyleSheet.create({
  bar: { borderBottomWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 6 },
  live: { width: 6, height: 6, borderRadius: 3 },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 32, paddingHorizontal: 9, borderRadius: 6, borderWidth: 1 },
  count: { minWidth: 16, paddingHorizontal: 4, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  chip: { flexDirection: 'row', height: 32, borderRadius: 6, overflow: 'hidden', borderWidth: 1 },
  side: { paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  sideLbl: { fontSize: 8, letterSpacing: 0.6 },
  spread: { paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center', borderLeftWidth: 1, borderRightWidth: 1 },
  closeAll: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 32, paddingHorizontal: 9, borderRadius: 6, borderWidth: 1 },
  closeCount: { minWidth: 16, paddingHorizontal: 4, height: 16, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
});
