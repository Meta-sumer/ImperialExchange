import React from 'react';
import { Pressable, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { AppText, AssetIcon } from '@/components/ui';
import { FinancialPerformance } from '@/components/stock/FinancialPerformance';
import { makeStyles, useTheme } from '@/theme';
import type { Fundamentals, OrderBook, OrderBookLevel } from '@/types/market';
import type { Candle, Instrument } from '@/types/trading';
import { EMPTY, fmtNum } from '@/utils/money';
import {
  STOCK_COLORS,
  depthRows,
  depthSummary,
  fmtPx,
  fmtQty,
  fmtSignedPct,
  fundamentalRows,
  performanceMetrics,
  rangePosition,
  similarInstruments,
  stockCurrency,
  stockPrecision,
  week52,
  type StockCurrency,
  type StockFigures,
} from '@/utils/stockDetail';

/**
 * The Overview tab — StockDetail.jsx:338-483: market depth, performance
 * ranges and metrics, Yahoo fundamentals, financial performance and similar
 * instruments. Only real figures (utils/stockDetail explains what the web
 * invents and why it is not here).
 */

export interface OverviewTabProps {
  book: OrderBook | null;
  figures: StockFigures;
  cur: StockCurrency;
  prec: number;
  candles: readonly Candle[];
  fund: Fundamentals | null;
  instruments: readonly Instrument[];
  inst: Instrument | null;
  symbol: string;
  onOpenInstrument: (symbol: string) => void;
}

function DepthCol({
  title,
  rows,
  tone,
  prec,
  cur,
}: {
  title: string;
  rows: readonly OrderBookLevel[];
  tone: 'bull' | 'bear';
  prec: number;
  cur: StockCurrency;
}): React.JSX.Element {
  const s = useStyles();
  const color = tone === 'bull' ? STOCK_COLORS.up : STOCK_COLORS.down;
  const bg = tone === 'bull' ? 'rgba(22,163,74,0.08)' : 'rgba(234,88,12,0.08)';
  const list = depthRows(rows);
  return (
    <View style={s.flex1}>
      <View style={s.depthHead}>
        <AppText variant="caption" weight="600" tone="muted">{title}</AppText>
        <AppText variant="caption" weight="600" tone="muted">Qty</AppText>
      </View>
      {list.length === 0 ? (
        <AppText variant="caption" tone="muted" align="center" style={s.noDepth}>No depth</AppText>
      ) : list.map(({ level, qty, widthPct }, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <View key={i} style={s.depthRow}>
          <View style={[s.depthBar, { width: `${widthPct}%`, backgroundColor: bg }]} />
          <AppText variant="body" mono color={color}>{fmtNum(level.price, prec, cur.group)}</AppText>
          <AppText variant="body" mono>{fmtQty(qty, cur)}</AppText>
        </View>
      ))}
    </View>
  );
}

function RangeBar({
  label1,
  v1,
  label2,
  v2,
  value,
  cur,
  prec,
}: {
  label1: string;
  v1: number | null;
  label2: string;
  v2: number | null;
  value: number | null;
  cur: StockCurrency;
  prec: number;
}): React.JSX.Element {
  const s = useStyles();
  const pos = rangePosition(value, v1, v2);
  return (
    <View>
      <View style={s.rangeLabels}>
        <View>
          <AppText variant="caption" tone="muted">{label1}</AppText>
          <AppText variant="bodyStrong" mono>{fmtPx(v1, prec, cur)}</AppText>
        </View>
        <View style={s.alignEnd}>
          <AppText variant="caption" tone="muted">{label2}</AppText>
          <AppText variant="bodyStrong" mono>{fmtPx(v2, prec, cur)}</AppText>
        </View>
      </View>
      <View style={s.rangeTrack}>
        <Svg width="100%" height={6}>
          <Defs>
            <LinearGradient id="rangeGrad" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0%" stopColor={STOCK_COLORS.up} />
              <Stop offset="50%" stopColor={STOCK_COLORS.lime} />
              <Stop offset="100%" stopColor={STOCK_COLORS.up} />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height={6} rx={3} fill="url(#rangeGrad)" />
        </Svg>
        {pos !== null ? (
          <View
            testID="range-marker"
            style={[s.marker, { left: `${pos}%`, borderTopColor: STOCK_COLORS.marker }]}
          />
        ) : null}
      </View>
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  const s = useStyles();
  return (
    <View style={s.metric}>
      <AppText variant="caption" tone="muted">{label}</AppText>
      <AppText variant="bodyStrong" mono style={s.metricValue}>{value}</AppText>
    </View>
  );
}

export function OverviewTab({
  book,
  figures,
  cur,
  prec,
  candles,
  fund,
  instruments,
  inst,
  symbol,
  onOpenInstrument,
}: OverviewTabProps): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  const depth = depthSummary(book);
  const wk = week52(fund);
  const similar = similarInstruments(instruments, symbol, inst?.category);

  return (
    <View style={s.sections}>
      {/* Market depth */}
      <View>
        <AppText variant="h3" weight="700" style={s.sectionTitle}>Market depth</AppText>
        <View style={s.pctRow}>
          <AppText variant="small" weight="600" tone="secondary">
            Buy orders <AppText variant="small" weight="600">{`${fmtNum(depth.buyPct, 2)}%`}</AppText>
          </AppText>
          <AppText variant="small" weight="600" tone="secondary">
            Sell orders <AppText variant="small" weight="600">{`${fmtNum(100 - depth.buyPct, 2)}%`}</AppText>
          </AppText>
        </View>
        <View style={[s.split, { backgroundColor: t.colors.bgHover }]}>
          <View style={{ width: `${depth.buyPct}%`, backgroundColor: STOCK_COLORS.up }} />
          <View style={{ width: `${100 - depth.buyPct}%`, backgroundColor: STOCK_COLORS.down }} />
        </View>
        <View style={s.depthCols}>
          <DepthCol title="Bid Price" rows={depth.bids} tone="bull" prec={prec} cur={cur} />
          <DepthCol title="Ask Price" rows={depth.asks} tone="bear" prec={prec} cur={cur} />
        </View>
        <View style={[s.depthCols, s.totals, { borderTopColor: t.colors.borderSubtle }]}>
          <View style={[s.flex1, s.totalRow]}>
            <AppText variant="bodyStrong" weight="700">Bid Total</AppText>
            <AppText variant="bodyStrong" weight="700" mono>{fmtQty(depth.bidTotal, cur)}</AppText>
          </View>
          <View style={[s.flex1, s.totalRow]}>
            <AppText variant="bodyStrong" weight="700">Ask Total</AppText>
            <AppText variant="bodyStrong" weight="700" mono>{fmtQty(depth.askTotal, cur)}</AppText>
          </View>
        </View>
      </View>

      {/* Performance */}
      <View>
        <AppText variant="h3" weight="700" style={s.sectionTitle}>Performance</AppText>
        <RangeBar label1="Today's low" v1={figures.dayLow} label2="Today's high" v2={figures.dayHigh} value={figures.lastPrice} cur={cur} prec={prec} />
        <View style={s.gapTop}>
          <RangeBar label1="52 week low" v1={wk.low} label2="52 week high" v2={wk.high} value={figures.lastPrice} cur={cur} prec={prec} />
        </View>
        <View style={s.metrics}>
          {performanceMetrics(figures, fund, inst, candles, cur, prec).map(([label, value]) => (
            <Metric key={label} label={label} value={value} />
          ))}
        </View>
      </View>

      {/* Fundamentals (Yahoo Finance) */}
      <View>
        <AppText variant="h3" weight="700" style={s.sectionTitle}>Fundamentals</AppText>
        {fundamentalRows(fund, cur, prec).map(([k, v]) => (
          <View key={k} style={[s.fundRow, { borderBottomColor: t.alpha(t.colors.borderSubtle, 0.6) }]}>
            <AppText variant="body" tone="secondary">{k}</AppText>
            <AppText variant="bodyStrong" mono>{v}</AppText>
          </View>
        ))}
      </View>

      <FinancialPerformance fund={fund} cur={cur} />

      {/* Similar */}
      {similar.length > 0 ? (
        <View>
          <AppText variant="h3" weight="700" style={s.sectionTitle}>Similar stocks</AppText>
          <View style={s.table}>
            <View style={[s.tableHead, { backgroundColor: t.colors.bgHover }]}>
              <AppText variant="caption" weight="700" tone="muted" style={s.upper}>Stock</AppText>
              <AppText variant="caption" weight="700" tone="muted" style={s.upper}>Mkt price (1D)</AppText>
            </View>
            {similar.map((r, i) => {
              const rc = stockCurrency(r);
              const ch = r.change24h ?? null;
              return (
                <Pressable
                  key={r.symbol}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${r.symbol}`}
                  onPress={() => onOpenInstrument(r.symbol)}
                  style={({ pressed }) => [
                    s.simRow,
                    i > 0 ? { borderTopWidth: 1, borderTopColor: t.colors.borderSubtle } : null,
                    pressed ? { backgroundColor: t.colors.bgHover } : null,
                  ]}
                >
                  <View style={s.simName}>
                    <AssetIcon row={r} size={30} round />
                    <View style={s.flexShrink}>
                      <AppText variant="bodyStrong" numberOfLines={1}>{r.name || r.symbol}</AppText>
                      <AppText variant="micro" tone="muted">{r.symbol}</AppText>
                    </View>
                  </View>
                  <View style={s.alignEnd}>
                    <AppText variant="bodyStrong" mono>{fmtPx(r.lastPrice, stockPrecision(r), rc)}</AppText>
                    <AppText variant="caption" mono tone={ch === null ? 'muted' : ch >= 0 ? 'bull' : 'bear'}>
                      {ch === null ? EMPTY : fmtSignedPct(ch, 2)}
                    </AppText>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  sections: { gap: 40 },
  sectionTitle: { marginBottom: t.space.lg },
  flex1: { flex: 1 },
  flexShrink: { flexShrink: 1 },
  alignEnd: { alignItems: 'flex-end' },
  upper: { textTransform: 'uppercase', letterSpacing: 0.6 },
  pctRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  split: { height: 6, borderRadius: 3, overflow: 'hidden', flexDirection: 'row' },
  depthCols: { flexDirection: 'row', gap: t.space.xxl, marginTop: t.space.lg },
  depthHead: { flexDirection: 'row', justifyContent: 'space-between', paddingBottom: 6 },
  noDepth: { paddingVertical: t.space.lg },
  depthRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  depthBar: { position: 'absolute', top: 0, bottom: 0, right: 0 },
  totals: { marginTop: t.space.sm, paddingTop: t.space.sm, borderTopWidth: 1 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between' },
  rangeLabels: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: t.space.sm },
  rangeTrack: { height: 6, justifyContent: 'center' },
  marker: {
    position: 'absolute',
    top: -3,
    width: 0,
    height: 0,
    marginLeft: -5,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderTopWidth: 8,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  gapTop: { marginTop: t.space.xxl },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', marginTop: t.space.xxl, rowGap: t.space.lg },
  metric: { width: '50%', paddingRight: t.space.lg },
  metricValue: { marginTop: 2 },
  fundRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, marginBottom: t.space.xs },
  table: { borderWidth: 1, borderColor: t.colors.borderDark, borderRadius: t.radius.xxl, overflow: 'hidden' },
  tableHead: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: t.space.lg, paddingVertical: 10 },
  simRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: t.space.lg, paddingVertical: t.space.md, gap: t.space.md },
  simName: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
}));
