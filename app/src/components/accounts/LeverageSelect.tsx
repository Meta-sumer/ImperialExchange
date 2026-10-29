import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { AppText, BottomSheet, Icon } from '@/components/ui';
import { useTheme } from '@/theme';
import {
  LEVERAGE_OPTIONS,
  UNLIMITED_LEVERAGE,
  clampCustomLeverage,
  isLeverageLocked,
  isLeverageOptionSelected,
  leverageCap,
  leverageDisplay,
  leverageOptionLabel,
  leverageSnapTarget,
  type LeverageOption,
} from '@/utils/plans';

/**
 * client/src/components/LeverageDropdown.jsx: the canonical leverage ladder
 * with everything above the tier's cap faded and locked, a Custom option
 * that opens an inline numeric field, and 1:Unlimited (999999).
 *
 * The web's floating dropdown becomes a bottom sheet; ESC / outside-click
 * closing becomes the sheet's backdrop, swipe and back button.
 *
 *   value        current leverage — 999999 is "1:Unlimited"
 *   onChange     receives the new leverage
 *   maxLeverage  the tier cap; null (or 0 / NaN / negative) = no cap
 */
export function LeverageSelect({
  value,
  onChange,
  maxLeverage,
}: {
  value: number;
  onChange: (n: number) => void;
  maxLeverage: number | null | undefined;
}): React.JSX.Element {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  // What the Custom field shows while it is being typed in. The number
  // handed to `onChange` is the web's, keystroke for keystroke (at least 1,
  // at most the cap). Only the TEXT differs: an emptied field stays empty
  // instead of reading "1" — bound straight to the value, backspacing "100"
  // down left "1" in the field, and typing 75 after it made 175. On a phone
  // there is no double-click-to-select to get round that. null = show the
  // value; leaving the field (or the Custom row) puts the value back.
  const [draft, setDraft] = useState<string | null>(null);
  const cap = leverageCap(maxLeverage);

  // A value above the cap (the parent's 999999 before the cap arrived) is
  // snapped down — LeverageDropdown.jsx:41-44.
  useEffect(() => {
    const snap = leverageSnapTarget(value, cap);
    if (snap != null) onChange(snap);
  }, [cap, value, onChange]);

  const pick = (opt: LeverageOption): void => {
    if (isLeverageLocked(opt, cap)) return;
    setDraft(null);
    if (opt.kind === 'CUSTOM') {
      setCustom(true);
    } else if (opt.kind === 'UNLIMITED') {
      setCustom(false);
      onChange(UNLIMITED_LEVERAGE);
    } else {
      setCustom(false);
      onChange(opt.value);
    }
    setOpen(false);
  };

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Leverage"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        style={[
          styles.trigger,
          {
            backgroundColor: t.colors.inputBg,
            borderColor: open ? t.colors.primary : t.colors.borderDark,
            borderRadius: t.radius.xl,
          },
        ]}
      >
        <AppText variant="bodyStrong" mono numberOfLines={1} style={styles.flex}>
          {leverageDisplay(value, custom, cap)}
        </AppText>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} color={t.colors.textMuted} strokeWidth={2.2} />
      </Pressable>

      {custom ? (
        <View style={styles.customRow}>
          <AppText variant="bodyStrong" tone="muted">1:</AppText>
          <TextInput
            accessibilityLabel="Custom leverage"
            // The draft only while it still names the value — a snap from
            // outside (a new cap) shows the value it snapped to.
            value={draft !== null && (draft === '' || Number(draft) === value) ? draft : String(value)}
            onChangeText={(text) => {
              const v = clampCustomLeverage(text, cap);
              onChange(v);
              // Empty stays empty; anything else shows the clamped number,
              // as the web's field does (150 under a 1:100 cap reads 100).
              setDraft(text.trim() === '' ? '' : String(v));
            }}
            onBlur={() => setDraft(null)}
            keyboardType="number-pad"
            placeholder={cap != null ? `up to ${cap}` : 'e.g. 75'}
            placeholderTextColor={t.colors.textMuted}
            style={[
              styles.customInput,
              {
                backgroundColor: t.colors.inputBg,
                borderColor: t.colors.borderDark,
                borderRadius: t.radius.md,
                color: t.colors.textPrimary,
                fontFamily: t.font.mono,
              },
            ]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close custom leverage"
            hitSlop={8}
            onPress={() => { setDraft(null); setCustom(false); }}
            style={({ pressed }) => [
              styles.customClose,
              { borderRadius: t.radius.sm, backgroundColor: pressed ? t.colors.bgHover : 'transparent' },
            ]}
          >
            <AppText variant="micro" tone="muted" weight="700">×</AppText>
          </Pressable>
        </View>
      ) : null}

      <BottomSheet open={open} onClose={() => setOpen(false)} title="Leverage" scrollable={false} bodyPadding={0}>
        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {LEVERAGE_OPTIONS.map((opt) => {
            const locked = isLeverageLocked(opt, cap);
            const selected = isLeverageOptionSelected(opt, value, custom);
            const label = leverageOptionLabel(opt);
            return (
              <Pressable
                key={opt.kind === 'FIXED' ? `f${opt.value}` : opt.kind}
                accessibilityRole="button"
                accessibilityLabel={locked ? `${label}, locked` : label}
                accessibilityState={{ selected, disabled: locked }}
                disabled={locked}
                onPress={() => pick(opt)}
                style={({ pressed }) => [
                  styles.row,
                  {
                    backgroundColor: selected && !locked
                      ? t.colors.primarySoft
                      : pressed ? t.colors.bgHover : 'transparent',
                  },
                ]}
              >
                <AppText
                  variant="bodyStrong"
                  mono
                  color={locked ? t.alpha(t.colors.textMuted, 0.5) : selected ? t.colors.primaryText : t.colors.textPrimary}
                >
                  {label}
                </AppText>
                {locked ? (
                  <View style={styles.dim}>
                    <Icon name="lock" size={12} color={t.colors.textMuted} strokeWidth={2.2} />
                  </View>
                ) : selected ? (
                  <Icon name="check" size={14} color={t.colors.primaryText} strokeWidth={3} />
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 44,
  },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  customInput: { flex: 1, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 6, fontSize: 14, minHeight: 36 },
  customClose: { paddingHorizontal: 8, paddingVertical: 4 },
  list: { maxHeight: 420 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 44,
  },
  dim: { opacity: 0.6 },
});
