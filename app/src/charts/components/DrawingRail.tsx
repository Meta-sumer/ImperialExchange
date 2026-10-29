import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { AppText, BottomSheet, toast, type ConfirmFn } from '@/components/ui';
import { alpha, useTheme } from '@/theme';

import {
  CURSORS,
  CURSOR_TOOLS,
  EMOJI_PALETTE,
  GROUPS,
  RAIL,
  RAIL_LABEL,
  TOOL_META,
  TOOL_RAIL,
  engineMeta,
  initialRailLast,
  railGroups,
  type RailButton,
} from '../chartTools';
import type { DrawState } from '../protocol';
import { FamilyIcon, ToolIcon, type ToolIconName } from './chartGlyphs';

/**
 * The drawing toolbar — client/src/components/ChartDrawingToolbar.jsx: a
 * left rail of category buttons, each opening its grouped, searchable list
 * (a sheet here, a flyout there); the rail remembers the last tool per
 * category; cursors and stickers have their own lists; measure, magnet,
 * eraser, zoom, undo / redo, lock, hide and remove-all sit below. Collapses
 * to a tab, and the choice is remembered (chartPersistence).
 *
 * On a phone the web's hidden-on-mobile rail is shown (`hidden md:flex`
 * there): the drawing engine works with a finger, and a tool nobody can
 * pick is a tool that does not exist. Three touch-only buttons appear when
 * they are needed: Finish (free polyline), Cancel (a half-placed drawing)
 * and Edit (the selected object).
 */

export interface DrawingRailProps {
  state: DrawState | null;
  collapsed: boolean;
  onCollapse: (v: boolean) => void;
  send: (cmd: string, arg?: Record<string, unknown>) => void;
  onEditSelected: () => void;
  confirm: ConfirmFn;
}

const RAIL_W = 40;
export const DRAWING_RAIL_WIDTH = RAIL_W;

