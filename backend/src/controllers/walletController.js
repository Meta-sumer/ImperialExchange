const { Wallet, WalletLedger } = require('../models/Wallet');
const { Deposit, Withdrawal } = require('../models/index');
const TradingAccount = require('../models/TradingAccount');
const Position = require('../models/Position');
const Instrument = require('../models/Instrument');
const walletService = require('../services/walletService');
const currencyService = require('../services/currencyService');
const fxService = require('../services/fxService');
const { computeDepositFee } = require('../utils/depositFee');
const { computeWithdrawalFee } = require('../utils/withdrawalFee');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const { gt, sub, add, mul, div } = require('../utils/decimal');

// Single source of truth: every account holds ONE real wallet, denominated in
// this base currency. Other currencies (INR / EUR / GBP / USDT) are display-only
// conversions. Imported rather than redeclared so the money layer and everything
// that compares against it cannot drift apart.
const { BASE_CURRENCY } = require('../config/constants');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Largest accepted base64 payment screenshot. Generous next to the ~600KB a
// downscaled phone screenshot encodes to, far below the 16MB MongoDB document
// ceiling these are stored inside.
const SCREENSHOT_MAX_BYTES = 3 * 1024 * 1024;

// Resolve a payment-method config (fixed or custom) from the admin blob, and
// gate a submitted method on the admin's Shown/Hidden toggle. Shared with the
// subscription wallet so ONE list decides what a deposit may use.
const {
  getMethodConfig: _methodConfig, assertMethodAllowed, publicPaymentDetails, assertWithinLimits,
  withdrawalCurrencies,
} = require('../utils/paymentMethods');

// A method restricts currencies only when it has a NON-EMPTY supportedCurrencies
// list (backward compatible: empty/absent = all currencies allowed).
const _assertCurrencySupported = async (method, code) => {
  if (!method) return;
  const cfg = await _methodConfig(method);
  const list = Array.isArray(cfg?.supportedCurrencies) ? cfg.supportedCurrencies : [];
  if (list.length && !list.includes(String(code).toUpperCase())) {
    throw new AppError(`${code} is not supported by this payment method`, 400, 'CURRENCY_NOT_SUPPORTED');
  }
};

const getBalances = asyncHandler(async (req, res) => {
  const { accountId } = req.query;
  const balances = await walletService.getBalances(req.userId, accountId);
  // include 'free' = balance - locked
  const enriched = balances.map((w) => ({
    ...w,
    free: gt(w.balance, w.locked || '0') ? sub(w.balance, w.locked || '0') : '0',
  }));
  sendSuccess(res, enriched);
});

// Per-account FLOATING balance (equity = realized balance + Σ open-position
// unrealized P&L) for every account of the user. The header/account-switcher
// shows THIS live figure, while the terminal footer "Balance" and the
// transaction-history before/after stay the FIXED realized balance.
//
// Batched — one Wallet + one Position + one Instrument query regardless of
// account count — and uses the SAME mark (Instrument.lastPrice) + uPnL formula
// as GET /trading/positions so the header equity matches the terminal exactly.
const getAccountsEquity = asyncHandler(async (req, res) => {
  // Wallets, open positions and account statuses are three independent reads of
  // the same userId — they were awaited one after another, which cost three
  // sequential Atlas round trips where one suffices. Only the instrument lookup
  // genuinely depends on a previous result (it needs the position instrumentIds),
  // so it stays in a second wave. Four waves become two.
  //
  // The account-status read is for the live summary (ACTIVE / STOPPED_OUT /
  // BLOCKED …) so the header can show "Stopped Out" and the UI stops rendering
  // stale open positions the instant the risk engine liquidates.
  //
  // These are pure reads with no writes between them, so only the issue order
  // changes — every figure below is computed from the same data as before.
  const [wallets, positions, accounts] = await Promise.all([
    walletService.getBalances(req.userId),
    Position.find({ userId: req.userId, status: 'OPEN' })
      .select('accountId instrumentId side quantity entryPrice margin')
      .lean(),
    TradingAccount.find({ userId: req.userId }).select('_id status stoppedOutAt').lean(),
  ]);
  const statusByAcct = new Map(accounts.map((a) => [String(a._id), a]));

  const instrIds = [...new Set(positions.map((p) => String(p.instrumentId)))];
  const instruments = instrIds.length
    ? await Instrument.find({ _id: { $in: instrIds } }).select('_id lastPrice').lean()
    : [];
  const markById = new Map(instruments.map((i) => [String(i._id), i.lastPrice]));

  // Σ unrealized P&L + used margin per account.
  const byAcct = new Map();
  for (const p of positions) {
    const mark = markById.get(String(p.instrumentId)) || p.entryPrice;
    const pnl = p.side === 'BUY'
      ? mul(sub(mark, p.entryPrice), p.quantity)
      : mul(sub(p.entryPrice, mark), p.quantity);
    const cur = byAcct.get(String(p.accountId)) || { upnl: '0', margin: '0' };
    cur.upnl = add(cur.upnl, pnl);
    cur.margin = add(cur.margin, p.margin || '0');
    byAcct.set(String(p.accountId), cur);
  }

  const out = wallets.map((w) => {
    const agg = byAcct.get(String(w.accountId)) || { upnl: '0', margin: '0' };
    const free = gt(w.balance, w.locked || '0') ? sub(w.balance, w.locked || '0') : '0';
    const equity = add(w.balance, agg.upnl);              // ← floating balance
    // Margin Level % = Equity / Used Margin × 100 (null when no open margin).
    const marginLevel = gt(agg.margin, '0') ? mul(div(equity, agg.margin), '100') : null;
    const acct = statusByAcct.get(String(w.accountId));
    const status = acct?.status || 'ACTIVE';
    return {
      accountId:     String(w.accountId),
      currency:      w.currency,
      balance:       w.balance,        // fixed / realized (unchanged)
      unrealizedPnl: agg.upnl,
      equity,                          // floating = balance + Σ uPnL
      usedMargin:    agg.margin,
      free,                            // realized balance − locked
      freeMargin:    sub(equity, agg.margin), // equity − used margin
      marginLevel,                     // % (null when no open positions)
      status,                          // account status (STOPPED_OUT when liquidated)
      stoppedOut:    status === 'STOPPED_OUT',
    };
  });
  sendSuccess(res, out);
});

// Where to SEND money for a manual deposit (admin-configured per method).
// Shown to the client in the "Add funds" modal. Read-only.
const depositDetails = asyncHandler(async (req, res) => {
  const systemSettings = require('../services/systemSettings.service');
  const bankAssignment = require('../services/bankAssignment');
  // Switched-off rails keep their enabled:false flag (the clients filter on it)
  // but ship no payee details, so a hidden rail has nothing to pay into even if
  // some surface manages to render it. The admin panel reads the unredacted
  // blob from /admin/system/deposit-details.
  const details = publicPaymentDetails(await systemSettings.getSetting('deposit.paymentDetails'));

  // Per-user deposit bank account (Super Admin → Bank Accounts). A customer
  // with an assigned account sees THAT account on the BANK rail (and its UPI
  // handle, when the account has one) instead of the global details, so
  // deposits are spread across the pool. A customer without one is assigned
  // the least-loaded active account right here. Staff, a disabled BANK rail
  // and an empty pool fall through to the global details unchanged.
  if (req.user && !bankAssignment.isStaffRole(req.user.role)) {
    const bank = await bankAssignment.autoAssignIfMissing(req.user);
    if (bank) {
      const rail = details.BANK && typeof details.BANK === 'object' ? details.BANK : {};
      if (rail.enabled !== false) {
        details.BANK = {
          ...rail,
          accountName: bank.accountName,
          accountNumber: bank.accountNumber,
          ifsc: bank.ifsc,
          bankName: bank.bankName,
          note: bank.note || rail.note || '',
          qr: bank.qr || rail.qr || '',
        };
      }
      const upi = details.UPI && typeof details.UPI === 'object' ? details.UPI : null;
      if (bank.upiId && upi && upi.enabled !== false) {
        details.UPI = { ...upi, upiId: bank.upiId, payeeName: bank.accountName || upi.payeeName || '' };
      }
      details.assignedBank = { label: bank.label, bankName: bank.bankName };
    }
  }
  sendSuccess(res, details);
});

