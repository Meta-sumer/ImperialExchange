/**
 * The order ticket's decisions (utils/orderForm) — against EquityHub's own
 * client/src/components/OrderForm.jsx, lifted and run on the same inputs:
 * the account-tier spread, the configured bid/ask, the unified fee
 * breakdown, remembered leverage, the Volume field, the pre-submit checks
 * and the posted body.
 */
import fs from 'fs';
import path from 'path';

import { buildOrderPayload } from '@/api/trading.api';
import {
  buildOrderRequest,
  currentBidAsk,
  effectiveSpread,
  feeEstimate,
  feePlanFor,
  feeTypeMeta,
  initialLeverage,
  leverageStorageKey,
  parseSavedLeverage,
  preSubmitError,
  sideQuotes,
  tradingDisabledBanner,
  volumeField,
  type FeePlan,
} from '@/utils/orderForm';
import type { OrderMode, ProductType } from '@/types/trading';

const ROOT = path.join(__dirname, '../../..');
const readLf = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const FORM = readLf('client/src/components/OrderForm.jsx');
const FEE_TYPE = readLf('client/src/utils/feeType.js');
const between = (src: string, start: string, end: string): string => {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`slice start moved: ${start}`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`slice end moved: ${end}`);
  return src.slice(a, b);
};
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const lift = <T,>(params: string[], body: string): T => new Function(...params, body) as unknown as T;

const WEB_FEE_TYPE = `${between(FEE_TYPE, 'const FEE_TYPE_META = {', '\n// Accepts')}\nconst feeTypeMeta = (code) => FEE_TYPE_META[String(code || '').toUpperCase()] || null;`;

const PLANS: Record<string, FeePlan> = {
  STANDARD: { feeKind: 'PCT_OF_VALUE', feeValue: 0.00005, feeDisplay: '0.005% of trade value', defaultSpreadValue: null, defaultSpreadType: 'FIXED' },
  PRO: { feeKind: 'FIXED_PER_TRADE', feeValue: 10, feeDisplay: '₹10 fixed per trade', defaultSpreadValue: '0.20', defaultSpreadType: 'FIXED' },
  FREE: { feeKind: 'PCT_OF_PROFIT', feeValue: 0.01, feeDisplay: '1% of profit · zero fee for losing trades', defaultSpreadValue: '0.0004', defaultSpreadType: 'PERCENTAGE' },
};
const RELIANCE = {
  symbol: 'RELIANCE', exchange: 'NSE', segment: 'EQ', category: 'STOCK', lastPrice: '2500', pricePrecision: 2,
  spreadValue: '0.10', spreadType: 'FIXED' as const, tickSize: '0.05', upperCircuit: '2750', lowerCircuit: '2250', freezeQty: '5000',
  accountSpreads: [{ accountType: 'ECN', spreadValue: '0.04', spreadType: 'FIXED' }],
};
const NIFTY_FUT = { symbol: 'NIFTY26OCTFUT', exchange: 'NFO', segment: 'FUT', category: 'INDEX', lastPrice: '24000', pricePrecision: 2, lotSize: 75, spreadValue: '1', spreadType: 'FIXED' as const };
const CRUDE_FUT = { symbol: 'CRUDEOIL26OCTFUT', exchange: 'MCX', segment: 'FUT', category: 'COMMODITY', lastPrice: '6000', lotSize: 100, contractUnit: 'bbl' };

