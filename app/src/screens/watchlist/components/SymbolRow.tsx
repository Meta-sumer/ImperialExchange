import React, { memo } from 'react';
import { Pressable, View } from 'react-native';

import { AppText, AssetIcon } from '@/components/ui';
import { WatchIcon } from '@/components/watchlist/WatchlistIcons';
import type { DragA11yProps } from '@/components/watchlist/DraggableList';
import { changeOf, changeTone, fmtChange, fmtWatchPrice } from '@/components/watchlist/watchlistLogic';
import { makeStyles, useTheme } from '@/theme';
import type { WatchlistItem } from '@/types/market';
import type { Instrument } from '@/types/trading';

/**
 * One symbol card — Watchlist.jsx SymbolRow, as the web draws it on a phone:
 * grip, icon, symbol (with the pin mark) and name, the live price and the
 * 24h change, and the ⋮ actions. (The sparkline and the Trade button are
 * `hidden sm:…` on the web; Trade lives in the ⋮ sheet here.)
 *
 * A long press anywhere on the card but the ⋮ lifts it (`dragArea`).
 */
export const SymbolRow = memo(function SymbolRow({
  item,
  row,
  lifted = false,
  dragArea,
  a11yProps,
  onMenu,
}: {
  item: WatchlistItem;
  row: Instrument | null;
  lifted?: boolean;
  dragArea: (node: React.ReactNode) => React.ReactElement;
  a11yProps?: DragA11yProps;
  onMenu: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const s = useStyles();
  const change = changeOf(row);
  const tone = changeTone(change);

  return (
    <View
      style={[s.card, {
        borderColor: lifted ? t.colors.primary : t.colors.borderDark,
        backgroundColor: t.colors.surface,
      }, lifted ? s.lifted : null]}
    >
      {dragArea(
        <View style={s.body}>
          <View
            accessible
            accessibilityLabel={`Reorder ${item.symbol}`}
            accessibilityHint="Long press and drag to reorder"
            {...a11yProps}
            style={s.grip}
          >
            <WatchIcon name="grip" size={14} color={t.alpha(t.colors.textMuted, 0.6)} />
          </View>
          <AssetIcon row={row ?? { symbol: item.symbol }} size={36} round />
          <View style={s.names}>
            <View style={s.symLine}>
              <AppText variant="bodyStrong" weight="700" numberOfLines={1} style={s.sym}>{item.symbol}</AppText>
              {item.pinned ? <WatchIcon name="pin" size={11} color="#3B82F6" filled /> : null}
            </View>
            <AppText variant="caption" tone="muted" numberOfLines={1}>{row?.name ?? ''}</AppText>
          </View>
          <View style={s.price}>
            <AppText variant="bodyStrong" weight="700" mono numberOfLines={1}>
              {fmtWatchPrice(row?.lastPrice, row?.pricePrecision, row?.quoteCurrency)}
            </AppText>
            <AppText variant="caption" weight="700" mono color={tone}>{fmtChange(change)}</AppText>
          </View>
        </View>,
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Actions for ${item.symbol}`}
        hitSlop={8}
        onPress={onMenu}
        style={({ pressed }) => [s.menu, pressed ? { backgroundColor: t.colors.bgHover } : null]}
      >
        <WatchIcon name="dotsVertical" size={16} color={t.colors.textMuted} />
      </Pressable>
    </View>
  );
});

const useStyles = makeStyles((t) => ({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: t.radius.xl,
    paddingLeft: 12,
    paddingRight: 6,
  },
  lifted: { shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  body: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, minWidth: 0 },
  grip: { paddingVertical: 4 },
  names: { flex: 1, minWidth: 0 },
  symLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sym: { flexShrink: 1 },
  price: { alignItems: 'flex-end', minWidth: 92 },
  menu: { padding: 6, borderRadius: t.radius.md, marginLeft: 4 },
}));
