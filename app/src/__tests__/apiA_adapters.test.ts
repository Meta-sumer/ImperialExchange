/**
 * The account / auth / money adapters, against the shapes the backend
 * actually sends and the ones it sends when something upstream is missing.
 *
 * The rule under test everywhere: a missing field becomes an honest absence
 * (null, '0', the server's own default) — never a number that looks real.
 */
import {
  buildCreateAccountPayload,
  nicknameError,
  normaliseNickname,
} from '@/api/account.api';
import {
  isResetSessionExpired,
  registerErrorField,
} from '@/api/auth.api';
import { base64ByteLength, kycUploadError, stripDataUrlPrefix } from '@/api/compliance.api';
import { insufficientBalance } from '@/api/subscription.api';
import {
  insufficientTradingBalance,
  bonusTopUpError,
  withdrawErrorMessage,
} from '@/api/wallet.api';
import {
  isPostPaidPlan,
  planNeedsPayment,
  planPrice,
  toMySubscription,
  toPlan,
  toSubscription,
} from '@/types/subscription';
import {
  effectiveKycStatus,
  indexPlansByCode,
  isClientRole,
  kycDocDisplayStatus,
  toAccountPlan,
  toAuthUser,
  toKycDocument,
  toLeverageState,
  toSessionDevice,
  toUserAccount,
  userReferredBy,
} from '@/types/user';
import {
  DEFAULT_PEER_TRANSFER_SETTINGS,
  customRailId,
  depositRailExtras,
  depositRailRows,
  enabledCustomRails,
  enabledDepositRails,
  ledgerCounterpartyLabel,
  ledgerTypeLabel,
  payoutRailTypes,
  toBonusWallet,
  toDeposit,
  toDepositDetails,
  toFxRate,
  toLedgerEntry,
  toBillingWallet,
  toPeerTransferResult,
  toPeerTransferSettings,
  toRazorpayOrder,
  toTransferRecipient,
  toWalletBalance,
  toWalletTransaction,
  toWithdrawal,
  toWithdrawalMethod,
  usableWithdrawalMethods,
} from '@/types/wallet';

/** The error an axios call rejects with, as far as the readers look. */
const apiError = (status: number, code: string, message = 'Refused', details?: unknown) => ({
  isAxiosError: true,
  message: `Request failed with status code ${status}`,
  response: { status, data: { success: false, error: { code, message, details } } },
});

/* ══ The signed-in user ════════════════════════════════════════════════ */

describe('toAuthUser', () => {
  const me = {
    _id: '65f000000000000000000001',
    email: 'trader@example.com',
    firstName: 'Asha',
    lastName: 'Rao',
    role: 'USER',
    phone: '+919800000000',
    kycStatus: 'APPROVED',
    userUid: 'USR100245',
    twoFactorEnabled: true,
    isEmailVerified: true,
    referralCode: 'ASHA10',
    referredBy: { firstName: 'Ravi', lastName: null, email: 'r@example.com', referralCode: 'RAVI1' },
    kycRejectionReason: null,
  };

  it('reads the /auth/me document', () => {
    const u = toAuthUser(me);
    expect(u).not.toBeNull();
    expect(u).toMatchObject({
      id: me._id,
      email: me.email,
      name: 'Asha Rao',
      role: 'USER',
      phone: '+919800000000',
      kycStatus: 'APPROVED',
      userUid: 'USR100245',
      twoFactorEnabled: true,
      emailVerified: true,
      referralCode: 'ASHA10',
      avatarUrl: null,
    });
    expect(u?.raw).toBe(me);
  });

  it('falls back to the email for the name, never an empty string', () => {
    expect(toAuthUser({ _id: 'x', email: 'a@b.c', firstName: '  ' })?.name).toBe('a@b.c');
  });

  it('refuses a body that is not a user', () => {
    expect(toAuthUser(null)).toBeNull();
    expect(toAuthUser([])).toBeNull();
    expect(toAuthUser({ foo: 1 })).toBeNull();
  });

  it('keeps an absent role absent, so the gate refuses it', () => {
    const u = toAuthUser({ _id: 'x', email: 'a@b.c' });
    expect(u?.role).toBe('');
    expect(isClientRole(u)).toBe(false);
    expect(isClientRole(toAuthUser({ _id: 'x', email: 'a@b.c', role: 'ADMIN' }))).toBe(false);
    expect(isClientRole(toAuthUser(me))).toBe(true);
  });

  it('reads the populated referrer', () => {
    expect(userReferredBy(toAuthUser(me))).toEqual({
      firstName: 'Ravi', lastName: null, email: 'r@example.com', referralCode: 'RAVI1',
    });
    // Anywhere but /auth/me it is a bare id.
    expect(userReferredBy(toAuthUser({ ...me, referredBy: '65f0' }))).toBeNull();
  });
});

