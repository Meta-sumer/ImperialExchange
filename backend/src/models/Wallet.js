const mongoose = require('mongoose');
const { WALLET_TX_TYPE } = require('../config/constants');

const walletSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount', required: true, index: true },
    currency: { type: String, required: true },
    // Stored as string to preserve decimal precision; convert to Decimal for arithmetic.
    balance: { type: String, default: '0' },
    locked: { type: String, default: '0' }, // Reserved for open orders / margin
  },
  { timestamps: true }
);

walletSchema.index({ userId: 1, accountId: 1, currency: 1 }, { unique: true });

const ledgerSchema = new mongoose.Schema(
  {
    walletId: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount', required: true },
    type: { type: String, enum: Object.values(WALLET_TX_TYPE), required: true },
    currency: { type: String, required: true },
    amount: { type: String, required: true }, // signed string decimal (positive credit, negative debit)
    // Realized (MT-style) balance snapshots around this row — the settled
    // wallet balance (NOT floating equity) before and after the mutation, so
    // the transaction history reads as a continuous per-wallet ledger where
    // each row's `balanceAfter` equals the next row's `balanceBefore`. Trade
    // OPEN leaves balance unchanged (margin only moves to `locked`), so its
    // before == after. `balanceBefore` is not required (legacy rows predate it
    // → the UI falls back to `balanceAfter − amount`).
    balanceBefore: { type: String },
    balanceAfter: { type: String, required: true },
    referenceType: String, // 'order', 'trade', 'position', 'withdrawal', 'deposit'
    referenceId: { type: mongoose.Schema.Types.ObjectId },
    // Idempotency key. When set, the sparse unique index ensures a duplicate
    // settlement insert (e.g. two concurrent close requests, or a worker
    // racing the controller) is rejected with E11000 — the second insert
    // becomes a no-op so PnL can never be double-credited. Format examples:
    //   "TRADE_SETTLE:<tradeId>"   one settle per fill
    //   "POSITION_SETTLE:<posId>"  one settle per position close
    dedupeKey: { type: String },
    note: String,
    createdAt: { type: Date, default: Date.now, immutable: true },
  },
  { timestamps: false }
);

ledgerSchema.index({ userId: 1, createdAt: -1 });
// getLedger enriches INTERNAL_TRANSFER rows by looking up the paired row via
// { referenceId: { $in: [...] }, userId: { $ne }, type: { $in } }. referenceId had
// NO index, so that lookup scanned the ENTIRE ledger — the fastest-growing
// collection here, since every trade settle, margin lock/release, deposit and
// withdrawal appends a row. It fires whenever a user's last 100 ledger rows
// contain any internal transfer, i.e. routinely, on the Wallet page.
// Sparse: most rows carry no referenceId and do not belong in the index.
ledgerSchema.index({ referenceId: 1, type: 1 }, { sparse: true });
// Sparse: only documents with dedupeKey set are indexed, so legacy ledger
// rows without the key don't collide.
ledgerSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });

module.exports = {
  Wallet: mongoose.model('Wallet', walletSchema),
  WalletLedger: mongoose.model('WalletLedger', ledgerSchema),
};
