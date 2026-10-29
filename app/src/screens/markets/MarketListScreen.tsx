import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  View,
  useWindowDimensions,
  type ListRenderItem,
  type ViewToken,
} from 'react-native';

import { refreshInstruments, useInstruments } from '@/api/instruments.api';
import { ExploreLinksCard, PortfolioCard, TopMoversCard } from '@/components/markets/MarketSidebar';
import {
  MarketRow,
  SECTOR_COLUMNS,
  SectorRow,
  TableHeader,
  TableMessage,
  marketColumns,
} from '@/components/markets/MarketRows';
import { livePriceOf, useLivePrices } from '@/components/markets/useLivePrices';
import { MarketNewsCard } from '@/components/news/MarketNews';
import { AppText, Button, Screen, useScreenChrome } from '@/components/ui';
import type { AppScreenProps } from '@/navigation/types';
import { useTheme } from '@/theme';
import type { Instrument } from '@/types/trading';
import {
  SPARKLINE_MIN_WIDTH,
  isSectorsView,
  marketListTitle,
  marketViewConfig,
  sectorFor,
  sortMarketRows,
  summariseSectors,
  type SectorDef,
} from '@/utils/markets';

/**
 * MarketList — `/markets?view=most-traded|gainers|losers|volume|sectors`
 * (`&sector=indices|stocks|futures|idxfut|comm|gold` narrows a ranking to
 * one segment — the Explore card's tiles link with it), the full-page list
 * behind Explore's "See more" / "See all" links (client/src/pages/MarketList.jsx).
 *
 * The web's two columns stack on a phone as they do on the web's own narrow
 * layout: the ranked table, then Your Portfolio, Top Movers, Market News and
 * the Explore links.
 *
 * ── Live prices ───────────────────────────────────────────────────────
 * The web subscribes a ticker for EVERY instrument in the catalogue. Here
 * only the rows on screen (plus the three top movers) are subscribed, the
 * set follows the scroll, ticks are coalesced into one render per 300 ms,
 * and everything is released while another screen is on top
 * (components/markets/useLivePrices). The ranking itself never depended on
 * the live price — it sorts by 24h change and volume — so what the trader
 * sees is the same list with live prices where they are looking.
 *
 * ── Differences from the web, on purpose ──────────────────────────────
 *   • A failed catalogue load shows its message and "Try again" (the web
 *     shows "No instruments available." and needs a reload). Pull to refresh
 *     re-reads the catalogue and the portfolio card.
 *   • A missing 24h change reads "—", not "+0.00 (+0.00%)" (utils/markets).
 */

/** Rows subscribed before the list reports what is visible. */
const INITIAL_LIVE_ROWS = 15;
/** Wait for the scroll to settle before re-subscribing. */
const VIEWABLE_DEBOUNCE_MS = 200;
const VIEWABILITY = { itemVisiblePercentThreshold: 1, minimumViewTime: 0 };

export function MarketListScreen({ route, navigation }: AppScreenProps<'MarketList'>): React.JSX.Element {
  const view = route.params?.view || 'most-traded';
  const sector = sectorFor(route.params?.sector);
  const { rows, loading, error } = useInstruments();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshKey((k) => k + 1);
    try { await refreshInstruments(); } finally { setRefreshing(false); }
  }, []);
  const onRetry = useCallback(() => { void refreshInstruments(); }, []);
  const openStock = useCallback((symbol: string) => navigation.navigate('StockDetail', { symbol }), [navigation]);

  const shared = { rows, loading, error, refreshing, onRefresh, onRetry, refreshKey, openStock };
  return isSectorsView(view) ? <SectorsList {...shared} /> : <RankedList view={view} sector={sector} {...shared} />;
}

interface ListProps {
  rows: Instrument[];
  loading: boolean;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  onRetry: () => void;
  refreshKey: number;
  openStock: (symbol: string) => void;
}

/* ── Title block ──────────────────────────────────────────────────────── */

function Title({ title, caption }: { title: string; caption: string }): React.JSX.Element {
  return (
    <View style={styles.titleBlock}>
      <AppText variant="h1" accessibilityRole="header">{title}</AppText>
      <AppText variant="body" tone="secondary" style={styles.mt4}>{caption}</AppText>
    </View>
  );
}

/** "Loading…" / the failure with a retry / the empty line, inside the table card. */
function ListState({
  loading,
  error,
  onRetry,
  loadingText,
  emptyText,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  loadingText: string;
  emptyText: string;
}): React.JSX.Element {
  if (loading) {
    return <TableMessage><AppText variant="body" tone="muted" align="center">{loadingText}</AppText></TableMessage>;
  }
  if (error) {
    return (
      <TableMessage>
        <AppText variant="body" tone="bear" align="center">{error}</AppText>
        <Button title="Try again" variant="secondary" size="sm" leftIcon="refresh" onPress={onRetry} style={styles.mt12} />
      </TableMessage>
    );
  }
  return <TableMessage><AppText variant="body" tone="muted" align="center">{emptyText}</AppText></TableMessage>;
}

