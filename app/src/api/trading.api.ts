import { useCallback, useEffect, useRef, useState } from 'react';
import type { AxiosError } from 'axios';
import { create } from 'zustand';

import { api, errorMessage } from '@/api/client';
import { walletApi } from '@/api/wallet.api';
import { bool, id, num, rows, str, strOrNull } from '@/types/api';
import { adaptPagination, decOrNull, isoOrNull, type Pagination } from '@/types/market';
import {
  ORDER_STATUS,
  POSITION_STATUS,
  type AccountMetrics,
  type CloseAllResult,
  type ClosePositionResult,
  type HistoryRecord,
  type ModifyOrderRequest,
  type ModifyPositionRequest,
  type OcoOrderRequest,
  type OcoOrderResult,
  type Order,
  type OrderSide,
  type OrderStatus,
  type OrderType,
  type PlaceOrderRequest,
  type Position,
  type PositionHistorySummary,
  type PositionStatus,
  type ProductType,
  type RecordType,
} from '@/types/trading';
import type { WalletBalance } from '@/types/wallet';
import {
  subscribeForeground,
  subscribeOrders,
  subscribePositions,
  subscribeWallet,
  type Unsubscribe,
} from '@/websocket/channels';

/**
 * Orders, positions and the account's money figures — EquityHub's
 * backend/src/routes/trading.js and controllers/orderController.js.
 *
 * EquityHub trades Indian markets only (NSE/BSE cash, index & stock F&O, MCX)
 * on the platform's own engine: there is no broker connect, so every row here
 * is a platform row and every action reaches the internal engine.
 *
 * Unrealised P&L on a position is the server's mark-to-market
 * (orderController.listPositions recomputes it at read time). EquityHub has
 * no account-metrics endpoint, so the account figures are composed here from
 * the two reads the web composes them from — /wallet/balances and
 * /trading/positions — with riskService's own formulas (see
 * `computeAccountMetrics`).
 */

type Raw = Record<string, unknown>;

const asRaw = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {});

const payload = (body: unknown): unknown => {
  const env = asRaw(body);
  return 'data' in env ? env.data : body;
};

/* ── Error codes the UI acts on ───────────────────────────────────────── */

export const TRADING_ERROR = {
  /** Close raced another close / the SL-TP worker. Refresh, do not alarm. */
  ALREADY_SETTLING: 'ALREADY_SETTLING',
  ALREADY_CLOSED: 'ALREADY_CLOSED',
  /** The closing order did not fill; the position was reverted to OPEN. */
  CLOSE_FAILED: 'CLOSE_FAILED',
  PARTIAL_IN_FLIGHT: 'PARTIAL_IN_FLIGHT',
  SL_WOULD_TRIGGER_IMMEDIATELY: 'SL_WOULD_TRIGGER_IMMEDIATELY',
  TP_WOULD_TRIGGER_IMMEDIATELY: 'TP_WOULD_TRIGGER_IMMEDIATELY',
  RATE_LIMITED: 'RATE_LIMITED',
  /** A switched-off market segment takes no NEW exposure; closing still works. */
  SEGMENT_DISABLED: 'SEGMENT_DISABLED',
  MARKET_CLOSED: 'MARKET_CLOSED',
  /** F&O trades in whole lots. */
  INVALID_LOT_SIZE: 'INVALID_LOT_SIZE',
  /** Options are buy-to-open only (no writing). */
  OPTION_WRITE_NOT_SUPPORTED: 'OPTION_WRITE_NOT_SUPPORTED',
  INVALID_TICK_SIZE: 'INVALID_TICK_SIZE',
  PRICE_OUT_OF_BAND: 'PRICE_OUT_OF_BAND',
  QTY_EXCEEDS_FREEZE: 'QTY_EXCEEDS_FREEZE',
  LIMIT_INVALID: 'LIMIT_INVALID',
  LEVERAGE_OVER_TIER_CAP: 'LEVERAGE_OVER_TIER_CAP',
  SELL_NOT_ALLOWED_ON_IC_TIER: 'SELL_NOT_ALLOWED_ON_IC_TIER',
  NO_LONG_TO_CLOSE: 'NO_LONG_TO_CLOSE',
  MAX_POSITION_SIZE_EXCEEDED: 'MAX_POSITION_SIZE_EXCEEDED',
} as const;

/** The `error.code` of a failed request, when the server sent one. */
export const errorCode = (err: unknown): string | null =>
  (err as AxiosError<{ error?: { code?: string } }> | undefined)?.response?.data?.error?.code ?? null;

/**
 * A pending-order edit that lost a race with the fill or the trigger —
 * Trade.jsx handleOrderModifyError. The row the trader dragged no longer
 * exists as a pending order; the right response is to refresh quietly, not
 * to show an error for something that already happened.
 */
export const isBenignOrderModifyError = (err: unknown): boolean => {
  const msg = errorMessage(err);
  return msg.includes('Only PENDING orders can be modified')
    || msg.includes('Stop has already triggered');
};

/* ── Adapters ─────────────────────────────────────────────────────────── */

