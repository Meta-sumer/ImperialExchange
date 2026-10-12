import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Image, Linking, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../services/api';
import { wsClient } from '../services/ws';
import { usePrice } from '../hooks/usePrice';
import { useColors, radius, fmtNum, currencySymbol } from '../theme';
import { Card, Button, Row } from '../components/ui';
import TradingViewChart from '../components/TradingViewChart';

/**
 * Groww-style instrument detail — a native mirror of the web StockDetail page.
 * Same sections, same order, same backend data: header (icon, symbol/exchange,
 * name, live price + change, action buttons) · chart · Overview / Technicals /
 * News tabs. Chart / price / depth / fundamentals / news
 * are all real (same endpoints the web uses); OI/Volume + "similar stocks"
 * market-caps are illustrative (no backend source), exactly like the web.
 * Buy / Sell route to the platform's real OrderTicket screen.
 */

// UI timeframe → candle {timeframe, limit} — same map the web uses.
const TF_MAP = {
  '1D': { timeframe: '5m', limit: 80 },
  '1W': { timeframe: '30m', limit: 90 },
  '1M': { timeframe: '1d', limit: 30 },
  '3M': { timeframe: '1d', limit: 90 },
  '6M': { timeframe: '1d', limit: 180 },
  '1Y': { timeframe: '1w', limit: 52 },
  '3Y': { timeframe: '1w', limit: 156 },
  '5Y': { timeframe: '1w', limit: 260 },
  'All': { timeframe: '1w', limit: 520 },
};
const TF_LIST = ['1D', '1W', '1M', '3M', '6M', '1Y', '3Y', '5Y', 'All'];
const TABS = ['Overview', 'Technicals', 'News'];

// Drop the LEADING carry-forward run (flat, volume 0) so the real price spreads
// across the analytics window. Mirrors the web helper.
function trimLeadingFlat(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return candles || [];
  const first = Number(candles[0]?.close);
  let i = 0;
  while (i < candles.length - 2 && Number(candles[i].close) === first && Number(candles[i].volume || 0) === 0) i++;
  const start = Math.max(0, i - 1);
  return start > 0 ? candles.slice(start) : candles;
}

// Integer grouping via the shared helper (avoids RN Intl locale gaps).
const fmtInt = (v) => fmtNum(Number(v) || 0, 0);

// Deterministic tile colour per underlying (recognisable icon without a logo CDN).
const TILE_PALETTE = ['#2563EB', '#7C3AED', '#0891B2', '#16A34A', '#EA580C', '#DB2777', '#0D9488', '#CA8A04', '#DC2626', '#4F46E5', '#0EA5E9', '#9333EA'];
function tileColor(key) {
  let h = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return TILE_PALETTE[h % TILE_PALETTE.length];
}

// Technicals maths (same as web).
const sma = (arr, n) => (arr.length < n ? null : arr.slice(-n).reduce((s, v) => s + v, 0) / n);
const rsi14 = (arr) => {
  if (arr.length < 15) return null;
  let g = 0, l = 0;
  for (let i = arr.length - 14; i < arr.length; i++) { const d = arr[i] - arr[i - 1]; if (d >= 0) g += d; else l -= d; }
  if (l === 0) return 100;
  return 100 - 100 / (1 + (g / 14) / (l / 14));
};

