import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { api, errorMessage } from '../services/api';
import { useColors, radius } from '../theme';
import { Loader, Empty } from '../components/ui';

/**
 * NewAccountTiersScreen — native port of the web client's page 1 of the
 * open-account flow (client/src/pages/NewAccountTiers.jsx). Mirrors it
 * section-for-section:
 *   • grouped tier catalogue — Standard / Professional / Free / Other
 *   • each group is a card of selectable (radio) tier rows, with a badge
 *     tile, name + badge + "active" chip, description, feature chips and the
 *     spec columns (Min deposit · Max leverage · Commission) from the catalogue
 *   • a sticky "Continue" bar → navigation.navigate('NewAccountConfigure', { tierCode })
 *
 * Hits the SAME backend the web calls: /account-plans (catalogue) and
 * /user/accounts (owned-count badges). Real data only.
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

// Per-plan accent — honour the backend accentColor, else tint by code.
// Receives `c` so it stays theme-reactive (module-scope fn, no module `c`).
const accentForPlan = (plan, c) => {
  if (plan?.accentColor) return plan.accentColor;
  const code = String(plan?.code || '');
  if (code.startsWith('FREE')) return c.bull;
  return c.primary500;
};

const initialsOf = (plan) =>
  (plan?.name || plan?.code || 'A').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();

// ─── Presentational pieces (receive styles / c via props — no module `c`) ──
function Radio({ selected, styles, c }) {
  return (
    <View style={[styles.radio, selected
      ? { borderColor: c.primary500, backgroundColor: c.primary500 }
      : { borderColor: c.border, backgroundColor: c.card }]}>
      {selected ? <View style={styles.radioDot} /> : null}
    </View>
  );
}

function FeatureChips({ plan, styles, c }) {
  const items = [
    plan.buyCloseOnly
      ? { label: 'Buy-close only', tone: 'warn' }
      : { label: 'Buy / Sell · no restrictions', tone: 'bull' },
    { label: plan.instrumentsLabel || 'All instruments', tone: 'muted' },
    { label: plan.accessLabel || '24/7 access', tone: 'muted' },
    { label: plan.supportLabel || 'Standard support', tone: 'muted' },
  ];
  const tones = {
    warn: [c.warnSoft, c.warn],
    bull: [c.bullSoft, c.bull],
    muted: [c.hover, c.textSecondary],
  };
  return (
    <View style={styles.chipsWrap}>
      {items.map((it, i) => {
        const [bg, fg] = tones[it.tone] || tones.muted;
        return (
          <View key={i} style={[styles.chip, { backgroundColor: bg }]}>
            <View style={[styles.chipDot, { backgroundColor: fg }]} />
            <Text style={[styles.chipTxt, { color: fg }]}>{it.label}</Text>
          </View>
        );
      })}
    </View>
  );
}

function SpecLite({ label, value, styles }) {
  return (
    <View style={styles.spec}>
      <Text style={styles.specLabel}>{label}</Text>
      <Text style={styles.specValue}>{value}</Text>
    </View>
  );
}

function TierRow({ plan, selected, onSelect, ownedCount, last, styles, c }) {
  const accent = accentForPlan(plan, c);
  const minDep = Number(plan.minDeposit || 0);
  const lev = plan.maxLeverage ? `1:${plan.maxLeverage}` : '1:Unlimited';
  const commission = feeTypeWithDetail(plan.feeKind || plan.feeModel?.kind, plan.feeDisplay);

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onSelect}
      style={[styles.row, !last && styles.rowDivider, selected && { backgroundColor: c.primarySoft }]}
    >
      <View style={styles.rowTop}>
        <Radio selected={selected} styles={styles} c={c} />
        <View style={[styles.badgeTile, { backgroundColor: accent + '22' }]}>
          <Text style={[styles.badgeTileTxt, { color: accent }]}>{initialsOf(plan)}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.nameRow}>
            <Text style={styles.tierName} numberOfLines={1}>{plan.name}</Text>
            {plan.badge ? (
              <View style={[styles.tierBadge, { backgroundColor: accent }]}>
                <Text style={styles.tierBadgeTxt}>{plan.badge}</Text>
              </View>
            ) : null}
            {ownedCount > 0 ? (
              <View style={styles.ownedChip}>
                <Text style={styles.ownedChipTxt}>✓ {ownedCount} active</Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.tierDesc} numberOfLines={2}>{plan.description || '—'}</Text>
          <FeatureChips plan={plan} styles={styles} c={c} />
        </View>
      </View>

      <View style={styles.specGrid}>
        <SpecLite label="Min deposit" value={minDep > 0 ? `${minDep} USD` : 'No min'} styles={styles} />
        <SpecLite label="Max leverage" value={lev} styles={styles} />
        <SpecLite label="Commission" value={commission} styles={styles} />
      </View>
    </TouchableOpacity>
  );
}

function Section({ title, plans, selectedCode, onSelect, usage, styles, c }) {
  return (
    <View>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionCard}>
        {plans.map((p, i) => (
          <TierRow
            key={p._id || p.code}
            plan={p}
            selected={selectedCode === p.code}
            onSelect={() => onSelect(p.code)}
            ownedCount={usage[p.code] || 0}
            last={i === plans.length - 1}
            styles={styles}
            c={c}
          />
        ))}
      </View>
    </View>
  );
}

// ─── Screen ────────────────────────────────────────────────────────────────
export default function NewAccountTiersScreen({ navigation }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);

  const [plans, setPlans] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [selectedCode, setSelectedCode] = useState(null);

  useEffect(() => { navigation.setOptions({ title: 'Open account' }); }, [navigation]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, a] = await Promise.allSettled([
          api.get('/account-plans'),
          api.get('/user/accounts'),
        ]);
        if (cancelled) return;
        if (p.status === 'fulfilled') {
          const list = p.value.data.data || [];
          setPlans(list);
          // Default-select the first plan so Continue is immediately usable.
          if (list.length) setSelectedCode((prev) => prev || list[0].code);
        } else {
          setErr(errorMessage(p.reason));
        }
        if (a.status === 'fulfilled') setAccounts(a.value.data.data || []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Owned-count per account type — drives the "✓ N active" chips.
  const usage = useMemo(() => {
    const out = {};
    accounts.forEach((a) => { out[a.accountType] = (out[a.accountType] || 0) + 1; });
    return out;
  }, [accounts]);

  // Bucket the catalogue into named sections. Codes outside the canonical
  // set (e.g. legacy DEMO) fall into an "Other" group so they stay visible.
  const groups = useMemo(() => {
    const standard = [], professional = [], free = [], other = [];
    for (const p of plans) {
      if (p.code === 'STANDARD' || p.code === 'STANDARD_IC') standard.push(p);
      else if (p.code === 'PRO' || p.code === 'PRO_IC') professional.push(p);
      else if (p.code === 'FREE' || p.code === 'FREE_IC') free.push(p);
      else other.push(p);
    }
    return [
      { title: 'Standard accounts', plans: standard },
      { title: 'Professional accounts', plans: professional },
      { title: 'Free accounts', plans: free },
      ...(other.length ? [{ title: 'Other', plans: other }] : []),
    ].filter((g) => g.plans.length);
  }, [plans]);

  const continueToConfigure = () => {
    if (!selectedCode) return;
    navigation.navigate('NewAccountConfigure', { tierCode: selectedCode });
  };

  if (loading) return <Loader label="Loading account tiers…" />;
  if (groups.length === 0) {
    return <Empty title="No tiers available" sub={err || 'Ask an admin to enable some.'} />;
  }

  const selectedName = plans.find((p) => p.code === selectedCode)?.name || selectedCode;

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 22, paddingBottom: 28 }}>
        {groups.map((g) => (
          <Section
            key={g.title}
            title={g.title}
            plans={g.plans}
            selectedCode={selectedCode}
            onSelect={setSelectedCode}
            usage={usage}
            styles={styles}
            c={c}
          />
        ))}
      </ScrollView>

      {/* Sticky Continue bar */}
      <View style={styles.footer}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.footerTxt} numberOfLines={1}>
            {selectedCode ? <>Selected: <Text style={styles.footerStrong}>{selectedName}</Text></> : 'Pick an account type to continue'}
          </Text>
        </View>
        <TouchableOpacity
          activeOpacity={0.85}
          disabled={!selectedCode}
          onPress={continueToConfigure}
          style={[styles.continueBtn, !selectedCode && { opacity: 0.4 }]}
        >
          <Text style={styles.continueBtnTxt}>Continue →</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (c) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },

  // Section
  sectionTitle: { fontSize: 15, fontWeight: '900', color: c.textPrimary, marginBottom: 10 },
  sectionCard: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.xl, overflow: 'hidden' },

  // Tier row
  row: { paddingHorizontal: 14, paddingVertical: 14 },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  radio: { width: 20, height: 20, borderRadius: radius.pill, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  radioDot: { width: 7, height: 7, borderRadius: radius.pill, backgroundColor: c.white },
  badgeTile: { width: 44, height: 44, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  badgeTileTxt: { fontSize: 15, fontWeight: '900' },

  nameRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  tierName: { fontSize: 15, fontWeight: '900', color: c.textPrimary },
  tierBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  tierBadgeTxt: { fontSize: 9, fontWeight: '900', letterSpacing: 0.5, color: c.white, textTransform: 'uppercase' },
  ownedChip: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: c.bullSoft },
  ownedChipTxt: { fontSize: 9, fontWeight: '900', letterSpacing: 0.5, color: c.bull, textTransform: 'uppercase' },
  tierDesc: { fontSize: 12, color: c.textMuted, marginTop: 3, lineHeight: 17 },

  // Feature chips
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6 },
  chipDot: { width: 4, height: 4, borderRadius: 2, opacity: 0.7 },
  chipTxt: { fontSize: 10, fontWeight: '700' },

  // Spec grid
  specGrid: { flexDirection: 'row', gap: 10, marginTop: 12, paddingLeft: 32 },
  spec: { flex: 1, minWidth: 0 },
  specLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5, color: c.textMuted, textTransform: 'uppercase' },
  specValue: { fontSize: 12, fontWeight: '700', color: c.textPrimary, marginTop: 3, lineHeight: 16 },

  // Sticky footer
  footer: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 12,
    borderTopWidth: 1, borderTopColor: c.borderSubtle, backgroundColor: c.card,
  },
  footerTxt: { fontSize: 12, color: c.textMuted },
  footerStrong: { fontWeight: '900', color: c.textPrimary },
  continueBtn: { backgroundColor: c.primary500, paddingHorizontal: 20, paddingVertical: 12, borderRadius: radius.md },
  continueBtnTxt: { fontSize: 14, fontWeight: '900', color: c.white },
});
