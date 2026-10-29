import type {
  Instrument,
  OrderMode,
  OrderSide,
  PlaceOrderRequest,
  ProductType,
  TradingAccount,
} from '@/types/trading';
import { isDemoLike } from '@/utils/accountType';
import { EMPTY, currencySymbol, fmtMoney, fmtNum, fmtPrice } from '@/utils/money';

/**
 * The order form's rules — EquityHub's client/src/components/OrderForm.jsx,
 * lifted out of the component so every number and every message can be
 * pinned against the web's own source.
 *
 * Nothing here talks to the network or to React. The component
 * (components/trade/OrderForm.tsx) owns state and effects; this file decides.
 *
 * EquityHub is INR-only and trades on the platform's own engine: every
 * quote, fee, margin and balance is rupees, and every order goes to the
 * platform (there is no broker routing).
 *
 * ── WHERE THE PORT DIFFERS, DELIBERATELY ─────────────────────────────
 * 1. Money figures go through utils/money: a negative reads `-₹12.00`, where
 *    the web's `fmtAcct` prints `₹-12.00`.
 * 2. The confirm prompt names `baseCurrency || symbol` — the web prints
 *    "undefined" for an instrument with no baseCurrency (a stock).
 * Everything else is the web's arithmetic, operator for operator.
 * ──────────────────────────────────────────────────────────────────────
 */

/* ── Types ────────────────────────────────────────────────────────────── */

/** What the order form reads from an instrument. The adapter's row fits. */
export type OrderInstrument = Partial<Instrument> | null | undefined;

export type TpSlMode = 'price' | 'pips' | 'money' | 'percent';
export type CapSource = 'instrument' | 'account' | 'demo' | 'system';

/* ── TP / SL modes ────────────────────────────────────────────────────── */

/** PriceModeDropdown's menu. */
export const PRICE_MODE_OPTIONS: readonly { id: TpSlMode; label: string }[] = [
  { id: 'price', label: 'By asset price' },
  { id: 'pips', label: 'In pips' },
  { id: 'money', label: 'In money' },
  { id: 'percent', label: 'In % of equity' },
];
export const PRICE_MODE_SHORT: Record<TpSlMode, string> = {
  price: 'Price',
  pips: 'Pips',
  money: 'Money',
  percent: '% Eq.',
};

/** The TP / SL placeholders per mode. */
export const tpSlPlaceholder = (mode: TpSlMode, isTp: boolean): string => {
  if (mode === 'price') return 'Not set';
  if (mode === 'pips') return isTp ? 'e.g. 50' : 'e.g. 30';
  if (mode === 'money') return isTp ? 'e.g. 25.00' : 'e.g. 15.00';
  return isTp ? 'e.g. 0.5' : 'e.g. 0.3';
};

/** What a TP/SL conversion needs to know (the closure the web's helpers read). */
export interface TpSlContext {
  /** The projected entry — last price for MARKET, the limit price for LIMIT. */
  refPrice: number;
  qtyNum: number;
  /** The account's free balance. */
  free: number;
  side: OrderSide | null;
  /** `Math.min(pricePrecision || 2, 8)` — `_prec`. */
  precision: number;
}

/** `_prec`. */
export const tpSlPrecision = (instrument: OrderInstrument): number => Math.min(instrument?.pricePrecision || 2, 8);

/** A typed TP/SL value in `mode` → an absolute price, or '' when it cannot be worked out (`_toPrice`). */
export const tpSlToPrice = (mode: TpSlMode, raw: unknown, isTp: boolean, c: TpSlContext): number | '' => {
  const v = Number(raw);
  if (!Number.isFinite(v) || v === 0) return '';
  if (mode === 'price') return v;
  if (!c.refPrice) return '';
  const pipSize = Math.pow(10, -c.precision);
  const dirTp = c.side === 'BUY' ? 1 : -1;
  const dir = isTp ? dirTp : -dirTp;
  if (mode === 'pips') return c.refPrice + dir * v * pipSize;
  if (mode === 'money') return c.qtyNum > 0 ? c.refPrice + dir * (v / c.qtyNum) : '';
  if (mode === 'percent') {
    if (!c.qtyNum || !c.free) return '';
    const targetPnl = (v / 100) * c.free;
    return c.refPrice + dir * (targetPnl / c.qtyNum);
  }
  return v;
};

/** Up to `dp` decimals without trailing zeros — "100", "100.5" (`_trim`). */
export const trimDp = (n: number, dp: number): string => {
  const r = Number(Number(n).toFixed(dp));
  return Number.isFinite(r) ? String(r) : '';
};

/** An absolute price → the input string for `mode` (`_fromPrice`). */
export const tpSlFromPrice = (mode: TpSlMode, priceStr: string, isTp: boolean, c: TpSlContext): string => {
  const p = Number(priceStr);
  if (!Number.isFinite(p) || p === 0) return '';
  if (mode === 'price') return String(priceStr);
  if (!c.refPrice) return '';
  const pipSize = Math.pow(10, -c.precision);
  const dirTp = c.side === 'BUY' ? 1 : -1;
  const dir = isTp ? dirTp : -dirTp;
  const diff = (p - c.refPrice) * dir;
  if (mode === 'pips') return trimDp(diff / pipSize, 1);
  if (mode === 'money') return c.qtyNum > 0 ? trimDp(diff * c.qtyNum, 2) : '';
  if (mode === 'percent') {
    if (!c.qtyNum || !c.free) return '';
    return trimDp((diff * c.qtyNum / c.free) * 100, 2);
  }
  return String(priceStr);
};

