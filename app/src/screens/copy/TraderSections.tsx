import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Image, Pressable, StyleSheet, View, type DimensionValue } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import Svg, { Line as SvgLine, Path } from 'react-native-svg';

import { copyTradingApi } from '@/api/copyTrading.api';
import { DateField } from '@/components/common/DateField';
import { AppText, Button, toast } from '@/components/ui';
import { useTheme } from '@/theme';
import {
  EQUITY_RANGES,
  HISTORY_PERIODS,
  earningsGate,
  transferErrorText,
  RISK_TONE,
  equityRangeSummary,
  filterEquityCurve,
  fmtAumCompact,
  fmtDuration,
  traderRelTime,
  type ChartPoint,
  type EarningEvent,
  type DistributionBucket,
  type EquityPoint,
  type EquityRange,
  type HistoryPeriod,
  type Paged,
  type RiskBadge,
  type TraderAnalytics,
  type TraderClosedTrade,
  type TraderOpenPosition,
} from '@/types/copyTrading';
import { fmtMoney, fmtSigned } from '@/utils/money';
import { subscribeTickers } from '@/websocket/channels';

/**
 * The Trader Dashboard's sections — client/src/pages/TraderDashboard.jsx.
 * Every label is the web's; every figure is the server's analytics, except
 * the open positions' running P&L, which the web too re-marks live from the
 * ticker feed between its 5 s polls.
 */

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
/** TraderDashboard.jsx `usd` — every copy-trading figure is rupees: ₹1,23,456.78, -₹12.30. */
export const usd = (v: unknown): string => fmtMoney(n(v));
export const pct = (v: unknown): string => `${n(v) >= 0 ? '+' : ''}${n(v).toFixed(2)}%`;
/** TraderDashboard.jsx `signed` — +₹12.30 / -₹4.00 ("+" at zero). */
const signed = (v: unknown, d = 2): string => fmtSigned(n(v), d);
const riskOf = (tier: string | null | undefined) => RISK_TONE[(tier as RiskBadge) ?? 'MEDIUM'] ?? RISK_TONE.MEDIUM;

const W = (a: number): string => `rgba(255,255,255,${a})`;

/* ── Hero ────────────────────────────────────────────────────────────── */

export function TraderHero({ d, isSelf, onCopy, onBack }: { d: TraderAnalytics; isSelf: boolean; onCopy: () => void; onBack: () => void }): React.JSX.Element {
  const tr = d.trader;
  const rt = riskOf(tr.riskBadge);
  const roi = d.performance.totalROI;
  return (
    <View style={styles.hero}>
      <View style={styles.heroTop}>
        <View style={styles.heroAvatar}>
          {tr.avatarUrl ? (
            <Image source={{ uri: tr.avatarUrl }} style={styles.heroAvatarImg} accessibilityLabel={tr.displayName} />
          ) : (
            <AppText style={styles.heroInitials} color="#FFFFFF">{(tr.displayName || 'T').slice(0, 2).toUpperCase()}</AppText>
          )}
        </View>
        <View style={styles.flex}>
          <View style={[styles.row, styles.wrap]}>
            <AppText variant="h3" weight="800" color="#FFFFFF" numberOfLines={1} style={styles.shrink}>{tr.displayName}</AppText>
            {tr.verified ? (
              <View style={[styles.pill, { backgroundColor: 'rgba(59,130,246,0.3)', borderColor: 'rgba(147,197,253,0.5)', borderWidth: 1 }]}>
                <AppText variant="micro" weight="700" color="#FFFFFF">★ VERIFIED</AppText>
              </View>
            ) : null}
            <View style={[styles.pill, { backgroundColor: tr.activeStatus ? 'rgba(16,185,129,0.25)' : W(0.1) }]}>
              <AppText variant="micro" weight="700" color={tr.activeStatus ? '#FFFFFF' : W(0.6)}>{tr.activeStatus ? '● ACTIVE' : 'INACTIVE'}</AppText>
            </View>
          </View>
          <View style={[styles.row, styles.wrap, styles.mt4]}>
            {tr.tradingStyle ? <AppText variant="caption" color={W(0.75)}>{tr.tradingStyle}</AppText> : null}
            <AppText variant="caption" color={W(0.75)}>{`· Joined ${tr.joinedAt ? new Date(tr.joinedAt).toLocaleDateString() : '—'}`}</AppText>
            {tr.country ? <AppText variant="caption" color={W(0.75)}>{`· ${tr.country}`}</AppText> : null}
            <View style={[styles.pill, { backgroundColor: rt.bg }]}>
              <AppText variant="micro" weight="700" color={rt.fg}>{`Risk ${tr.riskScore ?? '—'}/10`}</AppText>
            </View>
          </View>
        </View>
      </View>
      {tr.bio ? <AppText variant="body" color={W(0.7)}>{tr.bio}</AppText> : null}
      <View style={styles.heroStats}>
        <HeroStat label="Followers" value={tr.followers.toLocaleString()} />
        <HeroStat label="AUM" value={fmtAumCompact(tr.aum)} />
        <HeroStat label="Total ROI" value={pct(roi)} accent={n(roi) >= 0 ? '#34D399' : '#F87171'} />
      </View>
      {isSelf ? (
        <Pressable accessibilityRole="link" onPress={onBack} style={[styles.heroBtn, { backgroundColor: W(0.12), borderColor: W(0.2), borderWidth: 1 }]}>
          <AppText variant="bodyStrong" weight="700" color="#FFFFFF">Your profile</AppText>
        </Pressable>
      ) : (
        <Pressable accessibilityRole="button" onPress={onCopy} style={[styles.heroBtn, { backgroundColor: '#2563EB' }]}>
          <AppText variant="bodyStrong" weight="700" color="#FFFFFF">Copy Trader</AppText>
        </Pressable>
      )}
    </View>
  );
}

