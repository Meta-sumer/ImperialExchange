import React, { useMemo } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { AppText } from '@/components/ui';
import { useTheme } from '@/theme';
import type { Instrument } from '@/types/trading';

/**
 * The eye toggle's TradingView chart (PriceChart.jsx:1217-1276): the public
 * tv.js widget for the same symbol and interval, laid over the platform
 * chart, with an "open in browser" way out when TradingView is slow or
 * blocked on the network (the embed is otherwise just blank).
 *
 * This is the only chart that needs the network to draw — it is
 * TradingView's page, not ours, and says so in its header.
 */

export const tvConfigFor = (symbol: string, timeframe: string, instrument: Pick<Instrument, 'category' | 'raw'> | null): { sym: string; interval: string } => {
  const cat = String(instrument?.category || '').toUpperCase();
  const feed = instrument?.raw?.externalFeedSymbol;
  let sym = symbol;
  if (cat === 'FOREX') sym = `FX:${symbol}`;
  else if (cat === 'CRYPTO') sym = `BINANCE:${String(typeof feed === 'string' && feed ? feed : symbol).toUpperCase()}`;
  else if (cat === 'COMMODITY') sym = `TVC:${symbol}`;
  const interval = ({ '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D', '1w': 'W' } as Record<string, string>)[timeframe] || 'D';
  return { sym, interval };
};

const widgetHtml = (sym: string, interval: string, dark: boolean): string => `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>html,body,#tv{margin:0;height:100%;background:${dark ? '#0F1623' : '#FFFFFF'}}</style></head>
<body><div id="tv"></div>
<script src="https://s3.tradingview.com/tv.js"></script>
<script>
try {
  new TradingView.widget(${JSON.stringify({
    autosize: true,
    symbol: sym,
    interval,
    timezone: 'Etc/UTC',
    theme: dark ? 'dark' : 'light',
    style: '1',
    locale: 'en',
    allow_symbol_change: true,
    hide_side_toolbar: false,
    withdateranges: true,
    container_id: 'tv',
  })});
} catch (e) {}
</script></body></html>`;

export function TradingViewDemo({ symbol, timeframe, instrument }: { symbol: string; timeframe: string; instrument: Instrument | null }): React.JSX.Element {
  const t = useTheme();
  const cfg = useMemo(() => tvConfigFor(symbol, timeframe, instrument), [symbol, timeframe, instrument]);
  const html = useMemo(() => widgetHtml(cfg.sym, cfg.interval, t.mode === 'dark'), [cfg, t.mode]);
  const url = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(cfg.sym)}`;
  return (
    <View style={[StyleSheet.absoluteFill, s.wrap, { backgroundColor: t.colors.surface }]} testID="tv-demo">
      <View style={[s.head, { borderBottomColor: t.colors.borderDark }]}>
        <AppText variant="caption" tone="muted" numberOfLines={1} style={s.flex1}>TradingView · {cfg.sym}</AppText>
        <Pressable accessibilityRole="link" onPress={() => { void Linking.openURL(url); }} hitSlop={8}>
          <AppText variant="caption" weight="700" tone="brand">Blank? Open in browser ↗</AppText>
        </Pressable>
      </View>
      <WebView
        source={{ html, baseUrl: 'https://www.tradingview.com' }}
        originWhitelist={['*']}
        javaScriptEnabled
        style={s.flex1}
        setSupportMultipleWindows={false}
      />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { zIndex: 30 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1 },
  flex1: { flex: 1 },
});
