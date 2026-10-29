/*
 * Chart runtime — the drawing-tools engine.
 *
 * client/src/hooks/useChartDrawings.js without React: every drawing is painted
 * on a canvas laid over the main chart, anchored in chart space
 * ({ logical, time, price }) and re-projected on every pan / zoom / resize.
 * Geometry, colours, fib ratios, hit-testing, handles, history (120 steps),
 * duplicate, lock, layer order and the measurement panel are the web's.
 *
 * What a finger needs that a mouse did not:
 *   • A 2-point tool takes tap-tap (as the web's click-click) OR press-drag-
 *     release — there is no hover to preview the second point, so a drag is
 *     the natural gesture and both work.
 *   • The web's window.prompt for text / note tools becomes a `textPrompt`
 *     message; the app asks and answers with `add`.
 *   • Right-click → long-press, double-click → double-tap. Both post to the
 *     app, which opens the drawing's menu / settings as a sheet.
 *   • Keyboard shortcuts have no equivalent; the app's toolbar carries
 *     undo / redo / delete / finish instead.
 *
 * The app owns the tool catalogue (src/charts/chartTools.ts): it sends the
 * active tool's meta ({ family, pts, variant, glyph }) with `setTool`, and a
 * stored drawing carries its own family / variant / glyph.
 */