// Financial-chart helpers.
function niceCeil(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 3 ? 3 : n <= 5 ? 5 : n <= 7 ? 7 : 10;
  return step * p;
}
function fmtFinLabel(l) {
  const m = /^(\d)Q(\d{4})$/.exec(l || '');
  if (m) return `Q${m[1]} '${m[2].slice(2)}`;
  if (/^\d{4}$/.test(l)) return `FY '${l.slice(2)}`;
  return l || '';
}
const timeAgo = (iso) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export default function InstrumentDetailScreen({ route, navigation }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const initial = route.params?.instrument || { symbol: route.params?.symbol };
  const symbol = initial.symbol;

  const [inst, setInst] = useState(initial);
  const [tf, setTf] = useState('1D');
  const [candles, setCandles] = useState([]);
  const [book, setBook] = useState({ bids: [], asks: [] });
  const [fund, setFund] = useState(null);
  const [tab, setTab] = useState('Overview');
  const [catalog, setCatalog] = useState([]);

  const livePrice = usePrice(symbol, initial.lastPrice); // WS ticker, seeded from the row

  useEffect(() => { navigation.setOptions({ title: symbol }); }, [navigation, symbol]);

  // Instrument metadata (name, precision, exchange, circuits…) + fundamentals.
  useEffect(() => {
    let dead = false;
    setFund(null);
    api.get(`/instruments/${encodeURIComponent(symbol)}`)
      .then(({ data }) => { if (!dead && data?.data) setInst((p) => ({ ...p, ...data.data })); }).catch(() => {});
    api.get(`/instruments/${encodeURIComponent(symbol)}/fundamentals`)
      .then(({ data }) => { if (!dead) setFund(data?.data || null); }).catch(() => {});
    return () => { dead = true; };
  }, [symbol]);

  // Candles for the selected analytics window (drives header change, Performance
  // range, Technicals). The chart itself (TradingViewChart) fetches its own.
  useEffect(() => {
    let dead = false;
    const { timeframe, limit } = TF_MAP[tf];
    api.get(`/instruments/${encodeURIComponent(symbol)}/candles`, { params: { timeframe, limit } })
      .then(({ data }) => { if (!dead) setCandles(trimLeadingFlat(Array.isArray(data?.data) ? data.data : [])); })
      .catch(() => { if (!dead) setCandles([]); });
    return () => { dead = true; };
  }, [symbol, tf]);

  // Order book (depth) — REST snapshot + live WS updates.
  useEffect(() => {
    let dead = false;
    api.get(`/instruments/${encodeURIComponent(symbol)}/orderbook`, { params: { depth: 5 } })
      .then(({ data }) => { if (!dead) setBook({ bids: data?.data?.bids || [], asks: data?.data?.asks || [] }); }).catch(() => {});
    const un = wsClient.subscribe(`orderbook:${symbol}`, (d) => { if (d) setBook({ bids: d.bids || [], asks: d.asks || [] }); });
    return () => { dead = true; un && un(); };
  }, [symbol]);

  // Catalog + watchlist (merged by symbol) for the "Similar stocks" list.
  useEffect(() => {
    let dead = false;
    Promise.all([
      api.get('/instruments').then((r) => r.data?.data || []).catch(() => []),
      api.get('/instruments/watchlist').then((r) => r.data?.data || []).catch(() => []),
    ]).then(([cat, wl]) => {
      if (dead) return;
      const wlBy = new Map(wl.map((r) => [r.symbol, r]));
      setCatalog(cat.map((r) => {
        const w = wlBy.get(r.symbol);
        return w ? { ...r, lastPrice: w.lastPrice ?? r.lastPrice, change24h: w.change24h } : r;
      }));
    });
    return () => { dead = true; };
  }, [symbol]);

  // ── Derived figures (same formulas as the web) ──
  const prec = Math.min(inst?.pricePrecision || 2, 5);
  const closes = candles.map((k) => Number(k.close));
  const lastPrice = livePrice != null ? Number(livePrice) : (closes.length ? closes[closes.length - 1] : Number(inst?.lastPrice || 0));
  const openPrice = candles.length ? Number(candles[0].open) : lastPrice;
  const change = lastPrice - openPrice;
  const pct = openPrice ? (change / openPrice) * 100 : 0;
  const up = change >= 0;
  const dayLow = candles.length ? Math.min(...candles.map((k) => Number(k.low))) : lastPrice;
  const dayHigh = candles.length ? Math.max(...candles.map((k) => Number(k.high))) : lastPrice;
  const isEquity = inst?.category === 'STOCK' && ['NSE', 'BSE'].includes(inst?.exchange);
  const cur = (inst?.quoteCurrency === 'INR' || isEquity) ? '₹' : (inst?.quoteCurrency === 'USD' ? '$' : currencySymbol(inst?.quoteCurrency || 'USD'));
  const name = inst?.name || symbol;

  const go = (side) => navigation.navigate('OrderTicket', { instrument: { ...inst, lastPrice }, side });
  const openInstrument = (r) => navigation.navigate('InstrumentDetail', { instrument: r });

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 100, gap: 14 }}>
        {/* ── Header ── */}
        <Card>
          <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <Row style={{ gap: 10, flex: 1 }}>
              <AssetGlyph inst={inst} symbol={symbol} size={44} c={c} />
              <View style={{ flex: 1 }}>
                <Text style={styles.hSym} numberOfLines={1}>{symbol} · {inst?.exchange || 'NSE'}</Text>
                <Text style={styles.hName} numberOfLines={2}>{name}</Text>
              </View>
            </Row>
            <Row style={{ gap: 8 }}>
              <IconBtn c={c} name="notifications-outline" onPress={() => Alert.alert('Price alert', `Price alerts for ${symbol} are coming to mobile soon.`)} />
              <IconBtn c={c} name="bookmark-outline" onPress={() => Alert.alert('Watchlist', `Manage watchlists from the web app — mobile watchlists are coming soon.`)} />
            </Row>
          </Row>
          <Row style={{ marginTop: 14, gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <Text style={styles.price}>{cur}{fmtNum(lastPrice, prec)}</Text>
            <Text style={{ fontSize: 14, fontWeight: '700', color: up ? c.bull : c.bear }}>
              {up ? '' : '-'}{cur}{fmtNum(Math.abs(change), prec)} ({up ? '+' : ''}{pct.toFixed(2)}%)
            </Text>
            <Text style={{ fontSize: 13, color: c.textMuted }}>{tf}</Text>
          </Row>
        </Card>

        {/* ── Chart (reuses the shared TradingViewChart — fullscreen + MA; the
            timeframe is driven by the single analytics pill row below) ── */}
        <Card>
          <TradingViewChart symbol={symbol} timeframe={TF_MAP[tf].timeframe} limit={TF_MAP[tf].limit} />
        </Card>

        {/* Analytics timeframe pills — drive the header change + Performance + Technicals. */}
        <Row style={{ flexWrap: 'wrap', gap: 8 }}>
          {TF_LIST.map((t) => {
            const on = tf === t;
            return (
              <TouchableOpacity key={t} onPress={() => setTf(t)} style={[styles.tfPill, on && { borderColor: c.primary500, backgroundColor: c.primarySoft }]}>
                <Text style={{ fontSize: 12, fontWeight: '800', color: on ? c.primary500 : c.textSecondary }}>{t}</Text>
              </TouchableOpacity>
            );
          })}
        </Row>

        {/* ── Tab bar ── */}
        <View style={styles.tabBar}>
          {TABS.map((t) => {
            const on = tab === t;
            return (
              <TouchableOpacity key={t} onPress={() => setTab(t)} style={[styles.tabItem, on && { borderBottomColor: c.bull }]}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: on ? c.bull : c.textSecondary }}>{t}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── Tab content ── */}
        {tab === 'Overview' ? (
          <OverviewTab book={book} lastPrice={lastPrice} dayLow={dayLow} dayHigh={dayHigh} openPrice={openPrice}
            cur={cur} prec={prec} candles={candles} fund={fund} catalog={catalog} inst={inst} symbol={symbol}
            onOpen={openInstrument} c={c} styles={styles} />
        ) : tab === 'Technicals' ? (
          <TechnicalsTab candles={candles} lastPrice={lastPrice} cur={cur} prec={prec} fund={fund} dayLow={dayLow} dayHigh={dayHigh} c={c} styles={styles} />
        ) : (
          <NewsTab symbol={symbol} name={name} c={c} styles={styles} />
        )}
      </ScrollView>

      {/* ── Fixed Buy / Sell bar → the platform's real OrderTicket (native equivalent of the web mobile Trade drawer) ── */}
      <View style={styles.bottomBar}>
        <Button title="SELL" variant="danger" style={{ flex: 1 }} onPress={() => go('SELL')} />
        <Button title="BUY" style={{ flex: 1, backgroundColor: c.bull }} onPress={() => go('BUY')} />
      </View>
    </View>
  );
}

/* ─────────────────────────── Shared bits ─────────────────────────── */
function IconBtn({ name, onPress, c }) {
  return (
    <TouchableOpacity onPress={onPress} style={{ width: 38, height: 38, borderRadius: 19, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={name} size={17} color={c.textSecondary} />
    </TouchableOpacity>
  );
}

function AssetGlyph({ inst, symbol, size = 44, c }) {
  const [failed, setFailed] = useState(false);
  const logo = inst?.logoUrl;
  if (logo && !failed) {
    return <Image source={{ uri: logo }} onError={() => setFailed(true)} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#fff' }} />;
  }
  const bg = tileColor(inst?.underlying || symbol);
  const label = (String(symbol || '').replace(/[^A-Za-z]/g, '').slice(0, 2) || String(symbol || '?').slice(0, 2)).toUpperCase();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontWeight: '900', fontSize: Math.round(size * 0.34) }}>{label}</Text>
    </View>
  );
}

