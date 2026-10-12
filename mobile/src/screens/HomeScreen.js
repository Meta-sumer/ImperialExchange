import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Image, RefreshControl, Alert, StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path, Line, Rect, Circle } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { DrawerActions } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { useAuth } from '../store/auth';
import { useAccounts } from '../store/account';
import { useColors, useTheme, useThemeMode, radius, fmtNum } from '../theme';

/**
 * HomeScreen — a FAITHFUL, COMPLETE native port of the web client's Explore
 * page (client/src/pages/Explore.jsx) plus the web Layout's brand header +
 * primary-nav strip (client/src/components/Layout.jsx). Mirrors the web's OWN
 * mobile/responsive layout: single column, tables collapse into card rows,
 * horizontal rails become <ScrollView horizontal>. Sections, top → bottom:
 *   1. Custom header  — brand logo (T + PRO) · search · theme toggle · bell · avatar
 *   2. Primary nav    — Explore(active) · Watchlist · F&O · Portfolio · Wallets · Copy Trading
 *   3. Recently viewed
 *   4. Most traded
 *   5. Market movers  (tabs + category filter + sector filter)
 *   6. Sectors trending today
 *   7. Your activity  (Positions / Pending Orders + close / cancel + bulk)
 *   8. Products & Tools
 *   9. Economic Calendar (real backend feeds, gated by the admin enabled flag)
 * Same API endpoints the web calls; live prices seeded from REST then updated
 * over the SAME wsClient ticker/positions/orders channels. Real data only.
 * Fully theme-reactive (light + dark) via useColors() + makeStyles(c).
 */

const RECENT_KEY = 'tradepro:recently-viewed';

// ─── Primary nav (mirrors web PRIMARY_NAV) — Explore is the current screen ──
const NAV = [
  { key: 'Explore', label: 'Explore', route: null },
  { key: 'Watchlist', label: 'Watchlist', route: 'Watchlist' },
  { key: 'Portfolio', label: 'Portfolio', route: 'Portfolio' },
  { key: 'Wallet', label: 'Wallets', route: 'Wallet' },
  { key: 'Copy', label: 'Copy Trading', route: 'Copy' },
];

const MOVER_TABS = ['Gainers', 'Losers', 'Most Active', 'Trending'];
const MOVER_CATS = [
  { key: '', label: 'All' },
  { key: 'FOREX', label: 'Forex' },
  { key: 'CRYPTO', label: 'Crypto' },
  { key: 'COMMODITY', label: 'Commodities' },
  { key: 'INDEX', label: 'Indices' },
  { key: 'STOCK', label: 'Stocks' },
];

// ─── Asset glyph catalog (kept in sync with the web AssetIcon / other screens) ─
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

// ─── Sectors — grounded in the real backend `category` enum (mirrors web) ──
const catOf = (r) => (r.category || '').toUpperCase();
const isCrypto = (r) => catOf(r) === 'CRYPTO';
const isForex = (r) => catOf(r) === 'FOREX';
const isCommodity = (r) => catOf(r) === 'COMMODITY';
const isIndex = (r) => catOf(r) === 'INDEX';
const isStock = (r) => catOf(r) === 'STOCK';
const MAJOR_CCY = new Set(['EUR', 'GBP', 'USD', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD']);
const SECTOR_DEFS = [
  { key: 'crypto', label: 'Crypto', tint: '#F7931A', icon: 'logo-bitcoin', match: isCrypto },
  { key: 'forex', label: 'Forex', tint: '#10B981', icon: 'cash-outline', match: isForex },
  { key: 'majors', label: 'Forex Majors', tint: '#0EA5E9', icon: 'swap-horizontal-outline',
    match: (r) => isForex(r)
      && MAJOR_CCY.has((r.baseCurrency || '').toUpperCase())
      && MAJOR_CCY.has((r.quoteCurrency || '').toUpperCase()) },
  { key: 'comm', label: 'Commodities', tint: '#A16207', icon: 'flame-outline', match: isCommodity },
  { key: 'gold', label: 'Precious Metals', tint: '#D4A017', icon: 'diamond-outline',
    match: (r) => isCommodity(r) && ['XAU', 'XAG'].includes((r.baseCurrency || '').toUpperCase()) },
  { key: 'indices', label: 'Indices', tint: '#3B82F6', icon: 'stats-chart-outline', match: isIndex },
  { key: 'stocks', label: 'Stocks', tint: '#8B5CF6', icon: 'business-outline', match: isStock },
];

// ─── Products & Tools — link rows to the mobile screens (mirrors web PRODUCTS) ─
const PRODUCTS = [
  { route: 'Profile', label: 'Trading Account', caption: 'Manage demo & real accounts', icon: 'person-circle-outline', tint: '#1D4ED8' },
  { route: 'Wallet', label: 'Funds', caption: 'Deposit & withdraw', icon: 'cash-outline', tint: '#10B981' },
  { route: 'Partner', label: 'IB Room', caption: 'Partner & copy-trading hub', icon: 'people-outline', tint: '#2563EB' },
  { route: 'Plans', label: 'Plans & Pricing', caption: 'Compare account tiers', icon: 'diamond-outline', tint: '#8B5CF6' },
  { route: 'Support', label: 'Helpdesk', caption: 'Talk to our support team', icon: 'headset-outline', tint: '#EC4899' },
  { route: 'Alerts', label: 'Signals & Alerts', caption: 'Price-based entry alerts', icon: 'notifications-outline', tint: '#3B82F6' },
  { route: 'Trade', label: 'Trading Terminal', caption: 'Open the pro chart', icon: 'grid-outline', tint: '#0EA5E9' },
];

// ─── Economic calendar helpers ─────────────────────────────────────────────
const ECON_IMPACT = {
  high: { color: '#DC2626', label: 'High' },
  medium: { color: '#3B82F6', label: 'Med' },
  low: { color: '#9CA3AF', label: 'Low' },
};
const FLAGS = {
  US: '🇺🇸', EU: '🇪🇺', GB: '🇬🇧', JP: '🇯🇵', CA: '🇨🇦', AU: '🇦🇺', NZ: '🇳🇿',
  CH: '🇨🇭', CN: '🇨🇳', IN: '🇮🇳', KR: '🇰🇷', SG: '🇸🇬', TR: '🇹🇷', BR: '🇧🇷',
};
const flagFor = (co) => FLAGS[co] || '🌐';
const econTime = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
const econDayLong = (d) => d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
function normEconEvent(e) {
  const date = new Date(e.date);
  if (Number.isNaN(date.getTime())) return null;
  let impact = String(e.impact || '').toLowerCase();
  if (impact === 'lowest') impact = 'low';
  if (!['high', 'medium', 'low'].includes(impact)) impact = 'medium';
  const label = (v, lbl) => {
    if (lbl != null && lbl !== '' && lbl !== '—') return String(lbl);
    if (v == null || v === '') return null;
    return String(v);
  };
  return {
    id: e.id || `${e.event}-${e.date}`,
    date,
    country: e.country || '',
    impact,
    event: e.event || '',
    actualLabel: label(e.actual, e.actualLabel),
    previousLabel: label(e.previous, e.previousLabel),
  };
}

// ─── Number + spark helpers (pure — no styles/colors at module scope) ──────
function synthSpark(change, seed = 0) {
  const ch = Number(change);
  const dir = !Number.isFinite(ch) ? 0 : ch >= 0 ? 1 : -1;
  const N = 16;
  const start = 50 - dir * 12;
  const end = 50 + dir * 12;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const wiggle = Math.sin((i + seed) * 1.3) * 3;
    pts.push(start + (end - start) * t + wiggle);
  }
  return pts;
}
function fmtVolume(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}
function fmtPrice(raw, precision) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return '—';
  return fmtNum(v, Math.min(Number(precision) || 2, 6));
}

