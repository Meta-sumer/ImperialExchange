/**
 * Copy trading — the adapters and the pure logic behind the screens, plus
 * the request shapes the API module sends. No network: axios is given a
 * local adapter that records each call and answers from a table.
 */
import fs from 'fs';
import path from 'path';

import type { InternalAxiosRequestConfig } from 'axios';

import { api } from '@/api/client';
import { copyTradingApi } from '@/api/copyTrading.api';
import {
  analyticsPresetRange,
  boxVisibilityToast,
  computeBadges,
  copyAnalyticsCsv,
  copySettingsFromRelation,
  copySettingsPayload,
  defaultCopySettings,
  deleteBoxConfirmText,
  earningsGate,
  toMasterEarnings,
  transferErrorText,
  equityRangeSummary,
  feedEventText,
  feeInputToPayload,
  feedShowsPnl,
  filterEquityCurve,
  filterLeaders,
  filterMyCopies,
  firstFreeAccount,
  fmtAumCompact,
  fmtDuration,
  formatElapsed,
  sortMyCopies,
  toEligibleAccount,
  traderRelTime,
  validateProfileForm,
  toCopyAnalytics,
  toCopyBox,
  toCopyRelation,
  toFeedEvent,
  toLeaderboardEntry,
  toPaged,
  toTraderAnalytics,
  toTraderClosedTrade,
  toTraderOpenPosition,
  traderHistoryParams,
  validateBoxForm,
  validateCopySettings,
  type CopyBox,
} from '@/types/copyTrading';

const ROOT = path.join(__dirname, '../../..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
/** EquityHub's web pages and server. */
const DASHBOARD = read('client/src/pages/TraderDashboard.jsx');
const COPY_PAGE = read('client/src/pages/CopyTrade.jsx');

/* ── A recording adapter in place of the network ──────────────────────── */

type Call = { method: string; url: string; params: Record<string, unknown>; data: unknown };
const calls: Call[] = [];
let reply: (c: Call) => unknown = () => ({ success: true, data: null });

beforeAll(() => {
  api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const call: Call = {
      method: String(config.method ?? 'get').toUpperCase(),
      url: String(config.url ?? ''),
      params: (config.params ?? {}) as Record<string, unknown>,
      data: typeof config.data === 'string' ? JSON.parse(config.data) : config.data,
    };
    calls.push(call);
    return { data: reply(call), status: 200, statusText: 'OK', headers: {}, config };
  };
});

beforeEach(() => {
  calls.length = 0;
  reply = () => ({ success: true, data: null });
});

const lastCall = (): Call => {
  const c = calls[calls.length - 1];
  if (!c) throw new Error('no request was made');
  return c;
};

/* ── Boxes: the two fee fields ────────────────────────────────────────── */

describe('copy boxes', () => {
  it('reads the owner list fee as an OVERRIDE, never as the charged fee', () => {
    const box = toCopyBox({ _id: 'b1', performanceFeePercent: null, effectivePerformanceFee: 20 });
    expect(box.feeOverride).toBeNull();
    expect(box.effectiveFee).toBe(20);
  });

  it('reads the leaderboard fee as the RESOLVED fee', () => {
    const box = toLeaderboardEntry({ _id: 'b1', performanceFeePercent: 15 });
    expect(box.feeOverride).toBeNull();
    expect(box.effectiveFee).toBe(15);
  });

  it('computes the win rate with the server formula when it was not sent', () => {
    expect(toCopyBox({ totalTrades: 8, wins: 6 }).winRate).toBe(75);
    expect(toCopyBox({ totalTrades: 0, wins: 0 }).winRate).toBe(0);
    expect(toCopyBox({ winRate: 42, totalTrades: 8, wins: 6 }).winRate).toBe(42);
  });

  it('accepts populated refs and survives a missing body', () => {
    const box = toCopyBox({ userId: { _id: 'u1' }, accountId: 'a1' });
    expect(box.userId).toBe('u1');
    expect(box.accountId).toBe('a1');
    expect(toCopyBox(null).id).toBe('');
    expect(toCopyBox(null).cumulativePnl).toBe('0');
  });

  it('sends a blank fee as null, so clearing it resets to the default', () => {
    expect(feeInputToPayload('')).toBeNull();
    expect(feeInputToPayload('  ')).toBeNull();
    expect(feeInputToPayload('12.5')).toBe(12.5);
    expect(feeInputToPayload('abc')).toBeNull();
  });

  it('refuses to list a nameless box publicly', () => {
    expect(validateBoxForm({ displayName: ' ', isPublic: true })).toMatch(/name/);
    expect(validateBoxForm({ displayName: '', isPublic: false })).toBeNull();
  });

  it('words the archive confirmation by follower count', () => {
    const base = toCopyBox({ displayName: 'Alpha', followers: 3 });
    expect(deleteBoxConfirmText(base)).toContain('3 follower(s) will be stopped');
    expect(deleteBoxConfirmText({ ...base, followers: 0 })).toContain('moved to Archived');
  });
});

