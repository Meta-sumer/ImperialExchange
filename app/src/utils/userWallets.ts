/**
 * EquityHub's Bonus Wallet (client/src/pages/BonusWallet.jsx) — the wallet
 * plans are billed from, with its Add Funds modal (client/src/components/
 * DepositModal.jsx), its WithdrawModal
 * (client/src/components/WithdrawModal.jsx), and the date helper it imports
 * (client/src/utils/dateRange.js) — the decisions only, with no React, so a
 * test can pin each one against the web's own code. INR only.
 *
 * The Main Wallet (subscription wallet) is retired: the Bonus Wallet holds
 * referral and partner earnings, copy-trading fees and funds the user adds,
 * and plans are billed from it.
 *
 * Nothing here computes money beyond the web's own previews: balances,
 * earnings and history amounts are the server's Decimal strings; the
 * comparisons (amount ≤ balance, within the rail's limits) and the fee
 * preview are done on parsed copies.
 */
import { isRealMoney } from '@/utils/accountType';
import type { PaymentRail, WithdrawRail } from '@/utils/fundsFlows';
import { EMPTY, fmtMoney } from '@/utils/money';
import type { MySubscription, Subscription } from '@/types/subscription';
import type { Decimal } from '@/types/trading';
import type { UserAccount } from '@/types/user';
import {
  customRailId,
  type CustomRail,
  type DepositDetails,
  type BillingWallet,
  type BonusManualDepositInput,
  type WalletBalance,
  type WalletTransaction,
} from '@/types/wallet';

/* ══ Dates ═══════════════════════════════════════════════════════════ */

/** `new Date(x).toLocaleString()` — device locale and zone (PORT-RULINGS §5). */
export const fmtDateTime = (iso: string | null | undefined): string => {
  if (!iso) return EMPTY;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : EMPTY;
};

/* ── dateRange.js, the parts BonusWallet uses ──────────────────────── */

export const DAY_MS = 24 * 60 * 60 * 1000;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Local midnight of the calendar day for `value` ('YYYY-MM-DD' | Date | ISO). dateRange.js:16. */
export const dayStart = (value: string | Date | null | undefined): Date | null => {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && YMD.test(value.trim())) {
    const [y = 0, m = 1, d = 1] = value.trim().split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
};

/** Local start of the day AFTER `value` — the exclusive upper bound. dateRange.js:27. */
export const nextDayStart = (value: string | Date | null | undefined): Date | null => {
  const s = dayStart(value);
  return s ? new Date(s.getTime() + DAY_MS) : null;
};

/**
 * Inclusive: [startOfDay(from), startOfNextDay(to)). A From equal to To is
 * that whole day, not nothing. dateRange.js:33.
 */
export const inCustomRange = (
  value: string | null | undefined,
  from: string | null | undefined,
  to: string | null | undefined,
): boolean => {
  const t = new Date(value as string).getTime();
  if (!Number.isFinite(t)) return false;
  const s = dayStart(from);
  if (s && t < s.getTime()) return false;
  const e = nextDayStart(to);
  if (e && t >= e.getTime()) return false;
  return true;
};

