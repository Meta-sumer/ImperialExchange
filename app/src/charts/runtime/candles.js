/*
 * Chart runtime — the candle pipeline.
 *
 * Ported from client/src/components/PriceChart.jsx: the history clean-up
 * (fillCandleGaps, :228), the diagnostics audit (analyzeCandles, :319), the
 * series shapes (:351-385) and the live-tick path of the candles WS handler
 * (:2246-2342) — the repair, the outlier clamp, and the update / append /
 * gap-fill decision — as pure functions, so jest can run them.
 *
 * All times are unix SECONDS, snapped to the timeframe's bucket grid.
 */
(function (root) {
  'use strict';

  var TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
  var tfToSeconds = function (tf) { return TF_SECONDS[tf] || 60; };
  var bucketFloor = function (sec, tfSec) { return Math.floor(sec / tfSec) * tfSec; };

  /** PriceChart.jsx MAX_BAR_MOVE — a single-bar move beyond this is corruption, not price. */
  var MAX_BAR_MOVE = 0.6;

  /**
   * PriceChart.jsx MAX_GAP_FILL_SEC — never bridge a gap LARGER than this with
   * flat carry-forward candles. An overnight / weekend / feed-outage gap stays
   * a real gap (lightweight-charts compresses it on the time axis); filling it
   * built a plateau at the stale price that made the chart open on old flat
   * data. Small intra-session holes are still smoothed.
   */
  var MAX_GAP_FILL_SEC = 6 * 60 * 60;

  var COLORS = {
    up: '#26A69A',
    down: '#EF5350',
    volumeUp: 'rgba(38, 166, 154, 0.45)',
    volumeDown: 'rgba(239, 83, 80, 0.45)',
  };

  var nowSeconds = function () { return Math.floor(Date.now() / 1000); };

  /**
   * Repair, de-duplicate and carry-forward fill a candle history
   * (PriceChart.jsx fillCandleGaps). A missing bucket inside a gap of at most
   * MAX_GAP_FILL_SEC becomes a flat candle at the previous close with zero
   * volume — "no trades this bar", not invented movement; a longer gap is
   * left open. `nowSec` is injectable for tests.
   */
  var fillCandleGaps = function (candles, tfSec, nowSec) {
    if (!Array.isArray(candles) || candles.length === 0) return [];
    var maxTime = (nowSec == null ? nowSeconds() : nowSec) + tfSec;
    var valid = candles.filter(function (c) {
      return c
        && Number.isFinite(c.time) && c.time <= maxTime
        && Number.isFinite(c.open) && Number.isFinite(c.high)
        && Number.isFinite(c.low) && Number.isFinite(c.close);
    });
    if (valid.length === 0) return [];
    var snapped = valid
      .map(function (c) {
        var o = Number(c.open);
        var cl = Number(c.close);
        var high = Math.max(Number(c.high), o, cl, Number(c.low));
        var low = Math.min(Number(c.low), o, cl, Number(c.high));
        return Object.assign({}, c, { open: o, close: cl, high: high, low: low, time: bucketFloor(c.time, tfSec) });
      })
      .sort(function (a, b) { return a.time - b.time; });
    var deduped = [];
    for (var i = 0; i < snapped.length; i++) {
      var c = snapped[i];
      var last = deduped[deduped.length - 1];
      if (last && last.time === c.time) deduped[deduped.length - 1] = c;
      else deduped.push(c);
    }
    if (deduped.length < 2) return deduped;
    // Outlier protection against a rolling median of the last 20 closes.
    var recent = [];
    var ref = null;
    for (var j = 0; j < deduped.length; j++) {
      var d = deduped[j];
      if (ref != null && ref > 0) {
        var dev = Math.max(
          Math.abs(d.high - ref), Math.abs(d.low - ref),
          Math.abs(d.open - ref), Math.abs(d.close - ref)
        ) / ref;
        if (!Number.isFinite(dev) || dev > MAX_BAR_MOVE) {
          d.open = ref; d.high = ref; d.low = ref; d.close = ref;
        }
      }
      if (Number.isFinite(d.close) && d.close > 0) {
        recent.push(d.close);
        if (recent.length > 20) recent.shift();
        var sorted = recent.slice().sort(function (a, b) { return a - b; });
        ref = sorted[Math.floor(sorted.length / 2)];
      }
    }
    var out = [deduped[0]];
    for (var k = 1; k < deduped.length; k++) {
      var prev = out[out.length - 1];
      var next = deduped[k];
      if ((next.time - prev.time) <= MAX_GAP_FILL_SEC) {
        var t = prev.time + tfSec;
        while (t < next.time) {
          var cf = prev.close;
          out.push({ time: t, open: cf, high: cf, low: cf, close: cf, volume: 0 });
          t += tfSec;
        }
      }
      out.push(next);
    }
    return out;
  };

  /** Structural audit of a candle array (PriceChart.jsx:319). */
  var analyzeCandles = function (raw, tfSec, nowSec) {
    var s = { total: 0, invalid: 0, duplicates: 0, outOfOrder: 0, future: 0, gaps: 0, lastAgeSec: null };
    if (!Array.isArray(raw) || !raw.length) return s;
    s.total = raw.length;
    var now = nowSec == null ? Date.now() / 1000 : nowSec;
    var prev = -Infinity;
    var seen = new Set();
    var times = [];
    for (var i = 0; i < raw.length; i++) {
      var c = raw[i];
      if (!c || !Number.isFinite(c.time)) { s.invalid++; continue; }
      var o = +c.open; var h = +c.high; var l = +c.low; var cl = +c.close;
      if (![o, h, l, cl].every(Number.isFinite) || h < Math.max(o, cl) || l > Math.min(o, cl) || h < l) s.invalid++;
      if (c.time > now + 1) s.future++;
      if (seen.has(c.time)) s.duplicates++; else { seen.add(c.time); times.push(c.time); }
      if (c.time < prev) s.outOfOrder++;
      if (c.time > prev) prev = c.time;
    }
    if (times.length > 1 && tfSec > 0) {
      times.sort(function (a, b) { return a - b; });
      for (var j = 1; j < times.length; j++) {
        var d = Math.round((times[j] - times[j - 1]) / tfSec);
        if (d > 1) s.gaps += d - 1;
      }
    }
    var last = raw[raw.length - 1];
    if (last && Number.isFinite(last.time)) s.lastAgeSec = Math.max(0, Math.round(now - last.time));
    return s;
  };

  var toLineData = function (candles) {
    return candles.map(function (c) { return { time: c.time, value: Number(c.close) }; });
  };

  var volumePoint = function (c) {
    return {
      time: c.time,
      value: Number(c.volume) || 0,
      color: c.close >= c.open ? COLORS.volumeUp : COLORS.volumeDown,
    };
  };

  var toVolumeData = function (candles) { return candles.map(volumePoint); };

  /** Heikin Ashi (PriceChart.jsx:372). */
  var toHeikinAshi = function (candles) {
    var out = [];
    for (var i = 0; i < candles.length; i++) {
      var c = candles[i];
      var O = Number(c.open); var H = Number(c.high); var L = Number(c.low); var C = Number(c.close);
      var haClose = (O + H + L + C) / 4;
      var prev = out[i - 1];
      var haOpen = prev ? (prev.open + prev.close) / 2 : (O + C) / 2;
      out.push({ time: c.time, open: haOpen, high: Math.max(H, haOpen, haClose), low: Math.min(L, haOpen, haClose), close: haClose });
    }
    return out;
  };

  /** The baseline chart's base value: the median close (PriceChart.jsx:711). */
  var medianClose = function (candles) {
    var closes = candles.map(function (c) { return c.close; }).filter(Number.isFinite).sort(function (a, b) { return a - b; });
    var m = closes[Math.floor(closes.length / 2)];
    return m === undefined ? 0 : m;
  };

  /**
   * One live candle into the history (PriceChart.jsx:2246-2342). Returns null
   * when the tick is dropped (unusable, future, or late), else the next array,
   * the repaired point, the action, and whether filler candles were added —
   * which the chart must bulk-set rather than `update()`.
   */
  var mergeLiveCandle = function (candles, raw, tfSec, nowSec) {
    if (!raw) return null;
    var point = {
      time: bucketFloor(Number(raw.time), tfSec),
      open: Number(raw.open),
      high: Number(raw.high),
      low: Number(raw.low),
      close: Number(raw.close),
      volume: Number(raw.volume) || 0,
    };
    if (!Number.isFinite(point.time) || !Number.isFinite(point.close)) return null;
    var now = nowSec == null ? nowSeconds() : nowSec;
    if (point.time > now + tfSec) return null;
    var last = candles[candles.length - 1];
    var lastTime = last ? last.time : undefined;
    if (last && point.time < lastTime) return null;

    if (!Number.isFinite(point.open)) point.open = point.close;
    var o = point.open;
    var c2 = point.close;
    var h = Number.isFinite(point.high) ? point.high : Math.max(o, c2);
    var l = Number.isFinite(point.low) ? point.low : Math.min(o, c2);
    point.high = Math.max(h, o, c2, l);
    point.low = Math.min(l, o, c2, h);
    var prevClose = last && Number.isFinite(last.close) ? last.close : null;
    if (prevClose && prevClose > 0) {
      var dev = Math.max(
        Math.abs(point.high - prevClose), Math.abs(point.low - prevClose),
        Math.abs(point.open - prevClose), Math.abs(point.close - prevClose)
      ) / prevClose;
      if (!Number.isFinite(dev) || dev > MAX_BAR_MOVE) {
        var hiB = prevClose * (1 + MAX_BAR_MOVE);
        var loB = prevClose * (1 - MAX_BAR_MOVE);
        var cl = function (v) { return Math.min(hiB, Math.max(loB, v)); };
        point.open = cl(point.open);
        point.close = cl(point.close);
        point.high = Math.max(cl(point.high), point.open, point.close);
        point.low = Math.min(cl(point.low), point.open, point.close);
      }
    }

    if (last && lastTime === point.time) {
      return { candles: candles.slice(0, -1).concat([point]), point: point, action: 'update-current', bulk: false };
    }
    if (last && point.time > lastTime + tfSec) {
      var fillers = [];
      var carry = last.close;
      for (var t = lastTime + tfSec; t < point.time; t += tfSec) {
        fillers.push({ time: t, open: carry, high: carry, low: carry, close: carry, volume: 0 });
      }
      return { candles: candles.concat(fillers, [point]), point: point, action: 'new-with-gap-fill', bulk: true };
    }
    return { candles: candles.concat([point]), point: point, action: 'new', bulk: false };
  };

  var api = {
    TF_SECONDS: TF_SECONDS,
    MAX_BAR_MOVE: MAX_BAR_MOVE,
    MAX_GAP_FILL_SEC: MAX_GAP_FILL_SEC,
    COLORS: COLORS,
    tfToSeconds: tfToSeconds,
    bucketFloor: bucketFloor,
    fillCandleGaps: fillCandleGaps,
    analyzeCandles: analyzeCandles,
    toLineData: toLineData,
    volumePoint: volumePoint,
    toVolumeData: toVolumeData,
    toHeikinAshi: toHeikinAshi,
    medianClose: medianClose,
    mergeLiveCandle: mergeLiveCandle,
  };

  root.AATChart = root.AATChart || {};
  root.AATChart.candles = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
