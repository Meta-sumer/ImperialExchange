import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtNum, currencySymbol } from '../utils/format';
import { matchesDateRange } from '../utils/dateRange';
import { ticketShort } from '../utils/ticket';

/**
 * Unified Transaction History — a single rich table that merges wallet
 * deposits, withdrawals and ledger postings (trades, fees, adjustments,
 * transfers) into one filterable, paginated view.
 *
 * Design mirrors the reference screenshot: Date & Time · Transaction ID ·
 * Amount · Status · Type · Payment Method · Currency · Received From ·
 * Destination · Description · Note · Actions — with a filter bar
 * (Date Range / Type / Status / Accounts / Search), Export-to-CSV, and
 * bottom pagination.
 *
 * It is purely presentational over data the Wallet page already loads:
 *   - deposits   → /wallet/deposits
 *   - withdrawals→ /wallet/withdrawals
 *   - ledger     → /wallet/ledger
 * Personal per-row notes are stored client-side (localStorage) since the
 * backend has no user-note field on transactions.
 */

// ─── Label maps ───────────────────────────────────────────────────────
const METHOD_LABEL = {
  UPI: 'UPI',
  BANK: 'Bank Transfer',
  CRYPTO: 'Crypto',
  CARD: 'Card',
  RAZORPAY: 'Razorpay',
  DEMO: 'Wallet Balance',
  MANUAL: 'Manual',
};

const LEDGER_TYPE = {
  TRADE_OPEN: 'Trade Open',
  TRADE_CLOSE: 'Trade Close',
  FEE: 'Fee',
  ADJUSTMENT: 'Adjustment',
  TRANSFER: 'Internal Transfer',
  INTERNAL_TRANSFER_OUT: 'Transfer Sent',
  INTERNAL_TRANSFER_IN: 'Transfer Received',
  DEPOSIT: 'Deposit',
  WITHDRAWAL: 'Withdrawal',
  CONVERSION: 'Conversion',
};

const methodLabel = (m) => METHOD_LABEL[String(m || '').toUpperCase()] || (m ? String(m) : 'System');

// ─── Date formatting: "13 Jul 2026, 10:09:36 PM" ──────────────────────
function fmtDateTime(d) {
  if (!d) return '-';
  const s = new Date(d).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  });
  return s.replace(/\b(am|pm)\b/i, (x) => x.toUpperCase());
}

// ─── Transaction ID display: TXN-XXXXXXXXXXXX ─────────────────────────
const txnDisplayId = (raw) => 'TXN-' + String(raw || '').slice(-12).toUpperCase().padStart(12, '0');
// One ticket rendering for the whole app — see utils/ticket.js.

// Every wallet in this product holds ONE balance, denominated in the platform
// base currency (backend config/constants BASE_CURRENCY). A deposit or
// withdrawal can be DENOMINATED in something else — ₹31,210.99 over UPI, 200
// USDT over TRC20 — but the balance it moves is still the USD one. Labelling
// those balance columns with the transaction's currency printed a real USD
// figure behind a ₹ or USDT symbol, i.e. the number was right and the unit was
// wrong by a factor of ~96.
const BASE_CURRENCY = 'USD';
// Currency to label a row's before/after balance with. Deliberately NOT
// row.currency — falling back to the base currency is the whole point.
const balCcy = (row) => (row && row.balCurrency) || BASE_CURRENCY;
// receivedFrom / destination carry a newline so the table can break them onto
// two lines; a description reads them as prose, so flatten first.
const flat = (v) => String(v == null ? '' : v).split(String.fromCharCode(10)).join(' ').trim();
// A deposit/withdrawal's own description. "Withdrawal via UPI" said nothing
// the Type and Payment Method columns did not already say: not which UPI id
// the money went to, not which account it left, not what currency or how much.
// Every one of those is already on the record — it was simply never assembled.
function movementDescription({ kind, method, amount, currency, base, account, counterparty, note }) {
  const word = kind === 'withdrawal' ? 'Withdrawal' : 'Deposit';
  const parts = [`${word} via ${method}`];
  const amt = Math.abs(Number(amount) || 0);
  if (amt > 0) {
    // currencySymbol() falls back to the CODE itself for anything without a
    // glyph (USDT, BTC), so appending the code again gave "USDT 200.00 USDT".
    const sym = currencySymbol(currency);
    const money = sym.trim() === currency
      ? `${sym}${fmtNum(amt, 2)}`
      : `${sym}${fmtNum(amt, 2)} ${currency}`;
    parts.push(base && base.currency !== currency
      ? `${money} (≈ ${currencySymbol(base.currency)}${fmtNum(Math.abs(base.amount), 2)})`
      : money);
  }
  // Direction spelled out: a withdrawal leaves the trading account for an
  // external destination; a deposit arrives from outside into the account.
  const from = kind === 'withdrawal' ? account : counterparty;
  const to   = kind === 'withdrawal' ? counterparty : account;
  if (from) parts.push(`from ${from}`);
  if (to) parts.push(`to ${to}`);
  const built = parts.join(' · ');
  // A note the user or an admin wrote is extra information, not a replacement.
  return note && String(note).trim() ? `${built} · ${String(note).trim()}` : built;
}
// The USD equivalent the backend already stored for a deposit/withdrawal
// (Deposit/Withdrawal.baseAmount + baseCurrency + fxRateUsed). Null when the
// row is already in base currency or predates the conversion fields.
function baseEquivalent(doc, signedAmount) {
  const baseCcy = doc?.baseCurrency || BASE_CURRENCY;
  const base = _num(doc?.baseAmount);
  if (base == null || base === 0) return null;
  return { currency: baseCcy, amount: Math.sign(signedAmount || 1) * Math.abs(base), rate: _num(doc?.fxRateUsed) };
}
// A ledger row's trade reference, or null when the row isn't a trade/fee row.
const rowTicket = (row) => (row?.raw?.referenceId ? ticketShort(row.raw.referenceId) : null);
// Description with the order ticket on the front.
//
// walletService writes the ticket into the note now, but a note is written ONCE
// at settle time — every trade that closed before that shipped still has a
// description with no id in it, and those rows are never rewritten. Deriving it
// here from the row's referenceId (which every trade/fee row has always
// carried) puts the order on the old rows too, without touching stored audit
// text. Rows that already name the ticket are left alone so it isn't doubled.
function rowDescription(row) {
  const desc = String(row?.description || '').trim();
  const tkt = rowTicket(row);
  if (!tkt || desc.includes(tkt)) return desc;
  return desc ? `order ${tkt} · ${desc}` : `order ${tkt}`;
}

// ─── Balance-snapshot helpers (realized/settled balance, NOT floating) ─────
// A ledger row's before/after are the wallet's REALIZED balance around the
// mutation. `balanceBefore` is a newer field; legacy rows fall back to
// `balanceAfter − signed amount`. Deposits/withdrawals show the snapshot from
// their matching trading-wallet ledger row (looked up by referenceId).
const _num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
function _ledgerBefore(l) {
  const after = _num(l.balanceAfter);
  const before = _num(l.balanceBefore);
  if (before != null) return before;
  if (after != null) return after - Number(l.amount || 0); // signed amount
  return null;
}

