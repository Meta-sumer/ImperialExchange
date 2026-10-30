import type { FooterConfig, FooterLink } from '@/types/cms';
import { apiErrorCode, fmtDateTime } from '@/utils/fundsFlows';

/**
 * The CMS family's pure logic — client/src/pages/CmsPageView.jsx and
 * client/src/components/CmsFooter.jsx, minus React.
 */

/* ── The page ─────────────────────────────────────────────────────────── */

/**
 * What a failed page read means. CmsPageView.jsx: AUTH_REQUIRED → "Members
 * only", anything else → "Page not found". Here only a real 404 (or the
 * adapter's own "no page") is "not found"; a dropped connection is an error
 * with a Retry.
 */
export const cmsPageFailure = (err: unknown): 'notfound' | 'auth' | 'error' => {
  if (apiErrorCode(err) === 'AUTH_REQUIRED') return 'auth';
  const e = err as { response?: { status?: number }; message?: string } | null | undefined;
  if (e?.response?.status === 401) return 'auth';
  if (e?.response?.status === 404) return 'notfound';
  if (e && !e.response && e.message === 'Page not found') return 'notfound';
  return 'error';
};

/** The web path of a page, for relative links inside its body. */
export const cmsPagePath = (slug: string): string => `/page/${encodeURIComponent(slug)}`;

/** `Updated <date>` — utils/format.js fmtDate: date and time, '-' when absent. */
export const fmtCmsDate = (iso: string | null | undefined): string => fmtDateTime(iso ?? null);

/* ── The footer ───────────────────────────────────────────────────────── */

export interface FooterItem {
  label: string;
  href: string;
  openInNewTab?: boolean;
  slug?: string;
}

export interface FooterColumn {
  name: string;
  items: FooterItem[];
}

/**
 * CmsFooter.jsx DEFAULT_COLUMNS — the out-of-the-box footer while no CMS page
 * has a footer column. '#' links do nothing, as on the web.
 */
export const DEFAULT_FOOTER_COLUMNS: readonly FooterColumn[] = [
  { name: 'Company', items: [
    { label: 'About Us', href: '#' }, { label: 'Daily News Updates', href: '/news' },
    { label: 'Contact Us', href: '#' }, { label: 'Meet Our Team', href: '#' },
  ] },
  { name: 'Products', items: [
    { label: 'Solutions', href: '#' }, { label: 'Plans & Pricing', href: '#' },
    { label: 'Services', href: '#' }, { label: 'Partners', href: '#' },
  ] },
  { name: 'Resources', items: [
    { label: 'Gallery', href: '#' }, { label: 'Blog Articles', href: '#' },
    { label: 'FAQ', href: '#' }, { label: 'Guidelines', href: '#' },
  ] },
  { name: 'Support', items: [
    { label: 'Knowledge Base', href: '#' }, { label: 'Contact Support', href: '#' },
    { label: 'Privacy Policy', href: '#' }, { label: 'Terms & Conditions', href: '#' },
  ] },
];

/**
 * CmsFooter.jsx `columns`: links grouped by their column in first-seen
 * order (a link with none goes under Company), with "Daily News Updates"
 * first in the first column; the defaults while there are no links.
 */
export const footerColumns = (links: readonly FooterLink[]): FooterColumn[] => {
  if (!links.length) return DEFAULT_FOOTER_COLUMNS.map((c) => ({ name: c.name, items: [...c.items] }));
  const groups = new Map<string, FooterItem[]>();
  for (const l of links) {
    const col = l.column || 'Company';
    const list = groups.get(col) ?? [];
    list.push({ label: l.label, href: l.href, openInNewTab: l.openInNewTab, slug: l.slug });
    groups.set(col, list);
  }
  const order = [...groups.keys()];
  const first = order[0] ?? 'Company';
  groups.get(first)?.unshift({ label: 'Daily News Updates', href: '/news' });
  return order.map((name) => ({ name, items: groups.get(name) ?? [] }));
};

/** What tapping a footer link does: nothing ('#'), the browser, or an app path. */
export type FooterTarget =
  | { kind: 'none' }
  | { kind: 'external'; url: string }
  | { kind: 'internal'; path: string };

export const footerTarget = (item: Pick<FooterItem, 'href' | 'openInNewTab'>): FooterTarget => {
  const href = String(item.href || '').trim();
  if (!href || href === '#') return { kind: 'none' };
  if (/^https?:/i.test(href)) return { kind: 'external', url: href };
  // "Open in new tab" on a site path has no second tab here — it opens in app.
  return { kind: 'internal', path: href.startsWith('/') ? href : `/${href}` };
};

/** The brand's name — the config's, else the product's. */
export const footerBrand = (config: Pick<FooterConfig, 'brand'> | null | undefined): string =>
  config?.brand || 'Imperial Exchange';

/** CmsFooter.jsx: the admin's copyright line, else `© <year> · <brand> · All rights reserved`. */
export const footerCopyright = (config: Pick<FooterConfig, 'brand' | 'copyright'> | null | undefined, year: number): string =>
  config?.copyright || `© ${year} · ${footerBrand(config)} · All rights reserved`;

/** The built-in networks, in the web's order. */
export const SOCIAL_NETWORKS = [
  'facebook', 'twitter', 'youtube', 'linkedin', 'instagram', 'whatsapp', 'telegram', 'skype',
] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

/** The networks the admin filled in (a '#' counts: it is shown, and does nothing). */
export const activeSocials = (socials: Readonly<Record<string, string>> | null | undefined): SocialNetwork[] =>
  SOCIAL_NETWORKS.filter((k) => !!socials?.[k] && String(socials[k]).trim() !== '');
