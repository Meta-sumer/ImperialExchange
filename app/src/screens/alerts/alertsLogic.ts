import { priceAlertStatus, type AlertDirection, type PriceAlert } from '@/types/market';

/**
 * The Price Alerts list's wording, ported from client/src/pages/PriceAlerts.jsx.
 * No React here.
 */

/** "↑ Above" in bull, "↓ Below" in bear. */
export const alertDirectionLabel = (d: AlertDirection): string => (d === 'ABOVE' ? '↑ Above' : '↓ Below');

/**
 * The status chip: a fired alert reads "Triggered @ <price>" even while
 * paused, then "Active", then "Paused" (types/market `priceAlertStatus`).
 */
export const alertStatusLabel = (a: Pick<PriceAlert, 'triggeredAt' | 'triggeredPrice' | 'isActive'>): string => {
  const s = priceAlertStatus(a);
  if (s === 'TRIGGERED') return `Triggered @ ${a.triggeredPrice ?? ''}`.trimEnd();
  return s === 'ACTIVE' ? 'Active' : 'Paused';
};

/** The row's toggle: Pause an active alert, Resume a paused one (resuming re-arms a fired one). */
export const toggleLabel = (a: Pick<PriceAlert, 'isActive'>): string => (a.isActive ? 'Pause' : 'Resume');
