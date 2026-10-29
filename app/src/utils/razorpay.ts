/**
 * The page Razorpay's hosted Checkout runs in — the same checkout.js and the
 * same options the web opens (Wallet.jsx submitRazorpay, 996-1021), inside a
 * WebView.
 *
 * It talks back through `postMessage`: the handler's three values on
 * success, a dismissal, or a failure to load Checkout itself. It never
 * decides that money arrived — that is the server's job, when the caller
 * posts the signature to /wallet/razorpay/verify from the success handler.
 *
 * A declined card or a timed-out UPI request is NOT reported: like the web,
 * no `payment.failed` handler is registered, so Razorpay's own modal offers
 * the retry. Closing on it would open a fresh order — and a fresh PENDING
 * deposit on the server — for every attempt.
 */
export interface CheckoutParams {
  /** The PUBLIC key id the server returned with the order. */
  keyId: string;
  orderId: string;
  /** Major units (rupees); converted to paise below exactly as the web does. */
  amount: number;
  currency: string;
  description: string;
}

/** The web's Checkout options. Exported for tests. */
export const checkoutOptions = (p: CheckoutParams): Record<string, unknown> => ({
  key: p.keyId,
  order_id: p.orderId,
  amount: Math.round(Number(p.amount) * 100),
  currency: p.currency,
  name: 'Trading Platform',
  description: p.description,
  // Lets Checkout hand a UPI intent to an installed app from inside a WebView.
  webview_intent: true,
});

/** JSON that is safe inside a <script> block: no "</script>" can close it early. */
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

export const CHECKOUT_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';

export const CHECKOUT_LOAD_FAILED = 'Failed to load Razorpay Checkout';

export const checkoutHtml = (p: CheckoutParams): string => `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:#fff;font-family:sans-serif}#s{padding:24px;color:#555;font-size:14px}</style>
</head><body><div id="s">Opening Razorpay…</div><script>
var send=function(m){window.ReactNativeWebView.postMessage(JSON.stringify(m));};
var opts=${scriptJson(checkoutOptions(p))};
opts.handler=function(r){send({type:'success',orderId:r.razorpay_order_id,paymentId:r.razorpay_payment_id,signature:r.razorpay_signature});};
opts.modal={ondismiss:function(){send({type:'dismiss'});}};
var s=document.createElement('script');
s.src=${scriptJson(CHECKOUT_SCRIPT_URL)};
s.onload=function(){try{new Razorpay(opts).open();}catch(e){send({type:'error',message:String((e&&e.message)||e)});}};
s.onerror=function(){send({type:'error',message:${scriptJson(CHECKOUT_LOAD_FAILED)}});};
document.head.appendChild(s);
</script></body></html>`;

export interface RazorpaySuccess {
  orderId: string;
  paymentId: string;
  signature: string;
}

export type CheckoutMessage =
  | { type: 'success'; payment: RazorpaySuccess }
  | { type: 'dismiss' }
  | { type: 'error'; message: string }
  | { type: 'ignore' };

/**
 * A message from the checkout page. A success missing any of the three
 * values is not a success — /razorpay/verify would 400 it anyway — and is
 * reported as an error rather than posted.
 */
export const parseCheckoutMessage = (data: string): CheckoutMessage => {
  let msg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object') return { type: 'ignore' };
    msg = parsed as Record<string, unknown>;
  } catch {
    return { type: 'ignore' };
  }
  if (msg.type === 'success') {
    const payment = {
      orderId: typeof msg.orderId === 'string' ? msg.orderId : '',
      paymentId: typeof msg.paymentId === 'string' ? msg.paymentId : '',
      signature: typeof msg.signature === 'string' ? msg.signature : '',
    };
    if (!payment.orderId || !payment.paymentId || !payment.signature) {
      return { type: 'error', message: 'Payment failed' };
    }
    return { type: 'success', payment };
  }
  if (msg.type === 'dismiss') return { type: 'dismiss' };
  if (msg.type === 'error') return { type: 'error', message: typeof msg.message === 'string' && msg.message ? msg.message : 'Payment failed' };
  return { type: 'ignore' };
};

/**
 * Which navigations the WebView loads itself. Everything else — upi://,
 * intent://, a bank's app scheme — is handed to the phone.
 */
export const loadsInWebView = (url: string): boolean => /^(https?:|about:|data:|blob:)/i.test(url);
