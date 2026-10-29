import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { walletApi } from '@/api/wallet.api';
import {
  AppText,
  Badge,
  Button,
  Card,
  Input,
  LoadingView,
  Modal,
  Select,
  toast,
  useConfirm,
} from '@/components/ui';
import { useTheme } from '@/theme';
import type { DepositDetails, WithdrawalMethod } from '@/types/wallet';
import {
  REMOVE_METHOD_CONFIRM,
  addMethodProblem,
  addMethodTypes,
  buildAddMethodBody,
  methodLine,
  methodStatusStyle,
  noAddableRails,
  withdrawalFieldKey,
  type AddMethodType,
} from '@/utils/fundsFlows';

/**
 * Saved payout destinations — client/src/components/WithdrawalMethods.jsx.
 *
 * Add → the method starts PENDING (an admin verifies it). Only VERIFIED
 * methods can be selected for a withdrawal (enforced server-side). Removing
 * is a soft archive, so past withdrawal snapshots stay intact. The server
 * only ever returns MASKED destinations.
 *
 * The web opens this as a modal — from the wallet rail and from the
 * withdraw flow's "Manage" — and so does the app (`WithdrawalMethodsModal`).
 * `WithdrawalMethodsPanel` is the same content, for a screen that wants it
 * inline.
 */

export interface WithdrawalMethodsState {
  methods: WithdrawalMethod[];
  /** True until the first answer (or failure). */
  loading: boolean;
  /** The last load's failure; the previous list is kept. */
  error: unknown;
  reload: () => Promise<void>;
}

/** GET /withdrawal-methods, archived rows dropped. */
export function useWithdrawalMethods(): WithdrawalMethodsState {
  const [methods, setMethods] = useState<WithdrawalMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    try {
      const list = await walletApi.withdrawalMethods();
      if (!alive.current) return;
      setMethods(list);
      setError(null);
    } catch (e) {
      if (alive.current) setError(e);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => { alive.current = false; };
  }, [reload]);

  return { methods, loading, error, reload };
}

/* ══ The manager ══════════════════════════════════════════════════════ */

/**
 * The list (with Remove) and the Add form. `onChanged` runs after an add or
 * a removal, for a caller that holds its own copy of the list.
 */
