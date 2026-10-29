/**
 * store/theme + store/tradeSettings — the web's two stores, ported. The
 * defaults, the merge, the dot-path setter and the appearance sync are all
 * behaviour a trader sees (confirm-before-order is a default here), so they
 * are pinned against the web's values.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance } from 'react-native';

import { THEME_STORAGE_KEY, hydrateTheme, useThemeStore } from '@/store/theme';
import {
  TRADE_SETTINGS_DEFAULTS,
  TRADE_SETTINGS_STORAGE_KEY,
  applyInitialTradeSettings,
  hydrateTradeSettings,
  mergeSettings,
  resolveAppearance,
  toggleAppearance,
  useTradeSettings,
  type TradeSettingsData,
} from '@/store/tradeSettings';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const flush = () => new Promise((r) => setImmediate(r));

let scheme: 'light' | 'dark' = 'light';
let appearanceListeners: Array<() => void> = [];

beforeEach(async () => {
  await AsyncStorage.clear();
  scheme = 'light';
  appearanceListeners = [];
  jest.spyOn(Appearance, 'getColorScheme').mockImplementation(() => scheme);
  jest.spyOn(Appearance, 'addChangeListener').mockImplementation((fn) => {
    const l = fn as unknown as () => void;
    appearanceListeners.push(l);
    return { remove: () => { appearanceListeners = appearanceListeners.filter((x) => x !== l); } };
  });
  useThemeStore.setState({ theme: 'light' });
  useTradeSettings.setState({ ...(TRADE_SETTINGS_DEFAULTS as TradeSettingsData), drawerOpen: false });
});

afterEach(() => jest.restoreAllMocks());

describe('store/theme — store/theme.js', () => {
  it('defaults to light and ignores anything but light/dark', () => {
    expect(useThemeStore.getState().theme).toBe('light');
    useThemeStore.getState().setTheme('purple' as never);
    expect(useThemeStore.getState().theme).toBe('light');
  });

  it('toggles and persists under the web key', async () => {
    useThemeStore.getState().toggle();
    expect(useThemeStore.getState().theme).toBe('dark');
    await flush();
    expect(await AsyncStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('hydrates a saved theme and rejects a corrupt one', async () => {
    await AsyncStorage.setItem(THEME_STORAGE_KEY, 'dark');
    await hydrateTheme();
    expect(useThemeStore.getState().theme).toBe('dark');
    useThemeStore.setState({ theme: 'light' });
    await AsyncStorage.setItem(THEME_STORAGE_KEY, '"dark"');
    await hydrateTheme();
    expect(useThemeStore.getState().theme).toBe('light');
  });
});

describe('store/tradeSettings — defaults', () => {
  it('matches tradeSettings.js:8-43', () => {
    expect(TRADE_SETTINGS_DEFAULTS).toEqual({
      showOnChart: {
        signals: false, hmr: false, alerts: true, positions: true,
        tpsl: true, stopLimit: true, calendar: false, orderPreview: true,
      },
      calendarFilters: { high: true, medium: true, low: false, lowest: false },
      sounds: { alerts: true, tpsl: false },
      trading: { openOrderMode: 'regular', priceSource: 'mid', appearance: 'system', timeZone: 'local' },
      autoTrading: { autoTpSl: false, confirmOrder: true, oneClick: false, autoSaveLayout: true },
    });
  });
});

describe('mergeSettings', () => {
  it('fills keys a stored blob predates, keeps the ones it has', () => {
    const merged = mergeSettings(TRADE_SETTINGS_DEFAULTS, { sounds: { alerts: false }, trading: { priceSource: 'bid' } });
    expect(merged.sounds).toEqual({ alerts: false, tpsl: false });
    expect(merged.trading.priceSource).toBe('bid');
    expect(merged.trading.appearance).toBe('system');
    expect(merged.showOnChart).toEqual(TRADE_SETTINGS_DEFAULTS.showOnChart);
  });

  it('drops unknown keys and wrongly typed values', () => {
    const merged = mergeSettings(TRADE_SETTINGS_DEFAULTS, {
      bogus: { x: 1 },
      autoTrading: { confirmOrder: 'no', oneClick: true },
    }) as unknown as Record<string, unknown>;
    expect(merged.bogus).toBeUndefined();
    expect((merged.autoTrading as Record<string, unknown>).confirmOrder).toBe(true);
    expect((merged.autoTrading as Record<string, unknown>).oneClick).toBe(true);
  });

  it('returns the defaults for a non-object', () => {
    expect(mergeSettings(TRADE_SETTINGS_DEFAULTS, null)).toBe(TRADE_SETTINGS_DEFAULTS);
    expect(mergeSettings(TRADE_SETTINGS_DEFAULTS, 'x')).toBe(TRADE_SETTINGS_DEFAULTS);
  });
});

describe('set / replace / reset', () => {
  it('writes one leaf and leaves other sections referentially stable', () => {
    const before = useTradeSettings.getState();
    before.set('sounds.tpsl', true);
    const after = useTradeSettings.getState();
    expect(after.sounds.tpsl).toBe(true);
    expect(after.sounds).not.toBe(before.sounds);
    expect(after.showOnChart).toBe(before.showOnChart);
    expect(TRADE_SETTINGS_DEFAULTS.sounds.tpsl).toBe(false);
  });

  it('sees its own previous write, as the paired Pending/Preview toggle needs', () => {
    const { set } = useTradeSettings.getState();
    set('showOnChart.stopLimit', false);
    set('showOnChart.orderPreview', false);
    expect(useTradeSettings.getState().showOnChart).toMatchObject({ stopLimit: false, orderPreview: false });
  });

  it('persists the five sections and never drawerOpen', async () => {
    useTradeSettings.getState().openDrawer();
    useTradeSettings.getState().set('trading.timeZone', 'utc');
    await flush();
    const saved = JSON.parse((await AsyncStorage.getItem(TRADE_SETTINGS_STORAGE_KEY)) ?? '{}');
    expect(Object.keys(saved).sort()).toEqual(['autoTrading', 'calendarFilters', 'showOnChart', 'sounds', 'trading']);
    expect(saved.trading.timeZone).toBe('utc');
  });

  it('reset restores the defaults and keeps the drawer as it was', () => {
    const s = useTradeSettings.getState();
    s.openDrawer();
    s.set('autoTrading.confirmOrder', false);
    s.reset();
    const after = useTradeSettings.getState();
    expect(after.autoTrading.confirmOrder).toBe(true);
    expect(after.drawerOpen).toBe(true);
  });

  it('hydrates from storage, merged onto the defaults', async () => {
    await AsyncStorage.setItem(TRADE_SETTINGS_STORAGE_KEY, JSON.stringify({ trading: { openOrderMode: 'oneClick' } }));
    await hydrateTradeSettings();
    const s = useTradeSettings.getState();
    expect(s.trading.openOrderMode).toBe('oneClick');
    expect(s.trading.priceSource).toBe('mid');
  });
});

describe('appearance sync', () => {
  it('resolves intent to a theme', () => {
    expect(resolveAppearance('system', true)).toBe('dark');
    expect(resolveAppearance('system', false)).toBe('light');
    expect(resolveAppearance('dark', false)).toBe('dark');
  });

  it("'system' follows the OS, and keeps following it", () => {
    scheme = 'dark';
    applyInitialTradeSettings();
    expect(useThemeStore.getState().theme).toBe('dark');
    scheme = 'light';
    for (const l of appearanceListeners) l();
    expect(useThemeStore.getState().theme).toBe('light');
  });

  it('an explicit choice stops following the OS', () => {
    applyInitialTradeSettings();
    useTradeSettings.getState().set('trading.appearance', 'dark');
    expect(useThemeStore.getState().theme).toBe('dark');
    expect(appearanceListeners).toHaveLength(0);
  });

  it('the header toggle records the intent, so it survives a restart', () => {
    toggleAppearance();
    expect(useThemeStore.getState().theme).toBe('dark');
    expect(useTradeSettings.getState().trading.appearance).toBe('dark');
    toggleAppearance();
    expect(useTradeSettings.getState().trading.appearance).toBe('light');
  });
});
