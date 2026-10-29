import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';

import { walletApi, withdrawErrorMessage } from '@/api/wallet.api';
import { AppText, Badge, Button, Input, Modal, Skeleton, toast } from '@/components/ui';
import { VerifiedDestinationList } from '@/components/wallet/WithdrawalMethods';
import { makeStyles, useTheme } from '@/theme';
import type { Decimal } from '@/types/trading';
import { verifiedForRail, type DepositDetails, type WithdrawalMethod } from '@/types/wallet';
import { coerceWithdrawRail, withdrawRails, type LoadState } from '@/utils/fundsFlows';
import { fmtMoney } from '@/utils/money';
import {
  cleanAmountInput,
  maxWithdrawAmount,
  userWithdrawCheck,
  userWithdrawRailBits,
  withdrawBody,
  withdrawSubmitError,
} from '@/utils/userWallets';

/**
 * EquityHub's components/WithdrawModal.jsx — cash out of the Bonus Wallet
 * (POST /bonus-wallet/withdraw) in two layers, the same shape as the
 * trading wallet's flow:
 *
 *   1. METHOD      — the rails the admin has opened for withdrawals, each
 *                    with its own limits and fee.
 *   2. WITHDRAW TO — the user's SAVED, VERIFIED destinations on that rail.
 *
 * Only the destination id travels; the server resolves the real account
 * from the verified record. The balance is held at once and a PENDING
 * withdrawal goes to the admin queue (approved = paid out, rejected =
 * refunded). KYC-gated server-side.
 *
 * Until both the admin's rails and the user's destinations have loaded
 * neither is shown — a half-loaded picker invites choosing something that
 * will be refused. On a phone the web's modal is a bottom sheet (it is
 * `items-end` below `sm` on the web too). "Add a … method →" closes the
 * sheet and opens Wallet → Withdrawal Methods (`onManage`), as the web's
 * link to `/wallet?view=withdrawal-methods` does.
 *
 * Differs from the web, deliberately: MAX is the balance floored to the
 * cent (utils/userWallets maxWithdrawAmount), and a rail's "Setup" tag
 * counts the destinations actually listed under it (the web counts by type,
 * so a custom rail always reads "Setup").
 */
export interface UserWalletWithdrawSheetProps {
  open: boolean;
  title: string;
  /** Kept for callers; always INR. */
  currency?: string;
  /** The server's balance, unparsed. */
  balance: Decimal;
  onClose: () => void;
  onSuccess: () => void;
  /** "Add a … method →": after the sheet closes. */
  onManage: () => void;
}

