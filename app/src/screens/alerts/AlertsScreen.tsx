import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { deletePriceAlert, togglePriceAlert, usePriceAlerts } from '@/api/alerts.api';
import { errorMessage } from '@/api/client';
import { useInstruments } from '@/api/instruments.api';
import { CreateAlertModal } from '@/components/alerts/CreateAlertModal';
import {
  AppText,
  AssetIcon,
  Badge,
  Button,
  ErrorView,
  LoadingView,
  PageHero,
  Screen,
  toast,
  useConfirm,
  useScreenChrome,
} from '@/components/ui';
import type { AppScreenProps } from '@/navigation/types';
import { useTheme } from '@/theme';
import { priceAlertStatus, type PriceAlert } from '@/types/market';
import type { Instrument } from '@/types/trading';

import { alertDirectionLabel, alertStatusLabel, toggleLabel } from './alertsLogic';

/**
 * Price Alerts — client/src/pages/PriceAlerts.jsx (`/alerts`).
 *
 * The trader's own "tell me when RELIANCE goes above 3,000" list: symbol,
 * direction, target, note, status (Triggered @ price / Active / Paused),
 * Pause ↔ Resume and Delete (confirmed), and "+ New Alert", which opens the
 * shared CreateAlertModal. The server's price monitor fires them and the
 * trader hears through notifications (in-app, email and push).
 *
 * Differences from the web, each deliberate:
 *   • `/alerts?symbol=X` — the StockDetail "Set a price alert" link — opens
 *     the New Price Alert form on that symbol. The web ignores the param
 *     (PORT-RULINGS: emitted but never read), which left the trader on a
 *     list with no alert for the symbol they came from.
 *   • The first load shows a spinner, and a failed one an error with a
 *     retry (the web showed "No alerts yet" either way, plus a toast).
 *   • It re-reads on coming back to the screen and on pull-to-refresh.
 */
