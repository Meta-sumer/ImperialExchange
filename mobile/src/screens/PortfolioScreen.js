import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, RefreshControl, TouchableOpacity, Image, Alert,
  AppState, PanResponder, useWindowDimensions,
} from 'react-native';
import Svg, { Path, Line, Rect, Circle, Defs, LinearGradient, Stop, G, Text as SvgText } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../services/api';
import { wsClient } from '../services/ws';
import { useColors, fmtNum, currencySymbol } from '../theme';
import { Loader, Empty, Row } from '../components/ui';

// ─── Portfolio screen — native port of the web client's Dashboard page ────
// Mirrors client/src/pages/Dashboard.jsx section-for-section:
//   Header · Equity hero (5 tiles + balance footer) · Trading summary ·
//   Portfolio chart · Accounts (expandable) · Open positions ·
//   Asset allocation (donut) · Recent Closed Trades.
// Web is responsive → we render its single-column / card layout.

// ── Pure helpers (module scope — never reference a free `c` / `styles`) ──
const isDemo = (t) => ['DEMO', 'VIRTUAL'].includes(String(t || '').toUpperCase());
const cardBase = (c) => ({ backgroundColor: c.card, borderRadius: 16, borderWidth: 1, borderColor: c.border });
const GREEN = '#16A34A';
const RED = '#DC2626';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const TIME_RANGES = [
  { id: 0, label: 'Lifetime' }, { id: 7, label: '7D' }, { id: 30, label: '30D' },
  { id: 90, label: '90D' }, { id: 365, label: '1Y' },
];
const CHART_TABS = [
  { id: 'netProfit', label: 'Net profit', type: 'area' },
  { id: 'closedOrders', label: 'Closed orders', type: 'bar' },
  { id: 'tradingVolume', label: 'Trading volume', type: 'histogram' },
  { id: 'equity', label: 'Equity', type: 'curve' },
];
const TIMEFRAMES = [
  { id: '1d', label: '1D' }, { id: '1w', label: '1W' }, { id: '1m', label: '1M' },
  { id: '3m', label: '3M' }, { id: '1y', label: '1Y' }, { id: 'all', label: 'ALL' },
];
const ALLOC_COLORS = { FOREX: '#3B82F6', INDEX: '#22C55E', COMMODITY: '#F59E0B', CRYPTO: '#8B5CF6', STOCK: '#38BDF8', OTHER: '#9CA3AF' };
const CAT_NAME = { FOREX: 'Forex', INDEX: 'Indices', COMMODITY: 'Commodities', CRYPTO: 'Crypto', STOCK: 'Stocks', OTHER: 'Other' };

// USD-first dual-currency formatter (mirrors web utils/format.js fmtMoneyBoth).
// Was India-first — rupees as the headline, dollars as an approximation — which
// disagreed with the wallets it renders: balances are USD-denominated and every
// account defaults to USD, so the converted figure was dominant and the stored
// one was the footnote.
function fmtMoneyBoth(value, sourceCurrency = 'USD', fxRate = 83, withSign = false) {
  const n = Number(value);
  if (!isFinite(n)) return { primary: '$0.00', secondary: '≈ ₹0.00 INR' };
  const sign = withSign && n > 0 ? '+' : (n < 0 ? '-' : '');
  const abs = Math.abs(n);
  const rate = Number(fxRate || 0) > 0 ? Number(fxRate) : 83;
  let usdAbs, inrAbs;
  if (sourceCurrency === 'USD') { usdAbs = abs; inrAbs = abs * rate; }
  else if (sourceCurrency === 'INR') { inrAbs = abs; usdAbs = abs / rate; }
  else return { primary: `${sign}${currencySymbol(sourceCurrency)}${fmtNum(abs, 2)}`, secondary: '' };
  return { primary: `${sign}$${fmtNum(usdAbs, 2)}`, secondary: `≈ ${sign}₹${fmtNum(inrAbs, 2)} INR` };
}

