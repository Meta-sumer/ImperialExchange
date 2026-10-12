import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, ActivityIndicator } from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../services/api';
import { useColors, radius } from '../theme';

const TFS = [
  { id: '1m', label: '1m' }, { id: '5m', label: '5m' }, { id: '15m', label: '15m' },
  { id: '1h', label: '1H' }, { id: '4h', label: '4H' }, { id: '1d', label: '1D' },
];

// Self-contained chart page — lightweight-charts from CDN (the same engine the
// web terminal uses). Exposes updateData / addSMA / removeSMA to the RN side.
function html(colors) {
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>html,body{margin:0;padding:0;height:100%;background:${colors.bg};overflow:hidden}#c{width:100%;height:100%}</style>
</head><body><div id="c"></div>
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
<script>
  var post = function(m){ if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(m); };
  var chart, series, sma;
  function boot(){
    if(!window.LightweightCharts){ return setTimeout(boot, 60); }
    chart = LightweightCharts.createChart(document.getElementById('c'), {
      layout:{ background:{color:'${colors.bg}'}, textColor:'${colors.textMuted}', fontFamily:'-apple-system,Roboto,sans-serif' },
      grid:{ vertLines:{color:'${colors.borderSubtle}'}, horzLines:{color:'${colors.borderSubtle}'} },
      rightPriceScale:{ borderColor:'${colors.border}' },
      timeScale:{ borderColor:'${colors.border}', timeVisible:true, secondsVisible:false },
      crosshair:{ mode:1 },
      handleScroll:true, handleScale:true,
    });
    series = chart.addCandlestickSeries({ upColor:'${colors.bull}', downColor:'${colors.bear}', wickUpColor:'${colors.bull}', wickDownColor:'${colors.bear}', borderVisible:false });
    var resize=function(){ chart.applyOptions({ width: window.innerWidth, height: window.innerHeight }); };
    window.addEventListener('resize', resize); resize();
    post('ready');
  }
  window.updateData = function(d){ if(series){ series.setData(d); chart.timeScale().fitContent(); } };
  window.addSMA = function(period){
    if(!series || !chart) return; removeSMA();
    var d = series.data ? series.data() : window.__d || [];
    var src = window.__d || [];
    var out=[]; var sum=0;
    for(var i=0;i<src.length;i++){ sum+=src[i].close; if(i>=period) sum-=src[i-period].close; if(i>=period-1) out.push({time:src[i].time, value:sum/period}); }
    sma = chart.addLineSeries({ color:'#F59E0B', lineWidth:1 }); sma.setData(out);
  };
  window.removeSMA = function(){ if(sma){ chart.removeSeries(sma); sma=null; } };
  var _upd = window.updateData; window.updateData = function(d){ window.__d=d; _upd(d); };
  boot();
</script></body></html>`;
}

// When `timeframe` is passed the chart is CONTROLLED by the parent (its own
// timeframe pills are hidden) — e.g. the instrument-detail screen drives both
// the chart and its analytics from a single row of pills. Left uncontrolled
// (no `timeframe` prop) it shows its own 1m…1D selector.
export default function TradingViewChart({ symbol, height = 260, timeframe, limit }) {
  const c = useColors();
  const controlled = timeframe != null;
  const [tf, setTf] = useState('1h');
  const effTf = controlled ? timeframe : tf;
  const effLimit = limit || 300;
  const [sma, setSma] = useState(false);
  const [fs, setFs] = useState(false);
  const ready = useRef(false);
  const dataRef = useRef([]);
  const webRef = useRef(null);
  const fsWebRef = useRef(null);
  const [loading, setLoading] = useState(true);

  const source = useMemo(() => html(c), [c]);

  const inject = useCallback((js) => {
    webRef.current?.injectJavaScript(js + ';true;');
    fsWebRef.current?.injectJavaScript(js + ';true;');
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/instruments/${encodeURIComponent(symbol)}/candles`, { params: { timeframe: effTf, limit: effLimit } });
      const raw = Array.isArray(data?.data) ? data.data : [];
      const seen = new Set();
      const candles = raw.map((x) => ({
        time: Math.floor(new Date(x.openTime).getTime() / 1000),
        open: Number(x.open), high: Number(x.high), low: Number(x.low), close: Number(x.close),
      })).filter((x) => Number.isFinite(x.close) && !seen.has(x.time) && seen.add(x.time))
        .sort((a, b) => a.time - b.time);
      dataRef.current = candles;
      if (ready.current) inject(`window.updateData(${JSON.stringify(candles)})`);
    } catch {}
    setLoading(false);
  }, [symbol, effTf, effLimit, inject]);

  useEffect(() => { load(); }, [load]);

  const onReady = useCallback(() => {
    ready.current = true;
    if (dataRef.current.length) inject(`window.updateData(${JSON.stringify(dataRef.current)})`);
    if (sma) inject('window.addSMA(20)');
  }, [inject, sma]);

  const toggleSma = () => {
    const next = !sma; setSma(next);
    inject(next ? 'window.addSMA(20)' : 'window.removeSMA()');
  };

  const chartView = (h, isFs) => (
    <View style={{ height: h, borderRadius: isFs ? 0 : radius.md, overflow: 'hidden', backgroundColor: c.bg }}>
      <WebView
        ref={isFs ? fsWebRef : webRef}
        originWhitelist={['*']}
        source={{ html: source }}
        onMessage={(e) => { if (e.nativeEvent.data === 'ready') onReady(); }}
        style={{ backgroundColor: c.bg }}
        scrollEnabled={false}
        setSupportMultipleWindows={false}
        javaScriptEnabled
      />
      {loading && <View style={styles.loading}><ActivityIndicator color={c.primary500} /></View>}
    </View>
  );

  return (
    <View>
      {/* Controls — the timeframe pills are hidden when the parent controls tf. */}
      <View style={styles.controls}>
        {controlled ? <View style={{ flex: 1 }} /> : (
          <View style={{ flexDirection: 'row', gap: 6, flex: 1, flexWrap: 'wrap' }}>
            {TFS.map((t) => (
              <TouchableOpacity key={t.id} onPress={() => setTf(t.id)} style={[styles.tf, tf === t.id && { backgroundColor: c.primarySoft }]}>
                <Text style={{ fontSize: 12, fontWeight: '700', color: tf === t.id ? c.primary500 : c.textMuted }}>{t.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        <TouchableOpacity onPress={toggleSma} style={[styles.icon, sma && { backgroundColor: c.primarySoft }]}>
          <Text style={{ fontSize: 11, fontWeight: '800', color: sma ? c.primary500 : c.textMuted }}>MA</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setFs(true)} style={styles.icon}>
          <Ionicons name="expand" size={16} color={c.textSecondary} />
        </TouchableOpacity>
      </View>

      {chartView(height, false)}

      {/* Fullscreen (rotate the device for landscape) */}
      <Modal visible={fs} animationType="slide" onRequestClose={() => setFs(false)} supportedOrientations={['portrait', 'landscape']}>
        <View style={{ flex: 1, backgroundColor: c.bg }}>
          <View style={[styles.fsBar, { backgroundColor: c.card, borderBottomColor: c.border }]}>
            <Text style={{ fontSize: 15, fontWeight: '800', color: c.textPrimary }}>{symbol} · {String(effTf).toUpperCase()}</Text>
            <TouchableOpacity onPress={() => setFs(false)}><Ionicons name="close" size={24} color={c.textSecondary} /></TouchableOpacity>
          </View>
          <View style={{ flex: 1 }}>{chartView('100%', true)}</View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  controls: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  tf: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: 6 },
  icon: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, minWidth: 32, alignItems: 'center' },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  fsBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
});
