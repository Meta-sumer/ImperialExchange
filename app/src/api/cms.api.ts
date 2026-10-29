import type { AxiosResponse } from 'axios';

import { api } from '@/api/client';
import { rows } from '@/types/api';
import {
  NEWS_PAGE_SIZE,
  toCmsPage,
  toEconomicCalendar,
  toFooter,
  toKbArticles,
  toNewsArticle,
  toNewsPage,
  type CmsPage,
  type EconomicCalendarConfig,
  type Footer,
  type KbArticle,
  type NewsArticle,
  type NewsPage,
} from '@/types/cms';

/**
 * Public content — `/api/cms/*` (routes/cms.js). None of these need a
 * session, but the shared client still attaches one when present, which is
 * what lets an AUTH-visibility page open for a signed-in reader.
 *
 * Failures are for the caller to classify: `cmsFailure(err)` turns a page
 * read's error into the "sign in" vs "not found" state CmsPageView shows.
 */

const payload = (res: AxiosResponse): unknown => {
  const b = res.data as unknown;
  if (b && typeof b === 'object' && 'success' in b && 'data' in b) return (b as { data: unknown }).data;
  return b;
};

export interface NewsQuery {
  page?: number;
  limit?: number;
  /** Matches title, excerpt and tags. */
  q?: string;
  category?: string;
}

export const cmsApi = {
  /** One published page. 404 NOT_FOUND, or 401 AUTH_REQUIRED for a signed-out reader of an AUTH page. */
  page: async (slug: string): Promise<CmsPage> => {
    const p = toCmsPage(payload(await api.get(`/cms/pages/${encodeURIComponent(slug.toLowerCase())}`)));
    if (!p) throw new Error('Page not found');
    return p;
  },

  /** Footer links (grouped by column on screen) and the brand/social config. */
  footer: async (lang = 'en'): Promise<Footer> =>
    toFooter(payload(await api.get('/cms/footer-links', { params: lang === 'en' ? {} : { lang } }))),

  /** Admin events + the show/hide switch. The web re-reads this every 5 minutes. */
  economicCalendar: async (): Promise<EconomicCalendarConfig> =>
    toEconomicCalendar(payload(await api.get('/cms/economic-calendar'))),

  /**
   * Admin help articles, appended to the built-in FAQ on the Helpdesk.
   * (EquityHub's server serves no /cms/service-times and no
   * /cms/app-download: its pages print those words themselves.)
   */
  knowledgeBase: async (): Promise<KbArticle[]> =>
    toKbArticles(payload(await api.get('/cms/knowledge-base'))),

  /** Published articles, newest first, without their bodies. */
  news: async (q: NewsQuery = {}): Promise<NewsPage> => {
    const params: Record<string, string | number> = { page: q.page ?? 1, limit: q.limit ?? NEWS_PAGE_SIZE };
    if (q.q) params.q = q.q;
    if (q.category) params.category = q.category;
    return toNewsPage(payload(await api.get('/cms/news', { params })));
  },

  newsCategories: async (): Promise<string[]> =>
    rows<unknown>(payload(await api.get('/cms/news/categories')))
      .filter((c): c is string => typeof c === 'string' && c.trim() !== ''),

  newsArticle: async (slug: string): Promise<NewsArticle> => {
    const a = toNewsArticle(payload(await api.get(`/cms/news/${encodeURIComponent(slug.toLowerCase())}`)));
    if (!a) throw new Error('Article not found');
    return a;
  },
};

/** How often the web refreshes the economic-calendar config. */
export const ECONOMIC_CONFIG_REFRESH_MS = 5 * 60_000;

export type CmsApi = typeof cmsApi;
