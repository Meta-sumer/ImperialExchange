/**
 * Profile page logic — client/src/pages/Profile.jsx, as pure functions.
 *
 * Everything that decides a label, a colour, a validation message or what
 * gets sent lives here, so it can be pinned against the web's own source
 * (stage2_profile.logic.test.ts lifts the web's code and runs both).
 *
 * No React, no native modules.
 */
import { COUNTRY_OPTIONS } from '@/screens/auth/logic/countries';
import { passwordRulesPass } from '@/screens/auth/logic/password';
import type { ProfileTab } from '@/navigation/types';
import { str } from '@/types/api';
import {
  KYC_ALLOWED_MIME,
  KYC_MAX_BYTES,
  PAN_CARD,
  kycDocDisplayStatus,
  toAuthUser,
  type AuthUser,
  type KycDocument,
  type ReferredBy,
  type SessionDevice,
} from '@/types/user';

/* ══ Tabs ══════════════════════════════════════════════════════════════ */

/** Profile.jsx VALID_TABS, in the order the rail shows them. */
export const PROFILE_TABS = ['profile', 'kyc', 'security', 'devices'] as const satisfies readonly ProfileTab[];

/** Profile.jsx. */
export const PROFILE_TAB_ITEMS: ReadonlyArray<{ key: ProfileTab; label: string }> = [
  { key: 'profile', label: 'Profile' },
  { key: 'kyc', label: 'KYC Verification' },
  { key: 'security', label: 'Security' },
  { key: 'devices', label: 'Active Sessions' },
];

export const isProfileTab = (v: unknown): v is ProfileTab =>
  typeof v === 'string' && (PROFILE_TABS as readonly string[]).includes(v);

/** Profile.jsx — an unknown `?tab=` lands on Profile. */
export const initialProfileTab = (param: unknown): ProfileTab => (isProfileTab(param) ? param : 'profile');

/**
 * The route param for a tab — Profile.jsx drops `?tab` for the
 * default tab and sets it otherwise, so a shared link reopens the same tab.
 */
export const tabParam = (tab: ProfileTab): ProfileTab | undefined => (tab === 'profile' ? undefined : tab);

/* ══ Hero ══════════════════════════════════════════════════════════════ */

type NameFields = Pick<AuthUser, 'firstName' | 'lastName' | 'email'>;

/** Profile.jsx. */
export const profileInitials = (user: NameFields | null | undefined): string => {
  const f = (user?.firstName || '').trim();
  const l = (user?.lastName || '').trim();
  if (f || l) return `${f[0] || ''}${l[0] || ''}`.toUpperCase();
  return ((user?.email || '?')[0] ?? '?').toUpperCase();
};

/** Profile.jsx. */
export const heroName = (user: NameFields | null | undefined): string =>
  (user?.firstName || user?.lastName
    ? `${user?.firstName || ''} ${user?.lastName || ''}`.trim()
    : 'Welcome back');

/**
 * Profile.jsx — month and year in the device locale. An unparseable
 * date reads "—" rather than the web's "Invalid Date".
 */
export const memberSince = (createdAt: string | null | undefined): string => {
  if (!createdAt) return '—';
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
};

/**
 * Profile.jsx — a friendly country name from the stored ISO-2 code.
 *
 * The web asks `Intl.DisplayNames`, which Hermes does not implement; when it
 * is missing (or refuses the code) this falls back to the registration
 * list's own name for the code, then to the raw value — the web's last
 * resort.
 */
export const countryName = (code: string | null | undefined): string => {
  if (!code) return '—';
  const upper = String(code).toUpperCase();
  try {
    const DisplayNames = (Intl as unknown as {
      DisplayNames?: new (l: string[], o: { type: 'region' }) => { of(c: string): string | undefined };
    }).DisplayNames;
    if (DisplayNames) {
      const name = new DisplayNames(['en'], { type: 'region' }).of(upper);
      if (name) return name;
    }
  } catch {
    // RangeError for a value that is not a region code (already a full name).
  }
  return COUNTRY_OPTIONS.find((c) => c.code === upper)?.name ?? String(code);
};

/* ══ Profile tab ═══════════════════════════════════════════════════════ */

/** What PUT /user/profile receives from this page — Profile.jsx, sent whole. */
export interface ProfileForm {
  firstName: string;
  lastName: string;
  phone: string;
}

/**
 * The form's starting values. Read off the document as sent (`raw`), as the
 * web does with `user?.firstName || ''` — AuthUser's own `phone` also falls
 * back to a legacy `mobile` field, which the web's form never shows.
 */
