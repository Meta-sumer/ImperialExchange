import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { subscriptionApi } from '@/api/subscription.api';
import { fetchPositions } from '@/api/trading.api';
import { walletApi } from '@/api/wallet.api';
import { AppText, Button, Screen } from '@/components/ui';
import { WalletNav } from '@/components/wallet/WalletNav';
import { WithdrawalMethodsModal } from '@/components/wallet/WithdrawalMethods';
import type { AppScreenProps } from '@/navigation/types';
import { useAuthStore } from '@/store/auth';
import { useSelectedAccountStore } from '@/store/selectedAccount';
import { useTheme } from '@/theme';
import type { Position } from '@/types/trading';
import type { Deposit, LedgerEntry, WalletBalance, WalletTransaction, Withdrawal } from '@/types/wallet';
import {
  subscribePositions,
  subscribeTickers,
  subscribeWallet,
  useForeground,
} from '@/websocket/channels';
import {
  DEFAULT_WALLET_VIEW,
  accountsStateOf,
  createSourceSequencer,
  deepLinkView,
  isHubView,
  markReady,
  showsRecentStrip,
  showsViewAll,
  withSourceError,
  type SourceErrors,
  type SourceReady,
  type WalletHubView,
  type WalletSource,
} from '@/utils/walletLogic';

import { RecentTransactions, SupportStrip } from './RecentTransactions';
import { AccountDetailsView } from './views/AccountDetailsView';
import { DepositView } from './views/DepositView';
import { HistoryView } from './views/HistoryView';
import { OverviewView } from './views/OverviewView';
import { TransferView } from './views/TransferView';
import { WithdrawView } from './views/WithdrawView';

/** A burst of wallet events (a close-all settles many) is one reload. */
const EVENT_DEBOUNCE_MS = 300;
/**
 * The web re-marks open positions on every tick. Here the P&L is the
 * server's (PORT-RULINGS §2), so a tick on a held symbol re-reads the
 * positions — at most this often.
 */
const TICK_REFRESH_MS = 5_000;

type Source = WalletSource;

interface WalletData {
  balances: WalletBalance[];
  deposits: Deposit[];
  withdrawals: Withdrawal[];
  ledger: LedgerEntry[];
  positions: Position[];
  /**
   * /subscriptions/history — plan charges (BONUS) and the retired Main
   * Wallet's old rows (MAIN, read-only); Transaction History shows them.
   */
  subscriptions: WalletTransaction[];
  /** The Bonus Wallet's transactions — likewise. */
  bonusTx: WalletTransaction[];
  /** The page's first load has not finished (Wallet.jsx `loading`). */
  loading: boolean;
  /**
   * The sources that have answered at least once. Until one has, a figure
   * built from it is unknown — shown as a dash, never as "$0.00".
   */
  ready: SourceReady;
  /** Each source's latest failure (cleared when its next request succeeds). */
  errors: SourceErrors;
  /** Re-fetch everything. `accounts: false` skips the account list (a socket nudge the store already heard). */
  load: (opts?: { accounts?: boolean }) => Promise<void>;
  refreshPositions: () => Promise<void>;
}

/**
 * Wallet.jsx `load()`: every endpoint applies its own result the moment it
 * lands — the accounts box must not wait for a 100-row ledger —
 * and a failure degrades that one source, never the page.
 *
 * Unlike the web, loads overlap here (socket nudges, pull-to-refresh, the
 * foreground, coming back from another screen, a finished deposit), so each
 * source takes only the answer to its NEWEST request: a slow response to an
 * older one would otherwise land last and put pre-change figures back.
 */
