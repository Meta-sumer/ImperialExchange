/**
 * What the money flows SEND — through the real API module, over a recording
 * axios adapter — checked against the names EQUITYHUB'S SERVER reads.
 *
 * A near-miss key is not an error on the wire: the server just never reads
 * it, and the money goes wherever the default sends it. Only a test that
 * reads both sides catches that. No request leaves the process.
 *
 * Also pinned from the backend source: the server facts the flows are built
 * around — INR only, the practice-withdrawal branch before the verified
 * method gate, the typed-destination refusal, the proof cap, the reference
 * minimum, the Razorpay mock provider, and where /withdrawal-methods lives.
 */
import fs from 'fs';
import path from 'path';

import type { InternalAxiosRequestConfig } from 'axios';

import { api } from '@/api/client';
import { walletApi } from '@/api/wallet.api';
import { PROOF_TARGET } from '@/services/proofImage';
import { toDepositDetails } from '@/types/wallet';
import {
  MAX_UPLOAD_BYTES,
  PROOF_COMPRESS_TARGET,
  PROOF_MAX_DATA_URL,
  TX_REFERENCE_MIN,
  addMethodTypes,
  buildAddMethodBody,
  buildDepositPayload,
  buildWithdrawalPayload,
  depositMethods,
  isLiveRazorpayOrder,
} from '@/utils/fundsFlows';

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
const backend = (p: string): string => read(path.join('backend/src', p));
const web = (p: string): string => read(path.join('client/src', p));

const WALLET = backend('controllers/walletController.js');
const METHODS = backend('controllers/withdrawalMethodController.js');
const PAYMENTS = backend('services/paymentService.js');

/** The source of one `const name = asyncHandler(…)` handler. */
const handler = (src: string, name: string): string => {
  const head = `const ${name} = asyncHandler`;
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`handler moved: ${name}`);
  const next = src.indexOf('= asyncHandler', at + head.length);
  return src.slice(at, next < 0 ? undefined : next);
};

/** The keys a handler destructures from `req.body` (every destructure in it). */
const bodyKeys = (src: string, name: string): string[] => {
  const keys = new Set<string>();
  for (const m of handler(src, name).matchAll(/const \{([^}]+)\} = req\.body/g)) {
    for (const k of (m[1] ?? '')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join(',')
      .split(',')
      .map((x) => x.trim().split(/[\s=:]/)[0] ?? '')
      .filter(Boolean)) keys.add(k);
  }
  if (!keys.size) throw new Error(`no body destructure in ${name}`);
  return [...keys];
};

type Sent = { method: string; url: string; body: Record<string, unknown> };
let sent: Sent[] = [];
const respond = (data: unknown) => { api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
  sent.push({
    method: String(config.method).toUpperCase(),
    url: String(config.url),
    body: typeof config.data === 'string' ? JSON.parse(config.data) as Record<string, unknown> : {},
  });
  return { data: { success: true, data }, status: 200, statusText: 'OK', headers: {}, config };
}; };
beforeEach(() => { sent = []; });

const last = (): Sent => {
  const s = sent[sent.length - 1];
  if (!s) throw new Error('nothing sent');
  return s;
};

/* ══ Deposits ════════════════════════════════════════════════════════ */