// ─── Normalizers → one common row shape ───────────────────────────────
function normalizeDeposit(d, ledgerByRef, acctName) {
  const method = String(d.method || '').toUpperCase();
  let receivedFrom = 'External';
  if (method === 'UPI') receivedFrom = d.senderUpiId ? `UPI ID\n${d.senderUpiId}` : 'UPI ID';
  else if (method === 'BANK') receivedFrom = 'Bank Account';
  else if (method === 'CRYPTO') receivedFrom = 'Crypto Wallet';
  else if (method === 'CARD') receivedFrom = 'Card';
  const snap = ledgerByRef && ledgerByRef.get(String(d._id || d.id));
  // A deposit credits the TRADING ACCOUNT's wallet — that is the wallet
  // walletService touches on confirm. "Main Wallet" named a wallet that
  // never moved for this row.
  const acct = (acctName && d.accountId && acctName.get(String(d.accountId))) || 'Trading Account';
  return {
    id: String(d._id || d.id),
    kind: 'deposit',
    date: d.createdAt,
    amount: Number(d.amount || 0),
    currency: d.currency || 'USD',
    status: d.status || 'PENDING',
    type: 'Deposit',
    typeKey: 'Deposit',
    method: methodLabel(d.method),
    receivedFrom,
    destination: acct,
    description: movementDescription({
      kind: 'deposit', method: methodLabel(d.method), amount: d.amount, currency: d.currency || 'USD',
      base: baseEquivalent(d, 1), account: acct, counterparty: flat(receivedFrom), note: d.note,
    }),
    accountId: d.accountId ? String(d.accountId) : null,
    beforeBal: snap ? snap.before : null,
    afterBal: snap ? snap.after : null,
    // Currency of beforeBal/afterBal — the wallet's, never the deposit's.
    balCurrency: (snap && snap.currency) || d.baseCurrency || BASE_CURRENCY,
    // "+USDT 200.00" alone doesn't say what landed in the wallet.
    baseEq: baseEquivalent(d, 1),
    raw: d,
  };
}

function normalizeWithdrawal(w, ledgerByRef, acctName) {
  const method = String(w.method || '').toUpperCase();
  let destination = w.destination || 'External';
  if (method === 'UPI') destination = w.upiId ? `UPI ID\n${w.upiId}` : (w.destination || 'UPI ID');
  else if (method === 'BANK') destination = w.destination || 'Bank Account';
  else if (method === 'CRYPTO') destination = w.destination || 'Crypto Wallet';
  const snap = ledgerByRef && ledgerByRef.get(String(w._id || w.id));
  // Where the money actually came from. `source` is the authority here:
  //   TRADING      → the trading account's own wallet
  //   SUBSCRIPTION → Main Wallet
  //   BONUS        → Bonus Wallet
  // Main/Bonus payouts carry NO accountId (they are not tied to a trading
  // account), so keying off accountId alone made every one of them claim
  // to come from a "Trading Account" that was never involved.
  const source = String(w.source || 'TRADING').toUpperCase();
  const acct =
    source === 'SUBSCRIPTION' ? 'Main Wallet'
    : source === 'BONUS' ? 'Bonus Wallet'
    : ((acctName && w.accountId && acctName.get(String(w.accountId))) || 'Trading Account');
  return {
    id: String(w._id || w.id),
    kind: 'withdrawal',
    date: w.createdAt,
    amount: -Math.abs(Number(w.amount || 0)),
    currency: w.currency || 'USD',
    status: w.status || 'PENDING',
    type: 'Withdrawal',
    typeKey: 'Withdrawal',
    method: methodLabel(w.method),
    receivedFrom: acct,
    destination,
    description: movementDescription({
      kind: 'withdrawal', method: methodLabel(w.method), amount: w.amount, currency: w.currency || 'USD',
      base: baseEquivalent(w, -1), account: acct, counterparty: flat(destination), note: w.note,
    }),
    accountId: w.accountId ? String(w.accountId) : null,
    beforeBal: snap ? snap.before : null,
    afterBal: snap ? snap.after : null,
    balCurrency: (snap && snap.currency) || w.baseCurrency || BASE_CURRENCY,
    baseEq: baseEquivalent(w, -1),
    raw: w,
  };
}

function normalizeLedger(l, acctName) {
  const type = LEDGER_TYPE[l.type] || l.type || 'Other';
  const amt = Number(l.amount || 0);
  const cp = l.counterparty?.name;
  const isTransfer = l.type === 'INTERNAL_TRANSFER_OUT' || l.type === 'INTERNAL_TRANSFER_IN' || l.type === 'TRANSFER';
  // Resolve the trading account's display name (nickname / number) so trade
  // rows show the actual account instead of a generic "Trading Account".
  const acct = (acctName && l.accountId && acctName.get(String(l.accountId))) || 'Trading Account';
  let receivedFrom = '-';
  let destination = '-';
  let method = 'System';
  // Trading money never passes through the Main Wallet. Margin is locked, P&L
  // is settled and fees are charged inside the TRADING ACCOUNT's own wallet
  // (walletService writes every one of these rows against { userId, accountId }),
  // so naming the Main Wallet as the source or destination pointed at a wallet
  // whose balance did not move at all.
  if (l.type === 'TRADE_OPEN') {
    // A margin lock moves free → locked inside the same account; the balance is
    // unchanged, which is why before == after on this row.
    receivedFrom = acct; destination = 'Locked margin';
  } else if (l.type === 'TRADE_CLOSE') {
    // Realized P&L settles against the market, into or out of the account.
    if (amt >= 0) { receivedFrom = 'Market'; destination = acct; }
    else { receivedFrom = acct; destination = 'Market'; }
  } else if (l.type === 'FEE') {
    // The fee is debited from the trading account, not from nowhere.
    receivedFrom = acct; destination = 'System';
  }
  else if (l.type === 'ADJUSTMENT') { receivedFrom = 'System'; destination = 'Main Wallet'; }
  else if (l.type === 'INTERNAL_TRANSFER_OUT') { method = 'Internal'; receivedFrom = 'Main Wallet'; destination = cp || 'User Wallet'; }
  else if (l.type === 'INTERNAL_TRANSFER_IN') { method = 'Internal'; receivedFrom = cp || 'User Wallet'; destination = 'Main Wallet'; }
  else if (l.type === 'TRANSFER') { method = 'Internal'; receivedFrom = amt >= 0 ? 'Wallet' : 'Main Wallet'; destination = amt >= 0 ? 'Main Wallet' : 'Wallet'; }
  return {
    id: String(l._id || l.id),
    kind: 'ledger',
    date: l.createdAt,
    amount: amt,
    currency: l.currency || 'USD',
    status: 'COMPLETED',
    type,
    typeKey: type,
    method,
    receivedFrom,
    destination,
    description: l.note || type,
    accountId: l.accountId ? String(l.accountId) : null,
    beforeBal: _ledgerBefore(l),
    afterBal: _num(l.balanceAfter),
    // Ledger rows ARE wallet rows: amount and balance share one currency.
    balCurrency: l.currency || BASE_CURRENCY,
    raw: l,
  };
}

// Subscription (Main Wallet) ledger tx → common row. reason DEBITs are the
// plan/postpaid charges; CREDIT/REFUND are top-ups/refunds. Shown so every
// plan deduction appears here, not only on the Subscription Wallet page.
// Bonus-wallet reasons. Unknown values fall back to a title-cased version of the
// raw reason, so a new reason added server-side still renders readably.
const BONUS_REASON_LABEL = {
  REFERRAL_COMMISSION: 'Referral Commission',
  REFERRAL_DEPOSIT_BONUS: 'Referral Deposit Bonus',
  PARTNER_COMMISSION: 'Partner Commission',
  REVENUE_SHARE: 'Revenue Share',
  DEPOSIT_BONUS: 'Deposit Bonus',
  ADMIN_CREDIT: 'Bonus Credit',
  ADMIN_DEBIT: 'Bonus Debit',
  WITHDRAWAL: 'Bonus Withdrawal',
  TRANSFER_OUT: 'Transfer to Wallet',
};

