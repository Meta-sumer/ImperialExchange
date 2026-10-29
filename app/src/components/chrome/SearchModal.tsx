import { StackActions } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import {
  catalogCounts,
  filterCatalog,
  isOptionLikeQuery,
  refreshInstruments,
  searchOptionContracts,
  useInstruments,
  useRecommendedMarkets,
} from '@/api/instruments.api';
import { WatchlistButton } from '@/components/market/WatchlistButton';
import { WatchlistModalProvider } from '@/components/market/WatchlistModal';
import { AppText, AssetIcon, BottomSheet, ErrorView, Icon, IconButton } from '@/components/ui';
import { navigationRef } from '@/navigation/navigationRef';
import { useTheme } from '@/theme';
import type { Instrument } from '@/types/trading';
import {
  OPTION_SEARCH_DEBOUNCE_MS,
  resolveSearchCategory,
  searchHeading,
  searchNoMatches,
  searchResults,
  searchRowSubtitle,
  searchRowTitle,
  searchTabs,
  sortToggleTitle,
} from '@/utils/search';

/**
 * SearchModal.jsx — the "Search markets…" sheet: the catalogue by category
 * (with the admin's Recommended list first when there is one), a query over
 * symbol and name, option contracts from the server search for option-like
 * queries, and a bookmark on every row. Picking a row opens the stock page,
 * as the web's `navigate('/stock/:symbol')` does.
 *
 * The web centres a card under the header; on a phone it is a bottom sheet
 * (the kit's). Its hooks run only while it is open — the body unmounts with
 * the sheet — so a stack of screens, each with a header and a closed search,
 * holds no catalogue polling of its own.
 *
 * Differences from the web, on purpose:
 *   • The default tab follows the Recommended list as the catalogue
 *     RESOLVES it (utils/search resolveSearchCategory) — the web could open
 *     on a hidden tab with an empty list.
 *   • An option search whose answer arrives after a newer query's is
 *     dropped, so a slow reply cannot overwrite a fast one.
 *   • A catalogue that failed to load says so, with Retry, instead of
 *     `No matches for "".`
 *   • `onPick` hands the symbol to the caller instead of opening the stock
 *     page. The Trade terminal uses it: Trade.jsx's own comments say a pick
 *     from its "+" tab and chart legend re-points the chart, but the web's
 *     SearchModal navigates to /stock/:symbol and leaves the terminal.
 */

export interface SearchModalProps {
  open: boolean;
  onClose: () => void;
  /** Take the picked symbol instead of opening its stock page. */
  onPick?: (symbol: string) => void;
}

export function SearchModal({ open, onClose, onPick }: SearchModalProps): React.JSX.Element {
  const inputRef = useRef<TextInput>(null);
  // Outlives one opening, as the web's state in its always-mounted modal does.
  const [recSortAlpha, setRecSortAlpha] = useState(false);

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      scrollable={false}
      bodyPadding={0}
      initialFocus={inputRef}
      testID="search-modal"
    >
      {/* The sheet renders in the overlay layer, outside the app's
          WatchlistModalProvider (a portal sees only app-level context), so a
          row's bookmark would get the provider's no-op default there. The
          sheet carries its own provider: the bookmark opens the same shared
          "Add to Watchlist" sheet (same store), stacked above this one. */}
      <WatchlistModalProvider>
        <SearchBody
          inputRef={inputRef}
          onClose={onClose}
          onPick={onPick}
          recSortAlpha={recSortAlpha}
          onToggleSort={() => setRecSortAlpha((v) => !v)}
        />
      </WatchlistModalProvider>
    </BottomSheet>
  );
}

