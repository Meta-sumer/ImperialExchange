/**
 * The Wallet hub's rules, checked against EQUITYHUB'S OWN WEB SOURCE rather
 * than a re-typed copy of it.
 *
 * Each block lifts the relevant slice out of the shipped web file
 * (client/src/pages/Wallet.jsx, components/WalletSidebar.jsx,
 * components/AccountOverview.jsx, components/TransactionHistory.jsx,
 * utils/dateRange.js, utils/format.js, utils/ticket.js), runs it with
 * `new Function`, and runs utils/walletLogic on the same input. If either
 * side changes, this fails.
 *
 * Where the port deliberately differs (PORT-RULINGS §1 the server's account
 * figures, the "All Time" custom-date bug), the test pins the difference
 * instead of hiding it.
 */
import fs from 'fs';
import path from 'path';

import { nicknameError, normaliseNickname } from '@/api/account.api';
import type { AccountMetrics } from '@/types/trading';
import { toUserAccount } from '@/types/user';
import { toDeposit, toLedgerEntry, toWalletBalance, toWalletTransaction, toWithdrawal } from '@/types/wallet';
import {
  ALL_STATUSES,
  DATE_PRESETS,
  PAGE_SIZES,
  PERF_RANGES,
  TYPE_CATEGORIES,
  VIEW_FOR_ACTION,
  WALLET_NAV_ITEMS,
  accountBalance,
  accountDisplayName,
  accountTile,
  accountsStateOf,
  areaChartPaths,
  buildHistoryRows,
  chartLabels,
  cleanCustomRange,
  createSourceSequencer,
  customDateError,
  datePresetLabel,
  deepLinkView,
  filterHistory,
  fmtOverviewDateTime,
  fmtTxnDateTime,
  fullNameOf,
  historyAccountOptions,
  historyCsv,
  historyCsvFilename,
  historyDetailRows,
  inCustomRange,
  initialsOf,
  isCalendarDate,
  isHubView,
  kycMeta,
  marginNote,
  markReady,
  matchesDateRange,
  metricsFailures,
  moneyFlows,
  multiSummary,
  notesStorageKey,
  openPositionCounts,
  overviewAccountRows,
  overviewTotalTrades,
  overviewWinRate,
  pageNumbers,
  pageSummary,
  parseNotes,
  perfNet,
  perfPct,
  presetRange,
  realAccounts,
  recentMethodText,
  moveWalletLabel,
  recentMoves,
  rowDescription,
  rowTicket,
  shortTxId,
  showsRecentStrip,
  showsViewAll,
  statusDotColor,
  statusOptionsOf,
  ticketShort,
  tradingTotals,
  trendPct,
  txStatusLabel,
  txnDisplayId,
  withNote,
  withSourceError,
  type HistoryFilter,
  type HistoryRow,
} from '@/utils/walletLogic';

const ROOT = path.join(__dirname, '../../..');
/** LF only, so a CRLF checkout slices the same as this one. */
const readLf = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const web = (p: string): string => readLf(path.join(ROOT, 'client/src', p));
const app = (p: string): string => readLf(path.join(__dirname, '..', p));

/** From `start` (inclusive) up to `end` (exclusive), or a loud failure. */
const between = (src: string, start: string, end: string, from = 0): string => {
  const a = src.indexOf(start, from);
  if (a < 0) throw new Error(`slice start moved: ${start}`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`slice end moved: ${end}`);
  return src.slice(a, b);
};
const through = (src: string, start: string, end: string, from = 0): string => between(src, start, end, from) + end;

type Fn<T> = (...args: unknown[]) => T;
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const lift = <T>(params: string[], body: string): Fn<T> => new Function(...params, body) as Fn<T>;

const WALLET = web('pages/Wallet.jsx');
const SIDEBAR = web('components/WalletSidebar.jsx');
const OVERVIEW = web('components/AccountOverview.jsx');
const HISTORY = web('components/TransactionHistory.jsx');
const DATE_RANGE = web('utils/dateRange.js');

/* ── The web's own formatters (no imports in either file) ──────────────── */

const webFmt = lift<{ fmtNum: Fn<string>; fmtMoney: Fn<string>; currencySymbol: Fn<string> }>(
  [], `${web('utils/format.js').replace(/^export /gm, '')}\nreturn { fmtNum, fmtMoney, currencySymbol };`,
)();
const webTicketShort = lift<Fn<string>>(
  [], `${web('utils/ticket.js').replace(/^export default .*$/m, '').replace(/^export /gm, '')}\nreturn ticketShort;`,
)();

const webRange = lift<{
  dayStart: (v: unknown) => Date | null;
  inCustomRange: (v: unknown, f: unknown, t: unknown) => boolean;
  presetRange: (r: string, now?: Date) => { from: Date | null; to: Date | null };
  matchesDateRange: (v: unknown, r: string, c?: unknown) => boolean;
}>([], `${DATE_RANGE.replace(/^export /gm, '')}\nreturn { dayStart, inCustomRange, presetRange, matchesDateRange };`)();

/* ── Fixtures, in the server's raw shapes ──────────────────────────────── */

const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo: number, hour = 10): string => {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setHours(hour, 15, 30, 0);
  return d.toISOString();
};

const RAW_ACCOUNTS = [
  { _id: 'acc1', accountNumber: '100234', accountType: 'STANDARD', nickname: 'Scalper' },
  { _id: 'acc2', accountNumber: '100235', accountType: 'PRO', nickname: null },
  { _id: 'acc3', accountNumber: '900001', accountType: 'DEMO', nickname: 'Practice' },
];
const ACCOUNTS = RAW_ACCOUNTS.map(toUserAccount);

