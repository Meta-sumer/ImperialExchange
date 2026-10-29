/**
 * Password strength, two ways — because the web has two, on purpose.
 *
 *   PASSWORD_RULES    ForgotPassword.jsx's checklist. ALL must pass before
 *                     the new password can be submitted.
 *   passwordStrength  Register.jsx's four-bar meter. Guidance only; what
 *                     blocks sign-up is v.password(…, { strict: true }).
 *
 * Pure. Tested in authScreens.logic.test.ts.
 */

export interface PasswordRule {
  label: string;
  test: (p: string) => boolean;
}

export const PASSWORD_RULES: readonly PasswordRule[] = [
  { test: (p) => p.length >= 8, label: 'At least 8 characters' },
  { test: (p) => /[A-Z]/.test(p), label: 'One uppercase letter' },
  { test: (p) => /[a-z]/.test(p), label: 'One lowercase letter' },
  { test: (p) => /[0-9]/.test(p), label: 'One number' },
  { test: (p) => /[^A-Za-z0-9]/.test(p), label: 'One special character' },
];

export const passwordRulesPass = (p: string): boolean => PASSWORD_RULES.every((r) => r.test(p));

/** Register.jsx:341 — index by score. */
export const STRENGTH_LABELS = ['Too short', 'Weak', 'Fair', 'Strong', 'Excellent'] as const;

/**
 * The meter's colour per score, by name — Register.jsx:342 uses
 * bg-bear, bg-orange-500, bg-amber-400, bg-lime-500, bg-bull. The screen
 * maps the names to theme colours.
 */
export const STRENGTH_TONES = ['bear', 'orange500', 'amber400', 'lime500', 'bull'] as const;
export type StrengthTone = (typeof STRENGTH_TONES)[number];

export interface PasswordStrength {
  /** 0–4. */
  score: number;
  /** How many of the four bars are filled — equal to the score. */
  filled: number;
  tone: StrengthTone;
  /** The line under the bars. */
  caption: string;
}

/**
 * Register.jsx PasswordStrength, arithmetic unchanged: a point for 8+
 * characters, a point for 12+, and up to two more for character variety
 * (one per class beyond the first). An empty field shows the hint instead
 * of a verdict.
 */
export const passwordStrength = (password: string): PasswordStrength => {
  const len = password.length;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  const score = (len >= 8 ? 1 : 0) + (len >= 12 ? 1 : 0) + Math.min(2, classes - 1);
  const safe = Math.max(0, Math.min(4, score));
  return {
    score: safe,
    filled: safe,
    tone: STRENGTH_TONES[safe] ?? 'bear',
    caption: len === 0 ? 'Min 8 characters · mix letters, numbers, symbols' : (STRENGTH_LABELS[safe] ?? ''),
  };
};
