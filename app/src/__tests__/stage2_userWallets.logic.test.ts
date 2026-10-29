/**
 * The Bonus Wallet is the web's BonusWallet page (with its Add Funds
 * DepositModal and its WithdrawModal) on a phone — so its rules are checked
 * against the WEB'S OWN SOURCE, not a re-typed copy. The Main Wallet
 * (SubscriptionWallet.jsx) is retired; the Bonus Wallet took over its job.
 *
 * Each block lifts the slice it needs out of the shipped web file
 * (client/src/…), runs it with `new Function`, and runs this app's version
 * on the same inputs. If either side changes, this fails.
 *
 * Where the app deliberately differs from the web, the test says so and pins
 * the difference instead of hiding it.
 */
import fs from 'fs';
import path from 'path';

import { toMySubscription, toSubscription } from '@/types/subscription';
import { toDepositDetails, toWalletTransaction, type DepositDetails } from '@/types/wallet';
import type { UserAccount } from '@/types/user';
import {
  BONUS_REASON_LABEL,
  BONUS_STATUS_OPTIONS,
  DEPOSIT_STEPS,
  LOW_BALANCE_WARNING,
  EMPTY_BONUS_FILTER,
  TOPUP_FIXED_METHODS,
  TOPUP_TRADING_METHOD,
  SUBSCRIPTION_STATUS_BADGE,
  accountWalletBalance,
  autoRenewNote,
  autoRenewToast,
  billingCycleSub,
  bonusAmountText,
  bonusRecordsLabel,
  bonusStats,
  bonusTypeOptions,
  cleanAmountInput,
  dayAllowed,
  dayStart,
  depositCanNext,
  depositSubmitError,
  filterBonusTxns,
  hasBonusFilter,
  inCustomRange,
  instantTopUpBody,
  isYmd,
  topUpAmountNote,
  topUpMethods,
  topUpPayTo,
  topUpPayToRail,
  topUpPresets,
  billingWalletIsLow,
  manualDepositBody,
  maxWithdrawAmount,
  monthGrid,
  nextDayStart,
  oldestAccountId,
  planCountdown,
  planPeriodEnd,
  planPeriodLabel,
  settleSourceAccount,
  subscriptionStatusBadge,
  topUpSourceAccounts,
  userWithdrawCheck,
  userWithdrawRailBits,
  txReferencePlaceholder,
  txnStatusTone,
  withdrawAmountValid,
  withdrawBody,
  withdrawSubmitError,
  type BonusFilter,
  type DepositDraft,
  type TopUpMethod,
} from '@/utils/userWallets';
import { payoutRailTypes, toWithdrawalMethod, verifiedForRail } from '@/types/wallet';
import { withdrawRails } from '@/utils/fundsFlows';
import { EMPTY, fmtMoney } from '@/utils/money';

const ROOT = path.join(__dirname, '../../..');
/** LF only, so a CRLF checkout slices the same as this one. */
const readLf = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const web = (p: string): string => readLf(path.join(ROOT, 'client/src', p));

/** The text from `start` up to (not including) `end`, or a loud failure. */
const between = (src: string, start: string, end: string, from = 0): string => {
  const a = src.indexOf(start, from);
  if (a < 0) throw new Error(`slice start moved: ${start}`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`slice end moved: ${end}`);
  return src.slice(a, b);
};
/** `start` through the end of `end`. */
const through = (src: string, start: string, end: string, from = 0): string =>
  between(src, start, end, from) + end;
/** Only the part after `start` (the opening line itself dropped). */
const after = (src: string, start: string, end: string): string =>
  between(src, start, end).slice(start.length);

// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const lift = <T,>(params: string[], body: string): ((...args: unknown[]) => T) =>
  new Function(...params, body) as (...args: unknown[]) => T;

