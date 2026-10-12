/**
 * dhanInstrumentSync.js — periodic refresh of Indian instruments from Dhan's
 * scrip master.
 *
 * One CSV pass upserts NSE cash equity (series EQ/BE). Called by the
 * background worker once a day (pre-market). The CLI
 * scripts/import-dhan-instruments.js stays for manual / one-off imports.
 *
 * Derivatives are out of scope: futures and options were removed from the
 * platform, so the FUTIDX / FUTSTK / OPTIDX / OPTSTK rows in the scrip master
 * are skipped along with everything else that is not cash equity.
 *
 * Env:
 *   DHAN_SCRIP_URL           (optional override)
 *   DHAN_SYNC_EQUITY=all|curated             default 'curated'
 */
const Instrument = require('../models/Instrument');
const { LIQUID_NSE_SET } = require('../config/indianLiquidStocks');

const CSV_URL = process.env.DHAN_SCRIP_URL || 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';

// Default 'curated': only keep the liquid universe (real-price-able on the free
// Yahoo feed). Set DHAN_SYNC_EQUITY=all to import every listed scrip again.
const EQUITY_MODE = (process.env.DHAN_SYNC_EQUITY || 'curated').toLowerCase();
const EQ_CURATED = LIQUID_NSE_SET;



function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === ',') { out.push(cur); cur = ''; }
    else if (ch === '"') q = true;
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function syncAll() {
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`scrip master HTTP ${res.status}`);
  const lines = (await res.text()).split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toUpperCase());
  const col = (...names) => {
    for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; }
    for (const n of names) { const i = header.findIndex((h) => h.includes(n)); if (i >= 0) return i; }
    return -1;
  };
  const C = {
    exch: col('EXCH_ID'), sid: col('SECURITY_ID'), isin: col('ISIN'), inst: col('INSTRUMENT'),
    series: col('SERIES'), lot: col('LOT_SIZE'), exp: col('SM_EXPIRY_DATE'),
    strike: col('STRIKE_PRICE'), opt: col('OPTION_TYPE'), tick: col('TICK_SIZE'),
    custom: col('DISPLAY_NAME'), under: col('UNDERLYING_SYMBOL'),
    upperLimit: col('SM_UPPER_LIMIT'), lowerLimit: col('SM_LOWER_LIMIT'), freezeQty: col('SM_FREEZE_QTY'),
  };
  const _band = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? String(n) : null; };
  if (C.exch < 0 || C.sid < 0 || C.inst < 0 || C.under < 0) throw new Error('unexpected scrip-master columns');
  const get = (a, i) => (i >= 0 && i < a.length ? String(a[i] || '').trim() : '');

  const ops = [];
  for (let li = 1; li < lines.length; li++) {
    const r = parseCsvLine(lines[li]);
    if (get(r, C.exch).toUpperCase() !== 'NSE') continue;
    const inst = get(r, C.inst).toUpperCase();
    const under = get(r, C.under).toUpperCase();

    // Cash equity only. FUTIDX / FUTSTK / OPTIDX / OPTSTK fall through.
    if (inst !== 'EQUITY') continue;
    const ser = get(r, C.series).toUpperCase();
    if (ser && ser !== 'EQ' && ser !== 'BE') continue;
    if (EQUITY_MODE !== 'all' && !EQ_CURATED.has(under)) continue;
    const category = 'STOCK';
    const segment = 'EQ';
    if (!under) continue;

    const symbol = under.replace(/\s+/g, '');
    if (!symbol) continue;

    const lot = get(r, C.lot) || '1';
    const set$ = {
      symbol, name: get(r, C.custom) || symbol, category,
      exchange: 'NSE', segment,
      externalProvider: 'DHAN', instrumentToken: get(r, C.sid), isin: get(r, C.isin) || null,
      tickSize: String(Number(get(r, C.tick)) || 0.05), lotSize: String(lot),
      upperCircuit: _band(get(r, C.upperLimit)), lowerCircuit: _band(get(r, C.lowerLimit)), freezeQty: _band(get(r, C.freezeQty)),
      pricePrecision: 2, quantityPrecision: 0, minOrderSize: '1',
      isActive: true,
    };
    ops.push({ updateOne: {
      filter: { symbol },
      update: { $set: set$, $setOnInsert: { baseCurrency: symbol, quoteCurrency: 'INR' } },
      upsert: true,
    } });
  }

  if (!ops.length) return { ops: 0, upserted: 0, modified: 0, deactivated: 0 };
  let upserted = 0, modified = 0;
  for (let k = 0; k < ops.length; k += 2000) { // batch to keep each bulkWrite modest
    const w = await Instrument.bulkWrite(ops.slice(k, k + 2000), { ordered: false });
    upserted += w.upsertedCount || 0; modified += w.modifiedCount || 0;
  }

  // Curated mode is the source of truth for the cash-equity universe: deactivate
  // any NSE EQ that's not in the liquid list (self-healing — keeps the daily sync
  // from re-surfacing penny stocks), and (re)activate the ones that are.
  let deactivated = 0;
  if (EQUITY_MODE !== 'all') {
    const keep = [...EQ_CURATED];
    const d = await Instrument.updateMany(
      { exchange: 'NSE', segment: 'EQ', symbol: { $nin: keep }, isActive: true },
      { $set: { isActive: false } },
    );
    deactivated = d.modifiedCount || 0;
    await Instrument.updateMany(
      { exchange: 'NSE', segment: 'EQ', symbol: { $in: keep }, isActive: false },
      { $set: { isActive: true } },
    );
  }

  return { ops: ops.length, upserted, modified, deactivated };
}

module.exports = { syncAll };
