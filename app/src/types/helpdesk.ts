/**
 * Helpdesk — live chat with the assigned manager, and support tickets
 * (feedback). Types, adapters and the pure logic the screens share.
 *
 * Chat shapes: backend/src/controllers/chatController.js and
 * services/chatService.js (serializeMessage, counterpartInfo,
 * getEffectiveUploadConfig). Behaviour: client/src/pages/HelpdeskChat.jsx.
 *
 * Tickets: backend/src/controllers/userController.js (submitFeedback,
 * listMyFeedback) and models/Feedback.js. Behaviour: pages/Feedback.jsx and
 * pages/Helpdesk.jsx, which both open tickets through the same endpoint.
 */
import { id, num, rows, str, strOrNull } from '@/types/api';

type Raw = Record<string, unknown>;

const obj = (v: unknown): Raw =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

const strList = (v: unknown): string[] =>
  (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase()) : []);

/* ══ Chat ═══════════════════════════════════════════════════════════════ */

/** Who wrote a message, within the conversation. `USER` is the trader. */
export type ChatSenderRole = 'USER' | 'MANAGER' | 'SUPER_ADMIN' | (string & {});

export interface ChatAttachment {
  name: string;
  mimeType: string;
  /** A base64 data: URI — the server stores and returns attachments inline. */
  dataUrl: string;
  sizeBytes: number | null;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderRole: ChatSenderRole;
  text: string;
  attachments: ChatAttachment[];
  seenAt: string | null;
  createdAt: string;
}

export interface ChatConversation {
  id: string;
  userId: string;
  managerId: string | null;
  unread: number;
  status: string | null;
}

/** The person on the other end. null until a manager is assigned. */
export interface ChatCounterpart {
  id: string;
  name: string;
  email: string;
  userUid: string | null;
  role: string | null;
  online: boolean;
}

export interface ChatThread {
  conversation: ChatConversation | null;
  counterpart: ChatCounterpart | null;
  /** Oldest first. */
  messages: ChatMessage[];
}

export interface ChatUploadConfig {
  enabled: boolean;
  maxFileMB: number;
  maxTotalMB: number;
  /** 0 = unlimited. */
  maxFiles: number;
  /** Lower-case, no dot. Empty = any extension not blocked. */
  allowedExtensions: string[];
  blockedExtensions: string[];
}

/** Page size of every history read — a full page back means there is probably more. */
export const CHAT_PAGE_SIZE = 50;

export const toChatMessage = (raw: unknown): ChatMessage => {
  const r = obj(raw);
  return {
    id: id(r),
    conversationId: str(r.conversationId),
    senderId: str(r.senderId),
    senderRole: str(r.senderRole, 'USER') || 'USER',
    text: str(r.text),
    attachments: rows<unknown>(r.attachments).map((x) => {
      const a = obj(x);
      return { name: str(a.name), mimeType: str(a.mimeType), dataUrl: str(a.dataUrl), sizeBytes: num(a.sizeBytes) };
    }),
    seenAt: strOrNull(r.seenAt),
    createdAt: str(r.createdAt),
  };
};

export const toChatThread = (raw: unknown): ChatThread => {
  const r = obj(raw);
  const c = r.conversation && typeof r.conversation === 'object' ? obj(r.conversation) : null;
  const p = r.counterpart && typeof r.counterpart === 'object' ? obj(r.counterpart) : null;
  return {
    conversation: c
      ? {
        id: id(c),
        userId: str(c.userId),
        managerId: strOrNull(c.managerId),
        unread: num(c.unread) ?? 0,
        status: strOrNull(c.status),
      }
      : null,
    counterpart: p
      ? {
        id: str(p.id) || id(p),
        name: str(p.name) || str(p.email),
        email: str(p.email),
        userUid: strOrNull(p.userUid),
        role: strOrNull(p.role),
        online: p.online === true,
      }
      : null,
    messages: rows<unknown>(r.messages).map(toChatMessage).filter((m) => m.id),
  };
};

export const toChatUploadConfig = (raw: unknown): ChatUploadConfig => {
  const r = obj(raw);
  return {
    enabled: r.enabled !== false,
    maxFileMB: num(r.maxFileMB) ?? 5,
    maxTotalMB: num(r.maxTotalMB) ?? 0,
    maxFiles: num(r.maxFiles) ?? 0,
    allowedExtensions: strList(r.allowedExtensions),
    blockedExtensions: strList(r.blockedExtensions),
  };
};

const byTime = (a: ChatMessage, b: ChatMessage): number =>
  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();

/**
 * The single funnel for new messages — the optimistic send, the socket
 * echo and the polling fallback all arrive here (HelpdeskChat.jsx
 * mergeIncoming). Deduped by id, so the same message reaching the screen
 * three ways appears once; time-ordered, so a late echo lands in place.
 *
 * `added` is what was genuinely new — the screen scrolls and marks seen on
 * it, and must not do either for a message it already showed.
 */
