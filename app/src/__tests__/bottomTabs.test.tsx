/**
 * The phone's bottom tabs — Explore, Option Chain, Positions, Portfolio,
 * Wallets — and the pill strip that keeps the rest of the web's MOBILE_NAV
 * (Watchlist, Copy Trading). The web has no tab bar; these pin the app's own
 * split of EquityHub's Layout.jsx nav.
 */
import React, { act } from 'react';
import { Keyboard, Text } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('@/navigation/navigationRef',() => ({ navigationRef: { isReady: () => true, dispatch: jest.fn() } }));

/* eslint-disable import/first */
import { BottomTabBar, WithBottomTabs } from '@/navigation/chrome/BottomTabBar';
import { PillRail } from '@/navigation/chrome/PillRail';
import {
  BOTTOM_TABS,
  MOBILE_NAV,
  RAIL_NAV,
  SECTION_ROUTES,
  isNavActive,
} from '@/navigation/chrome/primaryNav';
import { navigationRef } from '@/navigation/navigationRef';
import { ThemeProvider } from '@/theme';
/* eslint-enable import/first */

interface TestNode {
  props: Record<string, unknown>;
  findAll(pred: (n: TestNode) => boolean): TestNode[];
}
interface Renderer { root: TestNode; toJSON(): unknown; unmount(): void }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { create } = require('react-test-renderer') as { create: (el: React.ReactElement) => Renderer };

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const Shell = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <SafeAreaProvider initialMetrics={METRICS}><ThemeProvider>{children}</ThemeProvider></SafeAreaProvider>
);

const tabs = (r: Renderer): TestNode[] =>
  r.root.findAll((n) => n.props.accessibilityRole === 'tab' && typeof n.props.onPress === 'function');
const selected = (r: Renderer): string[] =>
  tabs(r).filter((n) => (n.props.accessibilityState as { selected?: boolean }).selected).map((n) => String(n.props.accessibilityLabel));

describe('the split', () => {
  it('the bottom tabs: Explore, Option Chain, Positions, Portfolio, Wallets', () => {
    expect(BOTTOM_TABS.map((i) => i.label)).toEqual(['Explore', 'Option Chain', 'Positions', 'Portfolio', 'Wallets']);
    expect(BOTTOM_TABS.map((i) => i.route)).toEqual([
      { name: 'Explore' },
      { name: 'Options' },
      { name: 'Positions' },
      { name: 'Dashboard' },
      { name: 'Wallet' },
    ]);
  });

  it('the strip carries the rest of MOBILE_NAV, in its order', () => {
    expect(RAIL_NAV.map((i) => i.label)).toEqual(['Watchlist', 'Copy Trading']);
    expect(RAIL_NAV.map((i) => i.route.name)).toEqual(['Watchlist', 'CopyTrading']);
  });

  it('tabs + strip are exactly the web nav: nothing lost, nothing added', () => {
    const both = [...BOTTOM_TABS, ...RAIL_NAV].map((i) => i.key).sort();
    expect(both).toEqual(MOBILE_NAV.map((i) => i.key).sort());
  });

  it('the section pages — no back chevron on them — are exactly what the strip and the tabs open', () => {
    expect([...SECTION_ROUTES].sort()).toEqual(['CopyTrading', 'Dashboard', 'Explore', 'Options', 'Positions', 'Wallet', 'Watchlist']);
  });

  it('a destination is lit on its own route only', () => {
    const [explore, options] = BOTTOM_TABS;
    expect(isNavActive(explore!, { name: 'Explore' })).toBe(true);
    expect(isNavActive(explore!, { name: 'MarketList' })).toBe(false);
    expect(isNavActive(options!, { name: 'Options', params: { underlying: 'NIFTY', expiry: '2026-10-27' } })).toBe(true);
    expect(isNavActive(options!, { name: 'StockDetail', params: { symbol: 'NIFTY' } })).toBe(false);
  });
});

