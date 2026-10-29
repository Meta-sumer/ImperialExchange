/**
 * Orders, positions, the unified history and the account's money figures —
 * EquityHub's backend/src/routes/trading.js. The payload builder and the
 * account scoping are where a wrong answer costs money, so they are pinned.
 * EquityHub has no broker connect and no account-metrics endpoint: every row
 * is a platform row, and the figures are composed from /wallet/balances and
 * /trading/positions.
 */
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';

import { api } from '@/api/client';
import {
  _resetAccountFeePlans,
  adaptAccountFeePlan,
  adaptCloseResult,
  adaptHistoryRecord,
  adaptOrder,
  adaptPosition,
  applyMetricsPush,
  buildOrderPayload,
  closeAllPositions,
  closePosition,
  computeAccountMetrics,
  errorCode,
  fetchAccountMetrics,
  fetchOrderHistory,
  fetchOrderHistoryPage,
  fetchPositionHistory,
  fetchPositions,
  fetchTradeBook,
  fetchUnifiedHistory,
  isBenignOrderModifyError,
  loadAccountFeePlans,
  loadAccountMetrics,
  modifyPosition,
  partialClosePosition,
  resetAccountMetrics,
  scopeToAccount,
  useAccountMetricsStore,
} from '@/api/trading.api';
import { adaptAccountMetrics } from '@/types/trading';

type Reply = { status?: number; data: unknown };
let calls: InternalAxiosRequestConfig[] = [];

const serve = (handler: (c: InternalAxiosRequestConfig) => Reply): void => {
  calls = [];
  api.defaults.adapter = async (config) => {
    calls.push(config);
    const r = handler(config);
    const response = { data: r.data, status: r.status ?? 200, statusText: '', headers: {}, config };
    if (response.status >= 400) {
      throw new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, null, response);
    }
    return response;
  };
};

const body = (c: InternalAxiosRequestConfig | undefined): unknown =>
  (typeof c?.data === 'string' ? JSON.parse(c.data) : c?.data);

/* ── Placing ──────────────────────────────────────────────────────────── */

describe('buildOrderPayload — OrderForm.jsx submit', () => {
  const base = { accountId: 'a1', symbol: 'reliance', side: 'BUY' as const, orderMode: 'MARKET' as const, quantity: '10' };

  it('account, symbol, side, mode, quantity and an idempotency key — nothing about routing', () => {
    const p = buildOrderPayload(base);
    expect(p).toEqual({ accountId: 'a1', symbol: 'RELIANCE', side: 'BUY', orderMode: 'MARKET', quantity: '10', idempotencyKey: expect.any(String) });
    expect(p).not.toHaveProperty('destination');
    expect(p).not.toHaveProperty('broker');
  });

  it('sends price only in LIMIT mode', () => {
    expect(buildOrderPayload({ ...base, price: '2480' }).price).toBeUndefined();
    expect(buildOrderPayload({ ...base, orderMode: 'LIMIT', price: '2480' }).price).toBe('2480');
  });

  it('sends the product type (DELIVERY / INTRADAY) and leverage when given', () => {
    expect(buildOrderPayload({ ...base, productType: 'INTRADAY', leverage: 5 })).toMatchObject({ productType: 'INTRADAY', leverage: 5 });
    expect(buildOrderPayload(base)).not.toHaveProperty('productType');
  });

  it('never sends a zero SL/TP — "0" is a threshold that never triggers', () => {
    const p = buildOrderPayload({ ...base, stopLoss: '0', takeProfit: '2600' });
    expect(p).not.toHaveProperty('stopLoss');
    expect(p.takeProfit).toBe('2600');
  });

  it('keeps a caller-supplied idempotency key, so a retry is the same order', () => {
    expect(buildOrderPayload({ ...base, idempotencyKey: 'k1' }).idempotencyKey).toBe('k1');
  });
});