export const profileFormFrom = (user: Pick<AuthUser, 'raw'> | null | undefined): ProfileForm => ({
  firstName: str(user?.raw.firstName),
  lastName: str(user?.raw.lastName),
  phone: str(user?.raw.phone),
});

export const sameProfileForm = (a: ProfileForm, b: ProfileForm): boolean =>
  a.firstName === b.firstName && a.lastName === b.lastName && a.phone === b.phone;

/** Profile.jsx. */
export const profileDirty = (form: ProfileForm, user: Pick<AuthUser, 'raw'> | null | undefined): boolean =>
  !sameProfileForm(form, profileFormFrom(user));

/**
 * What the form holds after the saved profile changes underneath it.
 *
 * The web seeds the form once, at mount, and a page load is how it picks up
 * a profile changed elsewhere (by an admin, on another device). Here the
 * screen lives on: pull to refresh and the mount-time /auth/me re-read
 * stand in for that page load. A field the user has not touched follows
 * the saved value; one they have edited keeps the edit. Without this, a
 * refreshed profile left the old values in the form, the page said
 * "Unsaved changes", and Save would have written the stale values back.
 * Returns `form` itself when nothing moves, so a no-op does not re-render.
 */
export const followSavedProfile = (form: ProfileForm, prevSaved: ProfileForm, nextSaved: ProfileForm): ProfileForm => {
  const pick = (k: keyof ProfileForm): string => (form[k] === prevSaved[k] ? nextSaved[k] : form[k]);
  const out: ProfileForm = { firstName: pick('firstName'), lastName: pick('lastName'), phone: pick('phone') };
  return sameProfileForm(out, form) ? form : out;
};

/**
 * The personal-information fields the server now holds after a successful
 * PUT /user/profile: read off its answer (the saved document), or — when the
 * answer carries no document — the form that was sent, which
 * userController.updateProfile stores verbatim.
 */
export const savedProfileFields = (
  answer: Pick<AuthUser, 'raw'> | null | undefined,
  sent: ProfileForm,
): ProfileForm => {
  const raw = (answer as { raw?: unknown } | null | undefined)?.raw;
  return raw && typeof raw === 'object' ? profileFormFrom(answer) : sent;
};

/**
 * The signed-in user with fields the server has just CONFIRMED written laid
 * over the document held — everything else, the populated `referredBy`
 * above all, is kept. Rebuilt through toAuthUser so the derived fields
 * (`name`, `emailVerified`, …) agree with `raw`.
 *
 * Why: after a change the page re-reads /auth/me, and that re-read is
 * silent on failure (store/auth refreshUser, as the web's). Without this, a
 * re-read lost to a dropped connection left the page on the OLD state after
 * the server had answered: a saved profile read "Unsaved changes" (and Save
 * would have written it again), an address already verified still offered
 * "Resend verification".
 */
export const withSavedFields = (user: AuthUser, fields: Readonly<Record<string, unknown>>): AuthUser =>
  toAuthUser({ ...user.raw, ...fields }) ?? user;

/** Profile.jsx — the resend button's cooldown, in seconds. */
export const RESEND_COOLDOWN_S = 30;