const ORDER = '64dddddddddddddddd726b5a';
const RAW_DEPOSITS = [
  { _id: '64aaaaaaaaaaaaaaaaaaaa01', accountId: 'acc1', method: 'UPI', senderUpiId: 'ravi@okhdfc', amount: '5000', currency: 'INR', status: 'PENDING', createdAt: iso(0) },
  { _id: '64aaaaaaaaaaaaaaaaaaaa02', accountId: 'acc1', method: 'BANK', amount: '10000', currency: 'INR', status: 'CONFIRMED', note: 'Salary top-up', createdAt: iso(2) },
  { _id: '64aaaaaaaaaaaaaaaaaaaa03', accountId: 'acc2', method: 'Cash Deposit', amount: '2500', currency: 'INR', status: 'REJECTED', createdAt: iso(12) },
  { _id: '64aaaaaaaaaaaaaaaaaaaa04', accountId: 'acc2', method: 'RAZORPAY', amount: '1000', currency: 'INR', status: 'CONFIRMED', createdAt: iso(40) },
  { _id: '64aaaaaaaaaaaaaaaaaaaa05', method: 'UPI', amount: '750', currency: 'INR', status: 'CONFIRMED', targetWallet: 'subscription', createdAt: iso(100) },
  // A Bonus Wallet Add Funds by UPI, approved: its wallet credit (paymentRef) is the same event.
  { _id: '64aaaaaaaaaaaaaaaaaaaa06', method: 'UPI', amount: '400', currency: 'INR', status: 'CONFIRMED', targetWallet: 'bonus', createdAt: iso(11) },
];
const RAW_WITHDRAWALS = [
  { _id: '64bbbbbbbbbbbbbbbbbbbb01', accountId: 'acc1', method: 'UPI', upiId: 'ravi@okhdfc', amount: '800', currency: 'INR', status: 'COMPLETED', createdAt: iso(1) },
  { _id: '64bbbbbbbbbbbbbbbbbbbb02', accountId: 'acc2', method: 'BANK', amount: '600', currency: 'INR', status: 'PROCESSING', createdAt: iso(5) },
  { _id: '64bbbbbbbbbbbbbbbbbbbb03', accountId: 'acc2', method: 'BANK', destination: 'HDFC ••1234', amount: '3000', currency: 'INR', status: 'APPROVED', createdAt: iso(200) },
  { _id: '64bbbbbbbbbbbbbbbbbbbb04', method: 'UPI', amount: '250', currency: 'INR', status: 'PENDING', source: 'BONUS', createdAt: iso(3) },
];
// balanceAfter is required on every WalletLedger row (backend models/Wallet.js).
const RAW_LEDGER = [
  { _id: '64cccccccccccccccccccc01', accountId: 'acc1', type: 'TRADE_OPEN', amount: '-3.2', currency: 'INR', referenceId: ORDER, balanceAfter: '9296.8', note: 'Margin for RELIANCE', createdAt: iso(0, 12) },
  { _id: '64cccccccccccccccccccc02', accountId: 'acc1', type: 'TRADE_CLOSE', amount: '4.1', currency: 'INR', referenceId: ORDER, balanceAfter: '9300.9', createdAt: iso(0, 13) },
  { _id: '64cccccccccccccccccccc03', accountId: 'acc1', type: 'INTERNAL_TRANSFER_OUT', amount: '-20', currency: 'INR', counterparty: { userId: 'u9', name: 'Asha Rao' }, balanceAfter: '9037', createdAt: iso(4) },
  { _id: '64cccccccccccccccccccc04', accountId: 'acc2', type: 'INTERNAL_TRANSFER_IN', amount: '20', currency: 'INR', balanceAfter: '9074', createdAt: iso(4, 11) },
  { _id: '64cccccccccccccccccccc05', accountId: 'acc1', type: 'TRANSFER', amount: '-15', currency: 'INR', note: 'Transfer to Main Wallet', balanceAfter: '9111', createdAt: iso(6) },
  { _id: '64cccccccccccccccccccc06', accountId: 'acc1', type: 'FEE', amount: '-0.5', currency: 'INR', referenceId: ORDER, balanceAfter: '9148', createdAt: iso(7) },
  { _id: '64cccccccccccccccccccc07', accountId: 'acc1', type: 'ADJUSTMENT', amount: '2', currency: 'INR', note: 'Referral commission for June', balanceAfter: '9185', createdAt: iso(8) },
  { _id: '64cccccccccccccccccccc08', accountId: 'acc1', type: 'ADJUSTMENT', amount: '5', currency: 'INR', note: 'Welcome bonus', balanceAfter: '9222', createdAt: iso(9) },
  { _id: '64cccccccccccccccccccc09', accountId: 'acc1', type: 'DEPOSIT', amount: '10000', currency: 'INR', referenceId: '64aaaaaaaaaaaaaaaaaaaa02', balanceBefore: '100', balanceAfter: '10100', createdAt: iso(2, 11) },
  { _id: '64cccccccccccccccccccc10', accountId: 'acc1', type: 'WITHDRAWAL', amount: '-800', currency: 'INR', referenceId: '64bbbbbbbbbbbbbbbbbbbb01', balanceAfter: '9300', createdAt: iso(1, 11) },
  { _id: '64cccccccccccccccccccc12', accountId: 'acc2', type: 'ADJUSTMENT', amount: '1', currency: 'INR', note: 'Wallet to Account move', balanceAfter: '9259', createdAt: iso(31) },
  { _id: '64cccccccccccccccccccc13', accountId: 'acc2', type: 'ADJUSTMENT', amount: '3', currency: 'INR', note: 'Referral deposit reward', balanceAfter: '9296', createdAt: iso(32) },
  { _id: '64cccccccccccccccccccc14', accountId: 'acc2', type: 'ADJUSTMENT', amount: '-2', currency: 'INR', note: 'Swap charge', balanceAfter: '9333', createdAt: iso(33) },
  // An instant Add Funds into the Bonus Wallet debits the trading account.
  { _id: '64cccccccccccccccccccc15', accountId: 'acc1', type: 'ADJUSTMENT', amount: '-100', currency: 'INR', referenceType: 'bonus_wallet_topup', note: 'Transfer to Main Wallet', balanceAfter: '9233', createdAt: iso(13) },
  // An old Main Wallet top-up from the same account.
  { _id: '64cccccccccccccccccccc16', accountId: 'acc2', type: 'ADJUSTMENT', amount: '-50', currency: 'INR', referenceType: 'subscription_wallet_topup', balanceAfter: '9283', createdAt: iso(95) },
];
// /subscriptions/history: the retired Main Wallet's rows (MAIN) and the Bonus
// Wallet's plan charges (BONUS) — one of which the Bonus ledger also holds.
const RAW_SUBSCRIPTIONS = [
  { _id: '64eeeeeeeeeeeeeeeeeeee01', wallet: 'MAIN', transactionType: 'CREDIT', reason: 'DEPOSIT', status: 'SUCCESS', amount: '750', balanceAfter: '750', currency: 'INR', note: 'UPI top-up', createdAt: iso(100, 11) },
  { _id: '64eeeeeeeeeeeeeeeeeeee02', wallet: 'MAIN', transactionType: 'DEBIT', reason: 'PLAN_PURCHASE', status: 'SUCCESS', amount: '499', balanceAfter: '251', planCode: 'PRO', billingCycle: 'MONTHLY', currency: 'INR', createdAt: iso(90) },
  { _id: '64ffffffffffffffffffff04', wallet: 'BONUS', transactionType: 'DEBIT', reason: 'SUBSCRIPTION_CHARGE', status: 'SUCCESS', amount: '29.99', balanceAfter: '420.01', planCode: 'PREMIUM', billingCycle: 'MONTHLY', currency: 'INR', createdAt: iso(1, 9) },
  { _id: '64ffffffffffffffffffff09', wallet: 'BONUS', transactionType: 'DEBIT', reason: 'RENEWAL', status: 'SUCCESS', amount: '29.99', balanceAfter: '390.02', planCode: 'PREMIUM', billingCycle: 'MONTHLY', currency: 'INR', createdAt: iso(150) },
];
const RAW_BONUS = [
  { _id: '64ffffffffffffffffffff01', transactionType: 'CREDIT', reason: 'REFERRAL_COMMISSION', status: 'SUCCESS', amount: '300', balanceAfter: '300', currency: 'INR', note: 'From user Asha', createdAt: iso(10) },
  { _id: '64ffffffffffffffffffff02', transactionType: 'DEBIT', reason: 'WITHDRAWAL', status: 'SUCCESS', amount: '250', balanceAfter: '50', referenceId: '64bbbbbbbbbbbbbbbbbbbb04', currency: 'INR', createdAt: iso(3, 9) },
  { _id: '64ffffffffffffffffffff03', transactionType: 'DEBIT', reason: 'TRANSFER_OUT', status: 'SUCCESS', amount: '25', balanceAfter: '25', currency: 'INR', createdAt: iso(2, 9) },
  { _id: '64ffffffffffffffffffff04', transactionType: 'DEBIT', reason: 'SUBSCRIPTION_CHARGE', status: 'SUCCESS', amount: '29.99', balanceAfter: '420.01', planCode: 'PREMIUM', billingCycle: 'MONTHLY', currency: 'INR', createdAt: iso(1, 9) },
  { _id: '64ffffffffffffffffffff05', transactionType: 'CREDIT', reason: 'DEPOSIT', status: 'SUCCESS', amount: '400', balanceAfter: '450', paymentRef: '64aaaaaaaaaaaaaaaaaaaa06', currency: 'INR', createdAt: iso(11, 9) },
  { _id: '64ffffffffffffffffffff06', transactionType: 'CREDIT', reason: 'COPY_PERFORMANCE_FEE', status: 'SUCCESS', amount: '12', balanceAfter: '462', currency: 'INR', note: 'Copy fee', createdAt: iso(12, 9) },
  { _id: '64ffffffffffffffffffff07', transactionType: 'CREDIT', reason: 'DEPOSIT', status: 'SUCCESS', amount: '100', balanceAfter: '562', paymentRef: 'topup:64cccccccccccccccccccc15', currency: 'INR', createdAt: iso(13, 1) },
];

