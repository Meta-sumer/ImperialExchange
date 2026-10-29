import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { accountApi } from '@/api/account.api';
import { errorMessage } from '@/api/client';
import { WalletNav } from '@/components/wallet/WalletNav';
import { AppText, Button, Card, ErrorView, Icon, Screen, toast } from '@/components/ui';
import type { AppScreenProps } from '@/navigation';
import { useSelectedAccountStore } from '@/store/selectedAccount';
import { alpha, useTheme } from '@/theme';
import type { AccountPlanDetail } from '@/types/user';
import {
  defaultTierSelection,
  groupTiers,
  tierAccent,
  tierCommission,
  tierFeatureChips,
  tierInitials,
  tierLeverageLabel,
  tierMinDepositLabel,
  usageByType,
  type FeatureChip,
} from '@/utils/plans';

/**
 * client/src/pages/NewAccountTiers.jsx — `/accounts/new`, page 1 of the
 * new-account flow: the tier catalogue (/account-plans) grouped into
 * Standard / Professional / Free / Other, each row radio-selectable with its
 * minimum deposit, leverage cap and commission, and how many accounts the
 * user already holds on it. Continue → NewAccountConfigure.
 *
 * Phone layout is the web's own `md:hidden` stacked row; from 768dp the
 * desktop row with its column header. WalletSidebar is the WalletNav pill
 * rail, as the web shows it under `lg`.
 *
 * No "Contract specifications" link: the web's was a dead placeholder
 * (`href="#"`) and has been removed there too.
 *
 * Differs from the web: a failed catalogue load shows the server's error
 * with a retry, where the web (Promise.allSettled) fell through to "No tiers
 * available", which blamed the admin for a network error.
 */
export function NewAccountTiersScreen({ navigation }: AppScreenProps<'NewAccountTiers'>): React.JSX.Element {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= 768;

  // The user's accounts come from the shared store (CONTRACT §8); it is
  // asked to refresh on mount, as the web fetched /user/accounts here.
  const accounts = useSelectedAccountStore((s) => s.accounts);
  const [plans, setPlans] = useState<AccountPlanDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);

  // Set in the setup too: StrictMode / Fast Refresh replay cleanup + setup,
  // and a ref that only ever goes false would drop every later response.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Whether a catalogue is on screen. A failed first load is told by the
  // ErrorView; only a failed refresh (catalogue still showing, no ErrorView)
  // needs the toast — otherwise the same message showed twice.
  const hasCatalogue = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    const [p] = await Promise.allSettled([
      accountApi.listPlans(),
      useSelectedAccountStore.getState().load(),
    ]);
    if (!mounted.current) return;
    if (p.status === 'fulfilled') {
      hasCatalogue.current = p.value.length > 0;
      setPlans(p.value);
      setLoadError(null);
      // Default-select the first plan so Continue is usable at once.
      setSelectedCode((cur) => defaultTierSelection(p.value, cur));
    } else {
      setLoadError(p.reason);
      if (hasCatalogue.current) toast.error(errorMessage(p.reason));
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const usage = useMemo(() => usageByType(accounts), [accounts]);
  const groups = useMemo(() => groupTiers(plans), [plans]);
  const selectedPlan = plans.find((p) => p.code === selectedCode);

  const continueToConfigure = (): void => {
    if (!selectedCode) return;
    navigation.navigate('NewAccountConfigure', { tierCode: selectedCode });
  };

  const showBar = !loading && plans.length > 0;

  return (
    <View style={styles.flex}>
      <Screen onRefresh={load}>
        <WalletNav activeId={null} />

        {/* Header row */}
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={() => navigation.navigate('Wallet', undefined, { pop: true })}
            style={({ pressed }) => [
              styles.back,
              { borderColor: t.colors.borderDark, backgroundColor: pressed ? t.colors.bgHover : 'transparent' },
            ]}
          >
            <Icon name="arrowLeft" size={16} color={t.colors.textSecondary} strokeWidth={2} />
          </Pressable>
          <AppText variant="display" weight="800" accessibilityRole="header">Open account</AppText>
        </View>

        {loading && !plans.length ? (
          <AppText variant="body" tone="muted" style={styles.loading}>Loading account tiers…</AppText>
        ) : loadError && !plans.length ? (
          <ErrorView error={loadError} onRetry={() => { setLoading(true); void load(); }} />
        ) : groups.length === 0 ? (
          <Card padded={48}>
            <AppText variant="body" tone="muted" align="center">No tiers available. Ask an admin to enable some.</AppText>
          </Card>
        ) : (
          groups.map((g) => (
            <View key={g.title} style={styles.section}>
              <AppText variant="title" weight="800" style={styles.sectionTitle}>{g.title}</AppText>
              <Card padded={false} style={styles.clip}>
                {wide ? (
                  <View style={[styles.colHead, { borderBottomColor: t.colors.borderSubtle, backgroundColor: alpha(t.colors.bgHover, 0.3) }]}>
                    <View style={styles.radioCol} />
                    <View style={styles.tileCol} />
                    <View style={styles.flex} />
                    <AppText variant="caption" tone="muted" weight="700" style={[styles.upper, styles.minCol]}>Min deposit</AppText>
                    <AppText variant="caption" tone="muted" weight="700" style={[styles.upper, styles.levCol]}>Max leverage</AppText>
                    <AppText variant="caption" tone="muted" weight="700" style={[styles.upper, styles.feeCol]}>Commission</AppText>
                  </View>
                ) : null}
                {g.plans.map((p, i) => (
                  <TierRow
                    key={p.id || p.code}
                    plan={p}
                    wide={wide}
                    selected={selectedCode === p.code}
                    onSelect={() => setSelectedCode(p.code)}
                    ownedCount={usage[p.code] ?? 0}
                    divider={i > 0}
                  />
                ))}
              </Card>
            </View>
          ))
        )}

        {/* Room for the floating Continue bar — the web's pb-24. */}
        {showBar ? <View style={styles.barSpace} /> : null}
      </Screen>

      {showBar ? (
        <View pointerEvents="box-none" style={[styles.barWrap, { bottom: 16 + insets.bottom }]}>
          <Card style={[styles.bar, t.shadow.elevated, { backgroundColor: alpha(t.colors.surface, 0.95) }]} padded={12}>
            <AppText variant="small" tone="muted" numberOfLines={1} style={styles.flex}>
              {selectedCode ? (
                <>Selected: <AppText variant="small" weight="700">{selectedPlan?.name || selectedCode}</AppText></>
              ) : 'Pick an account type to continue'}
            </AppText>
            <Button title="Continue →" disabled={!selectedCode} onPress={continueToConfigure} />
          </Card>
        </View>
      ) : null}
    </View>
  );
}

