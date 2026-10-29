import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { AppText, BottomSheet, Button, Icon, IconButton, SwitchRow, Tabs } from '@/components/ui';
import { navigateToPath } from '@/navigation/linking';
import {
  dismissPushPrompt,
  openPushSettings,
  requestPushPermission,
  shouldOfferPushPrompt,
  usePushStore,
} from '@/services/push';
import { useTheme } from '@/theme';
import {
  NOTIFICATION_META,
  NOTIFICATION_TABS,
  bellEmptyText,
  bellRelativeTime,
  notificationsForTab,
  statusDot,
  type BellNotification,
  type NotificationMeta,
  type NotificationTab,
} from '@/types/notifications';

import { useNotifications } from './notificationStore';

/**
 * NotificationCenter.jsx's dropdown, as a bottom sheet: the header with the
 * unread chip, "Mark all read" and the preferences toggle; the All / Trading
 * / Markets / Account tabs; the list; and the footer's "+ Price alert" and
 * "Clear all". The preferences pane has the web's three channel switches.
 *
 * Added for the phone, with no web equivalent: the push-notification offer
 * at the top of the list (only while the OS has not been asked and it was
 * not waved away) and a "Push notifications" row in the preferences pane.
 */

type TabKey = NotificationTab | 'All';

/** NotificationCenter.jsx ICONS, path for path. */
function NotificationGlyph({ icon, color }: { icon: NotificationMeta['icon']; color: string }): React.JSX.Element {
  const p = { stroke: color, strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  let body: React.ReactNode;
  switch (icon) {
    case 'order':
      body = <Path d="M9 11l3 3L22 4M22 12v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" {...p} />;
      break;
    case 'signal':
      body = (
        <>
          <Path d="M2 12h4" {...p} /><Path d="M10 7h4" {...p} /><Path d="M18 2h4" {...p} />
          <Path d="M2 18h4" {...p} /><Path d="M10 13h4" {...p} /><Path d="M18 8h4" {...p} />
        </>
      );
      break;
    case 'pie':
      body = <><Circle cx={12} cy={12} r={10} {...p} /><Path d="M12 2v10l8 6" {...p} /></>;
      break;
    case 'bolt':
      body = <Path d="M13 2L3 14h7l-1 8 10-12h-7z" {...p} />;
      break;
    case 'filter':
      body = <Path d="M22 3H2l8 9.5V19l4 2v-8.5z" {...p} />;
      break;
    case 'user':
      body = <><Circle cx={12} cy={8} r={4} {...p} /><Path d="M4 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2" {...p} /></>;
      break;
    case 'bell':
    default:
      body = <><Path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" {...p} /><Path d="M13.73 21a2 2 0 0 1-3.46 0" {...p} /></>;
  }
  return <Svg width={16} height={16} viewBox="0 0 24 24">{body}</Svg>;
}

const NotificationRow = React.memo(function NotificationRow({
  n,
  now,
  onPress,
}: {
  n: BellNotification;
  now: number;
  onPress: (n: BellNotification) => void;
}): React.JSX.Element {
  const t = useTheme();
  const meta = NOTIFICATION_META[n.type] ?? NOTIFICATION_META.TRADING;
  return (
    <Pressable
      accessibilityRole={n.link ? 'link' : 'button'}
      accessibilityLabel={`${meta.label}. ${n.title}${n.message ? `. ${n.message}` : ''}${n.read ? '' : '. Unread'}`}
      onPress={() => onPress(n)}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: t.colors.borderSubtle },
        !n.read ? { backgroundColor: t.alpha(t.brand.primary500, 0.04) } : null,
        pressed ? { backgroundColor: t.colors.bgHover } : null,
      ]}
    >
      <View style={[styles.iconCircle, { backgroundColor: t.alpha(meta.tint, 0.094) }]}>
        <NotificationGlyph icon={meta.icon} color={meta.tint} />
      </View>
      <View style={styles.rowBody}>
        <View style={styles.metaRow}>
          <AppText variant="micro" weight="700" color={meta.tint} style={styles.metaLabel}>
            {meta.label}
          </AppText>
          <View style={[styles.statusDot, { backgroundColor: statusDot(n.status) }]} />
        </View>
        <AppText variant="bodyStrong" numberOfLines={1} style={styles.gapXs}>{n.title}</AppText>
        {n.message ? (
          <AppText variant="small" tone="secondary" numberOfLines={2} style={styles.gapXs}>{n.message}</AppText>
        ) : null}
        <AppText variant="micro" tone="muted" mono style={styles.time}>{bellRelativeTime(n.timestamp, now)}</AppText>
      </View>
      {!n.read ? <View style={[styles.unreadDot, { backgroundColor: t.colors.primary }]} /> : null}
    </Pressable>
  );
});

