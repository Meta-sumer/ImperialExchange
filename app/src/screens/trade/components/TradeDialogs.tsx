import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { AppText, BottomSheet, Button, Modal, Toggle } from '@/components/ui';
import { alpha, useTheme } from '@/theme';
import type { UserAccount } from '@/types/user';
import type { Instrument, Order } from '@/types/trading';
import { accountTierLabel, isDemoLike } from '@/utils/accountType';
import { fmtMoney, fmtNum } from '@/utils/money';

import { leverageText, type EquityFigures } from '../tradeLogic';

/**
 * The Trade page's dialogs: the pending-order modify modal
 * (components/PendingOrderModifyModal.jsx), the account menu under the top
 * bar's chip and the equity strip (Trade.jsx).
 */

/* ── Pending order modify ── */

export interface OrderModifyFields {
  price?: string;
  stopPrice?: string;
  quantity: string;
  stopLoss: string | null;
  takeProfit: string | null;
}

/** The web sends every field; an empty SL / TP clears it (null). Exported for tests. */
export const orderModifyFields = (isStop: boolean, v: { price: string; qty: string; sl: string; tp: string }): OrderModifyFields => ({
  ...(isStop ? { stopPrice: v.price } : { price: v.price }),
  quantity: v.qty,
  stopLoss: v.sl === '' ? null : v.sl,
  takeProfit: v.tp === '' ? null : v.tp,
});

function Field({ label, value, onChange, placeholder, autoFocus }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={s.field}>
      <AppText variant="label">{label}</AppText>
      <TextInput
        value={value}
        onChangeText={onChange}
        keyboardType="decimal-pad"
        placeholder={placeholder}
        placeholderTextColor={t.colors.textMuted}
        autoFocus={autoFocus}
        style={[s.input, { color: t.colors.textPrimary, borderColor: t.colors.borderDark, backgroundColor: t.colors.inputBg }]}
        accessibilityLabel={label}
      />
    </View>
  );
}

export function PendingOrderModifyModal({
  order,
  onClose,
  onSave,
  onCancelOrder,
}: {
  order: Order | null;
  instrument?: Instrument | null;
  onClose: () => void;
  onSave: (order: Order, fields: OrderModifyFields) => Promise<void>;
  onCancelOrder: (order: Order) => void;
}): React.JSX.Element {
  const t = useTheme();
  const isStop = order?.type === 'STOP';
  const isBuy = order?.side === 'BUY';
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('');
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!order) return;
    setPrice(String((order.type === 'STOP' ? order.stopPrice : order.price) ?? ''));
    setQty(String(order.quantity ?? ''));
    setSl(order.stopLoss != null ? String(order.stopLoss) : '');
    setTp(order.takeProfit != null ? String(order.takeProfit) : '');
    setSaving(false);
  }, [order]);

  const submit = async (): Promise<void> => {
    if (!order || saving) return;
    setSaving(true);
    try { await onSave(order, orderModifyFields(isStop, { price, qty, sl, tp })); } finally { setSaving(false); }
  };

  return (
    <Modal
      open={!!order}
      onClose={onClose}
      size="sm"
      testID="order-modify"
      title={order ? (
        <View style={s.titleRow}>
          <View style={[s.tag, { backgroundColor: isBuy ? '#10b981' : '#f43f5e' }]}><AppText variant="micro" weight="800" color="#FFFFFF">{isBuy ? '↑ BUY' : '↓ SELL'}</AppText></View>
          <View style={[s.tag, { backgroundColor: t.colors.bgHover }]}><AppText variant="micro" weight="700" tone="secondary">{order.type}</AppText></View>
          <AppText variant="bodyStrong" numberOfLines={1}>{order.symbol}</AppText>
        </View>
      ) : undefined}
      footer={(
        <View style={s.footer}>
          <Button title="Cancel order" variant="danger" size="sm" onPress={() => { if (order) onCancelOrder(order); }} />
          <Button title={saving ? 'Saving…' : 'Save changes'} size="sm" disabled={saving} onPress={() => { void submit(); }} style={s.flex1} testID="order-modify-save" />
        </View>
      )}
    >
      <View style={s.form}>
        <Field label={isStop ? 'Trigger price' : 'Limit price'} value={price} onChange={setPrice} autoFocus />
        <Field label="Quantity" value={qty} onChange={setQty} />
        <View style={s.two}>
          <View style={s.flex1}><Field label="Stop loss" value={sl} onChange={setSl} placeholder="—" /></View>
          <View style={s.flex1}><Field label="Take profit" value={tp} onChange={setTp} placeholder="—" /></View>
        </View>
      </View>
    </Modal>
  );
}