function HeroStat({ label, value, accent }: { label: string; value: string; accent?: string }): React.JSX.Element {
  return (
    <View style={styles.flex}>
      <AppText variant="micro" weight="700" color={W(0.5)}>{label.toUpperCase()}</AppText>
      <AppText variant="title" weight="800" mono color={accent ?? '#FFFFFF'} numberOfLines={1} adjustsFontSizeToFit>{value}</AppText>
    </View>
  );
}

/* ── Headline cards ──────────────────────────────────────────────────── */

const TINT = { green: '#16A34A', red: '#DC2626', blue: '#2563EB', violet: '#7C3AED' } as const;

export function HeadlineCards({ d }: { d: TraderAnalytics }): React.JSX.Element {
  const pf = d.performance;
  const f = d.followers;
  return (
    <View style={styles.grid2}>
      <Headline label="Total ROI" value={pct(pf.totalROI)} color={n(pf.totalROI) >= 0 ? TINT.green : TINT.red} sub={`${usd(pf.totalPnL)} net`} />
      <Headline label="Followers" value={f.total.toLocaleString()} color={TINT.blue} sub={`${f.active} active`} />
      <Headline label="Copied AUM" value={fmtAumCompact(d.trader.aum)} color={TINT.violet} sub={`${f.copiedTrades} copied trades`} />
      <RiskCard risk={d.risk} />
    </View>
  );
}

function Headline({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[styles.cell, { borderColor: t.colors.borderDark, backgroundColor: t.colors.surface }]}>
      <AppText variant="micro" weight="700" tone="muted">{label.toUpperCase()}</AppText>
      <AppText variant="h3" weight="800" mono color={color} numberOfLines={1} adjustsFontSizeToFit style={styles.mt4}>{value}</AppText>
      {sub ? <AppText variant="caption" tone="muted">{sub}</AppText> : null}
    </View>
  );
}

function RiskCard({ risk }: { risk: TraderAnalytics['risk'] }): React.JSX.Element {
  const t = useTheme();
  const rt = riskOf(risk.riskTier);
  const score = n(risk.riskScore);
  return (
    <View style={[styles.cell, { borderColor: `${rt.fg}55`, backgroundColor: t.colors.surface }]}>
      <AppText variant="micro" weight="700" tone="muted">RISK SCORE</AppText>
      <View style={[styles.row, styles.mt4]}>
        <AppText variant="h3" weight="800" color={rt.fg}>
          {String(risk.riskScore ?? '—')}
          <AppText variant="body" weight="700" tone="muted">/10</AppText>
        </AppText>
        <View style={[styles.pill, { backgroundColor: rt.bg }]}>
          <AppText variant="micro" weight="700" color={rt.fg}>{rt.label.toUpperCase()}</AppText>
        </View>
      </View>
      <View style={[styles.track, { backgroundColor: t.colors.bgHover }]}>
        <View style={[styles.fill, { width: `${Math.max(0, Math.min(100, score * 10))}%` as DimensionValue, backgroundColor: rt.fg }]} />
      </View>
    </View>
  );
}

/* ── Equity curve ────────────────────────────────────────────────────── */

export function EquityCurveCard({ series, initialEquity }: { series: readonly EquityPoint[]; initialEquity: number | null }): React.JSX.Element {
  const t = useTheme();
  const [range, setRange] = useState<EquityRange>('ALL');
  const shown = useMemo(() => filterEquityCurve(series, range), [series, range]);
  const { last, changePct } = equityRangeSummary(shown, initialEquity);
  return (
    <Card>
      <View style={styles.rowTop}>
        <View style={styles.flex}>
          <AppText variant="bodyStrong" weight="700">Equity Curve</AppText>
          <AppText variant="caption" tone="muted">{`Account growth from ${usd(initialEquity)} base`}</AppText>
        </View>
        <View style={styles.alignEnd}>
          <AppText variant="title" weight="800" mono>{usd(last)}</AppText>
          <AppText variant="caption" weight="700" color={changePct >= 0 ? t.colors.bull : t.colors.bear}>
            {pct(changePct)}
            <AppText variant="caption" tone="muted">{` (${range})`}</AppText>
          </AppText>
        </View>
      </View>
      <View style={[styles.row, styles.wrap, styles.mt8]}>
        {EQUITY_RANGES.map((r) => (
          <Chip key={r} label={r} on={range === r} onPress={() => setRange(r)} />
        ))}
      </View>
      <AreaChart data={shown.map((p) => p.equity)} baseline={initialEquity} />
    </Card>
  );
}

