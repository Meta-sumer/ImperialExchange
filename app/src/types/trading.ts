/**
 * Trading domain types, derived from backend/src/models and
 * backend/src/config/constants.js.
 *
 * ── WHY EVERY MONEY FIELD IS A STRING ─────────────────────────────────
 * The backend stores decimals as strings and sends them as strings:
 * `quantity: String, // decimal as string` (models/Order.js:33), and the same
 * for price, margin, balance, P&L and every fee. That is not an accident of
 * serialisation — a float round-trip loses cents, and these are the numbers a
 * statement has to agree with.
 *
 * So they stay strings all the way to the formatter. Parse them for
 * comparison if you must; never parse them, do arithmetic, and send the
 * result back.
 * ──────────────────────────────────────────────────────────────────────
 */
import { dec, str } from '@/types/api';

/** A decimal carried as a string. See the note above. */
export type Decimal = string;

/* ── Enums, mirroring backend/src/config/constants.js ─────────────────── */

export const ORDER_SIDE = { BUY: 'BUY', SELL: 'SELL' } as const;
export type OrderSide = (typeof ORDER_SIDE)[keyof typeof ORDER_SIDE];

export const ORDER_TYPE = { MARKET: 'MARKET', LIMIT: 'LIMIT', STOP: 'STOP' } as const;
export type OrderType = (typeof ORDER_TYPE)[keyof typeof ORDER_TYPE];

/**
 * What the ORDER FORM offers, which is not the same list.
 *
 * The web posts `orderMode: 'MARKET' | 'LIMIT'` and the server resolves the
 * engine-level type from it — a LIMIT below market becomes a LIMIT, above it
 * becomes a STOP (orderController: "auto-resolve the engine-level type from
 * the price direction"). Sending `type` directly is the legacy path.
 */
export const ORDER_MODE = { MARKET: 'MARKET', LIMIT: 'LIMIT' } as const;
export type OrderMode = (typeof ORDER_MODE)[keyof typeof ORDER_MODE];

export const ORDER_STATUS = {
  PENDING: 'PENDING',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
} as const;
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

export const POSITION_STATUS = {
  OPEN: 'OPEN',
  CLOSING: 'CLOSING',
  CLOSED: 'CLOSED',
} as const;
export type PositionStatus = (typeof POSITION_STATUS)[keyof typeof POSITION_STATUS];

/**
 * Hedge-mode identity. `LONG` is built from BUY fills, `SHORT` from SELL.
 *
 * Equivalent to `side` by construction — models/Position.js:18-21 defaults it
 * to `side === 'BUY' ? 'LONG' : 'SHORT'` — so the two can never disagree.
 * See docs/PORT-RULINGS.md §2.
 */
export type PositionSide = 'LONG' | 'SHORT';

export type ProductType = 'DELIVERY' | 'INTRADAY' | 'NORMAL';

/**
 * Why a position closed — `Position.closeReason` in the backend schema, plus
 * COPY_MASTER_CLOSED, which copyTradingService writes through an update and
 * so bypasses the enum. Open-ended: a reason added server-side must still
 * arrive as itself rather than fail to type-check into something else.
 */
export type CloseReason =
  | 'TAKE_PROFIT' | 'STOP_LOSS' | 'TRAILING_STOP'
  | 'STOP_OUT' | 'MARGIN_STOPOUT' | 'NEGATIVE_BALANCE'
  | 'MANUAL' | 'ADMIN' | 'EXPIRY' | 'INTRADAY_SQUAREOFF'
  | 'INSTRUMENT_DISABLED_FORCE_CLOSE' | 'COPY_MASTER_CLOSED'
  | (string & {});

/**
 * The close reasons `GET /trading/positions/history?closeReason=` and
 * `/trading/history?closeReason=` accept — orderController's
 * VALID_CLOSE_REASONS whitelist, in its order.
 */
