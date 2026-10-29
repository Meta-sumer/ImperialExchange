import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { fetchDashboard, fetchLifetimeStats, fetchPerformanceSeries } from '@/api/dashboard.api';
import { partnerApi } from '@/api/partner.api';
import { fetchPositionHistory, loadAccountMetrics, retainAccountMetrics, useAccountMetricsStore } from '@/api/trading.api';
import { walletApi } from '@/api/wallet.api';
import { AppText, Button, Select } from '@/components/ui';
import { useAppNavigation } from '@/navigation/types';
import { useTheme } from '@/theme';
import type {
  AccountMetrics,
  DashboardSummary,
  LifetimeStats,
  Position,
  PositionHistorySummary,
  SeriesBucket,
} from '@/types/trading';
import type { UserAccount } from '@/types/user';
import type { BonusWallet, Deposit, Withdrawal } from '@/types/wallet';
import type { VolumeDashboard } from '@/types/partner';
import { EMPTY, fmtMarginLevel, fmtMoney, fmtNum, fmtSigned } from '@/utils/money';
import {
  PERF_RANGES,
  areaChartPaths,
  chartLabels,
  fmtOverviewDateTime,
  marginNote,
  metricsFailures,
  moneyFlows,
  openPositionCounts,
  overviewAccountRows,
  overviewTotalTrades,
  overviewWinRate,
  perfNet,
  perfPct,
  rangeNet,
  realAccounts,
  moveWalletLabel,
  recentMoves,
  signedPct,
  tradingTotals,
  trendPct,
  type AccountsState,
  type MetricsFailure,
  type PerfRange,
  type SourceReady,
  type WalletHubView,
} from '@/utils/walletLogic';

import { CardHeader, StatusPill, TintBadge, WalletCard } from '../RecentTransactions';

/** AccountOverview.jsx's inline tints — the same in both themes, as on the web. */
const TINT = {
  blue: '#1D4ED8',
  purple: '#8B5CF6',
  green: '#16A34A',
  red: '#DC2626',
  amber: '#F59E0B',
  sky: '#0EA5E9',
} as const;

/** A known amount, or null while its source has not answered. */
const numOrNull = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

interface Extras {
  loaded: boolean;
  bonus: BonusWallet | null;
  partner: VolumeDashboard | null;
  dashboard: DashboardSummary | null;
  closed: PositionHistorySummary | null;
  week: LifetimeStats | null;
  month: LifetimeStats | null;
  year: LifetimeStats | null;
}

const NO_EXTRAS: Extras = {
  loaded: false, bonus: null, partner: null, dashboard: null, closed: null, week: null, month: null, year: null,
};

const grab = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/**
 * The server's figures for every live account, kept live (a METRICS push
 * each risk sweep, a poll otherwise) for as long as the overview is shown.
 * PORT-RULINGS §1: displayed, never recomputed from ticks.
 */
function useLiveMetrics(accounts: readonly UserAccount[]): {
  byId: Record<string, AccountMetrics | null>;
  /** Live accounts whose figures failed to load and have never arrived. */
  failures: MetricsFailure[];
} {
  const ids = useMemo(() => realAccounts(accounts).map((a) => a.id).filter(Boolean), [accounts]);
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return undefined;
    const releases = key.split(',').map((id) => retainAccountMetrics(id));
    return () => { for (const r of releases) r(); };
  }, [key]);
  const byAccount = useAccountMetricsStore((s) => s.byAccount);
  const byId = useMemo(() => {
    const out: Record<string, AccountMetrics | null> = {};
    for (const id of ids) out[id] = byAccount[id]?.metrics ?? null;
    return out;
  }, [byAccount, ids]);
  const failures = useMemo(() => metricsFailures(ids, byAccount), [byAccount, ids]);
  return { byId, failures };
}

