import React, { memo } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { WatchlistButton } from '@/components/market/WatchlistButton';
import { AppText, AssetIcon } from '@/components/ui';
import { useTheme } from '@/theme';
import type { Instrument } from '@/types/trading';
import {
  LIST_DOWN,
  LIST_UP,
  fmtListPrice,
  fmtVolume,
  listChange,
  listName,
  sectorBar,
  sectorCaption,
  sectorPerfText,
  type SectorSummary,
} from '@/utils/markets';

import { SynthSparkline } from './Sparklines';

/**
 * The MarketList table as phone rows. The web's 12-column grid
 * (Company 5 · Market Price (1D) 4 · Volume 3) keeps its three columns;
 * the name column takes what the two figure columns leave, so names are
 * not cut to a few letters on a narrow screen.
 */

export const PRICE_COL = 118;
export const VOLUME_COL = 64;
export const TABLE_RADIUS = 16;

/** Side borders + surface for every table part; the first/last add their caps. */
export function useTableCell(): (edge?: 'top' | 'bottom' | 'both') => ViewStyle {
  const t = useTheme();
  return (edge) => ({
    backgroundColor: t.colors.surface,
    borderColor: t.colors.borderDark,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    ...(edge === 'top' || edge === 'both'
      ? { borderTopWidth: 1, borderTopLeftRadius: TABLE_RADIUS, borderTopRightRadius: TABLE_RADIUS }
      : null),
    ...(edge === 'bottom' || edge === 'both'
      ? { borderBottomWidth: 1, borderBottomLeftRadius: TABLE_RADIUS, borderBottomRightRadius: TABLE_RADIUS }
      : null),
  });
}

/** The grey column-header strip at the top of a table card. */
export function TableHeader({ columns }: { columns: { label: string; style: StyleProp<ViewStyle>; align?: 'left' | 'right' }[] }): React.JSX.Element {
  const t = useTheme();
  const cell = useTableCell();
  return (
    <View style={[cell('top'), styles.header, { backgroundColor: t.colors.bgCard, borderBottomColor: t.colors.borderSubtle }]}>
      {columns.map((c) => (
        <View key={c.label} style={c.style}>
          <AppText variant="small" tone="muted" align={c.align ?? 'left'}>{c.label}</AppText>
        </View>
      ))}
    </View>
  );
}

/** A message row inside a table card ("Loading markets…", "No instruments available."). */
export function TableMessage({ children }: { children: React.ReactNode }): React.JSX.Element {
  const cell = useTableCell();
  return <View style={[cell('bottom'), styles.message]}>{children}</View>;
}

/** The sparkline column (≥ 640 dp) sits inside "Market Price (1D)", as on the web. */
export const SPARK_W = 110;

export const marketColumns = (showSpark: boolean): { label: string; style: ViewStyle; align?: 'left' | 'right' }[] => [
  { label: 'Company', style: { flex: 1 } },
  { label: 'Market Price (1D)', style: { width: PRICE_COL + (showSpark ? SPARK_W + 12 : 0) }, align: 'right' },
  { label: 'Volume', style: { width: VOLUME_COL }, align: 'right' },
];

export interface MarketRowProps {
  row: Instrument;
  /** Live price if one has arrived, else the catalogue's. */
  price: string | null;
  index: number;
  last: boolean;
  showSpark: boolean;
  onOpen: (symbol: string) => void;
}

