/**
 * What Plans and the new-account wizard send, and where — checked against
 * the SERVER'S source and the WEB'S source.
 *
 * Every body is posted through the real API module with the transport
 * mocked, then compared with (a) the names the backend controller reads
 * from `req.body` and (b) the keys the web page posts. A near-miss key is
 * not an error on the wire — the server just never reads it and a default
 * decides instead — so only a test that reads both sides catches it.
 */
import fs from 'fs';
import path from 'path';

import { createAccountFromWizard } from '@/api/account.api';
import { api } from '@/api/client';
import { subscriptionApi } from '@/api/subscription.api';
import { ACCOUNT_BASE_CURRENCY, buildNewAccountPayload, DEMO_SEED_INR, UNLIMITED_LEVERAGE } from '@/utils/plans';

const ROOT = path.join(__dirname, '../../..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const backend = (p: string): string => read(path.join('backend/src', p));
const web = (p: string): string => read(path.join('client/src', p));

/** The keys a controller destructures from `req.body`, in the handler named. */
const bodyKeys = (src: string, handler: string): string[] => {
  const at = src.indexOf(`const ${handler} = asyncHandler`);
  if (at < 0) throw new Error(`handler moved: ${handler}`);
  const m = /const \{([^}]+)\} = req\.body/.exec(src.slice(at, at + 4000));
  if (!m?.[1]) throw new Error(`no body destructure in ${handler}`);
  return m[1]
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join(',')
    .split(',')
    .map((k) => k.trim().split(/[\s=:]/)[0] ?? '')
    .filter(Boolean);
};

/** The keys of the object literal the web posts to `url` (the n-th such call). */
const webPostKeys = (src: string, url: string, nth = 0): string[] => {
  let from = 0;
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = src.indexOf(`api.post('${url}', {`, from);
    if (at < 0) throw new Error(`web call moved: ${url} #${nth}`);
    from = at + 1;
  }
  const open = src.indexOf('{', at);
  const close = src.indexOf('}', open);
  return src
    .slice(open + 1, close)
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .join(' ')
    .split(',')
    .map((k) => k.trim().split(/[\s:]/)[0] ?? '')
    .filter(Boolean);
};

let post: jest.SpyInstance;

const posted = (): { url: string; body: Record<string, unknown> } => {
  const call = post.mock.calls[0] as [string, Record<string, unknown>];
  return { url: call[0], body: call[1] };
};

const expectReadBy = (body: Record<string, unknown>, keys: string[]): void => {
  for (const k of Object.keys(body)) {
    expect({ key: k, readByServer: keys.includes(k) }).toEqual({ key: k, readByServer: true });
  }
};

