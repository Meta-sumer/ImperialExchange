import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { useInstruments } from '@/api/instruments.api';
import { EMPTY_HISTORY_SUMMARY } from '@/api/trading.api';
import {
  REPORT_EXPORTS,
  exportReportCsv,
  fetchReportsOverview,
  reportsWinRate,
  type ReportExport,
} from '@/api/reports.api';
import {
  AppText,
  AssetIcon,
  Badge,
  Button,
  ErrorView,
  Icon,
  Input,
  PageHero,
  Screen,
  Select,
  StatTile,
  toast,
  useScreenChrome,
} from '@/components/ui';
import type { AppScreenProps } from '@/navigation/types';
import { useSelectedAccountStore } from '@/store/selectedAccount';
import { useTheme } from '@/theme';
import type { Instrument, Order, PositionHistorySummary } from '@/types/trading';
import { sanitizeDateInput } from '@/utils/dateFilter';
import { fmtLocalDateTime } from '@/utils/walletLogic';

import {
  EMPTY_EXPORT_FORM,
  RECENT_ORDERS_LIMIT,
  canExport,
  exportAccountLabel,
  exportDateErrors,
  exportFiltersOf,
  hasExportFilters,
  orderPriceText,
  orderQty,
  orderStatusTone,
  realizedPnlIsLoss,
  realizedPnlText,
  type ExportForm,
} from './reportsLogic';

const EXPORT_ORDER: readonly ReportExport[] = ['orders', 'positions', 'ledger'];

/**
 * Reports — client/src/pages/Reports.jsx (`/reports`).
 *
 * The summary over ALL closed positions (computed server-side), the three
 * quick links, the CSV exports with their account / date filters, and the
 * newest 50 orders. A CSV is fetched and handed to the share sheet — the
 * phone's download (reports.api `exportReportCsv`).
 *
 * Differences from the web, each deliberate:
 *   • The figures show "—" until they have loaded, and a failed load says so
 *     with a retry (the web showed zeros and "No trades yet" either way).
 *   • Dates are typed YYYY-MM-DD; one that is not a real day, or an end
 *     before the start, blocks the export (reports.api would otherwise drop
 *     it and export all time).
 *   • Qty is the filled size only when something filled (reportsLogic
 *     `orderQty`); prices use the instrument's precision when it is known.
 *   • It re-reads on coming back to the screen and on pull-to-refresh.
 */
