import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, RefreshControl, StyleSheet } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import Svg, { Polyline } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { useColors, radius, fmtNum } from '../theme';
import { Loader, Empty } from '../components/ui';

/**
 * MarketsScreen — native port of the web client's MarketList page
 * (client/src/pages/MarketList.jsx). Mirrors it section-for-section:
 *   • ranking selector (most-traded / gainers / losers / volume / sectors)
 *     — the web's ?view= param becomes an on-screen segmented control.
 *   • main live list  (Company · Market Price 1D w/ sparkline · Volume)
 *   • sectors view    (Sector · Gainers/Losers bar · 1D%)  when selected
 *   • the web's right-sidebar cards, stacked BELOW on mobile:
 *       Portfolio · Top Movers · Economic Calendar · Explore links.
 *
 * The main list keeps a FlashList; the selector sits fixed above it and the
 * sidebar cards ride in ListFooterComponent so it all reads as one stack.
 */

// ─── Asset glyph catalog (kept in sync with the web's ASSET_META) ─────────
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
// Category tints so glyph tiles echo the web AssetIcon colour language.
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

// ─── Sectors — grounded in the real backend `category` enum (mirrors web) ──
const cat = (r) => (r.category || '').toUpperCase();
const isCrypto = (r) => cat(r) === 'CRYPTO';
const isForex = (r) => cat(r) === 'FOREX';
const isCommodity = (r) => cat(r) === 'COMMODITY';
const isIndex = (r) => cat(r) === 'INDEX';
const isStock = (r) => cat(r) === 'STOCK';
const MAJOR_CCY = new Set(['EUR', 'GBP', 'USD', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD']);

const SECTOR_DEFS = [
  { key: 'crypto', label: 'Crypto', tint: '#F7931A', match: isCrypto },
  { key: 'forex', label: 'Forex', tint: '#10B981', match: isForex },
  { key: 'majors', label: 'Forex Majors', tint: '#0EA5E9',
    match: (r) => isForex(r)
      && MAJOR_CCY.has((r.baseCurrency || '').toUpperCase())
      && MAJOR_CCY.has((r.quoteCurrency || '').toUpperCase()) },
  { key: 'comm', label: 'Commodities', tint: '#A16207', match: isCommodity },
  { key: 'gold', label: 'Precious Metals', tint: '#D4A017',
    match: (r) => isCommodity(r) && ['XAU', 'XAG'].includes((r.baseCurrency || '').toUpperCase()) },
  { key: 'indices', label: 'Indices', tint: '#3B82F6', match: isIndex },
  { key: 'stocks', label: 'Stocks', tint: '#8B5CF6', match: isStock },
];

// ─── View configs — title + caption + sort fn per ranking (mirrors web) ────
const VIEWS = {
  'most-traded': {
    title: 'Most traded markets',
    caption: 'Highest liquidity across crypto, forex, indices and commodities.',
    sort: (a, b) => {
      const va = Number(a.volume24h) || 0;
      const vb = Number(b.volume24h) || 0;
      if (vb !== va) return vb - va;
      return Math.abs(Number(b.change24h) || 0) - Math.abs(Number(a.change24h) || 0);
    },
  },
  gainers: {
    title: 'Top gainers',
    caption: 'Best 24h performers across the platform.',
    sort: (a, b) => (Number(b.change24h) || -Infinity) - (Number(a.change24h) || -Infinity),
  },
  losers: {
    title: 'Top losers',
    caption: 'Worst 24h performers across the platform.',
    sort: (a, b) => (Number(a.change24h) || Infinity) - (Number(b.change24h) || Infinity),
  },
  volume: {
    title: 'Highest volume',
    caption: 'Where the money is flowing right now.',
    sort: (a, b) => (Number(b.volume24h) || 0) - (Number(a.volume24h) || 0),
  },
  sectors: {
    title: 'All sectors',
    caption: 'Sector performance over the last 24 hours.',
  },
};
const SEGMENTS = [
  { key: 'most-traded', label: 'Most traded' },
  { key: 'gainers', label: 'Gainers' },
  { key: 'losers', label: 'Losers' },
  { key: 'volume', label: 'Volume' },
  { key: 'sectors', label: 'Sectors' },
];

// ─── Formatting + spark helpers (ported verbatim from the web) ─────────────
function synthSpark(change, seed = 0) {
  const ch = Number(change);
  const dir = !Number.isFinite(ch) ? 0 : ch >= 0 ? 1 : -1;
  const N = 24;
  const start = 50 - dir * 12;
  const end = 50 + dir * 12;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const wiggle = Math.sin((i + seed) * 0.9) * 3 + Math.sin((i + seed) * 2.1) * 1.5;
    pts.push(start + (end - start) * t + wiggle);
  }
  return pts;
}
function fmtVolume(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return v.toFixed(0);
}
function fmtPrice(raw, precision) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return '—';
  return fmtNum(v, Math.min(Number(precision) || 2, 6));
}