describe('the effective spread — OrderForm.jsx effSpread (backend spreadService)', () => {
  const web = lift<(account: unknown, instrument: unknown, acctPlanByCode: unknown) => { value: number; type: string }>(
    ['account', 'instrument', 'acctPlanByCode'],
    `${between(FORM, '  const effSpread = useMemo(() => {', '  }, [account?.accountType').replace('  const effSpread = useMemo(() => {', '')}`,
  );
  it.each([
    ['the account tier\'s own override on the instrument', 'ECN'],
    ['else the tier plan\'s default', 'PRO'],
    ['a percentage plan default', 'FREE'],
    ['else the instrument\'s global spread', 'STANDARD'],
    ['no account', null],
  ])('%s', (_l, accountType) => {
    expect(effectiveSpread(RELIANCE as never, accountType, PLANS)).toEqual(web(accountType ? { accountType } : null, RELIANCE, PLANS));
  });
  it('bid / ask from the last price and that spread — never the feed', () => {
    const webBidAsk = lift<(instrument: unknown, effSpread: unknown) => { bid: number; ask: number }>(
      ['instrument', 'effSpread'],
      between(FORM, '  const currentBidAsk = useMemo(() => {', '  }, [instrument?.lastPrice, effSpread]);').replace('  const currentBidAsk = useMemo(() => {', ''),
    );
    for (const at of ['ECN', 'PRO', 'FREE', 'STANDARD']) {
      const sp = effectiveSpread(RELIANCE as never, at, PLANS);
      expect(currentBidAsk(RELIANCE as never, sp)).toEqual(webBidAsk(RELIANCE, sp));
    }
    expect(currentBidAsk({ lastPrice: '0' } as never, { value: 1, type: 'FIXED' })).toEqual({ bid: 0, ask: 0 });
    const q = sideQuotes({ ...RELIANCE, bid: '1', ask: '9999' } as never, effectiveSpread(RELIANCE as never, 'ECN', PLANS));
    expect([q.bid, q.ask, q.spreadAbs]).toEqual([2499.98, 2500.02, expect.closeTo(0.04, 10)]);
  });
});

describe('the fee breakdown — OrderForm.jsx (Total Fee = Commission + Charges + Spread Cost)', () => {
  const web = lift<(p: Record<string, unknown>) => { feeEstimate: number | null; chargesPending: boolean; feeHelp: string }>(
    ['p'],
    `${WEB_FEE_TYPE}
     const { qtyNum, notional, hasQuotes, spreadAbs, prec, account, acctPlanByCode, instrument, productType } = p;
     ${between(FORM, '  const fmtQuote = (v) =>', '\n  // Notional is denominated')}
     ${between(FORM, '  const hasQty = qtyNum > 0 && notional > 0;', '\n  const sideIsBuy')}
     return { feeEstimate, chargesPending, feeHelp };`,
  );
  it.each([
    ['STANDARD — commission, % of value, delivery', 'STANDARD', RELIANCE, 10, 'DELIVERY'],
    ['STANDARD — intraday', 'STANDARD', RELIANCE, 10, 'INTRADAY'],
    ['PRO — a flat charge', 'PRO', RELIANCE, 4, 'INTRADAY'],
    ['FREE — 1% of profit, pending until close', 'FREE', RELIANCE, 10, 'INTRADAY'],
    ['a legacy tier falls back to STANDARD', 'LEGACY', RELIANCE, 10, 'DELIVERY'],
    ['a future — no statutory pass-through', 'PRO', NIFTY_FUT, 75, 'INTRADAY'],
    ['no size yet', 'STANDARD', RELIANCE, 0, 'DELIVERY'],
  ] as Array<[string, string, Record<string, unknown>, number, ProductType]>)('%s — as the web', (_l, accountType, instrument, qtyNum, productType) => {
    const spread = effectiveSpread(instrument as never, accountType, PLANS);
    const quotes = sideQuotes(instrument as never, spread);
    const notional = qtyNum * Number(instrument.lastPrice);
    const mine = feeEstimate({ instrument: instrument as never, notional, qtyNum, productType, quotes, plan: feePlanFor(accountType, PLANS) });
    const theirs = web({ qtyNum, notional, hasQuotes: quotes.hasQuotes, spreadAbs: quotes.spreadAbs, prec: quotes.prec, account: { accountType }, acctPlanByCode: PLANS, instrument, productType });
    expect(mine.chargesPending).toBe(theirs.chargesPending);
    if (theirs.feeEstimate === null) expect(mine.feeEstimate).toBeNull();
    else expect(mine.feeEstimate).toBeCloseTo(theirs.feeEstimate, 10);
    expect(mine.feeHelp).toBe(theirs.feeHelp);
  });
  it('fee kinds group as feeType.js does', () => {
    const webMeta = lift<() => (c: unknown) => unknown>([], `${WEB_FEE_TYPE}\nreturn feeTypeMeta;`)();
    for (const k of ['PERCENTAGE', 'PCT_OF_VALUE', 'FIXED', 'FIXED_PER_TRADE', 'PCT_OF_PROFIT', 'pct_of_value', 'OTHER', null]) {
      expect(feeTypeMeta(k)).toEqual(webMeta(k));
    }
  });
});

