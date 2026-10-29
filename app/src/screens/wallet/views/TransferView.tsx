import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { errorMessage } from '@/api/client';
import { walletApi } from '@/api/wallet.api';
import {
  AppText,
  Button,
  Card,
  ErrorView,
  Input,
  LoadingView,
  Modal,
  Segmented,
  Select,
  toast,
} from '@/components/ui';
import { useSelectedAccountStore } from '@/store/selectedAccount';
import { avatarGradient, makeStyles, useTheme } from '@/theme';
import type { UserAccount } from '@/types/user';
import {
  DEFAULT_PEER_TRANSFER_SETTINGS,
  type BonusWallet,
  type PeerTransferSettings,
  type TransferRecipient,
  type WalletBalance,
} from '@/types/wallet';
import { EMPTY, fmtMoney } from '@/utils/money';
import {
  DEMO_TRANSFER_NOTE,
  PEER_NOTE_MAX,
  PEER_NO_LIVE_NOTE,
  PEER_SEARCH_DEBOUNCE_MS,
  PEER_SEARCH_LIMIT,
  PEER_SEARCH_MIN_CHARS,
  TRANSFER_CURRENCY,
  accountsGate,
  bonusWalletShortcut,
  canReviewPeer,
  checkSelfTransfer,
  freeLabel,
  initialPeerSource,
  demoAccounts,
  initialSelfPair,
  isPracticeSource,
  liveAccounts,
  loadableAvatar,
  peerAmountErrors,
  peerConfirmNote,
  peerFeeCaveat,
  peerFromOptions,
  peerLimitsHint,
  peerQuote,
  peerSentMessage,
  peerSettingsAfter,
  peerTransferPayload,
  recipientInitials,
  recipientSubline,
  reseedPeerSource,
  reseedSelfPair,
  sanitizeAmount,
  searchPhase,
  selfFromOptions,
  selfSubmitRefusal,
  selfToOptions,
  selfTransferPayload,
  showBonusShortcut,
  snapshotMissing,
  sourceFree,
  type FinishedSearch,
  type PeerSettingsState,
} from '@/utils/transferLogic';
import { useChannel, useForeground } from '@/websocket/channels';

/**
 * Transfer Funds — Wallet.jsx TransferView (:2827) and TransferToUserPanel
 * (:3105), rendered by the Wallet hub for its "Internal Transfer" item.
 *
 * Two modes under one heading, as on the web:
 *   • Between my accounts — POST /wallet/transfers. From: live trading
 *     accounts, the Bonus Wallet ('bonus'), then demo accounts. To: the same
 *     side of the demo / live line only (demo → demo; live / Bonus → live /
 *     Bonus) — practice money never becomes real. The retired Main Wallet is
 *     not offered.
 *   • Send to another user — from one of the user's LIVE trading accounts
 *     to a registered user found by their public User ID, who receives it
 *     in their trading account. POST /wallet/transfer-user, within the
 *     admin's limits and fee.
 *
 * The web hands this view `accounts` and `balances` from the Wallet page;
 * here it reads the accounts from the shared store (CONTRACT §8) and loads
 * the balances itself, refreshing them on the same `user:wallet` /
 * `user:positions` events the web page reloads on, and on return to the
 * foreground as the hub does (events missed in the background never
 * arrive). The Bonus Wallet snapshot is fetched as on the web — and again
 * after a transfer, on its own socket events and on the foreground; one
 * that failed to load offers a retry. The peer limits and fee are read on
 * open and on each pull-to-refresh; a failed read is shown with a retry.
 *
 * A confirm sheet closes if what it confirms changes under it (the account
 * list moved and a re-seed swapped the source) — see transferLogic, 7.
 *
 * Every rule is in utils/transferLogic, pinned against the web source in
 * stage2_transfer.logic.test.ts; the differences are listed there.
 */

type Mode = 'self' | 'user';

const MODES: { value: Mode; label: string }[] = [
  { value: 'self', label: 'Between my accounts' },
  { value: 'user', label: 'Send to another user' },
];

