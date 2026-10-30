import type { AxiosError } from 'axios';

import { api, errorMessage } from '@/api/client';
import { dec, rows, str } from '@/types/api';
import {
  toAccountEquity,
  toBonusWallet,
  toDeposit,
  toDepositDetails,
  toFxRate,
  toLedgerEntry,
  toManualDepositResult,
  toPeerTransferResult,
  toPeerTransferSettings,
  toRazorpayOrder,
  toTransferRecipient,
  toWalletBalance,
  toWalletTransaction,
  toWalletWithdrawalResult,
  toWithdrawal,
  toWithdrawalMethod,
  type AccountEquity,
  type BonusWallet,
  type CreateDepositInput,
  type CreateWithdrawalInput,
  type Deposit,
  type DepositDetails,
  type FxRate,
  type InsufficientTradingBalance,
  type LedgerEntry,
  type BonusManualDepositInput,
  type ManualDepositResult,
  type NewWithdrawalMethod,
  type PeerTransferInput,
  type PeerTransferResult,
  type PeerTransferSettings,
  type RazorpayOrder,
  type RazorpayVerifyInput,
  type RazorpayVerifyResult,
  type TransferInput,
  type TransferRecipient,
  type TransferResult,
  type WalletBalance,
  type WalletTransaction,
  type WalletWithdrawalResult,
  type Withdrawal,
  type WithdrawalMethod,
  toCreditSummary,
  toCreditTransaction,
  type CreditSummary,
  type CreditTransaction,
} from '@/types/wallet';
import { CURRENCY_SYMBOL } from '@/utils/money';

/**
 * /wallet/*, /withdrawal-methods, /fx/usdinr, and the user-level Bonus
 * Wallet: /bonus-wallet/*. The Main Wallet (/subscription-wallet) is
 * retired — its money endpoints answer 410 MAIN_WALLET_RETIRED — so nothing
 * here calls it; its old rows still arrive on /subscriptions/history.
 *
 * Nothing here computes money. Balances, free margin and fees are the
 * server's figures, carried as Decimal strings. EquityHub is INR-only.
 *
 * NOT ported: /wallet/deposits/quote and /wallet/withdrawals/quote — no
 * EquityHub screen calls them (the web previews fees from the admin config
 * it already holds). There is no /wallet/convert and no /wallet/fx/* on
 * EquityHub.
 */

type Raw = Record<string, unknown>;

const payload = (body: unknown): unknown =>
  (body && typeof body === 'object' && 'success' in body ? (body as Raw).data : body);

const record = (v: unknown): Raw =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

type ErrBody = { error?: { code?: string; message?: string; details?: unknown } };

const errorCode = (err: unknown): string | null =>
  (err as AxiosError<ErrBody> | undefined)?.response?.data?.error?.code ?? null;

const errorDetails = (err: unknown): Raw | null => {
  const d = (err as AxiosError<ErrBody> | undefined)?.response?.data?.error?.details;
  return d && typeof d === 'object' ? (d as Raw) : null;
};

const clean = (q: object): Record<string, string | number> => {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  }
  return out;
};

