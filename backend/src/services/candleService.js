const Candle = require('../models/Candle');
const broadcaster = require('../websocket/server');

const TF_MS = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};

const bucket = (ts, tfMs) => Math.floor(ts / tfMs) * tfMs;

/**
 * If the last existing candle for (symbol, tf) is more than one bucket
 * behind the incoming `currentBucket`, fill the gap with flat candles
 * (carry-forward last close). Prevents visible gaps between historical
 * seed data and the first live tick after the feed reconnects.
 *
 * Caps at MAX_BACKFILL buckets per call so a long downtime doesn't
 * generate thousands of fake candles in one tick.
 */
// 1500 buckets per call covers 25h on 1m, 5 days on 5m, ~3 months on 1h.
// First tick after a long downtime pays the cost of one big bulkWrite —
// trade-off for keeping the chart visually continuous.
const MAX_BACKFILL = 1500;

// Never bridge a gap LARGER than this with flat carry-forward candles. An
// overnight / weekend / feed-outage gap must stay a real GAP — filling it with
// thousands of flat candles at the stale pre-gap price builds a giant plateau
// that swamps the chart and makes it open on old flat data instead of the live
// candles. Only small intra-session holes (left by the skip-unchanged feed) get
// smoothed. Applies to BOTH the stored gap-fill and the serve-time forward-fill.
const MAX_GAP_MS = 6 * 60 * 60 * 1000; // 6 hours

// Newest bucket this process has written, per "symbol|timeframe".
//
// The gap check below used to ask the database, on every tick and for every one
// of the eight timeframes, what the most recent candle was — and the answer was
// almost always the candle this same process had just written. That doubled the
// round trips per tick from 8 to 16. On a live feed the cluster measured 331
// writes/s and 851% DB busy on this one collection, ~95% of all its work.
//
// Bounded by instruments × timeframes (~11k × 8 here). The cap is a safety net,
// not a tuning knob: dropping the whole map only costs us one real query per
// key afterwards, which is exactly the behaviour we had before.
const _lastBucket = new Map();
const _LAST_BUCKET_MAX = 120000;

const _rememberBucket = (symbol, tf, bucketTs) => {
  if (_lastBucket.size >= _LAST_BUCKET_MAX) _lastBucket.clear();
  _lastBucket.set(`${symbol}|${tf}`, bucketTs);
};

const _backfillGaps = async (symbol, tf, tfMs, currentBucketTs, fallbackClose) => {
  // Fast path: we wrote the previous bucket ourselves, so there is provably no
  // hole and nothing to ask. Consecutive ticks land in the same bucket or the
  // next one, so this is the overwhelmingly common case.
  //
  // Only a difference of one bucket or less is trusted. A bigger jump, a cold
  // cache after restart, or a tick for a symbol we have not seen falls through
  // to the real query, so the fill behaviour itself is unchanged. A negative
  // difference (a late tick arriving out of order) is also skipped — there is
  // no gap ahead of a bucket we have already passed.
  const known = _lastBucket.get(`${symbol}|${tf}`);
  if (known != null && currentBucketTs - known <= tfMs) return;

  const last = await Candle.findOne({ symbol, timeframe: tf })
    .sort({ openTime: -1 })
    .limit(1)
    .lean();
  if (!last) return;
  await _gapFill(symbol, tf, tfMs, new Date(last.openTime).getTime(), last.close, currentBucketTs, fallbackClose);
};

