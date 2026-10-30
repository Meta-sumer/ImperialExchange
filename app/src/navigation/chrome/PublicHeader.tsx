import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BrandLogo, Button, IconButton } from '@/components/ui';
import { useTheme } from '@/theme';

/**
 * The visitor header for CMS and news pages — PublicShell.jsx's anonymous
 * branch: the logo on a white tile linking home, and a "Sign In" button.
 * (A signed-in reader gets the full app header instead, as on the web.)
 */
export function PublicHeader({ navigation, back }: NativeStackHeaderProps): React.JSX.Element {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ backgroundColor: t.colors.surface, paddingTop: insets.top }}>
      <View style={[styles.bar, { borderBottomColor: t.colors.borderDark }]}>
        {back ? (
          <IconButton name="chevronLeft" accessibilityLabel="Back" size={22} onPress={() => navigation.goBack()} style={styles.back} />
        ) : null}
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Imperial Exchange — home"
          onPress={() => navigation.navigate('Landing', undefined, { pop: true })}
        >
          <BrandLogo variant="full" height={28} tile />
        </Pressable>
        <View style={styles.spacer} />
        <Button title="Sign In" size="sm" onPress={() => navigation.navigate('Login')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  back: { marginLeft: -10 },
  spacer: { flex: 1 },
});