/* ── Adapters ─────────────────────────────────────────────────────────── */

describe('adapters', () => {
  it('an unknown order status is carried as sent, not coerced', () => {
    const o = adaptOrder({ _id: 'o1', symbol: 'tcs', side: 'sell', type: 'limit', status: 'TRIGGER_PENDING', quantity: '1' });
    expect(o).toMatchObject({ id: 'o1', symbol: 'TCS', side: 'SELL', type: 'LIMIT', status: 'TRIGGER_PENDING', filledQuantity: '0' });
  });

  it('a legacy position without positionSide gets the model default', () => {
    expect(adaptPosition({ _id: 'p', side: 'SELL', entryPrice: '1', quantity: '1' }).positionSide).toBe('SHORT');
    expect(adaptPosition({ _id: 'p', side: 'BUY' }).positionSide).toBe('LONG');
  });

  it('the close answer: the order, the closed position and the wallet', () => {
    const r = adaptCloseResult({ order: { _id: 'o1' }, position: { _id: 'p1', status: 'CLOSED' }, wallet: { balance: '100', locked: '10', free: '90', currency: 'INR' } });
    expect(r).toMatchObject({ order: { id: 'o1' }, position: { id: 'p1', status: 'CLOSED' }, wallet: { balance: '100', locked: '10', free: '90', currency: 'INR' } });
    expect(adaptCloseResult({})).toEqual({ order: null, position: null, wallet: null });
  });

  it('a history row: a trade, or an order that never opened (its missing figures are null, not 0)', () => {
    const trade = adaptHistoryRecord({ _id: 'p1', kind: 'TRADE', symbol: 'reliance', side: 'BUY', quantity: '10', entryPrice: '2500', closePrice: '2520', realizedPnl: '200', closeReason: 'TAKE_PROFIT', closedAt: '2026-10-01T10:00:00Z' });
    expect(trade).toMatchObject({ id: 'p1', kind: 'TRADE', symbol: 'RELIANCE', status: 'CLOSED', realizedPnl: '200', closeReason: 'TAKE_PROFIT' });
    const order = adaptHistoryRecord({ _id: 'o1', kind: 'ORDER', symbol: 'tcs', side: 'SELL', status: 'REJECTED', quantity: '5', entryPrice: null, closePrice: null, commission: null, realizedPnl: null, rejectionReason: 'SEGMENT_DISABLED', orderType: 'MARKET' });
    expect(order).toMatchObject({ kind: 'ORDER', status: 'REJECTED', closePrice: null, commission: null, realizedPnl: null, rejectionReason: 'SEGMENT_DISABLED', orderType: 'MARKET' });
  });

  it('account metrics keep the "0" margin level — an absence, not 0% — and default to INR', () => {
    expect(adaptAccountMetrics({ accountId: 'a', marginLevel: '0' })).toMatchObject({ marginLevel: '0', currency: 'INR' });
  });

  it('an account plan\'s fee half — either field shape', () => {
    expect(adaptAccountFeePlan({ code: 'standard', feeKind: 'PCT_OF_VALUE', feeValue: 0.00005, feeDisplay: '0.005% of trade value', defaultSpreadValue: '0.05', defaultSpreadType: 'FIXED' }))
      .toEqual({ code: 'STANDARD', feeKind: 'PCT_OF_VALUE', feeValue: 0.00005, feeDisplay: '0.005% of trade value', defaultSpreadValue: '0.05', defaultSpreadType: 'FIXED' });
    expect(adaptAccountFeePlan({ code: 'pro', feeModel: { kind: 'fixed_per_trade', value: 10 }, defaultSpreadValue: null, defaultSpreadType: 'percentage' }))
      .toMatchObject({ code: 'PRO', feeKind: 'FIXED_PER_TRADE', feeValue: 10, defaultSpreadValue: null, defaultSpreadType: 'PERCENTAGE' });
  });
});