/**
 * Account Overview — EquityHub's components/AccountOverview.jsx, the
 * wallet's landing view: the total (the Bonus Wallet plus trading equity),
 * the Bonus Wallet card, the trading summary, the live accounts,
 * performance, the KPIs and the latest money movements. INR throughout.
 *
 * Differences from the web, all deliberate:
 *   • Equity, free / used margin, floating P&L and margin level are the
 *     server's account-metrics (PORT-RULINGS §1), summed over live accounts
 *     only (PORT-RULINGS §3). Until every live account's figures are in, the
 *     totals show a dash rather than a partial sum.
 *   • Margin Level is the lowest per-account level — see tradingTotals.
 *   • A figure whose request failed shows a dash, not "₹0.00".
 *   • Tables become row cards.
 */
export function OverviewView({
  accounts,
  accountsState,
  deposits,
  withdrawals,
  positions,
  ready,
  refreshKey,
  setView,
  onRetryAccounts,
}: {
  accounts: readonly UserAccount[];
  /**
   * Whether the account list has answered. Until it has (or when it failed)
   * the trading figures are unknown — not "no live accounts", which would
   * print ₹0.00 equity and a total that silently leaves the accounts out.
   */
  accountsState: AccountsState;
  deposits: readonly Deposit[];
  withdrawals: readonly Withdrawal[];
  positions: readonly Position[];
  /** Which of the page's sources have answered; the rest show a dash. */
  ready: SourceReady;
  /** Bumped by a pull-to-refresh — the extra figures re-load with it. */
  refreshKey: number;
  setView: (v: WalletHubView) => void;
  /** Re-load after the account list failed. */
  onRetryAccounts: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  const { byId, failures } = useLiveMetrics(accounts);

  const [extras, setExtras] = useState<Extras>(NO_EXTRAS);
  const [perfRange, setPerfRange] = useState<PerfRange>('1m');
  const [series, setSeries] = useState<SeriesBucket[]>([]);

  // AccountOverview.jsx:50-70 — every extra figure degrades on its own.
  useEffect(() => {
    let dead = false;
    void (async () => {
      const [bonus, partner, dashboard, closed, week, month, year] = await Promise.all([
        grab(walletApi.bonusWallet()),
        grab(partnerApi.volumeDashboard()),
        grab(fetchDashboard()),
        grab(fetchPositionHistory({ limit: 6 })),
        grab(fetchLifetimeStats({ days: 7 })),
        grab(fetchLifetimeStats({ days: 30 })),
        grab(fetchLifetimeStats({ days: 365 })),
      ]);
      if (dead) return;
      setExtras({ loaded: true, bonus, partner, dashboard, closed: closed?.summary ?? null, week, month, year });
    })();
    return () => { dead = true; };
  }, [refreshKey]);

  // AccountOverview.jsx:73-79 — the chart follows the range dropdown.
  useEffect(() => {
    let dead = false;
    fetchPerformanceSeries({ range: perfRange })
      .then((s) => { if (!dead) setSeries(s.buckets); })
      .catch(() => { if (!dead) setSeries([]); });
    return () => { dead = true; };
  }, [perfRange, refreshKey]);

  const totals = useMemo(() => tradingTotals(accounts, byId), [accounts, byId]);
  const rows = useMemo(() => overviewAccountRows([...accounts], byId), [accounts, byId]);
  const flows = useMemo(() => moneyFlows(deposits, withdrawals), [deposits, withdrawals]);
  const counts = useMemo(() => openPositionCounts(positions), [positions]);
  const recent = useMemo(() => recentMoves([...deposits], [...withdrawals]), [deposits, withdrawals]);

  // Every live account's server figures are in, AND the list of live
  // accounts is itself known (an unanswered list is not "none").
  const complete = accountsState === 'ready' && totals.complete;

  // The Main Wallet is retired — the Bonus Wallet took its job, so the total
  // is the Bonus Wallet plus trading equity.
  const refBal = extras.bonus ? numOrNull(extras.bonus.balance) : null;
  const tradingEq = complete ? totals.equity : null;
  const totalBal = refBal !== null && tradingEq !== null ? refBal + tradingEq : null;

  // A figure over a list that has not answered is unknown, not ₹0.00.
  const depositsTotal = ready.deposits ? flows.totalDeposits : null;
  const withdrawalsTotal = ready.withdrawals ? flows.totalWithdrawals : null;
  const pendingTotal = ready.withdrawals ? flows.pendingWithdrawals : null;

  const lifetime = extras.bonus
    ? numOrNull(extras.bonus.totalEarnings)
    : extras.partner ? numOrNull(extras.partner.totalCommissionEarned) : null;
  const partnerPaid = extras.partner ? numOrNull(extras.partner.paidCommission) : null;
  const partnerMonth = extras.partner ? numOrNull(extras.partner.monthlyCommission) : null;

  const net = perfNet(series);
  const pct = perfPct(net, totals.equity);
  const winRate = overviewWinRate(extras.dashboard, extras.closed);
  const totalTrades = overviewTotalTrades(extras.closed, extras.dashboard);
  const wins = extras.closed?.wins ?? 0;
  const losses = extras.closed?.losses ?? 0;
  const unreal = totals.unrealized;
  const note = complete ? marginNote(totals.marginLevel) : null;

  const dash = (n: number | null, format: (v: number) => string = (v) => fmtMoney(v)): string =>
    (n === null ? EMPTY : format(n));

  return (
    <View style={styles.stack}>
      {/* ── Header ── */}
      <View>
        <AppText variant="h1" accessibilityRole="header">Account Overview</AppText>
        <AppText variant="body" tone="secondary" style={styles.sub}>Manage your funds, view balance and wallet history</AppText>
        <View style={styles.headerBtns}>
          <Button title="Deposit" leftIcon="plus" size="sm" onPress={() => setView('grow')} style={styles.flex} />
          <Button title="Withdraw" variant="secondary" size="sm" onPress={() => setView('withdraw')} style={styles.flex} />
          <Button title="Transfer" variant="secondary" size="sm" onPress={() => setView('transfer')} style={styles.flex} />
        </View>
      </View>

      {/* ── Total Wallet Balance ── */}
      <WalletCard>
        <AppText variant="micro" tone="muted" weight="700" style={styles.upper}>Total Wallet Balance</AppText>
        <AppText variant="display" mono weight="800" numberOfLines={1} adjustsFontSizeToFit style={styles.gap4}>
          {dash(totalBal)}
        </AppText>
        <AppText variant="caption" tone="muted" style={styles.gap4}>
          All wallets + trading account equity
        </AppText>
        <View style={styles.breakdown}>
          <BreakPart tint={TINT.purple} glyph="gift" label="Main Wallet" value={dash(refBal)} />
          <BreakPart tint={TINT.green} glyph="chart" label="Trading Accounts (Equity)" value={dash(tradingEq)} />
        </View>
      </WalletCard>

      {/* ── Bonus Wallet — referral & partner earnings, copy-trading fees and
          funds you add; plans are billed from it. ── */}
      <WalletCard style={{ backgroundColor: t.alpha(TINT.purple, t.isDark ? 0.08 : 0.04) }}>
        <View style={styles.between}>
          <Chip label="Add Funds & Withdraw" tint={TINT.purple} />
          <LinkText label="View Main Wallet History" onPress={() => nav.navigate('BonusWallet')} arrow />
        </View>
        <View style={styles.walletHead}>
          <TintBadge tint={TINT.purple} glyph="wallet" size={48} glyphSize={22} solid />
          <View style={styles.flex}>
            <AppText variant="bodyStrong" weight="700">Main Wallet</AppText>
            <AppText variant="h1" mono weight="800" numberOfLines={1} adjustsFontSizeToFit>{dash(refBal)}</AppText>
            <AppText variant="caption" tone="muted">Available Balance · plans are billed from here</AppText>
          </View>
        </View>
        <View style={styles.grid}>
          <MiniStat label="Lifetime Earnings" value={dash(lifetime)} tone="bull" small />
          <MiniStat label="Total Withdrawals" value={dash(partnerPaid)} tone="bear" small />
          <MiniStat label="This Month" value={dash(partnerMonth)} small />
        </View>
        <View style={styles.cardBtns}>
          <Button title="Add Funds" onPress={() => nav.navigate('BonusWallet')} style={styles.flex} />
          <Button title="Withdraw" variant="secondary" onPress={() => nav.navigate('BonusWallet')} style={styles.flex} />
        </View>
      </WalletCard>

      {/* ── Overall Trading Summary ── */}
      <WalletCard>
        <CardHeader title="Overall Trading Summary" />
        <View style={styles.grid}>
          <SummaryTile
            tint={TINT.blue}
            glyph="chart"
            label="Equity (Total)"
            value={dash(tradingEq)}
            foot={complete ? trendPct(pct) : null}
            footColor={pct >= 0 ? t.colors.bull : t.colors.bear}
          />
          <SummaryTile tint={TINT.amber} glyph="clock" label="Pending Withdrawals" value={dash(pendingTotal)} />
          <SummaryTile tint={TINT.sky} glyph="trend" label="Free Margin" value={dash(complete ? totals.free : null)} />
          <SummaryTile tint={TINT.purple} glyph="lock" label="Used Margin" value={dash(complete ? totals.used : null)} />
          <SummaryTile
            tint={TINT.green}
            glyph="shield"
            label="Margin Level"
            // utils/money's margin-level format, as everywhere else in the app
            // (a stratospheric level reads ">9999%").
            value={complete && totals.marginLevel !== null ? fmtMarginLevel(totals.marginLevel) : EMPTY}
            foot={note ? `● ${note.label}` : null}
            footColor={note?.tone === 'bear' ? t.colors.bear : t.colors.bull}
          />
          <SummaryTile
            tint={unreal >= 0 ? TINT.green : TINT.red}
            glyph="trend"
            label="Today's P&L"
            value={dash(complete ? totals.unrealized : null, (v) => fmtSigned(v))}
            valueColor={complete ? (unreal >= 0 ? t.colors.bull : t.colors.bear) : undefined}
          />
        </View>
        {failures.length > 0 ? (
          // The figures above are the server's; when it could not give them
          // they are dashes, and the dashes need a reason. The store keeps
          // retrying on its own poll; Retry asks now.
          <View
            accessibilityRole="alert"
            style={[styles.metricsError, { backgroundColor: t.colors.bearSoft, borderColor: t.alpha(t.colors.bear, 0.3) }]}
          >
            <View style={styles.flex}>
              <AppText variant="small" tone="bear" weight="700">Live account figures could not be loaded</AppText>
              <AppText variant="caption" tone="secondary">{failures[0]?.error}</AppText>
            </View>
            <Button
              title="Retry"
              variant="secondary"
              size="sm"
              onPress={() => { for (const f of failures) void loadAccountMetrics(f.accountId); }}
            />
          </View>
        ) : null}
      </WalletCard>

      {/* ── Your Trading Accounts ── */}
      <WalletCard padded={false}>
        <View style={[styles.tableHead, { borderBottomColor: t.colors.borderSubtle }]}>
          <AppText variant="bodyStrong" weight="700" style={styles.flex}>Your Trading Accounts</AppText>
          <LinkText label="View All Accounts" onPress={() => setView('details')} arrow />
        </View>
        {accountsState === 'loading' ? (
          <AppText variant="small" tone="muted" align="center" style={styles.emptyRow}>Loading…</AppText>
        ) : accountsState === 'error' ? (
          // Wallet.jsx's Account Details wording for the same failure: an
          // empty list after a failed load is not "No trading accounts yet".
          <View style={styles.failed}>
            <AppText variant="bodyStrong" align="center">Couldn’t load your accounts</AppText>
            <AppText variant="small" tone="muted" align="center" style={styles.gap4}>The request failed — your accounts are safe. Try again.</AppText>
            <Button title="Retry" variant="secondary" size="sm" onPress={onRetryAccounts} style={styles.retry} />
          </View>
        ) : rows.length === 0 ? (
          <AppText variant="small" tone="muted" align="center" style={styles.emptyRow}>No trading accounts yet</AppText>
        ) : rows.map(({ account: a, metrics: m, pct: rowPct }, i) => {
          const pnl = m ? Number(m.unrealizedPnl) || 0 : 0;
          const pnlColor = pnl >= 0 ? t.colors.bull : t.colors.bear;
          return (
            <View key={a.id} style={[styles.accRow, i > 0 ? { borderTopWidth: 1, borderTopColor: t.colors.borderSubtle } : null]}>
              <View style={styles.accTop}>
                <View style={[styles.accTile, { backgroundColor: t.alpha(TINT.blue, 0.08) }]}>
                  <AppText variant="caption" color={TINT.blue} weight="700">{(a.accountNumber || 'AC').slice(-2)}</AppText>
                </View>
                <View style={styles.flex}>
                  <View style={styles.inline}>
                    <AppText variant="small" weight="700" numberOfLines={1} style={styles.shrink}>{a.accountNumber || a.id.slice(-6)}</AppText>
                    <Chip label="Live" tint={TINT.green} tiny />
                  </View>
                  <AppText variant="micro" tone="muted" numberOfLines={1}>{a.nickname || a.accountType}</AppText>
                </View>
                <View style={[styles.activePill, { backgroundColor: t.alpha(TINT.green, 0.08) }]}>
                  <View style={[styles.activeDot, { backgroundColor: t.colors.bull }]} />
                  <AppText variant="micro" color={t.isDark ? TINT.green : '#15803D'} weight="700" style={styles.upper}>Active</AppText>
                </View>
              </View>
              <View style={styles.accFigures}>
                <Figure label="Balance" value={m ? fmtMoney(m.balance) : EMPTY} />
                <Figure label="Equity" value={m ? fmtMoney(m.equity) : EMPTY} />
                <View style={styles.figure}>
                  <AppText variant="micro" tone="muted" weight="700" style={styles.upper}>P&amp;L (Today)</AppText>
                  <AppText variant="small" mono weight="700" color={m ? pnlColor : undefined}>{m ? fmtSigned(m.unrealizedPnl) : EMPTY}</AppText>
                  {rowPct !== null ? <AppText variant="micro" mono color={rowPct >= 0 ? t.colors.bull : t.colors.bear}>{signedPct(rowPct)}</AppText> : null}
                </View>
              </View>
              <Button title="View" variant="ghost" size="sm" onPress={() => setView('details')} style={styles.viewBtn} />
            </View>
          );
        })}
      </WalletCard>

      {/* ── Performance Overview ── */}
      <WalletCard>
        <View style={styles.between}>
          <AppText variant="bodyStrong" weight="700">Performance Overview</AppText>
          <Select<PerfRange>
            variant="compact"
            value={perfRange}
            options={PERF_RANGES.map((r) => ({ value: r.value, label: r.label }))}
            onChange={setPerfRange}
            title="Performance Overview"
            accessibilityLabel="Performance range"
          />
        </View>
        <AppText variant="caption" tone="muted" style={styles.gap4}>Total Profit/Loss</AppText>
        <View style={styles.baseline}>
          <AppText variant="h1" mono weight="800" color={net >= 0 ? t.colors.bull : t.colors.bear}>{fmtSigned(net)}</AppText>
          {/* A share of the equity total — only once that total is whole. */}
          <AppText variant="caption" weight="700" color={complete ? (pct >= 0 ? t.colors.bull : t.colors.bear) : t.colors.textMuted}>
            {complete ? signedPct(pct) : EMPTY}
          </AppText>
        </View>
        <AreaChart buckets={series} />
        <View style={[styles.perfRow, { borderTopColor: t.colors.borderSubtle }]}>
          <PerfStat label="This Week" value={rangeNet(extras.week)} />
          <PerfStat label="This Month" value={rangeNet(extras.month)} />
          <PerfStat label="This Year" value={rangeNet(extras.year)} />
        </View>
      </WalletCard>

      {/* ── KPI cards ── */}
      <View style={styles.grid}>
        <KpiCard
          tint={TINT.blue}
          glyph="layers"
          value={ready.positions ? String(counts.open) : EMPTY}
          label="Open Positions"
          // Not "0 Winning · 0 Losing" under a dash: the split is as unknown as the count.
          foot={ready.positions ? `${counts.winning} Winning · ${counts.losing} Losing` : `${EMPTY} Winning · ${EMPTY} Losing`}
        />
        <KpiCard
          tint={TINT.green}
          glyph="target"
          value={winRate === null ? EMPTY : `${fmtNum(winRate, 2)}%`}
          label="Winning Rate"
          foot={`${wins} Wins · ${losses} Losses`}
        />
        <KpiCard tint={TINT.purple} glyph="chart" value={String(totalTrades)} label="Total Trades" foot="All time" />
        <KpiCard
          tint={TINT.sky}
          glyph="moneyIn"
          value={dash(depositsTotal)}
          label="Total Deposits"
          foot={`Withdrawn ${dash(withdrawalsTotal)}`}
          small
        />
      </View>

      {/* ── Recent Transactions panel ── */}
      <WalletCard padded={false}>
        <View style={[styles.tableHead, { borderBottomColor: t.colors.borderSubtle }]}>
          <AppText variant="bodyStrong" weight="700" style={styles.flex}>Recent Transactions</AppText>
          <LinkText label="View All" onPress={() => setView('history')} />
        </View>
        {recent.length === 0 ? (
          <AppText variant="small" tone="muted" align="center" style={styles.emptyRow}>No transactions yet</AppText>
        ) : recent.slice(0, 5).map((m, i) => {
          const dep = m.kind === 'deposit';
          const tint = dep ? TINT.green : TINT.red;
          return (
            <View key={`${m.kind}-${m.row.id || i}`} style={[styles.txRow, i > 0 ? { borderTopWidth: 1, borderTopColor: t.colors.borderSubtle } : null]}>
              <TintBadge tint={tint} glyph={dep ? 'moneyIn' : 'moneyOut'} />
              <View style={styles.flex}>
                <AppText variant="small" weight="600" numberOfLines={1}>
                  {`${dep ? 'Deposit' : 'Withdrawal Request'}${m.row.method ? ` via ${m.row.method}` : ''}`}
                </AppText>
                <AppText variant="micro" tone="muted">{fmtOverviewDateTime(m.row.createdAt)}</AppText>
              </View>
              <View style={styles.right}>
                <AppText variant="small" mono weight="700" color={dep ? t.colors.bull : t.colors.bear}>
                  {`${dep ? '+' : '-'}${fmtMoney(Math.abs(Number(m.row.amount) || 0))}`}
                </AppText>
                <StatusPill status={m.row.status} />
              </View>
            </View>
          );
        })}
      </WalletCard>

      {/* ── Recent Wallet Transactions ── */}
      <WalletCard padded={false}>
        <View style={[styles.tableHead, { borderBottomColor: t.colors.borderSubtle }]}>
          <AppText variant="bodyStrong" weight="700" style={styles.flex}>Recent Wallet Transactions</AppText>
          <LinkText label="View All" onPress={() => setView('history')} arrow />
        </View>
        {recent.length === 0 ? (
          <AppText variant="small" tone="muted" align="center" style={styles.emptyRow}>No wallet transactions yet</AppText>
        ) : recent.slice(0, 8).map((m, i) => {
          const dep = m.kind === 'deposit';
          const tone = dep ? t.colors.bull : t.colors.bear;
          return (
            <View key={`w-${m.kind}-${m.row.id || i}`} style={[styles.walletTx, i > 0 ? { borderTopWidth: 1, borderTopColor: t.colors.borderSubtle } : null]}>
              <View style={styles.between}>
                <AppText variant="small" tone="secondary">{fmtOverviewDateTime(m.row.createdAt)}</AppText>
                <StatusPill status={m.row.status} />
              </View>
              <View style={styles.inline}>
                <AppText variant="small" tone="secondary">{moveWalletLabel(m)}</AppText>
                <View style={[styles.typeTag, { backgroundColor: t.alpha(tone, 0.15) }]}>
                  <AppText variant="micro" color={tone} weight="700" style={styles.upper}>{dep ? 'Deposit' : 'Withdrawal'}</AppText>
                </View>
              </View>
              <View style={styles.between}>
                <AppText variant="small" tone="secondary" numberOfLines={1} style={styles.flex}>
                  {m.row.note || `${dep ? 'Deposit' : 'Withdrawal'}${m.row.method ? ` · ${m.row.method}` : ''}`}
                </AppText>
                <AppText variant="bodyStrong" mono weight="700" color={tone}>
                  {`${dep ? '+' : '-'}${fmtMoney(Math.abs(Number(m.row.amount) || 0))}`}
                </AppText>
              </View>
            </View>
          );
        })}
      </WalletCard>
    </View>
  );
}

/* ── Building blocks (AccountOverview.jsx) ─────────────────────────── */

function Chip({ label, tint, tiny = false }: { label: string; tint: string; tiny?: boolean }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[tiny ? styles.chipTiny : styles.chip, { backgroundColor: t.alpha(tint, 0.08) }]}>
      <AppText variant="micro" color={tint} weight="700" style={[styles.upper, tiny ? styles.tinyText : null]}>{label}</AppText>
    </View>
  );
}

