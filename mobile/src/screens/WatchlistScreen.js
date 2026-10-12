import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, Modal, FlatList,
  RefreshControl, StyleSheet, KeyboardAvoidingView, Platform, Image, Alert,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import Svg, { Path, Line, Circle, Polygon, Defs, LinearGradient, Stop } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { useColors, radius, fmtNum } from '../theme';
import { Button, Row, Loader, Empty } from '../components/ui';

/**
 * WatchlistScreen — native port of the web client's Watchlist page
 * (client/src/pages/Watchlist.jsx). Mirrors the web's OWN mobile layout
 * section-for-section:
 *   • header            — "My Watchlists" + New List
 *   • sticky list-tabs  — horizontal pills (color · emoji · name · count);
 *                         tap an inactive tab to switch, tap the active tab
 *                         to open its actions bottom-sheet.
 *   • active list       — emoji · name · count + Add Symbol, then the symbol
 *                         rows (icon · symbol · sparkline · live price · % ·
 *                         Trade · row menu) or an empty-state illustration.
 *   • first-run         — no lists yet → create-your-first-watchlist prompt.
 * The web's hover dropdowns / desktop drag-reorder / share+import+export all
 * become native <Modal> bottom-sheets or are trimmed (see the report). Uses
 * the SAME backend endpoints the web's useWatchlists hook calls, live prices
 * over the SAME wsClient ticker channels, real data only.
 */

// ─── Small helpers (pure — no styles/colors at module scope) ──────────────
const EMOJI_CHOICES = ['⭐', '📈', '🔥', '💎', '🚀', '📊', '⚡', '🌙', '🐂', '🐻'];
// Color tags — '' = none. Hex values double as the accent dot color.
const COLOR_CHOICES = ['', '#3B82F6', '#22C55E', '#EF4444', '#F59E0B', '#A855F7', '#EC4899', '#14B8A6'];

const fmtPrice = (raw, prec) => {
  const v = Number(raw);
  if (!Number.isFinite(v)) return '—';
  return fmtNum(v, Math.min(Number(prec) || 2, 6));
};

// Deterministic spark from the 24h change — ported verbatim from the web.
function sparkPath(change24h) {
  const W = 84, H = 30, mid = H / 2;
  const finite = Number.isFinite(change24h);
  const positive = !finite || change24h >= 0;
  const start = mid + (positive ? 6 : -6);
  const end = mid + (positive ? -6 : 6);
  const points = [];
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const x = t * W;
    const noise = ((i % 2 === 0) ? 1 : -1) * (5 - i * 0.35);
    const y = start + (end - start) * t + noise * 0.6;
    points.push([x.toFixed(1), y.toFixed(1)]);
  }
  const d = points.map(([x, y], i) => (i === 0 ? `M${x} ${y}` : `L${x} ${y}`)).join(' ');
  return { d, W, H, finite, positive };
}

// ─── Asset glyph catalog (kept in sync with the web AssetIcon / MarketsScreen) ─
const ASSET_META = {
  BTCUSD: { glyph: '₿', bg: '#F7931A' },
  ETHUSD: { glyph: 'Ξ', bg: '#627EEA' },
  SOLUSD: { glyph: '◎', bg: '#9945FF' },
  XRPUSD: { glyph: 'X', bg: '#23292F' },
  EURUSD: { glyph: '€$', bg: '#1F3A8A' },
  GBPUSD: { glyph: '£$', bg: '#7C3AED' },
  USDJPY: { glyph: '¥$', bg: '#0F172A' },
  AUDUSD: { glyph: 'A$', bg: '#0EA5E9' },
  GOLD: { glyph: 'Au', bg: '#D4A017' },
  XAUUSD: { glyph: 'Au', bg: '#D4A017' },
  XAGUSD: { glyph: 'Ag', bg: '#94A3B8' },
  NAS100: { glyph: 'NQ', bg: '#0EA5E9' },
  US30: { glyph: 'DJ', bg: '#475569' },
  SPX500: { glyph: 'SP', bg: '#3B82F6' },
};
const CAT_TINT = { CRYPTO: '#F7931A', FOREX: '#10B981', COMMODITY: '#D4A017', INDEX: '#3B82F6', STOCK: '#8B5CF6' };
function glyphMeta(row) {
  const sym = (row?.symbol || '').toUpperCase();
  if (ASSET_META[sym]) return ASSET_META[sym];
  const category = (row?.category || '').toUpperCase();
  const base = (row?.baseCurrency || '').toUpperCase();
  const bg = CAT_TINT[category] || '#475569';
  const glyph = base && base.length >= 2 ? base.slice(0, 3) : sym.slice(0, 2) || '?';
  return { glyph, bg };
}