export const mergeChatMessages = (
  existing: readonly ChatMessage[],
  incoming: ChatMessage | readonly ChatMessage[],
): { messages: ChatMessage[]; added: ChatMessage[] } => {
  const list = (Array.isArray(incoming) ? incoming : [incoming] as ChatMessage[]).filter((m) => m && m.id);
  const seen = new Set(existing.map((m) => m.id));
  const added: ChatMessage[] = [];
  for (const m of list) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    added.push(m);
  }
  if (!added.length) return { messages: [...existing], added };
  return { messages: [...existing, ...added].sort(byTime), added };
};

/** Did anyone other than the trader write any of these? Drives mark-seen and the unread badge. */
export const hasInbound = (msgs: readonly ChatMessage[]): boolean =>
  msgs.some((m) => m.senderRole !== 'USER');

/** The manager has read everything: stamp the trader's unseen messages. */
export const markOutboundSeen = (msgs: readonly ChatMessage[], at: string): ChatMessage[] =>
  msgs.map((m) => (m.senderRole === 'USER' && !m.seenAt ? { ...m, seenAt: at } : m));

/** A `user:chat` socket frame, narrowed. Anything unrecognised is null. */
export type ChatSocketEvent =
  | { event: 'message'; message: ChatMessage }
  | { event: 'typing'; by: string }
  | { event: 'seen'; by: string }
  | { event: 'presence'; userId: string; online: boolean };

export const parseChatSocketEvent = (raw: unknown): ChatSocketEvent | null => {
  const r = obj(raw);
  switch (r.event) {
    case 'message': {
      const m = toChatMessage(r.message);
      return m.id ? { event: 'message', message: m } : null;
    }
    case 'typing':
      return { event: 'typing', by: str(r.by) };
    case 'seen':
      return { event: 'seen', by: str(r.by) };
    case 'presence':
      return { event: 'presence', userId: str(r.userId), online: r.online === true };
    default:
      return null;
  }
};

/* ── Attachment checks (before reading the file, as the web does) ──────── */

/** A picked file, as much of it as validation needs. */
export interface PickedFile {
  name: string;
  /** Bytes. */
  size: number;
  mimeType?: string | null;
}

export const extOf = (name: string): string => {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m?.[1] ?? '';
};

/** One file against the role's limits. Web wording, verbatim. */
export const validateChatFile = (file: PickedFile, cfg: ChatUploadConfig | null): string | null => {
  if (!cfg || !cfg.enabled) return 'File uploads are currently disabled.';
  const ext = extOf(file.name);
  if (cfg.blockedExtensions.includes(ext)) return `Executable / unsafe files (.${ext}) are not allowed.`;
  if (cfg.allowedExtensions.length && !cfg.allowedExtensions.includes(ext)) {
    return `.${ext || '?'} is not allowed. Allowed: ${cfg.allowedExtensions.join(', ')}.`;
  }
  if (file.size > (cfg.maxFileMB || 5) * 1024 * 1024) {
    return `"${file.name}" exceeds the ${cfg.maxFileMB} MB per-file limit.`;
  }
  return null;
};

/**
 * A batch of picks against what is already staged — the per-message count
 * and total-size caps as well as each file's own checks. Returns the files
 * that may be staged, and one message per rejection, in order.
 */
export const stageChatFiles = <F extends PickedFile>(
  picked: readonly F[],
  staged: readonly PickedFile[],
  cfg: ChatUploadConfig | null,
): { accepted: F[]; errors: string[] } => {
  if (!picked.length) return { accepted: [], errors: [] };
  if (!cfg || !cfg.enabled) return { accepted: [], errors: ['File uploads are currently disabled.'] };
  const maxFiles = cfg.maxFiles > 0 ? cfg.maxFiles : Infinity;
  const maxTotal = cfg.maxTotalMB > 0 ? cfg.maxTotalMB * 1024 * 1024 : Infinity;
  let count = staged.length;
  let bytes = staged.reduce((s, f) => s + (f.size || 0), 0);
  const accepted: F[] = [];
  const errors: string[] = [];
  for (const f of picked) {
    if (count >= maxFiles) {
      errors.push(`You can attach at most ${cfg.maxFiles} file(s) per message.`);
      break;
    }
    const err = validateChatFile(f, cfg);
    if (err) { errors.push(err); continue; }
    if (bytes + f.size > maxTotal) {
      errors.push(`Total attachments would exceed the ${cfg.maxTotalMB} MB limit.`);
      continue;
    }
    count += 1;
    bytes += f.size;
    accepted.push(f);
  }
  return { accepted, errors };
};

