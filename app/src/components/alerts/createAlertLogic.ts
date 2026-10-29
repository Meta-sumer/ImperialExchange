import type { CreatePriceAlertInput } from '@/api/alerts.api';
import type { AlertDirection } from '@/types/market';
import type { Instrument } from '@/types/trading';
import { fmtPrice } from '@/utils/money';

/**
 * The New Price Alert form's rules, ported from
 * client/src/components/CreateAlertModal.jsx. No React here. The request
 * and its validation are alerts.api (`validatePriceAlert`,
 * `createPriceAlert`).
 */

export interface AlertForm {
  symbol: string;
  direction: AlertDirection;
  /** As typed — the server stores the string. */
  targetPrice: string;
  note: string;
  repeatable: boolean;
}

/** "Price goes ABOVE" / "Price goes BELOW", in the web's order. */
export const DIRECTION_OPTIONS: readonly { value: AlertDirection; label: string }[] = [
  { value: 'ABOVE', label: 'Price goes ABOVE' },
  { value: 'BELOW', label: 'Price goes BELOW' },
];

/**
 * The form a fresh modal opens with. The web starts on the FIRST instrument
 * of the list it was given; a symbol handed in (the `/alerts?symbol=` link
 * StockDetail emits, which the web ignores) is used instead.
 */
export const initialAlertForm = (
  instruments: readonly Pick<Instrument, 'symbol'>[],
  initialSymbol?: string | null,
): AlertForm => ({
  symbol: (initialSymbol ?? '').trim().toUpperCase() || instruments[0]?.symbol || '',
  direction: 'ABOVE',
  targetPrice: '',
  note: '',
  repeatable: false,
});

/** The symbol picker shows at most this many rows (SymbolCombobox). */
export const SYMBOL_RESULTS_CAP = 300;

/**
 * SymbolCombobox's filter: case-insensitive on the symbol or the name,
 * capped at 300 so a catalogue of thousands stays quick.
 */
export const filterAlertSymbols = <I extends Pick<Instrument, 'symbol' | 'name'>>(
  instruments: readonly I[],
  query: string,
): I[] => {
  const s = query.trim().toLowerCase();
  const base = s
    ? instruments.filter((i) => i.symbol.toLowerCase().includes(s) || (i.name || '').toLowerCase().includes(s))
    : instruments;
  return base.slice(0, SYMBOL_RESULTS_CAP);
};

/** "No symbols match "<q>"" — the picker's empty line. */
export const noSymbolsMessage = (query: string): string => `No symbols match "${query}"`;

/** Does the instrument have a price to show / copy / use? */
export const hasPrice = (i: Pick<Instrument, 'lastPrice'> | null | undefined): boolean =>
  i?.lastPrice != null && String(i.lastPrice) !== '';

/**
 * A price as shown: the instrument's own precision, in rupees (the
 * web prints the raw string). What Copy and "Use as target" take is the raw
 * string itself (`rawPrice`) — the exact figure, as on the web.
 */
export const shownPrice = (i: Pick<Instrument, 'lastPrice' | 'pricePrecision' | 'quoteCurrency'> | null | undefined): string =>
  (hasPrice(i) ? fmtPrice(i?.lastPrice, i?.pricePrecision ?? 2, i?.quoteCurrency ?? 'INR') : '—');

export const rawPrice = (i: Pick<Instrument, 'lastPrice'> | null | undefined): string =>
  (hasPrice(i) ? String(i?.lastPrice) : '');

/**
 * The Target Price field. The web's `<input type="number" step="any">`
 * holds a decimal; the phone keyboard can offer more, so keep digits and one
 * decimal point.
 */
export const sanitizePriceInput = (v: string): string => {
  const cleaned = v.replace(/,/g, '.').replace(/[^\d.]/g, '');
  const dot = cleaned.indexOf('.');
  return dot < 0 ? cleaned : `${cleaned.slice(0, dot + 1)}${cleaned.slice(dot + 1).replace(/\./g, '')}`;
};

/**
 * The target as the web's number input would hand it over. A number input
 * that holds no number reports '' — so a lone "." is empty here too (and
 * gets the web's "Symbol and target price are required" rather than being
 * stored as "." by a server that only checks the string is non-empty) — and
 * a trailing point is dropped ("10." → "10").
 */
export const canonicalTargetPrice = (v: string): string => {
  const s = v.trim();
  if (!/\d/.test(s)) return '';
  return s.endsWith('.') ? s.slice(0, -1) : s;
};

/** The form as it is checked and sent: the target canonical, the rest as typed. */
export const submittableForm = (f: AlertForm): AlertForm => ({ ...f, targetPrice: canonicalTargetPrice(f.targetPrice) });

/** What POST /reports/alerts receives — the web posts the form object as it stands. */
export const alertInput = (f: AlertForm): CreatePriceAlertInput => {
  const s = submittableForm(f);
  return {
    symbol: s.symbol,
    direction: s.direction,
    targetPrice: s.targetPrice,
    note: s.note,
    repeatable: s.repeatable,
  };
};
