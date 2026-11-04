import { useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';

/**
 * Delete a receiving bank account from the pool for good.
 *
 * Users assigned to it either move to another active account picked here, or
 * are left unassigned, in which case each gets the least-loaded active account
 * the next time they open Add Funds (or the Payment Settings bank details when
 * the pool is empty). Used by Bank Accounts and by Payments → Deposit.
 * DELETE /admin/bank-accounts/:id { moveTo? }
 *
 * Props: account (row with _id, label, bankName, accountNumber, assignedUsers),
 * accounts (all pool rows, to offer the move target), onClose, onDone.
 */
export default function DeleteBankAccountModal({ account, accounts = [], onClose, onDone }) {
  const [moveTo, setMoveTo] = useState('');
  const [saving, setSaving] = useState(false);
  const users = Number(account.assignedUsers || 0);
  const targets = accounts.filter((a) => a.isActive && String(a._id) !== String(account._id));
  const last4 = String(account.accountNumber || '').slice(-4);

  const submit = async () => {
    setSaving(true);
    try {
      const { data } = await api.delete(`/admin/bank-accounts/${account._id}`, { data: moveTo ? { moveTo } : {} });
      const r = data.data || {};
      toast.success(`Bank account ${account.label} deleted${r.usersMoved ? ` · ${r.usersMoved} user${r.usersMoved === 1 ? '' : 's'} ${r.movedTo ? `moved to ${r.movedTo.label}` : 'will be re-assigned'}` : ''}`);
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-bg-card border border-border-dark rounded-xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-border-dark flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-text-primary">Delete bank account</h3>
            <p className="text-xs text-text-muted mt-0.5">
              {account.label}{account.bankName ? ` · ${account.bankName}` : ''}{last4 ? ` · ••${last4}` : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-4 space-y-3 text-sm">
          <p className="text-xs text-text-secondary">
            The account is removed from the pool for good and clients will no longer see it on Add Funds.
            Past deposits keep the details they were made with.
          </p>
          {users > 0 ? (
            <div>
              <label className="label">{users} user{users === 1 ? ' is' : 's are'} on this account. Move them to</label>
              <select className="input" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                <option value="">Auto: next active account on their next visit</option>
                {targets.map((a) => (
                  <option key={a._id} value={a._id}>{a.label}{a.bankName ? ` · ${a.bankName}` : ''} · ••{String(a.accountNumber || '').slice(-4)}</option>
                ))}
              </select>
              {!targets.length && (
                <p className="text-[11px] text-text-muted mt-1">No other active account. These users will see the Payment Settings bank details.</p>
              )}
            </div>
          ) : (
            <p className="text-xs text-text-muted">No users are assigned to this account.</p>
          )}
        </div>
        <div className="px-4 py-3 border-t border-border-dark flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost text-sm">Cancel</button>
          <button type="button" onClick={submit} disabled={saving} className="btn-bear text-sm disabled:opacity-40">
            {saving ? 'Deleting…' : 'Delete account'}
          </button>
        </div>
      </div>
    </div>
  );
}
