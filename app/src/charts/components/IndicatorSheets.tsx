import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { AppText, BottomSheet, Button, Modal } from '@/components/ui';
import { alpha, useTheme } from '@/theme';

import {
  CATEGORIES,
  INDICATORS,
  INDICATOR_LIST,
  LINE_STYLES,
  MA_TYPES,
  activeIndicatorKeys,
  applyIndicatorSettings,
  cfgOf,
  indicatorColor,
  labelForActive,
  parseMaKey,
  removeIndicator,
  sanitizeLength,
  type IndicatorMap,
  type IndicatorTarget,
} from '../chartCatalog';
import { ColorField } from './ChartSheets';
import { ToolIcon } from './chartGlyphs';

/**
 * The Indicators picker (client/src/components/IndicatorsPanel.jsx) and its
 * per-indicator settings (IndicatorSettingsModal.jsx), as sheets.
 *
 * `mode="panel"` is the full picker: search, the Active list with edit /
 * remove, collapsible categories, one row per MA type (the period is chosen
 * in settings). `mode="checklist"` is the multi-chart toolbar's flat toggle
 * list (MultiChartToolbar.jsx), every MA preset as its own row.
 */

export interface EditTarget {
  target: IndicatorTarget;
  cfg: { period?: number; length?: number; color?: string; lineWidth?: number; lineStyle?: number };
  isActive: boolean;
  key: string | null;
}

/** The settings target for an active key (legend tap, Active row). */
export const editTargetForKey = (indicators: IndicatorMap, key: string): EditTarget | null => {
  const ma = parseMaKey(key);
  if (ma) return { target: { type: 'ma', ma: ma.def }, cfg: { ...cfgOf(indicators, key), period: ma.period }, isActive: true, key };
  const ind = INDICATORS.find((i) => i.key === key);
  return ind ? { target: { type: 'ind', ind }, cfg: cfgOf(indicators, key), isActive: true, key } : null;
};

