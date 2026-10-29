import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { DateField } from '@/components/common/DateField';
import { AppText, Badge, Button, Card, Checkbox, Icon, Select } from '@/components/ui';
import { useTheme } from '@/theme';
import type { Plan, Subscription } from '@/types/subscription';
import { fmtMoney } from '@/utils/money';
import {
  BLANK_HISTORY_FILTERS,
  HISTORY_BILLING_OPTIONS,
  HISTORY_PAGE_SIZES,
  HISTORY_STATUS_OPTIONS,
  HISTORY_TYPE_OPTIONS,
  buildPeriods,
  clampPage,
  emptyHistoryLabel,
  filterPeriods,
  fmtPlanDate,
  hasHistoryFilters,
  pageNumbers,
  paginate,
  periodAmountLabel,
  periodDaysLabel,
  periodRangeLabel,
  periodStatusLabel,
  periodStatusTone,
  postpaidDetail,
  showingLabel,
  totalBilling,
  totalBillingLabel,
  type BillingCharge,
  type BillingPeriod,
  type HistoryFilters,
} from '@/utils/plans';

/**
 * client/src/components/BillingHistory.jsx — the "Billing & Subscription
 * History" card under Plans & Pricing.
 *
 * The backend keeps one subscription document per user, so the timeline is
 * RECONSTRUCTED from real data: the plan charges (Bonus Wallet, and the
 * retired Main Wallet's old ones) become plan
 * periods, joined with the plan catalogue and the current subscription
 * (utils/plans `buildPeriods`). Each period shows its start / end, plan
 * type, description, billing period with its length, amount and status;
 * View expands a summary (postpaid: the itemized usage and the deposit
 * figures). Filters are staged — picked, then applied — with pagination.
 *
 * Phone layout: the web's 900px-wide table becomes one card row per period
 * carrying the same columns as labelled fields; everything else is the
 * web's, in its order and words.
 */
