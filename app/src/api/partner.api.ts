import type { AxiosResponse } from 'axios';

import { api } from '@/api/client';
import { API_URL, WEB_ORIGIN } from '@/constants/env';
import { rows } from '@/types/api';
import {
  publicOrigin,
  referralLink,
  toCommission,
  toPartnerDashboard,
  toPartnerSettings,
  toReferral,
  toVolumeDashboard,
  type Commission,
  type CommissionSource,
  type PartnerDashboard,
  type PartnerSettings,
  type Referral,
  type VolumeDashboard,
} from '@/types/partner';

/**
 * Partner / referral — everything under /api/partner (routes/partner.js).
 *
 * All reads. Commissions are written by deposit confirmation and trade
 * settlement, never by the partner, and they land in the Bonus Wallet — so
 * withdrawing them is a Bonus Wallet action (`/bonus-wallet/*`), not a
 * partner one.
 */

const payload = (res: AxiosResponse): unknown => {
  const b = res.data as unknown;
  if (b && typeof b === 'object' && 'success' in b && 'data' in b) return (b as { data: unknown }).data;
  return b;
};

export const partnerApi = {
  /**
   * The partner screen's single source: level, progression, volumes,
   * commission overview, per-referral performance and the 6-month series.
   * Also read by the account overview card.
   */
  volumeDashboard: async (): Promise<VolumeDashboard | null> =>
    toVolumeDashboard(payload(await api.get('/partner/volume-dashboard'))),

  /**
   * The commission ledger, newest first. The partner screen asks for 8 and
   * shows 6, and treats a failure as an empty list rather than an error —
   * the ledger is a footnote to the dashboard, not a reason to blank it.
   */
  commissions: async (opts: { limit?: number; sourceType?: CommissionSource } = {}): Promise<Commission[]> =>
    rows<unknown>(payload(await api.get('/partner/commissions', {
      params: { limit: opts.limit ?? 100, ...(opts.sourceType ? { sourceType: opts.sourceType } : {}) },
    }))).map(toCommission),

  referrals: async (limit = 100): Promise<Referral[]> =>
    rows<unknown>(payload(await api.get('/partner/referrals', { params: { limit } }))).map(toReferral),

  settings: async (): Promise<PartnerSettings> =>
    toPartnerSettings(payload(await api.get('/partner/settings'))),

  /** The older count-based summary; the volume dashboard supersedes it on screen. */
  dashboard: async (): Promise<PartnerDashboard | null> =>
    toPartnerDashboard(payload(await api.get('/partner/dashboard'))),
};

/**
 * The partner's shareable link. WEB_ORIGIN (`EXPO_PUBLIC_WEB_ORIGIN` or
 * `expo.extra.webOrigin`, the same setting the deep links use) plays the
 * web's `VITE_PUBLIC_URL`; without it the link is built on the API host,
 * exactly as the web does when its API base is absolute. Set it wherever
 * the API and the public site live on different hosts, or the link will
 * point at the API.
 */
export const referralLinkFor = (code: string | null | undefined): string =>
  referralLink(code, publicOrigin(WEB_ORIGIN, API_URL));

export type PartnerApi = typeof partnerApi;
