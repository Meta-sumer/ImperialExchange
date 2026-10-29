import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Linking, Pressable, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { fetchInstrumentNews } from '@/api/news.api';
import { StockIcon } from '@/components/stock/StockIcons';
import { AppText, ErrorView, toast } from '@/components/ui';
import { makeStyles, useTheme } from '@/theme';
import type { InstrumentNewsItem } from '@/types/market';
import { newsEmptyText, newsMeta } from '@/utils/stockDetail';

/**
 * The News tab — StockDetail.jsx:713-736: the instrument's Yahoo headlines,
 * fetched each time the tab opens (the web's NewsTab mounts on switch).
 * A row opens the article in the browser, as the web's `target="_blank"`.
 *
 * One difference: the web turns a failed request into "No recent news";
 * here a failure says so and offers Retry.
 */

/** Only web links leave the app — a feed row is not trusted with any other scheme. */
export const isWebLink = (link: string | null | undefined): link is string => !!link && /^https?:\/\//i.test(link);

function NewsRow({ item, first }: { item: InstrumentNewsItem; first: boolean }): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  const [thumbOk, setThumbOk] = useState(true);
  const open = (): void => {
    if (!isWebLink(item.link)) return;
    Linking.openURL(item.link).catch(() => { toast.error("Couldn't open this article."); });
  };
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={item.title}
      onPress={open}
      disabled={!isWebLink(item.link)}
      style={({ pressed }) => [
        s.row,
        first ? null : { borderTopWidth: 1, borderTopColor: t.colors.borderSubtle },
        pressed ? { backgroundColor: t.colors.bgHover } : null,
      ]}
    >
      {item.thumbnail && thumbOk ? (
        <Image
          source={{ uri: item.thumbnail }}
          style={[s.thumb, { backgroundColor: t.colors.bgHover }]}
          resizeMode="cover"
          onError={() => setThumbOk(false)}
        />
      ) : null}
      <View style={s.body}>
        <AppText variant="bodyStrong">{item.title}</AppText>
        <AppText variant="caption" tone="muted" style={s.meta}>{newsMeta(item)}</AppText>
      </View>
      <View style={s.icon}>
        <StockIcon name="external" size={14} color={t.colors.textMuted} />
      </View>
    </Pressable>
  );
}

export function NewsTab({ symbol, name, refreshKey = 0 }: { symbol: string; name: string; refreshKey?: number }): React.JSX.Element {
  const s = useStyles();
  const [news, setNews] = useState<InstrumentNewsItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (quiet: boolean) => {
    const mine = ++seq.current;
    if (!quiet) { setNews(null); setError(null); }
    try {
      const rows = await fetchInstrumentNews(symbol);
      if (mine !== seq.current) return;
      setNews(rows);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      if (!quiet) setError(errorMessage(err));
    }
  }, [symbol]);

  useEffect(() => {
    void load(false);
    return () => { seq.current += 1; };
  }, [load]);

  // Pull-to-refresh on the page re-reads without blanking the list.
  const lastKey = useRef(refreshKey);
  useEffect(() => {
    if (lastKey.current === refreshKey) return;
    lastKey.current = refreshKey;
    void load(true);
  }, [refreshKey, load]);

  if (error && news === null) return <ErrorView compact error={error} onRetry={() => { void load(false); }} />;
  if (news === null) return <AppText variant="body" tone="muted" align="center" style={s.state}>Loading news…</AppText>;
  if (!news.length) return <AppText variant="body" tone="muted" align="center" style={s.state}>{newsEmptyText(name)}</AppText>;
  return (
    <View>
      {news.map((n, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <NewsRow key={i} item={n} first={i === 0} />
      ))}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  state: { paddingVertical: 64 },
  row: { flexDirection: 'row', gap: t.space.lg, paddingVertical: t.space.lg, paddingHorizontal: t.space.sm, marginHorizontal: -t.space.sm, borderRadius: t.radius.lg },
  thumb: { width: 96, height: 64, borderRadius: t.radius.lg },
  body: { flex: 1, minWidth: 0 },
  meta: { marginTop: 4 },
  icon: { marginTop: 4 },
}));
