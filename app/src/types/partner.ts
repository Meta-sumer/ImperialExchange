/**
 * Partner / referral program — types, adapters and the pure logic behind the
 * partner screen.
 *
 * Shapes come from backend/src/services/partnerService.js; behaviour from
 * client/src/pages/Partner.jsx, which is what `/affiliate`, `/partner` and
 * `/ib-room` all render. `Affiliate.jsx` is dead (PORT-RULINGS) and its
 * `/compliance/affiliate/*` calls are not ported.
 *
 * ── THE TIER IS LAST MONTH'S, AND FIXED ───────────────────────────────
 * A partner's level is set on the 1st from the PREVIOUS calendar month's
 * referral trading volume and does not move for the rest of the month.
 * `currentMonthVolume` only counts toward NEXT month. So progress is
 * measured against `previousMonthVolume`, and the server computes it
 * (`progressPercent`, `volumeToNextLevel`) — the app displays those rather
 * than re-deriving a bar that could disagree with the tier the server set.
 * ──────────────────────────────────────────────────────────────────────
 *
 * Volumes are notionals (numbers); commission amounts are decimal strings.
 * Both are rupees — EquityHub is INR-only, and Partner.jsx prints them so
 * whatever `walletCurrency` says.
 */
import { dec, id, num, rows, str, strOrNull } from '@/types/api';
import type { Decimal } from '@/types/trading';
import { fmtInrCompact, fmtMoney } from '@/utils/money';

type Raw = Record<string, unknown>;

const obj = (v: unknown): Raw =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

const n0 = (v: unknown): number => num(v) ?? 0;

/* ── Tiers ────────────────────────────────────────────────────────────── */

export interface PartnerTier {
  name: string;
  /** Previous-month referral volume (INR) needed for this tier. */
  minVolume: number;
  /** Revenue-share percent on referral fees. */
  percent: number;
}

const toTier = (raw: unknown): PartnerTier => {
  const r = obj(raw);
  return { name: str(r.name).toUpperCase(), minVolume: n0(r.minVolume), percent: n0(r.percent) };
};

/** The default ladder order — used only when the server sends no tiers. */
export const PARTNER_TIER_ORDER = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'ELITE'] as const;

export type TierState = 'cleared' | 'current' | 'locked';

/**
 * Partner.jsx LevelsSection: the ladder, ascending by volume, with each rung
 * marked cleared / current / locked relative to the partner's tier.
 */
export const partnerLevels = (
  tiers: readonly PartnerTier[],
  currentLevel: string,
): { tier: PartnerTier; state: TierState }[] => {
  const list = (tiers.length
    ? [...tiers]
    : PARTNER_TIER_ORDER.map((name) => ({ name, minVolume: 0, percent: 0 })))
    .sort((a, b) => a.minVolume - b.minVolume);
  const currentIdx = list.findIndex((t) => t.name === currentLevel);
  return list.map((tier, i) => ({
    tier,
    state: i < currentIdx ? 'cleared' : i === currentIdx ? 'current' : 'locked',
  }));
};

/* ── Volume dashboard ─────────────────────────────────────────────────── */

export interface ReferralPerformanceRow {
  id: string;
  name: string;
  email: string;
  /** One-side volume = pending + commissioned. */
  volume: number;
  pendingVolume: number | null;
  commissionedVolume: number | null;
  commission: number;
  lastActivityAt: string | null;
  joinedAt: string | null;
  status: 'ACTIVE' | 'INACTIVE';
}

export interface PartnerMonthPoint {
  key: string;
  label: string;
  volume: number;
  commission: number;
}

export interface FirstDepositBonus {
  enabled: boolean;
  amount: Decimal;
  minDeposit: Decimal;
  currency: string;
}

export interface VolumeDashboard {
  /** false = the admin paused the program; no new commissions are credited. */
  enabled: boolean;
  firstDepositBonus: FirstDepositBonus | null;
  partnerLevel: string;
  revenueSharePercent: number;
  tierLocked: boolean;
  tierBlocked: boolean;
  previousMonthVolume: number;
  currentMonthVolume: number;
  totalReferralVolume: number;
  totalOneSideVolume: number;
  pendingVolume: number;
  commissionedVolume: number;
  nextLevel: PartnerTier | null;
  volumeToNextLevel: number;
  /** 0–100, server-computed against previous-month volume. */
  progressPercent: number;
  tiers: PartnerTier[];
  activeTraders: number;
  totalReferrals: number;
  totalCommissionEarned: Decimal;
  revenueShareEarned: Decimal;
  totalBonus: Decimal;
  pendingCommission: Decimal;
  paidCommission: Decimal;
  monthlyCommission: Decimal;
  todayCommission: Decimal;
  /** The Bonus Wallet balance — where every referral earning lands. */
  availableBalance: Decimal;
  walletCurrency: string;
  referralCode: string | null;
  referralPerformance: ReferralPerformanceRow[];
  monthlySeries: PartnerMonthPoint[];
}

