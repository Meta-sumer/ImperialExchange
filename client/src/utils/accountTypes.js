/**
 * Client-side account-type helpers — mirror the backend's
 * config/accountTypes.js. The 6-tier catalogue (STANDARD / STANDARD_IC /
 * PRO / PRO_IC / FREE / FREE_IC) replaced the legacy REAL / DEMO /
 * VIRTUAL types. We keep these helpers thin so any new tier added on
 * the backend just shows up — no client deploy needed for the actual
 * types (only for any tier-specific labels/icons we might add).
 *
 * Legacy:
 *   REAL    — live money. Treated identically to the new 6 tiers.
 *   DEMO    — practice / virtual seed.
 *   VIRTUAL — synonym of DEMO.
 */
const LEGACY_DEMO_TYPES = new Set(['DEMO', 'VIRTUAL']);

// Catalogue tier → human label. New tiers added on the backend fall through to
// the generic title-caser below, so this only needs the special-cased ones.
const TIER_LABELS = {
  STANDARD: 'Standard', STANDARD_IC: 'Standard IC',
  PRO: 'Pro',           PRO_IC: 'Pro IC',
  FREE: 'Free',         FREE_IC: 'Free IC',
};

/**
 * Human TIER label for an account's type (not its demo/live mode — that's the
 * separate badge). Real tiers map to their catalogue name; CUSTOM uses its
 * custom name; legacy DEMO / REAL / VIRTUAL have no tier of their own, so they
 * fall back to the effective default tier 'Standard' (mirrors the backend's
 * getDef() fallback). Pass the account object (needs customTypeName for CUSTOM).
 */
export function accountTierLabel(account) {
  if (!account) return 'Standard';
  const t = String(account.accountType || '').toUpperCase();
  if (t === 'CUSTOM') return account.customTypeName || 'Custom';
  if (TIER_LABELS[t]) return TIER_LABELS[t];
  if (t && !LEGACY_DEMO_TYPES.has(t) && t !== 'REAL') {
    // Unknown non-legacy tier from the backend — title-case it (PRO_IC → Pro IC).
    const ic = t.endsWith('_IC');
    const base = ic ? t.slice(0, -3) : t;
    const label = base.charAt(0) + base.slice(1).toLowerCase();
    return ic ? `${label} IC` : label;
  }
  // Legacy DEMO / REAL / VIRTUAL → the tier it was created from. Demo accounts
  // save that in `tierCode` (their accountType is 'DEMO'); show it when present.
  const tc = String(account.tierCode || '').toUpperCase();
  if (TIER_LABELS[tc]) return TIER_LABELS[tc];
  return 'Standard';
}

/** True when this account is a real-money / live account (any non-demo). */
export function isLiveAccount(account) {
  if (!account) return false;
  const t = String(account.accountType || '').toUpperCase();
  return !LEGACY_DEMO_TYPES.has(t);
}

/** True only for legacy DEMO/VIRTUAL accounts (self-funded, no deposits). */
export function isDemoAccount(account) {
  if (!account) return false;
  const t = String(account.accountType || '').toUpperCase();
  return LEGACY_DEMO_TYPES.has(t);
}

/** Same predicate, but accepts a raw type string (for filter convenience). */
export function isLiveType(accountType) {
  const t = String(accountType || '').toUpperCase();
  return !LEGACY_DEMO_TYPES.has(t);
}

export function isDemoType(accountType) {
  const t = String(accountType || '').toUpperCase();
  return LEGACY_DEMO_TYPES.has(t);
}