// ─── Presentational pieces (receive styles / c via props — never module `c`) ──
function AssetGlyph({ row, size = 38, c }) {
  const logo = row?.logoUrl;
  const [failed, setFailed] = useState(false);
  // Reset when the view is recycled (FlashList) onto a different symbol/logo.
  useEffect(() => { setFailed(false); }, [logo]);
  if (logo && !failed) {
    return (
      <Image
        source={{ uri: logo }}
        onError={() => setFailed(true)}
        style={{ width: size, height: size, borderRadius: radius.md, backgroundColor: '#FFFFFF' }}
      />
    );
  }
  const meta = glyphMeta(row);
  const fs = Math.round(size * (meta.glyph.length > 2 ? 0.34 : 0.42));
  return (
    <View style={{ width: size, height: size, borderRadius: radius.md, backgroundColor: meta.bg, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#FFFFFF', fontWeight: '800', fontSize: fs }}>{meta.glyph}</Text>
    </View>
  );
}

function Spark({ change, styles, c }) {
  const { d, W, H, finite, positive } = sparkPath(Number(change));
  const tone = !finite ? c.textMuted : positive ? c.bull : c.bear;
  return (
    <Svg width={54} height={28} viewBox={`0 0 ${W} ${H}`} style={styles.spark}>
      <Path d={`${d} L${W} ${H} L0 ${H} Z`} fill={tone} fillOpacity={0.12} />
      <Path d={d} stroke={tone} strokeWidth={1.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

// Empty-state illustration (reused for first-run + empty list) — ported from web.
function WatchlistIllustration({ c }) {
  const accent = c.primary400;
  return (
    <Svg width={200} height={128} viewBox="0 0 220 140">
      <Defs>
        <LinearGradient id="wishGrad" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%" stopColor={accent} stopOpacity={1} />
          <Stop offset="100%" stopColor={accent} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Line x1="10" y1="40" x2="210" y2="40" stroke={c.borderSubtle} strokeWidth={1} strokeDasharray="2 3" />
      <Line x1="10" y1="70" x2="210" y2="70" stroke={c.borderSubtle} strokeWidth={1} strokeDasharray="2 3" />
      <Line x1="10" y1="100" x2="210" y2="100" stroke={c.borderSubtle} strokeWidth={1} strokeDasharray="2 3" />
      <Path d="M20 90 L50 80 L80 65 L110 55 L140 38 L170 28 L200 22 L200 120 L20 120 Z" fill="url(#wishGrad)" opacity={0.18} />
      <Path d="M20 90 L50 80 L80 65 L110 55 L140 38 L170 28 L200 22" stroke={accent} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Circle cx="200" cy="22" r="13" fill={c.card} stroke={accent} strokeWidth={2} />
      <Polygon points="200,14 202.2,19.7 208.5,20.1 203.5,24.1 205.2,30 200,26.6 194.8,30 196.5,24.1 191.5,20.1 197.8,19.7" fill={accent} />
    </Svg>
  );
}

// ─── Generic bottom-sheet shell (native equivalent of the shared web Modal) ───
function Sheet({ visible, onClose, title, children, styles, c }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.sheetRoot}>
        <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.sheetHandle} />
          {title ? (
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle} numberOfLines={1}>{title}</Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color={c.textMuted} />
              </TouchableOpacity>
            </View>
          ) : null}
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── Create / rename list sheet ───────────────────────────────────────────
function ListFormModal({ visible, onClose, initial, onSubmit, styles, c }) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('⭐');
  const [color, setColor] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (visible) { setName(initial?.name || ''); setEmoji(initial?.emoji || '⭐'); setColor(initial?.color || ''); setBusy(false); }
  }, [visible, initial]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try { await onSubmit({ name: trimmed, emoji, color }); onClose(); }
    catch (_) { /* Alert surfaced upstream — keep the sheet open */ }
    finally { setBusy(false); }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={initial ? 'Rename watchlist' : 'New watchlist'} styles={styles} c={c}>
      <Text style={styles.fieldLabel}>ICON</Text>
      <View style={styles.emojiWrap}>
        {EMOJI_CHOICES.map((em) => (
          <TouchableOpacity key={em} onPress={() => setEmoji(em)} style={[styles.emojiBtn, emoji === em && styles.emojiBtnOn]}>
            <Text style={{ fontSize: 18 }}>{em}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.fieldLabel}>COLOR TAG</Text>
      <View style={styles.colorWrap}>
        {COLOR_CHOICES.map((col) => {
          const on = color === col;
          return (
            <TouchableOpacity
              key={col || 'none'}
              onPress={() => setColor(col)}
              style={[
                styles.colorBtn,
                { backgroundColor: col || 'transparent', borderColor: col ? (on ? c.primary500 : 'transparent') : c.border },
                on && !!col && styles.colorBtnOn,
              ]}
            >
              {!col ? <Ionicons name="close" size={14} color={c.textMuted} /> : on ? <Ionicons name="checkmark" size={14} color="#FFFFFF" /> : null}
            </TouchableOpacity>
          );
        })}
      </View>

      <Text style={styles.fieldLabel}>NAME</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        maxLength={40}
        autoFocus
        placeholder="e.g. Scalping, Futures, Long Term"
        placeholderTextColor={c.textMuted}
        style={styles.input}
      />

      <Row style={{ gap: 10, marginTop: 18 }}>
        <Button title="Cancel" variant="ghost" style={{ flex: 1 }} onPress={onClose} />
        <Button title={initial ? 'Save' : 'Create'} style={{ flex: 1 }} loading={busy} disabled={!name.trim()} onPress={submit} />
      </Row>
    </Sheet>
  );
}

// ─── Confirm-delete sheet ─────────────────────────────────────────────────
function ConfirmDeleteModal({ visible, onClose, list, onConfirm, styles, c }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (visible) setBusy(false); }, [visible]);
  const n = list?.items?.length || 0;
  return (
    <Sheet visible={visible} onClose={onClose} title="Delete watchlist" styles={styles} c={c}>
      <Text style={styles.sheetBody}>
        Delete <Text style={{ fontWeight: '800', color: c.textPrimary }}>{list?.emoji} {list?.name}</Text> and its {n} symbol{n === 1 ? '' : 's'}? This can't be undone.
      </Text>
      <Row style={{ gap: 10, marginTop: 18 }}>
        <Button title="Cancel" variant="ghost" style={{ flex: 1 }} onPress={onClose} />
        <Button
          title="Delete"
          variant="danger"
          style={{ flex: 1 }}
          loading={busy}
          onPress={async () => { setBusy(true); try { await onConfirm(); onClose(); } catch (_) {} finally { setBusy(false); } }}
        />
      </Row>
    </Sheet>
  );
}