const sideOf = (v: unknown): OrderSide => (str(v).toUpperCase() === 'SELL' ? 'SELL' : 'BUY');

const ORDER_TYPES: readonly string[] = ['MARKET', 'LIMIT', 'STOP'];
const ORDER_STATUSES: readonly string[] = Object.values(ORDER_STATUS);
const POSITION_STATUSES: readonly string[] = Object.values(POSITION_STATUS);
const PRODUCT_TYPES: readonly string[] = ['DELIVERY', 'INTRADAY', 'NORMAL'];

const productOf = (v: unknown): ProductType | undefined => {
  const p = str(v).toUpperCase();
  return PRODUCT_TYPES.includes(p) ? (p as ProductType) : undefined;
};

export const adaptOrder = (rawIn: unknown): Order => {
  const r = asRaw(rawIn);
  const type = str(r.type).toUpperCase();
  const status = str(r.status).toUpperCase();
  const positionSide = str(r.positionSide).toUpperCase();
  return {
    id: id(r) || str(r.clientOrderId),
    accountId: str(r.accountId),
    instrumentId: str(r.instrumentId) || undefined,
    symbol: str(r.symbol).toUpperCase(),
    side: sideOf(r.side),
    positionSide: positionSide === 'LONG' || positionSide === 'SHORT' ? positionSide : null,
    type: (ORDER_TYPES.includes(type) ? type : 'MARKET') as OrderType,
    // An unknown status is carried as the server said it, not coerced into
    // one it is not.
    status: (ORDER_STATUSES.includes(status) ? status : str(r.status)) as OrderStatus,
    quantity: decOrNull(r.quantity) ?? '0',
    filledQuantity: decOrNull(r.filledQuantity) ?? '0',
    price: decOrNull(r.price),
    stopPrice: decOrNull(r.stopPrice),
    avgFillPrice: decOrNull(r.avgFillPrice),
    stopLoss: decOrNull(r.stopLoss),
    takeProfit: decOrNull(r.takeProfit),
    leverage: num(r.leverage) ?? 1,
    productType: productOf(r.productType),
    reduceOnly: bool(r.reduceOnly),
    routing: (strOrNull(r.routing) ?? undefined) as Order['routing'],
    rejectionReason: strOrNull(r.rejectionReason),
    cancellationReason: strOrNull(r.cancellationReason),
    // A pending order's commission is the server's ESTIMATE (listOpen);
    // `commissionEstimated` says so. Absent elsewhere — a dash, not a zero.
    commission: decOrNull(r.commission) ?? undefined,
    commissionEstimated: bool(r.commissionEstimated),
    createdAt: isoOrNull(r.createdAt) ?? '',
    updatedAt: isoOrNull(r.updatedAt) ?? undefined,
    isCopy: bool(r.isCopy),
    copyMaster: strOrNull(r.copyMaster),
    feeCategory: strOrNull(r.feeCategory),
    closeOnly: bool(r.closeOnly),
    executionSource: strOrNull(r.executionSource),
    ocoGroupId: strOrNull(r.ocoGroupId),
    lockedMargin: decOrNull(r.lockedMargin),
    triggeredAt: isoOrNull(r.triggeredAt),
    triggeredPrice: decOrNull(r.triggeredPrice),
    filledAt: isoOrNull(r.filledAt),
    cancelledAt: isoOrNull(r.cancelledAt),
  };
};

export const adaptPosition = (rawIn: unknown): Position => {
  const r = asRaw(rawIn);
  const side = sideOf(r.side);
  const ps = str(r.positionSide).toUpperCase();
  const status = str(r.status).toUpperCase();
  return {
    id: id(r),
    accountId: str(r.accountId),
    instrumentId: str(r.instrumentId) || undefined,
    symbol: str(r.symbol).toUpperCase(),
    side,
    // Legacy rows predate the field; the model's own default applies
    // (Position.js positionSide default, PORT-RULINGS §2).
    positionSide: ps === 'LONG' || ps === 'SHORT' ? ps : side === 'BUY' ? 'LONG' : 'SHORT',
    status: (POSITION_STATUSES.includes(status) ? status : 'OPEN') as PositionStatus,
    quantity: decOrNull(r.quantity) ?? '0',
    closedQuantity: decOrNull(r.closedQuantity) ?? '0',
    entryPrice: decOrNull(r.entryPrice) ?? '0',
    markPrice: decOrNull(r.markPrice),
    closePrice: decOrNull(r.closePrice),
    leverage: num(r.leverage) ?? 1,
    productType: productOf(r.productType),
    margin: decOrNull(r.margin) ?? '0',
    stopLoss: decOrNull(r.stopLoss),
    takeProfit: decOrNull(r.takeProfit),
    trailingDistance: decOrNull(r.trailingDistance),
    realizedPnl: decOrNull(r.realizedPnl) ?? '0',
    unrealizedPnl: decOrNull(r.unrealizedPnl) ?? '0',
    commission: decOrNull(r.commission) ?? '0',
    swap: decOrNull(r.swap) ?? '0',
    closeReason: strOrNull(r.closeReason),
    remark: strOrNull(r.remark),
    openedAt: isoOrNull(r.openedAt) ?? isoOrNull(r.createdAt) ?? '',
    closedAt: isoOrNull(r.closedAt),
    exchange: strOrNull(r.exchange),
    isCopy: bool(r.isCopy),
    copyMaster: strOrNull(r.copyMaster),
    feeCategory: strOrNull(r.feeCategory),
    trailingHighWatermark: decOrNull(r.trailingHighWatermark),
    partialClosing: bool(r.partialClosing),
    createdAt: isoOrNull(r.createdAt),
  };
};

