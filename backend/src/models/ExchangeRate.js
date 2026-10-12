const mongoose = require('mongoose');

/**
 * Exchange rate configuration — ONE document per quote currency, relative to the
 * platform base currency (always USD).
 *
 * Rate convention (single, unambiguous): `1 USD = <rate> <quoteCurrency>`.
 *   e.g. quoteCurrency='INR', depositRate=90  →  1 USD = ₹90.
 *
 * Separate rates by purpose so the platform can control conversion precisely:
 *   - displayRate    : used ONLY to convert USD → display currency for the UI
 *                      (balances, notional). Never touches stored balances.
 *   - depositRate    : used when converting an incoming deposit amount → USD.
 *   - withdrawalRate : used when converting a withdrawal amount ↔ USD.
 *
 * mode:
 *   - AUTO   : rates are the live online rate (frankfurter). The stored
 *              *Rate fields are treated as fallbacks only.
 *   - MANUAL : the admin-entered *Rate fields are authoritative; the online
 *              rate is NOT used.
 *
 * USD itself never needs a row (rate is always 1). Unknown currencies with no
 * row are treated 1:1 with USD (matches the pre-existing currencyService).
 */
const exchangeRateSchema = new mongoose.Schema(
  {
    // Always 'USD' for now — kept explicit so the schema is future-proof.
    baseCurrency: { type: String, default: 'USD', uppercase: true, trim: true },
    quoteCurrency: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
    // Presentation only.
    symbol: { type: String, default: '' },
    // When false, the currency is hidden from the display-currency selector and
    // rejected for deposits/withdrawals.
    enabled: { type: Boolean, default: true },

    mode: { type: String, enum: ['AUTO', 'MANUAL'], default: 'AUTO' },

    // 1 USD = <rate> <quoteCurrency>. Stored as Number (rates aren't ledger
    // money — the converted *amounts* are persisted as string-decimals on the
    // Deposit/Withdrawal docs).
    displayRate: { type: Number, default: null },
    depositRate: { type: Number, default: null },
    withdrawalRate: { type: Number, default: null },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ExchangeRate', exchangeRateSchema);
