import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { bonusTopUpError, insufficientTradingBalance, walletApi } from '@/api/wallet.api';
import { AppText, Badge, Button, Icon, Input, Modal, Select, Skeleton, Spinner, toast } from '@/components/ui';
import { PayToCard, ProofPicker, type ProofImage } from '@/components/wallet/PayToCard';
import { useSelectedAccountStore } from '@/store/selectedAccount';
import { makeStyles, useTheme } from '@/theme';
import type { DepositDetails, WalletBalance } from '@/types/wallet';
import type { LoadState } from '@/utils/fundsFlows';
import { CURRENCY_SYMBOL, fmtMoney } from '@/utils/money';
import {
  DEPOSIT_STEPS,
  LAST_DEPOSIT_STEP,
  TRADING_METHOD_ID,
  accountDisplayName,
  accountWalletBalance,
  cleanAmountInput,
  depositCanNext,
  depositSubmitError,
  instantTopUpBody,
  topUpAmountNote,
  topUpMethods,
  topUpPayTo,
  topUpPayToRail,
  topUpPresets,
  manualDepositBody,
  settleSourceAccount,
  topUpSourceAccounts,
  txReferencePlaceholder,
  type DepositDraft,
  type TopUpMethod,
} from '@/utils/userWallets';


/**
 * The Bonus Wallet's "Add Funds" — EquityHub's client/src/components/
 * DepositModal.jsx, which BonusWallet.jsx opens (it moved there from the
 * retired Main Wallet), in its four steps:
 *
 *   1. Method  → the admin's enabled rails (UPI / Bank / custom) once their
 *                list has landed, then the instant trading-account transfer
 *                (the only choice if that list fails to load)
 *   2. Amount  → within the rail's admin minimum and maximum, four quick
 *                amounts
 *   3. Proof   → a manual rail: where to pay, the reference, sender details
 *                and a screenshot. The trading transfer: which live account
 *   4. Review  → and submit
 *
 * A manual rail (POST /bonus-wallet/manual-deposit) creates a PENDING
 * deposit an admin verifies; the trading transfer (POST /bonus-wallet/
 * deposit) debits a LIVE trading wallet and credits the Bonus Wallet at
 * once — a practice account is never offered (the server refuses it).
 *
 * The trading-account picker lists accounts from the shared store, so it is
 * usable before the balances arrive. Until they do (or if that call fails)
 * each balance reads "—", never ₹0.00; and the oldest-account pre-selection
 * that lands with them does not overwrite a pick the user already made.
 */
export interface BonusWalletDepositSheetProps {
  open: boolean;
  /** Kept for callers; always INR. */
  currency?: string;
  onClose: () => void;
  onSuccess: () => void;
  /** "No real trading account yet. Open one →" — /accounts/new. */
  onOpenAccount: () => void;
}

