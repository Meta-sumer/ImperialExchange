import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Image, Linking, Pressable, Share, StyleSheet, View, type DimensionValue } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import Svg, {
  Circle,
  Defs,
  Ellipse,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
  Text as SvgText,
} from 'react-native-svg';

import { DateField } from '@/components/common/DateField';
import { FillSvg } from '@/components/common/FillSvg';
import { AppText, Input, toast } from '@/components/ui';
import { useTheme } from '@/theme';
import {
  REFERRAL_SHARE,
  RECENT_COMMISSIONS_SHOWN,
  commissionSourceLabel,
  filterReferralPerformance,
  fmtVolume,
  fmtVolumeCompact,
  levelMeta,
  levelThresholdText,
  nextLevelText,
  pageSlice,
  partnerLevels,
  partnerRelTime,
  referralAvatar,
  referralQrUrl,
  referralShareUrls,
  seriesTotals,
  type Commission,
  type FirstDepositBonus,
  type PartnerMonthPoint,
  type ReferralPerformanceRow,
  type TierState,
  type VolumeDashboard,
} from '@/types/partner';
import { fmtDateTime } from '@/utils/fundsFlows';
import { fmtMoney } from '@/utils/money';

/**
 * The Partner page's sections — client/src/pages/Partner.jsx. Every string
 * and tier colour is the web's; figures are the server's volume dashboard.
 */

/* ── Count-up (the web's useCountUp: easeOutCubic from the last value) ── */

export function useCountUp(target: number, duration = 800): number {
  const to = Number(target) || 0;
  const [val, setVal] = useState(to);
  const from = useRef(to);
  useEffect(() => {
    const start = from.current;
    if (start === to) { setVal(to); return undefined; }
    let raf = 0;
    const t0 = Date.now();
    const tick = (): void => {
      const k = Math.min(1, (Date.now() - t0) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      setVal(start + (to - start) * eased);
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, duration]);
  return val;
}

/* ── Atoms ───────────────────────────────────────────────────────────── */

export function SectionTitle({ title, sub }: { title: string; sub?: string }): React.JSX.Element {
  return (
    <View style={styles.sectionTitle}>
      <AppText variant="h3" weight="800">{title}</AppText>
      {sub ? <AppText variant="small" tone="secondary" style={styles.sectionSub}>{sub}</AppText> : null}
    </View>
  );
}

/** The metallic tier disc — gradient, rings, a shine and the tier's initial. */
export function MetallicBadge({ tier, size = 96 }: { tier: string; size?: number }): React.JSX.Element {
  const m = levelMeta(tier);
  const id = `mb-${String(tier)}`;
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Defs>
          <RadialGradient id={`${id}-g`} cx="35%" cy="28%" r="80%">
            <Stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
            <Stop offset="28%" stopColor={m.from} />
            <Stop offset="100%" stopColor={m.to} />
          </RadialGradient>
        </Defs>
        <Circle cx="50" cy="50" r="46" fill={`url(#${id}-g)`} stroke="rgba(255,255,255,0.55)" strokeWidth="1.5" />
        <Circle cx="50" cy="50" r="38" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
        <Ellipse cx="38" cy="30" rx="22" ry="12" fill="rgba(255,255,255,0.35)" />
        <SvgText x="50" y="62" textAnchor="middle" fontSize="34" fontWeight="900" fill={m.text}>
          {m.label.charAt(0)}
        </SvgText>
      </Svg>
    </View>
  );
}

/** A full-size gradient behind a card (the web's CSS linear-gradient). */
function GradientFill({ from, to, id, angle = 'diag' }: { from: string; to: string; id: string; angle?: 'diag' | 'h' }): React.JSX.Element {
  return (
    <FillSvg preserveAspectRatio="none" viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2={angle === 'h' ? '1' : '1'} y2={angle === 'h' ? '0' : '1'}>
          <Stop offset="0" stopColor={from} />
          <Stop offset="1" stopColor={to} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100" height="100" fill={`url(#${id})`} />
    </FillSvg>
  );
}

/* ── Paused banner + first-deposit reward ─────────────────────────────── */

export function PausedBanner(): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[styles.banner, { backgroundColor: t.alpha(t.colors.warn, 0.1), borderColor: t.alpha(t.colors.warn, 0.3) }]}>
      <AppText variant="bodyStrong" color={t.colors.warn}>
        The partner program is currently paused by the administrator. New commissions won't be credited.
      </AppText>
    </View>
  );
}

