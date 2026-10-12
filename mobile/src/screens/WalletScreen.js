import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl, TextInput,
  TouchableOpacity, Alert, Image, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Polyline, Polygon } from 'react-native-svg';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { pickImageBase64 } from '../services/imagePicker';
import { useAccounts } from '../store/account';
import { useAuth } from '../store/auth';
import { useColors, radius, fmtNum, currencySymbol } from '../theme';
import { Card, Button, Row, Loader, Empty } from '../components/ui';

/**
 * WalletScreen — native port of the web client's Wallet hub
 * (client/src/pages/Wallet.jsx). Mirrors it section-for-section: the web's
 * left sidebar collapses to a top horizontal menu that switches between
 * Account Overview · Account Details · Deposit · Withdraw · Internal Transfer ·
 * Transaction History, plus links to the Main Wallet (Plans) and an inline
 * Bonus Wallet view. A persistent Recent Transactions strip sits at the bottom
 * on every view except Overview (which carries its own).
 *
 * Same backend endpoints as the web (real data only). Razorpay's browser SDK
 * isn't available in RN, so the deposit flow is the manual method + amount +
 * proof-upload path, posting to the same /wallet/deposits endpoint.
 */

const REAL = (t) => String(t || '').toUpperCase() !== 'DEMO' && String(t || '').toUpperCase() !== 'VIRTUAL';
const isDemoType = (t) => ['DEMO', 'VIRTUAL'].includes(String(t || '').toUpperCase());
const TIER_MAP = {
  REAL: 'Real', DEMO: 'Demo', VIRTUAL: 'Virtual', STANDARD: 'Standard', STANDARD_IC: 'Standard IC',
  PRO: 'Pro', PRO_IC: 'Pro IC', FREE: 'Free', FREE_IC: 'Free IC', ECN: 'ECN', RAW: 'Raw',
};
const tierLabel = (a) => {
  const t = String(a?.accountType || '').toUpperCase();
  // Demo accounts keep their chosen tier in `tierCode` (accountType is 'DEMO').
  if (isDemoType(t) && a?.tierCode) return TIER_MAP[String(a.tierCode).toUpperCase()] || 'Demo';
  return TIER_MAP[t] || a?.accountType || '—';
};

const MENU = [
  { id: 'overview', label: 'Overview', icon: 'pie-chart-outline' },
  { id: 'details', label: 'Account', icon: 'person-outline' },
  { id: 'grow', label: 'Deposit', icon: 'add-circle-outline' },
  { id: 'withdraw', label: 'Withdraw', icon: 'arrow-up-circle-outline' },
  { id: 'transfer', label: 'Transfer', icon: 'swap-horizontal-outline' },
  { id: 'history', label: 'History', icon: 'time-outline' },
  { id: 'subscription', label: 'Main Wallet', icon: 'wallet-outline', nav: 'Plans' },
  { id: 'bonus', label: 'Bonus Wallet', icon: 'gift-outline' },
];

export default function WalletScreen({ navigation }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const { user } = useAuth();
  const { accounts } = useAccounts();

  const [view, setView] = useState('overview');
  const [balances, setBalances] = useState([]);
  const [deposits, setDeposits] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [positions, setPositions] = useState([]);
  const [priceMap, setPriceMap] = useState({});
  const [fxRate, setFxRate] = useState(83);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [b, d, w, l, p, fx] = await Promise.allSettled([
      api.get('/wallet/balances'),
      api.get('/wallet/deposits'),
      api.get('/wallet/withdrawals'),
      api.get('/wallet/ledger', { params: { limit: 100 } }),
      api.get('/trading/positions'),
      api.get('/fx/usdinr', { timeout: 8000 }),
    ]);
    if (b.status === 'fulfilled') setBalances(b.value.data?.data || []);
    if (d.status === 'fulfilled') setDeposits(d.value.data?.data || []);
    if (w.status === 'fulfilled') setWithdrawals(w.value.data?.data || []);
    if (l.status === 'fulfilled') setLedger(l.value.data?.data || []);
    if (p.status === 'fulfilled') {
      const pos = p.value.data?.data || [];
      setPositions(pos);
      const seed = {};
      for (const x of pos) if (x.markPrice) seed[x.symbol] = x.markPrice;
      setPriceMap((prev) => ({ ...seed, ...prev }));
    }
    if (fx.status === 'fulfilled') {
      const r = Number(fx.value.data?.rate);
      if (Number.isFinite(r) && r > 0) setFxRate(r);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh on wallet / positions server events (mirrors the web).
  useEffect(() => {
    const a = wsClient.subscribe('user:wallet', () => load());
    const b = wsClient.subscribe('user:positions', () => load());
    return () => { a && a(); b && b(); };
  }, [load]);

  // Live mark-to-market so unrealized P&L in the equity figures moves.
  useEffect(() => {
    if (!positions.length) return;
    const symbols = [...new Set(positions.map((p) => p.symbol))];
    const unsubs = symbols.map((sym) =>
      wsClient.subscribe(`ticker:${sym}`, (data) =>
        setPriceMap((prev) => ({ ...prev, [sym]: data.lastPrice }))
      )
    );
    return () => unsubs.forEach((u) => u && u());
  }, [positions]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;

  const accountTypeById = useMemo(() => {
    const m = new Map();
    for (const a of accounts) m.set(String(a._id), a.accountType);
    return m;
  }, [accounts]);
  // Use the REAL() helper above (not DEMO / not VIRTUAL) rather than testing
  // for the literal 'REAL', which is a legacy account type — live accounts are
  // STANDARD / PRO / FREE tiers, so the old test matched none of them and
  // zeroed every real-money figure on this screen. An unknown accountId counts
  // as neither, so a half-loaded screen under-reports rather than inventing money.
  const isReal = useCallback((b) => {
    const t = accountTypeById.get(String(b.accountId));
    return t !== undefined && REAL(t);
  }, [accountTypeById]);

  const unrealizedByAccCur = useMemo(() => {
    const out = new Map();
    for (const p of positions) {
      const mark = Number(priceMap[p.symbol] || p.markPrice || p.entryPrice);
      const entry = Number(p.entryPrice);
      const qty = Number(p.quantity);
      const pnl = p.side === 'BUY' ? (mark - entry) * qty : (entry - mark) * qty;
      const acc = accounts.find((a) => String(a._id) === String(p.accountId));
      const cur = acc?.baseCurrency || 'USD';
      const key = `${p.accountId}|${cur}`;
      out.set(key, (out.get(key) || 0) + pnl);
    }
    return out;
  }, [positions, priceMap, accounts]);

  const realTotalsByCurrency = useMemo(() => {
    const out = {};
    for (const b of balances) {
      if (!isReal(b)) continue;
      const cur = b.currency || 'USD';
      if (!out[cur]) out[cur] = { balance: 0, locked: 0, free: 0, unrealized: 0 };
      out[cur].balance += Number(b.balance || 0);
      out[cur].locked += Number(b.locked || 0);
      out[cur].free += Number(b.free || 0);
      out[cur].unrealized += unrealizedByAccCur.get(`${b.accountId}|${cur}`) || 0;
    }
    return out;
  }, [balances, isReal, unrealizedByAccCur]);

  const totals = useMemo(() => {
    let balance = 0, locked = 0, free = 0, unrealized = 0;
    for (const [cur, t] of Object.entries(realTotalsByCurrency)) {
      const k = cur === 'USD' ? 1 : cur === 'INR' ? 1 / rate : 1;
      balance += (Number(t.balance) || 0) * k;
      locked += (Number(t.locked) || 0) * k;
      free += (Number(t.free) || 0) * k;
      unrealized += (Number(t.unrealized) || 0) * k;
    }
    const equity = balance + unrealized;
    const marginLevel = locked > 0 ? (equity / locked) * 100 : null;
    return { balance, locked, free, unrealized, equity, marginLevel, cur: 'USD' };
  }, [realTotalsByCurrency, rate]);

  const recentTx = useMemo(() => {
    const d = (deposits || []).map((x) => ({ ...x, _kind: 'deposit' }));
    const w = (withdrawals || []).map((x) => ({ ...x, _kind: 'withdraw' }));
    return [...d, ...w]
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, 12);
  }, [deposits, withdrawals]);

  const usd = (v) => `${currencySymbol('INR')}${fmtNum((Number(v) || 0) * rate, 2)}`;
  const usdSub = (v) => `≈ $${fmtNum(Number(v) || 0, 2)} USD`;

  const onMenu = (item) => {
    if (item.nav) { navigation.navigate(item.nav); return; }
    setView(item.id);
  };

  if (loading) return <Loader label="Loading wallet…" />;

  const common = { styles, c, navigation, accounts, balances, deposits, withdrawals, ledger, positions, priceMap, fxRate: rate, totals, usd, usdSub, setView, reload: load };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.bg }}
      contentContainerStyle={{ padding: 14, gap: 14, paddingBottom: 40 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary500} />}
    >
      <MenuBar styles={styles} c={c} view={view} onSelect={onMenu} />

      {view === 'overview' ? <OverviewView {...common} />
        : view === 'details' ? <DetailsView {...common} user={user} />
        : view === 'grow' ? <DepositView {...common} />
        : view === 'withdraw' ? <WithdrawView {...common} />
        : view === 'transfer' ? <TransferView {...common} />
        : view === 'history' ? <HistoryView {...common} />
        : view === 'bonus' ? <BonusView {...common} />
        : <OverviewView {...common} />}

      {view !== 'overview' && (
        <RecentTransactions styles={styles} c={c} rows={recentTx} fxRate={rate} showViewAll={view !== 'history'} onViewAll={() => setView('history')} />
      )}
    </ScrollView>
  );
}