describe('sessions', () => {
  it('reads a device row, and keeps a legacy row without an id unrevokable', () => {
    expect(toSessionDevice({ id: 'abc', deviceInfo: 'okhttp/4', createdAt: '2026-01-01T00:00:00Z' }))
      .toEqual({ id: 'abc', deviceInfo: 'okhttp/4', createdAt: '2026-01-01T00:00:00Z', lastSeenAt: null, current: false });
    expect(toSessionDevice({ id: null })).toEqual({ id: null, deviceInfo: 'Unknown device', createdAt: null, lastSeenAt: null, current: false });
  });
});

/* ══ Auth error readers ══════════════════ */

describe('auth error readers', () => {
  it('puts a register refusal under the right field', () => {
    expect(registerErrorField(apiError(409, 'DUPLICATE_EMAIL'))).toBe('email');
    expect(registerErrorField(apiError(409, 'DUPLICATE_PHONE'))).toBe('phone');
    expect(registerErrorField(apiError(400, 'INVALID_REFERRAL_CODE'))).toBe('referralCode');
    expect(registerErrorField(apiError(400, 'REFERRER_BLOCKED'))).toBe('referralCode');
    expect(registerErrorField(apiError(400, 'WEAK_PASSWORD'))).toBeNull();
  });

  it('sends the OTP reset back to step 1 only when its ticket is dead', () => {
    expect(isResetSessionExpired(apiError(400, 'RESET_TOKEN_INVALID'))).toBe(true);
    expect(isResetSessionExpired(apiError(400, 'RESET_NOT_VERIFIED'))).toBe(true);
    expect(isResetSessionExpired(apiError(400, 'OTP_INVALID'))).toBe(false);
  });
});

/* ══ KYC ═══════════════════════════════════════════════════════════════ */

