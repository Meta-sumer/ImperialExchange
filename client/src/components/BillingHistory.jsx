import { useEffect, useMemo, useState } from 'react';

/**
 * BillingHistory — subscription-lifecycle timeline for the Plans & Pricing page.
 *
 * The backend keeps ONE current subscription document per user (no history
 * collection), so the timeline of past plans is RECONSTRUCTED from REAL data:
 * the subscription-wallet charges the parent already loads (SUBSCRIPTION_CHARGE /
 * RENEWAL) become plan periods, joined with the live plan catalogue for names +
 * the current subscription for the active period. No dummy rows.
 *
 * Each row = a plan period: Start · End · Plan Type · Plan/Description · Billing
 * Period (+ days) · Amount · Status (Active / Cancelled / Ended) · Actions.
 * Postpaid rows expand → itemized usage + a deposit summary (collected / used /
 * remaining). Filters are staged (Apply Filters) with pagination.
 */

/* ── helpers ─────────────────────────────────────────────────────────── */
const fmt = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const symOf = (ccy) => (ccy === 'INR' ? '₹' : ccy === 'USD' ? '$' : `${ccy || 'USD'} `);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');
const isPostpaidTxn = (t) => /postpaid/i.test(t.note || '') || String(t.planCode || '').toUpperCase().includes('POST');

// Lifecycle status → pill styling.
const STATUS_CLS = {
  ACTIVE:    'bg-bull/15 text-bull',
  CANCELLED: 'bg-warn/15 text-warn',
  ENDED:     'bg-bg-hover text-text-secondary',
};

// Standard postpaid rates (per the plan) — used only to itemize the expand row.
const POSTPAID = { device: 2, account: 4 };
const postpaidLines = (t) => {
  const note = t.note || '';
  const dev = Number((note.match(/(\d+)\s*device/i) || [])[1] || 0);
  const acc = Number((note.match(/(\d+)\s*account/i) || [])[1] || 0);
  const lines = [];
  if (dev) lines.push({ desc: 'Device logins', qty: dev, unit: POSTPAID.device, tax: 0 });
  if (acc) lines.push({ desc: 'Trading accounts', qty: acc, unit: POSTPAID.account, tax: 0 });
  if (!lines.length) lines.push({ desc: note || 'Postpaid charge', qty: 1, unit: Math.abs(Number(t.amount) || 0), tax: 0 });
  const min = Number((note.match(/min\s*\$?([\d.]+)/i) || [])[1] || 0);
  return { lines, min };
};

/**
 * Reconstruct the plan-period timeline from real charges + the current sub.
 * Returns rows newest-first: { id, start, end, days, code, planName, cycle,
 * badges[], description, subtitle, amount, currency, status, isPostpaid,
 * isCurrent, t }.
 */
