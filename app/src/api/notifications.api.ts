import type { AxiosResponse } from 'axios';

import { api } from '@/api/client';
import { userApi } from '@/api/user.api';
import { rows } from '@/types/api';
import {
  MAX_NOTIFICATIONS,
  serverIdOf,
  toServerNotification,
  type PushPlatform,
  type ServerNotification,
} from '@/types/notifications';

/**
 * Notifications — the bell's server half (`/api/user/notifications`) and
 * push-token registration (`/api/user/push-tokens`).
 *
 * The push-token routes exist on the backend and the web never calls them;
 * a phone must, or admin sends and system events reach the bell only while
 * the app is open.
 */

const payload = (res: AxiosResponse): unknown => {
  const b = res.data as unknown;
  if (b && typeof b === 'object' && 'success' in b && 'data' in b) return (b as { data: unknown }).data;
  return b;
};

const OBJECT_ID = /^[0-9a-f]{24}$/i;

export const notificationsApi = {
  /** The caller's notifications, newest first (the server caps at 100). */
  list: async (limit = MAX_NOTIFICATIONS): Promise<ServerNotification[]> =>
    rows<unknown>(payload(await api.get('/user/notifications', { params: { limit } })))
      .map(toServerNotification)
      .filter((n) => n.id),

  /**
   * Mark specific notifications read. Accepts bell ids: server entries
   * (`srv:<id>`) are sent, local ones are skipped — they have no server row.
   * A bare ObjectId is sent as it is.
   */
  markRead: async (ids: readonly string[]): Promise<number> => {
    const serverIds = ids
      .map((x) => serverIdOf(x) ?? (OBJECT_ID.test(x) ? x : null))
      .filter((x): x is string => !!x);
    if (!serverIds.length) return 0;
    const d = payload(await api.post('/user/notifications/read', { ids: serverIds })) as { updated?: number } | null;
    return Number(d?.updated ?? 0);
  },

  /** Mark every notification read — the bell's "Mark all read", and "Clear all". */
  markAllRead: async (): Promise<number> => {
    const d = payload(await api.post('/user/notifications/read', { all: true })) as { updated?: number } | null;
    return Number(d?.updated ?? 0);
  },

  /**
   * Push registration is owned by api/user, which remembers the token so
   * sign-out can remove it. These delegate rather than post on their own: a
   * registration user.api never saw would survive sign-out, and whoever
   * holds the phone next would keep getting the last user's margin calls.
   */
  registerPushToken: (token: string, platform: PushPlatform): Promise<void> =>
    userApi.registerPushToken(token, platform),

  unregisterPushToken: (token: string): Promise<void> =>
    userApi.unregisterPushToken(token),
};

export type NotificationsApi = typeof notificationsApi;