// ─── Add-symbols sheet (search + multi-select bulk add) ───────────────────
function AddSymbolsModal({ visible, onClose, instruments, existingSymbols, onAdd, styles, c }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [optResults, setOptResults] = useState([]); // options surfaced on option-like queries
  useEffect(() => { if (visible) { setQ(''); setPicked(new Set()); setOptResults([]); setBusy(false); } }, [visible]);

  // Options aren't in the cached catalog — fetch on demand for option-like queries.
  useEffect(() => {
    const term = q.trim();
    const optionLike = /\d{3,}/.test(term) || /(^|[^a-z])(ce|pe)([^a-z]|$)/i.test(term);
    if (!term || !optionLike) { setOptResults([]); return undefined; }
    const id = setTimeout(() => {
      api.get(`/instruments/search?q=${encodeURIComponent(term)}`)
        .then((res) => setOptResults((res.data?.data || []).filter((r) => r.segment === 'OPT')))
        .catch(() => setOptResults([]));
    }, 250);
    return () => clearTimeout(id);
  }, [q]);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    const existing = new Set(existingSymbols);
    let rows = (instruments || []).filter((r) => !existing.has(r.symbol));
    if (term) rows = rows.filter((r) => r.symbol.toLowerCase().includes(term) || (r.name || '').toLowerCase().includes(term));
    rows = rows.slice(0, 60);
    const opts = optResults.filter((o) => !existing.has(o.symbol) && !rows.some((r) => r.symbol === o.symbol));
    return [...rows, ...opts].slice(0, 80);
  }, [q, instruments, existingSymbols, optResults]);

  const toggle = (sym) => setPicked((prev) => { const n = new Set(prev); if (n.has(sym)) n.delete(sym); else n.add(sym); return n; });
  const add = async () => { setBusy(true); try { await onAdd([...picked]); onClose(); } catch (_) {} finally { setBusy(false); } };

  return (
    <Sheet visible={visible} onClose={onClose} title="Add symbols" styles={styles} c={c}>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={c.textMuted} />
        <TextInput
          value={q}
          onChangeText={setQ}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Search symbol or name…"
          placeholderTextColor={c.textMuted}
          style={styles.searchInput}
        />
      </View>
      <View style={styles.resultsBox}>
        <FlatList
          data={results}
          keyExtractor={(r) => r.symbol}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() => <View style={styles.sepInset} />}
          ListEmptyComponent={<Text style={styles.noMatch}>No symbols match “{q}”</Text>}
          renderItem={({ item: r }) => {
            const on = picked.has(r.symbol);
            return (
              <TouchableOpacity onPress={() => toggle(r.symbol)} style={[styles.pickRow, on && { backgroundColor: c.primarySoft }]}>
                <AssetGlyph row={r} size={30} c={c} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.pickSym} numberOfLines={1}>{r.symbol}</Text>
                  <Text style={styles.pickName} numberOfLines={1}>{r.name || `${r.baseCurrency || ''}/${r.quoteCurrency || ''}`}</Text>
                </View>
                <View style={[styles.checkbox, on && styles.checkboxOn]}>
                  {on ? <Ionicons name="checkmark" size={13} color="#FFFFFF" /> : null}
                </View>
              </TouchableOpacity>
            );
          }}
        />
      </View>
      <Row style={{ gap: 10, marginTop: 14 }}>
        <Button title="Cancel" variant="ghost" style={{ flex: 1 }} onPress={onClose} />
        <Button
          title={picked.size ? `Add ${picked.size} symbol${picked.size === 1 ? '' : 's'}` : 'Add symbols'}
          style={{ flex: 2 }}
          loading={busy}
          disabled={picked.size === 0}
          onPress={add}
        />
      </Row>
    </Sheet>
  );
}

