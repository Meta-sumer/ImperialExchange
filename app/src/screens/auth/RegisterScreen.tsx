import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type TextInput } from 'react-native';

import { errorMessage } from '@/api/client';
import { registerErrorField } from '@/api/auth.api';
import { AppText, Button, Icon, Input, PasswordInput, Select, toast, type SelectOption } from '@/components/ui';
import type { AppScreenProps } from '@/navigation/types';
import { useAuthStore } from '@/store/auth';
import { useTheme } from '@/theme';

import { AuthCard, AuthShell, BrandMark, TextLink } from './AuthShell';
import { PasswordStrengthMeter } from './components/PasswordMeters';
import { COUNTRY_OPTIONS } from './logic/countries';
import { clearPendingRef, loadPendingRef, normaliseRef, savePendingRef } from './logic/referral';
import {
  REGISTER_FIELDS,
  buildRegisterPayload,
  registerServerFieldMessage,
  registerSuccessMessage,
  sanitize,
  validateRegister,
  validateRegisterField,
  type FieldErrors,
  type RegisterField,
  type RegisterForm,
} from './logic/validation';

const COUNTRY_SELECT: SelectOption[] = COUNTRY_OPTIONS.map((c) => ({ value: c.code, label: c.name }));

const EMPTY_FORM: RegisterForm = {
  email: '',
  password: '',
  firstName: '',
  lastName: '',
  phone: '',
  country: '',
  referralCode: '',
};

/**
 * client/src/pages/Register.jsx — sign-up with a live password meter,
 * per-field sanitising and validation, and partner referral codes.
 *
 * A referral code arrives on the link (`/register?ref=ABC12345`), is
 * remembered until sign-up succeeds (logic/referral), pre-fills the field and
 * shows the "Referral applied" banner. The server REFUSES an unknown or
 * blocked code rather than dropping it, and that refusal is put under the
 * field it belongs to — as are a duplicate email or phone.
 *
 * On success nothing navigates: the new session swaps the navigator to the
 * app, as the web's `navigate('/explore')` does.
 */