const adaptOrders = (body: unknown): Order[] => rows<unknown>(payload(body)).map(adaptOrder);
const adaptPositions = (body: unknown): Position[] => rows<unknown>(payload(body)).map(adaptPosition);

/* ── Placing ──────────────────────────────────────────────────────────── */

/** The web's key shape (OrderForm.jsx submit). Scoped per user server-side. */
export const newIdempotencyKey = (): string =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

/**
 * The body POST /trading/orders receives, shaped exactly as OrderForm.jsx
 * shapes it:
 *   • `orderMode` MARKET | LIMIT — the server resolves a LIMIT into LIMIT or
 *     STOP from the price against the current bid/ask;
 *   • `price` only in LIMIT mode;
 *   • `productType` (DELIVERY / INTRADAY) only for NSE/BSE cash equity — the
 *     caller decides, the server ignores it elsewhere;
 *   • SL/TP only when > 0 — "0" is a threshold that never triggers;
 *   • an idempotency key, always, so a double tap cannot open two positions.
 */
export const buildOrderPayload = (req: PlaceOrderRequest): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    accountId: req.accountId,
    symbol: req.symbol.toUpperCase(),
    side: req.side,
    orderMode: req.orderMode,
    quantity: String(req.quantity),
    idempotencyKey: req.idempotencyKey || newIdempotencyKey(),
  };
  if (req.leverage !== undefined) body.leverage = req.leverage;
  if (req.orderMode === 'LIMIT' && req.price !== undefined) body.price = String(req.price);
  if (req.productType) body.productType = req.productType;
  if (req.stopLoss !== undefined && Number(req.stopLoss) > 0) body.stopLoss = String(req.stopLoss);
  if (req.takeProfit !== undefined && Number(req.takeProfit) > 0) body.takeProfit = String(req.takeProfit);
  return body;
};

/**
 * POST /trading/orders. A MARKET order comes back routed and (usually)
 * FILLED with `executionSource`; a LIMIT/STOP comes back PENDING — the
 * price-monitor worker triggers it when the market crosses.
 */
export const placeOrder = async (req: PlaceOrderRequest): Promise<Order> => {
  const res = await api.post('/trading/orders', buildOrderPayload(req));
  return adaptOrder(payload(res.data));
};

/** POST /trading/orders/oco. The web has no screen for it; the route is live. */
export const placeOcoOrder = async (req: OcoOrderRequest): Promise<OcoOrderResult> => {
  const res = await api.post('/trading/orders/oco', {
    ...req,
    symbol: req.symbol.toUpperCase(),
    quantity: String(req.quantity),
    limitPrice: String(req.limitPrice),
    stopPrice: String(req.stopPrice),
  });
  const r = asRaw(payload(res.data));
  return {
    ocoGroupId: str(r.ocoGroupId),
    limitOrder: r.limitOrder ? adaptOrder(r.limitOrder) : null,
    stopOrder: r.stopOrder ? adaptOrder(r.stopOrder) : null,
  };
};

/**
 * PUT /trading/orders/:id — a PENDING order's price / stop / size / SL / TP.
 * Send `stopLoss: null` to remove it. See isBenignOrderModifyError for the
 * race with a fill. The server re-resolves LIMIT vs STOP against the market.
 */
export const modifyOrder = async (orderId: string, fields: ModifyOrderRequest): Promise<Order> => {
  const res = await api.put(`/trading/orders/${encodeURIComponent(orderId)}`, fields);
  return adaptOrder(payload(res.data));
};

/** DELETE /trading/orders/:id — PENDING / PARTIALLY_FILLED only. */
export const cancelOrder = async (orderId: string): Promise<Order> => {
  const res = await api.delete(`/trading/orders/${encodeURIComponent(orderId)}`);
  return adaptOrder(payload(res.data));
};

/* ── Reading orders ───────────────────────────────────────────────────── */

/**
 * GET /trading/orders/open — PENDING and PARTIALLY_FILLED, newest first. Each
 * row carries a fee ESTIMATE (`commissionEstimated`).
 */
export const fetchOpenOrders = async (q: { accountId?: string | null } = {}): Promise<Order[]> => {
  const res = await api.get('/trading/orders/open', {
    params: q.accountId ? { accountId: q.accountId } : undefined,
  });
  return adaptOrders(res.data);
};

export interface OrderHistoryQuery {
  accountId?: string | null;
  /** Case-insensitive match on the symbol, server-side. */
  symbol?: string;
  /** One terminal state; absent = FILLED, CANCELLED and REJECTED. */
  status?: 'FILLED' | 'CANCELLED' | 'REJECTED';
  page?: number;
  /** 1–200, default 50. */
  limit?: number;
}

