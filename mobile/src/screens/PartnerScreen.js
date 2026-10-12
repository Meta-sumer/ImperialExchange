import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, RefreshControl,
  Alert, Share, Linking, StyleSheet, useWindowDimensions,
} from 'react-native';
import Svg, { Path, Rect, Circle, Ellipse, Defs, RadialGradient, Stop, Text as SvgText } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { useColors, radius, fmtNum, currencySymbol } from '../theme';
import { Skeleton, Empty } from '../components/ui';
import { API_BASE_URL } from '../config';

/**
 * PartnerScreen — native 1:1 port of the web client's Partner / Referral
 * dashboard (client/src/pages/Partner.jsx). VOLUME-DRIVEN. Mirrors it
 * section-for-section:
 *   paused banner · hero (metallic tier badge + revenue-share % + prev-month
 *   volume progress) · first-deposit-reward card · partner levels (5 tiers) ·
 *   stats tiles · charts (volume area + commission bars) · referral
 *   performance (search + date range + pagination) · commission overview +
 *   recent commissions · referral link (copy / share).
 *
 * Same endpoints the web calls:
 *   GET /partner/volume-dashboard   — level, volume, tiers, stats, per-referral
 *                                     performance, 6-month series (charts)
 *   GET /partner/commissions?limit=8 — recent commission ledger
 * Live updates ride subscriptionWallet / bonusWallet / notifications WS.
 */

// ─── Optional clipboard (expo-clipboard → @react-native-clipboard → Alert) ──
// Neither lib is a hard dependency; guarded requires keep the bundle building
// and degrade to an Alert showing the text for manual copy when absent.
let ClipboardLib = null;
try { ClipboardLib = require('expo-clipboard'); } catch (e) {
  try { const m = require('@react-native-clipboard/clipboard'); ClipboardLib = m.default || m; } catch (e2) { ClipboardLib = null; }
}
async function copyText(text) {
  if (!text) return false;
  try {
    if (ClipboardLib?.setStringAsync) { await ClipboardLib.setStringAsync(text); return true; }
    if (ClipboardLib?.setString) { ClipboardLib.setString(text); return true; }
  } catch (e) { /* fall through */ }
  return false;
}

// ─── Volume-tier visual language (metallic) — verbatim from the web ─────────
const LEVEL_META = {
  BRONZE:   { label: 'Bronze',   from: '#D08B45', to: '#7C3A12', accent: '#F0A357', glow: 'rgba(217,119,6,0.45)',  text: '#3B1A06' },
  SILVER:   { label: 'Silver',   from: '#CBD5E1', to: '#64748B', accent: '#E2E8F0', glow: 'rgba(148,163,184,0.5)', text: '#1F2937' },
  GOLD:     { label: 'Gold',     from: '#FCD34D', to: '#B7791F', accent: '#FDE68A', glow: 'rgba(245,158,11,0.55)', text: '#3B2A06' },
  PLATINUM: { label: 'Platinum', from: '#6EE7DF', to: '#0E7490', accent: '#A5F3EC', glow: 'rgba(45,212,191,0.5)',  text: '#06322F' },
  ELITE:    { label: 'Elite',    from: '#A78BFA', to: '#4338CA', accent: '#C4B5FD', glow: 'rgba(124,58,237,0.55)', text: '#1E1B4B' },
};
const ORDER = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'ELITE'];
const metaFor = (name) => LEVEL_META[String(name || '').toUpperCase()] || LEVEL_META.BRONZE;

// ─── Formatters (module scope — never reference `c` / `styles`) ─────────────
const usdFull = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const usdCompact = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(v % 1e9 === 0 ? 0 : 1) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(v % 1e3 === 0 ? 0 : 1) + 'K';
  return '$' + Math.round(v).toLocaleString('en-US');
};
// fmtMoney/fmtDate mirror the web utils, built on the shared theme helpers.
const fmtMoney = (v, cur = 'USD') => `${currencySymbol(cur)}${fmtNum(v, 2)}`;
const fmtDate = (d) => { if (!d) return '-'; const t = new Date(d); return isNaN(t.getTime()) ? '-' : t.toLocaleString('en-IN'); };
function relTime(d) {
  if (!d) return '—';
  const diff = Date.now() - new Date(d).getTime();
  if (diff < 0) return 'just now';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDate(d);
}

// ─── Date-range helpers (ported from web utils/dateRange — inCustomRange) ───
const DAY_MS = 24 * 60 * 60 * 1000;
function dayStart(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}
function nextDayStart(value) { const s = dayStart(value); return s ? new Date(s.getTime() + DAY_MS) : null; }
function inCustomRange(value, from, to) {
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return false;
  const s = dayStart(from); if (s && t < s.getTime()) return false;
  const e = nextDayStart(to); if (e && t >= e.getTime()) return false;
  return true;
}
// Native adaptation of the web's two <input type="date"> fields: preset pills
// (no date-picker dependency) resolved to a {from,to} window fed to inCustomRange.
const RANGE_PILLS = [
  { key: 'all', label: 'All' }, { key: 'today', label: 'Today' },
  { key: '7d', label: '7D' }, { key: '30d', label: '30D' }, { key: '90d', label: '90D' },
];
function presetRange(key) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ago = (n) => new Date(today.getTime() - n * DAY_MS);
  switch (key) {
    case 'today': return { from: today, to: today };
    case '7d': return { from: ago(6), to: today };
    case '30d': return { from: ago(29), to: today };
    case '90d': return { from: ago(89), to: today };
    default: return { from: null, to: null };
  }
}

// ─── Stat-tile tints + recent-commission source labels (from the web) ───────
const TINTS = {
  green:  { fg: '#16A34A', bg: 'rgba(0,200,83,0.12)' },
  blue:   { fg: '#2563EB', bg: 'rgba(37,99,235,0.12)' },
  violet: { fg: '#7C3AED', bg: 'rgba(124,58,237,0.12)' },
  amber:  { fg: '#D97706', bg: 'rgba(217,119,6,0.12)' },
  slate:  { fg: '#475569', bg: 'rgba(71,85,105,0.12)' },
};
const SRC = { DEPOSIT_BONUS: 'First-deposit bonus', TRADE_FEE: 'Profit share', SPREAD: 'Profit share', ADJUSTMENT: 'Admin credit' };