// ─── List picker (move / copy target) ─────────────────────────────────────
function ListPickerModal({ visible, onClose, title, lists, excludeId, onPick, styles, c }) {
  const options = (lists || []).filter((l) => l._id !== excludeId);
  return (
    <Sheet visible={visible} onClose={onClose} title={title} styles={styles} c={c}>
      {options.length === 0 ? (
        <Text style={styles.sheetBody}>No other watchlists. Create one first.</Text>
      ) : options.map((l) => (
        <TouchableOpacity key={l._id} onPress={() => { onPick(l._id); onClose(); }} style={styles.pickListRow}>
          <Text style={{ fontSize: 18 }}>{l.emoji || '📋'}</Text>
          <Text style={styles.pickListName} numberOfLines={1}>{l.name}</Text>
          <Text style={styles.pickListCount}>{l.items?.length || 0}</Text>
        </TouchableOpacity>
      ))}
    </Sheet>
  );
}

// ─── Action rows shared by the list + row bottom-sheets ───────────────────
function SheetAction({ icon, label, danger, onPress, onClose, styles, c }) {
  return (
    <TouchableOpacity onPress={() => { onClose(); onPress(); }} style={styles.actionRow}>
      <Ionicons name={icon} size={19} color={danger ? c.bear : c.textSecondary} />
      <Text style={[styles.actionTxt, danger && { color: c.bear }]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── Per-list actions sheet (tap the active tab) ──────────────────────────
function ListActionsSheet({ list, onClose, onRename, onDuplicate, onDelete, canDelete, styles, c }) {
  return (
    <Sheet visible={!!list} onClose={onClose} title={list ? `${list.emoji || '📋'} ${list.name}` : ''} styles={styles} c={c}>
      <SheetAction icon="create-outline" label="Rename" onPress={onRename} onClose={onClose} styles={styles} c={c} />
      <SheetAction icon="copy-outline" label="Duplicate" onPress={onDuplicate} onClose={onClose} styles={styles} c={c} />
      {canDelete ? (
        <>
          <View style={styles.divider} />
          <SheetAction icon="trash-outline" label="Delete" danger onPress={onDelete} onClose={onClose} styles={styles} c={c} />
        </>
      ) : null}
    </Sheet>
  );
}

// ─── Row quick-actions sheet (the web's ⋯ dropdown) ───────────────────────
function RowMenuSheet({ item, onClose, onPin, onMove, onCopy, onRemove, styles, c }) {
  const pinned = !!item?.pinned;
  return (
    <Sheet visible={!!item} onClose={onClose} title={item?.symbol || ''} styles={styles} c={c}>
      <SheetAction icon={pinned ? 'bookmark' : 'bookmark-outline'} label={pinned ? 'Unpin' : 'Pin to top'} onPress={onPin} onClose={onClose} styles={styles} c={c} />
      <SheetAction icon="arrow-forward-outline" label="Move to…" onPress={onMove} onClose={onClose} styles={styles} c={c} />
      <SheetAction icon="copy-outline" label="Copy to…" onPress={onCopy} onClose={onClose} styles={styles} c={c} />
      <View style={styles.divider} />
      <SheetAction icon="trash-outline" label="Remove" danger onPress={onRemove} onClose={onClose} styles={styles} c={c} />
    </Sheet>
  );
}

// ─── Symbol row ───────────────────────────────────────────────────────────
function SymbolRow({ item, row, onOpen, onTrade, onMenu, styles, c }) {
  const change = Number(row?.change24h);
  const positive = !Number.isFinite(change) ? null : change >= 0;
  const tone = positive == null ? c.textMuted : positive ? c.bull : c.bear;
  return (
    <View style={styles.symRow}>
      <TouchableOpacity style={styles.symMain} activeOpacity={0.6} onPress={onOpen}>
        <AssetGlyph row={row || { symbol: item.symbol }} size={38} c={c} />
        <View style={styles.symText}>
          <Row>
            <Text style={styles.symName} numberOfLines={1}>{item.symbol}</Text>
            {item.pinned ? <Ionicons name="bookmark" size={11} color={c.primary400} style={{ marginLeft: 5 }} /> : null}
          </Row>
          <Text style={styles.symSub} numberOfLines={1}>{row?.name || ''}</Text>
        </View>
      </TouchableOpacity>

      <Spark change={change} styles={styles} c={c} />

      <View style={styles.symRight}>
        <Text style={styles.symPrice} numberOfLines={1}>{fmtPrice(row?.lastPrice, row?.pricePrecision)}</Text>
        <Text style={[styles.symChg, { color: tone }]} numberOfLines={1}>
          {positive == null ? '—' : `${positive ? '+' : ''}${change.toFixed(2)}%`}
        </Text>
      </View>

      <TouchableOpacity style={styles.tradeBtn} activeOpacity={0.8} onPress={onTrade}>
        <Text style={styles.tradeTxt}>Trade</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.menuBtn} onPress={onMenu} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}>
        <Ionicons name="ellipsis-vertical" size={16} color={c.textMuted} />
      </TouchableOpacity>
    </View>
  );
}

// ─── Sticky list tab pill ─────────────────────────────────────────────────
function ListTab({ list, active, onPress, styles, c }) {
  return (
    <TouchableOpacity activeOpacity={0.8} onPress={onPress} style={[styles.tab, active && styles.tabOn]}>
      {list.color ? <View style={[styles.tabDot, { backgroundColor: list.color }]} /> : null}
      <Text style={styles.tabEmoji}>{list.emoji || '📋'}</Text>
      <Text style={[styles.tabName, active && styles.tabNameOn]} numberOfLines={1}>{list.name}</Text>
      <View style={[styles.tabCount, active && styles.tabCountOn]}>
        <Text style={[styles.tabCountTxt, active && styles.tabCountTxtOn]}>{list.items?.length || 0}</Text>
      </View>
      {active ? <Ionicons name="ellipsis-horizontal" size={14} color={c.white} style={{ marginLeft: 2 }} /> : null}
    </TouchableOpacity>
  );
}

// ─── Empty-list state (active list has no symbols) ────────────────────────
function EmptyList({ onAdd, styles, c }) {
  return (
    <View style={styles.emptyWrap}>
      <WatchlistIllustration c={c} />
      <Text style={styles.emptyTitle}>This watchlist is empty</Text>
      <Text style={styles.emptySub}>Add trading pairs to track prices, set up quick trades, and organize your strategy.</Text>
      <Button title="+ Add Symbols" style={{ marginTop: 16, paddingHorizontal: 22 }} onPress={onAdd} />
    </View>
  );
}

// ─── Screen ────────────────────────────────────────────────────────────────
export default function WatchlistScreen({ navigation }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);

  const [watchlists, setWatchlists] = useState(null); // null = loading
  const [activeId, setActiveId] = useState(null);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const [instruments, setInstruments] = useState([]);
  const [extra, setExtra] = useState({});       // on-demand instruments (options)
  const fetchedRef = useRef(new Set());
  const [priceMap, setPriceMap] = useState({}); // live last-price by symbol

  // UI state (each modal = a native bottom-sheet)
  const [showCreate, setShowCreate] = useState(false);
  const [renameTarget, setRenameTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [transfer, setTransfer] = useState(null);       // { mode:'move'|'copy', itemId }
  const [mobileActions, setMobileActions] = useState(null); // list whose action sheet is open
  const [menuItem, setMenuItem] = useState(null);       // item whose row-menu is open

  const activeList = useMemo(
    () => (watchlists || []).find((w) => w._id === activeId) || null,
    [watchlists, activeId],
  );
  const items = activeList?.items || [];
  const instrBySymbol = useMemo(() => new Map((instruments || []).map((r) => [r.symbol, r])), [instruments]);
  const activeSymbols = useMemo(() => items.map((it) => it.symbol), [items]);

  // ── Cache upsert helper (mirrors the web's upsertList) ──
  const applyList = useCallback((wl) => {
    if (!wl?._id) return;
    setWatchlists((prev) => {
      const arr = prev ? [...prev] : [];
      const idx = arr.findIndex((w) => w._id === wl._id);
      if (idx === -1) arr.push(wl); else arr[idx] = wl;
      return arr;
    });
  }, []);

  // ── Load watchlists — GET /watchlists → { watchlists, lastSelectedWatchlistId } ──
  const loadWatchlists = useCallback(async () => {
    try {
      const { data } = await api.get('/watchlists');
      const lists = data?.data?.watchlists || [];
      const last = data?.data?.lastSelectedWatchlistId || null;
      setWatchlists(lists);
      setActiveId((prev) => {
        if (prev && lists.some((w) => w._id === prev)) return prev;
        if (last && lists.some((w) => w._id === last)) return last;
        const def = lists.find((w) => w.isDefault) || lists[0];
        return def?._id || null;
      });
      setErr('');
    } catch (e) {
      setErr(errorMessage(e));
      setWatchlists((w) => w || []);
    }
  }, []);

  // ── Instrument catalog — /instruments merged with /instruments/watchlist ──
  const loadInstruments = useCallback(async () => {
    try {
      const [catRes, wlRes] = await Promise.all([
        api.get('/instruments'),
        api.get('/instruments/watchlist').catch(() => ({ data: { data: [] } })),
      ]);
      const catalog = catRes.data?.data || [];
      const watch = wlRes.data?.data || [];
      const wlBy = new Map(watch.map((r) => [r.symbol, r]));
      setInstruments(catalog.map((r) => {
        const wl = wlBy.get(r.symbol);
        return wl ? {
          ...r,
          lastPrice: wl.lastPrice ?? r.lastPrice,
          change24h: wl.change24h,
          dayHigh: wl.dayHigh,
          dayLow: wl.dayLow,
          volume24h: wl.volume24h ?? r.volume24h,
        } : r;
      }));
    } catch (_) {
      setInstruments((r) => r || []);
    }
  }, []);

  useEffect(() => { loadWatchlists(); loadInstruments(); }, [loadWatchlists, loadInstruments]);
  useEffect(() => { const id = setInterval(loadInstruments, 30000); return () => clearInterval(id); }, [loadInstruments]);

  // ── Live prices: subscribe ONLY to the active list's symbols (resubscribe on change) ──
  useEffect(() => {
    if (!activeSymbols.length) return undefined;
    const unsubs = activeSymbols.map((sym) =>
      wsClient.subscribe(`ticker:${sym}`, (data) => {
        const px = Number(data?.lastPrice ?? data?.price ?? data?.last);
        if (Number.isFinite(px)) setPriceMap((m) => (m[sym] === px ? m : { ...m, [sym]: px }));
      }),
    );
    return () => unsubs.forEach((u) => u && u());
  }, [activeSymbols.join(',')]);

  // ── On-demand instruments: options aren't in the cached catalog — fetch once ──
  useEffect(() => {
    const missing = activeSymbols.filter((s) => !instrBySymbol.has(s) && !fetchedRef.current.has(s));
    if (!missing.length) return;
    missing.forEach((s) => fetchedRef.current.add(s));
    Promise.all(missing.map((s) => api.get(`/instruments/${encodeURIComponent(s)}`)
      .then((r) => [s, r.data?.data]).catch(() => [s, null])))
      .then((pairs) => setExtra((prev) => {
        const next = { ...prev };
        for (const [s, d] of pairs) if (d) next[s] = d;
        return next;
      }));
  }, [activeSymbols.join(','), instrBySymbol]);

  const rowFor = (sym) => {
    const base = instrBySymbol.get(sym) || extra[sym];
    if (!base) return null;
    const px = priceMap[sym];
    return px != null ? { ...base, lastPrice: px } : base;
  };

  // ── Selection (persist "remember last watchlist") ──
  const selectList = (id) => {
    if (!id || id === activeId) return;
    setActiveId(id);
    api.patch('/watchlists/last-selected', { watchlistId: id }).catch(() => {});
  };

  // ── Mutations — SAME endpoints the web's useWatchlists hook calls ──
  const handleCreate = async ({ name, emoji, color }) => {
    try {
      const { data } = await api.post('/watchlists', { name, emoji, color });
      applyList(data.data);
      setActiveId(data.data._id);
      api.patch('/watchlists/last-selected', { watchlistId: data.data._id }).catch(() => {});
    } catch (e) { Alert.alert('Failed', errorMessage(e)); throw e; }
  };
  const handleRename = async (patch) => {
    if (!renameTarget) return;
    try { const { data } = await api.patch(`/watchlists/${renameTarget._id}`, patch); applyList(data.data); }
    catch (e) { Alert.alert('Failed', errorMessage(e)); throw e; }
  };
  const handleDuplicate = async (id) => {
    try { const { data } = await api.post(`/watchlists/${id}/duplicate`); applyList(data.data); }
    catch (e) { Alert.alert('Failed', errorMessage(e)); }
  };
  const handleDelete = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget._id;
    try {
      await api.delete(`/watchlists/${id}`);
      const remaining = (watchlists || []).filter((w) => w._id !== id);
      setWatchlists(remaining);
      if (activeId === id) setActiveId(remaining[0]?._id || null);
    } catch (e) { Alert.alert('Failed', errorMessage(e)); throw e; }
  };
  const handleBulkAdd = async (symbols) => {
    if (!activeList || !symbols.length) return;
    try { const { data } = await api.post(`/watchlists/${activeList._id}/items/bulk`, { symbols }); applyList(data.data); }
    catch (e) { Alert.alert('Failed', errorMessage(e)); throw e; }
  };
  const removeSymbol = async (itemId) => {
    if (!activeList) return;
    try { const { data } = await api.delete(`/watchlists/${activeList._id}/items/${itemId}`); applyList(data.data); }
    catch (e) { Alert.alert('Failed', errorMessage(e)); }
  };
  const pinSymbol = async (itemId, pinned) => {
    if (!activeList) return;
    try { const { data } = await api.post(`/watchlists/${activeList._id}/items/${itemId}/pin`, { pinned }); applyList(data.data); }
    catch (e) { Alert.alert('Failed', errorMessage(e)); }
  };
  const transferSymbol = async (targetId) => {
    if (!transfer || !activeList) return;
    const { mode, itemId } = transfer;
    try {
      const { data } = await api.post(`/watchlists/${activeList._id}/items/${itemId}/${mode === 'move' ? 'move' : 'copy'}`, { targetWatchlistId: targetId });
      applyList(data.data.source); applyList(data.data.target);
    } catch (e) { Alert.alert('Failed', errorMessage(e)); }
    setTransfer(null);
  };

  const onRefresh = async () => { setRefreshing(true); await Promise.all([loadWatchlists(), loadInstruments()]); setRefreshing(false); };

  const canDelete = (watchlists || []).length > 1;

  // ── Render states ──
  if (watchlists == null) return <Loader label="Loading your watchlists…" />;
  if (err && watchlists.length === 0) return <Empty title="Couldn't load watchlists" sub={err} />;

  // First-run: no lists yet → invite create.
  if (watchlists.length === 0) {
    return (
      <View style={styles.firstRun}>
        <WatchlistIllustration c={c} />
        <Text style={styles.emptyTitle}>Create your first watchlist</Text>
        <Text style={styles.emptySub}>Organize trading pairs into custom lists like Favorites, Scalping, or Futures.</Text>
        <Button title="+ New Watchlist" style={{ marginTop: 18, paddingHorizontal: 24 }} onPress={() => setShowCreate(true)} />
        <ListFormModal visible={showCreate} onClose={() => setShowCreate(false)} onSubmit={handleCreate} styles={styles} c={c} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.h1}>My Watchlists</Text>
        <TouchableOpacity style={styles.newBtn} activeOpacity={0.85} onPress={() => setShowCreate(true)}>
          <Ionicons name="add" size={18} color={c.white} />
          <Text style={styles.newBtnTxt}>New List</Text>
        </TouchableOpacity>
      </View>

      {/* Sticky horizontal list-tabs */}
      <View style={styles.tabsBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabsScroll}>
          {watchlists.map((l) => (
            <ListTab
              key={l._id}
              list={l}
              active={l._id === activeId}
              onPress={() => (l._id === activeId ? setMobileActions(l) : selectList(l._id))}
              styles={styles}
              c={c}
            />
          ))}
        </ScrollView>
      </View>

      {/* Active-list header + Add */}
      <View style={styles.activeHead}>
        <Text style={styles.activeEmoji}>{activeList?.emoji || '📋'}</Text>
        <Text style={styles.activeName} numberOfLines={1}>{activeList?.name}</Text>
        <Text style={styles.activeCount}>{items.length}</Text>
        <TouchableOpacity style={styles.addBtn} activeOpacity={0.8} onPress={() => setShowAdd(true)}>
          <Ionicons name="add" size={16} color={c.primary500} />
          <Text style={styles.addBtnTxt}>Add Symbol</Text>
        </TouchableOpacity>
      </View>

      {/* Symbol rows / empty state */}
      <View style={{ flex: 1 }}>
        {items.length === 0 ? (
          <EmptyList onAdd={() => setShowAdd(true)} styles={styles} c={c} />
        ) : (
          <FlashList
            data={items}
            keyExtractor={(it) => it._id}
            extraData={[priceMap, extra, c]}
            estimatedItemSize={64}
            contentContainerStyle={{ paddingBottom: 24 }}
            ItemSeparatorComponent={() => <View style={styles.sep} />}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary500} />}
            renderItem={({ item }) => {
              const row = rowFor(item.symbol);
              const instrument = row || { symbol: item.symbol };
              return (
                <SymbolRow
                  item={item}
                  row={row}
                  onOpen={() => navigation.navigate('InstrumentDetail', { instrument })}
                  onTrade={() => navigation.navigate('OrderTicket', { instrument, side: 'BUY' })}
                  onMenu={() => setMenuItem(item)}
                  styles={styles}
                  c={c}
                />
              );
            }}
          />
        )}
      </View>

      {/* Bottom-sheets */}
      <ListFormModal visible={showCreate} onClose={() => setShowCreate(false)} onSubmit={handleCreate} styles={styles} c={c} />
      <ListFormModal visible={!!renameTarget} onClose={() => setRenameTarget(null)} initial={renameTarget} onSubmit={handleRename} styles={styles} c={c} />
      <ConfirmDeleteModal visible={!!deleteTarget} onClose={() => setDeleteTarget(null)} list={deleteTarget} onConfirm={handleDelete} styles={styles} c={c} />
      <AddSymbolsModal
        visible={showAdd}
        onClose={() => setShowAdd(false)}
        instruments={instruments}
        existingSymbols={items.map((it) => it.symbol)}
        onAdd={handleBulkAdd}
        styles={styles}
        c={c}
      />
      <ListPickerModal
        visible={!!transfer}
        onClose={() => setTransfer(null)}
        title={transfer?.mode === 'move' ? 'Move to watchlist' : 'Copy to watchlist'}
        lists={watchlists}
        excludeId={activeList?._id}
        onPick={transferSymbol}
        styles={styles}
        c={c}
      />
      <ListActionsSheet
        list={mobileActions}
        canDelete={canDelete}
        onClose={() => setMobileActions(null)}
        onRename={() => setRenameTarget(mobileActions)}
        onDuplicate={() => mobileActions && handleDuplicate(mobileActions._id)}
        onDelete={() => setDeleteTarget(mobileActions)}
        styles={styles}
        c={c}
      />
      <RowMenuSheet
        item={menuItem}
        onClose={() => setMenuItem(null)}
        onPin={() => menuItem && pinSymbol(menuItem._id, !menuItem.pinned)}
        onMove={() => menuItem && setTransfer({ mode: 'move', itemId: menuItem._id })}
        onCopy={() => menuItem && setTransfer({ mode: 'copy', itemId: menuItem._id })}
        onRemove={() => menuItem && removeSymbol(menuItem._id)}
        styles={styles}
        c={c}
      />
    </View>
  );
}