const deposits = RAW_DEPOSITS.map(toDeposit);
const withdrawals = RAW_WITHDRAWALS.map(toWithdrawal);
const ledger = RAW_LEDGER.map(toLedgerEntry);
const subscriptions = RAW_SUBSCRIPTIONS.map(toWalletTransaction);
const bonusTx = RAW_BONUS.map(toWalletTransaction);

/* ══ Transaction history ═══════════════════════════════════════════════ */

interface WebHistory {
  buildRows: (...a: unknown[]) => Record<string, unknown>[];
  filterRows: (...a: unknown[]) => Record<string, unknown>[];
  categoryOf: (r: unknown) => string;
  fmtDateTime: (d: unknown) => string;
  txnDisplayId: (raw: unknown) => string;
  rowTicket: (r: unknown) => string | null;
  rowDescription: (r: unknown) => string;
  balCcy: (r: unknown) => string;
  TYPE_CATEGORIES: string[];
  ALL_STATUSES: string[];
  DATE_PRESETS: { k: string; label: string }[];
}

const webHistory = lift<WebHistory>(
  ['fmtNum', 'fmtMoney', 'currencySymbol', 'ticketShort', 'matchesDateRange'],
  between(HISTORY, 'const METHOD_LABEL = {', '// ─── Status pill')
    + through(HISTORY, 'const ALL_STATUSES = [', '];')
    + through(HISTORY, 'const TYPE_CATEGORIES = [', '];')
    + through(HISTORY, 'function categoryOf(row) {', '\n}\n')
    + through(HISTORY, 'const DATE_PRESETS = [', '];')
    + `const buildRows = (deposits, withdrawals, ledger, subscriptions, bonusTx, accounts) => {
        ${between(HISTORY, 'const acctName = new Map();', '}, [deposits, withdrawals, ledger, subscriptions, bonusTx, accounts]);')}
      };
      const filterRows = (allRows, search, dateRange, customRange, accountId, effTypeSel, effStatusSel) => {
        ${between(HISTORY, 'const q = search.trim().toLowerCase();', '}, [allRows, dateRange, customRange')}
      };`
    + 'return { buildRows, filterRows, categoryOf, fmtDateTime, txnDisplayId, rowTicket, rowDescription, balCcy, TYPE_CATEGORIES, ALL_STATUSES, DATE_PRESETS };',
)(webFmt.fmtNum, webFmt.fmtMoney, webFmt.currencySymbol, webTicketShort, webRange.matchesDateRange);

const webRows = (): Record<string, unknown>[] =>
  webHistory.buildRows(RAW_DEPOSITS, RAW_WITHDRAWALS, RAW_LEDGER, RAW_SUBSCRIPTIONS, RAW_BONUS, RAW_ACCOUNTS);
const ours = buildHistoryRows(deposits, withdrawals, ledger, subscriptions, bonusTx, ACCOUNTS);

const pick = (r: Record<string, unknown>): Record<string, unknown> => ({
  id: r.id,
  kind: r.kind,
  date: r.date,
  amount: r.amount,
  currency: r.currency,
  status: r.status,
  type: r.type,
  method: r.method,
  receivedFrom: r.receivedFrom,
  destination: r.destination,
  description: r.description,
  accountId: r.accountId ?? null,
  beforeBal: r.beforeBal ?? null,
  afterBal: r.afterBal ?? null,
  walletScope: r.walletScope,
  category: r.category,
  ref: (r.referenceId ?? (r.raw as { referenceId?: string } | undefined)?.referenceId) || null,
});

