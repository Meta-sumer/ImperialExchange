import React, { useEffect } from 'react';
import { BackHandler, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useGlobalAlerts } from '@/api/alerts.api';
import { HtmlContent } from '@/components/news/HtmlContent';
import { AppText, Button, Portal } from '@/components/ui';
import { useAuthStore } from '@/store/auth';
import { useTheme, type AppTheme } from '@/theme';
import type { GlobalAlertPriority } from '@/types/market';

/**
 * The web's popup sits at z-index 2000 — above every modal (1000) and the
 * confirm layer (1100): an announcement a trader must acknowledge is not
 * hidden behind whatever they had open. Toasts (Z.toast) stay above it.
 */
export const GLOBAL_ALERT_Z = 2000;

const TRIANGLE = 'M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z';
const CIRCLE_INFO = 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z';

/** GlobalAlertPopup.jsx `PRIORITY`: label, ring, header fill and glyph. */
export const PRIORITY_META: Record<GlobalAlertPriority, { label: string; icon: string }> = {
  CRITICAL: { label: 'Critical', icon: TRIANGLE },
  WARNING: { label: 'Warning', icon: TRIANGLE },
  INFO: { label: 'Info', icon: CIRCLE_INFO },
};

/** amber-400 / amber-500 — the web's WARNING colours are stock Tailwind, not tokens. */
const AMBER_400 = '#FBBF24';
const AMBER_500 = '#F59E0B';

const priorityColors = (t: AppTheme, p: GlobalAlertPriority): { ring: string; head: string } => {
  if (p === 'CRITICAL') return { ring: t.alpha(t.colors.bear, 0.6), head: t.colors.bear };
  if (p === 'WARNING') return { ring: t.alpha(AMBER_400, 0.6), head: AMBER_500 };
  return { ring: t.alpha(t.colors.primary, 0.5), head: t.colors.primary };
};

/**
 * The platform's blocking announcement — GlobalAlertPopup.jsx, mounted once
 * for the whole app (the GlobalOverlays slot).
 *
 * A centred card over a dimmed screen. It cannot be dismissed by a tap
 * outside or by Android's back button (the web ignores backdrop clicks and
 * ESC); the only action is OK, which acknowledges the alert and moves on to
 * the next one — Critical → Warning → Info, in the server's order. "1 of N"
 * shows while more are queued.
 *
 * Pending alerts are pulled on sign-in, every 60 s, on return to the
 * foreground (the web's window focus) and at once on an `alerts:refresh`
 * nudge (alerts.api `useGlobalAlerts`). Signing out clears the queue.
 * An OK whose acknowledge fails still dismisses it for this session, as on
 * the web, so a network blip cannot trap the trader behind it.
 */
export function GlobalAlertPopup(): React.JSX.Element | null {
  const t = useTheme();
  const { height } = useWindowDimensions();
  const signedIn = useAuthStore((s) => !!s.user);
  const { current, total, acking, acknowledge } = useGlobalAlerts(signedIn);

  // Android back is swallowed while an alert is up: OK is the only way out.
  useEffect(() => {
    if (!current) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [current]);

  if (!current) return null;
  const meta = PRIORITY_META[current.priority] ?? PRIORITY_META.INFO;
  const colors = priorityColors(t, current.priority);

  return (
    <Portal z={GLOBAL_ALERT_Z}>
      <View
        style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: 'rgba(0,0,0,0.6)' }]}
        accessibilityViewIsModal
        testID="global-alert-popup"
      >
        <View
          accessibilityRole="alert"
          style={[
            styles.card,
            t.shadow.modal,
            {
              backgroundColor: t.colors.surface,
              borderColor: colors.ring,
              borderRadius: t.radius.xxl,
              maxHeight: height * 0.85,
            },
          ]}
        >
          {/* Header */}
          <View style={[styles.head, { backgroundColor: colors.head }]}>
            <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <Path d={meta.icon} />
            </Svg>
            <AppText variant="bodyStrong" weight="700" color="#FFFFFF" style={styles.headLabel}>{meta.label}</AppText>
            {total > 1 ? (
              <AppText variant="caption" weight="600" color="#FFFFFF" style={styles.count}>{`1 of ${total}`}</AppText>
            ) : null}
          </View>

          {/* Body */}
          <ScrollView style={{ maxHeight: height * 0.5 }} contentContainerStyle={styles.body} bounces={false}>
            <AppText variant="h3" weight="800" style={styles.title}>{current.title}</AppText>
            {/* The web's `cms-content` div — the same renderer as a news article's body. */}
            <HtmlContent html={current.message} testID="global-alert-message" />
          </ScrollView>

          {/* Footer — OK is the only way out */}
          <View style={[styles.foot, { borderTopColor: t.colors.borderSubtle }]}>
            <Button
              title="OK"
              loadingTitle="Please wait…"
              loading={acking}
              onPress={() => { void acknowledge(); }}
              style={styles.ok}
            />
          </View>
        </View>
      </View>
    </Portal>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 448, borderWidth: 2, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingVertical: 12 },
  headLabel: { textTransform: 'uppercase', letterSpacing: 0.6 },
  count: { marginLeft: 'auto', opacity: 0.9 },
  body: { paddingHorizontal: 20, paddingVertical: 16 },
  title: { marginBottom: 8 },
  foot: { borderTopWidth: 1, paddingHorizontal: 20, paddingVertical: 12, alignItems: 'flex-end' },
  ok: { paddingHorizontal: 32 },
});