function useWalletData(): WalletData {
  const [balances, setBalances] = useState<WalletBalance[]>([]);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [subscriptions, setSubscriptions] = useState<WalletTransaction[]>([]);
  const [bonusTx, setBonusTx] = useState<WalletTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState<SourceReady>({});
  const [errors, setErrors] = useState<SourceErrors>({});
  // Re-armed in the effect body: StrictMode and Fast Refresh replay an
  // effect's cleanup and then its setup, and a flag that only ever went
  // false dropped every later result — the page sat on "Loading…" forever.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const sequencer = useRef(createSourceSequencer()).current;

  /**
   * One source's request. Its answer lands only if it is still the newest
   * request for that source. `quiet` requests (the ticker-driven positions
   * re-read) never raise the banner — the next event retries them.
   */
  const fetchInto = useCallback(<T,>(
    source: Source,
    request: () => Promise<T>,
    apply: (v: T) => void,
    quiet = false,
  ): Promise<void> => {
    const isLatest = sequencer.begin(source);
    return request().then(
      (v) => {
        if (!alive.current || !isLatest()) return;
        apply(v);
        setReady((r) => markReady(r, source));
        setErrors((e) => withSourceError(e, source, null));
      },
      (err: unknown) => {
        if (!alive.current || !isLatest() || quiet) return;
        setErrors((e) => withSourceError(e, source, errorMessage(err)));
      },
    );
  }, [sequencer]);

  const load = useCallback(async (opts: { accounts?: boolean } = {}): Promise<void> => {
    const tasks: Promise<unknown>[] = [
      fetchInto('balances', () => walletApi.balances(), setBalances),
      fetchInto('deposits', () => walletApi.deposits(), setDeposits),
      fetchInto('withdrawals', () => walletApi.withdrawals(), setWithdrawals),
      fetchInto('ledger', () => walletApi.ledger({ limit: 100 }), setLedger),
      fetchInto('positions', () => fetchPositions(), setPositions),
      // Plan-billing rows (incl. the old Main Wallet's) and the Bonus ledger,
      // for Transaction History.
      fetchInto('subscriptions', () => subscriptionApi.history({ limit: 100 }), setSubscriptions),
      fetchInto('bonusTx', () => walletApi.bonusHistory(100), setBonusTx),
    ];
    // The accounts live in the app-wide store; it keeps its own error and
    // loading state, which Account Details reads.
    if (opts.accounts !== false) tasks.push(useSelectedAccountStore.getState().load());

    await Promise.allSettled(tasks);
    if (!alive.current) return;
    setLoading(false);
  }, [fetchInto]);

  const refreshPositions = useCallback(
    (): Promise<void> => fetchInto('positions', () => fetchPositions(), setPositions, true),
    [fetchInto],
  );

  return { balances, deposits, withdrawals, ledger, positions, subscriptions, bonusTx, loading, ready, errors, load, refreshPositions };
}

/**
 * The Wallet — EquityHub's client/src/pages/Wallet.jsx (served at /wallet,
 * /accounts, /funds). The web's left sidebar is the horizontal rail it
 * shows on narrow screens; each item opens the same view: Account Details,
 * Account Overview (the landing view), Deposit, Withdraw, Internal Transfer
 * and Transaction History, with the Bonus Wallet as its own page (the
 * retired Main Wallet's item is gone). Withdrawal Methods opens the manager as a modal over the current
 * view, as on the web. Under every view but the overview sit the Recent
 * Transactions strip and the support line.
 *
 * Live: reloads on `user:wallet` and `user:positions`, on return to the
 * foreground, on coming back from another screen (the web remounts on every
 * visit), and re-reads positions as held symbols tick.
 *
 * Deep links: `?action=deposit|withdraw|transfer` and `?view=<id>` open that
 * view (or the methods manager) once; the param is then cleared so coming
 * back does not reopen it.
 */
