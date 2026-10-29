import { StatusBar } from 'expo-status-bar';
import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';

import { useThemeStore } from '@/store/theme';
import {
  applyInitialTradeSettings,
  hydrateTradeSettings,
  toggleAppearance,
  useTradeSettings,
  type AppearanceIntent,
} from '@/store/tradeSettings';
import { hydrateTheme } from '@/store/theme';

import { themes, type AppTheme } from './tokens';

/**
 * The theme runtime.
 *
 * On the web, `data-theme` on <html> flips every CSS variable at once and no
 * component has to know. React Native has no cascade, so the palette has to
 * reach components some other way — this context. Components read it with
 * `useTheme()` (or `makeStyles`, below) and re-render when it changes.
 *
 * The provider holds no state of its own. The applied theme lives in
 * store/theme and the intent in store/tradeSettings, exactly as on the web;
 * this only turns the store's value into a theme object and hands it down.
 */

const ThemeContext = createContext<AppTheme>(themes.light);

export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const mode = useThemeStore((s) => s.theme);
  const theme = themes[mode];
  return (
    <ThemeContext.Provider value={theme}>
      {/* Dark glyphs on the light chrome, light on dark — the status bar is
          part of the header here, and the web has no equivalent to copy. */}
      <StatusBar style={theme.isDark ? 'light' : 'dark'} />
      {children}
    </ThemeContext.Provider>
  );
}

/** The current theme. Re-renders the caller when the theme changes. */
export const useTheme = (): AppTheme => useContext(ThemeContext);

/**
 * Theme controls for a settings screen or the header toggle.
 *
 * `appearance` is the persisted intent ('light' | 'dark' | 'system');
 * `mode` is what is applied right now.
 */
export const useAppearance = (): {
  mode: AppTheme['mode'];
  appearance: AppearanceIntent;
  setAppearance: (next: AppearanceIntent) => void;
  toggle: () => void;
} => {
  const mode = useThemeStore((s) => s.theme);
  const appearance = useTradeSettings((s) => s.trading.appearance);
  const set = useTradeSettings((s) => s.set);
  return useMemo(() => ({
    mode,
    appearance,
    setAppearance: (next: AppearanceIntent) => set('trading.appearance', next),
    toggle: toggleAppearance,
  }), [mode, appearance, set]);
};

/**
 * Themed styles without re-creating a StyleSheet on every render.
 *
 *   const useStyles = makeStyles((t) => ({
 *     root: { backgroundColor: t.colors.surface, padding: t.space.lg },
 *   }));
 *   …
 *   const s = useStyles();
 *
 * Built once per theme per hook, so a theme switch costs one StyleSheet per
 * mounted component and a normal render costs nothing.
 */
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (theme: AppTheme) => T,
): () => T {
  const cache = new Map<AppTheme, T>();
  return function useStyles(): T {
    const theme = useTheme();
    let styles = cache.get(theme);
    if (!styles) {
      styles = StyleSheet.create(factory(theme));
      cache.set(theme, styles);
    }
    return styles;
  };
}

/**
 * Load the saved theme and appearance intent. Awaited by App.tsx's boot
 * gate, in the order main.jsx applies them: the plain theme first, then the
 * trade-settings intent, which wins.
 */
export const hydrateAppearance = async (): Promise<void> => {
  await Promise.all([hydrateTheme(), hydrateTradeSettings()]);
  applyInitialTradeSettings();
};
