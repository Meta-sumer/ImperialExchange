const systemSettings = require('../services/systemSettings.service');
const { AppError } = require('./errors');

/**
 * Admin-configurable deposit rails. The admin panel writes exactly these keys
 * (plus `custom[]`) into `deposit.paymentDetails`, each with an optional
 * `enabled` flag — absent/true = shown, false = hidden from the picker.
 */
const FIXED_METHOD_IDS = ['UPI', 'BANK', 'CRYPTO', 'SKRILL', 'NETELLER', 'RAZORPAY'];

/** Display names, so a refusal reads "Skrill", not the storage key "SKRILL". */
const FIXED_METHOD_LABELS = {
  UPI: 'UPI',
  BANK: 'Bank transfer',
  CRYPTO: 'Crypto',
  SKRILL: 'Skrill',
  NETELLER: 'Neteller',
  RAZORPAY: 'Razorpay',
};

/**
 * Pseudo-methods that are NOT payment providers and never appear in the admin
 * blob: internal book transfers and demo top-ups. They must stay allowed or the
 * instant trading-account → wallet transfer and demo funding would break.
 */
const INTERNAL_METHOD_IDS = new Set(['TRADING', 'DEMO', 'VIRTUAL', 'INTERNAL', 'BONUS']);

const _norm = (v) => String(v == null ? '' : v).trim().toUpperCase();

/**
 * Is this rail open for `kind` ('deposit' | 'withdrawal')?
 *
 * Deposit and withdrawal are separate switches. They used to share one
 * `enabled` flag, so turning a rail off for deposits silently closed it for
 * payouts as well — an admin who wanted to stop accepting UPI deposits also
 * stopped being able to pay anyone out over UPI, with nothing on screen
 * saying so.
 *
 * `withdrawalEnabled` absent falls back to `enabled` so an existing config
 * behaves exactly as before until the admin touches the withdrawal switch.
 */
/**
 * Rails that settle domestically, and in what, when the admin has said
 * nothing. UPI and NEFT/IMPS are Indian rails: they cannot pay a USD
 * balance out as USD, so INR is the sane default.
 *
 * It is only a DEFAULT. It used to be a hard rule in the withdrawal
 * controller that the admin's own settings could not reach, so a rail they
 * had listed currencies on was still refused anything but INR.
 */
const DOMESTIC_RAIL_CURRENCIES = { UPI: ['INR'], BANK: ['INR'] };

/**
 * The storage key for one admin-defined withdrawal field.
 *
 * Admin types a LABEL ("Wallet address"); the value the user fills is stored
 * under a slug of it. Derived rather than required so a field added without
 * an explicit key still works, and shared from here so the admin UI, the
 * client form and this server all agree — if they disagreed, a user would
 * fill one key and the server would look for another.
 */
// Rails that have their own columns on WithdrawalMethod and their own
// validated form. Every OTHER rail — Skrill, Neteller, and anything the
// admin adds — stores its destination generically in `details`.
const NATIVE_DESTINATION_RAILS = new Set(['UPI', 'BANK', 'CRYPTO']);

// Used when the admin has switched a rail on for withdrawals without saying
// what to collect. Showing the rail with one generic input beats hiding it:
// a Shown toggle that silently does nothing reads as a broken switch.
const DEFAULT_WITHDRAWAL_FIELDS = [
  { label: 'Account / address', required: true, sensitive: true },
];

/**
 * The fields a payout to `railId` needs from the user, or null when the rail
 * has its own columns and its own form.
 *
 * Shared so the server that validates a submission and the client that draws
 * the form cannot disagree about which fields exist.
 */
