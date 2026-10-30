import { create } from 'zustand';

import { api } from '@/api/client';

/**
 * Which optional market features THIS backend offers.
 *
 * Imperial Exchange trades NSE/BSE cash stocks, the index spots and MCX
 * commodities — no futures or options. The web client simply has no F&O
 * pages; this app was ported from a build that did, so every F&O surface
 * (the Option Chain tab, the stock page's chain button, the chain screen)
 * asks here before it shows itself.
 *
 * The answer comes from the backend, not a constant: GET
 * /instruments/fno/underlyings exists only where F&O is on. A 404 means
 * "not offered" and hides the surfaces; a success turns them on; a network
 * failure leaves the last answer (unknown shows them, as the web's build
 * did), so a dead connection never hides a feature a trader has.
 */
export type FeatureState = 'unknown' | 'on' | 'off';

interface FeaturesState {
  fno: FeatureState;
  /** The probe has answered (either way) since launch. */
  probed: boolean;
}

export const useFeaturesStore = create<FeaturesState>(() => ({ fno: 'unknown', probed: false }));

/** An HTTP 404 from the API — the route is not mounted on this backend. */
export const isNotFound = (err: unknown): boolean => {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return status === 404;
};

/** F&O is off for this backend — called by a screen that just saw the 404. */
export const markFnoUnavailable = (): void => {
  useFeaturesStore.setState({ fno: 'off', probed: true });
};

let inflight: Promise<void> | null = null;

/**
 * Ask the backend once. Cheap (a HEAD-sized list, or a 404) and awaited in
 * the boot gate so the first frame already knows whether to draw the tab.
 */
export const probeFeatures = (): Promise<void> => {
  if (inflight) return inflight;
  inflight = api.get('/instruments/fno/underlyings', { timeout: 4000 })
    .then(() => { useFeaturesStore.setState({ fno: 'on', probed: true }); })
    .catch((err: unknown) => {
      if (isNotFound(err)) useFeaturesStore.setState({ fno: 'off', probed: true });
      else useFeaturesStore.setState((s) => ({ ...s, probed: true }));
    })
    .finally(() => { inflight = null; });
  return inflight;
};

/** True unless the backend has said F&O is not offered. */
export const useFnoAvailable = (): boolean => useFeaturesStore((s) => s.fno !== 'off');
export const fnoAvailable = (): boolean => useFeaturesStore.getState().fno !== 'off';
