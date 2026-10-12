import { useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { wsClient } from '../services/ws';
import { fmtNum } from '../utils/format';
import AssetIcon from '../components/AssetIcon';
import DateFilter from '../components/DateFilter';
import { useAuthStore } from '../store/auth';

import { ticketShort } from '../utils/ticket';

/**
 * Trade History — every record an account has finished with, in one list:
 * closed positions, plus the orders that were cancelled or rejected and so
 * never became positions. Filters, pagination, summary stats, CSV download.
 *
 * Closed trades are POSITIONS; cancelled and rejected are ORDERS — a
 * different collection. Merging them in the client could not work, because
 * page 2 of each list is not page 2 of the merge, so /trading/history unions
 * and pages them server-side and projects orders into the position shape.
 *
 * Data shape from /trading/history:
 *   { items: Row[], summary: {...}, pagination: {...} }
 *
 * A Row carries `kind` (TRADE | ORDER) and `status` (CLOSED | CANCELLED |
 * REJECTED). Fields an order cannot have — close price, commission, P/L —
 * are null, never 0.
 */

// One Status control covering both kinds of record this page lists.
//
// A value is EITHER a record type (lowercase) OR a close reason (uppercase,
// matching the backend whitelist). They share a dropdown because they were
// never independent: a close reason belongs to a trade that opened, so
// pairing one with "Cancelled" could only ever return nothing. Keeping them
// in one control makes that contradiction unrepresentable.
//
// `group` drives the <optgroup> headings, so the two kinds stay legible
// without becoming two inputs.
const TRADE_GROUP = 'Closed trades';
const ORDER_GROUP = 'Never opened';
const STATUS_OPTIONS = [
  { value: '',                 label: 'All records' },
  { value: 'closed',           label: 'Any close reason',        group: TRADE_GROUP },
  { value: 'MANUAL',           label: 'Manual close',            group: TRADE_GROUP },
  { value: 'ADMIN',            label: 'Closed by admin',         group: TRADE_GROUP },
  { value: 'TAKE_PROFIT',      label: 'Take Profit',             group: TRADE_GROUP },
  { value: 'STOP_LOSS',        label: 'Stop Loss',               group: TRADE_GROUP },
  { value: 'TRAILING_STOP',    label: 'Trailing Stop',           group: TRADE_GROUP },
  // Both spellings — the engine writes STOP_OUT, so a filter offering only
  // MARGIN_STOPOUT could never find a real liquidation.
  { value: 'STOP_OUT',         label: 'Stop-out',                group: TRADE_GROUP },
  { value: 'MARGIN_STOPOUT',   label: 'Margin Stop-out (legacy)', group: TRADE_GROUP },
  { value: 'NEGATIVE_BALANCE', label: 'Neg-balance Protection',  group: TRADE_GROUP },
  { value: 'cancelled',        label: 'Cancelled orders',        group: ORDER_GROUP },
  { value: 'rejected',         label: 'Rejected orders',         group: ORDER_GROUP },
];
const STATUS_GROUPS = [TRADE_GROUP, ORDER_GROUP];

// Which values name a record set rather than a close reason. Anything else
// is a reason, and a reason means closed trades.
const RECORD_TYPES = new Set(['closed', 'cancelled', 'rejected']);

/**
 * The history table: closed trades, cancelled and rejected orders together.
 *
 * The server hands both kinds over in the position shape, so one set of
 * columns draws all three. Where a kind has no value — a cancelled order has
 * no close price, no commission, no P/L — the cell is an em dash. Never 0: a
 * zero in the P/L column reads as "broke even", which is a different claim
 * from "never opened".
 *
 * REMARKS carries whichever reason the row has — how a trade closed, or why an
 * order was refused. Both answer "why is this here?", which is what makes one
 * column honest rather than two things forced together.
 */
function HistoryTable({ items, loading }) {
  const none = <span className="text-text-muted">—</span>;
  return (
    <table className="w-full text-sm whitespace-nowrap">
      <thead className="text-xs text-gray-500 uppercase tracking-wider border-b border-border-dark">
        <tr>
          <th className="text-left px-4 py-3 font-normal">Order Id</th>
          <th className="text-left px-4 py-3 font-normal">Symbol</th>
          <th className="text-left px-4 py-3 font-normal">Side</th>
          <th className="text-left px-4 py-3 font-normal">Status</th>
          <th className="text-right px-4 py-3 font-normal">Size</th>
          <th className="text-right px-4 py-3 font-normal">Open Price</th>
          <th className="text-right px-4 py-3 font-normal">Close Price</th>
          <th className="text-right px-4 py-3 font-normal">Commission</th>
          <th className="text-right px-4 py-3 font-normal">Charge</th>
          <th className="text-center px-4 py-3 font-normal">Executed By</th>
          <th className="text-left px-4 py-3 font-normal">Remarks</th>
          <th className="text-left px-4 py-3 font-normal">Opened At</th>
          <th className="text-left px-4 py-3 font-normal">Closed At</th>
          <th className="text-right px-4 py-3 font-normal">P/L</th>
        </tr>
      </thead>
      <tbody className={loading ? 'opacity-50 transition-opacity' : 'transition-opacity'}>
        {items.map((p) => {
          const isTrade = p.kind !== 'ORDER';
          const pnl = Number(p.realizedPnl || 0);
          const remark = isTrade ? remarkText(p.closeReason) : orderRemark(p);
          return (
            <tr key={`${p.kind || 'TRADE'}-${p._id}`} className="border-b border-border-subtle hover:bg-bg-hover transition-colors">
              <td className="px-4 py-3 font-mono text-gray-300" title={p._id}>{ticketShort(p._id)}</td>
              <td className="px-4 py-3 font-bold text-white">
                <div className="flex items-center gap-2">
                  <AssetIcon symbol={p.symbol} size={20} round />
                  <span>{p.symbol}</span>
                </div>
              </td>
              <td className="px-4 py-3"><SidePill side={p.side} /></td>
              <td className="px-4 py-3"><RecordStatusPill status={p.status} /></td>
              <td className="px-4 py-3 text-right font-mono">{fmtLot(Number(p.closedQuantity) > 0 ? p.closedQuantity : p.quantity)}</td>
              <td className="px-4 py-3 text-right font-mono">
                {p.entryPrice ? fmtNum(p.entryPrice, 5) : none}
              </td>
              <td className="px-4 py-3 text-right font-mono">
                {p.closePrice ? fmtNum(p.closePrice, 5) : none}
              </td>
              <td className="px-4 py-3 text-right font-mono text-gray-400">
                {isTrade ? fmtNum(p.commission || '0', 2) : none}
              </td>
              <td className="px-4 py-3 text-right font-mono text-gray-400">
                {isTrade ? fmtNum(p.swap || '0', 2) : none}
              </td>
              <td className="px-4 py-3 text-center">
                {isTrade ? <ExecutedByPill reason={p.closeReason} /> : none}
              </td>
              <td className={`px-4 py-3 max-w-[220px] truncate ${p.status === 'REJECTED' ? 'text-bear' : 'text-gray-400'}`} title={remark}>
                {remark}
              </td>
              <td className="px-4 py-3 text-gray-400 font-mono text-xs">
                {formatDateTime(p.openedAt || p.createdAt)}
              </td>
              <td className="px-4 py-3 text-gray-400 font-mono text-xs">
                {formatDateTime(p.closedAt)}
              </td>
              <td className={`px-4 py-3 text-right font-mono font-semibold ${!isTrade ? '' : pnl >= 0 ? 'text-bull' : 'text-bear'}`}>
                {isTrade ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}` : none}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * What to show in REMARKS for an order that never became a position.
 *
 * A rejection's reason is the whole point of the row, so it wins. A blank one
 * says so rather than being filled with a guess: it means nothing recorded a
 * reason, which is itself worth knowing.
 */
function orderRemark(o) {
  if (o.rejectionReason) return o.rejectionReason;
  if (o.status === 'REJECTED') return 'REJECTED — no reason recorded';
  return 'CANCELLED — order withdrawn';
}

function RecordStatusPill({ status }) {
  const tone = status === 'REJECTED'
    ? 'bg-bear/15 text-bear border-bear/40'
    : status === 'CANCELLED'
      ? 'bg-text-muted/15 text-text-secondary border-border-dark'
      : 'bg-bull/15 text-bull border-bull/40';
  return (
    <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${tone}`}>
      {status || 'CLOSED'}
    </span>
  );
}

export default function Orders() {
  const user = useAuthStore((s) => s.user);
  const [accounts, setAccounts] = useState([]);
  // Account ID picker — 'all' is a sentinel meaning "across every
  // account that matches the current TYPE filter".
  const [selectedAccountId, setSelectedAccountId] = useState('all');
  // TYPE filter — 'all' / 'DEMO' / 'REAL' (where REAL == any tier code
  // that isn't DEMO/VIRTUAL). Drives both which accounts appear in the
  // ID dropdown and which IDs we send to the backend.
  const [typeFilter, setTypeFilter] = useState('all');
  // Which record set to show. Closed trades are POSITIONS; cancelled and
  // rejected are ORDERS that never became one — a different collection, which
  // is why no value of the closeReason dropdown could ever surface them.

  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState({ totalTrades: 0, totalLot: 0, netPnl: 0, wins: 0, losses: 0 });
  const [pagination, setPagination] = useState({ page: 1, limit: 30, total: 0, pages: 0 });
  const [loading, setLoading] = useState(true);

  // Filter state
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [symbolFilter, setSymbolFilter] = useState('');
  const [sideFilter, setSideFilter] = useState('');
  // The single Status control: a record type OR a close reason (see
  // STATUS_OPTIONS). Both of the things the server wants are derived from
  // it rather than stored alongside, so they cannot drift apart.
  const [statusFilter, setStatusFilter] = useState('');
  const view = RECORD_TYPES.has(statusFilter)
    ? statusFilter
    : (statusFilter ? 'closed' : 'all'); // a close reason implies closed trades
  const closeReasonFilter = RECORD_TYPES.has(statusFilter) ? '' : statusFilter;
  // Date range via the global DateFilter (defaults to all-time / no preset
  // so existing behaviour is preserved until the admin picks a range).
  const [range, setRange] = useState({ period: null, fromDate: '', toDate: '' });
  const fromDate = range.fromDate;
  const toDate = range.toDate;
  const [page, setPage] = useState(1);

  // Load accounts once.
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/user/accounts');
        setAccounts(data.data);
      } catch (_) { /* ignore */ }
    })();
  }, []);

  // Accounts narrowed by the TYPE filter (used by the ID dropdown).
  const filteredAccounts = useMemo(() => {
    if (typeFilter === 'all')  return accounts;
    if (typeFilter === 'DEMO') return accounts.filter((a) => a.accountType === 'DEMO' || a.accountType === 'VIRTUAL');
    if (typeFilter === 'REAL') return accounts.filter((a) => a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL');
    return accounts;
  }, [accounts, typeFilter]);

  // If the currently-selected ID drops out of the filtered list, snap
  // back to "all" so the dropdown stays valid.
  useEffect(() => {
    if (selectedAccountId === 'all') return;
    if (!filteredAccounts.some((a) => a._id === selectedAccountId)) {
      setSelectedAccountId('all');
    }
  }, [filteredAccounts, selectedAccountId]);

  // Live: bump a tick when a position/order closes or fills anywhere (SL/TP,
  // another device, the terminal) so a just-closed trade shows up in history
  // without a manual refresh. The server publishes user-scoped channels.
  const [refreshTick, setRefreshTick] = useState(0);
  useEffect(() => {
    const bump = () => setRefreshTick((t) => t + 1);
    const u1 = wsClient.subscribe('user:positions', bump);
    const u2 = wsClient.subscribe('user:orders', bump);
    return () => { u1 && u1(); u2 && u2(); };
  }, []);

  // Reload history whenever filters change.
  useEffect(() => {
    if (!accounts.length) return;
    (async () => {
      setLoading(true);
      try {
        // Build the backend filter. Specific account → single ID. "All"
        // either omits accountId (server uses all user accounts) or sends
        // a CSV list of the TYPE-filtered accounts when a TYPE is active.
        const params = {
          symbol: symbolFilter || undefined,
          side: sideFilter || undefined,
          closeReason: closeReasonFilter || undefined,
          from: fromDate || undefined,
          to: toDate || undefined,
          page,
          limit: 30,
        };
        if (selectedAccountId !== 'all') {
          params.accountId = selectedAccountId;
        } else if (typeFilter !== 'all') {
          // Server takes one accountId; we fan out by sending each in
          // sequence then merging is overkill. Cheaper compromise: when
          // a TYPE filter is on but ID is "all", just hit the API once
          // per account in the filtered set in parallel.
          params.accountIds = filteredAccounts.map((a) => a._id).join(',');
        }
        // One list across both collections. The server unions and pages them
        // together — merging two paginated endpoints here could not work,
        // because page 2 of each is not page 2 of the merge.
        const { data } = await api.get('/trading/history', {
          params: { ...params, recordType: view },
        });
        setItems(data.data?.items ?? []);
        setPagination(data.data?.pagination ?? { page: 1, limit: 30, total: 0, pages: 0 });
        // The stat cards are TRADE figures — lots, wins, net P/L. The server
        // computes them over the closed rows only, so a list that also holds
        // cancelled orders does not inflate them.
        setSummary(data.data?.summary ?? { totalTrades: 0, totalLot: 0, netPnl: 0, wins: 0, losses: 0 });
      } finally {
        setLoading(false);
      }
    })();
  }, [selectedAccountId, typeFilter, filteredAccounts, accounts.length, symbolFilter, sideFilter, statusFilter, fromDate, toDate, page, refreshTick]);

  const account = useMemo(
    () => accounts.find((a) => a._id === selectedAccountId),
    [accounts, selectedAccountId]
  );

  const downloadReport = () => {
    if (!items.length) return;

    // CSV-quote helper — wraps in quotes and escapes embedded quotes.
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const row = (cells) => cells.map(q).join(',');

    // Header block at the top of the CSV — report metadata + user
    // identification. Sits above the data table separated by a blank
    // line so spreadsheet apps render it as a banner section.
    const downloadedAt = new Date();
    const userName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || '—';
    const accountLabel = selectedAccountId === 'all'
      ? `All accounts (${filteredAccounts.length})`
      : (account?.accountNumber || selectedAccountId);
    const typeLabel = typeFilter === 'all' ? 'All' : typeFilter;

    const metaLines = [
      row(['Trade History Report']),
      row([]),
      row(['Generated at',  downloadedAt.toLocaleString()]),
      row(['Generated by',  userName]),
      row(['Email',         user?.email || '—']),
      row(['Phone',         user?.phone || user?.mobile || '—']),
      row(['Account',       accountLabel]),
      row(['Account type',  typeLabel]),
      row(['Date range',    fromDate || toDate ? `${fromDate || '—'} → ${toDate || '—'}` : 'All time']),
      row(['Symbol filter', symbolFilter || 'Any']),
      row(['Side filter',   sideFilter || 'Any']),
      row(['Status filter', STATUS_OPTIONS.find((o) => o.value === statusFilter)?.label || 'All records']),
      row(['Rows in file',  items.length]),
      row([]),
    ];

    const headers = [
      'Order ID', 'Symbol', 'Side', 'Status', 'Size', 'Open Price', 'Close Price',
      'Commission', 'Charge', 'Executed By', 'Remarks', 'Opened At', 'Closed At', 'P/L',
    ];
    // Order rows leave the trade-only cells EMPTY rather than writing 0.
    // A spreadsheet sums a column of zeros without complaint, so a 0 here
    // would quietly fold orders that never opened into a commission or P/L
    // total. Blank keeps them out of it.
    const dataRows = items.map((p) => {
      const isTrade = p.kind !== 'ORDER';
      return [
        ticketShort(p._id),
        p.symbol,
        p.side,
        p.status || 'CLOSED',
        Number(p.closedQuantity) > 0 ? p.closedQuantity : p.quantity,
        p.entryPrice || '',
        p.closePrice || '',
        isTrade ? (p.commission || '0') : '',
        isTrade ? (p.swap || '0') : '',
        isTrade ? (p.closeReason === 'ADMIN' ? 'ADMIN' : 'SELF') : '',
        isTrade ? remarkText(p.closeReason) : orderRemark(p),
        formatDateTime(p.openedAt || p.createdAt),
        formatDateTime(p.closedAt),
        isTrade ? p.realizedPnl : '',
      ];
    });

    const csv = [
      ...metaLines,
      row(headers),
      ...dataRows.map(row),
    ].join('\n');

    // Filename uses ISO timestamp (YYYY-MM-DDTHH-mm) so files sort chronologically.
    const tsLabel = downloadedAt.toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const fileTag = selectedAccountId === 'all' ? 'all-accounts' : (account?.accountNumber || selectedAccountId);
    const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' }); // BOM for Excel
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trade-history_${fileTag}_${tsLabel}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const clearFilters = () => {
    setSymbolFilter('');
    setSideFilter('');
    setStatusFilter('');
    setRange({ period: null, fromDate: '', toDate: '' });
    setPage(1);
  };

  return (
    <div className="space-y-4 max-w-[1600px]">
      {/* Header bar — title + account chip + filters + download */}
      <div className="card p-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <span className="w-1 h-6 bg-primary-500 rounded-full" />
          <h1 className="text-xl font-bold text-text-primary tracking-wide">
            TRADE HISTORY <span className="text-text-muted font-normal">({pagination.total})</span>
          </h1>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Account chip — ID and TYPE both selectable; "All" sentinel
              for either side aggregates across accounts. */}
          <div className="border border-border-dark rounded px-3 py-1.5 text-xs flex items-center gap-3">
            <span className="text-primary-500 font-medium">Selected Account</span>
            <span className="text-gray-600">|</span>
            <span className="text-gray-400">ID:</span>
            <select
              value={selectedAccountId}
              onChange={(e) => { setSelectedAccountId(e.target.value); setPage(1); }}
              className="bg-white text-text-primary font-mono text-xs focus:outline-none border border-border-subtle rounded px-1 py-0.5"
            >
              <option value="all">All accounts</option>
              {filteredAccounts.map((a) => (
                <option key={a._id} value={a._id}>
                  {a.accountNumber}
                </option>
              ))}
            </select>
            <span className="text-gray-600">|</span>
            <span className="text-gray-400">TYPE:</span>
            <select
              value={typeFilter}
              onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
              className="bg-bg-hover text-primary-500 font-bold text-[10px] focus:outline-none border border-border-subtle rounded px-2 py-0.5"
            >
              <option value="all">ALL</option>
              <option value="REAL">REAL</option>
              <option value="DEMO">DEMO</option>
            </select>
          </div>

          {/* Filters toggle */}
          <button
            onClick={() => setFiltersOpen((o) => !o)}
            className="btn-ghost flex items-center gap-1.5 text-sm"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
            </svg>
            Filters
          </button>

          {/* Download */}
          <button
            onClick={downloadReport}
            disabled={!items.length}
            className="border border-border-dark rounded px-3 py-1.5 text-sm text-text-primary hover:bg-bg-hover disabled:opacity-40 inline-flex items-center gap-1.5"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download Report
          </button>
        </div>
      </div>

      {/* Filters panel */}
      {filtersOpen && (
        <div className="card p-4 grid grid-cols-1 md:grid-cols-6 gap-3">
          <div>
            <label className="label">Symbol</label>
            <input
              type="text"
              value={symbolFilter}
              onChange={(e) => { setSymbolFilter(e.target.value.toUpperCase()); setPage(1); }}
              placeholder="e.g. XAUUSD"
              className="input text-xs"
            />
          </div>
          <div>
            <label className="label">Side</label>
            <select
              value={sideFilter}
              onChange={(e) => { setSideFilter(e.target.value); setPage(1); }}
              className="input text-xs"
            >
              <option value="">All</option>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
          </div>
          <div>
            {/* Record type and close reason in one control — see STATUS_OPTIONS
                for why they are not two. */}
            <label className="label">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
              className="input text-xs"
            >
              {STATUS_OPTIONS.filter((o) => !o.group).map((o) => (
                <option key={o.value || 'all'} value={o.value}>{o.label}</option>
              ))}
              {STATUS_GROUPS.map((g) => (
                <optgroup key={g} label={g}>
                  {STATUS_OPTIONS.filter((o) => o.group === g).map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="label">Date range</label>
            <DateFilter value={range} onChange={(r) => { setRange(r); setPage(1); }} />
          </div>
          <div className="flex items-end">
            <button onClick={clearFilters} className="btn-ghost w-full text-xs">Clear</button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="card overflow-x-auto">
        {loading ? (
          <div className="text-gray-500 text-sm py-12 text-center">Loading trade history…</div>
        ) : !items.length ? (
          <div className="text-gray-500 text-sm py-12 text-center">
            {/* "Nothing matched" and "nothing exists" are different answers, and
                only the second is worth reassurance. A close reason narrows to a
                subset, so it gets the first. */}
            {closeReasonFilter
              ? `No closed trades matched ${STATUS_OPTIONS.find((o) => o.value === closeReasonFilter)?.label || 'that status'}.`
              : view === 'all' ? 'Nothing here yet — closed trades, cancelled and rejected orders all appear in this list.'
              : view === 'closed' ? 'No closed trades yet'
              : view === 'rejected' ? 'No rejected orders — nothing has been refused on this account.'
              : 'No cancelled orders.'}
          </div>
        ) : (
          <HistoryTable items={items} loading={loading} />
        )}
      </div>

      {/* Pagination footer + count */}
      <div className="flex items-center justify-between text-xs text-gray-400 px-2">
        <span>
          Showing {items.length} of {pagination.total} {view === 'closed' ? 'trades' : view === 'all' ? 'records' : 'orders'}
        </span>
        {pagination.pages > 1 && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="btn-ghost text-xs px-2 disabled:opacity-30"
            >
              ◀ Prev
            </button>
            <span>{page} / {pagination.pages}</span>
            <button
              onClick={() => setPage((p) => Math.min(pagination.pages, p + 1))}
              disabled={page >= pagination.pages}
              className="btn-ghost text-xs px-2 disabled:opacity-30"
            >
              Next ▶
            </button>
          </div>
        )}
      </div>

      {/* Summary stat strip */}
      <div className="flex flex-wrap gap-3">
        <StatCard label="Total Trades" value={summary.totalTrades.toFixed(2)} />
        <StatCard label="Total Lot" value={Number(summary.totalLot).toFixed(2)} />
        <StatCard label="Loaded Wins" value={summary.wins.toFixed(2)} positive />
        <StatCard label="Loaded Losses" value={summary.losses.toFixed(2)} negative />
        <div className="flex-1" />
        <StatCard
          label="Net P/L"
          value={`${summary.netPnl >= 0 ? '+' : ''}${Number(summary.netPnl).toFixed(2)}`}
          positive={summary.netPnl > 0}
          negative={summary.netPnl < 0}
          highlight
        />
      </div>
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

// shortId() used to live here: it turned the last 8 hex characters of the
// position id into a decimal number ("694807545"), a rendering used on no other
// screen. Trade History now shows the same #XXXXXX ticket as the trade screen,
// the admin panel and the wallet-ledger notes, so one trade is one id.

function fmtLot(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n) || n === 0) return '0.00';
  // Lot sizes can be fractional (e.g. 0.001). Two decimals would collapse
  // any sub-0.01 size to "0.00", so widen precision for small sizes while
  // keeping the usual 2dp for normal ones.
  const abs = Math.abs(n);
  const decimals = abs >= 0.01 ? 2 : abs >= 0.001 ? 3 : abs >= 0.0001 ? 4 : 5;
  return n.toFixed(decimals);
}

function formatDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (n) => String(n).padStart(2, '0');
  const dd = pad(d.getDate());
  const mm = pad(d.getMonth() + 1);
  const yy = d.getFullYear();
  let h = d.getHours();
  const m = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${dd}/${mm}/${yy}, ${pad(h)}:${m}:${s} ${ampm}`;
}

function remarkText(reason) {
  switch (reason) {
    case 'TAKE_PROFIT':       return 'PROFIT TAKEN — Target hit';
    case 'STOP_LOSS':         return 'STOP LOSS HIT';
    case 'TRAILING_STOP':     return 'TRAILING STOP HIT';
    // The engine writes STOP_OUT; older rows carry MARGIN_STOPOUT.
    case 'STOP_OUT':
    case 'MARGIN_STOPOUT':    return 'CLOSED — Stop-out';
    case 'NEGATIVE_BALANCE':  return 'NEG-BALANCE PROTECTION';
    case 'EXPIRY':            return 'CLOSED — Expired';
    case 'INTRADAY_SQUAREOFF': return 'CLOSED — Intraday square-off';
    case 'INSTRUMENT_DISABLED_FORCE_CLOSE': return 'CLOSED — Instrument disabled';
    case 'COPY_MASTER_CLOSED': return 'CLOSED — Master closed';
    case 'MANUAL':            return 'closed by user';
    case 'ADMIN':             return 'closed by admin';
    default:                  return 'N/A';
  }
}

function SidePill({ side }) {
  const isBuy = side === 'BUY';
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold border ${
        isBuy
          ? 'border-bull/40 text-bull bg-bull/10'
          : 'border-bear/40 text-bear bg-bear/10'
      }`}
    >
      {isBuy ? '↗' : '↙'} {side}
    </span>
  );
}

function ExecutedByPill({ reason }) {
  // ADMIN close-reason = an admin/super force-closed this position → show ADMIN.
  // Otherwise the user themselves (no copy-trading yet → swap to MASTER later).
  const admin = reason === 'ADMIN';
  return (
    <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${admin ? 'bg-warn/20 text-warn border-warn/40' : 'bg-info/20 text-info border-info/40'}`}>
      {admin ? 'ADMIN' : 'SELF'}
    </span>
  );
}

function StatCard({ label, value, positive, negative, highlight }) {
  const border =
    highlight && negative ? 'border-bear' :
    highlight && positive ? 'border-bull' :
    'border-border-dark';
  const valueColor =
    positive ? 'text-bull' :
    negative ? 'text-bear' :
    'text-white';
  return (
    <div className={`px-4 py-3 rounded border bg-bg-card ${border} flex items-center gap-3 min-w-[140px]`}>
      <span className="text-[10px] uppercase tracking-wider text-gray-500">{label}</span>
      <span className={`font-mono font-bold ${valueColor}`}>{value}</span>
    </div>
  );
}
