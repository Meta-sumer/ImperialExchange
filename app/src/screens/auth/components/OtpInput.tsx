import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, TextInput, View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native';

import { useTheme } from '@/theme';

import { applyOtpBackspace, applyOtpText, isOtpComplete, otpValue, OTP_LENGTH } from '../logic/otp';

/**
 * ForgotPassword.jsx OtpInput — six boxes: auto-advance, backspace steps
 * back, paste or the OS's one-time-code fill spreads across all six, and
 * a full code submits itself. The state changes are logic/otp.ts.
 *
 * Every box accepts a whole code (no maxLength of 1), because that is where
 * a paste or an SMS/Keychain autofill lands; the handler keeps one digit per
 * box whatever arrives.
 */
export function OtpInput({
  digits,
  setDigits,
  disabled,
  onComplete,
}: {
  digits: string[];
  setDigits: (next: string[]) => void;
  disabled?: boolean;
  onComplete?: (code: string) => void;
}): React.JSX.Element {
  const t = useTheme();
  const refs = useRef<(TextInput | null)[]>([]);
  const [focused, setFocused] = useState<number | null>(null);

  const focusBox = (i: number): void => { refs.current[i]?.focus(); };

  // A failed verify or a resend clears the code; put the caret back in the
  // first box once the field is usable again, so the next code can be typed
  // straight in.
  const empty = digits.every((d) => d === '');
  useEffect(() => {
    if (!disabled && empty) focusBox(0);
  }, [disabled, empty]);

  const onChangeBox = (i: number, raw: string): void => {
    const { next, focus } = applyOtpText(digits, i, raw);
    setDigits(next);
    if (isOtpComplete(next)) onComplete?.(otpValue(next));
    focusBox(focus);
  };

  const onKeyPress = (i: number, e: NativeSyntheticEvent<TextInputKeyPressEventData>): void => {
    if (e.nativeEvent.key !== 'Backspace') return;
    const change = applyOtpBackspace(digits, i);
    if (!change) return;
    setDigits(change.next);
    focusBox(change.focus);
  };

  return (
    <View style={styles.row}>
      {Array.from({ length: OTP_LENGTH }, (_, i) => (
        <TextInput
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          value={digits[i] ?? ''}
          editable={!disabled}
          autoFocus={i === 0}
          keyboardType="number-pad"
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          textContentType={i === 0 ? 'oneTimeCode' : 'none'}
          selectTextOnFocus
          caretHidden
          accessibilityLabel={`Digit ${i + 1}`}
          onChangeText={(raw) => onChangeBox(i, raw)}
          onKeyPress={(e) => onKeyPress(i, e)}
          onFocus={() => setFocused(i)}
          onBlur={() => setFocused((f) => (f === i ? null : f))}
          selectionColor={t.brand.tealAccent}
          style={[
            styles.box,
            {
              borderRadius: t.radius.md,
              // focus:border-teal-accent
              borderColor: focused === i ? t.brand.tealAccent : t.colors.borderDark,
              backgroundColor: t.colors.bgPanel,
              color: t.colors.textPrimary,
              opacity: disabled ? 0.5 : 1,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  box: {
    flex: 1,
    maxWidth: 48,
    height: 56,
    borderWidth: 1,
    textAlign: 'center',
    fontSize: 20,
    fontWeight: '700',
    padding: 0,
  },
});