export const FILTERABLE_CLOSE_REASONS = [
  'MANUAL', 'ADMIN', 'TAKE_PROFIT', 'STOP_LOSS', 'TRAILING_STOP', 'MARGIN_STOPOUT',
  'NEGATIVE_BALANCE', 'STOP_OUT', 'INSTRUMENT_DISABLED_FORCE_CLOSE',
] as const;

/**
 * Which record set GET /trading/history returns (orderController
 * unifiedHistory `recordType`): closed trades are POSITIONS, cancelled and
 * rejected are ORDERS that never became one.
 */
export type RecordType = 'all' | 'closed' | 'cancelled' | 'rejected';

/**
 * One row of GET /trading/history. An order that never opened is projected
 * into the position shape; what it cannot have — a close price, a
 * commission, a P/L — is null, never 0.
 */
export interface HistoryRecord {
  id: string;
  /** TRADE = a closed position; ORDER = a cancelled / rejected order. */
  kind: 'TRADE' | 'ORDER';
  accountId: string;
  symbol: string;
  side: OrderSide;
  /** CLOSED | CANCELLED | REJECTED. */
  status: string;
  quantity: Decimal;
  closedQuantity: Decimal | null;
  /** The limit price for an order; null for a market order. */
  entryPrice: Decimal | null;
  closePrice: Decimal | null;
  commission: Decimal | null;
  swap: Decimal | null;
  realizedPnl: Decimal | null;
  closeReason: string | null;
  rejectionReason: string | null;
  /** The order's engine type (LIMIT / STOP / MARKET); null for a trade. */
  orderType: string | null;
  /** A trade: when it opened. An order: when it was placed. */
  openedAt: string | null;
  /** A trade: when it closed. An order: when it was cancelled / refused. */
  closedAt: string | null;
  createdAt: string | null;
}

/**
 * Which column a row's fee belongs under. Display metadata the server attaches
 * (orderController.attachFeeCategory) so one fee shows in exactly one place.
 */
export type FeeCategory = 'COMMISSION' | 'CHARGES' | (string & {});

/**
 * Account tiers. `REAL`, `VIRTUAL` and `DEMO` are LEGACY; modern accounts
 * carry STANDARD / PRO / FREE and their `_IC` variants.
 *
 * Which is exactly why nothing may test `=== 'REAL'` to mean "live money" —
 * that misses every modern account. See docs/PORT-RULINGS.md §3 and
 * utils/accountType.
 */
export type AccountType =
  | 'STANDARD' | 'STANDARD_IC'
  | 'PRO' | 'PRO_IC'
  | 'FREE' | 'FREE_IC'
  | 'REAL' | 'VIRTUAL' | 'DEMO'
  | 'CUSTOM'
  | (string & {});

export type TradingMode = 'INTERNAL' | 'EXTERNAL' | 'HYBRID';

export type Routing = 'INTERNAL' | 'INTERNAL_MATCHING' | 'EXTERNAL' | 'B_BOOK';

/* ── Account ──────────────────────────────────────────────────────────── */

export interface TradingAccount {
  id: string;
  accountNumber: string;
  /** The account PLAN CODE. Join to AccountPlan for the admin's own name. */
  accountType: AccountType;
  /** Only when accountType === 'CUSTOM'. */
  customTypeName?: string | null;
  baseCurrency: string;
  leverage: number;
  mode?: TradingMode;
  isActive: boolean;
  isTradingEnabled: boolean;
  nickname?: string | null;
  group?: string | null;
  /** Set when the plan's account cap suspended this one. */
  planSuspendedAt?: string | null;
  planSuspendedReason?: string | null;
  stoppedOutAt?: string | null;
}

/**
 * An account TIER as the admin configured it — the human name, badge and
 * wording behind `TradingAccount.accountType`, which is only a code.
 *
 * NOT the subscription `Plan` the user buys. Two products, two admin screens;
 * they collide only because both are "plans" in English.
 */
