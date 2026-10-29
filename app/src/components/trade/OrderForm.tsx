import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { newIdempotencyKey, placeOrder, useAccountFeePlans } from '@/api/trading.api';
import { WatchlistButton } from '@/components/market/WatchlistButton';
import {
  AppText,
  AssetIcon,
  Icon,
  orderToast,
  toast,
  useConfirm,
  type ConfirmFn,
} from '@/components/ui';
import { useTradeSettings } from '@/store/tradeSettings';
import { useTheme } from '@/theme';
import type {
  Instrument,
  Order,
  OrderMode,
  OrderSide,
  ProductType,
  TradingAccount,
} from '@/types/trading';
import { getMarketSession, marketClosedBanner } from '@/utils/marketSession';
import {
  OPEN_ORDER_MODE_OPTIONS,
  ORDER_MODE_TABS,
  PRODUCT_OPTIONS,
  SL_HELP,
  TP_HELP,
  UNLIMITED_THRESHOLD,
  accountFreeFrom,
  autoTpSlLevels,
  buildOrderRequest,
  bumpToMinimum,
  circuitHint,
  clampLeverage,
  confirmMessage,
  ctaDisabled,
  ctaLabel,
  currentBidAsk,
  defaultQuantity,
  effectiveSpread,
  expiryLine,
  feeEstimate,
  feePlanFor,
  fmtAcct,
  fmtOverrideTime,
  fmtQuoteAmt,
  infoRows,
  initialLeverage,
  isIndianEquity,
  isTradingDisabled,
  leverageChips,
  leverageFromInput,
  nudgePrice,
  nudgeQuantity,
  orderCost,
  placedToastText,
  preSubmitError,
  quantityStep,
  resolveLeverageCap,
  resolveLimitTab,
  riskCalc,
  sanitizeDecimal,
  sideQuotes,
  sliderTicks,
  tpSlCaption,
  tpSlFromPrice,
  tpSlInputChange,
  tpSlPlaceholder,
  tpSlPrecision,
  tradingDisabledBanner,
  volumeField,
  type TpSlContext,
  type TpSlMode,
} from '@/utils/orderForm';

import {
  knownSavedLeverage,
  readSavedLeverage,
  saveLeverage,
  useAccountWallets,
  useLeverageState,
  useScreenFocused,
} from './orderForm/hooks';
import { LeverageSlider } from './orderForm/LeverageSlider';
import { ORDER_TONES, useOrderPalette } from './orderForm/palette';
import {
  FieldCard,
  InfoRow,
  Notice,
  NumericRow,
  PanelSelect,
  SidePriceCard,
} from './orderForm/parts';

/**
 * The order form — EquityHub's client/src/components/OrderForm.jsx, feature
 * for feature: the leverage ceiling from /user/leverage (live on
 * `user:leverage`) and the leverage last chosen for this account; the Sell /
 * Buy cards on the CONFIGURED spread for this account's tier (the spread
 * actually charged); Market / Pending with the server's LIMIT-vs-STOP
 * resolution; Delivery / Intraday for NSE/BSE cash equity; F&O volume in
 * units with the lot size (and MCX's unit) and the lot equivalent; the
 * circuit band and freeze cap; TP / SL in four modes; the free-margin check;
 * the trading-disabled and market-session banners; the fee breakdown from the
 * account tier's fee model; one-click / confirm from Trade Settings; the
 * idempotency-keyed POST; and the preview / external-level / controlled-side
 * hooks the chart drives.
 *
 * F&O lot multiples, option writing (buy-to-open only) and switched-off
 * segments are refused by the server with its own words (INVALID_LOT_SIZE,
 * OPTION_WRITE_NOT_SUPPORTED, SEGMENT_DISABLED); the web does not pre-check
 * them, and the toast shows the server's message.
 *
 * The decisions are in utils/orderForm; this file holds state and draws. It
 * renders a plain column — the host (OrderSheet, the Trade page) provides the
 * scroll.
 *
 * ── DELIBERATE DIFFERENCES FROM THE WEB ──────────────────────────────
 * 1. The limit price follows the live last price only while MARKET is
 *    selected. The web re-seeds it on every lastPrice change, so with a live
 *    feed a Pending price being typed is overwritten by the next tick.
 * 2. "Set TP/SL automatically" waits for a side. The web fills SELL-signed
 *    levels while no side is chosen, which then stay when Buy is pressed.
 * 3. Switching account shows no free balance until the new account's
 *    arrives (the web keeps showing the previous account's).
 * 4. A second submit while one is in flight is ignored (one-click cards
 *    have no disabled state on the web).
 * 5. A one-click Pending order is checked against the side it is sent
 *    with. The web checks the price against the side state, which the
 *    tapped card has not updated yet.
 * ──────────────────────────────────────────────────────────────────────
 */

/** What the Trade chart draws as the pending line: the web's `{ side, type, price }`. */
export interface PendingPricePreview {
  side: OrderSide | null;
  type: 'LIMIT';
  price: string;
}

/** The live Entry / TP / SL preview. Purely visual. */
export interface OrderPreview {
  side: OrderSide;
  mode: OrderMode;
  entry: number | null;
  tp: number | null;
  sl: number | null;
}