describe('remembered leverage — OrderForm.jsx _levKey / _readSavedLeverage / initialLev', () => {
  const web = lift<() => { key: (id: unknown) => string; read: (raw: unknown) => number | null }>(
    [],
    `${between(FORM, 'const _levKey = ', '\nconst _readSavedLeverage')}
     return { key: _levKey, read: (raw) => { const n = Number(raw); return Number.isFinite(n) && n >= 1 ? n : null; } };`,
  )();
  it('one key per account', () => {
    expect(leverageStorageKey('a1')).toBe(web.key('a1'));
    expect(leverageStorageKey(null)).toBe(web.key(null));
    expect(leverageStorageKey('a1')).toBe('tradepro:leverage:a1');
  });
  it.each(['20', '1', '0.5', 'abc', ''])('a stored %j reads as the web reads it', (raw) => {
    expect(parseSavedLeverage(raw)).toBe(web.read(raw));
  });
  it('the starting leverage: the saved one, else the account\'s, inside the ceiling', () => {
    expect(FORM).toContain('Math.max(1, _readSavedLeverage(account?._id) || Number(account?.leverage) || 1)');
    expect(initialLeverage({ leverage: 5 }, 10, 8)).toBe(8);
    expect(initialLeverage({ leverage: 5 }, 10, null)).toBe(5);
    expect(initialLeverage({ leverage: 50 }, 10, null)).toBe(10);
    expect(initialLeverage(null, 10, null)).toBe(1);
  });
});

describe('the Volume field — units for F&O, with the lot equivalent', () => {
  it('cash equity: plain "Volume"', () => {
    expect(volumeField(RELIANCE as never, 10)).toMatchObject({ label: 'Volume', subtext: null });
  });
  it('a future counts units: "Volume (1 lot = 75)", "= 2 lots"', () => {
    expect(volumeField(NIFTY_FUT as never, 150)).toMatchObject({ label: 'Volume (1 lot = 75)', subtext: '= 2 lots' });
    expect(volumeField(NIFTY_FUT as never, 75)).toMatchObject({ subtext: '= 1 lot' });
    expect(volumeField(NIFTY_FUT as never, 0)).toMatchObject({ subtext: null });
  });
  it('MCX names its contract unit', () => {
    expect(FORM).toContain("label={isDeriv ? `Volume (1 lot = ${lotSz}${instrument?.contractUnit ? ` ${instrument.contractUnit}` : ''})` : 'Volume'}");
    expect(volumeField(CRUDE_FUT as never, 150).label).toBe('Volume (1 lot = 100 bbl)');
    expect(volumeField(CRUDE_FUT as never, 150).subtext).toBe('= 1.5 lots');
  });
});

