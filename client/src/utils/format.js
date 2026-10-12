export const fmtNum = (v, decimals = 2) => {
  const n = Number(v);
  if (!isFinite(n)) return '0';
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
};

export const fmtPrice = (v, precision = 2) => fmtNum(v, precision);

// Defaults to USD: wallets are USD-denominated and every account schema
// defaults to USD, so a rupee default mislabels the common case.
export const currencySymbol = (currency = 'USD') => {
  // USDT / BTC carry real symbols. Without them the fallback returned the CODE
  // itself ('USDT ', 'BTC ') as the "symbol" — 4-5 characters wide, which
  // collided with the number in every amount input and money cell.
  const map = { INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥', USDT: '₮', BTC: '₿' };
  return map[currency] || (currency + ' ');
};

export const fmtMoney = (v, currency = 'USD') => `${currencySymbol(currency)}${fmtNum(v, 2)}`;

export const fmtPnl = (v, currency = 'USD') => {
  const n = Number(v);
  const sign = n > 0 ? '+' : '';
  return `${sign}${currencySymbol(currency)}${fmtNum(Math.abs(n), 2) * (n < 0 ? -1 : 1) === 0 ? '0.00' : fmtNum(n, 2)}`;
};

// Simpler PnL formatting that handles negative correctly
export const fmtPnlSimple = (v, currency = 'USD') => {
  const n = Number(v);
  if (!isFinite(n)) return `${currencySymbol(currency)}0.00`;
  const sign = n >= 0 ? '+' : '-';
  const abs = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${currencySymbol(currency)}${abs}`;
};

export const fmtDate = (d) => {
  if (!d) return '-';
  return new Date(d).toLocaleString('en-IN');
};

export const fmtTime = (d) => {
  if (!d) return '-';
  return new Date(d).toLocaleTimeString('en-IN');
};

/**
 * Compact money formatter — USD-primary, matching what the wallets hold.
 *   { primary: '$1,204.82', secondary: '', primaryRaw, secondaryRaw }
 *
 * The fxRate converts INR-sourced numbers into USD. It used to run the other
 * way and was documented as "INR-primary across the app", so a USD balance was
 * multiplied into rupees for display while the account itself was in dollars.
 * Signature is unchanged so call sites don't need touching.
 *
 * Sign-aware: negatives keep their sign; `withSign=true` adds a leading
 * '+' on positives (useful for PnL display).
 */
export const fmtMoneyDual = (value, sourceCurrency = 'USD', fxRate = 83, withSign = false) => {
  const n = Number(value);
  if (!isFinite(n)) {
    return { primary: '$0.00', secondary: '', primaryRaw: 0, secondaryRaw: 0 };
  }
  const sign = withSign && n > 0 ? '+' : (n < 0 ? '-' : '');
  const abs = Math.abs(n);
  const rate = Number(fxRate || 0) > 0 ? Number(fxRate) : 83;

  let usdAbs;
  if (sourceCurrency === 'USD') {
    usdAbs = abs;
  } else if (sourceCurrency === 'INR') {
    usdAbs = abs / rate;
  } else {
    // Unknown source currency — display native (no FX conversion).
    return {
      primary: `${sign}${currencySymbol(sourceCurrency)}${fmtNum(abs, 2)}`,
      secondary: '',
      primaryRaw: n,
      secondaryRaw: 0,
    };
  }

  const signedUsd = usdAbs * (n < 0 ? -1 : 1);
  return {
    primary: `${sign}$${fmtNum(usdAbs, 2)}`,
    secondary: '',
    primaryRaw: signedUsd,
    secondaryRaw: signedUsd,
  };
};

/**
 * Both-currency money formatter — used on the headline "final total"
 * summary cards (Wallet equity, Funds real-balance / demo-balance hero
 * cards, Dashboard top-line balance, Account cards, PnL summaries).
 *
 * USD-first display policy:
 *   { primary: '$1,204.82', secondary: '≈ ₹1,00,000.00 INR' }
 *
 * Primary is USD (large), secondary the rupee approximation (small,
 * prefixed with ≈). This was the other way round — "India-first", with
 * rupees dominant — which disagreed with the wallets it was summarising:
 * balances are USD-denominated and every account defaults to USD, so the
 * headline figure was the converted one and the stored one was the footnote.
 * Conversion uses the live `fxRate` passed from the `useFxRate` hook.
 *
 * Everywhere ELSE (PnL columns, chart info-strip, per-account rows) we
 * stick with the USD-only `fmtMoneyDual`. This helper is intentionally
 * narrow — reserved for the visually dominant total amounts.
 */
export const fmtMoneyBoth = (value, sourceCurrency = 'USD', fxRate = 83, withSign = false, showAlt = true) => {
  const n = Number(value);
  if (!isFinite(n)) {
    return { primary: '$0.00', secondary: '≈ ₹0.00 INR', primaryRaw: 0, secondaryRaw: 0 };
  }
  const sign = withSign && n > 0 ? '+' : (n < 0 ? '-' : '');
  const abs = Math.abs(n);
  const rate = Number(fxRate || 0) > 0 ? Number(fxRate) : 83;

  let usdAbs;
  let inrAbs;
  if (sourceCurrency === 'USD') {
    usdAbs = abs;
    inrAbs = abs * rate;
  } else if (sourceCurrency === 'INR') {
    inrAbs = abs;
    usdAbs = abs / rate;
  } else {
    // Unknown source currency — display native as primary, no INR convert.
    return {
      primary: `${sign}${currencySymbol(sourceCurrency)}${fmtNum(abs, 2)}`,
      secondary: '',
      primaryRaw: n,
      secondaryRaw: 0,
    };
  }

  const signedUsd = usdAbs * (n < 0 ? -1 : 1);
  const signedInr = inrAbs * (n < 0 ? -1 : 1);
  return {
    // USD is the dominant figure — it is what the wallet actually holds.
    // The rupee line reads as an approximate conversion beneath it, and is
    // dropped when the caller is already showing USD as the chosen display
    // currency, where it adds a second currency nobody asked to see.
    primary: `${sign}$${fmtNum(usdAbs, 2)}`,
    secondary: showAlt ? `≈ ${sign}₹${fmtNum(inrAbs, 2)} INR` : '',
    primaryRaw: signedUsd,
    secondaryRaw: signedInr,
  };
};

/**
 * Price formatter — USD-primary for every instrument. Returns:
 *   { primary: '$60,000.00', secondary: '', primaryRaw, secondaryRaw }
 *
 * - USD-quoted instruments: primary = the native USD price (decimals
 *   honored, e.g. 5 for forex).
 * - INR-quoted instruments: converted to USD via fxRate.
 * - Other quotes (EUR/GBP/JPY/etc): kept in native currency since we
 *   don't have cross-rates yet — same fallback behaviour as before.
 */
export const fmtPriceDual = (price, quoteCurrency = 'USD', fxRate = 83, decimals = 2) => {
  const n = Number(price);
  if (!isFinite(n)) return { primary: '-', secondary: '', primaryRaw: 0, secondaryRaw: 0 };
  if (quoteCurrency === 'USD') {
    return {
      primary: `$${fmtNum(n, decimals)}`,
      secondary: '',
      primaryRaw: n,
      secondaryRaw: n,
    };
  }
  if (quoteCurrency === 'INR') {
    // Native INR-quoted instruments (NSE/BSE cash) — show ₹ directly. These are
    // already in rupees; converting to USD would be wrong (₹1500 ≠ $18).
    return {
      primary: `₹${fmtNum(n, decimals)}`,
      secondary: '',
      primaryRaw: n,
      secondaryRaw: n,
    };
  }
  // Other quote currencies (JPY / EUR / GBP / CHF / etc.). The numeric value IS
  // the FX rate for the pair (e.g. EUR/JPY 184.837 means 1 EUR = 184.837 JPY) —
  // that's what the trader acts on. We keep the raw number and show it with the
  // pair's OWN quote-currency symbol (¥ / € / £ / …) so a JPY-quoted price reads
  // "¥184.885", not a misleading "$184.885".
  return {
    primary: `${currencySymbol(quoteCurrency)}${fmtNum(n, decimals)}`,
    secondary: '',
    primaryRaw: n,
    secondaryRaw: n,
  };
};
