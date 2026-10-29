/**
 * Copy trading — types, adapters and the pure logic behind the screens.
 *
 * Shapes come from backend/src/services/copyTradingService.js,
 * copyAnalyticsService.js and copyEarningsService.js; the behaviour from
 * client/src/pages/CopyTrade.jsx, TraderDashboard.jsx and the Copy* modals.
 *
 * ── A BOX IS AN ACCOUNT, NOT A PERSON ─────────────────────────────────
 * A master does not publish "themselves". They publish a COPY BOX bound to
 * one trading account, and only that account's trades are mirrored. A user
 * can own several boxes. Followers copy a box (`masterAccountId`), which is
 * why every copy call is keyed by account id, and the trader dashboard takes
 * both a user id and an optional account id.
 * ──────────────────────────────────────────────────────────────────────
 *
 * ── TWO FEE FIELDS, DELIBERATELY RENAMED ──────────────────────────────
 * The server sends `performanceFeePercent` with two different meanings:
 * on the owner's own box list it is the RAW override (null = "use the
 * default"), on the leaderboard it is the RESOLVED fee actually charged.
 * One name for two numbers is how an edit form ends up pre-filled with the
 * platform default as if the master had chosen it. Here they are two
 * fields: `feeOverride` and `effectiveFee`.
 * ──────────────────────────────────────────────────────────────────────
 */
import { dec, id, num, rows, str, strOrNull } from '@/types/api';
import type { Decimal } from '@/types/trading';
import { fmtInrCompact, fmtMoney } from '@/utils/money';

type Raw = Record<string, unknown>;

const obj = (v: unknown): Raw =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

/** An ObjectId that may arrive as a string or populated `{ _id }`. */
const ref = (v: unknown): string | null => {
  if (typeof v === 'string' && v !== '') return v;
  if (v && typeof v === 'object') return id(v as Raw) || null;
  return null;
};

/** A boolean whose ABSENCE means true — `copySL !== false` on the web. */
const boolDefaultTrue = (v: unknown): boolean => v !== false;

const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

const int = (v: unknown): number => {
  const n = num(v);
  return n === null ? 0 : Math.trunc(n);
};

/* ── Enums ────────────────────────────────────────────────────────────── */

export const RISK_BADGES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type RiskBadge = (typeof RISK_BADGES)[number];

const riskBadge = (v: unknown): RiskBadge | null => {
  const s = str(v).toUpperCase();
  return (RISK_BADGES as readonly string[]).includes(s) ? (s as RiskBadge) : null;
};

/** The risk choices the box / profile editors offer, in the web's wording. */
export const RISK_OPTIONS: { id: RiskBadge; label: string }[] = [
  { id: 'LOW', label: 'Low' },
  { id: 'MEDIUM', label: 'Medium' },
  { id: 'HIGH', label: 'High' },
];

export type CopyStatus = 'ACTIVE' | 'PAUSED' | 'STOPPED';

const copyStatus = (v: unknown): CopyStatus => {
  const s = str(v).toUpperCase();
  return s === 'PAUSED' || s === 'STOPPED' ? s : 'ACTIVE';
};

export type LotMode = 'LOW' | 'MEDIUM' | 'HIGH' | 'CUSTOM';

const lotMode = (v: unknown): LotMode => {
  const s = str(v).toUpperCase();
  return s === 'LOW' || s === 'HIGH' || s === 'CUSTOM' ? s : 'MEDIUM';
};

export type FeedEventType = 'OPEN' | 'CLOSE' | 'TP_HIT' | 'SL_HIT' | 'FOLLOWED';

/* ── Copy box (master side) ───────────────────────────────────────────── */

export interface CopyBox {
  id: string;
  userId: string;
  accountId: string;
  accountNumber: string;
  /** The account's type LABEL as the server resolved it — may be a custom name. */
  accountType: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  isPublic: boolean;
  riskBadge: RiskBadge | null;
  totalTrades: number;
  wins: number;
  /** Percent, 0–100. */
  winRate: number;
  /** Realised P&L across the box's copied history (INR). */
  cumulativePnl: Decimal;
  /**
   * Performance fees charged on this box and held in escrow, not yet
   * released to the owner's Bonus Wallet (CopyBox.accruedFeeUsd — rupees,
   * whatever the name says). Owner lists only; 0 when none.
   */
  accruedFee: number;
  /** Everything ever released to the owner from this box (CopyBox.lifetimeFeeReleasedUsd). */
  lifetimeFeeReleased: number;
  roiPct: number;
  followers: number;
  /** The owner's own override for this box. null = platform/profile default. Owner lists only. */
  feeOverride: number | null;
  /** The percent actually charged, as the server resolved it. null when not sent. */
  effectiveFee: number | null;
  /** Owner's list only — false when the source account is disabled/suspended/archived. */
  acceptsFollowers: boolean | null;
  accountActive: boolean | null;
  /** Leaderboard only — the owner's name. */
  ownerName: string | null;
  archived: boolean;
  archivedAt: string | null;
  level: string | null;
  verified: boolean;
  pinned: boolean;
  createdAt: string | null;
}

/**
 * The win rate the server attached, or — for the few responses that return
 * the bare document (create/update) — the server's own formula
 * (copyTradingService: `totalTrades ? wins / totalTrades * 100 : 0`).
 */
const winRateOf = (r: Raw): number => {
  const sent = num(r.winRate);
  if (sent !== null) return sent;
  const total = num(r.totalTrades) ?? 0;
  return total ? ((num(r.wins) ?? 0) / total) * 100 : 0;
};

const baseBox = (raw: unknown): CopyBox => {
  const r = obj(raw);
  return {
    id: id(r),
    userId: ref(r.userId) ?? '',
    accountId: ref(r.accountId) ?? '',
    accountNumber: str(r.accountNumber),
    accountType: str(r.accountType),
    displayName: str(r.displayName),
    bio: str(r.bio),
    avatarUrl: strOrNull(r.avatarUrl),
    isPublic: r.isPublic === true,
    riskBadge: riskBadge(r.riskBadge),
    totalTrades: int(r.totalTrades),
    wins: int(r.wins),
    winRate: winRateOf(r),
    cumulativePnl: dec(r.cumulativePnl),
    accruedFee: num(r.accruedFeeUsd) ?? 0,
    lifetimeFeeReleased: num(r.lifetimeFeeReleasedUsd) ?? 0,
    roiPct: num(r.roiPct) ?? 0,
    followers: int(r.followers),
    feeOverride: null,
    effectiveFee: null,
    acceptsFollowers: boolOrNull(r.acceptsFollowers),
    accountActive: boolOrNull(r.accountActive),
    ownerName: strOrNull(r.ownerName),
    archived: r.archived === true,
    archivedAt: strOrNull(r.archivedAt),
    level: strOrNull(r.level),
    verified: r.verified === true,
    pinned: r.pinned === true,
    createdAt: strOrNull(r.createdAt),
  };
};