/**
 * The trader typed in a TP/SL field: keep the raw text, derive the absolute
 * price sent to the server (`_onInputChange`).
 */
export const tpSlInputChange = (
  mode: TpSlMode,
  raw: string,
  isTp: boolean,
  c: TpSlContext,
): { input: string; price: string } => {
  const input = String(raw);
  if (raw === '' || raw === '-') return { input, price: '' };
  if (mode === 'price') return { input, price: String(raw) };
  const px = tpSlToPrice(mode, raw, isTp, c);
  if (px === '' || !Number.isFinite(Number(px))) return { input, price: '' };
  return { input, price: Number(px).toFixed(c.precision) };
};

/**
 * The caption under a TP/SL row in a non-price mode (`_modeCaption`): the
 * asset price it works out to, or why it cannot yet.
 */
export const tpSlCaption = (mode: TpSlMode, priceStr: string, c: TpSlContext): string | null => {
  if (mode === 'price') return null;
  if (!c.refPrice) return 'Enter a reference price (or wait for the live quote) to use this mode.';
  if ((mode === 'money' || mode === 'percent') && !c.qtyNum) {
    return 'Enter a volume so the converter can size the P&L.';
  }
  if (mode === 'percent' && !c.free) {
    return 'Equity not loaded yet — check your account balance.';
  }
  if (!priceStr) return null;
  const p = Number(priceStr);
  return `≈ asset price ${Number.isFinite(p) ? p.toFixed(c.precision) : '—'}`;
};

/** Help tips of the two fields. */
export const TP_HELP = 'Auto-closes the position in profit when price reaches this level.';
export const SL_HELP = 'Caps the loss by auto-closing the position when price hits this level.';

/**
 * Settings > "Set TP/SL automatically": a 1% stop and a 2% target (1:2 R/R)
 * off the entry, signed by the side. Null when there is no entry to work
 * from. Only EMPTY fields are filled by the caller.
 */
export const autoTpSlLevels = (p: {
  side: OrderSide | null;
  orderMode: OrderMode;
  lastPrice: unknown;
  price: unknown;
  pricePrecision: number | null | undefined;
}): { stopLoss: string; takeProfit: string } | null => {
  const px = p.orderMode === 'MARKET' ? Number(p.lastPrice || 0) : Number(p.price || 0);
  if (!px) return null;
  const prec = Math.min(p.pricePrecision || 2, 5);
  const slDist = px * 0.01;
  const tpDist = px * 0.02;
  if (p.side === 'BUY') {
    return { stopLoss: (px - slDist).toFixed(prec), takeProfit: (px + tpDist).toFixed(prec) };
  }
  return { stopLoss: (px + slDist).toFixed(prec), takeProfit: (px - tpDist).toFixed(prec) };
};

/* ── Leverage ─────────────────────────────────────────────────────────── */

/** The platform's "unlimited" sentinel. */
export const UNLIMITED_THRESHOLD = 999_999;
export const SYSTEM_DEFAULT_LEVERAGE = 100;
/** The slider stops here so it stays draggable; the input and chips cover the rest. */
export const SLIDER_VISUAL_CAP = 2000;

export interface LeverageCap {
  /** MAX_LEVERAGE_UI. */
  max: number;
  capSource: CapSource;
  /** SLIDER_VISUAL_MAX. */
  sliderMax: number;
}

export const isDemoAccount = (account: Pick<TradingAccount, 'accountType'> | null | undefined): boolean =>
  isDemoLike(account?.accountType);

/**
 * The ceiling, by priority: the instrument's own cap (its scheduled override
 * while one runs) wins outright; else a practice account is unlimited; else
 * the account/plan cap from /user/leverage; else the system default.
 */
export const resolveLeverageCap = (
  instrument: Pick<Instrument, 'effectiveLeverage' | 'maxLeverage'> | null | undefined,
  account: Pick<TradingAccount, 'accountType'> | null | undefined,
  accountEffectiveLeverage: number | null | undefined,
): LeverageCap => {
  const rawInstLev = Number(instrument?.effectiveLeverage ?? instrument?.maxLeverage);
  const hasInstLev = Number.isFinite(rawInstLev) && rawInstLev > 0;
  const accountCap = Number(accountEffectiveLeverage) || null;
  let max: number;
  let capSource: CapSource;
  if (hasInstLev) {
    max = rawInstLev;
    capSource = 'instrument';
  } else if (isDemoAccount(account)) {
    max = UNLIMITED_THRESHOLD;
    capSource = 'demo';
  } else if (accountCap && accountCap > 0) {
    max = accountCap;
    capSource = 'account';
  } else {
    max = SYSTEM_DEFAULT_LEVERAGE;
    capSource = 'system';
  }
  return { max, capSource, sliderMax: Math.min(max, SLIDER_VISUAL_CAP) };
};

/**
 * Where the leverage the trader last chose for an account is remembered
 * (OrderForm.jsx `_levKey`). Presentation state only — the server re-derives
 * and enforces the real cap on every order.
 */
export const leverageStorageKey = (accountId: string | null | undefined): string =>
  `tradepro:leverage:${accountId || 'default'}`;

