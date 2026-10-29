/*
 * Chart runtime — technical indicators.
 *
 * A line-for-line port of client/src/utils/indicators.js. It runs INSIDE the
 * chart WebView (scripts/build-chart-runtime.mjs inlines it), where the
 * candles live, so an indicator is recomputed next to the data instead of
 * shipping arrays across the bridge on every tick.
 *
 * Every function takes closes (numbers) or candles ({ time, open, high, low,
 * close, volume }) and returns values aligned to the input, null for warm-up.
 * src/__tests__/stage5_chartRuntime.test.ts runs each one against the web's
 * own file on the same inputs, so the two cannot drift.
 */
(function (root) {
  'use strict';

  var sma = function (closes, period) {
    var out = new Array(closes.length).fill(null);
    if (closes.length < period) return out;
    var sum = 0;
    for (var i = 0; i < period; i++) sum += closes[i];
    out[period - 1] = sum / period;
    for (var j = period; j < closes.length; j++) {
      sum += closes[j] - closes[j - period];
      out[j] = sum / period;
    }
    return out;
  };

  var ema = function (closes, period) {
    var out = new Array(closes.length).fill(null);
    if (closes.length < period) return out;
    var k = 2 / (period + 1);
    var prev = 0;
    for (var i = 0; i < period; i++) prev += closes[i];
    prev /= period;
    out[period - 1] = prev;
    for (var j = period; j < closes.length; j++) {
      prev = closes[j] * k + prev * (1 - k);
      out[j] = prev;
    }
    return out;
  };

  /** RSI — Wilder's smoothing, 0..100. */
  var rsi = function (closes, period) {
    if (period === undefined) period = 14;
    var out = new Array(closes.length).fill(null);
    if (closes.length <= period) return out;
    var gains = 0;
    var losses = 0;
    for (var i = 1; i <= period; i++) {
      var diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    var avgGain = gains / period;
    var avgLoss = losses / period;
    out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (var j = period + 1; j < closes.length; j++) {
      var d = closes[j] - closes[j - 1];
      var gain = d > 0 ? d : 0;
      var loss = d < 0 ? -d : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[j] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  };

  /** MACD = EMA(fast) − EMA(slow); signal = EMA(MACD); histogram = MACD − signal. */
  var macd = function (closes, fast, slow, signalPeriod) {
    if (fast === undefined) fast = 12;
    if (slow === undefined) slow = 26;
    if (signalPeriod === undefined) signalPeriod = 9;
    var fastEma = ema(closes, fast);
    var slowEma = ema(closes, slow);
    var macdLine = closes.map(function (_, i) {
      return fastEma[i] != null && slowEma[i] != null ? fastEma[i] - slowEma[i] : null;
    });
    var macdNonNull = macdLine.map(function (v) { return v == null ? 0 : v; });
    var signalLine = ema(macdNonNull, signalPeriod);
    var signal = signalLine.map(function (v, i) { return macdLine[i] == null ? null : v; });
    var histogram = macdLine.map(function (m, i) {
      return m != null && signal[i] != null ? m - signal[i] : null;
    });
    return { macd: macdLine, signal: signal, histogram: histogram };
  };

  /** Bollinger Bands — SMA(period) ± stddev × σ(period). */
  var bollinger = function (closes, period, stddev) {
    if (period === undefined) period = 20;
    if (stddev === undefined) stddev = 2;
    var middle = sma(closes, period);
    var upper = new Array(closes.length).fill(null);
    var lower = new Array(closes.length).fill(null);
    for (var i = period - 1; i < closes.length; i++) {
      var mean = middle[i];
      if (mean == null) continue;
      var variance = 0;
      for (var j = i - period + 1; j <= i; j++) variance += Math.pow(closes[j] - mean, 2);
      var sd = Math.sqrt(variance / period);
      upper[i] = mean + stddev * sd;
      lower[i] = mean - stddev * sd;
    }
    return { middle: middle, upper: upper, lower: lower };
  };

  /** VWAP — resets every UTC day, like a session VWAP. */
  var vwap = function (candles) {
    var out = new Array(candles.length).fill(null);
    var cumPv = 0;
    var cumV = 0;
    var prevDay = -1;
    for (var i = 0; i < candles.length; i++) {
      var c = candles[i];
      var tSec = typeof c.time === 'number' ? c.time : 0;
      var day = Math.floor(tSec / 86400);
      if (day !== prevDay) {
        cumPv = 0;
        cumV = 0;
        prevDay = day;
      }
      var tp = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
      var v = Number(c.volume) || 0;
      cumPv += tp * v;
      cumV += v;
      out[i] = cumV > 0 ? cumPv / cumV : null;
    }
    return out;
  };

  /** Stochastic — %K and %D = SMA(%K). */
  var stochastic = function (candles, kPeriod, dPeriod) {
    if (kPeriod === undefined) kPeriod = 14;
    if (dPeriod === undefined) dPeriod = 3;
    var k = new Array(candles.length).fill(null);
    for (var i = kPeriod - 1; i < candles.length; i++) {
      var hh = -Infinity;
      var ll = Infinity;
      for (var j = i - kPeriod + 1; j <= i; j++) {
        var h = Number(candles[j].high);
        var l = Number(candles[j].low);
        if (h > hh) hh = h;
        if (l < ll) ll = l;
      }
      var close = Number(candles[i].close);
      k[i] = hh === ll ? 50 : ((close - ll) / (hh - ll)) * 100;
    }
    var d = sma(k.map(function (v) { return v == null ? 0 : v; }), dPeriod);
    for (var m = 0; m < kPeriod - 1 + dPeriod - 1; m++) d[m] = null;
    return { k: k, d: d };
  };

  /** ATR — Wilder's smoothing. */
  var atr = function (candles, period) {
    if (period === undefined) period = 14;
    var out = new Array(candles.length).fill(null);
    if (candles.length < period + 1) return out;
    var trs = new Array(candles.length).fill(0);
    trs[0] = Number(candles[0].high) - Number(candles[0].low);
    for (var i = 1; i < candles.length; i++) {
      var h = Number(candles[i].high);
      var l = Number(candles[i].low);
      var pc = Number(candles[i - 1].close);
      trs[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    var prev = 0;
    for (var j = 0; j < period; j++) prev += trs[j];
    prev /= period;
    out[period - 1] = prev;
    for (var m = period; m < candles.length; m++) {
      prev = (prev * (period - 1) + trs[m]) / period;
      out[m] = prev;
    }
    return out;
  };

  /** Williams %R, −100..0. */
  var williamsR = function (candles, period) {
    if (period === undefined) period = 14;
    var out = new Array(candles.length).fill(null);
    for (var i = period - 1; i < candles.length; i++) {
      var hh = -Infinity;
      var ll = Infinity;
      for (var j = i - period + 1; j <= i; j++) {
        var h = Number(candles[j].high);
        var l = Number(candles[j].low);
        if (h > hh) hh = h;
        if (l < ll) ll = l;
      }
      var close = Number(candles[i].close);
      out[i] = hh === ll ? -50 : ((hh - close) / (hh - ll)) * -100;
    }
    return out;
  };

  /** CCI — (tp − SMA(tp)) / (0.015 × mean deviation). */
  var cci = function (candles, period) {
    if (period === undefined) period = 20;
    var out = new Array(candles.length).fill(null);
    var tps = candles.map(function (c) { return (Number(c.high) + Number(c.low) + Number(c.close)) / 3; });
    var smaTp = sma(tps, period);
    for (var i = period - 1; i < candles.length; i++) {
      var mean = smaTp[i];
      if (mean == null) continue;
      var dev = 0;
      for (var j = i - period + 1; j <= i; j++) dev += Math.abs(tps[j] - mean);
      var meanDev = dev / period;
      out[i] = meanDev === 0 ? 0 : (tps[i] - mean) / (0.015 * meanDev);
    }
    return out;
  };

  /** Donchian — highest high / lowest low / midline. */
  var donchian = function (candles, period) {
    if (period === undefined) period = 20;
    var upper = new Array(candles.length).fill(null);
    var lower = new Array(candles.length).fill(null);
    var middle = new Array(candles.length).fill(null);
    for (var i = period - 1; i < candles.length; i++) {
      var hh = -Infinity;
      var ll = Infinity;
      for (var j = i - period + 1; j <= i; j++) {
        var h = Number(candles[j].high);
        var l = Number(candles[j].low);
        if (h > hh) hh = h;
        if (l < ll) ll = l;
      }
      upper[i] = hh;
      lower[i] = ll;
      middle[i] = (hh + ll) / 2;
    }
    return { upper: upper, middle: middle, lower: lower };
  };

  /** Keltner — EMA(close) ± multiplier × ATR. */
  var keltner = function (candles, period, multiplier, atrPeriod) {
    if (period === undefined) period = 20;
    if (multiplier === undefined) multiplier = 2;
    if (atrPeriod === undefined) atrPeriod = 10;
    var closes = candles.map(function (c) { return Number(c.close); });
    var middle = ema(closes, period);
    var atrVals = atr(candles, atrPeriod);
    var upper = new Array(candles.length).fill(null);
    var lower = new Array(candles.length).fill(null);
    for (var i = 0; i < candles.length; i++) {
      if (middle[i] != null && atrVals[i] != null) {
        upper[i] = middle[i] + multiplier * atrVals[i];
        lower[i] = middle[i] - multiplier * atrVals[i];
      }
    }
    return { upper: upper, middle: middle, lower: lower };
  };

  var wma = function (closes, period) {
    var out = new Array(closes.length).fill(null);
    var denom = (period * (period + 1)) / 2;
    for (var i = period - 1; i < closes.length; i++) {
      var s = 0;
      for (var k = 0; k < period; k++) s += closes[i - k] * (period - k);
      out[i] = s / denom;
    }
    return out;
  };

  var hma = function (closes, period) {
    var half = Math.max(1, Math.floor(period / 2));
    var sq = Math.max(1, Math.round(Math.sqrt(period)));
    var wHalf = wma(closes, half);
    var wFull = wma(closes, period);
    var diff = closes.map(function (_, i) {
      return wHalf[i] != null && wFull[i] != null ? 2 * wHalf[i] - wFull[i] : 0;
    });
    var h = wma(diff, sq);
    return h.map(function (v, i) { return i < period + sq ? null : v; });
  };

  var emaOf = function (arr, period) {
    var out = new Array(arr.length).fill(null);
    var start = arr.findIndex(function (v) { return v != null && Number.isFinite(v); });
    if (start < 0 || arr.length - start < period) return out;
    var k = 2 / (period + 1);
    var prev = 0;
    for (var i = start; i < start + period; i++) prev += arr[i];
    prev /= period;
    out[start + period - 1] = prev;
    for (var j = start + period; j < arr.length; j++) { prev = arr[j] * k + prev * (1 - k); out[j] = prev; }
    return out;
  };

  var dema = function (closes, period) {
    var e1 = ema(closes, period);
    var e2 = emaOf(e1, period);
    return closes.map(function (_, i) { return e1[i] != null && e2[i] != null ? 2 * e1[i] - e2[i] : null; });
  };

  var tema = function (closes, period) {
    var e1 = ema(closes, period);
    var e2 = emaOf(e1, period);
    var e3 = emaOf(e2, period);
    return closes.map(function (_, i) {
      return e1[i] != null && e2[i] != null && e3[i] != null ? 3 * e1[i] - 3 * e2[i] + e3[i] : null;
    });
  };

  var smma = function (closes, period) {
    var out = new Array(closes.length).fill(null);
    if (closes.length < period) return out;
    var prev = 0;
    for (var i = 0; i < period; i++) prev += closes[i];
    prev /= period;
    out[period - 1] = prev;
    for (var j = period; j < closes.length; j++) { prev = (prev * (period - 1) + closes[j]) / period; out[j] = prev; }
    return out;
  };

  /** Volume-weighted MA; a candle with no volume weighs 1, as on the web. */
  var vwma = function (candles, period) {
    var out = new Array(candles.length).fill(null);
    for (var i = period - 1; i < candles.length; i++) {
      var pv = 0;
      var v = 0;
      for (var k = 0; k < period; k++) {
        var c = candles[i - k];
        var vol = Number(c.volume) || 1;
        pv += Number(c.close) * vol;
        v += vol;
      }
      out[i] = v > 0 ? pv / v : null;
    }
    return out;
  };

  var alma = function (closes, period, offset, sigma) {
    if (offset === undefined) offset = 0.85;
    if (sigma === undefined) sigma = 6;
    var out = new Array(closes.length).fill(null);
    var m = offset * (period - 1);
    var s = period / sigma;
    var w = [];
    var norm = 0;
    for (var k = 0; k < period; k++) { var wk = Math.exp(-Math.pow(k - m, 2) / (2 * s * s)); w[k] = wk; norm += wk; }
    for (var i = period - 1; i < closes.length; i++) {
      var sum = 0;
      for (var j = 0; j < period; j++) sum += closes[i - period + 1 + j] * w[j];
      out[i] = sum / norm;
    }
    return out;
  };

  var envelopes = function (closes, period, pct) {
    if (period === undefined) period = 20;
    if (pct === undefined) pct = 2;
    var middle = sma(closes, period);
    var f = pct / 100;
    return {
      middle: middle,
      upper: middle.map(function (v) { return v == null ? null : v * (1 + f); }),
      lower: middle.map(function (v) { return v == null ? null : v * (1 - f); }),
    };
  };

  var linreg = function (closes, period) {
    if (period === undefined) period = 14;
    var out = new Array(closes.length).fill(null);
    var n = period;
    for (var i = period - 1; i < closes.length; i++) {
      var sx = 0; var sy = 0; var sxy = 0; var sxx = 0;
      for (var k = 0; k < period; k++) {
        var x = k;
        var y = closes[i - period + 1 + k];
        sx += x; sy += y; sxy += x * y; sxx += x * x;
      }
      var denom = n * sxx - sx * sx;
      if (!denom) { out[i] = null; continue; }
      var slope = (n * sxy - sx * sy) / denom;
      var intercept = (sy - slope * sx) / n;
      out[i] = slope * (period - 1) + intercept;
    }
    return out;
  };

  var psar = function (candles, step, max) {
    if (step === undefined) step = 0.02;
    if (max === undefined) max = 0.2;
    var n = candles.length;
    var out = new Array(n).fill(null);
    if (n < 2) return out;
    var isUp = candles[1].close >= candles[0].close;
    var af = step;
    var ep = isUp ? candles[0].high : candles[0].low;
    var sar = isUp ? candles[0].low : candles[0].high;
    out[0] = sar;
    for (var i = 1; i < n; i++) {
      var h = candles[i].high;
      var l = candles[i].low;
      sar = sar + af * (ep - sar);
      if (isUp) {
        sar = Math.min(sar, candles[i - 1].low, candles[i - 2] ? candles[i - 2].low : candles[i - 1].low);
        if (l < sar) { isUp = false; sar = ep; ep = l; af = step; }
        else if (h > ep) { ep = h; af = Math.min(af + step, max); }
      } else {
        sar = Math.max(sar, candles[i - 1].high, candles[i - 2] ? candles[i - 2].high : candles[i - 1].high);
        if (h > sar) { isUp = true; sar = ep; ep = h; af = step; }
        else if (l < ep) { ep = l; af = Math.min(af + step, max); }
      }
      out[i] = sar;
    }
    return out;
  };

  var supertrend = function (candles, period, multiplier) {
    if (period === undefined) period = 10;
    if (multiplier === undefined) multiplier = 3;
    var n = candles.length;
    var out = new Array(n).fill(null);
    var a = atr(candles, period);
    var upperBand = null;
    var lowerBand = null;
    var trendUp = true;
    for (var i = 0; i < n; i++) {
      if (a[i] == null) continue;
      var hl2 = (candles[i].high + candles[i].low) / 2;
      var basicUpper = hl2 + multiplier * a[i];
      var basicLower = hl2 - multiplier * a[i];
      var prevClose = candles[i - 1] ? candles[i - 1].close : candles[i].close;
      upperBand = (upperBand == null || basicUpper < upperBand || prevClose > upperBand) ? basicUpper : upperBand;
      lowerBand = (lowerBand == null || basicLower > lowerBand || prevClose < lowerBand) ? basicLower : lowerBand;
      var close = candles[i].close;
      if (close > upperBand) trendUp = true;
      else if (close < lowerBand) trendUp = false;
      out[i] = trendUp ? lowerBand : upperBand;
    }
    return out;
  };

  var api = {
    sma: sma, ema: ema, rsi: rsi, macd: macd, bollinger: bollinger, vwap: vwap,
    stochastic: stochastic, atr: atr, williamsR: williamsR, cci: cci, donchian: donchian,
    keltner: keltner, wma: wma, hma: hma, dema: dema, tema: tema, smma: smma, vwma: vwma,
    alma: alma, envelopes: envelopes, linreg: linreg, psar: psar, supertrend: supertrend,
  };

  root.AATChart = root.AATChart || {};
  root.AATChart.indicators = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
