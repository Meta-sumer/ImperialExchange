const { eq } = require('./decimal');

// Stuck-feed execution guard.
//
// A market-data feed sometimes FREEZES: the price sits at one value for a long
// time (or repeats the same tick) while the real market keeps moving. If a
// B-book (broker-as-counterparty) order fills at that stale price, the broker
// is exposed — a user can open at the frozen price, wait for the feed to
// recover, and close for a "free" profit.
//
// This guard blocks a B-book fill unless the instrument's price is BOTH:
//   1. FRESH   — a feed tick arrived within FEED_STALE_MS, and
//   2. MOVING  — the latest tick differs from the previous tick (not frozen).
//
// It applies ONLY to B-book / internal-fallback fills at the feed price. Genuine
// internal matching between two real user orders carries its own liquidity and
// is not gated here.
const FEED_GUARD_ENABLED = String(process.env.FEED_GUARD_ENABLED ?? 'true').toLowerCase() !== 'false';
const FEED_STALE_MS = Number(process.env.FEED_STALE_MS) > 0 ? Number(process.env.FEED_STALE_MS) : 10000;
// How long the price may sit UNCHANGED, while the feed is still delivering,
// before we treat it as a stuck quote. Generous on purpose: a quiet minute on
// a real instrument is normal and must not block trading.
const FEED_FROZEN_MS = Number(process.env.FEED_FROZEN_MS) > 0 ? Number(process.env.FEED_FROZEN_MS) : 90000;

/**
 * @param {object} instrument  Instrument doc/lean with { lastPrice, prevPrice, feedUpdatedAt, lastPriceUpdatedAt }
 * @returns {{ ok: boolean, reason?: string, ageMs?: number }}
 */
function checkFeed(instrument) {
  if (!FEED_GUARD_ENABLED) return { ok: true };
  if (!instrument) return { ok: false, reason: 'NO_INSTRUMENT' };

  // Freshness — prefer the feed-exclusive timestamp so the engine's self-fills
  // (which bump lastPriceUpdatedAt) can't disguise a dead feed. Fall back to
  // lastPriceUpdatedAt for instruments whose feed doesn't stamp feedUpdatedAt yet.
  const feedAt = instrument.feedUpdatedAt || instrument.lastPriceUpdatedAt;
  const ageMs = feedAt ? Date.now() - new Date(feedAt).getTime() : Infinity;
  if (ageMs > FEED_STALE_MS) return { ok: false, reason: 'STALE_FEED', ageMs };

  // Frozen — the price has not MOVED for a sustained period even though the
  // feed is still delivering ticks (i.e. a provider pushing a cached quote).
  //
  // This deliberately does NOT compare the last two ticks. That test rejected
  // orders on a perfectly healthy feed: Binance's @trade stream fires on every
  // trade and BTC prints in $0.01 steps, so consecutive trades at the SAME
  // price are completely normal — observed live with feedUpdatedAt under one
  // second old and lastPrice === prevPrice on every sample. Polling feeds have
  // the same problem: they rewrite the identical value each cycle whenever the
  // market is quiet. "The market didn't move this second" is not a dead feed.
  //
  // `priceChangedAt` is stamped by the feeds only on a genuine change, so the
  // time since it is the real measure of a stuck price.
  const changedAt = instrument.priceChangedAt;
  if (changedAt) {
    const flatMs = Date.now() - new Date(changedAt).getTime();
    if (flatMs > FEED_FROZEN_MS) {
      return { ok: false, reason: 'FROZEN_FEED', ageMs, flatMs };
    }
  }
  // No priceChangedAt (legacy document, or a feed that doesn't stamp it yet)
  // → no evidence of a freeze. Freshness above is the guard; blocking here
  // would reject every order until the next genuine price change.
  return { ok: true, ageMs };
}

// Human-facing reason for a rejected order.
function reasonMessage(reason) {
  switch (reason) {
    case 'STALE_FEED':   return 'No liquidity — the price feed is stale. Try again in a moment.';
    case 'FROZEN_FEED':  return 'No liquidity — the price is not moving right now. Try again in a moment.';
    case 'NO_INSTRUMENT': return 'No liquidity — instrument unavailable.';
    default:             return 'No liquidity — order cannot be executed right now.';
  }
}

module.exports = { checkFeed, reasonMessage, FEED_GUARD_ENABLED, FEED_STALE_MS };
