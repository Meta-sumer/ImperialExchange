import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, Switch, Modal,
  ActivityIndicator, Alert, RefreshControl, AppState, Dimensions, StyleSheet,
} from 'react-native';
import Svg, { Polyline, Polygon, Line, Rect } from 'react-native-svg';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { useColors, radius, fmtNum } from '../theme';
import { Loader } from '../components/ui';

/**
 * CopyScreen — native port of the web Copy Trading hub (client/src/pages/
 * CopyTrade.jsx). Mirrors it section-for-section, in the same order the web
 * shows on mobile:
 *   1. Hero            — "Become a master trader" → BecomeMaster sheet
 *   2. My copy boxes   — one per source trading account (or empty CTA)
 *   3. Archived boxes  — collapsible, restore-only history
 *   4. Tab strip       — Discover / Feed / My Copies (drives the section below)
 *   5. Leaderboard     — search + risk filter + sort, trader cards w/ badges
 *   6. Live feed       — activity stream
 *   7. My copies       — rows w/ running P/L + Pause/Resume/Edit/Stop/Analytics
 *
 * Same backend endpoints as the web. The web's <table>/modals become native
 * Card rows + <Modal> bottom-sheets. Running P/L polls every 6s (mirrors the
 * web) and refreshes on `copytrading` WS events (where the web subscribes).
 */

// ── Constants (mirror the web) ───────────────────────────────────────────
const COPY_STATUS_RANK = { ACTIVE: 0, PAUSED: 1, STOPPED: 2 };
const TABS = [
  { id: 'discover', label: 'Discover' },
  { id: 'feed', label: 'Feed' },
  { id: 'mine', label: 'My Copies' },
];
const RISK_FILTERS = [
  { id: 'ALL', label: 'All risk' }, { id: 'LOW', label: 'Low' },
  { id: 'MEDIUM', label: 'Medium' }, { id: 'HIGH', label: 'High' },
];
const SORTS = [
  { id: 'roi', label: 'ROI' }, { id: 'newest', label: 'Newest' },
  { id: 'followers', label: 'Followers' }, { id: 'winRate', label: 'Win rate' },
  { id: 'trades', label: 'Trades' },
];
const RISK_BADGES = [{ id: 'LOW', label: 'Low' }, { id: 'MEDIUM', label: 'Medium' }, { id: 'HIGH', label: 'High' }];
const LOT_MODES = [
  { id: 'LOW', label: 'Low', note: '0.5× master lot' },
  { id: 'MEDIUM', label: 'Medium', note: '1× master lot' },
  { id: 'HIGH', label: 'High', note: '1.5× master lot' },
  { id: 'CUSTOM', label: 'Custom', note: 'Fixed lot' },
];
const ANALYTICS_PRESETS = [
  { id: 'all', label: 'All' }, { id: '7d', label: '7D' }, { id: '30d', label: '30D' }, { id: '90d', label: '90D' },
];

// ── Pure helpers (module scope — no `styles`/`c` here) ────────────────────
const symOf = (cur = 'USD') => ({ USD: '$', INR: '₹', EUR: '€', GBP: '£', JPY: '¥' }[cur] || `${cur} `);
const money = (n, cur = 'USD') => `${Number(n) < 0 ? '-' : ''}${symOf(cur)}${Math.abs(Number(n || 0)).toFixed(2)}`;
const pct = (n) => `${Number(n || 0).toFixed(1)}%`;
const riskToneKey = (risk) => (risk === 'LOW' ? 'bull' : risk === 'HIGH' ? 'bear' : 'warn');
const statusToneKey = (s) => (s === 'ACTIVE' ? 'bull' : s === 'PAUSED' ? 'warn' : 'muted');

