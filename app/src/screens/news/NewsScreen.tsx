import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { fetchNewsCategories, fetchNewsPage, type NewsArticle } from '@/api/news.api';
import { AppText, Button, Card, ErrorView, Input, Screen, Skeleton } from '@/components/ui';
import { resolveMediaUrl } from '@/components/news/htmlParse';
import {
  EMPTY_PAGINATION,
  NEWS_COPY,
  byline,
  canNext,
  canPrev,
  newsQuery,
  pageLabel,
  showPager,
} from '@/components/news/newsLogic';
import { API_URL, WEB_ORIGIN } from '@/constants/env';
import type { AppScreenProps } from '@/navigation/types';
import { useTheme } from '@/theme';
import { fmtDateTime } from '@/utils/fundsFlows';

/**
 * Daily News Updates — client/src/pages/News.jsx at /news. Public: a visitor
 * gets the public header, a signed-in reader the app header (the navigator
 * does PublicShell's job). Latest first, a search box, the category chips,
 * twelve to a page, each card opening the article.
 *
 * Phone layout: the web's 1-3 column grid is one column; the chips wrap as
 * on the web. A page change scrolls back to the top (the web leaves the
 * reader at the pager, under a column of skeletons).
 *
 * Difference, on purpose: a failed load says so with Retry. The web catches
 * it and shows "No news articles yet.", which tells a reader offline that
 * there is no news.
 */

const MEDIA_ORIGIN = WEB_ORIGIN ?? API_URL.replace(/\/api\/?$/, '');

export function NewsScreen({ navigation }: AppScreenProps<'News'>): React.JSX.Element {
  const t = useTheme();
  const scrollRef = useRef<ScrollView>(null);
  const [items, setItems] = useState<NewsArticle[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState(EMPTY_PAGINATION);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const loadCategories = useCallback(() => {
    fetchNewsCategories().then(setCats).catch(() => { /* the chips just do not show, as on the web */ });
  }, []);
  useEffect(() => { loadCategories(); }, [loadCategories]);

  // Only the newest request's answer lands — a fast page / chip change must
  // not be overwritten by a slower earlier one.
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const res = await fetchNewsPage(newsQuery(page, search, category));
      if (mine !== seq.current) return;
      setItems(res.items);
      setPagination({ page: res.page, pages: res.pages, total: res.total });
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      setItems([]);
      setError(err);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [page, search, category]);
  useEffect(() => { void load(); }, [load]);

  const refresh = useCallback(async () => {
    loadCategories();
    await load();
  }, [load, loadCategories]);

  const submit = () => {
    setPage(1);
    setSearch(q);
  };

  const pickCategory = (c: string) => {
    setCategory(c);
    setPage(1);
  };

  const goPage = (next: number) => {
    setPage(next);
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  };

  return (
    <Screen onRefresh={refresh} scrollRef={scrollRef} testID="news-screen">
      <View style={styles.head}>
        <AppText variant="display" style={styles.title}>{NEWS_COPY.title}</AppText>
        <AppText variant="body" tone="secondary" style={styles.subtitle}>{NEWS_COPY.subtitle}</AppText>
        <View style={styles.searchRow}>
          <View style={styles.flex}>
            <Input
              value={q}
              onChangeText={setQ}
              placeholder={NEWS_COPY.searchPlaceholder}
              returnKeyType="search"
              onSubmitEditing={submit}
              autoCorrect={false}
              accessibilityLabel="Search news"
            />
          </View>
          <Button title={NEWS_COPY.search} size="md" onPress={submit} />
        </View>
      </View>

      {cats.length > 0 ? (
        <View style={styles.chips}>
          <Chip label={NEWS_COPY.all} active={!category} onPress={() => pickCategory('')} />
          {cats.map((c) => <Chip key={c} label={c} active={category === c} onPress={() => pickCategory(c)} />)}
        </View>
      ) : null}

      {loading ? (
        <View style={styles.grid} accessibilityLabel="Loading news">
          {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={256} radius={t.radius.xl} />)}
        </View>
      ) : error ? (
        <ErrorView error={error} title={NEWS_COPY.loadFailed} onRetry={() => { void load(); }} />
      ) : items.length === 0 ? (
        <AppText variant="body" tone="muted" align="center" style={styles.empty}>{NEWS_COPY.empty}</AppText>
      ) : (
        <View style={styles.grid}>
          {items.map((a) => (
            <NewsCard
              key={a.id || a.slug}
              article={a}
              onPress={() => navigation.navigate('NewsArticle', { slug: a.slug })}
            />
          ))}
        </View>
      )}

      {showPager(pagination.pages) ? (
        <View style={styles.pager}>
          <Button title={NEWS_COPY.prev} variant="secondary" size="sm" disabled={!canPrev(page)} onPress={() => goPage(page - 1)} />
          <AppText variant="body" tone="secondary">{pageLabel(pagination)}</AppText>
          <Button
            title={NEWS_COPY.next}
            variant="secondary"
            size="sm"
            disabled={!canNext(page, pagination.pages)}
            onPress={() => goPage(page + 1)}
          />
        </View>
      ) : null}
    </Screen>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: active ? t.colors.primary : 'transparent',
          borderColor: active ? t.colors.primary : pressed ? t.colors.primary : t.colors.borderDark,
        },
      ]}
    >
      <AppText variant="smallStrong" color={active ? t.colors.onPrimary : t.colors.textSecondary}>{label}</AppText>
    </Pressable>
  );
}

function NewsCard({ article: a, onPress }: { article: NewsArticle; onPress: () => void }): React.JSX.Element {
  const t = useTheme();
  const image = resolveMediaUrl(a.featuredImageUrl, MEDIA_ORIGIN);
  const by = byline(a.author);
  return (
    <Card padded={false} onPress={onPress} accessibilityLabel={a.title} style={styles.card}>
      {image ? (
        <Image source={{ uri: image }} accessibilityLabel={a.title} style={styles.cardImage} resizeMode="cover" />
      ) : (
        <View style={[styles.cardImage, styles.noImage, { backgroundColor: t.colors.bgHover }]}>
          <AppText variant="body" tone="muted">{NEWS_COPY.noImage}</AppText>
        </View>
      )}
      <View style={styles.cardBody}>
        <View style={styles.metaRow}>
          <View style={[styles.catPill, { backgroundColor: t.colors.primarySoft }]}>
            <AppText variant="caption" weight="600" color={t.colors.primaryText}>{a.category}</AppText>
          </View>
          <AppText variant="caption" tone="muted">{fmtDateTime(a.publishDate)}</AppText>
        </View>
        <AppText variant="title" numberOfLines={2}>{a.title}</AppText>
        {a.excerpt ? <AppText variant="body" tone="secondary" numberOfLines={3} style={styles.excerpt}>{a.excerpt}</AppText> : null}
        {by ? <AppText variant="small" tone="muted" style={styles.by}>{by}</AppText> : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  head: { marginBottom: 24 },
  title: { marginBottom: 4 },
  subtitle: { marginBottom: 16 },
  searchRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 24 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1 },
  grid: { gap: 20 },
  empty: { paddingVertical: 80 },
  card: { overflow: 'hidden' },
  cardImage: { width: '100%', height: 160 },
  noImage: { alignItems: 'center', justifyContent: 'center' },
  cardBody: { padding: 16 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' },
  catPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  excerpt: { marginTop: 6 },
  by: { marginTop: 8 },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 32 },
});
