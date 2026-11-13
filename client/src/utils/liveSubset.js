// Which symbols a big list subscribes to for live ticks.
//
// The catalogue now carries the whole NSE cash universe (~3,000 scrips).
// Subscribing to every one floods the socket and re-renders the page on every
// tick, so past `max` rows a page keeps: every non-stock row (indices, MCX),
// the symbols in `always` (open positions, pending orders, the active symbol),
// and the `limit` stocks moving most by |change24h| — what the movers and
// most-active cards show. The rest keep the catalogue's snapshot price, which
// the instrument list refreshes on its own.
export function liveSubset(rows, { always = [], limit = 150, max = 400 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length <= max) return list.map((r) => r.symbol).filter(Boolean);
  const keep = new Set(always.filter(Boolean));
  const stocks = [];
  for (const r of list) {
    if (!r || !r.symbol) continue;
    if (String(r.category || '').toUpperCase() === 'STOCK') stocks.push(r);
    else keep.add(r.symbol);
  }
  stocks.sort((a, b) => Math.abs(Number(b.change24h) || 0) - Math.abs(Number(a.change24h) || 0));
  for (const r of stocks.slice(0, limit)) keep.add(r.symbol);
  return [...keep];
}
