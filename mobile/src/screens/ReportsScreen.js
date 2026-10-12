import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, RefreshControl, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, errorMessage } from '../services/api';
import { useAccounts } from '../store/account';
import { useColors, radius, fmtNum, currencySymbol } from '../theme';
import { Pill, Loader, Empty } from '../components/ui';

/**
 * ReportsScreen — native port of the web client's Reports page
 * (client/src/pages/Reports.jsx). Mirrors it section-for-section, same order,
 * same backend data:
 *   • header            (eyebrow "Analytics" · title · subtitle)
 *   • 4 summary cards    (Realized P&L · Win Rate · Winners · Losers)
 *                        — from /trading/positions/history?limit=1 → summary
 *   • 3 quick-link cards (Order History→History · Wallet Ledger→Wallet ·
 *                         Price Alerts→Alerts)
 *   • "Export your data" (account pills + From/To date filters + Orders /
 *                         Positions / Ledger CSV buttons)
 *   • "Recent Order Activity" list (Date · Symbol · Side · Type · Qty · Price ·
 *                         Status) — from /trading/orders/history, first 50.
 *
 * Native adaptations of the web:
 *   • the <select> account filter → a horizontal pill selector.
 *   • the <input type="date"> From/To → plain text fields (YYYY-MM-DD); the app
 *     doesn't bundle a native date picker.
 *   • CSV download → the app doesn't bundle expo-sharing / expo-file-system, so
 *     the three export buttons surface the same endpoints but point the user to
 *     the web dashboard (which streams the CSV blob) instead of breaking.
 */

// Default aggregate shape (matches the web's initial `stats`).
const EMPTY_STATS = { totalTrades: 0, totalLot: 0, netPnl: 0, wins: 0, losses: 0 };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Dependency-free date/time formatter (avoids Hermes Intl gaps) — mirrors the
// web's `new Date(t.createdAt).toLocaleString()` well enough for the activity list.
function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}

// Same status → colour language as the web (FILLED=bull, CANCELLED=muted,
// REJECTED=bear, everything else=warn), mapped onto the shared Pill tones.
const statusTone = (s) =>
  s === 'FILLED' ? 'bull' : s === 'CANCELLED' ? 'muted' : s === 'REJECTED' ? 'bear' : 'warn';

