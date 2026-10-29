/**
 * The bell's own generators (useNotifications.js): which socket events and
 * ticks become entries, in what words, and how often.
 */
import {
  DEFAULT_NOTIFICATION_PREFS,
  MAX_NOTIFICATIONS,
  addLocalNotification,
  bellEmptyText,
  bellRelativeTime,
  notificationSound,
  notificationsForTab,
  orderEventNotification,
  pnlBand,
  portfolioPnlNotification,
  positionEventNotification,
  priceAlertNotification,
  pushPriceSample,
  screenerNotification,
  isForAccount,
  statusDot,
  volatilityNotification,
  walletEventNotification,
  type BellNotification,
  type PriceSample,
} from '@/types/notifications';
import { portfolioFloatingPnl } from '@/components/chrome/notificationEngineLogic';

describe('socket-event generators — EquityHub useNotifications.js', () => {
  it('rings for the order events the server tags, never for an UPDATED tick', () => {
    expect(orderEventNotification({ event: 'UPDATED', symbol: 'TCS' })).toBeNull();
    // MetaTrading's `action` field is not what EquityHub's server sends.
    expect(orderEventNotification({ action: 'filled', symbol: 'TCS' })).toBeNull();
    expect(orderEventNotification({ event: 'FILLED', accountId: 'a1', orderId: 'o1', symbol: 'RELIANCE' }))
      .toEqual({
        type: 'ORDER', title: 'Order filled · RELIANCE', message: 'Your order status changed',
        status: 'success', link: '/reports', symbol: 'RELIANCE',
      });
    expect(orderEventNotification({ event: 'CANCELLED', reason: 'CONTRACT_EXPIRED', symbol: 'NIFTY27OCT2625000CE' }))
      .toMatchObject({ title: 'Order cancelled · NIFTY27OCT2625000CE', status: 'warning' });
    expect(orderEventNotification({ event: 'STOP_TRIGGERED', order: { symbol: 'TCS' } }))
      .toMatchObject({ title: 'Order triggered · TCS', status: 'info' });
    expect(orderEventNotification({ event: 'OCO_CANCELLED' })).toMatchObject({ title: 'Order cancelled', symbol: null });
  });

  it('rings when a position is closed — by its event or, for a manual close, its reason', () => {
    expect(positionEventNotification({ event: 'UPDATED' })).toBeNull();
    expect(positionEventNotification({ event: 'TAKE_PROFIT', symbol: 'INFY' }))
      .toEqual({ type: 'TRADING', title: 'Position closed · INFY', message: 'Your position closed', status: 'success', link: '/trade?symbol=INFY', symbol: 'INFY' });
    expect(positionEventNotification({ event: 'STOP_LOSS', symbol: 'M&M' })).toMatchObject({ status: 'warning', link: '/trade?symbol=M%26M' });
    expect(positionEventNotification({ event: 'MARGIN_STOPOUT', symbol: 'TCS' })).toMatchObject({ status: 'error' });
    expect(positionEventNotification({ event: 'INTRADAY_SQUAREOFF', symbol: 'TCS' })).toMatchObject({ status: 'info' });
    expect(positionEventNotification({ reason: 'POSITION_CLOSED', positionId: 'p1' })).toMatchObject({ title: 'Position closed', status: 'info' });
  });

  it('drops an order or position event for another account; keeps untagged ones', () => {
    expect(isForAccount({ accountId: 'a1' }, 'a1')).toBe(true);
    expect(isForAccount({ accountId: 'a2' }, 'a1')).toBe(false);
    expect(isForAccount({ accountId: null }, 'a1')).toBe(true);
    expect(isForAccount({}, 'a1')).toBe(true);
    expect(isForAccount({ accountId: 'a2' }, null)).toBe(true);
  });

  it('rings for a wallet transaction in rupees, never a rebalance tick', () => {
    expect(walletEventNotification({ action: 'updated' })).toBeNull();
    expect(walletEventNotification({ action: 'Deposit', amount: 125000 }))
      .toMatchObject({ title: 'Wallet deposit', message: '+₹1,25,000.00', status: 'success', link: '/wallet' });
    expect(walletEventNotification({ action: 'WITHDRAWAL', amount: -40 }))
      .toMatchObject({ message: '-₹40.00', status: 'info' });
  });
});

