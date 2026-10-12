/**
 * Migration: repair signup-created accounts stuck on baseCurrency 'INR'.
 *
 * WHY
 *   The money layer is USD-denominated — walletController's BASE_CURRENCY is
 *   'USD', so deposits / withdrawals / admin credits all land in the USD
 *   wallet. But margin locking, trade settlement and the Trade page's balance
 *   lookup key off `account.baseCurrency`. authController.register used to
 *   hardcode 'INR', which split the two: a funded account showed a 0 balance
 *   on the Trade page and rejected orders with INSUFFICIENT_FREE, because the
 *   page was reading an empty INR wallet while the money sat in a USD one.
 *
 * WHAT IT DOES
 *   For every account with baseCurrency 'INR':
 *     - INR wallet missing or zero  -> flip the account to USD, ensure a USD
 *       wallet exists, and delete the empty INR wallet. No money moves.
 *     - INR wallet holds a balance  -> DO NOT TOUCH. Reported at the end for
 *       a human decision, because converting would require an FX rate and a
 *       ledger entry, which a migration must not invent.
 *
 * Idempotent. Safe to re-run.
 *
 *   docker compose exec backend node migrations/fixAccountBaseCurrencyUsd.js
 *
 * Add --dry-run to report without writing anything.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const DRY = process.argv.includes('--dry-run');

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('[migration] MONGODB_URI not set'); process.exit(1); }
  await mongoose.connect(uri);

  const TradingAccount = require('../src/models/TradingAccount');
  const { Wallet } = require('../src/models/Wallet');

  const accounts = await TradingAccount.find({ baseCurrency: { $ne: 'USD' } })
    .select('_id userId accountNumber baseCurrency nickname').lean();

  console.log(`[migration] ${accounts.length} account(s) not on USD${DRY ? '  (DRY RUN)' : ''}`);

  let flipped = 0;
  const skipped = [];

  for (const acc of accounts) {
    const oldCcy = acc.baseCurrency || 'INR';
    const oldWallet = await Wallet.findOne({ accountId: acc._id, currency: oldCcy }).lean();
    const bal = Number(oldWallet?.balance || 0);
    const locked = Number(oldWallet?.locked || 0);

    if (bal > 0 || locked > 0) {
      skipped.push({ account: acc.accountNumber, currency: oldCcy, balance: bal, locked });
      continue;
    }

    if (DRY) { flipped += 1; continue; }

    // Ensure the USD wallet exists before repointing the account, so the
    // account is never left referencing a wallet that isn't there.
    await Wallet.updateOne(
      { userId: acc.userId, accountId: acc._id, currency: 'USD' },
      { $setOnInsert: { userId: acc.userId, accountId: acc._id, currency: 'USD', balance: '0', locked: '0' } },
      { upsert: true },
    );
    await TradingAccount.updateOne({ _id: acc._id }, { $set: { baseCurrency: 'USD' } });
    // Drop the empty stale wallet so it stops showing as a second row in
    // GET /wallet/balances and /wallet/equity.
    if (oldWallet) await Wallet.deleteOne({ _id: oldWallet._id });
    flipped += 1;
  }

  console.log(`[migration] ${DRY ? 'would flip' : 'flipped'} ${flipped} account(s) to USD`);

  if (skipped.length) {
    console.log(`\n[migration] ${skipped.length} account(s) SKIPPED — non-empty ${skipped[0].currency} wallet.`);
    console.log('[migration] These need a manual decision (convert at a rate, or withdraw first):');
    for (const s of skipped) {
      console.log(`  - ${s.account}: ${s.currency} balance=${s.balance} locked=${s.locked}`);
    }
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => { console.error('[migration]', err); process.exit(1); });
