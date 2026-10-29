import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIsFocused } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { fetchFnoUnderlyings, fetchOptionChain } from '@/api/market.api';
import {
  ChainTable,
  ExpiryChips,
  FutureChip,
  KindPill,
  StatCell,
  UnderlyingChip,
} from '@/components/markets/OptionChainParts';
import { AppText, Card, LoadingView, PageHero, Screen, Select } from '@/components/ui';
import type { AppScreenProps } from '@/navigation/types';
import { useTheme } from '@/theme';
import type { FnoKind, FnoUnderlyings, OptionChain } from '@/types/market';
import {
  GREEKS_STORAGE_KEY,
  OPTION_CHAIN_EMPTY_BODY,
  OPTION_CHAIN_EMPTY_TITLE,
  OPTION_CHAIN_POLL_MS,
  OPTION_CHAIN_SUBTITLE,
  activeKind,
  analyticsCaption,
  chainColumns,
  chainSession,
  chainStats,
  inr,
  kindsAvailable,
  noOptionsText,
  optionChainFootnote,
  spotCaption,
  underlyingOptionLabel,
  underlyingsOfKind,
} from '@/utils/markets';

/**
 * Option chain — `/options?underlying=NIFTY&expiry=2026-10-27`
 * (client/src/pages/OptionChain.jsx): index (NIFTY, BANKNIFTY, SENSEX …),
 * stock and MCX commodity options, one underlying + expiry at a time.
 *
 *   GET /instruments/fno/underlyings  → the picker (Index / Stocks /
 *                                       Commodity (MCX) tabs, every
 *                                       underlying with its expiries)
 *   GET /instruments/option-chain     → strikes × CE / PE for one expiry,
 *                                       with Dhan's OI / IV / Greeks when
 *                                       configured
 *
 * Prices are each contract's own live LTP — what an order fills against — so
 * the chain re-polls every 3 seconds while it is on screen and the app is in
 * the foreground (the web's `!document.hidden`). Tapping a premium (or a
 * future) opens that contract on the trade page. The route params carry the
 * selection, as the web's query does, so StockDetail's "Options chain"
 * button and a deep link land on the same chain.
 *
 * Differences from the web, on purpose:
 *   • Switching underlying, expiry or segment clears the table until the
 *     new chain arrives; the web keeps the previous underlying's table on
 *     screen under the new heading meanwhile.
 *   • Only the newest request's answer lands, so a slow poll cannot put an
 *     older chain back.
 *   • The Greeks toggle is remembered in AsyncStorage under the web's
 *     localStorage key (`eh:oc:greeks`).
 *   • Pull to refresh re-reads the picker (if it failed) and the chain.
 */

let greeksCache: boolean | null = null;

function useGreeksToggle(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState<boolean>(greeksCache ?? false);
  useEffect(() => {
    if (greeksCache !== null) return;
    AsyncStorage.getItem(GREEKS_STORAGE_KEY)
      .then((v) => { greeksCache = v === '1'; setOn(greeksCache); })
      .catch(() => { /* private mode — default off */ });
  }, []);
  const set = useCallback((v: boolean) => {
    greeksCache = v;
    setOn(v);
    AsyncStorage.setItem(GREEKS_STORAGE_KEY, v ? '1' : '0').catch(() => { /* ignore */ });
  }, []);
  return [on, set];
}

