import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { errorMessage } from '@/api/client';
import {
  cancelOrder as apiCancelOrder,
  closePosition as apiClosePosition,
  fetchOpenOrders,
  fetchPositions,
} from '@/api/trading.api';
import { AppText, toast } from '@/components/ui';
import { useTheme } from '@/theme';
import type { Order, Position } from '@/types/trading';
import { fmtSigned } from '@/utils/money';
import { subscribePositions } from '@/websocket/channels';

import { useLiveBoard } from '@/screens/trade/useLiveBoard';

/**
 * Open positions and pending orders, self-contained — EquityHub's
 * client/src/components/PositionsPanel.jsx.
 *
 * It fetches its own data (GET /trading/positions and /trading/orders/open,
 * side by side, one failing never blanking the other) and owns its own
 * actions (close a position, cancel an order), so it can be mounted on the
 * Positions page, on an instrument page, or anywhere else, without the host
 * knowing anything about trading state.
 *
 * `symbol` narrows it to one instrument (StockDetail's Positions tab);
 * omitted, it shows the whole account. `accountId` scopes the reads to one
 * trading account; omitted, every account's rows show, as on the web.
 *
 * The book re-reads on `user:positions` rather than polling, and each held
 * symbol's ticker marks its row to market, so the P&L moves as it does in
 * the terminal (ticks coalesced, released while `active` is false).
 */

type PanelTab = 'positions' | 'orders';

/** PositionsPanel.jsx `pnlOf`: the live mark, else the server's, else the entry. */
export const panelPnl = (p: Pick<Position, 'symbol' | 'markPrice' | 'entryPrice' | 'quantity' | 'side'>, priceMap: Record<string, number | undefined>): number => {
  const mark = Number(priceMap[p.symbol] || p.markPrice || p.entryPrice);
  const entry = Number(p.entryPrice);
  const qty = Number(p.quantity);
  if (!Number.isFinite(mark) || !Number.isFinite(entry) || !Number.isFinite(qty)) return 0;
  return p.side === 'BUY' ? (mark - entry) * qty : (entry - mark) * qty;
};

/** The empty line under each tab (PositionsPanel.jsx Empty). */
export const panelEmpty = (tab: PanelTab, symbol: string | null): { title: string; hint: string } => (tab === 'positions'
  ? { title: 'No open positions', hint: symbol ? `Positions in ${symbol} will appear here.` : 'Place an order and it will appear here.' }
  : { title: 'No pending orders', hint: symbol ? `Pending orders in ${symbol} will appear here.` : 'Limit and stop orders waiting to trigger appear here.' });

export interface PositionsPanelProps {
  symbol?: string | null;
  accountId?: string | null;
  /** Drops the Market column (the web's `compact`). */
  compact?: boolean;
  /** Live ticks and refetches run only while true (the host's focus). */
  active?: boolean;
  testID?: string;
}

