import type { Decimal } from '@/types/trading';

/**
 * Roll every wallet row of an account into one figure.
 *
 * EquityHub is INR-only: each account holds one rupee wallet, so this is a
 * plain sum — Wallet.jsx `accountTotalUsd` ("INR-only: every wallet row is
 * rupees, so this is a plain sum"). The web's multi-currency
 * utils/walletTotals.js does not exist on EquityHub.
 *
 * The shape (`currency`, `unconverted`, `exact`, the `fxRate` option) is kept
 * so callers written for the multi-currency version keep compiling; nothing
 * is ever unconverted any more, so `exact` is always true.
 */

/** A wallet row as /wallet/balances returns it (adapted or raw). */
export interface WalletRow {
  accountId?: unknown;
  currency?: string | null;
  balance?: Decimal | number | null;
  locked?: Decimal | number | null;
  free?: Decimal | number | null;
}

export interface UnconvertedWallet {
  currency: string;
  balance: number;
  locked: number;
  free: number;
}

export interface WalletRollUp {
  /** Always 'INR'. */
  currency: string;
  balance: number;
  locked: number;
  free: number;
  /** Always empty — every row is rupees. */
  unconverted: UnconvertedWallet[];
  /** Always true. */
  exact: boolean;
}

export interface RollUpOptions {
  /** Only rows of this account. Omit to roll up every row passed. */
  accountId?: string | null;
  /** Ignored — INR-only. */
  baseCurrency?: string | null;
  /** Ignored — INR-only. */
  fxRate?: number | null;
}

/** INR-only: an amount is already in the base currency. Kept for older imports. */
export const toBaseCurrency = (
  amount: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _from?: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _base?: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _fxRate?: number | null,
): number => amount;

export function rollUpWallets(rows: readonly WalletRow[] | null | undefined, opts: RollUpOptions = {}): WalletRollUp {
  let balance = 0;
  let locked = 0;
  let free = 0;
  for (const w of rows || []) {
    // String()-compared: ids arrive as strings in some callers and as
    // ObjectId-ish values in others.
    if (opts.accountId && String(w.accountId) !== String(opts.accountId)) continue;
    balance += Number(w.balance) || 0;
    locked += Number(w.locked) || 0;
    free += Number(w.free) || 0;
  }
  return { currency: 'INR', balance, locked, free, unconverted: [], exact: true };
}

/** Convenience for callers that only need the free figure. */
export const freeForAccount = (rows: readonly WalletRow[] | null | undefined, opts?: RollUpOptions): number =>
  rollUpWallets(rows, opts).free;
