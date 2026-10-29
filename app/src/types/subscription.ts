/**
 * Subscription plans — the product the user BUYS (Free / Premium / VIP /
 * Post-Paid), billed from the Bonus Wallet.
 *
 * Not to be confused with an AccountPlan (types/trading), which is the TIER
 * of one trading account. Two products, two admin screens; they share a
 * word in English and nothing else.
 *
 * EquityHub is INR-only (backend BASE_CURRENCY): prices, rates and payments
 * are rupees, so a missing currency reads as INR.
 */
import { bool, dec, id, num, str, strOrNull } from '@/types/api';
import type { Decimal } from '@/types/trading';
import { toBillingWallet, type BillingWallet } from '@/types/wallet';

type Raw = Record<string, unknown>;

const asRecord = (v: unknown): Raw =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

export type BillingCycle = 'MONTHLY' | 'YEARLY';

export interface PlanLimits {
  /** null is UNLIMITED (Post-Paid). */
  maxAccounts: number | null;
  /** Concurrent signed-in devices; null is unlimited. */
  maxDevices: number | null;
  defaultLeverage: number | null;
  withdrawalDailyLimit: Decimal | null;
}

export interface PlanFeatures {
  /** A fraction, 0.20 = 20% off. */
  feeDiscountPercent: Decimal;
  apiAccess: boolean;
  prioritySupport: boolean;
  copyTradingEnabled: boolean;
  affiliateBonus: Decimal;
  customSupport: boolean;
  postPaid: boolean;
  maintenanceFee: boolean;
}

export interface PostPaidRates {
  perDevicePerMonth: Decimal;
  perAccountPerMonth: Decimal;
  minimumMonthlyFee: Decimal;
  currency: string;
}

export interface BillingDays {
  monthly: number;
  yearly: number;
  unit: 'MINUTES' | 'HOURS' | 'DAYS' | (string & {});
}

export interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** INR. */
  monthlyPrice: Decimal;
  yearlyPrice: Decimal;
  billingDays: BillingDays;
  isActive: boolean;
  sortOrder: number;
  limits: PlanLimits;
  features: PlanFeatures;
  postPaidRates: PostPaidRates;
  /** Bullet points the pricing card lists. */
  highlights: string[];
  badge: string | null;
  /** Plans.jsx reads a long tail of optional fields; they stay reachable. */
  raw: Record<string, unknown>;
}

export const toPlan = (body: unknown): Plan => {
  const raw = asRecord(body);
  const limits = asRecord(raw.limits);
  const features = asRecord(raw.features);
  const rates = asRecord(raw.postPaidRates);
  const days = asRecord(raw.billingDays);
  return {
    id: id(raw),
    code: str(raw.code).toUpperCase(),
    name: str(raw.name) || str(raw.code),
    description: strOrNull(raw.description),
    monthlyPrice: dec(raw.monthlyPrice),
    yearlyPrice: dec(raw.yearlyPrice),
    billingDays: {
      monthly: num(days.monthly) ?? 30,
      yearly: num(days.yearly) ?? 365,
      unit: str(days.unit) || 'DAYS',
    },
    isActive: raw.isActive !== false,
    sortOrder: num(raw.sortOrder) ?? 0,
    limits: {
      // A present-but-null cap is UNLIMITED; num() keeps it null, not zero.
      maxAccounts: num(limits.maxAccounts),
      maxDevices: num(limits.maxDevices),
      defaultLeverage: num(limits.defaultLeverage),
      withdrawalDailyLimit: limits.withdrawalDailyLimit == null ? null : dec(limits.withdrawalDailyLimit),
    },
    features: {
      feeDiscountPercent: dec(features.feeDiscountPercent),
      apiAccess: bool(features.apiAccess),
      prioritySupport: bool(features.prioritySupport),
      copyTradingEnabled: bool(features.copyTradingEnabled),
      affiliateBonus: dec(features.affiliateBonus),
      customSupport: bool(features.customSupport),
      postPaid: bool(features.postPaid),
      maintenanceFee: bool(features.maintenanceFee),
    },
    postPaidRates: {
      perDevicePerMonth: dec(rates.perDevicePerMonth),
      perAccountPerMonth: dec(rates.perAccountPerMonth),
      minimumMonthlyFee: dec(rates.minimumMonthlyFee),
      currency: str(rates.currency) || 'INR',
    },
    highlights: Array.isArray(raw.highlights)
      ? raw.highlights.filter((h): h is string => typeof h === 'string' && h.trim() !== '')
      : [],
    badge: strOrNull(raw.badge),
    raw,
  };
};

/** The price for a cycle. Plans.jsx:104 — YEARLY takes yearlyPrice, else monthly. */
export const planPrice = (plan: Pick<Plan, 'monthlyPrice' | 'yearlyPrice'>, cycle: BillingCycle): Decimal =>
  (cycle === 'YEARLY' ? plan.yearlyPrice : plan.monthlyPrice);

/**
 * Post-Paid is billed per trade, so activating it moves no money and the
 * web switches to it with a confirm, not the pay-from-wallet modal.
 * Plans.jsx:65.
 */
export const isPostPaidPlan = (plan: Pick<Plan, 'code' | 'features'>): boolean =>
  plan.code === 'POSTPAID' || plan.features.postPaid;

