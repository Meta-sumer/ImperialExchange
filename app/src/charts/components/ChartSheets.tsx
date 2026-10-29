import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { AppText, BottomSheet, Button, Modal } from '@/components/ui';
import { alpha, useTheme } from '@/theme';

import { CHART_COLOR_SWATCHES, CHART_TYPES, SCALE_MODES, TF_OPTIONS, type ChartPrefs, type ChartTimeframe, type ChartType } from '../chartCatalog';
import { ChartTypeGlyph, ToolIcon, type ToolIconName } from './chartGlyphs';

/**
 * The chart's small pickers as sheets: chart type, timeframe, the long-press
 * scale menu (PriceChart.jsx ChartContextMenu) and the text prompt that
 * replaces the web's window.prompt for text / note drawings. ColorField is
 * the phone's stand-in for <input type="color">: swatches plus a hex field.
 */

export function SheetRow({
  label,
  onPress,
  active,
  left,
  right,
  danger,
  testID,
}: {
  label: string;
  onPress: () => void;
  active?: boolean;
  left?: React.ReactNode;
  right?: React.ReactNode;
  danger?: boolean;
  testID?: string;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        s.row,
        { backgroundColor: active ? alpha(t.colors.primary, 0.1) : pressed ? t.colors.bgHover : 'transparent' },
      ]}
    >
      {left ? <View style={s.rowLeft}>{left}</View> : null}
      <AppText variant="body" style={s.rowLabel} color={danger ? t.colors.bear : active ? t.colors.primaryText : t.colors.textPrimary} numberOfLines={1}>
        {label}
      </AppText>
      {right ?? (active ? <ToolIcon name="check" color={t.colors.primaryText} size={14} /> : null)}
    </Pressable>
  );
}

export function ChartTypeSheet({ open, value, onPick, onClose }: { open: boolean; value: ChartType; onPick: (v: ChartType) => void; onClose: () => void }): React.JSX.Element {
  const t = useTheme();
  return (
    <BottomSheet open={open} onClose={onClose} title="Chart Type" bodyPadding={0} testID="chart-type-sheet">
      {CHART_TYPES.map((ct) => (
        <SheetRow
          key={ct.id}
          label={ct.label}
          active={ct.id === value}
          left={<ChartTypeGlyph type={ct.id} color={ct.id === value ? t.colors.primaryText : t.colors.textMuted} />}
          onPress={() => { onPick(ct.id); onClose(); }}
          testID={`chart-type-${ct.id}`}
        />
      ))}
    </BottomSheet>
  );
}

export function TimeframeSheet({ open, value, onPick, onClose }: { open: boolean; value: string; onPick: (v: ChartTimeframe) => void; onClose: () => void }): React.JSX.Element {
  return (
    <BottomSheet open={open} onClose={onClose} title="Timeframe" bodyPadding={0} testID="timeframe-sheet">
      {TF_OPTIONS.map((tf) => (
        <SheetRow key={tf} label={tf} active={tf === value} onPress={() => { onPick(tf); onClose(); }} testID={`tf-${tf}`} />
      ))}
    </BottomSheet>
  );
}

