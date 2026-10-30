/**
 * INR-only ledger: the currency helpers are identity functions for INR and
 * refuse any other currency with UNSUPPORTED_CURRENCY instead of guessing a
 * rate. Pure — no database, no network (getUsdInrRate is not called).
 */
const assert = require('assert');
const path = require('path');

const { BASE_CURRENCY } = require(path.join(__dirname, '../src/config/constants'));
const currencyService = require(path.join(__dirname, '../src/services/currencyService'));
const fxService = require(path.join(__dirname, '../src/services/fxService'));
const paymentMethods = require(path.join(__dirname, '../src/utils/paymentMethods'));

(async () => {
  assert.strictEqual(BASE_CURRENCY, 'INR', 'ledger currency is INR');

  const conv = await currencyService.toBase('INR', '100');
  assert.strictEqual(conv.baseCurrency, 'INR');
  assert.strictEqual(conv.baseAmount, 100);
  assert.strictEqual(conv.rate, 1);
  assert.strictEqual(await currencyService.fromBase('inr', 250.5), 250.5);

  for (const fn of [() => currencyService.toBase('USD', 100), () => currencyService.fromBase('USD', 100)]) {
    let err = null;
    try { await fn(); } catch (e) { err = e; }
    assert.ok(err, 'non-INR must throw');
    assert.strictEqual(err.code, 'UNSUPPORTED_CURRENCY');
    assert.strictEqual(err.statusCode, 400);
  }

  assert.strictEqual(fxService.BASE, 'INR');
  assert.deepStrictEqual(await fxService.toUsd('INR', 99.999), { usd: 100, rate: 1, source: 'base' });
  assert.deepStrictEqual(await fxService.fromUsd('INR', 12.345), { amount: 12.35, rate: 1, source: 'base' });
  await assert.rejects(() => fxService.toUsd('USD', 1), (e) => e.code === 'UNSUPPORTED_CURRENCY');

  assert.deepStrictEqual(paymentMethods.FIXED_METHOD_IDS, ['UPI', 'BANK', 'RAZORPAY']);
  assert.strictEqual(paymentMethods.payoutCurrency({ supportedCurrencies: ['USD'] }), 'INR', 'every rail pays out in INR');

  console.log('inrLedger: ok');
})().catch((e) => { console.error(e); process.exit(1); });