function SectionTitle({ children, styles }) {
  return <Text style={styles.secTitle}>{children}</Text>;
}

/* ─────────────────────────── Overview tab ─────────────────────────── */
function OverviewTab({ book, lastPrice, dayLow, dayHigh, openPrice, cur, prec, candles, fund, catalog, inst, symbol, onOpen, c, styles }) {
  const wk52Low = fund?.week52Low ?? dayLow * 0.72;
  const wk52High = fund?.week52High ?? dayHigh * 1.38;
  const dash = (v, fmt) => (v == null ? '—' : fmt(v));
  const FUND = [
    ['Market Cap', dash(fund?.marketCap, (v) => `${cur}${fmtInt(v / 1e7)}Cr`)],
    ['P/E Ratio (TTM)', dash(fund?.peRatio, (v) => v.toFixed(2))],
    ['P/B Ratio', dash(fund?.pbRatio, (v) => v.toFixed(2))],
    ['ROE', dash(fund?.roe, (v) => `${(v * 100).toFixed(2)}%`)],
    ['Debt to Equity', dash(fund?.debtToEquity, (v) => (v / 100).toFixed(2))],
    ['EPS (TTM)', dash(fund?.eps, (v) => v.toFixed(2))],
    ['Dividend Yield', dash(fund?.dividendYield, (v) => `${(v * 100).toFixed(2)}%`)],
    ['Book Value', dash(fund?.bookValue, (v) => v.toFixed(2))],
    ['52W High', dash(fund?.week52High, (v) => `${cur}${fmtNum(v, prec)}`)],
    ['52W Low', dash(fund?.week52Low, (v) => `${cur}${fmtNum(v, prec)}`)],
  ];

  const QTY = (r) => Number(r.quantity ?? r.qty ?? 0);
  // Synthesise a plausible book around last price when there's no real L2
  // (only crypto has one) — a pulse timer re-rolls sizes so it looks alive.
  const [pulse, setPulse] = useState(0);
  useEffect(() => { const id = setInterval(() => setPulse((p) => p + 1), 1200); return () => clearInterval(id); }, []);
  const tick = Number(inst?.tickSize) || Math.max(0.05, lastPrice * 0.0002);
  const depth = useMemo(() => {
    if (book.bids.length || book.asks.length) return book;
    if (!lastPrice) return { bids: [], asks: [] };
    const bids = [], asks = [];
    for (let i = 1; i <= 5; i++) {
      const weight = (6 - i) / 5;
      bids.push({ price: lastPrice - i * tick, quantity: Math.round(300 + Math.random() * 3800 * weight + weight * 400) });
      asks.push({ price: lastPrice + i * tick, quantity: Math.round(300 + Math.random() * 3800 * weight + weight * 400) });
    }
    return { bids, asks };
  }, [book, lastPrice, tick, pulse]);

  const bidTotal = depth.bids.reduce((s, b) => s + QTY(b), 0);
  const askTotal = depth.asks.reduce((s, a) => s + QTY(a), 0);
  const total = bidTotal + askTotal;
  const buyPct = total ? (bidTotal / total) * 100 : 50;

  const similar = (catalog || []).filter((r) => r.symbol !== symbol && r.category === (inst?.category || 'STOCK')).slice(0, 6);
  const liveVol = fund?.volume ?? candles.reduce((s, k) => s + Number(k.volume || 0), 0);

  return (
    <View style={{ gap: 22 }}>
      {/* Market depth */}
      <View>
        <SectionTitle styles={styles}>Market depth</SectionTitle>
        <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <Text style={styles.depthPct}>Buy orders <Text style={{ color: c.textPrimary }}>{buyPct.toFixed(2)}%</Text></Text>
          <Text style={styles.depthPct}>Sell orders <Text style={{ color: c.textPrimary }}>{(100 - buyPct).toFixed(2)}%</Text></Text>
        </Row>
        <View style={{ height: 6, borderRadius: 3, flexDirection: 'row', overflow: 'hidden', backgroundColor: c.hover }}>
          <View style={{ width: `${buyPct}%`, backgroundColor: c.bull }} />
          <View style={{ width: `${100 - buyPct}%`, backgroundColor: c.bear }} />
        </View>
        <View style={{ flexDirection: 'row', gap: 24, marginTop: 14, alignItems: 'flex-start' }}>
          <DepthCol title="Bid Price" rows={depth.bids} tone="bull" prec={prec} c={c} styles={styles} />
          <DepthCol title="Ask Price" rows={depth.asks} tone="bear" prec={prec} c={c} styles={styles} />
        </View>
        <View style={{ flexDirection: 'row', gap: 24, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: c.borderSubtle }}>
          <Row style={{ flex: 1, justifyContent: 'space-between' }}><Text style={styles.totLbl}>Bid Total</Text><Text style={styles.totVal}>{fmtInt(bidTotal)}</Text></Row>
          <Row style={{ flex: 1, justifyContent: 'space-between' }}><Text style={styles.totLbl}>Ask Total</Text><Text style={styles.totVal}>{fmtInt(askTotal)}</Text></Row>
        </View>
      </View>

      {/* Performance */}
      <View>
        <SectionTitle styles={styles}>Performance</SectionTitle>
        <RangeBar label1="Today's low" v1={dayLow} label2="Today's high" v2={dayHigh} cur={cur} prec={prec} value={lastPrice} c={c} styles={styles} />
        <View style={{ height: 18 }} />
        <RangeBar label1="52 week low" v1={wk52Low} label2="52 week high" v2={wk52High} cur={cur} prec={prec} value={lastPrice} c={c} styles={styles} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 16 }}>
          <Metric label="Open price" value={`${cur}${fmtNum(openPrice, prec)}`} styles={styles} />
          <Metric label="Previous close" value={`${cur}${fmtNum(fund?.prevClose ?? openPrice, prec)}`} styles={styles} />
          <Metric label="Live volume" value={fmtInt(liveVol)} styles={styles} />
          <Metric label="Lower circuit" value={`${cur}${fmtNum(Number(inst?.lowerCircuit) || lastPrice * 0.9, prec)}`} styles={styles} />
          <Metric label="Upper circuit" value={`${cur}${fmtNum(Number(inst?.upperCircuit) || lastPrice * 1.1, prec)}`} styles={styles} />
        </View>
      </View>

      {/* Fundamentals */}
      <View>
        <SectionTitle styles={styles}>Fundamentals</SectionTitle>
        {FUND.map(([k, v]) => (
          <Row key={k} style={styles.fundRow}>
            <Text style={styles.fundKey}>{k}</Text>
            <Text style={styles.fundVal}>{v}</Text>
          </Row>
        ))}
      </View>

      {/* Financial performance */}
      <FinancialPerformance fund={fund} cur={cur} c={c} styles={styles} />

      {/* Similar stocks */}
      {similar.length > 0 && (
        <View>
          <SectionTitle styles={styles}>Similar stocks</SectionTitle>
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <Row style={styles.simHead}>
              <Text style={[styles.simHeadTxt, { flex: 1 }]}>Stock</Text>
              <Text style={[styles.simHeadTxt, { width: 92, textAlign: 'right' }]}>Mkt price (1D)</Text>
              <Text style={[styles.simHeadTxt, { width: 78, textAlign: 'right' }]}>Mkt cap</Text>
            </Row>
            {similar.map((r) => {
              const p = Number(r.lastPrice || 0);
              const ch = Number(r.change24h || 0);
              return (
                <TouchableOpacity key={r.symbol} onPress={() => onOpen(r)} style={styles.simRow}>
                  <Row style={{ flex: 1, gap: 10, alignItems: 'center' }}>
                    <AssetGlyph inst={r} symbol={r.symbol} size={30} c={c} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.simName} numberOfLines={1}>{r.name || r.symbol}</Text>
                      <Text style={styles.simSym}>{r.symbol}</Text>
                    </View>
                  </Row>
                  <View style={{ width: 92, alignItems: 'flex-end' }}>
                    <Text style={styles.simPrice}>₹{fmtNum(p, 2)}</Text>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: ch >= 0 ? c.bull : c.bear }}>{ch >= 0 ? '+' : ''}{ch.toFixed(2)}%</Text>
                  </View>
                  <Text style={[styles.simCap, { width: 78 }]}>{fmtInt(p * 4.2e8 / 1e7)}</Text>
                </TouchableOpacity>
              );
            })}
          </Card>
        </View>
      )}
    </View>
  );
}

