/**
 * The signed-in user, their trading accounts, and the account-adjacent
 * records the profile and account screens read.
 *
 * Three /user/* areas have their own modules: the portfolio dashboard
 * (api/dashboard, types/trading), the bell (types/notifications) and
 * feedback / tickets (types/helpdesk).
 *
 * Every adapter here reads through the tolerant helpers in types/api —
 * `/auth/me`, `/user/accounts` and `/account-plans` are shared with a web
 * client that reads them loosely, and an admin can change several of the
 * underlying documents without a deploy.
 */
import {
  bool,
  id,
  num,
  str,
  strOrNull,
} from '@/types/api';
import type {
  AccountPlan,
  TradingAccount,
  TradingMode,
} from '@/types/trading';

type Raw = Record<string, unknown>;

const asRecord = (v: unknown): Raw =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

/* ══ The signed-in user ═══════════════════════════════════════════════ */

export interface AuthUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  /** First + last, or the email when neither is set. Never empty. */
  name: string;
  /** '' when the server sent none — see isClientRole for why that matters. */
  role: string;
  phone: string | null;
  kycStatus: string | null;
  /** The permanent public id ("USR100245"). */
  userUid: string | null;
  /**
   * Read by Wallet → Account details' "Two-factor" row (Wallet.jsx). EquityHub
   * has no way to turn it on, so it reads false for everyone it created.
   */
  twoFactorEnabled: boolean;
  emailVerified: boolean;
  referralCode: string | null;
  avatarUrl: string | null;
  /** The document as sent, for the handful of fields read in one place. */
  raw: Record<string, unknown>;
}

/**
 * The only role that may hold a session in this app.
 *
 * store/auth.js:9 — the client app is the CUSTOMER portal; staff use the
 * admin portal. Impersonation tokens carry role USER, so "View As User"
 * still passes.
 */
export const CLIENT_ROLE = 'USER';

/**
 * A missing role is NOT a customer. The web gate is `role !== 'USER'`, so an
 * absent role is refused there too; defaulting it to USER here would open
 * the one door the gate exists to keep shut.
 */
export const isClientRole = (user: Pick<AuthUser, 'role'> | null | undefined): boolean =>
  user?.role === CLIENT_ROLE;

export const STAFF_ACCOUNT_MESSAGE =
  'This is a staff account. Please sign in from the admin portal.';

/** `/auth/me`, the `user` of a login/register response, or `PUT /user/profile`. */
export const toAuthUser = (body: unknown): AuthUser | null => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = body as Raw;
  const userId = id(raw);
  const email = str(raw.email);
  if (!userId && !email) return null;

  const firstName = strOrNull(raw.firstName);
  const lastName = strOrNull(raw.lastName);
  const joined = [firstName, lastName].filter(Boolean).join(' ');

  return {
    id: userId,
    email,
    firstName,
    lastName,
    name: joined || strOrNull(raw.name) || email,
    role: str(raw.role),
    // `mobile` is read once on the web as a fallback for older documents.
    phone: strOrNull(raw.phone) ?? strOrNull(raw.mobile),
    kycStatus: strOrNull(raw.kycStatus),
    userUid: strOrNull(raw.userUid),
    twoFactorEnabled: bool(raw.twoFactorEnabled),
    emailVerified: bool(raw.isEmailVerified) || bool(raw.emailVerified),
    referralCode: strOrNull(raw.referralCode),
    avatarUrl: strOrNull(raw.avatarUrl),
    raw,
  };
};

/* ── Fields read in only one or two places, off `raw` ─────────────────── */

export interface ReferredBy {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  referralCode: string | null;
}

/** `/auth/me` populates `referredBy`; any other source leaves it an id. */
export const userReferredBy = (user: AuthUser | null | undefined): ReferredBy | null => {
  const r = user?.raw.referredBy;
  if (!r || typeof r !== 'object') return null;
  const o = r as Raw;
  return {
    firstName: strOrNull(o.firstName),
    lastName: strOrNull(o.lastName),
    email: strOrNull(o.email),
    referralCode: strOrNull(o.referralCode),
  };
};

export const userKycRejectionReason = (user: AuthUser | null | undefined): string | null =>
  strOrNull(user?.raw.kycRejectionReason);

export const userCountry = (user: AuthUser | null | undefined): string | null =>
  strOrNull(user?.raw.country);

