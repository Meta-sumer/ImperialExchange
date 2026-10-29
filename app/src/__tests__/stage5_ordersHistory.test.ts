/**
 * Trade History (screens/orders/ordersLogic) and the market-session banner
 * (utils/marketSession) — against EquityHub's own client/src/pages/Orders.jsx
 * and client/src/utils/marketSession.js, lifted and run on the same inputs.
 */
import fs from 'fs';
import path from 'path';

import {
  CSV_HEADERS,
  STATUS_OPTIONS,
  closeReasonFor,
  emptyText,
  executedBy,
  fmtLot,
  formatDateTime,
  historyQueryFor,
  orderRemark,
  remarkFor,
  remarkText,
  showingText,
  summaryTiles,
  ticketShort,
  viewFor,
} from '@/screens/orders/ordersLogic';
import { getMarketSession } from '@/utils/marketSession';
import { FILTERABLE_CLOSE_REASONS } from '@/types/trading';

const ROOT = path.join(__dirname, '../../..');
const readLf = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const ORDERS = readLf('client/src/pages/Orders.jsx');
const SESSION = readLf('client/src/utils/marketSession.js');
const TICKET = readLf('client/src/utils/ticket.js');
const between = (src: string, start: string, end: string): string => {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`slice start moved: ${start}`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`slice end moved: ${end}`);
  return src.slice(a, b);
};
const fnSrc = (src: string, name: string): string => `${between(src, `function ${name}(`, '\n}\n')}\n}\n`;
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const lift = <T,>(params: string[], body: string): T => new Function(...params, body) as unknown as T;

const WEB = lift<() => {
  STATUS_OPTIONS: { value: string; label: string; group?: string }[];
  RECORD_TYPES: Set<string>;
  remarkText: (r: unknown) => string;
  orderRemark: (o: unknown) => string;
  formatDateTime: (iso: unknown) => string;
  fmtLot: (q: unknown) => string;
}>(
  [],
  `${between(ORDERS, 'const TRADE_GROUP = ', 'const STATUS_GROUPS')}
   ${between(ORDERS, 'const RECORD_TYPES = ', ';\n')};
   ${fnSrc(ORDERS, 'remarkText')}${fnSrc(ORDERS, 'orderRemark')}${fnSrc(ORDERS, 'formatDateTime')}${fnSrc(ORDERS, 'fmtLot')}
   return { STATUS_OPTIONS, RECORD_TYPES, remarkText, orderRemark, formatDateTime, fmtLot };`,
)();

describe('the Status filter — Orders.jsx STATUS_OPTIONS', () => {
  it('the same options, wording and groups', () => {
    expect(STATUS_OPTIONS.map((o) => ({ ...o }))).toEqual(WEB.STATUS_OPTIONS);
  });
  it('every close reason it offers is one the server filters on', () => {
    const reasons = STATUS_OPTIONS.map((o) => o.value).filter((v) => v && !WEB.RECORD_TYPES.has(v));
    for (const r of reasons) expect(FILTERABLE_CLOSE_REASONS).toContain(r);
  });
  it.each(STATUS_OPTIONS.map((o) => o.value))('%j → the record set and close reason the web asks for', (status) => {
    const webView = WEB.RECORD_TYPES.has(status) ? status : (status ? 'closed' : 'all');
    const webReason = WEB.RECORD_TYPES.has(status) ? '' : status;
    expect(viewFor(status)).toBe(webView);
    expect(closeReasonFor(status)).toBe(webReason);
    expect(showingText(3, 9, status)).toBe(`Showing 3 of 9 ${webView === 'closed' ? 'trades' : webView === 'all' ? 'records' : 'orders'}`);
  });
  it('empty lines, word for word', () => {
    for (const s of ['', 'closed', 'cancelled', 'rejected']) expect(ORDERS).toContain(`'${emptyText(s)}'`);
    expect(ORDERS).toContain("`No closed trades matched ${STATUS_OPTIONS.find((o) => o.value === closeReasonFilter)?.label || 'that status'}.`");
    expect(emptyText('STOP_LOSS')).toBe('No closed trades matched Stop Loss.');
  });
});

describe('the query — GET /trading/history', () => {
  const base = { accountId: 'a1', type: 'all' as const, symbol: '', side: '' as const, status: '', range: { period: null, fromDate: '', toDate: '' }, page: 1 };
  it('a close reason implies closed trades and is sent as closeReason', () => {
    expect(historyQueryFor({ ...base, status: 'STOP_OUT' } as never, [])).toEqual({ page: 1, limit: 30, recordType: 'closed', closeReason: 'STOP_OUT', accountId: 'a1' });
  });
  it('a record set is sent as recordType alone; dates and filters as given', () => {
    expect(historyQueryFor({ ...base, status: 'rejected', symbol: 'TCS', side: 'SELL', range: { period: 'custom', fromDate: '2026-10-01', toDate: '2026-10-05' } } as never, []))
      .toEqual({ page: 1, limit: 30, recordType: 'rejected', symbol: 'TCS', side: 'SELL', from: '2026-10-01', to: '2026-10-05', accountId: 'a1' });
  });
  it('"All" with a type filter asks for those accounts — or nothing when there are none', () => {
    expect(historyQueryFor({ ...base, accountId: 'all', type: 'DEMO' } as never, [{ id: 'd1' }, { id: 'd2' }])).toMatchObject({ accountIds: ['d1', 'd2'] });
    expect(historyQueryFor({ ...base, accountId: 'all', type: 'DEMO' } as never, [])).toBeNull();
  });
});

describe('cells — Orders.jsx', () => {
  it.each([...FILTERABLE_CLOSE_REASONS, 'EXPIRY', 'INTRADAY_SQUAREOFF', 'COPY_MASTER_CLOSED', 'SOMETHING_NEW', null])('remark for %j', (reason) => {
    expect(remarkText(reason)).toBe(WEB.remarkText(reason));
    expect(remarkFor({ kind: 'TRADE', closeReason: reason, rejectionReason: null, status: 'CLOSED' })).toBe(WEB.remarkText(reason));
  });
  it.each([
    [{ rejectionReason: 'SEGMENT_DISABLED', status: 'REJECTED' }],
    [{ rejectionReason: null, status: 'REJECTED' }],
    [{ rejectionReason: null, status: 'CANCELLED' }],
  ])('an order that never opened: %j', (o) => {
    expect(orderRemark(o)).toBe(WEB.orderRemark(o));
    expect(remarkFor({ kind: 'ORDER', closeReason: null, ...o })).toBe(WEB.orderRemark(o));
  });
  it('who closed it: ADMIN, else SELF', () => {
    expect([executedBy({ closeReason: 'ADMIN' }), executedBy({ closeReason: 'STOP_LOSS' }), executedBy({ closeReason: null })]).toEqual(['ADMIN', 'SELF', 'SELF']);
  });
  it.each(['2026-10-01T09:05:07Z', '2026-12-31T23:59:59Z', null, 'garbage'])('date %j', (iso) => {
    expect(formatDateTime(iso)).toBe(WEB.formatDateTime(iso));
  });
  it.each([0, 1, 0.5, 0.009, 0.0009, 0.00009, 75, '12.345', 'x'])('lot %j', (q) => {
    expect(fmtLot(q as never)).toBe(WEB.fmtLot(q));
  });
  it('the ticket — utils/ticket.js', () => {
    expect(TICKET).toContain('slice(-6).toUpperCase()');
    expect(ticketShort('66f0a1b2c3d4e5f6a7b8c9d0')).toBe('#B8C9D0');
  });
  it('the summary strip — StatCards, in rupees', () => {
    expect(summaryTiles({ totalTrades: 9, totalLot: 1.5, netPnl: -2.5, wins: 4, losses: 5 }).map((t) => [t.label, t.value]))
      .toEqual([['Total Trades', '9.00'], ['Total Lot', '1.50'], ['Loaded Wins', '4.00'], ['Loaded Losses', '5.00'], ['Net P/L', '-₹2.50']]);
    expect(ORDERS).toContain("value={`${summary.netPnl >= 0 ? '+' : '-'}₹${Math.abs(Number(summary.netPnl)).toFixed(2)}`}");
  });
  it('the CSV columns', () => {
    const web = lift<() => string[]>([], `return [${between(ORDERS, 'const headers = [', '];')}];`.replace('return [const headers = [', 'return ['))();
    expect([...CSV_HEADERS]).toEqual(web);
  });
});

describe('the market session — utils/marketSession.js', () => {
  const webSession = lift<() => (arg: unknown) => { isOpen: boolean; label: string; detail?: string; tz: string }>(
    [],
    `${SESSION.replace(/^export /gm, '')}\nreturn getMarketSession;`,
  )();
  const rows = [
    { exchange: 'NSE', category: 'STOCK' },
    { exchange: 'BSE', category: 'STOCK' },
    { exchange: 'NFO', category: 'INDEX' },
    { exchange: 'BFO', category: 'INDEX' },
    { exchange: 'MCX', category: 'COMMODITY' },
    { exchange: '', category: 'INDEX' },
    'COMMODITY',
    null,
  ];
  // IST = UTC + 05:30. Wednesday 30 Sep 2026 and a Saturday.
  const instants = [
    '2026-09-30T03:00:00Z', // 08:30 IST — before MCX and NSE
    '2026-09-30T03:40:00Z', // 09:10 IST — MCX open, NSE pre-open
    '2026-09-30T06:00:00Z', // 11:30 IST — both open
    '2026-09-30T10:05:00Z', // 15:35 IST — NSE closed, MCX open
    '2026-09-30T18:05:00Z', // 23:35 IST — both closed
    '2026-10-03T06:00:00Z', // Saturday
  ];
  afterEach(() => { jest.useRealTimers(); });
  it.each(instants)('%s — every exchange as the web', (iso) => {
    jest.useFakeTimers({ now: new Date(iso) });
    for (const r of rows) expect(getMarketSession(r as never, new Date(iso))).toEqual(webSession(r));
  });
  it('MCX keeps its own hours', () => {
    expect(getMarketSession({ exchange: 'MCX' }, new Date('2026-09-30T10:05:00Z'))).toEqual({ isOpen: true, label: 'MCX open', tz: 'IST' });
    expect(getMarketSession({ exchange: 'MCX' }, new Date('2026-09-30T18:05:00Z'))).toEqual({ isOpen: false, label: 'Market Closed', detail: 'MCX closes 23:30 IST', tz: 'IST' });
  });
});
