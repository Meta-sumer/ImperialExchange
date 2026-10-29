import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { loadInstruments, useInstrumentStore } from '@/api/instruments.api';
import { CreateAlertModal } from '@/components/alerts/CreateAlertModal';
import { AppText, Icon } from '@/components/ui';
import { useAuthStore } from '@/store/auth';
import { useTheme } from '@/theme';
import type { Instrument } from '@/types/trading';

import { NotificationCenter } from './NotificationCenter';
import { refreshWatchedAlerts, retainNotificationEngine, useUnreadCount } from './notificationStore';

/**
 * The bell — NotificationCenter.jsx's trigger: the bell with its unread
 * badge ("9+" past nine), the notification panel (a bottom sheet here), and
 * the quick "set a price alert" modal the panel's footer opens in place,
 * without leaving the page. For the HeaderBell chrome slot, which the
 * profile menu draws in its header, before the × (the app header no longer
 * carries it).
 *
 * The bell holds the engine (notificationStore) while mounted and signed in,
 * but the profile menu is mounted only while open — so NotificationEngineKeeper
 * below holds it for the whole signed-in session. The engine runs once
 * however many hold it. A closed panel renders nothing, and the alert modal
 * is not mounted until first used.
 */
export function HeaderBell(): React.JSX.Element {
  const t = useTheme();
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const unread = useUnreadCount();
  const [open, setOpen] = useState(false);
  const [alertOpen, setAlertOpen] = useState(false);
  const [alertUsed, setAlertUsed] = useState(false);

  useEffect(() => (userId ? retainNotificationEngine() : undefined), [userId]);

  const close = useCallback(() => setOpen(false), []);

  // The web closes the dropdown, opens the modal, and reads the symbol list
  // with `loadInstruments({ catalogOnly: true })`: the shared catalogue when
  // it is held, else the bare catalogue — the form needs symbol and name only.
  const [alertRows, setAlertRows] = useState<Instrument[] | null>(null);
  const openAlert = useCallback(() => {
    setOpen(false);
    setAlertUsed(true);
    setAlertOpen(true);
    loadInstruments({ catalogOnly: true })
      .then((rows) => setAlertRows(rows))
      .catch(() => { /* the modal still opens; its symbol list starts empty */ });
  }, []);

  const badge = unread > 9 ? '9+' : String(unread);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Notifications"
        accessibilityValue={unread > 0 ? { text: `${unread} unread` } : undefined}
        onPress={() => setOpen((o) => !o)}
        hitSlop={4}
        style={({ pressed }) => [styles.btn, { borderRadius: t.radius.lg }, pressed ? { backgroundColor: t.colors.bgHover } : null]}
      >
        <Icon name="bell" size={18} color={t.colors.textSecondary} />
        {unread > 0 ? (
          <View style={[styles.badge, { backgroundColor: t.colors.primary }]} pointerEvents="none">
            <AppText variant="micro" weight="700" color={t.colors.onPrimary} style={styles.badgeText}>{badge}</AppText>
          </View>
        ) : null}
      </Pressable>

      <NotificationCenter open={open} onClose={close} onCreateAlert={openAlert} />

      {alertUsed ? <BellAlertModal visible={alertOpen} rows={alertRows} onClose={() => setAlertOpen(false)} /> : null}
    </>
  );
}

/**
 * Keeps the notification engine running for whoever is signed in, with no
 * bell on screen — mounted once, outside the screens (GlobalOverlays).
 * Without it the engine would stop whenever the profile menu closes and miss
 * the order fills, alert crossings and server notifications in between.
 */
export function NotificationEngineKeeper(): null {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  useEffect(() => (userId ? retainNotificationEngine() : undefined), [userId]);
  return null;
}

/** CreateAlertModal with the shared catalogue (or the bare one read for it) as its symbol list. */
function BellAlertModal({
  visible,
  rows,
  onClose,
}: {
  visible: boolean;
  rows: Instrument[] | null;
  onClose: () => void;
}): React.JSX.Element {
  const shared = useInstrumentStore((s) => s.rows);
  const instruments = shared.length ? shared : rows ?? [];
  return (
    <CreateAlertModal
      visible={visible}
      instruments={instruments}
      onClose={onClose}
      onCreated={() => {
        onClose();
        refreshWatchedAlerts();
      }}
    />
  );
}

const styles = StyleSheet.create({
  btn: { padding: 8, alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    top: 4,
    right: 4,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 10, lineHeight: 12 },
});
