/**
 * Positions — EquityHub's client/src/pages/Positions.jsx and the
 * self-contained components/PositionsPanel.jsx behind it (also the
 * instrument page's Positions tab). The panel fetches its own book, marks it
 * to market, and owns close / cancel.
 */
import fs from 'fs';
import path from 'path';
import React, { act } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));

const mockPosition = {
  id: 'p1', accountId: 'a1', symbol: 'RELIANCE', side: 'BUY', positionSide: 'LONG', status: 'OPEN',
  quantity: '10', closedQuantity: '0', entryPrice: '2500', markPrice: '2505', leverage: 5,
  margin: '5000', realizedPnl: '0', unrealizedPnl: '50', commission: '0', swap: '0', openedAt: '2026-10-01T00:00:00Z',
};
const mockShort = { ...mockPosition, id: 'p2', symbol: 'TCS', side: 'SELL', positionSide: 'SHORT', quantity: '2', entryPrice: '3900', markPrice: '3890' };
const mockOrder = {
  id: 'o1', accountId: 'a1', symbol: 'NIFTY', side: 'SELL', type: 'LIMIT', status: 'PENDING',
  quantity: '75', price: '24100', createdAt: '2026-10-01T00:00:00Z',
};
const mockBook: { positions: unknown[]; orders: unknown[] } = { positions: [], orders: [] };
const mockPrices: Record<string, number> = {};

jest.mock('@/api/trading.api', () => ({
  fetchPositions: jest.fn(async () => mockBook.positions),
  fetchOpenOrders: jest.fn(async () => mockBook.orders),
  closePosition: jest.fn(async () => ({ order: null, position: null, wallet: null })),
  cancelOrder: jest.fn(async () => ({})),
}));
jest.mock('@/websocket/channels', () => ({ subscribePositions: jest.fn(() => () => {}) }));
jest.mock('@/screens/trade/useLiveBoard', () => ({ useLiveBoard: () => ({ prices: mockPrices, overlay: {} }) }));

/* eslint-disable import/first */
import { cancelOrder, closePosition, fetchOpenOrders, fetchPositions } from '@/api/trading.api';
import { PositionsPanel, panelEmpty, panelPnl } from '@/components/orders/PositionsPanel';
import { ConfirmProvider, PortalHost } from '@/components/ui';
import { PositionsScreen } from '@/screens/positions/PositionsScreen';
import { ThemeProvider } from '@/theme';
/* eslint-enable import/first */

interface TestNode { props: Record<string, unknown>; parent: TestNode | null; findAll(pred: (n: TestNode) => boolean): TestNode[] }
interface Renderer { root: TestNode; toJSON(): unknown; unmount(): void }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { create } = require('react-test-renderer') as { create: (el: React.ReactElement) => Renderer };

const PANEL = fs.readFileSync(path.join(__dirname, '../../../client/src/components/PositionsPanel.jsx'), 'utf8').replace(/\r\n/g, '\n');
const PAGE = fs.readFileSync(path.join(__dirname, '../../../client/src/pages/Positions.jsx'), 'utf8').replace(/\r\n/g, '\n');

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const textOf = (node: unknown): string => {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return textOf((node as { children?: unknown }).children ?? null);
};
const text = (r: Renderer): string => textOf(r.toJSON());
const byId = (r: Renderer, id: string): TestNode[] => r.root.findAll((n) => n.props.testID === id);
const press = (n: TestNode | undefined): void => { (n?.props.onPress as () => void)(); };
const byLabel = (r: Renderer, label: string): TestNode | undefined =>
  r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];

let renderer: Renderer | null = null;
const mount = async (el: React.ReactElement): Promise<Renderer> => {
  await act(async () => {
    renderer = create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>
          <PortalHost>
            <ConfirmProvider>{el}</ConfirmProvider>
          </PortalHost>
        </ThemeProvider>
      </SafeAreaProvider>,
    );
  });
  return renderer as unknown as Renderer;
};
const page = (): React.ReactElement => (
  <PositionsScreen navigation={{ navigate: jest.fn() } as never} route={{ key: 'Positions', name: 'Positions' } as never} />
);

beforeEach(() => {
  mockBook.positions = [mockPosition, mockShort];
  mockBook.orders = [mockOrder];
  for (const k of Object.keys(mockPrices)) delete mockPrices[k];
});
afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = null;
  jest.clearAllMocks();
});

