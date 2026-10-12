import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, Modal, TextInput, TouchableOpacity, Pressable, ScrollView,
  RefreshControl, Switch, KeyboardAvoidingView, Platform, Alert, StyleSheet,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { api, errorMessage } from '../services/api';
import { useColors, radius } from '../theme';
import { Card, Button, Pill, Row, Loader, Empty } from '../components/ui';

/**
 * AlertsScreen — native port of the web client's Price Alerts page
 * (client/src/pages/PriceAlerts.jsx + components/CreateAlertModal.jsx).
 * Mirrors it 1:1, adapted to native:
 *   • hero header (eyebrow · title · subtitle · "+ New Alert")
 *   • alerts list — cards carrying every web table column:
 *       Symbol + asset glyph · Direction (↑ Above / ↓ Below) · Target ·
 *       Note · Status badge (Triggered / Active / Paused) · Pause·Resume·Delete
 *   • empty state
 *   • "New Alert" → native bottom-sheet <Modal> (CreateAlertModal): searchable
 *     symbol picker, direction, target, note, repeatable.
 *
 * Hits the SAME backend endpoints the web calls:
 *   GET  /reports/alerts            list
 *   GET  /instruments               catalog (for glyph + symbol picker)
 *   POST /reports/alerts            create { symbol, direction, targetPrice, note, repeatable }
 *   DELETE /reports/alerts/:id      delete
 *   PUT  /reports/alerts/:id/toggle pause / resume (also clears trigger)
 */

// ─── Asset glyph catalog (mirrors the web AssetIcon colour language, same as
//     MarketsScreen's native AssetGlyph). Pure data + fn — safe at module scope.
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

// ─── Presentational pieces (receive styles / c via props — no module `c`) ──
function AssetGlyph({ row, size = 36 }) {
  const meta = glyphMeta(row);
  const fs = Math.round(size * (meta.glyph.length > 2 ? 0.34 : 0.42));
  return (
    <View style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), backgroundColor: meta.bg, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#FFFFFF', fontWeight: '800', fontSize: fs }}>{meta.glyph}</Text>
    </View>
  );
}

function AlertCard({ alert: a, instrument, onToggle, onDelete, onOpen, styles, c }) {
  const above = a.direction === 'ABOVE';
  const status = a.triggeredAt
    ? { label: `Triggered @ ${a.triggeredPrice}`, tone: 'bull' }
    : a.isActive
      ? { label: 'Active', tone: 'warn' }
      : { label: 'Paused', tone: 'muted' };

  return (
    <Card>
      <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <TouchableOpacity
          activeOpacity={instrument ? 0.6 : 1}
          disabled={!instrument}
          onPress={() => instrument && onOpen(instrument)}
          style={styles.symWrap}
        >
          <AssetGlyph row={instrument || { symbol: a.symbol }} size={36} />
          <Text style={styles.sym} numberOfLines={1}>{a.symbol}</Text>
        </TouchableOpacity>
        <Pill label={status.label} tone={status.tone} />
      </Row>

      <Row style={styles.metaRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.metaLabel}>Direction</Text>
          <Text style={[styles.dirValue, { color: above ? c.bull : c.bear }]}>{above ? '↑ Above' : '↓ Below'}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.metaLabel}>Target</Text>
          <Text style={styles.targetValue}>{a.targetPrice}</Text>
        </View>
      </Row>

      {a.note ? <Text style={styles.note} numberOfLines={2}>{a.note}</Text> : null}

      <Row style={styles.actions}>
        <TouchableOpacity onPress={() => onToggle(a._id)} style={styles.actionBtn} activeOpacity={0.7}>
          <Text style={styles.actionTxt}>{a.isActive ? 'Pause' : 'Resume'}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => onDelete(a._id)} style={styles.actionBtn} activeOpacity={0.7}>
          <Text style={[styles.actionTxt, { color: c.bear }]}>Delete</Text>
        </TouchableOpacity>
      </Row>
    </Card>
  );
}

