/**
 * The rules of EquityHub's money flows — Wallet.jsx InlineDepositFlow and
 * WithdrawView, components/WithdrawalMethods.jsx — as utils/fundsFlows
 * implements them, pinned against the web's own source where a slice of it
 * can be run, and by example where it is JSX.
 */
import fs from 'fs';
import path from 'path';

import { toDepositDetails, toWithdrawalMethod, verifiedForRail } from '@/types/wallet';
import {
  DEPOSIT_METHODS_FAILED,
  DEPOSIT_METHODS_NONE,
  DEPOSIT_PRESETS,
  DEPOSIT_STEPS,
  REMOVE_METHOD_CONFIRM,
  TX_REFERENCE_MIN,
  WITHDRAW_METHODS_FAILED,
  WITHDRAW_METHODS_NONE,
  WITHDRAW_STEPS,
  accountKindLabel,
  accountTotal,
  addMethodProblem,
  addMethodTypes,
  apiErrorCode,
  availableToWithdraw,
  belowMinDeposit,
  canonicalAmount,
  coerceWithdrawRail,
  defaultFlowAccountId,
  depositAssurance,
  depositCanNext,
  depositFee,
  depositMethodMeta,
  depositMethods,
  depositPrimaryLabel,
  depositReviewRows,
  depositSteps,
  depositSuccessMessage,
  fallbackDepositMethod,
  fmtBytes,
  isOverBudget,
  isShareSelected,
  isStaleMethodRefusal,
  manualDepositProblem,
  methodLine,
  methodStatusStyle,
  minDepositNotice,
  minDepositToast,
  noAddableRails,
  planMinDeposit,
  railFee,
  razorpayCreditedMessage,
  sanitizeAmountInput,
  shareOf,
  withdrawAmountNote,
  withdrawCanNext,
  withdrawFee,
  withdrawFooterNote,
  withdrawLimits,
  withdrawPrimaryLabel,
  withdrawProblem,
  withdrawRailMeta,
  withdrawRails,
  withdrawReviewRows,
  withdrawSteps,
  withdrawSuccessMessage,
  withdrawalFieldKey,
  withdrawalSchema,
} from '@/utils/fundsFlows';

const ROOT = path.join(__dirname, '../../..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const WALLET = read('client/src/pages/Wallet.jsx');
const METHODS_JSX = read('client/src/components/WithdrawalMethods.jsx');
const PAYMENT_METHODS = read('backend/src/utils/paymentMethods.js');

const between = (src: string, start: string, end: string, from = 0): string => {
  const a = src.indexOf(start, from);
  if (a < 0) throw new Error(`slice start moved: ${start}`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`slice end moved: ${end}`);
  return src.slice(a, b);
};

const DETAILS = toDepositDetails({
  UPI: { upiId: 'pay@okaxis', payeeName: 'EquityHub', minDeposit: 500, maxDeposit: 200000, feePercent: 1, feeFixed: 5, minWithdrawal: 1000, withdrawalFeePercent: 0.5 },
  BANK: { accountName: 'EquityHub Pvt', accountNumber: '9876', ifsc: 'HDFC0001', bankName: 'HDFC', enabled: false },
  RAZORPAY: { enabled: true, feePercent: 2, withdrawalEnabled: false },
  custom: [
    { id: 'paytm', label: 'Paytm', emoji: '💸', fields: [{ label: 'Number', value: '99999' }], minDeposit: 100, withdrawalFeeFixed: 10, maxWithdrawal: 5000 },
    { id: 'off', label: 'Off', enabled: false, withdrawalEnabled: false },
  ],
});

/* ══ Shared ═══════════════════════════════════════════════════════════ */

describe('shared', () => {
  it('a typed amount keeps one decimal point and is sent as the number it means', () => {
    expect(sanitizeAmountInput('1,2.3.4a')).toBe('1.234');
    expect(canonicalAmount('10.')).toBe('10');
    expect(canonicalAmount('.5')).toBe('0.5');
    expect(canonicalAmount('007')).toBe('7');
    expect(canonicalAmount('1e3')).toBe('1e3');
  });

  it('an account’s total is a plain rupee sum (Wallet.jsx accountTotalUsd)', () => {
    expect(between(WALLET, 'function accountTotalUsd', '\n}\n')).toMatch(/INR-only: every wallet row is rupees, so this is a plain sum/);
    const rows = [
      { accountId: 'a', balance: '100.5', free: '80', locked: '20.5' },
      { accountId: 'a', balance: '10', free: '10', locked: '0' },
      { accountId: 'b', balance: '999', free: '999', locked: '0' },
    ];
    expect(accountTotal(rows, 'a', 'balance')).toBe(110.5);
    expect(accountTotal(rows, 'a', 'free')).toBe(90);
    expect(accountTotal(rows, 'a', 'locked')).toBe(20.5);
  });

  it('both flows default to a live account; the chip says Live · Real or Demo', () => {
    expect(defaultFlowAccountId([{ id: 'd', accountType: 'DEMO' }, { id: 'p', accountType: 'PRO' }])).toBe('p');
    expect(defaultFlowAccountId([{ id: 'd', accountType: 'VIRTUAL' }])).toBe('d');
    expect(accountKindLabel({ accountType: 'STANDARD' })).toBe('Live · Real');
    expect(accountKindLabel({ accountType: 'VIRTUAL' })).toBe('Demo');
  });

  it('reads a server error code', () => {
    expect(apiErrorCode({ response: { data: { error: { code: 'KYC_REQUIRED' } } } })).toBe('KYC_REQUIRED');
    expect(apiErrorCode(new Error('x'))).toBeNull();
  });

  it('fmtBytes is imageCompress.js’s', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(2048)).toBe('2 KB');
    expect(fmtBytes(10 * 1024 * 1024)).toBe('10.0 MB');
  });
});

