/**
 * Public content (CMS pages, footer, news, knowledge base, economic
 * calendar) and the notification bell's merge rules. No network.
 */
import type { InternalAxiosRequestConfig } from 'axios';

import { api } from '@/api/client';
import { cmsApi } from '@/api/cms.api';
import { notificationsApi } from '@/api/notifications.api';
import {
  cmsFailure,
  fmtEconomicValue,
  footerColumns,
  helpdeskTabOf,
  searchKb,
  toCmsPage,
  toEconomicCalendar,
  toFooter,
  toKbArticles,
  toNewsArticle,
  toNewsPage,
} from '@/types/cms';
import {
  DEFAULT_NOTIFICATION_PREFS,
  MAX_NOTIFICATIONS,
  allowedByPrefs,
  applyNotificationPush,
  mergeServerNotifications,
  serverIdOf,
  toBellNotification,
  toServerNotification,
  unreadCount,
  type BellNotification,
} from '@/types/notifications';

type Call = { method: string; url: string; params: Record<string, unknown>; data: unknown };
const calls: Call[] = [];
let reply: (c: Call) => unknown = () => ({ success: true, data: null });

beforeAll(() => {
  api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const call: Call = {
      method: String(config.method ?? 'get').toUpperCase(),
      url: String(config.url ?? ''),
      params: (config.params ?? {}) as Record<string, unknown>,
      data: typeof config.data === 'string' ? JSON.parse(config.data) : config.data,
    };
    calls.push(call);
    return { data: reply(call), status: 200, statusText: 'OK', headers: {}, config };
  };
});

beforeEach(() => {
  calls.length = 0;
  reply = () => ({ success: true, data: null });
});

/* ── CMS ──────────────────────────────────────────────────────────────── */

describe('cms pages', () => {
  it('adapts a page and refuses a body that is not one', () => {
    const p = toCmsPage({ _id: 'p1', slug: 'terms', title: 'Terms', visibility: 'auth', metaKeywords: ['a', '', 3] });
    expect(p).toMatchObject({ id: 'p1', slug: 'terms', visibility: 'AUTH', metaKeywords: ['a'] });
    expect(toCmsPage({})).toBeNull();
  });

  it('tells "sign in" from "not found"', () => {
    expect(cmsFailure({ response: { data: { error: { code: 'AUTH_REQUIRED' } } } })).toBe('auth');
    expect(cmsFailure({ response: { status: 404 } })).toBe('notfound');
    expect(cmsFailure(undefined)).toBe('notfound');
  });

  it('asks for the lower-cased, encoded slug', async () => {
    reply = () => ({ success: true, data: { slug: 'about us', title: 'About' } });
    await cmsApi.page('About Us');
    expect(calls[0]?.url).toBe('/cms/pages/about%20us');
  });

  it('throws on an empty page body rather than rendering a blank page', async () => {
    reply = () => ({ success: true, data: {} });
    await expect(cmsApi.page('x')).rejects.toThrow('Page not found');
  });
});

describe('footer', () => {
  it('reads links and config, dropping blank socials', () => {
    const f = toFooter({
      links: [{ slug: 'terms', label: 'Terms', column: 'Legal', authOnly: true }, { label: 'no slug' }],
      config: { brand: 'EquityHub', socials: { twitter: ' https://x.com/a ', youtube: '' }, customSocials: [{ label: 'Blog' }] },
    });
    expect(f.links).toEqual([{ slug: 'terms', label: 'Terms', href: '/page/terms', column: 'Legal', openInNewTab: false, authOnly: true }]);
    expect(f.config.socials).toEqual({ twitter: 'https://x.com/a' });
    expect(f.config.customSocials).toEqual([]);
  });

  it('accepts the older bare-array answer', () => {
    const f = toFooter([{ slug: 'privacy' }]);
    expect(f.links.map((l) => l.slug)).toEqual(['privacy']);
    expect(f.links[0]?.column).toBe('Company');
  });

  it('groups columns in first-seen order', () => {
    const f = toFooter({ links: [
      { slug: 'a', column: 'Legal' }, { slug: 'b', column: 'Company' }, { slug: 'c', column: 'Legal' },
    ] });
    expect(footerColumns(f.links).map((c) => `${c.column}:${c.links.map((l) => l.slug).join('')}`))
      .toEqual(['Legal:ac', 'Company:b']);
  });

  it('sends lang only when it is not English', async () => {
    reply = () => ({ success: true, data: { links: [], config: {} } });
    await cmsApi.footer();
    expect(calls[0]).toMatchObject({ url: '/cms/footer-links', params: {} });
    await cmsApi.footer('hi');
    expect(calls[1]?.params).toEqual({ lang: 'hi' });
  });
});