function buildPeriods(txns, currentSub, plans) {
  const planByCode = new Map((plans || []).map((p) => [String(p.code).toUpperCase(), p]));
  const nameOf = (code) => planByCode.get(String(code || '').toUpperCase())?.name || String(code || 'Plan').replace(/_/g, ' ');

  const charges = (txns || [])
    .filter((t) => t.transactionType === 'DEBIT' && (t.reason === 'SUBSCRIPTION_CHARGE' || t.reason === 'RENEWAL'))
    .slice()
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); // ascending to chain periods

  const curCode = currentSub ? String(currentSub.planCode || '').toUpperCase() : '';
  const curActive = currentSub && String(currentSub.status || '').toUpperCase() === 'ACTIVE';
  // Postpaid plans never set expiresAt on purpose — they are billed each
  // cycle instead of expiring, because their $0 monthlyPrice would
  // otherwise read as lapsed and downgrade the user. Their period ends at
  // the next billing anchor, which subscribe() seeds one cycle out and the
  // worker advances on every charge.
  const curCycleEnd = currentSub ? (currentSub.nextBillingAt || currentSub.expiresAt || null) : null;

  const rows = charges.map((t, i) => {
    const start = new Date(t.createdAt);
    const next = charges[i + 1] ? new Date(charges[i + 1].createdAt) : null;
    const isLast = i === charges.length - 1;
    // Every charge written before chargePlan recorded a planCode has none.
    // The newest charge is the one that paid for the plan running now, so
    // adopt the current code instead of leaving it blank — a blank never
    // matches curCode, which made this row read as CANCELLED and caused a
    // duplicate synthetic "current plan" row to be appended next to it.
    const code = String(t.planCode || '').toUpperCase() || (isLast && curActive ? curCode : '');
    const plan = planByCode.get(code);
    const pp = isPostpaidTxn(t) || !!plan?.features?.postPaid;
    const cycle = pp ? 'MONTHLY' : String(t.billingCycle || 'MONTHLY').toUpperCase();
    let end = next;
    if (!end && isLast && curActive && code === curCode && curCycleEnd) end = new Date(curCycleEnd);
    const prevCode = i > 0 ? String(charges[i - 1].planCode || '').toUpperCase() : null;
    return { t, start, end, code, plan, cycle, pp, prevCode, isLast, amount: Math.abs(Number(t.amount) || 0), currency: t.currency || 'USD', nameOf };
  });

  const mkRow = (r, isCurrent) => {
    const days = r.end ? Math.max(0, Math.round((r.end.getTime() - r.start.getTime()) / 86400000)) : null;
    const status = isCurrent ? 'ACTIVE' : r.code === 'FREE' ? 'ENDED' : 'CANCELLED';
    const subtitle = r.pp ? 'Postpaid Used'
      : r.code === 'FREE' ? 'Welcome Plan'
        : r.cycle === 'YEARLY' ? 'Yearly Subscription'
          : r.prevCode ? `Upgraded from ${r.nameOf(r.prevCode)}` : 'Monthly Subscription';
    const description = r.pp ? 'Postpaid Plan'
      : r.code === 'FREE' ? 'Free Plan'
        : `${r.nameOf(r.code)} ${cap(r.cycle)} Plan`;
    const badges = r.code === 'FREE' ? ['FREE'] : [r.code, r.cycle].filter(Boolean);
    return {
      id: r.t?._id || `${r.code}-${+r.start}`,
      start: r.start, end: r.end, days,
      code: r.code, planName: r.nameOf(r.code), cycle: r.cycle, badges,
      description, subtitle, amount: r.amount, currency: r.currency,
      status, isPostpaid: r.pp, isCurrent, t: r.t,
    };
  };

  const periods = rows.map((r) => mkRow(r, r.isLast && curActive && r.code === curCode));

  // Current plan has no matching charge (e.g. FREE, or a fresh activation)? Add it.
  if (curActive && !periods.some((p) => p.isCurrent)) {
    const plan = planByCode.get(curCode);
    const pp = !!plan?.features?.postPaid;
    periods.push(mkRow({
      t: null,
      start: currentSub.startedAt ? new Date(currentSub.startedAt) : new Date(),
      end: curCycleEnd ? new Date(curCycleEnd) : null,
      code: curCode, plan, cycle: pp ? 'MONTHLY' : String(currentSub.billingCycle || 'MONTHLY').toUpperCase(),
      pp, prevCode: null, amount: Number(currentSub.lastPayment?.amount || 0), currency: currentSub.lastPayment?.currency || 'USD', nameOf,
    }, true));
  }

  periods.sort((a, b) => b.start - a.start); // newest first
  return periods;
}

/* ── reusable bits ───────────────────────────────────────────────────── */
function Pill({ cls, children }) {
  return <span className={`inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${cls}`}>{children}</span>;
}

