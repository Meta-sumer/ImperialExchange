import type { Decimal, TradingAccount } from '@/types/trading';
import {
  BONUS_WALLET_ID,
  type PeerTransferInput,
  type PeerTransferSettings,
  type TransferInput,
  type WalletBalance,
} from '@/types/wallet';
import { isDemoLike } from '@/utils/accountType';
import { fmtMoney } from '@/utils/money';

/**
 * The rules behind the Wallet's "Transfer Funds" view — Wallet.jsx
 * TransferView (between the trader's own accounts and the Bonus Wallet) and
 * TransferToUserPanel (from a live account to another registered user, who
 * receives it in their trading account). No React
 * here, so every number and every gate can be pinned against the web's own
 * source in a test (stage2_transfer.logic.test.ts).
 *
 * ── WHAT IS DIFFERENT FROM THE WEB, AND WHY ──────────────────────────
 * 1. Demo-ness is `isDemoLike` (utils/accountType), the server's predicate,
 *    instead of the web's inline `!== 'DEMO' && !== 'VIRTUAL'`. Same set,
 *    but case-insensitive and in one place (PORT-RULINGS §3).
 * 2. An UNKNOWN source balance is `null`, not zero. The web reads a failed
 *    Bonus Wallet fetch as `Number(undefined || 0)` and tells the
 *    trader "Exceeds source account balance" for every amount; here the
 *    figure shows as a dash and Review stays off without a false message.
 * 3. A non-numeric amount ("1.2.3") never enables Review. The web's
 *    `Number(amount) <= 0` is false for NaN; its `type="number"` input kept
 *    NaN out, a phone keyboard does not (sanitizeAmount does that job here).
 * 4. The pickers are re-seeded when the account list changes. The web seeds
 *    them once, on mount (its list only changes on a page reload); the
 *    app's shared account store refreshes on every `user:wallet` event, so
 *    a pick that is still listed — or a Bonus Wallet pick — is kept and
 *    anything else falls back to the first live (else demo) account.
 * 5. When the last live account leaves the list, a picker holding it is
 *    cleared instead of keeping an id the picker no longer lists.
 * 6. A peer "Confirm & Send" pressed after the transfer stopped being
 *    valid (a wallet event lowered the free balance while the sheet was
 *    open) closes the sheet so the form can say why — the web's submit
 *    returns silently and leaves a button that does nothing.
 * 7. Either confirm closes when its source, destination or currency changes
 *    under it (the account list moved and a re-seed swapped the account).
 *    The web keeps the sheet up, so its confirm could post from an account
 *    the trader never reviewed — the peer sheet does not even name it.
 * 8. A failed read of the peer limits and fee is shown, with a retry, and
 *    the confirm's total says it does not include a fee it could not load
 *    (see PeerSettingsState). The web silently assumes no fee.
 * ──────────────────────────────────────────────────────────────────────
 */

/* ── Constants (Wallet.jsx) ───────────────────────────────────────────── */

/**
 * EquityHub is INR-only: both panels show a fixed "INR (₹)" where the
 * currency select was, and every transfer is sent in INR.
 */
export const TRANSFER_CURRENCY = 'INR';
/** Kept for older imports — the one currency. */
export const TRANSFER_CURRENCIES = [TRANSFER_CURRENCY] as const;

/** The recipient search waits this long after the last keystroke. */
export const PEER_SEARCH_DEBOUNCE_MS = 250;
/** Below this many characters (trimmed) no search is made. */
export const PEER_SEARCH_MIN_CHARS = 2;
/** `limit: 8` on /wallet/recipients/search. */
export const PEER_SEARCH_LIMIT = 8;
/** The note field's `maxLength={120}`. */
export const PEER_NOTE_MAX = 120;

export { BONUS_WALLET_ID };

/**
 * The Bonus Wallet sentinel — the one user-level wallet a transfer can name.
 * The retired Main Wallet ('subscription') is never offered: the server
 * answers 410 MAIN_WALLET_RETIRED to it.
 */
export const isUserWallet = (id: string | null | undefined): boolean => id === BONUS_WALLET_ID;

/* ── Accounts and picker options ──────────────────────────────────────── */

type AccountRow = Pick<TradingAccount, 'id' | 'accountNumber' | 'accountType' | 'nickname'>;

/**
 * Practice money stays practice money: demo accounts only transfer to other
 * demo accounts, and live accounts and the Bonus Wallet only to each other
 * (the server refuses any mix: PRACTICE_TRANSFER_NOT_ALLOWED). Wallet.jsx
 * TransferView `liveAccounts` / `demoAccounts`. The peer panel is handed the
 * live list only — a transfer to another user leaves a live account.
 */
