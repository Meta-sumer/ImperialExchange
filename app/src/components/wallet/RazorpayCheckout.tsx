import React, { useEffect, useMemo, useRef } from 'react';
import { BackHandler, Linking, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { AppText, IconButton, Portal, toast } from '@/components/ui';
import { useTheme, Z } from '@/theme';
import {
  checkoutHtml,
  loadsInWebView,
  parseCheckoutMessage,
  type CheckoutParams,
  type RazorpaySuccess,
} from '@/utils/razorpay';

export type { RazorpaySuccess } from '@/utils/razorpay';

/**
 * Razorpay's hosted Checkout in a WebView — the page utils/razorpay builds,
 * which is the same checkout.js and options the web opens.
 *
 * Full screen, in the overlay layer (a portal, like every overlay here), so
 * a confirm or toast raised while it is open still stacks above it. Android
 * back closes it the way Checkout's own ✕ does.
 *
 * Links a UPI app answers (upi://, intent://, a bank's scheme) are handed to
 * the phone rather than loaded in the frame.
 *
 * The caller posts /wallet/razorpay/verify from `onSuccess` and from nowhere
 * else — the success handler is the only place a payment id and signature
 * exist.
 */
export interface RazorpayCheckoutProps extends CheckoutParams {
  onSuccess: (payment: RazorpaySuccess) => void;
  onDismiss: () => void;
  onFailure: (message: string) => void;
}

export function RazorpayCheckout({
  keyId,
  orderId,
  amount,
  currency,
  description,
  onSuccess,
  onDismiss,
  onFailure,
}: RazorpayCheckoutProps): React.JSX.Element {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const html = useMemo(
    () => checkoutHtml({ keyId, orderId, amount, currency, description }),
    [keyId, orderId, amount, currency, description],
  );

  // One outcome per checkout: a success that is also followed by Checkout's
  // own dismissal must not report twice.
  const settled = useRef(false);
  const settle = (fn: () => void): void => {
    if (settled.current) return;
    settled.current = true;
    fn();
  };

  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!settled.current) {
        settled.current = true;
        dismissRef.current();
      }
      return true;
    });
    return () => sub.remove();
  }, []);

  const onMessage = (event: WebViewMessageEvent): void => {
    const msg = parseCheckoutMessage(event.nativeEvent.data);
    if (msg.type === 'success') settle(() => onSuccess(msg.payment));
    else if (msg.type === 'dismiss') settle(onDismiss);
    else if (msg.type === 'error') settle(() => onFailure(msg.message));
  };

  return (
    <Portal z={Z.modal}>
      <View
        style={[StyleSheet.absoluteFill, { backgroundColor: t.colors.surface, paddingTop: insets.top, paddingBottom: insets.bottom }]}
        accessibilityViewIsModal
        testID="razorpay-checkout"
      >
        <View style={[styles.bar, { borderBottomColor: t.colors.borderSubtle }]}>
          <AppText variant="title" style={styles.flex}>Pay with Razorpay</AppText>
          <IconButton
            name="close"
            accessibilityLabel="Close"
            color={t.colors.textSecondary}
            onPress={() => settle(onDismiss)}
          />
        </View>
        <WebView
          source={{ html }}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          setSupportMultipleWindows={false}
          onMessage={onMessage}
          onShouldStartLoadWithRequest={(req) => {
            if (loadsInWebView(req.url)) return true;
            // Not fatal when no app answers: Checkout stays open and offers
            // another way to pay.
            void Linking.openURL(req.url).catch(() => toast.error('That payment app is not installed on this phone.'));
            return false;
          }}
          style={styles.flex}
        />
      </View>
    </Portal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
});