export interface OrderHistoryPage {
  items: Order[];
  pagination: Pagination;
}

const orderHistoryParams = (q: OrderHistoryQuery): Record<string, string | number> => {
  const params: Record<string, string | number> = {};
  if (q.accountId) params.accountId = q.accountId;
  if (q.symbol) params.symbol = q.symbol.toUpperCase();
  if (q.status) params.status = q.status;
  if (q.page) params.page = q.page;
  if (q.limit) params.limit = q.limit;
  return params;
};

/**
 * GET /trading/orders/history — FILLED, CANCELLED and REJECTED, newest
 * first, one page (`{ items, pagination }`). A plan-suspended account sees a
 * limited window.
 */
export const fetchOrderHistoryPage = async (q: OrderHistoryQuery = {}): Promise<OrderHistoryPage> => {
  const res = await api.get('/trading/orders/history', { params: orderHistoryParams(q) });
  const body = asRaw(payload(res.data));
  return {
    items: rows<unknown>(payload(res.data)).map(adaptOrder),
    pagination: adaptPagination(body.pagination, q.limit ?? 50),
  };
};

/** The first page's rows — what the Trade page and Reports read. */
export const fetchOrderHistory = async (q: OrderHistoryQuery = {}): Promise<Order[]> =>
  (await fetchOrderHistoryPage(q)).items;

/* ── Positions ────────────────────────────────────────────────────────── */

export interface PositionsQuery {
  accountId?: string | null;
}

/** GET /trading/positions — OPEN positions, marked to market by the server. */
export const fetchPositions = async (q: PositionsQuery = {}): Promise<Position[]> => {
  const res = await api.get('/trading/positions', {
    params: q.accountId ? { accountId: q.accountId } : {},
  });
  return adaptPositions(res.data);
};

export interface PositionHistoryQuery {
  accountId?: string | null;
  /** Several accounts at once — Orders.jsx's "All" with a type filter. */
  accountIds?: readonly string[];
  symbol?: string;
  side?: OrderSide;
  /** One of FILTERABLE_CLOSE_REASONS (types/trading); anything else is ignored server-side. */
  closeReason?: string;
  from?: string;
  to?: string;
  page?: number;
  /** 1–200, default 30. */
  limit?: number;
}

export interface PositionHistoryPage {
  items: Position[];
  /** Over the whole filtered set, not the page. */
  summary: PositionHistorySummary;
  pagination: Pagination;
}

export const EMPTY_HISTORY_SUMMARY: PositionHistorySummary = {
  totalTrades: 0, totalLot: 0, netPnl: 0, wins: 0, losses: 0,
};

export const adaptHistorySummary = (rawIn: unknown): PositionHistorySummary => {
  const r = asRaw(rawIn);
  return {
    totalTrades: num(r.totalTrades) ?? 0,
    totalLot: num(r.totalLot) ?? 0,
    netPnl: num(r.netPnl) ?? 0,
    wins: num(r.wins) ?? 0,
    losses: num(r.losses) ?? 0,
  };
};

const historyParams = (q: PositionHistoryQuery): Record<string, string | number> => {
  const params: Record<string, string | number> = {};
  if (q.accountId) params.accountId = q.accountId;
  else if (q.accountIds && q.accountIds.length) params.accountIds = q.accountIds.join(',');
  if (q.symbol) params.symbol = q.symbol.toUpperCase();
  if (q.side) params.side = q.side;
  if (q.closeReason) params.closeReason = q.closeReason;
  if (q.from) params.from = q.from;
  if (q.to) params.to = q.to;
  if (q.page) params.page = q.page;
  if (q.limit) params.limit = q.limit;
  return params;
};

/** GET /trading/positions/history — closed positions + the summary footer. */
export const fetchPositionHistory = async (q: PositionHistoryQuery = {}): Promise<PositionHistoryPage> => {
  const res = await api.get('/trading/positions/history', { params: historyParams(q) });
  const body = asRaw(payload(res.data));
  return {
    items: rows<unknown>(body.items).map(adaptPosition),
    summary: adaptHistorySummary(body.summary),
    pagination: adaptPagination(body.pagination, q.limit ?? 30),
  };
};

/* ── Unified history (/trading/history) ───────────────────────────────── */

export interface UnifiedHistoryQuery extends PositionHistoryQuery {
  /** all | closed | cancelled | rejected (orderController.unifiedHistory). */
  recordType?: RecordType;
}

export interface UnifiedHistoryPage {
  items: HistoryRecord[];
  /** TRADE figures only — computed over the closed positions in scope. */
  summary: PositionHistorySummary;
  pagination: Pagination;
}

/**
 * One row of /trading/history. The server projects an order that never
 * opened into the position shape; a value it cannot have (close price,
 * commission, P/L) is null — never 0, which would read as "broke even".
 */
