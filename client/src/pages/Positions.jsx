import PositionsPanel from '../components/PositionsPanel';

/**
 * Open positions and pending orders on their own route.
 *
 * Reachable from the main nav so closing a trade is one tap from anywhere,
 * rather than a trip into the terminal. The panel is self-contained — it
 * fetches its own data and owns close/cancel — so this page is only a frame
 * around it, and the same component backs the Positions tab on an instrument
 * page.
 *
 * No symbol filter here: this is the whole account.
 */
export default function Positions() {
  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="mb-4">
        <h1 className="text-xl font-bold text-text-primary">Positions</h1>
        <p className="text-sm text-text-muted mt-0.5">
          Everything currently open, and orders still waiting to trigger. Close or cancel from here.
        </p>
      </div>
      <div className="border border-border-dark rounded-2xl overflow-hidden bg-bg-card">
        <div className="h-[70vh] min-h-[380px]">
          <PositionsPanel />
        </div>
      </div>
    </div>
  );
}