function LinkText({ label, onPress, arrow = false }: { label: string; onPress: () => void; arrow?: boolean }): React.JSX.Element {
  return (
    <AppText variant="caption" tone="brand" weight="600" onPress={onPress} accessibilityRole="link" suppressHighlighting>
      {arrow ? `${label} →` : label}
    </AppText>
  );
}

function BreakPart({ tint, glyph, label, value }: {
  tint: string;
  glyph: 'wallet' | 'gift' | 'chart';
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <View style={styles.breakPart}>
      <TintBadge tint={tint} glyph={glyph} size={36} />
      <View style={styles.flex}>
        <AppText variant="micro" tone="muted" weight="700" numberOfLines={1} style={styles.upper}>{label}</AppText>
        <AppText variant="bodyStrong" mono weight="700" numberOfLines={1}>{value}</AppText>
      </View>
    </View>
  );
}

function MiniStat({ label, value, tone, small = false }: {
  label: string;
  value: string;
  tone?: 'bull' | 'bear';
  small?: boolean;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[styles.miniStat, { borderColor: t.colors.borderSubtle, backgroundColor: t.alpha(t.colors.bgCard, 0.7) }]}>
      <AppText variant="micro" tone="muted" weight="700" numberOfLines={1} style={styles.upper}>{label}</AppText>
      <AppText variant={small ? 'small' : 'bodyStrong'} tone={tone} mono weight="700" numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </AppText>
    </View>
  );
}