function AreaChart({ data, baseline }: { data: readonly number[]; baseline: number | null }): React.JSX.Element {
  const t = useTheme();
  if (data.length < 2) return <AppText variant="small" tone="muted" align="center" style={styles.chartEmpty}>Not enough data yet.</AppText>;
  const Wd = 600;
  const H = 160;
  const P = 4;
  const min = Math.min(...data, baseline ?? Infinity);
  const max = Math.max(...data, baseline ?? -Infinity);
  const span = Math.max(max - min, 1);
  const stepX = (Wd - P * 2) / (data.length - 1);
  const y = (v: number): number => H - P - ((v - min) / span) * (H - P * 2);
  const pts = data.map((v, i) => [P + i * stepX, y(v)] as const);
  const up = (data[data.length - 1] ?? 0) >= (data[0] ?? 0);
  const stroke = up ? '#16A34A' : '#DC2626';
  const fill = up ? 'rgba(22,163,74,0.12)' : 'rgba(220,38,38,0.12)';
  const line = pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const lastPt = pts[pts.length - 1] ?? [P, H - P];
  const firstPt = pts[0] ?? [P, H - P];
  const area = `${line} L ${lastPt[0].toFixed(1)} ${H - P} L ${firstPt[0].toFixed(1)} ${H - P} Z`;
  return (
    <Svg width="100%" height={170} viewBox={`0 0 ${Wd} ${H}`} preserveAspectRatio="none" style={styles.mt8}>
      {baseline !== null && baseline >= min && baseline <= max ? (
        <SvgLine x1={P} x2={Wd - P} y1={y(baseline)} y2={y(baseline)} stroke={t.colors.textMuted} strokeWidth={1} strokeDasharray="3 3" opacity={0.5} />
      ) : null}
      <Path d={area} fill={fill} />
      <Path d={line} fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/* ── Performance + risk metrics ──────────────────────────────────────── */

type Tone = 'bull' | 'bear' | undefined;

export function PerformanceMetrics({ pf }: { pf: TraderAnalytics['performance'] }): React.JSX.Element {
  const items: { label: string; value: string; tone?: Tone }[] = [
    { label: 'Total ROI', value: pct(pf.totalROI), tone: n(pf.totalROI) >= 0 ? 'bull' : 'bear' },
    { label: 'Monthly ROI', value: pct(pf.monthlyROI), tone: n(pf.monthlyROI) >= 0 ? 'bull' : 'bear' },
    { label: 'Weekly ROI', value: pct(pf.weeklyROI), tone: n(pf.weeklyROI) >= 0 ? 'bull' : 'bear' },
    { label: 'Daily ROI', value: pct(pf.dailyROI), tone: n(pf.dailyROI) >= 0 ? 'bull' : 'bear' },
    { label: 'Total P/L', value: usd(pf.totalPnL), tone: n(pf.totalPnL) >= 0 ? 'bull' : 'bear' },
    { label: 'Win Rate', value: `${n(pf.winRate).toFixed(1)}%` },
    { label: 'Total Trades', value: String(pf.totalTrades) },
    { label: 'Winning Trades', value: String(pf.wins), tone: 'bull' },
    { label: 'Losing Trades', value: String(pf.losses), tone: 'bear' },
    { label: 'Avg Trade Profit', value: usd(pf.avgWin), tone: 'bull' },
    { label: 'Avg Trade Loss', value: usd(pf.avgLoss), tone: 'bear' },
    { label: 'Profit Factor', value: n(pf.profitFactor) >= 999 ? '∞' : n(pf.profitFactor).toFixed(2) },
    { label: 'Avg Trade Duration', value: fmtDuration(pf.avgDurationMs) },
  ];
  return (
    <Card>
      <AppText variant="bodyStrong" weight="700" style={styles.mb12}>Performance Metrics</AppText>
      <MetricGrid items={items} />
    </Card>
  );
}

export function RiskAnalytics({ risk }: { risk: TraderAnalytics['risk'] }): React.JSX.Element {
  const rt = riskOf(risk.riskTier);
  const items: { label: string; value: string; color?: string }[] = [
    { label: 'Risk Score', value: `${risk.riskScore ?? '—'}/10`, color: rt.fg },
    { label: 'Max Drawdown', value: `${n(risk.maxDrawdownPct).toFixed(2)}%`, color: '#DC2626' },
    { label: 'Avg Drawdown', value: `${n(risk.avgDrawdownPct).toFixed(2)}%`, color: '#D97706' },
    { label: 'Sharpe Ratio', value: n(risk.sharpe).toFixed(2) },
    { label: 'Recovery Factor', value: n(risk.recoveryFactor) >= 999 ? '∞' : n(risk.recoveryFactor).toFixed(2) },
    { label: 'Avg Leverage', value: `${n(risk.avgLeverage).toFixed(1)}×` },
    { label: 'Stop-Loss Usage', value: `${n(risk.slUsagePct).toFixed(0)}%` },
    { label: 'Max Consecutive Wins', value: String(risk.maxWinStreak), color: '#16A34A' },
    { label: 'Max Consecutive Losses', value: String(risk.maxLossStreak), color: '#DC2626' },
  ];
  return (
    <Card>
      <View style={[styles.row, styles.mb12]}>
        <AppText variant="bodyStrong" weight="700" style={styles.flex}>Risk Analytics</AppText>
        <View style={[styles.pill, { backgroundColor: rt.bg }]}>
          <AppText variant="micro" weight="700" color={rt.fg}>{rt.label.toUpperCase()}</AppText>
        </View>
      </View>
      <MetricGrid items={items} />
    </Card>
  );
}

function MetricGrid({ items }: { items: { label: string; value: string; tone?: Tone; color?: string }[] }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={styles.grid2}>
      {items.map((m) => (
        <View key={m.label} style={[styles.metric, { backgroundColor: t.alpha(t.colors.bgHover, 0.4), borderColor: t.colors.borderSubtle }]}>
          <AppText variant="micro" weight="700" tone="muted" numberOfLines={1}>{m.label.toUpperCase()}</AppText>
          <AppText
            variant="bodyStrong"
            weight="800"
            mono
            numberOfLines={1}
            adjustsFontSizeToFit
            color={m.color ?? (m.tone === 'bull' ? t.colors.bull : m.tone === 'bear' ? t.colors.bear : t.colors.textPrimary)}
          >
            {m.value}
          </AppText>
        </View>
      ))}
    </View>
  );
}

/* ── Period bars + distribution ──────────────────────────────────────── */

export function BarChartCard({ title, sub, data }: { title: string; sub: string; data: readonly ChartPoint[] }): React.JSX.Element {
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  return (
    <Card>
      <AppText variant="bodyStrong" weight="700">{title}</AppText>
      <AppText variant="caption" tone="muted" style={styles.mb12}>{sub}</AppText>
      {!data.length ? (
        <AppText variant="small" tone="muted" align="center" style={styles.chartEmpty}>No data yet.</AppText>
      ) : (
        <>
          <View style={styles.bars}>
            {data.map((d, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <View key={i} style={styles.barCol}>
                <View style={[styles.bar, { height: `${Math.max(2, (Math.abs(d.value) / max) * 100)}%` as DimensionValue, backgroundColor: d.value >= 0 ? '#16A34A' : '#DC2626' }]} />
              </View>
            ))}
          </View>
          <View style={styles.axis}>
            {data.map((d, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <AppText key={i} variant="micro" tone="muted" align="center" numberOfLines={1} style={styles.flex}>{d.label}</AppText>
            ))}
          </View>
        </>
      )}
    </Card>
  );
}

export function DistributionCard({ data }: { data: readonly DistributionBucket[] }): React.JSX.Element {
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <Card>
      <AppText variant="bodyStrong" weight="700">Profit Distribution</AppText>
      <AppText variant="caption" tone="muted" style={styles.mb12}>Trades by PnL bucket (INR)</AppText>
      {!data.length ? (
        <AppText variant="small" tone="muted" align="center" style={styles.chartEmpty}>No trades yet.</AppText>
      ) : (
        <>
          <View style={styles.bars}>
            {data.map((d, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <View key={i} style={styles.barCol}>
                <AppText variant="micro" weight="700" tone="secondary">{String(d.count)}</AppText>
                <View style={[styles.bar, { maxWidth: 40, height: `${Math.max(2, (d.count / max) * 90)}%` as DimensionValue, backgroundColor: d.positive ? '#16A34A' : '#DC2626' }]} />
              </View>
            ))}
          </View>
          <View style={styles.axis}>
            {data.map((d, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <AppText key={i} variant="micro" tone="muted" align="center" numberOfLines={1} style={styles.flex}>{d.bucket}</AppText>
            ))}
          </View>
        </>
      )}
    </Card>
  );
}