export const liveAccounts = <A extends Pick<TradingAccount, 'accountType'>>(accounts: readonly A[]): A[] =>
  accounts.filter((a) => !isDemoLike(a.accountType));

export const demoAccounts = <A extends Pick<TradingAccount, 'accountType'>>(accounts: readonly A[]): A[] =>
  accounts.filter((a) => isDemoLike(a.accountType));

export interface TransferOption {
  value: string;
  /** What the picker shows. */
  label: string;
  /** What the confirm sentence calls it — `nickname || accountNumber`. */
  name: string;
}

/** `${a.nickname || a.accountNumber} · ${a.accountType}` */
export const accountOption = (a: AccountRow): TransferOption => {
  const name = a.nickname || a.accountNumber;
  return { value: a.id, label: `${name} · ${a.accountType}`, name };
};

/** BONUS_TRANSFER_OPT — `{ _id: 'bonus', nickname: 'Bonus Wallet' }`. */
export const BONUS_OPTION: TransferOption = { value: BONUS_WALLET_ID, label: 'Main Wallet · INR', name: 'Main Wallet' };

type IdRow = Pick<TradingAccount, 'id'>;

/** The source is one of the demo accounts. */
export const isPracticeSource = (demo: readonly IdRow[], from: string): boolean =>
  !!from && demo.some((a) => a.id === from);

/** Between own accounts, the From list: live accounts, the Bonus Wallet, then demo accounts. */
export const selfFromOptions = (live: readonly AccountRow[], demo: readonly AccountRow[] = []): TransferOption[] =>
  [...live.map(accountOption), BONUS_OPTION, ...demo.map(accountOption)];

/**
 * The To list: the destinations on the same side of the demo / live line as
 * the source, minus the source itself — demo → other demo accounts; a live
 * account or the Bonus Wallet → live accounts and the Bonus Wallet.
 */
export const selfToOptions = (
  live: readonly AccountRow[],
  demo: readonly AccountRow[],
  from: string,
): TransferOption[] =>
  (isPracticeSource(demo, from) ? demo.map(accountOption) : [...live.map(accountOption), BONUS_OPTION])
    .filter((o) => o.value !== from);

/** Shown under To when the source is a demo account. */
export const DEMO_TRANSFER_NOTE = 'Demo accounts can only transfer to other demo accounts.';

/**
 * The pickers' first values, as the web's useState seeds them: the first
 * live account (else the first demo one) into the second live account, or
 * into the Bonus Wallet when there is only one.
 */
export const initialSelfPair = (
  live: readonly IdRow[],
  demo: readonly IdRow[] = [],
): { from: string; to: string } => ({
  from: live[0]?.id || demo[0]?.id || '',
  to: live[1]?.id || (live[0] ? BONUS_WALLET_ID : ''),
});

/**
 * Run when the account list changes, and after the source is picked (the
 * web's two effects: a source once accounts arrive, and a destination that
 * is no longer on offer replaced by the first one that is). A source still
 * listed — or the Bonus Wallet — is kept; anything else falls to the first
 * live (else demo) account, or to '' when none is left (header, differences
 * 4 and 5). Returns null when nothing changes.
 */
export const reseedSelfPair = (
  live: readonly AccountRow[],
  demo: readonly AccountRow[],
  current: { from: string; to: string },
): { from: string; to: string } | null => {
  const listed = (id: string): boolean =>
    !!id && (isUserWallet(id) || live.some((a) => a.id === id) || demo.some((a) => a.id === id));
  const from = listed(current.from) ? current.from : (live[0]?.id || demo[0]?.id || '');
  const options = selfToOptions(live, demo, from);
  const to = options.some((o) => o.value === current.to) ? current.to : (options[0]?.value ?? '');
  return from === current.from && to === current.to ? null : { from, to };
};

/**
 * "Transfer to Bonus Wallet": destination Bonus — only a live account can
 * fund it, so a Bonus or demo source moves to the first live account.
 */
export const bonusWalletShortcut = (
  live: readonly IdRow[],
  demo: readonly IdRow[],
  from: string,
): { from: string; to: string; currency: 'INR' } => ({
  from: from === BONUS_WALLET_ID || isPracticeSource(demo, from) ? (live[0]?.id || '') : from,
  to: BONUS_WALLET_ID,
  currency: 'INR',
});

