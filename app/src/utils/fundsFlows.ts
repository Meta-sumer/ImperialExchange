import type { AxiosError } from 'axios';

import type { AccountPlan, TradingAccount } from '@/types/trading';
import {
  BASE_CURRENCY,
  FIXED_RAILS,
  MANUAL_RAILS,
  NATIVE_DESTINATION_RAILS,
  customRailId,
  depositRailExtras,
  depositRailRows,
  railConfig,
  type CreateDepositInput,
  type CreateWithdrawalInput,
  type CustomRail,
  type DepositDetails,
  type ManualRailId,
  type NewWithdrawalMethod,
  type RailRow,
  type RailRules,
  type WalletBalance,
  type WithdrawalField,
  type WithdrawalMethod,
} from '@/types/wallet';
import { isDemoLike, isRealMoney } from '@/utils/accountType';
import { currencySymbol, fmtMoney, fmtNum } from '@/utils/money';

/**
 * The rules of EquityHub's money flows — Wallet.jsx InlineDepositFlow and
 * WithdrawView, components/WithdrawalMethods.jsx and WithdrawModal.jsx — as
 * plain functions, so the views stay layout and every number or label they
 * decide can be pinned by a test without rendering.
 *
 * EquityHub is INR-only: every amount is typed, sent and booked in rupees,
 * and the admin's per-rail limits and fees are rupees too. Which rails exist
 * is the admin's decision (GET /wallet/deposit-details) and arrives over the
 * network, so until it lands NO rail is offered — not "every rail".
 *
 * ── WHERE THIS DELIBERATELY DIFFERS FROM THE WEB ──────────────────────
 * 1. Demo-ness is `isDemoLike` (PORT-RULINGS §3). The web's flows test
 *    `=== 'DEMO'` and so send a VIRTUAL account down the live path the
 *    server never applies to it.
 * 2. Percentage / MAX amounts are floored to the cent. The web's
 *    `v.toFixed(2)` rounds to nearest, so MAX on 12.345 asked for 12.35 —
 *    more than the balance — and was refused.
 * 3. The withdrawal fee preview reads the chosen rail's own config for a
 *    custom rail too (the web looks it up under `CUSTOM:<id>`, which a
 *    withdrawal rail id never is, and so always previews ₹0), and the
 *    review card shows that same fee (the web hard-codes ₹0.00 there).
 * 4. A live deposit's reference must meet the server's four-character
 *    minimum before the upload step lets the user on, rather than failing
 *    after it.
 * ──────────────────────────────────────────────────────────────────────
 */

/* ══ Shared ══════════════════════════════════════════════════════════ */

const up = (c: string | null | undefined): string => String(c ?? '').toUpperCase();

/** Cents, rounded the web's way: `Math.round(x * 100) / 100`. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** "Ravi's account" / "100234" — `a.nickname || a.accountNumber`, as every web card writes it. */
export const accountTitle = (a: Pick<TradingAccount, 'nickname' | 'accountNumber'> | null | undefined): string =>
  (a ? a.nickname || a.accountNumber : '');

/** The two-letter tile on an account card. */
export const accountInitials = (a: Pick<TradingAccount, 'nickname' | 'accountNumber'>): string =>
  (a.nickname || a.accountNumber || 'A').slice(0, 2).toUpperCase();

/** The account-card chip: 'Live · Real' or 'Demo'. */
export const accountKindLabel = (a: Pick<TradingAccount, 'accountType'>): string =>
  (isRealMoney(a.accountType) ? 'Live · Real' : 'Demo');

/** Both flows default to a live account (`realAccount?._id || accounts[0]?._id`). */
export const defaultFlowAccountId = (accounts: ReadonlyArray<Pick<TradingAccount, 'id' | 'accountType'>>): string =>
  accounts.find((a) => isRealMoney(a.accountType))?.id ?? accounts[0]?.id ?? '';

/**
 * Wallet.jsx `accountTotalUsd` — an account's total across its wallets. On
 * EquityHub every row is rupees, so a plain sum. `balance` for the deposit
 * card, `free` for the withdraw card, `locked` for "locked in open positions".
 */
export const accountTotal = (
  balances: readonly Pick<WalletBalance, 'accountId' | 'balance' | 'free' | 'locked'>[],
  accountId: string,
  field: 'balance' | 'free' | 'locked',
): number =>
  balances
    .filter((b) => String(b.accountId) === String(accountId))
    .reduce((sum, b) => sum + (Number(b[field]) || 0), 0);

/**
 * The web's `fmtDate` (`toLocaleString('en-IN')`), with the device locale
 * and time zone instead (PORT-RULINGS §5). '-' for a missing date, as there.
 */
export const fmtDateTime = (value: string | null | undefined): string => {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString();
};

/** The `error.code` of a refused request, or null. */
export const apiErrorCode = (err: unknown): string | null =>
  (err as AxiosError<{ error?: { code?: string } }> | undefined)?.response?.data?.error?.code ?? null;

/** A money-flow step, as the stepper shows it. */
export interface FlowStep<Id extends string> {
  id: Id;
  label: string;
  sub: string;
}

/** Summary cell / review rows are `{ l, v }` on the web. */
export interface ReviewRow {
  l: string;
  v: string;
}

/** `${currencySymbol(currency)}${fmtNum(v, 2)}` — how the web's flows print a typed amount. */
export const fmtFlowAmount = (value: number | string): string => fmtMoney(Number(value) || 0);

/**
 * What an amount field keeps of a keystroke or a paste: digits and ONE
 * decimal point (a comma typed on a European keypad is that point). The
 * web's `<input type="number">` refuses "1.2.3" outright; a TextInput would
 * keep it, and it would read as NaN everywhere after.
 */
