import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';

import { useDashboard } from '@/api/dashboard.api';
import { useInstruments } from '@/api/instruments.api';
import { fetchPositionHistory, fetchPositions } from '@/api/trading.api';
import { walletApi } from '@/api/wallet.api';
import { AppText, Button, Screen, Skeleton } from '@/components/ui';
import { useAppNavigation } from '@/navigation/types';
import { useSelectedAccountStore } from '@/store/selectedAccount';
import { useTheme } from '@/theme';
import type { Position } from '@/types/trading';
import type { WalletBalance } from '@/types/wallet';
import {
  createTickBuffer,
  dashboardName,
  dashboardSubtitle,
  hasMoreHistory,
  heroFigures,
  KYC_CHIP_LABEL,
  kycChipOf,
  livePosition,
  mergePrices,
  openSymbols,
  startOfTodayIso,
  tickPrice,
  todayByAccount as sumTodayByAccount,
  TODAY_HISTORY_PAGE,
} from '@/utils/dashboard';
import { subscribePositions, subscribeTickers, subscribeWallet } from '@/websocket/channels';

import { AccountsTable } from './components/AccountsTable';
import { AssetAllocationCard } from './components/AssetAllocationCard';
import { Glyph, type GlyphName } from './components/Glyph';
import { HeroBand } from './components/HeroBand';
import { OpenPositions } from './components/OpenPositions';
import { PortfolioChart } from './components/PortfolioChart';
import { PortfolioStats } from './components/PortfolioStats';
import { RecentClosedTrades } from './components/RecentClosedTrades';
import { TINT, tint } from './components/shared';

/** Ticks are coalesced: one render per window, however many symbols moved. */
const TICK_FLUSH_MS = 500;

/** A burst of wallet events (a close settles in several writes) re-reads once. */
const WALLET_NUDGE_MS = 500;

/**
 * Portfolio — EquityHub's client/src/pages/Dashboard.jsx.
 *
 * Header (title, Live pill, KYC chip, Add Funds, Trade), the equity hero
 * band, the trading summary, the analytics chart, the trading accounts
 * table, the open positions, the asset allocation donut and the recent
 * closed trades — in the web's order, stacked. Everything is rupees.
 *
 * Data, as on the web: /user/dashboard polled every 15 s and re-read on
 * `user:wallet` (useDashboard); the open positions re-read on
 * `user:positions`; a ticker per held symbol for the live marks, which
 * re-mark the hero's floating P&L once every live position has a tick
 * (utils/dashboard heroFigures). The accounts table sums /wallet/balances
 * and today's closes per account.
 *
 * One deliberate difference: the web reads /wallet/balances and today's
 * history once per page load, so the table's balance and Today's P&L froze
 * while the hero above it moved. Both are re-read here on `user:wallet`
 * (once per burst) and on pull-to-refresh.
 */