function withdrawalSchema(railId, cfg) {
  const given = Array.isArray(cfg && cfg.withdrawalFields)
    ? cfg.withdrawalFields.filter((f) => f && f.label)
    : [];
  // An admin-defined schema wins on ANY rail. Without this the editor shown
  // for UPI / Bank / Crypto would collect labels the server ignored.
  if (given.length) return given;
  // Untouched native rail → it keeps its own columns and its own validators
  // (IFSC length, '@' in a UPI id, per-network address format). Those checks
  // only apply to the fixed columns, so a rail the admin HAS configured runs
  // the generic path and is validated against their labels instead.
  if (NATIVE_DESTINATION_RAILS.has(String(railId || '').toUpperCase())) return null;
  return DEFAULT_WITHDRAWAL_FIELDS;
}

function withdrawalFieldKey(f) {
  return String((f && (f.key || f.label)) || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/**
 * Which currencies this rail pays out in — the admin's list if they set
 * one, else the domestic default, else null for "no restriction".
 * Shared so the picker and the gate cannot disagree.
 */
function withdrawalCurrencies(cfg, methodId) {
  const listed = Array.isArray(cfg?.supportedCurrencies) && cfg.supportedCurrencies.length
    ? cfg.supportedCurrencies.map((c) => String(c).toUpperCase())
    : null;
  if (listed) return listed;
  return DOMESTIC_RAIL_CURRENCIES[String(methodId || "").toUpperCase()] || null;
}

function railEnabled(cfg, kind) {
  if (!cfg) return true;
  if (String(kind).toLowerCase() === 'withdrawal') {
    return cfg.withdrawalEnabled === undefined || cfg.withdrawalEnabled === null
      ? cfg.enabled !== false
      : cfg.withdrawalEnabled !== false;
  }
  return cfg.enabled !== false;
}

/**
 * Per-method transaction limits, all denominated in the platform BASE currency
 * (USD) and all optional — 0 or absent means "no limit".
 *
 * USD, not the currency the user typed in, because the same rail serves every
 * currency: the old client-side minimum was a bare number compared against
 * whatever was in the amount box, so "500" meant ₹500 on an INR withdrawal and
 * $500 on a USD one — a 96× difference from one dropdown change, with nothing
 * on the server checking either. Storing one USD figure and converting it for
 * display is the only way a limit means the same thing to every user.
 */
const LIMIT_KEYS = ['minDeposit', 'maxDeposit', 'minWithdrawal', 'maxWithdrawal'];

/** Normalise a stored limit: a positive finite number, else 0 (= no limit). */
const limitValue = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * The USD limits configured for a method, as { min, max }. `kind` is
 * 'deposit' or 'withdrawal'. Missing config → no limits.
 */
function methodLimits(cfg, kind) {
  const w = String(kind).toLowerCase() === 'withdrawal';
  return {
    min: limitValue(cfg && cfg[w ? 'minWithdrawal' : 'minDeposit']),
    max: limitValue(cfg && cfg[w ? 'maxWithdrawal' : 'maxDeposit']),
  };
}

/**
 * Enforce a method's admin-configured per-transaction limits.
 *
 * @param {string} method        the submitted method (fixed id or custom label)
 * @param {'deposit'|'withdrawal'} kind
 * @param {number|string} baseAmountUsd  the amount already converted to USD
 * @param {object} [display]     { currency, amount } to phrase the error in the
 *                               user's own currency instead of USD
 */
async function assertWithinLimits(method, kind, baseAmountUsd, display) {
  const usd = Number(baseAmountUsd);
  if (!Number.isFinite(usd)) return; // nothing to compare against
  const resolved = await resolveMethod(method);
  const { min, max } = methodLimits(resolved && resolved.cfg, kind);
  if (!min && !max) return;

  const label = (resolved && resolved.label) || method;
  const word = String(kind).toLowerCase() === 'withdrawal' ? 'Withdrawal' : 'Deposit';
  // Show the limit in the SAME currency the user typed, so they don't have to
  // do the conversion themselves to understand the refusal.
  const asTyped = (limitUsd) => {
    const cur = display && display.currency;
    const amt = Number(display && display.amount);
    if (!cur || cur === 'USD' || !Number.isFinite(amt) || amt <= 0 || usd <= 0) {
      return `${limitUsd.toFixed(2)} USD`;
    }
    return `${(limitUsd * (amt / usd)).toFixed(2)} ${cur} (${limitUsd.toFixed(2)} USD)`;
  };

  if (min && usd < min) {
    throw new AppError(
      `Minimum ${word.toLowerCase()} for ${label} is ${asTyped(min)}.`,
      400,
      kind === 'withdrawal' ? 'BELOW_METHOD_MIN_WITHDRAWAL' : 'BELOW_METHOD_MIN_DEPOSIT'
    );
  }
  if (max && usd > max) {
    throw new AppError(
      `Maximum ${word.toLowerCase()} for ${label} is ${asTyped(max)} per transaction.`,
      400,
      kind === 'withdrawal' ? 'ABOVE_METHOD_MAX_WITHDRAWAL' : 'ABOVE_METHOD_MAX_DEPOSIT'
    );
  }
}

/**
 * Every payment method the user is actually allowed to deposit through, built
 * the SAME way the "Add funds" picker builds its list: enabled fixed rails +
 * enabled custom rails. This is the single source of truth both sides read, so
 * the UI can no longer offer something the server would take.
 *
 * @returns {Promise<Array<{id:string,label:string,enabled:boolean,cfg:object}>>}
 */
async function listPaymentMethods() {
  const details = (await systemSettings.getSetting('deposit.paymentDetails')) || {};
  const out = [];
  for (const id of FIXED_METHOD_IDS) {
    const cfg = details[id];
    if (!cfg) continue;
    out.push({
      id, label: FIXED_METHOD_LABELS[id] || id,
      enabled: cfg.enabled !== false,
      withdrawalEnabled: railEnabled(cfg, 'withdrawal'),
      cfg,
    });
  }
  for (const c of Array.isArray(details.custom) ? details.custom : []) {
    if (!c || !c.label) continue;
    out.push({
      id: String(c.id), label: String(c.label),
      enabled: c.enabled !== false,
      withdrawalEnabled: railEnabled(c, 'withdrawal'),
      cfg: c,
    });
  }
  return out;
}

/**
 * Resolve a submitted `method` to its admin config.
 *
 * Fixed rails arrive as their id ('SKRILL'). Custom rails arrive as their
 * LABEL — every client sends `custom.label`, not `custom.id` — so matching on
 * id alone silently resolved custom methods to nothing, which is why the
 * per-method currency restriction never fired for them.
 *
 * @returns {Promise<{id:string,label:string,enabled:boolean,cfg:object}|null>}
 */
async function resolveMethod(method) {
  const want = _norm(method);
  if (!want) return null;
  const all = await listPaymentMethods();
  return all.find((m) => _norm(m.id) === want) || all.find((m) => _norm(m.label) === want) || null;
}

/**
 * Config blob for a method, or null. Kept for the fee/currency helpers that
 * only care about the settings and not about whether the rail is open.
 */
async function getMethodConfig(method) {
  const m = await resolveMethod(method);
  return m ? m.cfg : null;
}

/**
 * Gate a deposit on the admin's show/hide toggle.
 *
 * The picker hides a disabled rail, but hiding is cosmetic and arrives late:
 * `deposit.paymentDetails` is fetched after the form renders, so on a slow
 * connection the full hard-coded list is on screen first and a user can pick —
 * and submit — a rail the admin turned off. Nothing on the server said no, so
 * deposits landed for methods the business does not even have an account with.
 *
 * Throws 400 unless `method` is an enabled rail (or an internal pseudo-method).
 */
async function assertMethodAllowed(method, kind = 'deposit') {
  const want = _norm(method);
  if (!want) throw new AppError('Payment method is required', 400, 'PAYMENT_METHOD_REQUIRED');
  if (INTERNAL_METHOD_IDS.has(want)) return null;

  const all = await listPaymentMethods();
  const match = all.find((m) => _norm(m.id) === want) || all.find((m) => _norm(m.label) === want);
  if (!match) {
    throw new AppError(
      `${method} is not an available payment method.`,
      400,
      'PAYMENT_METHOD_UNAVAILABLE'
    );
  }
  const isWd = String(kind).toLowerCase() === 'withdrawal';
  if (!(isWd ? match.withdrawalEnabled : match.enabled)) {
    throw new AppError(
      `${match.label} is not accepting ${isWd ? 'withdrawals' : 'deposits'} right now. Please choose another payment method.`,
      400,
      'PAYMENT_METHOD_DISABLED'
    );
  }
  return match;
}

/**
 * Keys that survive on a SWITCHED-OFF rail. Everything else — the payee
 * details: UPI id, account number, IFSC, wallet address, Skrill/Neteller
 * email, QR, custom fields, notes — is withheld.
 *
 * This is an allowlist so a payee field added to the admin panel later is
 * withheld by default rather than leaking until someone remembers to add it.
 *
 * Fee and currency config stays: the WITHDRAWAL form reads
 * withdrawalFeePercent/withdrawalFeeFixed out of this same blob, and hiding a
 * rail from the deposit picker must not silently zero a withdrawal fee.
 */
// `enabled` (deposit) and `withdrawalEnabled` are independent, so a rail can
// be closed for deposits and open for payouts. Its withdrawalFields must
// survive the strip or the user gets the rail with no form to fill in.
const DISABLED_METHOD_PUBLIC_KEYS = [
  'enabled', 'withdrawalEnabled', 'id', 'label', 'emoji', 'min',
  'feePercent', 'feeFixed', 'withdrawalFeePercent', 'withdrawalFeeFixed',
  'supportedCurrencies', 'withdrawalFields',
  ...LIMIT_KEYS,
];

const _stripDisabled = (cfg) => {
  if (!cfg || typeof cfg !== 'object') return cfg;
  if (cfg.enabled !== false) return cfg;
  const out = {};
  for (const k of DISABLED_METHOD_PUBLIC_KEYS) if (k in cfg) out[k] = cfg[k];
  out.enabled = false;
  return out;
};

/**
 * The user-facing view of `deposit.paymentDetails`.
 *
 * A rail the admin switched off is still listed — the clients need the
 * `enabled: false` flag to filter it out, and an absent key reads as "on" by
 * the blob's own convention — but it carries no destination. So even if some
 * surface renders a hidden rail, there is nothing there to pay into.
 */
function publicPaymentDetails(details) {
  const src = details && typeof details === 'object' ? details : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'custom') continue;
    out[k] = _stripDisabled(v);
  }
  if (Array.isArray(src.custom)) out.custom = src.custom.map(_stripDisabled);
  return out;
}