describe('KYC', () => {
  it('reads a document, accepting the older reviewNote as the reason', () => {
    expect(toKycDocument({ _id: 'd1', docType: 'SELFIE', filename: 'me.jpg', status: 'REJECTED', reviewNote: 'Blurry' }))
      .toMatchObject({ id: 'd1', docType: 'SELFIE', originalFilename: 'me.jpg', status: 'REJECTED', rejectionReason: 'Blurry' });
  });

  it('reads documents on file under NOT_SUBMITTED as under review — Profile.jsx:392', () => {
    expect(effectiveKycStatus('NOT_SUBMITTED', [{ status: 'PENDING' }])).toBe('PENDING');
    expect(effectiveKycStatus(null, [])).toBe('NOT_SUBMITTED');
    // A rejected document is not "on file".
    expect(effectiveKycStatus('NOT_SUBMITTED', [{ status: 'REJECTED' }])).toBe('NOT_SUBMITTED');
    expect(effectiveKycStatus('APPROVED', [{ status: 'PENDING' }])).toBe('APPROVED');
  });

  it('never shows a rejected document as approved', () => {
    expect(kycDocDisplayStatus({ status: 'REJECTED' }, 'APPROVED')).toBe('REJECTED');
    expect(kycDocDisplayStatus({ status: 'PENDING' }, 'APPROVED')).toBe('APPROVED');
    expect(kycDocDisplayStatus({ status: 'PENDING' }, 'PENDING')).toBe('PENDING');
  });

  it('checks size and type before sending 10 MB of base64', () => {
    expect(base64ByteLength('QUJD')).toBe(3);
    expect(base64ByteLength('QUI=')).toBe(2);
    expect(base64ByteLength('QQ==')).toBe(1);
    expect(kycUploadError({ mimeType: 'image/png', dataBase64: 'QUJD' })).toBeNull();
    expect(kycUploadError({ mimeType: 'image/gif', dataBase64: 'QUJD' })).toBe('Upload a JPG, PNG, WEBP or PDF');
    const eleven = 'A'.repeat(Math.ceil((11 * 1024 * 1024 * 4) / 3));
    expect(kycUploadError({ mimeType: 'application/pdf', dataBase64: eleven })).toBe('File too large (max 10MB)');
  });

  it('strips a data URL prefix — the server wants bare base64', () => {
    expect(stripDataUrlPrefix('data:image/jpeg;base64,QUJD')).toBe('QUJD');
    expect(stripDataUrlPrefix('QUJD')).toBe('QUJD');
  });
});

/* ══ Accounts and tiers ════════════════════════════════════════════════ */

describe('toUserAccount', () => {
  it('reads an account row', () => {
    const a = toUserAccount({
      _id: 'a1', accountNumber: 'TP1001', accountType: 'PRO_IC', baseCurrency: 'INR',
      leverage: 500, mode: 'HYBRID', isActive: true, isTradingEnabled: false, nickname: 'Swing',
      status: 'SUSPENDED', planSuspendedReason: 'PLAN_LIMIT',
    });
    expect(a).toMatchObject({
      id: 'a1', accountNumber: 'TP1001', accountType: 'PRO_IC', leverage: 500, mode: 'HYBRID',
      isTradingEnabled: false, nickname: 'Swing', status: 'SUSPENDED', planSuspendedReason: 'PLAN_LIMIT',
    });
  });

  it('defaults the way the model does, and never invents a mode', () => {
    const a = toUserAccount({ _id: 'a2', mode: 'SOMETHING' });
    expect(a.baseCurrency).toBe('INR');
    expect(a.leverage).toBe(100);
    expect(a.mode).toBeUndefined();
    expect(a.isActive).toBe(true);
    expect(a.status).toBe('ACTIVE');
    expect(a.nickname).toBeNull();
  });
});

describe('creating and renaming accounts', () => {
  it('sends a practice balance only for a practice account', () => {
    expect(buildCreateAccountPayload({ accountType: 'DEMO', initialBalance: 10000 }))
      .toEqual({ accountType: 'DEMO', initialBalance: 10000 });
    // A live tier would be refused with it ("use a deposit instead").
    expect(buildCreateAccountPayload({ accountType: 'STANDARD', initialBalance: 10000 }))
      .toEqual({ accountType: 'STANDARD' });
  });

  it('never sends a base currency, and normalises the nickname', () => {
    const body = buildCreateAccountPayload({ accountType: 'PRO', leverage: 200, nickname: '  My   main  ', mode: 'INTERNAL' });
    expect(body).toEqual({ accountType: 'PRO', leverage: 200, mode: 'INTERNAL', nickname: 'My main' });
    expect('baseCurrency' in body).toBe(false);
    expect(buildCreateAccountPayload({ accountType: 'PRO', nickname: '   ' })).toEqual({ accountType: 'PRO' });
  });

  it('refuses the nicknames the server refuses, in the web’s words', () => {
    expect(normaliseNickname(' a \n b ')).toBe('a b');
    expect(nicknameError('   ')).toBe('Nickname cannot be empty');
    expect(nicknameError('x'.repeat(41))).toBe('Nickname too long (max 40)');
    expect(nicknameError('x'.repeat(40))).toBeNull();
  });
});