export function FirstDepositRewardCard({ bonus, cur }: { bonus: FirstDepositBonus | null; cur: string }): React.JSX.Element | null {
  const t = useTheme();
  if (!bonus || bonus.enabled === false) return null;
  const amt = Number(bonus.amount) || 0;
  if (amt <= 0) return null;
  // Partner.jsx: `const currency = 'INR'`.
  const currency = cur;
  return (
    <View style={[styles.reward, { borderColor: 'rgba(16,185,129,0.3)', backgroundColor: 'rgba(16,185,129,0.08)' }]}>
      <View style={styles.rewardIcon}>
        <GradientFill from="#34D399" to="#059669" id="fdr" />
        <AppText style={styles.rewardGlyph}>🎁</AppText>
      </View>
      <View style={styles.flex}>
        <View style={styles.row}>
          <AppText variant="title" weight="800">First Deposit Reward</AppText>
          <View style={[styles.pill, { backgroundColor: t.alpha(t.colors.bull, 0.15) }]}>
            <AppText variant="micro" weight="700" color={t.colors.bull}>ACTIVE</AppText>
          </View>
        </View>
        <AppText variant="body" tone="secondary" style={styles.mt2}>
          {'Earn '}
          <AppText variant="body" weight="700" color={t.colors.bull}>{fmtMoney(amt, currency)}</AppText>
          {' when your referral makes their first deposit of '}
          <AppText variant="body" weight="700">{fmtMoney(bonus.minDeposit, currency)}</AppText>
          {' or more.'}
        </AppText>
        <AppText variant="caption" tone="muted" style={styles.mt4}>
          Paid to you automatically, once per referral, on their first qualifying deposit.
        </AppText>
      </View>
    </View>
  );
}

/* ── Hero ────────────────────────────────────────────────────────────── */

const W = (a: number): string => `rgba(255,255,255,${a})`;

export function HeroCard({ d }: { d: VolumeDashboard }): React.JSX.Element {
  const m = levelMeta(d.partnerLevel);
  const next = d.nextLevel;
  const vol = useCountUp(d.previousMonthVolume ?? d.totalReferralVolume);
  const pct = useCountUp(d.progressPercent, 900);
  const bar = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(bar, { toValue: Math.max(0, Math.min(100, d.progressPercent || 0)), duration: 1000, useNativeDriver: false }).start();
  }, [bar, d.progressPercent]);
  const width = bar.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] });
  const nextMeta = next ? levelMeta(next.name) : null;

  return (
    <View style={styles.hero}>
      <GradientFill from="#0B1220" to="#1B2740" id="hero-bg" />
      <View style={styles.heroTop}>
        <MetallicBadge tier={d.partnerLevel} size={88} />
        <View style={styles.flex}>
          <AppText variant="micro" weight="700" color={W(0.55)} style={styles.caps}>
            {`CURRENT TIER${d.tierLocked ? ' · 🔒 LOCKED' : ''}`}
          </AppText>
          <View style={styles.levelRow}>
            <AppText style={styles.levelName} color="#FFFFFF">{m.label}</AppText>
            <View style={[styles.partnerTag, { backgroundColor: W(0.12), borderColor: W(0.18) }]}>
              <AppText variant="micro" weight="700" color="#FFFFFF">PARTNER</AppText>
            </View>
          </View>
          <View style={styles.row}>
            <AppText style={styles.sharePct} color={m.accent}>{`${d.revenueSharePercent}%`}</AppText>
            <AppText variant="small" color={W(0.7)} style={styles.flex}>profit share on referral fees</AppText>
          </View>
        </View>
      </View>

      <View style={[styles.nextChip, { backgroundColor: W(0.08), borderColor: W(0.14) }]}>
        {next && nextMeta ? (
          <AppText variant="small" weight="600" color="#FFFFFF">
            <AppText variant="small" color={nextMeta.accent}>▲ </AppText>
            {nextLevelText(next)}
          </AppText>
        ) : (
          <AppText variant="small" weight="700" color="#FFFFFF">👑 Top tier unlocked — maximum profit share</AppText>
        )}
      </View>

      <View style={[styles.progress, { backgroundColor: W(0.05), borderColor: W(0.12) }]}>
        <View style={styles.progressTop}>
          <View style={styles.flex}>
            <AppText variant="micro" weight="700" color={W(0.55)} style={styles.caps}>PREVIOUS MONTH VOLUME</AppText>
            <AppText style={styles.volume} mono color="#FFFFFF">{fmtVolume(vol)}</AppText>
            <AppText variant="caption" color={W(0.6)}>Determines this month's tier</AppText>
          </View>
          <View style={styles.alignEnd}>
            <AppText variant="micro" weight="700" color={W(0.55)} style={styles.caps}>
              {nextMeta ? `${nextMeta.label.toUpperCase()} REQUIREMENT` : 'TIER REQUIREMENT'}
            </AppText>
            <AppText variant="title" weight="700" mono color={W(0.85)}>{next ? fmtVolume(next.minVolume) : 'MAX'}</AppText>
            <AppText variant="caption" color={W(0.6)}>
              {'This month so far: '}
              <AppText variant="caption" weight="700" color={W(0.85)}>{fmtVolume(d.currentMonthVolume || 0)}</AppText>
            </AppText>
          </View>
        </View>

        <View style={[styles.track, { backgroundColor: W(0.1) }]}>
          <Animated.View style={[styles.fill, { width, backgroundColor: m.accent }]} />
        </View>

        <View style={styles.progressFoot}>
          <AppText variant="small" weight="700" color={m.accent}>{`${pct.toFixed(1)}% complete`}</AppText>
          {next && nextMeta ? (
            <AppText variant="small" color={W(0.75)} style={styles.flexRight}>
              <AppText variant="small" weight="700" color="#FFFFFF">{fmtVolume(d.volumeToNextLevel)}</AppText>
              {' more to unlock '}
              <AppText variant="small" weight="700" color={nextMeta.accent}>{`${nextMeta.label} (${next.percent}%)`}</AppText>
            </AppText>
          ) : (
            <AppText variant="small" color={W(0.75)} style={styles.flexRight}>You've reached the highest partner tier.</AppText>
          )}
        </View>
      </View>
    </View>
  );
}