// Fill the buckets strictly between lastBucketTs and currentBucketTs with flat
// candles at lastClose. Split out of _backfillGaps unchanged so the coalescing
// path can supply the previous candle from memory (see _coalesceTick).
const _gapFill = async (symbol, tf, tfMs, lastBucketTs, lastClose, currentBucketTs, fallbackClose) => {
  const gapBuckets = Math.floor((currentBucketTs - lastBucketTs) / tfMs) - 1;
  if (gapBuckets <= 0) return;
  // Large gap (overnight / weekend / outage) → leave it a real gap, don't store
  // a flat plateau at the stale price.
  if (gapBuckets * tfMs > MAX_GAP_MS) return;
  const fillCount = Math.min(gapBuckets, MAX_BACKFILL);
  const flatPrice = String(lastClose ?? fallbackClose);
  const flatPriceNum = Number(flatPrice);

  const ops = [];
  for (let i = 1; i <= fillCount; i++) {
    const openTime = new Date(lastBucketTs + i * tfMs);
    const closeTime = new Date(openTime.getTime() + tfMs);
    ops.push({
      updateOne: {
        filter: { symbol, timeframe: tf, openTime },
        update: {
          $setOnInsert: {
            symbol,
            timeframe: tf,
            openTime,
            closeTime,
            open: flatPrice,
            high: flatPrice,
            low: flatPrice,
            close: flatPrice,
            volume: '0',
          },
        },
        upsert: true,
      },
    });
    // Cheap guard against absurdly large flat blocks if data is corrupt.
    if (!Number.isFinite(flatPriceNum)) break;
  }
  if (ops.length) {
    try { await Candle.bulkWrite(ops, { ordered: false }); }
    catch (e) { /* duplicates expected on race — ignore */ }
  }
};

// ── Optional write coalescing ───────────────────────────────────────────
//
// Every tick used to cost one findOneAndUpdate per timeframe — eight round
// trips, eight writes — and a 1-minute candle was rewritten ~60 times to end
// up as one OHLC row. Candle upserts were ~89% of all database writes.
//
// With CANDLE_FLUSH_MS set, ticks are merged in memory per (symbol, timeframe,
// bucket) and flushed in ONE bulkWrite per interval. The flush uses the same
// merge as the per-tick upsert — open kept if present, high/low through $max/
// $min, close = last price, volume added left to right through $reduce — so
// the stored candle is what per-tick writes would have produced. Clients see
// no difference: candles are still broadcast on every tick (from an in-memory
// copy that starts from the stored candle), and getCandles overlays candles
// that have not been flushed yet.
//
// What changes: a crash (not a graceful stop — server.js flushes on SIGTERM)
// loses up to one interval of candle updates. Unset or 0 = the per-tick path,
// unchanged.
const flushMs = () => {
  const v = Number(process.env.CANDLE_FLUSH_MS);
  return Number.isFinite(v) && v > 0 ? v : 0;
};

// MongoDB's ordering puts NaN below every number, so $max skips it and $min
// returns it. Mirrored here so a scalar high/low merges exactly as the
// sequence of per-tick $max/$min did.
const _bsonMax = (a, b) => (Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.max(a, b));
const _bsonMin = (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : Math.min(a, b));

let _pending = new Map();       // "symbol|tf|bucketTs" -> entry awaiting flush
const _inFlight = new Set();    // keys of entries being written right now
const _views = new Map();       // "symbol|tf" -> Map(bucketTs -> candle as stored + pending)
const _inits = new Map();       // "symbol|tf|bucketTs" -> first-touch read in flight
let _flushTimer = null;
let _flushing = null;
const coalesceStats = { ticks: 0, firstTouchReads: 0, flushes: 0, ops: 0, failedOps: 0, droppedOps: 0, lateTicks: 0 };
const MAX_ATTEMPTS = 3;           // a write that keeps failing is dropped, as a failed per-tick write always was
const VIEW_BUCKETS = 2;         // current + previous bucket: covers a late tick across a boundary

const _ensureTimer = () => {
  if (_flushTimer) return;
  _flushTimer = setInterval(() => { flushCandles().catch(() => {}); }, flushMs());
  if (_flushTimer.unref) _flushTimer.unref();
};

