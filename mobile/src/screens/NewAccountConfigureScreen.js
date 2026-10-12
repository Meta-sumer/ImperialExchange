import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, Modal, ActivityIndicator, Alert, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, errorMessage } from '../services/api';
import { useAccounts } from '../store/account';
import { useColors, radius } from '../theme';
import { Loader, Empty } from '../components/ui';

/**
 * NewAccountConfigureScreen — native port of the web client's page 2 of the
 * open-account flow (client/src/pages/NewAccountConfigure.jsx). Reads the
 * chosen tier from route.params.tierCode and mirrors it section-for-section:
 *   • hero + "change tier" action
 *   • tier summary chip (min · leverage · fee · buy-only)
 *   • Section "Account mode"    — Real / Demo cards
 *   • Section "Account details" — below-min warning · nickname · base
 *     currency (pills) · leverage (native dropdown, or a fixed chip for Demo)
 *   • sticky bottom "Create account" bar → POST /user/accounts, then Wallet
 *
 * Hits the SAME backend the web calls: /account-plans · /user/accounts ·
 * /wallet/balances (below-min check) · POST /user/accounts (create).
 */

// ─── Fee-type display grouping (ported verbatim from web utils/feeType.js) ──
const FEE_TYPE_META = {
  PERCENTAGE:      { group: 'Commission', label: 'Percentage' },
  PCT_OF_VALUE:    { group: 'Commission', label: 'Percentage' },
  FIXED:           { group: 'Charges',    label: 'Fixed' },
  FIXED_PER_TRADE: { group: 'Charges',    label: 'Fixed' },
  PCT_OF_PROFIT:   { group: 'Charges',    label: 'Percentage of Profit' },
};
const feeTypeText = (code) => {
  const m = FEE_TYPE_META[String(code || '').toUpperCase()];
  return m ? `${m.group} · ${m.label}` : '';
};
const feeTypeWithDetail = (code, detail) => {
  const text = feeTypeText(code);
  if (text && detail) return `${text} — ${detail}`;
  return text || detail || '—';
};

// Leverage ladder (ported from web LeverageDropdown). 999999 == "1:Unlimited".
const LEVERAGE_LADDER = [1, 2, 5, 10, 20, 50, 100, 200, 400, 500, 600, 800, 1000, 2000];
const UNLIMITED_LEVERAGE = 999999;
const CURRENCIES = ['USD', 'INR', 'EUR', 'GBP'];

// Per-plan accent — honour backend accentColor, else tint by code. Receives
// `c` so it stays theme-reactive (module-scope fn, no module `c`).
const accentForPlan = (plan, c) => {
  if (plan?.accentColor) return plan.accentColor;
  const code = String(plan?.code || '');
  if (code.startsWith('FREE')) return c.bull;
  return c.primary500;
};