export const sanitizeAmountInput = (value: string): string => {
  const s = value.replace(/,/g, '.').replace(/[^\d.]/g, '');
  const dot = s.indexOf('.');
  return dot < 0 ? s : `${s.slice(0, dot + 1)}${s.slice(dot + 1).replace(/\./g, '')}`;
};

/**
 * A typed amount as the decimal string it means — "10." → "10", ".5" →
 * "0.5", "007" → "7". The server stores a deposit's and a withdrawal's
 * amount as `String(amount)` — the figure the admin pays out against and
 * the user sees in their history — so it gets the number, not the
 * keystrokes. Anything that is not a plain decimal is returned trimmed, for
 * the server to refuse in its own words.
 */
export const canonicalAmount = (value: string): string => {
  const s = value.trim();
  if (!/^\d*\.?\d*$/.test(s) || !/\d/.test(s)) return s;
  const [wholeRaw = '', frac = ''] = s.split('.');
  const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0';
  return frac ? `${whole}.${frac}` : whole;
};

/** Where a view's own read stands — the web's `payState`. */
export type LoadState = 'loading' | 'ready' | 'error';

/**
 * A burst of wallet events (a close-all settles many positions) becomes one
 * reload — the web debounces the same burst (250 ms).
 */
export const LIVE_RELOAD_DEBOUNCE_MS = 300;

/** How many recent withdrawals show before "Show more" (the server sends ≤ 100). */
export const RECENT_PAGE = 20;

/* ══ Proof uploads (utils/imageCompress.js) ══════════════════════════ */

/** The largest file a user may pick — imageCompress.js MAX_UPLOAD_BYTES. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** What the web compresses a screenshot's data URL down to (`maxBytes`). */
export const PROOF_COMPRESS_TARGET = 900 * 1024;

/** The server's cap on a proof data: URL (walletController SCREENSHOT_MAX_BYTES). */
export const PROOF_MAX_DATA_URL = 3 * 1024 * 1024;

/** imageCompress.js fmtBytes. */
export const fmtBytes = (n: number): string => {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
};

/* ══ Deposit rails ═══════════════════════════════════════════════════ */

/**
 * One manual rail a user pays into — UPI, Bank, or an admin-defined one —
 * with what the "Pay to these details" card needs.
 */
export interface PaymentRail {
  /** 'UPI' | 'BANK' | 'CUSTOM:<id>'. */
  id: string;
  label: string;
  /** What a deposit posts as `method`: the fixed id, or a custom rail's LABEL. */
  postAs: string;
  custom: boolean;
  emoji: string | null;
  /** Payee rows, blanks dropped. */
  rows: RailRow[];
  note: string | null;
  qr: string | null;
}

/** Wallet.jsx FIXED_MANUAL. */
const FIXED_DEPOSIT: Record<ManualRailId, { label: string; sub: string }> = {
  UPI: { label: 'UPI', sub: 'Instant · Free' },
  BANK: { label: 'Bank Transfer', sub: 'NEFT / IMPS · 1-3 hrs' },
};

const manualRail = (details: DepositDetails, id: ManualRailId): PaymentRail => {
  const extras = depositRailExtras(details, id);
  return {
    id,
    label: FIXED_DEPOSIT[id].label,
    postAs: id,
    custom: false,
    emoji: null,
    rows: depositRailRows(details, id),
    note: extras.note,
    qr: extras.qr,
  };
};

const customPaymentRail = (details: DepositDetails, c: CustomRail): PaymentRail => {
  const id = customRailId(c);
  return {
    id,
    label: c.label,
    postAs: c.label,
    custom: true,
    emoji: c.emoji,
    rows: depositRailRows(details, id),
    note: c.note,
    qr: c.qr,
  };
};

/**
 * The name the "not set up yet" warning uses. The web prints the method id
 * (`Payment details for BANK aren't set up yet.`); for a custom rail that id
 * is `CUSTOM:<random>`, so its label is used instead.
 */
export const railWarningName = (rail: PaymentRail | null, fallback: string): string =>
  (rail ? (rail.custom ? rail.label : rail.id) : fallback);

export const RAZORPAY_ID = 'RAZORPAY';

export type MethodGlyphKind = 'UPI' | 'BANK' | 'RAZORPAY' | 'CUSTOM';

export interface DepositMethod {
  id: string;
  label: string;
  sub: string;
  kind: 'manual' | 'instant';
  glyph: MethodGlyphKind;
  emoji: string | null;
  /** The manual rail; null for Razorpay. */
  rail: PaymentRail | null;
  /** What is posted as `method`. */
  postAs: string;
  /** The binding floor: the rail's admin minimum or the account tier's, whichever is higher. 0 = none. */
  min: number;
  /** The rail's admin maximum per transaction. 0 = none. */
  max: number;
  /** The tier minimum is the one that binds — the card says "(account tier)". */
  planFloored: boolean;
  /** The rail's admin rules (the deposit fee lives here). */
  rules: RailRules;
}

const rulesOf = (details: DepositDetails, id: string): RailRules => {
  const cfg = railConfig(details, id);
  return {
    minDeposit: cfg?.minDeposit ?? 0,
    maxDeposit: cfg?.maxDeposit ?? 0,
    minWithdrawal: cfg?.minWithdrawal ?? 0,
    maxWithdrawal: cfg?.maxWithdrawal ?? 0,
    feePercent: cfg?.feePercent ?? 0,
    feeFixed: cfg?.feeFixed ?? 0,
    withdrawalFeePercent: cfg?.withdrawalFeePercent ?? 0,
    withdrawalFeeFixed: cfg?.withdrawalFeeFixed ?? 0,
  };
};

