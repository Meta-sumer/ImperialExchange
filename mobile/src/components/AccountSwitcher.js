import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useAccounts } from '../store/account';
import { useColors, radius } from '../theme';

const isDemo = (t) => ['DEMO', 'VIRTUAL'].includes(String(t || '').toUpperCase());

/** Horizontal chips to pick the active trading account (used across screens). */
export default function AccountSwitcher() {
  const c = useColors();
  const { accounts, selectedId, select } = useAccounts();
  if (!accounts.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10, gap: 8 }}>
      {accounts.map((a) => {
        const on = a._id === selectedId;
        const demo = isDemo(a.accountType);
        return (
          <TouchableOpacity
            key={a._id}
            onPress={() => select(a._id)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 7, marginRight: 8,
              borderColor: on ? c.primary500 : c.border, backgroundColor: on ? c.primarySoft : c.card }}
          >
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: demo ? c.warn : c.bull }} />
            <Text style={{ fontSize: 13, fontWeight: '700', color: on ? c.primary500 : c.textSecondary, maxWidth: 140 }} numberOfLines={1}>
              {a.nickname || a.accountNumber}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}
