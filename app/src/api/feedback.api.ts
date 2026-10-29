import type { AxiosResponse } from 'axios';
import Constants from 'expo-constants';

import { api } from '@/api/client';
import { rows } from '@/types/api';
import {
  toTicket,
  toTicketCategories,
  type Ticket,
  type TicketCategory,
  type TicketCategoryOption,
} from '@/types/helpdesk';

/**
 * Support tickets / feedback — `/api/user/feedback`.
 *
 * One endpoint behind two screens: Feedback (category + rating) and the
 * Helpdesk's "Open a ticket" (a category from the server's list + an
 * optional image/PDF). Both list the same history, every ticket. Live
 * updates arrive on `user:tickets` and are folded in with `applyTicketPush`.
 */

const payload = (res: AxiosResponse): unknown => {
  const b = res.data as unknown;
  if (b && typeof b === 'object' && 'success' in b && 'data' in b) return (b as { data: unknown }).data;
  return b;
};

export interface TicketSubmit {
  category: TicketCategory;
  subject: string;
  message: string;
  /** 1–5; omitted/null = no rating. */
  rating?: number | null;
  /** The screen it was opened from — the web sends its pathname. */
  page?: string;
  /** A base64 data: URI (PNG/JPG/WEBP/GIF or PDF, ≤ 3 MB). */
  attachment?: string | null;
  attachmentName?: string | null;
}

/**
 * The app version stamped on each ticket — the web's VITE_APP_VERSION.
 * Support needs it to tell a fixed bug from one reported on an old build.
 */
const appVersion = (): string => Constants.expoConfig?.version ?? 'dev';

export const feedbackApi = {
  /**
   * GET /user/feedback/categories — the server's category list (value +
   * label), which the Helpdesk offers instead of a list of its own.
   */
  categories: async (): Promise<TicketCategoryOption[]> =>
    toTicketCategories(payload(await api.get('/user/feedback/categories'))),

  /** The caller's last 50 tickets, newest first. */
  list: async (): Promise<Ticket[]> =>
    rows<unknown>(payload(await api.get('/user/feedback'))).map(toTicket).filter((t) => t.id),

  /** Opens a ticket. The server answers only `{ id, status }`; re-list to show it. */
  submit: async (t: TicketSubmit): Promise<{ id: string; status: string }> => {
    const body: Record<string, unknown> = {
      category: t.category,
      subject: t.subject,
      message: t.message,
      rating: t.rating || null,
      context: { page: t.page, appVersion: appVersion() },
    };
    if (t.attachment) {
      body.attachment = t.attachment;
      body.attachmentName = t.attachmentName ?? 'attachment';
    }
    const d = payload(await api.post('/user/feedback', body)) as Record<string, unknown> | null;
    return { id: String(d?.id ?? d?._id ?? ''), status: String(d?.status ?? 'OPEN') };
  },
};

export type FeedbackApi = typeof feedbackApi;