describe('toAccountPlan', () => {
  it('keeps an unlimited cap unlimited — null, never 0', () => {
    const p = toAccountPlan({ _id: 'p', code: 'pro', name: 'Pro', maxLeverage: null, minDeposit: 100, feeValue: 0.00005 });
    expect(p.code).toBe('PRO');
    expect(p.maxLeverage).toBeNull();
    expect(p.minDeposit).toBe(100);
    expect(p.feeValue).toBe(0.00005);
    expect(p.isActive).toBe(true);
  });

  it('indexes by uppercase code, the shape planFor reads', () => {
    const idx = indexPlansByCode([toAccountPlan({ code: 'free', name: 'Free' }), toAccountPlan({ code: 'PRO' })]);
    expect(Object.keys(idx).sort()).toEqual(['FREE', 'PRO']);
    expect(idx.PRO?.name).toBe('PRO');
  });
});

describe('toLeverageState', () => {
  it('reads the source label the order form shows', () => {
    const s = toLeverageState({
      effectiveLeverage: 999999, planDefault: 100, source: 'DEMO',
      sourceLabel: 'Demo account · unlimited', isDemo: true, isOverridden: false,
    });
    expect(s).toMatchObject({ effectiveLeverage: 999999, sourceLabel: 'Demo account · unlimited', isDemo: true, customLeverage: null });
  });
});

/* ══ Wallets ═══════════════════════════════════════════════════════════ */

describe('toWalletBalance', () => {
  it('reads the server’s free margin', () => {
    expect(toWalletBalance({ _id: 'w', accountId: 'a1', currency: 'INR', balance: '100.5', locked: '20', free: '80.5' }))
      .toMatchObject({ accountId: 'a1', balance: '100.5', locked: '20', free: '80.5' });
  });

  it('never substitutes the balance for a missing free figure', () => {
    // Doing so would overstate what can be withdrawn by the margin in use.
    expect(toWalletBalance({ balance: '100', locked: '40' }).free).toBe('0');
  });

  it('accepts a populated account reference', () => {
    expect(toWalletBalance({ accountId: { _id: 'a9' } }).accountId).toBe('a9');
  });
});

describe('ledger', () => {
  it('reads a peer transfer with its counterparty', () => {
    const e = toLedgerEntry({
      _id: 'l1', type: 'INTERNAL_TRANSFER_OUT', amount: '-25.00', balanceAfter: '75.00', currency: 'INR',
      counterparty: { userId: 'u2', name: 'Jane Doe', referralCode: null, avatarUrl: null },
    });
    expect(e.amount).toBe('-25.00');
    expect(ledgerTypeLabel(e)).toBe('Transfer Sent');
    expect(ledgerCounterpartyLabel(e)).toBe('to Jane Doe');
    const inbound = { ...e, type: 'INTERNAL_TRANSFER_IN' };
    expect(ledgerTypeLabel(inbound)).toBe('Transfer Received');
    expect(ledgerCounterpartyLabel(inbound)).toBe('from Jane Doe');
  });

  it('shows every other type as the server’s own enum', () => {
    const e = toLedgerEntry({ type: 'TRADE_CLOSE', amount: '3' });
    expect(ledgerTypeLabel(e)).toBe('TRADE_CLOSE');
    expect(ledgerCounterpartyLabel(e)).toBeNull();
  });
});

