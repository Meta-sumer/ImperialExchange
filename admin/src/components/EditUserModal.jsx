import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { useAuthStore } from '../store/auth';

/**
 * Admin: edit a customer's profile (name / email / phone / country) and reset
 * their login password. Two independent actions in one modal — saving the
 * profile and resetting the password are separate submits.
 *
 * Props: { user:{_id,firstName,lastName,email,phone,country}, onClose, onSaved }
 *   onSaved — called after a successful profile save so the parent can reload.
 */
export default function EditUserModal({ user, onClose, onSaved }) {
  const [firstName, setFirstName] = useState(user.firstName || '');
  const [lastName, setLastName]   = useState(user.lastName || '');
  const [email, setEmail]         = useState(user.email || '');
  const [phone, setPhone]         = useState(user.phone || '');
  const [country, setCountry]     = useState(user.country || '');
  const [savingProfile, setSavingProfile] = useState(false);

  // Deposit bank account (Super Admin only) — which company account this
  // customer pays into. '' = Auto: the least-loaded active account is assigned
  // the next time the customer opens the deposit page.
  const me = useAuthStore((st) => st.user);
  const isSuper = me?.role === 'SUPER_ADMIN';
  const [bankAccounts, setBankAccounts] = useState([]);
  const [bankSel, setBankSel] = useState(user.depositBankAccountId ? String(user.depositBankAccountId) : '');
  const [savingBank, setSavingBank] = useState(false);
  useEffect(() => {
    if (!isSuper) return;
    api.get('/admin/bank-accounts').then((r) => setBankAccounts(r.data?.data || [])).catch(() => setBankAccounts([]));
  }, [isSuper]);

  const saveBank = async () => {
    setSavingBank(true);
    try {
      await api.post('/admin/bank-accounts/assign', { userId: user._id, bankAccountId: bankSel || null });
      toast.success(bankSel ? 'Deposit bank account assigned' : 'Set to auto — assigned on the next deposit');
      onSaved?.();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setSavingBank(false); }
  };

  const [pw, setPw] = useState('');
  const [resetting, setResetting] = useState(false);
  const [pwResult, setPwResult] = useState(null); // now-active password to reveal once

  const saveProfile = async () => {
    if (!email.trim()) return toast.error('Email cannot be empty');
    setSavingProfile(true);
    try {
      await api.put(`/admin/users/${user._id}/profile`, {
        firstName, lastName, email: email.trim(), phone: phone.trim(), country: country.trim(),
      });
      toast.success('Profile updated');
      onSaved?.();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setSavingProfile(false); }
  };

  const resetPassword = async () => {
    if (pw && pw.length < 6) return toast.error('Password must be at least 6 characters');
    setResetting(true);
    try {
      const { data } = await api.post(`/admin/users/${user._id}/reset-password`, { password: pw || undefined });
      setPwResult(data.data?.generatedPassword || pw);
      toast.success('Password reset · user signed out of all devices');
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setResetting(false); }
  };

  const copyPw = async () => {
    try { await navigator.clipboard.writeText(pwResult); toast.success('Copied'); }
    catch { toast.error('Copy failed — select the text manually'); }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-bg-card rounded-2xl border border-border-dark max-w-md w-full shadow-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <h3 className="text-base font-bold text-text-primary">Edit user</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        {/* Profile fields */}
        <div className="p-5 space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="label mb-1">First name</div>
              <input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </label>
            <label className="block">
              <div className="label mb-1">Last name</div>
              <input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </label>
          </div>
          <label className="block">
            <div className="label mb-1">Email</div>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="label mb-1">Phone</div>
              <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="—" />
            </label>
            <label className="block">
              <div className="label mb-1">Country</div>
              <input className="input" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="—" />
            </label>
          </div>
          <div className="flex justify-end pt-1">
            <button onClick={saveProfile} disabled={savingProfile} className="btn-primary text-sm disabled:opacity-50">
              {savingProfile ? 'Saving…' : 'Save profile'}
            </button>
          </div>
        </div>

        {/* Deposit bank account — Super Admin only */}
        {isSuper && (
          <div className="px-5 py-4 border-t border-border-dark space-y-2 text-sm">
            <div className="label">Deposit bank account</div>
            <p className="text-[12px] text-text-muted">The company account this customer sees on the deposit page. Leave on Auto to let the pool balance itself.</p>
            <div className="flex items-end gap-2">
              <select className="input flex-1" value={bankSel} onChange={(e) => setBankSel(e.target.value)}>
                <option value="">Auto (least-loaded active account)</option>
                {bankAccounts.map((b) => (
                  <option key={b._id} value={b._id} disabled={!b.isActive && String(b._id) !== bankSel}>
                    {b.label}{b.bankName ? ` · ${b.bankName}` : ''}{b.accountNumber ? ` · ••••${String(b.accountNumber).slice(-4)}` : ''}{b.isActive ? '' : ' (inactive)'}
                  </option>
                ))}
              </select>
              <button onClick={saveBank} disabled={savingBank} className="btn-secondary text-sm disabled:opacity-50 shrink-0">
                {savingBank ? 'Saving…' : 'Assign'}
              </button>
            </div>
          </div>
        )}

        {/* Reset password */}
        <div className="px-5 py-4 border-t border-border-dark space-y-3 text-sm">
          <div className="label">Reset password</div>
          {pwResult ? (
            <>
              <p className="text-text-secondary text-[13px]">New password — share securely, shown once:</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 rounded-lg bg-bg-hover border border-border-dark font-mono text-text-primary break-all select-all">{pwResult}</code>
                <button onClick={copyPw} className="btn-secondary text-xs shrink-0">Copy</button>
              </div>
              <p className="text-[12px] text-warn">⚠ The user was signed out of all devices and must log in again with this password.</p>
            </>
          ) : (
            <div className="flex items-end gap-2">
              <label className="block flex-1">
                <div className="label mb-1">New password (optional)</div>
                <input className="input" type="text" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Blank = auto-generate a temp password" />
              </label>
              <button onClick={resetPassword} disabled={resetting} className="btn-secondary text-sm disabled:opacity-50 shrink-0">
                {resetting ? 'Resetting…' : 'Reset'}
              </button>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border-dark flex justify-end">
          <button onClick={onClose} className="btn-ghost text-sm">Close</button>
        </div>
      </div>
    </div>
  );
}