/* ── Levels ──────────────────────────────────────────────────────────── */

export function LevelsSection({ d }: { d: VolumeDashboard }): React.JSX.Element {
  const levels = partnerLevels(d.tiers, d.partnerLevel);
  return (
    <View>
      <SectionTitle
        title="Partner Levels"
        sub="Your tier is set on the 1st of each month from the PREVIOUS month's referral trading volume, then fixed for the whole month."
      />
      <View style={styles.grid2}>
        {levels.map(({ tier, state }) => (
          <LevelCard key={tier.name} name={tier.name} threshold={levelThresholdText(tier)} percent={tier.percent} state={state} />
        ))}
      </View>
    </View>
  );
}

function LevelCard({ name, threshold, percent, state }: { name: string; threshold: string; percent: number; state: TierState }): React.JSX.Element {
  const t = useTheme();
  const m = levelMeta(name);
  const isCurrent = state === 'current';
  const isLocked = state === 'locked';
  return (
    <View
      style={[styles.levelCard, {
        borderColor: isCurrent ? 'transparent' : t.colors.borderDark,
        backgroundColor: isCurrent ? m.to : t.colors.surface,
        opacity: isLocked ? 0.7 : 1,
      }]}
    >
      {isCurrent ? <GradientFill from={m.from} to={m.to} id={`lc-${name}`} /> : (
        <View style={styles.levelStrip}><GradientFill from={m.from} to={m.to} id={`ls-${name}`} angle="h" /></View>
      )}
      <View style={styles.levelHead}>
        <MetallicBadge tier={name} size={isCurrent ? 46 : 40} />
        {isCurrent ? (
          <View style={[styles.currentTag, { backgroundColor: W(0.2), borderColor: W(0.3) }]}>
            <AppText variant="micro" weight="800" color="#FFFFFF">CURRENT</AppText>
          </View>
        ) : isLocked ? (
          <AppText tone="muted">🔒</AppText>
        ) : (
          <View style={[styles.check, { backgroundColor: t.alpha(t.colors.bull, 0.15) }]}>
            <AppText variant="micro" weight="800" color={t.colors.bull}>✓</AppText>
          </View>
        )}
      </View>
      <AppText variant="title" weight="800" color={isCurrent ? '#FFFFFF' : undefined} style={styles.mt8}>{m.label}</AppText>
      <AppText variant="small" weight="600" color={isCurrent ? W(0.85) : t.colors.textMuted}>{threshold}</AppText>
      <View style={[styles.row, styles.mt8]}>
        <AppText style={styles.levelPct} color={isCurrent ? '#FFFFFF' : m.to}>{`${percent}%`}</AppText>
        <AppText variant="caption" weight="600" color={isCurrent ? W(0.8) : t.colors.textMuted}>profit share</AppText>
      </View>
    </View>
  );
}

/* ── Statistics ──────────────────────────────────────────────────────── */

const TINTS = {
  green: { fg: '#16A34A', bg: 'rgba(0,200,83,0.12)' },
  blue: { fg: '#2563EB', bg: 'rgba(37,99,235,0.12)' },
  violet: { fg: '#7C3AED', bg: 'rgba(124,58,237,0.12)' },
  amber: { fg: '#D97706', bg: 'rgba(217,119,6,0.12)' },
  slate: { fg: '#475569', bg: 'rgba(71,85,105,0.12)' },
} as const;
type Tint = keyof typeof TINTS;

const ICON_PATHS = {
  volume: ['M3 3v18h18', 'M7 14l3-3 3 3 5-6'],
  calendar: ['M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z', 'M16 2v4', 'M8 2v4', 'M3 10h18'],
  coins: ['M12 2v20', 'M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6'],
  network: ['M12 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M5 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M12 8v4', 'M6.5 16l4-3', 'M17.5 16l-4-3'],
  clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6v6l4 2'],
} as const;
type IconKey = keyof typeof ICON_PATHS;

