import React, { type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { AppText } from '@/components/ui';
import { useTheme, type AppTheme } from '@/theme';
import type { StatusTone } from '@/utils/profile';

import { ProfileIcon, type ProfileIconName } from './ProfileIcons';

/**
 * Profile.jsx's page primitives: SectionCard, InfoBlock, StatusPill,
 * KycPill and the status badge — the same boxes, on the theme.
 */

/** A status tone's colours: text/icon, the wash and the border. */
export const toneColors = (t: AppTheme, tone: StatusTone): { fg: string; bg: string; border: string } => {
  switch (tone) {
    case 'bull': return { fg: t.colors.bull, bg: t.alpha(t.colors.bull, 0.1), border: t.alpha(t.colors.bull, 0.2) };
    case 'bear': return { fg: t.colors.bear, bg: t.alpha(t.colors.bear, 0.1), border: t.alpha(t.colors.bear, 0.2) };
    case 'warn': return { fg: t.colors.warn, bg: t.alpha(t.colors.warn, 0.1), border: t.alpha(t.colors.warn, 0.2) };
    case 'muted':
    default: return { fg: t.colors.textMuted, bg: t.colors.bgHover, border: t.colors.borderSubtle };
  }
};

/** The `w-9 h-9 rounded-lg bg-primary-500/10 text-primary-600` icon tile. */
export function IconTile({
  icon,
  size = 36,
  iconSize = 16,
  tone = 'primary',
  style,
}: {
  icon: ProfileIconName;
  size?: number;
  iconSize?: number;
  tone?: 'primary' | 'muted';
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  const primary = tone === 'primary';
  return (
    <View
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: size >= 48 ? t.radius.xl : t.radius.lg,
          backgroundColor: primary ? t.colors.primarySoft : t.colors.bgHover,
        },
        style,
      ]}
    >
      <ProfileIcon name={icon} size={iconSize} color={primary ? t.colors.primaryText : t.colors.textMuted} />
    </View>
  );
}

/** Profile.jsx — a `.card` with an icon header and a body. */
export function SectionCard({
  icon,
  title,
  subtitle,
  action,
  children,
  padded = true,
  testID,
}: {
  icon?: ProfileIconName;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children?: ReactNode;
  padded?: boolean;
  testID?: string;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.card,
        { backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark, borderRadius: t.radius.xl },
        t.shadow.card,
      ]}
    >
      <View style={[styles.cardHead, { borderBottomColor: t.colors.borderSubtle }]}>
        {icon ? <IconTile icon={icon} /> : null}
        <View style={styles.flex}>
          <AppText variant="body" weight="800" accessibilityRole="header">{title}</AppText>
          {subtitle ? <AppText variant="small" tone="muted" style={styles.sub}>{subtitle}</AppText> : null}
        </View>
        {action ? <View>{action}</View> : null}
      </View>
      <View style={padded ? styles.body : null}>{children}</View>
    </View>
  );
}

/** Profile.jsx. */
export function InfoBlock({ label, children }: { label: string; children?: ReactNode }): React.JSX.Element {
  const t = useTheme();
  return (
    <View
      style={[
        styles.info,
        { borderColor: t.colors.borderSubtle, backgroundColor: t.alpha(t.colors.bgHover, 0.4), borderRadius: t.radius.lg },
      ]}
    >
      <AppText variant="micro" tone="muted" weight="700" style={styles.upper}>{label}</AppText>
      <View style={styles.infoBody}>{children}</View>
    </View>
  );
}

/** A rounded-full chip with an icon — StatusPill / KycPill / the referral chip. */
export function Chip({
  icon,
  tone,
  children,
}: {
  icon: ProfileIconName;
  tone: StatusTone;
  children: ReactNode;
}): React.JSX.Element {
  const t = useTheme();
  // KycPill's muted chip is `text-text-secondary`, not muted.
  const c = tone === 'muted'
    ? { fg: t.colors.textSecondary, bg: t.colors.bgHover, border: t.colors.borderSubtle }
    : toneColors(t, tone);
  return (
    <View style={[styles.chip, { backgroundColor: c.bg, borderColor: c.border }]}>
      <ProfileIcon name={icon} size={12} color={c.fg} />
      {typeof children === 'string'
        ? <AppText variant="caption" weight="600" color={c.fg}>{children}</AppText>
        : children}
    </View>
  );
}

/** Profile.jsx. */
export function StatusPill({
  active,
  activeLabel,
  inactiveLabel,
  icon,
}: {
  active: boolean;
  activeLabel: string;
  inactiveLabel: string;
  icon: ProfileIconName;
}): React.JSX.Element {
  return <Chip icon={icon} tone={active ? 'bull' : 'bear'}>{active ? activeLabel : inactiveLabel}</Chip>;
}

/**
 * The square status badge — `text-[10px] uppercase tracking-wider
 * font-extrabold px-2 py-1 rounded` — a document's verdict, the PAN card's
 * status or "Required".
 */
export function StatusBadge({ label, tone }: { label: string; tone: StatusTone | 'primary' }): React.JSX.Element {
  const t = useTheme();
  const c = tone === 'primary'
    ? { fg: t.colors.primaryText, bg: t.alpha(t.colors.primary, 0.1) }
    : toneColors(t, tone);
  return (
    <View style={[styles.badge, { backgroundColor: c.bg, borderRadius: t.radius.sm }]}>
      <AppText variant="micro" weight="800" color={c.fg} style={styles.upper}>{label}</AppText>
    </View>
  );
}

/**
 * The small `text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded
 * bg-primary-500/10 text-primary-600` action — "Copy".
 */
export function MiniAction({
  label,
  onPress,
  tone = 'primary',
  accessibilityLabel,
  disabled,
}: {
  label: string;
  onPress: () => void;
  tone?: 'primary' | 'bear';
  accessibilityLabel?: string;
  disabled?: boolean;
}): React.JSX.Element {
  const t = useTheme();
  const fg = tone === 'bear' ? t.colors.bear : t.colors.primaryText;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={({ pressed }) => [
        styles.mini,
        {
          borderRadius: t.radius.sm,
          backgroundColor: tone === 'bear'
            ? (pressed ? t.alpha(t.colors.bear, 0.1) : 'transparent')
            : t.alpha(t.colors.primary, pressed ? 0.15 : 0.1),
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <AppText variant="micro" weight="700" color={fg} style={styles.upper}>{label}</AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  tile: { alignItems: 'center', justifyContent: 'center' },
  card: { borderWidth: 1, overflow: 'hidden' },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  sub: { marginTop: 2 },
  body: { padding: 20, gap: 16 },
  info: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10 },
  infoBody: { marginTop: 4 },
  upper: { textTransform: 'uppercase', letterSpacing: 0.6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badge: { paddingHorizontal: 8, paddingVertical: 4 },
  mini: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 4 },
});