// ─── New Price Alert bottom-sheet — mirrors CreateAlertModal, posts /reports/alerts
function CreateAlertModal({ instruments, onClose, onCreated, styles, c }) {
  const [form, setForm] = useState({
    symbol: instruments[0]?.symbol || '',
    direction: 'ABOVE',
    targetPrice: '',
    note: '',
    repeatable: false,
  });
  const [loading, setLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [q, setQ] = useState('');

  const selectedInst = useMemo(
    () => instruments.find((i) => i.symbol === form.symbol) || null,
    [instruments, form.symbol],
  );

  // Mirrors the web SymbolCombobox filter (symbol/name contains), capped for
  // native list perf (the web's non-virtualised dropdown caps at 300).
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const base = s
      ? instruments.filter((i) => i.symbol.toLowerCase().includes(s) || (i.name || '').toLowerCase().includes(s))
      : instruments;
    return base.slice(0, 100);
  }, [instruments, q]);

  const pick = (sym) => { setForm((f) => ({ ...f, symbol: sym })); setPickerOpen(false); setQ(''); };

  const submit = async () => {
    if (!form.symbol || !form.targetPrice) { Alert.alert('Missing info', 'Symbol and target price are required'); return; }
    setLoading(true);
    try {
      await api.post('/reports/alerts', form);
      onCreated();
    } catch (e) {
      Alert.alert('Could not create alert', errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const above = form.direction === 'ABOVE';

  return (
    <Modal visible transparent animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={styles.sheetTitle}>New Price Alert</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={styles.close}>×</Text>
            </TouchableOpacity>
          </Row>

          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {/* Symbol picker */}
            <Text style={styles.label}>Symbol</Text>
            <TouchableOpacity style={styles.pickerBtn} activeOpacity={0.7} onPress={() => setPickerOpen((o) => !o)}>
              {selectedInst ? (
                <Row style={{ gap: 8, flex: 1, minWidth: 0 }}>
                  <AssetGlyph row={selectedInst} size={22} />
                  <Text style={styles.pickerSym} numberOfLines={1}>{selectedInst.symbol}</Text>
                  {selectedInst.lastPrice != null && (
                    <Text style={styles.pickerPrice} numberOfLines={1}>({selectedInst.lastPrice})</Text>
                  )}
                </Row>
              ) : (
                <Text style={styles.pickerPlaceholder}>Select symbol</Text>
              )}
              <Text style={styles.chevron}>{pickerOpen ? '▲' : '▼'}</Text>
            </TouchableOpacity>

            {pickerOpen && (
              <View style={styles.pickerPanel}>
                <TextInput
                  value={q}
                  onChangeText={setQ}
                  placeholder="Search symbol…"
                  placeholderTextColor={c.textMuted}
                  style={styles.search}
                  autoFocus
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
                <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                  {filtered.length === 0 && <Text style={styles.noMatch}>No symbols match “{q}”</Text>}
                  {filtered.map((i) => (
                    <TouchableOpacity
                      key={i.symbol}
                      onPress={() => pick(i.symbol)}
                      style={[styles.pickRow, i.symbol === form.symbol && { backgroundColor: c.primarySoft }]}
                      activeOpacity={0.7}
                    >
                      <AssetGlyph row={i} size={22} />
                      <Text style={styles.pickRowSym} numberOfLines={1}>{i.symbol}</Text>
                      {i.lastPrice != null && <Text style={styles.pickRowPrice} numberOfLines={1}>{i.lastPrice}</Text>}
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}

            {/* Current price + use as target (mirrors the web hint row) */}
            {selectedInst && (
              <Row style={styles.priceHint}>
                <Text style={styles.hintLabel}>Current price</Text>
                <Text style={styles.hintPrice}>{selectedInst.lastPrice != null ? String(selectedInst.lastPrice) : '—'}</Text>
                {selectedInst.lastPrice != null && (
                  <TouchableOpacity onPress={() => setForm((f) => ({ ...f, targetPrice: String(selectedInst.lastPrice ?? '') }))}>
                    <Text style={styles.useTarget}>Use as target →</Text>
                  </TouchableOpacity>
                )}
              </Row>
            )}

            {/* Direction — the web <select> becomes a bull/bear segmented control */}
            <Text style={styles.label}>Direction</Text>
            <Row style={{ gap: 10 }}>
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => setForm((f) => ({ ...f, direction: 'ABOVE' }))}
                style={[styles.dirBtn, above && { borderColor: c.bull, backgroundColor: c.bullSoft }]}
              >
                <Text style={[styles.dirTxt, above && { color: c.bull }]}>↑ Above</Text>
              </TouchableOpacity>
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => setForm((f) => ({ ...f, direction: 'BELOW' }))}
                style={[styles.dirBtn, !above && { borderColor: c.bear, backgroundColor: c.bearSoft }]}
              >
                <Text style={[styles.dirTxt, !above && { color: c.bear }]}>↓ Below</Text>
              </TouchableOpacity>
            </Row>

            {/* Target price */}
            <Text style={styles.label}>Target Price</Text>
            <TextInput
              value={form.targetPrice}
              onChangeText={(t) => setForm((f) => ({ ...f, targetPrice: t }))}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={c.textMuted}
              style={styles.input}
            />

            {/* Note */}
            <Text style={styles.label}>Note (optional)</Text>
            <TextInput
              value={form.note}
              onChangeText={(t) => setForm((f) => ({ ...f, note: t }))}
              placeholder="e.g. resistance breakout"
              placeholderTextColor={c.textMuted}
              style={styles.input}
            />

            {/* Repeatable — the web checkbox becomes a native Switch */}
            <Row style={styles.switchRow}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={styles.switchLabel}>Repeatable</Text>
                <Text style={styles.switchSub}>Re-arm after each trigger</Text>
              </View>
              <Switch
                value={form.repeatable}
                onValueChange={(v) => setForm((f) => ({ ...f, repeatable: v }))}
                trackColor={{ true: c.primary500, false: c.border }}
                thumbColor="#FFFFFF"
              />
            </Row>

            <Row style={{ gap: 10, marginTop: 16 }}>
              <Button title="Cancel" variant="ghost" style={{ flex: 1 }} onPress={onClose} />
              <Button title="Create alert" style={{ flex: 1 }} loading={loading} onPress={submit} />
            </Row>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── Screen ────────────────────────────────────────────────────────────────
export default function AlertsScreen({ navigation }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const [alerts, setAlerts] = useState(null);
  const [instruments, setInstruments] = useState([]);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  // Mirrors the web refresh(): load alerts + instruments together.
  const load = useCallback(async () => {
    try {
      const [a, i] = await Promise.all([api.get('/reports/alerts'), api.get('/instruments')]);
      setAlerts(a.data?.data || []);
      setInstruments(i.data?.data || []);
      setErr('');
    } catch (e) {
      setErr(errorMessage(e));
      setAlerts((prev) => prev || []);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const instrumentBySymbol = useMemo(() => {
    const m = new Map();
    for (const i of instruments) m.set(i.symbol, i);
    return m;
  }, [instruments]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const toggle = async (id) => {
    try { await api.put(`/reports/alerts/${id}/toggle`); load(); }
    catch (e) { Alert.alert('Failed', errorMessage(e)); }
  };

  const remove = (id) => {
    Alert.alert('Delete alert', 'Delete this alert?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try { await api.delete(`/reports/alerts/${id}`); load(); }
          catch (e) { Alert.alert('Failed', errorMessage(e)); }
        },
      },
    ]);
  };

  const openInstrument = (instrument) => navigation.navigate('InstrumentDetail', { instrument });

  if (alerts == null) return <Loader label="Loading alerts…" />;
  if (err && alerts.length === 0) return <Empty title="Couldn't load alerts" sub={err} />;

  const ListHeader = (
    <View style={styles.hero}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={styles.eyebrow}>NOTIFICATIONS</Text>
        <Text style={styles.title}>Price Alerts</Text>
        <Text style={styles.sub}>Get notified the moment an instrument crosses your target price.</Text>
      </View>
      <Button title="+ New Alert" style={styles.newBtn} onPress={() => setShowCreate(true)} />
    </View>
  );

  return (
    <View style={styles.screen}>
      <FlashList
        data={alerts}
        extraData={[c, instrumentBySymbol]}
        keyExtractor={(item) => item._id}
        estimatedItemSize={150}
        contentContainerStyle={{ padding: 16, paddingBottom: 28 }}
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary500} />}
        ListHeaderComponent={ListHeader}
        ListEmptyComponent={<Empty title="No alerts yet" sub="Create an alert to get notified on price moves." />}
        renderItem={({ item }) => (
          <AlertCard
            alert={item}
            instrument={instrumentBySymbol.get(item.symbol) || null}
            onToggle={toggle}
            onDelete={remove}
            onOpen={openInstrument}
            styles={styles}
            c={c}
          />
        )}
      />

      {showCreate && (
        <CreateAlertModal
          instruments={instruments}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
          styles={styles}
          c={c}
        />
      )}
    </View>
  );
}

const makeStyles = (c) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },

  // Hero header
  hero: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 16 },
  eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, color: c.primary500 },
  title: { fontSize: 22, fontWeight: '900', color: c.textPrimary, marginTop: 3 },
  sub: { fontSize: 12.5, color: c.textMuted, marginTop: 4, lineHeight: 17 },
  newBtn: { height: 40, paddingHorizontal: 14 },

  // Alert card
  symWrap: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, paddingRight: 10 },
  sym: { fontSize: 16, fontWeight: '800', color: c.textPrimary, flexShrink: 1 },
  metaRow: { justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 14 },
  metaLabel: { fontSize: 11, color: c.textMuted, fontWeight: '600' },
  dirValue: { fontSize: 15, fontWeight: '800', marginTop: 3 },
  targetValue: { fontSize: 15, fontWeight: '800', color: c.textPrimary, marginTop: 3, fontVariant: ['tabular-nums'] },
  note: { fontSize: 13, color: c.textMuted, marginTop: 12, lineHeight: 18 },
  actions: { gap: 10, marginTop: 14 },
  actionBtn: { flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingVertical: 10, alignItems: 'center' },
  actionTxt: { fontSize: 13, fontWeight: '800', color: c.textSecondary },

  // Modal / bottom-sheet
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.card, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, borderWidth: 1, borderColor: c.border, paddingHorizontal: 18, paddingTop: 10, paddingBottom: 24, maxHeight: '90%' },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: c.border, marginBottom: 12 },
  sheetTitle: { fontSize: 17, fontWeight: '900', color: c.textPrimary },
  close: { fontSize: 26, color: c.textMuted, lineHeight: 26 },

  label: { fontSize: 12, fontWeight: '700', color: c.textSecondary, marginBottom: 6, marginTop: 14 },
  input: { height: 46, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, fontSize: 15, color: c.textPrimary, backgroundColor: c.bg },

  pickerBtn: { minHeight: 46, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: c.bg },
  pickerSym: { fontSize: 15, fontWeight: '800', color: c.textPrimary, flexShrink: 1 },
  pickerPrice: { fontSize: 13, color: c.textMuted, fontVariant: ['tabular-nums'] },
  pickerPlaceholder: { fontSize: 15, color: c.textMuted },
  chevron: { fontSize: 11, color: c.textMuted, marginLeft: 8 },

  pickerPanel: { marginTop: 8, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, overflow: 'hidden', backgroundColor: c.panel },
  search: { height: 42, paddingHorizontal: 12, fontSize: 14, color: c.textPrimary, borderBottomWidth: 1, borderBottomColor: c.borderSubtle, backgroundColor: c.bg },
  noMatch: { fontSize: 13, color: c.textMuted, textAlign: 'center', paddingVertical: 16 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  pickRowSym: { flex: 1, fontSize: 14, fontWeight: '700', color: c.textPrimary },
  pickRowPrice: { fontSize: 13, color: c.textMuted, fontVariant: ['tabular-nums'] },

  priceHint: { gap: 8, marginTop: 8, flexWrap: 'wrap' },
  hintLabel: { fontSize: 12, color: c.textMuted },
  hintPrice: { fontSize: 13, fontWeight: '800', color: c.textPrimary, fontVariant: ['tabular-nums'] },
  useTarget: { fontSize: 12, fontWeight: '800', color: c.primary500 },

  dirBtn: { flex: 1, height: 46, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg },
  dirTxt: { fontSize: 14, fontWeight: '800', color: c.textSecondary },

  switchRow: { justifyContent: 'space-between', alignItems: 'center', marginTop: 16 },
  switchLabel: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
  switchSub: { fontSize: 12, color: c.textMuted, marginTop: 2 },
});
