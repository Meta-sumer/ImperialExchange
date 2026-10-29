/**
 * The rulings that change what a trader sees, on EquityHub.
 *
 * docs/PORT-RULINGS.md, adjusted for an INR-only platform: every amount is
 * rupees, grouped the Indian way (§5 has one currency left), with no FX
 * (§4 is moot). The web's own formatters — client/src/utils/format.js and
 * hooks/useMoney.js, EquityHub's — are lifted from the shipped source and
 * run beside utils/money, so the two agree by construction; where the port
 * differs on purpose (a missing figure is "—", not ₹0.00), the difference is
 * pinned.
 */
import fs from 'fs';
import path from 'path';

import {
  accountLabel,
  accountTierLabel,
  isDemoAccount,
  isDemoLike,
  isLiveAccount,
  isRealMoney,
} from '@/utils/accountType';
import {
  CURRENCY_SYMBOL,
  EMPTY,
  currencySymbol,
  fmtInrCompact,
  fmtMarginLevel,
  fmtMoney,
  fmtNum,
  fmtPnl,
  fmtPrice,
  fmtSigned,
} from '@/utils/money';
import type { TradingAccount } from '@/types/trading';

const ROOT = path.join(__dirname, '../../..');
const readLf = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const FORMAT = readLf('client/src/utils/format.js');
const USE_MONEY = readLf('client/src/hooks/useMoney.js');
const ACCOUNT_TYPES = readLf('client/src/utils/accountTypes.js');

const strip = (s: string): string => s.replace(/export const /g, 'const ').replace(/export function /g, 'function ');

type Num = number | string;
interface Web {
  fmtNum: (v: Num, d?: number) => string;
  fmtMoney: (v: Num, c?: string, d?: number) => string;
  fmtPnl: (v: Num) => string;
  fmtPrice: (v: Num, p?: number) => string;
  fmtInrCompact: (v: Num) => string;
  currencySymbol: (c?: string) => string;
  money: (v: Num, d?: number) => string;
  signed: (v: Num, d?: number) => string;
  accountTierLabel: (a: unknown) => string;
  isLiveAccount: (a: unknown) => boolean;
  isDemoAccount: (a: unknown) => boolean;
}

/** EquityHub's format.js and useMoney.js as shipped (imports dropped). */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const W = new Function(`
  ${strip(FORMAT)}
  ${strip(USE_MONEY.replace(/^import .*$/m, '').replace(/export function useMoney[\s\S]*$/, ''))}
  ${strip(ACCOUNT_TYPES)}
  return { fmtNum, fmtMoney, fmtPnl, fmtPrice, fmtInrCompact, currencySymbol, money, signed, accountTierLabel, isLiveAccount, isDemoAccount };
`)() as Web;

/* ══ One currency, Indian grouping ═════════════════════════════════════ */

