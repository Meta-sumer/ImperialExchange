/**
 * Money movement: the per-account trading wallets, their ledger, deposits,
 * withdrawals and payout destinations, peer transfers, and the two
 * user-level wallets (Main / "subscription", and Bonus).
 *
 * EquityHub is INR-only: every amount is rupees (backend BASE_CURRENCY), so
 * a missing currency reads as 'INR'. Every amount is a Decimal string,
 * carried unparsed from the server to the formatter — see types/trading.
 * The one exception is where the SERVER already sends a JSON number (a
 * Razorpay order amount); that is kept as a number.
 */
import { bool, dec, id, num, str, strOrNull } from '@/types/api';
import type { Decimal } from '@/types/trading';

type Raw = Record<string, unknown>;

const asRecord = (v: unknown): Raw =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

const idOf = (v: unknown): string | null => {
  if (typeof v === 'string' && v) return v;
  if (v && typeof v === 'object') return id(v as Raw) || null;
  return null;
};

/** The platform's only currency (backend config/constants BASE_CURRENCY). */
export const BASE_CURRENCY = 'INR';

/* ══ Trading wallets ══════════════════════════════════════════════════ */

/** One row of GET /wallet/balances: an account's wallet. */
export interface WalletBalance {
  id: string;
  accountId: string;
  currency: string;
  balance: Decimal;
  /** Margin reserved for open positions. */
  locked: Decimal;
  /** balance − locked, floored at zero — computed by the server. */
  free: Decimal;
  updatedAt: string | null;
}

export const toWalletBalance = (body: unknown): WalletBalance => {
  const raw = asRecord(body);
  return {
    id: id(raw),
    accountId: idOf(raw.accountId) ?? '',
    currency: str(raw.currency) || BASE_CURRENCY,
    balance: dec(raw.balance),
    locked: dec(raw.locked),
    // The server always sends `free`. If a proxy stripped it, the balance is
    // NOT a substitute — it would overstate what can be withdrawn by the
    // margin in use — so it reads as zero rather than as the balance.
    free: dec(raw.free),
    updatedAt: strOrNull(raw.updatedAt),
  };
};

/**
 * One row of GET /wallet/equity — an account's FLOATING balance
 * (walletController.getAccountsEquity): the settled balance plus the open
 * positions' unrealized P&L, marked at Instrument.lastPrice. EquityHub's
 * header chip reads it (hooks/useFloatingBalance.js).
 */
export interface AccountEquity {
  accountId: string;
  currency: string;
  /** Fixed / realized. */
  balance: Decimal;
  unrealizedPnl: Decimal;
  /** Floating = balance + Σ uPnL. */
  equity: Decimal;
  usedMargin: Decimal;
  free: Decimal;
  freeMargin: Decimal;
  /** % — null when no margin is in use. */
  marginLevel: Decimal | null;
  status: string;
  stoppedOut: boolean;
}

export const toAccountEquity = (body: unknown): AccountEquity => {
  const raw = asRecord(body);
  return {
    accountId: idOf(raw.accountId) ?? '',
    currency: str(raw.currency) || BASE_CURRENCY,
    balance: dec(raw.balance),
    unrealizedPnl: dec(raw.unrealizedPnl),
    equity: dec(raw.equity),
    usedMargin: dec(raw.usedMargin),
    free: dec(raw.free),
    freeMargin: dec(raw.freeMargin),
    marginLevel: raw.marginLevel == null ? null : dec(raw.marginLevel),
    status: str(raw.status) || 'ACTIVE',
    stoppedOut: raw.stoppedOut === true,
  };
};

/* ══ Ledger ═══════════════════════════════════════════════════════════ */

export type LedgerType =
  | 'DEPOSIT' | 'WITHDRAWAL' | 'TRADE_OPEN' | 'TRADE_CLOSE' | 'FEE'
  | 'ADJUSTMENT' | 'DIVIDEND' | 'TRANSFER'
  | 'INTERNAL_TRANSFER_OUT' | 'INTERNAL_TRANSFER_IN'
  | (string & {});

export interface LedgerCounterparty {
  userId: string;
  name: string;
  referralCode: string | null;
  avatarUrl: string | null;
}

export interface LedgerEntry {
  id: string;
  accountId: string | null;
  type: LedgerType;
  currency: string;
  /** SIGNED: positive is a credit, negative a debit. */
  amount: Decimal;
  /** The realized balance before the mutation; null on rows that predate the field. */
  balanceBefore: Decimal | null;
  balanceAfter: Decimal;
  referenceType: string | null;
  referenceId: string | null;
  note: string | null;
  /** Peer transfers only — the other user, inlined by the server. */
  counterparty: LedgerCounterparty | null;
  createdAt: string | null;
}

export const toLedgerEntry = (body: unknown): LedgerEntry => {
  const raw = asRecord(body);
  const cp = raw.counterparty && typeof raw.counterparty === 'object'
    ? asRecord(raw.counterparty)
    : null;
  return {
    id: id(raw),
    accountId: idOf(raw.accountId),
    type: str(raw.type),
    currency: str(raw.currency) || BASE_CURRENCY,
    amount: dec(raw.amount),
    balanceBefore: raw.balanceBefore == null || raw.balanceBefore === '' ? null : dec(raw.balanceBefore),
    balanceAfter: dec(raw.balanceAfter),
    referenceType: strOrNull(raw.referenceType),
    referenceId: idOf(raw.referenceId),
    note: strOrNull(raw.note),
    counterparty: cp
      ? {
        userId: str(cp.userId),
        name: str(cp.name),
        referralCode: strOrNull(cp.referralCode),
        avatarUrl: strOrNull(cp.avatarUrl),
      }
      : null,
    createdAt: strOrNull(raw.createdAt),
  };
};

