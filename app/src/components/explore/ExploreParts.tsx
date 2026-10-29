import React from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { AppText } from '@/components/ui';
import { useTheme } from '@/theme';
import {
  DOWN_COLOR,
  NO_CHANGE_COLOR,
  UP_COLOR,
  changePill,
  changeText,
  gainersLosersSplit,
  sparkPaths,
} from '@/utils/explore';

import { ExploreGlyph, type ExploreGlyphName } from './ExploreGlyph';

/**
 * Small pieces of Explore.jsx — ChangePill, ChangeText, Sparkline,
 * GainersLosersBar, the tinted glyph tile, SectionHeader, the "View all"
 * link and the market empty-state illustration — drawn with
 * react-native-svg where the web drew SVG.
 */

/** ChangePill — "▲ +1.23%" on a tinted chip, or a dash. */
export function ChangePill({ value }: { value: number }): React.JSX.Element {
  const t = useTheme();
  const p = changePill(value);
  if (!p) return <AppText variant="caption" tone="muted">—</AppText>;
  const color = p.positive ? UP_COLOR : DOWN_COLOR;
  return (
    <View style={[styles.pill, { backgroundColor: t.alpha(color, 0.1) }]}>
      <ExploreGlyph name={p.positive ? 'arrowUp' : 'arrowDn'} size={12} color={color} />
      <AppText variant="smallStrong" color={color} mono>{p.text}</AppText>
    </View>
  );
}

/** ChangeText — "+1.68 (+9.41%)", coloured, no chip. */
export function ChangeText({
  absChange,
  pct,
  precision,
  currency,
}: {
  absChange: number;
  pct: number;
  precision: number | null | undefined;
  currency?: string;
}): React.JSX.Element {
  const c = changeText(absChange, pct, precision, currency);
  if (!c) return <AppText variant="small" color={NO_CHANGE_COLOR}>—</AppText>;
  return (
    <AppText variant="bodyStrong" color={c.positive ? UP_COLOR : DOWN_COLOR} numberOfLines={1}>
      {`${c.abs} `}
      <AppText variant="body" weight="500" color={c.positive ? UP_COLOR : DOWN_COLOR}>{c.pct}</AppText>
    </AppText>
  );
}

/** Sparkline — the stylised trend line with a soft fill under it. */
export function Sparkline({
  points,
  positive,
  width = 110,
  height = 36,
}: {
  points: number[];
  positive: boolean;
  width?: number;
  height?: number;
}): React.JSX.Element | null {
  const p = sparkPaths(points, width, height);
  if (!p) return null;
  const stroke = positive ? UP_COLOR : DOWN_COLOR;
  const fill = positive ? 'rgba(22, 163, 74, 0.10)' : 'rgba(220, 38, 38, 0.10)';
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Path d={p.area} fill={fill} />
      <Path d={p.line} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** GainersLosersBar — the two counts over a green / red split. */
export function GainersLosersBar({ gainers, losers }: { gainers: number; losers: number }): React.JSX.Element {
  const t = useTheme();
  const { gPct, lPct } = gainersLosersSplit(gainers, losers);
  return (
    <View style={styles.glWrap}>
      <View style={styles.glCounts}>
        <AppText variant="bodyStrong" color={UP_COLOR}>{String(gainers || 0)}</AppText>
        <AppText variant="bodyStrong" color={DOWN_COLOR}>{String(losers || 0)}</AppText>
      </View>
      <View style={[styles.glBar, { backgroundColor: t.colors.bgHover }]}>
        <View style={{ width: `${gPct}%`, backgroundColor: UP_COLOR }} />
        <View style={{ width: `${lPct}%`, backgroundColor: DOWN_COLOR }} />
      </View>
    </View>
  );
}

/** The 36px tinted square a sector or product glyph sits in. */
export function GlyphTile({ name, tint, size = 36 }: { name: ExploreGlyphName; tint: string; size?: number }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[styles.tile, { width: size, height: size, backgroundColor: t.alpha(tint, 0.08) }]}>
      <ExploreGlyph name={name} size={18} color={tint} />
    </View>
  );
}

