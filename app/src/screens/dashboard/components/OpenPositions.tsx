import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText, AssetIcon, Button } from '@/components/ui';
import { useAppNavigation } from '@/navigation/types';
import { useTheme } from '@/theme';
import { fmtPrice, fmtSigned } from '@/utils/money';
import {
  fmtQty,
  positionKey,
  positionPercents,
  positionSubtitle,
  signedPct,
  type LivePosition,
} from '@/utils/dashboard';

import { Glyph } from './Glyph';
import { Eyebrow, TextLink, TINT, tint } from './shared';

/** Dashboard.jsx:343 — the grid shows six; the rest are one tap away. */
export const POSITIONS_SHOWN = 6;

/**
 * "Open positions" — Dashboard.jsx:311-356: the Live eyebrow, the count, the
 * first six as cards (each opens the chart), "View all N positions →", and
 * the empty state with "Explore Markets".
 *
 * Six cards at most, so a plain column — never the whole book in a
 * ScrollView.
 */
export function OpenPositions({
  positions,
}: {
  positions: readonly LivePosition[];
}): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  return (
    <View testID="dashboard-positions" style={styles.wrap}>
      <View style={styles.head}>
        <View>
          <Eyebrow>Live</Eyebrow>
          <View style={styles.titleRow}>
            <AppText variant="title">Open positions</AppText>
            <View style={[styles.count, { backgroundColor: t.colors.primarySoft }]}>
              <AppText variant="micro" weight="700" color={t.colors.primaryText}>{String(positions.length)}</AppText>
            </View>
          </View>
        </View>
        <TextLink label="Manage →" onPress={() => nav.navigate('Trade')} />
      </View>

      {positions.length === 0 ? (
        <View style={[styles.empty, { backgroundColor: t.colors.surface, borderColor: t.colors.borderDark }]}>
          <Glyph name="chart" size={72} color="#9CA3AF" strokeWidth={1.4} />
          <AppText variant="bodyStrong" align="center" style={styles.emptyTitle}>No open positions</AppText>
          <AppText variant="small" tone="muted" align="center" style={styles.emptyMsg}>
            Open a long or short trade and your live positions will appear here with mark-to-market P&L.
          </AppText>
          <Button
            title="Explore Markets"
            size="sm"
            rightIcon="chevronRight"
            onPress={() => nav.navigate('Explore')}
            style={styles.emptyAction}
          />
        </View>
      ) : (
        <>
          {positions.slice(0, POSITIONS_SHOWN).map((lp) => (
            <PositionCard key={positionKey(lp.position)} lp={lp} />
          ))}
          {positions.length > POSITIONS_SHOWN ? (
            <Pressable
              accessibilityRole="link"
              onPress={() => nav.navigate('Trade')}
              style={({ pressed }) => [
                styles.viewAll,
                { backgroundColor: pressed ? t.colors.primarySoft : t.colors.surface, borderColor: t.colors.borderDark },
              ]}
            >
              <AppText variant="small" weight="600" color={t.colors.primaryText}>
                {`View all ${positions.length} positions →`}
              </AppText>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}

/**
 * PositionCard — Dashboard.jsx:377-471. A side-coloured rail, the symbol
 * with Long/Short, the big unrealised P&L in rupees (`+₹` on a gain or
 * zero, `-₹` on a loss) with its % pill, entry → mark with the price move,
 * and the quantity. The whole card opens the Trade chart for the symbol;
 * "View chart" is always shown (the web reveals it on hover).
 */
function PositionCard({ lp }: { lp: LivePosition }): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  const p = lp.position;
  const { pnlPct, movePct } = positionPercents(lp);
  const isWin = lp.pnl >= 0;
  const tone = isWin ? TINT.green : TINT.red;
  const sideTone = lp.long ? TINT.green : TINT.red;
  const entry = fmtPrice(p.entryPrice, lp.prec);
  const mark = fmtPrice(lp.mark, lp.prec);
  const pnlText = fmtSigned(lp.pnl);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${p.symbol} ${lp.long ? 'Long' : 'Short'}, unrealised P&L ${pnlText}. View chart`}
      onPress={() => nav.navigate('Trade', { symbol: p.symbol })}
      testID={`dashboard-position-${p.symbol}`}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: t.colors.surface,
          borderColor: pressed ? t.alpha(t.colors.primary, 0.4) : t.colors.borderDark,
        },
        t.shadow.card,
      ]}
    >
      <View style={[styles.rail, { backgroundColor: sideTone }]} />

      <View style={styles.top}>
        <AssetIcon row={lp.instrument ?? { symbol: p.symbol, category: lp.category }} size={36} round />
        <View style={styles.flex}>
          <View style={styles.symRow}>
            <AppText variant="bodyStrong" weight="700" numberOfLines={1} style={styles.shrink}>{p.symbol}</AppText>
            <View style={[styles.side, { backgroundColor: tint(sideTone, 0.1) }]}>
              <AppText variant="micro" weight="700" color={sideTone} style={styles.sideText}>
                {`${lp.long ? '▲' : '▼'} ${lp.long ? 'Long' : 'Short'}`}
              </AppText>
            </View>
          </View>
          <AppText variant="caption" tone="muted" numberOfLines={1}>{positionSubtitle(lp.instrument, lp.category)}</AppText>
        </View>
      </View>

      <View style={styles.pnlBlock}>
        <AppText variant="micro" tone="muted" weight="700" style={styles.upper}>{'Unrealised P&L'}</AppText>
        <View style={styles.pnlRow}>
          <AppText variant="h1" mono weight="700" color={tone} testID={`dashboard-position-pnl-${p.symbol}`}>{pnlText}</AppText>
          <View style={[styles.pctPill, { backgroundColor: tint(tone, 0.1) }]}>
            <Glyph name={isWin ? 'caretUp' : 'caretDown'} size={9} color={tone} strokeWidth={3} />
            <AppText variant="caption" mono weight="700" color={tone}>{signedPct(pnlPct)}</AppText>
          </View>
        </View>
      </View>

      <View style={[styles.footer, { borderTopColor: t.colors.borderSubtle }]}>
        <View style={styles.col}>
          <AppText variant="micro" tone="muted" weight="700" style={styles.upperSm}>Entry</AppText>
          <AppText variant="caption" mono weight="600" tone="secondary" numberOfLines={1}>{entry}</AppText>
        </View>
        <View style={[styles.col, styles.center]}>
          <AppText variant="micro" tone="muted" weight="700" style={styles.upperSm}>→</AppText>
          <AppText variant="micro" mono weight="700" color={movePct >= 0 ? TINT.green : TINT.red} style={styles.tiny}>
            {signedPct(movePct)}
          </AppText>
        </View>
        <View style={[styles.col, styles.right]}>
          <AppText variant="micro" tone="muted" weight="700" style={styles.upperSm}>Mark</AppText>
          <AppText variant="caption" mono weight="700" numberOfLines={1} testID={`dashboard-position-mark-${p.symbol}`}>{mark}</AppText>
        </View>
      </View>

      <View style={styles.bottom}>
        <AppText variant="micro" tone="muted" mono>{`Qty · ${fmtQty(p.quantity, 6)}`}</AppText>
        <View style={styles.chartHint}>
          <AppText variant="micro" weight="600" color={t.colors.primaryText}>View chart</AppText>
          <Glyph name="arrowRight" size={10} color={t.colors.primaryText} strokeWidth={2.4} />
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12, marginBottom: 24 },
  head: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingHorizontal: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  count: { minWidth: 22, height: 18, paddingHorizontal: 6, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  empty: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 24, paddingVertical: 48, alignItems: 'center' },
  emptyTitle: { marginTop: 12 },
  emptyMsg: { marginTop: 4, maxWidth: 320 },
  emptyAction: { marginTop: 16 },
  viewAll: { borderWidth: 1, borderRadius: 12, paddingVertical: 10, alignItems: 'center' },
  card: { borderWidth: 1, borderRadius: 16, padding: 16, overflow: 'hidden' },
  rail: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, opacity: 0.85 },
  top: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  flex: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  symRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  side: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  sideText: { fontSize: 9, lineHeight: 12, letterSpacing: 0.6, textTransform: 'uppercase' },
  pnlBlock: { marginTop: 16 },
  upper: { textTransform: 'uppercase', letterSpacing: 0.6 },
  upperSm: { fontSize: 9, lineHeight: 12, textTransform: 'uppercase', letterSpacing: 0.6 },
  tiny: { fontSize: 9, lineHeight: 12, marginTop: 2 },
  pnlRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  pctPill: { flexDirection: 'row', alignItems: 'center', gap: 2, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  footer: { marginTop: 16, paddingTop: 12, borderTopWidth: 1, flexDirection: 'row', gap: 8 },
  col: { flex: 1, minWidth: 0 },
  center: { alignItems: 'center' },
  right: { alignItems: 'flex-end' },
  bottom: { marginTop: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chartHint: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