// ─── Economic calendar — real backend feeds only ──────────────────────────
// Web merges a live Forex-Factory proxy (/instruments/economic-calendar) with
// admin events (/cms/economic-calendar). We use those SAME backend feeds and
// honour the admin `enabled` flag. (The web's client-side synthetic fallback
// schedule is intentionally not ported — this port is real-data-only.)
const ECON_IMPACT = {
  high: { color: '#DC2626', label: 'High' },
  medium: { color: '#3B82F6', label: 'Med' },
  low: { color: '#9CA3AF', label: 'Low' },
};
const FLAGS = {
  US: '🇺🇸', EU: '🇪🇺', GB: '🇬🇧',
  JP: '🇯🇵', CA: '🇨🇦', AU: '🇦🇺',
  NZ: '🇳🇿', CH: '🇨🇭', CN: '🇨🇳',
  IN: '🇮🇳', KR: '🇰🇷', SG: '🇸🇬',
  TR: '🇹🇷', BR: '🇧🇷',
};
const flagFor = (co) => FLAGS[co] || '🌐';
const econTime = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
const econMonth = (d) => d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
function normAdminEvent(e) {
  const date = new Date(e.date);
  if (Number.isNaN(date.getTime())) return null;
  return {
    id: e.id || `adm-${e.date}-${e.event}`,
    date,
    country: e.country || '',
    impact: ['high', 'medium', 'low'].includes(e.impact) ? e.impact : 'medium',
    event: e.event || '',
  };
}