export function DashboardScreen(): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  const focused = useIsFocused();
  const { rows: instruments } = useInstruments();
  const { data, loading, refresh } = useDashboard();
  const accounts = useSelectedAccountStore((s) => s.accounts);
  const [refreshKey, setRefreshKey] = useState(0);
  const [retrying, setRetrying] = useState(false);

  // The accounts list is shared app state; ask for a fresh copy per visit,
  // as the web's sections read /user/accounts on mount.
  useEffect(() => { void useSelectedAccountStore.getState().load(); }, [refreshKey]);

  /* ── Open positions ─────────────────────────────────────────────── */
  const [positions, setPositions] = useState<Position[]>([]);
  const positionsSeq = useRef(0);
  const loadPositions = useCallback(async () => {
    const seq = ++positionsSeq.current;
    try {
      const rows = await fetchPositions();
      if (seq === positionsSeq.current) setPositions(rows);
    } catch { /* keep the prior list */ }
  }, []);
  useEffect(() => {
    void loadPositions();
    const off = subscribePositions(() => { void loadPositions(); });
    return () => { off(); positionsSeq.current += 1; };
  }, [loadPositions, refreshKey]);

  /* ── Live marks: a ticker per held symbol, paused off-screen ─────── */
  const [priceMap, setPriceMap] = useState<Record<string, number>>({});
  const symbols = useMemo(() => openSymbols(data, positions), [data, positions]);
  const symbolsKey = symbols.join(',');
  useEffect(() => {
    if (!focused || !symbolsKey) return undefined;
    const buffer = createTickBuffer(TICK_FLUSH_MS, (next) => setPriceMap((prev) => mergePrices(prev, next)));
    const off = subscribeTickers(symbolsKey.split(','), (tick) => {
      const px = tickPrice(tick);
      if (px !== null && tick.symbol) buffer.push(tick.symbol.toUpperCase(), px);
    });
    return () => { off(); buffer.cancel(); };
  }, [focused, symbolsKey]);

  /* ── The accounts table's figures (Dashboard.jsx:1600-1616) ──────── */
  // null = not answered yet (or failed): the table shows "—", not ₹0.00.
  const [balances, setBalances] = useState<WalletBalance[] | null>(null);
  const [todayByAcc, setTodayByAcc] = useState<Record<string, number>>({});
  const figuresSeq = useRef(0);
  const loadAccountFigures = useCallback(async () => {
    const seq = ++figuresSeq.current;
    const balancesRead = walletApi.balances()
      .then((rows) => { if (seq === figuresSeq.current) setBalances(rows); })
      .catch(() => { /* keep what is shown */ });
    const todayRead = (async () => {
      const from = startOfTodayIso();
      const items: Position[] = [];
      for (let page = 1; ; page += 1) {
        const res = await fetchPositionHistory({ from, limit: TODAY_HISTORY_PAGE, page });
        items.push(...res.items);
        if (!hasMoreHistory(page, res)) break;
      }
      if (seq === figuresSeq.current) setTodayByAcc(sumTodayByAccount(items));
    })().catch(() => { /* keep what is shown */ });
    await Promise.all([balancesRead, todayRead]);
  }, []);
  useEffect(() => {
    void loadAccountFigures();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = subscribeWallet(() => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; void loadAccountFigures(); }, WALLET_NUDGE_MS);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
      figuresSeq.current += 1;
    };
  }, [loadAccountFigures, refreshKey]);

  /* ── Derived ─────────────────────────────────────────────────────── */
  const instBySymbol = useMemo(() => new Map(instruments.map((i) => [i.symbol, i] as const)), [instruments]);
  const livePositions = useMemo(
    () => positions.map((p) => livePosition(p, priceMap[p.symbol.toUpperCase()], instBySymbol.get(p.symbol))),
    [positions, priceMap, instBySymbol],
  );
  const hero = useMemo(() => (data ? heroFigures({ summary: data, priceMap }) : null), [data, priceMap]);

  const onRefresh = useCallback(async () => {
    setRefreshKey((k) => k + 1);
    await Promise.all([refresh(), loadPositions()]);
  }, [refresh, loadPositions]);

  const retry = useCallback(async () => {
    setRetrying(true);
    try { await refresh(); } finally { setRetrying(false); }
  }, [refresh]);

  if (loading) return <DashboardSkeleton />;

  if (!data || !hero) {
    return (
      <Screen testID="dashboard-error">
        <View style={[styles.errorCard, { backgroundColor: t.colors.surface, borderColor: tint(TINT.red, 0.3) }]}>
          <View style={[styles.errorIcon, { backgroundColor: tint(TINT.red, 0.15) }]}>
            <Glyph name="alert" size={28} color={t.colors.bear} strokeWidth={2.5} />
          </View>
          <AppText variant="title" align="center">Couldn't load your portfolio</AppText>
          <AppText variant="body" tone="secondary" align="center" style={styles.errorText}>
            Check your connection and try again.
          </AppText>
          <Button title="Retry" onPress={() => { void retry(); }} loading={retrying} />
        </View>
      </Screen>
    );
  }

  const chip = kycChipOf(data.user.kycStatus);

  return (
    <Screen onRefresh={onRefresh} testID="dashboard-screen">
      <View style={styles.page}>
        {/* ── Header ─────────────────────────────────────────────── */}
        <View style={styles.header}>
          <View style={styles.titleRow}>
            <AppText variant="h1">Portfolio</AppText>
            <View style={[styles.livePill, { backgroundColor: t.colors.surface, borderColor: t.colors.borderDark }]}>
              <View style={[styles.liveDot, { backgroundColor: t.colors.bull }]} />
              <AppText variant="micro" weight="600" tone="secondary">Live</AppText>
            </View>
          </View>
          <AppText variant="body" tone="secondary">{dashboardSubtitle(dashboardName(data.user))}</AppText>

          <View style={styles.actions}>
            {chip === 'verified' ? (
              <HeaderChip icon="check" label={KYC_CHIP_LABEL.verified} hex={TINT.green} />
            ) : chip === 'review' ? (
              <HeaderChip icon="shield" label={KYC_CHIP_LABEL.review} hex={TINT.amber} />
            ) : (
              <HeaderChip
                icon="shield"
                label={KYC_CHIP_LABEL.verify}
                hex={TINT.red}
                onPress={() => nav.navigate('Profile')}
              />
            )}
            <Pressable
              accessibilityRole="link"
              onPress={() => nav.navigate('Wallet')}
              style={({ pressed }) => [
                styles.ghostBtn,
                { borderColor: t.colors.borderDark },
                pressed ? { backgroundColor: t.colors.primarySoft } : null,
              ]}
            >
              <Glyph name="wallet" size={14} color={t.colors.textPrimary} />
              <AppText variant="small" weight="600">Add Funds</AppText>
            </Pressable>
            <Pressable
              accessibilityRole="link"
              onPress={() => nav.navigate('Trade')}
              style={({ pressed }) => [
                styles.primaryBtn,
                { backgroundColor: pressed ? t.colors.primaryPressed : t.colors.primary },
              ]}
            >
              <Glyph name="chart" size={14} color={t.colors.onPrimary} />
              <AppText variant="small" weight="700" color={t.colors.onPrimary}>Trade</AppText>
            </Pressable>
          </View>
        </View>

        <HeroBand hero={hero} openCount={positions.length} />

        <PortfolioStats accounts={accounts} refreshKey={refreshKey} />

        <PortfolioChart dash={data} refreshKey={refreshKey} />

        <AccountsTable
          accounts={accounts}
          positions={livePositions}
          balances={balances}
          todayByAccount={todayByAcc}
        />

        <OpenPositions positions={livePositions} />

        <AssetAllocationCard positions={livePositions} accounts={accounts} />

        <RecentClosedTrades accounts={accounts} refreshKey={refreshKey} />
      </View>
    </Screen>
  );
}

