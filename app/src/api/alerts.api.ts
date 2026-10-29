import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';

import { api, errorMessage } from '@/api/client';
import { rows } from '@/types/api';
import {
  adaptGlobalAlert,
  adaptPriceAlert,
  type AlertDirection,
  type GlobalAlert,
  type PriceAlert,
} from '@/types/market';
import { subscribeAlertsRefresh, subscribeForeground } from '@/websocket/channels';

/**
 * Two different things the product calls "alerts":
 *
 *   • PRICE ALERTS — the trader's own "tell me when RELIANCE goes above 3,000",
 *     at /reports/alerts (routes/reports.js). The price-monitor worker fires
 *     them server-side and they arrive as notifications; PriceAlerts.jsx and
 *     CreateAlertModal.jsx are the screens.
 *   • GLOBAL ALERTS — the platform's blocking announcements, at
 *     /alerts/pending (routes/globalAlerts.js). GlobalAlertPopup.jsx: a modal
 *     whose only exit is OK, which acknowledges it.
 */

type Raw = Record<string, unknown>;

const payload = (body: unknown): unknown => {
  const env = body && typeof body === 'object' ? (body as Raw) : {};
  return 'data' in env ? env.data : body;
};

/* ══ Price alerts ═════════════════════════════════════════════════════ */

/**
 * GET /reports/alerts — newest first, capped at 200 server-side. `active`
 * filters on isActive; absent lists all of them, as PriceAlerts.jsx does.
 */
export const fetchPriceAlerts = async (q: { active?: boolean } = {}): Promise<PriceAlert[]> => {
  const res = await api.get('/reports/alerts', {
    params: q.active === undefined ? undefined : { active: String(q.active) },
  });
  return rows<unknown>(payload(res.data)).map(adaptPriceAlert).filter((a) => a.id !== '');
};

export interface CreatePriceAlertInput {
  symbol: string;
  direction: AlertDirection;
  /** As typed. The server stores it as a string. */
  targetPrice: string;
  note?: string;
  /** Re-arm after each trigger instead of switching off. */
  repeatable?: boolean;
}

/**
 * CreateAlertModal's own check, in its words, before anything is sent. The
 * server repeats it ("symbol, direction, targetPrice required") and adds
 * what only it can know — an unknown or inactive symbol is 404.
 */
export const validatePriceAlert = (input: Partial<CreatePriceAlertInput>): string | null =>
  (!input.symbol || !String(input.targetPrice ?? '').trim()
    ? 'Symbol and target price are required'
    : null);

/** POST /reports/alerts. The body is the modal's form, as the web posts it. */
export const createPriceAlert = async (input: CreatePriceAlertInput): Promise<PriceAlert> => {
  const res = await api.post('/reports/alerts', {
    symbol: input.symbol,
    direction: input.direction,
    targetPrice: String(input.targetPrice).trim(),
    note: input.note ?? '',
    repeatable: !!input.repeatable,
  });
  return adaptPriceAlert(payload(res.data));
};

/** DELETE /reports/alerts/:id. */
export const deletePriceAlert = async (id: string): Promise<void> => {
  await api.delete(`/reports/alerts/${encodeURIComponent(id)}`);
};

/**
 * PUT /reports/alerts/:id/toggle — Pause ↔ Resume. Resuming also clears the
 * trigger, so a fired alert re-arms (priceAlertController.toggle).
 */
export const togglePriceAlert = async (id: string): Promise<PriceAlert> => {
  const res = await api.put(`/reports/alerts/${encodeURIComponent(id)}/toggle`);
  return adaptPriceAlert(payload(res.data));
};

/**
 * The alerts list, for the Price Alerts screen. `refresh` never rejects —
 * PriceAlerts.jsx toasts its failure and keeps the rows it had; the error is
 * returned here for the screen to toast the same way.
 */
export function usePriceAlerts(): {
  alerts: PriceAlert[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<string | null>;
} {
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async (): Promise<string | null> => {
    try {
      const list = await fetchPriceAlerts();
      if (alive.current) { setAlerts(list); setError(null); }
      return null;
    } catch (err) {
      const msg = errorMessage(err);
      if (alive.current) setError(msg);
      return msg;
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; };
  }, [refresh]);

  return { alerts, loading, error, refresh };
}

/* ══ Global alerts (the blocking popup) ═══════════════════════════════ */

/**
 * GET /alerts/pending — what this user has yet to see, already filtered
 * (targeting, schedule, acknowledged-and-not-repeating) and ordered
 * CRITICAL → WARNING → INFO, oldest first within a priority, by the server.
 */
