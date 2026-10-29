/**
 * The logic behind EquityHub's plan and new-account pages, kept free of
 * React so it can be pinned against the web's own source
 * (src/__tests__/stage2_plans.parity.test.ts):
 *
 *   client/src/pages/Plans.jsx               — subscription plans (Bonus Wallet billing)
 *   client/src/components/BillingHistory.jsx — the plan-period timeline under it
 *   client/src/pages/NewAccountTiers.jsx     — the account-tier picker
 *   client/src/pages/NewAccountConfigure.jsx — mode, nickname, leverage (INR fixed)
 *   client/src/components/LeverageDropdown.jsx
 *   client/src/utils/feeType.js
 *
 * EquityHub is INR-only: every price, balance and charge is rupees, and
 * every account is opened in INR (backend BASE_CURRENCY). Money goes
 * through utils/money, which always prints ₹ with Indian grouping.
 *
 * Two different products share the word "plan" here: a subscription `Plan`
 * (types/subscription — what Plans.jsx sells) and an account tier
 * `AccountPlanDetail` (types/user — what the new-account flow opens). Their
 * functions are kept in separate sections below.
 *
 * Deliberate differences from the web, each asserted by the parity test:
 *   - Money goes through utils/money instead of hand-built `₹` +
 *     toLocaleString / toFixed (the paid-subscribe toast groups 1,200.00).
 *   - Dates use the device locale (PORT-RULINGS §5) with the web's
 *     day / short month / year options, where the web pins 'en-GB'; an
 *     unparseable date is "—", not "Invalid Date".
 *   - The "Below minimum deposit" total counts REAL-MONEY accounts only
 *     (isRealMoney, PORT-RULINGS §3). The web sums every wallet the user
 *     has, so a practice account's ₹1,00,000 seed hid the warning for good.
 */
import type { BillingCycle, Plan, Subscription } from '@/types/subscription';
import { isPostPaidPlan, planPrice } from '@/types/subscription';
import type { Decimal } from '@/types/trading';
import type { AccountPlanDetail } from '@/types/user';
import type { BillingWallet, WalletBalance, WalletTransaction } from '@/types/wallet';
import { isRealMoney } from '@/utils/accountType';
import { CURRENCY, EMPTY, fmtMoney, fmtNum } from '@/utils/money';

/* ══ Shared formatting ═══════════════════════════════════════════════ */

/**
 * A price with 0–2 decimals — Plans.jsx's
 * `₹{Number(price).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`.
 * `₹29`, `₹29.5`, `₹29.99`, `₹1,200`, `₹1,00,000`. The currency argument
 * is kept for callers; it is always rupees.
 */
export const fmtPlanPrice = (value: Decimal | number | null | undefined, currency: string = CURRENCY): string =>
  trimFraction(fmtMoney(value, currency, 2));