const _broadcastView = (symbol, tf, bucketTs, v) => {
  broadcaster.broadcastCandle(symbol, tf, {
    symbol,
    timeframe: tf,
    openTime: new Date(bucketTs),
    closeTime: v.closeTime,
    open: v.open,
    high: String(v.high),
    low: String(v.low),
    close: v.close,
    volume: String(v.volume),
  });
};

/**
 * Merge one tick for one timeframe into memory. Returns false when the tick
 * belongs to a bucket older than the ones being tracked — the caller then
 * writes it the per-tick way, exactly as before.
 */
const _coalesceTick = async (symbol, tf, ms, t, priceStr, priceNum, qtyNum) => {
  const key = `${symbol}|${tf}`;
  const bucketTs = bucket(t, ms);
  const pk = `${key}|${bucketTs}`;
  let views = _views.get(key);
  if (views && views.size && !views.has(bucketTs) && bucketTs < Math.max(...views.keys())) {
    coalesceStats.lateTicks += 1;
    return false;
  }

  if (!views || !views.has(bucketTs)) {
    // First tick of this bucket in this process: start from what is stored
    // (usually nothing). Concurrent ticks share one read and resume in order.
    let read = _inits.get(pk);
    if (!read) {
      coalesceStats.firstTouchReads += 1;
      // Gap fill first, where the per-tick path runs it: before the bucket's
      // first write. The previous candle's close comes from memory when it is
      // tracked — its last ticks may not be flushed, so the stored close could
      // be stale. Otherwise from the database, exactly as before.
      const prevTs = views && views.size ? Math.max(...views.keys()) : null;
      const prevClose = prevTs != null ? views.get(prevTs).close : null;
      read = (async () => {
        if (prevTs != null) await _gapFill(symbol, tf, ms, prevTs, prevClose, bucketTs, priceStr);
        else await _backfillGaps(symbol, tf, ms, bucketTs, priceStr);
        // Tracked from here on: a late tick for an older bucket (per-tick path)
        // must see this bucket as written, as it would be without coalescing.
        _rememberBucket(symbol, tf, bucketTs);
        return Candle.findOne({ symbol, timeframe: tf, openTime: new Date(bucketTs) }).lean().exec();
      })();
      _inits.set(pk, read);
      read.finally(() => _inits.delete(pk)).catch(() => {});
    }
    const existing = await read;
    views = _views.get(key) || new Map();
    if (!views.has(bucketTs)) {
      views.set(bucketTs, existing
        ? {
          open: existing.open, close: existing.close, closeTime: existing.closeTime,
          high: Number(existing.high), low: Number(existing.low), volume: Number(existing.volume ?? '0'),
        }
        : { open: null, close: null, closeTime: new Date(bucketTs + ms), high: null, low: null, volume: 0 });
      // Trim to the newest VIEW_BUCKETS, but never drop a candle that still has
      // unflushed ticks: getCandles overlays from these copies, and dropping one
      // early would serve its stale stored version until the next flush.
      for (const ts of [...views.keys()].sort((a, b) => a - b)) {
        if (views.size <= VIEW_BUCKETS) break;
        const vk = `${key}|${ts}`;
        if (ts !== bucketTs && !_pending.has(vk) && !_inFlight.has(vk)) views.delete(ts);
      }
      _views.set(key, views);
    }
  }

  // The view: what the stored candle will be once this tick is flushed.
  const v = views.get(bucketTs);
  const first = Number(priceStr);
  v.open = v.open ?? priceStr;
  v.high = _bsonMax(priceNum, v.high == null ? first : v.high);
  v.low = _bsonMin(priceNum, v.low == null ? first : v.low);
  v.volume = qtyNum + v.volume;
  v.close = priceStr;
  v.closeTime = v.closeTime ?? new Date(bucketTs + ms);

  // The pending delta for the next flush.
  const e = _pending.get(pk);
  if (e) {
    e.hi = _bsonMax(priceNum, e.hi);
    e.lo = _bsonMin(priceNum, e.lo);
    e.lastPriceStr = priceStr;
    e.qtys.push(qtyNum);
  } else {
    _pending.set(pk, {
      pk, key, symbol, tf, tfMs: ms, bucketTs, closeTime: new Date(bucketTs + ms),
      firstPriceStr: priceStr, lastPriceStr: priceStr, hi: priceNum, lo: priceNum, qtys: [qtyNum],
    });
  }
  coalesceStats.ticks += 1;
  _ensureTimer();
  _broadcastView(symbol, tf, bucketTs, v);
  return true;
};

