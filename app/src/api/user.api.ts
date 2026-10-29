import { api } from '@/api/client';
import {
  toAuthUser,
  toKycStatusInfo,
  toLeverageState,
  type AuthUser,
  type KycStatusInfo,
  type LeverageState,
} from '@/types/user';
import type { PushPlatform } from '@/types/notifications';

// One definition, in types/notifications ('unknown' is the server's default).
export type { PushPlatform };

/**
 * /user/* — the profile, the KYC upload gate, leverage, and push registration.
 *
 * Trading ACCOUNTS are /user/accounts too, but live in api/account, beside
 * the account-plan catalogue they are always read with. The portfolio
 * dashboard is api/dashboard; the bell and the feedback / ticket list are
 * api/notifications and api/feedback.
 */

type Raw = Record<string, unknown>;

const payload = (body: unknown): unknown =>
  (body && typeof body === 'object' && 'success' in body ? (body as Raw).data : body);

export interface ProfileUpdate {
  firstName?: string;
  lastName?: string;
  phone?: string;
  /** ISO-2; the server uppercases it and '' clears it. */
  country?: string;
}

/* ── Push registration ────────────────────────────────────────────────
 * The web never calls these; the phone must. The token registered last is
 * remembered so sign-out can remove it: a signed-out phone that stays
 * registered keeps receiving the previous user's trade and margin alerts,
 * on a device that may already be in someone else's hands.
 */
let registeredPushToken: string | null = null;

export const userApi = {
  /**
   * PUT /user/profile — answers with the updated user, so the caller can
   * hand it straight to the auth store's setUser instead of a second read.
   */
  updateProfile: async (update: ProfileUpdate): Promise<AuthUser> => {
    const { data } = await api.put('/user/profile', update);
    const user = toAuthUser(payload(data));
    if (!user) throw new Error('Profile saved, but the server did not return it. Please refresh.');
    return user;
  },

  /**
   * GET /user/kyc/status — Profile → KYC reads `canUpload` from it: a
   * verified account has nothing left to submit unless an admin re-opened
   * upload. Profile.jsx keeps the form showing when this read fails.
   */
  kycStatus: async (): Promise<KycStatusInfo> => {
    const { data } = await api.get('/user/kyc/status');
    return toKycStatusInfo(payload(data));
  },

  /**
   * The effective leverage cap and its source — OrderForm.jsx bounds the
   * slider with it and shows the source chip. With an account id, a
   * DEMO/VIRTUAL account answers "unlimited": practice money bypasses plan
   * caps and admin overrides. Without one, the user-level answer.
   */
  getLeverage: async (accountId?: string): Promise<LeverageState> => {
    const { data } = await api.get('/user/leverage', { params: accountId ? { accountId } : {} });
    return toLeverageState(payload(data));
  },

  /* ── Push ──────────────────────────────────────────────────────────── */

  /**
   * Register this device for push. Idempotent server-side — the same token
   * is pulled and re-added, never duplicated — so calling it on every
   * sign-in is safe.
   *
   * The backend's pushService sends through FCM with the token as the FCM
   * `to`, so the token must be one FCM accepts (the native device token on
   * Android), not an `ExponentPushToken[…]`.
   */
  registerPushToken: async (token: string, platform: PushPlatform): Promise<void> => {
    await api.post('/user/push-tokens', { token, platform });
    registeredPushToken = token;
  },

  unregisterPushToken: async (token: string): Promise<void> => {
    // Expo tokens carry brackets, hence the encoding.
    await api.delete(`/user/push-tokens/${encodeURIComponent(token)}`);
    if (registeredPushToken === token) registeredPushToken = null;
  },

  /**
   * Remove whatever this session registered. Called on sign-out, BEFORE the
   * tokens are cleared — the endpoint needs the session it is ending.
   */
  unregisterCurrentPushToken: async (): Promise<void> => {
    const token = registeredPushToken;
    if (!token) return;
    registeredPushToken = null;
    await api.delete(`/user/push-tokens/${encodeURIComponent(token)}`);
  },

  /** The token this session registered, if any. */
  currentPushToken: (): string | null => registeredPushToken,
};