export function IndicatorsSheet({
  open,
  mode = 'panel',
  indicators,
  onChange,
  onEdit,
  onClose,
}: {
  open: boolean;
  mode?: 'panel' | 'checklist';
  indicators: IndicatorMap;
  onChange: (next: IndicatorMap) => void;
  onEdit: (target: EditTarget) => void;
  onClose: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  useEffect(() => { if (!open) setQ(''); }, [open]);

  const active = useMemo(() => activeIndicatorKeys(indicators), [indicators]);
  const query = q.trim().toLowerCase();

  const groups = useMemo(() => CATEGORIES.map((cat) => {
    const rows: { id: string; name: string; color: string; open: () => void; badge: string | null }[] = [];
    if (cat === 'Trend') {
      MA_TYPES.forEach((ma) => {
        const count = active.filter((k) => parseMaKey(k)?.code === ma.code).length;
        rows.push({
          id: ma.code, name: ma.name, color: ma.color, badge: count ? String(count) : null,
          open: () => onEdit({ target: { type: 'ma', ma }, cfg: {}, isActive: false, key: null }),
        });
      });
    }
    INDICATORS.filter((i) => i.cat === cat).forEach((ind) => {
      const on = !!indicators[ind.key];
      rows.push({
        id: ind.key, name: ind.name, color: ind.color, badge: on ? '✓' : null,
        open: () => onEdit({ target: { type: 'ind', ind }, cfg: cfgOf(indicators, ind.key), isActive: on, key: on ? ind.key : null }),
      });
    });
    return { cat, rows: query ? rows.filter((r) => r.name.toLowerCase().includes(query)) : rows };
  }).filter((g) => g.rows.length > 0), [active, indicators, onEdit, query]);

  const checklist = useMemo(
    () => (query ? INDICATOR_LIST.filter((i) => i.label.toLowerCase().includes(query)) : INDICATOR_LIST),
    [query],
  );

  const search = (
    <View style={[s.searchWrap, { borderBottomColor: t.colors.borderSubtle }]}>
      <TextInput
        value={q}
        onChangeText={setQ}
        placeholder="Search indicators…"
        placeholderTextColor={t.colors.textMuted}
        autoCorrect={false}
        style={[s.search, { color: t.colors.textPrimary, borderColor: t.colors.borderDark, backgroundColor: t.colors.inputBg }]}
        testID="indicator-search"
      />
    </View>
  );

  return (
    <BottomSheet open={open} onClose={onClose} title="Indicators" bodyPadding={0} testID="indicators-sheet">
      {search}
      {mode === 'checklist' ? (
        <View>
          {checklist.map((ind) => {
            const on = !!indicators[ind.key];
            return (
              <Pressable
                key={ind.key}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                onPress={() => onChange(on ? removeIndicator(indicators, ind.key) : { ...indicators, [ind.key]: true })}
                style={({ pressed }) => [s.checkRow, pressed && { backgroundColor: t.colors.bgHover }]}
                testID={`indicator-toggle-${ind.key}`}
              >
                <View style={[s.dot, { backgroundColor: ind.color }]} />
                <AppText variant="small" style={s.flex1} color={t.colors.textSecondary}>{ind.label}</AppText>
                <View style={[s.box, { borderColor: on ? t.colors.primary : t.colors.borderDark, backgroundColor: on ? t.colors.primary : 'transparent' }]}>
                  {on ? <ToolIcon name="check" color={t.colors.onPrimary} size={10} /> : null}
                </View>
              </Pressable>
            );
          })}
          {checklist.length === 0 ? <AppText variant="small" tone="muted" align="center" style={s.empty}>No match</AppText> : null}
        </View>
      ) : (
        <View>
          {active.length > 0 ? (
            <View style={[s.section, { borderBottomColor: t.colors.borderSubtle }]}>
              <AppText variant="micro" weight="700" tone="muted" style={s.sectionHead}>ACTIVE · {active.length}</AppText>
              {active.map((key) => (
                <View key={key} style={s.activeRow}>
                  <View style={[s.dot, { backgroundColor: indicatorColor(indicators, key) }]} />
                  <Pressable style={s.flex1} onPress={() => { const e = editTargetForKey(indicators, key); if (e) onEdit(e); }} accessibilityRole="button">
                    <AppText variant="small" numberOfLines={1}>{labelForActive(key, cfgOf(indicators, key))}</AppText>
                  </Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel="Settings" hitSlop={8} onPress={() => { const e = editTargetForKey(indicators, key); if (e) onEdit(e); }} style={s.iconBtn}>
                    <ToolIcon name="gear" color={t.colors.textMuted} size={15} />
                  </Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel="Remove" hitSlop={8} onPress={() => onChange(removeIndicator(indicators, key))} style={s.iconBtn} testID={`indicator-remove-${key}`}>
                    <AppText variant="bodyStrong" color={t.colors.bear}>✕</AppText>
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
          {groups.map(({ cat, rows }) => {
            const isCollapsed = !query && !!collapsed[cat];
            return (
              <View key={cat} style={[s.section, { borderBottomColor: t.colors.borderSubtle }]}>
                <Pressable
                  onPress={() => setCollapsed((c) => ({ ...c, [cat]: !c[cat] }))}
                  style={[s.catHead, { backgroundColor: t.colors.bgCard }]}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: !isCollapsed }}
                >
                  <AppText variant="micro" weight="700" tone="muted">{cat.toUpperCase()}</AppText>
                  <AppText variant="micro" tone="muted">{isCollapsed ? '▸' : '▾'}</AppText>
                </Pressable>
                {!isCollapsed && rows.map((r) => (
                  <Pressable
                    key={r.id}
                    onPress={r.open}
                    style={({ pressed }) => [s.catRow, pressed && { backgroundColor: t.colors.bgHover }]}
                    accessibilityRole="button"
                    testID={`indicator-row-${r.id}`}
                  >
                    <View style={[s.dot, { backgroundColor: r.color }]} />
                    <AppText variant="body" style={s.flex1} numberOfLines={1}>{r.name}</AppText>
                    {r.badge ? (
                      <View style={[s.badge, { backgroundColor: t.colors.primary }]}>
                        <AppText variant="micro" weight="700" color={t.colors.onPrimary}>{r.badge}</AppText>
                      </View>
                    ) : null}
                    <AppText variant="bodyStrong" tone="muted">+</AppText>
                  </Pressable>
                ))}
              </View>
            );
          })}
          {groups.length === 0 ? <AppText variant="small" tone="muted" align="center" style={s.empty}>No indicators match “{q}”.</AppText> : null}
        </View>
      )}
    </BottomSheet>
  );
}

export function IndicatorSettingsSheet({
  edit,
  indicators,
  onChange,
  onClose,
}: {
  edit: EditTarget | null;
  indicators: IndicatorMap;
  onChange: (next: IndicatorMap) => void;
  onClose: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const isMa = edit?.target.type === 'ma';
  const meta = isMa ? edit?.target.ma : edit?.target.ind;
  const defLength = isMa ? edit?.target.ma?.def : edit?.target.ind?.defLength;
  const hasLength = isMa || defLength != null;

  const [period, setPeriod] = useState('');
  const [color, setColor] = useState('#1D4ED8');
  const [lineWidth, setLineWidth] = useState(2);
  const [lineStyle, setLineStyle] = useState(0);

  useEffect(() => {
    if (!edit || !meta) return;
    const p = edit.cfg.period ?? edit.cfg.length ?? defLength;
    setPeriod(p != null ? String(p) : '');
    setColor(edit.cfg.color || meta.color);
    setLineWidth(edit.cfg.lineWidth || 2);
    setLineStyle(edit.cfg.lineStyle ?? 0);
  }, [edit, meta, defLength]);

  const apply = (): void => {
    if (!edit) return;
    const fallback = defLength ?? 14;
    const n = sanitizeLength(period, fallback);
    onChange(applyIndicatorSettings(indicators, edit.target, edit.key, {
      color,
      lineWidth,
      lineStyle,
      ...(isMa ? { period: n } : defLength != null ? { length: n } : {}),
    }));
    onClose();
  };

  return (
    <Modal
      open={!!edit}
      onClose={onClose}
      presentation="sheet"
      handle
      title={meta ? (
        <View style={s.titleRow}>
          <View style={[s.dotLg, { backgroundColor: color }]} />
          <AppText variant="title">{meta.name} settings</AppText>
        </View>
      ) : undefined}
      testID="indicator-settings"
      footer={(
        <View style={s.footer}>
          {edit?.isActive && edit.key ? (
            <Button title="Remove" variant="danger" size="sm" onPress={() => { if (edit.key) onChange(removeIndicator(indicators, edit.key)); onClose(); }} />
          ) : <View />}
          <View style={s.footerRight}>
            <Button title="Cancel" variant="secondary" size="sm" onPress={onClose} />
            <Button title={edit?.isActive ? 'Apply' : 'Add'} size="sm" onPress={apply} testID="indicator-apply" />
          </View>
        </View>
      )}
    >
      <View style={s.form}>
        {hasLength ? (
          <View style={s.formRow}>
            <AppText variant="body" style={s.flex1}>{isMa ? 'Period' : 'Length'}</AppText>
            <TextInput
              value={period}
              onChangeText={setPeriod}
              keyboardType="number-pad"
              maxLength={4}
              style={[s.num, { color: t.colors.textPrimary, borderColor: t.colors.borderDark, backgroundColor: t.colors.inputBg }]}
              testID="indicator-period"
            />
          </View>
        ) : null}
        {isMa && edit?.target.ma ? (
          <View style={s.presets}>
            {edit.target.ma.periods.map((p) => (
              <Pressable
                key={p}
                onPress={() => setPeriod(String(p))}
                style={[s.preset, { borderColor: period === String(p) ? t.colors.primary : t.colors.borderDark, backgroundColor: period === String(p) ? alpha(t.colors.primary, 0.1) : 'transparent' }]}
              >
                <AppText variant="caption" weight="600" color={period === String(p) ? t.colors.primaryText : t.colors.textSecondary}>{p}</AppText>
              </Pressable>
            ))}
          </View>
        ) : null}
        <ColorField label="Color" value={color} onChange={setColor} />
        <View style={s.formRow}>
          <AppText variant="body" style={s.flex1}>Line width</AppText>
          <View style={s.chips}>
            {[1, 2, 3, 4].map((w) => (
              <Pressable key={w} onPress={() => setLineWidth(w)} style={[s.chip, { borderColor: lineWidth === w ? t.colors.primary : t.colors.borderDark, backgroundColor: lineWidth === w ? t.colors.primary : 'transparent' }]}>
                <AppText variant="caption" weight="700" color={lineWidth === w ? t.colors.onPrimary : t.colors.textSecondary}>{w}px</AppText>
              </Pressable>
            ))}
          </View>
        </View>
        <View style={s.formRow}>
          <AppText variant="body" style={s.flex1}>Line style</AppText>
          <View style={s.chips}>
            {LINE_STYLES.map((ls) => (
              <Pressable key={ls.value} onPress={() => setLineStyle(ls.value)} style={[s.chip, { borderColor: lineStyle === ls.value ? t.colors.primary : t.colors.borderDark, backgroundColor: lineStyle === ls.value ? t.colors.primary : 'transparent' }]}>
                <AppText variant="caption" weight="700" color={lineStyle === ls.value ? t.colors.onPrimary : t.colors.textSecondary}>{ls.label}</AppText>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  searchWrap: { padding: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  search: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14 },
  section: { borderBottomWidth: StyleSheet.hairlineWidth },
  sectionHead: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4, letterSpacing: 0.6 },
  activeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8 },
  iconBtn: { paddingHorizontal: 6, paddingVertical: 4 },
  catHead: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 9 },
  catRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 11 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotLg: { width: 10, height: 10, borderRadius: 5 },
  badge: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999 },
  box: { width: 18, height: 18, borderRadius: 4, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  flex1: { flex: 1 },
  empty: { paddingVertical: 20 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  footerRight: { flexDirection: 'row', gap: 8 },
  form: { gap: 16 },
  formRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  num: { width: 90, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, fontSize: 14, textAlign: 'right' },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  preset: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  chips: { flexDirection: 'row', gap: 6 },
  chip: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 5 },
});
