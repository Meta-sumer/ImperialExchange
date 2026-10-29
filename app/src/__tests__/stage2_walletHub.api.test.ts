/**
 * Every server call the Wallet hub makes goes to a route the backend has,
 * with the query and body the backend reads — pinned against a recording
 * adapter (no request leaves the process) and against the backend's own
 * source, read from disk.
 *
 * The hub's one write is the account rename (PATCH /user/accounts/:id). Its
 * body is checked key for key against what userController.updateAccount
 * reads, so a renamed field cannot become a silent 400 on a phone.
 */
import type { InternalAxiosRequestConfig } from 'axios';
import fs from 'fs';
import path from 'path';

import { accountApi } from '@/api/account.api';
import { api } from '@/api/client';
import { fetchDashboard, fetchLifetimeStats, fetchPerformanceSeries } from '@/api/dashboard.api';
import { partnerApi } from '@/api/partner.api';
import { fetchAccountMetrics, fetchPositionHistory, fetchPositions } from '@/api/trading.api';
import { subscriptionApi } from '@/api/subscription.api';
import { walletApi } from '@/api/wallet.api';

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});

const ROOT = path.join(__dirname, '../../..');
const backend = (p: string): string => fs.readFileSync(path.join(ROOT, 'backend/src', p), 'utf8').replace(/\r\n/g, '\n');

const between = (src: string, start: string, end: string): string => {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`slice start moved: ${start}`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`slice end moved: ${end}`);
  return src.slice(a, b);
};

interface Call { method: string; url: string; params: Record<string, unknown>; body: unknown }
const calls: Call[] = [];

beforeAll(() => {
  api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    calls.push({
      method: String(config.method ?? 'get').toUpperCase(),
      url: config.url ?? '',
      params: (config.params as Record<string, unknown> | undefined) ?? {},
      body: typeof config.data === 'string' ? JSON.parse(config.data) : config.data,
    });
    return { data: { success: true, data: {} }, status: 200, statusText: 'OK', headers: {}, config };
  };
});

beforeEach(() => { calls.length = 0; });

const only = (): Call => {
  expect(calls).toHaveLength(1);
  return calls[0]!;
};

/** Where server.js mounts each router, and the router file. */
const MOUNTS: Record<string, string> = {
  '/wallet': 'routes/wallet.js',
  '/trading': 'routes/trading.js',
  '/user': 'routes/user.js',
  '/partner': 'routes/partner.js',
  '/subscription-wallet': 'routes/subscriptionWallet.js',
  '/bonus-wallet': 'routes/bonusWallet.js',
  '/subscriptions': 'routes/subscription.js',
};