export interface AccountPlan {
  code: string;
  name: string;
  description: string | null;
  feeDisplay: string | null;
  supportLabel: string | null;
  instrumentsLabel: string | null;
  accessLabel: string | null;
  badge: string | null;
  minDeposit: number | null;
  /** null is UNLIMITED, which the model says explicitly — never 0. */
  maxLeverage: number | null;
  isPopular: boolean;
  isRecommended: boolean;
  sortOrder: number;
}

/**
 * An account's money figures. EquityHub has no account-metrics endpoint;
 * trading.api `computeAccountMetrics` composes these from the account's
 * wallet rows and open positions with riskService's formulas.
 */
export interface AccountMetrics {
  accountId: string;
  currency: string;
  /** Settled cash. Excludes floating P&L. */
  balance: Decimal;
  /** balance + unrealizedPnl. */
  equity: Decimal;
  /** Sum of position.margin — what was locked at fill. */
  usedMargin: Decimal;
  freeMargin: Decimal;
  unrealizedPnl: Decimal;
  /** `'0'` when no margin is in use — an absence, not a level of zero. */
  marginLevel: Decimal;
  /** When these figures were true. */
  asOf: string;
}

/* ── Orders ───────────────────────────────────────────────────────────── */

export interface Order {
  id: string;
  accountId: string;
  instrumentId?: string;
  symbol: string;
  side: OrderSide;
  positionSide?: PositionSide | null;
  type: OrderType;
  status: OrderStatus;
  quantity: Decimal;
  filledQuantity: Decimal;
  price?: Decimal | null;
  stopPrice?: Decimal | null;
  avgFillPrice?: Decimal | null;
  stopLoss?: Decimal | null;
  takeProfit?: Decimal | null;
  leverage: number;
  productType?: ProductType;
  reduceOnly?: boolean;
  routing?: Routing;
  /** Why an order was never accepted. The server's field name. */
  rejectionReason?: string | null;
  /** Why the SYSTEM cancelled a pending order — a different question. */
  cancellationReason?: string | null;
  commission?: Decimal;
  /** True when `commission` is this platform's estimate, not a booked fee. */
  commissionEstimated?: boolean;
  createdAt: string;
  updatedAt?: string;
  /* ── Added by the markets/trading API layer ── */
  /** Mirrored from a copy-trading master. */
  isCopy?: boolean;
  copyMaster?: string | null;
  feeCategory?: FeeCategory | null;
  /** Set on a close/reduce order the platform generated. */
  closeOnly?: boolean;
  /** 'INTERNAL' | 'LP' | … — which path filled it. */
  executionSource?: string | null;
  ocoGroupId?: string | null;
  lockedMargin?: Decimal | null;
  triggeredAt?: string | null;
  triggeredPrice?: Decimal | null;
  filledAt?: string | null;
  cancelledAt?: string | null;
  /**
   * @deprecated EquityHub has no broker rows — never set. Kept only so
   * callers that still test it compile until they drop the test.
   */
  isBroker?: boolean;
  /** @deprecated See `isBroker`. */
  broker?: string | null;
}

/** The payload POST /api/trading/orders accepts — OrderForm.jsx's body. */
export interface PlaceOrderRequest {
  accountId: string;
  symbol: string;
  side: OrderSide;
  /** The form's mode. The server resolves LIMIT vs STOP from the price. */
  orderMode: OrderMode;
  /** A string, straight from the input — never a parsed number. */
  quantity: Decimal;
  leverage?: number;
  /** LIMIT mode only. */
  price?: Decimal;
  stopLoss?: Decimal;
  takeProfit?: Decimal;
  /** NSE/BSE cash equity only: DELIVERY (full cash) or INTRADAY (leveraged, squared off). */
  productType?: ProductType;
  idempotencyKey?: string;
}

/**
 * PUT /api/trading/orders/:id — a PENDING order's editable fields. `null`
 * clears SL/TP; an absent key leaves it alone.
 */
export interface ModifyOrderRequest {
  price?: Decimal;
  stopPrice?: Decimal;
  quantity?: Decimal;
  stopLoss?: Decimal | null;
  takeProfit?: Decimal | null;
}