/* ─────────────────────────── Top menu ─────────────────────────── */
function MenuBar({ styles, c, view, onSelect }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 2 }}>
      {MENU.map((m) => {
        const active = view === m.id;
        return (
          <TouchableOpacity
            key={m.id}
            onPress={() => onSelect(m)}
            style={[styles.menuPill, active && { backgroundColor: c.primarySoft, borderColor: c.primary500 }]}
          >
            <Ionicons name={m.icon} size={15} color={active ? c.primary500 : c.textMuted} />
            <Text style={[styles.menuText, active && { color: c.primary500, fontWeight: '800' }]}>{m.label}</Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

/* ─────────────────────── Shared small pieces ──────────────────── */
function SectionTitle({ styles, children, right }) {
  return (
    <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
      <Text style={styles.h2}>{children}</Text>
      {right}
    </Row>
  );
}

function StatusPill({ styles, c, status }) {
  const s = String(status || '').toUpperCase();
  const map = {
    COMPLETED: c.bull, CONFIRMED: c.bull, APPROVED: c.bull,
    PROCESSING: c.primary400, PENDING: c.warn, REJECTED: c.bear, CANCELLED: c.textMuted,
  };
  const tint = map[s] || c.textMuted;
  const label = s === 'CONFIRMED' ? 'Success' : (s ? s.charAt(0) + s.slice(1).toLowerCase() : '—');
  return (
    <View style={{ backgroundColor: tint + '22', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, alignSelf: 'flex-start' }}>
      <Text style={{ color: tint, fontSize: 10, fontWeight: '800', letterSpacing: 0.3 }}>{label}</Text>
    </View>
  );
}

function TxItem({ styles, c, tx, fxRate }) {
  const dep = tx._kind === 'deposit';
  const amt = Number(tx.amount || 0);
  return (
    <Row style={{ justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderSubtle }}>
      <Row style={{ gap: 10, flex: 1 }}>
        <View style={[styles.txIcon, { backgroundColor: (dep ? c.bull : c.bear) + '22' }]}>
          <Ionicons name={dep ? 'arrow-down' : 'arrow-up'} size={15} color={dep ? c.bull : c.bear} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.txTitle}>{dep ? 'Deposit' : 'Withdrawal'}{tx.method ? ` · ${tx.method}` : ''}</Text>
          <Text style={styles.txSub}>{fmtDateTime(tx.createdAt)}</Text>
        </View>
      </Row>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <Text style={[styles.txAmt, { color: dep ? c.bull : c.bear }]}>
          {dep ? '+' : '-'}{currencySymbol(tx.currency || 'USD')}{fmtNum(amt, 2)}
        </Text>
        <StatusPill styles={styles} c={c} status={tx.status} />
      </View>
    </Row>
  );
}

function RecentTransactions({ styles, c, rows, fxRate, showViewAll, onViewAll }) {
  return (
    <Card style={{ padding: 0 }}>
      <Row style={{ justifyContent: 'space-between', padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderSubtle }}>
        <Text style={styles.h3}>Recent Transactions</Text>
        {showViewAll ? (
          <TouchableOpacity onPress={onViewAll}><Text style={styles.link}>View All</Text></TouchableOpacity>
        ) : null}
      </Row>
      {rows.length === 0 ? (
        <Text style={styles.emptyRow}>No transactions yet</Text>
      ) : (
        <View style={{ paddingHorizontal: 14, paddingBottom: 4 }}>
          {rows.map((t) => <TxItem key={(t._id || t.id) + t._kind} styles={styles} c={c} tx={t} fxRate={fxRate} />)}
        </View>
      )}
    </Card>
  );
}

/* Multi-step header (stepper) */
function Stepper({ styles, c, steps, step }) {
  return (
    <Row style={{ gap: 6, marginBottom: 4 }}>
      {steps.map((s, i) => {
        const active = i === step, done = i < step;
        return (
          <View key={s.id} style={{ flex: 1, alignItems: 'center' }}>
            <View style={[styles.stepDot, active ? { backgroundColor: c.primary400 } : done ? { backgroundColor: c.primary400 + '33' } : { backgroundColor: c.hover }]}>
              {done ? <Ionicons name="checkmark" size={14} color={c.primary400} />
                : <Text style={[styles.stepNum, active && { color: '#fff' }]}>{i + 1}</Text>}
            </View>
            <Text style={[styles.stepLabel, (active || done) && { color: c.textPrimary }]} numberOfLines={1}>{s.label}</Text>
          </View>
        );
      })}
    </Row>
  );
}

function AccountCards({ styles, c, accounts, balances, fxRate, selectedId, onSelect, availableLabel }) {
  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
  return (
    <View style={{ gap: 10 }}>
      {accounts.map((a) => {
        const sel = a._id === selectedId;
        const accCcy = a.baseCurrency || 'USD';
        const real = REAL(a.accountType);
        let bal = 0;
        for (const b of balances) {
          if (b.accountId !== a._id) continue;
          const v = availableLabel ? Number(b.free || 0) : Number(b.balance || 0);
          if (b.currency === accCcy) bal += v;
          else if (b.currency === 'USD' && accCcy === 'INR') bal += v * rate;
          else if (b.currency === 'INR' && accCcy === 'USD') bal += v / rate;
          else bal += v;
        }
        return (
          <TouchableOpacity key={a._id} onPress={() => onSelect(a._id)} style={[styles.acctCard, sel && { borderColor: c.primary400, backgroundColor: c.primarySoft }]}>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={styles.avatar}><Text style={styles.avatarTxt}>{(a.nickname || a.accountNumber || 'A').slice(0, 2).toUpperCase()}</Text></View>
              <View style={[styles.radio, sel && { borderColor: c.primary400, backgroundColor: c.primary400 }]}>
                {sel && <Ionicons name="checkmark" size={12} color="#fff" />}
              </View>
            </Row>
            <Row style={{ gap: 6, marginTop: 8, alignItems: 'center' }}>
              <Text style={styles.acctName} numberOfLines={1}>{a.nickname || a.accountNumber}</Text>
              <View style={[styles.badge, { backgroundColor: (real ? c.primary400 : c.info) + '22' }]}>
                <Text style={[styles.badgeTxt, { color: real ? c.primary400 : c.info }]}>{real ? 'Live · Real' : 'Demo'}</Text>
              </View>
            </Row>
            <Text style={styles.acctNum}>{a.accountNumber}</Text>
            <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 10 }}>
              <View>
                <Text style={styles.acctBal}>{currencySymbol(accCcy)}{fmtNum(bal, 2)}</Text>
                <Text style={styles.acctSub}>{availableLabel ? 'Available' : 'Balance'}</Text>
              </View>
              <View style={styles.ccyChip}><Text style={styles.ccyChipTxt}>{accCcy}</Text></View>
            </Row>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function Field({ styles, c, label, value, onChangeText, placeholder, keyboardType, autoCapitalize, maxLength }) {
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={styles.fieldLbl}>{label}</Text>
      <TextInput
        value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={c.textMuted}
        keyboardType={keyboardType} autoCapitalize={autoCapitalize || 'none'} maxLength={maxLength}
        style={styles.input}
      />
    </View>
  );
}

function BottomBar({ styles, c, onBack, backLabel, onNext, nextLabel, nextDisabled, loading }) {
  return (
    <Row style={{ gap: 10, marginTop: 14 }}>
      <TouchableOpacity onPress={onBack} style={styles.ghostBtn}><Text style={styles.ghostBtnTxt}>{backLabel}</Text></TouchableOpacity>
      <TouchableOpacity onPress={onNext} disabled={nextDisabled || loading} style={[styles.primaryBtn, (nextDisabled || loading) && { opacity: 0.5 }]}>
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnTxt}>{nextLabel}</Text>}
      </TouchableOpacity>
    </Row>
  );
}

/* ─────────────────────────── Overview ─────────────────────────── */
function OverviewView({ styles, c, navigation, accounts, balances, deposits, withdrawals, positions, priceMap, fxRate, totals, usd, usdSub, setView }) {
  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
  // USD is what these wallets hold; the rupee line below is the conversion.
  const money = (n) => `$${fmtNum(Number(n) || 0, 2)}`;
  // The secondary line is the rupee conversion now that USD is primary.
  const altStr = (usdVal) => `≈ ₹${fmtNum((Number(usdVal) || 0) * rate, 2)} INR`;
  // Normalise INTO USD — this ran the other way and summed everything as rupees.
  const toUsd = (amount, currency) => { const n = Number(amount) || 0; return currency === 'INR' && rate > 0 ? n / rate : n; };

  const [mainWallet, setMainWallet] = useState(null);
  const [refWallet, setRefWallet] = useState(null);
  const [partner, setPartner] = useState(null);
  const [dash, setDash] = useState(null);
  const [closed, setClosed] = useState({ items: [], summary: null });
  const [series, setSeries] = useState([]);
  const [perfRange, setPerfRange] = useState('1m');
  const [rangeStats, setRangeStats] = useState({ week: null, month: null, year: null });

  useEffect(() => {
    let dead = false;
    const grab = (p) => p.then((r) => r.data?.data).catch(() => null);
    (async () => {
      const [mw, rw, pt, db, cl, wk, mo, yr] = await Promise.all([
        grab(api.get('/subscription-wallet')),
        grab(api.get('/bonus-wallet')),
        grab(api.get('/partner/volume-dashboard')),
        grab(api.get('/user/dashboard')),
        grab(api.get('/trading/positions/history', { params: { limit: 6 } })),
        grab(api.get('/user/dashboard/lifetime-stats', { params: { days: 7 } })),
        grab(api.get('/user/dashboard/lifetime-stats', { params: { days: 30 } })),
        grab(api.get('/user/dashboard/lifetime-stats', { params: { days: 365 } })),
      ]);
      if (dead) return;
      setMainWallet(mw); setRefWallet(rw); setPartner(pt); setDash(db);
      if (cl) setClosed({ items: cl.items || [], summary: cl.summary || null });
      setRangeStats({ week: wk, month: mo, year: yr });
    })();
    return () => { dead = true; };
  }, []);

  useEffect(() => {
    let dead = false;
    api.get('/user/dashboard/monthly-series', { params: { range: perfRange } })
      .then((r) => { if (!dead) setSeries(r.data?.data?.buckets || []); })
      .catch(() => { if (!dead) setSeries([]); });
    return () => { dead = true; };
  }, [perfRange]);

  const mainUsd = toUsd(mainWallet?.balance, mainWallet?.currency);
  const refUsd = toUsd(refWallet?.balance, refWallet?.currency);
  const tradingUsd = Number(totals.equity) || 0;   // already USD-normalised
  const totalUsd = mainUsd + refUsd + tradingUsd;

  const isSettled = (s) => ['CONFIRMED', 'COMPLETED', 'APPROVED'].includes(String(s).toUpperCase());
  const isPending = (s) => ['PENDING', 'PROCESSING'].includes(String(s).toUpperCase());
  const totalDeposits = deposits.filter((d) => isSettled(d.status)).reduce((s, d) => s + toUsd(d.amount, d.currency), 0);
  const totalWithdrawals = withdrawals.filter((w) => isSettled(w.status)).reduce((s, w) => s + toUsd(w.amount, w.currency), 0);
  const pendingWithdrawals = withdrawals.filter((w) => isPending(w.status)).reduce((s, w) => s + toUsd(w.amount, w.currency), 0);

  const unrealByAcc = useMemo(() => {
    const m = new Map();
    for (const p of positions) {
      const mark = Number(priceMap[p.symbol] || p.markPrice || p.entryPrice);
      const entry = Number(p.entryPrice);
      const qty = Number(p.quantity);
      const pnl = p.side === 'BUY' ? (mark - entry) * qty : (entry - mark) * qty;
      const acc = accounts.find((a) => String(a._id) === String(p.accountId));
      const cur = acc?.baseCurrency || 'USD';
      m.set(String(p.accountId), (m.get(String(p.accountId)) || 0) + toUsd(pnl, cur));
    }
    return m;
  }, [positions, priceMap, accounts, rate]);

  const realAccounts = accounts.filter((a) => REAL(a.accountType));
  const accountRows = realAccounts.map((a) => {
    const bals = balances.filter((b) => String(b.accountId) === String(a._id));
    const balanceInr = bals.reduce((s, b) => s + toUsd(b.balance, b.currency), 0);
    const pnl = unrealByAcc.get(String(a._id)) || 0;
    const equity = balanceInr + pnl;
    const pct = balanceInr > 0 ? (pnl / balanceInr) * 100 : 0;
    return { a, balanceInr, equity, pnl, pct };
  });

  const openCount = positions.length;
  const posPnl = (p) => {
    const mark = Number(priceMap[p.symbol] || p.markPrice || p.entryPrice);
    const entry = Number(p.entryPrice);
    return p.side === 'BUY' ? mark - entry : entry - mark;
  };
  const winningOpen = positions.filter((p) => posPnl(p) >= 0).length;
  const losingOpen = openCount - winningOpen;
  const winRate = dash?.pnl?.winRate ?? (closed.summary && (closed.summary.wins + closed.summary.losses) > 0
    ? (closed.summary.wins / (closed.summary.wins + closed.summary.losses)) * 100 : null);
  const totalTrades = closed.summary?.totalTrades ?? dash?.trades?.totalLive ?? 0;
  const wins = closed.summary?.wins ?? 0;
  const losses = closed.summary?.losses ?? 0;

  const rangeNet = (s) => (s ? Number(s.netProfit || 0) : 0);
  const perfNet = series.reduce((s, b) => s + Number(b.netProfit || 0), 0);
  const perfBase = Number(totals.equity) || 0;
  const perfPct = perfBase > 0 ? (perfNet / perfBase) * 100 : 0;

  const recent = useMemo(() => {
    const d = deposits.map((x) => ({ ...x, _kind: 'deposit' }));
    const w = withdrawals.map((x) => ({ ...x, _kind: 'withdraw' }));
    return [...d, ...w].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }, [deposits, withdrawals]);

  const RANGES = [{ k: '1w', label: 'This Week' }, { k: '1m', label: 'This Month' }, { k: '1y', label: 'This Year' }];

  return (
    <View style={{ gap: 14 }}>
      {/* Header + quick actions */}
      <View>
        <Text style={styles.h1}>Account Overview</Text>
        <Text style={styles.pSub}>Manage your funds, view balance and wallet history</Text>
      </View>
      <Row style={{ gap: 8 }}>
        <QuickAction styles={styles} c={c} icon="add" label="Deposit" primary onPress={() => setView('grow')} />
        <QuickAction styles={styles} c={c} icon="arrow-up" label="Withdraw" onPress={() => setView('withdraw')} />
        <QuickAction styles={styles} c={c} icon="swap-horizontal" label="Transfer" onPress={() => setView('transfer')} />
      </Row>

      {/* Total Wallet Balance */}
      <Card>
        <Text style={styles.kicker}>Total Wallet Balance</Text>
        <Text style={styles.bigMoney}>{money(totalUsd)}</Text>
        <Text style={styles.moneySub}>{altStr(totalUsd)}</Text>
        <Text style={styles.tiny}>All wallets + trading account equity</Text>
        <View style={{ height: 12 }} />
        <BreakPart styles={styles} c={c} tint={c.primary500} icon="wallet-outline" label="Main Wallet" value={money(mainUsd)} sub={altStr(mainUsd)} />
        <BreakPart styles={styles} c={c} tint="#8B5CF6" icon="gift-outline" label="Referral Wallet" value={money(refUsd)} sub={altStr(refUsd)} />
        <BreakPart styles={styles} c={c} tint={c.bull} icon="trending-up-outline" label="Trading Accounts (Equity)" value={money(tradingUsd)} sub={altStr(tradingUsd)} last />
      </Card>

      {/* Main Wallet + Referral cards */}
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <View style={{ padding: 16 }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={[styles.tag, { backgroundColor: c.primary500 + '22' }]}><Text style={[styles.tagTxt, { color: c.primary500 }]}>Deposit & Withdraw</Text></View>
            <TouchableOpacity onPress={() => navigation.navigate('Plans')}><Text style={styles.link}>Main Wallet ›</Text></TouchableOpacity>
          </Row>
          <Row style={{ gap: 12, marginTop: 12 }}>
            <View style={[styles.walletIcon, { backgroundColor: c.primary500 }]}><Ionicons name="wallet" size={22} color="#fff" /></View>
            <View>
              <Text style={styles.h3}>Main Wallet</Text>
              <Text style={styles.bigMoney}>{money(mainUsd)}</Text>
              <Text style={styles.tiny}>Available Balance</Text>
            </View>
          </Row>
          <Row style={{ gap: 10, marginTop: 12 }}>
            <MiniStat styles={styles} c={c} label="Total Deposits" value={money(totalDeposits)} tone={c.bull} />
            <MiniStat styles={styles} c={c} label="Total Withdrawals" value={money(totalWithdrawals)} tone={c.bear} />
          </Row>
        </View>
      </Card>

      <Card style={{ padding: 16 }}>
        <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <View style={[styles.tag, { backgroundColor: '#8B5CF622' }]}><Text style={[styles.tagTxt, { color: '#8B5CF6' }]}>Withdraw Only</Text></View>
          <TouchableOpacity onPress={() => setView('bonus')}><Text style={styles.link}>Referral Wallet ›</Text></TouchableOpacity>
        </Row>
        <Row style={{ gap: 12, marginTop: 12 }}>
          <View style={[styles.walletIcon, { backgroundColor: '#8B5CF6' }]}><Ionicons name="people" size={20} color="#fff" /></View>
          <View>
            <Text style={styles.h3}>Referral / IB Wallet</Text>
            <Text style={styles.bigMoney}>{money(refUsd)}</Text>
            <Text style={styles.tiny}>Referral Earnings</Text>
          </View>
        </Row>
        <Row style={{ gap: 8, marginTop: 12 }}>
          <MiniStat styles={styles} c={c} small label="Lifetime" value={money(toUsd(refWallet?.totalEarnings ?? partner?.totalCommissionEarned, refWallet?.currency))} tone={c.bull} />
          <MiniStat styles={styles} c={c} small label="Withdrawn" value={money(toUsd(partner?.paidCommission, partner?.walletCurrency))} tone={c.bear} />
          <MiniStat styles={styles} c={c} small label="This Month" value={money(toUsd(partner?.monthlyCommission, partner?.walletCurrency))} tone={c.textPrimary} />
        </Row>
      </Card>

      {/* Overall Trading Summary */}
      <Card>
        <Text style={styles.h3}>Overall Trading Summary</Text>
        <View style={styles.tileGrid}>
          <SummaryTile styles={styles} c={c} tint={c.primary500} label="Equity (Total)" value={usd(totals.equity)} sub={usdSub(totals.equity)} />
          <SummaryTile styles={styles} c={c} tint={c.warn} label="Pending Withdrawals" value={money(pendingWithdrawals)} />
          <SummaryTile styles={styles} c={c} tint="#0EA5E9" label="Free Margin" value={usd(totals.free)} sub={usdSub(totals.free)} />
          <SummaryTile styles={styles} c={c} tint="#8B5CF6" label="Used Margin" value={usd(totals.locked)} sub={usdSub(totals.locked)} />
          <SummaryTile styles={styles} c={c} tint={c.bull} label="Margin Level" value={totals.marginLevel != null ? `${fmtNum(totals.marginLevel, 2)}%` : '—'} note={totals.marginLevel == null ? '' : totals.marginLevel >= 100 ? 'Safe' : 'At risk'} noteTone={totals.marginLevel != null && totals.marginLevel < 100 ? c.bear : c.bull} />
          <SummaryTile styles={styles} c={c} tint={(Number(totals.unrealized) || 0) >= 0 ? c.bull : c.bear} label="Today's P&L" value={`${(Number(totals.unrealized) || 0) >= 0 ? '+' : ''}${usd(totals.unrealized)}`} valueColor={(Number(totals.unrealized) || 0) >= 0 ? c.bull : c.bear} />
        </View>
      </Card>

      {/* Trading Accounts */}
      <Card style={{ padding: 0 }}>
        <Row style={{ justifyContent: 'space-between', padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderSubtle }}>
          <Text style={styles.h3}>Your Trading Accounts</Text>
          <TouchableOpacity onPress={() => setView('details')}><Text style={styles.link}>View All ›</Text></TouchableOpacity>
        </Row>
        {accountRows.length === 0 ? (
          <Text style={styles.emptyRow}>No trading accounts yet</Text>
        ) : accountRows.map(({ a, balanceInr, equity, pnl, pct }) => (
          <Row key={a._id} style={{ justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderSubtle }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.txTitle}>{a.accountNumber || a._id.slice(-6)}</Text>
              <Text style={styles.txSub}>{a.nickname || tierLabel(a)} · Live</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.txAmt}>{money(equity)}</Text>
              <Text style={{ fontSize: 11, fontWeight: '700', color: pnl >= 0 ? c.bull : c.bear }}>{pnl >= 0 ? '+' : ''}{money(pnl)} ({pct >= 0 ? '+' : ''}{pct.toFixed(2)}%)</Text>
            </View>
          </Row>
        ))}
      </Card>

      {/* Performance Overview */}
      <Card>
        <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={styles.h3}>Performance Overview</Text>
          <Row style={{ gap: 6 }}>
            {RANGES.map((r) => (
              <TouchableOpacity key={r.k} onPress={() => setPerfRange(r.k)} style={[styles.rangePill, perfRange === r.k && { backgroundColor: c.primarySoft, borderColor: c.primary500 }]}>
                <Text style={[styles.rangePillTxt, perfRange === r.k && { color: c.primary500 }]}>{r.label}</Text>
              </TouchableOpacity>
            ))}
          </Row>
        </Row>
        <Text style={[styles.tiny, { marginTop: 8 }]}>Total Profit/Loss</Text>
        <Row style={{ gap: 8, alignItems: 'baseline' }}>
          <Text style={[styles.bigMoney, { color: perfNet >= 0 ? c.bull : c.bear }]}>{perfNet >= 0 ? '+' : ''}{money(perfNet * rate)}</Text>
          <Text style={{ fontSize: 12, fontWeight: '800', color: perfPct >= 0 ? c.bull : c.bear }}>{perfPct >= 0 ? '+' : ''}{perfPct.toFixed(2)}%</Text>
        </Row>
        <AreaChart c={c} buckets={series} />
        <Row style={{ justifyContent: 'space-between', marginTop: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.borderSubtle }}>
          <PerfStat styles={styles} c={c} label="This Week" value={rangeNet(rangeStats.week)} money={money} />
          <PerfStat styles={styles} c={c} label="This Month" value={rangeNet(rangeStats.month)} money={money} />
          <PerfStat styles={styles} c={c} label="This Year" value={rangeNet(rangeStats.year)} money={money} />
        </Row>
      </Card>

      {/* KPI cards */}
      <View style={styles.kpiGrid}>
        <KpiCard styles={styles} c={c} tint={c.primary500} icon="layers-outline" value={String(openCount)} label="Open Positions" foot={`${winningOpen} Win · ${losingOpen} Lose`} />
        <KpiCard styles={styles} c={c} tint={c.bull} icon="disc-outline" value={winRate == null ? '—' : `${Number(winRate).toFixed(1)}%`} label="Winning Rate" foot={`${wins} Wins · ${losses} Losses`} />
        <KpiCard styles={styles} c={c} tint="#8B5CF6" icon="stats-chart-outline" value={String(totalTrades)} label="Total Trades" foot="All time" />
        <KpiCard styles={styles} c={c} tint="#0EA5E9" icon="arrow-down-outline" value={money(totalDeposits)} label="Total Deposits" foot={`Withdrawn ${money(totalWithdrawals)}`} />
      </View>

      {/* Recent Wallet Transactions */}
      <Card style={{ padding: 0 }}>
        <Row style={{ justifyContent: 'space-between', padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderSubtle }}>
          <Text style={styles.h3}>Recent Wallet Transactions</Text>
          <TouchableOpacity onPress={() => setView('history')}><Text style={styles.link}>View All ›</Text></TouchableOpacity>
        </Row>
        {recent.length === 0 ? (
          <Text style={styles.emptyRow}>No wallet transactions yet</Text>
        ) : (
          <View style={{ paddingHorizontal: 14, paddingBottom: 4 }}>
            {recent.slice(0, 8).map((t) => <TxItem key={(t._id || t.id) + t._kind} styles={styles} c={c} tx={t} fxRate={rate} />)}
          </View>
        )}
      </Card>
    </View>
  );
}

function QuickAction({ styles, c, icon, label, primary, onPress }) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.quickAction, primary ? { backgroundColor: c.primary400, borderColor: c.primary400 } : { borderColor: c.border }]}>
      <Ionicons name={icon} size={16} color={primary ? '#fff' : c.textPrimary} />
      <Text style={[styles.quickActionTxt, { color: primary ? '#fff' : c.textPrimary }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function BreakPart({ styles, c, tint, icon, label, value, sub, last }) {
  return (
    <Row style={{ gap: 10, marginBottom: last ? 0 : 10, alignItems: 'center' }}>
      <View style={[styles.breakIcon, { backgroundColor: tint + '22' }]}><Ionicons name={icon} size={16} color={tint} /></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.kicker}>{label}</Text>
        <Text style={styles.txAmt}>{value}</Text>
        <Text style={styles.tiny}>{sub}</Text>
      </View>
    </Row>
  );
}

function MiniStat({ styles, c, label, value, tone, small }) {
  return (
    <View style={styles.miniStat}>
      <Text style={styles.kicker} numberOfLines={1}>{label}</Text>
      <Text style={[small ? styles.miniStatValSm : styles.miniStatVal, { color: tone || c.textPrimary }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function SummaryTile({ styles, c, tint, label, value, sub, note, noteTone, valueColor }) {
  return (
    <View style={styles.tile}>
      <View style={[styles.tileIcon, { backgroundColor: tint + '22' }]}><Ionicons name="ellipse" size={10} color={tint} /></View>
      <Text style={styles.kicker} numberOfLines={1}>{label}</Text>
      <Text style={[styles.tileVal, valueColor && { color: valueColor }]} numberOfLines={1}>{value}</Text>
      {sub ? <Text style={styles.tiny} numberOfLines={1}>{sub}</Text> : null}
      {note ? <Text style={{ fontSize: 10, fontWeight: '700', color: noteTone }}>● {note}</Text> : null}
    </View>
  );
}

function KpiCard({ styles, c, tint, icon, value, label, foot }) {
  return (
    <View style={styles.kpiCard}>
      <View style={[styles.tileIcon, { backgroundColor: tint + '22' }]}><Ionicons name={icon} size={16} color={tint} /></View>
      <Text style={styles.kpiVal} numberOfLines={1}>{value}</Text>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={styles.tiny} numberOfLines={1}>{foot}</Text>
    </View>
  );
}

function PerfStat({ styles, c, label, value, money }) {
  const pos = value >= 0;
  return (
    <View style={{ alignItems: 'center', flex: 1 }}>
      <Text style={styles.kicker}>{label}</Text>
      <Text style={{ fontSize: 13, fontWeight: '800', color: pos ? c.bull : c.bear }}>{pos ? '+' : ''}{money(value)}</Text>
    </View>
  );
}

function AreaChart({ c, buckets }) {
  const vals = (buckets || []).map((b) => Number(b.equity || 0));
  if (vals.length < 2) {
    return <View style={{ height: 120, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: c.textMuted, fontSize: 11 }}>Not enough data yet</Text></View>;
  }
  const W = 320, H = 110, min = Math.min(...vals, 0), max = Math.max(...vals, 0);
  const span = max - min || 1;
  const x = (i) => (i / (vals.length - 1)) * W;
  const y = (v) => H - ((v - min) / span) * H;
  const pos = vals[vals.length - 1] >= vals[0];
  const stroke = pos ? c.bull : c.bear;
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const areaPts = `0,${H} ${pts} ${W},${H}`;
  return (
    <View style={{ marginTop: 8 }}>
      <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <Polygon points={areaPts} fill={stroke} fillOpacity={0.15} />
        <Polyline points={pts} fill="none" stroke={stroke} strokeWidth={2} />
      </Svg>
    </View>
  );
}

/* ─────────────────────────── Deposit ─────────────────────────── */
const DEPOSIT_METHODS = [
  { id: 'UPI', label: 'UPI', sub: 'Instant · Free', min: 100 },
  { id: 'BANK', label: 'Bank Transfer', sub: 'NEFT / IMPS · 1-3 hrs', min: 100 },
  { id: 'CRYPTO', label: 'Crypto (USDT)', sub: 'TRC20 · ~5 min', min: 500 },
  { id: 'SKRILL', label: 'Skrill', sub: 'Instant · Free', min: 100 },
  { id: 'NETELLER', label: 'Neteller', sub: 'Instant · Free', min: 100 },
];
const DEPOSIT_STEPS = [
  { id: 'account', label: 'Account' }, { id: 'method', label: 'Method' },
  { id: 'amount', label: 'Amount' }, { id: 'proof', label: 'Proof' }, { id: 'confirm', label: 'Review' },
];

function DepositView({ styles, c, accounts, balances, fxRate, setView, reload }) {
  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
  const real = accounts.find((a) => REAL(a.accountType));
  const [accountId, setAccountId] = useState(real?._id || accounts[0]?._id || '');
  // USD default. UPI/BANK are domestic INR rails, so the method default has to
  // follow the currency default or it flips the moment the form opens.
  const [currency, setCurrency] = useState('USD');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CRYPTO');
  const [txReference, setTxReference] = useState('');
  const [senderName, setSenderName] = useState('');
  const [senderUpiId, setSenderUpiId] = useState('');
  const [senderBankAccount, setSenderBankAccount] = useState('');
  const [proof, setProof] = useState(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [payDetails, setPayDetails] = useState(null);
  // WHICH rails exist is an admin decision that arrives over the network. Until
  // it lands we know nothing — not "everything is on" — so the hard-coded list
  // must not be on screen: on a slow connection that window was long enough for
  // a user to pick, and submit, a method the admin had switched off.
  const [payState, setPayState] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [planByCode, setPlanByCode] = useState({});

  useEffect(() => {
    api.get('/wallet/deposit-details')
      .then((r) => { setPayDetails(r.data?.data || {}); setPayState('ready'); })
      .catch(() => { setPayDetails(null); setPayState('error'); });
    api.get('/account-plans').then((r) => {
      const map = {};
      for (const p of (r.data?.data || [])) map[String(p.code).toUpperCase()] = p;
      setPlanByCode(map);
    }).catch(() => setPlanByCode({}));
  }, []);

  const selectedAccount = accounts.find((a) => a._id === accountId);
  const isReal = selectedAccount && REAL(selectedAccount.accountType);
  const isDemo = !isReal;

  const methods = useMemo(() => {
    if (payState !== 'ready') return [];
    const fixed = DEPOSIT_METHODS.filter((m) => payDetails?.[m.id]?.enabled !== false);
    const custom = (payDetails?.custom || []).filter((x) => x && x.label && x.enabled !== false)
      .map((x) => ({ id: `CUSTOM:${x.id}`, label: x.label, sub: 'Manual', min: Number(x.min) > 0 ? Number(x.min) : 100, custom: x }));
    return [...fixed, ...custom];
  }, [payDetails, payState]);

  // The default ('CRYPTO') is a guess made before the settings arrive. Once
  // they do, snap onto a rail that is actually open — otherwise a hidden
  // default stayed selected all the way to submit.
  useEffect(() => {
    if (payState !== 'ready' || !methods.length) return;
    if (methods.some((m) => m.id === method)) return;
    setMethod(methods[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payState, methods]);

  // No hard-coded fallback: falling back to DEPOSIT_METHODS[0] is exactly how a
  // rail the admin switched off ended up driving the form.
  const selectedMethod = methods.find((m) => m.id === method) || methods[0] || null;
  const selectedCustom = String(method).startsWith('CUSTOM:') ? (payDetails?.custom || []).find((x) => `CUSTOM:${x.id}` === method) : null;

  const planMinUsd = (() => {
    const p = selectedAccount ? planByCode[String(selectedAccount.accountType).toUpperCase()] : null;
    return p ? Number(p.minDeposit || 0) : 0;
  })();
  const amountUsd = (() => {
    const amt = Number(amount) || 0;
    if (currency === 'INR') return amt / rate;
    if (currency === 'USD' || currency === 'USDT') return amt;
    return null;
  })();
  const belowMin = isReal && planMinUsd > 0 && amountUsd != null && amountUsd < planMinUsd;

  const presets = currency === 'INR' ? [100, 500, 1000, 5000, 10000] : [10, 50, 100, 500, 1000];
  const skipProof = isDemo;
  const steps = skipProof ? DEPOSIT_STEPS.filter((s) => s.id !== 'proof') : DEPOSIT_STEPS;
  const stepId = steps[step]?.id;

  const canNext = (() => {
    if (stepId === 'account') return !!accountId;
    // Not merely "something is selected": it must be a rail we have CONFIRMED
    // the admin leaves open, which we only know once payDetails has landed.
    if (stepId === 'method') return payState === 'ready' && methods.some((m) => m.id === method);
    if (stepId === 'amount') return amount && Number(amount) >= (selectedMethod?.min || 1) && !belowMin;
    if (stepId === 'proof') return !!proof && !!txReference.trim() && !!senderName.trim();
    return true;
  })();

  const pickProof = async () => { const img = await pickImageBase64(); if (img) setProof(img); };

  const submit = async () => {
    if (belowMin) { Alert.alert('Minimum deposit', `Minimum for ${selectedAccount?.nickname || selectedAccount?.accountType} is $${fmtNum(planMinUsd, 2)}.`); return; }
    if (isReal && (!proof || !txReference.trim())) { Alert.alert('Proof required', 'Attach a payment screenshot and enter a transaction reference.'); return; }
    setBusy(true);
    try {
      const payload = {
        accountId, currency, amount,
        method: selectedCustom ? selectedCustom.label : method,
        txReference, senderName, senderUpiId, senderBankAccount,
      };
      if (isReal && proof) { payload.screenshot = proof.base64; payload.screenshotMimeType = proof.mimeType; }
      await api.post('/wallet/deposits', payload);
      Alert.alert('Submitted', isDemo ? 'Demo balance added.' : 'Deposit submitted — pending admin verification.',
        [{ text: 'OK', onPress: () => { reload(); setView('overview'); } }]);
    } catch (e) {
      Alert.alert('Deposit failed', errorMessage(e));
    } finally { setBusy(false); }
  };

  const payRows = (() => {
    const dd = selectedCustom || payDetails?.[method] || {};
    let rows = [];
    if (selectedCustom) rows = (selectedCustom.fields || []).map((f) => ({ l: f.label, v: f.value }));
    else if (method === 'UPI') rows = [{ l: 'UPI ID', v: dd.upiId }, { l: 'Beneficiary', v: dd.payeeName }];
    else if (method === 'BANK') rows = [{ l: 'Beneficiary', v: dd.accountName }, { l: 'A/C', v: dd.accountNumber }, { l: 'IFSC', v: dd.ifsc }, { l: 'Bank', v: dd.bankName }];
    else if (method === 'CRYPTO') rows = [{ l: 'Address', v: dd.address }, { l: 'Network', v: dd.network }];
    else rows = [{ l: 'Email', v: dd.email }];
    return { rows: rows.filter((r) => String(r.v || '').trim()), note: dd.note, qr: dd.qr };
  })();

  return (
    <View style={{ gap: 12 }}>
      <View>
        <Text style={styles.h1}>Add Funds</Text>
        <Text style={styles.pSub}>Securely add balance to your trading account</Text>
      </View>
      <Card>
        <Stepper styles={styles} c={c} steps={steps} step={step} />

        {stepId === 'account' && (
          <View style={{ marginTop: 8 }}>
            <Text style={styles.h3}>Select an account</Text>
            <View style={{ height: 10 }} />
            <AccountCards styles={styles} c={c} accounts={accounts} balances={balances} fxRate={rate} selectedId={accountId} onSelect={setAccountId} />
          </View>
        )}

        {stepId === 'method' && (
          <View style={{ marginTop: 8, gap: 10 }}>
            <Text style={styles.h3}>Choose payment method</Text>
            {payState === 'loading' && (
              <View style={{ paddingVertical: 18, alignItems: 'center', gap: 8 }}>
                <ActivityIndicator color={c.primary400} />
                <Text style={styles.txSub}>Loading available payment methods…</Text>
              </View>
            )}
            {payState === 'error' && (
              <Text style={[styles.txSub, { marginTop: 6 }]}>
                Couldn't load the available payment methods. Check your connection and reopen this before sending any money.
              </Text>
            )}
            {payState === 'ready' && methods.length === 0 && (
              <Text style={[styles.txSub, { marginTop: 6 }]}>No payment methods are available right now. Please contact support.</Text>
            )}
            {methods.map((m) => {
              const sel = method === m.id;
              return (
                <TouchableOpacity key={m.id} onPress={() => setMethod(m.id)} style={[styles.methodCard, sel && { borderColor: c.primary400, backgroundColor: c.primarySoft }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.methodLabel}>{m.label}</Text>
                    <Text style={styles.txSub}>{m.sub}</Text>
                    <Text style={styles.txSub}>Min · {currencySymbol(currency)}{m.min}</Text>
                  </View>
                  <View style={[styles.radio, sel && { borderColor: c.primary400, backgroundColor: c.primary400 }]}>{sel && <Ionicons name="checkmark" size={12} color="#fff" />}</View>
                </TouchableOpacity>
              );
            })}
            {isReal && payState === 'ready' && !!selectedMethod && (
              <View style={styles.payBox}>
                <Text style={styles.methodLabel}>Pay to these details</Text>
                {payRows.rows.length === 0 ? (
                  <Text style={[styles.txSub, { marginTop: 6 }]}>Payment details for {method} aren't set up yet. Contact support before sending money.</Text>
                ) : (
                  <View style={{ marginTop: 8, gap: 6 }}>
                    {payRows.rows.map((r) => (
                      <Row key={r.l} style={{ justifyContent: 'space-between' }}>
                        <Text style={styles.txSub}>{r.l}</Text>
                        <Text selectable style={styles.payVal}>{r.v}</Text>
                      </Row>
                    ))}
                    {payRows.note ? <Text style={[styles.txSub, { marginTop: 6 }]}>{payRows.note}</Text> : null}
                    {payRows.qr ? <Image source={{ uri: payRows.qr }} style={styles.qr} resizeMode="contain" /> : null}
                  </View>
                )}
              </View>
            )}
          </View>
        )}

        {stepId === 'amount' && (
          <View style={{ marginTop: 8, gap: 12 }}>
            <Text style={styles.h3}>Enter amount</Text>
            <Row style={{ flexWrap: 'wrap', gap: 8 }}>
              {presets.map((p) => {
                const sel = String(amount) === String(p);
                return (
                  <TouchableOpacity key={p} onPress={() => setAmount(String(p))} style={[styles.preset, sel && { borderColor: c.primary400, backgroundColor: c.primarySoft }]}>
                    <Text style={[styles.presetTxt, sel && { color: c.primary500 }]}>{currencySymbol(currency)}{p.toLocaleString()}</Text>
                  </TouchableOpacity>
                );
              })}
            </Row>
            <View>
              <Text style={styles.fieldLbl}>Custom amount</Text>
              <Row style={{ gap: 8, marginTop: 6 }}>
                <Row style={{ flex: 1, alignItems: 'center' }}>
                  <Text style={styles.cur}>{currencySymbol(currency)}</Text>
                  <TextInput value={amount} onChangeText={setAmount} placeholder="0.00" placeholderTextColor={c.textMuted} keyboardType="decimal-pad" style={[styles.input, { flex: 1 }]} />
                </Row>
                <CcyPicker styles={styles} c={c} value={currency} options={['INR', 'USD', 'USDT']} onChange={setCurrency} />
              </Row>
            </View>
            <View style={styles.summaryBox}>
              {(() => {
                const amt = Number(amount) || 0;
                const isInr = currency === 'INR';
                const alt = isInr ? amt / rate : amt * rate;
                const altSym = isInr ? '$' : '₹';
                return (
                  <>
                    <Row style={{ justifyContent: 'space-between' }}><Text style={styles.txSub}>You Pay</Text><Text style={styles.payVal}>{currencySymbol(currency)}{fmtNum(amt, 2)}</Text></Row>
                    <Row style={{ justifyContent: 'space-between' }}><Text style={styles.txSub}>Fees</Text><Text style={[styles.payVal, { color: c.bull }]}>{currencySymbol(currency)}0.00</Text></Row>
                    <Row style={{ justifyContent: 'space-between' }}><Text style={styles.txSub}>You Receive</Text><Text style={styles.payVal}>{currencySymbol(currency)}{fmtNum(amt, 2)} (≈ {altSym}{fmtNum(alt, 2)})</Text></Row>
                    <Row style={{ justifyContent: 'space-between', marginTop: 4 }}><Text style={styles.txSub}>Live FX</Text><Text style={styles.txSub}>1 USD = ₹{fmtNum(rate, 2)}</Text></Row>
                  </>
                );
              })()}
            </View>
            {belowMin && <Text style={styles.errText}>Minimum deposit for {selectedAccount?.nickname || selectedAccount?.accountType} is ${fmtNum(planMinUsd, 2)}. You entered ≈ ${fmtNum(amountUsd || 0, 2)}.</Text>}
            {isDemo && <Text style={[styles.txSub, { color: c.info }]}>Demo accounts are credited instantly. No payment is collected.</Text>}
          </View>
        )}

        {stepId === 'proof' && (
          <View style={{ marginTop: 8, gap: 10 }}>
            <Text style={styles.h3}>Upload payment proof</Text>
            <TouchableOpacity onPress={pickProof} style={styles.dropzone}>
              {proof ? <Image source={{ uri: proof.uri }} style={styles.preview} resizeMode="cover" /> : (
                <><Ionicons name="cloud-upload-outline" size={26} color={c.textMuted} /><Text style={{ color: c.textMuted, marginTop: 6 }}>Tap to attach the UPI/bank receipt</Text></>
              )}
            </TouchableOpacity>
            <Field styles={styles} c={c} label="Transaction reference *" value={txReference} onChangeText={setTxReference} placeholder="e.g. 4123456789012" />
            <Field styles={styles} c={c} label="Your name *" value={senderName} onChangeText={setSenderName} placeholder="As on bank / UPI" autoCapitalize="words" />
            {method === 'UPI' && <Field styles={styles} c={c} label="Your UPI ID" value={senderUpiId} onChangeText={setSenderUpiId} placeholder="yourname@upi" />}
            {method === 'BANK' && <Field styles={styles} c={c} label="Bank A/C last 4 digits" value={senderBankAccount} onChangeText={setSenderBankAccount} placeholder="1234" keyboardType="number-pad" maxLength={4} />}
          </View>
        )}

        {stepId === 'confirm' && (
          <View style={{ marginTop: 8, gap: 8 }}>
            <Text style={styles.h3}>Review & confirm</Text>
            <View style={styles.summaryBox}>
              <ReviewRow styles={styles} l="Account" v={`${selectedAccount?.nickname || selectedAccount?.accountNumber} · ${tierLabel(selectedAccount)}`} />
              <ReviewRow styles={styles} l="Method" v={selectedMethod?.label} />
              <ReviewRow styles={styles} l="Amount" v={`${currencySymbol(currency)}${fmtNum(Number(amount) || 0, 2)}`} />
              <ReviewRow styles={styles} l="Fees" v={`${currencySymbol(currency)}0.00`} />
              {isReal ? <ReviewRow styles={styles} l="Reference" v={txReference || '—'} /> : null}
              {isReal ? <ReviewRow styles={styles} l="Sender" v={senderName || '—'} /> : null}
            </View>
            <Text style={styles.txSub}>{isReal ? 'Admin will verify your screenshot within 1–24 hours.' : 'Demo funds credit instantly.'}</Text>
          </View>
        )}

        {step < steps.length - 1 ? (
          <BottomBar styles={styles} c={c} onBack={() => step === 0 ? setView('overview') : setStep(step - 1)} backLabel={step === 0 ? 'Cancel' : '← Back'} onNext={() => setStep(step + 1)} nextLabel="Continue →" nextDisabled={!canNext} />
        ) : (
          <BottomBar styles={styles} c={c} onBack={() => setStep(step - 1)} backLabel="← Back" onNext={submit} nextLabel={isDemo ? 'Add to Demo' : 'Confirm Deposit'} loading={busy} />
        )}
      </Card>
    </View>
  );
}

function ReviewRow({ styles, l, v }) {
  return <Row style={{ justifyContent: 'space-between' }}><Text style={styles.txSub}>{l}</Text><Text style={styles.payVal} numberOfLines={1}>{v}</Text></Row>;
}

function CcyPicker({ styles, c, value, options, onChange }) {
  return (
    <Row style={{ gap: 6, flexWrap: 'wrap' }}>
      {options.map((o) => (
        <TouchableOpacity key={o} onPress={() => onChange(o)} style={[styles.ccyOpt, value === o && { backgroundColor: c.primarySoft, borderColor: c.primary500 }]}>
          <Text style={[styles.ccyOptTxt, value === o && { color: c.primary500 }]}>{o}</Text>
        </TouchableOpacity>
      ))}
    </Row>
  );
}

/* ─────────────────────────── Withdraw ─────────────────────────── */
const WD_METHODS = [
  { id: 'UPI', label: 'UPI', sub: 'Instant · Free', min: 500 },
  { id: 'BANK', label: 'Bank Transfer', sub: 'NEFT / IMPS · 1-24 hrs', min: 500 },
  { id: 'CRYPTO', label: 'Crypto Wallet', sub: 'USDT / BTC / ETH · ~5min', min: 1000 },
];
const WD_STEPS = [
  { id: 'account', label: 'Account' }, { id: 'method', label: 'Method' },
  { id: 'amount', label: 'Amount' }, { id: 'destination', label: 'Where' }, { id: 'confirm', label: 'Review' },
];

function WithdrawView({ styles, c, accounts, balances, withdrawals, fxRate, setView, reload }) {
  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
  const real = accounts.find((a) => REAL(a.accountType));
  const [accountId, setAccountId] = useState(real?._id || accounts[0]?._id || '');
  // USD default, with a method that is valid for it — see above.
  const [currency, setCurrency] = useState('USD');
  const [method, setMethod] = useState('CRYPTO');
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [upiId, setUpiId] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [bankIFSC, setBankIFSC] = useState('');
  const [bankAccountHolderName, setBankAccountHolderName] = useState('');
  const [bankName, setBankName] = useState('');
  const [cryptoAddress, setCryptoAddress] = useState('');
  const [cryptoNetwork, setCryptoNetwork] = useState('USDT-TRC20');
  const [payDetails, setPayDetails] = useState(null);
  const [payState, setPayState] = useState('loading'); // 'loading' | 'ready' | 'error'
  useEffect(() => {
    api.get('/wallet/deposit-details')
      .then((r) => { setPayDetails(r.data?.data || {}); setPayState('ready'); })
      .catch(() => { setPayDetails(null); setPayState('error'); });
  }, []);
  // Deposit and withdrawal are separate switches; `withdrawalEnabled` absent
  // means the admin has never touched the payout one, so fall back to the
  // deposit flag exactly as the server does.
  const railOpen = (cfg) => (cfg
    ? (cfg.withdrawalEnabled === undefined || cfg.withdrawalEnabled === null
      ? cfg.enabled !== false
      : cfg.withdrawalEnabled !== false)
    : true);
  const methods = payState !== 'ready' ? [] : WD_METHODS.filter((m) => railOpen(payDetails?.[m.id]));

  const selectedAccount = accounts.find((a) => a._id === accountId);
  const isDemo = !REAL(selectedAccount?.accountType);
  const sym = currencySymbol(currency);

  // Which currencies a rail pays out in is the admin's call (supportedCurrencies),
  // not a hard-coded "UPI and Bank are INR-only". The method is chosen first, so
  // the currency follows it — forcing the method to follow the currency instead
  // made UPI and Bank unselectable, since the currency starts at USD.
  // Mirrors withdrawalCurrencies() on the server — see the web client.
  const DOMESTIC_RAIL_CURRENCIES = { UPI: ['INR'], BANK: ['INR'] };
  const railCurrencies = (cfg, id) => {
    const listed = Array.isArray(cfg?.supportedCurrencies) && cfg.supportedCurrencies.length
      ? cfg.supportedCurrencies.map((x) => String(x).toUpperCase())
      : null;
    return listed || DOMESTIC_RAIL_CURRENCIES[String(id || '').toUpperCase()] || null;
  };
  const ccyOptions = railCurrencies(payDetails?.[method], method) || ['INR', 'USD', 'USDT'];
  useEffect(() => {
    if (!ccyOptions.includes(currency)) setCurrency(ccyOptions[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ccyOptions.join(','), currency]);
  // The default ('CRYPTO') is a guess made before the settings arrive.
  const _openIds = methods.map((m) => m.id).join(',');
  useEffect(() => {
    if (methods.length && !methods.some((m) => m.id === method)) setMethod(methods[0].id);
  }, [_openIds, method]);

  const availableBalance = (() => {
    if (!accountId) return 0;
    let total = 0;
    for (const w of (balances || []).filter((b) => b.accountId === accountId)) {
      const free = Math.max(0, Number(w.free || 0));
      if (!free) continue;
      if (w.currency === currency) total += free;
      else if (w.currency === 'USD' && currency === 'INR') total += free * rate;
      else if (w.currency === 'INR' && currency === 'USD') total += free / rate;
      else total += free;
    }
    return total;
  })();
  const isOverBudget = Number(amount) > availableBalance;

  const steps = isDemo ? WD_STEPS.filter((s) => s.id !== 'method' && s.id !== 'destination') : WD_STEPS;
  const stepId = steps[step]?.id;
  const selectedMethod = methods.find((m) => m.id === method) || methods[0] || WD_METHODS[0];

  const canNext = (() => {
    if (stepId === 'account') return !!accountId;
    if (stepId === 'method') return payState === 'ready' && methods.some((m) => m.id === method);
    if (stepId === 'amount') return amount && Number(amount) >= (isDemo ? 1 : (selectedMethod.min || 1)) && !isOverBudget;
    if (stepId === 'destination') {
      if (method === 'UPI') return upiId && upiId.includes('@');
      if (method === 'BANK') return bankAccountNumber.length >= 5 && bankIFSC.length === 11 && !!bankAccountHolderName.trim();
      if (method === 'CRYPTO') return cryptoAddress.length >= 20;
    }
    return true;
  })();

  const submit = async () => {
    if (!amount || Number(amount) <= 0) { Alert.alert('Amount', 'Enter a valid amount'); return; }
    if (Number(amount) > availableBalance) { Alert.alert('Insufficient balance', `Available: ${sym}${fmtNum(availableBalance, 2)}`); return; }
    setBusy(true);
    try {
      const payload = { accountId, currency, amount, method };
      if (method === 'UPI') payload.upiId = upiId.trim();
      if (method === 'BANK') { payload.bankAccountNumber = bankAccountNumber.trim(); payload.bankIFSC = bankIFSC.trim().toUpperCase(); payload.bankAccountHolderName = bankAccountHolderName.trim(); payload.bankName = bankName.trim(); }
      if (method === 'CRYPTO') { payload.cryptoAddress = cryptoAddress.trim(); payload.cryptoNetwork = cryptoNetwork; }
      await api.post('/wallet/withdrawals', payload);
      Alert.alert('Submitted', isDemo ? 'Demo withdrawal completed instantly.' : 'Withdrawal request submitted — admin will process within 24 hours.',
        [{ text: 'OK', onPress: () => { reload(); setView('overview'); } }]);
    } catch (e) {
      Alert.alert('Withdrawal failed', errorMessage(e));
    } finally { setBusy(false); }
  };

  return (
    <View style={{ gap: 12 }}>
      <View>
        <Text style={styles.h1}>Withdraw Funds</Text>
        <Text style={styles.pSub}>Request a withdrawal to your bank or wallet</Text>
      </View>
      <Card>
        <Stepper styles={styles} c={c} steps={steps} step={step} />

        {stepId === 'account' && (
          <View style={{ marginTop: 8 }}>
            <Text style={styles.h3}>Withdraw from</Text>
            <View style={{ height: 10 }} />
            <AccountCards styles={styles} c={c} accounts={accounts} balances={balances} fxRate={rate} selectedId={accountId} onSelect={setAccountId} availableLabel />
          </View>
        )}

        {stepId === 'method' && (
          <View style={{ marginTop: 8, gap: 10 }}>
            <Text style={styles.h3}>Choose withdrawal method</Text>
            {payState === 'loading' && <Text style={styles.txSub}>Loading available methods…</Text>}
            {payState === 'error' && (
              <Text style={styles.txSub}>
                Couldn't load the available withdrawal methods. Check your connection and try again.
              </Text>
            )}
            {payState === 'ready' && !methods.length && (
              <Text style={styles.txSub}>No withdrawal methods are available right now. Please contact support.</Text>
            )}
            {methods.map((m) => {
              const sel = method === m.id;
              // Nothing is greyed out: the currency is chosen on the NEXT step
              // and follows whichever rail you pick.
              const ccys = railCurrencies(payDetails?.[m.id], m.id);
              return (
                <TouchableOpacity key={m.id} onPress={() => setMethod(m.id)} style={[styles.methodCard, sel && { borderColor: c.primary400, backgroundColor: c.primarySoft }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.methodLabel}>{m.label}</Text>
                    <Text style={styles.txSub}>{m.sub}</Text>
                    <Text style={styles.txSub}>Min · {sym}{m.min}</Text>
                    {!!ccys && <Text style={styles.txSub}>Pays out in {ccys.join(' · ')}</Text>}
                  </View>
                  <View style={[styles.radio, sel && { borderColor: c.primary400, backgroundColor: c.primary400 }]}>{sel && <Ionicons name="checkmark" size={12} color="#fff" />}</View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {stepId === 'amount' && (
          <View style={{ marginTop: 8, gap: 12 }}>
            <Text style={styles.h3}>How much would you like to withdraw?</Text>
            <View style={[styles.summaryBox, { borderColor: c.bull + '55' }]}>
              <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <View>
                  <Text style={styles.kicker}>Available to Withdraw</Text>
                  <Text style={[styles.bigMoney, { color: c.bull }]}>{sym}{fmtNum(availableBalance, 2)}</Text>
                </View>
                <TouchableOpacity onPress={() => setAmount(String(availableBalance))} disabled={availableBalance <= 0} style={[styles.maxBtn, { borderColor: c.bull }]}>
                  <Text style={{ color: c.bull, fontWeight: '800', fontSize: 12 }}>Use MAX</Text>
                </TouchableOpacity>
              </Row>
            </View>
            <Row style={{ gap: 8 }}>
              {[25, 50, 75, 100].map((pct) => {
                const v = (availableBalance * pct) / 100;
                const sel = amount && Math.abs(Number(amount) - v) < 0.01;
                return (
                  <TouchableOpacity key={pct} onPress={() => setAmount(v.toFixed(2))} style={[styles.preset, { flex: 1 }, sel && { borderColor: c.primary400, backgroundColor: c.primarySoft }]}>
                    <Text style={[styles.presetTxt, sel && { color: c.primary500 }]}>{pct === 100 ? 'MAX' : `${pct}%`}</Text>
                  </TouchableOpacity>
                );
              })}
            </Row>
            <View>
              <Text style={styles.fieldLbl}>Custom amount</Text>
              <Row style={{ gap: 8, marginTop: 6 }}>
                <Row style={{ flex: 1, alignItems: 'center' }}>
                  <Text style={styles.cur}>{sym}</Text>
                  <TextInput value={amount} onChangeText={setAmount} placeholder="0.00" placeholderTextColor={c.textMuted} keyboardType="decimal-pad" style={[styles.input, { flex: 1 }, isOverBudget && { borderColor: c.bear }]} />
                </Row>
                <CcyPicker styles={styles} c={c} value={currency} options={ccyOptions} onChange={setCurrency} />
              </Row>
              {isOverBudget && <Text style={styles.errText}>Exceeds your available balance</Text>}
            </View>
          </View>
        )}

        {stepId === 'destination' && (
          <View style={{ marginTop: 8 }}>
            <Text style={styles.h3}>Destination details</Text>
            {method === 'UPI' && <Field styles={styles} c={c} label="Your UPI ID *" value={upiId} onChangeText={setUpiId} placeholder="yourname@upi" />}
            {method === 'BANK' && (
              <>
                <Field styles={styles} c={c} label="Account holder name *" value={bankAccountHolderName} onChangeText={setBankAccountHolderName} placeholder="Full name" autoCapitalize="words" />
                <Field styles={styles} c={c} label="Account number *" value={bankAccountNumber} onChangeText={(t) => setBankAccountNumber(t.replace(/\s/g, ''))} placeholder="50100123456789" keyboardType="number-pad" />
                <Field styles={styles} c={c} label="IFSC *" value={bankIFSC} onChangeText={(t) => setBankIFSC(t.toUpperCase())} placeholder="HDFC0001234" maxLength={11} autoCapitalize="characters" />
                <Field styles={styles} c={c} label="Bank name" value={bankName} onChangeText={setBankName} placeholder="HDFC Bank" autoCapitalize="words" />
              </>
            )}
            {method === 'CRYPTO' && (
              <>
                <View style={{ marginTop: 12 }}>
                  <Text style={styles.fieldLbl}>Network *</Text>
                  <CcyPicker styles={styles} c={c} value={cryptoNetwork} options={['USDT-TRC20', 'USDT-ERC20', 'USDT-BEP20', 'BTC', 'ETH']} onChange={setCryptoNetwork} />
                </View>
                <Field styles={styles} c={c} label="Wallet address *" value={cryptoAddress} onChangeText={(t) => setCryptoAddress(t.trim())} placeholder="0x... or T..." />
                <Text style={[styles.txSub, { marginTop: 8 }]}>Crypto addresses may need to be whitelisted from your Profile (24h cooldown) before they're accepted.</Text>
              </>
            )}
            <Text style={[styles.txSub, { marginTop: 12 }]}>Withdrawals are processed manually within 1-24 hours. Funds are locked immediately on submit.</Text>
          </View>
        )}

        {stepId === 'confirm' && (
          <View style={{ marginTop: 8, gap: 8 }}>
            <Text style={styles.h3}>Review & confirm</Text>
            <View style={styles.summaryBox}>
              <ReviewRow styles={styles} l="Account" v={`${selectedAccount?.nickname || selectedAccount?.accountNumber} · ${tierLabel(selectedAccount)}`} />
              <ReviewRow styles={styles} l="Method" v={selectedMethod?.label} />
              <ReviewRow styles={styles} l="Amount" v={`${sym}${fmtNum(Number(amount) || 0, 2)}`} />
              <ReviewRow styles={styles} l="Fees" v={`${sym}0.00`} />
              {method === 'UPI' ? <ReviewRow styles={styles} l="UPI ID" v={upiId || '—'} /> : null}
              {method === 'BANK' ? <ReviewRow styles={styles} l="Beneficiary" v={bankAccountHolderName || '—'} /> : null}
              {method === 'BANK' ? <ReviewRow styles={styles} l="Account" v={bankAccountNumber ? `••• ${bankAccountNumber.slice(-4)}` : '—'} /> : null}
              {method === 'CRYPTO' ? <ReviewRow styles={styles} l="Network" v={cryptoNetwork} /> : null}
              {method === 'CRYPTO' ? <ReviewRow styles={styles} l="Address" v={cryptoAddress ? `${cryptoAddress.slice(0, 8)}…${cryptoAddress.slice(-6)}` : '—'} /> : null}
            </View>
            <Text style={styles.txSub}>Funds will be locked immediately on submit. Admin releases within 1–24 hours.</Text>
          </View>
        )}

        {step < steps.length - 1 ? (
          <BottomBar styles={styles} c={c} onBack={() => step === 0 ? setView('overview') : setStep(step - 1)} backLabel={step === 0 ? 'Cancel' : '← Back'} onNext={() => setStep(step + 1)} nextLabel="Continue →" nextDisabled={!canNext} />
        ) : (
          <BottomBar styles={styles} c={c} onBack={() => setStep(step - 1)} backLabel="← Back" onNext={submit} nextLabel={isDemo ? 'Withdraw instantly' : 'Request Withdrawal'} nextDisabled={!canNext} loading={busy} />
        )}
      </Card>

      <Card style={{ padding: 0 }}>
        <View style={{ padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderSubtle }}>
          <Text style={styles.h3}>Recent Withdrawals</Text>
        </View>
        {(!withdrawals || withdrawals.length === 0) ? (
          <Text style={styles.emptyRow}>No withdrawals</Text>
        ) : (
          <View style={{ paddingHorizontal: 14, paddingBottom: 4 }}>
            {withdrawals.slice(0, 8).map((w) => <TxItem key={w._id} styles={styles} c={c} tx={{ ...w, _kind: 'withdraw' }} fxRate={rate} />)}
          </View>
        )}
      </Card>
    </View>
  );
}

/* ─────────────────────────── Transfer ─────────────────────────── */
function TransferView({ styles, c, accounts, balances, fxRate, reload }) {
  const [mode, setMode] = useState('self');
  const liveAccounts = useMemo(() => accounts.filter((a) => REAL(a.accountType)), [accounts]);
  const [subWallet, setSubWallet] = useState(null);
  const [bonusWallet, setBonusWallet] = useState(null);

  useEffect(() => {
    api.get('/subscription-wallet').then((r) => setSubWallet(r.data?.data || null)).catch(() => {});
    api.get('/bonus-wallet').then((r) => setBonusWallet(r.data?.data || null)).catch(() => {});
  }, []);

  return (
    <View style={{ gap: 12 }}>
      <View>
        <Text style={styles.h1}>Transfer Funds</Text>
        <Text style={styles.pSub}>{mode === 'self' ? 'Move funds between your accounts and wallets.' : 'Send funds to another registered user.'}</Text>
      </View>
      <Row style={{ gap: 8 }}>
        <TabBtn styles={styles} c={c} active={mode === 'self'} label="Between my accounts" onPress={() => setMode('self')} />
        <TabBtn styles={styles} c={c} active={mode === 'user'} label="Send to another user" onPress={() => setMode('user')} />
      </Row>
      {mode === 'self'
        ? <SelfTransfer styles={styles} c={c} liveAccounts={liveAccounts} balances={balances} subWallet={subWallet} bonusWallet={bonusWallet} reload={reload} />
        : <UserTransfer styles={styles} c={c} accounts={liveAccounts} balances={balances} subWallet={subWallet} reload={reload} />}
    </View>
  );
}

function TabBtn({ styles, c, active, label, onPress }) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.tabBtn, active && { backgroundColor: c.primarySoft, borderColor: c.primary500 }]}>
      <Text style={[styles.tabBtnTxt, active && { color: c.primary500 }]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

function SelfTransfer({ styles, c, liveAccounts, balances, subWallet, bonusWallet, reload }) {
  const SUB = { _id: 'subscription', nickname: 'Main Wallet · USD' };
  const BONUS = { _id: 'bonus', nickname: 'Bonus Wallet · USD' };
  const options = useMemo(() => [...liveAccounts.map((a) => ({ _id: a._id, nickname: `${a.nickname || a.accountNumber} · ${tierLabel(a)}` })), SUB, BONUS], [liveAccounts]);
  const [from, setFrom] = useState(liveAccounts[0]?._id || '');
  const [to, setTo] = useState(liveAccounts[1]?._id || 'subscription');
  const [currency, setCurrency] = useState('USD');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  const isSpecial = (id) => id === 'subscription' || id === 'bonus';
  const free = from === 'subscription' ? Number(subWallet?.balance || 0)
    : from === 'bonus' ? Number(bonusWallet?.balance || 0)
    : Number((balances.find((b) => b.accountId === from && b.currency === currency))?.free || 0);
  const overBudget = Number(amount) > free;
  const subOnlyUsd = (isSpecial(from) || isSpecial(to)) && currency !== 'USD';
  const invalid = !from || !to || from === to || !amount || Number(amount) <= 0 || overBudget || subOnlyUsd;

  const submit = async () => {
    if (invalid) return;
    setBusy(true);
    try {
      await api.post('/wallet/transfers', { fromAccountId: from, toAccountId: to, currency, amount });
      Alert.alert('Done', 'Transfer completed.');
      setAmount('');
      reload();
    } catch (e) { Alert.alert('Transfer failed', errorMessage(e)); }
    finally { setBusy(false); }
  };

  return (
    <Card style={{ gap: 12 }}>
      <View>
        <Text style={styles.fieldLbl}>From</Text>
        <Picker styles={styles} c={c} value={from} options={options} onChange={(v) => { setFrom(v); if (isSpecial(v)) setCurrency('USD'); }} />
        <Text style={[styles.txSub, { marginTop: 6 }]}>{isSpecial(from) ? 'Balance' : 'Free'}: <Text style={{ color: c.bull, fontWeight: '700' }}>{currencySymbol(isSpecial(from) ? 'USD' : currency)}{fmtNum(free, 2)}</Text></Text>
      </View>
      <View>
        <Text style={styles.fieldLbl}>To</Text>
        <Picker styles={styles} c={c} value={to} options={options} onChange={(v) => { setTo(v); if (isSpecial(v)) setCurrency('USD'); }} />
      </View>
      <View>
        <Text style={styles.fieldLbl}>Currency</Text>
        <CcyPicker styles={styles} c={c} value={currency} options={['USD', 'EUR', 'GBP', 'INR']} onChange={setCurrency} />
      </View>
      <View>
        <Text style={styles.fieldLbl}>Amount</Text>
        <TextInput value={amount} onChangeText={setAmount} placeholder="0.00" placeholderTextColor={c.textMuted} keyboardType="decimal-pad" style={[styles.input, { marginTop: 6 }, overBudget && { borderColor: c.bear }]} />
        {overBudget && <Text style={styles.errText}>Exceeds source account balance</Text>}
        {from === to && from ? <Text style={styles.errText}>Source and destination must differ</Text> : null}
        {subOnlyUsd && <Text style={[styles.txSub, { color: c.warn }]}>Main / Bonus Wallet transfers must be in USD</Text>}
      </View>
      <Button title="Transfer" onPress={submit} loading={busy} disabled={invalid} />
    </Card>
  );
}

function UserTransfer({ styles, c, accounts, balances, subWallet, reload }) {
  const fromOptions = useMemo(() => [...accounts.map((a) => ({ _id: a._id, nickname: `${a.nickname || a.accountNumber} · ${tierLabel(a)}` })), { _id: 'subscription', nickname: 'Main Wallet · USD' }], [accounts]);
  const [fromAccountId, setFromAccountId] = useState(accounts[0]?._id || 'subscription');
  const [currency, setCurrency] = useState(accounts[0]?.baseCurrency || 'USD');
  const isMainFrom = fromAccountId === 'subscription';
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [recipient, setRecipient] = useState(null);
  const [cfg, setCfg] = useState({ enabled: true, min: '0', max: '0', feePercent: '0' });
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.get('/wallet/transfer-user/settings').then((r) => setCfg(r.data?.data || cfg)).catch(() => {}); }, []);

  useEffect(() => {
    const q = query.trim();
    if (recipient) return;
    if (q.length < 2) { setResults([]); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      api.get('/wallet/recipients/search', { params: { q, limit: 8, by: 'uid' } })
        .then((r) => { if (!cancelled) setResults(r.data?.data || []); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, recipient]);

  const free = isMainFrom ? Number(subWallet?.balance || 0) : Number(balances.find((b) => b.accountId === fromAccountId && b.currency === currency)?.free || 0);
  const amt = Number(amount) || 0;
  const feePct = Number(cfg.feePercent) || 0;
  const feeAmt = feePct > 0 ? amt * (feePct / 100) : 0;
  const total = amt + feeAmt;
  const overBudget = total > free;
  const min = Number(cfg.min || 0), max = Number(cfg.max || 0);
  const belowMin = min > 0 && amt > 0 && amt < min;
  const aboveMax = max > 0 && amt > max;
  const canSend = !!recipient && amt > 0 && !overBudget && !belowMin && !aboveMax && cfg.enabled !== false;

  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      await api.post('/wallet/transfer-user', { fromAccountId, currency, amount: String(amt), note: note?.trim() || undefined, recipientUserId: recipient._id });
      Alert.alert('Sent', `Sent ${amt} ${currency} to ${recipient.name}`);
      setAmount(''); setNote(''); setRecipient(null); setQuery('');
      reload();
    } catch (e) { Alert.alert('Transfer failed', errorMessage(e)); }
    finally { setBusy(false); }
  };

  if (cfg.enabled === false) {
    return <Card><Text style={styles.h3}>Peer transfers are currently disabled</Text><Text style={[styles.txSub, { marginTop: 4 }]}>User-to-user transfers have been turned off by the administrator.</Text></Card>;
  }

  return (
    <Card style={{ gap: 12 }}>
      <View>
        <Text style={styles.fieldLbl}>From account</Text>
        <Picker styles={styles} c={c} value={fromAccountId} options={fromOptions} onChange={(v) => { setFromAccountId(v); if (v === 'subscription') setCurrency('USD'); }} />
        <Text style={[styles.txSub, { marginTop: 6 }]}>{isMainFrom ? 'Balance' : 'Free'}: <Text style={{ color: c.bull, fontWeight: '700' }}>{currencySymbol(isMainFrom ? 'USD' : currency)}{fmtNum(free, 2)}</Text></Text>
      </View>
      {!isMainFrom && (
        <View>
          <Text style={styles.fieldLbl}>Currency</Text>
          <CcyPicker styles={styles} c={c} value={currency} options={['USD', 'EUR', 'GBP', 'INR']} onChange={setCurrency} />
        </View>
      )}
      <View>
        <Text style={styles.fieldLbl}>Recipient</Text>
        {recipient ? (
          <Row style={[styles.recipientCard, { borderColor: c.primary400, backgroundColor: c.primarySoft }]}>
            <View style={styles.recipAvatar}><Text style={styles.recipAvatarTxt}>{initials(recipient)}</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.methodLabel}>{recipient.name}</Text>
              <Text style={styles.txSub}>{recipient.userUid || recipient.email}</Text>
            </View>
            <TouchableOpacity onPress={() => { setRecipient(null); setQuery(''); setResults([]); }}><Text style={[styles.link, { color: c.bear }]}>Change</Text></TouchableOpacity>
          </Row>
        ) : (
          <>
            <TextInput value={query} onChangeText={setQuery} placeholder="Enter recipient's User ID (e.g. USR100245)" placeholderTextColor={c.textMuted} autoCapitalize="characters" style={[styles.input, { marginTop: 6 }]} />
            {(searching || results.length > 0) && (
              <View style={styles.resultsBox}>
                {searching && results.length === 0 ? <Text style={[styles.txSub, { padding: 10 }]}>Searching…</Text> : results.map((u) => (
                  <TouchableOpacity key={u._id} onPress={() => { setRecipient(u); setResults([]); }} style={styles.resultRow}>
                    <View style={styles.recipAvatar}><Text style={styles.recipAvatarTxt}>{initials(u)}</Text></View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.methodLabel}>{u.name}</Text>
                      <Text style={styles.txSub}>{u.userUid || u.email}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
                {!searching && results.length === 0 && query.trim().length >= 2 ? <Text style={[styles.txSub, { padding: 10 }]}>No users found.</Text> : null}
              </View>
            )}
          </>
        )}
      </View>
      <View>
        <Text style={styles.fieldLbl}>Amount</Text>
        <TextInput value={amount} onChangeText={setAmount} placeholder="0.00" placeholderTextColor={c.textMuted} keyboardType="decimal-pad" style={[styles.input, { marginTop: 6 }, (overBudget || belowMin || aboveMax) && { borderColor: c.bear }]} />
        <Text style={[styles.txSub, { marginTop: 4 }]}>
          {min > 0 ? `Min ${currencySymbol(currency)}${fmtNum(min, 2)} ` : ''}{max > 0 ? `· Max ${currencySymbol(currency)}${fmtNum(max, 2)} ` : ''}{feePct > 0 ? `· Fee ${feePct}%` : ''}
        </Text>
        {overBudget && <Text style={styles.errText}>Exceeds free balance</Text>}
        {belowMin && <Text style={styles.errText}>Below minimum transfer amount</Text>}
        {aboveMax && <Text style={styles.errText}>Above maximum transfer amount</Text>}
      </View>
      <Field styles={styles} c={c} label="Note (optional)" value={note} onChangeText={setNote} placeholder="Visible to recipient" maxLength={120} />
      {feeAmt > 0 && amt > 0 ? (
        <View style={styles.summaryBox}>
          <ReviewRow styles={styles} l="You send" v={`${currencySymbol(currency)}${fmtNum(amt, 2)}`} />
          <ReviewRow styles={styles} l={`Fee (${feePct}%)`} v={`${currencySymbol(currency)}${fmtNum(feeAmt, 2)}`} />
          <ReviewRow styles={styles} l="Total debit" v={`${currencySymbol(currency)}${fmtNum(total, 2)}`} />
        </View>
      ) : null}
      <Button title="Send" onPress={submit} loading={busy} disabled={!canSend} />
    </Card>
  );
}

function initials(user) {
  return String(user?.name || user?.email || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('') || '?';
}

function Picker({ styles, c, value, options, onChange }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 6 }}>
      {options.map((o) => {
        const sel = o._id === value;
        return (
          <TouchableOpacity key={o._id} onPress={() => onChange(o._id)} style={[styles.pickerOpt, sel && { borderColor: c.primary400, backgroundColor: c.primarySoft }]}>
            <Text style={[styles.pickerOptTxt, sel && { color: c.primary500 }]}>{o.nickname}</Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

/* ─────────────────────────── History ─────────────────────────── */
const HISTORY_FILTERS = ['All', 'Deposit', 'Withdrawal', 'Transfer', 'Trade', 'Fee'];

function normalizeRow(x, kind) {
  if (kind === 'deposit') return { id: String(x._id || x.id), kind, date: x.createdAt, amount: Number(x.amount || 0), currency: x.currency || 'USD', status: x.status || 'PENDING', type: 'Deposit', method: methodLabel(x.method), category: 'Deposit', baseEq: baseEquivalent(x, 1) };
  if (kind === 'withdraw') return { id: String(x._id || x.id), kind, date: x.createdAt, amount: -Math.abs(Number(x.amount || 0)), currency: x.currency || 'USD', status: x.status || 'PENDING', type: 'Withdrawal', method: methodLabel(x.method), category: 'Withdrawal', baseEq: baseEquivalent(x, -1) };
  const t = x.type;
  const label = LEDGER_LABEL[t] || t || 'Other';
  const cat = (t === 'TRADE_OPEN' || t === 'TRADE_CLOSE') ? 'Trade'
    : (t === 'FEE') ? 'Fee'
    : (t === 'TRANSFER' || t === 'INTERNAL_TRANSFER_OUT' || t === 'INTERNAL_TRANSFER_IN') ? 'Transfer' : 'Other';
  // Trade/fee rows carry the position they belong to; show the same ticket the
  // web history and the trade screen use so a row can be traced to its order.
  return { id: String(x._id || x.id), kind: 'ledger', date: x.createdAt, amount: Number(x.amount || 0), currency: x.currency || 'USD', status: 'COMPLETED', type: label, method: cat === 'Transfer' ? 'Internal' : 'System', category: cat, ticket: x.referenceId ? `#${String(x.referenceId).slice(-6).toUpperCase()}` : null };
}
const LEDGER_LABEL = { TRADE_OPEN: 'Trade Open', TRADE_CLOSE: 'Trade Close', FEE: 'Fee', ADJUSTMENT: 'Adjustment', TRANSFER: 'Internal Transfer', INTERNAL_TRANSFER_OUT: 'Transfer Sent', INTERNAL_TRANSFER_IN: 'Transfer Received', CONVERSION: 'Conversion' };
// A deposit/withdrawal can be denominated in INR or USDT while the wallet it
// moves is USD, so "+USDT 200.00" alone never says what actually landed. The
// backend already stores the converted figure (baseAmount/baseCurrency).
// Mirrors baseEquivalent() in client/src/components/TransactionHistory.jsx.
const BASE_CURRENCY = 'USD';
function baseEquivalent(doc, sign) {
  const base = Number(doc && doc.baseAmount);
  if (!Number.isFinite(base) || base === 0) return null;
  const currency = (doc && doc.baseCurrency) || BASE_CURRENCY;
  if (currency === (doc && doc.currency)) return null;
  return { currency, amount: sign * Math.abs(base) };
}

function methodLabel(m) { return ({ UPI: 'UPI', BANK: 'Bank Transfer', CRYPTO: 'Crypto', CARD: 'Card', RAZORPAY: 'Razorpay', DEMO: 'Wallet Balance', MANUAL: 'Manual' }[String(m || '').toUpperCase()] || (m ? String(m) : 'System')); }

function HistoryView({ styles, c, deposits, withdrawals, ledger }) {
  const [filter, setFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(20);

  const rows = useMemo(() => {
    const d = deposits.map((x) => normalizeRow(x, 'deposit'));
    const w = withdrawals.map((x) => normalizeRow(x, 'withdraw'));
    const l = ledger.filter((e) => e.type !== 'DEPOSIT' && e.type !== 'WITHDRAWAL').map((x) => normalizeRow(x, 'ledger'));
    return [...d, ...w, ...l].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  }, [deposits, withdrawals, ledger]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== 'All' && r.category !== filter) return false;
      if (q) {
        const hay = `${r.type} ${r.method} ${r.status} ${r.currency}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, filter, search]);

  const shown = filtered.slice(0, limit);

  return (
    <View style={{ gap: 12 }}>
      <View>
        <Text style={styles.h1}>Transaction History</Text>
        <Text style={styles.pSub}>View all your transactions in one place</Text>
      </View>
      <Row style={[styles.input, { alignItems: 'center', gap: 8 }]}>
        <Ionicons name="search" size={16} color={c.textMuted} />
        <TextInput value={search} onChangeText={setSearch} placeholder="Search by type, method…" placeholderTextColor={c.textMuted} style={{ flex: 1, color: c.textPrimary, padding: 0 }} />
      </Row>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {HISTORY_FILTERS.map((f) => (
          <TouchableOpacity key={f} onPress={() => { setFilter(f); setLimit(20); }} style={[styles.menuPill, filter === f && { backgroundColor: c.primarySoft, borderColor: c.primary500 }]}>
            <Text style={[styles.menuText, filter === f && { color: c.primary500, fontWeight: '800' }]}>{f}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <Card style={{ padding: 0 }}>
        {shown.length === 0 ? (
          <Text style={styles.emptyRow}>No transactions match your filters</Text>
        ) : shown.map((r) => {
          const pos = r.amount > 0, neg = r.amount < 0;
          const color = pos ? c.bull : neg ? c.bear : c.textSecondary;
          return (
            <Row key={`${r.kind}-${r.id}`} style={{ justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderSubtle }}>
              <View style={{ flex: 1 }}>
                <Text style={styles.txTitle}>{r.type}</Text>
                <Text style={styles.txSub}>{fmtDateTime(r.date)} · {r.method}{r.ticket ? ` · order ${r.ticket}` : ''}</Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}>
                <Text style={[styles.txAmt, { color }]}>{pos ? '+' : neg ? '-' : ''}{currencySymbol(r.currency)}{fmtNum(Math.abs(r.amount), 2)}</Text>
                {r.baseEq ? (
                  <Text style={styles.txSub}>≈ {pos ? '+' : neg ? '-' : ''}{currencySymbol(r.baseEq.currency)}{fmtNum(Math.abs(r.baseEq.amount), 2)}</Text>
                ) : null}
                <StatusPill styles={styles} c={c} status={r.status} />
              </View>
            </Row>
          );
        })}
        {filtered.length > limit ? (
          <TouchableOpacity onPress={() => setLimit(limit + 20)} style={{ padding: 14, alignItems: 'center' }}>
            <Text style={styles.link}>Load more ({filtered.length - limit} more)</Text>
          </TouchableOpacity>
        ) : null}
      </Card>
    </View>
  );
}

/* ─────────────────────────── Details ─────────────────────────── */
function DetailsView({ styles, c, navigation, user, accounts, balances, fxRate, reload, setView }) {
  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Trader';
  const kyc = user?.kycStatus || 'NOT_STARTED';
  const kycMeta = kyc === 'APPROVED' ? { tint: c.bull, label: 'Verified' } : kyc === 'PENDING' ? { tint: c.primary400, label: 'Under Review' } : { tint: c.bear, label: 'Not verified' };

  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);
  const [overrides, setOverrides] = useState({});

  const saveName = async (a) => {
    const name = editName.replace(/\s+/g, ' ').trim();
    if (!name) { Alert.alert('Nickname', 'Nickname cannot be empty'); return; }
    if (name.length > 40) { Alert.alert('Nickname', 'Nickname too long (max 40)'); return; }
    setSaving(true);
    try {
      await api.patch(`/user/accounts/${a._id}`, { nickname: name });
      setOverrides((m) => ({ ...m, [a._id]: name }));
      setEditingId(null); setEditName('');
      reload();
    } catch (e) { Alert.alert('Rename failed', errorMessage(e)); }
    finally { setSaving(false); }
  };

  return (
    <View style={{ gap: 12 }}>
      <View>
        <Text style={styles.h1}>Account Details</Text>
        <Text style={styles.pSub}>Profile, trading accounts, KYC status and security.</Text>
      </View>

      <Card>
        <Row style={{ gap: 12, alignItems: 'center' }}>
          <View style={[styles.bigAvatar, { backgroundColor: c.primary400 }]}><Text style={styles.bigAvatarTxt}>{fullName.split(' ').map((s) => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()}</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.h3}>{fullName}</Text>
            <Text style={styles.txSub} numberOfLines={1}>{user?.email || '—'}</Text>
            <View style={[styles.badge, { backgroundColor: kycMeta.tint + '22', marginTop: 6 }]}><Text style={[styles.badgeTxt, { color: kycMeta.tint }]}>KYC · {kycMeta.label}</Text></View>
          </View>
        </Row>
      </Card>

      <Card style={{ gap: 10 }}>
        <SectionTitle styles={styles} right={<TouchableOpacity onPress={() => setView('transfer')}><Text style={styles.link}>Transfer funds ›</Text></TouchableOpacity>}>Trading Accounts ({accounts.length})</SectionTitle>
        {accounts.length === 0 ? (
          <Text style={styles.emptyRow}>No accounts yet</Text>
        ) : accounts.map((a) => {
          const real = REAL(a.accountType);
          const displayName = overrides[a._id] ?? (a.nickname || a.accountNumber);
          const editing = editingId === a._id;
          let inr = 0, usd = 0;
          for (const b of balances) {
            if (b.accountId !== a._id) continue;
            const v = Number(b.balance) || 0;
            if (b.currency === 'INR') { inr += v; usd += v / rate; }
            else { usd += v; inr += v * rate; }
          }
          return (
            <View key={a._id} style={styles.detailAcct}>
              <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                {editing ? (
                  <Row style={{ flex: 1, gap: 6, alignItems: 'center' }}>
                    <TextInput autoFocus value={editName} onChangeText={setEditName} maxLength={40} placeholder="Account name" placeholderTextColor={c.textMuted} style={[styles.input, { flex: 1, height: 40, marginTop: 0 }]} />
                    <TouchableOpacity onPress={() => saveName(a)} disabled={saving}><Ionicons name="checkmark" size={20} color={c.bull} /></TouchableOpacity>
                    <TouchableOpacity onPress={() => { setEditingId(null); setEditName(''); }}><Ionicons name="close" size={20} color={c.textMuted} /></TouchableOpacity>
                  </Row>
                ) : (
                  <Row style={{ gap: 6, alignItems: 'center', flex: 1 }}>
                    <Text style={styles.methodLabel} numberOfLines={1}>{displayName}</Text>
                    <TouchableOpacity onPress={() => { setEditingId(a._id); setEditName(displayName || ''); }}><Ionicons name="create-outline" size={15} color={c.textMuted} /></TouchableOpacity>
                  </Row>
                )}
                <View style={[styles.badge, { backgroundColor: (real ? c.bull : c.info) + '22' }]}><Text style={[styles.badgeTxt, { color: real ? c.bull : c.info }]}>{real ? 'Live · Real' : a.accountType}</Text></View>
              </Row>
              <Text style={styles.acctNum}>{a.accountNumber}</Text>
              <Row style={{ gap: 8, marginTop: 8 }}>
                <MiniStat styles={styles} c={c} small label="INR" value={`₹${fmtNum(inr, 2)}`} tone={c.textPrimary} />
                <MiniStat styles={styles} c={c} small label="USD" value={`$${fmtNum(usd, 2)}`} tone={c.textPrimary} />
              </Row>
              <Row style={{ gap: 8, marginTop: 8 }}>
                <MiniStat styles={styles} c={c} small label="Type" value={tierLabel(a)} tone={c.textPrimary} />
                <MiniStat styles={styles} c={c} small label="Leverage" value={`1:${a.leverage}`} tone={c.textPrimary} />
              </Row>
            </View>
          );
        })}
      </Card>

      <TouchableOpacity onPress={() => navigation.navigate('Plans')}>
        <Card>
          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Row style={{ gap: 12, flex: 1 }}>
              <View style={[styles.walletIcon, { backgroundColor: c.primary400 }]}><Ionicons name="card-outline" size={20} color="#fff" /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.h3}>Main Wallet</Text>
                <Text style={styles.txSub}>Separate balance for plan purchases & renewals.</Text>
              </View>
            </Row>
            <Ionicons name="chevron-forward" size={18} color={c.primary500} />
          </Row>
        </Card>
      </TouchableOpacity>

      <TouchableOpacity onPress={() => setView('bonus')}>
        <Card>
          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Row style={{ gap: 12, flex: 1 }}>
              <View style={[styles.walletIcon, { backgroundColor: c.bull }]}><Ionicons name="gift-outline" size={20} color="#fff" /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.h3}>Bonus Wallet</Text>
                <Text style={styles.txSub}>Referral & partner earnings, credited automatically.</Text>
              </View>
            </Row>
            <Ionicons name="chevron-forward" size={18} color={c.bull} />
          </Row>
        </Card>
      </TouchableOpacity>

      <Card style={{ gap: 10 }}>
        <Text style={styles.h3}>Security</Text>
        <Row style={{ justifyContent: 'space-between' }}><Text style={styles.txTitle}>Two-Factor Authentication</Text><StatusPill styles={styles} c={c} status={user?.twoFactorEnabled ? 'APPROVED' : 'REJECTED'} /></Row>
        <Row style={{ justifyContent: 'space-between' }}><Text style={styles.txTitle}>Login alerts</Text><StatusPill styles={styles} c={c} status="APPROVED" /></Row>
      </Card>

      <Card style={{ gap: 10 }}>
        <Text style={styles.h3}>Profile</Text>
        <Row style={{ justifyContent: 'space-between' }}><Text style={styles.txTitle}>Name</Text><Text style={styles.payVal}>{fullName}</Text></Row>
        <Row style={{ justifyContent: 'space-between' }}><Text style={styles.txTitle}>Email</Text><Text style={styles.payVal} numberOfLines={1}>{user?.email || '—'}</Text></Row>
        <Row style={{ justifyContent: 'space-between' }}><Text style={styles.txTitle}>Phone</Text><Text style={styles.payVal}>{user?.phone || '—'}</Text></Row>
      </Card>
    </View>
  );
}

/* ─────────────────────────── Bonus ─────────────────────────── */
function BonusView({ styles, c, fxRate, setView }) {
  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
  // USD-primary, normalising an INR-denominated bonus wallet into dollars.
  // This rendered rupees only — including for a USD wallet, which it converted
  // up — so a $50 bonus balance read "₹4,150" with no dollar figure anywhere.
  const money = (v, cur) => `$${fmtNum(cur === 'INR' && rate > 0 ? Number(v || 0) / rate : Number(v || 0), 2)}`;
  const [bonus, setBonus] = useState(null);
  const [partner, setPartner] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [b, p] = await Promise.allSettled([api.get('/bonus-wallet'), api.get('/partner/volume-dashboard')]);
      if (b.status === 'fulfilled') setBonus(b.value.data?.data || null);
      if (p.status === 'fulfilled') setPartner(p.value.data?.data || null);
      setLoading(false);
    })();
  }, []);

  if (loading) return <Loader label="Loading bonus wallet…" />;

  return (
    <View style={{ gap: 12 }}>
      <View>
        <Text style={styles.h1}>Bonus Wallet</Text>
        <Text style={styles.pSub}>Referral & partner earnings. Transfer out to spend — no direct withdrawal.</Text>
      </View>
      <Card>
        <Row style={{ gap: 12 }}>
          <View style={[styles.walletIcon, { backgroundColor: '#8B5CF6' }]}><Ionicons name="gift" size={22} color="#fff" /></View>
          <View>
            <Text style={styles.h3}>Referral / IB Wallet</Text>
            <Text style={styles.bigMoney}>{money(bonus?.balance, bonus?.currency)}</Text>
            <Text style={styles.tiny}>Available Balance</Text>
          </View>
        </Row>
        <Row style={{ gap: 8, marginTop: 12 }}>
          <MiniStat styles={styles} c={c} small label="Lifetime" value={money(bonus?.totalEarnings ?? partner?.totalCommissionEarned, bonus?.currency)} tone={c.bull} />
          <MiniStat styles={styles} c={c} small label="Withdrawn" value={money(partner?.paidCommission, partner?.walletCurrency)} tone={c.bear} />
          <MiniStat styles={styles} c={c} small label="This Month" value={money(partner?.monthlyCommission, partner?.walletCurrency)} tone={c.textPrimary} />
        </Row>
      </Card>
      <Button title="Transfer bonus out" onPress={() => setView('transfer')} />
    </View>
  );
}

/* ─────────────────────────── helpers ─────────────────────────── */
function fmtDateTime(d) {
  if (!d) return '-';
  try {
    return new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).replace(/\b(am|pm)\b/i, (x) => x.toUpperCase());
  } catch { return '-'; }
}

const makeStyles = (c) => StyleSheet.create({
  h1: { fontSize: 22, fontWeight: '900', color: c.textPrimary },
  h2: { fontSize: 17, fontWeight: '800', color: c.textPrimary },
  h3: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
  pSub: { fontSize: 13, color: c.textSecondary, marginTop: 2 },
  kicker: { fontSize: 10, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  tiny: { fontSize: 11, color: c.textMuted, marginTop: 1 },
  bigMoney: { fontSize: 22, fontWeight: '900', color: c.textPrimary, marginTop: 2, fontVariant: ['tabular-nums'] },
  moneySub: { fontSize: 11, color: c.textMuted, marginTop: 1, fontVariant: ['tabular-nums'] },
  link: { fontSize: 12, fontWeight: '700', color: c.primary500 },
  emptyRow: { padding: 24, textAlign: 'center', color: c.textMuted, fontSize: 13 },

  menuPill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: c.border, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: c.card },
  menuText: { fontSize: 13, fontWeight: '700', color: c.textSecondary },

  quickAction: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderRadius: radius.md, paddingVertical: 11 },
  quickActionTxt: { fontSize: 13, fontWeight: '800' },

  txIcon: { width: 32, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  txTitle: { fontSize: 13, fontWeight: '700', color: c.textPrimary },
  txSub: { fontSize: 11, color: c.textMuted, marginTop: 1 },
  txAmt: { fontSize: 14, fontWeight: '800', color: c.textPrimary, fontVariant: ['tabular-nums'] },

  breakIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  tag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, alignSelf: 'flex-start' },
  tagTxt: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4 },
  walletIcon: { width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },

  miniStat: { flex: 1, backgroundColor: c.hover, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 8 },
  miniStatVal: { fontSize: 14, fontWeight: '800', marginTop: 2, fontVariant: ['tabular-nums'] },
  miniStatValSm: { fontSize: 12, fontWeight: '800', marginTop: 2, fontVariant: ['tabular-nums'] },

  tileGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  tile: { width: '48%', backgroundColor: c.hover, borderRadius: radius.lg, padding: 12, borderWidth: 1, borderColor: c.borderSubtle },
  tileIcon: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  tileVal: { fontSize: 16, fontWeight: '900', color: c.textPrimary, fontVariant: ['tabular-nums'] },

  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  kpiCard: { width: '48%', backgroundColor: c.card, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, padding: 14 },
  kpiVal: { fontSize: 20, fontWeight: '900', color: c.textPrimary, marginTop: 8, fontVariant: ['tabular-nums'] },
  kpiLabel: { fontSize: 12, fontWeight: '700', color: c.textSecondary, marginTop: 2 },

  rangePill: { borderWidth: 1, borderColor: c.border, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: c.card },
  rangePillTxt: { fontSize: 11, fontWeight: '700', color: c.textSecondary },

  stepDot: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  stepNum: { fontSize: 12, fontWeight: '800', color: c.textMuted },
  stepLabel: { fontSize: 10, color: c.textMuted, marginTop: 4, fontWeight: '600' },

  acctCard: { borderWidth: 2, borderColor: c.border, borderRadius: radius.xl, padding: 14, backgroundColor: c.card },
  avatar: { width: 42, height: 42, borderRadius: 12, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { fontSize: 13, fontWeight: '900', color: c.primary500 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  acctName: { fontSize: 15, fontWeight: '800', color: c.textPrimary, flexShrink: 1 },
  acctNum: { fontSize: 11, color: c.textMuted, marginTop: 2, fontVariant: ['tabular-nums'] },
  acctBal: { fontSize: 18, fontWeight: '900', color: c.textPrimary, fontVariant: ['tabular-nums'] },
  acctSub: { fontSize: 11, color: c.textMuted, marginTop: 1 },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, alignSelf: 'flex-start' },
  badgeTxt: { fontSize: 9, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4 },
  ccyChip: { backgroundColor: c.hover, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  ccyChipTxt: { fontSize: 10, fontWeight: '800', color: c.textSecondary },

  methodCard: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 2, borderColor: c.border, borderRadius: radius.lg, padding: 12, backgroundColor: c.card },
  methodLabel: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
  payBox: { borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: 12, backgroundColor: c.hover },
  payVal: { fontSize: 13, fontWeight: '700', color: c.textPrimary, flexShrink: 1, textAlign: 'right' },
  qr: { width: 120, height: 120, alignSelf: 'center', marginTop: 8, borderRadius: 8, backgroundColor: '#fff' },

  dropzone: { height: 150, borderWidth: 1.5, borderStyle: 'dashed', borderColor: c.border, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: c.hover },
  preview: { width: '100%', height: '100%' },
  preset: { borderWidth: 2, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, alignItems: 'center' },
  presetTxt: { fontSize: 13, fontWeight: '800', color: c.textPrimary },
  cur: { fontSize: 17, fontWeight: '800', color: c.textMuted, marginRight: 6 },
  summaryBox: { backgroundColor: c.hover, borderRadius: radius.lg, padding: 12, gap: 6, borderWidth: 1, borderColor: c.borderSubtle },
  errText: { fontSize: 11, color: c.bear, fontWeight: '700', marginTop: 6 },
  maxBtn: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 6 },

  fieldLbl: { fontSize: 11, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 },
  input: { minHeight: 48, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: c.textPrimary, backgroundColor: c.card },
  ccyOpt: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 12, backgroundColor: c.card },
  ccyOptTxt: { fontSize: 12, fontWeight: '800', color: c.textSecondary },

  ghostBtn: { flex: 1, height: 48, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
  ghostBtnTxt: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
  primaryBtn: { flex: 1.4, height: 48, borderRadius: radius.md, backgroundColor: c.primary400, alignItems: 'center', justifyContent: 'center' },
  primaryBtnTxt: { fontSize: 14, fontWeight: '800', color: '#fff' },

  tabBtn: { flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingVertical: 10, alignItems: 'center', backgroundColor: c.card },
  tabBtnTxt: { fontSize: 12, fontWeight: '700', color: c.textSecondary },

  pickerOpt: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: c.card },
  pickerOptTxt: { fontSize: 12, fontWeight: '700', color: c.textSecondary },

  recipientCard: { alignItems: 'center', gap: 10, borderWidth: 2, borderRadius: radius.md, padding: 10, marginTop: 6 },
  recipAvatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: c.primary400, alignItems: 'center', justifyContent: 'center' },
  recipAvatarTxt: { color: '#fff', fontWeight: '800', fontSize: 13 },
  resultsBox: { marginTop: 6, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, backgroundColor: c.card, overflow: 'hidden' },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderSubtle },

  detailAcct: { borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: 12, backgroundColor: c.card },
  bigAvatar: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  bigAvatarTxt: { color: '#fff', fontWeight: '900', fontSize: 18 },
});
