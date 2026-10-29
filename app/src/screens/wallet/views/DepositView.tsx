import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { accountApi } from '@/api/account.api';
import { errorMessage } from '@/api/client';
import { walletApi } from '@/api/wallet.api';
import { Badge, Card, EmptyState, ErrorView, Input, LoadingView, Skeleton, toast } from '@/components/ui';
import {
  AccountChoiceCard,
  AmountInput,
  ChoiceCard,
  FlowFooter,
  FlowGlyph,
  FlowHeader,
  MethodGlyph,
  Notice,
  PayToCard,
  PresetGrid,
  ProofPicker,
  ReviewCard,
  StepBar,
  StepTitle,
  SummaryStrip,
  useLiveWalletReload,
  type ProofImage,
} from '@/components/wallet/PayToCard';
import { RazorpayCheckout, type RazorpaySuccess } from '@/components/wallet/RazorpayCheckout';
import { useAppNavigation } from '@/navigation/types';
import { useSelectedAccountStore } from '@/store/selectedAccount';
import { useTheme } from '@/theme';
import type { AccountPlan } from '@/types/trading';
import { indexPlansByCode } from '@/types/user';
import type { DepositDetails, RazorpayOrder, WalletBalance } from '@/types/wallet';
import {
  DEPOSIT_METHODS_FAILED,
  DEPOSIT_METHODS_NONE,
  DEPOSIT_PRESETS,
  RAZORPAY_ID,
  RAZORPAY_NOT_SET_UP,
  TX_REFERENCE_MIN,
  accountTitle,
  accountTotal,
  belowMinDeposit,
  buildDepositPayload,
  canonicalAmount,
  defaultFlowAccountId,
  depositAssurance,
  depositCanNext,
  depositFee,
  depositMethodMeta,
  depositMethods,
  depositPrimaryLabel,
  depositReviewRows,
  depositSteps,
  depositSuccessMessage,
  fallbackDepositMethod,
  fmtFlowAmount,
  fmtMoney,
  isDemoLike,
  isLiveRazorpayOrder,
  isRealMoney,
  manualDepositProblem,
  minDepositNotice,
  minDepositToast,
  planMinDeposit,
  railWarningName,
  razorpayCreditedMessage,
  type LoadState,
} from '@/utils/fundsFlows';
import { EMPTY } from '@/utils/money';

export interface DepositViewProps {
  /** Money moved — the hub reloads and returns to its overview. */
  onDone: () => void;
  /** Cancel / close. */
  onCancel: () => void;
  /** The hub's pull-to-refresh counter; each change re-reads the balances. Optional. */
  refreshKey?: number;
}

/**
 * Add Funds — EquityHub's InlineDepositFlow (Wallet.jsx), step for step:
 * Account → Payment Method → Amount → Upload Proof → Confirmation. INR only.
 *
 * Which rails exist is the admin's decision and arrives over the network, so
 * until /wallet/deposit-details lands no method is offered (skeleton cards);
 * if it fails the user is told to reload before sending money. A card's
 * minimum is the rail's admin minimum or the account tier's, whichever is
 * higher, and the admin's deposit fee is previewed in "You Receive".
 *
 * A practice account and a Razorpay payment skip the proof step: the first
 * is credited on the spot with no money collected, the second is proven by
 * the gateway's signature instead of a screenshot.
 *
 * Differences from the web, all deliberate (see utils/fundsFlows): a VIRTUAL
 * account is practice money, as the server treats it; a Razorpay order from
 * the server's mock provider is never opened or verified; a live deposit's
 * reference must be at least four characters before the proof step lets
 * the user on.
 */