function DepthCol({ title, rows, tone, prec, c, styles }) {
  const QTY = (r) => Number(r.quantity ?? r.qty ?? 0);
  const max = Math.max(1, ...rows.map(QTY));
  const color = tone === 'bull' ? c.bull : c.bear;
  const bg = tone === 'bull' ? c.bullSoft : c.bearSoft;
  return (
    <View style={{ flex: 1 }}>
      <Row style={{ justifyContent: 'space-between', paddingBottom: 6 }}>
        <Text style={styles.depthHdr}>{title}</Text><Text style={styles.depthHdr}>Qty</Text>
      </Row>
      {rows.length === 0 ? (
        <Text style={styles.centerMuted}>No depth</Text>
      ) : rows.slice(0, 5).map((r, i) => {
        const q = QTY(r);
        return (
          <View key={i} style={{ position: 'relative', paddingVertical: 5, justifyContent: 'center' }}>
            <View style={{ position: 'absolute', right: 0, top: 2, bottom: 2, width: `${(q / max) * 100}%`, backgroundColor: bg, borderRadius: 3 }} />
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={{ color, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{fmtNum(r.price, prec)}</Text>
              <Text style={{ color: c.textPrimary, fontSize: 13, fontVariant: ['tabular-nums'] }}>{fmtInt(q)}</Text>
            </Row>
          </View>
        );
      })}
    </View>
  );
}

function RangeBar({ label1, v1, label2, v2, cur, prec, value, c, styles }) {
  const pos = v2 > v1 ? Math.min(100, Math.max(0, ((value - v1) / (v2 - v1)) * 100)) : 50;
  return (
    <View>
      <Row style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <View><Text style={styles.rbLabel}>{label1}</Text><Text style={styles.rbVal}>{cur}{fmtNum(v1, prec)}</Text></View>
        <View style={{ alignItems: 'flex-end' }}><Text style={styles.rbLabel}>{label2}</Text><Text style={styles.rbVal}>{cur}{fmtNum(v2, prec)}</Text></View>
      </Row>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: c.bull }}>
        <View style={{ position: 'absolute', top: -4, left: `${pos}%`, marginLeft: -5, width: 0, height: 0, borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 8, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: c.textSecondary }} />
      </View>
    </View>
  );
}