const getLedger = asyncHandler(async (req, res) => {
  const { limit = 100, accountId } = req.query;
  const filter = { userId: req.userId };
  if (accountId) filter.accountId = accountId;
  const entries = await WalletLedger.find(filter).sort({ createdAt: -1 }).limit(Number(limit)).lean();

  // Enrich peer-to-peer transfer rows with the counterparty's display
  // name so the wallet history can render "Transfer to/from <name>"
  // without an extra round-trip from the FE. We look at all
  // INTERNAL_TRANSFER_* rows for this user, find the matching pair-row
  // (same referenceId, other user) and inline its userId / name.
  const transferIds = entries
    .filter((e) => (e.type === 'INTERNAL_TRANSFER_OUT' || e.type === 'INTERNAL_TRANSFER_IN') && e.referenceId)
    .map((e) => e.referenceId);
  if (transferIds.length) {
    const pairs = await WalletLedger.find({
      referenceId: { $in: transferIds },
      userId: { $ne: req.userId },
      type: { $in: ['INTERNAL_TRANSFER_OUT', 'INTERNAL_TRANSFER_IN'] },
    }).select('userId referenceId').lean();
    const otherIdByRef = new Map(pairs.map((p) => [String(p.referenceId), String(p.userId)]));
    const userIds = [...new Set(pairs.map((p) => String(p.userId)))];
    const User = require('../models/User');
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } }).select('_id firstName lastName email referralCode avatarUrl').lean()
      : [];
    const userById = new Map(users.map((u) => [String(u._id), u]));
    for (const e of entries) {
      if (e.type !== 'INTERNAL_TRANSFER_OUT' && e.type !== 'INTERNAL_TRANSFER_IN') continue;
      const otherId = otherIdByRef.get(String(e.referenceId));
      if (!otherId) continue;
      const u = userById.get(otherId);
      if (!u) continue;
      const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;
      e.counterparty = {
        userId:       String(u._id),
        name,
        referralCode: u.referralCode || null,
        avatarUrl:    u.avatarUrl || null,
      };
    }
  }

  sendSuccess(res, entries);
});

const createDeposit = asyncHandler(async (req, res) => {
  const {
    accountId,
    currency,
    amount,
    method,
    txReference,
    note,
    screenshot,           // base64 data URL of payment proof
    screenshotMimeType,   // 'image/png' | 'image/jpeg'
    senderName,
    senderUpiId,
    senderBankAccount,
  } = req.body;

  // Reject non-positive / non-numeric amounts up front. Without this guard
  // a Number("abc") cast or a negative amount would slip past the AppError
  // chain and either zero-credit the wallet or, worse, decrement it.
  const amtNum = Number(amount);
  if (!Number.isFinite(amtNum) || amtNum <= 0) {
    throw new AppError('Amount must be a positive number', 400);
  }

  const account = await TradingAccount.findOne({ _id: accountId, userId: req.userId });
  if (!account) throw new AppError('Account not found', 404);

  // Practice-money accounts (DEMO / VIRTUAL) skip every real-money gate: no
  // KYC, no payment screenshot, no admin review — they auto-credit instantly.
  // EVERY other type is a live plan tier (STANDARD / PRO / FREE / +IC variants,
  // legacy REAL, CUSTOM) and is treated as real money. Previously these gates
  // only matched the legacy 'REAL' type, so plan-coded live accounts slipped
  // past KYC + screenshot entirely.
  const isDemoLike = account.accountType === 'DEMO' || account.accountType === 'VIRTUAL';
  const isRealMoney = !isDemoLike;

  // KYC gate — real-money deposits are blocked until KYC APPROVED.
  // Demo / virtual accounts are exempt (no real funds at risk).
  // Disable with KYC_REQUIRED=false in env for staging / sandbox.
  const kycRequired = (process.env.KYC_REQUIRED || 'true').toLowerCase() !== 'false';
  if (kycRequired && isRealMoney) {
    if (req.user?.kycStatus !== 'APPROVED') {
      throw new AppError(
        'KYC verification must be approved before depositing on a real-money account.',
        403,
        'KYC_REQUIRED'
      );
    }
  }

  // For real-money accounts, screenshot is MANDATORY (proof of payment)
  if (isRealMoney) {
    if (!screenshot) {
      throw new AppError('Payment screenshot is required for real account deposits', 400);
    }
    // Basic validation: must be data URL or HTTPS URL
    const isDataUrl = typeof screenshot === 'string' && screenshot.startsWith('data:image/');
    const isHttpsUrl = typeof screenshot === 'string' && screenshot.startsWith('https://');
    if (!isDataUrl && !isHttpsUrl) {
      throw new AppError('Invalid screenshot format. Upload an image file.', 400);
    }
    // The client accepts a 10 MB pick and downscales it before sending
    // (client/src/utils/imageCompress.js), so what actually arrives is a few
    // hundred KB. The cap here is the backstop for anything not going through
    // that path, and it stays modest on purpose: these blobs live INLINE on
    // the deposit document and the admin list returns 200 documents whole, so
    // the stored size is paid on every admin page load, not once per user.
    if (isDataUrl && screenshot.length > SCREENSHOT_MAX_BYTES) {
      throw new AppError(`Screenshot too large (max ${Math.round(SCREENSHOT_MAX_BYTES / 1024)}KB encoded).`, 413);
    }
    if (!txReference || String(txReference).trim().length < 4) {
      throw new AppError('Transaction reference (UPI ref / bank ref) is required', 400);
    }
  }

  // For practice accounts (DEMO / VIRTUAL), allow direct credit without
  // screenshot (instant top-up) — no admin review, no real funds at risk.
  if (isDemoLike) {
    // Cap per-request and per-day so a user can't self-fund unlimited demo
    // balances, which would skew the trader-profile / routing analytics
    // and waste DB rows.
    // Capped in USD, because `amtNum` is denominated in whatever currency the
    // request carried. These were bare numbers commented as rupees, so the same
    // literal meant ~$12k for an INR request and a full $1,000,000 for a USD
    // one — the cap quietly relaxed by the FX rate depending on who was asking.
    const DEMO_PER_REQUEST_CAP_USD = Number(process.env.DEMO_TOPUP_CAP_USD) || 12000;
    const DEMO_PER_DAY_CAP_USD = Number(process.env.DEMO_TOPUP_DAILY_CAP_USD) || 120000;
    const capCur = String(currency || BASE_CURRENCY).toUpperCase();
    const amtUsdFx = await fxService.toUsd(capCur, amtNum, 'deposit');
    const amtUsd = Number(amtUsdFx.usd);
    if (!Number.isFinite(amtUsd)) {
      throw new AppError('Could not price this amount for the demo cap check.', 400);
    }
    if (amtUsd > DEMO_PER_REQUEST_CAP_USD) {
      throw new AppError(`Demo top-ups are capped at ${DEMO_PER_REQUEST_CAP_USD} USD per request`, 400);
    }
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentTotal = await Deposit.aggregate([
      { $match: { userId: account.userId, accountId: account._id, method: 'DEMO', createdAt: { $gte: since } } },
      // baseAmount, not amount. Summing `amount` added rupees to dollars as if
      // they were the same unit, so a day of INR top-ups and a day of USD ones
      // produced a meaningless total — and the cap it was checked against was
      // whichever currency the last caller happened to use.
      { $group: { _id: null, total: { $sum: { $toDouble: { $ifNull: ['$baseAmount', '0'] } } } } },
    ]);
    const usedToday = recentTotal[0]?.total || 0;
    if (usedToday + amtUsd > DEMO_PER_DAY_CAP_USD) {
      throw new AppError(
        `Demo top-up would exceed the daily cap (${DEMO_PER_DAY_CAP_USD} USD). Used today: ${usedToday.toFixed(2)} USD.`,
        400
      );
    }

    // Auto-confirm demo deposits — no admin review needed. Store the
    // original currency/amount the user typed AND the USD-equivalent
    // base figures, then credit the base wallet only.
    // Reuses the conversion already done for the cap check above — same
    // currency, same amount, so a second FX call would only risk the two
    // disagreeing if the rate moved between them.
    const convDemo = { baseCurrency: BASE_CURRENCY, baseAmount: amtUsdFx.usd, rate: amtUsdFx.rate };
    const dep = await Deposit.create({
      userId: req.userId,
      accountId,
      currency: capCur,
      amount: String(amtNum), // user-facing original
      baseCurrency: convDemo.baseCurrency,
      baseAmount: String(convDemo.baseAmount),
      fxRateUsed: convDemo.rate,
      method: method || 'DEMO',
      txReference: 'DEMO-' + Date.now(),
      status: 'CONFIRMED',
      confirmedAt: new Date(),
      note: 'Demo balance top-up (auto-approved)',
    });
    const { credit } = require('../services/walletService');
    await credit({
      userId: req.userId,
      accountId,
      currency: BASE_CURRENCY,
      amount: String(convDemo.baseAmount),
      type: 'DEPOSIT',
      referenceType: 'Deposit',
      referenceId: dep._id,
      note: `Demo top-up · ${convDemo.originalAmount} ${convDemo.originalCurrency} @ ${convDemo.rate}`,
    });
    return sendSuccess(res, dep, 201);
  }

  // REAL deposits — pending admin review. Pre-compute the USD base
  // figure so the eventual admin confirm credits the base wallet.
  // Convert the deposit → USD using the DEPOSIT exchange rate (admin-configured,
  // AUTO or MANUAL). Validate the currency is supported by the chosen method.
  const depCur = String(currency || BASE_CURRENCY).toUpperCase();
  // The picker hides rails the admin switched off, but it only learns which
  // ones AFTER /wallet/deposit-details resolves — on a slow connection the
  // whole hard-coded list is clickable first. Re-check here so a hidden rail
  // cannot be submitted from that window (or by hand).
  await assertMethodAllowed(method);
  await _assertCurrencySupported(method, depCur);
  const depConv = await fxService.toUsd(depCur, amtNum, 'deposit');
  const convReal = { baseCurrency: BASE_CURRENCY, baseAmount: depConv.usd, rate: depConv.rate };

  // Admin's per-method min/max for this rail (USD). Checked against the
  // CONVERTED figure so the same limit applies whatever currency was typed.
  await assertWithinLimits(method, 'deposit', convReal.baseAmount, { currency: depCur, amount: amtNum });

  // ─── Minimum-deposit gate (per AccountPlan tier) ────────────────────
  // Each live tier defines a minimum deposit amount (USD base), enforced on
  // EVERY deposit — not just the first. Demo/virtual practice accounts are
  // exempt (handled above; they return before this point).
  {
    const accountFeeService = require('../services/accountFeeService');
    const minDep = await accountFeeService.getMinDeposit(account); // USD
    if (minDep > 0) {
      const baseAmt = Number(convReal.baseAmount);
      if (baseAmt < minDep) {
        throw new AppError(
          `Minimum deposit for the ${account.nickname || account.accountType} plan is ${minDep} USD — you entered ≈ ${baseAmt.toFixed(2)} USD.`,
          400,
          'BELOW_MIN_DEPOSIT'
        );
      }
    }
  }

  const dep = await Deposit.create({
    userId: req.userId,
    accountId,
    currency: currency || BASE_CURRENCY,
    amount: String(amount),
    baseCurrency: convReal.baseCurrency,
    baseAmount: String(convReal.baseAmount),
    fxRateUsed: convReal.rate,
    method: method || 'UPI',
    txReference,
    note,
    screenshot,
    screenshotMimeType,
    senderName,
    senderUpiId,
    senderBankAccount,
    status: 'PENDING',
  });
  // Echo to the user's open sessions so the notification bell + wallet
  // history table show the new pending deposit row instantly.
  try {
    const broadcaster = require('../websocket/server');
    broadcaster.notifyUser(String(req.userId), 'wallet', {
      action: 'pending',
      reason: 'DEPOSIT_CREATED',
      depositId: String(dep._id),
      amount: dep.amount,
      currency: dep.currency,
    });
  } catch (_) {}
  sendSuccess(res, dep, 201);
});

