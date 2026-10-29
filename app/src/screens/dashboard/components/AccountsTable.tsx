import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { closeAllPositions } from '@/api/trading.api';
import { AppText, AssetIcon, Badge, toast, useConfirm } from '@/components/ui';
import { useAppNavigation } from '@/navigation/types';
import { useTheme } from '@/theme';
import type { UserAccount } from '@/types/user';
import { EMPTY, fmtMoney, fmtNum, fmtPrice, fmtSigned } from '@/utils/money';
import {
  accountRows,
  accountScopeOptions,
  accountShortLabel,
  accountTileText,
  accountTypeLabel,
  closeAllConfirmText,
  closeAllFailureText,
  closeAllOutcome,
  liveDemoCounts,
  positionKey,
  positionPercents,
  positionSubtitle,
  signedPct,
  type AccountRow,
  type AccountScope,
  type LivePosition,
} from '@/utils/dashboard';

import { Glyph } from './Glyph';
import { Eyebrow, ScopePicker, Section, TINT, tint } from './shared';

/**
 * "Your Trading Accounts" — Dashboard.jsx AccountsTable (:1571-1796): the
 * Live / Demo counts, the account filter, one row per account (Balance,
 * Equity, P&L (Floating), P&L %, Today's P&L, Open, View), and a row that
 * expands to its open positions with "Close All Positions".
 *
 * The web's nine-column table becomes one card per account. The figures are
 * the web's, all rupees with no conversion: the balance is the account's
 * /wallet/balances rows summed, the floating P&L its open positions at the
 * live marks, equity = balance + floating, P&L % of the balance. A balance
 * not in yet reads "—" (and so do equity and P&L %), not ₹0.00.
 *
 * Close All posts POST /trading/positions/close-all { accountId } after the
 * web's confirm, word for word. The positions list refreshes itself on the
 * `user:positions` events the closes publish.
 */
export function AccountsTable({
  accounts,
  positions,
  balances,
  todayByAccount,
}: {
  accounts: readonly UserAccount[];
  positions: readonly LivePosition[];
  /** /wallet/balances rows; null until the read answers. */
  balances: readonly { accountId: string; balance: unknown }[] | null;
  todayByAccount: Readonly<Record<string, number>>;
}): React.JSX.Element {
  const t = useTheme();
  const [scope, setScope] = useState<AccountScope>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const confirm = useConfirm();

  const { live, demo } = liveDemoCounts(accounts);
  const options = useMemo(() => accountScopeOptions(accounts), [accounts]);
  const rows = useMemo(
    () => accountRows({ accounts, scope, balances, positions, todayByAccount }),
    [accounts, scope, balances, positions, todayByAccount],
  );

  const closeAll = async (acc: UserAccount): Promise<void> => {
    const label = accountShortLabel(acc);
    const ok = await confirm({
      title: 'Close All Positions',
      message: closeAllConfirmText(label),
      confirmText: 'Close All Positions',
      danger: true,
    });
    if (!ok) return;
    setClosing(acc.id);
    try {
      const outcome = closeAllOutcome(await closeAllPositions(acc.id));
      if (outcome.ok) toast.success(outcome.message);
      else toast.error(outcome.message);
    } catch (e) {
      toast.error(closeAllFailureText(errorMessage(e)));
    } finally {
      setClosing(null);
    }
  };

  return (
    <Section testID="dashboard-accounts" padded={false} style={styles.gapBelow}>
      <View style={[styles.head, { borderBottomColor: t.colors.borderSubtle }]}>
        <View>
          <Eyebrow>Wallet</Eyebrow>
          <AppText variant="bodyStrong" weight="700" style={styles.headTitle}>Accounts</AppText>
        </View>
        <View style={styles.headRight}>
          <Count n={live} label="Live" />
          <Count n={demo} label="Demo" />
          <ScopePicker options={options} value={scope} onChange={setScope} maxLabelWidth={110} />
        </View>
      </View>

      {rows.length === 0 ? (
        <AppText variant="small" tone="muted" align="center" style={styles.none}>No accounts</AppText>
      ) : (
        // One card per account — bounded by the plan's account cap, so a
        // plain column inside the page scroll.
        rows.map((row) => (
          <AccountCard
            key={row.account.id}
            row={row}
            open={expandedId === row.account.id}
            closing={closing === row.account.id}
            onToggle={() => setExpandedId(expandedId === row.account.id ? null : row.account.id)}
            onCloseAll={() => { void closeAll(row.account); }}
          />
        ))
      )}
    </Section>
  );
}