describe('INR only — every amount is rupees, grouped the Indian way', () => {
  it('the web declares the one currency', () => {
    expect(FORMAT).toMatch(/export const CURRENCY = 'INR';/);
    expect(CURRENCY_SYMBOL).toBe('₹');
  });

  it('groups 12 lakh 34 thousand like the web does', () => {
    expect(fmtNum('1234567.89', 2)).toBe('12,34,567.89');
    expect(fmtNum('1234567.89', 2)).toBe(W.fmtNum('1234567.89', 2));
    expect(fmtNum('123.45', 2)).toBe(W.fmtNum('123.45', 2));
    expect(fmtNum('98765432.1', 0)).toBe(W.fmtNum('98765432.1', 0));
  });

  it('ignores a currency argument, as format.js does — a dollar code still prints rupees', () => {
    expect(currencySymbol('USD')).toBe('₹');
    expect(W.currencySymbol('USD')).toBe('₹');
    expect(fmtMoney('1234567.89', 'USD')).toBe('₹12,34,567.89');
    expect(fmtNum('1234567.89', 2, 'USD')).toBe('12,34,567.89');
    expect(fmtPrice('2450.5', 2, 'USD')).toBe(W.fmtPrice('2450.5', 2));
  });

  it('fmtMoney matches the web: sign first, then ₹', () => {
    for (const v of ['0', '12.3', '-12.3', '1234567.891', '-98765.4']) {
      expect({ v, ours: fmtMoney(v) }).toEqual({ v, ours: W.fmtMoney(v) });
    }
    expect(fmtMoney(1234.5, 'INR', 0)).toBe(W.fmtMoney(1234.5, 'INR', 0));
  });

  it('useMoney().money / .signed are fmtMoney / fmtSigned', () => {
    for (const v of [0, 12.3, -12.3, 1234.5]) {
      expect(fmtMoney(v)).toBe(W.money(v));
      expect(fmtSigned(v)).toBe(W.signed(v));
    }
    expect(fmtSigned(0)).toBe('+₹0.00');
  });

  it('fmtPnl matches the web: an explicit plus on a gain, nothing on zero', () => {
    for (const v of ['1234.56', '-1234.56', '0', 7]) {
      expect({ v, ours: fmtPnl(v) }).toEqual({ v, ours: W.fmtPnl(v) });
    }
    expect(fmtPnl('-1234.56')).toBe('-₹1,234.56');
  });

  it('DIFFERS on purpose: a P&L that rounds to ₹0.00 carries no sign', () => {
    // The web prints "+₹0.00" for 0.004 — a win of nothing.
    expect(W.fmtPnl(0.004)).toBe('+₹0.00');
    expect(fmtPnl(0.004)).toBe('₹0.00');
    expect(fmtPnl(-0.004)).toBe('₹0.00');
  });

  it('compact rupees: K / L / Cr like fmtInrCompact', () => {
    for (const v of [950, 12500, 320000, 14000000, -2500]) {
      expect({ v, ours: fmtInrCompact(v) }).toEqual({ v, ours: W.fmtInrCompact(v) });
    }
  });

  it('DIFFERS on purpose: a missing figure is a dash, not ₹0.00', () => {
    expect(W.fmtMoney(NaN)).toBe('₹0.00');
    expect(fmtMoney(null)).toBe(EMPTY);
    expect(fmtMoney(undefined)).toBe(EMPTY);
    expect(fmtMoney('')).toBe(EMPTY);
    expect(fmtPnl(null)).toBe(EMPTY);
    expect(fmtNum('abc')).toBe(EMPTY);
  });
});

/* ══ Ruling §1 — the margin-level zero case ════════════════════════════ */

describe('margin level', () => {
  it("treats the server's '0' as no margin in use, not as 0%", () => {
    expect(fmtMarginLevel('0')).toBe(EMPTY);
    expect(fmtMarginLevel(0)).toBe(EMPTY);
  });

  it('prints a real level with Indian grouping', () => {
    expect(fmtMarginLevel('550')).toBe('550.00%');
    expect(fmtMarginLevel('1550')).toBe('1,550.00%');
  });

  it('stops printing digits once they stop meaning anything', () => {
    expect(fmtMarginLevel('999999')).toBe('>9999%');
  });

  it('says nothing when the figure is absent', () => {
    expect(fmtMarginLevel(null)).toBe(EMPTY);
  });
});

/* ══ Ruling §3 — one demo-ness predicate ═══════════════════════════════ */