export const adaptHistoryRecord = (rawIn: unknown): HistoryRecord => {
  const r = asRaw(rawIn);
  const kind = str(r.kind).toUpperCase() === 'ORDER' ? 'ORDER' : 'TRADE';
  return {
    id: id(r),
    kind,
    accountId: str(r.accountId),
    symbol: str(r.symbol).toUpperCase(),
    side: sideOf(r.side),
    status: str(r.status).toUpperCase() || (kind === 'TRADE' ? 'CLOSED' : ''),
    quantity: decOrNull(r.quantity) ?? '0',
    closedQuantity: decOrNull(r.closedQuantity),
    entryPrice: decOrNull(r.entryPrice),
    closePrice: decOrNull(r.closePrice),
    commission: decOrNull(r.commission),
    swap: decOrNull(r.swap),
    realizedPnl: decOrNull(r.realizedPnl),
    closeReason: strOrNull(r.closeReason),
    rejectionReason: strOrNull(r.rejectionReason),
    remark: strOrNull(r.remark),
    orderType: strOrNull(r.orderType),
    openedAt: isoOrNull(r.openedAt),
    closedAt: isoOrNull(r.closedAt),
    createdAt: isoOrNull(r.createdAt),
  };
};

/**
 * GET /trading/history — closed trades, cancelled and rejected orders in one
 * list, unioned and paged server-side (page 2 of each list is not page 2 of
 * the merge, so the client could not do it). Orders.jsx's only source.
 */
export const fetchUnifiedHistory = async (q: UnifiedHistoryQuery = {}): Promise<UnifiedHistoryPage> => {
  const params: Record<string, string | number> = { ...historyParams(q), recordType: q.recordType ?? 'all' };
  const res = await api.get('/trading/history', { params });
  const body = asRaw(payload(res.data));
  return {
    items: rows<unknown>(body.items).map(adaptHistoryRecord),
    summary: adaptHistorySummary(body.summary),
    pagination: adaptPagination(body.pagination, q.limit ?? 30),
  };
};

/* ── Closing ──────────────────────────────────────────────────────────── */

/** Exported for tests: the close answer — the order, the closed position, the wallet. */
export const adaptCloseResult = (rawIn: unknown): ClosePositionResult => {
  const r = asRaw(rawIn);
  const w = r.wallet && typeof r.wallet === 'object' ? (r.wallet as Raw) : null;
  return {
    order: r.order ? adaptOrder(r.order) : null,
    position: r.position ? adaptPosition(r.position) : null,
    wallet: w
      ? {
        balance: decOrNull(w.balance) ?? '0',
        locked: decOrNull(w.locked) ?? '0',
        free: decOrNull(w.free) ?? '0',
        currency: str(w.currency) || 'INR',
      }
      : null,
  };
};

/**
 * POST /trading/positions/:id/close — no body, as the web posts it. A race
 * with another close or the SL/TP worker is a 409 (ALREADY_SETTLING /
 * ALREADY_CLOSED); an order that did not fill is CLOSE_FAILED and the
 * position is back to OPEN.
 */
export const closePosition = async (positionId: string): Promise<ClosePositionResult> => {
  const res = await api.post(`/trading/positions/${encodeURIComponent(positionId)}/close`);
  return adaptCloseResult(payload(res.data));
};

/**
 * POST /trading/positions/:id/partial-close — must be LESS than the open
 * size (the full size is a close: "Use full close endpoint …").
 */
export const partialClosePosition = async (positionId: string, quantity: string): Promise<Order> => {
  const res = await api.post(
    `/trading/positions/${encodeURIComponent(positionId)}/partial-close`,
    { quantity: String(quantity) },
  );
  return adaptOrder(payload(res.data));
};

/**
 * POST /trading/positions/close-all, scoped to one account when given.
 * Partial success is a normal answer.
 */
export const closeAllPositions = async (accountId?: string | null): Promise<CloseAllResult> => {
  const res = await api.post('/trading/positions/close-all', accountId ? { accountId } : {});
  const r = asRaw(payload(res.data));
  return {
    closed: num(r.closed) ?? 0,
    failed: rows<unknown>(r.failed).map((f) => {
      const x = asRaw(f);
      return { positionId: str(x.positionId), symbol: str(x.symbol), reason: str(x.reason) };
    }),
    total: num(r.total) ?? 0,
  };
};

/**
 * PUT /trading/positions/:id — SL/TP on an open position. The server
 * refuses a level that would fire at once (SL_/TP_WOULD_TRIGGER_IMMEDIATELY)
 * against the same price the trigger worker reads.
 */
export const modifyPosition = async (positionId: string, fields: ModifyPositionRequest): Promise<Position> => {
  const res = await api.put(`/trading/positions/${encodeURIComponent(positionId)}`, fields);
  return adaptPosition(payload(res.data));
};

/**
 * PUT /trading/positions/:id/trailing-stop — distance in price units;
 * null or 0 removes it. The route is live; the web has no control for it.
 */
export const setTrailingStop = async (positionId: string, distance: string | null): Promise<Position> => {
  const res = await api.put(
    `/trading/positions/${encodeURIComponent(positionId)}/trailing-stop`,
    { distance },
  );
  return adaptPosition(payload(res.data));
};

/* ── The trade book for one account ───────────────────────────────────── */

/**
 * Keep only rows for `accountId` (and rows with no accountId) — Trade.jsx's
 * belt-and-braces `scoped` filter, so a user-wide refresh never mixes
 * accounts.
 */