export function DrawingRail({ state, collapsed, onCollapse, send, onEditSelected, confirm }: DrawingRailProps): React.JSX.Element {
  const t = useTheme();
  const [openRail, setOpenRail] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [railLast, setRailLast] = useState<Record<string, string>>(initialRailLast);
  const [cursorLast, setCursorLast] = useState('crosshair');

  const tool = state?.tool ?? 'crosshair';
  const locked = !!state?.locked;
  const hidden = !!state?.hidden;
  const emoji = state?.emoji ?? '🚀';

  const pickTool = (next: string): void => {
    if (locked) { toast.error('Drawings are locked'); return; }
    send('setTool', { tool: next, meta: engineMeta(next) });
    const rid = TOOL_RAIL[next];
    if (rid) setRailLast((m) => ({ ...m, [rid]: next }));
    setOpenRail(null);
    setSearch('');
  };

  const onRail = (r: RailButton): void => {
    if (locked) { toast.error('Drawings are locked'); return; }
    if (r.cursors) send('setTool', { tool: cursorLast, meta: null });
    else if (r.emoji) send('setTool', { tool: 'emoji', meta: engineMeta('emoji') });
    else {
      const last = railLast[r.id];
      if (last) send('setTool', { tool: last, meta: engineMeta(last) });
    }
    setOpenRail(r.id);
    setSearch('');
  };

  const railActive = (r: RailButton): boolean => {
    if (r.cursors) return CURSOR_TOOLS.has(tool);
    if (r.emoji) return tool === 'emoji';
    return (r.groups ?? []).some((gn) => GROUPS.find((g) => g.name === gn)?.items.some((it) => it.tool === tool));
  };

  const railIcon = (r: RailButton, color: string): React.ReactNode => {
    if (r.cursors) return <ToolIcon name="crosshair" color={color} />;
    if (r.emoji) return <AppText style={s.emojiIcon}>{emoji}</AppText>;
    const last = railLast[r.id];
    const fam = last ? TOOL_META[last]?.family : r.repIcon;
    return <FamilyIcon family={fam || r.repIcon} color={color} />;
  };

  const activeMeta = TOOL_META[tool];
  const freePending = (state?.pending ?? 0) >= 2 && activeMeta?.pts === 'free' && activeMeta.family === 'poly';
  const halfPlaced = (state?.pending ?? 0) > 0 && !freePending;

  if (collapsed) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Show drawing tools"
        onPress={() => onCollapse(false)}
        style={[s.tab, { backgroundColor: t.colors.primary }]}
        testID="draw-rail-show"
      >
        <ToolIcon name="chevronRight" color={t.colors.onPrimary} size={12} />
      </Pressable>
    );
  }

  const ic = (name: ToolIconName, active?: boolean, disabled?: boolean): React.ReactNode => (
    <ToolIcon name={name} color={disabled ? alpha(t.colors.textMuted, 0.4) : active ? t.colors.primaryText : t.colors.textSecondary} />
  );

  const open = RAIL.find((r) => r.id === openRail) ?? null;

  return (
    <View style={[s.rail, { backgroundColor: alpha(t.colors.surface, 0.94), borderColor: t.colors.borderDark }]} testID="draw-rail">
      <ScrollView contentContainerStyle={s.railInner} showsVerticalScrollIndicator={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Hide drawing tools"
          onPress={() => onCollapse(true)}
          style={[s.hide, { backgroundColor: t.colors.primary }]}
        >
          <ToolIcon name="chevronLeft" color={t.colors.onPrimary} size={13} />
        </Pressable>
        <View style={[s.divider, { backgroundColor: t.colors.borderDark }]} />

        {RAIL.map((r) => {
          const on = railActive(r);
          return (
            <RailBtn key={r.id} label={RAIL_LABEL[r.id] ?? r.id} active={on} onPress={() => onRail(r)} icon={railIcon(r, on ? t.colors.primaryText : t.colors.textSecondary)} testID={`draw-rail-${r.id}`} />
          );
        })}

        {freePending ? (
          <Pressable accessibilityRole="button" onPress={() => send('finalize')} style={[s.textBtn, { backgroundColor: t.colors.primary }]} testID="draw-finish">
            <AppText variant="micro" weight="700" color={t.colors.onPrimary}>Finish</AppText>
          </Pressable>
        ) : null}
        {halfPlaced || freePending ? (
          <Pressable accessibilityRole="button" onPress={() => send('cancelPending')} style={[s.textBtn, { borderColor: t.colors.borderDark, borderWidth: 1 }]} testID="draw-cancel">
            <AppText variant="micro" weight="700" tone="muted">Cancel</AppText>
          </Pressable>
        ) : null}
        {state?.selectedId ? (
          <RailBtn label="Edit selected drawing" onPress={onEditSelected} icon={ic('pencil', true)} active testID="draw-edit" />
        ) : null}

        <View style={[s.divider, { backgroundColor: t.colors.borderDark }]} />
        <RailBtn label="Measure — Price Range" active={tool === 'pricerange'} onPress={() => pickTool(tool === 'pricerange' ? 'crosshair' : 'pricerange')} icon={ic('ruler', tool === 'pricerange')} />
        <RailBtn label="Magnet snap" active={tool === 'magnet'} onPress={() => (tool === 'magnet' ? pickTool('crosshair') : (locked ? toast.error('Drawings are locked') : send('setTool', { tool: 'magnet', meta: null })))} icon={ic('magnet', tool === 'magnet')} />
        <RailBtn label="Eraser — tap drawings to delete" active={tool === 'eraser'} onPress={() => (tool === 'eraser' ? pickTool('crosshair') : (locked ? toast.error('Drawings are locked') : send('setTool', { tool: 'eraser', meta: null })))} icon={ic('eraser', tool === 'eraser')} />
        <RailBtn label="Zoom in" onPress={() => send('zoomIn')} icon={ic('zoomIn')} />
        <RailBtn label="Zoom out" onPress={() => send('zoomOut')} icon={ic('zoomOut')} />
        <RailBtn label="Reset / fit chart" onPress={() => send('resetZoom')} icon={ic('zoomReset')} />

        <View style={[s.divider, { backgroundColor: t.colors.borderDark }]} />
        <RailBtn label="Undo" disabled={!state?.canUndo} onPress={() => send('undo')} icon={ic('undo', false, !state?.canUndo)} testID="draw-undo" />
        <RailBtn label="Redo" disabled={!state?.canRedo} onPress={() => send('redo')} icon={ic('redo', false, !state?.canRedo)} testID="draw-redo" />

        <View style={[s.divider, { backgroundColor: t.colors.borderDark }]} />
        <RailBtn label={locked ? 'Drawings locked — tap to unlock' : 'Lock all drawings'} active={locked} onPress={() => send('setLocked', { value: !locked })} icon={ic(locked ? 'locked' : 'unlocked', locked)} />
        <RailBtn label={hidden ? 'Drawings hidden — tap to show' : 'Hide drawings'} active={hidden} onPress={() => send('setHidden', { value: !hidden })} icon={ic(hidden ? 'eyeOff' : 'eye', hidden)} />
        <RailBtn
          label={`Remove all (${state?.count ?? 0})`}
          onPress={async () => {
            const n = state?.count ?? 0;
            if (n === 0 || await confirm({ title: 'Remove drawings', message: `Remove all ${n} drawing(s)?`, confirmText: 'Remove all', danger: true })) send('clearAll');
          }}
          icon={ic('trash')}
          testID="draw-clear"
        />
      </ScrollView>

      <BottomSheet
        open={!!open}
        onClose={() => { setOpenRail(null); setSearch(''); }}
        title={open ? RAIL_LABEL[open.id] : undefined}
        bodyPadding={0}
        testID="draw-flyout"
      >
        {open?.cursors ? (
          <View>
            {CURSORS.map((c) => (
              <FlyoutRow
                key={c.tool}
                label={c.label}
                active={tool === c.tool}
                icon={<ToolIcon name={c.tool as ToolIconName} color={tool === c.tool ? t.colors.primaryText : t.colors.textSecondary} />}
                onPress={() => { if (c.tool !== 'eraser') setCursorLast(c.tool); pickTool(c.tool); }}
              />
            ))}
          </View>
        ) : open?.emoji ? (
          <View style={s.emojiWrap}>
            <View style={s.emojiGrid}>
              {EMOJI_PALETTE.map((em) => (
                <Pressable
                  key={em}
                  accessibilityRole="button"
                  accessibilityLabel={`Use ${em}`}
                  onPress={() => { send('setEmoji', { emoji: em }); pickTool('emoji'); }}
                  style={[s.emojiCell, emoji === em && { backgroundColor: alpha(t.colors.primary, 0.15) }]}
                >
                  <AppText style={s.emojiBig}>{em}</AppText>
                </Pressable>
              ))}
            </View>
            <AppText variant="caption" tone="muted" align="center">Tap the chart to place</AppText>
          </View>
        ) : open ? (
          <GroupList railId={open.id} tool={tool} search={search} setSearch={setSearch} onPick={pickTool} />
        ) : null}
      </BottomSheet>
    </View>
  );
}