/* ── One tier row ─────────────────────────────────────────────────── */

function TierRow({
  plan,
  wide,
  selected,
  onSelect,
  ownedCount,
  divider,
}: {
  plan: AccountPlanDetail;
  wide: boolean;
  selected: boolean;
  onSelect: () => void;
  ownedCount: number;
  divider: boolean;
}): React.JSX.Element {
  const t = useTheme();
  const accent = tierAccent(plan);
  const minDep = tierMinDepositLabel(plan);
  const lev = tierLeverageLabel(plan.maxLeverage);
  const commission = tierCommission(plan);
  const initials = tierInitials(plan);

  const radio = (
    <View
      style={[
        styles.radio,
        selected
          ? { borderColor: t.colors.primaryPressed, backgroundColor: t.colors.primaryPressed }
          : { borderColor: t.colors.borderDark, backgroundColor: t.colors.surface },
      ]}
    >
      {selected ? <View style={styles.radioDot} /> : null}
    </View>
  );
  const tile = (size: number, font: number): React.JSX.Element => (
    <View style={[styles.tile, { width: size, height: size, backgroundColor: tint(accent, 0.1) ?? t.colors.bgHover }, t.shadow.card]}>
      <AppText weight="800" color={accent} style={{ fontSize: font, lineHeight: font + 4 }}>{initials}</AppText>
    </View>
  );

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={plan.name}
      onPress={onSelect}
      style={({ pressed }) => [
        divider ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.borderSubtle } : null,
        { backgroundColor: selected ? alpha(t.colors.primary, 0.06) : pressed ? t.colors.bgHover : 'transparent' },
      ]}
    >
      {wide ? (
        <View style={styles.wideRow}>
          <View style={styles.radioCol}>{radio}</View>
          <View style={styles.tileCol}>{tile(48, 16)}</View>
          <View style={styles.flex}>
            <View style={styles.nameRow}>
              <AppText variant="title" weight="800">{plan.name}</AppText>
              {plan.badge ? <SolidChip label={plan.badge} color={accent} /> : null}
              {ownedCount > 0 ? <OwnedChip label={`✓ ${ownedCount} active`} /> : null}
            </View>
            <AppText variant="small" tone="muted" numberOfLines={2} style={styles.mt2}>{plan.description || '—'}</AppText>
            <FeatureChips chips={tierFeatureChips(plan)} />
          </View>
          <AppText variant="bodyStrong" mono numberOfLines={1} style={styles.minCol}>{minDep}</AppText>
          <AppText variant="bodyStrong" mono numberOfLines={1} style={styles.levCol}>{lev}</AppText>
          <AppText variant="bodyStrong" tone="secondary" style={styles.feeCol}>{commission}</AppText>
        </View>
      ) : (
        <View style={styles.phoneRow}>
          <View style={styles.phoneTop}>
            {radio}
            {tile(44, 14)}
            <View style={styles.flex}>
              <View style={styles.nameRow}>
                <AppText variant="bodyStrong" weight="800">{plan.name}</AppText>
                {ownedCount > 0 ? <OwnedChip label={`✓ ${ownedCount}`} /> : null}
              </View>
              <AppText variant="caption" tone="muted" numberOfLines={2} style={styles.mt2}>{plan.description || '—'}</AppText>
              <FeatureChips chips={tierFeatureChips(plan)} compact />
            </View>
          </View>
          <View style={styles.specs}>
            <SpecLite label="Min deposit" value={minDep} />
            <SpecLite label="Max leverage" value={lev} />
            <SpecLite label="Commission" value={commission} />
          </View>
        </View>
      )}
    </Pressable>
  );
}