// ─── Native leverage dropdown (mirrors web LeverageDropdown behaviour) ──────
function LeverageSelect({ value, onChange, maxLeverage, styles, c }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);

  const capNum = Number(maxLeverage);
  const hasCap = Number.isFinite(capNum) && capNum > 0;

  // Snap the value down if it exceeds a freshly-arrived cap.
  useEffect(() => {
    if (hasCap && Number(value) > capNum) onChange(capNum);
  }, [hasCap, capNum, value]);

  const isLocked = (opt) => {
    if (!hasCap) return false;
    if (opt.kind === 'FIXED') return opt.value > capNum;
    if (opt.kind === 'UNLIMITED') return true;
    return false;
  };

  // When a cap is in force, never surface "1:Unlimited".
  const display = custom
    ? `Custom · 1:${value}`
    : (!hasCap && Number(value) >= UNLIMITED_LEVERAGE)
      ? '1:Unlimited'
      : `1:${hasCap ? Math.min(Number(value) || 1, capNum) : value}`;

  const OPTIONS = [
    { kind: 'CUSTOM', label: 'Custom' },
    ...LEVERAGE_LADDER.map((n) => ({ kind: 'FIXED', value: n })),
    { kind: 'UNLIMITED', label: '1:Unlimited' },
  ];

  const pick = (opt) => {
    if (isLocked(opt)) return;
    if (opt.kind === 'CUSTOM') setCustom(true);
    else if (opt.kind === 'UNLIMITED') { setCustom(false); onChange(UNLIMITED_LEVERAGE); }
    else { setCustom(false); onChange(opt.value); }
    setOpen(false);
  };

  return (
    <View>
      <TouchableOpacity activeOpacity={0.7} onPress={() => setOpen(true)} style={styles.selectTrigger}>
        <Text style={styles.selectValue} numberOfLines={1}>{display}</Text>
        <Ionicons name="chevron-down" size={16} color={c.textMuted} />
      </TouchableOpacity>

      {custom ? (
        <View style={styles.customRow}>
          <Text style={styles.customPrefix}>1:</Text>
          <TextInput
            keyboardType="number-pad"
            value={String(value)}
            onChangeText={(t) => {
              let v = Number(String(t).replace(/[^0-9]/g, '')) || 1;
              if (v < 1) v = 1;
              if (hasCap && v > capNum) v = capNum;
              onChange(v);
            }}
            placeholder={hasCap ? `up to ${capNum}` : 'e.g. 75'}
            placeholderTextColor={c.textMuted}
            style={styles.customInput}
          />
          <TouchableOpacity onPress={() => setCustom(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.customClose}>×</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <Modal visible={open} transparent animationType="slide" statusBarTranslucent onRequestClose={() => setOpen(false)}>
        <View style={styles.backdrop}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setOpen(false)} />
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>Select leverage</Text>
              <TouchableOpacity onPress={() => setOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={styles.sheetClose}>×</Text>
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ paddingVertical: 6 }}>
              {OPTIONS.map((opt, i) => {
                const locked = isLocked(opt);
                const selected =
                  (!custom && ((opt.kind === 'FIXED' && opt.value === value) || (opt.kind === 'UNLIMITED' && Number(value) >= UNLIMITED_LEVERAGE)))
                  || (custom && opt.kind === 'CUSTOM');
                const label = opt.kind === 'FIXED' ? `1:${opt.value}` : opt.label;
                return (
                  <TouchableOpacity
                    key={i}
                    disabled={locked}
                    activeOpacity={0.7}
                    onPress={() => pick(opt)}
                    style={[styles.optRow, selected && { backgroundColor: c.primarySoft }]}
                  >
                    <Text style={[styles.optTxt, locked && styles.optLocked, selected && { color: c.primary500 }]}>{label}</Text>
                    {locked ? <Ionicons name="lock-closed" size={13} color={c.textMuted} />
                      : selected ? <Ionicons name="checkmark" size={16} color={c.primary500} /> : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─── Presentational pieces (receive styles / c via props — no module `c`) ──
function Section({ title, desc, children, styles }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {desc ? <Text style={styles.sectionDesc}>{desc}</Text> : null}
      <View style={{ marginTop: 14 }}>{children}</View>
    </View>
  );
}

function Field({ label, children, styles }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function ModeCard({ title, tagline, body, icon, accent, active, badge, onPress, styles, c }) {
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={[styles.modeCard, { borderColor: active ? accent : c.border }]}
    >
      {badge ? (
        <View style={[styles.modeBadge, { backgroundColor: accent }]}>
          <Text style={styles.modeBadgeTxt}>{badge}</Text>
        </View>
      ) : null}
      <View style={styles.modeHead}>
        <Text style={styles.modeIcon}>{icon}</Text>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.modeTitle}>{title}</Text>
          <Text style={[styles.modeTagline, { color: accent }]}>{tagline}</Text>
        </View>
      </View>
      <Text style={styles.modeBody}>{body}</Text>
      {active ? (
        <View style={styles.modeSelected}>
          <Ionicons name="checkmark" size={13} color={accent} />
          <Text style={[styles.modeSelectedTxt, { color: accent }]}>Selected</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

// ─── Screen ────────────────────────────────────────────────────────────────
export default function NewAccountConfigureScreen({ route, navigation }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const tierCode = route.params?.tierCode;
  const loadAccounts = useAccounts((s) => s.load);

  const [plan, setPlan] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [balances, setBalances] = useState([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState('REAL');            // 'REAL' | 'DEMO'
  const [nickname, setNickname] = useState('');
  const [baseCurrency, setBaseCurrency] = useState('USD');
  const [leverage, setLeverage] = useState(100);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { navigation.setOptions({ title: 'Configure account' }); }, [navigation]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pl, ac] = await Promise.allSettled([
          api.get('/account-plans'),
          api.get('/user/accounts'),
        ]);
        if (cancelled) return;
        if (pl.status === 'fulfilled') {
          const all = pl.value.data.data || [];
          const target = all.find((p) => p.code === tierCode);
          if (!target) {
            Alert.alert('Plan not found', `Plan "${tierCode}" is not available.`);
            navigation.navigate('NewAccountTiers');
            setLoading(false);
            return;
          }
          setPlan(target);
          setNickname(target.name);
          // Default leverage: tier cap if present, otherwise Unlimited.
          setLeverage(target.maxLeverage != null ? target.maxLeverage : UNLIMITED_LEVERAGE);
        }
        if (ac.status === 'fulfilled') {
          const accs = ac.value.data.data || [];
          setAccounts(accs);
          if (accs.length) {
            const bs = await Promise.allSettled(
              accs.map((a) => api.get('/wallet/balances', { params: { accountId: a._id } })),
            );
            if (cancelled) return;
            const flat = [];
            bs.forEach((r) => { if (r.status === 'fulfilled') flat.push(...(r.value.data?.data || [])); });
            setBalances(flat);
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tierCode]);

  const totalBalance = useMemo(
    () => balances.reduce((sum, b) => sum + (Number(b.balance) || 0), 0),
    [balances],
  );

  const usage = useMemo(() => {
    const out = {};
    accounts.forEach((a) => { out[a.accountType] = (out[a.accountType] || 0) + 1; });
    return out;
  }, [accounts]);

  // Keep nickname in sync with mode unless the user typed a custom value.
  useEffect(() => {
    if (!plan) return;
    setNickname((curr) => {
      const defaults = [plan.name, `${plan.name} Practice`];
      if (!curr || defaults.includes(curr)) {
        return mode === 'DEMO' ? `${plan.name} Practice` : plan.name;
      }
      return curr;
    });
  }, [mode, plan]);

  // Demo accounts are permanently 1:Unlimited — snap on entering DEMO, restore
  // the tier default on switching back to REAL.
  useEffect(() => {
    if (!plan) return;
    if (mode === 'DEMO') setLeverage(UNLIMITED_LEVERAGE);
    else setLeverage(plan.maxLeverage != null ? plan.maxLeverage : UNLIMITED_LEVERAGE);
  }, [mode, plan]);

  const create = async () => {
    if (!plan) return;
    setSubmitting(true);
    try {
      const isDemoNow = mode === 'DEMO';
      const defaultLev = plan.maxLeverage != null ? plan.maxLeverage : UNLIMITED_LEVERAGE;
      const payload = isDemoNow
        ? {
            accountType: 'DEMO',
            tierCode: plan.code,   // preserve the chosen tier so the UI shows it
            baseCurrency,
            leverage: UNLIMITED_LEVERAGE,
            nickname: nickname.trim() || `${plan.name} Practice`,
            initialBalance: 100000,
          }
        : {
            accountType: plan.code,
            baseCurrency,
            leverage: Number(leverage) || defaultLev,
            nickname: nickname.trim() || plan.name,
          };
      await api.post('/user/accounts', payload);
      try { await loadAccounts(); } catch {}
      Alert.alert('Account created', `${isDemoNow ? 'Demo' : plan.name} account created`);
      navigation.navigate('Wallet');
    } catch (e) {
      Alert.alert('Could not create account', errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Loader label="Loading…" />;
  if (!plan) return <Empty title="Plan not found" sub="Pick a tier to continue." />;

  const isDemo = mode === 'DEMO';
  const accent = accentForPlan(plan, c);
  const minDep = Number(plan.minDeposit || 0);
  const shortfall = minDep - totalBalance;
  const belowMin = !isDemo && minDep > 0 && totalBalance < minDep;
  const tierCap = isDemo ? null : (plan.maxLeverage || null);
  const commission = feeTypeWithDetail(plan.feeKind || plan.feeModel?.kind, plan.feeDisplay);

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 28 }} keyboardShouldPersistTaps="handled">
        {/* Hero */}
        <View>
          <Text style={styles.heroEyebrow}>New {plan.name} Account</Text>
          <Text style={styles.heroTitle}>Account configuration</Text>
          <Text style={styles.heroSub}>Pick a mode and fine-tune the trading rules. You can change leverage later from account settings.</Text>
          <TouchableOpacity activeOpacity={0.7} onPress={() => navigation.navigate('NewAccountTiers')} style={{ marginTop: 8 }}>
            <Text style={styles.changeTier}>← Change tier</Text>
          </TouchableOpacity>
        </View>

        {/* Tier summary chip */}
        <View style={[styles.summaryChip, { borderColor: accent }]}>
          {plan.icon ? <Text style={styles.summaryIcon}>{plan.icon}</Text> : null}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.summaryName}>{plan.name}</Text>
            <Text style={styles.summaryMeta}>
              Min ${minDep} · {plan.maxLeverage ? `1:${plan.maxLeverage}` : '1:Unlimited'} · Fee {commission}
              {plan.buyCloseOnly ? <Text style={styles.summaryWarn}>  · Buy-only</Text> : null}
            </Text>
          </View>
          {usage[plan.code] > 0 ? (
            <View style={styles.activeChip}>
              <Text style={styles.activeChipTxt}>✓ {usage[plan.code]} active</Text>
            </View>
          ) : null}
        </View>

        {/* Section 1 — MODE */}
        <Section
          title="Account mode"
          desc="Real funds vs. virtual practice money. Demo accounts skip tier rules and start with $100,000 virtual seed."
          styles={styles}
        >
          <View style={{ gap: 12 }}>
            <ModeCard
              title="Real Account"
              tagline="Live trading"
              body="Trade with deposited funds. Profits and losses settle to your real wallet. Tier rules (leverage cap, fees, restrictions) apply."
              icon="💼"
              accent={accent}
              active={mode === 'REAL'}
              onPress={() => setMode('REAL')}
              styles={styles}
              c={c}
            />
            <ModeCard
              title="Demo Account"
              tagline="Practice trading"
              body="Virtual funds, no real deposit. Identical trading engine — useful for testing strategies risk-free."
              icon="🎯"
              accent={c.bull}
              active={mode === 'DEMO'}
              onPress={() => setMode('DEMO')}
              badge="No deposit needed"
              styles={styles}
              c={c}
            />
          </View>
        </Section>

        {/* Section 2 — DETAILS */}
        <Section
          title="Account details"
          desc="Nickname helps you spot this account in the picker. Leverage caps out at 1:Unlimited."
          styles={styles}
        >
          {belowMin ? (
            <View style={styles.warnBox}>
              <Ionicons name="warning-outline" size={16} color={c.warn} style={{ marginTop: 1 }} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.warnTitle}>Below minimum deposit</Text>
                <Text style={styles.warnBody}>
                  Wallet balance roughly ${totalBalance.toFixed(2)}. Tier needs ${minDep} — you can still create the account and fund the ${shortfall.toFixed(2)} later.
                </Text>
              </View>
            </View>
          ) : null}

          <Field label="Nickname" styles={styles}>
            <TextInput
              value={nickname}
              onChangeText={setNickname}
              placeholder={plan.name}
              placeholderTextColor={c.textMuted}
              style={styles.input}
            />
          </Field>

          <Field label="Base currency" styles={styles}>
            <View style={styles.pillRow}>
              {CURRENCIES.map((cur) => {
                const on = baseCurrency === cur;
                return (
                  <TouchableOpacity
                    key={cur}
                    activeOpacity={0.8}
                    onPress={() => setBaseCurrency(cur)}
                    style={[styles.pill, on && { borderColor: c.primary500, backgroundColor: c.primarySoft }]}
                  >
                    <Text style={[styles.pillTxt, on && { color: c.primary500 }]}>{cur}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </Field>

          <Field label="Leverage" styles={styles}>
            {isDemo ? (
              <View style={styles.fixedLev}>
                <Text style={styles.fixedLevTxt}>1:Unlimited</Text>
                <View style={styles.fixedTag}>
                  <Text style={styles.fixedTagTxt}>Fixed</Text>
                </View>
              </View>
            ) : (
              <LeverageSelect value={leverage} onChange={setLeverage} maxLeverage={tierCap} styles={styles} c={c} />
            )}
            {isDemo ? (
              <Text style={styles.levNote}>Demo accounts always run at 1:Unlimited leverage — no caps on practice money.</Text>
            ) : tierCap != null ? (
              <Text style={styles.levNote}>This tier caps leverage at 1:{tierCap} — options above are locked.</Text>
            ) : null}
          </Field>
        </Section>
      </ScrollView>

      {/* Sticky action bar */}
      <View style={styles.footer}>
        <TouchableOpacity activeOpacity={0.8} onPress={() => navigation.navigate('NewAccountTiers')} style={styles.backBtn}>
          <Text style={styles.backBtnTxt}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity
          activeOpacity={0.85}
          disabled={submitting}
          onPress={create}
          style={[styles.createBtn, { backgroundColor: isDemo ? c.bull : accent }, submitting && { opacity: 0.5 }]}
        >
          {submitting ? <ActivityIndicator color={c.white} />
            : <Text style={styles.createBtnTxt}>{isDemo ? 'Create Demo Account' : 'Create Real Account'}</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (c) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },

  // Hero
  heroEyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1, color: c.primary500, textTransform: 'uppercase' },
  heroTitle: { fontSize: 24, fontWeight: '900', color: c.textPrimary, marginTop: 4 },
  heroSub: { fontSize: 13, color: c.textMuted, marginTop: 6, lineHeight: 19 },
  changeTier: { fontSize: 13, fontWeight: '700', color: c.primary500 },

  // Tier summary chip
  summaryChip: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.card, borderWidth: 1.5, borderRadius: radius.lg, padding: 14 },
  summaryIcon: { fontSize: 22 },
  summaryName: { fontSize: 15, fontWeight: '900', color: c.textPrimary },
  summaryMeta: { fontSize: 11, color: c.textMuted, marginTop: 2, lineHeight: 16 },
  summaryWarn: { color: c.warn, fontWeight: '900' },
  activeChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, backgroundColor: c.bullSoft },
  activeChipTxt: { fontSize: 10, fontWeight: '900', letterSpacing: 0.5, color: c.bull, textTransform: 'uppercase' },

  // Section
  section: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.xl, padding: 16 },
  sectionTitle: { fontSize: 15, fontWeight: '900', color: c.textPrimary },
  sectionDesc: { fontSize: 12, color: c.textMuted, marginTop: 3, lineHeight: 17 },

  // Mode cards
  modeCard: { position: 'relative', borderWidth: 2, borderRadius: radius.xl, padding: 14, backgroundColor: c.bg },
  modeBadge: { position: 'absolute', top: -9, right: 12, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill },
  modeBadgeTxt: { fontSize: 9, fontWeight: '900', letterSpacing: 0.5, color: c.white, textTransform: 'uppercase' },
  modeHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  modeIcon: { fontSize: 22 },
  modeTitle: { fontSize: 15, fontWeight: '900', color: c.textPrimary },
  modeTagline: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase', marginTop: 1 },
  modeBody: { fontSize: 12, color: c.textSecondary, marginTop: 10, lineHeight: 17 },
  modeSelected: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 10 },
  modeSelectedTxt: { fontSize: 10, fontWeight: '900', letterSpacing: 0.5, textTransform: 'uppercase' },

  // Below-min warning
  warnBox: { flexDirection: 'row', gap: 8, backgroundColor: c.warnSoft, borderWidth: 1, borderColor: c.warn, borderRadius: radius.lg, padding: 12, marginBottom: 14 },
  warnTitle: { fontSize: 12, fontWeight: '900', color: c.warn },
  warnBody: { fontSize: 12, color: c.textSecondary, marginTop: 2, lineHeight: 17 },

  // Fields
  fieldLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, color: c.textMuted, textTransform: 'uppercase', marginBottom: 6 },
  input: { height: 48, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 15, color: c.textPrimary, backgroundColor: c.bg },

  // Currency pills
  pillRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  pill: { borderWidth: 1, borderColor: c.border, borderRadius: radius.pill, paddingHorizontal: 18, paddingVertical: 9, backgroundColor: c.bg },
  pillTxt: { fontSize: 13, fontWeight: '800', color: c.textSecondary },

  // Leverage — trigger + custom row + fixed chip
  selectTrigger: { height: 48, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: c.bg },
  selectValue: { fontSize: 15, fontWeight: '700', color: c.textPrimary, fontVariant: ['tabular-nums'] },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  customPrefix: { fontSize: 15, fontWeight: '800', color: c.textMuted },
  customInput: { flex: 1, height: 42, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, fontSize: 15, color: c.textPrimary, backgroundColor: c.bg },
  customClose: { fontSize: 22, color: c.textMuted, paddingHorizontal: 4 },
  fixedLev: { height: 48, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: c.hover },
  fixedLevTxt: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
  fixedTag: { backgroundColor: c.bullSoft, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
  fixedTagTxt: { fontSize: 9, fontWeight: '900', letterSpacing: 0.5, color: c.bull, textTransform: 'uppercase' },
  levNote: { fontSize: 10, color: c.textMuted, marginTop: 6, lineHeight: 15 },

  // Leverage dropdown sheet
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { maxHeight: '70%', backgroundColor: c.bg, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, overflow: 'hidden' },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  sheetTitle: { fontSize: 16, fontWeight: '900', color: c.textPrimary },
  sheetClose: { fontSize: 26, lineHeight: 26, color: c.textMuted },
  optRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 13 },
  optTxt: { fontSize: 15, fontWeight: '700', color: c.textPrimary, fontVariant: ['tabular-nums'] },
  optLocked: { color: c.textMuted, opacity: 0.5 },

  // Sticky footer
  footer: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: 1, borderTopColor: c.borderSubtle, backgroundColor: c.card },
  backBtn: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 18, paddingVertical: 13 },
  backBtnTxt: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
  createBtn: { flex: 1, height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  createBtnTxt: { fontSize: 15, fontWeight: '900', color: c.white },
});