function StatIcon({ name, color }: { name: IconKey; color: string }): React.JSX.Element {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24">
      {ICON_PATHS[name].map((p) => (
        <Path key={p} d={p} stroke={color} strokeWidth={1.9} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </Svg>
  );
}

export function StatsSection({ d, cur }: { d: VolumeDashboard; cur: string }): React.JSX.Element {
  const cards: { label: string; value: string; icon: IconKey; tint: Tint }[] = [
    { label: 'Total One-Side Volume', value: fmtVolume(d.totalOneSideVolume ?? d.totalReferralVolume), icon: 'volume', tint: 'blue' },
    { label: 'Pending Volume', value: fmtVolume(d.pendingVolume ?? 0), icon: 'clock', tint: 'amber' },
    { label: 'Commissioned Volume', value: fmtVolume(d.commissionedVolume ?? 0), icon: 'coins', tint: 'green' },
    { label: 'Total Commission Earned', value: fmtMoney(d.revenueShareEarned ?? d.totalCommissionEarned, cur), icon: 'coins', tint: 'green' },
    { label: 'Previous Month Volume', value: fmtVolume(d.previousMonthVolume), icon: 'calendar', tint: 'violet' },
    { label: 'Commission Rate', value: `${d.revenueSharePercent}%`, icon: 'coins', tint: 'green' },
    { label: 'Total Referrals', value: String(d.totalReferrals ?? 0), icon: 'network', tint: 'slate' },
    { label: 'Pending Commission', value: fmtMoney(d.pendingCommission, cur), icon: 'clock', tint: 'amber' },
  ];
  return (
    <View style={styles.grid2}>
      {cards.map((c) => <StatTile key={c.label} {...c} />)}
    </View>
  );
}

function StatTile({ label, value, icon, tint }: { label: string; value: string; icon: IconKey; tint: Tint }): React.JSX.Element {
  const t = useTheme();
  const tt = TINTS[tint];
  return (
    <View style={[styles.statTile, { backgroundColor: t.colors.surface, borderColor: t.colors.borderDark }]}>
      <View style={styles.row}>
        <View style={[styles.statIcon, { backgroundColor: tt.bg }]}><StatIcon name={icon} color={tt.fg} /></View>
        <AppText variant="micro" weight="700" tone="muted" style={[styles.flex, styles.capsTight]}>{label.toUpperCase()}</AppText>
      </View>
      <AppText variant="title" weight="800" mono numberOfLines={1} adjustsFontSizeToFit style={styles.mt8}>{value}</AppText>
    </View>
  );
}

/* ── Charts ──────────────────────────────────────────────────────────── */

export function ChartsSection({ series, cur }: { series: readonly PartnerMonthPoint[]; cur: string }): React.JSX.Element {
  const totals = seriesTotals(series);
  return (
    <View style={styles.stack}>
      <ChartCard title="Trading Volume Growth" sub="Referral notional volume · last 6 months" total={fmtVolume(totals.volume)} tint="#2563EB">
        <AreaChart data={series.map((p) => ({ label: p.label, value: p.volume || 0 }))} />
      </ChartCard>
      <ChartCard title="Commission Earnings" sub="Earned per month · last 6 months" total={fmtMoney(totals.commission, cur)} tint="#16A34A">
        <BarChart data={series.map((p) => ({ label: p.label, value: Number(p.commission) || 0 }))} />
      </ChartCard>
    </View>
  );
}

function ChartCard({ title, sub, total, tint, children }: { title: string; sub: string; total: string; tint: string; children: React.ReactNode }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: t.colors.surface, borderColor: t.colors.borderDark }]}>
      <View style={styles.chartHead}>
        <View style={styles.flex}>
          <AppText variant="bodyStrong" weight="700">{title}</AppText>
          <AppText variant="caption" tone="muted">{sub}</AppText>
        </View>
        <View style={styles.alignEnd}>
          <AppText variant="micro" weight="700" tone="muted">TOTAL</AppText>
          <AppText variant="bodyStrong" weight="800" mono color={tint}>{total}</AppText>
        </View>
      </View>
      {children}
    </View>
  );
}

function EmptyChart(): React.JSX.Element {
  return (
    <View style={styles.emptyChart}>
      <AppText variant="small" tone="muted">No data yet — activity will appear here.</AppText>
    </View>
  );
}

function AreaChart({ data }: { data: { label: string; value: number }[] }): React.JSX.Element {
  const t = useTheme();
  if (!data.length) return <EmptyChart />;
  const Wd = 320;
  const H = 120;
  const P = 6;
  const max = Math.max(...data.map((x) => x.value), 1);
  const stepX = (Wd - P * 2) / Math.max(1, data.length - 1);
  const y = (v: number): number => H - P - (v / max) * (H - P * 2 - 14);
  const pts = data.map((x, i) => [P + i * stepX, y(x.value)] as const);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1] ?? [P, H - P];
  const first = pts[0] ?? [P, H - P];
  const area = `${line} L ${last[0].toFixed(1)} ${H - P} L ${first[0].toFixed(1)} ${H - P} Z`;
  return (
    <View>
      <Svg width="100%" height={130} viewBox={`0 0 ${Wd} ${H}`} preserveAspectRatio="none">
        <Path d={area} fill="rgba(37,99,235,0.18)" />
        <Path d={line} fill="none" stroke="#2563EB" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        {pts.map((p, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <Circle key={i} cx={p[0]} cy={p[1]} r={3} fill={t.colors.surface} stroke="#2563EB" strokeWidth={2} />
        ))}
      </Svg>
      <ChartAxis labels={data.map((x) => x.label)} />
    </View>
  );
}