beforeEach(() => {
  post = jest.spyOn(api, 'post').mockResolvedValue({ data: { success: true, data: {} } } as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const SUBS = backend('controllers/subscriptionController.js');
const USERS = backend('controllers/userController.js');
const PLANS = web('pages/Plans.jsx');
const CONFIGURE = web('pages/NewAccountConfigure.jsx');

describe('the routes exist where the app posts', () => {
  it('POST /api/subscriptions/subscribe, /cancel and POST /api/user/accounts', () => {
    const server = backend('server.js');
    expect(server).toContain("app.use('/api/subscriptions', subscriptionRoutes);");
    expect(server).toContain("app.use('/api/user', userRoutes);");
    expect(backend('routes/subscription.js')).toContain("router.post('/subscribe', authenticate, c.subscribe);");
    expect(backend('routes/subscription.js')).toContain("router.post('/cancel', authenticate, c.cancel);");
    expect(backend('routes/user.js')).toContain("router.post('/accounts', c.createAccount);");
  });
});

describe('Plans — subscribe and cancel', () => {
  const serverKeys = bodyKeys(SUBS, 'subscribe');

  it('a paid plan: planCode and billingCycle only — the server charges the Main Wallet itself', async () => {
    await subscriptionApi.subscribe({ planCode: 'PREMIUM', billingCycle: 'YEARLY' });
    const { url, body } = posted();
    expect(url).toBe('/subscriptions/subscribe');
    expect(body).toEqual({ planCode: 'PREMIUM', billingCycle: 'YEARLY' });
    expectReadBy(body, serverKeys);
    expect(serverKeys.sort()).toEqual(['billingCycle', 'planCode']);
    // The same keys the web's confirmAndPay posts.
    expect(Object.keys(body).sort()).toEqual(webPostKeys(PLANS, '/subscriptions/subscribe', 1).sort());
    // No payment method or reference travels: a client-sent paymentRef used
    // to buy a plan for free, and the server no longer reads either.
    expect(body).not.toHaveProperty('paymentMethod');
    expect(body).not.toHaveProperty('paymentRef');
    expect(SUBS).toContain('effectivePaymentRef = await subscriptionService.chargePlan({');
  });

  it('a Free / Post-Paid switch: planCode and billingCycle only, as the web sends', async () => {
    await subscriptionApi.subscribe({ planCode: 'POSTPAID', billingCycle: 'MONTHLY' });
    const { url, body } = posted();
    expect(url).toBe('/subscriptions/subscribe');
    expect(body).toEqual({ planCode: 'POSTPAID', billingCycle: 'MONTHLY' });
    expectReadBy(body, serverKeys);
    expect(Object.keys(body).sort()).toEqual(webPostKeys(PLANS, '/subscriptions/subscribe', 0).sort());
  });

  it('cancel sends the web reason, which the server reads', async () => {
    await subscriptionApi.cancel('User requested');
    const { url, body } = posted();
    expect(url).toBe('/subscriptions/cancel');
    expect(body).toEqual({ reason: 'User requested' });
    const handler = SUBS.slice(SUBS.indexOf('const cancel = asyncHandler'), SUBS.indexOf('const cancel = asyncHandler') + 400);
    expect(handler).toContain('reason: req.body.reason');
    expect(webPostKeys(PLANS, '/subscriptions/cancel')).toEqual(['reason']);
  });

  it('the screen never calls /subscriptions/renew (the web never does)', () => {
    const screen = read('app/src/screens/plans/PlansScreen.tsx');
    // Code only — the screen's header comment explains why there is no button.
    const code = screen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\.renew\(|\/subscriptions\/renew/);
    expect(PLANS).not.toContain('/subscriptions/renew');
  });
});

describe('New account — POST /user/accounts', () => {
  const serverKeys = bodyKeys(USERS, 'createAccount');
  // The web builds `payload` in create() and posts it — run that slice.
  const start = "const isDemo = mode === 'DEMO';";
  const end = "await api.post('/user/accounts', payload);";
  const a = CONFIGURE.indexOf(start);
  const b = CONFIGURE.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('NewAccountConfigure create() moved');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const webPayload = new Function('mode', 'plan', 'nickname', 'baseCurrency', 'leverage', 'UNLIMITED_LEVERAGE', 'DEMO_SEED_INR', `${CONFIGURE.slice(a, b)}\nreturn payload;`) as (...args: unknown[]) => Record<string, unknown>;
  // NewAccountConfigure.jsx pins `const baseCurrency = 'INR';` — there is no picker.
  const webKeys = (mode: string): string[] =>
    Object.keys(webPayload(mode, { code: 'PRO', name: 'Pro', maxLeverage: null }, '', 'INR', 5, UNLIMITED_LEVERAGE, DEMO_SEED_INR));

  it('a real account: every key read by the server, and none the web does not send', async () => {
    const body = buildNewAccountPayload({
      plan: { code: 'STANDARD', name: 'Standard', maxLeverage: 100 },
      mode: 'REAL',
      nickname: '  Swing  ',
      leverage: 50,
    });
    await createAccountFromWizard(body);
    const sent = posted();
    expect(sent.url).toBe('/user/accounts');
    expect(sent.body).toEqual({ accountType: 'STANDARD', baseCurrency: 'INR', leverage: 50, nickname: 'Swing' });
    expectReadBy(sent.body, serverKeys);
    expect(Object.keys(sent.body)).toEqual(webKeys('REAL'));
    // initialBalance on a live tier is a 400 on the server — never sent.
    expect(USERS).toContain("throw new AppError('initialBalance not allowed for live accounts");
    expect(sent.body).not.toHaveProperty('initialBalance');
  });

  it('a demo account: DEMO with the tier in tierCode, 1:Unlimited, the ₹1,00,000 seed — every key read by the server', async () => {
    const body = buildNewAccountPayload({
      plan: { code: 'PRO', name: 'Pro', maxLeverage: null },
      mode: 'DEMO',
      nickname: '',
      leverage: 5,
    });
    await createAccountFromWizard(body);
    const sent = posted();
    expect(sent.url).toBe('/user/accounts');
    expect(sent.body).toEqual({
      accountType: 'DEMO', tierCode: 'PRO', baseCurrency: 'INR', leverage: UNLIMITED_LEVERAGE,
      nickname: 'Pro Practice', initialBalance: 100000,
    });
    expectReadBy(sent.body, serverKeys);
    // The web's seed, inside the server's demo seed cap (₹10 crore).
    expect(CONFIGURE).toContain('const DEMO_SEED_INR = 100000;');
    expect(DEMO_SEED_INR).toBe(100000);
    expect(USERS).toContain('const DEMO_SEED_CAP = 100000000;');
    expect(Object.keys(sent.body)).toEqual(webKeys('DEMO'));
  });

  it('baseCurrency is always INR, as the web pins it — the server stores its BASE_CURRENCY whatever is sent', async () => {
    await createAccountFromWizard(buildNewAccountPayload({
      plan: { code: 'STANDARD', name: 'Standard', maxLeverage: 100 },
      mode: 'REAL',
      nickname: '',
      leverage: 100,
    }));
    expect(posted().body.baseCurrency).toBe('INR');
    expect(ACCOUNT_BASE_CURRENCY).toBe('INR');
    expect(CONFIGURE).toContain("const baseCurrency = 'INR';");
    expect(USERS).toContain('baseCurrency: BASE_CURRENCY,');
  });

  it('reads the min-deposit hint the server returns', async () => {
    post.mockResolvedValueOnce({
      data: { success: true, data: { _id: 'n1', accountNumber: 'TA1', accountType: 'STANDARD', minDepositHint: { minDeposit: 100, currency: 'INR', needsFunding: true } } },
    } as never);
    const created = await createAccountFromWizard({ accountType: 'STANDARD', baseCurrency: 'INR', leverage: 100, nickname: 'Standard' });
    expect(created.id).toBe('n1');
    expect(created.minDepositHint).toEqual({ minDeposit: 100, currency: 'INR', needsFunding: true });
  });
});
