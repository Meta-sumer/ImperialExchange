/**
 * The Daily News pages' decisions — client/src/pages/News.jsx and
 * NewsArticle.jsx — kept out of the screens so they are testable.
 *
 * Pure: no React, no network. Pinned by __tests__/stage3_news.logic.
 */
import type { NewsQuery } from '@/api/cms.api';
import { NEWS_PAGE_SIZE, type NewsPage } from '@/types/cms';

/** News.jsx `load`: `{ page, limit: 12 }`, plus `q` and `category` only when set. */
export const newsQuery = (page: number, search: string, category: string): NewsQuery => {
  const q: NewsQuery = { page, limit: NEWS_PAGE_SIZE };
  if (search) q.q = search;
  if (category) q.category = category;
  return q;
};

/** The web's pagination state before the first answer: `{ page: 1, pages: 1, total: 0 }`. */
export const EMPTY_PAGINATION: Pick<NewsPage, 'page' | 'pages' | 'total'> = { page: 1, pages: 1, total: 0 };

/** The pager shows only when there is more than one page. */
export const showPager = (pages: number): boolean => pages > 1;

/** "Prev" / "Next" follow the page ASKED for, as the web's buttons do. */
export const canPrev = (page: number): boolean => page > 1;
export const canNext = (page: number, pages: number): boolean => page < pages;

/** "Page 2 / 5" — from the server's answer, as the web labels it. */
export const pageLabel = (p: Pick<NewsPage, 'page' | 'pages'>): string => `Page ${p.page} / ${p.pages}`;

/** The strings the web renders, verbatim. */
export const NEWS_COPY = {
  title: 'Daily News Updates',
  subtitle: 'Latest market news, analysis and announcements.',
  searchPlaceholder: 'Search news…',
  search: 'Search',
  all: 'All',
  empty: 'No news articles yet.',
  noImage: 'No image',
  prev: 'Prev',
  next: 'Next',
  back: '← Back to News',
  notFound: 'Article not found',
  allNews: 'All News',
  /** Not on the web, which shows "No news articles yet." for a failed load too. */
  loadFailed: 'Couldn’t load the news',
  articleFailed: 'Couldn’t load this article',
} as const;

/** "By Jane" — the card and the article both prefix the author. */
export const byline = (author: string | null | undefined): string | null => (author ? `By ${author}` : null);

/** `#tag` chips under the article. */
export const tagLabel = (tag: string): string => `#${tag}`;

/**
 * Why an article did not load. The web shows "Article not found" for any
 * failure, a dropped connection included; here only a 404 (or an answer
 * with no article in it) is "not found" — anything else offers a retry.
 */
export const articleFailure = (err: unknown): 'notfound' | 'error' => {
  const e = err as { response?: { status?: number }; message?: string } | null | undefined;
  if (e?.response?.status === 404) return 'notfound';
  if (e && !e.response && e.message === 'Article not found') return 'notfound';
  return 'error';
};

/** The web path of an article, for relative links inside its body. */
export const articlePath = (slug: string): string => `/news/${encodeURIComponent(slug)}`;