/** An ES module's exports, run as a plain script. */
const liftModule = <T,>(src: string, names: string[]): T =>
  lift<T>([], `${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();

const DEPOSIT = web('components/DepositModal.jsx');
const BONUS = web('pages/BonusWallet.jsx');
const WITHDRAW = web('components/WithdrawModal.jsx');

/* ══ The plan countdown (BonusWallet.jsx) ═══════════════════════════ */

describe('plan countdown — the web pages\' own block, run beside ours', () => {
  // The page computes it inline from `sub.expiresAt` only (no postpaid
  // billing anchor on EquityHub). The clock is passed in for the test.
  const body = (src: string, start: string, end: string): string =>
    between(src, start, end).slice(start.length).replace('new Date(sub.expiresAt) - new Date()', 'new Date(sub.expiresAt) - now');
  const webBonus = lift<Record<string, unknown> | null>(['sub', 'now'], body(BONUS, 'const countdown = (() => {', '})();'));
  const webSub = lift<string>(['sub'], `return ${between(BONUS, "sub={sub?.expiresAt ? ", "}\n").slice('sub={'.length)};`);

  const NOW = new Date('2026-09-29T12:00:00Z');
  const CASES: Array<[string, { expiresAt?: string | null; nextBillingAt?: string | null } | null]> = [
    ['no subscription', null],
    ['nothing dated', { expiresAt: null, nextBillingAt: null }],
    ['an expiry 12d 4h out', { expiresAt: '2026-10-11T16:30:00Z', nextBillingAt: null }],
    ['an expiry already past', { expiresAt: '2026-09-01T00:00:00Z' }],
    ['a billing anchor alone is not read', { expiresAt: null, nextBillingAt: '2026-10-29T12:00:00Z' }],
    ['exactly now', { expiresAt: '2026-09-29T12:00:00Z' }],
  ];

  it.each(CASES)('%s', (_name, sub) => {
    const mine = sub ? toSubscription({ planCode: 'PREMIUM', ...sub }) : null;
    const c = planCountdown(mine, NOW);
    // The page keeps only the label (no days / hours fields).
    expect(c && { expired: c.expired, label: c.label }).toEqual(webBonus(sub, NOW));
    if (c && !c.expired) expect(c.label).toBe(`${c.days}d ${c.hours}h`);
    expect(planPeriodLabel(mine)).toBe(webSub(sub));
    expect(planPeriodEnd(mine)?.source ?? null).toBe(sub?.expiresAt ? 'expiry' : null);
  });

  it('DIFFERENCE: an unreadable expiry is no date at all (the web shows "NaNd NaNh")', () => {
    const sub = { expiresAt: 'not a date' };
    expect(webBonus(sub, NOW)).toMatchObject({ label: 'NaNd NaNh' });
    expect(planCountdown(toSubscription(sub), NOW)).toBeNull();
    expect(planPeriodLabel(toSubscription(sub))).toBe('No renewal scheduled');
  });
});

/* ══ dateRange.js ══════════════════════════════════════════════════════ */

describe('dateRange — inclusive day range, run beside the web', () => {
  const webRange = liftModule<{
    dayStart: (v: unknown) => Date | null;
    nextDayStart: (v: unknown) => Date | null;
    inCustomRange: (v: unknown, f: unknown, t: unknown) => boolean;
  }>(web('utils/dateRange.js'), ['dayStart', 'nextDayStart', 'inCustomRange', 'DAY_MS']);

  const day = (y: number, m: number, d: number, h = 0, min = 0): string => new Date(y, m - 1, d, h, min).toISOString();
  const VALUES = [day(2026, 9, 10, 0, 0), day(2026, 9, 10, 23, 59), day(2026, 9, 11, 0, 0), day(2026, 9, 9, 23, 59), 'garbage', ''];
  const RANGES: Array<[string, string]> = [
    ['2026-09-10', '2026-09-10'],
    ['2026-09-10', ''],
    ['', '2026-09-10'],
    ['', ''],
    ['2026-09-09', '2026-09-11'],
  ];

  it('matches the web on every value × range', () => {
    for (const v of VALUES) {
      for (const [f, t] of RANGES) {
        expect({ v, f, t, in: inCustomRange(v, f, t) }).toEqual({ v, f, t, in: webRange.inCustomRange(v, f, t) });
      }
    }
  });

  it('From == To is that whole day, not nothing', () => {
    expect(inCustomRange(day(2026, 9, 10, 23, 59), '2026-09-10', '2026-09-10')).toBe(true);
    expect(inCustomRange(day(2026, 9, 11, 0, 0), '2026-09-10', '2026-09-10')).toBe(false);
  });

  it('day bounds agree', () => {
    for (const v of ['2026-02-28', '2026-12-31', day(2026, 3, 29, 1, 30)]) {
      expect(dayStart(v)?.getTime()).toBe(webRange.dayStart(v)?.getTime());
      expect(nextDayStart(v)?.getTime()).toBe(webRange.nextDayStart(v)?.getTime());
    }
    expect(dayStart('')).toBeNull();
  });

  it('the picker only yields real calendar days, bounded like the web inputs', () => {
    expect(isYmd('2026-02-28')).toBe(true);
    expect(isYmd('2026-02-31')).toBe(false);
    expect(isYmd('2026-9-1')).toBe(false);
    // From has max={toDate}; To has min={fromDate}.
    expect(dayAllowed('2026-09-10', undefined, '2026-09-10')).toBe(true);
    expect(dayAllowed('2026-09-11', undefined, '2026-09-10')).toBe(false);
    expect(dayAllowed('2026-09-09', '2026-09-10', undefined)).toBe(false);
    const sept = monthGrid(2026, 8);
    expect(sept.length % 7).toBe(0);
    expect(sept.filter(Boolean)).toHaveLength(30);
    // 1 Sep 2026 is a Tuesday: two blanks first.
    expect(sept.slice(0, 3)).toEqual([null, null, '2026-09-01']);
  });
});

/* ══ BonusWallet.jsx — the plan tiles (plans are billed from here) ═════ */

describe('Main Wallet page — Subscription tiles, auto-renew, low balance', () => {
  it('status badges are the web table, verbatim', () => {
    const webTone = lift<Record<string, { bg: string; fg: string; label: string }>>(
      [],
      `return ${between(BONUS, 'const statusTone = {', '}[status]').replace('const statusTone = ', '')}};`,
    )();
    for (const [k, v] of Object.entries(webTone)) {
      expect(SUBSCRIPTION_STATUS_BADGE[k]).toEqual({ fg: v.fg, label: v.label });
      expect(v.bg).toBe(`${v.fg}18`);
    }
    expect(Object.keys(SUBSCRIPTION_STATUS_BADGE).sort()).toEqual(Object.keys(webTone).sort());
  });

  it('the badge falls back as the web does', () => {
    const free = toMySubscription({ subscription: null, effectivePlan: { code: 'FREE', name: 'Free' } });
    expect(subscriptionStatusBadge(free).label).toBe('Free plan');
    expect(subscriptionStatusBadge(toMySubscription({ subscription: null })).label).toBe('No subscription');
    expect(subscriptionStatusBadge(toMySubscription({ subscription: { status: 'PENDING_PAYMENT' } })).label).toBe('Payment pending');
    // Unknown statuses are shown as the server wrote them.
    expect(subscriptionStatusBadge(toMySubscription({ subscription: { status: 'GRACE' } }))).toEqual({ fg: '#6B7280', label: 'GRACE' });
    expect(billingCycleSub(toSubscription({ billingCycle: 'YEARLY' }))).toBe('yearly billing');
  });

  it('the low-balance rule matches the web', () => {
    // The server's flag (bonusWalletService.isLowBalance: threshold ≥ balance).
    const webIsLow = lift<boolean>(['wallet'], `${through(BONUS, 'const isLow = ', ';')}\n return !!isLow;`);
    const CASES = [
      { balance: '50', lowBalanceThreshold: '10', isLowBalance: false },
      { balance: '10', lowBalanceThreshold: '10', isLowBalance: false },
      { balance: '5', lowBalanceThreshold: '10', isLowBalance: false },
      { balance: '500', lowBalanceThreshold: '10', isLowBalance: true },
      { balance: '0', lowBalanceThreshold: '0', isLowBalance: false },
    ];
    for (const w of CASES) expect(billingWalletIsLow(w)).toBe(webIsLow(w));
    expect(billingWalletIsLow(null)).toBe(false);
  });

  it('the auto-renew copy and the low-balance warning match the web', () => {
    expect(BONUS).toContain('toast.success(`Auto-renew ${next ? \'enabled\' : \'disabled\'}`)');
    expect(BONUS).toContain("api.post('/bonus-wallet/auto-renew', { enabled: next })");
    expect(autoRenewToast(true)).toBe('Auto-renew enabled');
    expect(autoRenewToast(false)).toBe('Auto-renew disabled');
    expect(BONUS).toContain('Plan renewals are deducted from this Main Wallet. {wallet?.gracePeriodDays || 0}-day grace period.');
    expect(autoRenewNote(3)).toBe('Plan renewals are deducted from this Main Wallet. 3-day grace period.');
    expect(autoRenewNote(null)).toBe('Plan renewals are deducted from this Main Wallet. 0-day grace period.');
    expect(BONUS).toContain(LOW_BALANCE_WARNING);
    expect(txnStatusTone('SUCCESS')).toBe('bull');
    expect(txnStatusTone('FAILED')).toBe('bear');
    expect(txnStatusTone('PENDING')).toBe('warn');
  });
});