/* ── Account menu ── */

function MetricRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={s.metric}>
      <AppText variant="small" tone="secondary">{label}</AppText>
      <AppText variant="smallStrong" mono>{value}</AppText>
    </View>
  );
}

function MenuLink({ label, onPress, strong }: { label: string; onPress: () => void; strong?: boolean }): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [s.link, pressed && { backgroundColor: t.colors.bgHover }]}>
      <AppText variant={strong ? 'bodyStrong' : 'small'}>{label}</AppText>
      <AppText variant="small" tone="muted">{strong ? '›' : '↗'}</AppText>
    </Pressable>
  );
}

export function AccountMenuSheet({
  open,
  onClose,
  account,
  accounts,
  figures,
  walletFree,
  balances,
  leverage,
  hideBalance,
  onHideBalance,
  onSelectAccount,
  onDeposit,
  onWithdraw,
  onHistory,
}: {
  open: boolean;
  onClose: () => void;
  account: UserAccount | null;
  accounts: readonly UserAccount[];
  figures: EquityFigures;
  /** The selected account's wallet free balance (the switcher shows it for that row). */
  walletFree: number | null;
  /** Every account's free balance, by id (Trade.jsx accountBalances). */
  balances: Record<string, number>;
  leverage: number | null;
  hideBalance: boolean;
  onHideBalance: (v: boolean) => void;
  onSelectAccount: (id: string) => void;
  onDeposit: () => void;
  onWithdraw: () => void;
  onHistory: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const [view, setView] = useState<'metrics' | 'switch'>('metrics');
  useEffect(() => { if (!open) setView('metrics'); }, [open]);
  const mask = (v: string): string => (hideBalance ? '••••' : v);
  const money = (n: number | null): string => (n === null ? '—' : mask(fmtMoney(n)));
  // The rows fall back to the wallet's free figure while equity is unknown (Trade.jsx).
  const balanceN = walletFree;

  return (
    <BottomSheet open={open} onClose={onClose} title={view === 'metrics' ? (account?.nickname || account?.accountNumber || 'Account') : 'Accounts'} testID="account-menu">
      {view === 'metrics' ? (
        <View style={s.menu}>
          <MetricRow label="Balance" value={money(figures.balance ?? balanceN)} />
          <MetricRow label="Equity" value={money(figures.equity ?? balanceN)} />
          <MetricRow label="Margin" value={money(figures.used ?? 0)} />
          <MetricRow label="Free margin" value={money(figures.free ?? balanceN)} />
          <MetricRow label="Margin level" value={figures.marginLevel !== null ? `${mask(fmtNum(figures.marginLevel, 2))}%` : '—'} />
          <MetricRow label="Account leverage" value={leverageText(leverage ?? account?.leverage ?? 100)} />
          <View style={s.quick}>
            <Pressable accessibilityRole="button" onPress={onWithdraw} style={s.quickBtn}>
              <View style={[s.circle, { borderColor: t.colors.borderDark, backgroundColor: t.colors.bgHover }]}><AppText variant="bodyStrong">↑</AppText></View>
              <AppText variant="caption">Withdraw</AppText>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={onDeposit} style={s.quickBtn}>
              <View style={[s.circle, { borderColor: t.colors.borderDark, backgroundColor: t.colors.bgHover }]}><AppText variant="bodyStrong">↓</AppText></View>
              <AppText variant="caption">Deposit</AppText>
            </Pressable>
          </View>
          <View style={[s.divider, { backgroundColor: t.colors.borderSubtle }]} />
          <View style={s.link}>
            <AppText variant="small">Hide balance</AppText>
            <Toggle value={hideBalance} onValueChange={onHideBalance} accessibilityLabel="Hide balance" />
          </View>
          <MenuLink label="Transaction History" onPress={onHistory} />
          <MenuLink label="Download Trading Log" onPress={onHistory} />
          <View style={[s.divider, { backgroundColor: t.colors.borderSubtle }]} />
          <MenuLink label="Switch account" strong onPress={() => setView('switch')} />
        </View>
      ) : (
        <View style={s.menu}>
          <MenuLink label="‹ Back" onPress={() => setView('metrics')} />
          {accounts.map((a) => {
            const on = a.id === account?.id;
            const demo = isDemoLike(a.accountType);
            const name = a.nickname || a.accountNumber || '—';
            const bal = (on ? walletFree : null) ?? balances[a.id] ?? null;
            return (
              <Pressable
                key={a.id}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => { onSelectAccount(a.id); onClose(); }}
                style={[s.acct, { backgroundColor: on ? alpha(t.colors.primary, 0.1) : 'transparent' }]}
                testID={`account-row-${a.id}`}
              >
                <View style={s.flex1}>
                  <AppText variant="smallStrong" numberOfLines={1}>{name}</AppText>
                  {a.accountNumber && a.accountNumber !== name ? (
                    <AppText variant="micro" mono tone="muted" numberOfLines={1}>{a.accountNumber}</AppText>
                  ) : null}
                  <View style={s.pills}>
                    <View style={[s.tag, { backgroundColor: demo ? '#fef3c7' : '#d1fae5' }]}>
                      <AppText variant="micro" weight="700" color={demo ? '#b45309' : '#047857'}>{demo ? 'DEMO' : 'REAL'}</AppText>
                    </View>
                    <View style={[s.tag, { backgroundColor: alpha(t.colors.primary, 0.1) }]}>
                      <AppText variant="micro" weight="700" tone="brand">{accountTierLabel(a).toUpperCase()}</AppText>
                    </View>
                  </View>
                </View>
                <View style={s.alignEnd}>
                  <AppText variant="smallStrong" mono>{mask(fmtMoney(bal !== null && Number.isFinite(bal) ? bal : 0))}</AppText>
                </View>
                {on ? <AppText variant="bodyStrong" tone="brand">✓</AppText> : null}
              </Pressable>
            );
          })}
        </View>
      )}
    </BottomSheet>
  );
}

