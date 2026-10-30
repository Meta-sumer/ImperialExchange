// EquityHub is INR-only: every wallet, account, fee and instrument amount the
// API returns is in Indian rupees. All money formatting lives here so pages
// share one rupee symbol and one Indian digit grouping (1,23,456.78).

export const CURRENCY = 'INR';
export const CURRENCY_SYMBOL = '₹';

export const fmtNum = (v, decimals = 2) => {
  const n = Number(v);
  if (!isFinite(n)) return '0';
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
};

export const fmtPrice = (v, precision = 2) => fmtNum(v, precision);

// Kept as a function so existing callers that pass a currency code keep
// working; the argument is ignored because rupees are the only currency.
// eslint-disable-next-line no-unused-vars
export const currencySymbol = (_currency) => CURRENCY_SYMBOL;

/** "₹1,23,456.78" / "-₹12.30". The currency argument is ignored (INR only). */
// eslint-disable-next-line no-unused-vars
export const fmtMoney = (v, _currency, decimals = 2) => {
  const n = Number(v);
  if (!isFinite(n)) return `${CURRENCY_SYMBOL}${fmtNum(0, decimals)}`;
  return `${n < 0 ? '-' : ''}${CURRENCY_SYMBOL}${fmtNum(Math.abs(n), decimals)}`;
};

/** Rupee amount with whole-rupee precision, e.g. "₹1,00,000". */
export const fmtInr = (v, decimals = 2) => fmtMoney(v, CURRENCY, decimals);

/** P&L formatting: always signed, e.g. "+₹1,200.00" / "-₹45.50". */
// eslint-disable-next-line no-unused-vars
export const fmtPnl = (v, _currency) => {
  const n = Number(v);
  if (!isFinite(n) || n === 0) return `${CURRENCY_SYMBOL}0.00`;
  return `${n > 0 ? '+' : '-'}${CURRENCY_SYMBOL}${fmtNum(Math.abs(n), 2)}`;
};

// eslint-disable-next-line no-unused-vars
export const fmtPnlSimple = (v, _currency) => {
  const n = Number(v);
  if (!isFinite(n)) return `${CURRENCY_SYMBOL}0.00`;
  return `${n >= 0 ? '+' : '-'}${CURRENCY_SYMBOL}${fmtNum(Math.abs(n), 2)}`;
};

export const fmtDate = (d) => {
  if (!d) return '-';
  return new Date(d).toLocaleString('en-IN');
};

export const fmtTime = (d) => {
  if (!d) return '-';
  return new Date(d).toLocaleTimeString('en-IN');
};

const inrResult = (n, withSign, decimals = 2) => {
  const sign = withSign && n > 0 ? '+' : (n < 0 ? '-' : '');
  return {
    primary: `${sign}${CURRENCY_SYMBOL}${fmtNum(Math.abs(n), decimals)}`,
    secondary: '',
    primaryRaw: n,
    secondaryRaw: n,
  };
};

/**
 * Legacy name kept for existing callers. Returns
 *   { primary: '₹1,204.82', secondary: '', primaryRaw, secondaryRaw }
 * The source-currency and fx-rate arguments are ignored: amounts are INR.
 * `withSign=true` adds a leading '+' on positives (for P&L).
 */
// eslint-disable-next-line no-unused-vars
export const fmtMoneyDual = (value, _sourceCurrency, _fxRate, withSign = false) => {
  const n = Number(value);
  return inrResult(isFinite(n) ? n : 0, withSign);
};

/** Legacy name kept for existing callers — identical to fmtMoneyDual (INR only). */
// eslint-disable-next-line no-unused-vars
export const fmtMoneyBoth = (value, _sourceCurrency, _fxRate, withSign = false) => {
  const n = Number(value);
  return inrResult(isFinite(n) ? n : 0, withSign);
};

/** Instrument price in rupees: { primary: '₹2,450.50', secondary: '', ... }. */
// eslint-disable-next-line no-unused-vars
export const fmtPriceDual = (price, _quoteCurrency, _fxRate, decimals = 2) => {
  const n = Number(price);
  if (!isFinite(n)) return { primary: '-', secondary: '', primaryRaw: 0, secondaryRaw: 0 };
  return inrResult(n, false, decimals);
};

/**
 * Compact rupee amount using Indian units: ₹950, ₹12.5K, ₹3.2L, ₹1.4Cr.
 * Whole-rupee amounts below 1,000 are shown without decimals.
 */
export const fmtInrCompact = (v) => {
  const n = Number(v);
  if (!isFinite(n)) return `${CURRENCY_SYMBOL}0`;
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  const unit = (div, suffix) => {
    const x = a / div;
    return `${sign}${CURRENCY_SYMBOL}${x.toFixed(x % 1 === 0 ? 0 : 1)}${suffix}`;
  };
  if (a >= 1e7) return unit(1e7, 'Cr');
  if (a >= 1e5) return unit(1e5, 'L');
  if (a >= 1e3) return unit(1e3, 'K');
  return `${sign}${CURRENCY_SYMBOL}${Math.round(a).toLocaleString('en-IN')}`;
};
