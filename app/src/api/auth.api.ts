import type { AxiosError } from 'axios';

import { api } from '@/api/client';
import { getRefreshToken } from '@/services/tokenStore';
import { rows, str } from '@/types/api';
import {
  toAuthUser,
  toSessionDevice,
  type AuthUser,
  type LoginResult,
  type SessionDevice,
} from '@/types/user';

/**
 * /auth/* — sign-in, sign-up, password recovery, email verification,
 * sessions (EquityHub's routes/auth.js — it has no two-factor routes and
 * no broker sign-in).
 *
 * Token STORAGE is not done here. These calls return what the server sent;
 * store/auth decides what becomes the session, after the role gate. A call
 * in this file that wrote tokens would be a way to hold a session that the
 * gate never saw.
 *
 * `/auth/refresh` is deliberately absent: it lives inside api/client's
 * interceptor, where the refresh queue is, and calling it from anywhere
 * else would rotate the refresh token out from under that queue.
 */

type Raw = Record<string, unknown>;

/** The `data` of a `{ success, data }` envelope, or the body itself. */
const payload = (body: unknown): unknown =>
  (body && typeof body === 'object' && 'success' in body ? (body as Raw).data : body);

const record = (v: unknown): Raw =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

type ErrBody = { error?: { code?: string; details?: unknown } };

const errorCode = (err: unknown): string | null =>
  (err as AxiosError<ErrBody> | undefined)?.response?.data?.error?.code ?? null;

/** A login or register response. Refuses one that is missing a token or a user. */
const toLoginResult = (body: unknown): LoginResult => {
  const d = record(payload(body));
  const user = toAuthUser(d.user);
  const accessToken = str(d.accessToken);
  const refreshToken = str(d.refreshToken);
  if (!user || !accessToken || !refreshToken) {
    // A 200 without a usable session is a server fault, and treating it as a
    // sign-in would leave the app "authenticated" with nothing to send.
    throw new Error('Sign-in failed — the server returned no session. Please try again.');
  }
  return { user, accessToken, refreshToken };
};

/* ── Sign-in / sign-up ────────────────────────────────────────────────── */

/** What authController.login reads — email and password, nothing else. */
export interface LoginInput {
  email: string;
  password: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  /** Normalised server-side: leading +, digits only. */
  phone?: string;
  /** ISO-2, uppercased. */
  country?: string;
  /** Uppercased. An unknown code is REFUSED, not dropped. */
  referralCode?: string;
}

