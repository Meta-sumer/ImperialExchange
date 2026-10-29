import React, { useMemo, useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, View } from 'react-native';

import {
  MARKET_NEWS_TABS,
  marketNewsForTab,
  marketNewsTimeAgo,
  useMarketNews,
  type MarketNewsTab,
} from '@/api/news.api';
import { AppText, Button, toast } from '@/components/ui';
import { useAppNavigation } from '@/navigation/types';
import { useTheme } from '@/theme';
import type { MarketNewsItem, MarketNewsTag } from '@/types/market';
import type { Instrument } from '@/types/trading';

/**
 * Market News — client/src/components/MarketNews.jsx, Groww-style Indian
 * market headlines.
 *
 * Headlines come from GET /instruments/market-news (Economic Times, Mint,
 * Business Standard, BusinessLine RSS, global stories filtered out), each
 * tagged with the listed stocks / indices it mentions. Every story opens the
 * publisher's own article; a stock chip opens that stock's page and shows
 * its day change from the catalogue the screen already holds (`instruments`).
 *
 *   <MarketNewsSection />  the full list (Explore)
 *   <MarketNewsCard />     the compact card (the market list)
 *
 * One feed for the app (api/news.api useMarketNews): read once, re-read
 * every 5 minutes while the app is in the foreground.
 */

const openStory = (url: string | null): void => {
  if (!url) return;
  Linking.openURL(url).catch(() => { toast.error("Couldn't open this article."); });
};

function Thumb({ uri, size }: { uri: string | null; size: { width: number; height: number } }): React.JSX.Element | null {
  const t = useTheme();
  const [ok, setOk] = useState(Boolean(uri));
  if (!ok || !uri) return null;
  return (
    <Image
      source={{ uri }}
      accessibilityIgnoresInvertColors
      onError={() => setOk(false)}
      style={[styles.thumb, size, { backgroundColor: t.colors.bgCard }]}
      resizeMode="cover"
    />
  );
}

function StockChip({ tag, row }: { tag: MarketNewsTag; row: Instrument | undefined }): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  const ch = Number(row?.change24h);
  const has = row?.change24h !== null && row?.change24h !== undefined && Number.isFinite(ch);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={tag.name ? `${tag.symbol}, ${tag.name}` : tag.symbol}
      onPress={() => nav.navigate('StockDetail', { symbol: tag.symbol })}
      hitSlop={4}
      style={({ pressed }) => [
        styles.chip,
        { borderColor: t.colors.borderDark, backgroundColor: pressed ? t.colors.bgHover : 'transparent' },
      ]}
    >
      <AppText variant="micro" weight="600">{tag.symbol}</AppText>
      {has ? (
        <AppText variant="micro" weight="600" color={ch >= 0 ? t.colors.bull : t.colors.bear}>
          {`${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%`}
        </AppText>
      ) : null}
    </Pressable>
  );
}

function NewsRow({
  item,
  bySymbol,
  compact = false,
  last = false,
}: {
  item: MarketNewsItem;
  bySymbol: Map<string, Instrument>;
  compact?: boolean;
  last?: boolean;
}): React.JSX.Element {
  const t = useTheme();
  const meta = [item.source, marketNewsTimeAgo(item.publishedAt)].filter(Boolean).join(' · ');
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={item.title}
      accessibilityHint={item.source ? `Opens ${item.source}` : undefined}
      onPress={() => openStory(item.url)}
      style={({ pressed }) => [
        styles.row,
        !last ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.colors.borderSubtle } : null,
        pressed ? { opacity: 0.8 } : null,
      ]}
    >
      <View style={styles.flex}>
        <AppText variant="micro" weight="500" tone="muted" numberOfLines={1}>{meta}</AppText>
        <AppText variant={compact ? 'small' : 'bodyStrong'} weight="600" numberOfLines={2} style={styles.title}>
          {item.title}
        </AppText>
        {!compact && item.summary ? (
          <AppText variant="small" tone="secondary" numberOfLines={2} style={styles.summary}>{item.summary}</AppText>
        ) : null}
        {item.tags.length > 0 ? (
          <View style={styles.tags}>
            {item.tags.map((tag) => <StockChip key={tag.symbol} tag={tag} row={bySymbol.get(tag.symbol)} />)}
          </View>
        ) : null}
      </View>
      <Thumb uri={item.image} size={compact ? { width: 64, height: 64 } : { width: 96, height: 96 }} />
    </Pressable>
  );
}

const useBySymbol = (instruments: readonly Instrument[] | null | undefined): Map<string, Instrument> =>
  useMemo(() => new Map((instruments ?? []).map((r) => [r.symbol, r])), [instruments]);