export function UserWalletWithdrawSheet({
  open,
  title,
  balance,
  onClose,
  onSuccess,
  onManage,
}: UserWalletWithdrawSheetProps): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [payDetails, setPayDetails] = useState<DepositDetails | null>(null);
  const [saved, setSaved] = useState<WithdrawalMethod[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // The web mounts a fresh modal per open; this one stays mounted for its
  // exit animation, so it starts clean on every open instead.
  useEffect(() => {
    if (!open) return undefined;
    setAmount('');
    setMethod(null);
    setSelectedId('');
    setSubmitting(false);
    setState('loading');
    let dead = false;
    Promise.all([walletApi.depositDetails(), walletApi.withdrawalMethods()])
      .then(([details, list]) => {
        if (dead) return;
        setPayDetails(details);
        setSaved(list);
        setState('ready');
      })
      .catch(() => { if (!dead) setState('error'); });
    return () => { dead = true; };
  }, [open]);

  // 1. The rails the admin has open for payouts.
  const rails = useMemo(() => (state === 'ready' ? withdrawRails(payDetails) : []), [payDetails, state]);
  const railIds = rails.map((r) => r.id).join(',');
  useEffect(() => {
    if (!rails.length) { setMethod(null); return; }
    setMethod((m) => coerceWithdrawRail(rails, m ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railIds]);

  const active = rails.find((r) => r.id === method) ?? null;

  // 2. The verified destinations on the chosen rail.
  const destinations = useMemo(() => (method ? verifiedForRail(saved, method) : []), [saved, method]);
  const destIds = destinations.map((d) => d.id).join(',');
  useEffect(() => {
    if (!destinations.length) { setSelectedId(''); return; }
    setSelectedId((cur) => (destinations.some((d) => d.id === cur) ? cur : destinations[0]?.id ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destIds]);

  const check = userWithdrawCheck(amount, balance, active);

  const submit = async (): Promise<void> => {
    const refusal = withdrawSubmitError(amount, balance, selectedId, active, true);
    if (refusal) { toast.error(refusal); return; }
    setSubmitting(true);
    try {
      // The destination id only — nothing about where the money goes.
      const body = withdrawBody(amount, selectedId);
      await walletApi.bonusWithdraw(body);
      toast.success('Withdrawal requested — pending admin approval');
      onSuccess();
    } catch (e) {
      toast.error(withdrawErrorMessage(e));
    } finally {
      if (alive.current) setSubmitting(false);
    }
  };

  const manage = (): void => {
    onClose();
    onManage();
  };

  const notice = (text: string): React.JSX.Element => (
    <View style={[s.notice, { backgroundColor: t.tw.amber100, borderColor: t.alpha(t.tw.amber700, 0.3) }]}>
      <AppText variant="caption" color={t.tw.amber700}>{text}</AppText>
    </View>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      testID="withdraw-sheet-bonus"
      footer={(
        <View style={s.footer}>
          <Button title="Cancel" variant="secondary" onPress={onClose} style={s.flex} />
          <Button
            title={submitting ? 'Submitting…' : 'Request Withdrawal'}
            onPress={() => { void submit(); }}
            disabled={submitting || !check.amountValid || !selectedId}
            style={s.flex}
          />
        </View>
      )}
    >
      <View style={s.stack}>
        {/* Amount */}
        <View>
          <AppText variant="caption" tone="muted" weight="700" style={s.caps}>Amount (INR)</AppText>
          <Input
            value={amount}
            onChangeText={(v) => setAmount(cleanAmountInput(v))}
            placeholder="0.00"
            keyboardType="decimal-pad"
            mono
            containerStyle={s.gapTop}
            accessibilityLabel="Amount (INR)"
            right={(
              <Pressable accessibilityRole="button" accessibilityLabel="MAX" hitSlop={8} onPress={() => setAmount(maxWithdrawAmount(balance))}>
                <AppText variant="caption" weight="700" color={t.colors.primaryText}>MAX</AppText>
              </Pressable>
            )}
          />
          <AppText variant="caption" tone="muted" style={s.gapTop}>
            {'Available: '}
            <AppText variant="caption" tone="secondary" weight="600" mono>{fmtMoney(balance || '0')}</AppText>
            {active && (active.min > 0 || active.max > 0)
              ? `   ${[active.min > 0 ? `Min · ${fmtMoney(active.min)}` : '', active.max > 0 ? `Max · ${fmtMoney(active.max)}` : ''].filter(Boolean).join(' · ')}`
              : ''}
          </AppText>
          {check.belowMin && active ? <AppText variant="caption" tone="bear" style={s.gapTop}>{`Minimum for this method is ${fmtMoney(active.min)}`}</AppText> : null}
          {check.aboveMax && active ? <AppText variant="caption" tone="bear" style={s.gapTop}>{`Maximum for this method is ${fmtMoney(active.max)}`}</AppText> : null}
          {check.overBalance ? <AppText variant="caption" tone="bear" style={s.gapTop}>Amount exceeds your balance</AppText> : null}
        </View>

        {/* 1. Method — the admin's rails */}
        <View>
          <AppText variant="caption" tone="muted" weight="700" style={s.caps}>Method</AppText>
          <View style={s.list}>
            {state === 'loading' ? [0, 1, 2].map((i) => (
              <View key={i} style={[s.card, { borderColor: t.colors.borderDark }]}>
                <Skeleton width={24} height={24} />
                <View style={s.flex}>
                  <Skeleton width={96} height={12} />
                  <Skeleton width={144} height={10} style={s.gapTop} />
                </View>
              </View>
            )) : null}
            {state === 'error'
              ? notice("Couldn't load the available withdrawal methods. Check your connection and reopen this window before requesting a payout.")
              : null}
            {state === 'ready' && !rails.length ? notice('No withdrawal methods are available right now. Please contact support.') : null}
            {rails.map((r) => {
              const on = method === r.id;
              const count = verifiedForRail(saved, r.id).length;
              return (
                <Pressable
                  key={r.id}
                  testID={`withdraw-rail-${r.id}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={r.label}
                  onPress={() => setMethod(r.id)}
                  style={[
                    s.card,
                    { borderColor: on ? t.colors.primary : t.colors.borderDark, backgroundColor: on ? t.alpha(t.colors.primary, 0.05) : 'transparent' },
                  ]}
                >
                  <AppText style={s.emoji}>{r.emoji}</AppText>
                  <View style={s.flex}>
                    <AppText variant="bodyStrong" weight="700">{r.label}</AppText>
                    <AppText variant="caption" tone="muted">{r.blurb}</AppText>
                    <AppText variant="caption" tone="secondary" style={s.mt2}>{userWithdrawRailBits(r)}</AppText>
                  </View>
                  {count === 0 ? <Badge label="Setup" tone="warn" size="xs" /> : null}
                  {on ? <AppText weight="800" color={t.colors.primary}>✓</AppText> : null}
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* 2. Destination — verified accounts on the chosen rail */}
        {rails.length ? (
          <View>
            <AppText variant="caption" tone="muted" weight="700" style={s.caps}>Withdraw to</AppText>
            <View style={s.list}>
              {!destinations.length ? (
                <View style={[s.notice, { backgroundColor: t.tw.amber100, borderColor: t.alpha(t.tw.amber700, 0.3) }]}>
                  <AppText variant="caption" weight="700" color={t.tw.amber700}>{`No verified ${active?.label || 'account'} yet`}</AppText>
                  <AppText variant="caption" color={t.tw.amber700} style={s.mt2}>
                    Payouts can only go to a destination you&apos;ve saved and we&apos;ve verified.
                  </AppText>
                  <AppText
                    variant="caption"
                    weight="700"
                    color={t.tw.amber700}
                    style={[s.mt6, s.underline]}
                    accessibilityRole="link"
                    onPress={manage}
                  >
                    {`Add a ${active?.label || 'withdrawal'} method →`}
                  </AppText>
                </View>
              ) : (
                <VerifiedDestinationList destinations={destinations} value={selectedId} onChange={setSelectedId} emoji={active?.emoji} />
              )}
            </View>
          </View>
        ) : null}

        {/* The admin's withdrawal fee, shown before committing. */}
        {check.hasAmount && check.fee > 0 ? (
          <View style={s.feeBox}>
            <View style={s.feeRow}>
              <AppText variant="caption" tone="muted">Withdrawal fee</AppText>
              <AppText variant="caption" tone="secondary" weight="600" mono>{`−${fmtMoney(check.fee)}`}</AppText>
            </View>
            <View style={s.feeRow}>
              <AppText variant="caption" tone="muted">You receive</AppText>
              <AppText variant="caption" weight="700" mono>{fmtMoney(check.net)}</AppText>
            </View>
          </View>
        ) : null}

        <View style={s.note}>
          <AppText variant="caption" tone="muted">
            Withdrawals are reviewed by our team. The amount is held immediately, paid out on approval, and automatically refunded if rejected.
          </AppText>
        </View>
      </View>
    </Modal>
  );
}

const useStyles = makeStyles((t) => ({
  flex: { flex: 1, minWidth: 0 },
  stack: { gap: t.space.lg },
  list: { gap: t.space.sm, marginTop: t.space.xs },
  footer: { flexDirection: 'row', gap: t.space.sm },
  caps: { textTransform: 'uppercase', letterSpacing: 0.6 },
  gapTop: { marginTop: t.space.xs },
  mt2: { marginTop: 2 },
  mt6: { marginTop: 6 },
  underline: { textDecorationLine: 'underline' },
  emoji: { fontSize: 20, lineHeight: 24 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.space.md,
    borderWidth: 2,
    borderRadius: t.radius.xl,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  notice: { borderWidth: 1, borderRadius: t.radius.lg, padding: 10 },
  feeBox: {
    borderRadius: t.radius.lg,
    borderWidth: 1,
    borderColor: t.colors.borderSubtle,
    backgroundColor: t.alpha(t.colors.bgHover, 0.5),
    padding: 10,
    gap: 4,
  },
  feeRow: { flexDirection: 'row', justifyContent: 'space-between', gap: t.space.md },
  note: {
    borderRadius: t.radius.lg,
    borderWidth: 1,
    borderColor: t.colors.borderSubtle,
    backgroundColor: t.alpha(t.colors.bgHover, 0.5),
    padding: 10,
  },
}));
