import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, TextInput, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';

import { searchOptionContracts } from '@/api/instruments.api';
import { AppText, AssetIcon, Button, Modal } from '@/components/ui';
import {
  COLOR_CHOICES,
  EMOJI_CHOICES,
  LIST_FALLBACK_EMOJI,
  LIST_NAME_MAX,
  addButtonLabel,
  addSymbolResults,
  deleteSymbolCount,
  importPreview,
  isOptionLike,
  listFormInitial,
  listFormSubmitLabel,
  listTitle,
  pickerLists,
  readImportText,
  resultSubtitle,
  type ImportPreview,
  type ListFormValues,
} from '@/components/watchlist/watchlistLogic';
import { WatchIcon, type WatchGlyph } from '@/components/watchlist/WatchlistIcons';
import { makeStyles, useTheme } from '@/theme';
import type { Watchlist } from '@/types/market';
import type { Instrument } from '@/types/trading';
import type { SharedWatchlist } from '@/utils/watchlistShare';

/**
 * The Watchlist page's dialogs — client/src/pages/Watchlist.jsx:
 * ListFormModal (create / rename), ConfirmDeleteModal, AddSymbolsModal,
 * ListPickerModal (move / copy target), ImportModal and ListActionsSheet.
 * Every string is the web's. Each dialog is mounted only while open, so its
 * state starts fresh every time — the web's reset-on-open effects.
 *
 * Mobile adaptations: the ImportModal's "Upload file" is the system document
 * picker, and the keyboard-shortcuts help is not ported (a phone has no
 * shortcuts to list).
 */

const useStyles = makeStyles((t) => ({
  label: { marginBottom: 8 },
  field: { gap: 0 },
  emojiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  emojiBtn: {
    width: 36,
    height: 36,
    borderRadius: t.radius.lg,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  colorBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: t.radius.xl,
    borderWidth: 1,
    borderColor: t.colors.borderDark,
    backgroundColor: t.colors.surface,
    color: t.colors.textPrimary,
    fontSize: 14,
  },
  searchWrap: { justifyContent: 'center' },
  searchIcon: { position: 'absolute', left: 12, zIndex: 1 },
  searchInput: { paddingLeft: 36 },
  textarea: { minHeight: 110, textAlignVertical: 'top', fontFamily: 'monospace' },
  stack: { gap: 16 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex: { flex: 1 },
  results: {
    marginTop: 12,
    maxHeight: 360,
    borderWidth: 1,
    borderColor: t.colors.borderDark,
    borderRadius: t.radius.xl,
    overflow: 'hidden',
  },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 10 },
  resultText: { flex: 1, minWidth: 0 },
  check: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: t.radius.xl,
    borderWidth: 1,
    borderColor: t.colors.borderDark,
  },
  pickList: { gap: 6 },
  preview: {
    marginTop: 12,
    padding: 12,
    borderRadius: t.radius.xl,
    borderWidth: 1,
    borderColor: t.colors.borderDark,
    backgroundColor: t.colors.bgHover,
    gap: 4,
  },
  previewHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  uploadRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: t.radius.xl,
  },
  divider: { height: 1, backgroundColor: t.colors.borderSubtle, marginVertical: 4 },
  emoji: { fontSize: 18, lineHeight: 24 },
  empty: { paddingHorizontal: 12, paddingVertical: 32 },
}));

function FieldLabel({ children }: { children: string }): React.JSX.Element {
  const s = useStyles();
  return <AppText variant="label" tone="muted" style={s.label}>{children}</AppText>;
}

/* ── Create / rename ─────────────────────────────────────────────────── */

