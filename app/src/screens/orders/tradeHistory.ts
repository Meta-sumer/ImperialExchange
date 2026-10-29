import { fetchUnifiedHistory } from '@/api/trading.api';

import {
  EMPTY_SUMMARY,
  TRADE_HISTORY_PAGE_SIZE,
  historyQueryFor,
  type OrdersFilters,
  type TradeHistoryPage,
} from './ordersLogic';

/**
 * Orders.jsx's history load as one call: GET /trading/history for the
 * filters — closed trades, cancelled and rejected orders in one list, paged
 * server-side, with the TRADE summary computed over the closed rows only.
 * A failed load rejects — the screen shows the error.
 */
export const loadTradeHistory = async (
  f: OrdersFilters,
  filteredAccounts: readonly { id: string }[],
): Promise<TradeHistoryPage> => {
  const query = historyQueryFor(f, filteredAccounts);
  if (!query) {
    // A TYPE filter with no account of that type: nothing can match.
    return {
      items: [],
      summary: EMPTY_SUMMARY,
      pagination: { page: f.page, limit: TRADE_HISTORY_PAGE_SIZE, total: 0, pages: 0 },
    };
  }
  const page = await fetchUnifiedHistory(query);
  return { items: page.items, summary: page.summary, pagination: page.pagination };
};