/* ── Scoping ──────────────────────────────────────────────────────────── */

describe('scopeToAccount — Trade.jsx `scoped`', () => {
  const rows = [{ accountId: 'a1' }, { accountId: 'a2' }, { accountId: '' }];
  it('keeps this account\'s rows (and rows with no account)', () => {
    expect(scopeToAccount(rows, 'a1')).toEqual([rows[0], rows[2]]);
  });
  it('no account selected → everything', () => {
    expect(scopeToAccount(rows, null)).toEqual(rows);
  });
});

/* ── Requests ─────────────────────────────────────────────────────────── */

describe('requests', () => {
  it('positions are scoped by accountId only', async () => {
    serve(() => ({ data: { success: true, data: [] } }));
    await fetchPositions({ accountId: 'a1' });
    await fetchPositions();
    expect(calls.map((c) => c.params)).toEqual([{ accountId: 'a1' }, {}]);
  });

  it('a close posts to the position with no body', async () => {
    serve(() => ({ data: { success: true, data: { order: { _id: 'o' }, position: { _id: 'p1', status: 'CLOSED' }, wallet: null } } }));
    const r = await closePosition('p1');
    expect(calls[0]?.method).toBe('post');
    expect(calls[0]?.url).toBe('/trading/positions/p1/close');
    expect(calls[0]?.data).toBeUndefined();
    expect(r.position?.status).toBe('CLOSED');
  });

  it('a partial close sends the quantity', async () => {
    serve(() => ({ data: { success: true, data: { _id: 'o2' } } }));
    await partialClosePosition('p1', '3');
    expect(calls[0]?.url).toBe('/trading/positions/p1/partial-close');
    expect(body(calls[0])).toEqual({ quantity: '3' });
  });

  it('position history reads items, the whole-set summary and pagination', async () => {
    serve(() => ({
      data: {
        success: true,
        data: {
          items: [{ _id: 'p1', status: 'CLOSED', realizedPnl: '-2.5' }],
          summary: { totalTrades: 9, totalLot: 1.5, netPnl: -2.5, wins: 4, losses: 5 },
          pagination: { page: 2, limit: 1, total: 9, pages: 9 },
        },
      },
    }));
    const h = await fetchPositionHistory({ accountIds: ['a1', 'a2'], closeReason: 'STOP_LOSS', page: 2, limit: 1 });
    expect(calls[0]?.params).toEqual({ accountIds: 'a1,a2', closeReason: 'STOP_LOSS', page: 2, limit: 1 });
    expect(h.items[0]?.realizedPnl).toBe('-2.5');
    expect(h.summary).toEqual({ totalTrades: 9, totalLot: 1.5, netPnl: -2.5, wins: 4, losses: 5 });
    expect(h.pagination.pages).toBe(9);
  });

  it('the unified history: one paged list of trades and orders, recordType defaulting to all', async () => {
    serve(() => ({
      data: {
        success: true,
        data: {
          items: [{ _id: 'p1', kind: 'TRADE', realizedPnl: '5' }, { _id: 'o1', kind: 'ORDER', status: 'CANCELLED' }],
          summary: { totalTrades: 1, totalLot: 1, netPnl: 5, wins: 1, losses: 0 },
          pagination: { page: 1, limit: 30, total: 2, pages: 1 },
        },
      },
    }));
    const h = await fetchUnifiedHistory({ accountId: 'a1', symbol: 'nifty' });
    expect(calls[0]?.url).toBe('/trading/history');
    expect(calls[0]?.params).toEqual({ accountId: 'a1', symbol: 'NIFTY', recordType: 'all' });
    expect(h.items.map((r) => [r.id, r.kind])).toEqual([['p1', 'TRADE'], ['o1', 'ORDER']]);
    expect(h.pagination.total).toBe(2);
    await fetchUnifiedHistory({ recordType: 'rejected', page: 2, limit: 10 });
    expect(calls[1]?.params).toEqual({ recordType: 'rejected', page: 2, limit: 10 });
  });

  it('order history is paged and only sends the filters given', async () => {
    serve(() => ({ data: { success: true, data: { items: [{ _id: 'o1', status: 'REJECTED' }], pagination: { page: 1, limit: 50, total: 1, pages: 1 } } } }));
    const page = await fetchOrderHistoryPage({ symbol: 'tcs', status: 'REJECTED', page: 1, limit: 50 });
    expect(calls[0]?.params).toEqual({ symbol: 'TCS', status: 'REJECTED', page: 1, limit: 50 });
    expect(page.items.map((o) => o.id)).toEqual(['o1']);
    expect(page.pagination.total).toBe(1);
    expect((await fetchOrderHistory({ accountId: 'a1' })).map((o) => o.status)).toEqual(['REJECTED']);
    expect(calls[1]?.params).toEqual({ accountId: 'a1' });
  });

  it('SL/TP null clears; the body goes as given', async () => {
    serve(() => ({ data: { success: true, data: { _id: 'p1' } } }));
    await modifyPosition('p1', { stopLoss: null, takeProfit: '2600' });
    expect(calls[0]?.method).toBe('put');
    expect(body(calls[0])).toEqual({ stopLoss: null, takeProfit: '2600' });
  });

  it('close-all reports partial success as data', async () => {
    serve(() => ({ data: { success: true, data: { closed: 2, failed: [{ positionId: 'p3', symbol: 'X', reason: 'CLOSE_FAILED' }], total: 3 } } }));
    expect(await closeAllPositions('a1')).toEqual({ closed: 2, failed: [{ positionId: 'p3', symbol: 'X', reason: 'CLOSE_FAILED' }], total: 3 });
    expect(body(calls[0])).toEqual({ accountId: 'a1' });
  });

  it('the trade book: four lists for one account, each failing on its own; rejections from order history', async () => {
    serve((c) => {
      if (c.url === '/trading/orders/open') return { status: 500, data: { error: { message: 'boom' } } };
      if (c.url === '/trading/positions') return { data: { data: [{ _id: 'p1', accountId: 'a1' }, { _id: 'p2', accountId: 'other' }] } };
      if (c.url === '/trading/positions/history') return { data: { data: { items: [{ _id: 'h1', accountId: 'a1' }, { _id: 'h2', accountId: 'other' }] } } };
      return { data: { data: { items: [{ _id: 'r1', accountId: 'a1', status: 'REJECTED' }, { _id: 'f1', accountId: 'a1', status: 'FILLED' }] } } };
    });
    const book = await fetchTradeBook('a1');
    expect(book.openOrders).toBeUndefined();
    expect(book.positions?.map((p) => p.id)).toEqual(['p1']);
    expect(book.closed?.map((p) => p.id)).toEqual(['h1']);
    expect(book.rejected?.map((o) => o.id)).toEqual(['r1']);
    expect(calls.map((c) => [c.url, c.params])).toEqual([
      ['/trading/orders/open', { accountId: 'a1' }],
      ['/trading/positions', { accountId: 'a1' }],
      ['/trading/positions/history', { accountId: 'a1', limit: 50 }],
      ['/trading/orders/history', { accountId: 'a1' }],
    ]);
  });

  it('reads the error code and recognises a benign modify race', async () => {
    serve(() => ({ status: 400, data: { error: { code: 'ALREADY_CLOSED', message: 'Only PENDING orders can be modified' } } }));
    const err = await closeAllPositions().catch((e: unknown) => e);
    expect(errorCode(err)).toBe('ALREADY_CLOSED');
    expect(isBenignOrderModifyError(err)).toBe(true);
  });
});