const SUB_REASON_LABEL = {
  SUBSCRIPTION_CHARGE: 'Subscription Charge',
  RENEWAL: 'Subscription Renewal',
  ADMIN_DEBIT: 'Subscription Debit',
  DEPOSIT: 'Subscription Deposit',
  ADMIN_CREDIT: 'Subscription Credit',
  REFUND: 'Subscription Refund',
  WITHDRAWAL: 'Subscription Withdrawal',
};
// Bonus-wallet ledger row. BonusTransaction has the same shape as a
// SubscriptionTransaction (transactionType / reason / amount / balanceAfter), so
// this mirrors normalizeSubscription with Bonus Wallet wording.
function normalizeBonus(t) {
  const isCredit = String(t.transactionType).toUpperCase() === 'CREDIT';
  const amt = isCredit ? Math.abs(_num(t.amount) || 0) : -Math.abs(_num(t.amount) || 0);
  const reason = String(t.reason || (isCredit ? 'BONUS_CREDIT' : 'BONUS_DEBIT')).toUpperCase();
  const type = BONUS_REASON_LABEL[reason] || reason.split('_').map((x) => x.charAt(0) + x.slice(1).toLowerCase()).join(' ');
  const ok = String(t.status || 'SUCCESS').toUpperCase() === 'SUCCESS';
  return {
    id: String(t._id || t.id),
    kind: 'bonus',
    date: t.createdAt,
    amount: amt,
    currency: t.currency || 'USD',
    status: ok ? 'COMPLETED' : String(t.status).toUpperCase(),
    type,
    typeKey: 'Bonus',
    method: 'Bonus Wallet',
    receivedFrom: isCredit ? type : 'Bonus Wallet',
    destination: isCredit ? 'Bonus Wallet' : (t.note || 'Withdrawal'),
    description: t.note || type,
    accountId: null,
    afterBal: _num(t.balanceAfter),
    beforeBal: _num(t.balanceAfter) != null ? _num(t.balanceAfter) - amt : null,
    balCurrency: t.currency || BASE_CURRENCY,
    raw: { ...t, type: 'BONUS' },
  };
}

function normalizeSubscription(t) {
  const isCredit = t.transactionType === 'CREDIT' || t.transactionType === 'REFUND';
  const amt = (isCredit ? 1 : -1) * Math.abs(Number(t.amount || 0));
  const reason = String(t.reason || 'SUBSCRIPTION_CHARGE').toUpperCase();
  const type = SUB_REASON_LABEL[reason] || `Subscription ${reason.replaceAll('_', ' ').toLowerCase()}`.replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    id: String(t._id || t.id),
    kind: 'subscription',
    date: t.createdAt,
    amount: amt,
    currency: t.currency || 'USD',
    status: 'COMPLETED',
    type,
    typeKey: 'Subscription',
    method: 'Main Wallet',
    receivedFrom: isCredit ? 'Deposit' : 'Main Wallet',
    destination: isCredit ? 'Main Wallet' : 'Subscription',
    description: t.note || (t.planCode ? `${t.planCode}${t.billingCycle ? ' · ' + t.billingCycle : ''}` : type),
    accountId: null,
    // Main Wallet stores balanceAfter; before = after − signed amount.
    afterBal: _num(t.balanceAfter),
    beforeBal: _num(t.balanceAfter) != null ? _num(t.balanceAfter) - amt : null,
    balCurrency: t.currency || BASE_CURRENCY,
    raw: { ...t, type: 'SUBSCRIPTION' },
  };
}

// Credit transactions — an admin processed a deposit or withdrawal "on
// credit". The wallet moved when the credit was granted (that ledger row is
// harvested for the balance snapshot); the status tracks the real-world
// settlement, and the remarks come straight from the admin.
function normalizeCredit(c, ledgerByRef, acctName) {
  const isDep = String(c.kind || '').toUpperCase() === 'DEPOSIT';
  const amt = Number(c.amount || 0);
  const settled = Number(c.settledAmount || 0);
  const outstanding = Number(c.outstanding != null ? c.outstanding : amt - settled);
  const ccy = c.currency || BASE_CURRENCY;
  const sym = currencySymbol(ccy);
  const acct = (acctName && c.accountId && acctName.get(String(c.accountId))) || 'Trading Account';
  const snap = ledgerByRef && ledgerByRef.get(String(c._id || c.id));
  const parts = [isDep ? 'Deposit on credit' : 'Withdrawal on credit', `${sym}${fmtNum(amt, 2)}`];
  if (c.status === 'SETTLED') parts.push('Fully settled');
  else if (c.status === 'CANCELLED') parts.push('Cancelled');
  else parts.push(`Settled ${sym}${fmtNum(settled, 2)} of ${sym}${fmtNum(amt, 2)} · Outstanding ${sym}${fmtNum(outstanding, 2)}`);
  if (c.dueDate) parts.push(`Due ${new Date(c.dueDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`);
  if (c.remarks && String(c.remarks).trim()) parts.push(String(c.remarks).trim());
  return {
    id: String(c._id || c.id),
    kind: 'credit',
    date: c.createdAt,
    amount: isDep ? amt : -amt,
    currency: ccy,
    status: c.status || 'PENDING',
    type: isDep ? 'Credit Deposit' : 'Credit Withdrawal',
    typeKey: 'Credit',
    method: 'Credit',
    receivedFrom: isDep ? 'Admin (on credit)' : acct,
    destination: isDep ? acct : 'Admin (on credit)',
    description: parts.join(' · '),
    accountId: c.accountId ? String(c.accountId) : null,
    beforeBal: snap ? snap.before : null,
    afterBal: snap ? snap.after : null,
    balCurrency: (snap && snap.currency) || ccy,
    baseEq: null,
    raw: { ...c, type: 'CREDIT' },
  };
}

// ─── Status pill ──────────────────────────────────────────────────────
function StatusPill({ status }) {
  const s = String(status || '').toUpperCase();
  const map = {
    COMPLETED: { dot: '#16A34A', bg: '#16A34A14', fg: '#15803D' },
    CONFIRMED: { dot: '#16A34A', bg: '#16A34A14', fg: '#15803D' },
    APPROVED: { dot: '#16A34A', bg: '#16A34A14', fg: '#15803D' },
    PROCESSING: { dot: '#2563EB', bg: '#2563EB14', fg: '#1D4ED8' },
    SETTLED: { dot: '#16A34A', bg: '#16A34A14', fg: '#15803D' },
    PARTIALLY_SETTLED: { dot: '#2563EB', bg: '#2563EB14', fg: '#1D4ED8' },
    PENDING: { dot: '#D97706', bg: '#D9770614', fg: '#B45309' },
    REJECTED: { dot: '#DC2626', bg: '#DC262614', fg: '#B91C1C' },
    CANCELLED: { dot: '#64748B', bg: '#64748B14', fg: '#475569' },
  };
  const c = map[s] || { dot: '#64748B', bg: '#64748B14', fg: '#475569' };
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide whitespace-nowrap"
      style={{ background: c.bg, color: c.fg }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: c.dot }} />
      {s || 'UNKNOWN'}
    </span>
  );
}