/**
 * Wallet.jsx METHODS: the enabled manual rails (UPI, Bank), the enabled
 * custom rails, then Razorpay — the automatic gateway — when the admin has
 * it on. `null` details (not loaded yet, or the load failed) offers none.
 *
 * `withLimits`: a card's minimum is the higher of the rail's admin minimum
 * and the account tier's minimum deposit, and says which binds.
 */
export const depositMethods = (details: DepositDetails | null, planMin = 0): DepositMethod[] => {
  if (!details) return [];
  const withLimits = (m: Omit<DepositMethod, 'min' | 'max' | 'planFloored' | 'rules'>): DepositMethod => {
    const rules = rulesOf(details, m.id);
    const planRow = planMin > 0 ? planMin : 0;
    return {
      ...m,
      rules,
      min: Math.max(rules.minDeposit, planRow),
      max: rules.maxDeposit,
      planFloored: planRow > 0 && planRow > rules.minDeposit,
    };
  };
  return [
    ...MANUAL_RAILS.filter((id) => details[id].enabled).map((id) => withLimits({
      id,
      label: FIXED_DEPOSIT[id].label,
      sub: FIXED_DEPOSIT[id].sub,
      kind: 'manual',
      glyph: id,
      emoji: null,
      rail: manualRail(details, id),
      postAs: id,
    })),
    ...details.custom.filter((c) => c.enabled).map((c) => withLimits({
      id: customRailId(c),
      label: c.label,
      sub: 'Manual',
      kind: 'manual',
      glyph: 'CUSTOM',
      emoji: c.emoji,
      rail: customPaymentRail(details, c),
      postAs: c.label,
    })),
    ...(details.RAZORPAY.enabled
      ? [withLimits({
        id: RAZORPAY_ID,
        label: 'Razorpay',
        sub: 'UPI / Card · Instant',
        kind: 'instant',
        glyph: 'RAZORPAY',
        emoji: null,
        rail: null,
        postAs: RAZORPAY_ID,
      })]
      : []),
  ];
};

/**
 * A deposit card's limits line — "Min · ₹1,000.00 (account tier)  ·  Max ·
 * ₹2,00,000.00", or 'No minimum'.
 */
export const depositMethodMeta = (m: Pick<DepositMethod, 'min' | 'max' | 'planFloored'>): string => {
  if (!(m.min > 0 || m.max > 0)) return 'No minimum';
  const min = m.min > 0 ? `Min · ${fmtMoney(m.min)}${m.planFloored ? ' (account tier)' : ''}` : '';
  const max = m.max > 0 ? `Max · ${fmtMoney(m.max)}` : '';
  return [min, max].filter(Boolean).join('  ·  ');
};

/**
 * The effect in InlineDepositFlow: once details load, a method the admin
 * has hidden (or a stale custom id) falls back to the first fixed rail still
 * shown, then the first custom one, then Razorpay if it is on. A
 * not-yet-loaded config leaves the choice alone.
 */
export const fallbackDepositMethod = (details: DepositDetails | null, method: string): string => {
  if (!details) return method;
  const razorOn = details.RAZORPAY.enabled;
  const stillVisible = method === RAZORPAY_ID
    ? razorOn
    : method.startsWith('CUSTOM:')
      ? details.custom.some((c) => customRailId(c) === method && c.enabled)
      : (MANUAL_RAILS as readonly string[]).includes(method)
        ? details[method as ManualRailId].enabled
        : true;
  if (stillVisible) return method;
  const firstFixed = MANUAL_RAILS.find((id) => details[id].enabled);
  const firstCustom = details.custom.find((c) => c.label && c.enabled);
  return firstFixed ?? (firstCustom ? customRailId(firstCustom) : (razorOn ? RAZORPAY_ID : method));
};

/**
 * The admin's fee on a gross amount — percentage plus fixed part, to the
 * cent, never more than the amount (InlineDepositFlow `methodFee`; the
 * withdrawal side mirrors backend utils/withdrawalFee).
 */
export const railFee = (gross: number, percent: number, fixed: number): number => {
  const g = Number(gross) || 0;
  return Math.min(g, round2((g * (Number(percent) || 0)) / 100 + (Number(fixed) || 0)));
};

/** The deposit fee for a method (`feePercent` / `feeFixed`). */
export const depositFee = (m: Pick<DepositMethod, 'rules'> | null | undefined, gross: number): number =>
  (m ? railFee(gross, m.rules.feePercent, m.rules.feeFixed) : 0);

/* ══ Deposit flow ════════════════════════════════════════════════════ */

/** InlineDepositFlow PRESETS — rupees. */
export const DEPOSIT_PRESETS: readonly number[] = [1000, 5000, 10000, 25000, 50000];

export type DepositStepId = 'account' | 'method' | 'amount' | 'proof' | 'confirm';

/** InlineDepositFlow STEPS. */
export const DEPOSIT_STEPS: readonly FlowStep<DepositStepId>[] = [
  { id: 'account', label: 'Account', sub: 'Choose account' },
  { id: 'method', label: 'Payment Method', sub: 'Select method' },
  { id: 'amount', label: 'Amount', sub: 'Enter amount' },
  { id: 'proof', label: 'Upload Proof', sub: 'Add payment proof' },
  { id: 'confirm', label: 'Confirmation', sub: 'Review & confirm' },
];

