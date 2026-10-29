import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { AppText, Button, Input, Modal, Segmented, toast } from '@/components/ui';
import { makeStyles, useTheme } from '@/theme';
import {
  PARTIAL_FRACTIONS,
  PF_MODES,
  deltaParts,
  initialPartialQty,
  partialPreset,
  pipSizeFor,
  priceFromUnit,
  slTpDelta,
  slTpEntry,
  slTpHypotheticalPnl,
  slTpPayload,
  slTpPrecision,
  stepSlTpPrice,
  unitFromPrice,
  type PriceFieldContext,
  type PriceFieldMode,
  type SlTpDelta,
  type SlTpInstrument,
  type SlTpPayload,
  type SlTpTarget,
} from '@/utils/explore';
import { sanitizeAmountInput } from '@/utils/fundsFlows';
import { CURRENCY, fmtMoney, fmtNum, fmtPrice } from '@/utils/money';

export type { SlTpInstrument, SlTpPayload, SlTpTarget } from '@/utils/explore';

/**
 * The SL/TP and partial-close sheet — EquityHub's
 * client/src/components/PositionSlTpModal.jsx (INR: the live P&L reads
 * "+₹12.30", the money unit is INR).
 * Shared by Explore (open positions and pending orders) and, from stage 5,
 * the Trade page. Tabs:
 *   • Modify        — Take Profit / Stop Loss, entered by price, pips, money
 *                     or % of equity, with ±1 pip steppers
 *   • Partial close — close part of the position (positions only)
 *   • Close by      — close all of it at market (positions only)
 * A pending order (`kind="order"`) shows only "Modify order" and edits its
 * SL/TP.
 *
 * The host renders it while a row is being edited and unmounts it on close,
 * as the web does — each opening starts from the row's own levels.
 *
 * Differences from the web, on purpose:
 *   - An open position's header P&L is the row's `unrealizedPnl` — the
 *     server's figure (PORT-RULINGS §2) — not `(last − entry) × qty`
 *     recomputed here. A pending order has no server P&L; for it the web's
 *     hypothetical figure is kept.
 *   - The price field keeps what is being typed as typed (the web does the
 *     same while the field is focused) — here keyed on the value it last
 *     handed up rather than on focus.
 *   - Levels are sent as the decimal strings typed (`"82450."` → `"82450"`);
 *     the server stores `String(level)`. See utils/explore slTpPayload.
 */
export interface PositionSlTpModalProps {
  /** The open position, or the pending order (`kind="order"`). */
  position: SlTpTarget;
  kind?: 'position' | 'order';
  /** The instrument, with its live price as `lastPrice` when there is one. */
  instrument?: SlTpInstrument | null;
  /** Free margin, for "In % of equity". 0 disables that unit (Explore passes 0). */
  free?: number;
  onClose: () => void;
  /** Modify: `{ takeProfit, stopLoss }`, null removing a level. */
  onSubmit: (payload: SlTpPayload) => Promise<void> | void;
  /** Partial close / Close by: the quantity to close (the full size for Close by). */
  onPartialClose: (quantity: number) => Promise<void> | void;
}

type Tab = 'modify' | 'partial' | 'closeby';

const HINT = 'Enter this level by asset price, pips, money, or % of equity';