const listDeposits = asyncHandler(async (req, res) => {
  const deposits = await Deposit.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(100).lean();
  sendSuccess(res, deposits);
});

const requestWithdrawal = asyncHandler(async (req, res) => {
  const {
    accountId,
    currency,
    amount,
    method, // only used by the demo path below; real payouts derive it from the saved method
    // Real withdrawals may ONLY target a saved, VERIFIED method — the raw
    // bank/UPI/wallet fields are intentionally NOT read from the body anymore.
    withdrawalMethodId,
  } = req.body;

  // Reject non-positive / non-numeric amounts before any side effects.
  const amtNum = Number(amount);
  if (!Number.isFinite(amtNum) || amtNum <= 0) {
    throw new AppError('Amount must be a positive number', 400);
  }

  const account = await TradingAccount.findOne({ _id: accountId, userId: req.userId });
  if (!account) throw new AppError('Account not found', 404);

  // ── Demo / virtual accounts: instant self-service withdrawal ─────────
  // Practice money — no real payout, so no admin review, KYC, whitelist or
  // AML. Just validate the balance, debit immediately, and record a
  // COMPLETED row so the user's history stays consistent.
  const isDemoLike = account.accountType === 'DEMO' || account.accountType === 'VIRTUAL';
  if (isDemoLike) {
    const displayCur = String(currency || BASE_CURRENCY).toUpperCase();
    const convFx = await fxService.toUsd(displayCur, amtNum, 'withdrawal');
    const conv = { baseAmount: convFx.usd, rate: convFx.rate };
    const baseAmountStr = String(conv.baseAmount);

    const wallet = await Wallet.findOne({ userId: req.userId, accountId, currency: BASE_CURRENCY });
    if (!wallet) throw new AppError('No funds on this account.', 400, 'INSUFFICIENT_FUNDS');
    const freeBase = gt(wallet.balance, wallet.locked || '0') ? sub(wallet.balance, wallet.locked || '0') : '0';
    if (gt(baseAmountStr, freeBase)) {
      const freeDisplay = await currencyService.fromBase(displayCur, Number(freeBase));
      throw new AppError(
        `Insufficient balance. Available: ${freeDisplay.toFixed(2)} ${displayCur} (requested ${amtNum} ${displayCur}).`,
        400,
        'INSUFFICIENT_FUNDS'
      );
    }

    const { WALLET_TX_TYPE } = require('../config/constants');
    // Debit first (the money-moving op). If the history record then fails to
    // write, refund so demo balance can't silently vanish.
    await walletService.debit({
      userId: req.userId,
      accountId,
      currency: BASE_CURRENCY,
      amount: baseAmountStr,
      type: WALLET_TX_TYPE.WITHDRAWAL,
      referenceType: 'withdrawal',
      note: `Demo withdrawal (auto-approved) · ${amtNum} ${displayCur}`,
    });

    let wd;
    try {
      wd = await Withdrawal.create({
        userId: req.userId,
        accountId,
        currency: displayCur,
        amount: String(amtNum),
        baseCurrency: BASE_CURRENCY,
        baseAmount: baseAmountStr,
        fxRateUsed: conv.rate,
        method: (method || 'DEMO').toUpperCase(),
        destination: 'Demo balance withdrawal (auto-approved)',
        status: 'COMPLETED',
        approvedAt: new Date(),
        payoutAt: new Date(),
      });
    } catch (createErr) {
      try {
        await walletService.credit({
          userId: req.userId,
          accountId,
          currency: BASE_CURRENCY,
          amount: baseAmountStr,
          type: WALLET_TX_TYPE.ADJUSTMENT,
          referenceType: 'withdrawal',
          note: 'Refund — demo withdrawal record failed',
        });
      } catch (e) {
        console.error('[wallet] failed to refund after demo withdrawal create error:', e.message);
      }
      throw createErr;
    }

    try {
      const broadcaster = require('../websocket/server');
      broadcaster.notifyUser(String(req.userId), 'wallet', {
        action: 'debited',
        reason: 'WITHDRAWAL_COMPLETED',
        withdrawalId: String(wd._id),
        amount: wd.amount,
        currency: wd.currency,
      });
    } catch (_) {}

    return sendSuccess(res, wd, 201);
  }

  // KYC gate — every real withdrawal needs KYC APPROVED (AML requirement).
  // Disable for sandbox via KYC_REQUIRED=false.
  const kycRequired = (process.env.KYC_REQUIRED || 'true').toLowerCase() !== 'false';
  if (kycRequired && req.user?.kycStatus !== 'APPROVED') {
    throw new AppError(
      'KYC verification must be approved before withdrawing funds.',
      403,
      'KYC_REQUIRED'
    );
  }

  // ── Verified withdrawal method (MANDATORY) — the core business rule ──────
  // A real payout may ONLY go to a destination the user previously SAVED and an
  // admin VERIFIED. The destination is resolved server-side from that record;
  // the request never carries a raw bank/UPI/wallet. This is the single choke
  // point that makes arbitrary destinations impossible (frontend cannot bypass).
  if (!withdrawalMethodId) {
    throw new AppError('Select a saved, verified withdrawal method.', 400, 'WITHDRAWAL_METHOD_REQUIRED');
  }
  const WithdrawalMethod = require('../models/WithdrawalMethod');
  // The userId filter is the IDOR guard — another user's methodId simply won't match.
  const wm = await WithdrawalMethod.findOne({ _id: withdrawalMethodId, userId: req.userId });
  if (!wm || wm.archived) throw new AppError('Withdrawal method not found.', 404, 'WITHDRAWAL_METHOD_NOT_FOUND');
  if (wm.status === 'BLOCKED') throw new AppError('This withdrawal method is blocked. Contact support.', 403, 'WITHDRAWAL_METHOD_BLOCKED');
  if (wm.status === 'REJECTED') throw new AppError('This withdrawal method was rejected. Add and verify a new one.', 403, 'WITHDRAWAL_METHOD_REJECTED');
  if (wm.status !== 'VERIFIED' || !wm.isVerified) throw new AppError('This withdrawal method is not verified yet.', 403, 'WITHDRAWAL_METHOD_NOT_VERIFIED');

  // Destination is taken ONLY from the saved method — never the request body.
  const m = wm.type; // BANK | UPI | CRYPTO
  const upiId = wm.upiId;
  const bankAccountNumber = wm.accountNumber;
  const bankIFSC = wm.ifsc;
  const bankAccountHolderName = wm.accountHolderName;
  const bankName = wm.bankName;
  const cryptoAddress = wm.walletAddress;
  const cryptoNetwork = wm.network;

  // Defense-in-depth: if the client ALSO sent destination details that don't
  // match the saved method, treat it as a tamper attempt and reject.
  const _b = req.body || {};
  if (
    (_b.upiId && _b.upiId !== upiId) ||
    (_b.bankAccountNumber && String(_b.bankAccountNumber) !== String(bankAccountNumber)) ||
    (_b.cryptoAddress && _b.cryptoAddress !== cryptoAddress) ||
    (_b.method && String(_b.method).toUpperCase() !== m)
  ) {
    throw new AppError('Withdrawal destination cannot be entered manually. Use your saved verified method.', 400, 'ARBITRARY_DESTINATION');
  }

  // Method ↔ currency compatibility. UPI / BANK are domestic rails, so they
  // settle in INR — but only until the admin lists currencies on the rail.
  // This used to be a hard rule their settings could not reach, so a rail
  // they had opened to USD was refused anyway, with nothing saying why.
  const cur = (currency || BASE_CURRENCY).toUpperCase();
  const _allowedCcys = withdrawalCurrencies(await _methodConfig(m), m);
  if (_allowedCcys && !_allowedCcys.includes(cur)) {
    throw new AppError(`${m} withdrawals are only available in ${_allowedCcys.join(', ')}.`, 400, 'CURRENCY_NOT_SUPPORTED');
  }

  // AML transaction screening
  const { Withdrawal: WdModel, Deposit: DepModel } = require('../models/index');
  const [recentWds, recentDeps] = await Promise.all([
    WdModel.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(20).lean(),
    DepModel.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(20).lean(),
  ]);
  const recentTxs = [
    ...recentWds.map((w) => ({ ...w, type: 'WITHDRAWAL' })),
    ...recentDeps.map((d) => ({ ...d, type: 'DEPOSIT' })),
  ];
  const aml = require('../services/amlService').screenTransaction({
    userId: req.userId,
    amount: String(amount),
    currency,
    type: 'WITHDRAWAL',
    recentTransactions: recentTxs,
  });

  // Convert the user-requested amount into the canonical base
  // currency (USD) using the live FX rate. The single real wallet is
  // USD-denominated; non-USD inputs are display-only.
  const displayCur = String(currency || BASE_CURRENCY).toUpperCase();
  await _assertCurrencySupported(m, displayCur);
  // Convert using the WITHDRAWAL exchange rate (admin-configured, AUTO/MANUAL).
  const wdConv = await fxService.toUsd(displayCur, amount, 'withdrawal');
  const conv = { baseAmount: wdConv.usd, rate: wdConv.rate };
  const baseAmountStr = String(conv.baseAmount);
  // Admin's per-method min/max for this rail (USD). There was NO server-side
  // withdrawal limit at all before this — the only minimum in the product was a
  // hard-coded number in the withdrawal form, which an admin could not change
  // and which anyone bypassing the form ignored entirely.
  // The rail must be open for PAYOUTS. This never checked at all, so a
  // rail switched off still paid out from a trading account.
  await assertMethodAllowed(m, 'withdrawal');
  await assertWithinLimits(m, 'withdrawal', conv.baseAmount, { currency: displayCur, amount: Number(amount) });
  // Withdrawal fee (USD). The account is debited the GROSS baseAmount; the fee
  // is retained by the platform, so the user RECEIVES (baseAmount − fee).
  const wdFeeUsd = await computeWithdrawalFee(m, baseAmountStr);
  // …and the same fee in the currency the ADMIN pays out in, plus the net they
  // should actually send. Scaled off this request's own amounts rather than
  // re-reading the rate, so the two figures can never disagree.
  const _grossDisp = Number(amount) || 0;
  const _baseNum = Number(baseAmountStr) || 0;
  const _dispPerUsd = _baseNum > 0 ? _grossDisp / _baseNum : 1;
  const wdFeeDisplay = round2(Number(wdFeeUsd) * _dispPerUsd);
  const wdNetDisplay = round2(Math.max(0, _grossDisp - wdFeeDisplay));

  // Check the canonical USD wallet's free balance.
  const wallet = await Wallet.findOne({ userId: req.userId, accountId, currency: BASE_CURRENCY });
  if (!wallet) {
    throw new AppError('No funds on this account. Make a deposit first.', 400, 'INSUFFICIENT_FUNDS');
  }
  const freeBase = gt(wallet.balance, wallet.locked || '0') ? sub(wallet.balance, wallet.locked || '0') : '0';
  if (gt(baseAmountStr, freeBase)) {
    // Convert the available base figure back into the user's display
    // currency for a friendlier error.
    const freeDisplay = await currencyService.fromBase(displayCur, Number(freeBase));
    throw new AppError(
      `Insufficient balance. Available: ${freeDisplay.toFixed(2)} ${displayCur} (requested ${amount} ${displayCur}).`,
      400,
      'INSUFFICIENT_FUNDS'
    );
  }

  // Build destination summary string for backwards-compat display
  let destSummary = '';
  if (m === 'UPI') destSummary = upiId;
  else if (m === 'BANK') destSummary = `${bankAccountHolderName} - ${bankAccountNumber} (${bankIFSC})`;
  else if (m === 'CRYPTO') destSummary = `${cryptoAddress} (${cryptoNetwork})`;

  // Lock the canonical USD funds FIRST so a free-balance race can't
  // approve while the funds aren't reserved.
  await walletService.lock({
    userId: req.userId,
    accountId,
    currency: BASE_CURRENCY,
    amount: baseAmountStr,
  });

  let wd;
  try {
    wd = await Withdrawal.create({
      userId: req.userId,
      accountId,
      // User-facing original — what the admin pays out and what the
      // user sees in their history.
      currency: displayCur,
      amount: String(amount),
      // Canonical base — what's actually locked / debited on the
      // single USD wallet.
      baseCurrency: BASE_CURRENCY,
      baseAmount: baseAmountStr,
      fxRateUsed: conv.rate,
      fee: wdFeeUsd,                    // USD (base)
      feeAmount: String(wdFeeDisplay),  // same fee, currency the admin sends
      netAmount: String(wdNetDisplay),  // what the admin actually pays out
      method: m,
      destination: destSummary,
      upiId: m === 'UPI' ? upiId : undefined,
      bankAccountNumber: m === 'BANK' ? bankAccountNumber : undefined,
      bankIFSC: m === 'BANK' ? bankIFSC : undefined,
      bankAccountHolderName: m === 'BANK' ? bankAccountHolderName : undefined,
      bankName: m === 'BANK' ? bankName : undefined,
      cryptoAddress: m === 'CRYPTO' ? cryptoAddress : undefined,
      cryptoNetwork: m === 'CRYPTO' ? cryptoNetwork : undefined,
      // Verified-method link + frozen destination snapshot (§7). Even if the
      // user later edits/deletes the method, this payout's destination is fixed.
      withdrawalMethodId: wm._id,
      methodType: m,
      destinationSnapshot: wm.destinationSnapshot(),
      status: 'PENDING',
    });
  } catch (createErr) {
    // Rollback the lock so funds aren't stuck.
    try {
      await walletService.unlock({
        userId: req.userId,
        accountId,
        currency: BASE_CURRENCY,
        amount: baseAmountStr,
      });
    } catch (e) {
      console.error('[wallet] failed to unlock after withdrawal create error:', e.message);
    }
    throw createErr;
  }

  // Email confirmation to user
  try {
    const email = require('../services/emailService');
    await email.sendWithdrawalAlert({
      to: req.user.email,
      amount: String(amount),
      currency: currency || BASE_CURRENCY,
      status: 'REQUESTED',
      destination: destSummary,
    });
  } catch (e) { /* non-fatal */ }

  // Live update to the user's open sessions so the wallet hero +
  // history table show the pending withdrawal + locked funds without
  // a refresh.
  try {
    const broadcaster = require('../websocket/server');
    broadcaster.notifyUser(String(req.userId), 'wallet', {
      action: 'pending',
      reason: 'WITHDRAWAL_REQUESTED',
      withdrawalId: String(wd._id),
      amount: wd.amount,
      currency: wd.currency,
    });
  } catch (_) {}

  // Stamp the method as last-used (admin visibility) + audit the withdrawal
  // creation. Never log the raw destination — only the method reference.
  try { wm.lastUsedAt = new Date(); await wm.save(); } catch (_) { /* best-effort */ }
  try {
    const { AuditLog } = require('../models/index');
    await AuditLog.create({
      actorId: req.userId, actorRole: req.user?.role, action: 'WITHDRAWAL_CREATED',
      targetType: 'WITHDRAWAL', targetId: String(wd._id),
      metadata: { amount: String(amount), currency: displayCur, methodType: m, withdrawalMethodId: String(wm._id) },
      ip: req.ip, userAgent: req.headers?.['user-agent'],
    });
  } catch (_) { /* audit best-effort */ }

  sendSuccess(res, { ...wd.toObject(), aml: aml.requiresReview ? { flagged: true, score: aml.score, flags: aml.flags } : undefined }, 201);
});

