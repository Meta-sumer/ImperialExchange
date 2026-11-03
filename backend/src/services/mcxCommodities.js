/**
 * mcxCommodities.js — ensures the MCX commodity instruments exist, every one
 * priced from a FREE Yahoo source.
 *
 * MCX itself has no free quote API, so each row is priced from the matching
 * international futures contract on the free Yahoo feed, converted into the
 * rupee unit the MCX contract is quoted in:
 *
 *   price(₹) = Yahoo price (USD) × USDINR × multiplier × (1 + adjustPct/100)
 *
 *   Family GOLD   (COMEX GC=F, USD/troy oz)
 *     GOLD / GOLDM         ₹/10 g      multiplier 10 / 31.1035
 *     GOLDGUINEA           ₹/8 g       multiplier  8 / 31.1035
 *     GOLDPETAL            ₹/1 g       multiplier  1 / 31.1035
 *   Family SILVER (COMEX SI=F, USD/troy oz)
 *     SILVER / SILVERM / SILVERMIC   ₹/kg   multiplier 1000 / 31.1035
 *   Family CRUDE  (NYMEX CL=F, USD/barrel)      CRUDEOIL / CRUDEOILM      ₹/bbl    ×1
 *   Family NATGAS (NYMEX NG=F, USD/mmBtu)       NATURALGAS / NATURALGASMINI ₹/mmBtu ×1
 *   Family COPPER (COMEX HG=F, USD/lb)          COPPER                    ₹/kg     ×2.20462
 *   Family ALUMINIUM (COMEX ALI=F, USD/tonne)   ALUMINIUM                 ₹/kg     ×1/1000
 *
 *   Lot sizes (`lot`, quantity per lot in the quote unit): GOLD 100 (1 kg),
 *   GOLDM 10 (100 g), GOLDGUINEA 1 (8 g), GOLDPETAL 1 (1 g), SILVER 30 (30 kg),
 *   SILVERM 5, SILVERMIC 1, CRUDEOIL 100 bbl, CRUDEOILM 10 bbl, NATURALGAS
 *   1250 mmBtu, NATURALGASMINI 250 mmBtu, COPPER 2500 kg, ALUMINIUM 5000 kg.
 *
 *   Not offered (no free source): Zinc, Lead, Nickel (LME-only), Cotton,
 *   Mentha Oil, CPO. They need a paid Dhan/Upstox MCX feed.
 *
 * The derived number tracks the real MCX price in direction and magnitude but
 * is NOT the exchange print — MCX carries import duty, a local premium or
 * discount and contract-expiry basis. `feedConvert.adjustPct` is the admin's
 * calibration for that (Instruments → Calibrate): one reference price for any
 * contract in a family re-tunes the whole family (`feedConvert.group`).
 *
 * The rows carry exchange 'MCX', so services/marketHours.js gates trading to
 * the MCX session (09:00–23:30 IST) and services/marketScope.js keeps them in
 * the Indian-market scope. Idempotent: config refreshed every run; lastPrice
 * and adjustPct are only seeded on insert, so a re-run never clobbers a live
 * price or an admin calibration.
 */
const Instrument = require('../models/Instrument');

const OZ = 31.1035; // grams per troy ounce