/** PUT /api/trading/positions/:id — `null` clears, absent leaves alone. */
export interface ModifyPositionRequest {
  stopLoss?: Decimal | null;
  takeProfit?: Decimal | null;
}

/**
 * POST /api/trading/orders/oco — a take-profit LIMIT and a stop-loss STOP
 * sharing an ocoGroupId; when one fills or cancels, the worker cancels the
 * other.
 */
export interface OcoOrderRequest {
  accountId: string;
  symbol: string;
  side: OrderSide;
  quantity: Decimal;
  limitPrice: Decimal;
  stopPrice: Decimal;
  leverage?: number;
}

export interface OcoOrderResult {
  ocoGroupId: string;
  limitOrder: Order | null;
  stopOrder: Order | null;
}

/* ── Positions ────────────────────────────────────────────────────────── */

export interface Position {
  id: string;
  accountId: string;
  instrumentId?: string;
  symbol: string;
  side: OrderSide;
  positionSide: PositionSide;
  status: PositionStatus;
  /** REMAINING open size. Zero once fully closed. */
  quantity: Decimal;
  /** Cumulative size closed over the position's life. */
  closedQuantity: Decimal;
  entryPrice: Decimal;
  /** The mark the server valued it at. */
  markPrice?: Decimal | null;
  closePrice?: Decimal | null;
  leverage: number;
  productType?: ProductType;
  /** Margin locked against this position. */
  margin: Decimal;
  stopLoss?: Decimal | null;
  takeProfit?: Decimal | null;
  trailingDistance?: Decimal | null;
  realizedPnl: Decimal;
  /** The authoritative floating figure, from the risk engine. */
  unrealizedPnl: Decimal;
  commission: Decimal;
  swap: Decimal;
  closeReason?: string | null;
  openedAt: string;
  closedAt?: string | null;
  /* ── Added by the markets/trading API layer ── */
  exchange?: string | null;
  isCopy?: boolean;
  copyMaster?: string | null;
  feeCategory?: FeeCategory | null;
  trailingHighWatermark?: Decimal | null;
  /** Set while a partial close is in flight server-side. */
  partialClosing?: boolean;
  createdAt?: string | null;
  /**
   * @deprecated EquityHub has no broker rows — never set. Kept only so
   * callers that still test it compile until they drop the test.
   */
  isBroker?: boolean;
  /** @deprecated See `isBroker`. */
  broker?: string | null;
  /** @deprecated See `isBroker`. */
  securityId?: string | null;
}

/**
 * What POST /trading/positions/:id/close answers (orderController
 * closePosition): the closing order, the now-closed position and the wallet,
 * so the screen can update before the WS nudge round-trips.
 */
export interface ClosePositionResult {
  order: Order | null;
  position: Position | null;
  wallet: { balance: Decimal; locked: Decimal; free: Decimal; currency: string } | null;
}

/** POST /trading/positions/close-all. Partial outcomes are normal. */
export interface CloseAllResult {
  closed: number;
  failed: { positionId: string; symbol: string; reason: string }[];
  total: number;
}

/**
 * The footer of GET /trading/positions/history — aggregated server-side over
 * the WHOLE filtered set, not the page. Numbers, not decimals: the backend
 * sums them as doubles (a count and a lot total do not need cents).
 */
export interface PositionHistorySummary {
  totalTrades: number;
  totalLot: number;
  netPnl: number;
  wins: number;
  losses: number;
}

/* ── Portfolio dashboard (/user/dashboard*) ───────────────────────────── */

/** Per-currency wallet totals. The server sums them as doubles. */
export type CurrencyTotals = Record<string, { balance: number; locked: number; free: number }>;

/**
 * GET /user/dashboard.
 *
 * "Live" is every non-demo account (dashboardController fixed its own
 * `=== 'REAL'` bug the same way PORT-RULINGS §3 rules). Unrealised P&L covers
 * only positions quoted in `primaryCurrency` — the server skips the rest
 * rather than add rupees to dollars.
 */