describe('submitting — OrderForm.jsx submit()', () => {
  const webCheck = lift<(p: Record<string, unknown>) => string | null>(
    ['p'],
    `const { effectiveSide, tradingDisabled, account, quantity, orderMode, price, limitInvalidReason, instrument } = p;
     const toast = { error: (m) => m };
     ${between(FORM, '    if (!effectiveSide) return toast.error', '    // Confirmation step')}
     return null;`,
  );
  const base = { side: 'BUY' as const, hasAccount: true, quantity: '10', orderMode: 'MARKET' as OrderMode, price: '', limitInvalidReason: '' };
  const inst = { ...RELIANCE, tradingEnabled: true };
  it.each([
    ['no side', { side: null }, inst],
    ['trading switched off', {}, { ...inst, tradingEnabled: false }],
    ['no account', { hasAccount: false }, inst],
    ['no quantity', { quantity: '0' }, inst],
    ['a limit without a price', { orderMode: 'LIMIT', price: '' }, inst],
    ['a limit the form already refused', { orderMode: 'LIMIT', price: '2400', limitInvalidReason: 'Limit price cannot be equal to current market price. Use Market order instead.' }, inst],
    ['off the tick', { orderMode: 'LIMIT', price: '2400.03' }, inst],
    ['above the upper circuit', { orderMode: 'LIMIT', price: '2800' }, inst],
    ['below the lower circuit', { orderMode: 'LIMIT', price: '2200' }, inst],
    // A stored band that cannot be right (upper 0.03 on a ₹1.4 lakh future) or
    // that the live price has already left (widened intraday) is not enforced.
    ['a broken band is not enforced', { orderMode: 'LIMIT', price: '142845' }, { ...inst, exchange: 'MCX', tickSize: '1', upperCircuit: '0.03', lowerCircuit: null, lastPrice: '142876' }],
    ['a band the price has crossed is not enforced', { orderMode: 'LIMIT', price: '2790' }, { ...inst, lastPrice: '2800' }],
    ['over the freeze quantity', { quantity: '6000' }, inst],
    ['a valid limit', { orderMode: 'LIMIT', price: '2400.05' }, inst],
    ['a valid market order', {}, inst],
  ] as Array<[string, Record<string, unknown>, Record<string, unknown>]>)('%s — the web\'s words', (_l, over, instrument) => {
    const c = { ...base, ...over };
    const mine = preSubmitError({ instrument: instrument as never, ...c } as never);
    const theirs = webCheck({
      effectiveSide: c.side, tradingDisabled: instrument.tradingEnabled === false, account: c.hasAccount ? {} : null,
      quantity: c.quantity, orderMode: c.orderMode, price: c.price, limitInvalidReason: c.limitInvalidReason, instrument,
    });
    expect(mine).toBe(theirs);
  });

  it('the posted body is the web\'s payload, key for key', () => {
    const webPayload = lift<(p: Record<string, unknown>) => Record<string, unknown>>(
      ['p'],
      `const { account, instrument, effectiveSide, orderMode, quantity, leverage, price, isIndianEquity, productType, stopLoss, takeProfit } = p;
       ${between(FORM, '      const payload = {', '      const { data } = await api.post')}
       return payload;`,
    );
    const cases = [
      { orderMode: 'MARKET', price: '', productType: 'INTRADAY', indianEquity: true, stopLoss: '0', takeProfit: '2600' },
      { orderMode: 'LIMIT', price: '2400.05', productType: 'DELIVERY', indianEquity: true, stopLoss: '2300', takeProfit: '' },
      { orderMode: 'MARKET', price: '', productType: 'DELIVERY', indianEquity: false, stopLoss: '', takeProfit: '' },
    ] as const;
    for (const c of cases) {
      const mine = buildOrderPayload(buildOrderRequest({ accountId: 'a1', symbol: 'RELIANCE', side: 'SELL', quantity: '10', leverage: 5, idempotencyKey: 'k', ...c }));
      const theirs = webPayload({ account: { _id: 'a1' }, instrument: { symbol: 'RELIANCE' }, effectiveSide: 'SELL', quantity: '10', leverage: 5, isIndianEquity: c.indianEquity, ...c });
      expect({ ...mine, idempotencyKey: 'k' }).toEqual({ ...theirs, idempotencyKey: 'k' });
    }
  });

  it('the trading-disabled banner names the symbol', () => {
    expect(tradingDisabledBanner({ symbol: 'RELIANCE' } as never)).toBe('Trading is disabled for RELIANCE. You can still close open positions.');
  });
});
