#!/usr/bin/env node
/**
 * diagnose-deposit-config.js — where is the deposit minimum actually coming from?
 *
 * A deposit is gated by TWO independent minimums, configured in two different
 * places, and the form does not say which one rejected you:
 *
 *   1. The ACCOUNT PLAN minimum (AccountPlan.minDeposit, in USD). This is the
 *      one the submit gate enforces — the typed amount is converted to USD and
 *      compared against it.
 *   2. The PAYMENT METHOD minimum (systemSettings 'deposit.paymentDetails' →
 *      method.min), which is what the method card DISPLAYS.
 *
 * They are stored separately, expressed in different currencies, and can
 * disagree. Reading "Minimum 500" on the card while the submit gate is really
 * enforcing a plan minimum in USD is exactly how a legitimate $100 deposit gets
 * refused with a message about 500.
 *
 * The plans live in the DATABASE — the values in config/accountTypes.js and
 * accountPlansService.js are only seeds, so editing those files proves nothing
 * about what is being enforced. This prints what is actually stored.
 *
 *   docker compose exec backend node scripts/diagnose-deposit-config.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is not set'); process.exit(1); }
  await mongoose.connect(uri, { maxPoolSize: 3, serverSelectionTimeoutMS: 10000, family: 4 });

  // ── 1. Plan minimums, as stored ──────────────────────────────────────
  const AccountPlan = require('../src/models/AccountPlan');
  const plans = await AccountPlan.find().sort({ sortOrder: 1 }).lean();
  // accountTypes exports a bag of helpers; the plan map is ACCOUNT_TYPE_DEFS.
  const { ACCOUNT_TYPE_DEFS: seeds } = require('../src/config/accountTypes');

  console.log('ACCOUNT PLAN minimums — this is what the submit gate enforces (USD)');
  console.log('  code'.padEnd(16), 'stored'.padStart(10), 'code-seed'.padStart(11), '  agrees?');
  console.log('  ' + '-'.repeat(56));
  if (!plans.length) {
    console.log('  (no AccountPlan rows — the service falls back to its built-in defaults)');
  }
  for (const p of plans) {
    const seed = seeds[p.code] ? seeds[p.code].minDeposit : null;
    const stored = Number(p.minDeposit || 0);
    const same = seed == null || Number(seed) === stored;
    console.log(
      '  ' + String(p.code).padEnd(14),
      String(stored).padStart(10),
      String(seed == null ? '—' : seed).padStart(11),
      same ? '  yes' : `  NO — the DB overrides the seed`
    );
  }

  // ── 2. Method minimums, as configured by the admin ───────────────────
  const systemSettings = require('../src/services/systemSettings.service');
  const cfg = (await systemSettings.getSetting('deposit.paymentDetails')) || {};
  const methods = Array.isArray(cfg.methods) ? cfg.methods : (Array.isArray(cfg) ? cfg : []);

  console.log('\nPAYMENT METHOD config — this is what the method card DISPLAYS');
  if (!methods.length) {
    console.log('  (no methods found under deposit.paymentDetails — check the admin page)');
    console.log('  raw keys:', Object.keys(cfg).join(', ') || '(empty)');
  }
  for (const m of methods) {
    const id = m.id || m.key || m.code || m.label || '(unnamed)';
    console.log(`\n  ${id}`);
    console.log('    enabled            :', m.enabled !== false);
    console.log('    min (displayed)    :', m.min != null ? m.min : '(unset)');
    console.log('    currency           :', m.currency || '(unset)');
    const sup = m.supportedCurrencies;
    if (Array.isArray(sup) && sup.length) {
      console.log('    supportedCurrencies:', sup.join(', '));
    } else {
      console.log('    supportedCurrencies: (blank → the client offers INR, USD, USDT, BTC)');
    }
    // The trap: a min expressed in the method's own currency, compared by the
    // user against a plan minimum expressed in USD.
    if (m.min != null && m.currency && String(m.currency).toUpperCase() !== 'USD') {
      console.log(`    NOTE               : this min is ${m.min} ${m.currency}, NOT USD — the`);
      console.log('                         submit gate compares against the plan minimum in USD,');
      console.log('                         so the displayed number and the enforced one differ.');
    }
  }

  console.log('\nHow to read this:');
  console.log('  If a plan row says NO under "agrees?", the database value is what applies —');
  console.log('  editing accountTypes.js will not change it. Fix it in the admin Plans page');
  console.log('  (or update the AccountPlan row) rather than in code.');
  console.log('  If a method\'s min is set in a non-USD currency, the card shows that number');
  console.log('  while the gate enforces the plan minimum in USD. Those are different values.');

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
