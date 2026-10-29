import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AppText, Button, Modal, Toggle } from '@/components/ui';
import { alpha, useTheme } from '@/theme';

import { DEFAULT_CHART_PREFS, SCALE_MODES, type ChartPrefs } from '../chartCatalog';
import { ColorField } from './ChartSheets';

/**
 * Chart settings — client/src/components/ChartSettings.jsx: Symbol · Status
 * line · Scales and lines · Canvas, applied live, Cancel reverts to the
 * snapshot taken on open, Ok keeps, Reset to defaults. The tab rail becomes
 * a row of tabs above the content on a phone.
 */

type Tab = 'symbol' | 'status' | 'scales' | 'canvas';
const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'symbol', label: 'Symbol' },
  { id: 'status', label: 'Status line' },
  { id: 'scales', label: 'Scales and lines' },
  { id: 'canvas', label: 'Canvas' },
];

export function ChartSettingsSheet({
  open,
  prefs,
  onChange,
  onReplace,
  onClose,
}: {
  open: boolean;
  prefs: ChartPrefs;
  onChange: (patch: Partial<ChartPrefs>) => void;
  onReplace: (next: ChartPrefs) => void;
  onClose: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const [tab, setTab] = useState<Tab>('scales');
  const snapshot = useRef(prefs);
  useEffect(() => { if (open) snapshot.current = prefs; }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = (): void => { onReplace(snapshot.current); onClose(); };

  return (
    <Modal
      open={open}
      onClose={cancel}
      title="Settings"
      presentation="sheet"
      handle
      bodyPadding={0}
      scrollable={false}
      testID="chart-settings"
      footer={(
        <View style={s.footer}>
          <Button title="Reset to defaults" variant="ghost" size="sm" onPress={() => onReplace({ ...DEFAULT_CHART_PREFS })} />
          <View style={s.footerRight}>
            <Button title="Cancel" variant="secondary" size="sm" onPress={cancel} />
            <Button title="Ok" size="sm" onPress={onClose} testID="chart-settings-ok" />
          </View>
        </View>
      )}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[s.tabs, { borderBottomColor: t.colors.borderSubtle }]}>
        {TABS.map((tb) => (
          <Pressable
            key={tb.id}
            onPress={() => setTab(tb.id)}
            style={[s.tab, tab === tb.id && { borderBottomColor: t.colors.primary }]}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === tb.id }}
          >
            <AppText variant="smallStrong" color={tab === tb.id ? t.colors.textPrimary : t.colors.textMuted}>{tb.label}</AppText>
          </Pressable>
        ))}
      </ScrollView>
      <ScrollView style={s.body} contentContainerStyle={s.bodyContent}>
        {tab === 'symbol' ? (
          <>
            <SettingsSection title="Candles">
              <ColorField label="Body / wick up" value={prefs.upColor} defaultValue={DEFAULT_CHART_PREFS.upColor} onChange={(v) => onChange({ upColor: v })} />
              <ColorField label="Body / wick down" value={prefs.downColor} defaultValue={DEFAULT_CHART_PREFS.downColor} onChange={(v) => onChange({ downColor: v })} />
              <PrefSwitch prefs={prefs} onChange={onChange} label="Last value label" k="lastValueVisible" />
            </SettingsSection>
            <SettingsSection title="Order lines (entry / TP / SL)">
              <ColorField label="Buy (entry)" value={prefs.buyColor} defaultValue={DEFAULT_CHART_PREFS.buyColor} onChange={(v) => onChange({ buyColor: v })} />
              <ColorField label="Sell (entry)" value={prefs.sellColor} defaultValue={DEFAULT_CHART_PREFS.sellColor} onChange={(v) => onChange({ sellColor: v })} />
              <ColorField label="Take Profit" value={prefs.tpColor} defaultValue={DEFAULT_CHART_PREFS.tpColor} onChange={(v) => onChange({ tpColor: v })} />
              <ColorField label="Stop Loss" value={prefs.slColor} defaultValue={DEFAULT_CHART_PREFS.slColor} onChange={(v) => onChange({ slColor: v })} />
            </SettingsSection>
          </>
        ) : null}
        {tab === 'status' ? (
          <SettingsSection title="Status line">
            <PrefSwitch prefs={prefs} onChange={onChange} label="Countdown to bar close" k="countdown" />
            <PrefSwitch prefs={prefs} onChange={onChange} label="Last value label" k="lastValueVisible" />
          </SettingsSection>
        ) : null}
        {tab === 'scales' ? (
          <>
            <SettingsSection title="Price scale">
              <AppText variant="body">Scale mode</AppText>
              <ChoiceChips value={prefs.scaleMode} options={SCALE_MODES} onPick={(v) => onChange({ scaleMode: v })} />
              <PrefSwitch prefs={prefs} onChange={onChange} label="Invert scale" k="invert" />
              <PrefSwitch prefs={prefs} onChange={onChange} label="Auto (fit data to screen)" k="autoScale" />
            </SettingsSection>
            <SettingsSection title="Price labels & lines">
              <PrefSwitch prefs={prefs} onChange={onChange} label="No overlapping labels" k="alignLabels" />
            </SettingsSection>
            <SettingsSection title="Time scale">
              <PrefSwitch prefs={prefs} onChange={onChange} label="Day of week on labels" k="dayOfWeek" />
              <SettingsRow label="Time hours format">
                <ChoiceChips value={prefs.hours24 ? '24' : '12'} options={[{ value: '24', label: '24-hours' }, { value: '12', label: '12-hours' }]} onPick={(v) => onChange({ hours24: v === '24' })} />
              </SettingsRow>
              <PrefSwitch prefs={prefs} onChange={onChange} label="Seconds on labels" k="secondsVisible" />
            </SettingsSection>
          </>
        ) : null}
        {tab === 'canvas' ? (
          <SettingsSection title="Canvas">
            <PrefSwitch prefs={prefs} onChange={onChange} label="Grid lines" k="gridLines" />
            <PrefSwitch prefs={prefs} onChange={onChange} label="Candle diagnostics overlay" k="diagnostics" />
          </SettingsSection>
        ) : null}
      </ScrollView>
    </Modal>
  );
}

function SettingsRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={s.row}>
      <AppText variant="body" style={s.flex1}>{label}</AppText>
      {children}
    </View>
  );
}

function PrefSwitch({ label, k, prefs, onChange }: { label: string; k: keyof ChartPrefs; prefs: ChartPrefs; onChange: (patch: Partial<ChartPrefs>) => void }): React.JSX.Element {
  return (
    <SettingsRow label={label}>
      <Toggle value={!!prefs[k]} onValueChange={(v) => onChange({ [k]: v } as Partial<ChartPrefs>)} accessibilityLabel={label} />
    </SettingsRow>
  );
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={s.section}>
      <AppText variant="micro" weight="700" tone="muted" style={s.sectionTitle}>{title.toUpperCase()}</AppText>
      <View style={s.sectionBody}>{children}</View>
    </View>
  );
}

function ChoiceChips<V extends string>({ value, options, onPick }: { value: V; options: readonly { value: V; label: string }[]; onPick: (v: V) => void }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={s.choices}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          onPress={() => onPick(o.value)}
          style={[s.choice, { borderColor: value === o.value ? t.colors.primary : t.colors.borderDark, backgroundColor: value === o.value ? alpha(t.colors.primary, 0.1) : 'transparent' }]}
        >
          <AppText variant="caption" weight="600" color={value === o.value ? t.colors.primaryText : t.colors.textSecondary}>{o.label}</AppText>
        </Pressable>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  tabs: { flexDirection: 'row', paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { paddingHorizontal: 12, paddingVertical: 11, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  body: { maxHeight: 460 },
  bodyContent: { padding: 18, gap: 4 },
  section: { marginBottom: 18 },
  sectionTitle: { letterSpacing: 0.8, marginBottom: 10 },
  sectionBody: { gap: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  flex1: { flex: 1 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  choice: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  footerRight: { flexDirection: 'row', gap: 8 },
});