function RailBtn({ icon, label, active, onPress, disabled, testID }: { icon: React.ReactNode; label: string; active?: boolean; onPress: () => void; disabled?: boolean; testID?: string }): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[s.btn, active && { backgroundColor: alpha(t.colors.primary, 0.15), borderColor: alpha(t.colors.primary, 0.3) }]}
      testID={testID}
    >
      {icon}
    </Pressable>
  );
}

function FlyoutRow({ label, active, icon, hotkey, onPress }: { label: string; active: boolean; icon: React.ReactNode; hotkey?: string; onPress: () => void }): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [s.flyRow, { backgroundColor: active ? alpha(t.colors.primary, 0.12) : pressed ? t.colors.bgHover : 'transparent' }]}
    >
      <View style={s.flyIcon}>{icon}</View>
      <AppText variant="body" style={s.flex1} color={active ? t.colors.primaryText : t.colors.textPrimary} numberOfLines={1}>{label}</AppText>
      {hotkey ? <AppText variant="micro" tone="muted">{hotkey}</AppText> : null}
    </Pressable>
  );
}

function GroupList({ railId, tool, search, setSearch, onPick }: { railId: string; tool: string; search: string; setSearch: (v: string) => void; onPick: (tool: string) => void }): React.JSX.Element {
  const t = useTheme();
  const groups = useMemo(() => railGroups(railId, search), [railId, search]);
  return (
    <View>
      <View style={[s.searchWrap, { borderBottomColor: t.colors.borderSubtle }]}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search drawing tools…"
          placeholderTextColor={t.colors.textMuted}
          autoCorrect={false}
          style={[s.search, { color: t.colors.textPrimary, borderColor: t.colors.borderDark, backgroundColor: t.colors.inputBg }]}
        />
      </View>
      {groups.map((g) => (
        <View key={g.name}>
          <View style={[s.groupHead, { backgroundColor: t.colors.bgCard }]}>
            <AppText variant="micro" weight="700" tone="muted">{g.name.toUpperCase()}</AppText>
          </View>
          {g.items.map((it) => (
            <FlyoutRow
              key={it.tool}
              label={it.label}
              active={tool === it.tool}
              icon={<FamilyIcon family={it.family} color={tool === it.tool ? t.colors.primaryText : t.colors.textSecondary} size={15} />}
              onPress={() => onPick(it.tool)}
            />
          ))}
        </View>
      ))}
      {groups.length === 0 ? <AppText variant="small" tone="muted" align="center" style={s.none}>No tools match “{search}”.</AppText> : null}
    </View>
  );
}

const s = StyleSheet.create({
  rail: { position: 'absolute', left: 0, top: 0, bottom: 0, width: RAIL_W, borderRightWidth: 1, zIndex: 20 },
  railInner: { alignItems: 'center', paddingVertical: 4, gap: 3 },
  tab: { position: 'absolute', left: 0, top: 6, width: 16, height: 30, borderTopRightRadius: 6, borderBottomRightRadius: 6, alignItems: 'center', justifyContent: 'center', zIndex: 20 },
  hide: { width: 30, height: 26, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  divider: { width: 20, height: StyleSheet.hairlineWidth, marginVertical: 3 },
  btn: { width: 32, height: 32, borderRadius: 7, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'transparent' },
  textBtn: { width: 34, paddingVertical: 5, borderRadius: 6, alignItems: 'center' },
  emojiIcon: { fontSize: 15, lineHeight: 18 },
  flyRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 11 },
  flyIcon: { width: 18, alignItems: 'center' },
  flex1: { flex: 1 },
  searchWrap: { padding: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  search: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14 },
  groupHead: { paddingHorizontal: 16, paddingVertical: 6 },
  none: { paddingVertical: 18 },
  emojiWrap: { padding: 14, gap: 10 },
  emojiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center' },
  emojiCell: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  emojiBig: { fontSize: 24, lineHeight: 30 },
});
