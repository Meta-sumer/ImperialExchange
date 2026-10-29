import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { AppText, toast } from '@/components/ui';
import { useAppNavigation } from '@/navigation/types';
import { useTheme } from '@/theme';
import type { UserAccount } from '@/types/user';
import { fmtMoney, fmtNum } from '@/utils/money';
import {
  ALLOC_COLORS,
  CAT_NAME,
  DONUT,
  DONUT_C,
  accountScopeOptions,
  allocationOf,
  donutSegments,
  inScope,
  type AccountScope,
  type AllocKey,
  type LivePosition,
} from '@/utils/dashboard';

import { Glyph } from './Glyph';
import { ScopePicker, Section } from './shared';

const INFO = 'Live exposure across your open positions';

const colorOf = (key: string): string => ALLOC_COLORS[key as AllocKey] ?? '#9CA3AF';
const nameOf = (key: string): string => CAT_NAME[key as AllocKey] ?? key;

/**
 * "Asset Allocation" — Dashboard.jsx AssetAllocationCard (:1384-1513): the
 * donut of open exposure by Indian market segment — Stocks, Indices,
 * Futures, Options, Commodities, Other (utils/dashboard allocKeyOf) — the
 * account filter (All / All Real / All Demo / one account), the legend with
 * each bucket's amount and share, and "View Detailed Allocation →" (Reports).
 *
 * Exposure is |qty × mark| per position in rupees, live with the ticks; no
 * conversion. The web's hover tooltip on the ⓘ is a tap here.
 */
export function AssetAllocationCard({
  positions,
  accounts,
}: {
  positions: readonly LivePosition[];
  accounts: readonly UserAccount[];
}): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  const [scope, setScope] = useState<AccountScope>('all');

  const typeById = useMemo(() => new Map(accounts.map((a) => [a.id, a.accountType as string])), [accounts]);
  const options = useMemo(() => accountScopeOptions(accounts), [accounts]);
  const { entries, total } = useMemo(
    () => allocationOf(positions.filter((lp) => inScope(lp.position.accountId, scope, typeById))),
    [positions, scope, typeById],
  );
  const segs = donutSegments(entries, total);

  return (
    <Section testID="dashboard-allocation" padded={false} style={styles.gapBelow}>
      <View style={styles.head}>
        <View style={styles.titleRow}>
          <AppText variant="title">Asset Allocation</AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={INFO}
            hitSlop={8}
            onPress={() => toast(INFO)}
          >
            <Glyph name="info" size={15} color={t.colors.textMuted} strokeWidth={1.8} />
          </Pressable>
        </View>
        <ScopePicker options={options} value={scope} onChange={setScope} />
      </View>

      <View style={styles.body}>
        {total === 0 ? (
          <AppText variant="small" tone="muted" align="center" style={styles.empty}>
            No exposure yet — open a position to see allocation.
          </AppText>
        ) : (
          <>
            <View style={styles.donutWrap}>
              <Svg width={190} height={190} viewBox="0 0 160 160">
                <Circle cx={DONUT.cx} cy={DONUT.cy} r={DONUT.R} fill="none" stroke={t.isDark ? t.colors.bgHover : '#EEF2F6'} strokeWidth={DONUT.SW} />
                {segs.map((s) => (
                  <Circle
                    key={s.cat}
                    cx={DONUT.cx}
                    cy={DONUT.cy}
                    r={DONUT.R}
                    fill="none"
                    stroke={colorOf(s.cat)}
                    strokeWidth={DONUT.SW}
                    strokeDasharray={`${s.len} ${DONUT_C - s.len}`}
                    strokeDashoffset={-s.off}
                    transform={`rotate(-90 ${DONUT.cx} ${DONUT.cy})`}
                  />
                ))}
              </Svg>
              <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
                <AppText variant="caption" tone="muted">Total</AppText>
                <AppText variant="h2" weight="800" mono testID="dashboard-allocation-total">{fmtMoney(total, undefined, 0)}</AppText>
              </View>
            </View>
            <View style={styles.legend}>
              {entries.map(([cat, val]) => (
                <View key={cat} style={styles.legendRow} accessible accessibilityLabel={`${nameOf(cat)}: ${fmtMoney(val)}`}>
                  <View style={[styles.dot, { backgroundColor: colorOf(cat) }]} />
                  <AppText variant="body" weight="600" numberOfLines={1} style={styles.flex}>{nameOf(cat)}</AppText>
                  <AppText variant="body" mono weight="700" style={styles.amount}>{fmtMoney(val)}</AppText>
                  <AppText variant="body" mono tone="muted" style={styles.pct}>{`${fmtNum((val / total) * 100, 2)}%`}</AppText>
                </View>
              ))}
            </View>
          </>
        )}
      </View>

      <View style={styles.foot}>
        <Pressable
          accessibilityRole="link"
          onPress={() => nav.navigate('Reports')}
          style={({ pressed }) => [styles.footLink, { backgroundColor: pressed ? t.colors.primarySoft : t.alpha(t.colors.bgHover, 0.6) }]}
        >
          <AppText variant="small" weight="600" color={t.colors.primaryText}>View Detailed Allocation →</AppText>
        </Pressable>
      </View>
    </Section>
  );
}

const styles = StyleSheet.create({
  gapBelow: { marginBottom: 24 },
  head: { paddingHorizontal: 20, paddingTop: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  body: { padding: 20 },
  empty: { paddingVertical: 32 },
  donutWrap: { alignSelf: 'center', width: 190, height: 190 },
  center: { alignItems: 'center', justifyContent: 'center' },
  legend: { marginTop: 20, gap: 12 },
  legendRow: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 10 },
  flex: { flex: 1, minWidth: 0 },
  amount: { minWidth: 96, textAlign: 'right' },
  pct: { minWidth: 64, textAlign: 'right' },
  foot: { paddingHorizontal: 20, paddingBottom: 16 },
  footLink: { borderRadius: 12, paddingVertical: 10, alignItems: 'center' },
});
