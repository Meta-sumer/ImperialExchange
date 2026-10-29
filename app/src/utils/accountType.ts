import type { AccountPlan, AccountType, TradingAccount } from '@/types/trading';

/**
 * Account-type helpers — client/src/utils/accountTypes.js (EquityHub), which
 * Wallet.jsx, Layout.jsx and Trade.jsx import.
 *
 * ── THE ONE PREDICATE ─────────────────────────────────────────────────
 * Real money is anything that is not practice money. The server's own rule
 * (walletController: `isDemoLike = type === 'DEMO' || type === 'VIRTUAL'`)
 * and accountTypes.js's `LEGACY_DEMO_TYPES` agree. Never `=== 'REAL'`:
 * REAL is a LEGACY tier, and modern live accounts carry STANDARD / PRO /
 * FREE and their `_IC` variants. See docs/PORT-RULINGS.md §3.
 * ──────────────────────────────────────────────────────────────────────
 */

const DEMO_LIKE = new Set<string>(['DEMO', 'VIRTUAL']);

export const isDemoLike = (accountType: AccountType | null | undefined): boolean =>
  DEMO_LIKE.has(String(accountType ?? '').toUpperCase());

export const isRealMoney = (accountType: AccountType | null | undefined): boolean =>
  !isDemoLike(accountType);

/** accountTypes.js isLiveAccount — any non-demo account. */
export const isLiveAccount = (account: Pick<TradingAccount, 'accountType'> | null | undefined): boolean =>
  !!account && isRealMoney(account.accountType);

/** accountTypes.js isDemoAccount — legacy DEMO / VIRTUAL. */
export const isDemoAccount = (account: Pick<TradingAccount, 'accountType'> | null | undefined): boolean =>
  !!account && isDemoLike(account.accountType);

/** accountTypes.js TIER_LABELS. */
const TIER_LABELS: Readonly<Record<string, string>> = {
  STANDARD: 'Standard',
  STANDARD_IC: 'Standard IC',
  PRO: 'Pro',
  PRO_IC: 'Pro IC',
  FREE: 'Free',
  FREE_IC: 'Free IC',
};

type TierSource = Pick<TradingAccount, 'accountType'> & {
  customTypeName?: string | null;
  /** A demo account keeps the tier it was created from here (userController). */
  tierCode?: string | null;
  /** A UserAccount carries the server row; `tierCode` is read from it when not lifted. */
  raw?: Record<string, unknown>;
};

/**
 * accountTypes.js accountTierLabel — the human TIER name of an account (not
 * its demo/live mode, which is a separate badge). Catalogue tiers map to
 * their name; CUSTOM uses its custom name; an unknown tier is title-cased
 * (PRO_IC → Pro IC); legacy DEMO / REAL / VIRTUAL show the tier they were
 * created from (`tierCode`), else 'Standard'.
 */
export const accountTierLabel = (account: TierSource | null | undefined): string => {
  if (!account) return 'Standard';
  const t = String(account.accountType || '').toUpperCase();
  if (t === 'CUSTOM') return account.customTypeName || 'Custom';
  const known = TIER_LABELS[t];
  if (known) return known;
  if (t && !DEMO_LIKE.has(t) && t !== 'REAL') {
    const ic = t.endsWith('_IC');
    const base = ic ? t.slice(0, -3) : t;
    const label = base.charAt(0) + base.slice(1).toLowerCase();
    return ic ? `${label} IC` : label;
  }
  const rawTier = account.tierCode ?? account.raw?.tierCode;
  const tc = String(typeof rawTier === 'string' ? rawTier : '').toUpperCase();
  return TIER_LABELS[tc] ?? 'Standard';
};

/**
 * The tier for an account, from the admin's published catalogue.
 * `TradingAccount.accountType` is the plan CODE.
 */
export const planFor = (
  plans: Record<string, AccountPlan>,
  account: TradingAccount | null | undefined,
): AccountPlan | null =>
  (account ? plans[String(account.accountType).toUpperCase()] ?? null : null);

/**
 * What to call an account on screen.
 *
 * The trader's own nickname wins — they chose it. Then the admin's tier
 * name. The raw code is the last resort rather than the first, but it is
 * kept: a label that vanishes because a cosmetic catalogue fetch failed is
 * worse than a blunt one.
 */
export const accountLabel = (
  account: TradingAccount | null | undefined,
  plans: Record<string, AccountPlan> = {},
): string => {
  if (!account) return 'No account';
  return account.nickname ?? planFor(plans, account)?.name ?? account.accountType;
};

/**
 * A short badge for the account list: the tier name, or DEMO for practice
 * money. Demo-ness is worth saying out loud wherever money is shown.
 */
export const accountBadge = (
  account: TradingAccount | null | undefined,
  plans: Record<string, AccountPlan> = {},
): string | null => {
  if (!account) return null;
  if (isDemoLike(account.accountType)) return 'DEMO';
  return planFor(plans, account)?.badge ?? null;
};
