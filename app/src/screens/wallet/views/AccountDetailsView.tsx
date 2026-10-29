import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { accountApi, nicknameError, NICKNAME_MAX, normaliseNickname } from '@/api/account.api';
import { errorMessage } from '@/api/client';
import { AppText, Button, Skeleton, toast } from '@/components/ui';
import { WalletGlyph } from '@/components/wallet/WalletNav';
import { useAppNavigation } from '@/navigation/types';
import { useTheme } from '@/theme';
import type { AuthUser, UserAccount } from '@/types/user';
import type { WalletBalance } from '@/types/wallet';
import { accountTierLabel, isRealMoney } from '@/utils/accountType';
import { EMPTY, fmtLeverage, fmtMoney } from '@/utils/money';
import {
  accountBalance,
  accountDisplayName,
  accountTile,
  fullNameOf,
  initialsOf,
  isSuspendedAccount,
  kycMeta,
  type WalletHubView,
} from '@/utils/walletLogic';

import { WalletCard } from '../RecentTransactions';

const BLUE = '#1D4ED8';
const LIGHT_BLUE = '#3B82F6';
const AMBER = '#F59E0B';
const AMBER_TEXT = '#B45309';

/**
 * Account Details — EquityHub's Wallet.jsx AccountDetailsView: the profile
 * hero with the KYC pill,
 * every trading account (rename in place, suspended badge, balance, type,
 * leverage), the Main / Bonus wallet entry cards, and the security and
 * profile summaries.
 *
 * Accounts come from the app-wide selected-account store (the same
 * /user/accounts list the header's switcher shows); the hub reloads it with
 * the rest of the page. A failed load is NOT "No accounts yet" — the web's
 * own reasoning: telling a user with accounts to create one is how a
 * transient 401 becomes a duplicate account.
 *
 * Balance (INR): every wallet row of the account summed, as the web's
 * `accountTotalUsd(balances, a._id, 'balance')` does. Type is the account's
 * tier name (utils/accountTypes accountTierLabel).
 */
