import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Modal, Alert, RefreshControl, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, errorMessage } from '../services/api';
import { useColors, radius, fmtNum, currencySymbol } from '../theme';
import { Loader, Empty } from '../components/ui';

/**
 * PlansScreen — native port of the web client's Plans page
 * (client/src/pages/Plans.jsx). Mirrors it section-for-section:
 *   • Hero            — "Plans & Pricing"
 *   • Current plan card (with Cancel) + Billing source card (Main Wallet)
 *   • Monthly / Yearly billing toggle
 *   • Pricing cards   — badge · price / post-paid rate block · highlights · CTA
 *   • Compare features — the web's <table> rendered as native rows (h-scroll)
 *   • Billing history  — plan charges, renewals & refunds from the Main Wallet
 *   • ConfirmPay <Modal> sheet   (subscribe → wallet debit)
 *   • Recharge   <Modal> sheet   (insufficient balance → top up)
 *
 * Hits the SAME backend the web calls: /subscriptions/plans · /subscriptions/me
 * · /subscriptions/history · /subscriptions/subscribe · /subscriptions/cancel.
 * Top-up links deep-link to the Wallet screen (the mobile Main Wallet hub).
 */

// ─── Static config (mirrors the web verbatim) ─────────────────────────────
const BILLING_REASONS = new Set(['SUBSCRIPTION_CHARGE', 'RENEWAL', 'REFUND']);
const REASON_LABEL = { SUBSCRIPTION_CHARGE: 'Subscription', RENEWAL: 'Renewal', REFUND: 'Refund' };

// Compare-features rows — same labels + value fns as the web FeatureRow calls.
const FEATURES = [
  { label: 'Maintenance fee', value: (p) => (p.features?.maintenanceFee ? 'Applies' : 'Zero') },
  { label: 'Trading accounts', value: (p) => (p.limits?.maxAccounts == null ? 'Unlimited' : p.limits.maxAccounts) },
  { label: 'All instruments', value: () => '✓' },
  { label: '24/7 access', value: () => '✓' },
  { label: 'API access', value: (p) => (p.features?.apiAccess ? '✓' : '—') },
  { label: 'Devices login', value: (p) => (p.limits?.maxDevices == null ? 'Unlimited' : p.limits.maxDevices) },
  { label: 'Support', value: (p) => (p.features?.customSupport || p.features?.postPaid ? 'Dedicated' : 'Standard') },
];
const FEATURE_W = 148;
const PLAN_W = 104;

// Pure formatting helpers (no theme/style dependency — safe at module scope).
const fmt = (n) => fmtNum(n, 2);
const priceLabel = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const isPostPaidPlan = (p) => p.code === 'POSTPAID' || !!p.features?.postPaid;
const priceOf = (p, billing) => Number((billing === 'YEARLY' ? p.yearlyPrice : p.monthlyPrice) || 0);

// ─── Presentational pieces (receive styles / c via props — no module `c`) ──
function Sheet({ title, onClose, children, footer, styles, c }) {
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop}>
        <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle} numberOfLines={1}>{title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={styles.sheetClose}>×</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">{children}</ScrollView>
          {footer ? <View style={styles.sheetFoot}>{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}

function KV({ label, value, tone, styles, c }) {
  const color = tone === 'bull' ? c.bull : tone === 'bear' ? c.bear : tone === 'neutral' ? c.textSecondary : c.textPrimary;
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={[styles.kvVal, { color }]}>{value}</Text>
    </View>
  );
}

function Stat({ label, value, tone, styles, c }) {
  const color = tone === 'bear' ? c.bear : tone === 'muted' ? c.textSecondary : c.textPrimary;
  return (
    <View style={styles.statBox}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statVal, { color }]}>{value}</Text>
    </View>
  );
}

