import { create } from 'zustand';

// Display currency — pinned. The platform is INR-only: every wallet, fee, P&L
// and deposit figure the API returns is already rupees (backend
// config/constants BASE_CURRENCY), and every instrument is rupee-quoted. The
// selector that used to live here (USD ledger, converted at render time) has
// nothing left to select, so the store keeps its shape for the pages that
// still read it and always answers INR. `setCode` is a no-op on purpose.
const CODE = 'INR';

export const useDisplayCurrency = create(() => ({
  code: CODE,
  setCode: () => {},
  hydrateFrom: () => {},
}));
