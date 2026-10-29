import { CommonActions } from '@react-navigation/native';
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import {
  AppText,
  Badge,
  BottomSheet,
  Divider,
  Icon,
  MenuItem,
  type IconName,
} from '@/components/ui';
import { useAuthStore } from '@/store/auth';
import { useSelectedAccountStore } from '@/store/selectedAccount';
import { useTheme } from '@/theme';
import { fmtMoney } from '@/utils/money';
import { subscribePositions, subscribeWallet } from '@/websocket/channels';

import { HeaderBell } from '../chromeSlots';
import { navigationRef } from '../navigationRef';
import type { RootStackParamList } from '../types';
import { accountChip, accountSubline, formatAccountLabel, initialsFor } from './accountRows';
import { useChrome } from './chromeState';
import {
  EQUITY_POLL_MS,
  balanceLabel,
  equityByAccount,
  fetchAccountsEquity,
  type AccountEquity,
} from './headerBalance';

/**
 * The profile menu — Layout.jsx's dropdown under the avatar, as a bottom
 * sheet (a 288px dropdown anchored to a 36px avatar is not a phone control).
 * Same sections in the same order:
 *
 *   name / email
 *   Switch account            (collapsed until tapped)
 *   Balance  ₹…               (the selected account's floating balance)
 *   Reports · Support · Chat with Support · Settings
 *   Log Out
 *
 * plus "Trading Terminal" — the header's Terminal button, which the web
 * hides below `sm` and which has nowhere else to live on a phone. Copy
 * Trading is not here: on EquityHub it is a primary destination (the pill
 * strip under the header).
 *
 * Mounted once (AppNavigation), opened from any header via chromeState.
 */

/**
 * GET /wallet/equity while the menu is open: on opening, every 5 s, and on
 * `user:wallet` / `user:positions` — Layout.jsx's poll. Only the newest
 * answer lands; a failed read keeps the last one. Dropped when the person
 * changes, so one user's balance never shows under the next one's name.
 */
function useMenuEquity(open: boolean): AccountEquity[] | null {
  const [list, setList] = useState<AccountEquity[] | null>(null);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  useEffect(() => { setList(null); }, [userId]);

  useEffect(() => {
    if (!open || !userId) return undefined;
    let alive = true;
    let seq = 0;
    const load = (): void => {
      seq += 1;
      const mine = seq;
      fetchAccountsEquity()
        .then((rows) => { if (alive && mine === seq) setList(rows); })
        .catch(() => { /* keep prior */ });
    };
    load();
    const timer = setInterval(load, EQUITY_POLL_MS);
    const offWallet = subscribeWallet(load);
    const offPositions = subscribePositions(load);
    return () => {
      alive = false;
      clearInterval(timer);
      offWallet();
      offPositions();
    };
  }, [open, userId]);

  return list;
}

/* ── Balance row ────────────────────────────────────────────────────── */

function BalanceRow({ label, onOpenWallet }: { label: string; onOpenWallet: () => void }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={styles.balance}>
      <Pressable
        accessibilityRole="link"
        accessibilityHint="Selected account floating balance (real-time)"
        onPress={onOpenWallet}
        style={styles.balanceLink}
      >
        <Icon name="wallet" size={18} color={t.colors.textMuted} />
        <AppText variant="body">Balance</AppText>
      </Pressable>
      <View style={styles.balanceFigures}>
        <AppText variant="small" weight="700" mono numberOfLines={1} testID="profile-balance">{label}</AppText>
      </View>
    </View>
  );
}

/* ── Account switcher ───────────────────────────────────────────────── */