export function ListFormModal({
  initial,
  onClose,
  onSubmit,
}: {
  /** The list being renamed; absent for "New watchlist". */
  initial?: Watchlist | null;
  onClose: () => void;
  onSubmit: (v: ListFormValues) => Promise<unknown>;
}): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  const [form, setForm] = useState<ListFormValues>(() => listFormInitial(initial));
  const [busy, setBusy] = useState(false);
  const isRename = !!initial;

  const submit = async (): Promise<void> => {
    const trimmed = form.name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSubmit({ ...form, name: trimmed });
      onClose();
    } catch { /* toasted upstream */ } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isRename ? 'Rename watchlist' : 'New watchlist'}
      footer={(
        <View style={s.actions}>
          <Button title="Cancel" variant="secondary" onPress={onClose} style={s.flex} />
          <Button
            title={listFormSubmitLabel(busy, isRename)}
            onPress={() => { void submit(); }}
            disabled={busy || !form.name.trim()}
            style={s.flex}
          />
        </View>
      )}
    >
      <View style={s.stack}>
        <View>
          <FieldLabel>Icon</FieldLabel>
          <View style={s.emojiRow}>
            {EMOJI_CHOICES.map((em) => {
              const on = form.emoji === em;
              return (
                <Pressable
                  key={em}
                  accessibilityRole="button"
                  accessibilityLabel={em}
                  accessibilityState={{ selected: on }}
                  onPress={() => setForm((f) => ({ ...f, emoji: em }))}
                  style={[s.emojiBtn, {
                    borderColor: on ? t.colors.primary : t.colors.borderDark,
                    backgroundColor: on ? t.alpha(t.colors.primary, 0.1) : 'transparent',
                    transform: [{ scale: on ? 1.05 : 1 }],
                  }]}
                >
                  <AppText style={{ fontSize: 18, lineHeight: 24 }}>{em}</AppText>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View>
          <FieldLabel>Color tag</FieldLabel>
          <View style={s.colorRow}>
            {COLOR_CHOICES.map((c) => {
              const on = form.color === c;
              return (
                <Pressable
                  key={c || 'none'}
                  accessibilityRole="button"
                  accessibilityLabel={c || 'None'}
                  accessibilityState={{ selected: on }}
                  onPress={() => setForm((f) => ({ ...f, color: c }))}
                  style={[s.colorBtn, {
                    backgroundColor: c || 'transparent',
                    borderWidth: 2,
                    borderColor: on ? t.colors.primary : c ? 'transparent' : t.colors.borderDark,
                    transform: [{ scale: on ? 1.05 : 1 }],
                  }]}
                >
                  {!c ? <WatchIcon name="close" size={14} color={t.colors.textMuted} /> : null}
                  {on && c ? <WatchIcon name="check" size={14} color="#FFFFFF" strokeWidth={3} /> : null}
                </Pressable>
              );
            })}
          </View>
        </View>

        <View>
          <FieldLabel>Name</FieldLabel>
          <TextInput
            autoFocus
            value={form.name}
            onChangeText={(name) => setForm((f) => ({ ...f, name }))}
            maxLength={LIST_NAME_MAX}
            placeholder="e.g. Scalping, Futures, Long Term"
            placeholderTextColor={t.colors.textMuted}
            returnKeyType="done"
            onSubmitEditing={() => { void submit(); }}
            style={s.input}
            accessibilityLabel="Name"
          />
        </View>
      </View>
    </Modal>
  );
}

/* ── Delete ───────────────────────────────────────────────────────────── */

export function ConfirmDeleteModal({
  list,
  onClose,
  onConfirm,
}: {
  list: Watchlist;
  onClose: () => void;
  onConfirm: () => Promise<unknown>;
}): React.JSX.Element {
  const s = useStyles();
  const [busy, setBusy] = useState(false);
  const confirm = async (): Promise<void> => {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch { /* the store rolled back and toasted */ } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Delete watchlist"
      footer={(
        <View style={s.actions}>
          <Button title="Cancel" variant="secondary" onPress={onClose} style={s.flex} />
          <Button title={busy ? 'Deleting…' : 'Delete'} variant="danger" onPress={() => { void confirm(); }} disabled={busy} style={s.flex} />
        </View>
      )}
    >
      <AppText variant="body" tone="secondary">
        {'Delete '}
        <AppText variant="bodyStrong">{`${list.emoji} ${list.name}`}</AppText>
        {` and its ${deleteSymbolCount(list)}? This can't be undone.`}
      </AppText>
    </Modal>
  );
}

/* ── Add symbols (search + multi-select) ─────────────────────────────── */

export function AddSymbolsModal({
  instruments,
  existingSymbols,
  onClose,
  onAdd,
}: {
  instruments: readonly Instrument[];
  existingSymbols: readonly string[];
  onClose: () => void;
  onAdd: (symbols: string[]) => Promise<unknown>;
}): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [optResults, setOptResults] = useState<Instrument[]>([]);

  // Options are not in the cached catalogue — ask the server when the query
  // looks option-like (a strike or CE/PE), 250 ms after the last keystroke.
  useEffect(() => {
    const term = q.trim();
    if (!isOptionLike(term)) { setOptResults([]); return undefined; }
    const ctrl = new AbortController();
    const id = setTimeout(() => {
      searchOptionContracts(term, { signal: ctrl.signal })
        .then((rows) => { if (!ctrl.signal.aborted) setOptResults(rows); })
        .catch(() => { if (!ctrl.signal.aborted) setOptResults([]); });
    }, 250);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [q]);

  const results = useMemo(
    () => addSymbolResults(instruments, existingSymbols, q, optResults),
    [instruments, existingSymbols, q, optResults],
  );

  const toggle = (sym: string): void => setPicked((prev) => {
    const n = new Set(prev);
    if (n.has(sym)) n.delete(sym); else n.add(sym);
    return n;
  });

  const add = async (): Promise<void> => {
    setBusy(true);
    try {
      await onAdd([...picked]);
      onClose();
    } catch { /* toasted upstream */ } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add symbols"
      size="lg"
      scrollable={false}
      footer={(
        <View style={s.actions}>
          <Button title="Cancel" variant="secondary" onPress={onClose} />
          <Button
            title={busy ? 'Adding…' : addButtonLabel(picked.size)}
            onPress={() => { void add(); }}
            disabled={busy || picked.size === 0}
            style={s.flex}
          />
        </View>
      )}
    >
      <View style={s.searchWrap}>
        <View style={s.searchIcon} pointerEvents="none">
          <WatchIcon name="search" size={16} color={t.colors.textMuted} />
        </View>
        <TextInput
          autoFocus
          value={q}
          onChangeText={setQ}
          placeholder="Search symbol or name…"
          placeholderTextColor={t.colors.textMuted}
          autoCapitalize="characters"
          autoCorrect={false}
          style={[s.input, s.searchInput]}
          accessibilityLabel="Search symbol or name"
        />
      </View>
      <FlatList
        style={s.results}
        data={results}
        keyExtractor={(r) => r.symbol}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={20}
        ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: t.colors.borderSubtle }} />}
        ListEmptyComponent={(
          <View style={s.empty}>
            <AppText variant="body" tone="muted" align="center">{`No symbols match "${q}"`}</AppText>
          </View>
        )}
        renderItem={({ item: r }) => {
          const on = picked.has(r.symbol);
          return (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={r.symbol}
              onPress={() => toggle(r.symbol)}
              style={({ pressed }) => [s.resultRow, {
                backgroundColor: on ? t.alpha(t.colors.primary, 0.05) : pressed ? t.colors.bgHover : 'transparent',
              }]}
            >
              <AssetIcon row={r} size={30} round />
              <View style={s.resultText}>
                <AppText variant="bodyStrong" numberOfLines={1}>{r.symbol}</AppText>
                <AppText variant="caption" tone="muted" numberOfLines={1}>{resultSubtitle(r)}</AppText>
              </View>
              <View style={[s.check, {
                backgroundColor: on ? t.colors.primary : 'transparent',
                borderColor: on ? t.colors.primary : t.colors.borderDark,
              }]}
              >
                {on ? <WatchIcon name="check" size={12} color="#FFFFFF" strokeWidth={3} /> : null}
              </View>
            </Pressable>
          );
        }}
      />
    </Modal>
  );
}

