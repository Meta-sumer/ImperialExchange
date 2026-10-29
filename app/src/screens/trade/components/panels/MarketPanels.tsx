import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import Svg, { Defs, LinearGradient, Polygon, Polyline, Stop } from 'react-native-svg';

import { fetchCandles } from '@/api/market.api';
import { WatchlistButton } from '@/components/market/WatchlistButton';
import { AppText, AssetIcon, Select, type SelectOption } from '@/components/ui';
import { alpha, useTheme } from '@/theme';
import type { OrderBook, Watchlist } from '@/types/market';
import type { Instrument } from '@/types/trading';
import { getMarketSession } from '@/utils/marketSession';
import { currencySymbol, fmtNum } from '@/utils/money';

import {
  MOVER_CATS,
  aboutFor,
  compactNumber,
  depthView,
  maxLeverageLabel,
  performanceFigures,
  rankMovers,
  segmentLabel,
  volumeShort,
  type InstrumentRow,
  type MoverOverlay,
} from '../../tradeLogic';

/**
 * The market side panels — Trade.jsx's side panes and SidebarPerformance:
 * Instruments (search + watchlist / market-segment filter, bid / ask,
 * ★ via the shared watchlist modal, long-press to manage), Symbol Details,
 * About, Performance (24h card, sparkline, range bar, three fact sections),
 * Market Depth (the REAL book — see tradeLogic's note on the web's
 * synthetic ladder) and Top Movers.
 */

const GREEN = '#16A34A';
const RED = '#DC2626';

function KV({ label, value, tone, mono }: { label: string; value: string; tone?: string; mono?: boolean }): React.JSX.Element {
  return (
    <View style={s.kv}>
      <AppText variant="micro" weight="700" tone="muted" style={s.caps}>{label.toUpperCase()}</AppText>
      <AppText variant="caption" mono={mono} color={tone} numberOfLines={1} style={s.kvVal}>{value}</AppText>
    </View>
  );
}

function Blank({ text }: { text: string }): React.JSX.Element {
  return <AppText variant="caption" tone="muted" align="center" style={s.blank}>{text}</AppText>;
}

/* ── Instruments ── */