/** A stored value read back: a finite number ≥ 1, else null (`_readSavedLeverage`). */
export const parseSavedLeverage = (raw: unknown): number | null => {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? n : null;
};

/**
 * The starting leverage: the one last chosen for THIS account, else the
 * account's own, inside the ceiling (OrderForm.jsx `initialLev`).
 */
export const initialLeverage = (
  account: Pick<TradingAccount, 'leverage'> | null | undefined,
  max: number,
  saved: number | null = null,
): number =>
  Math.min(max, Math.max(1, saved || Number(account?.leverage) || 1));

/** Snap into range — down, never up. */
export const clampLeverage = (curr: number, max: number): number => Math.min(max, Math.max(1, curr));

/** A keystroke in the 1:__ field; null means "leave the value alone". */
export const leverageFromInput = (raw: string, max: number): number | null => {
  const v = Number(raw);
  return Number.isFinite(v) ? Math.max(1, Math.min(max, Math.round(v))) : null;
};

export const leverageLabel = (leverage: number): string =>
  (leverage >= UNLIMITED_THRESHOLD ? 'Unlimited' : `1:${leverage}`);

/** The source line of the Leverage info row's help. */
export const leverageCapHelp = (cap: LeverageCap): string => {
  if (cap.capSource === 'instrument') {
    return `Instrument leverage: ${cap.max >= UNLIMITED_THRESHOLD ? 'Unlimited' : `1:${cap.max}`} (overrides account).`;
  }
  if (cap.capSource === 'demo') return 'Demo account · no leverage cap.';
  if (cap.capSource === 'account') return `Account leverage: 1:${cap.max}.`;
  return `System default: 1:${cap.max}.`;
};

export interface LeverageChip {
  label: string;
  value: number;
  locked: boolean;
  isUnl: boolean;
  active: boolean;
}

/** The six preset chips. */
export const leverageChips = (max: number, leverage: number): LeverageChip[] => {
  const isUnlimited = leverage >= UNLIMITED_THRESHOLD;
  const unlockedUnlimited = max >= UNLIMITED_THRESHOLD;
  const chips = [
    { label: '1:1', value: 1, locked: false, isUnl: false },
    { label: '1:10', value: 10, locked: 10 > max, isUnl: false },
    { label: '1:100', value: 100, locked: 100 > max, isUnl: false },
    { label: '1:500', value: 500, locked: 500 > max, isUnl: false },
    { label: '1:1000', value: 1000, locked: 1000 > max, isUnl: false },
    { label: 'Unlimited', value: UNLIMITED_THRESHOLD, locked: !unlockedUnlimited, isUnl: true },
  ];
  return chips.map((c) => ({ ...c, active: c.isUnl ? isUnlimited : (!isUnlimited && leverage === c.value) }));
};

/** The slider's three scale marks. */
export const sliderTicks = (sliderMax: number): [string, string, string] =>
  ['1×', `${Math.round(sliderMax / 2)}×`, `${sliderMax}×`];

/* ── Spread and quotes ────────────────────────────────────────────────── */

/** The fee half of an account tier (trading.api AccountFeePlan), as this file reads it. */
export interface FeePlan {
  feeKind: string;
  feeValue: number;
  feeDisplay: string;
  defaultSpreadValue: string | null;
  defaultSpreadType: 'FIXED' | 'PERCENTAGE';
}

export interface EffectiveSpread {
  value: number;
  type: 'FIXED' | 'PERCENTAGE';
}

const hasValue = (v: unknown): boolean => v != null && String(v).trim() !== '';

/** Instrument.accountSpreads, from the typed field or the server row. */
const accountSpreadsOf = (instrument: OrderInstrument): { accountType: string; spreadValue: unknown; spreadType?: unknown }[] => {
  const typed = instrument?.accountSpreads;
  if (Array.isArray(typed)) return typed;
  const raw = instrument?.raw?.accountSpreads;
  return Array.isArray(raw) ? (raw as { accountType: string; spreadValue: unknown; spreadType?: unknown }[]) : [];
};

/**
 * The spread for the SELECTED account — backend spreadService, as the form
 * mirrors it (OrderForm.jsx `effSpread`): the instrument's per-account-tier
 * override, else the tier's plan default, else the instrument's global one.
 */
export const effectiveSpread = (
  instrument: OrderInstrument,
  accountType: string | null | undefined,
  plans: Record<string, FeePlan | undefined>,
): EffectiveSpread => {
  const at = String(accountType || '').toUpperCase();
  const ov = accountSpreadsOf(instrument).find(
    (o) => String(o?.accountType || '').toUpperCase() === at && hasValue(o?.spreadValue),
  );
  if (ov) return { value: Number(ov.spreadValue) || 0, type: String(ov.spreadType || 'FIXED').toUpperCase() === 'PERCENTAGE' ? 'PERCENTAGE' : 'FIXED' };
  const plan = plans[at];
  if (plan && hasValue(plan.defaultSpreadValue)) return { value: Number(plan.defaultSpreadValue) || 0, type: plan.defaultSpreadType || 'FIXED' };
  return { value: Number(instrument?.spreadValue) || 0, type: instrument?.spreadType === 'PERCENTAGE' ? 'PERCENTAGE' : 'FIXED' };
};