export function AccountDetailsView({
  user,
  accounts,
  accountsError,
  accountsLoading,
  balances,
  balancesReady,
  onRefresh,
  setView,
}: {
  user: AuthUser | null;
  accounts: readonly UserAccount[];
  accountsError: string | null;
  accountsLoading: boolean;
  balances: readonly WalletBalance[];
  /**
   * /wallet/balances has answered at least once. Until then a card's balance
   * is unknown — a dash, not the web's "₹0.00" for money that may be there.
   */
  balancesReady: boolean;
  onRefresh: () => void;
  setView: (v: WalletHubView) => void;
}): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  const fullName = fullNameOf(user);
  const kyc = kycMeta(user?.kycStatus);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameOverrides, setNameOverrides] = useState<Record<string, string>>({});
  // The state flag above drives the button; this one guards the request. A
  // second tap (or the keyboard's Done right after the tick) lands before
  // the re-render that disables the button, and the state it would read is
  // still `false` — two PATCHes for one rename.
  const saving = useRef(false);

  const startEdit = (a: UserAccount, current: string): void => { setEditingId(a.id); setEditName(current || ''); };
  const cancelEdit = (): void => { setEditingId(null); setEditName(''); };

  // Wallet.jsx:3504-3520 — the same two checks, then PATCH /user/accounts/:id.
  const saveName = async (a: UserAccount): Promise<void> => {
    if (saving.current) return;
    const problem = nicknameError(editName);
    if (problem) { toast.error(problem); return; }
    const name = normaliseNickname(editName);
    saving.current = true;
    setSavingName(true);
    try {
      await accountApi.rename(a.id, name);
      setNameOverrides((m) => ({ ...m, [a.id]: name }));
      toast.success('Account renamed');
      cancelEdit();
      onRefresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      saving.current = false;
      setSavingName(false);
    }
  };

  return (
    <View style={styles.stack}>
      <View style={styles.head}>
        <View style={styles.flex}>
          <AppText variant="h1" accessibilityRole="header">Account Details</AppText>
          <AppText variant="body" tone="secondary" style={styles.gap4}>Profile, trading accounts, KYC status, and security settings.</AppText>
        </View>
        <Button title="+ New Account" size="sm" onPress={() => nav.navigate('NewAccountTiers')} />
      </View>

      {/* ── Profile hero ── */}
      <WalletCard>
        <View style={styles.hero}>
          <View style={[styles.avatar, { backgroundColor: BLUE }]}>
            <AppText variant="h2" color="#FFFFFF">{initialsOf(fullName)}</AppText>
          </View>
          <View style={styles.flex}>
            <AppText variant="h3" weight="700" numberOfLines={1}>{fullName}</AppText>
            <AppText variant="body" tone="secondary" numberOfLines={1}>{user?.email || EMPTY}</AppText>
            <View style={[styles.kycPill, { backgroundColor: t.alpha(kyc.tint, 0.1) }]}>
              <AppText variant="micro" color={kyc.tint} weight="700" style={styles.upper}>{`KYC · ${kyc.label}`}</AppText>
            </View>
          </View>
        </View>
        <AppText
          variant="small"
          tone="brand"
          weight="600"
          accessibilityRole="link"
          onPress={() => nav.navigate('Profile')}
          style={styles.editProfile}
        >
          Edit profile →
        </AppText>
      </WalletCard>

      {/* ── Trading Accounts ── */}
      <WalletCard>
        <View style={styles.between}>
          <AppText variant="bodyStrong" weight="700" style={styles.flex}>
            Trading Accounts <AppText variant="bodyStrong" tone="muted" weight="600">{`(${accounts.length})`}</AppText>
          </AppText>
          <AppText variant="small" tone="brand" weight="600" accessibilityRole="link" onPress={() => setView('transfer')}>
            Transfer funds →
          </AppText>
        </View>

        {accountsLoading && accounts.length === 0 ? (
          // A skeleton, NOT "No accounts yet" — until the list answers we do
          // not know, and "none" invites a duplicate account.
          <View style={styles.cards} accessibilityLabel="Loading accounts">
            {[0, 1].map((i) => (
              <View key={i} style={[styles.accCard, { borderColor: t.colors.borderDark }]}>
                <View style={styles.between}>
                  <Skeleton width={44} height={44} radius={12} />
                  <Skeleton width={64} height={16} />
                </View>
                <Skeleton width={128} height={16} style={styles.gap12} />
                <Skeleton width={96} height={12} style={styles.gap8} />
                <Skeleton height={56} radius={12} style={styles.gap16} />
              </View>
            ))}
          </View>
        ) : accounts.length === 0 && accountsError ? (
          <View style={styles.center}>
            <AppText variant="bodyStrong">Couldn’t load your accounts</AppText>
            <AppText variant="small" tone="muted" style={styles.gap4}>The request failed — your accounts are safe. Try again.</AppText>
            <Button title="Retry" variant="secondary" size="sm" onPress={onRefresh} style={styles.gap16} />
          </View>
        ) : accounts.length === 0 ? (
          <View style={styles.center}>
            <AppText variant="bodyStrong">No accounts yet</AppText>
            <AppText variant="small" tone="muted" style={styles.gap4}>Create your first trading account to start.</AppText>
            <Button title="+ Create Account" size="sm" onPress={() => nav.navigate('NewAccountTiers')} style={styles.gap16} />
          </View>
        ) : (
          <View style={styles.cards}>
            {accounts.map((a) => {
              const real = isRealMoney(a.accountType);
              const tint = real ? BLUE : LIGHT_BLUE;
              const displayName = accountDisplayName(a, nameOverrides);
              const editing = editingId === a.id;
              const suspended = isSuspendedAccount(a);
              const balance = accountBalance(balances, a.id);
              return (
                <View
                  key={a.id}
                  style={[
                    styles.accCard,
                    suspended
                      ? { borderColor: '#FBBF24', backgroundColor: t.alpha(AMBER, 0.06) }
                      : { borderColor: t.colors.borderDark, backgroundColor: t.colors.surface },
                  ]}
                >
                  {suspended ? (
                    <View style={[styles.suspended, { backgroundColor: AMBER }]}>
                      <AppText variant="micro" color="#FFFFFF" weight="800" style={styles.suspendedText}>Suspended</AppText>
                    </View>
                  ) : null}
                  <View style={styles.between}>
                    <View style={[styles.tile, { backgroundColor: t.alpha(tint, 0.12) }]}>
                      <AppText variant="bodyStrong" color={tint} weight="800">{accountTile(displayName)}</AppText>
                    </View>
                    <View style={[styles.typeTag, { backgroundColor: t.alpha(real ? t.colors.bull : t.colors.info, 0.15) }]}>
                      <AppText variant="micro" color={real ? t.colors.bull : t.colors.info} weight="700" style={styles.upper}>
                        {real ? 'Live · Real' : a.accountType}
                      </AppText>
                    </View>
                  </View>

                  <View style={styles.gap12}>
                    {editing ? (
                      <View style={styles.inline}>
                        <TextInput
                          autoFocus
                          value={editName}
                          onChangeText={setEditName}
                          onSubmitEditing={() => { void saveName(a); }}
                          maxLength={NICKNAME_MAX}
                          placeholder="Account name"
                          placeholderTextColor={t.colors.textMuted}
                          returnKeyType="done"
                          accessibilityLabel="Account name"
                          style={[
                            styles.nameInput,
                            { color: t.colors.textPrimary, backgroundColor: t.colors.bgHover, borderColor: t.colors.primary },
                          ]}
                        />
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Save name"
                          disabled={savingName}
                          onPress={() => { void saveName(a); }}
                          hitSlop={6}
                          style={[styles.iconBtn, savingName ? styles.dim : null]}
                        >
                          <WalletGlyph name="check" size={15} color={t.colors.bull} strokeWidth={2.6} />
                        </Pressable>
                        <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={cancelEdit} hitSlop={6} style={styles.iconBtn}>
                          <WalletGlyph name="close" size={15} color={t.colors.textMuted} strokeWidth={2.6} />
                        </Pressable>
                      </View>
                    ) : (
                      <View style={styles.inline}>
                        <AppText variant="bodyStrong" weight="700" numberOfLines={1} style={styles.shrink}>{displayName}</AppText>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Rename account"
                          onPress={() => startEdit(a, displayName)}
                          hitSlop={8}
                          style={styles.iconBtn}
                        >
                          <WalletGlyph name="pencil" size={13} color={t.colors.textMuted} strokeWidth={2} />
                        </Pressable>
                      </View>
                    )}
                  </View>
                  <AppText variant="caption" tone="muted" mono numberOfLines={1}>{a.accountNumber}</AppText>

                  {suspended ? (
                    <AppText variant="caption" color={t.isDark ? AMBER : AMBER_TEXT} style={styles.gap8}>
                      Over plan limit. Trading paused; you can still withdraw funds and view the last 3 months of history.{' '}
                      <AppText
                        variant="caption"
                        color={t.isDark ? AMBER : AMBER_TEXT}
                        weight="700"
                        style={styles.underline}
                        accessibilityRole="link"
                        onPress={() => nav.navigate('Plans')}
                      >
                        Upgrade plan
                      </AppText>
                    </AppText>
                  ) : null}

                  <View style={[styles.balance, { backgroundColor: t.colors.bgHover }]}>
                    <AppText variant="micro" tone="muted" weight="600" style={styles.upper}>Balance (INR)</AppText>
                    <AppText variant="bodyStrong" mono weight="700" style={styles.gap2}>{balancesReady ? fmtMoney(balance) : EMPTY}</AppText>
                  </View>

                  <View style={styles.meta}>
                    <View style={styles.flex}>
                      <AppText variant="caption" tone="muted" weight="600" style={styles.upper}>Type</AppText>
                      <AppText variant="bodyStrong" weight="700" numberOfLines={1}>{accountTierLabel(a)}</AppText>
                    </View>
                    <View style={styles.flex}>
                      <AppText variant="caption" tone="muted" weight="600" style={styles.upper}>Leverage</AppText>
                      <AppText variant="bodyStrong" mono weight="700">{fmtLeverage(a.leverage)}</AppText>
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </WalletCard>

      {/* ── Bonus Wallet entry card — referral / partner earnings, copy-trading
          fees and funds you add; plans are billed from it. ── */}
      <EntryCard
        tint="#16A34A"
        linkColor={t.colors.bull}
        glyph="navBonus"
        title="Main Wallet"
        body="Referral & partner earnings, copy-trading fees and funds you add. Your plans are billed from here."
        onPress={() => nav.navigate('BonusWallet')}
      />

      {/* ── Security ── */}
      <WalletCard>
        <AppText variant="bodyStrong" weight="700" style={styles.cardTitle}>Security</AppText>
        <View style={styles.list}>
          <View style={styles.between}>
            <AppText variant="body">Two-Factor Authentication</AppText>
            <StateTag on={!!user?.twoFactorEnabled} onLabel="Enabled" offLabel="Disabled" />
          </View>
          <View style={styles.between}>
            <AppText variant="body">Password</AppText>
            <AppText variant="small" tone="brand" weight="600" accessibilityRole="link" onPress={() => nav.navigate('Profile')}>
              Change →
            </AppText>
          </View>
          <View style={styles.between}>
            <AppText variant="body">Login alerts</AppText>
            <StateTag on onLabel="Active" offLabel="Active" />
          </View>
        </View>
      </WalletCard>

      {/* ── Profile ── */}
      <WalletCard>
        <AppText variant="bodyStrong" weight="700" style={styles.cardTitle}>Profile</AppText>
        <View style={styles.list}>
          <View style={styles.between}>
            <AppText variant="body">Name</AppText>
            <AppText variant="bodyStrong" numberOfLines={1} style={styles.value}>{fullName}</AppText>
          </View>
          <View style={styles.between}>
            <AppText variant="body">Email</AppText>
            <AppText variant="bodyStrong" numberOfLines={1} style={styles.value}>{user?.email || EMPTY}</AppText>
          </View>
          <View style={styles.between}>
            <AppText variant="body">Phone</AppText>
            <AppText variant="bodyStrong" numberOfLines={1} style={styles.value}>{user?.phone || EMPTY}</AppText>
          </View>
        </View>
      </WalletCard>
    </View>
  );
}

function StateTag({ on, onLabel, offLabel }: { on: boolean; onLabel: string; offLabel: string }): React.JSX.Element {
  const t = useTheme();
  const c = on ? '#16A34A' : '#DC2626';
  return (
    <View style={[styles.stateTag, { backgroundColor: t.alpha(c, 0.1) }]}>
      <AppText variant="caption" color={c} weight="700" style={styles.upper}>{on ? onLabel : offLabel}</AppText>
    </View>
  );
}

/** Wallet.jsx:3691-3735 — a whole-card link to a separate wallet page. */
function EntryCard({ tint, linkColor, glyph, title, body, onPress }: {
  tint: string;
  linkColor: string;
  glyph: 'navBonus';
  title: string;
  body: string;
  onPress: () => void;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => [
        styles.entry,
        {
          backgroundColor: t.colors.surface,
          borderColor: pressed ? tint : t.colors.borderDark,
          borderRadius: t.radius.xxl,
        },
      ]}
    >
      <View style={[styles.entryIcon, { backgroundColor: t.alpha(tint, 0.12) }]}>
        <WalletGlyph name={glyph} size={22} color={tint} />
      </View>
      <View style={styles.flex}>
        <AppText variant="title">{title}</AppText>
        <AppText variant="small" tone="muted" style={styles.gap2}>{body}</AppText>
      </View>
      <View style={styles.inline}>
        <AppText variant="bodyStrong" color={linkColor}>Open</AppText>
        <WalletGlyph name="arrowRight" size={14} color={linkColor} strokeWidth={2.2} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 20 },
  flex: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  upper: { textTransform: 'uppercase', letterSpacing: 0.6 },
  underline: { textDecorationLine: 'underline' },
  dim: { opacity: 0.4 },
  gap2: { marginTop: 2 },
  gap4: { marginTop: 4 },
  gap8: { marginTop: 8 },
  gap12: { marginTop: 12 },
  gap16: { marginTop: 16 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' },
  hero: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  avatar: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  kycPill: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, marginTop: 6 },
  editProfile: { marginTop: 12, alignSelf: 'flex-end' },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  center: { alignItems: 'center', paddingVertical: 32 },
  cards: { gap: 12, marginTop: 16 },
  accCard: { borderWidth: 2, borderRadius: 16, padding: 16 },
  suspended: { position: 'absolute', top: -9, right: 12, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, zIndex: 1 },
  suspendedText: { fontSize: 9, letterSpacing: 0.8, textTransform: 'uppercase' },
  tile: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  typeTag: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  nameInput: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: '700', borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  iconBtn: { padding: 4, borderRadius: 8 },
  balance: { marginTop: 12, borderRadius: 12, padding: 10 },
  meta: { flexDirection: 'row', gap: 8, marginTop: 10 },
  entry: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 2, padding: 20 },
  entryIcon: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { marginBottom: 12 },
  list: { gap: 12 },
  value: { flexShrink: 1, marginLeft: 12, textAlign: 'right' },
  stateTag: { borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2 },
});