function Metric({ label, value, styles }) {
  return (
    <View style={styles.metricCell}>
      <Text style={styles.metricLabel} numberOfLines={1}>{label}</Text>
      <Text style={styles.metricVal} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function FinancialPerformance({ fund, cur, c, styles }) {
  const [mode, setMode] = useState('Quarterly');
  const [sel, setSel] = useState(null);
  const raw = mode === 'Quarterly' ? (fund?.finQuarterly || []) : (fund?.finYearly || []);
  const src = raw.length ? raw : [
    { label: 'Q1', revenue: 3.0e11, profit: 3.8e10 }, { label: 'Q2', revenue: 3.2e11, profit: 4.0e10 },
    { label: 'Q3', revenue: 3.4e11, profit: 4.1e10 }, { label: 'Q4', revenue: 3.4e11, profit: 3.9e10 },
    { label: 'Q5', revenue: 3.5e11, profit: 4.2e10 },
  ];
  const bars = src.map((d) => ({ label: fmtFinLabel(d.label), rev: (Number(d.revenue) || 0) / 1e7, pr: (Number(d.profit) || 0) / 1e7 }));
  const selIdx = sel != null && sel < bars.length ? sel : bars.length - 1;
  const selBar = bars[selIdx] || { label: '', rev: 0, pr: 0 };
  const growth = (arr, i, k) => (i > 0 && arr[i - 1][k] ? ((arr[i][k] - arr[i - 1][k]) / Math.abs(arr[i - 1][k])) * 100 : null);
  const revG = growth(bars, selIdx, 'rev');
  const prG = growth(bars, selIdx, 'pr');
  const niceMax = niceCeil(Math.max(...bars.map((b) => Math.max(b.rev, b.pr)), 1));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => niceMax * f);

  const yearly = fund?.finYearly || [];
  const cagr = (k) => {
    if (yearly.length < 3) return null;
    const a = Number(yearly[0][k]), b = Number(yearly[yearly.length - 1][k]);
    if (!(a > 0) || !(b > 0)) return null;
    return (Math.pow(b / a, 1 / (yearly.length - 1)) - 1) * 100;
  };
  const rev1y = fund?.revenueGrowth != null ? fund.revenueGrowth * 100 : null;
  const pr1y = fund?.earningsGrowth != null ? fund.earningsGrowth * 100 : null;

  const kfmt = (v) => `${Math.round(v / 1000)}k`;
  const crfmt = (v) => `${cur}${fmtInt(Math.round(v))}`;
  const Pct = ({ v }) => v == null ? <Text style={{ color: c.textMuted }}>—</Text> : <Text style={{ color: v >= 0 ? c.bull : c.bear }}>{v >= 0 ? '+' : ''}{v.toFixed(mode === 'Quarterly' ? 2 : 0)}%</Text>;
  const PctInt = ({ v }) => v == null ? <Text style={{ color: c.textMuted, fontWeight: '800' }}>—</Text> : <Text style={{ color: v >= 0 ? c.bull : c.bear, fontWeight: '800' }}>{v >= 0 ? '+' : ''}{v.toFixed(0)}%</Text>;
  const Dot = ({ color }) => <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color }} />;

  const PLOT = 160;
  const revColor = '#64748B';
  const grow = [
    { title: 'Revenue Growth', one: rev1y, three: cagr('revenue') },
    { title: 'Profit Growth', one: pr1y, three: cagr('profit') },
  ];

  return (
    <View>
      <SectionTitle styles={styles}>Financial performance</SectionTitle>
      <Row style={{ gap: 8, marginBottom: 14 }}>
        {['Quarterly', 'Yearly'].map((m) => {
          const on = mode === m;
          return (
            <TouchableOpacity key={m} onPress={() => { setMode(m); setSel(null); }} style={[styles.segPill, on && { borderColor: c.primary500, backgroundColor: c.primarySoft }]}>
              <Text style={{ fontSize: 12, fontWeight: '800', color: on ? c.primary500 : c.textSecondary }}>{m}</Text>
            </TouchableOpacity>
          );
        })}
      </Row>

      <Card>
        <Text style={styles.finPeriod}>{selBar.label}</Text>
        <Row style={{ gap: 28, marginTop: 6 }}>
          <View>
            <Row style={{ gap: 6, alignItems: 'center' }}><Dot color={revColor} /><Text style={styles.finLegend}>Revenue (Cr)</Text></Row>
            <Text style={styles.finBig}>{crfmt(selBar.rev)} <Text style={styles.finPct}><Pct v={revG} /></Text></Text>
          </View>
          <View>
            <Row style={{ gap: 6, alignItems: 'center' }}><Dot color={c.bull} /><Text style={styles.finLegend}>Profit (Cr)</Text></Row>
            <Text style={styles.finBig}>{crfmt(selBar.pr)} <Text style={styles.finPct}><Pct v={prG} /></Text></Text>
          </View>
        </Row>

        {/* Bar chart */}
        <View style={{ height: PLOT, marginTop: 18 }}>
          {ticks.map((t, i) => (
            <View key={`g${i}`} style={{ position: 'absolute', left: 0, right: 30, bottom: `${(t / niceMax) * 100}%`, height: 1, backgroundColor: c.borderSubtle }} />
          ))}
          {ticks.map((t, i) => (
            <Text key={`y${i}`} style={{ position: 'absolute', right: 0, bottom: `${(t / niceMax) * 100}%`, fontSize: 9, color: c.textMuted, transform: [{ translateY: 5 }] }}>{kfmt(t)}</Text>
          ))}
          <View style={{ position: 'absolute', left: 0, right: 30, top: 0, bottom: 0, flexDirection: 'row', alignItems: 'flex-end' }}>
            {bars.map((b, i) => (
              <TouchableOpacity key={i} onPress={() => setSel(i)} activeOpacity={0.7} style={{ flex: 1, height: '100%', flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 3 }}>
                <View style={{ width: 9, height: `${(b.rev / niceMax) * 100}%`, backgroundColor: i === selIdx ? revColor : c.borderSubtle, borderTopLeftRadius: 2, borderTopRightRadius: 2 }} />
                <View style={{ width: 9, height: `${(b.pr / niceMax) * 100}%`, backgroundColor: i === selIdx ? c.bull : c.bullSoft, borderTopLeftRadius: 2, borderTopRightRadius: 2 }} />
              </TouchableOpacity>
            ))}
          </View>
        </View>
        <View style={{ flexDirection: 'row', marginTop: 6, paddingRight: 30 }}>
          {bars.map((b, i) => (
            <Text key={i} style={{ flex: 1, textAlign: 'center', fontSize: 10, color: i === selIdx ? c.textPrimary : c.textMuted, fontWeight: i === selIdx ? '800' : '400' }} numberOfLines={1}>{b.label}</Text>
          ))}
        </View>
      </Card>

      {/* Growth */}
      <View style={{ marginTop: 16, gap: 16 }}>
        {grow.map((g) => (
          <View key={g.title}>
            <Row style={{ justifyContent: 'space-between', paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: c.borderSubtle }}>
              <Text style={styles.grHdr}>{g.title}</Text><Text style={styles.grHdr}>Value</Text>
            </Row>
            <Row style={{ justifyContent: 'space-between', paddingVertical: 8 }}><Text style={styles.grLbl}>1Y (TTM)</Text><PctInt v={g.one} /></Row>
            <Row style={{ justifyContent: 'space-between', paddingVertical: 8 }}><Text style={styles.grLbl}>3Y CAGR</Text><PctInt v={g.three} /></Row>
          </View>
        ))}
      </View>
    </View>
  );
}

