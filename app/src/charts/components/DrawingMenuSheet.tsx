import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { AppText, BottomSheet, Toggle } from '@/components/ui';
import { alpha, useTheme } from '@/theme';

import {
  DRAWING_EMOJIS,
  DRAWING_PALETTE,
  DRAWING_STYLES,
  DRAWING_WIDTHS,
  HAS_FILL,
  HAS_STYLE,
  HAS_WIDTH,
  defaultFontSize,
  isTextDrawing,
  toolLabel,
  type ChartDrawing,
} from '../chartTools';

/**
 * One sheet for a drawing object: the web's right-click menu
 * (DrawingContextMenu.jsx — duplicate, lock, layer order, delete) and its
 * double-click property panel (DrawingProperties.jsx — colour, thickness,
 * style, fill, text, emoji, size, lock). A long-press opens it on the
 * actions, a double-tap / the rail's Edit on the properties; both are the
 * same sheet, so neither is a dead end.
 *
 * Every change goes through the engine's `update`, so it lands in undo /
 * redo and in the saved drawings. Text is committed a moment after typing
 * stops (and on close) rather than per keystroke, so one edit is one undo
 * step and the field never fights the round trip.
 */

export interface DrawingMenuSheetProps {
  drawing: ChartDrawing | null;
  onClose: () => void;
  send: (cmd: string, arg?: Record<string, unknown>) => void;
}

const SIZES = [10, 13, 16, 20, 24, 32, 40, 48];

function Chip({ label, active, onPress, danger }: { label: string; active?: boolean; onPress: () => void; danger?: boolean }): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      onPress={onPress}
      style={[s.chip, {
        borderColor: danger ? alpha(t.colors.bear, 0.4) : active ? t.colors.primary : t.colors.borderDark,
        backgroundColor: active ? t.colors.primary : 'transparent',
      }]}
    >
      <AppText variant="caption" weight="700" color={danger ? t.colors.bear : active ? t.colors.onPrimary : t.colors.textSecondary}>{label}</AppText>
    </Pressable>
  );
}

function Field({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={s.field}>
      <AppText variant="micro" weight="700" tone="muted" style={s.fieldTitle}>{title.toUpperCase()}</AppText>
      {children}
    </View>
  );
}

export function DrawingMenuSheet({ drawing, onClose, send }: DrawingMenuSheetProps): React.JSX.Element {
  const t = useTheme();
  const d = drawing;
  const id = d?.id ?? '';
  const set = (patch: Partial<ChartDrawing>): void => { if (id) send('update', { id, patch }); };

  const [text, setText] = useState(d?.text ?? '');
  const pendingText = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { setText(d?.text ?? ''); pendingText.current = null; }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const flushText = (): void => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (pendingText.current !== null && id) { send('update', { id, patch: { text: pendingText.current } }); pendingText.current = null; }
  };
  const onText = (v: string): void => {
    setText(v);
    pendingText.current = v;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flushText, 450);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const close = (): void => { flushText(); onClose(); };
  const act = (cmd: string, arg: Record<string, unknown>) => () => { flushText(); send(cmd, arg); if (cmd === 'remove' || cmd === 'duplicate') onClose(); };

  const fam = d?.family ?? '';
  const textual = d ? isTextDrawing(d) : false;
  const fontSize = d?.fontSize ?? defaultFontSize(fam);

  return (
    <BottomSheet open={!!d} onClose={close} title={d ? toolLabel(d.kind) : undefined} testID="drawing-menu">
      {d ? (
        <View style={s.body}>
          <View style={s.actions}>
            <Chip label="⧉ Duplicate" onPress={act('duplicate', { id })} />
            <Chip label={d.locked ? '🔓 Unlock' : '🔒 Lock'} onPress={act('toggleLock', { id })} />
            <Chip label="⤒ Front" onPress={act('reorder', { id, mode: 'front' })} />
            <Chip label="↑ Forward" onPress={act('reorder', { id, mode: 'forward' })} />
            <Chip label="↓ Backward" onPress={act('reorder', { id, mode: 'backward' })} />
            <Chip label="⤓ Back" onPress={act('reorder', { id, mode: 'back' })} />
            <Chip label="🗑 Delete" danger onPress={act('remove', { id })} />
          </View>

          <Field title="Color">
            <View style={s.palette}>
              {DRAWING_PALETTE.map((c) => (
                <Pressable
                  key={c}
                  accessibilityRole="button"
                  accessibilityLabel={`Colour ${c}`}
                  onPress={() => set({ color: c })}
                  style={[s.swatch, { backgroundColor: c, borderColor: d.color === c ? t.colors.primary : 'transparent' }]}
                />
              ))}
            </View>
          </Field>

          {HAS_WIDTH.has(fam) ? (
            <Field title="Thickness">
              <View style={s.row}>
                {DRAWING_WIDTHS.map((w) => <Chip key={w} label={String(w)} active={d.width === w} onPress={() => set({ width: w })} />)}
              </View>
            </Field>
          ) : null}

          {HAS_STYLE.has(fam) ? (
            <Field title="Style">
              <View style={s.row}>
                {DRAWING_STYLES.map((st) => <Chip key={st.k} label={st.label} active={(d.style || 'solid') === st.k} onPress={() => set({ style: st.k })} />)}
              </View>
            </Field>
          ) : null}

          {HAS_FILL.has(fam) ? (
            <View style={s.toggleRow}>
              <AppText variant="smallStrong" style={s.flex1}>Fill</AppText>
              <Toggle value={!!d.fill} onValueChange={(v) => set({ fill: v })} accessibilityLabel="Fill" />
            </View>
          ) : null}

          {textual ? (
            <Field title="Text">
              <TextInput
                value={text}
                onChangeText={onText}
                onBlur={flushText}
                style={[s.input, { color: t.colors.textPrimary, borderColor: t.colors.borderDark, backgroundColor: t.colors.inputBg }]}
                testID="drawing-text"
              />
            </Field>
          ) : null}

          {fam === 'emoji' ? (
            <Field title="Emoji">
              <View style={s.palette}>
                {DRAWING_EMOJIS.map((em) => (
                  <Pressable key={em} onPress={() => set({ emoji: em })} style={[s.emoji, d.emoji === em && { backgroundColor: alpha(t.colors.primary, 0.15) }]}>
                    <AppText style={s.emojiText}>{em}</AppText>
                  </Pressable>
                ))}
              </View>
            </Field>
          ) : null}

          {textual || fam === 'emoji' || fam === 'marker' ? (
            <Field title={`Size · ${fontSize}`}>
              <View style={s.row}>
                {SIZES.map((sz) => <Chip key={sz} label={String(sz)} active={fontSize === sz} onPress={() => set({ fontSize: sz })} />)}
              </View>
            </Field>
          ) : null}

          <View style={s.toggleRow}>
            <AppText variant="smallStrong" style={s.flex1}>Lock object</AppText>
            <Toggle value={!!d.locked} onValueChange={() => send('toggleLock', { id })} accessibilityLabel="Lock object" />
          </View>
        </View>
      ) : null}
    </BottomSheet>
  );
}

const s = StyleSheet.create({
  body: { gap: 16 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  field: { gap: 8 },
  fieldTitle: { letterSpacing: 0.8 },
  palette: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  swatch: { width: 30, height: 30, borderRadius: 8, borderWidth: 2 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  toggleRow: { flexDirection: 'row', alignItems: 'center' },
  flex1: { flex: 1 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 },
  emoji: { width: 40, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  emojiText: { fontSize: 22, lineHeight: 28 },
});
