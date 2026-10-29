import AsyncStorage from '@react-native-async-storage/async-storage';
import { NavigationContext } from '@react-navigation/native';
import { useContext, useEffect, useMemo, useState } from 'react';

import { retainTicker, useTickerStore } from '@/api/market.api';
import { userApi } from '@/api/user.api';
import { walletApi } from '@/api/wallet.api';
import type { Ticker } from '@/types/market';
import { toLeverageState, type LeverageState } from '@/types/user';
import type { WalletBalance } from '@/types/wallet';
import { leverageStorageKey, parseSavedLeverage } from '@/utils/orderForm';
import { subscribeForeground, subscribeLeverage, subscribeWallet } from '@/websocket/channels';

/**
 * Is the screen this component sits on the focused one?
 *
 * True outside a navigator screen — overlay (Portal) content has no screen
 * context, and a component rendered there is torn down with its sheet. The
 * order sheet closes itself when its screen loses focus, so the form inside
 * it never runs unfocused.
 */
export function useScreenFocused(): boolean {
  const navigation = useContext(NavigationContext);
  const [focused, setFocused] = useState<boolean>(() => (navigation ? navigation.isFocused() : true));
  useEffect(() => {
    if (!navigation) {
      setFocused(true);
      return undefined;
    }
    setFocused(navigation.isFocused());
    const offFocus = navigation.addListener('focus', () => setFocused(true));
    const offBlur = navigation.addListener('blur', () => setFocused(false));
    return () => { offFocus(); offBlur(); };
  }, [navigation]);
  return focused;
}

/**
 * GET /user/leverage, kept live — OrderForm.jsx: the admin's overrides
 * arrive on `user:leverage`, and coming back to the app re-reads it (the
 * web's window-focus refetch, for a push missed while the socket was down).
 * Paused while `active` is false; resuming re-reads.
 */
export function useLeverageState(active: boolean): LeverageState | null {
  const [state, setState] = useState<LeverageState | null>(null);
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const load = (): void => {
      userApi.getLeverage()
        .then((s) => { if (!cancelled) setState(s); })
        .catch(() => { /* fall through to the plan-less ceiling */ });
    };
    load();
    const off = subscribeLeverage((data) => {
      // The web ignores an empty push (`if (data)`); the channel hands an
      // object for anything, so an empty one is the equivalent.
      if (!cancelled && data && Object.keys(data).length) setState(toLeverageState(data));
    });
    const offFg = subscribeForeground(load);
    return () => { cancelled = true; off(); offFg(); };
  }, [active]);
  return state;
}

/**
 * The account's wallet rows (GET /wallet/balances?accountId=), re-read on
 * every `user:wallet` event — placing or closing a trade moves free balance
 * (OrderForm.jsx fetchFree). A failed read keeps the rows it had.
 *
 * Unlike the web, switching account clears the rows at once: the previous
 * account's balance is not this one's, and a margin check against it could
 * pass an order it should stop. A reply for an account no longer shown is
 * dropped. Paused while `active` is false; resuming re-reads.
 */
export function useAccountWallets(accountId: string | null | undefined, active: boolean): WalletBalance[] | null {
  // The rows carry the account they belong to, so another account's never show.
  const [held, setHeld] = useState<{ accountId: string; rows: WalletBalance[] } | null>(null);

  useEffect(() => {
    if (!accountId || !active) return undefined;
    let cancelled = false;
    let seq = 0;
    const fetchFree = (): void => {
      const mine = ++seq;
      walletApi.balances(accountId)
        .then((list) => { if (!cancelled && mine === seq) setHeld({ accountId, rows: list }); })
        .catch(() => { /* keep prior value */ });
    };
    fetchFree();
    const off = subscribeWallet(fetchFree);
    const offFg = subscribeForeground(fetchFree);
    return () => { cancelled = true; off(); offFg(); };
  }, [accountId, active]);

  return held && held.accountId === accountId ? held.rows : null;
}

/*
 * Remembered leverage, per account (OrderForm.jsx _readSavedLeverage /
 * _saveLeverage). The web reads localStorage synchronously; AsyncStorage is
 * asynchronous, so what was read or written this session is also held here
 * and a reopened form starts on it at once.
 */
const leverageMemo = new Map<string, number>();

/** The leverage last chosen for this account, if this session already knows it. */
export const knownSavedLeverage = (accountId: string | null | undefined): number | null =>
  leverageMemo.get(leverageStorageKey(accountId)) ?? null;

/** Read the stored value (null when none, or storage refuses). */
export const readSavedLeverage = async (accountId: string | null | undefined): Promise<number | null> => {
  const key = leverageStorageKey(accountId);
  const memo = leverageMemo.get(key);
  if (memo != null) return memo;
  try {
    const n = parseSavedLeverage(await AsyncStorage.getItem(key));
    if (n != null) leverageMemo.set(key, n);
    return n;
  } catch {
    // Storage unavailable — fall back to the account default.
    return null;
  }
};

/** Persist the leverage in effect (including one the clamp lowered). */
export const saveLeverage = (accountId: string | null | undefined, value: number): void => {
  if (!accountId || !(Number(value) >= 1)) return;
  const key = leverageStorageKey(accountId);
  leverageMemo.set(key, value);
  AsyncStorage.setItem(key, String(value)).catch(() => { /* ignore */ });
};

/** Tests only. */
export const _resetSavedLeverage = (): void => { leverageMemo.clear(); };

/**
 * One symbol's live tick, delivered at most once per `intervalMs` — a form
 * re-rendered on every tick of a busy feed would be doing nothing else.
 * Subscribed only while `active`; released on unmount and when `active`
 * goes false (the screen lost focus, the sheet closed).
 */
export function useCoalescedTicker(symbol: string | null | undefined, active: boolean, intervalMs = 300): Ticker | null {
  const sym = symbol ? symbol.toUpperCase() : '';
  const [tick, setTick] = useState<Ticker | null>(() => (sym ? useTickerStore.getState().bySymbol[sym] ?? null : null));

  useEffect(() => {
    if (!sym || !active) return undefined;
    const release = retainTicker(sym);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    let pending: Ticker | null = null;
    const flush = (): void => {
      timer = null;
      last = Date.now();
      if (pending) setTick(pending);
      pending = null;
    };
    const seen = useTickerStore.getState().bySymbol[sym];
    if (seen) setTick(seen);
    const unsub = useTickerStore.subscribe((s, prev) => {
      const next = s.bySymbol[sym];
      if (!next || next === prev.bySymbol[sym]) return;
      pending = next;
      if (timer) return;
      const wait = Math.max(0, intervalMs - (Date.now() - last));
      timer = setTimeout(flush, wait);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
      release();
    };
  }, [sym, active, intervalMs]);

  return useMemo(() => (tick && tick.symbol === sym ? tick : null), [tick, sym]);
}