/**
 * A chart drag pushed into the form, applied once per `nonce`. A key that is
 * present (even null) is applied; `null` clears that level. `cancel` — the
 * preview pill's × — clears the side (which removes the preview) and both
 * levels.
 */
export interface ExternalLevels {
  price?: number | string | null;
  stopLoss?: number | string | null;
  takeProfit?: number | string | null;
  cancel?: boolean;
  nonce: number | string | null;
}

export interface OrderFormProps {
  instrument: Instrument;
  /** The trading account the order is placed on. Null → "No trading account selected". */
  account: TradingAccount | null;
  /** Called with the server's order after a successful placement. */
  onPlaced?: (order: Order) => void;
  onPendingPriceChange?: (p: PendingPricePreview | null) => void;
  onPreviewChange?: (p: OrderPreview | null) => void;
  externalLevels?: ExternalLevels | null;
  /** Controlled side — the Trade page's chart chips drive it. */
  side?: 'BUY' | 'SELL' | null;
  onSideChange?: (s: 'BUY' | 'SELL' | null) => void;
  /** Renders the × and the Cancel button. */
  onClose?: () => void;
  /**
   * The screen's confirm. Overlay content (a sheet) renders outside the
   * ConfirmProvider, where `useConfirm()` resolves every question "no" —
   * a host that renders the form in a sheet passes its own.
   */
  confirm?: ConfirmFn;
}

