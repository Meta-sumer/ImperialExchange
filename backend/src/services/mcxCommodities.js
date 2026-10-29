/**
 * mcxCommodities.js — ensures the MCX commodity instruments exist (gold,
 * silver, crude oil, natural gas, copper).
 *
 * MCX itself has no free quote API, so each row is priced from the matching
 * international futures contract on the FREE Yahoo feed, converted into the
 * rupee unit the MCX contract is quoted in:
 *
 *   price(₹) = Yahoo price (USD) × USDINR × multiplier
 *
 *   GOLD        COMEX GC=F  USD/troy oz  → ₹/10 g      multiplier 10 / 31.1035
 *   SILVER      COMEX SI=F  USD/troy oz  → ₹/kg        multiplier 1000 / 31.1035
 *   CRUDEOIL    NYMEX CL=F  USD/barrel   → ₹/barrel    multiplier 1
 *   NATURALGAS  NYMEX NG=F  USD/mmBtu    → ₹/mmBtu     multiplier 1
 *   COPPER      COMEX HG=F  USD/lb       → ₹/kg        multiplier 2.20462
 *
 * This tracks the real MCX price closely in direction and magnitude but is
 * NOT the exchange print (MCX carries import duty, local premium/discount and
 * contract-expiry basis). The instrument names say "derived" so nobody
 * mistakes it for official MCX data. For exact MCX prices plug in a paid
 * Dhan/Upstox feed and set externalProvider accordingly.
 *
 * The rows carry exchange 'MCX', so services/marketHours.js gates trading to
 * the MCX session (09:00–23:30 IST) and services/marketScope.js keeps them in
 * the Indian-market scope. Idempotent: config refreshed every run, lastPrice
 * only seeded on insert so a re-run never clobbers a live price.
 */
const Instrument = require('../models/Instrument');

const OZ = 31.1035; // grams per troy ounce

const MCX_COMMODITIES = [
  { symbol: 'GOLD',       name: 'Gold (₹/10g, derived from COMEX)',          base: 'GOLD',   yh: 'GC=F', mult: 10 / OZ,   prec: 0, seedLast: '72000', spread: '10',   tick: '1' },
  { symbol: 'SILVER',     name: 'Silver (₹/kg, derived from COMEX)',          base: 'SILVER', yh: 'SI=F', mult: 1000 / OZ, prec: 0, seedLast: '85000', spread: '25',   tick: '1' },
  { symbol: 'CRUDEOIL',   name: 'Crude Oil (₹/bbl, derived from NYMEX WTI)',  base: 'CRUDE',  yh: 'CL=F', mult: 1,         prec: 0, seedLast: '6500',  spread: '2',    tick: '1' },
  { symbol: 'NATURALGAS', name: 'Natural Gas (₹/mmBtu, derived from NYMEX)',  base: 'NATGAS', yh: 'NG=F', mult: 1,         prec: 1, seedLast: '250',   spread: '0.3',  tick: '0.1' },
  { symbol: 'COPPER',     name: 'Copper (₹/kg, derived from COMEX)',          base: 'COPPER', yh: 'HG=F', mult: 2.20462,   prec: 2, seedLast: '850',   spread: '0.5',  tick: '0.05' },
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
          feedConvert: { fx: 'USDINR', multiplier: c.mult },
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
        },
      },
      upsert: true,
    },
  }));

  const res = await Instrument.bulkWrite(ops, { ordered: false });
  return {
    total: MCX_COMMODITIES.length,
    inserted: res.upsertedCount || 0,
    updated: res.modifiedCount || 0,
    symbols: MCX_COMMODITIES.map((c) => c.symbol),
  };
}

module.exports = { MCX_COMMODITIES, ensureMcxCommodities };
