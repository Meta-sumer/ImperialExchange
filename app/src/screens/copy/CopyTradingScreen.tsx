import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';

import { errorMessage } from '@/api/client';
import { copyTradingApi } from '@/api/copyTrading.api';
import { CopyAnalyticsModal } from '@/components/copy/CopyAnalyticsModal';
import {
  BecomeMasterModal,
  CopySetupModal,
  EditBoxModal,
  EditCopyModal,
  StopCopyModal,
  type CopyTarget,
} from '@/components/copy/CopyModals';
import { AppText, Button, Input, PageHero, Screen, Select, Tabs, toast, useConfirm } from '@/components/ui';
import type { AppScreenProps } from '@/navigation/types';
import { useTheme } from '@/theme';
import {
  COPY_ACTION_TOAST,
  LEADER_SORT_OPTIONS,
  RISK_FILTER_OPTIONS,
  RISK_TONE,
  boxVisibilityToast,
  computeBadges,
  deleteBoxConfirmText,
  feedEventText,
  feedShowsPnl,
  filterLeaders,
  filterMyCopies,
  formatElapsed,
  sortMyCopies,
  type CopyBox,
  type CopyRelation,
  type FeedEvent,
  type LeaderBadge,
  type LeaderSort,
  type RiskFilter,
  type TraderProfile,
} from '@/types/copyTrading';
import { fmtMoney } from '@/utils/money';
import { useForeground } from '@/websocket/channels';

type CopyTab = 'discover' | 'feed' | 'mine';

/** The web's full refresh cadence, and the running-P&L fast lane. */
const REFRESH_MS = 30_000;
const MINE_REFRESH_MS = 6_000;

const toTarget = (b: CopyBox): CopyTarget => ({
  userId: b.userId,
  accountId: b.accountId,
  displayName: b.displayName,
  roiPct: b.roiPct,
  winRate: b.winRate,
  followers: b.followers,
  fee: b.effectiveFee,
});

/**
 * Copy Trading — client/src/pages/CopyTrade.jsx: my copy boxes (one per
 * source trading account; edit, go public / private, archive, view), the
 * archived boxes (restore only), and three sections — Discover (the
 * leaderboard with search, risk filter and sort; badges for standouts), the
 * live Feed, and My Copies (running P&L; analytics, pause / resume, edit,
 * stop). On a phone the three sections are tabs, as on the web's mobile
 * layout (Discover also shows the feed and my copies under the leaderboard).
 *
 * Everything re-reads every 30 s and when the app returns to the foreground;
 * my copies re-read every 6 s while they are on screen, so Running P&L tracks
 * the live floating P&L. Polls pause while another screen is in front.
 */
