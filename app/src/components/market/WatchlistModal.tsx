import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { FlatList, Pressable, TextInput, View } from 'react-native';

import { AppText, AssetIcon, Button, Modal, toast } from '@/components/ui';
import {
  LIST_FALLBACK_EMOJI,
  LIST_NAME_MAX,
  NEW_LIST_EMOJIS,
  isChecked,
  membershipOf,
  membershipOps,
  saveToast,
} from '@/components/watchlist/watchlistLogic';
import { WatchIcon } from '@/components/watchlist/WatchlistIcons';
import { addSymbol, createList, removeSymbol, useWatchlists } from '@/api/watchlist.api';
import { makeStyles, useTheme } from '@/theme';
import type { Watchlist } from '@/types/market';
import type { Instrument } from '@/types/trading';

/**
 * The app-wide "Add to Watchlist" sheet — WatchlistModalProvider.jsx,
 * AddToWatchlistModal.jsx and watchlistModalContext.js.
 *
 * ONE sheet for the whole app: any bookmark on any screen calls
 * `useWatchlistModal().open(symbol, row)`. It is mounted only while a symbol
 * is set, so the signed-out screens (which the provider also wraps) never
 * touch the watchlist store. Outside the provider `open` is a no-op, never
 * a throw — the web's context default.
 *
 * The sheet ticks every list that holds the symbol; Save sends the minimal
 * adds and removes through the shared store (optimistic, rolled back with a
 * toast on refusal), so every ★, bookmark and the Watchlist screen update at
 * once. "New watchlist" creates a list and drops the symbol straight in.
 *
 * Difference from the web, on purpose: the web resets every tick to the
 * lists' membership whenever the store changes — so creating a list from
 * this sheet threw away ticks the trader had changed but not saved. Here a
 * tick the trader set stays set; only untouched rows follow the store.
 */

export interface WatchlistModalApi {
  open: (symbol: string, row?: Instrument | null) => void;
}

const WatchlistModalContext = createContext<WatchlistModalApi>({ open: () => undefined });

/** `open(symbol, row?)` — the shared sheet. A no-op outside the provider. */
export function useWatchlistModal(): WatchlistModalApi {
  return useContext(WatchlistModalContext);
}

export function WatchlistModalProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [target, setTarget] = useState<{ symbol: string; row: Instrument | null } | null>(null);

  const open = useCallback((symbol: string, row: Instrument | null = null) => {
    if (!symbol) return;
    setTarget({ symbol: String(symbol).toUpperCase(), row });
  }, []);
  const close = useCallback(() => setTarget(null), []);

  // Stable: consumers re-render only if `open` changes, and it never does.
  const value = useMemo(() => ({ open }), [open]);

  return (
    <WatchlistModalContext.Provider value={value}>
      {children}
      {target ? <AddToWatchlistModal symbol={target.symbol} instrumentRow={target.row} onClose={close} /> : null}
    </WatchlistModalContext.Provider>
  );
}

const useStyles = makeStyles((t) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: t.radius.xl,
  },
  emoji: { fontSize: 18, lineHeight: 24 },
  name: { flex: 1, minWidth: 0 },
  box: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createForm: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: t.colors.borderSubtle,
    marginTop: 4,
  },
  emojiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  emojiBtn: {
    width: 36,
    height: 36,
    borderRadius: t.radius.lg,
    borderWidth: 1,
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
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex: { flex: 1 },
  newBox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 },
  titleText: { minWidth: 0, flexShrink: 1 },
  empty: { paddingHorizontal: 12, paddingVertical: 24 },
  list: { maxHeight: 420 },
}));

interface AddProps {
  symbol: string;
  instrumentRow: Instrument | null;
  onClose: () => void;
}

