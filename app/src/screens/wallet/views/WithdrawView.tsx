import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { walletApi } from '@/api/wallet.api';
import { AppText, Button, Card, EmptyState, ErrorView, LoadingView, Skeleton, toast } from '@/components/ui';
import {
  AccountChoiceCard,
  AmountInput,
  ChoiceCard,
  FlowFooter,
  FlowGlyph,
  FlowHeader,
  MethodGlyph,
  Notice,
  PresetGrid,
  ReviewCard,
  StepBar,
  StepTitle,
  SummaryStrip,
  TxStatusBadge,
  useLiveWalletReload,
} from '@/components/wallet/PayToCard';
import { VerifiedDestinationList, WithdrawalMethodsModal, useWithdrawalMethods } from '@/components/wallet/WithdrawalMethods';
import { useAppNavigation } from '@/navigation/types';
import { useSelectedAccountStore } from '@/store/selectedAccount';
import { useTheme } from '@/theme';
import { verifiedForRail, type DepositDetails, type WalletBalance, type Withdrawal } from '@/types/wallet';
import {
  RECENT_PAGE,
  WITHDRAW_METHODS_FAILED,
  WITHDRAW_METHODS_NONE,
  accountTotal,
  apiErrorCode,
  availableToWithdraw,
  buildWithdrawalPayload,
  coerceWithdrawRail,
  defaultFlowAccountId,
  fmtDateTime,
  fmtFlowAmount,
  fmtMoney,
  isDemoLike,
  isOverBudget,
  isShareSelected,
  isStaleMethodRefusal,
  shareOf,
  withdrawAmountNote,
  withdrawCanNext,
  withdrawFee,
  withdrawFooterNote,
  withdrawLimits,
  withdrawPrimaryLabel,
  withdrawProblem,
  withdrawRailMeta,
  withdrawRails,
  withdrawReviewRows,
  withdrawSteps,
  withdrawSuccessMessage,
  type LoadState,
} from '@/utils/fundsFlows';
import { EMPTY, fmtNum } from '@/utils/money';

export interface WithdrawViewProps {
  /** Money moved — the hub reloads and returns to its overview. */
  onDone: () => void;
  /** Cancel / close. */
  onCancel: () => void;
  /** The hub's pull-to-refresh counter; each change re-reads balances and withdrawals. Optional. */
  refreshKey?: number;
}

/**
 * Withdraw Funds — EquityHub's WithdrawView (Wallet.jsx): Account → Method →
 * Amount → Destination → Confirmation, and Recent Withdrawals under the
 * flow. INR only.
 *
 * The rails come from the admin's config (open for PAYOUTS, with their own
 * per-transaction limits and withdrawal fee); none is offered until it has
 * landed. A live payout goes ONLY to a saved, VERIFIED destination on the
 * chosen rail, named by id. A practice account skips the method and
 * destination steps and is paid out instantly.
 *
 * Differences from the web, all deliberate (see utils/fundsFlows): a VIRTUAL
 * account is practice money, as the server treats it; MAX and the
 * percentages round DOWN to the cent; the fee preview reads a custom rail's
 * own config and the review card shows that fee; the saved methods are
 * re-read when the server says the chosen one went stale.
 */