export function PositionSlTpModal({
  position,
  kind = 'position',
  instrument,
  free = 0,
  onClose,
  onSubmit,
  onPartialClose,
}: PositionSlTpModalProps): React.JSX.Element {
  const t = useTheme();
  const isOrder = kind === 'order';
  const [tab, setTab] = useState<Tab>('modify');
  const [tp, setTp] = useState(position.takeProfit ? String(position.takeProfit) : '');
  const [sl, setSl] = useState(position.stopLoss ? String(position.stopLoss) : '');
  const [partialQty, setPartialQty] = useState(() => initialPartialQty(position.quantity));
  const [saving, setSaving] = useState(false);

  const precision = slTpPrecision(instrument);
  const pipSize = pipSizeFor(precision);
  const entry = slTpEntry(position);
  const lastPx = Number(instrument?.lastPrice) || 0;
  const qty = Number(position.quantity) || 0;
  const isBuy = position.side === 'BUY';
  // EquityHub quotes every instrument in rupees.
  const ccy = CURRENCY;
  const ctx = { entry, qty, isBuy, pipSize };

  const serverPnl = !isOrder && position.unrealizedPnl !== null && position.unrealizedPnl !== undefined
    ? Number(position.unrealizedPnl)
    : NaN;
  const pnl = Number.isFinite(serverPnl) ? serverPnl : slTpHypotheticalPnl(lastPx, ctx);

  const stepOpts = { entry, lastPx, precision, pipSize };

  const run = async (fn: () => Promise<void> | void): Promise<void> => {
    setSaving(true);
    try {
      await fn();
    } catch {
      // The host reports its own failures (a toast with the server's words).
    } finally {
      setSaving(false);
    }
  };

  const tabs = isOrder
    ? [{ value: 'modify' as Tab, label: 'Modify order' }]
    : [
      { value: 'modify' as Tab, label: 'Modify' },
      { value: 'partial' as Tab, label: 'Partial close' },
      { value: 'closeby' as Tab, label: 'Close by' },
    ];

  const header = (
    <View style={styles.header}>
      <View style={styles.flex}>
        <View style={styles.titleRow}>
          {instrument?.icon ? <AppText variant="h3">{instrument.icon}</AppText> : null}
          <AppText variant="title">{position.symbol}</AppText>
          <AppText variant="body" tone="muted" mono>{`${fmtNum(qty, 2)} lots`}</AppText>
        </View>
        <AppText variant="body" style={styles.sub}>
          <AppText variant="body" weight="600" color={isBuy ? t.colors.primaryText : t.colors.bear}>{isBuy ? 'Buy' : 'Sell'}</AppText>
          <AppText variant="body" tone="muted">{' at '}</AppText>
          <AppText variant="body" mono>{fmtPrice(entry, precision, ccy)}</AppText>
        </AppText>
      </View>
      <View style={styles.right}>
        <AppText variant="body" mono weight="700" color={pnl >= 0 ? t.colors.bull : t.colors.bear} testID="sltp-pnl">
          {`${pnl >= 0 ? '+' : '-'}${fmtMoney(Math.abs(pnl))}`}
        </AppText>
        <AppText variant="caption" tone="muted" mono>{fmtPrice(lastPx, precision, ccy)}</AppText>
      </View>
    </View>
  );

  const partialNum = Number(partialQty) || 0;

  return (
    <Modal open onClose={onClose} title={header} testID="position-sltp-modal">
      <Segmented options={tabs} value={tab} onChange={setTab} fill />

      <View style={styles.body}>
        {tab === 'modify' ? (
          <>
            <PriceField
              label="Take Profit"
              value={tp}
              onChange={setTp}
              onClear={() => setTp('')}
              onStep={(dir) => setTp(stepSlTpPrice(tp || entry || lastPx, dir, stepOpts))}
              delta={slTpDelta(tp, ctx)}
              deltaTone="bull"
              ctx={{ refPrice: entry || lastPx, qty, pipSize, free, isTp: true, side: String(position.side) }}
              currency={ccy}
            />
            <PriceField
              label="Stop Loss"
              value={sl}
              onChange={setSl}
              onClear={() => setSl('')}
              onStep={(dir) => setSl(stepSlTpPrice(sl || entry || lastPx, dir, stepOpts))}
              delta={slTpDelta(sl, ctx)}
              deltaTone="bear"
              ctx={{ refPrice: entry || lastPx, qty, pipSize, free, isTp: false, side: String(position.side) }}
              currency={ccy}
            />
            <Button
              title={isOrder ? 'Modify order' : 'Modify position'}
              loading={saving}
              loadingTitle="Saving…"
              fullWidth
              size="lg"
              onPress={() => { void run(() => onSubmit(slTpPayload(tp, sl))); }}
            />
          </>
        ) : null}

        {tab === 'partial' ? (
          <>
            <Input
              label="Quantity to close"
              value={partialQty}
              onChangeText={(v) => setPartialQty(sanitizeAmountInput(v))}
              keyboardType="decimal-pad"
              mono
              right={<AppText variant="small" tone="muted">{`/ ${fmtNum(qty, 2)} lots`}</AppText>}
              testID="sltp-partial-qty"
            />
            <View style={styles.presets}>
              {PARTIAL_FRACTIONS.map((f) => (
                <Pressable
                  key={f}
                  accessibilityRole="button"
                  onPress={() => setPartialQty(partialPreset(qty, f))}
                  style={({ pressed }) => [
                    styles.preset,
                    { borderColor: pressed ? t.colors.primary : t.colors.borderDark },
                  ]}
                >
                  <AppText variant="caption" weight="700" tone="secondary">{`${fmtNum(f * 100, 0)}%`}</AppText>
                </Pressable>
              ))}
            </View>
            <Button
              title={`Close ${fmtNum(partialNum, 2)} lots`}
              loading={saving}
              loadingTitle="Closing…"
              disabled={!partialNum}
              fullWidth
              size="lg"
              onPress={() => { void run(() => onPartialClose(Number(partialQty))); }}
            />
          </>
        ) : null}

        {tab === 'closeby' ? (
          <>
            <View style={[styles.note, { backgroundColor: t.alpha(t.colors.bgHover, 0.5), borderColor: t.colors.borderSubtle }]}>
              <AppText variant="small" tone="secondary">
                {'Close the entire '}
                <AppText variant="small" weight="700">{`${fmtNum(qty, 2)} lot`}</AppText>
                {` ${isBuy ? 'long' : 'short'} position at market. Realized P&L will settle to your trading wallet.`}
              </AppText>
            </View>
            <Button
              title={`Close ${fmtNum(qty, 2)} lots at market`}
              loading={saving}
              loadingTitle="Closing…"
              fullWidth
              size="lg"
              onPress={() => { void run(() => onPartialClose(qty)); }}
            />
          </>
        ) : null}
      </View>
    </Modal>
  );
}