/** "29.50" → "29.5", "29.00" → "29"; the dash for a missing figure is left alone. */
function trimFraction(s: string): string {
  if (s === EMPTY) return s;
  return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/** BillingHistory.jsx / Plans.jsx `cap` — "MONTHLY" → "Monthly". */
export const capWord = (s: string | null | undefined): string =>
  (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');

const toDate = (d: Date | string | number | null | undefined): Date | null => {
  if (d == null || d === '') return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isFinite(date.getTime()) ? date : null;
};

/**
 * Plans.jsx / BillingHistory.jsx `fmtDate` — "29 Oct 2026", or "—". The web
 * pins 'en-GB'; the app follows the device locale (PORT-RULINGS §5) with
 * the same options.
 */
export const fmtPlanDate = (d: Date | string | null | undefined): string => {
  const date = toDate(d);
  return date ? date.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : EMPTY;
};

/* ══ Subscription plans — Plans.jsx ══════════════════════════════════ */

/** Which button a pricing card shows. Plans.jsx's card ternary. */
export type PlanAction = 'current' | 'free' | 'postpaid' | 'pay';

export interface PlanCardState {
  isPostPaid: boolean;
  /** The price for the chosen cycle, as the server sent it. */
  price: Decimal;
  priceNum: number;
  isFree: boolean;
  popular: boolean;
  current: boolean;
  canAfford: boolean;
  action: PlanAction;
}

/** One pricing card — Plans.jsx `plans.map((plan) => { … })`. */
export const planCardState = (
  plan: Plan,
  billing: BillingCycle,
  balanceNum: number,
  effectiveCode: string | null | undefined,
): PlanCardState => {
  const isPostPaid = isPostPaidPlan(plan);
  const price = planPrice(plan, billing);
  const priceNum = Number(price || 0);
  const isFree = priceNum === 0 && !isPostPaid;
  const popular = plan.badge === 'Most Popular';
  const current = effectiveCode != null && effectiveCode === plan.code;
  const canAfford = isFree || isPostPaid || balanceNum >= priceNum;
  const action: PlanAction = current ? 'current' : isFree ? 'free' : isPostPaid ? 'postpaid' : 'pay';
  return { isPostPaid, price, priceNum, isFree, popular, current, canAfford, action };
};

/** `Number(subWallet?.balance || 0)` — Plans.jsx `balanceNum`. */
export const billingWalletBalanceNum = (wallet: Pick<BillingWallet, 'balance'> | null | undefined): number =>
  Number(wallet?.balance || 0);

/** The confirm before a Free / Post-Paid switch. Plans.jsx `switchToFree`. */
export const switchPrompt = (plan: Plan): string =>
  (isPostPaidPlan(plan)
    ? `Activate ${plan.name}? You'll be billed per trade plus a monthly maintenance fee.`
    : `Switch to ${plan.name}? Your paid features will end immediately.`);

/** Plans.jsx `switchToFree` success toast. */
export const switchSuccess = (plan: Plan): string =>
  (isPostPaidPlan(plan) ? `${plan.name} activated` : `Switched to ${plan.name}`);

/**
 * The toast after a paid subscribe — Plans.jsx `confirmAndPay`. The web
 * prints `Number(price).toFixed(2)`; utils/money groups it (1,200.00).
 */
export const subscribedToast = (plan: Plan, billing: BillingCycle): string =>
  `Subscribed to ${plan.name} · ${fmtNum(planPrice(plan, billing), 2)} deducted from your Main Wallet`;

/** Plans.jsx `cancel`. */
export const CANCEL_PROMPT =
  'Cancel your subscription? You will be downgraded to Free at the end of your billing period.';

/** The Cancel button: an ACTIVE subscription to anything but Free. */
export const canCancelSubscription = (
  sub: Pick<Subscription, 'status'> | null | undefined,
  effective: Pick<Plan, 'code'> | null | undefined,
): boolean => !!sub && sub.status === 'ACTIVE' && !!effective && effective.code !== 'FREE';

/** Copy-trading bullets are hidden — on the cards and in "Plan Details". */
export const visibleHighlights = (plan: Pick<Plan, 'highlights'>): string[] =>
  plan.highlights.filter((h) => !/copy[\s-]*trading/i.test(h));

/** The "Compare features" rows, in order. */
export const FEATURE_ROWS: ReadonlyArray<{ label: string; value: (p: Plan) => string }> = [
  { label: 'Maintenance fee', value: (p) => (p.features.maintenanceFee ? 'Applies' : 'Zero') },
  { label: 'Trading accounts', value: (p) => (p.limits.maxAccounts == null ? 'Unlimited' : String(p.limits.maxAccounts)) },
  { label: 'All instruments', value: () => '✓' },
  { label: '24/7 access', value: () => '✓' },
  { label: 'API access', value: (p) => (p.features.apiAccess ? '✓' : '—') },
  { label: 'Devices login', value: (p) => (p.limits.maxDevices == null ? 'Unlimited' : String(p.limits.maxDevices)) },
  { label: 'Support', value: (p) => (p.features.customSupport || p.features.postPaid ? 'Dedicated' : 'Standard') },
];

/* ── The Current Subscription card ─────────────────────────────────── */

/**
 * When the plan next bills — Plans.jsx
 * `mySub?.nextBillingAt || mySub?.expiresAt || null`. A postpaid plan has
 * no expiresAt by design (it is billed each cycle, not expired); its date
 * is the next billing anchor.
 */
export const nextBillingDate = (
  sub: Pick<Subscription, 'nextBillingAt' | 'expiresAt'> | null | undefined,
): string | null => sub?.nextBillingAt || sub?.expiresAt || null;

/**
 * Whole days until `d`, rounded up; 0 once it has passed; null without a
 * date — Plans.jsx `daysUntil`.
 */
export const daysUntil = (d: string | Date | null | undefined, now: number = Date.now()): number | null => {
  if (!d) return null;
  const ms = new Date(d).getTime() - now;
  // `ms > 0` is false for NaN too — the web's 0 for an unparseable date.
  return ms > 0 ? Math.ceil(ms / 86400000) : 0;
};

/** "in 1 day" / "in 12 days" / "" — the Next Billing Date sub-line. */
export const inDaysLabel = (n: number | null): string =>
  (n != null ? `in ${n} day${n === 1 ? '' : 's'}` : '');

/** Plans.jsx `isPostPaidEffective`. */
export const isPostPaidEffective = (effective: Pick<Plan, 'code' | 'features'> | null | undefined): boolean =>
  effective?.code === 'POSTPAID' || !!effective?.features?.postPaid;

/** The note under the figures — Plans.jsx `planNote`. */
export const subscriptionPlanNote = (
  effective: Pick<Plan, 'code' | 'features'> | null | undefined,
  sub: Pick<Subscription, 'billingCycle'> | null | undefined,
): string => {
  if (effective?.code === 'FREE') return "You're on the Free plan — no billing.";
  if (isPostPaidEffective(effective)) return 'Pay-as-you-trade — usage charges are deducted from your Main Wallet.';
  return String(sub?.billingCycle).toUpperCase() === 'YEARLY'
    ? 'This is a yearly plan. Amount has been collected in full.'
    : 'This is a monthly plan, billed each cycle from your Main Wallet.';
};

export interface SubscriptionSnapshot {
  startedOn: string;
  nextBilling: string | null;
  nextBillingLabel: string;
  nextBillingSub: string;
  amountCollected: number;
  /** A fully-charged prepaid plan shows what was collected as used. */
  used: number;
  /** Postpaid deposit tracking lives on the wallet; the card shows 0. */
  remainingDeposit: number;
  billingSubtitle: string;
  planNote: string;
}

/** Every figure on the Current Subscription card — Plans.jsx's snapshot block. */
export const subscriptionSnapshot = (
  sub: Subscription | null | undefined,
  effective: Pick<Plan, 'code' | 'features'> | null | undefined,
  now: number = Date.now(),
): SubscriptionSnapshot => {
  const next = nextBillingDate(sub);
  const amountCollected = Number(sub?.lastPayment?.amount || 0);
  return {
    startedOn: fmtPlanDate(sub?.startedAt),
    nextBilling: next,
    nextBillingLabel: next ? fmtPlanDate(next) : 'No expiry',
    nextBillingSub: inDaysLabel(daysUntil(next, now)),
    amountCollected,
    used: amountCollected,
    remainingDeposit: 0,
    billingSubtitle: sub?.billingCycle ? `${capWord(sub.billingCycle)} Subscription` : 'Subscription',
    planNote: subscriptionPlanNote(effective, sub),
  };
};

/* ── Paying for a plan ─────────────────────────────────────────────── */

export interface PayPreview {
  price: number;
  balance: number;
  after: number;
  canAfford: boolean;
  /** Always INR — the Bonus Wallet is rupees. */
  currency: string;
}

/**
 * The confirm-subscription modal's figures — Plans.jsx ConfirmPayModal.
 * The billing wallet has no `free` (subscriptionController.mySubscription
 * sends none), so the web's `wallet?.free || wallet?.balance` is the balance.
 */
export const payPreview = (
  plan: Plan,
  billing: BillingCycle,
  wallet: Pick<BillingWallet, 'balance'> | null | undefined,
): PayPreview => {
  const price = Number(planPrice(plan, billing));
  const balance = Number(wallet?.balance || 0);
  return {
    price,
    balance,
    after: balance - price,
    canAfford: balance >= price,
    currency: CURRENCY,
  };
};

/** The recharge prompt a 402 INSUFFICIENT_SUBSCRIPTION_BALANCE opens. */
export interface RechargePrompt {
  plan: Plan;
  billing: BillingCycle;
  balance: Decimal;
  needed: Decimal;
  shortfall: Decimal;
  currency: string;
}

/* ══ Billing & Subscription History — BillingHistory.jsx ═════════════ */

export type PeriodStatus = 'ACTIVE' | 'CANCELLED' | 'ENDED';

/** One plan period on the timeline, newest first. */
export interface BillingPeriod {
  id: string;
  start: Date;
  end: Date | null;
  days: number | null;
  code: string;
  planName: string;
  cycle: string;
  badges: string[];
  description: string;
  subtitle: string;
  amount: number;
  currency: string;
  status: PeriodStatus;
  isPostpaid: boolean;
  isCurrent: boolean;
  /** The charge behind the period; null for the synthetic current row. */
  t: BillingCharge | null;
}

/** The plan-billing transaction fields the timeline reads. */
export type BillingCharge = Pick<WalletTransaction, 'id' | 'transactionType' | 'reason' | 'amount' | 'currency' | 'planCode' | 'billingCycle' | 'note' | 'createdAt'>;
type PeriodPlan = Pick<Plan, 'code' | 'name' | 'features'>;
type PeriodSub = Pick<Subscription, 'planCode' | 'status' | 'nextBillingAt' | 'expiresAt' | 'startedAt' | 'billingCycle' | 'lastPayment'>;

/** A postpaid charge: by its note, or by a plan code containing POST. */
export const isPostpaidTxn = (t: Pick<WalletTransaction, 'note' | 'planCode'>): boolean =>
  /postpaid/i.test(t.note || '') || String(t.planCode || '').toUpperCase().includes('POST');

/** The web's standard postpaid rates, used only to itemize an expanded row. */
export const POSTPAID_UNIT_RATES = { device: 2, account: 4 } as const;

export interface PostpaidLine {
  desc: string;
  qty: number;
  unit: number;
  tax: number;
}

/**
 * Itemize a postpaid charge from its note ("Postpaid usage · 2 device(s) +
 * 3 account(s) (min ₹25)") — BillingHistory.jsx `postpaidLines`, regexes
 * and all. Its minimum pattern (`min\s*\$?([\d.]+)`) predates the rupee
 * notes, so against the server's "min ₹25" it finds nothing and the
 * detail falls back to the amount charged — the web does exactly that.
 */
export const postpaidLines = (
  t: { note?: string | null; amount?: Decimal | number | null },
): { lines: PostpaidLine[]; min: number } => {
  const note = t.note || '';
  const dev = Number((note.match(/(\d+)\s*device/i) || [])[1] || 0);
  const acc = Number((note.match(/(\d+)\s*account/i) || [])[1] || 0);
  const lines: PostpaidLine[] = [];
  if (dev) lines.push({ desc: 'Device logins', qty: dev, unit: POSTPAID_UNIT_RATES.device, tax: 0 });
  if (acc) lines.push({ desc: 'Trading accounts', qty: acc, unit: POSTPAID_UNIT_RATES.account, tax: 0 });
  if (!lines.length) lines.push({ desc: note || 'Postpaid charge', qty: 1, unit: Math.abs(Number(t.amount) || 0), tax: 0 });
  const min = Number((note.match(/min\s*\$?([\d.]+)/i) || [])[1] || 0);
  return { lines, min };
};

/**
 * Reconstruct the plan-period timeline — BillingHistory.jsx `buildPeriods`.
 *
 * The backend keeps ONE subscription document per user, so past periods
 * are rebuilt from the plan charges on /subscriptions/history (Bonus Wallet
 * rows now, old Main Wallet rows before it was retired: SUBSCRIPTION_CHARGE /
 * RENEWAL debits), chained oldest to newest, joined with the plan
 * catalogue for names and with the current subscription for the period
 * running now. `now` stands in for the web's `new Date()` when the current
 * subscription has no start date.
 */
export const buildPeriods = (
  txns: ReadonlyArray<BillingCharge> | null | undefined,
  currentSub: PeriodSub | null | undefined,
  plans: ReadonlyArray<PeriodPlan> | null | undefined,
  now: Date = new Date(),
): BillingPeriod[] => {
  const planByCode = new Map((plans || []).map((p) => [String(p.code).toUpperCase(), p]));
  const nameOf = (code: string | null | undefined): string =>
    planByCode.get(String(code || '').toUpperCase())?.name || String(code || 'Plan').replace(/_/g, ' ');
  const at = (s: string | null | undefined): Date => new Date(s ?? '');

  const charges = (txns || [])
    .filter((t) => t.transactionType === 'DEBIT' && (t.reason === 'SUBSCRIPTION_CHARGE' || t.reason === 'RENEWAL'))
    .slice()
    .sort((a, b) => at(a.createdAt).getTime() - at(b.createdAt).getTime()); // ascending, to chain periods

  const curCode = currentSub ? String(currentSub.planCode || '').toUpperCase() : '';
  const curActive = !!currentSub && String(currentSub.status || '').toUpperCase() === 'ACTIVE';
  // A postpaid plan never sets expiresAt; its period ends at the next
  // billing anchor, which subscribe() seeds one cycle out.
  const curCycleEnd = currentSub ? (currentSub.nextBillingAt || currentSub.expiresAt || null) : null;

  interface Draft {
    t: BillingCharge | null;
    start: Date;
    end: Date | null;
    code: string;
    cycle: string;
    pp: boolean;
    prevCode: string | null;
    isLast: boolean;
    amount: number;
    currency: string;
  }

  const rows: Draft[] = charges.map((t, i) => {
    const start = at(t.createdAt);
    const following = charges[i + 1];
    const next = following ? at(following.createdAt) : null;
    const isLast = i === charges.length - 1;
    // A charge written before planCode was recorded has none; the newest
    // one paid for the plan running now, so it adopts the current code.
    const code = String(t.planCode || '').toUpperCase() || (isLast && curActive ? curCode : '');
    const plan = planByCode.get(code);
    const pp = isPostpaidTxn(t) || !!plan?.features?.postPaid;
    const cycle = pp ? 'MONTHLY' : String(t.billingCycle || 'MONTHLY').toUpperCase();
    let end = next;
    if (!end && isLast && curActive && code === curCode && curCycleEnd) end = new Date(curCycleEnd);
    const before = i > 0 ? charges[i - 1] : undefined;
    const prevCode = before ? String(before.planCode || '').toUpperCase() : null;
    return { t, start, end, code, cycle, pp, prevCode, isLast, amount: Math.abs(Number(t.amount) || 0), currency: t.currency || CURRENCY };
  });

  const mkRow = (r: Draft, isCurrent: boolean): BillingPeriod => {
    const days = r.end ? Math.max(0, Math.round((r.end.getTime() - r.start.getTime()) / 86400000)) : null;
    const status: PeriodStatus = isCurrent ? 'ACTIVE' : r.code === 'FREE' ? 'ENDED' : 'CANCELLED';
    const subtitle = r.pp ? 'Postpaid Used'
      : r.code === 'FREE' ? 'Welcome Plan'
        : r.cycle === 'YEARLY' ? 'Yearly Subscription'
          : r.prevCode ? `Upgraded from ${nameOf(r.prevCode)}` : 'Monthly Subscription';
    const description = r.pp ? 'Postpaid Plan'
      : r.code === 'FREE' ? 'Free Plan'
        : `${nameOf(r.code)} ${capWord(r.cycle)} Plan`;
    const badges = r.code === 'FREE' ? ['FREE'] : [r.code, r.cycle].filter(Boolean);
    return {
      id: r.t?.id || `${r.code}-${r.start.getTime()}`,
      start: r.start,
      end: r.end,
      days,
      code: r.code,
      planName: nameOf(r.code),
      cycle: r.cycle,
      badges,
      description,
      subtitle,
      amount: r.amount,
      currency: r.currency,
      status,
      isPostpaid: r.pp,
      isCurrent,
      t: r.t,
    };
  };

  const periods = rows.map((r) => mkRow(r, r.isLast && curActive && r.code === curCode));

  // The plan running now has no matching charge (Free, a fresh activation)? Add it.
  if (curActive && currentSub && !periods.some((p) => p.isCurrent)) {
    const plan = planByCode.get(curCode);
    const pp = !!plan?.features?.postPaid;
    periods.push(mkRow({
      t: null,
      start: currentSub.startedAt ? new Date(currentSub.startedAt) : new Date(now.getTime()),
      end: curCycleEnd ? new Date(curCycleEnd) : null,
      code: curCode,
      cycle: pp ? 'MONTHLY' : String(currentSub.billingCycle || 'MONTHLY').toUpperCase(),
      pp,
      prevCode: null,
      isLast: true,
      amount: Number(currentSub.lastPayment?.amount || 0),
      currency: currentSub.lastPayment?.currency || CURRENCY,
    }, true));
  }

  periods.sort((a, b) => b.start.getTime() - a.start.getTime()); // newest first
  return periods;
};

/* ── Filters (staged: picked, then applied) ────────────────────────── */

export type HistoryTypeFilter = 'all' | 'subscription' | 'postpaid';
export type HistoryStatusFilter = 'all' | 'active' | 'cancelled' | 'ended';
export type HistoryBillingFilter = 'all' | 'monthly' | 'yearly' | 'postpaid';

export interface HistoryFilters {
  /** YYYY-MM-DD or ''. */
  from: string;
  to: string;
  type: HistoryTypeFilter;
  status: HistoryStatusFilter;
  billingType: HistoryBillingFilter;
  onlyCurrent: boolean;
}

/** BillingHistory.jsx `BLANK`. */
export const BLANK_HISTORY_FILTERS: Readonly<HistoryFilters> = Object.freeze({
  from: '', to: '', type: 'all', status: 'all', billingType: 'all', onlyCurrent: false,
});

/** The filter selects' options, in the web's order and words. */
export const HISTORY_TYPE_OPTIONS: ReadonlyArray<{ value: HistoryTypeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'subscription', label: 'Subscription' },
  { value: 'postpaid', label: 'Postpaid' },
];
export const HISTORY_STATUS_OPTIONS: ReadonlyArray<{ value: HistoryStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'ended', label: 'Ended' },
];
export const HISTORY_BILLING_OPTIONS: ReadonlyArray<{ value: HistoryBillingFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'postpaid', label: 'Postpaid' },
];