/** A practice account and a Razorpay payment both skip the proof step. */
export const depositSteps = (skipProof: boolean): readonly FlowStep<DepositStepId>[] =>
  (skipProof ? DEPOSIT_STEPS.filter((s) => s.id !== 'proof') : DEPOSIT_STEPS);

/**
 * The server refuses a real deposit whose reference is shorter than this
 * (`String(txReference).trim().length < 4`, walletController.createDeposit).
 */
export const TX_REFERENCE_MIN = 4;

/** The tier's own minimum deposit in rupees, 0 when it sets none. */
export const planMinDeposit = (
  plans: Readonly<Record<string, AccountPlan>>,
  account: Pick<TradingAccount, 'accountType'> | null | undefined,
): number => {
  if (!account) return 0;
  const p = plans[up(account.accountType)];
  return p ? Number(p.minDeposit || 0) : 0;
};

export const belowMinDeposit = (p: { isReal: boolean; planMin: number; amount: number }): boolean =>
  p.isReal && p.planMin > 0 && p.amount < p.planMin;

/** The submit-time refusal. */
export const minDepositToast = (
  account: Pick<TradingAccount, 'nickname' | 'accountType'> | null,
  min: number,
): string => `Minimum deposit for ${account?.nickname || account?.accountType} is ${fmtMoney(min)}.`;

/** The amount-step warning. */
export const minDepositNotice = (p: {
  account: Pick<TradingAccount, 'nickname' | 'accountType'> | null;
  min: number;
  amount: number;
}): string =>
  `⚠ Minimum deposit for the ${p.account?.nickname || p.account?.accountType} plan is ${fmtMoney(p.min)}. You entered ${fmtMoney(p.amount || 0)} — please increase the amount.`;

export interface DepositGateInput {
  stepId: DepositStepId | undefined;
  accountId: string;
  /** The admin's rail list has landed (`payState === 'ready'`). */
  payReady: boolean;
  /** The chosen method is one of the methods on offer. */
  methodListed: boolean;
  amount: string;
  method: Pick<DepositMethod, 'min' | 'max'> | null;
  belowMin: boolean;
  skipProof: boolean;
  hasProof: boolean;
  txReference: string;
  senderName: string;
  isReal: boolean;
}

/**
 * InlineDepositFlow canNext, by step id. The method must be one the admin is
 * CONFIRMED to leave open; no floor sneaks in when none is configured.
 */
export const depositCanNext = (g: DepositGateInput): boolean => {
  switch (g.stepId) {
    case 'account': return !!g.accountId;
    case 'method': return g.payReady && g.methodListed;
    case 'amount': {
      const amt = Number(g.amount) || 0;
      const min = g.method?.min ?? 0;
      const max = g.method?.max ?? 0;
      return !!g.amount && amt > 0 && amt >= min && !(max > 0 && amt > max) && !g.belowMin;
    }
    case 'proof':
      if (g.skipProof) return true;
      return g.hasProof
        && !!g.txReference.trim()
        && (!g.isReal || g.txReference.trim().length >= TX_REFERENCE_MIN)
        && !!g.senderName.trim();
    default: return true;
  }
};

export interface DepositDraft {
  accountId: string;
  amount: string;
  method: Pick<DepositMethod, 'id' | 'postAs'>;
  txReference: string;
  senderName: string;
  senderUpiId: string;
  senderBankAccount: string;
  proof: { dataUrl: string; mimeType: string } | null;
  isReal: boolean;
}

/**
 * POST /wallet/deposits — InlineDepositFlow `submit`. INR always; the method
 * as the rail id (a custom rail's label); the proof only for real money.
 * Blank sender fields are left out rather than sent as '', and the UPI /
 * bank sender fields only with that rail — the web keeps whatever was typed
 * before the method changed.
 */
export const buildDepositPayload = (d: DepositDraft): CreateDepositInput => {
  const body: CreateDepositInput = {
    accountId: d.accountId,
    currency: BASE_CURRENCY,
    amount: canonicalAmount(d.amount),
    method: d.method.postAs,
  };
  const ref = d.txReference.trim();
  const name = d.senderName.trim();
  const upi = d.senderUpiId.trim();
  const bank = d.senderBankAccount.trim();
  if (ref) body.txReference = ref;
  if (name) body.senderName = name;
  if (d.method.id === 'UPI' && upi) body.senderUpiId = upi;
  if (d.method.id === 'BANK' && bank) body.senderBankAccount = bank;
  if (d.isReal && d.proof) {
    body.screenshot = d.proof.dataUrl;
    body.screenshotMimeType = d.proof.mimeType;
  }
  return body;
};

/** The pre-submit refusals for a manual real deposit, or null. */
export const manualDepositProblem = (p: { isReal: boolean; hasProof: boolean; txReference: string }): string | null => {
  if (p.isReal && !p.hasProof) return 'Payment screenshot required for real account';
  if (p.isReal && !p.txReference.trim()) return 'Transaction reference required (UPI ref / bank ref)';
  return null;
};

/** Success toasts. */
export const depositSuccessMessage = (isDemo: boolean, amount: string): string =>
  (isDemo ? `${fmtFlowAmount(amount)} added to demo account!` : 'Deposit submitted — pending admin verification');

/** Razorpay's verify succeeded. */
export const razorpayCreditedMessage = (amount: string): string => `${fmtFlowAmount(amount)} credited`;

/** The final button. */
export const depositPrimaryLabel = (p: { loading: boolean; isDemo: boolean; isRazor: boolean; amount: string }): string => {
  if (p.loading) return 'Submitting…';
  if (p.isDemo) return 'Add to Demo Account';
  if (p.isRazor) return `Pay ${fmtFlowAmount(p.amount)} via Razorpay`;
  return 'Confirm Deposit';
};

