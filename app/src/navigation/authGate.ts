import { create } from 'zustand';

import { useAuthStore, type AuthStatus } from '@/store/auth';

import { accessOf } from './types';
import type { AnyRoute } from './webPaths';

/**
 * Which half of the app is mounted, and where a signed-out deep link was
 * going.
 *
 * ── WHY "LAST RESOLVED" AND NOT status ────────────────────────────────
 * store/auth sets status 'loading' whenever bootstrap() runs — at launch,
 * and again when a "View As User" link arrives or ends. Swapping the
 * navigator to a splash on every 'loading' would unmount whatever screen the
 * user is on and reset its state. So the navigator follows the last
 * RESOLVED status: null until the first bootstrap settles (the boot splash),
 * then 'authenticated' or 'unauthenticated', changing only when one of those
 * is actually reached.
 * ──────────────────────────────────────────────────────────────────────
 */

export type ResolvedAuth = 'authenticated' | 'unauthenticated';

interface GateState {
  resolved: ResolvedAuth | null;
  /** Ever signed in during this run — decides Login vs Landing after sign-out. */
  hadSession: boolean;
  /**
   * The web's `<Navigate to="/login" state={{ from: location }} />`: a
   * protected link opened while signed out, taken after sign-in.
   */
  pending: AnyRoute | null;
  /**
   * Whose session the signed-in screens were built for — the navigator keys
   * them by it. On the web a change of identity is always a page load (a
   * "View As User" tab, "Return to Admin"), so no page ever shows one
   * user's data under another's session. Here the identity can change under
   * a running navigator — an impersonation link, or leaving one and falling
   * back to this device's own sign-in — and without the key a mounted
   * screen would keep the previous user's figures on screen.
   */
  identity: string | null;
}

/**
 * The identity to key by. A null user — mid re-bootstrap, or the moment
 * "Return to Admin" drops the viewed user — keeps the last one, so the
 * screens are rebuilt once, when the NEXT user is known, not twice.
 */
export const nextIdentity = (prev: string | null, userId: string | null | undefined): string | null =>
  (userId ? userId : prev);

export const useAuthGate = create<GateState>(() => ({
  resolved: null,
  hadSession: false,
  pending: null,
  identity: nextIdentity(null, useAuthStore.getState().user?.id),
}));

/** Only a terminal status moves the gate. Exported for tests. */
export const resolveGate = (prev: Pick<GateState, 'resolved'>, status: AuthStatus): Partial<GateState> | null => {
  if (status !== 'authenticated' && status !== 'unauthenticated') return null;
  if (prev.resolved === status) return null;
  return status === 'authenticated'
    ? { resolved: status, hadSession: true }
    // Signing out forgets where a previous user was headed.
    : { resolved: status, pending: null };
};

const follow = (status: AuthStatus): void => {
  const patch = resolveGate(useAuthGate.getState(), status);
  if (patch) useAuthGate.setState(patch);
};

const track = (userId: string | null | undefined): void => {
  const identity = nextIdentity(useAuthGate.getState().identity, userId);
  if (identity !== useAuthGate.getState().identity) useAuthGate.setState({ identity });
};

follow(useAuthStore.getState().status);
useAuthStore.subscribe((s, prev) => {
  if (s.user?.id !== prev.user?.id) track(s.user?.id);
  if (s.status !== prev.status) follow(s.status);
});

export const isAuthed = (): boolean => useAuthGate.getState().resolved === 'authenticated';

export const setPendingRoute = (route: AnyRoute | null): void => {
  useAuthGate.setState({ pending: route });
};

/** Take the pending route, once. */
export const takePendingRoute = (): AnyRoute | null => {
  const { pending } = useAuthGate.getState();
  if (pending) useAuthGate.setState({ pending: null });
  return pending;
};

/**
 * Where a route actually goes for this auth state, and what to remember:
 *   protected + signed out → Login, remembering the route (ProtectedRoute)
 *   visitor-only + signed in → Explore (RootRoute's `<Navigate to="/explore">`)
 *   anything else          → itself
 */
export const routeForAuth = (route: AnyRoute, authed: boolean): { target: AnyRoute; pending: AnyRoute | null } => {
  const access = accessOf(route.name);
  if (access === 'app' && !authed) return { target: { name: 'Login' }, pending: route };
  if (access === 'guest' && authed) return { target: { name: 'Explore' }, pending: null };
  return { target: route, pending: null };
};

/**
 * The stack to open a deep link into: the home screen underneath, so the
 * back button leads somewhere instead of closing the app.
 */
export const stackFor = (target: AnyRoute, authed: boolean): { index: number; routes: AnyRoute[] } => {
  const home: AnyRoute = authed ? { name: 'Explore' } : { name: 'Landing' };
  const routes = target.name === home.name ? [target] : [home, target];
  return { index: routes.length - 1, routes };
};