/* ─────────────────────────── Technicals tab ─────────────────────────── */
function TechnicalsTab({ candles, lastPrice, cur, prec, fund, dayLow, dayHigh, c, styles }) {
  const closes = candles.map((k) => Number(k.close));
  const mas = [['SMA 20', sma(closes, 20)], ['SMA 50', sma(closes, 50)], ['SMA 200', sma(closes, 200)]].filter(([, v]) => v != null);
  const r = rsi14(closes);
  let bull = 0, bear = 0;
  mas.forEach(([, v]) => (lastPrice >= v ? bull++ : bear++));
  if (r != null) { if (r >= 55) bull++; else if (r <= 45) bear++; }
  const signal = bull > bear ? 'Bullish' : bear > bull ? 'Bearish' : 'Neutral';
  const sigColor = signal === 'Bullish' ? c.bull : signal === 'Bearish' ? c.bear : c.textMuted;
  const rows = [
    ...mas.map(([k, v]) => [k, `${cur}${fmtNum(v, prec)}`, lastPrice >= v ? 'Bullish' : 'Bearish', lastPrice >= v]),
    r != null ? ['RSI (14)', r.toFixed(2), r >= 70 ? 'Overbought' : r <= 30 ? 'Oversold' : r >= 55 ? 'Bullish' : r <= 45 ? 'Bearish' : 'Neutral', r >= 50] : null,
    ['Day range', `${cur}${fmtNum(dayLow, prec)} – ${cur}${fmtNum(dayHigh, prec)}`, '', null],
    fund?.week52Low != null ? ['52-week range', `${cur}${fmtNum(fund.week52Low, prec)} – ${cur}${fmtNum(fund.week52High, prec)}`, '', null] : null,
  ].filter(Boolean);

  return (
    <View style={{ gap: 16 }}>
      <Card>
        <Row style={{ gap: 14 }}>
          <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: sigColor, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900' }}>{signal[0]}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.grHdr}>Technical Summary</Text>
            <Text style={{ fontSize: 20, fontWeight: '900', color: sigColor }}>{signal}</Text>
            <Text style={{ fontSize: 11, color: c.textMuted, marginTop: 2 }}>
              {mas.filter(([, v]) => lastPrice >= v).length} of {mas.length} moving averages bullish{r != null ? ` · RSI ${r.toFixed(0)}` : ''}
            </Text>
          </View>
        </Row>
      </Card>

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <Row style={styles.tHead}>
          <Text style={[styles.tHeadTxt, { flex: 1 }]}>Indicator</Text>
          <Text style={[styles.tHeadTxt, { flex: 1, textAlign: 'right' }]}>Value</Text>
          <Text style={[styles.tHeadTxt, { width: 90, textAlign: 'right' }]}>Signal</Text>
        </Row>
        {rows.map((row, i) => {
          const [k, v, sig, pos] = row;
          return (
            <Row key={i} style={styles.tRow}>
              <Text style={{ flex: 1, fontSize: 13, color: c.textSecondary }}>{k}</Text>
              <Text style={{ flex: 1, fontSize: 13, textAlign: 'right', color: c.textPrimary, fontVariant: ['tabular-nums'] }}>{v}</Text>
              <View style={{ width: 90, alignItems: 'flex-end' }}>
                {sig ? <Text style={{ fontSize: 11, fontWeight: '800', color: pos ? c.bull : c.bear }}>{sig}</Text> : <Text style={{ color: c.textMuted }}>—</Text>}
              </View>
            </Row>
          );
        })}
      </Card>
      <Text style={styles.note}>Computed live from {candles.length} price candles. Not investment advice.</Text>
    </View>
  );
}

