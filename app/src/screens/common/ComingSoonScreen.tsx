import { CommonActions, useRoute } from '@react-navigation/native';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText, Button, Icon, Screen } from '@/components/ui';
import { isAuthed } from '@/navigation/authGate';
import { useAppNavigation } from '@/navigation/types';
import { pathForRoute } from '@/navigation/webPaths';
import { useTheme } from '@/theme';

/**
 * The stand-in every route is registered to until its real screen is
 * ported — the web's own ComingSoon.jsx layout (clock tile, phase chip,
 * title, one line, "Back to Dashboard").
 *
 * It names the route and the web path it stands for, so anyone opening it
 * knows exactly which page is missing rather than guessing from a blank.
 */

/** "BonusWallet" → "Bonus Wallet". */
export const humanise = (name: string): string =>
  name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');

export function ComingSoonScreen(): React.JSX.Element {
  const t = useTheme();
  const route = useRoute();
  const navigation = useAppNavigation();
  const authed = isAuthed();
  const path = pathForRoute({ name: route.name as never, params: route.params });

  return (
    <Screen contentContainerStyle={styles.center}>
      <View style={styles.inner}>
        <View style={[styles.tile, { backgroundColor: t.colors.primarySoft, borderColor: t.alpha(t.colors.primary, 0.3) }]}>
          <Icon name="clock" size={40} color={t.colors.primaryText} strokeWidth={1.5} />
        </View>
        <View style={[styles.chip, { backgroundColor: t.colors.primarySoft, borderColor: t.alpha(t.colors.primary, 0.3) }]}>
          <AppText variant="smallStrong" tone="brand">Being ported</AppText>
        </View>
        <AppText variant="h1" align="center">{humanise(route.name)}</AppText>
        <AppText variant="body" tone="secondary" align="center" style={styles.gap}>
          This screen is being ported from the web app.
        </AppText>
        <AppText variant="small" tone="muted" mono align="center" style={styles.gap}>{path}</AppText>
        <Button
          title={authed ? 'Back to Dashboard' : 'Sign In'}
          style={styles.cta}
          onPress={() => navigation.dispatch(
            CommonActions.navigate(authed ? 'Dashboard' : 'Login', undefined, { pop: true }),
          )}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flexGrow: 1, justifyContent: 'center' },
  inner: { alignItems: 'center', gap: 4, minHeight: 420, justifyContent: 'center' },
  tile: { width: 80, height: 80, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  chip: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, borderWidth: 1, marginBottom: 12 },
  gap: { marginTop: 8 },
  cta: { marginTop: 20 },
});
