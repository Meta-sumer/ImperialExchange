/**
 * Admin-managed content — CMS pages, the footer, news, the knowledge base
 * and the economic calendar's admin events.
 *
 * Shapes: backend/src/controllers/cmsPageController.js and
 * cmsNewsController.js (the PUBLIC half — `/api/cms/*`, no login needed
 * except for pages marked AUTH). Behaviour: client/src/pages/CmsPageView.jsx,
 * News.jsx, NewsArticle.jsx, components/CmsFooter.jsx, EconomicCalendar.jsx
 * and pages/Helpdesk.jsx.
 *
 * Page and article bodies are admin-authored HTML, sanitised by the server
 * (utils/cms sanitizeHtml). The app renders them; it does not re-sanitise
 * or rewrite them.
 */
import { id, num, rows, str, strOrNull } from '@/types/api';

type Raw = Record<string, unknown>;

const obj = (v: unknown): Raw =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

const strings = (v: unknown): string[] =>
  (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);

/* ── Pages ────────────────────────────────────────────────────────────── */

export interface CmsPage {
  id: string;
  title: string;
  slug: string;
  /** Sanitised HTML. */
  content: string;
  /** AUTH pages answer 401 AUTH_REQUIRED to a signed-out reader. */
  visibility: 'PUBLIC' | 'AUTH';
  featuredImageUrl: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  metaKeywords: string[];
  publishedAt: string | null;
  updatedAt: string | null;
}

export const toCmsPage = (raw: unknown): CmsPage | null => {
  const r = obj(raw);
  if (!r.slug && !r.title) return null;
  return {
    id: id(r),
    title: str(r.title),
    slug: str(r.slug),
    content: str(r.content),
    visibility: str(r.visibility).toUpperCase() === 'AUTH' ? 'AUTH' : 'PUBLIC',
    featuredImageUrl: strOrNull(r.featuredImageUrl),
    seoTitle: strOrNull(r.seoTitle),
    seoDescription: strOrNull(r.seoDescription),
    metaKeywords: strings(r.metaKeywords),
    publishedAt: strOrNull(r.publishedAt),
    updatedAt: strOrNull(r.updatedAt),
  };
};

/** CmsPageView's states: a signed-out reader on an AUTH page is asked to sign in; everything else is "not found". */
export type CmsFailure = 'auth' | 'notfound';

export const cmsFailure = (err: unknown): CmsFailure => {
  const code = (err as { response?: { data?: { error?: { code?: string } } } } | undefined)
    ?.response?.data?.error?.code;
  return code === 'AUTH_REQUIRED' ? 'auth' : 'notfound';
};

/* ── Footer ───────────────────────────────────────────────────────────── */

export interface FooterLink {
  slug: string;
  label: string;
  /** The WEB path (`/page/<slug>`); in the app, open the CMS page screen by `slug`. */
  href: string;
  column: string;
  openInNewTab: boolean;
  /** Visible only to signed-in users. */
  authOnly: boolean;
}

export interface FooterSocialLink { label: string; url: string; icon: string }

export interface FooterConfig {
  brand: string | null;
  logoUrl: string | null;
  tagline: string | null;
  address: string | null;
  copyright: string | null;
  /** Network key (e.g. `twitter`) → URL. Blank entries are dropped. */
  socials: Record<string, string>;
  customSocials: FooterSocialLink[];
}

export interface Footer {
  links: FooterLink[];
  config: FooterConfig;
}