// ─── Presentational pieces (receive styles / c via props — no module `c`) ──
function Sparkline({ points, positive, width = 56, height = 28, c }) {
  if (!points?.length) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(max - min, 1);
  const step = width / (points.length - 1);
  const coords = points
    .map((p, i) => `${(i * step).toFixed(1)},${(height - ((p - min) / span) * (height - 4) - 2).toFixed(1)}`)
    .join(' ');
  return (
    <Svg width={width} height={height}>
      <Polyline points={coords} fill="none" stroke={positive ? c.bull : c.bear} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function AssetGlyph({ row, size = 40 }) {
  const meta = glyphMeta(row);
  const fs = Math.round(size * (meta.glyph.length > 2 ? 0.34 : 0.42));
  return (
    <View style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), backgroundColor: meta.bg, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#FFFFFF', fontWeight: '800', fontSize: fs }}>{meta.glyph}</Text>
    </View>
  );
}

function Segmented({ view, setView, styles, c }) {
  return (
    <View style={styles.segBar}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.segScroll}>
        {SEGMENTS.map((s) => {
          const on = view === s.key;
          return (
            <TouchableOpacity key={s.key} activeOpacity={0.8} onPress={() => setView(s.key)} style={[styles.seg, on && styles.segOn]}>
              <Text style={[styles.segTxt, on && styles.segTxtOn]}>{s.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

function MarketRow({ item, idx, onPress, styles, c }) {
  const change = Number(item.change24h);
  const price = Number(item.lastPrice);
  const absChange = Number.isFinite(change) && Number.isFinite(price) ? (price * change) / 100 : NaN;
  const positive = Number.isFinite(change) ? change >= 0 : true;
  const prec = Math.min(Number(item.pricePrecision) || 2, 4);
  return (
    <TouchableOpacity activeOpacity={0.6} onPress={onPress} style={styles.row}>
      <AssetGlyph row={item} size={40} />
      <View style={styles.rowMain}>
        <Text style={styles.rowName} numberOfLines={1}>{item.name || item.symbol}</Text>
        <Text style={styles.rowSym} numberOfLines={1}>{item.symbol}</Text>
      </View>
      <View style={styles.rowSpark}>
        <Sparkline points={synthSpark(change, idx)} positive={positive} c={c} />
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.rowPrice} numberOfLines={1}>{fmtPrice(item.lastPrice, item.pricePrecision)}</Text>
        <Text style={[styles.rowChg, { color: positive ? c.bull : c.bear }]} numberOfLines={1}>
          {Number.isFinite(absChange)
            ? `${positive ? '+' : '-'}${fmtNum(Math.abs(absChange), prec)} (${positive ? '+' : '-'}${Math.abs(change).toFixed(2)}%)`
            : '—'}
        </Text>
        <Text style={styles.rowVol} numberOfLines={1}>Vol {fmtVolume(item.volume24h)}</Text>
      </View>
    </TouchableOpacity>
  );
}

function SectorRow({ item, onPress, styles, c }) {
  const positive = item.perf >= 0;
  return (
    <TouchableOpacity activeOpacity={0.6} onPress={onPress} style={styles.row}>
      <View style={[styles.sectorTile, { backgroundColor: item.tint + '22' }]}>
        <Text style={[styles.sectorTileTxt, { color: item.tint }]}>{item.label.slice(0, 1)}</Text>
      </View>
      <View style={styles.rowMain}>
        <Text style={styles.rowName} numberOfLines={1}>{item.label}</Text>
        <Text style={styles.rowSym} numberOfLines={1}>{item.matches.length} instruments · Top {item.top?.symbol || '—'}</Text>
      </View>
      <View style={styles.glBox}>
        <View style={styles.glNums}>
          <Text style={[styles.glNum, { color: c.bull }]}>{item.gainers}</Text>
          <Text style={[styles.glNum, { color: c.bear }]}>{item.losers}</Text>
        </View>
        <View style={styles.glTrack}>
          <View style={{ flex: item.gainers, backgroundColor: c.bull }} />
          <View style={{ flex: item.losers, backgroundColor: c.bear }} />
        </View>
      </View>
      <Text style={[styles.sectorPerf, { color: positive ? c.bull : c.bear }]}>
        {positive ? '+' : ''}{item.perf.toFixed(2)}%
      </Text>
    </TouchableOpacity>
  );
}

// ─── Sidebar cards (stacked below the list on mobile) ─────────────────────
function PortfolioCard({ navigation, styles, c }) {
  const [data, setData] = useState(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.get('/user/dashboard');
        if (!cancelled) setData(res.data?.data || null);
      } catch (_) { /* leave empty — render zeros */ }
    };
    load();
    const u1 = wsClient.subscribe('user:wallet', load);
    const u2 = wsClient.subscribe('user:positions', load);
    const u3 = wsClient.subscribe('user:orders', load);
    return () => { cancelled = true; u1 && u1(); u2 && u2(); u3 && u3(); };
  }, []);

  const balance = data?.balance || {};
  const eq = data?.equity || {};
  const liveByCur = balance.liveByCurrency || {};
  let liveCash = Number(balance.live || 0);
  if (liveCash === 0) {
    liveCash = Object.values(liveByCur).reduce((sum, t) => sum + (Number(t?.balance) || 0), 0);
  }
  const unrealised = Number(eq.unrealizedPnl || 0);
  const currentValue = liveCash + unrealised;

  let investedValue = Number(
    data?.deposits?.totalNet
      ?? data?.deposits?.lifetimeNet
      ?? data?.deposits?.total
      ?? data?.invested?.amount
      ?? 0,
  );
  if (!investedValue && Array.isArray(eq.openPositions) && eq.openPositions.length) {
    investedValue = eq.openPositions.reduce((sum, p) => {
      const m = Number(p.margin);
      if (Number.isFinite(m) && m > 0) return sum + m;
      const entry = Number(p.entryPrice) || 0;
      const qty = Number(p.quantity) || 0;
      const lev = Math.max(Number(p.leverage) || 1, 1);
      return sum + (entry * qty) / lev;
    }, 0);
  }

  const totalReturns = Number.isFinite(currentValue - investedValue) ? currentValue - investedValue : 0;
  const returnsPct = investedValue > 0 ? (totalReturns / investedValue) * 100 : 0;
  const positive = totalReturns >= 0;
  const fmt = (v) => (hidden ? '••••••' : '$' + fmtNum(Number(v) || 0, 2));

  return (
    <TouchableOpacity activeOpacity={0.85} onPress={() => navigation.navigate('Portfolio')} style={styles.card}>
      <View style={styles.pfHead}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={styles.cardTitle}>Your Portfolio</Text>
          <TouchableOpacity onPress={() => setHidden((h) => !h)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name={hidden ? 'eye-off-outline' : 'eye-outline'} size={16} color={c.textMuted} />
          </TouchableOpacity>
        </View>
        <Ionicons name="chevron-forward" size={16} color={c.textMuted} />
      </View>

      <Text style={styles.pfCaps}>CURRENT VALUE</Text>
      <Text style={styles.pfBig}>{fmt(currentValue)}</Text>

      <View style={styles.pfRow}>
        <View>
          <Text style={styles.pfCaps}>INVESTED VALUE</Text>
          <Text style={styles.pfSmall}>{fmt(investedValue)}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.pfCaps}>TOTAL RETURNS</Text>
          <Text style={[styles.pfSmall, { color: positive ? c.bull : c.bear }]}>
            {hidden
              ? '••••'
              : `${positive ? '+' : ''}${fmtNum(totalReturns, 2)} (${positive ? '+' : ''}${returnsPct.toFixed(2)}%)`}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

function TopMoversCard({ lived, navigation, styles, c }) {
  const [tab, setTab] = useState('Gainers');
  const list = useMemo(() => {
    const pool = [...(lived || [])];
    const sorters = {
      Gainers: (a, b) => (Number(b.change24h) || -Infinity) - (Number(a.change24h) || -Infinity),
      Losers: (a, b) => (Number(a.change24h) || Infinity) - (Number(b.change24h) || Infinity),
      'Most Active': (a, b) => (Number(b.volume24h) || 0) - (Number(a.volume24h) || 0),
    };
    return pool.sort(sorters[tab] || sorters.Gainers).slice(0, 3);
  }, [lived, tab]);

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Top Movers</Text>
      <View style={styles.tabRow}>
        {['Gainers', 'Losers', 'Most Active'].map((t) => {
          const on = tab === t;
          return (
            <TouchableOpacity key={t} activeOpacity={0.8} onPress={() => setTab(t)} style={[styles.tab, on && styles.tabOn]}>
              <Text style={[styles.tabTxt, on && styles.tabTxtOn]}>{t}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <View style={{ marginTop: 6 }}>
        {list.length === 0 && <Text style={styles.cardMuted}>Loading…</Text>}
        {list.map((r) => {
          const change = Number(r.change24h);
          const price = Number(r.lastPrice);
          const absChange = Number.isFinite(change) && Number.isFinite(price) ? (price * change) / 100 : NaN;
          const positive = Number.isFinite(change) ? change >= 0 : true;
          const prec = Math.min(Number(r.pricePrecision) || 2, 4);
          return (
            <TouchableOpacity
              key={r.symbol}
              activeOpacity={0.6}
              onPress={() => navigation.navigate('InstrumentDetail', { instrument: r })}
              style={styles.moverRow}
            >
              <AssetGlyph row={r} size={28} />
              <Text style={styles.moverSym} numberOfLines={1}>{r.symbol}</Text>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.moverPrice}>{fmtPrice(r.lastPrice, r.pricePrecision)}</Text>
                {Number.isFinite(change) && (
                  <Text style={[styles.moverChg, { color: positive ? c.bull : c.bear }]} numberOfLines={1}>
                    {positive ? '+' : ''}{fmtNum(Math.abs(absChange), prec)} ({positive ? '+' : ''}{change.toFixed(2)}%)
                  </Text>
                )}
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function EconomicCalendarCard({ styles, c }) {
  const [enabled, setEnabled] = useState(true);
  const [events, setEvents] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cfgRes, liveRes] = await Promise.all([
        api.get('/cms/economic-calendar').catch(() => null),
        api.get('/instruments/economic-calendar').catch(() => null),
      ]);
      if (cancelled) return;
      const cfg = cfgRes?.data?.data || {};
      const on = cfg.enabled !== false;
      const admin = Array.isArray(cfg.events) ? cfg.events.map(normAdminEvent).filter(Boolean) : [];
      const liveRows = Array.isArray(liveRes?.data?.data) ? liveRes.data.data : [];
      const live = liveRows
        .map((e) => ({
          id: e.id || `${e.event}-${e.date}`,
          date: new Date(e.date),
          country: e.country || '',
          impact: String(e.impact || 'medium').toLowerCase(),
          event: e.event || '',
        }))
        .filter((e) => !Number.isNaN(e.date.getTime()));
      const now = Date.now();
      const upcoming = [...live, ...admin]
        .filter((e) => e.date.getTime() >= now)
        .sort((a, b) => a.date - b.date)
        .slice(0, 4);
      setEnabled(on);
      setEvents(upcoming);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!enabled) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Economic Calendar</Text>
      <View style={{ marginTop: 6 }}>
        {events == null && <Text style={styles.cardMuted}>Loading…</Text>}
        {events != null && events.length === 0 && <Text style={styles.cardMuted}>No upcoming events.</Text>}
        {(events || []).map((e) => {
          const tone = ECON_IMPACT[e.impact] || ECON_IMPACT.medium;
          return (
            <View key={e.id} style={styles.econRow}>
              <View style={styles.econDate}>
                <Text style={styles.econMonth}>{econMonth(e.date)}</Text>
                <Text style={styles.econDay}>{e.date.getUTCDate()}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.econEvent} numberOfLines={1}>{e.event}</Text>
                <Text style={styles.econMeta} numberOfLines={1}>{flagFor(e.country)} {e.country} · {econTime(e.date)} UTC</Text>
              </View>
              <View style={[styles.impactPill, { backgroundColor: tone.color + '22' }]}>
                <Text style={[styles.impactTxt, { color: tone.color }]}>{tone.label}</Text>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function ExploreLinksCard({ setView, styles, c }) {
  const tiles = [
    { label: 'Crypto', tint: '#F7931A', icon: 'logo-bitcoin' },
    { label: 'Forex', tint: '#10B981', icon: 'cash-outline' },
    { label: 'Commodities', tint: '#D4A017', icon: 'diamond-outline' },
    { label: 'Indices', tint: '#3B82F6', icon: 'stats-chart-outline' },
  ];
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Explore</Text>
      <View style={styles.exploreGrid}>
        {tiles.map((t) => (
          <TouchableOpacity key={t.label} activeOpacity={0.8} style={styles.exploreTile} onPress={() => setView('most-traded')}>
            <View style={[styles.exploreIcon, { backgroundColor: t.tint + '22' }]}>
              <Ionicons name={t.icon} size={20} color={t.tint} />
            </View>
            <Text style={styles.exploreLabel} numberOfLines={1}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

// ─── Screen ────────────────────────────────────────────────────────────────
export default function MarketsScreen({ navigation }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState('most-traded');
  const [priceMap, setPriceMap] = useState({});

  // Mirror the web's useInstruments: catalog (/instruments) merged with the
  // live watchlist enrichment (/instruments/watchlist) by symbol.
  const load = useCallback(async () => {
    try {
      const [catRes, wlRes] = await Promise.all([
        api.get('/instruments'),
        api.get('/instruments/watchlist').catch(() => ({ data: { data: [] } })),
      ]);
      const catalog = catRes.data?.data || [];
      const watch = wlRes.data?.data || [];
      const wlBySymbol = new Map(watch.map((r) => [r.symbol, r]));
      const merged = catalog.map((r) => {
        const wl = wlBySymbol.get(r.symbol);
        if (!wl) return r;
        return {
          ...r,
          lastPrice: wl.lastPrice ?? r.lastPrice,
          bid: wl.bid,
          ask: wl.ask,
          spread: wl.spread,
          dayHigh: wl.dayHigh,
          dayLow: wl.dayLow,
          change24h: wl.change24h,
          volume24h: wl.volume24h ?? r.volume24h,
        };
      });
      setRows(merged);
      setErr('');
    } catch (e) {
      setErr(errorMessage(e));
      setRows((r) => r || []);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  // Live WS subs for every instrument we render (mirrors the web).
  const symbolsKey = useMemo(() => (rows || []).map((r) => r.symbol).sort().join('|'), [rows]);
  useEffect(() => {
    if (!symbolsKey) return undefined;
    const symbols = symbolsKey.split('|').filter(Boolean);
    const unsubs = symbols.map((sym) =>
      wsClient.subscribe(`ticker:${sym}`, (data) => {
        const last = Number(data?.lastPrice);
        if (!Number.isFinite(last) || last <= 0) return;
        setPriceMap((prev) => (prev[sym] === String(last) ? prev : { ...prev, [sym]: String(last) }));
      }),
    );
    return () => unsubs.forEach((u) => u && u());
  }, [symbolsKey]);

  const lived = useMemo(
    () => (rows || []).map((r) => (priceMap[r.symbol] ? { ...r, lastPrice: priceMap[r.symbol] } : r)),
    [rows, priceMap],
  );

  const isSectors = view === 'sectors';
  const listData = useMemo(() => {
    if (isSectors) {
      return SECTOR_DEFS
        .map((s) => {
          const matches = lived.filter(s.match);
          if (!matches.length) return null;
          const changes = matches.map((r) => Number(r.change24h)).filter(Number.isFinite);
          const perf = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
          const gainers = matches.filter((r) => Number(r.change24h) > 0).length;
          const losers = matches.filter((r) => Number(r.change24h) < 0).length;
          const top = [...matches].sort((a, b) => (Number(b.change24h) || 0) - (Number(a.change24h) || 0))[0];
          return { ...s, matches, perf, gainers, losers, top };
        })
        .filter(Boolean)
        .sort((a, b) => b.perf - a.perf);
    }
    const cfg = VIEWS[view] || VIEWS['most-traded'];
    return [...lived].sort(cfg.sort);
  }, [lived, view, isSectors]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  if (rows == null) return <Loader label="Loading markets…" />;
  if (err && rows.length === 0) return <Empty title="Couldn't load markets" sub={err} />;

  const cfg = VIEWS[view] || VIEWS['most-traded'];

  const ListHeader = (
    <View style={styles.headWrap}>
      <Text style={styles.headTitle}>{cfg.title}</Text>
      <Text style={styles.headCaption}>{cfg.caption}</Text>
      <View style={styles.colHead}>
        {isSectors ? (
          <>
            <Text style={styles.colHeadTxt}>Sector</Text>
            <Text style={[styles.colHeadTxt, { textAlign: 'right' }]}>Gainers/Losers · 1D%</Text>
          </>
        ) : (
          <>
            <Text style={styles.colHeadTxt}>Company</Text>
            <Text style={[styles.colHeadTxt, { textAlign: 'right' }]}>Market Price (1D) · Volume</Text>
          </>
        )}
      </View>
    </View>
  );

  const ListFooter = (
    <View style={styles.footerWrap}>
      <PortfolioCard navigation={navigation} styles={styles} c={c} />
      <TopMoversCard lived={lived} navigation={navigation} styles={styles} c={c} />
      <EconomicCalendarCard styles={styles} c={c} />
      <ExploreLinksCard setView={setView} styles={styles} c={c} />
    </View>
  );

  return (
    <View style={styles.screen}>
      <Segmented view={view} setView={setView} styles={styles} c={c} />
      <FlashList
        data={listData}
        extraData={[view, c]}
        keyExtractor={(item) => item.symbol || item.key}
        getItemType={() => (isSectors ? 'sector' : 'market')}
        estimatedItemSize={68}
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary500} />}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        ListHeaderComponent={ListHeader}
        ListFooterComponent={ListFooter}
        ListEmptyComponent={<Empty title={isSectors ? 'No sectors available.' : 'No instruments available.'} />}
        renderItem={({ item, index }) =>
          isSectors ? (
            <SectorRow
              item={item}
              onPress={() => item.top?.symbol && navigation.navigate('InstrumentDetail', { instrument: item.top })}
              styles={styles}
              c={c}
            />
          ) : (
            <MarketRow
              item={item}
              idx={index}
              onPress={() => navigation.navigate('InstrumentDetail', { instrument: item })}
              styles={styles}
              c={c}
            />
          )
        }
      />
    </View>
  );
}

const makeStyles = (c) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },

  // Segmented control (fixed above the list)
  segBar: { borderBottomWidth: 1, borderBottomColor: c.borderSubtle, backgroundColor: c.bg },
  segScroll: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  seg: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, marginRight: 8 },
  segOn: { borderColor: c.primary500, backgroundColor: c.primarySoft },
  segTxt: { fontSize: 13, fontWeight: '700', color: c.textSecondary },
  segTxtOn: { color: c.primary500 },

  // List header
  headWrap: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  headTitle: { fontSize: 20, fontWeight: '900', color: c.textPrimary },
  headCaption: { fontSize: 12, color: c.textMuted, marginTop: 3 },
  colHead: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  colHeadTxt: { fontSize: 11, color: c.textMuted, fontWeight: '600', flex: 1 },

  // Rows (shared by market + sector rows)
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: c.bg },
  sep: { height: 1, backgroundColor: c.borderSubtle, marginLeft: 16 },
  rowMain: { flex: 1, minWidth: 0, marginLeft: 12 },
  rowName: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
  rowSym: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  rowSpark: { marginHorizontal: 8 },
  rowRight: { alignItems: 'flex-end', minWidth: 96 },
  rowPrice: { fontSize: 14, fontWeight: '800', color: c.textPrimary, fontVariant: ['tabular-nums'] },
  rowChg: { fontSize: 11, fontWeight: '700', marginTop: 2, fontVariant: ['tabular-nums'] },
  rowVol: { fontSize: 10, color: c.textMuted, marginTop: 2, fontVariant: ['tabular-nums'] },

  // Sector row
  sectorTile: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  sectorTileTxt: { fontSize: 16, fontWeight: '800' },
  glBox: { width: 84, marginHorizontal: 8 },
  glNums: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  glNum: { fontSize: 13, fontWeight: '800' },
  glTrack: { flexDirection: 'row', height: 3, borderRadius: 2, overflow: 'hidden', backgroundColor: c.hover },
  sectorPerf: { fontSize: 13, fontWeight: '800', minWidth: 60, textAlign: 'right', fontVariant: ['tabular-nums'] },

  // Cards (footer stack)
  footerWrap: { padding: 16, gap: 12 },
  card: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.xl, padding: 16 },
  cardTitle: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
  cardMuted: { fontSize: 12, color: c.textMuted, paddingVertical: 8 },

  // Portfolio card
  pfHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pfCaps: { fontSize: 10, fontWeight: '700', color: c.textMuted, letterSpacing: 0.5, marginTop: 12 },
  pfBig: { fontSize: 24, fontWeight: '900', color: c.textPrimary, marginTop: 2, fontVariant: ['tabular-nums'] },
  pfRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 4 },
  pfSmall: { fontSize: 14, fontWeight: '800', color: c.textPrimary, marginTop: 2, fontVariant: ['tabular-nums'] },

  // Top movers card
  tabRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  tab: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg },
  tabOn: { borderColor: c.primary500, backgroundColor: c.primarySoft },
  tabTxt: { fontSize: 12, fontWeight: '700', color: c.textSecondary },
  tabTxtOn: { color: c.primary500 },
  moverRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  moverSym: { flex: 1, fontSize: 14, fontWeight: '700', color: c.textPrimary },
  moverPrice: { fontSize: 14, fontWeight: '700', color: c.textPrimary, fontVariant: ['tabular-nums'] },
  moverChg: { fontSize: 11, fontWeight: '700', marginTop: 2, fontVariant: ['tabular-nums'] },

  // Economic calendar card
  econRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  econDate: { width: 44, alignItems: 'center', backgroundColor: c.bg, borderWidth: 1, borderColor: c.borderSubtle, borderRadius: radius.md, paddingVertical: 4 },
  econMonth: { fontSize: 9, fontWeight: '700', color: c.textMuted, letterSpacing: 0.5 },
  econDay: { fontSize: 15, fontWeight: '800', color: c.textPrimary },
  econEvent: { fontSize: 13, color: c.textPrimary, fontWeight: '600' },
  econMeta: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  impactPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  impactTxt: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },

  // Explore card
  exploreGrid: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 },
  exploreTile: { flex: 1, alignItems: 'center', gap: 6 },
  exploreIcon: { width: 48, height: 48, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  exploreLabel: { fontSize: 11, fontWeight: '600', color: c.textSecondary },
});
