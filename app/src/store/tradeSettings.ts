import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance, type NativeEventSubscription } from 'react-native';
import { create } from 'zustand';

import type { ThemeMode } from '@/constants/theme';
import { useThemeStore } from '@/store/theme';

/**
 * Trade settings, ported from client/src/store/tradeSettings.js.
 *
 * Same sections, same defaults, same dot-path setter, same deep-merge on
 * load, same appearance side effect. Two things are platform swaps rather
 * than changes:
 *
 *   • localStorage → AsyncStorage. Reads are asynchronous, so the initial
 *     state is the DEFAULTS and `hydrateTradeSettings()` (awaited in the boot
 *     gate, see App.tsx) replaces it before anything is drawn.
 *   • `matchMedia('(prefers-color-scheme: dark)')` → RN `Appearance`. The
 *     'system' intent follows the OS exactly as the web follows the browser.
 *
 * The setter is TYPED here: `set('trading.appearance', 'dark')` compiles and
 * `set('trading.appearence', 'drak')` does not. The web accepts any string
 * and silently grows a new key.
 */

export const TRADE_SETTINGS_STORAGE_KEY = 'tradepro:tradeSettings';

export type OpenOrderMode = 'regular' | 'oneClick' | 'riskCalc';
export type PriceSource = 'bid' | 'ask' | 'mid';
/** The user's INTENT. 'system' follows the OS; store/theme holds what is applied. */
export type AppearanceIntent = ThemeMode | 'system';
export type TimeZonePref = 'utc' | 'gmt' | 'local';

export interface TradeSettingsData {
  showOnChart: {
    signals: boolean;
    hmr: boolean;
    alerts: boolean;
    positions: boolean;
    tpsl: boolean;
    stopLimit: boolean;
    calendar: boolean;
    orderPreview: boolean;
  };
  calendarFilters: {
    high: boolean;
    medium: boolean;
    low: boolean;
    lowest: boolean;
  };
  sounds: {
    alerts: boolean;
    tpsl: boolean;
  };
  trading: {
    openOrderMode: OpenOrderMode;
    priceSource: PriceSource;
    appearance: AppearanceIntent;
    timeZone: TimeZonePref;
  };
  autoTrading: {
    autoTpSl: boolean;
    confirmOrder: boolean;
    oneClick: boolean;
    autoSaveLayout: boolean;
  };
}

// ─── Defaults ────────────────────────────────────────────────────────
// tradeSettings.js:8-43, value for value. Frozen because `reset()` hands
// these nested objects straight to the store (as the web does) and `set()`
// clones a branch before writing — a mutation that slipped past that would
// otherwise change the defaults for the rest of the session.
export const TRADE_SETTINGS_DEFAULTS: Readonly<TradeSettingsData> = Object.freeze({
  showOnChart: Object.freeze({
    signals: false,
    hmr: false,
    alerts: true, // price alerts are most-used → default on
    positions: true,
    tpsl: true, // TP / SL lines on open positions
    stopLimit: true, // pending STOP / LIMIT order lines
    calendar: false,
    orderPreview: true, // live Entry/TP/SL preview lines while filling the order form
  }),
  calendarFilters: Object.freeze({
    high: true,
    medium: true,
    low: false,
    lowest: false,
  }),
  sounds: Object.freeze({
    alerts: true,
    tpsl: false,
  }),
  trading: Object.freeze({
    openOrderMode: 'regular' as OpenOrderMode,
    priceSource: 'mid' as PriceSource,
    appearance: 'system' as AppearanceIntent,
    timeZone: 'local' as TimeZonePref,
  }),
  autoTrading: Object.freeze({
    autoTpSl: false,
    confirmOrder: true, // confirm before placing — safer default
    oneClick: false,
    autoSaveLayout: true,
  }),
});

/** Every leaf, as the dot path the setter takes: 'showOnChart.signals', … */
export type SettingPath = {
  [S in keyof TradeSettingsData]: `${S}.${keyof TradeSettingsData[S] & string}`;
}[keyof TradeSettingsData];

export type SettingValue<P extends SettingPath> =
  P extends `${infer S}.${infer K}`
    ? S extends keyof TradeSettingsData
      ? K extends keyof TradeSettingsData[S]
        ? TradeSettingsData[S][K]
        : never
      : never
    : never;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Deep-merge defaults onto whatever storage holds, so schema additions (new
 * toggles, new sections) don't break older persisted blobs. tradeSettings.js
 * `merge`, with one guard added: a stored leaf whose TYPE differs from the
 * default's is ignored. The web copies it through, so a corrupted blob can
 * put a number where the order form expects a boolean.
 */
export const mergeSettings = <T>(base: T, override: unknown): T => {
  if (!isObject(override) || !isObject(base)) return base;
  const out: Json = { ...base };
  for (const k of Object.keys(base)) {
    const b = (base as Json)[k];
    const o = override[k];
    if (isObject(b)) {
      out[k] = mergeSettings(b, o);
    } else if (o !== undefined && typeof o === typeof b) {
      out[k] = o;
    }
  }
  return out as T;
};