/**
 * The ledger Type column. Wallet.jsx ledgerTypeLabel — peer transfers read
 * as what they are; everything else is the server's own enum, verbatim.
 */
export const ledgerTypeLabel = (entry: Pick<LedgerEntry, 'type'>): string => {
  if (entry.type === 'INTERNAL_TRANSFER_OUT') return 'Transfer Sent';
  if (entry.type === 'INTERNAL_TRANSFER_IN') return 'Transfer Received';
  return entry.type;
};

/** "to Jane Doe" / "from Jane Doe" beside a peer transfer (Wallet.jsx LedgerTable). */
export const ledgerCounterpartyLabel = (
  entry: Pick<LedgerEntry, 'type' | 'counterparty'>,
): string | null => {
  const cp = entry.counterparty;
  if (!cp) return null;
  if (entry.type === 'INTERNAL_TRANSFER_OUT') return `to ${cp.name}`;
  if (entry.type === 'INTERNAL_TRANSFER_IN') return `from ${cp.name}`;
  return null;
};

/* ══ Deposits ═════════════════════════════════════════════════════════ */

export type DepositStatus = 'PENDING' | 'CONFIRMED' | 'COMPLETED' | 'REJECTED' | 'CANCELLED' | (string & {});

export interface Deposit {
  id: string;
  accountId: string | null;
  /** Which wallet a confirmed deposit credits. */
  targetWallet: 'trading' | 'subscription' | 'bonus' | (string & {});
  currency: string;
  amount: Decimal;
  baseCurrency: string;
  baseAmount: Decimal;
  fxRateUsed: number | null;
  rateSource: string | null;
  /** The admin-configured deposit fee the server booked (Razorpay credits amount − fee). */
  fee: Decimal;
  feeAmount: Decimal;
  /** After the platform fee. Null on rows that predate fees. */
  netAmount: Decimal | null;
  paymentMethodCode: string | null;
  method: string | null;
  txReference: string | null;
  /** Payment proof — a data URL or https URL. Large; render lazily. */
  screenshot: string | null;
  senderName: string | null;
  senderUpiId: string | null;
  senderBankAccount: string | null;
  status: DepositStatus;
  rejectionReason: string | null;
  note: string | null;
  confirmedAt: string | null;
  createdAt: string | null;
}

export const toDeposit = (body: unknown): Deposit => {
  const raw = asRecord(body);
  return {
    id: id(raw),
    accountId: idOf(raw.accountId),
    targetWallet: str(raw.targetWallet) || 'trading',
    currency: str(raw.currency) || BASE_CURRENCY,
    amount: dec(raw.amount),
    baseCurrency: str(raw.baseCurrency) || BASE_CURRENCY,
    baseAmount: dec(raw.baseAmount),
    fxRateUsed: num(raw.fxRateUsed),
    rateSource: strOrNull(raw.rateSource),
    fee: dec(raw.fee),
    feeAmount: dec(raw.feeAmount),
    netAmount: raw.netAmount == null ? null : dec(raw.netAmount),
    paymentMethodCode: strOrNull(raw.paymentMethodCode),
    method: strOrNull(raw.method),
    txReference: strOrNull(raw.txReference),
    screenshot: strOrNull(raw.screenshot),
    senderName: strOrNull(raw.senderName),
    senderUpiId: strOrNull(raw.senderUpiId),
    senderBankAccount: strOrNull(raw.senderBankAccount),
    status: str(raw.status) || 'PENDING',
    rejectionReason: strOrNull(raw.rejectionReason),
    note: strOrNull(raw.note),
    confirmedAt: strOrNull(raw.confirmedAt) ?? strOrNull(raw.completedAt),
    createdAt: strOrNull(raw.createdAt),
  };
};

/**
 * POST /wallet/deposits — walletController.createDeposit reads
 * `accountId, currency, amount, method, txReference, note, screenshot,
 * screenshotMimeType, senderName, senderUpiId, senderBankAccount`.
 * Real-money accounts need the proof fields; practice accounts are credited
 * instantly.
 */
export interface CreateDepositInput {
  accountId: string;
  /** Always 'INR' — the server refuses anything else (CURRENCY_NOT_SUPPORTED). */
  currency: string;
  /** As typed — the server validates and books `String(amount)`. */
  amount: string | number;
  /** A fixed rail id (UPI / BANK) or a custom rail's LABEL. */
  method: string;
  txReference?: string;
  note?: string;
  senderName?: string;
  senderUpiId?: string;
  senderBankAccount?: string;
  /** `data:image/…;base64,…`. Real-money accounts only. */
  screenshot?: string;
  screenshotMimeType?: string;
}

/** POST /wallet/razorpay/order. */
export interface RazorpayOrder {
  depositId: string;
  orderId: string;
  /** In major units; Checkout wants paise, so ×100 at the call site. */
  amount: number;
  currency: string;
  /** Publishable key id — safe on the client, unlike the secret. */
  keyId: string | null;
}

export const toRazorpayOrder = (body: unknown): RazorpayOrder => {
  const raw = asRecord(body);
  return {
    depositId: idOf(raw.depositId) ?? '',
    orderId: str(raw.orderId),
    amount: num(raw.amount) ?? 0,
    currency: str(raw.currency) || BASE_CURRENCY,
    keyId: strOrNull(raw.keyId),
  };
};

