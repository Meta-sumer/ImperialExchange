import type { AxiosResponse } from 'axios';

import { api } from '@/api/client';
import { rows } from '@/types/api';
import {
  CHAT_PAGE_SIZE,
  toChatMessage,
  toChatThread,
  toChatUploadConfig,
  type ChatMessage,
  type ChatSendBody,
  type ChatThread,
  type ChatUploadConfig,
} from '@/types/helpdesk';

/**
 * Helpdesk live chat — the trader's side of /api/chat (routes/chat.js).
 *
 * There is no manager picker: the server resolves the trader's ASSIGNED
 * manager from the user record and returns `counterpart: null` until one
 * exists. Realtime rides `user:chat` on the socket; the screen also polls
 * `messagesAfter` every 5s so a missed echo still arrives, and every path
 * funnels through `mergeChatMessages` so nothing shows twice.
 *
 * Not here: `GET /chat/conversations` and `POST /chat/conversations/open`,
 * which are the MANAGER's inbox (403 for a trader).
 */

const payload = (res: AxiosResponse): unknown => {
  const b = res.data as unknown;
  if (b && typeof b === 'object' && 'success' in b && 'data' in b) return (b as { data: unknown }).data;
  return b;
};

const messageList = (body: unknown): ChatMessage[] =>
  rows<unknown>(body).map(toChatMessage).filter((m) => m.id);

export const helpdeskApi = {
  /** The effective attachment limits for the caller's role. */
  uploadConfig: async (): Promise<ChatUploadConfig> =>
    toChatUploadConfig(payload(await api.get('/chat/upload-config'))),

  /** The caller's conversation (created on first read), the manager, and the latest page. */
  conversation: async (): Promise<ChatThread> =>
    toChatThread(payload(await api.get('/chat/conversation'))),

  /**
   * The page BEFORE the oldest message held — "Load older messages". Oldest
   * first. The anchor is that message's `createdAt`, NOT its id: the server
   * filters `createdAt < before` (chatService.history), and an id there
   * parses as an invalid date and matches nothing. Fewer than a full page
   * back means the start of the thread has been reached.
   */
  messagesBefore: async (
    conversationId: string,
    oldest: Pick<ChatMessage, 'createdAt'>,
    limit = CHAT_PAGE_SIZE,
  ): Promise<ChatMessage[]> =>
    messageList(payload(await api.get(`/chat/conversations/${conversationId}/messages`, {
      params: { before: oldest.createdAt, limit },
    }))),

  /**
   * Only what arrived AFTER the newest message held — the poll. Cheap on
   * purpose: it does not re-download the thread and its inline attachments.
   * Anchored on `createdAt` (`> after`); with nothing held, the latest page.
   */
  messagesAfter: async (conversationId: string, newest: Pick<ChatMessage, 'createdAt'> | null): Promise<ChatMessage[]> =>
    messageList(payload(await api.get(`/chat/conversations/${conversationId}/messages`, {
      params: newest?.createdAt ? { after: newest.createdAt } : { limit: CHAT_PAGE_SIZE },
    }))),

  /**
   * Send. The body field is `text` (chatController.postMessage reads
   * `req.body.text`); anything else arrives as an empty message. The reply
   * is the stored message, which the screen merges immediately.
   * A NO_MANAGER error means nobody is assigned yet.
   */
  send: async (conversationId: string, body: ChatSendBody): Promise<ChatMessage> =>
    toChatMessage(payload(await api.post(`/chat/conversations/${conversationId}/messages`, {
      text: body.text,
      ...(body.attachments && body.attachments.length ? { attachments: body.attachments } : {}),
    }))),

  /** Mark inbound messages read. Fire-and-forget on the web. */
  markSeen: async (conversationId: string): Promise<void> => {
    await api.post(`/chat/conversations/${conversationId}/seen`);
  },

  /** Ephemeral "typing…" signal. The web sends at most one per 1.5s. */
  typing: async (conversationId: string): Promise<void> => {
    await api.post(`/chat/conversations/${conversationId}/typing`);
  },
};

/** The web's throttle on typing signals. */
export const TYPING_THROTTLE_MS = 1500;
/** How long "typing…" stays up after the last signal. */
export const TYPING_DISPLAY_MS = 3000;
/** The polling fallback interval. */
export const CHAT_POLL_MS = 5000;

export type HelpdeskApi = typeof helpdeskApi;
