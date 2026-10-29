import React, { useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';

import { AppText, BottomSheet, Icon } from '@/components/ui';
import { fmtPrice } from '@/utils/money';
import {
  PRICE_MODE_OPTIONS,
  PRICE_MODE_SHORT,
  sanitizeDecimal,
  type TpSlMode,
} from '@/utils/orderForm';

import { ORDER_TONES, type OrderPalette } from './palette';

/**
 * The order form's presentational pieces — OrderForm.jsx's SidePriceCard,
 * HelpTip, FieldCard, NumericRow, PriceModeDropdown and InfoRow.
 *
 * Mobile adaptations, nothing else: the hover tooltip ("?") opens on press
 * as a sheet; PriceModeDropdown's floating menu and the native <select> are
 * bottom sheets (the web's own Modal becomes one on phones too).
 */

/* ── Sell / Buy price card ────────────────────────────────────────────── */

export function SidePriceCard({
  label,
  price,
  prec,
  quoteCurrency,
  active,
  tone,
  C,
  onPress,
  disabled,
}: {
  label: string;
  price: number | null;
  prec: number;
  quoteCurrency: string;
  active: boolean;
  tone: 'buy' | 'sell';
  C: OrderPalette;
  onPress: () => void;
  /** Trading switched off for the symbol: dimmed and dead. */
  disabled?: boolean;
}): React.JSX.Element {
  const isBuy = tone === 'buy';
  const accent = isBuy ? C.buy : C.sell;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[s.sideCard, { backgroundColor: active ? accent : C.cardBg, borderColor: accent, opacity: disabled ? 0.5 : 1 }]}
    >
      <AppText variant="small" color={active ? ORDER_TONES.onActiveDim : C.dim}>{label}</AppText>
      <AppText
        mono
        align="right"
        weight="500"
        style={s.sidePrice}
        color={active ? ORDER_TONES.white : (isBuy ? C.buy : C.text)}
      >
        {price !== null && Number.isFinite(price) ? fmtPrice(price, prec, quoteCurrency) : '—'}
      </AppText>
    </Pressable>
  );
}

/* ── "?" help ─────────────────────────────────────────────────────────── */

/** HelpTip — the web's hover card, opened by a press. */
export function HelpTip({ text, title, C }: { text: string; title: string; C: OrderPalette }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={text}
        hitSlop={8}
        onPress={() => setOpen(true)}
        style={[s.help, { borderColor: C.muted }]}
      >
        <AppText variant="micro" color={C.muted}>?</AppText>
      </Pressable>
      <BottomSheet open={open} onClose={() => setOpen(false)} title={title}>
        <AppText variant="small" color={C.text}>{text}</AppText>
      </BottomSheet>
    </>
  );
}

/* ── Field wrapper ────────────────────────────────────────────────────── */

export function FieldCard({
  label,
  help,
  error,
  subtext,
  C,
  children,
}: {
  label: string;
  help?: string;
  error?: string | null;
  subtext?: string | null;
  C: OrderPalette;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <View>
      <View style={s.fieldHead}>
        <AppText variant="small" color={C.text}>{label}</AppText>
        {help ? <HelpTip text={help} title={label} C={C} /> : null}
      </View>
      {children}
      {error ? (
        <View style={s.fieldError}>
          <AppText variant="small" color={C.sell}>⚠</AppText>
          <AppText variant="small" color={C.sell} style={s.flex}>{error}</AppText>
        </View>
      ) : null}
      {!error && subtext ? (
        <AppText variant="small" color={C.dim} style={s.fieldSub}>{subtext}</AppText>
      ) : null}
    </View>
  );
}

/* ── The unified numeric bar ──────────────────────────────────────────── */

/**
 * NumericRow's `unified` variant (the only one the form uses): input · pill ·
 * price-mode · suffix · − · +, in one bordered bar. `onFocus` / `onBlur` let
 * the TP / SL fields keep exactly what is typed while focused and normalise
 * on blur (OrderForm.jsx tpOnFocus / tpOnBlur).
 */