/** The shortcut is offered: not already on the Bonus Wallet, and a live account to fund it. */
export const showBonusShortcut = (live: readonly IdRow[], to: string): boolean =>
  to !== BONUS_WALLET_ID && live.length > 0;

/** To another user: the sender's LIVE trading accounts only. */
export const peerFromOptions = (live: readonly AccountRow[]): TransferOption[] => live.map(accountOption);

/**
 * What the view shows for the ACCOUNT LIST: a spinner, the load error, or
 * the form. Only the first load may hold the form back: the shared store
 * re-fetches on every `user:wallet` event and flips `loading` each time,
 * and a trader with no active accounts (the Bonus Wallet only) would otherwise
 * see the form — recipient, amount, an open confirm — thrown away on each
 * one. A later failure keeps the list it had, so it keeps the form too.
 */
export type AccountsGate = 'loading' | 'error' | 'ready';

export const accountsGate = (p: {
  /** The list has loaded at least once since the view opened. */
  everReady: boolean;
  count: number;
  loading: boolean;
  error: unknown;
}): AccountsGate => {
  if (p.everReady || p.count > 0) return 'ready';
  if (p.loading) return 'loading';
  if (p.error) return 'error';
  return 'ready';
};

/* ── Balances ─────────────────────────────────────────────────────────── */

/**
 * What the source can give, as the SERVER sent it — a Decimal string — or
 * null when it is not known yet (a wallet still loading, or a failed fetch).
 *
 * The Bonus Wallet: its own balance. A trading account: the `free` figure of
 * its INR wallet; an account with no wallet has nothing there, which is the
 * web's `|| 0`.
 */
export const sourceFree = (p: {
  from: string;
  currency?: string;
  balances: readonly Pick<WalletBalance, 'accountId' | 'currency' | 'free'>[] | null;
  bonus: { balance: Decimal } | null;
}): Decimal | null => {
  if (p.from === BONUS_WALLET_ID) return p.bonus ? p.bonus.balance : null;
  if (!p.from || !p.balances) return null;
  const ccy = p.currency || TRANSFER_CURRENCY;
  return p.balances.find((b) => b.accountId === p.from && b.currency === ccy)?.free ?? '0';
};

/**
 * The source is the Bonus Wallet and its snapshot never arrived — the
 * balance line offers a retry (the web shows ₹0.00 and "Exceeds" with no
 * way back short of reloading the page).
 */
export const snapshotMissing = (p: {
  from: string;
  bonus: unknown;
  failed: boolean;
}): boolean => p.from === BONUS_WALLET_ID && !p.bonus && p.failed;

/** INR, whichever wallet the money leaves. Kept for older imports. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const freeCurrency = (_from?: string, _currency?: string): string => TRANSFER_CURRENCY;

/** `Balance` for the Bonus Wallet, `Free` for a trading account. */
export const freeLabel = (from: string): string => (isUserWallet(from) ? 'Balance' : 'Free');

/** A Decimal for comparison only — never for display. The web's `Number(x || 0)`. */
const toNum = (d: Decimal | null): number | null => (d === null ? null : Number(d || 0));

/* ── The amount field ─────────────────────────────────────────────────── */

/**
 * What a phone keyboard may put in the amount: digits and ONE decimal
 * point (a decimal comma becomes a point). The web's `type="number"` input
 * does this job in a browser.
 */
export const sanitizeAmount = (text: string): string => {
  const s = text.replace(/,/g, '.').replace(/[^0-9.]/g, '');
  const dot = s.indexOf('.');
  return dot < 0 ? s : s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
};

/* ── Between own accounts ─────────────────────────────────────────────── */

export interface SelfTransferCheck {
  /** `Number(amount) > free` — "Exceeds source account balance". */
  overBudget: boolean;
  /** "Source and destination must be different accounts." */
  same: boolean;
  /** Review Transfer is enabled. */
  canReview: boolean;
}

/** TransferView's checks and the Review button's `disabled`. */
export const checkSelfTransfer = (p: {
  from: string;
  to: string;
  amount: string;
  free: Decimal | null;
}): SelfTransferCheck => {
  const n = Number(p.amount);
  const free = toNum(p.free);
  const overBudget = free !== null && n > free;
  const same = !!p.from && p.from === p.to;
  const canReview = !!p.from && !!p.to && p.from !== p.to && !!p.amount
    && Number.isFinite(n) && n > 0 && free !== null && !overBudget;
  return { overBudget, same, canReview };
};

/**
 * The submit handler's own refusal — unreachable past a disabled Review
 * button, kept because the web keeps it.
 */
