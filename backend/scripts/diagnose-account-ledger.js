#!/usr/bin/env node
/**
 * diagnose-account-ledger.js — where did this balance actually come from?
 *
 * Reported from the live platform: an account balance that rose when a position
 * was OPENED, margin larger than the account had ever held, and a stop-out that
 * left money behind. None of those should be possible — lockMargin only
 * increments `locked` and is guarded by `balance - locked >= amount`, so
 * opening a position cannot credit anything.
 *
 * Guessing which write did it from a screen recording is not good enough, so
 * this replays the wallet ledger and checks it against the stored balance.
 *
 *   docker compose exec backend node scripts/diagnose-account-ledger.js <accountNumber|accountId> [rows]
 *
 * The important section is the last one. Every ledger row carries the balance
 * before and after it, so the rows can be checked two ways:
 *
 *   CONTINUITY — does each row start where the previous one ended? A break
 *                means something changed the balance WITHOUT writing a ledger
 *                row, which is the only way a balance can move unexplained.
 *   ARITHMETIC — does balanceAfter - balanceBefore equal the row's own amount?
 *                A mismatch means the row misreports what it did.
 *
 * Read-only.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const KEY = process.argv[2];
const ROWS = Math.max(10, Math.min(500, Number(process.argv[3]) || 60));

const n2 = (v) => Number(v || 0).toFixed(2);
const pad = (s, w) => String(s).padEnd(w);
const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—');

(async () => {
  if (!KEY) {
    console.error('usage: diagnose-account-ledger.js <accountNumber|accountId> [rows]');
    process.exit(1);
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is not set'); process.exit(1); }
  await mongoose.connect(uri, { maxPoolSize: 3, serverSelectionTimeoutMS: 10000, family: 4 });

  const TradingAccount = require('../src/models/TradingAccount');
  const { Wallet, WalletLedger } = require('../src/models/Wallet');
  const Position = require('../src/models/Position');

  const acc = mongoose.isValidObjectId(KEY)
    ? await TradingAccount.findById(KEY).lean()
    : await TradingAccount.findOne({ accountNumber: KEY }).lean();
  if (!acc) { console.error(`no account matching "${KEY}"`); process.exit(1); }

  console.log('Account', acc.accountNumber, `(${acc.accountType})`);
  console.log('  status            :', acc.status, acc.status === 'STOPPED_OUT' ? `(since ${when(acc.stoppedOutAt)})` : '');
  console.log('  baseCurrency      :', acc.baseCurrency || '(unset)');
  console.log('  leverage          :', acc.leverage);

  // ── Wallets ──────────────────────────────────────────────────────────
  const wallets = await Wallet.find({ accountId: acc._id }).lean();
  console.log('');
  console.log('Wallets on this account');
  for (const w of wallets) {
    const free = Number(w.balance || 0) - Number(w.locked || 0);
    console.log(`  ${pad(w.currency, 6)} balance ${pad(n2(w.balance), 14)} locked ${pad(n2(w.locked), 14)} free ${n2(free)}`);
  }
  if (!wallets.length) console.log('  (none)');
  // A baseCurrency with no matching wallet is why a deposit can raise a balance
  // and still leave the account locked — the stop-out release looks up the
  // wallet BY that currency and finds nothing.
  const baseCur = acc.baseCurrency || 'USD';
  if (wallets.length && !wallets.some((w) => w.currency === baseCur)) {
    console.log('');
    console.log(`  MISMATCH: baseCurrency is ${baseCur} but no wallet uses that code.`);
    console.log('  Anything that resolves a wallet from the account currency will miss.');
  }

  // ── Open positions and their margin ──────────────────────────────────
  const open = await Position.find({ accountId: acc._id, status: 'OPEN' })
    .select('symbol side quantity entryPrice margin leverage').lean();
  const marginSum = open.reduce((s, p) => s + Number(p.margin || 0), 0);
  console.log('');
  console.log(`Open positions: ${open.length}, margin total ${n2(marginSum)}`);
  for (const p of open) {
    console.log(`  ${pad(p.symbol, 10)} ${pad(p.side, 5)} qty ${pad(p.quantity, 12)} entry ${pad(p.entryPrice, 12)} margin ${n2(p.margin)}`);
  }
  const lockedSum = wallets.reduce((s, w) => s + Number(w.locked || 0), 0);
  if (Math.abs(lockedSum - marginSum) > 0.01) {
    console.log('');
    console.log(`  MISMATCH: wallet locked total ${n2(lockedSum)} != open-position margin ${n2(marginSum)}.`);
    console.log('  Margin was locked without a position, or released without unlocking.');
  }

  // ── The ledger ───────────────────────────────────────────────────────
  const rows = await WalletLedger.find({ accountId: acc._id })
    .sort({ createdAt: -1 }).limit(ROWS)
    .select('createdAt type amount balanceBefore balanceAfter referenceType currency note').lean();
  rows.reverse();

  console.log('');
  console.log(`Last ${rows.length} ledger rows (oldest first)`);
  console.log('  ' + pad('when', 19), pad('type', 22), pad('amount', 13), pad('before', 13), pad('after', 13), 'ref');
  console.log('  ' + '-'.repeat(104));

  let breaks = 0;
  let badMath = 0;
  let prevAfter = null;
  for (const r of rows) {
    const before = Number(r.balanceBefore);
    const after = Number(r.balanceAfter);
    const amt = Number(String(r.amount).replace('+', ''));

    const flags = [];
    // Continuity: this row must start where the last one finished.
    if (prevAfter != null && Number.isFinite(before) && Math.abs(before - prevAfter) > 0.01) {
      flags.push(`GAP ${n2(before - prevAfter)}`);
      breaks += 1;
    }
    // Arithmetic: the row's own numbers must agree with its amount. Margin
    // rows legitimately move `locked` rather than `balance`, so a zero delta
    // on those is expected and not flagged.
    const movesBalance = !/MARGIN/i.test(r.type || '') && Number.isFinite(amt) && Math.abs(amt) > 0;
    if (movesBalance && Number.isFinite(before) && Number.isFinite(after)) {
      const delta = after - before;
      if (Math.abs(Math.abs(delta) - Math.abs(amt)) > 0.01) {
        flags.push(`AMOUNT says ${n2(amt)} but balance moved ${n2(delta)}`);
        badMath += 1;
      }
    }
    if (Number.isFinite(after)) prevAfter = after;

    console.log(
      '  ' + pad(when(r.createdAt), 19),
      pad(r.type, 22),
      pad(n2(amt), 13),
      pad(Number.isFinite(before) ? n2(before) : '—', 13),
      pad(Number.isFinite(after) ? n2(after) : '—', 13),
      (r.referenceType || '') + (flags.length ? '   <<< ' + flags.join(' · ') : '')
    );
  }

  // ── Verdict ──────────────────────────────────────────────────────────
  console.log('');
  const storedBal = wallets.reduce((s, w) => s + Number(w.balance || 0), 0);
  if (prevAfter != null) {
    console.log(`  ledger ends at ${n2(prevAfter)}, wallet holds ${n2(storedBal)}`);
    if (Math.abs(prevAfter - storedBal) > 0.01) {
      console.log('  MISMATCH: the stored balance does not match the last ledger row.');
      console.log('  Something wrote the balance without recording a ledger entry.');
    }
  }
  console.log('');
  if (breaks) {
    console.log(`  ${breaks} continuity break(s): a row did not start where the previous one ended.`);
    console.log('  That is the signature of a balance change with no ledger row behind it —');
    console.log('  look at what happened between those two timestamps.');
  }
  if (badMath) {
    console.log(`  ${badMath} row(s) whose amount disagrees with the balance they recorded.`);
  }
  if (!breaks && !badMath) {
    console.log('  Ledger is continuous and self-consistent — every balance change is');
    console.log('  accounted for by a row. If the balance still looks wrong, the fault is');
    console.log('  in what a row was worth, not in an unrecorded write.');
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
