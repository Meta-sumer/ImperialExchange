import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

import { FillSvg } from '@/components/common/FillSvg';
import { AppText } from '@/components/ui';
import { useTheme } from '@/theme';
import { userCreatedAt, type AuthUser } from '@/types/user';
import { heroName, kycPill, memberSince, profileInitials } from '@/utils/profile';

import { copyText } from './clipboard';
import { ProfileIcon } from './ProfileIcons';
import { Chip, StatusPill } from './ProfilePrimitives';

/** Profile.jsx — the avatar's own gradient, theme-independent. */
const AVATAR_FROM = '#1D4ED8';
const AVATAR_TO = '#4F46E5';

/**
 * Profile.jsx hero: avatar, name, email, the copyable User ID, the status
 * chips (email, KYC, referral code) and "Member since".
 *
 * On a phone the web's `flex-wrap` row puts "Member since" on its own line
 * under the name; it is laid out that way directly here.
 */
export function ProfileHero({ user }: { user: AuthUser | null }): React.JSX.Element {
  const t = useTheme();
  const initials = profileInitials(user);
  const kyc = kycPill(user?.kycStatus);

  return (
    <View
      style={[
        styles.hero,
        { borderColor: t.colors.borderDark, backgroundColor: t.colors.bgCard, borderRadius: t.radius.xxl },
        t.shadow.card,
      ]}
    >
      {/* bg-gradient-to-br from-white via-bg-card to-primary-500/5, plus the
          top-right radial glow (rgba(29,78,216,0.18)). */}
      <FillSvg>
        <Defs>
          <LinearGradient id="profileHeroBg" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={t.colors.surface} />
            <Stop offset="0.5" stopColor={t.colors.bgCard} />
            <Stop offset="1" stopColor={t.colors.primary} stopOpacity={0.05} />
          </LinearGradient>
          <RadialGradient id="profileHeroGlow" cx="100%" cy="0%" r="60%">
            <Stop offset="0" stopColor="#1D4ED8" stopOpacity={0.18} />
            <Stop offset="0.6" stopColor="#1D4ED8" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#profileHeroBg)" />
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#profileHeroGlow)" />
      </FillSvg>

      <View style={styles.row}>
        <View style={styles.avatar} accessibilityLabel={`Avatar ${initials}`}>
          <FillSvg>
            <Defs>
              <LinearGradient id="profileAvatar" x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0" stopColor={AVATAR_FROM} />
                <Stop offset="1" stopColor={AVATAR_TO} />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width="80" height="80" rx="16" ry="16" fill="url(#profileAvatar)" />
          </FillSvg>
          <AppText variant="h1" weight="800" color="#FFFFFF">{initials}</AppText>
        </View>

        <View style={styles.flex}>
          <View style={styles.eyebrow}>
            <View style={[styles.rule, { backgroundColor: t.colors.primary }]} />
            <AppText variant="eyebrow">Account</AppText>
          </View>
          <AppText variant="h1" weight="800" accessibilityRole="header">{heroName(user)}</AppText>
          <AppText variant="body" tone="secondary" numberOfLines={1} style={styles.email}>
            {user?.email || '—'}
          </AppText>
        </View>
      </View>

      {/* Permanent public User ID — prominent + copyable. */}
      {user?.userUid ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy your User ID"
          onPress={() => { void copyText(user.userUid ?? '', 'User ID copied'); }}
          style={({ pressed }) => [
            styles.uid,
            {
              borderRadius: t.radius.xl,
              borderColor: t.alpha(t.colors.primary, pressed ? 0.6 : 0.3),
              backgroundColor: t.alpha(t.colors.primary, pressed ? 0.1 : 0.05),
            },
          ]}
        >
          <AppText variant="micro" tone="muted" weight="700" style={styles.upper}>User ID</AppText>
          <AppText variant="body" weight="800" color={t.colors.primaryText} mono>{user.userUid}</AppText>
          <View style={styles.copy}>
            <ProfileIcon name="copy" size={13} color={t.colors.textMuted} />
            <AppText variant="caption" weight="600" tone="muted">Copy</AppText>
          </View>
        </Pressable>
      ) : null}

      {/* Status chips */}
      <View style={styles.chips}>
        <StatusPill
          active={!!user?.emailVerified}
          activeLabel="Email verified"
          inactiveLabel="Email unverified"
          icon="check"
        />
        <Chip icon="shieldCheck" tone={kyc.tone}>{kyc.label}</Chip>
        {user?.referralCode ? (
          <Chip icon="gift" tone="muted">
            <AppText variant="caption" weight="600" tone="secondary">
              {'Code '}
              <AppText variant="caption" weight="600" color={t.colors.primaryText} mono>{user.referralCode}</AppText>
            </AppText>
          </Chip>
        ) : null}
      </View>

      <View style={styles.since}>
        <AppText variant="micro" tone="muted" weight="700" style={styles.upper}>Member since</AppText>
        <AppText variant="body" weight="700" style={styles.sinceValue}>{memberSince(userCreatedAt(user))}</AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { borderWidth: 1, padding: 24, overflow: 'hidden', gap: 0 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 20 },
  flex: { flex: 1, minWidth: 0 },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 16,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyebrow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  rule: { width: 24, height: 1 },
  email: { marginTop: 4 },
  uid: {
    marginTop: 12,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    paddingLeft: 12,
    paddingRight: 10,
    paddingVertical: 6,
  },
  copy: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  upper: { textTransform: 'uppercase', letterSpacing: 1.5 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 16 },
  since: { marginTop: 16, alignItems: 'flex-end' },
  sinceValue: { marginTop: 4 },
});