function HeaderChip({
  icon,
  label,
  hex,
  onPress,
}: {
  icon: GlyphName;
  label: string;
  hex: string;
  onPress?: () => void;
}): React.JSX.Element {
  const body = (
    <>
      <Glyph name={icon} size={14} color={hex} />
      <AppText variant="small" weight="600" color={hex}>{label}</AppText>
    </>
  );
  const style = [styles.chip, { backgroundColor: tint(hex, 0.1), borderColor: tint(hex, 0.3) }];
  return onPress ? (
    <Pressable accessibilityRole="link" onPress={onPress} style={({ pressed }) => [style, pressed ? { opacity: 0.7 } : null]}>
      {body}
    </Pressable>
  ) : (
    <View style={style}>{body}</View>
  );
}

/** Dashboard.jsx:1872-1906 — the page's shape while the first read is out. */
function DashboardSkeleton(): React.JSX.Element {
  const t = useTheme();
  const card = [styles.skelCard, { backgroundColor: t.colors.surface, borderColor: t.colors.borderSubtle }];
  return (
    <Screen testID="dashboard-loading">
      <View style={styles.page}>
        <View style={styles.skelHead}>
          <Skeleton width={160} height={32} />
          <Skeleton width={260} height={16} />
          <Skeleton width={112} height={36} />
        </View>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={card}>
            <Skeleton width={80} height={12} />
            <Skeleton width={128} height={32} />
            <Skeleton width={64} height={12} />
          </View>
        ))}
        <View style={card}>
          <Skeleton width={128} height={16} />
          <Skeleton height={192} />
        </View>
        <View style={card}>
          <Skeleton width={96} height={16} />
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={40} />)}
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: { gap: 20 },
  header: { gap: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 10 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  ghostBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 12,
  },
  errorCard: { borderWidth: 1, borderRadius: 16, padding: 32, alignItems: 'center', gap: 8, marginTop: 24 },
  errorIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  errorText: { marginBottom: 8 },
  skelHead: { gap: 8 },
  skelCard: { borderWidth: 1, borderRadius: 16, padding: 20, gap: 12 },
});