/** The review card. */
export const depositReviewRows = (p: {
  account: Pick<TradingAccount, 'nickname' | 'accountNumber' | 'accountType'> | null;
  methodLabel: string;
  amount: string;
  fee: number;
  isReal: boolean;
  isRazor: boolean;
  txReference: string;
  senderName: string;
}): ReviewRow[] => {
  const amt = Number(p.amount) || 0;
  return [
    { l: 'Account', v: `${accountTitle(p.account)} · ${p.account?.accountType ?? ''}` },
    { l: 'Method', v: p.methodLabel },
    { l: 'Amount', v: fmtFlowAmount(amt) },
    { l: 'Fees', v: fmtFlowAmount(p.fee) },
    { l: 'Receive', v: fmtFlowAmount(Math.max(0, amt - p.fee)) },
    ...(p.isReal && !p.isRazor
      ? [
        { l: 'Reference', v: p.txReference || '—' },
        { l: 'Sender', v: p.senderName || '—' },
      ]
      : []),
  ];
};

/** The reassurance under the review card. */
export const depositAssurance = (isReal: boolean, isRazor: boolean): string =>
  `Your payment is protected with bank-grade encryption. ${
    isReal && !isRazor
      ? 'Admin will verify your screenshot within 1–24 hours.'
      : isRazor ? 'Instant credit — powered by Razorpay.' : 'Demo funds credit instantly.'}`;

/** The deposit method step's notices, word for word. */
export const DEPOSIT_METHODS_FAILED = "Couldn't load the available payment methods. Check your connection and reload this page before sending any money.";
export const DEPOSIT_METHODS_NONE = 'No payment methods are available right now. Please contact support.';

/* ══ Razorpay ════════════════════════════════════════════════════════ */

/**
 * Whether the order is backed by a real gateway. The server's mock provider
 * (paymentService, the default whenever keys are missing) answers `mock_…`
 * order ids and its verify approves ANY payment — so a mock order is never
 * opened and never verified. A key alone is not proof: the server sends the
 * configured key id even in mock mode.
 */
export const isLiveRazorpayOrder = (order: { keyId: string | null; orderId: string }): boolean =>
  !!order.keyId && !!order.orderId && !order.orderId.startsWith('mock_');

export const RAZORPAY_NOT_SET_UP = 'Razorpay is not set up on this server yet. Choose another payment method.';

/* ══ Withdrawal rails ════════════════════════════════════════════════ */

/**
 * One rail a payout can use — Wallet.jsx WithdrawView METHODS and
 * WithdrawModal.jsx `rails`, from the admin's config: every fixed rail open
 * for PAYOUTS (UPI, Bank, Razorpay) and every open custom rail.
 */
export interface WithdrawRail {
  /** 'UPI' | 'BANK' | 'RAZORPAY' | a custom rail's bare id. */
  id: string;
  label: string;
  /** WithdrawView's line under the label. */
  sub: string;
  /** WithdrawModal's line under the label. */
  blurb: string;
  emoji: string;
  glyph: MethodGlyphKind;
  /** Saved destinations on a non-native rail are found by this; null on UPI / Bank. */
  methodKey: string | null;
  /** Admin limits per transaction, rupees. 0 = none. */
  min: number;
  max: number;
  feePercent: number;
  feeFixed: number;
}

/** Wallet.jsx W_RAIL_META + WithdrawModal.jsx RAIL_META. */
const WITHDRAW_RAIL_META: Record<string, { label: string; sub: string; blurb: string; emoji: string }> = {
  UPI: { label: 'UPI', sub: 'Instant · Free', blurb: 'Instant · to your UPI ID', emoji: '📱' },
  BANK: { label: 'Bank Transfer', sub: 'NEFT / IMPS · 1-24 hrs', blurb: 'NEFT / IMPS · 1-24 hrs', emoji: '🏦' },
  RAZORPAY: { label: 'Razorpay', sub: 'Gateway', blurb: 'Gateway', emoji: '⚡' },
};

/** The payout rails on offer, or none until the admin's config has landed. */
export const withdrawRails = (details: DepositDetails | null): WithdrawRail[] => {
  if (!details) return [];
  const fixed = FIXED_RAILS.filter((id) => details[id].withdrawalEnabled).map((id): WithdrawRail => {
    const meta = WITHDRAW_RAIL_META[id] ?? { label: id, sub: '', blurb: '', emoji: '💳' };
    const cfg = details[id];
    return {
      id,
      label: meta.label,
      sub: meta.sub,
      blurb: meta.blurb,
      emoji: meta.emoji,
      glyph: id,
      methodKey: NATIVE_DESTINATION_RAILS.has(id) ? null : id,
      min: cfg.minWithdrawal,
      max: cfg.maxWithdrawal,
      feePercent: cfg.withdrawalFeePercent,
      feeFixed: cfg.withdrawalFeeFixed,
    };
  });
  const custom = details.custom.filter((c) => c.withdrawalEnabled).map((c): WithdrawRail => ({
    id: String(c.id),
    label: c.label,
    sub: 'Manual',
    blurb: 'Manual',
    emoji: c.emoji || '💳',
    glyph: 'CUSTOM',
    methodKey: String(c.id),
    min: c.minWithdrawal,
    max: c.maxWithdrawal,
    feePercent: c.withdrawalFeePercent,
    feeFixed: c.withdrawalFeeFixed,
  }));
  return [...fixed, ...custom];
};