function Pagination({ page, totalPages, rows, onPage, onRows, from, to, count }) {
  const nums = useMemo(() => {
    const out = [];
    const add = (n) => out.push(n);
    if (totalPages <= 7) { for (let i = 1; i <= totalPages; i++) add(i); return out; }
    add(1);
    const lo = Math.max(2, page - 1); const hi = Math.min(totalPages - 1, page + 1);
    if (lo > 2) add('…');
    for (let i = lo; i <= hi; i++) add(i);
    if (hi < totalPages - 1) add('…');
    add(totalPages);
    return out;
  }, [page, totalPages]);

  const btn = 'min-w-[32px] h-8 px-2 rounded-lg text-[13px] font-semibold transition-colors';
  return (
    <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-t border-border-subtle flex-wrap">
      <div className="text-[12px] text-text-muted">
        {count === 0 ? 'Showing 0 records' : `Showing ${from} to ${to} of ${count} records`}
      </div>
      <div className="flex items-center gap-1 flex-wrap">
        <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1}
          className={`${btn} border border-border-dark text-text-secondary hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed`}>Prev</button>
        {nums.map((n, i) => n === '…'
          ? <span key={`e${i}`} className="px-1 text-text-muted">…</span>
          : <button key={n} type="button" onClick={() => onPage(n)}
              className={`${btn} ${n === page ? 'bg-primary-500 text-white' : 'border border-border-dark text-text-secondary hover:bg-bg-hover'}`}>{n}</button>)}
        <button type="button" onClick={() => onPage(page + 1)} disabled={page >= totalPages}
          className={`${btn} border border-border-dark text-text-secondary hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed`}>Next</button>
      </div>
      <label className="flex items-center gap-2 text-[12px] text-text-muted">
        Rows per page
        <select value={rows} onChange={(e) => onRows(Number(e.target.value))}
          className="border border-border-dark rounded-lg px-2 py-1 bg-bg-card text-text-primary outline-none focus:border-primary-500">
          {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
    </div>
  );
}