function BarChart({ data }: { data: { label: string; value: number }[] }): React.JSX.Element {
  if (!data.length) return <EmptyChart />;
  const max = Math.max(...data.map((x) => x.value), 1);
  return (
    <View>
      <View style={styles.bars}>
        {data.map((x, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <View key={i} style={styles.barCol}>
            <View style={[styles.bar, { height: `${Math.max(2, (x.value / max) * 100)}%` as DimensionValue }]} />
          </View>
        ))}
      </View>
      <ChartAxis labels={data.map((x) => x.label)} />
    </View>
  );
}

function ChartAxis({ labels }: { labels: string[] }): React.JSX.Element {
  return (
    <View style={styles.axis}>
      {labels.map((l, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <AppText key={i} variant="micro" weight="500" tone="muted">{l}</AppText>
      ))}
    </View>
  );
}

/* ── Referral performance ────────────────────────────────────────────── */

export function ReferralPerformance({ rows, cur }: { rows: readonly ReferralPerformanceRow[]; cur: string }): React.JSX.Element {
  const t = useTheme();
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const maxVol = Math.max(...rows.map((r) => r.volume || 0), 1);
  const filtered = useMemo(() => filterReferralPerformance(rows, { query: q, from, to }), [rows, q, from, to]);
  const slice = pageSlice(filtered, page);
  const hasFilters = !!(q.trim() || from || to);
  const clear = (): void => { setQ(''); setFrom(''); setTo(''); setPage(1); };

  return (
    <View style={[styles.card, styles.noPad, { backgroundColor: t.colors.surface, borderColor: t.colors.borderDark }]}>
      <View style={[styles.cardHead, { borderBottomColor: t.colors.borderSubtle }]}>
        <View style={styles.flex}>
          <AppText variant="bodyStrong" weight="700">Referral Performance</AppText>
          <AppText variant="caption" tone="muted">Top traders by trading volume</AppText>
        </View>
        <AppText variant="caption" weight="600" tone="muted">
          {hasFilters ? `${filtered.length} of ${rows.length}` : `${rows.length} referral${rows.length === 1 ? '' : 's'}`}
        </AppText>
      </View>

      {rows.length > 0 ? (
        <View style={[styles.filters, { borderBottomColor: t.colors.borderSubtle }]}>
          <Input
            value={q}
            onChangeText={(v) => { setQ(v); setPage(1); }}
            placeholder="Search name or email…"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Search name or email"
          />
          <View style={styles.row}>
            <DateField label="From" value={from} onChange={(v) => { setFrom(v); setPage(1); }} max={to || undefined} />
            <AppText variant="small" tone="muted">–</AppText>
            <DateField label="To" value={to} onChange={(v) => { setTo(v); setPage(1); }} min={from || undefined} />
            {hasFilters ? (
              <Pressable accessibilityRole="button" onPress={clear} hitSlop={6}>
                <AppText variant="caption" weight="600" color={t.colors.primaryText}>Clear</AppText>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      {rows.length === 0 ? (
        <AppText variant="body" tone="muted" align="center" style={styles.state}>No referrals yet — share your link to start earning.</AppText>
      ) : filtered.length === 0 ? (
        <AppText variant="body" tone="muted" align="center" style={styles.state}>No referrals match your search or date range.</AppText>
      ) : (
        <>
          {slice.rows.map((r, i) => {
            const av = referralAvatar(r.name);
            return (
              <View key={r.id} style={[styles.refRow, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.borderSubtle } : null]}>
                <View style={styles.row}>
                  <View style={[styles.avatar, { backgroundColor: `hsl(${av.hue}, 65%, 48%)` }]}>
                    <AppText variant="caption" weight="700" color="#FFFFFF">{av.initials}</AppText>
                  </View>
                  <View style={styles.flex}>
                    <AppText variant="bodyStrong" numberOfLines={1}>{r.name}</AppText>
                    <AppText variant="micro" tone="muted" mono numberOfLines={1}>{r.email}</AppText>
                  </View>
                  <View style={[styles.pill, { backgroundColor: r.status === 'ACTIVE' ? t.alpha(t.colors.bull, 0.15) : t.colors.bgHover }]}>
                    <AppText variant="micro" weight="700" color={r.status === 'ACTIVE' ? t.colors.bull : t.colors.textMuted}>
                      {r.status === 'ACTIVE' ? 'ACTIVE' : 'IDLE'}
                    </AppText>
                  </View>
                </View>
                <View style={[styles.refFigures, styles.mt8]}>
                  <View style={styles.flex}>
                    <AppText variant="micro" weight="700" tone="muted">TRADING VOLUME</AppText>
                    <AppText variant="bodyStrong" weight="700" mono>{fmtVolume(r.volume)}</AppText>
                    <View style={[styles.volTrack, { backgroundColor: t.colors.bgHover }]}>
                      <View style={[styles.volFill, { width: `${(r.volume / maxVol) * 100}%` as DimensionValue }]} />
                    </View>
                    {r.pendingVolume != null && r.commissionedVolume != null ? (
                      <AppText variant="micro" mono tone="muted" style={styles.mt4}>
                        <AppText variant="micro" mono color="#D97706">{`${fmtVolumeCompact(r.pendingVolume)} pending`}</AppText>
                        {' · '}
                        <AppText variant="micro" mono color={t.colors.bull}>{`${fmtVolumeCompact(r.commissionedVolume)} done`}</AppText>
                      </AppText>
                    ) : null}
                  </View>
                  <View style={styles.alignEnd}>
                    <AppText variant="micro" weight="700" tone="muted">COMMISSION</AppText>
                    <AppText variant="bodyStrong" weight="700" mono color={t.colors.bull}>{fmtMoney(r.commission, cur)}</AppText>
                    <AppText variant="caption" tone="secondary" style={styles.mt4}>{partnerRelTime(r.lastActivityAt)}</AppText>
                  </View>
                </View>
              </View>
            );
          })}
          {filtered.length > slice.rows.length || slice.totalPages > 1 ? (
            <View style={[styles.pager, { borderTopColor: t.colors.borderSubtle }]}>
              <AppText variant="caption" weight="500" tone="muted">
                {`Showing ${slice.start + 1}–${Math.min(slice.start + slice.rows.length, filtered.length)} of ${filtered.length}`}
              </AppText>
              <View style={styles.row}>
                <PagerBtn label="Prev" disabled={slice.page <= 1} onPress={() => setPage(slice.page - 1)} />
                <AppText variant="caption" weight="600" tone="muted">{`${slice.page} / ${slice.totalPages}`}</AppText>
                <PagerBtn label="Next" disabled={slice.page >= slice.totalPages} onPress={() => setPage(slice.page + 1)} />
              </View>
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

function PagerBtn({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.pagerBtn, { borderColor: t.colors.borderSubtle, opacity: disabled ? 0.4 : 1 }]}
    >
      <AppText variant="caption" weight="600" tone="secondary">{label}</AppText>
    </Pressable>
  );
}

/* ── Commission overview + recent ────────────────────────────────────── */

export function CommissionOverview({ d, cur }: { d: VolumeDashboard; cur: string }): React.JSX.Element {
  const t = useTheme();
  const cells = [
    { label: 'Total earned', value: fmtMoney(d.totalCommissionEarned, cur), color: t.colors.bull },
    { label: 'This month', value: fmtMoney(d.monthlyCommission, cur), color: t.colors.textPrimary },
    { label: 'Paid out', value: fmtMoney(d.paidCommission, cur), color: t.colors.textPrimary },
    { label: 'Pending', value: fmtMoney(d.pendingCommission, cur), color: t.colors.warn },
  ];
  return (
    <View style={[styles.card, styles.noPad, { backgroundColor: t.colors.surface, borderColor: t.colors.borderDark }]}>
      <View style={[styles.cardHead, { borderBottomColor: t.colors.borderSubtle }]}>
        <AppText variant="bodyStrong" weight="700" style={styles.flex}>Commission Overview</AppText>
        <View style={[styles.pill, { backgroundColor: t.alpha(t.colors.primary, 0.1) }]}>
          <AppText variant="micro" weight="800" color={t.colors.primaryText}>{`${d.revenueSharePercent}% SHARE`}</AppText>
        </View>
      </View>
      <View style={styles.overviewGrid}>
        {cells.map((c) => (
          <View key={c.label} style={[styles.overviewCell, { borderColor: t.colors.borderSubtle }]}>
            <AppText variant="micro" weight="700" tone="muted">{c.label.toUpperCase()}</AppText>
            <AppText variant="title" weight="800" mono color={c.color} numberOfLines={1} adjustsFontSizeToFit>{c.value}</AppText>
          </View>
        ))}
      </View>
      <View style={[styles.available, { borderTopColor: t.colors.borderSubtle, backgroundColor: t.alpha(t.colors.bgHover, 0.4) }]}>
        <AppText variant="caption" weight="600" tone="muted">Available balance</AppText>
        <AppText variant="bodyStrong" weight="800" mono color={t.colors.bull}>{fmtMoney(d.availableBalance, cur)}</AppText>
      </View>
    </View>
  );
}

export function RecentCommissions({ rows, cur }: { rows: readonly Commission[]; cur: string }): React.JSX.Element | null {
  const t = useTheme();
  if (!rows.length) return null;
  return (
    <View style={[styles.card, styles.noPad, { backgroundColor: t.colors.surface, borderColor: t.colors.borderDark }]}>
      <View style={[styles.cardHead, { borderBottomColor: t.colors.borderSubtle }]}>
        <AppText variant="bodyStrong" weight="700">Recent commissions</AppText>
      </View>
      {rows.slice(0, RECENT_COMMISSIONS_SHOWN).map((r, i) => (
        <View key={r.id || `${r.createdAt}-${i}`} style={[styles.commission, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.borderSubtle } : null]}>
          <View style={styles.flex}>
            <AppText variant="small" weight="600" numberOfLines={1}>{commissionSourceLabel(r.sourceType)}</AppText>
            <AppText variant="micro" tone="muted" numberOfLines={1}>{`${r.refereeName || '—'} · ${fmtDateTime(r.createdAt)}`}</AppText>
          </View>
          <View style={styles.alignEnd}>
            <AppText variant="bodyStrong" weight="700" mono color={t.colors.bull}>{`+${fmtMoney(r.amount, cur)}`}</AppText>
            <AppText variant="micro" weight="700" color={r.status === 'PAID' ? '#16A34A' : '#3B82F6'}>{r.status}</AppText>
          </View>
        </View>
      ))}
    </View>
  );
}

/* ── Referral link + QR ──────────────────────────────────────────────── */

export function ReferralLinkSection({ code, link }: { code: string; link: string }): React.JSX.Element {
  const t = useTheme();
  const [copied, setCopied] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async (text: string, key: string, label: string): Promise<void> => {
    if (!text) return;
    try {
      await Clipboard.setStringAsync(text);
      toast.success(label);
      setCopied(key);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(''), 1500);
    } catch {
      toast.error('Copy failed');
    }
  };

  const share = async (): Promise<void> => {
    if (!link) return;
    try {
      await Share.share({ title: REFERRAL_SHARE.title, message: `${REFERRAL_SHARE.text}: ${link}`, url: link });
    } catch {
      void copy(link, 'link', 'Link copied — paste it anywhere');
    }
  };

  const urls = referralShareUrls(link);
  const open = (url: string): void => { Linking.openURL(url).catch(() => undefined); };

  return (
    <View>
      <SectionTitle title="Invite & Earn" sub="Share your link — earn profit share on every referral's trading volume." />
      <View style={[styles.card, { backgroundColor: t.colors.surface, borderColor: t.colors.borderDark, gap: 16 }]}>
        <View>
          <AppText variant="micro" weight="700" tone="muted">REFERRAL CODE</AppText>
          <View style={[styles.row, styles.mt6]}>
            <View style={[styles.codeBox, { backgroundColor: t.colors.bgHover, borderColor: t.colors.borderDark }]}>
              <AppText style={styles.code} mono numberOfLines={1}>{code || '—'}</AppText>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Copy referral code"
              disabled={!code}
              onPress={() => { void copy(code, 'code', 'Code copied'); }}
              style={[styles.copyPrimary, { backgroundColor: '#2563EB', opacity: code ? 1 : 0.5 }]}
            >
              <AppText variant="bodyStrong" weight="700" color="#FFFFFF">{copied === 'code' ? '✓ Copied' : 'Copy'}</AppText>
            </Pressable>
          </View>
        </View>

        <View>
          <AppText variant="micro" weight="700" tone="muted">REFERRAL LINK</AppText>
          <View style={[styles.row, styles.mt6]}>
            <View style={[styles.codeBox, { backgroundColor: t.colors.bgHover, borderColor: t.colors.borderDark }]}>
              <AppText variant="small" tone="secondary" mono numberOfLines={1}>{link || '—'}</AppText>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Copy referral link"
              disabled={!link}
              onPress={() => { void copy(link, 'link', 'Link copied'); }}
              style={[styles.copySecondary, { borderColor: t.colors.borderDark, opacity: link ? 1 : 0.5 }]}
            >
              <AppText variant="bodyStrong" weight="700">{copied === 'link' ? '✓' : 'Copy'}</AppText>
            </Pressable>
          </View>
        </View>

        <View style={styles.shareRow}>
          <Pressable
            accessibilityRole="button"
            disabled={!link}
            onPress={() => { void share(); }}
            style={[styles.shareBtn, { backgroundColor: '#16A34A', opacity: link ? 1 : 0.5 }]}
          >
            <AppText variant="bodyStrong" weight="700" color="#FFFFFF">Share</AppText>
          </Pressable>
          {urls ? (
            <>
              <ShareLink label="WhatsApp" onPress={() => open(urls.whatsapp)} />
              <ShareLink label="Telegram" onPress={() => open(urls.telegram)} />
              <ShareLink label="X / Twitter" onPress={() => open(urls.twitter)} />
            </>
          ) : null}
        </View>

        <View style={[styles.qrWrap, { borderTopColor: t.colors.borderSubtle }]}>
          <QRCode value={link} />
          <AppText variant="caption" weight="600" tone="muted" align="center">{'Scan to open\nyour referral link'}</AppText>
        </View>
      </View>
    </View>
  );
}

function ShareLink({ label, onPress }: { label: string; onPress: () => void }): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="link" onPress={onPress} style={[styles.shareLink, { borderColor: t.colors.borderDark }]}>
      <AppText variant="small" weight="600" tone="secondary">{label}</AppText>
    </Pressable>
  );
}

function QRCode({ value }: { value: string }): React.JSX.Element {
  const t = useTheme();
  const [failed, setFailed] = useState(false);
  const src = referralQrUrl(value);
  if (!src) {
    return (
      <View style={[styles.qrBox, styles.qrDashed, { borderColor: t.colors.borderDark }]}>
        <AppText variant="caption" tone="muted" align="center">Referral code unavailable</AppText>
      </View>
    );
  }
  if (failed) {
    return (
      <View style={[styles.qrBox, { borderColor: t.colors.borderDark, backgroundColor: '#FFFFFF' }]}>
        <AppText variant="micro" tone="muted" align="center">QR unavailable offline — use the link above</AppText>
      </View>
    );
  }
  return (
    <View style={[styles.qrFrame, { borderColor: t.colors.borderDark }]}>
      <Image source={{ uri: src }} style={styles.qr} accessibilityLabel="Referral QR code" onError={() => setFailed(true)} />
    </View>
  );
}

/* ── Skeleton ────────────────────────────────────────────────────────── */

export function PartnerSkeleton(): React.JSX.Element {
  const t = useTheme();
  const b = { backgroundColor: t.colors.bgHover };
  return (
    <View style={styles.stack} accessibilityLabel="Loading partner dashboard">
      <View style={[styles.skelHero, b]} />
      <View style={styles.grid2}>
        {[0, 1, 2, 3].map((i) => <View key={i} style={[styles.skelTile, b]} />)}
      </View>
      <View style={[styles.skelChart, b]} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  flexRight: { flex: 1, minWidth: 0, textAlign: 'right' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stack: { gap: 16 },
  alignEnd: { alignItems: 'flex-end' },
  mt2: { marginTop: 2 },
  mt4: { marginTop: 4 },
  mt6: { marginTop: 6 },
  mt8: { marginTop: 8 },
  caps: { letterSpacing: 1.6 },
  capsTight: { letterSpacing: 0.6 },
  sectionTitle: { marginBottom: 12 },
  sectionSub: { marginTop: 2 },
  banner: { borderWidth: 1, borderRadius: 16, padding: 16 },
  reward: { flexDirection: 'row', alignItems: 'center', gap: 16, borderWidth: 1, borderRadius: 16, padding: 20, overflow: 'hidden' },
  rewardIcon: { width: 56, height: 56, borderRadius: 16, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  rewardGlyph: { fontSize: 28, lineHeight: 34 },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  hero: { borderRadius: 24, overflow: 'hidden', padding: 20, gap: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  levelRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  levelName: { fontSize: 30, lineHeight: 36, fontWeight: '800' },
  partnerTag: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  sharePct: { fontSize: 22, lineHeight: 28, fontWeight: '800' },
  nextChip: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  progress: { borderWidth: 1, borderRadius: 16, padding: 16 },
  progressTop: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  volume: { fontSize: 28, lineHeight: 34, fontWeight: '800', marginTop: 4 },
  track: { height: 14, borderRadius: 7, overflow: 'hidden', marginTop: 16 },
  fill: { height: '100%', borderRadius: 7 },
  progressFoot: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  grid2: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  levelCard: { width: '47%', flexGrow: 1, borderWidth: 1, borderRadius: 16, padding: 14, overflow: 'hidden' },
  levelStrip: { position: 'absolute', left: 0, right: 0, top: 0, height: 4 },
  levelHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  currentTag: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  check: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  levelPct: { fontSize: 22, lineHeight: 28, fontWeight: '800' },
  statTile: { width: '47%', flexGrow: 1, borderWidth: 1, borderRadius: 16, padding: 14 },
  statIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  card: { borderWidth: 1, borderRadius: 16, padding: 20 },
  noPad: { padding: 0, overflow: 'hidden' },
  chartHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 16 },
  emptyChart: { height: 150, alignItems: 'center', justifyContent: 'center' },
  bars: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8, height: 130 },
  barCol: { flex: 1, height: '100%', alignItems: 'center', justifyContent: 'flex-end' },
  bar: { width: '100%', maxWidth: 34, borderTopLeftRadius: 6, borderTopRightRadius: 6, backgroundColor: '#16A34A' },
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, paddingHorizontal: 2 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1 },
  filters: { paddingHorizontal: 20, paddingVertical: 12, gap: 8, borderBottomWidth: 1 },
  state: { paddingHorizontal: 20, paddingVertical: 48 },
  refRow: { paddingHorizontal: 20, paddingVertical: 12 },
  avatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  refFigures: { flexDirection: 'row', gap: 12 },
  volTrack: { height: 6, width: 112, borderRadius: 3, overflow: 'hidden', marginTop: 4 },
  volFill: { height: '100%', borderRadius: 3, backgroundColor: '#2563EB' },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 12, borderTopWidth: 1 },
  pagerBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  overviewGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  overviewCell: { width: '50%', padding: 16, borderRightWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, gap: 4 },
  available: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1 },
  commission: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 12 },
  codeBox: { flex: 1, minWidth: 0, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  code: { fontSize: 20, lineHeight: 26, fontWeight: '800', letterSpacing: 1.5 },
  copyPrimary: { borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12 },
  copySecondary: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12 },
  shareRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  shareBtn: { borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10 },
  shareLink: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
  qrWrap: { alignItems: 'center', gap: 12, paddingTop: 16, borderTopWidth: 1 },
  qrBox: { width: 160, height: 160, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', padding: 12 },
  qrDashed: { borderStyle: 'dashed', borderWidth: 2 },
  qrFrame: { padding: 10, borderRadius: 16, borderWidth: 1, backgroundColor: '#FFFFFF' },
  qr: { width: 160, height: 160, borderRadius: 8 },
  skelHero: { height: 192, borderRadius: 24 },
  skelTile: { width: '47%', flexGrow: 1, height: 96, borderRadius: 16 },
  skelChart: { height: 256, borderRadius: 16 },
});