/**
 * A method restricts currencies only when it has a NON-EMPTY
 * supportedCurrencies list (blank/absent = every currency allowed).
 */
async function assertCurrencySupported(method, code) {
  if (!method) return;
  const cfg = await getMethodConfig(method);
  const list = Array.isArray(cfg && cfg.supportedCurrencies) ? cfg.supportedCurrencies : [];
  if (list.length && !list.includes(String(code).toUpperCase())) {
    throw new AppError(`${code} is not supported by this payment method`, 400, 'CURRENCY_NOT_SUPPORTED');
  }
}

/**
 * Every admin rail rule that applies to a payout, in one call, plus the fee
 * and the net the admin should actually send.
 *
 * The Main Wallet and the Bonus Wallet ran none of this: their withdrawals
 * accepted a rail the admin had switched off, ignored the per-method
 * min/max entirely, and charged no withdrawal fee — so a setting configured
 * once applied to trading-account payouts and silently to nothing else.
 *
 * Both wallets are USD-denominated, so `usdAmount` is both the requested
 * amount and its base value.
 *
 * @returns {Promise<{fee: string, net: string}>} USD
 */
/**
 * Which currency a rail pays out in, from the admin's own list.
 *
 *   no list        -> the base currency (no restriction configured)
 *   list with USD  -> USD (the wallet currency, no conversion needed)
 *   list without   -> the first currency the admin listed
 *
 * So a rail set to INR pays INR, a rail set to USD pays USD, and a rail
 * the admin never restricted pays the base. One setting decides, for
 * every method.
 */
