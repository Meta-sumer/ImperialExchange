/**
 * Plans, the new-account tier picker, the configure step and the leverage
 * dropdown — checked against the WEB'S OWN SOURCE, not a re-typed copy.
 *
 * Each block lifts a slice out of the shipped web file (client/src/...),
 * runs it with `new Function`, and runs this app's version (utils/plans) on
 * the same inputs. If either side changes, the test fails — a parity claim
 * nobody re-checks stops being true quietly.
 *
 * Where the port differs on purpose (money through utils/money, the
 * real-money-only balance total), the test pins the difference instead of
 * hiding it.
 */
import fs from 'fs';
import path from 'path';

import { insufficientBalance } from '@/api/subscription.api';
import { toPlan, toSubscription } from '@/types/subscription';
import { toAccountPlan } from '@/types/user';
import { toWalletTransaction } from '@/types/wallet';
import {
  ACCOUNT_BASE_CURRENCY,
  ACCOUNT_BASE_CURRENCY_LABEL,
  ACCOUNT_MODE_DESC,
  CANCEL_PROMPT,
  DEMO_SEED_INR,
  FEATURE_ROWS,
  LEVERAGE_LADDER,
  LEVERAGE_OPTIONS,
  UNLIMITED_LEVERAGE,
  accountCreatedToast,
  belowMinFigures,
  buildNewAccountPayload,
  buildPeriods,
  canCancelSubscription,
  clampCustomLeverage,
  configureAccent,
  feeTypeWithDetail,
  fmtPlanPrice,
  groupTiers,
  isLeverageLocked,
  isLeverageOptionSelected,
  leverageCap,
  leverageDisplay,
  leverageForMode,
  leverageSnapTarget,
  minDepositCheck,
  payPreview,
  planCardState,
  fmtPlanDate,
  planNotFoundMessage,
  postpaidLines,
  realMoneyTotal,
  subscribedToast,
  subscriptionSnapshot,
  switchPrompt,
  switchSuccess,
  syncNickname,
  tierSummaryLine,
  tierAccent,
  tierCommission,
  tierDefaultLeverage,
  tierFeatureChips,
  tierInitials,
  tierLeverageLabel,
  tierMinDeposit,
  tierMinDepositLabel,
  tintForCode,
  usageByType,
  visibleHighlights,
  type AccountMode,
} from '@/utils/plans';

const ROOT = path.join(__dirname, '../../..');
/** LF only, so a CRLF checkout slices the same as this one. */
const readLf = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const web = (p: string): string => readLf(path.join(ROOT, 'client/src', p));
const app = (p: string): string => readLf(path.join(__dirname, '..', p));

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

const at = (src: string, marker: string): number => {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error(`marker moved: ${marker}`);
  return i;
};

/** An ES module's text with `export` dropped, so new Function can run it. */
const unexport = (src: string): string => src.replace(/^export (default )?/gm, '');

// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const lift = <T,>(params: string[], body: string): ((...args: unknown[]) => T) =>
  new Function(...params, body) as (...args: unknown[]) => T;

const PLANS = web('pages/Plans.jsx');
const BILLING = web('components/BillingHistory.jsx');
const TIERS = web('pages/NewAccountTiers.jsx');
const CONFIGURE = web('pages/NewAccountConfigure.jsx');
const DROPDOWN = web('components/LeverageDropdown.jsx');

/** The web's rupee formatter (utils/format.js — no imports, so it runs as is). */
const webFormat = lift<{ fmtMoney: (v: unknown, c?: unknown, d?: number) => string }>(
  [],
  `${unexport(web('utils/format.js'))}\nreturn { fmtMoney };`,
)();

/* ══ Fixtures — server shapes, as the web receives them ═══════════════ */

const RAW_PLANS: Record<string, unknown>[] = [
  { _id: 'p1', code: 'FREE', name: 'Free', monthlyPrice: '0', yearlyPrice: '0', features: {}, limits: { maxAccounts: 1, maxDevices: 1 }, highlights: ['1 trading account', 'Copy trading access', 'Basic charts'] },
  { _id: 'p2', code: 'PREMIUM', name: 'Premium', monthlyPrice: '29.99', yearlyPrice: '299', badge: 'Most Popular', features: { apiAccess: true, maintenanceFee: true }, limits: { maxAccounts: 5, maxDevices: 3 }, highlights: ['5 accounts', 'Copy-Trading pro', 'API access'] },
  { _id: 'p3', code: 'VIP', name: 'VIP', monthlyPrice: '99', yearlyPrice: '990', features: { customSupport: true, apiAccess: true }, limits: { maxAccounts: null, maxDevices: null }, highlights: [] },
  { _id: 'p4', code: 'POSTPAID', name: 'Post Paid', monthlyPrice: '0', yearlyPrice: '0', features: { postPaid: true, maintenanceFee: true }, limits: {}, postPaidRates: { perDevicePerMonth: 5, perAccountPerMonth: 10, minimumMonthlyFee: 25, currency: 'INR' } },
  { _id: 'p5', code: 'FLEX', name: 'Flex', monthlyPrice: '15', yearlyPrice: '150', features: { postPaid: true } },
  { _id: 'p6', code: 'BIG', name: 'Big', monthlyPrice: '1200', yearlyPrice: '12000', features: {} },
];

