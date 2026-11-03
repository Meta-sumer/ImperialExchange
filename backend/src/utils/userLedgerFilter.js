// Wallet-ledger rows a user never sees in their own Transaction History or
// ledger export. Trades live in Trade History only, so their wallet postings
// stay out of the user's money history: margin lock/release, close P&L, the
// trading fee, and every desk adjustment tied to a trade (edit, delete,
// restore), plus the stop-out sweep and negative-balance top-up. A deposit an
// admin reversed (confirmed by mistake) is hidden with its reversal, since the
// two net to zero. Deposits, withdrawals, transfers, credit, subscription and
// copy-trading rows stay. Admin views and reconciliation read the ledger
// unfiltered.
const TRADE_TYPES = ['TRADE_OPEN', 'TRADE_CLOSE'];
const HIDDEN_REFERENCES = ['order', 'trade', 'position', 'STOP_OUT_MARGIN_SWEEP', 'NEGATIVE_BALANCE_PROTECTION', 'deposit_reversal'];

// hiddenRefIds: ids of the user's REVERSED deposits (their DEPOSIT rows go too).
const userLedgerFilter = (filter, hiddenRefIds = []) => {
  const nor = [{ type: { $in: TRADE_TYPES } }, { referenceType: { $in: HIDDEN_REFERENCES } }];
  if (hiddenRefIds.length) nor.push({ referenceId: { $in: hiddenRefIds } });
  return { ...filter, $nor: nor };
};

// The user's reversed deposit ids, for userLedgerFilter.
const reversedDepositIds = async (userId) => {
  const { Deposit } = require('../models/index');
  return Deposit.find({ userId, status: 'REVERSED' }).distinct('_id');
};

module.exports = { userLedgerFilter, reversedDepositIds, TRADE_TYPES, HIDDEN_REFERENCES };