export const toVolumeDashboard = (raw: unknown): VolumeDashboard | null => {
  const r = obj(raw);
  if (!Object.keys(r).length) return null;
  const b = r.firstDepositBonus && typeof r.firstDepositBonus === 'object' ? obj(r.firstDepositBonus) : null;
  const next = r.nextLevel && typeof r.nextLevel === 'object' ? toTier(r.nextLevel) : null;
  return {
    enabled: r.enabled !== false,
    firstDepositBonus: b
      ? {
        enabled: b.enabled !== false,
        amount: dec(b.amount),
        minDeposit: dec(b.minDeposit),
        currency: str(b.currency, 'INR') || 'INR',
      }
      : null,
    partnerLevel: str(r.partnerLevel, 'BRONZE').toUpperCase() || 'BRONZE',
    revenueSharePercent: n0(r.revenueSharePercent),
    tierLocked: r.tierLocked === true,
    tierBlocked: r.tierBlocked === true,
    // The web falls back to the lifetime total when an older server sends no
    // previous-month figure (Partner.jsx:211).
    previousMonthVolume: num(r.previousMonthVolume) ?? n0(r.totalReferralVolume),
    currentMonthVolume: num(r.currentMonthVolume) ?? n0(r.monthlyVolume),
    totalReferralVolume: n0(r.totalReferralVolume),
    totalOneSideVolume: num(r.totalOneSideVolume) ?? n0(r.totalReferralVolume),
    pendingVolume: n0(r.pendingVolume),
    commissionedVolume: n0(r.commissionedVolume),
    nextLevel: next,
    volumeToNextLevel: n0(r.volumeToNextLevel),
    progressPercent: Math.min(100, Math.max(0, n0(r.progressPercent))),
    tiers: rows<unknown>(r.tiers).map(toTier),
    activeTraders: n0(r.activeTraders),
    totalReferrals: n0(r.totalReferrals),
    totalCommissionEarned: dec(r.totalCommissionEarned),
    // "Total Commission Earned" on the web prefers the revenue-share figure.
    revenueShareEarned: dec(r.revenueShareEarned, dec(r.totalCommissionEarned)),
    totalBonus: dec(r.totalBonus),
    pendingCommission: dec(r.pendingCommission),
    paidCommission: dec(r.paidCommission),
    monthlyCommission: dec(r.monthlyCommission),
    todayCommission: dec(r.todayCommission),
    availableBalance: dec(r.availableBalance),
    walletCurrency: str(r.walletCurrency, 'INR') || 'INR',
    referralCode: strOrNull(r.referralCode),
    referralPerformance: rows<unknown>(r.referralPerformance).map((x) => {
      const q = obj(x);
      return {
        id: str(q.id) || id(q),
        name: str(q.name) || str(q.email),
        email: str(q.email),
        volume: n0(q.volume),
        pendingVolume: num(q.pendingVolume),
        commissionedVolume: num(q.commissionedVolume),
        commission: n0(q.commission),
        lastActivityAt: strOrNull(q.lastActivityAt),
        joinedAt: strOrNull(q.joinedAt),
        status: str(q.status).toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE',
      };
    }),
    monthlySeries: rows<unknown>(r.monthlySeries).map((x) => {
      const q = obj(x);
      return { key: str(q.key), label: str(q.label), volume: n0(q.volume), commission: n0(q.commission) };
    }),
  };
};

/* ── Commission ledger ────────────────────────────────────────────────── */

export type CommissionSource = 'DEPOSIT_BONUS' | 'TRADE_FEE' | 'SPREAD' | 'ADJUSTMENT' | (string & {});

export interface Commission {
  id: string;
  createdAt: string | null;
  paidAt: string | null;
  sourceType: CommissionSource;
  sourceId: string | null;
  refereeId: string | null;
  refereeName: string | null;
  currency: string;
  amount: Decimal;
  rate: Decimal | null;
  status: string;
  level: number | null;
  note: string | null;
}