/** Rows per page — the web's select. */
export const HISTORY_PAGE_SIZES: readonly number[] = [10, 25, 50, 100];

/** Whether any applied filter narrows the list — it changes the empty-state wording. */
export const hasHistoryFilters = (f: HistoryFilters): boolean =>
  !!(f.from || f.to || f.type !== 'all' || f.status !== 'all' || f.billingType !== 'all' || f.onlyCurrent);

/**
 * The applied filters — BillingHistory.jsx `filtered`. Dates are local
 * days, inclusive at both ends (00:00:00 to 23:59:59).
 */
export const filterPeriods = (
  periods: ReadonlyArray<BillingPeriod>,
  f: HistoryFilters,
  currentPlanCode: string | null | undefined,
): BillingPeriod[] => {
  const fromT = f.from ? new Date(`${f.from}T00:00:00`).getTime() : -Infinity;
  const toT = f.to ? new Date(`${f.to}T23:59:59`).getTime() : Infinity;
  const curCode = String(currentPlanCode || '').toUpperCase();
  return periods
    .filter((p) => { const ts = p.start.getTime(); return ts >= fromT && ts <= toT; })
    .filter((p) => f.type === 'all' || (f.type === 'postpaid' ? p.isPostpaid : !p.isPostpaid))
    .filter((p) => f.status === 'all' || p.status.toLowerCase() === f.status)
    .filter((p) => f.billingType === 'all' || (f.billingType === 'postpaid' ? p.isPostpaid : p.cycle.toUpperCase() === f.billingType.toUpperCase()))
    .filter((p) => !f.onlyCurrent || p.isCurrent || (!!curCode && p.code === curCode));
};

