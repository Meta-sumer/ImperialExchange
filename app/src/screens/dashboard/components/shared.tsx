import React, { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { AppText, BottomSheet } from '@/components/ui';
import { useTheme } from '@/theme';
import { scopeLabel, type AccountScope, type ScopeOption } from '@/utils/dashboard';

import { Glyph } from './Glyph';

/**
 * Pieces several Dashboard sections share. The inline hexes are the web's —
 * Dashboard.jsx paints its tints inline, the same in both themes.
 */
export const TINT = {
  blue: '#3B82F6',
  navy: '#1D4ED8',
  green: '#16A34A',
  greenText: '#15803D',
  red: '#DC2626',
  redSoft: '#EF4444',
  redText: '#B91C1C',
  amber: '#D97706',
  amberText: '#B45309',
  slate: '#94A3B8',
} as const;

/** Hex + alpha, as the web's `${hex}1A` / `${hex}15` suffixes. */
export const tint = (hex: string, alpha: number): string =>
  `${hex}${Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0').toUpperCase()}`;

/** The white `rounded-2xl border shadow-sm` section card the page is built from. */
export function Section({
  children,
  style,
  padded = true,
  testID,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
  testID?: string;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.section,
        {
          backgroundColor: t.colors.surface,
          borderColor: t.colors.borderDark,
          borderRadius: t.radius.xxl,
          padding: padded ? t.space.lg : 0,
        },
        t.shadow.card,
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** The `text-[10px] uppercase tracking-[0.18em] font-extrabold` eyebrow. */
export function Eyebrow({ children }: { children: string }): React.JSX.Element {
  return (
    <AppText variant="micro" tone="muted" weight="800" style={styles.eyebrow}>
      {children}
    </AppText>
  );
}

/** A primary-coloured text link (`text-xs font-semibold text-primary-600`). */
export function TextLink({
  label,
  onPress,
  style,
}: {
  label: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="link"
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [pressed ? { opacity: 0.6 } : null, style]}
    >
      <AppText variant="small" weight="600" color={t.colors.primaryText}>{label}</AppText>
    </Pressable>
  );
}

/**
 * The account dropdown the Asset Allocation card and the accounts table
 * share (Dashboard.jsx:1498-1516 / 1717-1735): a small trigger, and the
 * options in a sheet — with the divider before the first account and a
 * check on the current one.
 */
export function ScopePicker({
  options,
  value,
  onChange,
  title = 'Select Account',
  maxLabelWidth = 120,
}: {
  options: readonly ScopeOption[];
  value: AccountScope;
  onChange: (k: AccountScope) => void;
  title?: string;
  maxLabelWidth?: number;
}): React.JSX.Element {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const label = scopeLabel(options, value);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Accounts: ${label}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.trigger,
          { borderColor: pressed ? t.alpha(t.colors.primary, 0.4) : t.colors.borderDark, backgroundColor: t.colors.surface },
        ]}
      >
        <AppText variant="caption" weight="600" numberOfLines={1} style={{ maxWidth: maxLabelWidth }}>{label}</AppText>
        <Glyph name="caretDown" size={12} color={t.colors.textPrimary} />
      </Pressable>
      <BottomSheet open={open} onClose={() => setOpen(false)} title={title}>
        {options.map((o, i) => {
          const active = o.k === value;
          return (
            <View key={o.k}>
              {i === 3 ? <View style={[styles.divider, { backgroundColor: t.colors.borderSubtle }]} /> : null}
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: active }}
                onPress={() => { onChange(o.k); setOpen(false); }}
                style={({ pressed }) => [
                  styles.option,
                  { backgroundColor: active ? t.colors.primarySoft : pressed ? t.colors.bgHover : 'transparent', borderRadius: t.radius.lg },
                ]}
              >
                <AppText
                  variant="body"
                  weight={active ? '600' : '400'}
                  color={active ? t.colors.primaryText : t.colors.textPrimary}
                  numberOfLines={1}
                  style={styles.flex}
                >
                  {o.label}
                </AppText>
                {active ? <Glyph name="check" size={14} color={t.colors.primaryText} /> : null}
              </Pressable>
            </View>
          );
        })}
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
  section: { borderWidth: 1 },
  eyebrow: { letterSpacing: 1.8, textTransform: 'uppercase' },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  divider: { height: 1, marginVertical: 4 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 12 },
  flex: { flex: 1 },
});
