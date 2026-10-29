import { api } from '@/api/client';
import { num, rows, str } from '@/types/api';
import { isDemoLike } from '@/utils/accountType';
import {
  toAccountPlan,
  toUserAccount,
  type AccountPlanDetail,
  type CreateAccountInput,
  type CreatedAccount,
  type UserAccount,
} from '@/types/user';

/**
 * Trading accounts (/user/accounts) and the tier catalogue they are opened
 * against (/account-plans).
 */

type Raw = Record<string, unknown>;

const payload = (body: unknown): unknown =>
  (body && typeof body === 'object' && 'success' in body ? (body as Raw).data : body);

/** Nickname rules, identical to the server's (userController.updateAccount). */
export const NICKNAME_MAX = 40;

/** Collapse runs of whitespace and trim — what the server stores. */
export const normaliseNickname = (name: string): string => name.replace(/\s+/g, ' ').trim();

/**
 * Why a nickname would be refused, in the web's words (Wallet.jsx:3505-3506),
 * or null when it is fine. Checked before the round trip, not instead of it.
 */
export const nicknameError = (name: string): string | null => {
  const n = normaliseNickname(name);
  if (!n) return 'Nickname cannot be empty';
  if (n.length > NICKNAME_MAX) return `Nickname too long (max ${NICKNAME_MAX})`;
  return null;
};

/**
 * The body POST /user/accounts is sent.
 *
 * - `initialBalance` only for practice accounts: the server 400s it on a live
 *   tier ("use a deposit instead"). Wallet.jsx strips it the same way.
 * - `baseCurrency` is not sent. EquityHub is INR-only: the server stores its
 *   BASE_CURRENCY (INR) on every account whatever is asked
 *   (userController.createAccount).
 */
export const buildCreateAccountPayload = (input: CreateAccountInput): Raw => {
  const body: Raw = { accountType: input.accountType };
  if (input.leverage !== undefined) body.leverage = input.leverage;
  if (input.mode !== undefined) body.mode = input.mode;
  const nickname = input.nickname !== undefined ? normaliseNickname(input.nickname) : '';
  if (nickname) body.nickname = nickname;
  if (isDemoLike(input.accountType) && input.initialBalance !== undefined) {
    body.initialBalance = input.initialBalance;
  }
  return body;
};

/** The created account and its min-deposit hint — rupees (the server sends BASE_CURRENCY). */
const toCreatedAccount = (body: unknown): CreatedAccount => {
  const d = (payload(body) ?? {}) as Raw;
  const hint = d.minDepositHint && typeof d.minDepositHint === 'object'
    ? (d.minDepositHint as Raw)
    : null;
  return {
    ...toUserAccount(d),
    minDepositHint: hint
      ? {
        minDeposit: num(hint.minDeposit) ?? 0,
        currency: str(hint.currency) || 'INR',
        needsFunding: hint.needsFunding === true,
      }
      : null,
  };
};

export const accountApi = {
  /** Active accounts only — the server filters `isActive: true`. */
  list: async (): Promise<UserAccount[]> => {
    const { data } = await api.get('/user/accounts');
    return rows<unknown>(payload(data)).map(toUserAccount).filter((a) => a.id !== '');
  },

  /**
   * Open an account. PLAN_LIMIT_REACHED (403) means the subscription's
   * account cap; UNKNOWN_PLAN / PLAN_DISABLED mean the tier went away
   * between the picker loading and the submit.
   */
  create: async (input: CreateAccountInput): Promise<CreatedAccount> => {
    const { data } = await api.post('/user/accounts', buildCreateAccountPayload(input));
    return toCreatedAccount(data);
  },

  /** Only the nickname is editable; everything else about an account is fixed. */
  rename: async (accountId: string, nickname: string): Promise<UserAccount> => {
    const { data } = await api.patch(`/user/accounts/${encodeURIComponent(accountId)}`, {
      nickname: normaliseNickname(nickname),
    });
    return toUserAccount(payload(data));
  },

  /**
   * The ACTIVE tiers, in the admin's order (the server sorts by sortOrder,
   * then age). What the new-account picker offers, and the per-tier minimum
   * deposit the deposit form enforces.
   */
  listPlans: async (): Promise<AccountPlanDetail[]> => {
    const { data } = await api.get('/account-plans');
    return rows<unknown>(payload(data))
      .map(toAccountPlan)
      .filter((p) => p.code !== '' && p.isActive);
  },
};

/**
 * POST /user/accounts with the exact body EquityHub's NewAccountConfigure.jsx
 * builds (utils/plans `buildNewAccountPayload`, pinned to the web's source
 * by stage2_plans.parity.test), posted as-is.
 *
 * Added for the new-account wizard. Unlike `accountApi.create` it sends the
 * web's keys unaltered: `baseCurrency: 'INR'` (the server stores INR in any
 * case), the nickname trimmed only, and — for a demo — `tierCode`, which
 * the server keeps on the DEMO account so it is shown under the tier it was
 * opened from rather than as "Standard".
 */
export const createAccountFromWizard = async (body: {
  accountType: string;
  tierCode?: string;
  baseCurrency: string;
  leverage: number;
  nickname: string;
  initialBalance?: number;
}): Promise<CreatedAccount> => {
  const { data } = await api.post('/user/accounts', body);
  return toCreatedAccount(data);
};
