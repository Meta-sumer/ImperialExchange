import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

import { accountApi } from '@/api/account.api';
import { errorMessage } from '@/api/client';
import { useAuthStore } from '@/store/auth';
import type { TradingAccount } from '@/types/trading';
import type { UserAccount } from '@/types/user';
import { wsClient } from '@/websocket/ws';

/**
 * The user's ACTIVE trading account, ported from
 * client/src/store/selectedAccount.js plus the list-and-default logic the web
 * keeps in Layout.jsx:238-260.
 *
 * On the web the store held only an id and Layout fetched the list beside
 * it. Here the store owns both, because every screen that shows "the"
 * account — the header switcher, Trade, Explore, the order form — needs the
 * two to agree, and a second copy of the list is how they stop agreeing.
 *
 * ── WHAT IS KEPT ──────────────────────────────────────────────────────
 * - No saved choice → the first account (Layout.jsx:249).
 * - A saved choice that no longer exists → the first account (:251).
 * - An empty list leaves the choice alone — a list that comes back empty
 *   for a moment must not forget what the trader picked.
 * - The list reloads on every `user:wallet` event (:257) — a new account
 *   announces itself there.
 *
 * ── WHAT IS DIFFERENT, AND WHY ────────────────────────────────────────
 * 1. The saved choice is keyed PER USER. The web keeps one key per browser,
 *    so on a shared machine the next person to sign in inherited the last
 *    one's pick, snapped back only because the id was not in their list.
 *    A phone changes hands less often, but it does change hands.
 * 2. It also reloads on `user:accounts`, which the server publishes when a
 *    plan cap suspends an account and the web never subscribes to — so a
 *    web user keeps trading-screen state for an account that can no longer
 *    open a position until they reload.
 * 3. Sign-out clears the list and the choice from MEMORY (not from storage:
 *    signing back in should land on the same account, as it does on the web).
 * ──────────────────────────────────────────────────────────────────────
 */

const STORAGE_PREFIX = 'tradepro:selected-account';

export const selectedAccountStorageKey = (userId: string): string => `${STORAGE_PREFIX}:${userId}`;

/**
 * Which account the store settles on, given the list and the current pick.
 * Layout.jsx:249-253, as a pure function so it can be pinned by a test.
 */
export const resolveSelection = (
  accounts: ReadonlyArray<Pick<TradingAccount, 'id'>>,
  current: string | null,
): string | null => {
  const first = accounts[0];
  if (!first) return current;
  if (current && accounts.some((a) => a.id === current)) return current;
  return first.id;
};

const readSaved = async (userId: string): Promise<string | null> => {
  try {
    return (await AsyncStorage.getItem(selectedAccountStorageKey(userId))) || null;
  } catch {
    return null;
  }
};

const writeSaved = async (userId: string, accountId: string | null): Promise<void> => {
  try {
    const key = selectedAccountStorageKey(userId);
    if (accountId) await AsyncStorage.setItem(key, accountId);
    else await AsyncStorage.removeItem(key);
  } catch {
    // Storage full or unavailable: the choice holds for this session and is
    // simply not remembered, which is the web's behaviour in private mode.
  }
};

interface SelectedAccountState {
  /** The user's ACTIVE accounts (the server filters `isActive`), server order. */
  accounts: UserAccount[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  /** Whose accounts these are. A load for someone else never lands here. */
  userId: string | null;

  /** Fetch the list and settle the selection. Safe to call at any time. */
  load(): Promise<void>;
  /** The trader chose an account. Remembered for the next launch. */
  select(id: string): void;
  /** Forget everything in memory. Called on sign-out. */
  reset(): void;
}

/**
 * Bumped by every load and every reset. A response whose number is no
 * longer current belongs to a request that has been overtaken — by a newer
 * load, or by a sign-out — and is dropped.
 */
let generation = 0;

const INITIAL = {
  accounts: [] as UserAccount[],
  selectedId: null as string | null,
  loading: false,
  error: null as string | null,
  userId: null as string | null,
};

export const useSelectedAccountStore = create<SelectedAccountState>()((set, get) => ({
  ...INITIAL,

  load: async () => {
    const userId = useAuthStore.getState().user?.id ?? null;
    if (!userId) return;

    const mine = ++generation;
    if (get().userId !== userId) set({ ...INITIAL, userId });
    set({ loading: true, error: null });

    try {
      // The saved pick is read alongside the list the first time, so the
      // first render after sign-in lands on the account the trader left on.
      const [list, saved] = await Promise.all([
        accountApi.list(),
        get().selectedId === null ? readSaved(userId) : Promise.resolve(null),
      ]);
      if (mine !== generation || get().userId !== userId) return;

      // Read AFTER the await: a select() made while the list was in flight
      // is the trader's latest word and wins over the stored one.
      const current = get().selectedId ?? saved;
      const next = resolveSelection(list, current);
      set({ accounts: list, selectedId: next, loading: false, error: null });
      if (next !== saved) void writeSaved(userId, next);
    } catch (err) {
      if (mine !== generation) return;
      // Keep the list we had — Layout.jsx's "keep prior".
      set({ loading: false, error: errorMessage(err) });
    }
  },

  select: (id) => {
    if (!id) return;
    set({ selectedId: id });
    const { userId } = get();
    if (userId) void writeSaved(userId, id);
  },

  reset: () => {
    generation += 1;
    set({ ...INITIAL });
  },
}));

/**
 * The selected account, or the first one while nothing is selected —
 * Trade.jsx:653 `accounts.find(…) || accounts[0]`. Null only with no accounts.
 */
export const selectSelectedAccount = (s: Pick<SelectedAccountState, 'accounts' | 'selectedId'>): UserAccount | null =>
  s.accounts.find((a) => a.id === s.selectedId) ?? s.accounts[0] ?? null;

/* ── Session lifecycle ────────────────────────────────────────────────
 * Follows the signed-in USER, not the auth status: a refreshUser() that
 * hands back the same person must not reset anything, and a different
 * person (sign-out then sign-in, or leaving "View As User") must never see
 * the previous one's list for a frame.
 *
 * The socket subscriptions are taken again on every sign-in because
 * wsClient.disconnect() — sign-out — drops them all. Taken before the
 * connect, they are sent when the socket opens.
 */

const RELOAD_DEBOUNCE_MS = 500;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribers: Array<() => void> = [];

/** A burst of wallet events (a close-all settles many) is one reload. */
const scheduleReload = (): void => {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    void useSelectedAccountStore.getState().load();
  }, RELOAD_DEBOUNCE_MS);
};

const stopSync = (): void => {
  if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
  for (const u of unsubscribers) u();
  unsubscribers = [];
};

const startSync = (): void => {
  stopSync();
  unsubscribers = [
    wsClient.subscribe('user:wallet', scheduleReload),
    wsClient.subscribe('user:accounts', scheduleReload),
  ];
};

useAuthStore.subscribe((state, prev) => {
  const uid = state.user?.id ?? null;
  const prevUid = prev.user?.id ?? null;
  if (uid === prevUid) return;
  stopSync();
  useSelectedAccountStore.getState().reset();
  if (uid) {
    startSync();
    void useSelectedAccountStore.getState().load();
  }
});
