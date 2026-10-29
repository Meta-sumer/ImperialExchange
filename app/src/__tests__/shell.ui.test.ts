/**
 * The UI kit's pure halves: toasts, confirm defaults, the asset-icon
 * decision, flags, the error id, the overlay order, and the chrome's
 * balance and account labels. None of these render; all of them decide
 * something a user reads.
 */
import { resolveAssetIcon, inferBaseFromSymbol, tileColor } from '@/components/ui/assetIconResolve';
import { flagCode } from '@/components/ui/CountryFlag';
import { normaliseConfirm } from '@/components/ui/ConfirmProvider';
import { errorIdFor } from '@/components/ui/ErrorBoundary';
import { orderEntries } from '@/components/ui/Portal';
import { filterOptions } from '@/components/ui/Select';
import {
  DEFAULT_DURATION,
  TOAST_LIMIT,
  orderToast,
  removeToast,
  toast,
  toastStore,
  upsertToast,
  type ToastItem,
} from '@/components/ui/toast';
import { accountChip, accountSubline, formatAccountLabel, initialsFor } from '@/navigation/chrome/accountRows';
import { balanceLabel, equityByAccount, type AccountEquity } from '@/navigation/chrome/headerBalance';
import { buildTheme } from '@/theme/tokens';

// The theme runtime reads the saved theme from AsyncStorage, whose native
// module does not exist under jest.
jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'));

/* ── toast ───────────────────────────────────────────────────────────── */

const item = (id: string, over: Partial<ToastItem> = {}): ToastItem => ({
  id, type: 'blank', message: id, icon: null, duration: 4000, dismissButton: false, createdAt: 0, ...over,
});

describe('toast list', () => {
  it('puts the newest first and replaces an existing id in place', () => {
    let list = upsertToast([], item('a'));
    list = upsertToast(list, item('b'));
    expect(list.map((t) => t.id)).toEqual(['b', 'a']);
    list = upsertToast(list, item('a', { type: 'success', message: 'done' }));
    expect(list.map((t) => t.id)).toEqual(['b', 'a']);
    expect(list[1]).toMatchObject({ type: 'success', message: 'done' });
  });

  it('caps at react-hot-toast’s limit', () => {
    let list: ToastItem[] = [];
    for (let i = 0; i < TOAST_LIMIT + 5; i++) list = upsertToast(list, item(`t${i}`));
    expect(list).toHaveLength(TOAST_LIMIT);
    expect(list[0]?.id).toBe(`t${TOAST_LIMIT + 4}`);
  });

  it('removes one, or all', () => {
    const list = [item('a'), item('b')];
    expect(removeToast(list, 'a').map((t) => t.id)).toEqual(['b']);
    expect(removeToast(list)).toEqual([]);
  });
});

describe('toast API', () => {
  beforeEach(() => { jest.useFakeTimers(); toast.dismiss(); });
  afterEach(() => { toast.dismiss(); jest.useRealTimers(); });

  it('uses react-hot-toast’s default durations', () => {
    expect(DEFAULT_DURATION).toEqual({ blank: 4000, error: 4000, success: 2000, loading: Infinity });
    toast.success('Saved');
    toast.error('Nope');
    expect(toastStore.getState().toasts).toHaveLength(2);
    jest.advanceTimersByTime(2000);
    expect(toastStore.getState().toasts.map((t) => t.message)).toEqual(['Nope']);
    jest.advanceTimersByTime(2000);
    expect(toastStore.getState().toasts).toHaveLength(0);
  });

  it('turns a loading toast into a result through its id', () => {
    const id = toast.loading('Saving…');
    jest.advanceTimersByTime(60_000);
    expect(toastStore.getState().toasts[0]).toMatchObject({ id, type: 'loading' });
    toast.success('Saved', { id });
    expect(toastStore.getState().toasts).toHaveLength(1);
    expect(toastStore.getState().toasts[0]).toMatchObject({ id, type: 'success', message: 'Saved' });
    jest.advanceTimersByTime(2000);
    expect(toastStore.getState().toasts).toHaveLength(0);
  });

  it('honours a custom duration and an icon', () => {
    toast('Enter your 2FA code', { icon: '🔐', duration: 5000 });
    expect(toastStore.getState().toasts[0]).toMatchObject({ icon: '🔐', type: 'blank' });
    jest.advanceTimersByTime(4999);
    expect(toastStore.getState().toasts).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(toastStore.getState().toasts).toHaveLength(0);
  });

  it('orderToast is a 4s success with a dismiss button', () => {
    orderToast('Order placed');
    expect(toastStore.getState().toasts[0]).toMatchObject({ type: 'success', duration: 4000, dismissButton: true });
  });
});

/* ── confirm ─────────────────────────────────────────────────────────── */

