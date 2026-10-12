import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../services/api';
import { wsClient } from '../services/ws';

/**
 * Real-time FLOATING balance for ONE account (the header profile-dropdown chip).
 *
 *   Fixed balance   = settled wallet balance (never moves on open P&L)
 *   Floating balance = Fixed balance + Σ live unrealized P&L      ← what this returns
 *   Free margin      = Floating balance − Used margin
 *
 * Why this exists: the header used to re-fetch /wallet/equity only on position
 * OPEN/CLOSE events (+ a 5s poll while the menu was open), so between events the
 * chip sat frozen and looked like the FIXED balance. This hook keeps the fixed
 * balance + margin from the authoritative /wallet/equity snapshot but recomputes
 * the floating balance CLIENT-SIDE on every `ticker:<symbol>` tick — the same WS
 * price stream the terminal uses — so the chip tracks the market in real time.
 *
 * Uses the EXACT server formula (walletController.getAccountsEquity): equity =
 * balance + Σ (side==='BUY' ? (mark−entry) : (entry−mark)) × qty, summed across
 * the account's open positions. No FX conversion of P&L (matches the server;
 * single-currency accounts are exact).
 *
 * Account-switch safe: keyed on `accountId`, so switching tears down the old
 * account's ticker subscriptions and re-fetches/re-subscribes for the new one —
 * account A's ticks can never bleed into account B's displayed balance.
 *
 * Returns rows in the SAME shape as GET /wallet/equity (so the header's existing
 * FX-sum logic is unchanged), or null while first loading.
 */
export default function useFloatingBalance(accountId) {
  // snapshot: authoritative rows (fixed balance, usedMargin, status, currency)
  // + this account's open positions. Reloaded on wallet/position settle events.
  const [snap, setSnap] = useState(null);
  const pricesRef = useRef(new Map()); // symbol -> latest live price
  const [ver, setVer] = useState(0);   // bumped (throttled) to trigger recompute
  const lastBumpRef = useRef(0);

  // ── Load fixed balance + open positions; refresh on settle events ──────
  useEffect(() => {
    if (!accountId) { setSnap(null); pricesRef.current = new Map(); return; }
    let cancelled = false;
    const load = async () => {
      try {
        const [eqRes, posRes] = await Promise.all([
          api.get('/wallet/equity'),
          api.get('/trading/positions'),
        ]);
        if (cancelled) return;
        const rows = (eqRes.data?.data || []).filter((r) => String(r.accountId) === String(accountId));
        const positions = (posRes.data?.data || []).filter(
          (p) => String(p.accountId) === String(accountId) && (!p.status || p.status === 'OPEN')
        );
        // Seed live prices from each position's server mark so the chip shows the
        // correct floating value immediately, before the first tick arrives.
        const m = new Map();
        for (const p of positions) {
          const px = Number(p.markPrice ?? p.entryPrice);
          if (Number.isFinite(px)) m.set(p.symbol, px);
        }
        pricesRef.current = m;
        setSnap({ rows, positions });
        setVer((v) => v + 1);
      } catch (_) { /* keep last known */ }
    };
    load();
    // Settle events (deposit/withdraw/close/fee) move the FIXED balance + change
    // which positions are open → reload the snapshot.
    const u1 = wsClient.subscribe('user:wallet', load);
    const u2 = wsClient.subscribe('user:positions', load);
    return () => { cancelled = true; u1 && u1(); u2 && u2(); };
  }, [accountId]);

  // ── Subscribe to the held symbols' price ticks; recompute floating live ──
  useEffect(() => {
    if (!snap || !snap.positions.length) return;
    const symbols = [...new Set(snap.positions.map((p) => p.symbol))];
    const unsubs = symbols.map((sym) =>
      wsClient.subscribe(`ticker:${sym}`, (tick) => {
        const px = Number(tick?.lastPrice ?? tick?.price);
        if (!Number.isFinite(px)) return;
        pricesRef.current.set(sym, px);
        // Throttle re-renders to ~5/s (matches the WS flush cadence) — smooth
        // without a render per raw tick.
        const now = Date.now();
        if (now - lastBumpRef.current >= 200) {
          lastBumpRef.current = now;
          setVer((v) => v + 1);
        }
      })
    );
    return () => unsubs.forEach((u) => u && u());
  }, [snap]);

  // ── Compose live rows (fixed balance + live Σ uPnL) ────────────────────
  return useMemo(() => {
    if (!snap) return null;
    let uPnl = 0;
    for (const p of snap.positions) {
      const seeded = pricesRef.current.get(p.symbol);
      const mark = Number.isFinite(seeded) ? seeded : Number(p.markPrice ?? p.entryPrice);
      const entry = Number(p.entryPrice);
      const qty = Number(p.quantity);
      if (!Number.isFinite(mark) || !Number.isFinite(entry) || !Number.isFinite(qty)) continue;
      uPnl += p.side === 'BUY' ? (mark - entry) * qty : (entry - mark) * qty;
    }
    return snap.rows.map((r) => {
      const bal = Number(r.balance) || 0;
      const used = Number(r.usedMargin) || 0;
      const equity = bal + uPnl;              // floating balance
      return {
        ...r,
        unrealizedPnl: String(uPnl),
        equity: String(equity),
        freeMargin: String(equity - used),
        marginLevel: used > 0 ? String((equity / used) * 100) : null,
      };
    });
    // pricesRef is a ref; `ver` is the throttled tick signal that drives recompute
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, ver]);
}
