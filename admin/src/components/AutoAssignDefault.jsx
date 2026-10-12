import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';

/**
 * SuperAdmin control for a global AUTO-ASSIGNMENT default capacity — how many
 * managers auto-fill under each admin, or how many users under each manager,
 * when that staff member has no explicit per-account "Limits" override.
 *
 * `field` is 'defaultMaxManagers' | 'defaultMaxUsers'. Persists via
 * PUT /hierarchy/defaults; the backend auto-assign engine + display read it.
 */
export default function AutoAssignDefault({ field, label, hint, value, editable = true, onSaved }) {
  const [val, setVal] = useState(value ?? '');
  const [busy, setBusy] = useState(false);

  // Sync when the parent finishes loading (value arrives after mount) or after
  // a save. Safe mid-edit: `value` only changes on load/save, not on keystroke.
  useEffect(() => { setVal(value ?? ''); }, [value]);

  const dirty = String(val).trim() !== String(value ?? '');

  const save = async () => {
    const n = Number(val);
    if (!Number.isInteger(n) || n < 1) return toast.error('Enter a whole number ≥ 1');
    setBusy(true);
    try {
      const { data } = await api.put('/hierarchy/defaults', { [field]: n });
      toast.success('Default saved · applies to new auto-assignments');
      onSaved?.(data.data);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="card p-3 flex items-center gap-3 flex-wrap">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-text-primary">{label}</div>
        {hint && <div className="text-[11px] text-text-muted mt-0.5 max-w-2xl">{hint}</div>}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <input
          type="number"
          min="1"
          className="input w-24 text-center font-mono"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && editable && dirty) save(); }}
          disabled={!editable}
          title={editable ? '' : 'Only the Super Admin can change this'}
        />
        {editable && (
          <button onClick={save} disabled={busy || !dirty} className="btn-primary text-sm disabled:opacity-50">
            {busy ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
    </div>
  );
}
