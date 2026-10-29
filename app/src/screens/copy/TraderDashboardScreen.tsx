import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';

import { errorMessage } from '@/api/client';
import { copyTradingApi } from '@/api/copyTrading.api';
import { CopySetupModal } from '@/components/copy/CopyModals';
import { AppText, Screen, toast } from '@/components/ui';
import type { AppScreenProps } from '@/navigation/types';
import { useAuthStore } from '@/store/auth';
import { useTheme } from '@/theme';
import type { TraderAnalytics } from '@/types/copyTrading';

import {
  BarChartCard,
  CopyPanel,
  DistributionCard,
  EquityCurveCard,
  FollowerAnalytics,
  HeadlineCards,
  MasterEarnings,
  OpenPositionsCard,
  PerformanceMetrics,
  RiskAnalytics,
  TradeHistoryCard,
  TraderHero,
} from './TraderSections';

/** The web's full re-read cadence. */
const REFRESH_MS = 30_000;

/**
 * Trader Dashboard — client/src/pages/TraderDashboard.jsx at
 * /copy-trading/trader/:id?account=: a read-only trader profile — the hero,
 * headline cards, the equity curve with ranges, performance and risk
 * metrics, monthly / weekly bars and the profit distribution, live open
 * positions, the trade history, follower analytics, the owner's own
 * performance-fee earnings, and "Copy Trader" (the shared CopySetupModal).
 *
 * The profile re-reads every 30 s while the screen is in front and the app
 * is active; the open positions every 5 s, re-marked live from the ticker.
 */
export function TraderDashboardScreen({ navigation, route }: AppScreenProps<'TraderDashboard'>): React.JSX.Element {
  const t = useTheme();
  const focused = useIsFocused();
  const id = String(route.params?.id ?? '');
  const accountId = route.params?.account ? String(route.params.account) : null;
  const myId = useAuthStore((s) => s.user?.id ?? '');
  const [data, setData] = useState<TraderAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [copyOpen, setCopyOpen] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const d = await copyTradingApi.trader(id, accountId);
      if (mine === seq.current) setData(d);
    } catch (e) {
      if (mine === seq.current) toast.error(errorMessage(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [id, accountId]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useEffect(() => {
    if (!focused) return undefined;
    const iv = setInterval(() => { if (AppState.currentState === 'active') void load(); }, REFRESH_MS);
    return () => clearInterval(iv);
  }, [focused, load]);
  useEffect(() => () => { seq.current += 1; }, []);

  const back = (): void => navigation.navigate('CopyTrading', undefined, { pop: true });

  const BackLink = (
    <Pressable accessibilityRole="link" onPress={back} hitSlop={6} style={styles.back}>
      <AppText variant="bodyStrong" color={t.colors.primaryText}>← Copy Trading</AppText>
    </Pressable>
  );

  if (loading) {
    return (
      <Screen testID="trader-loading">
        <AppText variant="body" tone="muted" style={styles.pad}>Loading trader…</AppText>
      </Screen>
    );
  }

  if (!data) {
    return (
      <Screen testID="trader-unavailable">
        {BackLink}
        <View style={[styles.unavailable, { borderColor: t.colors.borderDark, backgroundColor: t.colors.surface }]}>
          <AppText variant="body" tone="muted" align="center">This trader profile is unavailable or private.</AppText>
        </View>
      </Screen>
    );
  }

  const tr = data.trader;
  const isSelf = !!myId && String(tr.userId) === String(myId);

  return (
    <Screen onRefresh={load} testID="trader-dashboard-screen">
      <View style={styles.page}>
        {BackLink}
        <TraderHero d={data} isSelf={isSelf} onCopy={() => setCopyOpen(true)} onBack={back} />
        <HeadlineCards d={data} />
        <EquityCurveCard series={data.charts.equityCurve} initialEquity={data.initialEquity} />
        <PerformanceMetrics pf={data.performance} />
        <RiskAnalytics risk={data.risk} />
        <BarChartCard title="Monthly Performance" sub="Realized PnL per month · last 12" data={data.charts.monthly} />
        <BarChartCard title="Weekly Performance" sub="Realized PnL per week · last 12" data={data.charts.weekly} />
        <DistributionCard data={data.charts.distribution} />
        <OpenPositionsCard traderId={id} accountId={accountId} />
        <TradeHistoryCard traderId={id} accountId={accountId} />
        {isSelf ? <MasterEarnings e={data.earnings} onTransferred={() => { void load(); }} /> : null}
        <FollowerAnalytics f={data.followers} fee={tr.performanceFeePercent} />
        <CopyPanel name={tr.displayName} isSelf={isSelf} onCopy={() => setCopyOpen(true)} />
      </View>

      {copyOpen && tr.accountId ? (
        <CopySetupModal
          trader={{
            userId: tr.userId,
            accountId: tr.accountId,
            displayName: tr.displayName,
            roiPct: Number(data.performance.totalROI) || 0,
            winRate: Number(data.performance.winRate) || 0,
            followers: tr.followers,
            fee: tr.performanceFeePercent,
          }}
          onClose={() => setCopyOpen(false)}
          onStarted={() => { setCopyOpen(false); }}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: { gap: 16, paddingBottom: 16 },
  pad: { paddingVertical: 24 },
  back: { alignSelf: 'flex-start' },
  unavailable: { marginTop: 24, borderWidth: 1, borderRadius: 16, padding: 40 },
});
