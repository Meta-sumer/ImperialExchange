import type { Instrument } from '@/types/trading';
import type { Watchlist } from '@/types/market';
import { EMPTY, fmtNum } from '@/utils/money';
import { parseImport, type SharedWatchlist } from '@/utils/watchlistShare';

/**
 * The watchlist family's pure logic — client/src/pages/Watchlist.jsx,
 * components/AddToWatchlistModal.jsx and WatchlistButton.jsx, minus React.
 * Shared by the Watchlist screen and the app-wide "Add to Watchlist" sheet.
 * Every string is the web's; every rule that decides a number, a label or a
 * list is here so a test can hold it against the web's own source.
 */

/* ── Choices ──────────────────────────────────────────────────────────── */

/** Watchlist.jsx EMOJI_CHOICES — the create / rename icon grid. */
export const EMOJI_CHOICES = ['⭐', '📈', '🔥', '💎', '🚀', '📊', '⚡', '🌙', '🐂', '🐻'] as const;

/** Watchlist.jsx COLOR_CHOICES — '' is "none"; the hex doubles as the dot colour. */
export const COLOR_CHOICES = ['', '#3B82F6', '#22C55E', '#EF4444', '#F59E0B', '#A855F7', '#EC4899', '#14B8A6'] as const;

/** AddToWatchlistModal.jsx NEW_LIST_EMOJIS — the inline "New watchlist" row. */
export const NEW_LIST_EMOJIS = ['⭐', '📈', '🔥', '💎', '🚀', '📊', '⚡', '🌙'] as const;

/** The list glyph when a list has no emoji. */
export const LIST_FALLBACK_EMOJI = '📋';

/** Max list name length — the input's maxLength and the server's 400. */
export const LIST_NAME_MAX = 40;

/* ── Numbers ──────────────────────────────────────────────────────────── */

/**
 * Watchlist.jsx `fmtPrice`: the instrument's own precision, 2 when it has
 * none (or 0 — the web's `Number(prec) || 2`), never more than 6.
 *
 * Grouping follows the instrument's quote currency (PORT-RULINGS §5); the
 * web groups every price the Indian way. An absent price is "—": the web's
 * `Number(null)` turns a missing price into "0.00".
 */
export const fmtWatchPrice = (
  raw: string | number | null | undefined,
  precision: number | null | undefined,
  quoteCurrency?: string | null,
): string => {
  if (raw === null || raw === undefined || raw === '') return EMPTY;
  const v = Number(raw);
  if (!Number.isFinite(v)) return EMPTY;
  return fmtNum(v, Math.min(Number(precision) || 2, 6), quoteCurrency || 'INR');
};

/** The 24h change as a finite number, or null — never a made-up zero. */
export const changeOf = (row: Pick<Instrument, 'change24h'> | null | undefined): number | null => {
  const c = row?.change24h;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
};

/** `+1.23%` / `-0.45%` / `—` — `+` on zero too, as the web's `change >= 0`. */
export const fmtChange = (change: number | null): string => {
  if (change === null || !Number.isFinite(change)) return EMPTY;
  return `${change >= 0 ? '+' : '-'}${fmtNum(Math.abs(change), 2)}%`;
};

/* ── Sparkline ────────────────────────────────────────────────────────── */

/** The web's hard-coded tones: gray-400 / green-600 / red-600. */
export const SPARK_TONES = { flat: '#9CA3AF', up: '#16A34A', down: '#DC2626' } as const;

export interface Spark { d: string; tone: string; W: number; H: number }

/**
 * Watchlist.jsx `sparkPath` — a decorative 9-point zig-zag sloping with the
 * sign of the 24h change (there is no intraday series behind it on the web
 * either). Grey and rising when the change is unknown.
 */
export const sparkPath = (change24h: number | null | undefined): Spark => {
  const W = 84;
  const H = 30;
  const mid = H / 2;
  const c = typeof change24h === 'number' ? change24h : NaN;
  const positive = !Number.isFinite(c) || c >= 0;
  const tone = !Number.isFinite(c) ? SPARK_TONES.flat : positive ? SPARK_TONES.up : SPARK_TONES.down;
  const start = mid + (positive ? 6 : -6);
  const end = mid + (positive ? -6 : 6);
  const points: [string, string][] = [];
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const x = t * W;
    const noise = (i % 2 === 0 ? 1 : -1) * (5 - i * 0.35);
    const y = start + (end - start) * t + noise * 0.6;
    points.push([x.toFixed(1), y.toFixed(1)]);
  }
  const d = points.map(([x, y], i) => (i === 0 ? `M${x} ${y}` : `L${x} ${y}`)).join(' ');
  return { d, tone, W, H };
};

/** The change tone for the price column — the sparkline's colours. */
export const changeTone = (change: number | null): string =>
  (change === null ? SPARK_TONES.flat : change >= 0 ? SPARK_TONES.up : SPARK_TONES.down);

