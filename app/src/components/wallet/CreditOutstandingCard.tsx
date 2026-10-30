import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { useTheme } from '@/theme';
import type { CreditSummary } from '@/types/wallet';
import { fmtMoney } from '@/utils/money';

/**
 * "Outstanding credit" — the web's Wallet.jsx card for deposits and
 * withdrawals the desk processed on credit. Shown only while something is
 * still owed: a deposit on credit means the trader still owes the desk
 * ("You owe"); a withdrawal on credit means the desk still owes the trader
 * ("Due to you"). Settled and cancelled credits leave the card empty, and an
 * empty card is not drawn.
 */
export function CreditOutstandingCard({ summary }: { summary: CreditSummary | null }): React.JSX.Element | null {
  const t = useTheme();
  if (!summary) return null;
  const owe = Number(summary.outstandingReceivable) || 0;
  const due = Number(summary.outstandingPayable) || 0;
  if (owe <= 0 && due <= 0) return null;
  return (
    <View
      testID="credit-outstanding"
      style={[styles.card, { backgroundColor: t.colors.surface, borderColor: t.colors.borderDark, borderRadius: t.radius.xl }]}
    >
      <View style={styles.head}>
        <AppText variant="bodyStrong" weight="700">Outstanding credit</AppText>
        <AppText variant="caption" tone="muted">
          {summary.pendingCount === 1 ? '1 open credit transaction' : `${summary.pendingCount} open credit transactions`}
        </AppText>
      </View>
      <View style={styles.row}>
        {owe > 0 ? (
          <View style={styles.cell}>
            <AppText variant="caption" tone="muted">You owe</AppText>
            <AppText variant="h2" mono color={t.colors.bear}>{fmtMoney(owe)}</AppText>
            <AppText variant="micro" tone="muted">Deposits processed on credit — settle with the desk</AppText>
          </View>
        ) : null}
        {due > 0 ? (
          <View style={styles.cell}>
            <AppText variant="caption" tone="muted">Due to you</AppText>
            <AppText variant="h2" mono color={t.colors.bull}>{fmtMoney(due)}</AppText>
            <AppText variant="micro" tone="muted">Withdrawals processed on credit — payout pending</AppText>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, padding: 16, marginBottom: 12 },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 10 },
  row: { flexDirection: 'row', gap: 16, flexWrap: 'wrap' },
  cell: { flex: 1, minWidth: 140, gap: 2 },
});
