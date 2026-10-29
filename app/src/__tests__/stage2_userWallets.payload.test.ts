/**
 * What the Bonus Wallet screen sends, and where — checked against the
 * SERVER'S source. The Main Wallet is retired: its money endpoints answer
 * 410 MAIN_WALLET_RETIRED and the app calls none of them.
 *
 * Each body is built by the screen's own builder, posted through the real API
 * module against a recording adapter (nothing leaves the process), and every
 * key is checked against the names the backend controller reads from
 * `req.body`. A near-miss key is not an error on the wire; the server just
 * never reads it — only a test that reads both sides catches that.
 */
import fs from 'fs';
import path from 'path';

import type { InternalAxiosRequestConfig } from 'axios';

import { api } from '@/api/client';
import { walletApi } from '@/api/wallet.api';
import { TOPUP_FIXED_METHODS, instantTopUpBody, manualDepositBody, topUpMethods, withdrawBody } from '@/utils/userWallets';
import type { TopUpMethod } from '@/utils/userWallets';

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});

const ROOT = path.join(__dirname, '../../..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const SUB = read('backend/src/controllers/subscriptionWalletController.js');
const BONUS = read('backend/src/controllers/bonusWalletController.js');
const SUB_ROUTES = read('backend/src/routes/subscriptionWallet.js');
const BONUS_ROUTES = read('backend/src/routes/bonusWallet.js');

/** The handler's source, from its declaration to the next top-level handler. */
const handler = (src: string, name: string): string => {
  const at = src.indexOf(`const ${name} = asyncHandler`);
  if (at < 0) throw new Error(`handler moved: ${name}`);
  const next = src.indexOf('\nconst ', at + 10);
  return src.slice(at, next < 0 ? undefined : next);
};

/** Every key the handler takes from the body: the destructure and `req.body.x`. */
const bodyKeys = (src: string, name: string): string[] => {
  const h = handler(src, name);
  const keys = new Set<string>();
  const m = /const \{([^}]+)\} = req\.body/.exec(h);
  if (m?.[1]) {
    for (const part of m[1].split('\n').map((l) => l.replace(/\/\/.*$/, '')).join(',').split(',')) {
      const k = part.trim().split(/[\s=:]/)[0];
      if (k) keys.add(k);
    }
  }
  for (const d of h.matchAll(/req\.body\.(\w+)/g)) if (d[1]) keys.add(d[1]);
  return [...keys];
};

interface Call { method: string; url: string; params: unknown; body: Record<string, unknown> }
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
      params: config.params,
      body: typeof config.data === 'string' ? JSON.parse(config.data) : (config.data ?? {}),
    };
    calls.push(call);
    return { data: reply(call), status: 200, statusText: 'OK', headers: {}, config };
  };
});

beforeEach(() => {
  calls.length = 0;
  reply = () => ({ success: true, data: {} });
});

const expectReadByServer = (body: Record<string, unknown>, keys: string[]): void => {
  for (const k of Object.keys(body)) {
    expect({ key: k, readByServer: keys.includes(k) }).toEqual({ key: k, readByServer: true });
  }
};

describe('the routes exist', () => {
  it.each([
    ["router.get('/', authenticate, c.getWallet)", BONUS_ROUTES],
    ["router.get('/history', authenticate, c.history)", BONUS_ROUTES],
    // EquityHub has no broker feature switch in front of these.
    ["router.post('/deposit', authenticate, c.deposit)", BONUS_ROUTES],
    ["router.post('/manual-deposit', authenticate, c.manualDeposit)", BONUS_ROUTES],
    ["router.post('/withdraw', authenticate, c.requestWithdrawal)", BONUS_ROUTES],
    ["router.post('/auto-renew', authenticate, c.toggleAutoRenew)", BONUS_ROUTES],
  ])('%s', (line, src) => {
    expect(src).toContain(line);
  });
});