export const resendLabel = (cooldown: number): string =>
  (cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend verification');

/**
 * The referrer the Referral card shows — Profile.jsx tests
 * `user?.referredBy` for truthiness alone.
 *
 * Only /auth/me populates `referredBy`; a login or register response
 * carries the bare referrer id. The web then still takes the "referred"
 * branch and, with no name or email to read, says "Anonymous referrer".
 * userReferredBy (types/user) reads only a populated object, which would
 * turn the same user into "Signed up directly" — untrue. An unpopulated
 * reference reads as the web reads it.
 */
export const profileReferrer = (user: Pick<AuthUser, 'raw'> | null | undefined): ReferredBy | null => {
  const r = user?.raw.referredBy;
  if (!r) return null;
  const o = (typeof r === 'object' ? r : {}) as Record<string, unknown>;
  const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return { firstName: s(o.firstName), lastName: s(o.lastName), email: s(o.email), referralCode: s(o.referralCode) };
};

/** Profile.jsx. */
export const referredByName = (r: ReferredBy): string =>
  (r.firstName || r.lastName
    ? `${r.firstName || ''} ${r.lastName || ''}`.trim()
    : (r.email || 'Anonymous referrer'));

/* ══ KYC ═══════════════════════════════════════════════════════════════ */

export type StatusTone = 'bull' | 'warn' | 'bear' | 'muted';

type KnownKyc = 'APPROVED' | 'PENDING' | 'REJECTED' | 'NOT_SUBMITTED';

/** Profile.jsx statusMeta — the KYC tab's banner. */
export const KYC_STATUS_META: Readonly<Record<KnownKyc, { tone: StatusTone; desc: string }>> = {
  APPROVED: { tone: 'bull', desc: 'Your identity is verified. You have full trading access.' },
  PENDING: { tone: 'warn', desc: 'We are reviewing your documents. This usually takes 1-2 business days.' },
  REJECTED: { tone: 'bear', desc: 'Your submission was rejected. Please re-upload corrected documents.' },
  NOT_SUBMITTED: { tone: 'muted', desc: 'Verify your identity to unlock Live trading and withdrawals.' },
};

/**
 * The banner for a status. The server's enum has exactly the four above
 * (config/constants.js KYC_STATUS); anything else would crash the web page,
 * so it reads as not submitted here.
 */
export const kycStatusMeta = (status: string): { tone: StatusTone; desc: string } =>
  KYC_STATUS_META[status as KnownKyc] ?? KYC_STATUS_META.NOT_SUBMITTED;

/** Profile.jsx — the hero chip, keyed on the account's RAW status. */
export const KYC_PILL: Readonly<Record<KnownKyc, { tone: StatusTone; label: string }>> = {
  APPROVED: { tone: 'bull', label: 'KYC verified' },
  PENDING: { tone: 'warn', label: 'KYC pending' },
  REJECTED: { tone: 'bear', label: 'KYC rejected' },
  NOT_SUBMITTED: { tone: 'muted', label: 'KYC not started' },
};

export const kycPill = (status: string | null | undefined): { tone: StatusTone; label: string } =>
  KYC_PILL[(status || 'NOT_SUBMITTED') as KnownKyc] ?? KYC_PILL.NOT_SUBMITTED;

/**
 * `status.replace('_', ' ')` — the banner's status chip. A string pattern
 * replaces the FIRST underscore only, and that is kept: 'NOT_SUBMITTED' →
 * 'NOT SUBMITTED'. (Documents are named by kycDocLabel, types/user.)
 */
export const underscoreToSpace = (s: string): string => s.replace('_', ' ');

/** Profile.jsx — the document row's chip colour. */
export const docStatusTone = (ds: string): StatusTone =>
  (ds === 'APPROVED' ? 'bull' : ds === 'REJECTED' ? 'bear' : 'warn');

/** Profile.jsx "Uploaded documents" subtitle. */
export const docsSubtitle = (n: number): string => `${n} document${n === 1 ? '' : 's'} on file`;

/** complianceController's limit, and the web's check before reading (KYC_MAX_BYTES). */
export const KYC_TOO_LARGE = 'File too large (max 10MB)';
/** The app's own early type check — see complianceApi kycUploadError. */
export const KYC_WRONG_TYPE = 'Upload a JPG, PNG, WEBP or PDF';

/** Profile.jsx upload — the success toast names the PAN card. */
export const kycUploadedToast = (docType: string): string =>
  (docType === PAN_CARD ? 'PAN card uploaded' : 'Document uploaded');

/* ── Step 1: the PAN card (Profile.jsx PanCardStep) ─────────────────── */

export interface PanGate {
  /** The newest PAN card on file — the server lists newest first — or null. */
  panDoc: KycDocument | null;
  /** Its status as the list shows it (kycDocDisplayStatus), or null without one. */
  panStatus: string | null;
  /** A PAN card on file that has not been rejected. */
  panOnFile: boolean;
  /**
   * Step 2 (the other documents) waits on the PAN card — but only once the
   * list has actually loaded, so a read that failed never locks anyone out.
   */
  otherUploadsLocked: boolean;
}

/** Profile.jsx KycTab: panDoc / panStatus / panOnFile / otherUploadsLocked. */
export const panGate = (
  docs: ReadonlyArray<KycDocument>,
  rawStatus: string | null | undefined,
  docsLoaded: boolean,
): PanGate => {
  const panDoc = docs.find((d) => d.docType === PAN_CARD) ?? null;
  const panStatus = panDoc ? kycDocDisplayStatus(panDoc, rawStatus || 'NOT_SUBMITTED') : null;
  const panOnFile = !!panDoc && panStatus !== 'REJECTED';
  return { panDoc, panStatus, panOnFile, otherUploadsLocked: docsLoaded && !panOnFile };
};

/**
 * PanCardStep showForm — the upload zone shows when nothing usable is on
 * file: no PAN card yet, the last one rejected, or the user chose to replace
 * one still pending ("Upload a different one"). Never over an approved one.
 */
export const panFormShown = (hasPanDoc: boolean, panStatus: string | null, replacing: boolean): boolean =>
  !hasPanDoc || panStatus === 'REJECTED' || (replacing && panStatus !== 'APPROVED');

/** PanCardStep's badge: the PAN card's status, or "Required" with none on file. */
export const panBadge = (panStatus: string | null): { label: string; tone: StatusTone | 'primary' } => {
  if (!panStatus) return { label: 'Required', tone: 'primary' };
  if (panStatus === 'APPROVED') return { label: panStatus, tone: 'bull' };
  if (panStatus === 'REJECTED') return { label: panStatus, tone: 'bear' };
  return { label: panStatus, tone: 'warn' };
};

/** PanCardStep — the line under the PAN card on file; nothing for any other status. */
export const PAN_STATUS_LINE: Readonly<Record<string, string>> = {
  APPROVED: 'Your PAN card is verified.',
  PENDING: 'We are reviewing your PAN card.',
  REJECTED: 'Your PAN card was rejected. Please upload it again below.',
};

export const panStatusLine = (panStatus: string | null): string =>
  (panStatus ? PAN_STATUS_LINE[panStatus] ?? '' : '');

/** Step 2's notice while it waits on the PAN card. */
export const KYC_PAN_FIRST =
  'Add your PAN card above first — it is required before other documents can be submitted.';

/**
 * Why a picked file would be refused, before any bytes are read: size
 * first (Profile.jsx's KYC_MAX_BYTES check and words), then type (the
 * app's own, kycUploadError). `size` is null when the picker could not
 * say; the decoded bytes are measured again before sending.
 */
export const kycFileError = (file: { size: number | null | undefined; mimeType: string }): string | null => {
  if (file.size != null && file.size > KYC_MAX_BYTES) return KYC_TOO_LARGE;
  if (!(KYC_ALLOWED_MIME as readonly string[]).includes(file.mimeType)) return KYC_WRONG_TYPE;
  return null;
};

const EXT_MIME: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

const extOf = (name: string): string => {
  const clean = name.split(/[?#]/)[0] ?? '';
  const dot = clean.lastIndexOf('.');
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : '';
};

/**
 * The file's type as the server will be told it. A browser fills
 * `file.type` itself; a phone picker sometimes leaves it out, or says
 * `image/jpg`, which complianceController refuses — so a missing type is
 * read from the extension and `image/jpg` is spelled the way the server
 * lists it. Anything else passes through, for kycFileError to judge.
 */
export const kycMimeType = (reported: string | null | undefined, name: string): string => {
  const r = (reported || '').trim().toLowerCase();
  if (r === 'image/jpg' || r === 'image/pjpeg') return 'image/jpeg';
  if (r) return r;
  return EXT_MIME[extOf(name)] ?? '';
};

const MIME_EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/**
 * `file.name` for the upload. A camera shot has no name on iOS; the server
 * requires one (it is stored as `originalFilename` and shown in the list),
 * so a photo is named after the document type and the moment it was taken.
 */
export const kycFileName = (
  pickedName: string | null | undefined,
  uri: string,
  docType: string,
  mimeType: string,
  now: number = Date.now(),
): string => {
  const given = (pickedName || '').trim();
  if (given) return given;
  const segment = (uri.split(/[?#]/)[0] ?? '').split('/').pop() ?? '';
  let last = segment;
  try { last = decodeURIComponent(segment); } catch { /* a malformed escape: keep it as is */ }
  last = last.trim();
  if (last && last.includes('.')) return last;
  return `${docType}_${now}.${MIME_EXT[mimeType] ?? 'jpg'}`;
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** The first `n` bytes a base64 string decodes to (fewer when it is shorter). */
export const base64Head = (b64: string, n: number): number[] => {
  const s = b64.replace(/^data:[^;,]+;base64,/, '').replace(/\s/g, '');
  const out: number[] = [];
  for (let i = 0; i < s.length && out.length < n; i += 4) {
    const [a = -1, b = -1, c = -1, d = -1] = [0, 1, 2, 3].map((k) => B64.indexOf(s.charAt(i + k)));
    if (a < 0 || b < 0) break;
    out.push(((a << 2) | (b >> 4)) & 0xff);
    if (c < 0) break;
    out.push((((b & 15) << 4) | (c >> 2)) & 0xff);
    if (d < 0) break;
    out.push((((c & 3) << 6) | d) & 0xff);
  }
  return out.slice(0, n);
};

/**
 * Which accepted format the bytes really are, by the signatures
 * complianceController's `sniffMime` reads, or null.
 *
 * Needed for the photo pickers: they re-encode what they hand back, and
 * Android's reports the SOURCE's type, not the file it wrote. A HEIC or
 * WEBP gallery photo comes back as JPEG bytes (expo-image-picker's
 * CompressionImageExporter writes JPEG for everything but PNG) while
 * `mimeType` still says image/heic or image/webp — declaring image/heic is
 * refused outright ("Unsupported mime type"), and the record would be
 * named for a format it is not.
 */
export const sniffKycMime = (b64: string): string | null => {
  const b = base64Head(b64, 12);
  const at = (sig: number[], off = 0): boolean => sig.every((v, i) => b[off + i] === v);
  if (at([0xFF, 0xD8, 0xFF])) return 'image/jpeg';
  if (at([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png';
  if (at([0x52, 0x49, 0x46, 0x46]) && at([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (at([0x25, 0x50, 0x44, 0x46, 0x2D])) return 'application/pdf';
  return null;
};

/**
 * A photo's name with the extension of what it now is — "IMG_1.heic"
 * re-encoded to JPEG becomes "IMG_1.jpg", so the name on file (the admin's
 * review list) matches the bytes. A name already right is kept.
 */
export const kycNameForMime = (name: string, mimeType: string): string => {
  const ext = MIME_EXT[mimeType];
  if (!ext || EXT_MIME[extOf(name)] === mimeType) return name;
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.${ext}`;
};

/**
 * A timeout for the upload request, sized to the body. The app's default is
 * 20 s; the web's axios has none, and a 10 MB document is ~13.4 MB of base64
 * — on a phone's upstream that can take minutes. 20 s plus a second per
 * 64 KB (≈ 0.5 Mbit/s), capped at five minutes.
 */
export const kycUploadTimeoutMs = (base64Length: number): number =>
  Math.min(300_000, 20_000 + Math.ceil(Math.max(0, base64Length) / 65_536) * 1_000);

/* ══ Security ══════════════════════════════════════════════════════════ */

/**
 * Profile.jsx ChangePasswordCard — the submit's checks, in order. The
 * button is disabled until all pass, so these are reached from the
 * keyboard's submit key, as the web's are from Enter.
 *
 * Change password is the whole Security tab: EquityHub has no two-factor
 * sign-in (no /auth/2fa routes on its server).
 */
export const changePasswordError = (cur: string, pwd: string, confirm: string): string | null => {
  if (!cur) return 'Enter your current password';
  if (!passwordRulesPass(pwd)) return 'New password does not meet all requirements';
  if (!(pwd && pwd === confirm)) return 'Passwords do not match';
  return null;
};

/** Profile.jsx — the inline error under the confirm field. */
export const confirmMismatch = (pwd: string, confirm: string): boolean =>
  !!confirm && !(pwd && pwd === confirm);

/* ══ Sessions ══════════════════════════════════════════════════════════ */

/** Profile.jsx DevicesTab subtitle. */
export const sessionsSubtitle = (loading: boolean, n: number): string =>
  (loading ? 'Loading…' : `${n} active session${n === 1 ? '' : 's'}`);

/** Profile.jsx DevicesTab revoke confirm. */
export const REVOKE_CONFIRM = 'Revoke this session? You will be logged out from that device.';

/**
 * authController.revokeDevice's wording for a session it cannot find — also
 * what the app says for a row that came without an id, which the web would
 * send as "undefined" and be told the same.
 */
export const SESSION_NOT_FOUND = 'Session not found';

/**
 * Profile.jsx DevicesTab — "Last active <date time> · Signed in <date>".
 * The last activity is the session's last refresh, else its start.
 */
export const deviceActivity = (d: Pick<SessionDevice, 'lastSeenAt' | 'createdAt'>): string =>
  `Last active ${dateTime(d.lastSeenAt || d.createdAt)} · Signed in ${shortDate(d.createdAt)}`;

/* ══ Dates ═════════════════════════════════════════════════════════════ */

/** `new Date(x).toLocaleDateString()` — Profile.jsx. */
export const shortDate = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
};

/** `new Date(x).toLocaleString()` — Profile.jsx. */
export const dateTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
};
