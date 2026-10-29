import React from 'react';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { useWatchlists } from '@/api/watchlist.api';
import { bookmarkHint, bookmarkLabel } from '@/components/watchlist/watchlistLogic';
import { WatchIcon } from '@/components/watchlist/WatchlistIcons';
import { useTheme } from '@/theme';
import type { Instrument } from '@/types/trading';

import { useWatchlistModal } from './WatchlistModal';

/**
 * The bookmark on every instrument card and row, for any asset class —
 * client/src/components/WatchlistButton.jsx. A press opens the shared
 * "Add to Watchlist" sheet for `symbol`; it is filled while the symbol sits
 * in ANY of the trader's lists (not only Favorites).
 *
 * On the web it is hidden on desktop until the card is hovered; a phone has
 * no hover, and the web's own mobile breakpoint shows it always — so it is
 * always shown here, and `persistent` changes nothing.
 *
 * Nested inside a pressable card it takes the touch, so the card's own
 * press ("open trade") does not fire — the web's stopPropagation.
 *
 * Variants (the web's names in brackets):
 *   'overlay'  pill with a surface, border and shadow, over card artwork
 *   'inline'   bare icon for list rows ['ghost']
 *   'toolbar'  32 dp bordered square for chart toolbars
 */
export interface WatchlistButtonProps {
  symbol: string;
  row?: Instrument | null;
  size?: number;
  variant?: 'overlay' | 'inline' | 'toolbar';
  /** Always on here (no hover on a phone); kept for call-site parity. */
  persistent?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function WatchlistButton({
  symbol,
  row = null,
  size = 16,
  variant = 'overlay',
  style,
}: WatchlistButtonProps): React.JSX.Element | null {
  const t = useTheme();
  const { inAnyList } = useWatchlists();
  const { open } = useWatchlistModal();

  if (!symbol) return null;
  const saved = inAnyList(symbol);
  const pad = size >= 18 ? 8 : 6;

  const skin: ViewStyle = variant === 'toolbar'
    ? {
      width: 32,
      height: 32,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: saved ? t.alpha(t.colors.primary, 0.4) : t.colors.borderDark,
      backgroundColor: saved ? t.alpha(t.colors.primary, 0.1) : t.colors.surface,
    }
    : variant === 'overlay'
      ? {
        padding: pad,
        borderRadius: t.radius.lg,
        borderWidth: 1,
        borderColor: saved ? t.alpha(t.colors.primary, 0.3) : t.colors.borderDark,
        backgroundColor: t.alpha(t.colors.surface, saved ? 0.95 : 0.9),
        ...t.shadow.card,
      }
      : { padding: pad, borderRadius: t.radius.lg };

  const color = saved
    ? t.colors.primary
    : variant === 'toolbar' ? t.colors.textSecondary : t.colors.textMuted;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={bookmarkLabel(saved, symbol)}
      accessibilityHint={bookmarkHint(saved)}
      accessibilityState={{ selected: saved }}
      hitSlop={6}
      onPress={() => open(symbol, row)}
      style={({ pressed }) => [styles.base, skin, pressed ? styles.pressed : null, style]}
      testID={`watchlist-button-${symbol}`}
    >
      <WatchIcon name="bookmark" size={size} color={color} filled={saved} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
  pressed: { transform: [{ scale: 0.95 }] },
});