/** Where the web's Currency select was: EquityHub is INR-only. */
function FixedCurrency(): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  return (
    <View>
      <AppText variant="label" style={s.label}>Currency</AppText>
      <View style={[s.fixedCcy, { borderColor: t.colors.borderDark, backgroundColor: t.colors.bgHover }]}>
        <AppText variant="body" weight="600">INR (₹)</AppText>
      </View>
    </View>
  );
}

/** A burst of wallet events (a close-all settles many) is one reload. */
const RELOAD_DEBOUNCE_MS = 500;

export interface TransferViewProps {
  /** A transfer went through — the hub reloads what it shows (the web's `load`). */
  onDone: () => void;
  /**
   * Optional: the hub's pull-to-refresh counter. When it changes, this view
   * reloads its own balances and Bonus Wallet snapshot as well.
   */
  refreshKey?: number;
  /**
   * "Open one →" under the peer source when the user has no live account
   * (the web links /accounts/new). Without it the link is not drawn.
   */
  onOpenAccount?: () => void;
}

export function TransferView({ onDone, refreshKey, onOpenAccount }: TransferViewProps): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  const [mode, setMode] = useState<Mode>('self');

  /* ── Accounts (shared store) ────────────────────────────────────────── */
  const accounts = useSelectedAccountStore((st) => st.accounts);
  const accountsLoading = useSelectedAccountStore((st) => st.loading);
  const accountsError = useSelectedAccountStore((st) => st.error);
  const live = useMemo(() => liveAccounts(accounts), [accounts]);
  const demo = useMemo(() => demoAccounts(accounts), [accounts]);

  // Only the FIRST load of the list may hold the form back — the store
  // re-fetches (and flips `loading`) on every wallet event. See accountsGate.
  const [accountsEverReady, setAccountsEverReady] = useState(false);
  const gate = accountsGate({
    everReady: accountsEverReady,
    count: accounts.length,
    loading: accountsLoading,
    error: accountsError,
  });
  useEffect(() => {
    if (gate === 'ready' && !accountsEverReady) setAccountsEverReady(true);
  }, [gate, accountsEverReady]);

  /* ── Balances and the Bonus Wallet snapshot ─────────────────────────── */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const [balances, setBalances] = useState<WalletBalance[] | null>(null);
  const [balancesError, setBalancesError] = useState<unknown>(null);
  const balanceSeq = useRef(0);

  const loadBalances = useCallback(async (): Promise<void> => {
    const mine = ++balanceSeq.current;
    try {
      const rows = await walletApi.balances();
      if (!alive.current || mine !== balanceSeq.current) return;
      setBalances(rows);
      setBalancesError(null);
    } catch (err) {
      if (!alive.current || mine !== balanceSeq.current) return;
      // Rows already on screen stay; only a first load that fails shows the error.
      setBalancesError(err);
    }
  }, []);

  const [bonusWallet, setBonusWallet] = useState<BonusWallet | null>(null);
  /** The latest fetch failed. A snapshot already shown is kept. */
  const [bonusFailed, setBonusFailed] = useState(false);

  const walletSeq = useRef(0);

  /** Wallet.jsx loadBonus — non-fatal. */
  const loadUserWallets = useCallback(async (): Promise<void> => {
    const mine = ++walletSeq.current;
    const [bonus] = await Promise.allSettled([walletApi.bonusWallet()]);
    // An overtaken load (a transfer and a socket event close together) never
    // lands over a newer answer.
    if (!alive.current || mine !== walletSeq.current) return;
    if (bonus.status === 'fulfilled') setBonusWallet(bonus.value);
    setBonusFailed(bonus.status === 'rejected');
  }, []);

  // On mount, and again on each pull-to-refresh of the hub.
  useEffect(() => {
    void loadBalances();
    void loadUserWallets();
  }, [loadBalances, loadUserWallets, refreshKey]);

  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleBalances = useCallback((): void => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      void loadBalances();
    }, RELOAD_DEBOUNCE_MS);
  }, [loadBalances]);
  useEffect(() => () => { if (reloadTimer.current) clearTimeout(reloadTimer.current); }, []);

  useChannel('user:wallet', scheduleBalances);
  useChannel('user:positions', scheduleBalances);
  useChannel('user:bonusWallet', () => { void loadUserWallets(); });
  useChannel('user:subscription', () => { void loadUserWallets(); });
  // The hub reloads its own figures on the foreground; these are this
  // view's copy and would otherwise stay as they were when the app left.
  useForeground(() => {
    void loadBalances();
    void loadUserWallets();
  });

  const afterTransfer = useCallback((): void => {
    void loadBalances();
    void loadUserWallets();
    onDone();
  }, [loadBalances, loadUserWallets, onDone]);

  /* ── Between my accounts ────────────────────────────────────────────── */
  const [pair, setPair] = useState(() => initialSelfPair(live, demo));
  const { from, to } = pair;

  // The pickers seed from the list at mount; the list can arrive (or change)
  // afterwards, and a new source can take the destination off the To list.
  // Wallet.jsx TransferView's two effects.
  useEffect(() => {
    setPair((p) => reseedSelfPair(live, demo, p) ?? p);
  }, [live, demo, from]);

  const currency = TRANSFER_CURRENCY;
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [confirm, setConfirm] = useState(false);

  // A confirm is for the pair it was opened on. The pickers cannot be
  // touched while it is up, so a change here is the account list moving
  // under it (an account suspended or closed) — the re-seed above swaps in
  // another account. Close it rather than let "Confirm Transfer" post a pair
  // the trader never reviewed.
  useEffect(() => { setConfirm(false); }, [from, to]);

  const fromOptions = useMemo(() => selfFromOptions(live, demo), [live, demo]);
  const toOptions = useMemo(() => selfToOptions(live, demo, from), [live, demo, from]);
  const fromOpt = fromOptions.find((o) => o.value === from);
  const toOpt = toOptions.find((o) => o.value === to);
  const fromPractice = isPracticeSource(demo, from);
  const free = sourceFree({ from, currency, balances, bonus: bonusWallet });
  const check = checkSelfTransfer({ from, to, amount, free });
  const retryFree = snapshotMissing({ from, bonus: bonusWallet, failed: bonusFailed })
    ? () => { void loadUserWallets(); }
    : undefined;

  const pickFrom = (v: string): void => {
    setPair((p) => reseedSelfPair(live, demo, { ...p, from: v }) ?? { ...p, from: v });
  };
  const pickTo = (v: string): void => {
    setPair((p) => ({ ...p, to: v }));
  };
  const toBonusWallet = (): void => {
    const next = bonusWalletShortcut(live, demo, from);
    setPair({ from: next.from, to: next.to });
  };

  const submitSelf = async (): Promise<void> => {
    if (submittingRef.current) return;
    const refusal = selfSubmitRefusal({ from, to, amount });
    if (refusal) {
      toast.error(refusal);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await walletApi.transfer(selfTransferPayload({ from, to, amount }));
      toast.success('Transfer completed');
      setAmount('');
      setConfirm(false);
      afterTransfer();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  /* ── What the body shows ────────────────────────────────────────────── */
  let body: ReactNode;
  if (gate === 'loading' || (balances === null && !balancesError)) {
    body = <LoadingView style={s.loading} />;
  } else if (gate === 'error') {
    body = (
      <ErrorView
        compact
        error={accountsError}
        title="Couldn't load your accounts"
        onRetry={() => { void useSelectedAccountStore.getState().load(); }}
      />
    );
  } else if (balances === null) {
    body = (
      <ErrorView
        compact
        error={balancesError}
        title="Couldn't load balances"
        // Back to the spinner while the retry is out, so the tap is seen to
        // do something and a second tap is not a second request.
        onRetry={() => { setBalancesError(null); void loadBalances(); }}
      />
    );
  } else if (mode === 'user') {
    body = (
      <PeerTransferPanel
        live={live}
        balances={balances}
        onTransferred={afterTransfer}
        refreshKey={refreshKey}
        onOpenAccount={onOpenAccount}
      />
    );
  } else {
    body = (
      <Card variant="plain" padded={20} style={s.panel}>
        {/* A discoverability shortcut: the Bonus Wallet as the destination.
            Only a live account can fund it, so a Bonus / demo source
            switches to the first live account. */}
        {showBonusShortcut(live, to) ? (
          <Pressable
            accessibilityRole="button"
            onPress={toBonusWallet}
            style={({ pressed }) => [
              s.shortcut,
              {
                borderColor: t.alpha(t.colors.primary, 0.4),
                backgroundColor: t.alpha(t.colors.primary, pressed ? 0.1 : 0.05),
              },
            ]}
          >
            <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={t.colors.primaryText} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M12 5v14" />
              <Path d="M5 12l7-7 7 7" />
            </Svg>
            <AppText variant="body" weight="700" color={t.colors.primaryText}>Transfer to Main Wallet</AppText>
          </Pressable>
        ) : null}

        <View>
          <Select label="From" value={from || null} options={fromOptions} onChange={pickFrom} />
          {fromOpt ? (
            <FreeLine
              label={freeLabel(from)}
              value={free === null ? EMPTY : fmtMoney(free)}
              onRetry={retryFree}
            />
          ) : null}
        </View>
        <View>
          <Select
            label="To"
            value={to || null}
            options={toOptions}
            onChange={pickTo}
            placeholder={toOptions.length === 0 ? 'No eligible account' : undefined}
          />
          {fromPractice ? (
            <AppText variant="caption" tone="muted" style={s.underPicker}>{DEMO_TRANSFER_NOTE}</AppText>
          ) : null}
        </View>

        <FixedCurrency />
        <Input
          label="Amount"
          value={amount}
          onChangeText={(v) => setAmount(sanitizeAmount(v))}
          placeholder="0.00"
          keyboardType="decimal-pad"
          inputStyle={s.amountText}
          error={check.overBudget ? 'Exceeds source account balance' : null}
        />

        <Button title="Review Transfer →" size="lg" fullWidth disabled={!check.canReview} onPress={() => setConfirm(true)} />
      </Card>
    );
  }

  return (
    <View style={s.root}>
      <View>
        <AppText variant="h1" accessibilityRole="header">Transfer Funds</AppText>
        <AppText variant="body" tone="secondary" style={s.subtitle}>
          {mode === 'self'
            ? 'Move funds instantly between your trading accounts and your Main Wallet.'
            : 'Send funds from one of your live trading accounts to another registered user — they receive it in their trading account.'}
        </AppText>
      </View>

      <Segmented options={MODES} value={mode} onChange={setMode} />

      {body}

      <Modal
        open={confirm && mode === 'self'}
        onClose={() => setConfirm(false)}
        title="Confirm Transfer"
        footer={(
          <View style={s.footer}>
            <Button title="Cancel" variant="secondary" onPress={() => setConfirm(false)} style={s.flex} />
            <Button
              title="Confirm Transfer"
              loading={submitting}
              loadingTitle="Transferring…"
              onPress={() => { void submitSelf(); }}
              style={s.flex}
            />
          </View>
        )}
      >
        <AppText variant="body" tone="secondary">
          {'Move '}
          <AppText variant="body" weight="700" mono>{fmtMoney(amount || '0')}</AppText>
          {' from '}
          <AppText variant="body" weight="600">{fromOpt?.name ?? ''}</AppText>
          {' to '}
          <AppText variant="body" weight="600">{toOpt?.name ?? ''}</AppText>
          ?
        </AppText>
      </Modal>
    </View>
  );
}

/* ══ Send to another user ════════════════════════════════════════════ */

function PeerTransferPanel({
  live,
  balances,
  onTransferred,
  refreshKey,
  onOpenAccount,
}: {
  /** The sender's LIVE trading accounts — the only sources. */
  live: UserAccount[];
  balances: WalletBalance[];
  onTransferred: () => void;
  onOpenAccount?: () => void;
  /** The hub's pull-to-refresh counter — the limits are read again with it. */
  refreshKey?: number;
}): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();

  const [source, setSource] = useState(() => initialPeerSource(live));
  const { from } = source;
  useEffect(() => {
    setSource((cur) => reseedPeerSource(live, cur) ?? cur);
  }, [live]);

  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TransferRecipient[]>([]);
  const [searching, setSearching] = useState(false);
  const [lastSearch, setLastSearch] = useState<FinishedSearch | null>(null);
  const [recipient, setRecipient] = useState<TransferRecipient | null>(null);
  const [cfg, setCfg] = useState<PeerTransferSettings>(DEFAULT_PEER_TRANSFER_SETTINGS);
  const [cfgState, setCfgState] = useState<PeerSettingsState>('loading');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [confirm, setConfirm] = useState(false);

  // The source is not shown in the confirm (nor on the web), and cannot be
  // changed while it is up — so a change here is the re-seed above moving
  // it because the chosen account left the list. Close the sheet rather
  // than let "Confirm & Send" debit an account the trader never picked.
  useEffect(() => { setConfirm(false); }, [from]);

  // The admin's limits, for the hints and the fee preview — on open and on
  // each pull-to-refresh of the hub. A failed read keeps the permissive
  // defaults as on the web (the server enforces the caps regardless), but
  // says so: those defaults include "no fee". See PeerSettingsState.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const cfgSeq = useRef(0);
  const loadSettings = useCallback(async (): Promise<void> => {
    const mine = ++cfgSeq.current;
    try {
      const next = await walletApi.peerTransferSettings();
      if (!alive.current || mine !== cfgSeq.current) return;
      setCfg(next);
      setCfgState('ready');
    } catch {
      if (!alive.current || mine !== cfgSeq.current) return;
      setCfgState((prev) => peerSettingsAfter(prev, false));
    }
  }, []);
  useEffect(() => { void loadSettings(); }, [loadSettings, refreshKey]);
  const retrySettings = (): void => {
    setCfgState('loading');
    void loadSettings();
  };

  // Debounced recipient search by User ID only — "U", "US", "USR" do not
  // each reach the server.
  useEffect(() => {
    const q = query.trim();
    if (recipient) return undefined;
    if (q.length < PEER_SEARCH_MIN_CHARS) {
      setResults([]);
      // The web leaves `searching` set here when a pending search is cut
      // short, and shows "Searching…" over an empty field until a reload.
      setSearching(false);
      return undefined;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      walletApi.searchRecipients(q, { limit: PEER_SEARCH_LIMIT })
        .then((rows) => {
          if (cancelled) return;
          setResults(rows);
          setLastSearch({ query: q, error: null });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setResults([]);
          setLastSearch({ query: q, error: errorMessage(err) });
        })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, PEER_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, recipient]);

  const options = useMemo(() => peerFromOptions(live), [live]);
  const acct = options.find((o) => o.value === from);
  const free = sourceFree({ from, balances, bonus: null });
  const q = peerQuote(amount, cfg, free);
  const canReview = canReviewPeer({ from, hasRecipient: !!recipient, quote: q, enabled: cfg.enabled, free });
  const amountErrors = peerAmountErrors(q, free);
  const limits = peerLimitsHint(cfg);
  const caveat = peerFeeCaveat(cfgState, q.fee);
  const phase = searchPhase({ query, searching, resultCount: results.length, last: lastSearch });

  const pickSource = (v: string): void => {
    setSource({ from: v, currency: TRANSFER_CURRENCY });
  };

  const pickRecipient = (u: TransferRecipient): void => {
    setRecipient(u);
    setResults([]);
  };

  const changeRecipient = (): void => {
    setRecipient(null);
    setQuery('');
    setResults([]);
  };

  const submit = async (): Promise<void> => {
    if (submittingRef.current) return;
    if (!canReview || !from || !recipient) {
      // No longer valid (a wallet event lowered the free balance while the
      // sheet was open): close it so the form's own message says why. The
      // web returns silently here and leaves a button that does nothing.
      setConfirm(false);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await walletApi.transferToUser(peerTransferPayload({ from, amount, note, recipientUserId: recipient.id }));
      toast.success(peerSentMessage(amount, recipient.name));
      setAmount('');
      setNote('');
      setRecipient(null);
      setQuery('');
      setConfirm(false);
      onTransferred();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  if (cfg.enabled === false) {
    return (
      <Card variant="plain" padded={20} style={s.panel}>
        <View>
          <AppText variant="body" weight="700">Peer transfers are currently disabled</AppText>
          <AppText variant="small" tone="secondary" style={s.subtitle}>
            User-to-user transfers have been turned off by the platform administrator. Try again later.
          </AppText>
        </View>
      </Card>
    );
  }

  const noteShown = note.trim();

  return (
    <>
      <Card variant="plain" padded={20} style={s.panel}>
        <View>
          <Select
            label="From account"
            value={from || null}
            options={options}
            onChange={pickSource}
            placeholder={options.length === 0 ? 'No live trading account' : undefined}
          />
          {acct ? (
            <FreeLine label="Free" value={free === null ? EMPTY : fmtMoney(free)} />
          ) : (
            <AppText variant="caption" tone="muted" style={s.underPicker}>
              {PEER_NO_LIVE_NOTE}
              {onOpenAccount ? (
                <>
                  {' '}
                  <AppText variant="caption" weight="600" color={t.colors.primaryText} accessibilityRole="link" onPress={onOpenAccount}>
                    Open one →
                  </AppText>
                </>
              ) : null}
            </AppText>
          )}
        </View>
        <FixedCurrency />

        <View>
          <AppText variant="label" style={s.label}>Recipient</AppText>
          {recipient ? (
            <View style={[s.recipient, s.picked, { borderColor: t.colors.primary, backgroundColor: t.alpha(t.colors.primary, 0.05) }]}>
              <RecipientAvatar user={recipient} />
              <RecipientText user={recipient} />
              <Pressable
                accessibilityRole="button"
                onPress={changeRecipient}
                hitSlop={6}
                style={({ pressed }) => [s.change, pressed ? { backgroundColor: t.alpha(t.colors.bear, 0.1) } : null]}
              >
                {({ pressed }) => (
                  <AppText variant="small" weight="600" color={pressed ? t.colors.bear : t.colors.textSecondary}>Change</AppText>
                )}
              </Pressable>
            </View>
          ) : (
            <>
              <Input
                value={query}
                onChangeText={setQuery}
                placeholder="Enter recipient's User ID (e.g. USR100245)"
                autoComplete="off"
                autoCorrect={false}
                autoCapitalize="characters"
                spellCheck={false}
                // The web's data-lpignore / data-1p-ignore: no password
                // manager or autofill offering a stored value here.
                importantForAutofill="no"
                textContentType="none"
                accessibilityLabel="Recipient User ID"
              />
              {phase !== 'idle' ? (
                <View style={[s.results, { borderColor: t.colors.borderDark, backgroundColor: t.colors.surface }]}>
                  {phase === 'searching' ? (
                    <AppText variant="small" tone="muted" style={s.resultNote}>Searching…</AppText>
                  ) : null}
                  {phase === 'results' ? results.map((u) => (
                    <Pressable
                      key={u.id}
                      accessibilityRole="button"
                      onPress={() => pickRecipient(u)}
                      style={({ pressed }) => [s.recipient, s.resultRow, pressed ? { backgroundColor: t.colors.bgHover } : null]}
                    >
                      <RecipientAvatar user={u} />
                      <RecipientText user={u} />
                    </Pressable>
                  )) : null}
                  {phase === 'empty' ? (
                    <AppText variant="small" tone="muted" style={s.resultNote}>No users found.</AppText>
                  ) : null}
                  {phase === 'error' ? (
                    <AppText variant="small" tone="bear" style={s.resultNote}>{lastSearch?.error ?? ''}</AppText>
                  ) : null}
                </View>
              ) : null}
            </>
          )}
        </View>

        <View>
          <Input
            label="Amount"
            value={amount}
            onChangeText={(v) => setAmount(sanitizeAmount(v))}
            placeholder="0.00"
            keyboardType="decimal-pad"
            inputStyle={s.amountText}
            error={amountErrors.length ? amountErrors.join('\n') : null}
            hint={amountErrors.length ? undefined : limits || undefined}
          />
          {amountErrors.length && limits ? (
            <AppText variant="small" tone="muted" style={s.below}>{limits}</AppText>
          ) : null}
          {cfgState === 'failed' ? (
            <View style={[s.below, s.freeRow]}>
              <AppText variant="small" color={t.colors.warn} style={s.flex}>
                Couldn't load the transfer limits and fee. The server applies them when you send.
              </AppText>
              <Pressable accessibilityRole="button" accessibilityLabel="Retry loading the transfer limits" onPress={retrySettings} hitSlop={8}>
                <AppText variant="small" tone="brand" weight="600">Retry</AppText>
              </Pressable>
            </View>
          ) : null}
        </View>
        <Input
          label="Note (optional)"
          value={note}
          onChangeText={setNote}
          maxLength={PEER_NOTE_MAX}
          placeholder="Visible to recipient"
        />

        {q.fee > 0 && q.amount > 0 ? (
          <View style={[s.feeBox, { backgroundColor: t.colors.bgHover }]}>
            <Line label="You send" value={fmtMoney(q.amount)} strong />
            <Line label={`Fee ${q.feePercent}%`} value={fmtMoney(q.fee)} color={t.colors.warn} />
            <Line label="Total debit" value={fmtMoney(q.total)} strong />
            <EstimateNote />
          </View>
        ) : null}

        <Button title="Review Transfer →" size="lg" fullWidth disabled={!canReview} onPress={() => setConfirm(true)} />
      </Card>

      <Modal
        open={confirm && !!recipient}
        onClose={() => setConfirm(false)}
        title="Confirm Transfer"
        footer={(
          <View style={s.footer}>
            <Button title="Cancel" variant="secondary" onPress={() => setConfirm(false)} style={s.flex} />
            <Button
              title="Confirm & Send"
              loading={submitting}
              loadingTitle="Sending…"
              onPress={() => { void submit(); }}
              style={s.flex}
            />
          </View>
        )}
      >
        {recipient ? (
          <View style={[s.recipient, s.chip, { backgroundColor: t.colors.bgHover }]}>
            <RecipientAvatar user={recipient} />
            <RecipientText user={recipient} />
          </View>
        ) : null}
        <View style={s.confirmRows}>
          <Line label="Amount" value={fmtMoney(q.amount)} strong size="body" />
          {q.fee > 0 ? (
            <Line label={`Fee (${q.feePercent}%)`} value={fmtMoney(q.fee)} color={t.colors.warn} size="body" />
          ) : null}
          <View style={[s.totalRow, { borderTopColor: t.colors.borderSubtle }]}>
            <AppText variant="body" weight="700">You pay</AppText>
            <AppText variant="body" weight="700" mono>{fmtMoney(q.total)}</AppText>
          </View>
          {caveat ? <EstimateNote unknown={caveat === 'unknown'} /> : null}
        </View>
        {noteShown ? (
          <AppText variant="small" tone="muted" style={s.noteLine}>{`Note: "${noteShown}"`}</AppText>
        ) : null}
        <AppText variant="caption" tone="muted" style={s.noteLine}>{peerConfirmNote(acct?.name, recipient?.name)}</AppText>
      </Modal>
    </>
  );
}

/* ══ Pieces ═══════════════════════════════════════════════════════════ */

/**
 * `Free: ₹1,234.00` under a source picker — the figure in bull, mono. With
 * `onRetry` (a Bonus Wallet snapshot that failed to load), a Retry beside
 * the dash.
 */
function FreeLine({ label, value, onRetry }: { label: string; value: string; onRetry?: () => void }): React.JSX.Element {
  const s = useStyles();
  const line = (
    <AppText variant="caption" tone="muted" style={onRetry ? null : s.freeLine}>
      {`${label}: `}
      <AppText variant="caption" tone="bull" weight="600" mono>{value}</AppText>
    </AppText>
  );
  if (!onRetry) return line;
  return (
    <View style={[s.freeLine, s.freeRow]}>
      {line}
      <Pressable accessibilityRole="button" accessibilityLabel="Retry loading the balance" onPress={onRetry} hitSlop={8}>
        <AppText variant="caption" tone="brand" weight="600">Retry</AppText>
      </Pressable>
    </View>
  );
}

function Line({
  label,
  value,
  strong = false,
  color,
  size = 'caption',
}: {
  label: string;
  value: string;
  strong?: boolean;
  color?: string;
  size?: 'caption' | 'body';
}): React.JSX.Element {
  const s = useStyles();
  return (
    <View style={s.line}>
      <AppText variant={size} tone="secondary">{label}</AppText>
      <AppText variant={size} weight={strong ? '700' : '400'} mono color={color}>{value}</AppText>
    </View>
  );
}

/**
 * PORT-RULINGS §6: a client-side charge preview says it is one. `unknown`:
 * the admin's fee has not been read, so the total leaves out any fee.
 */
function EstimateNote({ unknown = false }: { unknown?: boolean }): React.JSX.Element {
  return (
    <AppText variant="micro" tone="muted">
      {unknown
        ? 'The fee could not be loaded, so it is not included — the server calculates the amount it debits.'
        : 'Fee shown is an estimate — the server calculates the amount it debits.'}
    </AppText>
  );
}

function RecipientText({ user }: { user: TransferRecipient }): React.JSX.Element {
  const s = useStyles();
  return (
    <View style={s.flex}>
      <AppText variant="body" weight="700" numberOfLines={1}>{user.name}</AppText>
      <AppText variant="caption" tone="muted" mono numberOfLines={1}>{recipientSubline(user)}</AppText>
    </View>
  );
}

/** Wallet.jsx RecipientAvatar — the photo, or initials on the brand gradient. */
function RecipientAvatar({ user }: { user: TransferRecipient }): React.JSX.Element {
  const s = useStyles();
  const uri = loadableAvatar(user.avatarUrl);
  // A photo that will not load (gone, or blocked) falls back to the
  // initials — a phone would otherwise show an empty circle.
  const [failedUri, setFailedUri] = useState<string | null>(null);
  if (uri && uri !== failedUri) {
    return (
      <Image
        source={{ uri }}
        style={s.avatar}
        accessibilityIgnoresInvertColors
        onError={() => setFailedUri(uri)}
      />
    );
  }
  return (
    <View style={s.avatar}>
      <Svg width={40} height={40} style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="recipientAvatar" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={avatarGradient[0]} />
            <Stop offset="1" stopColor={avatarGradient[1]} />
          </LinearGradient>
        </Defs>
        <Circle cx={20} cy={20} r={20} fill="url(#recipientAvatar)" />
      </Svg>
      <AppText variant="body" weight="700" color="#FFFFFF">{recipientInitials(user)}</AppText>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  root: { gap: t.space.xl },
  subtitle: { marginTop: t.space.xs },
  loading: { minHeight: 240 },
  panel: { borderRadius: t.radius.xxl, gap: t.space.lg },
  flex: { flex: 1, minWidth: 0 },
  label: { marginBottom: 6 },
  fixedCcy: { borderWidth: 1, borderRadius: t.radius.xl, paddingHorizontal: t.space.md, paddingVertical: 10 },
  below: { marginTop: t.space.xs },
  shortcut: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: t.space.sm,
    borderWidth: 1,
    borderRadius: t.radius.xl,
    paddingVertical: 10,
  },
  freeLine: { marginTop: 6 },
  underPicker: { marginTop: 6 },
  freeRow: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
  amountText: { fontSize: t.text.lg.fontSize, fontWeight: '700' },
  recipient: { flexDirection: 'row', alignItems: 'center', gap: t.space.md },
  picked: { borderWidth: 2, borderRadius: t.radius.xl, paddingHorizontal: t.space.md, paddingVertical: 10 },
  change: { paddingHorizontal: t.space.sm, paddingVertical: t.space.xs, borderRadius: t.radius.lg },
  results: { marginTop: t.space.xs, borderWidth: 1, borderRadius: t.radius.xl, overflow: 'hidden' },
  resultRow: { paddingHorizontal: t.space.md, paddingVertical: 10 },
  resultNote: { paddingHorizontal: t.space.md, paddingVertical: t.space.md },
  feeBox: { borderRadius: t.radius.lg, paddingHorizontal: t.space.md, paddingVertical: t.space.sm, gap: t.space.xs },
  line: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.space.md },
  chip: { borderRadius: t.radius.xl, paddingHorizontal: t.space.md, paddingVertical: 10 },
  confirmRows: { marginTop: t.space.md, gap: t.space.xs },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    paddingTop: t.space.xs,
  },
  noteLine: { marginTop: t.space.md },
  footer: { flexDirection: 'row', gap: t.space.sm },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