/** Only the five sections are settings. Drawer state and actions are not. */
export const pickSettings = (state: TradeSettingsData): TradeSettingsData => ({
  showOnChart: state.showOnChart,
  calendarFilters: state.calendarFilters,
  sounds: state.sounds,
  trading: state.trading,
  autoTrading: state.autoTrading,
});

const write = (state: TradeSettingsData): void => {
  // tradeSettings.js:74 strips `drawerOpen` — UI state, not a setting.
  AsyncStorage.setItem(TRADE_SETTINGS_STORAGE_KEY, JSON.stringify(pickSettings(state)))
    .catch(() => { /* full disk: this session keeps the value, a restart loses it */ });
};

// ─── Appearance sync ────────────────────────────────────────────────
// The settings store owns the user's intent ('light' | 'dark' | 'system');
// the theme store owns what's currently applied. Intent → effective theme
// is pushed to the theme store whenever it changes. 'system' tracks the OS.

const systemPrefersDark = (): boolean => Appearance.getColorScheme() === 'dark';

export const resolveAppearance = (intent: AppearanceIntent, osPrefersDark: boolean): ThemeMode =>
  (intent === 'system' ? (osPrefersDark ? 'dark' : 'light') : intent);

const applyAppearance = (intent: AppearanceIntent): void => {
  const themeStore = useThemeStore.getState();
  const next = resolveAppearance(intent, systemPrefersDark());
  if (themeStore.theme !== next) themeStore.setTheme(next);
};

// One OS listener at most, live only while the intent is 'system'.
let systemListener: NativeEventSubscription | null = null;
const wireSystemListener = (intent: AppearanceIntent): void => {
  if (systemListener) {
    systemListener.remove();
    systemListener = null;
  }
  if (intent === 'system') {
    systemListener = Appearance.addChangeListener(() => applyAppearance('system'));
  }
};

// ─── Store ──────────────────────────────────────────────────────────

export interface TradeSettingsState extends TradeSettingsData {
  drawerOpen: boolean;
  /** Dot-path setter: `set('showOnChart.signals', true)`. */
  set: <P extends SettingPath>(path: P, value: SettingValue<P>) => void;
  /** Bulk override (used by reset). */
  replace: (next: TradeSettingsData) => void;
  reset: () => void;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
}

export const useTradeSettings = create<TradeSettingsState>()((setState, get) => ({
  ...(TRADE_SETTINGS_DEFAULTS as TradeSettingsData),
  drawerOpen: false,

  set: (path, value) => {
    const [section, key] = path.split('.') as [keyof TradeSettingsData, string];
    // Clone the touched branch only — untouched sections stay referentially
    // stable, so a selector on `showOnChart` does not re-render when a sound
    // toggle changes.
    const branch = { ...(get()[section] as unknown as Json), [key]: value };
    setState({ [section]: branch } as Partial<TradeSettingsState>);
    // Side effect: an appearance change applies the theme immediately.
    if (path === 'trading.appearance') {
      applyAppearance(value as AppearanceIntent);
      wireSystemListener(value as AppearanceIntent);
    }
    write(get());
  },

  replace: (next) => {
    setState(pickSettings(next));
    write(get());
    const intent = next.trading?.appearance ?? 'system';
    applyAppearance(intent);
    wireSystemListener(intent);
  },

  reset: () => {
    setState({ ...(TRADE_SETTINGS_DEFAULTS as TradeSettingsData) });
    write(get());
    applyAppearance(TRADE_SETTINGS_DEFAULTS.trading.appearance);
    wireSystemListener(TRADE_SETTINGS_DEFAULTS.trading.appearance);
  },

  openDrawer: () => setState({ drawerOpen: true }),
  closeDrawer: () => setState({ drawerOpen: false }),
  toggleDrawer: () => setState({ drawerOpen: !get().drawerOpen }),
}));

/** Load persisted settings. Awaited in the boot gate; safe to call again. */
export const hydrateTradeSettings = async (): Promise<void> => {
  try {
    const raw = await AsyncStorage.getItem(TRADE_SETTINGS_STORAGE_KEY);
    if (!raw) return;
    useTradeSettings.setState(
      mergeSettings(TRADE_SETTINGS_DEFAULTS as TradeSettingsData, JSON.parse(raw)),
    );
  } catch {
    // Unreadable or unparsable: the defaults stand, as on the web.
  }
};

/**
 * Apply the persisted appearance. Call after both hydrations, as main.jsx
 * calls it after applyInitialTheme — the intent (default 'system') wins over
 * the plain saved theme. Safe to call more than once.
 */
export const applyInitialTradeSettings = (): void => {
  const intent = useTradeSettings.getState().trading.appearance;
  applyAppearance(intent);
  wireSystemListener(intent);
};

/**
 * The sun/moon toggle. Flips the INTENT (persisted), which then pushes the
 * effective theme — the same thing OrderForm.jsx:1214 does.
 *
 * Layout.jsx's toggle calls the theme store directly instead, and that
 * choice does not survive a reload: main.jsx re-applies the default
 * 'system' intent on boot and overrides it. Going through the intent is the
 * version that stays put.
 */
export const toggleAppearance = (): void => {
  const current = useThemeStore.getState().theme;
  useTradeSettings.getState().set('trading.appearance', current === 'dark' ? 'light' : 'dark');
};