export function AlertsScreen({ navigation, route }: AppScreenProps<'Alerts'>): React.JSX.Element {
  const t = useTheme();
  const confirm = useConfirm();
  const { Footer } = useScreenChrome();
  const { alerts, loading, error, refresh } = usePriceAlerts();
  const { rows: instruments } = useInstruments();

  const [showCreate, setShowCreate] = useState(false);
  const [createSymbol, setCreateSymbol] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  /** PriceAlerts.jsx `refresh`: a failure is toasted, the rows on screen stay. */
  const reload = useCallback(async (): Promise<void> => {
    const problem = await refresh();
    if (problem && alive.current) toast.error(problem);
  }, [refresh]);

  // The first load's failure is toasted as the web does; ErrorView shows it too.
  const toastedFirst = useRef(false);
  useEffect(() => {
    if (!toastedFirst.current && !loading && error) {
      toastedFirst.current = true;
      toast.error(error);
    }
    if (!loading) toastedFirst.current = true;
  }, [loading, error]);

  // `/alerts?symbol=` opens the form on that symbol, once.
  const symbolParam = route.params?.symbol;
  useEffect(() => {
    if (!symbolParam) return;
    setCreateSymbol(symbolParam);
    setShowCreate(true);
    navigation.setParams({ symbol: undefined });
  }, [symbolParam, navigation]);

  // Coming back from another screen: the web remounts on every visit.
  useEffect(() => {
    let away = false;
    const offBlur = navigation.addListener('blur', () => { away = true; });
    const offFocus = navigation.addListener('focus', () => {
      if (!away) return;
      away = false;
      void reload();
    });
    return () => { offBlur(); offFocus(); };
  }, [navigation, reload]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await reload(); } finally { if (alive.current) setRefreshing(false); }
  }, [reload]);

  const instrumentBySymbol = useMemo(() => {
    const m = new Map<string, Instrument>();
    for (const i of instruments) m.set(i.symbol, i);
    return m;
  }, [instruments]);

  const setRowBusy = (id: string, on: boolean): void =>
    setBusy((b) => {
      const next = { ...b };
      if (on) next[id] = true; else delete next[id];
      return next;
    });

  const remove = useCallback(async (id: string): Promise<void> => {
    if (!(await confirm('Delete this alert?'))) return;
    setRowBusy(id, true);
    try {
      await deletePriceAlert(id);
      toast.success('Alert deleted');
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      if (alive.current) setRowBusy(id, false);
    }
  }, [confirm, reload]);

  const toggle = useCallback(async (id: string): Promise<void> => {
    setRowBusy(id, true);
    try {
      await togglePriceAlert(id);
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      if (alive.current) setRowBusy(id, false);
    }
  }, [reload]);

  const openCreate = (): void => { setCreateSymbol(undefined); setShowCreate(true); };

  const renderItem = useCallback(({ item }: { item: PriceAlert }) => {
    const inst = instrumentBySymbol.get(item.symbol);
    const status = priceAlertStatus(item);
    const above = item.direction === 'ABOVE';
    const rowBusy = !!busy[item.id];
    return (
      <View
        testID={`alert-row-${item.id}`}
        style={[styles.row, { backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark, borderRadius: t.radius.xl }]}
      >
        <View style={styles.top}>
          <AssetIcon row={inst ?? { symbol: item.symbol }} size={20} round />
          <AppText variant="bodyStrong" numberOfLines={1} style={styles.flex}>{item.symbol}</AppText>
          <Badge
            label={alertStatusLabel(item)}
            tone={status === 'TRIGGERED' ? 'bull' : status === 'ACTIVE' ? 'warn' : 'neutral'}
          />
        </View>
        <View style={styles.mid}>
          <AppText variant="body" weight="600" color={above ? t.colors.bull : t.colors.bear}>{alertDirectionLabel(item.direction)}</AppText>
          <AppText variant="micro" tone="muted" style={styles.targetLabel}>TARGET</AppText>
          <AppText variant="bodyStrong" mono>{item.targetPrice}</AppText>
        </View>
        <AppText variant="small" tone="secondary" numberOfLines={2}>{item.note || '—'}</AppText>
        <View style={styles.actions}>
          <GhostAction label={toggleLabel(item)} disabled={rowBusy} onPress={() => { void toggle(item.id); }} />
          <GhostAction label="Delete" danger disabled={rowBusy} onPress={() => { void remove(item.id); }} />
        </View>
      </View>
    );
  }, [instrumentBySymbol, busy, t, toggle, remove]);

  const header = (
    <View style={styles.side}>
      <PageHero
        eyebrow="Notifications"
        title="Price Alerts"
        subtitle="Get notified the moment an instrument crosses your target price — via in-app, email, and push."
        actions={<Button title="+ New Alert" size="sm" onPress={openCreate} />}
      />
    </View>
  );

  const empty = loading ? (
    <LoadingView />
  ) : error ? (
    <ErrorView error={error} onRetry={() => { void reload(); }} compact />
  ) : (
    <View style={[styles.emptyBox, { backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark, borderRadius: t.radius.xl }]}>
      <AppText variant="body" tone="muted" align="center">No alerts yet</AppText>
    </View>
  );

  return (
    <Screen scroll={false} padded={false}>
      <FlatList
        data={loading || (error && !alerts.length) ? [] : alerts}
        keyExtractor={(a) => a.id}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListEmptyComponent={<View style={styles.side}>{empty}</View>}
        ListFooterComponent={(
          <View>
            <View style={styles.pad} />
            {Footer ? <Footer /> : null}
          </View>
        )}
        contentContainerStyle={{ paddingTop: t.space.page }}
        initialNumToRender={10}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { void onRefresh(); }}
            tintColor={t.colors.primary}
            colors={[t.colors.primary]}
            progressBackgroundColor={t.colors.surface}
          />
        )}
      />

      <CreateAlertModal
        visible={showCreate}
        instruments={instruments}
        initialSymbol={createSymbol}
        onClose={() => setShowCreate(false)}
        onCreated={() => { setShowCreate(false); void reload(); }}
      />
    </Screen>
  );
}

/** The web's `btn-ghost text-xs` row actions; Delete is `text-bear`. */
function GhostAction({ label, onPress, disabled, danger }: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.ghost,
        { borderRadius: t.radius.lg, backgroundColor: pressed ? t.colors.bgHover : 'transparent', opacity: disabled ? 0.5 : 1 },
      ]}
    >
      <AppText variant="small" weight="600" color={danger ? t.colors.bear : t.colors.textSecondary}>{label}</AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  ghost: { paddingHorizontal: 10, paddingVertical: 6, minHeight: 32, justifyContent: 'center' },
  flex: { flex: 1, minWidth: 0 },
  side: { paddingHorizontal: 16 },
  row: { marginHorizontal: 16, marginBottom: 10, borderWidth: 1, padding: 12, gap: 6 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mid: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  targetLabel: { marginLeft: 'auto', letterSpacing: 0.6 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 4 },
  emptyBox: { borderWidth: 1, paddingVertical: 24 },
  pad: { height: 24 },
});