/** The route exists: server.js mounts the prefix, and the router declares METHOD path. */
const expectRoute = (method: string, url: string): void => {
  const server = backend('server.js');
  const prefix = Object.keys(MOUNTS).find((p) => url === p || url.startsWith(`${p}/`));
  if (!prefix) throw new Error(`no mount known for ${url}`);
  expect(server).toContain(`app.use('/api${prefix}',`);
  const rest = url.slice(prefix.length) || '/';
  const pattern = rest.replace(/\/[0-9a-f]{6,}|\/acc\d+/gi, '/:id');
  const router = backend(MOUNTS[prefix]!);
  expect(router).toMatch(new RegExp(`router\\.${method.toLowerCase()}\\('${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
};

describe('the loads — Wallet.jsx load() and components/AccountOverview.jsx', () => {
  it.each([
    ['balances', () => walletApi.balances(), 'GET', '/wallet/balances', {}],
    ['deposits', () => walletApi.deposits(), 'GET', '/wallet/deposits', {}],
    ['withdrawals', () => walletApi.withdrawals(), 'GET', '/wallet/withdrawals', {}],
    ['ledger, 100 rows as the web asks', () => walletApi.ledger({ limit: 100 }), 'GET', '/wallet/ledger', { limit: 100 }],
    // Wallet.jsx asks for platform positions only — no includeBroker.
    ['open positions', () => fetchPositions(), 'GET', '/trading/positions', {}],
    ['closed-trade summary', () => fetchPositionHistory({ limit: 6 }), 'GET', '/trading/positions/history', { limit: 6 }],
    ['dashboard', () => fetchDashboard(), 'GET', '/user/dashboard', {}],
    ['lifetime stats 7d', () => fetchLifetimeStats({ days: 7 }), 'GET', '/user/dashboard/lifetime-stats', { days: '7' }],
    ['lifetime stats 30d', () => fetchLifetimeStats({ days: 30 }), 'GET', '/user/dashboard/lifetime-stats', { days: '30' }],
    ['lifetime stats 365d', () => fetchLifetimeStats({ days: 365 }), 'GET', '/user/dashboard/lifetime-stats', { days: '365' }],
    ['performance series', () => fetchPerformanceSeries({ range: '1m' }), 'GET', '/user/dashboard/monthly-series', { range: '1m' }],
    ['partner figures', () => partnerApi.volumeDashboard(), 'GET', '/partner/volume-dashboard', {}],
    ['main wallet', () => walletApi.bonusWallet(), 'GET', '/bonus-wallet', {}],
    // Wallet.jsx load(): plan billing (with the retired Main Wallet's old rows)
    // and the Bonus ledger feed Transaction History.
    ['plan-billing history, 100 rows', () => subscriptionApi.history({ limit: 100 }), 'GET', '/subscriptions/history', { limit: 100 }],
    ['main wallet history, 100 rows', () => walletApi.bonusHistory(100), 'GET', '/bonus-wallet/history', { limit: 100 }],
  ] as [string, () => Promise<unknown>, string, string, Record<string, unknown>][])('%s', async (_n, run, method, url, params) => {
    await run();
    const c = only();
    expect(c.method).toBe(method);
    expect(c.url).toBe(url);
    expect(c.params).toEqual(params);
    expectRoute(method, url);
  });

  it('account metrics are composed from the account’s balances and open positions (EquityHub has no metrics route)', async () => {
    await fetchAccountMetrics('acc1');
    expect(calls.map((c) => [c.method, c.url, c.params])).toEqual([
      ['GET', '/wallet/balances', { accountId: 'acc1' }],
      ['GET', '/trading/positions', { accountId: 'acc1' }],
    ]);
    expect(backend('routes/trading.js')).not.toContain('account-metrics');
  });

  it('the query keys are ones the controllers read', () => {
    expect(between(backend('controllers/walletController.js'), 'const getLedger', '});')).toMatch(/const \{ limit = 100, accountId \} = req\.query/);
    const history = between(backend('controllers/orderController.js'), 'const positionHistory', 'req.query;');
    expect(history).toContain('limit: limitRaw');
    const dash = backend('controllers/dashboardController.js');
    expect(dash).toContain('Number(req.query.days)');
    expect(dash).toContain("String(req.query.range || '')");
  });
});

describe('the one write — rename (PATCH /user/accounts/:id)', () => {
  it('sends only the nickname, normalised, and the controller reads exactly that', async () => {
    await accountApi.rename('acc1', '  Swing    Book ');
    const c = only();
    expect(c.method).toBe('PATCH');
    expect(c.url).toBe('/user/accounts/acc1');
    expect(c.body).toEqual({ nickname: 'Swing Book' });

    const controller = between(backend('controllers/userController.js'), 'const updateAccount = asyncHandler', '\n});');
    const read = new Set([...controller.matchAll(/req\.body\??\.(\w+)/g)].map((m) => m[1]));
    for (const m of controller.matchAll(/const \{([^}]+)\} = req\.body/g)) {
      for (const k of (m[1] ?? '').split(',')) read.add(k.split(/[=:]/)[0]!.trim());
    }
    expect([...Object.keys(c.body as object)].sort()).toEqual([...read].sort());
    // The server applies the same collapse-and-trim and the same 40 cap the form checks.
    expect(controller).toContain(".replace(/\\s+/g, ' ').trim()");
    expect(controller).toContain('nickname.length > 40');
    expect(backend('routes/user.js')).toContain("router.patch('/accounts/:id', c.updateAccount)");
  });
});
