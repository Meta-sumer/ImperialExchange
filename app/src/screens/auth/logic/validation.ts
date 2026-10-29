/**
 * Field validators and input sanitisers for the auth forms, ported from
 * client/src/utils/validation.js. Messages are the web's, verbatim.
 *
 * Each validator returns null when the value is acceptable, or a short
 * message. Cheap enough to run on every keystroke. The backend validates
 * everything again — these are UX, not security.
 *
 * Pure: no React, no React Native. Tested in authScreens.logic.test.ts.
 */

/**
 * A `u`-flag regex built at RUNTIME, with a fallback for an engine that
 * refuses it.
 *
 * The web's name rules use `\p{L}` (any letter, any script). A regex
 * LITERAL with a property escape is rewritten by Babel's unicode-regex
 * transform, which does not promise to handle property escapes; building it
 * from a string keeps it away from Babel and lets Hermes compile it natively.
 * The fallback is an explicit letter class covering the scripts a name on
 * this platform is realistically written in, so a refusal degrades to
 * "fewer scripts accepted" rather than "no names accepted".
 */
const unicodeRe = (source: string, flags: string, fallback: RegExp): RegExp => {
  try {
    return new RegExp(source, flags);
  } catch {
    return fallback;
  }
};

// Latin + Latin-1/Extended, Greek, Cyrillic, Hebrew, Arabic, Devanagari,
// Bengali, Tamil, Thai, Hangul, Kana, CJK.
const LETTER_FALLBACK =
  'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F\\u0370-\\u03FF\\u0400-\\u04FF' +
  '\\u0590-\\u05FF\\u0600-\\u06FF\\u0900-\\u097F\\u0980-\\u09FF\\u0B80-\\u0BFF\\u0E00-\\u0E7F' +
  '\\u1100-\\u11FF\\u3040-\\u30FF\\u4E00-\\u9FFF\\uAC00-\\uD7AF';

// Generous but real-world email pattern. Does not try to match every RFC
// edge case (those break more legit addresses than they catch).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Letters (incl. accented), apostrophes, hyphens, spaces. 1–50 chars.
// Rejects digits and symbols so "John123" does not sneak in.
const NAME_RE = unicodeRe(
  "^[\\p{L}][\\p{L}\\s'-]{0,49}$",
  'u',
  new RegExp(`^[${LETTER_FALLBACK}][${LETTER_FALLBACK}\\s'-]{0,49}$`),
);

// E.164-ish: optional leading +, then 7–15 digits. Spaces and dashes are
// stripped as the user types.
const PHONE_RE = /^\+?[0-9]{7,15}$/;

// Generated codes are 8 hex chars, but admin-assigned ones can be wider.
const REFERRAL_RE = /^[A-Z0-9]{6,16}$/;

type Msg = string | null;

export const v = {
  email(value: string | null | undefined): Msg {
    const s = (value || '').trim();
    if (!s) return 'Email is required';
    if (s.length > 254) return 'Email is too long';
    if (!EMAIL_RE.test(s)) return 'Enter a valid email address';
    return null;
  },

  password(value: string | null | undefined, opts: { strict?: boolean } = {}): Msg {
    const s = value || '';
    if (!s) return 'Password is required';
    if (s.length < 8) return 'At least 8 characters';
    if (s.length > 128) return 'Password is too long';
    if (opts.strict) {
      // Registration nudges a stronger password — 3 of the 4 character
      // classes. The backend accepts anything >= 8, so this is guidance
      // shown as an error before submit, exactly as on the web.
      const classes =
        (/[a-z]/.test(s) ? 1 : 0) +
        (/[A-Z]/.test(s) ? 1 : 0) +
        (/\d/.test(s) ? 1 : 0) +
        (/[^A-Za-z0-9]/.test(s) ? 1 : 0);
      if (classes < 3) return 'Mix letters, numbers, and a symbol';
    }
    return null;
  },

  passwordConfirm(value: string | null | undefined, original: string): Msg {
    if (!value) return 'Confirm your password';
    if (value !== original) return 'Passwords do not match';
    return null;
  },

  firstName(value: string | null | undefined): Msg {
    const s = (value || '').trim();
    if (!s) return 'First name is required';
    if (!NAME_RE.test(s)) return 'Letters, hyphens, and apostrophes only';
    return null;
  },

  lastName(value: string | null | undefined): Msg {
    const s = (value || '').trim();
    if (!s) return null; // optional
    if (!NAME_RE.test(s)) return 'Letters, hyphens, and apostrophes only';
    return null;
  },

  phone(value: string | null | undefined): Msg {
    const s = (value || '').trim();
    if (!s) return null; // optional
    if (!PHONE_RE.test(s)) return 'Enter 7–15 digits (optional + prefix)';
    return null;
  },

  country(value: string | null | undefined): Msg {
    const s = (value || '').trim();
    if (!s) return 'Pick a country';
    if (!/^[A-Z]{2}$/.test(s)) return 'Invalid country code';
    return null;
  },

  referralCode(value: string | null | undefined): Msg {
    const s = (value || '').trim().toUpperCase();
    if (!s) return null; // optional
    if (!REFERRAL_RE.test(s)) return 'Letters and digits only (6–16 chars)';
    return null;
  },
  // validation.js also carries totp / backupCode validators; no EquityHub
  // page uses them (its sign-in takes no second factor), so they are not here.
};

