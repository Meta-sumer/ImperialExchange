/**
 * The six-box OTP field's state changes — ForgotPassword.jsx OtpInput, as
 * pure functions over the digit array.
 *
 * The web gets separate keydown, change and paste events. A TextInput gives
 * one text-change event for all three, so the cases are told apart by what
 * the new text looks like:
 *
 *   ''                 the box was cleared           → empty that box
 *   one new digit      typed                         → set it, move right
 *   two or more digits pasted, or the OS filled the   → fill from box 1,
 *                      one-time code (iOS/Android     exactly as the web's
 *                      autofill lands in one box)     onPaste does
 *
 * A box that already holds a digit and gets another reports BOTH (the old
 * one and the new one); that is a single keystroke, not a paste, and the
 * new digit wins — the web gets the same effect by selecting the box's
 * contents on focus.
 *
 * Backspace on an EMPTY box produces no text change at all, so it arrives
 * separately (onKeyPress) and steps back, as the web's keydown handler does.
 */

export const OTP_LENGTH = 6;

export const emptyOtp = (): string[] => Array.from({ length: OTP_LENGTH }, () => '');

export const otpValue = (digits: readonly string[]): string => digits.join('');

export const isOtpComplete = (digits: readonly string[]): boolean =>
  digits.length === OTP_LENGTH && digits.every((d) => d !== '');

export interface OtpChange {
  next: string[];
  /** The box to focus afterwards. */
  focus: number;
}

const last = OTP_LENGTH - 1;

export const applyOtpText = (digits: readonly string[], index: number, raw: string): OtpChange => {
  const d = (raw || '').replace(/\D/g, '');
  const next = digits.slice(0, OTP_LENGTH);
  while (next.length < OTP_LENGTH) next.push('');

  if (!d) {
    next[index] = '';
    return { next, focus: index };
  }

  const current = next[index] ?? '';
  let incoming = d;
  if (current && d.length === 2 && (d[0] === current || d[1] === current)) {
    incoming = d[0] === current ? (d[1] ?? '') : (d[0] ?? '');
  }

  if (incoming.length === 1) {
    next[index] = incoming;
    return { next, focus: Math.min(index + 1, last) };
  }

  // A paste / autofill: the web's onPaste — clear, fill from the start.
  const code = incoming.slice(0, OTP_LENGTH);
  const filled = emptyOtp();
  code.split('').forEach((c, k) => { filled[k] = c; });
  return { next: filled, focus: Math.min(code.length, last) };
};

/** Backspace on an empty box: clear the previous one and step back. Null at the first box. */
export const applyOtpBackspace = (digits: readonly string[], index: number): OtpChange | null => {
  if ((digits[index] ?? '') !== '' || index <= 0) return null;
  const next = digits.slice();
  next[index - 1] = '';
  return { next, focus: index - 1 };
};