describe('transaction history — the web normalisers, run beside ours', () => {
  it('builds the same rows, in the same order, with the same category, scope and balances', () => {
    expect(ours.map((r) => pick(r as unknown as Record<string, unknown>))).toEqual(webRows().map(pick));
  });

  it('drops the ledger DEPOSIT / WITHDRAWAL postings, the wallet withdrawal and deposit legs, and plan charges listed twice', () => {
    const ids = ours.map((r) => r.id);
    // Ledger postings, the Bonus withdrawal's debit, and the Bonus credit of an approved deposit.
    for (const gone of ['64cccccccccccccccccccc09', '64cccccccccccccccccccc10', '64ffffffffffffffffffff02', '64ffffffffffffffffffff05']) expect(ids).not.toContain(gone);
    // A Bonus plan charge in both /subscriptions/history and /bonus-wallet/history is one row …
    expect(ids.filter((id) => id === '64ffffffffffffffffffff04')).toHaveLength(1);
    // … one only /subscriptions/history returned is kept, as is an instant top-up's credit.
    expect(ids).toContain('64ffffffffffffffffffff09');
    expect(ids).toContain('64ffffffffffffffffffff07');
    expect(ours).toHaveLength(RAW_DEPOSITS.length + RAW_WITHDRAWALS.length + RAW_LEDGER.length - 2 + RAW_SUBSCRIPTIONS.length - 1 + RAW_BONUS.length - 2);
  });

  it('names the retired Main Wallet "Old Main Wallet (closed)", and the Main Wallet where money moved into it', () => {
    const row = (id: string): HistoryRow => ours.find((r) => r.id === id) as HistoryRow;
    expect(row('64eeeeeeeeeeeeeeeeeeee01')).toMatchObject({ kind: 'subscription', method: 'Old Main Wallet (closed)', destination: 'Old Main Wallet (closed)', category: 'Subscription' });
    expect(row('64aaaaaaaaaaaaaaaaaaaa05').destination).toBe('Old Main Wallet (closed)');
    expect(row('64aaaaaaaaaaaaaaaaaaaa06')).toMatchObject({ destination: 'Main Wallet', walletScope: 'bonus' });
    expect(row('64cccccccccccccccccccc15')).toMatchObject({ receivedFrom: 'Scalper (100234)', destination: 'Main Wallet' });
    expect(row('64cccccccccccccccccccc16').destination).toBe('Old Main Wallet (closed)');
    expect(row('64ffffffffffffffffffff04')).toMatchObject({ kind: 'bonus', type: 'Subscription Charge', destination: 'Subscription', description: 'PREMIUM · MONTHLY', category: 'Subscription' });
    expect(row('64ffffffffffffffffffff09')).toMatchObject({ kind: 'bonus', type: 'Subscription Renewal', category: 'Subscription' });
    expect(row('64ffffffffffffffffffff06').type).toBe('Copy Trading Commission');
    expect(HISTORY).toContain("const MAIN_CLOSED = 'Old Main Wallet (closed)';");
  });

  it('balances come from the matching ledger row, or the wallet debit that funded a Main / Bonus withdrawal', () => {
    const row = (id: string): HistoryRow => ours.find((r) => r.id === id) as HistoryRow;
    expect([row('64aaaaaaaaaaaaaaaaaaaa02').beforeBal, row('64aaaaaaaaaaaaaaaaaaaa02').afterBal]).toEqual([100, 10100]);
    expect([row('64bbbbbbbbbbbbbbbbbbbb04').beforeBal, row('64bbbbbbbbbbbbbbbbbbbb04').afterBal]).toEqual([300, 50]);
    expect(row('64aaaaaaaaaaaaaaaaaaaa05').walletScope).toBe('subscription');
    // An approved Bonus deposit finds its balances on the credit it produced (paymentRef).
    expect([row('64aaaaaaaaaaaaaaaaaaaa06').beforeBal, row('64aaaaaaaaaaaaaaaaaaaa06').afterBal]).toEqual([50, 450]);
    expect(row('64bbbbbbbbbbbbbbbbbbbb04').walletScope).toBe('bonus');
    expect(row('64eeeeeeeeeeeeeeeeeeee02').walletScope).toBe('subscription');
    expect(row('64ffffffffffffffffffff01').walletScope).toBe('bonus');
    expect(row('64cccccccccccccccccccc01').walletScope).toBe('trading');
  });

  it('covers every category branch the fixtures reach', () => {
    const cats = new Set(ours.map((r) => r.category));
    expect(cats).toEqual(new Set(webRows().map((r) => r.category)));
    for (const c of ['Deposit', 'Withdrawal', 'Trade Open', 'Trade Close', 'Fee', 'Subscription']) expect(cats.has(c)).toBe(true);
  });

  it('keeps the web lists and labels verbatim', () => {
    expect([...TYPE_CATEGORIES]).toEqual(webHistory.TYPE_CATEGORIES);
    expect([...ALL_STATUSES]).toEqual(webHistory.ALL_STATUSES);
    expect(DATE_PRESETS.map((p) => [p.key, p.label])).toEqual(webHistory.DATE_PRESETS.map((p) => [p.k, p.label]));
    expect(datePresetLabel('nonsense')).toBe('All Time');
    const sizes = /\[([\d, ]+)\]\.map\(\(n\) => <option key=\{n\} value=\{n\}>\{n\} per page/.exec(HISTORY)?.[1];
    expect(sizes?.split(',').map((s) => Number(s.trim()))).toEqual([...PAGE_SIZES]);
  });

  it('the transaction id, the order ticket, the description and the date read the web way (en-GB to compare)', () => {
    for (const raw of ['64aaaaaaaaaaaaaaaaaaaa01', 'abc', '', null]) expect(txnDisplayId(raw)).toBe(webHistory.txnDisplayId(raw));
    for (const id of [ORDER, '', null, 'abc']) expect(ticketShort(id)).toBe(webTicketShort(id));
    const web = webRows();
    for (const o of ours) {
      const w = web.find((r) => r.id === o.id) as Record<string, unknown>;
      expect({ id: o.id, t: rowTicket(o), d: rowDescription(o) }).toEqual({ id: o.id, t: webHistory.rowTicket(w), d: webHistory.rowDescription(w) });
    }
    for (const r of RAW_LEDGER) expect(fmtTxnDateTime(r.createdAt, 'en-GB')).toBe(webHistory.fmtDateTime(r.createdAt));
    expect(fmtTxnDateTime(null)).toBe('-');
    expect(fmtTxnDateTime('not a date')).toBe('-');
  });

  it('statusOptions: every known status, then the unexpected ones sorted', () => {
    const webStatus = lift<string[]>(['allRows', 'ALL_STATUSES'], between(HISTORY, 'const present = new Set(allRows', '}, [allRows]);'));
    const rows = [...ours, { ...ours[0]!, status: 'ZETA' }, { ...ours[0]!, status: 'ALPHA' }] as HistoryRow[];
    expect(statusOptionsOf(rows)).toEqual(webStatus(rows, webHistory.ALL_STATUSES));
  });

  it('the Accounts filter: All, then Main and Main Wallet, then each account (number shown when it is not the name)', () => {
    const raw = [...RAW_ACCOUNTS, { _id: 'acc4', accountNumber: '', accountType: 'PRO' }];
    const webOpts = lift<unknown[]>(['accounts'], `${between(HISTORY, 'const opts = [', 'const cur = opts.find')}return opts;`);
    expect(historyAccountOptions(raw.map(toUserAccount))).toEqual(webOpts(raw));
  });

  it('the multi-select summary reads the same', () => {
    const webSummary = lift<string>(['options', 'selected'], `${between(HISTORY, 'const all = options.length > 0', 'const toggle = ')}return summary;`);
    for (const [o, s] of [[[], []], [['a', 'b'], ['a', 'b']], [['a', 'b'], []], [['a', 'b', 'c'], ['a']]] as [string[], string[]][]) {
      expect(multiSummary(o.length, s.length)).toBe(webSummary(o, s));
    }
  });

  it('the pager elides the same pages', () => {
    const webPages = lift<(number | string)[]>(['totalPages', 'clampedPage'], between(HISTORY, 'const out = [];\n    const win = 2;', '}, [totalPages, clampedPage]);'));
    for (const [total, cur] of [[1, 1], [5, 3], [20, 1], [20, 10], [20, 20], [7, 4]] as [number, number][]) {
      expect(pageNumbers(total, cur)).toEqual(webPages(total, cur));
    }
    expect(pageSummary(2, 15, 42)).toBe('Showing 16 to 30 of 42 entries');
    expect(pageSummary(3, 15, 42)).toBe('Showing 31 to 42 of 42 entries');
  });

  it('the CSV export is the web’s, column for column — order id and balances included — with the notes', () => {
    const webCsv = lift<string>(
      ['filtered', 'notes', 'fmtDateTime', 'txnDisplayId', 'rowTicket', 'rowDescription'],
      `${between(HISTORY, "const cols = ['Date & Time'", 'const blob = new Blob')}return lines.join('\\n');`,
    );
    const notes = { '64aaaaaaaaaaaaaaaaaaaa02': 'paid "twice"?\nno' };
    expect(historyCsv(ours, notes, 'en-GB'))
      .toBe(webCsv(webRows(), notes, webHistory.fmtDateTime, webHistory.txnDisplayId, webHistory.rowTicket, webHistory.rowDescription));
    expect(historyCsvFilename(new Date('2026-09-29T08:00:00Z'))).toBe('transactions-2026-09-29.csv');
  });

  it('the details rows match, every row (en-GB to compare)', () => {
    const webDetails = lift<unknown[][]>(
      ['row', 'currencySymbol', 'fmtNum', 'txnDisplayId', 'fmtDateTime', 'ticketShort', 'balCcy', 'rowDescription'],
      `${between(HISTORY, "const sign = row.amount > 0 ? '+'", '\n  return (')}return rows;`,
    );
    const web = webRows();
    for (const o of ours) {
      const w = web.find((r) => r.id === o.id) as Record<string, unknown>;
      const theirs = webDetails(w, webFmt.currencySymbol, webFmt.fmtNum, webHistory.txnDisplayId, webHistory.fmtDateTime,
        webTicketShort, webHistory.balCcy, webHistory.rowDescription);
      expect({ id: o.id, rows: historyDetailRows(o, 'en-GB') }).toEqual({ id: o.id, rows: theirs });
    }
  });
});

describe('transaction history — filtering', () => {
  const run = (f: Partial<HistoryFilter>): { mine: string[]; theirs: string[] } => {
    const full: HistoryFilter = {
      range: 'all', custom: { from: '', to: '' }, accountId: 'all', types: TYPE_CATEGORIES, statuses: statusOptionsOf(ours), search: '', ...f,
    };
    return {
      mine: filterHistory(ours, full).map((r) => r.id),
      theirs: webHistory.filterRows(webRows(), full.search, full.range, full.custom, full.accountId, full.types, full.statuses)
        .map((r) => String(r.id)),
    };
  };

  it.each([
    ['everything', {}],
    ['one account', { accountId: 'acc2' }],
    // No longer offered, but a stale filter still scopes the old rows as the web does.
    ['the retired Main Wallet', { accountId: 'wallet:subscription' }],
    ['the Main Wallet', { accountId: 'wallet:bonus' }],
    ['a type subset', { types: ['Deposit', 'Trade Open', 'Fee', 'Subscription'] }],
    ['a status subset', { statuses: ['PENDING', 'PROCESSING'] }],
    ['search by transaction id', { search: 'txn-cccccccc0003' }],
    ['search by order ticket', { search: '#726b5a' }],
    ['search by bare ticket', { search: '726B5A' }],
    ['search by the full order id', { search: ORDER }],
    ['search by counterparty', { search: 'asha' }],
    ['search by method label', { search: 'bank transfer' }],
    ['today', { range: 'today' }],
    ['yesterday', { range: 'yesterday' }],
    ['last 7 days', { range: '7d' }],
    ['last 30 days', { range: '30d' }],
    ['last 90 days', { range: '90d' }],
    ['3 months', { range: '3m' }],
    ['6 months', { range: '6m' }],
    ['1 year', { range: '1y' }],
  ] as [string, Partial<HistoryFilter>][])('%s — same rows as the web', (_name, f) => {
    const { mine, theirs } = run(f);
    expect(mine).toEqual(theirs);
  });

  it('a custom range is inclusive of the whole To day, as on the web', () => {
    const local = new Date(iso(4));
    const ymd = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
    const { mine, theirs } = run({ range: 'custom', custom: { from: ymd, to: ymd } });
    expect(mine).toEqual(theirs);
    expect(mine.length).toBeGreaterThan(0);
  });

  it('"All Time" ignores custom dates the user can no longer see', () => {
    const stale = { from: iso(3).slice(0, 10), to: iso(3).slice(0, 10) };
    const { mine, theirs } = run({ range: 'all', custom: stale });
    expect(mine).toHaveLength(ours.length);
    // Pinned either way: if the web ever applies stale dates under "All Time", this says so.
    expect(theirs.length).toBeLessThanOrEqual(ours.length);
  });

  it('a half-typed custom date is not a bound yet', () => {
    expect(cleanCustomRange({ from: '2026-0', to: '2026-09-3' })).toEqual({ from: '', to: '' });
    expect(cleanCustomRange({ from: ' 2026-09-01 ', to: '2026-09-30' })).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    const { mine } = run({ range: 'custom', custom: { from: '2026-0', to: '' } });
    expect(mine).toHaveLength(ours.length);
  });
});

describe('date ranges — utils/dateRange.js', () => {
  const now = new Date(2026, 8, 29, 15, 0, 0);
  it.each(['today', 'yesterday', '7d', '30d', '90d', '3m', '6m', '1y', 'week', 'month', 'year', 'all', ''])('presetRange(%s) matches', (k) => {
    const mine = presetRange(k, now);
    const theirs = webRange.presetRange(k, now);
    expect([mine.from?.getTime() ?? null, mine.to?.getTime() ?? null]).toEqual([theirs.from?.getTime() ?? null, theirs.to?.getTime() ?? null]);
  });

  it('inCustomRange matches, including open ends and invalid values', () => {
    const cases: [string | null, string, string][] = [
      [iso(0), '', ''],
      [iso(2), iso(3).slice(0, 10), ''],
      [iso(2), '', iso(3).slice(0, 10)],
      ['garbage', '', ''],
      [null, '', ''],
    ];
    for (const [v, f, to] of cases) expect(inCustomRange(v, f, to)).toBe(webRange.inCustomRange(v ?? undefined, f, to));
  });

  it('matchesDateRange agrees on every preset without custom dates', () => {
    for (const r of ['today', '7d', 'custom', 'all']) {
      for (const v of [iso(0), iso(10), iso(400)]) expect(matchesDateRange(v, r, { from: '', to: '' })).toBe(webRange.matchesDateRange(v, r, { from: '', to: '' }));
    }
  });
});

/* ══ Notes ═════════════════════════════════════════════════════════════ */

describe('private notes', () => {
  it('saves trimmed and deletes on empty, as saveNote does', () => {
    const a = withNote({}, 'x', '  hello ');
    expect(a).toEqual({ x: 'hello' });
    expect(withNote(a, 'x', '   ')).toEqual({});
  });
  it('is kept per user, never under the web’s one per-device key', () => {
    expect(notesStorageKey('u1')).not.toBe(notesStorageKey('u2'));
    expect(notesStorageKey('u1')).not.toBe('txnNotes');
  });
  it('reads storage tolerantly', () => {
    expect(parseNotes(null)).toEqual({});
    expect(parseNotes('nope')).toEqual({});
    expect(parseNotes('[1,2]')).toEqual({});
    expect(parseNotes('{"a":"x","b":3,"c":""}')).toEqual({ a: 'x' });
  });
});

/* ══ The hub ═══════════════════════════════════════════════════════════ */

describe('the hub — nav, deep links', () => {
  const NAV = [...between(SIDEBAR, 'export const NAV_ITEMS = [', '];\n').matchAll(/\{ id: '([^']+)',\s+label: '([^']+)'([^}]*)\}/g)].map((m) => ({
    id: m[1] as string,
    label: m[2] as string,
    to: /to: '([^']+)'/.exec(m[3] ?? '')?.[1] ?? null,
    openMethods: /openMethods: true/.test(m[3] ?? ''),
  }));

  it('the rail is WalletSidebar NAV_ITEMS, word for word, with the same page links', () => {
    expect(NAV.length).toBeGreaterThan(5);
    expect(WALLET_NAV_ITEMS.map((i) => ({ id: i.id, label: i.label }))).toEqual(NAV.map(({ id, label }) => ({ id, label })));
    const route = { '/main-wallet': 'BonusWallet' } as Record<string, string>;
    expect(NAV.map((i) => i.id)).not.toContain('subscription');
    expect(WALLET_NAV_ITEMS.map((i) => i.route)).toEqual(NAV.map((i) => (i.to ? route[i.to] : null)));
    // Withdrawal Methods opens the manager rather than a page of its own.
    expect(WALLET_NAV_ITEMS.map((i) => !!i.opensMethods)).toEqual(NAV.map((i) => i.openMethods));
  });

  it('?action= opens the view Wallet.jsx opens', () => {
    const webViewFor = lift<Record<string, string>>([], `${through(WALLET, 'const VIEW_FOR = {', '};')}return VIEW_FOR;`)();
    expect(VIEW_FOR_ACTION).toEqual(webViewFor);
    for (const [a, v] of Object.entries(webViewFor)) expect(deepLinkView({ action: a })).toBe(v);
  });

  it('?view= is honoured for every rail item without a page of its own, as Wallet.jsx VALID', () => {
    const valid = NAV.filter((n) => !n.to).map((n) => n.id);
    for (const id of valid) expect({ id, v: deepLinkView({ view: id }) }).toEqual({ id, v: id });
    for (const id of NAV.filter((n) => n.to).map((n) => n.id)) expect(deepLinkView({ view: id })).toBeNull();
    expect(deepLinkView({ view: 'nope' })).toBeNull();
    expect(deepLinkView({ action: 'withdraw', view: 'history' })).toBe('withdraw');
    expect(deepLinkView({ action: 'toString' })).toBeNull();
    expect(deepLinkView(undefined)).toBeNull();
    expect(isHubView('bonus')).toBe(false);
  });

  it('the Recent Transactions strip: under every view but the overview, no "View All" on the history', () => {
    expect(showsRecentStrip('overview')).toBe(false);
    expect(showsRecentStrip('grow')).toBe(true);
    expect(showsViewAll('history')).toBe(false);
    expect(showsViewAll('details')).toBe(true);
  });

  it('recent movements: the same twelve, newest first', () => {
    const webRecent = lift<{ _id: string }[]>(
      ['deposits', 'withdrawals'],
      between(WALLET, "const d = (deposits || []).map((x) => ({ ...x, _kind: 'deposit' }));", '}, [deposits, withdrawals]);'),
    );
    const many = [...RAW_DEPOSITS, ...RAW_DEPOSITS.map((d, i) => ({ ...d, _id: `${d._id}x${i}`, createdAt: iso(i + 50) }))];
    const mine = recentMoves(many.map(toDeposit), withdrawals, 12).map((m) => m.row.id);
    expect(mine).toEqual(webRecent(many, RAW_WITHDRAWALS).map((r) => r._id));
    expect(recentMoves(deposits, withdrawals)).toHaveLength(deposits.length + withdrawals.length);
  });

  it('the strip’s method and id columns', () => {
    expect(recentMethodText('cash deposit')).toBe('Cash Deposit');
    expect(recentMethodText('UPI')).toBe('UPI');
    expect(recentMethodText(null)).toBe('—');
    expect(shortTxId('64aaaaaaaaaaaaaaaaaaaa01')).toBe('aaaaaaaaaa01');
    expect(shortTxId('')).toBe('—');
  });
});

