import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

import { DEFAULT_THEME_MODE, type ThemeMode } from '@/constants/theme';

/**
 * The APPLIED theme, ported from client/src/store/theme.js.
 *
 * Same split as the web: this store owns what is currently painted
 * ('light' | 'dark'); store/tradeSettings owns the user's INTENT, which can
 * also be 'system'. tradeSettings translates intent into a `setTheme` call
 * here, exactly as the web's applyAppearance does.
 *
 * ── WHY THERE IS A hydrate() ──────────────────────────────────────────
 * The web reads localStorage synchronously in `readInitial()`, so the first
 * paint is already the saved theme. AsyncStorage is asynchronous; reading it
 * after the first render is the mobile version of the flash-of-wrong-palette
 * the web's main.jsx goes out of its way to avoid. So App.tsx awaits
 * `hydrateTheme()` inside the same boot gate that loads the session, and
 * nothing is drawn with the default before the saved value is known.
 * ──────────────────────────────────────────────────────────────────────
 */

/** Same key as the web, so the two are recognisably the same setting. */
export const THEME_STORAGE_KEY = 'tradepro:theme';

const isThemeMode = (v: unknown): v is ThemeMode => v === 'light' || v === 'dark';

interface ThemeState {
  theme: ThemeMode;
  setTheme: (next: ThemeMode) => void;
  toggle: () => void;
}

export const useThemeStore = create<ThemeState>()((set, get) => ({
  // store/theme.js:11 — 'light' when nothing is saved.
  theme: DEFAULT_THEME_MODE,

  setTheme: (next) => {
    // The web ignores anything that is not exactly 'light' or 'dark' rather
    // than coercing it; a stray value must not paint half a theme.
    if (!isThemeMode(next)) return;
    set({ theme: next });
    // Private mode on the web, a full disk here — either way the theme still
    // applies for this session, it just will not survive a restart.
    AsyncStorage.setItem(THEME_STORAGE_KEY, next).catch(() => {});
  },

  toggle: () => get().setTheme(get().theme === 'light' ? 'dark' : 'light'),
}));

/**
 * Load the saved theme. Awaited once in the boot gate; safe to call again.
 * The web's `readInitial()`, made asynchronous.
 */
export const hydrateTheme = async (): Promise<void> => {
  try {
    const saved = await AsyncStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeMode(saved)) useThemeStore.setState({ theme: saved });
  } catch {
    // Unreadable storage means "nothing saved" — the default stands.
  }
};
