import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { subscriptionApi } from '@/api/subscription.api';
import { walletApi } from '@/api/wallet.api';
import {
  AppText,
  Badge,
  Button,
  ErrorView,
  Icon,
  Input,
  LoadingView,
  PageHero,
  Screen,
  SectionHeader,
  Select,
  Toggle,
  toast,
} from '@/components/ui';
import { DateField } from '@/components/common/DateField';
import { BonusWalletDepositSheet } from '@/components/wallet/BonusWalletDepositSheet';
import { UserWalletWithdrawSheet } from '@/components/wallet/UserWalletWithdrawSheet';
import { WalletNav } from '@/components/wallet/WalletNav';
import type { AppScreenProps } from '@/navigation/types';
import { makeStyles, useTheme } from '@/theme';
import type { MySubscription } from '@/types/subscription';
import type { BonusWallet, WalletTransaction } from '@/types/wallet';
import { fmtMoney } from '@/utils/money';
import {
  BONUS_STATUS_OPTIONS,
  EMPTY_BONUS_FILTER,
  LOW_BALANCE_WARNING,
  autoRenewNote,
  autoRenewToast,
  billingCycleSub,
  billingWalletIsLow,
  bonusAmountText,
  bonusReasonLabel,
  bonusRecordsLabel,
  bonusStats,
  bonusTypeOptions,
  filterBonusTxns,
  fmtDateTime,
  hasBonusFilter,
  isBonusCredit,
  planCountdown,
  planPeriodLabel,
  shortTxnId,
  subscriptionStatusBadge,
  txnStatusTone,
  type BonusFilter,
  type StatusBadge,
} from '@/utils/userWallets';
import { useChannel, useForeground } from '@/websocket/channels';

/**
 * The Bonus Wallet — client/src/pages/BonusWallet.jsx (route `/bonus-wallet`,
 * and `/subscription-wallet`, which now lands here). It holds referral and
 * partner earnings, copy-trading fees and the funds the user adds, and plans
 * are billed from it — it took over the retired Main Wallet's job.
 *
 * Balance and lifetime earnings with Add Funds (instant from a live trading
 * account, or UPI / bank with proof) and Withdraw; the four earnings tiles;
 * the Subscription tiles — current plan, renews in, the plan auto-renew
 * switch — and the low-balance warning; and the last 100 transactions with
 * the web's filters — search, type, status, direction and an inclusive
 * From–To day range. The wallet, its history and /subscriptions/me load
 * independently (Promise.allSettled). Refreshes when the server announces a
 * movement on `user:bonusWallet`.
 *
 * Differences from the web, on purpose:
 *   - A failed wallet load shows the error and a retry instead of ₹0.00.
 *   - The Status column is coloured by status (the web paints FAILED green).
 *   - A missing balance-after reads "—", not ₹0.00.
 *   - Reloads when the screen comes back into view and on foreground.
 *   - The renews-in countdown ticks each minute rather than freezing at the
 *     value it had when the page rendered.
 *   - The auto-renew switch takes the server's answer as soon as the POST
 *     returns, instead of showing the old state until the reload lands.
 *   - `POST /subscriptions/renew` is not offered: the web never calls it.
 */
