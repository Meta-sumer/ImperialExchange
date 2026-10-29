import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Line as SvgLine, Polygon, Polyline, Rect } from 'react-native-svg';

import { errorMessage } from '@/api/client';
import { copyTradingApi } from '@/api/copyTrading.api';
import { DateField } from '@/components/common/DateField';
import { shareCsv } from '@/components/orders/shareCsv';
import { AppText, Modal, toast } from '@/components/ui';
import { useTheme } from '@/theme';
import {
  ANALYTICS_PRESETS,
  analyticsPresetRange,
  copyAnalyticsCsv,
  type AnalyticsPreset,
  type CopyAnalytics,
  type CopyRelation,
  type CurvePoint,
  type PeriodPnl,
} from '@/types/copyTrading';
import { fmtMoney } from '@/utils/money';
import { subscribeCopyTrading } from '@/websocket/channels';

/**
 * Copy analytics — client/src/components/CopyAnalyticsModal.jsx: one copy
 * relation's full performance — the fee-aware P&L breakdown, net profit /
 * ROI / win rate / profit factor, the equity curve and daily P&L, the master
 * comparison, 16 metrics and the trade history with CSV export. Presets (All,
 * 7D, 30D, 90D) or a custom range; live on `user:copytrading`.
 *
 * The web's "Print / PDF" has no phone equivalent; CSV goes to the share sheet.
 */

type Preset = AnalyticsPreset | 'custom';

const pct = (n: number): string => `${(Number(n) || 0).toFixed(1)}%`;
const money = (n: number, c: string): string => fmtMoney(n, c);

