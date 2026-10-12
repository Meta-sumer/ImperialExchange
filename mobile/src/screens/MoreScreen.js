import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors, radius } from '../theme';

const SECTIONS = [
  {
    title: 'Trading',
    items: [
      { label: 'Wallet', icon: 'wallet-outline', to: 'Wallet' },
      { label: 'Watchlist', icon: 'bookmark-outline', to: 'Watchlist' },
      { label: 'Copy Trading', icon: 'repeat-outline', to: 'Copy' },
      { label: 'Algo Trading', icon: 'hardware-chip-outline', to: 'Algo' },
      { label: 'History', icon: 'time-outline', to: 'History' },
    ],
  },
  {
    title: 'Insights',
    items: [
      { label: 'Reports', icon: 'analytics-outline', to: 'Reports' },
      { label: 'Price Alerts', icon: 'alarm-outline', to: 'Alerts' },
      { label: 'News', icon: 'newspaper-outline', to: 'News' },
      { label: 'Notifications', icon: 'notifications-outline', to: 'Notifications' },
    ],
  },
  {
    title: 'Account',
    items: [
      { label: 'Open new account', icon: 'add-circle-outline', to: 'NewAccountTiers' },
      { label: 'Account plans', icon: 'pricetags-outline', to: 'Plans' },
      { label: 'Partner Program', icon: 'people-outline', to: 'Partner' },
      { label: 'KYC verification', icon: 'shield-checkmark-outline', to: 'Kyc' },
      { label: 'Send Feedback', icon: 'chatbox-ellipses-outline', to: 'Feedback' },
      { label: 'Settings', icon: 'settings-outline', to: 'Settings' },
      { label: 'Support', icon: 'help-buoy-outline', to: 'Support' },
    ],
  },
];

export default function MoreScreen({ navigation }) {
  const c = useColors();
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, gap: 18 }}>
      {SECTIONS.map((sec) => (
        <View key={sec.title}>
          <Text style={{ fontSize: 12, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>{sec.title}</Text>
          <View style={{ backgroundColor: c.card, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border }}>
            {sec.items.map((it, i) => (
              <TouchableOpacity
                key={it.to}
                onPress={() => navigation.navigate(it.to)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 15,
                  borderBottomWidth: i < sec.items.length - 1 ? 1 : 0, borderBottomColor: c.borderSubtle }}
              >
                <Ionicons name={it.icon} size={20} color={c.primary500} />
                <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: c.textPrimary }}>{it.label}</Text>
                <Ionicons name="chevron-forward" size={18} color={c.textMuted} />
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ))}
      <View style={{ height: 12 }} />
    </ScrollView>
  );
}
