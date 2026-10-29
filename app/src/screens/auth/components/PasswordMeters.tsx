import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText, Icon } from '@/components/ui';
import { meterColors, useTheme, type AppTheme } from '@/theme';

import { PASSWORD_RULES, passwordStrength, type StrengthTone } from '../logic/password';

const toneColor = (t: AppTheme, tone: StrengthTone): string => {
  switch (tone) {
    case 'bull': return t.colors.bull;
    case 'orange500': return meterColors.orange500;
    case 'amber400': return meterColors.amber400;
    case 'lime500': return meterColors.lime500;
    case 'bear':
    default: return t.colors.bear;
  }
};

/** Register.jsx PasswordStrength — four bars and a verdict. */
export function PasswordStrengthMeter({ password }: { password: string }): React.JSX.Element {
  const t = useTheme();
  const s = passwordStrength(password);
  const fill = toneColor(t, s.tone);
  return (
    <View style={styles.meter}>
      <View style={styles.bars}>
        {[0, 1, 2, 3].map((i) => (
          <View
            key={i}
            style={[styles.bar, { backgroundColor: i < s.filled ? fill : t.colors.bgHover }]}
          />
        ))}
      </View>
      <AppText variant="small" color={t.colors.compatGray500} style={styles.caption}>{s.caption}</AppText>
    </View>
  );
}

/** ForgotPassword.jsx's live rules checklist. */
export function PasswordRulesList({ password }: { password: string }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={styles.rules} accessibilityRole="list">
      {PASSWORD_RULES.map((r) => {
        const ok = r.test(password);
        return (
          <View key={r.label} style={styles.rule} accessibilityLabel={`${r.label}${ok ? ', met' : ', not met'}`}>
            <View style={[styles.dotWrap, { backgroundColor: ok ? t.alpha(t.colors.bull, 0.15) : t.colors.bgHover }]}>
              {ok ? (
                <Icon name="check" size={10} strokeWidth={3.5} color={t.colors.bull} />
              ) : (
                <View style={[styles.dot, { backgroundColor: t.colors.textMuted }]} />
              )}
            </View>
            <AppText variant="small" color={ok ? t.colors.bull : t.colors.textMuted}>{r.label}</AppText>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  meter: { marginTop: 6 },
  bars: { flexDirection: 'row', gap: 4 },
  bar: { height: 4, flex: 1, borderRadius: 4 },
  caption: { marginTop: 4 },
  rules: { gap: 4 },
  rule: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dotWrap: { width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 4, height: 4, borderRadius: 2 },
});
