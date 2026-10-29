/**
 * Profile → parity with EquityHub's OWN SOURCE.
 *
 * Each block lifts the slice of client/src/pages/Profile.jsx that decides a
 * label, a colour or a gate, runs it with `new Function`, and runs the
 * app's version (src/utils/profile.ts, src/types/user.ts) on the same
 * inputs. If either side changes, this fails. Where the app deliberately
 * differs, the test says so and pins the difference.
 */
import fs from 'fs';
import path from 'path';

import { PASSWORD_RULES, passwordRulesPass } from '@/screens/auth/logic/password';
import {
  KYC_ALLOWED_MIME,
  KYC_DOC_LABELS,
  KYC_DOC_TYPES,
  KYC_MAX_BYTES,
  PAN_CARD,
  effectiveKycStatus,
  kycDocDisplayStatus,
  kycDocLabel,
  toAuthUser,
  toKycDocument,
  toKycStatusInfo,
  toSessionDevice,
  type KycDocument,
} from '@/types/user';
import {
  KYC_PAN_FIRST,
  KYC_PILL,
  KYC_STATUS_META,
  KYC_TOO_LARGE,
  KYC_WRONG_TYPE,
  PAN_STATUS_LINE,
  PROFILE_TABS,
  PROFILE_TAB_ITEMS,
  RESEND_COOLDOWN_S,
  REVOKE_CONFIRM,
  SESSION_NOT_FOUND,
  base64Head,
  changePasswordError,
  confirmMismatch,
  countryName,
  dateTime,
  deviceActivity,
  docStatusTone,
  docsSubtitle,
  followSavedProfile,
  heroName,
  initialProfileTab,
  isProfileTab,
  kycFileError,
  kycFileName,
  kycMimeType,
  kycNameForMime,
  kycPill,
  kycStatusMeta,
  kycUploadTimeoutMs,
  kycUploadedToast,
  memberSince,
  panBadge,
  panFormShown,
  panGate,
  panStatusLine,
  profileDirty,
  profileFormFrom,
  profileInitials,
  profileReferrer,
  referredByName,
  resendLabel,
  savedProfileFields,
  sessionsSubtitle,
  shortDate,
  sniffKycMime,
  tabParam,
  underscoreToSpace,
  withSavedFields,
} from '@/utils/profile';

const ROOT = path.join(__dirname, '../../..');
/** LF only, so a CRLF checkout slices the same as this one. */
const readLf = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const web = (p: string): string => readLf(path.join(ROOT, 'client/src', p));
const backend = (p: string): string => readLf(path.join(ROOT, 'backend/src', p));
const app = (p: string): string => readLf(path.join(__dirname, '..', p));

/** The text from `start` up to (not including) `end`, or a loud failure. */
const between = (src: string, start: string, end: string, from = 0): string => {
  const a = src.indexOf(start, from);
  if (a < 0) throw new Error(`slice start moved: ${start}`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`slice end moved: ${end}`);
  return src.slice(a, b);
};

/** The text strictly between `start` and `end`. */
const inner = (src: string, start: string, end: string, from = 0): string =>
  between(src, start, end, from).slice(start.length);

// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const lift = <T,>(params: string[], body: string): ((...args: unknown[]) => T) =>
  new Function(...params, body) as (...args: unknown[]) => T;

const PROFILE = web('pages/Profile.jsx');
const COMPLIANCE = backend('controllers/complianceController.js');
const AUTH = backend('controllers/authController.js');

const user = (raw: Record<string, unknown>) => {
  const u = toAuthUser({ _id: 'u1', email: 'ada@example.com', role: 'USER', ...raw });
  if (!u) throw new Error('fixture');
  return u;
};

const doc = (raw: Record<string, unknown>): KycDocument =>
  toKycDocument({ _id: 'd', originalFilename: 'f.jpg', createdAt: '2026-01-01T00:00:00Z', ...raw });

/** The web's `effectiveDocStatus`, lifted. */
const webDocStatus = lift<string>(['d', 'accountStatus'], `return (${inner(PROFILE, 'const effectiveDocStatus = (d, accountStatus) => (', '\n);\n')});`);

/* ══ Tabs ══════════════════════════════════════════════════════════════ */

describe('tabs', () => {
  it('offers the web VALID_TABS, in the web order, with the web labels — KYC always on', () => {
    const valid = lift<Set<string>>([], `return ${inner(PROFILE, 'const VALID_TABS = ', ';\n')};`)();
    expect([...valid]).toEqual([...PROFILE_TABS]);
    const tabs = lift<Array<{ id: string; label: string }>>(
      ['IconUser', 'IconShieldCheck', 'IconLock', 'IconMonitor'],
      `return ${inner(PROFILE, 'const tabs = ', ';\n')};`,
    )(null, null, null, null);
    expect(tabs.map((x) => ({ key: x.id, label: x.label }))).toEqual(PROFILE_TAB_ITEMS);
    // EquityHub has no broker switch that hides KYC.
    expect(PROFILE).not.toContain('kycOn');
  });

  it('opens on the ?tab= the link names, else Profile, and drops the param for Profile', () => {
    for (const p of ['profile', 'kyc', 'security', 'devices']) expect(initialProfileTab(p)).toBe(p);
    for (const p of [undefined, '', 'KYC', 'settings', 3]) expect(initialProfileTab(p)).toBe('profile');
    expect(isProfileTab('devices')).toBe(true);
    expect(tabParam('profile')).toBeUndefined();
    expect(tabParam('kyc')).toBe('kyc');
  });
});