describe('confirm defaults — ConfirmProvider.jsx:25-31', () => {
  it('takes a bare string as the message', () => {
    expect(normaliseConfirm('Close all positions?')).toEqual({
      message: 'Close all positions?', title: 'Please confirm', confirmText: 'Confirm', cancelText: 'Cancel', danger: false,
    });
  });

  it('falls back to the web wording', () => {
    expect(normaliseConfirm()).toMatchObject({ message: 'Are you sure?', title: 'Please confirm' });
    expect(normaliseConfirm({ title: 'Delete?', danger: true, confirmText: 'Delete' }))
      .toMatchObject({ title: 'Delete?', danger: true, confirmText: 'Delete', cancelText: 'Cancel' });
  });
});

/* ── asset icons ─────────────────────────────────────────────────────── */

describe('AssetIcon decision — AssetIcon.jsx order', () => {
  it('infers the base by stripping the longest quote suffix', () => {
    expect(inferBaseFromSymbol('BTCUSDT')).toBe('BTC');
    expect(inferBaseFromSymbol('ETH/USD')).toBe('ETH');
    expect(inferBaseFromSymbol('usd')).toBe('USD');
    expect(inferBaseFromSymbol('')).toBe('');
  });

  it('lets an admin logo win, until it fails', () => {
    expect(resolveAssetIcon({ symbol: 'BTCUSD', logoUrl: 'https://x/logo.png' }).kind).toBe('logo');
    expect(resolveAssetIcon({ symbol: 'BTCUSD', logoUrl: 'https://x/logo.png' }, true).kind).toBe('crypto');
  });

  it('draws known coins from the CDN, even without a category', () => {
    expect(resolveAssetIcon({ symbol: 'BTCUSD' })).toMatchObject({
      kind: 'crypto', coin: 'btc', uri: expect.stringMatching(/\/btc\.svg$/),
    });
    // …but not a coin-looking symbol filed under another category.
    expect(resolveAssetIcon({ symbol: 'LINK', category: 'STOCK' }).kind).toBe('stockGlyph');
  });

  it('draws commodities from the underlying first', () => {
    expect(resolveAssetIcon({ symbol: 'GOLD26JULFUT', underlying: 'GOLD', category: 'FUTURE' }))
      .toEqual({ kind: 'commodity', icon: 'gold' });
    expect(resolveAssetIcon({ symbol: 'XAGUSD', category: 'COMMODITY' })).toEqual({ kind: 'commodity', icon: 'silver' });
  });

  it('pairs two flags for forex', () => {
    expect(resolveAssetIcon({ symbol: 'EURUSD', category: 'FOREX', baseCurrency: 'EUR', quoteCurrency: 'USD' }))
      .toEqual({ kind: 'forex', base: 'EUR', quote: 'USD' });
  });

  it('tints the four big indices as themselves and keeps global indices as text', () => {
    expect(resolveAssetIcon({ symbol: 'NIFTY', category: 'INDEX' }))
      .toEqual({ kind: 'indexGlyph', colors: ['#2563EB', '#1E40AF'] });
    expect(resolveAssetIcon({ symbol: 'NAS100', category: 'INDEX' })).toEqual({ kind: 'tile', glyph: 'NQ', bg: '#0EA5E9' });
  });

  it('gives every contract of an underlying the same colour', () => {
    const a = resolveAssetIcon({ symbol: 'SBIN24JUNFUT', underlying: 'SBIN', category: 'STOCK' });
    const b = resolveAssetIcon({ symbol: 'SBIN24JULFUT', underlying: 'SBIN', category: 'STOCK' });
    expect(a).toEqual(b);
    expect(tileColor('SBIN')).toEqual(tileColor('SBIN'));
  });

  it('falls back to a slate tile with a three-letter glyph', () => {
    expect(resolveAssetIcon({ symbol: 'XYZABC' })).toEqual({ kind: 'tile', glyph: 'XYZ', bg: '#475569' });
    expect(resolveAssetIcon({ symbol: '' })).toEqual({ kind: 'tile', glyph: '?', bg: '#475569' });
    expect(resolveAssetIcon({ symbol: 'ZINC', category: 'COMMODITY' })).toEqual({ kind: 'tile', glyph: 'Zn', bg: '#64748B' });
  });
});

describe('CountryFlag', () => {
  it('maps currencies and passes countries through', () => {
    expect(flagCode(null, 'usd')).toBe('us');
    expect(flagCode(null, 'EUR')).toBe('eu');
    expect(flagCode('GB')).toBe('gb');
    expect(flagCode(null, 'XYZ')).toBe('');
    expect(flagCode()).toBe('');
  });
});

/* ── misc kit ────────────────────────────────────────────────────────── */