/* ══ DepositModal.jsx — the Bonus Wallet's Add Funds ═══════════════════ */

describe('Main Wallet Add Funds — the web DepositModal, run beside ours', () => {
  const METHODS_SRC = through(DEPOSIT, 'const FIXED_METHODS = [', '];') + through(DEPOSIT, 'const TRADING_METHOD = {', '};');
  const webConsts = lift<{ FIXED_METHODS: Array<Record<string, unknown>>; TRADING_METHOD: Record<string, unknown> }>(
    [],
    `${METHODS_SRC}\nreturn { FIXED_METHODS, TRADING_METHOD };`,
  )();
  const HELPERS = through(DEPOSIT, 'const railRules = (cfg) => ({', '});');
  const webMethods = lift<Array<Record<string, unknown>>>(
    ['payDetails', 'payState', 'FIXED_METHODS', 'TRADING_METHOD'],
    `${HELPERS}\n${after(DEPOSIT, 'const methods = useMemo(() => {', '}, [payDetails, payState]);')}`,
  );

  const RAW_DETAILS = {
    UPI: { upiId: 'pay@okaxis', payeeName: 'Equity Hub', enabled: true, note: 'UPI only', qr: 'data:image/png;base64,QR', minDeposit: 500, maxDeposit: 100000, feePercent: 1 },
    BANK: { accountName: 'Equity Hub Pvt', accountNumber: '001122334455', ifsc: 'HDFC0000001', bankName: 'HDFC', enabled: false },
    RAZORPAY: { enabled: true },
    custom: [
      { id: 'cash', label: 'Cash Deposit', emoji: '💵', enabled: true, minDeposit: 2500, feeFixed: 10, fields: [{ label: 'Branch', value: 'Andheri', copy: true }, { label: 'Ref', value: '', copy: false }], note: 'Cash note', qr: '' },
      { id: 'off', label: 'Closed', enabled: false, minDeposit: 5, fields: [] },
      { id: 'nomin', label: 'No Min', enabled: true, fields: [{ label: 'Acct', value: '42', copy: false }] },
      { id: 'nolabel', label: '', enabled: true, fields: [] },
    ],
  };
  const DETAILS: DepositDetails = toDepositDetails(RAW_DETAILS);

  const shape = (m: object): Record<string, unknown> => {
    const r = m as Record<string, unknown>;
    return {
      id: r.id, label: r.label, sub: r.sub, kind: r.kind, emoji: r.emoji,
      min: r.min ?? 0, max: r.max ?? 0, feePercent: r.feePercent ?? 0, feeFixed: r.feeFixed ?? 0,
    };
  };

  it('the fixed rails and the instant transfer are the web lists, verbatim', () => {
    expect(TOPUP_FIXED_METHODS.map(shape)).toEqual(webConsts.FIXED_METHODS.map(shape));
    expect(shape(TOPUP_TRADING_METHOD)).toEqual(shape(webConsts.TRADING_METHOD));
    // UPI and Bank only: no Crypto / Skrill / Neteller on EquityHub.
    expect(TOPUP_FIXED_METHODS.map((m) => m.id)).toEqual(['UPI', 'BANK']);
  });

  it('the picker list matches the web for every settings state: nothing while loading, only the transfer on error', () => {
    const cases: Array<[unknown, 'loading' | 'ready' | 'error']> = [
      [RAW_DETAILS, 'ready'], [{}, 'ready'], [null, 'loading'], [null, 'error'], [RAW_DETAILS, 'loading'],
    ];
    for (const [details, state] of cases) {
      const w = webMethods(details, state, webConsts.FIXED_METHODS, webConsts.TRADING_METHOD);
      const m = topUpMethods(details ? toDepositDetails(details) : null, state);
      expect({ state, ids: m.map(shape) }).toEqual({ state, ids: w.map(shape) });
    }
    expect(topUpMethods(DETAILS, 'ready').map((x) => x.id)).toEqual(['UPI', 'CUSTOM:cash', 'CUSTOM:nomin', 'TRADING']);
    const upi = topUpMethods(DETAILS, 'ready')[0];
    expect(upi).toMatchObject({ min: 500, max: 100000, feePercent: 1 });
  });

  it('quick amounts are the web block: min (or ₹1,000) × 1 / 5 / 10 / 50, capped at the max', () => {
    const webPresets = lift<number[]>(['payMin', 'payMax', 'payRate'], `${between(DEPOSIT, 'const base = payMin > 0', 'return list;')}return list;`);
    const pairs: Array<[number, number]> = [[0, 0], [100, 0], [99.5, 0], [500, 100000], [500, 4000], [500, 400], [0, 20000], [2500, 0]];
    for (const [min, max] of pairs) expect({ min, max, p: topUpPresets(min, max) }).toEqual({ min, max, p: webPresets(min, max, 1) });
    expect(topUpPresets(0)).toEqual([1000, 5000, 10000, 50000]);
  });

  it('the limits line under the amount is the web copy', () => {
    expect(DEPOSIT).toContain('`Minimum for ${method.label} is ${paySym}${fmt(payMin)}`');
    expect(DEPOSIT).toContain('`Maximum for ${method.label} is ${paySym}${fmt(payMax)} per transaction`');
    const upi = { label: 'UPI', min: 500, max: 100000 };
    expect(topUpAmountNote(upi, '100')).toEqual({ text: 'Minimum for UPI is ₹500.00', error: true });
    expect(topUpAmountNote(upi, '200000')).toEqual({ text: 'Maximum for UPI is ₹1,00,000.00 per transaction', error: true });
    expect(topUpAmountNote(upi, '1000')).toEqual({ text: 'Min ₹500.00 · Max ₹1,00,000.00', error: false });
    expect(topUpAmountNote({ label: 'X', min: 0, max: 5000 }, '')).toEqual({ text: 'Max ₹5,000.00', error: false });
    expect(topUpAmountNote({ label: 'X', min: 0, max: 0 }, '10')).toBeNull();
  });

  it('"Continue" is live exactly when the web says so — the rail must still be listed, and the max is checked', () => {
    const webCanNext = lift<boolean>(
      ['step', 'method', 'methods', 'n', 'payMin', 'payMax', 'sourceAccountId', 'txReference', 'screenshot'],
      after(DEPOSIT, 'const canNext = () => {', '\n  };'),
    );
    const listed = topUpMethods(DETAILS, 'ready');
    const upi = listed[0] as TopUpMethod;
    const bank = { ...(TOPUP_FIXED_METHODS[1] as TopUpMethod) }; // closed: not in the list
    const methods: Array<TopUpMethod | null> = [null, upi, bank, TOPUP_TRADING_METHOD];
    const amounts = ['', '0', '499', '500', '1', 'abc', '100000', '100001'];
    for (let step = 0; step <= 3; step++) {
      for (const method of methods) {
        for (const amount of amounts) {
          for (const src of ['', 'acc1']) {
            for (const ref of ['', '  ', 'UTR1']) {
              for (const proof of [false, true]) {
                const draft: DepositDraft = { method, amount, sourceAccountId: src, txReference: ref, hasProof: proof };
                const w = webCanNext(step, method, listed, Number(amount), method?.min || 0, method?.max || 0, src, ref, proof ? 'data:x' : null);
                expect({ step, m: method?.id, amount, src, ref, proof, ok: depositCanNext(step, draft, listed) })
                  .toEqual({ step, m: method?.id, amount, src, ref, proof, ok: w });
              }
            }
          }
        }
      }
    }
  });

  it('submit refuses with the web messages, in the web order', () => {
    const webSubmit = lift<string | undefined>(
      ['n', 'method', 'txReference', 'screenshot', 'sourceAccountId', 'toast', 'submitInstant', 'submitManual'],
      after(DEPOSIT, 'const submit = () => {', '\n  };'),
    );
    const toast = { error: (m: string) => m };
    const instant = (src: string) => () => (src ? undefined : 'Pick a trading account');
    const upi = TOPUP_FIXED_METHODS[0] as TopUpMethod;
    for (const method of [upi, TOPUP_TRADING_METHOD]) {
      for (const amount of ['', '-1', '0', '5']) {
        for (const ref of ['', 'R']) {
          for (const proof of [false, true]) {
            for (const src of ['', 'a1']) {
              const w = webSubmit(Number(amount), method, ref, proof ? 'x' : null, src, toast, instant(src), () => undefined);
              const m = depositSubmitError({ method, amount, txReference: ref, hasProof: proof, sourceAccountId: src });
              expect(m ?? undefined).toBe(w);
            }
          }
        }
      }
    }
  });

  it('the manual deposit body is the web body, in INR — minus a sender field the rail does not show', async () => {
    const webManual = lift<Promise<unknown>>(
      ['api', 'setSubmitting', 'toast', 'onSuccess', 'errorMessage', 'n', 'payCcy', 'method', 'txReference',
        'senderName', 'senderUpiId', 'senderBankAccount', 'screenshot', 'screenshotMimeType'],
      `return (${after(DEPOSIT, 'const submitManual = ', '\n  };')}\n  })();`,
    );
    const post = jest.fn(async () => ({}));
    const noop = (): void => undefined;
    const run = async (method: TopUpMethod, f: { upi: string; bank: string; name: string }): Promise<unknown> => {
      post.mockClear();
      await webManual({ post }, noop, { success: noop, error: noop }, noop, String, 1500, 'INR', method, '  UTR123  ',
        f.name, f.upi, f.bank, 'data:image/jpeg;base64,AAA', 'image/jpeg');
      const [url, body] = (post.mock.calls[0] as unknown as [string, Record<string, unknown>]);
      expect(url).toBe('/bonus-wallet/manual-deposit');
      return JSON.parse(JSON.stringify(body)); // what reaches the wire: undefined dropped
    };
    const common = { amount: '1500', txReference: '  UTR123  ', screenshot: 'data:image/jpeg;base64,AAA', screenshotMimeType: 'image/jpeg' };
    const upi = TOPUP_FIXED_METHODS[0] as TopUpMethod;
    const custom = topUpMethods(DETAILS, 'ready').find((m) => m.id === 'CUSTOM:cash') as TopUpMethod;

    expect(manualDepositBody({ ...common, method: upi, senderName: ' Ravi ', senderUpiId: ' r@ok ', senderBankAccount: '' }))
      .toEqual(await run(upi, { upi: ' r@ok ', bank: '', name: ' Ravi ' }));
    // A custom rail is posted by its LABEL.
    const c = manualDepositBody({ ...common, method: custom, senderName: '', senderUpiId: '', senderBankAccount: '' });
    expect(c).toEqual(await run(custom, { upi: '', bank: '', name: '' }));
    expect(c).toMatchObject({ method: 'Cash Deposit', currency: 'INR' });

    // Deliberate: a UPI ID typed before switching to Bank is NOT posted.
    const bank = { ...upi, id: 'BANK', label: 'Bank Transfer' } as TopUpMethod;
    const w = await run(bank, { upi: 'stale@ok', bank: '1234', name: '' }) as Record<string, unknown>;
    const m = manualDepositBody({ ...common, method: bank, senderName: '', senderUpiId: 'stale@ok', senderBankAccount: '1234' });
    expect(w.senderUpiId).toBe('stale@ok');
    expect(m).not.toHaveProperty('senderUpiId');
    expect({ ...w, senderUpiId: undefined }).toEqual(JSON.parse(JSON.stringify({ ...m, senderUpiId: undefined })));
  });

  it('the instant transfer body is the web body', async () => {
    const webInstant = lift<Promise<unknown>>(
      ['api', 'setSubmitting', 'toast', 'onSuccess', 'errorMessage', 'n', 'sourceAccountId', 'sym'],
      `return (${after(DEPOSIT, 'const submitInstant = ', '\n  };')}\n  })();`,
    );
    const post = jest.fn(async () => ({}));
    const noop = (): void => undefined;
    await webInstant({ post }, noop, { success: noop, error: noop }, noop, String, 2500, 'acc9', '₹');
    expect(post).toHaveBeenCalledWith('/bonus-wallet/deposit', instantTopUpBody('2500', 'acc9'));
  });

  it('pay-to rows are the Add Funds labels, blanks dropped, note + QR from the rail', () => {
    const webRows = lift<{ visible: Array<[string, string, boolean]>; dd: Record<string, unknown> | undefined }>(
      ['method', 'payDetails'],
      `const isCustom = !!method.custom;
       const dd = isCustom ? method.custom : payDetails?.[method.id];
       ${between(DEPOSIT, 'let rows = [];', 'const visible = ')}
       ${through(DEPOSIT, 'const visible = ', ';')}
       return { visible, dd };`,
    );
    const methods = topUpMethods(DETAILS, 'ready').filter((m) => m.kind === 'manual');
    const bank = { ...(TOPUP_FIXED_METHODS[1] as TopUpMethod) };
    for (const method of [...methods, bank]) {
      const webMethod = method.custom
        ? { id: method.id, custom: RAW_DETAILS.custom.find((c) => `CUSTOM:${c.id}` === method.id) }
        : { id: method.id };
      const w = webRows(webMethod, RAW_DETAILS);
      const m = topUpPayTo(DETAILS, method);
      expect(m.rows.map((r) => [r.label, r.value, r.copy])).toEqual(w.visible.map(([l, v, c]) => [l, v, c]));
      expect(m.note ?? undefined).toBe((w.dd?.note as string | undefined) || undefined);
      expect(m.qr ?? undefined).toBe((w.dd?.qr as string | undefined) || undefined);
    }
    // Nothing set up → no rail, so the card warns by the method's label.
    const blank = toDepositDetails({ UPI: { enabled: true } });
    const upiOnly = topUpMethods(blank, 'ready')[0] as TopUpMethod;
    expect(topUpPayTo(blank, upiOnly).rows).toEqual([]);
    expect(topUpPayToRail(topUpPayTo(blank, upiOnly), upiOnly)).toBeNull();
    expect(DEPOSIT).toContain("Payment details for {method.label} aren't set up yet. Please contact support before sending money.");
    const upiRail = topUpPayToRail(topUpPayTo(DETAILS, methods[0] as TopUpMethod), methods[0] as TopUpMethod);
    expect(upiRail?.rows).toEqual([
      { label: 'UPI ID', value: 'pay@okaxis', copyable: true },
      { label: 'Name', value: 'Equity Hub', copyable: false },
    ]);
    expect(topUpPayTo(null, methods[0] as TopUpMethod).rows).toEqual([]);
    const webPlaceholder = lift<string>(['method'], `return ${between(DEPOSIT, "placeholder={method.id === 'UPI'", '}\n').slice('placeholder={'.length)};`);
    for (const id of ['UPI', 'BANK', 'CUSTOM:cash']) expect(txReferencePlaceholder(id)).toBe(webPlaceholder({ id }));
  });

  it('the instant transfer draws on LIVE accounts only, oldest first (practice money never funds the Main Wallet)', () => {
    const acc = (id: string, accountType: string, createdAt: string | null, isActive = true): UserAccount =>
      ({ id, accountType, createdAt, isActive, accountNumber: `N-${id}`, nickname: null, baseCurrency: 'INR' } as unknown as UserAccount);
    const list = [
      acc('demo', 'DEMO', '2020-01-01T00:00:00Z'),
      acc('virt', 'VIRTUAL', '2020-01-01T00:00:00Z'),
      acc('std', 'STANDARD', '2024-05-01T00:00:00Z'),
      acc('pro', 'PRO', '2023-02-01T00:00:00Z'),
      acc('old', 'REAL', '2022-01-01T00:00:00Z', false),
    ];
    // The web's filter, on the same rows.
    const webFilter = lift<boolean>(['a'], `return (${between(DEPOSIT, '(a) => a.accountType !== ', '\n        );')})(a);`);
    const live = topUpSourceAccounts(list);
    expect(live.map((a) => a.id)).toEqual(list.filter((a) => webFilter({ ...a, _id: a.id })).map((a) => a.id));
    expect(live.map((a) => a.id)).toEqual(['std', 'pro']);
    expect(oldestAccountId(live)).toBe('pro');
    const webOldest = [...live].sort((a, b) => (new Date(a.createdAt as string) as unknown as number) - (new Date(b.createdAt as string) as unknown as number))[0];
    expect(oldestAccountId(live)).toBe(webOldest?.id);
    expect(oldestAccountId([])).toBe('');
    const balances = [{ accountId: 'pro', currency: 'INR', balance: '12050.5' }];
    expect(accountWalletBalance(balances, { id: 'pro' })).toBe('12050.5');
    // Loaded, and no wallet row for the account: 0, as on the web.
    expect(accountWalletBalance(balances, { id: 'none' })).toBe('0');
  });

  it('an unknown balance (still loading, or the call failed) is unknown — never 0', () => {
    expect(accountWalletBalance(null, { id: 'pro' })).toBeNull();
    expect(fmtMoney(accountWalletBalance(null, { id: 'pro' }))).toBe(EMPTY);
  });

  it('the oldest-account pre-selection does not overwrite a pick made while it loaded', () => {
    const acc = (id: string, createdAt: string): Pick<UserAccount, 'id' | 'createdAt'> => ({ id, createdAt });
    const live = [acc('std', '2024-05-01T00:00:00Z'), acc('pro', '2023-02-01T00:00:00Z')];
    expect(settleSourceAccount('', false, live)).toBe('pro');
    expect(settleSourceAccount('std', false, live)).toBe('pro');
    expect(settleSourceAccount('std', true, live)).toBe('std');
    expect(settleSourceAccount('gone', true, live)).toBe('pro');
    expect(settleSourceAccount('', false, [])).toBe('');
  });

  it('the step names are the web ones', () => {
    expect(DEPOSIT).toContain("const STEPS = ['Method', 'Amount', 'Proof', 'Review'];");
    expect([...DEPOSIT_STEPS]).toEqual(['Method', 'Amount', 'Proof', 'Review']);
    expect(cleanAmountInput('1,2a3.4.5')).toBe('1.2345');
    expect(cleanAmountInput('12,5')).toBe('12.5');
  });
});