function PostPaidRateBlock({ plan, styles, c }) {
  const rates = plan.postPaidRates || {};
  const perDevice = Number(rates.perDevicePerMonth || 0);
  const perAccount = Number(rates.perAccountPerMonth || 0);
  const minFee = Number(rates.minimumMonthlyFee || 0);
  const sym = currencySymbol(rates.currency || 'USD');
  return (
    <View style={{ gap: 4 }}>
      <View style={styles.ppLine}>
        <Text style={styles.ppBig}>{sym}{perDevice}</Text>
        <Text style={styles.ppUnit}>per device / month</Text>
      </View>
      <View style={styles.ppLine}>
        <Text style={styles.ppBig}>{sym}{perAccount}</Text>
        <Text style={styles.ppUnit}>per account / month</Text>
      </View>
      <Text style={styles.ppNote}>
        Minimum <Text style={styles.ppNoteStrong}>{sym}{minFee}/month</Text> maintenance fee — whichever is higher.
      </Text>
    </View>
  );
}

function PlanCard({ plan, billing, balanceNum, current, onSubscribe, onSwitchFree, onTopUp, styles, c }) {
  const isPostPaid = isPostPaidPlan(plan);
  const price = priceOf(plan, billing);
  const isFree = price === 0 && !isPostPaid;
  const popular = plan.badge === 'Most Popular';
  const canAfford = isFree || isPostPaid || balanceNum >= price;

  const badge = popular
    ? { label: plan.badge, color: c.primary500 }
    : isPostPaid ? { label: 'Pay as you trade', color: c.warn } : null;
  const borderColor = popular ? c.primary500 : isPostPaid ? c.warn : current ? c.bull : c.border;
  const highlights = (plan.highlights || []).filter((h) => !/copy[\s-]*trading/i.test(h));

  return (
    <View style={[styles.priceCard, { borderColor, borderWidth: popular || current ? 2 : 1 }]}>
      {badge ? (
        <View style={styles.badgeWrap} pointerEvents="none">
          <View style={[styles.badge, { backgroundColor: badge.color }]}>
            <Text style={styles.badgeTxt}>{badge.label}</Text>
          </View>
        </View>
      ) : null}

      <Text style={styles.planCode}>{plan.code}</Text>
      <Text style={styles.planTitle}>{plan.name}</Text>
      {plan.description ? <Text style={styles.planDesc}>{plan.description}</Text> : null}

      <View style={styles.priceBlock}>
        {isPostPaid ? (
          <PostPaidRateBlock plan={plan} styles={styles} c={c} />
        ) : (
          <Text>
            <Text style={styles.priceBig}>${priceLabel(price)}</Text>
            <Text style={styles.priceUnit}>  / {billing === 'YEARLY' ? 'year' : 'month'}</Text>
          </Text>
        )}
      </View>

      <View style={{ gap: 8, marginBottom: 16 }}>
        {highlights.map((h, i) => (
          <View key={i} style={styles.hlRow}>
            <Ionicons name="checkmark" size={14} color={c.bull} style={{ marginTop: 1 }} />
            <Text style={styles.hlTxt}>{h}</Text>
          </View>
        ))}
      </View>

      {current ? (
        <View style={[styles.cta, styles.ctaSecondary, { opacity: 0.6 }]}>
          <Text style={styles.ctaSecondaryTxt}>✓ Current plan</Text>
        </View>
      ) : isFree ? (
        <TouchableOpacity activeOpacity={0.85} onPress={() => onSwitchFree(plan)} style={[styles.cta, styles.ctaSecondary]}>
          <Text style={styles.ctaSecondaryTxt}>Switch to Free</Text>
        </TouchableOpacity>
      ) : isPostPaid ? (
        <TouchableOpacity activeOpacity={0.85} onPress={() => onSwitchFree(plan)} style={[styles.cta, styles.ctaPrimary]}>
          <Text style={styles.ctaPrimaryTxt}>Activate Post Paid</Text>
        </TouchableOpacity>
      ) : (
        <View style={{ gap: 8 }}>
          <TouchableOpacity
            activeOpacity={0.85}
            disabled={!canAfford}
            onPress={() => onSubscribe(plan)}
            style={[styles.cta, popular ? styles.ctaPrimary : styles.ctaSecondary, !canAfford && { opacity: 0.4 }]}
          >
            <Text style={popular ? styles.ctaPrimaryTxt : styles.ctaSecondaryTxt}>
              {canAfford ? `Pay from wallet · $${fmt(price)}` : 'Insufficient balance'}
            </Text>
          </TouchableOpacity>
          {!canAfford ? (
            <TouchableOpacity activeOpacity={0.7} onPress={onTopUp}>
              <Text style={styles.topUpUpgrade}>Top up to upgrade →</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      )}
    </View>
  );
}

function FeatureTable({ plans, styles, c }) {
  return (
    <View style={styles.secCard}>
      <View style={styles.secHead}>
        <Text style={styles.secTitle}>Compare features</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          <View style={[styles.ftRow, styles.ftHeadRow]}>
            <Text style={[styles.ftHeadTxt, { width: FEATURE_W, textAlign: 'left' }]}>Feature</Text>
            {plans.map((p) => (
              <Text key={p._id || p.code} style={[styles.ftHeadTxt, { width: PLAN_W }]} numberOfLines={1}>{p.name}</Text>
            ))}
          </View>
          {FEATURES.map((f) => (
            <View key={f.label} style={styles.ftRow}>
              <Text style={[styles.ftLabel, { width: FEATURE_W }]}>{f.label}</Text>
              {plans.map((p) => (
                <Text key={p._id || p.code} style={[styles.ftVal, { width: PLAN_W }]}>{String(f.value(p) ?? '—')}</Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function BillingHistory({ rows, styles, c }) {
  return (
    <View style={styles.secCard}>
      <View style={styles.secHead}>
        <View style={styles.rowBetween}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.secTitle}>Billing history</Text>
            <Text style={styles.secSub}>Plan charges, renewals and refunds from your Main Wallet.</Text>
          </View>
          {rows.length > 0 ? (
            <Text style={styles.secCount}>{rows.length} record{rows.length === 1 ? '' : 's'}</Text>
          ) : null}
        </View>
      </View>
      {rows.length === 0 ? (
        <Text style={styles.bhEmpty}>No billing history yet. Your plan charges and renewals will appear here.</Text>
      ) : (
        rows.map((t, i) => <BillingRow key={t._id || i} t={t} last={i === rows.length - 1} styles={styles} c={c} />)
      )}
    </View>
  );
}

function BillingRow({ t, last, styles, c }) {
  const isDebit = t.transactionType === 'DEBIT';
  const sym = currencySymbol(t.currency || 'USD');
  const d = new Date(t.createdAt);
  const [bg, fg] = t.status === 'FAILED' ? [c.bearSoft, c.bear]
    : t.status === 'PENDING' ? [c.warnSoft, c.warn]
    : [c.bullSoft, c.bull];
  return (
    <View style={[styles.bhRow, last && { borderBottomWidth: 0 }]}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.bhDate}>{d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' })}</Text>
        <Text style={styles.bhTime}>{d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
        <View style={styles.reasonBadge}>
          <Text style={styles.reasonTxt}>{REASON_LABEL[t.reason] || t.reason}</Text>
        </View>
        {t.note ? <Text style={styles.bhNote}>{t.note}</Text> : null}
      </View>
      <View style={{ alignItems: 'flex-end', marginLeft: 12 }}>
        <Text style={[styles.bhAmount, { color: isDebit ? c.bear : c.bull }]}>
          {isDebit ? '−' : '+'}{sym}{fmt(t.amount)}
        </Text>
        <View style={[styles.statusPill, { backgroundColor: bg }]}>
          <Text style={[styles.statusTxt, { color: fg }]}>{t.status || 'SUCCESS'}</Text>
        </View>
      </View>
    </View>
  );
}

function ConfirmPaySheet({ plan, billing, wallet, submitting, onConfirm, onClose, onTopUp, styles, c }) {
  const price = priceOf(plan, billing);
  const balance = Number(wallet?.free || wallet?.balance || 0);
  const after = balance - price;
  const canAfford = balance >= price;
  const ccy = wallet?.currency || 'USD';
  const footer = (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <TouchableOpacity onPress={onClose} disabled={submitting} activeOpacity={0.85} style={[styles.sheetBtn, styles.sheetBtnGhost, { flex: 1 }]}>
        <Text style={styles.sheetBtnGhostTxt}>Cancel</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onConfirm}
        disabled={!canAfford || submitting}
        activeOpacity={0.85}
        style={[styles.sheetBtn, styles.sheetBtnPrimary, { flex: 1, opacity: !canAfford || submitting ? 0.4 : 1 }]}
      >
        {submitting ? <ActivityIndicator color={c.white} /> : <Text style={styles.sheetBtnPrimaryTxt}>Pay ${fmt(price)} & subscribe</Text>}
      </TouchableOpacity>
    </View>
  );
  return (
    <Sheet title="Confirm subscription" onClose={() => !submitting && onClose()} footer={footer} styles={styles} c={c}>
      <View style={styles.sumBox}>
        <Text style={styles.caps}>Plan</Text>
        <Text style={styles.sumName}>{plan.name}</Text>
        <Text style={styles.sumBilling}>Billing: <Text style={styles.sumBillingStrong}>{billing === 'YEARLY' ? 'Yearly' : 'Monthly'}</Text></Text>
      </View>

      <View style={{ gap: 8 }}>
        <KV label="Amount due" value={`$${fmt(price)}`} tone="primary" styles={styles} c={c} />
        <KV label="Wallet balance" value={`${ccy} ${fmt(balance)}`} tone="neutral" styles={styles} c={c} />
        <KV label="After payment" value={`${ccy} ${fmt(Math.max(0, after))}`} tone={canAfford ? 'bull' : 'bear'} styles={styles} c={c} />
      </View>

      {!canAfford ? (
        <TouchableOpacity activeOpacity={0.7} onPress={onTopUp} style={styles.alertBear}>
          <Text style={styles.alertBearTxt}>Insufficient balance. <Text style={styles.alertBearLink}>Top up your wallet →</Text></Text>
        </TouchableOpacity>
      ) : null}

      <Text style={styles.sheetNote}>
        Plan renewals are deducted from your Main Wallet ({ccy}) immediately. The Bonus Wallet is never charged. Subscription activates the moment the payment clears — there's no refund window for partial use.
      </Text>
    </Sheet>
  );
}

function RechargeSheet({ plan, balance, needed, shortfall, currency, onClose, onTopUp, styles, c }) {
  const sym = currencySymbol(currency || 'USD');
  const footer = (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <TouchableOpacity onPress={onClose} activeOpacity={0.85} style={[styles.sheetBtn, styles.sheetBtnGhost, { flex: 1 }]}>
        <Text style={styles.sheetBtnGhostTxt}>Maybe later</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onTopUp} activeOpacity={0.85} style={[styles.sheetBtn, styles.sheetBtnPrimary, { flex: 1 }]}>
        <Text style={styles.sheetBtnPrimaryTxt}>Add funds →</Text>
      </TouchableOpacity>
    </View>
  );
  return (
    <Sheet title="Recharge required" onClose={onClose} footer={footer} styles={styles} c={c}>
      <View style={styles.alertBear}>
        <Text style={styles.alertBearTxt}>Not enough balance in your Main Wallet to subscribe to {plan?.name}.</Text>
      </View>
      <View style={styles.statRow}>
        <Stat label="Balance" value={`${sym}${fmt(balance)}`} tone="muted" styles={styles} c={c} />
        <Stat label="Plan price" value={`${sym}${fmt(needed)}`} tone="primary" styles={styles} c={c} />
        <Stat label="Top up by" value={`${sym}${fmt(shortfall)}`} tone="bear" styles={styles} c={c} />
      </View>
      <Text style={styles.sheetNote}>
        Plan purchases and renewals are deducted from your Main Wallet. Top up your Main Wallet to continue.
      </Text>
    </Sheet>
  );
}

// ─── Screen ────────────────────────────────────────────────────────────────
export default function PlansScreen({ navigation }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);

  const [plans, setPlans] = useState(null);
  const [mySub, setMySub] = useState(null);
  const [effective, setEffective] = useState(null);
  const [subWallet, setSubWallet] = useState(null);
  const [history, setHistory] = useState([]);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [billing, setBilling] = useState('MONTHLY');
  const [confirmPlan, setConfirmPlan] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [rechargePrompt, setRechargePrompt] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [p, m, h] = await Promise.all([
        api.get('/subscriptions/plans'),
        api.get('/subscriptions/me'),
        // Billing history is non-fatal — a failure here shouldn't blank the page.
        api.get('/subscriptions/history', { params: { limit: 100 } }).catch(() => ({ data: { data: [] } })),
      ]);
      setPlans(p.data.data || []);
      setMySub(m.data.data.subscription);
      setEffective(m.data.data.effectivePlan);
      setSubWallet(m.data.data.subscriptionWallet || null);
      setHistory(Array.isArray(h.data.data) ? h.data.data : []);
      setErr('');
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const onRefresh = async () => { setRefreshing(true); await refresh(); setRefreshing(false); };

  const goWallet = useCallback(() => navigation.navigate('Wallet'), [navigation]);

  const confirmAsync = (message) => new Promise((resolve) => {
    Alert.alert('Confirm', message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Confirm', onPress: () => resolve(true) },
    ]);
  });

  // Free / Post-Paid switch — no upfront payment, no confirmation sheet.
  const switchToFree = async (plan) => {
    const isPostPaid = isPostPaidPlan(plan);
    const prompt = isPostPaid
      ? `Activate ${plan.name}? You'll be billed per trade plus a monthly maintenance fee.`
      : `Switch to ${plan.name}? Your paid features will end immediately.`;
    if (!(await confirmAsync(prompt))) return;
    try {
      await api.post('/subscriptions/subscribe', { planCode: plan.code, billingCycle: billing });
      Alert.alert(isPostPaid ? `${plan.name} activated` : `Switched to ${plan.name}`);
      refresh();
    } catch (e) {
      Alert.alert('Error', errorMessage(e));
    }
  };

  // Submit handler — debits the Main Wallet and creates the sub. On insufficient
  // balance the backend returns a structured 402 → surface the recharge sheet.
  const confirmAndPay = async () => {
    if (!confirmPlan) return;
    setSubmitting(true);
    try {
      await api.post('/subscriptions/subscribe', {
        planCode: confirmPlan.code,
        billingCycle: billing,
        paymentMethod: 'subscription_wallet',
      });
      const price = priceOf(confirmPlan, billing);
      Alert.alert(`Subscribed to ${confirmPlan.name}`, `${fmt(price)} deducted from your Main Wallet`);
      setConfirmPlan(null);
      refresh();
    } catch (e) {
      const code = e.response?.data?.error?.code;
      const details = e.response?.data?.error?.details;
      if (code === 'INSUFFICIENT_SUBSCRIPTION_BALANCE') {
        setRechargePrompt({
          plan: confirmPlan,
          balance: details?.balance ?? subWallet?.balance ?? '0',
          needed: details?.needed ?? String(priceOf(confirmPlan, billing)),
          shortfall: details?.shortfall ?? '0',
          currency: details?.currency ?? subWallet?.currency ?? 'USD',
        });
        setConfirmPlan(null);
      } else {
        Alert.alert('Error', errorMessage(e));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async () => {
    if (!(await confirmAsync('Cancel your subscription? You will be downgraded to Free at the end of your billing period.'))) return;
    try {
      await api.post('/subscriptions/cancel', { reason: 'User requested' });
      Alert.alert('Subscription cancelled');
      refresh();
    } catch (e) {
      Alert.alert('Error', errorMessage(e));
    }
  };

  if (plans == null && !err) return <Loader label="Loading plans…" />;
  if (plans == null) return <Empty title="Couldn't load plans" sub={err} />;

  const isCurrent = (plan) => effective?.code === plan.code;
  const balanceNum = Number(subWallet?.balance || 0);
  const walletSym = currencySymbol(subWallet?.currency || 'USD');
  const billingRows = (history || []).filter((t) => BILLING_REASONS.has(t.reason));

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 14 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary500} />}
      >
        {/* Hero */}
        <View>
          <Text style={styles.heroEyebrow}>Membership</Text>
          <Text style={styles.heroTitle}>Plans & Pricing</Text>
          <Text style={styles.heroSub}>Upgrade for lower trading fees, more accounts, premium support, and exclusive perks.</Text>
        </View>

        {/* Current plan */}
        {effective ? (
          <View style={styles.card}>
            <Text style={styles.caps}>Current plan</Text>
            <View style={[styles.rowBetween, { marginTop: 4 }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.planName}>{effective.name}</Text>
                {mySub?.expiresAt ? (
                  <Text style={styles.renew}>Renews {new Date(mySub.expiresAt).toLocaleDateString()}</Text>
                ) : null}
              </View>
              {mySub && mySub.status === 'ACTIVE' && effective.code !== 'FREE' ? (
                <TouchableOpacity onPress={cancel} activeOpacity={0.85} style={styles.cancelBtn}>
                  <Text style={styles.cancelBtnTxt}>Cancel subscription</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
        ) : null}

        {/* Billing source: Main Wallet */}
        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.caps}>Billing Source: Main Wallet</Text>
            {subWallet?.isLowBalance ? (
              <View style={[styles.lowPill, { backgroundColor: c.warnSoft }]}>
                <Text style={[styles.lowPillTxt, { color: c.warn }]}>Low</Text>
              </View>
            ) : null}
          </View>
          <View style={[styles.rowBetween, { marginTop: 4 }]}>
            <Text style={styles.walletBal}>{walletSym}{fmt(balanceNum)}</Text>
            <TouchableOpacity onPress={goWallet} activeOpacity={0.7}>
              <Text style={styles.link}>Top up →</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.srcNote}>Plan renewals are deducted from your Main Wallet.</Text>
          <Text style={styles.srcWarn}>⚠ Ensure sufficient balance is available in your Main Wallet before the renewal date.</Text>
        </View>

        {/* Billing toggle */}
        <View style={styles.toggleRow}>
          <Text style={billing === 'MONTHLY' ? styles.tglActive : styles.tglMuted}>Monthly</Text>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => setBilling(billing === 'MONTHLY' ? 'YEARLY' : 'MONTHLY')}
            style={styles.tglTrack}
          >
            <View style={[styles.tglKnob, billing === 'YEARLY' ? styles.tglKnobRight : styles.tglKnobLeft]} />
          </TouchableOpacity>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={billing === 'YEARLY' ? styles.tglActive : styles.tglMuted}>Yearly</Text>
            <Text style={styles.tglSave}>  save ~17%</Text>
          </View>
        </View>

        {/* Pricing cards */}
        <View style={{ gap: 20, marginTop: 6 }}>
          {plans.map((plan) => (
            <PlanCard
              key={plan._id || plan.code}
              plan={plan}
              billing={billing}
              balanceNum={balanceNum}
              current={isCurrent(plan)}
              onSubscribe={setConfirmPlan}
              onSwitchFree={switchToFree}
              onTopUp={goWallet}
              styles={styles}
              c={c}
            />
          ))}
        </View>

        {/* Compare features */}
        <FeatureTable plans={plans} styles={styles} c={c} />

        {/* Billing history */}
        <BillingHistory rows={billingRows} styles={styles} c={c} />

        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Confirm-pay sheet */}
      {confirmPlan ? (
        <ConfirmPaySheet
          plan={confirmPlan}
          billing={billing}
          wallet={subWallet}
          submitting={submitting}
          onConfirm={confirmAndPay}
          onClose={() => setConfirmPlan(null)}
          onTopUp={() => { setConfirmPlan(null); goWallet(); }}
          styles={styles}
          c={c}
        />
      ) : null}

      {/* Recharge sheet */}
      {rechargePrompt ? (
        <RechargeSheet
          {...rechargePrompt}
          onClose={() => setRechargePrompt(null)}
          onTopUp={() => { setRechargePrompt(null); goWallet(); }}
          styles={styles}
          c={c}
        />
      ) : null}
    </View>
  );
}

const makeStyles = (c) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },

  // Hero
  heroEyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1, color: c.primary500, textTransform: 'uppercase' },
  heroTitle: { fontSize: 24, fontWeight: '900', color: c.textPrimary, marginTop: 4 },
  heroSub: { fontSize: 13, color: c.textMuted, marginTop: 6, lineHeight: 19 },

  // Generic card + labels
  card: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.xl, padding: 16 },
  caps: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, color: c.textMuted, textTransform: 'uppercase' },

  // Current plan card
  planName: { fontSize: 20, fontWeight: '900', color: c.textPrimary },
  renew: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  cancelBtn: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8, marginLeft: 8 },
  cancelBtnTxt: { fontSize: 12, fontWeight: '700', color: c.textPrimary },

  // Billing source card
  lowPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  lowPillTxt: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
  walletBal: { fontSize: 20, fontWeight: '900', color: c.textPrimary, fontVariant: ['tabular-nums'] },
  link: { fontSize: 13, fontWeight: '700', color: c.primary500 },
  srcNote: { fontSize: 11, color: c.textMuted, marginTop: 8 },
  srcWarn: { fontSize: 11, color: c.warn, marginTop: 4 },

  // Billing toggle
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 2 },
  tglActive: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
  tglMuted: { fontSize: 14, color: c.textMuted },
  tglSave: { fontSize: 12, color: c.bull, fontWeight: '700' },
  tglTrack: { width: 48, height: 26, borderRadius: radius.pill, backgroundColor: c.hover, borderWidth: 1, borderColor: c.border, justifyContent: 'center' },
  tglKnob: { position: 'absolute', width: 20, height: 20, borderRadius: radius.pill, backgroundColor: c.primary500 },
  tglKnobLeft: { left: 2 },
  tglKnobRight: { left: 25 },

  // Pricing card
  priceCard: { backgroundColor: c.card, borderRadius: radius.xl, padding: 18, position: 'relative' },
  badgeWrap: { position: 'absolute', top: -11, left: 0, right: 0, alignItems: 'center', zIndex: 2 },
  badge: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: radius.pill },
  badgeTxt: { color: c.white, fontSize: 11, fontWeight: '800' },
  planCode: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, color: c.textMuted, textTransform: 'uppercase' },
  planTitle: { fontSize: 22, fontWeight: '900', color: c.textPrimary, marginTop: 2 },
  planDesc: { fontSize: 13, color: c.textSecondary, marginTop: 4, lineHeight: 18 },
  priceBlock: { marginVertical: 16 },
  priceBig: { fontSize: 34, fontWeight: '900', color: c.textPrimary },
  priceUnit: { fontSize: 13, color: c.textMuted },
  ppLine: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  ppBig: { fontSize: 22, fontWeight: '900', color: c.textPrimary },
  ppUnit: { fontSize: 12, color: c.textMuted },
  ppNote: { fontSize: 11, color: c.textMuted, marginTop: 4, lineHeight: 16 },
  ppNoteStrong: { fontWeight: '700', color: c.textSecondary },
  hlRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  hlTxt: { flex: 1, fontSize: 13, color: c.textSecondary, lineHeight: 18 },

  // Pricing CTA
  cta: { height: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  ctaPrimary: { backgroundColor: c.primary500 },
  ctaPrimaryTxt: { color: c.white, fontSize: 14, fontWeight: '800' },
  ctaSecondary: { borderWidth: 1, borderColor: c.border, backgroundColor: c.bg },
  ctaSecondaryTxt: { color: c.textPrimary, fontSize: 14, fontWeight: '700' },
  topUpUpgrade: { textAlign: 'center', fontSize: 11, fontWeight: '700', color: c.primary500 },

  // Section card (compare / billing)
  secCard: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.xl, overflow: 'hidden' },
  secHead: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  secTitle: { fontSize: 15, fontWeight: '800', color: c.textPrimary },
  secSub: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  secCount: { fontSize: 11, color: c.textMuted, marginLeft: 8 },

  // Compare features table
  ftRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: c.borderSubtle, paddingVertical: 10 },
  ftHeadRow: { backgroundColor: c.hover },
  ftHeadTxt: { fontSize: 11, fontWeight: '800', letterSpacing: 0.3, color: c.textMuted, textTransform: 'uppercase', textAlign: 'center', paddingHorizontal: 8 },
  ftLabel: { fontSize: 13, color: c.textSecondary, paddingHorizontal: 12 },
  ftVal: { fontSize: 12, color: c.textPrimary, fontWeight: '700', textAlign: 'center', paddingHorizontal: 8, fontVariant: ['tabular-nums'] },

  // Billing history rows
  bhEmpty: { fontSize: 13, color: c.textMuted, textAlign: 'center', paddingHorizontal: 16, paddingVertical: 36 },
  bhRow: { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  bhDate: { fontSize: 13, color: c.textSecondary, fontWeight: '600' },
  bhTime: { fontSize: 11, color: c.textMuted, marginTop: 1 },
  reasonBadge: { alignSelf: 'flex-start', backgroundColor: c.hover, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, marginTop: 6 },
  reasonTxt: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5, color: c.textSecondary, textTransform: 'uppercase' },
  bhNote: { fontSize: 12, color: c.textSecondary, marginTop: 4 },
  bhAmount: { fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statusPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginTop: 6 },
  statusTxt: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },

  // ── Bottom-sheet modals ──
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { maxHeight: '90%', backgroundColor: c.bg, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, overflow: 'hidden' },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  sheetTitle: { flex: 1, fontSize: 16, fontWeight: '900', color: c.textPrimary },
  sheetClose: { fontSize: 26, lineHeight: 26, color: c.textMuted, fontWeight: '400' },
  sheetFoot: { flexDirection: 'row', padding: 12, borderTopWidth: 1, borderTopColor: c.borderSubtle, backgroundColor: c.card },
  sheetBtn: { height: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  sheetBtnGhost: { borderWidth: 1, borderColor: c.border },
  sheetBtnGhostTxt: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
  sheetBtnPrimary: { backgroundColor: c.primary500 },
  sheetBtnPrimaryTxt: { fontSize: 14, fontWeight: '800', color: c.white },

  // Confirm-pay sheet bits
  sumBox: { backgroundColor: c.hover, borderRadius: radius.md, padding: 12 },
  sumName: { fontSize: 18, fontWeight: '800', color: c.textPrimary, marginTop: 2 },
  sumBilling: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  sumBillingStrong: { fontWeight: '700', color: c.textSecondary },
  kvRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  kvLabel: { fontSize: 13, color: c.textMuted },
  kvVal: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  alertBear: { borderWidth: 1, borderColor: c.bear, backgroundColor: c.bearSoft, borderRadius: radius.md, padding: 10 },
  alertBearTxt: { fontSize: 12, fontWeight: '600', color: c.bear, lineHeight: 17 },
  alertBearLink: { fontWeight: '800', textDecorationLine: 'underline' },
  sheetNote: { fontSize: 11, color: c.textMuted, lineHeight: 16 },

  // Recharge sheet stats
  statRow: { flexDirection: 'row', gap: 8 },
  statBox: { flex: 1, borderWidth: 1, borderColor: c.borderSubtle, borderRadius: radius.md, padding: 8, alignItems: 'center' },
  statLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5, color: c.textMuted, textTransform: 'uppercase' },
  statVal: { fontSize: 14, fontWeight: '800', marginTop: 4, fontVariant: ['tabular-nums'] },
});
