import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { alpha, useTheme } from '@/theme';
import type { Instrument, Order } from '@/types/trading';

import {
  ageLabel,
  distanceFromMarket,
  fillPnls,
  groupPositions,
  pendingSummary,
  summarisePositions,
  ticketShort,
  tradesFor,
  triggerPrice,
  type LivePositionRow,
  type PositionGroup,
} from '../../tradeLogic';

/**
 * The side panels for the book — Trade.jsx SidebarPositions and
 * SidebarPendingOrders: a summary card and one card per symbol / side,
 * expandable into the fills that built it.
 */

const fmtQty = (q: number): string => Number(q || 0).toLocaleString('en-US', { maximumFractionDigits: 4 });
const fmtTime = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

function Stat({ lbl, val, color }: { lbl: string; val: number | string; color: string }): React.JSX.Element {
  return (
    <View style={s.stat}>
      <AppText variant="micro" weight="700" tone="secondary" style={s.statLbl}>{lbl.toUpperCase()}</AppText>
      <AppText variant="smallStrong" mono color={color}>{val}</AppText>
    </View>
  );
}

function Tag({ label, bg, fg }: { label: string; bg: string; fg: string }): React.JSX.Element {
  return (
    <View style={[s.tag, { backgroundColor: bg }]}>
      <AppText variant="micro" weight="800" color={fg}>{label}</AppText>
    </View>
  );
}