// ─── Copy-to-clipboard button ─────────────────────────────────────────
function CopyBtn({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title="Copy Transaction ID"
      onClick={() => {
        try { navigator.clipboard?.writeText(text); } catch (_) {}
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="text-text-muted hover:text-primary-600 transition-colors shrink-0"
    >
      {done ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      )}
    </button>
  );
}

// ─── Shared dropdown helpers ──────────────────────────────────────────
function useDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return { open, setOpen, ref };
}

// Trigger "chip" — label on top, current value below, chevron + open ring.
function FilterTrigger({ icon, label, value, open, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 bg-white border rounded-xl px-3 py-2.5 text-left transition-all ${
        open ? 'border-primary-500 ring-2 ring-primary-500/30' : 'border-border-dark hover:border-primary-500/40'
      }`}
    >
      <span className="text-text-muted shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] uppercase tracking-wider text-text-muted font-bold truncate">{label}</span>
        <span className="block text-[13px] font-semibold text-text-primary truncate">{value}</span>
      </span>
      <svg
        width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        className={`text-text-muted shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  );
}

const Panel = ({ children }) => (
  <div className="absolute z-40 mt-1.5 w-full min-w-[248px] bg-white border border-border-dark rounded-xl shadow-elevated">
    {children}
  </div>
);

// iOS-style toggle switch.
function Toggle({ on, onChange }) {
  return (
    <button
      type="button"
      onClick={onChange}
      className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${on ? 'bg-primary-600' : 'bg-gray-300'}`}
      aria-pressed={on}
    >
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${on ? 'translate-x-4' : ''}`} />
    </button>
  );
}

// ─── Per-type leading icons (keyword-matched, with a fallback) ────────
function typeIcon(label) {
  const l = String(label).toLowerCase();
  const P = (d) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{d}</svg>;
  if (l.includes('deposit')) return P(<><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 21h16" /></>);
  if (l.includes('withdraw')) return P(<><path d="M12 21V9" /><path d="M7 14l5-5 5 5" /><path d="M4 3h16" /></>);
  if (l.includes('transfer')) return P(<><path d="M7 7h13l-3-3" /><path d="M17 17H4l3 3" /></>);
  if (l.includes('trade')) return P(<><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></>);
  if (l.includes('commission') || l.includes('referral')) return P(<><path d="M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7" /><rect x="2" y="7" width="20" height="5" rx="1" /><path d="M12 22V7" /><path d="M12 7S9 2 7 3.5 8 7 12 7z" /><path d="M12 7s3-5 5-3.5S16 7 12 7z" /></>);
  if (l.includes('charge')) return P(<><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></>);
  if (l.includes('invest')) return P(<><path d="M3 3v18h18" /><path d="M7 14l4-4 3 3 5-6" /></>);
  if (l.includes('bonus')) return P(<><rect x="3" y="8" width="18" height="13" rx="2" /><path d="M12 8v13M3 12h18" /></>);
  if (l.includes('conversion') || l.includes('adjust')) return P(<><path d="M4 7h13l-3-3" /><path d="M20 17H7l3 3" /></>);
  if (l.includes('fee')) return P(<><path d="M9 6l9 9" /><circle cx="7.5" cy="7.5" r="1.5" /><circle cx="16.5" cy="16.5" r="1.5" /><path d="M5 5l14 14" opacity="0" /></>);
  return P(<><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>);
}

const STATUS_COLOR = {
  COMPLETED: '#16A34A', CONFIRMED: '#16A34A', APPROVED: '#16A34A', DONE: '#16A34A',
  PROCESSING: '#2563EB', PENDING: '#D97706', REJECTED: '#DC2626', CANCELLED: '#94A3B8',
  SETTLED: '#16A34A', PARTIALLY_SETTLED: '#2563EB',
};
// Every status a deposit / withdrawal / ledger row can carry — so the Status
// filter always offers the full set, even when the current history has none of
// a given status yet. (Deposit: PENDING/CONFIRMED/REJECTED/CANCELLED,
// Withdrawal: PENDING/APPROVED/PROCESSING/COMPLETED/REJECTED/CANCELLED.)
const ALL_STATUSES = ['PENDING', 'PROCESSING', 'CONFIRMED', 'APPROVED', 'COMPLETED', 'PARTIALLY_SETTLED', 'SETTLED', 'REJECTED', 'CANCELLED'];
const statusDot = (status) => (
  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: STATUS_COLOR[String(status).toUpperCase()] || '#94A3B8' }} />
);

// ─── Fixed transaction-type categories (matches the reference UI) ─────
// The filter always shows this full set, regardless of which types the
// data currently contains. Every row is mapped into exactly one bucket
// via `categoryOf` so the toggles filter correctly.
const TYPE_CATEGORIES = [
  'Deposit',
  'Withdrawal',
  'Transfer - Internal',
  'Transfer - External',
  'Transfer - Wallet to Account',
  'Transfer - Account to Wallet',
  'Transfer - Wallet to Wallet',
  'Trade Open',
  'Trade Close',
  'Fee',
  'Commission',
  'Charge',
  'Subscription',
  'Investment',
  'Bonus',
  'Referral Commission Earned',
  'Referral Deposit Bonus',
  'Credit',
  'Others',
];