// The per-tick upsert's merge, applied to a whole interval's ticks at once.
const _flushOp = (e) => ({
  updateOne: {
    filter: { symbol: e.symbol, timeframe: e.tf, openTime: new Date(e.bucketTs) },
    update: [{
      $set: {
        open: { $ifNull: ['$open', e.firstPriceStr] },
        close: e.lastPriceStr,
        closeTime: { $ifNull: ['$closeTime', e.closeTime] },
        high: { $toString: { $max: [e.hi, { $toDouble: { $ifNull: ['$high', e.firstPriceStr] } }] } },
        low: { $toString: { $min: [e.lo, { $toDouble: { $ifNull: ['$low', e.firstPriceStr] } }] } },
        volume: {
          $toString: {
            $reduce: {
              input: e.qtys,
              initialValue: { $toDouble: { $ifNull: ['$volume', '0'] } },
              in: { $add: ['$$this', '$$value'] },
            },
          },
        },
      },
    }],
    upsert: true,
  },
});

// Put a failed entry back in front of anything that arrived since. When the
// failure leaves it unknown whether the write landed, its volume is dropped
// rather than risk adding it twice; open/high/low/close re-apply idempotently.
const _requeue = (e, dropVolume) => {
  const attempts = (e.attempts || 0) + 1;
  if (attempts >= MAX_ATTEMPTS) { coalesceStats.droppedOps += 1; return; }
  const later = _pending.get(e.pk);
  const qtys = dropVolume ? [] : e.qtys;
  if (later) {
    later.firstPriceStr = e.firstPriceStr;
    later.hi = _bsonMax(e.hi, later.hi);
    later.lo = _bsonMin(e.lo, later.lo);
    later.qtys = [...qtys, ...later.qtys];
    later.attempts = attempts;
  } else {
    _pending.set(e.pk, { ...e, qtys, attempts });
  }
};

/**
 * Write every pending candle in one bulkWrite. Safe to call any time; a call
 * during a flush waits for it. Exported for graceful shutdown and tests.
 */
const flushCandles = async () => {
  if (_flushing) return _flushing;
  if (!_pending.size) return undefined;
  _flushing = (async () => {
    const batch = [..._pending.values()].sort((a, b) => a.bucketTs - b.bucketTs);
    _pending = new Map();
    for (const e of batch) _inFlight.add(e.pk);
    try {
      // Gap fill already ran at each bucket's first tick (_coalesceTick), with
      // the previous candle's final close; the flush only writes.
      let failed = new Set();
      let unknown = false;
      try {
        await Candle.bulkWrite(batch.map(_flushOp), { ordered: false });
      } catch (err) {
        const we = err && Array.isArray(err.writeErrors) ? err.writeErrors : null;
        if (we && we.length) failed = new Set(we.map((w) => w.index));
        else { failed = new Set(batch.map((_, i) => i)); unknown = true; }
      }
      coalesceStats.flushes += 1;
      coalesceStats.ops += batch.length;
      coalesceStats.failedOps += failed.size;
      batch.forEach((e, i) => {
        if (failed.has(i)) _requeue(e, unknown);
        else _rememberBucket(e.symbol, e.tf, e.bucketTs);
      });
    } finally {
      for (const e of batch) _inFlight.delete(e.pk);
      _flushing = null;
    }
  })();
  return _flushing;
};