const listWithdrawals = asyncHandler(async (req, res) => {
  const withdrawals = await Withdrawal.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(100).lean();
  sendSuccess(res, withdrawals);
});

/**
 * Internal transfer between two of the same user's trading accounts.
 * E.g. moving funds from a Real account to a Demo account (top-up).
 * Both accounts must belong to req.userId.
 */
const internalTransfer = asyncHandler(async (req, res) => {
  const { fromAccountId, toAccountId, currency, amount, note } = req.body;
  if (!fromAccountId || !toAccountId || !currency || !amount) {
    throw new AppError('fromAccountId, toAccountId, currency, amount required', 400);
  }
  if (String(fromAccountId) === String(toAccountId)) {
    throw new AppError('Cannot transfer to the same account', 400);
  }

  // Subscription ("Main") wallet and Bonus wallet are identified by the
  // literal sentinels 'subscription' / 'bonus' on either side. Both live
  // at the user level (no accountId) — the routing below dispatches
  // debit/credit to the matching service.
  const isSubFrom = String(fromAccountId) === 'subscription';
  const isSubTo   = String(toAccountId)   === 'subscription';
  const isBonusFrom = String(fromAccountId) === 'bonus';
  const isBonusTo   = String(toAccountId)   === 'bonus';
  const isSpecialFrom = isSubFrom || isBonusFrom;
  const isSpecialTo   = isSubTo   || isBonusTo;

  // The Bonus / Referral wallet is WITHDRAW-ONLY. It represents earnings the
  // platform paid out — referral and partner commission — so a balance in it is
  // a record of what was earned. Letting a user move their own funds in mixes
  // deposited money into that record, and every report built on it (partner
  // commission, bonus-abuse auditing) then counts money that was never earned.
  //
  // Transfers OUT stay allowed; that is the whole point of the wallet.
  if (isBonusTo) {
    throw new AppError(
      'The Bonus Wallet cannot receive transfers — it is funded by referral and partner earnings only. You can withdraw from it or transfer out of it.',
      400,
      'BONUS_WALLET_WITHDRAW_ONLY'
    );
  }

  const TradingAccount = require('../models/TradingAccount');
  const [from, to] = await Promise.all([
    isSpecialFrom ? Promise.resolve(null) : TradingAccount.findOne({ _id: fromAccountId, userId: req.userId }),
    isSpecialTo   ? Promise.resolve(null) : TradingAccount.findOne({ _id: toAccountId,   userId: req.userId }),
  ]);
  if (!isSpecialFrom && !from) throw new AppError('Source account not found or not yours', 404);
  if (!isSpecialTo   && !to)   throw new AppError('Destination account not found or not yours', 404);

  // Validate amount up front so a bad input doesn't reach walletService.
  const amtNum = Number(amount);
  if (!Number.isFinite(amtNum) || amtNum <= 0) {
    throw new AppError('Amount must be a positive number', 400);
  }
  const amtStr = String(amtNum);

  const subscriptionWalletService = require('../services/subscriptionWalletService');
  const bonusWalletService = require('../services/bonusWalletService');

  const destLabel = isBonusTo ? 'Bonus Wallet' : isSubTo ? 'Main Wallet' : (to && to.accountNumber);
  const srcLabel  = isBonusFrom ? 'Bonus Wallet' : isSubFrom ? 'Main Wallet' : (from && from.accountNumber);

  // ── Min-deposit gate on the destination (real trading accounts only) ──
  // Internal transfer into a trading account must clear the SAME minimum-deposit
  // limit as a normal deposit: the transfer amount (converted to USD) must be
  // ≥ the account's plan minimum. Otherwise internal transfer would be a way to
  // bypass the deposit gate. Demo / virtual accounts and the Main / Bonus wallets
  // have no minimum. Checked BEFORE any debit so a rejected transfer moves nothing.
  if (!isSpecialTo && to && !['DEMO', 'VIRTUAL'].includes(to.accountType)) {
    const accountFeeService = require('../services/accountFeeService');
    const minDep = await accountFeeService.getMinDeposit(to); // USD
    if (minDep > 0) {
      const baseAmt = Number((await currencyService.toBase(currency, amtNum)).baseAmount);
      if (baseAmt < minDep) {
        throw new AppError(
          `Minimum deposit for the ${to.nickname || to.accountType} plan is ${minDep} USD — you entered ≈ ${baseAmt.toFixed(2)} USD.`,
          400,
          'BELOW_MIN_DEPOSIT'
        );
      }
    }
  }

  // ── Debit source ──
  if (isBonusFrom) {
    try {
      await bonusWalletService.debit({
        userId: req.userId,
        amount: amtStr,
        reason: 'TRANSFER_OUT',
        note: note || `Transfer to ${destLabel || 'wallet'}`,
      });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_BONUS_BALANCE') throw new AppError(err.message, 402, err.code);
      throw err;
    }
  } else if (isSubFrom) {
    try {
      await subscriptionWalletService.debit({
        userId: req.userId,
        amount: amtStr,
        reason: 'ADMIN_DEBIT',
        note: note || `Transfer to ${destLabel || 'wallet'}`,
      });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_SUBSCRIPTION_BALANCE') {
        throw new AppError(err.message, 402, err.code);
      }
      throw err;
    }
  } else {
    await walletService.debit({
      userId: req.userId,
      accountId: fromAccountId,
      currency,
      amount: amtStr,
      type: 'TRANSFER',
      referenceType: 'transfer',
      note: note || `Transfer to ${destLabel || 'wallet'}`,
    });
  }

  // ── Credit destination, with a compensating rollback if it fails ──
  try {
    if (isBonusTo) {
      await bonusWalletService.credit({
        userId: req.userId,
        amount: amtStr,
        reason: 'TRANSFER_IN',
        note: note || `Transfer from ${srcLabel || 'wallet'}`,
      });
    } else if (isSubTo) {
      await subscriptionWalletService.credit({
        userId: req.userId,
        amount: amtStr,
        reason: 'DEPOSIT',
        paymentMethod: 'internal_transfer',
        note: note || `Transfer from ${srcLabel || 'wallet'}`,
      });
    } else {
      await walletService.credit({
        userId: req.userId,
        accountId: toAccountId,
        currency,
        amount: amtStr,
        type: 'TRANSFER',
        referenceType: 'transfer',
        note: note || `Transfer from ${srcLabel || 'wallet'}`,
      });
    }
  } catch (creditErr) {
    // Compensating credit on source — best-effort. Logs loudly if both
    // legs fail so an on-call can reconcile from the ledger.
    try {
      if (isBonusFrom) {
        await bonusWalletService.credit({
          userId: req.userId,
          amount: amtStr,
          reason: 'TRANSFER_IN',
          note: 'Rollback: failed transfer credit on destination',
        });
      } else if (isSubFrom) {
        await subscriptionWalletService.credit({
          userId: req.userId,
          amount: amtStr,
          reason: 'REFUND',
          paymentMethod: 'internal_transfer',
          note: 'Rollback: failed transfer credit on destination',
        });
      } else {
        await walletService.credit({
          userId: req.userId,
          accountId: fromAccountId,
          currency,
          amount: amtStr,
          type: 'TRANSFER',
          referenceType: 'transfer',
          note: 'Rollback: failed transfer credit on destination',
        });
      }
    } catch (rbErr) {
      console.error(
        `[wallet] CRITICAL: failed to roll back transfer ` +
        `from=${fromAccountId} to=${toAccountId} amount=${amtStr}: ` +
        `creditErr=${creditErr.message} rollbackErr=${rbErr.message}`
      );
    }
    throw creditErr;
  }

  sendSuccess(res, { ok: true, from: fromAccountId, to: toAccountId, amount: amtStr, currency });
});