/* ── Equity strip ── */

function Stat({ label, value, color }: { label: string; value: string; color?: string }): React.JSX.Element {
  return (
    <View style={s.stat}>
      <AppText variant="micro" weight="700" tone="secondary" style={s.caps}>{label.toUpperCase()}</AppText>
      <AppText variant="caption" mono weight="700" color={color} numberOfLines={1}>{value}</AppText>
    </View>
  );
}

export function EquityBar({ figures }: { figures: EquityFigures }): React.JSX.Element {
  const t = useTheme();
  const m = (n: number | null): string => (n === null ? '—' : fmtMoney(n));
  return (
    <View style={[s.equity, { borderColor: t.colors.borderDark, backgroundColor: t.colors.bgCard }]} testID="equity-bar">
      <Stat label="Equity" value={m(figures.equity)} />
      <Stat label="Balance" value={m(figures.balance)} />
      <Stat label="Free Margin" value={m(figures.free)} />
      <Stat label="Margin" value={m(figures.used)} />
      <Stat
        label="Margin Level"
        value={figures.marginLevel !== null ? `${figures.marginLevel.toFixed(2)}%` : '—'}
        color={figures.marginLevel !== null && figures.marginLevel < 100 ? '#DC2626' : undefined}
      />
    </View>
  );
}

const s = StyleSheet.create({
  flex1: { flex: 1 },
  alignEnd: { alignItems: 'flex-end' },
  pills: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  caps: { letterSpacing: 0.6 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  form: { gap: 12 },
  two: { flexDirection: 'row', gap: 10 },
  field: { gap: 6 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, fontVariant: ['tabular-nums'] },
  menu: { gap: 2 },
  metric: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 7 },
  quick: { flexDirection: 'row', justifyContent: 'center', gap: 40, paddingVertical: 12 },
  quickBtn: { alignItems: 'center', gap: 6 },
  circle: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 6 },
  link: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 11 },
  acct: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingVertical: 10, borderRadius: 8 },
  equity: { flexDirection: 'row', flexWrap: 'wrap', borderTopWidth: 1, paddingHorizontal: 12, paddingVertical: 8, rowGap: 6 },
  stat: { width: '50%', gap: 1 },
});
