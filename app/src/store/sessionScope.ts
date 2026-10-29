import { resetGlobalAlerts } from '@/api/alerts.api';
import { resetAccountMetrics } from '@/api/trading.api';
import { resetWatchlists } from '@/api/watchlist.api';
import { useAuthStore } from '@/store/auth';

/**
 * Per-user caches that outlive a screen, dropped when the signed-in PERSON
 * changes.
 *
 * The web never needed this: sign-out was `window.location = '/login'` and
 * "Return to Admin" a navigation to /admin/, and both page loads threw
 * every module-level store away. Here the JS context survives, so without
 * this the next user — or the admin leaving "View As User" — would see the
 * previous one's watchlists, account figures and pending alert popups until
 * each happened to refetch.
 *
 * Keyed on the user id, not the auth status, for the same reason as
 * store/selectedAccount: a refreshUser() that hands back the same person
 * must not wipe anything, and a switch between two signed-in people never
 * passes through 'unauthenticated'.
 *
 * Imported once, for its side effect, by App.tsx. Stores with their own
 * lifecycle (selectedAccount) follow the user themselves.
 */

/** Every reset, in one place, so a new per-user store has one line to add. */
export const resetUserScopedState = (): void => {
  resetWatchlists();
  resetGlobalAlerts();
  resetAccountMetrics();
};

useAuthStore.subscribe((state, prev) => {
  if ((state.user?.id ?? null) === (prev.user?.id ?? null)) return;
  resetUserScopedState();
});
