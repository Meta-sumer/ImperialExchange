const mongoose = require('mongoose');
const { BASE_CURRENCY } = require('../config/constants');
const { sub } = require('../utils/decimal');

/**
 * CreditTransaction — a deposit or withdrawal an admin processed "on credit".
 *
 * The wallet moves at creation (a DEPOSIT credits the trading wallet, a
 * WITHDRAWAL debits it) and the row then tracks the real-world money that is
 * still owed: for a DEPOSIT the user owes the platform, for a WITHDRAWAL the
 * platform owes the user. `settledAmount` grows with each recorded payment
 * until it reaches `amount`; `outstanding` is the difference.
 *
 * Money fields are decimal strings like the rest of the money layer.
 */
const CREDIT_KIND = Object.freeze({ DEPOSIT: 'DEPOSIT', WITHDRAWAL: 'WITHDRAWAL' });
const CREDIT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PARTIALLY_SETTLED: 'PARTIALLY_SETTLED',
  SETTLED: 'SETTLED',
  CANCELLED: 'CANCELLED',
});
// Statuses that still carry an outstanding balance.
const OPEN_STATUSES = [CREDIT_STATUS.PENDING, CREDIT_STATUS.PARTIALLY_SETTLED];

const settlementSchema = new mongoose.Schema({
  amount: { type: String, required: true },
  at: { type: Date, default: Date.now },
  byId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  remarks: { type: String, default: '' },
});

const creditTransactionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount', required: true },
    walletId: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet', default: null },
    kind: { type: String, enum: Object.values(CREDIT_KIND), required: true },
    amount: { type: String, required: true },
    currency: { type: String, default: BASE_CURRENCY },
    settledAmount: { type: String, default: '0' },
    status: { type: String, enum: Object.values(CREDIT_STATUS), default: CREDIT_STATUS.PENDING, index: true },
    // Admin remark written when the credit was granted (shown to the user).
    remarks: { type: String, default: '' },
    dueDate: { type: Date, default: null },
    // Every recorded payment against this credit, newest last.
    settlements: [settlementSchema],
    // The WalletLedger row of the initial wallet movement.
    ledgerId: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletLedger', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    settledAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelRemarks: { type: String, default: '' },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

creditTransactionSchema.virtual('outstanding').get(function outstanding() {
  return sub(this.amount, this.settledAmount || '0');
});

creditTransactionSchema.index({ userId: 1, status: 1 });
creditTransactionSchema.index({ status: 1, createdAt: -1 });

const CreditTransaction = mongoose.model('CreditTransaction', creditTransactionSchema);

module.exports = CreditTransaction;
module.exports.CREDIT_KIND = CREDIT_KIND;
module.exports.CREDIT_STATUS = CREDIT_STATUS;
module.exports.OPEN_STATUSES = OPEN_STATUSES;
