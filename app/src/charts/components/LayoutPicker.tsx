import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText, BottomSheet, Toggle } from '@/components/ui';
import { alpha, useTheme } from '@/theme';

import { LAYOUT_GROUPS, SYNC_FIELDS, cellFrame, getLayout, type ChartLayout, type SyncKey, type SyncState } from '../chartLayouts';

/**
 * The chart-layout picker — client/src/components/ChartLayoutPicker.jsx: a
 * toolbar button showing the current layout, opening the templates grouped
 * 1–8 and the SYNC IN LAYOUT toggles.
 */

export function LayoutIcon({ layout, size = 22, color }: { layout: ChartLayout; size?: number; color: string }): React.JSX.Element {
  const w = size;
  const h = Math.round(size * 0.78);
  return (
    <View style={{ width: w, height: h }}>
      {layout.cells.map((c, i) => {
        const f = cellFrame(layout, c);
        return (
          <View
            key={i}
            style={{
              position: 'absolute',
              left: `${f.left}%`,
              top: `${f.top}%`,
              width: `${f.width}%`,
              height: `${f.height}%`,
              padding: 0.75,
            }}
          >
            <View style={[s.cell, { borderColor: color }]} />
          </View>
        );
      })}
    </View>
  );
}

export function LayoutPickerButton({
  value,
  onChange,
  sync,
  onSyncChange,
}: {
  value: string;
  onChange: (id: string) => void;
  sync: SyncState;
  onSyncChange: (key: SyncKey, v: boolean) => void;
}): React.JSX.Element {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const active = getLayout(value);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Select chart layout"
        onPress={() => setOpen(true)}
        style={[s.btn, { borderColor: open ? t.colors.primary : t.colors.borderDark, backgroundColor: open ? alpha(t.colors.primary, 0.1) : t.colors.surface }]}
        testID="layout-picker"
      >
        <LayoutIcon layout={active} size={16} color={open ? t.colors.primaryText : t.colors.textSecondary} />
      </Pressable>
      <BottomSheet open={open} onClose={() => setOpen(false)} title="Layout" testID="layout-sheet">
        <View style={s.groups}>
          {LAYOUT_GROUPS.map((g) => (
            <View key={g.n} style={[s.group, { borderBottomColor: t.colors.borderSubtle }]}>
              <AppText variant="smallStrong" tone="muted" style={s.n}>{g.n}</AppText>
              <View style={s.items}>
                {g.items.map((l) => {
                  const on = value === l.id;
                  return (
                    <Pressable
                      key={l.id}
                      accessibilityRole="button"
                      accessibilityLabel={`${l.n} chart${l.n > 1 ? 's' : ''}`}
                      accessibilityState={{ selected: on }}
                      onPress={() => { onChange(l.id); setOpen(false); }}
                      style={[s.item, { borderColor: on ? t.colors.primary : t.colors.borderDark, backgroundColor: on ? alpha(t.colors.primary, 0.1) : 'transparent' }]}
                      testID={`layout-${l.id}`}
                    >
                      <LayoutIcon layout={l} size={24} color={on ? t.colors.primaryText : t.colors.textSecondary} />
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))}
        </View>
        <AppText variant="micro" weight="700" tone="muted" style={s.syncHead}>SYNC IN LAYOUT</AppText>
        {SYNC_FIELDS.map((f) => (
          <View key={f.key} style={s.syncRow}>
            <View style={s.flex1}>
              <AppText variant="smallStrong">{f.label}</AppText>
              <AppText variant="caption" tone="muted">{f.info}</AppText>
            </View>
            <Toggle value={!!sync[f.key]} onValueChange={(v) => onSyncChange(f.key, v)} accessibilityLabel={f.label} />
          </View>
        ))}
      </BottomSheet>
    </>
  );
}

const s = StyleSheet.create({
  btn: { width: 32, height: 32, borderRadius: 6, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  cell: { flex: 1, borderWidth: 1.3, borderRadius: 2 },
  groups: { gap: 2 },
  group: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  n: { width: 16 },
  items: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, flex: 1 },
  item: { width: 44, height: 36, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  syncHead: { marginTop: 16, marginBottom: 6, letterSpacing: 0.8 },
  syncRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  flex1: { flex: 1 },
});