export const walletApi = {
  /* ── Trading wallets ───────────────────────────────────────────────── */

  /** Every wallet of every account, or one account's with `accountId`. */
  balances: async (accountId?: string): Promise<WalletBalance[]> => {
    const { data } = await api.get('/wallet/balances', { params: clean({ accountId }) });
    return rows<unknown>(payload(data)).map(toWalletBalance);
  },

  /**
   * GET /wallet/equity — every account's FLOATING balance (balance + Σ open
   * uPnL), margins and status. EquityHub's header chip reads it
   * (hooks/useFloatingBalance.js).
   */
  equity: async (): Promise<AccountEquity[]> => {
    const { data } = await api.get('/wallet/equity');
    return rows<unknown>(payload(data)).map(toAccountEquity);
  },

  /** Newest first. The web asks for 100. */
  ledger: async (query: { limit?: number; accountId?: string } = {}): Promise<LedgerEntry[]> => {
    const { data } = await api.get('/wallet/ledger', { params: clean({ limit: 100, ...query }) });
    return rows<unknown>(payload(data)).map(toLedgerEntry);
  },

  /* ── Deposits ──────────────────────────────────────────────────────── */

  /**
   * Where to SEND money, which rails are open each way, and the admin's
   * per-rail limits and fees — GET /wallet/deposit-details. A switched-off
   * rail keeps its flags and rules but no payee details.
   */
  depositDetails: async (): Promise<DepositDetails> => {
    const { data } = await api.get('/wallet/deposit-details');
    return toDepositDetails(payload(data));
  },

  /** The caller's last 100, newest first. */
  deposits: async (): Promise<Deposit[]> => {
    const { data } = await api.get('/wallet/deposits');
    return rows<unknown>(payload(data), 'deposits').map(toDeposit);
  },

  /**
   * A practice account is credited on the spot (status CONFIRMED). A live
   * one creates a PENDING row for admin review, and needs KYC APPROVED
   * (403 KYC_REQUIRED), a screenshot and a transaction reference; below the
   * tier minimum it is 400 BELOW_MIN_DEPOSIT.
   */
  createDeposit: async (input: CreateDepositInput): Promise<Deposit> => {
    const { data } = await api.post('/wallet/deposits', input);
    return toDeposit(record(payload(data)).deposit ?? payload(data));
  },

  /** Step 1 of a Razorpay deposit. Live accounts only, KYC-gated. */
  razorpayOrder: async (input: { accountId: string; amount: string | number; currency: string }): Promise<RazorpayOrder> => {
    const { data } = await api.post('/wallet/razorpay/order', input);
    return toRazorpayOrder(payload(data));
  },

  /**
   * Step 3: hand back what Checkout returned; the server checks the HMAC
   * and credits. Idempotent — a replay answers `alreadyCredited`.
   */
  razorpayVerify: async (input: RazorpayVerifyInput): Promise<RazorpayVerifyResult> => {
    const { data } = await api.post('/wallet/razorpay/verify', input);
    const d = record(payload(data));
    return {
      depositId: str(d.depositId),
      status: str(d.status),
      alreadyCredited: d.alreadyCredited === true,
    };
  },

  /* ── Withdrawals ───────────────────────────────────────────────────── */

  withdrawals: async (): Promise<Withdrawal[]> => {
    const { data } = await api.get('/wallet/withdrawals');
    return rows<unknown>(payload(data), 'withdrawals').map(toWithdrawal);
  },

  /**
   * A live account's request goes to the admin queue (PENDING); a practice
   * account's completes at once. Errors read with `errorMessage`.
   */
  createWithdrawal: async (input: CreateWithdrawalInput): Promise<Withdrawal> => {
    const { data } = await api.post('/wallet/withdrawals', input);
    return toWithdrawal(record(payload(data)).withdrawal ?? payload(data));
  },

  /* ── Payout destinations (/withdrawal-methods) ─────────────────────── */

  /** The user's own non-archived methods, masked. */
  withdrawalMethods: async (): Promise<WithdrawalMethod[]> => {
    const { data } = await api.get('/withdrawal-methods');
    return rows<unknown>(payload(data)).map(toWithdrawalMethod).filter((m) => !m.archived);
  },

  withdrawalMethod: async (methodId: string): Promise<WithdrawalMethod> => {
    const { data } = await api.get(`/withdrawal-methods/${encodeURIComponent(methodId)}`);
    return toWithdrawalMethod(payload(data));
  },

  /**
   * Starts PENDING — unusable until an admin verifies it. DUPLICATE_METHOD
   * (409) when the same destination is already on file.
   */
  addWithdrawalMethod: async (method: NewWithdrawalMethod): Promise<WithdrawalMethod> => {
    const { data } = await api.post('/withdrawal-methods', method);
    return toWithdrawalMethod(payload(data));
  },

  /**
   * A soft archive: withdrawals already sent to it keep their record of
   * where the money went, and it can never be used again.
   */
  removeWithdrawalMethod: async (methodId: string): Promise<void> => {
    await api.delete(`/withdrawal-methods/${encodeURIComponent(methodId)}`);
  },

  /* ── Moving money ──────────────────────────────────────────────────── */

  /**
   * Between the user's own accounts and the Bonus Wallet (BONUS_WALLET_ID).
   * Practice money stays practice: demo accounts only move to other demo
   * accounts, and live accounts and the Bonus Wallet only to each other —
   * the server refuses any mix (PRACTICE_TRANSFER_NOT_ALLOWED).
   */
  transfer: async (input: TransferInput): Promise<TransferResult> => {
    const { data } = await api.post('/wallet/transfers', input);
    const d = record(payload(data));
    return {
      from: str(d.from),
      to: str(d.to),
      amount: dec(d.amount),
      currency: str(d.currency) || input.currency,
    };
  },

  /** Peer-transfer limits. The web keeps permissive defaults if this fails. */
  peerTransferSettings: async (): Promise<PeerTransferSettings> => {
    const { data } = await api.get('/wallet/transfer-user/settings');
    return toPeerTransferSettings(payload(data));
  },

  /**
   * Recipient autocomplete. The web searches by public User ID only
   * (`by: 'uid'`), so a recipient cannot be found by guessing an email —
   * that is the default here too. Under 2 characters the server returns [].
   */
  searchRecipients: async (
    q: string,
    opts: { limit?: number; byUid?: boolean } = {},
  ): Promise<TransferRecipient[]> => {
    const { data } = await api.get('/wallet/recipients/search', {
      params: clean({ q, limit: opts.limit ?? 8, by: opts.byUid === false ? undefined : 'uid' }),
    });
    return rows<unknown>(payload(data)).map(toTransferRecipient).filter((r) => r.id !== '');
  },

  transferToUser: async (input: PeerTransferInput): Promise<PeerTransferResult> => {
    const { data } = await api.post('/wallet/transfer-user', {
      ...input,
      note: input.note?.trim() || undefined,
    });
    return toPeerTransferResult(payload(data));
  },

  /* ── FX (legacy) ───────────────────────────────────────────────────── */

  /**
   * GET /fx/usdinr. EquityHub keeps it for older clients and answers rate 1
   * (`source: 'inr-ledger'`). The app does not need it — hooks/useUsdInr is
   * a constant 1 — but the call is kept for completeness.
   */
  usdInr: async (): Promise<FxRate> => {
    const { data } = await api.get('/fx/usdinr', { timeout: 8_000 });
    return toFxRate(data);
  },

  /* ── Credit transactions (/wallet/credit) ──────────────────────────── */

  /**
   * GET /wallet/credit — the deposits and withdrawals the desk processed on
   * credit for this user (newest first, up to 100) and what is still
   * outstanding either way. Transaction History lists the rows; the wallet
   * page shows the outstanding card while anything is open.
   */
  credit: async (): Promise<{ items: CreditTransaction[]; summary: CreditSummary }> => {
    const { data } = await api.get('/wallet/credit');
    const body = (payload(data) ?? {}) as { items?: unknown; summary?: unknown };
    return {
      items: rows<unknown>(body.items).map(toCreditTransaction),
      summary: toCreditSummary(body.summary),
    };
  },

  /* ── Bonus Wallet (/bonus-wallet) ──────────────────────────────────── */

  /**
   * The wallet plus the server's earnings roll-up by source. It holds
   * referral and partner earnings, copy-trading fees and funds the user
   * adds, and plans are billed from it.
   */
  bonusWallet: async (): Promise<BonusWallet> => {
    const { data } = await api.get('/bonus-wallet');
    return toBonusWallet(payload(data));
  },

  bonusHistory: async (limit = 100): Promise<WalletTransaction[]> => {
    const { data } = await api.get('/bonus-wallet/history', { params: { limit } });
    return rows<unknown>(payload(data)).map(toWalletTransaction);
  },

  /**
   * Add Funds, instantly, FROM a live trading account (a practice account is
   * refused: PRACTICE_TRANSFER_NOT_ALLOWED). See bonusTopUpError for
   * INSUFFICIENT_TRADING_BALANCE / NO_REAL_ACCOUNT.
   */
  bonusDeposit: async (input: { amount: number; sourceAccountId: string }): Promise<BonusWallet> => {
    const { data } = await api.post('/bonus-wallet/deposit', input);
    return toBonusWallet(record(payload(data)).wallet);
  },

  /** Add Funds by UPI / bank with proof: a PENDING deposit an admin verifies. */
  bonusManualDeposit: async (input: BonusManualDepositInput): Promise<ManualDepositResult> => {
    const { data } = await api.post('/bonus-wallet/manual-deposit', input);
    return toManualDepositResult(payload(data));
  },

  /** Held immediately; refunded if the admin rejects it. KYC-gated. */
  bonusWithdraw: async (input: { amount: number; withdrawalMethodId: string }): Promise<WalletWithdrawalResult> => {
    const { data } = await api.post('/bonus-wallet/withdraw', input);
    return toWalletWithdrawalResult(payload(data));
  },

  /** Plan auto-renew — renewals are charged from the Bonus Wallet. */
  setBonusAutoRenew: async (enabled: boolean): Promise<boolean> => {
    const { data } = await api.post('/bonus-wallet/auto-renew', { enabled });
    return record(payload(data)).autoRenew === true;
  },
};