export function BonusWalletScreen({ navigation }: AppScreenProps<'BonusWallet'>): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();

  const [wallet, setWallet] = useState<BonusWallet | null>(null);
  const [walletError, setWalletError] = useState<unknown>(null);
  const [me, setMe] = useState<MySubscription | null>(null);
  const [txns, setTxns] = useState<WalletTransaction[]>([]);
  const [historyError, setHistoryError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [savingAutoRenew, setSavingAutoRenew] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [filter, setFilter] = useState<BonusFilter>(EMPTY_BONUS_FILTER);
  const set = <K extends keyof BonusFilter>(key: K) => (value: BonusFilter[K]): void =>
    setFilter((f) => ({ ...f, [key]: value }));

  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++generation.current;
    const [w, h, m] = await Promise.allSettled([
      walletApi.bonusWallet(),
      walletApi.bonusHistory(100),
      subscriptionApi.me(),
    ]);
    // A newer refresh (or leaving the screen) overtook this one.
    if (!alive.current || mine !== generation.current) return;
    if (w.status === 'fulfilled') { setWallet(w.value); setWalletError(null); } else setWalletError(w.reason);
    if (h.status === 'fulfilled') { setTxns(h.value); setHistoryError(null); } else setHistoryError(h.reason);
    if (m.status === 'fulfilled') setMe(m.value);
    setNow(new Date());
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Live update when money lands (earnings, copy fees, Add Funds, plan charges).
  useChannel('user:bonusWallet', () => { void refresh(); });
  useForeground(() => { void refresh(); });
  // Back on this screen (from Plans, say, after a purchase): reload, as the
  // web does by mounting the page afresh. Only after the screen was left.
  useEffect(() => {
    let away = false;
    const offBlur = navigation.addListener('blur', () => { away = true; });
    const offFocus = navigation.addListener('focus', () => {
      if (!away) return;
      away = false;
      void refresh();
    });
    return () => { offBlur(); offFocus(); };
  }, [navigation, refresh]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const sub = me?.subscription ?? null;
  const countdown = useMemo(() => planCountdown(sub, now), [sub, now]);
  const badge = subscriptionStatusBadge(me);

  const toggleAutoRenew = async (next: boolean): Promise<void> => {
    setSavingAutoRenew(true);
    try {
      const on = await walletApi.setBonusAutoRenew(next);
      // The server's answer, at once. Waiting for the reload below (as the
      // web does) re-enables the switch still showing the OLD state under a
      // "disabled" toast, and a second tap re-sends the same change.
      if (alive.current) setWallet((w) => (w ? { ...w, autoRenew: on } : w));
      toast.success(autoRenewToast(next));
      void refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      if (alive.current) setSavingAutoRenew(false);
    }
  };

  const typeOptions = useMemo(() => bonusTypeOptions(txns), [txns]);
  const filtered = useMemo(() => filterBonusTxns(txns, filter), [txns, filter]);
  const filtering = hasBonusFilter(filter);
  const clearFilters = (): void => setFilter(EMPTY_BONUS_FILTER);

  const nav = <WalletNav activeId="bonus" />;

  if (loading && !wallet) {
    return (
      <Screen>
        {nav}
        <LoadingView label="Loading wallet…" />
      </Screen>
    );
  }

  if (!wallet) {
    return (
      <Screen onRefresh={refresh}>
        {nav}
        <ErrorView error={walletError} onRetry={() => { setLoading(true); void refresh(); }} />
      </Screen>
    );
  }

  const ccy = 'INR';
  const isLow = billingWalletIsLow(wallet);

  return (
    <Screen onRefresh={refresh}>
      {nav}
      <PageHero
        eyebrow="Wallet"
        title="Main Wallet"
        subtitle="Holds your referral and partner earnings, copy-trading fees and the funds you add. Your plans are billed from here. Add funds or withdraw anytime."
      />

      <View style={s.sections}>
        {/* ── Balance ───────────────────────────────────────────────── */}
        <View style={[s.balanceCard, t.shadow.card]}>
          <View style={[s.glow, { backgroundColor: t.alpha('#16A34A', 0.07) }]} pointerEvents="none" />
          <View style={s.inline}>
            <View style={[s.dot, { backgroundColor: t.colors.bull }]} />
            <AppText variant="micro" tone="muted" weight="800" style={s.eyebrow}>Main wallet</AppText>
          </View>
          <AppText
            style={s.balance}
            mono
            numberOfLines={1}
            adjustsFontSizeToFit
            accessibilityLabel={`Main wallet balance ${fmtMoney(wallet.balance || '0', ccy)}`}
          >
            {fmtMoney(wallet.balance || '0', ccy)}
          </AppText>
          <AppText variant="small" tone="muted">
            {'Lifetime earnings: '}
            <AppText variant="small" tone="secondary" weight="600" mono>{fmtMoney(wallet.totalEarnings || '0', ccy)}</AppText>
          </AppText>

          {/* Add Funds (instant from a live trading account, or UPI / bank
              transfer verified by an admin) and Withdraw, which cashes out
              the balance (admin-approved, refunded if rejected). */}
          <View style={s.actions}>
            <Button title="Add Funds" leftIcon="plus" onPress={() => setDepositOpen(true)} style={s.flex} />
            <Button title="Withdraw" leftIcon="arrowDown" variant="secondary" onPress={() => setWithdrawOpen(true)} style={s.flex} />
          </View>

          <View style={s.stats}>
            {bonusStats(wallet).map((st) => (
              <View key={st.label} style={s.stat}>
                <AppText variant="micro" tone="muted" weight="700" style={s.caps} numberOfLines={2}>{st.label}</AppText>
                <AppText variant="h3" weight="700" mono numberOfLines={1} adjustsFontSizeToFit style={s.statValue}>
                  {fmtMoney(st.value, ccy)}
                </AppText>
              </View>
            ))}
          </View>
        </View>

        {/* ── Subscription: plan · renews in · auto-renew (billed from here) ── */}
        <View>
          <SectionHeader
            title="Subscription"
            actionLabel="Manage plans →"
            onAction={() => navigation.navigate('Plans')}
            style={s.sectionHead}
          />
          <View style={s.tiles}>
            <StatusTile
              label="Current plan"
              value={me?.effectivePlan?.name || '—'}
              sub={billingCycleSub(sub)}
              badge={badge}
            />
            <StatusTile
              label="Renews in"
              value={countdown ? countdown.label : '—'}
              sub={planPeriodLabel(sub)}
              tone={countdown?.expired ? 'bear' : undefined}
            />
            <View style={s.tile}>
              <AppText variant="micro" tone="muted" weight="700" style={s.caps}>Auto-renew</AppText>
              <View style={s.tileRow}>
                <AppText variant="h3" weight="700" tone={wallet.autoRenew ? 'bull' : 'muted'}>
                  {wallet.autoRenew ? 'Enabled' : 'Disabled'}
                </AppText>
                <Toggle
                  value={wallet.autoRenew}
                  onValueChange={(next) => { void toggleAutoRenew(next); }}
                  disabled={savingAutoRenew}
                  accessibilityLabel="Auto-renew"
                />
              </View>
              <AppText variant="caption" tone="muted" style={s.tileNote}>{autoRenewNote(wallet.gracePeriodDays)}</AppText>
            </View>
          </View>
          {isLow ? (
            <View style={[s.warn, { borderColor: t.alpha(t.colors.warn, 0.4), backgroundColor: t.alpha(t.colors.warn, 0.1) }]}>
              <AppText variant="small" weight="600" color={t.colors.warn} style={s.flex}>{LOW_BALANCE_WARNING}</AppText>
              <Pressable accessibilityRole="button" onPress={() => setDepositOpen(true)} hitSlop={8}>
                <AppText variant="small" weight="700" color={t.colors.warn} style={s.underline}>Add Funds</AppText>
              </Pressable>
            </View>
          ) : null}
        </View>

        {/* ── Transaction history ───────────────────────────────────── */}
        <View style={s.historyCard}>
          <View style={[s.historyHead, { borderBottomColor: t.colors.borderSubtle }]}>
            <AppText variant="title" style={s.flex}>Transaction History</AppText>
            <AppText variant="small" tone="muted">{bonusRecordsLabel(filtered.length, txns.length, filtering)}</AppText>
          </View>

          {txns.length > 0 ? (
            <View style={[s.filters, { borderBottomColor: t.colors.borderSubtle }]}>
              <Input
                value={filter.q}
                onChangeText={set('q')}
                placeholder="Search description or ID..."
                accessibilityLabel="Search description or ID"
                autoCapitalize="none"
                autoCorrect={false}
                left={<Icon name="search" size={14} color={t.colors.textMuted} strokeWidth={2} />}
              />
              <View style={s.filterRow}>
                <Select
                  value={filter.type}
                  onChange={set('type')}
                  title="Type"
                  accessibilityLabel="Type"
                  style={s.flex}
                  options={[{ value: '', label: 'All types' }, ...typeOptions.map((r) => ({ value: r, label: bonusReasonLabel(r) }))]}
                />
                <Select
                  value={filter.status}
                  onChange={set('status')}
                  title="Status"
                  accessibilityLabel="Status"
                  style={s.flex}
                  options={[{ value: '', label: 'All statuses' }, ...BONUS_STATUS_OPTIONS.map((x) => ({ value: x, label: x }))]}
                />
              </View>
              <Select
                value={filter.dir}
                onChange={set('dir')}
                title="Direction"
                accessibilityLabel="Direction"
                options={[
                  { value: '', label: 'All' },
                  { value: 'CREDIT', label: 'Credit (+)' },
                  { value: 'DEBIT', label: 'Debit (-)' },
                ]}
              />
              <View style={s.filterRow}>
                <DateField
                  label="From"
                  value={filter.from}
                  onChange={set('from')}
                  max={filter.to || undefined}
                />
                <AppText variant="small" tone="muted">to</AppText>
                <DateField
                  label="To"
                  value={filter.to}
                  onChange={set('to')}
                  min={filter.from || undefined}
                />
              </View>
              {filtering ? (
                <Pressable accessibilityRole="button" onPress={clearFilters} hitSlop={8} style={s.clear}>
                  <AppText variant="small" weight="600" tone="muted">Clear</AppText>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {historyError && txns.length === 0 ? (
            <ErrorView error={historyError} onRetry={() => { void refresh(); }} compact />
          ) : txns.length === 0 ? (
            <AppText variant="body" tone="muted" align="center" style={s.empty}>
              No transactions yet. Earnings, copy-trading fees, funds you add and plan charges will appear here.
            </AppText>
          ) : filtered.length === 0 ? (
            <AppText variant="body" tone="muted" align="center" style={s.empty}>
              {'No transactions match your filters. '}
              <AppText variant="body" weight="600" color={t.colors.primaryText} accessibilityRole="button" onPress={clearFilters}>
                Clear filters
              </AppText>
            </AppText>
          ) : (
            // Bounded: the request asks for the last 100.
            filtered.map((txn) => <BonusTxnRow key={txn.id} txn={txn} currency={ccy} />)
          )}
        </View>
      </View>

      <BonusWalletDepositSheet
        open={depositOpen}
        currency={ccy}
        onClose={() => setDepositOpen(false)}
        onSuccess={() => { setDepositOpen(false); void refresh(); }}
        onOpenAccount={() => navigation.navigate('NewAccountTiers')}
      />

      <UserWalletWithdrawSheet
        open={withdrawOpen}
        title="Withdraw from Main Wallet"
        currency={ccy}
        balance={wallet.balance || '0'}
        onClose={() => setWithdrawOpen(false)}
        onSuccess={() => { setWithdrawOpen(false); void refresh(); }}
        onManage={() => navigation.navigate('Wallet', { view: 'withdrawal-methods' })}
      />
    </Screen>
  );
}

/** BonusWallet.jsx `StatusTile`. */
function StatusTile({
  label,
  value,
  sub,
  badge,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  badge?: StatusBadge;
  tone?: 'bear';
}): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  return (
    <View style={s.tile}>
      <AppText variant="micro" tone="muted" weight="700" style={s.caps}>{label}</AppText>
      <View style={s.tileRow}>
        <AppText variant="h3" weight="700" tone={tone === 'bear' ? 'bear' : 'primary'} style={s.flex} numberOfLines={1}>
          {value}
        </AppText>
        {badge ? (
          <View style={[s.statusChip, { backgroundColor: t.alpha(badge.fg, 0.094) }]}>
            <AppText variant="micro" weight="700" color={badge.fg} style={s.caps}>{badge.label}</AppText>
          </View>
        ) : null}
      </View>
      {sub ? <AppText variant="caption" tone="muted" style={s.tileSub}>{sub}</AppText> : null}
    </View>
  );
}

/** One history row — the web's seven table columns as a card. */
function BonusTxnRow({ txn, currency }: { txn: WalletTransaction; currency: string }): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  const credit = isBonusCredit(txn);
  const fg = credit ? '#16A34A' : '#DC2626';
  const status = txn.status || 'SUCCESS';
  return (
    <View style={[s.row, { borderBottomColor: t.colors.borderSubtle }]}>
      <View style={s.rowTop}>
        <View style={[s.typeChip, { backgroundColor: t.alpha(fg, 0.078) }]}>
          <AppText variant="caption" weight="600" color={fg} numberOfLines={1}>{bonusReasonLabel(txn.reason)}</AppText>
        </View>
        <AppText variant="bodyStrong" weight="700" mono color={fg} style={s.amount}>{bonusAmountText(txn, currency)}</AppText>
      </View>
      <AppText variant="small" tone="muted" numberOfLines={2}>{txn.note || '—'}</AppText>
      <View style={s.rowMeta}>
        <AppText variant="caption" tone="secondary">{fmtDateTime(txn.createdAt)}</AppText>
        <AppText variant="caption" tone="secondary" mono>
          {`Bal ${txn.balanceAfter != null ? fmtMoney(txn.balanceAfter, currency) : '—'}`}
        </AppText>
      </View>
      <View style={s.rowMeta}>
        <AppText variant="micro" tone="muted" mono>{shortTxnId(txn.id)}</AppText>
        <Badge label={status} tone={txnStatusTone(status)} size="xs" />
      </View>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  flex: { flex: 1, minWidth: 0 },
  sections: { gap: 20 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
  caps: { textTransform: 'uppercase', letterSpacing: 0.6 },
  eyebrow: { textTransform: 'uppercase', letterSpacing: 1.8 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  balanceCard: {
    backgroundColor: t.colors.surface,
    borderWidth: 2,
    borderColor: t.colors.borderDark,
    borderRadius: 24,
    padding: t.space.xxl,
    overflow: 'hidden',
  },
  glow: { position: 'absolute', top: -64, right: -64, width: 192, height: 192, borderRadius: 96 },
  balance: {
    fontSize: 44,
    lineHeight: 52,
    fontWeight: '800',
    color: t.colors.textPrimary,
    letterSpacing: -0.5,
    marginTop: t.space.sm,
  },
  actions: { flexDirection: 'row', gap: t.space.sm, marginTop: t.space.lg },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.md, marginTop: t.space.xxl },
  stat: {
    flexBasis: '46%',
    flexGrow: 1,
    borderRadius: t.radius.xxl,
    borderWidth: 1,
    borderColor: t.colors.borderSubtle,
    backgroundColor: t.colors.bgCard,
    paddingHorizontal: t.space.lg,
    paddingVertical: t.space.md,
  },
  statValue: { marginTop: t.space.xs },
  sectionHead: { marginBottom: t.space.sm },
  tiles: { gap: t.space.md },
  tile: {
    borderRadius: t.radius.xxl,
    borderWidth: 1,
    borderColor: t.colors.borderDark,
    backgroundColor: t.alpha(t.colors.bgHover, 0.3),
    padding: t.space.lg,
  },
  tileRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.space.sm, marginTop: t.space.xs },
  tileSub: { marginTop: 2 },
  tileNote: { marginTop: 6 },
  statusChip: { borderRadius: t.radius.full, paddingHorizontal: t.space.sm, paddingVertical: 2 },
  warn: {
    marginTop: t.space.md,
    borderRadius: t.radius.xl,
    borderWidth: 1,
    paddingHorizontal: t.space.lg,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.space.md,
  },
  underline: { textDecorationLine: 'underline' },
  historyCard: {
    backgroundColor: t.colors.surface,
    borderWidth: 1,
    borderColor: t.colors.borderDark,
    borderRadius: t.radius.xxl,
    overflow: 'hidden',
    ...t.shadow.card,
  },
  historyHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.space.md,
    paddingHorizontal: t.space.xl,
    paddingVertical: t.space.lg,
    borderBottomWidth: 1,
  },
  filters: { paddingHorizontal: t.space.xl, paddingVertical: t.space.md, borderBottomWidth: 1, gap: 10 },
  filterRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  clear: { alignSelf: 'flex-end', paddingHorizontal: t.space.sm, paddingVertical: 6 },
  empty: { paddingHorizontal: t.space.xl, paddingVertical: 40 },
  row: { paddingHorizontal: t.space.lg, paddingVertical: t.space.md, borderBottomWidth: 1, gap: 4 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.space.md },
  rowMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.space.sm },
  typeChip: { borderRadius: t.radius.sm, paddingHorizontal: t.space.sm, paddingVertical: 2, flexShrink: 1 },
  amount: { flexShrink: 0 },
}));
