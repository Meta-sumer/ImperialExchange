/**
 * Every account / auth / money call goes to the endpoint the web client
 * uses, with the body the backend reads — pinned against a recording
 * adapter, so no request leaves the process.
 *
 * What this guards is drift: a renamed field in a body is a silent 400 on a
 * phone that nobody sees until a deposit fails.
 */
import fs from 'fs';
import path from 'path';

import type { InternalAxiosRequestConfig } from 'axios';

import { accountApi } from '@/api/account.api';
import { authApi } from '@/api/auth.api';
import { api } from '@/api/client';
import { complianceApi } from '@/api/compliance.api';
import { subscriptionApi } from '@/api/subscription.api';
import { userApi } from '@/api/user.api';
import { walletApi } from '@/api/wallet.api';
import { clearTokens, setTokens } from '@/services/tokenStore';
import { BONUS_WALLET_ID } from '@/types/wallet';

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});

interface Call {
  method: string;
  url: string;
  params: Record<string, unknown> | undefined;
  body: unknown;
  timeout: number | undefined;
}

const calls: Call[] = [];
let reply: (c: Call) => unknown = () => ({ success: true, data: {} });

const last = (): Call => {
  const c = calls[calls.length - 1];
  if (!c) throw new Error('no request was made');
  return c;
};

beforeAll(() => {
  api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const call: Call = {
      method: String(config.method ?? 'get').toUpperCase(),
      url: config.url ?? '',
      params: config.params as Record<string, unknown> | undefined,
      body: typeof config.data === 'string' ? JSON.parse(config.data) : config.data,
      timeout: config.timeout,
    };
    calls.push(call);
    return { data: reply(call), status: 200, statusText: 'OK', headers: {}, config };
  };
});

beforeEach(() => {
  calls.length = 0;
  reply = () => ({ success: true, data: {} });
});

/* ══ /auth ═════════════════════════════════════════════════════════════ */

describe('authApi', () => {
  const session = {
    success: true,
    data: { user: { _id: 'u1', email: 'a@b.c', role: 'USER' }, accessToken: 'AT', refreshToken: 'RT' },
  };

  it('signs in with email and password only', async () => {
    reply = () => session;
    const res = await authApi.login({ email: 'a@b.c', password: 'pw' });
    expect(last()).toMatchObject({ method: 'POST', url: '/auth/login', body: { email: 'a@b.c', password: 'pw' } });
    expect(last().body).not.toHaveProperty('twoFactorCode');
    expect(res).toMatchObject({ accessToken: 'AT', refreshToken: 'RT', user: { id: 'u1' } });
  });

  it('refuses a 200 that carries no session', async () => {
    reply = () => ({ success: true, data: { user: { _id: 'u1', email: 'a@b.c' } } });
    await expect(authApi.login({ email: 'a@b.c', password: 'pw' })).rejects.toThrow(/no session/);
  });

  it('registers with the body as given', async () => {
    reply = () => session;
    await authApi.register({ email: 'a@b.c', password: 'pw', country: 'IN', referralCode: 'ASHA10' });
    expect(last()).toMatchObject({ method: 'POST', url: '/auth/register', body: { country: 'IN', referralCode: 'ASHA10' } });
  });

  it('reads /auth/me out of its envelope', async () => {
    reply = () => ({ success: true, data: { _id: 'u1', email: 'a@b.c', role: 'USER' } });
    expect((await authApi.me()).id).toBe('u1');
    expect(last()).toMatchObject({ method: 'GET', url: '/auth/me' });
  });

  it('revokes this device’s refresh token on sign-out', async () => {
    await authApi.logout('RT');
    expect(last()).toMatchObject({ method: 'POST', url: '/auth/logout', body: { refreshToken: 'RT' } });
  });

  it('keeps THIS session when changing the password — Profile.jsx:585', async () => {
    await setTokens('AT', 'RT-this-phone');
    reply = () => ({ success: true, data: { ok: true, message: 'Password changed successfully.' } });
    expect(await authApi.changePassword('old', 'new')).toBe('Password changed successfully.');
    expect(last().body).toEqual({ currentPassword: 'old', newPassword: 'new', keepRefreshToken: 'RT-this-phone' });
    await clearTokens();
  });

  it('runs the three-step OTP reset', async () => {
    reply = () => ({ success: true, data: { ok: true, message: 'If an account exists…' } });
    expect(await authApi.forgotPassword('a@b.c')).toBe('If an account exists…');
    expect(last()).toMatchObject({ url: '/auth/forgot-password', body: { email: 'a@b.c' } });

    reply = () => ({ success: true, data: { verified: true, resetToken: 'RST' } });
    expect(await authApi.verifyResetOtp('a@b.c', '123456')).toBe('RST');
    expect(last()).toMatchObject({ url: '/auth/verify-reset-otp', body: { email: 'a@b.c', otp: '123456' } });

    reply = () => ({ success: true, data: { ok: true } });
    await authApi.resetPasswordWithOtp('RST', 'N3w!pass');
    expect(last()).toMatchObject({ url: '/auth/reset-password', body: { resetToken: 'RST', newPassword: 'N3w!pass' } });
  });

  it('refuses a verified OTP that came back without a ticket', async () => {
    reply = () => ({ success: true, data: { verified: true } });
    await expect(authApi.verifyResetOtp('a@b.c', '1')).rejects.toThrow();
  });

  it('confirms an emailed reset link and an email verification', async () => {
    await authApi.confirmPasswordReset('TOK', 'pw');
    expect(last()).toMatchObject({ url: '/auth/password-reset/confirm', body: { token: 'TOK', newPassword: 'pw' } });
    await authApi.verifyEmail('VTOK');
    expect(last()).toMatchObject({ url: '/auth/verify-email', body: { token: 'VTOK' } });
    reply = () => ({ success: true, data: { ok: true, alreadyVerified: true } });
    expect(await authApi.resendVerification()).toEqual({ alreadyVerified: true });
    expect(last()).toMatchObject({ method: 'POST', url: '/auth/resend-verification' });
  });

  it('lists and revokes devices', async () => {
    reply = () => ({ success: true, data: [{ id: 'd1', deviceInfo: 'okhttp' }] });
    expect(await authApi.listDevices()).toEqual([{ id: 'd1', deviceInfo: 'okhttp', createdAt: null, lastSeenAt: null, current: false }]);
    await authApi.revokeDevice('d1');
    expect(last()).toMatchObject({ method: 'DELETE', url: '/auth/devices/d1' });
  });

  it('ends an impersonation session', async () => {
    reply = () => ({ success: true, data: { ok: true, durationSec: 42 } });
    expect(await authApi.endImpersonation()).toEqual({ durationSec: 42 });
    expect(last()).toMatchObject({ method: 'POST', url: '/auth/impersonation/end' });
  });
});

