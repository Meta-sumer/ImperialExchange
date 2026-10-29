import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { authApi, isResetSessionExpired } from '@/api/auth.api';
import { errorMessage } from '@/api/client';
import { AppText, Button, Input, PasswordInput, toast } from '@/components/ui';
import type { AppScreenProps } from '@/navigation/types';
import { useTheme } from '@/theme';

import { goToLogin } from './authNav';
import { AuthCard, AuthShell, BrandMark, TextLink } from './AuthShell';
import { OtpInput } from './components/OtpInput';
import { PasswordRulesList } from './components/PasswordMeters';
import { StatusIcon } from './components/StatusIcon';
import { emptyOtp, otpValue, OTP_LENGTH } from './logic/otp';
import { passwordRulesPass } from './logic/password';
import { sanitize, v } from './logic/validation';

type Step = 'email' | 'otp' | 'password' | 'done';

/** Seconds before "Resend code" comes back — the server's own cooldown is 60s too. */
const RESEND_COOLDOWN = 60;
/** ForgotPassword.jsx: the "done" card redirects after 1.8s. */
const DONE_REDIRECT_MS = 1800;

/**
 * client/src/pages/ForgotPassword.jsx — the email-OTP reset, in three steps:
 *
 *   1. Email    → POST /auth/forgot-password   (same answer whether or not
 *                                               the account exists)
 *   2. Code     → POST /auth/verify-reset-otp  (a short-lived reset ticket)
 *   3. Password → POST /auth/reset-password    (ticket + new password)
 *
 * then back to Login. A ticket the server no longer accepts sends the user
 * back to step 1, as on the web.
 */