export const toCommission = (raw: unknown): Commission => {
  const r = obj(raw);
  const rate = dec(r.rate, '');
  return {
    id: id(r),
    createdAt: strOrNull(r.createdAt),
    paidAt: strOrNull(r.paidAt),
    sourceType: str(r.sourceType),
    sourceId: strOrNull(r.sourceId),
    refereeId: strOrNull(r.refereeId),
    refereeName: strOrNull(r.refereeName),
    currency: str(r.currency),
    amount: dec(r.amount),
    rate: rate === '' ? null : rate,
    status: str(r.status),
    level: num(r.level),
    note: strOrNull(r.note),
  };
};

/**
 * What a ledger row is called on screen (Partner.jsx RecentCommissions).
 * TRADE_FEE and SPREAD are both "Profit share" to the partner — the split
 * is an accounting detail. Unknown sources fall back to the raw code.
 */
export const commissionSourceLabel = (sourceType: string): string =>
  ({
    DEPOSIT_BONUS: 'First-deposit bonus',
    TRADE_FEE: 'Profit share',
    SPREAD: 'Profit share',
    ADJUSTMENT: 'Admin credit',
  } as Record<string, string>)[sourceType] ?? sourceType;

/* ── Referee list ─────────────────────────────────────────────────────── */

export interface Referral {
  id: string;
  name: string;
  email: string;
  referralCode: string | null;
  registeredAt: string | null;
  /** Has a qualifying first deposit at or above the program minimum. */
  isActive: boolean;
  firstDepositAt: string | null;
  firstDepositAmount: Decimal;
  totalDeposited: Decimal;
  depositCount: number;
  commissionEarned: Decimal;
  bonusEarned: Decimal;
  revShareEarned: Decimal;
}

export const toReferral = (raw: unknown): Referral => {
  const r = obj(raw);
  return {
    id: id(r),
    name: str(r.name) || str(r.email),
    email: str(r.email),
    referralCode: strOrNull(r.referralCode),
    registeredAt: strOrNull(r.registeredAt),
    isActive: r.isActive === true,
    firstDepositAt: strOrNull(r.firstDepositAt),
    firstDepositAmount: dec(r.firstDepositAmount),
    totalDeposited: dec(r.totalDeposited),
    depositCount: n0(r.depositCount),
    commissionEarned: dec(r.commissionEarned),
    bonusEarned: dec(r.bonusEarned),
    revShareEarned: dec(r.revShareEarned),
  };
};

/* ── Settings + legacy dashboard ──────────────────────────────────────── */

export interface PartnerSettings {
  enabled: boolean;
  bonusAmount: Decimal;
  minDeposit: Decimal;
  bonusCurrency: string;
}

export const toPartnerSettings = (raw: unknown): PartnerSettings => {
  const r = obj(raw);
  return {
    enabled: r.enabled !== false,
    bonusAmount: dec(r.bonusAmount),
    minDeposit: dec(r.minDeposit),
    bonusCurrency: (str(r.bonusCurrency, 'INR') || 'INR').toUpperCase(),
  };
};

/** GET /partner/dashboard — the count-based summary the volume dashboard superseded. */
export interface PartnerDashboard {
  referralCode: string | null;
  name: string | null;
  settings: PartnerSettings;
  level: {
    name: string;
    percent: number;
    locked: boolean;
    blocked: boolean;
    prevMonthVolume: number;
    activeCount: number;
  };
  stats: {
    totalReferrals: number;
    activeReferrals: number;
    /** 0–1. */
    conversionRate: number;
    lifetimeEarnings: Decimal;
    pendingCommission: Decimal;
    paidCommission: Decimal;
    totalBonus: Decimal;
    totalRevenueShare: Decimal;
    todayEarnings: Decimal;
    monthlyEarnings: Decimal;
    availableBalance: Decimal;
    walletCurrency: string;
  };
}

