import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText, BottomSheet, Button, Input } from '@/components/ui';
import { useTheme } from '@/theme';
import {
  DATE_FILTER_PRESETS,
  canApplyCustom,
  computeRange,
  customButtonLabel,
  rangeFromStored,
  reversedRangeError,
  sanitizeDateInput,
  typedDateError,
  type DatePeriod,
  type DateRange,
} from '@/utils/dateFilter';

/**
 * The global date-range filter — [ Today ] [ 7 Days ] [ 30 Days ] [ Custom ]
 * — ported from client/src/components/DateFilter.jsx (logic in
 * utils/dateFilter.ts).
 *
 * Every preset resolves to a concrete local-day range. Custom opens a sheet
 * with a start and an end date and Apply / Cancel (the web's popover); the
 * active choice stays highlighted and a chosen custom range shows on its
 * button. The web's date inputs are native pickers; here the dates are typed
 * YYYY-MM-DD, so an impossible day or a reversed pair is caught before Apply
 * (the web's `min` / `max` stop the reversed pair in its picker).
 */
export function DateFilter({ value, onChange }: {
  value: DateRange;
  onChange: (range: DateRange) => void;
}): React.JSX.Element {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(value.fromDate || '');
  const [draftTo, setDraftTo] = useState(value.toDate || '');

  const pick = (period: Exclude<DatePeriod, 'custom'>): void => {
    setOpen(false);
    onChange(computeRange(period));
  };
  const openCustom = (): void => {
    setDraftFrom(value.fromDate || '');
    setDraftTo(value.toDate || '');
    setOpen(true);
  };
  const applyable = canApplyCustom(draftFrom, draftTo);
  const apply = (): void => {
    if (!applyable) return;
    onChange({ period: 'custom', fromDate: draftFrom.trim(), toDate: draftTo.trim() });
    setOpen(false);
  };

  const isCustom = value.period === 'custom';
  const reversed = reversedRangeError(draftFrom, draftTo);

  const chip = (key: string, label: string, active: boolean, onPress: () => void): React.JSX.Element => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          borderRadius: t.radius.lg,
          borderColor: active || pressed ? t.colors.primary : t.colors.borderDark,
          backgroundColor: active ? t.colors.primarySoft : 'transparent',
        },
      ]}
    >
      <AppText variant="small" weight="700" color={active ? t.colors.primaryText : t.colors.textSecondary} numberOfLines={1}>
        {label}
      </AppText>
    </Pressable>
  );

  return (
    <View style={styles.row}>
      {DATE_FILTER_PRESETS.map((p) => chip(p.key, p.label, value.period === p.key, () => pick(p.key)))}
      {chip('custom', `${customButtonLabel(value)}${isCustom ? '' : ' ▾'}`, isCustom, openCustom)}

      <BottomSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Custom range"
        footer={(
          <View style={styles.footer}>
            <Button title="Cancel" variant="ghost" size="sm" onPress={() => setOpen(false)} />
            <Button title="Apply" size="sm" disabled={!applyable} onPress={apply} />
          </View>
        )}
      >
        <View style={styles.fields}>
          <Input
            label="Start date"
            value={draftFrom}
            onChangeText={(v) => setDraftFrom(sanitizeDateInput(v))}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
            maxLength={10}
            autoCorrect={false}
            autoCapitalize="none"
            error={typedDateError(draftFrom)}
            mono
          />
          <Input
            label="End date"
            value={draftTo}
            onChangeText={(v) => setDraftTo(sanitizeDateInput(v))}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
            maxLength={10}
            autoCorrect={false}
            autoCapitalize="none"
            error={typedDateError(draftTo) ?? reversed}
            mono
          />
        </View>
      </BottomSheet>
    </View>
  );
}

/**
 * DateFilter.jsx `useDateFilter(storageKey, defaultPeriod)` — a range that
 * survives a restart. A saved CUSTOM range comes back as saved; a saved
 * preset is re-computed against today (a "7 Days" chosen last week means the
 * last seven days now). The web reads localStorage synchronously; storage is
 * asynchronous here, so the first frame shows the default and the saved
 * choice lands a moment later — unless the trader has already picked one,
 * which wins.
 */
export function useDateFilter(
  storageKey: string | null,
  defaultPeriod: string | null = '7d',
): [DateRange, (range: DateRange) => void] {
  const [range, setRange] = useState<DateRange>(() => computeRange(defaultPeriod));
  const touched = useRef(false);

  useEffect(() => {
    if (!storageKey) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(storageKey);
        if (cancelled || touched.current || raw == null) return;
        setRange(rangeFromStored(JSON.parse(raw) as unknown, defaultPeriod));
      } catch { /* unreadable: keep the default */ }
    })();
    return () => { cancelled = true; };
  }, [storageKey, defaultPeriod]);

  const set = useCallback((r: DateRange) => {
    touched.current = true;
    setRange(r);
    if (storageKey) {
      AsyncStorage.setItem(storageKey, JSON.stringify(r)).catch(() => { /* quota */ });
    }
  }, [storageKey]);

  return [range, set];
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  chip: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6 },
  fields: { gap: 12 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