/** "Total Billing" — every charged amount on the filtered timeline. */
export const totalBilling = (periods: ReadonlyArray<Pick<BillingPeriod, 'amount'>>): number =>
  periods.reduce((s, p) => s + (Number(p.amount) || 0), 0);

/** `−₹1,234.00` — the header figure is always shown as a debit, zero too. */
export const totalBillingLabel = (total: number): string => `−${fmtMoney(total)}`;

/** A period's amount: `₹0.00` when nothing was charged, else `−₹29.99`. */
export const periodAmountLabel = (amount: number): string =>
  (Number(amount) === 0 ? fmtMoney(0) : `−${fmtMoney(amount)}`);

/** "01 Sept 2026 → 01 Oct 2026", or "… → now" for an open period. */
export const periodRangeLabel = (p: Pick<BillingPeriod, 'start' | 'end'>): string =>
  `${fmtPlanDate(p.start)} → ${p.end ? fmtPlanDate(p.end) : 'now'}`;

/** "(30 days)" / "" — the Billing Period column's second line. */
export const periodDaysLabel = (days: number | null): string => (days != null ? `(${days} days)` : '');

/** The status pill — Active / Cancelled / Ended, and its tone. */
export const periodStatusLabel = (status: string): string => capWord(status);
export const periodStatusTone = (status: string): 'bull' | 'warn' | 'neutral' =>
  (status === 'ACTIVE' ? 'bull' : status === 'CANCELLED' ? 'warn' : 'neutral');

