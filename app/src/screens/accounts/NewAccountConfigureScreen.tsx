import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { accountApi, createAccountFromWizard } from '@/api/account.api';
import { errorMessage } from '@/api/client';
import { walletApi } from '@/api/wallet.api';
import { LeverageSelect } from '@/components/accounts/LeverageSelect';
import { WalletNav } from '@/components/wallet/WalletNav';
import {
  AppText,
  Button,
  Card,
  ErrorView,
  Icon,
  Input,
  LoadingView,
  PageHero,
  Screen,
  toast,
  useScreenChrome,
  type ScreenProps,
} from '@/components/ui';
import type { AppScreenProps } from '@/navigation';
import { useSelectedAccountStore } from '@/store/selectedAccount';
import { alpha, useTheme } from '@/theme';
import type { AccountPlanDetail } from '@/types/user';
import type { WalletBalance } from '@/types/wallet';
import {
  ACCOUNT_BASE_CURRENCY_LABEL,
  ACCOUNT_MODE_DESC,
  DEMO_ACCENT,
  accountCreatedToast,
  belowMinFigures,
  buildNewAccountPayload,
  configureAccent,
  leverageForMode,
  minDepositCheck,
  planNotFoundMessage,
  realMoneyTotal,
  syncNickname,
  tierDefaultLeverage,
  tierSummaryLine,
  usageByType,
  type AccountMode,
} from '@/utils/plans';

/**
 * client/src/pages/NewAccountConfigure.jsx (EquityHub) —
 * `/accounts/new/:tierCode`, page 2 of the new-account flow: Real / Demo
 * mode, then nickname, the base currency (fixed: INR, EquityHub is
 * rupee-only) and leverage (the tier cap locks the ladder above it; Demo is
 * fixed at 1:Unlimited), a below-minimum-deposit warning, and
 * POST /user/accounts with the web's exact body (utils/plans
 * buildNewAccountPayload — a demo keeps the chosen tier in `tierCode` and
 * starts with the ₹1,00,000 seed). On success → the Wallet (the web's
 * `/wallet?view=accounts`, which the Wallet opens on its overview).
 *
 * Differences from the web, on purpose:
 *   - The "Below minimum deposit" total counts real-money accounts only
 *     (utils/plans realMoneyTotal) — the web's included practice seeds.
 *   - After creating, the shared account list is reloaded so the header
 *     switcher and the Wallet see the new account at once (the web's
 *     page load did that), and the flow is popped back to the Wallet
 *     instead of stacking it on top of the finished form.
 *   - A failed tier catalogue load shows the error with a retry, not
 *     "Plan not found" (which the web showed for a network error).
 */