/**
 * Which path a plan switch takes. A plan that costs nothing on activation —
 * Free, or Post-Paid — is a plain switch; anything with a price for the
 * chosen cycle debits the Bonus Wallet and gets the confirmation modal.
 */
export const planNeedsPayment = (plan: Plan, cycle: BillingCycle): boolean =>
  !isPostPaidPlan(plan) && Number(planPrice(plan, cycle)) > 0;

export type SubscriptionStatus = 'ACTIVE' | 'CANCELLED' | 'EXPIRED' | 'PENDING_PAYMENT' | 'TRIAL' | (string & {});

export interface LastPayment {
  provider: string | null;
  transactionId: string | null;
  amount: Decimal | null;
  currency: string;
  paidAt: string | null;
}

export interface Subscription {
  id: string;
  planCode: string;
  /** Populated on GET /subscriptions/me; null elsewhere. */
  plan: Plan | null;
  status: SubscriptionStatus;
  billingCycle: 'MONTHLY' | 'YEARLY' | 'LIFETIME' | (string & {});
  startedAt: string | null;
  /** null = never expires (Free / Lifetime / Post-Paid). */
  expiresAt: string | null;
  nextBillingAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  autoRenew: boolean;
  lastPayment: LastPayment | null;
}

export const toSubscription = (body: unknown): Subscription | null => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = body as Raw;
  // `planId` is the populated plan on /me and a bare id everywhere else.
  const populated = raw.planId && typeof raw.planId === 'object' ? toPlan(raw.planId) : null;
  const lp = raw.lastPayment && typeof raw.lastPayment === 'object' ? asRecord(raw.lastPayment) : null;
  return {
    id: id(raw),
    planCode: (str(raw.planCode) || populated?.code || '').toUpperCase(),
    plan: populated,
    status: str(raw.status) || 'ACTIVE',
    billingCycle: str(raw.billingCycle) || 'MONTHLY',
    startedAt: strOrNull(raw.startedAt),
    expiresAt: strOrNull(raw.expiresAt),
    nextBillingAt: strOrNull(raw.nextBillingAt),
    cancelledAt: strOrNull(raw.cancelledAt),
    cancelReason: strOrNull(raw.cancelReason),
    autoRenew: raw.autoRenew !== false,
    lastPayment: lp
      ? {
        provider: strOrNull(lp.provider),
        transactionId: strOrNull(lp.transactionId),
        amount: lp.amount == null ? null : dec(lp.amount),
        currency: str(lp.currency) || 'INR',
        paidAt: strOrNull(lp.paidAt),
      }
      : null,
  };
};

/** The first live trading wallet — what "real" billing would draw on. */
export interface BillingTradingWallet {
  accountId: string;
  currency: string;
  balance: Decimal;
  free: Decimal;
}

/** GET /subscriptions/me. */
export interface MySubscription {
  /** Null for a user who has never subscribed (they are on Free). */
  subscription: Subscription | null;
  /**
   * The plan whose limits apply RIGHT NOW. A lapsed paid plan falls back to
   * Free here even while `subscription` still names it — so "which plan am
   * I on" is this, not `subscription.planCode`. Plans.jsx:150 `isCurrent`.
   */
  effectivePlan: Plan | null;
  wallet: BillingTradingWallet | null;
  /** 'BONUS_WALLET' — plans are billed from the Bonus Wallet. */
  billingSource: string;
  /**
   * The wallet plans are billed from: `billingWallet`, or the deprecated
   * `subscriptionWallet` alias the server still sends with the same object.
   */
  billingWallet: BillingWallet | null;
}

const billingWalletOf = (raw: Raw): BillingWallet | null => {
  const w = [raw.billingWallet, raw.subscriptionWallet].find((v) => v && typeof v === 'object' && !Array.isArray(v));
  return w ? toBillingWallet(w) : null;
};

export const toMySubscription = (body: unknown): MySubscription => {
  const raw = asRecord(body);
  const w = raw.wallet && typeof raw.wallet === 'object' ? asRecord(raw.wallet) : null;
  return {
    subscription: toSubscription(raw.subscription),
    effectivePlan: raw.effectivePlan && typeof raw.effectivePlan === 'object' ? toPlan(raw.effectivePlan) : null,
    wallet: w
      ? {
        accountId: typeof w.accountId === 'string' ? w.accountId : id(asRecord(w.accountId)),
        currency: str(w.currency) || 'INR',
        balance: dec(w.balance),
        free: dec(w.free),
      }
      : null,
    billingSource: str(raw.billingSource) || 'BONUS_WALLET',
    billingWallet: billingWalletOf(raw),
  };
};

/**
 * POST /subscriptions/subscribe — subscriptionController.subscribe reads
 * `planCode, billingCycle` and nothing else: a paid plan is charged from
 * the Bonus Wallet server-side.
 */
export interface SubscribeInput {
  planCode: string;
  billingCycle: BillingCycle;
}

/**
 * `details` on a 402 INSUFFICIENT_SUBSCRIPTION_BALANCE: what the Bonus Wallet
 * holds, what the plan needs, and the gap. The web turns it into a recharge
 * prompt rather than a toast. Plans.jsx:110-120.
 */
export interface InsufficientBalance {
  balance: Decimal;
  needed: Decimal;
  shortfall: Decimal;
  currency: string;
}
