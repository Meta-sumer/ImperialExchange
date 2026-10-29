/**
 * Partner / referral — adapters, the tier ladder, the referral table and
 * the request shapes. No network.
 */
import type { InternalAxiosRequestConfig } from 'axios';

import { api } from '@/api/client';
import { partnerApi } from '@/api/partner.api';
import {
  commissionSourceLabel,
  filterReferralPerformance,
  fmtVolume,
  fmtVolumeCompact,
  levelMeta,
  levelThresholdText,
  nextLevelText,
  pageSlice,
  partnerLevels,
  partnerRelTime,
  publicOrigin,
  referralAvatar,
  referralLink,
  referralShareUrls,
  seriesTotals,
  toCommission,
  toPartnerDashboard,
  toPartnerSettings,
  toReferral,
  toVolumeDashboard,
  type ReferralPerformanceRow,
} from '@/types/partner';

type Call = { method: string; url: string; params: Record<string, unknown> };
const calls: Call[] = [];
let reply: (c: Call) => unknown = () => ({ success: true, data: null });

beforeAll(() => {
  api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const call: Call = {
      method: String(config.method ?? 'get').toUpperCase(),
      url: String(config.url ?? ''),
      params: (config.params ?? {}) as Record<string, unknown>,
    };
    calls.push(call);
    return { data: reply(call), status: 200, statusText: 'OK', headers: {}, config };
  };
});

beforeEach(() => {
  calls.length = 0;
  reply = () => ({ success: true, data: null });
});

describe('volume dashboard', () => {
  it('returns null for an empty body', () => {
    expect(toVolumeDashboard({})).toBeNull();
    expect(toVolumeDashboard(null)).toBeNull();
  });

  it('falls back to the lifetime total when an older server sends no previous-month figure', () => {
    const d = toVolumeDashboard({ totalReferralVolume: 5000, monthlyVolume: 700 });
    expect(d?.previousMonthVolume).toBe(5000);
    expect(d?.currentMonthVolume).toBe(700);
    expect(d?.totalOneSideVolume).toBe(5000);
  });

  it('displays the server progress, clamped, never re-derived', () => {
    expect(toVolumeDashboard({ progressPercent: 140 })?.progressPercent).toBe(100);
    expect(toVolumeDashboard({ progressPercent: -3 })?.progressPercent).toBe(0);
    expect(toVolumeDashboard({ progressPercent: '37.5' })?.progressPercent).toBe(37.5);
  });

  it('reads the program switch, tier and money as sent', () => {
    const d = toVolumeDashboard({
      enabled: false,
      partnerLevel: 'gold',
      totalCommissionEarned: '12.50',
      walletCurrency: 'INR',
      nextLevel: { name: 'platinum', minVolume: 1_000_000, percent: 40 },
      referralPerformance: [{ id: 'r1', email: 'a@b.c', volume: 10, status: 'active' }],
      monthlySeries: [{ key: '2026-09', label: 'Sep', volume: 100, commission: 2 }],
    });
    expect(d?.enabled).toBe(false);
    expect(d?.partnerLevel).toBe('GOLD');
    expect(d?.revenueShareEarned).toBe('12.50');
    expect(d?.nextLevel).toEqual({ name: 'PLATINUM', minVolume: 1_000_000, percent: 40 });
    expect(d?.referralPerformance[0]).toMatchObject({ name: 'a@b.c', status: 'ACTIVE' });
    expect(d?.firstDepositBonus).toBeNull();
  });
});