export function BillingHistory({
  txns,
  currentSub,
  plans,
  currentPlanCode,
}: {
  txns: ReadonlyArray<BillingCharge>;
  currentSub: Subscription | null;
  plans: ReadonlyArray<Plan>;
  currentPlanCode: string | null;
}): React.JSX.Element {
  const t = useTheme();
  const [draft, setDraft] = useState<HistoryFilters>(BLANK_HISTORY_FILTERS);
  const [applied, setApplied] = useState<HistoryFilters>(BLANK_HISTORY_FILTERS);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState(10);
  const [openId, setOpenId] = useState<string | null>(null);

  const setD = <K extends keyof HistoryFilters>(k: K, v: HistoryFilters[K]): void =>
    setDraft((d) => ({ ...d, [k]: v }));
  // The web also resets the page in an effect on [applied, rows]; every
  // change to either goes through these three, so they do it themselves.
  const apply = (): void => { setApplied(draft); setPage(1); };
  const reset = (): void => { setDraft(BLANK_HISTORY_FILTERS); setApplied(BLANK_HISTORY_FILTERS); setPage(1); };
  const changeRows = (n: number): void => { setRows(n); setPage(1); };

  const periods = useMemo(() => buildPeriods(txns, currentSub, plans), [txns, currentSub, plans]);
  const filtered = useMemo(() => filterPeriods(periods, applied, currentPlanCode), [periods, applied, currentPlanCode]);
  const total = useMemo(() => totalBilling(filtered), [filtered]);
  const pg = paginate(filtered, page, rows);

  return (
    <Card padded={false} style={styles.card}>
      {/* Header + total billing */}
      <View style={[styles.head, { borderBottomColor: t.colors.borderSubtle }]}>
        <View style={styles.flex}>
          <AppText variant="h3" weight="700">{'Billing & Subscription History'}</AppText>
          <AppText variant="small" tone="muted" style={styles.mt2}>View your subscription timeline, charges, usage and invoices.</AppText>
        </View>
        <View style={styles.total}>
          <AppText variant="caption" tone="muted" weight="700" style={styles.upper}>Total Billing</AppText>
          <AppText variant="h1" tone="bear" mono>{totalBillingLabel(total)}</AppText>
        </View>
      </View>

      {/* Filters — staged, applied on "Apply Filters" */}
      <View style={[styles.filters, { borderBottomColor: t.colors.borderSubtle }]}>
        <View style={styles.filterRow}>
          <FilterField label="From Date">
            <DateField label="From" value={draft.from} max={draft.to || undefined} onChange={(v) => setD('from', v)} />
          </FilterField>
          <FilterField label="To Date">
            <DateField label="To" value={draft.to} min={draft.from || undefined} onChange={(v) => setD('to', v)} />
          </FilterField>
        </View>
        <View style={styles.filterRow}>
          <FilterField label="Type">
            <Select
              value={draft.type}
              options={HISTORY_TYPE_OPTIONS.map((o) => ({ ...o }))}
              onChange={(v) => setD('type', v)}
              title="Type"
              accessibilityLabel="Type"
            />
          </FilterField>
          <FilterField label="Status">
            <Select
              value={draft.status}
              options={HISTORY_STATUS_OPTIONS.map((o) => ({ ...o }))}
              onChange={(v) => setD('status', v)}
              title="Status"
              accessibilityLabel="Status"
            />
          </FilterField>
        </View>
        <View style={styles.filterRow}>
          <FilterField label="Billing Type">
            <Select
              value={draft.billingType}
              options={HISTORY_BILLING_OPTIONS.map((o) => ({ ...o }))}
              onChange={(v) => setD('billingType', v)}
              title="Billing Type"
              accessibilityLabel="Billing Type"
            />
          </FilterField>
          <View style={[styles.flex, styles.checkCell]}>
            <Checkbox label="Show only current plan" value={draft.onlyCurrent} onValueChange={(v) => setD('onlyCurrent', v)} />
          </View>
        </View>
        <View style={styles.filterActions}>
          <Button title="Reset" variant="secondary" size="sm" onPress={reset} />
          <Button title="Apply Filters" size="sm" onPress={apply} />
        </View>
      </View>

      {/* The timeline */}
      {pg.rows.length === 0 ? (
        <AppText variant="body" tone="muted" align="center" style={styles.empty}>
          {emptyHistoryLabel(hasHistoryFilters(applied))}
        </AppText>
      ) : (
        // Bounded: one page of at most 100 periods, from at most 100 charges.
        pg.rows.map((p, i) => (
          <PeriodRow
            key={p.id}
            p={p}
            divider={i > 0}
            open={openId === p.id}
            onToggle={() => setOpenId(openId === p.id ? null : p.id)}
          />
        ))
      )}

      {/* Pagination */}
      <View style={[styles.pager, { borderTopColor: t.colors.borderSubtle }]}>
        <AppText variant="small" tone="muted">{showingLabel(pg)}</AppText>
        <View style={styles.pages}>
          <PageButton label="Prev" disabled={pg.page <= 1} onPress={() => setPage(clampPage(pg.page - 1, pg.totalPages))} />
          {pageNumbers(pg.page, pg.totalPages).map((n, i) => (n === '…'
            // eslint-disable-next-line react/no-array-index-key
            ? <AppText key={`e${i}`} variant="body" tone="muted" style={styles.ellipsis}>…</AppText>
            : (
              <PageButton
                key={n}
                label={String(n)}
                active={n === pg.page}
                onPress={() => setPage(clampPage(n, pg.totalPages))}
              />
            )))}
          <PageButton label="Next" disabled={pg.page >= pg.totalPages} onPress={() => setPage(clampPage(pg.page + 1, pg.totalPages))} />
        </View>
        <View style={styles.rowsPer}>
          <AppText variant="small" tone="muted">Rows per page</AppText>
          <Select
            variant="compact"
            value={rows}
            options={HISTORY_PAGE_SIZES.map((n) => ({ value: n, label: String(n) }))}
            onChange={changeRows}
            title="Rows per page"
            accessibilityLabel="Rows per page"
          />
        </View>
      </View>
    </Card>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={styles.field}>
      <AppText variant="caption" tone="muted" weight="600" style={styles.fieldLabel}>{label}</AppText>
      {children}
    </View>
  );
}

function PageButton({
  label,
  active,
  disabled,
  onPress,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={/^\d+$/.test(label) ? `Page ${label}` : label}
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pageBtn,
        { borderRadius: t.radius.lg },
        active
          ? { backgroundColor: t.colors.primary }
          : { borderWidth: 1, borderColor: t.colors.borderDark, backgroundColor: pressed ? t.colors.bgHover : 'transparent' },
        disabled ? styles.faded : null,
      ]}
    >
      <AppText variant="body" weight="600" color={active ? t.colors.onPrimary : t.colors.textSecondary}>{label}</AppText>
    </Pressable>
  );
}

/* ── One period + its expandable detail ───────────────────────────── */

