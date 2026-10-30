import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';

/**
 * Payments — everything that governs money moving in or out, on one page.
 *
 * These three used to be cards buried in the general Settings page, which meant
 * scrolling past execution mode and referral tiers to change a withdrawal fee.
 * They belong together: a payment method's deposit side, its withdrawal side and
 * the exchange rates all read and write the same two settings documents, and a
 * change to one is almost always a change to another.
 *
 * Deposit and Withdrawal are two views of ONE record
 * (`deposit.paymentDetails`) — the tabs split the fields, not the data, so a
 * save from either tab sends the whole record and the server merges it.
 */
const TABS = [
  { key: 'deposit',    label: 'Deposit details',    hint: 'Where clients send money' },
  { key: 'withdrawal', label: 'Withdrawal details', hint: 'Fees and limits on payouts' },
  { key: 'currency',   label: 'Currency exchange',  hint: 'Rates every conversion uses' },
];

export default function Payments() {
  const [tab, setTab] = useState('deposit');

  return (
    <div className="space-y-5">
      <PageHero
        title="Payments"
        subtitle="Payment methods, payout rules and exchange rates."
      />

      {/* Tabs */}
      <div className="flex flex-wrap gap-1.5 border-b border-border-dark">
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`relative px-4 py-2.5 text-xs font-bold transition-colors ${
                active ? 'text-primary-400' : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {t.label}
              <span className="block text-[10px] font-normal text-text-muted mt-0.5">{t.hint}</span>
              {active && <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-primary-500 rounded-full" />}
            </button>
          );
        })}
      </div>

      {/* One record behind the first two tabs — mode only decides which fields show. */}
      {tab === 'deposit' && <PaymentMethodsCard mode="deposit" />}
      {tab === 'withdrawal' && <PaymentMethodsCard mode="withdrawal" />}
      {tab === 'currency' && <ExchangeRatesCard />}
    </div>
  );
}

/**
 * Deposit payment details — where clients SEND money for a manual deposit.
 * Self-contained: loads/saves via the dedicated /admin/system/deposit-details
 * endpoints (the generic settings PUT is whitelisted and won't accept these).
 * Whatever is filled here shows in the client's "Add funds" modal per method.
 */
function PaymentMethodsCard({ mode = 'deposit' }) {
  const isWithdrawal = mode === 'withdrawal';
  const [d, setD] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/admin/system/deposit-details')
      .then((r) => setD(r.data.data || {}))
      .catch((e) => toast.error(errorMessage(e)));
  }, []);

  const set = (method, field, val) =>
    setD((prev) => ({ ...prev, [method]: { ...(prev?.[method] || {}), [field]: val } }));

  // Show/hide toggle for the fixed methods (default: shown).
  // Deposit and withdrawal have their OWN switch. They shared one before, so
  // hiding a rail here also closed it on the other tab.
  const flagKey = isWithdrawal ? 'withdrawalEnabled' : 'enabled';
  const isOn = (method) => {
    const cfg = d?.[method];
    if (!cfg) return true;
    if (isWithdrawal) {
      return cfg.withdrawalEnabled === undefined || cfg.withdrawalEnabled === null
        ? cfg.enabled !== false
        : cfg.withdrawalEnabled !== false;
    }
    return cfg.enabled !== false;
  };
  const toggleMethod = (method) => set(method, flagKey, !isOn(method));
  // A hidden rail folds its body away and keeps only its header row. The
  // whole card used to render either way, so a rail the admin had switched
  // off looked at a glance exactly like a live one. Flip it back to Shown
  // to edit it.
  const railBox = (on) => `border rounded-lg p-3 ${on
    ? 'border-border-dark'
    : 'border-border-dark/60 opacity-60 [&>*:not(:first-child)]:hidden'}`;
  // Same rule for a custom rail.
  const customOn = (m) => {
    if (!isWithdrawal) return m.enabled !== false;
    return m.withdrawalEnabled === undefined || m.withdrawalEnabled === null
      ? m.enabled !== false
      : m.withdrawalEnabled !== false;
  };

  // Custom (admin-defined) methods — stored under d.custom.
  const customList = () => (Array.isArray(d?.custom) ? d.custom : []);
  const setCustomList = (list) => setD((prev) => ({ ...prev, custom: list }));
  const addCustom = () => setCustomList([...customList(), {
    id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    label: '', emoji: '💳', enabled: true, min: 0, supportedCurrencies: [], note: '', qr: '', fields: [{ label: '', value: '', copy: true }],
    // What a PAYOUT to this rail needs from the user — see the withdrawal tab.
    withdrawalFields: [],
  }]);
  const patchCustom = (idx, patch) => setCustomList(customList().map((m, i) => (i === idx ? { ...m, ...patch } : m)));
  const removeCustom = (idx) => setCustomList(customList().filter((_, i) => i !== idx));
  const addCustomField = (idx) => patchCustom(idx, { fields: [...(customList()[idx]?.fields || []), { label: '', value: '', copy: true }] });
  const patchCustomField = (idx, fi, patch) => patchCustom(idx, { fields: (customList()[idx]?.fields || []).map((f, j) => (j === fi ? { ...f, ...patch } : f)) });
  const removeCustomField = (idx, fi) => patchCustom(idx, { fields: (customList()[idx]?.fields || []).filter((_, j) => j !== fi) });

  // Withdrawal-side schema: the details to COLLECT, as opposed to the
  // deposit-side `fields` above, which are the details to PUBLISH.
  const wfList = (idx) => (customList()[idx]?.withdrawalFields || []);
  const addWithdrawalField = (idx) => patchCustom(idx, { withdrawalFields: [...wfList(idx), { label: '', required: true, sensitive: false }] });
  const patchWithdrawalField = (idx, fi, patch) => patchCustom(idx, { withdrawalFields: wfList(idx).map((f, j) => (j === fi ? { ...f, ...patch } : f)) });
  const removeWithdrawalField = (idx, fi) => patchCustom(idx, { withdrawalFields: wfList(idx).filter((_, j) => j !== fi) });
  const onCustomQr = (idx, file) => {
    if (!file) return;
    if (file.size > 500 * 1024) { toast.error('QR image must be under 500 KB'); return; }
    const reader = new FileReader();
    reader.onload = () => patchCustom(idx, { qr: reader.result });
    reader.readAsDataURL(file);
  };
  const togglePill = (on, onClick) => (
    <button type="button" onClick={onClick}
      className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded transition-colors ${on ? 'bg-emerald-500/20 text-emerald-400' : 'bg-bear/20 text-bear'}`}>
      {on ? 'Shown' : 'Hidden'}
    </button>
  );

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put('/admin/system/deposit-details', d);
      setD(r.data.data);
      toast.success('Deposit details saved');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  // What each built-in rail collects today. Seeded into the editor so it
  // opens showing the truth instead of blank — and so an admin who changes
  // nothing keeps exactly the fields the native validators expect.
  const NATIVE_WITHDRAWAL_FIELDS = {
    UPI:    [{ label: 'UPI ID', required: true, sensitive: true }, { label: 'Account holder name', required: true }],
    BANK:   [{ label: 'Account holder name', required: true }, { label: 'Bank name' }, { label: 'Account number', required: true, sensitive: true }, { label: 'IFSC code', required: true }],
    CRYPTO: [{ label: 'Wallet address', required: true, sensitive: true }, { label: 'Network', required: true }, { label: 'Memo / Tag' }],
  };

  // The two-column "what to collect" editor, shared by every rail on the
  // withdrawal tab. `get` returns the current array, `put` stores a new one —
  // passed in because a fixed rail lives at d[ID] and a custom one at
  // custom[idx], and the editor should not care which.
  const wFieldsEditor = (railId, get, put) => {
    const list = get();
    const shown = list.length ? list : (NATIVE_WITHDRAWAL_FIELDS[railId] || []);
    const commit = (next) => put(next);
    return (
      <div className="col-span-2 sm:col-span-2">
        <div className="text-[11px] font-bold text-text-secondary mb-0.5">Custom payment details</div>
        <p className="text-[10px] text-text-muted mb-2">
          These fields will be shown to users when they select this withdrawal method.
        </p>
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2 mb-1">
          <span className="text-[10px] text-text-muted">Field name / label</span>
          <span className="text-[10px] text-text-muted">User input / value</span>
          <span />
        </div>
        <div className="space-y-1.5">
          {shown.map((f, fi) => (
            <div key={fi} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
              <input value={f.label || ''}
                onChange={(e) => commit(shown.map((x, j) => (j === fi ? { ...x, label: e.target.value } : x)))}
                placeholder="Field name (e.g. Wallet address)" className={inputCls} />
              {/* Preview only — on a payout this value comes from the user. */}
              <input value={f.label ? `Enter ${String(f.label).toLowerCase()}` : ''} readOnly disabled tabIndex={-1}
                className={`${inputCls} opacity-60 cursor-not-allowed`} />
              <button type="button" title="Remove field"
                onClick={() => commit(shown.filter((_, j) => j !== fi))}
                className="text-bear text-sm px-1 shrink-0">🗑</button>
            </div>
          ))}
        </div>
        <button type="button"
          onClick={() => commit([...shown, { label: '', required: true }])}
          className="mt-2 text-[11px] font-semibold text-primary-400 hover:underline">+ Add custom field</button>
        <div className="flex flex-wrap gap-3 mt-1.5">
          {shown.map((f, fi) => (f.label ? (
            <label key={fi} className="flex items-center gap-1 text-[9px] text-text-muted cursor-pointer" title={`${f.label}: mask this value everywhere except the payout itself`}>
              <input type="checkbox" checked={!!f.sensitive}
                onChange={(e) => commit(shown.map((x, j) => (j === fi ? { ...x, sensitive: e.target.checked } : x)))} />
              {f.label} sensitive
            </label>
          ) : null))}
        </div>
      </div>
    );
  };

  // Bound to a FIXED rail (d[ID].withdrawalFields).
  const wFixedFields = (id) => (isWithdrawal ? wFieldsEditor(
    id,
    () => (Array.isArray(d?.[id]?.withdrawalFields) ? d[id].withdrawalFields : []),
    (next) => set(id, 'withdrawalFields', next),
  ) : null);

  // Plain helper (NOT a component) so inputs keep focus across keystrokes.
  // Payee details and the QR tell a client where to SEND money, so they have
  // no meaning on the withdrawal tab — a payout goes to the destination the
  // USER saved and verified, never to an address configured here.
  const field = (method, key, label, ph) => (isWithdrawal ? null : (
    <div>
      <label className="block text-[10px] text-text-muted mb-0.5">{label}</label>
      <input
        value={d?.[method]?.[key] || ''}
        onChange={(e) => set(method, key, e.target.value)}
        placeholder={ph}
        className="w-full px-2 py-1.5 rounded bg-bg-dark border border-border-dark text-xs font-mono text-white focus:border-primary-500 focus:outline-none"
      />
    </div>
  ));

  // Per-method fees + supported currencies. 0 / blank fee = no fee (default).
  // Deposit: client credited (amount − fee). Withdrawal: user receives
  // (amount − fee); the account is debited the full amount. Supported currencies
  // blank = all enabled currencies allowed for this method.
  const inputCls = 'w-full px-2 py-1.5 rounded bg-bg-dark border border-border-dark text-xs font-mono text-white focus:border-primary-500 focus:outline-none';

  // Per-transaction min/max for a method, in INR.
  //
  // INR and not the client's display currency: the same rail serves INR, USDT
  // and INR users, and the limit has to mean one thing for all of them. The
  // client converts it at the live rate for display, and the server checks the
  // converted figure — so "min 10" is $10 whether the user typed ₹960 or $10.
  // Blank / 0 = no limit (previous behaviour).
  const limitFields = (get, put) => (
    <div className="col-span-2 sm:col-span-2 grid grid-cols-2 sm:grid-cols-4 gap-2 border-t border-border-dark/40 pt-2 mt-1">
      <div className="col-span-2 sm:col-span-4 -mb-1">
        <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">
          Per-transaction {isWithdrawal ? 'withdrawal' : 'deposit'} limits (INR · blank = no limit)
        </span>
      </div>
      {(isWithdrawal
        ? [['minWithdrawal', 'Min withdrawal'], ['maxWithdrawal', 'Max withdrawal']]
        : [['minDeposit', 'Min deposit'], ['maxDeposit', 'Max deposit']]
      ).map(([k, label]) => (
        <div key={k}>
          <label className="block text-[10px] text-text-muted mb-0.5">{label}</label>
          <input type="number" min="0" step="0.01" inputMode="decimal"
            value={get(k) ?? ''} onChange={(e) => put(k, e.target.value)}
            placeholder="0" className={inputCls} />
        </div>
      ))}
    </div>
  );
  const feeRow = (method) => (
    <div className="sm:col-span-2 grid grid-cols-2 gap-2 border-t border-border-dark/40 pt-2 mt-1">
      {(isWithdrawal
        ? [['withdrawalFeePercent', 'Withdrawal fee %'], ['withdrawalFeeFixed', '+ Fixed fee']]
        : [['feePercent', 'Deposit fee %'], ['feeFixed', '+ Fixed fee']]
      ).map(([k, label]) => (
        <div key={k}>
          <label className="block text-[10px] text-text-muted mb-0.5">{label}</label>
          <input type="number" min="0" step="0.01" inputMode="decimal"
            value={d?.[method]?.[k] ?? ''} onChange={(e) => set(method, k, e.target.value)}
            placeholder="0" className={inputCls} />
        </div>
      ))}
      <div className="col-span-2">
        <label className="block text-[10px] text-text-muted mb-0.5">Supported currencies (comma-separated · blank = all)</label>
        <input type="text"
          value={Array.isArray(d?.[method]?.supportedCurrencies) ? d[method].supportedCurrencies.join(', ') : ''}
          onChange={(e) => set(method, 'supportedCurrencies', e.target.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))}
          placeholder="INR, INR, GBP" className={inputCls} />
      </div>
      {limitFields(
        (k) => d?.[method]?.[k] ?? '',
        (k, v) => set(method, k, v),
      )}
    </div>
  );

  // Scan-to-pay QR upload (UPI / Crypto). Stored as a data URL.
  const onQr = (method, file) => {
    if (!file) return;
    if (file.size > 500 * 1024) { toast.error('QR image must be under 500 KB'); return; }
    const reader = new FileReader();
    reader.onload = () => set(method, 'qr', reader.result);
    reader.readAsDataURL(file);
  };
  const qrUpload = (method) => (isWithdrawal ? null : (
    <div className="sm:col-span-2">
      <label className="block text-[10px] text-text-muted mb-1">QR code (scan to pay)</label>
      <div className="flex items-center gap-3">
        {d?.[method]?.qr ? (
          <img src={d[method].qr} alt="QR" className="w-16 h-16 rounded border border-border-dark bg-white object-contain p-0.5" />
        ) : (
          <div className="w-16 h-16 rounded border border-dashed border-border-dark flex items-center justify-center text-[9px] text-text-muted">No QR</div>
        )}
        <div className="flex flex-col gap-1.5">
          <label className="px-2 py-1 rounded bg-bg-dark border border-border-dark text-[11px] text-text-secondary cursor-pointer hover:border-primary-500 w-fit transition-colors">
            <input type="file" accept="image/*" className="hidden" onChange={(e) => onQr(method, e.target.files?.[0])} />
            Upload QR
          </label>
          {d?.[method]?.qr && (
            <button type="button" onClick={() => set(method, 'qr', '')} className="text-[10px] text-bear hover:underline w-fit">Remove</button>
          )}
        </div>
      </div>
    </div>
  ));

  if (!d) return <div className="card p-6 text-text-muted text-sm">Loading payment methods…</div>;

  return (
    <div className="card p-6">
      <h2 className="text-base font-semibold text-white mb-1">
        {isWithdrawal ? 'Withdrawal payment details' : 'Deposit payment details'}
      </h2>
      <p className="text-xs text-text-muted mb-4 max-w-lg">
        {isWithdrawal
          ? 'Fees and per-transaction limits applied when a payout leaves on each rail. The destination is always the one the user saved and an admin verified — it is never configured here. Switching a rail off stops new payouts on it.'
          : <>Where clients send money for a manual deposit. Filled fields appear in the client’s “Add funds” modal under each method (blank fields are hidden). Deposits still go through manual verification.</>}
      </p>

      <div className="space-y-4">
        <fieldset className={railBox(isOn('UPI'))}>
          <legend className="px-1 text-[11px] uppercase tracking-wider font-bold text-text-secondary"><span className="inline-flex items-center gap-2">📱 UPI {togglePill(isOn('UPI'), () => toggleMethod('UPI'))}</span></legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {field('UPI', 'upiId', 'UPI ID', 'name@bank')}
            {field('UPI', 'payeeName', 'Payee name', 'Imperial Exchange')}
            <div className="sm:col-span-2">{field('UPI', 'note', 'Note (optional)', 'Add your user-id in the remarks')}</div>
            {wFixedFields('UPI')}
            {qrUpload('UPI')}
            {feeRow('UPI')}
          </div>
        </fieldset>

        <fieldset className={railBox(isOn('BANK'))}>
          <legend className="px-1 text-[11px] uppercase tracking-wider font-bold text-text-secondary"><span className="inline-flex items-center gap-2">🏦 Bank transfer {togglePill(isOn('BANK'), () => toggleMethod('BANK'))}</span></legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {field('BANK', 'accountName', 'Account name', 'Imperial Exchange Pvt Ltd')}
            {field('BANK', 'accountNumber', 'Account number', '0000 0000 0000')}
            {field('BANK', 'ifsc', 'IFSC', 'HDFC0000001')}
            {field('BANK', 'bankName', 'Bank name', 'HDFC Bank')}
            <div className="sm:col-span-2">{field('BANK', 'note', 'Note (optional)', '')}</div>
            {wFixedFields('BANK')}
            {feeRow('BANK')}
          </div>
        </fieldset>

        <fieldset className={railBox(isOn('CRYPTO'))}>
          <legend className="px-1 text-[11px] uppercase tracking-wider font-bold text-text-secondary"><span className="inline-flex items-center gap-2">🪙 Crypto (USDT) {togglePill(isOn('CRYPTO'), () => toggleMethod('CRYPTO'))}</span></legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {field('CRYPTO', 'address', 'Wallet address', 'T...')}
            {field('CRYPTO', 'network', 'Network', 'TRC20')}
            <div className="sm:col-span-2">{field('CRYPTO', 'note', 'Note (optional)', 'Send only USDT on this network')}</div>
            {qrUpload('CRYPTO')}
            {wFixedFields('CRYPTO')}
            {feeRow('CRYPTO')}
          </div>
        </fieldset>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <fieldset className={railBox(isOn('SKRILL'))}>
            <legend className="px-1 text-[11px] uppercase tracking-wider font-bold text-text-secondary"><span className="inline-flex items-center gap-2">💳 Skrill {togglePill(isOn('SKRILL'), () => toggleMethod('SKRILL'))}</span></legend>
            <div className="space-y-2">
              {field('SKRILL', 'email', 'Skrill email', 'pay@tradepro.com')}
              {field('SKRILL', 'note', 'Note (optional)', '')}
              {wFixedFields('SKRILL')}
              {feeRow('SKRILL')}
            </div>
          </fieldset>
          <fieldset className={railBox(isOn('NETELLER'))}>
            <legend className="px-1 text-[11px] uppercase tracking-wider font-bold text-text-secondary"><span className="inline-flex items-center gap-2">💳 Neteller {togglePill(isOn('NETELLER'), () => toggleMethod('NETELLER'))}</span></legend>
            <div className="space-y-2">
              {field('NETELLER', 'email', 'Neteller email', 'pay@tradepro.com')}
              {field('NETELLER', 'note', 'Note (optional)', '')}
              {wFixedFields('NETELLER')}
              {feeRow('NETELLER')}
            </div>
          </fieldset>
        </div>

        {/* Razorpay — the automatic gateway. Toggle Shown/Hidden to control
            whether clients see the instant-pay option. Fee is charged on the
            credited amount like the manual methods. */}
        <fieldset className={railBox(isOn('RAZORPAY'))}>
          <legend className="px-1 text-[11px] uppercase tracking-wider font-bold text-text-secondary"><span className="inline-flex items-center gap-2">⚡ Razorpay (automatic gateway) {togglePill(isOn('RAZORPAY'), () => toggleMethod('RAZORPAY'))}</span></legend>
          <p className="text-[11px] text-text-muted mb-2">Instant UPI / card payments. Turn <b>off</b> to hide the automatic “Razorpay” option from the client’s Add-funds modal (manual methods stay).</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {wFixedFields('RAZORPAY')}
            {feeRow('RAZORPAY')}
          </div>
        </fieldset>

        {/* Custom (admin-defined) payment methods — add your own beyond the fixed set. */}
        <div className="border-t border-border-dark pt-4">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div>
              <h3 className="text-sm font-bold text-white">Custom payment methods</h3>
              <p className="text-[11px] text-text-muted">
                {isWithdrawal
                  ? 'Your own rails — the same list the Deposit tab shows. Add, rename or remove from either tab; Shown/Hidden is set per tab.'
                  : 'Add your own (PayPal, Wise, etc.). The same list serves withdrawals — only Shown/Hidden is set separately on each tab.'}
              </p>
            </div>
            <button type="button" onClick={addCustom} className="shrink-0 text-xs font-bold px-2.5 py-1 rounded bg-primary-500/15 text-primary-400 hover:bg-primary-500/25 transition-colors">+ Add method</button>
          </div>

          {customList().length === 0 ? (
            <p className="text-[11px] text-text-muted italic">No custom methods yet.</p>
          ) : (
            <div className="space-y-3">
              {customList().map((m, idx) => (
                <fieldset key={m.id || idx} className={railBox(customOn(m))}>
                  <div className="flex items-center gap-2 mb-2">
                    {/* One record behind both tabs, so the name and icon are
                        editable from either — the Withdrawal tab used to show
                        them read-only and point you at the Deposit tab. */}
                    <input value={m.emoji || ''} onChange={(e) => patchCustom(idx, { emoji: e.target.value })} maxLength={2} placeholder="💳"
                      className="w-10 text-center px-1 py-1.5 rounded bg-bg-dark border border-border-dark text-sm text-white focus:border-primary-500 focus:outline-none" />
                    <input value={m.label || ''} onChange={(e) => patchCustom(idx, { label: e.target.value })} placeholder="Method name (e.g. PayPal)"
                      className="flex-1 px-2 py-1.5 rounded bg-bg-dark border border-border-dark text-xs font-semibold text-white focus:border-primary-500 focus:outline-none" />
                    {togglePill(customOn(m), () => patchCustom(idx, { [flagKey]: !customOn(m) }))}
                    {/* Shared record: removing here removes it for deposits too,
                        which the blurb above states. */}
                    <button type="button" onClick={() => removeCustom(idx)} className="text-[10px] font-bold text-bear hover:underline shrink-0">Remove</button>
                  </div>

                  {/* Where to SEND money — deposit-side only. A payout goes to the
                      user's own saved, verified destination, never to these. */}
                  <div className={`space-y-1.5 ${isWithdrawal ? 'hidden' : ''}`}>
                    {(m.fields || []).map((f, fi) => (
                      <div key={fi} className="flex items-center gap-1.5">
                        <input value={f.label || ''} onChange={(e) => patchCustomField(idx, fi, { label: e.target.value })} placeholder="Label (e.g. Email)"
                          className="w-1/3 px-2 py-1.5 rounded bg-bg-dark border border-border-dark text-xs text-white focus:border-primary-500 focus:outline-none" />
                        <input value={f.value || ''} onChange={(e) => patchCustomField(idx, fi, { value: e.target.value })} placeholder="Value"
                          className="flex-1 px-2 py-1.5 rounded bg-bg-dark border border-border-dark text-xs font-mono text-white focus:border-primary-500 focus:outline-none" />
                        <label className="flex items-center gap-1 text-[9px] text-text-muted shrink-0 cursor-pointer" title="Show a Copy button to the client">
                          <input type="checkbox" checked={f.copy !== false} onChange={(e) => patchCustomField(idx, fi, { copy: e.target.checked })} />
                          copy
                        </label>
                        <button type="button" onClick={() => removeCustomField(idx, fi)} className="text-bear text-sm px-1 shrink-0" title="Remove field">×</button>
                      </div>
                    ))}
                    <button type="button" onClick={() => addCustomField(idx)} className="text-[11px] font-semibold text-primary-400 hover:underline">+ Add field</button>
                  </div>

                  {/* What to ASK the user for — withdrawal side. The block above
                      publishes an address to pay INTO; this one declares the
                      details a payout needs OUT. Each row becomes an input on the
                      user's Withdrawal methods form. */}
                  <div className={`space-y-1.5 ${isWithdrawal ? '' : 'hidden'}`}>
                    <div className="text-[10px] text-text-muted">Details to collect from the user</div>
                    {(m.withdrawalFields || []).map((f, fi) => (
                      <div key={fi} className="flex items-center gap-1.5">
                        <input value={f.label || ''} onChange={(e) => patchWithdrawalField(idx, fi, { label: e.target.value })} placeholder="Label (e.g. Wallet address)"
                          className="flex-1 px-2 py-1.5 rounded bg-bg-dark border border-border-dark text-xs text-white focus:border-primary-500 focus:outline-none" />
                        <label className="flex items-center gap-1 text-[9px] text-text-muted shrink-0 cursor-pointer" title="The user cannot save the destination without this">
                          <input type="checkbox" checked={f.required !== false} onChange={(e) => patchWithdrawalField(idx, fi, { required: e.target.checked })} />
                          required
                        </label>
                        <label className="flex items-center gap-1 text-[9px] text-text-muted shrink-0 cursor-pointer" title="Mask this value everywhere except the payout itself — for account numbers and wallet addresses">
                          <input type="checkbox" checked={!!f.sensitive} onChange={(e) => patchWithdrawalField(idx, fi, { sensitive: e.target.checked })} />
                          sensitive
                        </label>
                        <button type="button" onClick={() => removeWithdrawalField(idx, fi)} className="text-bear text-sm px-1 shrink-0" title="Remove field">×</button>
                      </div>
                    ))}
                    <button type="button" onClick={() => addWithdrawalField(idx)} className="text-[11px] font-semibold text-primary-400 hover:underline">+ Add field</button>
                    <p className="text-[10px] text-text-muted leading-snug">
                      The user fills these in under Withdrawal methods, you verify the
                      destination, and only a verified one can receive a payout. Leave
                      this empty and the rail stays hidden for withdrawals — there
                      would be nothing to ask.
                    </p>
                  </div>

                  {/* Fee pair for whichever side this tab is about. */}
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {(isWithdrawal
                      ? [['withdrawalFeePercent', 'Withdrawal fee %'], ['withdrawalFeeFixed', '+ Fixed fee']]
                      : [['feePercent', 'Deposit fee %'], ['feeFixed', '+ Fixed fee']]
                    ).map(([k, label]) => (
                      <div key={k}>
                        <label className="block text-[10px] text-text-muted mb-0.5">{label}</label>
                        <input type="number" min="0" step="0.01" inputMode="decimal" value={m[k] ?? ''} onChange={(e) => patchCustom(idx, { [k]: e.target.value })} placeholder="0"
                          className="w-full px-2 py-1.5 rounded bg-bg-dark border border-border-dark text-xs font-mono text-white focus:border-primary-500 focus:outline-none" />
                      </div>
                    ))}
                  </div>

                  {/* Which currencies this rail accepts. Blank = all enabled.
                      Set on the deposit side; it governs both directions. */}
                  <div className={`mt-2 ${isWithdrawal ? 'hidden' : ''}`}>
                    <label className="block text-[10px] text-text-muted mb-0.5">Supported currencies (comma-separated · blank = all)</label>
                    <input type="text"
                      value={Array.isArray(m.supportedCurrencies) ? m.supportedCurrencies.join(', ') : ''}
                      onChange={(e) => patchCustom(idx, { supportedCurrencies: e.target.value.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) })}
                      placeholder="USDT" className={inputCls} />
                    <p className="text-[10px] text-text-muted mt-1 leading-snug">
                      Conversion follows the currency's DEPOSIT rate in Exchange Rates below — the same rate the deposit screen quotes and the confirm credits at.
                    </p>
                  </div>

                  {/* Per-transaction limits (INR) */}
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {limitFields(
                      (k) => m[k] ?? '',
                      (k, v) => patchCustom(idx, { [k]: v }),
                    )}
                  </div>

                  {/* Note + QR — deposit-side only, same reason as the fields above. */}
                  <input value={m.note || ''} onChange={(e) => patchCustom(idx, { note: e.target.value })} placeholder="Note (optional) — e.g. Add your user-id in remarks"
                    className={`mt-2 w-full px-2 py-1.5 rounded bg-bg-dark border border-border-dark text-xs text-white focus:border-primary-500 focus:outline-none ${isWithdrawal ? 'hidden' : ''}`} />
                  <div className={`mt-2 flex items-center gap-3 ${isWithdrawal ? 'hidden' : ''}`}>
                    {m.qr ? (
                      <img src={m.qr} alt="QR" className="w-14 h-14 rounded border border-border-dark bg-white object-contain p-0.5" />
                    ) : (
                      <div className="w-14 h-14 rounded border border-dashed border-border-dark flex items-center justify-center text-[9px] text-text-muted">No QR</div>
                    )}
                    <div className="flex flex-col gap-1.5">
                      <label className="px-2 py-1 rounded bg-bg-dark border border-border-dark text-[11px] text-text-secondary cursor-pointer hover:border-primary-500 w-fit transition-colors">
                        <input type="file" accept="image/*" className="hidden" onChange={(e) => onCustomQr(idx, e.target.files?.[0])} />
                        Upload QR
                      </label>
                      {m.qr && <button type="button" onClick={() => patchCustom(idx, { qr: '' })} className="text-[10px] text-bear hover:underline w-fit">Remove</button>}
                    </div>
                  </div>
                </fieldset>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="px-4 py-1.5 rounded text-xs font-bold bg-primary-500 text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-600 transition-colors"
        >
          {saving ? 'Saving…' : (isWithdrawal ? 'Save withdrawal details' : 'Save deposit details')}
        </button>
      </div>
    </div>
  );
}

/**
 * Exchange-rate configuration (multi-currency). The account base currency is
 * always INR; these rates only convert display + deposit/withdrawal amounts.
 * Rate convention: 1 INR = <rate> <currency>. AUTO uses the live online rate;
 * MANUAL uses the entered rates and needs a positive deposit + withdrawal rate.
 */
const BLANK_CCY = { code: '', symbol: '', mode: 'MANUAL', displayRate: '', depositRate: '', withdrawalRate: '' };

function ExchangeRatesCard() {
  const [rows, setRows] = useState([]);
  const [saving, setSaving] = useState(false);
  // A currency the platform does not know yet. The table only ever listed
  // what was already stored, so a rail accepting (say) USDC or BTC had no
  // rate anywhere and its deposits could not be priced at all.
  const [draft, setDraft] = useState(BLANK_CCY);

  const load = async () => {
    try {
      const r = await api.get('/admin/system/exchange-rates');
      setRows(r.data.data?.currencies || []);
    } catch (e) { toast.error(errorMessage(e)); }
  };
  useEffect(() => { load(); }, []);

  // Unlike adding, removing hits the server straight away: a row staged for
  // deletion locally would reappear on the next load, and "Save rates" only
  // upserts — it has no concept of a row that should no longer exist.
  const removeCurrency = async (code) => {
    const c = String(code).toUpperCase();
    if (!window.confirm(
      `Remove ${c}?\n\nPast deposits and withdrawals in ${c} keep the rate they were made at, so history stays correct.       New transactions can no longer use it.`
    )) return;
    try {
      await api.delete(`/admin/system/exchange-rates/${c}`);
      toast.success(`${c} removed`);
      load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  // Staged locally; "Save rates" is what persists it, same as every edit
  // above. The server upserts by code, so a new one simply appears.
  const addCurrency = () => {
    const code = String(draft.code || '').toUpperCase().trim();
    if (!/^[A-Z]{3,5}$/.test(code)) {
      toast.error('Currency code must be 3-5 letters, e.g. USDC');
      return;
    }
    if (code === 'INR') {
      toast.error('INR is the base currency — it has no rate');
      return;
    }
    if (rows.some((c) => String(c.code).toUpperCase() === code)) {
      toast.error(`${code} is already listed`);
      return;
    }
    const mode = draft.mode === 'AUTO' ? 'AUTO' : 'MANUAL';
    // MANUAL is rejected server-side without a positive deposit AND
    // withdrawal rate, so catch it here rather than on save.
    if (mode === 'MANUAL' && !(Number(draft.depositRate) > 0 && Number(draft.withdrawalRate) > 0)) {
      toast.error('MANUAL needs a positive deposit and withdrawal rate');
      return;
    }
    setRows((prev) => [...prev, {
      code,
      symbol: String(draft.symbol || '').slice(0, 4),
      enabled: true,
      mode,
      displayRate: draft.displayRate === '' ? null : Number(draft.displayRate),
      depositRate: draft.depositRate === '' ? null : Number(draft.depositRate),
      withdrawalRate: draft.withdrawalRate === '' ? null : Number(draft.withdrawalRate),
    }]);
    setDraft(BLANK_CCY);
    toast.success(`${code} added — press Save rates to store it`);
  };

  const setField = (code, field, val) =>
    setRows((prev) => prev.map((c) => (c.code === code ? { ...c, [field]: val } : c)));

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/admin/system/exchange-rates', {
        currencies: rows.map((c) => ({
          code: c.code,
          symbol: c.symbol,
          enabled: c.enabled !== false,
          mode: c.mode,
          displayRate: c.displayRate === '' ? null : Number(c.displayRate),
          depositRate: c.depositRate === '' ? null : Number(c.depositRate),
          withdrawalRate: c.withdrawalRate === '' ? null : Number(c.withdrawalRate),
        })),
      });
      toast.success('Exchange rates saved');
      load();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setSaving(false); }
  };

  const inp = 'w-full px-2 py-1.5 rounded bg-bg-dark border border-border-dark text-xs font-mono text-white focus:border-primary-500 focus:outline-none';

  return (
    <div className="bg-bg-card border border-border-dark rounded-xl p-5">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-semibold text-white">Exchange Rates (multi-currency)</h2>
        <button onClick={save} disabled={saving}
          className="px-3 py-1.5 rounded bg-primary-600 hover:bg-primary-500 text-white text-xs font-semibold disabled:opacity-60">
          {saving ? 'Saving…' : 'Save rates'}
        </button>
      </div>
      <p className="text-[11px] text-text-muted mb-3">
        Base currency is <span className="text-white font-semibold">INR</span>. Rates are <span className="font-mono">1 INR = rate</span>.
        AUTO uses the live online rate; MANUAL uses the values below (deposit &amp; withdrawal rate required).
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-muted text-left">
              <th className="py-1 pr-2">Currency</th>
              <th className="py-1 px-2">On</th>
              <th className="py-1 px-2">Mode</th>
              <th className="py-1 px-2">Display rate</th>
              <th className="py-1 px-2">Deposit rate</th>
              <th className="py-1 px-2">Withdrawal rate</th>
              <th className="py-1 px-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.code} className="border-t border-border-dark/40">
                <td className="py-1.5 pr-2 font-semibold text-white whitespace-nowrap">{c.symbol} {c.code}</td>
                <td className="py-1.5 px-2">
                  <input type="checkbox" checked={c.enabled !== false} onChange={(e) => setField(c.code, 'enabled', e.target.checked)} />
                </td>
                <td className="py-1.5 px-2">
                  <select value={c.mode || 'AUTO'} onChange={(e) => setField(c.code, 'mode', e.target.value)} className={inp}>
                    <option value="AUTO">AUTO</option>
                    <option value="MANUAL">MANUAL</option>
                  </select>
                </td>
                <td className="py-1.5 px-2">
                  <input type="number" min="0" step="0.0001" inputMode="decimal" className={inp}
                    value={c.displayRate ?? ''} onChange={(e) => setField(c.code, 'displayRate', e.target.value)}
                    disabled={c.mode === 'AUTO'} placeholder={c.mode === 'AUTO' ? 'live' : '0'} />
                </td>
                <td className="py-1.5 px-2">
                  <input type="number" min="0" step="0.0001" inputMode="decimal" className={inp}
                    value={c.depositRate ?? ''} onChange={(e) => setField(c.code, 'depositRate', e.target.value)}
                    disabled={c.mode === 'AUTO'} placeholder={c.mode === 'AUTO' ? 'live' : '0'} />
                </td>
                <td className="py-1.5 px-2">
                  <input type="number" min="0" step="0.0001" inputMode="decimal" className={inp}
                    value={c.withdrawalRate ?? ''} onChange={(e) => setField(c.code, 'withdrawalRate', e.target.value)}
                    disabled={c.mode === 'AUTO'} placeholder={c.mode === 'AUTO' ? 'live' : '0'} />
                </td>
                <td className="py-1.5 px-2 text-right whitespace-nowrap">
                  <button type="button" onClick={() => removeCurrency(c.code)}
                    title={`Remove ${c.code} from the platform`}
                    className="text-[10px] font-bold text-bear hover:underline">Remove</button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={7} className="py-3 text-center text-text-muted">Loading currencies…</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add a currency the platform does not carry yet. */}
      <div className="mt-4 border-t border-border-dark/60 pt-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-text-muted">Add a currency</span>
          <span className="text-[10px] text-text-muted">Payment methods convert through these rates</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-7 gap-2 items-end">
          <div>
            <label className="block text-[10px] text-text-muted mb-0.5">Code</label>
            <input value={draft.code}
              onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })}
              maxLength={5} placeholder="USDC" className={inp} />
          </div>
          <div>
            <label className="block text-[10px] text-text-muted mb-0.5">Symbol</label>
            <input value={draft.symbol}
              onChange={(e) => setDraft({ ...draft, symbol: e.target.value })}
              maxLength={4} placeholder="$" className={inp} />
          </div>
          <div>
            <label className="block text-[10px] text-text-muted mb-0.5">Mode</label>
            <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value })} className={inp}>
              <option value="MANUAL">MANUAL</option>
              <option value="AUTO">AUTO</option>
            </select>
          </div>
          {[
            ['displayRate', 'Display rate'],
            ['depositRate', 'Deposit rate'],
            ['withdrawalRate', 'Withdrawal rate'],
          ].map(([k, label]) => (
            <div key={k}>
              <label className="block text-[10px] text-text-muted mb-0.5">{label}</label>
              <input type="number" min="0" step="0.0001" inputMode="decimal" className={inp}
                value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                disabled={draft.mode === 'AUTO'} placeholder={draft.mode === 'AUTO' ? 'live' : '0'} />
            </div>
          ))}
          <button type="button" onClick={addCurrency}
            className="px-3 py-1.5 rounded bg-primary-500/15 text-primary-400 hover:bg-primary-500/25 text-xs font-bold transition-colors">
            + Add
          </button>
        </div>
        <p className="text-[10px] text-text-muted mt-2 leading-snug">
          Rates are <span className="font-mono">1 INR = rate</span>. Untick <span className="text-white">On</span> to hide a currency from every picker but keep it configured;
          <span className="text-white"> Remove</span> deletes it outright. Past transactions keep the rate they were made at either way, so history stays correct.
          A currency still listed on a payment method cannot be removed until it is taken off that method.
        </p>
      </div>
    </div>
  );
}


