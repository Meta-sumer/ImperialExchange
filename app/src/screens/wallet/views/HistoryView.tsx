import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, Share, StyleSheet, TextInput, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { AppText, BottomSheet, Button, Input, Select, Toggle, toast } from '@/components/ui';
import { WalletGlyph, categoryGlyph, type WalletGlyphName } from '@/components/wallet/WalletNav';
import { useAuthStore } from '@/store/auth';
import { useTheme } from '@/theme';
import type { UserAccount } from '@/types/user';
import type { Deposit, LedgerEntry, WalletTransaction, Withdrawal } from '@/types/wallet';
import {
  DATE_PRESETS,
  PAGE_SIZES,
  TYPE_CATEGORIES,
  balanceText,
  buildHistoryRows,
  customDateError,
  datePresetLabel,
  filterHistory,
  fmtTxnDateTime,
  historyAccountOptions,
  historyCsv,
  historyCsvFilename,
  historyAmountText,
  historyDetailRows,
  multiSummary,
  notesStorageKey,
  pageNumbers,
  pageSummary,
  parseNotes,
  rowDescription,
  statusDotColor,
  statusOptionsOf,
  totalPagesOf,
  txnDisplayId,
  withNote,
  type CustomRange,
  type HistoryRow,
} from '@/utils/walletLogic';

import { StatusPill, WalletCard } from '../RecentTransactions';

const amountText = (r: HistoryRow): string => historyAmountText(r.amount);

/**
 * Transaction History — client/src/components/TransactionHistory.jsx: the
 * deposits, withdrawals and ledger postings the Wallet already loads, plus
 * the Bonus Wallet's transactions and the retired Main Wallet's old ones
 * (read-only, "Main Wallet (closed)"), in one list — each with the
 * wallet's balance before and after it, and a trade or fee row's order
 * ticket. Filters (date presets + custom range, type categories, status,
 * account or wallet, search), paging, CSV export, a private note per row and
 * a details sheet.
 *
 * On a phone the twelve-column table is one card per row carrying the same
 * twelve fields, the dropdowns are bottom sheets, and "Export" hands a CSV
 * file to the share sheet (there is no downloads folder to drop it in).
 *
 * Differences from the web, deliberate:
 *   • "All Time" ignores custom dates set earlier (walletLogic.matchesDateRange).
 *   • Notes are stored per signed-in user, not per device.
 *   • A half-typed custom date is not applied until it is a whole date.
 */
