import { useIsFocused } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { refreshInstruments, useInstruments, useRecentlyViewed } from '@/api/instruments.api';
import { ExploreGlyph } from '@/components/explore/ExploreGlyph';
import {
  ChangePill,
  ChangeText,
  ChevronLink,
  ExploreSectionHeader,
  GainersLosersBar,
  GlyphTile,
  Sparkline,
} from '@/components/explore/ExploreParts';
import { WatchlistButton } from '@/components/market/WatchlistButton';
import { MarketNewsSection } from '@/components/news/MarketNews';
import {
  AppText,
  AssetIcon,
  BottomSheet,
  ErrorView,
  Screen,
  Skeleton,
  useScreenChrome,
} from '@/components/ui';
import type { AppScreenProps } from '@/navigation/types';
import { makeStyles, useTheme } from '@/theme';
import {
  DOWN_COLOR,
  EXPLORE_COPY,
  MOVER_SEGMENTS,
  MOVER_TABS,
  PRODUCTS,
  SECTOR_DEFS,
  UP_COLOR,
  absChangeOf,
  categoryButtonLabel,
  changePill,
  fmtExplorePrice,
  fmtSectorPerf,
  fmtVolume,
  liveSymbolsKey,
  livedRows,
  moverRows,
  mostTradedRows,
  quoteOf,
  recentlyViewedRows,
  sectorRows,
  synthSpark,
  toggleCategory,
  type MoverTab,
  type Product,
  type SectorRow,
} from '@/utils/explore';

import { useExploreLivePrices } from './useExploreLivePrices';

/**
 * Explore — client/src/pages/Explore.jsx, `/explore`: Indian markets only.
 * The catalogue is the server's, already scoped by the admin's market-
 * segment switches (India-only, F&O segments), so every section reads it
 * as it comes.
 *
 * Sections, in the web's phone order: recently viewed, most traded, market
 * movers (Gainers / Losers / Most Active / Trending, a segment multi-select —
 * Indices, Stocks, Futures, Commodities — and a sector filter), sectors
 * trending today, Products & Tools, then Market News (components/news).
 * `/explore#market-news` (route param `section`) opens at Market News.
 *
 * The web's "Your activity" card (open positions and pending orders) is not
 * here: it is the Positions page (screens/positions), the rail's "Positions"
 * pill.
 *
 * Differences from the web, on purpose:
 *   - Live prices: the catalogue's instruments, released while the screen is
 *     not focused, ticks coalesced (useExploreLivePrices).
 *   - A failed catalogue read shows the server's message and Retry where the
 *     web says "No instruments available yet.".
 *   - Pull to refresh re-reads the catalogue and the news.
 */

type Item = { key: string; kind: 'recent' | 'mostTraded' | 'movers' | 'sectors' | 'products' | 'news' };