export const toPartnerDashboard = (raw: unknown): PartnerDashboard | null => {
  const r = obj(raw);
  if (!Object.keys(r).length) return null;
  const u = obj(r.user);
  const l = obj(r.level);
  const s = obj(r.stats);
  return {
    referralCode: strOrNull(u.referralCode),
    name: strOrNull(u.name),
    settings: toPartnerSettings(r.settings),
    level: {
      name: str(l.name, 'BRONZE') || 'BRONZE',
      percent: n0(l.percent),
      locked: l.locked === true,
      blocked: l.blocked === true,
      prevMonthVolume: n0(l.prevMonthVolume),
      activeCount: n0(l.activeCount),
    },
    stats: {
      totalReferrals: n0(s.totalReferrals),
      activeReferrals: n0(s.activeReferrals),
      conversionRate: n0(s.conversionRate),
      lifetimeEarnings: dec(s.lifetimeEarnings),
      pendingCommission: dec(s.pendingCommission),
      paidCommission: dec(s.paidCommission),
      totalBonus: dec(s.totalBonus),
      totalRevenueShare: dec(s.totalRevenueShare),
      todayEarnings: dec(s.todayEarnings),
      monthlyEarnings: dec(s.monthlyEarnings),
      availableBalance: dec(s.availableBalance),
      walletCurrency: str(s.walletCurrency, 'INR') || 'INR',
    },
  };
};

/* ── Referral link ────────────────────────────────────────────────────── */

/**
 * The public site origin a referral link points at. Partner.jsx resolves it
 * as: an explicit public URL → the API base minus `/api` → the page origin.
 * An app has no page origin, so the last step is gone and the caller must
 * supply one of the first two.
 */
export const publicOrigin = (explicit: string | null | undefined, apiUrl: string): string => {
  const e = String(explicit ?? '').trim().replace(/\/+$/, '');
  if (e) return e;
  return apiUrl.replace(/\/api\/?$/, '').replace(/\/+$/, '');
};

/** `<origin>/register?ref=<code>`, or '' when the partner has no code yet. */
export const referralLink = (code: string | null | undefined, origin: string): string =>
  (code ? `${origin}/register?ref=${code}` : '');

/** The share-sheet copy the web uses for navigator.share / WhatsApp. */
export const REFERRAL_SHARE = {
  title: 'Join me on the platform',
  text: 'Trade with my referral link',
  whatsappText: (link: string) => `Trade with my referral link: ${link}`,
} as const;

/* ── Referral performance table: search + date filter + paging ────────── */

export const REFERRAL_PAGE_SIZE = 8;

/**
 * Inclusive day range on `lastActivityAt`: From == To returns that whole
 * day, in the device's calendar. A row with no activity never matches an
 * active date filter.
 */
const inDayRange = (iso: string, from: string, to: string): boolean => {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  const day = (ymd: string, end: boolean): number | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (end) d.setHours(23, 59, 59, 999);
    return d.getTime();
  };
  const lo = from ? day(from, false) : null;
  const hi = to ? day(to, true) : null;
  if (lo !== null && t < lo) return false;
  if (hi !== null && t > hi) return false;
  return true;
};

export const filterReferralPerformance = (
  list: readonly ReferralPerformanceRow[],
  opts: { query: string; from: string; to: string },
): ReferralPerformanceRow[] => {
  const term = opts.query.trim().toLowerCase();
  return list.filter((r) => {
    if (term && !`${r.name} ${r.email}`.toLowerCase().includes(term)) return false;
    if (opts.from || opts.to) {
      if (!r.lastActivityAt || !inDayRange(r.lastActivityAt, opts.from, opts.to)) return false;
    }
    return true;
  });
};

export interface PagedSlice<T> {
  rows: T[];
  totalPages: number;
  /** The requested page, clamped — a filter that shrinks the list must not strand the reader on page 9 of 2. */
  page: number;
  /** Zero-based index of the first row shown ("Showing 9–16 of 40"). */
  start: number;
}

export const pageSlice = <T>(list: readonly T[], page: number, size: number = REFERRAL_PAGE_SIZE): PagedSlice<T> => {
  const totalPages = Math.max(1, Math.ceil(list.length / size));
  const safe = Math.min(Math.max(1, page), totalPages);
  const start = (safe - 1) * size;
  return { rows: list.slice(start, start + size), totalPages, page: safe, start };
};

/* ── Presentation: the tier look, volume figures, relative time ───────── */

export interface PartnerLevelMeta {
  label: string;
  /** Metallic badge / card gradient. */
  from: string;
  to: string;
  /** Glow and active ring. */
  accent: string;
  glow: string;
  /** Foreground on the badge. */
  text: string;
}

