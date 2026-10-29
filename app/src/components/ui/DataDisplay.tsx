import React, { type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';

import { AppText, type TextTone } from './AppText';
import { Card } from './Card';
import { Icon, type IconName } from './Icon';

/**
 * Rows and tiles for showing figures.
 *
 * None of these format money. Pass a string that came out of utils/money —
 * a component that formatted numbers itself would be one more place for the
 * `en-IN`-on-dollars mistake PORT-RULINGS §5 exists to stop.
 */

/**
 * A label on the left, a value on the right — the web's detail lists
 * ("Account number … 100234", "Leverage … 1:100").
 */
export function KeyValueRow({
  label,
  value,
  valueTone,
  mono = false,
  hint,
  right,
  onPress,
  divider = false,
  style,
}: {
  label: string;
  value?: ReactNode;
  valueTone?: TextTone;
  /** Tabular figures, for numbers. */
  mono?: boolean;
  /** Small muted line under the label. */
  hint?: string;
  /** Replaces the value slot entirely (a button, a toggle). */
  right?: ReactNode;
  onPress?: () => void;
  divider?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  const content = (
    <>
      <View style={styles.kvLabel}>
        <AppText variant="body" tone="muted">{label}</AppText>
        {hint ? <AppText variant="micro" tone="muted">{hint}</AppText> : null}
      </View>
      {right ?? (
        typeof value === 'string' || typeof value === 'number' ? (
          <AppText variant="bodyStrong" tone={valueTone} mono={mono} align="right" style={styles.kvValue}>
            {String(value)}
          </AppText>
        ) : value
      )}
      {onPress ? <Icon name="chevronRight" size={16} color={t.colors.textMuted} /> : null}
    </>
  );
  const rowStyle = [
    styles.kv,
    divider ? { borderBottomWidth: 1, borderBottomColor: t.colors.borderSubtle } : null,
    style,
  ];
  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [...rowStyle, pressed ? { backgroundColor: t.colors.bgHover } : null]}
      >
        {content}
      </Pressable>
    );
  }
  return <View style={rowStyle}>{content}</View>;
}

/**
 * index.css `.stat-card` — a card with a small label, a big figure and an
 * optional sub-line. `tone` colours the figure (bull/bear for P&L).
 */
export function StatTile({
  label,
  value,
  sub,
  tone,
  icon,
  loading = false,
  onPress,
  style,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: TextTone;
  icon?: IconName;
  /** Shows a dash rather than a stale or zero figure while loading. */
  loading?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <Card padded={20} onPress={onPress} accessibilityLabel={`${label} ${value}`} style={style}>
      <View style={styles.statHead}>
        <AppText variant="small" tone="muted" weight="500" style={styles.flex} numberOfLines={1}>{label}</AppText>
        {icon ? <Icon name={icon} size={16} color={t.colors.textMuted} /> : null}
      </View>
      <AppText variant="h2" tone={tone} mono numberOfLines={1} adjustsFontSizeToFit style={styles.statValue}>
        {loading ? '—' : value}
      </AppText>
      {sub ? <AppText variant="small" tone="muted" numberOfLines={2}>{sub}</AppText> : null}
    </Card>
  );
}

/**
 * A row in a menu — the profile menu's `flex items-center gap-3 px-4 py-2.5
 * text-sm` links. `danger` is the Log Out row (`text-bear`).
 */
export function MenuItem({
  icon,
  label,
  sublabel,
  onPress,
  right,
  danger = false,
  chevron = false,
  style,
}: {
  icon?: IconName;
  label: string;
  sublabel?: string;
  onPress?: () => void;
  right?: ReactNode;
  danger?: boolean;
  chevron?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  const fg = danger ? t.colors.bear : t.colors.textPrimary;
  return (
    <Pressable
      accessibilityRole={onPress ? 'menuitem' : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.menu,
        { backgroundColor: pressed ? (danger ? t.colors.bearSoft : t.colors.bgHover) : 'transparent' },
        style,
      ]}
    >
      {icon ? <Icon name={icon} size={18} color={danger ? t.colors.bear : t.colors.textMuted} /> : null}
      <View style={styles.flex}>
        <AppText variant="body" color={fg} weight={sublabel ? '500' : undefined}>{label}</AppText>
        {sublabel ? <AppText variant="micro" tone="muted" numberOfLines={1}>{sublabel}</AppText> : null}
      </View>
      {right}
      {chevron ? <Icon name="chevronRight" size={16} color={t.colors.textMuted} /> : null}
    </Pressable>
  );
}

/** A small section heading with an optional trailing action. */
export function SectionHeader({
  title,
  actionLabel,
  onAction,
  style,
}: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  return (
    <View style={[styles.section, style]}>
      <AppText variant="title" style={styles.flex}>{title}</AppText>
      {actionLabel && onAction ? (
        <Pressable accessibilityRole="button" onPress={onAction} hitSlop={8}>
          <AppText variant="bodyStrong" tone="brand">{actionLabel}</AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  kv: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, minHeight: 40 },
  kvLabel: { flexShrink: 1 },
  kvValue: { flex: 1, minWidth: 0 },
  statHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statValue: { marginTop: 6, marginBottom: 2 },
  menu: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, minHeight: 44 },
  section: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
});
