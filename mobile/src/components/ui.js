import React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useColors, radius } from '../theme';

export function Card({ style, children }) {
  const c = useColors();
  return (
    <View style={[{ backgroundColor: c.card, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, padding: 14 }, style]}>
      {children}
    </View>
  );
}

export function Button({ title, onPress, loading, disabled, variant = 'primary', style }) {
  const c = useColors();
  const bg = variant === 'primary' ? c.primary500 : variant === 'danger' ? c.bear : variant === 'bull' ? c.bull : c.hover;
  const ghost = variant === 'ghost';
  const fg = ghost ? c.textPrimary : c.white;
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      disabled={disabled || loading}
      style={[{ height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16,
        backgroundColor: ghost ? 'transparent' : bg, borderWidth: ghost ? 1 : 0, borderColor: c.border, opacity: disabled ? 0.5 : 1 }, style]}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={{ fontSize: 15, fontWeight: '700', color: fg }}>{title}</Text>}
    </TouchableOpacity>
  );
}

export function Pill({ label, tone = 'muted' }) {
  const c = useColors();
  const map = {
    bull: [c.bullSoft, c.bull],
    bear: [c.bearSoft, c.bear],
    primary: [c.primarySoft, c.primary500],
    warn: [c.warnSoft, c.warn],
    muted: [c.hover, c.textMuted],
  };
  const [bg, fg] = map[tone] || map.muted;
  return (
    <View style={{ backgroundColor: bg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, alignSelf: 'flex-start' }}>
      <Text style={{ color: fg, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 }}>{label}</Text>
    </View>
  );
}

export function Row({ children, style }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center' }, style]}>{children}</View>;
}

export function Loader({ label }) {
  const c = useColors();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 }}>
      <ActivityIndicator color={c.primary500} />
      {label ? <Text style={{ color: c.textMuted, marginTop: 8 }}>{label}</Text> : null}
    </View>
  );
}

export function Empty({ title, sub }) {
  const c = useColors();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 }}>
      <Text style={{ color: c.textSecondary, fontSize: 15, fontWeight: '600' }}>{title}</Text>
      {sub ? <Text style={{ color: c.textMuted, marginTop: 4, fontSize: 13, textAlign: 'center' }}>{sub}</Text> : null}
    </View>
  );
}

// Loading skeleton block (native feel while data loads).
export function Skeleton({ height = 16, width = '100%', style }) {
  const c = useColors();
  return <View style={[{ height, width, backgroundColor: c.hover, borderRadius: radius.sm }, style]} />;
}