export interface DashboardSummary {
  user: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    kycStatus: string | null;
    twoFactorEnabled: boolean;
  };
  balance: {
    live: Decimal;
    demo: Decimal;
    liveByCurrency: CurrencyTotals;
    demoByCurrency: CurrencyTotals;
    primaryCurrency: string;
  };
  equity: {
    live: Decimal;
    unrealizedPnl: Decimal;
    openPositions: { symbol: string; side: OrderSide; quantity: Decimal; entryPrice: Decimal }[];
  };
  pnl: {
    realizedToday: Decimal;
    realizedLifetime: Decimal;
    /** Null when no trade has won or lost yet — not 0%. */
    winRate: number | null;
    profit: Decimal;
    /** Signed: a negative number. */
    loss: Decimal;
    netProfit: Decimal;
    tradingVolume: Decimal;
  };
  accounts: { live: number; demo: number };
  trades: {
    totalLive: number;
    totalLiveToday: number;
    totalDemo: number;
    totalDemoToday: number;
    openLive: number;
    openDemo: number;
    closedLive: number;
    closedLiveToday: number;
    winningLive: number;
    winningLiveToday: number;
    losingLive: number;
    losingLiveToday: number;
  };
  notifications: { unread: number };
  recentActivity: {
    id: string;
    symbol: string;
    side: OrderSide;
    price: Decimal;
    quantity: Decimal;
    executedAt: string | null;
    routing: string | null;
  }[];
}

/** GET /user/dashboard/lifetime-stats. */
export interface LifetimeStats {
  netProfit: Decimal;
  profit: Decimal;
  /** Signed: a negative number. */
  loss: Decimal;
  unrealizedPnl: Decimal;
  closedOrders: number;
  profitable: number;
  unprofitable: number;
  tradingVolume: Decimal;
}

export type SeriesGrain = 'hour' | 'day' | 'week' | 'month';

/** One bucket of GET /user/dashboard/monthly-series. */
export interface SeriesBucket {
  key: string;
  /** Server-formatted ("Jan", "Mar 4", "13:00") — shown verbatim. */
  label: string;
  tsStart: number;
  netProfit: number;
  profit: number;
  loss: number;
  closedOrders: number;
  tradingVolume: number;
  /** Running cumulative net profit — the curve the chart draws. */
  equity: number;
}

export interface PerformanceSeries {
  grain: SeriesGrain;
  range: string;
  buckets: SeriesBucket[];
}

/* ── Adapters for shapes the WebSocket also carries ───────────────────── */

type RawRow = Record<string, unknown>;

/**
 * An account-metrics shape from anywhere it arrives. `marginLevel` is carried
 * through as given, including `'0'` for "no margin in use"; fmtMarginLevel
 * decides how that reads. See PORT-RULINGS §1.
 */
export const adaptAccountMetrics = (rawIn: unknown, fallbackAccountId = ''): AccountMetrics => {
  const raw: RawRow = rawIn && typeof rawIn === 'object' ? (rawIn as RawRow) : {};
  return {
    accountId: str(raw.accountId) || fallbackAccountId,
    currency: (str(raw.currency) || 'INR').toUpperCase(),
    balance: dec(raw.balance),
    equity: dec(raw.equity),
    usedMargin: dec(raw.usedMargin),
    freeMargin: dec(raw.freeMargin),
    unrealizedPnl: dec(raw.unrealizedPnl),
    marginLevel: dec(raw.marginLevel),
    // The push names its timestamp `at`; the endpoint says `asOf`.
    asOf: str(raw.asOf) || str(raw.at) || new Date().toISOString(),
  };
};

/* ── Instruments ──────────────────────────────────────────────────────── */

export type InstrumentCategory =
  | 'FOREX' | 'CRYPTO' | 'STOCK' | 'INDEX' | 'COMMODITY' | (string & {});

