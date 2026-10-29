import React from 'react';
import { Text, type TextProps, type TextStyle } from 'react-native';

import { useTheme, type AppColors, type AppTheme } from '@/theme';

/**
 * Text, on the web's type scale.
 *
 * Each variant is a class combination the web repeats rather than a new
 * invention — `h1` is PageHero's `text-2xl font-bold`, `title` is the modal
 * header's `text-base font-bold`, `label` is index.css's `.label`.
 */
export type TextVariant =
  | 'display' // text-3xl font-bold — the desktop PageHero title
  | 'h1' // text-2xl font-bold — page titles, PageHero on phones
  | 'h2' // text-xl font-bold — section heads
  | 'h3' // text-lg font-semibold
  | 'title' // text-base font-bold — modal and card titles
  | 'body' // text-sm — the default body copy
  | 'bodyStrong' // text-sm font-semibold
  | 'small' // text-xs
  | 'smallStrong' // text-xs font-semibold
  | 'caption' // text-[11px]
  | 'micro' // text-[10px]
  | 'label' // .label — xs, uppercase, tracking-wider, medium, secondary
  | 'eyebrow'; // PageHero eyebrow — 10px, uppercase, 0.25em tracking, bold, primary

export type TextTone =
  | 'primary'
  | 'secondary'
  | 'muted'
  | 'brand'
  | 'bull'
  | 'bear'
  | 'onPrimary';

const TONE: Record<TextTone, keyof AppColors> = {
  primary: 'textPrimary',
  secondary: 'textSecondary',
  muted: 'textMuted',
  brand: 'primaryText',
  bull: 'bull',
  bear: 'bear',
  onPrimary: 'onPrimary',
};

const variantStyle = (t: AppTheme, v: TextVariant): TextStyle => {
  switch (v) {
    case 'display': return { ...t.text.xxxl, fontWeight: '700' };
    case 'h1': return { ...t.text.xxl, fontWeight: '700' };
    case 'h2': return { ...t.text.xl, fontWeight: '700' };
    case 'h3': return { ...t.text.lg, fontWeight: '600' };
    case 'title': return { ...t.text.base, fontWeight: '700' };
    case 'body': return { ...t.text.sm, fontWeight: '400' };
    case 'bodyStrong': return { ...t.text.sm, fontWeight: '600' };
    case 'small': return { ...t.text.xs, fontWeight: '400' };
    case 'smallStrong': return { ...t.text.xs, fontWeight: '600' };
    case 'caption': return { ...t.text.caption, fontWeight: '400' };
    case 'micro': return { ...t.text.micro, fontWeight: '400' };
    case 'label':
      return { ...t.text.xs, fontWeight: '500', letterSpacing: 0.6, textTransform: 'uppercase' };
    case 'eyebrow':
      return { ...t.text.micro, fontWeight: '700', letterSpacing: 2.5, textTransform: 'uppercase' };
    default: return t.text.sm;
  }
};

/** The colour a variant takes when the caller does not choose one. */
const defaultTone = (v: TextVariant): TextTone => {
  if (v === 'label') return 'secondary';
  if (v === 'eyebrow') return 'brand';
  return 'primary';
};

export interface AppTextProps extends TextProps {
  variant?: TextVariant;
  /** A theme tone, or any colour string. */
  tone?: TextTone;
  color?: string;
  weight?: TextStyle['fontWeight'];
  align?: TextStyle['textAlign'];
  /**
   * `.num` / `.font-mono` — tabular figures so a changing price does not
   * make its neighbours jump. The web switches font family; the platform
   * mono is uneven across Android vendors, so this keeps the family and asks
   * for tabular digits instead, which is the part that matters.
   */
  mono?: boolean;
}

export function AppText({
  variant = 'body',
  tone,
  color,
  weight,
  align,
  mono,
  style,
  ...rest
}: AppTextProps): React.JSX.Element {
  const t = useTheme();
  const resolved: TextStyle = {
    ...variantStyle(t, variant),
    color: color ?? t.colors[TONE[tone ?? defaultTone(variant)]],
    ...(weight ? { fontWeight: weight } : null),
    ...(align ? { textAlign: align } : null),
    ...(mono ? { fontVariant: ['tabular-nums'], fontFamily: t.font.mono } : null),
    ...(t.font.sans && !mono ? { fontFamily: t.font.sans } : null),
  };
  return <Text {...rest} style={[resolved, style]} />;
}