function SearchBody({
  inputRef,
  onClose,
  onPick,
  recSortAlpha,
  onToggleSort,
}: {
  inputRef: React.RefObject<TextInput | null>;
  onClose: () => void;
  onPick?: (symbol: string) => void;
  recSortAlpha: boolean;
  onToggleSort: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const { rows, loading, error } = useInstruments();
  const { symbols: recommended } = useRecommendedMarkets();
  const [chosen, setChosen] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [optionResults, setOptionResults] = useState<Instrument[]>([]);

  // Pull the latest catalogue each time the sheet opens, so an admin's new
  // logo, name or symbol shows now rather than after the cache's TTL.
  useEffect(() => { void refreshInstruments(); }, []);

  // Options are not in the cached catalogue; an option-like query (a strike
  // number or CE/PE) asks the server, 250ms after typing stops. Any other
  // query clears them at once, as the web does.
  const optionSeq = useRef(0);
  useEffect(() => {
    const seq = ++optionSeq.current;
    const q = query.trim();
    if (!q || !isOptionLikeQuery(q)) { setOptionResults([]); return undefined; }
    const timer = setTimeout(() => {
      searchOptionContracts(q)
        .then((found) => { if (seq === optionSeq.current) setOptionResults(found); })
        .catch(() => { if (seq === optionSeq.current) setOptionResults([]); });
    }, OPTION_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const counts = useMemo(() => catalogCounts(rows, recommended), [rows, recommended]);
  const tabs = useMemo(() => searchTabs(counts), [counts]);
  const category = resolveSearchCategory(chosen, counts);
  const visible = useMemo(
    () => filterCatalog(rows, { category, query, recommended, sortAlpha: recSortAlpha }),
    [rows, category, query, recommended, recSortAlpha],
  );
  const list = useMemo(() => searchResults(visible, optionResults, query), [visible, optionResults, query]);
  const showTrending = !query.trim();

  const pick = useCallback((symbol: string) => {
    onClose();
    if (onPick) { onPick(symbol); return; }
    // A new page per pick, like the web's navigate() — searching from one
    // stock page for another keeps the first one to come back to.
    if (navigationRef.isReady()) navigationRef.dispatch(StackActions.push('StockDetail', { symbol }));
  }, [onClose, onPick]);

  const failed = !!error && rows.length === 0;

  const header = (
    <View>
      <View style={[styles.heading, { paddingHorizontal: 20 }]}>
        <AppText variant="bodyStrong" tone="secondary">
          {searchHeading(category, query, visible.length, list.length)}
        </AppText>
        {category === 'RECOMMENDED' && showTrending ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={sortToggleTitle(recSortAlpha)}
            accessibilityState={{ selected: recSortAlpha }}
            onPress={onToggleSort}
            style={[
              styles.sortBtn,
              {
                borderColor: recSortAlpha ? t.colors.primary : t.colors.borderDark,
                backgroundColor: recSortAlpha ? t.colors.primarySoft : 'transparent',
              },
            ]}
          >
            <SortGlyph color={recSortAlpha ? t.colors.primaryText : t.colors.textMuted} />
            <AppText variant="caption" weight="700" color={recSortAlpha ? t.colors.primaryText : t.colors.textMuted}>
              A–Z
            </AppText>
          </Pressable>
        ) : null}
      </View>
      {loading ? (
        <AppText variant="body" tone="muted" style={styles.loading}>Loading instruments…</AppText>
      ) : null}
      {failed ? (
        <ErrorView error={error} compact onRetry={() => { void refreshInstruments(); }} />
      ) : null}
    </View>
  );

  return (
    <View style={styles.body}>
      {/* Search input */}
      <View style={[styles.inputRow, { borderBottomColor: t.colors.borderSubtle }]}>
        <Icon name="search" size={20} color={t.colors.textMuted} />
        <TextInput
          ref={inputRef}
          value={query}
          onChangeText={setQuery}
          placeholder="Search markets…"
          placeholderTextColor={t.colors.textMuted}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          accessibilityLabel="Search markets"
          style={[styles.input, { color: t.colors.textPrimary }]}
        />
        <IconButton name="close" accessibilityLabel="Close" onPress={onClose} color={t.colors.textMuted} />
      </View>

      {/* Category pills */}
      <View style={[styles.pillsWrap, { borderBottomColor: t.colors.borderSubtle }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pills} keyboardShouldPersistTaps="handled">
          {tabs.map((c) => {
            const active = category === c.key;
            const count = counts[c.key];
            return (
              <Pressable
                key={c.key}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                onPress={() => setChosen(c.key)}
                style={[
                  styles.pill,
                  {
                    borderColor: active ? t.colors.textPrimary : t.colors.borderDark,
                    backgroundColor: active ? t.colors.bgCard : t.colors.surface,
                  },
                ]}
              >
                <AppText variant={active ? 'bodyStrong' : 'body'} color={active ? t.colors.textPrimary : t.colors.textSecondary}>
                  {c.label}
                </AppText>
                {count != null ? (
                  <AppText variant="micro" weight="600" color={active ? t.colors.textPrimary : t.colors.textMuted}>
                    {count}
                  </AppText>
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <FlatList
        data={loading || failed ? [] : list}
        keyExtractor={(r) => r.symbol}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        style={styles.list}
        contentContainerStyle={styles.listContent}
        initialNumToRender={16}
        maxToRenderPerBatch={20}
        windowSize={7}
        ListHeaderComponent={header}
        ListEmptyComponent={!loading && !failed ? (
          <AppText variant="body" tone="muted" align="center" style={styles.empty}>
            {searchNoMatches(query)}
          </AppText>
        ) : null}
        renderItem={({ item }) => <SearchRow row={item} onPick={pick} />}
      />
    </View>
  );
}

const SearchRow = React.memo(function SearchRow({
  row,
  onPick,
}: {
  row: Instrument;
  onPick: (symbol: string) => void;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${searchRowTitle(row)}, ${searchRowSubtitle(row)}`}
        onPress={() => onPick(row.symbol)}
        style={({ pressed }) => [styles.rowMain, pressed ? { backgroundColor: t.colors.bgHover } : null]}
      >
        <AssetIcon row={row} size={28} round />
        <View style={styles.rowText}>
          <AppText variant="body" numberOfLines={1}>{searchRowTitle(row)}</AppText>
          <AppText variant="caption" tone="muted" numberOfLines={1}>{searchRowSubtitle(row)}</AppText>
        </View>
      </Pressable>
      <WatchlistButton symbol={row.symbol} row={row} variant="inline" size={18} />
    </View>
  );
});

/** The A–Z toggle's glyph — SearchModal.jsx:250-252. */
function SortGlyph({ color }: { color: string }): React.JSX.Element {
  return (
    <Svg width={12} height={12} viewBox="0 0 24 24" fill="none">
      <Path d="M3 6h11M3 12h8M3 18h5" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M17 8l3-3 3 3M20 5v14" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  body: { flexShrink: 1 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 20,
    paddingRight: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  input: { flex: 1, fontSize: 16, paddingVertical: 8 },
  pillsWrap: { borderBottomWidth: 1 },
  pills: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 12 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  list: { flexGrow: 0, flexShrink: 1 },
  listContent: { paddingBottom: 12 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingTop: 16, paddingBottom: 8 },
  sortBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  loading: { paddingHorizontal: 20, paddingVertical: 24 },
  empty: { paddingHorizontal: 20, paddingVertical: 40 },
  row: { flexDirection: 'row', alignItems: 'center', paddingRight: 12 },
  rowMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 20, paddingRight: 8, paddingVertical: 12 },
  rowText: { flex: 1, minWidth: 0 },
});