function Count({ n, label }: { n: number; label: string }): React.JSX.Element {
  return (
    <View style={styles.countBox} accessible accessibilityLabel={`${n} ${label}`}>
      <AppText variant="h3" mono weight="700">{String(n)}</AppText>
      <AppText variant="micro" tone="muted" weight="700" style={styles.upperSm}>{label}</AppText>
    </View>
  );
}

function AccountCard({
  row,
  open,
  closing,
  onToggle,
  onCloseAll,
}: {
  row: AccountRow;
  open: boolean;
  closing: boolean;
  onToggle: () => void;
  onCloseAll: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  const a = row.account;
  // The web's <Both>: money(n), or with `colored` a '+' on n >= 0 — signed().
  const money = (v: number | null): string => (v === null ? EMPTY : fmtMoney(v));
  const pnlColor = (v: number | null): string | undefined =>
    (v === null ? undefined : v >= 0 ? t.colors.bull : t.colors.bear);
  const pctText = row.pct === null ? EMPTY : signedPct(row.pct);
  const label = accountShortLabel(a);

  return (
    <View
      testID={`dashboard-account-${a.id}`}
      style={[styles.account, { borderBottomColor: t.colors.borderSubtle, backgroundColor: open ? t.colors.bgHover : 'transparent' }]}
    >
      <View style={styles.accTop}>
        <View style={[styles.tile, { backgroundColor: tint(TINT.navy, 0.08) }]}>
          <AppText variant="caption" weight="700" color={TINT.navy}>{accountTileText(a)}</AppText>
        </View>
        <View style={styles.flex}>
          <View style={styles.accNameRow}>
            <AppText variant="smallStrong" weight="700" numberOfLines={1} style={styles.shrink}>{label}</AppText>
            <Badge label={row.demo ? 'Demo' : 'Live'} tone={row.demo ? 'demo' : 'live'} size="xs" />
          </View>
          <AppText variant="micro" tone="muted" numberOfLines={1}>{a.nickname || 'Trading Account'}</AppText>
        </View>
        <AppText variant="caption" tone="secondary" numberOfLines={1} style={styles.type}>{accountTypeLabel(a)}</AppText>
      </View>

      <View style={styles.figures}>
        <Figure label="Balance" value={money(row.balance)} />
        <Figure label="Equity" value={money(row.equity)} />
        <Figure label="P&L (Floating)" value={fmtSigned(row.floating)} color={pnlColor(row.floating)} />
        <Figure label="P&L %" value={pctText} color={pnlColor(row.pct)} />
        <Figure label="Today's P&L" value={fmtSigned(row.today)} color={pnlColor(row.today)} />
        <Figure label="Open" value={String(row.openN)} />
      </View>

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`View ${label} in Wallet`}
          onPress={() => nav.navigate('Wallet', undefined, { pop: true })}
          style={({ pressed }) => [styles.viewBtn, { borderColor: t.colors.borderDark, backgroundColor: pressed ? t.colors.bgHover : 'transparent' }]}
        >
          <AppText variant="caption" weight="600" color={t.colors.primaryText}>View</AppText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={open ? 'Hide positions' : 'Show open positions'}
          accessibilityState={{ disabled: row.openN === 0, expanded: open }}
          disabled={row.openN === 0}
          onPress={onToggle}
          style={({ pressed }) => [
            styles.toggle,
            { borderColor: t.colors.borderDark, opacity: row.openN === 0 ? 0.4 : 1, backgroundColor: pressed ? t.colors.bgHover : 'transparent' },
          ]}
        >
          <Glyph name={open ? 'caretUp' : 'caretDown'} size={14} color={t.colors.textSecondary} />
        </Pressable>
      </View>

      {open ? (
        <View style={[styles.expanded, { borderTopColor: t.colors.borderSubtle }]} testID={`dashboard-account-expanded-${a.id}`}>
          <View style={styles.expHead}>
            <View style={[styles.bar, { backgroundColor: t.colors.primaryText }]} />
            <AppText variant="small" weight="700" style={styles.flex}>
              {`${label} - ${a.nickname || 'Trading Account'} · Open Positions (${row.openN})`}
            </AppText>
          </View>
          <View style={styles.expTotals}>
            <AppText variant="caption" tone="muted">Total Floating P&amp;L</AppText>
            <AppText variant="small" mono weight="700" color={pnlColor(row.floating)}>
              {`${fmtSigned(row.floating)} (${pctText})`}
            </AppText>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: closing || row.openN === 0, busy: closing }}
            disabled={closing || row.openN === 0}
            onPress={onCloseAll}
            style={({ pressed }) => [
              styles.closeAll,
              {
                borderColor: t.alpha(t.colors.bear, 0.4),
                backgroundColor: pressed ? t.alpha(t.colors.bear, 0.05) : t.colors.surface,
                opacity: closing || row.openN === 0 ? 0.5 : 1,
              },
            ]}
          >
            <AppText variant="caption" weight="600" color={t.colors.bear}>{closing ? 'Closing…' : 'Close All Positions'}</AppText>
          </Pressable>

          {row.positions.length === 0 ? (
            <AppText variant="small" tone="muted" align="center" style={styles.none}>No open positions on this account</AppText>
          ) : (
            <FlatList
              horizontal
              data={row.positions}
              keyExtractor={(lp) => positionKey(lp.position)}
              renderItem={({ item }) => <MiniPositionCard lp={item} />}
              ItemSeparatorComponent={Gap}
              showsHorizontalScrollIndicator={false}
              initialNumToRender={3}
              windowSize={5}
              style={styles.miniList}
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

const Gap = (): React.JSX.Element => <View style={styles.gap} />;

function Figure({ label, value, color }: { label: string; value: string; color?: string }): React.JSX.Element {
  return (
    <View style={styles.figure} accessible accessibilityLabel={`${label}: ${value}`}>
      <AppText variant="micro" tone="muted" weight="700" style={styles.upperSm} numberOfLines={1}>{label}</AppText>
      <AppText variant="small" mono weight="700" color={color} numberOfLines={1} adjustsFontSizeToFit>{value}</AppText>
    </View>
  );
}

/** MiniPositionCard — Dashboard.jsx:1516-1568. P&L is `signed()`, rupees, unconverted. */
function MiniPositionCard({ lp }: { lp: LivePosition }): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  const p = lp.position;
  const { movePct } = positionPercents(lp);
  const win = lp.pnl >= 0;
  const tone = win ? TINT.green : TINT.red;
  const sideTone = lp.long ? TINT.green : TINT.red;
  return (
    <View style={[styles.mini, { backgroundColor: t.colors.surface, borderColor: t.colors.borderDark }]} testID={`dashboard-mini-${p.symbol}`}>
      <View style={styles.miniTop}>
        <AssetIcon row={lp.instrument ?? { symbol: p.symbol, category: lp.category }} size={26} round />
        <View style={styles.flex}>
          <View style={styles.accNameRow}>
            <AppText variant="small" weight="700" numberOfLines={1} style={styles.shrink}>{p.symbol}</AppText>
            <View style={[styles.miniSide, { backgroundColor: tint(sideTone, 0.08) }]}>
              <AppText variant="micro" weight="700" color={lp.long ? TINT.greenText : TINT.redText} style={styles.miniSideText}>
                {lp.long ? '▲ Long' : '▼ Short'}
              </AppText>
            </View>
          </View>
          <AppText variant="micro" tone="muted" numberOfLines={1} style={styles.tinyText}>{positionSubtitle(lp.instrument, lp.category)}</AppText>
        </View>
      </View>
      <View style={styles.miniPnl}>
        <AppText variant="micro" tone="muted" weight="700" style={styles.upperXs}>{'Unrealised P&L'}</AppText>
        <View style={styles.miniPnlRow}>
          <AppText variant="bodyStrong" mono weight="700" color={tone}>{fmtSigned(lp.pnl)}</AppText>
          <View style={[styles.miniPct, { backgroundColor: tint(tone, 0.08) }]}>
            <AppText variant="micro" weight="700" color={tone} style={styles.tinyText}>{signedPct(movePct)}</AppText>
          </View>
        </View>
      </View>
      <View style={[styles.miniFoot, { borderTopColor: t.colors.borderSubtle }]}>
        <View style={styles.flex}>
          <AppText variant="micro" tone="muted" weight="700" style={styles.upperXs}>Entry</AppText>
          <AppText variant="micro" mono weight="600" tone="secondary" numberOfLines={1}>{fmtPrice(p.entryPrice, lp.prec)}</AppText>
        </View>
        <AppText variant="micro" mono weight="700" color={movePct >= 0 ? TINT.green : TINT.red} style={styles.upperXs}>{signedPct(movePct)}</AppText>
        <View style={[styles.flex, styles.right]}>
          <AppText variant="micro" tone="muted" weight="700" style={styles.upperXs}>Mark</AppText>
          <AppText variant="micro" mono weight="700" numberOfLines={1}>{fmtPrice(lp.mark, lp.prec)}</AppText>
        </View>
      </View>
      <View style={styles.miniBottom}>
        <AppText variant="micro" tone="muted" mono>{`Qty ${fmtNum(p.quantity, 2)}`}</AppText>
        <Pressable accessibilityRole="link" hitSlop={8} onPress={() => nav.navigate('Trade', { symbol: p.symbol })}>
          <AppText variant="micro" weight="600" color={t.colors.primaryText}>View Chart →</AppText>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  gapBelow: { marginBottom: 24 },
  head: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 12,
  },
  headTitle: { marginTop: 2 },
  headRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  countBox: { alignItems: 'center' },
  upperSm: { fontSize: 9, lineHeight: 12, textTransform: 'uppercase', letterSpacing: 0.4 },
  upperXs: { fontSize: 8, lineHeight: 11, textTransform: 'uppercase', letterSpacing: 0.4 },
  tinyText: { fontSize: 9, lineHeight: 12 },
  none: { paddingVertical: 32 },
  account: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  accTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  tile: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  accNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  type: { maxWidth: 120 },
  figures: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12, rowGap: 10 },
  figure: { width: '33.33%', paddingRight: 8 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 6, marginTop: 10 },
  viewBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  toggle: { width: 32, height: 32, borderWidth: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  expanded: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, gap: 10 },
  expHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bar: { width: 4, height: 16, borderRadius: 2 },
  expTotals: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  closeAll: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  miniList: { flexGrow: 0 },
  gap: { width: 12 },
  mini: { width: 220, borderWidth: 1, borderRadius: 12, padding: 12 },
  miniTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  miniSide: { borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  miniSideText: { fontSize: 8, lineHeight: 11, textTransform: 'uppercase' },
  miniPnl: { marginTop: 10 },
  miniPnlRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  miniPct: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 },
  miniFoot: { marginTop: 10, paddingTop: 8, borderTopWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  right: { alignItems: 'flex-end' },
  miniBottom: { marginTop: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
