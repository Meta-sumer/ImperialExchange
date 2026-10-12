import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, RefreshControl, StyleSheet, Share, Alert,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Ionicons } from '@expo/vector-icons';
import { api, errorMessage } from '../services/api';
import { useColors, radius, fmtNum } from '../theme';
import { Loader, Empty } from '../components/ui';
import { useAuth } from '../store/auth';

/**
 * HistoryScreen — native port of the web client's Orders (Trade History) page
 * (client/src/pages/Orders.jsx). Mirrors it section-for-section, adapted to a
 * single mobile stack (its responsive tables become cards):
 *   • header            — TRADE HISTORY + (total) count
 *   • account chip      — Selected Account: ID picker + TYPE filter (ALL/REAL/DEMO)
 *   • collapsible Filters — Symbol · Side · Status (close reason) · Date range · Clear
 *   • trades list       — FlashList of cards (Order ID · Symbol · Side · Size ·
 *                         Open/Close price · Commission · Charge · Executed By ·
 *                         Remarks · opened/closed times · P/L) → tap opens InstrumentDetail
 *   • pagination footer — "Showing X of Y" + Prev / page / Next
 *   • summary strip     — Total Trades · Total Lot · Loaded Wins · Loaded Losses · Net P/L
 *
 * Data + filters use the SAME backend the web calls: /user/accounts and
 * /trading/positions/history (accountId | accountIds CSV, symbol, side,
 * closeReason, from, to, page, limit → { items, summary, pagination }).
 *
 * Native adaptations of the web:
 *   • Tailwind classes            → makeStyles(c) + useColors()
 *   • <select> pickers            → segmented pill rows (PillGroup)
 *   • DateFilter popover          → preset pills + a YYYY-MM-DD custom range
 *                                   (no native date-picker dep installed)
 *   • CSV "Download Report" <a>   → RN core Share of the CSV string ("Share Report")
 *   • <Link>/useNavigate          → navigation.navigate('InstrumentDetail', …)
 */

// Status = how a closed trade ended (its close reason). Values match the
// backend whitelist; labels mirror the "Remarks" column. (verbatim from web)
const STATUS_OPTIONS = [
  { value: '',                 label: 'All statuses' },
  { value: 'MANUAL',           label: 'Manual close' },
  { value: 'ADMIN',            label: 'Closed by admin' },
  { value: 'TAKE_PROFIT',      label: 'Take Profit' },
  { value: 'STOP_LOSS',        label: 'Stop Loss' },
  { value: 'TRAILING_STOP',    label: 'Trailing Stop' },
  { value: 'STOP_OUT',         label: 'Stop-out' },
  { value: 'MARGIN_STOPOUT',   label: 'Margin Stop-out (legacy)' },
  { value: 'NEGATIVE_BALANCE', label: 'Neg-balance Protection' },
];
const STATUS_PILLS = STATUS_OPTIONS.map((o) => ({ key: o.value, label: o.label }));
const TYPE_PILLS = [
  { key: 'all', label: 'ALL' },
  { key: 'REAL', label: 'REAL' },
  { key: 'DEMO', label: 'DEMO' },
];
const SIDE_PILLS = [
  { key: '', label: 'All' },
  { key: 'BUY', label: 'BUY' },
  { key: 'SELL', label: 'SELL' },
];

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ─── Pure helpers (module scope — never reference a free `c` / `styles`) ─────

const pad = (n) => String(n).padStart(2, '0');
const toYMD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isYMD = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// Concrete { period, fromDate, toDate } per preset (mirrors DateFilter.computeRange).
function computeRange(period) {
  const now = new Date();
  const end = toYMD(now);
  if (period === 'today') return { period: 'today', fromDate: end, toDate: end };
  if (period === '30d') { const f = new Date(now); f.setDate(f.getDate() - 29); return { period: '30d', fromDate: toYMD(f), toDate: end }; }
  if (period === '7d') { const f = new Date(now); f.setDate(f.getDate() - 6); return { period: '7d', fromDate: toYMD(f), toDate: end }; }
  return { period: null, fromDate: '', toDate: '' }; // all-time / no filter
}
function fmtRange(a, b) {
  const f = (s) => { if (!s) return '?'; const [y, m, d] = s.split('-'); return `${d} ${MON[+m - 1]} ${y}`; };
  return `${f(a)} – ${f(b)}`;
}