/**
 * Razorpay deposit flow (alongside the existing screenshot upload method).
 *
 *   1. Client POSTs /wallet/razorpay/order with { accountId, amount, currency }
 *      → server creates a Razorpay order, returns { orderId, keyId, amount }.
 *   2. Client opens Razorpay Checkout SDK with that orderId.
 *   3. After payment, Razorpay redirects with { paymentId, signature }.
 *   4. Client POSTs /wallet/razorpay/verify with those three values.
 *      → server verifies HMAC signature, marks Deposit COMPLETED, credits wallet.
 *
 * The existing manual screenshot flow at POST /wallet/deposit is untouched —
 * users can still do bank/UPI transfers + admin approval if they prefer.
 *
 * Webhook endpoint at POST /wallet/razorpay/webhook also accepts events
 * directly from Razorpay (in case the client never returns to /verify).
 * Both verify and webhook are idempotent via paymentId dedupe.
 */
const paymentService = require('../services/paymentService');
const { WALLET_TX_TYPE } = require('../config/constants');

const createRazorpayOrder = asyncHandler(async (req, res) => {
  const { accountId, currency = BASE_CURRENCY, amount } = req.body;
  const amtNum = Number(amount);
  if (!Number.isFinite(amtNum) || amtNum <= 0) {
    throw new AppError('Amount must be a positive number', 400);
  }
  const account = await TradingAccount.findOne({ _id: accountId, userId: req.userId });
  if (!account) throw new AppError('Account not found', 404);
  const isDemoLike = account.accountType === 'DEMO' || account.accountType === 'VIRTUAL';
  if (isDemoLike) {
    throw new AppError('Razorpay deposits are only for real-money accounts', 400);
  }
  // Admin kill-switch for the automatic gateway (deposit.paymentDetails.RAZORPAY.enabled).
  {
    const systemSettings = require('../services/systemSettings.service');
    const payDetails = (await systemSettings.getSetting('deposit.paymentDetails')) || {};
    if (payDetails.RAZORPAY && payDetails.RAZORPAY.enabled === false) {
      throw new AppError('Razorpay payments are currently disabled.', 400, 'RAZORPAY_DISABLED');
    }
  }
  // KYC gate — same as the manual flow.
  const kycRequired = (process.env.KYC_REQUIRED || 'true').toLowerCase() !== 'false';
  if (kycRequired && req.user?.kycStatus !== 'APPROVED') {
    throw new AppError('KYC must be approved before depositing.', 403, 'KYC_REQUIRED');
  }

  // Minimum-deposit gate (per AccountPlan tier) — enforced on EVERY deposit,
  // mirroring the manual flow.
  {
    const accountFeeService = require('../services/accountFeeService');
    const minDep = await accountFeeService.getMinDeposit(account); // USD
    if (minDep > 0) {
      const conv = await currencyService.toBase(currency || BASE_CURRENCY, amtNum);
      const baseAmt = Number(conv.baseAmount);
      if (baseAmt < minDep) {
        throw new AppError(
          `Minimum deposit for the ${account.nickname || account.accountType} plan is ${minDep} USD — you entered ≈ ${baseAmt.toFixed(2)} USD.`,
          400,
          'BELOW_MIN_DEPOSIT'
        );
      }
    }
  }

  // Create the Razorpay order. If RAZORPAY env vars aren't set, the
  // service silently falls back to mock mode (auto-confirms) so dev works.
  const order = await paymentService.createOrder({
    amount: amtNum,
    currency,
    metadata: {
      userId: String(req.userId),
      accountId: String(account._id),
    },
  });

  // Persist a PENDING Deposit row keyed by the Razorpay order id so the
  // verify/webhook can find it idempotently.
  const dep = await Deposit.create({
    userId: req.userId,
    accountId: account._id,
    currency,
    amount: String(amtNum),
    method: 'RAZORPAY',
    txReference: order.orderId,
    status: 'PENDING',
  });

  sendSuccess(res, {
    depositId: dep._id,
    orderId: order.orderId,
    amount: amtNum,
    currency,
    keyId: order.providerData?.keyId || process.env.RAZORPAY_KEY_ID,
  });
});