export function HistoryView({
  deposits,
  withdrawals,
  ledger,
  subscriptions = [],
  bonusTx = [],
  accounts,
  loading,
}: {
  deposits: readonly Deposit[];
  withdrawals: readonly Withdrawal[];
  ledger: readonly LedgerEntry[];
  /** /subscriptions/history — plan charges and the old Main Wallet rows. */
  subscriptions?: readonly WalletTransaction[];
  /** The Bonus Wallet's transactions (/bonus-wallet/history). */
  bonusTx?: readonly WalletTransaction[];
  accounts: readonly UserAccount[];
  loading: boolean;
}): React.JSX.Element {
  const t = useTheme();
  const userId = useAuthStore((s) => s.user?.id ?? '');

  /* ── Private notes (TransactionHistory.jsx:538) ── */
  const [notes, setNotes] = useState<Record<string, string>>({});
  // The notes as last written — read and written OUTSIDE a state updater, so
  // a note committed while this view unmounts (the rail switched views with
  // a note half-typed) is still persisted: a setState on an unmounting
  // component never runs its updater.
  const notesRef = useRef<Record<string, string>>({});
  const persist = useCallback((next: Record<string, string>): void => {
    notesRef.current = next;
    setNotes(next);
    if (userId) {
      AsyncStorage.setItem(notesStorageKey(userId), JSON.stringify(next)).catch(() => {
        // Storage full or unavailable: the note holds for this visit.
      });
    }
  }, [userId]);

  useEffect(() => {
    let dead = false;
    notesRef.current = {};
    setNotes({});
    if (!userId) return undefined;
    AsyncStorage.getItem(notesStorageKey(userId))
      .then((raw) => {
        if (dead) return;
        // A note saved before the read came back is kept, not overwritten.
        const early = notesRef.current;
        const merged = { ...parseNotes(raw), ...early };
        if (Object.keys(early).length > 0) persist(merged);
        else { notesRef.current = merged; setNotes(merged); }
      })
      .catch(() => { /* unreadable storage: no notes, as the web's try/catch */ });
    return () => { dead = true; };
  }, [userId, persist]);

  const saveNote = useCallback((id: string, value: string): void => {
    persist(withNote(notesRef.current, id, value));
  }, [persist]);

  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [detailRow, setDetailRow] = useState<HistoryRow | null>(null);

  /* ── Filters ── */
  const [dateRange, setDateRange] = useState('all');
  const [customRange, setCustomRange] = useState<CustomRange>({ from: '', to: '' });
  const [accountId, setAccountId] = useState('all');
  const [search, setSearch] = useState('');
  const [typeSel, setTypeSel] = useState<string[] | null>(null);
  const [statusSel, setStatusSel] = useState<string[] | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);

  const allRows = useMemo(
    () => buildHistoryRows(deposits, withdrawals, ledger, subscriptions, bonusTx, accounts),
    [deposits, withdrawals, ledger, subscriptions, bonusTx, accounts],
  );
  const statusOptions = useMemo(() => statusOptionsOf(allRows), [allRows]);
  const effTypeSel = typeSel ?? TYPE_CATEGORIES;
  const effStatusSel = statusSel ?? statusOptions;

  const filtered = useMemo(
    () => filterHistory(allRows, {
      range: dateRange,
      custom: customRange,
      accountId,
      types: effTypeSel,
      statuses: effStatusSel,
      search,
    }),
    [allRows, dateRange, customRange, accountId, effTypeSel, effStatusSel, search],
  );

  // Back to the first page whenever a filter changes (TransactionHistory.jsx:614).
  useEffect(() => { setPage(1); }, [dateRange, customRange, accountId, search, typeSel, statusSel, pageSize]);

  const totalPages = totalPagesOf(filtered.length, pageSize);
  const current = Math.min(page, totalPages);
  const pageRows = filtered.slice((current - 1) * pageSize, current * pageSize);

  const [exporting, setExporting] = useState(false);
  const exportCsv = async (): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    const csv = historyCsv(filtered, notes);
    const name = historyCsvFilename();
    try {
      let shared = false;
      try {
        const file = new File(Paths.cache, name);
        file.create({ overwrite: true });
        file.write(csv);
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(file.uri, {
            mimeType: 'text/csv',
            UTI: 'public.comma-separated-values-text',
            dialogTitle: 'Transaction History',
          });
          shared = true;
        }
      } catch {
        shared = false;
      }
      // No file sharing on this device: hand the CSV over as text instead.
      if (!shared) await Share.share({ title: name, message: csv });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const accountOptions = useMemo(() => historyAccountOptions(accounts), [accounts]);

  return (
    <WalletCard padded={false}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: t.colors.borderSubtle }]}>
        <View style={styles.flex}>
          <AppText variant="h3" weight="700">Transaction History</AppText>
          <AppText variant="small" tone="muted" style={styles.gap2}>View and manage all your transactions in one place.</AppText>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Export"
          onPress={() => { void exportCsv(); }}
          disabled={exporting}
          style={({ pressed }) => [
            styles.export,
            { borderColor: pressed ? t.alpha(t.colors.primary, 0.4) : t.colors.borderDark, borderRadius: t.radius.xl, opacity: exporting ? 0.6 : 1 },
          ]}
        >
          <WalletGlyph name="download" size={15} color={t.colors.textPrimary} />
          <AppText variant="small" weight="600">Export</AppText>
        </Pressable>
      </View>

      {/* Filter bar */}
      <View style={[styles.filters, { borderBottomColor: t.colors.borderSubtle }]}>
        <DateRangeFilter value={dateRange} custom={customRange} onChange={setDateRange} onCustomChange={setCustomRange} />
        <MultiSelectFilter
          glyph="typeFilter"
          label="Transaction Type"
          title="Select Transaction Type"
          options={TYPE_CATEGORIES}
          selected={effTypeSel}
          onChange={setTypeSel}
          leading={(o) => <WalletGlyph name={categoryGlyph(o)} size={15} color={t.colors.textSecondary} strokeWidth={1.7} />}
        />
        <MultiSelectFilter
          glyph="statusPie"
          label="Status"
          title="Select Status"
          options={statusOptions}
          selected={effStatusSel}
          onChange={setStatusSel}
          leading={(o) => <View style={[styles.statusDot, { backgroundColor: statusDotColor(o) }]} />}
        />
        <AccountFilter options={accountOptions} value={accountId} onChange={setAccountId} />
        <Input
          value={search}
          onChangeText={setSearch}
          placeholder="Search by ID, description…"
          autoCorrect={false}
          autoCapitalize="none"
          accessibilityLabel="Search transactions"
          left={<WalletGlyph name="search" size={16} color={t.colors.textMuted} />}
        />
      </View>

      {/* Rows */}
      {loading ? (
        <AppText variant="body" tone="muted" align="center" style={styles.empty}>Loading…</AppText>
      ) : filtered.length === 0 ? (
        <AppText variant="body" tone="muted" align="center" style={styles.empty}>No transactions match your filters</AppText>
      ) : (
        pageRows.map((r, i) => (
          <HistoryRowCard
            key={`${r.kind}-${r.id}`}
            row={r}
            first={i === 0}
            note={notes[r.id]}
            editing={editingNote === r.id}
            onEditNote={() => setEditingNote(r.id)}
            onCommitNote={(v) => saveNote(r.id, v)}
            // Only closes THIS row's editor: by the time a late blur arrives
            // another row's may already be open.
            onCloseNote={() => setEditingNote((cur) => (cur === r.id ? null : cur))}
            onDetails={() => setDetailRow(r)}
          />
        ))
      )}

      {/* Footer / pagination */}
      {!loading && filtered.length > 0 ? (
        <View style={[styles.footer, { borderTopColor: t.colors.borderSubtle }]}>
          <AppText variant="small" tone="muted" align="center">{pageSummary(current, pageSize, filtered.length)}</AppText>
          <View style={styles.pagerRow}>
            <Select<number>
              variant="compact"
              value={pageSize}
              options={PAGE_SIZES.map((n) => ({ value: n, label: `${n} per page` }))}
              onChange={setPageSize}
              title="Rows per page"
              accessibilityLabel="Rows per page"
            />
            <View style={styles.pager}>
              <PageButton glyph="chevronLeft" label="Previous page" disabled={current === 1} onPress={() => setPage(current - 1)} />
              {pageNumbers(totalPages, current).map((n, i) => (n === '…'
                ? <AppText key={`e${i}`} variant="small" tone="muted" style={styles.ellipsis}>…</AppText>
                : <PageButton key={n} label={`Page ${n}`} text={String(n)} active={n === current} onPress={() => setPage(n)} />))}
              <PageButton glyph="chevronRight" label="Next page" disabled={current === totalPages} onPress={() => setPage(current + 1)} />
            </View>
          </View>
        </View>
      ) : null}

      <DetailsSheet row={detailRow} onClose={() => setDetailRow(null)} />
    </WalletCard>
  );
}

