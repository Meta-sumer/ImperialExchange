import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { HeaderBell } from '@/components/chrome/HeaderBell';
import { DraggableRail } from '@/components/watchlist/DraggableRail';
import { AppText, AssetIcon, BottomSheet, BrandLogo, Toggle } from '@/components/ui';
import { alpha, useTheme } from '@/theme';
import type { UserAccount } from '@/types/user';
import type { Instrument } from '@/types/trading';
import { accountTierLabel, isDemoLike } from '@/utils/accountType';
import { fmtMoney } from '@/utils/money';

/**
 * The terminal's own top bar — Trade.jsx's 52px bar. The app header and pill
 * rail are hidden on this route (RootNavigator), so this bar is the way out:
 * the EquityHub mark goes back to the dashboard, as on the web.
 *
 * Symbol tabs are a draggable rail (drag to reorder, × to close, the last
 * one cannot close); "+" opens the instrument picker. The account chip shows
 * EQUITY (balance + floating P&L, the same figure as the profile menu) under
 * the account name and its tier pill (amber for demo, green for live). The
 * web puts the Show-on-Chart toggles, the bell and the theme switch in the
 * bar from tablet width up and nowhere on a phone; here they live behind
 * "⋯" so a phone still has them.
 */

export interface ShowToggles { positions: boolean; tpsl: boolean; stopLimit: boolean }

export interface TradeTopBarProps {
  tabs: readonly string[];
  activeSymbol: string;
  instrumentsBySymbol: Record<string, Instrument | undefined>;
  onSelectTab: (sym: string) => void;
  onCloseTab: (sym: string) => void;
  onReorderTabs: (ordered: string[]) => void;
  onAddTab: () => void;
  account: UserAccount | null;
  /** Trade.jsx headerEquity — equity, else the wallet's free figure while it loads. */
  equity: number | null;
  hideBalance: boolean;
  onOpenAccountMenu: () => void;
  show: ShowToggles;
  onToggleShow: (key: keyof ShowToggles) => void;
  onBack: () => void;
  onDeposit: () => void;
  onOpenPanels: () => void;
  themeMode: 'light' | 'dark';
  onToggleTheme: () => void;
}