export const selfSubmitRefusal = (p: { from: string; to: string; amount: string }): string | null =>
  (!p.from || !p.to || p.from === p.to || !p.amount ? 'Pick two different accounts and a positive amount' : null);

/**
 * POST /wallet/transfers — `{ fromAccountId, toAccountId, currency, amount }`,
 * exactly what TransferView sends (walletController.internalTransfer reads
 * those plus an optional `note`).
 */
export const selfTransferPayload = (p: { from: string; to: string; amount: string }): TransferInput => ({
  fromAccountId: p.from,
  toAccountId: p.to,
  currency: TRANSFER_CURRENCY,
  amount: p.amount,
});

/* ── To another user ──────────────────────────────────────────────────── */

export interface PeerQuote {
  /** `Number(amount) || 0` */
  amount: number;
  /** `Number(cfg.feePercent) || 0` */
  feePercent: number;
  /** Charged ON TOP of the amount. A client estimate — the server books it. */
  fee: number;
  /** amount + fee — what must be free. */
  total: number;
  min: number;
  max: number;
  overBudget: boolean;
  belowMin: boolean;
  aboveMax: boolean;
}

/** TransferToUserPanel's fee / total / limit arithmetic, figure for figure. */
export const peerQuote = (
  amount: string,
  cfg: Pick<PeerTransferSettings, 'min' | 'max' | 'feePercent'>,
  free: Decimal | null,
): PeerQuote => {
  const amt = Number(amount) || 0;
  const feePercent = Number(cfg.feePercent) || 0;
  const fee = feePercent > 0 ? amt * (feePercent / 100) : 0;
  const total = amt + fee;
  const freeN = toNum(free);
  const min = Number(cfg.min || 0);
  const max = Number(cfg.max || 0);
  return {
    amount: amt,
    feePercent,
    fee,
    total,
    min,
    max,
    overBudget: freeN !== null && total > freeN,
    belowMin: min > 0 && amt > 0 && amt < min,
    aboveMax: max > 0 && amt > max,
  };
};

/** TransferToUserPanel `canReview` (a source, a recipient, …), plus a known source balance. */
export const canReviewPeer = (p: {
  /** The source account; omitted = not checked here. */
  from?: string;
  hasRecipient: boolean;
  quote: PeerQuote;
  enabled: boolean;
  free: Decimal | null;
}): boolean =>
  (p.from === undefined || !!p.from) && p.hasRecipient && p.quote.amount > 0 && !p.quote.overBudget && !p.quote.belowMin
  && !p.quote.aboveMax && p.enabled !== false && p.free !== null;

/**
 * Where the admin's limits and fee stand. The web starts from permissive
 * defaults (no minimum, no maximum, NO FEE) and keeps them silently when
 * GET /wallet/transfer-user/settings fails — so its confirm then says
 * "You pay $50.00" while the server debits $50.75. Here a failed read is
 * said out loud (with a retry), and the confirm's total is labelled as not
 * including a fee the app could not load (PORT-RULINGS §6).
 */
export type PeerSettingsState = 'loading' | 'ready' | 'failed';

/** A failed RE-read keeps limits already loaded; only a first read that fails is 'failed'. */
export const peerSettingsAfter = (prev: PeerSettingsState, ok: boolean): PeerSettingsState =>
  (ok || prev === 'ready' ? 'ready' : 'failed');

/**
 * Which caveat the charge figures carry: 'unknown' while the fee has not
 * been read (the defaults say 0, which may not be what the server charges),
 * 'estimate' when a fee is previewed, none when the admin set no fee.
 */
export const peerFeeCaveat = (settings: PeerSettingsState, fee: number): 'unknown' | 'estimate' | null =>
  (settings !== 'ready' ? 'unknown' : fee > 0 ? 'estimate' : null);

/** The amount field's refusals, in the web's order. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const peerAmountErrors = (q: PeerQuote, free: Decimal | null, _currency?: string): string[] => {
  const out: string[] = [];
  if (q.overBudget) out.push(`Exceeds free balance (${fmtMoney(free)})`);
  if (q.belowMin) out.push('Below minimum transfer amount');
  if (q.aboveMax) out.push('Above maximum transfer amount');
  return out;
};

/**
 * "Min ₹100.00 · Max ₹50,000.00 · Fee 1.5%" under the amount, or '' when
 * the admin set none of them.
 */