/** A closed or vanished rail moves to the first one still open; the choice stands when none is. */
export const coerceWithdrawRail = (rails: readonly Pick<WithdrawRail, 'id'>[], method: string): string =>
  (rails.length && !rails.some((r) => r.id === method) ? rails[0]?.id ?? method : method);

/** A withdraw card's limits line — "Min · ₹500.00  ·  Max · ₹50,000.00", or 'No limit'. */
export const withdrawRailMeta = (r: Pick<WithdrawRail, 'min' | 'max'>): string => {
  if (!(r.min > 0 || r.max > 0)) return 'No limit';
  return [r.min > 0 ? `Min · ${fmtMoney(r.min)}` : '', r.max > 0 ? `Max · ${fmtMoney(r.max)}` : '']
    .filter(Boolean)
    .join('  ·  ');
};

/** The withdrawal fee on a gross amount — backend utils/withdrawalFee. */
export const withdrawFee = (r: Pick<WithdrawRail, 'feePercent' | 'feeFixed'> | null | undefined, gross: number): number =>
  (r ? railFee(gross, r.feePercent, r.feeFixed) : 0);

/** The method step's notices, word for word. */
export const WITHDRAW_METHODS_FAILED = "Couldn't load the available withdrawal methods. Check your connection and reload this page before requesting a payout.";
export const WITHDRAW_METHODS_NONE = 'No withdrawal methods are available right now. Please contact support.';

/* ══ Withdraw flow (trading accounts) ════════════════════════════════ */

export type WithdrawStepId = 'account' | 'method' | 'amount' | 'destination' | 'confirm';

/** WithdrawView STEPS. */
export const WITHDRAW_STEPS: readonly FlowStep<WithdrawStepId>[] = [
  { id: 'account', label: 'Account', sub: 'Choose account' },
  { id: 'method', label: 'Method', sub: 'Select method' },
  { id: 'amount', label: 'Amount', sub: 'Enter amount' },
  { id: 'destination', label: 'Destination', sub: 'Where to send' },
  { id: 'confirm', label: 'Confirmation', sub: 'Review & confirm' },
];

/** Practice money pays out nowhere: no method, no destination step. */
export const withdrawSteps = (isDemo: boolean): readonly FlowStep<WithdrawStepId>[] =>
  (isDemo ? WITHDRAW_STEPS.filter((s) => s.id !== 'method' && s.id !== 'destination') : WITHDRAW_STEPS);

/** "Available to Withdraw": every wallet's free part, floored at zero. */
export const availableToWithdraw = (
  balances: readonly Pick<WalletBalance, 'accountId' | 'free'>[],
  accountId: string,
): number =>
  (accountId
    ? balances
      .filter((b) => String(b.accountId) === String(accountId))
      .reduce((s, w) => s + Math.max(0, Number(w.free || 0)), 0)
    : 0);

/**
 * `pct` of what is available, to the cent, ROUNDED DOWN — so MAX never asks
 * for more than the balance (the web's `toFixed(2)` rounds up half the time).
 */
export const shareOf = (available: number, pct: number): string => {
  // available × pct/100 in cents is available × pct. The epsilon absorbs
  // binary noise (0.29 × 100 = 28.999…96) without ever adding a cent.
  const cents = Math.floor(available * pct + 1e-7);
  return (Math.max(0, cents) / 100).toFixed(2);
};

/** Whether a preset is the amount on screen. */
export const isShareSelected = (amount: string, available: number, pct: number): boolean =>
  !!amount && Math.abs(Number(amount) - Number(shareOf(available, pct))) < 0.01;

export const isOverBudget = (amount: string, available: number): boolean => Number(amount) > available;

/** Below / above the rail's admin limits. Practice money has none. */
export const withdrawLimits = (p: {
  amount: string;
  rail: Pick<WithdrawRail, 'min' | 'max'> | null;
  isDemo: boolean;
}): { belowMin: boolean; aboveMax: boolean } => {
  const amt = Number(p.amount) || 0;
  const min = p.rail?.min ?? 0;
  const max = p.rail?.max ?? 0;
  return {
    belowMin: !p.isDemo && min > 0 && amt > 0 && amt < min,
    aboveMax: !p.isDemo && max > 0 && amt > max,
  };
};

/** The amount field's line under it — an error, the rail's limits, or nothing. */
export const withdrawAmountNote = (p: {
  overBudget: boolean;
  belowMin: boolean;
  aboveMax: boolean;
  rail: Pick<WithdrawRail, 'label' | 'min' | 'max'> | null;
}): { text: string; error: boolean } | null => {
  if (p.overBudget) return { text: 'Exceeds your available balance', error: true };
  const r = p.rail;
  if (!r) return null;
  if (p.belowMin) return { text: `Minimum withdrawal for ${r.label} is ${fmtMoney(r.min)}`, error: true };
  if (p.aboveMax) return { text: `Maximum withdrawal for ${r.label} is ${fmtMoney(r.max)} per transaction`, error: true };
  if (r.min > 0 || r.max > 0) {
    const min = r.min > 0 ? `Min ${fmtMoney(r.min)}` : '';
    const max = r.max > 0 ? `Max ${fmtMoney(r.max)} per transaction` : '';
    return { text: [min, max].filter(Boolean).join(' · '), error: false };
  }
  return null;
};

export interface WithdrawGateInput {
  stepId: WithdrawStepId | undefined;
  accountId: string;
  payReady: boolean;
  methodListed: boolean;
  amount: string;
  belowMin: boolean;
  aboveMax: boolean;
  overBudget: boolean;
  withdrawalMethodId: string;
}

