import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, Image, Modal, RefreshControl, StyleSheet,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../services/api';
import { useColors, radius } from '../theme';
import { Empty } from '../components/ui';

/**
 * NewsScreen — native port of the web client's "Daily News Updates" pages
 * (client/src/pages/News.jsx + client/src/pages/NewsArticle.jsx). Mirrors them
 * section-for-section against the SAME public CMS endpoints:
 *   • GET /cms/news              (list: page/limit/q/category, newest first)
 *   • GET /cms/news/categories   (chip filter row)
 *   • GET /cms/news/:slug        (full article incl. HTML `content`)
 *
 * Sections (list): header (title + subtitle + search) · category chip row ·
 * article cards (featured image · category pill · date · title · excerpt ·
 * author) · loading skeletons / empty state · Prev/Next pagination.
 *
 * Tapping a card opens the article DETAIL in a full-screen <Modal> in this same
 * file: back bar · category/date/author · title · image · excerpt · body · tags.
 *
 * NATIVE ADAPTATIONS
 *  • The web's responsive 1/2/3-col grid collapses to a single-column card list
 *    (matches the web's own `grid-cols-1` mobile breakpoint).
 *  • The CMS `content` is sanitized HTML. React Native has no DOM, so instead of
 *    the web's dangerouslySetInnerHTML we convert the HTML to readable plain-text
 *    paragraphs (htmlToParagraphs): <br>/block tags → paragraph breaks, <li> →
 *    bullet lines, entities decoded, tags stripped. Each paragraph renders as a
 *    <Text> block for a clean, scrollable read.
 *  • Dates are formatted locally (day-month-year) rather than the web's raw
 *    toLocaleString, so they read cleanly on a card.
 *  • Remote thumbnails load via <Image source={{uri}}> with a graceful "No image"
 *    fallback on missing URL or load error.
 */

// ─── Pure helpers (module scope — no styles/c captured here) ───────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
}

// Decode the common HTML entities a CMS body is likely to contain.
function decodeEntities(str) {
  if (!str) return '';
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
    ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', deg: '°',
  };
  const cp = (n, base) => {
    const v = parseInt(n, base);
    return Number.isFinite(v) && v >= 0 && v <= 0x10ffff ? String.fromCodePoint(v) : '';
  };
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => cp(h, 16))
    .replace(/&#(\d+);/g, (_, n) => cp(n, 10))
    .replace(/&([a-zA-Z]+);/g, (m, name) => {
      const hit = named[name] != null ? named[name] : named[name.toLowerCase()];
      return hit != null ? hit : m;
    });
}

// Convert sanitized CMS HTML → an array of readable plain-text paragraphs.
function htmlToParagraphs(html) {
  if (!html || typeof html !== 'string') return [];
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n• ');
  s = s.replace(/<\/(p|div|h[1-6]|ul|ol|blockquote|section|article|header|footer|tr|table|pre)>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\r/g, '');
  s = s.replace(/[ \t]{2,}/g, ' ');
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

// ─── Presentational pieces (receive styles / c via props — no module `c`) ──
function Chip({ active, label, onPress, styles, c }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.8} style={[styles.chip, active && styles.chipOn]}>
      <Text style={[styles.chipTxt, active && styles.chipTxtOn]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

// Remote image with graceful fallback. `big` selects the article-detail sizing.
function CardImage({ uri, big, styles, c }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [uri]);
  const imgStyle = big ? styles.detailImg : styles.cardImg;
  const fbStyle = big ? styles.detailImgFallback : styles.cardImgFallback;
  if (uri && !failed) {
    return <Image source={{ uri }} onError={() => setFailed(true)} resizeMode="cover" style={imgStyle} />;
  }
  return (
    <View style={fbStyle}>
      <Ionicons name="image-outline" size={22} color={c.textMuted} />
      <Text style={styles.imgFallbackTxt}>No image</Text>
    </View>
  );
}

function NewsCard({ item, onPress, styles, c }) {
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress} style={styles.card}>
      <CardImage uri={item.featuredImageUrl} styles={styles} c={c} />
      <View style={styles.cardBody}>
        <View style={styles.metaRow}>
          <View style={styles.catPill}><Text style={styles.catPillTxt}>{item.category}</Text></View>
          <Text style={styles.metaDate}>{fmtDate(item.publishDate)}</Text>
        </View>
        <Text style={styles.cardTitle} numberOfLines={2}>{item.title}</Text>
        {item.excerpt ? <Text style={styles.cardExcerpt} numberOfLines={3}>{item.excerpt}</Text> : null}
        {item.author ? <Text style={styles.cardAuthor}>By {item.author}</Text> : null}
      </View>
    </TouchableOpacity>
  );
}