/* ── Leaderboard ──────────────────────────────────────────────────────── */

describe('leaderboard', () => {
  const mk = (o: Partial<CopyBox> & { id: string }): CopyBox => ({
    ...toLeaderboardEntry({}),
    ...o,
  });
  const list = [
    mk({ id: 'a', displayName: 'Alpha', bio: 'scalper', roiPct: 80, followers: 150, winRate: 60, totalTrades: 10, riskBadge: 'HIGH', createdAt: '2026-01-01' }),
    mk({ id: 'b', displayName: 'Beta', bio: 'swing', roiPct: 20, followers: 400, winRate: 50, totalTrades: 90, riskBadge: null, createdAt: '2026-06-01' }),
    mk({ id: 'c', displayName: 'Gamma', bio: 'news', roiPct: 5, followers: 10, winRate: 70, totalTrades: 5, riskBadge: 'LOW', createdAt: '2026-03-01' }),
  ];

  it('searches name and bio, filters risk (unbadged = MEDIUM) and sorts', () => {
    expect(filterLeaders(list, { query: 'SWING', risk: 'ALL', sortBy: 'roi' }).map((t) => t.id)).toEqual(['b']);
    expect(filterLeaders(list, { query: '', risk: 'MEDIUM', sortBy: 'roi' }).map((t) => t.id)).toEqual(['b']);
    expect(filterLeaders(list, { query: '', risk: 'ALL', sortBy: 'newest' }).map((t) => t.id)).toEqual(['b', 'c', 'a']);
    expect(filterLeaders(list, { query: '', risk: 'ALL', sortBy: 'followers' }).map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });

  it('gives each box at most one badge, first rule wins', () => {
    const badges = computeBadges(list);
    expect(badges.a?.label).toBe('Top Trader');
    expect(badges.b?.label).toBe('Most Followed');
    expect(badges.c?.label).toBe('Rising Star');
    expect(computeBadges([])).toEqual({});
  });
});

/* ── Follower sessions ────────────────────────────────────────────────── */

describe('copy relations', () => {
  it('defaults copySL/copyTP to ON when absent, as the web does', () => {
    const r = toCopyRelation({ _id: 'r1' });
    expect(r.copySL).toBe(true);
    expect(r.copyTP).toBe(true);
    expect(r.copyPending).toBe(false);
    expect(r.status).toBe('ACTIVE');
    expect(r.master).toBeNull();
    expect(r.openMirrors).toEqual([]);
  });

  it('keeps an explicit false and reads the live running P&L', () => {
    const r = toCopyRelation({ _id: 'r1', copySL: false, runningPnl: '-12.5', status: 'paused', master: { displayName: 'A', roiPct: '3.5' } });
    expect(r.copySL).toBe(false);
    expect(r.runningPnl).toBe('-12.5');
    expect(r.status).toBe('PAUSED');
    expect(r.master?.roiPct).toBe(3.5);
  });

  it('sorts live first and searches trader, account and status', () => {
    const list = [
      toCopyRelation({ _id: '1', status: 'STOPPED', master: { displayName: 'Zed' } }),
      toCopyRelation({ _id: '2', status: 'ACTIVE', followerAccountNumber: 'ACC-77' }),
      toCopyRelation({ _id: '3', status: 'PAUSED' }),
    ];
    expect(sortMyCopies(list).map((r) => r.id)).toEqual(['2', '3', '1']);
    expect(filterMyCopies(list, 'acc-77').map((r) => r.id)).toEqual(['2']);
    expect(filterMyCopies(list, 'zed').map((r) => r.id)).toEqual(['1']);
    expect(filterMyCopies(list, 'paused').map((r) => r.id)).toEqual(['3']);
  });
});

describe('copy settings form', () => {
  it('sends a blank max lot as NULL, never omitted', () => {
    const p = copySettingsPayload(defaultCopySettings());
    expect(p).toHaveProperty('maxLot', null);
    expect(p).not.toHaveProperty('customLot');
  });

  it('sends the custom lot only in CUSTOM mode', () => {
    const p = copySettingsPayload({ ...defaultCopySettings(), lotMode: 'CUSTOM', customLot: '0.25', maxLot: '2' });
    expect(p.customLot).toBe(0.25);
    expect(p.maxLot).toBe(2);
  });

  it('rejects a non-positive custom lot in the web words', () => {
    expect(validateCopySettings({ ...defaultCopySettings(), lotMode: 'CUSTOM', customLot: '0' }))
      .toBe('Enter a custom lot size greater than 0');
    expect(validateCopySettings(defaultCopySettings())).toBeNull();
  });

  it('starts the edit form from the session', () => {
    const s = copySettingsFromRelation(toCopyRelation({ lotMode: 'CUSTOM', customLot: 0.5, maxLot: null, copyTP: false }));
    expect(s).toMatchObject({ lotMode: 'CUSTOM', customLot: '0.5', maxLot: '', copyTP: false });
  });
});

/* ── Feed ─────────────────────────────────────────────────────────────── */

describe('live feed', () => {
  it('prefers the server note and shows P&L only on a close', () => {
    const open = toFeedEvent({ _id: 'e1', type: 'open', masterName: 'Alpha', symbol: 'NIFTY', pnl: 5 });
    expect(open.type).toBe('OPEN');
    expect(feedEventText(open)).toBe('Alpha open NIFTY');
    expect(feedShowsPnl(open)).toBe(false);
    const tp = toFeedEvent({ _id: 'e2', type: 'TP_HIT', note: 'Alpha hit TP', pnl: '12.3' });
    expect(feedEventText(tp)).toBe('Alpha hit TP');
    expect(feedShowsPnl(tp)).toBe(true);
    expect(toFeedEvent({ type: 'WEIRD' }).type).toBe('OPEN');
  });

  it('formats elapsed time like the web', () => {
    expect(formatElapsed(0)).toBe('1s ago');
    expect(formatElapsed(59_000)).toBe('59s ago');
    expect(formatElapsed(5 * 60_000)).toBe('5m ago');
    expect(formatElapsed(3 * 3_600_000)).toBe('3h ago');
    expect(formatElapsed(2 * 86_400_000)).toBe('2d ago');
  });
});

/* ── Trader dashboard + analytics ─────────────────────────────────────── */

describe('trader dashboard', () => {
  it('returns null for a body with no trader and no performance', () => {
    expect(toTraderAnalytics({})).toBeNull();
    expect(toTraderAnalytics(null)).toBeNull();
  });

  it('keeps absent statistics absent rather than zero', () => {
    const a = toTraderAnalytics({ trader: { userId: 'u1' }, performance: { totalTrades: 3 } });
    expect(a?.trader.displayName).toBe('Trader');
    expect(a?.performance.totalTrades).toBe(3);
    expect(a?.performance.profitFactor).toBeNull();
    expect(a?.risk.sharpe).toBeNull();
    expect(a?.charts.equityCurve).toEqual([]);
  });

  it('treats a zero stop as no stop', () => {
    const p = toTraderOpenPosition({ _id: 'p', entryPrice: '1.1', stopLoss: 0, takeProfit: '1.2' });
    expect(p.stopLoss).toBeNull();
    expect(p.takeProfit).toBe('1.2');
    expect(p.currentPrice).toBe('1.1');
    expect(toTraderClosedTrade({ _id: 't' }).exitPrice).toBeNull();
  });

  it('pages history tolerantly', () => {
    const pg = toPaged({ items: [{ _id: 'x' }], total: 11, page: 2, pages: 2, limit: 10 }, toTraderClosedTrade);
    expect(pg).toMatchObject({ total: 11, page: 2, pages: 2, limit: 10 });
    expect(pg.items[0]?.id).toBe('x');
    expect(toPaged([{ _id: 'y' }], toTraderClosedTrade).items).toHaveLength(1);
  });

  it('makes the custom range inclusive of the whole last day', () => {
    expect(traderHistoryParams({ period: 'custom', page: 1, from: '2026-09-01', to: '2026-09-29', accountId: 'acc' }))
      .toEqual({ period: 'custom', page: 1, limit: 10, from: '2026-09-01', to: '2026-09-29T23:59:59.999', accountId: 'acc' });
    expect(traderHistoryParams({ period: 'week', page: 3, from: '2026-09-01' }))
      .toEqual({ period: 'week', page: 3, limit: 10 });
  });
});

describe('copy analytics', () => {
  it('reads an infinite profit factor as null, not zero', () => {
    const a = toCopyAnalytics({ netProfit: '10', profitFactor: null, trades: [{ id: 't1', qty: '1' }] });
    expect(a?.profitFactor).toBeNull();
    expect(a?.netProfit).toBe(10);
    expect(a?.trades[0]?.leverage).toBe(1);
    expect(toCopyAnalytics({})).toBeNull();
  });

  it('takes presets in the DEVICE calendar, inclusive of today', () => {
    const now = new Date(2026, 8, 29, 2, 0, 0); // 02:00 local — UTC would still be the 28th in India
    expect(analyticsPresetRange('7d', now)).toEqual({ from: '2026-09-23', to: '2026-09-29' });
    expect(analyticsPresetRange('30d', now)).toEqual({ from: '2026-08-31', to: '2026-09-29' });
    expect(analyticsPresetRange('all', now)).toEqual({ from: '', to: '' });
  });

  it('exports CSV with quoted, escaped cells', () => {
    const a = toCopyAnalytics({ trades: [{ id: '1', symbol: 'NIFTY"FUT', side: 'BUY', qty: 1, pnl: -2, closedAt: '2026-09-01T10:00:00.000Z' }] });
    const csv = copyAnalyticsCsv(a?.trades ?? []);
    const [head, row] = csv.split('\n');
    expect(head).toBe('"Closed","Symbol","Side","Qty","Entry","Close","PnL","Commission","Swap"');
    expect(row).toBe('"2026-09-01T10:00:00.000Z","NIFTY""FUT","BUY","1","0","0","-2","0","0"');
  });
});

/* ── Requests ─────────────────────────────────────────────────────────── */

describe('copyTradingApi requests', () => {
  it('unwraps the envelope and adapts the leaderboard', async () => {
    reply = () => ({ success: true, data: [{ _id: 'b1', performanceFeePercent: 10 }] });
    const list = await copyTradingApi.leaderboard();
    expect(lastCall()).toMatchObject({ method: 'GET', url: '/copy-trading/leaderboard', params: { limit: 50 } });
    expect(list[0]?.effectiveFee).toBe(10);
  });

  it('survives a non-array body', async () => {
    reply = () => ({ success: true, data: { unexpected: true } });
    expect(await copyTradingApi.myCopies()).toEqual([]);
  });

  it('merges the settings into the copy body', async () => {
    reply = () => ({ success: true, data: { _id: 'r9' } });
    const rel = await copyTradingApi.startCopy({
      masterAccountId: 'm1',
      followerAccountId: 'f1',
      settings: copySettingsPayload(defaultCopySettings()),
    });
    expect(rel.id).toBe('r9');
    expect(lastCall()).toMatchObject({
      method: 'POST',
      url: '/copy-trading/copy',
      data: { masterAccountId: 'm1', followerAccountId: 'f1', lotMode: 'MEDIUM', maxLot: null, copySL: true },
    });
  });

  it('pauses, resumes and stops by relationId', async () => {
    await copyTradingApi.pause('r1');
    expect(lastCall()).toMatchObject({ url: '/copy-trading/pause', data: { relationId: 'r1', closePositions: false } });
    await copyTradingApi.resume('r1');
    expect(lastCall()).toMatchObject({ url: '/copy-trading/resume', data: { relationId: 'r1', closePositions: false } });
    await copyTradingApi.stop('r1', true);
    expect(lastCall()).toMatchObject({ url: '/copy-trading/stop', data: { relationId: 'r1', closePositions: true } });
  });

  it('drops demo accounts from the box candidates', async () => {
    reply = () => ({
      success: true,
      data: [
        { accountId: 'a1', accountType: 'DEMO' },
        { accountId: 'a2', accountType: 'STANDARD' },
        { accountId: 'a3', accountType: 'VIRTUAL' },
      ],
    });
    expect((await copyTradingApi.eligibleAccounts()).map((a) => a.accountId)).toEqual(['a2']);
  });

  it('scopes the trader dashboard by accountId only when given', async () => {
    reply = () => ({ success: true, data: { trader: { userId: 'u1' } } });
    await copyTradingApi.trader('u1');
    expect(lastCall()).toMatchObject({ url: '/copy-trading/trader/u1', params: {} });
    await copyTradingApi.trader('u1', 'acc');
    expect(lastCall().params).toEqual({ accountId: 'acc' });
  });

  it('archives with DELETE and restores with POST', async () => {
    await copyTradingApi.archiveBox('b1');
    expect(lastCall()).toMatchObject({ method: 'DELETE', url: '/copy-trading/boxes/b1' });
    reply = () => ({ success: true, data: { _id: 'b1', isPublic: false } });
    const b = await copyTradingApi.restoreBox('b1');
    expect(lastCall()).toMatchObject({ method: 'POST', url: '/copy-trading/boxes/b1/restore' });
    expect(b.isPublic).toBe(false);
  });

  it('sends only the analytics dates that were chosen', async () => {
    reply = () => ({ success: true, data: { netProfit: 1 } });
    await copyTradingApi.analytics('r1', { from: '2026-09-01' });
    expect(lastCall()).toMatchObject({ url: '/copy-trading/copy/r1/analytics', params: { from: '2026-09-01' } });
  });
});

describe('dashboard furniture', () => {
  const day = 864e5;
  const now = Date.UTC(2026, 8, 29);
  const series = [
    { t: new Date(now - 40 * day).toISOString(), equity: 1000 },
    { t: new Date(now - 20 * day).toISOString(), equity: 1100 },
    { t: new Date(now - 2 * day).toISOString(), equity: 1210 },
  ];

  it('filters the equity curve by range, keeping at least two points', () => {
    expect(filterEquityCurve(series, 'ALL', now)).toHaveLength(3);
    expect(filterEquityCurve(series, '1M', now).map((p) => p.equity)).toEqual([1100, 1210]);
    expect(filterEquityCurve(series, '1D', now).map((p) => p.equity)).toEqual([1100, 1210]);
    expect(filterEquityCurve([], '1W', now)).toEqual([]);
  });

  it('summarises the shown range', () => {
    const s = equityRangeSummary(filterEquityCurve(series, '1M', now), 1000);
    expect(s.last).toBe(1210);
    expect(s.changePct).toBeCloseTo(10);
    expect(equityRangeSummary([], null)).toEqual({ last: null, changePct: 0 });
  });

  it('formats holding time', () => {
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(45 * 60_000)).toBe('45m');
    expect(fmtDuration(3.5 * 3_600_000)).toBe('3.5h');
    expect(fmtDuration(2.1 * day)).toBe('2.1d');
  });

  it('words the profile and box actions like the web', () => {
    expect(validateProfileForm({ displayName: '', isPublic: true })).toBe('Display name required to go public');
    expect(boxVisibilityToast(true)).toBe('Box hidden from leaderboard');
    expect(firstFreeAccount([
      toEligibleAccount({ accountId: 'a1', hasBox: true }),
      toEligibleAccount({ accountId: 'a2' }),
    ])).toBe('a2');
    expect(firstFreeAccount([toEligibleAccount({ accountId: 'a1', hasBox: true })])).toBeNull();
  });
});