/** The empty table row. */
export const emptyHistoryLabel = (filtered: boolean): string =>
  `No subscription history${filtered ? ' matches these filters' : ' yet'}.`;

export interface HistoryPage<T> {
  totalPages: number;
  /** The page shown — clamped to the last page. */
  page: number;
  rows: T[];
  /** 1-based first / last record shown; 0 / 0 when there are none. */
  from: number;
  to: number;
  count: number;
}

/** BillingHistory.jsx's pagination arithmetic. */
export const paginate = <T,>(list: ReadonlyArray<T>, page: number, rows: number): HistoryPage<T> => {
  const totalPages = Math.max(1, Math.ceil(list.length / rows));
  const pageC = Math.min(page, totalPages);
  const startIdx = (pageC - 1) * rows;
  return {
    totalPages,
    page: pageC,
    rows: list.slice(startIdx, startIdx + rows),
    from: list.length ? startIdx + 1 : 0,
    to: Math.min(startIdx + rows, list.length),
    count: list.length,
  };
};

/** "Showing 1 to 10 of 23 records" / "Showing 0 records". */
export const showingLabel = (pg: Pick<HistoryPage<unknown>, 'count' | 'from' | 'to'>): string =>
  (pg.count === 0 ? 'Showing 0 records' : `Showing ${pg.from} to ${pg.to} of ${pg.count} records`);

/**
 * The page buttons: every page up to 7, else the first, the last, the
 * current one and its neighbours, with "…" for the gaps.
 */
export const pageNumbers = (page: number, totalPages: number): Array<number | '…'> => {
  const out: Array<number | '…'> = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) out.push(i);
    return out;
  }
  out.push(1);
  const lo = Math.max(2, page - 1);
  const hi = Math.min(totalPages - 1, page + 1);
  if (lo > 2) out.push('…');
  for (let i = lo; i <= hi; i++) out.push(i);
  if (hi < totalPages - 1) out.push('…');
  out.push(totalPages);
  return out;
};