/**
 * The right-hand cards, under the table. Inside the FlatList it also draws
 * the page footer (CmsFooter slot) edge to edge, which Screen draws itself
 * only for a scrolling screen.
 */
function Sidebar({ rows, refreshKey, withFooter }: { rows: Instrument[]; refreshKey: number; withFooter: boolean }): React.JSX.Element {
  const t = useTheme();
  const { Footer } = useScreenChrome();
  return (
    <>
      <View style={styles.sidebar}>
        <PortfolioCard refreshKey={refreshKey} />
        <TopMoversCard rows={rows} />
        <MarketNewsCard instruments={rows} refreshKey={refreshKey} />
        <ExploreLinksCard />
      </View>
      {withFooter && Footer ? (
        <View style={{ marginHorizontal: -t.space.gutter, marginBottom: -t.space.page, marginTop: t.space.page }}>
          <Footer />
        </View>
      ) : null}
    </>
  );
}

/* ── Ranked views ─────────────────────────────────────────────────────── */

function RankedList({ view, sector, rows, loading, error, refreshing, onRefresh, onRetry, refreshKey, openStock }: ListProps & { view: string; sector: SectorDef | null }): React.JSX.Element {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const showSpark = width >= SPARKLINE_MIN_WIDTH;
  const cfg = marketViewConfig(view);
  const list = useMemo(() => (loading ? [] : sortMarketRows(rows, view, sector)), [rows, view, sector, loading]);
  const listRef = useRef<FlatList<Instrument>>(null);

  // Which rows are on screen — the live subscription follows them.
  const [visible, setVisible] = useState<string[] | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken<Instrument>[] }) => {
    const syms = viewableItems.map((v) => v.item?.symbol).filter((s): s is string => !!s);
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      pending.current = null;
      setVisible((prev) => (prev && prev.length === syms.length && prev.every((s, i) => s === syms[i]) ? prev : syms));
    }, VIEWABLE_DEBOUNCE_MS);
  }).current;
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); }, []);

  // A new ranking starts at the top, with the first screenful live.
  useEffect(() => {
    setVisible(null);
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [view, sector]);

  const liveSymbols = useMemo(
    () => visible ?? list.slice(0, INITIAL_LIVE_ROWS).map((r) => r.symbol),
    [visible, list],
  );
  const prices = useLivePrices(liveSymbols);

  const renderItem: ListRenderItem<Instrument> = useCallback(({ item, index }) => (
    <MarketRow
      row={item}
      price={livePriceOf(prices, item)}
      index={index}
      last={index === list.length - 1}
      showSpark={showSpark}
      onOpen={openStock}
    />
  ), [prices, list.length, showSpark, openStock]);

  return (
    <Screen scroll={false} padded={false}>
      <FlatList
        ref={listRef}
        testID="market-list"
        data={list}
        keyExtractor={(r) => r.symbol}
        renderItem={renderItem}
        extraData={prices}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={VIEWABILITY}
        initialNumToRender={INITIAL_LIVE_ROWS}
        maxToRenderPerBatch={20}
        windowSize={9}
        removeClippedSubviews
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingTop: t.space.page, paddingBottom: t.space.page }}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={t.colors.primary}
            colors={[t.colors.primary]}
            progressBackgroundColor={t.colors.surface}
          />
        )}
        ListHeaderComponent={(
          <>
            <Title title={marketListTitle(view, sector)} caption={cfg.caption} />
            <TableHeader columns={marketColumns(showSpark)} />
          </>
        )}
        ListEmptyComponent={(
          <ListState
            loading={loading}
            error={error}
            onRetry={onRetry}
            loadingText="Loading markets…"
            emptyText="No instruments available."
          />
        )}
        ListFooterComponent={<Sidebar rows={rows} refreshKey={refreshKey} withFooter />}
      />
    </Screen>
  );
}

/* ── Sectors ──────────────────────────────────────────────────────────── */

function SectorsList({ rows, loading, error, refreshing, onRefresh, onRetry, refreshKey, openStock }: ListProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const sectors = useMemo(() => summariseSectors(rows), [rows]);

  return (
    <Screen scroll onRefresh={onRefresh} refreshing={refreshing}>
      <Title title="All sectors" caption="Sector performance over the last 24 hours." />
      <TableHeader columns={SECTOR_COLUMNS} />
      {loading || sectors.length === 0 ? (
        <ListState
          loading={loading}
          error={error}
          onRetry={onRetry}
          loadingText="Loading sectors…"
          emptyText="No sectors available."
        />
      ) : sectors.map((s, i) => (
        <SectorRow
          key={s.key}
          sector={s}
          last={i === sectors.length - 1}
          wide={width >= SPARKLINE_MIN_WIDTH}
          onOpen={openStock}
        />
      ))}
      <Sidebar rows={rows} refreshKey={refreshKey} withFooter={false} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  titleBlock: { marginBottom: 20 },
  mt4: { marginTop: 4 },
  mt12: { marginTop: 12 },
  sidebar: { marginTop: 24, gap: 16 },
});