/* ── Open positions (live) ───────────────────────────────────────────── */

export function OpenPositionsCard({ traderId, accountId }: { traderId: string; accountId: string | null }): React.JSX.Element {
  const t = useTheme();
  const focused = useIsFocused();
  const [rows, setRows] = useState<TraderOpenPosition[]>([]);
  const [live, setLive] = useState<Record<string, number>>({});
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    if (!focused) return undefined;
    const load = (): void => {
      copyTradingApi.traderPositions(traderId, accountId)
        .then((r) => { if (alive.current) setRows(r); })
        .catch(() => { /* keep prior */ });
    };
    load();
    const id = setInterval(() => { if (AppState.currentState === 'active') load(); }, 5000);
    return () => clearInterval(id);
  }, [traderId, accountId, focused]);

  const symbolsKey = useMemo(() => [...new Set(rows.map((r) => r.symbol))].sort().join('|'), [rows]);
  useEffect(() => {
    if (!focused || !symbolsKey) return undefined;
    return subscribeTickers(symbolsKey.split('|').filter(Boolean), (tick) => {
      const p = Number(tick.lastPrice);
      if (!Number.isFinite(p) || p <= 0 || !tick.symbol) return;
      const sym = tick.symbol.toUpperCase();
      setLive((prev) => (prev[sym] === p ? prev : { ...prev, [sym]: p }));
    });
  }, [symbolsKey, focused]);

  const computed = rows.map((r) => {
    const cur = live[r.symbol.toUpperCase()] ?? n(r.currentPrice);
    const dir = r.side === 'BUY' ? 1 : -1;
    return { r, cur, pnl: (cur - n(r.entryPrice)) * n(r.quantity) * dir };
  });

  return (
    <Card padded={false}>
      <View style={[styles.cardHead, { borderBottomColor: t.colors.borderSubtle }]}>
        <View style={styles.row}>
          <AppText variant="bodyStrong" weight="700">Open Positions</AppText>
          <View style={[styles.liveDot, { backgroundColor: t.colors.bull }]} />
          <AppText variant="micro" weight="600" tone="muted">LIVE</AppText>
        </View>
        <AppText variant="caption" tone="muted">{`${computed.length} open`}</AppText>
      </View>
      {computed.length === 0 ? (
        <AppText variant="body" tone="muted" align="center" style={styles.pad}>No open positions right now.</AppText>
      ) : computed.map(({ r, cur, pnl }, i) => {
        const prec = Math.min(r.pricePrecision || 2, 6);
        return (
          <View key={r.id || `${r.symbol}-${i}`} style={[styles.item, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.borderSubtle } : null]}>
            <View style={styles.row}>
              <AppText variant="bodyStrong" style={styles.flex} numberOfLines={1}>{r.symbol}</AppText>
              <SideChip side={r.side} />
              <AppText variant="bodyStrong" weight="700" mono color={pnl >= 0 ? t.colors.bull : t.colors.bear}>{signed(pnl)}</AppText>
            </View>
            <View style={styles.row}>
              <Mini label="Entry" value={n(r.entryPrice).toFixed(prec)} />
              <Mini label="Current" value={n(cur).toFixed(prec)} />
              <Mini label="Size" value={String(n(r.quantity))} />
              <Mini label="Open" value={traderRelTime(r.openedAt)} />
            </View>
          </View>
        );
      })}
    </Card>
  );
}