export const scopeToAccount = <T extends { accountId: string }>(
  list: readonly T[],
  accountId: string | null | undefined,
): T[] => (accountId ? list.filter((x) => !x.accountId || x.accountId === accountId) : [...list]);

export interface TradeBook {
  /** undefined = that request failed; keep what you had. */
  openOrders?: Order[];
  positions?: Position[];
  closed?: Position[];
  /** Orders the platform refused — they never reach Pending or Closed. */
  rejected?: Order[];
}

/**
 * Open orders, open positions, recent closed trades and the rejected orders
 * for one account in parallel — the data half of Trade.jsx's `refresh()`.
 * Each list fails on its own: one endpoint down must not blank the others.
 */
export const fetchTradeBook = async (
  accountId: string | null,
  opts: { closedLimit?: number } = {},
): Promise<TradeBook> => {
  const [o, p, h, r] = await Promise.allSettled([
    fetchOpenOrders({ accountId }),
    fetchPositions({ accountId }),
    fetchPositionHistory({ accountId, limit: opts.closedLimit ?? 50 }),
    // Order history returns FILLED / CANCELLED / REJECTED; the rejections are
    // the ones no other list shows.
    fetchOrderHistory({ accountId }),
  ]);
  const book: TradeBook = {};
  if (o.status === 'fulfilled') book.openOrders = scopeToAccount(o.value, accountId);
  if (p.status === 'fulfilled') book.positions = scopeToAccount(p.value, accountId);
  if (h.status === 'fulfilled') book.closed = scopeToAccount(h.value.items, accountId);
  if (r.status === 'fulfilled') book.rejected = scopeToAccount(r.value.filter((x) => x.status === 'REJECTED'), accountId);
  return book;
};

/**
 * The trade book for the selected account, kept live the way Trade.jsx keeps
 * it:
 *   • switching accounts CLEARS the lists at once, so the previous account's
 *     rows (and anything drawn from them) vanish before the new ones land;
 *   • a response for an account that is no longer selected is dropped;
 *   • `user:positions`, `user:orders` and `user:wallet` are user-wide, so any
 *     of them re-runs the account-scoped fetch;
 *   • returning to the foreground re-fetches (the web's focus safety net).
 * A list whose request failed keeps its previous rows.
 */
export function useTradeBook(
  accountId: string | null,
  opts: { closedLimit?: number } = {},
): {
  openOrders: Order[];
  positions: Position[];
  closed: Position[];
  rejected: Order[];
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const closedLimit = opts.closedLimit ?? 50;
  const [openOrders, setOpenOrders] = useState<Order[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [closed, setClosed] = useState<Position[]>([]);
  const [rejected, setRejected] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const selected = useRef<string | null>(accountId);
  selected.current = accountId;

  const refresh = useCallback(async () => {
    const requestedFor = accountId;
    const book = await fetchTradeBook(requestedFor, { closedLimit });
    if (selected.current !== requestedFor) return;
    if (book.openOrders) setOpenOrders(book.openOrders);
    if (book.positions) setPositions(book.positions);
    if (book.closed) setClosed(book.closed);
    if (book.rejected) setRejected(book.rejected);
    setLoading(false);
  }, [accountId, closedLimit]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    setOpenOrders([]);
    setPositions([]);
    setClosed([]);
    setRejected([]);
    setLoading(true);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const again = (): void => { void refreshRef.current(); };
    const offPositions = subscribePositions(again);
    const offOrders = subscribeOrders(again);
    const offWallet = subscribeWallet(again);
    const offFg = subscribeForeground(again);
    return () => { offPositions(); offOrders(); offWallet(); offFg(); };
  }, []);

  return { openOrders, positions, closed, rejected, loading, refresh };
}

/* ── Account metrics ──────────────────────────────────────────────────── */

const toFixed2 = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : '0.00');

/**
 * The account's money figures from its wallet rows and open positions —
 * riskService.calculateAccountMetrics' formulas (the engine that decides
 * margin calls), which EquityHub's own client-side useAccountMetrics.js
 * repeats:
 *
 *   balance     = the account's base-currency wallet balance (else the first row)
 *   usedMargin  = Σ position.margin   (what was locked at fill)
 *   unrealized  = Σ position.unrealizedPnl (the server's mark-to-market)
 *   equity      = balance + unrealized
 *   freeMargin  = equity − usedMargin
 *   marginLevel = usedMargin > 0 ? equity / usedMargin × 100 : '0'
 *
 * `'0'` is "no margin in use" — fmtMarginLevel renders it as a dash.
 */