export function ExploreScreen({ navigation, route }: AppScreenProps<'Explore'>): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  const copy = EXPLORE_COPY;
  const section = route.params?.section;
  const focused = useIsFocused();
  const { Footer } = useScreenChrome();

  const { rows: instruments, loading, error: instrumentsError } = useInstruments();

  /* ── Movers filters ─────────────────────────────────────────────── */
  const [moverTab, setMoverTab] = useState<MoverTab>('Gainers');
  const [moverCategories, setMoverCategories] = useState<string[]>([]);
  const [catMenuOpen, setCatMenuOpen] = useState(false);
  const [sectorKey, setSectorKey] = useState<string | null>(null);
  const sectorDef = useMemo(() => SECTOR_DEFS.find((d) => d.key === sectorKey) ?? null, [sectorKey]);

  /* ── Live prices ────────────────────────────────────────────────── */
  const symbolsKey = useMemo(() => liveSymbolsKey(instruments, []), [instruments]);
  const priceMap = useExploreLivePrices(symbolsKey, focused);
  const lived = useMemo(() => livedRows(instruments, priceMap), [instruments, priceMap]);

  /* ── Sections ───────────────────────────────────────────────────── */
  const recentSymbols = useRecentlyViewed();
  const recentlyViewed = useMemo(() => recentlyViewedRows(recentSymbols, lived), [recentSymbols, lived]);
  const mostTraded = useMemo(() => mostTradedRows(lived), [lived]);
  const sectors = useMemo(() => sectorRows(lived), [lived]);
  const movers = useMemo(
    () => moverRows(lived, moverTab, sectorDef, moverCategories),
    [lived, moverTab, sectorDef, moverCategories],
  );

  /* ── Navigation ─────────────────────────────────────────────────── */
  const openTrade = useCallback((sym: string) => navigation.navigate('StockDetail', { symbol: sym }), [navigation]);
  const goProduct = useCallback((p: Product) => {
    switch (p.route) {
      case 'Wallet': navigation.navigate('Wallet', undefined, { pop: true }); break;
      case 'Partner': navigation.navigate('Partner'); break;
      case 'Plans': navigation.navigate('Plans'); break;
      case 'Helpdesk': navigation.navigate('Helpdesk'); break;
      case 'Alerts': navigation.navigate('Alerts'); break;
      case 'Trade': navigation.navigate('Trade'); break;
      default: break;
    }
  }, [navigation]);

  /* ── Refresh ────────────────────────────────────────────────────── */
  const [refreshing, setRefreshing] = useState(false);
  const [newsKey, setNewsKey] = useState(0);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setNewsKey((k) => k + 1);
    try {
      await refreshInstruments();
    } finally {
      setRefreshing(false);
    }
  }, []);

  /* ── The list ───────────────────────────────────────────────────── */
  const items = useMemo((): Item[] => {
    const out: Item[] = [];
    if (recentlyViewed.length > 0) out.push({ key: 'recent', kind: 'recent' });
    out.push({ key: 'mostTraded', kind: 'mostTraded' }, { key: 'movers', kind: 'movers' }, { key: 'sectors', kind: 'sectors' });
    out.push({ key: 'products', kind: 'products' }, { key: 'news', kind: 'news' });
    return out;
  }, [recentlyViewed.length]);

  const listRef = useRef<FlatList<Item>>(null);
  const scrollToKind = useCallback((kind: Item['kind'], animated = true): void => {
    const index = items.findIndex((i) => i.kind === kind);
    if (index < 0) return;
    setTimeout(() => {
      listRef.current?.scrollToIndex({ index, animated, viewPosition: 0 });
    }, 60);
  }, [items]);
  const scrollToMovers = (): void => scrollToKind('movers');

  // `/explore#market-news` — open at the news, then forget the anchor so a
  // later visit starts at the top.
  useEffect(() => {
    if (section !== 'market-news') return;
    scrollToKind('news', false);
    navigation.setParams({ section: undefined });
  }, [section, scrollToKind, navigation]);

  /* ── Blocks ─────────────────────────────────────────────────────── */

  const renderRecent = (): React.JSX.Element => (
    <View style={styles.section}>
      <AppText variant="h3" weight="700" style={styles.recentTitle}>Recently viewed</AppText>
      <View style={styles.recentWrap}>
        {recentlyViewed.map((r) => {
          const ch = Number(r.change24h);
          const positive = Number.isFinite(ch) ? ch >= 0 : true;
          const pill = changePill(ch);
          return (
            <Pressable key={r.symbol} accessibilityRole="button" onPress={() => openTrade(r.symbol)} style={styles.recentItem}>
              <AssetIcon row={r} size={36} />
              <AppText variant="bodyStrong" style={styles.recentSym}>{r.symbol}</AppText>
              {pill ? <AppText variant="smallStrong" color={positive ? UP_COLOR : DOWN_COLOR}>{pill.text}</AppText> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  const renderMostTraded = (): React.JSX.Element => (
    <View style={styles.section} testID="explore-most-traded">
      <ExploreSectionHeader
        title="Most traded"
        caption={copy.mostTraded}
        action={<ChevronLink label="View all" small onPress={() => navigation.navigate('MarketList', { view: 'most-traded' })} />}
      />
      {loading ? (
        <View style={styles.grid}>
          {Array.from({ length: 4 }).map((_, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <View key={i} style={[s.tradedCard, styles.gridCell]}>
              <Skeleton width={40} height={40} radius={12} />
              <Skeleton width="70%" height={12} style={styles.skelGap} />
              <Skeleton height={28} style={styles.skelGap} />
              <Skeleton width="75%" height={12} style={styles.skelGapSm} />
            </View>
          ))}
        </View>
      ) : null}
      {!loading && instrumentsError && mostTraded.length === 0 ? (
        <ErrorView error={new Error(instrumentsError)} onRetry={() => { void refreshInstruments(); }} compact />
      ) : null}
      {!loading && !instrumentsError && mostTraded.length === 0 ? (
        <View style={s.emptyBox}><AppText variant="body" tone="muted" align="center">No instruments available yet.</AppText></View>
      ) : null}
      {!loading && mostTraded.length > 0 ? (
        <>
          <View style={styles.grid}>
            {mostTraded.slice(0, 4).map((a) => (
              <Pressable
                key={a.symbol}
                accessibilityRole="button"
                accessibilityLabel={a.name || a.symbol}
                onPress={() => openTrade(a.symbol)}
                style={({ pressed }) => [s.tradedCard, styles.gridCell, pressed && { borderColor: t.alpha(t.colors.primary, 0.3) }]}
              >
                <View style={styles.watchOverlay}><WatchlistButton symbol={a.symbol} row={a} /></View>
                <AssetIcon row={a} size={44} />
                <AppText variant="body" weight="500" numberOfLines={1} style={styles.tradedName}>{a.name || a.symbol}</AppText>
                <AppText variant="h2" mono numberOfLines={1} adjustsFontSizeToFit style={styles.tradedPrice}>
                  {fmtExplorePrice(a.lastPrice, a.pricePrecision, quoteOf(a))}
                </AppText>
                <View style={styles.tradedChange}>
                  <ChangeText absChange={absChangeOf(a)} pct={Number(a.change24h)} precision={a.pricePrecision} currency={quoteOf(a)} />
                </View>
              </Pressable>
            ))}
          </View>
          <ChevronLink label="See more" onPress={() => navigation.navigate('MarketList', { view: 'most-traded' })} style={styles.seeMore} />
        </>
      ) : null}
    </View>
  );

  const pillStyle = (active: boolean) => [
    s.filterPill,
    active ? { borderColor: t.colors.textPrimary, backgroundColor: t.colors.surface } : null,
  ];

  const renderMovers = (): React.JSX.Element => (
    <View style={styles.section} testID="explore-movers">
      <AppText variant="h3" weight="700">Market movers</AppText>
      <AppText variant="small" tone="secondary" style={styles.caption}>{copy.movers}</AppText>
      {sectorDef ? (
        <View style={[styles.sectorChip, { backgroundColor: t.colors.primarySoft }]}>
          <AppText variant="smallStrong" color={t.colors.primaryText}>{`Filtered: ${sectorDef.label}`}</AppText>
          <Pressable accessibilityRole="button" accessibilityLabel="Clear sector filter" onPress={() => setSectorKey(null)} hitSlop={8}>
            <ExploreGlyph name="close" size={12} color={t.colors.primaryText} />
          </Pressable>
        </View>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pills} style={styles.pillsRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Filter by category"
          onPress={() => setCatMenuOpen((o) => !o)}
          style={[s.filterPill, styles.catBtn]}
        >
          <AppText variant="body" tone="secondary">{categoryButtonLabel(moverCategories)}</AppText>
          <ExploreGlyph name="caret" size={12} color={t.colors.textSecondary} strokeWidth={2.4} />
        </Pressable>
        {MOVER_TABS.map((tab) => {
          const active = moverTab === tab;
          return (
            <Pressable
              key={tab}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => setMoverTab(tab)}
              style={pillStyle(active)}
            >
              <AppText variant="body" weight={active ? '600' : '400'} tone={active ? 'primary' : 'secondary'}>{tab}</AppText>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={s.tableCard}>
        {loading ? (
          <AppText variant="body" tone="muted" align="center" style={styles.tableMsg}>Loading market data…</AppText>
        ) : movers.length === 0 ? (
          <AppText variant="body" tone="muted" align="center" style={styles.tableMsg}>No assets match this filter.</AppText>
        ) : movers.map((m, idx) => {
          const change = Number(m.change24h);
          const vol = fmtVolume(m.volume24h);
          return (
            <Pressable
              key={m.symbol}
              accessibilityRole="button"
              accessibilityLabel={m.symbol}
              onPress={() => openTrade(m.symbol)}
              style={({ pressed }) => [
                styles.moverRow,
                idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.borderSubtle },
                pressed && { backgroundColor: t.colors.bgHover },
              ]}
            >
              <AssetIcon row={m} size={34} />
              <View style={styles.flex}>
                <AppText variant="bodyStrong" numberOfLines={1}>{m.symbol}</AppText>
                <AppText variant="caption" tone="muted" numberOfLines={1}>{m.name || ''}</AppText>
                <AppText variant="caption" tone="secondary" mono numberOfLines={1}>{`Vol ${vol}`}</AppText>
              </View>
              <Sparkline points={synthSpark(change, idx)} positive={Number.isFinite(change) ? change >= 0 : true} width={56} height={28} />
              <View style={styles.moverRight}>
                <AppText variant="body" mono numberOfLines={1}>{fmtExplorePrice(m.lastPrice, m.pricePrecision, quoteOf(m))}</AppText>
                <ChangePill value={change} />
              </View>
              <WatchlistButton symbol={m.symbol} row={m} variant="inline" />
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  const renderSectors = (): React.JSX.Element => (
    <View style={styles.section} testID="explore-sectors">
      <AppText variant="h2" style={styles.sectorsTitle}>Sectors trending today</AppText>
      {loading ? (
        <View style={[s.tableCard, styles.sectorSkel]}>
          {Array.from({ length: 5 }).map((_, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <Skeleton key={i} height={40} />
          ))}
        </View>
      ) : sectors.length === 0 ? (
        <View style={s.emptyBox}><AppText variant="body" tone="muted" align="center">No sector data yet.</AppText></View>
      ) : (
        <>
          <View style={s.tableCard}>
            <View style={[styles.sectorHead, { backgroundColor: t.colors.bgCard, borderBottomColor: t.colors.borderSubtle }]}>
              <AppText variant="small" tone="muted" style={styles.sectorCol1}>Sector</AppText>
              <AppText variant="small" tone="muted" style={styles.sectorCol2}>Gainers/Losers</AppText>
              <AppText variant="small" tone="muted" style={styles.sectorCol3} align="right">1D price change</AppText>
            </View>
            {sectors.map((sec: SectorRow, i) => {
              const active = sectorKey === sec.key;
              const positive = sec.perf >= 0;
              return (
                <Pressable
                  key={sec.key}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={sec.label}
                  onPress={() => {
                    setSectorKey((cur) => (cur === sec.key ? null : sec.key));
                    scrollToMovers();
                  }}
                  style={({ pressed }) => [
                    styles.sectorRow,
                    i < sectors.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.colors.borderSubtle },
                    { backgroundColor: active ? t.alpha(t.colors.primary, 0.05) : pressed ? t.colors.bgHover : 'transparent' },
                  ]}
                >
                  <View style={[styles.sectorCol1, styles.sectorName]}>
                    <GlyphTile name={sec.icon} tint={sec.tint} />
                    <View style={styles.flex}>
                      <AppText variant="bodyStrong" numberOfLines={1}>{sec.label}</AppText>
                      <AppText variant="caption" tone="muted" numberOfLines={1}>{`Top: ${sec.top?.symbol || '—'}`}</AppText>
                    </View>
                  </View>
                  <View style={styles.sectorCol2}>
                    <GainersLosersBar gainers={sec.gainers} losers={sec.losers} />
                  </View>
                  <AppText variant="bodyStrong" mono align="right" color={positive ? UP_COLOR : DOWN_COLOR} style={styles.sectorCol3}>
                    {fmtSectorPerf(sec.perf)}
                  </AppText>
                </Pressable>
              );
            })}
          </View>
          <ChevronLink label="See all sectors" onPress={() => navigation.navigate('MarketList', { view: 'sectors' })} style={styles.seeMore} />
        </>
      )}
    </View>
  );

  const renderProducts = (): React.JSX.Element => (
    <View style={styles.sectionAside} testID="explore-products">
      <AppText variant="title" style={styles.productsTitle}>Products &amp; Tools</AppText>
      <View style={s.productsCard}>
        {PRODUCTS.map((p, i) => (
          <Pressable
            key={p.to + p.label}
            accessibilityRole="link"
            accessibilityLabel={p.label}
            onPress={() => goProduct(p)}
            style={({ pressed }) => [
              styles.productRow,
              i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.borderSubtle },
              pressed && { backgroundColor: t.colors.bgHover },
            ]}
          >
            <GlyphTile name={p.icon} tint={p.tint} />
            <View style={styles.flex}>
              <AppText variant="bodyStrong" numberOfLines={1}>{p.label}</AppText>
              <AppText variant="caption" tone="muted" numberOfLines={1}>{p.caption}</AppText>
            </View>
            <ExploreGlyph name="chevron" size={14} color={t.colors.textMuted} />
          </Pressable>
        ))}
      </View>
    </View>
  );

  const renderNews = (): React.JSX.Element => (
    <View style={styles.sectionLarge}>
      <MarketNewsSection instruments={instruments} refreshKey={newsKey} />
    </View>
  );

  const renderItem = ({ item }: { item: Item }): React.JSX.Element | null => {
    let body: React.JSX.Element | null = null;
    switch (item.kind) {
      case 'recent': body = renderRecent(); break;
      case 'mostTraded': body = renderMostTraded(); break;
      case 'movers': body = renderMovers(); break;
      case 'sectors': body = renderSectors(); break;
      case 'products': body = renderProducts(); break;
      case 'news': body = renderNews(); break;
      default: body = null;
    }
    return <View style={styles.gutter}>{body}</View>;
  };

  return (
    <Screen scroll={false} padded={false} testID="explore-screen">
      <FlatList
        ref={listRef}
        data={items}
        extraData={[priceMap, lived, loading, moverTab, moverCategories, sectorKey, instrumentsError, t]}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={8}
        onScrollToIndexFailed={({ averageItemLength, index }) => {
          listRef.current?.scrollToOffset({ offset: averageItemLength * index, animated: true });
        }}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { void onRefresh(); }}
            tintColor={t.colors.primary}
            colors={[t.colors.primary]}
            progressBackgroundColor={t.colors.surface}
          />
        )}
        ListFooterComponent={(
          <>
            <View style={styles.tail} />
            {Footer ? <Footer /> : null}
          </>
        )}
      />

      {/* The asset-class multi-select — the web's dropdown, as a sheet. */}
      <BottomSheet open={catMenuOpen} onClose={() => setCatMenuOpen(false)} title="Filter by category" testID="explore-category-sheet">
        <View>
          {[{ key: '', label: 'All categories' }, ...MOVER_SEGMENTS].map((c) => {
            const all = c.key === '';
            const on = all ? moverCategories.length === 0 : moverCategories.includes(c.key);
            return (
              <Pressable
                key={c.key || 'all'}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                onPress={() => (all ? setMoverCategories([]) : setMoverCategories((prev) => toggleCategory(prev, c.key)))}
                style={({ pressed }) => [styles.catRow, pressed && { backgroundColor: t.colors.bgHover }]}
              >
                <AppText
                  variant="body"
                  weight={!all && on ? '600' : '400'}
                  color={!all && on ? t.colors.primaryText : t.colors.textSecondary}
                >
                  {c.label}
                </AppText>
                {on ? <ExploreGlyph name="check" size={14} color={!all ? t.colors.primaryText : t.colors.textSecondary} /> : null}
              </Pressable>
            );
          })}
        </View>
      </BottomSheet>

    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  tradedCard: {
    backgroundColor: t.colors.surface,
    borderColor: t.colors.borderDark,
    borderWidth: 1,
    borderRadius: 20,
    padding: t.space.lg,
  },
  emptyBox: {
    backgroundColor: t.colors.surface,
    borderColor: t.colors.borderDark,
    borderWidth: 1,
    borderRadius: 20,
    padding: 40,
  },
  filterPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: t.radius.full,
    borderWidth: 1,
    borderColor: t.colors.borderDark,
  },
  tableCard: {
    backgroundColor: t.colors.surface,
    borderColor: t.colors.borderDark,
    borderWidth: 1,
    borderRadius: t.radius.xxl,
    overflow: 'hidden',
  },
  productsCard: {
    backgroundColor: t.colors.surface,
    borderColor: t.colors.borderDark,
    borderWidth: 1,
    borderRadius: 20,
    padding: t.space.md,
  },
}));

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  gutter: { paddingHorizontal: 16 },
  listContent: { paddingTop: 24 },
  tail: { height: 40 },
  section: { marginTop: 32 },
  sectionLarge: { marginTop: 32 },
  sectionAside: { marginTop: 16 },
  caption: { marginTop: 4 },
  recentTitle: { marginBottom: 12 },
  recentWrap: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24, rowGap: 12 },
  recentItem: { alignItems: 'center' },
  recentSym: { marginTop: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 16 },
  gridCell: { width: '48%' },
  skelGap: { marginTop: 16 },
  skelGapSm: { marginTop: 12 },
  watchOverlay: { position: 'absolute', top: 12, right: 12, zIndex: 1 },
  tradedName: { marginTop: 16 },
  tradedPrice: { marginTop: 16 },
  tradedChange: { marginTop: 6 },
  seeMore: { marginTop: 16 },
  sectorChip: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', marginTop: 8, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  pillsRow: { marginTop: 12, marginBottom: 16, flexGrow: 0 },
  pills: { gap: 8 },
  catBtn: {},
  tableMsg: { paddingHorizontal: 20, paddingVertical: 32 },
  moverRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 12 },
  moverRight: { alignItems: 'flex-end', gap: 4, minWidth: 84 },
  sectorsTitle: { marginBottom: 16 },
  sectorSkel: { padding: 24, gap: 16 },
  sectorHead: { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 12, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  sectorRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  sectorCol1: { flex: 5, minWidth: 0 },
  sectorCol2: { flex: 4, minWidth: 0 },
  sectorCol3: { flex: 3, minWidth: 0 },
  sectorName: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  productsTitle: { marginBottom: 12 },
  productRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, paddingVertical: 12, borderRadius: 8 },
  catRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 12, borderRadius: 8 },
});