/** A box from the owner's own lists (`/boxes/me`, `/boxes/archived`, create/update). */
export const toCopyBox = (raw: unknown): CopyBox => {
  const r = obj(raw);
  return {
    ...baseBox(r),
    feeOverride: num(r.performanceFeePercent),
    effectiveFee: num(r.effectivePerformanceFee),
  };
};

/**
 * A public box from `/leaderboard`. The server has already replaced
 * `performanceFeePercent` with the RESOLVED fee (copyTradingService.leaderboard
 * → effFee), so it is the effective fee here, never an override.
 */
export const toLeaderboardEntry = (raw: unknown): CopyBox => {
  const r = obj(raw);
  return {
    ...baseBox(r),
    feeOverride: null,
    effectiveFee: num(r.effectivePerformanceFee) ?? num(r.performanceFeePercent),
  };
};

/** What a box / profile editor sends. `performanceFeePercent: null` clears the override. */
export interface CopyBoxUpdate {
  displayName?: string;
  bio?: string;
  riskBadge?: RiskBadge;
  isPublic?: boolean;
  performanceFeePercent?: number | null;
}

export interface CreateCopyBoxBody extends CopyBoxUpdate {
  accountId: string;
}

/**
 * The fee input as the editors hold it (a string) → what the server wants.
 * Blank is NULL, never omitted: the server reads `undefined` as "leave it
 * alone" and `null` as "back to the default" (copyTradingService.clampBoxFee),
 * so a master who cleared the field must send null or keep the old fee.
 */