const fmtCloseTime = (d) => {
  if (!d) return '-';
  const t = new Date(d);
  if (isNaN(t.getTime())) return '-';
  let h = t.getHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(t.getDate()).padStart(2, '0')} ${MONTHS[t.getMonth()]} ${t.getFullYear()}, ${String(h).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} ${ap}`;
};

// Smooth Bézier path (Catmull-Rom) — same as the web chart.
function smoothPathFromPoints(pts) {
  if (!pts.length) return '';
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  const tension = 0.5;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const cp1x = p1.x + ((p2.x - p0.x) / 6) * tension * 2;
    const cp1y = p1.y + ((p2.y - p0.y) / 6) * tension * 2;
    const cp2x = p2.x - ((p3.x - p1.x) / 6) * tension * 2;
    const cp2y = p2.y - ((p3.y - p1.y) / 6) * tension * 2;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}
function niceStep(raw) {
  if (raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const m = raw / base;
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return nice * base;
}
function fmtAxis(n) {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}

// ── Small asset badge — instrument logo, else a category-tinted initial ──
function AssetBadge({ inst, symbol, category, size = 34 }) {
  const logo = inst?.logoUrl;
  const cat = String(category || inst?.category || 'OTHER').toUpperCase();
  const tint = ALLOC_COLORS[cat] || ALLOC_COLORS.OTHER;
  const sym = String(symbol || inst?.symbol || '?');
  if (logo) {
    return <Image source={{ uri: logo }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#0000000A' }} />;
  }
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: tint + '22' }}>
      <Text style={{ fontSize: size * 0.36, fontWeight: '800', color: tint }}>{sym.slice(0, 2).toUpperCase()}</Text>
    </View>
  );
}

// ── Horizontal segmented control (metric / timeframe tabs) ──
function Segmented({ c, options, value, onChange, size = 'md' }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={{ flexDirection: 'row', backgroundColor: c.hover, borderRadius: 10, padding: 3, borderWidth: 1, borderColor: c.borderSubtle }}>
        {options.map((o) => {
          const active = o.id === value;
          return (
            <TouchableOpacity key={String(o.id)} onPress={() => onChange(o.id)}
              style={{ paddingHorizontal: size === 'sm' ? 10 : 13, paddingVertical: 6, borderRadius: 8, backgroundColor: active ? c.card : 'transparent' }}>
              <Text style={{ fontSize: size === 'sm' ? 11 : 12, fontWeight: '700', color: active ? c.textPrimary : c.textMuted }}>{o.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </ScrollView>
  );
}

// ── Account filter pills (native replacement for the web <select>) ──
function FilterPills({ c, options, value, onChange }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 2 }}>
      {options.map((o) => {
        const active = o.k === value;
        return (
          <TouchableOpacity key={o.k} onPress={() => onChange(o.k)}
            style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: active ? c.primary500 : c.border, backgroundColor: active ? c.primarySoft : c.card }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: active ? c.primary500 : c.textSecondary }} numberOfLines={1}>{o.label}</Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

// ── Section heading (eyebrow + title + optional badge / right link) ──
function SectionHead({ c, eyebrow, title, count, rightLabel, onRight, children }) {
  return (
    <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 10 }}>
      <View style={{ flex: 1 }}>
        {eyebrow ? <Text style={{ fontSize: 10, fontWeight: '800', letterSpacing: 1.6, color: c.textMuted }}>{eyebrow.toUpperCase()}</Text> : null}
        <Row style={{ gap: 8, marginTop: 2 }}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: c.textPrimary }}>{title}</Text>
          {count != null ? (
            <View style={{ minWidth: 22, height: 18, paddingHorizontal: 6, borderRadius: 9, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 10, fontWeight: '800', color: c.primary500 }}>{count}</Text>
            </View>
          ) : null}
        </Row>
        {children}
      </View>
      {rightLabel ? (
        <TouchableOpacity onPress={onRight}><Text style={{ fontSize: 12, fontWeight: '700', color: c.primary500 }}>{rightLabel}</Text></TouchableOpacity>
      ) : null}
    </Row>
  );
}

// ── One of the three money tiles in the equity hero band ──
function PnlTile({ c, tint, iconName, label, badge, value, valueColor, secondary, pct }) {
  const pos = (pct ?? 0) >= 0;
  const hasPct = Number.isFinite(pct) && Math.abs(pct) > 0.005;
  return (
    <Row style={{ alignItems: 'flex-start', gap: 12, paddingVertical: 8 }}>
      <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: tint + '1A' }}>
        <Ionicons name={iconName} size={20} color={tint} />
      </View>
      <View style={{ flex: 1 }}>
        <Row style={{ gap: 6 }}>
          <Text style={{ fontSize: 12, fontWeight: '600', color: c.textMuted }} numberOfLines={1}>{label}</Text>
          {badge ? (
            <View style={{ backgroundColor: '#0F172A', borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1 }}>
              <Text style={{ fontSize: 8, fontWeight: '800', color: '#FFFFFF', letterSpacing: 0.5 }}>{badge}</Text>
            </View>
          ) : null}
        </Row>
        <Text style={{ fontSize: 22, fontWeight: '900', color: valueColor || c.textPrimary, marginTop: 2, fontVariant: ['tabular-nums'] }} numberOfLines={1}>{value}</Text>
        <Row style={{ gap: 6, marginTop: 2 }}>
          {secondary ? <Text style={{ fontSize: 11, color: c.textMuted, fontVariant: ['tabular-nums'] }} numberOfLines={1}>{secondary}</Text> : null}
          {hasPct ? <Text style={{ fontSize: 10, fontWeight: '800', color: pos ? GREEN : RED }}>{pos ? '▲ +' : '▼ '}{pct.toFixed(2)}%</Text> : null}
        </Row>
      </View>
    </Row>
  );
}

// ── Bordered Open / Win-Rate cells ──
function StatBox({ c, dotTint, label, value, caption }) {
  return (
    <View style={[cardBase(c), { flex: 1, padding: 12 }]}>
      <Row style={{ gap: 6 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dotTint }} />
        <Text style={{ fontSize: 10, fontWeight: '800', letterSpacing: 0.6, color: c.textMuted }} numberOfLines={1}>{String(label).toUpperCase()}</Text>
      </Row>
      <Text style={{ fontSize: 22, fontWeight: '900', color: c.textPrimary, marginTop: 4, fontVariant: ['tabular-nums'] }}>{value}</Text>
      <Text style={{ fontSize: 11, color: c.textMuted, marginTop: 2 }}>{caption}</Text>
    </View>
  );
}

// ── Trading-summary stat cell ──
function StatCell({ c, label, value, tone, emphasis }) {
  const col = tone === 'bull' ? c.bull : tone === 'bear' ? c.bear : c.textPrimary;
  return (
    <View style={{ width: '48%', marginBottom: 14 }}>
      <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.5, color: c.textMuted }}>{String(label).toUpperCase()}</Text>
      <Text style={{ fontSize: emphasis ? 20 : 16, fontWeight: '800', color: col, marginTop: 3, fontVariant: ['tabular-nums'] }}>{value}</Text>
    </View>
  );
}

// ── Full open-position card ──
function PositionCard({ c, p, onPress }) {
  const prec = Math.min(p._inst?.pricePrecision || 2, 5);
  const pnl = Number(p.unrealizedPnl || 0);
  const isWin = pnl >= 0;
  const sideBull = p.side === 'BUY';
  const qty = Number(p.quantity);
  const entry = Number(p.entryPrice);
  const mark = Number(p.markPrice || entry);
  const pnlPct = entry > 0 ? (pnl / (qty * entry)) * 100 : 0;
  const movePct = entry > 0 ? ((mark - entry) / entry) * 100 * (sideBull ? 1 : -1) : 0;
  const tone = isWin ? GREEN : RED;
  const sideTone = sideBull ? GREEN : RED;
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress} style={[cardBase(c), { padding: 14, overflow: 'hidden' }]}>
      <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: sideTone }} />
      <Row style={{ gap: 10, alignItems: 'flex-start' }}>
        <AssetBadge inst={p._inst} symbol={p.symbol} category={p.category} size={36} />
        <View style={{ flex: 1 }}>
          <Row style={{ gap: 6 }}>
            <Text style={{ fontSize: 14, fontWeight: '800', color: c.textPrimary }} numberOfLines={1}>{p.symbol}</Text>
            <View style={{ backgroundColor: sideTone + '1A', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
              <Text style={{ fontSize: 9, fontWeight: '800', color: sideTone }}>{sideBull ? '▲ LONG' : '▼ SHORT'}</Text>
            </View>
          </Row>
          <Text style={{ fontSize: 11, color: c.textMuted, marginTop: 2 }} numberOfLines={1}>
            {p._inst?.name || (p.category ? p.category.charAt(0) + p.category.slice(1).toLowerCase() : 'Position')}
          </Text>
        </View>
      </Row>
      <View style={{ marginTop: 12 }}>
        <Text style={{ fontSize: 10, fontWeight: '800', letterSpacing: 0.5, color: c.textMuted }}>UNREALISED P&L</Text>
        <Row style={{ gap: 8, marginTop: 2 }}>
          <Text style={{ fontSize: 24, fontWeight: '900', color: tone, fontVariant: ['tabular-nums'] }}>
            {isWin ? '+' : ''}{fmtNum(pnl, 2)}
          </Text>
          <View style={{ backgroundColor: tone + '1A', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2, alignSelf: 'center' }}>
            <Text style={{ fontSize: 11, fontWeight: '800', color: tone }}>{isWin ? '▲ +' : '▼ '}{pnlPct.toFixed(2)}%</Text>
          </View>
        </Row>
      </View>
      <Row style={{ marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.borderSubtle, justifyContent: 'space-between' }}>
        <View>
          <Text style={{ fontSize: 9, fontWeight: '800', letterSpacing: 0.5, color: c.textMuted }}>ENTRY</Text>
          <Text style={{ fontSize: 12, fontWeight: '700', color: c.textSecondary, marginTop: 2, fontVariant: ['tabular-nums'] }}>{fmtNum(entry, prec)}</Text>
        </View>
        <View style={{ alignItems: 'center' }}>
          <Text style={{ fontSize: 9, fontWeight: '800', color: c.textMuted }}>→</Text>
          <Text style={{ fontSize: 10, fontWeight: '800', color: movePct >= 0 ? GREEN : RED, marginTop: 2, fontVariant: ['tabular-nums'] }}>{movePct >= 0 ? '+' : ''}{movePct.toFixed(2)}%</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={{ fontSize: 9, fontWeight: '800', letterSpacing: 0.5, color: c.textMuted }}>MARK</Text>
          <Text style={{ fontSize: 12, fontWeight: '800', color: c.textPrimary, marginTop: 2, fontVariant: ['tabular-nums'] }}>{fmtNum(mark, prec)}</Text>
        </View>
      </Row>
      <Row style={{ marginTop: 8, justifyContent: 'space-between' }}>
        <Text style={{ fontSize: 10, color: c.textMuted, fontVariant: ['tabular-nums'] }}>Qty · {fmtNum(qty, 2)}</Text>
        <Row style={{ gap: 3 }}>
          <Text style={{ fontSize: 10, fontWeight: '700', color: c.primary500 }}>View chart</Text>
          <Ionicons name="arrow-forward" size={11} color={c.primary500} />
        </Row>
      </Row>
    </TouchableOpacity>
  );
}

// ── Compact position card inside an expanded account row ──
function MiniPositionCard({ c, p, cur, rate, onPress }) {
  const buy = p.side === 'BUY';
  const entry = Number(p.entryPrice);
  const mark = Number(p.markPrice || entry);
  const qty = Number(p.quantity);
  const prec = Math.min(p._inst?.pricePrecision || 2, 5);
  const pnlNative = Number(p.unrealizedPnl || 0);
  // unrealizedPnl is in the INSTRUMENT quote currency â rupees for NSE.
  const pnlUsd = cur === 'INR' && rate > 0 ? pnlNative / rate : pnlNative;
  const movePct = entry > 0 ? ((mark - entry) / entry) * 100 * (buy ? 1 : -1) : 0;
  const win = pnlUsd >= 0;
  const tone = win ? GREEN : RED;
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress} style={[cardBase(c), { padding: 12 }]}>
      <Row style={{ gap: 8 }}>
        <AssetBadge inst={p._inst} symbol={p.symbol} category={p.category} size={26} />
        <View style={{ flex: 1 }}>
          <Row style={{ gap: 6 }}>
            <Text style={{ fontSize: 12, fontWeight: '800', color: c.textPrimary }} numberOfLines={1}>{p.symbol}</Text>
            <View style={{ backgroundColor: tone + '18', borderRadius: 3, paddingHorizontal: 4, paddingVertical: 1 }}>
              <Text style={{ fontSize: 8, fontWeight: '800', color: tone }}>{buy ? '▲ Long' : '▼ Short'}</Text>
            </View>
          </Row>
          <Text style={{ fontSize: 9, color: c.textMuted }} numberOfLines={1}>{p._inst?.name || 'Position'}</Text>
        </View>
      </Row>
      <View style={{ marginTop: 8 }}>
        <Text style={{ fontSize: 9, fontWeight: '800', letterSpacing: 0.4, color: c.textMuted }}>UNREALISED P&L</Text>
        <Row style={{ gap: 6, marginTop: 2 }}>
          <Text style={{ fontSize: 16, fontWeight: '900', color: tone, fontVariant: ['tabular-nums'] }}>{win ? '+' : '-'}${fmtNum(Math.abs(pnlUsd), 2)}</Text>
          <View style={{ backgroundColor: tone + '18', borderRadius: 3, paddingHorizontal: 4, paddingVertical: 1, alignSelf: 'center' }}>
            <Text style={{ fontSize: 9, fontWeight: '800', color: tone }}>{movePct >= 0 ? '+' : ''}{movePct.toFixed(2)}%</Text>
          </View>
        </Row>
      </View>
      <Row style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: c.borderSubtle, justifyContent: 'space-between' }}>
        <View>
          <Text style={{ fontSize: 8, fontWeight: '800', color: c.textMuted }}>ENTRY</Text>
          <Text style={{ fontSize: 10, fontWeight: '700', color: c.textSecondary, fontVariant: ['tabular-nums'] }}>{fmtNum(entry, prec)}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={{ fontSize: 8, fontWeight: '800', color: c.textMuted }}>MARK</Text>
          <Text style={{ fontSize: 10, fontWeight: '800', color: c.textPrimary, fontVariant: ['tabular-nums'] }}>{fmtNum(mark, prec)}</Text>
        </View>
      </Row>
      <Row style={{ marginTop: 6, justifyContent: 'space-between' }}>
        <Text style={{ fontSize: 10, color: c.textMuted, fontVariant: ['tabular-nums'] }}>Qty {fmtNum(qty, 2)}</Text>
        <Text style={{ fontSize: 10, fontWeight: '700', color: c.primary500 }}>View Chart →</Text>
      </Row>
    </TouchableOpacity>
  );
}

// ═══════════════════ Trading summary (filterable stats) ═══════════════════
function TradingSummary({ fxRate, refreshKey }) {
  const c = useColors();
  const [accounts, setAccounts] = useState([]);
  const [days, setDays] = useState(0);
  const [accountId, setAccountId] = useState('');
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let dead = false;
    api.get('/user/accounts').then((r) => { if (!dead) setAccounts(r.data.data || []); }).catch(() => {});
    return () => { dead = true; };
  }, [refreshKey]);

  useEffect(() => {
    let dead = false;
    (async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (days) params.set('days', String(days));
        if (accountId) params.set('accountId', accountId);
        const r = await api.get(`/user/dashboard/lifetime-stats?${params.toString()}`);
        if (!dead) setStats(r.data.data);
      } catch { /* keep previous */ }
      finally { if (!dead) setLoading(false); }
    })();
    return () => { dead = true; };
  }, [days, accountId, refreshKey]);

  const sign = (n) => (n > 0 ? '+' : '') + n.toFixed(2);
  const toneOf = (n) => (n > 0 ? 'bull' : n < 0 ? 'bear' : 'neutral');
  const num = (k) => Number(stats?.[k] || 0);
  const netProfit = num('netProfit');
  const profit = num('profit');
  const loss = num('loss');
  const unrealized = num('unrealizedPnl');
  const closedOrders = Number(stats?.closedOrders || 0);
  const profitable = Number(stats?.profitable || 0);
  const unprofitable = Number(stats?.unprofitable || 0);
  const tradingVolume = num('tradingVolume');

  const rows = [
    { label: 'Net profit', value: `${sign(netProfit)} USD`, tone: toneOf(netProfit), emphasis: true },
    { label: 'Profit', value: `+${profit.toFixed(2)} USD`, tone: 'bull' },
    { label: 'Loss', value: `-${Math.abs(loss).toFixed(2)} USD`, tone: 'bear' },
    { label: 'Unrealised P/L', value: `${sign(unrealized)} USD`, tone: toneOf(unrealized) },
    { label: 'Closed orders', value: closedOrders.toLocaleString() },
    { label: 'Profitable', value: profitable.toLocaleString(), tone: 'bull' },
    { label: 'Unprofitable', value: unprofitable.toLocaleString(), tone: 'bear' },
    { label: 'Trading volume', value: `${fmtNum(tradingVolume, 2)} USD` },
  ];

  const acctOptions = [
    { k: '', label: 'All accounts' },
    ...(accounts.some((a) => !isDemo(a.accountType)) ? [{ k: 'ALL_REAL', label: 'All Real' }] : []),
    ...(accounts.some((a) => isDemo(a.accountType)) ? [{ k: 'ALL_DEMO', label: 'All Demo' }] : []),
    ...accounts.map((a) => ({ k: String(a._id), label: `${a.nickname || a.accountNumber} · ${a.baseCurrency || 'USD'}` })),
  ];

  return (
    <View style={[cardBase(c), { padding: 16 }]}>
      <Text style={{ fontSize: 10, fontWeight: '800', letterSpacing: 1.6, color: c.textMuted }}>PERFORMANCE</Text>
      <Text style={{ fontSize: 16, fontWeight: '800', color: c.textPrimary, marginTop: 2 }}>Trading summary</Text>
      <Text style={{ fontSize: 11, color: c.textMuted, marginTop: 2 }}>{loading ? 'Loading…' : 'Filter the window or pick an account to drill down'}</Text>

      <View style={{ marginTop: 12, gap: 8 }}>
        <Segmented c={c} size="sm" options={TIME_RANGES} value={days} onChange={setDays} />
        <FilterPills c={c} options={acctOptions} value={accountId} onChange={setAccountId} />
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 16 }}>
        {rows.map((r) => <StatCell key={r.label} c={c} {...r} />)}
      </View>
    </View>
  );
}

// ═══════════════════════════ Portfolio chart ═══════════════════════════
function PortfolioChart({ fxRate, refreshKey }) {
  const c = useColors();
  const { width: winW } = useWindowDimensions();
  const [buckets, setBuckets] = useState([]);
  const [tab, setTab] = useState('netProfit');
  const [range, setRange] = useState('1y');
  const [loading, setLoading] = useState(false);
  const [hoverIdx, setHoverIdx] = useState(null);
  const [sumStats, setSumStats] = useState(null);
  const geoRef = useRef({ padLeft: 0, slot: 1, n: 0 });

  useEffect(() => {
    let dead = false;
    api.get('/user/dashboard/lifetime-stats').then((r) => { if (!dead) setSumStats((p) => ({ ...(p || {}), lifetime: r.data.data })); }).catch(() => {});
    api.get('/user/dashboard').then((r) => { if (!dead) setSumStats((p) => ({ ...(p || {}), dash: r.data.data })); }).catch(() => {});
    return () => { dead = true; };
  }, [refreshKey]);

  useEffect(() => {
    let dead = false;
    (async () => {
      setLoading(true);
      try {
        const r = await api.get(`/user/dashboard/monthly-series?range=${range}`);
        if (!dead) setBuckets(r.data.data?.buckets || []);
      } catch { /* keep */ }
      finally { if (!dead) setLoading(false); }
    })();
    return () => { dead = true; };
  }, [range, refreshKey]);

  const activeTab = CHART_TABS.find((t) => t.id === tab) || CHART_TABS[0];

  const { yMax, yMin, ticks } = useMemo(() => {
    if (!buckets.length) return { yMax: 4, yMin: 0, ticks: [0, 1, 2, 3, 4] };
    const vals = buckets.map((b) => Number(b[tab] || 0));
    const minV = Math.min(0, ...vals);
    const maxV = Math.max(0, ...vals);
    const span = Math.max(Math.abs(minV), Math.abs(maxV), 4);
    const step = niceStep(span / 4);
    const top = Math.ceil(span / step) * step;
    if (minV < 0) return { yMax: top, yMin: -top, ticks: [-top, -top / 2, 0, top / 2, top] };
    return { yMax: top, yMin: 0, ticks: [0, top / 4, top / 2, (3 * top) / 4, top] };
  }, [buckets, tab]);

  // Responsive geometry — fit to the screen width.
  const W = Math.max(280, Math.round(winW) - 60);
  const H = 220;
  const PAD = { top: 14, right: 14, bottom: 26, left: 40 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const n = Math.max(1, buckets.length);
  const slot = innerW / n;
  const barW = Math.min(20, slot * 0.55);
  const yRange = (yMax - yMin) || 1;
  const yOf = (v) => PAD.top + innerH * (1 - (v - yMin) / yRange);
  const cxOf = (i) => PAD.left + slot * i + slot / 2;
  geoRef.current = { padLeft: PAD.left, slot, n: buckets.length };

  const headline = useMemo(() => {
    if (!buckets.length) return null;
    if (tab === 'equity') { const last = buckets[buckets.length - 1]?.equity ?? 0; return { value: last, fmt: 'usd' }; }
    if (tab === 'closedOrders') return { value: buckets.reduce((s, b) => s + Number(b.closedOrders || 0), 0), fmt: 'int' };
    if (tab === 'tradingVolume') return { value: buckets.reduce((s, b) => s + Number(b.tradingVolume || 0), 0), fmt: 'usd' };
    return { value: buckets.reduce((s, b) => s + Number(b.netProfit || 0), 0), fmt: 'usd' };
  }, [buckets, tab]);

  const fmtHeadline = (h) => {
    if (!h) return '—';
    if (h.fmt === 'int') return h.value.toLocaleString();
    return `${h.value >= 0 ? '' : '-'}$${fmtNum(Math.abs(h.value), 2)}`;
  };
  const headlineTone = !headline ? c.textPrimary : (tab === 'closedOrders' || tab === 'tradingVolume') ? c.textPrimary : headline.value >= 0 ? c.bull : c.bear;

  const smoothPath = useMemo(() => {
    if (!buckets.length) return '';
    return smoothPathFromPoints(buckets.map((b, i) => ({ x: cxOf(i), y: yOf(Number(b[tab] || 0)) })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, tab, yMax, yMin, W]);
  const areaPath = useMemo(() => {
    if (!smoothPath || !buckets.length) return '';
    const baseY = yOf(yMin < 0 ? 0 : yMin);
    return `${smoothPath} L ${cxOf(buckets.length - 1)} ${baseY} L ${cxOf(0)} ${baseY} Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smoothPath, buckets, yMin, yMax, W]);

  const totalNonZero = buckets.length > 0 && buckets.some((b) => Number(b[tab] || 0) !== 0);
  const hovered = hoverIdx != null ? buckets[hoverIdx] : null;

  // Inline analytics strip.
  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
  const netVals = buckets.map((b) => Number(b.netProfit || 0));
  const bestDay = netVals.length ? Math.max(...netVals) : 0;
  const worstDay = netVals.length ? Math.min(...netVals) : 0;
  const lifetime = sumStats?.lifetime;
  const dash = sumStats?.dash;
  const winRate = dash?.pnl?.winRate;
  const pfProfit = Number(lifetime?.profit ?? dash?.pnl?.profit ?? 0);
  const pfLoss = Math.abs(Number(lifetime?.loss ?? dash?.pnl?.loss ?? 0));
  const profitFactor = pfLoss > 0 ? pfProfit / pfLoss : null;
  const totalTrades = lifetime?.closedOrders ?? dash?.trades?.closedLive ?? 0;
  const STRIP = [
    { label: 'Best Day', value: `+$${fmtNum(Math.max(bestDay, 0), 2)}`, col: c.bull },
    { label: 'Worst Day', value: `${worstDay < 0 ? '-' : ''}$${fmtNum(Math.abs(worstDay), 2)}`, col: c.bear },
    { label: 'Win Rate', value: winRate != null ? `${Number(winRate).toFixed(2)}%` : '—', col: c.textPrimary },
    { label: 'Profit Factor', value: profitFactor != null ? profitFactor.toFixed(2) : '—', col: c.textPrimary },
    { label: 'Total Trades', value: String(totalTrades), col: c.textPrimary },
  ];

  // Only claim horizontal scrubs so the page's vertical scroll still works
  // when the finger passes over the chart.
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (e, g) => Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 4,
    onPanResponderGrant: (e) => setHover(e.nativeEvent.locationX),
    onPanResponderMove: (e) => setHover(e.nativeEvent.locationX),
    onPanResponderRelease: () => setHoverIdx(null),
    onPanResponderTerminate: () => setHoverIdx(null),
  })).current;
  function setHover(x) {
    const g = geoRef.current;
    if (!g.n) return;
    let i = Math.floor((x - g.padLeft) / g.slot);
    if (i < 0) i = 0; if (i > g.n - 1) i = g.n - 1;
    setHoverIdx(i);
  }

  const stride = buckets.length <= 8 ? 1 : buckets.length <= 14 ? 2 : Math.ceil(buckets.length / 8);
  const areaStroke = (headline?.value ?? 0) >= 0 ? GREEN : '#EF4444';
  const tooltipLeft = hovered ? Math.max(4, Math.min(W - 150, cxOf(hoverIdx) - 75)) : 0;

  return (
    <View style={[cardBase(c), { padding: 16 }]}>
      <Text style={{ fontSize: 10, fontWeight: '800', letterSpacing: 1.6, color: c.textMuted }}>ANALYTICS</Text>
      <Text style={{ fontSize: 24, fontWeight: '900', color: headlineTone, marginTop: 4, fontVariant: ['tabular-nums'] }}>{fmtHeadline(headline)}</Text>
      <Text style={{ fontSize: 11, color: c.textMuted, marginTop: 2 }}>{activeTab.label} · {TIMEFRAMES.find((t) => t.id === range)?.label || '—'}</Text>

      {/* Inline stat strip */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 12 }}>
        <Row style={{ borderWidth: 1, borderColor: c.borderSubtle, borderRadius: 10, overflow: 'hidden' }}>
          {STRIP.map((s, i) => (
            <View key={s.label} style={{ paddingHorizontal: 14, paddingVertical: 7, borderLeftWidth: i ? 1 : 0, borderLeftColor: c.borderSubtle, alignItems: 'center' }}>
              <Text style={{ fontSize: 10, fontWeight: '800', letterSpacing: 0.4, color: c.textMuted }}>{s.label.toUpperCase()}</Text>
              <Text style={{ fontSize: 13, fontWeight: '800', color: s.col, marginTop: 2, fontVariant: ['tabular-nums'] }}>{s.value}</Text>
            </View>
          ))}
        </Row>
      </ScrollView>

      {/* Timeframe + metric tabs */}
      <View style={{ marginTop: 12, gap: 8 }}>
        <Segmented c={c} size="sm" options={TIMEFRAMES} value={range} onChange={setRange} />
        <Segmented c={c} options={CHART_TABS} value={tab} onChange={setTab} />
      </View>

      {/* SVG chart */}
      <View style={{ marginTop: 12, width: W, alignSelf: 'center' }} {...pan.panHandlers}>
        <Svg width={W} height={H}>
          <Defs>
            <LinearGradient id="pcGreen" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0%" stopColor="#16A34A" stopOpacity="0.32" /><Stop offset="100%" stopColor="#16A34A" stopOpacity="0.02" />
            </LinearGradient>
            <LinearGradient id="pcRed" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0%" stopColor="#EF4444" stopOpacity="0.28" /><Stop offset="100%" stopColor="#EF4444" stopOpacity="0.02" />
            </LinearGradient>
            <LinearGradient id="pcBlue" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0%" stopColor="#3B82F6" stopOpacity="0.28" /><Stop offset="100%" stopColor="#3B82F6" stopOpacity="0.02" />
            </LinearGradient>
          </Defs>

          {ticks.map((v, i) => {
            const y = yOf(v);
            const isZero = Math.abs(v) < 1e-9;
            return (
              <G key={i}>
                <Line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke={isZero ? c.border : c.borderSubtle} strokeWidth={1} strokeDasharray={isZero ? undefined : [4, 4]} />
                <SvgText x={PAD.left - 6} y={y + 3} fontSize={9} fill={c.textMuted} textAnchor="end">{fmtAxis(v)}</SvgText>
              </G>
            );
          })}

          {totalNonZero && activeTab.type === 'area' && (
            <G>
              <Path d={areaPath} fill={(headline?.value ?? 0) >= 0 ? 'url(#pcGreen)' : 'url(#pcRed)'} />
              <Path d={smoothPath} fill="none" stroke={areaStroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </G>
          )}
          {totalNonZero && activeTab.type === 'curve' && (
            <G>
              <Path d={areaPath} fill="url(#pcBlue)" />
              <Path d={smoothPath} fill="none" stroke="#3B82F6" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </G>
          )}
          {totalNonZero && (activeTab.type === 'bar' || activeTab.type === 'histogram') && buckets.map((b, i) => {
            const v = Number(b[tab] || 0);
            if (!v) return null;
            const y = yOf(v), y0 = yOf(0);
            const fill = activeTab.type === 'bar' ? '#3B82F6' : (b.netProfit || 0) >= 0 ? '#16A34A' : '#EF4444';
            const dim = hoverIdx != null && hoverIdx !== i;
            return <Rect key={b.key} x={cxOf(i) - barW / 2} y={Math.min(y, y0)} width={barW} height={Math.max(2, Math.abs(y0 - y))} rx={3} fill={fill} opacity={dim ? 0.4 : activeTab.type === 'histogram' ? 0.92 : 1} />;
          })}

          {yMin < 0 && <Line x1={PAD.left} x2={W - PAD.right} y1={yOf(0)} y2={yOf(0)} stroke={c.border} strokeWidth={1} />}

          {hoverIdx != null && hovered && (
            <G>
              <Line x1={cxOf(hoverIdx)} x2={cxOf(hoverIdx)} y1={PAD.top} y2={H - PAD.bottom} stroke={c.textMuted} strokeWidth={1} strokeDasharray={[3, 4]} />
              {(activeTab.type === 'area' || activeTab.type === 'curve') && (
                <Circle cx={cxOf(hoverIdx)} cy={yOf(Number(hovered[tab] || 0))} r={5} fill={c.card} stroke={activeTab.type === 'curve' ? '#3B82F6' : areaStroke} strokeWidth={2} />
              )}
            </G>
          )}

          {buckets.map((b, i) => {
            if (i % stride !== 0 && i !== buckets.length - 1) return null;
            return <SvgText key={b.key} x={cxOf(i)} y={H - PAD.bottom + 15} fontSize={9} fill={hoverIdx === i ? c.textPrimary : c.textMuted} textAnchor="middle">{b.label}</SvgText>;
          })}
        </Svg>

        {hovered && (
          <View style={{ position: 'absolute', top: 2, left: tooltipLeft, minWidth: 140, backgroundColor: c.card, borderWidth: 1, borderColor: c.borderSubtle, borderRadius: 10, padding: 8 }}>
            <Text style={{ fontSize: 10, fontWeight: '800', color: c.textMuted }}>{hovered.label}</Text>
            {tab === 'netProfit' ? (
              <View style={{ marginTop: 4, gap: 2 }}>
                <Row style={{ justifyContent: 'space-between', gap: 12 }}><Text style={{ fontSize: 11, color: c.textSecondary }}>Profit</Text><Text style={{ fontSize: 11, fontWeight: '800', color: c.bull }}>+${fmtNum(hovered.profit, 2)}</Text></Row>
                <Row style={{ justifyContent: 'space-between', gap: 12 }}><Text style={{ fontSize: 11, color: c.textSecondary }}>Loss</Text><Text style={{ fontSize: 11, fontWeight: '800', color: c.bear }}>${fmtNum(hovered.loss, 2)}</Text></Row>
                <Row style={{ justifyContent: 'space-between', gap: 12, paddingTop: 3, borderTopWidth: 1, borderTopColor: c.borderSubtle }}><Text style={{ fontSize: 11, fontWeight: '700', color: c.textPrimary }}>Net</Text><Text style={{ fontSize: 11, fontWeight: '900', color: hovered.netProfit >= 0 ? c.bull : c.bear }}>{hovered.netProfit >= 0 ? '+' : ''}${fmtNum(hovered.netProfit, 2)}</Text></Row>
              </View>
            ) : (
              <Row style={{ justifyContent: 'space-between', gap: 12, marginTop: 4 }}>
                <Text style={{ fontSize: 11, color: c.textSecondary }}>{activeTab.label}</Text>
                <Text style={{ fontSize: 11, fontWeight: '900', color: c.textPrimary }}>{tab === 'closedOrders' ? Number(hovered.closedOrders || 0).toLocaleString() : `$${fmtNum(Number(hovered[tab] || 0), 2)}`}</Text>
              </Row>
            )}
          </View>
        )}

        {loading && buckets.length === 0 && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 12, color: c.textMuted }}>Loading…</Text></View>
        )}
        {!loading && buckets.length > 0 && !totalNonZero && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 11, color: c.textMuted, backgroundColor: c.card, borderWidth: 1, borderColor: c.borderSubtle, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, textAlign: 'center' }}>No data for this window — try a longer timeframe or another metric.</Text>
          </View>
        )}
      </View>
    </View>
  );
}

