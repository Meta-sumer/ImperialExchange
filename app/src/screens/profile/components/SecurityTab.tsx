import React, { useRef, useState } from 'react';
import { StyleSheet, View, type TextInput } from 'react-native';

import { authApi } from '@/api/auth.api';
import { errorMessage } from '@/api/client';
import { AppText, Button, PasswordInput, toast } from '@/components/ui';
import { PASSWORD_RULES, passwordRulesPass } from '@/screens/auth/logic/password';
import { useTheme } from '@/theme';
import { changePasswordError, confirmMismatch } from '@/utils/profile';

import { ProfileIcon } from './ProfileIcons';
import { SectionCard } from './ProfilePrimitives';

/**
 * Profile.jsx SecurityTab — the password change, and only that: EquityHub
 * has no two-factor sign-in (its server has no /auth/2fa routes, and the
 * login takes no code).
 */
export function SecurityTab(): React.JSX.Element {
  return (
    <View style={styles.stack}>
      <ChangePasswordCard />
    </View>
  );
}

/* ══ Change password — Profile.jsx ChangePasswordCard ════════════════ */

function ChangePasswordCard(): React.JSX.Element {
  const t = useTheme();
  const [cur, setCur] = useState('');
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const newRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  const rulesPass = passwordRulesPass(pwd);
  const match = !!pwd && pwd === confirm;

  const submit = async (): Promise<void> => {
    if (loading) return;
    const invalid = changePasswordError(cur, pwd, confirm);
    if (invalid) { toast.error(invalid); return; }
    setLoading(true);
    try {
      // Sends this device's refresh token: THIS session stays signed in,
      // every other device is signed out (auth.api changePassword).
      await authApi.changePassword(cur, pwd);
      toast.success('Password changed. Other devices have been signed out.');
      setCur(''); setPwd(''); setConfirm('');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <SectionCard icon="lock" title="Password" subtitle="Change your account password.">
      <PasswordInput
        label="Current password"
        value={cur}
        onChangeText={setCur}
        autoComplete="current-password"
        placeholder="Current password"
        returnKeyType="next"
        onSubmitEditing={() => newRef.current?.focus()}
        submitBehavior="submit"
      />
      <PasswordInput
        ref={newRef}
        label="New password"
        value={pwd}
        onChangeText={setPwd}
        autoComplete="new-password"
        placeholder="New password"
        maxLength={128}
        returnKeyType="next"
        onSubmitEditing={() => confirmRef.current?.focus()}
        submitBehavior="submit"
      />

      <View style={styles.rules} accessibilityRole="list">
        {PASSWORD_RULES.map((r) => {
          const ok = r.test(pwd);
          return (
            <View key={r.label} style={styles.rule} accessibilityLabel={`${r.label}${ok ? ', met' : ', not met'}`}>
              <View style={[styles.ruleDot, { backgroundColor: ok ? t.alpha(t.colors.bull, 0.15) : t.colors.bgHover }]}>
                {ok
                  ? <ProfileIcon name="check" size={12} color={t.colors.bull} />
                  : <View style={[styles.pip, { backgroundColor: t.colors.textMuted }]} />}
              </View>
              <AppText variant="small" color={ok ? t.colors.bull : t.colors.textMuted}>{r.label}</AppText>
            </View>
          );
        })}
      </View>

      <PasswordInput
        ref={confirmRef}
        label="Confirm new password"
        value={confirm}
        onChangeText={setConfirm}
        autoComplete="new-password"
        placeholder="Re-enter new password"
        error={confirmMismatch(pwd, confirm) ? 'Passwords do not match' : null}
        returnKeyType="done"
        // The web's Enter-to-submit: its checks and toasts run from here.
        onSubmitEditing={() => { void submit(); }}
      />

      <Button
        title={loading ? 'Updating…' : 'Update password'}
        disabled={loading || !cur || !rulesPass || !match}
        onPress={() => { void submit(); }}
        style={styles.start}
      />
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 20 },
  rules: { gap: 4 },
  rule: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ruleDot: { width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  pip: { width: 4, height: 4, borderRadius: 2 },
  start: { alignSelf: 'flex-start' },
});