/**
 * The order ticket a user sees — last 6 hex characters of the id, upper-cased.
 * Mirrors client/src/utils/ticket.js and backend/src/utils/ticket.js.
 *
 * This used to convert the last 8 hex characters to decimal ("694807545"), a
 * rendering no other screen used, so a trade here could not be matched against
 * the trade screen, the wallet ledger or support's admin view.
 */
function ticketShort(id) {
  return id ? `#${String(id).slice(-6).toUpperCase()}` : '—';
}

// Lot sizes can be fractional (e.g. 0.001) → widen precision for small sizes.
function fmtLot(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n) || n === 0) return '0.00';
  const abs = Math.abs(n);
  const decimals = abs >= 0.01 ? 2 : abs >= 0.001 ? 3 : abs >= 0.0001 ? 4 : 5;
  return n.toFixed(decimals);
}

function formatDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const dd = pad(d.getDate());
  const mm = pad(d.getMonth() + 1);
  const yy = d.getFullYear();
  let h = d.getHours();
  const m = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${dd}/${mm}/${yy}, ${pad(h)}:${m}:${s} ${ampm}`;
}

function remarkText(reason) {
  switch (reason) {
    case 'TAKE_PROFIT':      return 'PROFIT TAKEN — Target hit';
    case 'STOP_LOSS':        return 'STOP LOSS HIT';
    case 'TRAILING_STOP':    return 'TRAILING STOP HIT';
    case 'STOP_OUT':
    case 'MARGIN_STOPOUT':   return 'CLOSED — Stop-out';
    case 'EXPIRY':           return 'CLOSED — Expired';
    case 'INTRADAY_SQUAREOFF': return 'CLOSED — Intraday square-off';
    case 'INSTRUMENT_DISABLED_FORCE_CLOSE': return 'CLOSED — Instrument disabled';
    case 'COPY_MASTER_CLOSED': return 'CLOSED — Master closed';
    case 'NEGATIVE_BALANCE': return 'NEG-BALANCE PROTECTION';
    case 'MANUAL':           return 'closed by user';
    case 'ADMIN':            return 'closed by admin';
    default:                 return 'N/A';
  }
}

// Deterministic tile colour per symbol (recognisable badge without a logo CDN).
const BADGE_PALETTE = ['#2563EB', '#7C3AED', '#0891B2', '#16A34A', '#EA580C', '#DB2777', '#0D9488', '#CA8A04', '#DC2626', '#4F46E5', '#0EA5E9', '#9333EA'];
function tintFor(key) {
  let h = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return BADGE_PALETTE[h % BADGE_PALETTE.length];
}

// Build the trade-history CSV (verbatim structure from the web downloadReport).
function buildCsv({ items, user, selectedAccountId, filteredAccounts, account, typeFilter, fromDate, toDate, symbolFilter, sideFilter, statusFilter }) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const row = (cells) => cells.map(q).join(',');

  const downloadedAt = new Date();
  const userName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || '—';
  const accountLabel = selectedAccountId === 'all'
    ? `All accounts (${filteredAccounts.length})`
    : (account?.accountNumber || selectedAccountId);
  const typeLabel = typeFilter === 'all' ? 'All' : typeFilter;

  const metaLines = [
    row(['Trade History Report']),
    row([]),
    row(['Generated at',  downloadedAt.toLocaleString()]),
    row(['Generated by',  userName]),
    row(['Email',         user?.email || '—']),
    row(['Phone',         user?.phone || user?.mobile || '—']),
    row(['Account',       accountLabel]),
    row(['Account type',  typeLabel]),
    row(['Date range',    fromDate || toDate ? `${fromDate || '—'} - ${toDate || '—'}` : 'All time']),
    row(['Symbol filter', symbolFilter || 'Any']),
    row(['Side filter',   sideFilter || 'Any']),
    row(['Status filter', STATUS_OPTIONS.find((o) => o.value === statusFilter)?.label || 'Any']),
    row(['Rows in file',  items.length]),
    row([]),
  ];

  const headers = [
    'Order ID', 'Symbol', 'Side', 'Size', 'Open Price', 'Close Price',
    'Commission', 'Charge', 'Executed By', 'Remarks', 'Opened At', 'Closed At', 'P/L',
  ];
  const dataRows = items.map((p) => [
    ticketShort(p._id),
    p.symbol,
    p.side,
    Number(p.closedQuantity) > 0 ? p.closedQuantity : p.quantity,
    p.entryPrice,
    p.closePrice || '',
    p.commission || '0',
    p.swap || '0',
    p.closeReason === 'ADMIN' ? 'ADMIN' : 'SELF',
    remarkText(p.closeReason),
    formatDateTime(p.openedAt || p.createdAt),
    formatDateTime(p.closedAt),
    p.realizedPnl,
  ]);

  return ['﻿' + [...metaLines, row(headers), ...dataRows.map(row)].join('\n')].join('');
}

// ─── Presentational pieces (receive styles / c via props — no module `c`) ───

function PillGroup({ options, value, onChange, styles, c }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.pillRow}
    >
      {options.map((o) => {
        const on = value === o.key;
        return (
          <TouchableOpacity
            key={o.label}
            activeOpacity={0.8}
            onPress={() => onChange(o.key)}
            style={[styles.pill, on && styles.pillOn]}
          >
            <Text style={[styles.pillTxt, on && styles.pillTxtOn]} numberOfLines={1}>{o.label}</Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

// Native adaptation of the web DateFilter: preset pills + a YYYY-MM-DD custom range.
function DateRange({ value, onChange, styles, c }) {
  const [open, setOpen] = useState(false);
  const [df, setDf] = useState(value?.fromDate || '');
  const [dt, setDt] = useState(value?.toDate || '');

  const isCustom = value?.period === 'custom';
  const cur = value?.period == null ? '__all' : value.period;
  const presets = [
    { key: '__all', label: 'All time' },
    { key: 'today', label: 'Today' },
    { key: '7d', label: '7 Days' },
    { key: '30d', label: '30 Days' },
  ];

  const pick = (k) => { setOpen(false); onChange(computeRange(k === '__all' ? null : k)); };
  const toggleCustom = () => { setDf(value?.fromDate || ''); setDt(value?.toDate || ''); setOpen((o) => !o); };
  const apply = () => { if (!isYMD(df) || !isYMD(dt)) return; onChange({ period: 'custom', fromDate: df, toDate: dt }); setOpen(false); };

  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.pillRow}>
        {presets.map((p) => {
          const on = cur === p.key;
          return (
            <TouchableOpacity key={p.key} activeOpacity={0.8} onPress={() => pick(p.key)} style={[styles.pill, on && styles.pillOn]}>
              <Text style={[styles.pillTxt, on && styles.pillTxtOn]}>{p.label}</Text>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity activeOpacity={0.8} onPress={toggleCustom} style={[styles.pill, isCustom && styles.pillOn]}>
          <Text style={[styles.pillTxt, isCustom && styles.pillTxtOn]}>
            {isCustom && value?.fromDate && value?.toDate ? fmtRange(value.fromDate, value.toDate) : 'Custom ▾'}
          </Text>
        </TouchableOpacity>
      </ScrollView>

      {open && (
        <View style={styles.customPanel}>
          <Text style={styles.customTitle}>CUSTOM RANGE</Text>
          <Text style={styles.customInputLabel}>Start date</Text>
          <TextInput
            value={df}
            onChangeText={setDf}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={c.textMuted}
            autoCapitalize="none"
            style={styles.input}
          />
          <Text style={[styles.customInputLabel, { marginTop: 8 }]}>End date</Text>
          <TextInput
            value={dt}
            onChangeText={setDt}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={c.textMuted}
            autoCapitalize="none"
            style={styles.input}
          />
          <View style={styles.customBtns}>
            <TouchableOpacity onPress={() => setOpen(false)} style={styles.customCancel}>
              <Text style={styles.customCancelTxt}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={apply} disabled={!isYMD(df) || !isYMD(dt)} style={[styles.customApply, (!isYMD(df) || !isYMD(dt)) && { opacity: 0.4 }]}>
              <Text style={styles.customApplyTxt}>Apply</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

function SymbolBadge({ symbol, size = 34, styles, c }) {
  const tint = tintFor(symbol);
  return (
    <View style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), backgroundColor: tint + '22', alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: tint, fontWeight: '800', fontSize: Math.round(size * 0.36) }}>{String(symbol || '?').slice(0, 2).toUpperCase()}</Text>
    </View>
  );
}

function SidePill({ side, styles, c }) {
  const buy = side === 'BUY';
  return (
    <View style={[styles.sidePill, { backgroundColor: buy ? c.bullSoft : c.bearSoft, borderColor: (buy ? c.bull : c.bear) + '55' }]}>
      <Text style={[styles.sidePillTxt, { color: buy ? c.bull : c.bear }]}>{buy ? '↗' : '↙'} {side}</Text>
    </View>
  );
}

function ExecutedByPill({ reason, styles, c }) {
  // ADMIN close-reason = an admin force-closed this position → ADMIN, else SELF.
  const admin = reason === 'ADMIN';
  const col = admin ? '#D97706' : c.primary500;
  return (
    <View style={[styles.execPill, { backgroundColor: col + '22', borderColor: col + '55' }]}>
      <Text style={[styles.execPillTxt, { color: col }]}>{admin ? 'ADMIN' : 'SELF'}</Text>
    </View>
  );
}

function KV({ label, value, muted, styles, c }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={[styles.kvValue, muted && { color: c.textMuted }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function StatCard({ label, value, positive, negative, highlight, styles, c }) {
  const border = highlight && negative ? c.bear : highlight && positive ? c.bull : c.border;
  const valueColor = positive ? c.bull : negative ? c.bear : c.textPrimary;
  return (
    <View style={[styles.statCard, { borderColor: border }]}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, { color: valueColor }]}>{value}</Text>
    </View>
  );
}

function TradeCard({ item: p, onPress, styles, c }) {
  const pnl = Number(p.realizedPnl || 0);
  const size = Number(p.closedQuantity) > 0 ? p.closedQuantity : p.quantity;
  return (
    <TouchableOpacity activeOpacity={0.7} onPress={onPress} style={styles.tradeCard}>
      {/* Order id + symbol · P/L */}
      <View style={styles.tcTop}>
        <View style={styles.tcId}>
          <SymbolBadge symbol={p.symbol} styles={styles} c={c} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.tcSym} numberOfLines={1}>{p.symbol}</Text>
            <Text style={styles.tcOrder} numberOfLines={1}>Order {ticketShort(p._id)}</Text>
          </View>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[styles.tcPnl, { color: pnl >= 0 ? c.bull : c.bear }]}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}</Text>
          <Text style={styles.tcPnlCap}>P/L</Text>
        </View>
      </View>

      {/* Side + Executed-by */}
      <View style={styles.tcPills}>
        <SidePill side={p.side} styles={styles} c={c} />
        <ExecutedByPill reason={p.closeReason} styles={styles} c={c} />
      </View>

      {/* Size / prices / fees */}
      <View style={styles.tcGrid}>
        <KV label="Size" value={fmtLot(size)} styles={styles} c={c} />
        <KV label="Open Price" value={fmtNum(p.entryPrice, 5)} styles={styles} c={c} />
        <KV label="Close Price" value={p.closePrice ? fmtNum(p.closePrice, 5) : '-'} styles={styles} c={c} />
        <KV label="Commission" value={fmtNum(p.commission || '0', 2)} muted styles={styles} c={c} />
        <KV label="Charge" value={fmtNum(p.swap || '0', 2)} muted styles={styles} c={c} />
      </View>

      {/* Remarks */}
      <Text style={styles.tcRemark} numberOfLines={2}>{remarkText(p.closeReason)}</Text>

      {/* Opened / Closed */}
      <View style={styles.tcTimes}>
        <View style={{ flex: 1 }}>
          <Text style={styles.tcTimeLabel}>OPENED</Text>
          <Text style={styles.tcTimeVal}>{formatDateTime(p.openedAt || p.createdAt)}</Text>
        </View>
        <View style={{ flex: 1, alignItems: 'flex-end' }}>
          <Text style={styles.tcTimeLabel}>CLOSED</Text>
          <Text style={styles.tcTimeVal}>{formatDateTime(p.closedAt)}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

// Pagination footer + summary stat strip (rides in the list footer).
function Footer({ items, pagination, page, setPage, summary, styles, c }) {
  const canPrev = page > 1;
  const canNext = page < pagination.pages;
  return (
    <View style={styles.footer}>
      <View style={styles.pagerRow}>
        <Text style={styles.showing}>Showing {items.length} of {pagination.total} trades</Text>
        {pagination.pages > 1 && (
          <View style={styles.pager}>
            <TouchableOpacity disabled={!canPrev} onPress={() => setPage((p) => Math.max(1, p - 1))} style={[styles.pagerBtn, !canPrev && { opacity: 0.3 }]}>
              <Text style={styles.pagerTxt}>◀ Prev</Text>
            </TouchableOpacity>
            <Text style={styles.pagerPage}>{page} / {pagination.pages}</Text>
            <TouchableOpacity disabled={!canNext} onPress={() => setPage((p) => Math.min(pagination.pages, p + 1))} style={[styles.pagerBtn, !canNext && { opacity: 0.3 }]}>
              <Text style={styles.pagerTxt}>Next ▶</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.statStrip}>
        <StatCard label="Total Trades" value={Number(summary.totalTrades || 0).toFixed(2)} styles={styles} c={c} />
        <StatCard label="Total Lot" value={Number(summary.totalLot || 0).toFixed(2)} styles={styles} c={c} />
        <StatCard label="Loaded Wins" value={Number(summary.wins || 0).toFixed(2)} positive styles={styles} c={c} />
        <StatCard label="Loaded Losses" value={Number(summary.losses || 0).toFixed(2)} negative styles={styles} c={c} />
        <StatCard
          label="Net P/L"
          value={`${Number(summary.netPnl || 0) >= 0 ? '+' : ''}${Number(summary.netPnl || 0).toFixed(2)}`}
          positive={Number(summary.netPnl || 0) > 0}
          negative={Number(summary.netPnl || 0) < 0}
          highlight
          styles={styles}
          c={c}
        />
      </ScrollView>
    </View>
  );
}

// ─── Screen ─────────────────────────────────────────────────────────────────
export default function HistoryScreen({ navigation }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const user = useAuth((s) => s.user);

  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState('all'); // 'all' sentinel
  const [typeFilter, setTypeFilter] = useState('all');               // all | REAL | DEMO
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState({ totalTrades: 0, totalLot: 0, netPnl: 0, wins: 0, losses: 0 });
  const [pagination, setPagination] = useState({ page: 1, limit: 30, total: 0, pages: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState('');

  // Filter state (mirrors the web)
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [symbolFilter, setSymbolFilter] = useState('');
  const [sideFilter, setSideFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [range, setRange] = useState({ period: null, fromDate: '', toDate: '' });
  const fromDate = range.fromDate;
  const toDate = range.toDate;
  const [page, setPage] = useState(1);

  // Load accounts once.
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/user/accounts');
        const list = data?.data || [];
        setAccounts(list);
        if (!list.length) setLoading(false); // no accounts → drop the loader, show Empty
      } catch (_) { setLoading(false); }
    })();
  }, []);

  // Accounts narrowed by the TYPE filter (used by the ID picker + accountIds CSV).
  const filteredAccounts = useMemo(() => {
    if (typeFilter === 'all')  return accounts;
    if (typeFilter === 'DEMO') return accounts.filter((a) => a.accountType === 'DEMO' || a.accountType === 'VIRTUAL');
    if (typeFilter === 'REAL') return accounts.filter((a) => a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL');
    return accounts;
  }, [accounts, typeFilter]);

  // Snap the ID picker back to "all" if the selection drops out of the filter.
  useEffect(() => {
    if (selectedAccountId === 'all') return;
    if (!filteredAccounts.some((a) => a._id === selectedAccountId)) setSelectedAccountId('all');
  }, [filteredAccounts, selectedAccountId]);

  const account = useMemo(
    () => accounts.find((a) => a._id === selectedAccountId),
    [accounts, selectedAccountId],
  );

  // Reload history whenever filters change (same endpoint/params as the web).
  const load = useCallback(async (isRefresh) => {
    if (!accounts.length) return;
    isRefresh ? setRefreshing(true) : setLoading(true);
    try {
      const params = {
        symbol: symbolFilter || undefined,
        side: sideFilter || undefined,
        closeReason: statusFilter || undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
        page,
        limit: 30,
      };
      if (selectedAccountId !== 'all') {
        params.accountId = selectedAccountId;
      } else if (typeFilter !== 'all') {
        params.accountIds = filteredAccounts.map((a) => a._id).join(',');
      }
      const { data } = await api.get('/trading/positions/history', { params });
      setItems(data.data.items || []);
      setSummary(data.data.summary || { totalTrades: 0, totalLot: 0, netPnl: 0, wins: 0, losses: 0 });
      setPagination(data.data.pagination || { page: 1, limit: 30, total: 0, pages: 0 });
      setErr('');
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      isRefresh ? setRefreshing(false) : setLoading(false);
    }
  }, [accounts.length, symbolFilter, sideFilter, statusFilter, fromDate, toDate, page, selectedAccountId, typeFilter, filteredAccounts]);

  useEffect(() => { load(); }, [load]);

  const clearFilters = () => {
    setSymbolFilter('');
    setSideFilter('');
    setStatusFilter('');
    setRange({ period: null, fromDate: '', toDate: '' });
    setPage(1);
  };

  const onShare = async () => {
    if (!items.length) return;
    try {
      const csv = buildCsv({ items, user, selectedAccountId, filteredAccounts, account, typeFilter, fromDate, toDate, symbolFilter, sideFilter, statusFilter });
      await Share.share({ message: csv, title: 'Trade History Report' });
    } catch (e) {
      Alert.alert('Share failed', errorMessage(e));
    }
  };

  const idOptions = useMemo(
    () => [
      { key: 'all', label: 'All accounts' },
      ...filteredAccounts.map((a) => ({ key: a._id, label: a.accountNumber || String(a._id).slice(-6) })),
    ],
    [filteredAccounts],
  );

  return (
    <View style={styles.screen}>
      {/* ── Fixed header: title · account chip · filter toggles · filters panel ── */}
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <View style={styles.accent} />
          <Text style={styles.title}>TRADE HISTORY</Text>
          <Text style={styles.titleCount}>({pagination.total})</Text>
        </View>

        {/* Account chip — ID + TYPE (both selectable; "All" aggregates) */}
        <View style={styles.chip}>
          <Text style={styles.chipLabel}>SELECTED ACCOUNT</Text>
          <Text style={styles.chipSub}>Type</Text>
          <PillGroup options={TYPE_PILLS} value={typeFilter} onChange={(v) => { setTypeFilter(v); setPage(1); }} styles={styles} c={c} />
          <Text style={styles.chipSub}>Account ID</Text>
          <PillGroup options={idOptions} value={selectedAccountId} onChange={(v) => { setSelectedAccountId(v); setPage(1); }} styles={styles} c={c} />
        </View>

        {/* Actions — Filters toggle + Share Report */}
        <View style={styles.actionsRow}>
          <TouchableOpacity onPress={() => setFiltersOpen((o) => !o)} style={styles.actionBtn} activeOpacity={0.8}>
            <Ionicons name="funnel-outline" size={14} color={c.textPrimary} />
            <Text style={styles.actionTxt}>Filters</Text>
            <Ionicons name={filtersOpen ? 'chevron-up' : 'chevron-down'} size={14} color={c.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity onPress={onShare} disabled={!items.length} style={[styles.actionBtn, !items.length && { opacity: 0.4 }]} activeOpacity={0.8}>
            <Ionicons name="share-outline" size={14} color={c.textPrimary} />
            <Text style={styles.actionTxt}>Share Report</Text>
          </TouchableOpacity>
        </View>

        {/* Collapsible filters */}
        {filtersOpen && (
          <View style={styles.filtersPanel}>
            <Text style={styles.fLabel}>Symbol</Text>
            <TextInput
              value={symbolFilter}
              onChangeText={(t) => { setSymbolFilter(t.toUpperCase()); setPage(1); }}
              placeholder="e.g. XAUUSD"
              placeholderTextColor={c.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
              style={styles.input}
            />

            <Text style={[styles.fLabel, { marginTop: 12 }]}>Side</Text>
            <PillGroup options={SIDE_PILLS} value={sideFilter} onChange={(v) => { setSideFilter(v); setPage(1); }} styles={styles} c={c} />

            <Text style={[styles.fLabel, { marginTop: 12 }]}>Status</Text>
            <PillGroup options={STATUS_PILLS} value={statusFilter} onChange={(v) => { setStatusFilter(v); setPage(1); }} styles={styles} c={c} />

            <Text style={[styles.fLabel, { marginTop: 12 }]}>Date range</Text>
            <DateRange value={range} onChange={(r) => { setRange(r); setPage(1); }} styles={styles} c={c} />

            <TouchableOpacity onPress={clearFilters} style={styles.clearBtn} activeOpacity={0.8}>
              <Text style={styles.clearTxt}>Clear filters</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* ── Trades list (cards) + pagination + summary ── */}
      <View style={{ flex: 1 }}>
        <FlashList
          data={items}
          extraData={[c, loading]}
          keyExtractor={(t) => t._id}
          estimatedItemSize={210}
          contentContainerStyle={{ padding: 12, paddingBottom: 24 }}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={c.primary500} />}
          ListEmptyComponent={
            loading
              ? <Loader label="Loading trade history…" />
              : err
                ? <Empty title="Couldn't load trade history" sub={err} />
                : <Empty title="No closed trades yet" />
          }
          ListFooterComponent={<Footer items={items} pagination={pagination} page={page} setPage={setPage} summary={summary} styles={styles} c={c} />}
          renderItem={({ item }) => (
            <TradeCard
              item={item}
              onPress={() => navigation.navigate('InstrumentDetail', { instrument: { symbol: item.symbol } })}
              styles={styles}
              c={c}
            />
          )}
        />
      </View>
    </View>
  );
}

const makeStyles = (c) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },

  // Header
  header: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: c.borderSubtle, backgroundColor: c.bg },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  accent: { width: 4, height: 20, borderRadius: 2, backgroundColor: c.primary500 },
  title: { fontSize: 18, fontWeight: '900', color: c.textPrimary, letterSpacing: 0.5 },
  titleCount: { fontSize: 15, fontWeight: '600', color: c.textMuted },

  // Account chip
  chip: { marginTop: 10, backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: 12 },
  chipLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 1, color: c.primary500 },
  chipSub: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5, color: c.textMuted, marginTop: 10, marginBottom: 6 },

  // Pills (shared: TYPE / ID / Side / Status / date presets)
  pillRow: { gap: 8, paddingRight: 4 },
  pill: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg },
  pillOn: { borderColor: c.primary500, backgroundColor: c.primarySoft },
  pillTxt: { fontSize: 12, fontWeight: '700', color: c.textSecondary },
  pillTxtOn: { color: c.primary500 },

  // Action buttons
  actionsRow: { flexDirection: 'row', gap: 10, marginTop: 10 },
  actionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 40, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.card },
  actionTxt: { fontSize: 13, fontWeight: '700', color: c.textPrimary },

  // Filters panel
  filtersPanel: { marginTop: 10, backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: 12 },
  fLabel: { fontSize: 11, fontWeight: '700', color: c.textMuted, marginBottom: 6 },
  input: { height: 40, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, color: c.textPrimary, fontSize: 13, backgroundColor: c.bg },
  clearBtn: { marginTop: 14, height: 40, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  clearTxt: { fontSize: 13, fontWeight: '700', color: c.textSecondary },

  // Custom date range panel
  customPanel: { marginTop: 10, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: 12, backgroundColor: c.bg },
  customTitle: { fontSize: 10, fontWeight: '800', letterSpacing: 1, color: c.textMuted, marginBottom: 8 },
  customInputLabel: { fontSize: 11, color: c.textSecondary, marginBottom: 4 },
  customBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 12 },
  customCancel: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.md },
  customCancelTxt: { fontSize: 13, fontWeight: '700', color: c.textSecondary },
  customApply: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: radius.md, backgroundColor: c.primary500 },
  customApplyTxt: { fontSize: 13, fontWeight: '800', color: c.white },

  // Trade card
  tradeCard: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: 14 },
  tcTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  tcId: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 },
  tcSym: { fontSize: 15, fontWeight: '800', color: c.textPrimary },
  tcOrder: { fontSize: 11, color: c.textMuted, marginTop: 2, fontVariant: ['tabular-nums'] },
  tcPnl: { fontSize: 17, fontWeight: '900', fontVariant: ['tabular-nums'] },
  tcPnlCap: { fontSize: 9, fontWeight: '800', letterSpacing: 0.6, color: c.textMuted, marginTop: 1 },

  tcPills: { flexDirection: 'row', gap: 8, marginTop: 10 },
  sidePill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  sidePillTxt: { fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
  execPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  execPillTxt: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },

  tcGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  kv: { width: '30%' },
  kvLabel: { fontSize: 10, fontWeight: '700', color: c.textMuted, letterSpacing: 0.3 },
  kvValue: { fontSize: 13, fontWeight: '700', color: c.textPrimary, marginTop: 2, fontVariant: ['tabular-nums'] },

  tcRemark: { fontSize: 12, color: c.textMuted, marginTop: 12 },
  tcTimes: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.borderSubtle },
  tcTimeLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5, color: c.textMuted },
  tcTimeVal: { fontSize: 11, color: c.textSecondary, marginTop: 2, fontVariant: ['tabular-nums'] },

  // Footer (pagination + summary)
  footer: { paddingTop: 14 },
  pagerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, paddingHorizontal: 2 },
  showing: { fontSize: 12, color: c.textMuted },
  pager: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pagerBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.card },
  pagerTxt: { fontSize: 12, fontWeight: '700', color: c.textSecondary },
  pagerPage: { fontSize: 12, color: c.textMuted, fontVariant: ['tabular-nums'] },

  statStrip: { gap: 10, paddingVertical: 14, paddingRight: 4 },
  statCard: { minWidth: 130, paddingHorizontal: 14, paddingVertical: 12, borderRadius: radius.md, borderWidth: 1, backgroundColor: c.card },
  statLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.6, color: c.textMuted, textTransform: 'uppercase' },
  statValue: { fontSize: 18, fontWeight: '900', marginTop: 6, fontVariant: ['tabular-nums'] },
});