function SkeletonCard({ styles }) {
  return (
    <View style={styles.card}>
      <View style={styles.skelImg} />
      <View style={styles.cardBody}>
        <View style={[styles.skelLine, { width: '40%', height: 12 }]} />
        <View style={[styles.skelLine, { width: '92%', height: 16, marginTop: 12 }]} />
        <View style={[styles.skelLine, { width: '68%', height: 16, marginTop: 6 }]} />
        <View style={[styles.skelLine, { width: '100%', height: 12, marginTop: 14 }]} />
        <View style={[styles.skelLine, { width: '80%', height: 12, marginTop: 6 }]} />
      </View>
    </View>
  );
}

// ─── Article detail (full-screen modal in this same file) ──────────────────
function ArticleDetail({ slug, visible, onClose, styles, c, insets }) {
  const [article, setArticle] = useState(null);
  const [state, setState] = useState('loading'); // loading | ok | notfound

  useEffect(() => {
    if (!slug) return undefined;
    let on = true;
    setState('loading');
    setArticle(null);
    api.get(`/cms/news/${slug}`)
      .then((r) => { if (!on) return; setArticle(r.data.data); setState('ok'); })
      .catch(() => { if (on) setState('notfound'); });
    return () => { on = false; };
  }, [slug]);

  const paragraphs = useMemo(() => (article ? htmlToParagraphs(article.content) : []), [article]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.detailBar}>
          <TouchableOpacity onPress={onClose} activeOpacity={0.7} style={styles.backBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="arrow-back" size={18} color={c.primary500} />
            <Text style={styles.backTxt}>Back to News</Text>
          </TouchableOpacity>
        </View>

        {state === 'loading' && (
          <View style={styles.detailBody}>
            <View style={[styles.skelLine, { width: '66%', height: 26 }]} />
            {[0, 1, 2, 3].map((i) => (
              <View key={i} style={[styles.skelLine, { width: `${90 - i * 10}%`, height: 14, marginTop: 14 }]} />
            ))}
          </View>
        )}

        {state === 'notfound' && (
          <View style={styles.notFound}>
            <Text style={styles.notFoundTitle}>Article not found</Text>
            <TouchableOpacity style={styles.notFoundBtn} activeOpacity={0.85} onPress={onClose}>
              <Text style={styles.notFoundBtnTxt}>All News</Text>
            </TouchableOpacity>
          </View>
        )}

        {state === 'ok' && article && (
          <ScrollView contentContainerStyle={styles.detailScroll} showsVerticalScrollIndicator={false}>
            <View style={styles.metaRow}>
              <View style={styles.catPill}><Text style={styles.catPillTxt}>{article.category}</Text></View>
              <Text style={styles.metaDate}>{fmtDate(article.publishDate)}</Text>
              {article.author ? <Text style={styles.metaDate}>· By {article.author}</Text> : null}
            </View>
            <Text style={styles.detailTitle}>{article.title}</Text>
            {article.featuredImageUrl
              ? <CardImage uri={article.featuredImageUrl} big styles={styles} c={c} />
              : <View style={{ height: 16 }} />}
            {article.excerpt ? <Text style={styles.detailExcerpt}>{article.excerpt}</Text> : null}
            {paragraphs.map((p, i) => <Text key={i} style={styles.bodyPara}>{p}</Text>)}
            {article.tags && article.tags.length ? (
              <View style={styles.tagsWrap}>
                {article.tags.map((t) => (
                  <View key={t} style={styles.tag}><Text style={styles.tagTxt}>#{t}</Text></View>
                ))}
              </View>
            ) : null}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

// ─── Screen ────────────────────────────────────────────────────────────────
export default function NewsScreen() {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();

  const [items, setItems] = useState([]);
  const [cats, setCats] = useState([]);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeSlug, setActiveSlug] = useState(null);

  // Categories once (mirrors the web's separate effect).
  useEffect(() => {
    let on = true;
    api.get('/cms/news/categories').then((r) => { if (on) setCats(r.data.data || []); }).catch(() => {});
    return () => { on = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 12 };
      if (search) params.q = search;
      if (category) params.category = category;
      const { data } = await api.get('/cms/news', { params });
      setItems(data.data.items || []);
      setPagination(data.data.pagination || { page: 1, pages: 1, total: 0 });
    } catch (_) {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [page, search, category]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);
  const submitSearch = () => { setPage(1); setSearch(q); };

  const ListHeader = (
    <View>
      <View style={styles.headWrap}>
        <Text style={styles.title}>Daily News Updates</Text>
        <Text style={styles.subtitle}>Latest market news, analysis and announcements.</Text>
        <View style={styles.searchRow}>
          <View style={styles.searchWrap}>
            <Ionicons name="search" size={16} color={c.textMuted} />
            <TextInput
              value={q}
              onChangeText={setQ}
              onSubmitEditing={submitSearch}
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Search news…"
              placeholderTextColor={c.textMuted}
              style={styles.searchInput}
            />
          </View>
          <TouchableOpacity style={styles.searchBtn} activeOpacity={0.85} onPress={submitSearch}>
            <Text style={styles.searchBtnTxt}>Search</Text>
          </TouchableOpacity>
        </View>
      </View>

      {cats.length > 0 && (
        <View style={styles.chipsWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsScroll}>
            <Chip active={!category} label="All" onPress={() => { setCategory(''); setPage(1); }} styles={styles} c={c} />
            {cats.map((cat0) => (
              <Chip
                key={cat0}
                active={category === cat0}
                label={cat0}
                onPress={() => { setCategory(cat0); setPage(1); }}
                styles={styles}
                c={c}
              />
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );

  const ListFooter = !loading && pagination.pages > 1 ? (
    <View style={styles.pagWrap}>
      <TouchableOpacity
        disabled={page <= 1}
        activeOpacity={0.85}
        onPress={() => setPage(page - 1)}
        style={[styles.pagBtn, page <= 1 && styles.pagBtnDisabled]}
      >
        <Text style={styles.pagBtnTxt}>Prev</Text>
      </TouchableOpacity>
      <Text style={styles.pagInfo}>Page {pagination.page} / {pagination.pages}</Text>
      <TouchableOpacity
        disabled={page >= pagination.pages}
        activeOpacity={0.85}
        onPress={() => setPage(page + 1)}
        style={[styles.pagBtn, page >= pagination.pages && styles.pagBtnDisabled]}
      >
        <Text style={styles.pagBtnTxt}>Next</Text>
      </TouchableOpacity>
    </View>
  ) : null;

  const ListEmpty = loading ? (
    <View style={styles.skeletonWrap}>
      {[0, 1, 2, 3].map((i) => <SkeletonCard key={i} styles={styles} />)}
    </View>
  ) : (
    <Empty title="No news articles yet." sub="Check back soon for the latest market updates." />
  );

  return (
    <View style={styles.screen}>
      <FlashList
        data={loading ? [] : items}
        extraData={c}
        keyExtractor={(item) => item._id || item.slug}
        estimatedItemSize={340}
        contentContainerStyle={{ paddingBottom: 28 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary500} />}
        ListHeaderComponent={ListHeader}
        ListFooterComponent={ListFooter}
        ListEmptyComponent={ListEmpty}
        renderItem={({ item }) => (
          <NewsCard item={item} onPress={() => setActiveSlug(item.slug)} styles={styles} c={c} />
        )}
      />

      <ArticleDetail
        slug={activeSlug}
        visible={!!activeSlug}
        onClose={() => setActiveSlug(null)}
        styles={styles}
        c={c}
        insets={insets}
      />
    </View>
  );
}

const makeStyles = (c) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },

  // Header
  headWrap: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6 },
  title: { fontSize: 24, fontWeight: '900', color: c.textPrimary },
  subtitle: { fontSize: 13, color: c.textSecondary, marginTop: 4 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
  searchWrap: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 44,
    borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, backgroundColor: c.card,
  },
  searchInput: { flex: 1, fontSize: 15, color: c.textPrimary, padding: 0 },
  searchBtn: { height: 44, paddingHorizontal: 18, borderRadius: radius.md, backgroundColor: c.primary500, alignItems: 'center', justifyContent: 'center' },
  searchBtnTxt: { color: c.white, fontSize: 14, fontWeight: '700' },

  // Category chips
  chipsWrap: { marginTop: 4 },
  chipsScroll: { paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, marginRight: 8 },
  chipOn: { backgroundColor: c.primary500, borderColor: c.primary500 },
  chipTxt: { fontSize: 12, fontWeight: '700', color: c.textSecondary },
  chipTxtOn: { color: c.white },

  // Article card
  card: { marginHorizontal: 16, marginTop: 14, borderRadius: radius.xl, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, overflow: 'hidden' },
  cardImg: { width: '100%', height: 176, backgroundColor: c.hover },
  cardImgFallback: { width: '100%', height: 176, backgroundColor: c.hover, alignItems: 'center', justifyContent: 'center', gap: 4 },
  imgFallbackTxt: { fontSize: 12, color: c.textMuted },
  cardBody: { padding: 14 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  catPill: { backgroundColor: c.primarySoft, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill },
  catPillTxt: { color: c.primary500, fontSize: 11, fontWeight: '800' },
  metaDate: { fontSize: 11, color: c.textMuted },
  cardTitle: { fontSize: 16, fontWeight: '800', color: c.textPrimary, marginTop: 8, lineHeight: 21 },
  cardExcerpt: { fontSize: 13, color: c.textSecondary, marginTop: 6, lineHeight: 19 },
  cardAuthor: { fontSize: 12, color: c.textMuted, marginTop: 8 },

  // Loading skeletons
  skeletonWrap: { paddingBottom: 4 },
  skelImg: { width: '100%', height: 176, backgroundColor: c.hover },
  skelLine: { backgroundColor: c.hover, borderRadius: radius.sm },

  // Pagination
  pagWrap: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 24, paddingHorizontal: 16 },
  pagBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.card },
  pagBtnDisabled: { opacity: 0.35 },
  pagBtnTxt: { fontSize: 13, fontWeight: '700', color: c.textSecondary },
  pagInfo: { fontSize: 13, color: c.textSecondary },

  // Article detail (modal)
  detailBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.borderSubtle, backgroundColor: c.bg },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 4 },
  backTxt: { fontSize: 14, fontWeight: '700', color: c.primary500 },
  detailBody: { padding: 20 },
  detailScroll: { padding: 20, paddingBottom: 48 },
  detailTitle: { fontSize: 24, fontWeight: '900', color: c.textPrimary, marginTop: 10, lineHeight: 30 },
  detailImg: { width: '100%', height: 220, borderRadius: radius.xl, borderWidth: 1, borderColor: c.border, marginTop: 16, backgroundColor: c.hover },
  detailImgFallback: { width: '100%', height: 200, borderRadius: radius.xl, borderWidth: 1, borderColor: c.border, marginTop: 16, backgroundColor: c.hover, alignItems: 'center', justifyContent: 'center', gap: 4 },
  detailExcerpt: { fontSize: 16, color: c.textSecondary, marginTop: 16, lineHeight: 23 },
  bodyPara: { fontSize: 15, color: c.textPrimary, marginTop: 14, lineHeight: 23 },
  tagsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 26, paddingTop: 16, borderTopWidth: 1, borderTopColor: c.borderSubtle },
  tag: { backgroundColor: c.hover, paddingHorizontal: 8, paddingVertical: 5, borderRadius: radius.sm },
  tagTxt: { fontSize: 12, color: c.textMuted },

  // Not-found state
  notFound: { alignItems: 'center', justifyContent: 'center', padding: 48, gap: 16 },
  notFoundTitle: { fontSize: 20, fontWeight: '800', color: c.textPrimary },
  notFoundBtn: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: radius.md, backgroundColor: c.primary500 },
  notFoundBtnTxt: { color: c.white, fontSize: 14, fontWeight: '700' },
});