/** The instrument's global spread rule — what the order panel uses with no account in view. */
export const instrumentSpread = (instrument: OrderInstrument): EffectiveSpread =>
  ({ value: Number(instrument?.spreadValue) || 0, type: instrument?.spreadType === 'PERCENTAGE' ? 'PERCENTAGE' : 'FIXED' });

/**
 * Bid/ask from the last price and the configured spread — the matching
 * engine's own derivation for the B-book fill, which the form mirrors so the
 * quoted spread is the spread charged (OrderForm.jsx `currentBidAsk`).
 */
export const currentBidAsk = (
  instrument: Pick<Instrument, 'lastPrice'> | Partial<Instrument> | null | undefined,
  spread: EffectiveSpread,
): { bid: number; ask: number } => {
  const last = Number(instrument?.lastPrice || 0);
  if (!last) return { bid: 0, ask: 0 };
  const half = spread.value / 2;
  if (spread.type === 'PERCENTAGE') {
    return { bid: last * (1 - half), ask: last * (1 + half) };
  }
  return { bid: last - half, ask: last + half };
};

export interface SideQuotes {
  bid: number;
  ask: number;
  hasQuotes: boolean;
  /** `Math.min(pricePrecision || 2, 5)` — the cards', spread chip's and nudges' precision. */
  prec: number;
  spreadAbs: number;
  buyPct: number;
  sellPct: number;
}

/**
 * The Sell / Buy cards' prices and the sentiment split: from the
 * ADMIN-configured spread, NOT the feed's bid/ask — so the quoted spread is
 * the spread actually charged.
 */
export const sideQuotes = (instrument: OrderInstrument, spread: EffectiveSpread): SideQuotes => {
  const { bid, ask } = currentBidAsk(instrument, spread);
  const hasQuotes = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0;
  const prec = Math.min(instrument?.pricePrecision || 2, 5);
  const spreadAbs = hasQuotes ? Math.max(0, ask - bid) : 0;
  const last = Number(instrument?.lastPrice || 0);
  const buyPct = hasQuotes && (ask - bid) > 0
    ? Math.max(15, Math.min(85, ((last - bid) / (ask - bid)) * 100))
    : 50;
  return { bid, ask, hasQuotes, prec, spreadAbs, buyPct, sellPct: 100 - buyPct };
};

/* ── Pending (LIMIT tab) ──────────────────────────────────────────────── */

export interface LimitResolution {
  resolvedKind: 'LIMIT' | 'STOP' | null;
  hint: string;
  invalidReason: string;
}

export const LIMIT_EQUALS_MARKET = 'Limit price cannot be equal to current market price. Use Market order instead.';

/** What a Pending order becomes — the server's resolveLimitTabOrderType, with the helper line. */
export const resolveLimitTab = (p: {
  orderMode: OrderMode;
  price: unknown;
  side: OrderSide | null;
  bidAsk: { bid: number; ask: number };
}): LimitResolution => {
  const none: LimitResolution = { resolvedKind: null, hint: '', invalidReason: '' };
  if (p.orderMode !== 'LIMIT') return none;
  const limitPx = Number(p.price);
  if (!Number.isFinite(limitPx) || limitPx <= 0) return none;
  const { bid, ask } = p.bidAsk;
  if (!ask || !bid) return none;
  if (p.side === 'BUY') {
    if (limitPx === ask) return { resolvedKind: null, hint: '', invalidReason: LIMIT_EQUALS_MARKET };
    if (limitPx < ask) return { resolvedKind: 'LIMIT', hint: 'Buy when price drops to this level', invalidReason: '' };
    return { resolvedKind: 'STOP', hint: 'Buy when price breaks above this level', invalidReason: '' };
  }
  if (limitPx === bid) return { resolvedKind: null, hint: '', invalidReason: LIMIT_EQUALS_MARKET };
  if (limitPx > bid) return { resolvedKind: 'LIMIT', hint: 'Sell when price rises to this level', invalidReason: '' };
  return { resolvedKind: 'STOP', hint: 'Sell when price breaks below this level', invalidReason: '' };
};

/* ── Size and cost ────────────────────────────────────────────────────── */

/** The default volume: the instrument's minimum, else 0.01. */
export const defaultQuantity = (instrument: OrderInstrument): string =>
  String(Number(instrument?.minOrderSize) || 0.01);

/** On an instrument switch, raise a volume below the new minimum. */
export const bumpToMinimum = (curr: string, instrument: OrderInstrument): string => {
  const min = Number(instrument?.minOrderSize) || 0.01;
  const n = Number(curr);
  return (!Number.isFinite(n) || n < min) ? String(min) : curr;
};

/** The volume step: one minimum lot. */
export const quantityStep = (instrument: OrderInstrument): number => Number(instrument?.minOrderSize) || 0.01;

/** −/+ on the volume. */
export const nudgeQuantity = (quantity: string, step: number, sign: 1 | -1): string => {
  const next = Math.max(0, (Number(quantity) || 0) + sign * step);
  return next ? next.toFixed(4).replace(/\.?0+$/, '') : '';
};

/** −/+ on a price by one unit of precision. */
export const nudgePrice = (current: string, refPrice: number, prec: number, sign: 1 | -1): string => {
  const pxStep = 1 / Math.pow(10, prec);
  const curr = Number(current) || Number(refPrice) || 0;
  const next = Math.max(0, curr + sign * pxStep);
  return next ? next.toFixed(prec) : '';
};

