import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View, type TextInput } from 'react-native';

import { createPriceAlert, validatePriceAlert } from '@/api/alerts.api';
import { errorMessage } from '@/api/client';
import {
  AppText,
  AssetIcon,
  BottomSheet,
  Button,
  Checkbox,
  Icon,
  Input,
  Modal,
  Select,
  toast,
} from '@/components/ui';
import { useTheme } from '@/theme';
import type { AlertDirection } from '@/types/market';
import type { Instrument } from '@/types/trading';

import {
  DIRECTION_OPTIONS,
  alertInput,
  filterAlertSymbols,
  hasPrice,
  initialAlertForm,
  noSymbolsMessage,
  rawPrice,
  sanitizePriceInput,
  shownPrice,
  submittableForm,
  type AlertForm,
} from './createAlertLogic';

export interface CreateAlertModalProps {
  visible: boolean;
  /** The catalogue the symbol picker offers (and whose prices it shows). */
  instruments: Instrument[];
  /** Preselect this symbol instead of the first instrument. */
  initialSymbol?: string;
  onClose: () => void;
  /** After a successful create. Without it the modal just closes. */
  onCreated?: () => void;
}

/**
 * New Price Alert — client/src/components/CreateAlertModal.jsx, shared by the
 * Price Alerts screen and the notification bell's "+ Price alert" action.
 * Posts to /reports/alerts.
 *
 * Symbol (a searchable picker with each symbol's icon and price), the
 * selected instrument's current price with Copy and "Use as target →",
 * Direction, Target Price, an optional Note and "Repeatable". The form
 * starts fresh each time it opens.
 */
export function CreateAlertModal({
  visible,
  instruments,
  initialSymbol,
  onClose,
  onCreated,
}: CreateAlertModalProps): React.JSX.Element {
  const t = useTheme();
  const [form, setForm] = useState<AlertForm>(() => initialAlertForm(instruments, initialSymbol));
  const [loading, setLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // The web mounts a new modal per open; this one is kept mounted, so each
  // open starts from a fresh form (on the list as it is at that moment).
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      setForm(initialAlertForm(instruments, initialSymbol));
      setLoading(false);
      setPickerOpen(false);
    }
    wasVisible.current = visible;
  }, [visible, instruments, initialSymbol]);

  const selected = useMemo(
    () => instruments.find((i) => i.symbol === form.symbol) ?? null,
    [instruments, form.symbol],
  );

  const copyPrice = async (): Promise<void> => {
    if (!hasPrice(selected)) return;
    try {
      await Clipboard.setStringAsync(rawPrice(selected));
      toast.success('Price copied');
    } catch {
      toast.error('Could not copy');
    }
  };

  const submit = async (): Promise<void> => {
    if (loading) return;
    const problem = validatePriceAlert(submittableForm(form));
    if (problem) { toast.error(problem); return; }
    setLoading(true);
    try {
      await createPriceAlert(alertInput(form));
      toast.success('Alert created');
      if (onCreated) onCreated(); else onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open={visible}
      onClose={onClose}
      title="New Price Alert"
      size="md"
      footer={(
        <View style={styles.footer}>
          <Button title="Cancel" variant="secondary" onPress={onClose} style={styles.flex} />
          <Button
            title="Create alert"
            loading={loading}
            loadingTitle="Creating…"
            onPress={() => { void submit(); }}
            style={styles.flex}
          />
        </View>
      )}
    >
      <View style={styles.body}>
        <View>
          <AppText variant="label" style={styles.label}>Symbol</AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Symbol"
            accessibilityState={{ expanded: pickerOpen }}
            onPress={() => setPickerOpen(true)}
            style={[
              styles.trigger,
              {
                backgroundColor: t.colors.inputBg,
                borderColor: pickerOpen ? t.colors.primary : t.colors.borderDark,
                borderRadius: t.radius.lg,
              },
            ]}
          >
            <View style={styles.triggerText}>
              {form.symbol ? (
                <>
                  <AppText variant="bodyStrong" numberOfLines={1}>{form.symbol}</AppText>
                  {hasPrice(selected) ? (
                    <AppText variant="body" tone="muted" mono numberOfLines={1}>{`(${shownPrice(selected)})`}</AppText>
                  ) : null}
                </>
              ) : (
                <AppText variant="body" tone="muted">Select symbol</AppText>
              )}
            </View>
            <Icon name="chevronDown" size={14} color={t.colors.textMuted} />
          </Pressable>

          {selected ? (
            <View style={styles.priceRow}>
              <AppText variant="small" tone="muted">Current price</AppText>
              <AppText variant="smallStrong" mono>{shownPrice(selected)}</AppText>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Copy price"
                onPress={() => { void copyPrice(); }}
                style={({ pressed }) => [styles.mini, { borderRadius: t.radius.md, backgroundColor: pressed ? t.colors.primarySoft : 'transparent' }]}
                hitSlop={4}
              >
                <Icon name="copy" size={12} color={t.colors.textMuted} />
                <AppText variant="small" tone="muted">Copy</AppText>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => setForm((f) => ({ ...f, targetPrice: rawPrice(selected) }))}
                style={({ pressed }) => [styles.mini, { borderRadius: t.radius.md, backgroundColor: pressed ? t.colors.primarySoft : 'transparent' }]}
                hitSlop={4}
              >
                <AppText variant="smallStrong" color={t.colors.primaryText}>Use as target →</AppText>
              </Pressable>
            </View>
          ) : null}
        </View>

        <View style={styles.pair}>
          <Select<AlertDirection>
            label="Direction"
            style={styles.flex}
            value={form.direction}
            onChange={(direction) => setForm((f) => ({ ...f, direction }))}
            options={DIRECTION_OPTIONS.map((o) => ({ ...o }))}
          />
          <Input
            label="Target Price"
            value={form.targetPrice}
            onChangeText={(v) => setForm((f) => ({ ...f, targetPrice: sanitizePriceInput(v) }))}
            keyboardType="decimal-pad"
            containerStyle={styles.flex}
            mono
          />
        </View>

        <Input
          label="Note (optional)"
          value={form.note}
          onChangeText={(note) => setForm((f) => ({ ...f, note }))}
          placeholder="e.g. resistance breakout"
        />

        <Checkbox
          label="Repeatable (re-arm after each trigger)"
          value={form.repeatable}
          onValueChange={(repeatable) => setForm((f) => ({ ...f, repeatable }))}
        />
      </View>

      <SymbolPicker
        open={pickerOpen}
        instruments={instruments}
        value={form.symbol}
        onPick={(symbol) => { setForm((f) => ({ ...f, symbol })); setPickerOpen(false); }}
        onClose={() => setPickerOpen(false)}
      />
    </Modal>
  );
}

