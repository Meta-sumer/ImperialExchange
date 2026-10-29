import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { partnerApi, referralLinkFor } from '@/api/partner.api';
import { Screen, toast } from '@/components/ui';
import { PARTNER_CURRENCY, RECENT_COMMISSIONS_FETCH, type Commission, type VolumeDashboard } from '@/types/partner';
import { subscribeBonusWallet, subscribeNotifications, subscribeSubscription } from '@/websocket/channels';

import {
  ChartsSection,
  CommissionOverview,
  FirstDepositRewardCard,
  HeroCard,
  LevelsSection,
  PartnerSkeleton,
  PausedBanner,
  RecentCommissions,
  ReferralLinkSection,
  ReferralPerformance,
  StatsSection,
} from './PartnerSections';

/**
 * Partner / IB Room — client/src/pages/Partner.jsx, served at /partner,
 * /affiliate and /ib-room. VOLUME-DRIVEN: the partner's tier and profit
 * share follow the previous month's referral trading volume.
 *
 * One read of GET /partner/volume-dashboard (level, progress, tiers,
 * statistics, per-referral performance, the 6-month series) plus the last
 * few commissions (a failure there is an empty list, not an error). It
 * re-reads on `user:subscription`, `user:bonusWallet`, and a PARTNER_BONUS
 * notification, as the web does.
 *
 * The referral link is built on the public origin (WEB_ORIGIN, else the API
 * host — partner.api referralLinkFor), not the phone's own address.
 */
export function PartnerScreen(): React.JSX.Element {
  const [d, setD] = useState<VolumeDashboard | null>(null);
  const [commissions, setCommissions] = useState<Commission[]>([]);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = useCallback(async () => {
    try {
      const [vd, c] = await Promise.all([
        partnerApi.volumeDashboard(),
        partnerApi.commissions({ limit: RECENT_COMMISSIONS_FETCH }).catch(() => [] as Commission[]),
      ]);
      if (!alive.current) return;
      setD(vd);
      setCommissions(c);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const offS = subscribeSubscription(() => { void refresh(); });
    const offB = subscribeBonusWallet(() => { void refresh(); });
    const offN = subscribeNotifications((m) => {
      if (m && typeof m === 'object' && (m as { type?: unknown }).type === 'PARTNER_BONUS') void refresh();
    });
    return () => { offS(); offB(); offN(); };
  }, [refresh]);

  if (loading || !d) {
    return (
      <Screen onRefresh={loading ? undefined : refresh} testID="partner-loading">
        <PartnerSkeleton />
      </Screen>
    );
  }

  const code = d.referralCode || '';
  const link = referralLinkFor(code);
  // Partner.jsx: `const cur = 'INR'` — every partner amount is rupees.
  const cur = PARTNER_CURRENCY;

  return (
    <Screen onRefresh={refresh} testID="partner-screen">
      <View style={styles.page}>
        {d.enabled === false ? <PausedBanner /> : null}
        <HeroCard d={d} />
        <FirstDepositRewardCard bonus={d.firstDepositBonus} cur={cur} />
        <LevelsSection d={d} />
        <StatsSection d={d} cur={cur} />
        <ChartsSection series={d.monthlySeries} cur={cur} />
        <ReferralPerformance rows={d.referralPerformance} cur={cur} />
        <CommissionOverview d={d} cur={cur} />
        <RecentCommissions rows={commissions} cur={cur} />
        <ReferralLinkSection code={code} link={link} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: { gap: 24, paddingBottom: 16 },
});