export const toFooter = (raw: unknown): Footer => {
  const r = obj(raw);
  const c = obj(r.config);
  const socials: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(c.socials))) {
    if (typeof v === 'string' && v.trim()) socials[k] = v.trim();
  }
  return {
    // An older server answered a bare array of links (CmsFooter.jsx back-compat).
    links: rows<unknown>(Array.isArray(raw) ? raw : r.links).map((x) => {
      const l = obj(x);
      const slug = str(l.slug);
      return {
        slug,
        label: str(l.label) || slug,
        href: str(l.href) || `/page/${slug}`,
        column: str(l.column) || 'Company',
        openInNewTab: l.openInNewTab === true,
        authOnly: l.authOnly === true,
      };
    }).filter((l) => l.slug),
    config: {
      brand: strOrNull(c.brand),
      logoUrl: strOrNull(c.logoUrl),
      tagline: strOrNull(c.tagline),
      address: strOrNull(c.address),
      copyright: strOrNull(c.copyright),
      socials,
      customSocials: rows<unknown>(c.customSocials)
        .map((x) => {
          const s = obj(x);
          return { label: str(s.label), url: str(s.url), icon: str(s.icon) };
        })
        .filter((s) => s.url),
    },
  };
};

/**
 * Links grouped into footer columns, columns in first-seen order (CmsFooter
 * groups the same way). Auth-only links are KEPT, as on the web: opening one
 * signed-out lands on the page's "sign in to view" state, which says why,
 * where a missing link would say nothing.
 */
export const footerColumns = (
  links: readonly FooterLink[],
): { column: string; links: FooterLink[] }[] => {
  const cols = new Map<string, FooterLink[]>();
  for (const l of links) {
    const list = cols.get(l.column) ?? [];
    list.push(l);
    cols.set(l.column, list);
  }
  return [...cols.entries()].map(([column, list]) => ({ column, links: list }));
};

/* ── News ─────────────────────────────────────────────────────────────── */

export interface NewsArticle {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  /** Sanitised HTML. Empty on list rows — the list omits it. */
  content: string;
  category: string;
  author: string | null;
  featuredImageUrl: string | null;
  tags: string[];
  publishDate: string | null;
  views: number;
}

export const toNewsArticle = (raw: unknown): NewsArticle | null => {
  const r = obj(raw);
  if (!r.slug && !r.title) return null;
  return {
    id: id(r),
    title: str(r.title),
    slug: str(r.slug),
    excerpt: str(r.excerpt),
    content: str(r.content),
    category: str(r.category) || 'General',
    author: strOrNull(r.author),
    featuredImageUrl: strOrNull(r.featuredImageUrl),
    tags: strings(r.tags),
    publishDate: strOrNull(r.publishDate),
    views: num(r.views) ?? 0,
  };
};

