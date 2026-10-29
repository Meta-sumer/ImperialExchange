import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtNum } from '../utils/format';

/**
 * Manual-trade and trade-edit modals for Orders Management.
 *
 *   ManualTradeModal — book a trade straight into a user's account on any
 *   script at any past date/time, either still open or already closed.
 *   POST /order-management/manual-trade
 *
 *   EditTradeModal — change the facts of an existing trade: entry price, open
 *   time, size, side, leverage, SL/TP, commission, and on a closed trade the
 *   close price/time. Only the fields the admin actually changed are sent, so
 *   an untouched timestamp is never rewritten by the minute-precision picker.
 *   POST /order-management/positions/:id/edit
 *
 * Both end with the backend's wallet effect (margin locked, PnL settled, or a
 * balance adjustment) and an audit row; the user's terminal is nudged over
 * the WebSocket so the trade appears on their chart and history immediately.
 */

// datetime-local wants local wall-clock "YYYY-MM-DDTHH:mm"; the API gets ISO.
const toLocalInput = (d) => {
  if (!d) return '';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
};
const toIso = (local) => (local ? new Date(local).toISOString() : null);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = (n) => `${n < 0 ? '-' : ''}$${fmtNum(Math.abs(n), 2)}`;
const str = (v) => (v == null ? '' : String(v));

function Shell({ title, subtitle, onClose, children, footer }) {
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-bg-card border border-border-dark rounded-xl max-w-2xl w-full max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-border-dark flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-white">{title}</h2>
            {subtitle && <p className="text-xs text-text-muted mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-white text-xl leading-none">✕</button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">{children}</div>
        <div className="px-4 py-3 border-t border-border-dark flex justify-end gap-2">{footer}</div>
      </div>
    </div>
  );
}

function Field({ label, hint, children, className = '' }) {
  return (
    <div className={className}>
      <label className="label">{label}{hint ? <span className="text-text-muted font-normal"> · {hint}</span> : null}</label>
      {children}
    </div>
  );
}

function SideToggle({ value, onChange }) {
  const cls = (on, tone) => `flex-1 py-2 rounded-lg text-sm font-bold border transition-colors ${
    on ? (tone === 'BUY' ? 'bg-bull/20 text-bull border-bull/40' : 'bg-bear/20 text-bear border-bear/40')
       : 'border-border-dark text-text-muted hover:text-white'}`;
  return (
    <div className="flex gap-2">
      <button type="button" className={cls(value === 'BUY', 'BUY')} onClick={() => onChange('BUY')}>BUY</button>
      <button type="button" className={cls(value === 'SELL', 'SELL')} onClick={() => onChange('SELL')}>SELL</button>
    </div>
  );
}

/** Live arithmetic preview — the backend recomputes; this only guides the admin. */
function Preview({ side, quantity, entryPrice, leverage, status, closePrice, commission }) {
  const q = num(quantity), e = num(entryPrice), lev = num(leverage) || 1;
  const margin = q * e / lev;
  const pnl = status === 'CLOSED'
    ? (side === 'BUY' ? num(closePrice) - e : e - num(closePrice)) * q
    : null;
  const net = pnl == null ? null : pnl - num(commission);
  return (
    <div className="rounded-lg border border-border-dark bg-bg-dark/60 px-3 py-2 text-xs flex flex-wrap gap-x-5 gap-y-1">
      <span className="text-text-muted">Notional <b className="text-white">{money(q * e)}</b></span>
      {status === 'OPEN'
        ? <span className="text-text-muted">Margin to lock <b className="text-white">{money(margin)}</b></span>
        : <>
            <span className="text-text-muted">PnL <b className={pnl > 0 ? 'text-bull' : pnl < 0 ? 'text-bear' : 'text-white'}>{money(pnl || 0)}</b></span>
            <span className="text-text-muted">Net to wallet <b className={net > 0 ? 'text-bull' : net < 0 ? 'text-bear' : 'text-white'}>{money(net || 0)}</b></span>
          </>}
    </div>
  );
}