const verifyRazorpayPayment = asyncHandler(async (req, res) => {
  const { orderId, paymentId, signature } = req.body;
  if (!orderId || !paymentId || !signature) {
    throw new AppError('orderId, paymentId, signature all required', 400);
  }
  const dep = await Deposit.findOne({ txReference: orderId, userId: req.userId });
  if (!dep) throw new AppError('Deposit not found', 404);
  if (dep.status === 'COMPLETED' || dep.status === 'CONFIRMED') {
    // Idempotent — already credited. Just acknowledge.
    return sendSuccess(res, { depositId: dep._id, status: dep.status, alreadyCredited: true });
  }

  const verified = await paymentService.verifyPayment({ orderId, paymentId, signature });
  if (!verified.ok) {
    dep.status = 'REJECTED';
    dep.rejectionReason = verified.reason;
    await dep.save();
    throw new AppError(`Payment verification failed: ${verified.reason}`, 400, 'PAYMENT_VERIFY_FAILED');
  }

  // Admin-configured deposit fee for this method → credit (amount − fee).
  const fee = await require('../utils/depositFee').computeDepositFee(dep.method, dep.amount);
  const creditAmt = gt(fee, '0') ? sub(dep.amount, fee) : dep.amount;
  // Credit the wallet. Use the Razorpay paymentId as a dedupeKey on the
  // wallet ledger so a replay (verify hits + webhook hits) only credits once.
  if (gt(creditAmt, '0')) {
    await walletService.credit({
      userId: dep.userId,
      accountId: dep.accountId,
      currency: dep.currency,
      amount: creditAmt,
      type: WALLET_TX_TYPE.DEPOSIT,
      referenceType: 'deposit',
      referenceId: dep._id,
      dedupeKey: `RAZORPAY:${paymentId}`,
      note: `Razorpay deposit ${paymentId}${gt(fee, '0') ? ` (fee ${fee} ${dep.currency})` : ''}`,
    });
  }
  dep.fee = fee;
  dep.status = 'COMPLETED';
  dep.completedAt = new Date();
  dep.providerPaymentId = paymentId;
  await dep.save();

  // Partner program: try the first-deposit bonus hook. Best-effort.
  try {
    const partnerService = require('../services/partnerService');
    await partnerService.handleFirstQualifyingDeposit({ userId: dep.userId, deposit: dep });
  } catch (e) {
    console.warn('[razorpay verify] partner hook failed:', e.message);
  }

  sendSuccess(res, { depositId: dep._id, status: 'COMPLETED' });
});

