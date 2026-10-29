import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { AppText, Checkbox, Select, Toggle } from '@/components/ui';
import { useConfirm } from '@/components/ui';
import { useTradeSettings, type SettingPath, type SettingValue } from '@/store/tradeSettings';
import { useTheme } from '@/theme';

/**
 * The inline Trade Settings side panel (settings/TradeSettingsPanel.jsx) —
 * every section, the search, and Reset all.
 */

/* ── Trade settings (settings/TradeSettingsPanel.jsx) ── */

const SECTION_INDEX = [
  { id: 'chart', title: 'Show on Chart', labels: ['Signals', 'HMR periods', 'Price alerts', 'Open positions', 'TP / SL on positions', 'Pending orders', 'Economic calendar'] },
  { id: 'calendar', title: 'Economic Calendar Filters', labels: ['High impact', 'Medium impact', 'Low impact', 'Lowest impact'] },
  { id: 'sound', title: 'Sound Effects', labels: ['Price alerts sound', 'TP / SL / SO closing sound'] },
  { id: 'trading', title: 'Trading Settings', labels: ['Open order mode', 'Regular form', 'One-click form', 'Risk calculator', 'Price source', 'Bid', 'Ask', 'Mid Price', 'Appearance', 'Light', 'Dark', 'System', 'Time zone', 'UTC', 'GMT', 'Local Time'] },
  { id: 'auto', title: 'Auto Trading Preferences', labels: ['Set TP/SL automatically', 'Confirm before order', 'Enable one-click trading', 'Auto save chart layout'] },
] as const;

/** Which sections a search leaves on screen; null = all. Exported for tests. */
export const settingsHits = (query: string): Set<string> | null => {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const hit = new Set<string>();
  for (const sec of SECTION_INDEX) {
    if (sec.title.toLowerCase().includes(q) || sec.labels.some((l) => l.toLowerCase().includes(q))) hit.add(sec.id);
  }
  return hit;
};

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[s.section, { borderColor: t.colors.borderSubtle }]}>
      <View style={[s.sectionHead, { backgroundColor: t.colors.bgCard, borderBottomColor: t.colors.borderSubtle }]}>
        <AppText variant="micro" weight="700" tone="secondary" style={s.caps}>{title.toUpperCase()}</AppText>
      </View>
      <View style={s.sectionBody}>{children}</View>
    </View>
  );
}

function SwitchRow<P extends SettingPath>({ label, path, value, also }: { label: string; path: P; value: boolean; also?: SettingPath }): React.JSX.Element {
  const set = useTradeSettings((st) => st.set);
  return (
    <View style={s.row}>
      <AppText variant="small" style={s.flex1}>{label}</AppText>
      <Toggle
        value={value}
        accessibilityLabel={label}
        onValueChange={(v) => {
          set(path, v as SettingValue<P>);
          if (also) set(also, v as never);
        }}
      />
    </View>
  );
}

