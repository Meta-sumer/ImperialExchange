import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';

import { AppText } from '@/components/ui';
import { useTheme, type AppTheme } from '@/theme';
import type { FnoUnderlying, OptionChain, OptionChainRow, OptionLeg } from '@/types/market';
import {
  ceIsItm,
  daysTo,
  expiryDaysText,
  expiryLabel,
  fmtStrike,
  inr,
  legPremiumText,
  maxOiOf,
  oiBarPct,
  peIsItm,
  spotIndexOf,
  statTone,
  type ChainColumn,
} from '@/utils/markets';

/**
 * OptionChain.jsx's pieces: the pill tabs and chips, and the chain table.
 *
 * The table keeps the web's columns in the web's order —
 *   [OI · Chg OI · IV · (Vol · Δ · Θ · Γ · V)] LTP | Strike | LTP [(V · Γ · Θ · Δ · Vol) · IV · Chg OI · OI]
 * — with the in-the-money side of each strike shaded, an OI bar growing out
 * from the strike, the ATM strike marked and a "Spot ₹…" divider where the
 * spot falls between strikes. On a phone it scrolls sideways (the web hides
 * the less essential columns by breakpoint instead), opening centred on
 * LTP · Strike · LTP; and the rows scroll inside their own box with the
 * header standing still, the ATM row centred once per underlying + expiry,
 * as the web does.
 */

/** Tailwind amber-500 — the web's in-the-money shading (`bg-amber-500/10`, `/5`). */
const AMBER = '#F59E0B';
/** The OI bars' colours, verbatim: red on the CALL side, green on the PUT side. */
const OI_BAR_CE = 'rgba(255,59,87,0.14)';
const OI_BAR_PE = 'rgba(0,200,83,0.16)';

const STAT_W = 66;
const LTP_W = 80;
const STRIKE_W = 92;
export const ROW_H = 40;
export const SPOT_H = 26;

/* ── Pills and chips ──────────────────────────────────────────────────── */

/** A segment tab — `px-4 py-2 rounded-full`, filled when active. */
export function KindPill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.kindPill,
        active
          ? { backgroundColor: t.colors.primary, borderColor: t.colors.primary }
          : { borderColor: t.colors.borderDark, backgroundColor: pressed ? t.colors.bgHover : 'transparent' },
      ]}
    >
      <AppText variant="body" weight="600" color={active ? t.colors.onPrimary : t.colors.textSecondary}>{label}</AppText>
    </Pressable>
  );
}

