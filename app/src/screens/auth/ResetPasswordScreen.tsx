import React, { useRef, useState } from 'react';
import { StyleSheet, View, type TextInput } from 'react-native';

import { authApi } from '@/api/auth.api';
import { errorMessage } from '@/api/client';
import { AppText, Button, PasswordInput, toast } from '@/components/ui';
import { navigateToPath } from '@/navigation/linking';
import type { AppScreenProps } from '@/navigation/types';
import { useTheme } from '@/theme';

import { goToLogin } from './authNav';
import { AuthCard, AuthCentered, BrandMark, TextLink } from './AuthShell';
import { StatusIcon } from './components/StatusIcon';

/**
 * client/src/pages/ResetPassword.jsx — the emailed reset link
 * (`/reset-password?token=…`), as opposed to ForgotPassword's OTP flow.
 *
 * The web renders it without AuthShell: the brand above a plain card on the
 * page background. It is a public route, so the link works whether or not
 * this device is signed in.
 */
export function ResetPasswordScreen({ navigation, route }: AppScreenProps<'ResetPassword'>): React.JSX.Element {
  const t = useTheme();
  const token = (route.params?.token ?? '').trim();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const confirmRef = useRef<TextInput>(null);

  const submit = async (): Promise<void> => {
    if (loading) return;
    if (password.length < 8) { toast.error('Password must be at least 8 characters'); return; }
    if (password !== confirm) { toast.error('Passwords do not match'); return; }
    setLoading(true);
    try {
      await authApi.confirmPasswordReset(token, password);
      toast.success('Password reset. Please log in.');
      goToLogin(navigation);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCentered testID="reset-password-screen">
      <View style={styles.brand}>
        <BrandMark />
      </View>

      <AuthCard>
        {!token ? (
          <View style={styles.invalid}>
            <StatusIcon kind="alert" />
            <AppText variant="h3" weight="700" align="center" color={t.colors.compatWhite} style={styles.invalidTitle}>
              Invalid reset link
            </AppText>
            <AppText variant="body" align="center" color={t.colors.compatGray400} style={styles.invalidBody}>
              This link is missing a token or has expired. Reset links are valid for 30{' '}minutes.
            </AppText>
            <Button
              title="Request a new link"
              onPress={() => { navigateToPath('/forgot-password'); }}
              style={styles.center}
            />
          </View>
        ) : (
          <>
            <AppText variant="h2" color={t.colors.compatWhite} style={styles.title}>Set a new password</AppText>
            <AppText variant="body" color={t.colors.compatGray400} style={styles.lead}>
              Choose a strong password (8+ characters).
            </AppText>
            <View style={styles.form}>
              <PasswordInput
                label="New password"
                value={password}
                onChangeText={setPassword}
                autoFocus
                autoComplete="new-password"
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => confirmRef.current?.focus()}
              />
              <PasswordInput
                ref={confirmRef}
                label="Confirm password"
                value={confirm}
                onChangeText={setConfirm}
                autoComplete="new-password"
                returnKeyType="go"
                onSubmitEditing={() => { void submit(); }}
              />
              <Button
                title="Reset password"
                loadingTitle="Resetting…"
                loading={loading}
                fullWidth
                onPress={() => { void submit(); }}
              />
            </View>
          </>
        )}

        <View style={styles.back}>
          <TextLink label="Back to login" variant="body" onPress={() => goToLogin(navigation)} />
        </View>
      </AuthCard>
    </AuthCentered>
  );
}

const styles = StyleSheet.create({
  brand: { alignItems: 'center', marginBottom: 32 },
  invalid: { paddingVertical: 16 },
  invalidTitle: { marginBottom: 8 },
  invalidBody: { marginBottom: 16 },
  center: { alignSelf: 'center' },
  title: { marginBottom: 8 },
  lead: { marginBottom: 24 },
  form: { gap: 16 },
  back: { marginTop: 24, alignItems: 'center' },
});