export const peerLimitsHint = (
  cfg: Pick<PeerTransferSettings, 'min' | 'max' | 'feePercent'>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _currency?: string,
): string => {
  const q = peerQuote('0', cfg, null);
  const parts: string[] = [];
  if (q.min > 0) parts.push(`Min ${fmtMoney(cfg.min)}`);
  if (q.max > 0) parts.push(`Max ${fmtMoney(cfg.max)}`);
  if (q.feePercent > 0) parts.push(`Fee ${q.feePercent}%`);
  return parts.join(' · ');
};

/**
 * The web's initial source: the first live account, or none. Always INR.
 * The recipient is credited in their primary live trading account.
 */
export const initialPeerSource = (
  live: readonly Pick<TradingAccount, 'id'>[],
): { from: string; currency: string } => ({
  from: live[0]?.id || '',
  currency: TRANSFER_CURRENCY,
});

/** Under From when the sender has no live account (the web links /accounts/new). */
export const PEER_NO_LIVE_NOTE = 'Transfers are sent from a live trading account.';

/** The peer confirm's last line — who sends, and where the recipient receives it. */
export const peerConfirmNote = (sourceName: string | null | undefined, recipientName: string | null | undefined): string =>
  `Sent from ${sourceName || ''}. ${recipientName || 'The recipient'} receives it in their trading account.`;

/** The one currency — kept for older imports. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const peerCurrencies = (_from?: string): readonly string[] => TRANSFER_CURRENCIES;

/**
 * POST /wallet/transfer-user — `{ fromAccountId, currency, amount:
 * String(amt), note: note.trim() || undefined, recipientUserId }`, with a
 * blank note left out.
 */
export const peerTransferPayload = (p: {
  from: string;
  amount: string;
  note: string;
  recipientUserId: string;
}): PeerTransferInput => {
  const note = p.note.trim();
  return {
    fromAccountId: p.from,
    currency: TRANSFER_CURRENCY,
    amount: String(Number(p.amount) || 0),
    ...(note ? { note } : {}),
    recipientUserId: p.recipientUserId,
  };
};

/** `Sent ₹10.00 to Jane Doe` — the web's success toast. */
export const peerSentMessage = (amount: string, recipientName: string): string =>
  `Sent ${fmtMoney(Number(amount) || 0)} to ${recipientName}`;

/* ── Recipients ───────────────────────────────────────────────────────── */

/** RecipientAvatar's initials (Wallet.jsx). */
export const recipientInitials = (u: { name?: string | null; email?: string | null } | null | undefined): string =>
  String(u?.name || u?.email || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('') || '?';

/** The mono line under a recipient's name — their User ID, else email. */
export const recipientSubline = (u: { userUid?: string | null; email?: string | null }): string =>
  u.userUid || u.email || '';

/**
 * An avatar the phone can load. The web hands `avatarUrl` straight to
 * <img>, which resolves a relative path against the page; an app has no
 * page, so anything that is not absolute (or a data: URL) falls back to the
 * initials rather than a broken image.
 */
export const loadableAvatar = (url: string | null | undefined): string | null =>
  (url && /^(https?:|data:image\/)/i.test(url) ? url : null);

export type SearchPhase = 'idle' | 'searching' | 'results' | 'empty' | 'error';

/** The last search that finished: what it was for, and its failure if any. */
export interface FinishedSearch {
  query: string;
  error: string | null;
}

/**
 * What the results area shows. The web renders it only while
 * `searching || results.length > 0`, which makes its own "No users found."
 * line unreachable; here it shows once a search of 2+ characters comes back
 * empty — the message the web wrote, where it evidently meant it to appear.
 * A failed search says why instead of claiming nobody matched (the web
 * swallows it into an empty list).
 *
 * `last` must be for the CURRENT query, so neither line flashes in the
 * moment between a keystroke and its search starting.
 */
export const searchPhase = (p: {
  query: string;
  searching: boolean;
  resultCount: number;
  last: FinishedSearch | null;
}): SearchPhase => {
  if (p.searching && p.resultCount === 0) return 'searching';
  if (p.resultCount > 0) return 'results';
  const q = p.query.trim();
  if (q.length >= PEER_SEARCH_MIN_CHARS && p.last?.query === q) return p.last.error ? 'error' : 'empty';
  return 'idle';
};

/**
 * Keep the peer source valid as the account list changes (the web's effect:
 * a source no longer listed becomes `accounts[0]?._id || ''`). Null = no
 * change.
 */
export const reseedPeerSource = (
  live: readonly Pick<TradingAccount, 'id'>[],
  current: { from: string; currency: string },
): { from: string; currency: string } | null => {
  if (live.some((a) => a.id === current.from)) return null;
  const seed = initialPeerSource(live);
  return seed.from === current.from ? null : seed;
};
