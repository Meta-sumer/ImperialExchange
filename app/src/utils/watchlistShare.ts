import Constants from 'expo-constants';

import { WEB_ORIGIN } from '@/constants/env';

/**
 * Watchlist import / export / share — client/src/utils/watchlistShare.js.
 *
 * Share is STATELESS, as on the web: a list is encoded into a compact code
 * the recipient imports as their OWN copy. No server record and no public
 * read endpoint, so one person's lists never leak to another — the code
 * carries name + emoji + colour + symbols and nothing else.
 *
 * The code is the web's byte for byte (base64 of the UTF-8 JSON
 * `{ v, n, e, c, s }`), so a code made here imports on the web and the
 * reverse. The web gets there with `btoa(unescape(encodeURIComponent(s)))`
 * and `decodeURIComponent(escape(atob(s)))`; Hermes does not promise
 * `escape` / `unescape`, so the codec below is written out — UTF-8 and the
 * WHATWG "forgiving-base64" decode that `atob` implements, with the same
 * failures (a malformed code throws, as it does on the web).
 *
 * Differences from the web, on purpose:
 *   • The share link carries the code URL-encoded. The web pastes it raw
 *     into `?share=`, so a `+` in the code arrives as a space and the link
 *     is refused as invalid. `decodeWatchlist` turns spaces back into `+`
 *     (base64 has no spaces), so links the web already handed out work too.
 *   • The link points at `/watchlist` on the web origin when one is
 *     configured (it opens the web page, or this app through its app links),
 *     else at the app's own scheme. The web builds it on whatever path the
 *     page was opened at — `/wishlist` and `/favorites` redirect and drop the
 *     query, so a link built there never imported anything.
 */

export const WATCHLIST_SHARE_VERSION = 1;

/** The fields a shared / exported / imported list carries. */
export interface SharedWatchlist {
  name: string;
  emoji: string;
  color: string;
  symbols: string[];
}

/** Anything list-shaped: the store's Watchlist, or a web `_id` list. */
export interface ShareableList {
  name: string;
  emoji?: string | null;
  color?: string | null;
  items?: readonly { symbol: string }[] | null;
}

/* ── UTF-8 ────────────────────────────────────────────────────────────── */

/**
 * UTF-8 bytes of a string. A lone surrogate throws a URIError, exactly as
 * the web's `encodeURIComponent` does.
 */
export const utf8Encode = (s: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN;
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new URIError('URI malformed');
      cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
      i += 1;
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      throw new URIError('URI malformed');
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return out;
};

/**
 * Strict UTF-8 decode — `decodeURIComponent(escape(binary))`: a truncated
 * sequence, a stray continuation byte, an overlong form, a surrogate or a
 * code point past U+10FFFF throws a URIError.
 */
export const utf8Decode = (bytes: readonly number[]): string => {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i] as number;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
      continue;
    }
    let need: number;
    let cp: number;
    let min: number;
    if ((b0 & 0xe0) === 0xc0) { need = 1; cp = b0 & 0x1f; min = 0x80; }
    else if ((b0 & 0xf0) === 0xe0) { need = 2; cp = b0 & 0x0f; min = 0x800; }
    else if ((b0 & 0xf8) === 0xf0) { need = 3; cp = b0 & 0x07; min = 0x10000; }
    else throw new URIError('URI malformed');
    // A truncated sequence reads `undefined` here and throws.
    for (let k = 1; k <= need; k++) {
      const b = bytes[i + k];
      if (b === undefined || (b & 0xc0) !== 0x80) throw new URIError('URI malformed');
      cp = (cp << 6) | (b & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new URIError('URI malformed');
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
};

/* ── Base64 ───────────────────────────────────────────────────────────── */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const INDEX: Record<string, number> = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));

/** Standard base64 with `=` padding — `btoa` over the bytes. */
export const base64FromBytes = (bytes: readonly number[]): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += ALPHABET[(n >> 18) & 63];
    out += ALPHABET[(n >> 12) & 63];
    out += b === undefined ? '=' : ALPHABET[(n >> 6) & 63];
    out += c === undefined ? '=' : ALPHABET[n & 63];
  }
  return out;
};

/**
 * `atob` — the WHATWG forgiving-base64 decode: ASCII whitespace is
 * ignored, up to two trailing `=` are dropped when the length is a
 * multiple of four, and anything else malformed throws.
 */
export const bytesFromBase64 = (input: string): number[] => {
  let data = input.replace(/[\t\n\f\r ]/g, '');
  if (data.length % 4 === 0) {
    if (data.endsWith('==')) data = data.slice(0, -2);
    else if (data.endsWith('=')) data = data.slice(0, -1);
  }
  if (data.length % 4 === 1) throw new Error('The string to be decoded is not correctly encoded.');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of data) {
    const v = INDEX[ch];
    if (v === undefined) throw new Error('The string to be decoded is not correctly encoded.');
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits === 24) {
      out.push((buffer >> 16) & 0xff, (buffer >> 8) & 0xff, buffer & 0xff);
      buffer = 0;
      bits = 0;
    }
  }
  if (bits === 12) out.push((buffer >> 4) & 0xff);
  else if (bits === 18) out.push((buffer >> 10) & 0xff, (buffer >> 2) & 0xff);
  return out;
};

