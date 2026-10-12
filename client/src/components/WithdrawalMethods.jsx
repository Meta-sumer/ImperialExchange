import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';

/**
 * WithdrawalMethods — manage the user's saved payout destinations.
 *
 * Add → the method starts PENDING (an admin verifies it). Only VERIFIED methods
 * can be selected for a withdrawal (enforced server-side). Removing a method is a
 * soft-archive on the backend, so past withdrawal snapshots stay intact.
 * Sensitive details (full account no. / wallet) are never shown — only masked.
 */

const TYPE_LABEL = { BANK: 'Bank Account', UPI: 'UPI ID', CRYPTO: 'Crypto Wallet' };

// Open for payouts. `withdrawalEnabled` absent means the admin never touched
// the withdrawal switch, so fall back to the deposit one — the same rule the
// server uses (utils/paymentMethods railEnabled) and the withdraw modal.
const railOpen = (cfg) => (cfg
  ? (cfg.withdrawalEnabled === undefined || cfg.withdrawalEnabled === null
    ? cfg.enabled !== false
    : cfg.withdrawalEnabled !== false)
  : true);

// MUST match withdrawalFieldKey() in backend/src/utils/paymentMethods.js.
// The user fills a value under this key and the server looks it up by the
// same rule — if the two ever drift, every custom destination fails to save
// with "required" on a field the user plainly filled in.
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

const fieldKey = (f) => String((f && (f.key || f.label)) || '')
  .trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
const STATUS_STYLE = {
  VERIFIED: { bg: 'rgba(22,163,74,0.12)', color: '#16A34A', label: 'Verified' },
  PENDING: { bg: 'rgba(245,158,11,0.14)', color: '#B45309', label: 'Pending' },
  REJECTED: { bg: 'rgba(220,38,38,0.12)', color: '#DC2626', label: 'Rejected' },
  BLOCKED: { bg: 'rgba(107,114,128,0.15)', color: '#4B5563', label: 'Blocked' },
};
const NETWORKS = ['TRC20', 'ERC20', 'BEP20', 'BTC'];

