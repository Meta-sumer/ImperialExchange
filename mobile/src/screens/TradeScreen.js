import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl,
  Alert, Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { useAccounts } from '../store/account';
import { useAccountPlans, feeGroupOf, planForType } from '../hooks/useAccountPlans';
import { useColors, radius, fmtNum, currencySymbol } from '../theme';
import { Card, Button, Row, Pill, Loader, Empty } from '../components/ui';
import AccountSwitcher from '../components/AccountSwitcher';
import TradingViewChart from '../components/TradingViewChart';

/**
 * TradeScreen — the mobile trading terminal. A native port of the web client's
 * Trade page (client/src/pages/Trade.jsx), rendered as the web's OWN responsive
 * / mobile layout (single column) instead of the desktop multi-pane terminal:
 *
 *   1. Account bar        — AccountSwitcher chips + live Equity / Balance / P/L
 *   2. Symbol header      — active instrument + live price + 24h change, a
 *                           horizontal symbol strip + a searchable picker modal
 *   3. Chart              — reused TradingViewChart (timeframes + fullscreen)
 *   4. Buy / Sell bar     — big BUY (c.bull) / SELL (c.bear) → inline order
 *                           bottom-sheet (Market/Limit · volume · SL/TP · live
 *                           fee breakdown · account) → POST /trading/orders
 *   5. Open / Pending / Closed panel — live position cards (Close · Edit SL/TP),
 *                           pending orders (Cancel), recent closed trades, and a
 *                           Close-All action
 *   6. Equity footer      — Equity · Balance · Free Margin · Margin · Margin Level
 *
 * Endpoints (same as the web): /instruments, /instruments/watchlist,
 * /instruments/:symbol, /user/accounts, /user/leverage, /wallet/balances,
 * /account-plans, /trading/orders, /trading/orders/open, /trading/orders/:id
 * (DELETE cancel · PUT modify), /trading/positions, /trading/positions/:id
 * (PUT SL/TP), /trading/positions/:id/close, /trading/positions/close-all,
 * /trading/positions/history.
 * WS channels: ticker:<symbol>, positions, orders, wallet.
 */

const PANEL_TABS = ['Open', 'Pending', 'Closed'];
const isDemo = (t) => ['DEMO', 'VIRTUAL'].includes(String(t || '').toUpperCase());
const precOf = (inst) => Math.min(Number(inst?.pricePrecision) || 2, 5);
const money = (v, cur) => `${currencySymbol(cur)}${fmtNum(v, 2)}`;

// ── Live PnL per the web's exact formula (Trade.jsx positionsWithLivePnl) ──
function livePnl(p, priceMap) {
  const mark = Number(priceMap[p.symbol] ?? p.markPrice ?? p.entryPrice);
  const entry = Number(p.entryPrice);
  const qty = Number(p.quantity);
  const long = (p.positionSide || (p.side === 'BUY' ? 'LONG' : 'SHORT')) === 'LONG';
  if (!Number.isFinite(entry) || !Number.isFinite(qty) || !Number.isFinite(mark)) {
    return { mark, pnl: Number(p.unrealizedPnl || 0) };
  }
  return { mark, pnl: long ? (mark - entry) * qty : (entry - mark) * qty };
}

// ─────────────────────────── Presentational pieces ───────────────────────────
// (module scope — every helper receives styles / c via props; never a free c)

function AccountSummary({ c, styles, equityNums, floating, cur }) {
  return (
    <Row style={styles.sumStrip}>
      <SumItem styles={styles} c={c} label="Equity" value={equityNums ? money(equityNums.equity, cur) : '—'} />
      <SumItem styles={styles} c={c} label="Balance" value={equityNums ? money(equityNums.balance, cur) : '—'} />
      <SumItem
        styles={styles} c={c} label="Floating P/L"
        value={`${floating >= 0 ? '+' : ''}${money(floating, cur)}`}
        tone={floating >= 0 ? c.bull : c.bear}
      />
    </Row>
  );
}

