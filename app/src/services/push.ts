import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Linking, Platform } from 'react-native';
import { create } from 'zustand';

import { notificationsApi } from '@/api/notifications.api';
import { userApi } from '@/api/user.api';
import { navigateToPath } from '@/navigation/linking';
import { isImpersonating } from '@/services/impersonation';
import { useAuthStore } from '@/store/auth';
import type { PushPlatform } from '@/types/notifications';

/**
 * Push registration — the phone's half of `/api/user/push-tokens`
 * (routes/user.js), which the web never calls.
 *
 * What the backend supports, and so what this does:
 *   • POST /user/push-tokens `{ token, platform }` (idempotent: the server
 *     pulls the token and re-adds it) and DELETE /user/push-tokens/:token.
 *     Both go through api/user (notificationsApi delegates to it), which
 *     remembers the token so sign-out removes it (store/auth logout).
 *   • services/pushService.js sends through the LEGACY FCM endpoint with the
 *     token as FCM's `to`. So the token registered is the NATIVE device
 *     token (`getDevicePushTokenAsync` — the FCM registration token on
 *     Android), not an `ExponentPushToken[…]`, which FCM would refuse.
 *
 * Asking is polite: nothing is prompted at launch. The bell shows a short
 * explanation with "Turn on" / "Not now" while the OS has not been asked;
 * only "Turn on" raises the system prompt. "Not now" is remembered per
 * device. A refusal is respected — the preferences pane then offers the
 * system Settings, and nothing asks again. With permission already given,
 * the token is registered silently on sign-in and re-registered when the OS
 * rotates it.
 *
 * Never registered: while viewing as another user (read-only "View As User"
 * — the admin's phone must not receive that user's alerts), and in Expo Go
 * on Android, which has no remote-notification support since SDK 53.
 *
 * expo-notifications is loaded lazily, on first use, so a screen or test
 * that never touches push never loads its native module.
 */

type NotificationsModule = typeof import('expo-notifications');

let mod: NotificationsModule | null | undefined;

/** The module, or null where push cannot work. */
const notifications = (): NotificationsModule | null => {
  if (mod !== undefined) return mod;
  if (!pushSupported()) { mod = null; return mod; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('expo-notifications') as NotificationsModule;
  } catch {
    mod = null;
  }
  return mod;
};

/** Expo Go on Android dropped remote notifications in SDK 53; the web has no push here. */
export const pushSupported = (): boolean => {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
  const expoGo = Constants.executionEnvironment === 'storeClient';
  return !(expoGo && Platform.OS === 'android');
};

/**
 * What the bell shows:
 *   unknown       not checked yet
 *   unavailable   this build / device cannot receive push
 *   undetermined  the OS has not asked yet — the soft prompt may show
 *   denied        refused (and the OS will not ask again) — Settings only
 *   granted       allowed; `registered` says whether the server has the token
 */
export type PushStatus = 'unknown' | 'unavailable' | 'undetermined' | 'denied' | 'granted';

export interface PushState {
  status: PushStatus;
  /** The OS would still show its prompt (Android can re-ask once after a refusal). */
  canAskAgain: boolean;
  /** The server holds this device's token for the signed-in user. */
  registered: boolean;
  /** "Not now" was chosen on this device. */
  promptDismissed: boolean;
  /** A permission request or registration is in flight. */
  busy: boolean;
}

export const usePushStore = create<PushState>(() => ({
  status: 'unknown',
  canAskAgain: true,
  registered: false,
  promptDismissed: false,
  busy: false,
}));

/** Device-local: the soft prompt's "Not now". Not a secret, so AsyncStorage. */
export const PUSH_PROMPT_DISMISSED_KEY = 'tradepro:push:prompt-dismissed:v1';

/** The Android channel notifications arrive on (Android 8+ needs one; 13+ prompts only once it exists). */
export const ANDROID_CHANNEL_ID = 'default';

export const pushPlatform = (): PushPlatform =>
  (Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'unknown');

/** Show the bell's soft prompt? Only while the OS could still be asked and it was not waved away. */
export const shouldOfferPushPrompt = (s: Pick<PushState, 'status' | 'canAskAgain' | 'promptDismissed'>): boolean =>
  !s.promptDismissed && s.canAskAgain && s.status === 'undetermined';

interface PermissionLike {
  granted?: boolean;
  status?: string;
  canAskAgain?: boolean;
  ios?: { status?: number } | null;
}

/**
 * The OS answer → our status. iOS "provisional" (quiet delivery) counts as
 * allowed, as Expo's docs advise; a refusal the OS will re-ask about stays
 * "undetermined" so the soft prompt can still offer it.
 */
export const statusFromPermission = (p: PermissionLike | null | undefined): { status: PushStatus; canAskAgain: boolean } => {
  if (!p) return { status: 'unavailable', canAskAgain: false };
  const canAskAgain = p.canAskAgain !== false;
  // IosAuthorizationStatus.PROVISIONAL = 3
  if (p.granted || p.status === 'granted' || p.ios?.status === 3) return { status: 'granted', canAskAgain };
  if (p.status === 'denied' && !canAskAgain) return { status: 'denied', canAskAgain: false };
  return { status: 'undetermined', canAskAgain };
};

const signedInUserId = (): string | null => {
  const s = useAuthStore.getState();
  return s.status === 'authenticated' && s.user ? s.user.id : null;
};