/* ══ Deposit ══════════════════════════════════════════════════════════ */

describe('deposit methods — InlineDepositFlow METHODS', () => {
  it('none are offered until the admin’s list has landed', () => {
    expect(depositMethods(null)).toEqual([]);
    expect(WALLET).toContain("const METHODS = payState !== 'ready' ? [] : [");
  });

  it('enabled manual rails, enabled custom rails, then Razorpay when on', () => {
    const m = depositMethods(DETAILS);
    expect(m.map((x) => x.id)).toEqual(['UPI', 'CUSTOM:paytm', 'RAZORPAY']);
    expect(m[0]).toMatchObject({ label: 'UPI', sub: 'Instant · Free', kind: 'manual', postAs: 'UPI' });
    expect(m[1]).toMatchObject({ label: 'Paytm', sub: 'Manual', postAs: 'Paytm', emoji: '💸' });
    expect(m[2]).toMatchObject({ label: 'Razorpay', sub: 'UPI / Card · Instant', kind: 'instant', rail: null });
    expect(WALLET).toContain("{ id: 'UPI',      label: 'UPI',           sub: 'Instant · Free',         kind: 'manual',  icon: <MUPI /> }");
    expect(WALLET).toContain("{ id: 'BANK',     label: 'Bank Transfer', sub: 'NEFT / IMPS · 1-3 hrs',  kind: 'manual',  icon: <MBank /> }");
    expect(WALLET).toContain("{ id: 'RAZORPAY', label: 'Razorpay', sub: 'UPI / Card · Instant', kind: 'instant', icon: <MRazor /> }");
  });

  it('Razorpay switched off is not offered', () => {
    const d = toDepositDetails({ RAZORPAY: { enabled: false } });
    expect(depositMethods(d).map((x) => x.id)).toEqual(['UPI', 'BANK']);
  });

  it('a card’s minimum is the higher of the rail’s and the tier’s, and says which binds', () => {
    const [upi, paytm] = depositMethods(DETAILS, 1000);
    expect(upi).toMatchObject({ min: 1000, max: 200000, planFloored: true });
    expect(paytm).toMatchObject({ min: 1000, planFloored: true });
    const [upiNoTier] = depositMethods(DETAILS, 0);
    expect(upiNoTier).toMatchObject({ min: 500, planFloored: false });
    expect(depositMethodMeta({ min: 1000, max: 200000, planFloored: true })).toBe('Min · ₹1,000.00 (account tier)  ·  Max · ₹2,00,000.00');
    expect(depositMethodMeta({ min: 500, max: 0, planFloored: false })).toBe('Min · ₹500.00');
    expect(depositMethodMeta({ min: 0, max: 0, planFloored: false })).toBe('No minimum');
  });

  it('the fee is the web’s methodFee: % + fixed, to the cent, never above the amount', () => {
    const body = between(WALLET, '  const methodFee = (grossAmt) => {', '\n  };');
    expect(body).toContain('Math.min(g, Math.round((g * pct / 100 + fixed) * 100) / 100)');
    const [upi, , rzp] = depositMethods(DETAILS);
    expect(depositFee(upi, 1000)).toBe(15);
    expect(depositFee(rzp, 999)).toBe(19.98);
    expect(railFee(3, 0, 5)).toBe(3);
    expect(depositFee(null, 100)).toBe(0);
  });

  it('a hidden method falls back like the web’s effect', () => {
    expect(fallbackDepositMethod(DETAILS, 'BANK')).toBe('UPI');
    expect(fallbackDepositMethod(DETAILS, 'CUSTOM:off')).toBe('UPI');
    expect(fallbackDepositMethod(DETAILS, 'CUSTOM:paytm')).toBe('CUSTOM:paytm');
    expect(fallbackDepositMethod(null, 'BANK')).toBe('BANK');
    const allOff = toDepositDetails({ UPI: { enabled: false }, BANK: { enabled: false }, RAZORPAY: { enabled: false } });
    expect(fallbackDepositMethod(allOff, 'UPI')).toBe('UPI');
    const onlyRzp = toDepositDetails({ UPI: { enabled: false }, BANK: { enabled: false } });
    expect(fallbackDepositMethod(onlyRzp, 'UPI')).toBe('RAZORPAY');
  });

  it('the method step’s notices are the web’s', () => {
    expect(WALLET).toContain("Couldn&apos;t load the available payment methods. Check your connection and reload this page before sending any money.");
    expect(DEPOSIT_METHODS_FAILED).toBe("Couldn't load the available payment methods. Check your connection and reload this page before sending any money.");
    expect(WALLET).toContain(DEPOSIT_METHODS_NONE);
  });
});

