import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Image, Alert, Modal, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, errorMessage, tokens } from '../services/api';
import { pickImageBase64 } from '../services/imagePicker';
import * as Clipboard from 'expo-clipboard';
import { useColors, radius } from '../theme';
import { Button, Pill, Loader } from '../components/ui';
import { useAuth } from '../store/auth';

/**
 * ProfileScreen — native 1:1 port of the web client's Profile page
 * (client/src/pages/Profile.jsx). Mirrors it section-for-section:
 *   • gradient-style hero (avatar · name/email · copyable User ID · status
 *     pills: email / KYC / 2FA / referral · member-since)
 *   • tab strip → Profile · KYC Verification · Security · Active Sessions
 *   • Profile tab   — email + resend-verification · referral · personal info
 *   • KYC tab       — status banner · document upload (pickImageBase64) · list
 *   • Security tab  — change password (rules checklist) · 2FA setup/disable
 *   • Sessions tab  — active device list + revoke
 *
 * Same backend endpoints the web calls. Tailwind → makeStyles(c)+useColors();
 * <select> → pills; <Link>/toast/confirm/prompt → navigation/Alert/Modal.
 * All presentational helpers receive { styles, c } via props (no module `c`).
 */

const MONO = Platform.select({ ios: 'Courier', android: 'monospace', default: 'monospace' });

const TABS = [
  { id: 'profile',  label: 'Profile',          icon: 'person-outline' },
  { id: 'kyc',      label: 'KYC Verification',  icon: 'shield-checkmark-outline' },
  { id: 'security', label: 'Security',          icon: 'lock-closed-outline' },
  { id: 'devices',  label: 'Active Sessions',   icon: 'desktop-outline' },
];

// Password policy — mirrors the web checklist (and the backend util).
const PASSWORD_RULES = [
  { test: (p) => p.length >= 8,          label: 'At least 8 characters' },
  { test: (p) => /[A-Z]/.test(p),        label: 'One uppercase letter' },
  { test: (p) => /[a-z]/.test(p),        label: 'One lowercase letter' },
  { test: (p) => /[0-9]/.test(p),        label: 'One number' },
  { test: (p) => /[^A-Za-z0-9]/.test(p), label: 'One special character' },
];

// KYC document types — the web's <select> options, as pills.
const DOC_TYPES = [
  { id: 'ID_FRONT',      label: 'ID · Front' },
  { id: 'ID_BACK',       label: 'ID · Back' },
  { id: 'SELFIE',        label: 'Selfie with ID' },
  { id: 'ADDRESS_PROOF', label: 'Address proof' },
];

const toneFor = (s) => (s === 'APPROVED' ? 'bull' : s === 'REJECTED' ? 'bear' : 'warn');

// Friendly country name from an ISO-2 code (e.g. "IN" → "India"). Guards
// Intl.DisplayNames (not present on every RN engine) and falls back to raw.
const countryName = (code) => {
  if (!code) return '—';
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' });
    return dn.of(String(code).toUpperCase()) || code;
  } catch {
    return code;
  }
};

// Copy a value to the clipboard (expo-clipboard) + a brief confirmation.
// Falls back to showing the value in an Alert if the copy fails. Pure helper.
const showValue = async (label, value) => {
  if (value == null || value === '') return;
  try { await Clipboard.setStringAsync(String(value)); Alert.alert(label, 'Copied to clipboard.'); }
  catch { Alert.alert(label, String(value)); }
};