/** Re-read the OS permission (and the stored "Not now"). Never throws. */
export const refreshPushStatus = async (): Promise<PushStatus> => {
  let promptDismissed = usePushStore.getState().promptDismissed;
  try { promptDismissed = (await AsyncStorage.getItem(PUSH_PROMPT_DISMISSED_KEY)) === '1'; } catch { /* keep */ }
  const N = notifications();
  if (!N) {
    usePushStore.setState({ status: 'unavailable', canAskAgain: false, promptDismissed });
    return 'unavailable';
  }
  try {
    const next = statusFromPermission(await N.getPermissionsAsync());
    usePushStore.setState({ ...next, promptDismissed });
    return next.status;
  } catch {
    usePushStore.setState({ status: 'unavailable', canAskAgain: false, promptDismissed });
    return 'unavailable';
  }
};

const ensureAndroidChannel = async (N: NotificationsModule): Promise<void> => {
  if (Platform.OS !== 'android') return;
  try {
    await N.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
      name: 'Notifications',
      importance: N.AndroidImportance.DEFAULT,
    });
  } catch { /* the OS default channel still delivers */ }
};

/** Serialises registrations, so a rotation during a sign-in cannot interleave. */
let registering: Promise<boolean> | null = null;

/**
 * Hand this device's token to the server, for the signed-in user. Only
 * with permission, never while viewing as someone else. True when the server
 * now has it.
 */
export const registerPushToken = (tokenOverride?: string): Promise<boolean> => {
  const run = async (): Promise<boolean> => {
    const N = notifications();
    if (!N || !signedInUserId() || isImpersonating()) return false;
    if (usePushStore.getState().status !== 'granted') return false;
    try {
      await ensureAndroidChannel(N);
      const token = tokenOverride ?? String((await N.getDevicePushTokenAsync()).data ?? '');
      if (!token) return false;
      const previous = userApi.currentPushToken();
      if (previous === token && usePushStore.getState().registered) return true;
      // A rotated token replaces the old one; the old one can no longer deliver.
      if (previous && previous !== token) {
        try { await notificationsApi.unregisterPushToken(previous); } catch { /* best-effort */ }
      }
      await notificationsApi.registerPushToken(token, pushPlatform());
      usePushStore.setState({ registered: true });
      return true;
    } catch {
      usePushStore.setState({ registered: false });
      return false;
    }
  };
  const next = (registering ?? Promise.resolve(false)).then(run, run);
  registering = next.finally(() => { if (registering === next) registering = null; });
  return next;
};

/**
 * The soft prompt's "Turn on": the OS prompt, then registration. Resolves
 * to the resulting status. A refusal is final here — no toast, no nag.
 */
export const requestPushPermission = async (): Promise<PushStatus> => {
  const N = notifications();
  if (!N) {
    usePushStore.setState({ status: 'unavailable', canAskAgain: false });
    return 'unavailable';
  }
  usePushStore.setState({ busy: true });
  try {
    await ensureAndroidChannel(N);
    const next = statusFromPermission(await N.requestPermissionsAsync());
    // Once asked, a refusal is a refusal: do not offer the soft prompt again.
    const settled = next.status === 'undetermined' ? { status: 'denied' as const, canAskAgain: next.canAskAgain } : next;
    usePushStore.setState(settled);
    if (settled.status === 'granted') await registerPushToken();
    return settled.status;
  } catch {
    usePushStore.setState({ status: 'unavailable', canAskAgain: false });
    return 'unavailable';
  } finally {
    usePushStore.setState({ busy: false });
  }
};

/** The soft prompt's "Not now" — remembered on this device. */
export const dismissPushPrompt = async (): Promise<void> => {
  usePushStore.setState({ promptDismissed: true });
  try { await AsyncStorage.setItem(PUSH_PROMPT_DISMISSED_KEY, '1'); } catch { /* in-memory still hides it */ }
};

/** A refusal can only be undone in the system Settings. */
export const openPushSettings = (): Promise<void> => Linking.openSettings().catch(() => undefined);

/** A push tapped: open its `link` (a web path, as the bell's links are). */
const openFromResponse = (data: unknown): void => {
  const link = data && typeof data === 'object' ? (data as Record<string, unknown>).link : null;
  if (typeof link === 'string' && link.trim()) navigateToPath(link.trim());
};

/**
 * Start push for the signed-in session: check permission, register silently
 * when allowed, follow token rotation, and open a tapped push's link.
 * Returns the stop. Called by the bell engine, once per signed-in session.
 */
export const startPush = (): (() => void) => {
  let stopped = false;
  const subs: { remove: () => void }[] = [];
  void (async () => {
    const status = await refreshPushStatus();
    if (stopped) return;
    const N = notifications();
    if (!N) return;
    try {
      subs.push(N.addPushTokenListener((t) => {
        if (!stopped && typeof t.data === 'string') void registerPushToken(t.data);
      }));
      subs.push(N.addNotificationResponseReceivedListener((r) => {
        openFromResponse(r.notification.request.content.data);
      }));
    } catch { /* listeners are optional */ }
    if (status === 'granted') await registerPushToken();
  })();
  return () => {
    stopped = true;
    for (const s of subs) { try { s.remove(); } catch { /* already gone */ } }
    usePushStore.setState({ registered: false, busy: false });
  };
};

/** Tests only: forget the loaded module (so a test can swap mocks). */
export const __resetPushForTests = (): void => {
  mod = undefined;
  registering = null;
  usePushStore.setState({ status: 'unknown', canAskAgain: true, registered: false, promptDismissed: false, busy: false });
};