describe('deposits and withdrawals', () => {
  it('reads a deposit, defaulting a pre-multi-currency row to INR', () => {
    const d = toDeposit({ _id: 'd', amount: '5000', status: 'PENDING', netAmount: null });
    // EquityHub accounts are INR (backend BASE_CURRENCY), so both sides default to INR.
    expect(d).toMatchObject({ currency: 'INR', baseCurrency: 'INR', netAmount: null, targetWallet: 'trading' });
  });

  it('reads a withdrawal and its rejection reason under either spelling', () => {
    expect(toWithdrawal({ _id: 'w', rejectedReason: 'KYC mismatch' }).rejectedReason).toBe('KYC mismatch');
    expect(toWithdrawal({ _id: 'w', rejectionReason: 'Closed account' }).rejectedReason).toBe('Closed account');
    expect(toWithdrawal({}).status).toBe('PENDING');
  });

  it('reads a Razorpay order', () => {
    expect(toRazorpayOrder({ depositId: 'dep', orderId: 'order_1', amount: 500, currency: 'INR', keyId: 'rzp_live_x' }))
      .toEqual({ depositId: 'dep', orderId: 'order_1', amount: 500, currency: 'INR', keyId: 'rzp_live_x' });
  });

  // WithdrawModal.jsx: KYC gets an instruction; the monthly-P&L block the
  // server's wording (or the web's fallback); everything else the server's message.
  it('reads a refused withdrawal the way the web does', () => {
    expect(withdrawErrorMessage(apiError(403, 'KYC_REQUIRED'))).toBe('Complete KYC verification first (Profile → KYC).');
    expect(withdrawErrorMessage(apiError(400, 'WITHDRAWAL_BLOCKED_MONTHLY_PNL', 'Net P&L this month is ₹-120.')))
      .toBe('Net P&L this month is ₹-120.');
    expect(withdrawErrorMessage(apiError(400, 'WITHDRAWAL_BLOCKED_MONTHLY_PNL', '')))
      .toBe('Withdrawal blocked: your net trading P&L for this month must be positive to withdraw.');
    expect(withdrawErrorMessage(apiError(400, 'WITHDRAWAL_METHOD_REQUIRED', 'Select a saved, verified withdrawal method.')))
      .toBe('Select a saved, verified withdrawal method.');
    expect(withdrawErrorMessage(apiError(400, 'INSUFFICIENT_FUNDS', 'Insufficient balance.'))).toBe('Insufficient balance.');
  });
});

describe('deposit rails', () => {
  const details = toDepositDetails({
    UPI: { upiId: 'pay@okaxis', payeeName: 'EquityHub', enabled: true },
    BANK: { accountName: 'EquityHub Pvt', accountNumber: '', ifsc: 'HDFC0001', bankName: 'HDFC', withdrawalEnabled: false },
    RAZORPAY: {},
    // Stale keys from a pre-INR settings document — not EquityHub rails.
    CRYPTO: { address: 'TXyz', network: 'TRC20', enabled: false, withdrawalEnabled: false },
    SKRILL: {},
    custom: [
      { id: 'wise', label: 'Wise', fields: [{ label: 'Email', value: 'pay@wise.com' }, { label: 'Ref', value: ' ', copy: false }], note: 'Use your UID', enabled: true },
      { id: 'nolabel', label: '', fields: [] },
      { id: 'off', label: 'Off', enabled: false },
    ],
  });

  it('reads an absent flag as enabled', () => {
    expect(details.RAZORPAY.enabled).toBe(true);
    expect(details.RAZORPAY.withdrawalEnabled).toBe(true);
    expect(details.BANK.enabled).toBe(true);
    // Only the hand-paid fixed rails; Razorpay is its own checkout.
    expect(enabledDepositRails(details)).toEqual(['UPI', 'BANK']);
    expect(enabledDepositRails(toDepositDetails({ BANK: { enabled: false } }))).toEqual(['UPI']);
  });

  it('keeps only EquityHub’s rails — UPI, BANK, RAZORPAY (backend FIXED_METHOD_IDS)', () => {
    expect(Object.keys(details)).toEqual(['UPI', 'BANK', 'RAZORPAY', 'custom']);
  });

  it('drops custom rails without a label, and disabled ones from the picker', () => {
    expect(details.custom.map((c) => c.id)).toEqual(['wise', 'off']);
    expect(enabledCustomRails(details).map((c) => c.id)).toEqual(['wise']);
  });

  it('lists only the payee rows the admin filled in', () => {
    expect(depositRailRows(details, 'BANK').map((r) => r.label)).toEqual(['Beneficiary', 'IFSC', 'Bank']);
    expect(depositRailRows(details, 'UPI')).toEqual([
      { label: 'UPI ID', value: 'pay@okaxis', copyable: true },
      { label: 'Beneficiary', value: 'EquityHub', copyable: false },
    ]);
    expect(depositRailRows(details, customRailId({ id: 'wise' }))).toEqual([
      { label: 'Email', value: 'pay@wise.com', copyable: true },
    ]);
    // No payee rows (Razorpay is a checkout; a stale key is no rail at all) —
    // the caller must say so rather than show an empty card.
    expect(depositRailRows(details, 'RAZORPAY')).toEqual([]);
    expect(depositRailRows(details, 'SKRILL')).toEqual([]);
    expect(depositRailRows(null, 'UPI')).toEqual([]);
  });

  it('finds the note and QR for either kind of rail', () => {
    expect(depositRailExtras(details, 'CUSTOM:wise')).toEqual({ note: 'Use your UID', qr: null });
    expect(depositRailExtras(details, 'UPI')).toEqual({ note: null, qr: null });
  });

  it('offers only the payout rails the admin pays out on — none if the admin closed them all', () => {
    expect(payoutRailTypes(details)).toEqual(['UPI']);
    const allOff = toDepositDetails({
      UPI: { withdrawalEnabled: false }, BANK: { withdrawalEnabled: false },
    });
    // As on the web: the admin's choice, said on screen, not two dead rails.
    expect(payoutRailTypes(allOff)).toEqual([]);
    // Nothing loaded is not "all closed".
    expect(payoutRailTypes(null)).toEqual(['UPI', 'BANK']);
    // No stored withdrawal switch → the deposit one.
    expect(payoutRailTypes(toDepositDetails({ BANK: { enabled: false } }))).toEqual(['UPI']);
  });
});