// Webhook fired directly by Razorpay (configure URL in Razorpay dashboard).
// Body comes as raw bytes for signature verification; need express.raw()
// middleware on this route specifically. For simplicity, we require the
// `x-razorpay-signature` header matched against the JSON body.
const razorpayWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(503).json({ ok: false, reason: 'webhook not configured' });
  }
  const rawBody = JSON.stringify(req.body);
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (expected !== signature) {
    return res.status(401).json({ ok: false, reason: 'invalid signature' });
  }

  const event = req.body.event;
  const payment = req.body.payload?.payment?.entity;
  if (event === 'payment.captured' && payment) {
    const dep = await Deposit.findOne({ txReference: payment.order_id });
    if (dep && dep.status !== 'COMPLETED' && dep.status !== 'CONFIRMED') {
      const fee = await require('../utils/depositFee').computeDepositFee(dep.method, dep.amount);
      const creditAmt = gt(fee, '0') ? sub(dep.amount, fee) : dep.amount;
      if (gt(creditAmt, '0')) {
        await walletService.credit({
          userId: dep.userId,
          accountId: dep.accountId,
          currency: dep.currency,
          amount: creditAmt,
          type: WALLET_TX_TYPE.DEPOSIT,
          referenceType: 'deposit',
          referenceId: dep._id,
          dedupeKey: `RAZORPAY:${payment.id}`,
          note: `Razorpay webhook ${payment.id}${gt(fee, '0') ? ` (fee ${fee} ${dep.currency})` : ''}`,
        });
      }
      dep.fee = fee;
      dep.status = 'COMPLETED';
      dep.completedAt = new Date();
      dep.providerPaymentId = payment.id;
      await dep.save();
      // Partner program: best-effort first-deposit bonus.
      try {
        const partnerService = require('../services/partnerService');
        await partnerService.handleFirstQualifyingDeposit({ userId: dep.userId, deposit: dep });
      } catch (e) {
        console.warn('[razorpay webhook] partner hook failed:', e.message);
      }
    }
  }
  res.json({ ok: true });
});

/**
 * In-account currency conversion. Debits the source wallet and credits
 * the destination wallet (same account) with the converted amount.
 *
 * The fxRate is supplied by the client (which uses the live `useFxRate`
 * hook) so the user sees the same rate the rest of the UI is showing.
 * The server still validates the rate looks sane (within ±20 % of the
 * configured FX_DEFAULT_RATE) to prevent obvious tampering.
 */