describe('deposit flow', () => {
  it('the steps; a practice account and Razorpay skip the proof', () => {
    expect(DEPOSIT_STEPS.map((s) => s.label)).toEqual(['Account', 'Payment Method', 'Amount', 'Upload Proof', 'Confirmation']);
    expect(depositSteps(true).map((s) => s.id)).toEqual(['account', 'method', 'amount', 'confirm']);
  });

  it('rupee presets', () => {
    expect(WALLET).toContain('const PRESETS = [1000, 5000, 10000, 25000, 50000];');
    expect(DEPOSIT_PRESETS).toEqual([1000, 5000, 10000, 25000, 50000]);
  });

  it('the tier minimum — rupees, real money only', () => {
    const plans = { PRO: { minDeposit: '5000' } } as never;
    expect(planMinDeposit(plans, { accountType: 'pro' })).toBe(5000);
    expect(planMinDeposit(plans, { accountType: 'FREE' })).toBe(0);
    expect(belowMinDeposit({ isReal: true, planMin: 5000, amount: 4999 })).toBe(true);
    expect(belowMinDeposit({ isReal: false, planMin: 5000, amount: 1 })).toBe(false);
    expect(minDepositToast({ nickname: null, accountType: 'PRO' }, 5000)).toBe('Minimum deposit for PRO is ₹5,000.00.');
    expect(minDepositNotice({ account: { nickname: 'Swing', accountType: 'PRO' }, min: 5000, amount: 1200 }))
      .toBe('⚠ Minimum deposit for the Swing plan is ₹5,000.00. You entered ₹1,200.00 — please increase the amount.');
  });

  it('Continue: a listed method, an amount within the limits, the proof', () => {
    const base = {
      accountId: 'a', payReady: true, methodListed: true, amount: '1000', method: { min: 500, max: 2000 },
      belowMin: false, skipProof: false, hasProof: true, txReference: 'UTR1', senderName: 'Ravi', isReal: true,
    };
    expect(depositCanNext({ ...base, stepId: 'method' })).toBe(true);
    expect(depositCanNext({ ...base, stepId: 'method', payReady: false })).toBe(false);
    expect(depositCanNext({ ...base, stepId: 'method', methodListed: false })).toBe(false);
    expect(depositCanNext({ ...base, stepId: 'amount' })).toBe(true);
    expect(depositCanNext({ ...base, stepId: 'amount', amount: '499' })).toBe(false);
    expect(depositCanNext({ ...base, stepId: 'amount', amount: '2001' })).toBe(false);
    expect(depositCanNext({ ...base, stepId: 'amount', method: { min: 0, max: 0 }, amount: '1' })).toBe(true);
    expect(depositCanNext({ ...base, stepId: 'amount', belowMin: true })).toBe(false);
    expect(depositCanNext({ ...base, stepId: 'proof' })).toBe(true);
    expect(depositCanNext({ ...base, stepId: 'proof', hasProof: false })).toBe(false);
    expect(depositCanNext({ ...base, stepId: 'proof', senderName: ' ' })).toBe(false);
    // DIFFERS: the server's four-character reference minimum, here not after the upload.
    expect(depositCanNext({ ...base, stepId: 'proof', txReference: 'UTR' })).toBe(false);
    expect(TX_REFERENCE_MIN).toBe(4);
  });

  it('the refusals, toasts, button and review are the web’s words', () => {
    expect(manualDepositProblem({ isReal: true, hasProof: false, txReference: 'x' })).toBe('Payment screenshot required for real account');
    expect(manualDepositProblem({ isReal: true, hasProof: true, txReference: ' ' })).toBe('Transaction reference required (UPI ref / bank ref)');
    expect(depositSuccessMessage(true, '2500')).toBe('₹2,500.00 added to demo account!');
    expect(depositSuccessMessage(false, '2500')).toBe('Deposit submitted — pending admin verification');
    expect(razorpayCreditedMessage('999')).toBe('₹999.00 credited');
    expect(depositPrimaryLabel({ loading: false, isDemo: false, isRazor: true, amount: '1000' })).toBe('Pay ₹1,000.00 via Razorpay');
    expect(depositPrimaryLabel({ loading: false, isDemo: true, isRazor: false, amount: '1' })).toBe('Add to Demo Account');
    expect(depositPrimaryLabel({ loading: false, isDemo: false, isRazor: false, amount: '1' })).toBe('Confirm Deposit');
    expect(depositReviewRows({
      account: { nickname: 'Main', accountNumber: '100', accountType: 'PRO' },
      methodLabel: 'UPI', amount: '1000', fee: 15, isReal: true, isRazor: false, txReference: 'UTR1', senderName: '',
    })).toEqual([
      { l: 'Account', v: 'Main · PRO' },
      { l: 'Method', v: 'UPI' },
      { l: 'Amount', v: '₹1,000.00' },
      { l: 'Fees', v: '₹15.00' },
      { l: 'Receive', v: '₹985.00' },
      { l: 'Reference', v: 'UTR1' },
      { l: 'Sender', v: '—' },
    ]);
    expect(depositAssurance(true, false)).toBe('Your payment is protected with bank-grade encryption. Admin will verify your screenshot within 1–24 hours.');
    expect(WALLET).toContain("'Admin will verify your screenshot within 1–24 hours.'");
    expect(depositAssurance(true, true)).toContain('Instant credit — powered by Razorpay.');
    expect(depositAssurance(false, false)).toContain('Demo funds credit instantly.');
  });
});

