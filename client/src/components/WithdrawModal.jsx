import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';

/**
 * Shared withdrawal modal for the standalone wallets (Main / Bonus).
 *
 * Two steps, the same shape the trading wallet's withdraw flow uses:
 *
 *   1. METHOD      — the payment rails the admin has opened for withdrawals,
 *                    each with its own fee, limits and payout currency.
 *   2. WITHDRAW TO — the user's SAVED, VERIFIED destinations on that rail.
 *
 * Both layers matter. The rail is what the admin controls (is UPI open for
 * payouts? what does it charge? what does it pay out in?), and the destination
 * is what the compliance rule controls — WithdrawalMethod's own header:
 *
 *   "a real withdrawal may ONLY target a method this user has saved AND that
 *    an admin has moved to VERIFIED. The user can never type an arbitrary
 *    bank / UPI / wallet at withdraw time."
 *
 * Only the destination id travels to the server, which resolves the real
 * account from the verified record — the browser only ever holds a masked
 * view of it, so it could not send the real one even if it tried.
 *
 * Rails are limited to the types a destination can actually be saved as
 * (WITHDRAWAL_METHOD_TYPES: BANK, UPI, CRYPTO). Offering a rail nobody can
 * have a verified destination on would just be a dead end.
 *
 * Props:
 *   endpoint  POST target, e.g. '/subscription-wallet/withdraw' | '/bonus-wallet/withdraw'
 *   title     header label, e.g. 'Withdraw from Main Wallet'
 *   currency  wallet currency (e.g. 'INR')
 *   balance   numeric available balance
 *   onClose / onSuccess
 */

// The rails a payout can use. These mirror WITHDRAWAL_METHOD_TYPES, because a
// payout needs a verified destination and only these three can have one.
// RAZORPAY is absent on purpose: it is an automatic DEPOSIT gateway.
// Mirrors the server: FIXED_METHOD_IDS, NATIVE_DESTINATION_RAILS and
// DEFAULT_WITHDRAWAL_FIELDS in backend/src/utils/paymentMethods.js. Duplicated
// because the client cannot import from backend/src; keep the two in step.
const FIXED_RAIL_IDS = ['UPI', 'BANK', 'CRYPTO', 'SKRILL', 'NETELLER', 'RAZORPAY'];
const RAIL_META = {
  UPI:      { label: 'UPI',            blurb: 'Instant · to your UPI ID',   emoji: '📱' },
  BANK:     { label: 'Bank Transfer',  blurb: 'NEFT / IMPS · 1-24 hrs',     emoji: '🏦' },
  CRYPTO:   { label: 'Crypto (USDT)',  blurb: 'TRC20 / ERC20 / BEP20',      emoji: '🪙' },
  SKRILL:   { label: 'Skrill',         blurb: 'e-wallet',                   emoji: '💳' },
  NETELLER: { label: 'Neteller',       blurb: 'e-wallet',                   emoji: '💳' },
  RAZORPAY: { label: 'Razorpay',       blurb: 'Gateway',                    emoji: '⚡' },
};
// Rails with their own columns on WithdrawalMethod and their own form.
const NATIVE_DESTINATION_RAILS = new Set(['UPI', 'BANK', 'CRYPTO']);
const DEFAULT_WITHDRAWAL_FIELDS = [{ label: 'Account / address', required: true, sensitive: true }];

// What a payout to this rail asks the user for, or null when it has its own
// form. The default keeps an enabled-but-undescribed rail usable rather than
// hiding it, which made the admin toggle look broken.
const withdrawalSchema = (railId, cfg) => {
  const given = Array.isArray(cfg?.withdrawalFields) ? cfg.withdrawalFields.filter((f) => f && f.label) : [];
  // An admin-defined schema wins on ANY rail — mirrors the server, where the
  // same rule is what makes the editor on UPI / Bank / Crypto take effect.
  if (given.length) return given;
  // Untouched native rail keeps its own validated form.
  if (NATIVE_DESTINATION_RAILS.has(String(railId || '').toUpperCase())) return null;
  return DEFAULT_WITHDRAWAL_FIELDS;
};

// Open for payouts. `withdrawalEnabled` absent means the admin never touched
// the withdrawal switch, so fall back to the deposit one — the same rule the
// server uses (utils/paymentMethods railEnabled).
const railOpen = (cfg) => (cfg
  ? (cfg.withdrawalEnabled === undefined || cfg.withdrawalEnabled === null
    ? cfg.enabled !== false
    : cfg.withdrawalEnabled !== false)
  : true);

