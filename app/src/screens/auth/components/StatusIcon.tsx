import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/ui';
import { useTheme } from '@/theme';

/**
 * The 56px round badge the auth pages open a result with —
 * `mx-auto w-14 h-14 rounded-full bg-<tone>/15 text-<tone>`: a tick for
 * success, a cross or an "!" for failure, a spinner while working.
 */
export function StatusIcon({
  kind,
}: {
  kind: 'success' | 'error' | 'alert' | 'working';
}): React.JSX.Element {
  const t = useTheme();
  const tone = kind === 'success' ? t.colors.bull : kind === 'working' ? t.brand.tealAccent : t.colors.bear;
  return (
    <View style={[styles.circle, { backgroundColor: t.alpha(tone, 0.15) }]}>
      {kind === 'working' ? (
        <ActivityIndicator color={tone} />
      ) : kind === 'success' ? (
        <Icon name="check" size={28} strokeWidth={3} color={tone} />
      ) : kind === 'error' ? (
        <Icon name="close" size={28} strokeWidth={3} color={tone} />
      ) : (
        <Icon name="alert" size={28} strokeWidth={2.5} color={tone} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 12,
  },
});