function SummaryTile({ tint, glyph, label, value, foot, footColor, valueColor }: {
  tint: string;
  glyph: 'chart' | 'clock' | 'trend' | 'lock' | 'shield';
  label: string;
  value: string;
  foot?: string | null;
  footColor?: string;
  valueColor?: string;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[styles.tile, { borderColor: t.colors.borderSubtle, backgroundColor: t.alpha(t.colors.bgHover, 0.4) }]}>
      <TintBadge tint={tint} glyph={glyph} />
      <AppText variant="micro" tone="muted" weight="700" numberOfLines={1} style={[styles.upper, styles.gap8]}>{label}</AppText>
      <AppText variant="h3" mono weight="800" color={valueColor} numberOfLines={1} adjustsFontSizeToFit>{value}</AppText>
      {foot ? <AppText variant="micro" weight="700" color={footColor}>{foot}</AppText> : null}
    </View>
  );
}

function KpiCard({ tint, glyph, value, label, foot, small = false }: {
  tint: string;
  glyph: 'layers' | 'target' | 'chart' | 'moneyIn';
  value: string;
  label: string;
  foot: string;
  small?: boolean;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[styles.tile, styles.kpi, { borderColor: t.colors.borderDark, backgroundColor: t.colors.surface }]}>
      <TintBadge tint={tint} glyph={glyph} size={36} />
      <AppText variant={small ? 'h3' : 'h1'} mono weight="800" numberOfLines={1} adjustsFontSizeToFit style={styles.gap8}>{value}</AppText>
      <AppText variant="caption" tone="secondary" weight="600">{label}</AppText>
      <AppText variant="micro" tone="muted" numberOfLines={1}>{foot}</AppText>
    </View>
  );
}

