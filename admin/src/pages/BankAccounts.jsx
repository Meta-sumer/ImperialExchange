import PageHero from '../components/PageHero';

/**
 * Bank Accounts — the pool of company deposit accounts and which users are
 * assigned to each, so deposit traffic is spread across accounts.
 */
export default function BankAccounts() {
  return (
    <div className="space-y-6">
      <PageHero title="Bank Accounts" subtitle="Deposit bank accounts assigned per user." />
      <div className="card p-6 text-sm text-text-muted">Coming up.</div>
    </div>
  );
}
