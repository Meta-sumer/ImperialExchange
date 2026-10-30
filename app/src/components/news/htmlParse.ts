/**
 * Admin-authored article HTML → a small, safe node tree the native renderer
 * (HtmlContent) draws with Views and Text.
 *
 * The web renders `a.content` raw (`dangerouslySetInnerHTML`, NewsArticle.jsx)
 * after the server's regex sanitiser (backend/src/utils/cms.js). The app has
 * no DOM and does not use a WebView for this: it parses the HTML itself and
 * renders an ALLOW-LIST of elements — the ones `.cms-content` styles
 * (index.css:357-372) and the admin's RichTextEditor produces — so nothing it
 * does not know is ever executed or styled. That is the sanitising: scripts,
 * styles, frames and embeds are dropped with their content, inline `style` /
 * `on*` attributes are never read, and a link or image source is only used
 * when `classifyLink` / `resolveMediaUrl` accept it.
 *
 * Pure: no React, no network. Pinned by __tests__/stage3_news.logic.
 */

export interface HtmlText {
  type: 'text';
  text: string;
}

export interface HtmlElement {
  type: 'element';
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}

export type HtmlNode = HtmlText | HtmlElement;

/** Elements with no content and no end tag. */
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Dropped together with everything inside them. The server strips script,
 * style, iframe, object and embed; the rest can carry nothing a reader
 * should see as text.
 */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math',
  'head', 'title', 'select', 'textarea', 'button', 'canvas', 'video', 'audio', 'frame', 'frameset',
]);

/** Elements laid out as blocks. Everything else is inline text. */
export const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'ul', 'caption', 'img', 'body', 'html',
]);

/** Starting one of these closes an open <p> (the HTML parser's rule). */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'div', 'dl', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'ul',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
  plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾', larr: '←', rarr: '→',
  uarr: '↑', darr: '↓', hearts: '♥', check: '✓', shy: '',
  zwj: '‍', zwnj: '‌', ensp: ' ', emsp: ' ', thinsp: ' ',
};

/** `&amp;`, `&#8377;`, `&#x20B9;` and the common named entities. Unknown ones stay as written. */
export const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });

const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const parseAttrs = (src: string): Record<string, string> => {
  const out: Record<string, string> = {};
  ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = ATTR.exec(src))) {
    const name = (m[1] ?? '').toLowerCase();
    if (!name || name in out) continue;
    out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
};

const element = (tag: string, attrs: Record<string, string> = {}): HtmlElement =>
  ({ type: 'element', tag, attrs, children: [] });

/**
 * Parse HTML into a tree. Tolerant, as a browser is: stray end tags are
 * ignored, unclosed elements close at the end, and the implied closes that
 * matter for editor output (`<p>` before a block, `<li>` before `<li>`,
 * table cells and rows) are applied.
 */
export const parseHtml = (html: string | null | undefined): HtmlNode[] => {
  const src = String(html ?? '');
  const root = element('#root');
  const stack: HtmlElement[] = [root];
  const top = (): HtmlElement => stack[stack.length - 1] as HtmlElement;

  const pushText = (text: string) => {
    if (!text) return;
    const parent = top();
    const last = parent.children[parent.children.length - 1];
    if (last && last.type === 'text') last.text += text;
    else parent.children.push({ type: 'text', text });
  };

  /** Close back to (and including) the nearest open `tag`, stopping at any of `fence`. */
  const closeTo = (tags: ReadonlySet<string>, fence: ReadonlySet<string> = new Set()): boolean => {
    for (let i = stack.length - 1; i > 0; i--) {
      const tag = (stack[i] as HtmlElement).tag;
      if (fence.has(tag)) return false;
      if (tags.has(tag)) { stack.length = i; return true; }
    }
    return false;
  };

  const LIST_FENCE = new Set(['ul', 'ol', 'table']);
  const CELL_FENCE = new Set(['tr', 'table']);
  const ROW_FENCE = new Set(['table']);

  const open = (tag: string, attrs: Record<string, string>) => {
    if (CLOSES_P.has(tag)) closeTo(new Set(['p']), new Set(['blockquote', 'li', 'td', 'th', 'div', 'table']));
    if (tag === 'li') closeTo(new Set(['li']), LIST_FENCE);
    if (tag === 'dt' || tag === 'dd') closeTo(new Set(['dt', 'dd']), new Set(['dl']));
    if (tag === 'td' || tag === 'th') closeTo(new Set(['td', 'th']), CELL_FENCE);
    if (tag === 'tr') closeTo(new Set(['tr']), ROW_FENCE);
    const el = element(tag, attrs);
    top().children.push(el);
    if (!VOID.has(tag)) stack.push(el);
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { pushText(decodeEntities(src.slice(i))); break; }
    if (lt > i) pushText(decodeEntities(src.slice(i, lt)));
    i = lt;

    // Comments, doctypes, CDATA and processing instructions: skipped.
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src[i + 1] === '!' || src[i + 1] === '?') {
      const end = src.indexOf('>', i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }

    const tagMatch = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/.exec(src.slice(i));
    if (!tagMatch) {
      // A bare '<' that starts no tag is text, as a browser shows it.
      pushText('<');
      i += 1;
      continue;
    }
    i += tagMatch[0].length;
    const closing = tagMatch[1] === '/';
    const tag = (tagMatch[2] ?? '').toLowerCase();
    const rest = tagMatch[3] ?? '';

    if (closing) {
      if (tag === 'br') { open('br', {}); continue; } // `</br>` is a <br> in browsers
      closeTo(new Set([tag]));
      continue;
    }

    if (DROP_WITH_CONTENT.has(tag)) {
      if (VOID.has(tag) || /\/\s*$/.test(rest)) continue;
      // Skip to the matching end tag (no nesting for these in practice).
      const endRe = new RegExp(`<\\s*/\\s*${tag}\\s*>`, 'i');
      const m = endRe.exec(src.slice(i));
      i = m ? i + m.index + m[0].length : n;
      continue;
    }

    open(tag, parseAttrs(rest.replace(/\/\s*$/, '')));
    if (/\/\s*$/.test(rest) && !VOID.has(tag)) stack.pop(); // `<p/>` etc.
  }

  return root.children;
};

