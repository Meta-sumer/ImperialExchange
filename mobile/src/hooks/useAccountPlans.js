import { useEffect, useState } from 'react';
import { api } from '../services/api';

// Fee grouping — same mapping as the web feeType.js.
const FEE_GROUP = {
  PERCENTAGE: 'Commission', PCT_OF_VALUE: 'Commission',
  FIXED: 'Charges', FIXED_PER_TRADE: 'Charges', PCT_OF_PROFIT: 'Charges',
};
export const feeGroupOf = (kind) => FEE_GROUP[String(kind || '').toUpperCase()] || null;

let _cache = null;

/**
 * Account-tier fee catalogue (feeKind / feeValue / feeDisplay per code). Drives
 * the order-ticket fee breakdown. Legacy types fall back to STANDARD.
 */
export function useAccountPlans() {
  const [byCode, setByCode] = useState(_cache || {});
  useEffect(() => {
    if (_cache) return;
    api.get('/account-plans').then((r) => {
      const map = {};
      for (const p of (r.data?.data || [])) map[String(p.code || '').toUpperCase()] = p;
      _cache = map;
      setByCode(map);
    }).catch(() => {});
  }, []);
  return byCode;
}

export function planForType(byCode, accountType) {
  const code = String(accountType || '').toUpperCase();
  return byCode[code] || byCode.STANDARD || null;
}