export interface NewsPage {
  items: NewsArticle[];
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export const toNewsPage = (raw: unknown): NewsPage => {
  const r = obj(raw);
  const items = rows<unknown>(r.items ?? raw).map(toNewsArticle).filter((a): a is NewsArticle => a !== null);
  const p = obj(r.pagination);
  return {
    items,
    page: num(p.page) ?? 1,
    limit: num(p.limit) ?? items.length,
    total: num(p.total) ?? items.length,
    pages: Math.max(1, num(p.pages) ?? 1),
  };
};

/** The News screen's page size. */
export const NEWS_PAGE_SIZE = 12;

/* ── Knowledge base ───────────────────────────────────────────────────── */

export interface KbArticle {
  id: string;
  tag: string;
  /** Question. */
  q: string;
  /** Answer. */
  a: string;
  link: string | null;
  /** YouTube / Vimeo / mp4. */
  videoUrl: string | null;
}

export const toKbArticles = (raw: unknown): KbArticle[] =>
  rows<unknown>(raw, 'articles').map((x) => {
    const r = obj(x);
    return {
      id: str(r.id) || id(r),
      tag: str(r.tag) || 'General',
      q: str(r.q),
      a: str(r.a),
      link: strOrNull(r.link),
      videoUrl: strOrNull(r.videoUrl),
    };
  }).filter((k) => k.q && k.a);

/** The Helpdesk's panes, in order; 'faq' is where it opens. */
export const HELPDESK_TABS = ['chat', 'faq', 'tickets', 'new'] as const;
export type HelpdeskTab = (typeof HELPDESK_TABS)[number];

/** A deep link's `tab`, validated — anything unknown opens the FAQ. */
export const helpdeskTabOf = (v: string | null | undefined): HelpdeskTab =>
  ((HELPDESK_TABS as readonly string[]).includes(String(v)) ? (v as HelpdeskTab) : 'faq');

/**
 * Helpdesk search over question, answer and tag. The admin's articles are
 * APPENDED to the built-in set (Helpdesk.jsx allKb), so the caller passes
 * both.
 */
export const searchKb = <T extends { q?: string; a?: string; tag?: string }>(
  articles: readonly T[],
  query: string,
): T[] => {
  const q = query.trim().toLowerCase();
  if (!q) return [...articles];
  return articles.filter((a) =>
    (a.q ?? '').toLowerCase().includes(q)
    || (a.a ?? '').toLowerCase().includes(q)
    || (a.tag ?? '').toLowerCase().includes(q));
};

/* ── Economic calendar (admin events) ─────────────────────────────────── */

export type EconomicImpact = 'high' | 'medium' | 'low';

export interface EconomicEvent {
  id: string;
  /** ISO. */
  date: string;
  country: string;
  currency: string;
  impact: EconomicImpact;
  event: string;
  /** The figures as numbers, or null when blank or not a number. */
  previous: number | null;
  consensus: number | null;
  forecast: number | null;
  actual: number | null;
  /**
   * The figures as the admin typed them. EquityHub's server keeps them as
   * TEXT ("175K", "3.2%", ">200") — `Number()` of those is NaN, so format
   * the label from these (fmtEconomicValue takes either).
   */
  previousText?: string | null;
  consensusText?: string | null;
  forecastText?: string | null;
  actualText?: string | null;
  unit: string;
}

export interface EconomicCalendarConfig {
  /** false hides the whole calendar, built-in schedule included. */
  enabled: boolean;
  /** Admin events — MERGED with the client's generated schedule, not a replacement. */
  events: EconomicEvent[];
}

export const toEconomicCalendar = (raw: unknown): EconomicCalendarConfig => {
  const r = obj(raw);
  return {
    enabled: r.enabled !== false,
    events: rows<unknown>(r.events).map((x) => {
      const e = obj(x);
      const impact = str(e.impact).toLowerCase();
      return {
        id: str(e.id) || id(e),
        date: str(e.date),
        country: str(e.country).toUpperCase(),
        currency: str(e.currency).toUpperCase(),
        impact: (impact === 'high' || impact === 'low' ? impact : 'medium') as EconomicImpact,
        event: str(e.event),
        previous: num(e.previous),
        consensus: num(e.consensus),
        forecast: num(e.forecast),
        actual: num(e.actual),
        previousText: figureText(e.previous),
        consensusText: figureText(e.consensus),
        forecastText: figureText(e.forecast),
        actualText: figureText(e.actual),
        unit: str(e.unit),
      };
    }).filter((e) => e.date && e.event),
  };
};

/** An admin figure as text — a number or a string as sent; null when blank. */
const figureText = (v: unknown): string | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'string') return v.trim() ? v.trim() : null;
  return null;
};

/** `toLocaleString('en-US')` — Western grouping, up to three decimals as typed. */
const groupWestern = (n: number): string => {
  const decimals = Math.min(3, (String(n).split('.')[1] ?? '').length);
  const [int = '0', frac] = Math.abs(n).toFixed(decimals).split('.');
  const body = `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`;
  return n < 0 ? `-${body}` : body;
};

/**
 * utils/economicCalendar.js _fmtAdmin — an admin-entered figure with its
 * unit, or null when blank. A number is grouped from 1,000 up (en-US: these
 * are statistics, not money) and shown as entered below that; text the
 * admin typed ("175K", "3.2%") is shown verbatim.
 */
export const fmtEconomicValue = (v: number | string | null | undefined, unit: string): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  const s = Number.isFinite(n) ? (Math.abs(n) >= 1000 ? groupWestern(n) : String(n)) : String(v);
  return unit ? `${s}${unit}` : s;
};