function SumItem({ styles, c, label, value, tone }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={styles.sumLabel}>{label}</Text>
      <Text style={[styles.sumValue, tone && { color: tone }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function SymbolHeader({ c, styles, instrument, symbol, last, changePct, onPick }) {
  const prec = precOf(instrument);
  const qsym = currencySymbol(instrument?.quoteCurrency || 'USD');
  const up = Number(changePct) >= 0;
  const hasChg = Number.isFinite(Number(changePct));
  return (
    <TouchableOpacity activeOpacity={0.8} onPress={onPick} style={styles.symHeader}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Row style={{ gap: 6 }}>
          <Text style={styles.symName} numberOfLines={1}>{symbol || '—'}</Text>
          <Ionicons name="chevron-down" size={16} color={c.textMuted} />
        </Row>
        <Text style={styles.symSub} numberOfLines={1}>{instrument?.name || 'Tap to switch instrument'}</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={styles.symPrice} numberOfLines={1}>{last != null ? `${qsym}${fmtNum(last, prec)}` : '—'}</Text>
        {hasChg ? (
          <Text style={[styles.symChange, { color: up ? c.bull : c.bear }]}>
            {up ? '▲ +' : '▼ '}{fmtNum(changePct, 2)}%
          </Text>
        ) : <Text style={styles.symChangeMuted}>24h</Text>}
      </View>
    </TouchableOpacity>
  );
}

function SymbolStrip({ c, styles, rows, active, onSelect }) {
  if (!rows.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stripRow}>
      {rows.map((r) => {
        const on = r.symbol === active;
        const up = Number(r.change24h) >= 0;
        return (
          <TouchableOpacity key={r.symbol} onPress={() => onSelect(r.symbol)} style={[styles.stripChip, on && styles.stripChipOn]}>
            <Text style={[styles.stripSym, on && { color: c.primary500 }]} numberOfLines={1}>{r.symbol}</Text>
            {Number.isFinite(Number(r.change24h)) ? (
              <Text style={{ fontSize: 10, fontWeight: '700', color: up ? c.bull : c.bear }}>
                {up ? '+' : ''}{fmtNum(r.change24h, 2)}%
              </Text>
            ) : null}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

function PanelTabs({ c, styles, tab, setTab, counts, onCloseAll, canCloseAll }) {
  return (
    <Row style={styles.panelHead}>
      <Row style={{ gap: 8, flex: 1 }}>
        {PANEL_TABS.map((t) => {
          const on = tab === t;
          const n = counts[t];
          return (
            <TouchableOpacity key={t} onPress={() => setTab(t)} style={[styles.panelTab, on && styles.panelTabOn]}>
              <Text style={[styles.panelTabTxt, on && { color: c.primary500 }]}>{t}</Text>
              {n != null && n > 0 ? (
                <View style={[styles.countBadge, on && { backgroundColor: c.primarySoft }]}>
                  <Text style={[styles.countTxt, on && { color: c.primary500 }]}>{n}</Text>
                </View>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </Row>
      {tab === 'Open' && canCloseAll ? (
        <TouchableOpacity onPress={onCloseAll} style={styles.closeAllBtn}>
          <Text style={styles.closeAllTxt}>Close all</Text>
        </TouchableOpacity>
      ) : null}
    </Row>
  );
}

function PositionRow({ c, styles, p, cur, prec, onClose, onEdit }) {
  const pnl = Number(p.unrealizedPnl || 0);
  const buy = p.side === 'BUY';
  return (
    <Card style={{ marginBottom: 10 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Row style={{ gap: 8, flex: 1, minWidth: 0 }}>
          <Text style={styles.rowSym} numberOfLines={1}>{p.symbol}</Text>
          <Pill label={buy ? 'BUY' : 'SELL'} tone={buy ? 'bull' : 'bear'} />
        </Row>
        <Text style={[styles.rowPnl, { color: pnl >= 0 ? c.bull : c.bear }]}>
          {pnl >= 0 ? '+' : ''}{money(pnl, cur)}
        </Text>
      </Row>
      <Row style={{ justifyContent: 'space-between', marginTop: 10 }}>
        <Meta styles={styles} label="Volume" value={fmtNum(p.quantity, 4)} />
        <Meta styles={styles} label="Entry" value={fmtNum(p.entryPrice, prec)} />
        <Meta styles={styles} label="Mark" value={fmtNum(p.markPrice ?? p.entryPrice, prec)} align="flex-end" />
      </Row>
      {(p.stopLoss || p.takeProfit) ? (
        <Row style={{ gap: 14, marginTop: 8 }}>
          {p.stopLoss ? <Text style={styles.slTag}>SL {fmtNum(p.stopLoss, prec)}</Text> : null}
          {p.takeProfit ? <Text style={styles.tpTag}>TP {fmtNum(p.takeProfit, prec)}</Text> : null}
        </Row>
      ) : null}
      <Row style={{ gap: 8, marginTop: 12 }}>
        <TouchableOpacity onPress={() => onEdit(p)} style={styles.editBtn}>
          <Text style={styles.editTxt}>Edit SL/TP</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => onClose(p)} style={styles.closeBtn}>
          <Text style={styles.closeTxt}>Close</Text>
        </TouchableOpacity>
      </Row>
    </Card>
  );
}

function OrderRow({ c, styles, o, prec, onCancel }) {
  const buy = o.side === 'BUY';
  return (
    <Card style={{ marginBottom: 10 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Row style={{ gap: 8, flex: 1, minWidth: 0 }}>
          <Text style={styles.rowSym} numberOfLines={1}>{o.symbol}</Text>
          <Pill label={buy ? 'BUY' : 'SELL'} tone={buy ? 'bull' : 'bear'} />
          <Pill label={o.type || o.orderMode || 'LIMIT'} tone="primary" />
        </Row>
        <Pill label={o.status || 'PENDING'} tone="warn" />
      </Row>
      <Row style={{ justifyContent: 'space-between', marginTop: 10 }}>
        <Meta styles={styles} label="Volume" value={fmtNum(o.quantity, 4)} />
        <Meta styles={styles} label="Price" value={fmtNum(o.price ?? o.stopPrice, prec)} />
        <View style={{ alignItems: 'flex-end', justifyContent: 'flex-end' }}>
          <TouchableOpacity onPress={() => onCancel(o)} style={styles.cancelBtn}>
            <Text style={styles.cancelTxt}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </Row>
    </Card>
  );
}

function ClosedRow({ c, styles, t, prec }) {
  const pnl = Number(t.realizedPnl || 0);
  const buy = t.side === 'BUY';
  const qty = Number(t.closedQuantity) > 0 ? t.closedQuantity : t.quantity;
  return (
    <Card style={{ marginBottom: 10 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Row style={{ gap: 8, flex: 1, minWidth: 0 }}>
          <Text style={styles.rowSym} numberOfLines={1}>{t.symbol}</Text>
          <Pill label={buy ? 'BUY' : 'SELL'} tone={buy ? 'bull' : 'bear'} />
        </Row>
        <Text style={[styles.rowPnl, { color: pnl >= 0 ? c.bull : c.bear }]}>
          {pnl >= 0 ? '+' : ''}{fmtNum(pnl, 2)}
        </Text>
      </Row>
      <Row style={{ justifyContent: 'space-between', marginTop: 10 }}>
        <Meta styles={styles} label="Volume" value={fmtNum(qty, 4)} />
        <Meta styles={styles} label="Entry" value={fmtNum(t.entryPrice, prec)} />
        <Meta styles={styles} label="Close" value={fmtNum(t.closePrice, prec)} align="flex-end" />
      </Row>
    </Card>
  );
}

function Meta({ styles, label, value, align }) {
  return (
    <View style={{ alignItems: align || 'flex-start' }}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

function EquityFooter({ c, styles, equityNums }) {
  if (!equityNums) return null;
  const lvl = equityNums.marginLevel;
  return (
    <View style={styles.footerBar}>
      <FooterStat styles={styles} c={c} label="Equity" value={money(equityNums.equity, equityNums.base)} />
      <FooterStat styles={styles} c={c} label="Balance" value={money(equityNums.balance, equityNums.base)} />
      <FooterStat styles={styles} c={c} label="Free Margin" value={money(equityNums.free, equityNums.base)} />
      <FooterStat styles={styles} c={c} label="Margin" value={money(equityNums.used, equityNums.base)} />
      <FooterStat
        styles={styles} c={c} label="Margin Level"
        value={lvl != null ? `${lvl.toFixed(2)}%` : '—'}
        color={lvl != null && lvl < 100 ? c.bear : undefined}
      />
    </View>
  );
}

function FooterStat({ styles, c, label, value, color }) {
  return (
    <View style={styles.footerStat}>
      <Text style={styles.footerLabel}>{label}</Text>
      <Text style={[styles.footerValue, color && { color }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function Seg({ styles, active, onPress, label, tone, small }) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.seg, { height: small ? 36 : 44 }, active && { backgroundColor: tone, borderColor: tone }]}>
      <Text style={[styles.segTxt, active && { color: '#fff' }, small && { fontSize: 13 }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Field({ c, styles, label, value, onChangeText, placeholder }) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.lbl}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={c.textMuted}
        keyboardType="decimal-pad"
        style={styles.input}
      />
    </View>
  );
}

function FeeRow({ styles, label, rule, value }) {
  return (
    <Row style={{ justifyContent: 'space-between', marginBottom: 8 }}>
      <View style={{ flex: 1 }}>
        <Text style={styles.metaValue}>{label}</Text>
        <Text style={styles.metaLabel}>{rule}</Text>
      </View>
      <Text style={styles.metaValue}>{value}</Text>
    </Row>
  );
}

// ────────────────────────────────── Screen ──────────────────────────────────
export default function TradeScreen({ navigation }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const { accounts, selectedId, select, selected } = useAccounts();
  const account = selected();
  const byCode = useAccountPlans();

  // Instruments catalogue + active symbol
  const [catalog, setCatalog] = useState([]);
  const [symbol, setSymbol] = useState(null);
  const [instrument, setInstrument] = useState(null);
  const [ticker, setTicker] = useState({ last: null, changePct: null });

  // Account-scoped tables
  const [positions, setPositions] = useState(null);
  const [openOrders, setOpenOrders] = useState(null);
  const [closedTrades, setClosedTrades] = useState(null);
  const [priceMap, setPriceMap] = useState({});

  // Account metrics
  const [walletFree, setWalletFree] = useState('0');
  const [leverage, setLeverage] = useState(null);

  // UI state
  const [tab, setTab] = useState('Open');
  const [refreshing, setRefreshing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');

  // Order bottom-sheet
  const [sheetSide, setSheetSide] = useState(null); // 'BUY' | 'SELL' | null
  const [mode, setMode] = useState('MARKET');
  const [qty, setQty] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [sheetSl, setSheetSl] = useState('');
  const [sheetTp, setSheetTp] = useState('');
  const [placing, setPlacing] = useState(false);

  // SL/TP edit modal (open positions)
  const [editPos, setEditPos] = useState(null);
  const [editSl, setEditSl] = useState('');
  const [editTp, setEditTp] = useState('');
  const [saving, setSaving] = useState(false);

  const cur = account?.baseCurrency || 'USD';
  const prec = precOf(instrument);

  // ── Load the instruments catalogue once (watchlist = curated + live prices,
  //    merged with /instruments for full metadata). Seeds the active symbol. ──
  useEffect(() => {
    let dead = false;
    (async () => {
      const [wl, cat] = await Promise.all([
        api.get('/instruments/watchlist').then((r) => r.data?.data || []).catch(() => []),
        api.get('/instruments').then((r) => r.data?.data || []).catch(() => []),
      ]);
      if (dead) return;
      const catBy = new Map(cat.map((r) => [r.symbol, r]));
      const merged = wl.map((w) => ({ ...(catBy.get(w.symbol) || {}), ...w })).filter((r) => r.symbol);
      const list = merged.length ? merged : cat;
      setCatalog(list);
      setSymbol((prev) => prev || list[0]?.symbol || null);
    })();
    return () => { dead = true; };
  }, []);

  const catBySymbol = useMemo(() => {
    const m = {};
    for (const r of catalog) m[r.symbol] = r;
    return m;
  }, [catalog]);

  // ── Full instrument detail on symbol switch (quoteCurrency, precision,
  //    spread, minOrderSize, maxLeverage …) — seed from the catalogue row. ──
  useEffect(() => {
    if (!symbol) return undefined;
    let dead = false;
    const seed = catBySymbol[symbol];
    if (seed) setInstrument(seed);
    setTicker({
      last: seed?.lastPrice != null ? Number(seed.lastPrice) : null,
      changePct: seed?.change24h != null ? Number(seed.change24h) : null,
    });
    api.get(`/instruments/${encodeURIComponent(symbol)}`)
      .then(({ data }) => { if (!dead && data?.data) setInstrument((p) => ({ ...(p || {}), ...data.data })); })
      .catch(() => {});
    return () => { dead = true; };
  }, [symbol, catBySymbol]);

  // ── Live ticker for the active symbol → header price + 24h change + priceMap ──
  useEffect(() => {
    if (!symbol) return undefined;
    const off = wsClient.subscribe(`ticker:${symbol}`, (data) => {
      const p = Number(data?.lastPrice ?? data?.price);
      const chg = Number(data?.change24h);
      setTicker((prev) => ({
        last: Number.isFinite(p) ? p : prev.last,
        changePct: Number.isFinite(chg) ? chg : prev.changePct,
      }));
      if (Number.isFinite(p)) setPriceMap((prev) => ({ ...prev, [symbol]: p }));
    });
    return off;
  }, [symbol]);

  // ── Account-scoped Open / Pending / Closed (same endpoints as the web) ──
  const refresh = useCallback(async () => {
    const accId = account?._id || selectedId || null;
    const accParam = accId ? { accountId: accId } : {};
    const [o, p, h] = await Promise.allSettled([
      api.get('/trading/orders/open', { params: accParam }),
      api.get('/trading/positions', { params: accParam }),
      api.get('/trading/positions/history', { params: { ...accParam, limit: 50 } }),
    ]);
    const scoped = (arr) => (accId ? (arr || []).filter((x) => !x.accountId || String(x.accountId) === String(accId)) : (arr || []));
    if (o.status === 'fulfilled') setOpenOrders(scoped(o.value.data?.data));
    if (p.status === 'fulfilled') setPositions(scoped(p.value.data?.data));
    if (h.status === 'fulfilled') setClosedTrades(scoped(h.value.data?.data?.items || []));
  }, [account?._id, selectedId]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Reset + reload on account switch; poll for live PnL between WS pushes.
  useEffect(() => {
    setPositions(null);
    setOpenOrders(null);
    setClosedTrades(null);
    refresh();
    const id = setInterval(() => refreshRef.current(), 5000);
    return () => clearInterval(id);
  }, [account?._id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Private channels — refresh on any fill / trigger / wallet change.
  useEffect(() => {
    const u1 = wsClient.subscribe('user:positions', () => refreshRef.current());
    const u2 = wsClient.subscribe('user:orders', () => refreshRef.current());
    const u3 = wsClient.subscribe('user:wallet', () => refreshRef.current());
    return () => { u1 && u1(); u2 && u2(); u3 && u3(); };
  }, []);

  // Live prices for every symbol that has a position or pending order.
  const symbolsKey = useMemo(() => {
    const set = new Set([
      ...(positions || []).map((p) => p.symbol),
      ...(openOrders || []).map((o) => o.symbol),
    ]);
    return [...set].filter(Boolean).sort().join('|');
  }, [positions, openOrders]);
  useEffect(() => {
    if (!symbolsKey) return undefined;
    const unsubs = symbolsKey.split('|').map((s) =>
      wsClient.subscribe(`ticker:${s}`, (d) => {
        const p = Number(d?.lastPrice ?? d?.price);
        if (Number.isFinite(p)) setPriceMap((prev) => ({ ...prev, [s]: p }));
      })
    );
    return () => unsubs.forEach((u) => u && u());
  }, [symbolsKey]);

  // Free wallet balance for the active account (for the footer "Balance").
  useEffect(() => {
    if (!account?._id) return undefined;
    let dead = false;
    const fetchFree = async () => {
      try {
        const { data } = await api.get('/wallet/balances', { params: { accountId: account._id } });
        if (dead) return;
        const w = (data.data || []).find((b) => b.currency === account.baseCurrency);
        setWalletFree(w?.free || '0');
      } catch (_) { /* keep prior */ }
    };
    fetchFree();
    const off = wsClient.subscribe('user:wallet', fetchFree);
    return () => { dead = true; off && off(); };
  }, [account?._id, account?.baseCurrency]);

  // Effective leverage (admin override → plan default → fallback) for new orders.
  useEffect(() => {
    let dead = false;
    const params = account?._id ? { accountId: account._id } : {};
    api.get('/user/leverage', { params })
      .then((r) => { if (!dead) setLeverage(r.data?.data || null); })
      .catch(() => {});
    return () => { dead = true; };
  }, [account?._id]);

  // ── Derived: live PnL rows, floating total, footer equity numbers ──
  const positionsLive = useMemo(
    () => (positions || []).map((p) => {
      const { mark, pnl } = livePnl(p, priceMap);
      return { ...p, markPrice: mark, unrealizedPnl: pnl };
    }),
    [positions, priceMap],
  );
  const floating = positionsLive.reduce((s, p) => s + Number(p.unrealizedPnl || 0), 0);

  const equityNums = useMemo(() => {
    if (!account) return null;
    const walletAvail = Number(walletFree || 0);
    const upnl = floating;
    const usedMargin = (positions || []).reduce((acc, p) => {
      const px = Number(p.entryPrice || 0) * Number(p.quantity || 0);
      const lev = Math.max(Number(p.leverage || 1), 1);
      return acc + px / lev;
    }, 0);
    const balance = walletAvail + usedMargin;
    const equity = balance + upnl;
    const free = equity - usedMargin;
    const marginLevel = usedMargin > 0 ? (equity / usedMargin) * 100 : null;
    return { equity, free, balance, used: usedMargin, marginLevel, base: cur };
  }, [account, walletFree, floating, positions, cur]);

  // ── Order-ticket maths (mirrors OrderTicketScreen / web OrderForm) ──
  const last = Number(ticker.last) || Number(instrument?.lastPrice) || 0;
  const qtyNum = Number(qty) || 0;
  const notional = last * qtyNum;
  const leverageNum = Math.max(1, Number(leverage?.effectiveLeverage) || Number(account?.leverage) || Number(instrument?.maxLeverage) || 100);
  const quote = instrument?.quoteCurrency || 'USD';
  const qsym = currencySymbol(quote);

  const fee = useMemo(() => {
    const plan = planForType(byCode, account?.accountType);
    const kind = String(plan?.feeKind || plan?.feeModel?.kind || '').toUpperCase();
    const val = Number(plan?.feeValue ?? plan?.feeModel?.value ?? 0);
    const group = feeGroupOf(kind);
    const rule = plan?.feeDisplay || '';
    const spreadAbs = instrument?.spreadType === 'PERCENTAGE'
      ? last * (Number(instrument?.spreadValue) || 0) / 100
      : Number(instrument?.spreadValue) || 0;
    const spreadCost = qtyNum > 0 ? spreadAbs * qtyNum : 0;
    let commission = 0, charges = 0, pending = false;
    if (group === 'Commission') commission = qtyNum > 0 ? notional * val : 0;
    else if (group === 'Charges') {
      if (kind === 'PCT_OF_PROFIT') pending = qtyNum > 0;
      else if (qtyNum > 0) charges = val;
    }
    const total = pending ? null : commission + charges + spreadCost;
    return { group, rule, commission, charges, spreadCost, pending, total };
  }, [byCode, account, notional, qtyNum, last, instrument]);

  // ── Actions ──
  const onRefresh = async () => { setRefreshing(true); await refresh(); setRefreshing(false); };

  const openSheet = (side) => {
    if (!symbol) return;
    setSheetSide(side);
    setMode('MARKET');
    setQty(instrument?.minOrderSize ? String(instrument.minOrderSize) : '');
    setLimitPrice('');
    setSheetSl('');
    setSheetTp('');
  };

  const submitOrder = async () => {
    if (!account) { Alert.alert('No account', 'Select a trading account first.'); return; }
    if (qtyNum <= 0) { Alert.alert('Volume', 'Enter a volume greater than 0.'); return; }
    if (mode === 'LIMIT' && !(Number(limitPrice) > 0)) { Alert.alert('Price', 'Enter a limit price.'); return; }
    setPlacing(true);
    try {
      const payload = {
        accountId: account._id,
        symbol: instrument.symbol,
        side: sheetSide,
        orderMode: mode,
        quantity: String(qtyNum),
        leverage: leverageNum,
        idempotencyKey: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      };
      if (mode === 'LIMIT') payload.price = String(limitPrice);
      if (Number(sheetSl) > 0) payload.stopLoss = String(sheetSl);
      if (Number(sheetTp) > 0) payload.takeProfit = String(sheetTp);
      const { data } = await api.post('/trading/orders', payload);
      setSheetSide(null);
      Alert.alert('Order placed', `${sheetSide} ${qtyNum} ${instrument.symbol} — ${data.data?.status ?? 'OK'}`);
      refresh();
    } catch (e) {
      Alert.alert('Order failed', errorMessage(e));
    } finally {
      setPlacing(false);
    }
  };

  const closePosition = (p) => {
    Alert.alert('Close position', `Close ${p.side} ${p.symbol}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Close', style: 'destructive', onPress: async () => {
          try { await api.post(`/trading/positions/${p._id}/close`); refresh(); }
          catch (e) { Alert.alert('Failed', errorMessage(e)); }
        },
      },
    ]);
  };

  const closeAll = () => {
    if (!positionsLive.length) return;
    Alert.alert('Close all positions', `Close ALL ${positionsLive.length} open position(s)?\n\nThis places market orders to exit every open position and cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Close All', style: 'destructive', onPress: async () => {
          try {
            const { data } = await api.post('/trading/positions/close-all', { accountId: account?._id });
            const d = data?.data || {};
            if (d.failed?.length) Alert.alert('Partly closed', `Closed ${d.closed}/${d.total} — ${d.failed.length} failed`);
            else Alert.alert('Done', `Closed ${d.closed ?? 0} position(s)`);
            refresh();
          } catch (e) { Alert.alert('Error', errorMessage(e)); }
        },
      },
    ]);
  };

  const cancelOrder = (o) => {
    Alert.alert('Cancel order', `Cancel ${o.side} ${o.symbol}?`, [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Cancel order', style: 'destructive', onPress: async () => {
          try { await api.delete(`/trading/orders/${o._id}`); refresh(); }
          catch (e) { Alert.alert('Failed', errorMessage(e)); }
        },
      },
    ]);
  };

  const openEdit = (p) => {
    setEditPos(p);
    setEditSl(p.stopLoss ? String(p.stopLoss) : '');
    setEditTp(p.takeProfit ? String(p.takeProfit) : '');
  };
  const saveEdit = async () => {
    setSaving(true);
    try {
      await api.put(`/trading/positions/${editPos._id}`, {
        stopLoss: editSl.trim() === '' ? null : Number(editSl),
        takeProfit: editTp.trim() === '' ? null : Number(editTp),
      });
      setEditPos(null);
      refresh();
    } catch (e) {
      Alert.alert('Failed', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const stripRows = useMemo(() => catalog.slice(0, 14), [catalog]);
  const pickerRows = useMemo(() => {
    const q = pickerQuery.trim().toUpperCase();
    const rows = q
      ? catalog.filter((r) => r.symbol?.toUpperCase().includes(q) || String(r.name || '').toUpperCase().includes(q))
      : catalog;
    return rows.slice(0, 80);
  }, [catalog, pickerQuery]);

  const counts = { Open: positionsLive.length, Pending: (openOrders || []).length, Closed: (closedTrades || []).length };
  const buy = sheetSide === 'BUY';

  // ── Bottom-panel body (single scroll container → mapped Card rows, no nested lists) ──
  let panelBody;
  if (tab === 'Open') {
    panelBody = positions == null ? <Loader />
      : positionsLive.length === 0 ? <Empty title="No open positions" sub="Your live positions will appear here." />
      : positionsLive.map((p) => (
        <PositionRow key={p._id} c={c} styles={styles} p={p} cur={cur} prec={precOf(catBySymbol[p.symbol])} onClose={closePosition} onEdit={openEdit} />
      ));
  } else if (tab === 'Pending') {
    panelBody = openOrders == null ? <Loader />
      : openOrders.length === 0 ? <Empty title="No pending orders" sub="Limit / stop orders waiting to fill show here." />
      : openOrders.map((o) => (
        <OrderRow key={o._id} c={c} styles={styles} o={o} prec={precOf(catBySymbol[o.symbol])} onCancel={cancelOrder} />
      ));
  } else {
    panelBody = closedTrades == null ? <Loader />
      : closedTrades.length === 0 ? <Empty title="No closed trades" sub="Your recent closed trades show here." />
      : closedTrades.map((t) => (
        <ClosedRow key={t._id} c={c} styles={styles} t={t} prec={precOf(catBySymbol[t.symbol])} />
      ));
  }

  return (
    <View style={styles.screen}>
      {/* 1 ── Account bar */}
      <View style={styles.accountBar}>
        <AccountSwitcher />
        <AccountSummary c={c} styles={styles} equityNums={equityNums} floating={floating} cur={cur} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 16 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary500} />}
      >
        {/* 2 ── Symbol header + strip */}
        <SymbolHeader c={c} styles={styles} instrument={instrument} symbol={symbol} last={ticker.last} changePct={ticker.changePct} onPick={() => setPickerOpen(true)} />
        <SymbolStrip c={c} styles={styles} rows={stripRows} active={symbol} onSelect={setSymbol} />

        {/* 3 ── Chart */}
        <View style={{ paddingHorizontal: 12, marginTop: 6 }}>
          {symbol ? <TradingViewChart symbol={symbol} height={260} /> : <View style={{ height: 300 }}><Loader label="Loading chart…" /></View>}
        </View>

        {/* 4 ── Buy / Sell action bar */}
        <Row style={styles.actionBar}>
          <TouchableOpacity activeOpacity={0.85} onPress={() => openSheet('SELL')} style={[styles.bigBtn, { backgroundColor: c.bear }]}>
            <Text style={styles.bigBtnLabel}>SELL</Text>
            <Text style={styles.bigBtnPrice}>{ticker.last != null ? `${qsym}${fmtNum(ticker.last, prec)}` : '—'}</Text>
          </TouchableOpacity>
          <TouchableOpacity activeOpacity={0.85} onPress={() => openSheet('BUY')} style={[styles.bigBtn, { backgroundColor: c.bull }]}>
            <Text style={styles.bigBtnLabel}>BUY</Text>
            <Text style={styles.bigBtnPrice}>{ticker.last != null ? `${qsym}${fmtNum(ticker.last, prec)}` : '—'}</Text>
          </TouchableOpacity>
        </Row>

        {/* 5 ── Open / Pending / Closed */}
        <PanelTabs c={c} styles={styles} tab={tab} setTab={setTab} counts={counts} onCloseAll={closeAll} canCloseAll={positionsLive.length > 0} />
        <View style={{ paddingHorizontal: 12, paddingTop: 12 }}>{panelBody}</View>
      </ScrollView>

      {/* 6 ── Equity footer (pinned) */}
      <EquityFooter c={c} styles={styles} equityNums={equityNums} />

      {/* ── Order bottom-sheet ── */}
      <Modal visible={!!sheetSide} transparent animationType="slide" onRequestClose={() => setSheetSide(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.sheetWrap}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setSheetSide(null)} />
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <Row style={{ justifyContent: 'space-between', marginBottom: 12 }}>
                <Text style={styles.sheetTitle}>{instrument?.symbol}</Text>
                <Text style={styles.sheetPrice}>{qsym}{fmtNum(last, prec)}</Text>
              </Row>

              {/* Side + Market/Limit */}
              <Row style={{ gap: 10 }}>
                <Seg styles={styles} active={!buy} onPress={() => setSheetSide('SELL')} label="SELL" tone={c.bear} />
                <Seg styles={styles} active={buy} onPress={() => setSheetSide('BUY')} label="BUY" tone={c.bull} />
              </Row>
              <Row style={{ gap: 10, marginTop: 10, marginBottom: 14 }}>
                <Seg styles={styles} active={mode === 'MARKET'} onPress={() => setMode('MARKET')} label="Market" tone={c.primary500} small />
                <Seg styles={styles} active={mode === 'LIMIT'} onPress={() => setMode('LIMIT')} label="Limit" tone={c.primary500} small />
              </Row>

              {/* Account picker */}
              <Text style={styles.lbl}>Trading account</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8, marginBottom: 14 }}>
                {accounts.map((a) => {
                  const on = a._id === account?._id;
                  return (
                    <TouchableOpacity key={a._id} onPress={() => select(a._id)} style={[styles.acct, on && { borderColor: c.primary500, backgroundColor: c.primarySoft }]}>
                      <Text style={[styles.acctName, on && { color: c.primary500 }]} numberOfLines={1}>{a.nickname || a.accountNumber}</Text>
                      <Text style={styles.acctNum}>{a.baseCurrency}{isDemo(a.accountType) ? ' · Demo' : ''} · {a.accountNumber}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              {/* Inputs */}
              <Field c={c} styles={styles} label="Volume (lots)" value={qty} onChangeText={setQty} placeholder="e.g. 0.10" />
              {mode === 'LIMIT' && <Field c={c} styles={styles} label="Limit price" value={limitPrice} onChangeText={setLimitPrice} placeholder={fmtNum(last, prec)} />}
              <Row style={{ gap: 12 }}>
                <View style={{ flex: 1 }}><Field c={c} styles={styles} label="Stop Loss" value={sheetSl} onChangeText={setSheetSl} placeholder="—" /></View>
                <View style={{ flex: 1 }}><Field c={c} styles={styles} label="Take Profit" value={sheetTp} onChangeText={setSheetTp} placeholder="—" /></View>
              </Row>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.metaLabel}>Notional</Text>
                <Text style={styles.metaValue}>{qsym}{fmtNum(notional, 2)}</Text>
              </Row>
              <Row style={{ justifyContent: 'space-between', marginTop: 4, marginBottom: 12 }}>
                <Text style={styles.metaLabel}>Leverage</Text>
                <Text style={styles.metaValue}>1:{leverageNum}</Text>
              </Row>

              {/* Fee breakdown */}
              <View style={styles.feeCard}>
                <Text style={styles.feeTitle}>Estimated fee</Text>
                <FeeRow styles={styles} label="Commission" rule={fee.group === 'Commission' ? fee.rule : '—'} value={`${qsym}${fmtNum(fee.commission, 2)}`} />
                <FeeRow styles={styles} label="Charges" rule={fee.group === 'Charges' ? fee.rule : '—'} value={fee.pending ? 'Pending' : `${qsym}${fmtNum(fee.charges, 2)}`} />
                <FeeRow styles={styles} label="Spread Cost" rule="(ask − bid) × qty" value={`${qsym}${fmtNum(fee.spreadCost, 2)}`} />
                <View style={styles.hr} />
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.totalLbl}>Total ≈</Text>
                  <Text style={styles.totalVal}>{fee.pending ? 'Pending' : `${qsym}${fmtNum(fee.total, 2)}`}</Text>
                </Row>
              </View>

              <Button
                title={`${buy ? 'Buy' : 'Sell'} ${instrument?.symbol || ''}`}
                onPress={submitOrder}
                loading={placing}
                style={{ backgroundColor: buy ? c.bull : c.bear, marginTop: 14 }}
              />
              <Button title="Cancel" variant="ghost" style={{ marginTop: 10 }} onPress={() => setSheetSide(null)} />
              <View style={{ height: 12 }} />
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── SL / TP modify (open position) ── */}
      <Modal visible={!!editPos} transparent animationType="fade" onRequestClose={() => setEditPos(null)}>
        <View style={styles.backdrop}>
          <Card style={{ width: '88%' }}>
            <Text style={styles.modalTitle}>SL / TP · {editPos?.symbol}</Text>
            <Text style={styles.mlbl}>Stop Loss</Text>
            <TextInput value={editSl} onChangeText={setEditSl} keyboardType="decimal-pad" placeholder="—" placeholderTextColor={c.textMuted} style={styles.minput} />
            <Text style={styles.mlbl}>Take Profit</Text>
            <TextInput value={editTp} onChangeText={setEditTp} keyboardType="decimal-pad" placeholder="—" placeholderTextColor={c.textMuted} style={styles.minput} />
            <Row style={{ gap: 10, marginTop: 16 }}>
              <Button title="Cancel" variant="ghost" style={{ flex: 1 }} onPress={() => setEditPos(null)} />
              <Button title="Save" style={{ flex: 1 }} loading={saving} onPress={saveEdit} />
            </Row>
          </Card>
        </View>
      </Modal>

      {/* ── Symbol picker ── */}
      <Modal visible={pickerOpen} transparent animationType="slide" onRequestClose={() => setPickerOpen(false)}>
        <View style={styles.sheetWrap}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setPickerOpen(false)} />
          <View style={[styles.sheet, { maxHeight: '80%' }]}>
            <View style={styles.sheetHandle} />
            <Row style={{ justifyContent: 'space-between', marginBottom: 10 }}>
              <Text style={styles.sheetTitle}>Select instrument</Text>
              <TouchableOpacity onPress={() => setPickerOpen(false)}><Ionicons name="close" size={22} color={c.textSecondary} /></TouchableOpacity>
            </Row>
            <TextInput
              value={pickerQuery}
              onChangeText={setPickerQuery}
              placeholder="Search symbol or name"
              placeholderTextColor={c.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
              style={styles.searchInput}
            />
            <ScrollView keyboardShouldPersistTaps="handled" style={{ marginTop: 10 }}>
              {pickerRows.length === 0 ? <Empty title="No matches" /> : pickerRows.map((r) => {
                const on = r.symbol === symbol;
                const up = Number(r.change24h) >= 0;
                return (
                  <TouchableOpacity
                    key={r.symbol}
                    onPress={() => { setSymbol(r.symbol); setPickerOpen(false); setPickerQuery(''); }}
                    style={[styles.pickerRow, on && { backgroundColor: c.primarySoft, borderColor: c.primary500 }]}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.pickerSym} numberOfLines={1}>{r.symbol}</Text>
                      {r.name ? <Text style={styles.pickerName} numberOfLines={1}>{r.name}</Text> : null}
                    </View>
                    {r.lastPrice != null ? <Text style={styles.pickerPrice}>{fmtNum(r.lastPrice, precOf(r))}</Text> : null}
                    {Number.isFinite(Number(r.change24h)) ? (
                      <Text style={{ fontSize: 12, fontWeight: '700', color: up ? c.bull : c.bear, marginLeft: 10, width: 62, textAlign: 'right' }}>
                        {up ? '+' : ''}{fmtNum(r.change24h, 2)}%
                      </Text>
                    ) : null}
                  </TouchableOpacity>
                );
              })}
              <View style={{ height: 16 }} />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (c) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },

  // Account bar
  accountBar: { borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.card },
  sumStrip: { paddingHorizontal: 16, paddingBottom: 10, gap: 12 },
  sumLabel: { fontSize: 11, color: c.textMuted, fontWeight: '600' },
  sumValue: { fontSize: 16, fontWeight: '900', color: c.textPrimary, marginTop: 2, fontVariant: ['tabular-nums'] },

  // Symbol header
  symHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6, gap: 12 },
  symName: { fontSize: 20, fontWeight: '900', color: c.textPrimary },
  symSub: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  symPrice: { fontSize: 20, fontWeight: '900', color: c.textPrimary, fontVariant: ['tabular-nums'] },
  symChange: { fontSize: 12, fontWeight: '800', marginTop: 2, fontVariant: ['tabular-nums'] },
  symChangeMuted: { fontSize: 11, color: c.textMuted, marginTop: 2 },

  // Symbol strip
  stripRow: { gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  stripChip: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: c.card, alignItems: 'center', gap: 1 },
  stripChipOn: { borderColor: c.primary500, backgroundColor: c.primarySoft },
  stripSym: { fontSize: 13, fontWeight: '800', color: c.textSecondary },

  // Buy / Sell bar
  actionBar: { paddingHorizontal: 12, marginTop: 12, gap: 12 },
  bigBtn: { flex: 1, height: 58, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  bigBtnLabel: { color: c.white, fontSize: 18, fontWeight: '900', letterSpacing: 0.5 },
  bigBtnPrice: { color: 'rgba(255,255,255,0.9)', fontSize: 12, fontWeight: '700', marginTop: 2, fontVariant: ['tabular-nums'] },

  // Panel tabs
  panelHead: { paddingHorizontal: 12, paddingTop: 16, justifyContent: 'space-between' },
  panelTab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.pill },
  panelTabOn: { backgroundColor: c.primarySoft },
  panelTabTxt: { fontSize: 14, fontWeight: '700', color: c.textMuted },
  countBadge: { minWidth: 20, height: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: c.hover, alignItems: 'center', justifyContent: 'center' },
  countTxt: { fontSize: 11, fontWeight: '800', color: c.textMuted },
  closeAllBtn: { borderWidth: 1, borderColor: c.bear, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 7 },
  closeAllTxt: { color: c.bear, fontWeight: '800', fontSize: 12 },

  // Rows (positions / orders / closed)
  rowSym: { fontSize: 15, fontWeight: '800', color: c.textPrimary },
  rowPnl: { fontSize: 16, fontWeight: '900', fontVariant: ['tabular-nums'] },
  metaLabel: { fontSize: 11, color: c.textMuted },
  metaValue: { fontSize: 14, color: c.textPrimary, fontWeight: '600', marginTop: 2, fontVariant: ['tabular-nums'] },
  slTag: { fontSize: 12, fontWeight: '700', color: c.bear },
  tpTag: { fontSize: 12, fontWeight: '700', color: c.bull },
  editBtn: { flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingVertical: 10, alignItems: 'center' },
  editTxt: { color: c.textSecondary, fontWeight: '800', fontSize: 14 },
  closeBtn: { flex: 1, borderWidth: 1, borderColor: c.bear, borderRadius: radius.md, paddingVertical: 10, alignItems: 'center' },
  closeTxt: { color: c.bear, fontWeight: '800', fontSize: 14 },
  cancelBtn: { borderWidth: 1, borderColor: c.bear, borderRadius: radius.md, paddingHorizontal: 16, paddingVertical: 8 },
  cancelTxt: { color: c.bear, fontWeight: '800', fontSize: 13 },

  // Equity footer
  footerBar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, gap: 6, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.card },
  footerStat: { flexGrow: 1, flexBasis: '18%', minWidth: 64 },
  footerLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 0.4, color: c.textMuted, textTransform: 'uppercase' },
  footerValue: { fontSize: 13, fontWeight: '800', color: c.textPrimary, marginTop: 1, fontVariant: ['tabular-nums'] },

  // Order sheet / picker
  sheetWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.bg, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, borderWidth: 1, borderColor: c.border, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16, maxHeight: '90%' },
  sheetHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: c.border, marginBottom: 12 },
  sheetTitle: { fontSize: 18, fontWeight: '900', color: c.textPrimary },
  sheetPrice: { fontSize: 18, fontWeight: '800', color: c.textPrimary, fontVariant: ['tabular-nums'] },

  seg: { flex: 1, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  segTxt: { fontSize: 15, fontWeight: '800', color: c.textSecondary },
  lbl: { fontSize: 13, fontWeight: '700', color: c.textSecondary },
  input: { height: 48, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 16, color: c.textPrimary, backgroundColor: c.card, marginTop: 6 },
  acct: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8, marginRight: 8, maxWidth: 180 },
  acctName: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
  acctNum: { fontSize: 11, color: c.textMuted, marginTop: 2 },

  feeCard: { borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: 14, backgroundColor: c.card },
  feeTitle: { fontSize: 13, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase', marginBottom: 10, letterSpacing: 0.5 },
  hr: { height: 1, backgroundColor: c.borderSubtle, marginVertical: 8 },
  totalLbl: { fontSize: 15, fontWeight: '800', color: c.textPrimary },
  totalVal: { fontSize: 16, fontWeight: '900', color: c.textPrimary, fontVariant: ['tabular-nums'] },

  // SL/TP modal
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalTitle: { fontSize: 16, fontWeight: '800', color: c.textPrimary, marginBottom: 12 },
  mlbl: { fontSize: 13, fontWeight: '700', color: c.textSecondary, marginBottom: 6, marginTop: 6 },
  minput: { height: 46, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, fontSize: 15, color: c.textPrimary, backgroundColor: c.card },

  // Picker rows
  searchInput: { height: 46, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 15, color: c.textPrimary, backgroundColor: c.card },
  pickerRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: c.borderSubtle, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 8 },
  pickerSym: { fontSize: 15, fontWeight: '800', color: c.textPrimary },
  pickerName: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  pickerPrice: { fontSize: 14, fontWeight: '700', color: c.textSecondary, fontVariant: ['tabular-nums'] },
});