export interface OrderCost {
  refPrice: number;
  qtyNum: number;
  /** Quantity × reference price, in rupees. */
  notional: number;
  /** Notional ÷ leverage — what the platform would lock. */
  requiredMargin: number;
  remainingAfter: number;
  /** Blocks the order: "Insufficient free margin". */
  overBudget: boolean;
}

export const orderCost = (p: {
  orderMode: OrderMode;
  lastPrice: unknown;
  price: unknown;
  quantity: unknown;
  leverage: number;
  free: number;
}): OrderCost => {
  const refPrice = p.orderMode === 'MARKET' ? Number(p.lastPrice || 0) : Number(p.price || 0);
  const qtyNum = Number(p.quantity || 0);
  const notional = refPrice && qtyNum ? refPrice * qtyNum : 0;
  const requiredMargin = notional / Math.max(p.leverage, 1);
  const remainingAfter = p.free - requiredMargin;
  const overBudget = requiredMargin > 0 && remainingAfter < 0;
  return { refPrice, qtyNum, notional, requiredMargin, remainingAfter, overBudget };
};

/** The risk calculator: risk % of free over the stop distance. */
export const riskCalc = (free: number, riskPct: unknown, stopDistance: unknown): { riskAmt: number; recommendedQty: number } => {
  const riskAmt = free * (Number(riskPct) || 0) / 100;
  const dist = Number(stopDistance) || 0;
  return { riskAmt, recommendedQty: dist > 0 ? (riskAmt / dist) : 0 };
};