// ─── Presentational pieces (receive styles / c via props — never module `c`) ─
function AssetGlyph({ row, size = 40 }) {
  const logo = row?.logoUrl;
  const [failed, setFailed] = useState(false);
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

function Sparkline({ change, seed = 0, width = 70, height = 26, c }) {
  const pts = synthSpark(change, seed);
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = Math.max(max - min, 1);
  const step = width / (pts.length - 1);
  const d = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(1)} ${(height - ((p - min) / span) * (height - 4) - 2).toFixed(1)}`)
    .join(' ');
  const ch = Number(change);
  const positive = Number.isFinite(ch) ? ch >= 0 : true;
  const tone = positive ? c.bull : c.bear;
  return (
    <Svg width={width} height={height}>
      <Path d={`${d} L ${width} ${height} L 0 ${height} Z`} fill={tone} fillOpacity={0.12} />
      <Path d={d} fill="none" stroke={tone} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function ChangePill({ value, c, styles }) {
  if (!Number.isFinite(value)) return <Text style={styles.pillDash}>—</Text>;
  const positive = value >= 0;
  const tone = positive ? c.bull : c.bear;
  return (
    <View style={[styles.chgPill, { backgroundColor: positive ? c.bullSoft : c.bearSoft }]}>
      <Ionicons name={positive ? 'caret-up' : 'caret-down'} size={9} color={tone} />
      <Text style={{ fontSize: 11, fontWeight: '800', color: tone }}>{positive ? '+' : ''}{value.toFixed(2)}%</Text>
    </View>
  );
}

// Groww-style change display: "+1.68 (9.41%)" with colour, no chip background.
function ChangeText({ absChange, pct, precision, c }) {
  if (!Number.isFinite(pct)) return <Text style={{ fontSize: 12, color: c.textMuted }}>—</Text>;
  const positive = pct >= 0;
  const color = positive ? c.bull : c.bear;
  const absStr = Number.isFinite(absChange) ? fmtNum(Math.abs(absChange), Math.min(Number(precision) || 2, 4)) : '—';
  return (
    <Text style={{ fontSize: 13, fontWeight: '800', color }}>
      {positive ? '+' : '-'}{absStr} <Text style={{ fontWeight: '600' }}>({positive ? '+' : '-'}{Math.abs(pct).toFixed(2)}%)</Text>
    </Text>
  );
}

// Horizontal split bar: gainers (green) vs losers (red) with counts above.
function GainersLosersBar({ gainers, losers, c, styles }) {
  const g = gainers || 0;
  const l = losers || 0;
  return (
    <View style={styles.glBox}>
      <View style={styles.glNums}>
        <Text style={[styles.glNum, { color: c.bull }]}>{g}</Text>
        <Text style={[styles.glNum, { color: c.bear }]}>{l}</Text>
      </View>
      <View style={styles.glTrack}>
        <View style={{ flex: g || 1, backgroundColor: c.bull }} />
        <View style={{ flex: l || 1, backgroundColor: c.bear }} />
      </View>
    </View>
  );
}

function SectionHeader({ title, caption, actionLabel, onAction, styles, c }) {
  return (
    <View style={styles.secHeadRow}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.h2}>{title}</Text>
        {caption ? <Text style={styles.secCaption}>{caption}</Text> : null}
      </View>
      {actionLabel ? (
        <TouchableOpacity onPress={onAction} activeOpacity={0.7} style={styles.linkRow}>
          <Text style={styles.linkTxt}>{actionLabel}</Text>
          <Ionicons name="chevron-forward" size={13} color={c.primary500} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

// Forex/crypto-themed empty-state illustration (ported from the web).
function InvestmentsIllustration({ c }) {
  return (
    <Svg width={182} height={110} viewBox="0 0 200 120">
      <Line x1="10" y1="35" x2="190" y2="35" stroke={c.borderSubtle} strokeWidth={1} strokeDasharray="2 3" />
      <Line x1="10" y1="60" x2="190" y2="60" stroke={c.borderSubtle} strokeWidth={1} strokeDasharray="2 3" />
      <Line x1="10" y1="85" x2="190" y2="85" stroke={c.borderSubtle} strokeWidth={1} strokeDasharray="2 3" />
      <Line x1="55" y1="38" x2="55" y2="78" stroke={c.bull} strokeWidth={1.5} strokeLinecap="round" />
      <Rect x="50" y="55" width="10" height="20" rx="1.5" fill={c.bull} />
      <Line x1="75" y1="42" x2="75" y2="86" stroke={c.bear} strokeWidth={1.5} strokeLinecap="round" />
      <Rect x="70" y="55" width="10" height="22" rx="1.5" fill={c.bear} />
      <Line x1="95" y1="28" x2="95" y2="78" stroke={c.bull} strokeWidth={1.5} strokeLinecap="round" />
      <Rect x="90" y="38" width="10" height="32" rx="1.5" fill={c.bull} />
      <Line x1="115" y1="32" x2="115" y2="62" stroke={c.bear} strokeWidth={1.5} strokeLinecap="round" />
      <Rect x="110" y="40" width="10" height="14" rx="1.5" fill={c.bear} />
      <Line x1="135" y1="18" x2="135" y2="58" stroke={c.bull} strokeWidth={1.5} strokeLinecap="round" />
      <Rect x="130" y="22" width="10" height="28" rx="1.5" fill={c.bull} />
      <Path d="M50 70 L75 65 L95 50 L115 45 L135 28" stroke={c.primary500} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Circle cx="135" cy="28" r="3" fill={c.primary500} />
      <Circle cx="22" cy="40" r="13" fill="#F7931A" />
      <Rect x="158" y="80" width="34" height="20" rx="10" fill={c.primary500} />
    </Svg>
  );
}

// ─── Header (brand logo + search + theme toggle + bell + avatar) ───────────
function Header({ styles, c, dark, initials, navigation, setMode }) {
  return (
    <View style={styles.header}>
      <View style={styles.brandWrap}>
        <View style={styles.logo}>
          <Text style={styles.logoT}>T</Text>
          <View style={styles.proBadge}><Text style={styles.proBadgeTxt}>PRO</Text></View>
        </View>
        <View>
          <Text style={styles.brandName}>Frexever</Text>
          <Text style={styles.brandSub}>PRO</Text>
        </View>
      </View>
      <View style={styles.hRight}>
        <TouchableOpacity onPress={() => navigation.navigate('Markets')} hitSlop={8} style={styles.iconBtn}>
          <Ionicons name="search" size={21} color={c.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setMode(dark ? 'light' : 'dark')} hitSlop={8} style={styles.iconBtn}>
          <Ionicons name={dark ? 'sunny-outline' : 'moon-outline'} size={20} color={c.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => navigation.navigate('Notifications')} hitSlop={8} style={styles.iconBtn}>
          <Ionicons name="notifications-outline" size={20} color={c.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => navigation.dispatch(DrawerActions.openDrawer())} hitSlop={8} style={styles.avatar}>
          <Text style={styles.avatarT}>{initials}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Primary-nav strip (horizontal scroll; Explore is active) ──────────────
function PrimaryNav({ styles, c, navigation, scrollRef }) {
  return (
    <View style={styles.navStrip}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.navScroll}>
        {NAV.map((item) => {
          const active = item.route == null;
          return (
            <TouchableOpacity
              key={item.key}
              activeOpacity={0.8}
              onPress={() => (item.route ? navigation.navigate(item.route) : scrollRef.current?.scrollTo({ y: 0, animated: true }))}
              style={[styles.navPill, active && styles.navPillOn]}
            >
              <Text style={[styles.navPillTxt, active && styles.navPillTxtOn]}>{item.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

// ─── Screen ────────────────────────────────────────────────────────────────
export default function HomeScreen({ navigation }) {
  const c = useColors();
  const { dark } = useTheme();
  const setMode = useThemeMode((s) => s.setMode);
  const styles = useMemo(() => makeStyles(c), [c]);

  const user = useAuth((s) => s.user);
  const selectedId = useAccounts((s) => s.selectedId);
  const initials = ([user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'T')
    .split(' ').map((s) => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

  const scrollRef = useRef(null);
  const moversY = useRef(0);
  const accountIdRef = useRef(null);

  const [instruments, setInstruments] = useState(null); // null = loading
  const [priceMap, setPriceMap] = useState({});          // sym -> { last, change }
  const [recent, setRecent] = useState([]);
  const [positions, setPositions] = useState([]);
  const [orders, setOrders] = useState([]);
  const [watchlists, setWatchlists] = useState([]);
  const [savedSet, setSavedSet] = useState(() => new Set());

  const [moverTab, setMoverTab] = useState('Gainers');
  const [moverCats, setMoverCats] = useState([]);   // [] = all categories
  const [selectedSector, setSelectedSector] = useState(null);
  const [activityTab, setActivityTab] = useState('positions');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [econEnabled, setEconEnabled] = useState(true);
  const [econGroups, setEconGroups] = useState(null); // null = loading, [] = none

  const loading = instruments == null;

  useEffect(() => { accountIdRef.current = selectedId || null; }, [selectedId]);

  // ── Instrument catalog: /instruments merged with /instruments/watchlist ──
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
      }));
    } catch (_) {
      setInstruments((r) => r || []);
    }
  }, []);

  const loadRecent = useCallback(async () => {
    try { const raw = await AsyncStorage.getItem(RECENT_KEY); setRecent(raw ? JSON.parse(raw) : []); } catch (_) { setRecent([]); }
  }, []);

  const loadWatchlists = useCallback(async () => {
    try {
      const { data } = await api.get('/watchlists');
      const lists = data?.data?.watchlists || [];
      setWatchlists(lists);
      const s = new Set();
      lists.forEach((l) => (l.items || []).forEach((it) => s.add(it.symbol)));
      setSavedSet(s);
    } catch (_) { /* keep prior */ }
  }, []);

  const loadEconomic = useCallback(async () => {
    try {
      const [cfgRes, liveRes] = await Promise.all([
        api.get('/cms/economic-calendar').catch(() => null),
        api.get('/instruments/economic-calendar').catch(() => null),
      ]);
      const cfg = cfgRes?.data?.data || {};
      const on = cfg.enabled !== false;
      const admin = Array.isArray(cfg.events) ? cfg.events.map(normEconEvent).filter(Boolean) : [];
      const liveRows = Array.isArray(liveRes?.data?.data) ? liveRes.data.data : [];
      const live = liveRows.map(normEconEvent).filter(Boolean);
      const now = Date.now();
      const startOfToday = new Date(); startOfToday.setUTCHours(0, 0, 0, 0);
      const winStart = startOfToday.getTime() - 3 * 864e5;   // lookback 3d
      const winEnd = now + 14 * 864e5;                        // lookahead 14d
      const merged = [...live, ...admin]
        .filter((e) => e.date.getTime() >= winStart && e.date.getTime() <= winEnd)
        .sort((a, b) => a.date - b.date)
        .slice(0, 12);
      // Group by UTC day.
      const map = new Map();
      for (const e of merged) {
        const key = e.date.toISOString().slice(0, 10);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(e);
      }
      setEconEnabled(on);
      setEconGroups([...map.entries()].map(([key, rows]) => ({ key, rows })));
    } catch (_) {
      setEconGroups([]);
    }
  }, []);

  const loadActivity = useCallback(async () => {
    const accId = accountIdRef.current;
    const params = accId ? { accountId: accId } : {};
    const [p, o] = await Promise.all([
      api.get('/trading/positions', { params }).then((r) => r.data?.data || []).catch(() => []),
      api.get('/trading/orders/open', { params }).then((r) => r.data?.data || []).catch(() => []),
    ]);
    if (accId !== accountIdRef.current) return; // account switched mid-flight
    const scoped = (arr) => {
      const list = Array.isArray(arr) ? arr : [];
      if (!accId) return list;
      return list.filter((x) => !x.accountId || String(x.accountId) === String(accId));
    };
    setPositions(scoped(p));
    setOrders(scoped(o));
  }, []);

  // Mount loads + 30s catalog revalidation (mirrors the web SWR TTL).
  useEffect(() => { loadInstruments(); loadRecent(); loadWatchlists(); loadEconomic(); }, [loadInstruments, loadRecent, loadWatchlists, loadEconomic]);
  useEffect(() => { const id = setInterval(loadInstruments, 30000); return () => clearInterval(id); }, [loadInstruments]);
  useEffect(() => navigation.addListener('focus', loadRecent), [navigation, loadRecent]);

  // Activity re-scopes on account switch + refetches on positions/orders events.
  useEffect(() => {
    setPositions([]); setOrders([]);
    loadActivity();
    const a = wsClient.subscribe('user:positions', loadActivity);
    const b = wsClient.subscribe('user:orders', loadActivity);
    return () => { a && a(); b && b(); };
  }, [selectedId, loadActivity]);

  // ── Live tickers for every instrument + every open position / order ──
  const tickerKey = useMemo(() => {
    const s = new Set();
    (instruments || []).forEach((r) => r.symbol && s.add(r.symbol));
    positions.forEach((p) => p.symbol && s.add(p.symbol));
    orders.forEach((o) => o.symbol && s.add(o.symbol));
    return [...s].sort().join('|');
  }, [instruments, positions, orders]);

  useEffect(() => {
    if (!tickerKey) return undefined;
    const syms = tickerKey.split('|').filter(Boolean);
    const unsubs = syms.map((sym) => wsClient.subscribe(`ticker:${sym}`, (data) => {
      const last = Number(data?.lastPrice);
      if (!Number.isFinite(last) || last <= 0) return;
      const change = Number(data?.change24h);
      setPriceMap((prev) => {
        const cur = prev[sym];
        const nextLast = String(last);
        const nextChange = Number.isFinite(change) ? change : (cur ? cur.change : undefined);
        if (cur && cur.last === nextLast && cur.change === nextChange) return prev;
        return { ...prev, [sym]: { last: nextLast, change: nextChange } };
      });
    }));
    return () => unsubs.forEach((u) => u && u());
  }, [tickerKey]);

  // ── Instruments with LIVE price + recomputed 24h % (mirrors the web) ──
  const lived = useMemo(() => (instruments || []).map((r) => {
    const live = priceMap[r.symbol];
    if (!live) return r;
    const out = { ...r, lastPrice: live.last };
    const liveLast = Number(live.last);
    if (Number.isFinite(live.change)) {
      out.change24h = live.change;
    } else if (Number.isFinite(liveLast) && liveLast > 0) {
      const ch0 = Number(r.change24h);
      const last0 = Number(r.lastPrice);
      if (Number.isFinite(ch0) && Number.isFinite(last0) && last0 > 0) {
        const base = last0 / (1 + ch0 / 100);
        if (base > 0) out.change24h = ((liveLast - base) / base) * 100;
      }
    }
    return out;
  }), [instruments, priceMap]);

  const instBySym = useMemo(() => new Map(lived.map((r) => [r.symbol, r])), [lived]);

  const recentInsts = useMemo(
    () => recent.map((s) => lived.find((r) => r.symbol === s)).filter(Boolean).slice(0, 12),
    [recent, lived],
  );

  const mostTraded = useMemo(() => {
    const ranked = [...lived].sort((a, b) => {
      const va = Number(a.volume24h) || 0;
      const vb = Number(b.volume24h) || 0;
      if (vb !== va) return vb - va;
      return Math.abs(Number(b.change24h) || 0) - Math.abs(Number(a.change24h) || 0);
    });
    return ranked.slice(0, 4);
  }, [lived]);

  const sectors = useMemo(() => SECTOR_DEFS
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
    .sort((a, b) => b.perf - a.perf), [lived]);

  const movers = useMemo(() => {
    let pool = lived;
    if (selectedSector) pool = pool.filter(selectedSector.match);
    if (moverCats.length) pool = pool.filter((m) => moverCats.includes(String(m.category || '').toUpperCase()));
    const sortFns = {
      Gainers: (a, b) => (Number(b.change24h) || -Infinity) - (Number(a.change24h) || -Infinity),
      Losers: (a, b) => (Number(a.change24h) || Infinity) - (Number(b.change24h) || Infinity),
      'Most Active': (a, b) => (Number(b.volume24h) || 0) - (Number(a.volume24h) || 0),
      Trending: (a, b) => Math.abs(Number(b.change24h) || 0) - Math.abs(Number(a.change24h) || 0),
    };
    return [...pool].sort(sortFns[moverTab] || sortFns.Gainers).slice(0, 8);
  }, [lived, moverTab, selectedSector, moverCats]);

  const livePositions = useMemo(() => positions.map((p) => {
    const markPx = Number(priceMap[p.symbol]?.last ?? p.markPrice ?? p.entryPrice);
    const entry = Number(p.entryPrice);
    const qty = Number(p.quantity);
    if (!Number.isFinite(entry) || !Number.isFinite(qty) || !Number.isFinite(markPx)) {
      return { ...p, markPrice: markPx || 0, unrealizedPnl: 0 };
    }
    const livePnl = String(p.side).toUpperCase() === 'BUY' ? (markPx - entry) * qty : (entry - markPx) * qty;
    return { ...p, markPrice: markPx, unrealizedPnl: livePnl };
  }), [positions, priceMap]);

  // ── Actions ──
  const openStock = useCallback(async (inst) => {
    try {
      const raw = await AsyncStorage.getItem(RECENT_KEY);
      const next = [inst.symbol, ...(raw ? JSON.parse(raw) : []).filter((s) => s !== inst.symbol)].slice(0, 12);
      await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(next));
      setRecent(next);
    } catch (_) { /* private mode */ }
    navigation.navigate('InstrumentDetail', { instrument: inst });
  }, [navigation]);

  const toggleMoverCat = (key) => {
    if (key === '') { setMoverCats([]); return; }
    setMoverCats((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const toggleSector = (s) => {
    setSelectedSector((cur) => (cur?.key === s.key ? null : s));
    setTimeout(() => scrollRef.current?.scrollTo({ y: Math.max(moversY.current - 8, 0), animated: true }), 60);
  };

  const toggleWatch = useCallback(async (symbol) => {
    if (!symbol) return;
    if (!watchlists.length) { navigation.navigate('Watchlist'); return; }
    const saved = savedSet.has(symbol);
    setSavedSet((prev) => { const n = new Set(prev); if (saved) n.delete(symbol); else n.add(symbol); return n; });
    try {
      if (saved) {
        const targets = watchlists.filter((l) => (l.items || []).some((it) => it.symbol === symbol));
        await Promise.all(targets.flatMap((l) => (l.items || [])
          .filter((it) => it.symbol === symbol)
          .map((it) => api.delete(`/watchlists/${l._id}/items/${it._id}`))));
      } else {
        const target = watchlists.find((l) => l.isDefault) || watchlists[0];
        await api.post(`/watchlists/${target._id}/items/bulk`, { symbols: [symbol] });
      }
      loadWatchlists();
    } catch (e) {
      setSavedSet((prev) => { const n = new Set(prev); if (saved) n.add(symbol); else n.delete(symbol); return n; });
      Alert.alert('Watchlist', errorMessage(e));
    }
  }, [watchlists, savedSet, navigation, loadWatchlists]);

  const closePosition = async (id) => {
    const prev = positions;
    setPositions((list) => list.filter((p) => p._id !== id));
    try { await api.post(`/trading/positions/${id}/close`); }
    catch (e) { setPositions(prev); Alert.alert('Close position', errorMessage(e)); }
  };
  const closeAllPositions = () => {
    if (!livePositions.length) return;
    Alert.alert('Close all positions', `Close all ${livePositions.length} open position(s)?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Close All', style: 'destructive', onPress: async () => {
        setBulkBusy(true);
        const prev = positions;
        const accountId = selectedId || livePositions[0]?.accountId;
        setPositions([]);
        try {
          const { data } = await api.post('/trading/positions/close-all', accountId ? { accountId } : {});
          const r = data?.data || {};
          if (r.failed?.length) { setPositions(prev); Alert.alert('Close all', `Closed ${r.closed}/${r.total}. ${r.failed.length} failed.`); }
        } catch (e) { setPositions(prev); Alert.alert('Close all', errorMessage(e)); }
        finally { setBulkBusy(false); }
      } },
    ]);
  };
  const cancelOrder = async (id) => {
    const prev = orders;
    setOrders((list) => list.filter((o) => o._id !== id));
    try { await api.delete(`/trading/orders/${id}`); }
    catch (e) { setOrders(prev); Alert.alert('Cancel order', errorMessage(e)); }
  };
  const cancelAllOrders = () => {
    if (!orders.length) return;
    Alert.alert('Cancel all orders', `Cancel all ${orders.length} pending order(s)?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Cancel All', style: 'destructive', onPress: async () => {
        setBulkBusy(true);
        const prev = orders;
        setOrders([]);
        const results = await Promise.allSettled(prev.map((o) => api.delete(`/trading/orders/${o._id}`)));
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        const failed = results.length - ok;
        if (failed) {
          setOrders(prev.filter((_, i) => results[i].status !== 'fulfilled'));
          Alert.alert('Cancel all', `Cancelled ${ok}/${results.length}. ${failed} failed.`);
        }
        setBulkBusy(false);
      } },
    ]);
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadInstruments(), loadRecent(), loadWatchlists(), loadEconomic(), loadActivity()]);
    setRefreshing(false);
  };

  return (
    <View style={styles.screen}>
      {/* ── Fixed chrome: custom header + primary-nav strip ── */}
      <SafeAreaView edges={['top']} style={{ backgroundColor: c.bg }}>
        <Header styles={styles} c={c} dark={dark} initials={initials} navigation={navigation} setMode={setMode} />
        <PrimaryNav styles={styles} c={c} navigation={navigation} scrollRef={scrollRef} />
      </SafeAreaView>

      {/* ── One scroll container (no nested VirtualizedLists) ── */}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 28 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary500} />}
      >
        {/* ── Recently viewed ── */}
        {recentInsts.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.h2}>Recently viewed</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rvRail}>
              {recentInsts.map((it) => {
                const chg = Number(it.change24h);
                const positive = Number.isFinite(chg) ? chg >= 0 : true;
                return (
                  <TouchableOpacity key={it.symbol} style={styles.rvItem} activeOpacity={0.7} onPress={() => openStock(it)}>
                    <AssetGlyph row={it} size={44} />
                    <Text style={styles.rvSym} numberOfLines={1}>{it.symbol}</Text>
                    {Number.isFinite(chg) && (
                      <Text style={[styles.rvPct, { color: positive ? c.bull : c.bear }]}>{positive ? '+' : ''}{chg.toFixed(2)}%</Text>
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        )}

        {/* ── Most traded ── */}
        <View style={styles.section}>
          <SectionHeader
            title="Most traded"
            caption="Top liquidity across all markets today"
            actionLabel="View all"
            onAction={() => navigation.navigate('Markets')}
            styles={styles}
            c={c}
          />
          {loading && mostTraded.length === 0 ? (
            <View style={styles.mtWrap}>
              {[0, 1, 2, 3].map((i) => (
                <View key={i} style={[styles.mtCard, { justifyContent: 'flex-start' }]}>
                  <View style={styles.skGlyph} />
                  <View style={styles.skLineWide} />
                  <View style={styles.skLine} />
                </View>
              ))}
            </View>
          ) : mostTraded.length === 0 ? (
            <View style={styles.emptyCard}><Text style={styles.emptyCardTxt}>No instruments available yet.</Text></View>
          ) : (
            <>
              <View style={styles.mtWrap}>
                {mostTraded.map((a) => {
                  const change = Number(a.change24h);
                  const price = Number(a.lastPrice);
                  const absChange = Number.isFinite(change) && Number.isFinite(price) ? (price * change) / 100 : NaN;
                  const saved = savedSet.has(a.symbol);
                  return (
                    <TouchableOpacity key={a.symbol} style={styles.mtCard} activeOpacity={0.75} onPress={() => openStock(a)}>
                      <TouchableOpacity style={styles.mtBookmark} hitSlop={8} onPress={() => toggleWatch(a.symbol)}>
                        <Ionicons name={saved ? 'bookmark' : 'bookmark-outline'} size={17} color={saved ? c.primary500 : c.textMuted} />
                      </TouchableOpacity>
                      <AssetGlyph row={a} size={44} />
                      <Text style={styles.mtName} numberOfLines={1}>{a.name || a.symbol}</Text>
                      <Text style={styles.mtPrice}>{fmtPrice(a.lastPrice, a.pricePrecision)}</Text>
                      <ChangeText absChange={absChange} pct={change} precision={a.pricePrecision} c={c} />
                    </TouchableOpacity>
                  );
                })}
              </View>
              <TouchableOpacity style={styles.seeMore} activeOpacity={0.7} onPress={() => navigation.navigate('Markets')}>
                <Text style={styles.linkTxt}>See more</Text>
                <Ionicons name="chevron-forward" size={13} color={c.primary500} />
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* ── Market movers ── */}
        <View style={styles.section} onLayout={(e) => { moversY.current = e.nativeEvent.layout.y; }}>
          <Text style={styles.h2}>Market movers</Text>
          <Text style={styles.secCaption}>Top names by performance over the last 24h.</Text>
          {selectedSector && (
            <View style={styles.filterChip}>
              <Text style={styles.filterChipTxt}>Filtered: {selectedSector.label}</Text>
              <TouchableOpacity hitSlop={8} onPress={() => setSelectedSector(null)}>
                <Ionicons name="close" size={14} color={c.primary500} />
              </TouchableOpacity>
            </View>
          )}

          {/* Category filter chip row */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            {MOVER_CATS.map((cat) => {
              const on = cat.key === '' ? moverCats.length === 0 : moverCats.includes(cat.key);
              return (
                <TouchableOpacity key={cat.key || 'all'} activeOpacity={0.8} onPress={() => toggleMoverCat(cat.key)} style={[styles.chip, on && styles.chipOn]}>
                  <Text style={[styles.chipTxt, on && styles.chipTxtOn]}>{cat.label}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Mover tab pills */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabPillRow}>
            {MOVER_TABS.map((t) => {
              const on = moverTab === t;
              return (
                <TouchableOpacity key={t} activeOpacity={0.8} onPress={() => setMoverTab(t)} style={[styles.tabPill, on && styles.tabPillOn]}>
                  <Text style={[styles.tabPillTxt, on && styles.tabPillTxtOn]}>{t}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={styles.card}>
            {loading ? (
              <Text style={styles.centerMuted}>Loading market data…</Text>
            ) : movers.length === 0 ? (
              <Text style={styles.centerMuted}>No assets match this filter.</Text>
            ) : movers.map((m, idx) => {
              const change = Number(m.change24h);
              const saved = savedSet.has(m.symbol);
              return (
                <TouchableOpacity
                  key={m.symbol}
                  activeOpacity={0.6}
                  onPress={() => openStock(m)}
                  style={[styles.mvRow, idx > 0 && styles.rowBorder]}
                >
                  <AssetGlyph row={m} size={34} />
                  <View style={styles.mvMain}>
                    <Text style={styles.mvSym} numberOfLines={1}>{m.symbol}</Text>
                    {m.name ? <Text style={styles.mvName} numberOfLines={1}>{m.name}</Text> : null}
                  </View>
                  <Sparkline change={change} seed={idx} width={54} height={24} c={c} />
                  <View style={styles.mvRight}>
                    <Text style={styles.mvPrice} numberOfLines={1}>{fmtPrice(m.lastPrice, m.pricePrecision)}</Text>
                    <ChangePill value={change} c={c} styles={styles} />
                    <Text style={styles.mvVol}>Vol {fmtVolume(m.volume24h)}</Text>
                  </View>
                  <TouchableOpacity style={styles.starBtn} hitSlop={6} onPress={() => toggleWatch(m.symbol)}>
                    <Ionicons name={saved ? 'star' : 'star-outline'} size={16} color={saved ? c.warn : c.textMuted} />
                  </TouchableOpacity>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* ── Sectors trending today ── */}
        <View style={styles.section}>
          <Text style={styles.h2}>Sectors trending today</Text>
          {loading ? (
            <View style={[styles.card, { padding: 14, gap: 12 }]}>
              {[0, 1, 2, 3, 4].map((i) => <View key={i} style={styles.skRow} />)}
            </View>
          ) : sectors.length === 0 ? (
            <View style={styles.emptyCard}><Text style={styles.emptyCardTxt}>No sector data yet.</Text></View>
          ) : (
            <>
              <View style={styles.card}>
                <View style={styles.secColHead}>
                  <Text style={[styles.secColTxt, { flex: 1 }]}>Sector</Text>
                  <Text style={[styles.secColTxt, { width: 92, textAlign: 'center' }]}>Gainers/Losers</Text>
                  <Text style={[styles.secColTxt, { width: 62, textAlign: 'right' }]}>1D%</Text>
                </View>
                {sectors.map((s, idx) => {
                  const positive = s.perf >= 0;
                  const active = selectedSector?.key === s.key;
                  return (
                    <TouchableOpacity
                      key={s.key}
                      activeOpacity={0.6}
                      onPress={() => toggleSector(s)}
                      style={[styles.secRow, idx > 0 && styles.rowBorder, active && { backgroundColor: c.primarySoft }]}
                    >
                      <View style={[styles.secTile, { backgroundColor: s.tint + '22' }]}>
                        <Ionicons name={s.icon} size={18} color={s.tint} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.secLabel} numberOfLines={1}>{s.label}</Text>
                        <Text style={styles.secTop} numberOfLines={1}>Top: {s.top?.symbol || '—'}</Text>
                      </View>
                      <GainersLosersBar gainers={s.gainers} losers={s.losers} c={c} styles={styles} />
                      <Text style={[styles.secPerf, { color: positive ? c.bull : c.bear }]}>{positive ? '+' : ''}{s.perf.toFixed(2)}%</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <TouchableOpacity style={styles.seeMore} activeOpacity={0.7} onPress={() => navigation.navigate('Markets')}>
                <Text style={styles.linkTxt}>See all sectors</Text>
                <Ionicons name="chevron-forward" size={13} color={c.primary500} />
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* ── Your activity (Positions / Pending Orders) ── */}
        <View style={styles.section}>
          <Text style={styles.h2}>Your activity</Text>
          <View style={[styles.card, { padding: 0, marginTop: 12 }]}>
            {/* Tab bar */}
            <View style={styles.actTabBar}>
              {[
                { id: 'positions', label: 'Positions', count: livePositions.length },
                { id: 'orders', label: 'Pending Orders', count: orders.length },
              ].map((t) => {
                const on = activityTab === t.id;
                return (
                  <TouchableOpacity key={t.id} activeOpacity={0.8} onPress={() => setActivityTab(t.id)} style={[styles.actTab, on && styles.actTabOn]}>
                    <Text style={[styles.actTabTxt, on && styles.actTabTxtOn]}>{t.label}</Text>
                    {t.count > 0 && (
                      <View style={[styles.actBadge, on && styles.actBadgeOn]}>
                        <Text style={[styles.actBadgeTxt, on && styles.actBadgeTxtOn]}>{t.count}</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Positions */}
            {activityTab === 'positions' && (
              livePositions.length === 0 ? (
                <View style={styles.emptyState}>
                  <InvestmentsIllustration c={c} />
                  <Text style={styles.emptyTitle}>No open trades yet</Text>
                  <Text style={styles.emptySub}>Fund your account and place your first FX or crypto trade.</Text>
                  <View style={styles.ctaRow}>
                    <TouchableOpacity style={styles.ctaPrimary} activeOpacity={0.85} onPress={() => navigation.navigate('Wallet')}>
                      <Text style={styles.ctaPrimaryTxt}>Add funds</Text>
                      <Ionicons name="arrow-forward" size={14} color={c.white} />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.ctaGhost} activeOpacity={0.85} onPress={() => navigation.navigate('Trade')}>
                      <Text style={styles.ctaGhostTxt}>Start trading</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <>
                  {livePositions.map((p, idx) => {
                    const inst = instBySym.get(p.symbol);
                    const prec = Math.min(inst?.pricePrecision || 2, 5);
                    const pnl = Number(p.unrealizedPnl || 0);
                    const pnlPos = pnl >= 0;
                    const long = String(p.side).toUpperCase() === 'BUY';
                    return (
                      <View key={p._id || `${p.symbol}-${p.entryPrice}`} style={[styles.actRow, idx > 0 && styles.rowBorder]}>
                        <TouchableOpacity style={styles.actMain} activeOpacity={0.6} onPress={() => openStock(inst || { symbol: p.symbol, category: p.category })}>
                          <AssetGlyph row={inst || { symbol: p.symbol, category: p.category }} size={30} />
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <View style={styles.actSymRow}>
                              <Text style={styles.actSym} numberOfLines={1}>{p.symbol}</Text>
                              <View style={[styles.sideTag, { backgroundColor: long ? c.bullSoft : c.bearSoft }]}>
                                <Text style={[styles.sideTagTxt, { color: long ? c.bull : c.bear }]}>{long ? 'Long' : 'Short'}</Text>
                              </View>
                            </View>
                            <Text style={styles.actMeta} numberOfLines={1}>{fmtNum(p.quantity, 4)} @ {fmtNum(p.entryPrice, prec)}</Text>
                          </View>
                        </TouchableOpacity>
                        <View style={styles.actRightCol}>
                          <Text style={[styles.actPnl, { color: pnlPos ? c.bull : c.bear }]}>{pnlPos ? '+' : ''}{fmtNum(pnl, 2)}</Text>
                          <Text style={styles.actMark}>{fmtNum(p.markPrice || p.entryPrice, prec)}</Text>
                        </View>
                        <TouchableOpacity style={styles.actX} hitSlop={6} onPress={() => closePosition(p._id)}>
                          <Ionicons name="close" size={18} color={c.textMuted} />
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                  <View style={styles.actFooter}>
                    <TouchableOpacity style={styles.bulkBtn} activeOpacity={0.85} disabled={bulkBusy} onPress={closeAllPositions}>
                      <Text style={styles.bulkBtnTxt}>{bulkBusy ? 'Closing…' : `Close All (${livePositions.length})`}</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )
            )}

            {/* Pending orders */}
            {activityTab === 'orders' && (
              orders.length === 0 ? (
                <View style={styles.emptyState}>
                  <InvestmentsIllustration c={c} />
                  <Text style={styles.emptyTitle}>No pending orders yet</Text>
                  <Text style={styles.emptySub}>Limit and stop orders waiting to be filled will appear here.</Text>
                  <View style={styles.ctaRow}>
                    <TouchableOpacity style={styles.ctaPrimary} activeOpacity={0.85} onPress={() => navigation.navigate('Trade')}>
                      <Text style={styles.ctaPrimaryTxt}>Place an order</Text>
                      <Ionicons name="arrow-forward" size={14} color={c.white} />
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <>
                  {orders.map((o, idx) => {
                    const inst = instBySym.get(o.symbol);
                    const prec = Math.min(inst?.pricePrecision || 2, 5);
                    const buy = String(o.side).toUpperCase() === 'BUY';
                    const trigger = Number(o.limitPrice ?? o.stopPrice ?? o.price ?? 0);
                    const mark = Number(priceMap[o.symbol]?.last ?? inst?.lastPrice ?? trigger);
                    return (
                      <View key={o._id || `${o.symbol}-${o.createdAt}`} style={[styles.actRow, idx > 0 && styles.rowBorder]}>
                        <TouchableOpacity style={styles.actMain} activeOpacity={0.6} onPress={() => openStock(inst || { symbol: o.symbol, category: o.category })}>
                          <AssetGlyph row={inst || { symbol: o.symbol, category: o.category }} size={30} />
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <View style={styles.actSymRow}>
                              <Text style={styles.actSym} numberOfLines={1}>{o.symbol}</Text>
                              <View style={[styles.sideTag, { backgroundColor: buy ? c.bullSoft : c.bearSoft }]}>
                                <Text style={[styles.sideTagTxt, { color: buy ? c.bull : c.bear }]}>{buy ? 'Buy' : 'Sell'}</Text>
                              </View>
                              <View style={styles.typeTag}>
                                <Text style={styles.typeTagTxt}>{o.type || o.orderType || 'LIMIT'}</Text>
                              </View>
                            </View>
                            <Text style={styles.actMeta} numberOfLines={1}>{fmtNum(o.quantity, 4)} @ {fmtNum(trigger, prec)}</Text>
                          </View>
                        </TouchableOpacity>
                        <View style={styles.actRightCol}>
                          <Text style={styles.actMarkPrice}>{fmtNum(mark, prec)}</Text>
                          <Text style={styles.actMark}>Mark</Text>
                        </View>
                        <TouchableOpacity style={styles.actX} hitSlop={6} onPress={() => cancelOrder(o._id)}>
                          <Ionicons name="close" size={18} color={c.textMuted} />
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                  <View style={styles.actFooter}>
                    <TouchableOpacity style={styles.bulkBtn} activeOpacity={0.85} disabled={bulkBusy} onPress={cancelAllOrders}>
                      <Text style={styles.bulkBtnTxt}>{bulkBusy ? 'Cancelling…' : `Cancel All (${orders.length})`}</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )
            )}
          </View>
        </View>

        {/* ── Products & Tools ── */}
        <View style={styles.section}>
          <Text style={styles.h3}>Products &amp; Tools</Text>
          <View style={[styles.card, { padding: 6, marginTop: 12 }]}>
            {PRODUCTS.map((p, idx) => (
              <TouchableOpacity
                key={p.route + p.label}
                activeOpacity={0.7}
                onPress={() => navigation.navigate(p.route)}
                style={[styles.prodRow, idx > 0 && styles.rowBorder]}
              >
                <View style={[styles.prodIcon, { backgroundColor: p.tint + '22' }]}>
                  <Ionicons name={p.icon} size={19} color={p.tint} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.prodLabel} numberOfLines={1}>{p.label}</Text>
                  <Text style={styles.prodCaption} numberOfLines={1}>{p.caption}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={c.textMuted} />
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* ── Economic Calendar (gated by admin enabled flag) ── */}
        {econEnabled && (
          <View style={styles.section}>
            <Text style={styles.h2}>Economic Calendar</Text>
            <Text style={styles.secCaption}>High-impact macro events from US, EU, UK, JP and CN — actuals against consensus.</Text>
            <View style={[styles.card, { marginTop: 12 }]}>
              {econGroups == null ? (
                <Text style={styles.centerMuted}>Loading…</Text>
              ) : econGroups.length === 0 ? (
                <Text style={styles.centerMuted}>No upcoming events in the next 14 days.</Text>
              ) : econGroups.map((grp) => (
                <View key={grp.key}>
                  <View style={styles.econDayHead}>
                    <Text style={styles.econDayTxt}>{econDayLong(new Date(grp.key + 'T00:00:00Z'))}</Text>
                  </View>
                  {grp.rows.map((e, idx) => {
                    const tone = ECON_IMPACT[e.impact] || ECON_IMPACT.medium;
                    return (
                      <View key={e.id} style={[styles.econRow, idx > 0 && styles.rowBorder]}>
                        <Text style={styles.econTimeTxt}>{econTime(e.date)}</Text>
                        <Text style={styles.econFlag}>{flagFor(e.country)}</Text>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.econEvent} numberOfLines={1}>{e.event}</Text>
                          {(e.actualLabel != null || e.previousLabel != null) && (
                            <Text style={styles.econStats} numberOfLines={1}>
                              {e.country}
                              {e.actualLabel != null ? ` · A ${e.actualLabel}` : ''}
                              {e.previousLabel != null ? ` · P ${e.previousLabel}` : ''}
                            </Text>
                          )}
                        </View>
                        <View style={[styles.impactPill, { backgroundColor: tone.color + '22' }]}>
                          <Text style={[styles.impactTxt, { color: tone.color }]}>{tone.label}</Text>
                        </View>
                        <TouchableOpacity hitSlop={6} onPress={() => navigation.navigate('Alerts')}>
                          <Ionicons name="notifications-outline" size={15} color={c.textMuted} />
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </View>
              ))}
            </View>
          </View>
        )}

        <View style={{ height: 28 }} />
      </ScrollView>
    </View>
  );
}

const makeStyles = (c) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },

  // Header
  header: { height: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  brandWrap: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: { width: 40, height: 40, borderRadius: 12, backgroundColor: c.primary500, alignItems: 'center', justifyContent: 'center' },
  logoT: { color: '#FFFFFF', fontFamily: 'Georgia', fontSize: 20, fontWeight: '700' },
  proBadge: { position: 'absolute', bottom: -4, right: -6, backgroundColor: c.primary700, borderRadius: 5, paddingHorizontal: 3, paddingVertical: 1, borderWidth: 1.5, borderColor: c.bg },
  proBadgeTxt: { color: '#FFFFFF', fontSize: 6.5, fontWeight: '900', letterSpacing: 0.4 },
  brandName: { fontSize: 16, fontWeight: '900', color: c.textPrimary, letterSpacing: -0.3 },
  brandSub: { fontSize: 8.5, fontWeight: '800', color: c.primary500, letterSpacing: 2.2, marginTop: 1 },
  hRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  iconBtn: { padding: 6 },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: c.primary500, alignItems: 'center', justifyContent: 'center', marginLeft: 2 },
  avatarT: { color: '#FFFFFF', fontSize: 12.5, fontWeight: '800' },

  // Primary-nav strip
  navStrip: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.borderSubtle, backgroundColor: c.bg },
  navScroll: { paddingHorizontal: 12, paddingVertical: 9, gap: 6 },
  navPill: { paddingHorizontal: 13, paddingVertical: 7, borderRadius: radius.md, marginRight: 4 },
  navPillOn: { backgroundColor: c.primarySoft },
  navPillTxt: { fontSize: 14, fontWeight: '700', color: c.textSecondary },
  navPillTxtOn: { color: c.primary500 },

  // Sections
  section: { marginTop: 22, paddingHorizontal: 16 },
  h2: { fontSize: 19, fontWeight: '900', color: c.textPrimary, letterSpacing: -0.3 },
  h3: { fontSize: 16, fontWeight: '900', color: c.textPrimary },
  secCaption: { fontSize: 12, color: c.textMuted, marginTop: 3 },
  secHeadRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 2 },
  linkTxt: { fontSize: 13, fontWeight: '800', color: c.primary500 },
  seeMore: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 12, alignSelf: 'flex-start' },

  card: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.xl, marginTop: 12, overflow: 'hidden' },
  rowBorder: { borderTopWidth: 1, borderTopColor: c.borderSubtle },
  centerMuted: { fontSize: 13, color: c.textMuted, textAlign: 'center', paddingVertical: 28 },
  emptyCard: { backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.xl, marginTop: 12, paddingVertical: 34, alignItems: 'center' },
  emptyCardTxt: { fontSize: 13, color: c.textMuted },

  // Recently viewed
  rvRail: { gap: 18, paddingTop: 14, paddingRight: 8 },
  rvItem: { width: 62, alignItems: 'center', gap: 6 },
  rvSym: { fontSize: 12.5, fontWeight: '800', color: c.textPrimary, maxWidth: 62 },
  rvPct: { fontSize: 11.5, fontWeight: '800' },

  // Most traded
  mtWrap: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 14 },
  mtCard: { width: '48%', backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.xl, padding: 14, marginBottom: 12, minHeight: 132 },
  mtBookmark: { position: 'absolute', top: 10, right: 10, zIndex: 2, padding: 2 },
  mtName: { fontSize: 13, fontWeight: '600', color: c.textPrimary, marginTop: 14 },
  mtPrice: { fontSize: 19, fontWeight: '900', color: c.textPrimary, marginTop: 12, fontVariant: ['tabular-nums'] },

  // Skeletons
  skGlyph: { width: 44, height: 44, borderRadius: radius.md, backgroundColor: c.hover },
  skLineWide: { height: 12, width: '70%', borderRadius: 4, backgroundColor: c.hover, marginTop: 16 },
  skLine: { height: 12, width: '45%', borderRadius: 4, backgroundColor: c.hover, marginTop: 10 },
  skRow: { height: 40, borderRadius: radius.md, backgroundColor: c.hover },

  // Filter chips + tabs
  filterChip: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', marginTop: 10, backgroundColor: c.primarySoft, borderRadius: radius.pill, paddingLeft: 12, paddingRight: 8, paddingVertical: 5 },
  filterChipTxt: { fontSize: 12, fontWeight: '700', color: c.primary500 },
  chipRow: { gap: 8, paddingTop: 14, paddingRight: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, marginRight: 4 },
  chipOn: { borderColor: c.primary500, backgroundColor: c.primarySoft },
  chipTxt: { fontSize: 12.5, fontWeight: '700', color: c.textSecondary },
  chipTxtOn: { color: c.primary500 },
  tabPillRow: { gap: 8, paddingTop: 10, paddingRight: 8 },
  tabPill: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, marginRight: 4 },
  tabPillOn: { borderColor: c.textPrimary, backgroundColor: c.hover },
  tabPillTxt: { fontSize: 13, fontWeight: '700', color: c.textSecondary },
  tabPillTxtOn: { color: c.textPrimary, fontWeight: '800' },

  // Mover rows
  mvRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 11 },
  mvMain: { flex: 1, minWidth: 0, marginLeft: 10, marginRight: 6 },
  mvSym: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
  mvName: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  mvRight: { alignItems: 'flex-end', width: 90, marginLeft: 6 },
  mvPrice: { fontSize: 13.5, fontWeight: '800', color: c.textPrimary, fontVariant: ['tabular-nums'] },
  mvVol: { fontSize: 10, color: c.textMuted, marginTop: 3, fontVariant: ['tabular-nums'] },
  chgPill: { flexDirection: 'row', alignItems: 'center', gap: 1, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, marginTop: 3 },
  pillDash: { fontSize: 11, color: c.textMuted, marginTop: 3 },
  starBtn: { paddingLeft: 8, paddingVertical: 4 },

  // Sector rows
  secColHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 9, backgroundColor: c.hover },
  secColTxt: { fontSize: 10.5, fontWeight: '700', color: c.textMuted, letterSpacing: 0.4 },
  secRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12 },
  secTile: { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  secLabel: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
  secTop: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  glBox: { width: 92, marginHorizontal: 8 },
  glNums: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  glNum: { fontSize: 13, fontWeight: '800' },
  glTrack: { flexDirection: 'row', height: 3, borderRadius: 2, overflow: 'hidden', backgroundColor: c.hover },
  secPerf: { width: 62, textAlign: 'right', fontSize: 13.5, fontWeight: '800', fontVariant: ['tabular-nums'] },

  // Activity
  actTabBar: { flexDirection: 'row', gap: 8, padding: 10, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  actTab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 9, borderRadius: radius.md },
  actTabOn: { backgroundColor: c.primarySoft },
  actTabTxt: { fontSize: 13.5, fontWeight: '800', color: c.textSecondary },
  actTabTxtOn: { color: c.primary500 },
  actBadge: { minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: c.hover },
  actBadgeOn: { backgroundColor: c.primary500 },
  actBadgeTxt: { fontSize: 10, fontWeight: '900', color: c.textMuted },
  actBadgeTxtOn: { color: c.white },
  actRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 11 },
  actMain: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 },
  actSymRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actSym: { fontSize: 14, fontWeight: '800', color: c.textPrimary, flexShrink: 1 },
  sideTag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  sideTagTxt: { fontSize: 9, fontWeight: '900', letterSpacing: 0.4 },
  typeTag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: c.hover },
  typeTagTxt: { fontSize: 9, fontWeight: '900', letterSpacing: 0.4, color: c.textMuted },
  actMeta: { fontSize: 11, color: c.textMuted, marginTop: 3, fontVariant: ['tabular-nums'] },
  actRightCol: { alignItems: 'flex-end', marginLeft: 8 },
  actPnl: { fontSize: 14, fontWeight: '900', fontVariant: ['tabular-nums'] },
  actMarkPrice: { fontSize: 14, fontWeight: '800', color: c.textPrimary, fontVariant: ['tabular-nums'] },
  actMark: { fontSize: 10, color: c.textMuted, marginTop: 2, fontVariant: ['tabular-nums'] },
  actX: { paddingLeft: 10, paddingVertical: 4 },
  actFooter: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 14, paddingVertical: 11, borderTopWidth: 1, borderTopColor: c.borderSubtle },
  bulkBtn: { backgroundColor: c.bearSoft, borderWidth: 1, borderColor: c.bear, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 8 },
  bulkBtnTxt: { fontSize: 12.5, fontWeight: '900', color: c.bear },

  // Empty states
  emptyState: { alignItems: 'center', paddingHorizontal: 20, paddingVertical: 26 },
  emptyTitle: { marginTop: 12, fontSize: 15, fontWeight: '800', color: c.textPrimary },
  emptySub: { marginTop: 5, fontSize: 12.5, color: c.textMuted, textAlign: 'center', lineHeight: 18 },
  ctaRow: { flexDirection: 'row', gap: 10, marginTop: 16 },
  ctaPrimary: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.primary500, borderRadius: radius.md, paddingHorizontal: 16, paddingVertical: 10 },
  ctaPrimaryTxt: { fontSize: 13.5, fontWeight: '800', color: c.white },
  ctaGhost: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 16, paddingVertical: 10 },
  ctaGhostTxt: { fontSize: 13.5, fontWeight: '800', color: c.textPrimary },

  // Products & Tools
  prodRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, paddingVertical: 12 },
  prodIcon: { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  prodLabel: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
  prodCaption: { fontSize: 11, color: c.textMuted, marginTop: 2 },

  // Economic calendar
  econDayHead: { paddingHorizontal: 14, paddingVertical: 9, backgroundColor: c.hover },
  econDayTxt: { fontSize: 13, fontWeight: '800', color: c.textPrimary },
  econRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 14, paddingVertical: 11 },
  econTimeTxt: { width: 42, fontSize: 12, fontWeight: '800', color: c.textPrimary, fontVariant: ['tabular-nums'] },
  econFlag: { fontSize: 16 },
  econEvent: { fontSize: 13, fontWeight: '600', color: c.textPrimary },
  econStats: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  impactPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  impactTxt: { fontSize: 9, fontWeight: '900', letterSpacing: 0.4 },
});