/** The page's section header: title, caption, an action on the right. */
export function ExploreSectionHeader({
  title,
  caption,
  action,
  style,
}: {
  title: string;
  caption?: string;
  action?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  return (
    <View style={[styles.sectionHead, style]}>
      <View style={styles.flex}>
        <AppText variant="h3" weight="700">{title}</AppText>
        {caption ? <AppText variant="small" tone="secondary" style={styles.caption}>{caption}</AppText> : null}
      </View>
      {action}
    </View>
  );
}

/** "View all ›" / "See more ›" — a text link in the brand colour. */
export function ChevronLink({
  label,
  onPress,
  small = false,
  style,
}: {
  label: string;
  onPress: () => void;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="link" onPress={onPress} hitSlop={8} style={[styles.link, style]}>
      <AppText variant={small ? 'smallStrong' : 'bodyStrong'} color={t.colors.primary}>{label}</AppText>
      <ExploreGlyph name="chevron" size={14} color={t.colors.primary} />
    </Pressable>
  );
}

/**
 * The market empty-state art — five candles on a soft grid with a trend
 * line, a rupee coin and an NSE pill (Explore.jsx InvestmentsIllustration).
 */
export function InvestmentsIllustration(): React.JSX.Element {
  const t = useTheme();
  const grid = t.isDark ? t.colors.borderDark : '#E5E7EB';
  return (
    <Svg width={200} height={120} viewBox="0 0 200 120" fill="none">
      <Line x1="10" y1="35" x2="190" y2="35" stroke={grid} strokeWidth="1" strokeDasharray="2 3" />
      <Line x1="10" y1="60" x2="190" y2="60" stroke={grid} strokeWidth="1" strokeDasharray="2 3" />
      <Line x1="10" y1="85" x2="190" y2="85" stroke={grid} strokeWidth="1" strokeDasharray="2 3" />
      <Line x1="55" y1="38" x2="55" y2="78" stroke="#00C853" strokeWidth="1.5" strokeLinecap="round" />
      <Rect x="50" y="55" width="10" height="20" rx="1.5" fill="#00C853" />
      <Line x1="75" y1="42" x2="75" y2="86" stroke="#FF3B57" strokeWidth="1.5" strokeLinecap="round" />
      <Rect x="70" y="55" width="10" height="22" rx="1.5" fill="#FF3B57" />
      <Line x1="95" y1="28" x2="95" y2="78" stroke="#00C853" strokeWidth="1.5" strokeLinecap="round" />
      <Rect x="90" y="38" width="10" height="32" rx="1.5" fill="#00C853" />
      <Line x1="115" y1="32" x2="115" y2="62" stroke="#FF3B57" strokeWidth="1.5" strokeLinecap="round" />
      <Rect x="110" y="40" width="10" height="14" rx="1.5" fill="#FF3B57" />
      <Line x1="135" y1="18" x2="135" y2="58" stroke="#00C853" strokeWidth="1.5" strokeLinecap="round" />
      <Rect x="130" y="22" width="10" height="28" rx="1.5" fill="#00C853" />
      <Path d="M50 70 L75 65 L95 50 L115 45 L135 28" stroke="#1D4ED8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Circle cx="135" cy="28" r="3" fill="#1D4ED8" />
      <Circle cx="20" cy="40" r="14" fill="#F59E0B" />
      <SvgText x="20" y="46" textAnchor="middle" fontSize="16" fontWeight="700" fill="#FFFFFF">₹</SvgText>
      <Rect x="160" y="78" width="32" height="22" rx="11" fill="#1D4ED8" />
      <SvgText x="176" y="93" textAnchor="middle" fontSize="11" fontWeight="700" fill="#FFFFFF">NSE</SvgText>
      <Line x1="10" y1="108" x2="190" y2="108" stroke={grid} strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 2, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, alignSelf: 'flex-end' },
  glWrap: { width: '100%', maxWidth: 220 },
  glCounts: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  glBar: { flexDirection: 'row', height: 3, borderRadius: 2, overflow: 'hidden' },
  tile: { borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  sectionHead: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 16, gap: 12 },
  caption: { marginTop: 4 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
});
