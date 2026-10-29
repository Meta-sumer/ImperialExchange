/*
 * Chart runtime — the chart itself, inside the WebView.
 *
 * client/src/components/PriceChart.jsx, minus React and minus everything the
 * app draws natively (toolbar, pickers, sheets, the order form). The app
 * talks to it with JSON messages (window.__aatReceive) and hears back through
 * ReactNativeWebView.postMessage; src/charts/protocol.ts types both ways.
 *
 * What lives here, and why here: the candles (so indicators and the drawing
 * engine read them without crossing the bridge per tick), the series and
 * sub-panes, the price lines, the draggable position / order pills (a drag
 * has to track a finger at 60 fps), the OHLC status line, the indicator
 * legend, the bar countdown, the diagnostics and next-event chips and the
 * measure readout. Every action a pill or legend row triggers is POSTED —
 * nothing here talks to the server.
 */
(function (root) {
  'use strict';

  var LWC = root.LightweightCharts;
  var I = root.AATChart.indicators;
  var C = root.AATChart.candles;
  var D = root.AATChart.drawings;

  var post = function (type, payload) {
    var msg = Object.assign({ type: type }, payload || {});
    try {
      if (root.ReactNativeWebView) root.ReactNativeWebView.postMessage(JSON.stringify(msg));
    } catch (e) { /* bridge gone — the screen is unmounting */ }
  };

  root.addEventListener('error', function (e) {
    post('error', { message: String((e && e.message) || e) });
  });

  /* ── palettes (PriceChart.jsx:91-125) ── */
  var TV = { up: '#26A69A', down: '#EF5350' };
  var canvasPalette = function (mode) {
    return mode === 'dark'
      ? { background: '#0F1623', grid: 'rgba(255, 255, 255, 0.06)', border: 'rgba(255, 255, 255, 0.12)', text: '#94A3B8', crosshair: 'rgba(255, 255, 255, 0.30)', crosshairLabelBg: '#E5E7EB', panel: 'rgba(15,23,42,0.86)', ink: '#E2E8F0', muted: '#94A3B8' }
      : { background: '#FFFFFF', grid: 'rgba(17, 24, 39, 0.06)', border: 'rgba(17, 24, 39, 0.10)', text: '#6B7280', crosshair: 'rgba(17, 24, 39, 0.25)', crosshairLabelBg: '#1F2937', panel: 'rgba(255,255,255,0.86)', ink: '#0F172A', muted: '#64748B' };
  };
  /*
   * The price scale's pixel cushions (PriceChart.jsx). They COMPOUND with the
   * autoscale's price padding, so they stay small: the pre-volume default at
   * creation, then the volume effect's value — bottom 0.06 without volume,
   * 0.16 with it (matching the volume row's top: 0.84 exactly).
   */
  var PRICE_SCALE_MARGINS = {
    INITIAL: { top: 0.05, bottom: 0.08 },
    NO_VOLUME: { top: 0.05, bottom: 0.06 },
    WITH_VOLUME: { top: 0.05, bottom: 0.16 },
  };
  var PRICE_SCALE_MODE = { normal: 0, log: 1, percent: 2, indexed: 3 };
  var AXIS_MIN_WIDTH = 60;
  /** The autoscale's price padding, a fraction of the visible span (PriceChart.jsx PRICE_PAD_RATIO). */
  var PRICE_PAD_RATIO = 0.04;
  /** The span floor, a fraction of price, so a dead-flat market is not over-zoomed (MIN_REL_SPAN). */
  var MIN_REL_SPAN = 2e-4;

  /* Moving-average families — the codes PriceChart.jsx:12 knows. */
  var MA_FN = {
    ema: { fn: I.ema, src: 'closes', color: '#1D4ED8', name: 'EMA' },
    sma: { fn: I.sma, src: 'closes', color: '#F59E0B', name: 'SMA' },
    wma: { fn: I.wma, src: 'closes', color: '#22C55E', name: 'WMA' },
    hma: { fn: I.hma, src: 'closes', color: '#EC4899', name: 'HMA' },
    dema: { fn: I.dema, src: 'closes', color: '#14B8A6', name: 'DEMA' },
    tema: { fn: I.tema, src: 'closes', color: '#8B5CF6', name: 'TEMA' },
    smma: { fn: I.smma, src: 'closes', color: '#0EA5E9', name: 'SMMA' },
    vwma: { fn: I.vwma, src: 'candles', color: '#F97316', name: 'VWMA' },
    alma: { fn: I.alma, src: 'closes', color: '#A855F7', name: 'ALMA' },
  };
  var MA_RE = /^(ema|sma|wma|hma|dema|tema|smma|vwma|alma)(\d+)$/;

  /* ── state ── */
  var S = {
    ready: false,
    mode: 'light',
    sub: { background: '#F8F9FB', text: '#1F2937', grid: '#E5E7EB', border: '#D1D5DB' },
    prefs: {},
    chartType: 'candles',
    indicators: {},
    legend: [],
    precision: 2,
    symbol: '',
    name: '',
    timeframe: '1m',
    tfSec: 60,
    timeZone: 'local',
    dataKey: '',
    candles: [],
    hideHeader: false,
    legendInset: 0,
    lines: [],
    pills: [],
    pillColors: { tp: '#10b981', sl: '#ef4444', entry: '#EAB308' },
    quote: { bid: null, ask: null, last: null },
    flags: { signals: false, hmr: false },
    calEvents: [],
    nextEvent: null,
    measure: null,
    logoUrl: '',
    manualPrice: false,
    manualTime: false,
    extras: [],
    sync: { crosshair: false, time: false },
    hover: null,
  };

  var chart = null;
  var series = null;
  var volumeSeries = null;
  var overlays = {};
  var subs = {};
  var priceLines = new Map();
  var drawings = null;
  var el = {};

  var $ = function (id) { return document.getElementById(id); };
  var fmtPrice = function (v, prec) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    var p = prec == null ? S.precision : prec;
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: p, maximumFractionDigits: p });
  };
  var safe = function (fn) { try { return fn(); } catch (e) { return undefined; } };

  /* ── time formatting (PriceChart.jsx:1716-1727) ── */
  var tzOpt = function () { return (S.timeZone === 'utc' || S.timeZone === 'gmt') ? { timeZone: 'UTC' } : {}; };
  var toSec = function (t) { return typeof t === 'number' ? t : Math.floor(Date.UTC(t.year, t.month - 1, t.day) / 1000); };
  var isIntraday = function () { return S.timeframe === '1m' || S.timeframe === '5m' || S.timeframe === '15m' || S.timeframe === '1h' || S.timeframe === '4h'; };
  var tickFmt = function (t) {
    var p = S.prefs;
    var d = new Date(toSec(t) * 1000);
    if (isIntraday()) {
      return d.toLocaleTimeString([], Object.assign({ hour: '2-digit', minute: '2-digit', hour12: !p.hours24 }, p.secondsVisible ? { second: '2-digit' } : {}, tzOpt()));
    }
    return d.toLocaleDateString([], Object.assign(p.dayOfWeek ? { weekday: 'short' } : {}, { day: '2-digit', month: 'short' }, tzOpt()));
  };
  var crosshairFmt = function (t) {
    var p = S.prefs;
    return new Date(toSec(t) * 1000).toLocaleString([], Object.assign(
      p.dayOfWeek ? { weekday: 'short' } : {},
      { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: !p.hours24 },
      p.secondsVisible ? { second: '2-digit' } : {},
      tzOpt()
    ));
  };

  /* ── autoscale (PriceChart.jsx:404-559, the live path) ── */
  var autoscale = function (base) {
    var b = null;
    try { b = typeof base === 'function' ? base() : null; } catch (e) { b = null; }
    var lo; var hi;
    if (b && b.priceRange && Number.isFinite(b.priceRange.minValue) && Number.isFinite(b.priceRange.maxValue)) {
      lo = b.priceRange.minValue; hi = b.priceRange.maxValue;
    } else {
      var data = S.candles;
      if (!data || data.length < 1) return b || null;
      lo = Infinity; hi = -Infinity;
      for (var i = Math.max(0, data.length - 100); i < data.length; i++) {
        var c = data[i];
        if (!c) continue;
        if (Number.isFinite(c.low) && c.low < lo) lo = c.low;
        if (Number.isFinite(c.high) && c.high > hi) hi = c.high;
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return b || null;
    }
    var extras = S.extras;
    if (extras.length) {
      var span0 = Math.max(hi - lo, 1e-9);
      var maxStretch = span0 * 0.25;
      for (var j = 0; j < extras.length; j++) {
        var p = extras[j];
        if (!Number.isFinite(p) || p <= 0) continue;
        if (p < lo) lo = Math.max(p, lo - maxStretch);
        if (p > hi) hi = Math.min(p, hi + maxStretch);
      }
    }
    // Floor the span before padding: on a dead-flat market the raw visible
    // range can be almost zero, and scaling to it turns tick noise into what
    // looks like a rally.
    var mid = (hi + lo) / 2;
    var minSpan = Math.max(Math.abs(mid) * MIN_REL_SPAN, 1e-9);
    var span = hi - lo;
    if (!Number.isFinite(span) || span < minSpan) {
      lo = mid - minSpan / 2;
      hi = mid + minSpan / 2;
      span = minSpan;
    }
    var pad = span * PRICE_PAD_RATIO;
    return { priceRange: { minValue: lo - pad, maxValue: hi + pad } };
  };

  var refitY = function () {
    if (S.manualPrice || !series) return;
    safe(function () { series.priceScale().applyOptions({ autoScale: true }); });
  };

  /* ── main chart ── */
  var createMain = function () {
    var pal = canvasPalette(S.mode);
    chart = LWC.createChart(el.chart, {
      autoSize: true,
      localization: { locale: navigator.language || 'en-US', timeFormatter: crosshairFmt },
      grid: { vertLines: { color: pal.grid }, horzLines: { color: pal.grid } },
      timeScale: {
        timeVisible: true, secondsVisible: false, borderColor: pal.border, tickMarkFormatter: tickFmt,
        barSpacing: 8, minBarSpacing: 2, rightOffset: 12, fixLeftEdge: true,
        // ON: the library follows the live edge by itself — it shifts the
        // range on a new bar only while the last bar is visible, so a trader
        // reading history is never yanked back (PriceChart.jsx).
        lockVisibleTimeRangeOnResize: true, rightBarStaysOnScroll: true, shiftVisibleRangeOnNewBar: true,
      },
      rightPriceScale: {
        visible: true, borderVisible: true, borderColor: pal.border, minimumWidth: AXIS_MIN_WIDTH,
        autoScale: true, scaleMargins: PRICE_SCALE_MARGINS.INITIAL, mode: 0,
        entireTextOnly: false, alignLabels: true, ticksVisible: true,
      },
      crosshair: {
        mode: 0,
        vertLine: { width: 1, color: pal.crosshair, style: 2, visible: false, labelBackgroundColor: pal.crosshairLabelBg, labelVisible: true },
        horzLine: { width: 1, color: pal.crosshair, style: 2, visible: false, labelBackgroundColor: pal.crosshairLabelBg, labelVisible: true },
      },
      layout: { background: { type: 'solid', color: pal.background }, textColor: pal.text, fontSize: 11, fontFamily: '-apple-system, system-ui, Roboto, sans-serif', attributionLogo: false },
      kineticScroll: { touch: true, mouse: false },
    });

    var refitTimer = 0;
    chart.timeScale().subscribeVisibleLogicalRangeChange(function (range) {
      if (!S.manualPrice) {
        if (refitTimer) cancelAnimationFrame(refitTimer);
        refitTimer = requestAnimationFrame(refitY);
      }
      syncSubRanges(chart, range);
      if (S.sync.time && range && !applyingRange) postRange(range);
    });

    chart.subscribeCrosshairMove(function (param) {
      onCrosshair(param, chart);
      if (S.sync.crosshair && !applyingCrosshair) postCrosshair(param);
    });

    drawings = D.createDrawings({
      chart: chart,
      getSeries: function () { return series; },
      container: el.chart,
      getCandles: function () { return S.candles; },
      getPrecision: function () { return S.precision; },
      post: post,
      onMeasure: function (m) { S.measure = m; renderMeasure(); },
    });
  };

  var applyTheme = function () {
    var pal = canvasPalette(S.mode);
    document.body.style.background = pal.background;
    if (!chart) return;
    safe(function () {
      chart.applyOptions({
        layout: { background: { type: 'solid', color: pal.background }, textColor: pal.text },
        grid: { vertLines: { color: pal.grid }, horzLines: { color: pal.grid } },
        timeScale: { borderColor: pal.border },
        rightPriceScale: { borderColor: pal.border },
        crosshair: {
          vertLine: { color: pal.crosshair, labelBackgroundColor: pal.crosshairLabelBg },
          horzLine: { color: pal.crosshair, labelBackgroundColor: pal.crosshairLabelBg },
        },
      });
    });
    Object.keys(subs).forEach(function (k) { applySubTheme(subs[k]); });
    document.documentElement.setAttribute('data-mode', S.mode);
    renderLegend();
  };

  /* ── settings (PriceChart.jsx:1713-1743) ── */
  var isCandleType = function (t) { return t === 'candles' || t === 'bars' || t === 'heikinAshi'; };
  var applyPrefs = function () {
    if (!chart) return;
    var p = S.prefs;
    safe(function () { chart.applyOptions({ localization: { timeFormatter: crosshairFmt }, timeScale: { tickMarkFormatter: tickFmt, secondsVisible: !!p.secondsVisible } }); });
    safe(function () {
      chart.priceScale('right').applyOptions({
        mode: PRICE_SCALE_MODE[p.scaleMode] == null ? 0 : PRICE_SCALE_MODE[p.scaleMode],
        invertScale: !!p.invert, autoScale: !!p.autoScale, alignLabels: !!p.alignLabels,
      });
    });
    safe(function () { chart.applyOptions({ grid: { vertLines: { visible: !!p.gridLines }, horzLines: { visible: !!p.gridLines } } }); });
    if (series) {
      safe(function () { series.applyOptions({ lastValueVisible: !!p.lastValueVisible }); });
      // The web compares against 'hollow' / 'heikin', ids no chart type has,
      // so its colour setting never reached hollow candles or Heikin Ashi.
      if (isCandleType(S.chartType)) {
        safe(function () { series.applyOptions({ upColor: p.upColor, downColor: p.downColor, wickUpColor: p.upColor, wickDownColor: p.downColor, borderUpColor: p.upColor, borderDownColor: p.downColor }); });
      } else if (S.chartType === 'hollowCandles') {
        safe(function () { series.applyOptions({ downColor: p.downColor, wickUpColor: p.upColor, wickDownColor: p.downColor, borderUpColor: p.upColor, borderDownColor: p.downColor }); });
      }
    }
    renderCountdown();
    renderDiagnostics();
  };

  /* ── series by chart type (PriceChart.jsx:570-676) ── */
  var createSeries = function (type) {
    var up = S.prefs.upColor || TV.up;
    var down = S.prefs.downColor || TV.down;
    switch (type) {
      case 'bars': return chart.addBarSeries({ upColor: up, downColor: down, thinBars: false, autoscaleInfoProvider: autoscale });
      case 'hollowCandles': return chart.addCandlestickSeries({ upColor: 'rgba(0,0,0,0)', downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down, autoscaleInfoProvider: autoscale });
      case 'line': return chart.addLineSeries({ color: '#1D4ED8', lineWidth: 2, lineType: 0, priceLineVisible: true, crosshairMarkerVisible: true });
      case 'lineMarkers': return chart.addLineSeries({ color: '#1D4ED8', lineWidth: 2, lineType: 0, priceLineVisible: true, crosshairMarkerVisible: true });
      case 'stepLine': return chart.addLineSeries({ color: '#1D4ED8', lineWidth: 2, lineType: 1, priceLineVisible: true });
      case 'area': return chart.addAreaSeries({ topColor: 'rgba(29, 78, 216, 0.30)', bottomColor: 'rgba(29, 78, 216, 0.00)', lineColor: '#1D4ED8', lineWidth: 2 });
      case 'baseline': return chart.addBaselineSeries({
        baseValue: { type: 'price', price: 0 }, topLineColor: TV.up, topFillColor1: 'rgba(38, 166, 154, 0.30)', topFillColor2: 'rgba(38, 166, 154, 0.00)',
        bottomLineColor: TV.down, bottomFillColor1: 'rgba(239, 83, 80, 0.00)', bottomFillColor2: 'rgba(239, 83, 80, 0.30)', lineWidth: 2,
      });
      case 'histogram': return chart.addHistogramSeries({ priceFormat: { type: 'volume' } });
      case 'heikinAshi': return chart.addCandlestickSeries({ upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down, autoscaleInfoProvider: autoscale });
      case 'candles':
      default: return chart.addCandlestickSeries({ upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down, autoscaleInfoProvider: autoscale });
    }
  };

  var lineMarkerDots = function () {
    return S.candles.map(function (c) { return { time: c.time, position: 'inBar', shape: 'circle', color: '#1D4ED8', size: 0.5 }; });
  };

  var setSeriesData = function () {
    if (!series) return;
    var cs = S.candles;
    safe(function () {
      switch (S.chartType) {
        case 'line': case 'stepLine': case 'area': case 'lineMarkers': series.setData(C.toLineData(cs)); break;
        case 'baseline':
          series.setData(C.toLineData(cs));
          series.applyOptions({ baseValue: { type: 'price', price: C.medianClose(cs) } });
          break;
        case 'histogram': series.setData(C.toVolumeData(cs)); break;
        case 'heikinAshi': series.setData(C.toHeikinAshi(cs)); break;
        default: series.setData(cs); break;
      }
    });
    if (volumeSeries) safe(function () { volumeSeries.setData(C.toVolumeData(cs)); });
    updateLastPriceColor();
  };

  var updateSeriesPoint = function (point) {
    if (!series) return;
    safe(function () {
      switch (S.chartType) {
        case 'line': case 'stepLine': case 'area': case 'baseline': case 'lineMarkers':
          series.update({ time: point.time, value: Number(point.close) });
          break;
        case 'histogram': series.update(C.volumePoint(point)); break;
        case 'heikinAshi': {
          var ha = C.toHeikinAshi(S.candles);
          var last = ha[ha.length - 1];
          if (last) series.update(last);
          break;
        }
        default: series.update(point); break;
      }
    });
    if (volumeSeries) safe(function () { volumeSeries.update(C.volumePoint(point)); });
    updateLastPriceColor();
  };

  var updateLastPriceColor = function () {
    var last = S.candles[S.candles.length - 1];
    if (!series || !last || S.chartType === 'histogram') return;
    safe(function () { series.applyOptions({ priceLineColor: last.close >= last.open ? TV.up : TV.down }); });
  };

  /*
   * The live price into the series' LAST point (PriceChart.jsx livePrice
   * effect), so the last-price line and the line chart's end follow the
   * market between candle frames. Heikin Ashi and histogram advance on candle
   * frames only. The in-memory last candle is kept in step, so the autoscale
   * and the OHLC legend read the live value too.
   */
  var LIVE_LINE_TYPES = { line: 1, stepLine: 1, area: 1, baseline: 1 };
  var LIVE_BAR_TYPES = { candles: 1, bars: 1, hollowCandles: 1 };
  var applyLivePrice = function (px) {
    if (!series || !Number.isFinite(px) || px <= 0) return;
    var last = S.candles[S.candles.length - 1];
    if (!last || !Number.isFinite(last.time)) return;
    try {
      if (LIVE_LINE_TYPES[S.chartType]) {
        series.update({ time: last.time, value: px });
      } else if (LIVE_BAR_TYPES[S.chartType]) {
        series.update({ time: last.time, open: Number(last.open), high: Math.max(Number(last.high), px), low: Math.min(Number(last.low), px), close: px });
      } else {
        return;
      }
      last.close = px;
      if (px > Number(last.high)) last.high = px;
      if (px < Number(last.low)) last.low = px;
      updateLastPriceColor();
      if (!S.hover) renderLegend();
    } catch (e) { /* the series may be mid-recreate on a chart-type switch */ }
  };

  var applyPrecision = function () {
    if (!series || S.chartType === 'histogram') return;
    var p = Math.max(0, Math.min(8, Number(S.precision) || 2));
    var minMove = Number('1e-' + p) || 0.01;
    safe(function () {
      series.applyOptions({ priceFormat: { type: 'price', precision: p, minMove: minMove }, priceLineVisible: true, priceLineStyle: 2, priceLineWidth: 1 });
    });
  };

  /** Chart-type swap (PriceChart.jsx:1982): old series out, lines rebuilt on the new one. */
  var rebuildSeries = function () {
    if (!chart) return;
    if (series) { safe(function () { chart.removeSeries(series); }); series = null; }
    if (volumeSeries) { safe(function () { chart.removeSeries(volumeSeries); }); volumeSeries = null; }
    priceLines.clear();
    series = createSeries(S.chartType);
    applyPrecision();
    applyVolume();
    applyPrefs();
    if (S.candles.length) setSeriesData();
    applyLines();
    applyMarkers();
  };

  /** Volume row (PriceChart.jsx:2033): bottom 16% on its own scale. */
  var applyVolume = function () {
    if (!chart) return;
    var want = !!S.indicators.volume && S.chartType !== 'histogram';
    if (!want) {
      if (volumeSeries) {
        safe(function () { chart.removeSeries(volumeSeries); });
        volumeSeries = null;
      }
      safe(function () { chart.priceScale('right').applyOptions({ scaleMargins: PRICE_SCALE_MARGINS.NO_VOLUME }); });
      return;
    }
    if (!volumeSeries) {
      safe(function () {
        volumeSeries = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'volume', color: 'rgba(38, 166, 154, 0.45)', lastValueVisible: false, priceLineVisible: false });
        chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
        chart.priceScale('right').applyOptions({ scaleMargins: PRICE_SCALE_MARGINS.WITH_VOLUME });
        if (S.candles.length) volumeSeries.setData(C.toVolumeData(S.candles));
      });
    }
  };

  /* ── overlays (PriceChart.jsx:2426-2512) ── */
  var cfgOf = function (k) { var v = S.indicators[k]; return v && typeof v === 'object' ? v : {}; };
  var ilen = function (k, d) { var v = S.indicators[k]; return (v && typeof v === 'object' && v.length) ? Number(v.length) : d; };

  var overlayConfigs = function (closes, cs) {
    var keys = Object.keys(S.indicators).concat(Object.keys(overlays)).filter(function (k, i, arr) { return arr.indexOf(k) === i && MA_RE.test(k); });
    var list = keys.map(function (k) {
      var m = MA_RE.exec(k);
      var def = MA_FN[m[1]];
      var p = Number(m[2]);
      return { key: k, color: def.color, title: def.name + ' ' + p, compute: function () { return def.fn(def.src === 'candles' ? cs : closes, p); } };
    });
    var bb = function () { return I.bollinger(closes, ilen('bb', 20), 2); };
    var dc = function () { return I.donchian(cs, ilen('donchian', 20)); };
    var kc = function () { return I.keltner(cs, ilen('keltner', 20), 2, 10); };
    var env = function () { return I.envelopes(closes, ilen('envelopes', 20), 2); };
    var memo = function (fn) { var v; return function () { if (v === undefined) v = fn(); return v; }; };
    var bbM = memo(bb); var dcM = memo(dc); var kcM = memo(kc); var envM = memo(env);
    return list.concat([
      { key: 'bb', subKey: 'bbU', color: '#0EA5E9', lineWidth: 1, title: 'BB Upper', compute: function () { return bbM().upper; } },
      { key: 'bb', subKey: 'bbM', color: '#0EA5E9', lineWidth: 1, lineStyle: 'dashed', title: 'BB Middle', compute: function () { return bbM().middle; } },
      { key: 'bb', subKey: 'bbL', color: '#0EA5E9', lineWidth: 1, title: 'BB Lower', compute: function () { return bbM().lower; } },
      { key: 'donchian', subKey: 'dcU', color: '#10B981', lineWidth: 1, title: 'DC Upper', compute: function () { return dcM().upper; } },
      { key: 'donchian', subKey: 'dcM', color: '#10B981', lineWidth: 1, lineStyle: 'dashed', title: 'DC Middle', compute: function () { return dcM().middle; } },
      { key: 'donchian', subKey: 'dcL', color: '#10B981', lineWidth: 1, title: 'DC Lower', compute: function () { return dcM().lower; } },
      { key: 'keltner', subKey: 'ktU', color: '#F97316', lineWidth: 1, title: 'KC Upper', compute: function () { return kcM().upper; } },
      { key: 'keltner', subKey: 'ktM', color: '#F97316', lineWidth: 1, lineStyle: 'dashed', title: 'KC Middle', compute: function () { return kcM().middle; } },
      { key: 'keltner', subKey: 'ktL', color: '#F97316', lineWidth: 1, title: 'KC Lower', compute: function () { return kcM().lower; } },
      { key: 'vwap', color: '#7C3AED', lineWidth: 2, title: 'VWAP', compute: function () { return I.vwap(cs); } },
      { key: 'envelopes', subKey: 'envU', color: '#64748B', lineWidth: 1, title: 'Env Upper', compute: function () { return envM().upper; } },
      { key: 'envelopes', subKey: 'envM', color: '#64748B', lineWidth: 1, lineStyle: 'dashed', title: 'Env Mid', compute: function () { return envM().middle; } },
      { key: 'envelopes', subKey: 'envL', color: '#64748B', lineWidth: 1, title: 'Env Lower', compute: function () { return envM().lower; } },
      { key: 'linreg', color: '#0D9488', lineWidth: 2, title: 'Linear Regression', compute: function () { return I.linreg(closes, ilen('linreg', 14)); } },
      { key: 'psar', color: '#DC2626', lineWidth: 1, pointMarkers: true, title: 'Parabolic SAR', compute: function () { return I.psar(cs); } },
      { key: 'supertrend', color: '#0891B2', lineWidth: 2, title: 'SuperTrend', compute: function () { return I.supertrend(cs, ilen('supertrend', 10), 3); } },
    ]);
  };

  var applyOverlays = function () {
    if (!chart) return;
    var cs = S.candles;
    var closes = cs.map(function (c) { return c.close; });
    overlayConfigs(closes, cs).forEach(function (cfg) {
      var enabled = S.indicators[cfg.key];
      var refKey = cfg.subKey || cfg.key;
      var exists = overlays[refKey];
      var u = enabled && typeof enabled === 'object' ? enabled : {};
      var color = u.color || cfg.color;
      var lineWidth = u.lineWidth || cfg.lineWidth || 2;
      var lineStyle = u.lineStyle != null ? Number(u.lineStyle) : (cfg.lineStyle === 'dashed' ? 1 : 0);
      if (enabled && !exists) {
        var opts = { color: color, lineWidth: lineWidth, lineStyle: lineStyle, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true, title: cfg.title };
        if (cfg.pointMarkers) { opts.pointMarkersVisible = true; opts.lineVisible = false; }
        overlays[refKey] = chart.addLineSeries(opts);
      } else if (!enabled && exists) {
        safe(function () { chart.removeSeries(exists); });
        delete overlays[refKey];
      }
      if (enabled && overlays[refKey] && cs.length) {
        safe(function () { overlays[refKey].applyOptions({ color: color, lineWidth: lineWidth, lineStyle: lineStyle }); });
        var values = cfg.compute();
        var data = [];
        for (var i = 0; i < cs.length; i++) {
          var v = values[i];
          if (v != null && Number.isFinite(v)) data.push({ time: cs[i].time, value: v });
        }
        safe(function () { overlays[refKey].setData(data); });
      }
    });
  };

  /* ── sub-panes (PriceChart.jsx:2514-2690, 3370-3412) ── */
  // The web's heights (120 / 140 / 110) scaled for a phone.
  var SUB_DEFS = [
    { key: 'rsi', title: 'RSI', height: 92 },
    { key: 'macd', title: 'MACD', height: 104 },
    { key: 'stoch', title: 'STOCHASTIC', height: 92 },
    { key: 'atr', title: 'ATR', height: 84 },
    { key: 'wr', title: 'WILLIAMS %R', height: 84 },
    { key: 'cci', title: 'CCI', height: 84 },
  ];

  var applySubTheme = function (sc) {
    var s = S.sub;
    safe(function () {
      sc.chart.applyOptions({
        layout: { background: { type: 'solid', color: s.background }, textColor: s.text },
        grid: { vertLines: { color: s.grid }, horzLines: { color: s.grid } },
        timeScale: { borderColor: s.border },
        rightPriceScale: { borderColor: s.border },
      });
    });
    sc.head.style.background = s.background;
    sc.head.style.color = s.text;
    sc.head.style.borderColor = s.border;
  };

  var subTitle = function (key) {
    var pget = function (f, d) { var v = S.indicators[key]; return v && typeof v === 'object' && v[f] != null ? v[f] : d; };
    if (key === 'rsi') return 'RSI <b>(' + pget('length', 14) + ')</b>';
    if (key === 'macd') return 'MACD <b>(12, 26, 9)</b>';
    if (key === 'stoch') return 'STOCHASTIC <b>(' + pget('length', 14) + ', 3)</b>';
    if (key === 'atr') return 'ATR <b>(' + pget('length', 14) + ')</b>';
    if (key === 'wr') return 'WILLIAMS %R <b>(' + pget('length', 14) + ')</b>';
    return 'CCI <b>(' + pget('length', 20) + ')</b>';
  };

  var makeSub = function (def) {
    var box = document.createElement('div');
    box.className = 'aat-sub';
    var head = document.createElement('div');
    head.className = 'aat-sub-head';
    var host = document.createElement('div');
    host.className = 'aat-sub-host';
    host.style.height = def.height + 'px';
    box.appendChild(head);
    box.appendChild(host);
    el.subs.appendChild(box);
    var s = S.sub;
    var sc = LWC.createChart(host, {
      autoSize: true,
      layout: { background: { type: 'solid', color: s.background }, textColor: s.text, fontSize: 10, attributionLogo: false },
      grid: { vertLines: { color: s.grid }, horzLines: { color: s.grid } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: s.border, visible: false },
      rightPriceScale: { borderColor: s.border, minimumWidth: AXIS_MIN_WIDTH },
      crosshair: { vertLine: { visible: false, labelVisible: false }, horzLine: { visible: false, labelVisible: true } },
      handleScale: { axisPressedMouseMove: { time: false, price: true } },
    });
    var entry = { key: def.key, box: box, head: head, host: host, chart: sc, s: {} };
    var add = function (name, opts) { entry.s[name] = sc.addLineSeries(Object.assign({ priceLineVisible: false, lastValueVisible: true }, opts)); };
    if (def.key === 'rsi') { add('main', { color: '#8b5cf6', lineWidth: 1.5, title: 'RSI' }); add('ob', { color: '#ef4444', lineWidth: 1, lineStyle: 2, lastValueVisible: false }); add('os', { color: '#10b981', lineWidth: 1, lineStyle: 2, lastValueVisible: false }); }
    else if (def.key === 'stoch') { add('k', { color: '#3B82F6', lineWidth: 1.5, title: '%K' }); add('d', { color: '#F97316', lineWidth: 1.5, title: '%D' }); add('ob', { color: '#ef4444', lineWidth: 1, lineStyle: 2, lastValueVisible: false }); add('os', { color: '#10b981', lineWidth: 1, lineStyle: 2, lastValueVisible: false }); }
    else if (def.key === 'atr') { add('main', { color: '#0EA5E9', lineWidth: 1.5, title: 'ATR' }); }
    else if (def.key === 'wr') { add('main', { color: '#DB2777', lineWidth: 1.5, title: 'W%R' }); add('ob', { color: '#ef4444', lineWidth: 1, lineStyle: 2, lastValueVisible: false }); add('os', { color: '#10b981', lineWidth: 1, lineStyle: 2, lastValueVisible: false }); }
    else if (def.key === 'cci') { add('main', { color: '#7C3AED', lineWidth: 1.5, title: 'CCI' }); add('ob', { color: '#ef4444', lineWidth: 1, lineStyle: 2, lastValueVisible: false }); add('os', { color: '#10b981', lineWidth: 1, lineStyle: 2, lastValueVisible: false }); }
    else if (def.key === 'macd') {
      entry.s.hist = sc.addHistogramSeries({ color: '#6b7280', title: 'Hist', priceLineVisible: false });
      add('macd', { color: '#2dd4bf', lineWidth: 1.5, title: 'MACD' });
      add('signal', { color: '#f59e0b', lineWidth: 1.5, title: 'Signal' });
    }
    sc.timeScale().subscribeVisibleLogicalRangeChange(function (range) { syncSubRanges(sc, range); });
    sc.subscribeCrosshairMove(function (param) { onCrosshair(param, sc); });
    applySubTheme(entry);
    return entry;
  };

  /** Whitespace-padded series ({ time } only in the warm-up) keep bar indices 1:1 with the main chart. */
  var padded = function (cs, values) {
    return cs.map(function (c, i) { var v = values[i]; return v != null && Number.isFinite(v) ? { time: c.time, value: v } : { time: c.time }; });
  };
  var band = function (data, level) { return data.map(function (p) { return { time: p.time, value: level }; }); };

  var fillSub = function (sc) {
    var cs = S.candles;
    var closes = cs.map(function (c) { return c.close; });
    var pget = function (f, d) { var v = S.indicators[sc.key]; return v && typeof v === 'object' && v[f] != null ? v[f] : d; };
    var styled = function (s, color, width) { safe(function () { s.applyOptions({ color: pget('color', color), lineWidth: pget('lineWidth', width) }); }); };
    safe(function () {
      if (sc.key === 'rsi') {
        styled(sc.s.main, '#8b5cf6', 1.5);
        var r = padded(cs, I.rsi(closes, pget('length', 14)));
        sc.s.main.setData(r); sc.s.ob.setData(band(r, 70)); sc.s.os.setData(band(r, 30));
      } else if (sc.key === 'stoch') {
        styled(sc.s.k, '#3B82F6', 1.5);
        var st = I.stochastic(cs, pget('length', 14), 3);
        var k = padded(cs, st.k);
        sc.s.k.setData(k); sc.s.d.setData(padded(cs, st.d)); sc.s.ob.setData(band(k, 80)); sc.s.os.setData(band(k, 20));
      } else if (sc.key === 'atr') {
        styled(sc.s.main, '#0EA5E9', 1.5);
        sc.s.main.setData(padded(cs, I.atr(cs, pget('length', 14))));
      } else if (sc.key === 'wr') {
        styled(sc.s.main, '#DB2777', 1.5);
        var w = padded(cs, I.williamsR(cs, pget('length', 14)));
        sc.s.main.setData(w); sc.s.ob.setData(band(w, -20)); sc.s.os.setData(band(w, -80));
      } else if (sc.key === 'cci') {
        styled(sc.s.main, '#7C3AED', 1.5);
        var cc = padded(cs, I.cci(cs, pget('length', 20)));
        sc.s.main.setData(cc); sc.s.ob.setData(band(cc, 100)); sc.s.os.setData(band(cc, -100));
      } else if (sc.key === 'macd') {
        var m = I.macd(closes, 12, 26, 9);
        sc.s.hist.setData(cs.map(function (c, i) { var v = m.histogram[i]; return v != null ? { time: c.time, value: v, color: v >= 0 ? '#10b981' : '#ef4444' } : { time: c.time }; }));
        sc.s.macd.setData(padded(cs, m.macd));
        sc.s.signal.setData(padded(cs, m.signal));
      }
    });
    sc.head.innerHTML = subTitle(sc.key);
  };

  var applySubs = function () {
    SUB_DEFS.forEach(function (def) {
      var on = !!S.indicators[def.key];
      var sc = subs[def.key];
      if (!on && sc) {
        safe(function () { sc.chart.remove(); });
        if (sc.box.parentNode) sc.box.parentNode.removeChild(sc.box);
        delete subs[def.key];
        return;
      }
      if (on && !sc) {
        sc = makeSub(def);
        subs[def.key] = sc;
        // Keep the web's order no matter which was switched on first.
        SUB_DEFS.forEach(function (d2) { if (subs[d2.key]) el.subs.appendChild(subs[d2.key].box); });
      }
      if (on && sc) fillSub(sc);
    });
    alignSubs();
  };

  var applyingSubRange = false;
  var allCharts = function () { return [chart].concat(Object.keys(subs).map(function (k) { return subs[k].chart; })); };
  var syncSubRanges = function (src, range) {
    if (applyingSubRange || !range) return;
    applyingSubRange = true;
    allCharts().forEach(function (dst) { if (dst && dst !== src) safe(function () { dst.timeScale().setVisibleLogicalRange(range); }); });
    applyingSubRange = false;
  };
  var alignSubs = function () {
    if (!chart) return;
    var r = safe(function () { return chart.timeScale().getVisibleLogicalRange(); });
    if (r) syncSubRanges(chart, r);
  };

  /* ── indicators recompute, coalesced to one per frame ── */
  var indicatorFrame = 0;
  var scheduleIndicators = function () {
    if (indicatorFrame) return;
    indicatorFrame = requestAnimationFrame(function () {
      indicatorFrame = 0;
      applyOverlays();
      Object.keys(subs).forEach(function (k) { fillSub(subs[k]); });
      applyMarkers();
      renderDiagnostics();
      renderLegend();
    });
  };

  /* ── markers: signals / HMR / calendar (PriceChart.jsx:1287-1387) ── */
  var buildMarkers = function () {
    var cs = S.candles;
    if (!cs.length) return [];
    var out = [];
    if (S.flags.signals) {
      var r = I.rsi(cs.map(function (c) { return Number(c.close); }), 14);
      var prevR = null;
      for (var i = 0; i < cs.length; i++) {
        var v = r[i];
        if (v == null) { prevR = v; continue; }
        if (prevR != null) {
          if (prevR <= 30 && v > 30) out.push({ time: cs[i].time, position: 'belowBar', color: '#10B981', shape: 'arrowUp', text: 'BUY' });
          if (prevR >= 70 && v < 70) out.push({ time: cs[i].time, position: 'aboveBar', color: '#EF4444', shape: 'arrowDown', text: 'SELL' });
        }
        prevR = v;
      }
    }
    if (S.flags.hmr) {
      var moves = cs.map(function (c) { return Math.abs(Number(c.close) - Number(c.open)) / Math.max(Number(c.open), 1e-9); });
      var rolling = 0;
      var N = 20;
      for (var j = 0; j < cs.length; j++) {
        rolling += moves[j];
        if (j >= N) rolling -= moves[j - N];
        if (j < N) continue;
        var mean = rolling / N;
        var m = moves[j];
        if (m > 0.015 && m > mean * 1.8) {
          var bull = Number(cs[j].close) > Number(cs[j].open);
          out.push({ time: cs[j].time, position: bull ? 'belowBar' : 'aboveBar', color: bull ? '#8B5CF6' : '#F59E0B', shape: 'circle', text: 'HMR' });
        }
      }
    }
    if (S.calEvents.length) {
      var firstT = Number(cs[0].time);
      var lastT = Number(cs[cs.length - 1].time);
      S.calEvents.forEach(function (ev) {
        var tSec = Math.floor(Number(ev.ts) / 1000);
        if (!Number.isFinite(tSec) || tSec < firstT || tSec > lastT) return;
        var nearest = cs[0].time;
        var best = Math.abs(Number(cs[0].time) - tSec);
        for (var k = 0; k < cs.length; k++) {
          var d = Math.abs(Number(cs[k].time) - tSec);
          if (d < best) { best = d; nearest = cs[k].time; }
        }
        var tint = ev.impact === 'high' ? '#DC2626' : ev.impact === 'medium' ? '#3B82F6' : '#9CA3AF';
        out.push({ time: nearest, position: 'aboveBar', color: tint, shape: 'square', text: ev.code || 'EVT' });
      });
    }
    return out;
  };

  var applyMarkers = function () {
    if (!series || S.chartType === 'histogram') return;
    var list = buildMarkers();
    // A Line-with-Markers chart keeps its per-candle dots alongside.
    if (S.chartType === 'lineMarkers') list = list.concat(lineMarkerDots());
    list = list.filter(function (m) { return m && Number.isFinite(Number(m.time)); }).sort(function (a, b) { return Number(a.time) - Number(b.time); });
    safe(function () { series.setMarkers(list); });
  };

  /* ── price lines (PriceChart.jsx:2731-2917) ── */
  var applyLines = function () {
    if (!series) return;
    if (S.chartType === 'histogram') {
      priceLines.forEach(function (pl) { safe(function () { series.removePriceLine(pl); }); });
      priceLines.clear();
      S.extras = [];
      return;
    }
    var desired = new Map();
    S.lines.forEach(function (l) { desired.set(l.key, l); });
    priceLines.forEach(function (pl, key) {
      if (!desired.has(key)) { safe(function () { series.removePriceLine(pl); }); priceLines.delete(key); }
    });
    desired.forEach(function (l, key) {
      var opts = { price: Number(l.price), color: l.color, lineWidth: l.lineWidth || 1, lineStyle: l.lineStyle || 0, axisLabelVisible: !!l.axisLabelVisible, title: l.title || '' };
      // A line being dragged, or just dropped and not yet confirmed by the
      // server, stays where the finger left it instead of snapping back.
      var drag = pillDrag && pillDrag.key === key ? pillDrag : null;
      var hold = pillHold.get(key);
      if (drag && drag.price != null) opts.price = drag.price;
      else if (hold && hold.until > Date.now() && hold.from === Number(l.price)) opts.price = hold.price;
      var existing = priceLines.get(key);
      if (existing) safe(function () { existing.applyOptions(opts); });
      else safe(function () { priceLines.set(key, series.createPriceLine(opts)); });
    });
    S.extras = S.lines.map(function (l) { return Number(l.price); });
    refitY();
  };

  /* ── pills (PriceChart.jsx:2928-3368, 4430-4696) ── */
  var pillEls = new Map();
  var pillDrag = null;
  var pillHold = new Map();

  var escapeHtml = function (s) { return String(s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); };

  /*
   * Every entry pill — filled position, pending order or draft — is coloured
   * BY SIDE (Buy / Sell colours), matching the trade direction and its line.
   */
  var pillColor = function (p) {
    if (p.kind === 'sl') return S.pillColors.sl;
    if (p.kind === 'tp') return S.pillColors.tp;
    return p.side === 'SELL' ? S.pillColors.sell : S.pillColors.buy;
  };

  var pillUsd = function (p, price) {
    if (p.kind === 'entry') return Number(p.pnl) || 0;
    var qty = Number(p.qty) || 0;
    var entry = Number(p.entry) || 0;
    return (p.side === 'BUY' ? price - entry : entry - price) * qty;
  };

  var pillLabel = function (p) {
    if (p.kind === 'sl') return 'SL';
    if (p.kind === 'tp') return 'TP';
    if (p.target === 'order') return p.preview ? 'PREVIEW' : (p.orderType === 'STOP' ? 'STOP' : 'LIMIT');
    return null;
  };

  var pillDraggable = function (p) {
    return p.kind === 'sl' || p.kind === 'tp' || (p.kind === 'entry' && p.target === 'order' && !(p.preview && p.orderType === 'MARKET'));
  };

  var renderPillBody = function (node, p, price, dragging) {
    var color = pillColor(p);
    var usd = pillUsd(p, price);
    var label = pillLabel(p);
    var prec = Math.min(8, Math.max(0, Number(S.precision) || 2));
    var qty = (Number(p.qty) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    var html = '';
    if (p.quickTp) html += '<span class="aat-quick" data-quick="tp" style="background:#10b981">+ TP</span>';
    if (p.quickSl) html += '<span class="aat-quick" data-quick="sl" style="background:#ef4444">+ SL</span>';
    html += '<span class="aat-pill-main" style="border-color:' + color + ';color:' + color + '">';
    if (label) html += '<span class="aat-pill-label" style="background:' + color + '">' + label + '</span><span class="aat-pill-cell" style="border-color:' + color + '">' + price.toFixed(prec) + '</span>';
    else html += '<span class="aat-pill-cell aat-first" style="background:' + color + ';color:#FFFFFF">' + qty + '</span>';
    // The P&L in rupees, sign first ("+₹12.30" / "-₹4.10").
    html += '<span class="aat-pill-cell" style="border-color:' + color + ';color:' + (usd >= 0 ? '#16A34A' : '#DC2626') + '">' + (usd >= 0 ? '+' : '-') + '₹' + Math.abs(usd).toFixed(2) + '</span>';
    html += '<span class="aat-pill-x" data-close="1" style="border-color:' + color + '">✕</span></span>';
    node.innerHTML = html;
    node.classList.toggle('aat-dragging', !!dragging);
    node.classList.toggle('aat-preview', !!p.preview);
  };

  var ensurePillEl = function (p) {
    var node = pillEls.get(p.key);
    if (!node) {
      node = document.createElement('div');
      node.className = 'aat-pill';
      node.addEventListener('pointerdown', function (e) { onPillDown(p.key, e); });
      el.pills.appendChild(node);
      pillEls.set(p.key, node);
    }
    return node;
  };

  var pillPrice = function (p) {
    if (pillDrag && pillDrag.key === p.key && pillDrag.price != null) return pillDrag.price;
    var hold = pillHold.get(p.key);
    if (hold) {
      if (hold.until > Date.now() && hold.from === Number(p.price)) return hold.price;
      pillHold.delete(p.key);
    }
    return Number(p.price);
  };

  var renderPills = function () {
    var keep = new Set();
    if (series && S.chartType !== 'histogram') {
      S.pills.forEach(function (p) {
        keep.add(p.key);
        var node = ensurePillEl(p);
        renderPillBody(node, p, pillPrice(p), pillDrag && pillDrag.key === p.key);
      });
    }
    pillEls.forEach(function (node, key) {
      if (!keep.has(key) && !(pillDrag && pillDrag.key === key && pillDrag.ephemeral)) {
        if (node.parentNode) node.parentNode.removeChild(node);
        pillEls.delete(key);
      }
    });
    positionPills();
  };

  var positionPills = function () {
    if (!series) return;
    var h = el.main.clientHeight;
    pillEls.forEach(function (node, key) {
      var p = S.pills.find(function (x) { return x.key === key; });
      var price;
      if (pillDrag && pillDrag.key === key) price = pillDrag.price;
      else if (p) price = pillPrice(p);
      var y = price == null ? null : safe(function () { return series.priceToCoordinate(price); });
      if (y == null || !Number.isFinite(y) || y < -20 || y > h + 20) { node.style.display = 'none'; return; }
      node.style.display = '';
      var top = Math.round(y - 11);
      if (node._top !== top) { node._top = top; node.style.transform = 'translate(-50%, ' + top + 'px)'; }
    });
    if (pillDrag && pillDrag.y != null) {
      el.dragGlow.style.display = 'block';
      el.dragGlow.style.transform = 'translateY(' + Math.round(pillDrag.y - 1) + 'px)';
      el.dragGlow.style.background = pillDrag.color;
      el.dragChip.style.display = 'block';
      el.dragChip.style.transform = 'translateY(' + Math.round(pillDrag.y - 10) + 'px)';
      el.dragChip.style.background = pillDrag.color;
      el.dragChip.textContent = pillDrag.price.toFixed(Math.min(8, Math.max(0, Number(S.precision) || 2)));
    } else {
      el.dragGlow.style.display = 'none';
      el.dragChip.style.display = 'none';
    }
  };

  var CLICK_THRESHOLD = 6;
  var LIVE_THROTTLE = 250;

  var startPillDrag = function (p, e, immediate) {
    if (!series || !chart) return;
    e.preventDefault();
    e.stopPropagation();
    var rect = el.main.getBoundingClientRect();
    var startX = e.clientX; var startY = e.clientY;
    var didDrag = !!immediate;
    var isOrderEntry = p.kind === 'entry' && p.target === 'order';
    var draggable = p.kind === 'sl' || p.kind === 'tp' || (isOrderEntry && pillDraggable(p));
    var color = pillColor(p);
    var step = Math.pow(10, -Math.min(8, Math.max(0, Number(S.precision) || 2)));
    var snap = function (v) { return Math.round(v / step) * step; };

    // Anti-immediate-fill clamp for a real resting order (PriceChart.jsx:3133).
    var clamp = function (v) {
      if (!isOrderEntry || p.preview) return v;
      var last = Number(S.quote.last);
      var ask = Number(S.quote.ask) > 0 ? Number(S.quote.ask) : last;
      var bid = Number(S.quote.bid) > 0 ? Number(S.quote.bid) : last;
      if (!Number.isFinite(ask) || !Number.isFinite(bid) || ask <= 0 || bid <= 0) return v;
      var cushion = step * 3;
      if (p.orderType === 'LIMIT') {
        if (p.side === 'BUY') return Math.min(v, ask - cushion);
        if (p.side === 'SELL') return Math.max(v, bid + cushion);
      } else if (p.orderType === 'STOP') {
        if (p.side === 'BUY') return Math.max(v, ask + cushion);
        if (p.side === 'SELL') return Math.min(v, bid - cushion);
      }
      return v;
    };

    // An SL / TP on an OPEN position must not sit on the side of market that
    // fires it, or the position closes on the worker's next scan — and a drag
    // pushes live updates (PriceChart.jsx clampLevelPrice):
    //   BUY  → SL below price, TP above price
    //   SELL → SL above price, TP below price
    var clampLevel = function (v) {
      if (isOrderEntry || p.target === 'order' || p.preview) return v;
      var last = Number(S.quote.last);
      if (!Number.isFinite(last) || last <= 0) return v;
      var isBuy = p.side === 'BUY';
      var cushion = step * 3;
      if (p.kind === 'sl') return isBuy ? Math.min(v, last - cushion) : Math.max(v, last + cushion);
      if (p.kind === 'tp') return isBuy ? Math.max(v, last + cushion) : Math.min(v, last - cushion);
      return v;
    };

    // Magnetic snap to a recent high / low within ~0.15% of the visible range.
    var cs = S.candles;
    var visHi = Number(series.coordinateToPrice(0)) || 0;
    var visLo = Number(series.coordinateToPrice(rect.height)) || 0;
    var tol = Math.abs(visHi - visLo) * 0.0015;
    var magnet = function (v) {
      if (!cs.length || !(tol > 0)) return v;
      var best = null; var bestDist = Infinity;
      for (var i = Math.max(0, cs.length - 60); i < cs.length; i++) {
        var hh = Number(cs[i].high); var ll = Number(cs[i].low);
        if (Number.isFinite(hh) && Math.abs(v - hh) < bestDist) { bestDist = Math.abs(v - hh); best = hh; }
        if (Number.isFinite(ll) && Math.abs(v - ll) < bestDist) { bestDist = Math.abs(v - ll); best = ll; }
      }
      return best != null && bestDist <= tol ? best : v;
    };

    // Order targets commit on drop only: several in-flight re-prices of a
    // resting order can race the matching engine (PriceChart.jsx:3220).
    var allowLive = p.target !== 'order';
    var lastLive = 0; var liveTimer = 0; var livePrice = null;
    var pushLive = function (price) {
      if (!allowLive) return;
      livePrice = price;
      var now = Date.now();
      var fire = function () { lastLive = Date.now(); liveTimer = 0; post('pillCommit', { key: p.key, price: livePrice, live: true }); };
      if (now - lastLive >= LIVE_THROTTLE) fire();
      else if (!liveTimer) liveTimer = setTimeout(fire, LIVE_THROTTLE - (now - lastLive));
    };

    safe(function () { chart.applyOptions({ handleScroll: false, handleScale: false }); });
    var startPrice = Number(p.price);
    var begin = function () {
      pillDrag = { key: p.key, price: startPrice, y: series.priceToCoordinate(startPrice), color: color, ephemeral: !!p.ephemeral };
      var node = pillEls.get(p.key);
      if (node) renderPillBody(node, p, startPrice, true);
    };
    if (immediate && draggable) begin();

    // Listen on the window, not the touched element: a price refresh can
    // re-render the pill (and the +TP / +SL chip inside it) mid-drag, and a
    // detached node never hears the pointerup — the chart would stay frozen.
    var pointerId = e.pointerId;

    var onMove = function (ev) {
      if (ev.pointerId !== pointerId) return;
      var dx = ev.clientX - startX; var dy = ev.clientY - startY;
      if (!didDrag && (Math.abs(dx) > CLICK_THRESHOLD || Math.abs(dy) > CLICK_THRESHOLD)) {
        didDrag = true;
        if (draggable) begin();
      }
      if (!didDrag || !draggable || !pillDrag) return;
      var y = Math.max(0, Math.min(rect.height, ev.clientY - rect.top));
      var raw = series.coordinateToPrice(y);
      if (!Number.isFinite(raw)) return;
      var clamped = clampLevel(clamp(raw));
      var price = snap(magnet(clamped));
      var dispY = safe(function () { return series.priceToCoordinate(price); });
      pillDrag.price = price;
      pillDrag.y = Number.isFinite(dispY) ? dispY : y;
      var node = pillEls.get(p.key);
      if (node) renderPillBody(node, p, price, true);
      var line = priceLines.get(p.key);
      if (line) safe(function () { line.applyOptions({ price: price }); });
      positionPills();
      pushLive(price);
    };

    var onUp = function (ev) {
      if (ev && ev.pointerId !== pointerId) return;
      root.removeEventListener('pointermove', onMove, true);
      root.removeEventListener('pointerup', onUp, true);
      root.removeEventListener('pointercancel', onUp, true);
      safe(function () { chart.applyOptions({ handleScroll: true, handleScale: true }); });
      if (liveTimer) { clearTimeout(liveTimer); liveTimer = 0; }
      if (didDrag && draggable && pillDrag) {
        var finalPrice = snap(clampLevel(clamp(pillDrag.price)));
        pillHold.set(p.key, { price: finalPrice, from: Number(p.price), until: Date.now() + 5000 });
        pillDrag = null;
        post('pillCommit', { key: p.key, price: finalPrice });
      } else {
        pillDrag = null;
        if (!didDrag) post('pillTap', { key: p.key });
      }
      if (p.ephemeral) {
        S.pills = S.pills.filter(function (x) { return x.key !== p.key; });
        var node = pillEls.get(p.key);
        if (node && node.parentNode) node.parentNode.removeChild(node);
        pillEls.delete(p.key);
      }
      renderPills();
    };

    root.addEventListener('pointermove', onMove, true);
    root.addEventListener('pointerup', onUp, true);
    root.addEventListener('pointercancel', onUp, true);
  };

  var onPillDown = function (key, e) {
    var p = S.pills.find(function (x) { return x.key === key; });
    if (!p) return;
    var t = e.target;
    if (t && t.getAttribute && t.getAttribute('data-close')) {
      e.preventDefault(); e.stopPropagation();
      post('pillClose', { key: key });
      return;
    }
    var quick = t && t.getAttribute ? t.getAttribute('data-quick') : null;
    if (quick) {
      // +TP / +SL: a synthetic pill at the entry, dragged from the first move.
      var prefix = p.target === 'order' ? 'order' : 'pos';
      var synthetic = Object.assign({}, p, { key: prefix + ':' + p.id + ':' + quick + ':new', kind: quick, price: Number(p.entry), quickTp: false, quickSl: false, ephemeral: true });
      S.pills = S.pills.filter(function (x) { return x.key !== synthetic.key; }).concat([synthetic]);
      renderPillBody(ensurePillEl(synthetic), synthetic, Number(p.entry), true);
      startPillDrag(synthetic, e, true);
      return;
    }
    startPillDrag(p, e, false);
  };

  /* ── status line + indicator legend (PriceChart.jsx:3984-4054) ── */
  var renderLegend = function () {
    if (!el.status) return;
    var bar = S.hover || S.candles[S.candles.length - 1];
    var pal = canvasPalette(S.mode);
    el.legend.style.left = (8 + S.legendInset) + 'px';
    if (!bar) { el.status.innerHTML = '<span class="aat-sym" data-sym="1">' + escapeHtml(S.name || S.symbol) + ' ▾</span>'; }
    else {
      var o = bar.open; var h = bar.high; var l = bar.low; var c = bar.close != null ? bar.close : bar.value;
      var hasOHLC = o != null && h != null && l != null;
      var chg = (o != null && c != null) ? c - o : null;
      var pct = (chg != null && o) ? (chg / o) * 100 : null;
      var up = chg == null ? true : chg >= 0;
      var dir = up ? '#16A34A' : '#DC2626';
      var wide = el.main.clientWidth >= 640;
      var name = S.hideHeader ? S.symbol : (S.name || S.symbol);
      var sym = '<span class="aat-sym" data-sym="1">' + escapeHtml(name) + ' <i>▾</i></span>';
      var tf = '<span class="aat-muted">· ' + escapeHtml(S.timeframe) + ' ·</span>';
      var ohlc = hasOHLC && wide
        ? '<span class="aat-mono"><span class="aat-muted">O</span><span style="color:' + dir + '">' + fmtPrice(o) + '</span> <span class="aat-muted">H</span><span style="color:' + dir + '">' + fmtPrice(h) + '</span> <span class="aat-muted">L</span><span style="color:' + dir + '">' + fmtPrice(l) + '</span> <span class="aat-muted">C</span><span style="color:' + dir + '">' + fmtPrice(c) + '</span></span>'
        : '<span class="aat-mono" style="color:' + dir + '">' + fmtPrice(c) + '</span>';
      var change = chg == null ? '' : '<span class="aat-mono aat-bold" style="color:' + dir + '">' + (chg >= 0 ? '+' : '') + fmtPrice(chg) + (pct != null ? ' (' + (chg >= 0 ? '+' : '') + pct.toFixed(2) + '%)' : '') + '</span>';
      el.status.innerHTML = S.hideHeader
        ? '<div class="aat-row">' + sym + '</div><div class="aat-row">' + tf + ohlc + change + '</div>'
        : '<div class="aat-row">' + sym + tf + ohlc + change + '</div>';
    }
    el.status.style.color = pal.ink;
    var rows = S.legend.map(function (r) {
      return '<div class="aat-leg-row" style="background:' + pal.panel + ';color:' + pal.ink + '"><span class="aat-dot" style="background:' + r.color + '"></span><span class="aat-leg-label" data-leg-edit="' + escapeHtml(r.key) + '">' + escapeHtml(r.label) + '</span><span class="aat-leg-btn" data-leg-edit="' + escapeHtml(r.key) + '" style="color:' + pal.muted + '">⚙</span><span class="aat-leg-btn" data-leg-remove="' + escapeHtml(r.key) + '" style="color:#ef4444">✕</span></div>';
    });
    el.legendRows.innerHTML = rows.join('');
  };

  var onCrosshair = function (param, src) {
    var mainSeries = series;
    if (src === chart) {
      if (!param || !param.point || !mainSeries) S.hover = null;
      else {
        var d = param.seriesData && param.seriesData.get(mainSeries);
        S.hover = d && (d.open != null || d.value != null) ? d : null;
      }
      renderLegend();
    }
    // One crosshair across the main pane and every sub-pane (PriceChart.jsx:1030).
    if (!param || !param.point) { el.vline.style.opacity = '0'; el.hline.style.opacity = '0'; return; }
    el.vline.style.opacity = '1';
    el.vline.style.transform = 'translateX(' + param.point.x + 'px)';
    if (src === chart) {
      el.hline.style.opacity = '1';
      el.hline.style.transform = 'translateY(' + param.point.y + 'px)';
    } else {
      el.hline.style.opacity = '0';
    }
  };

  /* ── countdown, diagnostics, next event, measure, logo ── */
  var countdownTimer = 0;
  var renderCountdown = function () {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = 0; }
    if (!S.prefs.countdown) { el.countdown.style.display = 'none'; return; }
    var tick = function () {
      var tf = C.tfToSeconds(S.timeframe) || 60;
      var now = Date.now() / 1000;
      var left = Math.max(0, Math.round(Math.ceil(now / tf) * tf - now));
      var h = Math.floor(left / 3600); var m = Math.floor((left % 3600) / 60); var s = left % 60;
      var pad = function (n) { return String(n).padStart(2, '0'); };
      el.countdown.textContent = '⏱ ' + (h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s));
    };
    el.countdown.style.display = 'block';
    tick();
    countdownTimer = setInterval(tick, 1000);
  };

  var renderDiagnostics = function () {
    if (!S.prefs.diagnostics) { el.diag.style.display = 'none'; return; }
    var d = C.analyzeCandles(S.candles, C.tfToSeconds(S.timeframe));
    var row = function (label, val, bad) { return '<div class="aat-kv"><span class="aat-muted">' + label + '</span><span style="color:' + (bad ? '#DC2626' : '#16A34A') + ';font-weight:700">' + val + '</span></div>'; };
    var lat = d.lastAgeSec == null ? '—' : d.lastAgeSec < 2 ? 'live' : d.lastAgeSec + 's';
    el.diag.innerHTML = '<div class="aat-diag-title">Candle Diagnostics · ' + escapeHtml(S.symbol) + '</div>'
      + row('Total candles', d.total, false) + row('Invalid OHLC', d.invalid, d.invalid > 0)
      + row('Duplicates', d.duplicates, d.duplicates > 0) + row('Out of order', d.outOfOrder, d.outOfOrder > 0)
      + row('Future candles', d.future, d.future > 0) + row('Missing (gaps)', d.gaps, d.gaps > 0)
      + '<div class="aat-kv"><span class="aat-muted">Feed latency</span><span style="font-weight:700;color:' + (d.lastAgeSec == null ? '#94A3B8' : d.lastAgeSec > 120 ? '#DC2626' : '#16A34A') + '">' + lat + '</span></div>';
    el.diag.style.display = 'block';
  };

  var eventTimer = 0;
  var renderNextEvent = function () {
    if (eventTimer) { clearInterval(eventTimer); eventTimer = 0; }
    var ev = S.nextEvent;
    if (!ev) { el.event.style.display = 'none'; return; }
    var draw = function () {
      var mins = Math.max(0, Math.floor((Number(ev.ts) - Date.now()) / 60000));
      var cd = mins < 60 ? mins + 'm' : mins < 1440 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : Math.floor(mins / 1440) + 'd ' + Math.floor((mins % 1440) / 60) + 'h';
      var col = ev.impact === 'high' ? '#DC2626' : ev.impact === 'medium' ? '#3B82F6' : '#9CA3AF';
      el.event.innerHTML = '<span class="aat-dot" style="background:' + col + '"></span><span class="aat-muted">Next:</span><b style="color:' + col + '">' + escapeHtml(ev.currency || '') + '</b><span class="aat-ev-name">' + escapeHtml(ev.event || '') + '</span><span class="aat-muted">· in ' + cd + '</span>';
    };
    el.event.style.display = 'flex';
    draw();
    eventTimer = setInterval(draw, 30000);
  };

  var renderMeasure = function () {
    var m = S.measure;
    if (!m) { el.measure.style.display = 'none'; return; }
    var dir = m.dPrice >= 0 ? '#16A34A' : '#DC2626';
    el.measure.innerHTML = '<span class="aat-muted">Δ Price</span><b style="color:' + dir + '">' + (m.dPrice >= 0 ? '+' : '') + m.dPrice.toFixed(2) + '</b><b style="color:' + dir + '">(' + (m.dPct >= 0 ? '+' : '') + m.dPct.toFixed(2) + '%)</b><span class="aat-x" data-measure-close="1">✕</span>';
    el.measure.style.display = 'flex';
  };

  var renderLogo = function () {
    if (!S.logoUrl) { el.logo.style.display = 'none'; return; }
    el.logo.src = S.logoUrl;
    el.logo.style.display = 'block';
  };

  /* ── gestures on the chart area: long-press menu, axis locks, double-tap reset ── */
  var gesture = null;
  var lastTap = { t: 0, x: 0, y: 0 };
  var bindGestures = function () {
    var node = el.main;
    node.addEventListener('pointerdown', function (e) {
      var t0 = e.target;
      if (t0 && t0.closest && (t0.closest('.aat-pill') || t0.closest('.aat-leg-row') || t0.closest('.aat-sym') || t0.closest('#aat-measure'))) return;
      // While the drawing canvas holds the touch, the engine owns long-press.
      if (t0 && t0.classList && t0.classList.contains('aat-draw-canvas')) return;
      var r = node.getBoundingClientRect();
      var x = e.clientX - r.left; var y = e.clientY - r.top;
      var axisW = safe(function () { return chart.priceScale('right').width(); }) || AXIS_MIN_WIDTH;
      var timeH = safe(function () { return chart.timeScale().height(); }) || 28;
      var inPriceAxis = x >= r.width - axisW;
      var inTimeAxis = y >= r.height - timeH;
      var now = Date.now();
      var dbl = now - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 20;
      lastTap = { t: now, x: x, y: y };
      if (dbl && inPriceAxis) {
        // Double-tap the price axis → back to automatic scaling (PriceChart.jsx:1843).
        S.manualPrice = false;
        refitY();
        post('scaleLocks', { manualPrice: S.manualPrice, manualTime: S.manualTime });
        return;
      }
      gesture = {
        x: x, y: y, moved: false, inPriceAxis: inPriceAxis, inTimeAxis: inTimeAxis,
        timer: setTimeout(function () {
          if (!gesture || gesture.moved) return;
          var hit = drawings ? drawings.hitTestAt(gesture.x, gesture.y) : null;
          if (hit) drawings.command('select', { id: hit });
          post('longPress', { drawingId: hit, manualPrice: S.manualPrice, manualTime: S.manualTime });
          gesture = null;
        }, 550),
      };
    }, true);
    node.addEventListener('pointermove', function (e) {
      if (!gesture) return;
      var r = node.getBoundingClientRect();
      var x = e.clientX - r.left; var y = e.clientY - r.top;
      if (Math.hypot(x - gesture.x, y - gesture.y) > 3) {
        gesture.moved = true;
        clearTimeout(gesture.timer);
        // A drag that starts in an axis gutter stretches that axis by hand.
        if (gesture.inPriceAxis && Math.abs(y - gesture.y) > 3 && !S.manualPrice) { S.manualPrice = true; post('scaleLocks', { manualPrice: true, manualTime: S.manualTime }); }
        if (gesture.inTimeAxis && Math.abs(x - gesture.x) > 3 && !S.manualTime) { S.manualTime = true; post('scaleLocks', { manualPrice: S.manualPrice, manualTime: true }); }
      }
    }, true);
    var end = function () { if (gesture) { clearTimeout(gesture.timer); gesture = null; } };
    node.addEventListener('pointerup', end, true);
    node.addEventListener('pointercancel', end, true);

    // Taps on HTML overlays.
    node.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('[data-sym]')) { post('symbolTap', {}); return; }
      var edit = t.closest('[data-leg-edit]');
      if (edit) { post('legendTap', { key: edit.getAttribute('data-leg-edit'), action: 'edit' }); return; }
      var rm = t.closest('[data-leg-remove]');
      if (rm) { post('legendTap', { key: rm.getAttribute('data-leg-remove'), action: 'remove' }); return; }
      if (t.closest('[data-measure-close]')) { S.measure = null; renderMeasure(); }
    });
  };

  /* ── scale actions (PriceChart.jsx:1912-1944) ── */
  var scale = function (cmd) {
    if (!chart || !series) return;
    safe(function () {
      if (cmd === 'refresh') series.priceScale().applyOptions({ autoScale: true });
      else if (cmd === 'autoFit') { S.manualPrice = false; S.manualTime = false; chart.timeScale().fitContent(); series.priceScale().applyOptions({ autoScale: true }); }
      else if (cmd === 'resetY') { S.manualPrice = false; series.priceScale().applyOptions({ autoScale: true }); }
      else if (cmd === 'resetX') { S.manualTime = false; chart.timeScale().fitContent(); }
      else if (cmd === 'resetAll') { S.manualPrice = false; S.manualTime = false; chart.timeScale().fitContent(); series.priceScale().applyOptions({ autoScale: true }); chart.timeScale().scrollToRealTime(); }
    });
    post('scaleLocks', { manualPrice: S.manualPrice, manualTime: S.manualTime });
  };

  /* ── multi-chart sync (Trade.jsx:231-282), relayed through the app ── */
  var applyingCrosshair = false;
  var applyingRange = false;
  var chFrame = 0; var chPending = null;
  var postCrosshair = function (param) {
    var t = param && param.time;
    var d = (series && t != null && param.seriesData) ? param.seriesData.get(series) : null;
    chPending = t == null ? { time: null, price: null } : { time: t, price: d ? (d.close != null ? d.close : d.value) : null };
    if (chFrame) return;
    chFrame = requestAnimationFrame(function () { chFrame = 0; post('crosshair', chPending); });
  };
  var rgFrame = 0; var rgPending = null;
  var postRange = function (range) {
    rgPending = { from: range.from, to: range.to };
    if (rgFrame) return;
    rgFrame = requestAnimationFrame(function () { rgFrame = 0; post('range', rgPending); });
  };

  /* ── fitting a fresh dataset (PriceChart.jsx:2208-2239) ── */
  var fitView = function () {
    if (!chart) return;
    var n = S.candles.length;
    safe(function () {
      var visible = 90;
      if (n > visible) chart.timeScale().setVisibleLogicalRange({ from: n - visible, to: n - 1 });
      else chart.timeScale().fitContent();
      var ps = series && series.priceScale();
      if (ps) { ps.applyOptions({ autoScale: false }); ps.applyOptions({ autoScale: true }); }
    });
  };

  /* ── messages ── */
  var handlers = {
    init: function (m) {
      S.mode = m.mode || S.mode;
      if (m.sub) S.sub = m.sub;
      S.prefs = m.prefs || S.prefs;
      S.chartType = m.chartType || S.chartType;
      S.indicators = m.indicators || {};
      S.legend = m.legend || [];
      S.precision = m.precision == null ? S.precision : m.precision;
      S.symbol = m.symbol || '';
      S.name = m.name || m.symbol || '';
      S.timeframe = m.timeframe || S.timeframe;
      S.tfSec = C.tfToSeconds(S.timeframe);
      S.timeZone = m.timeZone || S.timeZone;
      S.hideHeader = !!m.hideHeader;
      S.legendInset = Number(m.legendInset) || 0;
      if (m.pillColors) S.pillColors = m.pillColors;
      if (m.sync) S.sync = m.sync;
      S.logoUrl = m.logoUrl || '';
      applyTheme();
      if (!chart) createMain();
      rebuildSeries();
      applySubs();
      renderLegend();
      renderLogo();
    },
    theme: function (m) { S.mode = m.mode || S.mode; if (m.sub) S.sub = m.sub; applyTheme(); },
    prefs: function (m) {
      S.prefs = m.prefs || S.prefs;
      if (m.pillColors) S.pillColors = m.pillColors;
      applyPrefs();
      renderPills();
    },
    chartType: function (m) { if (m.chartType && m.chartType !== S.chartType) { S.chartType = m.chartType; rebuildSeries(); renderPills(); } },
    indicators: function (m) {
      S.indicators = m.indicators || {};
      S.legend = m.legend || [];
      applyVolume();
      applyOverlays();
      applySubs();
      renderLegend();
    },
    meta: function (m) {
      if (m.precision != null && m.precision !== S.precision) { S.precision = m.precision; applyPrecision(); }
      if (m.name != null) S.name = m.name;
      if (m.timeZone && m.timeZone !== S.timeZone) { S.timeZone = m.timeZone; applyPrefs(); }
      if (m.hideHeader != null) S.hideHeader = !!m.hideHeader;
      if (m.legendInset != null) S.legendInset = Number(m.legendInset) || 0;
      if (m.logoUrl != null) { S.logoUrl = m.logoUrl; renderLogo(); }
      if (m.sync) S.sync = m.sync;
      renderLegend();
    },
    candles: function (m) {
      var key = m.symbol + ':' + m.timeframe;
      var switched = key !== S.dataKey;
      S.dataKey = key;
      S.symbol = m.symbol;
      if (m.name) S.name = m.name;
      S.timeframe = m.timeframe;
      S.tfSec = C.tfToSeconds(S.timeframe);
      if (switched) { S.hover = null; S.measure = null; renderMeasure(); pillHold.clear(); }
      S.candles = C.fillCandleGaps(m.candles || [], S.tfSec);
      if (!series) return;
      setSeriesData();
      applyOverlays();
      Object.keys(subs).forEach(function (k) { fillSub(subs[k]); });
      applyMarkers();
      if (m.fit) {
        fitView();
        safe(function () { chart.timeScale().scrollToRealTime(); });
        requestAnimationFrame(fitView);
      }
      alignSubs();
      renderLegend();
      renderDiagnostics();
      renderPills();
    },
    candle: function (m) {
      if (!series || !m.candle) return;
      if (m.symbol && m.timeframe && (m.symbol + ':' + m.timeframe) !== S.dataKey) return;
      var r = C.mergeLiveCandle(S.candles, m.candle, S.tfSec);
      if (!r) return;
      S.candles = r.candles;
      if (r.bulk) setSeriesData();
      else updateSeriesPoint(r.point);
      scheduleIndicators();
      // Horizontal follow is the library's (shiftVisibleRangeOnNewBar): the
      // trader's pan position always wins. Only the price axis re-fits here.
      safe(function () { refitY(); });
      if (!S.hover) renderLegend();
    },
    lines: function (m) { S.lines = m.lines || []; applyLines(); },
    pills: function (m) {
      S.pills = m.pills || [];
      if (m.colors) S.pillColors = m.colors;
      renderPills();
    },
    quote: function (m) {
      var prevLast = Number(S.quote.last);
      S.quote = { bid: m.bid, ask: m.ask, last: m.last };
      var px = Number(m.last);
      if (Number.isFinite(px) && px > 0 && px !== prevLast) applyLivePrice(px);
    },
    overlays: function (m) {
      S.flags = { signals: !!m.signals, hmr: !!m.hmr };
      S.calEvents = Array.isArray(m.calendar) ? m.calendar : [];
      S.nextEvent = m.nextEvent || null;
      applyMarkers();
      renderNextEvent();
    },
    drawings: function (m) { if (drawings) drawings.load(m.drawings || []); },
    draw: function (m) { if (drawings) drawings.command(m.cmd, m.arg || {}); },
    scale: function (m) { scale(m.cmd); },
    crosshair: function (m) {
      if (!chart || !series) return;
      applyingCrosshair = true;
      safe(function () {
        if (m.time == null || m.price == null) chart.clearCrosshairPosition();
        else chart.setCrosshairPosition(m.price, m.time, series);
      });
      applyingCrosshair = false;
    },
    range: function (m) {
      if (!chart) return;
      applyingRange = true;
      safe(function () { chart.timeScale().setVisibleLogicalRange({ from: m.from, to: m.to }); });
      applyingRange = false;
    },
  };

  root.__aatReceive = function (json) {
    var m;
    try { m = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return; }
    if (!m || !m.type) return;
    var h = handlers[m.type];
    if (!h) return;
    try { h(m); } catch (e) { post('error', { message: String(e && e.message ? e.message : e), where: m.type }); }
  };

  /* ── boot ── */
  var boot = function () {
    el.main = $('aat-main');
    el.chart = $('aat-chart');
    el.subs = $('aat-subs');
    el.legend = $('aat-legend');
    el.status = $('aat-status');
    el.legendRows = $('aat-legend-rows');
    el.pills = $('aat-pills');
    el.dragGlow = $('aat-drag-glow');
    el.dragChip = $('aat-drag-chip');
    el.countdown = $('aat-countdown');
    el.diag = $('aat-diag');
    el.event = $('aat-event');
    el.measure = $('aat-measure');
    el.logo = $('aat-logo');
    el.vline = $('aat-vline');
    el.hline = $('aat-hline');
    bindGestures();
    // Pill positions follow every pan / zoom / autoscale: one rAF loop, DOM
    // writes only when a pill actually moved.
    var loop = function () { positionPills(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    S.ready = true;
    post('ready', { version: 1 });
  };

  if (!LWC) { post('error', { message: 'Chart library missing' }); return; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
