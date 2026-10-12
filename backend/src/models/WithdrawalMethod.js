const mongoose = require('mongoose');

/**
 * WithdrawalMethod — a user's SAVED payout destination that money can be sent to.
 *
 * Core business rule: a real withdrawal may ONLY target a method this user has
 * saved AND that an admin has moved to VERIFIED. The user can never type an
 * arbitrary bank / UPI / wallet at withdraw time — the destination is resolved
 * server-side from one of these records (see walletController.requestWithdrawal).
 *
 * Lifecycle:  PENDING → VERIFIED (usable) | REJECTED | BLOCKED.
 * Editing a verified destination is NOT allowed (§8) — the user archives the old
 * method and adds a new one, which re-enters verification. `archived` soft-hides
 * a method without deleting it, so historical withdrawal snapshots stay intact.
 *
 * Sensitive values (full account number, wallet address) are stored here but are
 * NEVER returned raw to the frontend — use `toSafeJSON()` (masked). The full
 * destination is only ever copied into the Withdrawal via `destinationSnapshot()`
 * at request time, server-side.
 */

const WITHDRAWAL_METHOD_TYPES = ['BANK', 'UPI', 'CRYPTO', 'CUSTOM'];
const WITHDRAWAL_METHOD_STATUS = ['PENDING', 'VERIFIED', 'REJECTED', 'BLOCKED'];

const withdrawalMethodSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: WITHDRAWAL_METHOD_TYPES, required: true },
    // User-friendly name, e.g. "HDFC Salary", "Personal UPI", "USDT TRC20".
    label: { type: String, required: true, trim: true, maxlength: 60 },
    status: { type: String, enum: WITHDRAWAL_METHOD_STATUS, default: 'PENDING', index: true },
    // Fast boolean mirror of (status === 'VERIFIED'); kept in sync on every
    // status change so hot-path checks don't have to string-compare.
    isVerified: { type: Boolean, default: false },
    // Soft archive (§8: change destination = archive old + add new). Archived
    // methods are hidden from the user + never selectable for a withdrawal.
    archived: { type: Boolean, default: false, index: true },

    // ── BANK ──
    accountHolderName: String,
    bankName: String,
    accountNumber: String, // sensitive — never returned raw
    ifsc: String,
    // ── UPI ──
    upiId: String,
    // ── CRYPTO ──
    network: String,       // ERC20 / TRC20 / BEP20 / BTC
    walletAddress: String, // sensitive — never returned raw
    // ── CUSTOM (admin-defined rail) ──
    // Which admin rail this belongs to — deposit.paymentDetails.custom[].id.
    // The field SCHEMA lives in admin config; the values live in `details`.
    methodKey: { type: String, index: true },
    // key -> value for each field the admin asked the user for.
    details: { type: Map, of: String, default: undefined },
    // Which of those keys were marked sensitive WHEN THIS WAS SAVED.
    // Snapshotted, not re-read from admin config: un-ticking "sensitive"
    // later must not retroactively unmask values already given under a
    // promise of masking.
    sensitiveKeys: { type: [String], default: undefined },

    // Verification / moderation audit trail.
    verifiedAt: Date,
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectedReason: String,
    blockedReason: String,
    // Set every time this method is used to create a withdrawal (admin visibility).
    lastUsedAt: Date,
  },
  { timestamps: true }
);

// Suggested indexes (§10). `userId` alone is already covered by the field-level
// `index: true`; these add the compound lookups the queries actually use.
withdrawalMethodSchema.index({ userId: 1, status: 1 });
withdrawalMethodSchema.index({ userId: 1, type: 1 });

/* ── masking helpers (never leak full sensitive values) ─────────────── */
const last4 = (s) => String(s || '').slice(-4);
const maskUpi = (id) => {
  const s = String(id || '');
  const at = s.indexOf('@');
  if (at <= 0) return s ? `${s.slice(0, 2)}****` : '';
  const name = s.slice(0, at);
  return `${name.slice(0, 2)}****${s.slice(at)}`;
};
const maskAddr = (a) => {
  const s = String(a || '');
  return s.length > 12 ? `${s.slice(0, 6)}...${s.slice(-4)}` : s ? `${s.slice(0, 2)}****` : '';
};

// Plain object of the filled fields, sensitive ones masked. Used by the
// frontend view; the unmasked values never leave destinationSnapshot().
withdrawalMethodSchema.methods.safeDetails = function safeDetails() {
  if (!this.details) return undefined;
  const sens = new Set(this.sensitiveKeys || []);
  const out = {};
  for (const [k, v] of this.details) out[k] = sens.has(k) ? maskAddr(v) : v;
  return out;
};

// One-line masked destination for lists / admin tables.
withdrawalMethodSchema.methods.maskedDestination = function maskedDestination() {
  if (this.type === 'BANK') return `${this.bankName || 'Bank'} ****${last4(this.accountNumber)}`;
  if (this.type === 'UPI') return maskUpi(this.upiId);
  if (this.type === 'CRYPTO') return `${this.network || ''} ${maskAddr(this.walletAddress)}`.trim();
  if (this.type === 'CUSTOM') {
    const d = this.details ? Object.fromEntries(this.details) : {};
    const sens = new Set(this.sensitiveKeys || []);
    const keys = Object.keys(d);
    // Prefer a sensitive field — that is the account identifier, and the
    // one worth showing (masked). Otherwise the first value the user gave.
    const k = keys.find((x) => sens.has(x)) || keys[0];
    if (!k) return this.label || '';
    return sens.has(k) ? maskAddr(d[k]) : String(d[k]);
  }
  return '';
};

// FULL destination — server-side only. Copied verbatim into the Withdrawal at
// request time so a later edit/delete of the method can't change a pending payout.
withdrawalMethodSchema.methods.destinationSnapshot = function destinationSnapshot() {
  const base = { methodId: String(this._id), type: this.type, label: this.label };
  if (this.type === 'BANK') {
    return { ...base, accountHolderName: this.accountHolderName, bankName: this.bankName, accountNumber: this.accountNumber, ifsc: this.ifsc };
  }
  if (this.type === 'UPI') return { ...base, upiId: this.upiId };
  if (this.type === 'CRYPTO') return { ...base, network: this.network, walletAddress: this.walletAddress };
  if (this.type === 'CUSTOM') {
    return {
      ...base,
      methodKey: this.methodKey,
      details: this.details ? Object.fromEntries(this.details) : {},
    };
  }
  return base;
};

// Frontend-safe view — masked, no raw account number / wallet address.
withdrawalMethodSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: String(this._id),
    type: this.type,
    label: this.label,
    status: this.status,
    isVerified: this.isVerified,
    archived: this.archived,
    maskedDestination: this.maskedDestination(),
    // Non-sensitive display bits only.
    bankName: this.type === 'BANK' ? this.bankName : undefined,
    network: this.type === 'CRYPTO' ? this.network : undefined,
    methodKey: this.type === 'CUSTOM' ? this.methodKey : undefined,
    details: this.type === 'CUSTOM' ? this.safeDetails() : undefined,
    verifiedAt: this.verifiedAt,
    rejectedReason: this.status === 'REJECTED' ? this.rejectedReason : undefined,
    lastUsedAt: this.lastUsedAt,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

const WithdrawalMethod = mongoose.model('WithdrawalMethod', withdrawalMethodSchema);
WithdrawalMethod.TYPES = WITHDRAWAL_METHOD_TYPES;
WithdrawalMethod.STATUS = WITHDRAWAL_METHOD_STATUS;

module.exports = WithdrawalMethod;