const makeStyles = (c) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },

  // Header
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10 },
  h1: { flex: 1, fontSize: 22, fontWeight: '900', color: c.textPrimary },
  newBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: c.primary500, borderRadius: radius.md, paddingLeft: 12, paddingRight: 14, paddingVertical: 9 },
  newBtnTxt: { color: c.white, fontWeight: '800', fontSize: 14 },

  // Sticky tabs
  tabsBar: { borderBottomWidth: 1, borderBottomColor: c.borderSubtle, backgroundColor: c.bg },
  tabsScroll: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 13, paddingRight: 11, paddingVertical: 9, borderRadius: radius.pill, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, marginRight: 8 },
  tabOn: { backgroundColor: c.primary500, borderColor: c.primary500 },
  tabDot: { width: 8, height: 8, borderRadius: 4 },
  tabEmoji: { fontSize: 14 },
  tabName: { fontSize: 13, fontWeight: '700', color: c.textSecondary, maxWidth: 140 },
  tabNameOn: { color: c.white },
  tabCount: { minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: c.hover },
  tabCountOn: { backgroundColor: 'rgba(255,255,255,0.25)' },
  tabCountTxt: { fontSize: 10, fontWeight: '800', color: c.textMuted },
  tabCountTxtOn: { color: c.white },

  // Active-list header
  activeHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  activeEmoji: { fontSize: 22 },
  activeName: { flex: 1, fontSize: 17, fontWeight: '800', color: c.textPrimary },
  activeCount: { fontSize: 13, fontWeight: '800', color: c.textMuted, fontVariant: ['tabular-nums'] },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: c.primary500, borderRadius: radius.md, paddingLeft: 8, paddingRight: 11, paddingVertical: 7 },
  addBtnTxt: { fontSize: 13, fontWeight: '800', color: c.primary500 },

  // Symbol rows
  sep: { height: 1, backgroundColor: c.borderSubtle, marginLeft: 16 },
  symRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, backgroundColor: c.bg },
  symMain: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 },
  symText: { flex: 1, minWidth: 0 },
  symName: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
  symSub: { fontSize: 11, color: c.textMuted, marginTop: 1 },
  spark: { marginHorizontal: 4 },
  symRight: { alignItems: 'flex-end', width: 70, marginLeft: 2 },
  symPrice: { fontSize: 14, fontWeight: '800', color: c.textPrimary, fontVariant: ['tabular-nums'] },
  symChg: { fontSize: 11, fontWeight: '800', marginTop: 2, fontVariant: ['tabular-nums'] },
  tradeBtn: { backgroundColor: c.primary500, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 6, marginLeft: 8 },
  tradeTxt: { color: c.white, fontSize: 12, fontWeight: '800' },
  menuBtn: { paddingHorizontal: 4, paddingVertical: 4, marginLeft: 2 },

  // Empty states
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, paddingBottom: 40 },
  firstRun: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, backgroundColor: c.bg },
  emptyTitle: { marginTop: 14, fontSize: 17, fontWeight: '800', color: c.textPrimary, textAlign: 'center' },
  emptySub: { marginTop: 6, fontSize: 13, color: c.textSecondary, textAlign: 'center', lineHeight: 19 },

  // Bottom-sheet shell
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  sheetBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { backgroundColor: c.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 28 },
  sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: c.border, marginBottom: 10 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  sheetTitle: { flex: 1, marginRight: 12, fontSize: 16, fontWeight: '800', color: c.textPrimary },
  sheetBody: { fontSize: 14, color: c.textSecondary, lineHeight: 20 },

  // List-form fields
  fieldLabel: { fontSize: 11, fontWeight: '800', color: c.textMuted, letterSpacing: 0.6, marginTop: 12, marginBottom: 8 },
  emojiWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  emojiBtn: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border, backgroundColor: c.bg },
  emojiBtnOn: { borderColor: c.primary500, backgroundColor: c.primarySoft },
  colorWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  colorBtn: { width: 34, height: 34, borderRadius: 17, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  colorBtnOn: { borderColor: c.primary500 },
  input: { height: 46, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, fontSize: 15, color: c.textPrimary, backgroundColor: c.bg },

  // Add-symbols search
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, backgroundColor: c.bg },
  searchInput: { flex: 1, fontSize: 15, color: c.textPrimary, padding: 0 },
  resultsBox: { height: 330, marginTop: 12, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, overflow: 'hidden' },
  sepInset: { height: 1, backgroundColor: c.borderSubtle, marginLeft: 54 },
  noMatch: { fontSize: 13, color: c.textMuted, textAlign: 'center', paddingVertical: 36 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 10 },
  pickSym: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
  pickName: { fontSize: 11, color: c.textMuted, marginTop: 1 },
  checkbox: { width: 20, height: 20, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  checkboxOn: { backgroundColor: c.primary500, borderColor: c.primary500 },

  // List picker
  pickListRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 13, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, marginBottom: 8 },
  pickListName: { flex: 1, fontSize: 14, fontWeight: '700', color: c.textPrimary },
  pickListCount: { fontSize: 12, fontWeight: '700', color: c.textMuted },

  // Action rows (list + row sheets)
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 4 },
  actionTxt: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
  divider: { height: 1, backgroundColor: c.borderSubtle, marginVertical: 4 },
});
