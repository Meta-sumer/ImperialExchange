import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { authApi } from '@/api/auth.api';
import { errorMessage } from '@/api/client';
import { AppText, toast, useConfirm } from '@/components/ui';
import { useTheme } from '@/theme';
import type { SessionDevice } from '@/types/user';
import { REVOKE_CONFIRM, SESSION_NOT_FOUND, deviceActivity, sessionsSubtitle } from '@/utils/profile';

import { IconTile, MiniAction, SectionCard } from './ProfilePrimitives';

/**
 * Profile.jsx DevicesTab — every signed-in session, the one this app is
 * using first and marked "This device" (it has no Revoke: signing out is
 * how this one ends), each with when it was last active and when it
 * signed in.
 *
 * The list is the user's own sessions, capped by the plan's device limit
 * (the server signs the least recently used one out past it), so it renders
 * in the page's scroll like the web's divide-y list.
 */
export function DevicesTab({ reloadSignal }: { reloadSignal: number }): React.JSX.Element {
  const t = useTheme();
  const confirm = useConfirm();
  const [devices, setDevices] = useState<SessionDevice[]>([]);
  const [loading, setLoading] = useState(true);
  // Set in the setup, not only cleared in the cleanup: StrictMode and Fast
  // Refresh replay cleanup + setup on a live component, and a flag only
  // ever cleared would leave the tab on "Loading sessions…" for good.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // Reads overlap (the mount, pull to refresh, coming back to the app, the
  // reload after a revoke) and can answer out of order. Only an answer to a
  // later request than the one on screen is shown, so a list read before a
  // revoke cannot put the revoked session back after the post-revoke list.
  const issued = useRef(0);
  const shown = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++issued.current;
    try {
      const list = await authApi.listDevices();
      if (alive.current && mine > shown.current) {
        shown.current = mine;
        setDevices(list);
      }
    } catch {
      /* ignore — Profile.jsx */
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh, reloadSignal]);

  const revoke = async (device: SessionDevice): Promise<void> => {
    if (!(await confirm(REVOKE_CONFIRM))) return;
    if (!device.id) { toast.error(SESSION_NOT_FOUND); return; }
    try {
      await authApi.revokeDevice(device.id);
      toast.success('Session revoked');
      void refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <SectionCard
      icon="monitor"
      title="Active sessions"
      subtitle={sessionsSubtitle(loading, devices.length)}
      padded={false}
    >
      {loading ? (
        <View style={styles.loading}>
          <AppText variant="body" tone="muted" align="center">Loading sessions…</AppText>
        </View>
      ) : devices.length === 0 ? (
        <View style={styles.empty}>
          <IconTile icon="monitor" size={48} iconSize={24} tone="muted" />
          <AppText variant="body" tone="muted" style={styles.gap12}>No active sessions</AppText>
        </View>
      ) : (
        devices.map((d, i) => (
          <View
            key={d.id ?? `idx-${i}`}
            testID="device-row"
            style={[styles.row, i > 0 ? { borderTopWidth: 1, borderTopColor: t.colors.borderSubtle } : null]}
          >
            <IconTile icon="monitor" />
            <View style={styles.flex}>
              <View style={styles.nameRow}>
                <AppText variant="body" weight="700" numberOfLines={1} style={styles.shrink}>
                  {d.deviceInfo || 'Unknown device'}
                </AppText>
                {d.current ? (
                  <View style={[styles.thisDevice, { backgroundColor: t.alpha(t.colors.bull, 0.15) }]}>
                    <AppText variant="micro" weight="800" color={t.colors.bull} style={styles.upper}>This device</AppText>
                  </View>
                ) : null}
              </View>
              <AppText variant="caption" tone="muted">{deviceActivity(d)}</AppText>
            </View>
            {d.current ? (
              <AppText variant="caption" weight="700" tone="muted" style={[styles.upper, styles.current]}>Current</AppText>
            ) : (
              <MiniAction
                label="Revoke"
                tone="bear"
                accessibilityLabel={`Revoke ${d.deviceInfo || 'Unknown device'}`}
                onPress={() => { void revoke(d); }}
              />
            )}
          </View>
        ))
      )}
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  loading: { paddingHorizontal: 20, paddingVertical: 32 },
  empty: { paddingHorizontal: 20, paddingVertical: 40, alignItems: 'center' },
  gap12: { marginTop: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 12 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  thisDevice: { borderRadius: 999, paddingHorizontal: 6, paddingVertical: 2 },
  upper: { textTransform: 'uppercase', letterSpacing: 0.6 },
  current: { paddingHorizontal: 10, paddingVertical: 4 },
});
