import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { fetchLifetimeStats, STATS_TIME_RANGES, type DashboardLifetimeStats } from '@/api/dashboard.api';
import { AppText, Button, Input, Select, type SelectOption } from '@/components/ui';
import { useTheme } from '@/theme';
import type { UserAccount } from '@/types/user';
import {
  canApplyCustomRange,
  statsAccountOptions,
  statsQuery,
  statsRows,
  type StatRow,
} from '@/utils/dashboard';
import { customDateError } from '@/utils/walletLogic';

import { Eyebrow, Section } from './shared';

const CUSTOM = 'custom';

const RANGE_OPTIONS: SelectOption[] = [
  ...STATS_TIME_RANGES.map((r) => ({ value: String(r.id), label: r.label })),
  { value: CUSTOM, label: 'Custom' },
];

/**
 * "Trading summary" — Dashboard.jsx PortfolioStats (:489-643): a time
 * window (Lifetime / 7 / 30 / 90 / 365 days / Custom range) and an account
 * filter (All accounts / All Real / All Demo / one, each "· INR"),
 * refetching GET /user/dashboard/lifetime-stats on every change. Ten cells
 * in rupees: Net profit, Net P&L (after charges), Profit, Loss, Charges,
 * Unrealised P/L, Closed orders, Profitable, Unprofitable, Trading volume.
 * A failed read keeps the previous numbers, as the web does.
 *
 * The account list is the app's one copy (useSelectedAccountStore) rather
 * than a second GET /user/accounts. The web's native date inputs become
 * typed YYYY-MM-DD fields; Apply takes them only when both are real days in
 * order (the web's min/max did that).
 */
export function PortfolioStats({
  accounts,
  refreshKey,
}: {
  accounts: readonly UserAccount[];
  refreshKey: number;
}): React.JSX.Element {
  const t = useTheme();
  const [days, setDays] = useState(0);
  const [accountId, setAccountId] = useState('');
  const [stats, setStats] = useState<DashboardLifetimeStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const query = useMemo(
    () => statsQuery({ days, custom: customMode, from: customFrom, to: customTo, accountId }),
    [days, customMode, customFrom, customTo, accountId],
  );
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchLifetimeStats(JSON.parse(queryKey))
      .then((s) => { if (!cancelled) setStats(s); })
      .catch(() => { /* non-fatal — keep previous numbers */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [queryKey, refreshKey]);

  const accountOptions = useMemo(() => statsAccountOptions(accounts), [accounts]);
  const rows = statsRows(stats);
  const canApply = canApplyCustomRange(draftFrom, draftTo);

  return (
    <Section testID="dashboard-stats" style={styles.gapBelow}>
      <Eyebrow>Performance</Eyebrow>
      <AppText variant="title" style={styles.title}>Trading summary</AppText>
      <AppText variant="caption" tone="muted">
        {loading ? 'Loading…' : 'Filter the window or pick an account to drill down'}
      </AppText>

      <View style={styles.filters}>
        <Select
          value={customMode ? CUSTOM : String(days)}
          options={RANGE_OPTIONS}
          title="Time window"
          accessibilityLabel="Time window"
          onChange={(v) => {
            if (v === CUSTOM) {
              setCustomMode(true);
              setDraftFrom(customFrom);
              setDraftTo(customTo);
            } else {
              setCustomMode(false);
              setDays(Number(v));
            }
          }}
          style={styles.filter}
        />
        <Select
          value={accountId}
          options={accountOptions}
          title="Account"
          accessibilityLabel="Account"
          onChange={setAccountId}
          style={styles.filter}
        />
      </View>

      {customMode ? (
        <View style={styles.custom}>
          <View style={styles.customRow}>
            <Input
              value={draftFrom}
              onChangeText={setDraftFrom}
              placeholder="YYYY-MM-DD"
              accessibilityLabel="From date"
              keyboardType="numbers-and-punctuation"
              maxLength={10}
              autoCorrect={false}
              error={customDateError(draftFrom)}
              mono
              containerStyle={styles.dateInput}
            />
            <AppText variant="small" tone="muted" style={styles.to}>to</AppText>
            <Input
              value={draftTo}
              onChangeText={setDraftTo}
              placeholder="YYYY-MM-DD"
              accessibilityLabel="To date"
              keyboardType="numbers-and-punctuation"
              maxLength={10}
              autoCorrect={false}
              error={customDateError(draftTo)}
              mono
              containerStyle={styles.dateInput}
            />
          </View>
          <Button
            title="Apply"
            size="sm"
            disabled={!canApply}
            onPress={() => {
              if (!canApply) return;
              setCustomFrom(draftFrom.trim());
              setCustomTo(draftTo.trim());
            }}
          />
        </View>
      ) : null}

      <View style={[styles.grid, { rowGap: t.space.lg }]}>
        {rows.map((r) => <StatCell key={r.label} row={r} />)}
      </View>
    </Section>
  );
}

function StatCell({ row }: { row: StatRow }): React.JSX.Element {
  const t = useTheme();
  const color = row.tone === 'bull' ? t.colors.bull : row.tone === 'bear' ? t.colors.bear : t.colors.textPrimary;
  return (
    <View style={styles.cell} accessible accessibilityLabel={`${row.label}: ${row.value}`}>
      <AppText variant="caption" tone="muted" weight="600" style={styles.upper}>{row.label}</AppText>
      <AppText variant={row.emphasis ? 'h2' : 'title'} weight="700" mono color={color} style={styles.cellValue}>
        {row.value}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  gapBelow: { marginBottom: 24 },
  title: { marginTop: 2 },
  filters: { flexDirection: 'row', gap: 8, marginTop: 12 },
  filter: { flex: 1 },
  custom: { marginTop: 12, gap: 8 },
  customRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  dateInput: { flex: 1 },
  to: { marginTop: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 20 },
  cell: { width: '50%', paddingRight: 12 },
  upper: { textTransform: 'uppercase', letterSpacing: 0.6 },
  cellValue: { marginTop: 4 },
});