/* ── Text ─────────────────────────────────────────────────────────────── */

/** HTML's whitespace collapsing for normal (non-<pre>) text. */
export const collapseWhitespace = (s: string): string => s.replace(/[\t\n\f\r ]+/g, ' ');

/** All the text under a node, as a reader would see it (no markup). */
export const textContent = (nodes: readonly HtmlNode[]): string =>
  nodes.map((node) => (node.type === 'text' ? node.text : node.tag === 'br' ? '\n' : textContent(node.children))).join('');

export const isBlock = (node: HtmlNode): boolean => node.type === 'element' && BLOCK_TAGS.has(node.tag);

/** Does any descendant lay out as a block (an image in a link, a <p> in a <span>)? */
export const hasBlockDescendant = (node: HtmlNode): boolean =>
  node.type === 'element' && node.children.some((c) => isBlock(c) || hasBlockDescendant(c));

/* ── Links and media ──────────────────────────────────────────────────── */

export type LinkTarget =
  /** An app destination, as a WEB path — hand to navigateToPath. */
  | { kind: 'internal'; path: string }
  /** Somewhere else — open outside the app. */
  | { kind: 'external'; url: string }
  /** Not followed (javascript:, data:, a bare fragment, garbage). */
  | { kind: 'ignore' };

const SAFE_EXTERNAL = /^(https?:\/\/|mailto:|tel:)/i;

/**
 * Where a link in an article goes. A path, or a URL on the web app's own
 * origin (or the app scheme), is an app destination; http(s), mailto and tel
 * leave the app; anything else is not followed — the allow-list is the
 * sanitiser, whatever the server let through.
 *
 * A relative path ("other-article") resolves against `basePath` as the
 * browser would from the page it sits on.
 */
export const classifyLink = (
  hrefIn: string | null | undefined,
  opts: { webOrigin?: string | null; appScheme?: string; basePath?: string } = {},
): LinkTarget => {
  const href = String(hrefIn ?? '').trim();
  if (!href || href.startsWith('#')) return { kind: 'ignore' };
  const scheme = (opts.appScheme ?? 'imperialexchange').toLowerCase();
  if (href.toLowerCase().startsWith(`${scheme}://`)) return { kind: 'internal', path: href };
  if (href.startsWith('//')) return classifyLink(`https:${href}`, opts);
  if (href.startsWith('/')) return { kind: 'internal', path: href };
  const origin = (opts.webOrigin ?? '').replace(/\/+$/, '').toLowerCase();
  if (/^https?:\/\//i.test(href)) {
    const lower = href.toLowerCase();
    if (origin && (lower === origin || lower.startsWith(`${origin}/`) || lower.startsWith(`${origin}?`) || lower.startsWith(`${origin}#`))) {
      return { kind: 'internal', path: href.slice(origin.length) || '/' };
    }
    return { kind: 'external', url: href };
  }
  if (SAFE_EXTERNAL.test(href)) return { kind: 'external', url: href };
  // Any other scheme (javascript:, data:, vbscript:, intent:, file:) is refused.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { kind: 'ignore' };
  const base = opts.basePath ?? '/';
  const dir = base.endsWith('/') ? base : base.slice(0, base.lastIndexOf('/') + 1) || '/';
  return { kind: 'internal', path: `${dir}${href.replace(/^\.\//, '')}` };
};

/**
 * An image source the app will load: absolute http(s), a data:image URI, or
 * an origin-relative path resolved against `origin` (the web app's origin,
 * else the API host). Anything else — javascript:, file:, blank — is null.
 */
export const resolveMediaUrl = (srcIn: string | null | undefined, origin: string | null): string | null => {
  const src = String(srcIn ?? '').trim();
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) return src;
  if (/^data:image\//i.test(src)) return src;
  if (src.startsWith('//')) return `https:${src}`;
  if (src.startsWith('/') && origin) return `${origin.replace(/\/+$/, '')}${src}`;
  return null;
};

/** `width` / `height` attributes as an aspect ratio, when both are usable numbers. */
export const attrAspectRatio = (attrs: Readonly<Record<string, string>>): number | null => {
  const w = parseFloat(attrs.width ?? '');
  const h = parseFloat(attrs.height ?? '');
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? w / h : null;
};