describe('the Main Wallet is retired', () => {
  it.each(['deposit', 'manualDeposit', 'requestWithdrawal'])('subscriptionWalletController.%s refuses first (410 MAIN_WALLET_RETIRED)', (name) => {
    expect(SUB).toContain("'MAIN_WALLET_RETIRED'");
    expect(SUB).toContain('410,');
    const h = handler(SUB, name);
    expect(h.indexOf('_assertRetired();')).toBeGreaterThan(-1);
    const body = h.indexOf('req.body');
    if (body >= 0) expect(h.indexOf('_assertRetired();')).toBeLessThan(body);
    // The route is still mounted (an old client gets the clear message).
    expect(SUB_ROUTES).toContain(`c.${name})`);
  });

  it('no app module posts to /subscription-wallet', () => {
    for (const f of ['api/wallet.api.ts', 'api/subscription.api.ts']) {
      expect(read(`app/src/${f}`)).not.toMatch(/'\/subscription-wallet/);
    }
  });
});

describe('Main Wallet — Add Funds', () => {
  it('the instant transfer posts { amount, sourceAccountId } — both read by bonusWalletController.deposit', async () => {
    const keys = bodyKeys(BONUS, 'deposit');
    expect(keys).toEqual(expect.arrayContaining(['amount', 'sourceAccountId']));
    const body = instantTopUpBody('25.5', 'acc1');
    expectReadByServer(body, keys);
    expect(body).not.toHaveProperty('paymentMethod');
    expect(body).not.toHaveProperty('paymentRef');
    // Practice money never becomes Bonus Wallet money — the server refuses a
    // demo source, and the sheet only lists live accounts.
    expect(handler(BONUS, 'deposit')).toContain("'PRACTICE_TRANSFER_NOT_ALLOWED'");
    expect(handler(BONUS, 'deposit')).toContain("'INSUFFICIENT_TRADING_BALANCE'");

    reply = () => ({ success: true, data: { wallet: { balance: '125.5', currency: 'INR' } } });
    const w = await walletApi.bonusDeposit(body);
    expect(last()).toMatchObject({ method: 'POST', url: '/bonus-wallet/deposit', body: { amount: 25.5, sourceAccountId: 'acc1' } });
    expect(w.balance).toBe('125.5');
  });

  it('a manual deposit posts only keys manualDeposit destructures, with the proof and reference it requires', async () => {
    const keys = bodyKeys(BONUS, 'manualDeposit');
    const upi = TOPUP_FIXED_METHODS[0] as TopUpMethod;
    const body = manualDepositBody({
      method: upi,
      amount: '1500',
      txReference: ' UTR12345 ',
      senderName: 'Ravi',
      senderUpiId: 'ravi@okhdfc',
      senderBankAccount: '',
      screenshot: 'data:image/jpeg;base64,AAAA',
      screenshotMimeType: 'image/jpeg',
    });
    expectReadByServer(body as unknown as Record<string, unknown>, keys);
    // The server's own required fields (manualDeposit refuses without them).
    expect(handler(BONUS, 'manualDeposit')).toContain("throw new AppError('Transaction reference is required', 400)");
    expect(handler(BONUS, 'manualDeposit')).toContain("throw new AppError('Payment proof screenshot is required', 400)");
    expect(body).toMatchObject({ amount: 1500, currency: 'INR', method: 'UPI', txReference: 'UTR12345', screenshot: 'data:image/jpeg;base64,AAAA' });

    reply = () => ({ success: true, data: { depositId: 'd1', status: 'PENDING' } });
    const r = await walletApi.bonusManualDeposit(body);
    expect(last()).toMatchObject({ method: 'POST', url: '/bonus-wallet/manual-deposit' });
    expect(last().body).toEqual(JSON.parse(JSON.stringify(body)));
    expect(r).toMatchObject({ depositId: 'd1', status: 'PENDING' });
    // The admin's verification credits the Bonus Wallet.
    expect(handler(BONUS, 'manualDeposit')).toContain("targetWallet: 'bonus'");
  });

  it('a BANK manual deposit sends the last four and no stale UPI ID', () => {
    const keys = bodyKeys(BONUS, 'manualDeposit');
    const bank = TOPUP_FIXED_METHODS[1] as TopUpMethod;
    const body = manualDepositBody({
      method: bank, amount: '1000', txReference: 'NEFT1', senderName: '',
      senderUpiId: 'typed-earlier@ok', senderBankAccount: '1234', screenshot: 'data:x', screenshotMimeType: 'image/png',
    });
    expectReadByServer(body as unknown as Record<string, unknown>, keys);
    expect(body).toMatchObject({ method: 'BANK', senderBankAccount: '1234' });
    expect(body).not.toHaveProperty('senderUpiId');
    expect(body).not.toHaveProperty('senderName');
  });

  it('the payment settings come from GET /wallet/deposit-details, each rail with the admin\'s own limits', async () => {
    reply = () => ({
      success: true,
      data: {
        UPI: { upiId: 'a@b', enabled: true, minDeposit: 500, maxDeposit: 100000 },
        BANK: { enabled: false },
        custom: [{ id: 'cash', label: 'Cash', minDeposit: 2500, fields: [] }, { id: 'zero', label: 'Zero', fields: [] }, { label: '' }],
      },
    });
    const r = await walletApi.depositDetails();
    expect(last()).toMatchObject({ method: 'GET', url: '/wallet/deposit-details' });
    const methods = topUpMethods(r, 'ready');
    expect(methods.map((m) => m.id)).toEqual(['UPI', 'CUSTOM:cash', 'CUSTOM:zero', 'TRADING']);
    expect(methods.find((m) => m.id === 'UPI')).toMatchObject({ min: 500, max: 100000 });
    expect(methods.find((m) => m.id === 'CUSTOM:cash')?.min).toBe(2500);
    // Nothing configured is no floor — EquityHub has no default minimum.
    expect(methods.find((m) => m.id === 'CUSTOM:zero')?.min).toBe(0);
    // The server applies the same rail switch and limits.
    expect(handler(BONUS, 'manualDeposit')).toContain('await assertMethodAllowed(method);');
    expect(handler(BONUS, 'manualDeposit')).toContain("await assertWithinLimits(method, 'deposit', baseAmount");
  });
});

describe('Main Wallet withdrawals', () => {
  it('{ amount, withdrawalMethodId } — both read by requestWithdrawal', async () => {
    const keys = bodyKeys(BONUS, 'requestWithdrawal');
    expect(keys).toEqual(expect.arrayContaining(['amount', 'withdrawalMethodId']));
    const body = withdrawBody('12.345', 'wm1');
    expectReadByServer(body, keys);
    // No destination leaves the app — the server resolves it from the verified row.
    for (const k of ['upiId', 'bankAccountNumber', 'bankIFSC', 'cryptoAddress', 'destination']) expect(body).not.toHaveProperty(k);

    reply = () => ({ success: true, data: { withdrawalId: 'w1', status: 'PENDING', amount: '12.345', currency: 'INR', balance: '0' } });
    const res = await walletApi.bonusWithdraw(body);
    expect(last()).toMatchObject({ method: 'POST', url: '/bonus-wallet/withdraw', body: { amount: 12.345, withdrawalMethodId: 'wm1' } });
    expect(res).toMatchObject({ withdrawalId: 'w1', status: 'PENDING' });
  });

  it('without a saved, verified method the server refuses (WITHDRAWAL_METHOD_REQUIRED)', () => {
    const h = handler(BONUS, 'requestWithdrawal');
    expect(h).toContain('const savedId = req.body.withdrawalMethodId;');
    expect(h).toContain('resolveSavedMethod(req.userId, savedId)');
    expect(h).toContain("'WITHDRAWAL_METHOD_REQUIRED'");
    // The resolved destination is checked against anything else in the body;
    // the app sends nothing else.
    expect(h).toContain('assertNoConflictingDestination(req.body, M, dest);');
    expect(Object.keys(withdrawBody('10', 'wm1')).sort()).toEqual(['amount', 'withdrawalMethodId']);
  });
});

describe('the Main Wallet takes Add Funds', () => {
  it('neither deposit handler refuses any more, and the screen offers Add Funds', () => {
    for (const name of ['deposit', 'manualDeposit']) {
      expect(handler(BONUS, name)).not.toContain('_assertWithdrawOnly();');
    }
    const screen = read('app/src/screens/wallet/BonusWalletScreen.tsx');
    expect(screen).toContain('<BonusWalletDepositSheet');
    expect(screen).toContain('title="Add Funds"');
  });
});

describe('Auto-renew', () => {
  it('posts { enabled } to the Main Wallet — the one key toggleAutoRenew reads', async () => {
    expect(bodyKeys(BONUS, 'toggleAutoRenew')).toEqual(['enabled']);
    reply = () => ({ success: true, data: { autoRenew: false } });
    expect(await walletApi.setBonusAutoRenew(false)).toBe(false);
    expect(last()).toMatchObject({ method: 'POST', url: '/bonus-wallet/auto-renew', body: { enabled: false } });
  });
});

describe('Reads', () => {
  it('the Main Wallet screen reads the wallet, the last 100 transactions and the subscription', async () => {
    const { subscriptionApi } = jest.requireActual('@/api/subscription.api') as typeof import('@/api/subscription.api');
    await walletApi.bonusWallet();
    expect(last()).toMatchObject({ method: 'GET', url: '/bonus-wallet' });
    await walletApi.bonusHistory(100);
    expect(last()).toMatchObject({ method: 'GET', url: '/bonus-wallet/history', params: { limit: 100 } });
    await subscriptionApi.me();
    expect(last()).toMatchObject({ method: 'GET', url: '/subscriptions/me' });
  });
});