export function CopyAnalyticsModal({ rel, onClose }: { rel: CopyRelation; onClose: () => void }): React.JSX.Element {
  const t = useTheme();
  const [data, setData] = useState<CopyAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [preset, setPreset] = useState<Preset>('all');
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const d = await copyTradingApi.analytics(rel.id, { from: from || undefined, to: to || undefined });
      if (mine === seq.current) setData(d);
    } catch (e) {
      if (mine === seq.current) toast.error(errorMessage(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [rel.id, from, to]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useEffect(() => subscribeCopyTrading(() => { void load(); }), [load]);
  useEffect(() => () => { seq.current += 1; }, []);

  const applyPreset = (p: AnalyticsPreset): void => {
    setPreset(p);
    const r = analyticsPresetRange(p);
    setFrom(r.from);
    setTo(r.to);
  };

  // INR-only platform — every copy-trading amount is rupees (CopyAnalyticsModal.jsx).
  const c = 'INR';

  const exportCsv = async (): Promise<void> => {
    if (!data?.trades.length) { toast.error('No trades to export'); return; }
    try {
      await shareCsv(`copy-analytics-${rel.id}.csv`, copyAnalyticsCsv(data.trades));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const title = (
    <View style={styles.flex}>
      <AppText variant="bodyStrong" weight="800" numberOfLines={1}>{`Copy analytics · ${rel.master?.displayName || 'Trader'}`}</AppText>
      <AppText variant="caption" tone="muted" numberOfLines={1}>
        {`${data?.account ? data.account.nickname || data.account.number : ''} · ${data?.status ?? ''}`}
      </AppText>
    </View>
  );

  return (
    <Modal open onClose={onClose} title={title} size="lg">
      <View style={styles.filters}>
        <View style={styles.presets}>
          {ANALYTICS_PRESETS.map((p) => {
            const on = preset === p.id;
            return (
              <Pressable
                key={p.id}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => applyPreset(p.id)}
                style={[styles.preset, { backgroundColor: on ? t.colors.primary : t.colors.bgHover }]}
              >
                <AppText variant="small" weight="600" color={on ? t.colors.onPrimary : t.colors.textSecondary}>{p.label}</AppText>
              </Pressable>
            );
          })}
        </View>
        <View style={styles.range}>
          <DateField label="From" value={from} onChange={(v) => { setPreset('custom'); setFrom(v); }} max={to || undefined} />
          <AppText variant="small" tone="muted">→</AppText>
          <DateField label="To" value={to} onChange={(v) => { setPreset('custom'); setTo(v); }} min={from || undefined} />
        </View>
      </View>

      {loading || !data ? (
        <AppText variant="body" tone="muted" align="center" style={styles.loading}>Loading…</AppText>
      ) : (
        <View style={styles.stack}>
          <View style={[styles.card, { borderColor: t.colors.borderDark, backgroundColor: t.alpha(t.colors.bgHover, 0.4) }]}>
            <AppText variant="micro" weight="700" tone="muted" style={styles.caps}>P&amp;L BREAKDOWN</AppText>
            <Line label="Gross profit" value={money(data.grossProfit, c)} tone="bull" />
            <Line label="Performance fee" value={`-${money(data.performanceFeePaid, c)}`} tone="bear" />
            <Line label="Commission" value={`-${money(data.commission, c)}`} tone="bear" />
            <Line label="Swap" value={`-${money(data.swap, c)}`} tone="bear" />
            <View style={[styles.divider, { borderTopColor: t.colors.borderDark }]}>
              <Line label="Net profit" value={money(data.netProfit, c)} tone={data.netProfit >= 0 ? 'bull' : 'bear'} bold />
            </View>
          </View>

          <View style={styles.grid2}>
            <Kpi label="Net profit" value={money(data.netProfit, c)} tone={data.netProfit >= 0 ? 'bull' : 'bear'} big />
            <Kpi label="ROI" value={pct(data.roi)} tone={data.roi >= 0 ? 'bull' : 'bear'} big />
            <Kpi label="Win rate" value={pct(data.winRate)} />
            <Kpi label="Profit factor" value={data.profitFactor === null ? '∞' : String(data.profitFactor)} />
          </View>

          <Panel title="Equity curve (cumulative net)"><EquityChart data={data.curve} /></Panel>
          <Panel title="Daily P&L"><PnlBars data={data.daily} /></Panel>

          {data.master ? (
            <Panel title={`Comparison with master · ${data.master.displayName}`}>
              <View style={styles.compare}>
                <View style={styles.compareCell}>
                  <AppText variant="micro" weight="700" tone="muted">YOU</AppText>
                  <AppText variant="small" weight="700" align="center">{`ROI ${pct(data.roi)} · Win ${pct(data.winRate)} · ${data.closedTrades} trades`}</AppText>
                </View>
                <View style={styles.compareCell}>
                  <AppText variant="micro" weight="700" tone="muted">MASTER</AppText>
                  <AppText variant="small" weight="700" align="center">
                    {`ROI ${pct(data.master.roiPct)} · Win ${pct(data.master.winRate)} · ${data.master.totalTrades} trades`}
                  </AppText>
                </View>
              </View>
            </Panel>
          ) : null}

          <View style={styles.grid2}>
            <Kpi label="Total trades" value={String(data.totalTrades)} />
            <Kpi label="Closed" value={String(data.closedTrades)} />
            <Kpi label="Open" value={String(data.openTrades)} />
            <Kpi label="Success rate" value={pct(data.successRate)} />
            <Kpi label="Avg win" value={money(data.avgWin, c)} tone="bull" />
            <Kpi label="Avg loss" value={money(data.avgLoss, c)} tone="bear" />
            <Kpi label="Largest win" value={money(data.largestWin, c)} tone="bull" />
            <Kpi label="Largest loss" value={money(data.largestLoss, c)} tone="bear" />
            <Kpi label="Risk / reward" value={String(data.riskReward)} />
            <Kpi label="Recovery factor" value={String(data.recoveryFactor)} />
            <Kpi label="Sharpe" value={data.sharpe === null ? '—' : String(data.sharpe)} />
            <Kpi label="Max drawdown" value={money(data.maxDrawdown, c)} tone="bear" />
            <Kpi label="Current equity" value={money(data.currentEquity, c)} />
            <Kpi label="Max equity" value={money(data.maxEquity, c)} />
            <Kpi label="Total lots" value={String(data.totalLots)} />
            <Kpi label="Avg holding" value={`${data.avgHoldingMinutes} min`} />
          </View>

          <Panel
            title={`Trade history (${data.trades.length})`}
            action={(
              <Pressable accessibilityRole="button" onPress={() => { void exportCsv(); }} hitSlop={6}>
                <AppText variant="small" weight="600" color={t.colors.primaryText}>Export CSV</AppText>
              </Pressable>
            )}
          >
            {data.trades.length === 0 ? (
              <AppText variant="small" tone="muted" align="center" style={styles.empty}>No closed trades</AppText>
            ) : (
              data.trades.map((tr, i) => (
                <View
                  key={tr.id || `${tr.symbol}-${i}`}
                  style={[styles.trade, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.borderDark } : null]}
                >
                  <View style={styles.flex}>
                    <AppText variant="small" weight="600">
                      {tr.symbol}
                      <AppText variant="small" color={tr.side === 'BUY' ? t.colors.bull : t.colors.bear}>{`  ${tr.side}`}</AppText>
                    </AppText>
                    <AppText variant="micro" tone="secondary">
                      {`${tr.closedAt ? new Date(tr.closedAt).toLocaleDateString() : '—'} · qty ${tr.qty}`}
                    </AppText>
                  </View>
                  <View style={styles.alignEnd}>
                    <AppText variant="small" weight="600" mono color={tr.pnl >= 0 ? t.colors.bull : t.colors.bear}>{money(tr.pnl, c)}</AppText>
                    <AppText variant="micro" mono tone="muted">{`comm ${money(tr.commission, c)}`}</AppText>
                  </View>
                </View>
              ))
            )}
          </Panel>
        </View>
      )}
    </Modal>
  );
}

function Kpi({ label, value, tone, big = false }: { label: string; value: string; tone?: 'bull' | 'bear'; big?: boolean }): React.JSX.Element {
  const t = useTheme();
  const color = tone === 'bull' ? t.colors.bull : tone === 'bear' ? t.colors.bear : t.colors.textPrimary;
  return (
    <View style={[styles.kpi, { borderColor: t.colors.borderDark, backgroundColor: t.colors.surface }]}>
      <AppText variant="micro" weight="700" tone="muted" numberOfLines={1}>{label.toUpperCase()}</AppText>
      <AppText variant={big ? 'title' : 'small'} weight="800" mono color={color} numberOfLines={1} adjustsFontSizeToFit>{value}</AppText>
    </View>
  );
}

function Line({ label, value, tone, bold = false }: { label: string; value: string; tone?: 'bull' | 'bear'; bold?: boolean }): React.JSX.Element {
  const t = useTheme();
  const color = tone === 'bull' ? t.colors.bull : tone === 'bear' ? t.colors.bear : t.colors.textPrimary;
  return (
    <View style={styles.line}>
      <AppText variant="body" weight={bold ? '700' : '400'} tone={bold ? 'primary' : 'secondary'}>{label}</AppText>
      <AppText variant="body" weight={bold ? '800' : '600'} mono color={color}>{value}</AppText>
    </View>
  );
}

function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[styles.card, { borderColor: t.colors.borderDark, backgroundColor: t.colors.surface }]}>
      <View style={styles.panelHead}>
        <AppText variant="micro" weight="700" tone="muted" style={[styles.caps, styles.flex]}>{title.toUpperCase()}</AppText>
        {action}
      </View>
      {children}
    </View>
  );
}