const MCX_COMMODITIES = [
  // ── Gold family (COMEX GC=F, USD/oz) ──
  { symbol: 'GOLD',           name: 'Gold (₹/10g, derived from COMEX)',               base: 'GOLD',   group: 'GOLD',      yh: 'GC=F',  mult: 10 / OZ,   prec: 0, seedLast: '119000', spread: '10',  tick: '1', lot: 100, lotUnit: '1 kg' },
  { symbol: 'GOLDM',          name: 'Gold Mini (₹/10g, derived from COMEX)',          base: 'GOLD',   group: 'GOLD',      yh: 'GC=F',  mult: 10 / OZ,   prec: 0, seedLast: '119000', spread: '10',  tick: '1', lot: 10, lotUnit: '100 g' },
  { symbol: 'GOLDGUINEA',     name: 'Gold Guinea (₹/8g, derived from COMEX)',         base: 'GOLD',   group: 'GOLD',      yh: 'GC=F',  mult: 8 / OZ,    prec: 0, seedLast: '95000',  spread: '8',   tick: '1', lot: 1, lotUnit: '8 g' },
  { symbol: 'GOLDPETAL',      name: 'Gold Petal (₹/1g, derived from COMEX)',          base: 'GOLD',   group: 'GOLD',      yh: 'GC=F',  mult: 1 / OZ,    prec: 0, seedLast: '11900',  spread: '1',   tick: '1', lot: 1, lotUnit: '1 g' },
  // ── Silver family (COMEX SI=F, USD/oz) ──
  { symbol: 'SILVER',         name: 'Silver (₹/kg, derived from COMEX)',              base: 'SILVER', group: 'SILVER',    yh: 'SI=F',  mult: 1000 / OZ, prec: 0, seedLast: '153000', spread: '25',  tick: '1', lot: 30, lotUnit: '30 kg' },
  { symbol: 'SILVERM',        name: 'Silver Mini (₹/kg, derived from COMEX)',         base: 'SILVER', group: 'SILVER',    yh: 'SI=F',  mult: 1000 / OZ, prec: 0, seedLast: '153000', spread: '25',  tick: '1', lot: 5, lotUnit: '5 kg' },
  { symbol: 'SILVERMIC',      name: 'Silver Micro (₹/kg, derived from COMEX)',        base: 'SILVER', group: 'SILVER',    yh: 'SI=F',  mult: 1000 / OZ, prec: 0, seedLast: '153000', spread: '25',  tick: '1', lot: 1, lotUnit: '1 kg' },
  // ── Energy (NYMEX) ──
  { symbol: 'CRUDEOIL',       name: 'Crude Oil (₹/bbl, derived from NYMEX WTI)',      base: 'CRUDE',  group: 'CRUDE',     yh: 'CL=F',  mult: 1,         prec: 0, seedLast: '9500',   spread: '2',   tick: '1', lot: 100, lotUnit: '100 bbl' },
  { symbol: 'CRUDEOILM',      name: 'Crude Oil Mini (₹/bbl, derived from NYMEX WTI)', base: 'CRUDE',  group: 'CRUDE',     yh: 'CL=F',  mult: 1,         prec: 0, seedLast: '9500',   spread: '2',   tick: '1', lot: 10, lotUnit: '10 bbl' },
  { symbol: 'NATURALGAS',     name: 'Natural Gas (₹/mmBtu, derived from NYMEX)',      base: 'NATGAS', group: 'NATGAS',    yh: 'NG=F',  mult: 1,         prec: 1, seedLast: '275',    spread: '0.3', tick: '0.1', lot: 1250, lotUnit: '1250 mmBtu' },
  { symbol: 'NATURALGASMINI', name: 'Natural Gas Mini (₹/mmBtu, derived from NYMEX)', base: 'NATGAS', group: 'NATGAS',    yh: 'NG=F',  mult: 1,         prec: 1, seedLast: '275',    spread: '0.3', tick: '0.1', lot: 250, lotUnit: '250 mmBtu' },
  // ── Base metals (COMEX) ──
  { symbol: 'COPPER',         name: 'Copper (₹/kg, derived from COMEX)',              base: 'COPPER', group: 'COPPER',    yh: 'HG=F',  mult: 2.20462,   prec: 2, seedLast: '1370',   spread: '0.5', tick: '0.05', lot: 2500, lotUnit: '2500 kg' },
  { symbol: 'ALUMINIUM',      name: 'Aluminium (₹/kg, derived from COMEX)',           base: 'ALUMINIUM', group: 'ALUMINIUM', yh: 'ALI=F', mult: 1 / 1000, prec: 2, seedLast: '300',  spread: '0.3', tick: '0.05', lot: 5000, lotUnit: '5 MT' },
];

async function ensureMcxCommodities() {
  const ops = MCX_COMMODITIES.map((c) => ({
    updateOne: {
      filter: { symbol: c.symbol },
      update: {
        $set: {
          symbol: c.symbol,
          name: c.name,
          category: 'COMMODITY',
          exchange: 'MCX',
          segment: 'COMM',
          quoteCurrency: 'INR',
          tickSize: c.tick,
          pricePrecision: c.prec,
          quantityPrecision: 0,
          minOrderSize: '1',
          maxOrderSize: '10000',
          maxLeverage: 100,
          spreadType: 'FIXED',
          spreadValue: c.spread,
          commissionPercent: '0.0003',
          externalProvider: 'YAHOO',
          externalFeedSymbol: c.yh,
          // Dotted paths so a re-run refreshes the conversion but never
          // touches the admin's adjustPct (seeded below on insert only).
          'feedConvert.fx': 'USDINR',
          'feedConvert.multiplier': c.mult,
          'feedConvert.group': c.group,
          // The derived feed serves the price — keep the simulator OFF.
          priceSimulator: { enabled: false },
          isActive: true,
          tradingEnabled: true,
          marketDataEnabled: true,
          userVisible: true,
        },
        $setOnInsert: {
          baseCurrency: c.base,
          lastPrice: c.seedLast,
          'feedConvert.adjustPct': 0,
        },
      },
      upsert: true,
    },
  }));

  const res = await Instrument.bulkWrite(ops, { ordered: false });
  await ensureMcxLotSizes();
  return {
    total: MCX_COMMODITIES.length,
    inserted: res.upsertedCount || 0,
    updated: res.modifiedCount || 0,
    symbols: MCX_COMMODITIES.map((c) => c.symbol),
  };
}

// MCX lot size, in the contract's own quote unit. P&L is price × quantity, so
// one lot must be the quantity whose price × quantity is the lot's rupee value:
// GOLD is quoted per 10 g and one lot is 1 kg, so 1 lot = quantity 100. The
// admin's manual-trade form takes lots and books lots × lotSize. Only rows
// still on the model default (below 1) are filled, so a lot size set by hand
// on Instruments is never overwritten. Runs at boot and after every MCX sync.
async function ensureMcxLotSizes() {
  const bySymbol = new Map(MCX_COMMODITIES.map((c) => [c.symbol, c]));
  const rows = await Instrument.find({ exchange: 'MCX', symbol: { $in: [...bySymbol.keys()] } })
    .select('symbol lotSize').lean();
  const ops = rows
    .filter((r) => !(Number(r.lotSize) >= 1))
    .map((r) => ({ updateOne: { filter: { _id: r._id }, update: { $set: { lotSize: String(bySymbol.get(r.symbol).lot) } } } }));
  if (ops.length) await Instrument.bulkWrite(ops, { ordered: false });
  return ops.length;
}

module.exports = { MCX_COMMODITIES, ensureMcxCommodities, ensureMcxLotSizes };
