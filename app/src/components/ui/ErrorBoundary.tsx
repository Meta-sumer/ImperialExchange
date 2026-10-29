import React, { Component, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './Button';

/**
 * Render-crash fallback, ported from client/src/components/ErrorBoundary.jsx.
 *
 * The web wraps the whole app in one. Here the navigator wraps EACH screen
 * (see navigation/RootNavigator), so a crash in the chart does not take the
 * header, the wallet and the way out with it.
 *
 * Same copy, same short error id for a bug report. "Reload page" has no
 * meaning in an app; "Try again" (reset the boundary) is the recovery, and
 * the header above is still there to navigate away.
 */

/**
 * `E-XXXXXX` from the message, ErrorBoundary.jsx:18 verbatim — so an id a
 * user quotes from the app matches one quoted from the web for the same
 * message.
 */
export const errorIdFor = (message: string): string => {
  const hash = Array.from(message || '').reduce((a, c) => (a << 5) - a + c.charCodeAt(0), 0);
  return `E-${Math.abs(hash).toString(36).slice(0, 6).toUpperCase()}`;
};

function Fallback({ error, errorId, onReset }: { error: Error; errorId: string; onReset: () => void }): React.JSX.Element {
  const t = useTheme();
  const [details, setDetails] = useState(false);
  return (
    <View style={[styles.wrap, { backgroundColor: t.colors.surface }]}>
      <View style={[styles.card, { backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark, borderRadius: t.radius.xl }]}>
        <AppText style={styles.emoji}>⚠️</AppText>
        <AppText variant="h2" align="center">Something went wrong</AppText>
        <AppText variant="body" tone="secondary" align="center" style={styles.gap}>
          Sorry — the app hit an unexpected error.
        </AppText>
        <AppText variant="small" tone="muted" mono align="center" style={styles.id}>Error ID: {errorId}</AppText>
        <Button title="Try again" onPress={onReset} />
        {error.message ? (
          <View style={styles.details}>
            <Pressable onPress={() => setDetails((d) => !d)} accessibilityRole="button">
              <AppText variant="small" tone="muted">Technical details</AppText>
            </Pressable>
            {details ? (
              <ScrollView style={[styles.pre, { backgroundColor: t.colors.bgPanel }]}>
                <AppText variant="micro" tone="muted" mono>{error.message}</AppText>
              </ScrollView>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

interface State { error: Error | null; errorId: string | null }

export class ErrorBoundary extends Component<{ children: ReactNode; onError?: (e: Error) => void }, State> {
  override state: State = { error: null, errorId: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, errorId: errorIdFor(error?.message ?? '') };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // The web's hook point for Sentry / Bugsnag, kept as one.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info.componentStack);
    this.props.onError?.(error);
  }

  reset = (): void => { this.setState({ error: null, errorId: null }); };

  override render(): ReactNode {
    const { error, errorId } = this.state;
    if (!error) return this.props.children;
    return <Fallback error={error} errorId={errorId ?? errorIdFor('')} onReset={this.reset} />;
  }
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 448, borderWidth: 1, padding: 32, alignItems: 'center' },
  emoji: { fontSize: 44, lineHeight: 52, marginBottom: 12 },
  gap: { marginTop: 8 },
  id: { marginTop: 4, marginBottom: 24 },
  details: { marginTop: 16, alignSelf: 'stretch' },
  pre: { marginTop: 8, maxHeight: 128, padding: 8, borderRadius: 6 },
});