/** AddToWatchlistModal.jsx. Exported for the tests; the provider mounts it. */
export function AddToWatchlistModal({ symbol, instrumentRow, onClose }: AddProps): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  const { watchlists } = useWatchlists();

  // Which lists hold the symbol now — the ticks' starting point.
  const initial = useMemo(() => membershipOf(watchlists, symbol), [watchlists, symbol]);
  const [toggles, setToggles] = useState<Map<string, boolean>>(() => new Map());
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmoji, setNewEmoji] = useState<string>('📈');
  const nameRef = useRef<TextInput>(null);

  // Reused for another symbol: start again from its membership.
  useEffect(() => { setToggles(new Map()); }, [symbol]);
  useEffect(() => {
    if (!creating) return undefined;
    const id = setTimeout(() => nameRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [creating]);

  const toggle = (id: string): void => {
    setToggles((prev) => {
      const next = new Map(prev);
      next.set(id, !isChecked(id, initial, prev));
      return next;
    });
  };

  const submitNewList = async (): Promise<void> => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const list = await createList({ name, emoji: newEmoji });
      if (list?.id) {
        await addSymbol(list.id, symbol);
        setToggles((prev) => new Map(prev).set(list.id, true));
      }
      setCreating(false);
      setNewName('');
      toast.success(`Added ${symbol} to ${name}`);
    } catch {
      /* the store has toasted the reason */
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    const ops = membershipOps(watchlists, symbol, initial, toggles).map((op) => (
      op.kind === 'add' ? addSymbol(op.listId, symbol) : removeSymbol(op.listId, op.itemId ?? '')
    ));
    try {
      if (ops.length) await Promise.all(ops);
      toast.success(saveToast(ops.length, symbol));
      onClose();
    } catch {
      /* each refused edit has rolled back and toasted */
    } finally {
      setBusy(false);
    }
  };

  const title = (
    <View style={s.titleRow}>
      <AssetIcon row={instrumentRow ?? { symbol }} size={28} round />
      <View style={s.titleText}>
        <AppText variant="bodyStrong" weight="700" numberOfLines={1}>Add to Watchlist</AppText>
        <AppText variant="caption" tone="muted" numberOfLines={1}>{symbol}</AppText>
      </View>
    </View>
  );

  const footer = (
    <View style={s.actions}>
      <Button title="Cancel" variant="secondary" onPress={onClose} />
      <Button title={busy ? 'Saving…' : 'Save'} onPress={save} disabled={busy} style={s.flex} />
    </View>
  );

  const renderList = ({ item: w }: { item: Watchlist }): React.JSX.Element => {
    const on = isChecked(w.id, initial, toggles);
    return (
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: on }}
        accessibilityLabel={`${w.name}, ${w.items.length || 0}`}
        onPress={() => toggle(w.id)}
        style={({ pressed }) => [s.row, { backgroundColor: on ? t.alpha(t.colors.primary, 0.05) : pressed ? t.colors.bgHover : 'transparent' }]}
      >
        <AppText style={s.emoji}>{w.emoji || LIST_FALLBACK_EMOJI}</AppText>
        <AppText variant="body" weight="600" numberOfLines={1} style={[s.name, { fontSize: 15 }]}>{w.name}</AppText>
        <AppText variant="small" tone="muted" mono>{w.items.length || 0}</AppText>
        <View style={[s.box, { borderColor: on ? t.colors.primary : t.colors.borderDark, backgroundColor: on ? t.colors.primary : 'transparent' }]}>
          {on ? <WatchIcon name="check" size={14} color="#FFFFFF" strokeWidth={3} /> : null}
        </View>
      </Pressable>
    );
  };

  const createBlock = creating ? (
    <View style={s.createForm}>
      <View style={s.emojiRow}>
        {NEW_LIST_EMOJIS.map((em) => {
          const on = newEmoji === em;
          return (
            <Pressable
              key={em}
              accessibilityRole="button"
              accessibilityLabel={em}
              accessibilityState={{ selected: on }}
              onPress={() => setNewEmoji(em)}
              style={[s.emojiBtn, {
                borderColor: on ? t.colors.primary : t.colors.borderDark,
                backgroundColor: on ? t.alpha(t.colors.primary, 0.1) : 'transparent',
                transform: [{ scale: on ? 1.05 : 1 }],
              }]}
            >
              <AppText style={{ fontSize: 16, lineHeight: 22 }}>{em}</AppText>
            </Pressable>
          );
        })}
      </View>
      <TextInput
        ref={nameRef}
        value={newName}
        onChangeText={setNewName}
        maxLength={LIST_NAME_MAX}
        placeholder="New watchlist name"
        placeholderTextColor={t.colors.textMuted}
        returnKeyType="done"
        onSubmitEditing={() => { void submitNewList(); }}
        style={s.input}
        accessibilityLabel="New watchlist name"
      />
      <View style={s.actions}>
        <Button title="Cancel" variant="secondary" size="sm" onPress={() => { setCreating(false); setNewName(''); }} />
        <Button
          title={busy ? 'Creating…' : 'Create & add'}
          size="sm"
          onPress={() => { void submitNewList(); }}
          disabled={busy || !newName.trim()}
          style={s.flex}
        />
      </View>
    </View>
  ) : (
    <Pressable
      accessibilityRole="button"
      onPress={() => setCreating(true)}
      style={({ pressed }) => [s.row, { backgroundColor: pressed ? t.colors.bgHover : 'transparent' }]}
    >
      <View style={[s.newBox, { borderColor: t.alpha(t.colors.primary, 0.8) }]}>
        <WatchIcon name="plus" size={14} color={t.colors.primary} strokeWidth={2.5} />
      </View>
      <AppText variant="bodyStrong" color={t.colors.primaryText} style={s.name}>New watchlist</AppText>
    </Pressable>
  );

  return (
    <Modal open onClose={onClose} title={title} footer={footer} size="sm" bodyPadding={8} scrollable={false}>
      <FlatList
        data={watchlists}
        keyExtractor={(w) => w.id}
        renderItem={renderList}
        style={s.list}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={watchlists.length === 0 && !creating ? (
          <View style={s.empty}>
            <AppText variant="body" tone="muted" align="center">No watchlists yet — create one below.</AppText>
          </View>
        ) : null}
        ListFooterComponent={createBlock}
      />
    </Modal>
  );
}