/** MarketNewsSection — Explore's full list: two tabs, ten at a time, "Show more". */
export function MarketNewsSection({
  instruments,
  pageSize = 10,
  refreshKey = 0,
}: {
  instruments: readonly Instrument[] | null | undefined;
  pageSize?: number;
  refreshKey?: number;
}): React.JSX.Element {
  const t = useTheme();
  const items = useMarketNews(refreshKey);
  const bySymbol = useBySymbol(instruments);
  const [tab, setTab] = useState<MarketNewsTab>('all');
  const [shown, setShown] = useState(pageSize);
  const list = useMemo(() => marketNewsForTab(items, tab), [items, tab]);
  const visible = list.slice(0, shown);

  return (
    <View testID="market-news">
      <View style={styles.head}>
        <View style={styles.flex}>
          <AppText variant="title" weight="700">Market News</AppText>
          <AppText variant="caption" tone="secondary" style={styles.caption}>
            Latest from Indian markets — stocks, results, IPOs and the economy.
          </AppText>
        </View>
      </View>
      <View style={styles.tabs} accessibilityRole="tablist">
        {MARKET_NEWS_TABS.map(([k, label]) => {
          const active = tab === k;
          return (
            <Pressable
              key={k}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => { setTab(k); setShown(pageSize); }}
              style={({ pressed }) => [
                styles.tab,
                active
                  ? { backgroundColor: t.colors.primary, borderColor: t.colors.primary }
                  : { borderColor: t.colors.borderDark, backgroundColor: pressed ? t.colors.bgHover : 'transparent' },
              ]}
            >
              <AppText variant="caption" weight="600" color={active ? t.colors.onPrimary : t.colors.textSecondary}>{label}</AppText>
            </Pressable>
          );
        })}
      </View>

      <View style={[styles.card, { backgroundColor: t.colors.surface, borderColor: t.colors.borderDark }]}>
        {items === null ? (
          <AppText variant="body" tone="muted" align="center" style={styles.msg}>Loading news…</AppText>
        ) : null}
        {items !== null && list.length === 0 ? (
          <AppText variant="body" tone="muted" align="center" style={styles.msg}>
            No news right now. Check back in a few minutes.
          </AppText>
        ) : null}
        {visible.map((it, i) => (
          <NewsRow key={it.id} item={it} bySymbol={bySymbol} last={i === visible.length - 1} />
        ))}
      </View>

      {list.length > shown ? (
        <Button
          title="Show more"
          variant="secondary"
          size="sm"
          onPress={() => setShown((n) => n + pageSize)}
          style={styles.more}
        />
      ) : null}
      <AppText variant="micro" tone="muted" style={styles.note}>
        {"Headlines link to the publishers' websites (Economic Times, Mint, Business Standard, BusinessLine)."}
      </AppText>
    </View>
  );
}

/** MarketNewsCard — the market list's compact card: five headlines and "More news →". */
export function MarketNewsCard({
  instruments,
  max = 5,
  refreshKey = 0,
}: {
  instruments: readonly Instrument[] | null | undefined;
  max?: number;
  refreshKey?: number;
}): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  const items = useMarketNews(refreshKey);
  const bySymbol = useBySymbol(instruments);
  const top = (items ?? []).slice(0, max);
  return (
    <View style={[styles.sideCard, { backgroundColor: t.colors.surface, borderColor: t.colors.borderDark }]} testID="market-news-card">
      <AppText variant="bodyStrong">Market News</AppText>
      <View style={styles.caption}>
        {items === null ? <AppText variant="caption" tone="muted" style={styles.cardMsg}>Loading…</AppText> : null}
        {items !== null && items.length === 0 ? (
          <AppText variant="caption" tone="muted" style={styles.cardMsg}>No news right now.</AppText>
        ) : null}
        {top.map((it, i) => <NewsRow key={it.id} item={it} bySymbol={bySymbol} compact last={i === top.length - 1} />)}
      </View>
      <Pressable
        accessibilityRole="link"
        onPress={() => nav.navigate('Explore', { section: 'market-news' }, { pop: true })}
        hitSlop={8}
        style={styles.moreLink}
      >
        <AppText variant="caption" weight="600" color={t.colors.primaryText}>More news →</AppText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  head: { flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  caption: { marginTop: 4 },
  tabs: { flexDirection: 'row', gap: 8, marginTop: 12, marginBottom: 12 },
  tab: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1 },
  card: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 16 },
  sideCard: { borderWidth: 1, borderRadius: 16, padding: 20 },
  msg: { paddingVertical: 40 },
  cardMsg: { paddingVertical: 12 },
  row: { flexDirection: 'row', gap: 16, paddingVertical: 16 },
  title: { marginTop: 4 },
  summary: { marginTop: 4 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, borderWidth: 1 },
  thumb: { borderRadius: 12 },
  more: { alignSelf: 'center', marginTop: 12 },
  note: { marginTop: 8 },
  moreLink: { marginTop: 8, alignSelf: 'flex-start' },
});