export const authApi = {
  /**
   * Each sign-in is its own session. Past the plan's device limit the
   * server signs the least recently used session out instead of refusing
   * this one (authController.login, evict-oldest).
   */
  login: async (input: LoginInput): Promise<LoginResult> => {
    const { data } = await api.post('/auth/login', {
      email: input.email,
      password: input.password,
    });
    return toLoginResult(data);
  },

  register: async (input: RegisterInput | Record<string, unknown>): Promise<LoginResult> => {
    const { data } = await api.post('/auth/register', input);
    return toLoginResult(data);
  },

  /**
   * Revokes THIS device's refresh token server-side. Best-effort by design
   * at the call site: signing out must succeed locally even offline.
   */
  logout: async (refreshToken: string | null): Promise<void> => {
    await api.post('/auth/logout', { refreshToken: refreshToken ?? undefined });
  },

  me: async (): Promise<AuthUser> => {
    const { data } = await api.get('/auth/me');
    const user = toAuthUser(payload(data));
    if (!user) throw new Error('Could not load your profile.');
    return user;
  },

  /**
   * Close a read-only "View As User" session. The one POST the interceptor
   * lets an impersonation token make — see api/client.
   */
  endImpersonation: async (): Promise<{ durationSec: number | null }> => {
    const { data } = await api.post('/auth/impersonation/end');
    const d = record(payload(data));
    return { durationSec: typeof d.durationSec === 'number' ? d.durationSec : null };
  },

  /* ── Password ──────────────────────────────────────────────────────── */

  /**
   * Profile → Security. Sends this device's refresh token so the server
   * keeps THIS session and signs out every other one — Profile.jsx:585.
   * Without it the user would be signed out of the phone they just used.
   */
  changePassword: async (currentPassword: string, newPassword: string): Promise<string> => {
    const { data } = await api.post('/auth/change-password', {
      currentPassword,
      newPassword,
      keepRefreshToken: getRefreshToken() ?? undefined,
    });
    return str(record(payload(data)).message) || 'Password changed successfully.';
  },

  /**
   * Forgot password, step 1: email a 6-digit code. The answer is the same
   * whether or not the account exists, so it cannot be used to probe for
   * accounts — show the server's wording.
   */
  forgotPassword: async (email: string): Promise<string> => {
    const { data } = await api.post('/auth/forgot-password', { email });
    return str(record(payload(data)).message)
      || 'If an account exists for this email, an OTP has been sent.';
  },

  /** Step 2: trade the code for a short-lived reset ticket. */
  verifyResetOtp: async (email: string, otp: string): Promise<string> => {
    const { data } = await api.post('/auth/verify-reset-otp', { email, otp });
    const resetToken = str(record(payload(data)).resetToken);
    if (!resetToken) throw new Error('Could not verify the code. Please request a new one.');
    return resetToken;
  },

  /** Step 3. RESET_TOKEN_INVALID / RESET_NOT_VERIFIED mean start again from step 1. */
  resetPasswordWithOtp: async (resetToken: string, newPassword: string): Promise<string> => {
    const { data } = await api.post('/auth/reset-password', { resetToken, newPassword });
    return str(record(payload(data)).message)
      || 'Password updated. Please log in with your new password.';
  },

  /** The emailed-link reset (ResetPassword.jsx): a token from the link. */
  confirmPasswordReset: async (token: string, newPassword: string): Promise<void> => {
    await api.post('/auth/password-reset/confirm', { token, newPassword });
  },

  /* ── Email verification ────────────────────────────────────────────── */

  verifyEmail: async (token: string): Promise<void> => {
    await api.post('/auth/verify-email', { token });
  },

  /** `alreadyVerified` lets the screen refresh the user instead of claiming an email went out. */
  resendVerification: async (): Promise<{ alreadyVerified: boolean }> => {
    const { data } = await api.post('/auth/resend-verification');
    return { alreadyVerified: record(payload(data)).alreadyVerified === true };
  },

  /* ── Sessions ──────────────────────────────────────────────────────── */

  /** The caller's sessions, this one (`current`) first. */
  listDevices: async (): Promise<SessionDevice[]> => {
    const { data } = await api.get('/auth/devices');
    return rows<unknown>(data).map(toSessionDevice);
  },

  /** By session id. Its access token stops working on its next request. */
  revokeDevice: async (deviceId: string): Promise<void> => {
    await api.delete(`/auth/devices/${encodeURIComponent(deviceId)}`);
  },
};

/* ── Error readers the auth screens branch on ─────────────────────────── */

/**
 * Which register field an error belongs to, so the screen can put the
 * message under the field rather than only in a toast. Register.jsx.
 */
export const registerErrorField = (err: unknown): 'email' | 'phone' | 'referralCode' | null => {
  switch (errorCode(err)) {
    case 'DUPLICATE_EMAIL': return 'email';
    case 'DUPLICATE_PHONE': return 'phone';
    case 'INVALID_REFERRAL_CODE':
    case 'REFERRER_BLOCKED': return 'referralCode';
    default: return null;
  }
};

/** The OTP reset ticket is dead — send the user back to step 1. ForgotPassword.jsx. */
export const isResetSessionExpired = (err: unknown): boolean => {
  const code = errorCode(err);
  return code === 'RESET_TOKEN_INVALID' || code === 'RESET_NOT_VERIFIED';
};
