import React from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { useTheme } from '@/theme';
import {
  heroTexts,
  showsPct,
  signedPct,
  winRateLabel,
  winRateTone,
  type HeroFigures,
} from '@/utils/dashboard';

import { Glyph, type GlyphName } from './Glyph';
import { TINT, tint } from './shared';

/**
 * The equity hero band — Dashboard.jsx:233-295: Portfolio Value · Total P&L
 * (Floating) · Today's P&L (Closed) · Open · Win Rate, and the Balance
 * footer — one rupee figure, the live balance summed (EquityHub is
 * INR-only: no per-currency chips, no converted second line).
 *
 * The floating P&L is re-marked with the live ticks once every live
 * position has one, else the dashboard read (utils/dashboard heroFigures).
 * On a phone the five tiles stack, the two stat boxes side by side (the
 * web's `grid-cols-1` below md).
 */
export function HeroBand({
  hero,
  openCount,
}: {
  hero: HeroFigures;
  openCount: number;
}): React.JSX.Element {
  const t = useTheme();
  const text = heroTexts(hero);
  const wr = winRateTone(hero.winRate);

  return (
    <View
      testID="dashboard-hero"
      style={[
        styles.band,
        { backgroundColor: t.colors.bgPanel, borderColor: t.colors.borderDark, borderRadius: 24 },
        t.shadow.card,
      ]}
    >
      <PnlTile
        tintHex={TINT.blue}
        icon="chart"
        label="Portfolio Value (Equity)"
        value={text.equity}
        valueColor={t.colors.textPrimary}
        pct={hero.eqPct}
      />
      <PnlTile
        tintHex={TINT.green}
        icon="trendUp"
        label="Total P&L (Floating)"
        value={text.floating}
        valueColor={hero.unrealized >= 0 ? TINT.green : TINT.red}
        pct={hero.eqPct}
      />
      <PnlTile
        tintHex={hero.today >= 0 ? TINT.green : TINT.red}
        icon="dollar"
        label="Today's P&L"
        badge="CLOSED"
        value={text.today}
        valueColor={hero.today >= 0 ? TINT.green : TINT.red}
        pct={hero.todayPct}
      />
      <View style={styles.boxes}>
        <StatBox dotTint={TINT.blue} label="Open" value={String(openCount)} caption="Positions" />
        <StatBox
          dotTint={wr === 'none' ? TINT.slate : wr === 'bull' ? TINT.green : TINT.red}
          label="Win Rate"
          value={winRateLabel(hero.winRate)}
          caption="All time"
        />
      </View>

      {/* Balance footer */}
      <View style={[styles.footer, { borderTopColor: t.colors.borderSubtle }]}>
        <View style={styles.footerLabel}>
          <Glyph name="card" size={12} color={t.colors.textMuted} />
          <AppText variant="caption" tone="muted">Balance</AppText>
        </View>
        <AppText variant="caption" mono weight="700" testID="dashboard-balance">{text.balance}</AppText>
      </View>
    </View>
  );
}

/** PnlTile — icon circle, label (+ badge), big value, ↑/↓ percent chip. */
function PnlTile({
  tintHex,
  icon,
  label,
  badge,
  value,
  valueColor,
  pct,
}: {
  tintHex: string;
  icon: GlyphName;
  label: string;
  badge?: string;
  value: string;
  valueColor: string;
  pct: number;
}): React.JSX.Element {
  const pos = pct >= 0;
  return (
    <View style={styles.tile} accessible accessibilityLabel={`${label}: ${value}`}>
      <View style={[styles.iconCircle, { backgroundColor: tint(tintHex, 0.1) }]}>
        <Glyph name={icon} size={20} color={tintHex} />
      </View>
      <View style={styles.flex}>
        <View style={styles.labelRow}>
          <AppText variant="caption" tone="muted" weight="600" numberOfLines={1}>{label}</AppText>
          {badge ? (
            <View style={styles.badge}>
              <AppText variant="micro" weight="700" color="#FFFFFF" style={styles.badgeText}>{badge}</AppText>
            </View>
          ) : null}
        </View>
        <AppText variant="h2" mono weight="800" color={valueColor} numberOfLines={1} adjustsFontSizeToFit style={styles.value}>
          {value}
        </AppText>
        {showsPct(pct) ? (
          <View style={styles.pctRow}>
            <Glyph name={pos ? 'caretUp' : 'caretDown'} size={9} color={pos ? TINT.green : TINT.red} strokeWidth={3.5} />
            <AppText variant="micro" weight="700" color={pos ? TINT.green : TINT.red}>{signedPct(pct)}</AppText>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** StatBox — the bordered Open / Win Rate cells. */
function StatBox({ dotTint, label, value, caption }: { dotTint: string; label: string; value: string; caption: string }): React.JSX.Element {
  const t = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}`}
      style={[styles.box, { borderColor: t.colors.borderDark, backgroundColor: t.colors.surface }]}
    >
      <View style={styles.labelRow}>
        <View style={[styles.dot, { backgroundColor: dotTint }]} />
        <AppText variant="micro" tone="muted" weight="700" style={styles.upper} numberOfLines={1}>{label}</AppText>
      </View>
      <AppText variant="h1" weight="800" mono style={styles.boxValue}>{value}</AppText>
      <AppText variant="caption" tone="muted">{caption}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  band: { borderWidth: 1, padding: 16, gap: 4, marginBottom: 24 },
  tile: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 12, borderRadius: 16 },
  iconCircle: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1, minWidth: 0 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badge: { backgroundColor: '#0F172A', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 },
  badgeText: { fontSize: 9, lineHeight: 12, letterSpacing: 0.6, textTransform: 'uppercase' },
  value: { marginTop: 4 },
  pctRow: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 4 },
  boxes: { flexDirection: 'row', gap: 8, marginTop: 4 },
  box: { flex: 1, borderWidth: 1, borderRadius: 16, padding: 14, justifyContent: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  upper: { textTransform: 'uppercase', letterSpacing: 0.6 },
  boxValue: { marginTop: 4 },
  footer: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  footerLabel: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