export function WithdrawView({ onDone, onCancel, refreshKey }: WithdrawViewProps): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  const accounts = useSelectedAccountStore((s) => s.accounts);
  const accountsLoading = useSelectedAccountStore((s) => s.loading);
  const accountsError = useSelectedAccountStore((s) => s.error);
  const reloadAccounts = useSelectedAccountStore((s) => s.load);
  const { methods: savedMethods, reload: reloadMethods } = useWithdrawalMethods();

  /* ── What the flow reads ─────────────────────────────────────────── */
  const [balances, setBalances] = useState<WalletBalance[]>([]);
  const [balancesError, setBalancesError] = useState<unknown>(null);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [withdrawalsState, setWithdrawalsState] = useState<LoadState>('loading');
  const [withdrawalsError, setWithdrawalsError] = useState<unknown>(null);
  // The admin's payout rails — open for withdrawals, with fee and limits.
  const [payDetails, setPayDetails] = useState<DepositDetails | null>(null);
  const [payState, setPayState] = useState<LoadState>('loading');
  const [shown, setShown] = useState(RECENT_PAGE);
  const [manageOpen, setManageOpen] = useState(false);

  // A failed RE-read keeps what is on screen; only a read that never
  // succeeded shows its error.
  const balancesLoaded = useRef(false);
  const loadBalances = useCallback(async () => {
    try {
      const next = await walletApi.balances();
      balancesLoaded.current = true;
      setBalances(next);
      setBalancesError(null);
    } catch (e) {
      if (!balancesLoaded.current) setBalancesError(e);
    }
  }, []);

  const withdrawalsLoaded = useRef(false);
  const loadWithdrawals = useCallback(async () => {
    try {
      const next = await walletApi.withdrawals();
      withdrawalsLoaded.current = true;
      setWithdrawals(next);
      setWithdrawalsState('ready');
    } catch (e) {
      if (withdrawalsLoaded.current) return;
      setWithdrawalsError(e);
      setWithdrawalsState('error');
    }
  }, []);

  useEffect(() => {
    let live = true;
    void loadBalances();
    void loadWithdrawals();
    walletApi.depositDetails()
      .then((d) => { if (live) { setPayDetails(d); setPayState('ready'); } })
      .catch(() => { if (live) { setPayDetails(null); setPayState('error'); } });
    return () => { live = false; };
  }, [loadBalances, loadWithdrawals]);

  // The page re-reads on every wallet / position event and re-renders this
  // view with it.
  useLiveWalletReload(() => {
    void loadBalances();
    void loadWithdrawals();
  }, refreshKey);

  /* ── Form state ──────────────────────────────────────────────────── */
  const [step, setStep] = useState(0);
  const [accountId, setAccountId] = useState(() => defaultFlowAccountId(accounts));
  const [method, setMethod] = useState('UPI');
  const [amount, setAmount] = useState('');
  const [withdrawalMethodId, setWithdrawalMethodId] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (accountId && accounts.some((a) => a.id === accountId)) return;
    const next = defaultFlowAccountId(accounts);
    if (next !== accountId) setAccountId(next);
  }, [accountId, accounts]);

  const rails = useMemo(() => (payState === 'ready' ? withdrawRails(payDetails) : []), [payDetails, payState]);

  // A rail the admin closed (or the default UPI, if it is closed) moves to
  // the first one still open.
  const railsKey = rails.map((r) => r.id).join(',');
  useEffect(() => {
    const next = coerceWithdrawRail(rails, method);
    if (next !== method) setMethod(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railsKey, method]);

  /* ── Derived ─────────────────────────────────────────────────────── */
  const selectedAccount = accounts.find((a) => a.id === accountId) ?? null;
  const isDemo = !!selectedAccount && isDemoLike(selectedAccount.accountType);
  const steps = withdrawSteps(isDemo);
  const index = Math.min(step, steps.length - 1);
  const stepId = steps[index]?.id;
  const chosenRail = rails.find((r) => r.id === method) ?? null;
  const selectedMethodMeta = chosenRail ?? rails[0] ?? null;
  const railLabel = selectedMethodMeta?.label ?? method;

  const available = availableToWithdraw(balances, accountId);
  const overBudget = isOverBudget(amount, available);
  const amt = Number(amount) || 0;
  const { belowMin, aboveMax } = withdrawLimits({ amount, rail: chosenRail, isDemo });
  const fee = withdrawFee(chosenRail, amt);
  const amountNote = withdrawAmountNote({ overBudget, belowMin, aboveMax, rail: chosenRail });

  // Verified methods of the chosen rail; a selection that stops matching it
  // is dropped.
  const verifiedOfRail = useMemo(() => verifiedForRail(savedMethods, method), [savedMethods, method]);
  const selectedMethod = verifiedOfRail.find((m) => m.id === withdrawalMethodId) ?? null;
  const verifiedKey = verifiedOfRail.map((m) => m.id).join(',');
  useEffect(() => {
    if (withdrawalMethodId && !verifiedOfRail.some((m) => m.id === withdrawalMethodId)) setWithdrawalMethodId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifiedKey, withdrawalMethodId]);

  const canNext = withdrawCanNext({
    stepId,
    accountId,
    payReady: payState === 'ready',
    methodListed: !!chosenRail,
    amount,
    belowMin,
    aboveMax,
    overBudget,
    withdrawalMethodId: selectedMethod ? withdrawalMethodId : '',
  });

  const goNext = (): void => setStep(Math.min(index + 1, steps.length - 1));
  const goBack = (): void => setStep(Math.max(index - 1, 0));

  // A method verified since the flow opened is on the list when the user
  // arrives at the destination step.
  useEffect(() => {
    if (stepId === 'destination') void reloadMethods();
  }, [stepId, reloadMethods]);

  /* ── Submit ──────────────────────────────────────────────────────── */

  const destinationIndex = steps.findIndex((s) => s.id === 'destination');
  const submit = useCallback(async () => {
    const problem = withdrawProblem(amount, available);
    if (problem) {
      toast.error(problem);
      return;
    }
    setLoading(true);
    try {
      // Live: the saved verified method's id ONLY. Practice: the rail.
      await walletApi.createWithdrawal(buildWithdrawalPayload({
        accountId,
        amount,
        isDemo,
        method,
        withdrawalMethodId,
      }));
      toast.success(withdrawSuccessMessage(isDemo));
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
      // The saved method was archived, blocked or never verified since the
      // list loaded: re-read it and go back to Destination.
      if (isStaleMethodRefusal(apiErrorCode(e))) {
        void reloadMethods();
        if (!isDemo && destinationIndex >= 0) setStep(destinationIndex);
      }
    } finally {
      setLoading(false);
    }
  }, [accountId, amount, available, destinationIndex, isDemo, method, onDone, reloadMethods, withdrawalMethodId]);

  /* ── Render ──────────────────────────────────────────────────────── */

  const demoNotice = (
    <Notice tone="info">✨ Demo withdrawals are processed instantly — no payment details or admin review needed.</Notice>
  );

  let body: React.ReactNode = null;

  if (accounts.length === 0) {
    body = accountsLoading
      ? <LoadingView />
      : accountsError
        ? <ErrorView compact error={accountsError} title="Could not load your accounts" onRetry={() => { void reloadAccounts(); }} />
        : (
          <EmptyState
            icon="wallet"
            title="No accounts yet"
            message="Create your first trading account to start."
            actionLabel="+ Create Account"
            onAction={() => nav.navigate('NewAccountTiers')}
          />
        );
  } else if (stepId === 'account') {
    body = (
      <View style={styles.stack}>
        <StepTitle large title="Withdraw from" sub="Pick an account to withdraw funds from." />
        {accounts.map((a) => {
          // `free`, not `balance`: locked margin cannot leave. The part that
          // cannot is named, so this card and the deposit one disagreeing
          // reads as an explanation.
          const locked = accountTotal(balances, a.id, 'locked');
          return (
            <AccountChoiceCard
              key={a.id}
              account={a}
              selected={a.id === accountId}
              onPress={() => setAccountId(a.id)}
              figure={balancesError ? EMPTY : fmtMoney(accountTotal(balances, a.id, 'free'))}
              caption={locked > 0 ? `Available · ${fmtMoney(locked)} locked in open positions` : 'Available'}
              chip="INR"
            />
          );
        })}
        {isDemo ? demoNotice : null}
      </View>
    );
  } else if (stepId === 'method') {
    body = (
      <View style={styles.stack}>
        <StepTitle title="Choose withdrawal method" sub="Where should we send the funds?" />
        {payState === 'loading' ? (
          <View style={styles.stack} accessibilityLabel="Loading withdrawal methods">
            {[0, 1, 2].map((i) => (
              <View key={i} style={[styles.skeletonCard, { borderColor: t.colors.borderDark, borderRadius: t.radius.xl }]}>
                <Skeleton width={44} height={44} />
                <View style={styles.flex}>
                  <Skeleton width={96} height={12} />
                  <Skeleton width={128} height={10} style={styles.mt6} />
                </View>
              </View>
            ))}
          </View>
        ) : null}
        {payState === 'error' ? <Notice tone="amber">{WITHDRAW_METHODS_FAILED}</Notice> : null}
        {payState === 'ready' && rails.length === 0 ? <Notice tone="amber">{WITHDRAW_METHODS_NONE}</Notice> : null}
        {rails.map((r) => (
          <ChoiceCard
            key={r.id}
            testID={`withdraw-method-${r.id}`}
            selected={method === r.id}
            onPress={() => setMethod(r.id)}
            leading={<MethodGlyph kind={r.glyph} emoji={r.emoji} />}
            title={r.label}
            sub={r.sub}
            meta={withdrawRailMeta(r)}
          />
        ))}
      </View>
    );
  } else if (stepId === 'amount') {
    body = (
      <View style={styles.stack}>
        <StepTitle title="How much would you like to withdraw?" sub="Pick a preset or enter your own." />
        {balancesError ? (
          <ErrorView compact error={balancesError} title="Could not load your balances" onRetry={() => { void loadBalances(); }} />
        ) : null}

        {/* Available balance hero */}
        <View style={[styles.hero, { backgroundColor: t.alpha(t.colors.bull, 0.05), borderColor: t.alpha(t.colors.bull, 0.3), borderRadius: t.radius.xl }]}>
          <View style={styles.flex}>
            <AppText variant="micro" tone="muted" weight="700" style={styles.upper}>Available to Withdraw</AppText>
            <AppText variant="h2" tone="bull" mono style={styles.mt4}>{fmtMoney(available)}</AppText>
          </View>
          <Button
            title="Use MAX"
            size="sm"
            variant="bull"
            onPress={() => setAmount(shareOf(available, 100))}
            disabled={available <= 0}
          />
        </View>

        {/* Percent presets — floored to the cent */}
        <PresetGrid
          columns={4}
          options={[25, 50, 75, 100].map((pct) => ({
            key: String(pct),
            label: pct === 100 ? 'MAX' : `${pct}%`,
            selected: isShareSelected(amount, available, pct),
          }))}
          onPick={(k) => setAmount(shareOf(available, Number(k)))}
        />

        <AmountInput
          testID="withdraw-amount"
          value={amount}
          onChangeText={setAmount}
          currency="INR"
          error={amountNote?.error ? amountNote.text : null}
        />
        {amountNote && !amountNote.error ? (
          <AppText variant="caption" tone="muted">{amountNote.text}</AppText>
        ) : null}

        <SummaryStrip
          cells={[
            { label: 'You Withdraw', value: fmtFlowAmount(amt) },
            { label: 'Fees', value: fmtFlowAmount(fee), tone: fee > 0 ? 'bear' : 'bull' },
            { label: 'You Receive', value: fmtFlowAmount(Math.max(0, amt - fee)) },
          ]}
        />
      </View>
    );
  } else if (stepId === 'destination') {
    body = (
      <View style={styles.stack}>
        <View style={styles.headRow}>
          <View style={styles.flex}>
            <AppText variant="title" weight="700">Withdrawal method</AppText>
            <AppText variant="small" tone="muted" style={styles.mt2}>
              {'Choose one of your '}
              <AppText variant="small" weight="700" tone="muted">verified</AppText>
              {` ${railLabel} destinations.`}
            </AppText>
          </View>
          <Button title="Manage" variant="secondary" size="sm" onPress={() => setManageOpen(true)} />
        </View>

        {verifiedOfRail.length === 0 ? (
          <View style={[styles.noneBox, { borderColor: t.colors.borderDark, borderRadius: t.radius.xl }]}>
            <AppText variant="bodyStrong" align="center">{`No verified ${railLabel} method available.`}</AppText>
            <AppText variant="caption" tone="muted" align="center" style={styles.mt4}>
              Please add and verify a withdrawal method before requesting a withdrawal. New destinations cannot be entered here.
            </AppText>
            <Button title="+ Add Withdrawal Method" size="sm" onPress={() => setManageOpen(true)} style={styles.noneBtn} />
          </View>
        ) : (
          <VerifiedDestinationList destinations={verifiedOfRail} value={withdrawalMethodId} onChange={setWithdrawalMethodId} />
        )}

        <Notice tone="bull" icon={<FlowGlyph name="shield" size={16} color={t.colors.bull} strokeWidth={2.4} />}>
          <AppText variant="small" tone="secondary">
            <AppText variant="small" weight="700">Security check.</AppText>
            {' Funds can only be sent to a previously verified destination. Withdrawals are processed manually within 1-24 hours; funds are locked immediately on submission.'}
          </AppText>
        </Notice>
      </View>
    );
  } else if (stepId === 'confirm') {
    body = (
      <View style={styles.stack}>
        <StepTitle title="Review & confirm" sub="Double-check the details before submitting." />
        <ReviewCard
          rows={withdrawReviewRows({
            account: selectedAccount,
            methodLabel: isDemo ? (chosenRail?.label ?? method) : railLabel,
            amount,
            fee: isDemo ? 0 : fee,
            destination: isDemo ? null : selectedMethod,
          })}
        />
        {isDemo ? demoNotice : (
          <Notice tone="bull" icon={<FlowGlyph name="shield" size={16} color={t.colors.bull} strokeWidth={2.4} />}>
            Funds will be locked immediately on submit. Admin verifies and releases within 1–24 hours.
          </Notice>
        )}
      </View>
    );
  }

  const last = index >= steps.length - 1;
  const recent = withdrawals.slice(0, shown);

  return (
    <View style={styles.page}>
      <Card variant="plain" padded={false}>
        <FlowHeader title="Withdraw Funds" subtitle="Request a withdrawal to your registered bank or wallet" onClose={onCancel} />
        <StepBar steps={steps} index={index} />
        <View style={styles.body}>{body}</View>
        <FlowFooter
          first={index === 0}
          onCancel={onCancel}
          onBack={goBack}
          primaryLabel={last ? withdrawPrimaryLabel({ loading, isDemo, amount }) : 'Continue →'}
          onPrimary={last ? () => { void submit(); } : goNext}
          primaryDisabled={last ? loading || !canNext : !canNext || accounts.length === 0}
          loading={last && loading}
          note={withdrawFooterNote(isDemo)}
        />
      </Card>

      {/* Recent withdrawals — under the flow card, as rows rather than a table */}
      <Card variant="plain" padded={false}>
        <View style={[styles.recentHead, { borderBottomColor: t.colors.borderSubtle }]}>
          <AppText variant="bodyStrong" weight="700">Recent Withdrawals</AppText>
        </View>
        <View style={styles.recentBody}>
          {withdrawalsState === 'loading' ? <LoadingView label={null} style={styles.recentLoading} /> : null}
          {withdrawalsState === 'error' ? (
            <ErrorView compact error={withdrawalsError} title="Could not load withdrawals" onRetry={() => { void loadWithdrawals(); }} />
          ) : null}
          {withdrawalsState === 'ready' && withdrawals.length === 0 ? (
            <AppText variant="body" tone="muted" align="center" style={styles.none}>No withdrawals</AppText>
          ) : null}
          {recent.map((w) => (
            <View key={w.id} style={[styles.wRow, { borderColor: t.colors.borderSubtle, borderRadius: t.radius.lg }]}>
              <View style={styles.flex}>
                <View style={styles.inline}>
                  <AppText variant="bodyStrong" mono>{fmtNum(w.amount, 2)}</AppText>
                  <AppText variant="caption" tone="muted" mono>{w.currency}</AppText>
                </View>
                <AppText variant="caption" tone="secondary" style={styles.mt2}>
                  {`${w.method || '-'} · ${fmtDateTime(w.createdAt)}`}
                </AppText>
                <AppText variant="caption" tone="muted" numberOfLines={1} style={styles.mt2}>{w.destination || '-'}</AppText>
              </View>
              <TxStatusBadge status={w.status} />
            </View>
          ))}
          {withdrawals.length > shown ? (
            <Button title="Show more" variant="ghost" size="sm" onPress={() => setShown((n) => n + RECENT_PAGE)} />
          ) : null}
        </View>
      </Card>

      <WithdrawalMethodsModal
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        onChanged={() => { void reloadMethods(); }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { gap: 16 },
  body: { padding: 16 },
  stack: { gap: 14 },
  flex: { flex: 1, minWidth: 0 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  upper: { textTransform: 'uppercase', letterSpacing: 0.6 },
  mt2: { marginTop: 2 },
  mt4: { marginTop: 4 },
  mt6: { marginTop: 6 },
  hero: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, padding: 14 },
  skeletonCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 2, padding: 14 },
  noneBox: { borderWidth: 1, borderStyle: 'dashed', padding: 20, alignItems: 'center' },
  noneBtn: { marginTop: 12 },
  recentHead: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1 },
  recentBody: { padding: 16, gap: 8 },
  recentLoading: { minHeight: 80, paddingVertical: 12 },
  none: { paddingVertical: 12 },
  wRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10 },
});
