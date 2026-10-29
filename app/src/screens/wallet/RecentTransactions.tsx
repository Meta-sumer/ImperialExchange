import React, { useMemo, type ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { AppText, Card, toast } from '@/components/ui';
import { WalletGlyph, type WalletGlyphName } from '@/components/wallet/WalletNav';
import { useAppNavigation } from '@/navigation/types';
import { useTheme } from '@/theme';
import type { Deposit, Withdrawal } from '@/types/wallet';
import { fmtMoney } from '@/utils/money';
import {
  fmtLocalDateTime,
  recentMethodText,
  recentMoves,
  shortTxId,
  statusColors,
  stripStatusColors,
  txStatusLabel,
} from '@/utils/walletLogic';

/* ══ Pieces the wallet views share ════════════════════════════════════ */

/** The web's wallet box — `bg-white border border-border-dark rounded-2xl`. */
export function WalletCard({
  children,
  padded = true,
  style,
}: {
  children?: ReactNode;
  padded?: boolean | number;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <Card variant="plain" padded={padded === true ? 20 : padded} style={[{ borderRadius: t.radius.xxl }, style]}>
      {children}
    </Card>
  );
}

/** A card's title row with an optional link-style action on the right. */
export function CardHeader({
  title,
  action,
  onAction,
  divider = false,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  divider?: boolean;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <View
      style={[
        styles.cardHeader,
        divider ? { borderBottomWidth: 1, borderBottomColor: t.colors.borderSubtle, paddingBottom: 12, marginBottom: 4 } : null,
      ]}
    >
      <AppText variant="bodyStrong" weight="700" style={styles.flex}>{title}</AppText>
      {action && onAction ? (
        <Pressable accessibilityRole="button" onPress={onAction} hitSlop={8}>
          <AppText variant="small" tone="brand" weight="600">{action}</AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The tinted square an icon sits in — `w-8 h-8 rounded-xl` with `${tint}15`. */
export function TintBadge({
  tint,
  glyph,
  size = 32,
  glyphSize,
  solid = false,
}: {
  tint: string;
  glyph: WalletGlyphName;
  size?: number;
  glyphSize?: number;
  solid?: boolean;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        backgroundColor: solid ? tint : t.alpha(tint, 0.08),
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <WalletGlyph name={glyph} size={glyphSize ?? Math.round(size * 0.47)} color={solid ? '#FFFFFF' : tint} strokeWidth={1.9} />
    </View>
  );
}

/**
 * A status chip in the web's hexes. `variant="overview"` is AccountOverview's
 * TxStatus (CONFIRMED reads "Success"); `"history"` is TransactionHistory's
 * StatusPill (raw status, with a dot).
 */
export function StatusPill({
  status,
  variant = 'overview',
}: {
  status: string | null | undefined;
  variant?: 'overview' | 'history';
}): React.JSX.Element {
  const t = useTheme();
  const c = statusColors(status);
  const fg = t.isDark ? c.dot : c.fg;
  const label = variant === 'overview' ? txStatusLabel(status) : (String(status || '').toUpperCase() || 'UNKNOWN');
  return (
    <View style={[styles.pill, { backgroundColor: t.alpha(c.dot, 0.08) }]}>
      {variant === 'history' ? <View style={[styles.dot, { backgroundColor: c.dot }]} /> : null}
      <AppText variant="micro" color={fg} weight="700" style={styles.pillText}>{label}</AppText>
    </View>
  );
}

/* ══ The strip under every view but the overview ═════════════════════════ */

/**
 * "Recent Transactions": the last twelve deposits and withdrawals, newest
 * first. The web's six-column table becomes one row card per movement,
 * carrying the same six fields.
 */
export function RecentTransactions({
  deposits,
  withdrawals,
  onViewAll,
}: {
  deposits: readonly Deposit[];
  withdrawals: readonly Withdrawal[];
  /** Omitted on the history view, where "View All" would point back at itself. */
  onViewAll?: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const recent = useMemo(() => recentMoves(deposits, withdrawals, 12), [deposits, withdrawals]);

  return (
    <WalletCard padded={false} style={styles.stripCard}>
      <View style={[styles.stripHead, { borderBottomColor: t.colors.borderSubtle }]}>
        <AppText variant="bodyStrong" weight="700" style={styles.flex}>Recent Transactions</AppText>
        {onViewAll ? (
          <Pressable
            accessibilityRole="button"
            onPress={onViewAll}
            style={({ pressed }) => [
              styles.viewAll,
              { borderColor: pressed ? t.alpha(t.colors.primary, 0.4) : t.colors.borderDark, borderRadius: t.radius.lg },
            ]}
          >
            <AppText variant="small" tone="brand" weight="600">View All</AppText>
          </Pressable>
        ) : null}
      </View>
      {recent.length === 0 ? (
        <AppText variant="body" tone="muted" align="center" style={styles.empty}>No transactions yet</AppText>
      ) : (
        recent.map((m, i) => {
          const dep = m.kind === 'deposit';
          const tone = dep ? t.colors.bull : t.colors.bear;
          const strip = stripStatusColors(m.row.status);
          return (
            <View
              key={`${m.kind}-${m.row.id || i}`}
              style={[styles.stripRow, i > 0 ? { borderTopWidth: 1, borderTopColor: t.colors.borderSubtle } : null]}
            >
              <View style={styles.flex}>
                <View style={styles.inline}>
                  <View style={[styles.tag, { backgroundColor: t.alpha(tone, 0.15) }]}>
                    <AppText variant="micro" color={tone} weight="700" style={styles.upper}>{dep ? 'Deposit' : 'Withdraw'}</AppText>
                  </View>
                  <View style={[styles.rawStatus, strip ? { backgroundColor: t.alpha(strip.dot, 0.15) } : null]}>
                    <AppText variant="small" color={strip ? (t.isDark ? strip.dot : strip.fg) : t.colors.textSecondary}>
                      {m.row.status}
                    </AppText>
                  </View>
                </View>
                <AppText variant="small" tone="secondary" style={styles.gapTop}>{fmtLocalDateTime(m.row.createdAt)}</AppText>
                <AppText variant="small" tone="secondary" numberOfLines={1}>
                  {recentMethodText(m.row.method)}
                  <AppText variant="caption" tone="muted" mono>{`  ·  ${shortTxId(m.row.id)}`}</AppText>
                </AppText>
              </View>
              <AppText variant="bodyStrong" color={tone} weight="700" mono style={styles.amount}>
                {`${dep ? '+' : '-'}${fmtMoney(Math.abs(Number(m.row.amount) || 0))}`}
              </AppText>
            </View>
          );
        })
      )}
    </WalletCard>
  );
}

/**
 * "Need help? Live chat · support@tradepro.com" — Wallet.jsx, the
 * discreet support line under each view.
 */
export function SupportStrip(): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  const mail = 'support@tradepro.com';
  const openMail = async (): Promise<void> => {
    try {
      await Linking.openURL(`mailto:${mail}`);
    } catch {
      // No mail app configured: say where to write rather than fail silently.
      toast(`Write to ${mail}`);
    }
  };
  return (
    <View style={styles.support}>
      <AppText variant="small" tone="muted">Need help?</AppText>
      <Pressable accessibilityRole="link" onPress={() => nav.navigate('Helpdesk')} style={styles.inline} hitSlop={6}>
        <WalletGlyph name="chat" size={14} color={t.colors.primaryText} strokeWidth={2} />
        <AppText variant="small" tone="brand" weight="600">Live chat</AppText>
      </Pressable>
      <AppText variant="small" color={t.colors.borderDark}>·</AppText>
      <Pressable accessibilityRole="link" onPress={() => { void openMail(); }} style={styles.inline} hitSlop={6}>
        <WalletGlyph name="mail" size={14} color={t.colors.primaryText} strokeWidth={2} />
        <AppText variant="small" tone="brand" weight="600">{mail}</AppText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  upper: { textTransform: 'uppercase', letterSpacing: 0.4 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  pill: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  pillText: { fontSize: 9, letterSpacing: 0.5, textTransform: 'uppercase' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  stripCard: { marginTop: 20, overflow: 'hidden' },
  stripHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1 },
  viewAll: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6 },
  empty: { paddingVertical: 40 },
  stripRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 12 },
  tag: { borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2 },
  rawStatus: { borderRadius: 4, paddingHorizontal: 8, paddingVertical: 1 },
  gapTop: { marginTop: 4 },
  amount: { textAlign: 'right' },
  support: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 12, marginTop: 16 },
});