export function DepositView({ onDone, onCancel, refreshKey }: DepositViewProps): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  const accounts = useSelectedAccountStore((s) => s.accounts);
  const accountsLoading = useSelectedAccountStore((s) => s.loading);
  const accountsError = useSelectedAccountStore((s) => s.error);
  const reloadAccounts = useSelectedAccountStore((s) => s.load);

  /* ── What the flow reads ─────────────────────────────────────────── */
  const [balances, setBalances] = useState<WalletBalance[]>([]);
  const [balancesFailed, setBalancesFailed] = useState(false);
  // Admin-configured "where to send money" — null until it lands, and when
  // the load fails (`payState` says which).
  const [payDetails, setPayDetails] = useState<DepositDetails | null>(null);
  const [payState, setPayState] = useState<LoadState>('loading');
  // Tier catalogue, for each tier's minimum deposit. {} on failure.
  const [plans, setPlans] = useState<Record<string, AccountPlan>>({});

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // The account cards' balances. A failed RE-read keeps the figures already
  // on screen; only a first failure shows the dash.
  const balancesLoaded = useRef(false);
  const loadBalances = useCallback(async () => {
    try {
      const b = await walletApi.balances();
      if (!alive.current) return;
      balancesLoaded.current = true;
      setBalances(b);
      setBalancesFailed(false);
    } catch {
      if (alive.current && !balancesLoaded.current) setBalancesFailed(true);
    }
  }, []);

  // The web's page re-reads on every wallet / position event and the open
  // flow re-renders with it; this view reads for itself, so it listens too.
  useLiveWalletReload(() => { void loadBalances(); }, refreshKey);

  useEffect(() => {
    let live = true;
    void loadBalances();
    walletApi.depositDetails()
      .then((d) => { if (live) { setPayDetails(d); setPayState('ready'); } })
      .catch(() => { if (live) { setPayDetails(null); setPayState('error'); } });
    accountApi.listPlans()
      .then((p) => { if (live) setPlans(indexPlansByCode(p)); })
      .catch(() => { if (live) setPlans({}); });
    return () => { live = false; };
  }, [loadBalances]);

  /* ── Form state ──────────────────────────────────────────────────── */
  const [accountId, setAccountId] = useState(() => defaultFlowAccountId(accounts));
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('UPI');
  const [txReference, setTxReference] = useState('');
  const [senderName, setSenderName] = useState('');
  const [senderUpiId, setSenderUpiId] = useState('');
  const [senderBankAccount, setSenderBankAccount] = useState('');
  const [proof, setProof] = useState<ProofImage | null>(null);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState(0);
  const [checkout, setCheckout] = useState<RazorpayOrder | null>(null);

  // The accounts can land after the view mounts (the web mounts this only
  // once they have); pick the default the first time they do.
  useEffect(() => {
    if (accountId && accounts.some((a) => a.id === accountId)) return;
    const next = defaultFlowAccountId(accounts);
    if (next !== accountId) setAccountId(next);
  }, [accountId, accounts]);

  // A method the admin hid falls back once details load.
  useEffect(() => {
    if (payDetails) setMethod((m) => fallbackDepositMethod(payDetails, m));
  }, [payDetails]);

  /* ── Derived ─────────────────────────────────────────────────────── */
  const selectedAccount = accounts.find((a) => a.id === accountId) ?? null;
  const isReal = !!selectedAccount && isRealMoney(selectedAccount.accountType);
  const isDemo = !!selectedAccount && isDemoLike(selectedAccount.accountType);
  const planMin = planMinDeposit(plans, selectedAccount);
  const methods = useMemo(
    () => (payState === 'ready' ? depositMethods(payDetails, planMin) : []),
    [payDetails, payState, planMin],
  );
  const amt = Number(amount) || 0;
  const belowMin = belowMinDeposit({ isReal, planMin, amount: amt });
  const isRazor = method === RAZORPAY_ID;
  const skipProof = isDemo || isRazor;
  const steps = depositSteps(skipProof);
  const index = Math.min(step, steps.length - 1);
  const stepId = steps[index]?.id;
  const chosen = methods.find((m) => m.id === method) ?? null;
  const selectedMethodMeta = chosen ?? methods[0] ?? null;
  const fee = depositFee(chosen, amt);

  const canNext = depositCanNext({
    stepId,
    accountId,
    payReady: payState === 'ready',
    methodListed: !!chosen,
    amount,
    method: chosen,
    belowMin,
    skipProof,
    hasProof: !!proof,
    txReference,
    senderName,
    isReal,
  });

  const goNext = (): void => setStep(Math.min(index + 1, steps.length - 1));
  const goBack = (): void => setStep(Math.max(index - 1, 0));

  /* ── Submit ──────────────────────────────────────────────────────── */

  const submitRazorpay = useCallback(async () => {
    if (!amount || Number(amount) <= 0) {
      toast.error('Enter a valid amount');
      return;
    }
    setLoading(true);
    try {
      // 1. The order, on the server.
      const order = await walletApi.razorpayOrder({ accountId, currency: 'INR', amount: canonicalAmount(amount) });
      // 2. Checkout — only for an order a real gateway stands behind. The
      //    mock provider's verify approves anything, so its orders are
      //    neither opened nor verified.
      if (!isLiveRazorpayOrder(order)) {
        toast.error(RAZORPAY_NOT_SET_UP);
        setLoading(false);
        return;
      }
      setCheckout(order);
    } catch (e) {
      toast.error(errorMessage(e));
      setLoading(false);
    }
  }, [accountId, amount]);

  // 3. Checkout's success handler — the one place /razorpay/verify is called.
  const onPaid = useCallback(async (payment: RazorpaySuccess) => {
    setCheckout(null);
    try {
      await walletApi.razorpayVerify(payment);
      toast.success(razorpayCreditedMessage(amount));
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [amount, onDone]);

  const submit = useCallback(async () => {
    // Mirrors the server's tier gate, so the refusal is immediate.
    if (belowMin) {
      toast.error(minDepositToast(selectedAccount, planMin));
      return;
    }
    if (isRazor) {
      await submitRazorpay();
      return;
    }
    const problem = manualDepositProblem({ isReal, hasProof: !!proof, txReference });
    if (problem) {
      toast.error(problem);
      return;
    }
    if (!selectedMethodMeta) return;
    setLoading(true);
    try {
      // Sent as the user entered it, so the admin's check against the
      // attached receipt is one-to-one.
      await walletApi.createDeposit(buildDepositPayload({
        accountId,
        amount,
        method: selectedMethodMeta,
        txReference,
        senderName,
        senderUpiId,
        senderBankAccount,
        proof,
        isReal,
      }));
      toast.success(depositSuccessMessage(isDemo, amount));
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [accountId, amount, belowMin, isDemo, isRazor, isReal, onDone, planMin, proof, selectedAccount, selectedMethodMeta, senderBankAccount, senderName, senderUpiId, submitRazorpay, txReference]);

  /* ── Render ──────────────────────────────────────────────────────── */

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
        <StepTitle large title="Select an account" sub="Choose which trading account to credit." />
        {accounts.map((a) => (
          <AccountChoiceCard
            key={a.id}
            account={a}
            selected={a.id === accountId}
            onPress={() => setAccountId(a.id)}
            figure={balancesFailed ? EMPTY : fmtMoney(accountTotal(balances, a.id, 'balance'))}
            caption="Balance"
            chip="INR"
          />
        ))}
      </View>
    );
  } else if (stepId === 'method') {
    body = (
      <View style={styles.stack}>
        <StepTitle title="Choose payment method" sub="Pick how you'd like to fund your account." />
        {payState === 'loading' ? (
          <View style={styles.stack} accessibilityLabel="Loading payment methods">
            {[0, 1, 2, 3].map((i) => (
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
        {payState === 'error' ? <Notice tone="amber">{DEPOSIT_METHODS_FAILED}</Notice> : null}
        {payState === 'ready' && methods.length === 0 ? <Notice tone="amber">{DEPOSIT_METHODS_NONE}</Notice> : null}
        {methods.map((m) => (
          <ChoiceCard
            key={m.id}
            testID={`deposit-method-${m.id}`}
            selected={method === m.id}
            onPress={() => setMethod(m.id)}
            leading={<MethodGlyph kind={m.glyph} emoji={m.emoji} />}
            title={m.label}
            badge={m.kind === 'instant' ? <Badge label="Instant" tone="primary" size="xs" /> : null}
            sub={m.sub}
            meta={depositMethodMeta(m)}
          />
        ))}
        {isReal && !isRazor && payState === 'ready' && selectedMethodMeta ? (
          <PayToCard
            rail={selectedMethodMeta.rail}
            label={railWarningName(selectedMethodMeta.rail, method)}
          />
        ) : null}
      </View>
    );
  } else if (stepId === 'amount') {
    body = (
      <View style={styles.stack}>
        <StepTitle title="Enter amount" sub="Pick a preset or enter your own." />
        <PresetGrid
          options={[
            ...DEPOSIT_PRESETS.map((p) => ({ key: String(p), label: fmtMoney(p, 'INR', 0), selected: amount === String(p) })),
            { key: 'custom', label: 'Custom', selected: !!amount && !DEPOSIT_PRESETS.some((p) => String(p) === amount) },
          ]}
          onPick={(k) => setAmount(k === 'custom' ? '' : k)}
        />
        <AmountInput testID="deposit-amount" value={amount} onChangeText={setAmount} currency="INR" />
        <SummaryStrip
          cells={[
            { label: 'You Pay', value: fmtFlowAmount(amt) },
            { label: 'Fees', value: fmtFlowAmount(fee), tone: fee > 0 ? 'bear' : 'bull' },
            { label: 'You Receive', value: fmtFlowAmount(Math.max(0, amt - fee)) },
          ]}
        />
        {belowMin ? (
          <Notice tone="bear">{minDepositNotice({ account: selectedAccount, min: planMin, amount: amt })}</Notice>
        ) : null}
        {isDemo ? (
          <Notice tone="info">✨ Demo accounts are credited instantly. No payment is collected.</Notice>
        ) : null}
      </View>
    );
  } else if (stepId === 'proof') {
    const refShort = isReal && txReference.trim().length > 0 && txReference.trim().length < TX_REFERENCE_MIN;
    body = (
      <View style={styles.stack}>
        <StepTitle title="Upload payment proof" sub="Drop a screenshot of the confirmation, plus your transaction reference." />
        <ProofPicker value={proof} onChange={setProof} />
        <Input
          label="Transaction reference *"
          placeholder="e.g. 4123456789012"
          value={txReference}
          onChangeText={setTxReference}
          autoCapitalize="characters"
          autoCorrect={false}
          mono
          error={refShort ? `At least ${TX_REFERENCE_MIN} characters` : null}
        />
        <Input
          label="Your name *"
          placeholder="As on bank / UPI"
          value={senderName}
          onChangeText={setSenderName}
          autoCapitalize="words"
        />
        {method === 'UPI' ? (
          <Input
            label="Your UPI ID"
            placeholder="yourname@upi"
            value={senderUpiId}
            onChangeText={setSenderUpiId}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            mono
          />
        ) : null}
        {method === 'BANK' ? (
          <Input
            label="Bank A/C last 4 digits"
            placeholder="1234"
            value={senderBankAccount}
            onChangeText={setSenderBankAccount}
            maxLength={4}
            keyboardType="number-pad"
            mono
          />
        ) : null}
      </View>
    );
  } else if (stepId === 'confirm') {
    body = (
      <View style={styles.stack}>
        <StepTitle title="Review & confirm" sub="Double-check the details before submitting." />
        <ReviewCard
          rows={depositReviewRows({
            account: selectedAccount,
            methodLabel: selectedMethodMeta?.label ?? method,
            amount,
            fee,
            isReal,
            isRazor,
            txReference,
            senderName,
          })}
        />
        <Notice tone="bull" icon={<FlowGlyph name="shield" size={16} color={t.colors.bull} strokeWidth={2.4} />}>
          {depositAssurance(isReal, isRazor)}
        </Notice>
      </View>
    );
  }

  const last = index >= steps.length - 1;

  return (
    <Card variant="plain" padded={false}>
      <FlowHeader title="Add Funds" subtitle="Securely add balance to your trading account" onClose={onCancel} />
      <StepBar steps={steps} index={index} />
      <View style={styles.body}>{body}</View>
      <FlowFooter
        first={index === 0}
        onCancel={onCancel}
        onBack={goBack}
        primaryLabel={last ? depositPrimaryLabel({ loading, isDemo, isRazor, amount }) : 'Continue →'}
        onPrimary={last ? () => { void submit(); } : goNext}
        primaryDisabled={last ? loading || !selectedAccount : !canNext || accounts.length === 0}
        loading={last && loading}
        note="Your funds are protected with bank-level security"
      />

      {checkout && checkout.keyId ? (
        <RazorpayCheckout
          keyId={checkout.keyId}
          orderId={checkout.orderId}
          amount={checkout.amount}
          currency={checkout.currency}
          description={`Deposit to ${accountTitle(selectedAccount)}`}
          onSuccess={(p) => { void onPaid(p); }}
          onDismiss={() => { setCheckout(null); setLoading(false); }}
          onFailure={(message) => { setCheckout(null); setLoading(false); toast.error(message); }}
        />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16 },
  stack: { gap: 14 },
  flex: { flex: 1, minWidth: 0 },
  mt6: { marginTop: 6 },
  skeletonCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 2, padding: 14 },
});
