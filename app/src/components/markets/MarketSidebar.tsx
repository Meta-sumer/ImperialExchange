import { useIsFocused } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { fetchDashboard } from '@/api/dashboard.api';
import { WatchlistButton } from '@/components/market/WatchlistButton';
import { AppText, AssetIcon, Icon } from '@/components/ui';
import { useAppNavigation } from '@/navigation/types';
import { useTheme } from '@/theme';
import type { DashboardSummary, Instrument } from '@/types/trading';
import { fmtMoney } from '@/utils/money';
import {
  EXPLORE_TILES,
  HIDDEN_RETURNS,
  HIDDEN_VALUE,
  LIST_DOWN,
  LIST_UP,
  TOP_MOVER_TABS,
  fmtListPrice,
  moverChange,
  portfolioFigures,
  portfolioReturnsText,
  topMovers,
  type TopMoverTab,
} from '@/utils/markets';
import { subscribeOrders, subscribePositions, subscribeWallet } from '@/websocket/channels';

import { MarketIcon } from './MarketIcons';
import { PillTabs } from './PillTabs';
import { livePriceOf, useLivePrices } from './useLivePrices';

/**
 * MarketList's right-hand column, stacked under the table on a phone as the
 * web stacks it: portfolio, top movers, Market News (components/news) and
 * the explore links.
 */

const CARD_RADIUS = 16;

function useCardStyle(): { backgroundColor: string; borderColor: string; borderWidth: number; borderRadius: number; padding: number } {
  const t = useTheme();
  return { backgroundColor: t.colors.surface, borderColor: t.colors.borderDark, borderWidth: 1, borderRadius: CARD_RADIUS, padding: 20 };
}

/* ── Your Portfolio ───────────────────────────────────────────────────── */

/**
 * PortfolioCard — `/user/dashboard`, re-read on `user:wallet`,
 * `user:positions` and `user:orders` (the web's three events), shown as the
 * web computes it (utils/markets portfolioFigures). A failed read leaves the
 * last figures (zeros before the first). No KYC prompt, no paywall.
 *
 * The events are listened to only while the screen is focused; coming back
 * re-reads once, since anything missed underneath is not replayed. Only the
 * newest answer lands when reads overlap. `refreshKey` (pull-to-refresh)
 * re-reads too.
 */
export function PortfolioCard({ refreshKey = 0 }: { refreshKey?: number }): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  const card = useCardStyle();
  const focused = useIsFocused();
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [hidden, setHidden] = useState(false);
  const seq = useRef(0);
  const alive = useRef(true);

  const load = useCallback(async () => {
    seq.current += 1;
    const mine = seq.current;
    try {
      const d = await fetchDashboard();
      if (alive.current && mine === seq.current) setData(d);
    } catch { /* leave empty — render zeros */ }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (!focused) return undefined;
    void load();
    const reload = () => { void load(); };
    const offs = [subscribeWallet(reload), subscribePositions(reload), subscribeOrders(reload)];
    return () => { for (const off of offs) off(); };
  }, [focused, load]);

  const firstKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === firstKey.current) return;
    void load();
  }, [refreshKey, load]);

  const f = portfolioFigures(data);
  const fmt = (v: number): string => (hidden ? HIDDEN_VALUE : fmtMoney(v, f.currency, 2));
  const returns = portfolioReturnsText(f);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Your Portfolio"
      onPress={() => nav.navigate('Dashboard')}
      style={({ pressed }) => [card, pressed ? { backgroundColor: t.colors.bgHover } : null]}
    >
      <View style={styles.headRow}>
        <View style={styles.headLeft}>
          <AppText variant="bodyStrong">Your Portfolio</AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={hidden ? 'Show values' : 'Hide values'}
            hitSlop={10}
            onPress={() => setHidden((h) => !h)}
          >
            <Icon name={hidden ? 'eyeOff' : 'eye'} size={16} color={t.colors.textMuted} />
          </Pressable>
        </View>
        <Icon name="chevronRight" size={16} color={t.colors.textMuted} strokeWidth={2} />
      </View>

      <View style={styles.mt16}>
        <AppText variant="caption" tone="muted" weight="500" style={styles.upper}>Current Value</AppText>
        <AppText variant="h1" mono style={styles.mt4} testID="portfolio-current">{fmt(f.currentValue)}</AppText>
      </View>

      <View style={[styles.mt16, styles.split]}>
        <View>
          <AppText variant="caption" tone="muted" weight="500" style={styles.upper}>Invested Value</AppText>
          <AppText variant="bodyStrong" mono style={styles.mt4} testID="portfolio-invested">{fmt(f.investedValue)}</AppText>
        </View>
        <View style={styles.right}>
          <AppText variant="caption" tone="muted" weight="500" style={styles.upper}>Total Returns</AppText>
          <AppText variant="bodyStrong" mono style={styles.mt4} color={f.positive ? LIST_UP : LIST_DOWN} testID="portfolio-returns">
            {hidden ? HIDDEN_RETURNS : (
              <>
                {returns.value}
                <AppText variant="bodyStrong" weight="500" mono color={f.positive ? LIST_UP : LIST_DOWN}>{` ${returns.pct}`}</AppText>
              </>
            )}
          </AppText>
        </View>
      </View>
    </Pressable>
  );
}