describe('withdrawal methods', () => {
  it('derives verified-ness from status when the flag is absent', () => {
    expect(toWithdrawalMethod({ _id: 'm', type: 'UPI', masked: 'ra**@okicici', status: 'VERIFIED' }))
      .toMatchObject({ isVerified: true, label: 'ra**@okicici' });
    expect(toWithdrawalMethod({ _id: 'm', status: 'PENDING' }).isVerified).toBe(false);
  });

  it('offers only verified methods on an open rail', () => {
    const methods = [
      toWithdrawalMethod({ _id: '1', type: 'UPI', status: 'VERIFIED' }),
      toWithdrawalMethod({ _id: '2', type: 'BANK', status: 'VERIFIED' }),
      toWithdrawalMethod({ _id: '3', type: 'UPI', status: 'PENDING' }),
    ];
    expect(usableWithdrawalMethods(methods, ['UPI']).map((m) => m.id)).toEqual(['1']);
    expect(usableWithdrawalMethods(methods).map((m) => m.id)).toEqual(['1', '2']);
  });
});

describe('transfers', () => {
  it('keeps the web’s permissive defaults as the fallback', () => {
    expect(DEFAULT_PEER_TRANSFER_SETTINGS).toEqual({ enabled: true, min: '0', max: '0', feePercent: '0' });
    expect(toPeerTransferSettings({ enabled: false, min: '10', max: '5000', feePercent: '1.5' }))
      .toEqual({ enabled: false, min: '10', max: '5000', feePercent: '1.5' });
  });

  it('reads a recipient and a completed transfer', () => {
    expect(toTransferRecipient({ _id: 'u2', email: 'j@x.io', userUid: 'USR1' })).toMatchObject({ id: 'u2', name: 'j@x.io', userUid: 'USR1' });
    expect(toPeerTransferResult({ referenceId: 'r', recipient: { name: 'Jane' }, amount: '10', fee: '0.15', totalDebited: '10.15' }))
      .toMatchObject({ recipientName: 'Jane', totalDebited: '10.15', currency: 'INR' });
  });
});

