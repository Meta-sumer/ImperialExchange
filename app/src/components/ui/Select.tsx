import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Icon } from './Icon';
import { Input } from './Input';
import { BottomSheet } from './Modal';

/**
 * A <select>, as a bottom-sheet picker.
 *
 * The trigger is styled as `.input` with a chevron so a form of inputs and
 * selects reads as one column, as on the web. The list opens in a
 * BottomSheet — a native <select> on a phone is a wheel or a dialog that
 * cannot show a description line, and several web selects carry one (the
 * account picker's "USD · 100234 · STANDARD").
 *
 * Long lists get a search field automatically (over 8 options), matching
 * the web's searchable pickers; pass `searchable` to force it either way.
 */
export interface SelectOption<V extends string | number = string> {
  value: V;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string | number = string> {
  value: V | null | undefined;
  options: SelectOption<V>[];
  onChange: (value: V) => void;
  label?: string;
  placeholder?: string;
  error?: string | null;
  disabled?: boolean;
  /** Sheet title; defaults to the label. */
  title?: string;
  searchable?: boolean;
  /** 'compact' is the header's tiny select (text-[10px] font-semibold). */
  variant?: 'field' | 'compact';
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

/** Case-insensitive match on label and description. Exported for tests. */
export const filterOptions = <V extends string | number>(
  options: SelectOption<V>[],
  query: string,
): SelectOption<V>[] => {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) =>
    o.label.toLowerCase().includes(q) || (o.description ?? '').toLowerCase().includes(q));
};

export function Select<V extends string | number = string>({
  value,
  options,
  onChange,
  label,
  placeholder = 'Select…',
  error,
  disabled,
  title,
  searchable,
  variant = 'field',
  accessibilityLabel,
  style,
}: SelectProps<V>): React.JSX.Element {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const current = options.find((o) => o.value === value) ?? null;
  const showSearch = searchable ?? options.length > 8;
  const shown = useMemo(() => filterOptions(options, query), [options, query]);

  const close = (): void => { setOpen(false); setQuery(''); };

  const trigger = variant === 'compact' ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={disabled}
      onPress={() => setOpen(true)}
      style={[
        styles.compact,
        { backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark, borderRadius: t.radius.sm },
        style,
      ]}
    >
      <AppText variant="micro" tone="secondary" weight="600">{current?.label ?? placeholder}</AppText>
      <Icon name="chevronDown" size={10} color={t.colors.textMuted} strokeWidth={2.4} />
    </Pressable>
  ) : (
    <View style={style}>
      {label ? <AppText variant="label" style={styles.label}>{label}</AppText> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ disabled: !!disabled, expanded: open }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={[
          styles.field,
          {
            backgroundColor: t.colors.inputBg,
            borderColor: error ? t.colors.bear : open ? t.colors.primary : t.colors.borderDark,
            borderRadius: t.radius.lg,
            opacity: disabled ? 0.6 : 1,
          },
        ]}
      >
        <AppText
          variant="body"
          tone={current ? 'primary' : 'muted'}
          numberOfLines={1}
          style={styles.flex}
        >
          {current?.label ?? placeholder}
        </AppText>
        <Icon name="chevronDown" size={16} color={t.colors.textMuted} />
      </Pressable>
      {error ? <AppText variant="small" tone="bear" style={styles.below}>{error}</AppText> : null}
    </View>
  );

  return (
    <>
      {trigger}
      <BottomSheet open={open} onClose={close} title={title ?? label ?? placeholder} scrollable={false} bodyPadding={0}>
        {showSearch ? (
          <View style={styles.search}>
            <Input
              value={query}
              onChangeText={setQuery}
              placeholder="Search…"
              autoCorrect={false}
              autoCapitalize="none"
              left={<Icon name="search" size={16} color={t.colors.textMuted} />}
            />
          </View>
        ) : null}
        <FlatList
          data={shown}
          keyExtractor={(o) => String(o.value)}
          keyboardShouldPersistTaps="handled"
          style={styles.list}
          ListEmptyComponent={(
            <AppText variant="body" tone="muted" align="center" style={styles.empty}>No matches</AppText>
          )}
          renderItem={({ item }) => {
            const active = item.value === value;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: active, disabled: !!item.disabled }}
                disabled={item.disabled}
                onPress={() => { onChange(item.value); close(); }}
                style={({ pressed }) => [
                  styles.row,
                  { backgroundColor: active ? t.colors.primarySoft : pressed ? t.colors.bgHover : 'transparent' },
                  item.disabled ? styles.dim : null,
                ]}
              >
                <View style={styles.flex}>
                  <AppText variant="bodyStrong" numberOfLines={1}>{item.label}</AppText>
                  {item.description ? (
                    <AppText variant="micro" tone="muted" numberOfLines={1}>{item.description}</AppText>
                  ) : null}
                </View>
                {active ? <Icon name="check" size={16} color={t.colors.primary} strokeWidth={2.5} /> : null}
              </Pressable>
            );
          }}
        />
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  label: { marginBottom: 6 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    minHeight: 44,
  },
  compact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  below: { marginTop: 4 },
  search: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  list: { flexGrow: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
    minHeight: 48,
  },
  empty: { padding: 24 },
  dim: { opacity: 0.45 },
});