export function ForgotPasswordScreen({ navigation }: AppScreenProps<'ForgotPassword'>): React.JSX.Element {
  const [step, setStep] = useState<Step>('email');
  const [loading, setLoading] = useState(false);

  const [email, setEmail] = useState('');
  const [emailErr, setEmailErr] = useState<string | null>(null);

  const [digits, setDigits] = useState<string[]>(emptyOtp);
  const otp = otpValue(digits);
  const [cooldown, setCooldown] = useState(0);

  const [resetToken, setResetToken] = useState('');
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');

  const rulesPass = passwordRulesPass(pwd);
  const pwdMatch = !!pwd && pwd === confirm;

  // Resend cooldown ticker.
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  // "Redirecting you to login…" — and cancelled if the user leaves first.
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (doneTimer.current) clearTimeout(doneTimer.current); }, []);

  const toLogin = (): void => {
    if (doneTimer.current) clearTimeout(doneTimer.current);
    doneTimer.current = null;
    goToLogin(navigation);
  };

  /* ── Step 1: request a code ── */
  const submitEmail = async (): Promise<void> => {
    if (loading) return;
    const err = v.email(email);
    setEmailErr(err);
    if (err) return;
    setLoading(true);
    try {
      const message = await authApi.forgotPassword(email);
      toast.success(message);
      setDigits(emptyOtp());
      setStep('otp');
      setCooldown(RESEND_COOLDOWN);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  /* Resend — step 1 again. */
  const resend = async (): Promise<void> => {
    if (cooldown > 0 || loading) return;
    setLoading(true);
    try {
      await authApi.forgotPassword(email);
      setDigits(emptyOtp());
      setCooldown(RESEND_COOLDOWN);
      toast.success('A new code has been sent.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  /* ── Step 2: verify the code ── */
  const verify = async (code: string = otp): Promise<void> => {
    if (code.length !== OTP_LENGTH || loading) return;
    setLoading(true);
    try {
      const ticket = await authApi.verifyResetOtp(email, code);
      setResetToken(ticket);
      setStep('password');
    } catch (e) {
      setDigits(emptyOtp());
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  /* ── Step 3: the new password ── */
  const submitPassword = async (): Promise<void> => {
    if (loading) return;
    if (!rulesPass) { toast.error('Password does not meet all requirements.'); return; }
    if (!pwdMatch) { toast.error('Passwords do not match.'); return; }
    setLoading(true);
    try {
      await authApi.resetPasswordWithOtp(resetToken, pwd);
      setStep('done');
      toast.success('Password updated successfully.');
      doneTimer.current = setTimeout(toLogin, DONE_REDIRECT_MS);
    } catch (e) {
      toast.error(errorMessage(e));
      // Ticket expired or never verified: start again from the email.
      if (isResetSessionExpired(e)) {
        setStep('email');
        setDigits(emptyOtp());
        setResetToken('');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell testID="forgot-password-screen">
      <AuthCard>
        <View style={styles.head}>
          <BrandMark />
        </View>

        {step !== 'done' ? <Stepper step={step} /> : null}

        {step === 'email' ? (
          <>
            <AppText variant="h2" style={styles.title}>Forgot password?</AppText>
            <AppText variant="body" tone="secondary" style={styles.lead}>
              Enter your registered email and we'll send you a 6-digit verification code.
            </AppText>
            <View style={styles.form}>
              <Input
                label="Email"
                value={email}
                onChangeText={(s) => { setEmail(sanitize.email(s)); if (emailErr) setEmailErr(null); }}
                error={emailErr}
                autoFocus
                autoComplete="email"
                textContentType="emailAddress"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                placeholder="you@example.com"
                returnKeyType="send"
                onSubmitEditing={() => { void submitEmail(); }}
              />
              <Button title="Send code" loadingTitle="Sending…" loading={loading} fullWidth onPress={() => { void submitEmail(); }} />
            </View>
          </>
        ) : null}

        {step === 'otp' ? (
          <>
            <AppText variant="h2" style={styles.title}>Enter verification code</AppText>
            <AppText variant="body" tone="secondary" style={styles.lead}>
              If an account exists, a 6-digit code was sent to{' '}
              <AppText variant="bodyStrong">{email}</AppText>. It expires in 10 minutes.
            </AppText>
            <View style={styles.otpForm}>
              <OtpInput digits={digits} setDigits={setDigits} disabled={loading} onComplete={(code) => { void verify(code); }} />

              <AppText variant="body" tone="secondary" align="center">
                Didn't get it?{' '}
                {cooldown > 0 ? (
                  <AppText variant="body" tone="muted">Resend in {cooldown}s</AppText>
                ) : (
                  <TextLink label="Resend code" variant="body" weight="600" disabled={loading} onPress={() => { void resend(); }} />
                )}
              </AppText>

              <Button
                title="Verify code"
                loadingTitle="Verifying…"
                loading={loading}
                disabled={otp.length !== OTP_LENGTH}
                fullWidth
                onPress={() => { void verify(); }}
              />

              <AppText
                variant="small"
                tone="muted"
                align="center"
                accessibilityRole="button"
                suppressHighlighting
                onPress={() => { setStep('email'); setDigits(emptyOtp()); }}
              >
                ← Change email
              </AppText>
            </View>
          </>
        ) : null}

        {step === 'password' ? (
          <>
            <AppText variant="h2" style={styles.title}>Set a new password</AppText>
            <AppText variant="body" tone="secondary" style={styles.lead}>
              Choose a strong password you haven't used before.
            </AppText>
            <View style={styles.form}>
              <PasswordInput
                label="New password"
                value={pwd}
                onChangeText={setPwd}
                autoComplete="new-password"
                autoFocus
                maxLength={128}
                placeholder="New password"
              />

              <PasswordRulesList password={pwd} />

              <PasswordInput
                label="Confirm password"
                value={confirm}
                onChangeText={setConfirm}
                autoComplete="new-password"
                maxLength={128}
                placeholder="Re-enter password"
                error={confirm && !pwdMatch ? 'Passwords do not match' : null}
                returnKeyType="go"
                onSubmitEditing={() => { void submitPassword(); }}
              />

              <Button
                title="Update password"
                loadingTitle="Updating…"
                loading={loading}
                disabled={!rulesPass || !pwdMatch}
                fullWidth
                onPress={() => { void submitPassword(); }}
              />
            </View>
          </>
        ) : null}

        {step === 'done' ? (
          <View style={styles.done}>
            <StatusIcon kind="success" />
            <AppText variant="h3" weight="700" align="center" style={styles.doneTitle}>Password updated</AppText>
            <AppText variant="body" tone="secondary" align="center">Redirecting you to login…</AppText>
            <Button title="Go to login" fullWidth onPress={toLogin} style={styles.doneBtn} />
          </View>
        ) : null}

        {step !== 'done' ? (
          <View style={styles.back}>
            <TextLink label="Back to login" variant="body" onPress={() => goToLogin(navigation)} />
          </View>
        ) : null}
      </AuthCard>
    </AuthShell>
  );
}

/** ForgotPassword.jsx Stepper — three bars, the reached ones long and blue. */
function Stepper({ step }: { step: Step }): React.JSX.Element {
  const t = useTheme();
  const order: Step[] = ['email', 'otp', 'password'];
  const idx = order.indexOf(step);
  return (
    <View
      style={styles.stepper}
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${idx + 1} of ${order.length}`}
    >
      {order.map((s, i) => (
        <View
          key={s}
          style={[
            styles.stepBar,
            i <= idx
              ? { width: 32, backgroundColor: t.brand.tealAccent }
              : { width: 16, backgroundColor: t.colors.borderDark },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { alignItems: 'center', marginBottom: 24 },
  stepper: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, marginBottom: 24 },
  stepBar: { height: 6, borderRadius: 3 },
  title: { marginBottom: 6 },
  lead: { marginBottom: 24 },
  form: { gap: 16 },
  otpForm: { gap: 20 },
  done: { paddingVertical: 16 },
  doneTitle: { marginBottom: 8 },
  doneBtn: { marginTop: 20 },
  back: { marginTop: 24, alignItems: 'center' },
});