/* ── main ────────────────────────────────────────────────────────────── */
export default function BillingHistory({ txns = [], currentSub = null, plans = [], currentPlanCode = null }) {
  const BLANK = { from: '', to: '', type: 'all', status: 'all', billingType: 'all', onlyCurrent: false };
  const [draft, setDraft] = useState(BLANK);
  const [applied, setApplied] = useState(BLANK);
  const setD = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState(10);
  const [openId, setOpenId] = useState(null);
  const apply = () => { setApplied(draft); setPage(1); };
  const reset = () => { setDraft(BLANK); setApplied(BLANK); setPage(1); };
  const hasFilters = applied.from || applied.to || applied.type !== 'all' || applied.status !== 'all' || applied.billingType !== 'all' || applied.onlyCurrent;

  useEffect(() => { setPage(1); }, [applied, rows]);

  const periods = useMemo(() => buildPeriods(txns, currentSub, plans), [txns, currentSub, plans]);

  const filtered = useMemo(() => {
    const { from, to, type, status, billingType, onlyCurrent } = applied;
    const fromT = from ? new Date(`${from}T00:00:00`).getTime() : -Infinity;
    const toT = to ? new Date(`${to}T23:59:59`).getTime() : Infinity;
    const curCode = String(currentPlanCode || '').toUpperCase();
    return periods
      .filter((p) => { const ts = p.start.getTime(); return ts >= fromT && ts <= toT; })
      .filter((p) => type === 'all' || (type === 'postpaid' ? p.isPostpaid : !p.isPostpaid))
      .filter((p) => status === 'all' || p.status.toLowerCase() === status)
      .filter((p) => billingType === 'all' || (billingType === 'postpaid' ? p.isPostpaid : p.cycle.toUpperCase() === billingType.toUpperCase()))
      .filter((p) => !onlyCurrent || p.isCurrent || (curCode && p.code === curCode));
  }, [periods, applied, currentPlanCode]);

  // Total billing = sum of every charged amount across the (filtered) timeline.
  const total = useMemo(() => filtered.reduce((s, p) => s + (Number(p.amount) || 0), 0), [filtered]);
  const currency = filtered[0]?.currency || periods[0]?.currency || 'USD';
  const sym = symOf(currency);

  const totalPages = Math.max(1, Math.ceil(filtered.length / rows));
  const pageC = Math.min(page, totalPages);
  const startIdx = (pageC - 1) * rows;
  const pageRows = filtered.slice(startIdx, startIdx + rows);

  const selectCls = 'border border-border-dark rounded-lg px-2.5 py-1.5 bg-bg-card text-text-primary text-[13px] outline-none focus:border-primary-500';
  const dateCls = 'border border-border-dark rounded-lg px-2.5 py-1.5 bg-bg-card text-text-primary text-[13px] outline-none focus:border-primary-500';
  const th = 'text-left py-3 px-4 font-bold tracking-wide text-[11px] uppercase text-text-muted whitespace-nowrap';

  return (
    <div className="bg-bg-card border border-border-dark rounded-2xl overflow-hidden shadow-sm">
      {/* ── Header + total billing ── */}
      <div className="px-4 sm:px-5 py-4 border-b border-border-subtle flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-text-primary tracking-tight">Billing &amp; Subscription History</h2>
          <p className="text-[12px] text-text-muted mt-0.5">View your subscription timeline, charges, usage and invoices.</p>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">Total Billing</div>
          <div className="text-2xl font-bold text-bear tabular-nums leading-tight">−{sym}{fmt(total)}</div>
        </div>
      </div>

      {/* ── Filters (staged — apply on click) ── */}
      <div className="px-4 sm:px-5 py-3 border-b border-border-subtle flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-text-muted">From Date</span>
          <input type="date" value={draft.from} max={draft.to || undefined} onChange={(e) => setD('from', e.target.value)} className={dateCls} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-text-muted">To Date</span>
          <input type="date" value={draft.to} min={draft.from || undefined} onChange={(e) => setD('to', e.target.value)} className={dateCls} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-text-muted">Type</span>
          <select value={draft.type} onChange={(e) => setD('type', e.target.value)} className={selectCls}>
            <option value="all">All</option>
            <option value="subscription">Subscription</option>
            <option value="postpaid">Postpaid</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-text-muted">Status</span>
          <select value={draft.status} onChange={(e) => setD('status', e.target.value)} className={selectCls}>
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="cancelled">Cancelled</option>
            <option value="ended">Ended</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-text-muted">Billing Type</span>
          <select value={draft.billingType} onChange={(e) => setD('billingType', e.target.value)} className={selectCls}>
            <option value="all">All</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
            <option value="postpaid">Postpaid</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-[12px] text-text-secondary pb-2 cursor-pointer select-none">
          <input type="checkbox" checked={draft.onlyCurrent} onChange={(e) => setD('onlyCurrent', e.target.checked)} className="w-4 h-4 accent-primary-600" />
          Show only current plan
        </label>
        <div className="flex items-center gap-2 pb-0.5 ml-auto">
          <button type="button" onClick={reset} className="px-3.5 py-1.5 rounded-lg border border-border-dark text-text-secondary text-[13px] font-semibold hover:bg-bg-hover">Reset</button>
          <button type="button" onClick={apply} className="px-3.5 py-1.5 rounded-lg bg-primary-600 text-white text-[13px] font-semibold hover:bg-primary-500">Apply Filters</button>
        </div>
      </div>

      {/* ── Timeline table ── */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] border-collapse">
          <thead>
            <tr className="bg-bg-card border-b border-border-dark">
              <th className={th}>Start Date</th>
              <th className={th}>End Date</th>
              <th className={th}>Plan Type</th>
              <th className={th}>Plan / Description</th>
              <th className={th}>Billing Period</th>
              <th className={`${th} text-right`}>Amount</th>
              <th className={`${th} text-center`}>Status</th>
              <th className={`${th} text-center`}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && (
              <tr><td colSpan={8} className="py-12 text-center text-text-muted text-sm">No subscription history{hasFilters ? ' matches these filters' : ' yet'}.</td></tr>
            )}
            {pageRows.map((p) => (
              <PeriodRow key={p.id} p={p} sym={sym} open={openId === p.id} onToggle={() => setOpenId(openId === p.id ? null : p.id)} />
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ── */}
      <Pagination
        page={pageC}
        totalPages={totalPages}
        rows={rows}
        onPage={(n) => setPage(Math.min(Math.max(1, n), totalPages))}
        onRows={setRows}
        from={filtered.length ? startIdx + 1 : 0}
        to={Math.min(startIdx + rows, filtered.length)}
        count={filtered.length}
      />
    </div>
  );
}

/* One timeline row + (optional) its expandable detail. */
function PeriodRow({ p, sym, open, onToggle }) {
  const td = 'py-3 px-4 align-middle text-[13px]';
  const zero = Number(p.amount) === 0;
  return (
    <>
      <tr className="border-b border-border-subtle hover:bg-bg-hover/40 transition-colors align-top">
        <td className={`${td} whitespace-nowrap text-text-secondary`}>{fmtDate(p.start)}</td>
        <td className={`${td} whitespace-nowrap text-text-secondary`}>{p.end ? fmtDate(p.end) : '—'}</td>
        <td className={td}>
          <div className="flex flex-col gap-1 items-start">
            {p.badges.map((b, i) => (
              <Pill key={i} cls={p.isPostpaid ? 'bg-primary-500/15 text-primary-600' : 'bg-bg-hover text-text-secondary'}>{b}</Pill>
            ))}
          </div>
        </td>
        <td className={td}>
          <div className="font-semibold text-text-primary">{p.description}</div>
          <div className="text-[11px] text-text-muted mt-0.5">{p.subtitle}</div>
        </td>
        <td className={`${td} whitespace-nowrap text-text-secondary`}>
          <div>{fmtDate(p.start)} <span className="text-text-muted">→</span> {p.end ? fmtDate(p.end) : 'now'}</div>
          {p.days != null && <div className="text-[11px] text-text-muted">({p.days} days)</div>}
        </td>
        <td className={`${td} text-right whitespace-nowrap`}>
          <div className={`font-mono tabular-nums font-bold ${zero ? 'text-text-primary' : 'text-bear'}`}>
            {zero ? `${sym}${fmt(0)}` : `−${sym}${fmt(p.amount)}`}
          </div>
          {p.isPostpaid && <div className="text-[10px] text-text-muted">(Minimum Deposit)</div>}
        </td>
        <td className={`${td} text-center`}><Pill cls={STATUS_CLS[p.status] || STATUS_CLS.ENDED}>{cap(p.status)}</Pill></td>
        <td className={`${td} text-center`}>
          <div className="inline-flex items-center gap-1">
            <button type="button" onClick={onToggle}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-border-dark text-[12px] font-semibold text-text-secondary hover:bg-bg-hover transition-colors">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
              View
            </button>
            {p.isPostpaid && (
              <button type="button" onClick={onToggle} title={open ? 'Hide details' : 'Show details'}
                className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-text-muted hover:text-primary-600 hover:bg-bg-hover transition-colors">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? 'rotate-180' : ''}`}><path d="M6 9l6 6 6-6" /></svg>
              </button>
            )}
          </div>
        </td>
      </tr>
      {open && (p.isPostpaid ? <PostpaidDetail p={p} sym={sym} /> : <PlanDetailRow p={p} sym={sym} />)}
    </>
  );
}

/* Non-postpaid expand — a compact period summary. */
function PlanDetailRow({ p, sym }) {
  return (
    <tr className="bg-bg-hover/25">
      <td colSpan={8} className="px-4 sm:px-6 py-3">
        <div className="rounded-xl border border-border-subtle p-4 grid grid-cols-2 sm:grid-cols-4 gap-4 text-[12px]">
          <div><div className="text-text-muted">Plan</div><div className="font-semibold text-text-primary mt-0.5">{p.description}</div></div>
          <div><div className="text-text-muted">Billing period</div><div className="font-semibold text-text-primary mt-0.5">{fmtDate(p.start)} → {p.end ? fmtDate(p.end) : 'now'}{p.days != null ? ` (${p.days} days)` : ''}</div></div>
          <div><div className="text-text-muted">Amount charged</div><div className={`font-semibold mt-0.5 font-mono tabular-nums ${Number(p.amount) === 0 ? 'text-text-primary' : 'text-bear'}`}>{Number(p.amount) === 0 ? `${sym}${fmt(0)}` : `−${sym}${fmt(p.amount)}`}</div></div>
          <div><div className="text-text-muted">Status</div><div className="mt-0.5"><Pill cls={STATUS_CLS[p.status] || STATUS_CLS.ENDED}>{cap(p.status)}</Pill></div></div>
        </div>
      </td>
    </tr>
  );
}

/* Postpaid expand — itemized usage + deposit summary (collected / used / remaining). */
function PostpaidDetail({ p, sym }) {
  const t = p.t || { createdAt: p.start, note: '', amount: p.amount };
  const { lines, min } = postpaidLines(t);
  const usage = lines.reduce((s, l) => s + l.qty * l.unit + l.tax, 0);
  const minDep = min > 0 ? min : Number(p.amount) || 0;
  const remaining = Math.max(0, minDep - usage);
  const exhausted = remaining <= 0;
  const dTd = 'py-2 px-4 text-[12px] whitespace-nowrap';
  return (
    <tr className="bg-bg-hover/25">
      <td colSpan={8} className="px-4 sm:px-6 py-3">
        <div className="flex flex-col lg:flex-row gap-4">
          <div className="flex-1 min-w-0">
            <div className="text-[12px] font-bold text-text-primary mb-2">
              Postpaid Usage Details <span className="font-normal text-text-muted">({fmtDate(p.start)} – {p.end ? fmtDate(p.end) : 'now'})</span>
            </div>
            <div className="rounded-xl border border-border-subtle overflow-hidden overflow-x-auto">
              <table className="w-full min-w-[520px] border-collapse">
                <thead>
                  <tr className="bg-bg-card border-b border-border-subtle text-[10px] uppercase tracking-wider text-text-muted">
                    <th className="text-left py-2 px-4 font-bold">Charge Date</th>
                    <th className="text-left py-2 px-4 font-bold">Description</th>
                    <th className="text-center py-2 px-4 font-bold">Qty</th>
                    <th className="text-right py-2 px-4 font-bold">Unit Price</th>
                    <th className="text-right py-2 px-4 font-bold">Tax</th>
                    <th className="text-right py-2 px-4 font-bold">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i} className="border-b border-border-subtle/60 last:border-0">
                      <td className={`${dTd} text-text-secondary`}>{fmtDate(t.createdAt)}</td>
                      <td className={`${dTd} text-text-primary font-medium`}>{l.desc}</td>
                      <td className={`${dTd} text-center font-mono tabular-nums`}>{l.qty}</td>
                      <td className={`${dTd} text-right font-mono tabular-nums`}>{sym}{fmt(l.unit)}</td>
                      <td className={`${dTd} text-right font-mono tabular-nums`}>{sym}{fmt(l.tax)}</td>
                      <td className={`${dTd} text-right font-mono tabular-nums font-semibold`}>{sym}{fmt(l.qty * l.unit + l.tax)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="lg:w-72 shrink-0 space-y-2">
            <div className="rounded-xl border border-border-subtle p-3 space-y-2 text-[12px]">
              <div className="flex items-center justify-between gap-2">
                <span className="text-text-secondary">Minimum Deposit (Collected)</span>
                <span className="font-mono tabular-nums font-semibold text-text-primary">{sym}{fmt(minDep)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-text-secondary">Total Usage Charges</span>
                <span className="font-mono tabular-nums font-semibold text-text-primary">{sym}{fmt(usage)}</span>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-border-subtle pt-2">
                <span className="font-bold text-text-primary">Remaining Deposit</span>
                <span className="font-mono tabular-nums font-bold text-text-primary">{sym}{fmt(remaining)}</span>
              </div>
            </div>
            {exhausted && (
              <div className="rounded-xl border border-primary-500/20 bg-primary-500/5 p-3 text-[11px] text-text-secondary flex gap-2 leading-snug">
                <span className="text-primary-600 shrink-0">ⓘ</span>
                <span>Deposit is exhausted. Further charges are deducted from your Main Wallet.</span>
              </div>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}
