import React, { type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from './AppText';

/**
 * The inner-page hero, ported from client/src/components/PageHero.jsx:
 * eyebrow, big title, subtitle, an optional actions slot and extra content
 * (chips, stats) under the subtitle.
 *
 *   rounded-2xl border border-border-dark bg-bg-card p-6 mb-6
 *
 * The web also paints a radial yellow glow and a 3%-opacity grid. index.css
 * then force-hides that exact glow (the `252, 213, 53` rule under "Targeted
 * overrides"), and a 3% grid is invisible on a phone — so neither is drawn,
 * which is what a user of the web actually sees.
 *
 * `actions` sit to the right on the web and wrap under the text when the
 * row is narrow; on a phone they are always underneath, full width.
 *
 * `compact`: a slim band for pages that open on content the trader came for
 * (Explore's markets, Positions) — smaller title and padding, so the hero
 * does not fill the first screen.
 */
export function PageHero({
  eyebrow,
  title,
  subtitle,
  actions,
  children,
  compact = false,
  style,
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <View
      style={[
        styles.hero,
        compact && styles.compact,
        { backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark, borderRadius: t.radius.xxl },
        style,
      ]}
    >
      {eyebrow ? (
        <View style={styles.eyebrow}>
          <View style={[styles.rule, { backgroundColor: t.colors.primary }]} />
          <AppText variant="eyebrow">{eyebrow}</AppText>
        </View>
      ) : null}
      {typeof title === 'string'
        ? <AppText variant={compact ? 'h3' : 'h1'} accessibilityRole="header">{title}</AppText>
        : title}
      {subtitle ? (
        typeof subtitle === 'string'
          ? <AppText variant={compact ? 'small' : 'body'} tone="secondary" style={compact ? styles.subtitleCompact : styles.subtitle}>{subtitle}</AppText>
          : <View style={styles.subtitle}>{subtitle}</View>
      ) : null}
      {children ? <View style={styles.children}>{children}</View> : null}
      {actions ? <View style={styles.actions}>{actions}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { borderWidth: 1, padding: 24, marginBottom: 24 },
  compact: { paddingHorizontal: 16, paddingVertical: 12, marginBottom: 4 },
  eyebrow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  rule: { width: 24, height: 1 },
  subtitle: { marginTop: 8 },
  subtitleCompact: { marginTop: 2 },
  children: { marginTop: 16 },
  actions: { marginTop: 16, flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
