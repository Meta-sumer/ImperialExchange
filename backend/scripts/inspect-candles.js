#!/usr/bin/env node
/**
 * inspect-candles.js — why does a chart look chopped up?
 *
 * A gappy chart has three different causes that look identical once drawn, and
 * guessing between them from a screenshot is how you fix the wrong one:
 *
 *   MISSING  no document for that bucket at all. Either the feed produced no
 *            tick and _backfillGaps never ran, or the gap was wider than the
 *            six-hour ceiling and was deliberately left alone.
 *   FLAT     a document whose open = high = low = close. Either the bucket got
 *            exactly ONE tick — which is what a slow or delayed price source
 *            looks like — or it is a carry-forward bar written by the gap fill.
 *            The two are told apart by volume and by whether neighbours share
 *            the identical price.
 *   OK       a real candle with a range.
 *
 * A chart full of FLAT bars is a FEED problem: the price source is not updating
 * often enough. A chart full of MISSING buckets is a WRITE problem. They need
 * opposite fixes, so this counts them separately.
 *
 *   docker compose exec backend node scripts/inspect-candles.js NIFTY 1m
 *   docker compose exec backend node scripts/inspect-candles.js NIFTY 5m 200
 *
 * Read-only.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const SYMBOL = process.argv[2] || 'NIFTY';
const TF = process.argv[3] || '1m';
const WANT = Math.max(10, Math.min(2000, Number(process.argv[4]) || 120));

const pad = (s, n) => String(s).padEnd(n);
// Date AND time. The stored range often spans several days, and a time-only
// stamp renders that as "15:01 to 11:34" — which reads like a four-hour window
// running backwards instead of a multi-day one.
const stamp = (d) => new Date(d).toLocaleString('en-GB', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
}).replace(',', '');

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is not set'); process.exit(1); }
  await mongoose.connect(uri, { maxPoolSize: 3, serverSelectionTimeoutMS: 10000, family: 4 });

  const Candle = require('../src/models/Candle');
  const Instrument = require('../src/models/Instrument');
  const { TF_MS } = require('../src/services/candleService');

  const tfMs = TF_MS[TF];
  if (!tfMs) {
    console.error(`unknown timeframe "${TF}" — known: ${Object.keys(TF_MS).join(', ')}`);
    process.exit(1);
  }

  // ── What the instrument itself says ──────────────────────────────────
  // The live price and the newest candle disagreeing is itself a finding: it
  // means ticks are arriving but candles are not being written from them.
  const inst = await Instrument.findOne({ symbol: SYMBOL })
    .select('symbol exchange segment lastPrice lastPriceUpdatedAt priceChangedAt feedUpdatedAt').lean();
  if (!inst) {
    console.error(`no instrument "${SYMBOL}"`);
    process.exit(1);
  }
  const age = (d) => (d ? Math.round((Date.now() - new Date(d).getTime()) / 1000) + 's ago' : 'never');
  console.log(`${inst.symbol}  ${inst.exchange || ''} ${inst.segment || '(cash)'}`);
  console.log('  lastPrice           :', inst.lastPrice);
  console.log('  price last CHANGED  :', age(inst.priceChangedAt));
  console.log('  feed last RESPONDED :', age(inst.feedUpdatedAt));
  // These two being far apart is the signature of a source that answers every
  // poll with a stale number: the feed is alive, the price is not moving.
  if (inst.feedUpdatedAt && inst.priceChangedAt) {
    const stale = (new Date(inst.feedUpdatedAt) - new Date(inst.priceChangedAt)) / 1000;
    if (stale > 60) {
      console.log(`  NOTE                : the feed has answered for ${Math.round(stale)}s without the price`);
      console.log('                        moving. Ticks are skipped when unchanged, so buckets in');
      console.log('                        that window get no candle at all.');
    }
  }

  // ── Walk the stored buckets ──────────────────────────────────────────
  const docs = await Candle.find({ symbol: SYMBOL, timeframe: TF })
    .sort({ openTime: -1 }).limit(WANT)
    .select('openTime open high low close volume').lean();
  if (!docs.length) {
    console.log(`\nNo ${TF} candles stored for ${SYMBOL} at all.`);
    await mongoose.disconnect();
    return;
  }
  docs.reverse();

  const first = new Date(docs[0].openTime).getTime();
  const last = new Date(docs[docs.length - 1].openTime).getTime();
  const byBucket = new Map(docs.map((d) => [new Date(d.openTime).getTime(), d]));

  // Only buckets inside a trading session count. The stored range routinely
  // spans nights, weekends and holidays — there is no candle at 03:00 because
  // the exchange was shut, not because anything failed. Walking the range
  // blindly counted every closed minute as MISSING and reported 99%, which was
  // pure noise and buried the real signal.
  //
  // marketHours.isExchangeOpen takes a timestamp and already knows weekends and
  // the holiday calendar, so use it rather than reimplementing session hours.
  const mh = require('../src/services/marketHours');
  const EXCH = inst.exchange || 'NSE';
  const openAt = (t) => {
    try { return mh.isExchangeOpen(EXCH, new Date(t)); } catch (_) { return true; }
  };

  let ok = 0; let flat = 0; let missing = 0; let closed = 0;
  const runs = [];           // consecutive missing buckets INSIDE a session
  let runStart = null;
  const lines = [];

  for (let t = first; t <= last; t += tfMs) {
    if (!openAt(t)) {
      closed += 1;
      // A session boundary ends any run in progress — a hole that stops because
      // the market shut is not the same hole as one that continues next day.
      if (runStart != null) { runs.push([runStart, t - tfMs]); runStart = null; }
      continue;
    }
    const d = byBucket.get(t);
    if (!d) {
      missing += 1;
      if (runStart == null) runStart = t;
      continue;
    }
    if (runStart != null) { runs.push([runStart, t - tfMs]); runStart = null; }
    // Compare as NUMBERS. These are stored as strings, so "23246.90" and
    // "23246.9" are the same price written two ways — a string comparison calls
    // that a real candle and quietly understates how flat the series is.
    const n = (v) => Number(v);
    const isFlat = n(d.open) === n(d.high) && n(d.high) === n(d.low) && n(d.low) === n(d.close);
    if (isFlat) flat += 1; else ok += 1;
    lines.push(`  ${stamp(t)}  ${pad(isFlat ? 'FLAT' : 'ok', 5)} ${pad(d.open, 11)}${pad(d.high, 11)}${pad(d.low, 11)}${pad(d.close, 11)} vol ${d.volume}`);
  }
  if (runStart != null) runs.push([runStart, last]);

  const total = ok + flat + missing;
  if (!total) {
    console.log(`\nNo ${TF} buckets inside a trading session in this range (${closed} closed-market buckets skipped).`);
    await mongoose.disconnect();
    return;
  }
  console.log(`\n${total} ${TF} buckets inside ${EXCH} sessions, ${stamp(first)} to ${stamp(last)} IST`);
  console.log(`  (${closed.toLocaleString('en-US')} buckets skipped — market closed, nothing is expected there)`);
  for (const l of lines.slice(-40)) console.log(l);
  if (lines.length > 40) console.log(`  … ${lines.length - 40} earlier rows not shown`);

  console.log('');
  console.log(`  real candles : ${ok} (${((ok / total) * 100).toFixed(0)}%)`);
  console.log(`  FLAT bars    : ${flat} (${((flat / total) * 100).toFixed(0)}%)  — one tick in the bucket, or a gap-fill carry-forward`);
  console.log(`  MISSING      : ${missing} (${((missing / total) * 100).toFixed(0)}%)  — no document written for that bucket`);

  if (runs.length) {
    console.log('');
    console.log('  holes INSIDE trading sessions (closed-market gaps are not holes):');
    for (const [a, b] of runs.slice(-10)) {
      const n = Math.round((b - a) / tfMs) + 1;
      console.log(`    ${stamp(a)} to ${stamp(b)}  (${n} bucket${n > 1 ? 's' : ''})`);
    }
  }

  console.log('');
  if (flat / total > 0.4) {
    console.log('  Mostly FLAT. That is a PRICE SOURCE problem, not a candle-writing one:');
    console.log('  each bucket saw a single distinct price. A feed whose quotes refresh about');
    console.log('  once a minute produces exactly this, because ticks are skipped when the');
    console.log('  price is unchanged. Check WHICH Indian feed is actually live — Upstox polls');
    console.log('  every 1500ms with real-time data; the Yahoo fallback carries delayed index');
    console.log('  quotes that barely move between polls.');
  } else if (missing / total > 0.2) {
    console.log('  Mostly MISSING. Buckets are not being written at all. A restart explains a');
    console.log('  single hole; many scattered holes point at the feed loop stopping, or at');
    console.log('  gaps wider than the six-hour ceiling being left alone by design.');
  } else {
    console.log('  The stored series is healthy — real candles, few holes.');
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
