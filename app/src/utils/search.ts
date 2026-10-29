/**
 * The search sheet's decisions — client/src/components/SearchModal.jsx, the
 * parts that are not already in api/instruments (filterCatalog,
 * catalogCounts, inSearchCategory, SEARCH_CATEGORIES, isOptionLikeQuery,
 * searchOptionContracts live there and are reused, not copied).
 *
 * Pure: no React, no network. Pinned against the web source by
 * __tests__/stage3_chrome.logic.
 */
import { SEARCH_CATEGORIES } from '@/api/instruments.api';
import type { Instrument } from '@/types/trading';

export interface SearchTab {
  key: string;
  label: string;
}

export const RECOMMENDED_TAB: SearchTab = { key: 'RECOMMENDED', label: 'Recommended' };

/**
 * The pill rail, in the web's order. "Recommended" sits right after "All",
 * and only when the admin's list resolves to catalogue rows; every other tab
 * is hidden while it has nothing in it — except "All", which always shows.
 */
export const searchTabs = (counts: Readonly<Record<string, number>>): SearchTab[] => {
  const all = SEARCH_CATEGORIES.map((c) => ({ key: c.key, label: c.label }));
  const ordered = (counts.RECOMMENDED ?? 0) > 0
    ? [all[0] as SearchTab, RECOMMENDED_TAB, ...all.slice(1)]
    : all;
  return ordered.filter((c) => c.key === 'ALL' || !!counts[c.key]);
};

/**
 * The tab the sheet shows. `chosen` is the trader's pick since the sheet
 * opened, null until they tap one.
 *
 * The web decides the default once, as the sheet opens, from the RAW
 * recommended list (`recommended.length ? 'RECOMMENDED' : 'ALL'`) — so an
 * admin list whose symbols are not in the catalogue selects a tab that is
 * hidden (count 0) and shows an empty list reading `No matches for "".`
 * Here the default follows the RESOLVED count, so it lands on "All" in that
 * case, and moves to "Recommended" once the catalogue arrives on a first
 * open (documented divergence).
 */
export const resolveSearchCategory = (
  chosen: string | null,
  counts: Readonly<Record<string, number>>,
): string => chosen ?? ((counts.RECOMMENDED ?? 0) > 0 ? 'RECOMMENDED' : 'ALL');

/** The row's second line after the symbol — "Future", "Option", "Stock", "Index", "Commodity". */
export const formatSearchCategory = (r: Pick<Instrument, 'category' | 'segment'>): string => {
  const s = String(r.segment ?? '').toUpperCase();
  if (s === 'FUT') return 'Future';
  if (s === 'OPT') return 'Option';
  const c = String(r.category ?? '').toUpperCase();
  const names: Record<string, string> = { COMMODITY: 'Commodity', INDEX: 'Index', STOCK: 'Stock' };
  return names[c] ?? c;
};

/** `SYMBOL · Category`, or the bare symbol when the row has no category. */
export const searchRowSubtitle = (r: Pick<Instrument, 'symbol' | 'category' | 'segment'>): string =>
  `${r.symbol}${r.category ? ` · ${formatSearchCategory(r)}` : ''}`;

/** The row's first line. */
export const searchRowTitle = (r: Pick<Instrument, 'symbol' | 'name'>): string => r.name || r.symbol;

/**
 * What the list shows. With no query, the filtered tab as it is; with one,
 * the catalogue matches followed by the server-found option contracts that
 * are not already among them.
 */
export const searchResults = (
  visible: readonly Instrument[],
  optionResults: readonly Instrument[],
  query: string,
): Instrument[] => {
  if (!query.trim()) return [...visible];
  const have = new Set(visible.map((v) => v.symbol));
  return [...visible, ...optionResults.filter((o) => !have.has(o.symbol))];
};

/** The heading over the list — "Recommended (12)", "All markets (240)", "Results (3)". */
export const searchHeading = (
  category: string,
  query: string,
  visibleCount: number,
  listCount: number,
): string => (!query.trim()
  ? `${category === 'RECOMMENDED' ? 'Recommended' : 'All markets'} (${visibleCount})`
  : `Results (${listCount})`);

/** The empty line, with the query as typed. */
export const searchNoMatches = (query: string): string => `No matches for "${query}".`;

/** The A–Z toggle's title, as the web words it. */
export const sortToggleTitle = (alpha: boolean): string =>
  (alpha ? 'Showing A–Z — click for the recommended order' : 'Sort A–Z');

/** How long a typed query waits before the option-contract search goes out. */
export const OPTION_SEARCH_DEBOUNCE_MS = 250;
