import type { HelpdeskTab } from '@/navigation/types';

/**
 * The Helpdesk page's pure logic — client/src/pages/Helpdesk.jsx, minus React.
 */

/** Helpdesk.jsx TABS — anything else in the link falls back to the FAQ. */
export const HELPDESK_TABS: readonly HelpdeskTab[] = ['chat', 'faq', 'tickets', 'new'];

export const helpdeskTabOf = (raw: unknown): HelpdeskTab =>
  (HELPDESK_TABS.includes(raw as HelpdeskTab) ? (raw as HelpdeskTab) : 'faq');

/**
 * One knowledge-base article — a built-in one (KB_ARTICLES) or the admin's
 * (GET /cms/knowledge-base).
 */
export interface HelpArticle {
  q: string;
  a: string;
  tag: string;
  /** A web path ("Go to <tag> →"). */
  link?: string | null;
  /** YouTube / Vimeo / mp4. */
  videoUrl?: string | null;
}

/**
 * Helpdesk.jsx KB_ARTICLES — the built-in answers, verbatim. The admin's
 * Knowledge Base articles are APPENDED to these (helpdeskKb); EquityHub's
 * server serves only the admin's own.
 */
export const KB_ARTICLES: readonly HelpArticle[] = [
  {
    q: 'How long do withdrawals take?',
    a: 'UPI: ≤ 2 hours. Bank transfer: 1 business day. Crypto: ~30 minutes once admin approves. High-value (>10 lakh) needs two-admin approval — adds 24h.',
    tag: 'Funds',
    link: '/wallet',
  },
  {
    q: 'Why is my position showing in CLOSING status?',
    a: 'You (or the worker) submitted a close order; engine is matching it. Auto-resolves in seconds. If it sticks for >30s, the engine likely failed — try the Close button again.',
    tag: 'Trading',
    link: '/trade',
  },
  {
    q: 'How is margin calculated?',
    a: 'margin = (quantity × price) ÷ leverage. Locked at order placement, released when the position closes. Settlement = margin + PnL − fee.',
    tag: 'Trading',
  },
  {
    q: 'What does Margin Call mean?',
    a: 'When equity / used margin × 100 ≤ 80% you get a Margin Call notification. At ≤ 50% (Stop Out level), the broker auto-liquidates your largest losing position until equity recovers.',
    tag: 'Risk',
    link: '/wallet',
  },
  {
    q: 'KYC rejected — what to do?',
    a: 'Re-upload clearer photos with all four corners visible, no glare, and matching name across documents. The rejection note tells you the specific issue.',
    tag: 'Account',
    link: '/profile',
  },
  {
    q: 'Why is BUY/SELL disabled in the order form?',
    a: 'Likely insufficient free margin, or the instrument is paused (check Mode badge). KYC must be APPROVED for live trading; demo accounts always work.',
    tag: 'Trading',
    link: '/trade',
  },
  {
    q: 'Where do I see my IB / referral commissions?',
    a: 'IB Room shows total earned + per-trade breakdown. Commissions credit to your wallet automatically when a referred user trades.',
    tag: 'Affiliate',
    link: '/ib-room',
  },
  {
    q: 'My chart shows "Loading…" forever',
    a: 'Backend likely lost DB connection or your session expired. Check Wallets — if it loads, refresh Trade. If both fail, log out and back in.',
    tag: 'Technical',
  },
];

/** Helpdesk.jsx allKb — the built-in answers, then the admin's. */
export const helpdeskKb = (adminKb: readonly HelpArticle[]): HelpArticle[] => [...KB_ARTICLES, ...adminKb];

/**
 * Helpdesk.jsx's promise on the new-ticket form ("Average first response:
 * …"). EquityHub writes it into the page; it has no Service Times setting.
 */
export { SERVICE_TIMES_DEFAULTS as HELPDESK_TIMES } from '@/constants/serviceTimes';

/** Helpdesk.jsx filteredKb — question, answer or tag, case-insensitive. */
export const filterKb = (articles: readonly HelpArticle[], search: string): HelpArticle[] => {
  const q = search.trim().toLowerCase();
  if (!q) return [...articles];
  return articles.filter((a) =>
    (a.q || '').toLowerCase().includes(q)
    || (a.a || '').toLowerCase().includes(q)
    || (a.tag || '').toLowerCase().includes(q));
};

/**
 * Helpdesk.jsx toEmbedUrl — a YouTube / Vimeo watch URL as its embeddable
 * player, or null when it cannot be embedded.
 */
export const toEmbedUrl = (url: string | null | undefined): string | null => {
  if (!url) return null;
  // Parsed by hand: React Native's URL / URLSearchParams are incomplete.
  const m = /^https?:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i.exec(url.trim());
  if (!m) return null;
  const host = (m[1] ?? '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
  const path = m[2] ?? '';
  const query = m[3] ?? '';
  const param = (k: string): string => {
    const hit = new RegExp(`[?&]${k}=([^&]*)`).exec(query);
    if (!hit) return '';
    try { return decodeURIComponent(hit[1] ?? ''); } catch { return hit[1] ?? ''; }
  };
  if (host === 'youtu.be') return `https://www.youtube.com/embed/${path.slice(1)}`;
  if (host.endsWith('youtube.com')) {
    const id = param('v') || (path.startsWith('/embed/') ? path.slice(7) : '');
    return id ? `https://www.youtube.com/embed/${id}` : null;
  }
  if (host.endsWith('vimeo.com')) {
    const id = path.split('/').filter(Boolean).pop() ?? '';
    return /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}` : null;
  }
  return null;
};

/** A direct video file the web plays in a `<video>`. */
export const isDirectVideo = (url: string | null | undefined): boolean => /\.(mp4|webm|ogg)(\?|$)/i.test(String(url ?? ''));

/** `#A1B2C3` — the ticket's short reference (the id's last six, upper-cased). */
export const ticketRef = (id: string): string => `#${id.slice(-6).toUpperCase()}`;