/** What the send endpoint takes. The field is `text` — not `message`, not `body`. */
export interface ChatSendBody {
  text: string;
  attachments?: { name: string; mimeType: string; dataUrl: string }[];
}

/** Web wording for the one send error it rewrites. */
export const chatSendErrorText = (code: string | undefined, fallback: string): string =>
  (code === 'NO_MANAGER' ? 'No manager is assigned to you yet.' : fallback);

/** A full page back means there is probably older history to load. */
export const hasMoreHistory = (page: readonly unknown[]): boolean => page.length >= CHAT_PAGE_SIZE;

/** An attachment staged in the composer, read into a data: URI before it can be sent. */
export interface ChatPendingFile {
  id: string;
  name: string;
  mimeType: string;
  /** '' until the file has been read. */
  dataUrl: string;
  sizeBytes: number;
  /** 0–100. */
  progress: number;
}

/**
 * The composer's send: everything staged must be read first; then the text
 * and the attachments go together. null = nothing to send. The error is the
 * web's wording.
 */
export const composeChatSend = (
  text: string,
  pending: readonly ChatPendingFile[],
): { body: ChatSendBody } | { error: string } | null => {
  if (pending.some((p) => !p.dataUrl)) return { error: 'Please wait — files are still being read…' };
  const attachments = pending.map((p) => ({ name: p.name, mimeType: p.mimeType, dataUrl: p.dataUrl }));
  const t = text.trim();
  if (!t && !attachments.length) return null;
  return { body: { text: t, ...(attachments.length ? { attachments } : {}) } };
};

/** Show an attachment inline as an image, or as a download link. */
export const isImageAttachment = (a: Pick<ChatAttachment, 'mimeType'>): boolean => a.mimeType.startsWith('image/');

/**
 * The day chip between messages: "Today", "Yesterday", else the date in the
 * device's locale, with the year only when it is not this year.
 */
export const chatDayLabel = (iso: string, now: Date = new Date()): string => {
  const d = new Date(iso);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const yest = new Date(today); yest.setDate(yest.getDate() - 1);
  if (day.getTime() === today.getTime()) return 'Today';
  if (day.getTime() === yest.getTime()) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
};

export type ChatThreadItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'message'; key: string; message: ChatMessage; mine: boolean };

/** The thread as rows: messages, with a day chip wherever the calendar day changes. */
export const chatThreadItems = (messages: readonly ChatMessage[], now: Date = new Date()): ChatThreadItem[] => {
  const out: ChatThreadItem[] = [];
  let lastDay: string | null = null;
  for (const m of messages) {
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) {
      out.push({ kind: 'day', key: `day-${day}`, label: chatDayLabel(m.createdAt, now) });
      lastDay = day;
    }
    out.push({ kind: 'message', key: m.id, message: m, mine: m.senderRole === 'USER' });
  }
  return out;
};

/* ══ Tickets (feedback) ═════════════════════════════════════════════════ */

/**
 * A ticket category. The server owns the list (models/Feedback.js
 * CATEGORIES — SUPPORT, BUG, TECHNICAL, ACCOUNT, PAYMENT, WITHDRAWAL,
 * DEPOSIT, TRADING, FEATURE, UX, OTHER) and serves it at
 * GET /user/feedback/categories; it refuses anything outside it.
 */
export type TicketCategory = 'BUG' | 'FEATURE' | 'UX' | 'SUPPORT' | 'OTHER' | (string & {});

/** One row of GET /user/feedback/categories — the Helpdesk's category picker. */
export interface TicketCategoryOption {
  value: string;
  label: string;
}

export const toTicketCategories = (raw: unknown): TicketCategoryOption[] =>
  rows<unknown>(raw)
    .map((x) => {
      const r = obj(x);
      const value = str(r.value);
      return { value, label: str(r.label) || value };
    })
    .filter((c) => c.value);

/**
 * Feedback.jsx CATEGORIES — the Feedback page's own five, with their hints
 * (all within the server's list). The Helpdesk reads the server's list
 * instead (feedbackApi.categories).
 */
export const TICKET_CATEGORIES: { value: TicketCategory; label: string; hint: string }[] = [
  { value: 'BUG', label: '🐛 Bug Report', hint: 'Something broken or crashing' },
  { value: 'FEATURE', label: '✨ Feature Request', hint: 'New capability or idea' },
  { value: 'UX', label: '🎨 UX / Design', hint: 'Layout, copy, friction points' },
  { value: 'SUPPORT', label: '🤝 Support', hint: 'Account or trade-specific help' },
  { value: 'OTHER', label: '💬 Other', hint: 'General comments' },
];

export type TicketStatus = 'OPEN' | 'TRIAGED' | 'IN_PROGRESS' | 'RESOLVED' | 'WONT_FIX' | (string & {});