/* ══ /user ═════════════════════════════════════════════════════════════ */

describe('userApi', () => {
  it('updates the profile and returns the saved user', async () => {
    reply = () => ({ success: true, data: { _id: 'u1', email: 'a@b.c', firstName: 'Asha', role: 'USER' } });
    const u = await userApi.updateProfile({ firstName: 'Asha', lastName: 'Rao', phone: '+91' });
    expect(u.firstName).toBe('Asha');
    expect(last()).toMatchObject({ method: 'PUT', url: '/user/profile', body: { firstName: 'Asha', lastName: 'Rao', phone: '+91' } });
  });

  it('asks for leverage per account when there is one', async () => {
    await userApi.getLeverage('a1');
    expect(last()).toMatchObject({ url: '/user/leverage', params: { accountId: 'a1' } });
    await userApi.getLeverage();
    expect(last().params).toEqual({});
  });

  it('registers push, and on sign-out removes exactly the token it registered', async () => {
    await userApi.unregisterCurrentPushToken();
    expect(calls).toHaveLength(0);

    await userApi.registerPushToken('ExponentPushToken[abc]', 'android');
    expect(last()).toMatchObject({ method: 'POST', url: '/user/push-tokens', body: { token: 'ExponentPushToken[abc]', platform: 'android' } });
    expect(userApi.currentPushToken()).toBe('ExponentPushToken[abc]');

    await userApi.unregisterCurrentPushToken();
    expect(last()).toMatchObject({ method: 'DELETE', url: '/user/push-tokens/ExponentPushToken%5Babc%5D' });
    expect(userApi.currentPushToken()).toBeNull();
  });
});

