import type { AxiosError } from 'axios';

import { api } from '@/api/client';
import { dec, rows, str } from '@/types/api';
import {
  toMySubscription,
  toPlan,
  toSubscription,
  type BillingCycle,
  type InsufficientBalance,
  type MySubscription,
  type Plan,
  type SubscribeInput,
  type Subscription,
} from '@/types/subscription';
import { toWalletTransaction, type WalletTransaction } from '@/types/wallet';

/**
 * /subscriptions/* — the plan catalogue, the user's subscription, and the
 * plan-billing history.
 *
 * Paid plans are billed from the BONUS WALLET (`billingSource:
 * 'BONUS_WALLET'`), server-side: the subscribe body names the plan and the
 * cycle and nothing else. The Main Wallet that used to pay is retired.
 */

type Raw = Record<string, unknown>;

const payload = (body: unknown): unknown =>
  (body && typeof body === 'object' && 'success' in body ? (body as Raw).data : body);

type ErrBody = { error?: { code?: string; details?: unknown } };

export const subscriptionApi = {
  /** Active plans, in the admin's order. Public — no session needed. */
  plans: async (): Promise<Plan[]> => {
    const { data } = await api.get('/subscriptions/plans');
    return rows<unknown>(payload(data)).map(toPlan).filter((p) => p.code !== '');
  },

  me: async (): Promise<MySubscription> => {
    const { data } = await api.get('/subscriptions/me');
    return toMySubscription(payload(data));
  },

  /**
   * Switch plan — `{ planCode, billingCycle }`. A paid plan is debited from
   * the Bonus Wallet; a shortfall is a 402 read by `insufficientBalance`.
   */
  subscribe: async (input: SubscribeInput): Promise<Subscription | null> => {
    const { data } = await api.post('/subscriptions/subscribe', input);
    return toSubscription(payload(data));
  },

  /** Plans.jsx sends this exact reason; the admin log reads it. */
  cancel: async (reason = 'User requested'): Promise<Subscription | null> => {
    const { data } = await api.post('/subscriptions/cancel', { reason });
    return toSubscription(payload(data));
  },

  /**
   * The standalone renewal. The web never calls it — renewals run as a
   * server sweep — but the backend exposes it for a manual "renew now".
   *
   * It bills through the same charge as subscribe (the Bonus Wallet). No
   * screen puts a button on it — the web never calls it.
   */
  renew: async (planCode: string, billingCycle: BillingCycle = 'MONTHLY'): Promise<Subscription | null> => {
    const { data } = await api.post('/subscriptions/renew', { planCode, billingCycle });
    const d = payload(data);
    return toSubscription(d && typeof d === 'object' ? (d as Raw).subscription : null);
  },

  /**
   * The plan-billing timeline, newest first: the Bonus Wallet's plan charges
   * and every row of the retired Main Wallet (top-ups, charges, refunds,
   * withdrawals — read-only now), each tagged `wallet: 'BONUS' | 'MAIN'`.
   * Plans' Billing & Subscription History rebuilds plan periods from the
   * SUBSCRIPTION_CHARGE / RENEWAL debits; the wallet hub's Transaction
   * History shows the MAIN rows. The server caps `limit` at 500.
   */
  history: async (
    query: { limit?: number; type?: 'CREDIT' | 'DEBIT' | 'REFUND'; reason?: string } = {},
  ): Promise<WalletTransaction[]> => {
    const params: Record<string, string | number> = { limit: query.limit ?? 100 };
    if (query.type) params.type = query.type;
    if (query.reason) params.reason = query.reason;
    const { data } = await api.get('/subscriptions/history', { params });
    return rows<unknown>(payload(data)).map(toWalletTransaction);
  },
};

/**
 * The shortfall on a 402 INSUFFICIENT_SUBSCRIPTION_BALANCE, or null for any
 * other error. The web answers it with a recharge prompt, not a toast, and
 * falls back to the plan price and the known balance when `details` is
 * missing (Plans.jsx confirmAndPay) — which is why those are parameters.
 * The Bonus Wallet is rupees, so a missing currency is INR.
 */
export const insufficientBalance = (
  err: unknown,
  fallback: { needed: string; balance?: string | null; currency?: string | null },
): InsufficientBalance | null => {
  const e = (err as AxiosError<ErrBody> | undefined)?.response?.data?.error;
  if (e?.code !== 'INSUFFICIENT_SUBSCRIPTION_BALANCE') return null;
  const d = e.details && typeof e.details === 'object' ? (e.details as Raw) : {};
  return {
    balance: d.balance != null ? dec(d.balance) : (fallback.balance ?? '0'),
    needed: d.needed != null ? dec(d.needed) : fallback.needed,
    shortfall: d.shortfall != null ? dec(d.shortfall) : '0',
    currency: str(d.currency) || fallback.currency || 'INR',
  };
};
