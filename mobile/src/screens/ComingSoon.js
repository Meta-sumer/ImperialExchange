import React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';

/** Placeholder for drawer destinations that don't have a mobile screen yet
 *  (Algo Trading, Analytics, Support, News, Notifications). */
export default function ComingSoon({ route }) {
  const c = useColors();
  const { icon = 'construct-outline', title = 'Coming soon', message } = route?.params || {};
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={icon} size={32} color={c.primary500} />
      </View>
      <Text style={{ fontSize: 18, fontWeight: '800', color: c.textPrimary, marginTop: 16 }}>{title}</Text>
      <Text style={{ fontSize: 14, color: c.textMuted, marginTop: 6, textAlign: 'center', lineHeight: 20 }}>
        {message || 'This section is coming to mobile next.'}
      </Text>
    </View>
  );
}
