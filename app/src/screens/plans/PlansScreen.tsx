import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';

import { errorMessage } from '@/api/client';
import { insufficientBalance, subscriptionApi } from '@/api/subscription.api';
import {
  AppText,
  Badge,
  Button,
  Card,
  ErrorView,
  Icon,
  LoadingView,
  Modal,
  PageHero,
  Screen,
  toast,
  useConfirm,
} from '@/components/ui';
import type { AppScreenProps } from '@/navigation';
import { BillingHistory } from '@/screens/plans/BillingHistory';
import { useTheme } from '@/theme';
import { planPrice, type BillingCycle, type Plan, type Subscription } from '@/types/subscription';
import type { BillingWallet, WalletTransaction } from '@/types/wallet';
import { CURRENCY, fmtMoney } from '@/utils/money';
import {
  CANCEL_PROMPT,
  FEATURE_ROWS,
  canCancelSubscription,
  fmtPlanPrice,
  billingWalletBalanceNum,
  payPreview,
  planCardState,
  subscribedToast,
  subscriptionSnapshot,
  switchPrompt,
  switchSuccess,
  visibleHighlights,
  type RechargePrompt,
} from '@/utils/plans';

/**
 * client/src/pages/Plans.jsx (EquityHub) — `/plans` and `/bonuses`.
 *
 * Subscription plans billed from the BONUS WALLET, in rupees: the billing
 * source (Bonus Wallet balance + Top up), the Current Subscription card
 * (started on, next billing date and the days to it, amount collected /
 * used / remaining deposit, the plan note, "Plan Details" and Cancel), the
 * "How Postpaid Works" panel, a Monthly / Yearly switch, a card per plan
 * (Free and Post-Paid switch with a confirm; paid plans open the
 * pay-from-wallet confirmation), the feature comparison and the Billing &
 * Subscription History timeline (BillingHistory). A 402
 * INSUFFICIENT_SUBSCRIPTION_BALANCE opens the recharge prompt.
 *
 * There is no Renew button: POST /subscriptions/renew bills the BONUS
 * wallet and the web never calls it.
 *
 * Phone layout: the web's md / xl grids are one column (two from 768dp,
 * the subscription card beside the postpaid panel from 1280dp), and the
 * comparison table scrolls sideways, as the web's `overflow-x-auto` does.
 */
