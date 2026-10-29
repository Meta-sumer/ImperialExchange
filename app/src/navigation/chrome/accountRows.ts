import { accountTierLabel, isDemoLike } from '@/utils/accountType';

/**
 * How the account switcher names an account — Layout.jsx's switch-account
 * rows, verbatim in behaviour.
 */

interface AccountLike {
  accountType?: string | null;
  nickname?: string | null;
  baseCurrency?: string | null;
  accountNumber?: string | null;
  customTypeName?: string | null;
  tierCode?: string | null;
  raw?: Record<string, unknown>;
}

/**
 * The trader's nickname, else the type title-cased ("STANDARD_IC" →
 * "STANDARD IC"), else "Account". The web also tries `label` and `name`,
 * which no account payload carries.
 */
export const formatAccountLabel = (a: AccountLike | null | undefined): string => {
  if (!a) return '';
  const type = String(a.accountType ?? '').toUpperCase();
  return a.nickname
    || (type ? type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Account');
};

/**
 * "INR · 100234 · Standard IC" — the line under each account. Every
 * EquityHub account is INR (`['INR', a.accountNumber, accountTierLabel(a)]`).
 */
export const accountSubline = (a: AccountLike): string =>
  ['INR', a.accountNumber, accountTierLabel({ accountType: a.accountType ?? '', customTypeName: a.customTypeName, tierCode: a.tierCode, raw: a.raw })]
    .filter(Boolean)
    .join(' · ');

/**
 * DEMO or LIVE. Layout.jsx tests `DEMO || VIRTUAL`, which is the one correct
 * predicate (PORT-RULINGS §3) — utils/accountType is that predicate.
 */
export const accountChip = (a: AccountLike): 'DEMO' | 'LIVE' => (isDemoLike(a.accountType) ? 'DEMO' : 'LIVE');

/** "Ada Lovelace" → "AL"; nothing → "T" for Trader. */
export const initialsFor = (firstName?: string | null, lastName?: string | null): { fullName: string; initials: string } => {
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Trader';
  const initials = (fullName || 'T')
    .split(' ')
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return { fullName, initials };
};