export interface RazorpayVerifyInput {
  orderId: string;
  paymentId: string;
  signature: string;
}

export interface RazorpayVerifyResult {
  depositId: string;
  status: string;
  /** True on a replay — the deposit was already credited. */
  alreadyCredited: boolean;
}

/* ══ Payment rails (deposit.paymentDetails) ═══════════════════════════ */

/**
 * The admin's per-rail rules, in rupees (backend utils/paymentMethods
 * LIMIT_KEYS + the fee keys). 0 means "no limit" / "no fee".
 */
export interface RailRules {
  minDeposit: number;
  maxDeposit: number;
  minWithdrawal: number;
  maxWithdrawal: number;
  /** Deposit fee. */
  feePercent: number;
  feeFixed: number;
  /** Withdrawal fee. */
  withdrawalFeePercent: number;
  withdrawalFeeFixed: number;
}

/** One field the admin asks a payout destination to collect (withdrawalFields[]). */
export interface WithdrawalField {
  label: string;
  /** Explicit storage key, when the admin gave one; otherwise the label's slug. */
  key: string | null;
  required: boolean;
  sensitive: boolean;
  placeholder: string | null;
}

/** Common to every rail the admin configures. */
interface RailBase extends RailRules {
  /** False when the admin has never stored this rail at all. */
  configured: boolean;
  /** The DEPOSIT picker. Absent means enabled. */
  enabled: boolean;
  /** The WITHDRAWAL picker — a separate decision. Absent falls back to `enabled`. */
  withdrawalEnabled: boolean;
  note: string | null;
  /** Optional scan-to-pay image, a data URL. */
  qr: string | null;
  /** What a payout destination on this rail collects (admin schema); [] when undescribed. */
  withdrawalFields: WithdrawalField[];
}

export interface UpiRail extends RailBase { upiId: string | null; payeeName: string | null }
export interface BankRail extends RailBase {
  accountName: string | null;
  accountNumber: string | null;
  ifsc: string | null;
  bankName: string | null;
}
/** Razorpay — the automatic gateway; it has no payee details of its own. */
export type RazorpayRail = RailBase;

export interface CustomRailField { label: string; value: string; copy: boolean }

/** An admin-defined rail beyond the fixed ones. */
export interface CustomRail extends RailBase {
  id: string;
  label: string;
  emoji: string | null;
  fields: CustomRailField[];
}

/**
 * The fixed rails, in the web's order — backend utils/paymentMethods
 * FIXED_METHOD_IDS ("INR-only: UPI, bank transfer and Razorpay").
 */
export const FIXED_RAILS = ['UPI', 'BANK', 'RAZORPAY'] as const;
export type FixedRailId = (typeof FIXED_RAILS)[number];

/** The fixed rails a user PAYS INTO by hand (Wallet.jsx FIXED_MANUAL). */
export const MANUAL_RAILS = ['UPI', 'BANK'] as const;
export type ManualRailId = (typeof MANUAL_RAILS)[number];

/**
 * Rails whose destinations have their own columns (and their own form), so
 * saved methods are matched by `type`; every other rail stores its
 * destination generically and is matched by `methodKey`
 * (Wallet.jsx W_NATIVE_DESTINATION_RAILS, WithdrawModal.jsx).
 */
export const NATIVE_DESTINATION_RAILS: ReadonlySet<string> = new Set(['UPI', 'BANK']);

/** GET /wallet/deposit-details — the admin's "where to send money" config. */
export interface DepositDetails {
  UPI: UpiRail;
  BANK: BankRail;
  RAZORPAY: RazorpayRail;
  custom: CustomRail[];
  /**
   * The company bank account the Super Admin assigned to THIS user (the BANK
   * rail above already carries its details). Absent when the pool is empty
   * or the caller is staff — then the rail is the global config.
   */
  assignedBank?: { label: string; bankName: string | null } | null;
}

const positive = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const toWithdrawalFields = (v: unknown): WithdrawalField[] =>
  (Array.isArray(v) ? v : [])
    .map((f) => {
      const r = asRecord(f);
      return {
        label: str(r.label),
        key: strOrNull(r.key),
        required: r.required !== false,
        sensitive: r.sensitive === true,
        placeholder: strOrNull(r.placeholder),
      };
    })
    .filter((f) => f.label !== '');

const railBase = (r: Raw, configured: boolean): RailBase => ({
  configured,
  // Absent reads as enabled: a settings document written before these flags
  // existed must not silently close every rail.
  enabled: r.enabled !== false,
  // No stored withdrawal switch → the deposit one: the shared rule the web and
  // the server apply (backend utils/paymentMethods railEnabled).
  withdrawalEnabled: r.withdrawalEnabled === undefined || r.withdrawalEnabled === null
    ? r.enabled !== false
    : r.withdrawalEnabled !== false,
  note: strOrNull(r.note),
  qr: strOrNull(r.qr),
  withdrawalFields: toWithdrawalFields(r.withdrawalFields),
  minDeposit: positive(r.minDeposit),
  maxDeposit: positive(r.maxDeposit),
  minWithdrawal: positive(r.minWithdrawal),
  maxWithdrawal: positive(r.maxWithdrawal),
  feePercent: positive(r.feePercent),
  feeFixed: positive(r.feeFixed),
  withdrawalFeePercent: positive(r.withdrawalFeePercent),
  withdrawalFeeFixed: positive(r.withdrawalFeeFixed),
});