export function PlansScreen({ navigation: nav }: AppScreenProps<'Plans'>): React.JSX.Element {
  const confirm = useConfirm();
  const { width } = useWindowDimensions();
  const twoUp = width >= 768;

  const [plans, setPlans] = useState<Plan[]>([]);
  const [mySub, setMySub] = useState<Subscription | null>(null);
  const [effective, setEffective] = useState<Plan | null>(null);
  // The Bonus Wallet — plans are billed from it.
  const [billingWallet, setBillingWallet] = useState<BillingWallet | null>(null);
  const [history, setHistory] = useState<WalletTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [billing, setBilling] = useState<BillingCycle>('MONTHLY');
  // Gates the wallet debit so the user sees exactly what they will be
  // charged before money moves.
  const [confirmPlan, setConfirmPlan] = useState<Plan | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The Free / Post-Paid button's in-flight guard, and a ref besides: two
  // taps in one frame both read the state as false, the ref is written
  // synchronously and refuses the second (a second Post-Paid charge).
  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);
  const [rechargePrompt, setRechargePrompt] = useState<RechargePrompt | null>(null);
  // "Plan Details" toggle on the Current Subscription card.
  const [showPlanDetails, setShowPlanDetails] = useState(false);
  // The paid subscribe debits the Bonus Wallet. The button's `loading` only
  // disables it after the next render, so a second tap landing before that
  // would post a second subscribe (a second charge); the ref refuses it —
  // the web's reasoning for `switchingRef`, applied to the path that
  // actually moves money.
  const payingRef = useRef(false);

  // Set in the setup, not only cleared in the cleanup: StrictMode and Fast
  // Refresh replay cleanup + setup on a live component, and a ref that only
  // ever goes false would drop every response after that.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Bumped by every refresh; a response whose number is no longer current
  // was overtaken by a newer refresh and must not land on top of it.
  const generation = useRef(0);
  // Whether the page is on screen. A failed FIRST load is told by the
  // ErrorView (which shows the server's message); only a failed refresh —
  // page still showing, no ErrorView — needs the web's toast.
  const hasData = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++generation.current;
    try {
      const [p, m, h] = await Promise.all([
        subscriptionApi.plans(),
        subscriptionApi.me(),
        // Billing history is non-fatal — a failure must not blank the page.
        subscriptionApi.history({ limit: 100 }).catch((): WalletTransaction[] => []),
      ]);
      if (!mounted.current || mine !== generation.current) return;
      setPlans(p);
      setMySub(m.subscription);
      setEffective(m.effectivePlan);
      // billingWallet, or its deprecated alias subscriptionWallet (types/subscription).
      setBillingWallet(m.billingWallet);
      setHistory(h);
      setLoaded(true);
      setLoadError(null);
      hasData.current = true;
    } catch (e) {
      if (!mounted.current || mine !== generation.current) return;
      if (hasData.current) toast.error(errorMessage(e));
      setLoadError(e);
    } finally {
      if (mounted.current && mine === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Back on this screen — from the Bonus Wallet after "Top up →" / "Add
  // funds →" / "Top up to upgrade →": reload, as the web
  // does by mounting the page afresh. Without it the cards kept the old
  // balance and still said "Insufficient balance" after a top-up. Only after
  // the screen was actually left, so the first focus does not load twice.
  useEffect(() => {
    let away = false;
    const offBlur = nav.addListener('blur', () => { away = true; });
    const offFocus = nav.addListener('focus', () => {
      if (!away) return;
      away = false;
      void refresh();
    });
    return () => { offBlur(); offFocus(); };
  }, [nav, refresh]);

  // Free / Post-Paid — no confirmation modal, a confirm instead.
  const switchToFree = async (plan: Plan): Promise<void> => {
    // Guard BEFORE the confirm — otherwise two taps open two dialogs and
    // both go on to charge.
    if (switchingRef.current) return;
    switchingRef.current = true;
    setSwitching(true);
    try {
      if (!(await confirm(switchPrompt(plan)))) return;
      await subscriptionApi.subscribe({ planCode: plan.code, billingCycle: billing });
      toast.success(switchSuccess(plan));
      void refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      // Released on every path — a cancelled dialog must not leave the
      // buttons dead for the rest of the session.
      switchingRef.current = false;
      if (mounted.current) setSwitching(false);
    }
  };

  // Paid plan — debits the Bonus Wallet and creates the subscription. A
  // shortfall is a structured 402 that opens the recharge prompt.
  const confirmAndPay = async (): Promise<void> => {
    if (!confirmPlan || payingRef.current) return;
    payingRef.current = true;
    const plan = confirmPlan;
    setSubmitting(true);
    try {
      await subscriptionApi.subscribe({
        planCode: plan.code,
        billingCycle: billing,
      });
      toast.success(subscribedToast(plan, billing));
      setConfirmPlan(null);
      void refresh();
    } catch (e) {
      const short = insufficientBalance(e, {
        needed: String(planPrice(plan, billing)),
        balance: billingWallet?.balance ?? null,
      });
      if (short) {
        setConfirmPlan(null);
        // The Bonus Wallet is rupees — `currency: 'INR'`, as the web sets it.
        setRechargePrompt({ plan, billing, ...short, currency: CURRENCY });
      } else {
        toast.error(errorMessage(e));
      }
    } finally {
      payingRef.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (!(await confirm(CANCEL_PROMPT))) return;
    try {
      await subscriptionApi.cancel('User requested');
      toast.success('Subscription cancelled');
      void refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (loading && !loaded) return <Screen><LoadingView /></Screen>;
  if (loadError && !loaded) {
    return (
      <Screen onRefresh={refresh}>
        <ErrorView error={loadError} onRetry={() => { setLoading(true); void refresh(); }} />
      </Screen>
    );
  }

  const balanceNum = billingWalletBalanceNum(billingWallet);

  const closeOverlays = (): void => {
    // A modal lives in the overlay layer above the navigator — close it
    // first, or it would stay on top of the next screen.
    setConfirmPlan(null);
    setRechargePrompt(null);
  };
  // Every top-up goes to the Bonus Wallet's Add Funds — plans are billed from it.
  const toBonusWallet = (): void => { closeOverlays(); nav.navigate('BonusWallet', undefined, { pop: true }); };

  return (
    <Screen onRefresh={refresh}>
      <PageHero
        eyebrow="Membership"
        title="Plans & Pricing"
        subtitle="Upgrade for lower trading fees, more accounts, premium support, and exclusive perks."
      />

      {/* Billing source (Bonus Wallet) — where plan charges are deducted from. */}
      <BillingSourceCard wallet={billingWallet} balanceNum={balanceNum} onTopUp={toBonusWallet} />

      {/* Current Subscription + How Postpaid Works */}
      {effective ? (
        <View style={[styles.subRow, width >= 1280 ? styles.row : null]}>
          <CurrentSubscriptionCard
            sub={mySub}
            effective={effective}
            showDetails={showPlanDetails}
            onToggleDetails={() => setShowPlanDetails((v) => !v)}
            onCancel={() => { void cancel(); }}
            style={width >= 1280 ? styles.twoThirds : null}
          />
          <HowPostpaidWorks style={width >= 1280 ? styles.oneThird : null} />
        </View>
      ) : null}

      {/* Billing toggle */}
      <BillingToggle billing={billing} onToggle={() => setBilling(billing === 'MONTHLY' ? 'YEARLY' : 'MONTHLY')} />

      {/* Pricing cards */}
      <View style={[styles.cards, twoUp ? styles.wrapRow : null]}>
        {plans.map((plan) => (
          <PlanCard
            key={plan.id || plan.code}
            plan={plan}
            billing={billing}
            balanceNum={balanceNum}
            effectiveCode={effective?.code ?? null}
            switching={switching}
            style={twoUp ? styles.half : null}
            onSwitch={() => { void switchToFree(plan); }}
            onPay={() => setConfirmPlan(plan)}
            onTopUp={toBonusWallet}
          />
        ))}
      </View>

      {/* Feature comparison */}
      <CompareFeatures plans={plans} />

      {/* Billing & Subscription history — the plan-period timeline */}
      <BillingHistory txns={history} currentSub={mySub} plans={plans} currentPlanCode={effective?.code ?? null} />

      {confirmPlan ? (
        <ConfirmPayModal
          plan={confirmPlan}
          billing={billing}
          wallet={billingWallet}
          submitting={submitting}
          onConfirm={() => { void confirmAndPay(); }}
          onClose={() => { if (!submitting) setConfirmPlan(null); }}
          onTopUp={toBonusWallet}
        />
      ) : null}

      {/* Recharge popup — the Bonus Wallet cannot cover the plan. */}
      {rechargePrompt ? (
        <RechargePromptModal
          prompt={rechargePrompt}
          onClose={() => setRechargePrompt(null)}
          onAddFunds={toBonusWallet}
        />
      ) : null}
    </Screen>
  );
}

/* ── Billing source ───────────────────────────────────────────────── */

function BillingSourceCard({
  wallet,
  balanceNum,
  onTopUp,
}: {
  wallet: BillingWallet | null;
  balanceNum: number;
  onTopUp: () => void;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <Card padded={20}>
      <View style={styles.spread}>
        <AppText variant="small" tone="muted" style={styles.upper}>Billing Source: Main Wallet</AppText>
        {wallet?.isLowBalance ? <Badge label="Low" tone="warn" size="xs" /> : null}
      </View>
      <View style={[styles.spread, styles.mt4]}>
        <AppText variant="h2" mono>{fmtMoney(balanceNum)}</AppText>
        <Pressable accessibilityRole="link" hitSlop={8} onPress={onTopUp}>
          <AppText variant="bodyStrong" color={t.colors.primary}>Top up →</AppText>
        </Pressable>
      </View>
      <AppText variant="caption" tone="muted" style={styles.mt4}>
        Plan renewals are deducted from your Main Wallet.
      </AppText>
      <AppText variant="caption" color={t.colors.warn} style={styles.mt6}>
        ⚠ Ensure sufficient balance is available in your Main Wallet before the renewal date.
      </AppText>
    </Card>
  );
}

/* ── Current Subscription ─────────────────────────────────────────── */

function CurrentSubscriptionCard({
  sub,
  effective,
  showDetails,
  onToggleDetails,
  onCancel,
  style,
}: {
  sub: Subscription | null;
  effective: Plan;
  showDetails: boolean;
  onToggleDetails: () => void;
  onCancel: () => void;
  style: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const snap = subscriptionSnapshot(sub, effective);
  // grid-cols-2 sm:grid-cols-3 lg:grid-cols-5
  const statBasis = width >= 1024 ? '20%' : width >= 640 ? '33.33%' : '50%';
  const highlights = visibleHighlights(effective);
  return (
    <Card padded={20} style={style}>
      <View style={styles.subHead}>
        <View style={styles.pills}>
          <AppText variant="small" tone="muted" style={styles.upper}>Current Subscription</AppText>
          <Badge label={effective.name} tone="primary" size="xs" rounded />
          {sub?.billingCycle ? <Badge label={sub.billingCycle} tone="neutral" size="xs" rounded /> : null}
          {sub?.status ? <Badge label={sub.status} tone="bull" size="xs" rounded /> : null}
        </View>
        {canCancelSubscription(sub, effective) ? (
          <Button title="Cancel subscription" variant="secondary" size="sm" onPress={onCancel} />
        ) : null}
      </View>

      <View style={styles.stats}>
        <SubStat basis={statBasis} label="Started On" value={snap.startedOn} />
        <SubStat basis={statBasis} label="Next Billing Date" value={snap.nextBillingLabel} sub={snap.nextBillingSub} />
        <SubStat basis={statBasis} label="Amount Collected" value={fmtMoney(snap.amountCollected)} sub={snap.billingSubtitle} />
        <SubStat basis={statBasis} label="Used" value={fmtMoney(snap.used)} />
        <SubStat basis={statBasis} label="Remaining Deposit" value={fmtMoney(snap.remainingDeposit)} />
      </View>

      <View style={styles.noteRow}>
        <AppText variant="small" tone="muted" style={styles.note}>{snap.planNote}</AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showDetails }}
          onPress={onToggleDetails}
          style={({ pressed }) => [
            styles.detailsBtn,
            {
              borderColor: t.alpha(t.colors.primary, 0.4),
              borderRadius: t.radius.lg,
              backgroundColor: pressed ? t.alpha(t.colors.primary, 0.1) : 'transparent',
            },
          ]}
        >
          <AppText variant="small" weight="600" color={t.colors.primaryText}>{showDetails ? 'Hide details' : 'Plan Details'}</AppText>
        </Pressable>
      </View>

      {showDetails ? (
        <View style={[styles.details, { borderTopColor: t.colors.borderSubtle }]}>
          {highlights.map((h, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <View key={i} style={[styles.highlight, width >= 640 ? styles.halfRow : null]}>
              <View style={styles.tickSm}><Icon name="check" size={12} color={t.colors.bull} strokeWidth={3} /></View>
              <AppText variant="small" tone="secondary" style={styles.flex}>{h}</AppText>
            </View>
          ))}
          {/* The web tests the unfiltered list: a plan whose only bullets are
              copy-trading ones shows an empty list, not this line. */}
          {effective.highlights.length === 0 ? (
            <AppText variant="small" tone="muted">No extra details for this plan.</AppText>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

function SubStat({
  label,
  value,
  sub,
  basis,
}: {
  label: string;
  value: string;
  sub?: string;
  basis: '20%' | '33.33%' | '50%';
}): React.JSX.Element {
  return (
    <View style={[styles.stat, { flexBasis: basis, maxWidth: basis }]}>
      <AppText variant="micro" tone="muted" weight="600" style={styles.upper}>{label}</AppText>
      <AppText variant="bodyStrong" weight="700" mono style={styles.mt2}>{value}</AppText>
      {sub ? <AppText variant="micro" tone="muted" style={styles.mt2}>{sub}</AppText> : null}
    </View>
  );
}

/** "How Postpaid Works" — the design's info panel. */
function HowPostpaidWorks({ style }: { style: StyleProp<ViewStyle> }): React.JSX.Element {
  const t = useTheme();
  const steps = [
    'A minimum deposit is collected upfront.',
    'Usage charges are deducted from this deposit.',
    'Once the deposit is exhausted, charges are deducted directly from your Main Wallet.',
  ];
  return (
    <Card
      padded={20}
      style={[{ borderColor: t.alpha(t.colors.primary, 0.2), backgroundColor: t.alpha('#3B82F6', 0.05) }, style]}
    >
      <AppText variant="bodyStrong" weight="700">How Postpaid Works</AppText>
      <View style={styles.steps}>
        {steps.map((s, i) => (
          <AppText key={s} variant="small" tone="secondary">{`${i + 1}. ${s}`}</AppText>
        ))}
      </View>
    </Card>
  );
}

/* ── Monthly / Yearly ─────────────────────────────────────────────── */

function BillingToggle({ billing, onToggle }: { billing: BillingCycle; onToggle: () => void }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={styles.toggleRow}>
      <AppText variant={billing === 'MONTHLY' ? 'bodyStrong' : 'body'} tone={billing === 'MONTHLY' ? 'primary' : 'muted'}>
        Monthly
      </AppText>
      <Pressable
        accessibilityRole="switch"
        accessibilityLabel="Bill yearly"
        accessibilityState={{ checked: billing === 'YEARLY' }}
        hitSlop={8}
        onPress={onToggle}
        style={[styles.track, { backgroundColor: t.colors.bgHover, borderColor: t.colors.borderDark }]}
      >
        <View style={[styles.knob, { backgroundColor: t.colors.primary, left: billing === 'YEARLY' ? 26 : 2 }, t.shadow.card]} />
      </Pressable>
      <AppText variant={billing === 'YEARLY' ? 'bodyStrong' : 'body'} tone={billing === 'YEARLY' ? 'primary' : 'muted'}>
        Yearly <AppText variant="small" tone="bull">save ~17%</AppText>
      </AppText>
    </View>
  );
}

/* ── One pricing card ─────────────────────────────────────────────── */

function PlanCard({
  plan,
  billing,
  balanceNum,
  effectiveCode,
  switching,
  style,
  onSwitch,
  onPay,
  onTopUp,
}: {
  plan: Plan;
  billing: BillingCycle;
  balanceNum: number;
  effectiveCode: string | null;
  switching: boolean;
  style: StyleProp<ViewStyle>;
  onSwitch: () => void;
  onPay: () => void;
  onTopUp: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const s = planCardState(plan, billing, balanceNum, effectiveCode);
  const border = s.isPostPaid
    ? t.alpha(t.colors.warn, 0.4)
    : s.popular ? t.colors.primary : t.colors.borderDark;

  const card = (
    <Card
      padded={24}
      style={[
        { borderColor: border },
        s.popular ? t.shadow.elevated : null,
      ]}
    >
      <AppText variant="small" tone="muted" style={styles.upper}>{plan.code}</AppText>
      <AppText variant="h1" style={styles.mt4}>{plan.name}</AppText>
      <AppText variant="body" tone="secondary" style={[styles.mt4, styles.minDesc]}>{plan.description ?? ''}</AppText>

      <View style={styles.priceBlock}>
        {s.isPostPaid ? (
          <PostPaidRateBlock plan={plan} />
        ) : (
          <View style={styles.priceRow}>
            <AppText style={[styles.bigPrice, { color: t.colors.textPrimary }]}>{fmtPlanPrice(s.price)}</AppText>
            <AppText variant="body" tone="muted" style={styles.ml8}>{`/ ${billing === 'YEARLY' ? 'year' : 'month'}`}</AppText>
          </View>
        )}
      </View>

      <View style={styles.highlights}>
        {visibleHighlights(plan).map((h, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <View key={i} style={styles.highlight}>
            <View style={styles.tick}><Icon name="check" size={13} color={t.colors.bull} strokeWidth={3} /></View>
            <AppText variant="body" tone="secondary" style={styles.flex}>{h}</AppText>
          </View>
        ))}
      </View>

      {s.action === 'current' ? (
        <Button title="✓ Current plan" variant="secondary" disabled fullWidth />
      ) : s.action === 'free' ? (
        <Button
          title={switching ? 'Switching…' : 'Switch to Free'}
          variant="secondary"
          disabled={switching}
          fullWidth
          onPress={onSwitch}
          style={switching ? styles.faded : null}
        />
      ) : s.action === 'postpaid' ? (
        <Button
          title={switching ? 'Activating…' : 'Activate Post Paid'}
          variant="primary"
          disabled={switching}
          fullWidth
          onPress={onSwitch}
          style={switching ? styles.faded : null}
        />
      ) : (
        <View style={styles.gap8}>
          <Button
            title={s.canAfford ? `Pay from wallet · ${fmtMoney(s.priceNum)}` : 'Insufficient balance'}
            variant={s.popular ? 'primary' : 'secondary'}
            disabled={!s.canAfford}
            fullWidth
            onPress={onPay}
            style={!s.canAfford ? styles.faded : null}
          />
          {!s.canAfford ? (
            <Pressable accessibilityRole="link" hitSlop={6} onPress={onTopUp}>
              <AppText variant="caption" weight="600" align="center" color={t.colors.primary}>Top up to upgrade →</AppText>
            </Pressable>
          ) : null}
        </View>
      )}
    </Card>
  );

  return (
    <View style={[styles.cardWrap, style]}>
      {s.current ? (
        // ring-2 ring-bull/40 — drawn outside the card's own border.
        <View style={[styles.ring, { borderColor: t.alpha(t.colors.bull, 0.4), borderRadius: t.radius.xl + 3 }]}>{card}</View>
      ) : card}
      {s.popular ? (
        <View style={styles.ribbon} pointerEvents="none">
          <Badge label={plan.badge ?? ''} tone="primary" solid rounded style={t.shadow.card} />
        </View>
      ) : s.isPostPaid ? (
        <View style={styles.ribbon} pointerEvents="none">
          <Badge label="Pay as you trade" tone="warn" solid rounded style={t.shadow.card} />
        </View>
      ) : null}
    </View>
  );
}

function PostPaidRateBlock({ plan }: { plan: Plan }): React.JSX.Element {
  const r = plan.postPaidRates;
  return (
    <View style={styles.gap4}>
      <View style={styles.rateRow}>
        <AppText variant="h1">{fmtPlanPrice(r.perDevicePerMonth || 0)}</AppText>
        <AppText variant="small" tone="muted">per device / month</AppText>
      </View>
      <View style={styles.rateRow}>
        <AppText variant="h1">{fmtPlanPrice(r.perAccountPerMonth || 0)}</AppText>
        <AppText variant="small" tone="muted">per account / month</AppText>
      </View>
      <AppText variant="caption" tone="muted" style={styles.mt4}>
        Minimum <AppText variant="caption" tone="secondary" weight="600">{`${fmtPlanPrice(r.minimumMonthlyFee || 0)}/month`}</AppText> maintenance fee — whichever is higher.
      </AppText>
    </View>
  );
}

/* ── Compare features ─────────────────────────────────────────────── */

function CompareFeatures({ plans }: { plans: Plan[] }): React.JSX.Element {
  const t = useTheme();
  return (
    <Card padded={false} style={styles.section}>
      <View style={[styles.sectionHead, { borderBottomColor: t.colors.borderDark }]}>
        <AppText variant="title">Compare features</AppText>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          <View style={[styles.tr, { backgroundColor: t.alpha(t.colors.bgHover, 0.4) }]}>
            <AppText variant="small" tone="muted" weight="700" style={[styles.th, styles.featureCol, styles.upper]}>Feature</AppText>
            {plans.map((p) => (
              <AppText key={p.id || p.code} variant="small" tone="muted" weight="700" align="center" style={[styles.th, styles.planCol, styles.upper]}>
                {p.name}
              </AppText>
            ))}
          </View>
          {FEATURE_ROWS.map((r) => (
            <View key={r.label} style={[styles.tr, { borderBottomColor: t.colors.borderSubtle, borderBottomWidth: StyleSheet.hairlineWidth }]}>
              <AppText variant="body" tone="secondary" style={[styles.td, styles.featureCol]}>{r.label}</AppText>
              {plans.map((p) => (
                <AppText key={p.id || p.code} variant="small" mono align="center" style={[styles.td, styles.planCol]}>
                  {r.value(p)}
                </AppText>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </Card>
  );
}

/* ── Modals ───────────────────────────────────────────────────────── */

function ConfirmPayModal({
  plan,
  billing,
  wallet,
  submitting,
  onConfirm,
  onClose,
  onTopUp,
}: {
  plan: Plan;
  billing: BillingCycle;
  wallet: BillingWallet | null;
  submitting: boolean;
  onConfirm: () => void;
  onClose: () => void;
  onTopUp: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const p = payPreview(plan, billing, wallet);
  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!submitting}
      size="sm"
      title="Confirm subscription"
      footer={(
        <View style={styles.footer}>
          <Button title="Cancel" variant="ghost" size="sm" disabled={submitting} onPress={onClose} />
          <Button
            title={`Pay ${fmtMoney(p.price)} & subscribe`}
            loading={submitting}
            loadingTitle="Paying…"
            size="sm"
            disabled={!p.canAfford}
            onPress={onConfirm}
            style={!p.canAfford ? styles.faded : null}
          />
        </View>
      )}
    >
      <View style={styles.gap16}>
        <View style={[styles.summary, { backgroundColor: t.alpha(t.colors.bgHover, 0.4), borderRadius: t.radius.md }]}>
          <AppText variant="micro" tone="muted" weight="700" style={styles.upper}>Plan</AppText>
          <AppText variant="h3" weight="700" style={styles.mt2}>{plan.name}</AppText>
          <AppText variant="caption" tone="muted" style={styles.mt2}>
            Billing: <AppText variant="caption" tone="secondary" weight="600">{billing === 'YEARLY' ? 'Yearly' : 'Monthly'}</AppText>
          </AppText>
        </View>

        <View style={styles.gap8}>
          <PayRow label="Amount due" value={fmtMoney(p.price)} tone="primary" />
          <PayRow label="Wallet balance" value={fmtMoney(p.balance)} tone="neutral" />
          <PayRow label="After payment" value={fmtMoney(Math.max(0, p.after))} tone={p.canAfford ? 'bull' : 'bear'} />
        </View>

        {!p.canAfford ? (
          <View style={[styles.alert, { borderColor: t.alpha(t.colors.bear, 0.3), backgroundColor: t.colors.bearSoft, borderRadius: t.radius.md }]}>
            <AppText variant="small" tone="bear">
              Insufficient balance.{' '}
              <AppText variant="small" tone="bear" weight="700" style={styles.underline} onPress={onTopUp}>Top up your Main Wallet →</AppText>
            </AppText>
          </View>
        ) : null}

        <AppText variant="caption" tone="muted">
          {`Plan purchases and renewals are deducted from your Main Wallet (${p.currency}) immediately. Subscription activates the moment the payment clears — there's no refund window for partial use.`}
        </AppText>
      </View>
    </Modal>
  );
}

function PayRow({ label, value, tone }: { label: string; value: string; tone: 'primary' | 'bull' | 'bear' | 'neutral' }): React.JSX.Element {
  return (
    <View style={styles.spread}>
      <AppText variant="body" tone="muted" mono>{label}</AppText>
      <AppText
        variant={tone === 'neutral' ? 'body' : 'bodyStrong'}
        weight={tone === 'neutral' ? undefined : '700'}
        tone={tone === 'neutral' ? 'secondary' : tone}
        mono
      >
        {value}
      </AppText>
    </View>
  );
}

function RechargePromptModal({
  prompt,
  onClose,
  onAddFunds,
}: {
  prompt: RechargePrompt;
  onClose: () => void;
  onAddFunds: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const { plan, balance, needed, shortfall } = prompt;
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Recharge required"
      footer={(
        <View style={styles.footer}>
          <Button title="Maybe later" variant="ghost" size="sm" onPress={onClose} />
          <Button title="Add funds →" size="sm" onPress={onAddFunds} />
        </View>
      )}
    >
      <View style={styles.gap12}>
        <View style={[styles.alert, { backgroundColor: t.colors.bearSoft, borderColor: t.alpha(t.colors.bear, 0.3), borderRadius: t.radius.md }]}>
          <AppText variant="small" tone="bear" weight="600">
            {`Not enough balance in your Main Wallet to subscribe to ${plan.name}.`}
          </AppText>
        </View>
        <View style={styles.statsRow}>
          <Stat label="Balance" value={fmtMoney(balance)} tone="muted" />
          <Stat label="Plan price" value={fmtMoney(needed)} tone="primary" />
          <Stat label="Top up by" value={fmtMoney(shortfall)} tone="bear" />
        </View>
        <AppText variant="caption" tone="muted">
          Plan purchases and renewals are deducted from your Main Wallet. Add funds to your Main Wallet to continue.
        </AppText>
      </View>
    </Modal>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'bear' | 'primary' | 'muted' }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[styles.statBox, { borderColor: t.colors.borderSubtle, borderRadius: t.radius.md }]}>
      <AppText variant="micro" tone="muted" weight="700" align="center" style={styles.upper}>{label}</AppText>
      <AppText
        variant="bodyStrong"
        weight="700"
        mono
        align="center"
        tone={tone === 'bear' ? 'bear' : tone === 'muted' ? 'secondary' : 'primary'}
        style={styles.mt4}
        adjustsFontSizeToFit
        numberOfLines={1}
      >
        {value}
      </AppText>
    </View>
  );
}

/** Above the highest card elevation (shadow.elevated = 8). */
const RIBBON_ELEVATION = 12;

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  upper: { textTransform: 'uppercase', letterSpacing: 0.8 },
  underline: { textDecorationLine: 'underline' },
  mt2: { marginTop: 2 },
  mt4: { marginTop: 4 },
  mt6: { marginTop: 6 },
  ml8: { marginLeft: 8 },
  gap4: { gap: 4 },
  gap8: { gap: 8 },
  gap12: { gap: 12 },
  gap16: { gap: 16 },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap' },
  half: { flexBasis: '48%', flexGrow: 1 },
  twoThirds: { flex: 2, minWidth: 0 },
  oneThird: { flex: 1, minWidth: 0 },
  faded: { opacity: 0.4 },
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  subRow: { gap: 16, marginTop: 24 },
  subHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  pills: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, flexShrink: 1 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 16, rowGap: 12 },
  stat: { paddingRight: 16 },
  noteRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginTop: 16 },
  note: { flexShrink: 1, maxWidth: 448 },
  detailsBtn: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6 },
  details: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 6, marginTop: 12, paddingTop: 12, borderTopWidth: 1 },
  halfRow: { flexBasis: '50%', paddingRight: 16 },
  tickSm: { marginTop: 2 },
  steps: { gap: 8, marginTop: 12 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 24 },
  track: { width: 48, height: 24, borderRadius: 12, borderWidth: 1, justifyContent: 'center' },
  knob: { position: 'absolute', top: 1, width: 20, height: 20, borderRadius: 10 },
  cards: { gap: 20, marginTop: 24 },
  cardWrap: { paddingTop: 12 },
  ring: { borderWidth: 2, padding: 1 },
  // The web's `-top-3` ribbon straddles the card's top edge. On Android a
  // sibling's elevation outranks paint order, so the card (shadow.card = 2,
  // shadow.elevated = 8 on the popular card) hid the ribbon's lower half.
  // Above both; no background, so it casts no shadow of its own.
  ribbon: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center', zIndex: 2, elevation: RIBBON_ELEVATION },
  minDesc: { minHeight: 40 },
  priceBlock: { marginVertical: 20, minHeight: 60, justifyContent: 'center' },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap' },
  bigPrice: { fontSize: 36, lineHeight: 40, fontWeight: '700' },
  rateRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  highlights: { gap: 8, marginBottom: 24 },
  highlight: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  tick: { marginTop: 3 },
  section: { marginTop: 24, overflow: 'hidden' },
  sectionHead: { paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1 },
  tr: { flexDirection: 'row', alignItems: 'center' },
  th: { paddingVertical: 8, paddingHorizontal: 16 },
  td: { paddingVertical: 8, paddingHorizontal: 16 },
  featureCol: { width: 150 },
  planCol: { width: 120 },
  summary: { padding: 12 },
  alert: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  statsRow: { flexDirection: 'row', gap: 12 },
  statBox: { flex: 1, borderWidth: 1, padding: 8 },
});
