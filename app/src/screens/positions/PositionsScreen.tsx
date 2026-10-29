import { useIsFocused } from '@react-navigation/native';
import React from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { PositionsPanel } from '@/components/orders/PositionsPanel';
import { AppText, Screen } from '@/components/ui';
import type { AppScreenProps } from '@/navigation/types';
import { useTheme } from '@/theme';

/**
 * Positions — EquityHub's client/src/pages/Positions.jsx (`/positions`, the
 * mobile nav's "Positions").
 *
 * Open positions and pending orders on their own route, so closing a trade
 * is one tap from anywhere rather than a trip into the terminal. The panel
 * (components/orders/PositionsPanel) is self-contained — it fetches its own
 * data and owns close / cancel — so this page is only a frame around it, and
 * the same component backs the Positions tab on an instrument page.
 *
 * No symbol filter here: this is the whole account. Ticks and refetches are
 * released while the page is not focused.
 */
export function PositionsScreen(_props: AppScreenProps<'Positions'>): React.JSX.Element {
  const t = useTheme();
  const focused = useIsFocused();
  const { height } = useWindowDimensions();
  return (
    <Screen testID="positions-screen">
      <View style={s.head}>
        <AppText variant="h2" accessibilityRole="header">Positions</AppText>
        <AppText variant="small" tone="muted" style={s.sub}>
          Everything currently open, and orders still waiting to trigger. Close or cancel from here.
        </AppText>
      </View>
      <View
        style={[
          s.card,
          { borderColor: t.colors.borderDark, backgroundColor: t.colors.bgCard, borderRadius: t.radius.xxl, height: Math.max(380, Math.round(height * 0.7)) },
        ]}
      >
        <PositionsPanel active={focused} testID="positions" />
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  head: { marginBottom: 16 },
  sub: { marginTop: 2 },
  card: { borderWidth: 1, overflow: 'hidden' },
});