describe('accountApi', () => {
  it('lists accounts, dropping rows without an id', async () => {
    reply = () => ({ success: true, data: [{ _id: 'a1', accountNumber: 'TP1' }, { accountNumber: 'ghost' }] });
    expect((await accountApi.list()).map((a) => a.id)).toEqual(['a1']);
    expect(last()).toMatchObject({ method: 'GET', url: '/user/accounts' });
  });

  it('opens an account and reads the minimum-deposit hint', async () => {
    reply = () => ({
      success: true,
      data: { _id: 'a2', accountType: 'PRO', minDepositHint: { minDeposit: 500, currency: 'INR', needsFunding: true } },
    });
    const a = await accountApi.create({ accountType: 'PRO', leverage: 200, nickname: 'Main' });
    expect(last()).toMatchObject({ method: 'POST', url: '/user/accounts', body: { accountType: 'PRO', leverage: 200, nickname: 'Main' } });
    expect(a.minDepositHint).toEqual({ minDeposit: 500, currency: 'INR', needsFunding: true });
  });

  it('renames with the normalised nickname', async () => {
    reply = () => ({ success: true, data: { _id: 'a1', nickname: 'Swing' } });
    await accountApi.rename('a1', '  Swing  ');
    expect(last()).toMatchObject({ method: 'PATCH', url: '/user/accounts/a1', body: { nickname: 'Swing' } });
  });

  it('lists only active tiers', async () => {
    reply = () => ({ success: true, data: [{ code: 'free' }, { code: 'OLD', isActive: false }, { name: 'no code' }] });
    expect((await accountApi.listPlans()).map((p) => p.code)).toEqual(['FREE']);
    expect(last()).toMatchObject({ method: 'GET', url: '/account-plans' });
  });
});

/* ══ /wallet, /fx ══════════════════════════════════════════════════════ */

