import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { fetchPositionHistory } from '@/api/trading.api';
import { AppText, AssetIcon } from '@/components/ui';
import { useAppNavigation } from '@/navigation/types';
import { useTheme } from '@/theme';
import type { Position } from '@/types/trading';
import type { UserAccount } from '@/types/user';
import { CLOSED_PNL_HEADING, closedTradeView, fmtCloseTime, RECENT_CLOSED_LIMIT } from '@/utils/dashboard';

import { Section, TextLink, TINT, tint } from './shared';

/**
 * Recent Closed Trades — Dashboard.jsx:1801-1866. The web's eight-column
 * table becomes one card per trade: symbol and side, the one P&L column
 * ("P&L (₹)", `signed()`), the account, lot size, open / close price and the
 * close time. Loaded once per visit, as on the web; `refreshKey` re-reads it
 * on pull-to-refresh.
 */
export function RecentClosedTrades({
  accounts,
  refreshKey,
}: {
  accounts: readonly UserAccount[];
  refreshKey: number;
}): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  const [rows, setRows] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let dead = false;
    fetchPositionHistory({ limit: RECENT_CLOSED_LIMIT })
      .then((page) => { if (!dead) setRows(page.items); })
      .catch(() => { /* keep what is shown */ })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [refreshKey]);

  const accountNumberById = useMemo(
    () => new Map(accounts.map((a) => [a.id, a.accountNumber || ''] as const).filter(([, n]) => !!n)),
    [accounts],
  );
  const views = useMemo(() => rows.map((r) => closedTradeView(r, accountNumberById)), [rows, accountNumberById]);

  return (
    <Section padded={false} testID="recent-closed-trades">
      <View style={[styles.head, { borderBottomColor: t.colors.borderSubtle }]}>
        <AppText variant="bodyStrong">Recent Closed Trades</AppText>
        <TextLink label="View All Closed Trades →" onPress={() => nav.navigate('Reports')} />
      </View>

      {loading ? (
        <AppText variant="small" tone="muted" align="center" style={styles.state}>Loading…</AppText>
      ) : views.length === 0 ? (
        <AppText variant="small" tone="muted" align="center" style={styles.state}>No closed trades yet</AppText>
      ) : (
        views.map((v, i) => {
          const pnlColor = v.pnl >= 0 ? t.colors.bull : t.colors.bear;
          const source = rows[i];
          return (
            <View
              key={v.key}
              style={[styles.row, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.borderSubtle } : null]}
            >
              <View style={styles.rowTop}>
                <View style={styles.sym}>
                  <AssetIcon symbol={v.symbol} size={22} round />
                  <AppText variant="bodyStrong" numberOfLines={1} style={styles.symText}>{v.symbol}</AppText>
                  <View
                    style={[
                      styles.side,
                      { backgroundColor: tint(v.buy ? TINT.green : TINT.red, 0.08) },
                    ]}
                  >
                    <AppText variant="micro" weight="700" color={v.buy ? TINT.greenText : TINT.redText}>
                      {v.buy ? 'BUY' : 'SELL'}
                    </AppText>
                  </View>
                </View>
                <View style={styles.pnl} accessible accessibilityLabel={`${CLOSED_PNL_HEADING}: ${v.pnlText}`}>
                  <AppText variant="micro" tone="muted" weight="700">{CLOSED_PNL_HEADING.toUpperCase()}</AppText>
                  <AppText variant="bodyStrong" mono color={pnlColor} testID={`recent-closed-pnl-${v.key}`}>{v.pnlText}</AppText>
                </View>
              </View>

              <View style={styles.grid}>
                <Cell label="Account" value={v.account} />
                <Cell label="Lot Size" value={v.lot} mono />
                <Cell label="Open Price" value={v.open} mono />
                <Cell label="Close Price" value={v.close} mono />
              </View>
              <AppText variant="micro" tone="muted">{fmtCloseTime(source?.closedAt)}</AppText>
            </View>
          );
        })
      )}
    </Section>
  );
}

function Cell({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <View style={styles.cell}>
      <AppText variant="micro" tone="muted" weight="700">{label.toUpperCase()}</AppText>
      <AppText variant="small" tone="secondary" mono={mono} numberOfLines={1}>{value}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  state: { paddingVertical: 28 },
  row: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  sym: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  symText: { flexShrink: 1 },
  side: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 },
  pnl: { alignItems: 'flex-end' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 6 },
  cell: { width: '50%', gap: 1 },
});