export const toDepositDetails = (body: unknown): DepositDetails => {
  const raw = asRecord(body);
  const has = (k: string): boolean => !!raw[k] && typeof raw[k] === 'object';
  const upi = asRecord(raw.UPI);
  const bank = asRecord(raw.BANK);
  const razorpay = asRecord(raw.RAZORPAY);
  const custom = Array.isArray(raw.custom) ? raw.custom : [];
  return {
    UPI: { ...railBase(upi, has('UPI')), upiId: strOrNull(upi.upiId), payeeName: strOrNull(upi.payeeName) },
    BANK: {
      ...railBase(bank, has('BANK')),
      accountName: strOrNull(bank.accountName),
      accountNumber: strOrNull(bank.accountNumber),
      ifsc: strOrNull(bank.ifsc),
      bankName: strOrNull(bank.bankName),
    },
    RAZORPAY: railBase(razorpay, has('RAZORPAY')),
    ...(raw.assignedBank && typeof raw.assignedBank === 'object'
      ? { assignedBank: { label: str(asRecord(raw.assignedBank).label), bankName: strOrNull(asRecord(raw.assignedBank).bankName) } }
      : {}),
    custom: custom
      .map((c) => {
        const r = asRecord(c);
        const fields = Array.isArray(r.fields) ? r.fields : [];
        return {
          ...railBase(r, true),
          id: str(r.id),
          label: str(r.label),
          emoji: strOrNull(r.emoji),
          fields: fields.map((f) => {
            const fr = asRecord(f);
            return { label: str(fr.label), value: str(fr.value), copy: fr.copy !== false };
          }),
        };
      })
      // The web lists only custom rails that have a label (`c && c.label`).
      .filter((c) => c.label !== ''),
  };
};

/** The id a custom rail goes by in the DEPOSIT picker. Wallet.jsx `CUSTOM:${c.id}`. */
export const customRailId = (rail: Pick<CustomRail, 'id'>): string => `CUSTOM:${rail.id}`;

export const findCustomRail = (details: DepositDetails | null, methodId: string): CustomRail | null =>
  (details?.custom ?? []).find((c) => customRailId(c) === methodId) ?? null;

export interface RailRow {
  label: string;
  value: string;
  /** Whether a copy button belongs beside it. */
  copyable: boolean;
}

/**
 * The payee rows for a method, blanks dropped (Wallet.jsx "Pay to these
 * details"). An empty result means the admin has not set this rail up, and
 * the web says so ("Payment details for X aren't set up yet. Please contact
 * support before sending money.").
 */
export const depositRailRows = (details: DepositDetails | null, methodId: string): RailRow[] => {
  if (!details) return [];
  const custom = findCustomRail(details, methodId);
  let rows: RailRow[];
  if (custom) {
    rows = custom.fields.map((f) => ({ label: f.label, value: f.value, copyable: f.copy }));
  } else if (methodId === 'UPI') {
    rows = [
      { label: 'UPI ID', value: details.UPI.upiId ?? '', copyable: true },
      { label: 'Beneficiary', value: details.UPI.payeeName ?? '', copyable: false },
    ];
  } else if (methodId === 'BANK') {
    rows = [
      { label: 'Beneficiary', value: details.BANK.accountName ?? '', copyable: false },
      { label: 'Bank A/C', value: details.BANK.accountNumber ?? '', copyable: true },
      { label: 'IFSC', value: details.BANK.ifsc ?? '', copyable: true },
      { label: 'Bank', value: details.BANK.bankName ?? '', copyable: false },
    ];
  } else {
    rows = [];
  }
  return rows.filter((r) => r.value.trim() !== '');
};

/** The note and QR that go under the rows, for either kind of rail. */
export const depositRailExtras = (
  details: DepositDetails | null,
  methodId: string,
): { note: string | null; qr: string | null } => {
  if (!details) return { note: null, qr: null };
  const custom = findCustomRail(details, methodId);
  if (custom) return { note: custom.note, qr: custom.qr };
  if ((FIXED_RAILS as readonly string[]).includes(methodId)) {
    const rail = details[methodId as FixedRailId];
    return { note: rail.note, qr: rail.qr };
  }
  return { note: null, qr: null };
};

/** The admin's config for a method id — a fixed id, `CUSTOM:<id>` or a bare custom id. */
export const railConfig = (details: DepositDetails | null, methodId: string): RailBase | null => {
  if (!details) return null;
  if ((FIXED_RAILS as readonly string[]).includes(methodId)) return details[methodId as FixedRailId];
  const bare = methodId.startsWith('CUSTOM:') ? methodId.slice(7) : methodId;
  return details.custom.find((c) => c.id === bare) ?? null;
};

/** Manual fixed rails the deposit picker offers, in the web's order. */
export const enabledDepositRails = (details: DepositDetails | null): ManualRailId[] =>
  MANUAL_RAILS.filter((r) => !details || details[r].enabled);

export const enabledCustomRails = (details: DepositDetails | null): CustomRail[] =>
  (details?.custom ?? []).filter((c) => c.enabled);

export type PayoutRailType = 'UPI' | 'BANK';

/**
 * The native payout rails the admin pays out on (`withdrawalEnabled`).
 * Nothing loaded reads as both open.
 */
export const payoutRailTypes = (details: DepositDetails | null): PayoutRailType[] => {
  const ALL: PayoutRailType[] = ['UPI', 'BANK'];
  return ALL.filter((t) => !details || details[t].withdrawalEnabled);
};

/* ══ Withdrawals ══════════════════════════════════════════════════════ */

export type WithdrawalStatus =
  | 'PENDING' | 'APPROVED' | 'PROCESSING' | 'COMPLETED' | 'REJECTED' | 'CANCELLED'
  | (string & {});