describe('news + knowledge base', () => {
  it('pages the list and defaults the category', () => {
    const pg = toNewsPage({ items: [{ slug: 'a', title: 'A' }, {}], pagination: { page: 2, limit: 12, total: 13, pages: 2 } });
    expect(pg.items).toHaveLength(1);
    expect(pg.items[0]?.category).toBe('General');
    expect(pg).toMatchObject({ page: 2, pages: 2, total: 13 });
    expect(toNewsArticle({})).toBeNull();
  });

  it('keeps only answerable articles and searches question, answer and tag', () => {
    const kb = toKbArticles({ articles: [{ q: 'How to deposit?', a: 'Use UPI', tag: 'Wallet' }, { q: 'empty' }] });
    expect(kb).toHaveLength(1);
    expect(kb[0]?.tag).toBe('Wallet');
    expect(searchKb(kb, 'upi')).toHaveLength(1);
    expect(searchKb(kb, 'wallet')).toHaveLength(1);
    expect(searchKb(kb, 'kyc')).toHaveLength(0);
    expect(searchKb(kb, '  ')).toHaveLength(1);
  });

  it('sends news filters only when set', async () => {
    reply = () => ({ success: true, data: { items: [], pagination: {} } });
    await cmsApi.news({ q: 'rbi' });
    expect(calls[0]).toMatchObject({ url: '/cms/news', params: { page: 1, limit: 12, q: 'rbi' } });
  });
});

describe('economic calendar', () => {
  it('reads the switch and normalises events', () => {
    const c = toEconomicCalendar({
      enabled: false,
      events: [
        { id: 'e1', date: '2026-10-01T12:30:00Z', event: 'CPI', country: 'us', currency: 'usd', impact: 'HIGH', actual: '3.1', unit: '%' },
        { event: 'no date' },
      ],
    });
    expect(c.enabled).toBe(false);
    expect(c.events).toHaveLength(1);
    expect(c.events[0]).toMatchObject({ country: 'US', currency: 'USD', impact: 'high', actual: 3.1, previous: null });
  });

  it('formats an admin figure with its unit, grouping only from 1,000', () => {
    expect(fmtEconomicValue(3.1, '%')).toBe('3.1%');
    expect(fmtEconomicValue(250000, 'K')).toBe('250,000K');
    expect(fmtEconomicValue(1234.5, '')).toBe('1,234.5');
    expect(fmtEconomicValue(null, '%')).toBeNull();
  });

  it("keeps the admin's typed text — EquityHub's server stores figures as strings", () => {
    // cmsPageController normalises previous/consensus/forecast/actual to trimmed STRINGS.
    const ctrl = require('fs').readFileSync(require('path').join(__dirname, '../../../backend/src/controllers/cmsPageController.js'), 'utf8') as string;
    expect(ctrl).toContain('actual:    e.actual === \'\' || e.actual == null ? null : String(e.actual).trim().slice(0, 16),');
    const c = toEconomicCalendar({
      events: [{ id: 'e2', date: '2026-10-01T12:30:00Z', event: 'NFP', previous: '175K', consensus: '', actual: '3.2', unit: '' }],
    });
    expect(c.events[0]).toMatchObject({ previous: null, previousText: '175K', consensusText: null, actual: 3.2, actualText: '3.2' });
    expect(fmtEconomicValue('175K', '')).toBe('175K');
    expect(fmtEconomicValue('', '%')).toBeNull();
  });

  it('formats exactly as utils/economicCalendar.js _fmtAdmin does', () => {
    const src = (require('fs').readFileSync(require('path').join(__dirname, '../../../client/src/utils/economicCalendar.js'), 'utf8') as string)
      .replace(/\r\n/g, '\n');
    const start = src.indexOf('const _fmtAdmin = (v, unit) => {');
    const end = src.indexOf('\n};\n', start);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const web = new Function(`${src.slice(start, end + 3)} return _fmtAdmin;`)() as (v: unknown, u: string) => string | null;
    for (const [v, u] of [[3.1, '%'], [250000, 'K'], [1234.5, ''], [-1500.25, ''], [999, ''], ['175K', ''], ['3.2', '%'], [null, '%'], ['', '']] as const) {
      expect(fmtEconomicValue(v as never, u)).toBe(web(v, u));
    }
  });
});

/* ── Notifications ────────────────────────────────────────────────────── */