export function RegisterScreen({ navigation, route }: AppScreenProps<'Register'>): React.JSX.Element {
  const t = useTheme();
  const register = useAuthStore((s) => s.register);

  const refFromUrl = normaliseRef(route.params?.ref);
  const [storedRef, setStoredRef] = useState('');
  const initialRef = refFromUrl || storedRef;

  const [form, setForm] = useState<RegisterForm>(() => ({ ...EMPTY_FORM, referralCode: refFromUrl }));
  const [errors, setErrors] = useState<FieldErrors<RegisterField>>({});
  const [touched, setTouched] = useState<Partial<Record<RegisterField, boolean>>>({});
  const [loading, setLoading] = useState(false);

  const lastNameRef = useRef<TextInput>(null);
  const emailRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  const referralRef = useRef<TextInput>(null);

  // A code on the link is remembered, and — when it is a new one — put in
  // the field: following a partner's link is an explicit choice of partner.
  useEffect(() => {
    if (!refFromUrl) return;
    void savePendingRef(refFromUrl);
    setForm((f) => (f.referralCode === refFromUrl ? f : { ...f, referralCode: refFromUrl }));
  }, [refFromUrl]);

  // A code remembered from an earlier visit. localStorage is synchronous on
  // the web, so the field starts filled there; here it arrives a moment
  // later, and is applied only while the field is still empty.
  useEffect(() => {
    let alive = true;
    void loadPendingRef().then((code) => {
      if (!alive || !code) return;
      setStoredRef(code);
      setForm((f) => (f.referralCode ? f : { ...f, referralCode: code }));
    });
    return () => { alive = false; };
  }, []);

  const update = (k: RegisterField, clean?: (s: string) => string) => (raw: string): void => {
    const next = clean ? clean(raw) : raw;
    setForm((f) => ({ ...f, [k]: next }));
    // Once a field has been visited, its error clears live as it becomes valid.
    if (touched[k]) setErrors((errs) => ({ ...errs, [k]: validateRegisterField(k, next) ?? undefined }));
  };

  const onBlur = (field: RegisterField) => (): void => {
    setTouched((tt) => ({ ...tt, [field]: true }));
    setErrors((errs) => ({ ...errs, [field]: validateRegisterField(field, form[field]) ?? undefined }));
  };

  const shown = (field: RegisterField): string | null => (touched[field] && errors[field]) || null;

  /** A picker has no blur: choosing is the visit. */
  const onCountry = (code: string): void => {
    setForm((f) => ({ ...f, country: code }));
    setTouched((tt) => ({ ...tt, country: true }));
    setErrors((errs) => ({ ...errs, country: validateRegisterField('country', code) ?? undefined }));
  };

  /** The web's `el.focus(); el.select()`, a beat after the error is shown. */
  const focusAndSelect = (input: React.RefObject<TextInput | null>, value: string): void => {
    setTimeout(() => {
      input.current?.focus();
      input.current?.setSelection(0, value.length);
    }, 100);
  };

  const handleSubmit = async (): Promise<void> => {
    if (loading) return;
    // Every field touched, so every error shows at once.
    const all: Partial<Record<RegisterField, boolean>> = {};
    for (const k of REGISTER_FIELDS) all[k] = true;
    setTouched(all);
    const found = validateRegister(form);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      toast.error('Please fix the highlighted fields');
      return;
    }

    setLoading(true);
    const payload = buildRegisterPayload(form);
    try {
      await register({ ...payload });
      void clearPendingRef();
      toast.success(registerSuccessMessage(payload.referralCode));
    } catch (err) {
      const msg = errorMessage(err);
      const field = registerErrorField(err);
      if (field) {
        setErrors((errs) => ({ ...errs, [field]: registerServerFieldMessage(field, msg) }));
        setTouched((tt) => ({ ...tt, [field]: true }));
      }
      if (field === 'referralCode') {
        toast.error(msg, { duration: 6000 });
        focusAndSelect(referralRef, form.referralCode);
      } else if (field === 'phone') {
        toast.error(msg);
        focusAndSelect(phoneRef, form.phone);
      } else {
        toast.error(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const fromLink = !!initialRef && form.referralCode === initialRef;

  return (
    <AuthShell testID="register-screen">
      <AuthCard>
        <View style={styles.head}>
          <BrandMark />
          <AppText variant="body" tone="secondary" align="center" style={styles.subtitle}>
            Create your trading account
          </AppText>
        </View>

        {initialRef ? (
          <View
            accessibilityRole="summary"
            style={[
              styles.banner,
              {
                borderRadius: t.radius.lg,
                borderColor: t.alpha(t.colors.bull, 0.3),
                backgroundColor: t.alpha(t.colors.bull, 0.1),
              },
            ]}
          >
            <View style={styles.bannerIcon}>
              <Icon name="check" size={18} strokeWidth={2} color={t.colors.bull} />
            </View>
            <View style={styles.flex}>
              <AppText variant="body" weight="700" color={t.colors.bull} style={styles.bannerTitle}>
                Referral applied
              </AppText>
              <AppText variant="caption" tone="secondary" style={styles.bannerBody}>
                You'll be linked to referral code{' '}
                <AppText variant="caption" weight="700" mono style={styles.bannerBody}>{initialRef}</AppText>
                {' '}after sign-up — commissions on your future trades will credit them.
              </AppText>
            </View>
          </View>
        ) : null}

        <View style={styles.form}>
          <View style={styles.row}>
            <Input
              label="First Name *"
              value={form.firstName}
              onChangeText={update('firstName', sanitize.name)}
              onBlur={onBlur('firstName')}
              error={shown('firstName')}
              autoFocus
              autoComplete="given-name"
              textContentType="givenName"
              autoCapitalize="words"
              maxLength={50}
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => lastNameRef.current?.focus()}
              containerStyle={styles.flex}
            />
            <Input
              ref={lastNameRef}
              label="Last Name"
              value={form.lastName}
              onChangeText={update('lastName', sanitize.name)}
              onBlur={onBlur('lastName')}
              error={shown('lastName')}
              autoComplete="family-name"
              textContentType="familyName"
              autoCapitalize="words"
              maxLength={50}
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => emailRef.current?.focus()}
              containerStyle={styles.flex}
            />
          </View>

          <Input
            ref={emailRef}
            label="Email *"
            value={form.email}
            onChangeText={update('email', sanitize.email)}
            onBlur={onBlur('email')}
            error={shown('email')}
            autoComplete="email"
            textContentType="emailAddress"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            maxLength={254}
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => phoneRef.current?.focus()}
          />

          <Input
            ref={phoneRef}
            label="Phone"
            value={form.phone}
            onChangeText={update('phone', sanitize.phone)}
            onBlur={onBlur('phone')}
            error={shown('phone')}
            autoComplete="tel"
            textContentType="telephoneNumber"
            keyboardType="phone-pad"
            placeholder="+91 …"
            maxLength={16}
          />

          {/* A picker, so the value can only ever be a listed ISO code. */}
          <Select
            label="Country *"
            value={form.country || null}
            options={COUNTRY_SELECT}
            onChange={onCountry}
            placeholder="Select country…"
            title="Country"
            error={shown('country')}
          />

          <View>
            <PasswordInput
              label="Password *"
              value={form.password}
              onChangeText={update('password')}
              onBlur={onBlur('password')}
              error={shown('password')}
              maxLength={128}
              autoComplete="new-password"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => referralRef.current?.focus()}
            />
            <PasswordStrengthMeter password={form.password} />
          </View>

          <View>
            <View style={styles.refLabel}>
              <AppText variant="label">Referral Code (Optional)</AppText>
              {fromLink ? (
                <AppText variant="micro" weight="700" color={t.colors.bull} style={styles.fromLink}>
                  · from link
                </AppText>
              ) : null}
            </View>
            <Input
              ref={referralRef}
              value={form.referralCode}
              onChangeText={update('referralCode', sanitize.referralCode)}
              onBlur={onBlur('referralCode')}
              error={shown('referralCode')}
              mono
              tone={fromLink ? 'bull' : undefined}
              placeholder="ABC12345"
              maxLength={16}
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect={false}
              spellCheck={false}
              returnKeyType="go"
              onSubmitEditing={() => { void handleSubmit(); }}
              accessibilityLabel="Referral Code (Optional)"
            />
          </View>

          <Button
            title="Create Account"
            loadingTitle="Creating..."
            loading={loading}
            fullWidth
            onPress={() => { void handleSubmit(); }}
          />
        </View>

        <AppText variant="body" color={t.colors.compatGray400} align="center" style={styles.switch}>
          Already have an account?{' '}
          <TextLink
            label="Sign in"
            variant="body"
            onPress={() => navigation.navigate('Login', undefined, { pop: true })}
          />
        </AppText>
      </AuthCard>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  head: { alignItems: 'center', marginBottom: 28 },
  subtitle: { marginTop: 12 },
  banner: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderWidth: 1, padding: 12, marginBottom: 16 },
  bannerIcon: { marginTop: 2 },
  bannerTitle: { fontSize: 13 },
  bannerBody: { marginTop: 2, fontSize: 11.5, lineHeight: 16 },
  form: { gap: 12 },
  row: { flexDirection: 'row', gap: 12 },
  refLabel: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  fromLink: { marginLeft: 8, letterSpacing: 0.8, textTransform: 'uppercase' },
  switch: { marginTop: 24 },
});