// ── Screen ──────────────────────────────────────────────────────────────
export default function ProfileScreen({ navigation }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const { user, logout } = useAuth();
  const [tab, setTab] = useState('profile');

  // Web uses the auth store's refreshUser(); the mobile store has none, so we
  // refetch /auth/me and push it into the same zustand store.
  const refreshUser = useCallback(async () => {
    try {
      const { data } = await api.get('/auth/me');
      if (data?.data) useAuth.setState({ user: data.data });
    } catch { /* ignore — keep last-known user */ }
  }, []);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Hero user={user} styles={styles} c={c} />

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabStrip}>
        {TABS.map((t) => {
          const on = tab === t.id;
          return (
            <TouchableOpacity key={t.id} activeOpacity={0.85} onPress={() => setTab(t.id)} style={[styles.tabBtn, on && styles.tabBtnOn]}>
              <Ionicons name={t.icon} size={15} color={on ? c.white : c.textSecondary} />
              <Text style={[styles.tabTxt, on && styles.tabTxtOn]}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {tab === 'profile'  && <ProfileTab  user={user} refreshUser={refreshUser} styles={styles} c={c} />}
      {tab === 'kyc'      && <KycTab      user={user} refreshUser={refreshUser} styles={styles} c={c} />}
      {tab === 'security' && <SecurityTab user={user} refreshUser={refreshUser} styles={styles} c={c} />}
      {tab === 'devices'  && <SessionsTab styles={styles} c={c} />}

      <Button title="Log out" variant="danger" onPress={logout} style={{ marginTop: 4 }} />
      <View style={{ height: 12 }} />
    </ScrollView>
  );
}

// ── Hero ────────────────────────────────────────────────────────────────
function Hero({ user, styles, c }) {
  const f = (user?.firstName || '').trim();
  const l = (user?.lastName || '').trim();
  const name = (f || l) ? `${f} ${l}`.trim() : 'Welcome back';
  const initials = (f || l)
    ? `${f[0] || ''}${l[0] || ''}`.toUpperCase()
    : (user?.email || '?')[0].toUpperCase();
  const memberSince = user?.createdAt
    ? new Date(user.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short' })
    : '—';

  const kyc = user?.kycStatus || 'NOT_SUBMITTED';
  const kycMeta = {
    APPROVED:      ['bull',  'KYC verified'],
    PENDING:       ['warn',  'KYC pending'],
    REJECTED:      ['bear',  'KYC rejected'],
    NOT_SUBMITTED: ['muted', 'KYC not started'],
  }[kyc] || ['muted', 'KYC not started'];

  return (
    <View style={styles.hero}>
      <View style={styles.heroRow}>
        <View style={styles.avatar}><Text style={styles.avatarTxt}>{initials}</Text></View>

        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.eyebrow}>
            <View style={styles.eyebrowLine} />
            <Text style={styles.eyebrowTxt}>ACCOUNT</Text>
          </View>
          <Text style={styles.heroName} numberOfLines={1}>{name}</Text>
          <Text style={styles.heroEmail} numberOfLines={1}>{user?.email || '—'}</Text>

          {user?.userUid ? (
            <TouchableOpacity activeOpacity={0.7} onPress={() => showValue('User ID', user.userUid)} style={styles.uidChip}>
              <Text style={styles.uidLabel}>USER ID</Text>
              <Text style={styles.uidValue}>{user.userUid}</Text>
              <Ionicons name="copy-outline" size={13} color={c.primary500} />
            </TouchableOpacity>
          ) : null}

          <View style={styles.pillsWrap}>
            <TonePill
              icon={user?.isEmailVerified ? 'checkmark-circle-outline' : 'close-circle-outline'}
              label={user?.isEmailVerified ? 'Email verified' : 'Email unverified'}
              tone={user?.isEmailVerified ? 'bull' : 'bear'}
              styles={styles} c={c}
            />
            <TonePill icon="shield-checkmark-outline" label={kycMeta[1]} tone={kycMeta[0]} styles={styles} c={c} />
            <TonePill
              icon="lock-closed-outline"
              label={user?.twoFactorEnabled ? '2FA on' : '2FA off'}
              tone={user?.twoFactorEnabled ? 'bull' : 'bear'}
              styles={styles} c={c}
            />
            {user?.referralCode ? (
              <TonePill icon="gift-outline" label={`Code ${user.referralCode}`} tone="muted" styles={styles} c={c} />
            ) : null}
          </View>
        </View>

        <View style={styles.memberCol}>
          <Text style={styles.memberCap}>MEMBER SINCE</Text>
          <Text style={styles.memberVal}>{memberSince}</Text>
        </View>
      </View>
    </View>
  );
}

function TonePill({ icon, label, tone, styles, c }) {
  const fg = { bull: c.bull, bear: c.bear, warn: c.warn, muted: c.textMuted }[tone] || c.textMuted;
  const bg = { bull: c.bullSoft, bear: c.bearSoft, warn: c.warnSoft, muted: c.hover }[tone] || c.hover;
  return (
    <View style={[styles.tonePill, { backgroundColor: bg, borderColor: fg + '40' }]}>
      <Ionicons name={icon} size={12} color={fg} />
      <Text style={[styles.tonePillTxt, { color: fg }]}>{label}</Text>
    </View>
  );
}

// ── Shared primitives (receive styles / c via props) ──────────────────────
function SectionCard({ icon, title, subtitle, action, children, padded = true, styles, c }) {
  return (
    <View style={styles.sc}>
      <View style={styles.scHead}>
        {icon ? <View style={styles.scIcon}><Ionicons name={icon} size={16} color={c.primary500} /></View> : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.scTitle}>{title}</Text>
          {subtitle ? <Text style={styles.scSub}>{subtitle}</Text> : null}
        </View>
        {action ? <View>{action}</View> : null}
      </View>
      <View style={padded ? styles.scBody : null}>{children}</View>
    </View>
  );
}

function Field({ label, children, styles }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function InfoBlock({ label, children, styles }) {
  return (
    <View style={styles.infoBlock}>
      <Text style={styles.infoLabel}>{label}</Text>
      <View style={{ marginTop: 4 }}>{children}</View>
    </View>
  );
}

function SmallBtn({ label, tone = 'primary', onPress, disabled, styles, c }) {
  const bg = tone === 'bear' ? c.bear : c.primary500;
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress} disabled={disabled} style={[styles.smallBtn, { backgroundColor: bg, opacity: disabled ? 0.5 : 1 }]}>
      <Text style={styles.smallBtnTxt}>{label}</Text>
    </TouchableOpacity>
  );
}

function CopyTag({ label, onPress, styles }) {
  return (
    <TouchableOpacity activeOpacity={0.7} onPress={onPress} style={styles.copyTag}>
      <Text style={styles.copyTagTxt}>{label}</Text>
    </TouchableOpacity>
  );
}

function PwInput({ value, onChangeText, placeholder, styles, c }) {
  const [show, setShow] = useState(false);
  return (
    <View style={styles.pwWrap}>
      <TextInput
        style={styles.pwInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={c.textMuted}
        secureTextEntry={!show}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TouchableOpacity onPress={() => setShow((s) => !s)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={styles.pwEye}>
        <Ionicons name={show ? 'eye-off-outline' : 'eye-outline'} size={18} color={c.textMuted} />
      </TouchableOpacity>
    </View>
  );
}

// ── PROFILE tab ───────────────────────────────────────────────────────────
function ProfileTab({ user, refreshUser, styles, c }) {
  const [form, setForm] = useState({
    firstName: user?.firstName || '',
    lastName: user?.lastName || '',
    phone: user?.phone || '',
  });
  const [saving, setSaving] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    if (resendCooldown <= 0) return undefined;
    const t = setInterval(() => setResendCooldown((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [resendCooldown]);

  const dirty =
    form.firstName !== (user?.firstName || '') ||
    form.lastName  !== (user?.lastName  || '') ||
    form.phone     !== (user?.phone     || '');

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/user/profile', form);
      await refreshUser();
      Alert.alert('Saved', 'Profile updated.');
    } catch (e) { Alert.alert('Error', errorMessage(e)); }
    finally { setSaving(false); }
  };

  const resendVerify = async () => {
    if (resendCooldown > 0) return;
    try {
      await api.post('/auth/resend-verification');
      setResendCooldown(30);
      Alert.alert('Sent', 'Verification email sent.');
    } catch (e) { Alert.alert('Error', errorMessage(e)); }
  };

  const ref = user?.referredBy;
  const refName = ref
    ? ((ref.firstName || ref.lastName) ? `${ref.firstName || ''} ${ref.lastName || ''}`.trim() : (ref.email || 'Anonymous referrer'))
    : null;

  return (
    <View style={styles.tabCol}>
      {/* Email + verification */}
      <SectionCard icon="mail-outline" title="Email address" subtitle="Used for sign-in, security alerts, and trade notifications." styles={styles} c={c}>
        <View style={styles.rowBetween}>
          <Text style={styles.emailMono} numberOfLines={1}>{user?.email || '—'}</Text>
          {user?.isEmailVerified ? (
            <TonePill icon="checkmark-circle-outline" label="Verified" tone="bull" styles={styles} c={c} />
          ) : (
            <SmallBtn
              label={resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend verification'}
              onPress={resendVerify}
              disabled={resendCooldown > 0}
              styles={styles} c={c}
            />
          )}
        </View>
      </SectionCard>

      {/* Referral */}
      <SectionCard icon="gift-outline" title="Referral" subtitle="Track who invited you and share your code to earn commissions." styles={styles} c={c}>
        <InfoBlock label="REFERRED BY" styles={styles}>
          {ref ? (
            <View>
              <Text style={styles.infoStrong}>{refName}</Text>
              {ref.referralCode ? (
                <Text style={styles.infoMono}>Code <Text style={{ color: c.primary500, fontWeight: '800' }}>{ref.referralCode}</Text></Text>
              ) : null}
            </View>
          ) : (
            <Text style={styles.infoMuted}>Signed up directly</Text>
          )}
        </InfoBlock>
        <InfoBlock label="YOUR CODE" styles={styles}>
          {user?.referralCode ? (
            <View style={styles.rowStart}>
              <Text style={styles.codeBig}>{user.referralCode}</Text>
              <CopyTag label="Copy" onPress={() => showValue('Referral code', user.referralCode)} styles={styles} />
            </View>
          ) : (
            <Text style={styles.infoMuted}>—</Text>
          )}
        </InfoBlock>
      </SectionCard>

      {/* Personal info */}
      <SectionCard icon="person-outline" title="Personal information" subtitle="Your legal name should match KYC documents." styles={styles} c={c}>
        <Field label="First name" styles={styles}>
          <TextInput style={styles.input} value={form.firstName} onChangeText={(v) => setForm({ ...form, firstName: v })} placeholder="First name" placeholderTextColor={c.textMuted} />
        </Field>
        <Field label="Last name" styles={styles}>
          <TextInput style={styles.input} value={form.lastName} onChangeText={(v) => setForm({ ...form, lastName: v })} placeholder="Last name" placeholderTextColor={c.textMuted} />
        </Field>
        <Field label="Phone" styles={styles}>
          <TextInput style={styles.input} value={form.phone} onChangeText={(v) => setForm({ ...form, phone: v })} placeholder="+91 98xxxxxxxx" placeholderTextColor={c.textMuted} keyboardType="phone-pad" />
        </Field>
        <Field label="Country" styles={styles}>
          <View style={[styles.input, styles.inputReadonly]}>
            <Text style={styles.inputReadonlyTxt}>{countryName(user?.country)}</Text>
          </View>
        </Field>

        <View style={styles.saveRow}>
          <Text style={[styles.dirtyTxt, { color: dirty ? c.warn : c.textMuted }]}>
            {dirty ? 'Unsaved changes' : 'All changes saved'}
          </Text>
        </View>
        <Button title={saving ? 'Saving…' : 'Save changes'} onPress={save} loading={saving} disabled={saving || !dirty} />
      </SectionCard>
    </View>
  );
}

// ── KYC tab ────────────────────────────────────────────────────────────────
function KycTab({ user, refreshUser, styles, c }) {
  const [docs, setDocs] = useState(null);
  const [docType, setDocType] = useState('ID_FRONT');
  const [picked, setPicked] = useState(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    try { const { data } = await api.get('/compliance/kyc/documents'); setDocs(data?.data || []); }
    catch { setDocs([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const pick = async () => {
    const img = await pickImageBase64();
    if (img) setPicked(img);
  };

  const upload = async () => {
    if (!picked) { Alert.alert('Document', 'Pick a document image first.'); return; }
    setUploading(true);
    try {
      await api.post('/compliance/kyc/documents', {
        docType,
        filename: picked.fileName,
        mimeType: picked.mimeType,
        dataBase64: picked.base64,
      });
      setPicked(null);
      await load();
      await refreshUser();
      Alert.alert('Uploaded', 'Document submitted for review.');
    } catch (e) { Alert.alert('Upload failed', errorMessage(e)); }
    finally { setUploading(false); }
  };

  const rawStatus = user?.kycStatus || 'NOT_SUBMITTED';
  const list = docs || [];
  // A submitted doc IS under review — treat NOT_SUBMITTED w/ live docs as PENDING.
  const hasReviewableDocs = list.some((d) => d.status !== 'REJECTED');
  const status = rawStatus === 'NOT_SUBMITTED' && hasReviewableDocs ? 'PENDING' : rawStatus;

  const meta = {
    APPROVED:      { tone: 'bull',  desc: 'Your identity is verified. You have full trading access.' },
    PENDING:       { tone: 'warn',  desc: 'We are reviewing your documents. This usually takes 1-2 business days.' },
    REJECTED:      { tone: 'bear',  desc: 'Your submission was rejected. Please re-upload corrected documents.' },
    NOT_SUBMITTED: { tone: 'muted', desc: 'Verify your identity to unlock Live trading and withdrawals.' },
  }[status] || { tone: 'muted', desc: '' };
  const toneColor = { bull: c.bull, warn: c.warn, bear: c.bear, muted: c.textMuted }[meta.tone];
  const toneSoft  = { bull: c.bullSoft, warn: c.warnSoft, bear: c.bearSoft, muted: c.hover }[meta.tone];

  return (
    <View style={styles.tabCol}>
      {/* Status banner */}
      <View style={[styles.kycBanner, { backgroundColor: toneSoft, borderColor: toneColor + '33' }]}>
        <View style={styles.kycBannerIcon}><Ionicons name="shield-checkmark-outline" size={22} color={toneColor} /></View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.rowStart}>
            <Text style={styles.kycTitle}>KYC Verification</Text>
            <View style={[styles.kycTag, { borderColor: toneColor + '55' }]}>
              <Text style={[styles.kycTagTxt, { color: toneColor }]}>{status.replace('_', ' ')}</Text>
            </View>
          </View>
          <Text style={styles.kycDesc}>{meta.desc}</Text>
          {user?.kycRejectionReason ? (
            <View style={styles.rejectBox}>
              <Text style={styles.rejectTxt}><Text style={{ fontWeight: '800' }}>Rejection reason: </Text>{user.kycRejectionReason}</Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* Upload */}
      <SectionCard icon="cloud-upload-outline" title="Upload document" subtitle="JPG or PNG — max 10MB per file." styles={styles} c={c}>
        <Field label="Document type" styles={styles}>
          <View style={styles.pillRow}>
            {DOC_TYPES.map((d) => {
              const on = docType === d.id;
              return (
                <TouchableOpacity key={d.id} onPress={() => setDocType(d.id)} style={[styles.docPill, on && styles.docPillOn]}>
                  <Text style={[styles.docPillTxt, on && styles.docPillTxtOn]}>{d.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Field>

        <TouchableOpacity activeOpacity={0.8} onPress={pick} style={styles.dropzone}>
          {picked ? (
            <Image source={{ uri: picked.uri }} style={styles.preview} resizeMode="cover" />
          ) : (
            <View style={{ alignItems: 'center', gap: 6 }}>
              <View style={styles.dropIcon}><Ionicons name="cloud-upload-outline" size={24} color={c.primary500} /></View>
              <Text style={styles.dropTxt}>Tap to pick a document image</Text>
              <Text style={styles.dropSub}>Max 10MB · JPG, PNG</Text>
            </View>
          )}
        </TouchableOpacity>

        <Button title={uploading ? 'Uploading…' : 'Upload document'} onPress={upload} loading={uploading} disabled={!picked} style={{ marginTop: 12 }} />
      </SectionCard>

      {/* Documents list */}
      <SectionCard
        icon="folder-outline"
        title="Uploaded documents"
        subtitle={docs == null ? 'Loading…' : `${list.length} document${list.length === 1 ? '' : 's'} on file`}
        padded={false}
        styles={styles} c={c}
      >
        {docs == null ? (
          <View style={styles.loaderBox}><Loader /></View>
        ) : list.length === 0 ? (
          <View style={styles.emptyBox}>
            <View style={styles.emptyIcon}><Ionicons name="folder-outline" size={22} color={c.textMuted} /></View>
            <Text style={styles.emptyTxt}>No documents uploaded yet</Text>
          </View>
        ) : (
          list.map((d, i) => {
            const ds = rawStatus === 'APPROVED'
              ? 'APPROVED'
              : (rawStatus === 'REJECTED' && d.status === 'PENDING' ? 'REJECTED' : d.status);
            return (
              <View key={d._id || i} style={[styles.listRow, i > 0 && styles.listDivider]}>
                <View style={styles.listIcon}><Ionicons name="document-outline" size={16} color={c.primary500} /></View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.listTitle} numberOfLines={1}>{(d.docType || '').replace(/_/g, ' ')}</Text>
                  <Text style={styles.listMeta} numberOfLines={1}>
                    {(d.originalFilename || '')}{d.createdAt ? ` · ${new Date(d.createdAt).toLocaleDateString('en-US')}` : ''}
                  </Text>
                  {ds === 'REJECTED' && d.rejectionReason ? <Text style={styles.rejInline}>Reason: {d.rejectionReason}</Text> : null}
                </View>
                <Pill label={ds} tone={toneFor(ds)} />
              </View>
            );
          })
        )}
      </SectionCard>
    </View>
  );
}

// ── SECURITY tab ────────────────────────────────────────────────────────────
function ChangePasswordCard({ styles, c }) {
  const [cur, setCur] = useState('');
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  const rulesPass = PASSWORD_RULES.every((r) => r.test(pwd));
  const match = pwd && pwd === confirm;

  const submit = async () => {
    if (!cur) return Alert.alert('Password', 'Enter your current password');
    if (!rulesPass) return Alert.alert('Password', 'New password does not meet all requirements');
    if (!match) return Alert.alert('Password', 'Passwords do not match');
    setLoading(true);
    try {
      const rt = await tokens.getRefresh();
      await api.post('/auth/change-password', {
        currentPassword: cur,
        newPassword: pwd,
        // Keep THIS session alive; sign out other devices (mirrors the web).
        keepRefreshToken: rt || undefined,
      });
      setCur(''); setPwd(''); setConfirm('');
      Alert.alert('Password changed', 'Other devices have been signed out.');
    } catch (e) { Alert.alert('Password', errorMessage(e)); }
    finally { setLoading(false); }
  };

  return (
    <SectionCard icon="lock-closed-outline" title="Password" subtitle="Change your account password." styles={styles} c={c}>
      <Field label="Current password" styles={styles}>
        <PwInput value={cur} onChangeText={setCur} placeholder="Current password" styles={styles} c={c} />
      </Field>
      <Field label="New password" styles={styles}>
        <PwInput value={pwd} onChangeText={setPwd} placeholder="New password" styles={styles} c={c} />
      </Field>

      <View style={{ gap: 6 }}>
        {PASSWORD_RULES.map((r) => {
          const ok = r.test(pwd);
          return (
            <View key={r.label} style={styles.ruleRow}>
              <View style={[styles.ruleDot, { backgroundColor: ok ? c.bullSoft : c.hover }]}>
                {ok ? <Ionicons name="checkmark" size={11} color={c.bull} /> : <View style={styles.ruleDotInner} />}
              </View>
              <Text style={[styles.ruleTxt, { color: ok ? c.bull : c.textMuted }]}>{r.label}</Text>
            </View>
          );
        })}
      </View>

      <Field label="Confirm new password" styles={styles}>
        <PwInput value={confirm} onChangeText={setConfirm} placeholder="Re-enter new password" styles={styles} c={c} />
        {confirm && !match ? <Text style={styles.matchErr}>Passwords do not match</Text> : null}
      </Field>

      <Button title={loading ? 'Updating…' : 'Update password'} onPress={submit} loading={loading} disabled={loading || !cur || !rulesPass || !match} />
    </SectionCard>
  );
}

function SecurityTab({ user, refreshUser, styles, c }) {
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableCode, setDisableCode] = useState('');
  const [disabling, setDisabling] = useState(false);

  const init2FA = async () => {
    try { const r = await api.post('/auth/2fa/setup'); setSetup(r.data.data); }
    catch (e) { Alert.alert('2FA', errorMessage(e)); }
  };

  const enable = async () => {
    if (code.length !== 6) return Alert.alert('2FA', 'Enter the 6-digit code');
    setBusy(true);
    try {
      const r = await api.post('/auth/2fa/enable', { code });
      setBackupCodes(r.data.data.backupCodes);
      setSetup(null);
      setCode('');
      await refreshUser();
      Alert.alert('2FA enabled', 'Save your backup codes!');
    } catch (e) { Alert.alert('2FA', errorMessage(e)); }
    finally { setBusy(false); }
  };

  const confirmDisable = async () => {
    if (disableCode.length !== 6) return Alert.alert('2FA', 'Enter your current 6-digit code');
    setDisabling(true);
    try {
      await api.post('/auth/2fa/disable', { code: disableCode });
      setDisableOpen(false);
      setDisableCode('');
      await refreshUser();
      Alert.alert('2FA disabled', 'Two-factor authentication is now off.');
    } catch (e) { Alert.alert('2FA', errorMessage(e)); }
    finally { setDisabling(false); }
  };

  const enabled = !!user?.twoFactorEnabled;
  const action = enabled
    ? <SmallBtn label="Disable" tone="bear" onPress={() => setDisableOpen(true)} styles={styles} c={c} />
    : !setup ? <SmallBtn label="Enable 2FA" tone="primary" onPress={init2FA} styles={styles} c={c} /> : null;

  return (
    <View style={styles.tabCol}>
      <ChangePasswordCard styles={styles} c={c} />

      <SectionCard
        icon="lock-closed-outline"
        title="Two-Factor Authentication"
        subtitle="Add an extra layer of security with an authenticator app."
        action={action}
        styles={styles} c={c}
      >
        {/* Status banner */}
        <View style={[styles.twofaBanner, { backgroundColor: enabled ? c.bullSoft : c.warnSoft, borderColor: (enabled ? c.bull : c.warn) + '33' }]}>
          <View style={styles.twofaBannerIcon}>
            <Ionicons name={enabled ? 'checkmark' : 'warning-outline'} size={16} color={enabled ? c.bull : c.warn} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[styles.twofaTitle, { color: enabled ? c.bull : c.warn }]}>
              {enabled ? '2FA is active' : '2FA is not enabled'}
            </Text>
            <Text style={styles.twofaSub}>
              {enabled
                ? 'Your account is protected by a second authentication factor.'
                : 'Enable 2FA to protect your account from unauthorized access.'}
            </Text>
          </View>
        </View>

        {/* Setup wizard */}
        {setup && !enabled ? (
          <View style={styles.wizard}>
            <View style={styles.stepRow}>
              <View style={styles.stepNum}><Text style={styles.stepNumTxt}>1</Text></View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.stepTitle}>Scan with your authenticator app</Text>
                <Text style={styles.stepDesc}>Use Google Authenticator, Authy, or 1Password.</Text>
                <View style={styles.qrWrap}>
                  {setup.qrDataUrl ? <Image source={{ uri: setup.qrDataUrl }} style={styles.qrImg} resizeMode="contain" /> : null}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.fieldLabel}>Or enter manually</Text>
                    <View style={styles.secretBox}><Text style={styles.secretTxt}>{setup.secret}</Text></View>
                    <CopyTag label="Copy secret" onPress={() => showValue('2FA secret', setup.secret)} styles={styles} />
                  </View>
                </View>
              </View>
            </View>

            <View style={styles.stepRow}>
              <View style={styles.stepNum}><Text style={styles.stepNumTxt}>2</Text></View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.stepTitle}>Enter the 6-digit code from the app</Text>
                <View style={styles.codeRow}>
                  <TextInput
                    style={styles.codeInput}
                    value={code}
                    onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
                    keyboardType="number-pad"
                    maxLength={6}
                    placeholder="000000"
                    placeholderTextColor={c.textMuted}
                  />
                  <SmallBtn label={busy ? '…' : 'Confirm'} onPress={enable} disabled={busy} styles={styles} c={c} />
                </View>
              </View>
            </View>
          </View>
        ) : null}

        {/* Backup codes */}
        {backupCodes ? (
          <View style={styles.backupBox}>
            <View style={styles.rowStart}>
              <View style={styles.backupIcon}><Ionicons name="warning-outline" size={18} color={c.warn} /></View>
              <Text style={styles.backupTitle}>Save these backup codes</Text>
            </View>
            <Text style={styles.backupSub}>Each code can be used once if you lose access to your authenticator. They won't be shown again.</Text>
            <View style={styles.backupGrid}>
              {backupCodes.map((bc) => <Text key={bc} style={styles.backupCode}>{bc}</Text>)}
            </View>
            <CopyTag label="Copy all codes" onPress={() => showValue('Backup codes', backupCodes.join('\n'))} styles={styles} />
          </View>
        ) : null}
      </SectionCard>

      {/* Disable-2FA modal (replaces the web's window.prompt) */}
      <Modal visible={disableOpen} transparent animationType="fade" onRequestClose={() => setDisableOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Disable two-factor auth</Text>
            <Text style={styles.modalSub}>Enter your current 6-digit 2FA code to confirm.</Text>
            <TextInput
              style={styles.codeInput}
              value={disableCode}
              onChangeText={(v) => setDisableCode(v.replace(/\D/g, '').slice(0, 6))}
              keyboardType="number-pad"
              maxLength={6}
              placeholder="000000"
              placeholderTextColor={c.textMuted}
              autoFocus
            />
            <View style={styles.modalBtns}>
              <TouchableOpacity onPress={() => { setDisableOpen(false); setDisableCode(''); }} style={[styles.modalBtn, { backgroundColor: c.hover }]}>
                <Text style={[styles.modalBtnTxt, { color: c.textPrimary }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={confirmDisable} disabled={disabling} style={[styles.modalBtn, { backgroundColor: c.bear, opacity: disabling ? 0.6 : 1 }]}>
                <Text style={[styles.modalBtnTxt, { color: c.white }]}>{disabling ? 'Disabling…' : 'Disable'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ── ACTIVE SESSIONS tab ──────────────────────────────────────────────────
function SessionsTab({ styles, c }) {
  const [devices, setDevices] = useState(null);

  const load = useCallback(async () => {
    try { const r = await api.get('/auth/devices'); setDevices(r.data?.data || []); }
    catch { setDevices([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const revoke = (id) => {
    Alert.alert('Revoke session', 'You will be logged out from that device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Revoke',
        style: 'destructive',
        onPress: async () => {
          try { await api.delete(`/auth/devices/${id}`); load(); }
          catch (e) { Alert.alert('Error', errorMessage(e)); }
        },
      },
    ]);
  };

  const list = devices || [];
  return (
    <View style={styles.tabCol}>
      <SectionCard
        icon="desktop-outline"
        title="Active sessions"
        subtitle={devices == null ? 'Loading…' : `${list.length} active session${list.length === 1 ? '' : 's'}`}
        padded={false}
        styles={styles} c={c}
      >
        {devices == null ? (
          <View style={styles.loaderBox}><Loader /></View>
        ) : list.length === 0 ? (
          <View style={styles.emptyBox}>
            <View style={styles.emptyIcon}><Ionicons name="desktop-outline" size={22} color={c.textMuted} /></View>
            <Text style={styles.emptyTxt}>No active sessions</Text>
          </View>
        ) : (
          list.map((d, i) => (
            <View key={d.id || i} style={[styles.listRow, i > 0 && styles.listDivider]}>
              <View style={styles.listIcon}><Ionicons name="desktop-outline" size={16} color={c.primary500} /></View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.listTitle} numberOfLines={1}>{d.deviceInfo || 'Unknown device'}</Text>
                <Text style={styles.listMeta} numberOfLines={1}>Created {d.createdAt ? new Date(d.createdAt).toLocaleString('en-US') : '—'}</Text>
              </View>
              <TouchableOpacity onPress={() => revoke(d.id)} style={styles.revokeBtn}>
                <Text style={styles.revokeTxt}>Revoke</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
      </SectionCard>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────
const makeStyles = (c) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  tabCol: { gap: 12 },

  // Hero
  hero: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.xl, padding: 16 },
  heroRow: { flexDirection: 'row', gap: 14 },
  avatar: { width: 64, height: 64, borderRadius: radius.xl, backgroundColor: c.primary500, alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { color: c.white, fontWeight: '900', fontSize: 24 },
  eyebrow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  eyebrowLine: { width: 18, height: 1, backgroundColor: c.primary500 },
  eyebrowTxt: { fontSize: 10, fontWeight: '800', letterSpacing: 1.5, color: c.primary500 },
  heroName: { fontSize: 20, fontWeight: '900', color: c.textPrimary },
  heroEmail: { fontSize: 13, color: c.textSecondary, marginTop: 2 },
  uidChip: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', marginTop: 10, borderWidth: 1, borderColor: c.primary500 + '4D', backgroundColor: c.primarySoft, borderRadius: radius.md, paddingLeft: 10, paddingRight: 8, paddingVertical: 6 },
  uidLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 1, color: c.textMuted },
  uidValue: { fontFamily: MONO, fontSize: 13, fontWeight: '800', color: c.primary500 },
  pillsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  memberCol: { alignItems: 'flex-end', width: 72 },
  memberCap: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5, color: c.textMuted, textAlign: 'right' },
  memberVal: { fontSize: 13, fontWeight: '800', color: c.textPrimary, marginTop: 2, textAlign: 'right' },

  // Tone pill (hero + inline)
  tonePill: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 4 },
  tonePillTxt: { fontSize: 11, fontWeight: '700' },

  // Tab strip
  tabStrip: { gap: 8, paddingVertical: 2 },
  tabBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, marginRight: 8 },
  tabBtnOn: { backgroundColor: c.primary500, borderColor: c.primary500 },
  tabTxt: { fontSize: 13, fontWeight: '700', color: c.textSecondary },
  tabTxtOn: { color: c.white },

  // Section card
  sc: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.xl, overflow: 'hidden' },
  scHead: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  scIcon: { width: 34, height: 34, borderRadius: radius.md, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' },
  scTitle: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
  scSub: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  scBody: { padding: 16, gap: 14 },

  // Field / input
  fieldLabel: { fontSize: 12, fontWeight: '700', color: c.textSecondary },
  input: { minHeight: 44, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: c.textPrimary, backgroundColor: c.bg },
  inputReadonly: { justifyContent: 'center', opacity: 0.7 },
  inputReadonlyTxt: { fontSize: 14, color: c.textPrimary },

  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  rowStart: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  emailMono: { flex: 1, fontFamily: MONO, fontSize: 13, fontWeight: '700', color: c.textPrimary },

  // Info block (referral)
  infoBlock: { borderWidth: 1, borderColor: c.borderSubtle, backgroundColor: c.hover, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10 },
  infoLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5, color: c.textMuted },
  infoStrong: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
  infoMono: { fontFamily: MONO, fontSize: 12, color: c.textMuted, marginTop: 2 },
  infoMuted: { fontSize: 13, color: c.textMuted },
  codeBig: { fontFamily: MONO, fontSize: 17, fontWeight: '900', color: c.primary500 },

  // Save row
  saveRow: { borderTopWidth: 1, borderTopColor: c.borderSubtle, paddingTop: 12, alignItems: 'flex-end' },
  dirtyTxt: { fontSize: 11, fontWeight: '700' },

  // Small button + copy tag
  smallBtn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  smallBtnTxt: { fontSize: 13, fontWeight: '700', color: c.white },
  copyTag: { alignSelf: 'flex-start', backgroundColor: c.primarySoft, paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.sm, marginTop: 8 },
  copyTagTxt: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5, color: c.primary500 },

  // KYC banner
  kycBanner: { flexDirection: 'row', gap: 12, borderWidth: 1, borderRadius: radius.xl, padding: 16 },
  kycBannerIcon: { width: 44, height: 44, borderRadius: radius.md, backgroundColor: c.card, borderWidth: 1, borderColor: c.borderSubtle, alignItems: 'center', justifyContent: 'center' },
  kycTitle: { fontSize: 15, fontWeight: '900', color: c.textPrimary },
  kycTag: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: c.card },
  kycTagTxt: { fontSize: 10, fontWeight: '900', letterSpacing: 0.5 },
  kycDesc: { fontSize: 13, color: c.textSecondary, marginTop: 4 },
  rejectBox: { marginTop: 10, borderWidth: 1, borderColor: c.bear + '4D', backgroundColor: c.card, borderRadius: radius.md, padding: 10 },
  rejectTxt: { fontSize: 13, color: c.bear },

  // Doc-type pills + dropzone
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  docPill: { borderWidth: 1, borderColor: c.border, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8 },
  docPillOn: { borderColor: c.primary500, backgroundColor: c.primarySoft },
  docPillTxt: { fontSize: 13, fontWeight: '700', color: c.textSecondary },
  docPillTxtOn: { color: c.primary500 },
  dropzone: { height: 170, borderWidth: 1.5, borderStyle: 'dashed', borderColor: c.border, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: c.hover },
  dropIcon: { width: 44, height: 44, borderRadius: radius.md, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' },
  dropTxt: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
  dropSub: { fontSize: 12, color: c.textMuted },
  preview: { width: '100%', height: '100%' },

  // List rows (docs + sessions)
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  listDivider: { borderTopWidth: 1, borderTopColor: c.borderSubtle },
  listIcon: { width: 34, height: 34, borderRadius: radius.md, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' },
  listTitle: { fontSize: 14, fontWeight: '700', color: c.textPrimary, textTransform: 'capitalize' },
  listMeta: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  rejInline: { fontSize: 11, color: c.bear, marginTop: 2 },
  revokeBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.sm },
  revokeTxt: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, color: c.bear, textTransform: 'uppercase' },

  // Loading / empty states inside cards
  loaderBox: { height: 120 },
  emptyBox: { paddingVertical: 32, alignItems: 'center', gap: 10 },
  emptyIcon: { width: 44, height: 44, borderRadius: radius.md, backgroundColor: c.hover, alignItems: 'center', justifyContent: 'center' },
  emptyTxt: { fontSize: 13, color: c.textMuted },

  // Password rules + confirm
  ruleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ruleDot: { width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  ruleDotInner: { width: 4, height: 4, borderRadius: 2, backgroundColor: c.textMuted },
  ruleTxt: { fontSize: 12 },
  matchErr: { fontSize: 11, fontWeight: '700', color: c.bear, marginTop: 2 },

  // Password input (secure + eye toggle)
  pwWrap: { position: 'relative', justifyContent: 'center' },
  pwInput: { minHeight: 44, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, paddingRight: 44, fontSize: 14, color: c.textPrimary, backgroundColor: c.bg },
  pwEye: { position: 'absolute', right: 12 },

  // 2FA
  twofaBanner: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: radius.md, padding: 12 },
  twofaBannerIcon: { width: 34, height: 34, borderRadius: radius.md, backgroundColor: c.card, alignItems: 'center', justifyContent: 'center' },
  twofaTitle: { fontSize: 14, fontWeight: '800' },
  twofaSub: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
  wizard: { borderWidth: 1, borderColor: c.border, backgroundColor: c.hover, borderRadius: radius.lg, padding: 16, gap: 18, marginTop: 4 },
  stepRow: { flexDirection: 'row', gap: 12 },
  stepNum: { width: 28, height: 28, borderRadius: 14, backgroundColor: c.primary500, alignItems: 'center', justifyContent: 'center' },
  stepNumTxt: { color: c.white, fontWeight: '900', fontSize: 13 },
  stepTitle: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
  stepDesc: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  qrWrap: { flexDirection: 'row', gap: 14, marginTop: 12, alignItems: 'center' },
  qrImg: { width: 132, height: 132, backgroundColor: c.white, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, padding: 6 },
  secretBox: { marginTop: 4, backgroundColor: c.bg, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 8 },
  secretTxt: { fontFamily: MONO, fontSize: 12, color: c.primary500 },
  codeRow: { flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'center' },
  codeInput: { flex: 1, minHeight: 48, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, fontFamily: MONO, fontSize: 20, fontWeight: '800', color: c.textPrimary, backgroundColor: c.bg, textAlign: 'center', letterSpacing: 8 },

  // Backup codes
  backupBox: { backgroundColor: c.warnSoft, borderWidth: 1, borderColor: c.warn + '4D', borderRadius: radius.lg, padding: 16, marginTop: 4, gap: 8 },
  backupIcon: { width: 34, height: 34, borderRadius: radius.md, backgroundColor: c.card, alignItems: 'center', justifyContent: 'center' },
  backupTitle: { fontSize: 14, fontWeight: '900', color: c.warn },
  backupSub: { fontSize: 12, color: c.textSecondary },
  backupGrid: { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: c.bg, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, padding: 12 },
  backupCode: { width: '50%', fontFamily: MONO, fontSize: 13, color: c.primary500, paddingVertical: 3 },

  // Disable-2FA modal
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: { width: '100%', maxWidth: 380, backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.xl, padding: 20, gap: 12 },
  modalTitle: { fontSize: 16, fontWeight: '900', color: c.textPrimary },
  modalSub: { fontSize: 13, color: c.textSecondary },
  modalBtns: { flexDirection: 'row', gap: 10, marginTop: 4 },
  modalBtn: { flex: 1, height: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  modalBtnTxt: { fontSize: 14, fontWeight: '800' },
});