export function WithdrawalMethodsPanel({
  onChanged,
  compact,
}: {
  onChanged?: () => void;
  /** Inside the modal: no own header (the modal has one). */
  compact?: boolean;
}): React.JSX.Element {
  const t = useTheme();
  const confirm = useConfirm();
  const [methods, setMethods] = useState<WithdrawalMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await walletApi.withdrawalMethods();
      if (alive.current) setMethods(list);
    } catch (e) {
      // The web toasts the failure and keeps what it had.
      toast.error(errorMessage(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
  }, [load]);

  const changed = (): void => {
    void load();
    onChanged?.();
  };

  const remove = async (m: WithdrawalMethod): Promise<void> => {
    const ok = await confirm({ message: REMOVE_METHOD_CONFIRM, confirmText: 'Remove', danger: true });
    if (!ok) return;
    try {
      await walletApi.removeWithdrawalMethod(m.id);
      toast.success('Withdrawal method removed');
      changed();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <View style={styles.panel}>
      {compact ? null : (
        <View>
          <AppText variant="h3" weight="700">Withdrawal Methods</AppText>
          <AppText variant="caption" tone="muted" style={styles.mt2}>
            {'Only '}
            <AppText variant="caption" weight="700" tone="muted">verified</AppText>
            {' methods can be used to withdraw. New methods are verified by our team.'}
          </AppText>
        </View>
      )}

      {loading ? <LoadingView label="Loading…" style={styles.loading} /> : null}
      {!loading && !adding && methods.length === 0 ? (
        <AppText variant="body" tone="muted" align="center" style={styles.empty}>
          No withdrawal methods yet. Add one to get started.
        </AppText>
      ) : null}

      {!adding ? methods.map((m) => {
        const st = methodStatusStyle(m.status);
        return (
          <View
            key={m.id}
            testID={`method-${m.id}`}
            style={[styles.methodRow, { borderColor: t.colors.borderDark, borderRadius: t.radius.xl }]}
          >
            <View style={styles.flex}>
              <View style={styles.inline}>
                <AppText variant="bodyStrong" numberOfLines={1} style={styles.shrink}>{m.label}</AppText>
                <Badge label={st.label} size="xs" tone={st.tone === 'warn' ? 'demo' : st.tone} />
              </View>
              <AppText variant="caption" tone="muted" mono style={styles.mt2}>{methodLine(m)}</AppText>
              {m.status === 'REJECTED' && m.rejectionReason ? (
                <AppText variant="micro" tone="bear" style={styles.mt2}>{`Reason: ${m.rejectionReason}`}</AppText>
              ) : null}
            </View>
            <Pressable
              onPress={() => { void remove(m); }}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${m.label}`}
              hitSlop={8}
            >
              <AppText variant="small" tone="bear" weight="600">Remove</AppText>
            </Pressable>
          </View>
        );
      }) : null}

      {adding ? (
        <AddMethodForm onCancel={() => setAdding(false)} onAdded={() => { setAdding(false); changed(); }} />
      ) : (
        <Button title="+ Add Withdrawal Method" onPress={() => setAdding(true)} fullWidth />
      )}
    </View>
  );
}

/** The manager as the web shows it: a modal. */
export function WithdrawalMethodsModal({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
}): React.JSX.Element {
  return (
    <Modal open={open} onClose={onClose} title="Withdrawal Methods" scrollable testID="withdrawal-methods-modal">
      <AppText variant="caption" tone="muted" style={styles.modalSub}>
        {'Only '}
        <AppText variant="caption" weight="700" tone="muted">verified</AppText>
        {' methods can be used to withdraw. New methods are verified by our team.'}
      </AppText>
      {open ? <WithdrawalMethodsPanel compact onChanged={onChanged} /> : null}
    </Modal>
  );
}

/**
 * The Wallet hub's inline version — kept for screens/wallet/views/
 * WithdrawalMethodsView, which re-exports it.
 */
export function WithdrawalMethodsView(): React.JSX.Element {
  return (
    <Card variant="plain" padded={16}>
      <WithdrawalMethodsPanel />
    </Card>
  );
}

/* ── Add ───────────────────────────────────────────────────────────── */

/** WithdrawalMethods.jsx AddForm. */
function AddMethodForm({ onCancel, onAdded }: { onCancel: () => void; onAdded: () => void }): React.JSX.Element {
  const t = useTheme();
  const [typeId, setTypeId] = useState('BANK');
  const [label, setLabel] = useState('');
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: string): void => setForm((f) => ({ ...f, [k]: v }));

  // Which rails the admin allows for payouts. A failed read offers the
  // built-ins rather than an empty form, as on the web.
  const [details, setDetails] = useState<DepositDetails | null>(null);
  const [detailsLoaded, setDetailsLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    walletApi.depositDetails()
      .then((d) => { if (live) { setDetails(d); setDetailsLoaded(true); } })
      .catch(() => { if (live) { setDetails(null); setDetailsLoaded(true); } });
    return () => { live = false; };
  }, []);

  const types = useMemo(() => addMethodTypes(details), [details]);
  const type: AddMethodType | null = types.find((x) => x.id === typeId) ?? null;

  // Keep the selection legal once the config arrives — the default BANK may
  // itself be closed for withdrawals.
  const typesKey = types.map((x) => x.id).join(',');
  useEffect(() => {
    if (!detailsLoaded) return;
    if (types.length && !types.some((x) => x.id === typeId)) setTypeId(types[0]?.id ?? 'BANK');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailsLoaded, typesKey, typeId]);

  const submit = async (): Promise<void> => {
    const problem = addMethodProblem(label);
    if (problem) { toast.error(problem); return; }
    if (!type) return;
    setSaving(true);
    try {
      await walletApi.addWithdrawalMethod(buildAddMethodBody(type, label, form));
      toast.success('Method added — pending verification');
      onAdded();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.form}>
      <View style={styles.typeRow}>
        {types.map((x) => {
          const on = x.id === typeId;
          return (
            <Pressable
              key={x.id}
              onPress={() => setTypeId(x.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              style={[
                styles.typeChip,
                {
                  borderColor: on ? t.colors.primary : t.colors.borderDark,
                  backgroundColor: on ? t.alpha(t.colors.primary, 0.1) : 'transparent',
                  borderRadius: t.radius.lg,
                },
              ]}
            >
              <AppText variant="caption" weight="700" color={on ? t.colors.primaryText : t.colors.textSecondary} numberOfLines={1}>
                {x.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
      {noAddableRails(details) ? (
        <AppText variant="small" tone="muted">No withdrawal methods are available right now. Please contact support.</AppText>
      ) : null}

      <Input label="Label *" placeholder="e.g. HDFC Salary" value={label} onChangeText={setLabel} />

      {typeId === 'BANK' ? (
        <>
          <Input
            label="Account holder name *"
            placeholder="Full name as on bank account"
            value={form.accountHolderName ?? ''}
            onChangeText={(v) => set('accountHolderName', v)}
            autoCapitalize="words"
          />
          <Input
            label="Bank name"
            placeholder="e.g. HDFC Bank"
            value={form.bankName ?? ''}
            onChangeText={(v) => set('bankName', v)}
            autoCapitalize="words"
          />
          <Input
            label="Account number *"
            placeholder="e.g. 50100123456789"
            value={form.accountNumber ?? ''}
            onChangeText={(v) => set('accountNumber', v.replace(/\s/g, ''))}
            keyboardType="number-pad"
            mono
          />
          <Input
            label="IFSC *"
            placeholder="HDFC0001234"
            value={form.ifsc ?? ''}
            onChangeText={(v) => set('ifsc', v.toUpperCase())}
            maxLength={11}
            autoCapitalize="characters"
            autoCorrect={false}
            mono
          />
        </>
      ) : null}
      {typeId === 'UPI' ? (
        <Input
          label="UPI ID *"
          placeholder="yourname@bank"
          value={form.upiId ?? ''}
          onChangeText={(v) => set('upiId', v)}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          mono
        />
      ) : null}
      {/* An admin-defined rail: one input per field the admin asked for. */}
      {type && !type.native ? type.schema.map((f) => {
        const k = withdrawalFieldKey(f);
        return (
          <Input
            key={k}
            label={`${f.label}${f.required !== false ? ' *' : ''}`}
            placeholder={f.placeholder || f.label}
            value={form[k] ?? ''}
            onChangeText={(v) => set(k, v)}
            autoCapitalize="none"
            autoCorrect={false}
            mono
          />
        );
      }) : null}

      <View style={styles.formButtons}>
        <Button title="Cancel" variant="secondary" onPress={onCancel} style={styles.flex} />
        <Button title={saving ? 'Saving…' : 'Add method'} onPress={() => { void submit(); }} disabled={saving} style={styles.flex} />
      </View>
    </View>
  );
}

/* ══ Choosing a verified destination ══════════════════════════════════ */

/**
 * The verified destinations on one rail, as radio rows — the withdraw
 * flow's Destination step and WithdrawModal's "Withdraw to". The caller
 * filters (`verifiedForRail`) and owns the selection.
 */
export function VerifiedDestinationList({
  destinations,
  value,
  onChange,
  emoji,
}: {
  destinations: readonly WithdrawalMethod[];
  value: string;
  onChange: (id: string) => void;
  /** WithdrawModal shows the rail's emoji on each row. */
  emoji?: string;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={styles.pickList}>
      {destinations.map((m) => {
        const on = value === m.id;
        return (
          <Pressable
            key={m.id}
            testID={`destination-${m.id}`}
            onPress={() => onChange(m.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={m.label}
            style={({ pressed }) => [
              styles.pickRow,
              {
                borderColor: on ? t.colors.primary : t.colors.borderDark,
                backgroundColor: on ? t.alpha(t.colors.primary, 0.05) : pressed ? t.colors.bgHover : 'transparent',
                borderRadius: t.radius.xl,
              },
            ]}
          >
            {emoji ? (
              <AppText style={styles.emoji}>{emoji}</AppText>
            ) : (
              <View style={[styles.radio, { borderColor: on ? t.colors.primary : t.colors.borderDark }]}>
                {on ? <View style={[styles.radioDot, { backgroundColor: t.colors.primary }]} /> : null}
              </View>
            )}
            <View style={styles.flex}>
              <View style={styles.inline}>
                <AppText variant="bodyStrong" numberOfLines={1} style={styles.shrink}>{m.label}</AppText>
                <Badge label="Verified" tone="bull" size="xs" />
              </View>
              <AppText variant="caption" tone="muted" mono numberOfLines={1} style={styles.mt2}>{m.masked}</AppText>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A select of verified destinations, for a compact form. */
export function VerifiedDestinationSelect({
  destinations,
  value,
  onChange,
  label,
}: {
  destinations: readonly WithdrawalMethod[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}): React.JSX.Element {
  return (
    <Select
      label={label}
      value={value}
      options={destinations.map((m) => ({ value: m.id, label: m.label, description: m.masked }))}
      onChange={onChange}
    />
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mt2: { marginTop: 2 },
  panel: { gap: 12 },
  modalSub: { marginBottom: 12 },
  loading: { minHeight: 80 },
  empty: { paddingVertical: 24 },
  methodRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 12 },
  form: { gap: 12 },
  typeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  typeChip: { flexGrow: 1, flexBasis: '30%', borderWidth: 1, paddingVertical: 8, paddingHorizontal: 8, alignItems: 'center' },
  formButtons: { flexDirection: 'row', gap: 8, paddingTop: 4 },
  pickList: { gap: 8 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 2, paddingHorizontal: 12, paddingVertical: 10 },
  emoji: { fontSize: 20, lineHeight: 24 },
  radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 8, height: 8, borderRadius: 4 },
});