function AccountSwitcher({
  floating,
  onPicked,
}: {
  floating: Map<string, number>;
  onPicked: () => void;
}): React.JSX.Element | null {
  const t = useTheme();
  const accounts = useSelectedAccountStore((s) => s.accounts);
  const selectedId = useSelectedAccountStore((s) => s.selectedId);
  const select = useSelectedAccountStore((s) => s.select);
  // Collapsed by default so the menu stays compact, as on the web.
  const [open, setOpen] = useState(false);

  if (!accounts.length) return null;
  const current = accounts.find((a) => a.id === selectedId);

  return (
    <View style={[styles.section, { borderBottomColor: t.colors.borderSubtle }]}>
      <MenuItem
        icon="switchAccount"
        label="Switch account"
        sublabel={formatAccountLabel(current) || 'Select an account'}
        onPress={() => setOpen((o) => !o)}
        right={<Icon name={open ? 'chevronUp' : 'chevronDown'} size={18} color={t.colors.textMuted} />}
      />
      {open ? (
        <View style={styles.accounts}>
          {accounts.map((a) => {
            const active = a.id === selectedId;
            const chip = accountChip(a);
            const bal = floating.get(a.id);
            return (
              <Pressable
                key={a.id}
                accessibilityRole="menuitem"
                accessibilityState={{ selected: active }}
                onPress={() => { select(a.id); onPicked(); }}
                style={({ pressed }) => [
                  styles.account,
                  {
                    borderRadius: t.radius.lg,
                    backgroundColor: active ? t.colors.primarySoft : pressed ? t.colors.bgHover : 'transparent',
                  },
                ]}
              >
                <View style={[styles.bullet, { backgroundColor: active ? t.colors.primary : t.colors.borderDark }]} />
                <View style={styles.flex}>
                  <View style={styles.accountTitle}>
                    <AppText variant="bodyStrong" numberOfLines={1} style={styles.shrink}>{formatAccountLabel(a)}</AppText>
                    <Badge label={chip} tone={chip === 'DEMO' ? 'demo' : 'live'} size="xs" />
                  </View>
                  <AppText variant="micro" tone="muted" numberOfLines={1}>{accountSubline(a)}</AppText>
                </View>
                <View style={styles.accountRight}>
                  {bal !== undefined ? (
                    <AppText
                      variant="micro"
                      weight="700"
                      mono
                      accessibilityHint="Floating balance (incl. open P&L)"
                    >
                      {fmtMoney(bal, 'INR')}
                    </AppText>
                  ) : null}
                  {active ? <Icon name="check" size={16} color={t.colors.primary} strokeWidth={2.5} /> : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

/* ── The menu ───────────────────────────────────────────────────────── */

type MenuLink = { icon: IconName; label: string; to: keyof RootStackParamList; params?: object };

const LINKS: MenuLink[] = [
  { icon: 'reports', label: 'Reports', to: 'Reports' },
  { icon: 'help', label: 'Support', to: 'Helpdesk' },
  { icon: 'chat', label: 'Chat with Support', to: 'HelpdeskChat' },
  { icon: 'settings', label: 'Settings', to: 'Profile' },
  { icon: 'terminal', label: 'Trading Terminal', to: 'Trade', params: { view: 'terminal' } },
];

export function ProfileMenu(): React.JSX.Element {
  const t = useTheme();
  const open = useChrome((s) => s.profileOpen);
  const close = useChrome((s) => s.closeProfile);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const selectedId = useSelectedAccountStore((s) => s.selectedId);
  const [leaving, setLeaving] = useState(false);
  const { fullName } = initialsFor(user?.firstName, user?.lastName);

  const equity = useMenuEquity(open);
  const floating = useMemo(() => equityByAccount(equity), [equity]);
  const label = balanceLabel(equity, selectedId);

  // Whatever moves the app on closes the menu — a notification opened from
  // the bell in its header included, which would otherwise leave the menu
  // standing over the page it opened.
  useEffect(() => {
    if (!open || !navigationRef.isReady()) return undefined;
    return navigationRef.addListener('state', close);
  }, [open, close]);

  const go = (to: keyof RootStackParamList, params?: object): void => {
    close();
    if (navigationRef.isReady()) navigationRef.dispatch(CommonActions.navigate(to, params, { pop: true }));
  };

  const handleLogout = async (): Promise<void> => {
    if (leaving) return;
    setLeaving(true);
    close();
    // No navigate('/login') as on the web — the root navigator swaps to the
    // signed-out stack, with Login on top, the moment status changes.
    try { await logout(); } finally { setLeaving(false); }
  };

  return (
    <BottomSheet
      open={open}
      onClose={close}
      bodyPadding={0}
      // The notifications bell, as in the app header, before the ×.
      headerRight={HeaderBell ? <HeaderBell /> : null}
      title={(
        <View>
          <AppText variant="bodyStrong" numberOfLines={1}>{fullName}</AppText>
          <AppText variant="small" tone="muted" numberOfLines={1}>{user?.email ?? ''}</AppText>
        </View>
      )}
    >
      <AccountSwitcher floating={floating} onPicked={close} />
      <BalanceRow label={label} onOpenWallet={() => go('Wallet')} />
      {LINKS.map((l) => (
        <MenuItem key={l.label} icon={l.icon} label={l.label} onPress={() => go(l.to, l.params)} />
      ))}
      <Divider />
      <MenuItem icon="logout" label="Log Out" danger onPress={() => { void handleLogout(); }} />
      <View style={{ height: t.space.sm }} />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  section: { borderBottomWidth: 1 },
  accounts: { paddingHorizontal: 8, paddingBottom: 8, gap: 2 },
  account: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 8 },
  accountRight: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  bullet: { width: 6, height: 6, borderRadius: 3 },
  accountTitle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  balance: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    minHeight: 44,
  },
  balanceLink: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  balanceFigures: { alignItems: 'flex-end', flexShrink: 1 },
});