/* ══ Withdraw ═════════════════════════════════════════════════════════ */

describe('withdrawal rails — WithdrawView METHODS / WithdrawModal rails', () => {
  it('fixed rails open for PAYOUTS (UPI, Bank, Razorpay) then open custom rails', () => {
    expect(WALLET).toContain("const W_FIXED_RAIL_IDS = ['UPI', 'BANK', 'RAZORPAY'];");
    expect(PAYMENT_METHODS).toContain("const FIXED_METHOD_IDS = ['UPI', 'BANK', 'RAZORPAY'];");
    const rails = withdrawRails(DETAILS);
    // BANK is closed for deposits, and with no withdrawal switch that closes payouts too; Razorpay's payouts are off.
    expect(rails.map((r) => r.id)).toEqual(['UPI', 'paytm']);
    expect(rails[0]).toMatchObject({ label: 'UPI', sub: 'Instant · Free', blurb: 'Instant · to your UPI ID', methodKey: null, min: 1000, feePercent: 0.5 });
    expect(rails[1]).toMatchObject({ label: 'Paytm', sub: 'Manual', blurb: 'Manual', methodKey: 'paytm', max: 5000, feeFixed: 10, emoji: '💸' });
    expect(withdrawRails(null)).toEqual([]);
  });

  it('a rail’s limits line', () => {
    expect(withdrawRailMeta({ min: 1000, max: 0 })).toBe('Min · ₹1,000.00');
    expect(withdrawRailMeta({ min: 0, max: 0 })).toBe('No limit');
    expect(withdrawRailMeta({ min: 1, max: 5000 })).toBe('Min · ₹1.00  ·  Max · ₹5,000.00');
  });

  it('a closed rail moves to the first open one', () => {
    const rails = withdrawRails(DETAILS);
    expect(coerceWithdrawRail(rails, 'BANK')).toBe('UPI');
    expect(coerceWithdrawRail(rails, 'paytm')).toBe('paytm');
    expect(coerceWithdrawRail([], 'BANK')).toBe('BANK');
  });

  it('the withdrawal fee is backend utils/withdrawalFee: % + fixed, never above the amount', () => {
    const [upi, paytm] = withdrawRails(DETAILS);
    expect(withdrawFee(upi, 10000)).toBe(50);
    // DIFFERS: the web looks a custom rail's fee up under `CUSTOM:<id>`, which
    // a withdrawal rail id never is, and so previews ₹0.
    expect(between(WALLET, '  const withdrawFee = (grossAmt) => {', '\n  };')).toContain("`CUSTOM:${c.id}` === method");
    expect(withdrawFee(paytm, 100)).toBe(10);
    expect(withdrawFee(paytm, 4)).toBe(4);
  });

  it('verified destinations on a rail: native by type, others by methodKey', () => {
    const methods = [
      toWithdrawalMethod({ id: 'u1', type: 'UPI', label: 'Main UPI', status: 'VERIFIED', isVerified: true, maskedDestination: 'ra**@ok' }),
      toWithdrawalMethod({ id: 'u2', type: 'UPI', label: 'Old', status: 'PENDING', isVerified: false }),
      toWithdrawalMethod({ id: 'c1', type: 'CUSTOM', label: 'Paytm', status: 'VERIFIED', isVerified: true, methodKey: 'paytm' }),
      toWithdrawalMethod({ id: 'c2', type: 'CUSTOM', label: 'Wise', status: 'VERIFIED', isVerified: true, methodKey: 'wise' }),
    ];
    expect(verifiedForRail(methods, 'UPI').map((m) => m.id)).toEqual(['u1']);
    expect(verifiedForRail(methods, 'paytm').map((m) => m.id)).toEqual(['c1']);
    expect(methods[0]?.masked).toBe('ra**@ok');
  });

  it('the method step’s notices are the web’s', () => {
    expect(WALLET).toContain("Couldn&apos;t load the available withdrawal methods. Check your connection and reload this page before requesting a payout.");
    expect(WITHDRAW_METHODS_FAILED).toContain("Couldn't load the available withdrawal methods.");
    expect(WALLET).toContain(WITHDRAW_METHODS_NONE);
  });
});