const RAW_TIERS: Record<string, unknown>[] = [
  { _id: 't1', code: 'STANDARD', name: 'Standard', description: 'Everyday trading', minDeposit: 100, maxLeverage: 100, feeKind: 'PCT_OF_VALUE', feeDisplay: '0.005% of trade value', supportLabel: 'Standard support', instrumentsLabel: 'All instruments', accessLabel: '24/7 access' },
  { _id: 't2', code: 'STANDARD_IC', name: 'Standard IC', description: '', minDeposit: 0, maxLeverage: 50, feeKind: 'FIXED_PER_TRADE', feeDisplay: '', buyCloseOnly: true, badge: 'New', accentColor: '#F59E0B' },
  { _id: 't3', code: 'PRO', name: 'Pro', minDeposit: 1000, maxLeverage: null, feeKind: 'PCT_OF_PROFIT', feeDisplay: '10% of profit', badge: 'Most Popular' },
  { _id: 't4', code: 'FREE', name: 'Free', minDeposit: 0, maxLeverage: 0, feeKind: 'PCT_OF_VALUE' },
  { _id: 't5', code: 'LEGACY', name: '1-Click 99', minDeposit: 50.5, maxLeverage: 2000, feeKind: 'PCT_OF_VALUE', supportLabel: 'VIP desk', instrumentsLabel: 'FX only', accessLabel: 'Weekdays' },
  { _id: 't6', code: 'PRO_IC', name: 'Pro IC', minDeposit: 500, maxLeverage: 400, feeKind: 'FIXED_PER_TRADE', feeDisplay: '₹2 per lot', buyCloseOnly: true },
];

/* ══ Plans.jsx — the Current Subscription card ═══════════════════════ */

describe('Plans.jsx — the Current Subscription card', () => {
  const NOW = Date.parse('2026-10-20T12:00:00Z');
  const webSnap = lift<Record<string, unknown>>(
    ['mySub', 'effective'],
    `${through(PLANS, 'const cap = (s) =>', "'This is a monthly plan, billed each cycle from your Main Wallet.';")}
     return { nextBillingDate, nextDays, amountCollected, usedAmount, remainingDeposit, billingSubtitle, planNote };`,
  );

  beforeEach(() => { jest.spyOn(Date, 'now').mockReturnValue(NOW); });
  afterEach(() => { jest.restoreAllMocks(); });

  const SUBS: Array<Record<string, unknown> | null> = [
    null,
    { status: 'ACTIVE', billingCycle: 'MONTHLY', startedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-31T00:00:00Z', lastPayment: { amount: '29.99', currency: 'INR' } },
    { status: 'ACTIVE', billingCycle: 'YEARLY', startedAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', lastPayment: { amount: '990' } },
    // Postpaid: no expiresAt by design — the period ends at nextBillingAt.
    { status: 'ACTIVE', billingCycle: 'MONTHLY', startedAt: '2026-10-05T00:00:00Z', nextBillingAt: '2026-11-05T00:00:00Z', expiresAt: null },
    { status: 'ACTIVE', billingCycle: 'MONTHLY', nextBillingAt: '2026-10-21T11:00:00Z', expiresAt: '2026-12-01T00:00:00Z' },
    { status: 'EXPIRED', billingCycle: 'MONTHLY', expiresAt: '2026-10-01T00:00:00Z' },
    { status: 'ACTIVE', billingCycle: 'LIFETIME', expiresAt: null, nextBillingAt: null },
  ];
  const EFFECTIVE = [RAW_PLANS[0], RAW_PLANS[1], RAW_PLANS[3], RAW_PLANS[4]] as Record<string, unknown>[];

  it('next billing date, days left, amounts, subtitle and plan note match the web', () => {
    for (const raw of SUBS) {
      for (const eff of EFFECTIVE) {
        const theirs = webSnap(raw, eff) as {
          nextBillingDate: string | null; nextDays: number | null; amountCollected: number; usedAmount: number;
          remainingDeposit: number; billingSubtitle: string; planNote: string;
        };
        const s = subscriptionSnapshot(toSubscription(raw), toPlan(eff), NOW);
        const ours = {
          nextBillingDate: s.nextBilling,
          nextDays: s.nextBillingSub,
          amountCollected: s.amountCollected,
          usedAmount: s.used,
          remainingDeposit: s.remainingDeposit,
          billingSubtitle: s.billingSubtitle,
          planNote: s.planNote,
        };
        const webSub = theirs.nextDays != null ? `in ${theirs.nextDays} day${theirs.nextDays === 1 ? '' : 's'}` : '';
        expect({ raw, code: eff.code, ours }).toEqual({
          raw,
          code: eff.code,
          ours: { ...theirs, nextDays: webSub },
        });
        // "No expiry" without a date; otherwise the date, formatted.
        expect(s.nextBillingLabel).toBe(theirs.nextBillingDate ? fmtPlanDate(theirs.nextBillingDate) : 'No expiry');
      }
    }
  });

  it('the card labels are the web strings', () => {
    for (const s of ['Started On', 'Next Billing Date', "'No expiry'", 'Amount Collected', 'label="Used"', 'Remaining Deposit', 'Plan Details', 'Hide details', 'How Postpaid Works', 'Billing Source: Main Wallet']) {
      expect({ s, inWeb: PLANS.includes(s) }).toEqual({ s, inWeb: true });
    }
    const screen = app('screens/plans/PlansScreen.tsx');
    for (const s of ['Started On', 'Next Billing Date', 'Amount Collected', 'label="Used"', 'Remaining Deposit', 'Plan Details', 'Hide details', 'How Postpaid Works']) {
      expect({ s, inApp: screen.includes(s) }).toEqual({ s, inApp: true });
    }
    // MetaTrading's "Renews … / Next bill …" line is gone from both.
    expect(PLANS).not.toMatch(/'Renews'|Next bill'/);
    expect(screen).not.toMatch(/Renews|Next bill /);
  });

  it('DIFFERS ON PURPOSE: dates follow the device locale, with the web’s options', () => {
    expect(PLANS).toContain("toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })");
    const d = '2026-10-29T10:00:00Z';
    expect(fmtPlanDate(d)).toBe(new Date(d).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }));
    expect(fmtPlanDate(null)).toBe('—');
  });
});

/* ══ components/BillingHistory.jsx ═══════════════════════════════════ */

describe('BillingHistory.jsx — the plan-period timeline', () => {
  const NOW = Date.parse('2026-10-20T12:00:00Z');
  const webBH = lift<{
    buildPeriods: (t: unknown, s: unknown, p: unknown) => Array<Record<string, unknown>>;
    postpaidLines: (t: unknown) => unknown;
  }>([], `${through(BILLING, 'const cap = (s) =>', '  return periods;\n}')}\nreturn { buildPeriods, postpaidLines };`)();

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => { jest.useRealTimers(); });

  const RAW_TXNS: Record<string, unknown>[] = [
    { _id: 'h1', transactionType: 'DEBIT', reason: 'SUBSCRIPTION_CHARGE', planCode: 'PREMIUM', billingCycle: 'MONTHLY', amount: '29.99', currency: 'INR', createdAt: '2026-07-01T10:00:00Z' },
    { _id: 'h2', transactionType: 'CREDIT', reason: 'DEPOSIT', amount: '100', createdAt: '2026-07-02T10:00:00Z' },
    { _id: 'h3', transactionType: 'DEBIT', reason: 'RENEWAL', planCode: 'PREMIUM', billingCycle: 'MONTHLY', amount: '29.99', createdAt: '2026-08-01T10:00:00Z' },
    { _id: 'h4', transactionType: 'DEBIT', reason: 'SUBSCRIPTION_CHARGE', planCode: 'vip', billingCycle: 'YEARLY', amount: '990', createdAt: '2026-09-01T10:00:00Z' },
    { _id: 'h5', transactionType: 'DEBIT', reason: 'WITHDRAWAL', amount: '5', createdAt: '2026-09-15T10:00:00Z' },
    // A charge written before planCode was recorded.
    { _id: 'h6', transactionType: 'DEBIT', reason: 'SUBSCRIPTION_CHARGE', note: 'Postpaid usage · 2 device(s) + 3 account(s) (min ₹25)', amount: '-16', createdAt: '2026-10-01T10:00:00Z' },
    { _id: 'h7', transactionType: 'REFUND', reason: 'REFUND', amount: '10', createdAt: '2026-10-02T10:00:00Z' },
  ];
  const RAW_SUBS: Array<Record<string, unknown> | null> = [
    null,
    { planCode: 'POSTPAID', status: 'ACTIVE', billingCycle: 'MONTHLY', startedAt: '2026-10-01T10:00:00Z', nextBillingAt: '2026-11-01T10:00:00Z', lastPayment: { amount: '25', currency: 'INR' } },
    { planCode: 'VIP', status: 'ACTIVE', billingCycle: 'YEARLY', startedAt: '2026-09-01T10:00:00Z', expiresAt: '2027-09-01T10:00:00Z' },
    // Free with no charge and no start date — the synthetic row starts "now".
    { planCode: 'FREE', status: 'ACTIVE', billingCycle: 'MONTHLY' },
    { planCode: 'FLEX', status: 'ACTIVE', billingCycle: 'MONTHLY', startedAt: '2026-10-10T00:00:00Z', nextBillingAt: '2026-11-10T00:00:00Z' },
    { planCode: 'PREMIUM', status: 'CANCELLED', billingCycle: 'MONTHLY', expiresAt: '2026-09-01T10:00:00Z' },
  ];

  const norm = (p: Record<string, unknown>, tId: unknown): Record<string, unknown> => ({
    id: p.id,
    start: (p.start as Date).getTime(),
    end: p.end ? (p.end as Date).getTime() : null,
    days: p.days,
    code: p.code,
    planName: p.planName,
    cycle: p.cycle,
    badges: p.badges,
    description: p.description,
    subtitle: p.subtitle,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    isPostpaid: p.isPostpaid,
    // The web's `r.isLast && curActive && …` is null, not false, without a subscription.
    isCurrent: !!p.isCurrent,
    tId: tId ?? null,
  });

  it('rebuilds the same periods, newest first, for every subscription state', () => {
    const plans = RAW_PLANS.map(toPlan);
    for (const txns of [RAW_TXNS, RAW_TXNS.slice(0, 3), RAW_TXNS.slice(5), []]) {
      for (const sub of RAW_SUBS) {
        const theirs = webBH.buildPeriods(txns, sub, RAW_PLANS).map((p) => norm(p, (p.t as { _id?: string } | null)?._id));
        const ours = buildPeriods(txns.map(toWalletTransaction), toSubscription(sub), plans, new Date(NOW))
          .map((p) => norm(p as unknown as Record<string, unknown>, p.t?.id));
        expect({ n: txns.length, sub, ours }).toEqual({ n: txns.length, sub, ours: theirs });
      }
    }
  });

  it('itemizes a postpaid charge from its note the same way', () => {
    for (const note of ['Postpaid usage · 2 device(s) + 3 account(s) (min ₹25)', 'Postpaid · 1 device', 'min $25 postpaid', '', null]) {
      for (const amount of ['-16', '25', null]) {
        expect({ note, amount, ours: postpaidLines({ note, amount }) }).toEqual({ note, amount, ours: webBH.postpaidLines({ note, amount }) });
      }
    }
  });

  it('the screen renders the timeline with the web’s inputs', () => {
    expect(PLANS).toContain('<BillingHistory txns={history} currentSub={mySub} plans={plans} currentPlanCode={effective?.code} />');
    expect(app('screens/plans/PlansScreen.tsx')).toContain('<BillingHistory txns={history} currentSub={mySub} plans={plans} currentPlanCode={effective?.code ?? null} />');
  });
});

