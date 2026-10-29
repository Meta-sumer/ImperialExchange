import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { useInstruments } from '@/api/instruments.api';
import { errorMessage } from '@/api/client';
import { DateFilter } from '@/components/orders/DateFilter';
import { shareCsv } from '@/components/orders/shareCsv';
import {
  AppText,
  Button,
  ErrorView,
  Icon,
  Input,
  Screen,
  Select,
  toast,
  useScreenChrome,
} from '@/components/ui';
import type { AppScreenProps } from '@/navigation/types';
import { useAuthStore } from '@/store/auth';
import { useSelectedAccountStore } from '@/store/selectedAccount';
import { useTheme } from '@/theme';
import type { HistoryRecord, Instrument } from '@/types/trading';
import { ALL_TIME } from '@/utils/dateFilter';
import { subscribeOrders, subscribePositions } from '@/websocket/channels';

import { TradeRowCard } from './components/TradeRowCard';
import {
  ALL_ACCOUNTS,
  EMPTY_TRADE_HISTORY,
  SIDE_FILTER_OPTIONS,
  STATUS_OPTIONS,
  TYPE_FILTER_OPTIONS,
  accountsForType,
  buildTradeHistoryCsv,
  clearedFilters,
  emptyText,
  nextPage,
  prevPage,
  reconcileAccountId,
  showingText,
  showsPager,
  summaryTiles,
  tradeHistoryFilename,
  type AccountTypeFilter,
  type OrdersFilters,
  type SideFilter,
  type TradeHistoryPage,
} from './ordersLogic';
import { loadTradeHistory } from './tradeHistory';

const INITIAL_FILTERS: OrdersFilters = {
  accountId: ALL_ACCOUNTS,
  type: 'all',
  symbol: '',
  side: '',
  status: '',
  range: ALL_TIME,
  page: 1,
};

/**
 * Trade History — EquityHub's client/src/pages/Orders.jsx (`/orders`).
 *
 * Every record the chosen account(s) have finished with — closed trades and
 * the cancelled and rejected orders that never became positions — from
 * GET /trading/history, with filters (one Status control covering record
 * type and close reason), pagination, the summary strip and a CSV "Download
 * Report". The list re-reads itself when a position or order changes
 * anywhere (`user:positions` / `user:orders`). The web's wide table is a
 * card per record with every column kept.
 *
 * The page is read-only on the web — no cancel or modify — and so is this.
 *
 * Differences from the web, each deliberate:
 *   • The account list is the app-wide store's (the same GET /user/accounts),
 *     not a second fetch. The web waited for that list forever when it came
 *     back empty ("Loading trade history…" never cleared); here the history
 *     loads once the list has answered, empty or not.
 *   • A TYPE filter with no account of that type shows no trades — the web
 *     sent an empty `accountIds`, which the server reads as "every account".
 *   • Prices use the instrument's own precision when the catalogue knows
 *     the symbol (the web prints five decimals for all).
 *   • Only the newest request's answer lands (the web's filters raced); a
 *     failed load says so with a retry (the web swallowed it); it re-reads on
 *     coming back to the screen (the web remounts) and on pull-to-refresh.
 */