describe('withdraw flow', () => {
  it('the steps; practice money skips method and destination', () => {
    expect(WITHDRAW_STEPS.map((s) => s.label)).toEqual(['Account', 'Method', 'Amount', 'Destination', 'Confirmation']);
    expect(withdrawSteps(true).map((s) => s.id)).toEqual(['account', 'amount', 'confirm']);
  });

  it('available: every wallet’s free part, floored at zero', () => {
    expect(availableToWithdraw([{ accountId: 'a', free: '120.5' }, { accountId: 'a', free: '-5' }, { accountId: 'b', free: '9' }], 'a')).toBe(120.5);
    expect(availableToWithdraw([], '')).toBe(0);
  });

  it('MAX and the percentages floor to the cent (DIFFERS: the web rounds 12.345 up)', () => {
    expect(shareOf(12.345, 100)).toBe('12.34');
    expect(shareOf(0.29, 100)).toBe('0.29');
    expect(shareOf(1000, 25)).toBe('250.00');
    expect(isShareSelected('250', 1000, 25)).toBe(true);
    expect(isOverBudget('100.01', 100)).toBe(true);
  });

  it('the rail’s limits and the amount note, in the web’s words', () => {
    const rail = { label: 'UPI', min: 1000, max: 50000 };
    expect(withdrawLimits({ amount: '500', rail, isDemo: false })).toEqual({ belowMin: true, aboveMax: false });
    expect(withdrawLimits({ amount: '500', rail, isDemo: true })).toEqual({ belowMin: false, aboveMax: false });
    expect(withdrawAmountNote({ overBudget: true, belowMin: true, aboveMax: false, rail })).toEqual({ text: 'Exceeds your available balance', error: true });
    expect(withdrawAmountNote({ overBudget: false, belowMin: true, aboveMax: false, rail })?.text).toBe('Minimum withdrawal for UPI is ₹1,000.00');
    expect(withdrawAmountNote({ overBudget: false, belowMin: false, aboveMax: true, rail })?.text).toBe('Maximum withdrawal for UPI is ₹50,000.00 per transaction');
    expect(withdrawAmountNote({ overBudget: false, belowMin: false, aboveMax: false, rail })).toEqual({ text: 'Min ₹1,000.00 · Max ₹50,000.00 per transaction', error: false });
    expect(WALLET).toContain('Minimum withdrawal for {selectedMethodMeta?.label} is {sym}{fmtNum(activeLimits.min, 2)}');
  });

  it('Continue', () => {
    const base = { accountId: 'a', payReady: true, methodListed: true, amount: '1500', belowMin: false, aboveMax: false, overBudget: false, withdrawalMethodId: 'm1' };
    expect(withdrawCanNext({ ...base, stepId: 'method' })).toBe(true);
    expect(withdrawCanNext({ ...base, stepId: 'method', payReady: false })).toBe(false);
    expect(withdrawCanNext({ ...base, stepId: 'amount', overBudget: true })).toBe(false);
    expect(withdrawCanNext({ ...base, stepId: 'amount', amount: '0' })).toBe(false);
    expect(withdrawCanNext({ ...base, stepId: 'destination', withdrawalMethodId: '' })).toBe(false);
  });

  it('the refusals, toasts, button, footer and review', () => {
    expect(withdrawProblem('', 10)).toBe('Enter a valid amount');
    expect(withdrawProblem('20', 10)).toBe('Insufficient balance. Available: ₹10.00');
    expect(withdrawSuccessMessage(true)).toBe('Demo withdrawal completed instantly');
    expect(withdrawSuccessMessage(false)).toBe('Withdrawal request submitted — admin will process within 24 hours');
    expect(WALLET).toContain("'Withdrawal request submitted — admin will process within 24 hours'");
    expect(withdrawPrimaryLabel({ loading: false, isDemo: true, amount: '100' })).toBe('Withdraw ₹100.00 instantly');
    expect(withdrawPrimaryLabel({ loading: false, isDemo: false, amount: '100' })).toBe('Request Withdrawal of ₹100.00');
    expect(withdrawFooterNote(false)).toBe('Withdrawals are processed manually within 1–24 hours');
    expect(withdrawFooterNote(true)).toBe('Demo withdrawals are processed instantly');
    expect(withdrawReviewRows({
      account: { nickname: null, accountNumber: '100', accountType: 'PRO' },
      methodLabel: 'UPI', amount: '1000', fee: 5, destination: { label: 'Main UPI', masked: 'ra**@ok' },
    })).toEqual([
      { l: 'Account', v: '100 · PRO' },
      { l: 'Method', v: 'UPI' },
      { l: 'Amount', v: '₹1,000.00' },
      { l: 'Fees', v: '₹5.00' },
      { l: 'Receive', v: '₹995.00' },
      { l: 'Destination', v: 'Main UPI' },
      { l: 'Details', v: 'ra**@ok' },
    ]);
  });

  it('a stale saved method is re-read', () => {
    for (const c of ['WITHDRAWAL_METHOD_REQUIRED', 'WITHDRAWAL_METHOD_NOT_FOUND', 'WITHDRAWAL_METHOD_NOT_VERIFIED', 'WITHDRAWAL_METHOD_BLOCKED', 'WITHDRAWAL_METHOD_REJECTED']) {
      expect(isStaleMethodRefusal(c)).toBe(true);
    }
    expect(isStaleMethodRefusal('INSUFFICIENT_FUNDS')).toBe(false);
  });
});

