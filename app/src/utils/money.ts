import type { Decimal } from '@/types/trading';

/**
 * Money and number formatting — client/src/utils/format.js and
 * hooks/useMoney.js.
 *
 * ── EQUITYHUB IS INR-ONLY ─────────────────────────────────────────────
 * Every wallet, account, fee, P&L and instrument amount the API returns is
 * already in Indian rupees (backend BASE_CURRENCY = 'INR'; /fx answers rate
 * 1 and refuses any other currency). So, as on the web:
 *
 *   - the symbol is always ₹ (`currencySymbol` ignores its argument), and
 *   - grouping is always Indian: 12,34,567.89.
 *
 * The `currency` parameters are kept so existing callers keep compiling;
 * they no longer change the output. format.js does the same ("the argument
 * is ignored because rupees are the only currency").
 *
 * ── WHERE THIS DELIBERATELY DIFFERS FROM THE WEB ──────────────────────
 * 1. A missing figure (null / undefined / '' / NaN) renders as EMPTY (—),
 *    not as ₹0.00. A zero standing in for "unknown" reads as "you have
 *    nothing" on a money screen.
 * 2. Grouping is written out instead of `toLocaleString('en-IN')`: React
 *    Native's Intl support varies by platform and build, and a formatter
 *    that silently stops grouping on one device is worse than none.
 * ──────────────────────────────────────────────────────────────────────
 */

/** Shown when a figure is genuinely absent — never a zero standing in. */
export const EMPTY = '—';

/** format.js CURRENCY / CURRENCY_SYMBOL. */
export const CURRENCY = 'INR';
export const CURRENCY_SYMBOL = '₹';

/**
 * format.js currencySymbol — always ₹. Kept as a function so callers that
 * pass a currency code keep working.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const currencySymbol = (_currency?: string | null): string => CURRENCY_SYMBOL;

/** Indian grouping puts the first separator at 3 digits and then every 2. */
const groupIndian = (whole: string): string => {
  if (whole.length <= 3) return whole;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
};

const group = (value: string): string => {
  const [whole = '0', frac] = value.split('.');
  const grouped = groupIndian(whole);
  return frac ? `${grouped}.${frac}` : grouped;
};

const toNumberOrNull = (value: Decimal | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

/** format.js fmtNum — a plain number with Indian grouping, no symbol. */
export const fmtNum = (
  value: Decimal | number | null | undefined,
  decimals = 2,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _currency?: string | null,
): string => {
  const n = toNumberOrNull(value);
  if (n === null) return EMPTY;
  const body = group(Math.abs(n).toFixed(decimals));
  // "-0.00" is not a loss.
  return n < 0 && /[1-9]/.test(body) ? `-${body}` : body;
};

/**
 * format.js fmtMoney — "₹1,23,456.78" / "-₹12.30". The sign leads, then the
 * symbol, never "₹-12.30".
 */
export const fmtMoney = (
  value: Decimal | number | null | undefined,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _currency?: string | null,
  decimals = 2,
): string => {
  const n = toNumberOrNull(value);
  if (n === null) return EMPTY;
  const body = group(Math.abs(n).toFixed(decimals));
  const sign = n < 0 && /[1-9]/.test(body) ? '-' : '';
  return `${sign}${CURRENCY_SYMBOL}${body}`;
};

/** format.js fmtInr — `fmtMoney` under its rupee name. */
export const fmtInr = (value: Decimal | number | null | undefined, decimals = 2): string =>
  fmtMoney(value, CURRENCY, decimals);

/**
 * format.js fmtPnl — "+₹1,200.00" / "-₹45.50", and a plain "₹0.00" for
 * zero: a "+₹0.00" reads as a small win rather than as nothing happening.
 */
export const fmtPnl = (
  value: Decimal | number | null | undefined,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _currency?: string | null,
  decimals = 2,
): string => {
  const n = toNumberOrNull(value);
  if (n === null) return EMPTY;
  const body = fmtMoney(Math.abs(n), CURRENCY, decimals);
  if (/[1-9]/.test(body) && n > 0) return `+${body}`;
  if (/[1-9]/.test(body) && n < 0) return `-${body}`;
  return body;
};

/**
 * useMoney().signed — always carries a sign, "+" included at zero: for P&L
 * where the web writes `signed(v)`. ("-₹12.30", "+₹0.00".)
 */
export const fmtSigned = (value: Decimal | number | null | undefined, decimals = 2): string => {
  const n = toNumberOrNull(value);
  if (n === null) return EMPTY;
  return `${n < 0 ? '-' : '+'}${fmtMoney(Math.abs(n), CURRENCY, decimals)}`;
};

/**
 * format.js fmtPrice — an instrument price, Indian grouping. The currency
 * argument is kept for callers; every price on the platform is rupees.
 */
export const fmtPrice = (
  value: Decimal | number | null | undefined,
  precision = 2,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _currency?: string | null,
): string => fmtNum(value, precision);

/**
 * format.js fmtInrCompact — ₹950, ₹12.5K, ₹3.2L, ₹1.4Cr. Whole rupees below
 * a thousand, no decimals.
 */
export const fmtInrCompact = (value: Decimal | number | null | undefined): string => {
  const n = toNumberOrNull(value);
  if (n === null) return EMPTY;
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  const unit = (div: number, suffix: string): string => {
    const x = a / div;
    return `${sign}${CURRENCY_SYMBOL}${x.toFixed(x % 1 === 0 ? 0 : 1)}${suffix}`;
  };
  if (a >= 1e7) return unit(1e7, 'Cr');
  if (a >= 1e5) return unit(1e5, 'L');
  if (a >= 1e3) return unit(1e3, 'K');
  return `${sign}${CURRENCY_SYMBOL}${group(String(Math.round(a)))}`;
};

export const fmtPercent = (
  value: number | null | undefined,
  decimals = 2,
): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
};

/**
 * Margin level. `'0'` from the server means NO MARGIN IN USE, which is an
 * absence rather than a level of zero — so it renders as a dash, not "0%".
 * See docs/PORT-RULINGS.md §1.
 */
export const fmtMarginLevel = (value: Decimal | number | null | undefined): string => {
  const n = toNumberOrNull(value);
  if (n === null || n === 0) return EMPTY;
  // Past a few thousand percent the digits stop carrying meaning.
  if (n >= 10_000) return '>9999%';
  return `${fmtNum(n, 2)}%`;
};

export const fmtLeverage = (leverage: number | null | undefined): string =>
  (leverage && Number.isFinite(leverage) ? `1:${leverage}` : EMPTY);