/** A requested page, kept inside 1…totalPages. */
export const clampPage = (n: number, totalPages: number): number => Math.min(Math.max(1, n), totalPages);

export interface PostpaidDetail {
  chargedAt: Date | string | null;
  lines: PostpaidLine[];
  usage: number;
  /** "Minimum Deposit (Collected)" — the note's minimum, else the amount charged. */
  minDep: number;
  remaining: number;
  exhausted: boolean;
}

/** A postpaid row's expanded detail — BillingHistory.jsx PostpaidDetail. */
export const postpaidDetail = (p: Pick<BillingPeriod, 't' | 'start' | 'amount'>): PostpaidDetail => {
  const t = p.t ?? { createdAt: null, note: '', amount: String(p.amount) };
  const { lines, min } = postpaidLines(t);
  const usage = lines.reduce((s, l) => s + l.qty * l.unit + l.tax, 0);
  const minDep = min > 0 ? min : Number(p.amount) || 0;
  const remaining = Math.max(0, minDep - usage);
  return {
    // The synthetic current row has no charge; the web dates it at the period start.
    chargedAt: p.t ? p.t.createdAt : p.start,
    lines,
    usage,
    minDep,
    remaining,
    exhausted: remaining <= 0,
  };
};

/* ══ Account tiers — NewAccountTiers.jsx ═════════════════════════════ */

/** Accounts per tier code — NewAccountTiers.jsx `usage`. */
export const usageByType = (accounts: ReadonlyArray<{ accountType: string }>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const a of accounts) out[a.accountType] = (out[a.accountType] ?? 0) + 1;
  return out;
};

export interface TierGroup<P> {
  title: string;
  plans: P[];
}

/**
 * The catalogue bucketed into named sections; codes outside the canonical
 * six get "Other" so they stay visible. NewAccountTiers.jsx `groups`.
 */
export const groupTiers = <P extends { code: string }>(plans: ReadonlyArray<P>): TierGroup<P>[] => {
  const standard: P[] = [];
  const professional: P[] = [];
  const free: P[] = [];
  const other: P[] = [];
  for (const p of plans) {
    if (p.code === 'STANDARD' || p.code === 'STANDARD_IC') standard.push(p);
    else if (p.code === 'PRO' || p.code === 'PRO_IC') professional.push(p);
    else if (p.code === 'FREE' || p.code === 'FREE_IC') free.push(p);
    else other.push(p);
  }
  return [
    { title: 'Standard accounts', plans: standard },
    { title: 'Professional accounts', plans: professional },
    { title: 'Free accounts', plans: free },
    ...(other.length ? [{ title: 'Other', plans: other }] : []),
  ].filter((g) => g.plans.length);
};

/** NewAccountTiers.jsx `tintForCode`. */
export const tintForCode = (code: string | null | undefined): string => {
  if (!code) return '#64748B';
  if (code.startsWith('FREE')) return '#10B981';
  if (code.startsWith('PRO')) return '#1D4ED8';
  return '#64748B';
};

/** A tier row's accent. */
export const tierAccent = (plan: Pick<AccountPlanDetail, 'accentColor' | 'code'>): string =>
  plan.accentColor || tintForCode(plan.code);

/** The two-letter tile. */
export const tierInitials = (plan: Pick<AccountPlanDetail, 'name' | 'code'>): string =>
  (plan.name || plan.code || 'A').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();

export const tierMinDeposit = (plan: Pick<AccountPlanDetail, 'minDeposit'>): number =>
  Number(plan.minDeposit || 0);

/** `₹1,000` / `No min` — `fmtMoney(minDep, 'INR', 0)`, whole rupees. */
export const tierMinDepositLabel = (plan: Pick<AccountPlanDetail, 'minDeposit'>): string => {
  const minDep = tierMinDeposit(plan);
  return minDep > 0 ? fmtMoney(minDep, CURRENCY, 0) : 'No min';
};

/** `1:100` / `1:Unlimited` — a missing (or zero) cap is unlimited. */
export const tierLeverageLabel = (maxLeverage: number | null | undefined): string =>
  (maxLeverage ? `1:${maxLeverage}` : '1:Unlimited');

/* utils/feeType.js — presentation only; internal codes never change. */
const FEE_TYPE_META: Readonly<Record<string, { group: string; label: string }>> = {
  PERCENTAGE: { group: 'Commission', label: 'Percentage' },
  PCT_OF_VALUE: { group: 'Commission', label: 'Percentage' },
  FIXED: { group: 'Charges', label: 'Fixed' },
  FIXED_PER_TRADE: { group: 'Charges', label: 'Fixed' },
  PCT_OF_PROFIT: { group: 'Charges', label: 'Percentage of Profit' },
};

export const feeTypeMeta = (code: string | null | undefined): { group: string; label: string } | null =>
  FEE_TYPE_META[String(code || '').toUpperCase()] ?? null;

/** "Commission · Percentage" / "Charges · Fixed" / "" when unknown. */
export const feeTypeText = (code: string | null | undefined): string => {
  const m = feeTypeMeta(code);
  return m ? `${m.group} · ${m.label}` : '';
};

/** The grouped label plus the admin's free-text detail. utils/feeType.js. */
export const feeTypeWithDetail = (code: string | null | undefined, detail: string | null | undefined): string => {
  const text = feeTypeText(code);
  if (text && detail) return `${text} — ${detail}`;
  return text || detail || '—';
};