function formatElapsed(ms) {
  if (ms < 60000) return `${Math.max(1, Math.floor(ms / 1000))}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

// Award leaderboard badges to standout traders (keyed by profile _id, ≤1 each).
function computeBadges(leaders) {
  const map = {};
  if (!leaders.length) return map;
  const add = (t, badge) => { if (t && !map[t._id]) map[t._id] = badge; };
  const byRoi = [...leaders].sort((a, b) => Number(b.roiPct || 0) - Number(a.roiPct || 0));
  const byFollowers = [...leaders].sort((a, b) => Number(b.followers || 0) - Number(a.followers || 0));
  const byWin = [...leaders].sort((a, b) => Number(b.winRate || 0) - Number(a.winRate || 0));
  add(byRoi[0], { icon: '🏆', label: 'Top Trader' });
  add(byFollowers[0], { icon: '🔥', label: 'Most Followed' });
  add(byRoi.find((t) => Number(t.followers || 0) >= 100 && Number(t.roiPct || 0) >= 50), { icon: '💎', label: 'Elite' });
  add(byWin.find((t) => Number(t.winRate || 0) >= 55 && Number(t.followers || 0) < 50), { icon: '⭐', label: 'Rising Star' });
  return map;
}

// Build the copy API payload from a settings object (shared by copy + edit).
function settingsPayload(s) {
  return {
    lotMode: s.lotMode,
    customLot: s.lotMode === 'CUSTOM' ? Number(s.customLot) : undefined,
    maxLot: s.maxLot === '' || s.maxLot == null ? undefined : Number(s.maxLot),
    copySL: !!s.copySL,
    copyTP: !!s.copyTP,
    copyPending: !!s.copyPending,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Screen
// ═══════════════════════════════════════════════════════════════════════════
export default function CopyScreen({ navigation }) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);

  const [tab, setTab] = useState('discover');
  const [leaders, setLeaders] = useState(null);
  const [feed, setFeed] = useState([]);
  const [mine, setMine] = useState([]);
  const [myBoxes, setMyBoxes] = useState([]);
  const [archivedBoxes, setArchivedBoxes] = useState([]);
  const [myProfile, setMyProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Discover filters
  const [q, setQ] = useState('');
  const [riskFilter, setRiskFilter] = useState('ALL');
  const [sortBy, setSortBy] = useState('roi');
  // My-copies search
  const [mineQ, setMineQ] = useState('');

  // Sheets / modals
  const [becomeMaster, setBecomeMaster] = useState(false);
  const [editingBox, setEditingBox] = useState(null);
  const [editRel, setEditRel] = useState(null);
  const [stopRel, setStopRel] = useState(null);
  const [analyticsRel, setAnalyticsRel] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [lb, fd, mc, mp, bx, ar] = await Promise.allSettled([
        api.get('/copy-trading/leaderboard', { params: { limit: 50 } }),
        api.get('/copy-trading/feed', { params: { limit: 50 } }),
        api.get('/copy-trading/my-copies'),
        api.get('/copy-trading/profile/me'),
        api.get('/copy-trading/boxes/me'),
        api.get('/copy-trading/boxes/archived'),
      ]);
      if (lb.status === 'fulfilled') setLeaders(lb.value.data?.data || []);
      if (fd.status === 'fulfilled') setFeed(fd.value.data?.data || []);
      if (mc.status === 'fulfilled') setMine(mc.value.data?.data || []);
      if (mp.status === 'fulfilled') setMyProfile(mp.value.data?.data || null);
      if (bx.status === 'fulfilled') setMyBoxes(bx.value.data?.data || []);
      if (ar.status === 'fulfilled') setArchivedBoxes(ar.value.data?.data || []);
    } finally {
      setLoading(false);
    }
  }, []);

  // Lightweight poll of ONLY my-copies (open count + live Running PnL).
  const refreshMine = useCallback(async () => {
    try {
      const mc = await api.get('/copy-trading/my-copies');
      setMine(mc.data?.data || []);
    } catch (_) { /* background poll — ignore transient errors */ }
  }, []);

  useEffect(() => {
    refresh();
    const unsub = navigation.addListener('focus', refresh);
    const interval = setInterval(refresh, 30000);
    return () => { unsub(); clearInterval(interval); };
  }, [navigation, refresh]);

  // Fast poll + WS so "Running PnL" stays live — only on the discover/mine
  // tabs and while the app is foregrounded (mirrors the web's guard).
  useEffect(() => {
    if (tab !== 'mine' && tab !== 'discover') return undefined;
    const id = setInterval(() => { if (AppState.currentState === 'active') refreshMine(); }, 6000);
    const un = wsClient.subscribe('copytrading', () => refreshMine());
    return () => { clearInterval(id); un && un(); };
  }, [tab, refreshMine]);

  const badges = useMemo(() => computeBadges(leaders || []), [leaders]);

  const visibleLeaders = useMemo(() => {
    let list = leaders || [];
    const s = q.trim().toLowerCase();
    if (s) list = list.filter((t) => (t.displayName || '').toLowerCase().includes(s) || (t.bio || '').toLowerCase().includes(s));
    if (riskFilter !== 'ALL') list = list.filter((t) => (t.riskBadge || 'MEDIUM') === riskFilter);
    const sorters = {
      roi: (a, b) => Number(b.roiPct || 0) - Number(a.roiPct || 0),
      followers: (a, b) => Number(b.followers || 0) - Number(a.followers || 0),
      winRate: (a, b) => Number(b.winRate || 0) - Number(a.winRate || 0),
      trades: (a, b) => Number(b.totalTrades || 0) - Number(a.totalTrades || 0),
      newest: (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
    };
    return [...list].sort(sorters[sortBy] || sorters.roi);
  }, [leaders, q, riskFilter, sortBy]);

  const sortedMine = useMemo(
    () => [...mine].sort((a, b) => (COPY_STATUS_RANK[a.status] ?? 9) - (COPY_STATUS_RANK[b.status] ?? 9)),
    [mine],
  );
  const filteredMine = useMemo(() => {
    const s = mineQ.trim().toLowerCase();
    if (!s) return sortedMine;
    return sortedMine.filter((r) => {
      const m = r.master || {};
      return [m.displayName, m.accountNumber, r.followerAccountNumber, r.status, r.riskLevel]
        .some((v) => String(v || '').toLowerCase().includes(s));
    });
  }, [sortedMine, mineQ]);

  // ── Actions (same endpoints as the web) ────────────────────────────────
  const setStatus = async (relationId, route, closePositions = false) => {
    try {
      await api.post(`/copy-trading/${route}`, { relationId, closePositions });
      refresh();
    } catch (e) { Alert.alert('Failed', errorMessage(e)); }
  };
  const toggleBoxPublic = async (box) => {
    try { await api.put(`/copy-trading/boxes/${box._id}`, { isPublic: !box.isPublic }); refresh(); }
    catch (e) { Alert.alert('Failed', errorMessage(e)); }
  };
  const deleteBox = (box) => {
    const name = box.displayName || box.accountNumber;
    const msg = Number(box.followers) > 0
      ? `Delete "${name}"? Its ${box.followers} follower(s) will be stopped (open mirrored trades stay open). The box moves to Archived — you can restore it later.`
      : `Delete "${name}"? It moves to Archived (kept in history) — you can restore it later.`;
    Alert.alert('Delete copy box', msg, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => { try { await api.delete(`/copy-trading/boxes/${box._id}`); refresh(); } catch (e) { Alert.alert('Failed', errorMessage(e)); } },
      },
    ]);
  };
  const restoreBox = async (box) => {
    try { await api.post(`/copy-trading/boxes/${box._id}/restore`); refresh(); }
    catch (e) { Alert.alert('Failed', errorMessage(e)); }
  };

  const onRefresh = async () => { setRefreshing(true); await refresh(); setRefreshing(false); };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 16 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary500} />}
      >
        {/* 1. Hero */}
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>SOCIAL</Text>
          <Text style={styles.h1}>Copy Trading</Text>
          <Text style={styles.heroSub}>
            Mirror the trades of top performers automatically. Pick a trader, set your investment, and the system copies
            their entries, closes and SL/TP for you.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => setBecomeMaster(true)} activeOpacity={0.85}>
            <Text style={styles.primaryBtnTxt}>+ Become a master trader</Text>
          </TouchableOpacity>
        </View>

        {/* 2. My copy boxes */}
        <MyBoxesSection
          boxes={myBoxes}
          onCreate={() => setBecomeMaster(true)}
          onToggle={toggleBoxPublic}
          onEdit={setEditingBox}
          onDelete={deleteBox}
          onView={(b) => navigation.navigate('TraderProfile', { box: b })}
          styles={styles} c={c}
        />

        {/* 3. Archived boxes */}
        <ArchivedBoxesSection boxes={archivedBoxes} onRestore={restoreBox} styles={styles} c={c} />

        {/* 4. Tab strip */}
        <TabStrip tab={tab} setTab={setTab} styles={styles} c={c} />

        {loading ? (
          <Loader label="Loading…" />
        ) : tab === 'discover' ? (
          <View style={{ gap: 12 }}>
            <SectionHeader title="Top traders" count={(leaders || []).length} styles={styles} c={c} />
            {(leaders || []).length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyTxt}>No public copy boxes yet — create one from your trading account to get listed.</Text>
              </View>
            ) : (
              <>
                <TextInput
                  value={q} onChangeText={setQ} placeholder="Search traders…" placeholderTextColor={c.textMuted}
                  style={styles.search}
                />
                <ChipRow options={RISK_FILTERS} value={riskFilter} onChange={setRiskFilter} styles={styles} c={c} />
                <ChipRow options={SORTS} value={sortBy} onChange={setSortBy} prefix="Sort: " styles={styles} c={c} />
                {visibleLeaders.length === 0 ? (
                  <View style={styles.emptyCard}><Text style={styles.emptyTxt}>No traders match your filters.</Text></View>
                ) : visibleLeaders.map((t) => (
                  <TraderCard
                    key={t._id} trader={t} badge={badges[t._id]}
                    onView={() => navigation.navigate('TraderProfile', { box: t })}
                    onCopy={() => navigation.navigate('CopySetup', { trader: t })}
                    styles={styles} c={c}
                  />
                ))}
              </>
            )}
          </View>
        ) : tab === 'feed' ? (
          <View style={{ gap: 12 }}>
            <SectionHeader title="Live feed" count={feed.length} styles={styles} c={c} />
            {feed.length === 0 ? (
              <View style={styles.emptyCard}><Text style={styles.emptyTxt}>No activity yet</Text></View>
            ) : (
              <View style={styles.card}>
                {feed.map((e, i) => <FeedRow key={e._id || i} event={e} last={i === feed.length - 1} styles={styles} c={c} />)}
              </View>
            )}
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            <SectionHeader title="My copies" count={mine.length} styles={styles} c={c} />
            {mine.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyTxt}>You aren't copying anyone yet — pick a trader in Discover to start.</Text>
              </View>
            ) : (
              <>
                <TextInput
                  value={mineQ} onChangeText={setMineQ} placeholder="Search by trader, account or status…"
                  placeholderTextColor={c.textMuted} style={styles.search}
                />
                {filteredMine.length === 0 ? (
                  <View style={styles.emptyCard}><Text style={styles.emptyTxt}>No copies match “{mineQ}”.</Text></View>
                ) : filteredMine.map((rel) => (
                  <MyCopyRow
                    key={rel._id} rel={rel} onAction={setStatus}
                    onEdit={() => setEditRel(rel)} onStop={() => setStopRel(rel)} onAnalytics={() => setAnalyticsRel(rel)}
                    styles={styles} c={c}
                  />
                ))}
              </>
            )}
          </View>
        )}
      </ScrollView>

      {/* Sheets (native equivalents of the web modals — same endpoints) */}
      {becomeMaster && (
        <BecomeMasterSheet
          initialFee={myProfile?.performanceFeePercent ?? ''}
          onClose={() => setBecomeMaster(false)}
          onCreated={() => { setBecomeMaster(false); refresh(); setTab('mine'); }}
          styles={styles} c={c}
        />
      )}
      {editingBox && (
        <EditBoxSheet box={editingBox} onClose={() => setEditingBox(null)} onSaved={() => { setEditingBox(null); refresh(); }} styles={styles} c={c} />
      )}
      {editRel && (
        <EditCopySheet rel={editRel} onClose={() => setEditRel(null)} onSaved={() => { setEditRel(null); refresh(); }} styles={styles} c={c} />
      )}
      {stopRel && (
        <StopCopySheet
          rel={stopRel} onClose={() => setStopRel(null)}
          onConfirm={async (close) => { await setStatus(stopRel._id, 'stop', close); setStopRel(null); }}
          styles={styles} c={c}
        />
      )}
      {analyticsRel && (
        <AnalyticsSheet rel={analyticsRel} onClose={() => setAnalyticsRel(null)} styles={styles} c={c} />
      )}
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Presentational pieces (receive `styles`/`c` via props — no module-scope `c`)
// ═══════════════════════════════════════════════════════════════════════════
function SectionHeader({ title, count, styles }) {
  return (
    <View style={styles.secHead}>
      <Text style={styles.secTitle}>{title}</Text>
      {count !== undefined && <Text style={styles.secCount}>{count}</Text>}
    </View>
  );
}

function TabStrip({ tab, setTab, styles, c }) {
  return (
    <View style={styles.tabStrip}>
      {TABS.map((t) => {
        const on = tab === t.id;
        return (
          <TouchableOpacity key={t.id} onPress={() => setTab(t.id)} style={[styles.tabBtn, on && styles.tabBtnOn]} activeOpacity={0.8}>
            <Text style={[styles.tabBtnTxt, on && { color: c.primary500 }]}>{t.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function ChipRow({ options, value, onChange, prefix = '', styles, c }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 2 }} keyboardShouldPersistTaps="handled">
      {options.map((o) => {
        const on = value === o.id;
        return (
          <TouchableOpacity key={o.id} onPress={() => onChange(o.id)} style={[styles.chip, on && styles.chipOn]} activeOpacity={0.8}>
            <Text style={[styles.chipTxt, on && { color: c.primary500 }]}>{prefix}{o.label}</Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

function Badge({ label, toneKey, styles, c }) {
  const map = {
    bull: [c.bullSoft, c.bull], bear: [c.bearSoft, c.bear], warn: [c.warnSoft, c.warn],
    primary: [c.primarySoft, c.primary500], muted: [c.hover, c.textMuted],
  };
  const [bg, fg] = map[toneKey] || map.muted;
  return <View style={[styles.badge, { backgroundColor: bg }]}><Text style={[styles.badgeTxt, { color: fg }]}>{label}</Text></View>;
}

function Stat({ label, value, toneKey, styles, c }) {
  const color = toneKey === 'bull' ? c.bull : toneKey === 'bear' ? c.bear : c.textPrimary;
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, { color }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function TraderCard({ trader, badge, onView, onCopy, styles, c }) {
  const roi = Number(trader.roiPct || 0);
  const win = Number(trader.winRate || 0);
  const meta = [trader.accountType, trader.ownerName].filter(Boolean).join(' · ');
  return (
    <View style={styles.card}>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <TouchableOpacity onPress={onView} style={styles.avatar} activeOpacity={0.8}>
          <Text style={styles.avatarTxt}>{(trader.displayName || 'T').slice(0, 2).toUpperCase()}</Text>
        </TouchableOpacity>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.nameRow}>
            <TouchableOpacity onPress={onView}><Text style={styles.cardName} numberOfLines={1}>{trader.displayName || 'Trader'}</Text></TouchableOpacity>
            {badge && <Badge label={`${badge.icon} ${badge.label}`} toneKey="primary" styles={styles} c={c} />}
            <Badge label={trader.riskBadge || 'MED'} toneKey={riskToneKey(trader.riskBadge)} styles={styles} c={c} />
          </View>
          {meta ? <Text style={styles.cardMeta} numberOfLines={1}>{meta}</Text> : null}
          <Text style={styles.cardBio} numberOfLines={2}>{trader.bio || 'Active trader on the platform.'}</Text>
        </View>
      </View>
      <View style={styles.statRow}>
        <Stat label="ROI" value={`${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`} toneKey={roi >= 0 ? 'bull' : 'bear'} styles={styles} c={c} />
        <Stat label="Win" value={`${win.toFixed(0)}%`} styles={styles} c={c} />
        <Stat label="Followers" value={fmtNum(Number(trader.followers || 0), 0)} styles={styles} c={c} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TouchableOpacity onPress={onView} style={[styles.btn, styles.btnGhost, { flex: 1 }]} activeOpacity={0.85}><Text style={styles.btnGhostTxt}>View profile</Text></TouchableOpacity>
        <TouchableOpacity onPress={onCopy} style={[styles.btn, styles.btnPrimary, { flex: 1 }]} activeOpacity={0.85}><Text style={styles.btnPrimaryTxt}>Copy</Text></TouchableOpacity>
      </View>
    </View>
  );
}

function FeedRow({ event, last, styles, c }) {
  const elapsed = formatElapsed(Date.now() - new Date(event.createdAt).getTime());
  const dotColor = { OPEN: c.warn, CLOSE: c.bull, TP_HIT: c.bull, SL_HIT: c.bear, FOLLOWED: '#8B5CF6' }[event.type] || c.textMuted;
  const pnlNum = Number(event.pnl);
  const showPnl = Number.isFinite(pnlNum) && (event.type === 'CLOSE' || event.type === 'TP_HIT' || event.type === 'SL_HIT');
  return (
    <View style={[styles.feedRow, !last && styles.feedDivider]}>
      <View style={[styles.feedDot, { backgroundColor: dotColor }]} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.feedText}>{event.note || `${event.masterName} ${String(event.type || '').toLowerCase()} ${event.symbol || ''}`}</Text>
        <View style={styles.feedMetaRow}>
          <Text style={styles.feedMeta}>{elapsed}</Text>
          {event.symbol ? <Text style={styles.feedMeta}>· {event.symbol}</Text> : null}
          {showPnl ? (
            <Text style={[styles.feedMeta, { color: pnlNum >= 0 ? c.bull : c.bear, fontWeight: '700' }]}>
              · {pnlNum >= 0 ? '+' : ''}{pnlNum.toFixed(2)} USD
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function MyCopyRow({ rel, onAction, onEdit, onStop, onAnalytics, styles, c }) {
  const m = rel.master || {};
  const running = Number(rel.runningPnl || 0);
  const lot = rel.lotMode === 'CUSTOM' ? `${rel.customLot} lots` : `${String(rel.lotMode || 'MEDIUM').toLowerCase()} lot`;
  const meta = `${lot} · ${rel.tradesCopied || 0} copies · ${(rel.openMirrors || []).length} open${rel.followerAccountNumber ? ` · → ${rel.followerAccountNumber}` : ''}`;
  return (
    <View style={styles.card}>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={styles.avatarSm}><Text style={styles.avatarSmTxt}>{(m.displayName || 'T').slice(0, 2).toUpperCase()}</Text></View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.nameRow}>
            <Text style={styles.cardName} numberOfLines={1}>{m.displayName || 'Trader'}</Text>
            <Badge label={rel.status} toneKey={statusToneKey(rel.status)} styles={styles} c={c} />
          </View>
          <Text style={styles.cardMeta} numberOfLines={2}>{meta}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[styles.runPnl, { color: running >= 0 ? c.bull : c.bear }]}>{running >= 0 ? '+' : ''}{running.toFixed(2)}</Text>
          <Text style={styles.runLabel}>Running PnL</Text>
        </View>
      </View>
      <View style={styles.actionRow}>
        <TouchableOpacity onPress={() => onAnalytics(rel)} style={styles.actBtn}><Text style={[styles.actTxt, { color: c.primary500 }]}>Analytics</Text></TouchableOpacity>
        {rel.status === 'ACTIVE' && <TouchableOpacity onPress={() => onAction(rel._id, 'pause')} style={styles.actBtn}><Text style={styles.actTxt}>Pause</Text></TouchableOpacity>}
        {rel.status !== 'ACTIVE' && <TouchableOpacity onPress={() => onAction(rel._id, 'resume')} style={styles.actBtn}><Text style={[styles.actTxt, { color: c.primary500 }]}>Resume</Text></TouchableOpacity>}
        {rel.status !== 'STOPPED' && <TouchableOpacity onPress={() => onEdit(rel)} style={styles.actBtn}><Text style={styles.actTxt}>Edit</Text></TouchableOpacity>}
        {rel.status !== 'STOPPED' && <TouchableOpacity onPress={() => onStop(rel)} style={styles.actBtn}><Text style={[styles.actTxt, { color: c.bear }]}>Stop</Text></TouchableOpacity>}
      </View>
    </View>
  );
}

// ── My copy boxes (one per source trading account) ───────────────────────
function MyBoxesSection({ boxes, onCreate, onToggle, onEdit, onDelete, onView, styles, c }) {
  if (!boxes.length) {
    return (
      <View style={[styles.card, styles.dashed]}>
        <Text style={styles.boxTitle}>Become a master trader</Text>
        <Text style={styles.boxSub}>Create a copy box from one of your trading accounts. Only that account's trades are copied to your followers.</Text>
        <TouchableOpacity style={[styles.primaryBtn, { marginTop: 12 }]} onPress={onCreate} activeOpacity={0.85}>
          <Text style={styles.primaryBtnTxt}>Create a copy box</Text>
        </TouchableOpacity>
      </View>
    );
  }
  return (
    <View style={{ gap: 12 }}>
      <View style={styles.secHead}>
        <Text style={styles.secTitle}>My copy boxes</Text>
        <TouchableOpacity onPress={onCreate}><Text style={styles.linkTxt}>+ New box</Text></TouchableOpacity>
      </View>
      {boxes.map((b) => <MyBoxCard key={b._id} b={b} onToggle={onToggle} onEdit={onEdit} onDelete={onDelete} onView={onView} styles={styles} c={c} />)}
    </View>
  );
}

function MyBoxCard({ b, onToggle, onEdit, onDelete, onView, styles, c }) {
  const roi = Number(b.roiPct || 0);
  const pnl = Number(b.cumulativePnl || 0);
  return (
    <View style={[styles.card, { borderColor: b.isPublic ? c.bull : c.border }]}>
      <View style={styles.boxHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.cardName} numberOfLines={1}>{b.displayName || b.accountNumber}</Text>
          <Text style={styles.cardMeta} numberOfLines={1}>{b.accountType} · {b.accountNumber}</Text>
        </View>
        <Badge label={b.isPublic ? 'Live' : 'Private'} toneKey={b.isPublic ? 'bull' : 'muted'} styles={styles} c={c} />
      </View>
      <View style={styles.statRow}>
        <Stat label="ROI" value={`${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`} toneKey={roi >= 0 ? 'bull' : 'bear'} styles={styles} c={c} />
        <Stat label="Win" value={`${Number(b.winRate || 0).toFixed(0)}%`} styles={styles} c={c} />
        <Stat label="Followers" value={fmtNum(Number(b.followers || 0), 0)} styles={styles} c={c} />
      </View>
      <View style={styles.pnlBar}>
        <Text style={styles.pnlLabel}>Total P&L</Text>
        <Text style={[styles.pnlValue, { color: pnl >= 0 ? c.bull : c.bear }]}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} USD</Text>
      </View>
      <Text style={styles.feeLine}>
        Performance fee: <Text style={{ fontWeight: '800', color: c.textSecondary }}>{Number(b.effectivePerformanceFee || 0)}%</Text>
        {b.performanceFeePercent == null ? ' (default)' : ''}
      </Text>
      {!b.acceptsFollowers && <Text style={styles.warnLine}>Source account disabled — not accepting new followers.</Text>}
      <View style={styles.boxActions}>
        {b.isPublic && <TouchableOpacity onPress={() => onView(b)} style={[styles.actBtn, { marginRight: 'auto' }]}><Text style={[styles.actTxt, { color: c.primary500 }]}>View profile</Text></TouchableOpacity>}
        <TouchableOpacity onPress={() => onEdit(b)} style={styles.actBtn}><Text style={styles.actTxt}>Edit</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => onToggle(b)} style={styles.actBtn}><Text style={styles.actTxt}>{b.isPublic ? 'Make private' : 'Go public'}</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => onDelete(b)} style={styles.actBtn}><Text style={[styles.actTxt, { color: c.bear }]}>Delete</Text></TouchableOpacity>
      </View>
    </View>
  );
}

// ── Archived (deleted) boxes — collapsible, restore-only history ──────────
function ArchivedBoxesSection({ boxes, onRestore, styles, c }) {
  const [show, setShow] = useState(false);
  if (!boxes.length) return null;
  return (
    <View style={{ gap: 12 }}>
      <TouchableOpacity onPress={() => setShow((s) => !s)} style={styles.archHead} activeOpacity={0.7}>
        <Text style={[styles.secTitle, show && { color: c.primary500 }]}>{show ? '▾' : '▸'}  Archived boxes</Text>
        <Text style={styles.secCount}>({boxes.length}) · {show ? 'Hide' : 'Show'}</Text>
      </TouchableOpacity>
      {show && boxes.map((b) => {
        const roi = Number(b.roiPct || 0);
        return (
          <View key={b._id} style={[styles.card, styles.dashed]}>
            <View style={styles.boxHead}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.cardName} numberOfLines={1}>{b.displayName || b.accountNumber}</Text>
                <Text style={styles.cardMeta} numberOfLines={1}>{b.accountType} · {b.accountNumber}</Text>
              </View>
              <Badge label="Archived" toneKey="muted" styles={styles} c={c} />
            </View>
            <View style={styles.statRow}>
              <Stat label="ROI" value={`${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`} toneKey={roi >= 0 ? 'bull' : 'bear'} styles={styles} c={c} />
              <Stat label="Win" value={`${Number(b.winRate || 0).toFixed(0)}%`} styles={styles} c={c} />
              <Stat label="Trades" value={fmtNum(Number(b.totalTrades || 0), 0)} styles={styles} c={c} />
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
              <TouchableOpacity onPress={() => onRestore(b)} style={styles.actBtn}><Text style={[styles.actTxt, { color: c.primary500 }]}>Restore</Text></TouchableOpacity>
            </View>
          </View>
        );
      })}
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Sheet primitives + form controls
// ═══════════════════════════════════════════════════════════════════════════
function Sheet({ title, subtitle, onClose, children, footer, styles, c }) {
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop}>
        <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.sheetHead}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.sheetTitle} numberOfLines={1}>{title}</Text>
              {subtitle ? <Text style={styles.sheetSub} numberOfLines={1}>{subtitle}</Text> : null}
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}><Text style={styles.sheetClose}>×</Text></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">{children}</ScrollView>
          {footer ? <View style={styles.sheetFoot}>{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}

function SheetFooter({ onClose, onSubmit, submitLabel, saving, disabled, styles, c }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <TouchableOpacity onPress={onClose} disabled={saving} style={[styles.btn, styles.btnGhost, { flex: 1 }]} activeOpacity={0.85}>
        <Text style={styles.btnGhostTxt}>Cancel</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onSubmit} disabled={saving || disabled} style={[styles.btn, styles.btnPrimary, { flex: 1, opacity: saving || disabled ? 0.5 : 1 }]} activeOpacity={0.85}>
        {saving ? <ActivityIndicator color={c.white} /> : <Text style={styles.btnPrimaryTxt}>{submitLabel}</Text>}
      </TouchableOpacity>
    </View>
  );
}

function RiskBadgePicker({ value, onChange, styles, c }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {RISK_BADGES.map((r) => {
        const on = value === r.id;
        return (
          <TouchableOpacity key={r.id} onPress={() => onChange(r.id)} style={[styles.riskBtn, { flex: 1 }, on && { borderColor: c.primary500, backgroundColor: c.primarySoft }]} activeOpacity={0.85}>
            <Text style={[styles.riskBtnTxt, on && { color: c.primary500 }]}>{r.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function SwitchRow({ label, sub, value, onValueChange, styles, c }) {
  return (
    <View style={styles.switchRow}>
      <View style={{ flex: 1, minWidth: 0, paddingRight: 10 }}>
        <Text style={styles.switchLabel}>{label}</Text>
        {sub ? <Text style={styles.switchSub}>{sub}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onValueChange} trackColor={{ true: c.primary500, false: c.border }} thumbColor={c.white} />
    </View>
  );
}

// ── Become a master trader → POST /copy-trading/boxes ────────────────────
function BecomeMasterSheet({ initialFee = '', onClose, onCreated, styles, c }) {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [riskBadge, setRiskBadge] = useState('MEDIUM');
  const [isPublic, setIsPublic] = useState(true);
  const [feePct, setFeePct] = useState(initialFee == null ? '' : String(initialFee));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get('/copy-trading/eligible-accounts');
        // DEMO / VIRTUAL accounts can't be a copy source (followers mirror real trades).
        const list = (r.data?.data || []).filter((a) => a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL');
        setAccounts(list);
        const first = list.find((a) => !a.hasBox);
        if (first) setAccountId(first.accountId);
      } catch (e) { Alert.alert('Failed', errorMessage(e)); }
      finally { setLoading(false); }
    })();
  }, []);

  const create = async () => {
    if (!accountId) { Alert.alert('Account', 'Select a trading account'); return; }
    setSaving(true);
    try {
      await api.post('/copy-trading/boxes', {
        accountId, displayName: displayName.trim(), riskBadge, isPublic,
        performanceFeePercent: feePct === '' ? null : Number(feePct),
      });
      onCreated?.();
    } catch (e) { Alert.alert('Failed', errorMessage(e)); }
    finally { setSaving(false); }
  };

  return (
    <Sheet
      title="Become a master trader" onClose={onClose} styles={styles} c={c}
      footer={<SheetFooter onClose={onClose} onSubmit={create} submitLabel="Create copy box" saving={saving} disabled={!accountId} styles={styles} c={c} />}
    >
      <View>
        <Text style={styles.fieldLabel}>SOURCE TRADING ACCOUNT</Text>
        <Text style={styles.fieldHint}>Pick the account to copy from. Only this account's trades are mirrored to followers.</Text>
        {loading ? (
          <ActivityIndicator color={c.primary500} style={{ marginTop: 10 }} />
        ) : accounts.length === 0 ? (
          <Text style={styles.fieldHint}>No active trading accounts found.</Text>
        ) : accounts.map((a) => {
          const on = a.accountId === accountId;
          const disabled = a.hasBox;
          return (
            <TouchableOpacity
              key={a.accountId} disabled={disabled} onPress={() => setAccountId(a.accountId)}
              style={[styles.acctRow, on && { borderColor: c.primary500, backgroundColor: c.primarySoft }, disabled && { opacity: 0.55 }]}
              activeOpacity={0.85}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[styles.acctName, disabled && { textDecorationLine: 'line-through', color: c.bear }]} numberOfLines={1}>
                  {a.accountNumber} ({a.accountType})
                </Text>
                <Text style={styles.acctMeta} numberOfLines={1}>
                  {a.baseCurrency}{a.hasBox ? ' · box exists' : ''}{!a.acceptsFollowers ? ' · inactive' : ''}
                </Text>
              </View>
              {on ? <Text style={{ color: c.primary500, fontWeight: '900', fontSize: 16 }}>✓</Text> : null}
            </TouchableOpacity>
          );
        })}
      </View>

      <View>
        <Text style={styles.fieldLabel}>BOX NAME</Text>
        <TextInput value={displayName} onChangeText={setDisplayName} placeholder="e.g. Aggressive FX Scalper" placeholderTextColor={c.textMuted} maxLength={40} style={styles.input} />
      </View>

      <View>
        <Text style={styles.fieldLabel}>RISK BADGE</Text>
        <RiskBadgePicker value={riskBadge} onChange={setRiskBadge} styles={styles} c={c} />
      </View>

      <SwitchRow label="List on the leaderboard" sub="Others can discover this box and copy it." value={isPublic} onValueChange={setIsPublic} styles={styles} c={c} />

      <View>
        <Text style={styles.fieldLabel}>PERFORMANCE FEE (%)</Text>
        <TextInput value={feePct} onChangeText={setFeePct} keyboardType="decimal-pad" placeholder="Platform default" placeholderTextColor={c.textMuted} style={styles.input} />
        <Text style={styles.fieldHint}>Your cut of each follower's profit on winning copied trades — credited to your Main Wallet. No fee on losses. Blank = platform default.</Text>
      </View>
    </Sheet>
  );
}

// ── Edit a copy box (name, risk, visibility, fee) → PUT /boxes/:id ───────
function EditBoxSheet({ box, onClose, onSaved, styles, c }) {
  const [displayName, setDisplayName] = useState(box.displayName || '');
  const [riskBadge, setRiskBadge] = useState(box.riskBadge || 'MEDIUM');
  const [isPublic, setIsPublic] = useState(!!box.isPublic);
  const [feePct, setFeePct] = useState(box.performanceFeePercent != null ? String(box.performanceFeePercent) : '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (isPublic && !displayName.trim()) { Alert.alert('Name required', 'Give your box a name before listing it publicly'); return; }
    setSaving(true);
    try {
      await api.put(`/copy-trading/boxes/${box._id}`, {
        displayName: displayName.trim(), riskBadge, isPublic,
        performanceFeePercent: feePct === '' ? null : Number(feePct),
      });
      onSaved?.();
    } catch (e) { Alert.alert('Failed', errorMessage(e)); }
    finally { setSaving(false); }
  };

  return (
    <Sheet
      title="Edit copy box" onClose={onClose} styles={styles} c={c}
      footer={<SheetFooter onClose={onClose} onSubmit={save} submitLabel="Save changes" saving={saving} styles={styles} c={c} />}
    >
      <View style={styles.roMeta}>
        <Text style={styles.roMetaTxt}>
          <Text style={{ fontWeight: '800', color: c.textPrimary }}>{box.accountType}</Text> · {box.accountNumber} · source account can't be changed
        </Text>
      </View>

      <View>
        <Text style={styles.fieldLabel}>BOX NAME</Text>
        <TextInput value={displayName} onChangeText={setDisplayName} placeholder="e.g. Aggressive FX Scalper" placeholderTextColor={c.textMuted} maxLength={40} style={styles.input} />
      </View>

      <View>
        <Text style={styles.fieldLabel}>RISK BADGE</Text>
        <RiskBadgePicker value={riskBadge} onChange={setRiskBadge} styles={styles} c={c} />
      </View>

      <SwitchRow label="List on the leaderboard" sub="Others can discover this box and copy it." value={isPublic} onValueChange={setIsPublic} styles={styles} c={c} />

      <View>
        <Text style={styles.fieldLabel}>PERFORMANCE FEE (%)</Text>
        <TextInput
          value={feePct} onChangeText={setFeePct} keyboardType="decimal-pad"
          placeholder={box.effectivePerformanceFee != null ? `Default (${box.effectivePerformanceFee}%)` : 'Platform default'}
          placeholderTextColor={c.textMuted} style={styles.input}
        />
        <Text style={styles.fieldHint}>Your cut of each follower's profit on winning copied trades. No fee on losses. Blank = platform default. Applies to this box only.</Text>
      </View>
    </Sheet>
  );
}

// ── Edit an existing copy relation → PUT /copy-trading/copy/:id ───────────
function EditCopySheet({ rel, onClose, onSaved, styles, c }) {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState(String(rel.followerAccountId || ''));
  const [lotMode, setLotMode] = useState(rel.lotMode || 'MEDIUM');
  const [customLot, setCustomLot] = useState(rel.customLot != null ? String(rel.customLot) : '0.10');
  const [maxLot, setMaxLot] = useState(rel.maxLot != null ? String(rel.maxLot) : '');
  const [copySL, setCopySL] = useState(rel.copySL !== false);
  const [copyTP, setCopyTP] = useState(rel.copyTP !== false);
  const [copyPending, setCopyPending] = useState(!!rel.copyPending);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const ar = await api.get('/user/accounts');
        setAccounts((ar.data?.data || []).filter((a) => a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL' && a.isActive !== false));
      } catch (_) { /* non-fatal */ }
    })();
  }, []);

  const accountChanged = String(accountId) !== String(rel.followerAccountId || '');
  const openCount = (rel.openMirrors || []).length;

  const doSave = async (closePositions) => {
    setSaving(true);
    try {
      await api.put(`/copy-trading/copy/${rel._id}`, {
        followerAccountId: accountId,
        closePositions: !!closePositions,
        ...settingsPayload({ lotMode, customLot, maxLot, copySL, copyTP, copyPending }),
      });
      onSaved?.();
    } catch (e) { Alert.alert('Failed', errorMessage(e)); }
    finally { setSaving(false); }
  };
  const onSaveClick = () => {
    if (lotMode === 'CUSTOM' && !(Number(customLot) > 0)) { Alert.alert('Lot', 'Enter a custom lot size greater than 0'); return; }
    if (accountChanged && openCount > 0) {
      Alert.alert(
        'Change trading account',
        `What should happen to the ${openCount} open copied position(s)? Future copied trades go to the new account either way.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Keep open', onPress: () => doSave(false) },
          { text: 'Close all', style: 'destructive', onPress: () => doSave(true) },
        ],
      );
      return;
    }
    doSave(false);
  };

  return (
    <Sheet
      title={`Edit copy · ${rel.master?.displayName || 'Trader'}`} onClose={onClose} styles={styles} c={c}
      footer={<SheetFooter onClose={onClose} onSubmit={onSaveClick} submitLabel="Save changes" saving={saving} styles={styles} c={c} />}
    >
      <View>
        <Text style={styles.fieldLabel}>TRADING ACCOUNT</Text>
        {accounts.length === 0 ? (
          <Text style={styles.fieldHint}>Loading accounts…</Text>
        ) : accounts.map((a) => {
          const on = String(a._id) === String(accountId);
          return (
            <TouchableOpacity key={a._id} onPress={() => setAccountId(String(a._id))} style={[styles.acctRow, on && { borderColor: c.primary500, backgroundColor: c.primarySoft }]} activeOpacity={0.85}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.acctName} numberOfLines={1}>{a.nickname || a.accountNumber}</Text>
                <Text style={styles.acctMeta} numberOfLines={1}>{a.baseCurrency}</Text>
              </View>
              {on ? <Text style={{ color: c.primary500, fontWeight: '900', fontSize: 16 }}>✓</Text> : null}
            </TouchableOpacity>
          );
        })}
        {accountChanged && openCount > 0 && <Text style={styles.warnLine}>Changing account — you'll choose what happens to open positions on save.</Text>}
      </View>

      <View>
        <Text style={styles.fieldLabel}>LOT SIZE</Text>
        <View style={styles.lotGrid}>
          {LOT_MODES.map((m) => {
            const on = lotMode === m.id;
            return (
              <TouchableOpacity key={m.id} onPress={() => setLotMode(m.id)} style={[styles.lotBtn, on && { borderColor: c.primary500, backgroundColor: c.primarySoft }]} activeOpacity={0.85}>
                <Text style={[styles.lotBtnTxt, on && { color: c.primary500 }]}>{m.label}</Text>
                <Text style={styles.lotBtnNote}>{m.note}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {lotMode === 'CUSTOM' && (
          <View style={{ marginTop: 8 }}>
            <TextInput value={customLot} onChangeText={setCustomLot} keyboardType="decimal-pad" placeholder="0.10" placeholderTextColor={c.textMuted} style={styles.input} />
          </View>
        )}
      </View>

      <View style={{ gap: 4 }}>
        <SwitchRow label="Copy Stop Loss" value={copySL} onValueChange={setCopySL} styles={styles} c={c} />
        <SwitchRow label="Copy Take Profit" value={copyTP} onValueChange={setCopyTP} styles={styles} c={c} />
        <SwitchRow label="Copy Pending Orders" value={copyPending} onValueChange={setCopyPending} styles={styles} c={c} />
      </View>

      <View>
        <Text style={styles.fieldLabel}>MAX LOT PER TRADE (blank = no limit)</Text>
        <TextInput value={maxLot} onChangeText={setMaxLot} keyboardType="decimal-pad" placeholder="No cap" placeholderTextColor={c.textMuted} style={styles.input} />
      </View>
    </Sheet>
  );
}

// ── Stop copy trading → onConfirm(closePositions) → POST /stop ────────────
function StopCopySheet({ rel, onClose, onConfirm, styles, c }) {
  const openCount = (rel.openMirrors || []).length;
  const [choice, setChoice] = useState('keep'); // 'close' | 'keep'
  const [saving, setSaving] = useState(false);

  const confirm = async () => {
    setSaving(true);
    try { await onConfirm(choice === 'close'); }
    finally { setSaving(false); }
  };

  return (
    <Sheet
      title="Stop copy trading?" onClose={onClose} styles={styles} c={c}
      footer={<SheetFooter onClose={onClose} onSubmit={confirm} submitLabel="Confirm stop" saving={saving} styles={styles} c={c} />}
    >
      <Text style={styles.bodyTxt}>
        {openCount > 0
          ? `This copy has ${openCount} open position(s). Choose what happens to them:`
          : 'New trades will stop being copied. You can resume this session later with the same settings.'}
      </Text>
      {openCount > 0 && (
        <>
          <OptionCard title="Close automatically" desc="Market-close all open copied positions now." selected={choice === 'close'} danger onPress={() => setChoice('close')} styles={styles} c={c} />
          <OptionCard title="Keep open (close manually)" desc="Leave positions open — you'll close them yourself." selected={choice === 'keep'} onPress={() => setChoice('keep')} styles={styles} c={c} />
        </>
      )}
    </Sheet>
  );
}

function OptionCard({ title, desc, selected, danger, onPress, styles, c }) {
  const accent = danger ? c.bear : c.primary500;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={[styles.optionCard, { borderColor: selected ? accent : c.border, backgroundColor: selected ? (danger ? c.bearSoft : c.primarySoft) : c.card }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={[styles.radioOuter, { borderColor: selected ? accent : c.border }]}>{selected ? <View style={[styles.radioInner, { backgroundColor: accent }]} /> : null}</View>
        <Text style={styles.optionTitle}>{title}</Text>
      </View>
      <Text style={styles.optionDesc}>{desc}</Text>
    </TouchableOpacity>
  );
}

// ── Copy analytics → GET /copy-trading/copy/:id/analytics ────────────────
function AnalyticsSheet({ rel, onClose, styles, c }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [preset, setPreset] = useState('all');

  const load = useCallback(async () => {
    try {
      const params = {};
      if (from) params.from = from;
      if (to) params.to = to;
      const r = await api.get(`/copy-trading/copy/${rel._id}/analytics`, { params });
      setData(r.data?.data || null);
    } catch (e) { Alert.alert('Failed', errorMessage(e)); }
    finally { setLoading(false); }
  }, [from, to, rel._id]);

  useEffect(() => { setLoading(true); load(); }, [load]);
  // Update in real time on copy-trading WS events (where the web subscribes).
  useEffect(() => { const un = wsClient.subscribe('copytrading', () => load()); return () => un && un(); }, [load]);

  const applyPreset = (p) => {
    setPreset(p);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const now = new Date();
    const ago = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return d; };
    if (p === 'all') { setFrom(''); setTo(''); }
    else if (p === '7d') { setFrom(fmt(ago(6))); setTo(fmt(now)); }
    else if (p === '30d') { setFrom(fmt(ago(29))); setTo(fmt(now)); }
    else if (p === '90d') { setFrom(fmt(ago(89))); setTo(fmt(now)); }
  };

  const cur = data?.currency || 'USD';
  const trades = data?.trades || [];

  return (
    <Sheet
      title={`Analytics · ${rel.master?.displayName || 'Trader'}`}
      subtitle={data ? `${data.account?.nickname || data.account?.number || ''}${data.status ? ` · ${data.status}` : ''}` : undefined}
      onClose={onClose} styles={styles} c={c}
    >
      <ChipRow options={ANALYTICS_PRESETS} value={preset} onChange={applyPreset} styles={styles} c={c} />

      {loading || !data ? (
        <ActivityIndicator color={c.primary500} style={{ marginVertical: 28 }} />
      ) : (
        <>
          {/* Fee-aware P&L breakdown */}
          <View style={styles.card}>
            <Text style={styles.panelTitle}>P&L BREAKDOWN</Text>
            <BreakLine label="Gross profit" value={money(data.grossProfit, cur)} color={c.bull} styles={styles} />
            <BreakLine label="Performance fee" value={`-${money(data.performanceFeePaid, cur)}`} color={c.bear} styles={styles} />
            <BreakLine label="Commission" value={`-${money(data.commission, cur)}`} color={c.bear} styles={styles} />
            <BreakLine label="Swap" value={`-${money(data.swap, cur)}`} color={c.bear} styles={styles} />
            <View style={styles.breakDivider} />
            <BreakLine label="Net profit" value={money(data.netProfit, cur)} color={data.netProfit >= 0 ? c.bull : c.bear} bold styles={styles} />
          </View>

          {/* KPI grid */}
          <View style={styles.kpiGrid}>
            <Kpi label="Net profit" value={money(data.netProfit, cur)} color={data.netProfit >= 0 ? c.bull : c.bear} styles={styles} />
            <Kpi label="ROI" value={pct(data.roi)} color={data.roi >= 0 ? c.bull : c.bear} styles={styles} />
            <Kpi label="Win rate" value={pct(data.winRate)} styles={styles} />
            <Kpi label="Profit factor" value={data.profitFactor == null ? '∞' : String(data.profitFactor)} styles={styles} />
            <Kpi label="Total trades" value={String(data.totalTrades ?? 0)} styles={styles} />
            <Kpi label="Closed" value={String(data.closedTrades ?? 0)} styles={styles} />
            <Kpi label="Open" value={String(data.openTrades ?? 0)} styles={styles} />
            <Kpi label="Success rate" value={pct(data.successRate)} styles={styles} />
            <Kpi label="Avg win" value={money(data.avgWin, cur)} color={c.bull} styles={styles} />
            <Kpi label="Avg loss" value={money(data.avgLoss, cur)} color={c.bear} styles={styles} />
            <Kpi label="Largest win" value={money(data.largestWin, cur)} color={c.bull} styles={styles} />
            <Kpi label="Largest loss" value={money(data.largestLoss, cur)} color={c.bear} styles={styles} />
            <Kpi label="Risk / reward" value={String(data.riskReward ?? '—')} styles={styles} />
            <Kpi label="Recovery factor" value={String(data.recoveryFactor ?? '—')} styles={styles} />
            <Kpi label="Sharpe" value={data.sharpe == null ? '—' : String(data.sharpe)} styles={styles} />
            <Kpi label="Max drawdown" value={money(data.maxDrawdown, cur)} color={c.bear} styles={styles} />
            <Kpi label="Current equity" value={money(data.currentEquity, cur)} styles={styles} />
            <Kpi label="Max equity" value={money(data.maxEquity, cur)} styles={styles} />
            <Kpi label="Total lots" value={String(data.totalLots ?? 0)} styles={styles} />
            <Kpi label="Avg holding" value={`${data.avgHoldingMinutes ?? 0} min`} styles={styles} />
          </View>

          {/* Equity curve */}
          <View style={styles.card}>
            <Text style={styles.panelTitle}>EQUITY CURVE (cumulative net)</Text>
            <EquityChart data={data.curve} c={c} />
          </View>

          {/* Daily P&L */}
          <View style={styles.card}>
            <Text style={styles.panelTitle}>DAILY P&L</Text>
            <PnlBars data={data.daily} c={c} />
          </View>

          {/* Master comparison */}
          {data.master && (
            <View style={styles.card}>
              <Text style={styles.panelTitle}>COMPARISON WITH MASTER · {String(data.master.displayName || '').toUpperCase()}</Text>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cmpHead}>You</Text>
                  <Text style={styles.cmpTxt}>ROI {pct(data.roi)} · Win {pct(data.winRate)} · {data.closedTrades} trades</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cmpHead}>Master</Text>
                  <Text style={styles.cmpTxt}>ROI {pct(data.master.roiPct)} · Win {pct(data.master.winRate)} · {data.master.totalTrades} trades</Text>
                </View>
              </View>
            </View>
          )}

          {/* Trade history */}
          <View style={styles.card}>
            <Text style={styles.panelTitle}>TRADE HISTORY ({trades.length})</Text>
            {trades.length === 0 ? (
              <Text style={styles.emptyTxt}>No closed trades</Text>
            ) : (
              <>
                <View style={[styles.tradeRow, { borderBottomWidth: 0 }]}>
                  <Text style={[styles.tradeHead, { flex: 1.4 }]}>Closed</Text>
                  <Text style={[styles.tradeHead, { flex: 1.2 }]}>Symbol</Text>
                  <Text style={[styles.tradeHead, { width: 42 }]}>Side</Text>
                  <Text style={[styles.tradeHead, { flex: 1, textAlign: 'right' }]}>PnL</Text>
                </View>
                {trades.slice(0, 60).map((t) => <TradeRow key={t.id} t={t} cur={cur} styles={styles} c={c} />)}
              </>
            )}
          </View>
          <View style={{ height: 8 }} />
        </>
      )}
    </Sheet>
  );
}

function BreakLine({ label, value, color, bold, styles }) {
  return (
    <View style={styles.breakLine}>
      <Text style={[styles.breakLabel, bold && { fontWeight: '800' }]}>{label}</Text>
      <Text style={[styles.breakValue, { color }, bold && { fontWeight: '900' }]}>{value}</Text>
    </View>
  );
}

function Kpi({ label, value, color, styles }) {
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiLabel} numberOfLines={1}>{label}</Text>
      <Text style={[styles.kpiValue, color && { color }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function TradeRow({ t, cur, styles, c }) {
  const pnl = Number(t.pnl || 0);
  return (
    <View style={styles.tradeRow}>
      <Text style={[styles.tradeCell, { flex: 1.4, color: c.textSecondary }]} numberOfLines={1}>{new Date(t.closedAt).toLocaleDateString()}</Text>
      <Text style={[styles.tradeCell, { flex: 1.2, fontWeight: '700', color: c.textPrimary }]} numberOfLines={1}>{t.symbol}</Text>
      <Text style={[styles.tradeCell, { width: 42, color: t.side === 'BUY' ? c.bull : c.bear, fontWeight: '700' }]} numberOfLines={1}>{t.side}</Text>
      <Text style={[styles.tradeCell, { flex: 1, textAlign: 'right', color: pnl >= 0 ? c.bull : c.bear, fontWeight: '700' }]} numberOfLines={1}>{money(pnl, cur)}</Text>
    </View>
  );
}

function EquityChart({ data, c }) {
  if (!data?.length) return <Text style={{ color: c.textMuted, fontSize: 12, paddingVertical: 18, textAlign: 'center' }}>No closed trades yet</Text>;
  const W = Math.max(160, Dimensions.get('window').width - 72);
  const H = 120;
  const P = 6;
  const ys = data.map((d) => Number(d.equity) || 0);
  const min = Math.min(0, ...ys);
  const max = Math.max(0, ...ys);
  const range = (max - min) || 1;
  const x = (i) => P + (i / Math.max(1, data.length - 1)) * (W - 2 * P);
  const y = (v) => P + (1 - (v - min) / range) * (H - 2 * P);
  const pts = data.map((d, i) => `${x(i)},${y(Number(d.equity) || 0)}`).join(' ');
  const up = ys[ys.length - 1] >= 0;
  return (
    <Svg width={W} height={H}>
      <Polygon points={`${x(0)},${y(0)} ${pts} ${x(data.length - 1)},${y(0)}`} fill={up ? c.bullSoft : c.bearSoft} />
      <Line x1={P} y1={y(0)} x2={W - P} y2={y(0)} stroke={c.border} strokeWidth="0.5" strokeDasharray="3 3" />
      <Polyline points={pts} fill="none" stroke={up ? c.bull : c.bear} strokeWidth="2" strokeLinejoin="round" />
    </Svg>
  );
}

function PnlBars({ data, c }) {
  if (!data?.length) return <Text style={{ color: c.textMuted, fontSize: 12, paddingVertical: 18, textAlign: 'center' }}>No P&L data</Text>;
  const W = Math.max(160, Dimensions.get('window').width - 72);
  const H = 110;
  const P = 6;
  const max = Math.max(1, ...data.map((d) => Math.abs(Number(d.pnl) || 0)));
  const bw = (W - 2 * P) / data.length;
  const zeroY = H / 2;
  const scale = (H / 2 - P) / max;
  return (
    <Svg width={W} height={H}>
      <Line x1={P} y1={zeroY} x2={W - P} y2={zeroY} stroke={c.border} strokeWidth="0.5" />
      {data.map((d, i) => {
        const v = Number(d.pnl) || 0;
        const h = Math.max(1, Math.abs(v) * scale);
        const xx = P + i * bw + bw * 0.15;
        const yy = v >= 0 ? zeroY - h : zeroY;
        return <Rect key={i} x={xx} y={yy} width={bw * 0.7} height={h} rx="1" fill={v >= 0 ? c.bull : c.bear} />;
      })}
    </Svg>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Styles
// ═══════════════════════════════════════════════════════════════════════════
const makeStyles = (c) => StyleSheet.create({
  // Hero
  hero: { gap: 6 },
  eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1, color: c.primary500 },
  h1: { fontSize: 24, fontWeight: '900', color: c.textPrimary },
  heroSub: { fontSize: 13, color: c.textMuted, lineHeight: 19 },
  primaryBtn: { alignSelf: 'flex-start', marginTop: 8, backgroundColor: c.primary500, borderRadius: radius.md, paddingHorizontal: 16, paddingVertical: 11 },
  primaryBtnTxt: { color: c.white, fontWeight: '800', fontSize: 14 },

  // Card
  card: { backgroundColor: c.card, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, padding: 14, gap: 12 },
  dashed: { borderStyle: 'dashed', borderColor: c.border },
  boxTitle: { fontSize: 16, fontWeight: '900', color: c.textPrimary },
  boxSub: { fontSize: 12, color: c.textMuted, lineHeight: 18 },
  boxHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },

  // Section header
  secHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  secTitle: { fontSize: 16, fontWeight: '900', color: c.textPrimary },
  secCount: { fontSize: 12, color: c.textMuted, fontWeight: '600' },
  linkTxt: { fontSize: 13, fontWeight: '800', color: c.primary500 },
  archHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  // Names / meta
  nameRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  cardName: { fontSize: 15, fontWeight: '900', color: c.textPrimary, maxWidth: 200 },
  cardMeta: { fontSize: 11, color: c.textMuted, marginTop: 3 },
  cardBio: { fontSize: 12, color: c.textMuted, marginTop: 4, lineHeight: 17 },

  // Avatars
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { color: c.primary500, fontWeight: '900', fontSize: 15 },
  avatarSm: { width: 40, height: 40, borderRadius: 20, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' },
  avatarSmTxt: { color: c.primary500, fontWeight: '900', fontSize: 13 },

  // Badge
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, alignSelf: 'flex-start' },
  badgeTxt: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },

  // Stat row
  statRow: { flexDirection: 'row', gap: 8 },
  stat: { flex: 1, backgroundColor: c.hover, borderRadius: radius.md, paddingVertical: 8, alignItems: 'center' },
  statLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5, color: c.textMuted, textTransform: 'uppercase' },
  statValue: { fontSize: 14, fontWeight: '900', marginTop: 2, fontVariant: ['tabular-nums'] },

  // Box P&L + fee
  pnlBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: c.hover, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 8 },
  pnlLabel: { fontSize: 11, color: c.textMuted },
  pnlValue: { fontSize: 14, fontWeight: '900', fontVariant: ['tabular-nums'] },
  feeLine: { fontSize: 11, color: c.textMuted },
  warnLine: { fontSize: 11, color: c.bear, backgroundColor: c.bearSoft, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 6 },
  boxActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 4 },

  // Buttons (card CTAs)
  btn: { height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  btnPrimary: { backgroundColor: c.primary500 },
  btnPrimaryTxt: { color: c.white, fontWeight: '800', fontSize: 14 },
  btnGhost: { borderWidth: 1, borderColor: c.border, backgroundColor: 'transparent' },
  btnGhostTxt: { color: c.textPrimary, fontWeight: '800', fontSize: 14 },

  // Inline action buttons (row of small text buttons)
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  actBtn: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: radius.sm },
  actTxt: { fontSize: 12, fontWeight: '800', color: c.textSecondary },
  runPnl: { fontSize: 15, fontWeight: '900', fontVariant: ['tabular-nums'] },
  runLabel: { fontSize: 10, color: c.textMuted, marginTop: 2 },

  // Search input
  search: { height: 44, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, fontSize: 14, color: c.textPrimary, backgroundColor: c.card },

  // Chips (risk / sort / analytics presets)
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: c.border, backgroundColor: c.card },
  chipOn: { borderColor: c.primary500, backgroundColor: c.primarySoft },
  chipTxt: { fontSize: 13, fontWeight: '700', color: c.textSecondary },

  // Empty states
  emptyCard: { backgroundColor: c.card, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, padding: 22, alignItems: 'center' },
  emptyTxt: { fontSize: 12, color: c.textMuted, textAlign: 'center', lineHeight: 18 },

  // Feed
  feedRow: { flexDirection: 'row', gap: 10, paddingVertical: 10, alignItems: 'flex-start' },
  feedDivider: { borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  feedDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  feedText: { fontSize: 13, color: c.textPrimary, fontWeight: '500', lineHeight: 18 },
  feedMetaRow: { flexDirection: 'row', gap: 6, marginTop: 3, flexWrap: 'wrap' },
  feedMeta: { fontSize: 10, color: c.textMuted },

  // Tab strip
  tabStrip: { flexDirection: 'row', backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, padding: 4, gap: 4 },
  tabBtn: { flex: 1, paddingVertical: 9, borderRadius: radius.sm, alignItems: 'center' },
  tabBtnOn: { backgroundColor: c.primarySoft },
  tabBtnTxt: { fontSize: 13, fontWeight: '800', color: c.textMuted },

  // Sheet
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { maxHeight: '92%', backgroundColor: c.bg, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, overflow: 'hidden' },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  sheetTitle: { fontSize: 16, fontWeight: '900', color: c.textPrimary },
  sheetSub: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  sheetClose: { fontSize: 26, lineHeight: 26, color: c.textMuted, fontWeight: '400' },
  sheetFoot: { flexDirection: 'row', padding: 12, borderTopWidth: 1, borderTopColor: c.borderSubtle, backgroundColor: c.card },

  // Form fields
  fieldLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, color: c.textMuted, marginBottom: 6 },
  fieldHint: { fontSize: 11, color: c.textMuted, marginTop: 6, lineHeight: 16 },
  input: { height: 46, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, fontSize: 15, color: c.textPrimary, backgroundColor: c.card },
  bodyTxt: { fontSize: 13, color: c.textSecondary, lineHeight: 19 },

  // Account picker rows
  acctRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, marginTop: 8, backgroundColor: c.card },
  acctName: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
  acctMeta: { fontSize: 11, color: c.textMuted, marginTop: 2 },
  roMeta: { backgroundColor: c.hover, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10 },
  roMetaTxt: { fontSize: 12, color: c.textSecondary },

  // Risk badge picker
  riskBtn: { borderWidth: 2, borderColor: c.border, borderRadius: radius.md, paddingVertical: 10, alignItems: 'center' },
  riskBtnTxt: { fontSize: 14, fontWeight: '900', color: c.textSecondary },

  // Switch rows
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: c.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10 },
  switchLabel: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
  switchSub: { fontSize: 11, color: c.textMuted, marginTop: 2 },

  // Lot-size grid
  lotGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  lotBtn: { width: '48%', marginBottom: 8, borderWidth: 2, borderColor: c.border, borderRadius: radius.md, padding: 10 },
  lotBtnTxt: { fontSize: 14, fontWeight: '900', color: c.textSecondary },
  lotBtnNote: { fontSize: 10, color: c.textMuted, marginTop: 2 },

  // Stop-copy option cards
  optionCard: { borderWidth: 2, borderRadius: radius.md, padding: 12, gap: 6 },
  optionTitle: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
  optionDesc: { fontSize: 12, color: c.textSecondary, marginLeft: 24 },
  radioOuter: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioInner: { width: 8, height: 8, borderRadius: 4 },

  // Analytics
  panelTitle: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, color: c.textMuted, marginBottom: 6, textTransform: 'uppercase' },
  breakLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 3 },
  breakLabel: { fontSize: 13, color: c.textSecondary },
  breakValue: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  breakDivider: { borderTopWidth: 1, borderTopColor: c.border, marginTop: 6, paddingTop: 2 },
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  kpi: { width: '48%', backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, padding: 10, marginBottom: 8 },
  kpiLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5, color: c.textMuted, textTransform: 'uppercase' },
  kpiValue: { fontSize: 15, fontWeight: '900', color: c.textPrimary, marginTop: 3, fontVariant: ['tabular-nums'] },
  cmpHead: { fontSize: 10, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase' },
  cmpTxt: { fontSize: 13, fontWeight: '700', color: c.textPrimary, marginTop: 3 },
  tradeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
  tradeHead: { fontSize: 10, fontWeight: '800', color: c.textMuted, textTransform: 'uppercase' },
  tradeCell: { fontSize: 12, fontVariant: ['tabular-nums'] },
});