export function TradeSettingsPanel(): React.JSX.Element {
  const t = useTheme();
  const confirm = useConfirm();
  const st = useTradeSettings();
  const [query, setQuery] = useState('');
  const hits = useMemo(() => settingsHits(query), [query]);
  const visible = (id: string): boolean => !hits || hits.has(id);
  const dd = <P extends SettingPath>(label: string, path: P, value: string, options: { value: string; label: string }[]): React.JSX.Element => (
    <View style={s.row}>
      <AppText variant="small" style={s.flex1}>{label}</AppText>
      <Select value={value} options={options} onChange={(v) => st.set(path, v as SettingValue<P>)} title={label} variant="compact" />
    </View>
  );

  return (
    <View style={s.pad} testID="panel-settings">
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search settings…"
        placeholderTextColor={t.colors.textMuted}
        autoCorrect={false}
        style={[s.search, { color: t.colors.textPrimary, borderColor: t.colors.borderDark, backgroundColor: t.colors.inputBg }]}
      />
      {visible('chart') ? (
        <Section title="Show on Chart">
          <SwitchRow label="Signals" path="showOnChart.signals" value={st.showOnChart.signals} />
          <SwitchRow label="HMR periods" path="showOnChart.hmr" value={st.showOnChart.hmr} />
          <SwitchRow label="Price alerts" path="showOnChart.alerts" value={st.showOnChart.alerts} />
          <SwitchRow label="Open positions" path="showOnChart.positions" value={st.showOnChart.positions} />
          <SwitchRow label="TP / SL on positions" path="showOnChart.tpsl" value={st.showOnChart.tpsl} />
          {/* Pending orders and Order preview are linked, as on the web. */}
          <SwitchRow label="Pending orders" path="showOnChart.stopLimit" value={st.showOnChart.stopLimit} also="showOnChart.orderPreview" />
          <SwitchRow label="Order preview (Entry / TP / SL)" path="showOnChart.orderPreview" value={st.showOnChart.orderPreview} also="showOnChart.stopLimit" />
          <SwitchRow label="Economic calendar" path="showOnChart.calendar" value={st.showOnChart.calendar} />
        </Section>
      ) : null}
      {visible('calendar') ? (
        <Section title="Economic Calendar Filters">
          <View style={s.checks}>
            <Checkbox label="High impact" value={st.calendarFilters.high} onValueChange={(v) => st.set('calendarFilters.high', v)} />
            <Checkbox label="Medium impact" value={st.calendarFilters.medium} onValueChange={(v) => st.set('calendarFilters.medium', v)} />
            <Checkbox label="Low impact" value={st.calendarFilters.low} onValueChange={(v) => st.set('calendarFilters.low', v)} />
            <Checkbox label="Lowest impact" value={st.calendarFilters.lowest} onValueChange={(v) => st.set('calendarFilters.lowest', v)} />
          </View>
        </Section>
      ) : null}
      {visible('sound') ? (
        <Section title="Sound Effects">
          <SwitchRow label="Price alerts sound" path="sounds.alerts" value={st.sounds.alerts} />
          <SwitchRow label="TP / SL / SO closing sound" path="sounds.tpsl" value={st.sounds.tpsl} />
        </Section>
      ) : null}
      {visible('trading') ? (
        <Section title="Trading Settings">
          {dd('Open order mode', 'trading.openOrderMode', st.trading.openOrderMode, [
            { value: 'regular', label: 'Regular form' }, { value: 'oneClick', label: 'One-click form' }, { value: 'riskCalc', label: 'Risk calculator' },
          ])}
          {dd('Price source', 'trading.priceSource', st.trading.priceSource, [
            { value: 'bid', label: 'Bid' }, { value: 'ask', label: 'Ask' }, { value: 'mid', label: 'Mid Price' },
          ])}
          {dd('Appearance', 'trading.appearance', st.trading.appearance, [
            { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' },
          ])}
          {dd('Time zone', 'trading.timeZone', st.trading.timeZone, [
            { value: 'utc', label: 'UTC' }, { value: 'gmt', label: 'GMT' }, { value: 'local', label: 'Local Time' },
          ])}
        </Section>
      ) : null}
      {visible('auto') ? (
        <Section title="Auto Trading Preferences">
          <SwitchRow label="Set TP/SL automatically" path="autoTrading.autoTpSl" value={st.autoTrading.autoTpSl} />
          <SwitchRow label="Confirm before order" path="autoTrading.confirmOrder" value={st.autoTrading.confirmOrder} />
          <SwitchRow label="Enable one-click trading" path="autoTrading.oneClick" value={st.autoTrading.oneClick} />
          <SwitchRow label="Auto save chart layout" path="autoTrading.autoSaveLayout" value={st.autoTrading.autoSaveLayout} />
        </Section>
      ) : null}
      {hits && hits.size === 0 ? (
        <View style={s.none}>
          <AppText variant="caption" tone="muted">No settings match "{query}"</AppText>
          <Pressable onPress={() => setQuery('')}><AppText variant="caption" weight="700" tone="brand">Clear search</AppText></Pressable>
        </View>
      ) : null}
      <View style={[s.footer, { borderTopColor: t.colors.borderSubtle }]}>
        <Pressable
          accessibilityRole="button"
          onPress={async () => { if (await confirm({ title: 'Reset settings', message: 'Reset all trading settings to defaults?', confirmText: 'Reset', danger: true })) st.reset(); }}
          style={[s.reset, { borderColor: t.colors.borderDark }]}
        >
          <AppText variant="caption" weight="700" tone="secondary">↺ Reset all</AppText>
        </Pressable>
        <AppText variant="micro" tone="muted">Auto-saved</AppText>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  flex1: { flex: 1 },
  pad: { padding: 12, gap: 12 },
  caps: { letterSpacing: 1 },
  search: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, fontSize: 13 },
  section: { borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  sectionHead: { paddingHorizontal: 12, paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth },
  sectionBody: { paddingHorizontal: 12, paddingVertical: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 },
  checks: { gap: 10, paddingVertical: 6 },
  none: { alignItems: 'center', gap: 4, paddingVertical: 16 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10 },
  reset: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
});