export function WalletScreen({ navigation, route }: AppScreenProps<'Wallet'>): React.JSX.Element {
  const t = useTheme();
  const user = useAuthStore((s) => s.user);
  const accounts = useSelectedAccountStore((s) => s.accounts);
  const accountsLoading = useSelectedAccountStore((s) => s.loading);
  const accountsError = useSelectedAccountStore((s) => s.error);

  const data = useWalletData();
  const { load, refreshPositions } = data;

  const [view, setViewState] = useState<WalletHubView>(() => {
    const initial = deepLinkView(route.params);
    return initial && initial !== 'withdrawal-methods' ? initial : DEFAULT_WALLET_VIEW;
  });
  // The Withdrawal Methods manager — a modal on this page, not a view.
  const [methodsOpen, setMethodsOpen] = useState(() => deepLinkView(route.params) === 'withdrawal-methods');
  const [refreshKey, setRefreshKey] = useState(0);
  const scrollRef = useRef<ScrollView>(null);

  const setView = useCallback((v: WalletHubView): void => {
    if (v === 'withdrawal-methods') setMethodsOpen(true);
    else setViewState(v);
  }, []);

  /* ── Deep link ── */
  const action = route.params?.action;
  const viewParam = route.params?.view;
  useEffect(() => {
    const target = deepLinkView({ action, view: viewParam });
    if (action !== undefined || viewParam !== undefined) navigation.setParams({ action: undefined, view: undefined });
    if (target) setView(target);
  }, [action, viewParam, navigation, setView]);

  /* ── Load, live refresh ── */
  useEffect(() => { void load(); }, [load]);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const nudge = (): void => {
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => { debounce.current = null; void load({ accounts: false }); }, EVENT_DEBOUNCE_MS);
    };
    const offWallet = subscribeWallet(nudge);
    const offPositions = subscribePositions(nudge);
    return () => {
      offWallet();
      offPositions();
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [load]);

  useForeground(() => { void load(); });

  // Coming back from another screen. On the web every visit to /wallet is a
  // fresh mount, so leaving for the Bonus Wallet, Plans or a
  // new account and coming back re-runs load() and AccountOverview's own
  // fetches. A native stack keeps this screen mounted underneath, so without
  // this the overview would still show the Bonus Wallet balance from before
  // the top-up the user just made there.
  useEffect(() => {
    let away = false;
    const offBlur = navigation.addListener('blur', () => { away = true; });
    const offFocus = navigation.addListener('focus', () => {
      if (!away) return;
      away = false;
      setRefreshKey((k) => k + 1);
      void load();
    });
    return () => { offBlur(); offFocus(); };
  }, [navigation, load]);

  // Positions feed the overview alone (its open / winning / losing counts),
  // so the ticker-driven re-read runs only while it is on screen — not a
  // /trading/positions request every few seconds under the history list.
  const onOverview = view === 'overview';
  const symbolsKey = useMemo(
    () => [...new Set(data.positions.filter((p) => !p.isBroker).map((p) => p.symbol))].sort().join(','),
    [data.positions],
  );
  // Coming back to the overview: the list may be minutes old by now.
  const wasOnOverview = useRef(onOverview);
  useEffect(() => {
    if (onOverview && !wasOnOverview.current) void refreshPositions();
    wasOnOverview.current = onOverview;
  }, [onOverview, refreshPositions]);
  useEffect(() => {
    if (!symbolsKey || !onOverview) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    const off = subscribeTickers(symbolsKey.split(','), () => {
      if (timer) return;
      const wait = Math.max(0, TICK_REFRESH_MS - (Date.now() - last));
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        void refreshPositions();
      }, wait);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [symbolsKey, onOverview, refreshPositions]);

  /* ── Scroll to the top when the view changes ── */
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  }, [view]);

  const refreshAll = useCallback(async (): Promise<void> => {
    setRefreshKey((k) => k + 1);
    await load();
  }, [load]);

  const toOverview = useCallback(() => setView('overview'), [setView]);
  const doneToOverview = useCallback(() => { void load(); setView('overview'); }, [load, setView]);
  const reload = useCallback(() => { void load(); }, [load]);

  const errorList = Object.values(data.errors).filter((m): m is string => !!m);

  // Until the list has answered once, "no accounts" is a guess (Wallet.jsx
  // starts `accountsLoading` true), and a failed load is not "none" either.
  const accountsState = accountsStateOf({
    count: accounts.length,
    loading: accountsLoading,
    error: accountsError,
    pageLoading: data.loading,
  });

  const content = ((): React.JSX.Element => {
    switch (view) {
      // refreshKey: the hub's pull-to-refresh and its return from another
      // screen re-read the open flow's own balances / withdrawals too.
      case 'grow':
        return <DepositView onDone={doneToOverview} onCancel={toOverview} refreshKey={refreshKey} />;
      case 'withdraw':
        return <WithdrawView onDone={doneToOverview} onCancel={toOverview} refreshKey={refreshKey} />;
      case 'transfer':
        return <TransferView onDone={reload} refreshKey={refreshKey} onOpenAccount={() => navigation.navigate('NewAccountTiers')} />;
      case 'history':
        return (
          <HistoryView
            deposits={data.deposits}
            withdrawals={data.withdrawals}
            ledger={data.ledger}
            subscriptions={data.subscriptions}
            bonusTx={data.bonusTx}
            accounts={accounts}
            loading={data.loading}
          />
        );
      case 'details':
        return (
          <AccountDetailsView
            user={user}
            accounts={accounts}
            accountsError={accountsError}
            accountsLoading={accountsState === 'loading'}
            balances={data.balances}
            balancesReady={!!data.ready.balances}
            onRefresh={reload}
            setView={setView}
          />
        );
      case 'overview':
      default:
        return (
          <OverviewView
            accounts={accounts}
            accountsState={accountsState}
            deposits={data.deposits}
            withdrawals={data.withdrawals}
            positions={data.positions}
            ready={data.ready}
            refreshKey={refreshKey}
            setView={setView}
            onRetryAccounts={reload}
          />
        );
    }
  })();

  return (
    <Screen onRefresh={refreshAll} scrollRef={scrollRef}>
      <WalletNav activeId={view} onSelect={(id) => { if (isHubView(id)) setView(id); }} />

      {errorList.length > 0 ? (
        // The web swallows these; on a money screen an empty list that is
        // really a failed request reads as "you have nothing", so say so.
        <View
          accessibilityRole="alert"
          style={[styles.banner, { backgroundColor: t.colors.bearSoft, borderColor: t.alpha(t.colors.bear, 0.3), borderRadius: t.radius.xl }]}
        >
          <View style={styles.flex}>
            <AppText variant="bodyStrong" tone="bear">Some wallet data could not be loaded</AppText>
            <AppText variant="small" tone="secondary">{errorList[0]}</AppText>
          </View>
          <Button title="Retry" variant="secondary" size="sm" onPress={reload} />
        </View>
      ) : null}

      {content}

      {showsRecentStrip(view) ? (
        <>
          <RecentTransactions
            deposits={data.deposits}
            withdrawals={data.withdrawals}
            onViewAll={showsViewAll(view) ? () => setView('history') : undefined}
          />
          <SupportStrip />
        </>
      ) : null}

      <WithdrawalMethodsModal open={methodsOpen} onClose={() => setMethodsOpen(false)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, padding: 12, marginBottom: 16 },
});
