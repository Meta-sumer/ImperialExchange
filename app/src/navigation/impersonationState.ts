import { create } from 'zustand';

import {
  beginImpersonation,
  getImpersonationInfo,
  isImpersonating,
  parseImpersonationLink,
  type ImpersonationInfo,
} from '@/services/impersonation';
import { useAuthStore } from '@/store/auth';
import { wsClient } from '@/websocket/ws';

/**
 * A render-able mirror of services/impersonation.
 *
 * That module is plain state, read synchronously by the HTTP interceptor —
 * right for the request path, but nothing re-renders when it changes. The
 * web gets away with that because a "View As User" session starts with a
 * page load. Here it starts from a deep link into a running app, so the
 * banner needs a store to follow.
 *
 * The two writers are the deep-link handler (start) and the banner (end);
 * both go through this file so the mirror cannot drift from the source.
 */

interface ImpersonationView {
  active: boolean;
  info: ImpersonationInfo | null;
}

export const useImpersonation = create<ImpersonationView>(() => ({
  active: isImpersonating(),
  info: getImpersonationInfo(),
}));

const sync = (): void => {
  useImpersonation.setState({ active: isImpersonating(), info: getImpersonationInfo() });
};

/**
 * Start a read-only session from an admin link. The caller has already
 * checked the URL is one (webPaths.isImpersonationUrl) — see the note there
 * on why the parser must not see a password-reset link.
 */
export const startImpersonationFromLink = (url: string): boolean => {
  const parsed = parseImpersonationLink(url);
  if (!parsed) return false;
  beginImpersonation(parsed.token, parsed.info);
  sync();
  // The socket is authenticated as whoever held the app before; the
  // session now belongs to the viewed user. bootstrap() reconnects it with
  // the impersonation token after /auth/me resolves the target.
  wsClient.disconnect();
  void useAuthStore.getState().bootstrap();
  return true;
};

/** "Return to Admin" — store/auth closes and audits the session. */
export const endImpersonation = async (): Promise<void> => {
  try {
    await useAuthStore.getState().exitImpersonation();
  } finally {
    sync();
  }
};