/* ── Top Movers ───────────────────────────────────────────────────────── */

const MOVER_TABS = TOP_MOVER_TABS.map((k) => ({ key: k, label: k }));

/**
 * TopMoversCard — three rows of the page's own instruments for the tab, no
 * extra request. Their prices are kept live (coalesced, paused off-screen).
 */
export function TopMoversCard({ rows }: { rows: readonly Instrument[] }): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  const card = useCardStyle();
  const [tab, setTab] = useState<TopMoverTab>('Gainers');
  const list = useMemo(() => topMovers(rows, tab), [rows, tab]);
  const symbols = useMemo(() => list.map((r) => r.symbol), [list]);
  const prices = useLivePrices(symbols);

  return (
    <View style={card}>
      <AppText variant="bodyStrong">Top Movers</AppText>
      <PillTabs tabs={MOVER_TABS} value={tab} onChange={setTab} look="brand" style={styles.mt12} />
      <View style={styles.mt12}>
        {list.length === 0 ? (
          <AppText variant="small" tone="muted" align="center" style={styles.pad12}>Loading…</AppText>
        ) : null}
        {list.map((r) => {
          const price = livePriceOf(prices, r);
          const ch = moverChange(r, price);
          return (
            <Pressable
              key={r.symbol}
              accessibilityRole="button"
              accessibilityLabel={r.symbol}
              onPress={() => nav.navigate('StockDetail', { symbol: r.symbol })}
              style={({ pressed }) => [styles.moverRow, { borderRadius: t.radius.lg }, pressed ? { backgroundColor: t.colors.bgHover } : null]}
            >
              <AssetIcon row={r} size={28} />
              <View style={styles.flex}>
                <AppText variant="body" weight="500" numberOfLines={1}>{r.symbol}</AppText>
              </View>
              <View style={styles.right}>
                <AppText variant="body" mono>{fmtListPrice(price, r.pricePrecision, r.quoteCurrency)}</AppText>
                {ch ? (
                  <AppText variant="caption" mono weight="600" color={ch.positive ? LIST_UP : LIST_DOWN}>{ch.text}</AppText>
                ) : null}
              </View>
              <WatchlistButton symbol={r.symbol} row={r} variant="inline" size={14} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/* ── Explore ──────────────────────────────────────────────────────────── */

/** ExploreLinksCard — four segment tiles, each opening the most-traded list for its segment. */
export function ExploreLinksCard(): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  const card = useCardStyle();
  return (
    <View style={card}>
      <View style={styles.headRow}>
        <AppText variant="bodyStrong">Explore</AppText>
        <Pressable accessibilityRole="link" accessibilityLabel="Explore" hitSlop={10} onPress={() => nav.navigate('Explore')}>
          <Icon name="chevronRight" size={16} color={t.colors.textMuted} strokeWidth={2} />
        </Pressable>
      </View>
      <View style={[styles.tiles, styles.mt16]}>
        {EXPLORE_TILES.map((tile) => (
          <Pressable
            key={tile.label}
            accessibilityRole="link"
            accessibilityLabel={tile.label}
            onPress={() => nav.navigate('MarketList', { view: tile.view, sector: tile.sector })}
            style={({ pressed }) => [styles.tile, pressed ? styles.lift : null]}
          >
            <View style={[styles.tileIcon, { backgroundColor: `${tile.tint}15` }]}>
              <MarketIcon name={tile.icon} size={20} color={tile.tint} />
            </View>
            <AppText variant="caption" tone="secondary" weight="500" align="center" numberOfLines={1}>{tile.label}</AppText>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  upper: { textTransform: 'uppercase', letterSpacing: 0.8 },
  mt4: { marginTop: 4 },
  mt12: { marginTop: 12 },
  mt16: { marginTop: 16 },
  pad12: { paddingVertical: 12 },
  split: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 },
  right: { alignItems: 'flex-end' },
  moverRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, paddingVertical: 8, marginHorizontal: -8 },
  tiles: { flexDirection: 'row', gap: 12 },
  tile: { flex: 1, alignItems: 'center', gap: 8 },
  tileIcon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  lift: { transform: [{ translateY: -2 }] },
});
