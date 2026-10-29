import { useIsFocused } from '@react-navigation/native';
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useInstruments } from '@/api/instruments.api';
import { STOCK_CHART_RANGES, type StockChartRange } from '@/api/market.api';
import { useWatchlistModal } from '@/components/market/WatchlistModal';
import { PositionsPanel } from '@/components/orders/PositionsPanel';
import { NewsTab } from '@/components/stock/NewsTab';
import { OverviewTab } from '@/components/stock/OverviewTab';
import { StockChart } from '@/components/stock/StockChart';
import { StockChip } from '@/components/stock/StockChip';
import { ChartModeGlyph, RoundIconButton, StockIcon } from '@/components/stock/StockIcons';
import { TechnicalsTab } from '@/components/stock/TechnicalsTab';
import {
  rangeSpec,
  useStockBalances,
  useStockCandles,
  useStockDepth,
  useStockFundamentals,
  useStockInstrument,
  useStockLivePrice,
} from '@/components/stock/useStockData';
import { OrderSheet } from '@/components/trade/OrderSheet';
import { AppText, AssetIcon, EmptyState, ErrorView, Screen, Tabs } from '@/components/ui';
import type { AppScreenProps } from '@/navigation/types';
import { makeStyles, useTheme } from '@/theme';
import {
  STOCK_TABS,
  changeLabel,
  fmtPx,
  stockCurrency,
  stockFigures,
  stockPrecision,
  type ChartMode,
  type StockTab,
} from '@/utils/stockDetail';

/**
 * The instrument page — EquityHub's client/src/pages/StockDetail.jsx
 * (`/stock/:symbol`).
 *
 * Clicking an instrument anywhere on the web opens this: the live price and
 * the range's change, an inline chart with nine ranges (line or candles),
 * the Terminal link, and four tabs — Overview (market depth, performance,
 * Yahoo fundamentals, financial performance, similar instruments),
 * Technicals, News and Positions (this symbol's open positions and pending
 * orders, closable without leaving the page). Header actions open the option
 * chain, price alerts (with the symbol) and the shared Add-to-watchlist
 * sheet. Every quote is in rupees.
 *
 * The web's order panel is a sticky column on desktop and, below `lg`, a
 * floating "Trade" button that slides in the same OrderForm; a phone gets
 * the latter — the button opens OrderSheet (the OrderForm for the selected
 * account), and a placed order re-reads /wallet/balances as the web's
 * onPlaced does.
 *
 * Live data (ticker, depth, the wallet nudge) is held only while this screen
 * is focused, and coalesced (components/stock/useStockData). Figures the web
 * invents when data is missing are not ported — utils/stockDetail lists them.
 */