export function NewAccountConfigureScreen({ navigation, route }: AppScreenProps<'NewAccountConfigure'>): React.JSX.Element {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const chrome = useScreenChrome();
  // The form's Screen leaves the bottom inset to the action bar under it;
  // the top follows the Screen's own rule (only when no header took it).
  const screenEdges: NonNullable<ScreenProps['edges']> = chrome.hasHeader ? ['left', 'right'] : ['top', 'left', 'right'];
  const tierCode = route.params?.tierCode ?? '';

  const accounts = useSelectedAccountStore((s) => s.accounts);
  const [plan, setPlan] = useState<AccountPlanDetail | null>(null);
  const [balances, setBalances] = useState<WalletBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [mode, setMode] = useState<AccountMode>('REAL');
  const [nickname, setNickname] = useState('');
  const [leverage, setLeverage] = useState<number>(100);
  const [submitting, setSubmitting] = useState(false);

  // Set in the setup too: StrictMode / Fast Refresh replay cleanup + setup,
  // and a ref that only ever goes false would drop every later response.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const seededFor = useRef<string | null>(null);
  // `loading` disables the Create button only after the next render; a
  // second tap before that would open a second account. Written
  // synchronously, the ref refuses it.
  const creatingRef = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    const [pl] = await Promise.allSettled([
      accountApi.listPlans(),
      useSelectedAccountStore.getState().load(),
    ]);
    if (!mounted.current) return;
    if (pl.status === 'fulfilled') {
      const target = pl.value.find((p) => p.code === tierCode);
      if (!target) {
        toast.error(planNotFoundMessage(tierCode));
        // `navigate('/accounts/new', { replace: true })`.
        navigation.popTo('NewAccountTiers');
        return;
      }
      setLoadError(null);
      // The form is seeded once per tier; a pull-to-refresh keeps what the
      // user has typed and picked.
      if (seededFor.current !== target.code) {
        seededFor.current = target.code;
        setNickname(target.name);
        // Capped tiers start at the cap; uncapped ones at Unlimited.
        setLeverage(tierDefaultLeverage(target));
      }
      setPlan(target);
    } else {
      setLoadError(pl.reason);
      // A failed first load is told by the ErrorView; only a failed refresh
      // (form still showing, no ErrorView) needs the toast.
      if (seededFor.current) toast.error(errorMessage(pl.reason));
    }

    // Every wallet of every account, per account — NewAccountConfigure.jsx:57-65.
    const accs = useSelectedAccountStore.getState().accounts;
    if (accs.length) {
      const bs = await Promise.allSettled(accs.map((a) => walletApi.balances(a.id)));
      if (!mounted.current) return;
      const flat: WalletBalance[] = [];
      for (const r of bs) if (r.status === 'fulfilled') flat.push(...r.value);
      setBalances(flat);
    }
    if (mounted.current) setLoading(false);
  }, [tierCode, navigation]);

  useEffect(() => { void load(); }, [load]);

  const totalBalance = useMemo(() => realMoneyTotal(accounts, balances), [accounts, balances]);
  const usage = useMemo(() => usageByType(accounts), [accounts]);

  // Keyed on the fields each effect reads, not the object, so a refresh
  // that returns the same tier does not reset the user's choices.
  const planName = plan?.name ?? null;
  const planCap = plan ? plan.maxLeverage : undefined;

  // Keep the nickname in step with the mode unless the user typed their own.
  useEffect(() => {
    if (planName == null) return;
    setNickname((curr) => syncNickname(curr, { name: planName }, mode));
  }, [mode, planName]);

  // Demo is always 1:Unlimited; back to Real restores the tier default.
  useEffect(() => {
    if (planCap === undefined) return;
    setLeverage(leverageForMode({ maxLeverage: planCap }, mode));
  }, [mode, planCap]);

  const create = async (): Promise<void> => {
    if (!plan || creatingRef.current) return;
    creatingRef.current = true;
    setSubmitting(true);
    try {
      await createAccountFromWizard(buildNewAccountPayload({ plan, mode, nickname, leverage }));
      toast.success(accountCreatedToast(plan, mode));
      void useSelectedAccountStore.getState().load();
      // The web goes to `/wallet?view=accounts`; the Wallet reads no such
      // view and opens its overview, so the app goes to the Wallet as it
      // is. popTo returns to a Wallet already under the flow, or replaces
      // the finished form with one.
      navigation.popTo('Wallet');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      creatingRef.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  const toTiers = (): void => navigation.popTo('NewAccountTiers');

  if (loading || !plan) {
    return (
      <Screen onRefresh={loadError ? load : undefined}>
        <WalletNav activeId={null} />
        {loading ? (
          <LoadingView />
        ) : loadError ? (
          <ErrorView error={loadError} onRetry={() => { setLoading(true); void load(); }} />
        ) : (
          <AppText variant="body" tone="muted" style={styles.notFound}>
            Plan not found.{' '}
            <AppText variant="body" color={t.colors.primary} style={styles.underline} onPress={toTiers}>Pick a tier →</AppText>
          </AppText>
        )}
      </Screen>
    );
  }

  const isDemo = mode === 'DEMO';
  const accent = configureAccent(plan);
  const { minDep, shortfall, belowMin, tierCap } = minDepositCheck(plan, mode, totalBalance);
  const short = belowMinFigures(totalBalance, minDep, shortfall);
  const owned = usage[plan.code] ?? 0;

  return (
    <View style={[styles.flex, { backgroundColor: t.colors.surface }]}>
      {/* The action bar sits BELOW the scroll view, in flow — the web's
          `sticky bottom-0`. Floated over the scroll view instead, it covered
          the bottom of the viewport, which is exactly where Android scrolls
          a focused field (Nickname, Custom leverage) when the keyboard
          opens, and the page footer at the end of the scroll. The bar
          takes the bottom safe-area inset, so the Screen does not. */}
      <Screen onRefresh={load} edges={screenEdges}>
        <WalletNav activeId={null} />

        <PageHero
          style={styles.hero}
          eyebrow={`New ${plan.name} Account`}
          title="Account configuration"
          subtitle="Pick a mode and fine-tune the trading rules. You can change leverage later from account settings."
          actions={<Button title="← Change tier" variant="ghost" size="sm" onPress={toTiers} />}
        />

        {/* Tier summary chip */}
        <Card style={[styles.summary, { borderColor: accent }]}>
          {plan.icon ? <AppText style={styles.emoji}>{plan.icon}</AppText> : null}
          <View style={styles.flex}>
            <AppText variant="bodyStrong" weight="800">{plan.name}</AppText>
            <AppText variant="caption" tone="muted">
              {tierSummaryLine(plan)}
              {plan.buyCloseOnly ? <AppText variant="caption" color={t.colors.warn} weight="700">{'  · Buy-only'}</AppText> : null}
            </AppText>
          </View>
          {owned > 0 ? (
            <View style={[styles.owned, { backgroundColor: alpha(t.colors.bull, 0.15) }]}>
              <AppText weight="800" color={t.colors.bull} style={styles.microText}>{`✓ ${owned} active`}</AppText>
            </View>
          ) : null}
        </Card>

        {/* Section 1 — mode */}
        <Section title="Account mode" desc={ACCOUNT_MODE_DESC}>
          <View style={styles.gap12}>
            <ModeCard
              title="Real Account"
              tagline="Live trading"
              body="Trade with deposited funds. Profits and losses settle to your real wallet. Tier rules (leverage cap, fees, restrictions) apply."
              icon="💼"
              accent={accent}
              active={mode === 'REAL'}
              onPress={() => setMode('REAL')}
            />
            <ModeCard
              title="Demo Account"
              tagline="Practice trading"
              body="Virtual funds, no real deposit. Identical trading engine — useful for testing strategies risk-free."
              icon="🎯"
              accent={DEMO_ACCENT}
              active={mode === 'DEMO'}
              onPress={() => setMode('DEMO')}
              badge="No deposit needed"
            />
          </View>
        </Section>

        {/* Section 2 — details */}
        <Section
          title="Account details"
          desc="Nickname helps you spot this account in the picker. Leverage caps out at 1:Unlimited."
        >
          {belowMin ? (
            <View style={[styles.warnBox, { backgroundColor: alpha(t.colors.warn, 0.1), borderColor: alpha(t.colors.warn, 0.3) }]}>
              <View style={styles.warnIcon}><Icon name="alert" size={14} color={t.colors.warn} strokeWidth={2.4} /></View>
              <View style={styles.flex}>
                <AppText variant="small" weight="700" color={t.colors.warn}>Below minimum deposit</AppText>
                <AppText variant="small" tone="secondary" style={styles.mt2}>
                  Wallet balance roughly <AppText variant="small" weight="700">{short.balance}</AppText>. Tier needs {short.needs} — you can still create the account and fund the <AppText variant="small" weight="700">{short.shortfall}</AppText> later.
                </AppText>
              </View>
            </View>
          ) : null}

          <View style={styles.gap16}>
            <Input
              label="Nickname"
              value={nickname}
              onChangeText={setNickname}
              placeholder={plan.name}
              autoCorrect={false}
            />
            {/* EquityHub is INR-only: every account is rupee-denominated,
                so the base currency is fixed rather than a choice. */}
            <View>
              <AppText variant="label" style={styles.fieldLabel}>Base currency</AppText>
              <FixedField label={ACCOUNT_BASE_CURRENCY_LABEL} accessibilityLabel={`Base currency ${ACCOUNT_BASE_CURRENCY_LABEL}, fixed`} />
            </View>
            <View>
              <AppText variant="label" style={styles.fieldLabel}>Leverage</AppText>
              {isDemo ? (
                // Demo accounts are permanently 1:Unlimited — a read-only chip.
                <FixedField label="1:Unlimited" accessibilityLabel="Leverage 1:Unlimited, fixed" />
              ) : (
                <LeverageSelect value={leverage} onChange={setLeverage} maxLeverage={tierCap} />
              )}
              {isDemo ? (
                <AppText variant="micro" tone="muted" style={styles.mt6}>
                  Demo accounts always run at <AppText variant="micro" weight="700">1:Unlimited</AppText> leverage — no caps on practice money.
                </AppText>
              ) : tierCap != null ? (
                <AppText variant="micro" tone="muted" style={styles.mt6}>
                  This tier caps leverage at <AppText variant="micro" weight="700">{`1:${tierCap}`}</AppText> — options above are locked.
                </AppText>
              ) : null}
            </View>
          </View>
        </Section>

      </Screen>

      <View
        style={[
          styles.dock,
          { paddingBottom: 8 + insets.bottom, paddingLeft: 8 + insets.left, paddingRight: 8 + insets.right },
        ]}
      >
        <Card padded={12} style={styles.bar}>
          <Button title="Back" variant="secondary" onPress={toTiers} />
          <Button
            title={isDemo ? 'Create Demo Account' : 'Create Real Account'}
            loading={submitting}
            loadingTitle="Creating…"
            onPress={() => { void create(); }}
            style={{ backgroundColor: isDemo ? DEMO_ACCENT : accent, borderColor: isDemo ? DEMO_ACCENT : accent }}
          />
        </Card>
      </View>
    </View>
  );
}

/* ── Local primitives ─────────────────────────────────────────────── */

/** A read-only value with the green "Fixed" chip — base currency, demo leverage. */
function FixedField({ label, accessibilityLabel }: { label: string; accessibilityLabel: string }): React.JSX.Element {
  const t = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.fixed,
        { borderColor: t.colors.borderDark, backgroundColor: alpha(t.colors.bgHover, 0.4), borderRadius: t.radius.xl },
      ]}
    >
      <AppText variant="bodyStrong">{label}</AppText>
      <View style={[styles.fixedChip, { backgroundColor: alpha(DEMO_ACCENT, 0.15) }]}>
        <AppText weight="700" color={t.tw.emerald700} style={styles.microText}>Fixed</AppText>
      </View>
    </View>
  );
}

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }): React.JSX.Element {
  return (
    <Card padded={20} style={styles.section}>
      <View style={styles.sectionHead}>
        <AppText variant="title" weight="800">{title}</AppText>
        {desc ? <AppText variant="small" tone="muted" style={styles.mt2}>{desc}</AppText> : null}
      </View>
      {children}
    </Card>
  );
}