function GroupCard({
  g,
  inst,
  active,
  fills,
  onSelect,
  onClose,
  onPartialClose,
  onLoadFills,
}: {
  g: PositionGroup;
  inst: Instrument | undefined;
  active: boolean;
  fills: readonly Order[] | null;
  onSelect: (sym: string) => void;
  onClose: (p: LivePositionRow) => void;
  onPartialClose: (p: LivePositionRow, qty: number) => void;
  onLoadFills: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const isBuy = g.side === 'BUY';
  const prec = inst?.pricePrecision ?? 4;
  return (
    <View style={[s.card, { borderColor: active ? alpha(t.colors.primary, 0.4) : t.colors.borderSubtle, backgroundColor: active ? alpha(t.colors.primary, 0.04) : t.colors.surface }]}>
      <View style={[s.stripe, { backgroundColor: isBuy ? '#10b981' : '#f43f5e' }]} />
      <Pressable
        onPress={() => { setOpen((v) => !v); if (!open) onLoadFills(); onSelect(g.symbol); }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={s.cardBody}
      >
        <View style={s.row}>
          <View style={s.rowLeft}>
            <AppText variant="micro" tone="muted">{open ? '▾' : '▸'}</AppText>
            <Tag label={isBuy ? '↑ BUY' : '↓ SELL'} bg={isBuy ? '#10b981' : '#f43f5e'} fg="#FFFFFF" />
            <AppText variant="smallStrong" numberOfLines={1} style={s.shrink}>{g.symbol}</AppText>
            <AppText variant="micro" tone="muted">{g.items.length} pos</AppText>
          </View>
          <View style={s.rowRight}>
            <AppText variant="bodyStrong" mono color={g.pnl >= 0 ? '#059669' : '#e11d48'}>{g.pnl >= 0 ? '+' : ''}{g.pnl.toFixed(2)}</AppText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close position"
              hitSlop={8}
              onPress={() => { g.items.forEach((p) => onClose(p)); }}
              style={s.x}
            >
              <AppText variant="caption" weight="800" tone="muted">✕</AppText>
            </Pressable>
          </View>
        </View>
        <View style={s.row}>
          <AppText variant="micro" mono tone="muted">Qty {fmtQty(g.totalQty)} · Avg {g.avgEntry.toFixed(prec)}</AppText>
          <AppText variant="micro" mono weight="700" color={g.pnlPct >= 0 ? '#059669' : '#e11d48'}>{g.pnlPct >= 0 ? '+' : ''}{g.pnlPct.toFixed(2)}%</AppText>
        </View>
      </Pressable>
      {open ? (
        <View style={[s.fills, { borderTopColor: t.colors.borderSubtle, backgroundColor: alpha(t.colors.bgHover, 0.6) }]}>
          {!fills ? <AppText variant="micro" tone="muted" align="center" style={s.pad}>Loading trades…</AppText> : (() => {
            const pos = g.items[0] as LivePositionRow;
            const rows = tradesFor({ ...pos, quantity: String(g.totalQty) }, fills);
            const mark = Number(pos.markLive || 0);
            const shares = fillPnls(rows, g.side, mark, g.pnl, g.totalQty);
            return (
              <>
                <AppText variant="micro" weight="700" tone="muted" style={s.fillsHead}>{rows.length} TRADE{rows.length === 1 ? '' : 'S'}</AppText>
                {rows.map((f, i) => {
                  const share = shares[i] ?? 0;
                  return (
                    <View key={`${f.id}:${i}`} style={[s.fill, { borderTopColor: t.colors.borderSubtle }]}>
                      <View style={s.row}>
                        <AppText variant="micro" mono tone="muted"><AppText variant="micro" weight="700" color={g.side === 'SELL' ? '#e11d48' : '#059669'}>{g.side}</AppText> {ticketShort(f.id)}</AppText>
                        <View style={s.rowRight}>
                          <AppText variant="smallStrong" mono color={share >= 0 ? '#059669' : '#e11d48'}>{share >= 0 ? '+' : ''}{share.toFixed(2)}</AppText>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Close this trade (${fmtQty(f.qty)})`}
                            hitSlop={8}
                            onPress={() => { if (f.qty >= g.totalQty - 1e-9) onClose(pos); else onPartialClose(pos, f.qty); }}
                            style={s.x}
                          >
                            <AppText variant="caption" weight="800" tone="muted">✕</AppText>
                          </Pressable>
                        </View>
                      </View>
                      <View style={s.row}>
                        <AppText variant="micro" mono tone="muted">Qty {fmtQty(f.qty)} · Price {f.price ? f.price.toFixed(prec) : '—'}</AppText>
                        <AppText variant="micro" mono tone="muted">Cur {mark ? mark.toFixed(prec) : '—'}{f.at ? ` · ${fmtTime(f.at)}` : ''}</AppText>
                      </View>
                    </View>
                  );
                })}
              </>
            );
          })()}
        </View>
      ) : null}
    </View>
  );
}

export function PositionsPanel({
  positions,
  activeSymbol,
  instrumentsBySymbol,
  fills,
  onSelect,
  onClose,
  onCloseAll,
  onPartialClose,
  onLoadFills,
}: {
  positions: readonly LivePositionRow[];
  activeSymbol: string;
  instrumentsBySymbol: Record<string, Instrument | undefined>;
  fills: readonly Order[] | null;
  onSelect: (sym: string) => void;
  onClose: (p: LivePositionRow) => void;
  onCloseAll: () => void;
  onPartialClose: (p: LivePositionRow, qty: number) => void;
  onLoadFills: () => void;
}): React.JSX.Element {
  const t = useTheme();
  if (!positions.length) {
    return (
      <View style={s.empty}>
        <AppText variant="smallStrong" align="center">No open positions</AppText>
        <AppText variant="caption" tone="muted" align="center">Place a market or limit order — your live positions will appear here with realtime P&L.</AppText>
      </View>
    );
  }
  const sum = summarisePositions(positions);
  const groups = groupPositions(positions);
  const up = sum.totalPnl >= 0;
  return (
    <View style={s.panel} testID="panel-positions">
      <View style={[s.summary, { backgroundColor: up ? 'rgba(16,185,129,0.10)' : 'rgba(244,63,94,0.10)', borderColor: up ? 'rgba(16,185,129,0.32)' : 'rgba(244,63,94,0.32)' }]}>
        <View style={s.row}>
          <AppText variant="micro" weight="800" tone="secondary" style={s.caps}>NET P&amp;L</AppText>
          <View style={s.rowRight}>
            <Tag label={up ? 'PROFIT' : 'LOSS'} bg={up ? '#d1fae5' : '#ffe4e6'} fg={up ? '#047857' : '#be123c'} />
            <Pressable accessibilityRole="button" accessibilityHint="Close all open positions" onPress={onCloseAll} style={[s.tag, { backgroundColor: '#ffe4e6' }]}>
              <AppText variant="micro" weight="800" color="#be123c">CLOSE ALL</AppText>
            </Pressable>
          </View>
        </View>
        <View style={s.big}>
          <AppText variant="title" mono color={up ? '#059669' : '#e11d48'}>{up ? '+' : ''}{sum.totalPnl.toFixed(2)}</AppText>
          <AppText variant="caption" mono weight="700" color={sum.pnlPct >= 0 ? '#059669' : '#e11d48'}>{sum.pnlPct >= 0 ? '+' : ''}{sum.pnlPct.toFixed(2)}%</AppText>
        </View>
        <View style={[s.stats, { borderTopColor: t.colors.borderSubtle }]}>
          <Stat lbl="Open" val={sum.open} color={t.colors.textPrimary} />
          <Stat lbl="Winners" val={sum.winners} color="#059669" />
          <Stat lbl="Losers" val={sum.losers} color="#e11d48" />
        </View>
      </View>
      {groups.map((g) => (
        <GroupCard
          key={g.key}
          g={g}
          inst={instrumentsBySymbol[g.symbol]}
          active={g.symbol === activeSymbol}
          fills={fills}
          onSelect={onSelect}
          onClose={onClose}
          onPartialClose={onPartialClose}
          onLoadFills={onLoadFills}
        />
      ))}
    </View>
  );
}

export function PendingPanel({
  orders,
  activeSymbol,
  instrumentsBySymbol,
  onCancel,
  onCancelAll,
  onModify,
  nowMs,
}: {
  orders: readonly Order[];
  activeSymbol: string;
  instrumentsBySymbol: Record<string, Instrument | undefined>;
  onCancel: (o: Order) => void;
  onCancelAll: () => void;
  onModify: (o: Order) => void;
  nowMs: number;
}): React.JSX.Element {
  const t = useTheme();
  if (!orders.length) {
    return (
      <View style={s.empty}>
        <AppText variant="smallStrong" align="center">No pending orders</AppText>
        <AppText variant="caption" tone="muted" align="center">Place a limit or stop order — it'll wait here until the market hits your price.</AppText>
      </View>
    );
  }
  const sum = pendingSummary(orders);
  return (
    <View style={s.panel} testID="panel-pending">
      <View style={[s.summary, { backgroundColor: alpha(t.colors.bgHover, 0.6), borderColor: t.colors.borderSubtle }]}>
        <View style={s.row}>
          <AppText variant="micro" weight="800" tone="secondary" style={s.caps}>PENDING</AppText>
          <Pressable accessibilityRole="button" accessibilityHint="Cancel all pending orders" onPress={onCancelAll} style={[s.tag, { backgroundColor: '#ffe4e6' }]}>
            <AppText variant="micro" weight="800" color="#be123c">CANCEL ALL</AppText>
          </Pressable>
        </View>
        <View style={s.big}>
          <AppText variant="title" mono>{sum.count}</AppText>
          <AppText variant="caption" tone="muted">order{sum.count === 1 ? '' : 's'} in queue</AppText>
        </View>
        <View style={[s.stats, { borderTopColor: t.colors.borderSubtle }]}>
          <Stat lbl="Buy" val={sum.buy} color="#059669" />
          <Stat lbl="Sell" val={sum.sell} color="#e11d48" />
          <Stat lbl="Limit" val={sum.limit} color={t.colors.textPrimary} />
          <Stat lbl="Stop" val={sum.stop} color={t.colors.textPrimary} />
        </View>
      </View>
      {orders.map((o) => {
        const inst = instrumentsBySymbol[o.symbol];
        const isBuy = o.side === 'BUY';
        const prec = inst?.pricePrecision ?? 4;
        const trig = triggerPrice(o);
        const dist = distanceFromMarket(trig, Number(inst?.lastPrice || 0));
        const age = ageLabel(o.createdAt, nowMs);
        return (
          <Pressable
            key={o.id}
            accessibilityRole="button"
            accessibilityHint="Click to modify"
            onPress={() => onModify(o)}
            style={[s.card, { borderColor: o.symbol === activeSymbol ? alpha(t.colors.primary, 0.4) : t.colors.borderSubtle, backgroundColor: o.symbol === activeSymbol ? alpha(t.colors.primary, 0.04) : t.colors.surface }]}
          >
            <View style={[s.stripe, { backgroundColor: isBuy ? '#10b981' : '#f43f5e' }]} />
            <View style={s.cardBody}>
              <View style={s.row}>
                <View style={s.rowLeft}>
                  <Tag label={isBuy ? '↑ BUY' : '↓ SELL'} bg={isBuy ? '#10b981' : '#f43f5e'} fg="#FFFFFF" />
                  <Tag label={o.type === 'STOP' ? 'STOP' : 'LIMIT'} bg={t.colors.bgHover} fg={t.colors.textSecondary} />
                  <AppText variant="smallStrong" numberOfLines={1} style={s.shrink}>{o.symbol}</AppText>
                </View>
                <View style={s.rowRight}>
                  <AppText variant="smallStrong" mono>{trig ? `@${trig.toFixed(prec)}` : '—'}</AppText>
                  <Pressable accessibilityRole="button" accessibilityLabel="Cancel order" hitSlop={8} onPress={() => onCancel(o)}>
                    <AppText variant="micro" weight="700" tone="muted">Cancel</AppText>
                  </Pressable>
                </View>
              </View>
              <View style={s.row}>
                <AppText variant="micro" mono tone="muted">
                  Qty {fmtQty(Number(o.quantity || 0))}
                  {dist !== null ? <AppText variant="micro" mono weight={Math.abs(dist) < 0.1 ? '700' : '400'} color={Math.abs(dist) < 0.1 ? '#d97706' : t.colors.textMuted}>{`  ·  ${dist >= 0 ? '+' : ''}${dist.toFixed(2)}% from mkt`}</AppText> : null}
                </AppText>
                {age ? <AppText variant="micro" mono tone="muted">{age}</AppText> : null}
              </View>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  panel: { gap: 8, padding: 8 },
  empty: { paddingVertical: 36, paddingHorizontal: 20, gap: 6, alignItems: 'center' },
  summary: { borderWidth: 1, borderRadius: 12, padding: 10, gap: 4 },
  caps: { letterSpacing: 1.4 },
  big: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  stats: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 6, marginTop: 4 },
  stat: { flex: 1, alignItems: 'center' },
  statLbl: { letterSpacing: 0.8 },
  card: { borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  stripe: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  cardBody: { paddingLeft: 10, paddingRight: 8, paddingVertical: 8, gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  shrink: { flexShrink: 1 },
  tag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  x: { paddingHorizontal: 4, paddingVertical: 2 },
  fills: { borderTopWidth: StyleSheet.hairlineWidth },
  fillsHead: { paddingHorizontal: 12, paddingTop: 6, letterSpacing: 0.8 },
  fill: { paddingLeft: 14, paddingRight: 8, paddingVertical: 6, gap: 3, borderTopWidth: StyleSheet.hairlineWidth },
  pad: { padding: 10 },
});