/* ══ Withdrawal methods (WithdrawalMethods.jsx) ═══════════════════════ */

describe('withdrawal methods', () => {
  /** WithdrawalMethods.jsx fieldKey, as shipped. */
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const webFieldKey = new Function(`${between(METHODS_JSX, 'const fieldKey = (f) =>', 'const STATUS_STYLE')}\nreturn fieldKey;`)() as (f: unknown) => string;

  it('the field key is the web’s and the server’s', () => {
    for (const f of [{ label: 'Wallet address' }, { label: '  UPI / VPA  ' }, { key: 'email', label: 'x' }, { label: '' }]) {
      expect({ f, ours: withdrawalFieldKey(f as never) }).toEqual({ f, ours: webFieldKey(f) });
    }
    expect(PAYMENT_METHODS).toContain(".replace(/[^a-z0-9]+/g, '_')");
  });

  it('the schema: the admin’s fields on any rail; native rails keep their form; else one default field', () => {
    const fields = [{ label: 'Phone', key: null, required: true, sensitive: false, placeholder: null }];
    expect(withdrawalSchema('UPI', [])).toBeNull();
    expect(withdrawalSchema('UPI', fields)).toEqual(fields);
    expect(withdrawalSchema('RAZORPAY', [])).toEqual([{ label: 'Account / address', key: null, required: true, sensitive: true, placeholder: null }]);
    expect(METHODS_JSX).toContain("const DEFAULT_WITHDRAWAL_FIELDS = [{ label: 'Account / address', required: true, sensitive: true }];");
  });

  it('the Add form’s types: open native rails (Bank, UPI), generic fixed (Razorpay), custom', () => {
    const d = toDepositDetails({
      UPI: { withdrawalEnabled: false },
      custom: [{ id: 'wise', label: 'Wise', emoji: '🌍' }, { id: 'no', label: 'No', withdrawalEnabled: false }],
    });
    const t = addMethodTypes(d);
    expect(t.map((x) => [x.id, x.label, x.native])).toEqual([
      ['BANK', 'Bank Account', true],
      ['RAZORPAY', 'Razorpay', false],
      ['wise', '🌍 Wise', false],
    ]);
    // A failed config read offers the built-ins rather than an empty form.
    expect(addMethodTypes(null).map((x) => x.id)).toEqual(['BANK', 'UPI', 'RAZORPAY']);
    expect(noAddableRails(toDepositDetails({ UPI: { withdrawalEnabled: false }, BANK: { withdrawalEnabled: false } }))).toBe(true);
    expect(noAddableRails(null)).toBe(false);
  });

  it('labels, statuses and the confirm are the web’s words', () => {
    expect(addMethodProblem(' a ')).toBe('Add a label (e.g. "HDFC Salary")');
    expect(addMethodProblem('HDFC')).toBeNull();
    expect(METHODS_JSX).toContain(`window.confirm('${REMOVE_METHOD_CONFIRM}')`);
    expect(methodStatusStyle('VERIFIED')).toEqual({ label: 'Verified', tone: 'bull' });
    expect(methodStatusStyle('PENDING')).toEqual({ label: 'Pending', tone: 'warn' });
    expect(methodStatusStyle('REJECTED')).toEqual({ label: 'Rejected', tone: 'bear' });
    expect(methodStatusStyle('BLOCKED')).toEqual({ label: 'Blocked', tone: 'neutral' });
    expect(methodStatusStyle('WHATEVER').label).toBe('Pending');
    expect(methodLine({ type: 'UPI', masked: 'ra**@ok' })).toBe('UPI ID · ra**@ok');
    expect(methodLine({ type: 'CUSTOM', masked: '••99' })).toBe('••99');
  });
});
