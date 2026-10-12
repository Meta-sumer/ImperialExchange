const mongoose = require('mongoose');

const candleSchema = new mongoose.Schema(
  {
    // NO field-level index here on purpose. The compound index below starts with
    // symbol, so it already serves every query that filters by symbol — and every
    // Candle query in this codebase does. A separate {symbol:1} added no read path
    // and was maintained on every write to a 2.6M-document collection that takes
    // eight upserts per tick per symbol. $indexStats confirmed it: zero reads.
    symbol: { type: String, required: true },
    timeframe: { type: String, enum: ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'], required: true },
    openTime: { type: Date, required: true },
    closeTime: { type: Date, required: true },
    open: { type: String, required: true },
    high: { type: String, required: true },
    low: { type: String, required: true },
    close: { type: String, required: true },
    volume: { type: String, default: '0' },
  },
  { timestamps: false }
);

candleSchema.index({ symbol: 1, timeframe: 1, openTime: 1 }, { unique: true });

module.exports = mongoose.model('Candle', candleSchema);