export const tierCommission = (plan: Pick<AccountPlanDetail, 'feeKind' | 'feeDisplay'>): string =>
  feeTypeWithDetail(plan.feeKind, plan.feeDisplay);

export interface FeatureChip {
  label: string;
  tone: 'warn' | 'bull' | 'neutral';
}

/** Buy/Sell · instruments · access · support — NewAccountTiers.jsx FeatureChips. */
export const tierFeatureChips = (
  plan: Pick<AccountPlanDetail, 'buyCloseOnly' | 'instrumentsLabel' | 'accessLabel' | 'supportLabel'>,
): FeatureChip[] => [
  plan.buyCloseOnly
    ? { label: 'Buy-close only', tone: 'warn' }
    : { label: 'Buy / Sell · no restrictions', tone: 'bull' },
  { label: plan.instrumentsLabel || 'All instruments', tone: 'neutral' },
  { label: plan.accessLabel || '24/7 access', tone: 'neutral' },
  { label: plan.supportLabel || 'Standard support', tone: 'neutral' },
];

/** The first tier, preselected so Continue works at once. */
export const defaultTierSelection = (
  plans: ReadonlyArray<{ code: string }>,
  current: string | null,
): string | null => {
  if (current && plans.some((p) => p.code === current)) return current;
  return plans[0]?.code ?? null;
};

/* ══ Leverage — LeverageDropdown.jsx ═════════════════════════════════ */

export const LEVERAGE_LADDER: readonly number[] = [1, 2, 5, 10, 20, 50, 100, 200, 400, 500, 600, 800, 1000, 2000];
/** How the server and the web spell "1:Unlimited". */
export const UNLIMITED_LEVERAGE = 999999;

export type LeverageOption =
  | { kind: 'CUSTOM'; label: 'Custom' }
  | { kind: 'FIXED'; value: number }
  | { kind: 'UNLIMITED'; label: '1:Unlimited' };

/** Custom, the ladder, Unlimited. */
export const LEVERAGE_OPTIONS: readonly LeverageOption[] = [
  { kind: 'CUSTOM', label: 'Custom' },
  ...LEVERAGE_LADDER.map((value): LeverageOption => ({ kind: 'FIXED', value })),
  { kind: 'UNLIMITED', label: '1:Unlimited' },
];

/** A finite positive cap, or null = no cap. null/0/NaN/negative all mean uncapped. */
export const leverageCap = (maxLeverage: unknown): number | null => {
  const capNum = Number(maxLeverage);
  return maxLeverage != null && Number.isFinite(capNum) && capNum > 0 ? capNum : null;
};

/** Options above the cap are locked; Unlimited is locked under any cap. */
export const isLeverageLocked = (opt: LeverageOption, cap: number | null): boolean => {
  if (cap == null) return false;
  if (opt.kind === 'FIXED') return opt.value > cap;
  if (opt.kind === 'UNLIMITED') return true;
  return false;
};

export const leverageOptionLabel = (opt: LeverageOption): string =>
  (opt.kind === 'FIXED' ? `1:${opt.value}` : opt.label);

export const isLeverageOptionSelected = (opt: LeverageOption, value: number, custom: boolean): boolean =>
  (!custom && (
    (opt.kind === 'FIXED' && opt.value === value)
    || (opt.kind === 'UNLIMITED' && value >= UNLIMITED_LEVERAGE)
  )) || (custom && opt.kind === 'CUSTOM');

/**
 * The trigger's text. Under a cap it never says "1:Unlimited", even during
 * the tick before the snap-down lands.
 */
export const leverageDisplay = (value: number, custom: boolean, cap: number | null): string => {
  if (custom) return `Custom · 1:${value}`;
  if (cap == null && value >= UNLIMITED_LEVERAGE) return '1:Unlimited';
  return `1:${cap != null ? Math.min(Number(value) || 1, cap) : value}`;
};

/** The Custom field's value: at least 1, at most the cap. */
export const clampCustomLeverage = (text: string, cap: number | null): number => {
  let v = Number(text) || 1;
  if (v < 1) v = 1;
  if (cap != null && v > cap) v = cap;
  return v;
};

/** The value to snap to when it sits above the cap, else null. */
export const leverageSnapTarget = (value: number, cap: number | null): number | null =>
  (cap != null && Number(value) > cap ? cap : null);

/* ══ Configure a new account — NewAccountConfigure.jsx ══════════════ */

export type AccountMode = 'REAL' | 'DEMO';

/** EquityHub is INR-only: every account is rupee-denominated, so the base currency is fixed. */
export const ACCOUNT_BASE_CURRENCY = 'INR';

/** The read-only Base currency field. */
export const ACCOUNT_BASE_CURRENCY_LABEL = 'INR (₹)';

/** The virtual balance a new demo account starts with (INR) — `DEMO_SEED_INR`. */
export const DEMO_SEED_INR = 100000;

/** "Real funds vs. virtual practice money. … start with a ₹1,00,000 virtual seed." */
export const ACCOUNT_MODE_DESC =
  `Real funds vs. virtual practice money. Demo accounts skip tier rules and start with a ${fmtMoney(DEMO_SEED_INR, CURRENCY, 0)} virtual seed.`;

/** Tier cap if there is one, otherwise Unlimited — the on-load and on-submit default. */
export const tierDefaultLeverage = (plan: Pick<AccountPlanDetail, 'maxLeverage'>): number =>
  (plan.maxLeverage != null ? plan.maxLeverage : UNLIMITED_LEVERAGE);