export function PositionsPanel({ symbol = null, accountId = null, compact = false, active = true, testID = 'positions-panel' }: PositionsPanelProps): React.JSX.Element {
  const t = useTheme();
  const [tab, setTab] = useState<PanelTab>('positions');
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true);
    // allSettled so one endpoint failing does not blank the other list.
    const [p, o] = await Promise.allSettled([fetchPositions({ accountId }), fetchOpenOrders({ accountId })]);
    if (!alive.current) return;
    if (p.status === 'fulfilled') setPositions(p.value);
    if (o.status === 'fulfilled') setOrders(o.value);
    setLoading(false);
  }, [accountId]);

  useEffect(() => { void load(); }, [load]);

  // Refresh when anything moves the book, rather than polling.
  useEffect(() => {
    if (!active) return undefined;
    return subscribePositions(() => { void load(true); });
  }, [load, active]);

  // Mark to market.
  const symbols = useMemo(() => [...new Set(positions.map((x) => x.symbol).filter(Boolean))], [positions]);
  const { prices: priceMap } = useLiveBoard(symbols, active);

  const shown = useMemo(() => {
    const f = <T extends { symbol: string }>(arr: readonly T[]): T[] => (symbol ? arr.filter((x) => x.symbol === symbol) : [...arr]);
    return { positions: f(positions), orders: f(orders) };
  }, [positions, orders, symbol]);

  const closePosition = async (id: string): Promise<void> => {
    setBusyId(id);
    try {
      await apiClosePosition(id);
      toast.success('Position closing');
      await load(true);
    } catch (e) { toast.error(errorMessage(e)); } finally { if (alive.current) setBusyId(null); }
  };

  const cancelOrder = async (id: string): Promise<void> => {
    setBusyId(id);
    try {
      await apiCancelOrder(id);
      toast.success('Order cancelled');
      await load(true);
    } catch (e) { toast.error(errorMessage(e)); } finally { if (alive.current) setBusyId(null); }
  };

  const tabs: { k: PanelTab; label: string; count: number }[] = [
    { k: 'positions', label: 'Open', count: shown.positions.length },
    { k: 'orders', label: 'Pending', count: shown.orders.length },
  ];
  const empty = panelEmpty(tab, symbol);

  const head = (cells: { label: string; flex: number; right?: boolean }[]): React.JSX.Element => (
    <View style={[s.row, s.headRow, { backgroundColor: t.colors.bgCard }]}>
      {cells.map((c, i) => (
        <AppText key={i} variant="micro" weight="600" tone="muted" style={[{ flex: c.flex }, c.right && s.right]} numberOfLines={1}>{c.label}</AppText>
      ))}
    </View>
  );

  return (
    <View style={s.root} testID={testID}>
      <View style={[s.bar, { borderBottomColor: t.colors.borderSubtle }]}>
        {tabs.map((x) => {
          const on = tab === x.k;
          return (
            <Pressable key={x.k} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => setTab(x.k)} style={s.tab} testID={`${testID}-tab-${x.k}`}>
              <AppText variant="smallStrong" color={on ? t.colors.textPrimary : t.colors.textSecondary}>{x.label}</AppText>
              <View style={[s.count, { backgroundColor: on ? t.colors.primary : t.colors.bgHover }]}>
                <AppText variant="micro" weight="700" color={on ? t.colors.onPrimary : t.colors.textSecondary}>{x.count}</AppText>
              </View>
            </Pressable>
          );
        })}
        <Pressable accessibilityRole="button" onPress={() => { void load(); }} style={s.refresh} hitSlop={6}>
          <AppText variant="micro" weight="600" tone="muted">Refresh</AppText>
        </Pressable>
      </View>

      <ScrollView style={s.body} nestedScrollEnabled>
        {loading ? (
          <AppText variant="caption" tone="muted" align="center" style={s.pad}>Loading…</AppText>
        ) : tab === 'positions' ? (
          shown.positions.length === 0 ? (
            <Empty title={empty.title} hint={empty.hint} />
          ) : (
            <View>
              {head([
                { label: 'Symbol', flex: 3 },
                { label: 'Side', flex: 2 },
                { label: 'Volume', flex: 2, right: true },
                { label: 'Entry', flex: 3, right: true },
                ...(compact ? [] : [{ label: 'Market', flex: 3, right: true }]),
                { label: 'P&L', flex: 3, right: true },
                { label: '', flex: 2 },
              ])}
              {shown.positions.map((p) => {
                const pnl = panelPnl(p, priceMap);
                const busy = busyId === p.id;
                const mark = priceMap[p.symbol] ?? p.markPrice ?? null;
                return (
                  <View key={p.id} style={[s.row, { borderTopColor: t.colors.borderSubtle }]} testID={`${testID}-position-${p.id}`}>
                    <AppText variant="caption" weight="600" numberOfLines={1} style={{ flex: 3 }}>{p.symbol}</AppText>
                    <AppText variant="caption" weight="600" color={p.side === 'BUY' ? t.colors.bull : t.colors.bear} style={{ flex: 2 }}>{p.side}</AppText>
                    <AppText variant="caption" mono tone="secondary" style={[{ flex: 2 }, s.right]} numberOfLines={1}>{p.quantity}</AppText>
                    <AppText variant="caption" mono tone="secondary" style={[{ flex: 3 }, s.right]} numberOfLines={1}>{p.entryPrice}</AppText>
                    {compact ? null : (
                      <AppText variant="caption" mono tone="secondary" style={[{ flex: 3 }, s.right]} numberOfLines={1}>{mark != null ? String(mark) : '—'}</AppText>
                    )}
                    <AppText variant="caption" mono weight="700" color={pnl >= 0 ? t.colors.bull : t.colors.bear} style={[{ flex: 3 }, s.right]} numberOfLines={1}>{fmtSigned(pnl)}</AppText>
                    <View style={[{ flex: 2 }, s.actionCell]}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Close position"
                        disabled={busy}
                        onPress={() => { void closePosition(p.id); }}
                        style={[s.btn, { borderColor: t.colors.borderDark, opacity: busy ? 0.4 : 1 }]}
                      >
                        <AppText variant="micro" weight="700">{busy ? '…' : 'Close'}</AppText>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </View>
          )
        ) : shown.orders.length === 0 ? (
          <Empty title={empty.title} hint={empty.hint} />
        ) : (
          <View>
            {head([
              { label: 'Symbol', flex: 3 },
              { label: 'Side', flex: 2 },
              { label: 'Type', flex: 2 },
              { label: 'Volume', flex: 2, right: true },
              { label: 'Price', flex: 3, right: true },
              { label: '', flex: 2 },
            ])}
            {shown.orders.map((o) => {
              const busy = busyId === o.id;
              return (
                <View key={o.id} style={[s.row, { borderTopColor: t.colors.borderSubtle }]} testID={`${testID}-order-${o.id}`}>
                  <AppText variant="caption" weight="600" numberOfLines={1} style={{ flex: 3 }}>{o.symbol}</AppText>
                  <AppText variant="caption" weight="600" color={o.side === 'BUY' ? t.colors.bull : t.colors.bear} style={{ flex: 2 }}>{o.side}</AppText>
                  <AppText variant="caption" tone="secondary" style={{ flex: 2 }} numberOfLines={1}>{o.type}</AppText>
                  <AppText variant="caption" mono tone="secondary" style={[{ flex: 2 }, s.right]} numberOfLines={1}>{o.quantity}</AppText>
                  <AppText variant="caption" mono tone="secondary" style={[{ flex: 3 }, s.right]} numberOfLines={1}>{o.price ?? o.stopPrice ?? '—'}</AppText>
                  <View style={[{ flex: 2 }, s.actionCell]}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Cancel order"
                      disabled={busy}
                      onPress={() => { void cancelOrder(o.id); }}
                      style={[s.btn, { borderColor: t.colors.borderDark, opacity: busy ? 0.4 : 1 }]}
                    >
                      <AppText variant="micro" weight="700" color={t.colors.bear}>{busy ? '…' : 'Cancel'}</AppText>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function Empty({ title, hint }: { title: string; hint: string }): React.JSX.Element {
  return (
    <View style={s.empty}>
      <AppText variant="smallStrong" align="center">{title}</AppText>
      <AppText variant="caption" tone="muted" align="center">{hint}</AppText>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  count: { minWidth: 20, paddingHorizontal: 8, paddingVertical: 1, borderRadius: 999, alignItems: 'center' },
  refresh: { marginLeft: 'auto', marginRight: 8 },
  body: { flex: 1 },
  pad: { padding: 24 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'transparent' },
  headRow: { paddingVertical: 6 },
  right: { textAlign: 'right' },
  actionCell: { alignItems: 'flex-end' },
  btn: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 4 },
  empty: { alignItems: 'center', paddingHorizontal: 24, paddingVertical: 40, gap: 4 },
});