export function ReportsScreen({ navigation }: AppScreenProps<'Reports'>): React.JSX.Element {
  const t = useTheme();
  const { Footer } = useScreenChrome();
  const accounts = useSelectedAccountStore((s) => s.accounts);
  const { rows: instruments } = useInstruments();

  const [orders, setOrders] = useState<Order[]>([]);
  const [stats, setStats] = useState<PositionHistorySummary>(EMPTY_HISTORY_SUMMARY);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [form, setForm] = useState<ExportForm>(EMPTY_EXPORT_FORM);
  const [exporting, setExporting] = useState<ReportExport | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const seq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const mine = ++seq.current;
    try {
      const o = await fetchReportsOverview();
      if (!alive.current || mine !== seq.current) return;
      setOrders(o.orders);
      setStats(o.summary);
      setLoaded(true);
      setError(null);
    } catch (err) {
      if (!alive.current || mine !== seq.current) return;
      setError(err);
    } finally {
      if (alive.current && mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Coming back from another screen: the web remounts on every visit.
  useEffect(() => {
    let away = false;
    const offBlur = navigation.addListener('blur', () => { away = true; });
    const offFocus = navigation.addListener('focus', () => {
      if (!away) return;
      away = false;
      void load();
    });
    return () => { offBlur(); offFocus(); };
  }, [navigation, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(); } finally { if (alive.current) setRefreshing(false); }
  }, [load]);

  const instrumentBySymbol = useMemo(() => {
    const m = new Map<string, Instrument>();
    for (const i of instruments) m.set(i.symbol, i);
    return m;
  }, [instruments]);

  const download = async (kind: ReportExport): Promise<void> => {
    if (exporting || !canExport(form)) return;
    setExporting(kind);
    try {
      await exportReportCsv(kind, exportFiltersOf(form));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      if (alive.current) setExporting(null);
    }
  };

  const dateErrors = exportDateErrors(form);
  const exportable = canExport(form);
  const winners = Number(stats.wins || 0);
  const losers = Number(stats.losses || 0);
  const pending = !loaded;

  const quickLink = (title: string, sub: string, onPress: () => void): React.JSX.Element => (
    <Pressable
      key={title}
      accessibilityRole="link"
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: pressed ? t.colors.bgHover : t.colors.bgCard,
          borderColor: pressed ? t.alpha(t.colors.primary, 0.5) : t.colors.borderDark,
          borderRadius: t.radius.xl,
        },
      ]}
    >
      <AppText variant="bodyStrong">{title}</AppText>
      <AppText variant="small" tone="muted" style={styles.gap4}>{sub}</AppText>
    </Pressable>
  );

  const header = (
    <View style={styles.headerBlock}>
      <PageHero
        eyebrow="Analytics"
        title="Reports"
        subtitle="Trading activity, P&L, and historical performance across all your accounts."
        style={styles.noMargin}
      />

      {/* Summary cards */}
      <View style={styles.grid}>
        <StatTile
          label="Realized P&L"
          value={realizedPnlText(stats.netPnl)}
          tone={realizedPnlIsLoss(stats.netPnl) ? 'bear' : 'bull'}
          loading={pending}
          style={styles.tile}
        />
        <StatTile label="Win Rate" value={`${reportsWinRate(stats)}%`} loading={pending} style={styles.tile} />
        <StatTile label="Winners" value={String(winners)} tone="bull" loading={pending} style={styles.tile} />
        <StatTile label="Losers" value={String(losers)} tone="bear" loading={pending} style={styles.tile} />
      </View>

      {/* Quick links */}
      <View style={styles.links}>
        {quickLink('Order History →', 'All filled, cancelled, rejected orders', () => navigation.navigate('Orders', undefined, { pop: true }))}
        {quickLink('Wallet Ledger →', 'Deposits, withdrawals, fees, P&L', () => navigation.navigate('Wallet', { view: 'overview' }, { pop: true }))}
        {quickLink('Price Alerts →', 'Create custom price notifications', () => navigation.navigate('Alerts', undefined, { pop: true }))}
      </View>

      {/* CSV exports */}
      <View style={[styles.card, styles.exportCard, { backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark, borderRadius: t.radius.xl }]}>
        <View>
          <AppText variant="bodyStrong">Export your data</AppText>
          <AppText variant="small" tone="secondary" style={styles.gap4}>
            Download CSV files for tax or record-keeping — filter by account and date range.
          </AppText>
        </View>

        {/* Filters — applied to every export below */}
        <Select
          label="Account"
          value={form.accountId}
          onChange={(accountId) => setForm((f) => ({ ...f, accountId }))}
          options={[
            { value: '', label: 'All accounts' },
            ...accounts.map((a) => ({ value: a.id, label: exportAccountLabel(a) })),
          ]}
        />
        <View style={styles.pair}>
          <Input
            label="From"
            value={form.from}
            onChangeText={(v) => setForm((f) => ({ ...f, from: sanitizeDateInput(v) }))}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
            maxLength={10}
            autoCorrect={false}
            autoCapitalize="none"
            error={dateErrors.from}
            containerStyle={styles.flex}
            mono
          />
          <Input
            label="To"
            value={form.to}
            onChangeText={(v) => setForm((f) => ({ ...f, to: sanitizeDateInput(v) }))}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
            maxLength={10}
            autoCorrect={false}
            autoCapitalize="none"
            error={dateErrors.to}
            containerStyle={styles.flex}
            mono
          />
        </View>
        {hasExportFilters(form) ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setForm(EMPTY_EXPORT_FORM)}
            style={styles.clear}
            hitSlop={6}
          >
            <AppText variant="smallStrong" tone="muted">Clear</AppText>
          </Pressable>
        ) : null}

        {/* Downloads — each respects the filters above */}
        <View style={[styles.downloads, { borderTopColor: t.colors.borderSubtle }]}>
          {EXPORT_ORDER.map((kind) => (
            <Button
              key={kind}
              title={REPORT_EXPORTS[kind].label}
              variant="secondary"
              size="sm"
              loading={exporting === kind}
              disabled={!exportable || (exporting !== null && exporting !== kind)}
              onPress={() => { void download(kind); }}
            />
          ))}
        </View>
      </View>

      {/* Recent trades */}
      <View style={[styles.activityHead, { backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark, borderTopLeftRadius: t.radius.xl, borderTopRightRadius: t.radius.xl }]}>
        <AppText variant="bodyStrong">Recent Order Activity</AppText>
      </View>
    </View>
  );

  const recent = orders.slice(0, RECENT_ORDERS_LIMIT);

  const empty = (
    <View style={[styles.activityBody, { borderColor: t.colors.borderDark, backgroundColor: t.colors.bgCard }]}>
      {loading && !loaded ? (
        <AppText variant="body" tone="muted" align="center" style={styles.pad24}>Loading…</AppText>
      ) : error && !loaded ? (
        <ErrorView error={error} onRetry={() => { setLoading(true); void load(); }} compact />
      ) : (
        <View style={styles.emptyBox}>
          <View style={[styles.emptyIcon, { backgroundColor: t.colors.bgHover }]}>
            <Icon name="reports" size={22} color={t.colors.textMuted} />
          </View>
          <AppText variant="body" tone="secondary">No trades yet</AppText>
          <Pressable accessibilityRole="link" onPress={() => navigation.navigate('Trade', undefined, { pop: true })} hitSlop={6}>
            <AppText variant="smallStrong" color={t.colors.primaryText}>Start trading →</AppText>
          </Pressable>
        </View>
      )}
    </View>
  );

  const renderItem = useCallback(({ item, index }: { item: Order; index: number }) => {
    const inst = instrumentBySymbol.get(item.symbol) ?? null;
    const tone = orderStatusTone(item.status);
    return (
      <View
        testID={`order-row-${item.id}`}
        style={[
          styles.orderRow,
          {
            backgroundColor: t.colors.bgCard,
            borderColor: t.colors.borderDark,
            borderTopColor: t.colors.borderSubtle,
            borderTopWidth: index === 0 ? 0 : 1,
          },
        ]}
      >
        <View style={styles.orderTop}>
          <AssetIcon row={inst ?? { symbol: item.symbol }} size={20} round />
          <AppText variant="bodyStrong" numberOfLines={1} style={styles.flex}>{item.symbol}</AppText>
          <Badge label={item.status} tone={tone === 'muted' ? 'neutral' : tone} />
        </View>
        <View style={styles.orderMid}>
          <AppText variant="small" weight="600" color={item.side === 'BUY' ? t.colors.bull : t.colors.bear}>{item.side}</AppText>
          <AppText variant="small" tone="secondary">{item.type}</AppText>
          <AppText variant="small" tone="muted" style={styles.flex} numberOfLines={1}>
            {fmtLocalDateTime(item.createdAt)}
          </AppText>
        </View>
        <View style={styles.orderMid}>
          <AppText variant="micro" tone="muted">QTY</AppText>
          <AppText variant="small" mono>{orderQty(item)}</AppText>
          <AppText variant="micro" tone="muted" style={styles.gapL}>PRICE</AppText>
          <AppText variant="small" mono>{orderPriceText(item, inst)}</AppText>
        </View>
      </View>
    );
  }, [instrumentBySymbol, t]);

  return (
    <Screen scroll={false} padded={false}>
      <FlatList
        data={recent}
        keyExtractor={(o, i) => o.id || `order-${i}`}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListEmptyComponent={<View style={styles.side}>{empty}</View>}
        ListFooterComponent={(
          <View>
            {recent.length ? (
              <View style={styles.side}>
                <View style={[styles.activityEnd, { borderColor: t.colors.borderDark, backgroundColor: t.colors.bgCard }]} />
              </View>
            ) : null}
            <View style={styles.pad24} />
            {Footer ? <Footer /> : null}
          </View>
        )}
        // Rows are drawn inside the card's side borders.
        contentContainerStyle={{ paddingTop: t.space.page }}
        style={styles.flex}
        initialNumToRender={10}
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
  noMargin: { marginBottom: 0 },
  headerBlock: { paddingHorizontal: 16, gap: 16 },
  side: { paddingHorizontal: 16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  tile: { flexGrow: 1, flexBasis: '45%' },
  links: { gap: 12 },
  card: { borderWidth: 1, padding: 20 },
  exportCard: { gap: 12 },
  gap4: { marginTop: 4 },
  pair: { flexDirection: 'row', gap: 12 },
  clear: { alignSelf: 'flex-start', paddingVertical: 4 },
  downloads: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, borderTopWidth: 1, paddingTop: 12 },
  activityHead: { borderWidth: 1, paddingHorizontal: 20, paddingVertical: 12 },
  activityBody: { borderWidth: 1, borderTopWidth: 0, borderBottomLeftRadius: 12, borderBottomRightRadius: 12 },
  activityEnd: { height: 12, borderWidth: 1, borderTopWidth: 0, borderBottomLeftRadius: 12, borderBottomRightRadius: 12 },
  orderRow: { marginHorizontal: 16, borderLeftWidth: 1, borderRightWidth: 1, paddingHorizontal: 16, paddingVertical: 10, gap: 6 },
  orderTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  orderMid: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  gapL: { marginLeft: 8 },
  pad24: { paddingVertical: 24 },
  emptyBox: { alignItems: 'center', paddingVertical: 40, gap: 6 },
  emptyIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
});