/* ── Arrays ───────────────────────────────────────────────────────────── */

/** Watchlist.jsx `moveInArray`. */
export const moveInArray = <T>(arr: readonly T[], from: number, to: number): T[] => {
  const c = [...arr];
  const [x] = c.splice(from, 1);
  c.splice(to, 0, x as T);
  return c;
};

/** One step up (-1) or down (+1) — the drag list's accessible fallback. */
export const nudgeOrder = (ids: readonly string[], id: string, dir: -1 | 1): string[] | null => {
  const from = ids.indexOf(id);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  return moveInArray(ids, from, to);
};

/* ── Rows and live prices ─────────────────────────────────────────────── */

/**
 * Watchlist.jsx `rowFor`: the catalogue row, else the one fetched on demand
 * (options are not in the catalogue), with the latest tick's price laid on.
 * A tick of 0 is ignored, as the web's truthiness check does.
 */
export const rowForSymbol = (
  sym: string,
  bySymbol: ReadonlyMap<string, Instrument>,
  extra: Readonly<Record<string, Instrument>>,
  prices: Readonly<Record<string, number>>,
): Instrument | null => {
  const base = bySymbol.get(sym) ?? extra[sym];
  if (!base) return null;
  const px = prices[sym];
  return px ? { ...base, lastPrice: String(px) } : base;
};

/**
 * Symbols of the open list that neither the catalogue nor an earlier fetch
 * has — fetched one by one from /instruments/:symbol, once per screen.
 */
export const missingSymbols = (
  symbols: readonly string[],
  bySymbol: ReadonlyMap<string, Instrument>,
  fetched: ReadonlySet<string>,
): string[] => symbols.filter((s) => !bySymbol.has(s) && !fetched.has(s));

/** Fold a batch of ticks into the price map; the same object when nothing moved. */
export const applyTicks = (
  prices: Readonly<Record<string, number>>,
  ticks: Readonly<Record<string, number>>,
): Record<string, number> => {
  let next: Record<string, number> | null = null;
  for (const [sym, px] of Object.entries(ticks)) {
    if (prices[sym] === px) continue;
    if (!next) next = { ...prices };
    next[sym] = px;
  }
  return next ?? (prices as Record<string, number>);
};

/* ── Add symbols ──────────────────────────────────────────────────────── */

/**
 * The server search runs only for an option-like query (a strike number or
 * CE/PE) — Watchlist.jsx's own test, same as instruments.api's.
 */
export const isOptionLike = (q: string): boolean => {
  const term = q.trim();
  return !!term && (/\d{3,}/.test(term) || /(^|[^a-z])(ce|pe)([^a-z]|$)/i.test(term));
};

/**
 * AddSymbolsModal's results: catalogue rows not already in the list that
 * match the query on symbol or name, first 60; then the option contracts
 * the server found that are neither; 80 at most.
 */
export const addSymbolResults = (
  instruments: readonly Instrument[],
  existingSymbols: readonly string[],
  q: string,
  optResults: readonly Instrument[],
): Instrument[] => {
  const term = q.trim().toLowerCase();
  const existing = new Set(existingSymbols);
  let rows = instruments.filter((r) => !existing.has(r.symbol));
  if (term) rows = rows.filter((r) => r.symbol.toLowerCase().includes(term) || (r.name || '').toLowerCase().includes(term));
  rows = rows.slice(0, 60);
  const opts = optResults.filter((o) => !existing.has(o.symbol) && !rows.some((r) => r.symbol === o.symbol));
  return [...rows, ...opts].slice(0, 80);
};

/**
 * The second line under a result: the server's name, else BASE/QUOTE.
 * (The adapter fills a missing name with the symbol, so the raw row decides.)
 */
export const resultSubtitle = (r: Instrument): string => {
  const raw = r.raw as Record<string, unknown> | undefined;
  const name = raw && typeof raw.name === 'string' ? raw.name : r.name;
  return name || `${String(r.baseCurrency)}/${String(r.quoteCurrency)}`;
};

/** `Add 3 symbols` / `Add 1 symbol` / `Add  symbols` — the web's template, verbatim. */
export const addButtonLabel = (n: number): string => `Add ${n || ''} symbol${n === 1 ? '' : 's'}`;

/* ── Toasts and copy ──────────────────────────────────────────────────── */

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export const createdToast = (emoji: string, name: string): string => `Created ${emoji} ${name}`;
export const bulkAddedToast = (n: number): string => `Added ${plural(n, 'symbol')}`;
export const importedToast = (n: number, name: string): string => `Imported ${plural(n, 'symbol')} into ${name}`;
export const transferToast = (mode: TransferMode): string => (mode === 'move' ? 'Symbol moved' : 'Symbol copied');
export const transferTitle = (mode: TransferMode | null | undefined): string =>
  (mode === 'move' ? 'Move to watchlist' : 'Copy to watchlist');