export function StockDetailScreen({ navigation, route }: AppScreenProps<'StockDetail'>): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  // Symbols are stored uppercase; a hand-typed /stock/reliance is the same page.
  const symbol = String(route.params?.symbol ?? '').trim().toUpperCase();

  const { open: openWatchlist } = useWatchlistModal();
  const { rows: instruments } = useInstruments();

  const [tf, setTf] = useState<StockChartRange>('1D');
  const [tab, setTab] = useState<StockTab>('Overview');
  const [chartMode, setChartMode] = useState<ChartMode>('line');
  const [tradeOpen, setTradeOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const instrument = useStockInstrument(symbol);
  const { fund, reload: reloadFund } = useStockFundamentals(symbol);
  const chart = useStockCandles(symbol, tf);
  const depth = useStockDepth(symbol, focused);
  const livePrice = useStockLivePrice(symbol, focused);
  const balances = useStockBalances(focused);

  const inst = instrument.inst;
  const cur = stockCurrency(inst);
  const prec = stockPrecision(inst);
  const figures = useMemo(() => stockFigures(chart.candles, livePrice, inst), [chart.candles, livePrice, inst]);
  const name = inst?.name || symbol;
  const iconRow = inst ?? { symbol, category: 'STOCK' };

  const refresh = useCallback(async () => {
    setRefreshKey((k) => k + 1);
    await Promise.all([instrument.reload(), reloadFund(), chart.reload(), depth.reload()]);
  }, [instrument, reloadFund, chart, depth]);

  // Stable: OrderSheet closes itself through this when the screen loses focus.
  const closeTrade = useCallback(() => setTradeOpen(false), []);
  // OrderForm's onPlaced — the web re-reads /wallet/balances.
  const reloadBalances = balances.reload;
  const onPlaced = useCallback(() => { void reloadBalances(); }, [reloadBalances]);

  const openInstrument = useCallback((sym: string) => {
    // A new page, as the web's navigate('/stock/…') pushes history.
    navigation.push('StockDetail', { symbol: sym });
  }, [navigation]);

  if (instrument.notFound) {
    return (
      <Screen>
        <EmptyState
          icon="search"
          title={instrument.notFound}
          message={symbol || undefined}
          actionLabel="Go to Explore"
          onAction={() => navigation.navigate('Explore')}
        />
      </Screen>
    );
  }

  return (
    <View style={s.flex}>
      <Screen onRefresh={refresh}>
        {instrument.error && !inst ? (
          <ErrorView compact error={instrument.error} onRetry={() => { void instrument.reload(); }} style={s.instError} />
        ) : null}

        {/* Header */}
        <View style={s.headRow}>
          <View style={s.headLeft}>
            <AssetIcon row={iconRow} size={44} round />
            <View style={s.flexShrink}>
              <AppText variant="small" weight="600" tone="muted">{`${symbol}${inst?.exchange ? ` · ${inst.exchange}` : ''}`}</AppText>
              <AppText variant="h1" numberOfLines={2}>{name}</AppText>
            </View>
          </View>
          <View style={s.headActions}>
            <RoundIconButton accessibilityLabel="Options chain" onPress={() => navigation.navigate('Options', { underlying: symbol })}>
              <StockIcon name="link" color={t.colors.textSecondary} />
            </RoundIconButton>
            <RoundIconButton accessibilityLabel="Set a price alert" onPress={() => navigation.navigate('Alerts', { symbol })}>
              <StockIcon name="bell" color={t.colors.textSecondary} />
            </RoundIconButton>
            <RoundIconButton accessibilityLabel="Add to watchlist" onPress={() => openWatchlist(symbol, inst)}>
              <StockIcon name="bookmark" color={t.colors.textSecondary} />
            </RoundIconButton>
          </View>
        </View>

        <View style={s.priceRow}>
          <AppText variant="display" mono testID="stock-price">{fmtPx(figures.lastPrice, prec, cur)}</AppText>
          {figures.lastPrice !== null ? (
            <AppText variant="bodyStrong" tone={figures.up ? 'bull' : 'bear'} testID="stock-change">
              {changeLabel(figures, prec, cur)}
            </AppText>
          ) : null}
          <AppText variant="body" tone="muted">{tf}</AppText>
        </View>

        {/* Chart */}
        <View style={s.section}>
          <StockChart
            candles={chart.candles}
            timeframe={rangeSpec(tf).timeframe}
            mode={chartMode}
            up={figures.up}
            cur={cur}
            prec={prec}
            loading={chart.loading}
            error={chart.error}
            onRetry={() => { void chart.reload(); }}
          />
          <View style={s.ranges}>
            {STOCK_CHART_RANGES.map((r) => (
              <StockChip key={r.id} label={r.id} active={tf === r.id} minWidth={46} onPress={() => setTf(r.id)} />
            ))}
          </View>
          <View style={s.chartTools}>
            <RoundIconButton
              accessibilityLabel={chartMode === 'line' ? 'Switch to candles' : 'Switch to line'}
              onPress={() => setChartMode((m) => (m === 'line' ? 'candle' : 'line'))}
            >
              <ChartModeGlyph mode={chartMode} />
            </RoundIconButton>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Terminal"
              onPress={() => navigation.navigate('Trade', { symbol })}
              style={({ pressed }) => [s.terminal, pressed ? { backgroundColor: t.colors.bgHover } : null]}
            >
              <AppText variant="small" weight="600">Terminal</AppText>
              <StockIcon name="bars" size={14} color={t.colors.textPrimary} />
            </Pressable>
          </View>
        </View>

        {/* Tabs */}
        <Tabs
          tabs={STOCK_TABS.map((k) => ({ key: k, label: k }))}
          value={tab}
          onChange={setTab}
          fill
          style={s.tabs}
        />

        <View style={s.tabBody}>
          {tab === 'Overview' ? (
            <OverviewTab
              book={depth.book}
              figures={figures}
              cur={cur}
              prec={prec}
              candles={chart.candles}
              fund={fund}
              instruments={instruments}
              inst={inst}
              symbol={symbol}
              onOpenInstrument={openInstrument}
            />
          ) : tab === 'Technicals' ? (
            <TechnicalsTab
              candles={chart.candles}
              lastPrice={figures.lastPrice}
              fund={fund}
              dayLow={figures.dayLow}
              dayHigh={figures.dayHigh}
              cur={cur}
              prec={prec}
            />
          ) : tab === 'News' ? (
            <NewsTab symbol={symbol} name={name} refreshKey={refreshKey} />
          ) : (
            // Scoped to this symbol: the positions you are looking at the
            // chart of, closable without leaving the page.
            <View style={[s.positionsBox, { borderColor: t.colors.borderDark }]}>
              <PositionsPanel symbol={symbol} active={focused} testID="stock-positions" />
            </View>
          )}
        </View>

        {/* Room for the floating Trade button over the last row. */}
        <View style={s.fabSpace} />
      </Screen>

      {/* The web's below-lg floating "Trade" button. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open trade panel"
        onPress={() => setTradeOpen(true)}
        style={({ pressed }) => [
          s.fab,
          { bottom: insets.bottom + 20, transform: [{ scale: pressed ? 0.95 : 1 }] },
        ]}
      >
        <StockIcon name="trade" size={18} color={t.colors.onPrimary} strokeWidth={2} />
        <AppText variant="bodyStrong" weight="700" color={t.colors.onPrimary}>Trade</AppText>
      </Pressable>

      <OrderSheet
        visible={tradeOpen}
        onClose={closeTrade}
        instrument={inst}
        onPlaced={onPlaced}
      />
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  flex: { flex: 1, backgroundColor: t.colors.surface },
  flexShrink: { flexShrink: 1 },
  instError: { marginBottom: t.space.lg },
  headRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: t.space.md },
  headLeft: { flexDirection: 'row', alignItems: 'center', gap: t.space.md, flexShrink: 1 },
  headActions: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: t.space.md, marginTop: t.space.lg },
  section: { marginTop: t.space.xxl },
  ranges: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm, marginTop: t.space.lg },
  chartTools: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: t.space.sm, marginTop: t.space.sm },
  terminal: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: t.colors.borderDark,
  },
  tabs: { marginTop: t.space.xxl },
  tabBody: { marginTop: t.space.xxl },
  positionsBox: { height: 420, borderWidth: 1, borderRadius: t.radius.xl, overflow: 'hidden' },
  fabSpace: { height: 72 },
  fab: {
    position: 'absolute',
    right: t.space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.space.sm,
    paddingLeft: t.space.lg,
    paddingRight: t.space.xl,
    paddingVertical: t.space.md,
    borderRadius: 999,
    backgroundColor: t.colors.primary,
    ...t.shadow.elevated,
  },
}));