export const fetchPendingGlobalAlerts = async (): Promise<GlobalAlert[]> => {
  const res = await api.get('/alerts/pending');
  return rows<unknown>(payload(res.data))
    .map(adaptGlobalAlert)
    .filter((a): a is GlobalAlert => a !== null);
};

/** POST /alerts/:id/acknowledge — idempotent server-side. */
export const acknowledgeGlobalAlert = async (id: string): Promise<void> => {
  await api.post(`/alerts/${encodeURIComponent(id)}/acknowledge`);
};

/** GlobalAlertPopup's poll. */
export const GLOBAL_ALERTS_POLL_MS = 60_000;

interface GlobalAlertsState {
  pending: GlobalAlert[];
  /**
   * Acknowledged in THIS session. A repeat-display alert stays away until
   * the next launch (the web: until reload), and any alert disappears the
   * instant OK is pressed rather than when the server round-trip lands.
   */
  dismissed: string[];
  acking: boolean;
}

export const useGlobalAlertStore = create<GlobalAlertsState>(() => ({
  pending: [],
  dismissed: [],
  acking: false,
}));

/** Pending minus dismissed, in server order. Exported for tests. */
export const visibleGlobalAlerts = (s: Pick<GlobalAlertsState, 'pending' | 'dismissed'>): GlobalAlert[] =>
  s.pending.filter((a) => !s.dismissed.includes(a.id));

/** Bumped by resetGlobalAlerts, so a fetch a user switch overtook lands nowhere. */
let alertsGeneration = 0;

/** Best-effort: a failure keeps whatever was pending. */
export const loadGlobalAlerts = async (): Promise<void> => {
  const gen = alertsGeneration;
  try {
    const pending = await fetchPendingGlobalAlerts();
    if (gen !== alertsGeneration) return;
    useGlobalAlertStore.setState({ pending });
  } catch { /* popups are best-effort */ }
};

/**
 * OK. Acknowledge, and dismiss locally EVEN IF the acknowledge failed — the
 * web does the same, so a network blip cannot trap the trader behind a modal.
 * A non-repeat alert whose ack was lost reappears on the next launch.
 */
export const acknowledgeCurrent = async (): Promise<void> => {
  const s = useGlobalAlertStore.getState();
  if (s.acking) return;
  const current = visibleGlobalAlerts(s)[0];
  if (!current) return;
  useGlobalAlertStore.setState({ acking: true });
  try { await acknowledgeGlobalAlert(current.id); } catch { /* still dismiss locally */ }
  useGlobalAlertStore.setState((st) => ({
    dismissed: st.dismissed.includes(current.id) ? st.dismissed : [...st.dismissed, current.id],
    pending: st.pending.filter((a) => a.id !== current.id),
    acking: false,
  }));
};

/** Sign-out: forget everything, including what was dismissed. */
export const resetGlobalAlerts = (): void => {
  alertsGeneration += 1;
  useGlobalAlertStore.setState({ pending: [], dismissed: [], acking: false });
};

/**
 * Drive the popup. Mount once, app-wide, with `signedIn`. Pending alerts are
 * pulled on sign-in, every 60s, on return to the foreground (the web's window
 * focus) and at once on an `alerts:refresh` nudge, so a freshly created alert
 * shows without a re-login. Signing out clears the queue.
 *
 * Returns the alert to show (null for none), its position in the queue, and
 * the OK action.
 */
export function useGlobalAlerts(signedIn: boolean): {
  current: GlobalAlert | null;
  total: number;
  acking: boolean;
  acknowledge: () => Promise<void>;
} {
  useEffect(() => {
    if (!signedIn) {
      resetGlobalAlerts();
      return undefined;
    }
    void loadGlobalAlerts();
    const poll = setInterval(() => { void loadGlobalAlerts(); }, GLOBAL_ALERTS_POLL_MS);
    const offFg = subscribeForeground(() => { void loadGlobalAlerts(); });
    const offWs = subscribeAlertsRefresh(() => { void loadGlobalAlerts(); });
    return () => { clearInterval(poll); offFg(); offWs(); };
  }, [signedIn]);

  const pending = useGlobalAlertStore((s) => s.pending);
  const dismissed = useGlobalAlertStore((s) => s.dismissed);
  const acking = useGlobalAlertStore((s) => s.acking);
  const visible = visibleGlobalAlerts({ pending, dismissed });

  return {
    current: signedIn ? visible[0] ?? null : null,
    total: visible.length,
    acking,
    acknowledge: acknowledgeCurrent,
  };
}
