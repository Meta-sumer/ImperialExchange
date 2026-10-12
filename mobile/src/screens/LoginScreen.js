import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../store/auth';
import { errorMessage } from '../services/api';
import { useColors, radius } from '../theme';
import { Button } from '../components/ui';

export default function LoginScreen() {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const login = useAuth((s) => s.login);
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr('');
    if (!email.trim() || !password) { setErr('Enter your email and password.'); return; }
    setBusy(true);
    try {
      await login(email.trim(), password);
      // On success the auth store sets `user` → RootNavigator swaps to the tabs.
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[styles.wrap, { paddingTop: insets.top + 60 }]} keyboardShouldPersistTaps="handled">
        <Text style={styles.brand}>Frexever</Text>
        <Text style={styles.sub}>Sign in to your trading account</Text>

        <View style={{ height: 28 }} />

        <Text style={styles.label}>Email</Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          placeholderTextColor={c.textMuted}
          autoCapitalize="none"
          keyboardType="email-address"
          autoCorrect={false}
          style={styles.input}
        />

        <Text style={[styles.label, { marginTop: 16 }]}>Password</Text>
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder="••••••••"
          placeholderTextColor={c.textMuted}
          secureTextEntry
          style={styles.input}
          onSubmitEditing={submit}
        />

        {err ? <Text style={styles.err}>{err}</Text> : null}

        <View style={{ height: 24 }} />
        <Button title="Sign in" onPress={submit} loading={busy} />

        <Text style={styles.hint}>
          Customer accounts only. Can't connect? Make sure the backend is running and the
          API IP in src/config.js matches this PC's LAN address.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c) => StyleSheet.create({
  wrap: { paddingHorizontal: 24, paddingBottom: 40, flexGrow: 1 },
  brand: { fontSize: 34, fontWeight: '900', color: c.primary500, letterSpacing: -0.5 },
  sub: { fontSize: 15, color: c.textSecondary, marginTop: 6 },
  label: { fontSize: 13, fontWeight: '700', color: c.textSecondary, marginBottom: 6 },
  input: {
    height: 50, borderWidth: 1, borderColor: c.border, borderRadius: radius.md,
    paddingHorizontal: 14, fontSize: 16, color: c.textPrimary, backgroundColor: c.card,
  },
  err: { color: c.bear, marginTop: 14, fontSize: 13, fontWeight: '600' },
  hint: { color: c.textMuted, fontSize: 12, marginTop: 20, lineHeight: 18 },
});