/** One instrument row → the stock page. */
export const MarketRow = memo(function MarketRow({ row, price, index, last, showSpark, onOpen }: MarketRowProps): React.JSX.Element {
  const t = useTheme();
  const cell = useTableCell();
  const ch = listChange(row, price);
  const color = ch.positive ? LIST_UP : LIST_DOWN;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${listName(row)} ${row.symbol}`}
      testID={`market-row-${row.symbol}`}
      onPress={() => onOpen(row.symbol)}
      style={({ pressed }) => [
        cell(last ? 'bottom' : undefined),
        styles.row,
        !last ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.colors.borderSubtle } : null,
        pressed ? { backgroundColor: t.colors.bgHover } : null,
      ]}
    >
      <View style={styles.company}>
        <AssetIcon row={row} size={36} />
        <View style={styles.flex}>
          <AppText variant="body" numberOfLines={1}>{listName(row)}</AppText>
          <AppText variant="caption" tone="muted" numberOfLines={1}>{row.symbol}</AppText>
        </View>
        <WatchlistButton symbol={row.symbol} row={row} variant="inline" />
      </View>

      {showSpark ? (
        <SynthSparkline change={row.change24h} seed={index} positive={ch.positive} width={SPARK_W} height={32} />
      ) : null}

      <View style={[styles.priceCol, { width: PRICE_COL }]}>
        <AppText variant="bodyStrong" mono align="right" numberOfLines={1} testID={`market-price-${row.symbol}`}>
          {fmtListPrice(price, row.pricePrecision, row.quoteCurrency)}
        </AppText>
        <AppText variant="smallStrong" mono align="right" color={color}>
          {ch.abs && ch.pct ? (
            <>
              {`${ch.abs} `}
              <AppText variant="small" weight="500" mono color={color}>{ch.pct}</AppText>
            </>
          ) : '—'}
        </AppText>
      </View>

      <View style={{ width: VOLUME_COL }}>
        <AppText variant="body" mono align="right" numberOfLines={1}>{fmtVolume(row.volume24h)}</AppText>
      </View>
    </Pressable>
  );
});

/* ── Sectors ──────────────────────────────────────────────────────────── */

export const SECTOR_COLUMNS: { label: string; style: ViewStyle; align?: 'left' | 'right' }[] = [
  { label: 'Sector', style: { flex: 5 } },
  { label: 'Gainers/Losers', style: { flex: 4 } },
  { label: '1D price change', style: { flex: 3 }, align: 'right' },
];

/** One sector row → the stock page of its best performer. */
export function SectorRow({
  sector,
  last,
  wide,
  onOpen,
}: {
  sector: SectorSummary;
  last: boolean;
  /** ≥ 640 dp: the web's `sm:` caption under the label. */
  wide: boolean;
  onOpen: (symbol: string) => void;
}): React.JSX.Element {
  const t = useTheme();
  const cell = useTableCell();
  const bar = sectorBar(sector);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={sector.label}
      testID={`sector-row-${sector.key}`}
      onPress={() => { if (sector.top?.symbol) onOpen(sector.top.symbol); }}
      style={({ pressed }) => [
        cell(last ? 'bottom' : undefined),
        styles.row,
        !last ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.colors.borderSubtle } : null,
        pressed ? { backgroundColor: t.colors.bgHover } : null,
      ]}
    >
      <View style={[styles.company, { flex: 5 }]}>
        <View style={[styles.sectorTile, { backgroundColor: `${sector.tint}15` }]}>
          <AppText variant="bodyStrong" weight="700" color={sector.tint}>{sector.label.slice(0, 1)}</AppText>
        </View>
        <View style={styles.flex}>
          <AppText variant="bodyStrong" numberOfLines={1}>{sector.label}</AppText>
          {wide ? <AppText variant="caption" tone="muted" numberOfLines={1}>{sectorCaption(sector)}</AppText> : null}
        </View>
      </View>

      <View style={{ flex: 4 }}>
        <View style={styles.barWrap}>
          <View style={styles.barCounts}>
            <AppText variant="bodyStrong" color={LIST_UP}>{String(sector.gainers)}</AppText>
            <AppText variant="bodyStrong" color={LIST_DOWN}>{String(sector.losers)}</AppText>
          </View>
          <View style={[styles.bar, { backgroundColor: t.colors.bgHover }]}>
            <View style={{ width: `${bar.gPct}%`, backgroundColor: LIST_UP }} />
            <View style={{ width: `${bar.lPct}%`, backgroundColor: LIST_DOWN }} />
          </View>
        </View>
      </View>

      <View style={{ flex: 3 }}>
        <AppText variant="bodyStrong" mono align="right" color={bar.positive ? LIST_UP : LIST_DOWN}>
          {sectorPerfText(sector.perf)}
        </AppText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  message: { paddingHorizontal: 16, paddingVertical: 40, alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  company: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 },
  priceCol: { alignItems: 'flex-end' },
  sectorTile: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  barWrap: { width: '100%', maxWidth: 260 },
  barCounts: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  bar: { flexDirection: 'row', height: 3, borderRadius: 999, overflow: 'hidden' },
});