describe('walletApi — trading wallets', () => {
  it('reads balances and the ledger', async () => {
    await walletApi.balances('a1');
    expect(last()).toMatchObject({ method: 'GET', url: '/wallet/balances', params: { accountId: 'a1' } });
    await walletApi.balances();
    expect(last().params).toEqual({});
    await walletApi.ledger();
    expect(last()).toMatchObject({ url: '/wallet/ledger', params: { limit: 100 } });
  });

  it('reads deposits under either envelope', async () => {
    reply = () => ({ success: true, data: { deposits: [{ _id: 'd1', amount: '5' }] } });
    expect((await walletApi.deposits()).map((d) => d.id)).toEqual(['d1']);
    reply = () => ({ success: true, data: [{ _id: 'd2' }] });
    expect((await walletApi.deposits()).map((d) => d.id)).toEqual(['d2']);
  });

  it('creates a proofed deposit', async () => {
    reply = () => ({ success: true, data: { _id: 'd3', status: 'PENDING' } });
    const d = await walletApi.createDeposit({
      accountId: 'a1', currency: 'INR', amount: '5000', method: 'UPI', txReference: 'UTR1',
      screenshot: 'data:image/jpeg;base64,QQ==', screenshotMimeType: 'image/jpeg',
    });
    expect(d).toMatchObject({ id: 'd3', status: 'PENDING' });
    expect(last()).toMatchObject({ method: 'POST', url: '/wallet/deposits', body: { method: 'UPI', txReference: 'UTR1' } });
  });

  it('runs the Razorpay order → verify pair', async () => {
    reply = () => ({ success: true, data: { depositId: 'd4', orderId: 'order_9', amount: 1000, currency: 'INR', keyId: 'rzp' } });
    expect((await walletApi.razorpayOrder({ accountId: 'a1', amount: '1000', currency: 'INR' })).orderId).toBe('order_9');
    expect(last()).toMatchObject({ url: '/wallet/razorpay/order', body: { accountId: 'a1', amount: '1000', currency: 'INR' } });
    reply = () => ({ success: true, data: { depositId: 'd4', status: 'COMPLETED', alreadyCredited: true } });
    expect(await walletApi.razorpayVerify({ orderId: 'order_9', paymentId: 'pay_1', signature: 'sig' }))
      .toEqual({ depositId: 'd4', status: 'COMPLETED', alreadyCredited: true });
    expect(last()).toMatchObject({ url: '/wallet/razorpay/verify', body: { orderId: 'order_9', paymentId: 'pay_1', signature: 'sig' } });
  });

  it('requests a withdrawal naming only the verified method', async () => {
    reply = () => ({ success: true, data: { _id: 'w1', status: 'PENDING', amount: '50' } });
    await walletApi.createWithdrawal({ accountId: 'a1', currency: 'INR', amount: '50', withdrawalMethodId: 'm1', method: 'UPI' });
    expect(last().body).toEqual({ accountId: 'a1', currency: 'INR', amount: '50', withdrawalMethodId: 'm1', method: 'UPI' });
    await walletApi.withdrawals();
    expect(last()).toMatchObject({ method: 'GET', url: '/wallet/withdrawals' });
  });

  // EquityHub mounts the payout destinations at /api/withdrawal-methods
  // (server.js), not under /wallet — WithdrawalMethods.jsx calls the same.
  it('manages payout destinations', async () => {
    await walletApi.withdrawalMethods();
    expect(last()).toMatchObject({ method: 'GET', url: '/withdrawal-methods' });
    await walletApi.withdrawalMethod('m1');
    expect(last()).toMatchObject({ method: 'GET', url: '/withdrawal-methods/m1' });
    await walletApi.addWithdrawalMethod({ type: 'UPI', upiId: 'me@okaxis', label: 'Main UPI' });
    expect(last()).toMatchObject({ method: 'POST', url: '/withdrawal-methods', body: { type: 'UPI', upiId: 'me@okaxis' } });
    await walletApi.removeWithdrawalMethod('m1');
    expect(last()).toMatchObject({ method: 'DELETE', url: '/withdrawal-methods/m1' });
  });

  // INR only: EquityHub has no /wallet/convert (routes/wallet.js), so the app
  // has no convert call.
  it('moves money between own wallets', async () => {
    reply = () => ({ success: true, data: { ok: true, from: 'a1', to: 'bonus', amount: '10', currency: 'INR' } });
    expect(await walletApi.transfer({ fromAccountId: 'a1', toAccountId: BONUS_WALLET_ID, currency: 'INR', amount: '10' }))
      .toEqual({ from: 'a1', to: 'bonus', amount: '10', currency: 'INR' });
    expect(last()).toMatchObject({ url: '/wallet/transfers', body: { toAccountId: 'bonus' } });
    expect((walletApi as Record<string, unknown>).convert).toBeUndefined();
  });

  it('searches recipients by public User ID, as the web does', async () => {
    reply = () => ({ success: true, data: [{ _id: 'u2', name: 'Jane' }] });
    await walletApi.searchRecipients('USR1');
    expect(last()).toMatchObject({ url: '/wallet/recipients/search', params: { q: 'USR1', limit: 8, by: 'uid' } });
    await walletApi.searchRecipients('jane', { byUid: false, limit: 3 });
    expect(last().params).toEqual({ q: 'jane', limit: 3 });
  });

  it('sends to another user, dropping an empty note', async () => {
    await walletApi.peerTransferSettings();
    expect(last()).toMatchObject({ method: 'GET', url: '/wallet/transfer-user/settings' });
    await walletApi.transferToUser({ fromAccountId: 'a1', currency: 'INR', amount: '10', note: '   ', recipientUserId: 'u2' });
    expect(last()).toMatchObject({ method: 'POST', url: '/wallet/transfer-user' });
    expect(last().body).toEqual({ fromAccountId: 'a1', currency: 'INR', amount: '10', recipientUserId: 'u2' });
  });

  it('reads the unenveloped USD/INR rate with the web’s 8s ceiling', async () => {
    reply = () => ({ rate: 88.4, source: 'yahoo', ts: 5 });
    expect(await walletApi.usdInr()).toEqual({ rate: 88.4, source: 'yahoo', ts: 5 });
    expect(last()).toMatchObject({ url: '/fx/usdinr', timeout: 8000 });
  });
});