export function CopyTradingScreen({ navigation }: AppScreenProps<'CopyTrading'>): React.JSX.Element {
  const t = useTheme();
  const focused = useIsFocused();
  const confirm = useConfirm();
  const [tab, setTab] = useState<CopyTab>('discover');
  const [leaders, setLeaders] = useState<CopyBox[]>([]);
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [mine, setMine] = useState<CopyRelation[]>([]);
  const [myProfile, setMyProfile] = useState<TraderProfile | null>(null);
  const [myBoxes, setMyBoxes] = useState<CopyBox[]>([]);
  const [archivedBoxes, setArchivedBoxes] = useState<CopyBox[]>([]);
  const [mineQ, setMineQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [copyTarget, setCopyTarget] = useState<CopyTarget | null>(null);
  const [becomeMaster, setBecomeMaster] = useState(false);
  const [editingBox, setEditingBox] = useState<CopyBox | null>(null);
  const [editRel, setEditRel] = useState<CopyRelation | null>(null);
  const [stopRel, setStopRel] = useState<CopyRelation | null>(null);
  const [analyticsRel, setAnalyticsRel] = useState<CopyRelation | null>(null);
  const [q, setQ] = useState('');
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('ALL');
  const [sortBy, setSortBy] = useState<LeaderSort>('roi');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const badges = useMemo(() => computeBadges(leaders), [leaders]);
  const visibleLeaders = useMemo(() => filterLeaders(leaders, { query: q, risk: riskFilter, sortBy }), [leaders, q, riskFilter, sortBy]);
  const filteredMine = useMemo(() => filterMyCopies(sortMyCopies(mine), mineQ), [mine, mineQ]);

  const refresh = useCallback(async () => {
    try {
      const [lb, fd, mc, mp, bx, ar] = await Promise.allSettled([
        copyTradingApi.leaderboard(50),
        copyTradingApi.feed(50),
        copyTradingApi.myCopies(),
        copyTradingApi.myProfile(),
        copyTradingApi.myBoxes(),
        copyTradingApi.archivedBoxes(),
      ]);
      if (!alive.current) return;
      if (lb.status === 'fulfilled') setLeaders(lb.value);
      if (fd.status === 'fulfilled') setFeed(fd.value);
      if (mc.status === 'fulfilled') setMine(mc.value);
      if (mp.status === 'fulfilled') setMyProfile(mp.value);
      if (bx.status === 'fulfilled') setMyBoxes(bx.value);
      if (ar.status === 'fulfilled') setArchivedBoxes(ar.value);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  const refreshMine = useCallback(async () => {
    try {
      const mc = await copyTradingApi.myCopies();
      if (alive.current) setMine(mc);
    } catch { /* background poll */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useForeground(() => { void refresh(); });
  useEffect(() => {
    if (!focused) return undefined;
    const id = setInterval(() => { if (AppState.currentState === 'active') void refresh(); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [focused, refresh]);
  useEffect(() => {
    if (!focused || (tab !== 'mine' && tab !== 'discover')) return undefined;
    const id = setInterval(() => { if (AppState.currentState === 'active') void refreshMine(); }, MINE_REFRESH_MS);
    return () => clearInterval(id);
  }, [focused, tab, refreshMine]);

  const setStatus = async (relationId: string, route: 'pause' | 'resume' | 'stop', closePositions = false): Promise<void> => {
    try {
      if (route === 'pause') await copyTradingApi.pause(relationId);
      else if (route === 'resume') await copyTradingApi.resume(relationId);
      else await copyTradingApi.stop(relationId, closePositions);
      toast.success(COPY_ACTION_TOAST[route]);
      void refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const toggleBoxPublic = async (box: CopyBox): Promise<void> => {
    try {
      await copyTradingApi.updateBox(box.id, { isPublic: !box.isPublic });
      toast.success(boxVisibilityToast(box.isPublic));
      void refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const deleteBox = async (box: CopyBox): Promise<void> => {
    if (!(await confirm({ title: 'Delete copy box', message: deleteBoxConfirmText(box), confirmText: 'Delete', danger: true }))) return;
    try {
      await copyTradingApi.archiveBox(box.id);
      toast.success('Copy box archived');
      void refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const restoreBox = async (box: CopyBox): Promise<void> => {
    try {
      await copyTradingApi.restoreBox(box.id);
      toast.success('Copy box restored');
      void refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const viewTrader = (b: CopyBox): void => navigation.navigate('TraderDashboard', { id: b.userId, account: b.accountId });

  return (
    <Screen onRefresh={refresh} testID="copy-trading-screen">
      <View style={styles.page}>
        <PageHero
          eyebrow="Social"
          title="Copy Trading"
          subtitle="Mirror the trades of top performers automatically. Pick a trader, set your investment, and the system copies their entries, closes and SL/TP for you."
          actions={<Button title="Become a master trader" leftIcon="plus" size="sm" onPress={() => setBecomeMaster(true)} />}
        />

        <MyBoxes
          boxes={myBoxes}
          onCreate={() => setBecomeMaster(true)}
          onToggle={(b) => { void toggleBoxPublic(b); }}
          onEdit={setEditingBox}
          onDelete={(b) => { void deleteBox(b); }}
          onView={viewTrader}
        />
        <ArchivedBoxes boxes={archivedBoxes} onRestore={(b) => { void restoreBox(b); }} />

        <Tabs
          variant="pill"
          tabs={[{ key: 'discover', label: 'Discover' }, { key: 'feed', label: 'Feed' }, { key: 'mine', label: 'My Copies' }]}
          value={tab}
          onChange={setTab}
        />

        {loading ? (
          <AppText variant="body" tone="muted" style={styles.loading}>Loading…</AppText>
        ) : (
          <>
            {tab === 'discover' ? (
              <View>
                <SectionHeader title="Top traders" count={leaders.length} />
                {leaders.length === 0 ? (
                  <Empty text="No public copy boxes yet — create one from your trading account to get listed." />
                ) : (
                  <>
                    <View style={styles.filters}>
                      <Input value={q} onChangeText={setQ} placeholder="Search traders…" accessibilityLabel="Search traders" />
                      <View style={styles.row}>
                        <View style={styles.flex}>
                          <Select
                            value={riskFilter}
                            title="Risk"
                            options={RISK_FILTER_OPTIONS.map((o) => ({ value: o.id, label: o.label }))}
                            onChange={(v) => setRiskFilter(v as RiskFilter)}
                          />
                        </View>
                        <View style={styles.flex}>
                          <Select
                            value={sortBy}
                            title="Sort"
                            options={LEADER_SORT_OPTIONS.map((o) => ({ value: o.id, label: o.label }))}
                            onChange={(v) => setSortBy(v as LeaderSort)}
                          />
                        </View>
                      </View>
                    </View>
                    {visibleLeaders.length === 0 ? (
                      <Empty text="No traders match your filters." />
                    ) : (
                      <View style={styles.stack}>
                        {visibleLeaders.map((b) => (
                          <TraderCard
                            key={b.id}
                            trader={b}
                            badge={badges[b.id]}
                            onView={() => viewTrader(b)}
                            onCopy={() => setCopyTarget(toTarget(b))}
                          />
                        ))}
                      </View>
                    )}
                  </>
                )}
              </View>
            ) : null}

            {tab === 'feed' || tab === 'discover' ? (
              <View>
                <SectionHeader title="Live feed" count={feed.length} />
                <View style={[styles.card, styles.noPad, { borderColor: t.colors.borderDark, backgroundColor: t.colors.surface }]}>
                  {feed.length === 0 ? <AppText variant="small" tone="muted" align="center" style={styles.pad}>No activity yet</AppText> : null}
                  {feed.map((e, i) => <FeedRow key={e.id || String(i)} event={e} first={i === 0} />)}
                </View>
              </View>
            ) : null}

            {tab === 'mine' || tab === 'discover' ? (
              <View>
                <SectionHeader title="My copies" count={mine.length} />
                {mine.length === 0 ? (
                  <Empty text="You aren't copying anyone yet — pick a trader on the left to start." />
                ) : (
                  <View style={styles.stack}>
                    <Input value={mineQ} onChangeText={setMineQ} placeholder="Search by trader, account or status…" accessibilityLabel="Search my copies" />
                    {filteredMine.length === 0 ? (
                      <Empty text={`No copies match “${mineQ}”.`} />
                    ) : filteredMine.map((rel) => (
                      <MyCopyRow
                        key={rel.id}
                        rel={rel}
                        onAction={(route) => { void setStatus(rel.id, route); }}
                        onEdit={() => setEditRel(rel)}
                        onStop={() => setStopRel(rel)}
                        onAnalytics={() => setAnalyticsRel(rel)}
                      />
                    ))}
                  </View>
                )}
              </View>
            ) : null}
          </>
        )}
      </View>

      {copyTarget ? (
        <CopySetupModal trader={copyTarget} onClose={() => setCopyTarget(null)} onStarted={() => { setCopyTarget(null); void refresh(); setTab('mine'); }} />
      ) : null}
      {becomeMaster ? (
        <BecomeMasterModal
          initialFee={myProfile?.performanceFeePercent ?? null}
          onClose={() => setBecomeMaster(false)}
          onCreated={() => { setBecomeMaster(false); void refresh(); setTab('mine'); }}
        />
      ) : null}
      {editingBox ? <EditBoxModal box={editingBox} onClose={() => setEditingBox(null)} onSaved={() => { setEditingBox(null); void refresh(); }} /> : null}
      {editRel ? <EditCopyModal rel={editRel} onClose={() => setEditRel(null)} onSaved={() => { setEditRel(null); void refresh(); }} /> : null}
      {stopRel ? (
        <StopCopyModal
          rel={stopRel}
          onClose={() => setStopRel(null)}
          onConfirm={async (closePositions) => { await setStatus(stopRel.id, 'stop', closePositions); setStopRel(null); }}
        />
      ) : null}
      {analyticsRel ? <CopyAnalyticsModal rel={analyticsRel} onClose={() => setAnalyticsRel(null)} /> : null}
    </Screen>
  );
}

/* ── Sections ────────────────────────────────────────────────────────── */

function SectionHeader({ title, count }: { title: string; count?: number }): React.JSX.Element {
  return (
    <View style={styles.sectionHead}>
      <AppText variant="title" weight="800">{title}</AppText>
      {count !== undefined ? <AppText variant="caption" tone="muted">{String(count)}</AppText> : null}
    </View>
  );
}

function Empty({ text }: { text: string }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[styles.card, { borderColor: t.colors.borderDark, backgroundColor: t.colors.surface }]}>
      <AppText variant="small" tone="muted" align="center">{text}</AppText>
    </View>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'bull' | 'bear' }): React.JSX.Element {
  const t = useTheme();
  const color = tone === 'bull' ? t.colors.bull : tone === 'bear' ? t.colors.bear : t.colors.textPrimary;
  return (
    <View style={[styles.stat, { backgroundColor: t.alpha(t.colors.bgHover, 0.4) }]}>
      <AppText variant="micro" weight="700" tone="muted">{label.toUpperCase()}</AppText>
      <AppText variant="small" weight="800" mono color={color}>{value}</AppText>
    </View>
  );
}

const roiText = (roi: number): string => `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`;

function MyBoxes({
  boxes,
  onCreate,
  onToggle,
  onEdit,
  onDelete,
  onView,
}: {
  boxes: readonly CopyBox[];
  onCreate: () => void;
  onToggle: (b: CopyBox) => void;
  onEdit: (b: CopyBox) => void;
  onDelete: (b: CopyBox) => void;
  onView: (b: CopyBox) => void;
}): React.JSX.Element {
  const t = useTheme();
  if (!boxes.length) {
    return (
      <View style={[styles.card, styles.invite, { borderColor: t.colors.borderDark, backgroundColor: t.colors.surface }]}>
        <View style={[styles.inviteIcon, { backgroundColor: t.alpha(t.colors.primary, 0.15) }]}>
          <AppText style={styles.inviteGlyph}>👥</AppText>
        </View>
        <View style={styles.flex}>
          <AppText variant="bodyStrong" weight="800">Become a master trader</AppText>
          <AppText variant="caption" tone="muted" style={styles.mt2}>
            {"Create a copy box from one of your trading accounts. Only that account's trades are copied to your followers."}
          </AppText>
        </View>
        <Button title="Create a copy box" size="sm" onPress={onCreate} />
      </View>
    );
  }
  return (
    <View>
      <View style={styles.sectionHead}>
        <AppText variant="title" weight="800">My copy boxes</AppText>
        <Pressable accessibilityRole="button" onPress={onCreate} hitSlop={6}>
          <AppText variant="small" weight="600" color={t.colors.primaryText}>+ New box</AppText>
        </Pressable>
      </View>
      <View style={styles.stack}>
        {boxes.map((b) => {
          const pnl = Number(b.cumulativePnl || 0);
          return (
            <View key={b.id} style={[styles.card, { borderWidth: 2, borderColor: b.isPublic ? '#6EE7B7' : t.colors.borderDark, backgroundColor: t.colors.surface }]}>
              <View style={styles.row}>
                <View style={styles.flex}>
                  <AppText variant="bodyStrong" weight="800" numberOfLines={1}>{b.displayName || b.accountNumber}</AppText>
                  <AppText variant="caption" tone="secondary">
                    <AppText variant="caption" weight="600">{b.accountType}</AppText>
                    {` · ${b.accountNumber}`}
                  </AppText>
                </View>
                <View style={[styles.pill, { backgroundColor: b.isPublic ? 'rgba(16,185,129,0.15)' : t.alpha(t.colors.textMuted, 0.15) }]}>
                  <AppText variant="micro" weight="700" color={b.isPublic ? '#047857' : t.colors.textMuted}>{b.isPublic ? 'LIVE' : 'PRIVATE'}</AppText>
                </View>
              </View>
              <View style={[styles.row, styles.mt12]}>
                <Stat label="ROI" value={roiText(b.roiPct)} tone={b.roiPct >= 0 ? 'bull' : 'bear'} />
                <Stat label="Win" value={`${b.winRate.toFixed(0)}%`} />
                <Stat label="Followers" value={String(b.followers)} />
              </View>
              <View style={[styles.totalPnl, { backgroundColor: t.alpha(t.colors.bgHover, 0.5) }]}>
                <AppText variant="caption" tone="muted">Total P&amp;L</AppText>
                <AppText variant="bodyStrong" weight="700" mono color={pnl >= 0 ? t.colors.bull : t.colors.bear}>
                  {`${pnl >= 0 ? '+' : ''}${fmtMoney(pnl)}`}
                </AppText>
              </View>
              <AppText variant="caption" tone="muted" style={styles.mt8}>
                {'Performance fee: '}
                <AppText variant="caption" weight="700" tone="secondary">{`${b.effectiveFee ?? 0}%`}</AppText>
                {b.feeOverride === null ? ' (default)' : ''}
              </AppText>
              {/* Fees charged on this box wait in escrow until they are transferred to the Bonus Wallet. */}
              {b.accruedFee > 0 ? (
                <>
                  <View style={[styles.totalPnl, { backgroundColor: 'rgba(245,158,11,0.10)' }]}>
                    <View style={styles.pendingLabel}>
                      <View style={styles.pendingDot} />
                      <AppText variant="caption" weight="600" color="#B45309">Pending fee</AppText>
                    </View>
                    <AppText variant="bodyStrong" weight="700" mono color="#B45309">{fmtMoney(b.accruedFee)}</AppText>
                  </View>
                  <AppText variant="micro" tone="muted" style={styles.mt4}>
                    Releases to your Main Wallet at month-end if the account is net-profitable — else it carries forward.
                  </AppText>
                </>
              ) : null}
              {b.lifetimeFeeReleased > 0 ? (
                <AppText variant="caption" tone="muted" style={styles.mt4}>
                  {'Released to date: '}
                  <AppText variant="caption" weight="700" color="#047857">{fmtMoney(b.lifetimeFeeReleased)}</AppText>
                </AppText>
              ) : null}
              {b.acceptsFollowers === false ? (
                <View style={[styles.warn, { backgroundColor: t.alpha(t.colors.bear, 0.1) }]}>
                  <AppText variant="caption" color={t.colors.bear}>Source account disabled — not accepting new followers.</AppText>
                </View>
              ) : null}
              <View style={[styles.actions, styles.mt12]}>
                {b.isPublic ? <Button title="View profile" variant="ghost" size="sm" onPress={() => onView(b)} /> : null}
                <View style={styles.flex} />
                <Button title="Edit" variant="ghost" size="sm" onPress={() => onEdit(b)} />
                <Button title={b.isPublic ? 'Make private' : 'Go public'} variant="ghost" size="sm" onPress={() => onToggle(b)} />
                <Pressable accessibilityRole="button" onPress={() => onDelete(b)} hitSlop={6} style={styles.deleteBtn}>
                  <AppText variant="small" weight="600" color={t.colors.bear}>Delete</AppText>
                </Pressable>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function ArchivedBoxes({ boxes, onRestore }: { boxes: readonly CopyBox[]; onRestore: (b: CopyBox) => void }): React.JSX.Element | null {
  const t = useTheme();
  const [show, setShow] = useState(false);
  if (!boxes.length) return null;
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: show }} onPress={() => setShow((s) => !s)} style={styles.sectionHeadLeft}>
        <AppText variant="title" weight="800">{`${show ? '▾' : '▸'} Archived boxes`}</AppText>
        <AppText variant="small" weight="600" tone="muted">{`(${boxes.length}) · ${show ? 'Hide' : 'Show'}`}</AppText>
      </Pressable>
      {show ? (
        <View style={styles.stack}>
          {boxes.map((b) => (
            <View key={b.id} style={[styles.card, { borderWidth: 2, borderStyle: 'dashed', borderColor: t.colors.borderDark, backgroundColor: t.colors.surface }]}>
              <View style={styles.row}>
                <View style={styles.flex}>
                  <AppText variant="bodyStrong" weight="800" numberOfLines={1}>{b.displayName || b.accountNumber}</AppText>
                  <AppText variant="caption" tone="secondary">{`${b.accountType} · ${b.accountNumber}`}</AppText>
                </View>
                <View style={[styles.pill, { backgroundColor: t.alpha(t.colors.textMuted, 0.15) }]}>
                  <AppText variant="micro" weight="700" tone="muted">ARCHIVED</AppText>
                </View>
              </View>
              <View style={[styles.row, styles.mt12]}>
                <Stat label="ROI" value={roiText(b.roiPct)} tone={b.roiPct >= 0 ? 'bull' : 'bear'} />
                <Stat label="Win" value={`${b.winRate.toFixed(0)}%`} />
                <Stat label="Trades" value={String(b.totalTrades)} />
              </View>
              <View style={[styles.actions, styles.mt12]}>
                <View style={styles.flex} />
                <Button title="Restore" variant="ghost" size="sm" onPress={() => onRestore(b)} />
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function TraderCard({ trader, badge, onView, onCopy }: { trader: CopyBox; badge?: LeaderBadge; onView: () => void; onCopy: () => void }): React.JSX.Element {
  const t = useTheme();
  const risk = trader.riskBadge ? RISK_TONE[trader.riskBadge] : null;
  return (
    <View style={[styles.card, { borderColor: t.colors.borderDark, backgroundColor: t.colors.surface, gap: 12 }]}>
      <View style={styles.rowTop}>
        <Pressable accessibilityRole="button" accessibilityLabel={`View ${trader.displayName || 'trader'}`} onPress={onView} style={[styles.avatar, { backgroundColor: t.alpha(t.colors.primary, 0.15) }]}>
          <AppText variant="small" weight="800" color={t.colors.primaryText}>{(trader.displayName || 'T').slice(0, 2).toUpperCase()}</AppText>
        </Pressable>
        <View style={styles.flex}>
          <View style={[styles.row, styles.wrap]}>
            <Pressable accessibilityRole="link" onPress={onView} style={styles.shrink}>
              <AppText variant="bodyStrong" weight="800" numberOfLines={1}>{trader.displayName || 'Trader'}</AppText>
            </Pressable>
            {badge ? (
              <View style={[styles.pill, { backgroundColor: t.alpha(t.colors.primary, 0.1) }]}>
                <AppText variant="micro" weight="700" color={t.colors.primaryText}>{`${badge.icon} ${badge.label.toUpperCase()}`}</AppText>
              </View>
            ) : null}
            <View style={[styles.pill, { backgroundColor: risk ? risk.bg : t.alpha(t.colors.textMuted, 0.1) }]}>
              <AppText variant="micro" weight="700" color={risk ? risk.fg : t.colors.textMuted}>{trader.riskBadge ?? 'MED'}</AppText>
            </View>
          </View>
          {trader.accountType || trader.ownerName ? (
            <AppText variant="micro" tone="secondary" numberOfLines={1}>
              {[trader.accountType, trader.ownerName].filter(Boolean).join(' · ')}
            </AppText>
          ) : null}
          <AppText variant="caption" tone="muted" numberOfLines={2} style={styles.mt2}>{trader.bio || 'Active trader on the platform.'}</AppText>
        </View>
      </View>
      <View style={styles.row}>
        <Stat label="ROI" value={roiText(trader.roiPct)} tone={trader.roiPct >= 0 ? 'bull' : 'bear'} />
        <Stat label="Win" value={`${trader.winRate.toFixed(0)}%`} />
        <Stat label="Followers" value={trader.followers.toLocaleString()} />
      </View>
      <View style={styles.row}>
        <Button title="View profile" variant="ghost" size="sm" onPress={onView} style={styles.flex} />
        <Button title="Copy" size="sm" onPress={onCopy} style={styles.flex} />
      </View>
    </View>
  );
}

const FEED_DOT: Record<string, string> = { OPEN: '#3B82F6', CLOSE: '#10B981', TP_HIT: '#10B981', SL_HIT: '#F43F5E', FOLLOWED: '#8B5CF6' };

function FeedRow({ event, first }: { event: FeedEvent; first: boolean }): React.JSX.Element {
  const t = useTheme();
  const at = event.createdAt ? new Date(event.createdAt).getTime() : Date.now();
  const pnl = Number(event.pnl);
  return (
    <View style={[styles.feedRow, first ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.borderSubtle }]}>
      <View style={[styles.dot, { backgroundColor: FEED_DOT[event.type] ?? t.colors.textMuted }]} />
      <View style={styles.flex}>
        <AppText variant="body" weight="500">{feedEventText(event)}</AppText>
        <AppText variant="micro" tone="muted">
          {formatElapsed(Date.now() - at)}
          {event.symbol ? ` · ${event.symbol}` : ''}
          {feedShowsPnl(event) ? (
            <AppText variant="micro" weight="600" color={pnl >= 0 ? t.colors.bull : t.colors.bear}>{` · ${pnl >= 0 ? '+' : ''}${fmtMoney(pnl)}`}</AppText>
          ) : null}
        </AppText>
      </View>
    </View>
  );
}

function MyCopyRow({
  rel,
  onAction,
  onEdit,
  onStop,
  onAnalytics,
}: {
  rel: CopyRelation;
  onAction: (route: 'pause' | 'resume') => void;
  onEdit: () => void;
  onStop: () => void;
  onAnalytics: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const m = rel.master;
  const running = Number(rel.runningPnl || 0);
  const tone = rel.status === 'ACTIVE' ? t.colors.bull : rel.status === 'PAUSED' ? t.colors.warn : t.colors.textMuted;
  const lot = rel.lotMode === 'CUSTOM' ? `${rel.customLot ?? ''} lots` : `${rel.lotMode.toLowerCase()} lot`;
  return (
    <View style={[styles.card, { borderColor: t.colors.borderDark, backgroundColor: t.colors.surface }]}>
      <View style={styles.rowTop}>
        <View style={[styles.avatarSm, { backgroundColor: t.alpha(t.colors.primary, 0.15) }]}>
          <AppText variant="caption" weight="800" color={t.colors.primaryText}>{(m?.displayName || 'T').slice(0, 2).toUpperCase()}</AppText>
        </View>
        <View style={styles.flex}>
          <View style={[styles.row, styles.wrap]}>
            <AppText variant="bodyStrong" weight="800" numberOfLines={1} style={styles.shrink}>{m?.displayName || 'Trader'}</AppText>
            <View style={[styles.tag, { backgroundColor: t.alpha(tone, 0.15) }]}>
              <AppText variant="micro" weight="700" color={tone}>{rel.status}</AppText>
            </View>
          </View>
          <AppText variant="caption" tone="muted" style={styles.mt2}>
            <AppText variant="caption" weight="600" tone="secondary">{lot}</AppText>
            {` · ${rel.tradesCopied} copies · ${rel.openMirrors.length} open`}
            {rel.followerAccountNumber ? ` · → ${rel.followerAccountNumber}` : ''}
          </AppText>
        </View>
        <View style={styles.alignEnd}>
          <AppText variant="bodyStrong" weight="800" mono color={running >= 0 ? t.colors.bull : t.colors.bear}>
            {`${running >= 0 ? '+' : ''}${fmtMoney(running)}`}
          </AppText>
          <AppText variant="micro" tone="muted">Running PnL</AppText>
        </View>
      </View>
      <View style={[styles.actions, styles.mt12]}>
        <Button title="Analytics" variant="ghost" size="sm" onPress={onAnalytics} />
        {rel.status === 'ACTIVE' ? <Button title="Pause" variant="ghost" size="sm" onPress={() => onAction('pause')} /> : null}
        {rel.status !== 'ACTIVE' ? <Button title="Resume" variant="ghost" size="sm" onPress={() => onAction('resume')} /> : null}
        {rel.status !== 'STOPPED' ? <Button title="Edit" variant="ghost" size="sm" onPress={onEdit} /> : null}
        {rel.status !== 'STOPPED' ? (
          <Pressable accessibilityRole="button" onPress={onStop} hitSlop={6} style={styles.deleteBtn}>
            <AppText variant="small" weight="700" color={t.colors.bear}>Stop</AppText>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { gap: 20 },
  stack: { gap: 12 },
  flex: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  wrap: { flexWrap: 'wrap' },
  alignEnd: { alignItems: 'flex-end' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  mt2: { marginTop: 2 },
  mt8: { marginTop: 8 },
  mt12: { marginTop: 12 },
  loading: { paddingVertical: 32, paddingHorizontal: 8 },
  sectionHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10, paddingHorizontal: 2 },
  sectionHeadLeft: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 10 },
  card: { borderWidth: 1, borderRadius: 14, padding: 14 },
  noPad: { padding: 0, overflow: 'hidden' },
  pad: { padding: 24 },
  invite: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderWidth: 2, borderStyle: 'dashed' },
  inviteIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  inviteGlyph: { fontSize: 22, lineHeight: 28 },
  pill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999 },
  tag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  stat: { flex: 1, alignItems: 'center', borderRadius: 8, paddingVertical: 6 },
  pendingLabel: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pendingDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#F59E0B' },
  mt4: { marginTop: 4 },
  totalPnl: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, marginTop: 8 },
  warn: { marginTop: 8, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 },
  deleteBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  filters: { gap: 8, marginBottom: 12 },
  avatar: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  avatarSm: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  feedRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
});