describe('ErrorBoundary id — ErrorBoundary.jsx:18', () => {
  it('is stable, short and prefixed', () => {
    const webId = (m: string) =>
      `E-${Math.abs(Array.from(m).reduce((a, c) => (a << 5) - a + c.charCodeAt(0), 0)).toString(36).slice(0, 6).toUpperCase()}`;
    expect(errorIdFor('Cannot read properties of undefined')).toBe(webId('Cannot read properties of undefined'));
    expect(errorIdFor('x')).toMatch(/^E-[0-9A-Z]{1,6}$/);
    expect(errorIdFor('')).toBe('E-0');
  });
});

describe('overlay order', () => {
  it('sorts by layer, then by who opened first', () => {
    const order = orderEntries([
      { key: 'confirm', z: 1100, seq: 1 },
      { key: 'modalB', z: 1000, seq: 3 },
      { key: 'modalA', z: 1000, seq: 2 },
    ]).map((e) => e.key);
    expect(order).toEqual(['modalA', 'modalB', 'confirm']);
  });
});

describe('Select search', () => {
  it('matches label and description, case-insensitively', () => {
    const opts = [
      { value: 'a', label: 'Standard', description: 'USD · 100234' },
      { value: 'b', label: 'Pro', description: 'INR · 100999' },
    ];
    expect(filterOptions(opts, 'pro').map((o) => o.value)).toEqual(['b']);
    expect(filterOptions(opts, '100234').map((o) => o.value)).toEqual(['a']);
    expect(filterOptions(opts, '  ')).toBe(opts);
  });
});

describe('theme', () => {
  it('builds both palettes with the web surfaces', () => {
    expect(buildTheme('light').colors.surface).toBe('#FFFFFF');
    // index.css:139 — bg-white becomes the card colour in dark mode.
    expect(buildTheme('dark').colors.surface).toBe('#161B22');
    expect(buildTheme('dark').colors.primary).toBe('#1D4ED8');
  });
});

/* ── chrome labels ───────────────────────────────────────────────────── */

describe('account switcher labels — EquityHub Layout.jsx', () => {
  it('prefers the nickname, then the title-cased type', () => {
    expect(formatAccountLabel({ accountType: 'STANDARD_IC', nickname: 'Swing' })).toBe('Swing');
    expect(formatAccountLabel({ accountType: 'standard_ic' })).toBe('STANDARD IC');
    expect(formatAccountLabel({ accountType: '' })).toBe('Account');
    expect(formatAccountLabel(null)).toBe('');
  });

  it('writes the sub-line and the chip', () => {
    // ['INR', a.accountNumber, accountTierLabel(a)] — every account is INR.
    expect(accountSubline({ baseCurrency: 'USD', accountNumber: '100234', accountType: 'PRO_IC' })).toBe('INR · 100234 · Pro IC');
    expect(accountSubline({ accountType: 'DEMO' })).toBe('INR · Standard');
    expect(accountSubline({ accountType: 'DEMO', accountNumber: '9', tierCode: 'FREE' })).toBe('INR · 9 · Free');
    expect(accountSubline({ accountType: 'CUSTOM', customTypeName: 'VIP', accountNumber: '7' })).toBe('INR · 7 · VIP');
    expect(accountChip({ accountType: 'VIRTUAL' })).toBe('DEMO');
    // PORT-RULINGS §3: a modern live tier is LIVE, not "not REAL".
    expect(accountChip({ accountType: 'STANDARD' })).toBe('LIVE');
  });

  it('builds initials the web way', () => {
    expect(initialsFor('Ada', 'Lovelace')).toEqual({ fullName: 'Ada Lovelace', initials: 'AL' });
    expect(initialsFor(null, null)).toEqual({ fullName: 'Trader', initials: 'T' });
    expect(initialsFor('Cher', null).initials).toBe('C');
  });
});

describe('profile menu balance — Layout.jsx /wallet/equity', () => {
  const row = (accountId: string, equity: string, balance = equity): AccountEquity => ({
    accountId, currency: 'INR', balance, unrealizedPnl: '0', equity, usedMargin: '0', free: balance,
    freeMargin: equity, marginLevel: null, status: 'ACTIVE', stoppedOut: false,
  });

  it('a dash until the first read lands', () => {
    expect(balanceLabel(null, 'a1')).toBe('—');
  });

  it('shows the SELECTED account floating balance, in rupees', () => {
    const list = [row('a1', '125000.5'), row('a2', '99')];
    expect(balanceLabel(list, 'a1')).toBe('₹1,25,000.50');
    expect(balanceLabel(list, 'a2')).toBe('₹99.00');
    // An account with no wallet row sums nothing.
    expect(balanceLabel(list, 'zz')).toBe('₹0.00');
  });

  it('per account, for the switch-account rows', () => {
    const m = equityByAccount([row('a1', '10'), row('a1', '5'), row('a2', '-3')]);
    expect([...m.entries()]).toEqual([['a1', 15], ['a2', -3]]);
    expect(equityByAccount(null).size).toBe(0);
  });
});
