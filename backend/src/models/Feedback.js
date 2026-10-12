const mongoose = require('mongoose');

/**
 * User-submitted feedback / support tickets. One schema, distinguished by
 * `category`. Admins triage by changing `status` (and may re-categorise).
 *
 * CATEGORIES is the single source of truth — exposed to both the client + admin
 * via GET /user/feedback/categories so neither frontend hardcodes the list, and
 * both the create + update endpoints validate against it. The legacy values
 * (BUG / FEATURE / UX / SUPPORT / OTHER) are kept in the enum so existing
 * tickets stay valid (backward compatible).
 */
const CATEGORIES = ['SUPPORT', 'BUG', 'TECHNICAL', 'ACCOUNT', 'PAYMENT', 'WITHDRAWAL', 'DEPOSIT', 'TRADING', 'FEATURE', 'UX', 'OTHER'];
const CATEGORY_LABELS = {
  SUPPORT: 'Support', BUG: 'Bug', TECHNICAL: 'Technical Issue', ACCOUNT: 'Account',
  PAYMENT: 'Payment', WITHDRAWAL: 'Withdrawal', DEPOSIT: 'Deposit', TRADING: 'Trading',
  FEATURE: 'Feature Request', UX: 'UX', OTHER: 'Other',
};

const feedbackSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    category: {
      type: String,
      enum: CATEGORIES,
      default: 'OTHER',
      index: true,
    },
    subject: { type: String, required: true, maxlength: 200 },
    message: { type: String, required: true, maxlength: 4000 },
    // Optional single attachment (screenshot / doc) — stored as a base64
    // `data:` URI (image or PDF). Null when the user didn't attach anything.
    attachment: { type: String, default: null },
    attachmentName: { type: String, default: null },
    // 1-5; null when the user skipped the rating step.
    rating: { type: Number, min: 1, max: 5, default: null },
    // Free-form context the client snapshots so admins can reproduce: page
    // URL when submitted, browser UA, app version. All optional.
    context: {
      page: String,
      userAgent: String,
      appVersion: String,
    },
    status: {
      type: String,
      enum: ['OPEN', 'TRIAGED', 'IN_PROGRESS', 'RESOLVED', 'WONT_FIX'],
      default: 'OPEN',
      index: true,
    },
    // Admin-side INTERNAL notes — triage / resolution scratchpad. Never
    // surfaced to the user (stripped from the user-facing feedback list).
    adminNote: String,
    // Admin's REPLY to the user — this IS shown back to the user in their
    // "My Tickets" view (and best-effort emailed). Distinct from adminNote.
    adminReply: { type: String, default: null },
    repliedAt: { type: Date, default: null },
    resolvedAt: Date,
  },
  { timestamps: true }
);

feedbackSchema.index({ userId: 1, createdAt: -1 });

const Feedback = mongoose.model('Feedback', feedbackSchema);
Feedback.CATEGORIES = CATEGORIES;
Feedback.CATEGORY_LABELS = CATEGORY_LABELS;
module.exports = Feedback;
