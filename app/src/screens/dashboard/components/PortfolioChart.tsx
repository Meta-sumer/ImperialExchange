import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';

import {
  fetchLifetimeStats,
  fetchPerformanceSeries,
  PERFORMANCE_METRICS,
  PERFORMANCE_RANGES,
  type PerformanceMetric,
  type PerformanceRange,
} from '@/api/dashboard.api';
import { AppText, Segmented, Tabs } from '@/components/ui';
import { useTheme } from '@/theme';
import type { DashboardSummary, LifetimeStats, SeriesBucket } from '@/types/trading';
import {
  areaPath,
  barRect,
  bucketAt,
  chartGeometry,
  chartHeadline,
  chartStrip,
  fmtAxis,
  fmtChartHeadline,
  hasNonZero,
  linePath,
  tooltipLines,
  visibleXLabels,
  yScaleFor,
  type ChartPad,
} from '@/utils/dashboard';

import { Eyebrow, Section, TINT } from './shared';

const HEIGHT = 240;
const PAD: ChartPad = { top: 18, right: 12, bottom: 30, left: 40 };
const TOOLTIP_W = 168;

/**
 * "Analytics" — Dashboard.jsx PortfolioChart (:674-1179): metric tabs
 * (Net profit · Closed orders · Trading volume · Equity), timeframes
 * (1D · 1W · 1M · 3M · 1Y · ALL), a different mark per metric (area, bars,
 * histogram, curve), the Best Day / Worst Day / Win Rate / Profit Factor /
 * Total Trades strip, and the per-bucket card — every figure in rupees.
 *
 * Calls: GET /user/dashboard/monthly-series?range= on every range change,
 * GET /user/dashboard/lifetime-stats once (all accounts). The dashboard
 * summary for the strip is the page's own copy (`dash`), as on the web —
 * no second /user/dashboard read.
 *
 * Phone adaptations: the chart fits the card's width instead of a 680px
 * scrolling SVG, hover becomes a tap on a column (tap it again to clear),
 * and x labels thin to what fits.
 */
