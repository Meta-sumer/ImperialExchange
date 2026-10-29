const mongoose = require('mongoose');

// Largest accepted QR image (data URL). ~300 KB of PNG base64-encodes to
// roughly this; far below the 16 MB document ceiling.
const QR_MAX = 400 * 1024;

/**
 * A company bank account that receives customer deposits.
 *
 * Several of these form the deposit pool: each customer is assigned ONE
 * (User.depositBankAccountId) and sees only that account's details on the
 * deposit page, so incoming transfers are spread across accounts instead of
 * piling onto a single one. See services/bankAssignment.js for the
 * least-loaded assignment logic and controllers/bankAccountController.js
 * for the Super Admin management endpoints.
 *
 * Deactivated accounts are kept (audit trail, historical deposits) but never
 * receive new assignments; users still pointing at one are moved to the
 * least-loaded active account on their next deposit-details read.
 */
const bankAccountSchema = new mongoose.Schema(
  {
    label:         { type: String, required: true, trim: true, maxlength: 60 },   // short admin-facing name
    bankName:      { type: String, default: '', trim: true, maxlength: 120 },
    accountName:   { type: String, default: '', trim: true, maxlength: 120 },     // beneficiary
    accountNumber: { type: String, default: '', trim: true, maxlength: 40, index: true },
    ifsc:          { type: String, default: '', trim: true, uppercase: true, maxlength: 20 },
    branch:        { type: String, default: '', trim: true, maxlength: 120 },
    upiId:         { type: String, default: '', trim: true, maxlength: 80 },      // optional UPI handle on this account
    note:          { type: String, default: '', trim: true, maxlength: 500 },     // shown under the details
    qr:            { type: String, default: '', maxlength: QR_MAX },              // image URL or data:image URI
    isActive:      { type: Boolean, default: true, index: true },
    createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BankAccount', bankAccountSchema);
module.exports.QR_MAX = QR_MAX;