/**
 * Candles that are newer in memory than in the database, laid over rows read
 * from it (newest first). Only buckets with unflushed ticks are touched.
 */
const _overlayLive = (symbol, timeframe, rows, limit) => {
  const views = _views.get(`${symbol}|${timeframe}`);
  if (!views || !views.size) return rows;
  const out = rows.slice();
  for (const [bucketTs, v] of [...views].sort((a, b) => a[0] - b[0])) {
    const pk = `${symbol}|${timeframe}|${bucketTs}`;
    if (!_pending.has(pk) && !_inFlight.has(pk)) continue; // stored copy is current
    if (v.open == null) continue;
    const live = {
      symbol, timeframe, openTime: new Date(bucketTs), closeTime: v.closeTime,
      open: v.open, high: String(v.high), low: String(v.low), close: v.close, volume: String(v.volume),
    };
    const i = out.findIndex((r) => new Date(r.openTime).getTime() === bucketTs);
    if (i >= 0) out[i] = { ...out[i], ...live };
    else if (!out.length || bucketTs > new Date(out[0].openTime).getTime()) out.unshift(live);
  }
  return out.length > limit ? out.slice(0, limit) : out;
};

/**
 * Update candles for all timeframes for a single trade.
 *
 * Uses an atomic upsert (aggregation pipeline) so two concurrent ticks on
 * the same bucket can't both insert and produce an E11000 duplicate-key
 * error. Before the upsert we run a fast gap-backfill so the live candle
 * sits flush against the historical series with no visual hole.
 */