/* ── Trade history ───────────────────────────────────────────────────── */

export function TradeHistoryCard({ traderId, accountId }: { traderId: string; accountId: string | null }): React.JSX.Element {
  const t = useTheme();
  const [period, setPeriod] = useState<HistoryPeriod>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<TraderClosedTrade>>({ items: [], total: 0, page: 1, limit: 10, pages: 1 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    copyTradingApi.traderHistory(traderId, { period, page, limit: 10, from, to, accountId })
      .then((r) => { if (!cancelled) setData(r); })
      .catch(() => { /* keep what is shown */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [traderId, period, page, from, to, accountId]);

  return (
    <Card padded={false}>
      <View style={[styles.cardHeadCol, { borderBottomColor: t.colors.borderSubtle }]}>
        <AppText variant="bodyStrong" weight="700">Trade History</AppText>
        <View style={[styles.row, styles.wrap]}>
          {HISTORY_PERIODS.map((p) => (
            <Chip key={p.k} label={p.label} on={period === p.k} onPress={() => { setPeriod(p.k); setPage(1); }} />
          ))}
        </View>
      </View>
      {period === 'custom' ? (
        <View style={[styles.customRange, { borderBottomColor: t.colors.borderSubtle }]}>
          <DateField label="From" value={from} onChange={(v) => { setFrom(v); setPage(1); }} max={to || undefined} />
          <DateField label="To" value={to} onChange={(v) => { setTo(v); setPage(1); }} min={from || undefined} />
          {from || to ? <Button title="Clear" variant="ghost" size="sm" onPress={() => { setFrom(''); setTo(''); setPage(1); }} /> : null}
        </View>
      ) : null}
      {loading ? (
        <AppText variant="body" tone="muted" align="center" style={styles.pad}>Loading…</AppText>
      ) : data.items.length === 0 ? (
        <AppText variant="body" tone="muted" align="center" style={styles.pad}>No closed trades in this period.</AppText>
      ) : (
        <>
          {data.items.map((tr, i) => (
            <View key={tr.id || `${tr.symbol}-${i}`} style={[styles.item, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.borderSubtle } : null]}>
              <View style={styles.row}>
                <AppText variant="bodyStrong" style={styles.flex} numberOfLines={1}>{tr.symbol}</AppText>
                <SideChip side={tr.side} />
                <AppText variant="bodyStrong" weight="700" mono color={n(tr.realizedPnl) >= 0 ? t.colors.bull : t.colors.bear}>{signed(tr.realizedPnl)}</AppText>
              </View>
              <View style={styles.row}>
                <Mini label="Date" value={tr.closedAt ? new Date(tr.closedAt).toLocaleDateString() : '—'} />
                <Mini label="Entry" value={n(tr.entryPrice).toFixed(4)} />
                <Mini label="Exit" value={tr.exitPrice !== null ? n(tr.exitPrice).toFixed(4) : '—'} />
                <Mini label="Duration" value={fmtDuration(tr.durationMs)} />
              </View>
            </View>
          ))}
          <View style={[styles.pager, { borderTopColor: t.colors.borderSubtle }]}>
            <AppText variant="caption" tone="muted">{`${data.total} trades · page ${data.page}/${data.pages || 1}`}</AppText>
            <View style={styles.row}>
              <Button title="Prev" variant="secondary" size="sm" disabled={page <= 1} onPress={() => setPage((p) => Math.max(1, p - 1))} />
              <Button title="Next" variant="secondary" size="sm" disabled={page >= (data.pages || 1)} onPress={() => setPage((p) => p + 1)} />
            </View>
          </View>
        </>
      )}
    </Card>
  );
}

/* ── Earnings, followers, copy panel ─────────────────────────────────── */

/**
 * TraderDashboard.jsx MasterEarnings — the owner's performance-fee rollup:
 * what was charged, what sits in escrow, what this month's gate blocks,
 * "Transfer Commission" to the Bonus Wallet, and the last 25 fee events.
 * `onTransferred` re-reads the dashboard — the web reloads the page.
 */
export function MasterEarnings({
  e,
  onTransferred,
}: {
  e: TraderAnalytics['earnings'];
  onTransferred: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const [transferring, setTransferring] = useState(false);
  const [history, setHistory] = useState<EarningEvent[]>([]);
  const [histLoading, setHistLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    copyTradingApi.myEarnings(25)
      .then((r) => { if (alive) setHistory(r?.history ?? []); })
      .catch(() => { if (alive) setHistory([]); })
      .finally(() => { if (alive) setHistLoading(false); });
    return () => { alive = false; };
  }, []);

  const g = earningsGate(e);

  const handleTransfer = async (): Promise<void> => {
    if (transferring) return;
    setTransferring(true);
    try {
      const r = await copyTradingApi.transferCommission();
      toast.success(`${usd(r.transferred)} commission transferred to Main Wallet!`);
      onTransferred();
    } catch (err) {
      toast.error(transferErrorText(err));
    } finally {
      setTransferring(false);
    }
  };

  const items: { label: string; value: string; tone?: Tone | 'amber'; help?: string }[] = [
    { label: 'Total Commission Earned', value: usd(e.total), tone: 'bull', help: `All fees charged since start · ${e.count || 0} fee event(s)` },
    { label: 'Pending Release', value: usd(g.pending), tone: g.pending > 0 ? 'amber' : undefined, help: 'Sitting in escrow — what "Transfer Commission" would move' },
    { label: 'Earned This Month', value: usd(e.month), tone: n(e.month) > 0 ? 'bull' : undefined, help: 'Fees charged this calendar month' },
    { label: 'Blocked (Monthly Gate)', value: usd(g.blocked), tone: g.blocked > 0 ? 'bear' : undefined, help: g.isMonthNegative ? 'Net P&L this month is not positive — locked until it is' : 'No block' },
    { label: 'Net P&L This Month', value: g.monthPnl !== null ? signed(g.monthPnl) : '—', tone: g.isMonthNegative ? 'bear' : g.monthPnl !== null ? 'bull' : undefined, help: 'Your own trading P&L this calendar month, across all accounts — this is what unlocks the transfer' },
    { label: 'Performance Fee', value: `${n(e.performanceFeePercent)}%` },
  ];
  const AMBER = '#D97706';

  return (
    <View testID="master-earnings" style={[styles.card, { borderColor: '#FDE68A', backgroundColor: 'rgba(254,243,199,0.45)' }]}>
      <View style={[styles.row, styles.mb12, styles.wrap]}>
        <AppText variant="bodyStrong" weight="700" style={styles.flex}>Master Earnings</AppText>
        <View style={[styles.pill, { backgroundColor: '#FEF3C7' }]}>
          <AppText variant="micro" weight="700" color="#B45309">PERFORMANCE FEE → MAIN WALLET</AppText>
        </View>
      </View>

      {g.isMonthNegative ? (
        <View style={[styles.lockNote, { backgroundColor: '#FEF2F2', borderColor: '#FECACA' }]}>
          <AppText variant="caption" color="#B91C1C">
            <AppText variant="caption" weight="700" color="#B91C1C">Transfer locked:</AppText>
            {' Your net trading P&L this month is '}
            <AppText variant="caption" weight="700" mono color="#B91C1C">{signed(g.monthPnl)}</AppText>
            {'. Commission keeps '}
            <AppText variant="caption" weight="700" color="#B91C1C">accruing</AppText>
            {', but it cannot be transferred out of a month you lost money in. Trade this month back to positive to unlock it.'}
          </AppText>
        </View>
      ) : null}

      <View style={styles.grid2}>
        {items.map((m) => (
          <View key={m.label} style={[styles.metric, { backgroundColor: 'rgba(255,255,255,0.7)', borderColor: '#FEF3C7' }]}>
            <AppText variant="micro" weight="700" tone="muted" numberOfLines={1}>{m.label.toUpperCase()}</AppText>
            <AppText
              variant="bodyStrong"
              weight="800"
              mono
              numberOfLines={1}
              adjustsFontSizeToFit
              color={m.tone === 'bull' ? t.colors.bull : m.tone === 'bear' ? t.colors.bear : m.tone === 'amber' ? AMBER : t.colors.textPrimary}
            >
              {m.value}
            </AppText>
            {m.help ? <AppText variant="micro" tone="muted" numberOfLines={3}>{m.help}</AppText> : null}
          </View>
        ))}
      </View>

      <View style={[styles.mt12, styles.transferRow]}>
        <Button
          title={transferring ? 'Transferring...' : g.isMonthNegative ? 'Transfer Commission (Locked)' : 'Transfer Commission'}
          leftIcon={g.isMonthNegative ? 'lock' : undefined}
          loading={transferring}
          disabled={!g.canTransfer || transferring}
          onPress={() => { void handleTransfer(); }}
        />
        {g.isMonthNegative && (g.pending > 0 || g.blocked > 0) ? (
          <AppText variant="caption" tone="muted" style={styles.italic}>
            {`${usd(g.pending + g.blocked)} waiting — unlocks when this month’s P&L turns positive`}
          </AppText>
        ) : null}
      </View>

      {/* Per-close fee breakdown — what was charged, on whose profit, at what %. */}
      <View style={styles.mt16}>
        <AppText variant="micro" weight="700" tone="muted" style={styles.mb8}>
          {`FEE EVENTS${history.length > 0 ? ` · LAST ${history.length}` : ''}`}
        </AppText>
        {histLoading ? (
          <AppText variant="caption" tone="muted">Loading fee events…</AppText>
        ) : history.length === 0 ? (
          <View style={[styles.feeEmpty, { borderColor: '#FEF3C7' }]}>
            <AppText variant="caption" tone="muted">
              {"No fees charged yet. A fee is charged only when a follower's copied trade closes "}
              <AppText variant="caption" weight="600" tone="secondary">in profit</AppText>
              {' — losing and breakeven closes never generate one.'}
            </AppText>
          </View>
        ) : (
          <View style={[styles.feeList, { borderColor: '#FEF3C7' }]}>
            {history.map((h, i) => (
              <View key={h.id || String(i)} testID="fee-event" style={[styles.feeRow, i > 0 ? { borderTopWidth: 1, borderTopColor: '#FFFBEB' } : null]}>
                <View style={[styles.row, styles.between]}>
                  <AppText variant="small" weight="700">{h.symbol || '—'}</AppText>
                  <AppText variant="caption" tone="muted">{traderRelTime(h.createdAt)}</AppText>
                </View>
                <View style={[styles.row, styles.between, styles.mt4]}>
                  <Mini label="Follower profit" value={signed(h.realizedProfit)} />
                  <Mini label="Fee %" value={`${n(h.feePercent)}%`} />
                  <Mini label="Your fee" value={usd(h.feeAmountUsd)} color={t.colors.bull} />
                  <Mini label="Follower kept" value={usd(h.followerNetUsd)} />
                </View>
              </View>
            ))}
          </View>
        )}
      </View>

      <AppText variant="caption" tone="muted" style={styles.mt8}>
        {"You earn a share of each follower's profit on winning copied trades. The fee is held in escrow as it is charged and released to your Main Wallet (INR) when you transfer it. Losing and breakeven trades never generate a fee."}
        {g.isMonthNegative ? ' Your commission is accumulating but locked until your own trading P&L for this month is positive.' : ''}
      </AppText>
    </View>
  );
}

export function FollowerAnalytics({ f, fee }: { f: TraderAnalytics['followers']; fee: number | null }): React.JSX.Element {
  const items: { label: string; value: string; tone?: Tone }[] = [
    { label: 'Total Followers', value: f.total.toLocaleString() },
    { label: 'Active Followers', value: f.active.toLocaleString(), tone: 'bull' },
    { label: 'New This Month', value: `+${f.newThisMonth}`, tone: 'bull' },
    { label: 'Copied Volume (AUM)', value: fmtAumCompact(f.aum) },
    { label: 'Master Earnings', value: f.generatedCommission === null ? '—' : usd(f.generatedCommission), tone: 'bull' },
    { label: 'Avg Follower ROI', value: pct(f.avgFollowerRoi), tone: n(f.avgFollowerRoi) >= 0 ? 'bull' : 'bear' },
  ];
  if (fee !== null) items.push({ label: 'Performance Fee', value: `${fee}%`, tone: 'bull' });
  return (
    <Card>
      <AppText variant="bodyStrong" weight="700" style={styles.mb12}>Follower Analytics</AppText>
      <MetricGrid items={items} />
    </Card>
  );
}

export function CopyPanel({ name, isSelf, onCopy }: { name: string; isSelf: boolean; onCopy: () => void }): React.JSX.Element {
  const t = useTheme();
  return (
    <Card>
      <AppText variant="bodyStrong" weight="700">Copy this trader</AppText>
      <AppText variant="small" tone="muted" style={styles.mt4}>
        {`Mirror ${name}'s trades automatically. Set your investment, sizing mode and risk limits — the platform copies entries, closes and SL/TP for you.`}
      </AppText>
      <View style={styles.mt8}>
        {['Fixed / proportional / multiplier sizing', 'Max risk & drawdown protection', 'Pause, resume or stop any time'].map((l) => (
          <AppText key={l} variant="caption" tone="muted">{`• ${l}`}</AppText>
        ))}
      </View>
      {isSelf ? (
        <View style={[styles.self, { backgroundColor: t.alpha(t.colors.bgHover, 0.5), borderColor: t.colors.borderSubtle }]}>
          <AppText variant="small" tone="muted" align="center">This is your own profile.</AppText>
        </View>
      ) : (
        <Button title="Copy Trader" onPress={onCopy} fullWidth style={styles.mt16} />
      )}
    </Card>
  );
}

/* ── Atoms ───────────────────────────────────────────────────────────── */

function Card({ children, padded = true }: { children: React.ReactNode; padded?: boolean }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[styles.card, !padded ? styles.noPad : null, { borderColor: t.colors.borderDark, backgroundColor: t.colors.surface }]}>
      {children}
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress} style={[styles.chip, { backgroundColor: on ? t.colors.primary : t.colors.bgHover }]}>
      <AppText variant="caption" weight="700" color={on ? t.colors.onPrimary : t.colors.textSecondary}>{label}</AppText>
    </Pressable>
  );
}

