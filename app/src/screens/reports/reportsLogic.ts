import type { ExportFilters } from '@/api/reports.api';
import type { Instrument, Order } from '@/types/trading';
import { isCalendarDate, reversedRangeError, typedDateError } from '@/utils/dateFilter';
import { fmtMoney, fmtPrice } from '@/utils/money';

/**
 * The Reports page's rules, ported from client/src/pages/Reports.jsx. No
 * React here. The screen is ReportsScreen.tsx; the calls are reports.api.
 */

/** "Recent Order Activity" shows the newest 50 (Reports.jsx:194). */
export const RECENT_ORDERS_LIMIT = 50;

/** Realized P&L headline: `+` for zero and up, in rupees (Reports.jsx). */
export const realizedPnlText = (netPnl: number | string | null | undefined): string => {
  const n = Number(netPnl || 0);
  const v = Number.isFinite(n) ? n : 0;
  return `${v >= 0 ? '+' : ''}${fmtMoney(v)}`;
};

export const realizedPnlIsLoss = (netPnl: number | string | null | undefined): boolean => Number(netPnl || 0) < 0;

/** The status chip's colour, in the web's order: FILLED, CANCELLED, REJECTED, anything else. */
export type OrderStatusTone = 'bull' | 'muted' | 'bear' | 'warn';
export const orderStatusTone = (status: string | null | undefined): OrderStatusTone => {
  if (status === 'FILLED') return 'bull';
  if (status === 'CANCELLED') return 'muted';
  if (status === 'REJECTED') return 'bear';
  return 'warn';
};

/**
 * The Qty cell: the filled size, else the order's size.
 *
 * DOCUMENTED DIVERGENCE. The web writes `t.filledQuantity || t.quantity`,
 * but the server's `filledQuantity` defaults to the STRING '0'
 * (models/Order.js), which is truthy — so every cancelled and rejected order
 * showed a quantity of 0. The number decides here, as Orders.jsx's
 * `Number(closedQuantity) > 0` does.
 */
export const orderQty = (o: Pick<Order, 'filledQuantity' | 'quantity'>): string =>
  (Number(o.filledQuantity) > 0 ? o.filledQuantity : o.quantity);

/**
 * The Price cell: the average fill, else the order's limit / stop price,
 * else '—'. The web prints the server's string as it comes; when the
 * catalogue knows the instrument the port prints it at the instrument's own
 * precision and quote currency (a computed average can carry a long tail).
 */
export const orderPriceText = (
  o: Pick<Order, 'avgFillPrice' | 'price'>,
  instrument: Pick<Instrument, 'pricePrecision' | 'quoteCurrency'> | null | undefined,
): string => {
  const raw = o.avgFillPrice || o.price || '';
  if (!raw) return '—';
  if (!instrument || !Number.isFinite(Number(raw))) return raw;
  return fmtPrice(raw, instrument.pricePrecision ?? 2, instrument.quoteCurrency ?? 'INR');
};

/** The export Account option: nickname or number, then " · <currency>" when there is one. */
export const exportAccountLabel = (a: { nickname?: string | null; accountNumber: string; baseCurrency?: string | null }): string =>
  `${a.nickname || a.accountNumber}${a.baseCurrency ? ` · ${a.baseCurrency}` : ''}`;

export interface ExportForm {
  accountId: string;
  from: string;
  to: string;
}

export const EMPTY_EXPORT_FORM: ExportForm = { accountId: '', from: '', to: '' };

/** "Clear" shows once any export filter is set (Reports.jsx:143). */
export const hasExportFilters = (f: ExportForm): boolean => !!(f.accountId || f.from || f.to);

/**
 * Why the typed dates cannot be exported, per field, or null. The web's date
 * inputs cannot hold a half-typed or impossible day, and their min / max stop
 * a reversed pair; typed text can, and reports.api drops a date it cannot
 * read — which would export ALL time under a range the trader thinks they
 * set. So an unusable date blocks the export and says why.
 */
export const exportDateErrors = (f: Pick<ExportForm, 'from' | 'to'>): { from: string | null; to: string | null } => {
  const from = f.from.trim();
  const to = f.to.trim();
  // Half-typed is not an error yet (typedDateError); it only blocks the export.
  return { from: typedDateError(from), to: typedDateError(to) ?? reversedRangeError(from, to) };
};

/** Every set date is a real day, and the pair is in order. */
export const canExport = (f: Pick<ExportForm, 'from' | 'to'>): boolean => {
  const from = f.from.trim();
  const to = f.to.trim();
  if (from && !isCalendarDate(from)) return false;
  if (to && !isCalendarDate(to)) return false;
  return reversedRangeError(from, to) === null;
};

/** What reports.api sends for the form. */
export const exportFiltersOf = (f: ExportForm): ExportFilters => ({
  accountId: f.accountId || undefined,
  from: f.from.trim() || undefined,
  to: f.to.trim() || undefined,
});