/* ══ Overview ══════════════════════════════════════════════════════════ */

describe('overview — one Main Wallet card; the Main Wallet is retired', () => {
  it('the total is the Main Wallet plus trading equity, and no Main Wallet is read', () => {
    expect(OVERVIEW).toContain('const totalUsd = refUsd + tradingUsd;');
    expect(OVERVIEW).not.toContain("api.get('/subscription-wallet')");
    expect(OVERVIEW).toContain('label="Main Wallet"');
    expect(OVERVIEW).toContain('View Main Wallet History');
    expect(OVERVIEW).toContain('Available Balance · plans are billed from here');
    const app = readLf(path.join(__dirname, '../screens/wallet/views/OverviewView.tsx'));
    expect(app).toContain('const totalBal = refBal !== null && tradingEq !== null ? refBal + tradingEq : null;');
    expect(app).not.toMatch(/walletApi\.mainWallet|Old Main Wallet/);
    for (const copy of ['View Main Wallet History', 'Available Balance · plans are billed from here', 'Add Funds & Withdraw']) {
      expect(OVERVIEW.replace('&amp;', '&')).toContain(copy);
      expect(app).toContain(copy);
    }
  });

  it('the recent-transactions wallet column is the web walletTypeOf', () => {
    const webType = lift<string>(['t'], `${through(OVERVIEW, 'const walletTypeOf = (t) => {', '\n};')}\nreturn walletTypeOf(t);`);
    const moves = recentMoves(deposits, withdrawals);
    expect(moves.length).toBeGreaterThan(5);
    for (const m of moves) {
      const raw = m.kind === 'deposit'
        ? { _kind: 'deposit', targetWallet: m.row.targetWallet }
        : { _kind: 'withdraw', source: m.row.source };
      expect({ id: m.row.id, label: moveWalletLabel(m) }).toEqual({ id: m.row.id, label: webType(raw) });
    }
    expect(moves.map(moveWalletLabel)).toEqual(expect.arrayContaining(['Main Wallet', 'Old Main Wallet (closed)', 'Trading Account']));
  });
});