/* ── One price field ─────────────────────────────────────────────────── */

const sanitizeFor = (mode: PriceFieldMode, v: string): string => {
  if (mode === 'price') return sanitizeAmountInput(v);
  // Pips / money / % may be negative (a level on the other side of entry).
  const negative = v.trim().startsWith('-');
  const body = sanitizeAmountInput(v);
  return negative ? `-${body}` : body;
};

function PriceField({
  label,
  value,
  onChange,
  onClear,
  onStep,
  delta,
  deltaTone,
  ctx,
  currency,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
  onStep: (dir: 1 | -1) => void;
  delta: SlTpDelta;
  deltaTone: 'bull' | 'bear';
  ctx: PriceFieldContext;
  currency: string;
}): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  const has = !!value && value.trim() !== '';
  const [mode, setMode] = useState<PriceFieldMode>('price');
  const [menuOpen, setMenuOpen] = useState(false);
  const [input, setInput] = useState(() => unitFromPrice(value, 'price', ctx));
  // What this field last handed up. When the stored price comes back as
  // exactly that, the text being typed stays as typed.
  const emitted = useRef<{ value: string; mode: PriceFieldMode } | null>(null);

  useEffect(() => {
    const e = emitted.current;
    if (e && e.value === value && e.mode === mode) return;
    emitted.current = null;
    setInput(unitFromPrice(value, mode, ctx));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, mode, ctx.refPrice, ctx.qty, ctx.free]);

  const handleInput = (rawIn: string): void => {
    const raw = sanitizeFor(mode, rawIn);
    setInput(raw);
    // Price mode passes the text straight through so decimals type naturally.
    const next = mode === 'price' ? raw : (() => {
      const price = priceFromUnit(raw, mode, ctx);
      return price === '' ? '' : String(price);
    })();
    emitted.current = { value: next, mode };
    onChange(next);
  };

  const cur = PF_MODES.find((m) => m.id === mode) ?? PF_MODES[0];
  const shortOf = (m: (typeof PF_MODES)[number]): string => (m.id === 'money' ? currency : m.short);
  // The money part in rupees, sign first ("-₹12.30") — PositionSlTpModal.jsx.
  const parts = { ...deltaParts(delta, currency), money: fmtMoney(delta.money) };

  const buttonStyle = ({ pressed }: { pressed: boolean }) => [
    s.fieldBtn,
    pressed && { backgroundColor: t.colors.bgHover },
  ];

  return (
    <View>
      <View style={styles.labelRow}>
        <AppText variant="body" weight="600" tone="secondary">{label}</AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={HINT}
          onPress={() => toast(HINT)}
          hitSlop={8}
          style={[styles.hint, { borderColor: t.colors.borderDark }]}
        >
          <AppText variant="micro" tone="muted">?</AppText>
        </Pressable>
      </View>
      <Input
        value={input}
        placeholder="Not set"
        onChangeText={handleInput}
        keyboardType={mode === 'price' ? 'decimal-pad' : Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'numeric'}
        mono
        testID={`sltp-field-${label}`}
        accessibilityLabel={label}
        right={(
          <View style={styles.fieldBtns}>
            {has ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Clear" onPress={onClear} style={buttonStyle} hitSlop={4}>
                <AppText variant="title" tone="muted">×</AppText>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${label} unit: ${cur?.label ?? ''}`}
              onPress={() => setMenuOpen((o) => !o)}
              style={(st) => [...buttonStyle(st), s.unitBtn]}
            >
              <AppText variant="caption" tone="secondary">{`${cur ? shortOf(cur) : ''} ${menuOpen ? '▴' : '▾'}`}</AppText>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="−1 pip" onPress={() => onStep(-1)} style={buttonStyle}>
              <AppText variant="title" tone="secondary">−</AppText>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="+1 pip" onPress={() => onStep(1)} style={buttonStyle}>
              <AppText variant="title" tone="secondary">+</AppText>
            </Pressable>
          </View>
        )}
      />
      {menuOpen ? (
        <View style={s.menu}>
          {PF_MODES.map((m) => {
            const on = m.id === mode;
            return (
              <Pressable
                key={m.id}
                accessibilityRole="menuitem"
                accessibilityState={{ selected: on }}
                onPress={() => { setMode(m.id); setMenuOpen(false); }}
                style={({ pressed }) => [
                  styles.menuItem,
                  { backgroundColor: on ? t.colors.primarySoft : pressed ? t.colors.bgHover : 'transparent' },
                ]}
              >
                <AppText variant="small" weight={on ? '600' : '400'} color={on ? t.colors.primaryText : t.colors.textSecondary}>
                  {m.label}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {has ? (
        <View style={styles.deltaRow}>
          <AppText variant="caption" mono weight="600" color={deltaTone === 'bull' ? t.colors.bull : t.colors.bear}>{parts.pips}</AppText>
          <AppText variant="caption" tone="muted">·</AppText>
          <AppText variant="caption" mono tone="secondary">{parts.money}</AppText>
          <AppText variant="caption" tone="muted">·</AppText>
          <AppText variant="caption" mono tone="secondary">{parts.pct}</AppText>
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  fieldBtn: {
    minWidth: 34,
    minHeight: 40,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: t.colors.borderSubtle,
  },
  unitBtn: { minWidth: 52 },
  menu: {
    marginTop: 4,
    borderWidth: 1,
    borderColor: t.colors.borderDark,
    borderRadius: t.radius.lg,
    backgroundColor: t.colors.surface,
    paddingVertical: 4,
    overflow: 'hidden',
  },
}));

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  sub: { marginTop: 4 },
  right: { alignItems: 'flex-end' },
  body: { marginTop: 20, gap: 20 },
  presets: { flexDirection: 'row', gap: 6, marginTop: -12 },
  preset: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 4, borderWidth: 1 },
  note: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10 },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  hint: { width: 16, height: 16, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  fieldBtns: { flexDirection: 'row', alignItems: 'stretch', marginRight: -12 },
  menuItem: { paddingHorizontal: 12, paddingVertical: 8 },
  deltaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
});