describe('walletApi — the Main Wallet (the Main Wallet is retired)', () => {
  it('adds funds to the Main Wallet — instantly from a live account, or by proof', async () => {
    reply = () => ({ success: true, data: { wallet: { _id: 'bw', balance: '30' } } });
    expect((await walletApi.bonusDeposit({ amount: 10, sourceAccountId: 'a1' })).balance).toBe('30');
    expect(last()).toMatchObject({ method: 'POST', url: '/bonus-wallet/deposit', body: { amount: 10, sourceAccountId: 'a1' } });

    reply = () => ({ success: true, data: { depositId: 'd9', status: 'PENDING', amount: '10', currency: 'INR', method: 'UPI' } });
    expect(await walletApi.bonusManualDeposit({ amount: 10, currency: 'INR', method: 'UPI', txReference: 'UTR', screenshot: 'data:image/png;base64,QQ==' }))
      .toMatchObject({ depositId: 'd9', status: 'PENDING' });
    expect(last()).toMatchObject({ method: 'POST', url: '/bonus-wallet/manual-deposit', body: { txReference: 'UTR' } });
  });

  it('never calls a Main Wallet endpoint', () => {
    const names = Object.keys(walletApi);
    expect(names).not.toEqual(expect.arrayContaining(['mainWallet']));
    expect(names.filter((n) => /main/i.test(n))).toEqual([]);
    const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'wallet.api.ts'), 'utf8');
    expect(src).not.toMatch(/api\.(get|post)\('\/subscription-wallet/);
  });

  it('withdraws from the Main Wallet by method id only', async () => {
    reply = () => ({ success: true, data: { withdrawalId: 'w5', status: 'PENDING', amount: '5', currency: 'INR', balance: '15' } });
    expect(await walletApi.bonusWithdraw({ amount: 5, withdrawalMethodId: 'm1' }))
      .toMatchObject({ withdrawalId: 'w5', balance: '15' });
    expect(last()).toMatchObject({ url: '/bonus-wallet/withdraw', body: { amount: 5, withdrawalMethodId: 'm1' } });
  });

  it('toggles plan auto-renew on the Main Wallet', async () => {
    reply = () => ({ success: true, data: { autoRenew: true } });
    expect(await walletApi.setBonusAutoRenew(true)).toBe(true);
    expect(last()).toMatchObject({ url: '/bonus-wallet/auto-renew', body: { enabled: true } });
  });

  it('reads the Main Wallet and its history', async () => {
    await walletApi.bonusWallet();
    expect(last()).toMatchObject({ method: 'GET', url: '/bonus-wallet' });
    await walletApi.bonusHistory();
    expect(last()).toMatchObject({ url: '/bonus-wallet/history', params: { limit: 100 } });
  });
});

/* ══ /subscriptions ════════════════════════════════════════════════════ */

describe('subscriptionApi', () => {
  it('reads the catalogue and the current subscription', async () => {
    reply = () => ({ success: true, data: [{ code: 'FREE' }, { name: 'nameless' }] });
    expect((await subscriptionApi.plans()).map((p) => p.code)).toEqual(['FREE']);
    expect(last()).toMatchObject({ method: 'GET', url: '/subscriptions/plans' });
    await subscriptionApi.me();
    expect(last()).toMatchObject({ method: 'GET', url: '/subscriptions/me' });
  });

  it('subscribes (billed from the Main Wallet) and cancels with the web’s reason', async () => {
    reply = () => ({ success: true, data: { _id: 's1', planCode: 'VIP' } });
    expect((await subscriptionApi.subscribe({ planCode: 'VIP', billingCycle: 'YEARLY' }))?.planCode).toBe('VIP');
    expect(last()).toMatchObject({ url: '/subscriptions/subscribe' });
    // subscriptionController.subscribe reads `planCode, billingCycle` only.
    expect(last().body).toEqual({ planCode: 'VIP', billingCycle: 'YEARLY' });
    await subscriptionApi.cancel();
    expect(last()).toMatchObject({ url: '/subscriptions/cancel', body: { reason: 'User requested' } });
  });

  it('renews and reads the billing history', async () => {
    reply = () => ({ success: true, data: { subscription: { _id: 's1', planCode: 'VIP' } } });
    expect((await subscriptionApi.renew('VIP'))?.planCode).toBe('VIP');
    expect(last()).toMatchObject({ url: '/subscriptions/renew', body: { planCode: 'VIP', billingCycle: 'MONTHLY' } });
    await subscriptionApi.history({ type: 'DEBIT' });
    expect(last()).toMatchObject({ url: '/subscriptions/history', params: { limit: 100, type: 'DEBIT' } });
  });
});

/* ══ /compliance ═══════════════════════════════════════════════════════ */

describe('complianceApi', () => {
  it('uploads bare base64 and lists documents', async () => {
    reply = () => ({ success: true, data: { id: 'k1', status: 'PENDING' } });
    expect(await complianceApi.uploadKycDocument({
      docType: 'ID_FRONT', filename: 'id.jpg', mimeType: 'image/jpeg', dataBase64: 'data:image/jpeg;base64,QUJD',
    })).toEqual({ id: 'k1', status: 'PENDING' });
    expect(last()).toMatchObject({
      method: 'POST', url: '/compliance/kyc/documents',
      body: { docType: 'ID_FRONT', filename: 'id.jpg', mimeType: 'image/jpeg', dataBase64: 'QUJD' },
    });
    reply = () => ({ success: true, data: [{ _id: 'k1', docType: 'ID_FRONT', status: 'PENDING' }] });
    expect((await complianceApi.kycDocuments()).map((d) => d.id)).toEqual(['k1']);
  });
});
