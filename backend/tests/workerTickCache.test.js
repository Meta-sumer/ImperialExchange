/**
 * The worker's per-tick cache must change how data is LOADED, never what any
 * decision sees.
 *
 * Each money function is run twice on the same data — once through its
 * original queries, once from the tick snapshot — and the results must be
 * identical. The cases are the ones where a cache could plausibly drift:
 *
 *   - a field missing from the stored document. Lean objects and hydrated
 *     documents disagree here (Instrument.lastPrice defaults to "0", so a
 *     hydrated doc marks at 0 while a lean one falls through to the entry
 *     price), and each caller must keep getting the kind it always got
 *   - a wallet missing its balance, an account missing its base currency
 *   - wallets in several currencies on one account
 *   - a position whose instrument does not exist, or has no instrument at all
 *   - several accounts on the same instrument
 *
 * Plus the cache's own rules: a price is reused for at most the max age and
 * then refreshed in ONE query; an account the worker changes after the
 * snapshot is read fresh and no other account is; a failed snapshot load
 * fails the stage rather than handing out partial data.
 *
 * Needs a local MongoDB (uses a throwaway database, dropped afterwards). If
 * none is reachable it says so and exits 0 rather than failing CI that has
 * no database.
 *
 *   node tests/workerTickCache.test.js
 */
const assert = require('assert');
const mongoose = require('mongoose');

const URI = process.env.TEST_MONGO_URI || `mongodb://127.0.0.1:27017/wtc_test_${Date.now()}`;
if (!/127\.0\.0\.1|localhost/.test(URI)) throw new Error('refusing to run against a non-local database');

const Position = require('../src/models/Position');
const Instrument = require('../src/models/Instrument');
const TradingAccount = require('../src/models/TradingAccount');
const { Wallet } = require('../src/models/Wallet');
const riskService = require('../src/services/riskService');
const stopOut = require('../src/services/stopOutService');
const { createTickCache, INSTRUMENT_MAX_AGE_MS } = require('../src/services/workerTickCache');

// A controllable clock. Every cache in this file runs on it, so time passes
// only when a check says so. Real time would let a slow step on a busy machine
// age a price past the limit mid-check and fail a check that is correct.
let fakeNow = Date.now();
const advance = (ms) => { fakeNow += ms; };
const fakeCache = () => createTickCache({ now: () => fakeNow });

const oid = () => new mongoose.Types.ObjectId();
let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// Count the commands a block sends, so "one query" is measured, not assumed.
let counting = false;
let commands = [];
const counted = async (fn) => {
  commands = []; counting = true;
  try { return await fn(); } finally { counting = false; }
};

const pick = (m) => ({
  balance: m.balance, equity: m.equity, usedMargin: m.usedMargin,
  unrealizedPnl: m.unrealizedPnl, marginLevel: m.marginLevel,
  freeMargin: m.freeMargin, positions: m.positions.length,
});

