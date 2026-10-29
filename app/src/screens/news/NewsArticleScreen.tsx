import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';

import { fetchNewsArticle, type NewsArticle } from '@/api/news.api';
import { AppText, Button, ErrorView, Screen, Skeleton } from '@/components/ui';
import { HtmlContent } from '@/components/news/HtmlContent';
import { resolveMediaUrl } from '@/components/news/htmlParse';
import { NEWS_COPY, articleFailure, articlePath, byline, tagLabel } from '@/components/news/newsLogic';
import { API_URL, WEB_ORIGIN } from '@/constants/env';
import type { AppScreenProps } from '@/navigation/types';
import { useTheme } from '@/theme';
import { fmtDateTime } from '@/utils/fundsFlows';

/**
 * One Daily News article — client/src/pages/NewsArticle.jsx at /news/:slug.
 * Public, like the list. The back link, the loading skeleton, "Article not
 * found" with "All News", and the article: category, date and author; the
 * title; the featured image; the excerpt; the body; the tags.
 *
 * The body is the admin's HTML, which the web injects raw; here it is drawn
 * natively from an allow-list (components/news/HtmlContent), so it cannot
 * run code, and its links open app screens or the browser.
 *
 * The web's SEO tags (setPageSeo) have no phone equivalent and are not
 * ported. Difference, on purpose: only a 404 reads "Article not found"; a
 * dropped connection offers Retry (the web says "not found" for both).
 */

const MEDIA_ORIGIN = WEB_ORIGIN ?? API_URL.replace(/\/api\/?$/, '');

type State = 'loading' | 'ok' | 'notfound' | 'error';

export function NewsArticleScreen({ navigation, route }: AppScreenProps<'NewsArticle'>): React.JSX.Element {
  const t = useTheme();
  const slug = String(route.params?.slug ?? '').trim();
  const [article, setArticle] = useState<NewsArticle | null>(null);
  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState<unknown>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    if (!slug) { setState('notfound'); return; }
    setState((s) => (s === 'ok' ? s : 'loading'));
    try {
      const a = await fetchNewsArticle(slug);
      if (mine !== seq.current) return;
      setArticle(a);
      setError(null);
      setState('ok');
    } catch (err) {
      if (mine !== seq.current) return;
      setError(err);
      setState(articleFailure(err));
    }
  }, [slug]);

  useEffect(() => {
    setArticle(null);
    setState('loading');
    void load();
    return () => { seq.current += 1; };
  }, [load]);

  const allNews = () => navigation.navigate('News', undefined, { pop: true });

  const image = article ? resolveMediaUrl(article.featuredImageUrl, MEDIA_ORIGIN) : null;
  const by = byline(article?.author);

  return (
    <Screen onRefresh={state === 'ok' || state === 'error' ? load : undefined} testID="news-article-screen">
      <Pressable accessibilityRole="link" onPress={allNews} hitSlop={6} style={styles.back}>
        <AppText variant="body" color={t.colors.primaryText}>{NEWS_COPY.back}</AppText>
      </Pressable>

      {state === 'loading' ? (
        <View style={styles.skeleton} accessibilityLabel="Loading article">
          <Skeleton width="66%" height={32} />
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} width={`${90 - i * 10}%` as `${number}%`} height={16} />)}
        </View>
      ) : null}

      {state === 'notfound' ? (
        <View style={styles.notFound}>
          <AppText variant="h1" align="center">{NEWS_COPY.notFound}</AppText>
          <Button title={NEWS_COPY.allNews} onPress={allNews} style={styles.allNews} />
        </View>
      ) : null}

      {state === 'error' ? (
        <ErrorView error={error} title={NEWS_COPY.articleFailed} onRetry={() => { void load(); }} />
      ) : null}

      {state === 'ok' && article ? (
        <View style={styles.article}>
          <View style={styles.metaRow}>
            <View style={[styles.catPill, { backgroundColor: t.colors.primarySoft }]}>
              <AppText variant="small" weight="600" color={t.colors.primaryText}>{article.category}</AppText>
            </View>
            <AppText variant="small" tone="muted">{fmtDateTime(article.publishDate)}</AppText>
            {by ? <AppText variant="small" tone="muted">{`· ${by}`}</AppText> : null}
          </View>
          <AppText variant="display" accessibilityRole="header">{article.title}</AppText>
          {image ? <FeaturedImage uri={image} label={article.title} /> : <View style={styles.heroGap} />}
          {article.excerpt ? (
            <AppText variant="h3" weight="400" tone="secondary" style={styles.excerpt}>{article.excerpt}</AppText>
          ) : null}
          <HtmlContent html={article.content} basePath={articlePath(article.slug || slug)} testID="news-article-body" />
          {article.tags.length ? (
            <View style={[styles.tags, { borderTopColor: t.colors.borderSubtle }]}>
              {article.tags.map((tag) => (
                <View key={tag} style={[styles.tag, { backgroundColor: t.colors.bgHover }]}>
                  <AppText variant="small" tone="muted">{tagLabel(tag)}</AppText>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </Screen>
  );
}

/** The web's `w-full max-h-[400px] object-cover`: full width at its own proportions, capped at 400. */
function FeaturedImage({ uri, label }: { uri: string; label: string }): React.JSX.Element | null {
  const t = useTheme();
  const [ratio, setRatio] = useState(16 / 9);
  const [width, setWidth] = useState(0);
  const [failed, setFailed] = useState(false);
  if (failed) return <View style={styles.heroGap} />;
  const height = width ? Math.min(400, width / ratio) : 220;
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={styles.heroBox}>
      <Image
        source={{ uri }}
        accessibilityLabel={label}
        resizeMode="cover"
        onLoad={(e) => {
          const s = e.nativeEvent.source;
          if (s && s.width > 0 && s.height > 0) setRatio(s.width / s.height);
        }}
        onError={() => setFailed(true)}
        style={[styles.hero, { height, borderColor: t.colors.borderDark }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  back: { alignSelf: 'flex-start' },
  skeleton: { gap: 12, marginTop: 24 },
  notFound: { alignItems: 'center', paddingVertical: 80 },
  allNews: { marginTop: 24 },
  article: { marginTop: 16 },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  catPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  heroBox: { marginVertical: 24 },
  hero: { width: '100%', borderRadius: 12, borderWidth: 1 },
  heroGap: { marginTop: 24 },
  excerpt: { marginBottom: 16 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 32, paddingTop: 16, borderTopWidth: 1 },
  tag: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
});