/** 'YYYY-MM-DD' for a local date — the value an `<input type="date">` holds. */
export const toYmd = (d: Date): string => {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** A real calendar day in 'YYYY-MM-DD' — not 2026-02-31, not a half-typed one. */
export const isYmd = (s: string | null | undefined): s is string => {
  if (!s || !YMD.test(s)) return false;
  const d = dayStart(s);
  return !!d && toYmd(d) === s;
};

/** How a picked day reads in its field: the device's own date format. */
export const fmtYmd = (s: string): string => {
  const d = dayStart(s);
  return d ? d.toLocaleDateString() : s;
};

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

export const WEEKDAY_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;

/**
 * One month as the date picker lays it out: Sunday-first weeks, `null` for
 * the blanks before the 1st and after the last day. Always whole weeks.
 */
export const monthGrid = (year: number, month: number): (string | null)[] => {
  const first = new Date(year, month, 1);
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (string | null)[] = Array.from({ length: first.getDay() }, () => null);
  for (let d = 1; d <= days; d++) cells.push(toYmd(new Date(year, month, d)));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
};

/**
 * Whether a day may be picked. The web's two date inputs bound each other —
 * From has `max={toDate}`, To has `min={fromDate}` — so a range can never be
 * inverted. 'YYYY-MM-DD' compares correctly as a string.
 */
export const dayAllowed = (ymd: string, min?: string | null, max?: string | null): boolean =>
  (!min || ymd >= min) && (!max || ymd <= max);

/* ══ The plan period (BonusWallet.jsx) ═══════════════════════════════ */

type PeriodSub = Pick<Subscription, 'expiresAt' | 'nextBillingAt'>;

export interface PlanPeriodEnd {
  date: Date;
  /** Always 'expiry' — EquityHub's wallet pages read `expiresAt` only. */
  source: 'expiry' | 'billing';
}

/**
 * When the current plan expires — `expiresAt`, or null. EquityHub's wallet
 * pages count down to the expiry only (MetaTrading's utils/planPeriod.js,
 * which falls back to `nextBillingAt`, does not exist here).
 */
export const planPeriodEnd = (sub: PeriodSub | null | undefined): PlanPeriodEnd | null => {
  if (!sub?.expiresAt) return null;
  const d = new Date(sub.expiresAt);
  return Number.isFinite(d.getTime()) ? { date: d, source: 'expiry' } : null;
};

export interface PlanCountdown {
  expired: boolean;
  label: string;
  source: PlanPeriodEnd['source'];
  days?: number;
  hours?: number;
}

/**
 * The web's `countdown`: null without an expiry, 'Expired' once it has
 * passed, otherwise "12d 4h".
 */
export const planCountdown = (sub: PeriodSub | null | undefined, now: Date = new Date()): PlanCountdown | null => {
  const end = planPeriodEnd(sub);
  if (!end) return null;
  const ms = end.date.getTime() - now.getTime();
  if (ms <= 0) return { expired: true, label: 'Expired', source: end.source };
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  return { expired: false, days, hours, label: `${days}d ${hours}h`, source: end.source };
};

/**
 * The Expires-in tile's sub line: the expiry date, or "No renewal
 * scheduled" (`sub?.expiresAt ? new Date(sub.expiresAt).toLocaleDateString()
 * : 'No renewal scheduled'`).
 */
export const planPeriodLabel = (
  sub: PeriodSub | null | undefined,
  { empty = 'No renewal scheduled', formatDate = (d: Date) => d.toLocaleDateString() }:
  { empty?: string; formatDate?: (d: Date) => string } = {},
): string => {
  const end = planPeriodEnd(sub);
  return end ? formatDate(end.date) : empty;
};

/* ══ Subscription status ═════════════════════════════════════════════ */

export interface StatusBadge {
  /** The web's inline hex; the chip is this at ~9% for its fill. */
  fg: string;
  label: string;
}

/** The plan status chip on the Current plan tile. */
export const SUBSCRIPTION_STATUS_BADGE: Readonly<Record<string, StatusBadge>> = {
  ACTIVE: { fg: '#16A34A', label: 'Active' },
  TRIAL: { fg: '#3B82F6', label: 'Trial' },
  EXPIRED: { fg: '#DC2626', label: 'Expired' },
  CANCELLED: { fg: '#92400E', label: 'Cancelled' },
  PENDING_PAYMENT: { fg: '#EA580C', label: 'Payment pending' },
  FREE: { fg: '#6B7280', label: 'Free plan' },
  NONE: { fg: '#6B7280', label: 'No subscription' },
};

/**
 * The badge on the Current plan tile. No subscription row reads "Free plan"
 * when the effective plan is Free and "No subscription" otherwise; an
 * unknown status is shown as the server wrote it.
 */
export const subscriptionStatusBadge = (me: Pick<MySubscription, 'subscription' | 'effectivePlan'> | null): StatusBadge => {
  const status = me?.subscription?.status || (me?.effectivePlan?.code === 'FREE' ? 'FREE' : 'NONE');
  return SUBSCRIPTION_STATUS_BADGE[status] ?? { fg: '#6B7280', label: status };
};

/** "monthly billing" under the plan name. */
export const billingCycleSub = (sub: Pick<Subscription, 'billingCycle'> | null | undefined): string | undefined =>
  (sub?.billingCycle ? `${sub.billingCycle.toLowerCase()} billing` : undefined);

/* ══ Plan billing: auto-renew and the low-balance warning ═══════════ */

/**
 * The low-balance warning: the server's flag (bonusWalletService.isLowBalance
 * — threshold at or above the balance), as BonusWallet.jsx reads it.
 */
export const billingWalletIsLow = (
  wallet: Pick<BillingWallet, 'isLowBalance'> | null | undefined,
): boolean => !!wallet?.isLowBalance;

export const autoRenewToast = (enabled: boolean): string => `Auto-renew ${enabled ? 'enabled' : 'disabled'}`;

/** "Plan renewals are deducted … N-day grace period." */
export const autoRenewNote = (gracePeriodDays: number | null | undefined): string =>
  `Plan renewals are deducted from this Main Wallet. ${gracePeriodDays || 0}-day grace period.`;

export const LOW_BALANCE_WARNING =
  '⚠ Low balance — ensure sufficient funds in your Main Wallet before your renewal date.';

export type TxnStatusTone = 'bull' | 'bear' | 'warn';

/** SUCCESS green, FAILED red, anything else (PENDING) amber. */
export const txnStatusTone = (status: string | null | undefined): TxnStatusTone =>
  (status === 'SUCCESS' ? 'bull' : status === 'FAILED' ? 'bear' : 'warn');

/* ── Add Funds: the four-step DepositModal ─────────────────────────── */

export const DEPOSIT_STEPS = ['Method', 'Amount', 'Proof', 'Review'] as const;
export const LAST_DEPOSIT_STEP = DEPOSIT_STEPS.length - 1;

export const TRADING_METHOD_ID = 'TRADING';

export type FixedTopUpMethodId = 'UPI' | 'BANK';

export interface TopUpMethod {
  /** A fixed rail id, `CUSTOM:<id>`, or TRADING. */
  id: string;
  label: string;
  sub: string;
  /** The rail's admin minimum per deposit (rupees); 0 = none. */
  min: number;
  /** The rail's admin maximum per deposit; 0 = none. */
  max: number;
  feePercent: number;
  feeFixed: number;
  kind: 'manual' | 'instant';
  emoji: string;
  /** The admin's custom rail, when this is one. */
  custom: CustomRail | null;
}

/** DepositModal.jsx FIXED_METHODS — no hard-coded minimums. */
export const TOPUP_FIXED_METHODS: readonly (TopUpMethod & { id: FixedTopUpMethodId })[] = [
  { id: 'UPI', label: 'UPI', sub: 'Instant · Free', min: 0, max: 0, feePercent: 0, feeFixed: 0, kind: 'manual', emoji: '📱', custom: null },
  { id: 'BANK', label: 'Bank Transfer', sub: 'NEFT / IMPS · 1-3 hrs', min: 0, max: 0, feePercent: 0, feeFixed: 0, kind: 'manual', emoji: '🏦', custom: null },
];

/** DepositModal.jsx TRADING_METHOD — not a payment rail, not admin-gated, always last. */
export const TOPUP_TRADING_METHOD: TopUpMethod = {
  id: TRADING_METHOD_ID, label: 'Trading account', sub: 'Live accounts · Instant transfer', min: 1, max: 0, feePercent: 0, feeFixed: 0, kind: 'instant', emoji: '↔️', custom: null,
};

/** DepositModal.jsx railRules — the admin's deposit limits and fee for a rail. */
const railRules = (cfg: { minDeposit: number; maxDeposit: number; feePercent: number; feeFixed: number } | null | undefined): Pick<TopUpMethod, 'min' | 'max' | 'feePercent' | 'feeFixed'> => ({
  min: cfg && cfg.minDeposit > 0 ? cfg.minDeposit : 0,
  max: cfg && cfg.maxDeposit > 0 ? cfg.maxDeposit : 0,
  feePercent: cfg?.feePercent ?? 0,
  feeFixed: cfg?.feeFixed ?? 0,
});

/**
 * The picker's list (DepositModal.jsx `methods`). Nothing external is
 * offered until the admin's list is in hand — 'loading' shows none, and a
 * failed read offers only the instant trading-account transfer, which is not
 * a payment rail. Once loaded: the fixed rails the admin left on, their
 * custom rails, then the trading-account transfer — each with its limits.
 */
export const topUpMethods = (
  details: DepositDetails | null,
  payState: 'loading' | 'ready' | 'error' = details ? 'ready' : 'loading',
): TopUpMethod[] => {
  if (payState === 'loading') return [];
  if (payState === 'error' || !details) return [TOPUP_TRADING_METHOD];
  const list: TopUpMethod[] = TOPUP_FIXED_METHODS
    .filter((m) => details[m.id].enabled)
    .map((m) => ({ ...m, ...railRules(details[m.id]) }));
  for (const c of details.custom) {
    if (c.label && c.enabled) {
      list.push({
        id: customRailId(c),
        label: c.label,
        sub: 'Manual',
        ...railRules(c),
        kind: 'manual',
        emoji: c.emoji || '💳',
        custom: c,
      });
    }
  }
  list.push(TOPUP_TRADING_METHOD);
  return list;
};

/**
 * The quick amounts: the rail's minimum (rounded up) × 1 / 5 / 10 / 50, or
 * ₹1,000 × the same when it sets none; above the rail's maximum dropped, and
 * the maximum itself when nothing is left.
 */
export const topUpPresets = (min: number, max = 0): number[] => {
  const base = min > 0 ? Math.ceil(min) : 1000;
  let list = [base, base * 5, base * 10, base * 50];
  if (max > 0) list = list.filter((q) => q <= max);
  if (!list.length && max > 0) list = [Math.floor(max)];
  return list;
};

/** The amount line under the presets — an error, or the rail's limits; null with none set. */
export const topUpAmountNote = (
  method: Pick<TopUpMethod, 'label' | 'min' | 'max'>,
  amount: string,
): { text: string; error: boolean } | null => {
  if (!(method.min > 0 || method.max > 0)) return null;
  const n = Number(amount) || 0;
  const under = method.min > 0 && n > 0 && n < method.min;
  const over = method.max > 0 && n > method.max;
  if (under) return { text: `Minimum for ${method.label} is ${fmtMoney(method.min)}`, error: true };
  if (over) return { text: `Maximum for ${method.label} is ${fmtMoney(method.max)} per transaction`, error: true };
  const parts = [method.min > 0 ? `Min ${fmtMoney(method.min)}` : '', method.max > 0 ? `Max ${fmtMoney(method.max)}` : ''].filter(Boolean);
  return { text: parts.join(' · '), error: false };
};

/** A preset or minimum as money — whole numbers without cents, as the web writes them. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const fmtWholeish = (n: number, _currency?: string): string =>
  fmtMoney(n, 'INR', Number.isInteger(n) ? 0 : 2);

/** The reference field's placeholder, by rail. */
export const txReferencePlaceholder = (methodId: string): string => {
  if (methodId === 'UPI') return 'UPI reference number';
  if (methodId === 'BANK') return 'NEFT / IMPS / UTR number';
  return 'Transaction ID';
};

export interface PayToRow {
  label: string;
  value: string;
  copy: boolean;
}

export interface TopUpPayTo {
  /** Blank values dropped. Empty means the admin has not set this rail up. */
  rows: PayToRow[];
  note: string | null;
  qr: string | null;
}

/**
 * Where to send the money for the chosen rail, in the Bonus Wallet Add
 * Funds' own labels (they differ from the trading wallet's: "Name",
 * "Account name", "Account no.").
 */
export const topUpPayTo = (details: DepositDetails | null, method: TopUpMethod | null): TopUpPayTo => {
  if (!method || method.id === TRADING_METHOD_ID) return { rows: [], note: null, qr: null };
  let rows: PayToRow[] = [];
  let note: string | null = null;
  let qr: string | null = null;
  if (method.custom) {
    rows = method.custom.fields.map((f) => ({ label: f.label, value: f.value, copy: f.copy }));
    note = method.custom.note;
    qr = method.custom.qr;
  } else if (details) {
    const id = method.id as FixedTopUpMethodId;
    if (id === 'UPI') {
      rows = [
        { label: 'UPI ID', value: details.UPI.upiId ?? '', copy: true },
        { label: 'Name', value: details.UPI.payeeName ?? '', copy: false },
      ];
    } else if (id === 'BANK') {
      rows = [
        { label: 'Account name', value: details.BANK.accountName ?? '', copy: false },
        { label: 'Account no.', value: details.BANK.accountNumber ?? '', copy: true },
        { label: 'IFSC', value: details.BANK.ifsc ?? '', copy: true },
        { label: 'Bank', value: details.BANK.bankName ?? '', copy: false },
      ];
    }
    if (id === 'UPI' || id === 'BANK') {
      note = details[id].note;
      qr = details[id].qr;
    }
  }
  return { rows: rows.filter((r) => String(r.value || '').trim() !== ''), note, qr };
};

/**
 * The Add Funds pay-to details as the shared PayToCard takes them.
 *
 * Null when nothing is set up, so the card's warning names the method by
 * its LABEL — "Payment details for Bank Transfer aren't set up yet", as
 * the web words it — and, as there, shows no note or QR
 * without rows to go with them.
 */
export const topUpPayToRail = (payTo: TopUpPayTo, method: TopUpMethod | null): PaymentRail | null => {
  if (!method || payTo.rows.length === 0) return null;
  return {
    id: method.id,
    label: method.label,
    postAs: method.custom ? method.custom.label : method.id,
    custom: !!method.custom,
    emoji: method.custom?.emoji ?? null,
    rows: payTo.rows.map((r) => ({ label: r.label, value: r.value, copyable: r.copy })),
    note: payTo.note,
    qr: payTo.qr,
  };
};

/** Keep what a decimal amount field may hold: digits and one point. */
export const cleanAmountInput = (raw: string): string => {
  const s = raw.replace(/,/g, '.').replace(/[^0-9.]/g, '');
  const dot = s.indexOf('.');
  return dot < 0 ? s : `${s.slice(0, dot + 1)}${s.slice(dot + 1).replace(/\./g, '')}`;
};

export interface DepositDraft {
  method: TopUpMethod | null;
  amount: string;
  sourceAccountId: string;
  txReference: string;
  hasProof: boolean;
}

/**
 * Whether "Continue →" is live on a step. The method must still be one on
 * offer (`methods`), and the amount within the rail's minimum AND maximum.
 */
export const depositCanNext = (step: number, d: DepositDraft, methods?: readonly Pick<TopUpMethod, 'id'>[]): boolean => {
  const n = Number(d.amount);
  if (step === 0) return !!d.method && (!methods || methods.some((m) => m.id === d.method?.id));
  if (step === 1) {
    if (d.amount.trim() === '' || !Number.isFinite(n) || n <= 0) return false;
    if (d.method?.min && n < d.method.min) return false;
    if (d.method?.max && n > d.method.max) return false;
    return true;
  }
  if (step === 2) {
    return d.method?.id === TRADING_METHOD_ID ? !!d.sourceAccountId : !!d.txReference.trim() && d.hasProof;
  }
  return true;
};

/** The refusal submit shows before anything is sent, or null. */
export const depositSubmitError = (d: DepositDraft): string | null => {
  const n = Number(d.amount);
  if (d.amount.trim() === '' || !Number.isFinite(n) || n <= 0) return 'Enter a positive amount';
  if (d.method?.id === TRADING_METHOD_ID) return d.sourceAccountId ? null : 'Pick a trading account';
  if (!d.txReference.trim()) return 'Transaction reference is required';
  if (!d.hasProof) return 'Upload a payment screenshot';
  return null;
};

/** POST /bonus-wallet/deposit — the instant transfer (`{ amount: n, sourceAccountId }`). */
export const instantTopUpBody = (amount: string, sourceAccountId: string): { amount: number; sourceAccountId: string } =>
  ({ amount: Number(amount), sourceAccountId });

/**
 * POST /bonus-wallet/manual-deposit — always INR.
 *
 * A custom rail is posted by its LABEL, a fixed one by its id. Optional
 * sender fields go only when filled — and only for the rail that shows them:
 * the web keeps a UPI ID typed before switching to Bank and posts it anyway,
 * a detail the user can no longer see.
 */
export const manualDepositBody = (p: {
  method: TopUpMethod;
  amount: string;
  /** Ignored — INR always. */
  currency?: string;
  txReference: string;
  senderName: string;
  senderUpiId: string;
  senderBankAccount: string;
  screenshot: string;
  screenshotMimeType: string;
}): BonusManualDepositInput => {
  const body: BonusManualDepositInput = {
    amount: Number(p.amount),
    currency: 'INR',
    method: p.method.custom ? p.method.custom.label : p.method.id,
    txReference: p.txReference.trim(),
    screenshot: p.screenshot,
    screenshotMimeType: p.screenshotMimeType,
  };
  const name = p.senderName.trim();
  const upi = p.senderUpiId.trim();
  const bank = p.senderBankAccount.trim();
  if (name) body.senderName = name;
  if (upi && p.method.id === 'UPI') body.senderUpiId = upi;
  if (bank && p.method.id === 'BANK') body.senderBankAccount = bank;
  return body;
};

/* ── The trading account an instant top-up draws on ──────────────── */

/**
 * Live accounts only, active ones (the web's `!== 'DEMO' && !== 'VIRTUAL'`,
 * which is isRealMoney) — the server refuses a practice account with
 * PRACTICE_TRANSFER_NOT_ALLOWED: practice money never becomes Bonus Wallet
 * money.
 */
export const topUpSourceAccounts = (accounts: readonly UserAccount[]): UserAccount[] =>
  accounts.filter((a) => isRealMoney(a.accountType) && a.isActive !== false);

/**
 * The pre-selected source: the OLDEST live account — the server's own pick
 * when none is named. Undated rows keep their order, as the web's
 * NaN-comparing sort leaves them.
 */
export const oldestAccountId = (accounts: readonly Pick<UserAccount, 'id' | 'createdAt'>[]): string => {
  const sorted = [...accounts].sort((a, b) => {
    const ta = Date.parse(a.createdAt ?? '');
    const tb = Date.parse(b.createdAt ?? '');
    return Number.isFinite(ta) && Number.isFinite(tb) ? ta - tb : 0;
  });
  return sorted[0]?.id ?? '';
};

/**
 * The balance shown beside an account: its rupee wallet.
 *
 * `balances` is null while GET /wallet/balances is in flight or after it
 * failed, and so is the answer: an unknown balance is shown as unknown (—),
 * never as ₹0.00. Once the list is in, an account with no wallet row reads
 * 0, as on the web.
 */
export const accountWalletBalance = (
  balances: readonly Pick<WalletBalance, 'accountId' | 'currency' | 'balance'>[] | null,
  account: Pick<UserAccount, 'id'>,
): Decimal | null => {
  if (!balances) return null;
  const mine = balances.filter((w) => w.accountId === account.id);
  const base = mine.find((w) => w.currency === 'INR') ?? mine[mine.length - 1];
  return base?.balance ?? '0';
};

/**
 * Which source account the instant top-up settles on once the accounts and
 * balances are in. The web pre-selects the OLDEST live account — but the picker is usable while that load
 * is in flight here (the list comes from the shared store), so a pick the
 * user made in the meantime is kept, as long as it is still a live account.
 * With no live account the current value is left alone, as the web does.
 */
export const settleSourceAccount = (
  current: string,
  userPicked: boolean,
  live: readonly Pick<UserAccount, 'id' | 'createdAt'>[],
): string => {
  if (userPicked && live.some((a) => a.id === current)) return current;
  return oldestAccountId(live) || current;
};

export const accountDisplayName = (a: Pick<UserAccount, 'nickname' | 'accountNumber'>): string =>
  a.nickname || a.accountNumber;

/* ══ WithdrawModal ═══════════════════════════════════════════════════ */

/**
 * The amount against the balance and the chosen rail's admin limits, and
 * the withdrawal fee preview — WithdrawModal.jsx. The fee is the rail's
 * percentage plus its fixed part (computeWithdrawalFee); the payout is the
 * amount less the fee.
 */
export interface UserWithdrawCheck {
  hasAmount: boolean;
  belowMin: boolean;
  aboveMax: boolean;
  overBalance: boolean;
  amountValid: boolean;
  fee: number;
  net: number;
}

const cents = (n: number): number => Math.round(n * 100) / 100;

export const userWithdrawCheck = (
  amount: string,
  balance: Decimal | number,
  rail: Pick<WithdrawRail, 'min' | 'max' | 'feePercent' | 'feeFixed'> | null,
): UserWithdrawCheck => {
  const n = Number(amount);
  const bal = Number(balance || 0);
  const hasAmount = amount.trim() !== '' && Number.isFinite(n) && n > 0;
  const min = rail?.min ?? 0;
  const max = rail?.max ?? 0;
  const belowMin = hasAmount && min > 0 && n < min;
  const aboveMax = hasAmount && max > 0 && n > max;
  const overBalance = hasAmount && n > bal;
  const fee = hasAmount ? cents(n * ((rail?.feePercent ?? 0) / 100) + (rail?.feeFixed ?? 0)) : 0;
  return {
    hasAmount,
    belowMin,
    aboveMax,
    overBalance,
    amountValid: hasAmount && !belowMin && !aboveMax && !overBalance,
    fee,
    net: hasAmount ? Math.max(0, cents(n - fee)) : 0,
  };
};

/** WithdrawModal.jsx's validity — kept for older imports (no rail limits). */
export const withdrawAmountValid = (amount: string, balance: Decimal | number): boolean =>
  userWithdrawCheck(amount, balance, null).amountValid;

/** The refusal on submit, in WithdrawModal.jsx's words and order, or null. */
export const withdrawSubmitError = (
  amount: string,
  balance: Decimal | number,
  withdrawalMethodId: string,
  rail: Pick<WithdrawRail, 'id' | 'min' | 'max' | 'feePercent' | 'feeFixed'> | null = null,
  requireRail = false,
): string | null => {
  if (requireRail && !rail) return 'Choose a withdrawal method';
  if (!withdrawalMethodId) return 'Choose a verified destination';
  const c = userWithdrawCheck(amount, balance, rail);
  if (!c.hasAmount) return 'Enter a valid amount';
  if (c.overBalance) return 'Amount exceeds your balance';
  if (c.belowMin) return `Minimum for this method is ${fmtMoney(rail?.min ?? 0)}`;
  if (c.aboveMax) return `Maximum for this method is ${fmtMoney(rail?.max ?? 0)}`;
  return null;
};

/** A rail card's rules line — "Min · ₹500.00  ·  Max · ₹50,000.00  ·  Fee 1% + ₹10.00", or "No fee". */
export const userWithdrawRailBits = (r: Pick<WithdrawRail, 'min' | 'max' | 'feePercent' | 'feeFixed'>): string => {
  const bits: string[] = [];
  if (r.min > 0) bits.push(`Min · ${fmtMoney(r.min)}`);
  if (r.max > 0) bits.push(`Max · ${fmtMoney(r.max)}`);
  if (r.feePercent > 0 || r.feeFixed > 0) {
    const f: string[] = [];
    if (r.feePercent > 0) f.push(`${r.feePercent}%`);
    if (r.feeFixed > 0) f.push(fmtMoney(r.feeFixed));
    bits.push(`Fee ${f.join(' + ')}`);
  } else {
    bits.push('No fee');
  }
  return bits.join('  ·  ');
};

/**
 * MAX: the balance FLOORED TO THE CENT, cut from the decimal string itself —
 * never above what the wallet holds.
 *
 * The web's `String(bal)` (WithdrawModal.jsx:98, `bal = Number(balance)`) is
 * not the balance: the server keeps it as a decimal.js string of up to 30
 * significant digits (a revenue share is `fee × pct / 100`, an INR transfer
 * is divided by the rate), and a double rounds such a string to NEAREST —
 * "10.3333…3" becomes 10.333333333333334, above the balance. The form
 * accepts it (the same double on both sides) and the server's
 * `gte(balance, amount)` refuses it with a 402. Truncating the string never
 * rounds up, and a two-decimal balance comes back exactly ("250.75").
 * The same rule as the trading wallet's MAX (fundsFlows `shareOf`).
 */
export const maxWithdrawAmount = (balance: Decimal | number | null | undefined): string => {
  const s = typeof balance === 'number'
    ? (Number.isFinite(balance) ? String(balance) : '')
    : String(balance ?? '').trim();
  const plain = /^\+?(\d*)(?:\.(\d*))?$/.exec(s);
  if (plain && (plain[1] || plain[2])) {
    const whole = (plain[1] || '0').replace(/^0+(?=\d)/, '');
    const cents = (plain[2] ?? '').slice(0, 2).replace(/0+$/, '');
    const out = cents ? `${whole}.${cents}` : whole;
    return Number(out) > 0 ? out : '0';
  }
  // Exponent form (decimal.js writes 1e-7 below 1e-6) or a negative: floor
  // numerically. Only a sub-cent or negative balance lands here — it is 0.
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return '0';
  const floored = Math.floor(n * 100) / 100;
  return floored > 0 ? String(floored) : '0';
};

/**
 * The only body the Bonus Wallet withdraw endpoint is sent: an amount and
 * WHICH saved method. No destination — the server resolves it from the
 * verified row. WithdrawModal.jsx:70.
 */
export const withdrawBody = (amount: string, withdrawalMethodId: string): { amount: number; withdrawalMethodId: string } =>
  ({ amount: Number(amount), withdrawalMethodId });

/* ══ Bonus Wallet ════════════════════════════════════════════════════ */

/** BonusWallet.jsx REASON_LABEL, verbatim. Anything else is shown as the server wrote it. */
export const BONUS_REASON_LABEL: Readonly<Record<string, string>> = {
  REFERRAL_COMMISSION: 'Referral Commission',
  PARTNER_COMMISSION: 'Partner Commission',
  REVENUE_SHARE: 'Revenue Share',
  BONUS_REWARD: 'Bonus Reward',
  COPY_PERFORMANCE_FEE: 'Copy Trading Commission',
  DEPOSIT: 'Deposit',
  SUBSCRIPTION_CHARGE: 'Subscription Charge',
  RENEWAL: 'Subscription Renewal',
  TRANSFER_IN: 'Internal Transfer In',
  TRANSFER_OUT: 'Internal Transfer Out',
  ADMIN_CREDIT: 'Admin Credit',
  ADMIN_DEBIT: 'Admin Debit',
  WITHDRAWAL: 'Withdrawal',
  REFUND: 'Refund',
};

export const bonusReasonLabel = (reason: string): string => BONUS_REASON_LABEL[reason] || reason;

/** Money IN on the Bonus page is a CREDIT only. BonusWallet.jsx:241. */
export const isBonusCredit = (t: Pick<WalletTransaction, 'transactionType'>): boolean => t.transactionType === 'CREDIT';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const bonusAmountText = (t: Pick<WalletTransaction, 'transactionType' | 'amount'>, _currency?: string): string =>
  `${isBonusCredit(t) ? '+' : '-'}${fmtMoney(t.amount)}`;

/** The last ten characters of the id — the Transaction ID column. */
export const shortTxnId = (id: string): string => String(id).slice(-10);

export const BONUS_STATUS_OPTIONS = ['SUCCESS', 'PENDING', 'FAILED'] as const;

/** The reasons present in the history, sorted by their label. BonusWallet.jsx:121. */
export const bonusTypeOptions = (txns: readonly Pick<WalletTransaction, 'reason'>[]): string[] =>
  [...new Set(txns.map((t) => t.reason).filter(Boolean))]
    .sort((a, b) => bonusReasonLabel(a).localeCompare(bonusReasonLabel(b)));

export interface BonusFilter {
  q: string;
  /** A reason, or '' for all. */
  type: string;
  status: string;
  /** '' | 'CREDIT' | 'DEBIT' */
  dir: string;
  /** 'YYYY-MM-DD' or ''. */
  from: string;
  to: string;
}

export const EMPTY_BONUS_FILTER: BonusFilter = { q: '', type: '', status: '', dir: '', from: '', to: '' };

export const hasBonusFilter = (f: BonusFilter): boolean =>
  !!(f.q.trim() || f.type || f.status || f.dir || f.from || f.to);

/** BonusWallet.jsx:125-137. */
export const filterBonusTxns = (txns: readonly WalletTransaction[], f: BonusFilter): WalletTransaction[] => {
  const query = f.q.trim().toLowerCase();
  return txns.filter((t) => {
    if (f.type && t.reason !== f.type) return false;
    if (f.status && (t.status || 'SUCCESS') !== f.status) return false;
    if (f.dir && t.transactionType !== f.dir) return false;
    if ((f.from || f.to) && !inCustomRange(t.createdAt, f.from, f.to)) return false;
    if (query) {
      const hay = `${BONUS_REASON_LABEL[t.reason] || t.reason || ''} ${t.note || ''} ${t.id || ''}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
};

/** "3 of 12 records" while filtering, "12 records" otherwise. BonusWallet.jsx:161-163. */
export const bonusRecordsLabel = (shown: number, total: number, filtering: boolean): string => {
  const n = filtering ? shown : total;
  return `${filtering ? `${shown} of ${total}` : total} record${n === 1 ? '' : 's'}`;
};

/** The four earnings tiles, in the web's order. BonusWallet.jsx:97-102. */
export const bonusStats = (w: {
  totalReferralEarnings?: Decimal | null;
  totalPartnerEarnings?: Decimal | null;
  totalRevenueShare?: Decimal | null;
  totalBonusRewards?: Decimal | null;
} | null): { label: string; value: Decimal }[] => [
  { label: 'Total Referral Earnings', value: w?.totalReferralEarnings || '0' },
  { label: 'Total Partner Earnings', value: w?.totalPartnerEarnings || '0' },
  { label: 'Total Revenue Share', value: w?.totalRevenueShare || '0' },
  { label: 'Total Bonus Rewards', value: w?.totalBonusRewards || '0' },
];
