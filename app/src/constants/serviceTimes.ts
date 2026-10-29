/**
 * The turnaround times the pages promise — support's first response, the
 * deposit-proof review, manual withdrawal processing.
 *
 * EquityHub has no admin "Service Times" setting (no /cms/service-times):
 * its pages print these words directly — Helpdesk.jsx "Average first
 * response: 2-4 hours", Wallet.jsx "within 1–24 hours". They are kept here,
 * word for word, so every screen prints the same thing.
 */
export interface ServiceTimes {
  supportReply: string;
  depositReview: string;
  withdrawalProcessing: string;
}

export const SERVICE_TIMES_DEFAULTS: Readonly<ServiceTimes> = Object.freeze({
  supportReply: '2-4 hours',
  depositReview: '1–24 hours',
  withdrawalProcessing: '1–24 hours',
});
