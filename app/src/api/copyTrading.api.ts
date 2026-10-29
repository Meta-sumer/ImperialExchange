import type { AxiosResponse } from 'axios';

import { api } from '@/api/client';
import { rows } from '@/types/api';
import {
  toCopyAnalytics,
  toCopyBox,
  toCopyPreview,
  toCopyRelation,
  toEligibleAccount,
  toFeedEvent,
  toLeaderboardEntry,
  toMasterEarnings,
  toPaged,
  toTopEarner,
  toTraderAnalytics,
  toTraderClosedTrade,
  toTraderOpenPosition,
  toTraderProfile,
  traderHistoryParams,
  type CopyAnalytics,
  type CopyBox,
  type CopyBoxUpdate,
  type CopyPreview,
  type CopyRelation,
  type CopySettingsPayload,
  type CreateCopyBoxBody,
  type EligibleAccount,
  type FeedEvent,
  type MasterEarnings,
  type Paged,
  type RiskBadge,
  type TopEarner,
  type TraderAnalytics,
  type TraderClosedTrade,
  type TraderHistoryQuery,
  type TraderOpenPosition,
  type TraderProfile,
} from '@/types/copyTrading';
import { isDemoLike } from '@/utils/accountType';

/**
 * Copy trading — every endpoint under /api/copy-trading the web calls
 * (routes/copyTrading.js), the commission transfer included, plus the
 * top-earners read the backend also exposes.
 *
 * Every method returns ADAPTED rows (types/copyTrading), never the raw body,
 * so a screen cannot come to depend on a wrapper shape.
 *
 * Not ported: `DELETE /boxes/:id/purge`. The web deliberately offers no
 * permanent delete ("boxes can only be RESTORED … nothing is ever lost",
 * CopyTrade.jsx ArchivedBoxesSection), and a function that exists invites
 * a button that calls it.
 */

/** `{ success, data }` → data; anything else passes through. */
const payload = (res: AxiosResponse): unknown => {
  const b = res.data as unknown;
  if (b && typeof b === 'object' && 'success' in b && 'data' in b) return (b as { data: unknown }).data;
  return b;
};

const accountParams = (accountId?: string | null) => (accountId ? { accountId } : {});

export interface ProfileUpdate {
  displayName?: string;
  bio?: string;
  avatarUrl?: string;
  riskBadge?: RiskBadge;
  isPublic?: boolean;
  /** null = back to the platform default. The server clamps to [minFee, maxFee]. */
  performanceFeePercent?: number | null;
}