// Unique-id sequence for SVG gradient defs (multiple badges share tier names).
let BADGE_SEQ = 0;

// ─── Smooth count-up — animates prev → next on change (mirrors the web) ─────
function useCountUp(target, { duration = 800 } = {}) {
  const [val, setVal] = useState(Number(target) || 0);
  const fromRef = useRef(Number(target) || 0);
  useEffect(() => {
    const from = fromRef.current;
    const to = Number(target) || 0;
    if (from === to) { setVal(to); return undefined; }
    let raf;
    const start = Date.now();
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setVal(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

// ═══════════════════════════════════════════════════════════════════════════
// Screen
// ═══════════════════════════════════════════════════════════════════════════
export default function PartnerScreen({ navigation }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const [d, setD] = useState(null);
  const [commissions, setCommissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    try {
      const [vd, cm] = await Promise.all([
        api.get('/partner/volume-dashboard'),
        api.get('/partner/commissions?limit=8').catch(() => ({ data: { data: [] } })),
      ]);
      setD(vd.data.data);
      setCommissions(cm.data.data || []);
      setErr('');
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    const offW = wsClient.subscribe('subscriptionWallet', () => refresh());
    const offB = wsClient.subscribe('bonusWallet', () => refresh());
    const offN = wsClient.subscribe('notifications', (m) => { if (m?.type === 'PARTNER_BONUS') refresh(); });
    return () => { offW && offW(); offB && offB(); offN && offN(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRefresh = async () => { setRefreshing(true); await refresh(); setRefreshing(false); };

  // Derive the public origin from the API base (strip the trailing /api) — the
  // native equivalent of the web's VITE_PUBLIC_URL / VITE_API_URL derivation.
  const PUBLIC_ORIGIN = useMemo(
    () => String(API_BASE_URL || '').replace(/\/api\/?$/, '').replace(/\/+$/, ''),
    [],
  );

  if (loading && !d) return <DashboardSkeleton styles={styles} c={c} />;
  if (err && !d) return <Empty title="Couldn't load partner dashboard" sub={err} />;
  if (!d) return <DashboardSkeleton styles={styles} c={c} />;

  const code = d.referralCode || '';
  const link = code ? `${PUBLIC_ORIGIN}/register?ref=${code}` : '';
  const cur = d.walletCurrency || 'USD';

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary500} />}
      >
        {d.enabled === false && (
          <View style={styles.banner}>
            <Text style={styles.bannerTxt}>
              The partner program is currently paused by the administrator. New commissions won't be credited.
            </Text>
          </View>
        )}

        <HeroCard d={d} styles={styles} c={c} />
        <FirstDepositRewardCard bonus={d.firstDepositBonus} cur={cur} styles={styles} c={c} />
        <LevelsSection d={d} styles={styles} c={c} />
        <StatsSection d={d} cur={cur} styles={styles} c={c} />
        <ChartsSection series={d.monthlySeries} cur={cur} styles={styles} c={c} />
        <ReferralPerformance rows={d.referralPerformance} cur={cur} styles={styles} c={c} />
        <CommissionOverview d={d} cur={cur} styles={styles} c={c} />
        <RecentCommissions rows={commissions} cur={cur} styles={styles} c={c} />
        <ReferralLinkSection code={code} link={link} styles={styles} c={c} />
      </ScrollView>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Metallic badge — react-native-svg gradient disc + shine + tier initial
// ═══════════════════════════════════════════════════════════════════════════
function MetallicBadge({ tier, size = 96 }) {
  const m = metaFor(tier);
  const idRef = useRef(`mb-${++BADGE_SEQ}`);
  const gid = `${idRef.current}-g`;
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Defs>
          <RadialGradient id={gid} cx="35%" cy="28%" r="80%">
            <Stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
            <Stop offset="28%" stopColor={m.from} />
            <Stop offset="100%" stopColor={m.to} />
          </RadialGradient>
        </Defs>
        <Circle cx="50" cy="50" r="46" fill={`url(#${gid})`} stroke="rgba(255,255,255,0.55)" strokeWidth="1.5" />
        <Circle cx="50" cy="50" r="38" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
        <Ellipse cx="38" cy="30" rx="22" ry="12" fill="rgba(255,255,255,0.35)" />
        <SvgText x="50" y="63" textAnchor="middle" fontSize="34" fontWeight="900" fill={m.text}>
          {m.label.charAt(0)}
        </SvgText>
      </Svg>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// HERO — level badge + revenue share + previous-month volume progress
// ═══════════════════════════════════════════════════════════════════════════
function HeroCard({ d, styles }) {
  const m = metaFor(d.partnerLevel);
  const next = d.nextLevel;
  const vol = useCountUp(d.previousMonthVolume ?? d.totalReferralVolume);
  const pct = useCountUp(d.progressPercent, { duration: 900 });
  const width = `${Math.max(0, Math.min(100, Number(d.progressPercent) || 0))}%`;

  return (
    <View style={styles.hero}>
      <View style={styles.heroTopRow}>
        <MetallicBadge tier={d.partnerLevel} size={92} />
        <View style={styles.heroInfo}>
          <Text style={styles.heroEyebrow}>CURRENT TIER {d.tierLocked ? '· 🔒 LOCKED' : ''}</Text>
          <View style={styles.heroLevelRow}>
            <Text style={styles.heroLevel}>{m.label}</Text>
            <View style={styles.heroPartnerChip}><Text style={styles.heroPartnerChipTxt}>PARTNER</Text></View>
          </View>
          <View style={styles.heroShareRow}>
            <Text style={[styles.heroPct, { color: m.accent }]}>{d.revenueSharePercent}%</Text>
            <Text style={styles.heroPctLabel}>profit share on referral fees</Text>
          </View>
          {next ? (
            <View style={styles.heroNextChip}>
              <Text style={[styles.heroNextChipTxt, { color: metaFor(next.name).accent }]}>▲ </Text>
              <Text style={styles.heroNextChipTxt}>
                Next: <Text style={{ fontWeight: '800' }}>{metaFor(next.name).label}</Text> · {next.percent}% at {usdCompact(next.minVolume)}+
              </Text>
            </View>
          ) : (
            <View style={styles.heroNextChip}>
              <Text style={styles.heroNextChipTxt}>👑 Top tier unlocked — maximum profit share</Text>
            </View>
          )}
        </View>
      </View>

      {/* Volume progress panel */}
      <View style={styles.heroPanel}>
        <View style={styles.heroPanelRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.heroPanelCap}>PREVIOUS MONTH VOLUME</Text>
            <Text style={styles.heroPanelBig}>{usdFull(vol)}</Text>
            <Text style={styles.heroPanelNote}>Determines this month's tier</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={styles.heroPanelCap}>{next ? `${metaFor(next.name).label} REQUIREMENT` : 'TIER REQUIREMENT'}</Text>
            <Text style={styles.heroPanelSmall}>{next ? usdFull(next.minVolume) : 'MAX'}</Text>
            <Text style={styles.heroPanelNote}>This month so far: {usdFull(d.currentMonthVolume || 0)}</Text>
          </View>
        </View>

        <View style={styles.heroBarTrack}>
          <View style={[styles.heroBarFill, { width, backgroundColor: m.accent }]} />
        </View>

        <View style={styles.heroBarRow}>
          <Text style={[styles.heroBarPct, { color: m.accent }]}>{pct.toFixed(1)}% complete</Text>
          {next ? (
            <Text style={styles.heroBarNote}>
              <Text style={styles.heroBarNoteStrong}>{usdFull(d.volumeToNextLevel)}</Text> more to unlock{' '}
              <Text style={{ color: metaFor(next.name).accent, fontWeight: '800' }}>{metaFor(next.name).label} ({next.percent}%)</Text>
            </Text>
          ) : (
            <Text style={styles.heroBarNote}>You've reached the highest partner tier.</Text>
          )}
        </View>
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// FIRST DEPOSIT REWARD — campaign banner (admin-configurable)
// ═══════════════════════════════════════════════════════════════════════════
function FirstDepositRewardCard({ bonus, cur, styles, c }) {
  if (!bonus || bonus.enabled === false) return null;
  const amt = Number(bonus.amount) || 0;
  if (amt <= 0) return null;
  const currency = bonus.currency || cur || 'USD';
  return (
    <View style={styles.rewardCard}>
      <View style={styles.rewardIcon}><Text style={{ fontSize: 26 }}>🎁</Text></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.rewardTitleRow}>
          <Text style={styles.rewardTitle}>First Deposit Reward</Text>
          <View style={styles.rewardActivePill}><Text style={styles.rewardActivePillTxt}>ACTIVE</Text></View>
        </View>
        <Text style={styles.rewardText}>
          Earn <Text style={{ color: c.bull, fontWeight: '800' }}>{fmtMoney(amt, currency)}</Text> when your referral makes their
          first deposit of <Text style={{ color: c.textPrimary, fontWeight: '800' }}>{fmtMoney(bonus.minDeposit, currency)}</Text> or more.
        </Text>
        <Text style={styles.rewardSub}>Paid to you automatically, once per referral, on their first qualifying deposit.</Text>
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PARTNER LEVELS
// ═══════════════════════════════════════════════════════════════════════════
function LevelsSection({ d, styles, c }) {
  const tiers = (d.tiers && d.tiers.length ? d.tiers : ORDER.map((n) => ({ name: n, minVolume: 0, percent: 0 })))
    .slice()
    .sort((a, b) => a.minVolume - b.minVolume);
  const currentIdx = tiers.findIndex((t) => t.name === d.partnerLevel);
  return (
    <View style={styles.sectionWrap}>
      <SectionTitle
        title="Partner Levels"
        sub="Your tier is set on the 1st of each month from the PREVIOUS month's referral trading volume, then fixed for the whole month."
        styles={styles}
      />
      <View style={styles.grid}>
        {tiers.map((t, i) => (
          <LevelCard key={t.name} tier={t} state={i < currentIdx ? 'cleared' : i === currentIdx ? 'current' : 'locked'} styles={styles} c={c} />
        ))}
      </View>
    </View>
  );
}

function LevelCard({ tier, state, styles, c }) {
  const m = metaFor(tier.name);
  const isCurrent = state === 'current';
  const isLocked = state === 'locked';
  return (
    <View style={[styles.levelCard, isCurrent && { backgroundColor: m.from, borderColor: 'transparent' }, isLocked && { opacity: 0.7 }]}>
      {!isCurrent && <View style={[styles.levelTopBar, { backgroundColor: m.from }]} />}
      <View style={styles.levelHeadRow}>
        <MetallicBadge tier={tier.name} size={isCurrent ? 44 : 38} />
        {isCurrent ? (
          <View style={styles.levelStateCurrent}><Text style={styles.levelStateCurrentTxt}>CURRENT</Text></View>
        ) : isLocked ? (
          <Ionicons name="lock-closed" size={15} color={c.textMuted} />
        ) : (
          <View style={styles.levelCheck}><Ionicons name="checkmark" size={13} color={c.bull} /></View>
        )}
      </View>
      <Text style={[styles.levelName, { color: isCurrent ? '#fff' : c.textPrimary }]}>{m.label}</Text>
      <Text style={[styles.levelReq, { color: isCurrent ? 'rgba(255,255,255,0.85)' : c.textMuted }]}>
        {tier.minVolume > 0 ? `${usdCompact(tier.minVolume)}+ volume` : 'Starter tier'}
      </Text>
      <View style={styles.levelPctRow}>
        <Text style={[styles.levelPct, { color: isCurrent ? '#fff' : m.to }]}>{tier.percent}%</Text>
        <Text style={[styles.levelPctLabel, { color: isCurrent ? 'rgba(255,255,255,0.8)' : c.textMuted }]}>profit share</Text>
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// STATISTICS
// ═══════════════════════════════════════════════════════════════════════════
function StatsSection({ d, cur, styles, c }) {
  const cards = [
    { label: 'Total One-Side Volume',   value: usdFull(d.totalOneSideVolume ?? d.totalReferralVolume), icon: 'trending-up',     tint: 'blue' },
    { label: 'Pending Volume',          value: usdFull(d.pendingVolume ?? 0),                            icon: 'time-outline',    tint: 'amber' },
    { label: 'Commissioned Volume',     value: usdFull(d.commissionedVolume ?? 0),                       icon: 'cash-outline',    tint: 'green' },
    { label: 'Total Commission Earned', value: fmtMoney(d.revenueShareEarned ?? d.totalCommissionEarned, cur), icon: 'cash-outline', tint: 'green' },
    { label: 'Previous Month Volume',   value: usdFull(d.previousMonthVolume),                           icon: 'calendar-outline', tint: 'violet' },
    { label: 'Commission Rate',         value: `${d.revenueSharePercent}%`,                              icon: 'pricetag-outline', tint: 'green' },
    { label: 'Total Referrals',         value: String(d.totalReferrals ?? 0),                            icon: 'people-outline',  tint: 'slate' },
    { label: 'Pending Commission',      value: fmtMoney(d.pendingCommission, cur),                       icon: 'time-outline',    tint: 'amber' },
  ];
  return (
    <View style={styles.grid}>
      {cards.map((card) => <StatTile key={card.label} {...card} styles={styles} c={c} />)}
    </View>
  );
}

function StatTile({ label, value, icon, tint = 'slate', styles, c }) {
  const t = TINTS[tint] || TINTS.slate;
  return (
    <View style={styles.statTile}>
      <View style={styles.statTop}>
        <View style={[styles.statIcon, { backgroundColor: t.bg }]}>
          <Ionicons name={icon} size={17} color={t.fg} />
        </View>
        <Text style={styles.statLabel} numberOfLines={2}>{label.toUpperCase()}</Text>
      </View>
      <Text style={styles.statValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CHARTS — volume area + commission bars (react-native-svg)
// ═══════════════════════════════════════════════════════════════════════════
function ChartsSection({ series = [], cur, styles, c }) {
  const { width: winW } = useWindowDimensions();
  const chartW = Math.max(240, Math.round(winW) - 64); // screen pad (16*2) + card pad (16*2)
  const safe = series.length ? series : [];
  return (
    <View style={{ gap: 14, marginTop: 4 }}>
      <ChartCard
        title="Trading Volume Growth" sub="Referral notional volume · last 6 months"
        total={usdFull(safe.reduce((s, p) => s + (p.volume || 0), 0))} tint="#2563EB" styles={styles}
      >
        <AreaChart data={safe.map((p) => ({ label: p.label, value: p.volume }))} width={chartW} stroke="#2563EB" fill="rgba(37,99,235,0.18)" styles={styles} c={c} />
      </ChartCard>
      <ChartCard
        title="Commission Earnings" sub="Earned per month · last 6 months"
        total={fmtMoney(safe.reduce((s, p) => s + (Number(p.commission) || 0), 0), cur)} tint="#16A34A" styles={styles}
      >
        <BarChart data={safe.map((p) => ({ label: p.label, value: Number(p.commission) || 0 }))} width={chartW} color="#16A34A" styles={styles} c={c} />
      </ChartCard>
    </View>
  );
}

function ChartCard({ title, sub, total, tint = '#2563EB', styles, children }) {
  return (
    <View style={styles.card}>
      <View style={styles.chartHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.chartTitle}>{title}</Text>
          <Text style={styles.chartSub}>{sub}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.chartTotalCap}>TOTAL</Text>
          <Text style={[styles.chartTotalVal, { color: tint }]}>{total}</Text>
        </View>
      </View>
      {children}
    </View>
  );
}

function AreaChart({ data = [], width, stroke = '#2563EB', fill = 'rgba(37,99,235,0.18)', styles, c }) {
  const H = 130, P = 6;
  if (!data.length) return <EmptyChart styles={styles} />;
  const W = width;
  const max = Math.max(...data.map((x) => x.value), 1);
  const stepX = (W - P * 2) / Math.max(1, data.length - 1);
  const y = (v) => H - P - (v / max) * (H - P * 2 - 14);
  const pts = data.map((x, i) => [P + i * stepX, y(x.value)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L ${pts[pts.length - 1][0].toFixed(1)} ${H - P} L ${pts[0][0].toFixed(1)} ${H - P} Z`;
  return (
    <View>
      <Svg width={W} height={H}>
        <Path d={area} fill={fill} />
        <Path d={line} fill="none" stroke={stroke} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        {pts.map((p, i) => <Circle key={i} cx={p[0]} cy={p[1]} r={3} fill={c.card} stroke={stroke} strokeWidth={2} />)}
      </Svg>
      <ChartAxis labels={data.map((x) => x.label)} styles={styles} />
    </View>
  );
}

function BarChart({ data = [], width, color = '#16A34A', styles }) {
  const H = 130;
  if (!data.length) return <EmptyChart styles={styles} />;
  const W = width;
  const max = Math.max(...data.map((x) => x.value), 1);
  const n = data.length;
  const slot = W / n;
  const barW = Math.min(34, slot * 0.5);
  return (
    <View>
      <Svg width={W} height={H}>
        {data.map((x, i) => {
          const h = Math.max(2, (x.value / max) * (H - 10));
          const bx = slot * i + slot / 2 - barW / 2;
          return <Rect key={i} x={bx} y={H - h} width={barW} height={h} rx={4} fill={color} />;
        })}
      </Svg>
      <ChartAxis labels={data.map((x) => x.label)} styles={styles} />
    </View>
  );
}

function ChartAxis({ labels, styles }) {
  return (
    <View style={styles.axisRow}>
      {labels.map((l, i) => <Text key={i} style={styles.axisLabel}>{l}</Text>)}
    </View>
  );
}
function EmptyChart({ styles }) {
  return <View style={styles.emptyChart}><Text style={styles.emptyChartTxt}>No data yet — activity will appear here.</Text></View>;
}

// ═══════════════════════════════════════════════════════════════════════════
// REFERRAL PERFORMANCE — search + date range (preset pills) + pagination
// ═══════════════════════════════════════════════════════════════════════════
function ReferralPerformance({ rows = [], cur, styles, c }) {
  const PAGE_SIZE = 8;
  const [q, setQ] = useState('');
  const [rangeKey, setRangeKey] = useState('all');
  const [page, setPage] = useState(1);

  const maxVol = Math.max(...rows.map((r) => r.volume || 0), 1);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const { from, to } = presetRange(rangeKey);
    return rows.filter((r) => {
      if (term && !`${r.name || ''} ${r.email || ''}`.toLowerCase().includes(term)) return false;
      if (from || to) { if (!r.lastActivityAt || !inCustomRange(r.lastActivityAt, from, to)) return false; }
      return true;
    });
  }, [rows, q, rangeKey]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(start, start + PAGE_SIZE);
  const hasFilters = !!(q.trim() || rangeKey !== 'all');

  const onSearch = (v) => { setQ(v); setPage(1); };
  const onRange = (k) => { setRangeKey(k); setPage(1); };
  const clearFilters = () => { setQ(''); setRangeKey('all'); setPage(1); };

  return (
    <View style={[styles.card, { padding: 0, marginTop: 14 }]}>
      <View style={styles.rpHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rpTitle}>Referral Performance</Text>
          <Text style={styles.rpSub}>Top traders by trading volume</Text>
        </View>
        <Text style={styles.rpCount}>
          {hasFilters ? `${filtered.length} of ${rows.length}` : `${rows.length} referral${rows.length === 1 ? '' : 's'}`}
        </Text>
      </View>

      {rows.length > 0 && (
        <View style={styles.rpFilters}>
          <View style={styles.rpSearch}>
            <Ionicons name="search" size={15} color={c.textMuted} />
            <TextInput
              value={q}
              onChangeText={onSearch}
              placeholder="Search name or email…"
              placeholderTextColor={c.textMuted}
              style={styles.rpSearchInput}
            />
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rangePillRow}>
            {RANGE_PILLS.map((p) => {
              const on = rangeKey === p.key;
              return (
                <TouchableOpacity key={p.key} onPress={() => onRange(p.key)} style={[styles.rangePill, on && styles.rangePillOn]}>
                  <Text style={[styles.rangePillTxt, on && styles.rangePillTxtOn]}>{p.label}</Text>
                </TouchableOpacity>
              );
            })}
            {hasFilters && (
              <TouchableOpacity onPress={clearFilters} style={styles.rangePill}>
                <Text style={[styles.rangePillTxt, { color: c.primary500 }]}>Clear</Text>
              </TouchableOpacity>
            )}
          </ScrollView>
        </View>
      )}

      {rows.length === 0 ? (
        <View style={styles.rpEmpty}><Text style={styles.rpEmptyTxt}>No referrals yet — share your link to start earning.</Text></View>
      ) : filtered.length === 0 ? (
        <View style={styles.rpEmpty}><Text style={styles.rpEmptyTxt}>No referrals match your search or date range.</Text></View>
      ) : (
        <>
          {pageRows.map((r) => <ReferralRow key={r.id} r={r} cur={cur} maxVol={maxVol} styles={styles} c={c} />)}
          {filtered.length > PAGE_SIZE && (
            <View style={styles.pageRow}>
              <Text style={styles.pageInfo}>Showing {start + 1}–{Math.min(start + PAGE_SIZE, filtered.length)} of {filtered.length}</Text>
              <View style={styles.pageBtns}>
                <TouchableOpacity disabled={safePage <= 1} onPress={() => setPage(safePage - 1)} style={[styles.pageBtn, safePage <= 1 && styles.pageBtnOff]}>
                  <Text style={styles.pageBtnTxt}>Prev</Text>
                </TouchableOpacity>
                <Text style={styles.pageNum}>{safePage} / {totalPages}</Text>
                <TouchableOpacity disabled={safePage >= totalPages} onPress={() => setPage(safePage + 1)} style={[styles.pageBtn, safePage >= totalPages && styles.pageBtnOff]}>
                  <Text style={styles.pageBtnTxt}>Next</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </>
      )}
    </View>
  );
}

function ReferralRow({ r, cur, maxVol, styles, c }) {
  const active = r.status === 'ACTIVE';
  const barW = `${Math.max(0, Math.min(100, (r.volume / maxVol) * 100))}%`;
  return (
    <View style={styles.refRow}>
      <View style={styles.refTop}>
        <Avatar name={r.name} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.refName} numberOfLines={1}>{r.name}</Text>
          <Text style={styles.refEmail} numberOfLines={1}>{r.email}</Text>
        </View>
        <View style={[styles.statusPill, { backgroundColor: active ? c.bullSoft : c.hover }]}>
          <Text style={[styles.statusPillTxt, { color: active ? c.bull : c.textMuted }]}>{active ? 'ACTIVE' : 'IDLE'}</Text>
        </View>
      </View>

      <View style={styles.refVolRow}>
        <Text style={styles.refVol}>{usdFull(r.volume)}</Text>
        <Text style={[styles.refCommission, { color: c.bull }]}>{fmtMoney(r.commission, cur)}</Text>
      </View>
      <View style={styles.refBar}><View style={[styles.refBarFill, { width: barW }]} /></View>

      <View style={styles.refMetaRow}>
        {(r.pendingVolume != null && r.commissionedVolume != null) ? (
          <Text style={styles.refSubLine}>
            <Text style={{ color: '#D97706' }}>{usdCompact(r.pendingVolume)} pending</Text>
            <Text style={{ color: c.textMuted }}>  ·  </Text>
            <Text style={{ color: c.bull }}>{usdCompact(r.commissionedVolume)} done</Text>
          </Text>
        ) : <View />}
        <Text style={styles.refLastAct}>{relTime(r.lastActivityAt)}</Text>
      </View>
    </View>
  );
}

function Avatar({ name }) {
  const initials = String(name || '?').trim().split(/\s+/).slice(0, 2).map((s) => s[0]).join('').toUpperCase() || '?';
  const hue = [...String(name || '')].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360;
  return (
    <View style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: `hsl(${hue}, 65%, 48%)` }}>
      <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>{initials}</Text>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMISSION OVERVIEW + RECENT COMMISSIONS
// ═══════════════════════════════════════════════════════════════════════════
function CommissionOverview({ d, cur, styles, c }) {
  const rows = [
    { label: 'Total earned', value: fmtMoney(d.totalCommissionEarned, cur), tint: c.bull },
    { label: 'This month', value: fmtMoney(d.monthlyCommission, cur), tint: c.textPrimary },
    { label: 'Paid out', value: fmtMoney(d.paidCommission, cur), tint: c.textPrimary },
    { label: 'Pending', value: fmtMoney(d.pendingCommission, cur), tint: c.warn },
  ];
  return (
    <View style={[styles.card, { padding: 0, marginTop: 14 }]}>
      <View style={styles.coHead}>
        <Text style={styles.coTitle}>Commission Overview</Text>
        <View style={styles.coShareChip}><Text style={styles.coShareChipTxt}>{d.revenueSharePercent}% SHARE</Text></View>
      </View>
      <View style={styles.coGrid}>
        {rows.map((r) => (
          <View key={r.label} style={styles.coCell}>
            <Text style={styles.coCellLabel}>{r.label.toUpperCase()}</Text>
            <Text style={[styles.coCellVal, { color: r.tint }]}>{r.value}</Text>
          </View>
        ))}
      </View>
      <View style={styles.coFooter}>
        <Text style={styles.coFooterLabel}>Available balance</Text>
        <Text style={[styles.coFooterVal, { color: c.bull }]}>{fmtMoney(d.availableBalance, cur)}</Text>
      </View>
    </View>
  );
}

function RecentCommissions({ rows = [], cur, styles, c }) {
  if (!rows.length) return null;
  return (
    <View style={[styles.card, { padding: 0, marginTop: 14 }]}>
      <View style={styles.rcHead}><Text style={styles.rcTitle}>Recent commissions</Text></View>
      {rows.slice(0, 6).map((r) => (
        <View key={r._id} style={styles.rcRow}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.rcSrc} numberOfLines={1}>{SRC[r.sourceType] || r.sourceType}</Text>
            <Text style={styles.rcMeta} numberOfLines={1}>{r.refereeName || '—'} · {fmtDate(r.createdAt)}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[styles.rcAmt, { color: c.bull }]}>+{fmtMoney(r.amount, r.currency || cur)}</Text>
            <Text style={[styles.rcStatus, { color: r.status === 'PAID' ? '#16A34A' : '#3B82F6' }]}>{r.status}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// REFERRAL LINK — code / link copy + share (QR image omitted: no native lib)
// ═══════════════════════════════════════════════════════════════════════════
function ReferralLinkSection({ code, link, styles, c }) {
  const copy = async (text, label) => {
    if (!text) return;
    const ok = await copyText(text);
    if (ok) Alert.alert('Copied', label);
    else Alert.alert(label, text); // no clipboard lib — show the text for manual copy
  };
  const share = async () => {
    if (!link) return;
    try { await Share.share({ title: 'Join me on the platform', message: `Trade with my referral link: ${link}`, url: link }); }
    catch (e) { /* cancelled */ }
  };
  const openUrl = (url) => { if (url) Linking.openURL(url).catch(() => {}); };

  return (
    <View style={styles.sectionWrap}>
      <SectionTitle title="Invite & Earn" sub="Share your link — earn profit share on every referral's trading volume." styles={styles} />
      <View style={styles.linkCard}>
        <Text style={styles.linkLabel}>REFERRAL CODE</Text>
        <View style={styles.linkFieldRow}>
          <View style={styles.linkCode}><Text style={styles.linkCodeTxt} numberOfLines={1}>{code || '—'}</Text></View>
          <TouchableOpacity disabled={!code} onPress={() => copy(code, 'Code copied')} style={[styles.copyBtn, !code && { opacity: 0.5 }]}>
            <Text style={styles.copyBtnTxt}>Copy</Text>
          </TouchableOpacity>
        </View>

        <Text style={[styles.linkLabel, { marginTop: 16 }]}>REFERRAL LINK</Text>
        <View style={styles.linkFieldRow}>
          <View style={styles.linkCode}><Text style={styles.linkUrlTxt} numberOfLines={1}>{link || '—'}</Text></View>
          <TouchableOpacity disabled={!link} onPress={() => copy(link, 'Link copied')} style={[styles.copyBtnGhost, !link && { opacity: 0.5 }]}>
            <Text style={styles.copyBtnGhostTxt}>Copy</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.shareRow}>
          <TouchableOpacity disabled={!link} onPress={share} style={[styles.shareBtn, !link && { opacity: 0.5 }]}>
            <Ionicons name="share-social" size={16} color="#fff" />
            <Text style={styles.shareBtnTxt}>Share</Text>
          </TouchableOpacity>
          {!!link && (
            <>
              <ShareLinkBtn icon="logo-whatsapp" label="WhatsApp" onPress={() => openUrl(`https://wa.me/?text=${encodeURIComponent('Trade with my referral link: ' + link)}`)} styles={styles} c={c} />
              <ShareLinkBtn icon="send" label="Telegram" onPress={() => openUrl(`https://t.me/share/url?url=${encodeURIComponent(link)}`)} styles={styles} c={c} />
              <ShareLinkBtn icon="logo-twitter" label="X" onPress={() => openUrl(`https://twitter.com/intent/tweet?url=${encodeURIComponent(link)}`)} styles={styles} c={c} />
            </>
          )}
        </View>

        {/* QR image omitted — no QR library is installed in the app. The code
            and link above are shown prominently for scanning/copying instead. */}
        <View style={styles.qrNote}>
          <Ionicons name="qr-code-outline" size={16} color={c.textMuted} />
          <Text style={styles.qrNoteTxt}>Copy or share the link above to invite — in-app QR isn't available.</Text>
        </View>
      </View>
    </View>
  );
}

function ShareLinkBtn({ icon, label, onPress, styles, c }) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.shareLinkBtn}>
      <Ionicons name={icon} size={14} color={c.textSecondary} />
      <Text style={styles.shareLinkTxt}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── Shared atoms ───────────────────────────────────────────────────────────
function SectionTitle({ title, sub, styles }) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {sub ? <Text style={styles.sectionSub}>{sub}</Text> : null}
    </View>
  );
}

// ─── Loading skeleton (mirrors the web DashboardSkeleton) ───────────────────
function DashboardSkeleton({ styles }) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <Skeleton height={200} style={{ borderRadius: 18 }} />
      <View style={[styles.grid, { marginTop: 14 }]}>
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} height={120} width="48.5%" style={{ marginBottom: 12, borderRadius: 16 }} />)}
      </View>
      <View style={styles.grid}>
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} height={92} width="48.5%" style={{ marginBottom: 12, borderRadius: 16 }} />)}
      </View>
      <Skeleton height={200} style={{ borderRadius: 16, marginTop: 4 }} />
      <Skeleton height={200} style={{ borderRadius: 16, marginTop: 14 }} />
    </ScrollView>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Styles — makeStyles(c) + useColors() (no module-scope styles/c)
// ═══════════════════════════════════════════════════════════════════════════
const makeStyles = (c) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  content: { padding: 16, paddingBottom: 40, gap: 14 },

  // Paused banner
  banner: { backgroundColor: c.warnSoft, borderWidth: 1, borderColor: c.warn, borderRadius: radius.xl, padding: 14 },
  bannerTxt: { color: c.warn, fontSize: 13, fontWeight: '700' },

  // Hero
  hero: { backgroundColor: '#111A2E', borderRadius: 22, borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)', padding: 18, overflow: 'hidden' },
  heroTopRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  heroInfo: { flex: 1, minWidth: 0 },
  heroEyebrow: { fontSize: 10, fontWeight: '800', letterSpacing: 1.6, color: 'rgba(255,255,255,0.55)' },
  heroLevelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  heroLevel: { fontSize: 30, fontWeight: '900', color: '#fff', letterSpacing: -0.5 },
  heroPartnerChip: { backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  heroPartnerChipTxt: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  heroShareRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 6 },
  heroPct: { fontSize: 22, fontWeight: '900' },
  heroPctLabel: { fontSize: 12, color: 'rgba(255,255,255,0.7)', flexShrink: 1 },
  heroNextChip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginTop: 10, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  heroNextChipTxt: { color: '#fff', fontSize: 11, fontWeight: '600' },

  heroPanel: { marginTop: 16, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', borderRadius: 16, padding: 16 },
  heroPanelRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  heroPanelCap: { fontSize: 10, fontWeight: '800', letterSpacing: 1.2, color: 'rgba(255,255,255,0.55)' },
  heroPanelBig: { fontSize: 28, fontWeight: '900', color: '#fff', marginTop: 4, fontVariant: ['tabular-nums'] },
  heroPanelSmall: { fontSize: 18, fontWeight: '800', color: 'rgba(255,255,255,0.85)', marginTop: 4, fontVariant: ['tabular-nums'] },
  heroPanelNote: { fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 4 },
  heroBarTrack: { marginTop: 14, height: 14, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.10)', overflow: 'hidden' },
  heroBarFill: { height: '100%', borderRadius: 999 },
  heroBarRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginTop: 10 },
  heroBarPct: { fontSize: 12, fontWeight: '800' },
  heroBarNote: { flex: 1, textAlign: 'right', fontSize: 11, color: 'rgba(255,255,255,0.75)' },
  heroBarNoteStrong: { color: '#fff', fontWeight: '800' },

  // First-deposit reward
  rewardCard: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: c.card, borderWidth: 1, borderColor: 'rgba(16,185,129,0.35)', borderRadius: radius.xl, padding: 16 },
  rewardIcon: { width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(16,185,129,0.15)' },
  rewardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  rewardTitle: { fontSize: 15, fontWeight: '900', color: c.textPrimary },
  rewardActivePill: { backgroundColor: c.bullSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  rewardActivePillTxt: { fontSize: 9, fontWeight: '800', letterSpacing: 0.8, color: c.bull },
  rewardText: { fontSize: 13, color: c.textSecondary, marginTop: 4, lineHeight: 19 },
  rewardSub: { fontSize: 11, color: c.textMuted, marginTop: 4 },

  // Section title
  sectionWrap: { marginTop: 6 },
  sectionTitle: { fontSize: 18, fontWeight: '900', color: c.textPrimary, letterSpacing: -0.3 },
  sectionSub: { fontSize: 12, color: c.textSecondary, marginTop: 3, lineHeight: 17 },

  // Grids (level cards + stat tiles)
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },

  // Level card
  levelCard: { width: '48.5%', backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: 16, padding: 14, marginBottom: 12, overflow: 'hidden' },
  levelTopBar: { position: 'absolute', top: 0, left: 0, right: 0, height: 4 },
  levelHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  levelStateCurrent: { backgroundColor: 'rgba(255,255,255,0.2)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  levelStateCurrentTxt: { color: '#fff', fontSize: 9, fontWeight: '900', letterSpacing: 0.6 },
  levelCheck: { width: 20, height: 20, borderRadius: 10, backgroundColor: c.bullSoft, alignItems: 'center', justifyContent: 'center' },
  levelName: { fontSize: 15, fontWeight: '900', marginTop: 10 },
  levelReq: { fontSize: 11, fontWeight: '700', marginTop: 2 },
  levelPctRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 10 },
  levelPct: { fontSize: 22, fontWeight: '900' },
  levelPctLabel: { fontSize: 10, fontWeight: '700' },

  // Stat tile
  statTile: { width: '48.5%', backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: 16, padding: 14, marginBottom: 12 },
  statTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  statIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  statLabel: { flex: 1, fontSize: 10, fontWeight: '800', letterSpacing: 0.4, color: c.textMuted, lineHeight: 13 },
  statValue: { fontSize: 19, fontWeight: '900', color: c.textPrimary, marginTop: 12, fontVariant: ['tabular-nums'] },

  // Card (charts / lists)
  card: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: 16, padding: 16 },
  chartHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 14 },
  chartTitle: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
  chartSub: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  chartTotalCap: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6, color: c.textMuted },
  chartTotalVal: { fontSize: 15, fontWeight: '900', marginTop: 2, fontVariant: ['tabular-nums'] },
  axisRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  axisLabel: { fontSize: 10, color: c.textMuted, fontWeight: '600' },
  emptyChart: { height: 130, alignItems: 'center', justifyContent: 'center' },
  emptyChartTxt: { fontSize: 12, color: c.textMuted },

  // Referral performance
  rpHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  rpTitle: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
  rpSub: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  rpCount: { fontSize: 11, fontWeight: '700', color: c.textMuted },
  rpFilters: { padding: 12, borderBottomWidth: 1, borderBottomColor: c.borderSubtle, gap: 10 },
  rpSearch: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: c.bg, borderWidth: 1, borderColor: c.borderSubtle, borderRadius: 10, paddingHorizontal: 10, height: 40 },
  rpSearchInput: { flex: 1, fontSize: 13, color: c.textPrimary, padding: 0 },
  rangePillRow: { gap: 8, paddingRight: 8 },
  rangePill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg },
  rangePillOn: { borderColor: c.primary500, backgroundColor: c.primarySoft },
  rangePillTxt: { fontSize: 12, fontWeight: '700', color: c.textSecondary },
  rangePillTxtOn: { color: c.primary500 },

  refRow: { padding: 16, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  refTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  refName: { fontSize: 13, fontWeight: '800', color: c.textPrimary },
  refEmail: { fontSize: 10, color: c.textMuted, marginTop: 1, fontVariant: ['tabular-nums'] },
  statusPill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  statusPillTxt: { fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  refVolRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 12 },
  refVol: { fontSize: 14, fontWeight: '800', color: c.textPrimary, fontVariant: ['tabular-nums'] },
  refCommission: { fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] },
  refBar: { height: 6, borderRadius: 999, backgroundColor: c.hover, overflow: 'hidden', marginTop: 6 },
  refBarFill: { height: '100%', borderRadius: 999, backgroundColor: '#3B82F6' },
  refMetaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  refSubLine: { fontSize: 10, fontWeight: '700', fontVariant: ['tabular-nums'] },
  refLastAct: { fontSize: 11, color: c.textSecondary },

  rpEmpty: { padding: 40, alignItems: 'center' },
  rpEmptyTxt: { fontSize: 13, color: c.textMuted, textAlign: 'center' },
  pageRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14 },
  pageInfo: { fontSize: 11, color: c.textMuted, fontVariant: ['tabular-nums'] },
  pageBtns: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pageBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, borderWidth: 1, borderColor: c.border },
  pageBtnOff: { opacity: 0.4 },
  pageBtnTxt: { fontSize: 11, fontWeight: '700', color: c.textSecondary },
  pageNum: { fontSize: 11, fontWeight: '700', color: c.textMuted, fontVariant: ['tabular-nums'] },

  // Commission overview
  coHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  coTitle: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
  coShareChip: { backgroundColor: c.primarySoft, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  coShareChipTxt: { fontSize: 10, fontWeight: '900', letterSpacing: 0.5, color: c.primary500 },
  coGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  coCell: { width: '50%', padding: 16, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  coCellLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5, color: c.textMuted },
  coCellVal: { fontSize: 17, fontWeight: '900', marginTop: 4, fontVariant: ['tabular-nums'] },
  coFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: c.hover },
  coFooterLabel: { fontSize: 11, fontWeight: '700', color: c.textMuted },
  coFooterVal: { fontSize: 14, fontWeight: '900', fontVariant: ['tabular-nums'] },

  // Recent commissions
  rcHead: { padding: 16, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  rcTitle: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
  rcRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  rcSrc: { fontSize: 12, fontWeight: '700', color: c.textPrimary },
  rcMeta: { fontSize: 10, color: c.textMuted, marginTop: 1 },
  rcAmt: { fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  rcStatus: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5, marginTop: 1 },

  // Referral link
  linkCard: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: 16, padding: 16 },
  linkLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6, color: c.textMuted },
  linkFieldRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  linkCode: { flex: 1, minWidth: 0, backgroundColor: c.hover, borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 },
  linkCodeTxt: { fontSize: 18, fontWeight: '900', letterSpacing: 1, color: c.textPrimary },
  linkUrlTxt: { fontSize: 12, color: c.textSecondary },
  copyBtn: { backgroundColor: c.primary500, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  copyBtnTxt: { color: '#fff', fontSize: 13, fontWeight: '800' },
  copyBtnGhost: { borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  copyBtnGhostTxt: { color: c.textPrimary, fontSize: 13, fontWeight: '800' },
  shareRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  shareBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.bull, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10 },
  shareBtnTxt: { color: '#fff', fontSize: 13, fontWeight: '800' },
  shareLinkBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  shareLinkTxt: { color: c.textSecondary, fontSize: 12, fontWeight: '700' },
  qrNote: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, paddingTop: 14, borderTopWidth: 1, borderTopColor: c.borderSubtle },
  qrNoteTxt: { flex: 1, fontSize: 11, color: c.textMuted },
});