/** PriceChart.jsx ChartContextMenu, opened by a long press on the chart. */
export function ChartContextSheet({
  open,
  prefs,
  manualY,
  manualX,
  onSetPref,
  onScale,
  onMoreSettings,
  onClose,
}: {
  open: boolean;
  prefs: ChartPrefs;
  manualY: boolean;
  manualX: boolean;
  onSetPref: (patch: Partial<ChartPrefs>) => void;
  onScale: (cmd: 'refresh' | 'autoFit' | 'resetY' | 'resetX' | 'resetAll') => void;
  onMoreSettings: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const icon = (name: ToolIconName, tone?: string): React.ReactNode => <ToolIcon name={name} color={tone ?? t.colors.textMuted} size={15} />;
  const lock = (on: boolean): React.ReactNode => (on ? (
    <View style={[s.lock, { backgroundColor: alpha('#F59E0B', 0.14) }]}>
      <AppText variant="micro" weight="700" color="#F59E0B">MANUAL</AppText>
    </View>
  ) : null);
  const run = (fn: () => void) => () => { fn(); onClose(); };
  return (
    <BottomSheet open={open} onClose={onClose} title="Chart" bodyPadding={0} testID="chart-context-sheet">
      <SheetRow label="Auto (fits data to screen)" active={prefs.autoScale} left={icon('zoomReset')} onPress={run(() => { onSetPref({ autoScale: true }); onScale('autoFit'); })} />
      <SheetRow label="Invert scale" active={prefs.invert} onPress={run(() => onSetPref({ invert: !prefs.invert }))} />
      <View style={[s.divider, { backgroundColor: t.colors.borderSubtle }]} />
      {([['normal', 'Regular'], ['percent', 'Percent'], ['indexed', 'Indexed to 100'], ['log', 'Logarithmic']] as const).map(([k, label]) => (
        <SheetRow key={k} label={label} active={prefs.scaleMode === k} onPress={run(() => onSetPref({ scaleMode: k }))} />
      ))}
      <View style={[s.divider, { backgroundColor: t.colors.borderSubtle }]} />
      <SheetRow label="Refresh scale" left={icon('undo')} onPress={run(() => onScale('refresh'))} />
      <SheetRow label="Reset Y-Axis Zoom" left={icon('clock')} right={lock(manualY)} onPress={run(() => onScale('resetY'))} />
      <SheetRow label="Reset X-Axis Zoom" left={icon('clock')} right={lock(manualX)} onPress={run(() => onScale('resetX'))} />
      <SheetRow label="Reset all view" left={icon('zoomReset', t.colors.primaryText)} onPress={run(() => onScale('resetAll'))} />
      <View style={[s.divider, { backgroundColor: t.colors.borderSubtle }]} />
      <SheetRow label="More settings…" left={icon('gear')} onPress={() => { onClose(); onMoreSettings(); }} />
    </BottomSheet>
  );
}

/** The web's `window.prompt('Text:')` / `('Note text:', 'Note')`. */
export function TextPromptModal({
  open,
  title,
  initial,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  initial: string;
  onSubmit: (text: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const [text, setText] = useState(initial);
  useEffect(() => { if (open) setText(initial); }, [open, initial]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      presentation="center"
      size="sm"
      testID="chart-text-prompt"
      footer={(
        <View style={s.footer}>
          <Button title="Cancel" variant="secondary" onPress={onClose} />
          <Button title="Add" onPress={() => { onSubmit(text); onClose(); }} />
        </View>
      )}
    >
      <TextInput
        value={text}
        onChangeText={setText}
        autoFocus
        placeholder="Text"
        placeholderTextColor={t.colors.textMuted}
        style={[s.input, { color: t.colors.textPrimary, borderColor: t.colors.borderDark, backgroundColor: t.colors.inputBg }]}
        onSubmitEditing={() => { onSubmit(text); onClose(); }}
        returnKeyType="done"
        testID="chart-text-input"
      />
    </Modal>
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Swatches + a hex field — a phone has no native colour input. */
export function ColorField({
  label,
  value,
  defaultValue,
  onChange,
  swatches = CHART_COLOR_SWATCHES,
}: {
  label: string;
  value: string;
  defaultValue?: string;
  onChange: (hex: string) => void;
  swatches?: readonly string[];
}): React.JSX.Element {
  const t = useTheme();
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const canReset = defaultValue != null && value.toLowerCase() !== defaultValue.toLowerCase();
  return (
    <View style={s.colorBlock}>
      <View style={s.colorHead}>
        <AppText variant="small" style={s.flex1}>{label}</AppText>
        {canReset ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`Reset ${label} to default`} onPress={() => onChange(defaultValue)} hitSlop={8}>
            <AppText variant="caption" tone="brand" weight="600">Reset</AppText>
          </Pressable>
        ) : null}
        <View style={[s.swatchNow, { backgroundColor: value, borderColor: t.colors.borderDark }]} />
        <TextInput
          value={draft}
          onChangeText={(v) => { setDraft(v); if (HEX.test(v)) onChange(v); }}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={7}
          style={[s.hex, { color: t.colors.textPrimary, borderColor: t.colors.borderDark, backgroundColor: t.colors.inputBg }]}
          accessibilityLabel={`${label} hex colour`}
        />
      </View>
      <View style={s.swatches}>
        {swatches.map((c) => (
          <Pressable
            key={c}
            accessibilityRole="button"
            accessibilityLabel={`Colour ${c}`}
            onPress={() => onChange(c)}
            style={[s.swatch, { backgroundColor: c, borderColor: value.toLowerCase() === c.toLowerCase() ? t.colors.primary : t.colors.borderSubtle }]}
          />
        ))}
      </View>
    </View>
  );
}

export const SCALE_MODE_OPTIONS = SCALE_MODES;

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 13 },
  rowLeft: { width: 18, alignItems: 'center' },
  rowLabel: { flex: 1 },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 12, marginVertical: 4 },
  lock: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  colorBlock: { gap: 8 },
  colorHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex1: { flex: 1 },
  swatchNow: { width: 22, height: 22, borderRadius: 6, borderWidth: 1 },
  hex: { width: 86, borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, fontSize: 13, fontVariant: ['tabular-nums'] },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  swatch: { width: 28, height: 28, borderRadius: 8, borderWidth: 2 },
});