// ═══════════════════════ Accounts (expandable rows) ═══════════════════════
function AccountsSection({ c, positions, fxRate, refreshKey, onRefresh, onOpenChart }) {
  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
  // Normalise INTO USD â this ran the other way and treated rupees as the
  // common unit, while the wallets it sums are USD-denominated.
  const toUsd = (a, cur) => { const nn = Number(a) || 0; return cur === 'INR' && rate > 0 ? nn / rate : nn; };
  const [accounts, setAccounts] = useState([]);
  const [balances, setBalances] = useState([]);
  const [todayByAcc, setTodayByAcc] = useState({});
  const [sel, setSel] = useState('all');
  const [expandedId, setExpandedId] = useState(null);
  const [closing, setClosing] = useState(null);

  useEffect(() => {
    let dead = false;
    api.get('/user/accounts').then((r) => { if (!dead) setAccounts(r.data.data || []); }).catch(() => {});
    api.get('/wallet/balances').then((r) => { if (!dead) setBalances(r.data.data || []); }).catch(() => {});
    const start = new Date(); start.setHours(0, 0, 0, 0);
    api.get('/trading/positions/history', { params: { from: start.toISOString(), limit: 500 } }).then((r) => {
      if (dead) return;
      const m = {};
      for (const it of (r.data.data?.items || [])) { const k = String(it.accountId); m[k] = (m[k] || 0) + Number(it.realizedPnl || 0); }
      setTodayByAcc(m);
    }).catch(() => {});
    return () => { dead = true; };
  }, [refreshKey]);

  const closeAll = (acc) => {
    const label = acc.accountNumber || String(acc._id).slice(-6);
    Alert.alert('Close all positions', `Close ALL open positions on ${label}?\n\nThis places market orders to exit every open position and cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Close All', style: 'destructive', onPress: async () => {
          setClosing(acc._id);
          try {
            const { data } = await api.post('/trading/positions/close-all', { accountId: acc._id });
            const d = data?.data || {};
            if (d.failed?.length) Alert.alert('Partly closed', `Closed ${d.closed}/${d.total} — ${d.failed.length} failed`);
            else Alert.alert('Done', `Closed ${d.closed ?? 0} position${(d.closed ?? 0) === 1 ? '' : 's'}`);
            onRefresh && onRefresh();
          } catch (e) {
            Alert.alert('Error', e?.response?.data?.message || 'Failed to close positions');
          } finally { setClosing(null); }
        },
      },
    ]);
  };

  const live = accounts.filter((a) => !isDemo(a.accountType)).length;
  const demo = accounts.length - live;
  const options = [
    { k: 'all', label: 'All Accounts' }, { k: 'real', label: 'All Real' }, { k: 'demo', label: 'All Demo' },
    ...accounts.map((a) => ({ k: String(a._id), label: `${a.accountNumber || String(a._id).slice(-6)} (${isDemo(a.accountType) ? 'Demo' : 'Live'})` })),
  ];

  const rows = accounts.filter((a) => {
    if (sel === 'all') return true;
    if (sel === 'real') return !isDemo(a.accountType);
    if (sel === 'demo') return isDemo(a.accountType);
    return String(a._id) === sel;
  }).map((a) => {
    const cur = a.baseCurrency || 'USD';
    const bal = balances.filter((b) => String(b.accountId) === String(a._id)).reduce((s, b) => s + toUsd(b.balance, b.currency), 0);
    const accPos = positions.filter((p) => String(p.accountId) === String(a._id));
    const flo = accPos.reduce((s, p) => s + toUsd(p.unrealizedPnl, cur), 0);
    const equity = bal + flo;
    const pct = bal > 0 ? (flo / bal) * 100 : 0;
    const today = toUsd(todayByAcc[String(a._id)] || 0, cur);
    return { a, cur, bal, flo, equity, pct, today, openN: accPos.length, accPos };
  });

  const Both = ({ n, colored }) => (
    <View style={{ alignItems: 'flex-end' }}>
      <Text style={{ fontSize: 13, fontWeight: '800', color: colored ? (n >= 0 ? c.bull : c.bear) : c.textPrimary, fontVariant: ['tabular-nums'] }}>{colored && n >= 0 ? '+' : ''}${fmtNum(n, 2)}</Text>
      <Text style={{ fontSize: 10, color: c.textMuted, fontVariant: ['tabular-nums'] }}>{colored && n >= 0 ? '+' : ''}≈ ₹{fmtNum(n * rate, 2)}</Text>
    </View>
  );

  return (
    <View style={[cardBase(c), { padding: 0, overflow: 'hidden' }]}>
      <View style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: c.borderSubtle }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <View>
            <Text style={{ fontSize: 10, fontWeight: '800', letterSpacing: 1.6, color: c.textMuted }}>WALLET</Text>
            <Text style={{ fontSize: 15, fontWeight: '800', color: c.textPrimary, marginTop: 2 }}>Accounts</Text>
          </View>
          <Row style={{ gap: 16 }}>
            <View style={{ alignItems: 'center' }}><Text style={{ fontSize: 17, fontWeight: '800', color: c.textPrimary }}>{live}</Text><Text style={{ fontSize: 9, fontWeight: '800', color: c.textMuted }}>LIVE</Text></View>
            <View style={{ alignItems: 'center' }}><Text style={{ fontSize: 17, fontWeight: '800', color: c.textPrimary }}>{demo}</Text><Text style={{ fontSize: 9, fontWeight: '800', color: c.textMuted }}>DEMO</Text></View>
          </Row>
        </Row>
        <View style={{ marginTop: 10 }}><FilterPills c={c} options={options} value={sel} onChange={setSel} /></View>
      </View>

      {rows.length === 0 ? (
        <Text style={{ padding: 20, textAlign: 'center', color: c.textMuted, fontSize: 12 }}>No accounts</Text>
      ) : rows.map(({ a, cur, bal, flo, equity, pct, today, openN, accPos }) => {
        const dem = isDemo(a.accountType);
        const isOpen = expandedId === a._id;
        return (
          <View key={a._id} style={{ borderBottomWidth: 1, borderBottomColor: c.borderSubtle }}>
            <View style={{ padding: 14, backgroundColor: isOpen ? c.hover : 'transparent' }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Row style={{ gap: 10, flex: 1 }}>
                  <View style={{ width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: c.primarySoft }}>
                    <Text style={{ fontSize: 11, fontWeight: '800', color: c.primary500 }}>{(a.accountNumber || 'AC').slice(-2)}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Row style={{ gap: 6 }}>
                      <Text style={{ fontSize: 13, fontWeight: '800', color: c.textPrimary }} numberOfLines={1}>{a.accountNumber || String(a._id).slice(-6)}</Text>
                      <View style={{ backgroundColor: (dem ? '#D97706' : GREEN) + '18', borderRadius: 3, paddingHorizontal: 4, paddingVertical: 1 }}>
                        <Text style={{ fontSize: 8, fontWeight: '800', color: dem ? '#B45309' : '#15803D' }}>{dem ? 'Demo' : 'Live'}</Text>
                      </View>
                    </Row>
                    <Text style={{ fontSize: 10, color: c.textMuted }} numberOfLines={1}>{a.nickname || 'Trading Account'}</Text>
                  </View>
                </Row>
                <TouchableOpacity disabled={openN === 0} onPress={() => setExpandedId(isOpen ? null : a._id)} style={{ opacity: openN === 0 ? 0.4 : 1, padding: 6 }}>
                  <Ionicons name={isOpen ? 'chevron-up' : 'chevron-down'} size={18} color={c.textSecondary} />
                </TouchableOpacity>
              </Row>

              <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 12, gap: 12 }}>
                <MiniKV c={c} label="Balance"><Both n={bal} /></MiniKV>
                <MiniKV c={c} label="Equity"><Both n={equity} /></MiniKV>
                <MiniKV c={c} label="P&L (Float)"><Both n={flo} colored /></MiniKV>
                <MiniKV c={c} label="P&L %"><Text style={{ fontSize: 13, fontWeight: '800', color: pct >= 0 ? c.bull : c.bear, fontVariant: ['tabular-nums'] }}>{pct >= 0 ? '+' : ''}{pct.toFixed(2)}%</Text></MiniKV>
                <MiniKV c={c} label="Today"><Both n={today} colored /></MiniKV>
                <MiniKV c={c} label="Open"><Text style={{ fontSize: 13, fontWeight: '800', color: c.textPrimary }}>{openN}</Text></MiniKV>
              </View>
            </View>

            {isOpen && (
              <View style={{ padding: 14, backgroundColor: c.bg, gap: 10 }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 12, fontWeight: '800', color: c.textPrimary }}>Open Positions ({openN})</Text>
                  <Text style={{ fontSize: 12, fontWeight: '800', color: flo >= 0 ? c.bull : c.bear, fontVariant: ['tabular-nums'] }}>{flo >= 0 ? '+' : ''}${fmtNum(Math.abs(flo), 2)} ({pct >= 0 ? '+' : ''}{pct.toFixed(2)}%)</Text>
                </Row>
                {accPos.length === 0 ? (
                  <Text style={{ textAlign: 'center', color: c.textMuted, fontSize: 12, paddingVertical: 12 }}>No open positions on this account</Text>
                ) : (
                  <View style={{ gap: 10 }}>
                    {accPos.map((p) => <MiniPositionCard key={p._id || `${p.symbol}-${p.entryPrice}`} c={c} p={p} cur={cur} rate={rate} onPress={() => onOpenChart(p)} />)}
                  </View>
                )}
                <TouchableOpacity disabled={closing === a._id || openN === 0} onPress={() => closeAll(a)}
                  style={{ borderWidth: 1, borderColor: c.bear + '66', borderRadius: 10, paddingVertical: 10, alignItems: 'center', opacity: closing === a._id || openN === 0 ? 0.5 : 1 }}>
                  <Text style={{ fontSize: 12, fontWeight: '800', color: c.bear }}>{closing === a._id ? 'Closing…' : 'Close All Positions'}</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}
function MiniKV({ c, label, children }) {
  return (
    <View style={{ width: '30%' }}>
      <Text style={{ fontSize: 9, fontWeight: '800', letterSpacing: 0.4, color: c.textMuted, marginBottom: 2 }}>{label.toUpperCase()}</Text>
      {children}
    </View>
  );
}

// ═══════════════════════ Asset allocation (donut) ═══════════════════════
function AssetAllocation({ c, positions, fxRate, refreshKey, onViewMore }) {
  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
  const [accounts, setAccounts] = useState([]);
  const [sel, setSel] = useState('all');

  useEffect(() => {
    let dead = false;
    api.get('/user/accounts').then((r) => { if (!dead) setAccounts(r.data.data || []); }).catch(() => {});
    return () => { dead = true; };
  }, [refreshKey]);

  const typeById = useMemo(() => { const m = new Map(); for (const a of accounts) m.set(String(a._id), a.accountType); return m; }, [accounts]);
  const filtered = positions.filter((p) => {
    if (sel === 'all') return true;
    const t = typeById.get(String(p.accountId));
    if (sel === 'real') return !isDemo(t);
    if (sel === 'demo') return isDemo(t);
    return String(p.accountId) === sel;
  });

  const { entries, total } = useMemo(() => {
    const b = {}; let tot = 0;
    for (const p of filtered) {
      const cat = (p.category || 'OTHER').toUpperCase();
      const key = ALLOC_COLORS[cat] ? cat : 'OTHER';
      const v = Math.abs(Number(p.notional) || 0);
      b[key] = (b[key] || 0) + v; tot += v;
    }
    return { entries: Object.entries(b).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]), total: tot };
  }, [filtered]);

  const options = [
    { k: 'all', label: 'All Accounts' }, { k: 'real', label: 'All Real' }, { k: 'demo', label: 'All Demo' },
    ...accounts.map((a) => ({ k: String(a._id), label: `${a.accountNumber || String(a._id).slice(-6)} (${isDemo(a.accountType) ? 'Demo' : 'Live'})` })),
  ];

  const R = 54, SW = 20, CIRC = 2 * Math.PI * R, cx = 70, cy = 70;
  let off = 0;
  const segs = entries.map(([cat, val]) => { const len = (val / total) * CIRC; const s = { cat, len, off }; off += len; return s; });

  return (
    <View style={[cardBase(c), { padding: 16 }]}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <Row style={{ gap: 6 }}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: c.textPrimary }}>Asset Allocation</Text>
          <Ionicons name="information-circle-outline" size={15} color={c.textMuted} />
        </Row>
      </Row>
      <View style={{ marginTop: 10 }}><FilterPills c={c} options={options} value={sel} onChange={setSel} /></View>

      {total === 0 ? (
        <Text style={{ textAlign: 'center', color: c.textMuted, fontSize: 12, paddingVertical: 24 }}>No exposure yet — open a position to see allocation.</Text>
      ) : (
        <>
          <View style={{ width: 170, height: 170, alignSelf: 'center', marginTop: 12 }}>
            <Svg width={170} height={170} viewBox="0 0 140 140">
              <Circle cx={cx} cy={cy} r={R} fill="none" stroke={c.borderSubtle} strokeWidth={SW} />
              {segs.map((s) => (
                <Circle key={s.cat} cx={cx} cy={cy} r={R} fill="none" stroke={ALLOC_COLORS[s.cat] || '#9CA3AF'} strokeWidth={SW}
                  strokeDasharray={[s.len, CIRC - s.len]} strokeDashoffset={-s.off} rotation={-90} originX={cx} originY={cy} />
              ))}
            </Svg>
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 11, color: c.textMuted }}>Total</Text>
              <Text style={{ fontSize: 18, fontWeight: '900', color: c.textPrimary, fontVariant: ['tabular-nums'] }}>${fmtNum(total, 0)}</Text>
            </View>
          </View>

          <View style={{ marginTop: 16, gap: 10 }}>
            {entries.map(([cat, val]) => {
              const pct = (val / total) * 100;
              return (
                <Row key={cat} style={{ alignItems: 'center' }}>
                  <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: ALLOC_COLORS[cat] || '#9CA3AF', marginRight: 10 }} />
                  <Text style={{ flex: 1, fontSize: 13, fontWeight: '700', color: c.textPrimary }} numberOfLines={1}>{CAT_NAME[cat] || cat}</Text>
                  <Text style={{ fontSize: 13, fontWeight: '800', color: c.textPrimary, marginRight: 12, fontVariant: ['tabular-nums'] }}>${fmtNum(val, 2)}</Text>
                  <Text style={{ fontSize: 12, color: c.textMuted, width: 56, textAlign: 'right', fontVariant: ['tabular-nums'] }}>{pct.toFixed(2)}%</Text>
                </Row>
              );
            })}
          </View>
        </>
      )}

      <TouchableOpacity onPress={onViewMore} style={{ marginTop: 16, backgroundColor: c.hover, borderRadius: 12, paddingVertical: 10, alignItems: 'center' }}>
        <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary500 }}>View Detailed Allocation →</Text>
      </TouchableOpacity>
    </View>
  );
}

// ═══════════════════════ Recent closed trades ═══════════════════════
function RecentClosedTrades({ c, fxRate, refreshKey, onViewAll }) {
  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let dead = false;
    api.get('/trading/positions/history', { params: { limit: 6 } })
      .then((r) => { if (!dead) setRows(r.data.data?.items || []); })
      .catch(() => {})
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [refreshKey]);

  return (
    <View style={[cardBase(c), { padding: 0, overflow: 'hidden' }]}>
      <Row style={{ justifyContent: 'space-between', padding: 14, borderBottomWidth: 1, borderBottomColor: c.borderSubtle }}>
        <Text style={{ fontSize: 15, fontWeight: '800', color: c.textPrimary }}>Recent Closed Trades</Text>
        <TouchableOpacity onPress={onViewAll}><Text style={{ fontSize: 12, fontWeight: '700', color: c.primary500 }}>View All →</Text></TouchableOpacity>
      </Row>
      {loading ? (
        <Text style={{ padding: 20, textAlign: 'center', color: c.textMuted, fontSize: 12 }}>Loading…</Text>
      ) : rows.length === 0 ? (
        <Text style={{ padding: 20, textAlign: 'center', color: c.textMuted, fontSize: 12 }}>No closed trades yet</Text>
      ) : rows.map((t) => {
        const pnl = Number(t.realizedPnl || 0);
        const buy = String(t.side).toUpperCase() === 'BUY';
        const tone = pnl >= 0 ? c.bull : c.bear;
        return (
          <View key={t._id || `${t.symbol}-${t.closedAt}`} style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: c.borderSubtle }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Row style={{ gap: 8, flex: 1 }}>
                <AssetBadge symbol={t.symbol} size={24} />
                <View>
                  <Row style={{ gap: 6 }}>
                    <Text style={{ fontSize: 13, fontWeight: '800', color: c.textPrimary }}>{t.symbol}</Text>
                    <View style={{ backgroundColor: (buy ? GREEN : RED) + '18', borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1 }}>
                      <Text style={{ fontSize: 9, fontWeight: '800', color: buy ? '#15803D' : '#B91C1C' }}>{buy ? 'BUY' : 'SELL'}</Text>
                    </View>
                  </Row>
                  <Text style={{ fontSize: 10, color: c.textMuted, marginTop: 2 }}>{t.accountNumber || String(t.accountId || '').slice(-6) || '—'} · {fmtCloseTime(t.closedAt)}</Text>
                </View>
              </Row>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ fontSize: 14, fontWeight: '800', color: tone, fontVariant: ['tabular-nums'] }}>{pnl >= 0 ? '+' : '-'}${fmtNum(Math.abs(pnl), 2)}</Text>
                <Text style={{ fontSize: 10, color: tone, fontVariant: ['tabular-nums'] }}>{pnl >= 0 ? '+' : '-'}${fmtNum(Math.abs(pnl), 2)}</Text>
              </View>
            </Row>
            <Row style={{ marginTop: 8, justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 11, color: c.textMuted, fontVariant: ['tabular-nums'] }}>Lot {fmtNum(t.quantity, 2)}</Text>
              <Text style={{ fontSize: 11, color: c.textSecondary, fontVariant: ['tabular-nums'] }}>{fmtNum(t.entryPrice, 4)} → {t.closePrice != null ? fmtNum(t.closePrice, 4) : '—'}</Text>
            </Row>
          </View>
        );
      })}
    </View>
  );
}

// ═════════════════════════════ Screen ═════════════════════════════
export default function PortfolioScreen({ navigation }) {
  const c = useColors();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [priceMap, setPriceMap] = useState({});
  const [positions, setPositions] = useState([]);
  const [instruments, setInstruments] = useState([]);
  const [fxRate, setFxRate] = useState(83);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // ── Dashboard payload (15s poll, paused when app backgrounded) ──
  const loadDashboard = useCallback(async () => {
    try { const res = await api.get('/user/dashboard'); setData(res.data.data); }
    catch { setData((prev) => prev ?? null); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    let id = null;
    const start = () => { if (!id) id = setInterval(loadDashboard, 15000); };
    const stop = () => { if (id) { clearInterval(id); id = null; } };
    loadDashboard(); start();
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') { loadDashboard(); start(); } else stop(); });
    return () => { stop(); sub.remove(); };
  }, [loadDashboard]);

  // ── FX rate (USD→INR) — same endpoint the web useFxRate proxies ──
  useEffect(() => {
    let dead = false;
    api.get('/fx/usdinr', { timeout: 8000 }).then((r) => { const rt = Number(r.data?.rate); if (!dead && Number.isFinite(rt) && rt > 0) setFxRate(rt); }).catch(() => {});
    return () => { dead = true; };
  }, [refreshKey]);

  // ── Instrument catalog (category / precision / name / logo) ──
  useEffect(() => {
    let dead = false;
    api.get('/instruments').then((r) => { if (!dead) setInstruments(r.data?.data || []); }).catch(() => {});
    return () => { dead = true; };
  }, [refreshKey]);

  // ── Open positions (full payload) + WS refresh ──
  const loadPositions = useCallback(async () => {
    try { const { data: d } = await api.get('/trading/positions'); setPositions(Array.isArray(d?.data) ? d.data : []); } catch { /* keep */ }
  }, []);
  useEffect(() => {
    loadPositions();
    const p = wsClient.subscribe('user:positions', loadPositions);
    return () => { p && p(); };
  }, [loadPositions]);
  useEffect(() => {
    const refetch = () => { loadDashboard(); loadPositions(); };
    const w = wsClient.subscribe('user:wallet', refetch);
    const p = wsClient.subscribe('user:positions', refetch);
    return () => { w && w(); p && p(); };
  }, [loadDashboard, loadPositions]);

  // ── Live ticker subscriptions for every held symbol ──
  const openSymbols = useMemo(() => {
    const fromDash = data?.equity?.openPositions || [];
    return [...new Set([...fromDash.map((p) => p.symbol), ...positions.map((p) => p.symbol)])];
  }, [data, positions]);
  useEffect(() => {
    if (!openSymbols.length) return undefined;
    const unsubs = openSymbols.map((sym) => wsClient.subscribe(`ticker:${sym}`, (tick) => {
      const px = Number(tick?.lastPrice ?? tick?.price ?? tick?.last);
      if (Number.isFinite(px)) setPriceMap((prev) => (prev[sym] === px ? prev : { ...prev, [sym]: px }));
    }));
    return () => unsubs.forEach((u) => u && u());
  }, [openSymbols]);

  const instBySymbol = useMemo(() => { const m = new Map(); for (const i of instruments) m.set(i.symbol, i); return m; }, [instruments]);
  const livePositions = useMemo(() => positions.map((p) => {
    const markPx = Number(priceMap[p.symbol] ?? p.markPrice ?? p.entryPrice);
    const entry = Number(p.entryPrice);
    const qty = Number(p.quantity);
    const pnl = (p.side === 'BUY' ? (markPx - entry) * qty : (entry - markPx) * qty) || 0;
    const inst = instBySymbol.get(p.symbol);
    return { ...p, markPrice: markPx, unrealizedPnl: pnl, category: p.category || inst?.category || 'OTHER', notional: Math.abs(qty * markPx), _inst: inst };
  }), [positions, priceMap, instBySymbol]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshKey((k) => k + 1);
    await Promise.all([loadDashboard(), loadPositions()]);
    setRefreshing(false);
  }, [loadDashboard, loadPositions]);

  const openChart = useCallback((p) => {
    const inst = p._inst || instBySymbol.get(p.symbol) || { symbol: p.symbol };
    navigation.navigate('InstrumentDetail', { instrument: inst });
  }, [navigation, instBySymbol]);

  if (loading && !data) return <Loader label="Loading portfolio…" />;
  if (!data) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <Empty title="Couldn't load your portfolio" sub="Check your connection and try again." />
        <View style={{ paddingHorizontal: 40 }}>
          <TouchableOpacity onPress={() => { setLoading(true); loadDashboard(); }} style={{ backgroundColor: c.primary500, borderRadius: 12, paddingVertical: 12, alignItems: 'center' }}>
            <Text style={{ color: '#FFFFFF', fontWeight: '800' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Derived figures (mirror the web) ──
  const fullName = [data.user?.firstName, data.user?.lastName].filter(Boolean).join(' ') || 'Trader';
  const primaryCur = data.balance?.primaryCurrency || 'USD';
  const liveByCur = data.balance?.liveByCurrency || {};
  const liveBalance = (() => {
    const direct = Number(data.balance?.live || 0);
    if (direct !== 0) return direct;
    const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
    return Object.entries(liveByCur).reduce((sum, [cur, t]) => {
      const bal = Number(t?.balance || 0);
      if (!Number.isFinite(bal) || bal === 0) return sum;
      if (cur === primaryCur) return sum + bal;
      if (cur === 'USD' && primaryCur === 'INR') return sum + bal * rate;
      if (cur === 'INR' && primaryCur === 'USD') return sum + bal / rate;
      return sum + bal;
    }, 0);
  })();
  const openPositionsList = data.equity?.openPositions || [];
  const liveUnrealized = openPositionsList.reduce((sum, p) => {
    const mark = Number(priceMap[p.symbol] ?? 0);
    if (!mark) return sum;
    const entry = Number(p.entryPrice); const qty = Number(p.quantity);
    return sum + (p.side === 'BUY' ? (mark - entry) * qty : (entry - mark) * qty);
  }, 0);
  const haveAllTicks = openPositionsList.length > 0 && openPositionsList.every((p) => priceMap[p.symbol] != null);
  const unrealized = haveAllTicks ? liveUnrealized : Number(data.equity?.unrealizedPnl || 0);
  const equity = liveBalance + unrealized;
  const todayPnl = Number(data.pnl?.realizedToday || 0);
  const winRate = data.pnl?.winRate;
  const kycStatus = data.user?.kycStatus;

  const eq = fmtMoneyBoth(equity, primaryCur, fxRate);
  const bal = fmtMoneyBoth(liveBalance, primaryCur, fxRate);
  const floatPnl = fmtMoneyBoth(unrealized, primaryCur, fxRate, true);
  const today = fmtMoneyBoth(todayPnl, primaryCur, fxRate, true);
  const eqPct = equity > 0 ? (unrealized / equity) * 100 : 0;
  const todayPct = equity > 0 ? (todayPnl / equity) * 100 : 0;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.bg }}
      contentContainerStyle={{ padding: 16, gap: 20, paddingBottom: 32 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary500} />}
    >
      {/* ── Header ── */}
      <View style={{ gap: 12 }}>
        <View>
          <Row style={{ gap: 8 }}>
            <Text style={{ fontSize: 26, fontWeight: '900', color: c.textPrimary }}>Portfolio</Text>
            <Row style={{ gap: 5, borderWidth: 1, borderColor: c.border, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3, alignItems: 'center' }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.bull }} />
              <Text style={{ fontSize: 10, fontWeight: '700', color: c.textSecondary }}>Live</Text>
            </Row>
          </Row>
          <Text style={{ fontSize: 13, color: c.textMuted, marginTop: 4 }}>{fullName} · Equity, P&L, open positions and activity — all in one view</Text>
        </View>

        <Row style={{ gap: 8, flexWrap: 'wrap' }}>
          {kycStatus === 'APPROVED' ? (
            <Row style={{ gap: 5, borderWidth: 1, borderColor: c.bull + '4D', backgroundColor: c.bullSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 }}>
              <Ionicons name="shield-checkmark" size={13} color={c.bull} /><Text style={{ fontSize: 11, fontWeight: '800', color: c.bull }}>KYC Verified</Text>
            </Row>
          ) : kycStatus === 'PENDING' ? (
            <Row style={{ gap: 5, borderWidth: 1, borderColor: c.warn + '4D', backgroundColor: c.warnSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 }}>
              <Ionicons name="shield-outline" size={13} color={c.warn} /><Text style={{ fontSize: 11, fontWeight: '800', color: c.warn }}>KYC Under Review</Text>
            </Row>
          ) : (
            <TouchableOpacity onPress={() => navigation.navigate('Kyc')} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: c.bear + '4D', backgroundColor: c.bearSoft, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 }}>
              <Ionicons name="shield-outline" size={13} color={c.bear} /><Text style={{ fontSize: 11, fontWeight: '800', color: c.bear }}>Verify Identity</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => navigation.navigate('Wallet')} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 7 }}>
            <Ionicons name="wallet-outline" size={14} color={c.textPrimary} /><Text style={{ fontSize: 11, fontWeight: '800', color: c.textPrimary }}>Add Funds</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => navigation.navigate('Trade')} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: c.primary500, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 7 }}>
            <Ionicons name="trending-up" size={14} color="#FFFFFF" /><Text style={{ fontSize: 11, fontWeight: '800', color: '#FFFFFF' }}>Trade</Text>
          </TouchableOpacity>
        </Row>
      </View>

      {/* ── Equity hero band ── */}
      <View style={{ backgroundColor: c.panel, borderRadius: 20, borderWidth: 1, borderColor: c.border, padding: 14 }}>
        <PnlTile c={c} tint="#3B82F6" iconName="stats-chart" label="Portfolio Value (Equity)" value={eq.primary} valueColor={c.textPrimary} secondary={eq.secondary} pct={eqPct} />
        <PnlTile c={c} tint="#16A34A" iconName="trending-up" label="Total P&L (Floating)" value={floatPnl.primary} valueColor={unrealized >= 0 ? GREEN : RED} secondary={floatPnl.secondary} pct={eqPct} />
        <PnlTile c={c} tint={todayPnl >= 0 ? '#16A34A' : '#DC2626'} iconName="cash-outline" label="Today's P&L" badge="CLOSED" value={today.primary} valueColor={todayPnl >= 0 ? GREEN : RED} secondary={today.secondary} pct={todayPct} />
        <Row style={{ gap: 10, marginTop: 4 }}>
          <StatBox c={c} dotTint="#3B82F6" label="Open" value={String(positions.length)} caption="Positions" />
          <StatBox c={c} dotTint={winRate == null ? '#94A3B8' : winRate >= 50 ? '#16A34A' : '#DC2626'} label="Win Rate" value={winRate == null ? '—' : `${winRate.toFixed(0)}%`} caption="All time" />
        </Row>
        {/* Balance footer */}
        <Row style={{ marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.borderSubtle, gap: 6, flexWrap: 'wrap' }}>
          <Ionicons name="card-outline" size={12} color={c.textMuted} />
          <Text style={{ fontSize: 11, color: c.textMuted }}>Balance</Text>
          <Text style={{ fontSize: 11, fontWeight: '800', color: c.textPrimary, fontVariant: ['tabular-nums'] }}>{bal.primary}</Text>
          {bal.secondary ? <Text style={{ fontSize: 11, color: c.textMuted, fontVariant: ['tabular-nums'] }}>(= {bal.secondary.replace('≈ ', '')})</Text> : null}
          {Object.entries(liveByCur).filter(([cur]) => cur !== primaryCur).map(([cur, t]) => (
            <Row key={cur} style={{ gap: 3, borderWidth: 1, borderColor: c.borderSubtle, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
              <Text style={{ fontSize: 10, color: c.textMuted }}>{cur}</Text>
              <Text style={{ fontSize: 10, color: c.textSecondary, fontVariant: ['tabular-nums'] }}>{currencySymbol(cur)}{Math.round(Number(t.balance) || 0).toLocaleString()}</Text>
            </Row>
          ))}
        </Row>
      </View>

      {/* ── Trading summary ── */}
      <TradingSummary fxRate={fxRate} refreshKey={refreshKey} />

      {/* ── Portfolio chart ── */}
      <PortfolioChart fxRate={fxRate} refreshKey={refreshKey} />

      {/* ── Accounts ── */}
      <AccountsSection c={c} positions={livePositions} fxRate={fxRate} refreshKey={refreshKey} onRefresh={onRefresh} onOpenChart={openChart} />

      {/* ── Open positions ── */}
      <View>
        <SectionHead c={c} eyebrow="Live" title="Open positions" count={livePositions.length} rightLabel="Manage →" onRight={() => navigation.navigate('Trade')} />
        {livePositions.length === 0 ? (
          <View style={[cardBase(c), { padding: 28, alignItems: 'center' }]}>
            <Ionicons name="pie-chart-outline" size={44} color={c.textMuted} />
            <Text style={{ fontSize: 14, fontWeight: '700', color: c.textPrimary, marginTop: 10 }}>No open positions</Text>
            <Text style={{ fontSize: 12, color: c.textMuted, marginTop: 4, textAlign: 'center' }}>Open a long or short trade and your live positions will appear here with mark-to-market P&L.</Text>
            <TouchableOpacity onPress={() => navigation.navigate('Markets')} style={{ marginTop: 14, backgroundColor: c.primary500, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 9 }}>
              <Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '800' }}>Explore Markets →</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            {livePositions.slice(0, 6).map((p) => <PositionCard key={p._id || `${p.symbol}-${p.entryPrice}`} c={c} p={p} onPress={() => openChart(p)} />)}
            {livePositions.length > 6 ? (
              <TouchableOpacity onPress={() => navigation.navigate('Trade')} style={[cardBase(c), { paddingVertical: 12, alignItems: 'center' }]}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary500 }}>View all {livePositions.length} positions →</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        )}
      </View>

      {/* ── Asset allocation ── */}
      <AssetAllocation c={c} positions={livePositions} fxRate={fxRate} refreshKey={refreshKey} onViewMore={() => navigation.navigate('History')} />

      {/* ── Recent closed trades ── */}
      <RecentClosedTrades c={c} fxRate={fxRate} refreshKey={refreshKey} onViewAll={() => navigation.navigate('History')} />
    </ScrollView>
  );
}