(async () => {
  try {
    await mongoose.connect(URI, { serverSelectionTimeoutMS: 2000, monitorCommands: true });
  } catch (e) {
    console.log(`SKIPPED — no local MongoDB at ${URI.replace(/\/[^/]*$/, '')} (${e.message})`);
    process.exit(0);
  }
  mongoose.connection.getClient().on('commandStarted', (ev) => {
    // Candles are excluded: every fill makes the matching engine update
    // candles WITHOUT awaiting it, so liquidations from an earlier check can
    // still be reading candles while a later check counts — background
    // traffic, not the reads under test (accounts, wallets, positions,
    // instruments). It made this check fail about one run in fifteen.
    if (ev.command[ev.commandName] === 'candles') return;
    if (counting && ['find', 'aggregate', 'distinct'].includes(ev.commandName)) {
      commands.push(`${ev.command[ev.commandName]}.${ev.commandName}`);
    }
  });

  // ── fixtures ──────────────────────────────────────────────────────────
  const inst = async (sym, extra = {}) => Instrument.create({
    symbol: sym, name: sym, category: 'FOREX', baseCurrency: 'EUR', quoteCurrency: 'USD',
    lastPrice: '100', lastPriceUpdatedAt: new Date(), isActive: true, ...extra,
  });
  const iA = await inst('WTC_A', { lastPrice: '110' });
  const iB = await inst('WTC_B', { lastPrice: '95.5' });
  // Stored WITHOUT lastPrice: a hydrated doc reads "0", a lean one undefined.
  const iNoPrice = await Instrument.collection.insertOne({
    _id: oid(), symbol: 'WTC_NOPRICE', name: 'x', category: 'FOREX', baseCurrency: 'EUR', quoteCurrency: 'USD',
  }).then((r) => ({ _id: r.insertedId }));
  // Stored with lastPrice: null — stays null either way.
  const iNull = await Instrument.collection.insertOne({
    _id: oid(), symbol: 'WTC_NULL', name: 'x', category: 'FOREX', baseCurrency: 'EUR', quoteCurrency: 'USD', lastPrice: null,
  }).then((r) => ({ _id: r.insertedId }));
  const ghostInstrument = oid(); // referenced, never created

  const accounts = [];
  const mkAccount = async (label, { wallets = [{ currency: 'USD', balance: '1000' }], base = 'USD', rawAccount = false } = {}) => {
    const userId = oid();
    let acct;
    if (rawAccount) {
      // Stored without baseCurrency: hydrated reads the default 'USD'.
      const _idv = oid();
      await TradingAccount.collection.insertOne({ _id: _idv, userId, accountNumber: label, accountType: 'REAL', status: 'ACTIVE' });
      acct = await TradingAccount.findById(_idv);
    } else {
      acct = await TradingAccount.create({ userId, accountNumber: label, accountType: 'REAL', baseCurrency: base });
    }
    for (const w of wallets) {
      if (w.raw) await Wallet.collection.insertOne({ _id: oid(), userId, accountId: acct._id, currency: w.currency });
      else await Wallet.create({ userId, accountId: acct._id, currency: w.currency, balance: w.balance });
    }
    accounts.push({ label, acct });
    return acct;
  };
  const mkPos = (acct, instrumentId, side, qty, entry, extra = {}) => Position.create({
    userId: acct.userId, accountId: acct._id, instrumentId, symbol: 'S' + String(instrumentId).slice(-4),
    side, status: 'OPEN', quantity: qty, entryPrice: entry, margin: '10', ...extra,
  });

  const normal = await mkAccount('normal');
  await mkPos(normal, iA._id, 'BUY', '0.5', '100');
  await mkPos(normal, iB._id, 'SELL', '1.25', '100');
  await mkPos(normal, iA._id, 'SELL', '0.1', '120'); // same instrument twice

  const shared = await mkAccount('shared-instrument');
  await mkPos(shared, iA._id, 'BUY', '2', '90');      // another account on WTC_A

  const noWallet = await mkAccount('no-wallet', { wallets: [] });
  await mkPos(noWallet, iB._id, 'BUY', '1', '100');

  const walletNoBalance = await mkAccount('wallet-without-balance', { wallets: [{ currency: 'USD', raw: true }] });
  await mkPos(walletNoBalance, iA._id, 'BUY', '1', '100');

  const multiCcy = await mkAccount('eur-base-two-wallets', {
    base: 'EUR', wallets: [{ currency: 'USD', balance: '777' }, { currency: 'EUR', balance: '333' }],
  });
  await mkPos(multiCcy, iB._id, 'BUY', '1', '100');

  const rawAcct = await mkAccount('account-without-baseCurrency', { rawAccount: true });
  await mkPos(rawAcct, iA._id, 'SELL', '1', '100');

  const noPrice = await mkAccount('instrument-without-lastPrice');
  await mkPos(noPrice, iNoPrice._id, 'BUY', '1', '100');
  await mkPos(noPrice, iNull._id, 'SELL', '1', '100');

  const ghost = await mkAccount('instrument-does-not-exist');
  await mkPos(ghost, ghostInstrument, 'BUY', '1', '100');

  const noMargin = await mkAccount('position-without-margin');
  await Position.collection.insertOne({
    _id: oid(), userId: noMargin.userId, accountId: noMargin._id, instrumentId: iA._id, symbol: 'S',
    side: 'BUY', status: 'OPEN', quantity: '1', entryPrice: '100',
  });

  const noInstrumentId = await mkAccount('position-without-instrumentId');
  await Position.collection.insertOne({
    _id: oid(), userId: noInstrumentId.userId, accountId: noInstrumentId._id, symbol: 'S',
    side: 'BUY', status: 'OPEN', quantity: '1', entryPrice: '100', margin: '10',
  });

  const flat = await mkAccount('no-open-positions'); // must not appear in the snapshot
  await mkPos(flat, iA._id, 'BUY', '1', '100', { status: 'CLOSED' });

  const cache = fakeCache();
  const snap = await counted(() => cache.accountSnapshot());

  console.log('\n— the snapshot is ONE batch —');
  await check('positions, accounts, wallets and instruments: four queries for every account', () => {
    assert.deepStrictEqual([...commands].sort(), ['instruments.find', 'positions.find', 'tradingaccounts.find', 'wallets.find']);
  });
  await check('it enumerates exactly the accounts distinct() did', async () => {
    const distinct = (await Position.distinct('accountId', { status: 'OPEN' })).map(String).sort();
    assert.deepStrictEqual(snap.accountIds.map(String).sort(), distinct);
  });
  await check('an account with no open position is not in it', () => {
    assert.ok(!snap.accountIds.map(String).includes(String(flat._id)));
  });
  await check('its symbols are exactly what distinct(symbol) returned', async () => {
    const distinct = (await Position.distinct('symbol', { status: 'OPEN' })).sort();
    assert.deepStrictEqual([...snap.symbols].sort(), distinct);
  });

  console.log('\n— calculateAccountMetrics: queries vs snapshot, identical —');
  for (const { label, acct } of accounts) {
    if (!snap.accountIds.map(String).includes(String(acct._id))) continue;
    await check(label, async () => {
      const a = await TradingAccount.findById(acct._id);
      let fresh, cached, freshErr, cachedErr;
      try { fresh = pick(await riskService.calculateAccountMetrics(a.userId, a._id, a.baseCurrency)); } catch (e) { freshErr = e.message; }
      try { cached = pick(await riskService.calculateAccountMetrics(a.userId, a._id, a.baseCurrency, snap)); } catch (e) { cachedErr = e.message; }
      assert.strictEqual(Boolean(cachedErr), Boolean(freshErr), `fresh threw=${freshErr} cached threw=${cachedErr}`);
      if (!freshErr) assert.deepStrictEqual(cached, fresh);
    });
  }

  console.log('\n— computeAccountEquity: queries vs snapshot, identical —');
  for (const { label, acct } of accounts) {
    if (!snap.accountIds.map(String).includes(String(acct._id))) continue;
    await check(label, async () => {
      const a = await TradingAccount.findById(acct._id);
      let fresh, cached, freshErr, cachedErr;
      try { fresh = pick({ freeMargin: null, ...(await stopOut.computeAccountEquity(a)) }); } catch (e) { freshErr = e.message; }
      try { cached = pick({ freeMargin: null, ...(await stopOut.computeAccountEquity(a, { preloaded: snap })) }); } catch (e) { cachedErr = e.message; }
      assert.strictEqual(Boolean(cachedErr), Boolean(freshErr), `fresh threw=${freshErr} cached threw=${cachedErr}`);
      if (!freshErr) assert.deepStrictEqual(cached, fresh);
    });
  }

  console.log('\n— the snapshot hands each caller the kind of document it used to get —');
  await check('hydrated instrument reads a missing lastPrice as "0", lean reads undefined', () => {
    assert.strictEqual(snap.instrumentDoc(iNoPrice._id).lastPrice, '0');
    assert.strictEqual(snap.instrumentRaw(iNoPrice._id).lastPrice, undefined);
  });
  await check('a stored null stays null in both', () => {
    assert.strictEqual(snap.instrumentDoc(iNull._id).lastPrice, null);
    assert.strictEqual(snap.instrumentRaw(iNull._id).lastPrice, null);
  });
  await check('a missing instrument is null, as findById returned', async () => {
    assert.strictEqual(snap.instrumentDoc(ghostInstrument), null);
    assert.strictEqual(await Instrument.findById(ghostInstrument), null);
  });
  await check('hydrated wallet reads a missing balance as "0", lean as undefined', () => {
    const a = walletNoBalance;
    assert.strictEqual(snap.walletDoc(a.userId, a._id, 'USD').balance, '0');
    assert.strictEqual(snap.walletRaw(a.userId, a._id, 'USD').balance, undefined);
  });
  await check('the base-currency wallet is picked, not the first one', () => {
    assert.strictEqual(snap.walletRaw(multiCcy.userId, multiCcy._id, 'EUR').balance, '333');
  });
  await check('hydrating for one caller never alters the snapshot another caller reads', () => {
    const docs = snap.positionDocs(normal._id);
    docs[0].unrealizedPnl = '999';           // calculateAccountMetrics does exactly this
    docs[0].quantity = '42';
    const raw = snap.positionsRaw(normal._id);
    assert.ok(raw.every((p) => p.unrealizedPnl === undefined && p.quantity !== '42'));
  });

  console.log('\n— instruments for the trigger stages —');
  await check('the projected lean doc carries the same trigger fields as findById().lean()', async () => {
    const c = fakeCache();
    const viaCache = await c.getInstrument(iA._id);
    const full = await Instrument.findById(iA._id).lean();
    for (const f of ['lastPrice', 'lastPriceUpdatedAt', 'spreadValue', 'spreadType']) {
      assert.deepStrictEqual(viaCache[f], full[f], f);
    }
  });
  await check('missing, null and invalid ids all come back null, like findById', async () => {
    const c = fakeCache();
    assert.strictEqual(await c.getInstrument(ghostInstrument), null);
    assert.strictEqual(await c.getInstrument(null), null);
    assert.strictEqual(await c.getInstrument(undefined), null);
    assert.strictEqual(await c.getInstrument('not-an-id'), null);
  });
  await check('many lookups of the same instruments cost one query', async () => {
    const c = fakeCache();
    await counted(async () => {
      await c.ensureInstruments([iA._id, iB._id, iA._id]);
      for (let i = 0; i < 50; i++) { await c.getInstrument(iA._id); await c.getInstrument(iB._id); }
    });
    assert.deepStrictEqual(commands, ['instruments.find']);
  });
  await check(`a price older than ${INSTRUMENT_MAX_AGE_MS}ms is re-read, all stale ones in ONE query`, async () => {
    const c = fakeCache();
    await c.ensureInstruments([iA._id, iB._id]);
    await Instrument.updateOne({ _id: iA._id }, { $set: { lastPrice: '111' } });
    assert.strictEqual((await c.getInstrument(iA._id)).lastPrice, '110', 'still fresh: reused');
    advance(INSTRUMENT_MAX_AGE_MS + 1);
    await counted(async () => {
      assert.strictEqual((await c.getInstrument(iA._id)).lastPrice, '111', 'stale: re-read');
      await c.getInstrument(iB._id); // refreshed in the same batch
    });
    assert.deepStrictEqual(commands, ['instruments.find']);
    assert.strictEqual(c.stats.priceRefreshes, 1);
    await Instrument.updateOne({ _id: iA._id }, { $set: { lastPrice: '110' } });
  });

  console.log('\n— prices the worker\'s own trades change are re-read —');
  await check('after a submit, the traded instrument is re-read; the others are not', async () => {
    const c = fakeCache();
    await c.ensureInstruments([iA._id, iB._id]);
    // A fill writes the trade price into lastPrice (MatchingEngine._persistLastPrice).
    await Instrument.updateOne({ _id: iA._id }, { $set: { lastPrice: '109' } });
    c.invalidateInstrument(iA._id);
    await counted(async () => {
      assert.strictEqual((await c.getInstrument(iA._id)).lastPrice, '109');
      await c.getInstrument(iB._id);
    });
    assert.deepStrictEqual(commands, ['instruments.find'], 'one read, for the traded instrument only');
    await Instrument.updateOne({ _id: iA._id }, { $set: { lastPrice: '110' } });
  });
  await check(`snapshot prices older than ${INSTRUMENT_MAX_AGE_MS}ms are re-read in ONE query; fresh ones cost nothing`, async () => {
    const s = await fakeCache().accountSnapshot();
    await counted(() => s.refreshPricesIfStale(normal._id));
    assert.deepStrictEqual(commands, [], 'fresh: no read');
    await Instrument.updateOne({ _id: iA._id }, { $set: { lastPrice: '112' } });
    advance(INSTRUMENT_MAX_AGE_MS + 1);
    await counted(() => s.refreshPricesIfStale(normal._id));
    assert.deepStrictEqual(commands, ['instruments.find']);
    assert.strictEqual(s.instrumentRaw(iA._id).lastPrice, '112');
    await Instrument.updateOne({ _id: iA._id }, { $set: { lastPrice: '110' } });
  });
  await check('after a stop-out, only the instruments that account held are re-read — for the next account using them', async () => {
    const s = await fakeCache().accountSnapshot();
    s.expirePricesOf(shared._id);                       // shared held WTC_A only
    await counted(() => s.refreshPricesIfStale(multiCcy._id)); // multiCcy holds WTC_B: untouched
    assert.deepStrictEqual(commands, [], 'an account on other instruments reads nothing');
    await counted(() => s.refreshPricesIfStale(normal._id));   // normal holds WTC_A: re-read
    assert.deepStrictEqual(commands, ['instruments.find']);
  });

  console.log('\n— an account changed after the snapshot is read fresh — and only that one —');
  // Several fixtures above are insolvent on purpose (no wallet, losing
  // positions), and a sweep correctly liquidates them — real I/O that would be
  // counted against whatever these checks measure. Let one sweep settle them
  // first, so the counts below see only the reads under test.
  await stopOut.evaluateAllOpenAccounts(await fakeCache().accountSnapshot());
  await check('touched BEFORE the snapshot: still served from it (it already reflects the change)', async () => {
    const c = fakeCache();
    c.markTouched(normal._id);
    const s = await c.accountSnapshot();
    assert.strictEqual(s.isTouched(normal._id), false);
  });
  await check('touched AFTER the snapshot: the sweep reads exactly that account fresh', async () => {
    const c = fakeCache();
    const s = await c.accountSnapshot();
    c.markTouched(normal._id);
    await counted(() => stopOut.evaluateAllOpenAccounts(s));
    // The fresh path is today's: findById + wallet + positions + instruments,
    // for the touched account only. Every other account costs nothing.
    assert.strictEqual(c.stats.freshAccountReads, 1);
    assert.deepStrictEqual([...commands].sort(), ['instruments.find', 'positions.find', 'tradingaccounts.find', 'wallets.find']);
  });
  await check('untouched: the whole sweep reads nothing at all', async () => {
    const c = fakeCache();
    const s = await c.accountSnapshot();
    await counted(() => stopOut.evaluateAllOpenAccounts(s));
    assert.deepStrictEqual(commands, []);
  });

  console.log('\n— failure —');
  await check('a failed snapshot load rejects (the stage fails as before), and the next tick starts clean', async () => {
    const real = Position.find;
    Position.find = () => { throw new Error('simulated: database unavailable'); };
    const c = fakeCache();
    await assert.rejects(() => c.accountSnapshot(), /database unavailable/);
    Position.find = real;
    const next = fakeCache();
    const s = await next.accountSnapshot();
    assert.ok(s.accountIds.length > 0);
  });

  // Mongoose builds each model's indexes in the background; one still running
  // after dropDatabase recreates the collection and leaves an empty database
  // behind. Let them finish first.
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init().catch(() => {})));
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  console.log(`\n${passed}/${passed + failures.length} checks passed`);
  if (failures.length) process.exit(1);
})().catch(async (e) => {
  console.error(e);
  try { await mongoose.connection.db.dropDatabase(); } catch (_) {}
  process.exit(1);
});