// Which currency a rail pays out in, from the admin's own list. Mirrors
// payoutCurrency() on the server: no list = the wallet currency, a list
// containing it = the wallet currency, otherwise the first one listed.
const payoutCurrency = (cfg, walletCcy) => {
  const list = Array.isArray(cfg?.supportedCurrencies)
    ? cfg.supportedCurrencies.map((c) => String(c || '').toUpperCase()).filter(Boolean)
    : [];
  const base = String(walletCcy || 'INR').toUpperCase();
  if (!list.length) return base;
  return list.includes(base) ? base : list[0];
};

// The admin's payout limits + fee for a rail, in INR — the same fields
// assertWithinLimits('withdrawal') and computeWithdrawalFee read.
const railRules = (cfg) => ({
  min: Number(cfg?.minWithdrawal) > 0 ? Number(cfg.minWithdrawal) : 0,
  max: Number(cfg?.maxWithdrawal) > 0 ? Number(cfg.maxWithdrawal) : 0,
  feePercent: Number(cfg?.withdrawalFeePercent) || 0,
  feeFixed: Number(cfg?.withdrawalFeeFixed) || 0,
});

export default function WithdrawModal({ endpoint, title = 'Withdraw', currency = 'INR', balance = 0, onClose, onSuccess }) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState(null);      // the rail: UPI | BANK | CRYPTO
  const [selectedId, setSelectedId] = useState(''); // the saved destination
  const [submitting, setSubmitting] = useState(false);

  // Two things decide what can be picked: the admin's rail settings, and the
  // user's own verified destinations. Until BOTH land we show neither — a
  // half-loaded picker invites choosing something that will be refused.
  const [payDetails, setPayDetails] = useState(null);
  const [saved, setSaved] = useState([]);
  const [state, setState] = useState('loading'); // 'loading' | 'ready' | 'error'

  useEffect(() => {
    let dead = false;
    Promise.all([
      api.get('/wallet/deposit-details').then((r) => r.data?.data || {}),
      api.get('/withdrawal-methods').then((r) => r.data?.data || []),
    ])
      .then(([details, list]) => {
        if (dead) return;
        setPayDetails(details);
        // Only a VERIFIED, unarchived destination can receive money.
        setSaved(list.filter((m) => m.isVerified && !m.archived));
        setState('ready');
      })
      .catch(() => { if (!dead) setState('error'); });
    return () => { dead = true; };
  }, []);

  // ── 1. the rails the admin has open ──
  const rails = useMemo(() => {
    if (state !== 'ready') return [];
    // Every fixed rail the admin has open for payouts — not just the three
    // with their own forms. Skrill and Neteller used to be switchable in
    // admin and invisible here.
    const fixed = FIXED_RAIL_IDS
      .filter((id) => railOpen(payDetails?.[id]))
      .map((id) => ({
        id,
        ...RAIL_META[id],
        // A rail without its own columns saves its destination generically,
        // so its saved methods are found by methodKey rather than by type.
        methodKey: NATIVE_DESTINATION_RAILS.has(id) ? null : id,
        ...railRules(payDetails?.[id]),
        payCcy: payoutCurrency(payDetails?.[id], currency),
      }));
    // Admin-defined rails, same gate and same rules. No schema requirement:
    // withdrawalSchema supplies a default, so Shown always means shown.
    const custom = (payDetails?.custom || [])
      .filter((c) => c && c.label && railOpen(c))
      .map((c) => ({
        id: String(c.id),
        label: c.label,
        blurb: 'Manual',
        emoji: c.emoji || '💳',
        methodKey: String(c.id),
        ...railRules(c),
        payCcy: payoutCurrency(c, currency),
      }));
    return [...fixed, ...custom];
  }, [payDetails, state, currency]);

  const railIds = rails.map((r) => r.id).join(',');
  useEffect(() => {
    if (!rails.length) { setMethod(null); return; }
    if (!rails.some((r) => r.id === method)) setMethod(rails[0].id);
  }, [railIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 2. the verified destinations on the chosen rail ──
  // A built-in rail matches saved methods by `type`; a custom one by the
  // `methodKey` the destination was saved against — otherwise every custom
  // rail would show every other custom rail's addresses, since they all
  // share the type 'CUSTOM'.
  const destinations = useMemo(() => {
    const rail = rails.find((r) => r.id === method);
    if (rail && rail.methodKey) return saved.filter((sm) => sm.methodKey === rail.methodKey);
    return saved.filter((sm) => sm.type === method);
  }, [saved, method, rails]);
  const destIds = destinations.map((d) => d.id).join(',');
  useEffect(() => {
    if (!destinations.length) { setSelectedId(''); return; }
    if (!destinations.some((d) => d.id === selectedId)) setSelectedId(destinations[0].id);
  }, [destIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const sym = currency === 'INR' ? '₹' : currency === 'INR' ? '₹' : `${currency} `;
  const bal = Number(balance || 0);
  const n = Number(amount);
  const active = rails.find((r) => r.id === method)
    || { min: 0, max: 0, feePercent: 0, feeFixed: 0, payCcy: currency };
  const hasAmount = Number.isFinite(n) && n > 0;
  const belowMin = hasAmount && active.min > 0 && n < active.min;
  const aboveMax = hasAmount && active.max > 0 && n > active.max;
  const overBalance = hasAmount && n > bal;
  const amountValid = hasAmount && !belowMin && !aboveMax && !overBalance;

  // Mirrors computeWithdrawalFee: percentage of the amount plus a fixed part.
  const fee = hasAmount ? Math.round((n * (active.feePercent / 100) + active.feeFixed) * 100) / 100 : 0;
  const net = Math.max(0, Math.round((n - fee) * 100) / 100);
  const paysOther = active.payCcy && active.payCcy !== currency;

  const fmt = (v) => Number(v || 0).toFixed(2);

  const submit = async () => {
    if (!method) { toast.error('Choose a withdrawal method'); return; }
    if (!selectedId) { toast.error('Choose a verified destination'); return; }
    if (!hasAmount) { toast.error('Enter a valid amount'); return; }
    if (overBalance) { toast.error('Amount exceeds your balance'); return; }
    if (belowMin) { toast.error(`Minimum for this method is ${sym}${fmt(active.min)}`); return; }
    if (aboveMax) { toast.error(`Maximum for this method is ${sym}${fmt(active.max)}`); return; }
    setSubmitting(true);
    try {
      // The destination id only — the server resolves the real account from
      // the verified record. Nothing about where the money goes is sent here.
      await api.post(endpoint, { amount: n, withdrawalMethodId: selectedId });
      toast.success('Withdrawal requested — pending admin approval');
      onSuccess && onSuccess();
    } catch (e) {
      const code = e.response?.data?.error?.code;
      if (code === 'KYC_REQUIRED') toast.error('Complete KYC verification first (Profile → KYC).');
      else if (code === 'WITHDRAWAL_BLOCKED_MONTHLY_PNL') toast.error(e.response?.data?.error?.message || 'Withdrawal blocked: your net trading P&L for this month must be positive to withdraw.');
      else toast.error(errorMessage(e));
    } finally { setSubmitting(false); }
  };

  const fld = 'w-full px-3 py-2 rounded-xl border border-border-dark bg-white text-sm text-text-primary placeholder:text-text-muted focus:border-primary-500 focus:outline-none';
  const notice = 'text-[11px] leading-snug rounded-lg border border-amber-300/60 bg-amber-50 text-amber-800 p-2.5';
  const card = (on) => `w-full flex items-center gap-3 px-3.5 py-3 rounded-xl border-2 transition-all text-left ${
    on ? 'border-primary-500 bg-primary-500/5' : 'border-border-dark hover:border-primary-500/40'
  }`;
  const tick = (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-primary-500 shrink-0">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
  const skeleton = (rows) => (
    <div className="mt-1 space-y-2" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3.5 py-3 rounded-xl border-2 border-border-dark animate-pulse">
          <span className="w-6 h-6 rounded bg-bg-hover shrink-0" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-24 rounded bg-bg-hover" />
            <div className="h-2.5 w-36 rounded bg-bg-hover" />
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl border border-border-dark shadow-2xl max-h-[92vh] flex flex-col">
        <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between shrink-0">
          <h3 className="text-base font-bold text-text-primary">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="p-1.5 -mr-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {/* Amount */}
          <div>
            <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Amount ({currency})</label>
            <div className="relative mt-1">
              <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className={`${fld} font-mono pr-14`} />
              <button type="button" onClick={() => setAmount(String(bal))} className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-bold text-primary-600 hover:text-primary-700">MAX</button>
            </div>
            <div className="mt-1 text-[11px] text-text-muted">
              Available: <span className="font-semibold text-text-secondary">{sym}{fmt(bal)}</span>
              {(active.min > 0 || active.max > 0) && (
                <span className="ml-2">
                  {active.min > 0 && <>Min · {sym}{fmt(active.min)}</>}
                  {active.min > 0 && active.max > 0 && <> · </>}
                  {active.max > 0 && <>Max · {sym}{fmt(active.max)}</>}
                </span>
              )}
            </div>
            {belowMin && <div className="mt-1 text-[11px] text-bear">Minimum for this method is {sym}{fmt(active.min)}</div>}
            {aboveMax && <div className="mt-1 text-[11px] text-bear">Maximum for this method is {sym}{fmt(active.max)}</div>}
            {overBalance && <div className="mt-1 text-[11px] text-bear">Amount exceeds your balance</div>}
          </div>

          {/* 1. Method — the admin's rails */}
          <div>
            <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Method</label>
            {state === 'loading' && skeleton(3)}
            {state === 'error' && (
              <div className={`mt-1 ${notice}`}>
                Couldn&apos;t load the available withdrawal methods. Check your connection and reopen this window before requesting a payout.
              </div>
            )}
            {state === 'ready' && !rails.length && (
              <div className={`mt-1 ${notice}`}>
                No withdrawal methods are available right now. Please contact support.
              </div>
            )}
            {!!rails.length && (
              <div className="mt-1 space-y-2">
                {rails.map((r) => {
                  const on = method === r.id;
                  const bits = [];
                  if (r.min > 0) bits.push(`Min · ${sym}${fmt(r.min)}`);
                  if (r.max > 0) bits.push(`Max · ${sym}${fmt(r.max)}`);
                  if (r.feePercent > 0 || r.feeFixed > 0) {
                    const f = [];
                    if (r.feePercent > 0) f.push(`${r.feePercent}%`);
                    if (r.feeFixed > 0) f.push(`${sym}${fmt(r.feeFixed)}`);
                    bits.push(`Fee ${f.join(' + ')}`);
                  } else {
                    bits.push('No fee');
                  }
                  if (r.payCcy && r.payCcy !== currency) bits.push(`Pays out in ${r.payCcy}`);
                  // How many verified destinations the user has here, so an
                  // empty rail is obvious before it is chosen.
                  const count = saved.filter((sm) => sm.type === r.id).length;
                  return (
                    <button key={r.id} type="button" onClick={() => setMethod(r.id)} className={card(on)}>
                      <span className="text-xl shrink-0">{r.emoji}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-text-primary">{r.label}</div>
                        <div className="text-[11px] text-text-muted">{r.blurb}</div>
                        <div className="text-[11px] text-text-secondary mt-0.5">{bits.join('  ·  ')}</div>
                      </div>
                      {count === 0 && (
                        <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-warn/15 text-warn shrink-0">Setup</span>
                      )}
                      {on && tick}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 2. Destination — verified accounts on the chosen rail */}
          {!!rails.length && (
            <div>
              <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Withdraw to</label>
              {!destinations.length ? (
                <div className={`mt-1 ${notice}`}>
                  <div className="font-semibold">No verified {active.label || 'account'} yet</div>
                  <div className="mt-1">
                    Payouts can only go to a destination you&apos;ve saved and we&apos;ve verified.
                  </div>
                  <Link
                    to="/wallet?view=withdrawal-methods"
                    onClick={onClose}
                    className="inline-block mt-2 font-bold underline hover:no-underline"
                  >
                    Add a {active.label || 'withdrawal'} method →
                  </Link>
                </div>
              ) : (
                <div className="mt-1 space-y-2">
                  {destinations.map((d) => {
                    const on = selectedId === d.id;
                    return (
                      <button key={d.id} type="button" onClick={() => setSelectedId(d.id)} className={card(on)}>
                        <span className="text-xl shrink-0">{active.emoji}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-bold text-text-primary truncate">{d.label}</div>
                          <div className="text-[11px] text-text-muted font-mono truncate">{d.maskedDestination}</div>
                        </div>
                        <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-bull/15 text-bull shrink-0">Verified</span>
                        {on && tick}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* The admin's withdrawal fee, shown BEFORE committing — it comes off
              the payout, so the net figure belongs here, not in a surprise. */}
          {hasAmount && fee > 0 && (
            <div className="rounded-lg border border-border-subtle bg-bg-hover/50 p-2.5 space-y-1 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="text-text-muted">Withdrawal fee</span>
                <span className="font-mono font-semibold text-text-secondary">−{sym}{fmt(fee)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-text-muted">You receive</span>
                <span className="font-mono font-bold text-text-primary">{sym}{fmt(net)}</span>
              </div>
              {paysOther && (
                <div className="text-text-muted pt-0.5">
                  Paid out in {active.payCcy} at the current rate — the exact figure is
                  stamped on your request.
                </div>
              )}
            </div>
          )}

          <div className="text-[11px] text-text-muted leading-snug rounded-lg bg-bg-hover/50 border border-border-subtle p-2.5">
            Withdrawals are reviewed by our team. The amount is held immediately, paid out on approval, and automatically refunded if rejected.
          </div>
        </div>

        <div className="p-4 border-t border-border-subtle flex items-center gap-2 shrink-0">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-border-dark text-sm font-semibold text-text-primary hover:bg-bg-hover transition-colors">Cancel</button>
          <button onClick={submit} disabled={submitting || !amountValid || !selectedId} className="flex-1 py-2.5 rounded-xl bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white text-sm font-bold transition-colors">
            {submitting ? 'Submitting…' : 'Request Withdrawal'}
          </button>
        </div>
      </div>
    </div>
  );
}