export function PortfolioChart({
  dash,
  refreshKey,
}: {
  dash: DashboardSummary | null;
  refreshKey: number;
}): React.JSX.Element {
  const t = useTheme();
  const [buckets, setBuckets] = useState<SeriesBucket[]>([]);
  const [tab, setTab] = useState<PerformanceMetric>('netProfit');
  const [range, setRange] = useState<PerformanceRange>('1y');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [lifetime, setLifetime] = useState<LifetimeStats | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    let dead = false;
    fetchLifetimeStats({})
      .then((s) => { if (!dead) setLifetime(s); })
      .catch(() => { /* the strip falls back to the dashboard's figures */ });
    return () => { dead = true; };
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchPerformanceSeries({ range })
      .then((s) => { if (!cancelled) setBuckets(s.buckets); })
      .catch(() => { /* keep previous */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [range, refreshKey]);

  // A new series is new columns — a selection on the old one means nothing.
  useEffect(() => { setSelected(null); }, [buckets]);

  const activeTab = PERFORMANCE_METRICS.find((m) => m.id === tab) ?? PERFORMANCE_METRICS[0];
  const scale = useMemo(() => yScaleFor(buckets, tab), [buckets, tab]);
  const headline = useMemo(() => chartHeadline(buckets, tab), [buckets, tab]);
  const g = useMemo(
    () => chartGeometry(Math.max(width, 1), HEIGHT, PAD, buckets.length, scale),
    [width, buckets.length, scale],
  );
  const line = useMemo(() => (buckets.length ? linePath(buckets, tab, g) : ''), [buckets, tab, g]);
  const area = useMemo(() => areaPath(line, buckets.length, g, scale.yMin), [line, buckets.length, g, scale.yMin]);
  const nonZero = hasNonZero(buckets, tab);
  const strip = chartStrip(buckets, lifetime, dash);
  const up = (headline?.value ?? 0) >= 0;
  const maxLabels = Math.max(3, Math.min(8, Math.floor(g.innerW / 48)));
  const xLabels = visibleXLabels(buckets.length, maxLabels, true);
  const hovered = selected !== null ? buckets[selected] ?? null : null;
  const rangeLabel = PERFORMANCE_RANGES.find((r) => r.id === range)?.label ?? '—';

  const onLayout = (e: LayoutChangeEvent): void => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w !== width) setWidth(w);
  };

  const onTap = (e: GestureResponderEvent): void => {
    const i = bucketAt(e.nativeEvent.locationX, g, buckets.length);
    setSelected((cur) => (i === null || i === cur ? null : i));
  };

  const headColor = headline?.tone === 'bull' ? t.colors.bull : headline?.tone === 'bear' ? t.colors.bear : t.colors.textPrimary;
  const gridMuted = t.colors.borderSubtle;
  const gridZero = t.isDark ? t.colors.borderDark : '#CBD5E1';
  const axisText = t.isDark ? t.colors.textMuted : TINT.slate;

  return (
    <Section testID="dashboard-chart" style={styles.gapBelow}>
      <Eyebrow>Analytics</Eyebrow>
      <AppText variant="h1" weight="800" mono color={headColor} style={styles.headline} testID="dashboard-chart-headline">
        {fmtChartHeadline(headline)}
      </AppText>
      <AppText variant="caption" tone="muted">{`${activeTab.label} · ${rangeLabel}`}</AppText>

      {/* Best Day / Worst Day / Win Rate / Profit Factor / Total Trades */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[styles.strip, { borderColor: t.colors.borderSubtle }]}
      >
        {strip.map((s, i) => (
          <View
            key={s.label}
            accessible
            accessibilityLabel={`${s.label}: ${s.value}`}
            style={[styles.stripCell, i > 0 ? { borderLeftWidth: 1, borderLeftColor: t.colors.borderSubtle } : null]}
          >
            <AppText variant="micro" tone="muted" weight="700" style={styles.upper}>{s.label}</AppText>
            <AppText
              variant="small"
              weight="700"
              mono
              color={s.tone === 'bull' ? t.colors.bull : s.tone === 'bear' ? t.colors.bear : t.colors.textPrimary}
            >
              {s.value}
            </AppText>
          </View>
        ))}
      </ScrollView>

      <Segmented
        options={PERFORMANCE_RANGES.map((r) => ({ value: r.id, label: r.label }))}
        value={range}
        onChange={setRange}
        size="sm"
        style={styles.control}
      />
      <Tabs
        tabs={PERFORMANCE_METRICS.map((m) => ({ key: m.id, label: m.label }))}
        value={tab}
        onChange={setTab}
        variant="pill"
        style={styles.control}
      />

      <View style={styles.chart} onLayout={onLayout} testID="dashboard-chart-plot">
        {width > 0 ? (
          <Svg width={width} height={HEIGHT}>
            <Defs>
              <LinearGradient id="pcAreaGreen" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0%" stopColor="#16A34A" stopOpacity={0.32} />
                <Stop offset="100%" stopColor="#16A34A" stopOpacity={0.02} />
              </LinearGradient>
              <LinearGradient id="pcAreaRed" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0%" stopColor="#EF4444" stopOpacity={0.28} />
                <Stop offset="100%" stopColor="#EF4444" stopOpacity={0.02} />
              </LinearGradient>
              <LinearGradient id="pcAreaBlue" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0%" stopColor="#3B82F6" stopOpacity={0.28} />
                <Stop offset="100%" stopColor="#3B82F6" stopOpacity={0.02} />
              </LinearGradient>
              <LinearGradient id="pcBarBlue" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0%" stopColor="#3B82F6" />
                <Stop offset="100%" stopColor="#2563EB" />
              </LinearGradient>
            </Defs>

            {/* Grid lines + y labels */}
            {scale.ticks.map((v, i) => {
              const y = g.yOf(v);
              const zero = Math.abs(v) < 1e-9;
              return (
                <G key={`tick-${i}`}>
                  <Line
                    x1={PAD.left}
                    x2={width - PAD.right}
                    y1={y}
                    y2={y}
                    stroke={zero ? gridZero : gridMuted}
                    strokeWidth={1}
                    strokeDasharray={zero ? undefined : '4 4'}
                  />
                  <SvgText x={PAD.left - 8} y={y + 4} textAnchor="end" fill={axisText} fontSize={10} fontWeight="500">
                    {fmtAxis(v)}
                  </SvgText>
                </G>
              );
            })}

            {nonZero && activeTab.type === 'area' ? (
              <G>
                <Path d={area} fill={up ? 'url(#pcAreaGreen)' : 'url(#pcAreaRed)'} />
                <Path d={line} fill="none" stroke={up ? '#16A34A' : '#EF4444'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </G>
            ) : null}

            {nonZero && activeTab.type === 'curve' ? (
              <G>
                <Path d={area} fill="url(#pcAreaBlue)" />
                <Path d={line} fill="none" stroke="#3B82F6" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </G>
            ) : null}

            {nonZero && (activeTab.type === 'bar' || activeTab.type === 'histogram') ? (
              <G>
                {buckets.map((b, i) => {
                  const r = barRect(Number(b[tab] || 0), i, g);
                  if (!r) return null;
                  const dim = selected !== null && selected !== i;
                  const fill = activeTab.type === 'bar'
                    ? 'url(#pcBarBlue)'
                    // Volume tinted by the bucket's net P&L direction.
                    : (b.netProfit || 0) >= 0 ? '#16A34A' : '#EF4444';
                  const full = activeTab.type === 'bar' ? 1 : 0.92;
                  return (
                    <Rect key={b.key || `b-${i}`} x={r.x} y={r.y} width={r.width} height={r.height} rx={3} fill={fill} opacity={dim ? 0.4 : full} />
                  );
                })}
              </G>
            ) : null}

            {/* Zero baseline, when the scale crosses zero */}
            {scale.yMin < 0 ? (
              <Line x1={PAD.left} x2={width - PAD.right} y1={g.yOf(0)} y2={g.yOf(0)} stroke={gridZero} strokeWidth={1} />
            ) : null}

            {/* Selected column: guide + dot */}
            {selected !== null && hovered ? (
              <G>
                <Line
                  x1={g.cxOf(selected)}
                  x2={g.cxOf(selected)}
                  y1={PAD.top}
                  y2={HEIGHT - PAD.bottom}
                  stroke={gridZero}
                  strokeDasharray="3 4"
                  strokeWidth={1}
                />
                {activeTab.type === 'area' || activeTab.type === 'curve' ? (
                  <Circle
                    cx={g.cxOf(selected)}
                    cy={g.yOf(Number(hovered[tab] || 0))}
                    r={6}
                    fill="#FFFFFF"
                    stroke={activeTab.type === 'curve' ? '#3B82F6' : up ? '#16A34A' : '#EF4444'}
                    strokeWidth={2}
                  />
                ) : null}
              </G>
            ) : null}

            {/* X labels */}
            {xLabels.map((i) => {
              const b = buckets[i];
              if (!b) return null;
              const on = selected === i;
              return (
                <SvgText
                  key={`x-${b.key || i}`}
                  x={g.cxOf(i)}
                  y={HEIGHT - PAD.bottom + 18}
                  textAnchor="middle"
                  fill={on ? t.colors.textPrimary : axisText}
                  fontSize={10}
                  fontWeight={on ? '700' : '500'}
                >
                  {b.label}
                </SvgText>
              );
            })}
          </Svg>
        ) : null}

        {/* Tap target over the plot — the web's per-column hover areas */}
        {buckets.length ? (
          <Pressable
            accessibilityRole="adjustable"
            accessibilityLabel="Chart — tap a column for its figures"
            onPress={onTap}
            style={StyleSheet.absoluteFill}
            testID="dashboard-chart-tap"
          />
        ) : null}

        {hovered && selected !== null ? (
          <View
            pointerEvents="none"
            testID="dashboard-chart-tooltip"
            style={[
              styles.tooltip,
              {
                width: TOOLTIP_W,
                left: Math.max(0, Math.min(
                  width - TOOLTIP_W,
                  selected > buckets.length / 2 ? g.cxOf(selected) - TOOLTIP_W - 8 : g.cxOf(selected) + 8,
                )),
                backgroundColor: t.colors.surface,
                borderColor: t.colors.borderSubtle,
              },
              t.shadow.elevated,
            ]}
          >
            <AppText variant="micro" tone="muted" weight="700" style={styles.upper}>{hovered.label}</AppText>
            {tooltipLines(hovered, tab, activeTab.label).map((l) => (
              <View key={l.label} style={[styles.tipRow, l.total ? { borderTopWidth: 1, borderTopColor: t.colors.borderSubtle, paddingTop: 4 } : null]}>
                <AppText variant="caption" tone={l.total ? 'primary' : 'secondary'} weight={l.total ? '600' : '400'}>{l.label}</AppText>
                <AppText
                  variant="caption"
                  mono
                  weight={l.total || l.tone === 'primary' ? '800' : '700'}
                  color={l.tone === 'bull' ? t.colors.bull : l.tone === 'bear' ? t.colors.bear : t.colors.textPrimary}
                >
                  {l.value}
                </AppText>
              </View>
            ))}
          </View>
        ) : null}

        {loading && buckets.length === 0 ? (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
            <AppText variant="body" tone="muted">Loading…</AppText>
          </View>
        ) : null}
        {!loading && buckets.length > 0 && !nonZero ? (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
            <View style={[styles.empty, { backgroundColor: t.alpha(t.colors.surface, 0.85), borderColor: t.colors.borderSubtle }]}>
              <AppText variant="small" tone="muted" align="center">
                No data for this window — try a longer timeframe or another metric.
              </AppText>
            </View>
          </View>
        ) : null}
      </View>
    </Section>
  );
}

const styles = StyleSheet.create({
  gapBelow: { marginBottom: 24 },
  headline: { marginTop: 4 },
  strip: { marginTop: 12, borderWidth: 1, borderRadius: 12, flexGrow: 0 },
  stripCell: { paddingHorizontal: 14, paddingVertical: 6, alignItems: 'center' },
  upper: { textTransform: 'uppercase', letterSpacing: 0.6 },
  control: { marginTop: 12 },
  chart: { marginTop: 16, height: HEIGHT, width: '100%' },
  tooltip: { position: 'absolute', top: 8, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, gap: 4 },
  tipRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  center: { alignItems: 'center', justifyContent: 'center' },
  empty: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8, maxWidth: 280 },
});