function PeriodRow({
  p,
  divider,
  open,
  onToggle,
}: {
  p: BillingPeriod;
  divider: boolean;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const zero = Number(p.amount) === 0;
  return (
    <View style={[styles.period, divider ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.borderSubtle } : null]}>
      <View style={styles.spread}>
        <View style={styles.badges}>
          {p.badges.map((b, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <Badge key={i} label={b} tone={p.isPostpaid ? 'primary' : 'neutral'} size="xs" rounded />
          ))}
        </View>
        <Badge label={periodStatusLabel(p.status)} tone={periodStatusTone(p.status)} size="xs" rounded />
      </View>

      <View style={[styles.spread, styles.top, styles.mt8]}>
        <View style={styles.flex}>
          <AppText variant="bodyStrong">{p.description}</AppText>
          <AppText variant="caption" tone="muted" style={styles.mt2}>{p.subtitle}</AppText>
        </View>
        <View style={styles.amount}>
          <AppText variant="bodyStrong" weight="700" mono tone={zero ? 'primary' : 'bear'}>{periodAmountLabel(p.amount)}</AppText>
          {p.isPostpaid ? <AppText variant="micro" tone="muted">(Minimum Deposit)</AppText> : null}
        </View>
      </View>

      <View style={[styles.cells, styles.mt8]}>
        <Cell label="Start Date" value={fmtPlanDate(p.start)} />
        <Cell label="End Date" value={p.end ? fmtPlanDate(p.end) : '—'} />
      </View>
      <View style={styles.mt8}>
        <AppText variant="micro" tone="muted" weight="700" style={styles.upper}>Billing Period</AppText>
        <AppText variant="small" tone="secondary" style={styles.mt2}>
          {periodRangeLabel(p)}
          {p.days != null ? <AppText variant="caption" tone="muted">{`  ${periodDaysLabel(p.days)}`}</AppText> : null}
        </AppText>
      </View>

      <View style={[styles.actions, styles.mt8]}>
        <Button title="View" variant="secondary" size="sm" leftIcon="eye" onPress={onToggle} />
        {p.isPostpaid ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={open ? 'Hide details' : 'Show details'}
            hitSlop={6}
            onPress={onToggle}
            style={({ pressed }) => [styles.chevron, { borderRadius: t.radius.lg, backgroundColor: pressed ? t.colors.bgHover : 'transparent' }]}
          >
            <View style={open ? styles.flipped : null}>
              <Icon name="chevronDown" size={16} color={t.colors.textMuted} strokeWidth={2.4} />
            </View>
          </Pressable>
        ) : null}
      </View>

      {open ? (p.isPostpaid ? <PostpaidDetailView p={p} /> : <PlanDetailView p={p} />) : null}
    </View>
  );
}

function Cell({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.cell}>
      <AppText variant="micro" tone="muted" weight="700" style={styles.upper}>{label}</AppText>
      <AppText variant="small" tone="secondary" style={styles.mt2}>{value}</AppText>
    </View>
  );
}

/** A non-postpaid period's summary. */
function PlanDetailView({ p }: { p: BillingPeriod }): React.JSX.Element {
  const t = useTheme();
  const zero = Number(p.amount) === 0;
  return (
    <View style={[styles.detail, { borderColor: t.colors.borderSubtle, backgroundColor: t.alpha(t.colors.bgHover, 0.25), borderRadius: t.radius.xl }]}>
      <View style={styles.cells}>
        <DetailCell label="Plan" value={p.description} />
        <DetailCell label="Billing period" value={`${periodRangeLabel(p)}${p.days != null ? ` (${p.days} days)` : ''}`} />
      </View>
      <View style={[styles.cells, styles.mt12]}>
        <View style={styles.cell}>
          <AppText variant="small" tone="muted">Amount charged</AppText>
          <AppText variant="small" weight="600" mono tone={zero ? 'primary' : 'bear'} style={styles.mt2}>{periodAmountLabel(p.amount)}</AppText>
        </View>
        <View style={styles.cell}>
          <AppText variant="small" tone="muted">Status</AppText>
          <View style={[styles.mt2, styles.startRow]}>
            <Badge label={periodStatusLabel(p.status)} tone={periodStatusTone(p.status)} size="xs" rounded />
          </View>
        </View>
      </View>
    </View>
  );
}

function DetailCell({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.cell}>
      <AppText variant="small" tone="muted">{label}</AppText>
      <AppText variant="small" weight="600" style={styles.mt2}>{value}</AppText>
    </View>
  );
}