function EquityChart({ data }: { data: readonly CurvePoint[] }): React.JSX.Element {
  const t = useTheme();
  if (!data.length) return <AppText variant="small" tone="muted" align="center" style={styles.empty}>No closed trades yet</AppText>;
  const W = 600;
  const H = 160;
  const P = 10;
  const ys = data.map((d) => d.equity);
  const min = Math.min(0, ...ys);
  const max = Math.max(0, ...ys);
  const range = max - min || 1;
  const x = (i: number): number => P + (i / Math.max(1, data.length - 1)) * (W - 2 * P);
  const y = (v: number): number => P + (1 - (v - min) / range) * (H - 2 * P);
  const pts = data.map((d, i) => `${x(i)},${y(d.equity)}`).join(' ');
  const area = `${x(0)},${y(0)} ${pts} ${x(data.length - 1)},${y(0)}`;
  const up = (ys[ys.length - 1] ?? 0) >= 0;
  const stroke = up ? '#10b981' : '#ef4444';
  return (
    <Svg width="100%" height={160} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <Polygon points={area} fill={up ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)'} />
      <SvgLine x1={P} y1={y(0)} x2={W - P} y2={y(0)} stroke={t.colors.borderDark} strokeWidth={0.5} strokeDasharray="3 3" />
      <Polyline points={pts} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" />
    </Svg>
  );
}

function PnlBars({ data }: { data: readonly PeriodPnl[] }): React.JSX.Element {
  const t = useTheme();
  if (!data.length) return <AppText variant="small" tone="muted" align="center" style={styles.empty}>No P&amp;L data</AppText>;
  const W = 600;
  const H = 140;
  const P = 10;
  const max = Math.max(1, ...data.map((d) => Math.abs(d.pnl)));
  const bw = (W - 2 * P) / data.length;
  const zeroY = H / 2;
  const scale = (H / 2 - P) / max;
  return (
    <Svg width="100%" height={140} viewBox={`0 0 ${W} ${H}`}>
      <SvgLine x1={P} y1={zeroY} x2={W - P} y2={zeroY} stroke={t.colors.borderDark} strokeWidth={0.5} />
      {data.map((d, i) => {
        const h = Math.max(1, Math.abs(d.pnl) * scale);
        const xx = P + i * bw + bw * 0.15;
        const yy = d.pnl >= 0 ? zeroY - h : zeroY;
        // eslint-disable-next-line react/no-array-index-key
        return <Rect key={i} x={xx} y={yy} width={bw * 0.7} height={h} rx={1} fill={d.pnl >= 0 ? '#10b981' : '#ef4444'} />;
      })}
    </Svg>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  alignEnd: { alignItems: 'flex-end' },
  stack: { gap: 16, marginTop: 16 },
  filters: { gap: 8 },
  presets: { flexDirection: 'row', gap: 6 },
  preset: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 6 },
  range: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  loading: { paddingVertical: 64 },
  card: { borderWidth: 1, borderRadius: 12, padding: 14 },
  caps: { letterSpacing: 0.8 },
  divider: { borderTopWidth: 1, marginTop: 8, paddingTop: 8 },
  line: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 2 },
  grid2: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  kpi: { width: '48%', flexGrow: 1, borderWidth: 1, borderRadius: 10, padding: 10 },
  panelHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 },
  compare: { flexDirection: 'row', gap: 12, paddingVertical: 4 },
  compareCell: { flex: 1, alignItems: 'center', gap: 2 },
  empty: { paddingVertical: 24 },
  trade: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
});
