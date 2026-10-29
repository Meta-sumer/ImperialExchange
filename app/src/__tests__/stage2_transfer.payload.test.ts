/**
 * What Transfer Funds sends, and where — checked against the SERVER'S source.
 *
 * Each body is built by the view's own payload builders (utils/transferLogic),
 * posted through the real api module over a recording adapter (no request
 * leaves the process), and compared with the names the backend controller
 * destructures from `req.body` / `req.query`. A near-miss key is not an
 * error on the wire — the server just never reads it — so only a test that
 * reads both sides catches it.
 */
import fs from 'fs';
import path from 'path';

import type { InternalAxiosRequestConfig } from 'axios';

import { api } from '@/api/client';
import { walletApi } from '@/api/wallet.api';
import { peerTransferPayload, selfTransferPayload } from '@/utils/transferLogic';

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
const CONTROLLER = read('backend/src/controllers/walletController.js');
const ROUTES = read('backend/src/routes/wallet.js');
const SERVICE = read('backend/src/services/userTransferService.js');

/** The names a handler destructures from `req.body` (or `req.query`). */
const destructured = (src: string, handler: string, from: 'body' | 'query'): string[] => {
  const at = src.indexOf(`const ${handler} = asyncHandler`);
  if (at < 0) throw new Error(`handler moved: ${handler}`);
  const m = new RegExp(`const \\{([^}]+)\\} = req\\.${from}`).exec(src.slice(at, at + 4000));
  if (!m?.[1]) throw new Error(`no req.${from} destructure in ${handler}`);
  return m[1]
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join(',')
    .split(',')
    .map((k) => k.trim().split(/[\s=:]/)[0] ?? '')
    .filter(Boolean);
};

interface Call {
  method: string;
  url: string;
  params: Record<string, unknown> | undefined;
  body: Record<string, unknown> | undefined;
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
    };
    calls.push(call);
    return { data: reply(call), status: 200, statusText: 'OK', headers: {}, config };
  };
});

beforeEach(() => {
  calls.length = 0;
  reply = () => ({ success: true, data: {} });
});

const expectAllRead = (sent: Record<string, unknown> | undefined, read: string[]): void => {
  for (const k of Object.keys(sent ?? {})) {
    expect({ key: k, readByServer: read.includes(k) }).toEqual({ key: k, readByServer: true });
  }
};

describe('POST /wallet/transfers — between my accounts', () => {
  const READ = destructured(CONTROLLER, 'internalTransfer', 'body');

  it('the route exists and reads the four fields the web sends', () => {
    expect(ROUTES).toContain("router.post('/transfers', c.internalTransfer);");
    expect(READ).toEqual(expect.arrayContaining(['fromAccountId', 'toAccountId', 'currency', 'amount']));
  });

  it.each([
    ['account → account', 'a1', 'a2'],
    ['live account → Main Wallet', 'a1', 'bonus'],
    ['Main Wallet → account', 'bonus', 'a1'],
    ['demo → demo', 'd1', 'd2'],
  ])('%s: every key is one the server reads, and all it requires is there', async (_label, from, to) => {
    const currency = 'INR';
    reply = () => ({ success: true, data: { ok: true, from, to, amount: '25.5', currency } });
    const res = await walletApi.transfer(selfTransferPayload({ from, to, amount: '25.50' }));
    const c = last();
    expect(c).toMatchObject({ method: 'POST', url: '/wallet/transfers' });
    expectAllRead(c.body, READ);
    expect(c.body).toEqual({ fromAccountId: from, toAccountId: to, currency, amount: '25.50' });
    // The server's own figure comes back; nothing is recomputed here.
    expect(res).toEqual({ from, to, amount: '25.5', currency });
  });

  it('the Main Wallet is the literal id the controller dispatches on', () => {
    expect(CONTROLLER).toContain("const isBonusFrom = String(fromAccountId) === 'bonus';");
    expect(CONTROLLER).toContain("const isBonusTo   = String(toAccountId)   === 'bonus';");
  });

  it('the server refuses the retired Main Wallet (410) and any demo / live mix — the pickers never offer either', () => {
    const fn = CONTROLLER.slice(CONTROLLER.indexOf('const internalTransfer = asyncHandler'));
    const body = fn.slice(0, fn.indexOf('\nconst '));
    expect(body.slice(0, body.indexOf("'MAIN_WALLET_RETIRED'"))).toContain('if (isSubFrom || isSubTo) {');
    expect(body.slice(0, body.indexOf("'PRACTICE_TRANSFER_NOT_ALLOWED'"))).toContain('if (isPractice(from) !== isPractice(to)) {');
    // The Bonus Wallet receives transfers again.
    expect(body).not.toContain('BONUS_WALLET_WITHDRAW_ONLY');
  });
});