/** The web's `b64encode`. */
export const b64encode = (s: string): string => base64FromBytes(utf8Encode(s));
/** The web's `b64decode`. */
export const b64decode = (s: string): string => utf8Decode(bytesFromBase64(s));

/* ── Normalise ────────────────────────────────────────────────────────── */

type Loose = Record<string, unknown>;

/**
 * watchlistShare.js `normalize`, with its failure modes: a `null` payload
 * or a `symbols` that is not an array throws a TypeError (the web's
 * `.map` on it does), which sends parseImport on to its next reading.
 */
export const normalizeShared = (objIn: unknown): SharedWatchlist => {
  if (objIn === null) throw new TypeError("Cannot read properties of null (reading 'name')");
  const obj = (objIn ?? {}) as Loose;
  const pick = (a: string, b: string): unknown => (obj[a] ?? obj[b]);
  const rawSymbols = pick('symbols', 's') ?? [];
  const name = String(pick('name', 'n') ?? 'Imported watchlist').slice(0, 40);
  const emoji = String(pick('emoji', 'e') ?? '');
  const color = String(pick('color', 'c') ?? '');
  if (!Array.isArray(rawSymbols)) throw new TypeError('symbols.map is not a function');
  const symbols = (rawSymbols as unknown[])
    .map((s) => String(s).trim().toUpperCase())
    .filter(Boolean);
  return { name, emoji, color, symbols };
};

/* ── Share code ───────────────────────────────────────────────────────── */

const symbolsOf = (wl: ShareableList): string[] => (wl.items ?? []).map((it) => it.symbol);

export const encodeWatchlist = (wl: ShareableList): string =>
  b64encode(JSON.stringify({
    v: WATCHLIST_SHARE_VERSION,
    n: wl.name,
    e: wl.emoji || '',
    c: wl.color || '',
    s: symbolsOf(wl),
  }));

/**
 * A code from a link. Spaces become `+` first: a web-made link carries the
 * code raw, and a query string decodes `+` to a space.
 */
export const decodeWatchlist = (code: string): SharedWatchlist =>
  normalizeShared(JSON.parse(b64decode(code.replace(/ /g, '+'))));

/**
 * Where a share link points: `<web origin>/watchlist` when the web origin is
 * configured (constants/env WEB_ORIGIN — the setting deep links use), else
 * the app's own scheme.
 */
export const watchlistShareBase = (): string => {
  if (WEB_ORIGIN) return `${WEB_ORIGIN}/watchlist`;
  const scheme = typeof Constants.expoConfig?.scheme === 'string' ? Constants.expoConfig.scheme : 'imperialexchange';
  return `${scheme}://watchlist`;
};

/** The full link — `<base>?share=<code>`, the code URL-encoded. */
export const buildShareLink = (wl: ShareableList, base: string = watchlistShareBase()): string =>
  `${base}?share=${encodeURIComponent(encodeWatchlist(wl))}`;

/* ── Export file ──────────────────────────────────────────────────────── */

/** The JSON the web's exportWatchlistFile downloads, pretty-printed the same. */
export const exportWatchlistJson = (wl: ShareableList): string =>
  JSON.stringify(
    {
      type: 'tradepro-watchlist',
      version: WATCHLIST_SHARE_VERSION,
      name: wl.name,
      emoji: wl.emoji || '',
      color: wl.color || '',
      symbols: symbolsOf(wl),
    },
    null,
    2,
  );

/** `<name>.watchlist.json`, with anything not a word character or `-` made `_`. */
export const exportWatchlistFileName = (wl: ShareableList): string =>
  `${(wl.name || 'watchlist').replace(/[^\w-]+/g, '_')}.watchlist.json`;

/* ── Import ───────────────────────────────────────────────────────────── */

/**
 * Pasted text or a picked file's contents, read the web's way and in its
 * order: JSON (an export file, a share payload, or an array of symbols),
 * then a bare share code, then a comma / space / semicolon / newline
 * separated symbol list. Throws "Nothing to import" / "Could not read any
 * symbols" as the web does.
 */
export const parseImport = (raw: unknown): SharedWatchlist => {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Nothing to import');

  try {
    const obj: unknown = JSON.parse(text);
    if (Array.isArray(obj)) return normalizeShared({ symbols: obj });
    return normalizeShared(obj);
  } catch { /* not JSON — fall through */ }

  try {
    return normalizeShared(JSON.parse(b64decode(text)));
  } catch { /* not a code — fall through */ }

  const symbols = text.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) throw new Error('Could not read any symbols');
  return normalizeShared({ symbols });
};
