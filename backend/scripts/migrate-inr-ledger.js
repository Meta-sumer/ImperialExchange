#!/usr/bin/env node
/**
 * migrate-inr-ledger.js — relabel the ledger from USD to INR.
 *
 * The platform is INR-only now (config/constants BASE_CURRENCY). Rows written
 * before the switch carry currency 'USD' while their MAGNITUDES were always
 * rupees (every instrument is rupee-quoted and P&L was booked 1:1), so this
 * only changes the label — no value is converted.
 *
 *   node scripts/migrate-inr-ledger.js          # apply
 *   node scripts/migrate-inr-ledger.js --dry    # count only, change nothing
 *
 * Reads MONGODB_URI from backend/.env (dotenv, like seedProd.js). Idempotent:
 * a second run matches nothing. Run it once, right after deploying the
 * INR-only build, inside the backend container:
 *   docker compose exec backend node scripts/migrate-inr-ledger.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { BASE_CURRENCY } = require('../src/config/constants');

const DRY = process.argv.includes('--dry');
const FROM = 'USD';

// collection → fields that hold a wallet/ledger currency
const TARGETS = [
  ['wallets',                  ['currency']],
  ['walletledgers',            ['currency']],
  ['tradingaccounts',          ['baseCurrency']],
  ['deposits',                 ['currency', 'baseCurrency']],
  ['withdrawals',              ['currency', 'baseCurrency']],
  ['bonuswallets',             ['currency']],
  ['bonuswallettransactions',  ['currency']],
  ['subscriptionwallets',      ['currency']],
  ['subscriptiontransactions', ['currency']],
  ['credittransactions',       ['currency']],
  ['commissions',              ['currency']],
  ['copytradeearnings',        ['currency']],
  ['subscriptions',            ['lastPayment.currency', 'postPaidRates.currency']],
  ['plans',                    ['postPaidRates.currency']],
  ['users',                    ['preferredDisplayCurrency']],
];

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  console.log(`${DRY ? '[dry run] ' : ''}relabelling ${FROM} → ${BASE_CURRENCY}`);
  let total = 0;
  for (const [coll, fields] of TARGETS) {
    if (!existing.has(coll)) { console.log(`  ${coll.padEnd(26)} (absent)`); continue; }
    for (const field of fields) {
      const filter = { [field]: FROM };
      const matched = await db.collection(coll).countDocuments(filter);
      let modified = 0;
      if (matched && !DRY) {
        const r = await db.collection(coll).updateMany(filter, { $set: { [field]: BASE_CURRENCY } });
        modified = r.modifiedCount;
      }
      total += matched;
      console.log(`  ${coll.padEnd(26)} ${field.padEnd(26)} matched ${String(matched).padStart(6)}  modified ${String(modified).padStart(6)}`);
    }
  }
  // Instrument quote currencies are untouched: Indian rows are already INR and
  // the deactivated global rows keep their real quote currency.
  console.log(`${DRY ? 'would relabel' : 'relabelled'} ${total} field value(s).`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