export const computeAccountMetrics = (
  accountId: string,
  balances: readonly Pick<WalletBalance, 'accountId' | 'currency' | 'balance'>[],
  positions: readonly Pick<Position, 'accountId' | 'margin' | 'unrealizedPnl'>[],
  baseCurrency: string | null | undefined = 'INR',
): AccountMetrics => {
  const mine = balances.filter((b) => !b.accountId || b.accountId === accountId);
  const base = String(baseCurrency || 'INR').toUpperCase();
  const wallet = mine.find((b) => String(b.currency).toUpperCase() === base) ?? mine[0] ?? null;
  const balance = wallet ? Number(wallet.balance) || 0 : 0;
  let usedMargin = 0;
  let unrealizedPnl = 0;
  for (const p of positions) {
    if (p.accountId && p.accountId !== accountId) continue;
    usedMargin += Number(p.margin || 0) || 0;
    unrealizedPnl += Number(p.unrealizedPnl || 0) || 0;
  }
  const equity = balance + unrealizedPnl;
  const freeMargin = equity - usedMargin;
  return {
    accountId,
    currency: base,
    balance: toFixed2(balance),
    equity: toFixed2(equity),
    usedMargin: toFixed2(usedMargin),
    freeMargin: toFixed2(freeMargin),
    unrealizedPnl: toFixed2(unrealizedPnl),
    marginLevel: usedMargin > 0 ? toFixed2((equity / usedMargin) * 100) : '0',
    asOf: new Date().toISOString(),
  };
};

/**
 * One account's figures: GET /wallet/balances?accountId= and GET
 * /trading/positions?accountId=, composed by `computeAccountMetrics`.
 * Rejects when either read fails — the last good figures stay in the store.
 */
export const fetchAccountMetrics = async (accountId: string, baseCurrency?: string | null): Promise<AccountMetrics> => {
  const [balances, positions] = await Promise.all([
    walletApi.balances(accountId),
    fetchPositions({ accountId }),
  ]);
  return computeAccountMetrics(accountId, balances, positions, baseCurrency ?? 'INR');
};

/** The web's poll (useAccountMetrics.js, 5 s) while the figures are on screen. */
export const ACCOUNT_METRICS_POLL_MS = 5_000;

export interface AccountMetricsEntry {
  metrics: AccountMetrics | null;
  loading: boolean;
  error: string | null;
  /** When the figures arrived here, epoch ms. */
  receivedAt: number;
  /** Kept for callers that read it; EquityHub sends no account push. */
  openPositions: number | null;
  status: string | null;
}

const EMPTY_ENTRY: AccountMetricsEntry = {
  metrics: null, loading: false, error: null, receivedAt: 0, openPositions: null, status: null,
};

interface MetricsState {
  byAccount: Record<string, AccountMetricsEntry>;
}

export const useAccountMetricsStore = create<MetricsState>(() => ({ byAccount: {} }));

const patchEntry = (accountId: string, patch: Partial<AccountMetricsEntry>): void => {
  useAccountMetricsStore.setState((s) => ({
    byAccount: { ...s.byAccount, [accountId]: { ...(s.byAccount[accountId] ?? EMPTY_ENTRY), ...patch } },
  }));
};

const metricsInflight = new Map<string, Promise<AccountMetrics | null>>();

/** Fetch into the store. Never rejects; a failure lands in `error`. */
export const loadAccountMetrics = (accountId: string): Promise<AccountMetrics | null> => {
  const existing = metricsInflight.get(accountId);
  if (existing) return existing;
  const hasFigures = !!useAccountMetricsStore.getState().byAccount[accountId]?.metrics;
  if (!hasFigures) patchEntry(accountId, { loading: true });
  const p = fetchAccountMetrics(accountId)
    .then((metrics) => {
      patchEntry(accountId, { metrics, loading: false, error: null, receivedAt: Date.now() });
      return metrics;
    })
    .catch((err: unknown) => {
      // The last good figures stay on screen; the error says they are old.
      patchEntry(accountId, { loading: false, error: errorMessage(err) });
      return null;
    })
    .finally(() => { metricsInflight.delete(accountId); });
  metricsInflight.set(accountId, p);
  return p;
};

/** Land figures worked out elsewhere in the same store. Exported for tests. */
export const applyMetricsPush = (
  metrics: AccountMetrics,
  meta: { openPositions: number | null; status: string | null } = { openPositions: null, status: null },
): void => {
  if (!metrics.accountId) return;
  patchEntry(metrics.accountId, {
    metrics, loading: false, error: null, receivedAt: Date.now(),
    openPositions: meta.openPositions, status: meta.status,
  });
};

/*
 * Live wiring, shared: one poll per retained account, and wallet/position
 * nudges and the foreground refetching whatever is retained.
 */
const metricsRetained = new Map<string, { count: number; poll: ReturnType<typeof setInterval> }>();
let metricsLiveOff: Unsubscribe | null = null;

const refetchRetained = (): void => {
  for (const accountId of metricsRetained.keys()) void loadAccountMetrics(accountId);
};

const startMetricsLive = (): void => {
  const offWallet = subscribeWallet(refetchRetained);
  const offPositions = subscribePositions(refetchRetained);
  const offFg = subscribeForeground(refetchRetained);
  metricsLiveOff = () => { offWallet(); offPositions(); offFg(); };
};