describe('the bar', () => {
  let r: Renderer | null = null;
  afterEach(async () => {
    await act(async () => { r?.unmount(); });
    r = null;
    (navigationRef.dispatch as jest.Mock).mockClear();
  });

  it('lights the section on screen and switches with pop', async () => {
    await act(async () => { r = create(<Shell><BottomTabBar current={{ name: 'Options', params: { underlying: 'NIFTY' } }} /></Shell>); });
    const bar = r as unknown as Renderer;
    expect(tabs(bar).map((n) => n.props.accessibilityLabel)).toEqual(['Explore', 'Option Chain', 'Positions', 'Portfolio', 'Wallets']);
    expect(selected(bar)).toEqual(['Option Chain']);

    const positions = tabs(bar).find((n) => n.props.accessibilityLabel === 'Positions');
    await act(async () => { (positions?.props.onPress as () => void)(); });
    expect(navigationRef.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'NAVIGATE', payload: expect.objectContaining({ name: 'Positions', pop: true }) }),
    );

    // The tab already open does nothing.
    (navigationRef.dispatch as jest.Mock).mockClear();
    const options = tabs(bar).find((n) => n.props.accessibilityLabel === 'Option Chain');
    await act(async () => { (options?.props.onPress as () => void)(); });
    expect(navigationRef.dispatch).not.toHaveBeenCalled();
  });

  it('steps aside while the keyboard is up', async () => {
    const listeners: Record<string, () => void> = {};
    const spy = jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, fn: () => void) => {
      listeners[event] = fn;
      return { remove: () => undefined };
    }) as never);
    await act(async () => { r = create(<Shell><BottomTabBar current={{ name: 'Dashboard' }} /></Shell>); });
    const bar = r as unknown as Renderer;
    expect(selected(bar)).toEqual(['Portfolio']);

    const shown = Object.keys(listeners).find((k) => /Show$/.test(k)) as string;
    const hidden = Object.keys(listeners).find((k) => /Hide$/.test(k)) as string;
    await act(async () => { listeners[shown]?.(); });
    expect(tabs(bar)).toHaveLength(0);
    await act(async () => { listeners[hidden]?.(); });
    expect(tabs(bar)).toHaveLength(5);
    spy.mockRestore();
  });

  it('takes the bottom inset itself, and the page above is told it is zero', async () => {
    const Probe = (): React.JSX.Element => <Text>{`page-bottom:${useSafeAreaInsets().bottom}`}</Text>;
    await act(async () => {
      r = create(<Shell><WithBottomTabs current={{ name: 'Watchlist' }}><Probe /></WithBottomTabs></Shell>);
    });
    const page = r as unknown as Renderer;
    expect(JSON.stringify(page.toJSON())).toContain('page-bottom:0');
    const bar = page.root.findAll((n) => n.props.accessibilityRole === 'tablist')[0];
    const style = ([] as unknown[]).concat(bar?.props.style).flat() as { paddingBottom?: number }[];
    expect(style.some((s) => s && s.paddingBottom === 34)).toBe(true);
    // A page that is on the strip, not a tab, lights no tab.
    expect(selected(page)).toEqual([]);
  });
});

describe('the strip', () => {
  let r: Renderer | null = null;
  afterEach(async () => {
    await act(async () => { r?.unmount(); });
    r = null;
    (navigationRef.dispatch as jest.Mock).mockClear();
  });

  it('draws Watchlist and Copy Trading, lights the open one, and navigates with pop', async () => {
    await act(async () => { r = create(<Shell><PillRail current={{ name: 'Watchlist' }} /></Shell>); });
    const rail = r as unknown as Renderer;
    expect(tabs(rail).map((n) => n.props.accessibilityLabel)).toEqual(['Watchlist', 'Copy Trading']);
    expect(selected(rail)).toEqual(['Watchlist']);
    const copy = tabs(rail).find((n) => n.props.accessibilityLabel === 'Copy Trading');
    await act(async () => { (copy?.props.onPress as () => void)(); });
    expect(navigationRef.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'NAVIGATE', payload: expect.objectContaining({ name: 'CopyTrading', pop: true }) }),
    );
  });
});