/* ───────────────────────── Manual trade ───────────────────────── */

export function ManualTradeModal({ onClose, onSaved }) {
  const [userQ, setUserQ] = useState('');
  const [userHits, setUserHits] = useState([]);
  const [user, setUser] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [instruments, setInstruments] = useState([]);
  const [instQ, setInstQ] = useState('');
  const [instrument, setInstrument] = useState(null);
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({
    accountId: '', side: 'BUY', quantity: '', entryPrice: '',
    openedAt: toLocalInput(new Date()), status: 'CLOSED', closePrice: '', closedAt: toLocalInput(new Date()),
    leverage: '', stopLoss: '', takeProfit: '', commission: '0', note: '',
  });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  // User search — debounced, min 2 chars.
  useEffect(() => {
    if (user || userQ.trim().length < 2) { setUserHits([]); return undefined; }
    let on = true;
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get('/admin/users', { params: { search: userQ.trim(), limit: 10 } });
        if (on) setUserHits(data.data?.users || []);
      } catch (_) { /* ignore while typing */ }
    }, 250);
    return () => { on = false; clearTimeout(t); };
  }, [userQ, user]);

  // Accounts of the chosen user; the first one is selected by default.
  useEffect(() => {
    if (!user) { setAccounts([]); set('accountId', ''); return undefined; }
    let on = true;
    (async () => {
      try {
        const { data } = await api.get(`/admin/accounts/users/${user._id}/accounts`);
        const list = data.data || [];
        if (!on) return;
        setAccounts(list);
        if (list[0]) { set('accountId', String(list[0]._id)); set('leverage', str(list[0].leverage || '')); }
      } catch (e) { toast.error(errorMessage(e)); }
    })();
    return () => { on = false; };
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every instrument (active or not) once — the admin may book on any script.
  useEffect(() => {
    let on = true;
    api.get('/instruments', { params: { includeInactive: 'true' } })
      .then((r) => { if (on) setInstruments(Array.isArray(r.data.data) ? r.data.data : (r.data.data?.items || [])); })
      .catch(() => {});
    return () => { on = false; };
  }, []);

  const instHits = useMemo(() => {
    const q = instQ.trim().toUpperCase();
    if (!q || instrument) return [];
    const starts = [], contains = [];
    for (const i of instruments) {
      const sym = String(i.symbol || '').toUpperCase(); const name = String(i.name || '').toUpperCase();
      if (sym.startsWith(q)) starts.push(i);
      else if (sym.includes(q) || name.includes(q)) contains.push(i);
      if (starts.length >= 8) break;
    }
    return [...starts, ...contains].slice(0, 8);
  }, [instQ, instruments, instrument]);

  const account = accounts.find((a) => String(a._id) === f.accountId);
  const canSave = user && f.accountId && instrument && num(f.quantity) > 0 && num(f.entryPrice) > 0 && f.openedAt
    && (f.status === 'OPEN' || (num(f.closePrice) > 0 && f.closedAt));

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const body = {
        userId: user._id, accountId: f.accountId, symbol: instrument.symbol, side: f.side,
        quantity: f.quantity, entryPrice: f.entryPrice, openedAt: toIso(f.openedAt), status: f.status,
        leverage: f.leverage === '' ? undefined : f.leverage,
        stopLoss: f.stopLoss === '' ? undefined : f.stopLoss,
        takeProfit: f.takeProfit === '' ? undefined : f.takeProfit,
        commission: f.commission === '' ? '0' : f.commission,
        note: f.note,
      };
      if (f.status === 'CLOSED') { body.closePrice = f.closePrice; body.closedAt = toIso(f.closedAt); }
      await api.post('/order-management/manual-trade', body);
      toast.success(`${f.status === 'OPEN' ? 'Open' : 'Closed'} trade booked for ${user.email}`);
      onSaved();
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };

  return (
    <Shell title="Add Manual Trade" subtitle="Books a trade into the user's account at the date/time you choose. Open trades lock margin; closed trades settle PnL to the wallet." onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
        <button onClick={save} disabled={saving || !canSave} className="btn-primary text-sm disabled:opacity-40">{saving ? 'Booking…' : 'Book Trade'}</button>
      </>}>
      {/* User */}
      <Field label="User" hint="email, name or UID">
        {user ? (
          <div className="input flex items-center justify-between gap-2">
            <span className="truncate"><b className="text-white">{[user.firstName, user.lastName].filter(Boolean).join(' ') || user.email}</b> <span className="text-text-muted">· {user.email}{user.userUid ? ` · ${user.userUid}` : ''}</span></span>
            <button type="button" className="text-xs text-text-muted hover:text-white" onClick={() => { setUser(null); setUserQ(''); setInstrumentDefaults(); }}>change</button>
          </div>
        ) : (
          <div className="relative">
            <input className="input" value={userQ} onChange={(e) => setUserQ(e.target.value)} placeholder="Type at least 2 characters…" autoFocus />
            {userHits.length > 0 && (
              <div className="absolute z-20 left-0 right-0 mt-1 bg-bg-card border border-border-dark rounded-lg shadow-xl max-h-56 overflow-y-auto">
                {userHits.map((u) => (
                  <button key={u._id} type="button" onClick={() => { setUser(u); setUserHits([]); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-bg-hover flex items-center justify-between gap-2">
                    <span className="truncate"><b className="text-white">{[u.firstName, u.lastName].filter(Boolean).join(' ') || '—'}</b> <span className="text-text-muted">· {u.email}</span></span>
                    <span className="font-mono text-[11px] text-text-muted">{u.userUid || ''}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Field>

      {/* Account */}
      <Field label="Trading account">
        <select className="input" value={f.accountId} disabled={!user} onChange={(e) => { set('accountId', e.target.value); const a = accounts.find((x) => String(x._id) === e.target.value); if (a?.leverage) set('leverage', str(a.leverage)); }}>
          {!accounts.length && <option value="">{user ? 'No accounts' : 'Pick a user first'}</option>}
          {accounts.map((a) => (
            <option key={a._id} value={a._id}>{a.accountNumber} · {a.accountType} · bal {money(num(a.balance))} · {a.baseCurrency || 'USD'}</option>
          ))}
        </select>
      </Field>

      {/* Instrument */}
      <Field label="Script / instrument" hint="any symbol, active or not">
        {instrument ? (
          <div className="input flex items-center justify-between gap-2">
            <span className="truncate"><b className="text-white">{instrument.symbol}</b> <span className="text-text-muted">· {instrument.name}{instrument.exchange ? ` · ${instrument.exchange}` : ''}{instrument.lastPrice ? ` · last ${fmtNum(instrument.lastPrice, 2)}` : ''}</span></span>
            <button type="button" className="text-xs text-text-muted hover:text-white" onClick={() => { setInstrument(null); setInstQ(''); }}>change</button>
          </div>
        ) : (
          <div className="relative">
            <input className="input" value={instQ} onChange={(e) => setInstQ(e.target.value)} placeholder="e.g. RELIANCE, NIFTY…" />
            {instHits.length > 0 && (
              <div className="absolute z-20 left-0 right-0 mt-1 bg-bg-card border border-border-dark rounded-lg shadow-xl max-h-56 overflow-y-auto">
                {instHits.map((i) => (
                  <button key={i.symbol} type="button" onClick={() => { setInstrument(i); setInstQ(i.symbol); if (!f.entryPrice && i.lastPrice) set('entryPrice', str(i.lastPrice)); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-bg-hover flex items-center justify-between gap-2">
                    <span className="truncate"><b className="text-white">{i.symbol}</b> <span className="text-text-muted">· {i.name}</span></span>
                    <span className="text-[11px] text-text-muted">{i.exchange || i.category}{i.isActive === false ? ' · inactive' : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Side"><SideToggle value={f.side} onChange={(v) => set('side', v)} /></Field>
        <Field label="Status">
          <select className="input" value={f.status} onChange={(e) => set('status', e.target.value)}>
            <option value="CLOSED">Closed (history only, PnL settled)</option>
            <option value="OPEN">Open (live position, margin locked)</option>
          </select>
        </Field>
        <Field label="Quantity"><input className="input" value={f.quantity} onChange={(e) => set('quantity', e.target.value)} placeholder="e.g. 10" /></Field>
        <Field label="Entry price"><input className="input" value={f.entryPrice} onChange={(e) => set('entryPrice', e.target.value)} placeholder="e.g. 2948.40" /></Field>
        <Field label="Open date & time" hint="past, local time"><input type="datetime-local" className="input" value={f.openedAt} max={toLocalInput(new Date())} onChange={(e) => set('openedAt', e.target.value)} /></Field>
        <Field label="Leverage" hint={account ? `account default ${account.leverage || 1}×` : ''}><input className="input" value={f.leverage} onChange={(e) => set('leverage', e.target.value)} placeholder="1" /></Field>
        {f.status === 'CLOSED' && <>
          <Field label="Close price"><input className="input" value={f.closePrice} onChange={(e) => set('closePrice', e.target.value)} placeholder="e.g. 2970.10" /></Field>
          <Field label="Close date & time" hint="after open, not in the future"><input type="datetime-local" className="input" value={f.closedAt} min={f.openedAt || undefined} max={toLocalInput(new Date())} onChange={(e) => set('closedAt', e.target.value)} /></Field>
        </>}
        <Field label="Stop loss" hint="optional"><input className="input" value={f.stopLoss} onChange={(e) => set('stopLoss', e.target.value)} placeholder="blank = none" /></Field>
        <Field label="Take profit" hint="optional"><input className="input" value={f.takeProfit} onChange={(e) => set('takeProfit', e.target.value)} placeholder="blank = none" /></Field>
        <Field label="Commission" hint="deducted from PnL"><input className="input" value={f.commission} onChange={(e) => set('commission', e.target.value)} placeholder="0" /></Field>
        <Field label="Internal note" hint="audit trail only"><input className="input" value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="why this trade is being booked" /></Field>
      </div>

      <Preview side={f.side} quantity={f.quantity} entryPrice={f.entryPrice} leverage={f.leverage || account?.leverage || 1} status={f.status} closePrice={f.closePrice} commission={f.commission} />
    </Shell>
  );

  // Reset the instrument-dependent defaults when the admin changes user — the
  // price they typed for one account is rarely right for another.
  function setInstrumentDefaults() { setAccounts([]); set('accountId', ''); }
}

/* ───────────────────────── Edit trade ───────────────────────── */

export function EditTradeModal({ row, onClose, onSaved }) {
  const [loading, setLoading] = useState(true);
  const [pos, setPos] = useState(null);
  const [init, setInit] = useState(null);
  const [f, setF] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  // Load the raw position so every editable field (leverage, SL/TP, closed
  // size…) is prefilled exactly — the list rows only carry a display subset.
  useEffect(() => {
    let on = true;
    (async () => {
      try {
        const { data } = await api.get(`/order-management/detail/position/${row._id}`);
        const p = data.data?.position;
        if (!on || !p) return;
        const closed = p.status === 'CLOSED';
        const form = {
          side: p.side,
          quantity: closed ? (num(p.closedQuantity) > 0 ? str(p.closedQuantity) : str(p.quantity)) : str(p.quantity),
          entryPrice: str(p.entryPrice), openedAt: toLocalInput(p.openedAt),
          leverage: str(p.leverage ?? ''), stopLoss: str(p.stopLoss ?? ''), takeProfit: str(p.takeProfit ?? ''),
          commission: str(p.commission ?? '0'),
          closePrice: closed ? str(p.closePrice ?? '') : '', closedAt: closed ? toLocalInput(p.closedAt) : '',
        };
        setPos(p); setInit(form); setF(form);
      } catch (e) { toast.error(errorMessage(e)); onClose(); }
      finally { if (on) setLoading(false); }
    })();
    return () => { on = false; };
  }, [row._id]); // eslint-disable-line react-hooks/exhaustive-deps

  const closed = pos?.status === 'CLOSED';
  const changed = useMemo(() => {
    if (!f || !init) return {};
    const out = {};
    for (const k of Object.keys(f)) if (f[k] !== init[k]) out[k] = f[k];
    return out;
  }, [f, init]);
  const dirty = Object.keys(changed).length > 0;

  const save = async () => {
    if (!dirty) { toast('No changes to save'); return; }
    setSaving(true);
    try {
      const body = {};
      for (const [k, v] of Object.entries(changed)) {
        if (k === 'openedAt' || k === 'closedAt') body[k] = toIso(v);
        else if (k === 'stopLoss' || k === 'takeProfit') body[k] = v === '' ? null : v;
        else body[k] = v;
      }
      const { data } = await api.post(`/order-management/positions/${row._id}/edit`, body);
      const w = data.data?.wallet;
      const effect = w && w.effect !== 'NONE' ? ` · wallet ${w.effect.toLowerCase().replace('_', ' ')} ${money(num(w.amount))}` : '';
      toast.success(`Trade ${row.symbol} updated${effect}`);
      onSaved();
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };

  return (
    <Shell title={`Edit Trade · ${row.symbol}`} subtitle={closed
        ? 'Changing price, size or side recomputes realized PnL; the wallet balance moves by the difference (audited).'
        : 'Changing size, price or leverage adjusts the locked margin on the wallet (audited).'}
      onClose={onClose}
      footer={<>
        <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
        <button onClick={save} disabled={saving || loading || !dirty} className="btn-primary text-sm disabled:opacity-40">{saving ? 'Saving…' : `Save${dirty ? ` (${Object.keys(changed).length})` : ''}`}</button>
      </>}>
      {loading || !f ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-10 rounded-lg bg-bg-hover animate-pulse" />)}</div>
      ) : (
        <>
          <div className="text-xs text-text-muted">
            {row.userName}{row.accountNumber ? ` · ${row.accountNumber}` : ''} · {closed ? 'CLOSED' : 'OPEN'} · ticket #{String(row._id).slice(-6).toUpperCase()}
            {!closed && pos?.currentPrice ? ` · current ${fmtNum(pos.currentPrice, 2)}` : ''}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Side"><SideToggle value={f.side} onChange={(v) => set('side', v)} /></Field>
            <Field label={closed ? 'Closed quantity' : 'Open quantity'}><input className="input" value={f.quantity} onChange={(e) => set('quantity', e.target.value)} /></Field>
            <Field label="Entry price"><input className="input" value={f.entryPrice} onChange={(e) => set('entryPrice', e.target.value)} /></Field>
            <Field label="Open date & time" hint="local time"><input type="datetime-local" className="input" value={f.openedAt} max={toLocalInput(new Date())} onChange={(e) => set('openedAt', e.target.value)} /></Field>
            {closed && <>
              <Field label="Close price"><input className="input" value={f.closePrice} onChange={(e) => set('closePrice', e.target.value)} /></Field>
              <Field label="Close date & time" hint="after open"><input type="datetime-local" className="input" value={f.closedAt} min={f.openedAt || undefined} max={toLocalInput(new Date())} onChange={(e) => set('closedAt', e.target.value)} /></Field>
            </>}
            <Field label="Leverage"><input className="input" value={f.leverage} onChange={(e) => set('leverage', e.target.value)} /></Field>
            <Field label="Commission"><input className="input" value={f.commission} onChange={(e) => set('commission', e.target.value)} /></Field>
            <Field label="Stop loss" hint="blank = none"><input className="input" value={f.stopLoss} onChange={(e) => set('stopLoss', e.target.value)} /></Field>
            <Field label="Take profit" hint="blank = none"><input className="input" value={f.takeProfit} onChange={(e) => set('takeProfit', e.target.value)} /></Field>
          </div>
          <Preview side={f.side} quantity={f.quantity} entryPrice={f.entryPrice} leverage={f.leverage || 1} status={closed ? 'CLOSED' : 'OPEN'} closePrice={f.closePrice} commission={f.commission} />
        </>
      )}
    </Shell>
  );
}