export interface Withdrawal {
  id: string;
  accountId: string | null;
  /** Which wallet it was drawn from. */
  source: 'TRADING' | 'SUBSCRIPTION' | 'BONUS' | (string & {});
  currency: string;
  amount: Decimal;
  baseCurrency: string;
  baseAmount: Decimal;
  fee: Decimal;
  feeAmount: Decimal;
  netAmount: Decimal | null;
  method: string | null;
  /** Legacy single-field destination. */
  destination: string | null;
  upiId: string | null;
  bankAccountNumber: string | null;
  bankIFSC: string | null;
  bankAccountHolderName: string | null;
  bankName: string | null;
  cryptoAddress: string | null;
  cryptoNetwork: string | null;
  withdrawalMethodId: string | null;
  /** Where the money went, copied at request time. Shape varies by rail. */
  destinationSnapshot: Record<string, unknown> | null;
  status: WithdrawalStatus;
  rejectedReason: string | null;
  txReference: string | null;
  payoutTxReference: string | null;
  payoutAt: string | null;
  approvedAt: string | null;
  note: string | null;
  createdAt: string | null;
}

export const toWithdrawal = (body: unknown): Withdrawal => {
  const raw = asRecord(body);
  return {
    id: id(raw),
    accountId: idOf(raw.accountId),
    source: str(raw.source) || 'TRADING',
    currency: str(raw.currency) || BASE_CURRENCY,
    amount: dec(raw.amount),
    baseCurrency: str(raw.baseCurrency) || BASE_CURRENCY,
    baseAmount: dec(raw.baseAmount),
    fee: dec(raw.fee),
    feeAmount: dec(raw.feeAmount),
    netAmount: raw.netAmount == null ? null : dec(raw.netAmount),
    method: strOrNull(raw.method),
    destination: strOrNull(raw.destination),
    upiId: strOrNull(raw.upiId),
    bankAccountNumber: strOrNull(raw.bankAccountNumber),
    bankIFSC: strOrNull(raw.bankIFSC),
    bankAccountHolderName: strOrNull(raw.bankAccountHolderName),
    bankName: strOrNull(raw.bankName),
    cryptoAddress: strOrNull(raw.cryptoAddress),
    cryptoNetwork: strOrNull(raw.cryptoNetwork),
    withdrawalMethodId: idOf(raw.withdrawalMethodId),
    destinationSnapshot: raw.destinationSnapshot && typeof raw.destinationSnapshot === 'object'
      ? asRecord(raw.destinationSnapshot)
      : null,
    status: str(raw.status) || 'PENDING',
    // The model's field is `rejectedReason`; accept the deposit spelling too.
    rejectedReason: strOrNull(raw.rejectedReason) ?? strOrNull(raw.rejectionReason),
    txReference: strOrNull(raw.txReference),
    payoutTxReference: strOrNull(raw.payoutTxReference),
    payoutAt: strOrNull(raw.payoutAt),
    approvedAt: strOrNull(raw.approvedAt),
    note: strOrNull(raw.note),
    createdAt: strOrNull(raw.createdAt),
  };
};

/**
 * POST /wallet/withdrawals — walletController.requestWithdrawal reads
 * `accountId, currency, amount, method, withdrawalMethodId`.
 *
 * A LIVE account names its destination by `withdrawalMethodId` only — the
 * server resolves the payout from the verified row and refuses a typed
 * destination (ARBITRARY_DESTINATION). A PRACTICE account sends `method`
 * instead: its branch runs before any method check and books the method on
 * the COMPLETED row (Wallet.jsx WithdrawView: `isDemo ? { accountId,
 * currency, amount, method } : { accountId, currency, amount,
 * withdrawalMethodId }`).
 */
export interface CreateWithdrawalInput {
  accountId: string;
  currency: string;
  amount: string | number;
  withdrawalMethodId?: string;
  method?: string;
}

/** The Main / Bonus wallet withdraw endpoints answer this. */
export interface WalletWithdrawalResult {
  withdrawalId: string;
  status: string;
  amount: Decimal;
  currency: string;
  method: string | null;
  /** The wallet's balance after the hold. */
  balance: Decimal | null;
}

export const toWalletWithdrawalResult = (body: unknown): WalletWithdrawalResult => {
  const raw = asRecord(body);
  return {
    withdrawalId: idOf(raw.withdrawalId) ?? id(raw),
    status: str(raw.status) || 'PENDING',
    amount: dec(raw.amount),
    currency: str(raw.currency) || BASE_CURRENCY,
    method: strOrNull(raw.method),
    balance: raw.balance == null ? null : dec(raw.balance),
  };
};

/* ── Payout destinations (withdrawal methods) ─────────────────────────── */

export type WithdrawalMethodType = 'BANK' | 'UPI' | 'CRYPTO' | 'CUSTOM' | (string & {});
export type WithdrawalMethodStatus = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'BLOCKED' | (string & {});

/**
 * A saved destination as GET /withdrawal-methods returns it
 * (WithdrawalMethod.toSafeJSON): MASKED. Full account numbers never leave
 * the server — the user picks a method by id.
 */