/* ── One row (the web's table row, as a card) ─────────────────────────── */

function HistoryRowCard({
  row,
  first,
  note,
  editing,
  onEditNote,
  onCommitNote,
  onCloseNote,
  onDetails,
}: {
  row: HistoryRow;
  first: boolean;
  note: string | undefined;
  editing: boolean;
  onEditNote: () => void;
  /** Store the note (an empty one deletes it). */
  onCommitNote: (v: string) => void;
  /** Leave editing mode. */
  onCloseNote: () => void;
  onDetails: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const amtColor = row.amount > 0 ? t.colors.bull : row.amount < 0 ? t.colors.bear : t.colors.textSecondary;
  const id = txnDisplayId(row.id);
  return (
    <View style={[styles.row, first ? null : { borderTopWidth: 1, borderTopColor: t.colors.borderSubtle }]}>
      <View style={styles.rowTop}>
        <View style={styles.flex}>
          <AppText variant="bodyStrong" weight="600" numberOfLines={1}>{row.type}</AppText>
          <AppText variant="small" tone="secondary">{fmtTxnDateTime(row.date)}</AppText>
        </View>
        <View style={styles.right}>
          <AppText variant="bodyStrong" mono weight="700" color={amtColor}>{amountText(row)}</AppText>
          <StatusPill status={row.status} variant="history" />
        </View>
      </View>

      <View style={styles.inline}>
        <AppText variant="caption" mono>{id}</AppText>
        <CopyButton text={id} />
      </View>

      <View style={styles.fields}>
        <Field label="Balance Before" value={balanceText(row.beforeBal)} mono />
        <Field label="Balance After" value={balanceText(row.afterBal)} mono />
        <Field label="Payment Method" value={row.method} />
        <Field label="Currency" value={row.currency} mono />
        <Field label="Received From" value={row.receivedFrom} />
        <Field label="Destination" value={row.destination} />
      </View>
      <AppText variant="small" tone="secondary">{rowDescription(row)}</AppText>

      <View style={styles.actions}>
        {editing ? (
          <NoteEditor initial={note ?? ''} onCommit={onCommitNote} onClose={onCloseNote} />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={note ? `Note: ${note}` : 'Add note'}
            onPress={onEditNote}
            style={({ pressed }) => [
              styles.noteBtn,
              { backgroundColor: note ? t.colors.primarySoft : pressed ? t.colors.bgHover : 'transparent', borderColor: t.colors.borderDark },
            ]}
          >
            <WalletGlyph name="pencil" size={14} color={note ? t.colors.primaryText : t.colors.textMuted} />
            <AppText variant="small" color={note ? t.colors.primaryText : t.colors.textSecondary} numberOfLines={2} style={styles.shrink}>
              {note || 'Add note'}
            </AppText>
          </Pressable>
        )}
        {!editing ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="View details"
            onPress={onDetails}
            hitSlop={6}
            style={({ pressed }) => [styles.eyeBtn, { backgroundColor: pressed ? t.colors.bgHover : 'transparent' }]}
          >
            <WalletGlyph name="eye" size={16} color={t.colors.textMuted} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <View style={styles.field}>
      <AppText variant="micro" tone="muted" weight="700" style={styles.upper}>{label}</AppText>
      <AppText variant="small" tone="secondary" mono={mono}>{value}</AppText>
    </View>
  );
}

/**
 * The web's note field: saved on blur or Enter, dropped on Escape. On a phone
 * Escape is the ×.
 *
 * On the web, clicking anywhere else blurs the field first, so the note is
 * always saved. Here the screen keeps the keyboard up across taps
 * (keyboardShouldPersistTaps="handled"), so tapping another row's note, the
 * pager or a filter unmounts this editor WITHOUT a blur — and a TextInput's
 * blur is never delivered once it has unmounted. So an editor that goes away
 * without Done / blur / × saves what was typed, as the web's blur would.
 *
 * While the × is held, a blur is not a save (it would store what is being
 * thrown away); letting go off the × leaves the editor working as before.
 */
function NoteEditor({ initial, onCommit, onClose }: {
  initial: string;
  onCommit: (v: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const [draft, setDraft] = useState(initial);
  const done = useRef(false);
  const cancelHeld = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const initialRef = useRef(initial);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const save = (): void => {
    if (done.current || cancelHeld.current) return;
    done.current = true;
    onCommit(draft.trim());
    onClose();
  };
  const cancel = (): void => {
    done.current = true;
    onClose();
  };
  // Unmounted with the note still open. Only a CHANGED note is written, so a
  // mount-and-unmount (StrictMode) or an untouched editor writes nothing.
  useEffect(() => () => {
    if (done.current) return;
    const v = draftRef.current.trim();
    if (v === initialRef.current.trim()) return;
    done.current = true;
    commitRef.current(v);
  }, []);

  return (
    <View style={[styles.noteEdit, { borderColor: t.alpha(t.colors.primary, 0.5) }]}>
      <TextInput
        autoFocus
        value={draft}
        onChangeText={setDraft}
        onBlur={save}
        onSubmitEditing={save}
        returnKeyType="done"
        placeholder="Add note"
        placeholderTextColor={t.colors.textMuted}
        accessibilityLabel="Note"
        style={[styles.noteInput, { color: t.colors.textPrimary }]}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel note"
        onPressIn={() => { cancelHeld.current = true; }}
        onPressOut={() => { cancelHeld.current = false; }}
        onPress={cancel}
        hitSlop={8}
      >
        <WalletGlyph name="close" size={14} color={t.colors.textMuted} strokeWidth={2.2} />
      </Pressable>
    </View>
  );
}

/** TransactionHistory.jsx:171 CopyBtn — a tick for 1.2s after copying. */
function CopyButton({ text }: { text: string }): React.JSX.Element {
  const t = useTheme();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = (): void => {
    Clipboard.setStringAsync(text).catch(() => undefined);
    setDone(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 1200);
  };
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Copy Transaction ID" onPress={copy} hitSlop={8}>
      <WalletGlyph name={done ? 'check' : 'copy'} size={13} color={done ? t.colors.primaryText : t.colors.textMuted} strokeWidth={done ? 2.4 : 1.8} />
    </Pressable>
  );
}

function PageButton({ glyph, text, label, active = false, disabled = false, onPress }: {
  glyph?: WalletGlyphName;
  text?: string;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pageBtn,
        {
          backgroundColor: active ? t.colors.primary : pressed ? t.colors.bgHover : 'transparent',
          borderColor: active ? t.colors.primary : t.colors.borderDark,
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      {glyph ? <WalletGlyph name={glyph} size={14} color={t.colors.textSecondary} strokeWidth={2} /> : null}
      {text ? <AppText variant="small" weight="600" color={active ? t.colors.onPrimary : t.colors.textSecondary}>{text}</AppText> : null}
    </Pressable>
  );
}

/* ── Filters (TransactionHistory.jsx:193-491) ─────────────────────────── */

/** Label on top, current value below, chevron — the web's FilterTrigger. */
function FilterTrigger({ glyph, label, value, open, onPress }: {
  glyph: WalletGlyphName;
  label: string;
  value: string;
  open: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      style={[
        styles.trigger,
        {
          backgroundColor: t.colors.surface,
          borderColor: open ? t.colors.primary : t.colors.borderDark,
          borderRadius: t.radius.xl,
        },
      ]}
    >
      <WalletGlyph name={glyph} size={15} color={t.colors.textMuted} />
      <View style={styles.flex}>
        <AppText variant="micro" tone="muted" weight="700" numberOfLines={1} style={styles.upper}>{label}</AppText>
        <AppText variant="body" weight="600" numberOfLines={1} style={styles.triggerValue}>{value}</AppText>
      </View>
      <WalletGlyph name="chevronDown" size={14} color={t.colors.textMuted} strokeWidth={2} />
    </Pressable>
  );
}

function MultiSelectFilter({ glyph, label, title, options, selected, onChange, leading }: {
  glyph: WalletGlyphName;
  label: string;
  title: string;
  options: readonly string[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  leading: (o: string) => ReactNode;
}): React.JSX.Element {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const all = options.length > 0 && selected.length === options.length;
  const toggle = (o: string): void =>
    onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o]);
  return (
    <>
      <FilterTrigger glyph={glyph} label={label} value={multiSummary(options.length, selected.length)} open={open} onPress={() => setOpen(true)} />
      <BottomSheet open={open} onClose={() => setOpen(false)} title={title}>
        <View style={[styles.sheetRow, { borderBottomWidth: 1, borderBottomColor: t.colors.borderSubtle }]}>
          <AppText variant="small" tone="muted" weight="600" style={styles.flex}>Select All</AppText>
          <Toggle value={all} accessibilityLabel="Select All" onValueChange={() => onChange(all ? [] : [...options])} />
        </View>
        {options.map((o) => (
          <View key={o} style={styles.sheetRow}>
            <View style={styles.leading}>{leading(o)}</View>
            <AppText variant="body" numberOfLines={1} style={styles.flex}>{o}</AppText>
            <Toggle value={selected.includes(o)} accessibilityLabel={o} onValueChange={() => toggle(o)} />
          </View>
        ))}
        {options.length === 0 ? <AppText variant="small" tone="muted">No options</AppText> : null}
      </BottomSheet>
    </>
  );
}

function DateRangeFilter({ value, custom, onChange, onCustomChange }: {
  value: string;
  custom: CustomRange;
  onChange: (k: string) => void;
  onCustomChange: (c: CustomRange) => void;
}): React.JSX.Element {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <>
      <FilterTrigger glyph="calendar" label="Date Range" value={datePresetLabel(value)} open={open} onPress={() => setOpen(true)} />
      <BottomSheet open={open} onClose={() => setOpen(false)} title="Select Date Range">
        {DATE_PRESETS.map((p) => {
          const active = value === p.key;
          return (
            <Pressable
              key={p.key}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => { onChange(p.key); if (p.key !== 'custom') setOpen(false); }}
              style={({ pressed }) => [
                styles.sheetRow,
                styles.presetRow,
                { backgroundColor: active ? t.colors.primarySoft : pressed ? t.colors.bgHover : 'transparent' },
              ]}
            >
              <WalletGlyph name="calendar" size={15} color={active ? t.colors.primaryText : t.colors.textMuted} />
              <AppText variant="body" weight={active ? '600' : '400'} color={active ? t.colors.primaryText : t.colors.textPrimary} style={styles.flex}>
                {p.label}
              </AppText>
              {active ? <WalletGlyph name="check" size={15} color={t.colors.primaryText} strokeWidth={2.4} /> : null}
            </Pressable>
          );
        })}
        {value === 'custom' ? (
          <View style={styles.customRange}>
            {/* The web's native date input cannot hold an impossible day; typed
                text can, so a whole-but-impossible date says so (and is not
                applied) rather than rolling over to another day. */}
            <Input
              label="From"
              value={custom.from}
              onChangeText={(v) => onCustomChange({ ...custom, from: v })}
              placeholder="YYYY-MM-DD"
              keyboardType="numbers-and-punctuation"
              maxLength={10}
              autoCorrect={false}
              error={customDateError(custom.from)}
              mono
            />
            <Input
              label="To"
              value={custom.to}
              onChangeText={(v) => onCustomChange({ ...custom, to: v })}
              placeholder="YYYY-MM-DD"
              keyboardType="numbers-and-punctuation"
              maxLength={10}
              autoCorrect={false}
              error={customDateError(custom.to)}
              mono
            />
            <Button title="Done" size="sm" onPress={() => setOpen(false)} />
          </View>
        ) : null}
      </BottomSheet>
    </>
  );
}

function AccountFilter({ options, value, onChange }: {
  options: { id: string; name: string; sub: string }[];
  value: string;
  onChange: (id: string) => void;
}): React.JSX.Element {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.id === value) ?? options[0];
  return (
    <>
      <FilterTrigger glyph="walletSmall" label="Accounts" value={cur?.name ?? 'All Accounts'} open={open} onPress={() => setOpen(true)} />
      <BottomSheet open={open} onClose={() => setOpen(false)} title="Select Account">
        {options.map((o) => {
          const active = value === o.id;
          return (
            <Pressable
              key={o.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              onPress={() => { onChange(o.id); setOpen(false); }}
              style={({ pressed }) => [styles.sheetRow, styles.presetRow, { backgroundColor: pressed ? t.colors.bgHover : 'transparent' }]}
            >
              <WalletGlyph name="walletSmall" size={15} color={t.colors.textMuted} />
              <View style={styles.flex}>
                <AppText variant="body" numberOfLines={1}>{o.name}</AppText>
                {o.sub ? <AppText variant="caption" tone="muted" mono numberOfLines={1}>{o.sub}</AppText> : null}
              </View>
              <View style={[styles.radio, { borderColor: active ? t.colors.primaryText : t.colors.borderDark }]}>
                {active ? <View style={[styles.radioDot, { backgroundColor: t.colors.primaryText }]} /> : null}
              </View>
            </Pressable>
          );
        })}
      </BottomSheet>
    </>
  );
}

/** TransactionHistory.jsx:498 DetailsModal, as a sheet. */
function DetailsSheet({ row, onClose }: { row: HistoryRow | null; onClose: () => void }): React.JSX.Element {
  return (
    <BottomSheet open={row !== null} onClose={onClose} title="Transaction Details">
      {row ? (
        <View style={styles.details}>
          {historyDetailRows(row).map(([k, v, sysRef]) => (
            <View key={k} style={styles.detailRow}>
              <AppText variant="caption" tone="muted" weight="700" style={[styles.upper, styles.detailKey]}>{k}</AppText>
              <View style={styles.flex}>
                <AppText variant="body" weight="600" align="right" mono={!!sysRef} selectable>{v}</AppText>
                {sysRef ? (
                  <AppText variant="micro" tone="muted" mono align="right" selectable accessibilityLabel="Internal reference">{sysRef}</AppText>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  upper: { textTransform: 'uppercase', letterSpacing: 0.6 },
  gap2: { marginTop: 2 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1 },
  export: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8 },
  filters: { gap: 12, paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1 },
  trigger: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10 },
  triggerValue: { fontSize: 13 },
  empty: { paddingVertical: 64 },
  row: { paddingHorizontal: 20, paddingVertical: 14, gap: 8 },
  rowTop: { flexDirection: 'row', gap: 12 },
  right: { alignItems: 'flex-end', gap: 4 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  fields: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 8 },
  field: { width: '50%', paddingRight: 8, gap: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  noteBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  eyeBtn: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  noteEdit: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10 },
  noteInput: { flex: 1, fontSize: 12, paddingVertical: 6 },
  footer: { gap: 12, paddingHorizontal: 20, paddingVertical: 16, borderTopWidth: 1 },
  pagerRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 12 },
  pager: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 },
  pageBtn: { minWidth: 32, height: 32, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  ellipsis: { width: 24, textAlign: 'center' },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  presetRow: { paddingHorizontal: 8, borderRadius: 8 },
  leading: { width: 18, alignItems: 'center' },
  customRange: { gap: 12, paddingTop: 12 },
  radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 8, height: 8, borderRadius: 4 },
  details: { gap: 12 },
  detailRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 16 },
  detailKey: { paddingTop: 2 },
});
