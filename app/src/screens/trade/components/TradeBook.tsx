import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AppText, AssetIcon } from '@/components/ui';
import { alpha, useTheme } from '@/theme';
import type { Instrument, Order, Position } from '@/types/trading';
import { fmtNum, fmtPnl } from '@/utils/money';
import { formatDateTime } from '@/screens/orders/ordersLogic';

import {
  closeReasonInfo,
  feeColumns,
  fillPnls,
  orderTypeLabel,
  priceText,
  rejectedAt,
  rejectionText,
  rowMeta,
  ticketShort,
  tradesFor,
  type LivePositionRow,
  type ReasonTone,
} from '../tradeLogic';

/**
 * The Open / Pending / Closed / Rejected book under the chart — Trade.jsx's
 * bottom tabs and its PositionsTable / OrdersTable / ClosedTable /
 * RejectedTable.
 *
 * The web's wide tables become one card per row on a phone — every column
 * is still on the card: ticket, symbol and copy badge, side, volume, open
 * and current price, T/P and S/L (tap to edit, "+" to add), commission,
 * charges, open time and P/L, with Edit / Close. A position expands into the
 * individual fills that built it, each closable on its own (a partial close
 * of the netted position). Rejected orders carry the reason they were
 * refused — the point of that list.
 */

export type BookTab = 'positions' | 'orders' | 'closed' | 'rejected';

export interface TradeBookProps {
  tab: BookTab;
  onTab: (t: BookTab) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onMaximize: () => void;
  positions: readonly LivePositionRow[];
  orders: readonly Order[];
  closed: readonly Position[];
  rejected: readonly Order[];
  instrumentsBySymbol: Record<string, Instrument | undefined>;
  livePrices: Record<string, number | undefined>;
  onCloseAll: () => void;
  onClose: (p: LivePositionRow) => void;
  onPartialClose: (p: LivePositionRow, qty: number) => void;
  onModifyPosition: (p: LivePositionRow) => void;
  onModifyOrder: (o: Order) => void;
  onCancelOrder: (o: Order) => void;
  fills: readonly Order[] | null;
  onViewHistory: () => void;
}

function Cell({ label, children, right }: { label: string; children: React.ReactNode; right?: boolean }): React.JSX.Element {
  return (
    <View style={[s.cell, right && s.cellRight]}>
      <AppText variant="micro" tone="muted" style={s.cellLabel}>{label}</AppText>
      {children}
    </View>
  );
}

function TpSl({ value, label, onEdit }: { value: string | null; label: string; onEdit: () => void }): React.JSX.Element {
  const t = useTheme();
  if (value) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${label}`} onPress={onEdit} hitSlop={6}>
        <AppText variant="caption" mono weight="600">{value}</AppText>
      </Pressable>
    );
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Add ${label}`} onPress={onEdit} hitSlop={8} style={[s.add, { backgroundColor: alpha(t.colors.primary, 0.08) }]}>
      <AppText variant="caption" weight="800" tone="brand">+</AppText>
    </Pressable>
  );
}

function CopyBadge({ master }: { master: string | null | undefined }): React.JSX.Element | null {
  const t = useTheme();
  if (!master) return null;
  return (
    <View style={[s.copy, { backgroundColor: alpha(t.colors.primary, 0.1) }]} accessibilityLabel={`Copied from ${master}`}>
      <AppText variant="micro" weight="700" tone="brand" numberOfLines={1}>COPY · {master}</AppText>
    </View>
  );
}

function RowButton({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [s.rowBtn, { borderColor: danger ? alpha(t.colors.bear, 0.35) : t.colors.borderDark, backgroundColor: pressed ? t.colors.bgHover : 'transparent' }]}
    >
      <AppText variant="caption" weight="700" color={danger ? t.colors.bear : t.colors.textPrimary}>{label}</AppText>
    </Pressable>
  );
}

