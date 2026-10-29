/**
 * The shapes every endpoint shares.
 *
 * The backend answers `{ success: true, data }` on success and
 * `{ success: false, error: { code, message } }` on failure
 * (backend/src/utils/errors.js — sendSuccess / the error handler).
 *
 * ── WHY THE READERS ARE TOLERANT ──────────────────────────────────────
 * Not every endpoint is consistent. Some return the envelope, some a bare
 * array, and a few wrap the row under its own name (`{ deposit }`,
 * `{ withdrawal }`, `{ conversation }`). The web client works around this
 * per call site. This app does it once, in `rows()` and `one()`, so a
 * caller that assumed the wrong shape cannot take a screen down —
 * which has happened: "(rows ?? []).map is not a function".
 * ──────────────────────────────────────────────────────────────────────
 */

export interface ApiEnvelope<T> {
  success: boolean;
  data: T;
}

export interface ApiErrorBody {
  success: false;
  error: {
    code?: string;
    message: string;
    /** Broker errors carry the broker code and whether a retry could help. */
    broker?: string;
    retryable?: boolean;
  };
}

/** Error codes the UI acts on rather than merely displays. */
export const API_ERROR = {
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  IMPERSONATION_READONLY: 'IMPERSONATION_READONLY',
  KYC_REQUIRED: 'KYC_REQUIRED',
  WITHDRAWAL_METHOD_REQUIRED: 'WITHDRAWAL_METHOD_REQUIRED',
  WITHDRAWAL_METHOD_NOT_VERIFIED: 'WITHDRAWAL_METHOD_NOT_VERIFIED',
  BROKER_ACCESS_DENIED: 'BROKER_ACCESS_DENIED',
  DESTINATION_UNAVAILABLE: 'DESTINATION_UNAVAILABLE',
  UNSUPPORTED_BASE_CURRENCY: 'UNSUPPORTED_BASE_CURRENCY',
  DUPLICATE_METHOD: 'DUPLICATE_METHOD',
} as const;
export type ApiErrorCode = (typeof API_ERROR)[keyof typeof API_ERROR];

/**
 * Rows out of a response that may be a bare array OR an envelope.
 * `keys` names any endpoint-specific wrapper to look under first.
 */
export const rows = <T>(body: unknown, ...keys: string[]): T[] => {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === 'object') {
    const env = body as Record<string, unknown>;
    for (const key of [...keys, 'items', 'data', 'rows', 'entries']) {
      if (Array.isArray(env[key])) return env[key] as T[];
    }
  }
  return [];
};

/** A single row that may arrive bare or wrapped under its own name. */
export const one = <T>(body: unknown, ...keys: string[]): T | null => {
  if (!body || typeof body !== 'object') return null;
  const env = body as Record<string, unknown>;
  for (const key of keys) {
    const v = env[key];
    if (v && typeof v === 'object') return v as T;
  }
  return body as T;
};

/* ── Adapter helpers ──────────────────────────────────────────────────
 * Every adapter in this app reads defensively rather than trusting the
 * shape. These endpoints are shared with a web client that reads them
 * differently, and an admin can change several of them without a deploy.
 */

/** A string, or the fallback. Numbers are accepted and stringified. */
export const str = (v: unknown, fallback = ''): string =>
  (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback);

/** A non-empty trimmed string, or null. For optional admin-written copy. */
export const strOrNull = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? null : s;
};

/** A finite number, or null. Never coerces absent to zero. */
export const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * A decimal string, carried through unparsed. See types/trading — a float
 * round-trip loses cents, and these are the numbers a statement must match.
 */
export const dec = (v: unknown, fallback = '0'): string => {
  if (typeof v === 'string' && v.trim() !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return fallback;
};

export const bool = (v: unknown): boolean => v === true;

/** Mongo gives `_id`; some endpoints normalise to `id`. Accept either. */
export const id = (raw: Record<string, unknown>): string =>
  str(raw._id) || str(raw.id) || '';