describe('toFxRate — PORT-RULINGS §4', () => {
  it('uses a live rate', () => {
    expect(toFxRate({ rate: 88.12, source: 'yahoo', ts: 1 })).toEqual({ rate: 88.12, source: 'yahoo', ts: 1 });
  });

  it('refuses the server’s fallback figure — it cannot be vouched for', () => {
    expect(toFxRate({ rate: 83, source: 'fallback', ts: 1 }).rate).toBeNull();
  });

  it('refuses nonsense, and tolerates an envelope', () => {
    expect(toFxRate({ rate: 0 }).rate).toBeNull();
    expect(toFxRate({ rate: 'abc' }).rate).toBeNull();
    expect(toFxRate({ success: true, data: { rate: 87.5, source: 'cache' } }).rate).toBe(87.5);
  });
});

describe('The Main Wallet (the plan-billing wallet)', () => {
  it('reads auto-renew as on unless the server says off', () => {
    expect(toBillingWallet({ balance: '12.5' }).autoRenew).toBe(true);
    expect(toBillingWallet({ autoRenew: false }).autoRenew).toBe(false);
  });

  it("reads which wallet a /subscriptions/history row came from", () => {
    expect(toWalletTransaction({ _id: 'a', wallet: 'MAIN' }).wallet).toBe('MAIN');
    expect(toWalletTransaction({ _id: 'b', wallet: 'BONUS' }).wallet).toBe('BONUS');
    expect(toWalletTransaction({ _id: 'c' }).wallet).toBeNull();
    expect(toWalletTransaction({ _id: 'd', wallet: 'OTHER' }).wallet).toBeNull();
  });

  it('reads the bonus earnings roll-up', () => {
    const b = toBonusWallet({ balance: '40', totalReferralEarnings: '25', totalEarnings: '40' });
    expect(b).toMatchObject({ balance: '40', totalReferralEarnings: '25', totalPartnerEarnings: '0', totalEarnings: '40' });
  });

  it('reads a history row', () => {
    expect(toWalletTransaction({ _id: 't', transactionType: 'DEBIT', reason: 'SUBSCRIPTION', amount: '9.99', balanceAfter: null }))
      .toMatchObject({ transactionType: 'DEBIT', amount: '9.99', balanceAfter: null, status: 'SUCCESS' });
  });

  it('names the account and what it holds on a short top-up', () => {
    const err = apiError(400, 'INSUFFICIENT_TRADING_BALANCE', 'Insufficient', { accountNumber: 'TP1001', currency: 'INR', available: '4.20' });
    expect(insufficientTradingBalance(err)).toEqual({ accountNumber: 'TP1001', currency: 'INR', available: '4.20' });
    // DepositModal.jsx: `available ${sym}${details.available}` — rupees.
    expect(bonusTopUpError(err)).toBe('Not enough in TP1001 — available ₹4.20.');
    expect(insufficientTradingBalance(apiError(400, 'INSUFFICIENT_TRADING_BALANCE', 'x', { accountNumber: 'TP1' }))?.currency).toBe('INR');
    expect(bonusTopUpError(apiError(400, 'NO_REAL_ACCOUNT'))).toBe('Open a live trading account first.');
    expect(bonusTopUpError(apiError(400, 'PRACTICE_TRANSFER_NOT_ALLOWED', 'x')))
      .toBe('A demo account cannot fund the Main Wallet. Choose a live account.');
    expect(bonusTopUpError(apiError(400, 'OTHER', 'Server says no'))).toBe('Server says no');
  });
});

/* ══ Subscriptions ═════════════════════════════════════════════════════ */

