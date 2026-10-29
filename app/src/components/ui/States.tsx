import React, { useEffect, useRef, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  StyleSheet,
  View,
  type DimensionValue,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { errorMessage } from '@/api/client';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';

/**
 * Loading, error, empty and skeleton states.
 *
 * The web has no shared component for most of these — every page writes its
 * own "Loading…" and "No data" — so these take the chrome's versions as the
 * reference: App.jsx's RouteFallback for loading, ComingSoon.jsx's
 * icon-tile layout for empty, ErrorBoundary.jsx's card for errors.
 */

/**
 * App.jsx `RouteFallback` — a primary spinner and "Loading…" in text-xs
 * muted, centred. `fullScreen` fills the parent (the boot gate, a screen
 * that has nothing to show yet); otherwise it is a 60vh-ish block.
 */
export function LoadingView({
  label = 'Loading…',
  fullScreen = false,
  style,
}: {
  label?: string | null;
  fullScreen?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label ?? 'Loading'}
      style={[
        styles.center,
        fullScreen ? { flex: 1, backgroundColor: t.colors.surface } : styles.block,
        style,
      ]}
    >
      <ActivityIndicator size="large" color={t.colors.primary} />
      {label ? <AppText variant="small" tone="muted" style={styles.gap}>{label}</AppText> : null}
    </View>
  );
}

/** Just the spinner, inline. */
export function Spinner({ size = 'small', color }: { size?: 'small' | 'large'; color?: string }): React.JSX.Element {
  const t = useTheme();
  return <ActivityIndicator size={size} color={color ?? t.colors.primary} />;
}

/**
 * A failed load, with the server's own message and a retry.
 *
 * `error` may be the caught value itself; the message is extracted the way
 * api.js does it — the server's wording first, because the server is the
 * one that knows why it refused.
 */
export function ErrorView({
  error,
  title = 'Something went wrong',
  onRetry,
  retryLabel = 'Try again',
  compact = false,
  style,
}: {
  error?: unknown;
  title?: string;
  onRetry?: () => void;
  retryLabel?: string;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  const message = typeof error === 'string' ? error : error ? errorMessage(error) : null;
  return (
    <View accessibilityRole="alert" style={[styles.center, compact ? styles.compact : styles.block, style]}>
      <View style={[styles.tile, { backgroundColor: t.colors.bearSoft, borderColor: t.alpha(t.colors.bear, 0.3) }]}>
        <Icon name="alert" size={compact ? 20 : 28} color={t.colors.bear} />
      </View>
      <AppText variant={compact ? 'bodyStrong' : 'title'} align="center" style={styles.gap}>{title}</AppText>
      {message ? (
        <AppText variant="body" tone="secondary" align="center" style={styles.msg}>{message}</AppText>
      ) : null}
      {onRetry ? (
        <Button title={retryLabel} variant="secondary" size="sm" leftIcon="refresh" onPress={onRetry} style={styles.action} />
      ) : null}
    </View>
  );
}

/**
 * Nothing to show — ComingSoon.jsx's layout: a tinted icon tile, a title,
 * one line of muted copy, and an optional call to action.
 */
export function EmptyState({
  icon = 'inbox',
  title,
  message,
  actionLabel,
  onAction,
  children,
  style,
}: {
  icon?: IconName;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[styles.center, styles.compact, style]}>
      <View style={[styles.tile, { backgroundColor: t.colors.primarySoft, borderColor: t.alpha(t.colors.primary, 0.3) }]}>
        <Icon name={icon} size={24} color={t.colors.primaryText} strokeWidth={1.5} />
      </View>
      <AppText variant="bodyStrong" align="center" style={styles.gap}>{title}</AppText>
      {message ? <AppText variant="small" tone="muted" align="center" style={styles.msg}>{message}</AppText> : null}
      {actionLabel && onAction ? (
        <Button title={actionLabel} size="sm" onPress={onAction} style={styles.action} />
      ) : null}
      {children}
    </View>
  );
}

/**
 * A placeholder block that pulses — the web's `animate-pulse` /
 * `.pulse-live` (opacity 1 → 0.5 → 1).
 */
export function Skeleton({
  width = '100%',
  height = 14,
  radius,
  style,
}: {
  width?: DimensionValue;
  height?: DimensionValue;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.5, duration: 800, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        { width, height, borderRadius: radius ?? t.radius.sm, backgroundColor: t.colors.skeleton, opacity: pulse },
        style,
      ]}
    />
  );
}

/** A paragraph of skeleton lines, the last one short. */
export function SkeletonText({ lines = 3, gap = 8 }: { lines?: number; gap?: number }): React.JSX.Element {
  return (
    <View style={{ gap }}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 && lines > 1 ? '60%' : '100%'} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  block: { minHeight: 320, paddingVertical: 32 },
  compact: { paddingVertical: 24 },
  gap: { marginTop: 12 },
  msg: { marginTop: 4, maxWidth: 360 },
  action: { marginTop: 16 },
  tile: {
    width: 56,
    height: 56,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
