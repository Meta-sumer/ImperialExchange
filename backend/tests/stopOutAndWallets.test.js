/**
 * Three reported mismatches, pinned.
 *
 * 1. A stopped-out account stayed locked when it was re-funded by INTERNAL
 *    TRANSFER. walletService.credit only called clearIfFunded for type
 *    'DEPOSIT', so money arriving from the Main Wallet raised the balance,
 *    showed the new figure in the UI, and still refused to trade — the user had
 *    to make an external deposit for the same money to count.
 *
 * 2. A position liquidated by the risk engine was recorded with closeReason
 *    MANUAL. stopOutService stamps STOP_OUT when it claims the position, but
 *    the engine then tested `pos.closeReason` — an in-memory snapshot read
 *    before that claim — and wrote MANUAL over the stored value.
 *
 * 3. The Bonus Wallet accepted incoming transfers. It is withdraw-only: the
 *    balance is a record of referral/partner earnings, and user money paid into
 *    it corrupts every report built on that record.
 *
 * These assert against SOURCE rather than running Mongo, because the fixes live
 * in a `$ifNull` pipeline expression and a `$unset` — both evaluated by the
 * database, not by code a unit test can call.
 *
 *   node tests/stopOutAndWallets.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let passed = 0;
let total = 0;
const check = (label, fn) => {
  total += 1;
  try { fn(); console.log('  ok   ' + label); passed += 1; }
  catch (e) { console.log('  FAIL ' + label); console.log('       ' + e.message); process.exitCode = 1; }
};

// ── 1. Stop-out release ──────────────────────────────────────────────
const walletService = read('src/services/walletService.js');
console.log('stop-out release on re-funding');

check('an internal transfer counts as funding', () => {
  const m = walletService.match(/_FUNDING_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, 'could not find _FUNDING_TYPES');
  assert.ok(/WALLET_TX_TYPE\.TRANSFER\b/.test(m[1]), 'TRANSFER missing — wallet to account transfer would not unlock');
  assert.ok(/WALLET_TX_TYPE\.INTERNAL_TRANSFER_IN\b/.test(m[1]), 'INTERNAL_TRANSFER_IN missing');
  assert.ok(/WALLET_TX_TYPE\.DEPOSIT\b/.test(m[1]), 'DEPOSIT missing');
  assert.ok(/WALLET_TX_TYPE\.ADJUSTMENT\b/.test(m[1]), 'ADJUSTMENT missing — an admin credit would not unlock');
});

check('settlement proceeds do NOT count as funding', () => {
  // The stop-out flips status BEFORE liquidating. If closing proceeds counted,
  // the liquidation would lift the guard it had just set.
  const m = walletService.match(/_FUNDING_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(!/TRADE_CLOSE/.test(m[1]), 'TRADE_CLOSE must not be a funding type');
  assert.ok(!/\bFEE\b/.test(m[1]), 'FEE must not be a funding type');
  assert.ok(!/TRADE_OPEN/.test(m[1]), 'TRADE_OPEN must not be a funding type');
});

check('the credit hook gates on that set, not a hard-coded type', () => {
  assert.ok(/_FUNDING_TYPES\.has\(type\)/.test(walletService),
    'credit() should test the set');
  assert.ok(!/type === 'DEPOSIT' \|\| referenceType === 'deposit'/.test(walletService),
    'the old DEPOSIT-only condition is still present');
});

// ── 2. closeReason ───────────────────────────────────────────────────
const engine = read('src/matching-engine/MatchingEngine.js');
console.log('\nclose reason on a liquidated position');

check('the engine resolves closeReason against the STORED value', () => {
  const hits = engine.match(/\$ifNull:\s*\['\$closeReason',\s*'MANUAL'\]/g) || [];
  // One per close branch: netting/one-way and hedge.
  assert.strictEqual(hits.length, 2, `expected 2 $ifNull guards, found ${hits.length}`);
});

check('the stale in-memory snapshot test is gone', () => {
  assert.ok(!/\.\.\.\(pos\.closeReason \? \{\} : \{ closeReason: 'MANUAL' \}\)/.test(engine),
    'engine still defaults closeReason from the in-memory `pos`');
});

// Every path that claims a position as CLOSING stamps a reason. If the claim is
// then released back to OPEN, that reason must go with it — otherwise the
// $ifNull above will faithfully preserve a reason for a close that never
// happened, and label the eventual real close as a liquidation.
console.log('\nreleasing a CLOSING claim clears its reason');
const RELEASE_FILES = [
  'src/controllers/adminOrdersController.js',
  'src/controllers/instrumentController.js',
  'src/controllers/orderController.js',
  'src/services/backgroundWorker.js',
  'src/services/copyTradingService.js',
  'src/services/stopOutService.js',
];
check('no CLOSING -> OPEN revert leaves closeReason behind', () => {
  const offenders = [];
  let seen = 0;
  for (const f of RELEASE_FILES) {
    const src = read(f);
    const re = /\$set:\s*\{\s*status:\s*POSITION_STATUS\.OPEN\s*\}(\s*,\s*\$unset:\s*\{\s*closeReason)?/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      seen += 1;
      if (!m[1]) offenders.push(`${f.split('/').pop()} @${m.index}`);
    }
  }
  assert.ok(seen > 0, 'found no release paths at all — did the pattern change?');
  assert.deepStrictEqual(offenders, [], `release paths without $unset closeReason: ${offenders.join(', ')}`);
});

// ── 3. Bonus wallet is withdraw-only ─────────────────────────────────
const walletCtrl = read('src/controllers/walletController.js');
const bonusCtrl = read('src/controllers/bonusWalletController.js');
console.log('\nbonus wallet is withdraw-only');

check('an internal transfer INTO the bonus wallet is refused', () => {
  assert.ok(/if \(isBonusTo\) \{[\s\S]{0,400}?BONUS_WALLET_WITHDRAW_ONLY/.test(walletCtrl),
    'internalTransfer does not reject isBonusTo');
});

check('transferring OUT of the bonus wallet is still allowed', () => {
  // The guard must key off the destination only. Rejecting isBonusFrom would
  // trap the earnings in the wallet, which is the opposite of the intent.
  assert.ok(!/if \(isBonusFrom\)[\s\S]{0,200}?BONUS_WALLET_WITHDRAW_ONLY/.test(walletCtrl),
    'transfers OUT of the bonus wallet must not be blocked');
});

check('both bonus deposit endpoints refuse as well', () => {
  assert.ok(/const _assertWithdrawOnly = \(\) => \{[\s\S]*?BONUS_WALLET_WITHDRAW_ONLY/.test(bonusCtrl),
    'the shared refusal helper is missing');
  const guards = (bonusCtrl.match(/_assertWithdrawOnly\(\);/g) || []).length;
  assert.strictEqual(guards, 2, `expected deposit + manualDeposit guarded, found ${guards}`);
});

check('withdrawal is untouched', () => {
  assert.ok(/const requestWithdrawal = asyncHandler/.test(bonusCtrl), 'withdraw handler missing');
  const wd = bonusCtrl.slice(bonusCtrl.indexOf('const requestWithdrawal'), bonusCtrl.indexOf('const toggleAutoRenew'));
  assert.ok(!/_assertWithdrawOnly\(\)/.test(wd), 'the withdraw path must NOT be blocked');
});

console.log(`\n${passed}/${total} checks passed`);
