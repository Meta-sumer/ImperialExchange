import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, type AppTheme } from '@/theme';

import { AppText } from './AppText';

/**
 * Status chips, from index.css `.badge-primary / .badge-bull / .badge-bear`
 * and the chrome's one-off chips.
 *
 *   primary  bg primary/10, text primary-600, border primary/25
 *   bull     bg bull/10, text bull, border bull/30
 *   bear     bg bear/10, text bear, border bear/30
 *   neutral  bg hover wash, secondary text
 *   demo     Layout.jsx:528 — bg-amber-100 text-amber-700
 *   live     Layout.jsx:528 — bg-emerald-100 text-emerald-700
 *
 * `solid` fills with the tone (the NEW badge on the Broker nav item is
 * `bg-primary-500 text-white`). `Pill` is the same chip, fully rounded.
 */
export type BadgeTone = 'primary' | 'bull' | 'bear' | 'neutral' | 'warn' | 'info' | 'demo' | 'live';

export interface BadgeProps {
  label: string;
  tone?: BadgeTone;
  solid?: boolean;
  /** 'xs' is the 9-10px uppercase micro chip the chrome uses. */
  size?: 'xs' | 'sm';
  rounded?: boolean;
  style?: StyleProp<ViewStyle>;
}

interface ChipLook { bg: string; fg: string; border: string }

const chip = (t: AppTheme, tone: BadgeTone, solid: boolean): ChipLook => {
  const c = t.colors;
  const a = t.alpha;
  const fill = (hex: string): ChipLook => (solid
    ? { bg: hex, fg: c.onPrimary, border: hex }
    : { bg: a(hex, 0.1), fg: hex, border: a(hex, 0.3) });
  switch (tone) {
    case 'primary':
      return solid
        ? { bg: c.primary, fg: c.onPrimary, border: c.primary }
        : { bg: a(c.primary, 0.1), fg: c.primaryText, border: a(c.primary, 0.25) };
    case 'bull': return fill(c.bull);
    case 'bear': return fill(c.bear);
    case 'warn': return fill(c.warn);
    case 'info': return fill(c.info);
    case 'demo': return { bg: t.tw.amber100, fg: t.tw.amber700, border: t.tw.amber100 };
    case 'live': return { bg: t.tw.emerald100, fg: t.tw.emerald700, border: t.tw.emerald100 };
    case 'neutral':
    default:
      return solid
        ? { bg: c.textMuted, fg: c.onPrimary, border: c.textMuted }
        : { bg: c.bgHover, fg: c.textSecondary, border: c.borderSubtle };
  }
};

export function Badge({
  label,
  tone = 'neutral',
  solid = false,
  size = 'sm',
  rounded = false,
  style,
}: BadgeProps): React.JSX.Element {
  const t = useTheme();
  const l = chip(t, tone, solid);
  const xs = size === 'xs';
  return (
    <View
      style={[
        {
          alignSelf: 'flex-start',
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: l.bg,
          borderColor: l.border,
          borderWidth: 1,
          borderRadius: rounded ? t.radius.full : xs ? 4 : t.radius.md,
          paddingHorizontal: xs ? 6 : 8,
          paddingVertical: xs ? 1 : 2,
        },
        style,
      ]}
    >
      <AppText
        variant={xs ? 'micro' : 'smallStrong'}
        color={l.fg}
        weight={xs ? '800' : '600'}
        style={xs ? { fontSize: 9, lineHeight: 12, letterSpacing: 0.6, textTransform: 'uppercase' } : null}
      >
        {label}
      </AppText>
    </View>
  );
}

/** A fully rounded Badge — the web's `rounded-full` chips. */
export function Pill(props: Omit<BadgeProps, 'rounded'>): React.JSX.Element {
  return <Badge {...props} rounded />;
}