const NAME_STRIP = unicodeRe("[^\\p{L}\\s'-]", 'gu', new RegExp(`[^${LETTER_FALLBACK}\\s'-]`, 'g'));

/**
 * Run on the raw value as the user types, so form state never holds a
 * character the field does not allow — the value on screen is the value
 * that is sent.
 */
export const sanitize = {
  /** No whitespace, lower-cased; the @ is left alone. */
  email: (s: string | null | undefined): string => (s || '').replace(/\s+/g, '').toLowerCase().slice(0, 254),
  /** Digits and a single LEADING +; spaces, dashes and dots are dropped. */
  phone: (s: string | null | undefined): string => {
    const cleaned = (s || '').replace(/[^\d+]/g, '');
    return cleaned.startsWith('+')
      ? `+${cleaned.slice(1).replace(/\+/g, '').slice(0, 15)}`
      : cleaned.replace(/\+/g, '').slice(0, 15);
  },
  /** Letters, apostrophes, hyphens, spaces. */
  name: (s: string | null | undefined): string => (s || '').replace(NAME_STRIP, '').slice(0, 50),
  /** Upper-case alphanumeric — the stored format. */
  referralCode: (s: string | null | undefined): string => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16),
};

/* ── Form-level validation ────────────────────────────────────────────── */

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

/** Drop the fields that passed — the web's `Object.fromEntries(...filter(val))`. */
const compact = <K extends string>(all: Record<K, Msg>): FieldErrors<K> => {
  const out: FieldErrors<K> = {};
  for (const k of Object.keys(all) as K[]) {
    const msg = all[k];
    if (msg) out[k] = msg;
  }
  return out;
};

export type LoginField = 'email' | 'password';

/** Login.jsx `validate()` — email and password; EquityHub's sign-in asks for nothing else. */
export const validateLogin = (f: { email: string; password: string }): FieldErrors<LoginField> =>
  compact<LoginField>({
    email: v.email(f.email),
    password: v.password(f.password),
  });

export interface RegisterForm {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone: string;
  country: string;
  referralCode: string;
}

export type RegisterField = keyof RegisterForm;

export const REGISTER_FIELDS: readonly RegisterField[] = [
  'email', 'password', 'firstName', 'lastName', 'phone', 'country', 'referralCode',
];

/** One Register field, as Register.jsx's `update` / `onBlur` check it (strict password). */
export const validateRegisterField = (field: RegisterField, value: string): Msg => {
  switch (field) {
    case 'email': return v.email(value);
    case 'password': return v.password(value, { strict: true });
    case 'firstName': return v.firstName(value);
    case 'lastName': return v.lastName(value);
    case 'phone': return v.phone(value);
    case 'country': return v.country(value);
    case 'referralCode': return v.referralCode(value);
    default: return null;
  }
};

/** Register.jsx `validateAll()`. */
export const validateRegister = (form: RegisterForm): FieldErrors<RegisterField> => {
  const all = {} as Record<RegisterField, Msg>;
  for (const k of REGISTER_FIELDS) all[k] = validateRegisterField(k, form[k]);
  return compact(all);
};

/**
 * What Register.jsx sends: the form, trimmed; email lower-cased; country and
 * referral code upper-cased. Empty optional fields go as '' — the web sends
 * them that way and the server treats '' as absent.
 */
export const buildRegisterPayload = (form: RegisterForm): RegisterForm => ({
  ...form,
  email: form.email.trim().toLowerCase(),
  firstName: form.firstName.trim(),
  lastName: form.lastName.trim(),
  phone: form.phone.trim(),
  country: form.country.trim().toUpperCase(),
  referralCode: form.referralCode ? form.referralCode.trim().toUpperCase() : '',
});

/** Register.jsx's success toast — the referral one when a code went with the sign-up. */
export const registerSuccessMessage = (referralCode: string): string =>
  (referralCode
    ? `Account created · referral ${referralCode} applied`
    : 'Account created! A demo account has been added.');

/**
 * The field message Register.jsx puts under a field for a server refusal.
 * A referral refusal carries the server's own wording (it names the reason:
 * unknown code vs blocked referrer); the duplicates use fixed copy.
 */
export const registerServerFieldMessage = (
  field: 'email' | 'phone' | 'referralCode',
  serverMessage: string,
): string => {
  switch (field) {
    case 'email': return 'This email is already registered';
    case 'phone': return 'This phone is already registered with another account';
    default: return serverMessage;
  }
};