export interface Instrument {
  id: string;
  symbol: string;
  name: string;
  category: InstrumentCategory;
  exchange?: string | null;
  segment?: string | null;
  lastPrice?: Decimal | null;
  bid?: Decimal | null;
  ask?: Decimal | null;
  change24h?: number | null;
  pricePrecision?: number;
  lotSize?: number | null;
  minOrderSize?: Decimal | null;
  quoteCurrency?: string | null;
  logoUrl?: string | null;
  /** Options only. */
  underlying?: string | null;
  expiryDate?: string | null;
  strike?: Decimal | null;
  optionType?: 'CE' | 'PE' | null;
  /* ── Added by the markets/trading API layer ── */
  baseCurrency?: string | null;
  /** Derived by /instruments/watchlist from the spread rule. */
  spread?: Decimal | null;
  spreadType?: 'FIXED' | 'PERCENTAGE' | (string & {}) | null;
  spreadValue?: Decimal | null;
  dayHigh?: Decimal | null;
  dayLow?: Decimal | null;
  volume24h?: Decimal | null;
  tickSize?: Decimal | null;
  quantityPrecision?: number | null;
  maxOrderSize?: Decimal | null;
  /**
   * The instrument's own cap. 999999 is the model's UNLIMITED sentinel and
   * null is legacy unlimited — see `isUnlimitedLeverage`.
   */
  maxLeverage?: number | null;
  /** maxLeverage, or an admin's scheduled override while its window is open. */
  effectiveLeverage?: number | null;
  leverageOverride?: {
    leverage: number;
    normalLeverage: number;
    startAt: string | null;
    endAt: string | null;
    reason: string | null;
  } | null;
  /**
   * When enabled, every NEW order is forced to `value` and the volume input
   * is read-only. `source` says whether a schedule or the static lock set it.
   */
  fixedVolume?: {
    enabled: boolean;
    value: Decimal | null;
    source: 'schedule' | 'fixed' | (string & {}) | null;
    endAt: string | null;
    reason: string | null;
  } | null;
  leverageLadder?: number[];
  /** Daily price bands (Indian cash) — null when not enforced. */
  upperCircuit?: Decimal | null;
  lowerCircuit?: Decimal | null;
  /** Max quantity per F&O order. */
  freezeQty?: Decimal | null;
  commissionType?: string | null;
  commissionPercent?: Decimal | null;
  commissionPerTrade?: Decimal | null;
  /** MCX: the unit one lot is quoted in ("1 lot = 100 bbl"). */
  contractUnit?: string | null;
  /** Per-account-tier spread overrides (Instrument.accountSpreads; spreadService). */
  accountSpreads?: { accountType: string; spreadValue: Decimal | null; spreadType?: string | null }[] | null;
  isActive?: boolean;
  /** May NEW orders open exposure here? Closing is always allowed. */
  tradingEnabled?: boolean;
  tradingHours?: { start: string; end: string; days: number[] } | null;
  /** Platform-wide daily opening-volume cap, per side, in lots. */
  dailyVolumeLimitEnabled?: boolean;
  dailyBuyLimit?: number | null;
  dailySellLimit?: number | null;
  dailyBuyUsed?: number | null;
  dailySellUsed?: number | null;
  lifetimeVolumeLimitEnabled?: boolean;
  lifetimeBuyLimit?: number | null;
  lifetimeSellLimit?: number | null;
  lastPriceUpdatedAt?: string | null;
  instrumentToken?: string | null;
  isin?: string | null;
  /**
   * The row as the server sent it. The catalogue carries admin-tunable fields
   * this type does not name; a screen that needs one reads it here rather
   * than the adapter growing a field per screen.
   */
  raw?: Record<string, unknown>;
}

/** 999999 is Instrument.maxLeverage's UNLIMITED sentinel; null is legacy unlimited. */
export const UNLIMITED_LEVERAGE = 999_999;

export const isUnlimitedLeverage = (leverage: number | null | undefined): boolean =>
  leverage === null || leverage === undefined || leverage >= UNLIMITED_LEVERAGE;

/** One OHLC bar. The chart bridge speaks this shape. */
export interface Candle {
  /** Seconds since epoch — what lightweight-charts expects. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}