/** The phone-only offer to turn push on — polite: it explains, and "Not now" is final. */
function PushOffer(): React.JSX.Element | null {
  const t = useTheme();
  const status = usePushStore((s) => s.status);
  const canAskAgain = usePushStore((s) => s.canAskAgain);
  const promptDismissed = usePushStore((s) => s.promptDismissed);
  const busy = usePushStore((s) => s.busy);
  if (!shouldOfferPushPrompt({ status, canAskAgain, promptDismissed })) return null;
  return (
    <View style={[styles.offer, { backgroundColor: t.colors.primarySoft, borderColor: t.alpha(t.brand.primary500, 0.25) }]}>
      <AppText variant="bodyStrong">Turn on push notifications?</AppText>
      <AppText variant="small" tone="secondary" style={styles.gapXs}>
        Get order fills, price alerts and account updates on this phone, even when the app is closed.
      </AppText>
      <View style={styles.offerActions}>
        <Button title="Not now" variant="ghost" size="sm" disabled={busy} onPress={() => { void dismissPushPrompt(); }} />
        <Button title="Turn on" size="sm" loading={busy} onPress={() => { void requestPushPermission(); }} />
      </View>
    </View>
  );
}

/** Preferences pane: the push row (phone only). */
function PushPreference(): React.JSX.Element {
  const t = useTheme();
  const status = usePushStore((s) => s.status);
  const canAskAgain = usePushStore((s) => s.canAskAgain);
  const busy = usePushStore((s) => s.busy);
  let detail: string;
  let action: React.ReactNode = null;
  if (status === 'granted') {
    detail = 'On for this phone.';
  } else if (status === 'unavailable') {
    detail = 'Not available in this build of the app.';
  } else if (status === 'denied' || !canAskAgain) {
    detail = 'Off. Allow notifications for EquityHub in your phone’s Settings.';
    action = <Button title="Open Settings" variant="secondary" size="sm" onPress={() => { void openPushSettings(); }} />;
  } else if (status === 'undetermined') {
    detail = 'Off.';
    action = <Button title="Turn on" size="sm" loading={busy} onPress={() => { void requestPushPermission(); }} />;
  } else {
    detail = 'Checking…';
  }
  return (
    <View style={[styles.pushPref, { borderTopColor: t.colors.borderSubtle }]}>
      <View style={styles.flex}>
        <AppText variant="body">Push notifications</AppText>
        <AppText variant="small" tone="muted">{detail}</AppText>
      </View>
      {action}
    </View>
  );
}

export interface NotificationCenterProps {
  open: boolean;
  onClose: () => void;
  /** "+ Price alert" — the bell closes this and opens the create-alert modal. */
  onCreateAlert: () => void;
}

export function NotificationCenter({ open, onClose, onCreateAlert }: NotificationCenterProps): React.JSX.Element {
  const t = useTheme();
  const { notifications, unreadCount, markAllRead } = useNotifications();
  const [view, setView] = useState<'list' | 'prefs'>('list');
  const [tab, setTab] = useState<TabKey>('All');

  // Reset to the list and "All" whenever the panel closes, as the web does.
  useEffect(() => {
    if (!open) { setView('list'); setTab('All'); }
  }, [open]);

  const title = (
    <View style={styles.header}>
      <View style={styles.headerLeft}>
        <AppText variant="bodyStrong" weight="700">Notifications</AppText>
        {unreadCount > 0 ? (
          <View style={[styles.newChip, { backgroundColor: t.colors.primarySoft }]}>
            <AppText variant="micro" weight="700" color={t.colors.primaryText}>{`${unreadCount} new`}</AppText>
          </View>
        ) : null}
      </View>
      <View style={styles.headerRight}>
        {view === 'list' && notifications.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Mark all as read"
            onPress={markAllRead}
            hitSlop={6}
            style={styles.markAll}
          >
            <AppText variant="caption" weight="600" color={t.colors.primaryText}>Mark all read</AppText>
          </Pressable>
        ) : null}
        <IconButton
          name={view === 'list' ? 'settings' : 'chevronLeft'}
          size={16}
          accessibilityLabel={view === 'list' ? 'Notification preferences' : 'Back'}
          onPress={() => setView((v) => (v === 'list' ? 'prefs' : 'list'))}
        />
      </View>
    </View>
  );

  const footer = view === 'list' ? (
    <View style={[styles.footer, { borderColor: t.colors.borderSubtle }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Set a price alert"
        onPress={onCreateAlert}
        style={({ pressed }) => [styles.footerBtn, pressed ? { backgroundColor: t.colors.bgHover } : null]}
      >
        <Icon name="bell" size={13} color={t.colors.primaryText} strokeWidth={2} />
        <AppText variant="caption" weight="600" color={t.colors.primaryText}>+ Price alert</AppText>
      </Pressable>
      {notifications.length > 0 ? <ClearAll /> : null}
    </View>
  ) : undefined;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={title}
      footer={footer}
      scrollable={false}
      bodyPadding={0}
      testID="notification-center"
    >
      {view === 'list' ? (
        <NotificationList tab={tab} onTab={setTab} onNavigate={onClose} />
      ) : (
        <Preferences />
      )}
    </BottomSheet>
  );
}

