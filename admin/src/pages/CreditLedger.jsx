import PageHero from '../components/PageHero';

/**
 * Credit Ledger — deposits and withdrawals processed on credit, with the
 * outstanding balance per user and settlement tracking.
 */
export default function CreditLedger() {
  return (
    <div className="space-y-6">
      <PageHero title="Credit Ledger" subtitle="Deposits and withdrawals processed on credit, pending until settled." />
      <div className="card p-6 text-sm text-text-muted">Coming up.</div>
    </div>
  );
}