export default function WithdrawalMethods({ onClose, onChanged }) {
  const [methods, setMethods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  const load = () => {
    setLoading(true);
    api.get('/withdrawal-methods')
      .then((r) => setMethods(r.data?.data || []))
      .catch((e) => toast.error(errorMessage(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);
  const changed = () => { load(); onChanged && onChanged(); };

  const remove = async (id) => {
    if (!window.confirm('Remove this withdrawal method? You will need to add + verify a new one to use it again.')) return;
    try {
      await api.delete(`/withdrawal-methods/${id}`);
      toast.success('Withdrawal method removed');
      changed();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl border border-border-dark w-full max-w-lg max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-text-primary">Withdrawal Methods</h2>
            <p className="text-[11px] text-text-muted mt-0.5">Only <b>verified</b> methods can be used to withdraw. New methods are verified by our team.</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg text-text-secondary hover:bg-bg-hover shrink-0" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {loading && <div className="text-center text-text-muted text-sm py-8">Loading…</div>}
          {!loading && !adding && methods.length === 0 && (
            <div className="text-center text-text-muted text-sm py-8">No withdrawal methods yet. Add one to get started.</div>
          )}

          {!adding && methods.map((m) => {
            const st = STATUS_STYLE[m.status] || STATUS_STYLE.PENDING;
            return (
              <div key={m.id} className="rounded-xl border border-border-dark p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-text-primary truncate">{m.label}</span>
                    <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: st.bg, color: st.color }}>{st.label}</span>
                  </div>
                  <div className="text-[11px] text-text-muted mt-0.5 font-mono">{TYPE_LABEL[m.type]} · {m.maskedDestination}</div>
                  {m.status === 'REJECTED' && m.rejectedReason && <div className="text-[10px] text-bear mt-0.5">Reason: {m.rejectedReason}</div>}
                </div>
                <button onClick={() => remove(m.id)} className="text-bear hover:bg-bear/10 rounded-lg px-2.5 py-1 text-xs font-semibold shrink-0">Remove</button>
              </div>
            );
          })}

          {adding && <AddForm onCancel={() => setAdding(false)} onAdded={() => { setAdding(false); changed(); }} />}
        </div>

        {!adding && (
          <div className="px-5 py-3 border-t border-border-subtle">
            <button onClick={() => setAdding(true)} className="w-full py-2.5 rounded-xl bg-primary-600 text-white font-semibold text-sm hover:bg-primary-500 transition-colors">+ Add Withdrawal Method</button>
          </div>
        )}
      </div>
    </div>
  );
}

function AddForm({ onCancel, onAdded }) {
  const [type, setType] = useState('BANK');
  const [label, setLabel] = useState('');
  const [f, setF] = useState({ network: 'TRC20' });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  // Which rails the admin actually allows for payouts. Same source the
  // deposit screen and the withdraw modal read, so the three stay in step.
  const [payDetails, setPayDetails] = useState(null);
  useEffect(() => {
    api.get('/wallet/deposit-details')
      .then((r) => setPayDetails(r.data?.data || {}))
      .catch(() => setPayDetails({})); // offer the built-ins rather than an empty form
  }, []);

  // Every rail the admin has open for payouts. A rail without its own form
  // gets one from withdrawalSchema — the admin's fields, or one default
  // input — so an enabled rail is always fillable.
  const customRails = useMemo(
    () => (payDetails?.custom || []).filter((c) => c && c.label && railOpen(c)),
    [payDetails],
  );

  // Native rails keep their own validated inputs; the rest are generic.
  const nativeRails = useMemo(() => ['BANK', 'UPI', 'CRYPTO'].filter((t) => railOpen(payDetails?.[t])), [payDetails]);
  const genericFixed = useMemo(
    () => FIXED_RAIL_IDS.filter((id) => !NATIVE_DESTINATION_RAILS.has(id) && railOpen(payDetails?.[id])),
    [payDetails],
  );
  const builtIns = nativeRails;

  // The selected non-native rail — a fixed one like SKRILL, or a custom id.
  const custom = useMemo(() => {
    if (NATIVE_DESTINATION_RAILS.has(type)) return null;
    if (genericFixed.includes(type)) return { id: type, label: RAIL_META[type]?.label || type, ...(payDetails?.[type] || {}) };
    return customRails.find((c) => String(c.id) === type) || null;
  }, [customRails, genericFixed, payDetails, type]);
  const schema = useMemo(() => (custom ? (withdrawalSchema(custom.id, custom) || []) : []), [custom]);

  // Keep the selection legal once the config arrives — the default BANK may
  // itself be closed for withdrawals.
  useEffect(() => {
    if (!payDetails) return;
    const legal = [...builtIns, ...genericFixed, ...customRails.map((c) => String(c.id))];
    if (legal.length && !legal.includes(type)) setType(legal[0]);
  }, [payDetails, builtIns, customRails, type]);

  const submit = async () => {
    if (!label || label.trim().length < 2) return toast.error('Add a label (e.g. "HDFC Salary")');
    setSaving(true);
    try {
      const body = { type, label: label.trim() };
      if (type === 'BANK') Object.assign(body, { accountHolderName: f.accountHolderName, bankName: f.bankName, accountNumber: f.accountNumber, ifsc: f.ifsc });
      else if (type === 'UPI') body.upiId = f.upiId;
      else if (type === 'CRYPTO') Object.assign(body, { network: f.network || 'TRC20', walletAddress: f.walletAddress });
      else if (custom) {
        // Admin-defined rail: send the values under the shared key rule and
        // let the server validate them against its own copy of the schema.
        const details = {};
        for (const fld of schema) {
          const k = fieldKey(fld);
          if (k) details[k] = String(f[k] == null ? '' : f[k]).trim();
        }
        Object.assign(body, { type: 'CUSTOM', methodKey: String(custom.id), details });
      }
      await api.post('/withdrawal-methods', body);
      toast.success('Method added — pending verification');
      onAdded();
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };

  const inp = 'w-full mt-1 px-3 py-2 rounded-lg border border-border-dark focus:border-primary-500 outline-none text-sm text-text-primary';
  const lbl = 'text-[11px] font-bold uppercase tracking-wider text-text-muted';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {builtIns.map((t) => (
          <button key={t} onClick={() => setType(t)} className={`flex-1 min-w-[30%] py-2 rounded-lg text-xs font-bold border transition-colors ${type === t ? 'border-primary-500 bg-primary-500/10 text-primary-600' : 'border-border-dark text-text-secondary hover:bg-bg-hover'}`}>{TYPE_LABEL[t]}</button>
        ))}
        {genericFixed.map((id) => (
          <button key={id} onClick={() => setType(id)} className={`flex-1 min-w-[30%] py-2 rounded-lg text-xs font-bold border transition-colors ${type === id ? 'border-primary-500 bg-primary-500/10 text-primary-600' : 'border-border-dark text-text-secondary hover:bg-bg-hover'}`}>
            {RAIL_META[id]?.label || id}
          </button>
        ))}
        {customRails.map((c) => (
          <button key={c.id} onClick={() => setType(String(c.id))} className={`flex-1 min-w-[30%] py-2 rounded-lg text-xs font-bold border transition-colors ${type === String(c.id) ? 'border-primary-500 bg-primary-500/10 text-primary-600' : 'border-border-dark text-text-secondary hover:bg-bg-hover'}`}>
            {c.emoji ? `${c.emoji} ` : ''}{c.label}
          </button>
        ))}
      </div>
      {payDetails && !builtIns.length && !customRails.length && (
        <div className="text-[12px] text-text-muted py-2">
          No withdrawal methods are available right now. Please contact support.
        </div>
      )}
      <div><label className={lbl}>Label *</label><input className={inp} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. HDFC Salary" /></div>

      {type === 'BANK' && (
        <>
          <div><label className={lbl}>Account holder name *</label><input className={inp} value={f.accountHolderName || ''} onChange={(e) => set('accountHolderName', e.target.value)} placeholder="Full name as on bank account" /></div>
          <div><label className={lbl}>Bank name</label><input className={inp} value={f.bankName || ''} onChange={(e) => set('bankName', e.target.value)} placeholder="e.g. HDFC Bank" /></div>
          <div><label className={lbl}>Account number *</label><input className={`${inp} font-mono`} value={f.accountNumber || ''} onChange={(e) => set('accountNumber', e.target.value.replace(/\s/g, ''))} placeholder="e.g. 50100123456789" /></div>
          <div><label className={lbl}>IFSC *</label><input className={`${inp} font-mono uppercase`} maxLength={11} value={f.ifsc || ''} onChange={(e) => set('ifsc', e.target.value.toUpperCase())} placeholder="HDFC0001234" /></div>
        </>
      )}
      {type === 'UPI' && (
        <div><label className={lbl}>UPI ID *</label><input className={`${inp} font-mono`} value={f.upiId || ''} onChange={(e) => set('upiId', e.target.value)} placeholder="yourname@bank" /></div>
      )}
      {type === 'CRYPTO' && (
        <>
          <div>
            <label className={lbl}>Network *</label>
            <select className={inp} value={f.network || 'TRC20'} onChange={(e) => set('network', e.target.value)}>
              {NETWORKS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div><label className={lbl}>Wallet address *</label><input className={`${inp} font-mono text-xs`} value={f.walletAddress || ''} onChange={(e) => set('walletAddress', e.target.value.trim())} placeholder="0x… or T…" /></div>
        </>
      )}
      {/* An admin-defined rail: one input per field the admin asked for. */}
      {custom && schema.map((fld) => {
        const k = fieldKey(fld);
        return (
          <div key={k}>
            <label className={lbl}>{fld.label}{fld.required !== false ? ' *' : ''}</label>
            <input className={`${inp} font-mono text-xs`} value={f[k] || ''}
              onChange={(e) => set(k, e.target.value)}
              placeholder={fld.placeholder || fld.label} />
          </div>
        );
      })}

      <div className="flex gap-2 pt-1">
        <button onClick={onCancel} className="flex-1 py-2 rounded-lg border border-border-dark text-sm font-semibold text-text-primary hover:bg-bg-hover">Cancel</button>
        <button onClick={submit} disabled={saving} className="flex-1 py-2 rounded-lg bg-primary-600 text-white text-sm font-semibold disabled:opacity-50 hover:bg-primary-500">{saving ? 'Saving…' : 'Add method'}</button>
      </div>
    </div>
  );
}
