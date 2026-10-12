import { useEffect, useState } from 'react';
import { api } from '../services/api';

/**
 * Shared account-plan (tier) catalogue. The fee breakdown needs each account's
 * fee model (feeKind / feeValue / feeDisplay) which lives on the AccountPlan,
 * NOT on the plain `/user/accounts` object — so we fetch `/account-plans` once
 * and share it (module cache like useInstruments). Consumers resolve a plan by
 * `account.accountType` via `planForAccount(...)`.
 */
let _cache = null;      // array of plans
let _byCode = null;     // Map(CODE → plan)
let _cacheAt = 0;
let _inflight = null;
const _listeners = new Set();
const TTL_MS = 60000;

const notify = () => _listeners.forEach((fn) => fn(_cache));

async function _load() {
  const res = await api.get('/account-plans');
  _cache = res.data?.data || [];
  _byCode = new Map(_cache.map((p) => [String(p.code || '').toUpperCase(), p]));
  _cacheAt = Date.now();
  notify();
  return _cache;
}

function fetchOnce({ force = false } = {}) {
  if (_cache && !force && (Date.now() - _cacheAt < TTL_MS)) return Promise.resolve(_cache);
  if (_inflight) return _inflight;
  _inflight = _load().finally(() => { _inflight = null; });
  return _inflight;
}

/**
 * Resolve the fee plan for an account (or a raw accountType string). Legacy
 * REAL / DEMO / VIRTUAL / CUSTOM types (and anything not in the catalogue) fall
 * back to STANDARD — mirroring the backend's getAccountTypeDef() fallback so the
 * displayed fee matches what settlement actually charges.
 */
export function planForAccount(account, byCode = _byCode) {
  if (!byCode) return null;
  const code = String((account && (account.accountType || account)) || '').toUpperCase();
  return byCode.get(code) || byCode.get('STANDARD') || null;
}

export function refreshAccountPlans() {
  return fetchOnce({ force: true }).catch(() => {});
}

/** Returns { plans, planByCode, loading }. planByCode is a plain object keyed by UPPERCASE code. */
export function useAccountPlans() {
  const [plans, setPlans] = useState(_cache || []);
  const [loading, setLoading] = useState(!_cache);

  useEffect(() => {
    let cancelled = false;
    const onCache = (next) => { if (!cancelled) setPlans(next || []); };
    _listeners.add(onCache);

    if (_cache) {
      setPlans(_cache);
      setLoading(false);
      if (Date.now() - _cacheAt > TTL_MS) fetchOnce({ force: true }).catch(() => {});
    } else {
      fetchOnce()
        .then((data) => { if (!cancelled) { setPlans(data); setLoading(false); } })
        .catch(() => { if (!cancelled) setLoading(false); });
    }

    return () => { cancelled = true; _listeners.delete(onCache); };
  }, []);

  const planByCode = {};
  for (const p of plans) planByCode[String(p.code || '').toUpperCase()] = p;
  return { plans, planByCode, loading };
}