/** WithdrawView canNext. */
export const withdrawCanNext = (g: WithdrawGateInput): boolean => {
  switch (g.stepId) {
    case 'account': return !!g.accountId;
    case 'method': return g.payReady && g.methodListed;
    case 'amount': {
      const amt = Number(g.amount) || 0;
      return !!g.amount && amt > 0 && !g.belowMin && !g.aboveMax && !g.overBudget;
    }
    case 'destination': return !!g.withdrawalMethodId;
    default: return true;
  }
};

/** The submit-time refusals, or null. */
export const withdrawProblem = (amount: string, available: number): string | null => {
  if (!amount || Number(amount) <= 0) return 'Enter a valid amount';
  if (isOverBudget(amount, available)) return `Insufficient balance. Available: ${fmtMoney(available)}`;
  return null;
};

/**
 * The saved-method refusals. Each means the app's copy of the methods is out
 * of date — archived, blocked, rejected or never verified since it loaded —
 * so the list is fetched again rather than offering the same stale choice.
 */
export const isStaleMethodRefusal = (code: string | null): boolean =>
  code === 'WITHDRAWAL_METHOD_REQUIRED'
  || code === 'WITHDRAWAL_METHOD_NOT_FOUND'
  || code === 'WITHDRAWAL_METHOD_NOT_VERIFIED'
  || code === 'WITHDRAWAL_METHOD_BLOCKED'
  || code === 'WITHDRAWAL_METHOD_REJECTED';

/**
 * POST /wallet/withdrawals — WithdrawView `submit`. A live payout carries
 * ONLY the saved, verified method's id (the server resolves the destination
 * and refuses a typed one); a practice withdrawal carries the rail as
 * `method` and no destination — its branch runs before any method check.
 */
export const buildWithdrawalPayload = (p: {
  accountId: string;
  amount: string;
  isDemo: boolean;
  method: string;
  withdrawalMethodId: string;
}): CreateWithdrawalInput => (p.isDemo
  ? { accountId: p.accountId, currency: BASE_CURRENCY, amount: canonicalAmount(p.amount), method: p.method }
  : { accountId: p.accountId, currency: BASE_CURRENCY, amount: canonicalAmount(p.amount), withdrawalMethodId: p.withdrawalMethodId });

export const withdrawSuccessMessage = (isDemo: boolean): string =>
  (isDemo
    ? 'Demo withdrawal completed instantly'
    : 'Withdrawal request submitted — admin will process within 24 hours');

/** The final button. */
export const withdrawPrimaryLabel = (p: { loading: boolean; isDemo: boolean; amount: string }): string => {
  if (p.loading) return 'Submitting…';
  return p.isDemo
    ? `Withdraw ${fmtFlowAmount(p.amount)} instantly`
    : `Request Withdrawal of ${fmtFlowAmount(p.amount)}`;
};

/** The footer line. */
export const withdrawFooterNote = (isDemo: boolean): string =>
  (isDemo ? 'Demo withdrawals are processed instantly' : 'Withdrawals are processed manually within 1–24 hours');

/** The review card. */
export const withdrawReviewRows = (p: {
  account: Pick<TradingAccount, 'nickname' | 'accountNumber' | 'accountType'> | null;
  methodLabel: string;
  amount: string;
  fee: number;
  destination: Pick<WithdrawalMethod, 'label' | 'masked'> | null;
}): ReviewRow[] => {
  const amt = Number(p.amount) || 0;
  return [
    { l: 'Account', v: `${accountTitle(p.account)} · ${p.account?.accountType ?? ''}` },
    { l: 'Method', v: p.methodLabel },
    { l: 'Amount', v: fmtFlowAmount(amt) },
    { l: 'Fees', v: fmtFlowAmount(p.fee) },
    { l: 'Receive', v: fmtFlowAmount(Math.max(0, amt - p.fee)) },
    ...(p.destination
      ? [
        { l: 'Destination', v: p.destination.label },
        { l: 'Details', v: p.destination.masked },
      ]
      : []),
  ];
};

/* ══ Withdrawal methods (components/WithdrawalMethods.jsx) ═══════════ */

/** WithdrawalMethods.jsx TYPE_LABEL. */
export const METHOD_TYPE_LABEL: Readonly<Record<string, string>> = {
  BANK: 'Bank Account',
  UPI: 'UPI ID',
  CRYPTO: 'Crypto Wallet',
};

export type MethodStatusTone = 'bull' | 'warn' | 'bear' | 'neutral';

/** WithdrawalMethods.jsx STATUS_STYLE — anything unknown reads as Pending. */
export const methodStatusStyle = (status: string): { label: string; tone: MethodStatusTone } => {
  switch (up(status)) {
    case 'VERIFIED': return { label: 'Verified', tone: 'bull' };
    case 'REJECTED': return { label: 'Rejected', tone: 'bear' };
    case 'BLOCKED': return { label: 'Blocked', tone: 'neutral' };
    default: return { label: 'Pending', tone: 'warn' };
  }
};

/** A saved method's sub-line: "UPI ID · ra**@okicici" (a CUSTOM one shows the masked value alone). */
export const methodLine = (m: Pick<WithdrawalMethod, 'type' | 'masked'>): string => {
  const t = METHOD_TYPE_LABEL[up(m.type)];
  return t ? `${t} · ${m.masked}` : m.masked;
};

/** window.confirm text. */
export const REMOVE_METHOD_CONFIRM = 'Remove this withdrawal method? You will need to add + verify a new one to use it again.';

/**
 * MUST match withdrawalFieldKey() in backend/src/utils/paymentMethods.js —
 * the user fills a value under this key and the server looks it up by the
 * same rule.
 */