function Empty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }): React.JSX.Element {
  return (
    <View style={s.empty}>
      <AppText variant="small" tone="secondary" align="center">{title}</AppText>
      <AppText variant="caption" tone="muted" align="center">{body}</AppText>
      {action}
    </View>
  );
}

const useToneColor = (): ((tone: ReasonTone) => string) => {
  const t = useTheme();
  return (tone) => (tone === 'bull' ? t.colors.bull
    : tone === 'bear' ? t.colors.bear
      : tone === 'warn' ? '#F59E0B'
        : tone === 'secondary' ? t.colors.textSecondary
          : t.colors.textMuted);
};

function PositionCard({ p, inst, fills, props }: { p: LivePositionRow; inst: Instrument | undefined; fills: readonly Order[] | null; props: TradeBookProps }): React.JSX.Element {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const { quote, prec } = rowMeta(inst);
  const pnl = p.pnlLive;
  const { comm, charges } = feeColumns(p);
  const tp = p.takeProfit ? priceText(p.takeProfit, quote, prec) : null;
  const sl = p.stopLoss ? priceText(p.stopLoss, quote, prec) : null;
  const trades = fills ? tradesFor(p, fills) : null;
  const shares = trades ? fillPnls(trades, p.side, p.markLive, pnl, Number(p.quantity || 0)) : [];
  return (
    <View style={[s.card, { borderColor: t.colors.borderSubtle, backgroundColor: t.colors.surface }]} testID={`book-position-${p.id}`}>
      <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityHint="Click to view individual trades" accessibilityState={{ expanded: open }}>
        <View style={s.head}>
          <View style={s.headLeft}>
            <AppText variant="micro" tone="muted">{open ? '▾' : '▸'}</AppText>
            <AssetIcon row={inst ?? { symbol: p.symbol }} size={22} round />
            <View style={s.shrink}>
              <View style={s.inline}>
                <AppText variant="bodyStrong" numberOfLines={1}>{p.symbol}</AppText>
                <AppText variant="caption" weight="700" color={p.side === 'BUY' ? t.colors.bull : t.colors.bear}>{p.side === 'BUY' ? 'Buy' : 'Sell'}</AppText>
              </View>
              <View style={s.inline}>
                <AppText variant="micro" mono tone="muted">{ticketShort(p.id)}</AppText>
                {trades && trades.length > 1 ? (
                  <View style={[s.count, { backgroundColor: alpha(t.colors.primary, 0.1) }]} accessibilityLabel={`${trades.length} trades in this position`}>
                    <AppText variant="micro" weight="700" tone="brand">{trades.length}</AppText>
                  </View>
                ) : null}
                <CopyBadge master={p.copyMaster} />
              </View>
            </View>
          </View>
          <AppText variant="bodyStrong" mono color={pnl >= 0 ? t.colors.bull : t.colors.bear}>{fmtPnl(pnl, quote)}</AppText>
        </View>
      </Pressable>
      <View style={s.grid}>
        <Cell label="Volume, lot"><AppText variant="caption" mono>{fmtNum(p.quantity, 4)}</AppText></Cell>
        <Cell label="Open price"><AppText variant="caption" mono>{priceText(p.entryPrice, quote, prec)}</AppText></Cell>
        <Cell label="Current price" right><AppText variant="caption" mono>{priceText(p.markLive || p.entryPrice, quote, prec)}</AppText></Cell>
        <Cell label="T/P"><TpSl value={tp} label="Take Profit" onEdit={() => props.onModifyPosition(p)} /></Cell>
        <Cell label="S/L"><TpSl value={sl} label="Stop Loss" onEdit={() => props.onModifyPosition(p)} /></Cell>
        <Cell label="Commission" right><AppText variant="caption" mono tone="secondary">{comm ? fmtPnl(-Math.abs(comm), quote) : '—'}</AppText></Cell>
        <Cell label="Charges"><AppText variant="caption" mono tone="secondary">{charges ? fmtPnl(-Math.abs(charges), quote) : '—'}</AppText></Cell>
        <Cell label="Open time"><AppText variant="caption" tone="secondary">{formatDateTime(p.openedAt || p.createdAt || null)}</AppText></Cell>
        <View style={[s.cell, s.cellRight, s.actions]}>
          <RowButton label="Edit" onPress={() => props.onModifyPosition(p)} />
          <RowButton label="Close" danger onPress={() => props.onClose(p)} />
        </View>
      </View>
      {open ? (
        <View style={[s.fills, { borderTopColor: t.colors.borderSubtle, backgroundColor: t.colors.bgHover }]}>
          {!trades ? <AppText variant="caption" tone="muted" style={s.pad}>Loading trades…</AppText> : trades.map((f, i) => {
            const share = shares[i] ?? 0;
            const whole = f.qty >= Number(p.quantity || 0) - 1e-9;
            return (
              <View key={`${f.id}:${i}`} style={[s.fill, { borderBottomColor: t.colors.borderSubtle }]}>
                <View style={s.head}>
                  <AppText variant="micro" mono tone="muted">{ticketShort(f.id)} · {fmtNum(f.qty, 4)} @ {f.price ? priceText(f.price, quote, prec) : '—'}</AppText>
                  <AppText variant="caption" weight="700" mono color={share >= 0 ? t.colors.bull : t.colors.bear}>{fmtPnl(share, quote)}</AppText>
                </View>
                <View style={s.head}>
                  <AppText variant="micro" tone="muted">{f.at ? formatDateTime(f.at) : '—'}</AppText>
                  <View style={s.inline}>
                    <RowButton label="Edit" onPress={() => props.onModifyPosition(p)} />
                    <RowButton label="Close" danger onPress={() => (whole ? props.onClose(p) : props.onPartialClose(p, f.qty))} />
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function OrderCard({ o, inst, livePrices, props }: { o: Order; inst: Instrument | undefined; livePrices: Record<string, number | undefined>; props: TradeBookProps }): React.JSX.Element {
  const t = useTheme();
  const { quote, prec } = rowMeta(inst);
  const openRaw = o.type === 'STOP' ? (o.stopPrice || o.price) : (o.price || o.stopPrice);
  const cur = livePrices[o.symbol] ?? inst?.lastPrice ?? null;
  const { comm, charges } = feeColumns({ commission: o.commission, feeCategory: o.feeCategory ?? null });
  const tp = o.takeProfit ? priceText(o.takeProfit, quote, prec) : null;
  const sl = o.stopLoss ? priceText(o.stopLoss, quote, prec) : null;
  return (
    <View style={[s.card, { borderColor: t.colors.borderSubtle, backgroundColor: t.colors.surface }]} testID={`book-order-${o.id}`}>
      <View style={s.head}>
        <View style={s.headLeft}>
          <AssetIcon row={inst ?? { symbol: o.symbol }} size={22} round />
          <View style={s.shrink}>
            <View style={s.inline}>
              <AppText variant="bodyStrong" numberOfLines={1}>{o.symbol}</AppText>
              <AppText variant="caption" weight="700" color={o.side === 'BUY' ? t.colors.bull : t.colors.bear}>{orderTypeLabel(o)}</AppText>
              {o.type === 'STOP' && o.triggeredAt ? <AppText variant="micro" color="#3B82F6">(fired)</AppText> : null}
            </View>
            <View style={s.inline}>
              <AppText variant="micro" mono tone="muted">{ticketShort(o.id)}</AppText>
              <CopyBadge master={o.copyMaster} />
            </View>
          </View>
        </View>
        {/* No P&L until it fills — it has no exposure yet. */}
        <AppText variant="caption" tone="muted">—</AppText>
      </View>
      <View style={s.grid}>
        <Cell label="Volume, lot"><AppText variant="caption" mono>{fmtNum(o.quantity, 4)}</AppText></Cell>
        <Cell label="Open price"><AppText variant="caption" mono>{openRaw ? priceText(openRaw, quote, prec) : '—'}</AppText></Cell>
        <Cell label="Current price" right><AppText variant="caption" mono>{cur ? priceText(cur, quote, prec) : '—'}</AppText></Cell>
        <Cell label="T/P"><TpSl value={tp} label="Take Profit" onEdit={() => props.onModifyOrder(o)} /></Cell>
        <Cell label="S/L"><TpSl value={sl} label="Stop Loss" onEdit={() => props.onModifyOrder(o)} /></Cell>
        <Cell label="Commission (est)" right><AppText variant="caption" mono tone="secondary">{comm ? fmtPnl(-Math.abs(comm), quote) : '—'}</AppText></Cell>
        <Cell label="Charges (est)"><AppText variant="caption" mono tone="secondary">{charges ? fmtPnl(-Math.abs(charges), quote) : '—'}</AppText></Cell>
        <Cell label="Open time"><AppText variant="caption" tone="secondary">{formatDateTime(o.createdAt)}</AppText></Cell>
        <View style={[s.cell, s.cellRight, s.actions]}>
          <RowButton label="Modify" onPress={() => props.onModifyOrder(o)} />
          <RowButton label="Cancel" danger onPress={() => props.onCancelOrder(o)} />
        </View>
      </View>
    </View>
  );
}

function ClosedCard({ c, inst }: { c: Position; inst: Instrument | undefined }): React.JSX.Element {
  const t = useTheme();
  const toneColor = useToneColor();
  const quote = inst?.quoteCurrency || 'INR';
  const prec = inst?.pricePrecision || 4;
  const pnl = Number(c.realizedPnl || 0);
  const { comm, charges } = feeColumns(c);
  const reason = closeReasonInfo(c.closeReason);
  return (
    <View style={[s.card, { borderColor: t.colors.borderSubtle, backgroundColor: t.colors.surface }]} testID={`book-closed-${c.id}`}>
      <View style={s.head}>
        <View style={s.headLeft}>
          <AssetIcon row={inst ?? { symbol: c.symbol }} size={22} round />
          <View style={s.shrink}>
            <View style={s.inline}>
              <AppText variant="bodyStrong" numberOfLines={1}>{c.symbol}</AppText>
              <AppText variant="caption" weight="700" color={c.side === 'BUY' ? t.colors.bull : t.colors.bear}>{c.side === 'BUY' ? 'Buy' : 'Sell'}</AppText>
            </View>
            <View style={s.inline}>
              <AppText variant="micro" mono tone="muted">{ticketShort(c.id)}</AppText>
              <CopyBadge master={c.copyMaster} />
            </View>
          </View>
        </View>
        <AppText variant="bodyStrong" mono color={pnl >= 0 ? t.colors.bull : t.colors.bear}>{fmtPnl(pnl, quote)}</AppText>
      </View>
      <View style={s.grid}>
        <Cell label="Volume, lot"><AppText variant="caption" mono>{fmtNum(Number(c.closedQuantity) > 0 ? c.closedQuantity : c.quantity, 4)}</AppText></Cell>
        <Cell label="Open price"><AppText variant="caption" mono>{priceText(c.entryPrice, quote, prec)}</AppText></Cell>
        <Cell label="Close price" right><AppText variant="caption" mono>{c.closePrice ? priceText(c.closePrice, quote, prec) : '—'}</AppText></Cell>
        <Cell label="T/P"><AppText variant="caption" mono>{c.takeProfit ? priceText(c.takeProfit, quote, prec) : '—'}</AppText></Cell>
        <Cell label="S/L"><AppText variant="caption" mono>{c.stopLoss ? priceText(c.stopLoss, quote, prec) : '—'}</AppText></Cell>
        <Cell label="Commission" right><AppText variant="caption" mono tone="secondary">{comm ? fmtPnl(-Math.abs(comm), quote) : '—'}</AppText></Cell>
        <Cell label="Charges"><AppText variant="caption" mono tone="secondary">{charges ? fmtPnl(-Math.abs(charges), quote) : '—'}</AppText></Cell>
        <Cell label="Open time"><AppText variant="caption" tone="secondary">{formatDateTime(c.openedAt || c.createdAt || null)}</AppText></Cell>
        <Cell label="Closed time" right><AppText variant="caption" tone="secondary">{formatDateTime(c.closedAt ?? null)}</AppText></Cell>
        <Cell label="Reason"><AppText variant="caption" weight="600" color={toneColor(reason.tone)}>{reason.text}</AppText></Cell>
      </View>
    </View>
  );
}

/** Trade.jsx RejectedTable — Order ID, Symbol, Side, Type, Volume, Reason, When. */
function RejectedCard({ o }: { o: Order }): React.JSX.Element {
  const t = useTheme();
  const reason = rejectionText(o);
  const when = rejectedAt(o);
  return (
    <View style={[s.card, { borderColor: t.colors.borderSubtle, backgroundColor: t.colors.surface }]} testID={`book-rejected-${o.id}`}>
      <View style={s.head}>
        <View style={s.headLeft}>
          <View style={s.shrink}>
            <View style={s.inline}>
              <AppText variant="bodyStrong" numberOfLines={1}>{o.symbol}</AppText>
              <AppText variant="caption" weight="700" color={o.side === 'BUY' ? t.colors.bull : t.colors.bear}>{o.side}</AppText>
              <AppText variant="caption" tone="secondary">{o.type}</AppText>
            </View>
            <AppText variant="micro" mono tone="muted">{ticketShort(o.id)}</AppText>
          </View>
        </View>
        <AppText variant="caption" mono tone="secondary">{o.quantity}</AppText>
      </View>
      <View style={s.grid}>
        <View style={s.cellWide}>
          <AppText variant="micro" tone="muted" style={s.cellLabel}>Reason</AppText>
          {reason.recorded
            ? <AppText variant="caption" color={t.colors.bear}>{reason.text}</AppText>
            : <AppText variant="caption" tone="muted" style={s.italic}>{reason.text}</AppText>}
        </View>
        <Cell label="When"><AppText variant="caption" tone="muted">{when ? new Date(when).toLocaleString() : '—'}</AppText></Cell>
      </View>
    </View>
  );
}

export function TradeBook(props: TradeBookProps): React.JSX.Element {
  const t = useTheme();
  const { tab, collapsed, positions, orders, closed, rejected, instrumentsBySymbol } = props;
  const tabs: { k: BookTab; label: string; count: number }[] = [
    { k: 'positions', label: 'Open', count: positions.length },
    { k: 'orders', label: 'Pending', count: orders.length },
    { k: 'closed', label: 'Closed', count: closed.length },
    { k: 'rejected', label: 'Rejected', count: rejected.length },
  ];
  return (
    <View style={s.root} testID="trade-book">
      <View style={[s.bar, { borderBottomColor: t.colors.borderSubtle }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.tabs} style={s.tabsWrap}>
          {tabs.map((x) => {
            const on = tab === x.k;
            return (
              <Pressable
                key={x.k}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                onPress={() => { props.onTab(x.k); if (collapsed) props.onToggleCollapsed(); }}
                style={[s.tab, on && !collapsed && { borderBottomColor: t.colors.primary }]}
                testID={`book-tab-${x.k}`}
              >
                <AppText variant="smallStrong" color={on ? t.colors.textPrimary : t.colors.textSecondary}>{x.label}</AppText>
                <View style={[s.tabCount, { backgroundColor: on ? t.colors.primary : t.colors.bgHover }]}>
                  <AppText variant="micro" weight="700" color={on ? t.colors.onPrimary : t.colors.textSecondary}>{x.count}</AppText>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
        <View style={s.tools}>
          {tab === 'positions' && positions.length > 0 && !collapsed ? (
            <Pressable accessibilityRole="button" onPress={props.onCloseAll} style={[s.closeAll, { borderColor: alpha(t.colors.bear, 0.3), backgroundColor: alpha(t.colors.bear, 0.12) }]} testID="book-close-all">
              <AppText variant="micro" weight="700" color={t.colors.bear}>Close All</AppText>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Maximize panel" onPress={props.onMaximize} hitSlop={6} style={s.icon}>
            <AppText variant="caption" tone="secondary">⤢</AppText>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={collapsed ? 'Expand panel' : 'Minimize panel'} onPress={props.onToggleCollapsed} hitSlop={6} style={s.icon}>
            <AppText variant="caption" tone="secondary">{collapsed ? '▴' : '▾'}</AppText>
          </Pressable>
        </View>
      </View>
      {!collapsed ? (
        <ScrollView style={s.list} contentContainerStyle={s.listContent} nestedScrollEnabled>
          {tab === 'positions' ? (
            positions.length === 0
              ? <Empty title="No open positions" body="Place a market or limit order to open one." />
              : positions.map((p) => <PositionCard key={p.id} p={p} inst={instrumentsBySymbol[p.symbol]} fills={props.fills} props={props} />)
          ) : null}
          {tab === 'orders' ? (
            orders.length === 0
              ? <Empty title="No open orders" body="Pending limit/stop orders will appear here." />
              : orders.map((o) => <OrderCard key={o.id} o={o} inst={instrumentsBySymbol[o.symbol]} livePrices={props.livePrices} props={props} />)
          ) : null}
          {tab === 'closed' ? (
            closed.length === 0
              ? (
                <Empty
                  title="No closed trades to show"
                  body="Closed positions will appear here."
                  action={<Pressable accessibilityRole="link" onPress={props.onViewHistory}><AppText variant="caption" weight="700" tone="brand">View full history</AppText></Pressable>}
                />
              )
              : closed.map((c) => <ClosedCard key={c.id} c={c} inst={instrumentsBySymbol[c.symbol]} />)
          ) : null}
          {tab === 'rejected' ? (
            rejected.length === 0
              ? <Empty title="No rejected orders" body="Orders the system could not accept will appear here, with the reason." />
              : rejected.map((o) => <RejectedCard key={o.id} o={o} />)
          ) : null}
        </ScrollView>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 4 },
  tabsWrap: { flexShrink: 1 },
  tabs: { flexDirection: 'row' },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 3, borderBottomColor: 'transparent' },
  tabCount: { minWidth: 20, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, alignItems: 'center' },
  tools: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  closeAll: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1, marginRight: 4 },
  icon: { paddingHorizontal: 8, paddingVertical: 6 },
  list: { flex: 1 },
  listContent: { padding: 8, gap: 8 },
  card: { borderWidth: 1, borderRadius: 12, padding: 10, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  headLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1, minWidth: 0, gap: 2 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  count: { minWidth: 16, paddingHorizontal: 4, borderRadius: 8, alignItems: 'center' },
  copy: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, maxWidth: 140 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 8 },
  cell: { width: '33.33%', gap: 2, paddingRight: 6 },
  cellWide: { width: '66.66%', gap: 2, paddingRight: 6 },
  cellRight: { alignItems: 'flex-end', paddingRight: 0 },
  cellLabel: { textTransform: 'uppercase', letterSpacing: 0.4 },
  italic: { fontStyle: 'italic' },
  actions: { flexDirection: 'row', gap: 6, justifyContent: 'flex-end', alignItems: 'center' },
  add: { width: 26, height: 22, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  rowBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1 },
  fills: { borderTopWidth: 1, borderRadius: 8, overflow: 'hidden' },
  fill: { paddingHorizontal: 10, paddingVertical: 8, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  pad: { padding: 10 },
  empty: { paddingVertical: 28, alignItems: 'center', gap: 4 },
});