/** Demo snaps to Unlimited; Real restores the tier default. */
export const leverageForMode = (plan: Pick<AccountPlanDetail, 'maxLeverage'>, mode: AccountMode): number =>
  (mode === 'DEMO' ? UNLIMITED_LEVERAGE : tierDefaultLeverage(plan));

/** Keep the nickname in step with the mode unless the user typed their own. */
export const syncNickname = (curr: string, plan: Pick<AccountPlanDetail, 'name'>, mode: AccountMode): string => {
  const defaults = [plan.name, `${plan.name} Practice`];
  if (!curr || defaults.includes(curr)) {
    return mode === 'DEMO' ? `${plan.name} Practice` : plan.name;
  }
  return curr;
};

/** FREE green, everything else primary blue. */
export const configureAccent = (plan: Pick<AccountPlanDetail, 'accentColor' | 'code'>): string =>
  plan.accentColor
  || (plan.code.startsWith('FREE') ? '#10B981'
    : plan.code.startsWith('PRO') ? '#1D4ED8'
      : '#1D4ED8');

/** The demo mode's fixed green. */
export const DEMO_ACCENT = '#10B981';

/** Exactly the body the web posts to /user/accounts. */
export interface NewAccountPayload {
  accountType: string;
  /** Demo only: the tier it was opened from, so the UI names it (not "Standard"). */
  tierCode?: string;
  baseCurrency: string;
  leverage: number;
  nickname: string;
  /** Demo only: the ₹1,00,000 practice seed. */
  initialBalance?: number;
}

/**
 * NewAccountConfigure.jsx `create()`'s payload, key for key and in order.
 * Demo: DEMO with the chosen tier kept in `tierCode`, always 1:Unlimited,
 * the ₹1,00,000 seed. Real: the tier code, the chosen leverage (or the tier
 * default) and the trimmed nickname (or the tier name). Both send INR —
 * the server stores its BASE_CURRENCY (INR) whatever is asked.
 */
export const buildNewAccountPayload = (p: {
  plan: Pick<AccountPlanDetail, 'code' | 'name' | 'maxLeverage'>;
  mode: AccountMode;
  nickname: string;
  leverage: number;
}): NewAccountPayload => {
  const defaultLev = tierDefaultLeverage(p.plan);
  if (p.mode === 'DEMO') {
    return {
      accountType: 'DEMO',
      tierCode: p.plan.code,
      baseCurrency: ACCOUNT_BASE_CURRENCY,
      leverage: UNLIMITED_LEVERAGE,
      nickname: p.nickname.trim() || `${p.plan.name} Practice`,
      initialBalance: DEMO_SEED_INR,
    };
  }
  return {
    accountType: p.plan.code,
    baseCurrency: ACCOUNT_BASE_CURRENCY,
    leverage: Number(p.leverage) || defaultLev,
    nickname: p.nickname.trim() || p.plan.name,
  };
};

/** The success toast. */
export const accountCreatedToast = (plan: Pick<AccountPlanDetail, 'name'>, mode: AccountMode): string =>
  `${mode === 'DEMO' ? 'Demo' : plan.name} account created`;

/** An unknown tier code. */
export const planNotFoundMessage = (tierCode: string): string => `Plan "${tierCode}" not found`;

/**
 * What the user holds in real money, summed across their accounts' wallets.
 *
 * DIFFERS FROM THE WEB ON PURPOSE. NewAccountConfigure.jsx sums every
 * wallet of every account, practice accounts included, so anyone with a
 * demo account (seeded with ₹1,00,000) never saw "Below minimum deposit".
 * Demo-ness is decided by utils/accountType, the one predicate (PORT-RULINGS §3).
 */
export const realMoneyTotal = (
  accounts: ReadonlyArray<{ id: string; accountType: string }>,
  balances: ReadonlyArray<Pick<WalletBalance, 'accountId' | 'balance'>>,
): number => {
  const real = new Set(accounts.filter((a) => isRealMoney(a.accountType)).map((a) => a.id));
  return balances.reduce((sum, b) => (real.has(b.accountId) ? sum + (Number(b.balance) || 0) : sum), 0);
};

export interface MinDepositCheck {
  minDep: number;
  shortfall: number;
  belowMin: boolean;
  /** The leverage cap the picker locks above; null under Demo or an uncapped tier. */
  tierCap: number | null;
}

/** The below-minimum warning and the tier cap. */
export const minDepositCheck = (
  plan: Pick<AccountPlanDetail, 'minDeposit' | 'maxLeverage'>,
  mode: AccountMode,
  totalBalance: number,
): MinDepositCheck => {
  const isDemo = mode === 'DEMO';
  const minDep = Number(plan.minDeposit || 0);
  return {
    minDep,
    shortfall: minDep - totalBalance,
    belowMin: !isDemo && minDep > 0 && totalBalance < minDep,
    tierCap: isDemo ? null : (plan.maxLeverage || null),
  };
};

/** "Min ₹100 · 1:100 · Fee Commission · Percentage — 0.005% of trade value". */
export const tierSummaryLine = (plan: AccountPlanDetail): string =>
  `Min ${fmtMoney(tierMinDeposit(plan), CURRENCY, 0)} · ${tierLeverageLabel(plan.maxLeverage)} · Fee ${tierCommission(plan)}`;

/** The below-minimum note's three figures. */
export const belowMinFigures = (totalBalance: number, minDep: number, shortfall: number): { balance: string; needs: string; shortfall: string } => ({
  balance: fmtMoney(totalBalance),
  needs: fmtMoney(minDep, CURRENCY, 0),
  shortfall: fmtMoney(shortfall),
});