export function OrdersScreen({ navigation }: AppScreenProps<'Orders'>): React.JSX.Element {
  const t = useTheme();
  const { Footer } = useScreenChrome();
  const user = useAuthStore((s) => s.user);
  const accounts = useSelectedAccountStore((s) => s.accounts);
  const accountsLoading = useSelectedAccountStore((s) => s.loading);
  const { rows: instruments } = useInstruments();

  const [filters, setFilters] = useState<OrdersFilters>(INITIAL_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState<TradeHistoryPage>(EMPTY_TRADE_HISTORY);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [downloading, setDownloading] = useState(false);

  const filteredAccounts = useMemo(() => accountsForType(accounts, filters.type), [accounts, filters.type]);
  // The request always uses a valid pick, even in the frame before the
  // snap-back below lands.
  const accountId = reconcileAccountId(filters.accountId, filteredAccounts);
  useEffect(() => {
    if (accountId !== filters.accountId) setFilters((f) => ({ ...f, accountId, page: 1 }));
  }, [accountId, filters.accountId]);

  const effective = useMemo<OrdersFilters>(() => ({ ...filters, accountId }), [filters, accountId]);
  const filteredIds = filteredAccounts.map((a) => a.id).join(',');
  const requestKey = `${JSON.stringify(effective)}|${filteredIds}`;
  // The web loads nothing until the account list is there; an empty list
  // that has answered is "there" too.
  const accountsReady = accounts.length > 0 || !accountsLoading;

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const seq = useRef(0);
  const latest = useRef({ effective, filteredAccounts });
  latest.current = { effective, filteredAccounts };

  /** `quiet`: keep the rows on screen (focus / pull-to-refresh), and keep them if it fails. */
  const load = useCallback(async (quiet = false): Promise<void> => {
    const mine = ++seq.current;
    if (!quiet) setLoading(true);
    try {
      const next = await loadTradeHistory(latest.current.effective, latest.current.filteredAccounts);
      if (!alive.current || mine !== seq.current) return;
      setPage(next);
      setError(null);
    } catch (err) {
      if (!alive.current || mine !== seq.current) return;
      if (quiet) toast.error(errorMessage(err));
      else setError(err);
    } finally {
      if (alive.current && mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountsReady) return;
    void load();
  }, [requestKey, accountsReady, load]);

  // Live: a position or order closing or filling anywhere (SL/TP, another
  // device, the terminal) re-reads the list, quietly.
  useEffect(() => {
    const again = (): void => { if (latest.current) void load(true); };
    const offP = subscribePositions(again);
    const offO = subscribeOrders(again);
    return () => { offP(); offO(); };
  }, [load]);

  // Coming back from another screen: the web remounts on every visit.
  useEffect(() => {
    let away = false;
    const offBlur = navigation.addListener('blur', () => { away = true; });
    const offFocus = navigation.addListener('focus', () => {
      if (!away) return;
      away = false;
      void load(true);
    });
    return () => { offBlur(); offFocus(); };
  }, [navigation, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.allSettled([useSelectedAccountStore.getState().load(), load(true)]);
    } finally {
      if (alive.current) setRefreshing(false);
    }
  }, [load]);

  /* ── Filter handlers (every change goes back to page 1) ── */
  const patch = (p: Partial<OrdersFilters>): void => setFilters((f) => ({ ...f, ...p, page: 1 }));
  const setType = (type: AccountTypeFilter): void => setFilters((f) => ({
    ...f,
    type,
    accountId: reconcileAccountId(f.accountId, accountsForType(accounts, type)),
    page: 1,
  }));
  const goToPage = (n: number): void => setFilters((f) => ({ ...f, page: n }));

  const instrumentBySymbol = useMemo(() => {
    const m = new Map<string, Instrument>();
    for (const i of instruments) m.set(i.symbol, i);
    return m;
  }, [instruments]);

  const pickedAccount = accounts.find((a) => a.id === accountId) ?? null;

  const downloadReport = async (): Promise<void> => {
    if (!page.items.length || downloading || loading || error) return;
    setDownloading(true);
    try {
      const now = new Date();
      const csv = buildTradeHistoryCsv({
        rows: page.items,
        user: user ? { ...user, mobile: typeof user.raw.mobile === 'string' ? user.raw.mobile : null } : null,
        filters: effective,
        account: pickedAccount,
        filteredAccountCount: filteredAccounts.length,
        now,
      });
      await shareCsv(tradeHistoryFilename(effective, pickedAccount, now), csv, { bom: true, dialogTitle: 'Download Report' });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      if (alive.current) setDownloading(false);
    }
  };

  const total = page.pagination.total;
  const showRows = !loading && !error;

  const header = (
    <View style={styles.headerBlock}>
      {/* Header bar — title + account chip + filters + download */}
      <View style={[styles.card, { backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark, borderRadius: t.radius.xl }]}>
        <View style={styles.titleRow}>
          <View style={[styles.titleRule, { backgroundColor: t.colors.primary }]} />
          <AppText variant="h2" style={styles.title} accessibilityRole="header">
            TRADE HISTORY{' '}
            <AppText variant="h2" tone="muted" weight="400">{`(${total})`}</AppText>
          </AppText>
        </View>

        {/* Account chip — ID and TYPE both selectable; "All" aggregates. */}
        <View style={[styles.chip, { borderColor: t.colors.borderDark, borderRadius: t.radius.md }]}>
          <AppText variant="small" weight="500" color={t.colors.primaryText}>Selected Account</AppText>
          <View style={styles.chipRow}>
            <AppText variant="small" tone="muted">ID:</AppText>
            <Select
              variant="compact"
              accessibilityLabel="Account ID"
              title="Account"
              value={accountId}
              onChange={(id) => patch({ accountId: id })}
              options={[
                { value: ALL_ACCOUNTS, label: 'All accounts' },
                ...filteredAccounts.map((a) => ({ value: a.id, label: a.accountNumber })),
              ]}
            />
            <AppText variant="small" tone="muted">TYPE:</AppText>
            <Select
              variant="compact"
              accessibilityLabel="Account type"
              title="Account type"
              value={filters.type}
              onChange={(v) => setType(v)}
              options={TYPE_FILTER_OPTIONS.map((o) => ({ ...o }))}
            />
          </View>
        </View>

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: filtersOpen }}
            onPress={() => setFiltersOpen((o) => !o)}
            style={({ pressed }) => [styles.ghost, { borderRadius: t.radius.lg, backgroundColor: pressed || filtersOpen ? t.colors.bgHover : 'transparent' }]}
          >
            <Icon name="filter" size={14} color={t.colors.textSecondary} />
            <AppText variant="body" tone="secondary">Filters</AppText>
          </Pressable>
          <Button
            title="Download Report"
            variant="secondary"
            size="sm"
            leftIcon="arrowDown"
            loading={downloading}
            // Also off while the rows on screen are not the filters' answer
            // (loading, or that load failed): the file's banner would name
            // filters its rows do not match.
            disabled={!page.items.length || !showRows}
            onPress={() => { void downloadReport(); }}
          />
        </View>
      </View>

      {/* Filters panel */}
      {filtersOpen ? (
        <View style={[styles.card, styles.filters, { backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark, borderRadius: t.radius.xl }]}>
          <Input
            label="Symbol"
            value={filters.symbol}
            onChangeText={(v) => patch({ symbol: v.toUpperCase() })}
            placeholder="e.g. RELIANCE"
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <View style={styles.pair}>
            <Select<SideFilter>
              label="Side"
              style={styles.flex}
              value={filters.side}
              onChange={(v) => patch({ side: v })}
              options={SIDE_FILTER_OPTIONS.map((o) => ({ ...o }))}
            />
            <Select
              label="Status"
              style={styles.flex}
              value={filters.status}
              onChange={(v) => patch({ status: v })}
              options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label, description: o.group }))}
            />
          </View>
          <View>
            <AppText variant="label" style={styles.label}>Date range</AppText>
            <DateFilter value={filters.range} onChange={(range) => patch({ range })} />
          </View>
          <Button title="Clear" variant="ghost" size="sm" fullWidth onPress={() => setFilters((f) => clearedFilters(f))} />
        </View>
      ) : null}
    </View>
  );

  const empty = loading ? (
    <AppText variant="body" tone="muted" align="center" style={styles.placeholder}>Loading trade history…</AppText>
  ) : error ? (
    <ErrorView error={error} onRetry={() => { void load(); }} compact style={styles.placeholder} />
  ) : (
    <AppText variant="body" tone="muted" align="center" style={styles.placeholder}>{emptyText(effective.status)}</AppText>
  );

  const footer = (
    <View>
      <View style={styles.footerBlock}>
        {/* Pagination footer + count */}
        <View style={styles.pagerRow}>
          <AppText variant="small" tone="muted" style={styles.flex}>
            {showingText(page.items.length, total, effective.status)}
          </AppText>
          {showsPager(page.pagination) ? (
            <View style={styles.pager}>
              <Button
                title="◀ Prev"
                variant="ghost"
                size="sm"
                disabled={filters.page <= 1}
                onPress={() => goToPage(prevPage(filters.page))}
              />
              <AppText variant="small" tone="muted">{`${filters.page} / ${page.pagination.pages}`}</AppText>
              <Button
                title="Next ▶"
                variant="ghost"
                size="sm"
                disabled={filters.page >= page.pagination.pages}
                onPress={() => goToPage(nextPage(filters.page, page.pagination.pages))}
              />
            </View>
          ) : null}
        </View>

        {/* Summary stat strip */}
        <View style={styles.stats}>
          {summaryTiles(page.summary).map((s) => (
            <View
              key={s.label}
              style={[
                styles.stat,
                s.highlight ? styles.statWide : null,
                {
                  backgroundColor: t.colors.bgCard,
                  borderRadius: t.radius.md,
                  borderColor: s.highlight && s.tone === 'bear' ? t.colors.bear
                    : s.highlight && s.tone === 'bull' ? t.colors.bull
                      : t.colors.borderDark,
                },
              ]}
            >
              <AppText variant="micro" tone="muted" style={styles.statLabel}>{s.label}</AppText>
              <AppText
                variant="bodyStrong"
                mono
                weight="700"
                color={s.tone === 'bull' ? t.colors.bull : s.tone === 'bear' ? t.colors.bear : t.colors.textPrimary}
              >
                {s.value}
              </AppText>
            </View>
          ))}
        </View>
      </View>
      {Footer ? <Footer /> : null}
    </View>
  );

  const renderItem = useCallback(({ item }: { item: HistoryRecord }) => (
    <View style={styles.rowWrap}>
      <TradeRowCard row={item} instrument={instrumentBySymbol.get(item.symbol) ?? null} />
    </View>
  ), [instrumentBySymbol]);

  return (
    <Screen scroll={false} padded={false}>
      <FlatList
        data={showRows ? page.items : []}
        keyExtractor={(r, i) => (r.id ? `${r.kind}-${r.id}` : `row-${i}`)}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListEmptyComponent={<View style={styles.rowWrap}>{empty}</View>}
        ListFooterComponent={footer}
        contentContainerStyle={{ paddingTop: t.space.page }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={8}
        windowSize={7}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { void onRefresh(); }}
            tintColor={t.colors.primary}
            colors={[t.colors.primary]}
            progressBackgroundColor={t.colors.surface}
          />
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  headerBlock: { paddingHorizontal: 16, gap: 12, marginBottom: 12 },
  card: { borderWidth: 1, padding: 16, gap: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  titleRule: { width: 4, height: 24, borderRadius: 2 },
  title: { letterSpacing: 0.5, flexShrink: 1 },
  chip: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8, gap: 6 },
  chipRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  ghost: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8 },
  filters: { gap: 12 },
  pair: { flexDirection: 'row', gap: 12 },
  label: { marginBottom: 6 },
  rowWrap: { paddingHorizontal: 16, marginBottom: 10 },
  placeholder: { paddingVertical: 48 },
  footerBlock: { paddingHorizontal: 16, paddingBottom: 24, gap: 12 },
  pagerRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingHorizontal: 4 },
  pager: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, gap: 2, minWidth: 140, flexGrow: 1, flexBasis: '45%' },
  statWide: { flexBasis: '100%' },
  statLabel: { textTransform: 'uppercase', letterSpacing: 0.8 },
});