export const userCreatedAt = (user: AuthUser | null | undefined): string | null =>
  strOrNull(user?.raw.createdAt);

/* ══ Sessions ═════════════════════════════════════════════════════════ */

export interface LoginResult {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

/**
 * One signed-in session, from GET /auth/devices.
 *
 * authController.listDevices gives every session a stable id (its `sid`,
 * back-filled onto legacy rows as the list is read), stamps `lastSeenAt` on
 * every refresh, and marks the session the request came from `current` —
 * the list comes back with that one first.
 */
export interface SessionDevice {
  /** The session id DELETE /auth/devices/:id takes. Null only if a server sent none. */
  id: string | null;
  deviceInfo: string;
  createdAt: string | null;
  /** The last refresh; the server falls back to `createdAt` itself. */
  lastSeenAt: string | null;
  /** The session this app is signed in with — shown as "This device", never revoked from here. */
  current: boolean;
}

export const toSessionDevice = (body: unknown): SessionDevice => {
  const raw = asRecord(body);
  return {
    id: strOrNull(raw.id) ?? strOrNull(raw.sid) ?? strOrNull(raw._id),
    deviceInfo: str(raw.deviceInfo) || 'Unknown device',
    createdAt: strOrNull(raw.createdAt),
    lastSeenAt: strOrNull(raw.lastSeenAt),
    current: raw.current === true,
  };
};

/* ══ KYC ══════════════════════════════════════════════════════════════ */

export type KycStatus = 'NOT_SUBMITTED' | 'PENDING' | 'APPROVED' | 'REJECTED' | (string & {});

/**
 * The document types this app uploads — the server's KYC_DOC_TYPES
 * (config/constants.js) minus OTHER, which no page offers. PAN_CARD is
 * the mandatory Step 1; the other four are Step 2's picker.
 */
export type KycDocType = 'PAN_CARD' | 'ID_FRONT' | 'ID_BACK' | 'SELFIE' | 'ADDRESS_PROOF';

/** The Step 1 document — Profile.jsx PanCardStep. */
export const PAN_CARD: KycDocType = 'PAN_CARD';

/** Profile.jsx "Document type" select (Step 2), in the order it offers them. */
export const KYC_DOC_TYPES: ReadonlyArray<{ value: Exclude<KycDocType, 'PAN_CARD'>; label: string }> = [
  { value: 'ID_FRONT', label: 'ID Card / Passport — Front' },
  { value: 'ID_BACK', label: 'ID Card — Back' },
  { value: 'SELFIE', label: 'Selfie with ID' },
  { value: 'ADDRESS_PROOF', label: 'Address proof (utility bill, bank statement)' },
];

/** Profile.jsx DOC_LABELS — how a document on file is named in the list. */
export const KYC_DOC_LABELS: Readonly<Record<string, string>> = {
  PAN_CARD: 'PAN Card',
  ID_FRONT: 'ID — Front',
  ID_BACK: 'ID — Back',
  SELFIE: 'Selfie with ID',
  ADDRESS_PROOF: 'Address proof',
  OTHER: 'Other document',
};

/** Profile.jsx docLabel — a type with no label reads with every underscore spaced. */
export const kycDocLabel = (docType: string | null | undefined): string =>
  KYC_DOC_LABELS[String(docType ?? '')] ?? String(docType || '').replace(/_/g, ' ');

/**
 * GET /user/kyc/status (userController.getKycStatus). `canUpload` is false
 * for a verified account unless an admin re-opened upload for it — the
 * upload endpoint enforces the same rule (KYC_ALREADY_VERIFIED).
 */
export interface KycStatusInfo {
  status: KycStatus;
  rejectionReason: string | null;
  uploadUnlocked: boolean;
  canUpload: boolean;
}

export const toKycStatusInfo = (body: unknown): KycStatusInfo => {
  const raw = asRecord(body);
  return {
    status: str(raw.status) || 'NOT_SUBMITTED',
    rejectionReason: strOrNull(raw.rejectionReason),
    uploadUnlocked: raw.uploadUnlocked === true,
    // Profile.jsx: `canUpload !== false` — only an explicit refusal hides the form.
    canUpload: raw.canUpload !== false,
  };
};

/** complianceController ALLOWED_MIME. The server also checks the bytes. */
export const KYC_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export const KYC_MAX_BYTES = 10 * 1024 * 1024;

export interface KycDocument {
  id: string;
  docType: string;
  originalFilename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | (string & {});
  rejectionReason: string | null;
  createdAt: string | null;
}

export const toKycDocument = (body: unknown): KycDocument => {
  const raw = asRecord(body);
  return {
    id: id(raw),
    docType: str(raw.docType),
    originalFilename: str(raw.originalFilename) || str(raw.filename),
    mimeType: strOrNull(raw.mimeType),
    sizeBytes: num(raw.sizeBytes),
    status: str(raw.status) || 'PENDING',
    rejectionReason: strOrNull(raw.rejectionReason) ?? strOrNull(raw.reviewNote),
    createdAt: strOrNull(raw.createdAt),
  };
};

/**
 * The account-level status the KYC tab shows. Profile.jsx:392-396.
 *
 * Documents on file under a NOT_SUBMITTED account are under review — legacy
 * accounts uploaded under the old "needs 2 docs" rule and never flipped —
 * so that reads as PENDING. A rejected document does not count as on file.
 */
export const effectiveKycStatus = (
  rawStatus: string | null | undefined,
  docs: ReadonlyArray<Pick<KycDocument, 'status'>>,
): KycStatus => {
  const s = rawStatus || 'NOT_SUBMITTED';
  const hasReviewableDocs = docs.some((d) => d.status !== 'REJECTED');
  return s === 'NOT_SUBMITTED' && hasReviewableDocs ? 'PENDING' : s;
};

/**
 * The status one document shows — Profile.jsx effectiveDocStatus.
 *
 * A document's OWN verdict wins: APPROVED or REJECTED by the reviewer stays
 * what the reviewer decided, whatever the account says. Anything else (a
 * legacy row whose per-document status was never written) takes an
 * APPROVED or REJECTED account's verdict, and otherwise keeps its own.
 */
export const kycDocDisplayStatus = (
  doc: Pick<KycDocument, 'status'>,
  rawAccountStatus: string | null | undefined,
): string => {
  if (doc.status === 'APPROVED' || doc.status === 'REJECTED') return doc.status;
  if (rawAccountStatus === 'APPROVED') return 'APPROVED';
  if (rawAccountStatus === 'REJECTED') return 'REJECTED';
  return doc.status;
};

/* ══ Trading accounts ═════════════════════════════════════════════════ */

export type AccountStatus = 'ACTIVE' | 'BLOCKED' | 'SUSPENDED' | 'STOPPED_OUT' | (string & {});

/**
 * A row of GET /user/accounts. A TradingAccount plus what the account list
 * and the wallet read that the shared type leaves out.
 */
export interface UserAccount extends TradingAccount {
  /** Admin status. BLOCKED/SUSPENDED/STOPPED_OUT refuse new orders. */
  status: AccountStatus;
  createdAt: string | null;
  raw: Record<string, unknown>;
}

const MODES: ReadonlySet<string> = new Set(['INTERNAL', 'EXTERNAL', 'HYBRID']);

export const toUserAccount = (body: unknown): UserAccount => {
  const raw = asRecord(body);
  const mode = str(raw.mode);
  return {
    id: id(raw),
    accountNumber: str(raw.accountNumber),
    accountType: str(raw.accountType) || 'STANDARD',
    customTypeName: strOrNull(raw.customTypeName),
    // EquityHub is INR-only: every account is opened in its BASE_CURRENCY
    // (config/constants.js, 'INR'), so INR is the truthful default.
    baseCurrency: str(raw.baseCurrency) || 'INR',
    // The model's own default. 999999 is how the server spells "unlimited".
    leverage: num(raw.leverage) ?? 100,
    mode: MODES.has(mode) ? (mode as TradingMode) : undefined,
    isActive: raw.isActive !== false,
    isTradingEnabled: raw.isTradingEnabled !== false,
    nickname: strOrNull(raw.nickname),
    group: strOrNull(raw.group),
    planSuspendedAt: strOrNull(raw.planSuspendedAt),
    planSuspendedReason: strOrNull(raw.planSuspendedReason),
    stoppedOutAt: strOrNull(raw.stoppedOutAt),
    status: str(raw.status) || 'ACTIVE',
    createdAt: strOrNull(raw.createdAt),
    raw,
  };
};

/** For code holding a TradingAccount that may be the richer row. */
export const isUserAccount = (a: TradingAccount | null | undefined): a is UserAccount =>
  !!a && 'raw' in a && 'status' in a;

/** What POST /user/accounts accepts. */
export interface CreateAccountInput {
  /** An AccountPlan code, or DEMO for a practice account. */
  accountType: string;
  leverage?: number;
  nickname?: string;
  mode?: TradingMode;
  /** Practice accounts only — the server 400s it on a live tier. */
  initialBalance?: number;
}

export interface MinDepositHint {
  minDeposit: number;
  currency: string;
  needsFunding: boolean;
}

export interface CreatedAccount extends UserAccount {
  /** Set when the tier has a minimum the account does not yet meet. */
  minDepositHint: MinDepositHint | null;
}

/* ── Account plans (tiers) ────────────────────────────────────────────── */

/**
 * An AccountPlan with the fields the tier picker reads beyond the shared
 * type: branding, and the fee model the configure step describes.
 */
export interface AccountPlanDetail extends AccountPlan {
  id: string;
  accentColor: string | null;
  icon: string | null;
  feeKind: 'PCT_OF_VALUE' | 'FIXED_PER_TRADE' | 'PCT_OF_PROFIT' | (string & {});
  /** A raw decimal: 0.00005 is 0.005%, not 0.00005%. */
  feeValue: number;
  lossWaive: boolean;
  /** The IC variants: BUY-only entries. */
  buyCloseOnly: boolean;
  isActive: boolean;
}

export const toAccountPlan = (body: unknown): AccountPlanDetail => {
  const raw = asRecord(body);
  return {
    id: id(raw),
    code: str(raw.code).toUpperCase(),
    name: str(raw.name) || str(raw.code),
    description: strOrNull(raw.description),
    feeDisplay: strOrNull(raw.feeDisplay),
    supportLabel: strOrNull(raw.supportLabel),
    instrumentsLabel: strOrNull(raw.instrumentsLabel),
    accessLabel: strOrNull(raw.accessLabel),
    badge: strOrNull(raw.badge),
    minDeposit: num(raw.minDeposit),
    // null is UNLIMITED — the model says so explicitly. num() keeps an
    // absent cap absent instead of turning it into a cap of zero.
    maxLeverage: num(raw.maxLeverage),
    isPopular: bool(raw.isPopular),
    isRecommended: bool(raw.isRecommended),
    sortOrder: num(raw.sortOrder) ?? 0,
    accentColor: strOrNull(raw.accentColor),
    icon: strOrNull(raw.icon),
    feeKind: str(raw.feeKind) || 'PCT_OF_VALUE',
    feeValue: num(raw.feeValue) ?? 0,
    lossWaive: bool(raw.lossWaive),
    buyCloseOnly: bool(raw.buyCloseOnly),
    isActive: raw.isActive !== false,
  };
};

/**
 * Plans keyed by UPPERCASE code — the shape utils/accountType's planFor
 * reads, and the one Wallet.jsx:894-899 builds for the min-deposit gate.
 */
export const indexPlansByCode = <P extends AccountPlan>(plans: ReadonlyArray<P>): Record<string, P> => {
  const out: Record<string, P> = {};
  for (const p of plans) if (p.code) out[p.code.toUpperCase()] = p;
  return out;
};

/* ══ Leverage ═════════════════════════════════════════════════════════ */

/** GET /user/leverage — the effective cap and where it comes from. */
export interface LeverageState {
  effectiveLeverage: number;
  customLeverage: number | null;
  planDefault: number;
  planCode: string;
  planName: string;
  /** 'admin', 'DEMO', or a plan code. */
  source: string;
  /** Ready to show: "Admin Override", "VIP Plan", "Demo account · unlimited". */
  sourceLabel: string;
  isOverridden: boolean;
  systemMin: number | null;
  systemMax: number | null;
  isDemo: boolean;
}

export const toLeverageState = (body: unknown): LeverageState => {
  const raw = asRecord(body);
  return {
    effectiveLeverage: num(raw.effectiveLeverage) ?? num(raw.planDefault) ?? 100,
    customLeverage: num(raw.customLeverage),
    planDefault: num(raw.planDefault) ?? 100,
    planCode: str(raw.planCode) || 'FREE',
    planName: str(raw.planName) || 'Free',
    source: str(raw.source),
    sourceLabel: str(raw.sourceLabel),
    isOverridden: bool(raw.isOverridden),
    systemMin: num(raw.systemMin),
    systemMax: num(raw.systemMax),
    isDemo: bool(raw.isDemo),
  };
};