/* ── Move / copy target ───────────────────────────────────────────────── */

export function ListPickerModal({
  title,
  lists,
  excludeId,
  onClose,
  onPick,
}: {
  title: string;
  lists: readonly Watchlist[];
  excludeId: string | null | undefined;
  onClose: () => void;
  onPick: (listId: string) => void;
}): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  const others = pickerLists(lists, excludeId);
  return (
    <Modal open onClose={onClose} title={title}>
      <View style={s.pickList}>
        {others.map((l) => (
          <Pressable
            key={l.id}
            accessibilityRole="button"
            accessibilityLabel={`${l.name}, ${l.items.length || 0}`}
            onPress={() => { onPick(l.id); onClose(); }}
            style={({ pressed }) => [s.pickRow, pressed ? {
              borderColor: t.alpha(t.colors.primary, 0.4),
              backgroundColor: t.alpha(t.colors.primary, 0.05),
            } : null]}
          >
            <AppText style={s.emoji}>{l.emoji || LIST_FALLBACK_EMOJI}</AppText>
            <AppText variant="bodyStrong" numberOfLines={1} style={s.flex}>{l.name}</AppText>
            <AppText variant="small" tone="muted">{String(l.items.length || 0)}</AppText>
          </Pressable>
        ))}
        {others.length === 0 ? (
          <View style={s.empty}>
            <AppText variant="body" tone="muted" align="center">No other watchlists. Create one first.</AppText>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

/* ── Import ───────────────────────────────────────────────────────────── */

export function ImportModal({
  instruments,
  initial,
  onClose,
  onImport,
}: {
  instruments: readonly Instrument[];
  /** A shared-link payload: shown as the preview, no upload / paste. */
  initial: SharedWatchlist | null;
  onClose: () => void;
  onImport: (v: { name: string; emoji: string; color: string; symbols: string[] }) => Promise<unknown>;
}): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  const validSet = useMemo(() => new Set(instruments.map((r) => r.symbol)), [instruments]);
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ImportPreview | null>(() => (initial ? importPreview(initial, validSet) : null));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // A shared payload's "known" count follows the catalogue as it loads.
  useEffect(() => {
    if (initial) setParsed(importPreview(initial, validSet));
  }, [initial, validSet]);

  const apply = (raw: string): void => {
    const r = readImportText(raw);
    setErr(r.error);
    setParsed(r.parsed ? importPreview(r.parsed, validSet) : null);
  };

  const upload = async (): Promise<void> => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['application/json', 'text/plain', '*/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      const asset = res.canceled ? null : res.assets?.[0];
      if (!asset) return;
      const v = await new File(asset.uri).text();
      setText(v);
      apply(v);
    } catch (e) {
      setParsed(null);
      setErr(e instanceof Error && e.message ? e.message : 'Could not read that file');
    }
  };

  const submit = async (): Promise<void> => {
    if (!parsed) return;
    setBusy(true);
    try {
      await onImport({ name: parsed.name, emoji: parsed.emoji, color: parsed.color, symbols: parsed.known });
      onClose();
    } catch { /* toasted upstream */ } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Import watchlist"
      size="lg"
      footer={(
        <View style={s.actions}>
          <Button title="Cancel" variant="secondary" onPress={onClose} />
          <Button
            title={busy ? 'Importing…' : 'Import as new list'}
            onPress={() => { void submit(); }}
            disabled={busy || !parsed}
            style={s.flex}
          />
        </View>
      )}
    >
      {!initial ? (
        <>
          <View style={s.uploadRow}>
            <Button title="Upload file" variant="secondary" size="sm" onPress={() => { void upload(); }} />
            <AppText variant="small" tone="muted">JSON export, share code, or symbol list</AppText>
          </View>
          <TextInput
            value={text}
            onChangeText={(v) => { setText(v); apply(v); }}
            multiline
            numberOfLines={5}
            placeholder="…or paste a share code or symbols (RELIANCE, TCS, INFY)"
            placeholderTextColor={t.colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[s.input, s.textarea]}
            accessibilityLabel="Paste a share code or symbols"
          />
        </>
      ) : null}

      {err ? <AppText variant="body" tone="bear" style={{ marginTop: 12 }}>{err}</AppText> : null}

      {parsed ? (
        <View style={s.preview}>
          <View style={s.previewHead}>
            <AppText style={s.emoji}>{parsed.emoji || LIST_FALLBACK_EMOJI}</AppText>
            <AppText variant="bodyStrong">{parsed.name}</AppText>
          </View>
          <AppText variant="small" tone="secondary">
            <AppText variant="small" weight="600" tone="bull">{String(parsed.known.length)}</AppText>
            {` symbol${parsed.known.length === 1 ? '' : 's'} ready to import`}
            {parsed.skipped > 0 ? <AppText variant="small" tone="muted">{` · ${parsed.skipped} unknown skipped`}</AppText> : null}
          </AppText>
        </View>
      ) : null}
    </Modal>
  );
}

/* ── Per-list actions (the pill's sheet) ─────────────────────────────── */

export function ListActionsSheet({
  list,
  canDelete,
  onClose,
  onRename,
  onDuplicate,
  onShare,
  onExport,
  onDelete,
}: {
  list: Watchlist;
  canDelete: boolean;
  onClose: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onShare: () => void;
  onExport: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const s = useStyles();
  return (
    <Modal open onClose={onClose} title={listTitle(list)} presentation="sheet" handle>
      <View>
        <SheetAction icon="pen" label="Rename" onPress={() => { onClose(); onRename(); }} />
        <SheetAction icon="duplicate" label="Duplicate" onPress={() => { onClose(); onDuplicate(); }} />
        <SheetAction icon="share" label="Share link" onPress={() => { onClose(); onShare(); }} />
        <SheetAction icon="upload" label="Export" onPress={() => { onClose(); onExport(); }} />
        {canDelete ? (
          <>
            <View style={s.divider} />
            <SheetAction icon="trash" label="Delete" danger onPress={() => { onClose(); onDelete(); }} />
          </>
        ) : null}
      </View>
    </Modal>
  );
}

export function SheetAction({
  icon,
  label,
  onPress,
  danger = false,
  disabled = false,
  filled = false,
}: {
  icon: WatchGlyph;
  label: string;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
  filled?: boolean;
}): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  const color = danger ? t.colors.bear : t.colors.textPrimary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.action, {
        opacity: disabled ? 0.4 : 1,
        backgroundColor: pressed ? (danger ? t.alpha(t.colors.bear, 0.05) : t.colors.bgHover) : 'transparent',
      }]}
    >
      <WatchIcon name={icon} size={18} color={color} filled={filled} />
      <AppText variant="body" weight="600" color={color} style={{ fontSize: 15 }}>{label}</AppText>
    </Pressable>
  );
}