/**
 * SymbolCombobox — the web's searchable dropdown as a sheet over the modal:
 * type to filter by symbol or name, each row with its icon and price; the
 * keyboard's return key picks the first match (the web's Enter).
 */
function SymbolPicker({ open, instruments, value, onPick, onClose }: {
  open: boolean;
  instruments: Instrument[];
  value: string;
  onPick: (symbol: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const [q, setQ] = useState('');
  const inputRef = useRef<TextInput>(null);
  const filtered = useMemo(() => filterAlertSymbols(instruments, q), [instruments, q]);

  useEffect(() => { if (!open) setQ(''); }, [open]);

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Symbol"
      scrollable={false}
      bodyPadding={0}
      initialFocus={inputRef}
    >
      <View style={[styles.search, { borderBottomColor: t.colors.borderSubtle }]}>
        <Input
          ref={inputRef}
          value={q}
          onChangeText={setQ}
          placeholder="Search symbol…"
          autoCorrect={false}
          autoCapitalize="characters"
          returnKeyType="done"
          onSubmitEditing={() => { const first = filtered[0]; if (first) onPick(first.symbol); }}
          left={<Icon name="search" size={16} color={t.colors.textMuted} />}
        />
      </View>
      <FlatList
        data={filtered}
        keyExtractor={(i) => i.symbol}
        keyboardShouldPersistTaps="handled"
        style={styles.list}
        initialNumToRender={20}
        ListEmptyComponent={(
          <AppText variant="body" tone="muted" align="center" style={styles.empty}>{noSymbolsMessage(q)}</AppText>
        )}
        renderItem={({ item }) => {
          const active = item.symbol === value;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => onPick(item.symbol)}
              style={({ pressed }) => [
                styles.option,
                { backgroundColor: active ? t.colors.primarySoft : pressed ? t.colors.bgHover : 'transparent' },
              ]}
            >
              <AssetIcon row={item} size={22} round />
              <AppText variant="bodyStrong" numberOfLines={1} style={styles.flex}>{item.symbol}</AppText>
              {hasPrice(item) ? <AppText variant="body" tone="muted" mono>{shownPrice(item)}</AppText> : null}
            </Pressable>
          );
        }}
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  body: { gap: 12 },
  label: { marginBottom: 6 },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    minHeight: 42,
  },
  triggerText: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
  priceRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  mini: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 2 },
  pair: { flexDirection: 'row', gap: 12 },
  footer: { flexDirection: 'row', gap: 8 },
  search: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1 },
  list: { flexGrow: 0 },
  empty: { paddingVertical: 16, paddingHorizontal: 12 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
});