/* ── Account fee plans ────────────────────────────────────────────────── */

describe('account fee plans — GET /account-plans', () => {
  beforeEach(() => _resetAccountFeePlans());

  it('keyed by code and shared, not re-fetched on every read', async () => {
    serve(() => ({ data: { success: true, data: [{ code: 'standard', feeKind: 'PCT_OF_VALUE', feeValue: 0.00005 }, { code: 'ecn', feeKind: 'PCT_OF_PROFIT', feeValue: 0.01 }] } }));
    const plans = await loadAccountFeePlans();
    expect(Object.keys(plans)).toEqual(['STANDARD', 'ECN']);
    await loadAccountFeePlans();
    expect(calls.map((c) => c.url)).toEqual(['/account-plans']);
    await loadAccountFeePlans(true);
    expect(calls).toHaveLength(2);
  });
});

/* ── Account metrics ──────────────────────────────────────────────────── */

describe('account metrics — composed from /wallet/balances and /trading/positions', () => {
  beforeEach(() => resetAccountMetrics());

  it('riskService\'s formulas: equity = balance + uPnL, free = equity − margin, level = equity / margin', () => {
    const m = computeAccountMetrics(
      'a1',
      [{ accountId: 'a1', currency: 'INR', balance: '10000' }, { accountId: 'a2', currency: 'INR', balance: '99' }] as never[],
      [{ accountId: 'a1', margin: '2000', unrealizedPnl: '150' }, { accountId: 'a1', margin: '500', unrealizedPnl: '-50' }, { accountId: 'a2', margin: '1', unrealizedPnl: '1' }] as never[],
    );
    expect(m).toMatchObject({ accountId: 'a1', currency: 'INR', balance: '10000.00', equity: '10100.00', usedMargin: '2500.00', freeMargin: '7600.00', unrealizedPnl: '100.00', marginLevel: '404.00' });
  });

  it('no margin in use → the "0" margin level (a dash, not 0%)', () => {
    expect(computeAccountMetrics('a1', [{ accountId: 'a1', currency: 'INR', balance: '500' }] as never[], []).marginLevel).toBe('0');
    expect(computeAccountMetrics('a1', [], []).balance).toBe('0.00');
  });

  it('reads the account\'s balances and positions', async () => {
    serve((c) => {
      if (c.url === '/wallet/balances') return { data: { success: true, data: [{ accountId: 'a1', currency: 'INR', balance: '1000', locked: '0', free: '1000' }] } };
      return { data: { success: true, data: [{ _id: 'p1', accountId: 'a1', margin: '100', unrealizedPnl: '5.2' }] } };
    });
    const m = await fetchAccountMetrics('a1');
    expect(calls.map((c) => [c.url, c.params])).toEqual([['/wallet/balances', { accountId: 'a1' }], ['/trading/positions', { accountId: 'a1' }]]);
    expect(m).toMatchObject({ equity: '1005.20', usedMargin: '100.00', freeMargin: '905.20', marginLevel: '1005.20' });
    expect(calls.some((c) => c.url === '/trading/account-metrics')).toBe(false);
  });

  it('a failed refresh keeps the last figures and records why', async () => {
    serve((c) => (c.url === '/wallet/balances'
      ? { data: { data: [{ accountId: 'a1', currency: 'INR', balance: '10' }] } }
      : { data: { data: [] } }));
    await loadAccountMetrics('a1');
    serve(() => ({ status: 503, data: { error: { message: 'Service unavailable' } } }));
    await loadAccountMetrics('a1');
    const e = useAccountMetricsStore.getState().byAccount.a1;
    expect(e?.metrics?.equity).toBe('10.00');
    expect(e?.error).toBe('Service unavailable');
  });

  it('figures worked out elsewhere land in the same store', () => {
    applyMetricsPush(adaptAccountMetrics({ accountId: 'a2', equity: '7' }));
    expect(useAccountMetricsStore.getState().byAccount.a2).toMatchObject({ metrics: { equity: '7' }, openPositions: null, status: null, error: null });
  });
});