export const copyTradingApi = {
  /* ── Discover ─────────────────────────────────────────────────────── */

  /** Public boxes, excluding the caller's own (they live in "My boxes"). */
  leaderboard: async (limit = 50): Promise<CopyBox[]> =>
    rows<unknown>(payload(await api.get('/copy-trading/leaderboard', { params: { limit } }))).map(toLeaderboardEntry),

  feed: async (limit = 50): Promise<FeedEvent[]> =>
    rows<unknown>(payload(await api.get('/copy-trading/feed', { params: { limit } }))).map(toFeedEvent),

  /* ── Follower ─────────────────────────────────────────────────────── */

  /**
   * The caller's copy sessions, with live running P&L and the real open
   * count. Cheap enough that the web polls it every 6s while the list is on
   * screen.
   */
  myCopies: async (): Promise<CopyRelation[]> =>
    rows<unknown>(payload(await api.get('/copy-trading/my-copies'))).map(toCopyRelation),

  /** Advisory balance check for the copy dialog — never blocks copying. */
  copyPreview: async (q: { followerAccountId: string; masterAccountId?: string | null }): Promise<CopyPreview | null> =>
    toCopyPreview(payload(await api.get('/copy-trading/copy-preview', {
      params: { followerAccountId: q.followerAccountId, ...(q.masterAccountId ? { masterAccountId: q.masterAccountId } : {}) },
    }))),

  /**
   * Start copying a box into one of the caller's OWN live accounts. A
   * previously STOPPED session for the same box is resumed in place by the
   * server rather than duplicated.
   */
  startCopy: async (body: {
    masterAccountId: string;
    followerAccountId: string;
    settings: CopySettingsPayload;
  }): Promise<CopyRelation> =>
    toCopyRelation(payload(await api.post('/copy-trading/copy', {
      masterAccountId: body.masterAccountId,
      followerAccountId: body.followerAccountId,
      ...body.settings,
    }))),

  /**
   * Edit settings, and optionally move the session to another account.
   * `closePositions` decides what happens to mirrors open on the OLD account
   * — the web asks only when the account changed AND mirrors are open.
   */
  editCopy: async (relationId: string, body: {
    followerAccountId: string;
    closePositions: boolean;
    settings: CopySettingsPayload;
  }): Promise<CopyRelation> =>
    toCopyRelation(payload(await api.put(`/copy-trading/copy/${relationId}`, {
      followerAccountId: body.followerAccountId,
      closePositions: body.closePositions,
      ...body.settings,
    }))),

  /** Move only the destination account (backend route; the web edits via editCopy). */
  changeAccount: async (relationId: string, newAccountId: string, closePositions: boolean): Promise<CopyRelation> =>
    toCopyRelation(payload(await api.post(`/copy-trading/copy/${relationId}/change-account`, {
      newAccountId, closePositions,
    }))),

  /** Stop new copies; open mirrors stay open. */
  pause: async (relationId: string): Promise<CopyRelation> =>
    toCopyRelation(payload(await api.post('/copy-trading/pause', { relationId, closePositions: false }))),

  resume: async (relationId: string): Promise<CopyRelation> =>
    toCopyRelation(payload(await api.post('/copy-trading/resume', { relationId, closePositions: false }))),

  /**
   * Stop copying. `closePositions: true` is the Stop dialog's "close
   * automatically"; false leaves the open mirrors to close on their own.
   * The session is kept, so it can be resumed later with its history.
   */
  stop: async (relationId: string, closePositions: boolean): Promise<CopyRelation> =>
    toCopyRelation(payload(await api.post('/copy-trading/stop', { relationId, closePositions }))),

  /** Full analytics for one of the caller's sessions. `from`/`to` are YYYY-MM-DD. */
  analytics: async (relationId: string, range: { from?: string; to?: string } = {}): Promise<CopyAnalytics | null> => {
    const params: Record<string, string> = {};
    if (range.from) params.from = range.from;
    if (range.to) params.to = range.to;
    return toCopyAnalytics(payload(await api.get(`/copy-trading/copy/${relationId}/analytics`, { params })));
  },

  /* ── Master: boxes ────────────────────────────────────────────────── */

  myBoxes: async (): Promise<CopyBox[]> =>
    rows<unknown>(payload(await api.get('/copy-trading/boxes/me'))).map(toCopyBox),

  archivedBoxes: async (): Promise<CopyBox[]> =>
    rows<unknown>(payload(await api.get('/copy-trading/boxes/archived'))).map(toCopyBox),

  /**
   * The caller's accounts that could become a box, flagged if one already
   * has. Demo accounts are dropped here as well as on the server — the web
   * does the same (CopyTrade.jsx BecomeMasterModal), and a practice account
   * offered as a copy source is a promise the server will refuse.
   */
  eligibleAccounts: async (): Promise<EligibleAccount[]> =>
    rows<unknown>(payload(await api.get('/copy-trading/eligible-accounts')))
      .map(toEligibleAccount)
      .filter((a) => !isDemoLike(a.accountType)),

  createBox: async (body: CreateCopyBoxBody): Promise<CopyBox> =>
    toCopyBox(payload(await api.post('/copy-trading/boxes', body))),

  updateBox: async (boxId: string, patch: CopyBoxUpdate): Promise<CopyBox> =>
    toCopyBox(payload(await api.put(`/copy-trading/boxes/${boxId}`, patch))),

  /**
   * "Delete" ARCHIVES the box: active followers are stopped (their open
   * mirrors stay open), it leaves the leaderboard, and it can be restored.
   */
  archiveBox: async (boxId: string): Promise<void> => {
    await api.delete(`/copy-trading/boxes/${boxId}`);
  },

  /** Back to the active list, PRIVATE until the owner republishes it. */
  restoreBox: async (boxId: string): Promise<CopyBox> =>
    toCopyBox(payload(await api.post(`/copy-trading/boxes/${boxId}/restore`))),

  /* ── Master: profile + earnings ───────────────────────────────────── */

  /** Created on first read by the server, so this is null only on a bad body. */
  myProfile: async (): Promise<TraderProfile | null> =>
    toTraderProfile(payload(await api.get('/copy-trading/profile/me'))),

  updateMyProfile: async (patch: ProfileUpdate): Promise<TraderProfile | null> =>
    toTraderProfile(payload(await api.put('/copy-trading/profile/me', patch))),

  myEarnings: async (limit?: number): Promise<MasterEarnings | null> =>
    toMasterEarnings(payload(await api.get('/copy-trading/earnings/me', { params: limit ? { limit } : {} }))),

  topEarners: async (limit?: number): Promise<TopEarner[]> =>
    rows<unknown>(payload(await api.get('/copy-trading/earnings/top', { params: limit ? { limit } : {} }))).map(toTopEarner),

  /**
   * "Transfer Commission" — POST /copy-trading/earnings/transfer moves every
   * box's escrowed fees into the Bonus Wallet. The server refuses unless the
   * master's own net P&L this month is positive (MONTHLY_PNL_NEGATIVE, as a
   * plain message). Answers what it moved, 0 when there was nothing.
   */
  transferCommission: async (): Promise<{ transferred: number; boxes: number }> => {
    const d = (payload(await api.post('/copy-trading/earnings/transfer')) ?? {}) as Record<string, unknown>;
    const transferred = Number(d.transferred);
    const boxes = Number(d.boxes);
    return { transferred: Number.isFinite(transferred) ? transferred : 0, boxes: Number.isFinite(boxes) ? boxes : 0 };
  },

  /* ── Trader dashboard (read-only; 403 PROFILE_PRIVATE when not public) ─ */

  /** `accountId` scopes everything to one box; omit it for the trader overall. */
  trader: async (userId: string, accountId?: string | null): Promise<TraderAnalytics | null> =>
    toTraderAnalytics(payload(await api.get(`/copy-trading/trader/${userId}`, { params: accountParams(accountId) }))),

  traderPositions: async (userId: string, accountId?: string | null): Promise<TraderOpenPosition[]> =>
    rows<unknown>(payload(await api.get(`/copy-trading/trader/${userId}/positions`, {
      params: accountParams(accountId),
    }))).map(toTraderOpenPosition),

  traderHistory: async (userId: string, q: TraderHistoryQuery): Promise<Paged<TraderClosedTrade>> =>
    toPaged(payload(await api.get(`/copy-trading/trader/${userId}/history`, {
      params: traderHistoryParams(q),
    })), toTraderClosedTrade),
};

export type CopyTradingApi = typeof copyTradingApi;
