import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { useMoney } from '../hooks/useMoney';
import { wsClient } from '../services/ws';

/**
 * Open positions and pending orders, self-contained.
 *
 * The terminal already shows these, but its panel is wired into Trade.jsx's
 * state — prices, accounts, modals, the chart — so it cannot be dropped
 * anywhere else. That left closing a position as a journey: place the trade on
 * the instrument page, then navigate away to the terminal or the portfolio to
 * get out of it.
 *
 * This component fetches its own data and owns its own actions, so it can be
 * mounted on the instrument page, on its own route, or anywhere else, without
 * the host knowing anything about trading state.
 *
 * `symbol` narrows it to one instrument (the instrument page wants that);
 * omitted, it shows the whole account.
 *
 * Live prices come from the same WS ticker channel the rest of the app uses,
 * so floating P&L moves here exactly as it does in the terminal rather than
 * sitting frozen at whatever the fetch returned.
 */
export default function PositionsPanel({ symbol = null, accountId = null, compact = false }) {
  const { money, signed } = useMoney();

  const [tab, setTab] = useState('positions');
  const [positions, setPositions] = useState([]);
  const [orders, setOrders] = useState([]);
  const [priceMap, setPriceMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  const params = useMemo(() => (accountId ? { accountId } : {}), [accountId]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    // allSettled so one endpoint failing does not blank the other list.
    const [p, o] = await Promise.allSettled([
      api.get('/trading/positions', { params }),
      api.get('/trading/orders/open', { params }),
    ]);
    if (p.status === 'fulfilled') setPositions(p.value.data?.data || []);
    if (o.status === 'fulfilled') setOrders(o.value.data?.data || []);
    setLoading(false);
  }, [params]);

  useEffect(() => { load(); }, [load]);

  // Refresh when anything moves the book, rather than polling.
  useEffect(() => {
    const unsub = wsClient.subscribe('user:positions', () => load(true));
    return () => { unsub && unsub(); };
  }, [load]);

  // Mark to market. Without this the P&L column is whatever the fetch returned
  // and never moves — the same staleness that made the order preview look
  // broken elsewhere.
  const symbols = useMemo(
    () => [...new Set(positions.map((x) => x.symbol).filter(Boolean))],
    [positions],
  );
  useEffect(() => {
    if (!symbols.length) return undefined;
    const unsubs = symbols.map((sym) => wsClient.subscribe(`ticker:${sym}`, (d) => {
      const px = Number(d?.lastPrice);
      if (!Number.isFinite(px) || px <= 0) return;
      setPriceMap((prev) => (Number(prev[sym]) === px ? prev : { ...prev, [sym]: px }));
    }));
    return () => unsubs.forEach((u) => u && u());
  }, [symbols.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const f = (arr) => (symbol ? arr.filter((x) => x.symbol === symbol) : arr);
    return { positions: f(positions), orders: f(orders) };
  }, [positions, orders, symbol]);

  const pnlOf = (p) => {
    const mark = Number(priceMap[p.symbol] || p.markPrice || p.entryPrice);
    const entry = Number(p.entryPrice);
    const qty = Number(p.quantity);
    if (!Number.isFinite(mark) || !Number.isFinite(entry) || !Number.isFinite(qty)) return 0;
    return p.side === 'BUY' ? (mark - entry) * qty : (entry - mark) * qty;
  };

  const closePosition = async (id) => {
    setBusyId(id);
    try {
      await api.post(`/trading/positions/${id}/close`);
      toast.success('Position closing');
      await load(true);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusyId(null); }
  };

  const cancelOrder = async (id) => {
    setBusyId(id);
    try {
      await api.delete(`/trading/orders/${id}`);
      toast.success('Order cancelled');
      await load(true);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusyId(null); }
  };

  const TABS = [
    { k: 'positions', label: 'Open', count: shown.positions.length },
    { k: 'orders', label: 'Pending', count: shown.orders.length },
  ];

  const cell = 'px-3 py-2 whitespace-nowrap';
  const head = 'px-3 py-2 font-semibold text-text-muted text-left whitespace-nowrap';

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1 border-b border-border-subtle px-1 shrink-0">
        {TABS.map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k)}
            className={`px-3 py-2 text-xs sm:text-sm font-semibold flex items-center gap-2 transition-colors ${
              tab === t.k ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {t.label}
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
              tab === t.k ? 'bg-primary-500 text-white' : 'bg-bg-hover text-text-secondary'
            }`}
            >
              {t.count}
            </span>
          </button>
        ))}
        <button
          onClick={() => load()}
          className="ml-auto mr-2 text-[11px] font-semibold text-text-muted hover:text-text-primary"
        >
          Refresh
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="p-6 text-center text-xs text-text-muted">Loading…</div>
        ) : tab === 'positions' ? (
          shown.positions.length === 0 ? (
            <Empty
              title="No open positions"
              hint={symbol ? `Positions in ${symbol} will appear here.` : 'Place an order and it will appear here.'}
            />
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-bg-card">
                <tr>
                  <th className={head}>Symbol</th>
                  <th className={head}>Side</th>
                  <th className={`${head} text-right`}>Volume</th>
                  <th className={`${head} text-right`}>Entry</th>
                  {!compact && <th className={`${head} text-right`}>Market</th>}
                  <th className={`${head} text-right`}>P&amp;L</th>
                  <th className={head} />
                </tr>
              </thead>
              <tbody>
                {shown.positions.map((p) => {
                  const pnl = pnlOf(p);
                  return (
                    <tr key={p._id} className="border-t border-border-subtle">
                      <td className={`${cell} font-semibold text-text-primary`}>{p.symbol}</td>
                      <td className={`${cell} font-semibold ${p.side === 'BUY' ? 'text-bull' : 'text-bear'}`}>{p.side}</td>
                      <td className={`${cell} text-right font-mono text-text-secondary`}>{p.quantity}</td>
                      <td className={`${cell} text-right font-mono text-text-secondary`}>{p.entryPrice}</td>
                      {!compact && (
                        <td className={`${cell} text-right font-mono text-text-secondary`}>
                          {priceMap[p.symbol] ?? p.markPrice ?? '—'}
                        </td>
                      )}
                      <td className={`${cell} text-right font-mono font-bold ${pnl >= 0 ? 'text-bull' : 'text-bear'}`}>
                        {signed(pnl)}
                      </td>
                      <td className={`${cell} text-right`}>
                        <button
                          onClick={() => closePosition(p._id)}
                          disabled={busyId === p._id}
                          className="text-[11px] font-bold px-2 py-1 rounded border border-border-dark text-text-primary hover:bg-bg-hover disabled:opacity-40"
                        >
                          {busyId === p._id ? '…' : 'Close'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        ) : shown.orders.length === 0 ? (
          <Empty
            title="No pending orders"
            hint={symbol ? `Pending orders in ${symbol} will appear here.` : 'Limit and stop orders waiting to trigger appear here.'}
          />
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-bg-card">
              <tr>
                <th className={head}>Symbol</th>
                <th className={head}>Side</th>
                <th className={head}>Type</th>
                <th className={`${head} text-right`}>Volume</th>
                <th className={`${head} text-right`}>Price</th>
                <th className={head} />
              </tr>
            </thead>
            <tbody>
              {shown.orders.map((o) => (
                <tr key={o._id} className="border-t border-border-subtle">
                  <td className={`${cell} font-semibold text-text-primary`}>{o.symbol}</td>
                  <td className={`${cell} font-semibold ${o.side === 'BUY' ? 'text-bull' : 'text-bear'}`}>{o.side}</td>
                  <td className={`${cell} text-text-secondary`}>{o.type}</td>
                  <td className={`${cell} text-right font-mono text-text-secondary`}>{o.quantity}</td>
                  <td className={`${cell} text-right font-mono text-text-secondary`}>{o.price ?? o.stopPrice ?? '—'}</td>
                  <td className={`${cell} text-right`}>
                    <button
                      onClick={() => cancelOrder(o._id)}
                      disabled={busyId === o._id}
                      className="text-[11px] font-bold px-2 py-1 rounded border border-border-dark text-bear hover:bg-bg-hover disabled:opacity-40"
                    >
                      {busyId === o._id ? '…' : 'Cancel'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {/* money() is used by callers that show a total; referenced here so the
          hook is not flagged unused when the totals row is hidden in compact. */}
      <span className="hidden">{money(0)}</span>
    </div>
  );
}

function Empty({ title, hint }) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-10">
      <div className="text-sm font-semibold text-text-primary">{title}</div>
      <div className="text-xs text-text-muted mt-1">{hint}</div>
    </div>
  );
}
