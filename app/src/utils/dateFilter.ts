/**
 * The global date-range filter's logic — [ Today ] [ 7 Days ] [ 30 Days ]
 * [ Custom ] — ported from client/src/components/DateFilter.jsx (the
 * component itself is components/orders/DateFilter.tsx).
 *
 * Every preset resolves to a concrete `{ fromDate, toDate }` pair of LOCAL
 * calendar days (YYYY-MM-DD), so an API always receives a real range and
 * "Today" means today where the trader is. `period: null` is all time — no
 * bounds at all, which is what Orders.jsx starts on.
 *
 * No React here, so it tests without a renderer.
 */

export type DatePeriod = 'today' | '7d' | '30d' | 'custom';

export interface DateRange {
  /** null = all time / no filter. */
  period: DatePeriod | null;
  /** YYYY-MM-DD, or '' for no bound. */
  fromDate: string;
  toDate: string;
}

export const ALL_TIME: DateRange = { period: null, fromDate: '', toDate: '' };

/** DateFilter.jsx PRESETS, in order. Custom is its own button. */
export const DATE_FILTER_PRESETS: readonly { key: Exclude<DatePeriod, 'custom'>; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
];

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number): string => String(n).padStart(2, '0');

/** A Date's LOCAL calendar day as YYYY-MM-DD. */
export const toYMD = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** '2026-09-01', '2026-09-30' → '01 Sep 2026 - 30 Sep 2026'; a missing end reads '?'. */
export const fmtRange = (a: string | null | undefined, b: string | null | undefined): string => {
  const f = (s: string | null | undefined): string => {
    if (!s) return '?';
    const [y, m, d] = s.split('-');
    return `${d} ${MON[Number(m) - 1]} ${y}`;
  };
  return `${f(a)} - ${f(b)}`;
};

/**
 * DateFilter.jsx `computeRange`. `today`, `30d` and `custom` as named; `null`
 * (or undefined) is all time; ANY other value — including the '7d' preset —
 * is the last seven days, today included. `now` is injectable for tests.
 */
export const computeRange = (
  period: string | null | undefined,
  fromDate = '',
  toDate = '',
  now: Date = new Date(),
): DateRange => {
  const end = toYMD(now);
  if (period === 'today') return { period: 'today', fromDate: end, toDate: end };
  if (period === '30d') {
    const f = new Date(now);
    f.setDate(f.getDate() - 29);
    return { period: '30d', fromDate: toYMD(f), toDate: end };
  }
  if (period === 'custom') return { period: 'custom', fromDate, toDate };
  if (period == null) return { ...ALL_TIME };
  const f = new Date(now);
  f.setDate(f.getDate() - 6);
  return { period: '7d', fromDate: toYMD(f), toDate: end };
};

/** The Custom button's text: the chosen range once there is one, else "Custom". */
export const customButtonLabel = (value: DateRange | null | undefined): string =>
  (value?.period === 'custom' && value.fromDate && value.toDate
    ? fmtRange(value.fromDate, value.toDate)
    : 'Custom');

/* ── Typed dates ──────────────────────────────────────────────────────── */

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A whole YYYY-MM-DD that names a real day. The web's `<input type="date">`
 * cannot hold 2026-02-31; typed text can, and `new Date(2026, 1, 31)` would
 * silently roll over to 3 March — a different day from the one asked for.
 */
export const isCalendarDate = (value: string | null | undefined): boolean => {
  const s = String(value ?? '').trim();
  if (!YMD.test(s)) return false;
  const [y = 0, m = 0, d = 0] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
};

/**
 * Why a typed date cannot be used, or null. Half-typed text is not an error
 * yet (the trader is still typing); a whole one that names no real day is.
 * The wording is the Wallet history's (stage 2), so the app says it one way.
 */
export const typedDateError = (value: string): string | null => {
  const s = value.trim();
  if (s.length < 10) return null;
  return isCalendarDate(s) ? null : 'Enter a real date as YYYY-MM-DD';
};

/**
 * The web's date inputs carry `max={to}` / `min={from}`, so its picker cannot
 * choose an end before the start. Typing can, so a reversed pair is caught
 * here instead. Null when the order is fine or either end is not yet a date.
 */
export const reversedRangeError = (from: string, to: string): string | null =>
  (isCalendarDate(from) && isCalendarDate(to) && from.trim() > to.trim()
    ? 'End date is before start date'
    : null);

/** The custom popover's Apply: both ends real days, in order. */
export const canApplyCustom = (from: string, to: string): boolean =>
  isCalendarDate(from) && isCalendarDate(to) && reversedRangeError(from, to) === null;

/**
 * Keep only digits and dashes, at most 10 — what a YYYY-MM-DD field can hold.
 * The keyboard offers more than the web's date input does.
 */
export const sanitizeDateInput = (v: string): string => v.replace(/[^\d-]/g, '').slice(0, 10);

/* ── Persistence (useDateFilter) ──────────────────────────────────────── */

/**
 * `useDateFilter(storageKey)`'s hydration, pure: a saved CUSTOM range comes
 * back as saved; a saved preset is RE-COMPUTED against today (a "7 Days"
 * saved last week means the last seven days now, not then); anything
 * unreadable falls back to the default period.
 */
export const rangeFromStored = (
  stored: unknown,
  defaultPeriod: string | null = '7d',
  now: Date = new Date(),
): DateRange => {
  const s = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : null;
  if (s && 'period' in s) {
    if (s.period === 'custom') {
      return {
        period: 'custom',
        fromDate: typeof s.fromDate === 'string' ? s.fromDate : '',
        toDate: typeof s.toDate === 'string' ? s.toDate : '',
      };
    }
    return computeRange(s.period == null ? null : String(s.period), '', '', now);
  }
  return computeRange(defaultPeriod, '', '', now);
};
