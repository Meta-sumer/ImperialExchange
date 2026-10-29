import { create } from 'zustand';

/**
 * INR passthrough — kept so existing importers keep compiling.
 *
 * The web's useFxRate.js is gone on EquityHub (commit "Client: INR-only
 * display"): every amount the API returns is already rupees, and the
 * backend's /fx/usdinr answers `{ rate: 1, source: 'inr-ledger' }` "for older
 * clients". So there is nothing to fetch and nothing to convert: the "rate"
 * is 1, always, and a caller that still multiplies by it gets the figure it
 * started with.
 *
 * No request is made. New code should not read this at all — format with
 * `@/utils/money`, which is rupees throughout.
 */

/** Rupees per rupee. */
export const INR_RATE = 1;

/** Kept for older imports; there is no cache to expire. */
export const FX_TTL_MS = 5 * 60 * 1000;

interface FxState {
  rate: number;
  at: number;
}

/** Kept for older imports. Always `{ rate: 1 }`. */
export const useFxStore = create<FxState>(() => ({ rate: INR_RATE, at: 0 }));

/** Always resolves 1 — no network. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const loadUsdInr = (_force = false): Promise<number> => Promise.resolve(INR_RATE);

/**
 * Always 1: EquityHub money is rupees end to end. Typed `number | null` as
 * before, so callers that still guard for "no rate" keep compiling.
 */
export const useUsdInr = (): number | null => INR_RATE;

/** Tests only. */
export const _resetUsdInr = (): void => {
  useFxStore.setState({ rate: INR_RATE, at: 0 });
};
