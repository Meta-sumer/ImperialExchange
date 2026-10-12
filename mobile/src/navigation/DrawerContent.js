import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { DrawerContentScrollView } from '@react-navigation/drawer';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../store/auth';
import { useColors, useThemeMode, radius } from '../theme';

const ITEMS = [
  { label: 'Wallet', icon: 'wallet-outline', to: 'Wallet' },
  { label: 'Watchlist', icon: 'bookmark-outline', to: 'Watchlist' },
  { label: 'Copy Trading', icon: 'repeat-outline', to: 'Copy' },
  { label: 'Reports', icon: 'analytics-outline', to: 'Reports' },
  { label: 'Partner Program', icon: 'people-outline', to: 'Partner' },
  { label: 'Algo Trading', icon: 'hardware-chip-outline', to: 'Algo' },
  { label: 'History', icon: 'time-outline', to: 'History' },
  { label: 'Settings', icon: 'settings-outline', to: 'Settings' },
  { label: 'Support', icon: 'help-buoy-outline', to: 'Support' },
];

export default function DrawerContent({ navigation, state }) {
  const c = useColors();
  const { user, logout } = useAuth();
  const { mode, setMode } = useThemeMode();
  const dark = mode === 'dark';
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Trader';
  const initials = (name || 'T').split(' ').map((s) => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  const activeRoute = state?.routeNames?.[state.index];

  return (
    <View style={{ flex: 1, backgroundColor: c.sidebar }}>
      <DrawerContentScrollView contentContainerStyle={{ paddingTop: 0 }}>
        {/* Brand header */}
        <View style={{ paddingHorizontal: 18, paddingTop: 8, paddingBottom: 18, borderBottomWidth: 1, borderBottomColor: c.borderSubtle }}>
          <Text style={{ fontSize: 22, fontWeight: '900', color: c.primary500, letterSpacing: -0.5 }}>Frexever</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16 }}>
            <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: c.primary500, fontWeight: '900', fontSize: 16 }}>{initials}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: '800', color: c.textPrimary }} numberOfLines={1}>{name}</Text>
              <Text style={{ fontSize: 12, color: c.textMuted }} numberOfLines={1}>{user?.email}</Text>
            </View>
          </View>
        </View>

        {/* Items */}
        <View style={{ paddingHorizontal: 10, paddingTop: 10 }}>
          {ITEMS.map((it) => {
            const on = activeRoute === it.to;
            return (
              <TouchableOpacity
                key={it.to}
                onPress={() => navigation.navigate(it.to)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 12, paddingVertical: 13, borderRadius: radius.md, backgroundColor: on ? c.primarySoft : 'transparent' }}
              >
                <Ionicons name={it.icon} size={21} color={on ? c.primary500 : c.textSecondary} />
                <Text style={{ fontSize: 15, fontWeight: on ? '800' : '600', color: on ? c.primary500 : c.textPrimary }}>{it.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </DrawerContentScrollView>

      {/* Footer: dark toggle + logout */}
      <View style={{ padding: 14, borderTopWidth: 1, borderTopColor: c.borderSubtle, gap: 10 }}>
        <TouchableOpacity onPress={() => setMode(dark ? 'light' : 'dark')} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 }}>
          <Ionicons name={dark ? 'sunny-outline' : 'moon-outline'} size={20} color={c.textSecondary} />
          <Text style={{ fontSize: 14, fontWeight: '600', color: c.textPrimary }}>{dark ? 'Light mode' : 'Dark mode'}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={logout} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 }}>
          <Ionicons name="log-out-outline" size={20} color={c.bear} />
          <Text style={{ fontSize: 14, fontWeight: '700', color: c.bear }}>Log out</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