const updateCandlesForTrade = async ({ symbol, price, quantity, ts, timeframes }) => {
  const t = ts || Date.now();
  const priceNum = Number(price);
  const qtyNum = Number(quantity);
  const priceStr = String(price);

  // Optional subset of timeframes to write (e.g. options only need intraday TFs
  // — writing all 8 ×thousands of contracts overloads the box). Default = all.
  const tfEntries = timeframes && timeframes.length
    ? timeframes.filter((tf) => TF_MS[tf]).map((tf) => [tf, TF_MS[tf]])
    : Object.entries(TF_MS);

  const coalescing = flushMs() > 0;
  for (const [tf, ms] of tfEntries) {
    if (coalescing && await _coalesceTick(symbol, tf, ms, t, priceStr, priceNum, qtyNum)) continue;
    const bucketTs = bucket(t, ms);
    const openTime = new Date(bucketTs);
    const closeTime = new Date(bucketTs + ms);

    // Backfill any missing buckets between the last existing candle and
    // the current one — keeps the chart visually continuous.
    await _backfillGaps(symbol, tf, ms, bucketTs, priceStr);

    const candle = await Candle.findOneAndUpdate(
      { symbol, timeframe: tf, openTime },
      [
        {
          $set: {
            // First trade in the bucket wins for `open`; subsequent ticks keep it.
            open: { $ifNull: ['$open', priceStr] },
            close: priceStr,
            // closeTime is set on insert; preserve thereafter.
            closeTime: { $ifNull: ['$closeTime', closeTime] },
            high: {
              $toString: {
                $max: [priceNum, { $toDouble: { $ifNull: ['$high', priceStr] } }],
              },
            },
            low: {
              $toString: {
                $min: [priceNum, { $toDouble: { $ifNull: ['$low', priceStr] } }],
              },
            },
            volume: {
              $toString: {
                $add: [qtyNum, { $toDouble: { $ifNull: ['$volume', '0'] } }],
              },
            },
          },
        },
      ],
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Only after the write actually landed. Recording it earlier would let a
    // failed upsert suppress the gap fill that should have covered its bucket.
    _rememberBucket(symbol, tf, bucketTs);

    broadcaster.broadcastCandle(symbol, tf, {
      symbol,
      timeframe: tf,
      openTime: candle.openTime,
      closeTime: candle.closeTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    });
  }
};

const getCandles = async (symbol, timeframe, limit = 500) => {
  const tfMs = TF_MS[timeframe];
  const stored = await Candle.find({ symbol, timeframe }).sort({ openTime: -1 }).limit(limit).lean();
  // With coalescing on, the newest candle may still be in memory; show it.
  const rows = flushMs() > 0 ? _overlayLive(symbol, timeframe, stored, limit) : stored;
  if (!tfMs) return rows;

  // No stored candles yet (e.g. an option that hasn't ticked, or market closed) —
  // synthesize a short flat series at the instrument's last price so the chart
  // isn't blank. Live ticks then build real candles on top.
  if (rows.length === 0) {
    const inst = await require('../models/Instrument').findOne({ symbol }).select('lastPrice').lean();
    const px = inst && Number(inst.lastPrice) > 0 ? String(inst.lastPrice) : null;
    if (!px) return rows;
    const cur = bucket(Date.now(), tfMs);
    const out = [];
    for (let i = 0; i < 60; i += 1) { // newest-first (desc), matching the normal return
      const ot = new Date(cur - i * tfMs);
      out.push({ symbol, timeframe, openTime: ot, closeTime: new Date(ot.getTime() + tfMs), open: px, high: px, low: px, close: px, volume: '0' });
    }
    return out;
  }

  // Forward-fill missing buckets with flat carry-forward candles. A real-time
  // feed only writes a candle when the price CHANGES (perf), so stable stretches
  // leave holes — without this the chart shows dashes-with-gaps instead of a
  // continuous series. In-memory only (no DB writes). The last real candle is
  // filled up to (not incl.) the current live bucket, which the WS feed owns.
  // Is the market currently open for this symbol? When CLOSED we must NOT
  // forward-fill from the last real candle up to "now" — on a weekend (forex)
  // or after-hours that produces a giant flat run that swamps the real price
  // action, so the chart looks blank/flat. When closed we stop at the last real
  // candle so the chart shows actual history. Gaps BETWEEN real candles are
  // still filled either way (keeps the series visually contiguous).
  let marketOpen = true;
  try {
    const inst = await require('../models/Instrument').findOne({ symbol }).select('exchange category').lean();
    if (inst) marketOpen = !!require('./marketHours').isInstrumentTradeable(inst).tradeable;
  } catch (_) { /* default open — never block the chart on a lookup error */ }

  const FILL_CAP = 3000; // safety: never synthesize more than this per gap
  const asc = rows.slice().reverse();
  const out = [];
  for (let i = 0; i < asc.length; i += 1) {
    out.push(asc[i]);
    const curTs = new Date(asc[i].openTime).getTime();
    const isLast = i + 1 >= asc.length;
    // Trailing gap (last real candle → now): only bridge to the live bucket
    // while the market is OPEN. When closed, leave the last real candle as the
    // right edge of the chart.
    if (isLast && !marketOpen) continue;
    const nextTs = !isLast ? new Date(asc[i + 1].openTime).getTime() : bucket(Date.now(), tfMs);
    let gaps = Math.floor((nextTs - curTs) / tfMs) - 1;
    if (gaps <= 0) continue;
    // Leave LARGE gaps (overnight / weekend / outage) as real gaps — don't build
    // a flat plateau that swamps the chart and hides the live candles.
    if (gaps * tfMs > MAX_GAP_MS) continue;
    if (gaps > FILL_CAP) gaps = FILL_CAP;
    const c = asc[i].close;
    for (let g = 1; g <= gaps; g += 1) {
      const ot = new Date(curTs + g * tfMs);
      out.push({ symbol, timeframe, openTime: ot, closeTime: new Date(ot.getTime() + tfMs), open: c, high: c, low: c, close: c, volume: '0' });
    }
  }
  return out.reverse(); // desc, matching the original contract
};

module.exports = { updateCandlesForTrade, getCandles, TF_MS, flushCandles, coalesceStats };
