import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Share, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { fetchInstrument, useInstruments } from '@/api/instruments.api';
import { useWatchlists } from '@/api/watchlist.api';
import { AppText, Button, Modal, Screen, toast } from '@/components/ui';
import { DraggableList } from '@/components/watchlist/DraggableList';
import { DraggableRail } from '@/components/watchlist/DraggableRail';
import { WatchIcon } from '@/components/watchlist/WatchlistIcons';
import {
  applyTicks,
  bulkAddedToast,
  createdToast,
  importedToast,
  missingSymbols,
  pillHint,
  rowForSymbol,
  transferTitle,
  transferToast,
  type ListFormValues,
  type TransferMode,
} from '@/components/watchlist/watchlistLogic';
import { useAppNavigation, useAppRoute } from '@/navigation/types';
import { makeStyles, useTheme } from '@/theme';
import type { Watchlist, WatchlistItem } from '@/types/market';
import type { Instrument } from '@/types/trading';
import { createTickBuffer, tickPrice } from '@/utils/dashboard';
import {
  buildShareLink,
  decodeWatchlist,
  exportWatchlistFileName,
  exportWatchlistJson,
  type SharedWatchlist,
} from '@/utils/watchlistShare';
import { subscribeTickers } from '@/websocket/channels';

import { SymbolRow } from './components/SymbolRow';
import { WatchlistIllustration } from './components/WatchlistIllustration';
import {
  AddSymbolsModal,
  ConfirmDeleteModal,
  ImportModal,
  ListActionsSheet,
  ListFormModal,
  ListPickerModal,
  SheetAction,
} from './components/WatchlistModals';

/** Live prices are coalesced: one render per window for the whole list. */
const TICK_FLUSH_MS = 400;

interface RowMenuTarget {
  item: WatchlistItem;
  canMoveUp: boolean;
  canMoveDown: boolean;
  moveUp: () => void;
  moveDown: () => void;
}

/**
 * My Watchlists — client/src/pages/Watchlist.jsx, as the web lays it out on
 * a phone: the header with New List, the sticky rail of list pills (tap to
 * open, tap the open one for its actions, long-press to reorder), the open
 * list's header with Add Symbol, and its symbols as draggable cards.
 *
 * Live prices subscribe to the OPEN list's symbols only, re-subscribing when
 * it changes (the web's bandwidth rule), and pause while the screen is not
 * focused. Symbols the catalogue lacks (options) are fetched once each.
 *
 * `?share=<code>` (route param `share`) opens the import prefilled, then the
 * param is cleared so going back never reopens it.
 *
 * Adaptations: the web's keyboard shortcuts have no phone equivalent, so
 * Import (its `I` shortcut) is a header button; Export writes the JSON to the
 * cache and opens the share sheet (a phone has no downloads folder); the
 * row's hover-only Trade button is an entry in the row's ⋮ sheet, with
 * Move up / Move down as the accessible alternative to dragging.
 */