function TabPill({
  sym,
  inst,
  active,
  canClose,
  onSelect,
  onClose,
}: {
  sym: string;
  inst: Instrument | undefined;
  active: boolean;
  canClose: boolean;
  onSelect: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const change = Number(inst?.change24h);
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onSelect}
      style={[s.tab, {
        borderColor: active ? t.colors.primary : 'transparent',
        backgroundColor: active ? alpha(t.colors.primary, 0.05) : 'transparent',
      }]}
      testID={`trade-tab-${sym}`}
    >
      <AssetIcon row={inst ?? { symbol: sym }} size={18} round />
      <AppText variant="smallStrong" color={active ? t.colors.textPrimary : t.colors.textSecondary}>{sym}</AppText>
      {Number.isFinite(change) ? (
        <AppText variant="micro" weight="700" color={change >= 0 ? '#16A34A' : '#DC2626'}>{change >= 0 ? '+' : ''}{change.toFixed(2)}%</AppText>
      ) : null}
      {canClose ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Close ${sym}`} onPress={onClose} hitSlop={8} style={s.tabX} testID={`trade-tab-close-${sym}`}>
          <AppText variant="micro" weight="800" tone="muted">✕</AppText>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

function MenuToggle({ label, value, onPress }: { label: string; value: boolean; onPress: () => void }): React.JSX.Element {
  return (
    <View style={s.menuRow}>
      <AppText variant="body" style={s.flex1}>{label}</AppText>
      <Toggle value={value} onValueChange={onPress} accessibilityLabel={label} />
    </View>
  );
}

export function TradeTopBar(p: TradeTopBarProps): React.JSX.Element {
  const t = useTheme();
  const [more, setMore] = useState(false);
  const name = p.account?.nickname || p.account?.accountNumber || '—';
  const bal = p.equity === null ? '—' : fmtMoney(p.equity);
  const demo = p.account ? isDemoLike(p.account.accountType) : false;
  return (
    <View style={[s.bar, { borderBottomColor: t.colors.borderDark, backgroundColor: t.colors.surface }]} testID="trade-topbar">
      <Pressable accessibilityRole="link" accessibilityLabel="Back to dashboard" onPress={p.onBack} style={[s.brandWrap, { borderRightColor: t.colors.borderDark }]} testID="trade-back">
        <BrandLogo variant="icon" height={32} />
      </Pressable>

      <DraggableRail
        items={p.tabs}
        getId={(x) => x}
        onReorder={p.onReorderTabs}
        gap={4}
        style={s.rail}
        renderItem={(sym, info) => info.dragArea(
          <TabPill
            sym={sym}
            inst={p.instrumentsBySymbol[sym]}
            active={sym === p.activeSymbol}
            canClose={p.tabs.length > 1}
            onSelect={() => p.onSelectTab(sym)}
            onClose={() => p.onCloseTab(sym)}
          />,
        )}
        testID="trade-tabs"
      />
      <Pressable accessibilityRole="button" accessibilityLabel="Add symbol tab" onPress={p.onAddTab} style={[s.square, { borderColor: t.colors.borderDark }]} testID="trade-add-tab">
        <AppText variant="bodyStrong" tone="secondary">+</AppText>
      </Pressable>

      <Pressable accessibilityRole="button" accessibilityLabel="Account menu" onPress={p.onOpenAccountMenu} style={[s.pill, { borderColor: t.colors.borderDark }]} testID="trade-account-pill">
        <View style={s.pillText}>
          <View style={s.inline}>
            <AppText variant="micro" weight="700" numberOfLines={1} style={s.pillName}>{name}</AppText>
            {p.account?.accountType ? (
              <View style={[s.type, { backgroundColor: demo ? '#fef3c7' : '#d1fae5' }]}>
                <AppText variant="micro" weight="800" color={demo ? '#b45309' : '#047857'} style={s.typeText}>{accountTierLabel(p.account)}</AppText>
              </View>
            ) : null}
          </View>
          <AppText variant="caption" weight="800" mono numberOfLines={1}>
            {p.hideBalance ? '••••' : bal}
          </AppText>
        </View>
        <AppText variant="micro" tone="muted">▾</AppText>
      </Pressable>

      <Pressable accessibilityRole="button" accessibilityLabel="Deposit funds" onPress={p.onDeposit} style={s.deposit} testID="trade-deposit">
        <AppText variant="bodyStrong" color="#FFFFFF">+</AppText>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="More" onPress={() => setMore(true)} style={s.more} testID="trade-more">
        <AppText variant="bodyStrong" tone="secondary">⋯</AppText>
      </Pressable>

      <BottomSheet open={more} onClose={() => setMore(false)} title="Terminal" testID="trade-more-sheet">
        <AppText variant="micro" weight="700" tone="muted" style={s.caps}>SHOW ON CHART</AppText>
        <MenuToggle label="Positions" value={p.show.positions} onPress={() => p.onToggleShow('positions')} />
        <MenuToggle label="TP / SL" value={p.show.tpsl} onPress={() => p.onToggleShow('tpsl')} />
        <MenuToggle label="Pending" value={p.show.stopLimit} onPress={() => p.onToggleShow('stopLimit')} />
        <View style={[s.divider, { backgroundColor: t.colors.borderSubtle }]} />
        <View style={s.menuRow}>
          <AppText variant="body" style={s.flex1}>Notifications</AppText>
          <HeaderBell />
        </View>
        <MenuToggle label="Dark mode" value={p.themeMode === 'dark'} onPress={p.onToggleTheme} />
        <Pressable accessibilityRole="button" onPress={() => { setMore(false); p.onOpenPanels(); }} style={s.menuRow}>
          <AppText variant="body" style={s.flex1}>Panels (positions, depth, movers, settings…)</AppText>
          <AppText variant="body" tone="muted">›</AppText>
        </Pressable>
      </BottomSheet>
    </View>
  );
}

const s = StyleSheet.create({
  bar: { height: 52, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, borderBottomWidth: 1 },
  brandWrap: { paddingRight: 8, borderRightWidth: 1 },
  rail: { flex: 1, minWidth: 0 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 8, paddingRight: 4, paddingVertical: 5, borderRadius: 8, borderWidth: 1 },
  tabX: { paddingHorizontal: 4, paddingVertical: 2 },
  square: { width: 28, height: 28, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 38, paddingHorizontal: 8, borderRadius: 8, borderWidth: 1, maxWidth: 132 },
  pillText: { flexShrink: 1, minWidth: 0 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pillName: { flexShrink: 1, maxWidth: 70 },
  type: { paddingHorizontal: 4, borderRadius: 3 },
  typeText: { fontSize: 8, letterSpacing: 0.5 },
  deposit: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1D4ED8' },
  more: { width: 28, height: 34, alignItems: 'center', justifyContent: 'center' },
  caps: { letterSpacing: 1, marginBottom: 4 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  flex1: { flex: 1 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 6 },
});