describe('tier ladder', () => {
  const tiers = [
    { name: 'GOLD', minVolume: 500_000, percent: 30 },
    { name: 'BRONZE', minVolume: 0, percent: 10 },
    { name: 'SILVER', minVolume: 100_000, percent: 20 },
  ];

  it('sorts ascending and marks cleared / current / locked', () => {
    expect(partnerLevels(tiers, 'SILVER').map((l) => `${l.tier.name}:${l.state}`))
      .toEqual(['BRONZE:cleared', 'SILVER:current', 'GOLD:locked']);
  });

  it('uses the default ladder when the server sends none', () => {
    expect(partnerLevels([], 'BRONZE').map((l) => l.tier.name))
      .toEqual(['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'ELITE']);
  });

  it('words thresholds and the next tier like the web', () => {
    expect(levelThresholdText({ name: 'BRONZE', minVolume: 0, percent: 10 })).toBe('Starter tier');
    expect(levelThresholdText({ name: 'SILVER', minVolume: 100_000, percent: 20 })).toBe('₹1L+ volume');
    expect(nextLevelText({ name: 'GOLD', minVolume: 1_500_000, percent: 30 })).toBe('Next: Gold · 30% at ₹15L+');
    expect(nextLevelText(null)).toBeNull();
    expect(levelMeta('nonsense').label).toBe('Bronze');
    expect(levelMeta('elite').label).toBe('Elite');
  });
});

describe('volume formatting — Partner.jsx, INR', () => {
  const PARTNER = require('fs').readFileSync(require('path').join(__dirname, '../../../client/src/pages/Partner.jsx'), 'utf8') as string;

  it('volumes and commissions are rupees on the web', () => {
    expect(PARTNER).toContain("const usdFull = (n) => fmtMoney(Math.round(Number(n) || 0), 'INR', 0);");
    expect(PARTNER).toContain('const usdCompact = (n) => fmtInrCompact(n);');
    expect(PARTNER).toContain("const cur = 'INR';");
  });

  it('whole rupees, Indian grouping', () => {
    expect(fmtVolume(1234567.8)).toBe('₹12,34,568');
    expect(fmtVolume(null)).toBe('₹0');
  });

  it('compacts in Indian units, dropping the decimal on a round figure', () => {
    expect(fmtVolumeCompact(2_000_000_000)).toBe('₹200Cr');
    expect(fmtVolumeCompact(1_500_000)).toBe('₹15L');
    expect(fmtVolumeCompact(250_000)).toBe('₹2.5L');
    expect(fmtVolumeCompact(12_500)).toBe('₹12.5K');
    expect(fmtVolumeCompact(999)).toBe('₹999');
  });

  it('totals the six-month series', () => {
    expect(seriesTotals([
      { key: 'a', label: 'A', volume: 10, commission: 1.5 },
      { key: 'b', label: 'B', volume: 5, commission: 0 },
    ])).toEqual({ volume: 15, commission: 1.5 });
  });
});

describe('referral table', () => {
  const row = (id: string, name: string, lastActivityAt: string | null): ReferralPerformanceRow => ({
    id, name, email: `${id}@x.io`, volume: 0, pendingVolume: null, commissionedVolume: null,
    commission: 0, lastActivityAt, joinedAt: null, status: 'ACTIVE',
  });
  // Local-time timestamps, so the day boundaries are the device's.
  const at = (y: number, m: number, d: number, h: number) => new Date(y, m - 1, d, h).toISOString();
  const list = [
    row('a', 'Asha', at(2026, 9, 10, 23)),
    row('b', 'Bilal', at(2026, 9, 11, 0)),
    row('c', 'Chen', null),
  ];

  it('treats From == To as the whole day', () => {
    expect(filterReferralPerformance(list, { query: '', from: '2026-09-10', to: '2026-09-10' }).map((r) => r.id))
      .toEqual(['a']);
  });

  it('never matches a row with no activity under a date filter', () => {
    expect(filterReferralPerformance(list, { query: '', from: '2026-01-01', to: '' }).map((r) => r.id))
      .toEqual(['a', 'b']);
    expect(filterReferralPerformance(list, { query: '', from: '', to: '' })).toHaveLength(3);
  });

  it('searches name and email', () => {
    expect(filterReferralPerformance(list, { query: 'C@X', from: '', to: '' }).map((r) => r.id)).toEqual(['c']);
  });

  it('clamps the page when a filter shrinks the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => i);
    expect(pageSlice(many, 3)).toMatchObject({ page: 3, totalPages: 3, start: 16, rows: [16, 17, 18, 19] });
    expect(pageSlice(many.slice(0, 5), 3)).toMatchObject({ page: 1, totalPages: 1, start: 0 });
    expect(pageSlice([], 1)).toMatchObject({ page: 1, totalPages: 1, rows: [] });
  });

  it('says how long ago, and never a negative age', () => {
    const now = Date.UTC(2026, 8, 29, 12, 0, 0);
    expect(partnerRelTime(new Date(now + 60_000).toISOString(), now)).toBe('just now');
    expect(partnerRelTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5m ago');
    expect(partnerRelTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3h ago');
    expect(partnerRelTime(new Date(now - 12 * 86_400_000).toISOString(), now)).toBe('12d ago');
    expect(partnerRelTime(null, now)).toBe('—');
  });

  it('draws a stable avatar', () => {
    expect(referralAvatar('asha rao verma')).toMatchObject({ initials: 'AR' });
    expect(referralAvatar('')).toMatchObject({ initials: '?' });
    expect(referralAvatar('Asha').hue).toBe(referralAvatar('Asha').hue);
  });
});

describe('ledger + settings + legacy dashboard', () => {
  it('names commission sources in the partner words', () => {
    expect(commissionSourceLabel('TRADE_FEE')).toBe('Profit share');
    expect(commissionSourceLabel('SPREAD')).toBe('Profit share');
    expect(commissionSourceLabel('DEPOSIT_BONUS')).toBe('First-deposit bonus');
    expect(commissionSourceLabel('NEW_KIND')).toBe('NEW_KIND');
  });

  it('carries amounts as decimal strings', () => {
    const c = toCommission({ _id: 'c1', amount: 1.1, rate: null, sourceType: 'TRADE_FEE' });
    expect(c.amount).toBe('1.1');
    expect(c.rate).toBeNull();
    expect(toReferral({ _id: 'r', email: 'e@x' }).name).toBe('e@x');
    expect(toPartnerSettings({ bonusCurrency: 'inr' }).bonusCurrency).toBe('INR');
    expect(toPartnerSettings({}).bonusCurrency).toBe('INR');
    expect(toPartnerDashboard({ user: { referralCode: 'AB12' } })?.level.name).toBe('BRONZE');
  });
});

describe('referral link', () => {
  it('prefers an explicit public URL, else the API host minus /api', () => {
    expect(publicOrigin('https://site.io/', 'https://api.site.io/api')).toBe('https://site.io');
    expect(publicOrigin('', 'https://trading.example.com/api')).toBe('https://trading.example.com');
    expect(publicOrigin(undefined, 'https://trading.example.com/api/')).toBe('https://trading.example.com');
  });

  it('builds nothing without a code', () => {
    expect(referralLink('AB12', 'https://x.io')).toBe('https://x.io/register?ref=AB12');
    expect(referralLink(null, 'https://x.io')).toBe('');
    expect(referralShareUrls('')).toBeNull();
    expect(referralShareUrls('https://x.io/register?ref=AB12')?.whatsapp)
      .toBe(`https://wa.me/?text=${encodeURIComponent('Trade with my referral link: https://x.io/register?ref=AB12')}`);
  });
});

describe('partnerApi requests', () => {
  it('unwraps the volume dashboard', async () => {
    reply = () => ({ success: true, data: { partnerLevel: 'SILVER', revenueSharePercent: 20 } });
    const d = await partnerApi.volumeDashboard();
    expect(calls[0]).toMatchObject({ method: 'GET', url: '/partner/volume-dashboard' });
    expect(d?.partnerLevel).toBe('SILVER');
  });

  it('asks for the ledger with a limit and optional source', async () => {
    reply = () => ({ success: true, data: [{ _id: 'c1', amount: '2' }] });
    const list = await partnerApi.commissions({ limit: 8 });
    expect(calls[0]).toMatchObject({ url: '/partner/commissions', params: { limit: 8 } });
    expect(list[0]?.amount).toBe('2');
    await partnerApi.commissions({ sourceType: 'TRADE_FEE' });
    expect(calls[1]?.params).toEqual({ limit: 100, sourceType: 'TRADE_FEE' });
  });
});