describe('real money vs practice money', () => {
  it('counts every modern live tier as real money', () => {
    for (const t of ['STANDARD', 'STANDARD_IC', 'PRO', 'PRO_IC', 'FREE', 'FREE_IC', 'CUSTOM', 'REAL']) {
      expect({ t, real: isRealMoney(t) }).toEqual({ t, real: true });
    }
  });

  it('counts DEMO and VIRTUAL as practice money', () => {
    expect(isDemoLike('DEMO')).toBe(true);
    expect(isDemoLike('VIRTUAL')).toBe(true);
    expect(isRealMoney('DEMO')).toBe(false);
  });

  it('matches the server predicate exactly', () => {
    // walletController.js — isDemoLike = type === 'DEMO' || type === 'VIRTUAL'
    const server = (t: string): boolean => t === 'DEMO' || t === 'VIRTUAL';
    for (const t of ['DEMO', 'VIRTUAL', 'REAL', 'STANDARD', 'PRO', 'FREE', 'PRO_IC', 'ANYTHING']) {
      expect({ t, ours: isDemoLike(t) }).toEqual({ t, ours: server(t) });
    }
  });

  it('matches accountTypes.js isLiveAccount / isDemoAccount', () => {
    for (const t of ['DEMO', 'VIRTUAL', 'REAL', 'STANDARD', 'pro_ic', 'demo']) {
      const a = { accountType: t };
      expect({ t, live: isLiveAccount(a), demo: isDemoAccount(a) })
        .toEqual({ t, live: W.isLiveAccount(a), demo: W.isDemoAccount(a) });
    }
    expect(isLiveAccount(null)).toBe(W.isLiveAccount(null));
  });

  it('is case-insensitive and safe on an absent type', () => {
    expect(isDemoLike('demo')).toBe(true);
    expect(isDemoLike(null)).toBe(false);
    expect(isRealMoney(undefined)).toBe(true);
  });
});

/* ══ Tier names — accountTypes.js accountTierLabel ═════════════════════ */

describe('accountTierLabel', () => {
  it('matches the web for every kind of account', () => {
    const cases: Record<string, unknown>[] = [
      { accountType: 'STANDARD' },
      { accountType: 'PRO_IC' },
      { accountType: 'FREE' },
      { accountType: 'CUSTOM', customTypeName: 'VIP Desk' },
      { accountType: 'CUSTOM' },
      { accountType: 'GOLD_IC' },
      { accountType: 'DEMO', tierCode: 'PRO' },
      { accountType: 'DEMO' },
      { accountType: 'REAL' },
      { accountType: 'VIRTUAL', tierCode: 'nope' },
    ];
    for (const a of cases) {
      expect({ a, ours: accountTierLabel(a as never) }).toEqual({ a, ours: W.accountTierLabel(a) });
    }
    expect(accountTierLabel(null)).toBe(W.accountTierLabel(null));
  });

  it('reads a demo account’s tier from the server row when it was not lifted', () => {
    expect(accountTierLabel({ accountType: 'DEMO', raw: { tierCode: 'STANDARD_IC' } })).toBe('Standard IC');
  });
});

/* ══ Account naming ════════════════════════════════════════════════════ */

describe('what an account is called', () => {
  const account = (over: Partial<TradingAccount> = {}): TradingAccount => ({
    id: 'a1',
    accountNumber: 'TA900',
    accountType: 'STANDARD',
    baseCurrency: 'INR',
    leverage: 100,
    isActive: true,
    isTradingEnabled: true,
    nickname: null,
    ...over,
  });

  const plans = {
    STANDARD: {
      code: 'STANDARD',
      name: 'Standard',
      description: null,
      feeDisplay: null,
      supportLabel: null,
      instrumentsLabel: null,
      accessLabel: null,
      badge: null,
      minDeposit: null,
      maxLeverage: null,
      isPopular: false,
      isRecommended: false,
      sortOrder: 0,
    },
  };

  it("prefers the admin's tier name over the raw code", () => {
    expect(accountLabel(account(), plans)).toBe('Standard');
  });

  it("the trader's own nickname wins", () => {
    expect(accountLabel(account({ nickname: 'Scalper' }), plans)).toBe('Scalper');
  });

  it('falls back to the code rather than to nothing', () => {
    expect(accountLabel(account(), {})).toBe('STANDARD');
  });
});
