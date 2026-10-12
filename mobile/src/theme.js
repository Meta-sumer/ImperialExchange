import React, { createContext, useContext } from 'react';
import { useColorScheme } from 'react-native';
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * EXACT design tokens ported from the web client (tailwind.config.js + the
 * :root / [data-theme='dark'] CSS variables in index.css). Same colours,
 * same light + dark surfaces, same brand — so the app reads as one product.
 */
const brand = {
  primary50: '#EFF6FF', primary100: '#DBEAFE', primary400: '#3B82F6',
  primary500: '#1D4ED8', primary600: '#1E40AF', primary700: '#1E3A8A',
  bull: '#00C853', bear: '#FF3B57', warn: '#3B82F6', info: '#3B82F6',
  white: '#FFFFFF',
};

const LIGHT = {
  ...brand,
  bg: '#FFFFFF', card: '#F8F9FB', panel: '#F8F9FB', hover: '#F3F4F6', sidebar: '#FFFFFF',
  border: '#D1D5DB', borderSubtle: '#E5E7EB',
  textPrimary: '#0F172A', textSecondary: '#1F2937', textMuted: '#4B5563',
  primarySoft: 'rgba(29,78,216,0.08)', bullSoft: 'rgba(0,200,83,0.13)', bearSoft: 'rgba(255,59,87,0.13)', warnSoft: 'rgba(59,130,246,0.12)',
  scheme: 'light',
};

const DARK = {
  ...brand,
  bg: '#0D1117', card: '#161B22', panel: '#1E242C', hover: '#2A313A', sidebar: '#11151B',
  border: '#30363D', borderSubtle: '#21262D',
  textPrimary: '#F0F6FC', textSecondary: '#ADB5BF', textMuted: '#7D8590',
  primarySoft: 'rgba(59,130,246,0.16)', bullSoft: 'rgba(0,200,83,0.16)', bearSoft: 'rgba(255,59,87,0.16)', warnSoft: 'rgba(59,130,246,0.16)',
  scheme: 'dark',
};

// Shared metrics — from the web (radii 6/8/10/14).
export const radius = { sm: 6, md: 8, lg: 10, xl: 14, pill: 999 };

// ── Theme-mode store (light | dark | system), persisted ──
const MODE_KEY = 'themeMode';
export const useThemeMode = create((set) => ({
  mode: 'system',
  init: async () => { try { const m = await AsyncStorage.getItem(MODE_KEY); if (m) set({ mode: m }); } catch {} },
  setMode: async (mode) => { set({ mode }); try { await AsyncStorage.setItem(MODE_KEY, mode); } catch {} },
}));

const ThemeCtx = createContext({ colors: LIGHT, dark: false, radius });

export function ThemeProvider({ children }) {
  const mode = useThemeMode((s) => s.mode);
  const system = useColorScheme();
  const dark = mode === 'dark' || (mode === 'system' && system === 'dark');
  const value = React.useMemo(() => ({ colors: dark ? DARK : LIGHT, dark, radius }), [dark]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTheme() { return useContext(ThemeCtx); }
export function useColors() { return useContext(ThemeCtx).colors; }

// ── Formatting helpers (shared with the web) ──
export const currencySymbol = (c = 'USD') => ({ INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥' }[c] || `${c} `);
export const fmtNum = (v, dp = 2) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
};

// Back-compat: a static light `theme` object so any not-yet-migrated module
// keeps importing `{ theme }` and rendering (in the light palette) until it's
// converted to useColors()/useTheme().
export const theme = { colors: LIGHT, radius, space: (n) => n * 4 };