export function OrderForm({
  instrument,
  account,
  onPlaced,
  onPendingPriceChange,
  onPreviewChange,
  externalLevels = null,
  side: controlledSide,
  onSideChange,
  onClose,
  confirm: confirmProp,
}: OrderFormProps): React.JSX.Element {
  const C = useOrderPalette();
  const t = useTheme();
  const focused = useScreenFocused();
  const ctxConfirm = useConfirm();
  const confirm = confirmProp ?? ctxConfirm;

  /* ── Leverage ceiling ─────────────────────────────────────────────── */
  const leverageState = useLeverageState(focused);
  const cap = resolveLeverageCap(instrument, account, leverageState?.effectiveLeverage);
  const MAX = cap.max;

  /* ── Side and settings ────────────────────────────────────────────── */
  const [internalSide, setInternalSide] = useState<OrderSide | null>(null);
  const sideControlled = controlledSide === 'BUY' || controlledSide === 'SELL';
  const side: OrderSide | null = sideControlled ? (controlledSide as OrderSide) : internalSide;
  const setSide = (next: OrderSide): void => {
    if (sideControlled) onSideChange?.(next);
    else setInternalSide(next);
  };
  const openOrderMode = useTradeSettings((s) => s.trading.openOrderMode);
  const setSetting = useTradeSettings((s) => s.set);
  const confirmBeforeOrder = useTradeSettings((s) => s.autoTrading.confirmOrder);
  const autoOneClick = useTradeSettings((s) => s.autoTrading.oneClick);
  const autoTpSl = useTradeSettings((s) => s.autoTrading.autoTpSl);
  const isOneClick = openOrderMode === 'oneClick' || autoOneClick;
  const isRiskCalc = openOrderMode === 'riskCalc';
  const [orderMode, setOrderMode] = useState<OrderMode>('MARKET');

  /* ── Fields ───────────────────────────────────────────────────────── */
  const [riskPct, setRiskPct] = useState('1');
  const [stopDistance, setStopDistance] = useState('');
  const [quantity, setQuantity] = useState<string>(() => defaultQuantity(instrument));
  const [price, setPrice] = useState<string>(() => String(instrument?.lastPrice || ''));
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const feePlans = useAccountFeePlans();
  const [tpMode, setTpMode] = useState<TpSlMode>('price');
  const [slMode, setSlMode] = useState<TpSlMode>('price');
  const [tpInput, setTpInput] = useState('');
  const [slInput, setSlInput] = useState('');
  // While a field is focused the trader is typing: the derive-from-price
  // effects must not overwrite it ("1" → "1.00", a vanishing "0"); it is
  // normalised on blur.
  const tpFocused = useRef(false);
  const slFocused = useRef(false);
  const [leverage, setLeverage] = useState<number>(() => initialLeverage(account, MAX, knownSavedLeverage(account?.id)));
  // The 1:__ field's text while it is being typed in; null shows the value.
  const [leverageDraft, setLeverageDraft] = useState<string | null>(null);
  const [productType, setProductType] = useState<ProductType>('DELIVERY');
  const indianEquity = isIndianEquity(instrument);
  const tradingDisabled = isTradingDisabled(instrument);
  const [loading, setLoading] = useState(false);
  const submitting = useRef(false);
  const [moreOpen, setMoreOpen] = useState(false);

  /* ── Free balance ─────────────────────────────────────────────────── */
  const walletRows = useAccountWallets(account?.id, focused);
  const accountFree = accountFreeFrom(walletRows, account);

  const isUnlimited = leverage >= UNLIMITED_THRESHOLD;

  // Re-clamp whenever the ceiling can move (account, instrument, an admin's
  // push) — down, never up — and re-seed the limit price.
  useEffect(() => {
    setLeverage((curr) => clampLeverage(curr, MAX));
    setPrice(String(instrument?.lastPrice || ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument?.id, account?.id, account?.leverage, leverageState?.effectiveLeverage]);

  // The live price re-seeds the limit price only while it is not in use.
  useEffect(() => {
    if (orderMode !== 'MARKET') return;
    setPrice(String(instrument?.lastPrice || ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument?.lastPrice]);

  // A new instrument lifts a volume below its minimum.
  useEffect(() => {
    setQuantity((curr) => bumpToMinimum(curr, instrument));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument?.id]);

  useEffect(() => {
    if (leverage > MAX) setLeverage(MAX);
  }, [leverage, MAX]);

  // This account's remembered leverage, restored when the account changes —
  // keyed on the account ALONE, so a price tick never overwrites the slider.
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    const id = account?.id ?? null;
    restoredFor.current = null;
    let cancelled = false;
    void readSavedLeverage(id).then((saved) => {
      if (cancelled) return;
      if (saved) setLeverage(clampLeverage(saved, MAX));
      restoredFor.current = id;
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id]);

  // Persist whatever value is in effect, including one the clamp lowered —
  // the point is to reopen on the leverage last actually traded at. Not
  // before the stored value has been read back, or it would be overwritten.
  useEffect(() => {
    if (account?.id && restoredFor.current === account.id && Number(leverage) >= 1) saveLeverage(account.id, leverage);
  }, [account?.id, leverage]);

  const leverageOverride = instrument?.leverageOverride || null;

  /* ── Auto TP / SL ─────────────────────────────────────────────────── */
  const autoFillDoneRef = useRef(false);
  const prevSideRef = useRef<OrderSide | null>(side);
  useEffect(() => {
    if (prevSideRef.current !== side) {
      autoFillDoneRef.current = false;
      prevSideRef.current = side;
    }
    if (!autoTpSl) { autoFillDoneRef.current = false; return; }
    if (!quantity || Number(quantity) <= 0) { autoFillDoneRef.current = false; return; }
    if (autoFillDoneRef.current) return;
    if (!side) return; // correctly-signed levels need a side
    const lv = autoTpSlLevels({
      side, orderMode, lastPrice: instrument?.lastPrice, price, pricePrecision: instrument?.pricePrecision,
    });
    if (!lv) return;
    if (!stopLoss) setStopLoss(lv.stopLoss);
    if (!takeProfit) setTakeProfit(lv.takeProfit);
    autoFillDoneRef.current = true;
    // stopLoss / takeProfit deliberately omitted — the × must stick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTpSl, side, quantity, price, orderMode, instrument?.lastPrice, instrument?.pricePrecision]);

  /* ── Chart hooks ──────────────────────────────────────────────────── */
  useEffect(() => {
    if (!onPendingPriceChange) return;
    if (orderMode === 'MARKET') { onPendingPriceChange(null); return; }
    onPendingPriceChange(price ? { side, type: 'LIMIT', price } : null);
  }, [orderMode, side, price, onPendingPriceChange]);

  useEffect(() => {
    if (!onPreviewChange) return;
    if (!side) { onPreviewChange(null); return; }
    const mkt = Number(instrument?.lastPrice);
    const entry = orderMode === 'LIMIT'
      ? (Number(price) > 0 ? Number(price) : null)
      : (Number.isFinite(mkt) && mkt > 0 ? mkt : null);
    onPreviewChange({
      side,
      mode: orderMode,
      entry,
      tp: Number(takeProfit) > 0 ? Number(takeProfit) : null,
      sl: Number(stopLoss) > 0 ? Number(stopLoss) : null,
    });
  }, [side, orderMode, price, takeProfit, stopLoss, instrument?.lastPrice, onPreviewChange]);

  // No stale lines on the chart once the form is gone.
  useEffect(() => () => { onPreviewChange?.(null); }, [onPreviewChange]);

  /* ── Cost ─────────────────────────────────────────────────────────── */
  const free = Number(accountFree || 0);
  const cost = orderCost({ orderMode, lastPrice: instrument?.lastPrice, price, quantity, leverage, free });
  const { refPrice, qtyNum, notional, requiredMargin, remainingAfter, overBudget } = cost;

  /* ── TP / SL ──────────────────────────────────────────────────────── */
  const tpCtx: TpSlContext = { refPrice, qtyNum, free, side, precision: tpSlPrecision(instrument) };

  const onTpChange = (raw: string): void => {
    const r = tpSlInputChange(tpMode, raw, true, tpCtx);
    setTpInput(r.input);
    setTakeProfit(r.price);
  };
  const onSlChange = (raw: string): void => {
    const r = tpSlInputChange(slMode, raw, false, tpCtx);
    setSlInput(r.input);
    setStopLoss(r.price);
  };
  const tpOnFocus = (): void => { tpFocused.current = true; };
  const slOnFocus = (): void => { slFocused.current = true; };
  const tpOnBlur = (): void => { tpFocused.current = false; setTpInput(tpSlFromPrice(tpMode, takeProfit, true, tpCtx)); };
  const slOnBlur = (): void => { slFocused.current = false; setSlInput(tpSlFromPrice(slMode, stopLoss, false, tpCtx)); };
  const switchTpMode = (next: TpSlMode): void => {
    if (next === tpMode) return;
    if (takeProfit) setTpInput(tpSlFromPrice(next, takeProfit, true, tpCtx));
    setTpMode(next);
  };
  const switchSlMode = (next: TpSlMode): void => {
    if (next === slMode) return;
    if (stopLoss) setSlInput(tpSlFromPrice(next, stopLoss, false, tpCtx));
    setSlMode(next);
  };

  // External writers (auto TP/SL, the nudges, a chart drag) set the absolute
  // price; the field follows it — but never while it is being typed in.
  useEffect(() => {
    if (tpFocused.current) return;
    setTpInput(tpSlFromPrice(tpMode, takeProfit, true, tpCtx));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeProfit, tpMode, refPrice, qtyNum, free, side]);
  useEffect(() => {
    if (slFocused.current) return;
    setSlInput(tpSlFromPrice(slMode, stopLoss, false, tpCtx));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopLoss, slMode, refPrice, qtyNum, free, side]);

  // A chart drag: one-shot per nonce, the field back in price mode. The
  // preview's × (`cancel`) clears BOTH side stores and both levels.
  const lastExtNonceRef = useRef<number | string | null>(null);
  useEffect(() => {
    if (!externalLevels || externalLevels.nonce == null) return;
    if (externalLevels.nonce === lastExtNonceRef.current) return;
    lastExtNonceRef.current = externalLevels.nonce;
    if (externalLevels.cancel) {
      setInternalSide(null);
      onSideChange?.(null);
      setTpMode('price'); setTakeProfit('');
      setSlMode('price'); setStopLoss('');
      return;
    }
    if ('price' in externalLevels && externalLevels.price != null) {
      setPrice(String(externalLevels.price));
    }
    if ('takeProfit' in externalLevels) {
      setTpMode('price');
      setTakeProfit(externalLevels.takeProfit == null ? '' : String(externalLevels.takeProfit));
    }
    if ('stopLoss' in externalLevels) {
      setSlMode('price');
      setStopLoss(externalLevels.stopLoss == null ? '' : String(externalLevels.stopLoss));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalLevels]);

  const tpCaption = tpSlCaption(tpMode, takeProfit, tpCtx);
  const slCaption = tpSlCaption(slMode, stopLoss, tpCtx);

  /* ── Quotes, pending resolution, fees ─────────────────────────────── */
  const spread = useMemo(
    () => effectiveSpread(instrument, account?.accountType, feePlans),
    [instrument, account?.accountType, feePlans],
  );
  const bidAsk = currentBidAsk(instrument, spread);
  const limitResolution = resolveLimitTab({ orderMode, price, side, bidAsk });
  const limitInvalidReason = limitResolution.invalidReason;
  const quotes = sideQuotes(instrument, spread);
  const { hasQuotes, bid, ask, prec, spreadAbs, buyPct, sellPct } = quotes;
  const quoteCcy = instrument?.quoteCurrency || 'INR';
  const fees = feeEstimate({ instrument, notional, qtyNum, productType, quotes, plan: feePlanFor(account?.accountType, feePlans) });
  const rows = infoRows({ fees, leverage, cap, requiredMargin });
  const sideIsBuy = side === 'BUY';

  /* ── Submit ───────────────────────────────────────────────────────── */
  const submit = async (sideOverride?: OrderSide): Promise<void> => {
    if (submitting.current) return;
    const effectiveSide = sideOverride || side;
    // Judged for the side being SENT: a one-click card fires before the
    // side it sets has rendered (difference 5).
    const sentLimit = effectiveSide === side
      ? limitResolution
      : resolveLimitTab({ orderMode, price, side: effectiveSide, bidAsk });
    const refusal = preSubmitError({
      instrument,
      side: effectiveSide,
      hasAccount: !!account,
      quantity,
      orderMode,
      price,
      limitInvalidReason: sentLimit.invalidReason,
    });
    if (refusal || !effectiveSide || !account) {
      toast.error(refusal ?? 'Select Buy or Sell first');
      return;
    }
    submitting.current = true;
    try {
      if (confirmBeforeOrder && !isOneClick) {
        const ok = await confirm(confirmMessage({ side: effectiveSide, quantity, instrument, orderMode, price, leverage }));
        if (!ok) return;
      }
      setLoading(true);
      try {
        const req = buildOrderRequest({
          accountId: account.id,
          symbol: instrument.symbol,
          side: effectiveSide,
          orderMode,
          quantity,
          leverage,
          price,
          productType,
          indianEquity,
          stopLoss,
          takeProfit,
          idempotencyKey: newIdempotencyKey(),
        });
        const order = await placeOrder(req);
        orderToast(placedToastText({ side: effectiveSide, quantity, symbol: instrument.symbol, status: order.status }));
        onPlaced?.(order);
        // Keep instrument / leverage / side / volume; SL and TP do not carry over.
        setStopLoss('');
        setTakeProfit('');
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        setLoading(false);
      }
    } finally {
      submitting.current = false;
    }
  };

  /* ── Pieces ───────────────────────────────────────────────────────── */
  const session = getMarketSession(instrument);
  const closedBanner = marketClosedBanner(session);
  const expiry = expiryLine(instrument);
  const volume = volumeField(instrument, qtyNum);
  const circuit = circuitHint(instrument);
  const risk = riskCalc(free, riskPct, stopDistance);
  const qtyStep = quantityStep(instrument);
  const chips = leverageChips(MAX, leverage);
  const ticks = sliderTicks(cap.sliderMax);
  const cta = ctaLabel({ tradingDisabled, loading, side, quantity });
  const ctaOff = ctaDisabled({ loading, overBudget, limitInvalidReason, side, tradingDisabled });

  return (
    <View style={[s.shell, { backgroundColor: C.pageBg, borderColor: C.border }]}>
      {/* Header: icon · name · watchlist · close */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <AssetIcon row={instrument} size={24} round />
          <AppText weight="700" color={C.text} numberOfLines={1} style={s.headerName}>
            {instrument?.baseCurrency || instrument?.symbol}
          </AppText>
          {instrument?.symbol ? (
            <WatchlistButton symbol={instrument.symbol} row={instrument} variant="inline" size={18} persistent />
          ) : null}
        </View>
        {onClose ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Close order panel" onPress={onClose} hitSlop={8} style={s.close}>
            <Icon name="close" size={16} color={C.dim} strokeWidth={2} />
          </Pressable>
        ) : null}
      </View>

      {/* Trading disabled for this instrument (admin) */}
      {tradingDisabled ? (
        <View style={[s.banner, { backgroundColor: ORDER_TONES.disabledBg, borderColor: ORDER_TONES.disabled }]} testID="order-trading-disabled">
          <AppText variant="small" weight="500" color={ORDER_TONES.disabled}>🚫</AppText>
          <AppText variant="small" weight="500" color={ORDER_TONES.disabled} style={s.flex}>{tradingDisabledBanner(instrument)}</AppText>
        </View>
      ) : null}

      {/* Market closed (exchange-bound instruments) */}
      {closedBanner ? (
        <View style={[s.banner, { backgroundColor: ORDER_TONES.orangeBg, borderColor: ORDER_TONES.orange }]}>
          <AppText variant="small" weight="500" color={ORDER_TONES.orange}>⏱</AppText>
          <AppText variant="small" weight="500" color={ORDER_TONES.orange} style={s.flex}>{closedBanner}</AppText>
        </View>
      ) : null}

      {/* Futures / options expiry */}
      {expiry ? (
        <View style={[s.expiry, { backgroundColor: C.cardBg, borderColor: C.border }]}>
          <AppText variant="caption" color={C.dim}>⏳ Expiry</AppText>
          <AppText variant="caption" color={expiry.warn ? ORDER_TONES.orange : C.text}>{expiry.text}</AppText>
        </View>
      ) : null}

      {/* Order entry mode */}
      <View style={s.gap10}>
        <PanelSelect
          value={openOrderMode}
          options={OPEN_ORDER_MODE_OPTIONS}
          onChange={(v) => setSetting('trading.openOrderMode', v)}
          title="Order entry mode"
          accessibilityLabel="Order entry mode"
          C={C}
          testID="order-entry-mode"
        />
      </View>

      {/* Sell / Buy — in one-click mode these ARE the fire buttons */}
      <View style={s.sideRow}>
        <SidePriceCard
          label="Sell"
          price={hasQuotes ? bid : null}
          prec={prec}
          quoteCurrency={quoteCcy}
          active={side === 'SELL'}
          tone="sell"
          C={C}
          disabled={tradingDisabled}
          onPress={() => {
            setSide('SELL');
            if (isOneClick) void submit('SELL');
          }}
        />
        <SidePriceCard
          label="Buy"
          price={hasQuotes ? ask : null}
          prec={prec}
          quoteCurrency={quoteCcy}
          active={side === 'BUY'}
          tone="buy"
          C={C}
          disabled={tradingDisabled}
          onPress={() => {
            setSide('BUY');
            if (isOneClick) void submit('BUY');
          }}
        />
      </View>

      {/* Sentiment bar with the spread chip */}
      {hasQuotes ? (
        <View style={s.sentiment}>
          <View style={s.spreadChipWrap} pointerEvents="none">
            <View style={[s.spreadChip, { backgroundColor: C.cardBg, borderColor: C.border }]}>
              <AppText variant="caption" weight="600" mono color={C.text}>
                {`${spreadAbs.toFixed(prec)} ${instrument?.quoteCurrency || ''}`.trim()}
              </AppText>
            </View>
          </View>
          <View style={s.pctRow}>
            <AppText variant="small" weight="500" color={C.sell}>{`${sellPct.toFixed(0)}%`}</AppText>
            <AppText variant="small" weight="500" color={C.buy}>{`${buyPct.toFixed(0)}%`}</AppText>
          </View>
          <View style={[s.sentBar, { backgroundColor: C.cardBg }]}>
            <View style={[s.sentSell, { width: `${sellPct}%`, backgroundColor: C.sell }]} />
            <View style={[s.sentBuy, { width: `${buyPct}%`, backgroundColor: C.buy }]} />
          </View>
        </View>
      ) : null}

      {/* Market / Pending */}
      <View style={[s.tabs, { backgroundColor: C.cardBg, borderColor: C.border }]}>
        {ORDER_MODE_TABS.map((m) => {
          const active = orderMode === m.id;
          return (
            <Pressable
              key={m.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => {
                setOrderMode(m.id);
                if (m.id === 'LIMIT' && !price && instrument?.lastPrice) setPrice(String(instrument.lastPrice));
              }}
              style={[
                s.tab,
                active ? { backgroundColor: C.cardBg2, borderColor: C.border, borderWidth: 1, borderRadius: 6, margin: -1 } : null,
              ]}
            >
              <AppText variant="body" weight="500" color={active ? C.text : C.dim}>{m.label}</AppText>
            </Pressable>
          );
        })}
      </View>

      {/* Risk calculator */}
      {isRiskCalc ? (
        <View style={[s.riskBox, { backgroundColor: C.cardBg, borderColor: C.border }]}>
          <AppText variant="small" weight="500" color={C.dim}>Risk Calculator</AppText>
          <View style={s.riskInputs}>
            <TextInput
              value={riskPct}
              onChangeText={(v) => setRiskPct(sanitizeDecimal(v))}
              placeholder="Risk %"
              placeholderTextColor={C.muted}
              keyboardType="decimal-pad"
              accessibilityLabel="Risk %"
              style={[s.riskInput, { backgroundColor: C.pageBg, borderColor: C.border, color: C.text }]}
            />
            <TextInput
              value={stopDistance}
              onChangeText={(v) => setStopDistance(sanitizeDecimal(v))}
              placeholder="Stop dist"
              placeholderTextColor={C.muted}
              keyboardType="decimal-pad"
              accessibilityLabel="Stop dist"
              style={[s.riskInput, { backgroundColor: C.pageBg, borderColor: C.border, color: C.text }]}
            />
          </View>
          <View style={s.riskFoot}>
            <AppText variant="small" color={C.dim}>{`Risk · ${fmtAcct(risk.riskAmt)}`}</AppText>
            <Pressable
              accessibilityRole="button"
              disabled={!risk.recommendedQty}
              onPress={() => { if (risk.recommendedQty > 0) setQuantity(risk.recommendedQty.toFixed(4)); }}
              style={{ opacity: risk.recommendedQty ? 1 : 0.5 }}
            >
              <AppText variant="small" weight="500" color={C.buy}>
                {`Use ${risk.recommendedQty > 0 ? risk.recommendedQty.toFixed(4) : '—'} lots`}
              </AppText>
            </Pressable>
          </View>
        </View>
      ) : null}

      <View style={s.form}>
        {/* Limit price (Pending only) */}
        {orderMode === 'LIMIT' ? (
          <FieldCard
            label="Limit Price"
            error={limitInvalidReason}
            subtext={!limitInvalidReason ? limitResolution.hint : null}
            C={C}
          >
            <NumericRow
              C={C}
              testID="order-limit-price"
              accessibilityLabel="Limit Price"
              value={price}
              onChange={setPrice}
              onMinus={() => setPrice(nudgePrice(price, refPrice, prec, -1))}
              onPlus={() => setPrice(nudgePrice(price, refPrice, prec, 1))}
              placeholder={instrument?.lastPrice ? Number(instrument.lastPrice).toFixed(prec) : '0.00'}
              pill="Limit"
              error={!!limitInvalidReason}
            />
          </FieldCard>
        ) : null}

        {/* Temporary leverage override */}
        {leverageOverride ? (
          <Notice bg={ORDER_TONES.amberBg} border={ORDER_TONES.amberBorder} style={s.rounded6}>
            <AppText variant="small" weight="700" color={ORDER_TONES.amberText}>⚠ Temporary Leverage Override Active</AppText>
            <View style={s.overrideRow}>
              <AppText variant="small" color={C.text}>
                {'Current Leverage: '}
                <AppText variant="small" weight="700" color={C.text}>{`1:${leverageOverride.leverage}`}</AppText>
              </AppText>
              <AppText variant="small" color={C.dim}>{`Normal: 1:${leverageOverride.normalLeverage}`}</AppText>
              {leverageOverride.endAt ? (
                <AppText variant="small" color={C.dim}>{`Expires: ${fmtOverrideTime(leverageOverride.endAt)}`}</AppText>
              ) : null}
            </View>
          </Notice>
        ) : null}

        {/* Delivery vs Intraday (NSE / BSE cash equity) */}
        {indianEquity ? (
          <View style={s.productRow}>
            {PRODUCT_OPTIONS.map((p) => {
              const active = productType === p.id;
              return (
                <Pressable
                  key={p.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => setProductType(p.id)}
                  style={[
                    s.product,
                    {
                      borderColor: active ? t.colors.primary : t.colors.borderDark,
                      backgroundColor: active ? t.alpha(t.brand.primary500, 0.1) : 'transparent',
                    },
                  ]}
                >
                  <AppText variant="body" weight="700" color={active ? t.colors.primaryText : t.colors.textPrimary}>{p.label}</AppText>
                  <AppText variant="micro" color={t.colors.textMuted}>{p.hint}</AppText>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {/* Today's circuit band and the per-order freeze cap */}
        {circuit ? (
          <AppText variant="micro" color={t.colors.textMuted} style={s.circuit}>{circuit}</AppText>
        ) : null}

        {/* Volume — F&O in units, with the lot size and the lot equivalent */}
        <FieldCard label={volume.label} subtext={volume.subtext} C={C}>
          <NumericRow
            C={C}
            testID="order-volume"
            accessibilityLabel="Volume"
            value={quantity}
            onChange={setQuantity}
            onMinus={() => setQuantity(nudgeQuantity(quantity, qtyStep, -1))}
            onPlus={() => setQuantity(nudgeQuantity(quantity, qtyStep, 1))}
            placeholder={volume.placeholder}
            suffix={volume.suffix}
          />
        </FieldCard>

        {/* Take Profit */}
        {!isOneClick ? (
          <FieldCard label="Take Profit" help={TP_HELP} C={C} subtext={tpCaption}>
            <NumericRow
              C={C}
              testID="order-tp"
              accessibilityLabel="Take Profit"
              value={tpInput}
              onChange={onTpChange}
              onFocus={tpOnFocus}
              onBlur={tpOnBlur}
              onMinus={() => setTakeProfit(nudgePrice(takeProfit, refPrice, prec, -1))}
              onPlus={() => setTakeProfit(nudgePrice(takeProfit, refPrice, prec, 1))}
              placeholder={tpSlPlaceholder(tpMode, true)}
              priceMode={tpMode}
              onPriceModeChange={switchTpMode}
              allowNegative
            />
          </FieldCard>
        ) : null}

        {/* Stop Loss */}
        {!isOneClick ? (
          <FieldCard label="Stop Loss" help={SL_HELP} C={C} subtext={slCaption}>
            <NumericRow
              C={C}
              testID="order-sl"
              accessibilityLabel="Stop Loss"
              value={slInput}
              onChange={onSlChange}
              onFocus={slOnFocus}
              onBlur={slOnBlur}
              onMinus={() => setStopLoss(nudgePrice(stopLoss, refPrice, prec, -1))}
              onPlus={() => setStopLoss(nudgePrice(stopLoss, refPrice, prec, 1))}
              placeholder={tpSlPlaceholder(slMode, false)}
              priceMode={slMode}
              onPriceModeChange={switchSlMode}
              allowNegative
            />
          </FieldCard>
        ) : null}

        {/* Insufficient margin */}
        {overBudget ? (
          <View style={[s.warn, { backgroundColor: ORDER_TONES.sellBg, borderColor: C.sell }]}>
            <Icon name="alert" size={14} color={C.sell} strokeWidth={2} />
            <AppText variant="small" weight="500" color={C.sell}>Insufficient free margin</AppText>
          </View>
        ) : null}

        {/* Confirm Sell / Buy — the one-click cards fire instead */}
        {!isOneClick ? (
          <Pressable
            testID="order-submit"
            accessibilityRole="button"
            accessibilityState={{ disabled: ctaOff, busy: loading }}
            disabled={ctaOff}
            onPress={() => { void submit(); }}
            style={[
              s.cta,
              {
                backgroundColor: tradingDisabled || !side ? ORDER_TONES.slate : sideIsBuy ? C.buy : C.sell,
                opacity: ctaOff ? 0.5 : 1,
              },
            ]}
          >
            <AppText variant="bodyStrong" weight="500" color={ORDER_TONES.white}>{cta}</AppText>
          </Pressable>
        ) : null}

        {!isOneClick && onClose ? (
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={[s.cancel, { backgroundColor: C.cardBg, borderColor: C.border }]}
          >
            <AppText variant="body" weight="500" color={C.text}>Cancel</AppText>
          </Pressable>
        ) : null}

        {/* Fees · Leverage · Margin · More */}
        <View style={s.info}>
          {rows.map((r) => <InfoRow key={r.label} C={C} label={r.label} value={r.value} help={r.help} />)}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: moreOpen }}
            onPress={() => setMoreOpen((v) => !v)}
            style={s.more}
          >
            <AppText variant="body" color={C.dim} style={s.underline}>{moreOpen ? 'Less' : 'More'}</AppText>
            <Icon name={moreOpen ? 'chevronUp' : 'chevronDown'} size={11} color={C.dim} strokeWidth={2} />
          </Pressable>
          {moreOpen ? (
            <View style={[s.moreBody, { borderTopColor: C.border }]}>
              <View>
                <View style={s.levHead}>
                  <View style={s.levValue}>
                    <AppText variant="small" weight="500" color={C.dim}>Leverage</AppText>
                    {isUnlimited ? (
                      <AppText weight="700" color={C.buy} style={s.levBig}>Unlimited</AppText>
                    ) : (
                      <View style={s.levInputRow}>
                        <AppText variant="small" weight="700" color={C.buy} style={s.levColon}>1:</AppText>
                        <TextInput
                          accessibilityLabel="Leverage multiplier"
                          value={leverageDraft ?? String(leverage)}
                          keyboardType="number-pad"
                          onChangeText={(text) => {
                            const clean = sanitizeDecimal(text);
                            setLeverageDraft(clean);
                            const v = leverageFromInput(clean, MAX);
                            if (v !== null) setLeverage(v);
                          }}
                          onBlur={() => {
                            setLeverageDraft(null);
                            if (!leverage || leverage < 1) setLeverage(1);
                          }}
                          style={[s.levInput, { color: C.buy }]}
                        />
                      </View>
                    )}
                  </View>
                  {cap.capSource === 'instrument' ? (
                    <Pressable
                      accessibilityRole="text"
                      accessibilityHint="This instrument's cap overrides your account / plan."
                      onPress={() => toast("This instrument's cap overrides your account / plan.")}
                      style={[s.capPill, { backgroundColor: ORDER_TONES.instrumentPillBg }]}
                    >
                      <AppText variant="micro" weight="700" color={ORDER_TONES.instrumentPillText} style={s.capPillText}>Instrument</AppText>
                    </Pressable>
                  ) : null}
                  {cap.capSource === 'demo' ? (
                    <View style={[s.capPill, { backgroundColor: ORDER_TONES.demoPillBg }]}>
                      <AppText variant="micro" weight="700" color={ORDER_TONES.demoPillText} style={s.capPillText}>Demo</AppText>
                    </View>
                  ) : null}
                </View>

                {!isUnlimited ? (
                  <>
                    <LeverageSlider
                      value={Math.min(leverage, cap.sliderMax)}
                      max={cap.sliderMax}
                      onChange={setLeverage}
                      accent={C.buy}
                      track={C.border}
                    />
                    <View style={s.ticks}>
                      {ticks.map((tk, i) => <AppText key={i} variant="micro" color={C.muted}>{tk}</AppText>)}
                    </View>
                  </>
                ) : null}

                <View style={s.chips}>
                  {chips.map((c) => (
                    <Pressable
                      key={c.label}
                      accessibilityRole="button"
                      accessibilityState={{ selected: c.active, disabled: c.locked }}
                      accessibilityHint={c.locked ? `Capped at 1:${MAX}` : undefined}
                      onPress={() => {
                        if (c.locked) { toast(`Capped at 1:${MAX}`); return; }
                        setLeverage(c.value);
                      }}
                      style={[
                        s.chip,
                        {
                          backgroundColor: c.active ? C.buy : C.cardBg,
                          borderColor: c.active ? C.buy : C.border,
                          opacity: c.locked ? 0.4 : 1,
                        },
                      ]}
                    >
                      <AppText variant="caption" weight="700" color={c.locked ? C.muted : (c.active ? ORDER_TONES.white : C.text)}>{c.label}</AppText>
                    </Pressable>
                  ))}
                </View>
              </View>

              {qtyNum > 0 && refPrice > 0 ? (
                <View style={s.moreRows}>
                  <InfoRow C={C} label="Notional" value={fmtQuoteAmt(notional)} />
                  <InfoRow
                    C={C}
                    label="Free after"
                    value={fmtAcct(remainingAfter)}
                    valueColor={overBudget ? C.sell : C.buy}
                  />
                </View>
              ) : null}
            </View>
          ) : null}
        </View>

        {isOneClick ? (
          <AppText variant="caption" color={C.muted} align="center">
            One-click mode · order fires immediately at market price
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  shell: { borderWidth: 1, borderRadius: 6, padding: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1, minWidth: 0 },
  headerName: { fontSize: 16, lineHeight: 22, flexShrink: 1 },
  close: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', opacity: 0.85 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 10 },
  expiry: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 10 },
  gap10: { marginBottom: 10 },
  sideRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  sentiment: { marginBottom: 12, marginTop: 8 },
  spreadChipWrap: { position: 'absolute', top: -22, left: 0, right: 0, alignItems: 'center', zIndex: 10 },
  spreadChip: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 3 },
  pctRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  sentBar: { height: 3, borderRadius: 2, overflow: 'hidden', flexDirection: 'row', justifyContent: 'space-between' },
  sentSell: { height: 3 },
  sentBuy: { height: 3 },
  tabs: { flexDirection: 'row', borderWidth: 1, borderRadius: 4, marginBottom: 12, overflow: 'hidden' },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 6 },
  riskBox: { borderWidth: 1, borderRadius: 4, padding: 12, gap: 8, marginBottom: 16 },
  riskInputs: { flexDirection: 'row', gap: 8 },
  riskInput: { flex: 1, borderWidth: 1, borderRadius: 2, paddingHorizontal: 8, paddingVertical: 8, fontSize: 13 },
  riskFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  form: { gap: 10 },
  rounded6: { borderRadius: 6 },
  overrideRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 2, marginTop: 2 },
  productRow: { flexDirection: 'row', gap: 8 },
  product: { flex: 1, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  circuit: { paddingHorizontal: 4 },
  warn: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 10 },
  cta: { borderRadius: 4, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  cancel: { borderRadius: 4, borderWidth: 1, paddingVertical: 8, alignItems: 'center', justifyContent: 'center' },
  info: { paddingTop: 4, gap: 6 },
  more: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingTop: 4, alignSelf: 'flex-start' },
  underline: { textDecorationLine: 'underline' },
  moreBody: { paddingTop: 12, marginTop: 4, borderTopWidth: 1, gap: 12 },
  levHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 },
  levValue: { flexDirection: 'row', alignItems: 'baseline', gap: 8, flexShrink: 1 },
  levBig: { fontSize: 15, lineHeight: 20 },
  levInputRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  levColon: { opacity: 0.6 },
  levInput: { minWidth: 48, fontSize: 15, fontWeight: '700', paddingVertical: 0, fontVariant: ['tabular-nums'] },
  capPill: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  capPillText: { fontSize: 9, letterSpacing: 0.8, textTransform: 'uppercase' },
  ticks: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  chip: { width: '31.5%', borderWidth: 1, borderRadius: 4, paddingVertical: 6, alignItems: 'center' },
  moreRows: { gap: 4 },
});
