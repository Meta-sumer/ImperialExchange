import { CHART_RUNTIME_SOURCE } from './runtime/generated';
import { CHART_LIBRARY_SOURCE } from './vendor/chartLibrary';

/**
 * The document the chart WebView loads: the vendored lightweight-charts
 * build, the runtime (src/charts/runtime, bundled by
 * scripts/build-chart-runtime.mjs) and the overlay markup it drives. Both
 * scripts are inline, so a chart opens with no network at all.
 *
 * Built once per theme and cached — the string is ~310 KB and every chart
 * pane on the Trade page uses the same one.
 */

/** `</script` inside an inline script would end the element early. */
const inline = (src: string): string => src.replace(/<\/script/gi, '<\\/script');

const CSS = `
html,body{margin:0;padding:0;height:100%;overflow:hidden;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none;touch-action:none;overscroll-behavior:none;font-family:-apple-system,system-ui,Roboto,sans-serif}
#aat-wrap{position:relative;height:100vh;display:flex;flex-direction:column}
#aat-main{position:relative;flex:1 1 auto;min-height:0;overflow:hidden}
#aat-chart{position:absolute;left:0;top:0;right:0;bottom:0}
.aat-draw-canvas{position:absolute;left:0;top:0;z-index:5;pointer-events:none;touch-action:none}
#aat-legend{position:absolute;top:4px;left:8px;z-index:10;pointer-events:none;max-width:calc(100% - 76px);font-size:11px;font-weight:600}
#aat-status{display:flex;flex-direction:column;gap:2px}
.aat-row{display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden}
.aat-sym{pointer-events:auto;font-weight:700;padding:2px 2px;border-radius:4px}
.aat-sym i{font-style:normal;opacity:.6}
.aat-muted{color:#94A3B8}
[data-mode=light] .aat-muted{color:#64748B}
.aat-mono{font-variant-numeric:tabular-nums;display:inline-flex;gap:4px}
.aat-bold{font-weight:700}
#aat-legend-rows{display:flex;flex-direction:column;align-items:flex-start;gap:2px;margin-top:3px}
.aat-leg-row{pointer-events:auto;display:inline-flex;align-items:center;gap:6px;padding:1px 2px 1px 6px;border-radius:4px}
.aat-leg-label{max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aat-leg-btn{padding:3px 6px;font-size:12px;line-height:1}
.aat-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;display:inline-block}
#aat-pills{position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:10;overflow:hidden}
.aat-pill{position:absolute;left:50%;top:0;pointer-events:auto;touch-action:none;display:flex;align-items:stretch;gap:5px;font:10.5px/1 ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;will-change:transform}
.aat-pill-main{display:flex;align-items:stretch;border:1px solid;border-radius:2px;background:rgba(255,255,255,.9);box-shadow:0 1px 3px rgba(0,0,0,.12)}
[data-mode=dark] .aat-pill-main{background:rgba(15,23,42,.9)}
.aat-pill-label{padding:5px 6px;color:#fff;font-weight:800;font-size:10px;letter-spacing:.02em}
.aat-pill-cell{padding:5px 6px;border-left:1px solid;font-weight:700;display:flex;align-items:center}
.aat-pill-cell.aat-first{border-left:none;font-weight:600}
.aat-pill-x{padding:5px 8px;border-left:1px solid;display:flex;align-items:center;font-weight:800}
.aat-quick{padding:5px 7px;color:#fff;font-weight:800;font-size:9.5px;border-radius:2px;display:flex;align-items:center;box-shadow:0 1px 3px rgba(0,0,0,.18)}
.aat-dragging .aat-pill-main{box-shadow:0 0 0 1px rgba(250,204,21,.4),0 0 14px rgba(250,204,21,.45),0 2px 8px rgba(0,0,0,.14)}
.aat-preview{opacity:.9}
#aat-drag-glow{position:absolute;left:0;right:0;top:0;height:2px;z-index:9;pointer-events:none;display:none;opacity:.85}
#aat-drag-chip{position:absolute;right:2px;top:0;z-index:12;pointer-events:none;display:none;color:#fff;padding:3px 5px;border-radius:2px;font:bold 11px ui-monospace,Menlo,monospace}
#aat-countdown{position:absolute;right:64px;bottom:32px;z-index:11;display:none;padding:3px 7px;border-radius:6px;font:bold 11px ui-monospace,Menlo,monospace;pointer-events:none;border:1px solid rgba(148,163,184,.4);background:rgba(255,255,255,.9);color:#334155}
[data-mode=dark] #aat-countdown{background:rgba(15,23,42,.9);color:#CBD5E1}
#aat-diag{position:absolute;top:44px;right:64px;z-index:12;display:none;padding:8px 10px;border-radius:8px;font:11px ui-monospace,Menlo,monospace;pointer-events:none;border:1px solid rgba(148,163,184,.4);background:rgba(255,255,255,.95);color:#0F172A;line-height:1.55}
[data-mode=dark] #aat-diag{background:rgba(15,23,42,.95);color:#E2E8F0}
.aat-diag-title{font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;font-weight:700;color:#64748B;margin-bottom:3px}
.aat-kv{display:flex;justify-content:space-between;gap:18px}
#aat-event{position:absolute;top:36px;left:50%;transform:translateX(-50%);z-index:10;display:none;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:11px;white-space:nowrap;pointer-events:none;border:1px solid rgba(148,163,184,.4);background:rgba(255,255,255,.95);color:#0F172A;max-width:calc(100% - 90px);overflow:hidden}
[data-mode=dark] #aat-event{background:rgba(15,23,42,.95);color:#E2E8F0}
.aat-ev-name{overflow:hidden;text-overflow:ellipsis;max-width:130px}
#aat-measure{position:absolute;top:6px;right:64px;z-index:12;display:none;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;font:11px ui-monospace,Menlo,monospace;border:1px solid rgba(148,163,184,.4);background:rgba(255,255,255,.95);color:#0F172A}
[data-mode=dark] #aat-measure{background:rgba(15,23,42,.95);color:#E2E8F0}
.aat-x{padding:2px 4px;color:#64748B}
#aat-logo{position:absolute;left:8px;bottom:32px;height:18px;max-width:110px;object-fit:contain;opacity:.9;pointer-events:none;z-index:4;display:none}
#aat-subs{flex:0 0 auto}
.aat-sub{border-top:1px solid rgba(148,163,184,.35)}
.aat-sub-head{font-size:9px;text-transform:uppercase;letter-spacing:.14em;font-weight:700;padding:3px 10px;border-bottom:1px solid}
.aat-sub-head b{font-weight:600;opacity:.75}
.aat-sub-host{position:relative;width:100%}
#aat-vline{position:absolute;top:0;bottom:0;left:0;width:0;border-left:1px dashed rgba(17,24,39,.25);opacity:0;z-index:15;pointer-events:none;will-change:transform}
#aat-hline{position:absolute;left:0;right:0;top:0;height:0;border-top:1px dashed rgba(17,24,39,.25);opacity:0;z-index:15;pointer-events:none;will-change:transform}
[data-mode=dark] #aat-vline,[data-mode=dark] #aat-hline{border-color:rgba(255,255,255,.3)}
`;