// Safe ISO for the export query — returns null (skip the param) on a bad date so
// a half-typed field can never throw.
const isoOrNull = (dateStr, endOfDay) => {
  const d = new Date(`${dateStr}T${endOfDay ? '23:59:59' : '00:00:00'}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// ─── Presentational pieces (receive styles / c via props — no module `c`) ──
function SummaryCard({ label, value, color, styles }) {
  return (
    <View style={styles.sumCard}>
      <Text style={styles.sumLabel}>{label}</Text>
      <Text style={[styles.sumValue, { color }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    </View>
  );
}

function QuickLink({ title, sub, onPress, styles, c }) {
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress} style={styles.quickCard}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.quickTitle}>{title} →</Text>
        <Text style={styles.quickSub}>{sub}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={c.textMuted} />
    </TouchableOpacity>
  );
}

function Meta({ label, value, align, styles }) {
  const alignStyle = align === 'center' ? { textAlign: 'center' } : align === 'right' ? { textAlign: 'right' } : null;
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={[styles.metaLabel, alignStyle]}>{label}</Text>
      <Text style={[styles.metaValue, alignStyle]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function TradeRow({ t, first, onPress, styles }) {
  const buy = t.side === 'BUY';
  const qty = t.filledQuantity || t.quantity;
  const price = t.avgFillPrice || t.price;
  return (
    <TouchableOpacity activeOpacity={0.6} onPress={onPress} style={[styles.tradeRow, !first && styles.tradeRowBordered]}>
      <View style={styles.tradeTop}>
        <View style={styles.tradeSymWrap}>
          <Text style={styles.tradeSym} numberOfLines={1}>{t.symbol}</Text>
          <Pill label={buy ? 'BUY' : 'SELL'} tone={buy ? 'bull' : 'bear'} />
        </View>
        <Pill label={t.status || '—'} tone={statusTone(t.status)} />
      </View>
      <Text style={styles.tradeDate}>{fmtDateTime(t.createdAt)}</Text>
      <View style={styles.tradeMetaRow}>
        <Meta label="Type" value={t.type || '—'} styles={styles} />
        <Meta label="Qty" value={qty != null && qty !== '' ? String(qty) : '—'} align="center" styles={styles} />
        <Meta label="Price" value={price != null && price !== '' ? String(price) : '—'} align="right" styles={styles} />
      </View>
    </TouchableOpacity>
  );
}

// ─── Screen ────────────────────────────────────────────────────────────────
export default function ReportsScreen({ navigation }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);

  // Accounts for the export filter come from the shared store (same
  // /user/accounts endpoint the web fetches), already loaded at app start.
  const accounts = useAccounts((s) => s.accounts);

  const [trades, setTrades] = useState(null); // null = still loading (like MarketsScreen)
  const [stats, setStats] = useState(EMPTY_STATS);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // ── CSV export filters (account + date range) ──
  const [expAccount, setExpAccount] = useState(''); // '' = all accounts
  const [expFrom, setExpFrom] = useState('');
  const [expTo, setExpTo] = useState('');

  const load = useCallback(async () => {
    try {
      const [oh, hist] = await Promise.all([
        api.get('/trading/orders/history'),
        // limit=1 because we only need the `summary` block, not the rows.
        api.get('/trading/positions/history', { params: { limit: 1 } }),
      ]);
      setTrades(oh.data?.data?.items ?? []);
      setStats(hist.data?.data?.summary || EMPTY_STATS);
      setErr('');
    } catch (e) {
      setErr(errorMessage(e));
      setTrades((t) => t || []);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // ── Derived summary stats (mirrors the web verbatim) ──
  const totalPnl = Number(stats?.netPnl || 0);
  const winners = Number(stats?.wins || 0);
  const losers = Number(stats?.losses || 0);
  const totalDecided = winners + losers; // ignore break-even trades in the denominator
  const winRate = totalDecided ? ((winners / totalDecided) * 100).toFixed(1) : '0';
  const pnlText = `${totalPnl >= 0 ? '+' : '-'}${currencySymbol('USD')}${fmtNum(Math.abs(totalPnl), 2)}`;

  // Same query string the web builds (URLSearchParams isn't reliable on Hermes).
  const exportParams = () => {
    const parts = [];
    if (expAccount) parts.push(`accountId=${encodeURIComponent(expAccount)}`);
    const fromIso = expFrom ? isoOrNull(expFrom, false) : null;
    const toIso = expTo ? isoOrNull(expTo, true) : null;
    if (fromIso) parts.push(`from=${encodeURIComponent(fromIso)}`);
    if (toIso) parts.push(`to=${encodeURIComponent(toIso)}`);
    return parts.length ? `?${parts.join('&')}` : '';
  };

  const onExport = (kind) => {
    // Same endpoints the web streams: /reports/export/{orders|positions|ledger}.csv
    const path = `/reports/export/${kind}.csv${exportParams()}`;
    Alert.alert(
      'Export available on web',
      `Download ${kind}.csv from the web dashboard — your account and date filters are applied there.\n\n${path}`,
      [{ text: 'OK' }],
    );
  };

  const clearFilters = () => { setExpAccount(''); setExpFrom(''); setExpTo(''); };
  const hasFilters = !!(expAccount || expFrom || expTo);

  const accountOptions = useMemo(() => [
    { id: '', label: 'All accounts' },
    ...(accounts || []).map((a) => ({
      id: a._id,
      label: `${a.nickname || a.accountNumber}${a.baseCurrency ? ` · ${a.baseCurrency}` : ''}`,
    })),
  ], [accounts]);

  if (trades == null) return <Loader label="Loading reports…" />;
  if (err && trades.length === 0) return <Empty title="Couldn't load reports" sub={err} />;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary500} />}
    >
      {/* Header (PageHero) */}
      <View>
        <Text style={styles.eyebrow}>ANALYTICS</Text>
        <Text style={styles.title}>Reports</Text>
        <Text style={styles.subtitle}>Trading activity, P&L, and historical performance across all your accounts.</Text>
      </View>

      {/* Summary cards */}
      <View style={styles.sumGrid}>
        <SummaryCard label="Realized P&L" value={pnlText} color={totalPnl >= 0 ? c.bull : c.bear} styles={styles} />
        <SummaryCard label="Win Rate" value={`${winRate}%`} color={c.textPrimary} styles={styles} />
        <SummaryCard label="Winners" value={String(winners)} color={c.bull} styles={styles} />
        <SummaryCard label="Losers" value={String(losers)} color={c.bear} styles={styles} />
      </View>

      {/* Quick links */}
      <View style={styles.quickWrap}>
        <QuickLink title="Order History" sub="All filled, cancelled, rejected orders" onPress={() => navigation.navigate('History')} styles={styles} c={c} />
        <QuickLink title="Wallet Ledger" sub="Deposits, withdrawals, fees, P&L" onPress={() => navigation.navigate('Wallet')} styles={styles} c={c} />
        <QuickLink title="Price Alerts" sub="Create custom price notifications" onPress={() => navigation.navigate('Alerts')} styles={styles} c={c} />
      </View>

      {/* CSV exports */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Export your data</Text>
        <Text style={styles.cardSub}>Download CSV files for tax or record-keeping — filter by account and date range.</Text>

        {/* Account filter (web <select> → pills) */}
        <Text style={styles.fieldLabel}>Account</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillScroll}>
          {accountOptions.map((opt) => {
            const on = expAccount === opt.id;
            return (
              <TouchableOpacity key={opt.id || 'all'} activeOpacity={0.8} onPress={() => setExpAccount(opt.id)} style={[styles.pill, on && styles.pillOn]}>
                <Text style={[styles.pillTxt, on && styles.pillTxtOn]} numberOfLines={1}>{opt.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* From / To date range (web <input type=date> → text fields) */}
        <View style={styles.dateRow}>
          <View style={styles.dateField}>
            <Text style={styles.fieldLabel}>From</Text>
            <TextInput
              value={expFrom}
              onChangeText={setExpFrom}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={c.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
          </View>
          <View style={styles.dateField}>
            <Text style={styles.fieldLabel}>To</Text>
            <TextInput
              value={expTo}
              onChangeText={setExpTo}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={c.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
          </View>
        </View>
        {hasFilters && (
          <TouchableOpacity onPress={clearFilters} style={styles.clearBtn}>
            <Text style={styles.clearTxt}>Clear filters</Text>
          </TouchableOpacity>
        )}

        {/* Downloads — each respects the filters above */}
        <View style={styles.exportRow}>
          {[['orders', 'Orders CSV'], ['positions', 'Positions CSV'], ['ledger', 'Ledger CSV']].map(([kind, label]) => (
            <TouchableOpacity key={kind} activeOpacity={0.85} onPress={() => onExport(kind)} style={styles.exportBtn}>
              <Text style={styles.exportTxt}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Recent Order Activity */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Recent Order Activity</Text>
        <View style={{ marginTop: 6 }}>
          {trades.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyTitle}>No trades yet</Text>
              <TouchableOpacity onPress={() => navigation.navigate('Trade')}>
                <Text style={styles.emptyLink}>Start trading →</Text>
              </TouchableOpacity>
            </View>
          ) : (
            trades.slice(0, 50).map((t, i) => (
              <TradeRow
                key={t._id || i}
                t={t}
                first={i === 0}
                onPress={() => navigation.navigate('InstrumentDetail', { instrument: { symbol: t.symbol } })}
                styles={styles}
              />
            ))
          )}
        </View>
      </View>
    </ScrollView>
  );
}

const makeStyles = (c) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  content: { padding: 16, paddingBottom: 32, gap: 16 },

  // Header
  eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1.5, color: c.primary500 },
  title: { fontSize: 26, fontWeight: '900', color: c.textPrimary, marginTop: 4 },
  subtitle: { fontSize: 13, color: c.textMuted, marginTop: 4, lineHeight: 18 },

  // Summary cards (2×2 grid)
  sumGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  sumCard: { flexBasis: '47%', flexGrow: 1, backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.xl, padding: 14 },
  sumLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 1, color: c.textMuted, textTransform: 'uppercase' },
  sumValue: { fontSize: 22, fontWeight: '900', marginTop: 8, fontVariant: ['tabular-nums'] },

  // Quick links
  quickWrap: { gap: 10 },
  quickCard: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.xl, padding: 16 },
  quickTitle: { fontSize: 15, fontWeight: '800', color: c.textPrimary },
  quickSub: { fontSize: 12, color: c.textMuted, marginTop: 3 },

  // Generic card
  card: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.xl, padding: 16 },
  cardTitle: { fontSize: 15, fontWeight: '800', color: c.textPrimary },
  cardSub: { fontSize: 12, color: c.textMuted, marginTop: 4, lineHeight: 17 },

  // Export filters
  fieldLabel: { fontSize: 11, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 14, marginBottom: 6 },
  pillScroll: { paddingRight: 4 },
  pill: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg, marginRight: 8, maxWidth: 220 },
  pillOn: { borderColor: c.primary500, backgroundColor: c.primarySoft },
  pillTxt: { fontSize: 13, fontWeight: '700', color: c.textSecondary },
  pillTxtOn: { color: c.primary500 },
  dateRow: { flexDirection: 'row', gap: 12 },
  dateField: { flex: 1 },
  input: { height: 44, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, backgroundColor: c.bg, paddingHorizontal: 12, color: c.textPrimary, fontSize: 14 },
  clearBtn: { marginTop: 12, alignSelf: 'flex-start' },
  clearTxt: { fontSize: 13, fontWeight: '700', color: c.textMuted },

  // Export buttons
  exportRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: c.borderSubtle },
  exportBtn: { flexGrow: 1, minWidth: 100, alignItems: 'center', justifyContent: 'center', paddingVertical: 11, paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg },
  exportTxt: { fontSize: 13, fontWeight: '800', color: c.textPrimary },

  // Recent Order Activity
  tradeRow: { paddingVertical: 12 },
  tradeRowBordered: { borderTopWidth: 1, borderTopColor: c.borderSubtle },
  tradeTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  tradeSymWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  tradeSym: { fontSize: 15, fontWeight: '800', color: c.textPrimary },
  tradeDate: { fontSize: 12, color: c.textMuted, marginTop: 6 },
  tradeMetaRow: { flexDirection: 'row', marginTop: 10, gap: 8 },
  metaLabel: { fontSize: 10, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  metaValue: { fontSize: 13, fontWeight: '700', color: c.textPrimary, marginTop: 3, fontVariant: ['tabular-nums'] },

  // Empty state
  emptyBox: { alignItems: 'center', paddingVertical: 28 },
  emptyTitle: { fontSize: 14, fontWeight: '700', color: c.textSecondary },
  emptyLink: { fontSize: 13, fontWeight: '800', color: c.primary500, marginTop: 8 },
});