export const withdrawalFieldKey = (f: Pick<WithdrawalField, 'key' | 'label'> | null | undefined): string =>
  String((f && (f.key || f.label)) || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);

/** paymentMethods.js DEFAULT_WITHDRAWAL_FIELDS. */
export const DEFAULT_WITHDRAWAL_FIELDS: readonly WithdrawalField[] = [
  { label: 'Account / address', key: null, required: true, sensitive: true, placeholder: null },
];

/** Rails that keep their own validated form when the admin has not described them. */
const OWN_FORM_RAILS = new Set(['UPI', 'BANK', 'CRYPTO']);

/**
 * What a payout destination on `railId` asks the user for, or null when the
 * rail has its own form (paymentMethods.js withdrawalSchema): the admin's
 * fields win on any rail; an untouched native rail keeps its form; anything
 * else gets one default field.
 */
export const withdrawalSchema = (
  railId: string,
  fields: readonly WithdrawalField[] | null | undefined,
): readonly WithdrawalField[] | null => {
  const given = (fields ?? []).filter((f) => f && f.label);
  if (given.length) return given;
  if (OWN_FORM_RAILS.has(up(railId))) return null;
  return DEFAULT_WITHDRAWAL_FIELDS;
};

/** One choice in the Add form's type row. */
export interface AddMethodType {
  /** 'BANK' | 'UPI' | 'RAZORPAY' | a custom rail's bare id. */
  id: string;
  label: string;
  native: boolean;
  /** For a non-native rail: what to collect. */
  schema: readonly WithdrawalField[];
}

/**
 * The Add form's type row (WithdrawalMethods.jsx AddForm): the native rails
 * open for payouts (Bank, UPI), the generic fixed ones (Razorpay), then the
 * admin's custom rails. A failed config load offers the built-ins rather
 * than an empty form (`details` null → Bank and UPI).
 */
export const addMethodTypes = (details: DepositDetails | null): AddMethodType[] => {
  const open = (id: 'UPI' | 'BANK' | 'RAZORPAY'): boolean => !details || details[id].withdrawalEnabled;
  const builtIns: AddMethodType[] = (['BANK', 'UPI'] as const)
    .filter(open)
    .map((id) => ({ id, label: METHOD_TYPE_LABEL[id] ?? id, native: true, schema: [] }));
  const generic: AddMethodType[] = FIXED_RAILS
    .filter((id) => !OWN_FORM_RAILS.has(id) && open(id))
    .map((id) => ({
      id,
      label: WITHDRAW_RAIL_META[id]?.label ?? id,
      native: false,
      schema: withdrawalSchema(id, details ? details[id].withdrawalFields : null) ?? [],
    }));
  const custom: AddMethodType[] = (details?.custom ?? [])
    .filter((c) => c.withdrawalEnabled)
    .map((c) => ({
      id: String(c.id),
      label: `${c.emoji ? `${c.emoji} ` : ''}${c.label}`,
      native: false,
      schema: withdrawalSchema(c.id, c.withdrawalFields) ?? [],
    }));
  return [...builtIns, ...generic, ...custom];
};

/** Nothing to add on: no native rail and no custom rail is open for payouts. */
export const noAddableRails = (details: DepositDetails | null): boolean =>
  !!details
  && !details.BANK.withdrawalEnabled
  && !details.UPI.withdrawalEnabled
  && !details.custom.some((c) => c.withdrawalEnabled);

/** The Add form's own refusal. */
export const addMethodProblem = (label: string): string | null =>
  (!label || label.trim().length < 2 ? 'Add a label (e.g. "HDFC Salary")' : null);

/**
 * POST /withdrawal-methods — AddForm `submit`: `{ type, label }` plus the
 * native rail's own fields, or `{ type: 'CUSTOM', methodKey, details }` for
 * any other rail, its values keyed by withdrawalFieldKey. The server
 * validates; nothing else is pre-validated here, so its message is what a
 * user sees.
 */
export const buildAddMethodBody = (
  type: AddMethodType,
  label: string,
  form: Readonly<Record<string, string>>,
): NewWithdrawalMethod => {
  const l = label.trim();
  if (type.id === 'BANK') {
    return {
      type: 'BANK',
      label: l,
      accountHolderName: form.accountHolderName ?? '',
      bankName: form.bankName ?? '',
      accountNumber: form.accountNumber ?? '',
      ifsc: form.ifsc ?? '',
    };
  }
  if (type.id === 'UPI') return { type: 'UPI', label: l, upiId: form.upiId ?? '' };
  const details: Record<string, string> = {};
  for (const f of type.schema) {
    const k = withdrawalFieldKey(f);
    if (k) details[k] = String(form[k] ?? '').trim();
  }
  return { type: 'CUSTOM', label: l, methodKey: type.id, details };
};

/* ══ Recent withdrawals ══════════════════════════════════════════════ */

export type TxStatusTone = 'primary' | 'info' | 'bull' | 'bear' | 'neutral';

/** Wallet.jsx StatusBadge colours, in the kit's tones. */
export const txStatusTone = (status: string): TxStatusTone => {
  const s = up(status);
  if (s === 'PENDING') return 'primary';
  if (s === 'APPROVED' || s === 'PROCESSING') return 'info';
  if (s === 'CONFIRMED' || s === 'COMPLETED') return 'bull';
  if (s === 'REJECTED') return 'bear';
  return 'neutral';
};

/* ── Small re-exports so a view needs one import ─────────────────────── */

export { currencySymbol, fmtMoney, fmtNum, isDemoLike, isRealMoney };