export interface WithdrawalMethod {
  id: string;
  type: WithdrawalMethodType;
  /** The user's name for it ("HDFC Salary"); the server requires one. */
  label: string;
  /** `maskedDestination` — "HDFC ••1234", "ra**@okicici". */
  masked: string;
  status: WithdrawalMethodStatus;
  /** Only a verified method can receive a payout. */
  isVerified: boolean;
  archived: boolean;
  /** A CUSTOM method's rail — deposit.paymentDetails.custom[].id (or a generic fixed rail id). */
  methodKey: string | null;
  bankName: string | null;
  network: string | null;
  /** A CUSTOM method's (masked) field values. */
  details: Record<string, string> | null;
  /** `rejectedReason` — only on a REJECTED method. */
  rejectionReason: string | null;
  createdAt: string | null;
  verifiedAt: string | null;
  lastUsedAt: string | null;
}

export const toWithdrawalMethod = (body: unknown): WithdrawalMethod => {
  const raw = asRecord(body);
  const status = str(raw.status) || 'PENDING';
  const masked = str(raw.maskedDestination) || str(raw.masked);
  const detailsRaw = raw.details && typeof raw.details === 'object' ? asRecord(raw.details) : null;
  return {
    id: id(raw),
    type: str(raw.type),
    label: str(raw.label) || masked,
    masked,
    status,
    // The server keeps this in step with status; derive it the same way if absent.
    isVerified: raw.isVerified === undefined ? status === 'VERIFIED' : bool(raw.isVerified),
    archived: raw.archived === true,
    methodKey: strOrNull(raw.methodKey),
    bankName: strOrNull(raw.bankName),
    network: strOrNull(raw.network),
    details: detailsRaw
      ? Object.fromEntries(Object.entries(detailsRaw).map(([k, v]) => [k, String(v ?? '')]))
      : null,
    rejectionReason: strOrNull(raw.rejectedReason) ?? strOrNull(raw.rejectionReason),
    createdAt: strOrNull(raw.createdAt),
    verifiedAt: strOrNull(raw.verifiedAt),
    lastUsedAt: strOrNull(raw.lastUsedAt),
  };
};

/**
 * POST /withdrawal-methods (withdrawalMethodController.addMethod). Starts
 * PENDING until an admin verifies it. `label` is required (≥ 2 chars).
 */
export type NewWithdrawalMethod =
  | { type: 'BANK'; label: string; accountHolderName: string; bankName?: string; accountNumber: string; ifsc: string }
  | { type: 'UPI'; label: string; upiId: string }
  | { type: 'CRYPTO'; label: string; network: string; walletAddress: string }
  | { type: 'CUSTOM'; label: string; methodKey: string; details: Record<string, string> };

/**
 * Methods a withdrawal may use: verified and not archived. With
 * `allowTypes`, only those types.
 */
export const usableWithdrawalMethods = (
  methods: ReadonlyArray<WithdrawalMethod>,
  allowTypes?: ReadonlyArray<string> | null,
): WithdrawalMethod[] =>
  methods.filter((m) => m.isVerified && !m.archived && (!allowTypes || allowTypes.includes(m.type)));

/**
 * The verified destinations on one payout rail: a native rail (UPI / BANK)
 * by `type`, any other by the `methodKey` it was saved against — custom
 * methods all share the type CUSTOM (Wallet.jsx verifiedOfType,
 * WithdrawModal.jsx destinations).
 */
export const verifiedForRail = (methods: ReadonlyArray<WithdrawalMethod>, railId: string): WithdrawalMethod[] =>
  usableWithdrawalMethods(methods).filter((m) =>
    (NATIVE_DESTINATION_RAILS.has(railId) ? m.type === railId : m.methodKey === railId));

/* ══ Transfers ════════════════════════════════════════════════════════ */

/**
 * The literal id POST /wallet/transfers accepts in place of an account id
 * for the user-level Bonus Wallet.
 */
export const BONUS_WALLET_ID = 'bonus';
// The retired Main Wallet's 'subscription' sentinel is never sent: the
// server answers 410 MAIN_WALLET_RETIRED to it. It survives only in old rows.

/** walletController.internalTransfer reads `fromAccountId, toAccountId, currency, amount, note`. */
export interface TransferInput {
  /** An account id, or BONUS_WALLET_ID. */
  fromAccountId: string;
  toAccountId: string;
  currency: string;
  amount: string | number;
  note?: string;
}

export interface TransferResult {
  from: string;
  to: string;
  amount: Decimal;
  currency: string;
}

/** GET /wallet/transfer-user/settings — admin limits for peer transfers. */
export interface PeerTransferSettings {
  enabled: boolean;
  /** "0" means no minimum. */
  min: Decimal;
  /** "0" means no maximum. */
  max: Decimal;
  feePercent: Decimal;
}

/**
 * The web starts from permissive defaults and keeps them if the settings
 * call fails — the server enforces the caps regardless.
 */
export const DEFAULT_PEER_TRANSFER_SETTINGS: PeerTransferSettings = {
  enabled: true, min: '0', max: '0', feePercent: '0',
};

export const toPeerTransferSettings = (body: unknown): PeerTransferSettings => {
  const raw = asRecord(body);
  return {
    enabled: raw.enabled !== false,
    min: dec(raw.min),
    max: dec(raw.max),
    feePercent: dec(raw.feePercent),
  };
};

export interface TransferRecipient {
  id: string;
  name: string;
  email: string | null;
  userUid: string | null;
  referralCode: string | null;
  avatarUrl: string | null;
}

export const toTransferRecipient = (body: unknown): TransferRecipient => {
  const raw = asRecord(body);
  const email = strOrNull(raw.email);
  return {
    id: id(raw),
    name: str(raw.name) || email || '',
    email,
    userUid: strOrNull(raw.userUid),
    referralCode: strOrNull(raw.referralCode),
    avatarUrl: strOrNull(raw.avatarUrl),
  };
};

