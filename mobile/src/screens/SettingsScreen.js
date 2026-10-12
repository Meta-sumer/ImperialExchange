import React from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../store/auth';
import { useColors, useThemeMode, radius } from '../theme';
import { Card, Button, Row } from '../components/ui';
import { API_BASE_URL } from '../config';

const MODES = [
  { id: 'light', label: 'Light', icon: 'sunny-outline' },
  { id: 'dark', label: 'Dark', icon: 'moon-outline' },
  { id: 'system', label: 'System', icon: 'phone-portrait-outline' },
];

export default function SettingsScreen() {
  const c = useColors();
  const { logout, user } = useAuth();
  const { mode, setMode } = useThemeMode();

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 13, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Appearance</Text>
      <Card>
        <Row style={{ gap: 8 }}>
          {MODES.map((m) => {
            const on = mode === m.id;
            return (
              <TouchableOpacity
                key={m.id}
                onPress={() => setMode(m.id)}
                style={{ flex: 1, alignItems: 'center', paddingVertical: 14, borderRadius: radius.md, borderWidth: 1,
                  borderColor: on ? c.primary500 : c.border, backgroundColor: on ? c.primarySoft : 'transparent' }}
              >
                <Ionicons name={m.icon} size={22} color={on ? c.primary500 : c.textMuted} />
                <Text style={{ marginTop: 6, fontSize: 13, fontWeight: '700', color: on ? c.primary500 : c.textSecondary }}>{m.label}</Text>
              </TouchableOpacity>
            );
          })}
        </Row>
      </Card>

      <Text style={{ fontSize: 13, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 }}>Account</Text>
      <Card>
        <Info c={c} label="Name" value={[user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Trader'} />
        <Divider c={c} />
        <Info c={c} label="Email" value={user?.email} />
        <Divider c={c} />
        <Info c={c} label="User ID" value={user?.userUid || user?._id} />
        <Divider c={c} />
        <Info c={c} label="API endpoint" value={API_BASE_URL} />
      </Card>

      <View style={{ height: 8 }} />
      <Button title="Log out" variant="danger" onPress={logout} />
      <Text style={{ fontSize: 11, color: c.textMuted, textAlign: 'center', marginTop: 8 }}>Frexever Mobile · v1.0.0</Text>
    </ScrollView>
  );
}

function Info({ c, label, value }) {
  return (
    <View style={{ paddingVertical: 4 }}>
      <Text style={{ fontSize: 12, color: c.textMuted, fontWeight: '600' }}>{label}</Text>
      <Text style={{ fontSize: 14, color: c.textPrimary, marginTop: 2 }}>{value}</Text>
    </View>
  );
}
function Divider({ c }) { return <View style={{ height: 1, backgroundColor: c.borderSubtle, marginVertical: 8 }} />; }