function payoutCurrency(cfg, base = 'USD') {
  const list = Array.isArray(cfg?.supportedCurrencies)
    ? cfg.supportedCurrencies.map((c) => String(c || '').toUpperCase()).filter(Boolean)
    : [];
  if (!list.length) return base;
  return list.includes(base) ? base : list[0];
}

async function preparePayout(method, usdAmount) {
  const amt = Number(usdAmount);
  await assertMethodAllowed(method, 'withdrawal');

  // The rail's own currency, per the admin's list — not a hard-coded USD.
  const resolved = await resolveMethod(method);
  const payCcy = payoutCurrency(resolved && resolved.cfg, 'USD');
  await assertCurrencySupported(method, payCcy);

  // Limits and the fee stay in USD: they are STORED in the base currency
  // so one figure means the same thing on every rail (see LIMIT_KEYS).
  // Only the display inside a refusal is converted.
  const fx = require('../services/fxService');
  // fxService refuses to invent a 1:1 rate for money movement — paying ₹100
  // where ₹8,300 is owed is worse than refusing. Its error is generic, so it
  // is restated here naming the currency and where to fix it.
  let conv;
  try {
    conv = await fx.fromUsd(payCcy, amt, 'withdrawal');
  } catch (e) {
    if (e && e.code === 'MISSING_RATE') {
      throw new AppError(
        `No exchange rate is configured for ${payCcy}, so this method cannot pay out yet. Set one in Admin → Payments → Currency exchange.`,
        400,
        'MISSING_EXCHANGE_RATE'
      );
    }
    throw e;
  }
  await assertWithinLimits(method, 'withdrawal', amt, { currency: payCcy, amount: conv.amount });

  // Lazy require: withdrawalFee resolves methods through THIS module.
  const { computeWithdrawalFee } = require('./withdrawalFee');
  const fee = Number(await computeWithdrawalFee(method, amt));
  const net = Math.max(0, Math.round((amt - fee) * 100) / 100);

  // `fee` / `net` are USD (what leaves the wallet). `payout*` is what the
  // user actually receives and what the admin has to send.
  //
  // The converted FEE is derived as gross − net rather than converted on its
  // own, so the three figures always reconcile exactly. Rounding each one
  // independently lets them disagree by a cent, and an admin paying out from a
  // row whose parts do not add up has to guess which one is right.
  const payoutNet = await fx.fromUsd(payCcy, net, 'withdrawal');
  const payoutFee = Math.max(0, Math.round((conv.amount - payoutNet.amount) * 100) / 100);
  return {
    fee: String(fee),
    net: String(net),
    payoutCurrency: payCcy,
    payoutAmount: String(conv.amount),
    payoutFeeAmount: String(payoutFee),
    payoutNetAmount: String(payoutNet.amount),
    fxRate: conv.rate,
  };
}

module.exports = {
  FIXED_METHOD_IDS,
  LIMIT_KEYS,
  limitValue,
  methodLimits,
  assertWithinLimits,
  railEnabled,
  payoutCurrency,
  withdrawalFieldKey,
  withdrawalSchema,
  NATIVE_DESTINATION_RAILS,
  DEFAULT_WITHDRAWAL_FIELDS,
  DOMESTIC_RAIL_CURRENCIES,
  withdrawalCurrencies,
  assertCurrencySupported,
  preparePayout,
  FIXED_METHOD_LABELS,
  INTERNAL_METHOD_IDS,
  listPaymentMethods,
  resolveMethod,
  getMethodConfig,
  assertMethodAllowed,
  publicPaymentDetails,
  DISABLED_METHOD_PUBLIC_KEYS,
};
