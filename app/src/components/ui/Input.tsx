import React, { forwardRef, useState, type ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Icon } from './Icon';

/**
 * A text field, from index.css `.input` + `.label`, with PasswordInput.jsx's
 * show/hide toggle built in.
 *
 *   .input  w-full px-3 py-2.5 bg-white border border-border-dark rounded-lg
 *           text-sm text-text-primary placeholder-text-muted
 *           focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20
 *   .label  block text-xs text-text-secondary mb-1.5 uppercase tracking-wider
 *
 * The focus ring is drawn as an outer 2px border in primary/20, with a
 * matching negative margin so focusing does not shift the layout.
 *
 * `secure` makes it a password field with the eye toggle. On the web the
 * toggle is `tabIndex={-1}`, out of the keyboard order; a screen-reader user
 * on a phone still needs it, so it is labelled with the web's own
 * aria-labels instead — "Show password" / "Hide password".
 */
export interface InputProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  /** Error text under the field; also turns the border bear-red. */
  error?: string | null;
  /** Muted help text under the field, when there is no error. */
  hint?: string;
  secure?: boolean;
  left?: ReactNode;
  right?: ReactNode;
  /** `.font-mono` — codes, OTPs, referral codes. */
  mono?: boolean;
  /**
   * A confirmed-good value, tinted green: Register.jsx's referral field when
   * the code came from the link (`bg-bull/5 border-bull/40`). An error or
   * focus still wins the border, as the web's later classes do.
   */
  tone?: 'bull';
  containerStyle?: StyleProp<ViewStyle>;
  inputStyle?: TextInputProps['style'];
}

export const Input = forwardRef<TextInput, InputProps>(function Input(
  {
    label,
    error,
    hint,
    secure = false,
    left,
    right,
    mono,
    tone,
    containerStyle,
    inputStyle,
    editable = true,
    onFocus,
    onBlur,
    multiline,
    ...rest
  },
  ref,
) {
  const t = useTheme();
  const [focused, setFocused] = useState(false);
  const [show, setShow] = useState(false);
  const invalid = !!error;

  const bull = tone === 'bull' && !invalid;
  const borderColor = invalid
    ? t.colors.bear
    : focused
      ? t.colors.primary
      : bull ? t.alpha(t.colors.bull, 0.4) : t.colors.borderDark;
  const ringColor = focused ? t.alpha(invalid ? t.colors.bear : t.colors.primary, 0.2) : 'transparent';

  return (
    <View style={containerStyle}>
      {label ? <AppText variant="label" style={styles.label}>{label}</AppText> : null}
      <View style={[styles.ring, { borderColor: ringColor, borderRadius: t.radius.lg + 2 }]}>
        <View
          style={[
            styles.field,
            {
              backgroundColor: bull ? t.alpha(t.colors.bull, 0.05) : t.colors.inputBg,
              borderColor,
              borderRadius: t.radius.lg,
              opacity: editable ? 1 : 0.6,
              alignItems: multiline ? 'flex-start' : 'center',
            },
          ]}
        >
          {left ? <View style={styles.side}>{left}</View> : null}
          <TextInput
            ref={ref}
            {...rest}
            multiline={multiline}
            editable={editable}
            secureTextEntry={secure && !show}
            placeholderTextColor={t.colors.textMuted}
            selectionColor={t.colors.primary}
            aria-invalid={invalid}
            onFocus={(e) => { setFocused(true); onFocus?.(e); }}
            onBlur={(e) => { setFocused(false); onBlur?.(e); }}
            style={[
              styles.input,
              {
                color: t.colors.textPrimary,
                fontSize: t.text.sm.fontSize,
                fontFamily: mono ? t.font.mono : t.font.sans,
                minHeight: multiline ? 88 : undefined,
                textAlignVertical: multiline ? 'top' : 'center',
              },
              mono ? styles.mono : null,
              inputStyle,
            ]}
          />
          {secure ? (
            <Pressable
              onPress={() => setShow((s) => !s)}
              accessibilityRole="button"
              accessibilityLabel={show ? 'Hide password' : 'Show password'}
              hitSlop={8}
              style={styles.eye}
            >
              <Icon name={show ? 'eyeOff' : 'eye'} size={16} color={t.colors.textMuted} strokeWidth={2} />
            </Pressable>
          ) : null}
          {right ? <View style={styles.side}>{right}</View> : null}
        </View>
      </View>
      {error ? (
        <AppText variant="small" tone="bear" style={styles.below}>{error}</AppText>
      ) : hint ? (
        <AppText variant="small" tone="muted" style={styles.below}>{hint}</AppText>
      ) : null}
    </View>
  );
});

/**
 * PasswordInput.jsx — an Input with the eye toggle, autocomplete defaulting
 * to the current password as on the web. Pass `autoComplete="new-password"`
 * on Register / Reset so the OS offers to generate one.
 */
export const PasswordInput = forwardRef<TextInput, Omit<InputProps, 'secure'>>(function PasswordInput(
  { autoComplete = 'current-password', ...rest },
  ref,
) {
  return (
    <Input
      ref={ref}
      secure
      autoCapitalize="none"
      autoCorrect={false}
      autoComplete={autoComplete}
      textContentType={autoComplete === 'new-password' ? 'newPassword' : 'password'}
      {...rest}
    />
  );
});

const styles = StyleSheet.create({
  label: { marginBottom: 6 },
  ring: { borderWidth: 2, margin: -2 },
  field: { flexDirection: 'row', borderWidth: 1, paddingHorizontal: 12 },
  input: { flex: 1, paddingVertical: 10, minHeight: 42 },
  mono: { letterSpacing: 1 },
  side: { marginHorizontal: 4 },
  eye: { padding: 6, marginRight: -6 },
  below: { marginTop: 4 },
});