export const feeInputToPayload = (input: string): number | null => {
  const t = input.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** Web wording (CopyTrade.jsx EditBoxModal): a public box must have a name. */
export const validateBoxForm = (f: { displayName: string; isPublic: boolean }): string | null =>
  (f.isPublic && !f.displayName.trim() ? 'Give your box a name before listing it publicly' : null);

/** The master-profile editor says it differently (CopyTrade.jsx ProfileEditorModal). */
export const validateProfileForm = (f: { displayName: string; isPublic: boolean }): string | null =>
  (f.isPublic && !f.displayName.trim() ? 'Display name required to go public' : null);

/**
 * "Become a master": preselect the first account WITHOUT a box — accounts
 * that already have one are shown disabled. None free = nothing selected.
 */
export const firstFreeAccount = (list: readonly EligibleAccount[]): string | null =>
  list.find((a) => !a.hasBox)?.accountId ?? null;

/** The toasts the web raises for the follower actions and the box toggles. */
export const COPY_ACTION_TOAST = { pause: 'Paused', resume: 'Resumed', stop: 'Stopped copying' } as const;

export const boxVisibilityToast = (wasPublic: boolean): string =>
  (wasPublic ? 'Box hidden from leaderboard' : 'Box is now live on the leaderboard');

/* ── Accounts eligible to become a box ────────────────────────────────── */

export interface EligibleAccount {
  accountId: string;
  accountNumber: string;
  accountType: string;
  nickname: string;
  baseCurrency: string;
  hasBox: boolean;
  isPublic: boolean;
  acceptsFollowers: boolean;
}

export const toEligibleAccount = (raw: unknown): EligibleAccount => {
  const r = obj(raw);
  return {
    accountId: str(r.accountId) || id(r),
    accountNumber: str(r.accountNumber),
    accountType: str(r.accountType),
    nickname: str(r.nickname),
    baseCurrency: str(r.baseCurrency, 'INR') || 'INR',
    hasBox: r.hasBox === true,
    isPublic: r.isPublic === true,
    // Absent reads as accepting — the server only ever sends an explicit false.
    acceptsFollowers: r.acceptsFollowers !== false,
  };
};

/* ── Master profile (owner-level) ─────────────────────────────────────── */

export interface TraderProfile {
  id: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string;
  isPublic: boolean;
  riskBadge: RiskBadge | null;
  totalTrades: number;
  wins: number;
  winRate: number;
  cumulativePnl: Decimal;
  roiPct: number;
  followers: number;
  /** Raw override; null = platform default. */
  performanceFeePercent: number | null;
  status: string | null;
  level: string | null;
}

export const toTraderProfile = (raw: unknown): TraderProfile | null => {
  const r = obj(raw);
  if (!Object.keys(r).length) return null;
  return {
    id: id(r),
    userId: ref(r.userId) ?? '',
    displayName: str(r.displayName),
    avatarUrl: strOrNull(r.avatarUrl),
    bio: str(r.bio),
    isPublic: r.isPublic === true,
    riskBadge: riskBadge(r.riskBadge),
    totalTrades: int(r.totalTrades),
    wins: int(r.wins),
    winRate: winRateOf(r),
    cumulativePnl: dec(r.cumulativePnl),
    roiPct: num(r.roiPct) ?? 0,
    followers: int(r.followers),
    performanceFeePercent: num(r.performanceFeePercent),
    status: strOrNull(r.status),
    level: strOrNull(r.level),
  };
};

/* ── Follower side: copy relations ────────────────────────────────────── */

export interface CopyMirror {
  id: string;
  symbol: string;
  side: string;
  masterQty: Decimal;
  followerQty: Decimal;
  status: string;
  followerPositionId: string | null;
  createdAt: string | null;
}

const toMirror = (raw: unknown): CopyMirror => {
  const r = obj(raw);
  return {
    id: id(r),
    symbol: str(r.symbol),
    side: str(r.side),
    masterQty: dec(r.masterQty),
    followerQty: dec(r.followerQty),
    status: str(r.status, 'OPEN'),
    followerPositionId: ref(r.followerPositionId),
    createdAt: strOrNull(r.createdAt),
  };
};

export interface CopyRelationMaster {
  displayName: string;
  accountNumber: string;
  accountType: string;
  riskBadge: RiskBadge | null;
  roiPct: number;
  userId: string;
}

export interface CopyRelation {
  id: string;
  followerId: string;
  masterId: string;
  masterAccountId: string | null;
  masterBoxId: string | null;
  followerAccountId: string;
  followerAccountNumber: string | null;
  followerAccountType: string | null;
  status: CopyStatus;
  lotMode: LotMode;
  customLot: number | null;
  lotMultiplier: number | null;
  riskMultiplier: number | null;
  /** null = uncapped. */
  maxLot: number | null;
  /** null = unlimited. */
  maxOpenTrades: number | null;
  copySL: boolean;
  copyTP: boolean;
  copyPending: boolean;
  startedAt: string | null;
  pausedAt: string | null;
  stoppedAt: string | null;
  /**
   * The live floating P&L of the OPEN copied positions, marked to market by
   * the server on every `/my-copies` read (copyTradingService.listMyCopies).
   * Not the stored field of the same name, which is never written.
   */
  runningPnl: Decimal;
  tradesCopied: number;
  wins: number;
  losses: number;
  netProfit: Decimal;
  grossProfit: Decimal;
  performanceFeePaid: Decimal;
  /** Legacy v1 field, still searchable on the web. */
  riskLevel: string | null;
  master: CopyRelationMaster | null;
  /** Mirrors whose follower position is really still open. */
  openMirrors: CopyMirror[];
}

export const toCopyRelation = (raw: unknown): CopyRelation => {
  const r = obj(raw);
  const m = r.master && typeof r.master === 'object' ? obj(r.master) : null;
  return {
    id: id(r),
    followerId: ref(r.followerId) ?? '',
    masterId: ref(r.masterId) ?? '',
    masterAccountId: ref(r.masterAccountId),
    masterBoxId: ref(r.masterBoxId),
    followerAccountId: ref(r.followerAccountId) ?? '',
    followerAccountNumber: strOrNull(r.followerAccountNumber),
    followerAccountType: strOrNull(r.followerAccountType),
    status: copyStatus(r.status),
    lotMode: lotMode(r.lotMode),
    customLot: num(r.customLot),
    lotMultiplier: num(r.lotMultiplier),
    riskMultiplier: num(r.riskMultiplier),
    maxLot: num(r.maxLot),
    maxOpenTrades: num(r.maxOpenTrades),
    copySL: boolDefaultTrue(r.copySL),
    copyTP: boolDefaultTrue(r.copyTP),
    copyPending: r.copyPending === true,
    startedAt: strOrNull(r.startedAt),
    pausedAt: strOrNull(r.pausedAt),
    stoppedAt: strOrNull(r.stoppedAt),
    runningPnl: dec(r.runningPnl),
    tradesCopied: int(r.tradesCopied),
    wins: int(r.wins),
    losses: int(r.losses),
    netProfit: dec(r.netProfit),
    grossProfit: dec(r.grossProfit),
    performanceFeePaid: dec(r.performanceFeePaid),
    riskLevel: strOrNull(r.riskLevel),
    master: m
      ? {
        displayName: str(m.displayName),
        accountNumber: str(m.accountNumber),
        accountType: str(m.accountType),
        riskBadge: riskBadge(m.riskBadge),
        roiPct: num(m.roiPct) ?? 0,
        userId: ref(m.userId) ?? '',
      }
      : null,
    openMirrors: rows<unknown>(r.openMirrors).map(toMirror),
  };
};

/** My-copies order: live first, then paused, then stopped (stable within a group). */
const COPY_STATUS_RANK: Record<CopyStatus, number> = { ACTIVE: 0, PAUSED: 1, STOPPED: 2 };

export const sortMyCopies = (list: readonly CopyRelation[]): CopyRelation[] =>
  [...list].sort((a, b) => COPY_STATUS_RANK[a.status] - COPY_STATUS_RANK[b.status]);

/** The "Search by trader, account or status…" box — same fields as the web. */
export const filterMyCopies = (list: readonly CopyRelation[], query: string): CopyRelation[] => {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((r) =>
    [r.master?.displayName, r.master?.accountNumber, r.followerAccountNumber, r.status, r.riskLevel]
      .some((v) => String(v ?? '').toLowerCase().includes(q)));
};

/* ── Copy settings (the setup / edit form) ────────────────────────────── */

/** Form state, as strings where the user types. Ported from CopySettingsFields.jsx. */
export interface CopySettings {
  lotMode: LotMode;
  customLot: string;
  maxLot: string;
  copySL: boolean;
  copyTP: boolean;
  copyPending: boolean;
}

export interface CopySettingsPayload {
  lotMode: LotMode;
  customLot?: number;
  maxLot: number | null;
  copySL: boolean;
  copyTP: boolean;
  copyPending: boolean;
}

/** CopySettingsFields.jsx LOT_MODES — the note says what each size means. */
export const LOT_MODE_OPTIONS: { id: LotMode; label: string; note: string }[] = [
  { id: 'LOW', label: 'Low', note: '0.5× master lot' },
  { id: 'MEDIUM', label: 'Medium', note: '1× master lot' },
  { id: 'HIGH', label: 'High', note: '1.5× master lot' },
  { id: 'CUSTOM', label: 'Custom', note: 'Fixed lot' },
];

export const defaultCopySettings = (): CopySettings => ({
  lotMode: 'MEDIUM', customLot: '0.10', maxLot: '',
  copySL: true, copyTP: true, copyPending: false,
});

/** The edit form's starting point — EditCopyModal.jsx:20-28. */
export const copySettingsFromRelation = (rel: CopyRelation): CopySettings => ({
  lotMode: rel.lotMode,
  customLot: rel.customLot !== null ? String(rel.customLot) : '0.10',
  maxLot: rel.maxLot !== null ? String(rel.maxLot) : '',
  copySL: rel.copySL,
  copyTP: rel.copyTP,
  copyPending: rel.copyPending,
});

/**
 * Form → request body. Blank "Max lot" is sent as NULL, never omitted: on an
 * edit the server merges this body over the stored session, and an absent
 * key would leave the old cap in place — silently.
 */
export const copySettingsPayload = (s: CopySettings): CopySettingsPayload => {
  const out: CopySettingsPayload = {
    lotMode: s.lotMode,
    maxLot: s.maxLot.trim() === '' ? null : Number(s.maxLot),
    copySL: s.copySL,
    copyTP: s.copyTP,
    copyPending: s.copyPending,
  };
  if (s.lotMode === 'CUSTOM') out.customLot = Number(s.customLot);
  return out;
};

/** Web wording, checked before the request (the server says the same). */
export const validateCopySettings = (s: CopySettings): string | null =>
  (s.lotMode === 'CUSTOM' && !(Number(s.customLot) > 0) ? 'Enter a custom lot size greater than 0' : null);

/* ── Copy preview (advisory balance check) ────────────────────────────── */

export interface CopyPreview {
  currency: string;
  currentBalance: number | null;
  recommendedBalance: number | null;
  /** Advisory only — copying is never blocked on it. */
  lowBalance: boolean;
}

export const toCopyPreview = (raw: unknown): CopyPreview | null => {
  const r = obj(raw);
  if (!Object.keys(r).length) return null;
  return {
    currency: str(r.currency, 'INR') || 'INR',
    currentBalance: num(r.currentBalance),
    recommendedBalance: num(r.recommendedBalance),
    lowBalance: r.lowBalance === true,
  };
};

/* ── Leaderboard: search, filter, sort, badges ────────────────────────── */

export type LeaderSort = 'roi' | 'newest' | 'followers' | 'winRate' | 'trades';
export type RiskFilter = 'ALL' | RiskBadge;

export const LEADER_SORT_OPTIONS: { id: LeaderSort; label: string }[] = [
  { id: 'roi', label: 'Sort: ROI' },
  { id: 'newest', label: 'Sort: Newest' },
  { id: 'followers', label: 'Sort: Followers' },
  { id: 'winRate', label: 'Sort: Win rate' },
  { id: 'trades', label: 'Sort: Trades' },
];

export const RISK_FILTER_OPTIONS: { id: RiskFilter; label: string }[] = [
  { id: 'ALL', label: 'All risk' },
  { id: 'LOW', label: 'Low risk' },
  { id: 'MEDIUM', label: 'Medium risk' },
  { id: 'HIGH', label: 'High risk' },
];

const time = (iso: string | null): number => {
  const t = iso ? new Date(iso).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
};

const LEADER_SORTERS: Record<LeaderSort, (a: CopyBox, b: CopyBox) => number> = {
  roi: (a, b) => b.roiPct - a.roiPct,
  followers: (a, b) => b.followers - a.followers,
  winRate: (a, b) => b.winRate - a.winRate,
  trades: (a, b) => b.totalTrades - a.totalTrades,
  newest: (a, b) => time(b.createdAt) - time(a.createdAt),
};

/** CopyTrade.jsx visibleLeaders — search name + bio, risk filter, sort. */
export const filterLeaders = (
  list: readonly CopyBox[],
  opts: { query: string; risk: RiskFilter; sortBy: LeaderSort },
): CopyBox[] => {
  let out = [...list];
  const s = opts.query.trim().toLowerCase();
  if (s) {
    out = out.filter((t) => t.displayName.toLowerCase().includes(s) || t.bio.toLowerCase().includes(s));
  }
  // A box without a badge counts as MEDIUM — the model's default.
  if (opts.risk !== 'ALL') out = out.filter((t) => (t.riskBadge ?? 'MEDIUM') === opts.risk);
  return out.sort(LEADER_SORTERS[opts.sortBy]);
};

export interface LeaderBadge { icon: string; label: string }

/** CopyTrade.jsx computeBadges — one badge per box, first rule to claim it wins. */
export const computeBadges = (leaders: readonly CopyBox[]): Record<string, LeaderBadge> => {
  const map: Record<string, LeaderBadge> = {};
  if (!leaders.length) return map;
  const add = (t: CopyBox | undefined, badge: LeaderBadge) => {
    if (t && !map[t.id]) map[t.id] = badge;
  };
  const byRoi = [...leaders].sort((a, b) => b.roiPct - a.roiPct);
  const byFollowers = [...leaders].sort((a, b) => b.followers - a.followers);
  const byWin = [...leaders].sort((a, b) => b.winRate - a.winRate);
  add(byRoi[0], { icon: '🏆', label: 'Top Trader' });
  add(byFollowers[0], { icon: '🔥', label: 'Most Followed' });
  add(byRoi.find((t) => t.followers >= 100 && t.roiPct >= 50), { icon: '💎', label: 'Elite' });
  add(byWin.find((t) => t.winRate >= 55 && t.followers < 50), { icon: '⭐', label: 'Rising Star' });
  return map;
};

/** Delete-box confirmation, in the web's words. */
export const deleteBoxConfirmText = (box: CopyBox): string => {
  const name = box.displayName || box.accountNumber;
  return box.followers > 0
    ? `Delete "${name}"? Its ${box.followers} follower(s) will be stopped (open mirrored trades stay open). The box is moved to Archived — you can restore it later.`
    : `Delete "${name}"? It's moved to Archived (kept in history) — you can restore it later.`;
};

/* ── Live feed ────────────────────────────────────────────────────────── */

export interface FeedEvent {
  id: string;
  masterId: string;
  masterName: string;
  type: FeedEventType;
  symbol: string | null;
  side: string | null;
  qty: Decimal | null;
  price: Decimal | null;
  /** Signed, set on CLOSE / TP_HIT / SL_HIT. */
  pnl: Decimal | null;
  pctMove: string | null;
  /** Pre-formatted by the server; preferred over anything built here. */
  note: string | null;
  createdAt: string | null;
}

const FEED_TYPES: readonly FeedEventType[] = ['OPEN', 'CLOSE', 'TP_HIT', 'SL_HIT', 'FOLLOWED'];

export const toFeedEvent = (raw: unknown): FeedEvent => {
  const r = obj(raw);
  const t = str(r.type).toUpperCase();
  const decOrNull = (v: unknown): Decimal | null => {
    const d = dec(v, '');
    return d === '' ? null : d;
  };
  return {
    id: id(r),
    masterId: ref(r.masterId) ?? '',
    masterName: str(r.masterName),
    type: (FEED_TYPES as readonly string[]).includes(t) ? (t as FeedEventType) : 'OPEN',
    symbol: strOrNull(r.symbol),
    side: strOrNull(r.side),
    qty: decOrNull(r.qty),
    price: decOrNull(r.price),
    pnl: decOrNull(r.pnl),
    pctMove: strOrNull(r.pctMove),
    note: strOrNull(r.note),
    createdAt: strOrNull(r.createdAt),
  };
};

/** FeedRow headline — the server's note, else `<master> <type> <symbol>`. */
export const feedEventText = (e: FeedEvent): string =>
  e.note ?? `${e.masterName} ${e.type.toLowerCase()} ${e.symbol ?? ''}`.trim();

/** P&L is shown only on closing events, and only when it is a real number. */
export const feedShowsPnl = (e: FeedEvent): boolean =>
  e.pnl !== null && Number.isFinite(Number(e.pnl))
  && (e.type === 'CLOSE' || e.type === 'TP_HIT' || e.type === 'SL_HIT');

/** CopyTrade.jsx formatElapsed — "12s ago", "5m ago", "3h ago", "2d ago". */
export const formatElapsed = (ms: number): string => {
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s ago`;
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
};

/* ── Trader dashboard (read-only analytics) ───────────────────────────── */

export interface ChartPoint { label: string; value: number }
export interface EquityPoint { t: string; equity: number }
export interface DistributionBucket { bucket: string; count: number; positive: boolean }

export interface TraderAnalytics {
  trader: {
    userId: string;
    accountId: string | null;
    accountNumber: string | null;
    accountType: string | null;
    displayName: string;
    avatarUrl: string | null;
    bio: string;
    riskBadge: RiskBadge | null;
    isPublic: boolean;
    /** KYC approved. */
    verified: boolean;
    joinedAt: string | null;
    country: string | null;
    tradingStyle: string | null;
    /** Closed a trade within the last 7 days. */
    activeStatus: boolean;
    riskScore: number | null;
    followers: number;
    aum: number | null;
    performanceFeePercent: number | null;
  };
  performance: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    totalPnL: number | null;
    totalROI: number | null;
    monthlyROI: number | null;
    weeklyROI: number | null;
    dailyROI: number | null;
    avgWin: number | null;
    avgLoss: number | null;
    profitFactor: number | null;
    avgDurationMs: number | null;
  };
  risk: {
    riskScore: number | null;
    riskTier: string | null;
    maxDrawdownPct: number | null;
    avgDrawdownPct: number | null;
    sharpe: number | null;
    recoveryFactor: number | null;
    avgLeverage: number | null;
    slUsagePct: number | null;
    maxWinStreak: number;
    maxLossStreak: number;
  };
  charts: {
    /** Full curve; the screen filters by range. */
    equityCurve: EquityPoint[];
    monthly: ChartPoint[];
    weekly: ChartPoint[];
    distribution: DistributionBucket[];
  };
  followers: {
    total: number;
    active: number;
    newThisMonth: number;
    aum: number | null;
    avgFollowerRoi: number | null;
    copiedTrades: number;
    /** Performance-fee earnings (INR). */
    generatedCommission: number | null;
  };
  earnings: TraderEarnings & {
    performanceFeePercent: number | null;
  };
  initialEquity: number | null;
}

/**
 * A master's performance-fee rollup (copyEarningsService.getMasterEarnings),
 * INR. Fees are charged per profitable close and held in ESCROW on the
 * boxes; "Transfer Commission" moves them to the Bonus Wallet, and only in a
 * month the master's own net P&L is positive.
 */
export interface TraderEarnings {
  total: number | null;
  today: number | null;
  month: number | null;
  count: number;
  avgFeePercent: number | null;
  /** Sitting in escrow across every box. */
  accruedPending: number | null;
  /** All of the escrow while this month's net P&L is not positive, else 0. */
  accruedBlocked: number | null;
  /** What a transfer would move right now. */
  withdrawable: number | null;
  /** The master's own net P&L this calendar month — the transfer gate. */
  monthlyPnl: number | null;
}

export interface EarningsGate {
  pending: number;
  blocked: number;
  /** null when the server did not say — the card shows "—". */
  monthPnl: number | null;
  /** Escrow is waiting and this month's P&L is not positive: the transfer is locked. */
  isMonthNegative: boolean;
  /** Exactly what the server would move, so the button and the API agree. */
  canTransfer: boolean;
}

/**
 * TraderDashboard.jsx MasterEarnings: the gate is THIS calendar month's net
 * P&L, strictly positive (copyEarningsService.transferCommission refuses at
 * zero), and the button enables on `withdrawable` alone.
 */
export const earningsGate = (e: Pick<TraderEarnings, 'accruedPending' | 'accruedBlocked' | 'monthlyPnl' | 'withdrawable'>): EarningsGate => {
  const pending = Number(e.accruedPending || 0);
  const blocked = Number(e.accruedBlocked || 0);
  const monthPnl = e.monthlyPnl !== null && e.monthlyPnl !== undefined ? Number(e.monthlyPnl) : null;
  return {
    pending,
    blocked,
    monthPnl,
    isMonthNegative: monthPnl !== null && monthPnl <= 0 && pending > 0,
    canTransfer: Number(e.withdrawable || 0) > 0,
  };
};

/** TraderDashboard.jsx handleTransfer's refusal, in its words. */
export const transferErrorText = (err: unknown): string => {
  const e = err as { response?: { data?: { error?: { code?: unknown; message?: unknown } } } } | null | undefined;
  const body = e?.response?.data?.error;
  if (body?.code === 'MONTHLY_PNL_NEGATIVE') return 'Transfer blocked: your net trading P&L for this month must be positive.';
  return typeof body?.message === 'string' && body.message ? body.message : 'Transfer failed. Please try again.';
};

export const toTraderEarnings = (raw: unknown): TraderEarnings => {
  const e = obj(raw);
  return {
    total: num(e.total),
    today: num(e.today),
    month: num(e.month),
    count: int(e.count),
    avgFeePercent: num(e.avgFeePercent),
    accruedPending: num(e.accruedPending),
    accruedBlocked: num(e.accruedBlocked),
    withdrawable: num(e.withdrawable),
    monthlyPnl: num(e.monthlyPnlUsd),
  };
};

const toChartPoints = (v: unknown): ChartPoint[] =>
  rows<unknown>(v).map((x) => {
    const r = obj(x);
    return { label: str(r.label), value: num(r.value) ?? 0 };
  });

export const toTraderAnalytics = (raw: unknown): TraderAnalytics | null => {
  const r = obj(raw);
  if (!r.trader && !r.performance) return null;
  const t = obj(r.trader);
  const p = obj(r.performance);
  const k = obj(r.risk);
  const c = obj(r.charts);
  const f = obj(r.followers);
  const e = obj(r.earnings);
  return {
    trader: {
      userId: str(t.userId),
      accountId: strOrNull(t.accountId),
      accountNumber: strOrNull(t.accountNumber),
      accountType: strOrNull(t.accountType),
      displayName: str(t.displayName, 'Trader') || 'Trader',
      avatarUrl: strOrNull(t.avatarUrl),
      bio: str(t.bio),
      riskBadge: riskBadge(t.riskBadge),
      isPublic: t.isPublic === true,
      verified: t.verified === true,
      joinedAt: strOrNull(t.joinedAt),
      country: strOrNull(t.country),
      tradingStyle: strOrNull(t.tradingStyle),
      activeStatus: t.activeStatus === true,
      riskScore: num(t.riskScore),
      followers: int(t.followers),
      aum: num(t.aum),
      performanceFeePercent: num(t.performanceFeePercent),
    },
    performance: {
      totalTrades: int(p.totalTrades),
      wins: int(p.wins),
      losses: int(p.losses),
      winRate: num(p.winRate),
      totalPnL: num(p.totalPnL),
      totalROI: num(p.totalROI),
      monthlyROI: num(p.monthlyROI),
      weeklyROI: num(p.weeklyROI),
      dailyROI: num(p.dailyROI),
      avgWin: num(p.avgWin),
      avgLoss: num(p.avgLoss),
      profitFactor: num(p.profitFactor),
      avgDurationMs: num(p.avgDurationMs),
    },
    risk: {
      riskScore: num(k.riskScore),
      riskTier: strOrNull(k.riskTier),
      maxDrawdownPct: num(k.maxDrawdownPct),
      avgDrawdownPct: num(k.avgDrawdownPct),
      sharpe: num(k.sharpe),
      recoveryFactor: num(k.recoveryFactor),
      avgLeverage: num(k.avgLeverage),
      slUsagePct: num(k.slUsagePct),
      maxWinStreak: int(k.maxWinStreak),
      maxLossStreak: int(k.maxLossStreak),
    },
    charts: {
      equityCurve: rows<unknown>(c.equityCurve).map((x) => {
        const q = obj(x);
        return { t: str(q.t), equity: num(q.equity) ?? 0 };
      }),
      monthly: toChartPoints(c.monthly),
      weekly: toChartPoints(c.weekly),
      distribution: rows<unknown>(c.distribution).map((x) => {
        const q = obj(x);
        return { bucket: str(q.bucket), count: int(q.count), positive: q.positive === true };
      }),
    },
    followers: {
      total: int(f.total),
      active: int(f.active),
      newThisMonth: int(f.newThisMonth),
      aum: num(f.aum),
      avgFollowerRoi: num(f.avgFollowerRoi),
      copiedTrades: int(f.copiedTrades),
      generatedCommission: num(f.generatedCommission),
    },
    earnings: {
      ...toTraderEarnings(e),
      performanceFeePercent: num(e.performanceFeePercent),
    },
    initialEquity: num(r.initialEquity),
  };
};

export interface TraderOpenPosition {
  id: string;
  symbol: string;
  side: string;
  positionSide: string | null;
  quantity: Decimal;
  entryPrice: Decimal;
  /** The instrument's last price at read time; the screen may overlay live ticks. */
  currentPrice: Decimal;
  unrealizedPnl: Decimal;
  leverage: number | null;
  stopLoss: Decimal | null;
  takeProfit: Decimal | null;
  openedAt: string | null;
  pricePrecision: number;
}

export const toTraderOpenPosition = (raw: unknown): TraderOpenPosition => {
  const r = obj(raw);
  const decOrNull = (v: unknown): Decimal | null => {
    const d = dec(v, '');
    return d === '' || Number(d) === 0 ? null : d;
  };
  return {
    id: id(r),
    symbol: str(r.symbol),
    side: str(r.side),
    positionSide: strOrNull(r.positionSide),
    quantity: dec(r.quantity),
    entryPrice: dec(r.entryPrice),
    currentPrice: dec(r.currentPrice, dec(r.entryPrice)),
    unrealizedPnl: dec(r.unrealizedPnl),
    leverage: num(r.leverage),
    stopLoss: decOrNull(r.stopLoss),
    takeProfit: decOrNull(r.takeProfit),
    openedAt: strOrNull(r.openedAt),
    pricePrecision: num(r.pricePrecision) ?? 2,
  };
};

export interface TraderClosedTrade {
  id: string;
  symbol: string;
  side: string;
  entryPrice: Decimal;
  exitPrice: Decimal | null;
  realizedPnl: Decimal;
  openedAt: string | null;
  closedAt: string | null;
  durationMs: number | null;
  leverage: number | null;
  closeReason: string | null;
}

export const toTraderClosedTrade = (raw: unknown): TraderClosedTrade => {
  const r = obj(raw);
  const exit = dec(r.exitPrice, '');
  return {
    id: id(r),
    symbol: str(r.symbol),
    side: str(r.side),
    entryPrice: dec(r.entryPrice),
    exitPrice: exit === '' ? null : exit,
    realizedPnl: dec(r.realizedPnl),
    openedAt: strOrNull(r.openedAt),
    closedAt: strOrNull(r.closedAt),
    durationMs: num(r.durationMs),
    leverage: num(r.leverage),
    closeReason: strOrNull(r.closeReason),
  };
};

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export const toPaged = <T>(raw: unknown, map: (x: unknown) => T): Paged<T> => {
  const r = obj(raw);
  const items = rows<unknown>(r.items ?? raw).map(map);
  return {
    items,
    total: num(r.total) ?? items.length,
    page: num(r.page) ?? 1,
    limit: num(r.limit) ?? items.length,
    pages: Math.max(1, num(r.pages) ?? 1),
  };
};

/** The risk badge's colours and words (TraderDashboard RISK_TONE). */
export const RISK_TONE: Record<RiskBadge, { fg: string; bg: string; label: string }> = {
  LOW: { fg: '#16A34A', bg: 'rgba(22,163,74,0.12)', label: 'Low Risk' },
  MEDIUM: { fg: '#D97706', bg: 'rgba(217,119,6,0.12)', label: 'Medium Risk' },
  HIGH: { fg: '#DC2626', bg: 'rgba(220,38,38,0.12)', label: 'High Risk' },
};

export type EquityRange = '1D' | '1W' | '1M' | '3M' | '6M' | '1Y' | 'ALL';

export const EQUITY_RANGES: readonly EquityRange[] = ['1D', '1W', '1M', '3M', '6M', '1Y', 'ALL'];

const DAY_MS = 864e5;
const EQUITY_RANGE_MS: Record<EquityRange, number> = {
  '1D': DAY_MS, '1W': 7 * DAY_MS, '1M': 30 * DAY_MS, '3M': 90 * DAY_MS, '6M': 180 * DAY_MS, '1Y': 365 * DAY_MS, ALL: Infinity,
};

/**
 * The equity curve for a range. A range holding fewer than two points falls
 * back to the last two, so the card still draws a line and a change rather
 * than a lone dot.
 */
export const filterEquityCurve = (
  series: readonly EquityPoint[],
  range: EquityRange,
  now: number = Date.now(),
): EquityPoint[] => {
  if (range === 'ALL' || !series.length) return [...series];
  const cutoff = now - EQUITY_RANGE_MS[range];
  const f = series.filter((p) => new Date(p.t).getTime() >= cutoff);
  return f.length >= 2 ? f : series.slice(-2);
};

/** The card's headline: last equity and the change across the shown range, in percent. */
export const equityRangeSummary = (
  shown: readonly EquityPoint[],
  initialEquity: number | null,
): { last: number | null; changePct: number } => {
  const first = shown[0]?.equity ?? initialEquity;
  const last = shown[shown.length - 1]?.equity ?? initialEquity;
  return { last, changePct: first && last !== null ? ((last - first) / first) * 100 : 0 };
};

/**
 * TraderDashboard.jsx usdCompact — copied AUM in rupees: from a thousand up
 * in Indian units (₹12.5K, ₹3.2L, ₹1.4Cr — fmtInrCompact), below that the
 * full amount.
 */
export const fmtAumCompact = (v: number | null): string => {
  const n = v !== null && Number.isFinite(v) ? v : 0;
  return Math.abs(n) >= 1e3 ? fmtInrCompact(n) : fmtMoney(n);
};

/** An open position's age on the dashboard: just now / 5m / 3h / 2d ago. */
export const traderRelTime = (iso: string | null, now: number = Date.now()): string => {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const m = Math.floor((now - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

/** A holding time: "45m", "3.5h", "2.1d"; nothing held reads as a dash. */
export const fmtDuration = (ms: number | null): string => {
  if (!ms || ms <= 0) return '—';
  const m = ms / 60_000;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
};

export type HistoryPeriod = 'today' | 'week' | 'month' | 'all' | 'custom';

export const HISTORY_PERIODS: { k: HistoryPeriod; label: string }[] = [
  { k: 'today', label: 'Today' },
  { k: 'week', label: 'This Week' },
  { k: 'month', label: 'This Month' },
  { k: 'all', label: 'All' },
  { k: 'custom', label: 'Custom' },
];

export interface TraderHistoryQuery {
  period: HistoryPeriod;
  page: number;
  limit?: number;
  /** YYYY-MM-DD, custom period only. */
  from?: string;
  to?: string;
  accountId?: string | null;
}

/**
 * TraderDashboard.jsx TradeHistory params. `to` is widened to the end of the
 * chosen day so the range is inclusive — "to 2026-09-29" must include trades
 * closed that afternoon.
 */
export const traderHistoryParams = (q: TraderHistoryQuery): Record<string, string | number> => {
  const params: Record<string, string | number> = { period: q.period, page: q.page, limit: q.limit ?? 10 };
  if (q.accountId) params.accountId = q.accountId;
  if (q.period === 'custom') {
    if (q.from) params.from = q.from;
    if (q.to) params.to = `${q.to}T23:59:59.999`;
  }
  return params;
};

/* ── Per-relation analytics (the follower's analytics modal) ──────────── */

export interface CopyAnalyticsTrade {
  id: string;
  symbol: string;
  side: string;
  qty: number;
  entryPrice: number;
  closePrice: number;
  leverage: number;
  pnl: number;
  commission: number;
  swap: number;
  openedAt: string | null;
  closedAt: string | null;
}

export interface PeriodPnl { period: string; pnl: number }
export interface CurvePoint { t: string; pnl: number; equity: number }

export interface CopyAnalytics {
  currency: string;
  account: { number: string; nickname: string | null } | null;
  status: CopyStatus;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  performanceFeePaid: number;
  commission: number;
  swap: number;
  roi: number;
  totalTrades: number;
  closedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  lossRate: number;
  successRate: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  /** null means infinite — no losing trades. */
  profitFactor: number | null;
  riskReward: number;
  recoveryFactor: number;
  avgHoldingMinutes: number;
  avgVolume: number;
  totalLots: number;
  currentEquity: number;
  maxEquity: number;
  maxDrawdown: number;
  sharpe: number | null;
  curve: CurvePoint[];
  daily: PeriodPnl[];
  weekly: PeriodPnl[];
  monthly: PeriodPnl[];
  master: { displayName: string; roiPct: number; winRate: number; totalTrades: number } | null;
  /** Newest first. */
  trades: CopyAnalyticsTrade[];
}

const n0 = (v: unknown): number => num(v) ?? 0;

const toPeriodPnl = (v: unknown): PeriodPnl[] =>
  rows<unknown>(v).map((x) => {
    const r = obj(x);
    return { period: str(r.period), pnl: n0(r.pnl) };
  });

export const toCopyAnalytics = (raw: unknown): CopyAnalytics | null => {
  const r = obj(raw);
  if (!Object.keys(r).length) return null;
  const acc = r.account && typeof r.account === 'object' ? obj(r.account) : null;
  const m = r.master && typeof r.master === 'object' ? obj(r.master) : null;
  return {
    currency: str(r.currency, 'INR') || 'INR',
    account: acc ? { number: str(acc.number), nickname: strOrNull(acc.nickname) } : null,
    status: copyStatus(r.status),
    netProfit: n0(r.netProfit),
    grossProfit: n0(r.grossProfit),
    grossLoss: n0(r.grossLoss),
    performanceFeePaid: n0(r.performanceFeePaid),
    commission: n0(r.commission),
    swap: n0(r.swap),
    roi: n0(r.roi),
    totalTrades: int(r.totalTrades),
    closedTrades: int(r.closedTrades),
    openTrades: int(r.openTrades),
    wins: int(r.wins),
    losses: int(r.losses),
    winRate: n0(r.winRate),
    lossRate: n0(r.lossRate),
    successRate: n0(r.successRate),
    avgWin: n0(r.avgWin),
    avgLoss: n0(r.avgLoss),
    largestWin: n0(r.largestWin),
    largestLoss: n0(r.largestLoss),
    profitFactor: num(r.profitFactor),
    riskReward: n0(r.riskReward),
    recoveryFactor: n0(r.recoveryFactor),
    avgHoldingMinutes: n0(r.avgHoldingMinutes),
    avgVolume: n0(r.avgVolume),
    totalLots: n0(r.totalLots),
    currentEquity: n0(r.currentEquity),
    maxEquity: n0(r.maxEquity),
    maxDrawdown: n0(r.maxDrawdown),
    sharpe: num(r.sharpe),
    curve: rows<unknown>(r.curve).map((x) => {
      const q = obj(x);
      return { t: str(q.t), pnl: n0(q.pnl), equity: n0(q.equity) };
    }),
    daily: toPeriodPnl(r.daily),
    weekly: toPeriodPnl(r.weekly),
    monthly: toPeriodPnl(r.monthly),
    master: m
      ? { displayName: str(m.displayName), roiPct: n0(m.roiPct), winRate: n0(m.winRate), totalTrades: int(m.totalTrades) }
      : null,
    trades: rows<unknown>(r.trades).map((x) => {
      const q = obj(x);
      return {
        id: str(q.id) || id(q),
        symbol: str(q.symbol),
        side: str(q.side),
        qty: n0(q.qty),
        entryPrice: n0(q.entryPrice),
        closePrice: n0(q.closePrice),
        leverage: num(q.leverage) ?? 1,
        pnl: n0(q.pnl),
        commission: n0(q.commission),
        swap: n0(q.swap),
        openedAt: strOrNull(q.openedAt),
        closedAt: strOrNull(q.closedAt),
      };
    }),
  };
};

export type AnalyticsPreset = 'all' | '7d' | '30d' | '90d';

export const ANALYTICS_PRESETS: { id: AnalyticsPreset; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
  { id: '90d', label: '90D' },
];

/** YYYY-MM-DD in the DEVICE's calendar (PORT-RULINGS §5), not UTC's. */
export const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * A preset → the analytics date filter. "7D" is today and the six days
 * before it — the web's `ago(6)`, inclusive of today.
 *
 * The web formats with `toISOString()`, i.e. the UTC calendar, so a trader
 * in India opening the modal before 05:30 got yesterday's range. This uses
 * the device's calendar.
 */
export const analyticsPresetRange = (preset: AnalyticsPreset, now: Date = new Date()): { from: string; to: string } => {
  const days = { all: 0, '7d': 6, '30d': 29, '90d': 89 }[preset];
  if (!days) return { from: '', to: '' };
  const start = new Date(now);
  start.setDate(start.getDate() - days);
  return { from: ymd(start), to: ymd(now) };
};

/** CopyAnalyticsModal.jsx exportCsv — same columns, same quoting. */
export const copyAnalyticsCsv = (trades: readonly CopyAnalyticsTrade[]): string => {
  const cols = ['Closed', 'Symbol', 'Side', 'Qty', 'Entry', 'Close', 'PnL', 'Commission', 'Swap'];
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const iso = (d: string | null) => {
    const t = d ? new Date(d) : null;
    return t && Number.isFinite(t.getTime()) ? t.toISOString() : '';
  };
  const lines = [cols.map(esc).join(',')];
  for (const t of trades) {
    lines.push([iso(t.closedAt), t.symbol, t.side, t.qty, t.entryPrice, t.closePrice, t.pnl, t.commission, t.swap]
      .map(esc).join(','));
  }
  return lines.join('\n');
};

/* ── Master earnings (performance fee) ────────────────────────────────── */

export interface FeeSettings {
  enabled: boolean;
  defaultFee: number | null;
  minFee: number | null;
  maxFee: number | null;
}

export interface EarningEvent {
  id: string;
  followerId: string;
  relationId: string | null;
  symbol: string;
  /** The FOLLOWER account's currency — realizedProfit / feeAmount are in it. */
  currency: string;
  realizedProfit: Decimal;
  feePercent: number | null;
  feeAmount: Decimal;
  /** The master's fee for this close (INR) — into escrow, released by a transfer. */
  feeAmountUsd: number | null;
  /** What the follower kept: realised profit less the fee (INR). */
  followerNetUsd: number | null;
  createdAt: string | null;
}

export interface MasterEarnings {
  summary: TraderEarnings;
  history: EarningEvent[];
  performanceFeePercent: number | null;
  settings: FeeSettings;
}

export const toMasterEarnings = (raw: unknown): MasterEarnings | null => {
  const r = obj(raw);
  if (!Object.keys(r).length) return null;
  const s = obj(r.summary);
  const f = obj(r.settings);
  return {
    summary: toTraderEarnings(s),
    history: rows<unknown>(r.history).map((x) => {
      const q = obj(x);
      return {
        id: id(q),
        followerId: ref(q.followerId) ?? '',
        relationId: ref(q.relationId),
        symbol: str(q.symbol),
        currency: str(q.currency, 'INR') || 'INR',
        realizedProfit: dec(q.realizedProfit),
        feePercent: num(q.feePercent),
        feeAmount: dec(q.feeAmount),
        feeAmountUsd: num(q.feeAmountUsd),
        followerNetUsd: num(q.followerNetUsd),
        createdAt: strOrNull(q.createdAt),
      };
    }),
    performanceFeePercent: num(r.performanceFeePercent),
    settings: {
      enabled: f.enabled !== false,
      defaultFee: num(f.defaultFee),
      minFee: num(f.minFee),
      maxFee: num(f.maxFee),
    },
  };
};

export interface TopEarner {
  masterId: string;
  displayName: string;
  avatarUrl: string | null;
  totalEarnings: number | null;
  trades: number;
}

export const toTopEarner = (raw: unknown): TopEarner => {
  const r = obj(raw);
  return {
    masterId: str(r.masterId),
    displayName: str(r.displayName),
    avatarUrl: strOrNull(r.avatarUrl),
    totalEarnings: num(r.totalEarnings),
    trades: int(r.trades),
  };
};
