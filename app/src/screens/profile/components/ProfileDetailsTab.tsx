import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { authApi } from '@/api/auth.api';
import { errorMessage } from '@/api/client';
import { userApi } from '@/api/user.api';
import { AppText, Button, Input, toast } from '@/components/ui';
import { useTheme } from '@/theme';
import { userCountry, type AuthUser } from '@/types/user';
import {
  RESEND_COOLDOWN_S,
  countryName,
  followSavedProfile,
  profileDirty,
  profileFormFrom,
  profileReferrer,
  referredByName,
  resendLabel,
  savedProfileFields,
  type ProfileForm,
} from '@/utils/profile';

import { copyText } from './clipboard';
import { ProfileIcon } from './ProfileIcons';
import { InfoBlock, MiniAction, SectionCard } from './ProfilePrimitives';
import { applyToSignedInUser } from './userPatch';

/**
 * Profile.jsx — ProfileTab: the email and its verification, the
 * referral card, and the personal-information form.
 */
export function ProfileDetailsTab({
  user,
  onUpdate,
}: {
  user: AuthUser | null;
  onUpdate: () => Promise<void>;
}): React.JSX.Element {
  const t = useTheme();
  // Seeded from the user as the tab opens — Profile.jsx.
  const [form, setForm] = useState<ProfileForm>(() => profileFormFrom(user));
  const [saving, setSaving] = useState(false);

  // When the saved profile changes underneath (pull to refresh, the screen's
  // /auth/me re-read), untouched fields follow it, as the web's form does
  // after a page load; fields being edited are kept. See followSavedProfile.
  const saved = profileFormFrom(user);
  const lastSaved = useRef<ProfileForm>(saved);
  useEffect(() => {
    const prev = lastSaved.current;
    const next: ProfileForm = { firstName: saved.firstName, lastName: saved.lastName, phone: saved.phone };
    lastSaved.current = next;
    setForm((f) => followSavedProfile(f, prev, next));
  }, [saved.firstName, saved.lastName, saved.phone]);

  const [resendCooldown, setResendCooldown] = useState(0);
  // One request at a time. The web's button is live until the answer starts
  // the cooldown, and every resend mints a NEW token server-side
  // (authController.resendVerifyEmail), so a double tap mailed two links and
  // the first one the user opened was already dead ("Invalid or expired
  // token"). The ref closes the gap before the re-render.
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  useEffect(() => {
    if (resendCooldown <= 0) return undefined;
    const timer = setInterval(() => setResendCooldown((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  const dirty = profileDirty(form, user);

  const save = async (): Promise<void> => {
    const sent = form;
    setSaving(true);
    try {
      const answer = await userApi.updateProfile(sent);
      toast.success('Profile updated');
      // The saved fields go onto the user held now, so the card reads "All
      // changes saved" even if the re-read below is lost; the rest of the
      // document (the populated `referredBy` the referral card reads) is
      // kept — only /auth/me populates it, hence the re-read.
      if (user) applyToSignedInUser(user.id, { ...savedProfileFields(answer, sent) });
      await onUpdate();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const resendVerify = async (): Promise<void> => {
    if (resendCooldown > 0 || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const { alreadyVerified } = await authApi.resendVerification();
      if (alreadyVerified) {
        // The server sent nothing — the address was verified elsewhere (the
        // link opened on another device). The web still claims an email went
        // out; here the card is brought up to date instead.
        toast.success('Your email is already verified');
        if (user) applyToSignedInUser(user.id, { isEmailVerified: true });
        await onUpdate();
        return;
      }
      toast.success('Verification email sent');
      setResendCooldown(RESEND_COOLDOWN_S);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const ref = profileReferrer(user);

  return (
    <View style={styles.stack}>
      {/* Email + verification */}
      <SectionCard
        icon="mail"
        title="Email address"
        subtitle="Used for sign-in, security alerts, and trade notifications."
      >
        <View style={styles.emailRow}>
          <AppText variant="body" weight="700" mono numberOfLines={1} style={styles.flexShrink}>
            {user?.email}
          </AppText>
          {user?.emailVerified ? (
            <View
              style={[
                styles.verified,
                {
                  backgroundColor: t.alpha(t.colors.bull, 0.1),
                  borderColor: t.alpha(t.colors.bull, 0.2),
                  borderRadius: t.radius.lg,
                },
              ]}
            >
              <ProfileIcon name="check" size={14} color={t.colors.bull} />
              <AppText variant="small" weight="700" color={t.colors.bull}>Verified</AppText>
            </View>
          ) : (
            <Button
              title={resendLabel(resendCooldown)}
              size="sm"
              disabled={resendCooldown > 0}
              loading={sending}
              onPress={() => { void resendVerify(); }}
            />
          )}
        </View>
      </SectionCard>

      {/* Referral */}
      <SectionCard
        icon="gift"
        title="Referral"
        subtitle="Track who invited you and share your code to earn commissions."
      >
        <InfoBlock label="Referred by">
          {ref ? (
            <View>
              <AppText variant="body" weight="600">{referredByName(ref)}</AppText>
              {ref.referralCode ? (
                <AppText variant="caption" tone="muted" mono style={styles.gap2}>
                  {'Code '}
                  <AppText variant="caption" weight="700" color={t.colors.primaryText} mono>{ref.referralCode}</AppText>
                </AppText>
              ) : null}
            </View>
          ) : (
            <AppText variant="body" tone="muted">Signed up directly</AppText>
          )}
        </InfoBlock>
        <InfoBlock label="Your code">
          {user?.referralCode ? (
            <View style={styles.codeRow}>
              <AppText variant="title" weight="800" color={t.colors.primaryText} mono>{user.referralCode}</AppText>
              <MiniAction
                label="Copy"
                accessibilityLabel="Copy referral code"
                onPress={() => { void copyText(user.referralCode ?? '', 'Code copied'); }}
              />
            </View>
          ) : (
            <AppText variant="body" tone="muted">—</AppText>
          )}
        </InfoBlock>
      </SectionCard>

      {/* Personal info */}
      <SectionCard
        icon="user"
        title="Personal information"
        subtitle="Your legal name should match KYC documents."
      >
        <Input
          label="First name"
          value={form.firstName}
          onChangeText={(v) => setForm((f) => ({ ...f, firstName: v }))}
          placeholder="First name"
          autoComplete="given-name"
          textContentType="givenName"
        />
        <Input
          label="Last name"
          value={form.lastName}
          onChangeText={(v) => setForm((f) => ({ ...f, lastName: v }))}
          placeholder="Last name"
          autoComplete="family-name"
          textContentType="familyName"
        />
        <Input
          label="Phone"
          value={form.phone}
          onChangeText={(v) => setForm((f) => ({ ...f, phone: v }))}
          placeholder="+91 98xxxxxxxx"
          keyboardType="phone-pad"
          autoComplete="tel"
          textContentType="telephoneNumber"
        />
        {/* The web's `title="Chosen at registration"` tooltip, shown as the
            hint — a phone has no hover. */}
        <Input
          label="Country"
          value={countryName(userCountry(user))}
          editable={false}
          hint="Chosen at registration"
        />
        <View style={[styles.saveRow, { borderTopColor: t.colors.borderSubtle }]}>
          <AppText variant="caption" weight="600" color={dirty ? t.colors.warn : t.colors.textMuted}>
            {dirty ? 'Unsaved changes' : 'All changes saved'}
          </AppText>
          <Button
            title={saving ? 'Saving…' : 'Save changes'}
            disabled={saving || !dirty}
            onPress={() => { void save(); }}
          />
        </View>
      </SectionCard>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 20 },
  emailRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 },
  flexShrink: { flexShrink: 1 },
  verified: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  gap2: { marginTop: 2 },
  codeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  saveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 12,
    paddingTop: 12,
    borderTopWidth: 1,
  },
});