export interface Ticket {
  id: string;
  category: TicketCategory | (string & {});
  subject: string;
  message: string;
  rating: number | null;
  /** A data: URI (image or PDF), when one was attached. */
  attachment: string | null;
  attachmentName: string | null;
  status: TicketStatus;
  /** The admin's reply to the user. The internal admin note is never sent. */
  adminReply: string | null;
  repliedAt: string | null;
  resolvedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** The screen the ticket was opened from — '/helpdesk' for Helpdesk tickets. */
  contextPage: string | null;
}

export const toTicket = (raw: unknown): Ticket => {
  const r = obj(raw);
  return {
    id: id(r),
    category: str(r.category, 'OTHER') || 'OTHER',
    subject: str(r.subject),
    message: str(r.message),
    rating: num(r.rating),
    attachment: strOrNull(r.attachment),
    attachmentName: strOrNull(r.attachmentName),
    status: str(r.status, 'OPEN') || 'OPEN',
    adminReply: strOrNull(r.adminReply),
    repliedAt: strOrNull(r.repliedAt),
    resolvedAt: strOrNull(r.resolvedAt),
    createdAt: strOrNull(r.createdAt),
    updatedAt: strOrNull(r.updatedAt),
    contextPage: strOrNull(obj(r.context).page),
  };
};

export type TicketTone = 'info' | 'primary' | 'warn' | 'bull' | 'bear';

/** The status chip's colour intent (STATUS_STYLES); an unknown status looks OPEN. */
export const ticketStatusTone = (status: string): TicketTone =>
  ({ OPEN: 'info', TRIAGED: 'primary', IN_PROGRESS: 'warn', RESOLVED: 'bull', WONT_FIX: 'bear' } as Record<string, TicketTone>)[status]
  ?? 'info';

/** `IN_PROGRESS` → `IN PROGRESS`, as the chip prints it. */
export const ticketStatusLabel = (status: string): string => status.replace('_', ' ');

/** The history row's meta line after the date: category, and stars when rated. */
export const ticketMeta = (t: Pick<Ticket, 'category' | 'rating'>): string =>
  `${t.category}${t.rating !== null && t.rating > 0 ? ` · ${'★'.repeat(Math.min(5, Math.round(t.rating)))}` : ''}`;

/** Server caps — the form counts down against the message one. */
export const TICKET_LIMITS = { subjectMax: 200, messageMax: 4000, attachmentMaxBytes: 3 * 1024 * 1024 } as const;

/**
 * Pre-submit checks, in each page's own words. The Helpdesk form also
 * requires a category to be CHOSEN — it used to hardcode 'SUPPORT', which
 * is what made the admin queue untriageable.
 */
export const validateTicket = (
  f: { category?: string; subject: string; message: string },
  form: 'feedback' | 'helpdesk',
): string | null => {
  if (form === 'helpdesk' && !f.category) return 'Please select a category.';
  if (f.subject.trim().length < 3) return 'Subject too short';
  if (f.message.trim().length < 10) {
    return form === 'helpdesk' ? 'Describe your issue (min 10 chars)' : 'Message too short (min 10 chars)';
  }
  return null;
};

/** Ticket attachments: an image or a PDF, at most 3 MB (Helpdesk.jsx onAttachFile). */
export const validateTicketAttachment = (file: PickedFile): string | null => {
  if (!/^(image\/|application\/pdf)/.test(String(file.mimeType ?? ''))) return 'Attach an image or a PDF';
  if (file.size > TICKET_LIMITS.attachmentMaxBytes) return 'File too large — max 3 MB';
  return null;
};

/**
 * A `user:tickets` push (an admin reply or status change) folded into the
 * list: merged into the matching row, or prepended when new and `accept`
 * lets it in. "My Tickets" admits every ticket, whatever its category
 * (Helpdesk.jsx: a ticket must never vanish for not being SUPPORT).
 */
export const applyTicketPush = (
  list: readonly Ticket[],
  pushed: unknown,
  accept: (t: Ticket) => boolean = () => true,
): Ticket[] => {
  const raw = obj(obj(pushed).ticket);
  const t = toTicket(raw);
  if (!t.id) return [...list];
  const i = list.findIndex((x) => x.id === t.id);
  if (i === -1) return accept(t) ? [t, ...list] : [...list];
  const next = list.slice();
  const prev = next[i] as Ticket;
  // Only the fields the push actually carried overwrite — a partial push
  // must not blank a subject it did not mention.
  const patch = Object.fromEntries(
    Object.keys(raw)
      .map((k) => (k === '_id' ? 'id' : k))
      .filter((k) => k in t)
      .map((k) => [k, t[k as keyof Ticket]]),
  ) as Partial<Ticket>;
  next[i] = { ...prev, ...patch };
  return next;
};