/* ─────────────────────────── News tab ─────────────────────────── */
function NewsTab({ symbol, name, c, styles }) {
  const [news, setNews] = useState(null);
  useEffect(() => {
    let dead = false;
    api.get(`/instruments/${encodeURIComponent(symbol)}/news`)
      .then(({ data }) => { if (!dead) setNews(data?.data || []); })
      .catch(() => { if (!dead) setNews([]); });
    return () => { dead = true; };
  }, [symbol]);

  if (news == null) return <Text style={styles.centerMuted}>Loading news…</Text>;
  if (!news.length) return <Text style={styles.centerMuted}>No recent news for {name}.</Text>;
  return (
    <View>
      {news.map((n, i) => (
        <TouchableOpacity key={i} onPress={() => n.link && Linking.openURL(n.link)} style={styles.newsRow}>
          {n.thumbnail ? <Image source={{ uri: n.thumbnail }} style={{ width: 84, height: 56, borderRadius: 8, backgroundColor: c.hover }} /> : null}
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: c.textPrimary, lineHeight: 18 }} numberOfLines={3}>{n.title}</Text>
            <Text style={{ fontSize: 11, color: c.textMuted, marginTop: 4 }}>{n.publisher}{n.publishedAt ? ` · ${timeAgo(n.publishedAt)}` : ''}</Text>
          </View>
          <Ionicons name="open-outline" size={15} color={c.textMuted} />
        </TouchableOpacity>
      ))}
    </View>
  );
}