describe('POST /wallet/transfer-user — to another user', () => {
  const READ = destructured(CONTROLLER, 'transferToUser', 'body');

  it('the route exists and names the recipient by id', () => {
    // EquityHub has no broker feature switch in front of it.
    expect(ROUTES).toContain("router.post('/transfer-user',          c.transferToUser);");
    expect(READ).toEqual(expect.arrayContaining(['fromAccountId', 'currency', 'amount', 'note', 'recipientUserId']));
  });

  it('with a note: every key is read by the server', async () => {
    reply = () => ({
      success: true,
      data: { referenceId: 'r1', toUserId: 'u2', recipient: { name: 'Jane Doe' }, currency: 'INR', amount: '50', fee: '0.75', totalDebited: '50.75' },
    });
    const res = await walletApi.transferToUser(peerTransferPayload({ from: 'a1', amount: '50.00', note: ' Rent ', recipientUserId: 'u2' }));
    const c = last();
    expect(c).toMatchObject({ method: 'POST', url: '/wallet/transfer-user' });
    expectAllRead(c.body, READ);
    expect(c.body).toEqual({ fromAccountId: 'a1', currency: 'INR', amount: '50', note: 'Rent', recipientUserId: 'u2' });
    expect(res).toMatchObject({ referenceId: 'r1', recipientName: 'Jane Doe', fee: '0.75', totalDebited: '50.75' });
  });

  it('a blank note is not sent at all', async () => {
    await walletApi.transferToUser(peerTransferPayload({ from: 'a2', amount: '10', note: '   ', recipientUserId: 'u2' }));
    expect(last().body).toEqual({ fromAccountId: 'a2', currency: 'INR', amount: '10', recipientUserId: 'u2' });
    expectAllRead(last().body, READ);
  });

  it('the source is one of the sender\'s LIVE trading accounts; the recipient receives in their primary live account', () => {
    expect(SERVICE).toContain("if (String(fromAccountId) === 'subscription') {");
    expect(SERVICE).toContain("'MAIN_WALLET_RETIRED'");
    expect(SERVICE).toContain("const fromAcct = await TradingAccount.findOne({ _id: fromAccountId, userId: fromUserId, isActive: true }).lean();");
    expect(SERVICE).toContain("'PRACTICE_TRANSFER_NOT_ALLOWED'");
    expect(SERVICE).toContain("userId: recipientDoc._id, isActive: true, accountType: { $nin: PRACTICE },");
    expect(SERVICE).toContain("'RECIPIENT_NO_LIVE_ACCOUNT'");
    expect(SERVICE).not.toContain("=== 'bonus'");
  });
});

describe('GET helpers the panel reads', () => {
  it('recipient search sends q, limit 8 and by=uid — what searchTransferRecipients reads', async () => {
    reply = () => ({ success: true, data: [{ _id: 'u2', name: 'Jane Doe', email: 'j@d.co', userUid: 'USR100245', avatarUrl: null }] });
    const rows = await walletApi.searchRecipients('USR1', { limit: 8 });
    const c = last();
    expect(c).toMatchObject({ method: 'GET', url: '/wallet/recipients/search', params: { q: 'USR1', limit: 8, by: 'uid' } });
    expectAllRead(c.params, destructured(CONTROLLER, 'searchTransferRecipients', 'query'));
    expect(ROUTES).toContain("router.get ('/recipients/search',     c.searchTransferRecipients);");
    expect(rows).toEqual([{ id: 'u2', name: 'Jane Doe', email: 'j@d.co', userUid: 'USR100245', referralCode: null, avatarUrl: null }]);
  });

  it('settings read the admin strings the server sends', async () => {
    reply = () => ({ success: true, data: { enabled: false, min: '10', max: '500', feePercent: '1.5' } });
    expect(await walletApi.peerTransferSettings()).toEqual({ enabled: false, min: '10', max: '500', feePercent: '1.5' });
    expect(last()).toMatchObject({ method: 'GET', url: '/wallet/transfer-user/settings' });
    expect(ROUTES).toContain("router.get ('/transfer-user/settings', c.getUserTransferSettings);");
    expect(CONTROLLER).toContain("enabled:    cfg['userTransfer.enabled'] !== false,");
  });

  it('the Main Wallet snapshot comes from the endpoint the web reads', async () => {
    reply = (c) => ({ success: true, data: { _id: 'w', balance: c.url === '/bonus-wallet' ? '10' : '75.5', currency: 'INR' } });
    expect((await walletApi.bonusWallet()).balance).toBe('10');
    expect(last().url).toBe('/bonus-wallet');
    expect((await walletApi.balances()).length).toBe(0);
    expect(last()).toMatchObject({ method: 'GET', url: '/wallet/balances' });
  });
});