const BODY = `
<div id="aat-wrap">
  <div id="aat-main">
    <div id="aat-chart"></div>
    <img id="aat-logo" alt="" />
    <div id="aat-legend"><div id="aat-status"></div><div id="aat-legend-rows"></div></div>
    <div id="aat-event"></div>
    <div id="aat-measure"></div>
    <div id="aat-diag"></div>
    <div id="aat-countdown"></div>
    <div id="aat-drag-glow"></div>
    <div id="aat-pills"></div>
    <div id="aat-drag-chip"></div>
  </div>
  <div id="aat-subs"></div>
  <div id="aat-vline"></div>
  <div id="aat-hline"></div>
</div>`;

const cache = new Map<string, string>();

export const buildChartHtml = (mode: 'light' | 'dark'): string => {
  const hit = cache.get(mode);
  if (hit) return hit;
  const bg = mode === 'dark' ? '#0F1623' : '#FFFFFF';
  const html = `<!doctype html><html data-mode="${mode}"><head><meta charset="utf-8">`
    + '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">'
    + `<style>${CSS}</style></head><body style="background:${bg}">${BODY}`
    + `<script>${inline(CHART_LIBRARY_SOURCE)}</script>`
    + `<script>${inline(CHART_RUNTIME_SOURCE)}</script>`
    + '</body></html>';
  cache.set(mode, html);
  return html;
};