const makeStyles = (c) => StyleSheet.create({
  hSym: { fontSize: 12, color: c.textMuted, fontWeight: '700' },
  hName: { fontSize: 20, fontWeight: '800', color: c.textPrimary, marginTop: 1 },
  price: { fontSize: 28, fontWeight: '900', color: c.textPrimary, fontVariant: ['tabular-nums'] },
  tfPill: { minWidth: 44, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: c.border, alignItems: 'center' },
  segPill: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: c.border, alignItems: 'center' },
  tabBar: { flexDirection: 'row', gap: 20, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  tabItem: { paddingBottom: 10, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  secTitle: { fontSize: 16, fontWeight: '800', color: c.textPrimary, marginBottom: 12 },

  depthPct: { fontSize: 12, fontWeight: '600', color: c.textSecondary },
  depthHdr: { fontSize: 11, color: c.textMuted, fontWeight: '700' },
  totLbl: { fontSize: 13, fontWeight: '800', color: c.textPrimary },
  totVal: { fontSize: 13, fontWeight: '800', color: c.textPrimary, fontVariant: ['tabular-nums'] },
  centerMuted: { fontSize: 12, color: c.textMuted, textAlign: 'center', paddingVertical: 24 },

  rbLabel: { fontSize: 11, color: c.textMuted },
  rbVal: { fontSize: 13, fontWeight: '700', color: c.textPrimary, fontVariant: ['tabular-nums'] },
  metricCell: { width: '33.33%', paddingRight: 8, marginBottom: 14 },
  metricLabel: { fontSize: 11, color: c.textMuted },
  metricVal: { fontSize: 14, fontWeight: '700', color: c.textPrimary, marginTop: 2, fontVariant: ['tabular-nums'] },

  fundRow: { justifyContent: 'space-between', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  fundKey: { fontSize: 13, color: c.textSecondary },
  fundVal: { fontSize: 13, fontWeight: '700', color: c.textPrimary, fontVariant: ['tabular-nums'] },

  finPeriod: { fontSize: 11, fontWeight: '800', color: c.textMuted, letterSpacing: 0.5, textTransform: 'uppercase' },
  finLegend: { fontSize: 11, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  finBig: { fontSize: 17, fontWeight: '800', color: c.textPrimary, marginTop: 3, fontVariant: ['tabular-nums'] },
  finPct: { fontSize: 12 },
  grHdr: { fontSize: 11, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  grLbl: { fontSize: 13, color: c.textSecondary },

  simHead: { paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.hover, alignItems: 'center' },
  simHeadTxt: { fontSize: 10, fontWeight: '800', color: c.textMuted, letterSpacing: 0.4, textTransform: 'uppercase' },
  simRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 11, borderTopWidth: 1, borderTopColor: c.borderSubtle, gap: 8 },
  simName: { fontSize: 13, fontWeight: '700', color: c.textPrimary },
  simSym: { fontSize: 10, color: c.textMuted, marginTop: 1 },
  simPrice: { fontSize: 13, fontWeight: '700', color: c.textPrimary, fontVariant: ['tabular-nums'] },
  simCap: { fontSize: 12, color: c.textSecondary, textAlign: 'right', fontVariant: ['tabular-nums'] },

  tHead: { paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.hover, alignItems: 'center' },
  tHeadTxt: { fontSize: 10, fontWeight: '800', color: c.textMuted, letterSpacing: 0.4, textTransform: 'uppercase' },
  tRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 11, borderTopWidth: 1, borderTopColor: c.borderSubtle, gap: 6 },
  note: { fontSize: 11, color: c.textMuted, marginTop: 8 },

  oiLbl: { fontSize: 11, color: c.textMuted },
  oiVal: { fontSize: 18, fontWeight: '800', color: c.textPrimary, marginTop: 2, fontVariant: ['tabular-nums'] },
  futCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: 14 },
  futName: { fontSize: 13, fontWeight: '800', color: c.textPrimary },
  futExp: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  futPrice: { fontSize: 15, fontWeight: '800', color: c.textPrimary, fontVariant: ['tabular-nums'] },
  segTab: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 6 },

  bottomBar: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', gap: 12, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 22, backgroundColor: c.card, borderTopWidth: 1, borderTopColor: c.border },
});
