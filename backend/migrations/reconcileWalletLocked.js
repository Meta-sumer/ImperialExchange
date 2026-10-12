/**
 * Reconcile Wallet.locked against the exposure that actually justifies it.
 *
 * WHY
 *   placeOrder locked margin BEFORE routing, but the routing call had no
 *   try/catch. Any rejection — STALE_FEED / FROZEN_FEED from the feed guard,
 *   a risk-engine reject, a daily/lifetime volume cap, an unconfigured LP, or
 *   the engine's "No reference price for B-book fill" — threw (or returned a
 *   REJECTED order) without ever releasing the lock. The funds stayed in
 *   `locked` permanently: the Wallet page kept showing the full `balance`
 *   while the Trade page showed the smaller `free` (= balance − locked), and
 *   the difference was unspendable.
 *
 * WHAT IT DOES
 *   For every wallet, recomputes what `locked` SHOULD be:
 *
 *     locked = Σ margin of OPEN positions on the account
 *            + Σ unfilled portion of lockedMargin on PENDING /
 *              PARTIALLY_FILLED orders          (lockedMargin × remaining/qty,
 *                                                same formula cancelOrder uses)
 *
 *   and writes that value. `balance` is NEVER touched — this only returns
 *   over-reserved funds to `free`. It also zeroes `lockedMargin` on orders
 *   that are already REJECTED/CANCELLED so no later path double-releases.
 *
 *   If the computed value is HIGHER than the stored one the wallet is
 *   under-reserved (the opposite bug); that is reported and, by default, also
 *   corrected — pass --no-raise to only ever reduce `locked`.
 *
 * Idempotent. Safe to re-run. Run with --dry-run first.
 *
 *   docker compose exec backend node migrations/reconcileWalletLocked.js --dry-run
 *   docker compose exec backend node migrations/reconcileWalletLocked.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const DRY = process.argv.includes('--dry-run');
const NO_RAISE = process.argv.includes('--no-raise');

const D = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('[reconcile] MONGODB_URI not set'); process.exit(1); }
  await mongoose.connect(uri);

  const { Wallet } = require('../src/models/Wallet');
  const Position = require('../src/models/Position');
  const Order = require('../src/models/Order');

  // Clear lockedMargin on terminal orders so nothing releases it twice later.
  const stale = await Order.find({
    status: { $in: ['REJECTED', 'CANCELLED'] },
    lockedMargin: { $nin: [null, '', '0'] },
  }).select('_id status lockedMargin').lean();
  console.log(`[reconcile] ${stale.length} terminal order(s) still carry a lockedMargin stamp`);
  if (stale.length && !DRY) {
    await Order.updateMany(
      { _id: { $in: stale.map((o) => o._id) } },
      { $set: { lockedMargin: '0' } },
    );
  }

  const wallets = await Wallet.find({}).lean();
  console.log(`[reconcile] scanning ${wallets.length} wallet(s)${DRY ? '  (DRY RUN)' : ''}\n`);

  let changed = 0;
  let freed = 0;

  for (const w of wallets) {
    // Margin genuinely backing open exposure.
    const positions = await Position.find({ accountId: w.accountId, status: 'OPEN' })
      .select('margin').lean();
    const posMargin = positions.reduce((s, p) => s + D(p.margin), 0);

    // Margin still reserved for the UNFILLED part of working orders — same
    // proportional formula cancelOrder uses when it releases.
    const working = await Order.find({
      accountId: w.accountId,
      status: { $in: ['PENDING', 'PARTIALLY_FILLED'] },
    }).select('quantity filledQuantity lockedMargin').lean();
    const orderMargin = working.reduce((s, o) => {
      const qty = D(o.quantity);
      const lm = D(o.lockedMargin);
      if (qty <= 0 || lm <= 0) return s;
      const remaining = Math.max(0, qty - D(o.filledQuantity));
      return s + (lm * remaining) / qty;
    }, 0);

    const should = r2(posMargin + orderMargin);
    const current = r2(D(w.locked));
    const delta = r2(current - should);

    if (Math.abs(delta) < 0.005) continue;
    if (delta < 0 && NO_RAISE) {
      console.log(`  ${w.accountId} ${w.currency}: under-reserved by ${(-delta).toFixed(2)} — skipped (--no-raise)`);
      continue;
    }

    console.log(
      `  ${w.accountId} ${w.currency}: locked ${current.toFixed(2)} -> ${should.toFixed(2)} ` +
      `(${delta > 0 ? 'freeing ' + delta.toFixed(2) : 'raising ' + (-delta).toFixed(2)}) ` +
      `[positions ${posMargin.toFixed(2)} + working orders ${orderMargin.toFixed(2)}]`
    );

    if (!DRY) {
      await Wallet.updateOne({ _id: w._id }, { $set: { locked: String(should) } });
    }
    changed += 1;
    if (delta > 0) freed += delta;
  }

  console.log(`\n[reconcile] ${DRY ? 'would adjust' : 'adjusted'} ${changed} wallet(s); ` +
              `${freed.toFixed(2)} returned to free balance`);
  console.log('[reconcile] balances were NOT modified — only the `locked` reservation.');

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => { console.error('[reconcile]', err); process.exit(1); });
