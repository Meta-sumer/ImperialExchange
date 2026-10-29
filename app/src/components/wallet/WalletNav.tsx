import React, { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { AppText } from '@/components/ui';
import { useAppNavigation } from '@/navigation/types';
import { useTheme } from '@/theme';
import { WALLET_NAV_ITEMS, type WalletNavItem, type WalletViewId } from '@/utils/walletLogic';

/* ══ Glyphs ══════════════════════════════════════════════════════════════
 * The wallet pages' inline stroke icons, copied from the web
 * (Wallet.jsx NI*, AccountOverview.jsx Ic*, TransactionHistory.jsx
 * categoryIcon, WalletSidebar.jsx). The kit's Icon set is the chrome's;
 * these belong to the wallet area and live beside its rail.
 *
 * A spec is a list of SVG elements in a 24×24 box:
 *   'M…'                 a path
 *   'c:cx,cy,r'          a circle
 *   'r:x,y,w,h,rx'       a rounded rect
 * ─────────────────────────────────────────────────────────────────────── */

const G = {
  // Wallet.jsx:601-611 / WalletSidebar.jsx — the rail.
  navDetails: ['c:12,8,4', 'M4 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2'],
  navOverview: ['c:12,12,9', 'M9 12h6', 'M12 9v6'],
  navDeposit: ['c:12,12,9', 'M8 12l4-4 4 4', 'M12 16V8'],
  navWithdraw: ['c:12,12,9', 'M8 12l4 4 4-4', 'M12 8v8'],
  navTransfer: ['M7 17l-4-4 4-4', 'M3 13h13', 'M17 7l4 4-4 4', 'M21 11H8'],
  navHistory: ['c:12,12,9', 'M12 6v6l4 2'],
  navBonus: ['r:3,8,18,13,2', 'M3 12h18', 'M12 8v13', 'M12 8s-3-5-5-3 1 3 5 3z', 'M12 8s3-5 5-3-1 3-5 3z'],
  navMethods: ['r:2,6,20,14,2', 'M2 10h20'],
  // AccountOverview.jsx:561-575.
  plus: ['M12 5v14M5 12h14'],
  /** IcDown up — money coming in. */
  moneyIn: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 21h16'],
  /** IcDown — money going out. */
  moneyOut: ['M12 21V9', 'M7 14l5 5 5-5', 'M4 3h16'],
  swap: ['M7 7h11l-3-3', 'M17 17H6l3 3'],
  wallet: ['r:2,6,20,14,2', 'M2 10h20', 'c:17,15,1.3'],
  gift: ['r:3,8,18,13,2', 'M12 8v13M3 12h18', 'M12 8S9 3 7 4.5 8 8 12 8z', 'M12 8s3-5 5-3.5S16 8 12 8z'],
  chart: ['M3 3v18h18', 'M7 14l4-4 4 4 5-7'],
  users: ['c:9,8,3.5', 'M3 21v-1.5A4.5 4.5 0 0 1 7.5 15h3A4.5 4.5 0 0 1 15 19.5V21', 'M16 4a3.5 3.5 0 0 1 0 7', 'M18 15a4.5 4.5 0 0 1 3 4.5V21'],
  arrow: ['M5 12h14M13 6l6 6-6 6'],
  clock: ['c:12,12,9', 'M12 7v5l3 2'],
  trend: ['M3 17l6-6 4 4 8-8', 'M14 7h7v7'],
  lock: ['r:4,11,16,9,2', 'M8 11V7a4 4 0 0 1 8 0v4'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
  layers: ['M12 3l9 5-9 5-9-5 9-5z', 'M3 13l9 5 9-5'],
  target: ['c:12,12,9', 'c:12,12,5', 'c:12,12,1.5'],
  // Wallet.jsx Account Details / support strip.
  pencil: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'],
  check: ['M20 6L9 17l-5-5'],
  close: ['M18 6L6 18', 'M6 6l12 12'],
  cardWallet: ['r:2,6,20,14,2', 'M2 10h20', 'M6 16h4'],
  arrowRight: ['M5 12h14M13 5l7 7-7 7'],
  chat: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  mail: ['r:2,4,20,16,2', 'M22 6l-10 7L2 6'],
  // TransactionHistory.jsx — filters and row actions.
  calendar: ['r:3,4,18,18,2', 'M16 2v4M8 2v4M3 10h18'],
  typeFilter: ['M4 6h16M7 12h10M10 18h4'],
  statusPie: ['c:12,12,9', 'M12 3a9 9 0 0 1 9 9h-9z'],
  walletSmall: ['r:2,6,20,13,2', 'M2 10h20', 'c:17,14.5,1.2'],
  search: ['c:11,11,8', 'M21 21l-4.3-4.3'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  copy: ['r:9,9,13,13,2', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  eye: ['M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z', 'c:12,12,3'],
  chevronDown: ['M6 9l6 6 6-6'],
  chevronLeft: ['M15 18l-6-6 6-6'],
  chevronRight: ['M9 18l6-6-6-6'],
  // TransactionHistory.jsx:305 categoryIcon.
  catDeposit: ['M12 3v11', 'M8 10l4 4 4-4', 'M4 21h16'],
  catWithdrawal: ['r:2,6,20,13,2', 'M2 10h20', 'M12 13v6', 'M9 16l3 3 3-3'],
  catTransferInternal: ['M7 7h12l-3-3', 'M17 17H5l3 3'],
  catTransferExternal: ['M4 12a8 8 0 0 1 13-6', 'M17 3v3h-3', 'M20 12a8 8 0 0 1-13 6', 'M7 21v-3h3'],
  catWalletToAccount: ['M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1', 'M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1'],
  catAccountToWallet: ['M17 7H5l3-3', 'M7 17h12l-3 3'],
  catWalletToWallet: ['M7 7h12l-3-3', 'M17 17H5l3 3', 'c:4,8,1', 'c:20,16,1'],
  catTradeOpen: ['M3 17l6-6 4 4 8-8', 'M14 7h7v7'],
  catTradeClose: ['M3 7l6 6 4-4 8 8', 'M14 17h7v-7'],
  catFee: ['c:12,12,9', 'M15 9.3c-.6-.9-1.7-1.3-3-1.3-1.7 0-3 .8-3 2s1.3 1.8 3 2 3 .9 3 2-1.3 2-3 2c-1.3 0-2.4-.5-3-1.4', 'M12 6.5v11'],
  catCommission: ['c:12,12,3.2', 'M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1l2.1-2.1M17 7l2.1-2.1'],
  catCharge: ['c:12,12,9', 'M12 7v5l3 2'],
  catInvestment: ['M3 3v18h18', 'M7 14l4-4 3 3 5-6'],
  catReferral: ['r:2,7,20,14,2', 'M2 11h20', 'c:7,16,1'],
  catSubscription: ['r:2,5,20,14,2', 'M2 10h20', 'M6 15h5'],
  catOthers: ['c:5,12,1.6', 'c:12,12,1.6', 'c:19,12,1.6'],
} as const satisfies Record<string, readonly string[]>;

export type WalletGlyphName = keyof typeof G;

const nums = (s: string): number[] => s.split(',').map(Number);

export function WalletGlyph({
  name,
  size = 16,
  color,
  strokeWidth = 1.8,
}: {
  name: WalletGlyphName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}): React.JSX.Element {
  const t = useTheme();
  const stroke = color ?? t.colors.textSecondary;
  const common = { stroke, strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {G[name].map((spec, i) => {
        if (spec.startsWith('c:')) {
          const [cx = 0, cy = 0, r = 0] = nums(spec.slice(2));
          return <Circle key={i} cx={cx} cy={cy} r={r} {...common} />;
        }
        if (spec.startsWith('r:')) {
          const [x = 0, y = 0, w = 0, h = 0, rx = 0] = nums(spec.slice(2));
          return <Rect key={i} x={x} y={y} width={w} height={h} rx={rx} {...common} />;
        }
        return <Path key={i} d={spec} {...common} />;
      })}
    </Svg>
  );
}

/** TransactionHistory.jsx:305 — a category's leading icon. */
export const categoryGlyph = (label: string): WalletGlyphName => {
  switch (label) {
    case 'Deposit': return 'catDeposit';
    case 'Withdrawal': return 'catWithdrawal';
    case 'Transfer - Internal': return 'catTransferInternal';
    case 'Transfer - External': return 'catTransferExternal';
    case 'Transfer - Wallet to Account': return 'catWalletToAccount';
    case 'Transfer - Account to Wallet': return 'catAccountToWallet';
    case 'Transfer - Wallet to Wallet': return 'catWalletToWallet';
    case 'Trade Open': return 'catTradeOpen';
    case 'Trade Close': return 'catTradeClose';
    case 'Fee': return 'catFee';
    case 'Commission': return 'catCommission';
    case 'Charge': return 'catCharge';
    case 'Investment': return 'catInvestment';
    case 'Main Wallet': return 'gift';
    case 'Referral Commission Earned':
    case 'Referral Deposit Bonus': return 'catReferral';
    case 'Subscription': return 'catSubscription';
    default: return 'catOthers';
  }
};

const NAV_GLYPH: Record<WalletViewId, WalletGlyphName> = {
  details: 'navDetails',
  overview: 'navOverview',
  grow: 'navDeposit',
  withdraw: 'navWithdraw',
  // WalletSidebar.jsx NIMethods.
  'withdrawal-methods': 'navMethods',
  transfer: 'navTransfer',
  bonus: 'navBonus',
  history: 'navHistory',
};

/* ══ The rail ════════════════════════════════════════════════════════════ */

/**
 * The web's WalletSidebar (NAV_ITEMS, which Wallet.jsx renders too) as the
 * horizontal pill rail the web itself shows below `lg`
 * (`flex-row overflow-x-auto no-scrollbar`).
 *
 *   onSelect given   → items call it (the Wallet hub switches its view, or
 *                      — for Withdrawal Methods — opens the manager).
 *   onSelect omitted → items open the Wallet on that view
 *                      (`/wallet?view=<id>`, which the Wallet honours).
 *
 * The Bonus Wallet is a page of its own and always navigates,
 * in either mode. The web's "Need Help?" and "100% Secure" cards are
 * `hidden lg:block` — never shown at phone width — so they are not drawn.
 *
 * Like the app's pill rail (chrome/PillRail), a rail tap goes BACK to its
 * destination when that screen is already in the stack (`pop: true`)
 * instead of stacking another copy: bouncing Wallet → Bonus Wallet → Wallet
 * would otherwise leave two mounted Wallets, each reloading on every
 * wallet event. The Wallet re-reads when it is come back to.
 */
export function WalletNav({
  activeId,
  onSelect,
}: {
  activeId: WalletViewId | null;
  onSelect?: (id: WalletViewId) => void;
}): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  const scrollRef = useRef<ScrollView>(null);
  const xs = useRef<Partial<Record<WalletViewId, number>>>({});
  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  const reveal = (x: number, animated: boolean): void => {
    scrollRef.current?.scrollTo({ x: Math.max(0, x - 24), animated });
  };

  // Keep the active pill in view — a deep link can land on the last one.
  useEffect(() => {
    if (!activeId) return;
    const x = xs.current[activeId];
    if (x !== undefined) reveal(x, true);
  }, [activeId]);

  // On the first mount the effect above runs before the pills are laid out,
  // so it has no position to scroll to; the active pill reveals itself when
  // its layout arrives.
  const onItemLayout = (id: WalletViewId, x: number): void => {
    const first = xs.current[id] === undefined;
    xs.current[id] = x;
    if (first && id === activeRef.current) reveal(x, false);
  };

  const press = (id: WalletViewId, route: WalletNavItem['route']): void => {
    if (route === 'BonusWallet') { nav.navigate('BonusWallet', undefined, { pop: true }); return; }
    if (onSelect) { onSelect(id); return; }
    nav.navigate('Wallet', { view: id }, { pop: true });
  };

  return (
    <View
      style={[
        styles.bar,
        { backgroundColor: t.colors.surface, borderColor: t.colors.borderDark, borderRadius: t.radius.xxl },
      ]}
    >
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        accessibilityRole="tablist"
      >
        {WALLET_NAV_ITEMS.map((item) => {
          const active = activeId === item.id;
          const fg = active ? t.colors.primaryText : t.colors.textSecondary;
          return (
            <Pressable
              key={item.id}
              accessibilityRole={item.route ? 'link' : 'tab'}
              accessibilityState={{ selected: active }}
              accessibilityLabel={item.label}
              onLayout={(e) => onItemLayout(item.id, e.nativeEvent.layout.x)}
              onPress={() => press(item.id, item.route)}
              style={({ pressed }) => [
                styles.item,
                {
                  borderRadius: t.radius.xl,
                  backgroundColor: active ? t.colors.primarySoft : pressed ? t.colors.bgHover : 'transparent',
                },
              ]}
            >
              <WalletGlyph name={NAV_GLYPH[item.id]} size={16} color={active ? t.colors.primaryText : t.colors.textMuted} />
              <AppText variant="body" color={fg} weight={active ? '700' : '500'} numberOfLines={1} style={styles.label}>
                {item.label}
              </AppText>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderWidth: 1, padding: 8, marginBottom: 16 },
  row: { gap: 4 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  label: { fontSize: 13 },
});