describe('overview — money flows (components/AccountOverview.jsx)', () => {
  const webFlows = lift<{ totalDeposits: number; totalWithdrawals: number; pendingWithdrawals: number }>(
    ['toUsd', 'deposits', 'withdrawals'],
    `${between(OVERVIEW, 'const isSettled = ', '// ── Per-account unrealized')}return { totalDeposits, totalWithdrawals, pendingWithdrawals };`,
  );

  it('settled deposits and withdrawals, and what is still in flight — plain rupee sums', () => {
    expect(OVERVIEW).toContain('const toUsd = (amount) => Number(amount) || 0;');
    const theirs = webFlows((a: unknown) => Number(a) || 0, RAW_DEPOSITS, RAW_WITHDRAWALS);
    expect(moneyFlows(deposits, withdrawals)).toEqual(theirs);
    expect(theirs).toEqual({ totalDeposits: 12150, totalWithdrawals: 3800, pendingWithdrawals: 850 });
  });
});

describe('overview — trading figures are the server’s (PORT-RULINGS §1, §3)', () => {
  const accounts = [
    { _id: 'acc1', accountNumber: '100234', accountType: 'STANDARD', leverage: 100 },
    { _id: 'acc2', accountNumber: '100235', accountType: 'PRO_IC', leverage: 200 },
    { _id: 'acc3', accountNumber: '900001', accountType: 'DEMO', leverage: 500 },
    { _id: 'acc4', accountNumber: '900002', accountType: 'CUSTOM', leverage: 100 },
  ].map(toUserAccount);
  const metric = (accountId: string, o: Partial<AccountMetrics>): AccountMetrics => ({
    accountId, currency: 'INR', balance: '0', equity: '0', usedMargin: '0', freeMargin: '0', unrealizedPnl: '0', marginLevel: '0', asOf: '', ...o,
  });
  const metrics = {
    acc1: metric('acc1', { balance: '100000', equity: '110000', usedMargin: '20000', freeMargin: '90000', unrealizedPnl: '10000', marginLevel: '550' }),
    acc2: metric('acc2', { balance: '50000', equity: '45000', usedMargin: '50000', freeMargin: '-5000', unrealizedPnl: '-5000', marginLevel: '90' }),
    acc3: metric('acc3', { balance: '10000000', equity: '10000000' }),
    acc4: metric('acc4', { balance: '1000', equity: '1000' }),
  };

  it('real money is every tier but DEMO / VIRTUAL, as Wallet.jsx isReal', () => {
    const webIsReal = lift<boolean>(
      ['accountTypeById', 'b'],
      `${through(WALLET, 'const typeOf = (b) => ', ';\n')}${through(WALLET, 'const isDemo = (b) => {', '};')}${through(WALLET, 'const isReal = (b) => {', '};')}return isReal(b);`,
    );
    for (const t of ['STANDARD', 'STANDARD_IC', 'PRO', 'PRO_IC', 'FREE', 'CUSTOM', 'REAL', 'DEMO', 'VIRTUAL']) {
      expect({ t, real: realAccounts([{ accountType: t }]).length === 1 }).toEqual({ t, real: webIsReal(new Map([['x', t]]), { accountId: 'x' }) });
    }
    expect(realAccounts(accounts).map((a) => a.id)).toEqual(['acc1', 'acc2', 'acc4']);
  });

  it('sums the live accounts’ server figures and leaves the demo one out', () => {
    const t = tradingTotals(accounts, metrics);
    expect(t).toMatchObject({ complete: true, equity: 156000, balance: 151000, free: 85000, used: 70000, unrealized: 5000 });
  });

  it('DIFFERS: margin level is the account nearest its stop-out, not the web’s pooled ratio that reads "Safe"', () => {
    const webPooled = lift<number | null>(['equity', 'locked'], `${through(WALLET, 'const marginLevel = locked > 0 ? ', ';')}return marginLevel;`);
    const t = tradingTotals(accounts, metrics);
    expect(t.marginLevel).toBe(90);
    expect(marginNote(t.marginLevel)).toEqual({ label: 'At risk', tone: 'bear' });
    expect(webPooled(156000, 70000)).toBeGreaterThan(100);
    const none = tradingTotals(accounts, { ...metrics, acc1: metric('acc1', { marginLevel: '0' }), acc2: metric('acc2', {}) });
    expect(none.marginLevel).toBeNull();
    expect(webPooled(1, 0)).toBeNull();
    expect(marginNote(null)).toBeNull();
    expect(marginNote(150)).toEqual({ label: 'Safe', tone: 'bull' });
  });

  it('is incomplete — shown as a dash, not a partial sum — until every live account has figures', () => {
    expect(tradingTotals(accounts, { acc1: metrics.acc1, acc2: null }).complete).toBe(false);
  });

  it('account rows: live accounts only, P&L as a share of the balance, as the web’s accountRows', () => {
    const rows = overviewAccountRows(accounts, metrics);
    expect(rows.map((r) => [r.account.id, r.pct])).toEqual([['acc1', 10], ['acc2', -10], ['acc4', 0]]);
    expect(OVERVIEW).toContain('const pct = balanceUsd > 0 ? (pnl / balanceUsd) * 100 : 0;');
    expect(overviewAccountRows(accounts, {})[0]?.pct).toBeNull();
  });

  it('winning / losing open positions by the server’s floating P&L', () => {
    const p = (u: string, isBroker = false) => ({ unrealizedPnl: u, isBroker });
    expect(openPositionCounts([p('1'), p('0'), p('-2'), p('5', true)])).toEqual({ open: 3, winning: 2, losing: 1 });
    expect(OVERVIEW).toContain('const winningOpen = positions.filter((p) => posPnl(p) >= 0).length;');
  });

  it('the account area is "metrics failed" only for live accounts whose figures never came', () => {
    expect(metricsFailures(['acc1', 'acc2'], { acc1: { metrics: null, error: 'timeout' }, acc2: { metrics: {}, error: 'stale' } }))
      .toEqual([{ accountId: 'acc1', error: 'timeout' }]);
  });
});

