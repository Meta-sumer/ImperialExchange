/**
 * Fold stray non-USD trading wallets into the account's USD wallet.
 *
 * WHY THIS EXISTS
 * Account creation used to offer a base currency of INR / EUR / GBP and made
 * the account's first wallet in it, while every deposit credits USD
 * (confirmDeposit uses dep.baseCurrency). So an account could end up holding
 * two wallets in different currencies. The Trade footer shows one account in
 * one currency; the Portfolio sums every wallet, converting the odd one at the
 * LIVE rate. The two therefore disagreed by the converted value of the
 * leftover — and because the rate moves, the gap drifted on its own without
 * anyone touching the account.
 *
 * Account creation is USD-only now, so no new ones appear. This clears the
 * ones already out there.
 *
 * WHAT IT DOES
 * For every trading wallet whose currency is not USD:
 *   - converts its balance at the CURRENT withdrawal-leg rate,
 *   - adds that to the account's USD wallet (creating it if absent),
 *   - zeroes the source wallet,
 *   - writes a WalletLedger row on both sides so the movement is auditable.
 *
 * WHAT IT REFUSES TO TOUCH
 *   - a wallet with locked margin — money is committed to something; fix the
 *     lock first (a completed stop-out now sweeps those itself),
 *   - an account with OPEN positions, for the same reason,
 *   - a currency with no configured exchange rate, because converting at a
 *     guessed 1:1 would silently change what someone owns.
 *
 * USAGE
 *   node src/utils/consolidateWalletsToUsd.js            # dry run, changes nothing
 *   node src/utils/consolidateWalletsToUsd.js --apply    # actually writes
 *   node src/utils/consolidateWalletsToUsd.js --apply --user <userId>
 *
 * Dry run is the default on purpose: this moves real balances between wallets.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const userArgIdx = process.argv.indexOf('--user');
const ONLY_USER = userArgIdx > -1 ? process.argv[userArgIdx + 1] : null;

const BASE = 'USD';
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log(`connected · ${APPLY ? 'APPLY — writing changes' : 'DRY RUN — nothing will be written'}`);

  const { Wallet, WalletLedger } = require('../models/Wallet');
  const Position = require('../models/Position');
  const fxService = require('../services/fxService');

  const filter = { currency: { $ne: BASE } };
  if (ONLY_USER) filter.userId = new mongoose.Types.ObjectId(ONLY_USER);
  const strays = await Wallet.find(filter).lean();
  console.log(`found ${strays.length} non-${BASE} trading wallet(s)\n`);

  let moved = 0; let skipped = 0; let totalUsd = 0;

  for (const w of strays) {
    const tag = `${w.accountId} · ${w.currency} ${w.balance}`;
    const bal = Number(w.balance) || 0;
    const locked = Number(w.locked) || 0;

    if (locked > 0) {
      console.log(`SKIP  ${tag} — ${locked} still locked as margin`);
      skipped++; continue;
    }
    const open = await Position.countDocuments({ accountId: w.accountId, status: 'OPEN' });
    if (open) {
      console.log(`SKIP  ${tag} — account has ${open} open position(s)`);
      skipped++; continue;
    }
    if (bal === 0) {
      console.log(`SKIP  ${tag} — already empty`);
      skipped++; continue;
    }

    let usd;
    try {
      // Same leg a payout uses. Throws for a currency with no configured rate
      // rather than converting at a guessed 1:1.
      ({ usd } = await fxService.toUsd(w.currency, bal, 'withdrawal'));
    } catch (e) {
      console.log(`SKIP  ${tag} — no usable exchange rate (${e.code || e.message})`);
      skipped++; continue;
    }
    usd = round2(usd);
    console.log(`MOVE  ${tag}  ->  ${BASE} ${usd.toFixed(2)}`);
    totalUsd += usd;
    moved++;
    if (!APPLY) continue;

    // Credit the USD wallet first, so a crash between the two leaves the money
    // duplicated rather than destroyed — recoverable either way, and the safer
    // direction to fail in.
    const usdWallet = await Wallet.findOneAndUpdate(
      { userId: w.userId, accountId: w.accountId, currency: BASE },
      {
        $setOnInsert: { userId: w.userId, accountId: w.accountId, currency: BASE, locked: '0' },
        $inc: { __v: 0 },
      },
      { upsert: true, new: true }
    );
    const newBal = round2((Number(usdWallet.balance) || 0) + usd);
    await Wallet.updateOne({ _id: usdWallet._id }, { $set: { balance: String(newBal) } });
    await Wallet.updateOne({ _id: w._id }, { $set: { balance: '0' } });

    try {
      await WalletLedger.insertMany([
        {
          walletId: w._id, userId: w.userId, accountId: w.accountId,
          type: 'ADJUSTMENT', currency: w.currency,
          amount: '-' + bal.toFixed(2), balanceAfter: '0',
          referenceType: 'CURRENCY_CONSOLIDATION',
          note: `Consolidated ${bal} ${w.currency} into the ${BASE} wallet`,
        },
        {
          walletId: usdWallet._id, userId: w.userId, accountId: w.accountId,
          type: 'ADJUSTMENT', currency: BASE,
          amount: '+' + usd.toFixed(2), balanceAfter: String(newBal),
          referenceType: 'CURRENCY_CONSOLIDATION',
          note: `Consolidated from ${bal} ${w.currency}`,
        },
      ]);
    } catch (e) {
      console.warn(`      ledger write failed for ${tag}: ${e.message}`);
    }
  }

  console.log(`\n${moved} wallet(s) ${APPLY ? 'consolidated' : 'would be consolidated'}`
    + ` · ${BASE} ${totalUsd.toFixed(2)} total · ${skipped} skipped`);
  if (!APPLY && moved) console.log('re-run with --apply to write these changes');
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