/**
 * POST /wallet/transfer-user — walletController.transferToUser reads
 * `fromAccountId, currency, amount, note, recipientUserId`.
 */
export interface PeerTransferInput {
  /** One of the sender's LIVE trading accounts. */
  fromAccountId: string;
  currency: string;
  amount: string;
  note?: string;
  recipientUserId: string;
}

/** POST /wallet/transfer-user. `totalDebited` includes the fee. */
export interface PeerTransferResult {
  referenceId: string;
  toUserId: string;
  recipientName: string;
  currency: string;
  amount: Decimal;
  fee: Decimal;
  totalDebited: Decimal;
  createdAt: string | null;
}

export const toPeerTransferResult = (body: unknown): PeerTransferResult => {
  const raw = asRecord(body);
  const recipient = asRecord(raw.recipient);
  return {
    referenceId: str(raw.referenceId),
    toUserId: str(raw.toUserId),
    recipientName: str(recipient.name),
    currency: str(raw.currency) || BASE_CURRENCY,
    amount: dec(raw.amount),
    fee: dec(raw.fee),
    totalDebited: dec(raw.totalDebited),
    createdAt: strOrNull(raw.createdAt),
  };
};

/* ══ FX (legacy) ══════════════════════════════════════════════════════ */

/**
 * GET /fx/usdinr — kept on EquityHub "for older clients" and answering
 * `{ rate: 1, source: 'inr-ledger' }`. NOT enveloped. `rate` is null for a
 * `source: 'fallback'` answer or nonsense.
 */
export interface FxRate {
  rate: number | null;
  source: string | null;
  /** When the server answered, epoch ms. */
  ts: number | null;
}

export const toFxRate = (body: unknown): FxRate => {
  const raw = asRecord(body);
  // Tolerate an envelope in case the route is ever moved behind sendSuccess.
  const src = raw.data && typeof raw.data === 'object' ? asRecord(raw.data) : raw;
  const source = strOrNull(src.source);
  const n = num(src.rate);
  const usable = n !== null && n > 0 && source !== 'fallback';
  return { rate: usable ? n : null, source, ts: num(src.ts) };
};

/* ══ The Bonus Wallet — the wallet plans are billed from ══════════════ */

/**
 * The plan-billing wallet: GET /bonus-wallet, and `billingWallet` on GET
 * /subscriptions/me (`type: 'BONUS'`). The Main Wallet (subscription
 * wallet) that used to hold this job is retired.
 */
export interface BillingWallet {
  id: string;
  balance: Decimal;
  currency: string;
  autoRenew: boolean;
  gracePeriodDays: number | null;
  lowBalanceThreshold: Decimal;
  /** Server-computed: balance ≤ threshold. */
  isLowBalance: boolean;
  updatedAt: string | null;
}

export const toBillingWallet = (body: unknown): BillingWallet => {
  const raw = asRecord(body);
  return {
    id: id(raw),
    balance: dec(raw.balance),
    currency: str(raw.currency) || BASE_CURRENCY,
    // The model defaults it on; absent is not "off".
    autoRenew: raw.autoRenew !== false,
    gracePeriodDays: num(raw.gracePeriodDays),
    lowBalanceThreshold: dec(raw.lowBalanceThreshold),
    isLowBalance: bool(raw.isLowBalance),
    updatedAt: strOrNull(raw.updatedAt),
  };
};

/** GET /bonus-wallet — the wallet plus the server's earnings roll-up. */
export interface BonusWallet extends BillingWallet {
  totalReferralEarnings: Decimal;
  totalPartnerEarnings: Decimal;
  totalRevenueShare: Decimal;
  totalBonusRewards: Decimal;
  totalEarnings: Decimal;
}

export const toBonusWallet = (body: unknown): BonusWallet => {
  const raw = asRecord(body);
  return {
    ...toBillingWallet(raw),
    totalReferralEarnings: dec(raw.totalReferralEarnings),
    totalPartnerEarnings: dec(raw.totalPartnerEarnings),
    totalRevenueShare: dec(raw.totalRevenueShare),
    totalBonusRewards: dec(raw.totalBonusRewards),
    totalEarnings: dec(raw.totalEarnings),
  };
};

/**
 * One row of a user-level wallet's history — the Bonus Wallet's, or an old,
 * read-only Main Wallet row. Amounts are UNSIGNED.
 */
export interface WalletTransaction {
  id: string;
  transactionType: 'CREDIT' | 'DEBIT' | 'REFUND' | (string & {});
  reason: string;
  status: 'SUCCESS' | 'PENDING' | 'FAILED' | (string & {});
  amount: Decimal;
  currency: string;
  balanceAfter: Decimal | null;
  planCode: string | null;
  billingCycle: string | null;
  note: string | null;
  paymentMethod: string | null;
  paymentRef: string | null;
  /**
   * What the row funded — a withdrawal's id on the debit that held it, which
   * is how Transaction History finds that withdrawal's balances.
   */
  referenceId: string | null;
  /** Transfers: 'trading:<accountId>' | 'subscription' (old rows). */
  sourceWallet: string | null;
  /**
   * GET /subscriptions/history tags each row with the wallet it came from:
   * 'BONUS' (plan charges now) or 'MAIN' (the retired Main Wallet's rows).
   * Null on the per-wallet histories, which do not say.
   */
  wallet: 'MAIN' | 'BONUS' | null;
  createdAt: string | null;
}

