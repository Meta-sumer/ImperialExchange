// Wallet-ledger rows a user never sees in their own Transaction History or
// ledger export. Trades live in Trade History only, so their wallet postings
// stay out of the user's money history: margin lock/release, close P&L, the
// trading fee, and every desk adjustment tied to a trade (edit, delete,
// restore), plus the stop-out sweep and negative-balance top-up. Deposits,
// withdrawals, transfers, credit, subscription and copy-trading rows stay.
// Admin views and reconciliation read the ledger unfiltered.
const TRADE_TYPES = ['TRADE_OPEN', 'TRADE_CLOSE'];
const TRADE_REFERENCES = ['order', 'trade', 'position', 'STOP_OUT_MARGIN_SWEEP', 'NEGATIVE_BALANCE_PROTECTION'];

const withoutTradeRows = (filter) => ({
  ...filter,
  $nor: [{ type: { $in: TRADE_TYPES } }, { referenceType: { $in: TRADE_REFERENCES } }],
});

module.exports = { withoutTradeRows, TRADE_TYPES, TRADE_REFERENCES };