/** MCX's lot unit, from the typed field or the server row. */
const contractUnitOf = (instrument: OrderInstrument): string | null => {
  const v = instrument?.contractUnit ?? instrument?.raw?.contractUnit;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

/**
 * Label and sub-line of the Volume field. F&O counts UNITS (lots × lot
 * size) — "Volume (1 lot = 75)", "Volume (1 lot = 100 bbl)" for MCX — with
 * the lot equivalent under it.
 */
export const volumeField = (instrument: OrderInstrument, qtyNum: number): { label: string; subtext: string | null; suffix: string; placeholder: string } => {
  const isDeriv = instrument?.segment === 'FUT' || instrument?.segment === 'OPT';
  const lotSz = Number(instrument?.lotSize) || 1;
  const lots = isDeriv && qtyNum > 0 ? qtyNum / lotSz : 0;
  const unit = contractUnitOf(instrument);
  return {
    label: isDeriv ? `Volume (1 lot = ${lotSz}${unit ? ` ${unit}` : ''})` : 'Volume',
    subtext: isDeriv && lots > 0 ? `= ${trimNum(lots, 2)} lot${lots === 1 ? '' : 's'}` : null,
    suffix: isDeriv ? 'Units' : 'Lots',
    placeholder: instrument?.minOrderSize ? String(instrument.minOrderSize) : '0.01',
  };
};

/** A grouped number with at most `dp` decimals and no trailing zeros ("2", "1.5", "12,500"). */
export const trimNum = (n: number, dp: number): string =>
  fmtNum(n, dp).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');

/* ── Indian cash equity and order safety ──────────────────────────────── */

/** Delivery vs Intraday — NSE/BSE cash equity only. */
export const isIndianEquity = (instrument: OrderInstrument): boolean =>
  instrument?.segment === 'EQ' && (instrument?.exchange === 'NSE' || instrument?.exchange === 'BSE');

export const PRODUCT_OPTIONS: readonly { id: Extract<ProductType, 'DELIVERY' | 'INTRADAY'>; label: string; hint: string }[] = [
  { id: 'DELIVERY', label: 'Delivery', hint: '1x · full cash' },
  { id: 'INTRADAY', label: 'Intraday', hint: '5x · auto sq-off 3:15' },
];

/** Exchanges whose tick / circuit / freeze rules the form checks — the server's list. */
export const INDIAN_SAFETY_EXCHANGES: readonly string[] = ['NSE', 'BSE', 'NFO', 'BFO', 'MCX'];

const has = (v: unknown): boolean => !!Number(v);

/** "Circuit 2400–2600  ·  Max 1800/order", or null. */
export const circuitHint = (instrument: OrderInstrument): string | null => {
  if (!instrument || !INDIAN_SAFETY_EXCHANGES.includes(String(instrument.exchange ?? ''))) return null;
  if (!has(instrument.upperCircuit) && !has(instrument.freezeQty)) return null;
  const band = has(instrument.lowerCircuit) && has(instrument.upperCircuit)
    ? `Circuit ${String(instrument.lowerCircuit)}–${String(instrument.upperCircuit)}`
    : '';
  const freeze = has(instrument.freezeQty)
    ? `${has(instrument.upperCircuit) ? '  ·  ' : ''}Max ${String(instrument.freezeQty)}/order`
    : '';
  return `${band}${freeze}`;
};

/** Is new exposure switched off for this symbol? `=== false` on purpose. */
export const isTradingDisabled = (instrument: OrderInstrument): boolean => instrument?.tradingEnabled === false;

/** The banner (and toast) when it is — closing an open position still works. */
export const TRADING_DISABLED_MESSAGE = 'Trading is disabled for this instrument. You can still close open positions.';
export const tradingDisabledBanner = (instrument: OrderInstrument): string =>
  `Trading is disabled for ${instrument?.symbol || 'this instrument'}. You can still close open positions.`;

/* ── Fees (an estimate — PORT-RULINGS §6) ─────────────────────────────── */

/** "₹12.34" — every fee, margin and notional is rupees (OrderForm.jsx `fmtQuote`). */
export const fmtQuote = (v: number): string => fmtMoney(v);

/** feeType.js FEE_TYPE_META — which column a fee kind belongs under. */
const FEE_TYPE_META: Readonly<Record<string, { group: 'Commission' | 'Charges'; label: string }>> = {
  PERCENTAGE: { group: 'Commission', label: 'Percentage' },
  PCT_OF_VALUE: { group: 'Commission', label: 'Percentage' },
  FIXED: { group: 'Charges', label: 'Fixed' },
  FIXED_PER_TRADE: { group: 'Charges', label: 'Fixed' },
  PCT_OF_PROFIT: { group: 'Charges', label: 'Percentage of Profit' },
};

export const feeTypeMeta = (code: string | null | undefined): { group: 'Commission' | 'Charges'; label: string } | null =>
  FEE_TYPE_META[String(code || '').toUpperCase()] ?? null;

/** The account's fee tier — legacy and unknown types fall back to STANDARD. */
export const feePlanFor = (
  accountType: string | null | undefined,
  plans: Record<string, FeePlan | undefined>,
): FeePlan | null => plans[String(accountType || '').toUpperCase()] ?? plans.STANDARD ?? null;

export interface FeeEstimate {
  /** null when there is no size yet, or a component (a profit-based charge) is unknown. */
  feeEstimate: number | null;
  /** A profit-based charge that cannot be known until the trade closes. */
  chargesPending: boolean;
  /** The "?" tip, one line per row, as the web joins it. */
  feeHelp: string;
}

/**
 * Total Fee = Commission + Charges + Spread Cost (+ the NSE statutory
 * pass-through for Indian cash equity) — OrderForm.jsx's unified breakdown.
 * The single account-tier fee lands in exactly ONE bucket by its kind:
 * PCT_OF_VALUE → Commission (notional × value), FIXED_PER_TRADE → Charges
 * (flat), PCT_OF_PROFIT → Charges, "Pending" until the trade closes. A
 * preview only: the booked charge is the server's.
 */
export const feeEstimate = (p: {
  instrument: OrderInstrument;
  notional: number;
  qtyNum: number;
  productType: ProductType;
  quotes: Pick<SideQuotes, 'hasQuotes' | 'spreadAbs' | 'prec'>;
  plan: FeePlan | null;
}): FeeEstimate => {
  const inst = p.instrument;
  const hasQty = p.qtyNum > 0 && p.notional > 0;
  const spreadCost = p.quotes.hasQuotes && p.qtyNum > 0 ? p.quotes.spreadAbs * p.qtyNum : 0;

  const feeKind = String(p.plan?.feeKind || '').toUpperCase();
  const feeValue = Number(p.plan?.feeValue ?? 0) || 0;
  const feeGroup = feeTypeMeta(feeKind)?.group ?? null;
  const feeRule = p.plan?.feeDisplay || '';

  let commissionAmt = 0;
  let chargesAmt = 0;
  let chargesPending = false;
  if (feeGroup === 'Commission') {
    if (hasQty) commissionAmt = p.notional * feeValue;
  } else if (feeGroup === 'Charges') {
    if (feeKind === 'PCT_OF_PROFIT') chargesPending = hasQty;
    else if (hasQty) chargesAmt = feeValue;
  }

  const isIndianEq = inst?.exchange === 'NSE' || inst?.exchange === 'BSE';
  let statutory = 0;
  let statutoryLines: string[] = [];
  if (isIndianEq && hasQty) {
    const delivery = p.productType === 'DELIVERY';
    const sttRate = delivery ? 0.001 : 0.00025;
    const stt = p.notional * sttRate;
    const exch = p.notional * 0.0000297;
    const sebi = p.notional * 0.000001;
    const gst = (commissionAmt + chargesAmt + exch + sebi) * 0.18;
    statutory = stt + exch + sebi + gst;
    statutoryLines = [
      'Statutory charges (NSE est.)',
      `• STT (${delivery ? '0.1% both legs' : '0.025% sell'}): ${fmtQuote(stt)}`,
      `• Exchange + SEBI: ${fmtQuote(exch + sebi)}`,
      `• GST (18%): ${fmtQuote(gst)}`,
    ];
  }

  const knownTotal = commissionAmt + chargesAmt + spreadCost + statutory;
  const feeHelp = [
    'Total Fee = Commission + Charges + Spread Cost',
    'Commission',
    `• ${feeGroup === 'Commission' && feeRule ? feeRule : '—'}: ${fmtQuote(commissionAmt)}`,
    'Charges',
    `• ${feeGroup === 'Charges' && feeRule ? feeRule : '—'}: ${chargesPending ? 'Pending — 1% of realised profit at close' : fmtQuote(chargesAmt)}`,
    'Spread Cost',
    `• (ask − bid) ₹${p.quotes.spreadAbs.toFixed(p.quotes.prec)} × ${p.qtyNum || 0} qty: ${fmtQuote(spreadCost)}`,
    ...statutoryLines,
    '──────────',
    `Total ≈ ${chargesPending ? 'Pending' : fmtQuote(knownTotal)}`,
  ].join('\n');

  return {
    feeEstimate: !hasQty ? null : (chargesPending ? null : knownTotal),
    chargesPending,
    feeHelp,
  };
};

/* ── The bottom info rows ─────────────────────────────────────────────── */

/** Fees · Leverage · Margin — values and "?" tips. */
export const infoRows = (p: {
  fees: FeeEstimate;
  leverage: number;
  cap: LeverageCap;
  requiredMargin: number;
}): { label: string; value: string; help: string }[] => [
  {
    label: 'Fees',
    value: p.fees.feeEstimate != null ? `≈ ${fmtQuote(p.fees.feeEstimate)}` : (p.fees.chargesPending ? 'Pending' : EMPTY),
    help: p.fees.feeHelp,
  },
  { label: 'Leverage', value: leverageLabel(p.leverage), help: leverageCapHelp(p.cap) },
  {
    label: 'Margin',
    value: p.requiredMargin > 0 ? fmtQuote(p.requiredMargin) : EMPTY,
    help: 'Locked while the position is open.',
  },
];

/* ── Submitting ───────────────────────────────────────────────────────── */

export interface SubmitCheck {
  instrument: OrderInstrument;
  side: OrderSide | null;
  hasAccount: boolean;
  quantity: string;
  orderMode: OrderMode;
  price: string;
  limitInvalidReason: string;
}

/**
 * Everything submit() refuses before it asks for confirmation, in the web's
 * order and with its words. Null = go ahead. F&O lot multiples, option
 * writing and switched-off segments are the server's to refuse
 * (INVALID_LOT_SIZE / OPTION_WRITE_NOT_SUPPORTED / SEGMENT_DISABLED) — the
 * web does not pre-check them either.
 */
export const preSubmitError = (p: SubmitCheck): string | null => {
  const inst = p.instrument;
  if (!p.side) return 'Select Buy or Sell first';
  if (isTradingDisabled(inst)) return TRADING_DISABLED_MESSAGE;
  if (!p.hasAccount) return 'No trading account selected';
  if (!p.quantity || Number(p.quantity) <= 0) return 'Enter a valid quantity';
  if (p.orderMode === 'LIMIT') {
    if (!p.price || Number(p.price) <= 0) return 'Enter a valid limit price';
    if (p.limitInvalidReason) return p.limitInvalidReason;
  }
  // Indian order safety — the server's tick size, circuit band and freeze quantity.
  if (INDIAN_SAFETY_EXCHANGES.includes(String(inst?.exchange ?? ''))) {
    const tick = Number(inst?.tickSize) || 0;
    const uc = Number(inst?.upperCircuit) || 0;
    const lc = Number(inst?.lowerCircuit) || 0;
    const fz = Number(inst?.freezeQty) || 0;
    const px = p.orderMode === 'LIMIT' ? Number(p.price) : 0;
    // A band side counts only while credible (as the server): not inverted,
    // and the live price has not already crossed it.
    const ltp = Number(inst?.lastPrice) || 0;
    const bandSane = !(uc > 0 && lc > 0 && uc <= lc);
    const ucOk = uc > 0 && bandSane && !(ltp > uc);
    const lcOk = lc > 0 && bandSane && !(ltp > 0 && ltp < lc);
    if (px > 0) {
      if (tick > 0 && Math.abs(px / tick - Math.round(px / tick)) > 1e-6) return `Price must be in multiples of ${tick}`;
      if (ucOk && px > uc) return `Price above today's upper circuit (${uc})`;
      if (lcOk && px < lc) return `Price below today's lower circuit (${lc})`;
    }
    if (fz > 0 && Number(p.quantity) > fz) return `Max ${fz} per order (freeze limit) for ${inst?.symbol}`;
  }
  return null;
};

/** The confirmation question. */
export const confirmMessage = (p: {
  side: OrderSide;
  quantity: string;
  instrument: OrderInstrument;
  orderMode: OrderMode;
  price: string;
  leverage: number;
}): string => {
  const sideLabel = p.side === 'BUY' ? 'Buy' : 'Sell';
  const modeLabel = p.orderMode === 'LIMIT' ? `LIMIT @ ${p.price}` : 'MARKET';
  // `|| symbol`: the web prints "undefined" for an instrument with no base currency.
  const asset = p.instrument?.baseCurrency || p.instrument?.symbol || '';
  return `Confirm ${sideLabel} ${p.quantity} ${asset} (${modeLabel}) with 1:${p.leverage} leverage?`;
};

/**
 * The order request, shaped exactly as OrderForm.jsx shapes the body.
 * trading.api `buildOrderPayload` turns it into the posted JSON.
 */
export const buildOrderRequest = (p: {
  accountId: string;
  symbol: string;
  side: OrderSide;
  orderMode: OrderMode;
  quantity: string;
  leverage: number;
  price: string;
  productType: ProductType;
  indianEquity: boolean;
  stopLoss: string;
  takeProfit: string;
  idempotencyKey: string;
}): PlaceOrderRequest => {
  const req: PlaceOrderRequest = {
    accountId: p.accountId,
    symbol: p.symbol,
    side: p.side,
    orderMode: p.orderMode,
    quantity: p.quantity,
    leverage: p.leverage,
    idempotencyKey: p.idempotencyKey,
  };
  if (p.orderMode === 'LIMIT') req.price = p.price;
  if (p.indianEquity) req.productType = p.productType;
  // "0" is a threshold that never triggers — skip it.
  if (Number(p.stopLoss) > 0) req.stopLoss = p.stopLoss;
  if (Number(p.takeProfit) > 0) req.takeProfit = p.takeProfit;
  return req;
};

/** "✓ Buy 75 NIFTYFUT — Order FILLED". */
export const placedToastText = (p: { side: OrderSide; quantity: string; symbol: string; status: string }): string =>
  `✓ ${p.side === 'BUY' ? 'Buy' : 'Sell'} ${p.quantity} ${p.symbol} — Order ${p.status}`;

/** The primary button's words. */
export const ctaLabel = (p: {
  tradingDisabled: boolean;
  loading: boolean;
  side: OrderSide | null;
  quantity: string;
}): string => {
  if (p.tradingDisabled) return 'Trading Disabled';
  if (p.loading) return 'Placing…';
  if (!p.side) return 'Select Buy or Sell';
  return `Confirm ${p.side === 'BUY' ? 'Buy' : 'Sell'}${p.quantity ? ` ${p.quantity} lots` : ''}`;
};

/** When the primary button is dead. */
export const ctaDisabled = (p: {
  loading: boolean;
  overBudget: boolean;
  limitInvalidReason: string;
  side: OrderSide | null;
  tradingDisabled: boolean;
}): boolean =>
  p.loading || p.overBudget || !!p.limitInvalidReason || !p.side || p.tradingDisabled;

/* ── Banners and small print ──────────────────────────────────────────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** An instrument-override expiry as "10 Jun 2026 22:00 UTC". */
export const fmtOverrideTime = (d: string | number | Date | null | undefined): string => {
  if (d === null || d === undefined) return '';
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return '';
  return `${pad2(t.getUTCDate())} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()} ${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())} UTC`;
};

/**
 * The F&O expiry line: "10 Jun 2026 · 3d left", or "· expired". The date in
 * the device's time zone; `warn` inside the last two days.
 */
export const expiryLine = (instrument: OrderInstrument, now: number = Date.now()): { date: string; text: string; warn: boolean } | null => {
  if (!instrument?.expiryDate || (instrument.segment !== 'FUT' && instrument.segment !== 'OPT')) return null;
  const exp = new Date(instrument.expiryDate);
  if (Number.isNaN(exp.getTime())) return null;
  const days = Math.ceil((exp.getTime() - now) / 86400000);
  const date = `${pad2(exp.getDate())} ${MONTHS[exp.getMonth()]} ${exp.getFullYear()}`;
  return { date, text: `${date}${days >= 0 ? ` · ${days}d left` : ' · expired'}`, warn: days <= 2 && days >= 0 };
};

/**
 * The order drawer's header price — StockDetail.jsx `cur` + `fmtNum(lastPrice,
 * prec)`: always rupees. An absent price is a dash, not "0.00".
 */
export const drawerPrice = (instrument: OrderInstrument): string => {
  const prec = Math.min(instrument?.pricePrecision || 2, 5);
  const n = fmtPrice(instrument?.lastPrice, prec);
  return n === EMPTY ? n : `${currencySymbol()}${n}`;
};

/** An account amount — the web's `fmtAcct` (₹). */
export const fmtAcct = (v: number): string => fmtMoney(v);

/** The Notional row — the web's `fmtQuoteAmt` (₹). */
export const fmtQuoteAmt = (v: number): string => fmtMoney(v);

/**
 * Digits and one decimal point — the browser's `type="number"` filter, which
 * a phone keyboard does not apply. `allowNegative` lets a TP/SL distance
 * start with "-", as the web's number input does.
 */
export const sanitizeDecimal = (raw: string, allowNegative = false): string => {
  let s = String(raw).replace(/,/g, '.');
  const neg = allowNegative && s.trim().startsWith('-');
  s = s.replace(/[^0-9.]/g, '');
  const dot = s.indexOf('.');
  if (dot >= 0) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
  return neg ? `-${s}` : s;
};

/** The order-entry modes of the top dropdown. */
export const OPEN_ORDER_MODE_OPTIONS: readonly { value: 'regular' | 'oneClick' | 'riskCalc'; label: string }[] = [
  { value: 'regular', label: 'Regular form' },
  { value: 'oneClick', label: 'One-click form' },
  { value: 'riskCalc', label: 'Risk calculator' },
];

export const ORDER_MODE_TABS: readonly { id: OrderMode; label: string }[] = [
  { id: 'MARKET', label: 'Market' },
  { id: 'LIMIT', label: 'Pending' },
];

/**
 * The free balance of the account the form trades on (OrderForm.jsx
 * fetchFree): the account's own row, else its base-currency row, else the
 * first — `free`, falling back to `balance`. null while nothing has loaded.
 */
export const accountFreeFrom = (
  rows: readonly { accountId?: string; currency?: string; free?: string | null; balance?: string | null }[] | null | undefined,
  account: Pick<TradingAccount, 'id' | 'baseCurrency'> | null | undefined,
): string | null => {
  if (!rows) return null;
  const w = rows.find((b) => !!account && String(b.accountId) === String(account.id))
    ?? rows.find((b) => !!account && b.currency === account.baseCurrency)
    ?? rows[0];
  return w?.free ?? w?.balance ?? '0';
};