export const toWalletTransaction = (body: unknown): WalletTransaction => {
  const raw = asRecord(body);
  return {
    id: id(raw),
    transactionType: str(raw.transactionType),
    reason: str(raw.reason),
    status: str(raw.status) || 'SUCCESS',
    amount: dec(raw.amount),
    currency: str(raw.currency) || BASE_CURRENCY,
    balanceAfter: raw.balanceAfter == null ? null : dec(raw.balanceAfter),
    planCode: strOrNull(raw.planCode),
    billingCycle: strOrNull(raw.billingCycle),
    note: strOrNull(raw.note),
    paymentMethod: strOrNull(raw.paymentMethod),
    paymentRef: strOrNull(raw.paymentRef),
    referenceId: idOf(raw.referenceId),
    sourceWallet: strOrNull(raw.sourceWallet),
    wallet: raw.wallet === 'MAIN' || raw.wallet === 'BONUS' ? raw.wallet : null,
    createdAt: strOrNull(raw.createdAt),
  };
};

/**
 * POST /bonus-wallet/manual-deposit — bonusWalletController.manualDeposit
 * reads `amount, currency, method, txReference, senderName, senderUpiId,
 * senderBankAccount, screenshot, screenshotMimeType, note`.
 */
export interface BonusManualDepositInput {
  amount: number;
  currency: string;
  /** A fixed rail id, or a custom rail's LABEL (as the web sends it). */
  method: string;
  txReference: string;
  senderName?: string;
  senderUpiId?: string;
  senderBankAccount?: string;
  /** Required — the server refuses a manual top-up without proof. */
  screenshot: string;
  screenshotMimeType?: string;
  note?: string;
}

export interface ManualDepositResult {
  depositId: string;
  status: string;
  amount: Decimal;
  currency: string;
  method: string | null;
}

export const toManualDepositResult = (body: unknown): ManualDepositResult => {
  const raw = asRecord(body);
  return {
    depositId: idOf(raw.depositId) ?? '',
    status: str(raw.status) || 'PENDING',
    amount: dec(raw.amount),
    currency: str(raw.currency) || BASE_CURRENCY,
    method: strOrNull(raw.method),
  };
};

/**
 * `details` on a 402 INSUFFICIENT_TRADING_BALANCE from the Bonus Wallet's
 * instant Add Funds — the web names the account and what it actually holds.
 */
export interface InsufficientTradingBalance {
  accountNumber: string;
  currency: string;
  available: Decimal;
}

/* ══ Credit transactions (/wallet/credit) ═════════════════════════════ */

export type CreditKind = 'DEPOSIT' | 'WITHDRAWAL';
/** PENDING → PARTIALLY_SETTLED → SETTLED, or CANCELLED before any payment. */
export type CreditStatus = 'PENDING' | 'PARTIALLY_SETTLED' | 'SETTLED' | 'CANCELLED' | (string & {});

export interface CreditSettlement {
  amount: Decimal;
  at: string | null;
  remarks: string | null;
}

/**
 * A deposit or withdrawal the desk processed ON CREDIT (admin → Credit
 * Ledger). The trading wallet moved when it was granted; the row tracks what
 * is still owed in the real world until the admin records the payment(s).
 * A DEPOSIT credit is money the user owes; a WITHDRAWAL credit is money due
 * to the user.
 */
export interface CreditTransaction {
  id: string;
  accountId: string | null;
  kind: CreditKind;
  amount: Decimal;
  currency: string;
  settledAmount: Decimal;
  /** amount − settledAmount, as the server computes it. */
  outstanding: Decimal;
  status: CreditStatus;
  remarks: string | null;
  dueDate: string | null;
  settlements: CreditSettlement[];
  createdAt: string | null;
  settledAt: string | null;
}

export const toCreditTransaction = (body: unknown): CreditTransaction => {
  const raw = asRecord(body);
  const kind = String(raw.kind || 'DEPOSIT').toUpperCase() === 'WITHDRAWAL' ? 'WITHDRAWAL' : 'DEPOSIT';
  const amount = dec(raw.amount);
  const settledAmount = dec(raw.settledAmount);
  const outstanding = raw.outstanding !== undefined && raw.outstanding !== null
    ? dec(raw.outstanding)
    : dec(Math.max(0, Number(amount) - Number(settledAmount)));
  const settlements = Array.isArray(raw.settlements) ? raw.settlements : [];
  return {
    id: id(raw),
    accountId: idOf(raw.accountId),
    kind,
    amount,
    currency: str(raw.currency) || BASE_CURRENCY,
    settledAmount,
    outstanding,
    status: String(raw.status || 'PENDING').toUpperCase(),
    remarks: strOrNull(raw.remarks),
    dueDate: strOrNull(raw.dueDate),
    settlements: settlements.map((x) => {
      const r = asRecord(x);
      return { amount: dec(r.amount), at: strOrNull(r.at), remarks: strOrNull(r.remarks) };
    }),
    createdAt: strOrNull(raw.createdAt),
    settledAt: strOrNull(raw.settledAt),
  };
};

/** The totals /wallet/credit returns beside the rows. */
export interface CreditSummary {
  /** Unsettled DEPOSIT credits — what the user still owes. */
  outstandingReceivable: Decimal;
  /** Unsettled WITHDRAWAL credits — what is due to the user. */
  outstandingPayable: Decimal;
  pendingCount: number;
}

export const toCreditSummary = (body: unknown): CreditSummary => {
  const raw = asRecord(body);
  const n = Number(raw.pendingCount);
  return {
    outstandingReceivable: dec(raw.outstandingReceivable),
    outstandingPayable: dec(raw.outstandingPayable),
    pendingCount: Number.isFinite(n) ? n : 0,
  };
};