describe('tick-driven generators', () => {
  it('fires a price alert on the crossing side only', () => {
    const a = { id: 'a1', symbol: 'EURUSD', direction: 'ABOVE', targetPrice: 1.1, note: 'breakout' };
    expect(priceAlertNotification(a, 1.0999)).toBeNull();
    expect(priceAlertNotification(a, 1.1002)).toMatchObject({
      title: 'EURUSD crossed above 1.1', message: 'Now at 1.1002 · breakout', type: 'PRICE_ALERT',
    });
    expect(priceAlertNotification({ ...a, direction: 'BELOW' }, 1.2)).toBeNull();
    expect(priceAlertNotification({ ...a, targetPrice: null }, 2)).toBeNull();
  });

  it('keeps five minutes of samples and flags a 2% move once per cooldown', () => {
    let hist: PriceSample[] = [];
    const t0 = 1_000_000;
    [100, 100.5, 101, 101.5, 102.1].forEach((price, i) => { hist = pushPriceSample(hist, { ts: t0 + i * 10_000, price }); });
    const now = t0 + 40_000;
    expect(volatilityNotification('ETH', hist, now, 0)).toMatchObject({ title: 'ETH surged 2.10% in 5 min', message: 'Live: 102.1' });
    expect(volatilityNotification('ETH', hist, now, now - 60_000)).toBeNull();
    expect(volatilityNotification('ETH', hist.slice(0, 4), now, 0)).toBeNull();
    const later = pushPriceSample(hist, { ts: t0 + 6 * 60_000, price: 102 });
    // Six minutes on, every earlier sample has left the window.
    expect(later).toEqual([{ ts: t0 + 6 * 60_000, price: 102 }]);
  });

  it('rings when a symbol ENTERS a ±5% band', () => {
    expect(screenerNotification('TCS', 5.2, 0, 10 ** 9, 0)).toMatchObject({ title: 'TCS on the top gainers list', message: '+5.20% today' });
    expect(screenerNotification('TCS', 6, 1, 10 ** 9, 0)).toBeNull();
    expect(screenerNotification('TCS', -7, 0, 10 ** 9, 0)).toMatchObject({ title: 'TCS on the top losers list', status: 'error' });
    expect(screenerNotification('TCS', 3, 0, 10 ** 9, 0)).toBeNull();
    expect(screenerNotification('TCS', 5.2, 0, 10 ** 9, 10 ** 9 - 60_000)).toBeNull();
  });

  it('crosses the rupee P&L bands (₹10k / ₹50k / ₹1L) once each', () => {
    expect(pnlBand(0)).toBe(0);
    expect(pnlBand(9999.99)).toBe(0);
    expect(pnlBand(75000)).toBe(50000);
    expect(pnlBand(-120000)).toBe(-100000);
    expect(portfolioPnlNotification(12000, 0)).toMatchObject({ title: 'Portfolio PnL crossed +₹10,000', message: 'Live total: +₹12,000.00' });
    expect(portfolioPnlNotification(13000, 10000)).toBeNull();
    expect(portfolioPnlNotification(-51000, 10000)).toMatchObject({ title: 'Portfolio PnL crossed -₹50,000', message: 'Live total: -₹51,000.00', status: 'error' });
    expect(portfolioPnlNotification(150000, 50000)).toMatchObject({ title: 'Portfolio PnL crossed +₹1,00,000' });
  });

  it('the band check re-marks a ticked position at its last tick, else keeps the server figure', () => {
    const pos = [
      { symbol: 'TCS', side: 'BUY' as const, entryPrice: '3000', quantity: '10', unrealizedPnl: '5' },
      { symbol: 'INFY', side: 'SELL' as const, entryPrice: '1500', quantity: '4', unrealizedPnl: '-8' },
    ];
    const history = new Map([['TCS', [{ ts: 1, price: 3050 }]]]);
    // TCS: (3050 − 3000) × 10 = 500, re-marked; INFY: not ticked → server's −8.
    expect(portfolioFloatingPnl(pos, history)).toBe(492);
    expect(portfolioFloatingPnl([], history)).toBeNull();
  });
});

describe('raising an entry', () => {
  const input = { type: 'ORDER' as const, title: 'Order filled · TCS', message: 'BUY 1 TCS', status: 'success' };

  it('drops the same type+title within 30s, and honours the switches', () => {
    const seen = new Map<string, number>();
    const one = addLocalNotification([], input, DEFAULT_NOTIFICATION_PREFS, seen, 1_000, () => 0.5);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ type: 'ORDER', read: false, link: null, symbol: null, timestamp: 1_000 });
    expect(addLocalNotification(one, input, DEFAULT_NOTIFICATION_PREFS, seen, 20_000)).toHaveLength(1);
    expect(addLocalNotification(one, input, DEFAULT_NOTIFICATION_PREFS, seen, 40_000)).toHaveLength(2);
    expect(addLocalNotification([], input, { ...DEFAULT_NOTIFICATION_PREFS, enableTrading: false }, new Map(), 0)).toHaveLength(0);
  });

  it('caps the list', () => {
    let list: BellNotification[] = [];
    const seen = new Map<string, number>();
    for (let i = 0; i < MAX_NOTIFICATIONS + 3; i += 1) {
      list = addLocalNotification(list, { type: 'ACCOUNT', title: `t${i}` }, DEFAULT_NOTIFICATION_PREFS, seen, i);
    }
    expect(list).toHaveLength(MAX_NOTIFICATIONS);
    expect(list[0]?.title).toBe(`t${MAX_NOTIFICATIONS + 2}`);
  });

  it('asks for the right sound', () => {
    expect(notificationSound({ type: 'VOLATILITY', title: 'x' })).toBe('alert');
    expect(notificationSound(input)).toBe('tpsl');
    expect(notificationSound({ type: 'TRADING', title: 'Position opened · TCS' })).toBeNull();
    expect(notificationSound({ type: 'TRADING', title: 'SL hit on TCS' })).toBe('tpsl');
  });

  it('filters by tab and formats the list furniture', () => {
    const seen = new Map<string, number>();
    let list = addLocalNotification([], input, DEFAULT_NOTIFICATION_PREFS, seen, 0);
    list = addLocalNotification(list, { type: 'SCREENER', title: 's' }, DEFAULT_NOTIFICATION_PREFS, seen, 0);
    expect(notificationsForTab(list, 'Markets').map((n) => n.type)).toEqual(['SCREENER']);
    expect(notificationsForTab(list, 'All')).toHaveLength(2);
    expect(bellRelativeTime(0, 0)).toBe('1s ago');
    expect(bellRelativeTime(0, 90_000)).toBe('1m ago');
    expect(bellRelativeTime(0, 26 * 3_600_000)).toBe('1d ago');
    expect(statusDot('mystery')).toBe('#94A3B8');
    expect(bellEmptyText('Markets')).toBe('No markets notifications yet.');
  });
});
