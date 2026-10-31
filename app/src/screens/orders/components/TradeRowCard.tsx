import React, { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText, AssetIcon, Badge } from '@/components/ui';
import { useTheme } from '@/theme';
import type { HistoryRecord, Instrument } from '@/types/trading';

import {
  NONE,
  executedBy,
  fmtFee,
  fmtLot,
  fmtRowPrice,
  formatDateTime,
  isTrade,
  pnlText,
  pnlTone,
  recordStatus,
  remarkFor,
  sizeOf,
  ticketShort,
} from '../ordersLogic';

/** Orders.jsx `SidePill` — ↗ BUY in bull, ↙ SELL in bear. */
export function SidePill({ side }: { side: string }): React.JSX.Element {
  const buy = side === 'BUY';
  return <Badge label={`${buy ? '↗' : '↙'} ${side}`} tone={buy ? 'bull' : 'bear'} />;
}

/** Orders.jsx `ExecutedByPill` — ADMIN when an admin force-closed it, otherwise the trader (SELF). */
export function ExecutedByPill({ row }: { row: Pick<HistoryRecord, 'closeReason'> }): React.JSX.Element {
  const who = executedBy(row);
  // The user never sees the word "admin": a desk-booked/closed trade reads MANUAL.
  return <Badge label={who === 'ADMIN' ? 'MANUAL' : who} tone={who === 'ADMIN' ? 'warn' : 'info'} size="xs" />;
}

/** Orders.jsx `RecordStatusPill` — CLOSED (bull), CANCELLED (neutral), REJECTED (bear). */
export function RecordStatusPill({ row }: { row: Pick<HistoryRecord, 'status'> }): React.JSX.Element {
  const st = recordStatus(row);
  return <Badge label={st.label} tone={st.tone} size="xs" />;
}

function Cell({ label, value, mono = true, tone, color, wide }: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'muted' | 'secondary';
  color?: string;
  wide?: boolean;
}): React.JSX.Element {
  return (
    <View style={[styles.cell, wide ? styles.cellWide : null]}>
      <AppText variant="micro" tone="muted" style={styles.cellLabel}>{label}</AppText>
      <AppText variant="small" tone={color ? undefined : (tone ?? 'primary')} color={color} mono={mono} numberOfLines={wide ? 2 : 1}>{value}</AppText>
    </View>
  );
}

/**
 * One record — a table row of Orders.jsx HistoryTable as a card, every column
 * kept: Order Id, Symbol, Side, Status, Size, Open / Close Price, Commission,
 * Charge, Executed By, Remarks, Opened / Closed At and P/L. An order that
 * never opened shows a dash where a trade has a figure — never 0.
 */
export const TradeRowCard = memo(function TradeRowCard({ row, instrument }: {
  row: HistoryRecord;
  /** The catalogue's row for the symbol, when known — for the icon and the price precision. */
  instrument: Instrument | null;
}): React.JSX.Element {
  const t = useTheme();
  const trade = isTrade(row);
  const tone = pnlTone(row);
  return (
    <View
      testID={`trade-row-${row.kind}-${row.id}`}
      style={[styles.card, { backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark, borderRadius: t.radius.xl }]}
    >
      <View style={styles.head}>
        <AssetIcon row={instrument ?? { symbol: row.symbol }} size={20} round />
        <View style={styles.symbol}>
          <AppText variant="bodyStrong" numberOfLines={1}>{row.symbol}</AppText>
        </View>
        <SidePill side={row.side} />
        <RecordStatusPill row={row} />
      </View>

      <View style={styles.meta}>
        <AppText variant="caption" tone="secondary" mono numberOfLines={1} style={styles.flex}>
          {ticketShort(row.id)}
        </AppText>
        {trade ? <ExecutedByPill row={row} /> : <AppText variant="caption" tone="muted">{NONE}</AppText>}
        <AppText variant="bodyStrong" mono color={tone === 'bull' ? t.colors.bull : tone === 'bear' ? t.colors.bear : t.colors.textMuted}>
          {pnlText(row)}
        </AppText>
      </View>

      <View style={[styles.grid, { borderTopColor: t.colors.borderSubtle }]}>
        <Cell label="Size" value={fmtLot(sizeOf(row))} />
        <Cell label="Open Price" value={fmtRowPrice(row.entryPrice, instrument)} />
        <Cell label="Close Price" value={fmtRowPrice(row.closePrice, instrument)} />
        <Cell label="Commission" value={fmtFee(row, row.commission)} tone="secondary" />
        <Cell label="Charge" value={fmtFee(row, row.swap)} tone="secondary" />
        <Cell
          label="Remarks"
          value={remarkFor(row)}
          mono={false}
          tone="secondary"
          color={row.status === 'REJECTED' ? t.colors.bear : undefined}
          wide
        />
        <Cell label="Opened At" value={formatDateTime(row.openedAt || row.createdAt)} tone="secondary" wide />
        <Cell label="Closed At" value={formatDateTime(row.closedAt)} tone="secondary" wide />
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  card: { borderWidth: 1, padding: 12, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  symbol: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex: { flex: 1, minWidth: 0 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', borderTopWidth: 1, paddingTop: 8, rowGap: 8 },
  cell: { width: '33.33%', paddingRight: 6 },
  cellWide: { width: '100%' },
  cellLabel: { textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 1 },
});