describe('POST /wallet/deposits — InlineDepositFlow', () => {
  const read = bodyKeys(WALLET, 'createDeposit');
  const details = toDepositDetails({
    UPI: { upiId: 'pay@okaxis', minDeposit: 500 },
    BANK: { accountNumber: '123' },
    custom: [{ id: 'paytm', label: 'Paytm Wallet', fields: [{ label: 'Number', value: '99' }] }],
  });
  const methods = depositMethods(details);

  it('reads exactly the keys the web sends, plus the note', () => {
    expect(read.sort()).toEqual([
      'accountId', 'amount', 'currency', 'method', 'note', 'screenshot', 'screenshotMimeType',
      'senderBankAccount', 'senderName', 'senderUpiId', 'txReference',
    ].sort());
  });

  it('a live UPI deposit: INR, the rail id, the proof — every key one the server reads', async () => {
    const upi = methods.find((m) => m.id === 'UPI');
    if (!upi) throw new Error('no UPI');
    const body = buildDepositPayload({
      accountId: 'acc1',
      amount: '5000.',
      method: upi,
      txReference: ' UTR123 ',
      senderName: ' Ravi ',
      senderUpiId: 'ravi@ok',
      senderBankAccount: '1234',
      proof: { dataUrl: 'data:image/jpeg;base64,QQ==', mimeType: 'image/jpeg' },
      isReal: true,
    });
    respond({ _id: 'd1', status: 'PENDING' });
    await walletApi.createDeposit(body);
    expect(last()).toMatchObject({ method: 'POST', url: '/wallet/deposits' });
    expect(last().body).toEqual({
      accountId: 'acc1',
      currency: 'INR',
      amount: '5000',
      method: 'UPI',
      txReference: 'UTR123',
      senderName: 'Ravi',
      senderUpiId: 'ravi@ok',
      screenshot: 'data:image/jpeg;base64,QQ==',
      screenshotMimeType: 'image/jpeg',
    });
    for (const k of Object.keys(last().body)) expect(read).toContain(k);
  });

  it('a custom rail posts its LABEL — the server resolves custom rails by label', () => {
    const custom = methods.find((m) => m.id === 'CUSTOM:paytm');
    if (!custom) throw new Error('no custom rail');
    const body = buildDepositPayload({
      accountId: 'a', amount: '10', method: custom, txReference: 'r1234', senderName: 'x', senderUpiId: '', senderBankAccount: '', proof: null, isReal: false,
    });
    expect(body.method).toBe('Paytm Wallet');
    expect(body).not.toHaveProperty('screenshot');
    expect(backend('utils/paymentMethods.js')).toMatch(/all\.find\(\(m\) => _norm\(m\.label\) === want\)/);
  });

  it('the server takes INR and nothing else', () => {
    expect(handler(WALLET, 'createDeposit')).toMatch(/_assertCurrencySupported\(method, depCur\)/);
    expect(WALLET).toMatch(/!== BASE_CURRENCY\) \{\s*throw new AppError\(`Only \$\{BASE_CURRENCY\} is supported`/);
  });

  it('the reference minimum and the proof cap are the server’s', () => {
    expect(handler(WALLET, 'createDeposit')).toMatch(new RegExp(`String\\(txReference\\)\\.trim\\(\\)\\.length < ${TX_REFERENCE_MIN}`));
    expect(WALLET).toMatch(/const SCREENSHOT_MAX_BYTES = 3 \* 1024 \* 1024;/);
    expect(PROOF_MAX_DATA_URL).toBe(3 * 1024 * 1024);
  });

  it('the compression targets are imageCompress.js’s', () => {
    const ic = web('utils/imageCompress.js');
    expect(ic).toMatch(/opts\.maxBytes \|\| 900 \* 1024/);
    expect(ic).toMatch(/MAX_UPLOAD_BYTES = 10 \* 1024 \* 1024/);
    expect(PROOF_COMPRESS_TARGET).toBe(900 * 1024);
    expect(PROOF_TARGET).toBe(PROOF_COMPRESS_TARGET);
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });
});

/* ══ Razorpay ═══════════════════════════════════════════════════════ */

describe('Razorpay', () => {
  it('the order is created with what the server reads', async () => {
    expect(bodyKeys(WALLET, 'createRazorpayOrder').sort()).toEqual(['accountId', 'amount', 'currency']);
    respond({ depositId: 'd', orderId: 'order_1', amount: 500, currency: 'INR', keyId: 'rzp_live_x' });
    await walletApi.razorpayOrder({ accountId: 'a1', currency: 'INR', amount: '500' });
    expect(last()).toMatchObject({ method: 'POST', url: '/wallet/razorpay/order', body: { accountId: 'a1', currency: 'INR', amount: '500' } });
  });

  it('verify sends the three values Checkout returns', async () => {
    expect(bodyKeys(WALLET, 'verifyRazorpayPayment').sort()).toEqual(['orderId', 'paymentId', 'signature']);
    respond({ depositId: 'd', status: 'COMPLETED' });
    await walletApi.razorpayVerify({ orderId: 'o', paymentId: 'p', signature: 's' });
    expect(last()).toMatchObject({ url: '/wallet/razorpay/verify', body: { orderId: 'o', paymentId: 'p', signature: 's' } });
  });

  it('a mock-provider order is never opened: its id starts mock_', () => {
    expect(PAYMENTS).toMatch(/`mock_\$\{Date\.now\(\)\}/);
    expect(isLiveRazorpayOrder({ keyId: 'rzp_x', orderId: 'mock_1_abc' })).toBe(false);
    expect(isLiveRazorpayOrder({ keyId: 'rzp_x', orderId: 'order_abc' })).toBe(true);
    expect(isLiveRazorpayOrder({ keyId: null, orderId: 'order_abc' })).toBe(false);
  });
});

/* ══ Withdrawals ═════════════════════════════════════════════════════ */

describe('POST /wallet/withdrawals — WithdrawView', () => {
  const read = bodyKeys(WALLET, 'requestWithdrawal');
  const src = handler(WALLET, 'requestWithdrawal');

  it('reads accountId, currency, amount, method and the saved method id — no typed destination', () => {
    expect(read.sort()).toEqual(['accountId', 'amount', 'currency', 'method', 'withdrawalMethodId']);
  });

  it('a LIVE payout names the verified method by id and sends no `method`', async () => {
    const body = buildWithdrawalPayload({ accountId: 'a1', amount: '2500.50', isDemo: false, method: 'UPI', withdrawalMethodId: 'wm1' });
    respond({ _id: 'w1', status: 'PENDING' });
    await walletApi.createWithdrawal(body);
    expect(last()).toMatchObject({ method: 'POST', url: '/wallet/withdrawals' });
    expect(last().body).toEqual({ accountId: 'a1', currency: 'INR', amount: '2500.50', withdrawalMethodId: 'wm1' });
    // A `method` that disagrees with the saved method's type is refused as a tamper attempt.
    expect(src).toMatch(/_b\.method && String\(_b\.method\)\.toUpperCase\(\) !== m/);
    expect(src).toMatch(/'ARBITRARY_DESTINATION'/);
  });

  it('a PRACTICE withdrawal sends the rail and no method id — its branch runs before the gate', () => {
    const body = buildWithdrawalPayload({ accountId: 'd1', amount: '100', isDemo: true, method: 'BANK', withdrawalMethodId: 'ignored' });
    expect(body).toEqual({ accountId: 'd1', currency: 'INR', amount: '100', method: 'BANK' });
    const demoBranch = src.indexOf("const isDemoLike = account.accountType === 'DEMO' || account.accountType === 'VIRTUAL';");
    const gate = src.indexOf("'WITHDRAWAL_METHOD_REQUIRED'");
    expect(demoBranch).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(demoBranch);
    expect(src).toMatch(/method: \(method \|\| 'DEMO'\)\.toUpperCase\(\)/);
  });

  it('every key sent is one the server reads', () => {
    for (const isDemo of [true, false]) {
      const body = buildWithdrawalPayload({ accountId: 'a', amount: '1', isDemo, method: 'UPI', withdrawalMethodId: 'm' });
      for (const k of Object.keys(body)) expect(read).toContain(k);
    }
  });
});

/* ══ Withdrawal methods ══════════════════════════════════════════════ */

describe('/withdrawal-methods — WithdrawalMethods.jsx', () => {
  it('is mounted at /api/withdrawal-methods (not under /wallet)', () => {
    expect(backend('server.js')).toMatch(/app\.use\('\/api\/withdrawal-methods', withdrawalMethodRoutes\)/);
    expect(backend('routes/wallet.js')).not.toMatch(/withdrawal-methods/);
  });

  it('list, add and remove go to the routes the server has', async () => {
    respond([]);
    await walletApi.withdrawalMethods();
    expect(last()).toMatchObject({ method: 'GET', url: '/withdrawal-methods' });
    respond({ id: 'm1', type: 'UPI', label: 'Main', status: 'PENDING' });
    await walletApi.addWithdrawalMethod({ type: 'UPI', label: 'Main', upiId: 'me@ok' });
    expect(last()).toMatchObject({ method: 'POST', url: '/withdrawal-methods', body: { type: 'UPI', label: 'Main', upiId: 'me@ok' } });
    respond({ id: 'm1', archived: true });
    await walletApi.removeWithdrawalMethod('m1');
    expect(last()).toMatchObject({ method: 'DELETE', url: '/withdrawal-methods/m1' });
    const routes = backend('routes/withdrawalMethod.js');
    expect(routes).toMatch(/router\.get\('\/', c\.listMethods\)/);
    expect(routes).toMatch(/router\.post\('\/', c\.addMethod\)/);
    expect(routes).toMatch(/router\.delete\('\/:id', c\.deleteMethod\)/);
  });

  it('the bodies use the keys addMethod reads for each type', () => {
    const add = handler(METHODS, 'addMethod');
    const keys = new Set<string>();
    for (const m of add.matchAll(/const \{([^}]+)\} = req\.body/g)) {
      for (const k of (m[1] ?? '').split(',').map((x) => x.trim())) if (k) keys.add(k);
    }
    expect([...keys].sort()).toEqual(['accountHolderName', 'accountNumber', 'bankName', 'details', 'ifsc', 'label', 'methodKey', 'network', 'type', 'upiId', 'walletAddress'].sort());

    const details = toDepositDetails({
      RAZORPAY: { withdrawalFields: [{ label: 'Linked phone' }] },
      custom: [{ id: 'wise', label: 'Wise', withdrawalFields: [{ label: 'Wise email', key: 'email' }, { label: 'Account name' }] }],
    });
    const types = addMethodTypes(details);
    const bank = types.find((x) => x.id === 'BANK');
    const upi = types.find((x) => x.id === 'UPI');
    const wise = types.find((x) => x.id === 'wise');
    const rzp = types.find((x) => x.id === 'RAZORPAY');
    if (!bank || !upi || !wise || !rzp) throw new Error('types missing');

    const bodies = [
      buildAddMethodBody(bank, ' HDFC Salary ', { accountHolderName: 'Ravi K', bankName: 'HDFC', accountNumber: '50100123', ifsc: 'HDFC0001234' }),
      buildAddMethodBody(upi, 'UPI', { upiId: 'ravi@ok' }),
      buildAddMethodBody(wise, 'Wise', { email: ' r@x.io ', account_name: 'Ravi' }),
      buildAddMethodBody(rzp, 'Rzp', { linked_phone: '98' }),
    ];
    for (const b of bodies) for (const k of Object.keys(b)) expect(keys.has(k)).toBe(true);
    expect(bodies[0]).toEqual({ type: 'BANK', label: 'HDFC Salary', accountHolderName: 'Ravi K', bankName: 'HDFC', accountNumber: '50100123', ifsc: 'HDFC0001234' });
    expect(bodies[2]).toEqual({ type: 'CUSTOM', label: 'Wise', methodKey: 'wise', details: { email: 'r@x.io', account_name: 'Ravi' } });
    expect(bodies[3]).toEqual({ type: 'CUSTOM', label: 'Rzp', methodKey: 'RAZORPAY', details: { linked_phone: '98' } });
  });

  it('a label is required server-side (≥ 2 characters), as the form says', () => {
    expect(handler(METHODS, 'addMethod')).toMatch(/String\(label\)\.trim\(\)\.length < 2/);
  });
});