function FeatureChips({ chips, compact }: { chips: FeatureChip[]; compact?: boolean }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={styles.chips}>
      {chips.map((c, i) => {
        const tone = c.tone === 'warn'
          ? { border: alpha(t.colors.warn, 0.3), bg: alpha(t.colors.warn, 0.1), fg: t.colors.warn }
          : c.tone === 'bull'
            ? { border: alpha(t.colors.bull, 0.3), bg: alpha(t.colors.bull, 0.1), fg: t.colors.bull }
            : { border: t.colors.borderSubtle, bg: t.colors.bgHover, fg: t.colors.textSecondary };
        return (
          // By position, as the web keys them: the labels are admin-written
          // (instruments / access / support) and may repeat.
          // eslint-disable-next-line react/no-array-index-key
          <View key={i} style={[styles.chip, { borderColor: tone.border, backgroundColor: tone.bg }]}>
            <View style={[styles.chipDot, { backgroundColor: tone.fg }]} />
            <AppText weight="600" color={tone.fg} style={compact ? styles.chipTextCompact : styles.chipText}>{c.label}</AppText>
          </View>
        );
      })}
    </View>
  );
}

function OwnedChip({ label }: { label: string }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[styles.micro, { backgroundColor: alpha(t.colors.bull, 0.15) }]}>
      <AppText weight="800" color={t.colors.bull} style={styles.microText}>{label}</AppText>
    </View>
  );
}

function SolidChip({ label, color }: { label: string; color: string }): React.JSX.Element {
  return (
    <View style={[styles.micro, { backgroundColor: color }]}>
      <AppText weight="800" color="#FFFFFF" style={styles.microText}>{label}</AppText>
    </View>
  );
}

function SpecLite({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.spec}>
      <AppText weight="700" tone="muted" style={[styles.microText, styles.upper]}>{label}</AppText>
      <AppText variant="small" weight="600" style={styles.mt2}>{value}</AppText>
    </View>
  );
}

/** `${accent}22` — only a #RRGGBB accent can take an alpha suffix. */
const tint = (color: string, a: number): string | null =>
  (/^#[0-9a-f]{6}$/i.test(color) ? alpha(color, a) : null);

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  upper: { textTransform: 'uppercase', letterSpacing: 0.8 },
  mt2: { marginTop: 2 },
  clip: { overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 8, marginTop: 16, marginBottom: 24 },
  back: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  loading: { paddingHorizontal: 8, paddingVertical: 32 },
  section: { marginBottom: 24 },
  sectionTitle: { marginBottom: 12, paddingHorizontal: 4 },
  colHead: { flexDirection: 'row', alignItems: 'center', gap: 20, paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1 },
  radioCol: { width: 20 },
  tileCol: { width: 48 },
  minCol: { width: 120 },
  levCol: { width: 140 },
  feeCol: { width: 220 },
  wideRow: { flexDirection: 'row', alignItems: 'center', gap: 20, paddingHorizontal: 20, paddingVertical: 16 },
  phoneRow: { paddingHorizontal: 16, paddingVertical: 16 },
  phoneTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#FFFFFF' },
  tile: { borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  chipDot: { width: 4, height: 4, borderRadius: 2, opacity: 0.6 },
  chipText: { fontSize: 10, lineHeight: 14 },
  chipTextCompact: { fontSize: 9.5, lineHeight: 13 },
  micro: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  microText: { fontSize: 9, lineHeight: 12, letterSpacing: 0.6, textTransform: 'uppercase' },
  specs: { flexDirection: 'row', gap: 8, marginTop: 12 },
  spec: { flex: 1, minWidth: 0 },
  barSpace: { height: 96 },
  barWrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  bar: { width: '100%', maxWidth: 640, flexDirection: 'row', alignItems: 'center', gap: 12 },
});