export function InstrumentsPanel({
  rows,
  total,
  activeSymbol,
  search,
  onSearch,
  filter,
  onFilter,
  watchlists,
  categories,
  onOpen,
  onManage,
}: {
  rows: readonly InstrumentRow[];
  total: number;
  activeSymbol: string;
  search: string;
  onSearch: (v: string) => void;
  filter: string;
  onFilter: (v: string) => void;
  watchlists: readonly Watchlist[];
  categories: readonly string[];
  onOpen: (sym: string) => void;
  onManage: (row: InstrumentRow) => void;
}): React.JSX.Element {
  const t = useTheme();
  const options: SelectOption[] = useMemo(() => [
    { value: 'ALL', label: 'All Instruments' },
    ...watchlists.map((w) => ({ value: `wl:${w.id}`, label: `${w.emoji ? `${w.emoji} ` : ''}${w.name} (${w.items.length})`, description: 'Watchlist' })),
    ...categories.map((c) => ({ value: c, label: segmentLabel(c), description: 'Segments' })),
  ], [watchlists, categories]);
  return (
    <View testID="panel-instruments">
      <View style={[s.tools, { borderBottomColor: t.colors.borderSubtle }]}>
        <TextInput
          value={search}
          onChangeText={onSearch}
          placeholder="Search…"
          placeholderTextColor={t.colors.textMuted}
          autoCorrect={false}
          autoCapitalize="characters"
          style={[s.search, { color: t.colors.textPrimary, borderColor: t.colors.borderDark, backgroundColor: t.colors.inputBg }]}
          testID="instruments-search"
        />
        <Select value={filter} options={options} onChange={onFilter} title="Filter instruments" accessibilityLabel="Filter instruments by watchlist or category" />
        <AppText variant="micro" tone="muted">{total} instruments</AppText>
      </View>
      <View style={[s.gridHead, { backgroundColor: t.colors.bgCard, borderBottomColor: t.colors.borderSubtle }]}>
        <AppText variant="micro" weight="700" tone="secondary" style={s.colSym}>SYMBOL</AppText>
        <AppText variant="micro" weight="700" tone="secondary" style={s.colNum}>BID</AppText>
        <AppText variant="micro" weight="700" tone="secondary" style={s.colNum}>ASK</AppText>
      </View>
      {rows.length === 0 ? <Blank text={search ? `No symbols match "${search}"` : 'This watchlist is empty'} /> : null}
      {rows.map((r) => {
        const active = r.symbol === activeSymbol;
        const change = Number(r.change24h);
        const prec = Math.min(r.pricePrecision || 2, 5);
        return (
          <Pressable
            key={r.symbol}
            accessibilityRole="button"
            onPress={() => onOpen(r.symbol)}
            onLongPress={() => onManage(r)}
            delayLongPress={450}
            style={({ pressed }) => [s.instRow, { backgroundColor: active ? alpha(t.colors.primary, 0.1) : pressed ? t.colors.bgHover : 'transparent' }]}
            testID={`instrument-row-${r.symbol}`}
          >
            <View style={[s.colSym, s.inline]}>
              <WatchlistButton symbol={r.symbol} row={r} variant="inline" size={14} persistent />
              <AssetIcon row={r} size={22} round />
              <View style={s.shrink}>
                <AppText variant="smallStrong" numberOfLines={1}>{r.symbol}</AppText>
                {Number.isFinite(change) ? (
                  <AppText variant="micro" weight="700" color={change >= 0 ? GREEN : RED}>{change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(2)}%</AppText>
                ) : null}
              </View>
            </View>
            <AppText variant="caption" mono color={GREEN} style={s.colNum}>{fmtNum(r.bid, prec)}</AppText>
            <AppText variant="caption" mono color={RED} style={s.colNum}>{fmtNum(r.ask, prec)}</AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ── Details / About ── */

export function DetailsPanel({ instrument, demo, planLeverage }: { instrument: Instrument | null; demo: boolean; planLeverage: number | null }): React.JSX.Element {
  if (!instrument) return <Blank text="Pick an instrument from Watchlist to see its details here." />;
  const prec = Math.min(instrument.pricePrecision || 2, 5);
  const change = Number(instrument.change24h);
  return (
    <View style={s.pad} testID="panel-details">
      <Header instrument={instrument} />
      <KV label="Category" value={String(instrument.category || '—')} />
      <KV label="Base / Quote" value={`${instrument.baseCurrency || '—'} / ${instrument.quoteCurrency || '—'}`} />
      <KV label="Last Price" value={fmtNum(instrument.lastPrice, prec)} mono />
      <KV label="Bid / Ask" value={`${fmtNum(instrument.bid, prec)} / ${fmtNum(instrument.ask, prec)}`} mono />
      <KV label="Spread" value={instrument.spreadValue ? `${instrument.spreadValue} (${instrument.spreadType || 'FIXED'})` : '—'} />
      <KV label="Max Leverage" value={maxLeverageLabel(instrument, demo, planLeverage)} />
      <KV label="Min Order" value={String(instrument.minOrderSize || '—')} />
      <KV label="Precision" value={`${instrument.pricePrecision || 2} digits`} />
      <KV label="Feed" value={String(instrument.raw?.externalProvider || 'Internal')} />
      <KV label="Status" value={instrument.isActive ? 'Active' : 'Inactive'} tone={instrument.isActive ? GREEN : undefined} />
      {Number.isFinite(change) ? (
        <View style={s.section}>
          <AppText variant="micro" weight="700" tone="muted" style={s.caps}>24H CHANGE</AppText>
          <AppText variant="title" mono color={change >= 0 ? GREEN : RED}>{change >= 0 ? '+' : ''}{change.toFixed(2)}%</AppText>
        </View>
      ) : null}
    </View>
  );
}

function Header({ instrument }: { instrument: Instrument }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[s.header, { borderBottomColor: t.colors.borderSubtle }]}>
      <AssetIcon row={instrument} size={36} round />
      <View style={s.shrink}>
        <AppText variant="bodyStrong" numberOfLines={1}>{instrument.symbol}</AppText>
        <AppText variant="caption" tone="muted" numberOfLines={1}>{instrument.name || `${instrument.baseCurrency}/${instrument.quoteCurrency}`}</AppText>
      </View>
    </View>
  );
}

export function AboutPanel({ instrument }: { instrument: Instrument | null }): React.JSX.Element {
  if (!instrument) return <Blank text="Pick an instrument to see its description here." />;
  const a = aboutFor(instrument);
  return (
    <View style={s.pad} testID="panel-about">
      <Header instrument={instrument} />
      <AppText variant="small" tone="secondary" style={s.para}>{a.desc}</AppText>
      <KV label="Asset Class" value={a.assetClass} />
      <KV label="Exchange" value={instrument.exchange || '—'} />
      <KV label="Quote Curr." value={instrument.quoteCurrency || '—'} />
      <KV label="Trading Hours" value={a.hours} />
      <View style={s.section}>
        <AppText variant="micro" weight="700" tone="muted" style={s.caps}>RISK NOTICE</AppText>
        <AppText variant="caption" tone="muted">Leveraged trading carries significant risk and may not be suitable for all investors. Past performance is not indicative of future results.</AppText>
      </View>
    </View>
  );
}

/* ── Performance ── */

function Sparkline({ closes, color, height = 48, loading }: { closes: number[]; color: string; height?: number; loading: boolean }): React.JSX.Element {
  if (loading) return <View style={{ height }} />;
  if (closes.length < 2) return <View style={[s.center, { height }]}><AppText variant="micro" tone="muted">No chart data</AppText></View>;
  const W = 240; const H = height; const padY = 2;
  const min = Math.min(...closes); const max = Math.max(...closes);
  const range = max - min || 1;
  const stepX = W / (closes.length - 1);
  const y = (v: number): number => H - padY - ((v - min) / range) * (H - padY * 2);
  const pts = closes.map((v, i) => `${(i * stepX).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const gid = `spark-${color.replace('#', '')}`;
  return (
    <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <Defs>
        <LinearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%" stopColor={color} stopOpacity={0.25} />
          <Stop offset="100%" stopColor={color} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Polygon points={`0,${H} ${pts} ${W},${H}`} fill={`url(#${gid})`} />
      <Polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}

export function PerformancePanel({ instrument, livePrice, demo, planLeverage }: { instrument: Instrument | null; livePrice: number | null; demo: boolean; planLeverage: number | null }): React.JSX.Element {
  const t = useTheme();
  const symbol = instrument?.symbol ?? '';
  const [candles, setCandles] = useState<{ close: number; high: number; low: number }[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!symbol) { setCandles([]); return undefined; }
    let cancelled = false;
    setLoading(true);
    fetchCandles(symbol, '1h', 48)
      .then((c) => { if (!cancelled) setCandles(c); })
      .catch(() => { if (!cancelled) setCandles([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol]);

  if (!instrument) return <Blank text="Pick an instrument to see performance stats here." />;
  const session = getMarketSession(instrument);
  const prec = Math.min(instrument.pricePrecision || 2, 5);
  const f = performanceFigures(instrument, candles, livePrice);
  const up = f.change === null ? null : f.change >= 0;
  const tone = up === null ? '#9CA3AF' : up ? GREEN : RED;
  const row = (l: string, v: string | null, c?: string): React.JSX.Element | null => (v === null ? null : (
    <View key={l} style={s.kvTight}>
      <AppText variant="caption" tone="muted">{l}</AppText>
      <AppText variant="caption" mono weight="600" color={c}>{v}</AppText>
    </View>
  ));
  const cat = instrument.category ? instrument.category.charAt(0) + instrument.category.slice(1).toLowerCase() : null;
  const commission = Number(instrument.commissionPercent);
  return (
    <View style={s.pad} testID="panel-performance">
      {!session.isOpen ? (
        <View style={[s.banner, { borderColor: alpha('#3B82F6', 0.3), backgroundColor: alpha('#3B82F6', 0.1) }]}>
          <AppText variant="caption" weight="700">{session.label}</AppText>
          {session.detail ? <AppText variant="micro" tone="muted" numberOfLines={1}>{session.detail}</AppText> : null}
        </View>
      ) : null}
      <View style={[s.card, { borderColor: t.colors.borderSubtle, backgroundColor: alpha(t.colors.bgHover, 0.4) }]}>
        <View style={s.kvTight}>
          <AppText variant="micro" weight="700" tone="muted" style={s.caps}>24H CHANGE</AppText>
          <AppText variant="micro" weight="700" color={session.isOpen ? GREEN : t.colors.textMuted}>{session.isOpen ? '● LIVE' : '● CLOSED'}</AppText>
        </View>
        <AppText variant="title" mono color={tone}>{f.change === null ? '—' : `${f.change >= 0 ? '+' : ''}${f.change.toFixed(2)}%`}</AppText>
        <Sparkline closes={candles.map((c) => Number(c.close)).filter(Number.isFinite)} color={tone} loading={loading} />
        <AppText variant="micro" mono tone="muted">
          Last · <AppText variant="micro" mono weight="700">{fmtNum(f.last, prec)}</AppText> {instrument.quoteCurrency}
          {f.open24h !== null ? `   Open · ${fmtNum(f.open24h, prec)}` : ''}
        </AppText>
      </View>
      {f.hi !== null && f.lo !== null ? (
        <View style={s.range}>
          <View style={s.kvTight}>
            <AppText variant="micro" weight="700" tone="muted">24H LOW</AppText>
            <AppText variant="micro" weight="700" tone="muted">24H HIGH</AppText>
          </View>
          <View style={[s.track, { backgroundColor: t.colors.bgHover }]}>
            <View style={[s.knob, { left: `${Math.max(0, Math.min(100, f.pctOfRange ?? 0))}%`, backgroundColor: tone }]} />
          </View>
          <View style={s.kvTight}>
            <AppText variant="caption" mono color={RED}>{fmtNum(f.lo, prec)}</AppText>
            <AppText variant="caption" mono color={GREEN}>{fmtNum(f.hi, prec)}</AppText>
          </View>
        </View>
      ) : null}
      <AppText variant="micro" weight="700" tone="muted" style={s.sectionHead}>PRICE · QUOTE</AppText>
      {[
        row('Last', Number.isFinite(f.last) ? fmtNum(f.last, prec) : null),
        row('Open', f.open24h !== null ? fmtNum(f.open24h, prec) : null),
        row('Mid', f.mid !== null ? fmtNum(f.mid, prec) : null),
        row('Bid', f.bid !== null && f.bid > 0 ? fmtNum(f.bid, prec) : null, GREEN),
        row('Ask', f.ask !== null && f.ask > 0 ? fmtNum(f.ask, prec) : null, RED),
        row('Spread', f.spreadAbs !== null && f.spreadAbs > 0 ? fmtNum(f.spreadAbs, prec) : null),
        row('Spread (bps)', f.spreadBps !== null && f.spreadBps > 0 ? f.spreadBps.toFixed(2) : null),
      ]}
      <AppText variant="micro" weight="700" tone="muted" style={s.sectionHead}>RANGE · VOLUME</AppText>
      {[
        row('24h High', f.hi !== null ? fmtNum(f.hi, prec) : null, GREEN),
        row('24h Low', f.lo !== null ? fmtNum(f.lo, prec) : null, RED),
        row('Range', f.hi !== null && f.lo !== null ? fmtNum(f.hi - f.lo, prec) : null),
        row('Range (%)', f.rangePct !== null ? `${f.rangePct.toFixed(2)}%` : null),
        row('Volume', f.volume !== null && f.volume > 0 ? compactNumber(f.volume) : null),
        row('Turnover', f.turnover !== null && f.turnover > 0 ? `${currencySymbol()}${compactNumber(f.turnover)}` : null),
      ]}
      <AppText variant="micro" weight="700" tone="muted" style={s.sectionHead}>SYMBOL · TRADING</AppText>
      {[
        row('Symbol', instrument.symbol || null),
        row('Category', cat),
        row('Base / Quote', instrument.baseCurrency && instrument.quoteCurrency ? `${instrument.baseCurrency} / ${instrument.quoteCurrency}` : null),
        row('Precision', instrument.pricePrecision ? `${instrument.pricePrecision} digits` : null),
        row('Min Order', instrument.minOrderSize ? String(instrument.minOrderSize) : null),
        row('Max Leverage', maxLeverageLabel(instrument, demo, planLeverage).split(' · ')[0] ?? null),
        row('Commission', Number.isFinite(commission) && commission > 0 ? `${(commission * 100).toFixed(3)}%` : null),
      ]}
    </View>
  );
}

/* ── Market depth ── */

export function DepthPanel({ instrument, book, livePrice }: { instrument: Instrument | null; book: OrderBook | null; livePrice: number | null }): React.JSX.Element {
  const t = useTheme();
  if (!instrument) return <Blank text="Pick an instrument to see market depth here." />;
  const session = getMarketSession(instrument);
  if (!session.isOpen) {
    return (
      <View style={[s.pad, s.center]} testID="panel-depth-closed">
        <AppText variant="smallStrong">{session.label}</AppText>
        {session.detail ? <AppText variant="caption" tone="muted" align="center">{session.detail}</AppText> : null}
        <AppText variant="micro" weight="700" tone="muted" style={s.caps}>{instrument.symbol} · {instrument.category}</AppText>
      </View>
    );
  }
  const prec = Math.min(instrument.pricePrecision || 2, 5);
  const d = depthView(book, instrument, livePrice);
  const sizeText = (v: number | null): string => (v !== null && Number.isFinite(v) ? v.toFixed(4) : '—');
  const levelRow = (side: 'a' | 'b', r: { price: number; size: number | null }, cum: number, i: number): React.JSX.Element => {
    const pct = r.size !== null && Number.isFinite(r.size) ? (r.size / d.maxSize) * 100 : 0;
    const col = side === 'a' ? RED : GREEN;
    return (
      <View key={`${side}-${i}`} style={s.level}>
        <View style={[s.levelBar, { width: `${pct}%`, backgroundColor: alpha(col, 0.1) }]} />
        <AppText variant="micro" mono color={col} style={s.levelCol}>{fmtNum(r.price, prec)}</AppText>
        <AppText variant="micro" mono tone="secondary" style={[s.levelCol, s.right]}>{sizeText(r.size)}</AppText>
        <AppText variant="micro" mono tone="muted" style={[s.levelCol, s.right]}>{r.size !== null && Number.isFinite(r.size) ? (r.size * r.price).toFixed(0) : '—'}</AppText>
        <AppText variant="micro" mono tone="muted" style={[s.levelCol, s.right]}>{cum > 0 ? cum.toFixed(2) : '—'}</AppText>
      </View>
    );
  };
  return (
    <View testID="panel-depth">
      <View style={[s.kvTight, s.padX]}>
        <AppText variant="micro" weight="700" tone="muted">{d.real ? `● LIVE · ${(book?.bids.length ?? 0) + (book?.asks.length ?? 0)} LEVELS` : '● LIVE TOP-OF-BOOK · NO DEPTH FROM THIS FEED'}</AppText>
        {book?.ts ? <AppText variant="micro" mono tone="muted">{new Date(book.ts).toLocaleTimeString()}</AppText> : null}
      </View>
      <View style={[s.depthSum, { borderBottomColor: t.colors.borderSubtle }]}>
        <View>
          <AppText variant="micro" weight="700" tone="muted">BIDS · {d.bids.length}</AppText>
          <AppText variant="caption" mono weight="700" color={GREEN}>{d.totalBidSize.toFixed(2)}</AppText>
          <AppText variant="micro" mono tone="muted">{d.totalBidNotional > 0 ? d.totalBidNotional.toFixed(0) : '—'}</AppText>
        </View>
        <View style={s.center}>
          <AppText variant="micro" weight="700" tone="muted">MID</AppText>
          <AppText variant="caption" mono weight="700">{d.mid !== null ? fmtNum(d.mid, prec) : '—'}</AppText>
        </View>
        <View style={s.alignEnd}>
          <AppText variant="micro" weight="700" tone="muted">ASKS · {d.asks.length}</AppText>
          <AppText variant="caption" mono weight="700" color={RED}>{d.totalAskSize.toFixed(2)}</AppText>
          <AppText variant="micro" mono tone="muted">{d.totalAskNotional > 0 ? d.totalAskNotional.toFixed(0) : '—'}</AppText>
        </View>
      </View>
      <View style={[s.padX, s.imb]}>
        <View style={s.kvTight}>
          <AppText variant="micro" weight="700" tone="muted">BUY {d.bidPct.toFixed(0)}%</AppText>
          <AppText variant="micro" weight="700" tone="muted">SELL {(100 - d.bidPct).toFixed(0)}%</AppText>
        </View>
        <View style={[s.imbBar, { backgroundColor: t.colors.bgHover }]}>
          <View style={{ width: `${d.bidPct}%`, backgroundColor: GREEN }} />
          <View style={{ width: `${100 - d.bidPct}%`, backgroundColor: RED }} />
        </View>
      </View>
      <View style={[s.level, s.padX]}>
        {['Price', 'Size', 'Total', 'Cumul'].map((h, i) => (
          <AppText key={h} variant="micro" weight="700" tone="muted" style={[s.levelCol, i > 0 && s.right]}>{h.toUpperCase()}</AppText>
        ))}
      </View>
      {d.asks.length === 0 ? <Blank text="No asks" /> : d.asks.map((r, i) => levelRow('a', r, d.askCumul[i] ?? 0, i))}
      {d.bids.length === 0 ? <Blank text="No bids" /> : d.bids.map((r, i) => levelRow('b', r, d.bidCumul[i] ?? 0, i))}
      {d.asks.length === 0 && d.bids.length === 0 ? <Blank text={`Waiting for price feed for ${instrument.symbol}…`} /> : null}
    </View>
  );
}

/* ── Movers ── */

function MoverRowView({ m, onOpen }: { m: ReturnType<typeof rankMovers>['gainers'][number]; onOpen: (sym: string) => void }): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable onPress={() => onOpen(m.symbol)} style={({ pressed }) => [s.moverRow, pressed && { backgroundColor: t.colors.bgHover }]} accessibilityRole="button">
      <AssetIcon row={m.row} size={22} round />
      <View style={s.flex1}>
        <AppText variant="caption" weight="700" numberOfLines={1}>{m.symbol}</AppText>
        <AppText variant="micro" mono tone="muted">{fmtNum(m.lastPrice, m.pricePrecision)}</AppText>
      </View>
      <View style={s.alignEnd}>
        <AppText variant="caption" mono weight="700" color={m.change24h >= 0 ? GREEN : RED}>{m.change24h >= 0 ? '+' : ''}{m.change24h.toFixed(2)}%</AppText>
        {volumeShort(m.volume24h) ? <AppText variant="micro" mono tone="muted">Vol {volumeShort(m.volume24h)}</AppText> : null}
      </View>
    </Pressable>
  );
}

export function MoversPanel({
  rows,
  overlay,
  cat,
  onCat,
  onOpen,
}: {
  rows: readonly InstrumentRow[];
  overlay: Record<string, MoverOverlay | undefined>;
  cat: string;
  onCat: (c: string) => void;
  onOpen: (sym: string) => void;
}): React.JSX.Element {
  const t = useTheme();
  const r = useMemo(() => rankMovers(rows, overlay, cat), [rows, overlay, cat]);
  return (
    <View testID="panel-movers">
      <View style={[s.padX, s.liveHead, { backgroundColor: alpha(t.colors.bgHover, 0.4), borderBottomColor: t.colors.borderSubtle }]}>
        <AppText variant="micro" weight="700" tone="muted">● LIVE · {r.ranked} SYMBOLS</AppText>
      </View>
      <View style={[s.chips, { borderBottomColor: t.colors.borderSubtle }]}>
        {MOVER_CATS.map((c) => {
          if (c.key !== 'ALL' && !r.counts[c.key]) return null;
          const on = cat === c.key;
          return (
            <Pressable key={c.key} onPress={() => onCat(c.key)} style={[s.chip, { borderColor: on ? t.colors.primary : t.colors.borderDark, backgroundColor: on ? alpha(t.colors.primary, 0.1) : 'transparent' }]}>
              <AppText variant="micro" weight="700" color={on ? t.colors.primaryText : t.colors.textSecondary}>{c.label} {r.counts[c.key] ?? 0}</AppText>
            </Pressable>
          );
        })}
      </View>
      <View style={[s.moverHead, { backgroundColor: alpha(GREEN, 0.06) }]}><AppText variant="micro" weight="700" color={GREEN}>▲ TOP GAINERS</AppText></View>
      {r.gainers.length === 0 ? <Blank text="Waiting for 24h data…" /> : r.gainers.map((m) => <MoverRowView key={`g-${m.symbol}`} m={m} onOpen={onOpen} />)}
      <View style={[s.moverHead, { backgroundColor: alpha(RED, 0.06) }]}><AppText variant="micro" weight="700" color={RED}>▼ TOP LOSERS</AppText></View>
      {r.losers.length === 0 ? <Blank text="Waiting for 24h data…" /> : r.losers.map((m) => <MoverRowView key={`l-${m.symbol}`} m={m} onOpen={onOpen} />)}
    </View>
  );
}

const s = StyleSheet.create({
  pad: { padding: 12, gap: 10 },
  padX: { paddingHorizontal: 12 },
  center: { alignItems: 'center', justifyContent: 'center', gap: 4 },
  alignEnd: { alignItems: 'flex-end' },
  flex1: { flex: 1 },
  shrink: { flexShrink: 1, minWidth: 0 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  right: { textAlign: 'right' },
  caps: { letterSpacing: 0.8 },
  blank: { paddingVertical: 18, paddingHorizontal: 16 },
  kv: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  kvVal: { flexShrink: 1, textAlign: 'right' },
  kvTight: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingVertical: 2 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  section: { gap: 4, paddingTop: 8 },
  sectionHead: { paddingTop: 10, letterSpacing: 1.2 },
  para: { lineHeight: 19 },
  tools: { padding: 10, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  search: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, fontSize: 13 },
  gridHead: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  instRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8 },
  colSym: { flex: 5 },
  colNum: { flex: 3, textAlign: 'right' },
  banner: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 },
  card: { borderWidth: 1, borderRadius: 12, padding: 10, gap: 6 },
  range: { gap: 4 },
  track: { height: 6, borderRadius: 3, justifyContent: 'center' },
  knob: { position: 'absolute', width: 10, height: 10, borderRadius: 5, marginLeft: -5, borderWidth: 2, borderColor: '#FFFFFF' },
  depthSum: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  imb: { paddingVertical: 8, gap: 4 },
  imbBar: { height: 6, borderRadius: 3, overflow: 'hidden', flexDirection: 'row' },
  level: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 4 },
  levelBar: { position: 'absolute', right: 0, top: 0, bottom: 0 },
  levelCol: { flex: 1 },
  liveHead: { paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  moverHead: { paddingHorizontal: 12, paddingVertical: 6 },
  moverRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8 },
});