describe('subscription plans', () => {
  const vip = toPlan({ _id: 'p', code: 'vip', name: 'VIP', monthlyPrice: '49', yearlyPrice: '490', limits: { maxAccounts: null, maxDevices: 5 } });
  const postpaid = toPlan({ code: 'POSTPAID', monthlyPrice: '10', features: { postPaid: true } });
  const free = toPlan({ code: 'FREE', monthlyPrice: '0', yearlyPrice: '0' });

  it('reads a plan, keeping an unlimited cap null', () => {
    expect(vip.code).toBe('VIP');
    expect(vip.limits.maxAccounts).toBeNull();
    expect(vip.limits.maxDevices).toBe(5);
    expect(vip.billingDays).toEqual({ monthly: 30, yearly: 365, unit: 'DAYS' });
  });

  it('prices by cycle and routes the switch the way Plans.jsx does', () => {
    expect(planPrice(vip, 'YEARLY')).toBe('490');
    expect(planNeedsPayment(vip, 'MONTHLY')).toBe(true);
    expect(isPostPaidPlan(postpaid)).toBe(true);
    expect(planNeedsPayment(postpaid, 'MONTHLY')).toBe(false);
    expect(planNeedsPayment(free, 'MONTHLY')).toBe(false);
  });

  it('reads /subscriptions/me, where the effective plan answers "which plan am I on"', () => {
    const me = toMySubscription({
      subscription: { _id: 's', planId: { code: 'VIP', name: 'VIP', monthlyPrice: '49' }, status: 'EXPIRED', expiresAt: '2026-01-01' },
      effectivePlan: { code: 'FREE', name: 'Free' },
      wallet: null,
      billingSource: 'BONUS_WALLET',
      billingWallet: { _id: 'bw', type: 'BONUS', balance: '3.00', currency: 'INR', isLowBalance: true },
      subscriptionWallet: { _id: 'bw', type: 'BONUS', balance: '3.00', currency: 'INR', isLowBalance: true },
    });
    expect(me.subscription?.planCode).toBe('VIP');
    expect(me.subscription?.plan?.name).toBe('VIP');
    expect(me.effectivePlan?.code).toBe('FREE');
    expect(me.billingSource).toBe('BONUS_WALLET');
    expect(me.billingWallet).toMatchObject({ balance: '3.00', isLowBalance: true });
    expect(toMySubscription({}).subscription).toBeNull();
    expect(toMySubscription({}).billingSource).toBe('BONUS_WALLET');
  });

  it('reads the billing wallet from billingWallet, falling back to the deprecated subscriptionWallet', () => {
    expect(toMySubscription({ subscriptionWallet: { balance: '7.00' } }).billingWallet?.balance).toBe('7.00');
    expect(toMySubscription({ billingWallet: { balance: '9.00' }, subscriptionWallet: { balance: '1.00' } }).billingWallet?.balance).toBe('9.00');
    expect(toMySubscription({}).billingWallet).toBeNull();
  });

  it('reads a subscription row whose plan is only an id', () => {
    expect(toSubscription({ _id: 's', planId: '65f0', planCode: 'premium' })).toMatchObject({ planCode: 'PREMIUM', plan: null });
    expect(toSubscription(null)).toBeNull();
  });

  it('turns a 402 into a recharge prompt, with the web’s fallbacks', () => {
    // subscriptionService.chargePlan sends the Bonus Wallet's currency — INR.
    const withDetails = apiError(402, 'INSUFFICIENT_SUBSCRIPTION_BALANCE', 'Low', { balance: '5', needed: '49', shortfall: '44', currency: 'INR' });
    expect(insufficientBalance(withDetails, { needed: '49' })).toEqual({ balance: '5', needed: '49', shortfall: '44', currency: 'INR' });
    const bare = apiError(402, 'INSUFFICIENT_SUBSCRIPTION_BALANCE');
    expect(insufficientBalance(bare, { needed: '49', balance: '5' })).toEqual({ balance: '5', needed: '49', shortfall: '0', currency: 'INR' });
    expect(insufficientBalance(apiError(400, 'OTHER'), { needed: '49' })).toBeNull();
  });
});