/** A postpaid period: itemized usage and the deposit summary. */
function PostpaidDetailView({ p }: { p: BillingPeriod }): React.JSX.Element {
  const t = useTheme();
  const d = postpaidDetail(p);
  const box = { borderColor: t.colors.borderSubtle, borderRadius: t.radius.xl };
  return (
    <View style={[styles.detail, { borderColor: t.colors.borderSubtle, backgroundColor: t.alpha(t.colors.bgHover, 0.25), borderRadius: t.radius.xl }]}>
      <AppText variant="small" weight="700">
        Postpaid Usage Details{' '}
        <AppText variant="small" tone="muted">{`(${fmtPlanDate(p.start)} – ${p.end ? fmtPlanDate(p.end) : 'now'})`}</AppText>
      </AppText>
      <View style={[styles.lines, box]}>
        {d.lines.map((l, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <View key={i} style={[styles.line, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.borderSubtle } : null]}>
            <View style={styles.spread}>
              <AppText variant="small" weight="500" style={styles.flex}>{l.desc}</AppText>
              <AppText variant="small" weight="600" mono>{fmtMoney(l.qty * l.unit + l.tax)}</AppText>
            </View>
            <View style={[styles.lineFacts, styles.mt4]}>
              <LineFact label="Charge Date" value={fmtPlanDate(d.chargedAt)} />
              <LineFact label="Qty" value={String(l.qty)} />
              <LineFact label="Unit Price" value={fmtMoney(l.unit)} />
              <LineFact label="Tax" value={fmtMoney(l.tax)} />
            </View>
          </View>
        ))}
      </View>

      <View style={[styles.summary, box]}>
        <View style={styles.spread}>
          <AppText variant="small" tone="secondary" style={styles.flex}>Minimum Deposit (Collected)</AppText>
          <AppText variant="small" weight="600" mono>{fmtMoney(d.minDep)}</AppText>
        </View>
        <View style={styles.spread}>
          <AppText variant="small" tone="secondary" style={styles.flex}>Total Usage Charges</AppText>
          <AppText variant="small" weight="600" mono>{fmtMoney(d.usage)}</AppText>
        </View>
        <View style={[styles.spread, styles.summaryTotal, { borderTopColor: t.colors.borderSubtle }]}>
          <AppText variant="small" weight="700" style={styles.flex}>Remaining Deposit</AppText>
          <AppText variant="small" weight="700" mono>{fmtMoney(d.remaining)}</AppText>
        </View>
      </View>

      {d.exhausted ? (
        <View style={[styles.exhausted, { borderColor: t.alpha(t.colors.primary, 0.2), backgroundColor: t.alpha(t.colors.primary, 0.05), borderRadius: t.radius.xl }]}>
          <Icon name="info" size={13} color={t.colors.primaryText} />
          <AppText variant="caption" tone="secondary" style={styles.flex}>
            Deposit is exhausted. Further charges are deducted from your Main Wallet.
          </AppText>
        </View>
      ) : null}
    </View>
  );
}

function LineFact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.lineFact}>
      <AppText variant="micro" tone="muted" weight="700" style={styles.upper}>{label}</AppText>
      <AppText variant="caption" tone="secondary" mono>{value}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  upper: { textTransform: 'uppercase', letterSpacing: 0.8 },
  mt2: { marginTop: 2 },
  mt4: { marginTop: 4 },
  mt8: { marginTop: 8 },
  mt12: { marginTop: 12 },
  faded: { opacity: 0.4 },
  card: { marginTop: 24, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, paddingHorizontal: 16, paddingVertical: 16, borderBottomWidth: 1 },
  total: { alignItems: 'flex-end' },
  filters: { gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  filterRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  field: { flex: 1, minWidth: 0 },
  fieldLabel: { marginBottom: 4 },
  checkCell: { justifyContent: 'center', minHeight: 44 },
  filterActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  empty: { paddingHorizontal: 16, paddingVertical: 48 },
  period: { paddingHorizontal: 16, paddingVertical: 14 },
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  top: { alignItems: 'flex-start' },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, flex: 1, minWidth: 0 },
  amount: { alignItems: 'flex-end' },
  cells: { flexDirection: 'row', gap: 12 },
  cell: { flex: 1, minWidth: 0 },
  startRow: { flexDirection: 'row' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  chevron: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  flipped: { transform: [{ rotate: '180deg' }] },
  detail: { marginTop: 12, borderWidth: 1, padding: 12, gap: 8 },
  lines: { borderWidth: 1, overflow: 'hidden' },
  line: { paddingHorizontal: 12, paddingVertical: 8 },
  lineFacts: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 4 },
  lineFact: { minWidth: 64 },
  summary: { borderWidth: 1, padding: 12, gap: 8 },
  summaryTotal: { borderTopWidth: 1, paddingTop: 8 },
  exhausted: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderWidth: 1, padding: 12 },
  pager: { gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1 },
  pages: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 },
  pageBtn: { minWidth: 32, height: 32, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  ellipsis: { paddingHorizontal: 4 },
  rowsPer: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