/** Keep one account's metrics live until the release is called. */
export const retainAccountMetrics = (accountId: string): Unsubscribe => {
  const entry = metricsRetained.get(accountId);
  if (entry) {
    entry.count += 1;
  } else {
    const poll = setInterval(() => {
      const seen = useAccountMetricsStore.getState().byAccount[accountId]?.receivedAt ?? 0;
      if (Date.now() - seen >= ACCOUNT_METRICS_POLL_MS) void loadAccountMetrics(accountId);
    }, ACCOUNT_METRICS_POLL_MS);
    metricsRetained.set(accountId, { count: 1, poll });
    if (!metricsLiveOff) startMetricsLive();
  }
  void loadAccountMetrics(accountId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const e = metricsRetained.get(accountId);
    if (!e) return;
    e.count -= 1;
    if (e.count > 0) return;
    clearInterval(e.poll);
    metricsRetained.delete(accountId);
    if (metricsRetained.size === 0 && metricsLiveOff) {
      metricsLiveOff();
      metricsLiveOff = null;
    }
  };
};

/** One account's figures, live (polled, and re-read on wallet / position events). */
export function useAccountMetrics(
  accountId: string | null | undefined,
): AccountMetricsEntry & { refresh: () => Promise<AccountMetrics | null> } {
  useEffect(() => (accountId ? retainAccountMetrics(accountId) : undefined), [accountId]);
  const entry = useAccountMetricsStore((s) => (accountId ? s.byAccount[accountId] : undefined));
  const refresh = useCallback(
    () => (accountId ? loadAccountMetrics(accountId) : Promise.resolve(null)),
    [accountId],
  );
  return { ...(entry ?? { ...EMPTY_ENTRY, loading: !!accountId }), refresh };
}

/** Drop every account's figures — on sign-out, so the next user sees none. */
export const resetAccountMetrics = (): void => {
  useAccountMetricsStore.setState({ byAccount: {} });
};

/* ── Account fee plans (/account-plans) ───────────────────────────────── */

/**
 * The fee half of an account tier — what OrderForm.jsx's fee breakdown and
 * effective spread read (useAccountPlans.js): the tier's fee model and its
 * default spread. The catalogue itself is account.api's.
 */
export interface AccountFeePlan {
  code: string;
  /** PCT_OF_VALUE | FIXED_PER_TRADE | PCT_OF_PROFIT (feeType.js). */
  feeKind: string;
  /** A raw value: 0.00005 is 0.005% of value; a flat ₹ for FIXED_PER_TRADE. */
  feeValue: number;
  /** The admin's own wording, e.g. "0.005% of trade value". */
  feeDisplay: string;
  /** The plan's spread default; null = no plan default (spreadService). */
  defaultSpreadValue: string | null;
  defaultSpreadType: 'FIXED' | 'PERCENTAGE';
}

export const adaptAccountFeePlan = (rawIn: unknown): AccountFeePlan => {
  const r = asRaw(rawIn);
  const model = asRaw(r.feeModel);
  const spreadValue = r.defaultSpreadValue;
  return {
    code: str(r.code).toUpperCase(),
    feeKind: (str(r.feeKind) || str(model.kind)).toUpperCase(),
    feeValue: num(r.feeValue) ?? num(model.value) ?? 0,
    feeDisplay: str(r.feeDisplay),
    defaultSpreadValue: spreadValue != null && String(spreadValue).trim() !== '' ? String(spreadValue) : null,
    defaultSpreadType: str(r.defaultSpreadType).toUpperCase() === 'PERCENTAGE' ? 'PERCENTAGE' : 'FIXED',
  };
};

const FEE_PLANS_TTL_MS = 60_000;
let feePlans: Record<string, AccountFeePlan> | null = null;
let feePlansAt = 0;
let feePlansInflight: Promise<Record<string, AccountFeePlan>> | null = null;

/** GET /account-plans, keyed by UPPERCASE code, shared for a minute (useAccountPlans.js). */
export const loadAccountFeePlans = (force = false): Promise<Record<string, AccountFeePlan>> => {
  if (feePlans && !force && Date.now() - feePlansAt < FEE_PLANS_TTL_MS) return Promise.resolve(feePlans);
  if (feePlansInflight) return feePlansInflight;
  feePlansInflight = api.get('/account-plans')
    .then((res) => {
      const byCode: Record<string, AccountFeePlan> = {};
      for (const p of rows<unknown>(payload(res.data)).map(adaptAccountFeePlan)) {
        if (p.code) byCode[p.code] = p;
      }
      feePlans = byCode;
      feePlansAt = Date.now();
      return byCode;
    })
    .finally(() => { feePlansInflight = null; });
  return feePlansInflight;
};

/** The fee plans by code; `{}` until they load (and if they fail to). */
export function useAccountFeePlans(): Record<string, AccountFeePlan> {
  const [byCode, setByCode] = useState<Record<string, AccountFeePlan>>(() => feePlans ?? {});
  useEffect(() => {
    let cancelled = false;
    loadAccountFeePlans()
      .then((m) => { if (!cancelled) setByCode(m); })
      .catch(() => { /* the breakdown shows its dashes */ });
    return () => { cancelled = true; };
  }, []);
  return byCode;
}

/** Tests only. */
export const _resetAccountFeePlans = (): void => {
  feePlans = null;
  feePlansAt = 0;
  feePlansInflight = null;
};