function ClearAll(): React.JSX.Element {
  const t = useTheme();
  const { clear } = useNotifications();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={clear}
      style={({ pressed }) => [
        styles.footerBtn,
        styles.footerDivider,
        { borderLeftColor: t.colors.borderSubtle },
        pressed ? { backgroundColor: t.colors.bgHover } : null,
      ]}
    >
      {({ pressed }) => (
        <AppText variant="caption" weight="600" color={pressed ? t.colors.bear : t.colors.textSecondary}>Clear all</AppText>
      )}
    </Pressable>
  );
}

function NotificationList({
  tab,
  onTab,
  onNavigate,
}: {
  tab: TabKey;
  onTab: (t: TabKey) => void;
  onNavigate: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const { notifications, markRead } = useNotifications();
  const filtered = useMemo(() => notificationsForTab(notifications, tab), [notifications, tab]);

  // Live-tick the relative timestamps while the panel is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [notifications]);

  const onPress = useCallback((n: BellNotification) => {
    markRead(n.id);
    if (n.link) {
      onNavigate();
      navigateToPath(n.link);
    }
  }, [markRead, onNavigate]);

  const tabs = useMemo(() => NOTIFICATION_TABS.map((k) => ({ key: k, label: k })), []);

  return (
    <View style={styles.flexShrink}>
      <PushOffer />
      <Tabs tabs={tabs} value={tab} onChange={onTab} />
      <FlatList
        data={filtered}
        keyExtractor={(n) => n.id}
        style={styles.list}
        extraData={now}
        renderItem={({ item }) => <NotificationRow n={item} now={now} onPress={onPress} />}
        ListEmptyComponent={(
          <View style={styles.empty}>
            <View style={[styles.emptyIcon, { backgroundColor: t.colors.bgHover }]}>
              <Icon name="bell" size={20} color={t.colors.textMuted} />
            </View>
            <AppText variant="bodyStrong" align="center">You&apos;re all caught up</AppText>
            <AppText variant="small" tone="muted" align="center" style={styles.gapXs}>{bellEmptyText(tab)}</AppText>
          </View>
        )}
      />
    </View>
  );
}

function Preferences(): React.JSX.Element {
  const t = useTheme();
  const { prefs, updatePrefs } = useNotifications();
  return (
    <View>
      <View style={[styles.prefsHead, { borderBottomColor: t.colors.borderSubtle }]}>
        <AppText variant="caption" weight="700" tone="muted" style={styles.upper}>Channels</AppText>
      </View>
      <SwitchRow
        label="Trading (orders, positions, portfolio)"
        value={prefs.enableTrading}
        onValueChange={(v) => updatePrefs({ enableTrading: v })}
        style={styles.prefRow}
      />
      <SwitchRow
        label="Markets (price, volatility, screener)"
        value={prefs.enableMarkets}
        onValueChange={(v) => updatePrefs({ enableMarkets: v })}
        style={styles.prefRow}
      />
      <SwitchRow
        label="Account (wallet, security)"
        value={prefs.enableAccount}
        onValueChange={(v) => updatePrefs({ enableAccount: v })}
        style={styles.prefRow}
      />
      <PushPreference />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  flexShrink: { flexShrink: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  newChip: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999 },
  markAll: { paddingHorizontal: 8, paddingVertical: 4 },
  list: { flexGrow: 0, flexShrink: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconCircle: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1, minWidth: 0 },
  metaRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  metaLabel: { textTransform: 'uppercase', letterSpacing: 0.6 },
  statusDot: { width: 6, height: 6, borderRadius: 3, marginTop: 4 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, marginTop: 8 },
  gapXs: { marginTop: 2 },
  time: { marginTop: 6 },
  empty: { alignItems: 'center', paddingHorizontal: 24, paddingVertical: 48 },
  emptyIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  footer: { flexDirection: 'row', alignItems: 'stretch', margin: -16 },
  footerBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12 },
  footerDivider: { borderLeftWidth: 1 },
  prefsHead: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  upper: { textTransform: 'uppercase', letterSpacing: 0.6 },
  prefRow: { paddingHorizontal: 16 },
  offer: { margin: 12, padding: 12, borderRadius: 12, borderWidth: 1 },
  offerActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 10 },
  pushPref: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 8,
  },
});