function SideChip({ side }: { side: string }): React.JSX.Element {
  const t = useTheme();
  const buy = side === 'BUY';
  const hex = buy ? t.colors.bull : t.colors.bear;
  return (
    <View style={[styles.side, { backgroundColor: t.alpha(hex, 0.15) }]}>
      <AppText variant="micro" weight="700" color={hex}>{buy ? 'BUY' : 'SELL'}</AppText>
    </View>
  );
}

function Mini({ label, value, color }: { label: string; value: string; color?: string }): React.JSX.Element {
  return (
    <View style={styles.flex}>
      <AppText variant="micro" weight="600" tone="muted">{label.toUpperCase()}</AppText>
      <AppText variant="small" mono tone={color ? undefined : 'secondary'} color={color} numberOfLines={1}>{value}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  between: { justifyContent: 'space-between' },
  mb8: { marginBottom: 8 },
  mt12: { marginTop: 12 },
  italic: { fontStyle: 'italic' },
  lockNote: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 12 },
  transferRow: { gap: 8, alignItems: 'flex-start' },
  feeEmpty: { borderWidth: 1, borderRadius: 12, padding: 12, backgroundColor: 'rgba(255,255,255,0.7)' },
  feeList: { borderWidth: 1, borderRadius: 12, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.7)' },
  feeRow: { paddingHorizontal: 12, paddingVertical: 10 },
  shrink: { flexShrink: 1 },
  wrap: { flexWrap: 'wrap' },
  alignEnd: { alignItems: 'flex-end' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  mt4: { marginTop: 4 },
  mt8: { marginTop: 8 },
  mt16: { marginTop: 16 },
  mb12: { marginBottom: 12 },
  pad: { padding: 32 },
  hero: { borderRadius: 24, padding: 20, gap: 14, backgroundColor: '#111A2E', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  heroAvatar: { width: 72, height: 72, borderRadius: 18, backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  heroAvatarImg: { width: 72, height: 72 },
  heroInitials: { fontSize: 24, fontWeight: '800' },
  heroStats: { flexDirection: 'row', gap: 12 },
  heroBtn: { alignItems: 'center', borderRadius: 12, paddingVertical: 12 },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  grid2: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  cell: { width: '47%', flexGrow: 1, borderWidth: 1, borderRadius: 16, padding: 14 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden', marginTop: 8 },
  fill: { height: '100%', borderRadius: 3 },
  card: { borderWidth: 1, borderRadius: 16, padding: 16 },
  noPad: { padding: 0, overflow: 'hidden' },
  chip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  chartEmpty: { paddingVertical: 56 },
  metric: { width: '47%', flexGrow: 1, borderWidth: 1, borderRadius: 12, padding: 10, gap: 2 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 6, height: 130 },
  barCol: { flex: 1, height: '100%', alignItems: 'center', justifyContent: 'flex-end' },
  bar: { width: '100%', maxWidth: 28, borderTopLeftRadius: 6, borderTopRightRadius: 6, opacity: 0.85 },
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, gap: 2 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  cardHeadCol: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, gap: 8 },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  item: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  side: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 },
  customRange: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1 },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1 },
  self: { marginTop: 16, borderWidth: 1, borderRadius: 12, paddingVertical: 12 },
});
