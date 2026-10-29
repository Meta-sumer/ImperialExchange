import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';
import { useConfirm } from '../components/ConfirmProvider';

/**
 * Bank Accounts — the pool of company deposit accounts.
 *
 * Every customer is assigned ONE account (User.depositBankAccountId) and sees
 * only that account on the deposit page, so incoming transfers are spread
 * across the pool instead of piling onto a single account. This page manages
 * the pool (add / edit / activate / deactivate), shows how many users sit on
 * each account, lets the Super Admin re-balance ("Auto-distribute") and
 * reassign individual users.
 *
 * Super Admin only — the route, the sidebar entry and the API all enforce it.
 */

const EMPTY = { label: '', bankName: '', accountName: '', accountNumber: '', ifsc: '', branch: '', upiId: '', note: '', qr: '' };
const QR_MAX_BYTES = 300 * 1024;

const mask = (n) => {
  const s = String(n || '');
  if (!s) return '—';
  return s.length > 4 ? `•••• ${s.slice(-4)}` : s;
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

export default function BankAccounts() {
  const confirm = useConfirm();
  const [rows, setRows] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);       // null | { row?: account }
  const [usersFor, setUsersFor] = useState(null); // account whose users are open
  const [revealed, setRevealed] = useState(() => new Set());
  const [busy, setBusy] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [a, s] = await Promise.all([api.get('/admin/bank-accounts'), api.get('/admin/bank-accounts/stats')]);
      setRows(a.data?.data || []);
      setStats(s.data?.data || null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const active = useMemo(() => rows.filter((r) => r.isActive), [rows]);

  const toggleReveal = (id) => setRevealed((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const setActive = async (row, flag) => {
    const ok = await confirm({
      title: flag ? 'Activate account' : 'Deactivate account',
      message: flag
        ? `Make "${row.label}" available for assignment again?`
        : `"${row.label}" stops receiving new assignments. Its ${row.assignedUsers} assigned user(s) move to the least-loaded active account the next time they open the deposit page — or right away with Auto-distribute.`,
      confirmText: flag ? 'Activate' : 'Deactivate',
      danger: !flag,
    });
    if (!ok) return;
    setBusy(row._id);
    try {
      await api.post(`/admin/bank-accounts/${row._id}/${flag ? 'activate' : 'deactivate'}`);
      toast.success(flag ? 'Account activated' : 'Account deactivated');
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy('');
    }
  };

  const distribute = async () => {
    const n = stats?.unassignedUsers ?? 0;
    const ok = await confirm({
      title: 'Auto-distribute users',
      message: n
        ? `Assign ${n} unassigned customer(s) across the ${active.length} active bank account(s), least-loaded first?`
        : 'Every customer already has an active bank account. Run anyway?',
      confirmText: 'Distribute',
    });
    if (!ok) return;
    setBusy('distribute');
    try {
      const { data } = await api.post('/admin/bank-accounts/distribute');
      toast.success(`${data.data?.assigned || 0} customer(s) assigned`);
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="space-y-6">
      <PageHero
        eyebrow="Money"
        title="Bank Accounts"
        subtitle="Company accounts that receive deposits. Each customer is assigned one, so transfers are spread across the pool instead of hitting a single account."
        actions={(
          <>
            <button
              type="button"
              onClick={distribute}
              disabled={busy === 'distribute' || !active.length}
              className="btn-secondary text-sm disabled:opacity-50"
              title={active.length ? 'Assign every unassigned customer, least-loaded first' : 'Add an active account first'}
            >
              {busy === 'distribute' ? 'Distributing…' : 'Auto-distribute unassigned'}
            </button>
            <button type="button" onClick={() => setModal({})} className="btn-primary text-sm">+ Add bank account</button>
          </>
        )}
      />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Bank accounts" value={stats ? `${stats.activeAccounts} / ${stats.accounts}` : '—'} hint="active / total" />
        <Stat label="Customers" value={stats ? stats.customers : '—'} hint="active customer accounts" />
        <Stat label="Assigned" value={stats ? stats.assignedUsers : '—'} hint="on an active bank account" />
        <Stat
          label="Unassigned"
          value={stats ? stats.unassignedUsers : '—'}
          hint={stats?.unassignedUsers ? 'auto-assigned on next deposit, or distribute now' : 'everyone is covered'}
          tone={stats?.unassignedUsers ? 'warn' : 'ok'}
        />
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-text-muted border-b border-border-dark">
                <th className="px-4 py-3">Label</th>
                <th className="px-4 py-3">Bank</th>
                <th className="px-4 py-3">Beneficiary</th>
                <th className="px-4 py-3">Account no.</th>
                <th className="px-4 py-3">IFSC</th>
                <th className="px-4 py-3">UPI</th>
                <th className="px-4 py-3 text-right">Users</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-10 text-center text-text-muted">Loading…</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-text-muted">
                    No bank accounts yet. Add the first one — until then customers see the global details from Payments.
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const shown = revealed.has(r._id);
                return (
                  <tr key={r._id} className={`border-b border-border-dark/60 ${r.isActive ? '' : 'opacity-60'}`}>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-text-primary">{r.label}</div>
                      <div className="text-[11px] text-text-muted">added {fmtDate(r.createdAt)}</div>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      <div>{r.bankName || '—'}</div>
                      {r.branch && <div className="text-[11px] text-text-muted">{r.branch}</div>}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{r.accountName || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-text-primary">{shown ? (r.accountNumber || '—') : mask(r.accountNumber)}</span>
                        {r.accountNumber && (
                          <button type="button" onClick={() => toggleReveal(r._id)} className="text-[11px] text-primary-500 hover:text-primary-400">
                            {shown ? 'hide' : 'show'}
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-text-secondary">{r.ifsc || '—'}</td>
                    <td className="px-4 py-3 font-mono text-text-secondary">{r.upiId || '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <button type="button" onClick={() => setUsersFor(r)} className="font-mono tabular-nums text-primary-500 hover:text-primary-400" title="View assigned users">
                        {r.assignedUsers}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-[11px] font-bold px-2 py-0.5 rounded ${r.isActive ? 'bg-emerald-500/20 text-emerald-400' : 'bg-bear/20 text-bear'}`}>
                        {r.isActive ? 'ACTIVE' : 'INACTIVE'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button type="button" onClick={() => setModal({ row: r })} className="btn-ghost text-xs">Edit</button>
                        <button type="button" onClick={() => setUsersFor(r)} className="btn-ghost text-xs">Users</button>
                        <button
                          type="button"
                          disabled={busy === r._id}
                          onClick={() => setActive(r, !r.isActive)}
                          className={`text-xs px-2 py-1 rounded disabled:opacity-50 ${r.isActive ? 'text-bear hover:bg-bear/10' : 'text-emerald-400 hover:bg-emerald-500/10'}`}
                        >
                          {r.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[12px] text-text-muted">
        How assignment works: a customer with no account is given the least-loaded active account the first time they open the
        deposit page. Deactivating an account moves its users the same way on their next visit; "Auto-distribute" does it for
        everyone at once. Reassign a single customer from <span className="text-text-secondary">Users → Edit user</span> or from the
        users list of an account.
      </p>

      {modal && (
        <AccountModal
          row={modal.row || null}
          onClose={() => setModal(null)}
          onSaved={async () => { setModal(null); await load(); }}
        />
      )}
      {usersFor && (
        <UsersModal
          account={usersFor}
          accounts={active}
          onClose={() => setUsersFor(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

function Stat({ label, value, hint, tone }) {
  const color = tone === 'warn' ? 'text-amber-300' : tone === 'ok' ? 'text-emerald-400' : 'text-white';
  return (
    <div className="card p-4">
      <div className="text-[11px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${color}`}>{value}</div>
      {hint && <div className="text-[11px] text-text-muted mt-0.5">{hint}</div>}
    </div>
  );
}

/** Add / edit one bank account. */
function AccountModal({ row, onClose, onSaved }) {
  const [form, setForm] = useState(() => (row ? { ...EMPTY, ...row } : { ...EMPTY }));
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const pickQr = (file) => {
    if (!file) return;
    if (file.size > QR_MAX_BYTES) return toast.error('QR image must be under 300 KB');
    const reader = new FileReader();
    reader.onload = () => set('qr', String(reader.result || ''));
    reader.onerror = () => toast.error('Could not read that file');
    reader.readAsDataURL(file);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.label.trim()) return toast.error('Label is required');
    if (!form.accountNumber.trim() && !form.upiId.trim()) return toast.error('Enter an account number or a UPI ID');
    setSaving(true);
    try {
      const body = {
        label: form.label, bankName: form.bankName, accountName: form.accountName, accountNumber: form.accountNumber,
        ifsc: form.ifsc, branch: form.branch, upiId: form.upiId, note: form.note, qr: form.qr,
      };
      if (row) await api.put(`/admin/bank-accounts/${row._id}`, body);
      else await api.post('/admin/bank-accounts', body);
      toast.success(row ? 'Bank account updated' : 'Bank account added');
      onSaved?.();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const field = (key, label, props = {}) => (
    <label className="block">
      <div className="label mb-1">{label}</div>
      <input className="input" value={form[key] || ''} onChange={(e) => set(key, e.target.value)} {...props} />
    </label>
  );

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        className="bg-bg-card rounded-2xl border border-border-dark max-w-lg w-full shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <h3 className="text-base font-bold text-text-primary">{row ? 'Edit bank account' : 'Add bank account'}</h3>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          {field('label', 'Label *', { placeholder: 'e.g. HDFC Main, ICICI 2', autoFocus: true })}
          <div className="grid grid-cols-2 gap-3">
            {field('bankName', 'Bank name', { placeholder: 'HDFC Bank' })}
            {field('branch', 'Branch', { placeholder: 'Optional' })}
          </div>
          {field('accountName', 'Beneficiary / account name', { placeholder: 'Imperial Exchange Pvt Ltd' })}
          <div className="grid grid-cols-2 gap-3">
            {field('accountNumber', 'Account number', { placeholder: '0000 0000 0000', inputMode: 'numeric' })}
            {field('ifsc', 'IFSC', { placeholder: 'HDFC0001234', style: { textTransform: 'uppercase' } })}
          </div>
          {field('upiId', 'UPI ID (optional)', { placeholder: 'business@hdfcbank' })}
          <label className="block">
            <div className="label mb-1">Note shown to the customer</div>
            <textarea className="input min-h-[64px]" value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="e.g. Mention your User ID in the transfer remark" />
          </label>
          <div>
            <div className="label mb-1">QR image (optional)</div>
            <div className="flex items-center gap-3">
              {form.qr ? (
                <img src={form.qr} alt="QR" className="w-16 h-16 rounded border border-border-dark bg-white object-contain p-0.5" />
              ) : (
                <div className="w-16 h-16 rounded border border-dashed border-border-dark flex items-center justify-center text-[10px] text-text-muted">none</div>
              )}
              <div className="flex flex-col gap-1.5">
                <input type="file" accept="image/*" className="text-xs text-text-muted" onChange={(e) => pickQr(e.target.files?.[0])} />
                {form.qr && <button type="button" onClick={() => set('qr', '')} className="text-[11px] text-bear text-left">Remove QR</button>}
              </div>
            </div>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-border-dark flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost text-sm">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary text-sm disabled:opacity-50">{saving ? 'Saving…' : (row ? 'Save changes' : 'Add account')}</button>
        </div>
      </form>
    </div>
  );
}

/** Users assigned to one account, each with a reassign control. */
function UsersModal({ account, accounts, onClose, onChanged }) {
  const [list, setList] = useState(null);
  const [moving, setMoving] = useState('');

  const load = async () => {
    try {
      const { data } = await api.get(`/admin/bank-accounts/${account._id}/users`);
      setList(data.data || []);
    } catch (e) {
      toast.error(errorMessage(e));
      setList([]);
    }
  };
  useEffect(() => { load(); }, [account._id]); // eslint-disable-line react-hooks/exhaustive-deps

  const reassign = async (u, bankAccountId) => {
    setMoving(u._id);
    try {
      await api.post('/admin/bank-accounts/assign', { userId: u._id, bankAccountId: bankAccountId || null });
      toast.success(`${u.email} ${bankAccountId ? 'reassigned' : 'set to auto'}`);
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setMoving('');
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-bg-card rounded-2xl border border-border-dark max-w-2xl w-full shadow-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-text-primary">{account.label}</h3>
            <div className="text-[11px] text-text-muted">{account.bankName || '—'} · {mask(account.accountNumber)} · assigned users</div>
          </div>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="overflow-y-auto flex-1">
          {list === null && <div className="p-6 text-text-muted text-sm">Loading…</div>}
          {list && list.length === 0 && <div className="p-6 text-text-muted text-sm">No users are assigned to this account.</div>}
          {list && list.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-text-muted border-b border-border-dark">
                  <th className="px-4 py-2">User</th>
                  <th className="px-4 py-2">Joined</th>
                  <th className="px-4 py-2 text-right">Move to</th>
                </tr>
              </thead>
              <tbody>
                {list.map((u) => (
                  <tr key={u._id} className="border-b border-border-dark/60">
                    <td className="px-4 py-2">
                      <div className="text-text-primary">{u.email}</div>
                      <div className="text-[11px] text-text-muted">{[u.userUid, [u.firstName, u.lastName].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || '—'}</div>
                    </td>
                    <td className="px-4 py-2 text-text-secondary">{fmtDate(u.createdAt)}</td>
                    <td className="px-4 py-2 text-right">
                      <select
                        className="input text-xs py-1"
                        value={String(account._id)}
                        disabled={moving === u._id}
                        onChange={(e) => reassign(u, e.target.value)}
                      >
                        {accounts.map((a) => <option key={a._id} value={a._id}>{a.label}</option>)}
                        {!accounts.some((a) => String(a._id) === String(account._id)) && (
                          <option value={String(account._id)}>{account.label} (inactive)</option>
                        )}
                        <option value="">Auto (least-loaded)</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {list && list.length >= 200 && <div className="px-4 py-2 text-[11px] text-text-muted">Showing the first 200 users.</div>}
        </div>
        <div className="px-5 py-3 border-t border-border-dark flex justify-end">
          <button type="button" onClick={onClose} className="btn-ghost text-sm">Close</button>
        </div>
      </div>
    </div>
  );
}