describe('the Positions page — Positions.jsx', () => {
  it('its title and subtitle, word for word', async () => {
    const r = await mount(page());
    expect(PAGE).toContain('Everything currently open, and orders still waiting to trigger. Close or cancel from here.');
    expect(text(r)).toContain('Positions');
    expect(text(r)).toContain('Everything currently open, and orders still waiting to trigger. Close or cancel from here.');
  });

  it('reads every account\'s positions and pending orders, side by side', async () => {
    const r = await mount(page());
    expect(fetchPositions).toHaveBeenCalledWith({ accountId: null });
    expect(fetchOpenOrders).toHaveBeenCalledWith({ accountId: null });
    expect(byId(r, 'positions-position-p1').length).toBeGreaterThan(0);
    expect(byId(r, 'positions-position-p2').length).toBeGreaterThan(0);
  });

  it('closes a position — no body, then re-reads the book', async () => {
    const r = await mount(page());
    mockBook.positions = [mockShort];
    await act(async () => { press(byLabel(r, 'Close position')); });
    expect(closePosition).toHaveBeenCalledWith('p1');
    expect(byId(r, 'positions-position-p1')).toHaveLength(0);
    expect(byId(r, 'positions-position-p2').length).toBeGreaterThan(0);
  });

  it('the Pending tab lists the orders; Cancel cancels one', async () => {
    const r = await mount(page());
    await act(async () => { press(byId(r, 'positions-tab-orders')[0]); });
    expect(byId(r, 'positions-order-o1').length).toBeGreaterThan(0);
    await act(async () => { press(byLabel(r, 'Cancel order')); });
    expect(cancelOrder).toHaveBeenCalledWith('o1');
  });

  it('nothing open: the web\'s empty line', async () => {
    mockBook.positions = [];
    mockBook.orders = [];
    const r = await mount(page());
    expect(text(r)).toContain('No open positions');
    expect(text(r)).toContain('Place an order and it will appear here.');
    await act(async () => { press(byId(r, 'positions-tab-orders')[0]); });
    expect(text(r)).toContain('No pending orders');
    expect(text(r)).toContain('Limit and stop orders waiting to trigger appear here.');
  });
});

describe('PositionsPanel — components/PositionsPanel.jsx', () => {
  it('scoped to one symbol (the instrument page\'s Positions tab)', async () => {
    const r = await mount(<PositionsPanel symbol="TCS" testID="stock-positions" />);
    expect(byId(r, 'stock-positions-position-p2').length).toBeGreaterThan(0);
    expect(byId(r, 'stock-positions-position-p1')).toHaveLength(0);
    await act(async () => { press(byId(r, 'stock-positions-tab-orders')[0]); });
    expect(text(r)).toContain('Pending orders in TCS will appear here.');
  });

  it('marks to market at the live tick', async () => {
    mockPrices.RELIANCE = 2520;
    const r = await mount(<PositionsPanel testID="pp" />);
    // The Market column shows the tick; the server's 2505 is gone.
    expect(text(r)).toContain('2520');
    expect(text(r)).not.toContain('2505');
  });

  it('P&L: the live mark, else the server\'s, else the entry — as the web\'s pnlOf', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const pnlOf = new Function('priceMap', `${PANEL.slice(PANEL.indexOf('  const pnlOf = (p) => {'), PANEL.indexOf('  const closePosition = async')).trim()}\nreturn pnlOf;`) as (m: Record<string, number>) => (p: unknown) => number;
    const cases: Array<[typeof mockPosition, Record<string, number>]> = [
      [mockPosition, {}],
      [mockPosition, { RELIANCE: 2480 }],
      [mockShort, { TCS: 3800 }],
      [{ ...mockPosition, markPrice: null as never }, {}],
    ];
    for (const [p, m] of cases) expect(panelPnl(p as never, m)).toBe(pnlOf(m)(p));
    expect(panelPnl(mockPosition as never, { RELIANCE: 2520 })).toBe(200);
  });

  it('empty copy, word for word', () => {
    for (const [tab, sym] of [['positions', null], ['positions', 'NIFTY'], ['orders', null], ['orders', 'NIFTY']] as const) {
      const e = panelEmpty(tab, sym);
      expect(PANEL).toContain(e.title);
      expect(PANEL).toContain(sym ? e.hint.replace(sym, '${symbol}') : e.hint);
    }
    expect(PANEL).toContain("toast.success('Position closing')");
    expect(PANEL).toContain("toast.success('Order cancelled')");
  });
});