describe('notification bell', () => {
  const now = Date.UTC(2026, 8, 29, 12);
  const srv = (id: string, minsAgo: number, extra: Record<string, unknown> = {}) =>
    toServerNotification({ _id: id, title: `T${id}`, createdAt: new Date(now - minsAgo * 60_000).toISOString(), ...extra });

  it('files an unknown server type under Account and reads status/link from data', () => {
    const b = toBellNotification(srv('1', 1, { type: 'MARGIN_CALL', data: { status: 'warning', link: '/wallet' } }), now);
    expect(b).toMatchObject({ id: 'srv:1', type: 'ACCOUNT', status: 'warning', link: '/wallet', read: false });
    expect(toBellNotification(srv('2', 1, { type: 'ORDER', title: '' }), now).title).toBe('Notification');
  });

  it('merges a fetch: cutoff hides cleared entries, fresh replaces held, locals stay', () => {
    const held: BellNotification[] = [
      { ...toBellNotification(srv('1', 10), now), read: false },
      { id: 'local-1', type: 'ORDER', title: 'Filled', message: '', timestamp: now - 5 * 60_000, status: 'success', link: null, symbol: null, read: false },
    ];
    const clearedAt = now - 30 * 60_000;
    const merged = mergeServerNotifications(held, [srv('1', 10, { isRead: true }), srv('old', 60)], clearedAt, now);
    expect(merged.map((n) => n.id)).toEqual(['local-1', 'srv:1']);
    expect(merged.find((n) => n.id === 'srv:1')?.read).toBe(true);
  });

  it('caps the list', () => {
    const many = Array.from({ length: MAX_NOTIFICATIONS + 5 }, (_, i) => srv(String(i), i));
    expect(mergeServerNotifications([], many, 0, now)).toHaveLength(MAX_NOTIFICATIONS);
  });

  it('prepends a live push once, and never one from before the clear', () => {
    const push = { _id: 'p1', type: 'ANNOUNCEMENT', title: 'Hi', createdAt: new Date(now).toISOString(), isRead: true };
    const once = applyNotificationPush([], push, 0, now);
    expect(once).toHaveLength(1);
    expect(once[0]?.read).toBe(false);
    expect(applyNotificationPush(once, push, 0, now)).toHaveLength(1);
    expect(applyNotificationPush([], push, now + 1, now)).toHaveLength(0);
    expect(applyNotificationPush([], { title: 'no id' }, 0, now)).toHaveLength(0);
    expect(unreadCount(once)).toBe(1);
  });

  it('honours the category switches', () => {
    expect(allowedByPrefs('ORDER', { ...DEFAULT_NOTIFICATION_PREFS, enableTrading: false })).toBe(false);
    expect(allowedByPrefs('PRICE_ALERT', { ...DEFAULT_NOTIFICATION_PREFS, enableTrading: false })).toBe(true);
    expect(allowedByPrefs('ANNOUNCEMENT', { ...DEFAULT_NOTIFICATION_PREFS, enableAccount: false })).toBe(false);
    expect(serverIdOf('srv:abc')).toBe('abc');
    expect(serverIdOf('local-1')).toBeNull();
  });
});

describe('notificationsApi requests', () => {
  it('marks only server entries read', async () => {
    reply = () => ({ success: true, data: { updated: 1 } });
    const oid = '0123456789abcdef01234567';
    expect(await notificationsApi.markRead(['srv:a1', 'local-9', oid])).toBe(1);
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/user/notifications/read', data: { ids: ['a1', oid] } });
    expect(await notificationsApi.markRead(['local-only'])).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('marks all read with { all: true }', async () => {
    reply = () => ({ success: true, data: { updated: 7 } });
    expect(await notificationsApi.markAllRead()).toBe(7);
    expect(calls[0]?.data).toEqual({ all: true });
  });

  it('lists with a limit and drops rows without an id', async () => {
    reply = () => ({ success: true, data: [{ _id: 'n1' }, { title: 'x' }] });
    const list = await notificationsApi.list();
    expect(calls[0]).toMatchObject({ url: '/user/notifications', params: { limit: MAX_NOTIFICATIONS } });
    expect(list.map((n) => n.id)).toEqual(['n1']);
  });

  it('registers and encodes a push token', async () => {
    await notificationsApi.registerPushToken('ExponentPushToken[abc]', 'android');
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/user/push-tokens', data: { token: 'ExponentPushToken[abc]', platform: 'android' } });
    await notificationsApi.unregisterPushToken('ExponentPushToken[abc]');
    expect(calls[1]).toMatchObject({ method: 'DELETE', url: '/user/push-tokens/ExponentPushToken%5Babc%5D' });
  });
});

describe('helpdesk knowledge base', () => {
  it('is the server\'s list as sent — the starter answers now come from Admin → Knowledge Base', () => {
    const all = toKbArticles({ articles: [
      { id: 'kb-default-margin-call', q: 'What does Margin Call mean?', a: 'At ≤ 80%…', tag: 'Risk' },
      { q: 'New?', a: 'Yes', tag: 'Misc' },
    ] });
    expect(all.map((k) => k.q)).toEqual(['What does Margin Call mean?', 'New?']);
    expect(searchKb(all, 'margin call').map((k) => k.tag)).toEqual(['Risk']);
  });

  it('restores only a known tab from a deep link', () => {
    expect(helpdeskTabOf('tickets')).toBe('tickets');
    expect(helpdeskTabOf('admin')).toBe('faq');
    expect(helpdeskTabOf(null)).toBe('faq');
  });
});