function categoryIcon(label) {
  const P = (d) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{d}</svg>;
  switch (label) {
    case 'Deposit': return P(<><path d="M12 3v11" /><path d="M8 10l4 4 4-4" /><path d="M4 21h16" /></>);
    case 'Withdrawal': return P(<><rect x="2" y="6" width="20" height="13" rx="2" /><path d="M2 10h20" /><path d="M12 13v6" /><path d="M9 16l3 3 3-3" /></>);
    case 'Transfer - Internal': return P(<><path d="M7 7h12l-3-3" /><path d="M17 17H5l3 3" /></>);
    case 'Transfer - External': return P(<><path d="M4 12a8 8 0 0 1 13-6" /><path d="M17 3v3h-3" /><path d="M20 12a8 8 0 0 1-13 6" /><path d="M7 21v-3h3" /></>);
    case 'Transfer - Wallet to Account': return P(<><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></>);
    case 'Transfer - Account to Wallet': return P(<><path d="M17 7H5l3-3" /><path d="M7 17h12l-3 3" /></>);
    case 'Transfer - Wallet to Wallet': return P(<><path d="M7 7h12l-3-3" /><path d="M17 17H5l3 3" /><circle cx="4" cy="8" r="1" /><circle cx="20" cy="16" r="1" /></>);
    case 'Trade Open': return P(<><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></>);
    case 'Trade Close': return P(<><path d="M3 7l6 6 4-4 8 8" /><path d="M14 17h7v-7" /></>);
    case 'Fee': return P(<><circle cx="12" cy="12" r="9" /><path d="M15 9.3c-.6-.9-1.7-1.3-3-1.3-1.7 0-3 .8-3 2s1.3 1.8 3 2 3 .9 3 2-1.3 2-3 2c-1.3 0-2.4-.5-3-1.4" /><path d="M12 6.5v11" /></>);
    case 'Commission': return P(<><circle cx="12" cy="12" r="3.2" /><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1l2.1-2.1M17 7l2.1-2.1" /></>);
    case 'Charge': return P(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
    case 'Investment': return P(<><path d="M3 3v18h18" /><path d="M7 14l4-4 3 3 5-6" /></>);
    case 'Bonus': return P(<><rect x="3" y="8" width="18" height="13" rx="2" /><path d="M12 8v13M3 12h18" /><path d="M12 8S9 3 7 4.5 8 8 12 8z" /><path d="M12 8s3-5 5-3.5S16 8 12 8z" /></>);
    case 'Referral Commission Earned':
    case 'Referral Deposit Bonus': return P(<><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M2 11h20" /><circle cx="7" cy="16" r="1" /></>);
    case 'Subscription': return P(<><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /><path d="M6 15h5" /></>);
    case 'Credit': return P(<><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /><path d="M7 15h4" /><path d="M16 13v4M14 15h4" /></>);
    default: return P(<><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>);
  }
}

// Map a normalized row into exactly one of the TYPE_CATEGORIES buckets.
function categoryOf(row) {
  if (row.kind === 'subscription') return 'Subscription';
  if (row.kind === 'deposit') return 'Deposit';
  if (row.kind === 'withdrawal') return 'Withdrawal';
  if (row.kind === 'credit') return 'Credit';
  const t = row.raw?.type;
  if (t === 'TRANSFER') return 'Transfer - Internal';
  if (t === 'INTERNAL_TRANSFER_OUT' || t === 'INTERNAL_TRANSFER_IN') return 'Transfer - External';
  if (t === 'TRADE_OPEN') return 'Trade Open';
  if (t === 'TRADE_CLOSE') return 'Trade Close';
  if (t === 'FEE') return 'Fee';
  const s = `${row.type} ${row.description}`.toLowerCase();
  if (s.includes('wallet to account')) return 'Transfer - Wallet to Account';
  if (s.includes('account to wallet')) return 'Transfer - Account to Wallet';
  if (s.includes('wallet to wallet')) return 'Transfer - Wallet to Wallet';
  if (s.includes('referral') && s.includes('commission')) return 'Referral Commission Earned';
  if (s.includes('referral') && (s.includes('deposit') || s.includes('bonus'))) return 'Referral Deposit Bonus';
  if (s.includes('commission')) return 'Commission';
  if (s.includes('bonus')) return 'Bonus';
  if (s.includes('charge')) return 'Charge';
  if (s.includes('invest')) return 'Investment';
  return 'Others';
}

// ─── Multi-select dropdown with header + Select All + toggles ─────────
function MultiSelect({ icon, label, title, options, selected, onChange, renderLeading }) {
  const { open, setOpen, ref } = useDropdown();
  const all = options.length > 0 && selected.length === options.length;
  const summary = options.length === 0 ? 'None'
    : all ? `All Selected (${options.length})`
    : selected.length === 0 ? 'None Selected'
    : `${selected.length} Selected`;
  const toggle = (o) => selected.includes(o) ? onChange(selected.filter((x) => x !== o)) : onChange([...selected, o]);
  return (
    <div className="relative min-w-0" ref={ref}>
      <FilterTrigger icon={icon} label={label} value={summary} open={open} onClick={() => setOpen((o) => !o)} />
      {open && (
        <Panel>
          <div className="flex items-center justify-between px-3.5 pt-3 pb-2 border-b border-border-subtle">
            <span className="text-[13px] font-bold text-text-primary">{title}</span>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-text-muted">Select All</span>
              <Toggle on={all} onChange={() => onChange(all ? [] : [...options])} />
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto p-1.5">
            {options.map((o) => (
              <div key={o} className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-bg-hover">
                {renderLeading && <span className="text-text-secondary shrink-0 flex items-center">{renderLeading(o)}</span>}
                <span className="text-[13px] text-text-primary truncate flex-1">{o}</span>
                <Toggle on={selected.includes(o)} onChange={() => toggle(o)} />
              </div>
            ))}
            {options.length === 0 && <div className="px-2 py-3 text-[12px] text-text-muted">No options</div>}
          </div>
        </Panel>
      )}
    </div>
  );
}

// ─── Date-range dropdown (presets + checkmarks + custom range) ────────
const CalIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>;
const DATE_PRESETS = [
  { k: 'today', label: 'Today' },
  { k: 'yesterday', label: 'Yesterday' },
  { k: '7d', label: 'Last 7 Days' },
  { k: '30d', label: 'Last 30 Days' },
  { k: '90d', label: 'Last 90 Days' },
  { k: '3m', label: 'Last 3 Months' },
  { k: '6m', label: 'Last 6 Months' },
  { k: '1y', label: 'Last 1 Year' },
  { k: 'all', label: 'All Time' },
  { k: 'custom', label: 'Custom Range' },
];
function DateRangeSelect({ value, custom, onChange, onCustomChange }) {
  const { open, setOpen, ref } = useDropdown();
  const cur = DATE_PRESETS.find((p) => p.k === value) || DATE_PRESETS[8];
  return (
    <div className="relative min-w-0" ref={ref}>
      <FilterTrigger icon={<CalIcon />} label="Date Range" value={cur.label} open={open} onClick={() => setOpen((o) => !o)} />
      {open && (
        <Panel>
          <div className="px-3.5 pt-3 pb-2 border-b border-border-subtle text-[13px] font-bold text-text-primary">Select Date Range</div>
          <div className="max-h-80 overflow-y-auto p-1.5">
            {DATE_PRESETS.map((p) => {
              const active = value === p.k;
              return (
                <button
                  key={p.k}
                  type="button"
                  onClick={() => { onChange(p.k); if (p.k !== 'custom') setOpen(false); }}
                  className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition-colors ${active ? 'bg-primary-500/10' : 'hover:bg-bg-hover'}`}
                >
                  <span className={active ? 'text-primary-600' : 'text-text-muted'}><CalIcon /></span>
                  <span className={`text-[13px] flex-1 truncate ${active ? 'text-primary-600 font-semibold' : 'text-text-primary'}`}>{p.label}</span>
                  {active && (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-primary-600 shrink-0"><path d="M20 6L9 17l-5-5" /></svg>
                  )}
                </button>
              );
            })}
            {value === 'custom' && (
              <div className="px-2 pt-2 pb-1 flex flex-col gap-2">
                <label className="text-[11px] font-semibold text-text-muted">From
                  <input type="date" value={custom.from} onChange={(e) => onCustomChange({ ...custom, from: e.target.value })} className="mt-1 w-full text-[13px] text-text-primary border border-border-dark rounded-lg px-2 py-1.5 outline-none focus:border-primary-500" />
                </label>
                <label className="text-[11px] font-semibold text-text-muted">To
                  <input type="date" value={custom.to} onChange={(e) => onCustomChange({ ...custom, to: e.target.value })} className="mt-1 w-full text-[13px] text-text-primary border border-border-dark rounded-lg px-2 py-1.5 outline-none focus:border-primary-500" />
                </label>
              </div>
            )}
          </div>
        </Panel>
      )}
    </div>
  );
}

// ─── Account dropdown (single-select, radio rows) ─────────────────────
const WalletIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="13" rx="2" /><path d="M2 10h20" /><circle cx="17" cy="14.5" r="1.2" /></svg>;
function AccountSelect({ accounts, value, onChange }) {
  const { open, setOpen, ref } = useDropdown();
  const opts = [
    { id: 'all', name: 'All Accounts', sub: '' },
    // Neither is a trading account, so neither carries an accountId — they were
    // unreachable from this filter until rows gained a walletScope.
    { id: 'wallet:subscription', name: 'Main Wallet', sub: 'Plan charges & top-ups' },
    { id: 'wallet:bonus', name: 'Bonus Wallet', sub: 'Referral & partner earnings' },
    ...accounts.map((a) => {
      const name = a.nickname || a.accountNumber || a.accountType || 'Account';
      // Show the account number as a subline — unless the name already IS it.
      return { id: String(a._id), name, sub: a.accountNumber && a.accountNumber !== name ? a.accountNumber : '' };
    }),
  ];
  const cur = opts.find((o) => o.id === value) || opts[0];
  return (
    <div className="relative min-w-0" ref={ref}>
      <FilterTrigger icon={<WalletIcon />} label="Accounts" value={cur.name} open={open} onClick={() => setOpen((o) => !o)} />
      {open && (
        <Panel>
          <div className="px-3.5 pt-3 pb-2 border-b border-border-subtle text-[13px] font-bold text-text-primary">Select Account</div>
          <div className="max-h-72 overflow-y-auto p-1.5">
            {opts.map((o) => {
              const active = value === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => { onChange(o.id); setOpen(false); }}
                  className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left hover:bg-bg-hover transition-colors"
                >
                  <span className="text-text-muted shrink-0"><WalletIcon /></span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13px] text-text-primary truncate">{o.name}</span>
                    {o.sub && <span className="block text-[11px] font-mono text-text-muted truncate">{o.sub}</span>}
                  </span>
                  <span className={`w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${active ? 'border-primary-600' : 'border-gray-300'}`}>
                    {active && <span className="w-2 h-2 rounded-full bg-primary-600" />}
                  </span>
                </button>
              );
            })}
          </div>
        </Panel>
      )}
    </div>
  );
}

// Date-range filtering now uses the shared, inclusive helper
// (client/src/utils/dateRange.js → matchesDateRange). Custom From==To correctly
// returns the whole selected day.

// ─── Details modal ────────────────────────────────────────────────────
function DetailsModal({ row, onClose }) {
  if (!row) return null;
  const sign = row.amount > 0 ? '+' : row.amount < 0 ? '-' : '';
  const rows = [
    ['Transaction ID', txnDisplayId(row.id)],
    ['Date & Time', fmtDateTime(row.date)],
    ['Type', row.type],
    ['Amount', `${sign}${currencySymbol(row.currency)}${fmtNum(Math.abs(row.amount), 2)}`],
    // The USD the wallet actually moved, and the rate that got us there.
    ...(row.baseEq && row.baseEq.currency !== row.currency
      ? [[`Amount (${row.baseEq.currency})`, `${sign}${currencySymbol(row.baseEq.currency)}${fmtNum(Math.abs(row.baseEq.amount), 2)}`]]
      : []),
    ...(row.baseEq && row.baseEq.rate && row.baseEq.rate !== 1
      ? [['Exchange Rate', `1 ${row.baseEq.currency} = ${fmtNum(row.baseEq.rate, 4)} ${row.currency}`]]
      : []),
    // Balances are the WALLET's, so they carry the wallet's currency.
    ['Balance Before', row.beforeBal != null ? `${currencySymbol(balCcy(row))}${fmtNum(row.beforeBal, 2)}` : '—'],
    ['Balance After', row.afterBal != null ? `${currencySymbol(balCcy(row))}${fmtNum(row.afterBal, 2)}` : '—'],
    ['Currency', row.currency],
    ['Status', row.status],
    ['Payment Method', row.method],
    ['Received From', String(row.receivedFrom).replace(/\n/g, ' · ')],
    ['Destination', String(row.destination).replace(/\n/g, ' · ')],
    // Order reference for trade & fee rows, so a close, its fee and the
    // position on the trade screen can be matched by eye. Shows the SHORT
    // ticket — the raw 24-char ObjectId that used to sit here is internal and
    // appears nowhere else in the product, so it identified nothing to the
    // person reading it. The full id stays underneath for support.
    ...(row.raw?.referenceId ? [['Order ID', ticketShort(row.raw.referenceId), String(row.raw.referenceId)]] : []),
    ['Description', rowDescription(row)],
  ];
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto shadow-elevated" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle sticky top-0 bg-white">
          <div className="text-sm font-bold text-text-primary">Transaction Details</div>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-text-primary">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="p-5 space-y-3">
          {rows.map(([k, v, sysRef]) => (
            <div key={k} className="flex items-start justify-between gap-4">
              <span className="text-[11px] uppercase tracking-wider text-text-muted font-bold shrink-0 pt-0.5">{k}</span>
              <span className="text-[13px] font-semibold text-text-primary text-right break-all">
                {sysRef ? (
                  <>
                    <span className="font-mono">{v}</span>
                    <span className="block text-[10px] font-normal font-mono text-text-muted mt-0.5" title="Internal reference">{sysRef}</span>
                  </>
                ) : v}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────
export default function TransactionHistory({ deposits = [], withdrawals = [], ledger = [], subscriptions = [], bonusTx = [], creditTx = [], accounts = [], loading }) {
  // Personal notes (client-side only — backend has no per-tx user note field).
  const [notes, setNotes] = useState(() => {
    try { return JSON.parse(localStorage.getItem('txnNotes') || '{}'); } catch { return {}; }
  });
  const saveNote = (id, val) => {
    const next = { ...notes };
    if (val) next[id] = val; else delete next[id];
    setNotes(next);
    try { localStorage.setItem('txnNotes', JSON.stringify(next)); } catch (_) {}
  };
  const [editingNote, setEditingNote] = useState(null);
  const [detailRow, setDetailRow] = useState(null);

  // Filters
  const [dateRange, setDateRange] = useState('all');
  const [customRange, setCustomRange] = useState({ from: '', to: '' });
  const [accountId, setAccountId] = useState('all');
  const [search, setSearch] = useState('');
  const [typeSel, setTypeSel] = useState(null);   // null = all (initialized once options known)
  const [statusSel, setStatusSel] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);

  // Build the unified list. Ledger DEPOSIT/WITHDRAWAL rows are dropped —
  // they'd duplicate the richer deposit/withdrawal records which carry the
  // full status lifecycle (pending/rejected), whereas the ledger only
  // posts settled entries.
  const allRows = useMemo(() => {
    const acctName = new Map();
    // Name AND number. The nickname alone is ambiguous the moment a user has
    // two accounts of the same tier ("Standard Account" twice), and the number
    // is what support and the account switcher actually identify them by.
    for (const a of accounts) {
      const name = a.nickname || a.accountType || 'Account';
      const num = a.accountNumber ? String(a.accountNumber) : '';
      // Parenthesised, not " · " separated: the description joins its own
      // parts with " · ", so an account label using the same separator read as
      // two unrelated items ("from Standard Account · 694807545 · to UPI ID…").
      acctName.set(String(a._id), num && num !== name ? `${name} (${num})` : (num || name));
    }
    // Realized-balance snapshots for deposit/withdrawal rows come from their
    // matching trading-wallet ledger entry (the DEPOSIT/WITHDRAWAL ledger rows
    // are dropped from the list below, but we still harvest their before/after).
    const ledgerByRef = new Map();
    for (const e of ledger) {
      if (e.referenceId && (e.type === 'DEPOSIT' || e.type === 'WITHDRAWAL')) {
        // The ledger row's currency is the WALLET's currency — that is what the
        // before/after figures are denominated in, not the deposit's currency.
        ledgerByRef.set(String(e.referenceId), { before: _ledgerBefore(e), after: _num(e.balanceAfter), currency: e.currency || BASE_CURRENCY });
      }
    }
    // Main/Bonus withdrawals have no WalletLedger row — their balance
    // snapshot sits on the wallet debit that funded them, which carries the
    // withdrawal id in `referenceId`. Fold those into the same lookup so a
    // withdrawal row finds its balances wherever they happen to live.
    //
    // `balanceBefore` is derived: these transactions store balanceAfter, and
    // a DEBIT of `amount` means the balance before it was after + amount.
    for (const t of [...(subscriptions || []), ...(bonusTx || [])]) {
      if (!t || !t.referenceId) continue;
      const after = _num(t.balanceAfter);
      if (!Number.isFinite(after)) continue;
      const amt = Math.abs(_num(t.amount) || 0);
      const isDebit = String(t.transactionType || '').toUpperCase() === 'DEBIT';
      ledgerByRef.set(String(t.referenceId), {
        before: isDebit ? after + amt : after - amt,
        after,
        currency: t.currency || BASE_CURRENCY,
      });
    }
    const d = deposits.map((x) => normalizeDeposit(x, ledgerByRef, acctName));
    const w = withdrawals.map((x) => normalizeWithdrawal(x, ledgerByRef, acctName));
    const l = ledger
      .filter((e) => e.type !== 'DEPOSIT' && e.type !== 'WITHDRAWAL')
      .map((e) => normalizeLedger(e, acctName));
    // A Main/Bonus wallet withdrawal already appears as a Withdrawal row
    // (with its method, destination and approval status). The wallet debit
    // that funded it is the SAME event seen from the ledger side, so showing
    // both listed one payout twice — which reads as a phantom transaction.
    //
    // Only the debit is dropped. A later REFUND credit stays: money returning
    // after a rejection genuinely is a separate event.
    const isWithdrawalLeg = (t) => String(t?.reason || '').toUpperCase() === 'WITHDRAWAL';
    const s = subscriptions.filter((t) => !isWithdrawalLeg(t)).map(normalizeSubscription);
    const bn = bonusTx.filter((t) => !isWithdrawalLeg(t)).map(normalizeBonus);
    const cr = creditTx.map((x) => normalizeCredit(x, ledgerByRef, acctName));
    // Which wallet each row belongs to. Trading rows are identified by accountId,
    // but Main Wallet and Bonus Wallet rows have none — they are not tied to a
    // trading account — so the Accounts filter could never reach them. Deposits and
    // withdrawals already record their wallet (targetWallet / source), so a deposit
    // made straight into the Bonus Wallet is scoped to it rather than to trading.
    const scopeOf = (r) => {
      if (r.kind === 'subscription') return 'subscription';
      if (r.kind === 'bonus') return 'bonus';
      if (r.kind === 'deposit') return String(r.raw?.targetWallet || 'trading').toLowerCase();
      if (r.kind === 'withdrawal') return String(r.raw?.source || 'trading').toLowerCase();
      return 'trading';
    };
    return [...d, ...w, ...l, ...s, ...bn, ...cr]
      .map((r) => ({ ...r, category: categoryOf(r), walletScope: scopeOf(r) }))
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [deposits, withdrawals, ledger, subscriptions, bonusTx, creditTx, accounts]);

  const typeOptions = TYPE_CATEGORIES;
  // Always offer every possible status (not just those present in the current
  // history), plus any unexpected value that shows up in the data.
  const statusOptions = useMemo(() => {
    const present = new Set(allRows.map((r) => r.status).filter(Boolean));
    const extra = [...present].filter((s) => !ALL_STATUSES.includes(s)).sort();
    return [...ALL_STATUSES, ...extra];
  }, [allRows]);

  // Default the multiselects to "all" once options are known.
  const effTypeSel = typeSel === null ? typeOptions : typeSel;
  const effStatusSel = statusSel === null ? statusOptions : statusSel;

  const accountLabel = useMemo(() => {
    const m = new Map();
    for (const a of accounts) m.set(String(a._id), a.nickname || a.accountNumber || a.accountType || 'Account');
    return m;
  }, [accounts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allRows.filter((r) => {
      if (!matchesDateRange(r.date, dateRange, customRange)) return false;
      // Account
      // A 'wallet:' selection filters by which wallet the row belongs to; anything
      // else is a real trading account id. The prefix guarantees the two can never
      // collide with an ObjectId.
      if (accountId.startsWith('wallet:')) {
        if (r.walletScope !== accountId.slice(7)) return false;
      } else if (accountId !== 'all' && r.accountId !== accountId) return false;
      // Type category
      if (!effTypeSel.includes(r.category)) return false;
      // Status
      if (!effStatusSel.includes(r.status)) return false;
      // Search
      if (q) {
        // Include BOTH the short ticket and the raw reference so "726B5A",
        // "#726B5A" and the full ObjectId all find the row.
        const hay = `${txnDisplayId(r.id)} ${rowTicket(r) || ''} ${r.raw?.referenceId || ''} ${rowDescription(r)} ${r.destination} ${r.receivedFrom} ${r.type} ${r.method}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [allRows, dateRange, customRange, accountId, effTypeSel, effStatusSel, search]);

  // Reset to first page whenever a filter changes.
  useEffect(() => { setPage(1); }, [dateRange, customRange, accountId, search, typeSel, statusSel, pageSize]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((clampedPage - 1) * pageSize, clampedPage * pageSize);

  const exportCsv = () => {
    const cols = ['Date & Time', 'Transaction ID', 'Order ID', 'Amount', 'Currency', `Amount (${BASE_CURRENCY})`, 'Balance Before', 'Balance After', 'Balance Currency', 'Status', 'Type', 'Payment Method', 'Received From', 'Destination', 'Description', 'Note'];
    const esc = (v) => `"${String(v ?? '').replace(/\n/g, ' ').replace(/"/g, '""')}"`;
    const lines = [cols.map(esc).join(',')];
    for (const r of filtered) {
      lines.push([
        fmtDateTime(r.date), txnDisplayId(r.id), rowTicket(r) || '', r.amount.toFixed(2),
        r.currency,
        r.baseEq ? r.baseEq.amount.toFixed(2) : (balCcy(r) === r.currency ? r.amount.toFixed(2) : ''),
        r.beforeBal != null ? r.beforeBal.toFixed(2) : '', r.afterBal != null ? r.afterBal.toFixed(2) : '',
        balCcy(r), r.status,
        r.type, r.method, r.receivedFrom, r.destination, rowDescription(r), notes[r.id] || '',
      ].map(esc).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transactions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const pageNumbers = useMemo(() => {
    const out = [];
    const win = 2;
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || Math.abs(i - clampedPage) <= win) out.push(i);
      else if (out[out.length - 1] !== '…') out.push('…');
    }
    return out;
  }, [totalPages, clampedPage]);

  return (
    <div className="bg-white border border-border-dark rounded-2xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-5 py-4 border-b border-border-subtle">
        <div>
          <h2 className="text-lg font-bold text-text-primary">Transaction History</h2>
          <p className="text-[12px] text-text-muted mt-0.5">View and manage all your transactions in one place.</p>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-border-dark text-text-primary text-[13px] font-semibold hover:shadow-card hover:border-primary-500/40 transition-all self-start sm:self-auto"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></svg>
          Export
        </button>
      </div>

      {/* Filter bar */}
      <div className="px-5 py-4 border-b border-border-subtle grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
        <DateRangeSelect value={dateRange} custom={customRange} onChange={setDateRange} onCustomChange={setCustomRange} />
        <MultiSelect
          icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M7 12h10M10 18h4" /></svg>}
          label="Transaction Type" title="Select Transaction Type"
          options={typeOptions} selected={effTypeSel} onChange={setTypeSel} renderLeading={categoryIcon}
        />
        <MultiSelect
          icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 9 9h-9z" /></svg>}
          label="Status" title="Select Status"
          options={statusOptions} selected={effStatusSel} onChange={setStatusSel} renderLeading={statusDot}
        />
        <AccountSelect accounts={accounts} value={accountId} onChange={setAccountId} />
        <div className="flex items-center gap-2 bg-white border border-border-dark rounded-xl px-3 py-2.5 xl:col-span-1">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted shrink-0"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by ID, description…"
            className="w-full text-[13px] text-text-primary bg-transparent outline-none placeholder:text-text-muted"
          />
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        {loading ? (
          <div className="py-16 text-center text-sm text-text-muted">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-sm text-text-muted">No transactions match your filters</div>
        ) : (
          <table className="w-full text-sm min-w-[1380px]">
            <thead className="text-[10px] text-text-muted uppercase tracking-wider font-bold bg-bg-hover">
              <tr>
                <th className="text-left px-4 py-3">Date &amp; Time</th>
                <th className="text-left px-4 py-3">Transaction ID</th>
                <th className="text-right px-4 py-3">Amount</th>
                <th className="text-right px-4 py-3">Balance Before</th>
                <th className="text-right px-4 py-3">Balance After</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">Type</th>
                <th className="text-left px-4 py-3">Payment Method</th>
                <th className="text-left px-4 py-3">Currency</th>
                <th className="text-left px-4 py-3">Received From</th>
                <th className="text-left px-4 py-3">Destination</th>
                <th className="text-left px-4 py-3">Description</th>
                <th className="text-center px-4 py-3">Note</th>
                <th className="text-center px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {pageRows.map((r) => {
                const sign = r.amount > 0 ? '+' : r.amount < 0 ? '-' : '';
                const amtColor = r.amount > 0 ? 'text-bull' : r.amount < 0 ? 'text-bear' : 'text-text-secondary';
                return (
                  <tr key={`${r.kind}-${r.id}`} className="hover:bg-bg-hover transition-colors align-top">
                    <td className="px-4 py-3 text-text-secondary text-[12px] whitespace-nowrap">{fmtDateTime(r.date)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[11px] text-text-primary">{txnDisplayId(r.id)}</span>
                        <CopyBtn text={txnDisplayId(r.id)} />
                      </div>
                    </td>
                    <td className={`px-4 py-3 text-right font-mono tabular-nums font-bold whitespace-nowrap ${amtColor}`}>
                      {sign}{currencySymbol(r.currency)}{fmtNum(Math.abs(r.amount), 2)}
                      {/* What that actually came to in the wallet's currency. */}
                      {r.baseEq && r.baseEq.currency !== r.currency && (
                        <div className="text-[10px] font-normal text-text-muted mt-0.5">
                          ≈ {sign}{currencySymbol(r.baseEq.currency)}{fmtNum(Math.abs(r.baseEq.amount), 2)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-[12px] text-text-muted whitespace-nowrap">
                      {r.beforeBal != null ? `${currencySymbol(balCcy(r))}${fmtNum(r.beforeBal, 2)}` : '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-[12px] font-semibold text-text-primary whitespace-nowrap">
                      {r.afterBal != null ? `${currencySymbol(balCcy(r))}${fmtNum(r.afterBal, 2)}` : '—'}
                    </td>
                    <td className="px-4 py-3"><StatusPill status={r.status} /></td>
                    <td className="px-4 py-3 text-text-primary text-[12px] font-medium whitespace-nowrap">{r.type}</td>
                    <td className="px-4 py-3 text-text-secondary text-[12px] whitespace-nowrap">{r.method}</td>
                    <td className="px-4 py-3 text-text-secondary text-[12px] font-mono">{r.currency}</td>
                    <td className="px-4 py-3 text-text-secondary text-[12px] whitespace-pre-line max-w-[160px]">{r.receivedFrom}</td>
                    <td className="px-4 py-3 text-text-secondary text-[12px] whitespace-pre-line max-w-[160px] break-words">{r.destination}</td>
                    <td className="px-4 py-3 text-text-secondary text-[12px] max-w-[200px]">{rowDescription(r)}</td>
                    <td className="px-4 py-3 text-center">
                      {editingNote === r.id ? (
                        <input
                          autoFocus
                          defaultValue={notes[r.id] || ''}
                          onBlur={(e) => { saveNote(r.id, e.target.value.trim()); setEditingNote(null); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditingNote(null); }}
                          className="w-32 text-[12px] border border-primary-500/50 rounded-lg px-2 py-1 outline-none"
                        />
                      ) : notes[r.id] ? (
                        // Note exists → show the text (truncated) + click to edit.
                        <button
                          type="button"
                          title={`${notes[r.id]} — click to edit`}
                          onClick={() => setEditingNote(r.id)}
                          className="inline-flex items-center gap-1.5 max-w-[150px] text-[12px] text-text-primary hover:text-primary-600 transition-colors"
                        >
                          <span className="truncate">{notes[r.id]}</span>
                          <svg width="12" height="12" className="shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                        </button>
                      ) : (
                        <button
                          type="button"
                          title="Add note"
                          onClick={() => setEditingNote(r.id)}
                          className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-text-muted hover:text-primary-600 hover:bg-bg-hover transition-colors"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        type="button"
                        title="View details"
                        onClick={() => setDetailRow(r)}
                        className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-text-muted hover:text-primary-600 hover:bg-bg-hover transition-colors"
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" /><circle cx="12" cy="12" r="3" /></svg>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer / pagination */}
      {!loading && filtered.length > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-5 py-4 border-t border-border-subtle">
          <div className="text-[12px] text-text-muted">
            Showing {(clampedPage - 1) * pageSize + 1} to {Math.min(clampedPage * pageSize, filtered.length)} of {filtered.length} entries
          </div>
          <div className="flex items-center gap-3">
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="text-[12px] font-semibold text-text-primary bg-white border border-border-dark rounded-lg px-2.5 py-1.5 outline-none cursor-pointer"
            >
              {[15, 25, 50, 100].map((n) => <option key={n} value={n}>{n} per page</option>)}
            </select>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={clampedPage === 1}
                onClick={() => setPage(clampedPage - 1)}
                className="w-8 h-8 flex items-center justify-center rounded-lg border border-border-dark text-text-secondary disabled:opacity-40 hover:bg-bg-hover transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
              </button>
              {pageNumbers.map((n, i) =>
                n === '…' ? (
                  <span key={`e${i}`} className="w-8 h-8 flex items-center justify-center text-text-muted text-[12px]">…</span>
                ) : (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setPage(n)}
                    className={`w-8 h-8 flex items-center justify-center rounded-lg text-[12px] font-semibold transition-colors ${
                      n === clampedPage ? 'bg-primary-600 text-white' : 'border border-border-dark text-text-secondary hover:bg-bg-hover'
                    }`}
                  >
                    {n}
                  </button>
                )
              )}
              <button
                type="button"
                disabled={clampedPage === totalPages}
                onClick={() => setPage(clampedPage + 1)}
                className="w-8 h-8 flex items-center justify-center rounded-lg border border-border-dark text-text-secondary disabled:opacity-40 hover:bg-bg-hover transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
              </button>
            </div>
          </div>
        </div>
      )}

      <DetailsModal row={detailRow} onClose={() => setDetailRow(null)} />
    </div>
  );
}
