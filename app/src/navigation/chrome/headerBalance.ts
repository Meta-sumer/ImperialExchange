import { walletApi } from '@/api/wallet.api';
import type { AccountEquity } from '@/types/wallet';
import { fmtMoney } from '@/utils/money';

/**
 * The profile menu's "Balance" figure — Layout.jsx's `/wallet/equity` read.
 *
 * EquityHub's header shows the FLOATING balance (realized balance + Σ open
 * position P&L — "what the user would have if they closed now") of the
 * SELECTED account, and each account's own floating balance in the switch-
 * account list. Every wallet amount is INR, so there is no conversion and
 * no display-currency picker.
 *
 * The figure is the server's: GET /wallet/equity
 * (walletController.getAccountsEquity, walletApi.equity) marks every open
 * position at the instrument's last price with the same uPnL formula as
 * /trading/positions, so the header agrees with the terminal. The web also
 * re-marks the selected account on every tick in the browser
 * (useFloatingBalance); the app keeps the server's figure (PORT-RULINGS:
 * where the server computes a number, the app displays the server's) and
 * re-reads it every 5 s while the menu is open and on `user:wallet` /
 * `user:positions`, as the web's Layout does.
 */

export type { AccountEquity };

/** GET /wallet/equity — every account of the user. */
export const fetchAccountsEquity = (): Promise<AccountEquity[]> => walletApi.equity();

/** How often the figure is re-read while the menu is open (Layout.jsx's 5 s poll). */
export const EQUITY_POLL_MS = 5_000;

/** Per account: the floating balance summed over that account's wallet rows (`b.equity ?? b.balance`). */
export const equityByAccount = (list: readonly AccountEquity[] | null): Map<string, number> => {
  const out = new Map<string, number>();
  for (const b of list ?? []) {
    if (!b.accountId) continue;
    const v = Number(b.equity ?? b.balance) || 0;
    out.set(b.accountId, (out.get(b.accountId) ?? 0) + v);
  }
  return out;
};

/**
 * The Balance row's text: a dash until the first read lands, then the
 * selected account's floating balance (₹0.00 for an account with no wallet
 * row, as the web's reduce over nothing gives).
 */
export const balanceLabel = (list: readonly AccountEquity[] | null, selectedId: string | null): string => {
  if (list === null) return '—';
  const total = list
    .filter((b) => String(b.accountId) === String(selectedId))
    .reduce((s, b) => s + (Number(b.equity ?? b.balance) || 0), 0);
  return fmtMoney(total, 'INR');
};