(function (root) {
  'use strict';

  var SELECT = '#FACC15';
  var FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  var FIB_EXT = [0, 0.382, 0.618, 1, 1.272, 1.414, 1.618, 2.618];
  var FIB_COLORS = ['#6B7280', '#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#8B5CF6', '#6B7280', '#0EA5E9'];
  var GANN_RATIOS = [1 / 8, 1 / 4, 1 / 3, 1 / 2, 1, 2, 3, 4, 8];
  var FIB_SEQ = [0, 1, 2, 3, 5, 8, 13, 21, 34];
  var POLY_LABELS = {
    XABCD: ['X', 'A', 'B', 'C', 'D'], ABCD: ['A', 'B', 'C', 'D'],
    HS: ['', 'LS', '', 'H', '', 'RS', ''], '3D': ['', '1', '', '2', '', '3', ''],
    '12345': ['0', '1', '2', '3', '4', '5'], ABC: ['0', 'A', 'B', 'C'],
    ABCDE: ['0', 'A', 'B', 'C', 'D', 'E'], WXY: ['0', 'W', 'X', 'Y'], WXYXZ: ['0', 'W', 'X', 'Y', 'X', 'Z'],
  };

  // Finger-sized tolerances: the web's 6 / 8 px are for a mouse pointer.
  var HIT_TOL = 10;
  var HANDLE_TOL = 16;
  var LONG_PRESS_MS = 520;
  var MOVE_SLOP = 8;
  var SELECT_TOOLS = new Set(['crosshair', 'magnet', 'dot', 'arrowcur']);
  var WIDTH_FAMILIES = new Set(['fib', 'fibchannel', 'fibtime', 'circles', 'arcs', 'spiral', 'fan']);
  var FILL_FAMILIES = new Set(['rect', 'rectgrid', 'gannsquare', 'rotrect', 'ellipse', 'channel', 'poly', 'position', 'fibchannel', 'volprofile']);

  var seq = 0;
  var newId = function () { seq += 1; return 'd_' + Date.now() + '_' + seq.toString(36) + Math.random().toString(36).slice(2, 5); };
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };

  var defaultStyle = function (family, variant) {
    var s = { color: '#2962FF', width: 2, style: 'solid' };
    if (WIDTH_FAMILIES.has(family)) s.width = 1;
    if (FILL_FAMILIES.has(family)) s.fill = true;
    if (variant === 'hl') { s.width = 12; s.color = '#FACC15'; }
    if (family === 'measure') s.color = '#F59E0B';
    return s;
  };

  /** The web's normalize(): defaults first, then the drawing's own fields. */
  var normalize = function (d, meta) {
    var m = meta || {};
    var family = d.family || m.family;
    var variant = d.variant !== undefined ? d.variant : m.variant;
    return Object.assign(
      { locked: false, family: family, variant: variant, glyph: m.glyph },
      defaultStyle(family, variant),
      d
    );
  };

  var lineDash = function (style) { return style === 'dashed' ? [6, 4] : style === 'dotted' ? [2, 3] : []; };
  var hexA = function (hex, a) {
    if (typeof hex !== 'string' || hex[0] !== '#' || hex.length < 7) return hex;
    return 'rgba(' + parseInt(hex.slice(1, 3), 16) + ', ' + parseInt(hex.slice(3, 5), 16) + ', ' + parseInt(hex.slice(5, 7), 16) + ', ' + a + ')';
  };
  var distToSeg = function (px, py, x1, y1, x2, y2) {
    var dx = x2 - x1; var dy = y2 - y1; var len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - x1, py - y1);
    var t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  };
  var bbox = function (pts) {
    var list = pts.filter(Boolean);
    if (!list.length) return null;
    var xs = list.map(function (p) { return p.x; });
    var ys = list.map(function (p) { return p.y; });
    return { x1: Math.min.apply(null, xs), y1: Math.min.apply(null, ys), x2: Math.max.apply(null, xs), y2: Math.max.apply(null, ys) };
  };
  var inExpandedBox = function (x, y, b, tol) { return !!b && x >= b.x1 - tol && x <= b.x2 + tol && y >= b.y1 - tol && y <= b.y2 + tol; };

  var fmtDur = function (s) {
    if (s == null) return '—';
    if (s < 60) return Math.round(s) + 's';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60); var mm = m % 60;
    if (h < 24) return h + 'h ' + mm + 'm';
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  };

  /** Measurement stats from the real candles under the drawing (useChartDrawings.js:90). */
  var measureStats = function (d, candles, prec) {
    var p0 = (d.pts && d.pts[0]) || {};
    var p1 = (d.pts && d.pts[1]) || {};
    var startPrice = Number(p0.price) || 0;
    var endPrice = Number(p1.price) || 0;
    var priceDiff = endPrice - startPrice;
    var pct = startPrice ? (priceDiff / startPrice) * 100 : 0;
    var tick = Math.pow(10, -(Number(prec) || 2));
    var ticks = tick ? priceDiff / tick : 0;
    var t0 = p0.time; var t1 = p1.time;
    var durSec = (t0 != null && t1 != null) ? Math.abs(Number(t1) - Number(t0)) : null;
    var lo = Infinity; var hi = -Infinity; var vol = 0; var bars = 0;
    var cs = Array.isArray(candles) ? candles : [];
    if (t0 != null && t1 != null) {
      var tmin = Math.min(t0, t1); var tmax = Math.max(t0, t1);
      for (var i = 0; i < cs.length; i++) {
        var c = cs[i];
        if (c.time >= tmin && c.time <= tmax) {
          bars++;
          var h = Number(c.high); var l = Number(c.low);
          if (Number.isFinite(h) && h > hi) hi = h;
          if (Number.isFinite(l) && l < lo) lo = l;
          vol += Number(c.volume) || 0;
        }
      }
    }
    if (!bars) bars = Math.abs(Math.round((Number(p1.logical) || 0) - (Number(p0.logical) || 0)));
    var high = hi === -Infinity ? null : hi;
    var low = lo === Infinity ? null : lo;
    return { priceDiff: priceDiff, pct: pct, ticks: ticks, durSec: durSec, bars: bars, high: high, low: low, range: (high != null && low != null) ? high - low : null, vol: vol, prec: Number(prec) || 2 };
  };

  var drawMeasurePanel = function (ctx, st, ax, ay, color, paneW, paneH) {
    var fmt = function (v) { return v == null ? '—' : Number(v).toLocaleString(undefined, { minimumFractionDigits: st.prec, maximumFractionDigits: st.prec }); };
    var sign = function (v) { return v >= 0 ? '+' : ''; };
    var head = sign(st.priceDiff) + fmt(st.priceDiff) + ' (' + sign(st.pct) + st.pct.toFixed(2) + '%)';
    var lines = [
      sign(st.ticks) + Math.round(st.ticks) + ' ticks',
      st.bars + ' bars · ' + fmtDur(st.durSec),
      'H ' + fmt(st.high) + '   L ' + fmt(st.low),
      'Range ' + fmt(st.range),
    ];
    if (st.vol > 0) lines.push('Vol ' + st.vol.toLocaleString(undefined, { maximumFractionDigits: 0 }));
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 12px -apple-system, system-ui, sans-serif';
    var w = ctx.measureText(head).width;
    ctx.font = '11px -apple-system, system-ui, sans-serif';
    for (var i = 0; i < lines.length; i++) w = Math.max(w, ctx.measureText(lines[i]).width);
    w = Math.ceil(w) + 16;
    var headH = 22; var lineH = 16; var bodyH = lines.length * lineH + 8; var h = headH + bodyH;
    var px = ax + 10; var py = ay + 10;
    if (px + w > paneW) px = Math.max(2, ax - w - 10);
    if (py + h > paneH) py = Math.max(2, ay - h - 10);
    px = Math.max(2, px); py = Math.max(2, py);
    ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.fillRect(px, py, w, headH);
    ctx.fillStyle = 'rgba(15,23,42,0.94)'; ctx.fillRect(px, py + headH, w, bodyH);
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(px + 0.5, py + 0.5, w - 1, h - 1);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 12px -apple-system, system-ui, sans-serif'; ctx.fillText(head, px + 8, py + headH / 2);
    ctx.font = '11px -apple-system, system-ui, sans-serif'; ctx.fillStyle = '#E2E8F0';
    lines.forEach(function (l, i2) { ctx.fillText(l, px + 8, py + headH + 8 + i2 * lineH); });
  };

  var arrowHead = function (ctx, x1, y1, x2, y2, size) {
    var s = size || 9;
    var a = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath(); ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - s * Math.cos(a - 0.4), y2 - s * Math.sin(a - 0.4));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - s * Math.cos(a + 0.4), y2 - s * Math.sin(a + 0.4));
    ctx.stroke();
  };

  /**
   * opts: { chart, getSeries, container, getCandles, getPrecision, post }
   *   post(type, payload) — to the app.
   */
  var createDrawings = function (opts) {
    var chart = opts.chart;
    var getSeries = opts.getSeries;
    var container = opts.container;
    var getCandles = opts.getCandles;
    var getPrecision = opts.getPrecision;
    var post = opts.post;
    var onMeasure = opts.onMeasure || function () {};

    var state = {
      tool: 'crosshair',
      toolMeta: null,
      past: [],
      present: [],
      future: [],
      locked: false,
      hidden: false,
      pending: [],
      selectedId: null,
      emoji: '🚀',
    };
    var hover = null;
    var drag = null;
    var brush = null;
    var lastDown = { t: 0, x: 0, y: 0 };
    var press = null;
    var destroyed = false;

    /* ── coordinates ── */
    var xOf = function (anc) {
      if (!anc) return null;
      var ts = chart.timeScale();
      var x = anc.time != null ? ts.timeToCoordinate(anc.time) : null;
      if ((x == null || !Number.isFinite(x)) && anc.logical != null) x = ts.logicalToCoordinate(anc.logical);
      return Number.isFinite(x) ? x : null;
    };
    var yOf = function (price) {
      var s = getSeries();
      if (!s) return null;
      var y = s.priceToCoordinate(price);
      return Number.isFinite(y) ? y : null;
    };
    var anchorFromXY = function (x, y) {
      var s = getSeries();
      if (!s) return null;
      var ts = chart.timeScale();
      var price = s.coordinateToPrice(y);
      if (!Number.isFinite(price)) return null;
      var logical = ts.coordinateToLogical(x);
      var time = null;
      try { time = ts.coordinateToTime(x); } catch (e) { time = null; }
      return { logical: Number.isFinite(logical) ? logical : null, time: time == null ? null : time, price: price };
    };
    var P = function (anc) { if (!anc) return null; var x = xOf(anc); var y = yOf(anc.price); return (x == null || y == null) ? null : { x: x, y: y }; };
    var ptsPx = function (d) { return (d.pts || []).map(P); };

    /* ── canvas ── */
    var canvas = document.createElement('canvas');
    canvas.className = 'aat-draw-canvas';
    container.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    var paneDims = function () {
      var w = canvas.clientWidth || 0;
      var h = canvas.clientHeight || 0;
      try { w = chart.timeScale().width() || w; } catch (e) { /* not ready */ }
      return { w: w, h: h };
    };

    var emitState = function () {
      var sel = state.present.find(function (d) { return d.id === state.selectedId; }) || null;
      post('drawState', {
        tool: state.tool,
        canUndo: state.past.length > 0,
        canRedo: state.future.length > 0,
        locked: state.locked,
        hidden: state.hidden,
        count: state.present.length,
        pending: state.pending.length,
        selectedId: state.selectedId,
        selected: sel,
        emoji: state.emoji,
      });
    };

    var commit = function (updater) {
      var next = typeof updater === 'function' ? updater(state.present) : updater;
      if (next === state.present) return;
      state.past = state.past.concat([state.present]).slice(-120);
      state.present = next;
      state.future = [];
      post('drawings', { drawings: state.present });
      syncCapture();
      redraw();
      emitState();
    };

    var handlesFor = function (d) {
      var dims = paneDims();
      var out = [];
      var push = function (key, x, y) { if (x != null && y != null && Number.isFinite(x) && Number.isFinite(y)) out.push({ key: key, x: x, y: y }); };
      var px = ptsPx(d);
      var fam = d.family;
      if (fam === 'hline') { push('p0', dims.w / 2, yOf(d.pts[0] && d.pts[0].price)); return out; }
      if (fam === 'vline' || fam === 'cross') { push('p0', xOf(d.pts[0]), dims.h / 2); return out; }
      if (fam === 'rect' || fam === 'rectgrid' || fam === 'gannsquare' || fam === 'ellipse') {
        var a = px[0]; var b = px[1];
        if (!a || !b) return out;
        push('p0', a.x, a.y); push('p1', b.x, b.y); push('p01', b.x, a.y); push('p10', a.x, b.y);
        return out;
      }
      px.forEach(function (p, i) { if (p) push('p' + i, p.x, p.y); });
      return out;
    };

    /* ── render one drawing (useChartDrawings.js:284) ── */
    var drawOne = function (d, paneW, paneH, selected) {
      var col = selected ? SELECT : (d.color || '#2962FF');
      var w = d.width || 2;
      var px = ptsPx(d);
      var set = function (color, width, dash) { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []); };
      var fam = d.family;
      var dash = lineDash(d.style);

      var extLine = function (a, b, mode, arrow) {
        var x1 = a.x; var y1 = a.y; var x2 = b.x; var y2 = b.y;
        var dx = x2 - x1; var dy = y2 - y1;
        if (mode === 'rayR' || mode === 'arrowR') {
          if (dx !== 0 || dy !== 0) {
            var f = Math.max((dx >= 0 ? (paneW - x1) / (dx || 1e-6) : -x1 / (dx || -1e-6)), 1);
            x2 = x1 + dx * f; y2 = y1 + dy * f;
          }
        } else if (mode === 'extend') {
          var k = 4; x1 = a.x - dx * k; y1 = a.y - dy * k; x2 = b.x + dx * k; y2 = b.y + dy * k;
        }
        set(col, w, dash); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
        if (arrow) { set(col, w); arrowHead(ctx, a.x, a.y, b.x, b.y); }
      };

      if (fam === 'trend') {
        if (!px[0] || !px[1]) return;
        var v = d.variant;
        extLine(px[0], px[1], v, v === 'arrowR');
        if (v === 'info' || v === 'angle') {
          var dP = d.pts[1].price - d.pts[0].price;
          var dPct = d.pts[0].price ? (dP / d.pts[0].price) * 100 : 0;
          var ang = Math.atan2(-(px[1].y - px[0].y), px[1].x - px[0].x) * 180 / Math.PI;
          var txt = v === 'angle' ? ang.toFixed(1) + '°' : (dP >= 0 ? '+' : '') + dP.toFixed(2) + ' (' + dPct.toFixed(2) + '%)';
          ctx.font = 'bold 11px -apple-system, system-ui, sans-serif';
          var tw = ctx.measureText(txt).width + 10; var mx = px[1].x + 6; var my = px[1].y - 8;
          ctx.fillStyle = d.color || '#2962FF'; ctx.fillRect(mx, my - 8, tw, 16);
          ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(txt, mx + 5, my);
        }
      } else if (fam === 'hline') {
        var y = yOf(d.pts[0].price);
        if (y == null) return;
        set(col, w, dash); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(paneW, y); ctx.stroke(); ctx.setLineDash([]);
        var label = Number(d.pts[0].price).toLocaleString(undefined, { maximumFractionDigits: 6 });
        ctx.font = '11px ui-monospace, monospace';
        var lw = ctx.measureText(label).width + 8;
        ctx.fillStyle = d.color || '#2962FF'; ctx.fillRect(paneW - lw, y - 8, lw, 16);
        ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(label, paneW - lw + 4, y);
      } else if (fam === 'hray') {
        var hx = xOf(d.pts[0]); var hy = yOf(d.pts[0].price);
        if (hx == null || hy == null) return;
        set(col, w, dash); ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(paneW, hy); ctx.stroke(); ctx.setLineDash([]);
      } else if (fam === 'vline') {
        var vx = xOf(d.pts[0]);
        if (vx == null) return;
        set(col, w, dash); ctx.beginPath(); ctx.moveTo(vx, 0); ctx.lineTo(vx, paneH); ctx.stroke(); ctx.setLineDash([]);
      } else if (fam === 'cross') {
        var cx = xOf(d.pts[0]); var cy = yOf(d.pts[0].price);
        set(col, w, dash); ctx.beginPath();
        if (cy != null) { ctx.moveTo(0, cy); ctx.lineTo(paneW, cy); }
        if (cx != null) { ctx.moveTo(cx, 0); ctx.lineTo(cx, paneH); }
        ctx.stroke(); ctx.setLineDash([]);
      } else if (fam === 'rect' || fam === 'rectgrid' || fam === 'gannsquare') {
        var ra = px[0]; var rb = px[1];
        if (!ra || !rb) return;
        var rx = Math.min(ra.x, rb.x); var ry = Math.min(ra.y, rb.y); var rw = Math.abs(rb.x - ra.x); var rh = Math.abs(rb.y - ra.y);
        if (d.fill) { ctx.fillStyle = hexA(d.color || '#2962FF', 0.10); ctx.fillRect(rx, ry, rw, rh); }
        set(col, w, dash); ctx.strokeRect(rx, ry, rw, rh); ctx.setLineDash([]);
        if (fam === 'rectgrid' || fam === 'gannsquare') {
          set(hexA(col, 0.5), 1); ctx.beginPath();
          for (var gi = 1; gi < 4; gi++) {
            ctx.moveTo(rx + (rw * gi) / 4, ry); ctx.lineTo(rx + (rw * gi) / 4, ry + rh);
            ctx.moveTo(rx, ry + (rh * gi) / 4); ctx.lineTo(rx + rw, ry + (rh * gi) / 4);
          }
          ctx.stroke();
        }
        if (fam === 'gannsquare') {
          set(col, 1); ctx.beginPath();
          ctx.moveTo(rx, ry + rh); ctx.lineTo(rx + rw, ry); ctx.moveTo(rx, ry); ctx.lineTo(rx + rw, ry + rh);
          ctx.stroke();
        }
      } else if (fam === 'rotrect') {
        var qa = px[0]; var qb = px[1]; var qc = px[2];
        if (!qa || !qb) return;
        var qdx = qb.x - qa.x; var qdy = qb.y - qa.y; var len = Math.hypot(qdx, qdy) || 1;
        var nx = -qdy / len; var ny = qdx / len;
        var off = qc ? ((qc.x - qa.x) * nx + (qc.y - qa.y) * ny) : 30;
        ctx.beginPath(); ctx.moveTo(qa.x, qa.y); ctx.lineTo(qb.x, qb.y);
        ctx.lineTo(qb.x + nx * off, qb.y + ny * off); ctx.lineTo(qa.x + nx * off, qa.y + ny * off); ctx.closePath();
        if (d.fill) { ctx.fillStyle = hexA(d.color || '#2962FF', 0.10); ctx.fill(); }
        set(col, w, dash); ctx.stroke(); ctx.setLineDash([]);
      } else if (fam === 'ellipse') {
        var ea = px[0]; var eb = px[1];
        if (!ea || !eb) return;
        ctx.beginPath();
        if (d.variant === 'circle') { var r = Math.hypot(eb.x - ea.x, eb.y - ea.y); ctx.ellipse(ea.x, ea.y, r, r, 0, 0, Math.PI * 2); }
        else ctx.ellipse((ea.x + eb.x) / 2, (ea.y + eb.y) / 2, Math.abs(eb.x - ea.x) / 2, Math.abs(eb.y - ea.y) / 2, 0, 0, Math.PI * 2);
        if (d.fill) { ctx.fillStyle = hexA(d.color || '#2962FF', 0.10); ctx.fill(); }
        set(col, w, dash); ctx.stroke(); ctx.setLineDash([]);
      } else if (fam === 'channel' || fam === 'regression') {
        var ca = px[0]; var cb = px[1];
        if (!ca || !cb) return;
        var coff = 0;
        if (fam === 'regression') coff = -(Math.abs(cb.y - ca.y) * 0.5 + 20);
        else {
          var cc = px[2];
          var lineYatX = function (xx) { return ca.y + (cb.y - ca.y) * ((xx - ca.x) / ((cb.x - ca.x) || 1)); };
          coff = cc ? (cc.y - lineYatX(cc.x)) : 40;
        }
        set(col, w, dash); ctx.beginPath(); ctx.moveTo(ca.x, ca.y); ctx.lineTo(cb.x, cb.y); ctx.stroke();
        var b2y = cb.y + coff; var a2y = ca.y + coff;
        if (d.variant === 'flat' && px[2]) { a2y = px[2].y; b2y = px[2].y; }
        ctx.beginPath(); ctx.moveTo(ca.x, a2y); ctx.lineTo(cb.x, b2y); ctx.stroke(); ctx.setLineDash([]);
        if (fam === 'regression') { ctx.beginPath(); ctx.moveTo(ca.x, ca.y - coff); ctx.lineTo(cb.x, cb.y - coff); ctx.stroke(); }
        if (d.fill) {
          ctx.fillStyle = hexA(d.color || '#2962FF', 0.07); ctx.beginPath();
          ctx.moveTo(ca.x, ca.y); ctx.lineTo(cb.x, cb.y); ctx.lineTo(cb.x, b2y); ctx.lineTo(ca.x, a2y); ctx.closePath(); ctx.fill();
        }
      } else if (fam === 'fib') {
        var fa = d.pts[0]; var fb = d.pts[1]; var fc = d.pts[2];
        var ratios = d.variant === 'ext' ? FIB_EXT : FIB_RATIOS;
        var baseLo = fc ? fc.price : fa.price; var span = fb.price - fa.price;
        var xa = px[0] ? px[0].x : 0;
        var xb = d.variant === 'ext' ? paneW : (px[1] ? px[1].x : paneW);
        ctx.font = '10px ui-monospace, monospace'; ctx.textBaseline = 'middle';
        ratios.forEach(function (rt, i) {
          var price = d.variant === 'ext' ? baseLo + rt * span : fa.price + (fb.price - fa.price) * rt;
          var fy = yOf(price);
          if (fy == null) return;
          set(selected ? SELECT : FIB_COLORS[i % FIB_COLORS.length], 1);
          ctx.beginPath(); ctx.moveTo(Math.min(xa, xb), fy); ctx.lineTo(Math.max(xa, xb), fy); ctx.stroke();
          ctx.fillStyle = FIB_COLORS[i % FIB_COLORS.length]; ctx.fillText((rt * 100).toFixed(1) + '%', Math.min(xa, xb) + 4, fy - 6);
        });
      } else if (fam === 'fibchannel') {
        var ga = px[0]; var gb = px[1]; var gc = px[2];
        if (!ga || !gb) return;
        var gLine = function (xx) { return ga.y + (gb.y - ga.y) * ((xx - ga.x) / ((gb.x - ga.x) || 1)); };
        var goff = gc ? (gc.y - gLine(gc.x)) : 60;
        FIB_RATIOS.forEach(function (rt, i) {
          set(selected ? SELECT : FIB_COLORS[i % FIB_COLORS.length], 1);
          ctx.beginPath(); ctx.moveTo(ga.x, ga.y + goff * rt); ctx.lineTo(gb.x, gb.y + goff * rt); ctx.stroke();
        });
      } else if (fam === 'fibtime') {
        var ta = px[0]; var tb = px[1];
        if (!ta || !tb) return;
        var step = tb.x - ta.x;
        var tseq = d.variant === 'cycle' ? [0, 1, 2, 3, 4, 5, 6, 7, 8] : FIB_SEQ;
        tseq.forEach(function (n) {
          var tx = ta.x + step * n;
          if (tx < 0 || tx > paneW) return;
          set(selected ? SELECT : (d.color || '#2962FF'), 1, [4, 3]);
          ctx.beginPath(); ctx.moveTo(tx, 0); ctx.lineTo(tx, paneH); ctx.stroke();
        });
        ctx.setLineDash([]);
      } else if (fam === 'fan') {
        var na = px[0]; var nb = px[1];
        if (!na || !nb) return;
        var fr = d.variant === 'gann' ? GANN_RATIOS : FIB_RATIOS;
        fr.forEach(function (rt, i) {
          set(selected ? SELECT : FIB_COLORS[i % FIB_COLORS.length], 1);
          var ty = na.y + (nb.y - na.y) * (d.variant === 'gann' ? Math.min(rt, 1) : rt);
          ctx.beginPath(); ctx.moveTo(na.x, na.y); ctx.lineTo(nb.x, d.variant === 'gann' ? na.y + (nb.y - na.y) * rt : ty); ctx.stroke();
        });
      } else if (fam === 'circles' || fam === 'arcs' || fam === 'spiral') {
        var sa = px[0]; var sb = px[1];
        if (!sa || !sb) return;
        var R = Math.hypot(sb.x - sa.x, sb.y - sa.y);
        if (fam === 'spiral') {
          set(col, w); ctx.beginPath();
          for (var st = 0; st < Math.PI * 6; st += 0.15) {
            var rr = (R / 30) * Math.exp(0.196 * st);
            var sx = sa.x + rr * Math.cos(st); var sy = sa.y + rr * Math.sin(st);
            if (st === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
          }
          ctx.stroke();
        } else {
          FIB_RATIOS.forEach(function (rt, i) {
            if (rt === 0) return;
            set(selected ? SELECT : FIB_COLORS[i % FIB_COLORS.length], 1);
            ctx.beginPath();
            if (fam === 'arcs') ctx.arc(sa.x, sa.y, R * rt, Math.PI, Math.PI * 2);
            else ctx.ellipse(sa.x, sa.y, R * rt, R * rt, 0, 0, Math.PI * 2);
            ctx.stroke();
          });
        }
      } else if (fam === 'pitchfork') {
        var pa = px[0]; var pb = px[1]; var pc = px[2];
        if (!pa || !pb || !pc) return;
        var origin = pa;
        if (d.variant === 'schiff') origin = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
        else if (d.variant === 'modschiff') origin = { x: pa.x, y: (pa.y + pb.y) / 2 };
        var mid = { x: (pb.x + pc.x) / 2, y: (pb.y + pc.y) / 2 };
        var pdx = mid.x - origin.x; var pdy = mid.y - origin.y;
        var ext = function (ex, ey) { if (pdx === 0) return [ex, paneH]; var f2 = (paneW - ex) / pdx; return [paneW, ey + pdy * f2]; };
        set(col, w);
        var m = ext(origin.x, origin.y);
        ctx.beginPath(); ctx.moveTo(origin.x, origin.y); ctx.lineTo(m[0], m[1]); ctx.stroke();
        set(col, Math.max(1, w - 1));
        [pb, pc].forEach(function (p) { var u = ext(p.x, p.y); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(u[0], u[1]); ctx.stroke(); });
      } else if (fam === 'poly') {
        if (px.length < 2) {
          if (px[0]) { set(col, w); ctx.beginPath(); ctx.arc(px[0].x, px[0].y, 3, 0, 7); ctx.stroke(); }
          return;
        }
        set(col, w, dash); ctx.beginPath();
        px.forEach(function (p, i) { if (!p) return; if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        if (d.variant === 'closed') ctx.closePath();
        if (d.variant === 'closed' && d.fill) { ctx.fillStyle = hexA(d.color || '#2962FF', 0.10); ctx.fill(); }
        ctx.stroke(); ctx.setLineDash([]);
        if (d.variant === 'arrow' && px.length >= 2) {
          set(col, w);
          var la = px[px.length - 2]; var lb = px[px.length - 1];
          if (la && lb) arrowHead(ctx, la.x, la.y, lb.x, lb.y);
        }
        var labels = POLY_LABELS[d.variant];
        if (labels) {
          ctx.font = 'bold 11px -apple-system, system-ui, sans-serif'; ctx.fillStyle = d.color || '#2962FF'; ctx.textBaseline = 'middle';
          px.forEach(function (p, i) { if (p && labels[i]) ctx.fillText(labels[i], p.x + 5, p.y - 8); });
        }
      } else if (fam === 'sine') {
        var ia = px[0]; var ib = px[1];
        if (!ia || !ib) return;
        var amp = (ib.y - ia.y) / 2; var midY = (ia.y + ib.y) / 2; var slen = ib.x - ia.x;
        set(col, w, dash); ctx.beginPath();
        for (var si = 0; si <= 60; si++) {
          var t = si / 60;
          var wx = ia.x + slen * t; var wy = midY - amp * Math.sin(t * Math.PI * 2);
          if (si === 0) ctx.moveTo(wx, wy); else ctx.lineTo(wx, wy);
        }
        ctx.stroke(); ctx.setLineDash([]);
      } else if (fam === 'vwap') {
        var va = d.pts[0];
        if (!va) return;
        var cs = getCandles() || [];
        var pv = 0; var vol = 0; var line = [];
        for (var ci = 0; ci < cs.length; ci++) {
          var c = cs[ci];
          if (va.time != null && c.time < va.time) continue;
          var tp = (c.high + c.low + c.close) / 3;
          var vv = Number(c.volume) || 1;
          pv += tp * vv; vol += vv;
          var ly = yOf(pv / vol); var lx = xOf({ time: c.time });
          if (lx != null && ly != null) line.push({ x: lx, y: ly });
        }
        set(col, w); ctx.beginPath();
        line.forEach(function (p, i) { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.stroke();
      } else if (fam === 'volprofile') {
        var oa = px[0]; var ob = px[1];
        if (!oa || !ob || !d.pts) return;
        var vcs = getCandles() || [];
        var t1 = Math.min(d.pts[0].time, d.pts[1].time); var t2 = Math.max(d.pts[0].time, d.pts[1].time);
        var lo = Math.min(d.pts[0].price, d.pts[1].price); var hi = Math.max(d.pts[0].price, d.pts[1].price);
        var BINS = 24; var buckets = new Array(BINS).fill(0); var maxV = 0;
        for (var vi = 0; vi < vcs.length; vi++) {
          var vc = vcs[vi];
          if (vc.time < t1 || vc.time > t2) continue;
          var idx = Math.max(0, Math.min(BINS - 1, Math.floor(((vc.close - lo) / ((hi - lo) || 1)) * BINS)));
          buckets[idx] += Number(vc.volume) || 1;
          maxV = Math.max(maxV, buckets[idx]);
        }
        var x0 = Math.min(oa.x, ob.x); var boxW = Math.abs(ob.x - oa.x);
        if (d.fill) { ctx.fillStyle = hexA(d.color || '#2962FF', 0.06); ctx.fillRect(x0, Math.min(oa.y, ob.y), boxW, Math.abs(ob.y - oa.y)); }
        ctx.fillStyle = hexA(d.color || '#2962FF', 0.5);
        for (var bi = 0; bi < BINS; bi++) {
          if (!maxV) break;
          var py = yOf(lo + ((bi + 0.5) / BINS) * (hi - lo));
          if (py == null) continue;
          ctx.fillRect(x0, py - 3, (buckets[bi] / maxV) * boxW * 0.6, 6);
        }
        set(col, 1, [4, 3]); ctx.strokeRect(x0, Math.min(oa.y, ob.y), boxW, Math.abs(ob.y - oa.y)); ctx.setLineDash([]);
      } else if (fam === 'measure') {
        var ma = px[0]; var mb = px[1];
        if (!ma || !mb) return;
        var stt = measureStats(d, getCandles(), getPrecision());
        var up = stt.priceDiff >= 0;
        var linec = up ? '#089981' : '#F23645';
        var fillc = up ? 'rgba(8,153,129,0.15)' : 'rgba(242,54,69,0.15)';
        var mx0 = Math.min(ma.x, mb.x); var mx1 = Math.max(ma.x, mb.x); var my0 = Math.min(ma.y, mb.y); var my1 = Math.max(ma.y, mb.y);
        ctx.fillStyle = fillc; ctx.fillRect(mx0, my0, mx1 - mx0, my1 - my0);
        set(linec, 1.5, []); ctx.strokeRect(mx0, my0, mx1 - mx0, my1 - my0);
        set(linec, 1, [4, 3]); ctx.beginPath(); ctx.moveTo(mx0, ma.y); ctx.lineTo(mx1, ma.y); ctx.stroke(); ctx.setLineDash([]);
        var mcx = (mx0 + mx1) / 2;
        set(linec, 1.5); ctx.beginPath(); ctx.moveTo(mcx, ma.y); ctx.lineTo(mcx, mb.y); ctx.stroke();
        if (Math.abs(mb.y - ma.y) > 12) arrowHead(ctx, mcx, ma.y, mcx, mb.y, 8);
        drawMeasurePanel(ctx, stt, mx1, my1, linec, paneW, paneH);
      } else if (fam === 'position') {
        var pa2 = px[0]; var pb2 = px[1];
        if (!pa2 || !pb2) return;
        var long = d.variant !== 'short';
        var entryY = pa2.y; var targetY = pb2.y; var stopY = entryY + (entryY - targetY);
        var px0 = pa2.x; var px1 = pb2.x !== pa2.x ? pb2.x : pa2.x + 80;
        ctx.fillStyle = 'rgba(16,185,129,0.15)'; ctx.fillRect(Math.min(px0, px1), Math.min(entryY, targetY), Math.abs(px1 - px0), Math.abs(targetY - entryY));
        ctx.fillStyle = 'rgba(239,68,68,0.15)'; ctx.fillRect(Math.min(px0, px1), Math.min(entryY, stopY), Math.abs(px1 - px0), Math.abs(stopY - entryY));
        set(col, 1.5); ctx.beginPath(); ctx.moveTo(Math.min(px0, px1), entryY); ctx.lineTo(Math.max(px0, px1), entryY); ctx.stroke();
        ctx.font = 'bold 10px -apple-system, system-ui, sans-serif';
        ctx.fillStyle = '#10b981'; ctx.fillText(long ? 'Target' : 'Stop', px0 + 4, targetY - 4);
        ctx.fillStyle = '#ef4444'; ctx.fillText(long ? 'Stop' : 'Target', px0 + 4, stopY + 10);
      } else if (fam === 'brush') {
        if (px.length < 1) return;
        var isHl = d.variant === 'hl';
        set(isHl ? hexA(d.color || '#FACC15', 0.4) : col, isHl ? (d.width || 12) : w, dash);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
        var started = false;
        for (var pi = 0; pi < px.length; pi++) {
          var bp = px[pi];
          if (!bp) continue;
          if (started) ctx.lineTo(bp.x, bp.y); else { ctx.moveTo(bp.x, bp.y); started = true; }
        }
        ctx.stroke(); ctx.setLineDash([]); ctx.lineCap = 'butt';
      } else if (fam === 'text') {
        var tpnt = px[0];
        if (!tpnt) return;
        var fs = d.fontSize || 13;
        ctx.font = 'bold ' + fs + 'px -apple-system, system-ui, sans-serif';
        var ttw = ctx.measureText(d.text || 'Text').width + 10;
        ctx.fillStyle = selected ? SELECT : (d.color || '#2962FF'); ctx.fillRect(tpnt.x, tpnt.y - fs / 2 - 3, ttw, fs + 6);
        ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(d.text || 'Text', tpnt.x + 5, tpnt.y);
      } else if (fam === 'emoji') {
        var ep = px[0];
        if (!ep) return;
        var efs = d.fontSize || 20;
        ctx.font = efs + 'px serif'; ctx.textBaseline = 'middle'; ctx.fillText(d.emoji || '⭐', ep.x - efs / 2, ep.y);
      } else if (fam === 'marker') {
        var kp = px[0];
        if (!kp) return;
        var kfs = d.fontSize || 18;
        if ((d.variant === 'note' || d.variant === 'callout') && (d.text || d.text === '')) {
          ctx.font = 'bold 11px -apple-system, system-ui, sans-serif';
          var note = d.text || 'Note';
          var ntw = ctx.measureText(note).width + 12;
          if (d.variant === 'callout') { set(col, 1.5); ctx.beginPath(); ctx.moveTo(kp.x, kp.y); ctx.lineTo(kp.x + 14, kp.y - 22); ctx.stroke(); }
          var bx = d.variant === 'callout' ? kp.x + 14 : kp.x;
          var by = d.variant === 'callout' ? kp.y - 30 : kp.y - 9;
          ctx.fillStyle = hexA(d.color || '#2962FF', 0.95); ctx.fillRect(bx, by, ntw, 18);
          set(d.color || '#2962FF', 1); ctx.strokeRect(bx, by, ntw, 18);
          ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(note, bx + 6, by + 9);
        } else {
          ctx.font = kfs + 'px serif'; ctx.textBaseline = 'middle'; ctx.fillText(d.glyph || '⬆', kp.x - kfs / 2, kp.y);
        }
      }

      if (selected) {
        ctx.setLineDash([]);
        var hs = handlesFor(d);
        for (var hi2 = 0; hi2 < hs.length; hi2++) {
          var hnd = hs[hi2];
          ctx.fillStyle = '#fff'; ctx.strokeStyle = SELECT; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.rect(hnd.x - 5, hnd.y - 5, 10, 10); ctx.fill(); ctx.stroke();
        }
        if (d.locked && hs[0]) { ctx.fillStyle = SELECT; ctx.font = '11px serif'; ctx.fillText('🔒', hs[0].x + 8, hs[0].y - 8); }
      }
    };

    var redraw = function () {
      if (destroyed) return;
      var w = canvas.clientWidth; var h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      if (state.hidden) return;
      var paneW = w;
      try { paneW = chart.timeScale().width() || w; } catch (e) { paneW = w; }
      for (var i = 0; i < state.present.length; i++) {
        var d = state.present[i];
        var use = drag && drag.id === d.id ? drag.preview : d;
        drawOne(use, paneW, h, d.id === state.selectedId);
      }
      if (brush) drawOne(brush, paneW, h, false);
      if (state.pending.length && hover && !SELECT_TOOLS.has(state.tool) && state.tool !== 'eraser') {
        var cur = anchorFromXY(hover.x, hover.y);
        if (cur) drawOne(normalize({ kind: state.tool, pts: state.pending.concat([cur]) }, state.toolMeta), paneW, h, false);
      }
    };

    /* ── hit testing (topmost first) ── */
    var hitOne = function (d, x, y) {
      var px = ptsPx(d);
      var fam = d.family;
      if (fam === 'hline') { var yy = yOf(d.pts[0].price); return yy != null && Math.abs(y - yy) <= HIT_TOL; }
      if (fam === 'vline') { var xx = xOf(d.pts[0]); return xx != null && Math.abs(x - xx) <= HIT_TOL; }
      if (fam === 'cross') {
        var cx = xOf(d.pts[0]); var cy = yOf(d.pts[0].price);
        return (cx != null && Math.abs(x - cx) <= HIT_TOL) || (cy != null && Math.abs(y - cy) <= HIT_TOL);
      }
      if (fam === 'hray') {
        var hx = xOf(d.pts[0]); var hy = yOf(d.pts[0].price);
        return hx != null && hy != null && x >= hx - HIT_TOL && Math.abs(y - hy) <= HIT_TOL;
      }
      if (fam === 'trend') { if (!px[0] || !px[1]) return false; return distToSeg(x, y, px[0].x, px[0].y, px[1].x, px[1].y) <= HIT_TOL; }
      if (fam === 'rect' || fam === 'rectgrid' || fam === 'gannsquare' || fam === 'rotrect') {
        var a = px[0]; var b = px[1];
        if (!a || !b) return false;
        var edge = Math.min(
          distToSeg(x, y, a.x, a.y, b.x, a.y), distToSeg(x, y, b.x, a.y, b.x, b.y),
          distToSeg(x, y, b.x, b.y, a.x, b.y), distToSeg(x, y, a.x, b.y, a.x, a.y)
        );
        return edge <= HIT_TOL || (!!d.fill && inExpandedBox(x, y, bbox([a, b]), 0));
      }
      if (fam === 'ellipse') {
        var ea = px[0]; var eb = px[1];
        if (!ea || !eb) return false;
        var ex; var ey; var rx; var ry;
        if (d.variant === 'circle') { ex = ea.x; ey = ea.y; rx = ry = Math.hypot(eb.x - ea.x, eb.y - ea.y); }
        else { ex = (ea.x + eb.x) / 2; ey = (ea.y + eb.y) / 2; rx = Math.abs(eb.x - ea.x) / 2; ry = Math.abs(eb.y - ea.y) / 2; }
        var n = Math.sqrt(Math.pow((x - ex) / (rx || 1), 2) + Math.pow((y - ey) / (ry || 1), 2));
        return Math.abs(n - 1) * Math.min(rx, ry) <= HIT_TOL + 2 || (!!d.fill && n <= 1);
      }
      if (fam === 'poly' || fam === 'brush') {
        for (var j = 1; j < px.length; j++) {
          if (px[j - 1] && px[j] && distToSeg(x, y, px[j - 1].x, px[j - 1].y, px[j].x, px[j].y) <= HIT_TOL) return true;
        }
        return d.variant === 'closed' && !!d.fill && inExpandedBox(x, y, bbox(px), 0);
      }
      if (fam === 'channel' || fam === 'regression' || fam === 'fibchannel' || fam === 'pitchfork') {
        var ca = px[0]; var cb = px[1];
        if (!ca || !cb) return false;
        if (distToSeg(x, y, ca.x, ca.y, cb.x, cb.y) <= HIT_TOL + 2) return true;
        return inExpandedBox(x, y, bbox(px), 8);
      }
      if (fam === 'fib' || fam === 'measure' || fam === 'position' || fam === 'volprofile') return inExpandedBox(x, y, bbox(px), HIT_TOL);
      if (px[0]) {
        if (fam === 'text' || (fam === 'marker' && (d.variant === 'note' || d.variant === 'callout'))) {
          return x >= px[0].x - 14 && x <= px[0].x + 100 && Math.abs(y - px[0].y) <= 18;
        }
        if (fam === 'marker' || fam === 'emoji' || fam === 'vwap') return Math.hypot(x - px[0].x, y - px[0].y) <= 20;
      }
      return inExpandedBox(x, y, bbox(px), HIT_TOL + 4);
    };

    var hitTest = function (x, y) {
      for (var i = state.present.length - 1; i >= 0; i--) { if (hitOne(state.present[i], x, y)) return state.present[i]; }
      return null;
    };

    /* ── mutators ── */
    var setSelected = function (id) {
      state.selectedId = id;
      syncCapture();
      redraw();
      emitState();
    };
    var addDrawing = function (tool, meta, pts, extra) {
      var id = newId();
      var d = normalize(Object.assign({ id: id, kind: tool, pts: pts }, extra || {}), meta);
      commit(function (prev) { return prev.concat([d]); });
      setSelected(id);
      return id;
    };
    var removeDrawing = function (id) {
      commit(function (prev) { return prev.filter(function (d) { return d.id !== id; }); });
      if (state.selectedId === id) setSelected(null);
    };
    var reorder = function (id, mode) {
      commit(function (prev) {
        var i = prev.findIndex(function (d) { return d.id === id; });
        if (i < 0) return prev;
        var c = prev.slice();
        var it = c.splice(i, 1)[0];
        if (mode === 'front') c.push(it);
        else if (mode === 'back') c.unshift(it);
        else if (mode === 'forward') c.splice(Math.min(i + 1, c.length), 0, it);
        else if (mode === 'backward') c.splice(Math.max(i - 1, 0), 0, it);
        else c.splice(i, 0, it);
        return c;
      });
    };
    var duplicate = function (id) {
      var src = state.present.find(function (d) { return d.id === id; });
      if (!src) return;
      var off = function (a) {
        var x = xOf(a); var y = yOf(a.price);
        var na = anchorFromXY((x == null ? 0 : x) + 16, (y == null ? 0 : y) + 16);
        return na || a;
      };
      var nd = clone(src);
      nd.id = newId();
      nd.locked = false;
      nd.pts = (nd.pts || []).map(off);
      commit(function (prev) { return prev.concat([nd]); });
      setSelected(nd.id);
    };
    var setTool = function (tool, meta) {
      state.tool = tool || 'crosshair';
      state.toolMeta = meta || null;
      state.pending = [];
      try { chart.applyOptions({ crosshair: { mode: state.tool === 'magnet' ? 1 : 0 } }); } catch (e) { /* */ }
      syncCapture();
      redraw();
      emitState();
    };
    var finalizeFree = function () {
      var pend = state.pending;
      var meta = state.toolMeta || {};
      if (pend.length >= 2 && meta.family === 'poly' && meta.pts === 'free') addDrawing(state.tool, meta, pend);
      state.pending = [];
      setTool('crosshair', null);
    };

    /* Who gets the touches: the canvas while a drawing tool is armed or an
       object is selected (so it can be moved / resized), else the chart. */
    var syncCapture = function () {
      var capture = !SELECT_TOOLS.has(state.tool) || !!state.selectedId;
      canvas.style.pointerEvents = capture && !state.locked ? 'auto' : 'none';
    };

    var applyResize = function (orig, key, na) {
      var nd = clone(orig);
      var fam = nd.family;
      if (fam === 'hline') nd.pts[0] = Object.assign({}, nd.pts[0], { price: na.price });
      else if (fam === 'vline' || fam === 'cross') nd.pts[0] = Object.assign({}, nd.pts[0], { time: na.time, logical: na.logical });
      else if (fam === 'rect' || fam === 'rectgrid' || fam === 'gannsquare' || fam === 'ellipse') {
        if (key === 'p0') nd.pts[0] = na;
        else if (key === 'p1') nd.pts[1] = na;
        else if (key === 'p01') { nd.pts[1] = Object.assign({}, nd.pts[1], { time: na.time, logical: na.logical }); nd.pts[0] = Object.assign({}, nd.pts[0], { price: na.price }); }
        else if (key === 'p10') { nd.pts[0] = Object.assign({}, nd.pts[0], { time: na.time, logical: na.logical }); nd.pts[1] = Object.assign({}, nd.pts[1], { price: na.price }); }
      } else {
        var i = parseInt(key.slice(1), 10);
        if (Number.isFinite(i) && nd.pts[i]) nd.pts[i] = na;
      }
      return nd;
    };

    var pos = function (e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    var clearPress = function () { if (press && press.timer) clearTimeout(press.timer); press = null; };

    var onDown = function (e) {
      if (state.locked) return;
      var p = pos(e);
      var x = p.x; var y = p.y;
      var tool = state.tool;
      var now = Date.now();
      var dbl = now - lastDown.t < 320 && Math.hypot(x - lastDown.x, y - lastDown.y) < 14;
      lastDown = { t: now, x: x, y: y };
      clearPress();

      if (tool === 'eraser') { var ehit = hitTest(x, y); if (ehit) removeDrawing(ehit.id); return; }

      if (SELECT_TOOLS.has(tool)) {
        var hit = hitTest(x, y);
        // Long-press opens the object's menu in the app (or the chart's, off
        // any object); double-tap an object opens its settings.
        var pressId = hit ? hit.id : null;
        press = { x: x, y: y, timer: setTimeout(function () {
          if (!press) return;
          post('longPress', { drawingId: pressId });
          drag = null;
          redraw();
          press = null;
        }, LONG_PRESS_MS) };
        if (hit && dbl) { clearPress(); post('drawSettings', { id: hit.id }); return; }
        var sel = state.selectedId;
        if (sel) {
          var sd = state.present.find(function (dd) { return dd.id === sel; });
          if (sd && !sd.locked) {
            var hnd = handlesFor(sd).find(function (hh) { return Math.hypot(x - hh.x, y - hh.y) <= HANDLE_TOL; });
            if (hnd) {
              drag = { mode: 'resize', id: sd.id, key: hnd.key, orig: clone(sd), preview: clone(sd) };
              try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* */ }
              return;
            }
          }
        }
        if (hit) {
          if (state.selectedId !== hit.id) setSelected(hit.id);
          if (hit.locked) return;
          var snap = (hit.pts || []).map(function (a) { return { x: xOf(a), y: yOf(a.price) }; });
          drag = { mode: 'move', id: hit.id, startX: x, startY: y, snap: snap, preview: clone(hit), moved: false };
          try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* */ }
        } else {
          setSelected(null);
        }
        return;
      }

      var meta = state.toolMeta || {};
      var fam = meta.family;
      var need = meta.pts;
      var a = anchorFromXY(x, y);
      if (!a) return;
      if (fam === 'brush') {
        brush = normalize({ kind: tool, pts: [a] }, meta);
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* */ }
        return;
      }
      if (need === 'free') {
        if (dbl) { finalizeFree(); return; }
        state.pending = state.pending.concat([a]);
        redraw(); emitState();
        return;
      }
      if (need === 1) {
        var isNote = fam === 'marker' && (meta.variant === 'note' || meta.variant === 'callout');
        if (fam === 'text' || isNote) {
          post('textPrompt', { tool: tool, meta: meta, anchor: a, initial: isNote ? 'Note' : '' });
        } else if (fam === 'emoji') {
          addDrawing(tool, meta, [a], { emoji: state.emoji });
        } else {
          addDrawing(tool, meta, [a]);
        }
        setTool('crosshair', null);
        return;
      }
      // Fixed N ≥ 2: tap each point, or press-drag-release for the last one.
      if (state.pending.length < need - 1) {
        state.pending = state.pending.concat([a]);
        hover = { x: x, y: y };
        drag = { mode: 'create', startX: x, startY: y };
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* */ }
        redraw(); emitState();
      } else {
        finishFixed(a);
      }
    };

    var finishFixed = function (a) {
      var meta = state.toolMeta || {};
      var pts = state.pending.concat([a]);
      if (meta.family === 'measure') {
        var dP = a.price - pts[0].price;
        var dPct = pts[0].price ? (dP / pts[0].price) * 100 : 0;
        onMeasure({ dPrice: dP, dPct: dPct });
      }
      var tool = state.tool;
      state.pending = [];
      addDrawing(tool, meta, pts);
      setTool('crosshair', null);
    };

    var onMove = function (e) {
      var p = pos(e);
      var x = p.x; var y = p.y;
      hover = { x: x, y: y };
      if (press && Math.hypot(x - press.x, y - press.y) > MOVE_SLOP) clearPress();
      if (drag) {
        if (drag.mode === 'create') { redraw(); return; }
        if (drag.mode === 'resize') {
          var na = anchorFromXY(x, y);
          if (na) { drag.preview = applyResize(drag.orig, drag.key, na); redraw(); }
          return;
        }
        var dx = x - drag.startX; var dy = y - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) < MOVE_SLOP) return;
        drag.moved = true;
        var pv = drag.preview;
        pv.pts = drag.snap.map(function (sp, i) {
          var nx = anchorFromXY((sp.x == null ? 0 : sp.x) + dx, (sp.y == null ? 0 : sp.y) + dy);
          return nx || pv.pts[i];
        });
        redraw();
        return;
      }
      if (brush) { var ba = anchorFromXY(x, y); if (ba) { brush.pts.push(ba); redraw(); } return; }
      if (state.pending.length) redraw();
    };

    var onUp = function (e) {
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* */ }
      clearPress();
      if (drag) {
        var dr = drag;
        drag = null;
        if (dr.mode === 'create') {
          var p = pos(e);
          var meta = state.toolMeta || {};
          // A drag (not a tap) finishes a 2-point tool at the release point.
          if (meta.pts === 2 && Math.hypot(p.x - dr.startX, p.y - dr.startY) > MOVE_SLOP) {
            var a = anchorFromXY(p.x, p.y);
            if (a) { finishFixed(a); return; }
          }
          redraw();
          return;
        }
        if (dr.mode === 'resize' || dr.moved) {
          var id = dr.id; var preview = dr.preview;
          commit(function (prev) { return prev.map(function (d) { return d.id === id ? preview : d; }); });
        } else {
          redraw();
        }
        return;
      }
      if (brush) {
        var pts = brush.pts;
        var tool = state.tool;
        var bmeta = state.toolMeta;
        brush = null;
        if (pts.length >= 2) addDrawing(tool, bmeta, pts);
        setTool('crosshair', null);
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    // Selection when the canvas is not capturing: a tap on the chart hit-tests.
    var onChartClick = function (param) {
      if (!SELECT_TOOLS.has(state.tool) || state.locked || !param || !param.point) return;
      var hit = hitTest(param.point.x, param.point.y);
      setSelected(hit ? hit.id : null);
    };
    try { chart.subscribeClick(onChartClick); } catch (e) { /* */ }

    var sizeCanvas = function () {
      var dpr = window.devicePixelRatio || 1;
      var w = container.clientWidth; var h = container.clientHeight;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    };
    sizeCanvas();
    var ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sizeCanvas) : null;
    if (ro) ro.observe(container);

    // Repaint only when the chart moved or a gesture is live (useChartDrawings.js:721).
    var raf = 0;
    var lastSig = '';
    var loop = function () {
      if (destroyed) return;
      var sig = '';
      try {
        var r = chart.timeScale().getVisibleLogicalRange();
        var h = canvas.clientHeight;
        var s = getSeries();
        var p0 = s ? s.coordinateToPrice(0) : null;
        var p1 = s ? s.coordinateToPrice(h) : null;
        sig = (r ? r.from.toFixed(3) + '|' + r.to.toFixed(3) : '') + '|' + (p0 == null ? '' : p0.toFixed(5)) + '|' + (p1 == null ? '' : p1.toFixed(5)) + '|' + canvas.clientWidth + 'x' + h;
      } catch (e) { /* not ready */ }
      if (sig !== lastSig || drag || brush || state.pending.length) { lastSig = sig; redraw(); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    syncCapture();

    var zoomBy = function (factor) {
      var ts = chart.timeScale();
      var r = ts.getVisibleLogicalRange();
      if (!r) return;
      var span = (r.to - r.from) * factor; var mid = (r.from + r.to) / 2;
      try { ts.setVisibleLogicalRange({ from: mid - span / 2, to: mid + span / 2 }); } catch (e) { /* */ }
    };

    return {
      command: function (cmd, arg) {
        switch (cmd) {
          case 'setTool': setTool(arg.tool, arg.meta); break;
          case 'setEmoji': state.emoji = arg.emoji || state.emoji; emitState(); break;
          case 'undo':
            if (state.past.length) {
              state.future = [state.present].concat(state.future);
              state.present = state.past[state.past.length - 1];
              state.past = state.past.slice(0, -1);
              post('drawings', { drawings: state.present });
              redraw(); emitState();
            }
            break;
          case 'redo':
            if (state.future.length) {
              state.past = state.past.concat([state.present]);
              state.present = state.future[0];
              state.future = state.future.slice(1);
              post('drawings', { drawings: state.present });
              redraw(); emitState();
            }
            break;
          case 'clearAll':
            commit([]); state.pending = []; onMeasure(null); setSelected(null);
            break;
          case 'setLocked': state.locked = !!arg.value; if (state.locked) state.pending = []; syncCapture(); emitState(); break;
          case 'setHidden': state.hidden = !!arg.value; redraw(); emitState(); break;
          case 'remove': removeDrawing(arg.id); break;
          case 'update': commit(function (prev) { return prev.map(function (d) { return d.id === arg.id ? Object.assign({}, d, arg.patch) : d; }); }); break;
          case 'toggleLock': commit(function (prev) { return prev.map(function (d) { return d.id === arg.id ? Object.assign({}, d, { locked: !d.locked }) : d; }); }); break;
          case 'duplicate': duplicate(arg.id); break;
          case 'reorder': reorder(arg.id, arg.mode); break;
          case 'select': setSelected(arg.id || null); break;
          case 'finalize': finalizeFree(); break;
          case 'cancelPending': state.pending = []; redraw(); emitState(); break;
          case 'add': addDrawing(arg.tool, arg.meta, arg.pts, arg.extra); break;
          case 'zoomIn': zoomBy(0.7); break;
          case 'zoomOut': zoomBy(1.4); break;
          case 'resetZoom': try { chart.timeScale().fitContent(); } catch (e) { /* */ } break;
          default: break;
        }
      },
      /** Replace the set (symbol switch / first load): history starts over. */
      load: function (drawings) {
        state.past = [];
        state.future = [];
        state.present = Array.isArray(drawings) ? drawings.map(function (d) { return normalize(d, null); }) : [];
        state.pending = [];
        state.selectedId = null;
        onMeasure(null);
        syncCapture();
        redraw();
        emitState();
      },
      hitTestAt: function (x, y) { var d = hitTest(x, y); return d ? d.id : null; },
      redraw: redraw,
      destroy: function () {
        destroyed = true;
        cancelAnimationFrame(raf);
        if (ro) ro.disconnect();
        try { chart.unsubscribeClick(onChartClick); } catch (e) { /* */ }
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
        try { container.removeChild(canvas); } catch (e) { /* */ }
      },
    };
  };

  var api = { createDrawings: createDrawings, normalize: normalize, defaultStyle: defaultStyle, measureStats: measureStats, FIB_RATIOS: FIB_RATIOS };
  root.AATChart = root.AATChart || {};
  root.AATChart.drawings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