export type TransferMode = 'move' | 'copy';

/** ConfirmDeleteModal: "… and its 3 symbols? This can't be undone." */
export const deleteSymbolCount = (list: Pick<Watchlist, 'items'> | null | undefined): string => {
  const n = list?.items?.length || 0;
  return plural(n, 'symbol');
};

/** ListActionsSheet's title — `📋 Name` when the list has no emoji. */
export const listTitle = (list: Pick<Watchlist, 'emoji' | 'name'> | null | undefined): string =>
  (list ? `${list.emoji || LIST_FALLBACK_EMOJI} ${list.name}` : '');

/** ListPickerModal: every list but the one open. */
export const pickerLists = (lists: readonly Watchlist[], excludeId: string | null | undefined): Watchlist[] =>
  lists.filter((l) => l.id !== excludeId);

/** The web's pill `title` — the hint a screen reader reads. */
export const pillHint = (active: boolean): string => (active ? 'Tap for list actions' : 'Open list');

/* ── The list form ────────────────────────────────────────────────────── */

export interface ListFormValues { name: string; emoji: string; color: string }

/** ListFormModal's reset on open: the list's values, or ⭐ / no colour. */
export const listFormInitial = (initial: Pick<Watchlist, 'name' | 'emoji' | 'color'> | null | undefined): ListFormValues => ({
  name: initial?.name || '',
  emoji: initial?.emoji || '⭐',
  color: initial?.color || '',
});

/** The submit button's text. */
export const listFormSubmitLabel = (busy: boolean, isRename: boolean): string =>
  (busy ? 'Saving…' : isRename ? 'Save' : 'Create');

/* ── Import ───────────────────────────────────────────────────────────── */

export interface ImportPreview extends SharedWatchlist {
  /** The symbols the catalogue knows — the only ones imported. */
  known: string[];
  /** How many were dropped as unknown. */
  skipped: number;
}

/** Split a parsed payload into what imports and what is skipped. */
export const importPreview = (p: SharedWatchlist, valid: ReadonlySet<string>): ImportPreview => {
  const known = p.symbols.filter((s) => valid.has(s));
  return { ...p, known, skipped: p.symbols.length - known.length };
};

/**
 * ImportModal's `apply` for pasted / uploaded text: nothing typed → no
 * preview and no error; otherwise the parse, or its error message.
 */
export const readImportText = (raw: string): { parsed: SharedWatchlist | null; error: string } => {
  if (!raw) return { parsed: null, error: '' };
  try {
    return { parsed: parseImport(raw), error: '' };
  } catch (e) {
    return { parsed: null, error: (e instanceof Error && e.message) || 'Could not parse import' };
  }
};

/* ── Add to Watchlist (the ★ sheet) ───────────────────────────────────── */

/** The lists that hold `symbol` — the sheet's starting ticks. */
export const membershipOf = (lists: readonly Watchlist[], symbol: string): Set<string> => {
  const s = new Set<string>();
  for (const w of lists) if (w.items.some((it) => it.symbol === symbol)) s.add(w.id);
  return s;
};

/** A tick box's state: the trader's toggle when there is one, else membership. */
export const isChecked = (
  listId: string,
  initial: ReadonlySet<string>,
  toggles: ReadonlyMap<string, boolean>,
): boolean => toggles.get(listId) ?? initial.has(listId);

export interface MembershipOp {
  kind: 'add' | 'remove';
  listId: string;
  /** For a removal: the item to delete. */
  itemId?: string;
}

/**
 * AddToWatchlistModal `save`: the minimal adds / removes that take the
 * lists from their membership to the ticked set, in list order.
 */
export const membershipOps = (
  lists: readonly Watchlist[],
  symbol: string,
  initial: ReadonlySet<string>,
  toggles: ReadonlyMap<string, boolean>,
): MembershipOp[] => {
  const ops: MembershipOp[] = [];
  for (const w of lists) {
    const was = initial.has(w.id);
    const now = isChecked(w.id, initial, toggles);
    if (now && !was) ops.push({ kind: 'add', listId: w.id });
    else if (!now && was) {
      const item = w.items.find((it) => it.symbol === symbol);
      if (item) ops.push({ kind: 'remove', listId: w.id, itemId: item.id });
    }
  }
  return ops;
};

export const saveToast = (opsCount: number, symbol: string): string =>
  (opsCount ? `Updated watchlists for ${symbol}` : 'No changes');

/** WatchlistButton's accessible name and hint — the web's aria-label / title. */
export const bookmarkLabel = (saved: boolean, symbol: string): string =>
  (saved ? `Edit watchlists for ${symbol}` : `Add ${symbol} to watchlist`);
export const bookmarkHint = (saved: boolean): string =>
  (saved ? 'In your watchlist — edit' : 'Add to Watchlist');