export function NumericRow({
  value,
  onChange,
  onFocus,
  onBlur,
  onMinus,
  onPlus,
  placeholder,
  suffix,
  pill,
  priceMode,
  onPriceModeChange,
  allowNegative,
  error,
  C,
  testID,
  accessibilityLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onMinus: () => void;
  onPlus: () => void;
  placeholder?: string;
  suffix?: string;
  pill?: string;
  priceMode?: TpSlMode;
  onPriceModeChange?: (m: TpSlMode) => void;
  allowNegative?: boolean;
  error?: boolean;
  C: OrderPalette;
  testID?: string;
  accessibilityLabel?: string;
}): React.JSX.Element {
  return (
    <View style={[s.bar, { backgroundColor: C.cardBg, borderColor: error ? C.sell : C.border }]}>
      <View style={s.barInput}>
        <TextInput
          testID={testID}
          accessibilityLabel={accessibilityLabel}
          value={value}
          onChangeText={(v) => onChange(sanitizeDecimal(v, allowNegative))}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder={placeholder}
          placeholderTextColor={C.muted}
          keyboardType={allowNegative ? (Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'numeric') : 'decimal-pad'}
          style={[s.barText, { color: error ? C.sell : C.text }]}
        />
      </View>
      {pill ? <View style={s.barSeg}><AppText variant="body" weight="500" color={C.dim}>{pill}</AppText></View> : null}
      {onPriceModeChange ? (
        <PriceModeDropdown C={C} mode={priceMode ?? 'price'} onChange={onPriceModeChange} />
      ) : null}
      {suffix ? <View style={s.barSeg}><AppText variant="body" weight="500" color={C.dim}>{suffix}</AppText></View> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Decrease"
        testID={testID ? `${testID}-minus` : undefined}
        onPress={onMinus}
        style={({ pressed }) => [s.barBtn, { borderLeftColor: C.border }, pressed ? s.pressed : null]}
      >
        <Icon name="minus" size={14} color={C.text} strokeWidth={2} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Increase"
        testID={testID ? `${testID}-plus` : undefined}
        onPress={onPlus}
        style={({ pressed }) => [s.barBtn, { borderLeftColor: C.border }, pressed ? s.pressed : null]}
      >
        <Icon name="plus" size={14} color={C.text} strokeWidth={2} />
      </Pressable>
    </View>
  );
}

/* ── TP/SL price-mode picker ──────────────────────────────────────────── */

/** PriceModeDropdown — how a TP/SL field is expressed (price / pips / money / % of equity). */
export function PriceModeDropdown({
  C,
  mode,
  onChange,
}: {
  C: OrderPalette;
  mode: TpSlMode;
  onChange: (m: TpSlMode) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`TP/SL mode: ${PRICE_MODE_SHORT[mode] || 'Price'}`}
        onPress={() => setOpen((v) => !v)}
        style={s.modeTrigger}
      >
        <AppText variant="body" weight="500" color={C.dim}>{PRICE_MODE_SHORT[mode] || 'Price'}</AppText>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={10} color={C.dim} strokeWidth={2.6} />
      </Pressable>
      <BottomSheet open={open} onClose={() => setOpen(false)} bodyPadding={0}>
        {PRICE_MODE_OPTIONS.map((opt) => {
          const active = opt.id === mode;
          return (
            <Pressable
              key={opt.id}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => { onChange(opt.id); setOpen(false); }}
              style={[s.modeRow, { backgroundColor: active ? ORDER_TONES.activeModeBg : 'transparent' }]}
            >
              <AppText variant="body" weight={active ? '600' : '500'} color={active ? C.buy : C.text}>
                {opt.label}
              </AppText>
            </Pressable>
          );
        })}
      </BottomSheet>
    </>
  );
}

/* ── A native-select stand-in ─────────────────────────────────────────── */

export interface PanelOption<V extends string> {
  value: V;
  label: string;
  disabled?: boolean;
}

