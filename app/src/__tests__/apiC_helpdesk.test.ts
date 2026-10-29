/**
 * Helpdesk — live chat merging and attachment rules, support tickets, and
 * the request shapes (the send field is `text`). No network.
 */
import fs from 'fs';
import path from 'path';

import type { InternalAxiosRequestConfig } from 'axios';

import { api } from '@/api/client';
import { feedbackApi } from '@/api/feedback.api';
import { helpdeskApi } from '@/api/helpdesk.api';
import {
  applyTicketPush,
  chatDayLabel,
  chatSendErrorText,
  chatThreadItems,
  composeChatSend,
  extOf,
  hasInbound,
  hasMoreHistory,
  isImageAttachment,
  markOutboundSeen,
  mergeChatMessages,
  parseChatSocketEvent,
  stageChatFiles,
  ticketMeta,
  ticketStatusLabel,
  ticketStatusTone,
  toChatMessage,
  toChatThread,
  toChatUploadConfig,
  toTicket,
  toTicketCategories,
  validateChatFile,
  validateTicket,
  validateTicketAttachment,
  type ChatMessage,
} from '@/types/helpdesk';

import { HELPDESK_TIMES, KB_ARTICLES, helpdeskKb } from '@/utils/helpdesk';

const ROOT = path.join(__dirname, '../../..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
/** EquityHub's web page. */
const HELPDESK = read('client/src/pages/Helpdesk.jsx');

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

const msg = (id: string, at: string, senderRole = 'USER', seenAt: string | null = null): ChatMessage =>
  toChatMessage({ _id: id, createdAt: at, senderRole, text: id, seenAt });

/* ── Chat ─────────────────────────────────────────────────────────────── */

describe('chat merging', () => {
  it('shows a message that arrives three ways exactly once', () => {
    const a = msg('a', '2026-09-29T10:00:00Z');
    const b = msg('b', '2026-09-29T10:01:00Z', 'MANAGER');
    let state = mergeChatMessages([], a).messages;
    state = mergeChatMessages(state, [b, a]).messages; // poll
    const again = mergeChatMessages(state, b); // socket echo
    expect(again.messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(again.added).toEqual([]);
  });

  it('puts a late echo in time order and reports only what is new', () => {
    const late = msg('late', '2026-09-29T09:59:00Z');
    const r = mergeChatMessages([msg('a', '2026-09-29T10:00:00Z')], late);
    expect(r.messages.map((m) => m.id)).toEqual(['late', 'a']);
    expect(r.added.map((m) => m.id)).toEqual(['late']);
  });

  it('ignores rows with no id', () => {
    expect(mergeChatMessages([], toChatMessage({ text: 'x' })).messages).toEqual([]);
  });

  it('knows inbound from outbound and stamps seen only on the trader side', () => {
    const list = [msg('a', '2026-09-29T10:00:00Z'), msg('b', '2026-09-29T10:01:00Z', 'MANAGER')];
    expect(hasInbound(list)).toBe(true);
    expect(hasInbound([list[0] as ChatMessage])).toBe(false);
    const seen = markOutboundSeen(list, '2026-09-29T11:00:00Z');
    expect(seen[0]?.seenAt).toBe('2026-09-29T11:00:00Z');
    expect(seen[1]?.seenAt).toBeNull();
  });

  it('reads the thread with no manager yet', () => {
    const t = toChatThread({ conversation: { _id: 'c1', userId: 'u1' }, counterpart: null, messages: [{ _id: 'm1' }, {}] });
    expect(t.conversation?.id).toBe('c1');
    expect(t.counterpart).toBeNull();
    expect(t.messages).toHaveLength(1);
  });

  it('narrows socket frames and drops unknown ones', () => {
    expect(parseChatSocketEvent({ event: 'message', message: { _id: 'm1', text: 'hi' } }))
      .toMatchObject({ event: 'message', message: { id: 'm1', text: 'hi' } });
    expect(parseChatSocketEvent({ event: 'message', message: {} })).toBeNull();
    expect(parseChatSocketEvent({ event: 'presence', userId: 'u', online: true }))
      .toEqual({ event: 'presence', userId: 'u', online: true });
    expect(parseChatSocketEvent({ event: 'nope' })).toBeNull();
    expect(parseChatSocketEvent(null)).toBeNull();
  });

  it('rewrites only NO_MANAGER', () => {
    expect(chatSendErrorText('NO_MANAGER', 'x')).toBe('No manager is assigned to you yet.');
    expect(chatSendErrorText('OTHER', 'server words')).toBe('server words');
  });
});

describe('chat attachments', () => {
  const cfg = toChatUploadConfig({
    enabled: true, maxFileMB: 1, maxTotalMB: 2, maxFiles: 3,
    allowedExtensions: ['PNG', 'pdf'], blockedExtensions: ['exe'],
  });

  it('reads the config with safe defaults', () => {
    expect(cfg.allowedExtensions).toEqual(['png', 'pdf']);
    expect(toChatUploadConfig({})).toMatchObject({ enabled: true, maxFileMB: 5, maxTotalMB: 0, maxFiles: 0 });
    expect(extOf('Report.Final.PDF')).toBe('pdf');
    expect(extOf('noext')).toBe('');
  });

  it('checks one file in the web words', () => {
    expect(validateChatFile({ name: 'a.exe', size: 1 }, cfg)).toBe('Executable / unsafe files (.exe) are not allowed.');
    expect(validateChatFile({ name: 'a.gif', size: 1 }, cfg)).toBe('.gif is not allowed. Allowed: png, pdf.');
    expect(validateChatFile({ name: 'big.png', size: 2 * 1024 * 1024 }, cfg)).toBe('"big.png" exceeds the 1 MB per-file limit.');
    expect(validateChatFile({ name: 'ok.png', size: 10 }, cfg)).toBeNull();
    expect(validateChatFile({ name: 'ok.png', size: 10 }, null)).toBe('File uploads are currently disabled.');
  });

  it('applies the count and total caps across a batch', () => {
    const mb = 1024 * 1024;
    const r = stageChatFiles(
      [{ name: 'a.png', size: 0.9 * mb }, { name: 'b.png', size: 0.9 * mb }, { name: 'c.png', size: 10 }, { name: 'd.png', size: 10 }],
      [{ name: 'held.png', size: 0.5 * mb }],
      cfg,
    );
    expect(r.accepted.map((f) => f.name)).toEqual(['a.png', 'c.png']);
    expect(r.errors).toEqual([
      'Total attachments would exceed the 2 MB limit.',
      'You can attach at most 3 file(s) per message.',
    ]);
  });
});

/* ── Tickets ──────────────────────────────────────────────────────────── */

describe('tickets', () => {
  it('adapts a ticket and never exposes an internal note', () => {
    const t = toTicket({ _id: 't1', subject: 's', adminNote: 'secret', context: { page: '/helpdesk' } });
    expect(t).toMatchObject({ id: 't1', category: 'OTHER', status: 'OPEN', contextPage: '/helpdesk' });
    expect(t).not.toHaveProperty('adminNote');
  });

  it('My Tickets lists every ticket, whatever its category — Helpdesk.jsx', () => {
    // EquityHub's Helpdesk shows ALL of the user's tickets (no SUPPORT filter)
    // and prepends any pushed ticket it does not have yet.
    expect(HELPDESK).toContain('setTickets(data.data || []);');
    expect(HELPDESK).toContain('if (i === -1) return [t, ...prev];');
    expect(HELPDESK).not.toContain("f.category === 'SUPPORT'");
    expect(applyTicketPush([toTicket({ _id: 'a', category: 'SUPPORT' })], { ticket: { _id: 'b', category: 'WITHDRAWAL' } }).map((t) => t.id))
      .toEqual(['b', 'a']);
  });

  it("takes the server's category list (value + label) — never one of its own", () => {
    expect(HELPDESK).toContain("api.get('/user/feedback/categories')");
    expect(HELPDESK).not.toContain('TICKET_CATEGORIES');
    expect(read('backend/src/routes/user.js')).toContain("router.get('/feedback/categories', c.getFeedbackCategories);");
    expect(toTicketCategories([{ value: 'WITHDRAWAL', label: 'Withdrawal' }, { value: 'UX' }, { label: 'orphan' }]))
      .toEqual([{ value: 'WITHDRAWAL', label: 'Withdrawal' }, { value: 'UX', label: 'UX' }]);
  });

  it('the knowledge base is the web built-ins, then the admin articles', () => {
    const start = HELPDESK.indexOf('const KB_ARTICLES = [');
    const end = HELPDESK.indexOf('\n];\n', start);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const web = new Function(`return ${HELPDESK.slice(start + 'const KB_ARTICLES = '.length, end + 3)};`)() as unknown[];
    expect(web).toHaveLength(8);
    expect(KB_ARTICLES).toEqual(web);
    const admin = [{ q: 'Admin Q', a: 'Admin A', tag: 'Funds' }];
    expect(helpdeskKb(admin)).toEqual([...web, ...admin]);
    expect(HELPDESK).toContain('const allKb = useMemo(() => [...KB_ARTICLES, ...adminKb], [adminKb]);');
  });

  it('promises the web turnaround on the new-ticket form', () => {
    expect(HELPDESK).toContain('Average first response: <span className="text-text-primary font-semibold">2-4 hours</span>.');
    expect(HELPDESK_TIMES.supportReply).toBe('2-4 hours');
  });

  it('validates each form in its own words', () => {
    expect(validateTicket({ subject: 'Hello', message: 'long enough text' }, 'helpdesk')).toBe('Please select a category.');
    expect(validateTicket({ category: 'BUG', subject: 'Hi', message: 'long enough text' }, 'feedback')).toBe('Subject too short');
    expect(validateTicket({ category: 'BUG', subject: 'Hello', message: 'short' }, 'feedback')).toBe('Message too short (min 10 chars)');
    expect(validateTicket({ category: 'BUG', subject: 'Hello', message: 'short' }, 'helpdesk')).toBe('Describe your issue (min 10 chars)');
    expect(validateTicket({ category: 'BUG', subject: 'Hello', message: 'long enough text' }, 'helpdesk')).toBeNull();
  });

  it('takes only an image or PDF of at most 3 MB', () => {
    expect(validateTicketAttachment({ name: 'a.zip', size: 1, mimeType: 'application/zip' })).toBe('Attach an image or a PDF');
    expect(validateTicketAttachment({ name: 'a.pdf', size: 4 * 1024 * 1024, mimeType: 'application/pdf' })).toBe('File too large — max 3 MB');
    expect(validateTicketAttachment({ name: 'a.png', size: 10, mimeType: 'image/png' })).toBeNull();
  });

  it('merges a partial push without blanking fields it did not carry', () => {
    const list = [toTicket({ _id: 't1', subject: 'Keep me', status: 'OPEN', category: 'SUPPORT' })];
    const next = applyTicketPush(list, { ticket: { _id: 't1', status: 'RESOLVED', adminReply: 'Done' } });
    expect(next[0]).toMatchObject({ id: 't1', subject: 'Keep me', status: 'RESOLVED', adminReply: 'Done' });
  });

  it('prepends a new ticket only when the list accepts it', () => {
    const pushed = { ticket: { _id: 't2', category: 'BUG' } };
    expect(applyTicketPush([], pushed)).toHaveLength(1);
    expect(applyTicketPush([], pushed, (t) => t.category === 'SUPPORT')).toHaveLength(0);
    expect(applyTicketPush([], { nothing: true })).toEqual([]);
  });
});

/* ── Requests ─────────────────────────────────────────────────────────── */

describe('helpdeskApi requests', () => {
  it('sends the message under `text`', async () => {
    reply = () => ({ success: true, data: { _id: 'm1', text: 'hello', senderRole: 'USER' } });
    const m = await helpdeskApi.send('c1', { text: 'hello' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/chat/conversations/c1/messages', data: { text: 'hello' } });
    expect(calls[0]?.data).not.toHaveProperty('attachments');
    expect(m.id).toBe('m1');
  });

  it('anchors the poll and the history on createdAt, never on an id', async () => {
    reply = () => ({ success: true, data: [{ _id: 'm2' }] });
    const newest = msg('m1', '2026-09-29T10:00:00.000Z');
    await helpdeskApi.messagesAfter('c1', newest);
    expect(calls[0]).toMatchObject({ url: '/chat/conversations/c1/messages', params: { after: '2026-09-29T10:00:00.000Z' } });
    await helpdeskApi.messagesAfter('c1', null);
    expect(calls[1]?.params).toEqual({ limit: 50 });
    await helpdeskApi.messagesBefore('c1', newest);
    expect(calls[2]?.params).toEqual({ before: '2026-09-29T10:00:00.000Z', limit: 50 });
  });

  it('reads the conversation', async () => {
    reply = () => ({ success: true, data: { conversation: { _id: 'c9' }, counterpart: { id: 'mgr', name: 'Riya', online: true }, messages: [] } });
    const t = await helpdeskApi.conversation();
    expect(calls[0]?.url).toBe('/chat/conversation');
    expect(t.counterpart).toMatchObject({ id: 'mgr', name: 'Riya', online: true });
  });
});

describe('feedbackApi requests', () => {
  it('stamps the page and app version and sends the attachment only when present', async () => {
    reply = () => ({ success: true, data: { id: 't1', status: 'OPEN' } });
    const r = await feedbackApi.submit({ category: 'BUG', subject: 'Crash', message: 'It crashed on open', page: '/helpdesk' });
    expect(r).toEqual({ id: 't1', status: 'OPEN' });
    const body = calls[0]?.data as Record<string, unknown>;
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/user/feedback' });
    expect(body).toMatchObject({ category: 'BUG', subject: 'Crash', rating: null, context: { page: '/helpdesk' } });
    expect(body).not.toHaveProperty('attachment');
  });

  it('lists tickets, dropping rows without an id', async () => {
    reply = () => ({ success: true, data: [{ _id: 't1' }, { subject: 'orphan' }] });
    expect((await feedbackApi.list()).map((t) => t.id)).toEqual(['t1']);
  });

  it('reads the category list from GET /user/feedback/categories', async () => {
    reply = () => ({ success: true, data: [{ value: 'SUPPORT', label: 'Support' }, { value: 'PAYMENT', label: 'Payment' }] });
    expect(await feedbackApi.categories()).toEqual([{ value: 'SUPPORT', label: 'Support' }, { value: 'PAYMENT', label: 'Payment' }]);
    expect(calls[0]).toMatchObject({ method: 'GET', url: '/user/feedback/categories' });
  });
});

describe('chat composer and thread', () => {
  const file = (dataUrl: string) => ({ id: 'f', name: 'a.png', mimeType: 'image/png', dataUrl, sizeBytes: 3, progress: dataUrl ? 100 : 40 });

  it('waits for every staged file before sending', () => {
    expect(composeChatSend('hi', [file('')])).toEqual({ error: 'Please wait — files are still being read…' });
    expect(composeChatSend('  ', [])).toBeNull();
    expect(composeChatSend(' hi ', [])).toEqual({ body: { text: 'hi' } });
    expect(composeChatSend('', [file('data:image/png;base64,AAA')])).toEqual({
      body: { text: '', attachments: [{ name: 'a.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAA' }] },
    });
  });

  it('knows when older history may remain', () => {
    expect(hasMoreHistory(new Array(50).fill(0))).toBe(true);
    expect(hasMoreHistory(new Array(49).fill(0))).toBe(false);
    expect(isImageAttachment({ mimeType: 'image/jpeg' })).toBe(true);
    expect(isImageAttachment({ mimeType: 'application/pdf' })).toBe(false);
  });

  it('puts a day chip wherever the calendar day changes', () => {
    const now = new Date(2026, 8, 29, 15, 0);
    const at = (d: number, h: number) => new Date(2026, 8, d, h).toISOString();
    const items = chatThreadItems([
      msg('a', at(28, 9)),
      msg('b', at(28, 10), 'MANAGER'),
      msg('c', at(29, 9)),
    ], now);
    expect(items.map((i) => (i.kind === 'day' ? i.label : i.message.id))).toEqual(['Yesterday', 'a', 'b', 'Today', 'c']);
    expect(items.filter((i) => i.kind === 'message').map((i) => (i.kind === 'message' ? i.mine : null))).toEqual([true, false, true]);
    expect(chatDayLabel(at(10, 9), now)).not.toMatch(/Today|Yesterday/);
  });
});

describe('ticket chips', () => {
  it('colours and labels statuses like the web', () => {
    expect(ticketStatusTone('RESOLVED')).toBe('bull');
    expect(ticketStatusTone('SOMETHING')).toBe('info');
    expect(ticketStatusLabel('IN_PROGRESS')).toBe('IN PROGRESS');
    expect(ticketMeta(toTicket({ category: 'BUG', rating: 4 }))).toBe('BUG · ★★★★');
    expect(ticketMeta(toTicket({ category: 'UX' }))).toBe('UX');
  });
});
