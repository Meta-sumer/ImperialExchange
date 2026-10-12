import { create } from 'zustand';
import { api } from '../services/api';

// The user's chosen DISPLAY currency (presentation only). Never affects the
// account — the wallet and all trading math stay in USD. Persisted to
// localStorage so the choice survives refresh, and mirrored to the backend
// (User.preferredDisplayCurrency) best-effort so it follows across devices.
//
// USD IS THE DEFAULT AND THE PRIMARY CURRENCY. Everything is stored in USD, so
// the default must agree with storage rather than convert away from it.
const STORAGE_KEY = 'tradepro:display-currency:v2';
const LEGACY_KEY = 'tradepro:display-currency';
const DEFAULT_CODE = 'USD';

// One-time reset, hence the versioned key.
//
// Before this, several pages hardcoded a rupee sign and ignored the selector
// entirely, so a value could end up saved as INR without the user ever choosing
// it — including from a profile field written by a build where the selector and
// the display disagreed. Honouring those would keep showing rupees on a
// USD-denominated account forever, since nothing would ever overwrite them.
//
// The legacy key is removed rather than migrated: its value cannot be trusted
// to represent an intentional choice. Everything AFTER this reset is
// intentional, and is persisted and synced normally.
let _didReset = false;

const readSaved = () => {
  if (typeof window === 'undefined') return DEFAULT_CODE;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return saved.toUpperCase();
    // First load under the new key — start at USD and drop the old value.
    localStorage.removeItem(LEGACY_KEY);
    localStorage.setItem(STORAGE_KEY, DEFAULT_CODE);
    _didReset = true;
    return DEFAULT_CODE;
  } catch (_) {
    // Private windows and blocked site data throw on access; the default still
    // has to work, it just will not persist.
    return DEFAULT_CODE;
  }
};

export const useDisplayCurrency = create((set, get) => ({
  code: readSaved(),
  setCode: (raw) => {
    const code = String(raw || DEFAULT_CODE).toUpperCase();
    if (code === get().code) return;
    set({ code });
    try { localStorage.setItem(STORAGE_KEY, code); } catch (_) { /* ignore */ }
    // Best-effort backend sync — never block the UI on it.
    api.put('/user/profile', { preferredDisplayCurrency: code }).catch(() => {});
  },
  // Seed from the authenticated user's saved preference, for a device that has
  // never made a choice. It cannot fire on an existing browser any more: the
  // reset above writes the new key on first load, so `hasLocal` is already true
  // by the time this runs. That is deliberate — a profile value written before
  // the reset carries the same doubt as the local one did.
  // NOTE: nothing calls this today — grep found no callers outside this file —
  // so User.preferredDisplayCurrency is currently written by setCode and never
  // read back. Kept because it is the obvious place to seed a fresh device, but
  // do not assume it runs.
  //
  // If it is ever wired up, mind the ordering: readSaved() writes the new key on
  // first load, so `hasLocal` is already true by the time any post-login hook
  // could fire on an existing browser. A profile value written before the reset
  // carries the same doubt the local one did, and must not resurrect rupees on
  // a USD-denominated account.
  hydrateFrom: (userPref) => {
    if (!userPref || _didReset) return;
    let hasLocal = false;
    try { hasLocal = !!localStorage.getItem(STORAGE_KEY); } catch (_) { /* ignore */ }
    if (hasLocal) return;
    const code = String(userPref).toUpperCase();
    set({ code });
    try { localStorage.setItem(STORAGE_KEY, code); } catch (_) { /* ignore */ }
  },
}));
