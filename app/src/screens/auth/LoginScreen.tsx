import React, { useRef, useState } from 'react';
import { StyleSheet, View, type TextInput } from 'react-native';

import { errorMessage } from '@/api/client';
import { AppText, Button, Input, PasswordInput, toast } from '@/components/ui';
import type { AppScreenProps } from '@/navigation/types';
import { getAccessToken } from '@/services/tokenStore';
import { useAuthStore } from '@/store/auth';
import { useTheme } from '@/theme';

import { AuthCard, AuthShell, BrandMark, TextLink } from './AuthShell';
import { sanitize, validateLogin, type FieldErrors, type LoginField } from './logic/validation';

/**
 * client/src/pages/Login.jsx — email and password. EquityHub's sign-in asks
 * for nothing else: no second factor, no "Login with <broker>".
 *
 * Where the web does `navigate(from)` after signing in, nothing here
 * navigates: the navigator swaps to the signed-in app when the session is
 * established and takes a protected deep link that was waiting (CONTRACT §3).
 *
 * Validation is the web's, including its timing: a field's error appears
 * once it has been left (blur) or on submit, and is re-checked on the next
 * blur or submit — not on every keystroke.
 */
export function LoginScreen({ navigation }: AppScreenProps<'Login'>): React.JSX.Element {
  const t = useTheme();
  const login = useAuthStore((s) => s.login);
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const storeError = useAuthStore((s) => s.error);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [errors, setErrors] = useState<FieldErrors<LoginField>>({});
  const [touched, setTouched] = useState<Partial<Record<LoginField, boolean>>>({});

  const passwordRef = useRef<TextInput>(null);

  const validate = (): boolean => {
    const next = validateLogin({ email, password });
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const onBlur = (field: LoginField) => (): void => {
    setTouched((tt) => ({ ...tt, [field]: true }));
    validate();
  };

  const shown = (field: LoginField): string | null => (touched[field] && errors[field]) || null;

  const handleSubmit = async (): Promise<void> => {
    if (loading) return;
    setTouched({ email: true, password: true });
    if (!validate()) return;
    setLoading(true);
    try {
      await login(email.trim().toLowerCase(), password);
      toast.success('Welcome back');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // The session survived launch but /auth/me could not be reached (offline,
  // or the server mid-deploy): store/auth kept the tokens and reported why.
  // Offer the retry the store expects rather than making the user sign in
  // again (CONTRACT §8). A failed LOGIN also sets `error`, but never leaves
  // a token behind — that is how the two are told apart.
  const sessionPending = !!storeError && !!getAccessToken();
  const retrySession = async (): Promise<void> => {
    setRetrying(true);
    try { await bootstrap(); } finally { setRetrying(false); }
  };

  return (
    <AuthShell testID="login-screen">
      <AuthCard>
        <View style={styles.head}>
          <BrandMark />
          <AppText variant="body" tone="secondary" align="center" style={styles.subtitle}>
            Sign in to your trading account
          </AppText>
        </View>

        {sessionPending ? (
          <View
            style={[
              styles.notice,
              { borderColor: t.colors.borderDark, backgroundColor: t.alpha(t.colors.bgPanel, 0.6), borderRadius: t.radius.md },
            ]}
          >
            <AppText variant="bodyStrong">Couldn’t restore your session</AppText>
            <AppText variant="small" tone="secondary" style={styles.noticeBody}>{storeError}</AppText>
            <Button title="Retry" variant="secondary" size="sm" loading={retrying} onPress={() => { void retrySession(); }} style={styles.noticeBtn} />
          </View>
        ) : null}

        <View style={styles.form}>
          {/* Email — strict format, lower-cased, no spaces. */}
          <Input
            label="Email"
            value={email}
            onChangeText={(s) => setEmail(sanitize.email(s))}
            onBlur={onBlur('email')}
            error={shown('email')}
            autoFocus
            autoComplete="email"
            textContentType="emailAddress"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            maxLength={254}
            placeholder="you@example.com"
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
            submitBehavior="submit"
          />

          <View>
            <PasswordInput
              ref={passwordRef}
              label="Password"
              value={password}
              onChangeText={setPassword}
              onBlur={onBlur('password')}
              error={shown('password')}
              maxLength={128}
              autoComplete="current-password"
              returnKeyType="go"
              onSubmitEditing={() => { void handleSubmit(); }}
            />
            <View style={styles.forgot}>
              <TextLink label="Forgot password?" onPress={() => navigation.navigate('ForgotPassword')} />
            </View>
          </View>

          <Button
            title="Sign In"
            loadingTitle="Signing in..."
            loading={loading}
            fullWidth
            onPress={() => { void handleSubmit(); }}
          />
        </View>

        <AppText variant="body" color={t.colors.compatGray400} align="center" style={styles.switch}>
          Don't have an account?{' '}
          <TextLink
            label="Create one"
            variant="body"
            onPress={() => navigation.navigate('Register', undefined, { pop: true, merge: true })}
          />
        </AppText>
      </AuthCard>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  head: { alignItems: 'center', marginBottom: 28 },
  subtitle: { marginTop: 12 },
  notice: { borderWidth: 1, padding: 12, marginBottom: 16 },
  noticeBody: { marginTop: 4 },
  noticeBtn: { marginTop: 10, alignSelf: 'flex-start' },
  form: { gap: 16 },
  forgot: { alignItems: 'flex-end', marginTop: 4 },
  switch: { marginTop: 24 },
});