/** An underlying chip (index / MCX) — `px-3 py-1.5 rounded-lg`, outlined when chosen. */
export function UnderlyingChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      testID={`underlying-${label}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        { borderRadius: t.radius.lg },
        active
          ? { borderColor: t.colors.primary, backgroundColor: t.colors.primarySoft }
          : { borderColor: t.colors.borderDark, backgroundColor: pressed ? t.colors.bgHover : 'transparent' },
      ]}
    >
      <AppText variant="body" weight="600" color={active ? t.colors.primaryText : t.colors.textSecondary}>{label}</AppText>
    </Pressable>
  );
}

/** The expiry chips: "27 Oct 3d", the chain's own expiry lit. */
export function ExpiryChips({
  current,
  selected,
  onPick,
  nowMs,
}: {
  current: FnoUnderlying;
  selected: string | null;
  onPick: (expiry: string) => void;
  nowMs: number;
}): React.JSX.Element {
  const t = useTheme();
  const active = selected || current.optionExpiries[0] || null;
  return (
    <View style={styles.expiryRow}>
      <AppText variant="micro" weight="600" tone="muted" style={styles.expiryLabel}>EXPIRY</AppText>
      {current.optionExpiries.map((e) => {
        const on = active === e;
        const d = daysTo(e, nowMs);
        return (
          <Pressable
            key={e}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`Expiry ${expiryLabel(e)}, ${expiryDaysText(d)}`}
            testID={`expiry-${e}`}
            onPress={() => onPick(e)}
            style={({ pressed }) => [
              styles.expiryChip,
              on
                ? { borderColor: t.colors.primary, backgroundColor: t.colors.primarySoft }
                : { borderColor: t.colors.borderDark, backgroundColor: pressed ? t.colors.bgHover : 'transparent' },
            ]}
          >
            <AppText variant="caption" weight="600" color={on ? t.colors.primaryText : t.colors.textSecondary}>
              {expiryLabel(e)}
              <AppText variant="caption" weight="400" tone="muted">{` ${expiryDaysText(d)}`}</AppText>
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A summary-card figure: muted label over a semibold value. */
export function StatCell({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.stat}>
      <AppText variant="caption" weight="600" tone="muted">{label}</AppText>
      <AppText variant="bodyStrong" mono>{value}</AppText>
    </View>
  );
}

/** A future on the underlying — `{symbol} ₹{price}`, to the trade page. */
export function FutureChip({ symbol, lastPrice, onPress }: { symbol: string; lastPrice: unknown; onPress: () => void }): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Trade ${symbol}`}
      testID={`future-${symbol}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        { borderRadius: t.radius.lg, borderColor: t.colors.borderDark, backgroundColor: pressed ? t.colors.bgHover : 'transparent' },
      ]}
    >
      <AppText variant="caption" weight="600" tone="secondary">
        {symbol}
        <AppText variant="caption" weight="600" mono>{`  ${inr(lastPrice)}`}</AppText>
      </AppText>
    </Pressable>
  );
}

/* ── The table ────────────────────────────────────────────────────────── */

interface Widths { stat: number; ltp: number; strike: number; total: number }

const widthsFor = (cols: number, viewport: number): Widths => {
  const total = cols * STAT_W * 2 + LTP_W * 2 + STRIKE_W;
  // Narrower than the screen (no analytics): stretch every column alike.
  const k = viewport > total ? viewport / total : 1;
  return { stat: STAT_W * k, ltp: LTP_W * k, strike: STRIKE_W * k, total: total * k };
};

function LegButton({
  leg,
  side,
  onTrade,
}: {
  leg: OptionLeg | null;
  side: 'CE' | 'PE';
  onTrade: (symbol: string) => void;
}): React.JSX.Element {
  const t = useTheme();
  if (!leg) return <AppText variant="body" tone="muted">—</AppText>;
  const disabled = !leg.tradingEnabled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={disabled ? 'Trading disabled for this contract' : `Trade ${leg.symbol}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      testID={`premium-${leg.symbol}`}
      onPress={() => onTrade(leg.symbol)}
      hitSlop={4}
      style={({ pressed }) => [
        styles.leg,
        { opacity: disabled ? 0.5 : 1 },
        pressed && !disabled ? { backgroundColor: t.alpha(side === 'CE' ? t.colors.bull : t.colors.bear, 0.1) } : null,
      ]}
    >
      <AppText variant="body" mono>{legPremiumText(leg)}</AppText>
    </Pressable>
  );
}

function StatValue({
  col,
  leg,
  itm,
  side,
  maxOi,
  width,
  t,
}: {
  col: ChainColumn;
  leg: OptionLeg | null;
  itm: boolean;
  side: 'CE' | 'PE';
  maxOi: number;
  width: number;
  t: AppTheme;
}): React.JSX.Element {
  const v = leg?.stats ? leg.stats[col.key] : null;
  const tone = statTone(col, v);
  const color = tone === 'bull' ? t.colors.bull : tone === 'bear' ? t.colors.bear : tone === 'plain' ? t.colors.textPrimary : t.colors.textSecondary;
  const pct = col.bar ? oiBarPct(v, maxOi) : 0;
  return (
    <View
      style={[
        styles.cell,
        { width, alignItems: side === 'CE' ? 'flex-end' : 'flex-start' },
        itm ? { backgroundColor: t.alpha(AMBER, 0.05) } : null,
      ]}
    >
      {pct > 0 ? (
        <View
          pointerEvents="none"
          testID={`oi-bar-${side}`}
          style={[
            styles.bar,
            { width: `${pct}%`, backgroundColor: side === 'CE' ? OI_BAR_CE : OI_BAR_PE },
            // Grows from the strike outward.
            side === 'CE' ? { right: 0 } : { left: 0 },
          ]}
        />
      ) : null}
      <AppText variant="small" mono color={color} numberOfLines={1}>{col.fmt(v)}</AppText>
    </View>
  );
}

