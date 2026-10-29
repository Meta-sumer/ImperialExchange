import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { withLiveQuote } from '@/api/market.api';
import { AppText, AssetIcon, BottomSheet, useConfirm } from '@/components/ui';
import { selectSelectedAccount, useSelectedAccountStore } from '@/store/selectedAccount';
import { useTheme } from '@/theme';
import type { Instrument, Order } from '@/types/trading';
import { drawerPrice } from '@/utils/orderForm';

import { OrderForm } from './OrderForm';
import { useCoalescedTicker, useScreenFocused } from './orderForm/hooks';

/**
 * The order form in a bottom sheet, for the selected trading account —
 * StockDetail.jsx's mobile trade drawer (its header: icon, symbol, last
 * price, close) with the same OrderForm inside, and its two placeholder
 * states: "No trading account found." with no accounts, "Loading order
 * form…" until the account and instrument are there.
 *
 * What the sheet adds for a phone:
 *   • The price is LIVE: the instrument's ticker is subscribed while the
 *     sheet is open and its screen focused, coalesced to one update per
 *     300 ms, and released on close / blur / unmount. (The web drawer
 *     showed the instrument as it was fetched.)
 *   • The sheet closes when its screen loses focus — an overlay must not
 *     follow the trader onto the next screen.
 *   • The screen's confirm is handed to the form: sheet content renders in
 *     the overlay layer, outside the ConfirmProvider.
 *
 * Each open starts a fresh form (the sheet unmounts its content on close),
 * on `side` when given.
 */
export interface OrderSheetProps {
  visible: boolean;
  onClose: () => void;
  instrument: Instrument | null;
  side?: 'BUY' | 'SELL';
  onPlaced?: (order: Order) => void;
}

/** Which placeholder the sheet shows instead of the form, if any. Exported for tests. */
export const orderSheetState = (p: {
  instrument: Instrument | null;
  hasAccount: boolean;
  accountCount: number;
  accountsLoading: boolean;
}): 'form' | 'noAccount' | 'loading' => {
  if (p.instrument && p.hasAccount) return 'form';
  // The web says "No trading account found." whenever its list is empty —
  // including while the list is still loading. Here the store knows.
  if (p.accountCount === 0 && !p.accountsLoading) return 'noAccount';
  return 'loading';
};

export function OrderSheet({ visible, onClose, instrument, side, onPlaced }: OrderSheetProps): React.JSX.Element {
  const t = useTheme();
  const focused = useScreenFocused();
  const confirm = useConfirm();
  const account = useSelectedAccountStore(selectSelectedAccount);
  const accountCount = useSelectedAccountStore((s) => s.accounts.length);
  const accountsLoading = useSelectedAccountStore((s) => s.loading);
  const open = visible && focused;

  // Leaving the screen closes the sheet, so the parent's state agrees.
  useEffect(() => {
    if (visible && !focused) onClose();
  }, [visible, focused, onClose]);

  // The side the sheet was opened on, then the trader's.
  const [chosenSide, setChosenSide] = useState<'BUY' | 'SELL' | undefined>(side);
  useEffect(() => {
    if (visible) setChosenSide(side);
  }, [visible, side]);

  const tick = useCoalescedTicker(instrument?.symbol, open);
  const live = useMemo(() => (instrument ? withLiveQuote(instrument, tick) : null), [instrument, tick]);
  const state = orderSheetState({ instrument: live, hasAccount: !!account, accountCount, accountsLoading });

  const title = live ? (
    <View style={s.head}>
      <AssetIcon row={live} size={26} round />
      <View style={s.headText}>
        <AppText variant="bodyStrong" numberOfLines={1}>{live.symbol}</AppText>
        <AppText variant="caption" tone="muted" mono>{drawerPrice(live)}</AppText>
      </View>
    </View>
  ) : undefined;

  return (
    <BottomSheet open={open} onClose={onClose} title={title} bodyPadding={0} testID="order-sheet">
      {state === 'form' && live && account ? (
        <OrderForm
          instrument={live}
          account={account}
          onPlaced={onPlaced}
          side={chosenSide}
          onSideChange={(sd) => setChosenSide(sd ?? undefined)}
          confirm={confirm}
        />
      ) : (
        <View style={s.placeholder}>
          <AppText variant="small" color={t.colors.textMuted} align="center">
            {state === 'noAccount' ? 'No trading account found.' : 'Loading order form…'}
          </AppText>
        </View>
      )}
    </BottomSheet>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  headText: { flexShrink: 1, minWidth: 0 },
  placeholder: { padding: 24 },
});