export function BonusWalletDepositSheet({
  open,
  onClose,
  onSuccess,
  onOpenAccount,
}: BonusWalletDepositSheetProps): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();

  const [step, setStep] = useState(0);
  const [methodId, setMethodId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [txReference, setTxReference] = useState('');
  const [senderName, setSenderName] = useState('');
  const [senderUpiId, setSenderUpiId] = useState('');
  const [senderBankAccount, setSenderBankAccount] = useState('');
  const [proof, setProof] = useState<ProofImage | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Where the client should SEND money, per rail — the admin's settings.
  // Until they land no external rail is offered (`payState`).
  const [payDetails, setPayDetails] = useState<DepositDetails | null>(null);
  const [payState, setPayState] = useState<LoadState>('loading');

  // The instant transfer's source: a live, active trading account.
  const allAccounts = useSelectedAccountStore((st) => st.accounts);
  const accounts = useMemo(() => topUpSourceAccounts(allAccounts), [allAccounts]);
  // Null while GET /wallet/balances is in flight or after it failed: the
  // picker then shows each balance as unknown, never as a made-up $0.00.
  const [balances, setBalances] = useState<WalletBalance[] | null>(null);
  const [sourceAccountId, setSourceAccountId] = useState('');
  const [accountsLoading, setAccountsLoading] = useState(false);
  // Whether the user chose a source since the current load started — the
  // pre-selection that lands when it finishes must not undo their pick.
  const sourcePicked = useRef(false);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // A fresh form on every open (the web mounts a new modal each time), and
  // the payment settings with it.
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setMethodId(null);
    setAmount('');
    setTxReference('');
    setSenderName('');
    setSenderUpiId('');
    setSenderBankAccount('');
    setProof(null);
    setSubmitting(false);
    setSourceAccountId('');
    setPayState('loading');
    let cancelled = false;
    walletApi.depositDetails()
      .then((d) => {
        if (cancelled) return;
        setPayDetails(d);
        setPayState('ready');
      })
      .catch(() => { if (!cancelled) { setPayDetails(null); setPayState('error'); } });
    return () => { cancelled = true; };
  }, [open]);

  const methods = useMemo(() => topUpMethods(payDetails, payState), [payDetails, payState]);
  // Looked up, not stored: settings that arrive after the pick still set its
  // minimum, and a rail the admin has just hidden drops out.
  const method: TopUpMethod | null = methods.find((m) => m.id === methodId) ?? null;

  // A pick that vanished leaves nothing to fill in past the first step.
  useEffect(() => {
    if (!method && step > 0) setStep(0);
  }, [method, step]);

  // Picking the trading transfer loads the accounts and their balances, and
  // pre-selects the oldest live account. SubscriptionWallet.jsx:371-390.
  useEffect(() => {
    if (methodId !== TRADING_METHOD_ID) return;
    let cancelled = false;
    sourcePicked.current = false;
    setBalances(null);
    setAccountsLoading(true);
    (async () => {
      // A failed account load keeps the store's previous list.
      const [, walletRows] = await Promise.all([
        useSelectedAccountStore.getState().load().catch(() => undefined),
        // Non-fatal, as on the web — but a failed load leaves the balances
        // unknown rather than zero.
        walletApi.balances().catch(() => null),
      ]);
      if (cancelled) return;
      setBalances(walletRows);
      const live = topUpSourceAccounts(useSelectedAccountStore.getState().accounts);
      setSourceAccountId((cur) => settleSourceAccount(cur, sourcePicked.current, live));
      setAccountsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [methodId]);

  const pickSource = (id: string): void => {
    sourcePicked.current = true;
    setSourceAccountId(id);
  };

  const trading = method?.id === TRADING_METHOD_ID;
  const n = Number(amount);
  const nSafe = Number.isFinite(n) ? n : 0;
  const draft: DepositDraft = { method, amount, sourceAccountId, txReference, hasProof: !!proof };
  const canNext = depositCanNext(step, draft, methods);
  const prefix = CURRENCY_SYMBOL;
  const amountNote = method ? topUpAmountNote(method, amount) : null;

  const submit = async (): Promise<void> => {
    const refusal = depositSubmitError(draft);
    if (refusal) { toast.error(refusal); return; }
    if (!method) return;
    setSubmitting(true);
    try {
      if (trading) {
        await walletApi.bonusDeposit(instantTopUpBody(amount, sourceAccountId));
        toast.success(`${CURRENCY_SYMBOL}${nSafe.toFixed(2)} moved to Main Wallet`);
      } else {
        await walletApi.bonusManualDeposit(manualDepositBody({
          method,
          amount,
          txReference,
          senderName,
          senderUpiId,
          senderBankAccount,
          screenshot: proof?.dataUrl ?? '',
          screenshotMimeType: proof?.mimeType ?? '',
        }));
        toast.success('Deposit submitted — pending admin verification');
      }
      onSuccess();
    } catch (e) {
      if (trading) {
        // A short trading wallet names the account and what it holds.
        toast.error(bonusTopUpError(e), insufficientTradingBalance(e) ? { duration: 5000 } : undefined);
      } else {
        toast.error(errorMessage(e));
      }
    } finally {
      if (alive.current) setSubmitting(false);
    }
  };

  const source = accounts.find((a) => a.id === sourceAccountId) ?? null;
  const payTo = useMemo(() => topUpPayTo(payDetails, method), [payDetails, method]);

  const header = (
    <View>
      <AppText variant="title" numberOfLines={1}>Add funds to Main Wallet</AppText>
      <View style={s.steps} accessibilityRole="progressbar" accessibilityLabel={`Step ${step + 1} of ${DEPOSIT_STEPS.length}: ${DEPOSIT_STEPS[step]}`}>
        {DEPOSIT_STEPS.map((label, i) => {
          const done = i < step;
          const current = i === step;
          return (
            <View key={label} style={s.stepItem}>
              <View
                style={[
                  s.stepDot,
                  { backgroundColor: done ? t.colors.bull : current ? t.colors.primary : t.colors.bgHover },
                ]}
              >
                {done
                  ? <Icon name="check" size={11} color={t.colors.onPrimary} strokeWidth={3} />
                  : <AppText variant="micro" weight="700" color={current ? t.colors.onPrimary : t.colors.textMuted}>{String(i + 1)}</AppText>}
              </View>
              <AppText
                variant="micro"
                weight="600"
                tone={current ? 'primary' : 'muted'}
                style={s.stepLabel}
                numberOfLines={1}
              >
                {label}
              </AppText>
            </View>
          );
        })}
      </View>
    </View>
  );

  const footer = (
    <View style={s.footer}>
      <Button
        title={step === 0 ? 'Cancel' : '← Back'}
        variant="ghost"
        onPress={step === 0 ? onClose : () => setStep((x) => Math.max(0, x - 1))}
        disabled={submitting}
      />
      {step < LAST_DEPOSIT_STEP ? (
        <Button
          title="Continue →"
          onPress={() => setStep((x) => Math.min(LAST_DEPOSIT_STEP, x + 1))}
          disabled={!canNext}
          style={s.flex}
        />
      ) : (
        <Button
          title={submitting
            ? 'Submitting…'
            : method?.kind === 'instant' ? `Transfer ${fmtMoney(nSafe)}` : 'Submit deposit'}
          onPress={() => { void submit(); }}
          disabled={submitting}
          style={s.flex}
        />
      )}
    </View>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!submitting}
      title={header}
      footer={footer}
      testID="bonus-deposit-sheet"
    >
      {step === 0 ? (
        <View style={s.stackSm}>
          <AppText variant="caption" tone="muted">Pick how you want to fund this wallet.</AppText>
          {payState === 'loading' ? [0, 1, 2].map((i) => (
            <View key={i} style={[s.methodRow, { borderColor: t.colors.borderDark }]}>
              <Skeleton width={24} height={24} />
              <View style={s.flex}>
                <Skeleton width={96} height={12} />
                <Skeleton width={128} height={10} style={s.gapTop} />
              </View>
            </View>
          )) : null}
          {payState === 'error' ? (
            <View style={[s.warn, { backgroundColor: t.tw.amber100, borderColor: t.alpha(t.tw.amber700, 0.3) }]}>
              <AppText variant="caption" color={t.tw.amber700}>
                Couldn&apos;t load the external payment methods. Check your connection and reopen this before sending any money.
              </AppText>
            </View>
          ) : null}
          {methods.map((m) => {
            const active = method?.id === m.id;
            return (
              <Pressable
                key={m.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={m.label}
                onPress={() => setMethodId(m.id)}
                style={({ pressed }) => [
                  s.methodRow,
                  {
                    borderColor: active ? t.colors.primary : pressed ? t.alpha(t.colors.primary, 0.4) : t.colors.borderDark,
                    backgroundColor: active ? t.alpha(t.colors.primary, 0.05) : 'transparent',
                  },
                ]}
              >
                <AppText style={s.emoji}>{m.emoji}</AppText>
                <View style={s.flex}>
                  <AppText variant="bodyStrong" weight="700">{m.label}</AppText>
                  <AppText variant="caption" tone="muted">{m.sub}</AppText>
                </View>
                {m.kind === 'instant' ? <Badge label="Instant" tone="bull" size="xs" /> : null}
                {active ? <Icon name="check" size={18} color={t.colors.primary} strokeWidth={3} /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {step === 1 && method ? (
        <View>
          <AppText variant="caption" tone="muted" weight="700" style={s.caps}>Amount</AppText>
          <Input
            value={amount}
            onChangeText={(v) => setAmount(cleanAmountInput(v))}
            placeholder={method.min > 0 ? String(Math.ceil(method.min)) : '0.00'}
            keyboardType="decimal-pad"
            autoFocus
            mono
            accessibilityLabel="Amount"
            containerStyle={s.gapTop}
            inputStyle={s.bigAmount}
            left={<AppText variant="body" tone="muted">{prefix}</AppText>}
          />
          <View style={s.presets}>
            {topUpPresets(method.min, method.max).map((q, i) => (
              <Pressable
                // eslint-disable-next-line react/no-array-index-key
                key={i}
                accessibilityRole="button"
                onPress={() => setAmount(String(q))}
                style={({ pressed }) => [
                  s.preset,
                  { borderColor: pressed ? t.colors.primary : t.colors.borderDark },
                ]}
              >
                <AppText variant="small" weight="600" tone="secondary" numberOfLines={1} adjustsFontSizeToFit>
                  {`${CURRENCY_SYMBOL}${q}`}
                </AppText>
              </Pressable>
            ))}
          </View>
          {/* The admin's limits for this rail, so a refusal is never a surprise. */}
          {amountNote ? (
            <AppText variant="caption" tone={amountNote.error ? 'bear' : 'muted'} weight={amountNote.error ? '600' : undefined} style={s.gapTop}>
              {amountNote.text}
            </AppText>
          ) : null}
          <AppText variant="caption" tone="muted" style={s.gapTopMd}>{`Minimum ${fmtMoney(method.min)}`}</AppText>
        </View>
      ) : null}

      {step === 2 && method && trading ? (
        <View>
          <AppText variant="caption" tone="muted" weight="700" style={[s.caps, s.gapBottom]}>From trading account</AppText>
          {accountsLoading && accounts.length === 0 ? (
            <View style={s.inline}><Spinner /><AppText variant="small" tone="muted">Loading…</AppText></View>
          ) : accounts.length === 0 ? (
            <View style={[s.dashed, { borderColor: t.colors.borderDark }]}>
              <AppText variant="body" tone="muted">
                {'No live trading account yet. '}
                <AppText
                  variant="body"
                  weight="600"
                  color={t.colors.primaryText}
                  accessibilityRole="link"
                  onPress={() => { onClose(); onOpenAccount(); }}
                >
                  Open one →
                </AppText>
              </AppText>
            </View>
          ) : (
            <Select
              value={sourceAccountId || null}
              onChange={pickSource}
              title="From trading account"
              accessibilityLabel="From trading account"
              options={accounts.map((a) => ({
                value: a.id,
                label: `${accountDisplayName(a)} · ${fmtMoney(accountWalletBalance(balances, a))}`,
              }))}
            />
          )}
        </View>
      ) : null}

      {step === 2 && method && !trading ? (
        <View style={s.stack}>
          <PayToCard rail={topUpPayToRail(payTo, method)} label={method.label} />
          <View style={[s.infoBox, { borderColor: t.alpha(t.colors.primary, 0.3), backgroundColor: t.alpha(t.colors.primary, 0.05) }]}>
            <AppText variant="small" tone="secondary">
              {'Send '}
              <AppText variant="small" weight="700">{`${CURRENCY_SYMBOL}${nSafe.toFixed(2)}`}</AppText>
              {` via ${method.label} to the details above, then upload proof. An admin will verify and credit your Main Wallet.`}
            </AppText>
          </View>
          <Input
            label="Transaction reference *"
            value={txReference}
            onChangeText={setTxReference}
            placeholder={txReferencePlaceholder(method.id)}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {method.id === 'UPI' ? (
            <Input
              label="Sender UPI ID"
              value={senderUpiId}
              onChangeText={setSenderUpiId}
              placeholder="username@upi"
              autoCapitalize="none"
              autoCorrect={false}
            />
          ) : null}
          {method.id === 'BANK' ? (
            <Input
              label="Sender bank a/c (last 4)"
              value={senderBankAccount}
              onChangeText={setSenderBankAccount}
              placeholder="1234"
              maxLength={4}
              keyboardType="number-pad"
            />
          ) : null}
          <Input
            label="Sender name (optional)"
            value={senderName}
            onChangeText={setSenderName}
            placeholder="Name on the source account"
            autoCapitalize="words"
          />
          <View>
            <AppText variant="label" style={s.gapBottom}>Payment screenshot *</AppText>
            <ProofPicker value={proof} onChange={setProof} />
          </View>
        </View>
      ) : null}

      {step === 3 && method ? (
        <View style={s.stackSm}>
          <ReviewRow label="Method" value={`${method.emoji} ${method.label}`} />
          <ReviewRow label="Amount" value={fmtMoney(nSafe)} tone="primary" />
          {trading ? (
            <ReviewRow label="From" value={source ? accountDisplayName(source) : '—'} />
          ) : (
            <>
              <ReviewRow label="Reference" value={txReference} mono />
              <ReviewRow label="Proof" value={proof ? 'Attached' : 'Missing'} tone={proof ? 'bull' : 'bear'} />
            </>
          )}
          <View style={[s.reviewNote, { borderTopColor: t.colors.borderSubtle }]}>
            <AppText variant="caption" tone="muted">
              {trading
                ? 'Funds transfer instantly. Your trading account is debited and your Main Wallet credited in one step.'
                : 'Submission goes to admin for verification. You\'ll get a notification when the deposit is credited.'}
            </AppText>
          </View>
        </View>
      ) : null}
    </Modal>
  );
}

/** SubscriptionWallet.jsx `Row` — label left, bold value right. */
function ReviewRow({
  label,
  value,
  tone,
  mono = false,
}: {
  label: string;
  value: string;
  tone?: 'primary' | 'bull' | 'bear';
  mono?: boolean;
}): React.JSX.Element {
  const s = useStyles();
  return (
    <View style={s.reviewRow}>
      <AppText variant="small" tone="muted">{label}</AppText>
      <AppText
        variant="bodyStrong"
        weight="700"
        tone={tone ?? 'secondary'}
        mono={mono}
        numberOfLines={1}
        style={s.reviewValue}
      >
        {value}
      </AppText>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  flex: { flex: 1, minWidth: 0 },
  stack: { gap: t.space.md },
  stackSm: { gap: t.space.sm },
  inline: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
  caps: { textTransform: 'uppercase', letterSpacing: 0.6 },
  gapTop: { marginTop: 6 },
  gapTopMd: { marginTop: t.space.sm },
  gapBottom: { marginBottom: 6 },
  steps: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: t.space.md },
  stepItem: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0 },
  stepDot: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  stepLabel: { flexShrink: 1, textTransform: 'uppercase', letterSpacing: 0.5 },
  footer: { flexDirection: 'row', justifyContent: 'space-between', gap: t.space.sm },
  methodRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.space.md,
    paddingHorizontal: 14,
    paddingVertical: t.space.md,
    borderRadius: t.radius.xl,
    borderWidth: 2,
  },
  emoji: { fontSize: 20, lineHeight: 26 },
  bigAmount: { fontSize: 18, fontWeight: '700' },
  presets: { flexDirection: 'row', gap: t.space.sm, marginTop: t.space.sm },
  preset: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: t.space.sm,
    paddingVertical: 6,
    borderRadius: t.radius.md,
    borderWidth: 1,
  },
  dashed: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: t.radius.xl,
    paddingHorizontal: t.space.md,
    paddingVertical: t.space.md,
  },
  infoBox: { borderWidth: 1, borderRadius: t.radius.xl, paddingHorizontal: t.space.md, paddingVertical: 10 },
  warn: { borderWidth: 1, borderRadius: t.radius.xl, paddingHorizontal: 14, paddingVertical: 10 },
  reviewRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.space.md },
  reviewValue: { maxWidth: '60%', textAlign: 'right' },
  reviewNote: { borderTopWidth: 1, paddingTop: t.space.sm, marginTop: t.space.xs },
}));