/** Partner.jsx LEVEL_META, verbatim. */
export const PARTNER_LEVEL_META: Record<string, PartnerLevelMeta> = {
  BRONZE: { label: 'Bronze', from: '#D08B45', to: '#7C3A12', accent: '#F0A357', glow: 'rgba(217,119,6,0.45)', text: '#3B1A06' },
  SILVER: { label: 'Silver', from: '#CBD5E1', to: '#64748B', accent: '#E2E8F0', glow: 'rgba(148,163,184,0.5)', text: '#1F2937' },
  GOLD: { label: 'Gold', from: '#FCD34D', to: '#B7791F', accent: '#FDE68A', glow: 'rgba(245,158,11,0.55)', text: '#3B2A06' },
  PLATINUM: { label: 'Platinum', from: '#6EE7DF', to: '#0E7490', accent: '#A5F3EC', glow: 'rgba(45,212,191,0.5)', text: '#06322F' },
  ELITE: { label: 'Elite', from: '#A78BFA', to: '#4338CA', accent: '#C4B5FD', glow: 'rgba(124,58,237,0.55)', text: '#1E1B4B' },
};

/** An unknown tier name wears Bronze, as on the web. */
export const levelMeta = (name: string | null | undefined): PartnerLevelMeta =>
  PARTNER_LEVEL_META[String(name ?? '').toUpperCase()] ?? (PARTNER_LEVEL_META.BRONZE as PartnerLevelMeta);

/**
 * Partner.jsx usdFull — a referral VOLUME, whole rupees in Indian grouping:
 * `₹12,34,567`. (Volumes and commissions are INR on EquityHub.)
 */
export const fmtVolume = (n: number | null | undefined): string => fmtMoney(Math.round(Number(n) || 0), 'INR', 0);

/** Partner.jsx usdCompact — fmtInrCompact: `₹950`, `₹12.5K`, `₹3.2L`, `₹1.4Cr`. */
export const fmtVolumeCompact = (n: number | null | undefined): string => fmtInrCompact(Number(n) || 0);

/** Partner.jsx — every partner amount (bonus, commission) is rupees. */
export const PARTNER_CURRENCY = 'INR';

/** The hero's "next tier" line, or null at the top tier ("👑 Top tier unlocked"). */
export const nextLevelText = (next: PartnerTier | null): string | null =>
  (next ? `Next: ${levelMeta(next.name).label} · ${next.percent}% at ${fmtVolumeCompact(next.minVolume)}+` : null);

/** A level card's threshold line. */
export const levelThresholdText = (tier: PartnerTier): string =>
  (tier.minVolume > 0 ? `${fmtVolumeCompact(tier.minVolume)}+ volume` : 'Starter tier');

/** The chart cards' totals over the 6-month series. */
export const seriesTotals = (series: readonly PartnerMonthPoint[]): { volume: number; commission: number } =>
  series.reduce(
    (t, p) => ({ volume: t.volume + (p.volume || 0), commission: t.commission + (p.commission || 0) }),
    { volume: 0, commission: 0 },
  );

/**
 * "Last activity": just now / 5m / 3h / 12d ago; past 30 days, the date in
 * the device's locale (PORT-RULINGS §5). A future timestamp (clock skew) is
 * "just now", never a negative age.
 */
export const partnerRelTime = (iso: string | null, now: number = Date.now()): string => {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = now - t;
  const m = Math.floor(diff / 60_000);
  if (diff < 0 || m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
};

/** A referee's avatar: up to two initials, and a hue stable for the name. */
export const referralAvatar = (name: string | null | undefined): { initials: string; hue: number } => {
  const s = String(name ?? '');
  const initials = (s.trim() || '?').split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase() || '?';
  const hue = [...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return { initials, hue };
};

/** Share targets besides the system sheet (Partner.jsx ReferralLinkSection). */
export const referralShareUrls = (link: string): { whatsapp: string; telegram: string; twitter: string } | null =>
  (link
    ? {
      whatsapp: `https://wa.me/?text=${encodeURIComponent(REFERRAL_SHARE.whatsappText(link))}`,
      telegram: `https://t.me/share/url?url=${encodeURIComponent(link)}`,
      twitter: `https://twitter.com/intent/tweet?url=${encodeURIComponent(link)}`,
    }
    : null);

/**
 * The QR image for the link — the web renders it through the same public
 * service rather than shipping a QR library. The link is public by design.
 */
export const referralQrUrl = (link: string): string | null =>
  (link
    ? `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=8&qzone=1&color=0F172A&bgcolor=FFFFFF&data=${encodeURIComponent(link)}`
    : null);

/** The ledger footnote shows six; the screen asks for eight (Partner.jsx). */
export const RECENT_COMMISSIONS_FETCH = 8;
export const RECENT_COMMISSIONS_SHOWN = 6;