/* ══ WithdrawModal.jsx ═════════════════════════════════════════════════ */

describe('WithdrawModal — run beside ours', () => {
  const HEAD = [
    through(WITHDRAW, 'const FIXED_RAIL_IDS = ', ';'),
    through(WITHDRAW, 'const RAIL_META = {', '};'),
    through(WITHDRAW, 'const NATIVE_DESTINATION_RAILS = ', ';'),
    through(WITHDRAW, 'const railOpen = (cfg) => ', ': true);'),
    through(WITHDRAW, 'const payoutCurrency = ', ';'),
    through(WITHDRAW, 'const railRules = (cfg) => ({', '});'),
  ].join('\n');
  const webRails = lift<Array<Record<string, unknown>>>(
    ['payDetails', 'state', 'currency'],
    `${HEAD}\n${after(WITHDRAW, 'const rails = useMemo(() => {', '}, [payDetails, state, currency]);')}`,
  );
  const webDestinations = lift<Array<{ id: string }>>(
    ['saved', 'method', 'rails'],
    after(WITHDRAW, 'const destinations = useMemo(() => {', '}, [saved, method, rails]);'),
  );
  const RAW = {
    UPI: { enabled: true, minWithdrawal: 500, maxWithdrawal: 50000, withdrawalFeePercent: 1 },
    BANK: { enabled: false },
    RAZORPAY: { enabled: true, withdrawalEnabled: false },
    custom: [
      { id: 'cash', label: 'Cash Pickup', emoji: '💵', enabled: true, withdrawalFeeFixed: 25 },
      { id: 'shut', label: 'Shut', enabled: true, withdrawalEnabled: false },
      { id: 'dep-off', label: 'Deposit Off', enabled: false, withdrawalEnabled: true },
    ],
  };
  const pick = (r: Record<string, unknown>): Record<string, unknown> => ({
    id: r.id, label: r.label, blurb: r.blurb, emoji: r.emoji, methodKey: r.methodKey,
    min: r.min, max: r.max, feePercent: r.feePercent, feeFixed: r.feeFixed,
  });

  it('the rails on offer are the web list: open by `withdrawalEnabled`, else the deposit switch', () => {
    for (const raw of [RAW, {}, { UPI: { withdrawalEnabled: false }, BANK: { withdrawalEnabled: false }, RAZORPAY: { enabled: false } }]) {
      const w = webRails(raw, 'ready', 'INR');
      expect(withdrawRails(toDepositDetails(raw)).map((r) => pick(r as unknown as Record<string, unknown>))).toEqual(w.map(pick));
    }
    expect(withdrawRails(toDepositDetails(RAW)).map((r) => r.id)).toEqual(['UPI', 'cash', 'dep-off']);
    // Nothing until the settings land (and nothing on a failed read).
    expect(webRails(RAW, 'loading', 'INR')).toEqual([]);
    expect(webRails(RAW, 'error', 'INR')).toEqual([]);
    expect(withdrawRails(null)).toEqual([]);
  });

  it('destinations are the verified, unarchived methods of that rail: natives by type, the rest by methodKey', () => {
    const methods = [
      { id: 'u1', type: 'UPI', isVerified: true, archived: false, methodKey: null },
      { id: 'u2', type: 'UPI', isVerified: false, archived: false, methodKey: null },
      { id: 'u3', type: 'UPI', isVerified: true, archived: true, methodKey: null },
      { id: 'c1', type: 'CUSTOM', isVerified: true, archived: false, methodKey: 'cash' },
      { id: 'c2', type: 'CUSTOM', isVerified: true, archived: false, methodKey: 'other' },
      { id: 'b1', type: 'BANK', isVerified: true, archived: false, methodKey: null },
    ];
    const mine = methods.map((m) => toWithdrawalMethod({ _id: m.id, ...m, status: m.isVerified ? 'VERIFIED' : 'PENDING' }));
    // The web keeps `isVerified && !archived` when the list lands.
    expect(WITHDRAW).toContain('setSaved(list.filter((m) => m.isVerified && !m.archived));');
    const saved = methods.filter((m) => m.isVerified && !m.archived);
    const rails = webRails(RAW, 'ready', 'INR');
    for (const method of ['UPI', 'BANK', 'cash', 'dep-off']) {
      expect({ method, ids: verifiedForRail(mine, method).map((m) => m.id) })
        .toEqual({ method, ids: webDestinations(saved, method, rails).map((d) => d.id) });
    }
  });

  // Without an amount the web's `net` is NaN for a non-number (never shown); here it is 0.
  it('amount checks, fee, net and the refusals match the web, in the web order', () => {
    const webCheck = lift<Record<string, unknown>>(
      ['rails', 'method', 'selectedId', 'amount', 'balance', 'currency'],
      `${between(WITHDRAW, "const sym = '₹';", 'const submit = async () => {')}
       let err = null;
       const toast = { error: (m) => { err = m; } };
       (() => {
         ${after(WITHDRAW, 'const submit = async () => {', 'setSubmitting(true);')}
       })();
       return { hasAmount, belowMin, aboveMax, overBalance, amountValid, fee, net, err };`,
    );
    const rails = withdrawRails(toDepositDetails(RAW));
    const webList = webRails(RAW, 'ready', 'INR');
    let checked = 0;
    for (const method of ['UPI', 'cash', null]) {
      const rail = rails.find((r) => r.id === method) ?? null;
      for (const balance of ['0', '1000', '60000', '12.345']) {
        for (const amount of ['', '0', '-5', '100', '500', '999.99', '1000', '50000', '50001', '12.35', 'abc']) {
          for (const selectedId of ['', 'wm1']) {
            const w = webCheck(webList, method, selectedId, amount, balance, 'INR');
            const c = userWithdrawCheck(amount, balance, rail);
            const key = { method, balance, amount, selectedId };
            expect({ ...key, c: { hasAmount: c.hasAmount, belowMin: c.belowMin, aboveMax: c.aboveMax, overBalance: c.overBalance, amountValid: c.amountValid, fee: c.fee, net: c.net } })
              .toEqual({ ...key, c: { hasAmount: w.hasAmount, belowMin: w.belowMin, aboveMax: w.aboveMax, overBalance: w.overBalance, amountValid: w.amountValid, fee: w.fee, net: w.hasAmount ? w.net : 0 } });
            expect({ ...key, err: withdrawSubmitError(amount, balance, selectedId, rail, true) }).toEqual({ ...key, err: w.err });
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(3 * 4 * 11 * 2);
    expect(withdrawAmountValid('100', '1000')).toBe(true);
  });

  it('the limits line on a rail card', () => {
    const [upi, cash] = withdrawRails(toDepositDetails(RAW));
    expect(userWithdrawRailBits(upi!)).toBe('Min · ₹500.00  ·  Max · ₹50,000.00  ·  Fee 1%');
    expect(userWithdrawRailBits(cash!)).toBe('Fee ₹25.00');
    expect(userWithdrawRailBits({ min: 0, max: 0, feePercent: 0, feeFixed: 0 })).toBe('No fee');
  });

  it('DIFFERENCE: MAX is the balance floored to the cent — the web writes String(bal), which can round up past it', () => {
    expect(WITHDRAW).toContain('setAmount(String(bal))');
    expect(maxWithdrawAmount('250.75')).toBe('250.75');
    expect(maxWithdrawAmount('100.00')).toBe(String(Number('100.00')));
    expect(maxWithdrawAmount('0.50')).toBe('0.5');
    expect(maxWithdrawAmount('.5')).toBe('0.5');
    expect(maxWithdrawAmount('12.345')).toBe('12.34');
    expect(maxWithdrawAmount('12.349999')).toBe('12.34');
    expect(withdrawAmountValid(maxWithdrawAmount('12.345'), '12.345')).toBe(true);
    for (const b of ['0', '0.00', '0.004', '-5', '', 'abc', '1e-7']) expect(maxWithdrawAmount(b)).toBe('0');
    expect(maxWithdrawAmount(12.5)).toBe('12.5');
    // decimal.js (precision 30) balances: String(Number()) can exceed them.
    const scaled = (v: string): bigint => {
      const [wh = '0', f = ''] = v.split('.');
      return BigInt(`${wh}${f.padEnd(40, '0').slice(0, 40)}`);
    };
    const lte = (a: string, b: string): boolean => scaled(a) <= scaled(b);
    for (const balance of ['10.3333333333333333333333333333', '12.79999999999999993', '0.29999999999999999']) {
      expect({ balance, webFits: lte(String(Number(balance)), balance) }).toEqual({ balance, webFits: false });
      expect({ balance, mineFits: lte(String(Number(maxWithdrawAmount(balance))), balance) }).toEqual({ balance, mineFits: true });
    }
  });

  it('the body names a saved destination and nothing else', () => {
    expect(WITHDRAW).toContain('await api.post(endpoint, { amount: n, withdrawalMethodId: selectedId });');
    expect(withdrawBody('20.5', 'wm1')).toEqual({ amount: 20.5, withdrawalMethodId: 'wm1' });
  });

  it('the server refusals are worded as on the web', () => {
    expect(WITHDRAW).toContain("if (code === 'KYC_REQUIRED') toast.error('Complete KYC verification first (Profile → KYC).');");
    expect(WITHDRAW).toContain("'Withdrawal blocked: your net trading P&L for this month must be positive to withdraw.'");
    expect(WITHDRAW).toContain("toast.success('Withdrawal requested — pending admin approval');");
  });

  it('the payout types a new destination can be saved for follow the same switch', () => {
    expect(payoutRailTypes(null)).toEqual(['UPI', 'BANK']);
    expect(payoutRailTypes(toDepositDetails(RAW))).toEqual(['UPI']);
    expect(payoutRailTypes(toDepositDetails({}))).toEqual(['UPI', 'BANK']);
  });
});

/* ══ BonusWallet.jsx ═══════════════════════════════════════════════════ */

describe('Main Wallet — run beside the web', () => {
  const REASON = lift<Record<string, string>>([], `${through(BONUS, 'const REASON_LABEL = {', '};')}\nreturn REASON_LABEL;`)();
  const webRange = liftModule<{ inCustomRange: (v: unknown, f: unknown, t: unknown) => boolean }>(
    web('utils/dateRange.js'), ['inCustomRange'],
  );
  const webFilter = lift<Array<Record<string, unknown>>>(
    ['txns', 'typeSel', 'statusSel', 'dirSel', 'fromDate', 'toDate', 'q', 'REASON_LABEL', 'inCustomRange'],
    `return ${between(BONUS, 'txns.filter((t) => {', '\n  const clearFilters')}`,
  );
  const webTypes = lift<string[]>(['txns', 'REASON_LABEL'], `return ${after(BONUS, 'const typeOptions = ', ';\n')};`);

  const at = (d: number, h: number): string => new Date(2026, 8, d, h, 0).toISOString();
  const RAW = [
    { _id: 'a00000000001', transactionType: 'CREDIT', reason: 'REFERRAL_COMMISSION', status: 'SUCCESS', amount: '12.5', balanceAfter: '12.5', note: 'From user Asha', createdAt: at(10, 9) },
    { _id: 'a00000000002', transactionType: 'CREDIT', reason: 'PARTNER_COMMISSION', amount: '3', balanceAfter: '15.5', note: null, createdAt: at(10, 23) },
    { _id: 'a00000000003', transactionType: 'DEBIT', reason: 'TRANSFER_OUT', status: 'SUCCESS', amount: '5', balanceAfter: '10.5', note: 'To Main Wallet', createdAt: at(11, 0) },
    { _id: 'a00000000004', transactionType: 'DEBIT', reason: 'WITHDRAWAL', status: 'PENDING', amount: '10', balanceAfter: '0.5', note: 'Withdrawal request · UPI', createdAt: at(12, 8) },
    { _id: 'a00000000005', transactionType: 'CREDIT', reason: 'ZZZ_NEW_KIND', status: 'FAILED', amount: '1', balanceAfter: '1.5', createdAt: at(9, 22) },
    { _id: 'a00000000006', transactionType: 'REFUND', reason: 'ADMIN_CREDIT', status: 'SUCCESS', amount: '2', balanceAfter: '3.5', createdAt: 'garbage' },
  ];
  const MINE = RAW.map(toWalletTransaction);

  it('reason labels are the web table, verbatim', () => {
    expect(BONUS_REASON_LABEL).toEqual(REASON);
  });

  it('the type list is the reasons present, sorted by label', () => {
    expect(bonusTypeOptions(MINE)).toEqual(webTypes(RAW, REASON));
  });

  it('every filter combination matches the web', () => {
    const FILTERS: BonusFilter[] = [];
    for (const q of ['', 'asha', 'main', 'a00000000004', 'internal transfer', '  ']) {
      for (const type of ['', 'TRANSFER_OUT', 'ZZZ_NEW_KIND']) {
        for (const status of ['', ...BONUS_STATUS_OPTIONS]) {
          for (const dir of ['', 'CREDIT', 'DEBIT']) {
            FILTERS.push({ q, type, status, dir, from: '', to: '' });
          }
        }
      }
    }
    for (const [from, to] of [['2026-09-10', '2026-09-10'], ['2026-09-11', ''], ['', '2026-09-10'], ['2026-09-09', '2026-09-12']]) {
      FILTERS.push({ ...EMPTY_BONUS_FILTER, from: from as string, to: to as string });
    }
    for (const f of FILTERS) {
      const w = webFilter(RAW, f.type, f.status, f.dir, f.from, f.to, f.q, REASON, webRange.inCustomRange).map((t) => t._id);
      expect({ f, ids: filterBonusTxns(MINE, f).map((t) => t.id) }).toEqual({ f, ids: w });
    }
  });

  it('From == To keeps the whole day (the web helper, shared)', () => {
    const f = { ...EMPTY_BONUS_FILTER, from: '2026-09-10', to: '2026-09-10' };
    expect(filterBonusTxns(MINE, f).map((t) => t.id)).toEqual(['a00000000001', 'a00000000002']);
  });

  it('the filter flag, the count line and the tiles', () => {
    const webHas = lift<boolean>(['q', 'typeSel', 'statusSel', 'dirSel', 'fromDate', 'toDate'], `return ${after(BONUS, 'const hasFilter = ', ';\n')};`);
    for (const f of [EMPTY_BONUS_FILTER, { ...EMPTY_BONUS_FILTER, q: '  ' }, { ...EMPTY_BONUS_FILTER, q: 'x' }, { ...EMPTY_BONUS_FILTER, to: '2026-09-01' }]) {
      expect(hasBonusFilter(f)).toBe(webHas(f.q, f.type, f.status, f.dir, f.from, f.to));
    }
    expect(BONUS).toContain("{hasFilter ? `${filteredTxns.length} of ${txns.length}` : txns.length} record{(hasFilter ? filteredTxns.length : txns.length) === 1 ? '' : 's'}");
    expect(bonusRecordsLabel(3, 12, true)).toBe('3 of 12 records');
    expect(bonusRecordsLabel(1, 12, true)).toBe('1 of 12 record');
    expect(bonusRecordsLabel(0, 1, false)).toBe('1 record');
    expect(bonusRecordsLabel(0, 0, false)).toBe('0 records');

    const labels = [...BONUS.matchAll(/\{ label: '([^']+)', value: wallet\?\.(\w+) \}/g)].map((m) => [m[1], m[2]]);
    expect(labels).toHaveLength(4);
    const w = { totalReferralEarnings: '1', totalPartnerEarnings: '2', totalRevenueShare: '3', totalBonusRewards: '4' };
    expect(bonusStats(w).map((x) => [x.label, x.value])).toEqual(labels.map(([l, k]) => [l, (w as Record<string, string>)[k as string]]));
  });

  it('amounts: only CREDIT is money in on this page (a REFUND reads as a debit, as on the web)', () => {
    expect(BONUS).toContain("const credit = t.transactionType === 'CREDIT';");
    expect(BONUS).toContain("{credit ? '+' : '-'}{sym}{fmt(t.amount)}");
    expect(bonusAmountText({ transactionType: 'CREDIT', amount: '1250.5' })).toBe('+₹1,250.50');
    expect(bonusAmountText({ transactionType: 'REFUND', amount: '2' })).toBe('-₹2.00');
  });
});
