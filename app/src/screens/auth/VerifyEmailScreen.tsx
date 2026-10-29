import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { authApi } from '@/api/auth.api';
import { AppText, Button } from '@/components/ui';
import { navigateToPath } from '@/navigation/linking';
import type { AppScreenProps } from '@/navigation/types';
import { useAuthStore } from '@/store/auth';
import { useTheme } from '@/theme';

import { goToLogin } from './authNav';
import { AuthCard, AuthCentered, BrandMark } from './AuthShell';
import { StatusIcon } from './components/StatusIcon';
import { serverMessage } from './logic/errors';

type Status = 'verifying' | 'success' | 'error';

/**
 * client/src/pages/VerifyEmail.jsx — the link in the verification email
 * (`/verify-email?token=…`). Verifies on arrival; the user does nothing.
 *
 * Public on purpose: the email is often opened on a device that is already
 * signed in, and just as often on one that is not. "Go to Dashboard" and
 * "Resend email" (which lives in Profile, as on the web) go through the web
 * paths, so signed out they land on Login and continue there after sign-in.
 */
export function VerifyEmailScreen({ navigation, route }: AppScreenProps<'VerifyEmail'>): React.JSX.Element {
  const t = useTheme();
  const token = (route.params?.token ?? '').trim();
  const [status, setStatus] = useState<Status>('verifying');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMsg('Missing verification token in URL.');
      return undefined;
    }
    let alive = true;
    setStatus('verifying');
    void (async () => {
      try {
        await authApi.verifyEmail(token);
        if (!alive) return;
        setStatus('success');
        // The web picks the new state up on its next page load. Here the
        // signed-in user object would keep saying "unverified" until the next
        // launch, so re-read it now. Silent on failure (store/auth).
        const auth = useAuthStore.getState();
        if (auth.status === 'authenticated') void auth.refreshUser();
      } catch (err) {
        if (!alive) return;
        setStatus('error');
        setMsg(serverMessage(err, 'Verification failed'));
      }
    })();
    return () => { alive = false; };
  }, [token]);

  return (
    <AuthCentered testID="verify-email-screen">
      <AuthCard style={styles.card}>
        <View style={styles.brand}>
          <BrandMark wordmark={false} />
        </View>

        {status === 'verifying' ? (
          <>
            <StatusIcon kind="working" />
            <AppText variant="body" align="center" color={t.colors.compatGray300}>Verifying your email…</AppText>
          </>
        ) : null}

        {status === 'success' ? (
          <>
            <StatusIcon kind="success" />
            <AppText variant="h2" align="center" color={t.colors.compatWhite} style={styles.title}>Email verified!</AppText>
            <AppText variant="body" align="center" color={t.colors.compatGray400} style={styles.body}>
              Your account is now fully activated.
            </AppText>
            <Button title="Go to Dashboard" onPress={() => { navigateToPath('/dashboard'); }} style={styles.center} />
          </>
        ) : null}

        {status === 'error' ? (
          <>
            <StatusIcon kind="error" />
            <AppText variant="h2" align="center" color={t.colors.compatWhite} style={styles.title}>Verification failed</AppText>
            <AppText variant="body" align="center" color={t.colors.compatGray400} style={styles.body}>{msg}</AppText>
            <View style={styles.actions}>
              <Button title="Back to login" variant="secondary" onPress={() => goToLogin(navigation)} />
              <Button title="Resend email" onPress={() => { navigateToPath('/profile'); }} />
            </View>
          </>
        ) : null}
      </AuthCard>
    </AuthCentered>
  );
}

const styles = StyleSheet.create({
  card: { alignItems: 'stretch' },
  brand: { alignItems: 'center', marginBottom: 24 },
  title: { marginBottom: 8 },
  body: { marginBottom: 16 },
  center: { alignSelf: 'center' },
  actions: { flexDirection: 'row', justifyContent: 'center', gap: 8, flexWrap: 'wrap' },
});