export function OptionChainScreen({ route, navigation }: AppScreenProps<'Options'>): React.JSX.Element {
  const t = useTheme();
  const focused = useIsFocused();
  const underlying = (route.params?.underlying || '').toUpperCase();
  const expiryParam = route.params?.expiry || '';

  const [meta, setMeta] = useState<FnoUnderlyings | null>(null);
  const [metaError, setMetaError] = useState('');
  const [chain, setChain] = useState<OptionChain | null>(null);
  const [chainError, setChainError] = useState('');
  const [loading, setLoading] = useState(false);
  const [kindTab, setKindTab] = useState<FnoKind | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showGreeks, setShowGreeks] = useGreeksToggle();
  const [nowMs, setNowMs] = useState(() => Date.now());

  /* ── The picker — once (it changes daily) ────────────────────────── */
  const loadMeta = useCallback(async (): Promise<void> => {
    try {
      const m = await fetchFnoUnderlyings();
      setMeta(m);
      setMetaError('');
    } catch (e) {
      setMetaError(errorMessage(e));
    }
  }, []);
  useEffect(() => { void loadMeta(); }, [loadMeta]);

  const list = useMemo(() => meta?.underlyings ?? [], [meta]);
  const current = useMemo(() => list.find((u) => u.underlying === underlying) ?? null, [list, underlying]);
  const kinds = useMemo(() => kindsAvailable(list), [list]);
  const kind = activeKind(current, kindTab, list);
  const inKind = useMemo(() => underlyingsOfKind(list, kind), [list, kind]);

  const pick = useCallback((u: string, expiry?: string) => {
    navigation.setParams({ underlying: u, expiry: expiry || undefined });
  }, [navigation]);

  // No (valid) underlying in the route → the first of the tab.
  useEffect(() => {
    if (!meta || current || underlying) return;
    const first = inKind[0];
    if (first) navigation.setParams({ underlying: first.underlying, expiry: undefined });
  }, [meta, current, underlying, inKind, navigation]);

  /* ── The chain — fetch, then poll while on screen ────────────────── */
  const chainKey = current ? `${underlying}|${expiryParam}|${current.kind ?? ''}` : '';
  const shownKey = useRef('');
  const seq = useRef(0);
  const shownRefresh = useRef(0);

  useEffect(() => {
    if (!current) {
      shownKey.current = '';
      setChain(null);
      setChainError('');
      setLoading(false);
      return undefined;
    }
    const fresh = shownKey.current !== chainKey;
    if (fresh) {
      shownKey.current = chainKey;
      setChain(null);
    }
    if (!focused) return undefined;

    let off = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async (first: boolean): Promise<void> => {
      seq.current += 1;
      const mine = seq.current;
      if (first) { setLoading(true); setChainError(''); }
      try {
        const c = await fetchOptionChain(underlying, expiryParam || null, current.kind);
        if (off || mine !== seq.current) return;
        setChain(c);
        setChainError('');
        setNowMs(Date.now());
      } catch (e) {
        if (!off && mine === seq.current && first) {
          setChain(null);
          setChainError(errorMessage(e));
        }
      } finally {
        if (!off && first) setLoading(false);
      }
    };
    const tick = async (): Promise<void> => {
      if (AppState.currentState === 'active') await load(false);
      if (!off) timer = setTimeout(() => { void tick(); }, OPTION_CHAIN_POLL_MS);
    };
    // A new chain, or a pull to refresh, loads loudly; coming back into focus quietly.
    const loud = fresh || shownRefresh.current !== refreshKey;
    shownRefresh.current = refreshKey;
    void load(loud).then(() => {
      if (!off) timer = setTimeout(() => { void tick(); }, OPTION_CHAIN_POLL_MS);
    });
    return () => { off = true; if (timer) clearTimeout(timer); };
    // `current` is read through chainKey; its identity changes with every picker read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainKey, focused, refreshKey]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (!meta) await loadMeta();
      setRefreshKey((k) => k + 1);
    } finally {
      setRefreshing(false);
    }
  }, [meta, loadMeta]);

  const openContract = useCallback((symbol: string) => {
    if (symbol) navigation.navigate('Trade', { symbol });
  }, [navigation]);

  const an = chain?.analytics ?? null;
  const cols = chainColumns(!!an, showGreeks);
  const session = chain ? chainSession(chain.exchange, chain.kind) : null;

  return (
    <Screen onRefresh={onRefresh} refreshing={refreshing} testID="option-chain">
      <PageHero eyebrow="F&O" title="Option Chain" subtitle={OPTION_CHAIN_SUBTITLE} />

      {!meta && !metaError ? <LoadingView /> : null}
      {metaError ? (
        <Card style={styles.mt16}><AppText variant="body" tone="bear">{metaError}</AppText></Card>
      ) : null}
      {meta && !list.length ? (
        <Card style={[styles.mt16, styles.center]}>
          <AppText variant="title" align="center" testID="chain-unavailable">{OPTION_CHAIN_EMPTY_TITLE}</AppText>
          <AppText variant="body" tone="secondary" align="center" style={styles.mt4}>{OPTION_CHAIN_EMPTY_BODY}</AppText>
        </Card>
      ) : null}

      {meta && list.length > 0 ? (
        <>
          {/* Segment tabs */}
          <View style={[styles.wrap, styles.mt16]} accessibilityRole="tablist">
            {kinds.map((k) => (
              <KindPill
                key={k.key}
                label={k.label}
                active={kind === k.key}
                onPress={() => {
                  setKindTab(k.key);
                  const first = underlyingsOfKind(list, k.key)[0];
                  if (first) pick(first.underlying);
                }}
              />
            ))}
          </View>

          {/* Underlying picker — chips for index / MCX, a select for the longer stock list */}
          <Card style={styles.mt16}>
            {kind === 'STOCK' ? (
              <Select<string>
                label="Stock"
                value={current?.kind === 'STOCK' ? underlying : null}
                placeholder="Select a stock…"
                options={inKind.map((u) => ({ value: u.underlying, label: underlyingOptionLabel(u) }))}
                onChange={(v) => pick(v)}
                title="Stock"
              />
            ) : (
              <View style={styles.wrap}>
                {inKind.map((u) => (
                  <UnderlyingChip key={u.underlying} label={u.underlying} active={underlying === u.underlying} onPress={() => pick(u.underlying)} />
                ))}
              </View>
            )}
            {current ? (
              <View style={styles.mt12}>
                <ExpiryChips
                  current={current}
                  selected={chain?.expiry ?? null}
                  nowMs={nowMs}
                  onPick={(e) => pick(current.underlying, e)}
                />
              </View>
            ) : null}
          </Card>

          {underlying && !current ? (
            <Card style={styles.mt16}>
              <AppText variant="body" tone="secondary">{noOptionsText(underlying)}</AppText>
            </Card>
          ) : null}

          {current ? (
            <>
              {/* Underlying summary */}
              <Card style={styles.mt16}>
                <View style={styles.summaryTop}>
                  <View style={styles.flex}>
                    <AppText variant="caption" weight="600" tone="muted">{spotCaption(current, chain)}</AppText>
                    <AppText variant="h2" mono testID="chain-spot">{inr(chain?.spot?.lastPrice)}</AppText>
                  </View>
                  {session ? (
                    <View
                      style={[
                        styles.session,
                        { backgroundColor: session.isOpen ? t.alpha(t.colors.bull, 0.1) : t.colors.bgHover },
                      ]}
                    >
                      <View style={[styles.dot, { backgroundColor: session.isOpen ? t.colors.bull : t.colors.textMuted }]} />
                      <AppText variant="caption" weight="600" color={session.isOpen ? t.colors.bull : t.colors.textMuted}>{session.label}</AppText>
                    </View>
                  ) : null}
                </View>
                <View style={[styles.stats, styles.mt12]}>
                  {chainStats(chain).map((s) => <StatCell key={s.label} label={s.label} value={s.value} />)}
                </View>
              </Card>

              {current.futures.length > 0 ? (
                <View style={[styles.wrap, styles.mt12]}>
                  {current.futures.map((f) => (
                    <FutureChip key={f.symbol} symbol={f.symbol} lastPrice={f.lastPrice} onPress={() => openContract(f.symbol)} />
                  ))}
                </View>
              ) : null}

              {/* The chain */}
              <Card padded={false} style={[styles.mt16, styles.chainCard]}>
                {an ? (
                  <View style={[styles.anBar, { borderBottomColor: t.colors.borderSubtle }]}>
                    <AppText variant="micro" tone="muted" style={styles.flex}>{analyticsCaption(an.asOf)}</AppText>
                    <Pressable
                      accessibilityRole="switch"
                      accessibilityState={{ checked: showGreeks }}
                      accessibilityLabel="Greeks"
                      onPress={() => setShowGreeks(!showGreeks)}
                      style={[
                        styles.greeks,
                        showGreeks
                          ? { backgroundColor: t.colors.primary, borderColor: t.colors.primary }
                          : { borderColor: t.colors.borderDark },
                      ]}
                    >
                      <AppText variant="caption" weight="600" color={showGreeks ? t.colors.onPrimary : t.colors.textSecondary}>Greeks</AppText>
                    </Pressable>
                  </View>
                ) : null}
                {loading && !chain ? (
                  <AppText variant="body" tone="muted" align="center" style={styles.msg}>Loading option chain…</AppText>
                ) : null}
                {chainError ? (
                  <AppText variant="body" tone="bear" style={styles.msg} testID="chain-error">{chainError}</AppText>
                ) : null}
                {chain ? <ChainTable chain={chain} cols={cols} onTrade={openContract} /> : null}
              </Card>

              <AppText variant="caption" tone="muted" style={styles.footnote}>{optionChainFootnote(chain)}</AppText>
            </>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  center: { alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  mt4: { marginTop: 4 },
  mt12: { marginTop: 12 },
  mt16: { marginTop: 16 },
  summaryTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  session: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24, rowGap: 12 },
  chainCard: { overflow: 'hidden' },
  anBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  greeks: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, borderWidth: 1 },
  msg: { padding: 24 },
  footnote: { marginTop: 12, lineHeight: 18 },
});