const StrikeRowView = memo(function StrikeRowView({
  row,
  cols,
  w,
  spot,
  atmStrike,
  maxOi,
  onTrade,
}: {
  row: OptionChainRow;
  cols: readonly ChainColumn[];
  w: Widths;
  spot: number;
  atmStrike: number | null;
  maxOi: number;
  onTrade: (symbol: string) => void;
}): React.JSX.Element {
  const t = useTheme();
  const ceItm = ceIsItm(row.strike, spot);
  const peItm = peIsItm(row.strike, spot);
  const atm = row.strike === atmStrike;
  return (
    <View
      testID={`strike-${row.strike}`}
      style={[styles.row, { height: ROW_H, borderTopColor: t.colors.borderSubtle }]}
    >
      {cols.map((c) => (
        <StatValue key={`c-${c.key}`} col={c} leg={row.CE} itm={ceItm} side="CE" maxOi={maxOi} width={w.stat} t={t} />
      ))}
      <View style={[styles.cell, { width: w.ltp, alignItems: 'flex-end' }, ceItm ? { backgroundColor: t.alpha(AMBER, 0.1) } : null]}>
        <LegButton leg={row.CE} side="CE" onTrade={onTrade} />
      </View>
      <View style={[styles.cell, styles.strikeCell, { width: w.strike }]}>
        <AppText variant="body" weight={atm ? '700' : '600'} mono color={atm ? t.colors.primaryText : t.colors.textPrimary}>
          {fmtStrike(row.strike)}
        </AppText>
        {atm ? <AppText variant="micro" weight="700" color={t.colors.primary}> ATM</AppText> : null}
      </View>
      <View style={[styles.cell, { width: w.ltp, alignItems: 'flex-start' }, peItm ? { backgroundColor: t.alpha(AMBER, 0.1) } : null]}>
        <LegButton leg={row.PE} side="PE" onTrade={onTrade} />
      </View>
      {[...cols].reverse().map((c) => (
        <StatValue key={`p-${c.key}`} col={c} leg={row.PE} itm={peItm} side="PE" maxOi={maxOi} width={w.stat} t={t} />
      ))}
    </View>
  );
});

function SpotRow({ spot, width }: { spot: number; width: number }): React.JSX.Element {
  const t = useTheme();
  return (
    <View testID="spot-row" style={[styles.spot, { width, height: SPOT_H, backgroundColor: t.alpha(t.colors.primary, 0.05) }]}>
      <View style={[styles.spotLine, { backgroundColor: t.alpha(t.colors.primary, 0.4) }]} />
      <AppText variant="micro" weight="700" color={t.colors.primaryText}>{`Spot ${inr(spot)}`}</AppText>
      <View style={[styles.spotLine, { backgroundColor: t.alpha(t.colors.primary, 0.4) }]} />
    </View>
  );
}

/**
 * The chain. `cols` is BASE_COLS / GREEK_COLS (or none without analytics).
 * The row box is at most ~60% of the window tall and centres the ATM row
 * once for each underlying + expiry it is shown.
 */