/** The web's full-width <select> (the order-entry mode): a trigger and a sheet. */
export function PanelSelect<V extends string>({
  value,
  options,
  onChange,
  title,
  accessibilityLabel,
  borderColor,
  C,
  testID,
}: {
  value: V;
  options: readonly PanelOption<V>[];
  onChange: (v: V) => void;
  title: string;
  accessibilityLabel: string;
  borderColor?: string;
  C: OrderPalette;
  testID?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={() => setOpen(true)}
        style={[s.select, { backgroundColor: C.cardBg, borderColor: borderColor ?? C.border }]}
      >
        <AppText variant="body" weight="500" color={C.text} numberOfLines={1} style={s.flex}>{current?.label ?? ''}</AppText>
        <Icon name="chevronDown" size={14} color={C.dim} strokeWidth={2} />
      </Pressable>
      <BottomSheet open={open} onClose={() => setOpen(false)} title={title} bodyPadding={0}>
        {options.map((o) => {
          const active = o.value === value;
          return (
            <Pressable
              key={o.value}
              accessibilityRole="button"
              accessibilityState={{ selected: active, disabled: !!o.disabled }}
              disabled={o.disabled}
              onPress={() => { onChange(o.value); setOpen(false); }}
              style={[s.selectRow, { opacity: o.disabled ? 0.5 : 1, backgroundColor: active ? ORDER_TONES.activeModeBg : 'transparent' }]}
            >
              <AppText variant="body" weight={active ? '600' : '500'} color={C.text} style={s.flex}>{o.label}</AppText>
              {active ? <Icon name="check" size={16} color={C.buy} strokeWidth={2.5} /> : null}
            </Pressable>
          );
        })}
      </BottomSheet>
    </>
  );
}

/* ── Info row ─────────────────────────────────────────────────────────── */

export function InfoRow({
  label,
  value,
  help,
  valueColor,
  C,
}: {
  label: string;
  value: string;
  help?: string;
  valueColor?: string;
  C: OrderPalette;
}): React.JSX.Element {
  return (
    <View style={s.infoRow}>
      <AppText variant="body" color={C.dim}>{`${label}:`}</AppText>
      <View style={s.infoValue}>
        <AppText variant="body" mono color={valueColor || C.text}>{value}</AppText>
        {help ? <HelpTip text={help} title={label} C={C} /> : null}
      </View>
    </View>
  );
}

/* ── Notice box ───────────────────────────────────────────────────────── */

export function Notice({
  children,
  bg,
  border,
  style,
}: {
  children: ReactNode;
  bg: string;
  border: string;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  return <View style={[s.notice, { backgroundColor: bg, borderColor: border }, style]}>{children}</View>;
}

const s = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.7 },
  sideCard: { flex: 1, height: 62, borderWidth: 1, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 8, overflow: 'hidden' },
  sidePrice: { fontSize: 16, lineHeight: 20, marginTop: 2 },
  help: { width: 16, height: 16, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center', opacity: 0.8 },
  fieldHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  fieldError: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 6 },
  fieldSub: { marginTop: 6 },
  bar: { flexDirection: 'row', alignItems: 'stretch', borderWidth: 1, borderRadius: 6, height: 42, overflow: 'hidden' },
  barInput: { flex: 1, minWidth: 0, justifyContent: 'center', paddingLeft: 12, paddingRight: 8 },
  barText: { fontSize: 15, fontWeight: '600', paddingVertical: 0, fontVariant: ['tabular-nums'] },
  barSeg: { justifyContent: 'center', paddingHorizontal: 8 },
  barBtn: { width: 44, alignItems: 'center', justifyContent: 'center', borderLeftWidth: 1 },
  modeTrigger: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8 },
  modeRow: { paddingHorizontal: 20, paddingVertical: 14 },
  select: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 4, paddingLeft: 12, paddingRight: 12, minHeight: 38 },
  selectRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 14 },
  infoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  infoValue: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  notice: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 10 },
});
