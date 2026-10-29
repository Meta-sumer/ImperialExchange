import type { AxiosError } from 'axios';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { api } from '@/api/client';
import { fetchOrderHistory, fetchPositionHistory } from '@/api/trading.api';
import type { Order, PositionHistorySummary } from '@/types/trading';

/**
 * The Reports screen — its summary and the CSV exports. Ported from
 * pages/Reports.jsx; endpoints: backend/src/routes/reports.js (exports) and
 * routes/trading.js (the history it summarises). Price alerts share the
 * /reports prefix but are alerts.api.
 */

/* ── Summary ──────────────────────────────────────────────────────────── */

export interface ReportsOverview {
  /** Filled, cancelled and rejected orders, newest first — the first page of /trading/orders/history. */
  orders: Order[];
  /** Over ALL closed positions, aggregated server-side. */
  summary: PositionHistorySummary;
}

/**
 * The two reads Reports.jsx makes on mount. `limit: 1` because only the
 * summary footer is wanted from the position history, not its rows.
 */
export const fetchReportsOverview = async (): Promise<ReportsOverview> => {
  const [orders, history] = await Promise.all([
    fetchOrderHistory(),
    fetchPositionHistory({ limit: 1 }),
  ]);
  return { orders, summary: history.summary };
};

/**
 * Win rate as Reports.jsx prints it: break-even trades are left out of the
 * denominator, one decimal, and '0' when nothing has been decided.
 */
export const reportsWinRate = (s: Pick<PositionHistorySummary, 'wins' | 'losses'>): string => {
  const decided = s.wins + s.losses;
  return decided ? ((s.wins / decided) * 100).toFixed(1) : '0';
};

/* ── CSV exports ──────────────────────────────────────────────────────── */

/**
 * The three exports and the file each downloads as. Each server export is
 * capped at 5,000 rows.
 */
export const REPORT_EXPORTS = {
  orders: { path: '/reports/export/orders.csv', filename: 'orders.csv', label: 'Orders CSV' },
  positions: { path: '/reports/export/positions.csv', filename: 'positions.csv', label: 'Positions CSV' },
  ledger: { path: '/reports/export/ledger.csv', filename: 'ledger.csv', label: 'Ledger CSV' },
} as const;
export type ReportExport = keyof typeof REPORT_EXPORTS;

export interface ExportFilters {
  /** '' or absent: every account. */
  accountId?: string;
  /** Calendar dates, YYYY-MM-DD, in the device's own time zone. */
  from?: string;
  to?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The query Reports.jsx `exportParams` builds: `from` is the START of that
 * local day and `to` the END of it (23:59:59), both sent as ISO instants —
 * so a one-day range means that whole day where the trader is, not in UTC.
 */
export const exportParams = (f: ExportFilters): Record<string, string> => {
  const p: Record<string, string> = {};
  if (f.accountId) p.accountId = f.accountId;
  if (f.from && DATE_RE.test(f.from)) p.from = new Date(`${f.from}T00:00:00`).toISOString();
  if (f.to && DATE_RE.test(f.to)) p.to = new Date(`${f.to}T23:59:59`).toISOString();
  return p;
};

/**
 * With `responseType: 'text'` an error body arrives as a JSON STRING, so
 * errorMessage() would find no `error.message` in it and say "Request
 * failed". Parse it back so the server's own reason reaches the trader.
 * (The web's blob download has the same hole and shows axios's generic text.)
 */
const restoreErrorBody = (err: unknown): unknown => {
  const e = err as AxiosError | undefined;
  const body = e?.response?.data;
  if (e?.response && typeof body === 'string') {
    try { e.response.data = JSON.parse(body) as unknown; } catch { /* not JSON — leave it */ }
  }
  return err;
};

/** GET the CSV body itself. Rejects with the server's error, readable. */
export const fetchReportCsv = async (kind: ReportExport, filters: ExportFilters = {}): Promise<string> => {
  try {
    const res = await api.get<string>(REPORT_EXPORTS[kind].path, {
      params: exportParams(filters),
      responseType: 'text',
      // Axios would JSON-parse a body that looks like JSON; a CSV must stay text.
      transformResponse: [(d: unknown) => d],
    });
    return typeof res.data === 'string' ? res.data : String(res.data ?? '');
  } catch (err) {
    throw restoreErrorBody(err);
  }
};

/**
 * Download an export and hand it to the share sheet — the phone's "save as".
 * The web clicks an `<a download>`; there is no downloads folder to drop a
 * file into here, so the file is written to the cache and the trader picks
 * where it goes (Files, Drive, mail…). Returns the file's URI.
 */
export const exportReportCsv = async (kind: ReportExport, filters: ExportFilters = {}): Promise<string> => {
  const csv = await fetchReportCsv(kind, filters);
  const file = new File(Paths.cache, REPORT_EXPORTS[kind].filename);
  file.create({ overwrite: true });
  file.write(csv);
  // A file left in the cache with no way to reach it is not a download; say so.
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');
  await Sharing.shareAsync(file.uri, {
    mimeType: 'text/csv',
    UTI: 'public.comma-separated-values-text',
    dialogTitle: REPORT_EXPORTS[kind].label,
  });
  return file.uri;
};