export function ChainTable({
  chain,
  cols,
  onTrade,
}: {
  chain: OptionChain;
  cols: readonly ChainColumn[];
  onTrade: (symbol: string) => void;
}): React.JSX.Element {
  const t = useTheme();
  const { height: winH } = useWindowDimensions();
  const [viewport, setViewport] = useState(0);
  const hScroll = useRef<ScrollView>(null);
  const vScroll = useRef<ScrollView>(null);
  const centredFor = useRef('');
  const hCentredFor = useRef('');

  const spot = Number(chain.spot?.lastPrice) || 0;
  const strikes = chain.strikes;
  const maxOi = useMemo(() => maxOiOf(strikes), [strikes]);
  const spotIndex = useMemo(() => spotIndexOf(strikes, spot), [strikes, spot]);
  const w = widthsFor(cols.length, viewport);
  const sideW = cols.length * w.stat + w.ltp;

  const contentH = strikes.length * ROW_H + (spotIndex >= 0 ? SPOT_H : 0);
  const boxH = Math.min(contentH, Math.max(240, Math.round(winH * 0.6)));

  // Centre LTP · Strike · LTP once per column set.
  const colsKey = `${cols.length}:${viewport}`;
  useEffect(() => {
    if (!viewport || hCentredFor.current === colsKey) return;
    hCentredFor.current = colsKey;
    const x = Math.max(0, (w.total - viewport) / 2);
    hScroll.current?.scrollTo({ x, animated: false });
  }, [colsKey, viewport, w.total]);

  // Centre the ATM row in the box, once per underlying + expiry.
  useEffect(() => {
    const key = `${chain.underlying}:${chain.expiry}`;
    if (chain.atmStrike === null || centredFor.current === key) return;
    const i = strikes.findIndex((s) => s.strike === chain.atmStrike);
    if (i < 0) return;
    centredFor.current = key;
    const y = i * ROW_H + (spotIndex >= 0 && spotIndex <= i ? SPOT_H : 0);
    vScroll.current?.scrollTo({ y: Math.max(0, y - boxH / 2 + ROW_H / 2), animated: false });
  }, [chain.underlying, chain.expiry, chain.atmStrike, strikes, spotIndex, boxH]);

  const label = (text: string, width: number, align: 'left' | 'right' | 'center'): React.JSX.Element => (
    <View style={[styles.headCell, { width, alignItems: align === 'right' ? 'flex-end' : align === 'left' ? 'flex-start' : 'center' }]}>
      <AppText variant="micro" weight="600" tone="muted" numberOfLines={1} style={styles.upper}>{text}</AppText>
    </View>
  );

  return (
    <View onLayout={(e) => setViewport(Math.round(e.nativeEvent.layout.width))} testID="option-chain-table">
      <ScrollView ref={hScroll} horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled>
        <View style={{ width: w.total }}>
          {/* Head: Calls (CE) · · Puts (PE), then the column labels. */}
          <View style={[styles.headRow, { backgroundColor: t.colors.bgCard }]}>
            <View style={[styles.headCell, { width: sideW, borderRightWidth: 1, borderRightColor: t.colors.borderSubtle }]}>
              <AppText variant="micro" weight="700" color={t.colors.bull} style={styles.upper}>Calls (CE)</AppText>
            </View>
            <View style={{ width: w.strike }} />
            <View style={[styles.headCell, { width: sideW, borderLeftWidth: 1, borderLeftColor: t.colors.borderSubtle }]}>
              <AppText variant="micro" weight="700" color={t.colors.bear} style={styles.upper}>Puts (PE)</AppText>
            </View>
          </View>
          <View style={[styles.headRow, styles.headLabels, { backgroundColor: t.colors.bgCard }]}>
            {cols.map((c) => <React.Fragment key={`ch-${c.key}`}>{label(c.label, w.stat, 'right')}</React.Fragment>)}
            {label('LTP', w.ltp, 'right')}
            {label('Strike', w.strike, 'center')}
            {label('LTP', w.ltp, 'left')}
            {[...cols].reverse().map((c) => <React.Fragment key={`ph-${c.key}`}>{label(c.label, w.stat, 'left')}</React.Fragment>)}
          </View>
          <ScrollView ref={vScroll} style={{ height: boxH }} nestedScrollEnabled showsVerticalScrollIndicator>
            {strikes.map((row, i) => (
              <React.Fragment key={row.strike}>
                {i === spotIndex ? <SpotRow spot={spot} width={w.total} /> : null}
                <StrikeRowView
                  row={row}
                  cols={cols}
                  w={w}
                  spot={spot}
                  atmStrike={chain.atmStrike}
                  maxOi={maxOi}
                  onTrade={onTrade}
                />
              </React.Fragment>
            ))}
            {spotIndex === strikes.length ? <SpotRow spot={spot} width={w.total} /> : null}
          </ScrollView>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  kindPill: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 999, borderWidth: 1 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1 },
  expiryRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  expiryLabel: { letterSpacing: 0.6, marginRight: 4 },
  expiryChip: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, borderWidth: 1 },
  stat: { minWidth: 96, gap: 2 },
  leg: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  row: { flexDirection: 'row', alignItems: 'stretch', borderTopWidth: StyleSheet.hairlineWidth },
  cell: { justifyContent: 'center', paddingHorizontal: 8, overflow: 'hidden' },
  strikeCell: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  bar: { position: 'absolute', top: 0, bottom: 0 },
  headRow: { flexDirection: 'row' },
  headLabels: { paddingBottom: 6 },
  headCell: { justifyContent: 'center', alignItems: 'center', paddingHorizontal: 8, paddingTop: 8 },
  upper: { textTransform: 'uppercase' },
  spot: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 },
  spotLine: { height: 1, flex: 1 },
});