function ModeCard({
  title,
  tagline,
  body,
  icon,
  accent,
  active,
  badge,
  onPress,
}: {
  title: string;
  tagline: string;
  body: string;
  icon: string;
  accent: string;
  active: boolean;
  badge?: string;
  onPress: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const hex = /^#[0-9a-f]{6}$/i.test(accent);
  return (
    <View style={styles.modeWrap}>
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ checked: active }}
        accessibilityLabel={title}
        onPress={onPress}
        style={({ pressed }) => [
          styles.mode,
          {
            backgroundColor: pressed ? t.colors.bgHover : t.colors.surface,
            borderColor: active ? accent : t.colors.borderSubtle,
            borderRadius: t.radius.xxl,
          },
          // `box-shadow: 0 0 0 3px ${accent}22` — the selected glow.
          active && hex ? { shadowColor: accent, shadowOpacity: 0.35, shadowRadius: 3, shadowOffset: { width: 0, height: 0 }, elevation: 2 } : null,
        ]}
      >
        <View style={styles.modeHead}>
          <AppText style={styles.emoji}>{icon}</AppText>
          <View>
            <AppText variant="title" weight="800">{title}</AppText>
            <AppText variant="caption" weight="700" color={accent} style={styles.upper}>{tagline}</AppText>
          </View>
        </View>
        <AppText variant="small" tone="secondary" style={styles.mt12}>{body}</AppText>
        {active ? (
          <View style={styles.selected}>
            <Icon name="check" size={12} color={accent} strokeWidth={3} />
            <AppText weight="800" color={accent} style={styles.microText}>Selected</AppText>
          </View>
        ) : null}
      </Pressable>
      {badge ? (
        <View pointerEvents="none" style={[styles.modeBadge, { backgroundColor: accent }, t.shadow.card]}>
          <AppText weight="800" color="#FFFFFF" style={styles.microText}>{badge}</AppText>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  upper: { textTransform: 'uppercase', letterSpacing: 0.8 },
  underline: { textDecorationLine: 'underline' },
  mt2: { marginTop: 2 },
  mt6: { marginTop: 6 },
  mt12: { marginTop: 12 },
  gap12: { gap: 12 },
  gap16: { gap: 16 },
  notFound: { padding: 24 },
  hero: { marginTop: 16 },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 24 },
  emoji: { fontSize: 24, lineHeight: 30 },
  owned: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4 },
  microText: { fontSize: 10, lineHeight: 14, letterSpacing: 0.6, textTransform: 'uppercase' },
  section: { marginBottom: 24 },
  sectionHead: { marginBottom: 16 },
  modeWrap: { paddingTop: 10 },
  mode: { borderWidth: 2, padding: 16 },
  modeHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  selected: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 12 },
  modeBadge: { position: 'absolute', top: 0, right: 12, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  warnBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderWidth: 1, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, marginBottom: 16 },
  warnIcon: { marginTop: 2 },
  fieldLabel: { marginBottom: 6 },
  fixed: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, paddingHorizontal: 14, paddingVertical: 10, minHeight: 44 },
  fixedChip: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  dock: { paddingTop: 8 },
  bar: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8 },
});