/* ══ Hero ══════════════════════════════════════════════════════════════ */

describe('hero', () => {
  const webInitials = lift<string>(['user'], inner(PROFILE, 'const initials = useMemo(() => {', '}, [user?.firstName'));
  const webName = lift<string>(
    ['user'],
    `return (user?.firstName || user?.lastName) ${inner(PROFILE, '{(user?.firstName || user?.lastName)\n', '}\n            </h1>').trim()};`,
  );

  const cases: Array<Record<string, unknown>> = [
    { firstName: 'Ada', lastName: 'Lovelace' },
    { firstName: 'ada', lastName: '' },
    { firstName: '', lastName: 'lovelace' },
    { firstName: null, lastName: null },
    { firstName: null, lastName: null, email: '' },
    { firstName: 'Ada' },
  ];

  it.each(cases)('initials and name match the web for %j', (raw) => {
    const u = user(raw);
    const webUser = { firstName: u.firstName, lastName: u.lastName, email: u.email };
    expect(profileInitials(u)).toBe(webInitials(webUser));
    expect(heroName(u)).toBe(webName(webUser));
  });

  it('shows "—" for no join date, and for one it cannot read (the web printed "Invalid Date")', () => {
    expect(memberSince(null)).toBe('—');
    expect(memberSince('not a date')).toBe('—');
    const iso = '2025-03-14T10:00:00.000Z';
    expect(memberSince(iso)).toBe(new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short' }));
  });

  it('KycPill: the web map, keyed on the raw account status', () => {
    const webMap = lift<Record<string, { c: string; l: string }>>([], `return ${inner(PROFILE, 'const map = ', '[status];')};`)();
    for (const [k, v] of Object.entries(webMap)) {
      expect(KYC_PILL[k as keyof typeof KYC_PILL]).toEqual({ tone: v.c, label: v.l });
    }
    expect(Object.keys(KYC_PILL).sort()).toEqual(Object.keys(webMap).sort());
    expect(kycPill(null)).toEqual(KYC_PILL.NOT_SUBMITTED);
  });

  it('the chips are email, KYC and the referral code — no 2FA chip', () => {
    const chips = between(PROFILE, '{/* Status chips */}', '{/* ── Tabs');
    expect(chips).not.toContain('2FA');
    expect(app('screens/profile/components/ProfileHero.tsx')).not.toContain('2FA');
  });
});

/* ══ Country ═══════════════════════════════════════════════════════════ */

describe('countryName', () => {
  const webCountry = lift<string>(['code'], inner(PROFILE, 'const countryName = (code) => {', '\n};\n'));

  it.each(['IN', 'us', 'GB', 'AE', 'HK', null, '', 'India', 'XX'])('matches the web where Intl.DisplayNames exists: %p', (code) => {
    expect(countryName(code as string | null)).toBe(webCountry(code));
  });

  it('falls back to the registration list, then the raw value, where it does not (Hermes)', () => {
    const intl = Intl as unknown as { DisplayNames?: unknown };
    const saved = intl.DisplayNames;
    try {
      delete intl.DisplayNames;
      expect(countryName('in')).toBe('India');
      expect(countryName('AE')).toBe('United Arab Emirates');
      expect(countryName('ZZ')).toBe('ZZ');
      expect(countryName('India')).toBe('India');
      expect(countryName(undefined)).toBe('—');
    } finally {
      intl.DisplayNames = saved;
    }
  });
});

/* ══ Profile tab ═══════════════════════════════════════════════════════ */

describe('profile form', () => {
  const webDirty = lift<boolean>(['form', 'user'], `return ${inner(PROFILE, 'const dirty =\n', ';\n\n  const save')};`);

  it('starts from the document as sent, and is dirty exactly when the web says so', () => {
    const u = user({ firstName: 'Ada', lastName: 'Lovelace', phone: '+919876543210', mobile: '+910000000000' });
    const form = profileFormFrom(u);
    expect(form).toEqual({ firstName: 'Ada', lastName: 'Lovelace', phone: '+919876543210' });
    for (const f of [form, { ...form, firstName: 'Ad' }, { ...form, lastName: '' }, { ...form, phone: '+91' }]) {
      expect(profileDirty(f, u)).toBe(webDirty(f, u.raw));
    }
    const blank = user({});
    expect(profileFormFrom(blank)).toEqual({ firstName: '', lastName: '', phone: '' });
    expect(profileDirty({ firstName: '', lastName: '', phone: '' }, blank)).toBe(false);
  });

  it('resend: 30 s cooldown, the web labels', () => {
    expect(PROFILE).toContain(`setResendCooldown(${RESEND_COOLDOWN_S})`);
    expect(resendLabel(0)).toBe('Resend verification');
    expect(resendLabel(12)).toBe('Resend in 12s');
  });

  it('referral: the web name rule', () => {
    const src = between(PROFILE, '{(user.referredBy.firstName || user.referredBy.lastName)', '}\n                </div>');
    const webRef = lift<string>(['r'], `return ${src.slice(1).replace(/user\.referredBy/g, 'r')};`);
    for (const r of [
      { firstName: 'Grace', lastName: 'Hopper', email: 'g@x.io', referralCode: 'GH1' },
      { firstName: null, lastName: 'Hopper', email: null, referralCode: null },
      { firstName: null, lastName: null, email: 'g@x.io', referralCode: null },
      { firstName: null, lastName: null, email: null, referralCode: null },
    ]) {
      expect(referredByName(r)).toBe(webRef(r));
    }
  });
});

/* ══ KYC ═══════════════════════════════════════════════════════════════ */

describe('kyc — status and documents on file', () => {
  it('status banner: the web copy and colour per status', () => {
    const webMeta = lift<Record<string, { color: string; desc: string }>>([], `return ${inner(PROFILE, 'const statusMeta = ', '[status];')};`)();
    for (const [k, v] of Object.entries(webMeta)) {
      expect(KYC_STATUS_META[k as keyof typeof KYC_STATUS_META]).toEqual({ tone: v.color, desc: v.desc });
    }
    // An off-enum status crashes the web page; here it reads as not submitted.
    expect(kycStatusMeta('ON_HOLD')).toEqual(KYC_STATUS_META.NOT_SUBMITTED);
  });

  it("the account status and each document's status follow the web — a document's own verdict wins", () => {
    const webStatus = lift<string>(['rawStatus', 'docs'], `${between(PROFILE, 'const hasReviewableDocs', 'const statusMeta')} return status;`);
    const statuses = ['NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED', 'ODD'];
    const docSets = [[], [{ status: 'REJECTED' }], [{ status: 'PENDING' }], [{ status: 'APPROVED' }, { status: 'REJECTED' }]];
    for (const s of statuses) {
      for (const docs of docSets) expect(effectiveKycStatus(s, docs)).toBe(webStatus(s, docs));
      for (const ds of ['PENDING', 'APPROVED', 'REJECTED', 'UNKNOWN']) {
        expect(kycDocDisplayStatus({ status: ds }, s)).toBe(webDocStatus({ status: ds }, s));
      }
    }
    // The case the old rule got wrong: a rejected document under an approved account.
    expect(kycDocDisplayStatus({ status: 'REJECTED' }, 'APPROVED')).toBe('REJECTED');
  });

  it('documents are named by the web DOC_LABELS, else every underscore spaced', () => {
    const labels = lift<Record<string, string>>([], `return ${inner(PROFILE, 'const DOC_LABELS = ', ';\n')};`)();
    expect(KYC_DOC_LABELS).toEqual(labels);
    const webLabel = lift<string>(['DOC_LABELS', 't'], `return ${inner(PROFILE, 'const docLabel = (t) => ', ';\n')};`);
    for (const t of ['PAN_CARD', 'ID_FRONT', 'ADDRESS_PROOF', 'OTHER', 'NEW_KIND_OF_DOC', '', null]) {
      expect(kycDocLabel(t)).toBe(webLabel(labels, t));
    }
  });

  it('chip colours, the banner chip and the count', () => {
    const webChip = lift<string>(['ds'], `return ${between(PROFILE, "ds === 'APPROVED' ? ", "}`}>{ds}")};`);
    for (const ds of ['APPROVED', 'REJECTED', 'PENDING', 'ANYTHING']) {
      const cls = webChip(ds);
      expect(docStatusTone(ds)).toBe(cls.includes('bull') ? 'bull' : cls.includes('bear') ? 'bear' : 'warn');
    }
    expect(PROFILE).toContain("{status.replace('_', ' ')}");
    expect(underscoreToSpace('NOT_SUBMITTED')).toBe('NOT SUBMITTED');
    const webDocs = lift<string>(['docs'], `return \`${inner(PROFILE, 'subtitle={`', '`}\n        padded={false}')}\`;`);
    for (const n of [0, 1, 2, 7]) expect(docsSubtitle(n)).toBe(webDocs({ length: n }));
  });

  it('shows a rejected document its reason', () => {
    expect(PROFILE).toContain("{ds === 'REJECTED' && d.rejectionReason && (");
    expect(PROFILE).toContain('Reason: {d.rejectionReason}');
    expect(app('screens/profile/components/KycTab.tsx')).toContain("ds === 'REJECTED' && d.rejectionReason");
  });
});

describe('kyc — Step 1, the PAN card', () => {
  it('uploads as PAN_CARD — a type the server accepts — with no PAN number anywhere', () => {
    expect(PROFILE).toContain("onUpload={(file) => upload(file, 'PAN_CARD')}");
    const types = lift<string[]>([], `return ${inner(backend('config/constants.js'), 'KYC_DOC_TYPES: ', ',\n')};`)();
    expect(types).toContain(PAN_CARD);
    for (const t of KYC_DOC_TYPES) expect(types).toContain(t.value);
    expect(COMPLIANCE).toContain('if (!KYC_DOC_TYPES.includes(docType)) {');
    // Upload only: neither page asks for the number.
    expect(PROFILE).not.toMatch(/panNumber|PAN number/i);
    // …and the app's KYC tab has no text field at all.
    expect(app('screens/profile/components/KycTab.tsx')).not.toMatch(/panNumber|<Input|TextInput/);
  });

  const block = between(PROFILE, 'const panDoc = ', 'const hasReviewableDocs');
  const webGate = lift<{ panDoc: unknown; panStatus: string | null; panOnFile: boolean; otherUploadsLocked: boolean }>(
    ['docs', 'rawStatus', 'docsLoaded', 'effectiveDocStatus'],
    `${block} return { panDoc, panStatus, panOnFile, otherUploadsLocked };`,
  );

  const sets: Array<[string, Array<Record<string, unknown>>]> = [
    ['none', []],
    ['other documents only', [{ docType: 'ID_FRONT', status: 'PENDING' }]],
    ['a pending PAN card', [{ docType: 'PAN_CARD', status: 'PENDING' }]],
    ['an approved PAN card', [{ docType: 'PAN_CARD', status: 'APPROVED' }]],
    ['a rejected PAN card', [{ docType: 'PAN_CARD', status: 'REJECTED', rejectionReason: 'Blurry' }]],
    ['a newer pending PAN over an older rejected one', [{ docType: 'PAN_CARD', status: 'PENDING', _id: 'n' }, { docType: 'PAN_CARD', status: 'REJECTED', _id: 'o' }]],
    ['a newer rejected PAN over an older approved one', [{ docType: 'PAN_CARD', status: 'REJECTED', _id: 'n' }, { docType: 'PAN_CARD', status: 'APPROVED', _id: 'o' }]],
  ];

  it.each(sets)('gates Step 2 as the web does: %s', (_label, raw) => {
    const docs = raw.map(doc);
    for (const rawStatus of ['NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED']) {
      for (const loaded of [true, false]) {
        const w = webGate(docs, rawStatus, loaded, webDocStatus);
        const a = panGate(docs, rawStatus, loaded);
        expect({ panDoc: a.panDoc, panStatus: a.panStatus, panOnFile: a.panOnFile, otherUploadsLocked: a.otherUploadsLocked })
          .toEqual({ panDoc: w.panDoc, panStatus: w.panStatus, panOnFile: w.panOnFile, otherUploadsLocked: w.otherUploadsLocked });
      }
    }
  });

  it('never locks Step 2 on a list that did not load', () => {
    expect(panGate([], 'NOT_SUBMITTED', false).otherUploadsLocked).toBe(false);
    expect(panGate([], 'NOT_SUBMITTED', true).otherUploadsLocked).toBe(true);
  });

  it('shows the upload zone exactly when the web does — "Upload a different one" only while pending', () => {
    const webShow = lift<boolean>(['panDoc', 'panStatus', 'replacing'], `return ${inner(PROFILE, 'const showForm = ', ';\n')};`);
    for (const has of [true, false]) {
      for (const s of [null, 'PENDING', 'APPROVED', 'REJECTED']) {
        for (const replacing of [true, false]) {
          expect(panFormShown(has, s, replacing)).toBe(webShow(has ? {} : null, s, replacing));
        }
      }
    }
    expect(PROFILE).toContain("{panStatus === 'PENDING' && !replacing && (");
    expect(PROFILE).toContain('Upload a different one');
  });

  it('the badge: the status, or "Required" in the brand colour', () => {
    const src = inner(PROFILE, 'const badge = ', ';\n\n  return (');
    const webBadge = lift<string>(['panStatus'], `return ${src};`);
    for (const s of [null, 'PENDING', 'APPROVED', 'REJECTED', 'ODD']) {
      const cls = webBadge(s);
      const tone = cls.includes('bull') ? 'bull' : cls.includes('bear') ? 'bear' : cls.includes('warn') ? 'warn' : 'primary';
      expect(panBadge(s)).toEqual({ label: s || 'Required', tone });
    }
    expect(PROFILE).toContain("{panStatus || 'Required'}");
  });

  it('the line under the card on file, per status', () => {
    for (const [status, line] of Object.entries(PAN_STATUS_LINE)) {
      expect(PROFILE).toContain(`{panStatus === '${status}' && '${line}'}`);
      expect(panStatusLine(status)).toBe(line);
    }
    expect(panStatusLine(null)).toBe('');
    expect(panStatusLine('ODD')).toBe('');
  });

  it('the toasts, the Step 2 notice and the card copy are the web words', () => {
    expect(PROFILE).toContain("toast.success(type === 'PAN_CARD' ? 'PAN card uploaded' : 'Document uploaded');");
    expect(kycUploadedToast('PAN_CARD')).toBe('PAN card uploaded');
    expect(kycUploadedToast('SELFIE')).toBe('Document uploaded');
    expect(PROFILE).toContain(`<span>${KYC_PAN_FIRST}</span>`);
    for (const s of [
      'subtitle="Step 1 · Required. Upload a clear photo or scan of your PAN card."',
      'subtitle="Step 2 · JPG, PNG, or PDF — max 10MB per file."',
      "'Upload your PAN card first'",
      'PAN card on file',
    ]) expect({ s, web: PROFILE.includes(s) }).toEqual({ s, web: true });
  });
});

describe('kyc — may this account still upload?', () => {
  it('asks GET /user/kyc/status, and only an explicit `canUpload: false` hides the form', () => {
    expect(PROFILE).toContain("const s = await api.get('/user/kyc/status'); setCanUpload(s.data.data?.canUpload !== false);");
    const ctrl = backend('controllers/userController.js');
    expect(ctrl).toContain('canUpload: user.kycStatus !== KYC_STATUS.APPROVED || !!user.kycUploadUnlocked,');
    expect(toKycStatusInfo({ status: 'APPROVED', canUpload: false })).toMatchObject({ status: 'APPROVED', canUpload: false });
    expect(toKycStatusInfo({ status: 'APPROVED', canUpload: true, uploadUnlocked: true })).toMatchObject({ canUpload: true, uploadUnlocked: true });
    expect(toKycStatusInfo({})).toMatchObject({ status: 'NOT_SUBMITTED', canUpload: true });
    // …and the upload endpoint enforces the same rule.
    expect(COMPLIANCE).toContain("'KYC_ALREADY_VERIFIED'");
  });

  it('a verified account reads "Verification complete" in the web words', () => {
    expect(PROFILE).toContain('subtitle="No further documents are needed."');
    expect(app('screens/profile/components/KycTab.tsx')).toContain('subtitle="No further documents are needed."');
  });
});

describe('kyc — the file', () => {
  it('Step 2 offers the web document types, in order, starting on ID_FRONT', () => {
    const opts = [...between(PROFILE, '<select className="input" value={docType}', '</select>')
      .matchAll(/<option value="([A-Z_]+)">([^<]+)<\/option>/g)].map((m) => ({ value: m[1], label: m[2] }));
    expect(opts).toEqual(KYC_DOC_TYPES);
    expect(PROFILE).toContain("useState('ID_FRONT')");
  });

  it('refuses an oversized file in the web words, against the web and server limit', () => {
    expect(PROFILE).toContain('const KYC_MAX_BYTES = 10 * 1024 * 1024;');
    expect(COMPLIANCE).toContain('const MAX_SIZE = 10 * 1024 * 1024;');
    expect(KYC_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(PROFILE).toContain(`if (file.size > KYC_MAX_BYTES) { toast.error('${KYC_TOO_LARGE}'); return false; }`);
    expect(kycFileError({ size: KYC_MAX_BYTES + 1, mimeType: 'image/png' })).toBe(KYC_TOO_LARGE);
    expect(kycFileError({ size: KYC_MAX_BYTES, mimeType: 'image/png' })).toBeNull();
    // An unknown size passes to the byte check (complianceApi.kycUploadError).
    expect(kycFileError({ size: null, mimeType: 'image/png' })).toBeNull();
  });

  it('DIFFERS: the app refuses a wrong type before sending; the web leaves it to the server', () => {
    // On the web a wrong type travels and comes back "Unsupported mime type".
    expect(PROFILE).not.toContain('ALLOWED_UPLOAD_MIME');
    expect(COMPLIANCE).toContain(`const ALLOWED_MIME = [${KYC_ALLOWED_MIME.map((m) => `'${m}'`).join(', ')}];`);
    expect(PROFILE).toContain("const KYC_ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';");
    expect(kycFileError({ size: 1000, mimeType: 'image/heic' })).toBe(KYC_WRONG_TYPE);
    expect(kycFileError({ size: KYC_MAX_BYTES + 1, mimeType: 'image/heic' })).toBe(KYC_TOO_LARGE);
    for (const m of KYC_ALLOWED_MIME) expect(kycFileError({ size: 1000, mimeType: m })).toBeNull();
  });

  it('names the type the way the server lists it, from the extension when the picker did not say', () => {
    expect(kycMimeType('image/jpeg', 'a.jpg')).toBe('image/jpeg');
    expect(kycMimeType('image/jpg', 'a.jpg')).toBe('image/jpeg');
    expect(kycMimeType('IMAGE/PNG', 'a')).toBe('image/png');
    expect(kycMimeType(undefined, 'scan.PDF')).toBe('application/pdf');
    expect(kycMimeType(null, 'file:///x/y/photo.webp?v=1')).toBe('image/webp');
    expect(kycMimeType('', 'noext')).toBe('');
    expect(kycMimeType('image/heic', 'IMG_1.HEIC')).toBe('image/heic');
  });

  it('gives a camera shot a name (the server requires one)', () => {
    expect(kycFileName('passport.pdf', 'file:///c/x.pdf', 'ID_FRONT', 'application/pdf')).toBe('passport.pdf');
    expect(kycFileName(null, 'file:///cache/ImagePicker/ABC-123.jpg', 'SELFIE', 'image/jpeg')).toBe('ABC-123.jpg');
    expect(kycFileName(undefined, 'content://media/external/42', 'PAN_CARD', 'image/png', 1700000000000))
      .toBe('PAN_CARD_1700000000000.png');
    expect(kycFileName(null, 'file:///c/My%20Scan.pdf', 'ID_BACK', 'application/pdf')).toBe('My Scan.pdf');
    expect(kycFileName(null, 'file:///c/bad%E0%A4.pdf', 'ID_BACK', 'application/pdf')).toBe('bad%E0%A4.pdf');
  });

  it('sizes the upload timeout to the body, 20 s to 5 min', () => {
    expect(kycUploadTimeoutMs(0)).toBe(20_000);
    expect(kycUploadTimeoutMs(65_536)).toBe(21_000);
    expect(kycUploadTimeoutMs(Math.ceil((KYC_MAX_BYTES * 4) / 3))).toBe(20_000 + 214_000);
    expect(kycUploadTimeoutMs(1e9)).toBe(300_000);
  });
});

describe('kyc — a photo is sent as the format its bytes are', () => {
  // The server's own byte check, lifted: sniffMime.
  const sniff = lift<string | null>(['buf'], `${between(COMPLIANCE, 'function sniffMime(buf) {', '/**\n * Upload a KYC document.')} return sniffMime(buf);`);
  const pad = (head: number[]): Buffer => Buffer.concat([Buffer.from(head), Buffer.alloc(200, 7)]);
  const ascii = (s: string): number[] => [...Buffer.from(s, 'latin1')];

  const samples: Array<[string, Buffer]> = [
    ['jpeg', pad([0xFF, 0xD8, 0xFF, 0xE0])],
    ['png', pad([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])],
    ['webp', pad([...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBP')])],
    ['avi (RIFF, not WEBP)', pad([...ascii('RIFF'), 1, 2, 3, 4, ...ascii('AVI ')])],
    ['pdf', pad(ascii('%PDF-1.7'))],
    ['heic', pad([0, 0, 0, 0x18, ...ascii('ftypheic')])],
    ['gif', pad(ascii('GIF89a'))],
    ['almost jpeg', pad([0xFF, 0xD8, 0x00])],
  ];

  it.each(samples)('%s: the app reads the bytes as the server does', (_label, buf) => {
    expect(sniffKycMime(buf.toString('base64'))).toBe(sniff(buf));
  });

  it('decodes the head of base64 as Buffer does, data-URL prefix and padding included', () => {
    for (const [, buf] of samples) {
      const b64 = buf.toString('base64');
      expect(base64Head(b64, 12)).toEqual([...buf.subarray(0, 12)]);
      expect(base64Head(`data:image/jpeg;base64,${b64}`, 12)).toEqual([...buf.subarray(0, 12)]);
    }
    expect(base64Head(Buffer.from([1, 2]).toString('base64'), 12)).toEqual([1, 2]);
    expect(base64Head('', 12)).toEqual([]);
  });

  it('renames the photo to match what it now is', () => {
    expect(kycNameForMime('IMG_2041.heic', 'image/jpeg')).toBe('IMG_2041.jpg');
    expect(kycNameForMime('sticker.webp', 'image/jpeg')).toBe('sticker.jpg');
    expect(kycNameForMime('IMG_1.jpeg', 'image/jpeg')).toBe('IMG_1.jpeg');
    expect(kycNameForMime('SHOT.JPG', 'image/jpeg')).toBe('SHOT.JPG');
    expect(kycNameForMime('shot.png', 'image/png')).toBe('shot.png');
    expect(kycNameForMime('noext', 'image/png')).toBe('noext.png');
    expect(kycNameForMime('.hidden', 'image/png')).toBe('.hidden.png');
  });
});

/* ══ Security ══════════════════════════════════════════════════════════ */

describe('security', () => {
  it('is the password change alone: EquityHub has no two-factor sign-in', () => {
    expect(between(PROFILE, 'function SecurityTab() {', '// ============== DEVICES')).not.toContain('2FA');
    expect(PROFILE).not.toContain('/auth/2fa');
    expect(backend('routes/auth.js')).not.toContain('2fa');
    expect(AUTH).not.toContain('setup2FA');
    expect(app('screens/profile/components/SecurityTab.tsx')).not.toMatch(/setup2fa|enable2fa|disable2fa|backupCodes|twoFactor/);
  });

  it('the checklist is the web Profile rule list, and the server policy agrees with it', () => {
    const webRules = lift<Array<{ test: (p: string) => boolean; label: string }>>([], `return ${inner(PROFILE, 'const PASSWORD_RULES = ', ';\n')};`)();
    expect(webRules.map((r) => r.label)).toEqual(PASSWORD_RULES.map((r) => r.label));
    const policy = lift<(pw: string) => string | null>(
      [],
      `${between(backend('utils/passwordPolicy.js'), 'function validatePasswordStrength', 'module.exports')} return validatePasswordStrength;`,
    )();
    for (const pw of ['', 'short1!', 'alllowercase1!', 'ALLUPPER1!', 'NoDigits!!', 'NoSymbol123', 'Good#Pass1', 'Ünïcödé#1a', `Aa1!${'x'.repeat(130)}`]) {
      webRules.forEach((r, i) => expect(PASSWORD_RULES[i]?.test(pw)).toBe(r.test(pw)));
      if (pw.length <= 128) expect(passwordRulesPass(pw)).toBe(policy(pw) === null);
    }
  });

  it('submit checks: the web order and words', () => {
    const webSubmit = lift<string | undefined>(
      ['cur', 'rulesPass', 'match', 'toast'],
      `${between(PROFILE, 'if (!cur) return toast.error', 'setLoading(true);')} return undefined;`,
    );
    const toast = { error: (m: string) => m };
    for (const [cur, pwd, confirm] of [
      ['', '', ''],
      ['old', 'weak', 'weak'],
      ['old', 'Strong#Pass1', 'Strong#Pass2'],
      ['old', 'Strong#Pass1', ''],
      ['old', 'Strong#Pass1', 'Strong#Pass1'],
      ['', 'Strong#Pass1', 'Strong#Pass1'],
    ] as const) {
      const match = !!pwd && pwd === confirm;
      expect(changePasswordError(cur, pwd, confirm)).toBe(webSubmit(cur, passwordRulesPass(pwd), match, toast) ?? null);
    }
  });

  it('the confirm field says "Passwords do not match" when the web does', () => {
    for (const [pwd, confirm] of [['a', ''], ['a', 'b'], ['', 'b'], ['a', 'a'], ['', '']]) {
      const match = pwd && pwd === confirm;
      expect(confirmMismatch(pwd as string, confirm as string)).toBe(!!(confirm && !match));
    }
  });
});

/* ══ Sessions ══════════════════════════════════════════════════════════ */

describe('sessions', () => {
  it('subtitle: the web template', () => {
    const src = between(PROFILE, "subtitle={loading ? 'Loading…' : `", '`}');
    const webSub = lift<string>(['loading', 'devices'], `return loading ? 'Loading…' : \`${src.slice("subtitle={loading ? 'Loading…' : `".length)}\`;`);
    expect(sessionsSubtitle(true, 0)).toBe(webSub(true, []));
    for (const n of [0, 1, 3]) expect(sessionsSubtitle(false, n)).toBe(webSub(false, { length: n }));
  });

  it('every session has an id (its sid), the last activity and which one is this device', () => {
    expect(AUTH).toContain('    id: t.sid,');
    expect(AUTH).toContain('    lastSeenAt: t.lastSeenAt || t.createdAt,');
    expect(AUTH).toContain('    current: !!(req.sessionId && t.sid === req.sessionId),');
    expect(toSessionDevice({ id: 's1', deviceInfo: 'okhttp', createdAt: '2026-01-01', lastSeenAt: '2026-02-01', current: true }))
      .toEqual({ id: 's1', deviceInfo: 'okhttp', createdAt: '2026-01-01', lastSeenAt: '2026-02-01', current: true });
    expect(toSessionDevice({})).toEqual({ id: null, deviceInfo: 'Unknown device', createdAt: null, lastSeenAt: null, current: false });
  });

  it('"This device" has no Revoke; the rest revoke by session id ("Session not found" when gone)', () => {
    expect(PROFILE).toContain('{d.current ? (');
    expect(PROFILE).toContain('This device');
    expect(AUTH).toContain(`throw new AppError('${SESSION_NOT_FOUND}', 404);`);
    expect(PROFILE).toContain(`confirm('${REVOKE_CONFIRM}')`);
    // The numeric-index path the app once needed is gone from the server.
    expect(AUTH).not.toContain('const idx = Number(id);');
  });

  it('the activity line is the web template', () => {
    const tpl = inner(PROFILE, '<div className="text-[11px] text-text-muted">\n                  ', '\n                </div>');
    const webLine = lift<string>(['d'], `return \`${tpl.replace(/\{new Date/g, '${new Date')}\`;`);
    for (const d of [
      { lastSeenAt: '2026-02-01T10:00:00Z', createdAt: '2026-01-01T09:00:00Z' },
      { lastSeenAt: null, createdAt: '2026-01-01T09:00:00Z' },
    ]) {
      expect(deviceActivity(d)).toBe(webLine(d));
    }
  });

  it('dates read "—" when missing or unreadable', () => {
    expect(shortDate(null)).toBe('—');
    expect(dateTime('nope')).toBe('—');
    const iso = '2026-01-02T03:04:05.000Z';
    expect(shortDate(iso)).toBe(new Date(iso).toLocaleDateString());
    expect(dateTime(iso)).toBe(new Date(iso).toLocaleString());
  });
});

/* ══ Copy ══════════════════════════════════════════════════════════════ */

describe('web wording', () => {
  const APP = [
    'screens/profile/ProfileScreen.tsx',
    'screens/profile/components/ProfileHero.tsx',
    'screens/profile/components/ProfileDetailsTab.tsx',
    'screens/profile/components/KycTab.tsx',
    'screens/profile/components/SecurityTab.tsx',
    'screens/profile/components/DevicesTab.tsx',
    'utils/profile.ts',
    'types/user.ts',
  ].map(app).join('\n');

  it('every toast the web page raises is raised here with the same words', () => {
    const toasts = [...PROFILE.matchAll(/toast\.(success|error)\('([^']+)'\)/g)].map((m) => m[2] as string);
    expect(toasts.length).toBeGreaterThan(8);
    for (const msg of toasts) expect({ msg, found: APP.includes(`'${msg}'`) }).toEqual({ msg, found: true });
  });

  it('every section title, subtitle and field label is the web one', () => {
    const attrs = [...PROFILE.matchAll(/\b(title|subtitle|label|activeLabel|inactiveLabel|desc|placeholder)="([^"]+)"/g)]
      .map((m) => m[2] as string)
      // Hover tooltips have no phone equivalent ("Copy your User ID" is the
      // copy button's accessibility label instead).
      .filter((s) => !['Copy your User ID'].includes(s));
    expect(attrs.length).toBeGreaterThan(25);
    for (const s of attrs) {
      const found = APP.includes(`"${s}"`) || APP.includes(`'${s}'`) || APP.includes(`>${s}<`);
      expect({ s, found }).toEqual({ s, found: true });
    }
  });

  it('keeps the body copy of each state verbatim', () => {
    for (const s of [
      'Signed up directly',
      'Unsaved changes',
      'All changes saved',
      'No documents uploaded yet',
      'Max 10MB · JPG, PNG, PDF',
      'Upload a different one',
      'PAN card on file',
      'Rejection reason: ',
      'Loading sessions…',
      'No active sessions',
      'Unknown device',
      'This device',
      'Current',
      'Member since',
      'Welcome back',
    ]) {
      expect({ s, web: PROFILE.includes(s) }).toEqual({ s, web: true });
      expect({ s, app: APP.includes(s) }).toEqual({ s, app: true });
    }
  });
});

/* ══ Review fixes ══════════════════════════════════════════════════════ */

describe('review: an untouched form follows the saved profile', () => {
  const a = { firstName: 'Ada', lastName: 'Lovelace', phone: '+91 1' };
  const b = { firstName: 'Ada', lastName: 'King', phone: '+91 1' };

  it('re-seeds a form that still holds the old saved values (pull to refresh, /auth/me)', () => {
    expect(followSavedProfile(a, a, b)).toEqual(b);
  });

  it('keeps the fields being edited; the untouched ones still follow', () => {
    const editing = { ...a, phone: '+91 2' };
    expect(followSavedProfile(editing, a, b)).toEqual({ firstName: 'Ada', lastName: 'King', phone: '+91 2' });
    const clash = { ...a, lastName: 'Byron' };
    expect(followSavedProfile(clash, a, b)).toBe(clash);
  });

  it('after a save the form already equals the new values and is left alone', () => {
    const typed = { ...a, lastName: 'King' };
    expect(followSavedProfile(typed, a, b)).toBe(typed);
    expect(profileDirty(typed, user(b))).toBe(false);
  });

  it('no change underneath is no change', () => {
    const editing = { ...a, firstName: 'Augusta' };
    expect(followSavedProfile(editing, a, { ...a })).toBe(editing);
    expect(followSavedProfile(a, a, { ...a })).toBe(a);
  });
});

describe('review: the referrer reads as the web reads it', () => {
  const nameSrc = between(PROFILE, '{(user.referredBy.firstName || user.referredBy.lastName)', '}\n                </div>');
  const webRefName = lift<string>(['r'], `return ${nameSrc.slice(1).replace(/user\.referredBy/g, 'r')};`);
  const webRef = (u: { referredBy?: unknown }): { name: string; code: string | null } => (u.referredBy
    ? { name: webRefName(u.referredBy), code: ((u.referredBy as { referralCode?: string }).referralCode) || null }
    : { name: 'Signed up directly', code: null });
  const appRef = (raw: Record<string, unknown>): { name: string; code: string | null } => {
    const r = profileReferrer(user(raw));
    return r ? { name: referredByName(r), code: r.referralCode } : { name: 'Signed up directly', code: null };
  };

  it.each([
    ['populated by /auth/me', { referredBy: { firstName: 'Grace', lastName: 'Hopper', email: 'g@x.io', referralCode: 'GH1' } }],
    ['populated, email only', { referredBy: { email: 'g@x.io' } }],
    ['a bare id, as a login response carries it', { referredBy: '65f0c0ffee0000000000abcd' }],
    ['nobody', { referredBy: null }],
    ['absent', {}],
  ])('%s', (_label, raw) => {
    expect(appRef(raw)).toEqual(webRef(raw));
  });

  it('a bare id is "Anonymous referrer", never "Signed up directly"', () => {
    expect(PROFILE).toContain('{user?.referredBy ? (');
    expect(appRef({ referredBy: '65f0c0ffee0000000000abcd' }).name).toBe('Anonymous referrer');
  });
});

describe('review: fields the server confirmed are held without waiting for /auth/me', () => {
  const held = user({
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: '+91 98',
    referredBy: { firstName: 'Grace', lastName: 'Hopper', email: 'g@x.io', referralCode: 'GRACE1' },
  });

  it('the re-read the page relies on is silent on failure — the reason for holding the answer', () => {
    const store = app('store/auth.ts');
    expect(between(store, 'refreshUser: async () => {', 'setUser:')).toContain('catch { /* keep the user we have');
  });

  it('lays the fields over the held document, derived fields included, and keeps the rest', () => {
    const renamed = withSavedFields(held, { firstName: 'Augusta', lastName: 'King', phone: '' });
    expect(renamed.name).toBe('Augusta King');
    expect(profileFormFrom(renamed)).toEqual({ firstName: 'Augusta', lastName: 'King', phone: '' });
    expect(profileReferrer(renamed)?.firstName).toBe('Grace');
    expect(renamed.id).toBe(held.id);
    expect(withSavedFields(held, { isEmailVerified: true }).emailVerified).toBe(true);
    // The original is not mutated.
    expect(held.firstName).toBe('Ada');
  });

  it('reads the saved profile off the PUT answer, else what was sent (stored verbatim)', () => {
    const sent = { firstName: 'Augusta', lastName: 'Lovelace', phone: '+91 98' };
    const answer = user({ firstName: 'Augusta', lastName: 'Lovelace', phone: '+91 98', referredBy: 'abc' });
    expect(savedProfileFields(answer, sent)).toEqual(sent);
    expect(savedProfileFields(user({ firstName: 'Srv' }), sent)).toEqual({ firstName: 'Srv', lastName: '', phone: '' });
    expect(savedProfileFields(null, sent)).toBe(sent);
    expect(savedProfileFields({} as never, sent)).toBe(sent);
    expect(backend('controllers/userController.js')).toContain('allowed.forEach((k) => k in req.body && (updates[k] = req.body[k]));');
  });

  it('an address already verified answers so, and the page reads Verified', () => {
    expect(between(AUTH, 'const resendVerifyEmail = asyncHandler', 'module.exports'))
      .toContain('if (user.isEmailVerified) return sendSuccess(res, { ok: true, alreadyVerified: true });');
  });
});