describe('dashboard formatters', () => {
  it('compacts AUM in rupees, Indian units from a thousand — TraderDashboard.jsx usdCompact', () => {
    expect(DASHBOARD).toContain('if (Math.abs(n) >= 1e3) return fmtInrCompact(n);');
    expect(fmtAumCompact(1500)).toBe('₹1.5K');
    expect(fmtAumCompact(2_300_000)).toBe('₹23L');
    expect(fmtAumCompact(15_000_000)).toBe('₹1.5Cr');
    expect(fmtAumCompact(999.5)).toBe('₹999.50');
    expect(fmtAumCompact(null)).toBe('₹0.00');
    expect(fmtAumCompact(-1500)).toBe('-₹1.5K');
  });

  it('ages an open position', () => {
    const now = Date.UTC(2026, 8, 29, 12);
    expect(traderRelTime(new Date(now - 30_000).toISOString(), now)).toBe('just now');
    expect(traderRelTime(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe('2d ago');
    expect(traderRelTime(null, now)).toBe('—');
  });
});

/* ── EquityHub: INR, the fee escrow and "Transfer Commission" ─────────── */

describe('EquityHub copy trading', () => {
  it('a blank Max lot is sent as null — the one value that clears a cap on edit', () => {
    // EquityHub's web omits it (`undefined`), but editCopy merges the body over
    // the stored relation, so an omitted key keeps the old cap. null clears it
    // and, for a new copy, means "no limit" exactly as absent does.
    const svc = read('backend/src/services/copyTradingService.js');
    expect(svc).toContain('const merged = sanitizeLotSettings({ ...rel.toObject(), ...settings });');
    expect(svc).toContain("out.maxLot = (s.maxLot == null || s.maxLot === '') ? null");
    expect(copySettingsPayload({ ...defaultCopySettings(), maxLot: '' })).toHaveProperty('maxLot', null);
  });

  it('reads a box escrow: pending fee and released to date', () => {
    expect(COPY_PAGE).toContain('Number(b.accruedFeeUsd || 0) > 0');
    expect(COPY_PAGE).toContain('Releases to your Main Wallet at month-end if the account is net-profitable — else it carries forward.');
    const b = toCopyBox({ _id: 'b1', accruedFeeUsd: '125.5', lifetimeFeeReleasedUsd: '900' });
    expect(b).toMatchObject({ accruedFee: 125.5, lifetimeFeeReleased: 900 });
    expect(toCopyBox({ _id: 'b2' })).toMatchObject({ accruedFee: 0, lifetimeFeeReleased: 0 });
  });

  it('reads the escrow rollup on the trader analytics and on /earnings/me', () => {
    const rollup = { total: 500, today: 0, month: 40, count: 7, avgFeePercent: 20, accruedPending: 120, accruedBlocked: 120, withdrawable: 0, monthlyPnlUsd: -35.5 };
    expect(toTraderAnalytics({ trader: { userId: 'u1' }, earnings: { ...rollup, performanceFeePercent: 20 } })?.earnings)
      .toMatchObject({ accruedPending: 120, accruedBlocked: 120, withdrawable: 0, monthlyPnl: -35.5, performanceFeePercent: 20 });
    const me = toMasterEarnings({ summary: rollup, history: [{ _id: 'e1', symbol: 'RELIANCE', realizedProfit: '100', feePercent: 20, feeAmountUsd: 20, followerNetUsd: 80 }] });
    expect(me?.summary).toMatchObject({ total: 500, accruedPending: 120, monthlyPnl: -35.5 });
    expect(me?.history[0]).toMatchObject({ symbol: 'RELIANCE', feeAmountUsd: 20, followerNetUsd: 80, currency: 'INR' });
  });

  it('gates the transfer exactly as the web does: this month strictly positive, button on withdrawable', () => {
    expect(DASHBOARD).toContain('const isMonthNegative = monthPnl != null && monthPnl <= 0 && pending > 0;');
    expect(DASHBOARD).toContain('const canTransfer = Number(earnings.withdrawable || 0) > 0;');
    const base = { accruedPending: 120, accruedBlocked: 120, withdrawable: 0 };
    expect(earningsGate({ ...base, monthlyPnl: 0 })).toEqual({ pending: 120, blocked: 120, monthPnl: 0, isMonthNegative: true, canTransfer: false });
    expect(earningsGate({ accruedPending: 120, accruedBlocked: 0, withdrawable: 120, monthlyPnl: 5 }))
      .toMatchObject({ isMonthNegative: false, canTransfer: true });
    // Nothing pending is never "locked"; an unknown P&L reads "—".
    expect(earningsGate({ accruedPending: 0, accruedBlocked: 0, withdrawable: 0, monthlyPnl: -10 }).isMonthNegative).toBe(false);
    expect(earningsGate({ accruedPending: 5, accruedBlocked: 0, withdrawable: 5, monthlyPnl: null }).monthPnl).toBeNull();
  });

  it('words a refused transfer in the web wording', () => {
    expect(transferErrorText({ response: { data: { error: { code: 'MONTHLY_PNL_NEGATIVE', message: 'x' } } } }))
      .toBe('Transfer blocked: your net trading P&L for this month must be positive.');
    expect(transferErrorText({ response: { data: { error: { message: 'Something else' } } } })).toBe('Something else');
    expect(transferErrorText(new Error('offline'))).toBe('Transfer failed. Please try again.');
    for (const s of ['Transfer blocked: your net trading P&L for this month must be positive.', 'Transfer failed. Please try again.']) {
      expect(DASHBOARD).toContain(s);
    }
  });

  it('POSTs /copy-trading/earnings/transfer and reads what moved', async () => {
    reply = () => ({ success: true, data: { transferred: 120.5, boxes: 2 } });
    expect(await copyTradingApi.transferCommission()).toEqual({ transferred: 120.5, boxes: 2 });
    expect(lastCall()).toMatchObject({ method: 'POST', url: '/copy-trading/earnings/transfer' });
    expect(read('backend/src/routes/copyTrading.js')).toContain("router.post('/earnings/transfer', authenticate, c.transferCommission);");
    reply = () => ({ success: true, data: { transferred: 0, boxes: 0 } });
    expect(await copyTradingApi.transferCommission()).toEqual({ transferred: 0, boxes: 0 });
  });

  it('every copy-trading amount is rupees on the web', () => {
    expect(DASHBOARD).toContain('// All copy-trading figures are INR.');
    expect(DASHBOARD).toContain('Trades by PnL bucket (INR)');
    expect(DASHBOARD).toContain('Performance Fee → Main Wallet');
    expect(COPY_PAGE).toContain('placeholder="e.g. Aggressive NIFTY Scalper"');
    expect(COPY_PAGE).toContain('{a.accountNumber} ({a.accountType}) · INR');
  });
});