/* ── Error readers ────────────────────────────────────────────────────── */

/**
 * The message for a refused Bonus Wallet withdrawal — WithdrawModal.jsx:
 * KYC gets an instruction, the monthly-P&L block the server's own wording
 * (with the web's fallback), everything else the server's message.
 */
export const withdrawErrorMessage = (err: unknown): string => {
  const code = errorCode(err);
  if (code === 'KYC_REQUIRED') return 'Complete KYC verification first (Profile → KYC).';
  if (code === 'WITHDRAWAL_BLOCKED_MONTHLY_PNL') {
    const msg = (err as AxiosError<ErrBody> | undefined)?.response?.data?.error?.message;
    return msg || 'Withdrawal blocked: your net trading P&L for this month must be positive to withdraw.';
  }
  return errorMessage(err);
};

/** `details` of an INSUFFICIENT_TRADING_BALANCE refusal, or null. */
export const insufficientTradingBalance = (err: unknown): InsufficientTradingBalance | null => {
  if (errorCode(err) !== 'INSUFFICIENT_TRADING_BALANCE') return null;
  const d = errorDetails(err);
  if (!d) return null;
  return {
    accountNumber: str(d.accountNumber),
    currency: str(d.currency) || 'INR',
    available: dec(d.available),
  };
};

/** The message for a refused instant Add Funds into the Bonus Wallet — DepositModal.jsx submitInstant. */
export const bonusTopUpError = (err: unknown): string => {
  const short = insufficientTradingBalance(err);
  if (short) return `Not enough in ${short.accountNumber} — available ${CURRENCY_SYMBOL}${short.available}.`;
  if (errorCode(err) === 'NO_REAL_ACCOUNT') return 'Open a live trading account first.';
  if (errorCode(err) === 'PRACTICE_TRANSFER_NOT_ALLOWED') return 'A demo account cannot fund the Main Wallet. Choose a live account.';
  return errorMessage(err);
};

/** A live-money deposit refused until KYC is approved. */
export const isKycRequired = (err: unknown): boolean => errorCode(err) === 'KYC_REQUIRED';