const convertCurrency = asyncHandler(async (req, res) => {
  const { accountId, fromCurrency, toCurrency, amount, fxRate: clientFxRate } = req.body;

  if (!accountId || !fromCurrency || !toCurrency) {
    throw new AppError('accountId, fromCurrency, toCurrency required', 400);
  }
  if (String(fromCurrency).toUpperCase() === String(toCurrency).toUpperCase()) {
    throw new AppError('Source and target currency must be different', 400);
  }
  const amtNum = Number(amount);
  if (!Number.isFinite(amtNum) || amtNum <= 0) {
    throw new AppError('Amount must be a positive number', 400);
  }
  const from = String(fromCurrency).toUpperCase();
  const to = String(toCurrency).toUpperCase();

  const account = await TradingAccount.findOne({ _id: accountId, userId: req.userId });
  if (!account) throw new AppError('Account not found', 404);

  // Resolve the FX rate. Sanity-bound the client's value (±20 %) so a
  // tampered request can't get a 1000x conversion. Falls back to the
  // configured default if the client didn't send a rate.
  const DEFAULT_RATE = Number(process.env.FX_DEFAULT_RATE || 83);
  let rate = Number(clientFxRate);
  if (!Number.isFinite(rate) || rate <= 0) rate = DEFAULT_RATE;
  const minRate = DEFAULT_RATE * 0.8;
  const maxRate = DEFAULT_RATE * 1.2;
  if (rate < minRate || rate > maxRate) rate = DEFAULT_RATE;

  // Compute the target amount. Only USD↔INR pairs are auto-converted;
  // anything else returns the same magnitude (no FX risk taken).
  let targetAmount;
  if (from === 'USD' && to === 'INR') targetAmount = amtNum * rate;
  else if (from === 'INR' && to === 'USD') targetAmount = amtNum / rate;
  else targetAmount = amtNum;

  // Debit source first; if credit fails, compensate to keep the user whole.
  await walletService.debit({
    userId: req.userId,
    accountId,
    currency: from,
    amount: String(amtNum),
    type: WALLET_TX_TYPE.ADJUSTMENT,
    referenceType: 'conversion',
    note: `Convert ${amtNum} ${from} → ${to} @ ${rate}`,
  });
  try {
    await walletService.credit({
      userId: req.userId,
      accountId,
      currency: to,
      amount: String(targetAmount.toFixed(2)),
      type: WALLET_TX_TYPE.ADJUSTMENT,
      referenceType: 'conversion',
      note: `Convert ${amtNum} ${from} → ${to} @ ${rate}`,
    });
  } catch (err) {
    // Rollback the debit so the user's funds aren't lost.
    await walletService.credit({
      userId: req.userId,
      accountId,
      currency: from,
      amount: String(amtNum),
      type: WALLET_TX_TYPE.ADJUSTMENT,
      referenceType: 'conversion-rollback',
      note: `Convert rollback (credit failed)`,
    });
    throw err;
  }

  sendSuccess(res, {
    accountId,
    fromCurrency: from,
    toCurrency: to,
    fromAmount: String(amtNum),
    toAmount: targetAmount.toFixed(2),
    rate,
  });
});

/**
 * GET /wallet/recipients/search?q=<term>
 * Autocomplete for the "Send to user" form. Matches against referralCode,
 * email, name, or _id. Excludes the caller and blocked users. Returns a
 * slim recipient shape ({ _id, name, email, referralCode, avatarUrl }).
 */
const searchTransferRecipients = asyncHandler(async (req, res) => {
  const userTransferService = require('../services/userTransferService');
  const { q, limit, by } = req.query;
  // `by=uid` → match the permanent public User ID only (recipient picker
  // restricted to User ID search). Anything else keeps the broad match.
  const results = await userTransferService.searchRecipients(
    req.userId, q, Number(limit) || 10, { uidOnly: by === 'uid' }
  );
  sendSuccess(res, results);
});

/**
 * GET /wallet/transfer-user/settings
 * Returns the current admin-tunable limits for the form (so the FE can
 * show min/max hints + a fee preview before submit).
 */
const getUserTransferSettings = asyncHandler(async (req, res) => {
  const userTransferService = require('../services/userTransferService');
  const cfg = await userTransferService.getTransferSettings();
  sendSuccess(res, {
    enabled:    cfg['userTransfer.enabled'] !== false,
    min:        String(cfg['userTransfer.min']        || '0'),
    max:        String(cfg['userTransfer.max']        || '0'),
    feePercent: String(cfg['userTransfer.feePercent'] || '0'),
  });
});

/**
 * POST /wallet/transfer-user
 * Body: {
 *   fromAccountId, currency, amount, note?,
 *   recipientUserId? | recipientUsername? | recipientReferralCode?
 * }
 * Sends funds to another registered user. Reuses walletService.credit/debit;
 * writes two ledger rows (INTERNAL_TRANSFER_OUT on sender, INTERNAL_TRANSFER_IN
 * on receiver) with a shared referenceId.
 */
const transferToUser = asyncHandler(async (req, res) => {
  const userTransferService = require('../services/userTransferService');
  const {
    fromAccountId, currency, amount, note,
    recipientUserId, recipientUsername, recipientReferralCode,
  } = req.body || {};

  const result = await userTransferService.transferToUser({
    fromUserId:    req.userId,
    fromAccountId,
    currency:      currency || BASE_CURRENCY,
    amount,
    note,
    recipient:     { recipientUserId, recipientUsername, recipientReferralCode },
    req,
  });
  sendSuccess(res, result);
});

/**
 * POST /wallet/deposits/quote  { method, currency, amount }
 * Non-mutating preview for the deposit form (spec §14). Returns the exact rate +
 * fee + net that WILL be used, so the UI can show the breakdown before confirm.
 * The confirm flow re-resolves + persists the rate at transaction time.
 *
 * Deposit: amount (in `currency`) → USD via the DEPOSIT rate; deposit fee on the
 * USD amount; net USD credited = gross − fee.
 */
const quoteDeposit = asyncHandler(async (req, res) => {
  const { method, currency = 'USD', amount } = req.body || {};
  const amt = Number(amount);
  if (!(amt > 0)) throw new AppError('Enter a valid amount', 400, 'INVALID_AMOUNT');
  const code = String(currency).toUpperCase();
  await _assertCurrencySupported(method, code);
  const { usd, rate } = await fxService.toUsd(code, amt, 'deposit');
  const feeUsd = Number(await computeDepositFee(method, usd));
  const netUsd = Math.max(0, round2(usd - feeUsd));
  const cfg = await _methodConfig(method);
  sendSuccess(res, {
    kind: 'deposit',
    currency: code,
    amount: round2(amt),
    rate,                                   // 1 USD = rate <currency>
    grossUsd: round2(usd),                  // converted USD
    feeUsd: round2(feeUsd),
    netUsd,                                 // credited to the USD wallet
    feePercent: Number(cfg?.feePercent) || 0,
    feeFixed: Number(cfg?.feeFixed) || 0,
  });
});

/**
 * POST /wallet/withdrawals/quote  { method, currency, amount }
 * Withdrawal: amount (in `currency`) → USD via the WITHDRAWAL rate = gross USD
 * debited; withdrawal fee on the USD amount; net = gross − fee is what the user
 * RECEIVES (also converted back to `currency`).
 */
const quoteWithdrawal = asyncHandler(async (req, res) => {
  const { method, currency = 'USD', amount } = req.body || {};
  const amt = Number(amount);
  if (!(amt > 0)) throw new AppError('Enter a valid amount', 400, 'INVALID_AMOUNT');
  const code = String(currency).toUpperCase();
  await _assertCurrencySupported(method, code);
  const { usd, rate } = await fxService.toUsd(code, amt, 'withdrawal');
  const feeUsd = Number(await computeWithdrawalFee(method, usd));
  const netUsd = Math.max(0, round2(usd - feeUsd));
  const netAmount = (await fxService.fromUsd(code, netUsd, 'withdrawal')).amount; // user receives, in `currency`
  const cfg = await _methodConfig(method);
  sendSuccess(res, {
    kind: 'withdrawal',
    currency: code,
    amount: round2(amt),                    // debited from account (in currency)
    rate,
    grossUsd: round2(usd),                  // debited from the USD wallet
    feeUsd: round2(feeUsd),
    netUsd,                                 // received (USD)
    netAmount,                              // received (in `currency`)
    feePercent: Number(cfg?.withdrawalFeePercent) || 0,
    feeFixed: Number(cfg?.withdrawalFeeFixed) || 0,
  });
});

module.exports = {
  getBalances,
  getAccountsEquity,
  depositDetails,
  getLedger,
  createDeposit,
  listDeposits,
  quoteDeposit,
  quoteWithdrawal,
  requestWithdrawal,
  listWithdrawals,
  internalTransfer,
  convertCurrency,
  createRazorpayOrder,
  verifyRazorpayPayment,
  razorpayWebhook,
  searchTransferRecipients,
  getUserTransferSettings,
  transferToUser,
};