/* ══ utils/feeType.js ════════════════════════════════════════════════ */

describe('fee type labels — utils/feeType.js', () => {
  const webFee = lift<{ feeTypeWithDetail: (c: unknown, d: unknown) => string }>(
    [],
    `${unexport(web('utils/feeType.js'))}\nreturn { feeTypeWithDetail };`,
  )();

  it('groups and labels every code the same way', () => {
    const codes = ['PCT_OF_VALUE', 'pct_of_value', 'PERCENTAGE', 'FIXED', 'FIXED_PER_TRADE', 'PCT_OF_PROFIT', 'UNKNOWN', '', null, undefined];
    const details = ['0.005% of trade value', '', null, undefined];
    for (const c of codes) {
      for (const d of details) {
        expect({ c, d, ours: feeTypeWithDetail(c, d) }).toEqual({ c, d, ours: webFee.feeTypeWithDetail(c, d) });
      }
    }
  });
});

/* ══ Plans.jsx ═══════════════════════════════════════════════════════ */

describe('Plans.jsx — pricing cards', () => {
  const webCard = lift<Record<string, unknown>>(
    ['plan', 'billing', 'balanceNum', 'isCurrent'],
    `${between(PLANS, "const isPostPaid = plan.code === 'POSTPAID' || plan.features?.postPaid;\n          const price", 'return (', at(PLANS, '{plans.map((plan) => {'))}
     return { isPostPaid: !!isPostPaid, priceNum, isFree, popular, current, canAfford };`,
  );

  it('decides free / post-paid / popular / current / affordable the way the web does', () => {
    for (const raw of RAW_PLANS) {
      for (const billing of ['MONTHLY', 'YEARLY'] as const) {
        for (const balance of [0, 29.98, 29.99, 150, 5000]) {
          for (const effective of ['PREMIUM', 'FREE', null]) {
            const theirs = webCard(raw, billing, balance, (p: { code: string }) => effective === p.code);
            const s = planCardState(toPlan(raw), billing, balance, effective);
            const ours = { isPostPaid: s.isPostPaid, priceNum: s.priceNum, isFree: s.isFree, popular: s.popular, current: s.current, canAfford: s.canAfford };
            expect({ code: raw.code, billing, balance, effective, ours }).toEqual({ code: raw.code, billing, balance, effective, ours: theirs });
          }
        }
      }
    }
  });

  it('picks the button the way the JSX ternary does: current, free, post-paid, pay', () => {
    const order = between(PLANS, '{current ? (', '</div>\n          );', at(PLANS, '{plans.map((plan) => {'));
    expect(order.indexOf('✓ Current plan')).toBeLessThan(order.indexOf('Switch to Free'));
    expect(order.indexOf('Switch to Free')).toBeLessThan(order.indexOf('Activate Post Paid'));
    expect(order.indexOf('Activate Post Paid')).toBeLessThan(order.indexOf('Pay from wallet'));
    const free = toPlan(RAW_PLANS[0]);
    const pp = toPlan(RAW_PLANS[3]);
    const paid = toPlan(RAW_PLANS[1]);
    expect(planCardState(free, 'MONTHLY', 0, 'FREE').action).toBe('current');
    expect(planCardState(free, 'MONTHLY', 0, 'PREMIUM').action).toBe('free');
    expect(planCardState(pp, 'MONTHLY', 0, 'FREE').action).toBe('postpaid');
    expect(planCardState(paid, 'MONTHLY', 0, 'FREE').action).toBe('pay');
  });

  it('hides copy-trading bullets with the web regex', () => {
    const re = /\.filter\(\(h\) => !(\/[^/]+\/i)\.test\(h\)\)/.exec(PLANS)?.[1];
    expect(re).toBeDefined();
    const webRe = lift<RegExp>([], `return ${re};`)();
    const samples = ['Copy trading access', 'Copy-Trading pro', 'copytrading', 'Copy  trading', 'API access', 'Priority support'];
    const theirs = samples.filter((h) => !webRe.test(h));
    expect(visibleHighlights({ highlights: samples })).toEqual(theirs);
  });

  it('switch prompts and toasts are the web strings', () => {
    const webSwitch = lift<{ prompt: string; ok: string }>(
      ['plan'],
      `${between(PLANS, "const isPostPaid = plan.code === 'POSTPAID' || plan.features?.postPaid;\n      const prompt", 'if (!(await confirm(prompt))) return;')}
       const ok = ${between(PLANS, 'toast.success(isPostPaid ?', ');', at(PLANS, 'const switchToFree')).replace('toast.success(', '')};
       return { prompt, ok };`,
    );
    for (const raw of RAW_PLANS) {
      const theirs = webSwitch(raw);
      const p = toPlan(raw);
      expect({ code: raw.code, prompt: switchPrompt(p), ok: switchSuccess(p) }).toEqual({ code: raw.code, ...theirs });
    }
  });

  it('the paid-subscribe toast matches the web below 1,000, and groups above it (utils/money)', () => {
    const webToast = lift<string>(
      ['confirmPlan', 'billing'],
      `${through(PLANS, 'const price = billing === ', ';', at(PLANS, 'const confirmAndPay'))}
       return ${between(PLANS, 'toast.success(`Subscribed', ');', at(PLANS, 'const confirmAndPay')).replace('toast.success(', '')};`,
    );
    for (const raw of RAW_PLANS.slice(0, 5)) {
      for (const billing of ['MONTHLY', 'YEARLY'] as const) {
        expect(subscribedToast(toPlan(raw), billing)).toBe(webToast(raw, billing));
      }
    }
    // Deliberate: the web's toFixed(2) prints 1200.00; utils/money groups it.
    expect(webToast(RAW_PLANS[5], 'MONTHLY')).toBe('Subscribed to Big · 1200.00 deducted from your Main Wallet');
    expect(subscribedToast(toPlan(RAW_PLANS[5]), 'MONTHLY')).toBe('Subscribed to Big · 1,200.00 deducted from your Main Wallet');
  });

  it('cancel: the web prompt, the web reason, and the same visibility rule', () => {
    const cancelSrc = between(PLANS, 'const cancel = async', 'if (loading)');
    expect(cancelSrc).toContain(`confirm('${CANCEL_PROMPT}')`);
    expect(cancelSrc).toContain("{ reason: 'User requested' }");
    expect(app('screens/plans/PlansScreen.tsx')).toContain("subscriptionApi.cancel('User requested')");

    const cond = /\{(mySub && mySub\.status === 'ACTIVE' && effective\.code !== 'FREE') && \(/.exec(PLANS)?.[1];
    expect(cond).toBeDefined();
    const webCan = lift<boolean>(['mySub', 'effective'], `return !!(${cond});`);
    for (const sub of [null, { status: 'ACTIVE' }, { status: 'CANCELLED' }, { status: 'EXPIRED' }]) {
      for (const code of ['FREE', 'PREMIUM', 'POSTPAID']) {
        expect(canCancelSubscription(sub, { code })).toBe(webCan(sub, { code }));
      }
    }
  });

  it('compare-features rows: same labels, same order, same values', () => {
    const rows = [...PLANS.matchAll(/<FeatureRow label="([^"]+)" plans=\{plans\} value=\{(.+?)\} \/>/g)];
    expect(rows.map((m) => m[1])).toEqual(FEATURE_ROWS.map((r) => r.label));
    for (const [i, m] of rows.entries()) {
      const webValue = lift<(p: unknown) => unknown>([], `return ${m[2]};`)();
      const row = FEATURE_ROWS[i];
      if (!row) throw new Error('row missing');
      for (const raw of RAW_PLANS) {
        const theirs = webValue(raw);
        expect({ row: row.label, code: raw.code, ours: row.value(toPlan(raw)) }).toEqual({ row: row.label, code: raw.code, ours: String(theirs ?? '—') });
      }
    }
  });

  it('the confirm-subscription modal figures match ConfirmPayModal — always rupees', () => {
    const webModal = lift<Record<string, unknown>>(
      ['plan', 'billing', 'wallet'],
      `${through(PLANS, 'const price = Number(billing', "const ccy = 'INR';", at(PLANS, 'function ConfirmPayModal'))}
       return { price, balance, after, canAfford, currency: ccy };`,
    );
    const wallets = [null, { balance: '0', currency: 'INR' }, { balance: '29.99', currency: 'INR' }, { balance: '12.5' }, { balance: '1000', currency: 'INR' }];
    for (const raw of RAW_PLANS) {
      for (const billing of ['MONTHLY', 'YEARLY'] as const) {
        for (const w of wallets) {
          expect({ code: raw.code, billing, w, ours: payPreview(toPlan(raw), billing, w) })
            .toEqual({ code: raw.code, billing, w, ours: webModal(raw, billing, w) });
        }
      }
    }
    // The modal's figures and button are in rupees.
    const modal = PLANS.slice(at(PLANS, 'function ConfirmPayModal'));
    expect(modal).toContain('`₹${fmt(price)}`');
    expect(modal).toContain("`Pay ₹${fmt(price)} & subscribe`");
  });

  it('a 402 fills the recharge prompt the way the web does, details or not — in INR', () => {
    const webPrompt = lift<Record<string, unknown>>(
      ['e', 'confirmPlan', 'billing', 'billingWallet'],
      `const details = e.response?.data?.error?.details;
       ${through(PLANS, 'setRechargePrompt({', '});').replace('setRechargePrompt(', 'return (')}`,
    );
    const err = (details?: Record<string, unknown>): unknown => ({
      response: { status: 402, data: { error: { code: 'INSUFFICIENT_SUBSCRIPTION_BALANCE', ...(details ? { details } : {}) } } },
    });
    const plan = RAW_PLANS[1] as Record<string, unknown>;
    // The server sends the Bonus Wallet's currency, INR (subscriptionService.chargePlan).
    for (const e of [err(), err({ balance: '5', needed: '29.99', shortfall: '24.99', currency: 'INR' }), err({ shortfall: '3' })]) {
      for (const w of [null, { balance: '7.5', currency: 'INR' }]) {
        for (const billing of ['MONTHLY', 'YEARLY'] as const) {
          const theirs = webPrompt(e, plan, billing, w) as Record<string, unknown>;
          const ours = insufficientBalance(e, {
            needed: String(billing === 'YEARLY' ? toPlan(plan).yearlyPrice : toPlan(plan).monthlyPrice),
            balance: w?.balance ?? null,
          });
          expect(ours).toEqual({
            balance: String(theirs.balance),
            needed: String(theirs.needed),
            shortfall: String(theirs.shortfall),
            currency: theirs.currency,
          });
        }
      }
    }
    // The web pins `currency: 'INR'`; so does the screen.
    expect(PLANS).toContain("currency: 'INR',");
    expect(app('screens/plans/PlansScreen.tsx')).toContain('setRechargePrompt({ plan, billing, ...short, currency: CURRENCY });');
  });

  it('prices are rupees with the web’s 0–2 decimals and Indian grouping', () => {
    const expr = "₹{Number(price).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}";
    expect(PLANS).toContain(expr);
    const webPrice = (v: string): string => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
    const values = ['29.99', '299', '29.5', '1200', '0', '0.333', '100000'];
    expect(values.map((v) => fmtPlanPrice(v))).toEqual(values.map(webPrice));
    expect(fmtPlanPrice('100000')).toBe('₹1,00,000');
    expect(PLANS).toContain('`Pay from wallet · ₹${fmt(priceNum)}`');
  });
});

/* ══ NewAccountTiers.jsx ═════════════════════════════════════════════ */

describe('NewAccountTiers.jsx — the tier picker', () => {
  const webTint = lift<(c: unknown) => string>([], `${through(TIERS, 'function tintForCode(code) {', '\n}\n')}\nreturn tintForCode;`)();
  const webFee = lift<{ feeTypeWithDetail: (c: unknown, d: unknown) => string }>(
    [],
    `${unexport(web('utils/feeType.js'))}\nreturn { feeTypeWithDetail };`,
  )();

  it('groups the catalogue into the same sections, in the same order', () => {
    const webGroups = lift<Array<{ title: string; plans: Array<{ code: string }> }>>(
      ['plans'],
      between(TIERS, 'const standard = [];', '}, [plans]);'),
    );
    const shuffled = [RAW_TIERS[5], RAW_TIERS[4], RAW_TIERS[0], RAW_TIERS[3], RAW_TIERS[2], RAW_TIERS[1]] as Record<string, unknown>[];
    for (const set of [RAW_TIERS, shuffled, RAW_TIERS.slice(0, 2), [RAW_TIERS[4]], []]) {
      const theirs = webGroups(set).map((g) => ({ title: g.title, codes: g.plans.map((p) => p.code) }));
      const ours = groupTiers((set as Record<string, unknown>[]).map(toAccountPlan)).map((g) => ({ title: g.title, codes: g.plans.map((p) => p.code) }));
      expect(ours).toEqual(theirs);
    }
  });

  it('counts accounts per tier the same way', () => {
    const webUsage = lift<Record<string, number>>(['accounts'], `${through(TIERS, 'const out = {};', 'return out;')}`);
    const accounts = [{ accountType: 'STANDARD' }, { accountType: 'PRO' }, { accountType: 'STANDARD' }, { accountType: 'DEMO' }];
    expect(usageByType(accounts)).toEqual(webUsage(accounts));
  });

  it('each row shows the same accent, deposit, leverage, commission and initials', () => {
    const webRow = lift<Record<string, unknown>>(
      ['plan', 'tintForCode', 'feeTypeWithDetail'],
      `${through(TIERS, 'const accent = plan.accentColor || tintForCode(plan.code);', ".slice(0, 2).toUpperCase();")}
       return { accent, minDep, lev, commission, initials };`,
    );
    for (const code of ['FREE', 'FREE_IC', 'PRO', 'PRO_IC', 'STANDARD', '', null]) {
      expect(tintForCode(code)).toBe(webTint(code));
    }
    for (const raw of RAW_TIERS) {
      const theirs = webRow(raw, webTint, webFee.feeTypeWithDetail) as { accent: string; minDep: number; lev: string; commission: string; initials: string };
      const p = toAccountPlan(raw);
      expect({ code: raw.code, ours: { accent: tierAccent(p), minDep: tierMinDeposit(p), lev: tierLeverageLabel(p.maxLeverage), commission: tierCommission(p), initials: tierInitials(p) } })
        .toEqual({ code: raw.code, ours: theirs });
      // The deposit cell: whole rupees through the web's fmtMoney.
      const webCell = theirs.minDep > 0 ? webFormat.fmtMoney(theirs.minDep, 'INR', 0) : 'No min';
      expect({ code: raw.code, cell: tierMinDepositLabel(p) }).toEqual({ code: raw.code, cell: webCell });
    }
    expect(TIERS).toContain("value={minDep > 0 ? fmtMoney(minDep, 'INR', 0) : 'No min'}");
    expect(tierMinDepositLabel(toAccountPlan({ minDeposit: 100000 }))).toBe('₹1,00,000');
  });

  it('the feature chips carry the same labels and tones', () => {
    const webChips = lift<Array<{ label: string; tone?: string }>>(['plan'], `${through(TIERS, 'const items = [', '];')}\nreturn items;`);
    for (const raw of RAW_TIERS) {
      const theirs = webChips(raw).map((c) => ({ label: c.label, tone: c.tone ?? 'neutral' }));
      expect(tierFeatureChips(toAccountPlan(raw))).toEqual(theirs);
    }
  });

  it('empty-state and bar copy are the web strings', () => {
    const screen = app('screens/accounts/NewAccountTiersScreen.tsx');
    for (const s of ['Open account', 'Loading account tiers…', 'No tiers available. Ask an admin to enable some.', 'Pick an account type to continue', 'Continue →', 'Standard accounts', 'Professional accounts', 'Free accounts', 'Min deposit', 'Max leverage', 'Commission']) {
      expect({ s, inApp: screen.includes(s) || app('utils/plans.ts').includes(s) }).toEqual({ s, inApp: true });
      expect({ s, inWeb: TIERS.includes(s) }).toEqual({ s, inWeb: true });
    }
  });
});

/* ══ NewAccountConfigure.jsx ═════════════════════════════════════════ */

describe('NewAccountConfigure.jsx — opening an account', () => {
  // `baseCurrency` and `DEMO_SEED_INR` are constants outside create() — passed in.
  const webPayload = lift<Record<string, unknown>>(
    ['mode', 'plan', 'nickname', 'baseCurrency', 'leverage', 'UNLIMITED_LEVERAGE', 'DEMO_SEED_INR'],
    `${between(CONFIGURE, "const isDemo = mode === 'DEMO';", "await api.post('/user/accounts', payload);")}\nreturn payload;`,
  );
  const standard = { code: 'STANDARD', name: 'Standard', maxLeverage: 100 };
  const pro = { code: 'PRO', name: 'Pro', maxLeverage: null };

  it('posts exactly what the web posts, key for key — INR, and the tier kept on a demo', () => {
    const cases: Array<{ plan: typeof standard | typeof pro; mode: AccountMode; nickname: string; leverage: number }> = [
      { plan: standard, mode: 'REAL', nickname: '', leverage: 50 },
      { plan: standard, mode: 'REAL', nickname: '  My  FX  ', leverage: 0 },
      { plan: standard, mode: 'DEMO', nickname: '', leverage: 50 },
      { plan: standard, mode: 'DEMO', nickname: 'Sandbox ', leverage: 100 },
      { plan: pro, mode: 'REAL', nickname: 'Scalping', leverage: 0 },
      { plan: pro, mode: 'REAL', nickname: '   ', leverage: UNLIMITED_LEVERAGE },
      { plan: pro, mode: 'REAL', nickname: 'x', leverage: 75 },
    ];
    for (const c of cases) {
      const theirs = webPayload(c.mode, c.plan, c.nickname, 'INR', c.leverage, UNLIMITED_LEVERAGE, DEMO_SEED_INR);
      const ours = buildNewAccountPayload(c);
      expect({ c, ours }).toEqual({ c, ours: theirs });
      expect(Object.keys(ours)).toEqual(Object.keys(theirs));
    }
    expect(CONFIGURE).toContain("const baseCurrency = 'INR';");
    expect(ACCOUNT_BASE_CURRENCY).toBe('INR');
    expect(CONFIGURE).toContain(`const DEMO_SEED_INR = ${DEMO_SEED_INR};`);
  });

  it('keeps the nickname in step with the mode unless the user typed one', () => {
    const head = 'setNickname((curr) => {';
    const webSync = lift<string>(['curr', 'plan', 'mode'], between(CONFIGURE, head, '\n    });').slice(head.length));
    const plan = { name: 'Standard' };
    for (const curr of ['', 'Standard', 'Standard Practice', 'My book', 'standard']) {
      for (const mode of ['REAL', 'DEMO'] as const) {
        expect({ curr, mode, ours: syncNickname(curr, plan, mode) }).toEqual({ curr, mode, ours: webSync(curr, plan, mode) });
      }
    }
  });

  it('defaults and mode-switches leverage as the web does', () => {
    expect(CONFIGURE).toContain('setLeverage(target.maxLeverage != null ? target.maxLeverage : UNLIMITED_LEVERAGE);');
    const webMode = lift<number>(
      ['mode', 'plan', 'UNLIMITED_LEVERAGE'],
      `let out; const setLeverage = (v) => { out = v; };
       ${between(CONFIGURE, "if (mode === 'DEMO') {\n      setLeverage(UNLIMITED_LEVERAGE);", '\n  }, [mode, plan]);')}
       return out;`,
    );
    for (const plan of [standard, pro, { code: 'FREE', name: 'Free', maxLeverage: 0 }]) {
      expect(tierDefaultLeverage(plan)).toBe(plan.maxLeverage != null ? plan.maxLeverage : UNLIMITED_LEVERAGE);
      for (const mode of ['REAL', 'DEMO'] as const) {
        expect(leverageForMode(plan, mode)).toBe(webMode(mode, plan, UNLIMITED_LEVERAGE));
      }
    }
  });

  it('computes the minimum-deposit warning and the tier cap the same way', () => {
    const webMin = lift<Record<string, unknown>>(
      ['plan', 'isDemo', 'totalBalance'],
      `${through(CONFIGURE, 'const minDep = Number(plan.minDeposit || 0);', 'const tierCap = isDemo ? null : (plan.maxLeverage || null);')}
       return { minDep, shortfall, belowMin, tierCap };`,
    );
    for (const raw of RAW_TIERS) {
      for (const mode of ['REAL', 'DEMO'] as const) {
        for (const total of [0, 40, 100, 5000]) {
          const p = toAccountPlan(raw);
          expect({ code: raw.code, mode, total, ours: minDepositCheck(p, mode, total) })
            .toEqual({ code: raw.code, mode, total, ours: webMin(raw, mode === 'DEMO', total) });
        }
      }
    }
  });

  it('uses the same accent', () => {
    const webAccent = lift<string>(['plan'], `${through(CONFIGURE, 'const accent = plan.accentColor', "'#1D4ED8');")}\nreturn accent;`);
    for (const raw of RAW_TIERS) expect(configureAccent(toAccountPlan(raw))).toBe(webAccent(raw));
  });

  it('DIFFERS ON PURPOSE: the balance total counts real-money accounts only', () => {
    const expr = /\(\) => (balances\.reduce\(.+\)),\n/.exec(CONFIGURE)?.[1];
    expect(expr).toBeDefined();
    const webTotal = lift<number>(['balances'], `return ${expr};`);
    const accounts = [
      { id: 'a1', accountType: 'STANDARD' },
      { id: 'a2', accountType: 'DEMO' },
      { id: 'a3', accountType: 'PRO_IC' },
      { id: 'a4', accountType: 'VIRTUAL' },
    ];
    const balances = [
      { accountId: 'a1', balance: '40' },
      { accountId: 'a2', balance: '100000' },
      { accountId: 'a3', balance: '12.5' },
      { accountId: 'a4', balance: '500' },
    ];
    expect(webTotal(balances)).toBe(100552.5);
    expect(realMoneyTotal(accounts, balances)).toBe(52.5);
    // With no practice accounts the two agree.
    const realOnly = balances.filter((b) => b.accountId === 'a1' || b.accountId === 'a3');
    expect(realMoneyTotal(accounts, realOnly)).toBe(webTotal(realOnly));
  });

  it('toasts and the not-found message are the web strings', () => {
    expect(CONFIGURE).toContain("toast.success(`${isDemo ? 'Demo' : plan.name} account created`);");
    expect(accountCreatedToast({ name: 'Standard' }, 'REAL')).toBe('Standard account created');
    expect(accountCreatedToast({ name: 'Standard' }, 'DEMO')).toBe('Demo account created');
    expect(CONFIGURE).toContain('toast.error(`Plan "${tierCode}" not found`);');
    expect(planNotFoundMessage('GOLD')).toBe('Plan "GOLD" not found');
  });

  it('screen copy is the web copy, verbatim', () => {
    const screen = app('screens/accounts/NewAccountConfigureScreen.tsx');
    const strings = [
      'Account configuration',
      'Pick a mode and fine-tune the trading rules. You can change leverage later from account settings.',
      '← Change tier',
      'Account mode',
      'Real Account', 'Live trading',
      'Trade with deposited funds. Profits and losses settle to your real wallet. Tier rules (leverage cap, fees, restrictions) apply.',
      'Demo Account', 'Practice trading',
      'Virtual funds, no real deposit. Identical trading engine — useful for testing strategies risk-free.',
      'No deposit needed',
      'Account details',
      'Nickname helps you spot this account in the picker. Leverage caps out at 1:Unlimited.',
      'Below minimum deposit',
      'Nickname', 'Base currency', 'Leverage', 'Fixed',
      'Create Demo Account', 'Create Real Account', 'Creating…', 'Selected',
    ];
    for (const s of strings) {
      expect({ s, inWeb: CONFIGURE.includes(s) }).toEqual({ s, inWeb: true });
      expect({ s, inApp: screen.includes(s) }).toEqual({ s, inApp: true });
    }
    // The mode description names the ₹1,00,000 seed through the web's fmtMoney.
    const descTpl = between(CONFIGURE, 'desc={`Real funds vs.', '`}>').slice('desc={`'.length);
    const webDesc = lift<string>(['fmtMoney', 'DEMO_SEED_INR'], `return \`${descTpl}\`;`)(webFormat.fmtMoney, DEMO_SEED_INR);
    expect(ACCOUNT_MODE_DESC).toBe(webDesc);
    expect(ACCOUNT_MODE_DESC).toContain('start with a ₹1,00,000 virtual seed.');
    // INR-only: the base currency is a fixed field, not a picker.
    expect(CONFIGURE).not.toContain('<select');
    expect(CONFIGURE).toContain('<span className="text-text-primary">INR (₹)</span>');
    expect(ACCOUNT_BASE_CURRENCY_LABEL).toBe('INR (₹)');
    expect(screen).toContain('ACCOUNT_BASE_CURRENCY_LABEL');
  });

  it('the tier summary and the below-minimum figures are rupees, as the web prints them', () => {
    const { fmtMoney } = webFormat;
    expect(CONFIGURE).toContain("Min {fmtMoney(minDep, 'INR', 0)} · {plan.maxLeverage ? `1:${plan.maxLeverage}` : '1:Unlimited'} · Fee {feeTypeWithDetail(");
    expect(CONFIGURE).toContain("Wallet balance roughly <strong>{fmtMoney(totalBalance)}</strong>. Tier needs {fmtMoney(minDep, 'INR', 0)} — you can still create the account and fund the <strong>{fmtMoney(shortfall)}</strong> later.");
    for (const raw of RAW_TIERS) {
      const p = toAccountPlan(raw);
      const minDep = Number(p.minDeposit || 0);
      expect(tierSummaryLine(p)).toBe(`Min ${fmtMoney(minDep, 'INR', 0)} · ${p.maxLeverage ? `1:${p.maxLeverage}` : '1:Unlimited'} · Fee ${tierCommission(p)}`);
    }
    for (const [total, min, short] of [[40, 100, 60], [1234.5, 100000, 98765.5], [0, 50.5, 50.5]] as const) {
      expect(belowMinFigures(total, min, short)).toEqual({ balance: fmtMoney(total), needs: fmtMoney(min, 'INR', 0), shortfall: fmtMoney(short) });
    }
  });
});

/* ══ LeverageDropdown.jsx ════════════════════════════════════════════ */

describe('LeverageDropdown.jsx — the leverage ladder', () => {
  type WebDropdown = {
    hasCap: boolean;
    capNum: number;
    isLocked: (o: unknown) => boolean;
    display: string;
    OPTIONS: unknown[];
  };
  const webDropdown = lift<WebDropdown>(
    ['maxLeverage', 'value', 'custom', 'UNLIMITED_LEVERAGE', 'LEVERAGE_LADDER'],
    `${through(DROPDOWN, 'const OPTIONS = [', '];')}
     ${through(DROPDOWN, 'const capNum = Number(maxLeverage);', 'capNum > 0;')}
     ${through(DROPDOWN, 'const isLocked = (opt) => {', '\n  };')}
     ${through(DROPDOWN, 'const display = custom', 'value}`;')}
     return { hasCap, capNum, isLocked, display, OPTIONS };`,
  );
  const webSelected = lift<boolean>(
    ['opt', 'custom', 'value', 'UNLIMITED_LEVERAGE'],
    `${through(DROPDOWN, 'const selected = !custom && (', "opt.kind === 'CUSTOM');")}\nreturn selected;`,
  );
  const webCustom = lift<number>(
    ['e', 'hasCap', 'capNum'],
    `${between(DROPDOWN, 'let v = Number(e.target.value) || 1;', 'onChange(v);')}\nreturn v;`,
  );

  const CAPS = [null, undefined, 0, -5, Number.NaN, 50, 100, 400, 2000, 999999];
  const VALUES = [1, 50, 75, 100, 150, 2000, UNLIMITED_LEVERAGE];

  it('has the web ladder, the web Unlimited, and the web option list', () => {
    const ladder = /export const LEVERAGE_LADDER = \[([^\]]+)\];/.exec(DROPDOWN)?.[1]?.split(',').map((n) => Number(n.trim()));
    expect([...LEVERAGE_LADDER]).toEqual(ladder);
    expect(DROPDOWN).toContain(`export const UNLIMITED_LEVERAGE = ${UNLIMITED_LEVERAGE};`);
    expect(LEVERAGE_OPTIONS).toEqual(webDropdown(null, 1, false, UNLIMITED_LEVERAGE, LEVERAGE_LADDER).OPTIONS);
  });

  it('locks, labels and selects options the same way under every cap', () => {
    for (const cap of CAPS) {
      for (const value of VALUES) {
        for (const custom of [false, true]) {
          const w = webDropdown(cap, value, custom, UNLIMITED_LEVERAGE, LEVERAGE_LADDER);
          const c = leverageCap(cap);
          expect({ cap, hasCap: c != null }).toEqual({ cap, hasCap: w.hasCap });
          expect({ cap, value, custom, ours: leverageDisplay(value, custom, c) }).toEqual({ cap, value, custom, ours: w.display });
          for (const opt of LEVERAGE_OPTIONS) {
            expect({ cap, opt, locked: isLeverageLocked(opt, c) }).toEqual({ cap, opt, locked: w.isLocked(opt) });
            expect({ opt, value, custom, sel: isLeverageOptionSelected(opt, value, custom) })
              .toEqual({ opt, value, custom, sel: webSelected(opt, custom, value, UNLIMITED_LEVERAGE) });
          }
        }
      }
    }
  });

  it('clamps the Custom field and snaps an over-cap value down the same way', () => {
    expect(DROPDOWN).toContain('if (Number(value) > capNum) onChange(capNum);');
    for (const cap of CAPS) {
      const w = webDropdown(cap, 1, true, UNLIMITED_LEVERAGE, LEVERAGE_LADDER);
      const c = leverageCap(cap);
      for (const text of ['', '0', '-3', '1', '75', '150', '2500', 'abc', '12.5']) {
        expect({ cap, text, ours: clampCustomLeverage(text, c) }).toEqual({ cap, text, ours: webCustom({ target: { value: text } }, w.hasCap, w.capNum) });
      }
      for (const value of VALUES) {
        const webSnap = w.hasCap && Number(value) > w.capNum ? w.capNum : null;
        expect({ cap, value, ours: leverageSnapTarget(value, c) }).toEqual({ cap, value, ours: webSnap });
      }
    }
  });
});