export function WatchlistScreen(): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  const nav = useAppNavigation();
  const route = useAppRoute<'Watchlist'>();
  const focused = useIsFocused();
  const { rows: instruments } = useInstruments();
  const {
    watchlists, activeId, activeList, loading, loaded, setActiveId,
    createList, renameList, deleteList, duplicateList, reorderLists, importWatchlist,
    bulkAddSymbols, removeSymbol, reorderSymbols, pinSymbol, moveSymbol, copySymbol, reload,
  } = useWatchlists();

  const instrBySymbol = useMemo(() => new Map(instruments.map((r) => [r.symbol, r] as const)), [instruments]);

  /* ── Live prices for the open list ─────────────────────────────── */
  const [priceMap, setPriceMap] = useState<Record<string, number>>({});
  const activeSymbols = useMemo(() => (activeList?.items ?? []).map((it) => it.symbol), [activeList]);
  const symbolsKey = activeSymbols.join(',');
  useEffect(() => {
    if (!focused || !symbolsKey) return undefined;
    const buffer = createTickBuffer(TICK_FLUSH_MS, (ticks) => setPriceMap((prev) => applyTicks(prev, ticks)));
    const off = subscribeTickers(symbolsKey.split(','), (tick) => {
      const px = tickPrice(tick);
      if (px !== null && tick.symbol) buffer.push(tick.symbol.toUpperCase(), px);
    });
    return () => { off(); buffer.cancel(); };
  }, [focused, symbolsKey]);

  /* ── On-demand instruments (options are not in the catalogue) ─── */
  const [extra, setExtra] = useState<Record<string, Instrument>>({});
  const fetched = useRef(new Set<string>());
  useEffect(() => {
    const missing = missingSymbols(activeSymbols, instrBySymbol, fetched.current);
    if (!missing.length) return undefined;
    let dead = false;
    for (const sym of missing) fetched.current.add(sym);
    Promise.all(missing.map((sym) => fetchInstrument(sym).then((r) => [sym, r] as const, () => [sym, null] as const)))
      .then((pairs) => {
        if (dead) return;
        setExtra((prev) => {
          const next = { ...prev };
          for (const [sym, r] of pairs) if (r) next[sym] = r;
          return next;
        });
      });
    return () => { dead = true; };
  }, [activeSymbols, instrBySymbol]);

  const rowFor = useCallback(
    (sym: string) => rowForSymbol(sym, instrBySymbol, extra, priceMap),
    [instrBySymbol, extra, priceMap],
  );

  /* ── Dialog state ──────────────────────────────────────────────── */
  const [showCreate, setShowCreate] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Watchlist | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Watchlist | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [transfer, setTransfer] = useState<{ mode: TransferMode; itemId: string } | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [shareInitial, setShareInitial] = useState<SharedWatchlist | null>(null);
  const [listActions, setListActions] = useState<Watchlist | null>(null);
  const [rowMenu, setRowMenu] = useState<RowMenuTarget | null>(null);

  /* ── ?share=<code>: open the import prefilled, then drop the param ─ */
  const shareCode = route.params?.share;
  useEffect(() => {
    if (!shareCode) return;
    try {
      setShareInitial(decodeWatchlist(shareCode));
      setShowImport(true);
    } catch {
      toast.error('That shared watchlist link is invalid');
    }
    nav.setParams({ share: undefined });
  }, [shareCode, nav]);

  /* ── Handlers (Watchlist.jsx:615-636) ──────────────────────────── */
  const handleCreate = ({ name, emoji, color }: ListFormValues) =>
    createList({ name, emoji, color }).then((l) => { toast.success(createdToast(emoji, name)); return l; });
  const handleRename = (target: Watchlist) => ({ name, emoji, color }: ListFormValues) =>
    renameList(target.id, { name, emoji, color });
  const handleDuplicate = (id: string): void => {
    duplicateList(id).then(() => toast.success('Watchlist duplicated')).catch(() => { /* store toasted */ });
  };
  const handleDelete = (target: Watchlist) => () =>
    deleteList(target.id).then(() => toast.success('Watchlist deleted'));
  const handleBulkAdd = (symbols: string[]) => {
    if (!activeList) return Promise.resolve();
    return bulkAddSymbols(activeList.id, symbols).then(() => toast.success(bulkAddedToast(symbols.length)));
  };
  const handleTransfer = (targetId: string): void => {
    if (!transfer || !activeList) return;
    const fn = transfer.mode === 'move' ? moveSymbol : copySymbol;
    const mode = transfer.mode;
    fn(activeList.id, transfer.itemId, targetId)
      .then(() => toast.success(transferToast(mode)))
      .catch(() => { /* store toasted */ });
    setTransfer(null);
  };
  const handleExport = async (l: Watchlist): Promise<void> => {
    try {
      const file = new File(Paths.cache, exportWatchlistFileName(l));
      file.create({ overwrite: true });
      file.write(exportWatchlistJson(l));
      if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');
      await Sharing.shareAsync(file.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: l.name });
      toast.success(`Exported ${l.name}`);
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Could not export this watchlist');
    }
  };
  const handleShare = async (l: Watchlist): Promise<void> => {
    const link = buildShareLink(l);
    try {
      await Clipboard.setStringAsync(link);
      toast.success('Share link copied to clipboard');
    } catch {
      // The web falls back to window.prompt so the link can still be copied;
      // the share sheet is the phone's way to hand it on.
      Share.share({ message: link }).catch(() => { /* dismissed */ });
    }
  };
  const handleImport = ({ name, emoji, color, symbols }: { name: string; emoji: string; color: string; symbols: string[] }) =>
    importWatchlist({ name, emoji, color, symbols }).then(() => {
      setShareInitial(null);
      toast.success(importedToast(symbols.length, name));
    });

  const canDelete = watchlists.length > 1;

  /* ── First load and first run ───────────────────────────────────── */
  if (loading && watchlists.length === 0) {
    return (
      <Screen testID="watchlist-loading">
        <AppText variant="body" tone="muted" align="center" style={s.loading}>Loading your watchlists…</AppText>
      </Screen>
    );
  }

  if (loaded && !loading && watchlists.length === 0) {
    return (
      <Screen testID="watchlist-first-run" onRefresh={reload}>
        <View style={s.firstRun}>
          <WatchlistIllustration />
          <AppText variant="h3" weight="700" align="center" style={s.firstTitle}>Create your first watchlist</AppText>
          <AppText variant="body" tone="secondary" align="center">
            Organize trading pairs into custom lists like Favorites, Scalping, or Futures.
          </AppText>
          <Button title="+ New Watchlist" onPress={() => setShowCreate(true)} style={s.firstBtn} />
        </View>
        {showCreate ? <ListFormModal onClose={() => setShowCreate(false)} onSubmit={handleCreate} /> : null}
      </Screen>
    );
  }

  const items = activeList?.items ?? [];

  const header = (
    <View style={s.headerBlock}>
      <View style={s.pageHead}>
        <AppText variant="h2" weight="700" style={s.flex}>My Watchlists</AppText>
        <Button title="Import" variant="secondary" size="sm" onPress={() => setShowImport(true)} />
        <Button title="New List" leftIcon="plus" size="sm" onPress={() => setShowCreate(true)} />
      </View>

      <DraggableRail
        items={watchlists}
        getId={(l) => l.id}
        onReorder={(ids) => { reorderLists(ids).catch(() => { /* store toasted */ }); }}
        gap={8}
        paddingVertical={8}
        style={[s.rail, { borderBottomColor: t.colors.borderSubtle }]}
        testID="watchlist-rail"
        renderItem={(l, info) => {
          const active = l.id === activeId;
          return info.dragArea(
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${l.name}, ${l.items.length || 0} symbols`}
              accessibilityHint={pillHint(active)}
              accessibilityState={{ selected: active }}
              {...info.a11yProps}
              onPress={() => (active ? setListActions(l) : setActiveId(l.id))}
              style={[s.pill, active
                ? { backgroundColor: t.colors.primary, borderColor: t.colors.primary }
                : { backgroundColor: t.colors.surface, borderColor: t.colors.borderDark },
              info.isLifted ? s.pillLifted : null]}
            >
              {l.color ? <View style={[s.colorDot, { backgroundColor: l.color }]} /> : null}
              <AppText variant="bodyStrong" color={active ? '#FFFFFF' : t.colors.textSecondary}>
                {`${l.emoji} ${l.name}`}
              </AppText>
              <View style={[s.count, { backgroundColor: active ? 'rgba(255,255,255,0.25)' : t.colors.bgHover }]}>
                <AppText variant="micro" weight="700" color={active ? '#FFFFFF' : t.colors.textMuted}>
                  {String(l.items.length || 0)}
                </AppText>
              </View>
              {active ? <WatchIcon name="dotsHorizontal" size={14} color="#FFFFFF" /> : null}
            </Pressable>,
          );
        }}
      />

      <View style={s.listHead}>
        <View style={s.listTitle}>
          <AppText style={s.listEmoji}>{activeList?.emoji ?? ''}</AppText>
          <AppText variant="h3" weight="700" numberOfLines={1} style={s.flexShrink}>{activeList?.name ?? ''}</AppText>
          <AppText variant="small" weight="700" tone="muted">{String(items.length)}</AppText>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add Symbol"
          onPress={() => setShowAdd(true)}
          style={({ pressed }) => [s.addBtn, {
            borderColor: t.alpha(t.colors.primary, 0.5),
            backgroundColor: pressed ? t.alpha(t.colors.primary, 0.05) : 'transparent',
          }]}
        >
          <WatchIcon name="plus" size={15} color={t.colors.primaryText} strokeWidth={2.5} />
          <AppText variant="bodyStrong" weight="700" color={t.colors.primaryText}>Add Symbol</AppText>
        </Pressable>
      </View>
    </View>
  );

  const empty = (
    <View style={[s.emptyCard, { backgroundColor: t.colors.surface, borderColor: t.colors.borderDark }]}>
      <WatchlistIllustration />
      <AppText variant="title" align="center" style={s.firstTitle}>This watchlist is empty</AppText>
      <AppText variant="body" tone="secondary" align="center">
        Add trading pairs to track prices, set up quick trades, and organize your strategy.
      </AppText>
      <Button title="+ Add Symbols" onPress={() => setShowAdd(true)} style={s.firstBtn} />
    </View>
  );

  return (
    <Screen scroll={false} testID="watchlist-screen">
      <DraggableList
        items={items}
        getId={(it) => it.id}
        onReorder={(ids) => { if (activeList) reorderSymbols(activeList.id, ids).catch(() => { /* store toasted */ }); }}
        gap={8}
        paddingBottom={24}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        extraData={priceMap}
        onRefresh={() => { void reload(); }}
        refreshing={false}
        testID="watchlist-items"
        renderItem={(item, info) => (
          <SymbolRow
            item={item}
            row={rowFor(item.symbol)}
            lifted={info.isOverlay}
            dragArea={info.dragArea}
            a11yProps={info.a11yProps}
            onMenu={() => setRowMenu({
              item,
              canMoveUp: info.canMoveUp,
              canMoveDown: info.canMoveDown,
              moveUp: info.moveUp,
              moveDown: info.moveDown,
            })}
          />
        )}
      />

      {showCreate ? <ListFormModal onClose={() => setShowCreate(false)} onSubmit={handleCreate} /> : null}
      {renameTarget ? (
        <ListFormModal initial={renameTarget} onClose={() => setRenameTarget(null)} onSubmit={handleRename(renameTarget)} />
      ) : null}
      {deleteTarget ? (
        <ConfirmDeleteModal list={deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={handleDelete(deleteTarget)} />
      ) : null}
      {showAdd && activeList ? (
        <AddSymbolsModal
          instruments={instruments}
          existingSymbols={activeSymbols}
          onClose={() => setShowAdd(false)}
          onAdd={handleBulkAdd}
        />
      ) : null}
      {transfer ? (
        <ListPickerModal
          title={transferTitle(transfer.mode)}
          lists={watchlists}
          excludeId={activeList?.id}
          onClose={() => setTransfer(null)}
          onPick={handleTransfer}
        />
      ) : null}
      {showImport ? (
        <ImportModal
          instruments={instruments}
          initial={shareInitial}
          onClose={() => { setShowImport(false); setShareInitial(null); }}
          onImport={handleImport}
        />
      ) : null}
      {listActions ? (
        <ListActionsSheet
          list={listActions}
          canDelete={canDelete}
          onClose={() => setListActions(null)}
          onRename={() => setRenameTarget(listActions)}
          onDuplicate={() => handleDuplicate(listActions.id)}
          onShare={() => { void handleShare(listActions); }}
          onExport={() => { void handleExport(listActions); }}
          onDelete={() => setDeleteTarget(listActions)}
        />
      ) : null}
      {rowMenu && activeList ? (
        <Modal
          open
          onClose={() => setRowMenu(null)}
          title={rowMenu.item.symbol}
          presentation="sheet"
          handle
        >
          <View>
            <SheetAction
              icon="trade"
              label="Trade"
              onPress={() => { setRowMenu(null); nav.navigate('Trade', { symbol: rowMenu.item.symbol }); }}
            />
            <SheetAction
              icon="pin"
              filled={rowMenu.item.pinned}
              label={rowMenu.item.pinned ? 'Unpin' : 'Pin to top'}
              onPress={() => {
                setRowMenu(null);
                pinSymbol(activeList.id, rowMenu.item.id, !rowMenu.item.pinned).catch(() => { /* store toasted */ });
              }}
            />
            <SheetAction
              icon="move"
              label="Move to…"
              onPress={() => { setRowMenu(null); setTransfer({ mode: 'move', itemId: rowMenu.item.id }); }}
            />
            <SheetAction
              icon="duplicate"
              label="Copy to…"
              onPress={() => { setRowMenu(null); setTransfer({ mode: 'copy', itemId: rowMenu.item.id }); }}
            />
            <SheetAction
              icon="arrowUp"
              label="Move up"
              disabled={!rowMenu.canMoveUp}
              onPress={() => { setRowMenu(null); rowMenu.moveUp(); }}
            />
            <SheetAction
              icon="arrowDown"
              label="Move down"
              disabled={!rowMenu.canMoveDown}
              onPress={() => { setRowMenu(null); rowMenu.moveDown(); }}
            />
            <View style={[s.divider, { backgroundColor: t.colors.borderSubtle }]} />
            <SheetAction
              icon="trash"
              label="Remove"
              danger
              onPress={() => {
                setRowMenu(null);
                removeSymbol(activeList.id, rowMenu.item.id).catch(() => { /* store toasted */ });
              }}
            />
          </View>
        </Modal>
      ) : null}
    </Screen>
  );
}

const useStyles = makeStyles((t) => ({
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1 },
  loading: { paddingVertical: 40 },
  firstRun: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 16, gap: 4 },
  firstTitle: { marginTop: 16 },
  firstBtn: { marginTop: 20 },
  headerBlock: { gap: 8, marginBottom: 12 },
  pageHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 16 },
  rail: { borderBottomWidth: 1 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 14,
    paddingRight: 10,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
  },
  pillLifted: { opacity: 0.85, transform: [{ scale: 1.04 }] },
  colorDot: { width: 8, height: 8, borderRadius: 4 },
  count: { minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  listHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  listTitle: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  listEmoji: { fontSize: 24, lineHeight: 30 },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: t.radius.xl,
    borderWidth: 1,
  },
  emptyCard: { borderWidth: 1, borderRadius: t.radius.xxl, padding: 32, alignItems: 'center', gap: 4 },
  divider: { height: 1, marginVertical: 4 },
}));