function Figure({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.figure}>
      <AppText variant="micro" tone="muted" weight="700" style={styles.upper}>{label}</AppText>
      <AppText variant="small" mono weight="600" numberOfLines={1} adjustsFontSizeToFit>{value}</AppText>
    </View>
  );
}

function PerfStat({ label, value }: { label: string; value: number }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={styles.perfStat}>
      <AppText variant="micro" tone="muted" weight="700" style={styles.upper}>{label}</AppText>
      <AppText variant="small" mono weight="700" color={value >= 0 ? t.colors.bull : t.colors.bear} numberOfLines={1} adjustsFontSizeToFit>
        {fmtSigned(value)}
      </AppText>
    </View>
  );
}

/** AccountOverview.jsx:504 AreaChart — drawn at the measured width, so the stroke is not stretched. */
function AreaChart({ buckets }: { buckets: readonly SeriesBucket[] }): React.JSX.Element {
  const t = useTheme();
  const [width, setWidth] = useState(0);
  const H = 128;
  const paths = width > 0 ? areaChartPaths(buckets.map((b) => Number(b.equity || 0)), width, H) : null;
  const onLayout = (e: LayoutChangeEvent): void => setWidth(Math.round(e.nativeEvent.layout.width));

  if (buckets.length < 2) {
    return (
      <View style={[styles.chartEmpty, { height: H }]}>
        <AppText variant="caption" tone="muted">Not enough data yet</AppText>
      </View>
    );
  }
  const stroke = paths?.positive === false ? TINT.red : TINT.green;
  return (
    <View style={styles.chart} onLayout={onLayout}>
      <View style={{ height: H }}>
        {paths ? (
          <Svg width={width} height={H}>
            <Defs>
              <LinearGradient id="walletPerfFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0%" stopColor={stroke} stopOpacity={0.22} />
                <Stop offset="100%" stopColor={stroke} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Path d={paths.area} fill="url(#walletPerfFill)" />
            <Path d={paths.line} fill="none" stroke={stroke} strokeWidth={2} />
          </Svg>
        ) : null}
      </View>
      <View style={styles.labels}>
        {chartLabels(buckets).map((b, i) => (
          <AppText key={`${b.key}-${i}`} variant="micro" tone="muted" style={{ fontSize: 9, color: t.colors.textMuted }}>{b.label}</AppText>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 20 },
  flex: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  upper: { textTransform: 'uppercase', letterSpacing: 0.6 },
  sub: { marginTop: 4 },
  gap4: { marginTop: 4 },
  gap8: { marginTop: 8 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  baseline: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  right: { alignItems: 'flex-end', gap: 4 },
  headerBtns: { flexDirection: 'row', gap: 8, marginTop: 12 },
  breakdown: { gap: 12, marginTop: 16 },
  breakPart: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  walletHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 16 },
  cardBtns: { flexDirection: 'row', gap: 8, marginTop: 16 },
  chip: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  chipTiny: { borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  tinyText: { fontSize: 8, lineHeight: 11 },
  miniStat: { flexGrow: 1, flexBasis: '28%', minWidth: 0, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  tile: { flexGrow: 1, flexBasis: '44%', minWidth: 0, borderWidth: 1, borderRadius: 16, padding: 14 },
  kpi: { padding: 16 },
  tableHead: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1 },
  emptyRow: { paddingVertical: 32 },
  failed: { alignItems: 'center', paddingVertical: 32, paddingHorizontal: 20 },
  retry: { marginTop: 16 },
  metricsError: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 12 },
  accRow: { paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
  accTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  accTile: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  activePill: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  activeDot: { width: 6, height: 6, borderRadius: 3 },
  accFigures: { flexDirection: 'row', gap: 8 },
  figure: { flex: 1, minWidth: 0, gap: 2 },
  viewBtn: { alignSelf: 'flex-start' },
  chart: { marginTop: 8 },
  chartEmpty: { alignItems: 'center', justifyContent: 'center' },
  labels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  perfRow: { flexDirection: 'row', gap: 8, marginTop: 12, paddingTop: 12, borderTopWidth: 1 },
  perfStat: { flex: 1, alignItems: 'center', gap: 2 },
  txRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 12 },
  walletTx: { paddingHorizontal: 20, paddingVertical: 12, gap: 6 },
  typeTag: { borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2 },
});
