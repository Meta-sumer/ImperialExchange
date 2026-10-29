import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtDate } from '../utils/format';
import PageHero from '../components/PageHero';

/**
 * Credit Ledger — deposits and withdrawals processed "on credit".
 *
 * The wallet moved when the credit was granted; each row tracks what is still
 * owed in the real world (a DEPOSIT credit = the user owes us, a WITHDRAWAL
 * credit = we owe the user) until the admin records the payment(s). Backed by
 * /api/admin/credit (controllers/creditController.js).
 */

const OPEN = 'PENDING,PARTIALLY_SETTLED';
const STATUS_OPTS = [
  [OPEN, 'Open (pending + partial)'],
  ['PENDING', 'Pending'],
  ['PARTIALLY_SETTLED', 'Partially settled'],
  ['SETTLED', 'Settled'],
  ['CANCELLED', 'Cancelled'],
  ['', 'All'],
];
const SYMBOL = { USD: '$', INR: '₹', EUR: '€', GBP: '£' };
const money = (v, ccy = 'USD') =>
  `${SYMBOL[ccy] || `${ccy} `}${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const statusCls = (s) =>
  s === 'SETTLED' ? 'bg-green-900/30 text-green-400'
    : s === 'PARTIALLY_SETTLED' ? 'bg-blue-900/30 text-blue-300'
    : s === 'CANCELLED' ? 'bg-gray-700/40 text-gray-400'
    : 'bg-yellow-900/30 text-yellow-400';
const kindCls = (k) => (k === 'DEPOSIT' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300');
const isOpen = (s) => s === 'PENDING' || s === 'PARTIALLY_SETTLED';

export default function CreditLedger() {
  const [items, setItems] = useState([]);
  const [totals, setTotals] = useState(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState(OPEN);
  const [kind, setKind] = useState('');
  const [userPick, setUserPick] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [settling, setSettling] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  const limit = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/admin/credit', {
        params: {
          ...(status ? { status } : {}),
          ...(kind ? { kind } : {}),
          ...(userPick ? { userId: userPick._id } : {}),
          page, limit,
        },
      });
      setItems(data.data.items || []);
      setTotals(data.data.totals || null);
      setTotal(data.data.total || 0);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [status, kind, userPick, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [status, kind, userPick]);

  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-4 max-w-[1600px]">
      <PageHero
        eyebrow="Money"
        title="Credit Ledger"
        subtitle="Deposits and withdrawals processed on credit — the wallet moved immediately; track what is still owed until it is settled."
      />

      {/* Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <SummaryCard label="Receivable outstanding" hint="Deposits on credit — users still owe" value={money(totals?.receivableOutstanding)} tone="text-yellow-300" />
        <SummaryCard label="Payable outstanding" hint="Withdrawals on credit — due to users" value={money(totals?.payableOutstanding)} tone="text-rose-300" />
        <SummaryCard label="Open transactions" hint="Pending or partially settled" value={String(totals?.pendingCount ?? 0)} tone="text-white" />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="text-xs px-3 py-1.5 rounded bg-bg-card text-gray-300 border border-border-dark focus:outline-none">
          {STATUS_OPTS.map(([v, l]) => <option key={v || 'all'} value={v}>{l}</option>)}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="text-xs px-3 py-1.5 rounded bg-bg-card text-gray-300 border border-border-dark focus:outline-none">
          <option value="">Deposits + withdrawals</option>
          <option value="DEPOSIT">Deposits on credit</option>
          <option value="WITHDRAWAL">Withdrawals on credit</option>
        </select>
        <UserSearch value={userPick} onPick={setUserPick} />
        <span className="flex-1" />
        <button onClick={load} className="text-xs px-3 py-1.5 rounded bg-bg-card text-gray-400 hover:bg-bg-hover">{loading ? 'Refreshing…' : 'Refresh'}</button>
        <button onClick={() => setCreating(true)} className="btn-primary text-xs px-3 py-1.5 rounded">+ New credit transaction</button>
      </div>

      {/* Table */}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase">
            <tr>
              <th className="text-left p-3">Date</th>
              <th className="text-left p-3">User</th>
              <th className="text-left p-3">Account</th>
              <th className="text-left p-3">Kind</th>
              <th className="text-right p-3">Amount</th>
              <th className="text-right p-3">Settled</th>
              <th className="text-right p-3">Outstanding</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Remarks</th>
              <th className="text-left p-3">By</th>
              <th className="text-right p-3">Action</th>
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <tr key={t._id} className="table-row align-top">
                <td className="p-3 text-xs text-gray-400 whitespace-nowrap">
                  {fmtDate(t.createdAt)}
                  {t.dueDate && <div className="text-[10px] text-gray-500">Due {new Date(t.dueDate).toLocaleDateString('en-IN')}</div>}
                </td>
                <td className="p-3 text-xs">
                  {t.user?.userUid
                    ? <span className="font-mono font-bold text-primary-500">{t.user.userUid}</span>
                    : <span className="font-mono text-gray-400">{String(t.userId).slice(-6)}</span>}
                  <div className="text-[10px] text-gray-500 truncate max-w-[180px]">{t.user?.name || t.user?.email || '—'}</div>
                </td>
                <td className="p-3 text-xs font-mono text-gray-300">
                  {t.account?.accountNumber || '—'}
                  {t.account?.accountType && <div className="text-[10px] text-gray-500 font-sans">{t.account.accountType}</div>}
                </td>
                <td className="p-3"><span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${kindCls(t.kind)}`}>{t.kind}</span></td>
                <td className="p-3 text-right font-mono text-white font-semibold">{money(t.amount, t.currency)}</td>
                <td className="p-3 text-right font-mono text-gray-300">{money(t.settledAmount, t.currency)}</td>
                <td className={`p-3 text-right font-mono font-semibold ${Number(t.outstanding) > 0 ? 'text-yellow-300' : 'text-gray-500'}`}>{money(t.outstanding, t.currency)}</td>
                <td className="p-3"><span className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ${statusCls(t.status)}`}>{t.status.replace('_', ' ')}</span></td>
                <td className="p-3 text-xs text-gray-300 max-w-[260px]">
                  <div className="truncate" title={t.remarks}>{t.remarks || '—'}</div>
                  {!!(t.settlements || []).length && (
                    <div className="mt-1 space-y-0.5">
                      {t.settlements.map((s) => (
                        <div key={s._id || s.at} className="text-[10px] text-gray-500">
                          {new Date(s.at).toLocaleDateString('en-IN')} · {money(s.amount, t.currency)}{s.remarks ? ` · ${s.remarks}` : ''}
                        </div>
                      ))}
                    </div>
                  )}
                  {t.status === 'CANCELLED' && t.cancelRemarks && <div className="text-[10px] text-rose-300 mt-1">Cancelled: {t.cancelRemarks}</div>}
                </td>
                <td className="p-3 text-xs text-gray-500 truncate max-w-[140px]">{t.creator?.name || '—'}</td>
                <td className="p-3 text-right whitespace-nowrap">
                  {isOpen(t.status) && (
                    <>
                      <button onClick={() => setSettling(t)} className="btn-secondary text-xs mr-1">Settle</button>
                      {t.status === 'PENDING' && Number(t.settledAmount) === 0 && (
                        <button onClick={() => setCancelling(t)} className="text-xs text-bear hover:underline">Cancel</button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && <div className="text-center text-gray-500 py-6 text-sm">{loading ? 'Loading…' : 'No credit transactions match the filter'}</div>}
        {pages > 1 && (
          <div className="flex items-center justify-end gap-2 p-3 text-xs text-gray-400 border-t border-border-dark">
            <span>Page {page} of {pages} · {total} rows</span>
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-2 py-1 rounded bg-bg-card hover:bg-bg-hover disabled:opacity-40">Prev</button>
            <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className="px-2 py-1 rounded bg-bg-card hover:bg-bg-hover disabled:opacity-40">Next</button>
          </div>
        )}
      </div>

      {creating && <NewCreditModal onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />}
      {settling && <SettleModal tx={settling} onClose={() => setSettling(null)} onDone={() => { setSettling(null); load(); }} />}
      {cancelling && <CancelModal tx={cancelling} onClose={() => setCancelling(null)} onDone={() => { setCancelling(null); load(); }} />}
    </div>
  );
}

function SummaryCard({ label, hint, value, tone }) {
  return (
    <div className="card p-4">
      <div className="text-[11px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`text-2xl font-bold font-mono mt-1 ${tone}`}>{value}</div>
      <div className="text-[11px] text-gray-500 mt-0.5">{hint}</div>
    </div>
  );
}

/** Inline user picker — searches /admin/users as you type. */
function UserSearch({ value, onPick, placeholder = 'Filter by user (name / email / UID)' }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (!q.trim()) { setResults([]); return undefined; }
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const { data } = await api.get('/admin/users', { params: { search: q.trim(), role: 'USER', limit: 10 } });
        setResults(data.data.users || []);
        setOpen(true);
      } catch (e) { toast.error(errorMessage(e)); }
    }, 300);
    return () => clearTimeout(timer.current);
  }, [q]);

  if (value) {
    return (
      <span className="inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded bg-bg-card border border-border-dark text-gray-200">
        <span className="font-mono text-primary-500 font-bold">{value.userUid || String(value._id).slice(-6)}</span>
        <span className="text-gray-400">{[value.firstName, value.lastName].filter(Boolean).join(' ') || value.email}</span>
        <button onClick={() => { onPick(null); setQ(''); }} className="text-gray-500 hover:text-white" title="Clear">✕</button>
      </span>
    );
  }
  return (
    <div className="relative">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        className="text-xs px-3 py-1.5 rounded bg-bg-card text-gray-300 border border-border-dark focus:outline-none w-72"
      />
      {open && results.length > 0 && (
        <div className="absolute z-20 mt-1 w-full bg-bg-card border border-border-dark rounded shadow-xl max-h-64 overflow-y-auto">
          {results.map((u) => (
            <button
              key={u._id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onPick(u); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-xs hover:bg-bg-hover"
            >
              <span className="font-mono text-primary-500 font-bold">{u.userUid || String(u._id).slice(-6)}</span>
              <span className="ml-2 text-gray-200">{[u.firstName, u.lastName].filter(Boolean).join(' ')}</span>
              <span className="ml-2 text-gray-500">{u.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ModalShell({ title, onClose, children, footer, wide }) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className={`bg-bg-card border border-border-dark rounded-xl w-full ${wide ? 'max-w-2xl' : 'max-w-lg'}`} onClick={(e) => e.stopPropagation()}>
        <div className="p-5 border-b border-border-dark flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">✕</button>
        </div>
        <div className="p-5 space-y-4">{children}</div>
        {footer && <div className="p-5 border-t border-border-dark flex gap-3 justify-end">{footer}</div>}
      </div>
    </div>
  );
}

const Field = ({ label, children }) => (
  <label className="block">
    <div className="text-xs text-gray-500 uppercase mb-1">{label}</div>
    {children}
  </label>
);
const inputCls = 'w-full text-sm px-3 py-2 rounded bg-bg-dark text-white border border-border-dark focus:outline-none focus:border-primary-500';

function NewCreditModal({ onClose, onCreated }) {
  const [user, setUser] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [kind, setKind] = useState('DEPOSIT');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) { setAccounts([]); setAccountId(''); return; }
    (async () => {
      try {
        const { data } = await api.get(`/admin/accounts/users/${user._id}/accounts`);
        const list = data.data || [];
        setAccounts(list);
        setAccountId(list[0]?._id || '');
      } catch (e) { toast.error(errorMessage(e)); }
    })();
  }, [user]);

  const submit = async () => {
    if (!user || !accountId) return toast.error('Pick a user and a trading account');
    if (!(Number(amount) > 0)) return toast.error('Enter a positive amount');
    if (!remarks.trim()) return toast.error('Remarks are required');
    setBusy(true);
    try {
      await api.post('/admin/credit', { userId: user._id, accountId, kind, amount, remarks: remarks.trim(), ...(dueDate ? { dueDate } : {}) });
      toast.success(kind === 'DEPOSIT' ? 'Deposit on credit recorded — wallet credited' : 'Withdrawal on credit recorded — wallet debited');
      onCreated();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title="New credit transaction"
      onClose={onClose}
      wide
      footer={<>
        <button onClick={onClose} className="btn-secondary">Close</button>
        <button onClick={submit} disabled={busy} className="btn-primary">{busy ? 'Saving…' : (kind === 'DEPOSIT' ? 'Credit wallet on credit' : 'Debit wallet on credit')}</button>
      </>}
    >
      <Field label="User"><UserSearch value={user} onPick={setUser} placeholder="Search user by name / email / UID" /></Field>
      <div className="grid md:grid-cols-2 gap-4">
        <Field label="Trading account">
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputCls} disabled={!accounts.length}>
            {!accounts.length && <option value="">{user ? 'No accounts' : 'Pick a user first'}</option>}
            {accounts.map((a) => <option key={a._id} value={a._id}>{a.accountNumber} · {a.accountType}{a.status && a.status !== 'ACTIVE' ? ` · ${a.status}` : ''}</option>)}
          </select>
        </Field>
        <Field label="Kind">
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputCls}>
            <option value="DEPOSIT">Deposit on credit — credit wallet now, user pays later</option>
            <option value="WITHDRAWAL">Withdrawal on credit — debit wallet now, pay user later</option>
          </select>
        </Field>
        <Field label="Amount (USD)"><input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} placeholder="0.00" /></Field>
        <Field label="Due date (optional)"><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputCls} /></Field>
      </div>
      <Field label="Remarks (required — shown to the user)">
        <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={3} className={inputCls} placeholder="e.g. Cheque promised by Friday / UPI pending from client" />
      </Field>
      <p className="text-[11px] text-gray-500">
        The wallet moves immediately. Settling later only records the real-world payment; it never moves the wallet again.
      </p>
    </ModalShell>
  );
}

function SettleModal({ tx, onClose, onDone }) {
  const [amount, setAmount] = useState(String(tx.outstanding || ''));
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!(Number(amount) > 0)) return toast.error('Enter a positive amount');
    if (Number(amount) > Number(tx.outstanding)) return toast.error(`Amount exceeds the outstanding ${money(tx.outstanding, tx.currency)}`);
    setBusy(true);
    try {
      const { data } = await api.post(`/admin/credit/${tx._id}/settle`, { amount, remarks: remarks.trim() });
      toast.success(data.data.status === 'SETTLED' ? 'Credit fully settled' : `Partial settlement recorded — ${money(data.data.outstanding, tx.currency)} outstanding`);
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalShell
      title={`Settle ${tx.kind === 'DEPOSIT' ? 'deposit' : 'withdrawal'} on credit`}
      onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-secondary">Close</button>
        <button onClick={submit} disabled={busy} className="btn-bull">{busy ? 'Saving…' : 'Record payment'}</button>
      </>}
    >
      <div className="text-sm text-gray-300">
        {tx.user?.name || tx.user?.email} · {money(tx.amount, tx.currency)} total · {money(tx.settledAmount, tx.currency)} settled ·{' '}
        <span className="text-yellow-300 font-semibold">{money(tx.outstanding, tx.currency)} outstanding</span>
      </div>
      <Field label="Amount received / paid"><input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} /></Field>
      <Field label="Payment remarks"><input value={remarks} onChange={(e) => setRemarks(e.target.value)} className={inputCls} placeholder="e.g. UPI ref 4512…, cash received" /></Field>
    </ModalShell>
  );
}

function CancelModal({ tx, onClose, onDone }) {
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/credit/${tx._id}/cancel`, { remarks: remarks.trim() });
      toast.success('Credit cancelled — wallet movement reversed');
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalShell
      title="Cancel credit transaction"
      onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-secondary">Keep</button>
        <button onClick={submit} disabled={busy} className="btn-bear">{busy ? 'Cancelling…' : 'Cancel & reverse wallet'}</button>
      </>}
    >
      <p className="text-sm text-gray-300">
        This reverses the {tx.kind === 'DEPOSIT' ? 'credit' : 'debit'} of {money(tx.amount, tx.currency)} on the user's wallet with an adjustment entry.
        {tx.kind === 'DEPOSIT' && ' It fails if the user has already used the funds.'}
      </p>
      <Field label="Reason"><input value={remarks} onChange={(e) => setRemarks(e.target.value)} className={inputCls} placeholder="Why this credit is being cancelled" /></Field>
    </ModalShell>
  );
}