describe('overview — win rate, trades, performance (AccountOverview.jsx:129-145)', () => {
  const webStats = lift<{ winRate: number | null; totalTrades: number; wins: number; losses: number }>(
    ['dash', 'closed'],
    `${between(OVERVIEW, 'const winRate = dash?.pnl?.winRate', 'const rangeNet')}return { winRate, totalTrades, wins, losses };`,
  );
  const summary = { totalTrades: 9, totalLot: 1, netPnl: 5, wins: 6, losses: 3 };
  const dash = (winRate: number | null, totalLive = 4) => ({ pnl: { winRate }, trades: { totalLive } });

  it.each([
    ['dashboard rate wins', dash(55), summary],
    ['falls back to the closed summary', dash(null), summary],
    ['no dashboard at all', null, summary],
    ['nothing decided', dash(null), { ...summary, wins: 0, losses: 0 }],
    ['no closed summary: dashboard trades', dash(null, 12), null],
    ['neither', null, null],
  ] as [string, ReturnType<typeof dash> | null, typeof summary | null][])('%s', (_n, d, c) => {
    const theirs = webStats(d, { items: [], summary: c });
    expect(overviewWinRate(d as never, c)).toBe(theirs.winRate);
    expect(overviewTotalTrades(c, d as never)).toBe(theirs.totalTrades);
    expect(c?.wins ?? 0).toBe(theirs.wins);
    expect(c?.losses ?? 0).toBe(theirs.losses);
  });

  it('the performance headline and its percentage', () => {
    const webPerf = lift<{ perfNet: number; perfPct: number }>(
      ['series', 'totals'],
      `${between(OVERVIEW, 'const perfNet = series.reduce', '// ── Recent transactions')}return { perfNet, perfPct };`,
    );
    const series = [{ netProfit: 10 }, { netProfit: -2.5 }, { netProfit: 7 }];
    for (const equity of [0, 145, -3]) {
      const theirs = webPerf(series, { equity });
      expect(perfNet(series)).toBe(theirs.perfNet);
      expect(perfPct(perfNet(series), equity)).toBe(theirs.perfPct);
    }
    expect(trendPct(0.004)).toBeNull();
    expect(trendPct(1.234)).toBe('↑ +1.23%');
    expect(trendPct(-2)).toBe('↓ -2.00%');
  });

  it('the area chart draws the web’s path', () => {
    const webChart = lift<{ line: string; area: string; pos: boolean; labels: { label: string }[] }>(
      ['vals', 'buckets'],
      `${through(OVERVIEW, 'const W = 600', 'const labels = buckets.filter((_, i) => i % Math.ceil(buckets.length / 5) === 0);')}return { line, area, pos, labels };`,
    );
    const buckets = [5, -3, 12, 12, 40, 7, 9].map((equity, i) => ({ label: `L${i}`, equity }));
    const vals = buckets.map((b) => b.equity);
    const theirs = webChart(vals, buckets);
    const mine = areaChartPaths(vals, 600, 120);
    expect(mine).toEqual({ line: theirs.line, area: theirs.area, positive: theirs.pos });
    expect(chartLabels(buckets)).toEqual(theirs.labels);
    expect(areaChartPaths([1], 600, 120)).toBeNull();
    const flat = webChart([0, 0], [{ label: 'a' }, { label: 'b' }]);
    expect(areaChartPaths([0, 0], 600, 120)?.line).toBe(flat.line);
  });

  it('the status chip label', () => {
    const webLabel = lift<string>(['status'], `const s = String(status || '').toUpperCase();${through(OVERVIEW, "const label = s === 'CONFIRMED'", ';')}return label;`);
    for (const s of ['CONFIRMED', 'COMPLETED', 'pending', 'REJECTED', '', null]) expect(txStatusLabel(s)).toBe(webLabel(s));
  });

  it('the date format (en-GB here only to compare)', () => {
    const webDT = lift<string>(['d'], `${through(OVERVIEW, 'const fmtDT = (d) => {', '};')}return fmtDT(d);`);
    for (const d of [iso(0), iso(3, 23), null]) expect(fmtOverviewDateTime(d, 'en-GB')).toBe(webDT(d));
  });

  it('the performance range dropdown offers the web’s three', () => {
    const opts = [...OVERVIEW.matchAll(/<option value="(1[wmy])">([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]);
    expect(PERF_RANGES.map((r) => [r.value, r.label])).toEqual(opts);
  });
});

/* ══ Account Details ═══════════════════════════════════════════════════ */

describe('account details (Wallet.jsx AccountDetailsView)', () => {
  it('the name, initials and KYC pill', () => {
    const webHero = lift<{ fullName: string; kycMeta: { tint: string; label: string } }>(
      ['user'],
      `${between(WALLET, 'const fullName = [user?.firstName', '// Account creation moved')}return { fullName, kycMeta };`,
    );
    const initialsExpr = between(WALLET, "(fullName || 'T').split(' ')", '}\n');
    const webInitials = lift<string>(['fullName'], `return ${initialsExpr};`);
    for (const user of [
      { firstName: 'Ravi', lastName: 'Kumar', kycStatus: 'APPROVED' },
      { firstName: 'Asha', lastName: null, kycStatus: 'PENDING' },
      { firstName: null, lastName: null, kycStatus: 'REJECTED' },
      { firstName: 'mary jane', lastName: 'watson', kycStatus: null },
      null,
    ]) {
      const theirs = webHero(user);
      expect(fullNameOf(user)).toBe(theirs.fullName);
      expect(kycMeta(user?.kycStatus)).toEqual(theirs.kycMeta);
      expect(initialsOf(fullNameOf(user))).toBe(webInitials(theirs.fullName));
    }
  });

  it('the account type is the tier label (utils/accountTypes accountTierLabel, pinned in rulings.test)', () => {
    expect(WALLET).toContain('{accountTierLabel(a)}');
    expect(app('screens/wallet/views/AccountDetailsView.tsx')).toContain('accountTierLabel(a)');
  });

  it('rename: the same two refusals, then the normalised name', () => {
    const webCheck = lift<string | undefined>(
      ['editName', 'toast'],
      `${between(WALLET, "const name = editName.replace(/\\s+/g, ' ').trim();", 'setSavingName(true);')}return name;`,
    );
    for (const input of ['', '   ', '  Swing   Book ', 'x'.repeat(41), 'x'.repeat(40)]) {
      const errors: string[] = [];
      const theirs = webCheck(input, { error: (m: string) => errors.push(m) });
      expect(nicknameError(input)).toBe(errors[0] ?? null);
      if (theirs !== undefined) expect(normaliseNickname(input)).toBe(theirs);
    }
  });

  it('the card’s name and tile', () => {
    const a = toUserAccount({ _id: 'acc1', accountNumber: '100234', nickname: null });
    expect(accountDisplayName(a, {})).toBe('100234');
    expect(accountDisplayName(a, { acc1: 'Swing' })).toBe('Swing');
    expect(accountTile('swing')).toBe('SW');
    expect(accountTile('')).toBe('A');
  });

  it('the balance is every wallet row of the account summed, as accountTotalUsd (INR-only)', () => {
    const webTotal = lift<number>(
      ['balances', 'accountId', 'field'],
      `${through(WALLET, 'function accountTotalUsd(balances, accountId, field) {', '\n}\n')}return accountTotalUsd(balances, accountId, field);`,
    );
    const raw = [
      { _id: 'w1', accountId: 'acc1', currency: 'INR', balance: '99000', locked: '0', free: '99000' },
      { _id: 'w2', accountId: 'acc1', currency: 'INR', balance: '8800.5', locked: '0', free: '8800.5' },
      { _id: 'w3', accountId: 'acc2', currency: 'INR', balance: '5', locked: '0', free: '5' },
    ];
    const rows = raw.map(toWalletBalance);
    for (const id of ['acc1', 'acc2', 'acc9']) expect(accountBalance(rows, id)).toBe(webTotal(raw, id, 'balance'));
  });
});

/* ══ Review fixes ══════════════════════════════════════════════════════ */

describe('review: custom-range dates are real days', () => {
  it('an impossible day is not a bound — the web’s date input could never produce one', () => {
    // new Date(2026, 1, 31) is 3 March: before, "2026-02-31" silently became it.
    expect(isCalendarDate('2026-02-31')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-00-10')).toBe(false);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate(' 2026-09-30 ')).toBe(true);
    expect(cleanCustomRange({ from: '2026-02-31', to: '2026-09-31' })).toEqual({ from: '', to: '' });
    expect(cleanCustomRange({ from: '2026-02-28', to: '2026-09-30' })).toEqual({ from: '2026-02-28', to: '2026-09-30' });
  });

  it('says so once the date is whole, and not while it is still being typed', () => {
    expect(customDateError('')).toBeNull();
    expect(customDateError('2026-02-3')).toBeNull();
    expect(customDateError('2026-02-28')).toBeNull();
    expect(customDateError('2026-02-31')).toBe('Enter a real date as YYYY-MM-DD');
    expect(customDateError('2026/02/28')).toBe('Enter a real date as YYYY-MM-DD');
  });

  it('an impossible custom day filters nothing (instead of filtering on the rolled-over one)', () => {
    const rows = buildHistoryRows(deposits, withdrawals, ledger);
    const f: HistoryFilter = {
      range: 'custom', custom: { from: '2026-02-31', to: '' }, accountId: 'all',
      types: TYPE_CATEGORIES, statuses: statusOptionsOf(rows), search: '',
    };
    expect(filterHistory(rows, f)).toHaveLength(rows.length);
  });
});

describe('review: the Status filter’s dots are TransactionHistory’s STATUS_COLOR', () => {
  const webDot = lift<(s: unknown) => string>(
    [],
    `${through(HISTORY, 'const STATUS_COLOR = {', '};')}\nreturn (status) => STATUS_COLOR[String(status).toUpperCase()] || '#94A3B8';`,
  )();
  it.each([...ALL_STATUSES, 'DONE', 'done', 'EXPIRED', ''])('%s', (s) => {
    expect(statusDotColor(s)).toBe(webDot(s));
  });
});

describe('review: what the page knows', () => {
  it('a source is ready once it has answered; re-marking keeps the same object', () => {
    const a = markReady({}, 'balances');
    expect(a).toEqual({ balances: true });
    expect(markReady(a, 'balances')).toBe(a);
    expect(markReady(a, 'deposits')).toEqual({ balances: true, deposits: true });
  });

  it('an empty account list is "none" only once the list has answered', () => {
    const base = { count: 0, loading: false, error: null, pageLoading: false };
    expect(accountsStateOf(base)).toBe('ready');
    expect(accountsStateOf({ ...base, loading: true })).toBe('loading');
    // Before the store's first load has even begun, the page's first load covers it.
    expect(accountsStateOf({ ...base, pageLoading: true })).toBe('loading');
    expect(accountsStateOf({ ...base, error: 'Network Error' })).toBe('error');
    // Accounts in hand are known, whatever a background re-load is doing.
    expect(accountsStateOf({ count: 2, loading: true, error: 'x', pageLoading: true })).toBe('ready');
  });
});

/* ══ Review 2 (adversarial pass) ═══════════════════════════════════════ */

describe('review 2: overlapping loads — only a source’s newest answer lands', () => {
  // Imported here so the earlier blocks' import list stays as it was.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createSourceSequencer, withSourceError } = require('@/utils/walletLogic') as typeof import('@/utils/walletLogic');

  it('a newer request makes the older one stale; sources are independent', () => {
    const seq = createSourceSequencer();
    const olderBalances = seq.begin('balances');
    const deposits = seq.begin('deposits');
    expect(olderBalances()).toBe(true);
    const newerBalances = seq.begin('balances');
    // The slow first answer arriving after the second was asked for is dropped…
    expect(olderBalances()).toBe(false);
    expect(newerBalances()).toBe(true);
    // …and it says nothing about another source.
    expect(deposits()).toBe(true);
  });

  it('each source keeps its latest failure, and a success clears only its own', () => {
    const a = withSourceError({}, 'deposits', '/wallet/deposits is down');
    expect(a).toEqual({ deposits: '/wallet/deposits is down' });
    expect(withSourceError(a, 'deposits', '/wallet/deposits is down')).toBe(a);
    const b = withSourceError(a, 'ledger', 'timeout');
    expect(b).toEqual({ deposits: '/wallet/deposits is down', ledger: 'timeout' });
    expect(withSourceError(b, 'deposits', null)).toEqual({ ledger: 'timeout' });
    // Clearing a source with no failure is not a change.
    expect(withSourceError(a, 'balances', null)).toBe(a);
  });
});

describe('review 2: a failed server-figures load is reported, not a silent dash', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { metricsFailures } = require('@/utils/walletLogic') as typeof import('@/utils/walletLogic');
  const m = { accountId: 'acc1' };

  it('only live accounts whose figures never arrived and whose load failed', () => {
    expect(metricsFailures(['acc1', 'acc2', 'acc3', 'acc4'], {
      acc1: { metrics: null, error: 'Not found' },          // failed, nothing on screen → reported
      acc2: { metrics: m, error: 'timeout' },               // last good figures still shown → not
      acc3: { metrics: null, error: null },                 // still loading → not
      demo: { metrics: null, error: 'Not found' },          // not a live account → not
    })).toEqual([{ accountId: 'acc1', error: 'Not found' }]);
  });
});
