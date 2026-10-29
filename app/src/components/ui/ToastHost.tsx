import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';
import { useStore } from 'zustand';

import { brand, Z } from '@/theme';

import { AppText } from './AppText';
import { Portal } from './Portal';
import { toast, toastStore, type ToastItem } from './toast';

/**
 * Renders the toast queue — main.jsx's <Toaster>.
 *
 * The look is the web's `toastOptions`, copied value for value: white card,
 * #1F2937 text, #E5E7EB border, a soft shadow, a primary-blue success icon
 * and a bear-red error icon. The web does not theme its toasts for dark
 * mode (the style is inline hex), so neither does this.
 *
 * Position: the web pushes the container to `top: 72` "so the order-filled
 * popup never covers the account / balance pill" in the 64px top bar. Same
 * offset here, measured from below the status bar.
 *
 * On a phone only the newest three are drawn; a stack of twenty would cover
 * the screen. They are still queued and still time out.
 */

const VISIBLE = 3;

const STYLE = {
  background: '#FFFFFF',
  color: '#1F2937',
  border: '#E5E7EB',
} as const;

function TypeIcon({ item }: { item: ToastItem }): React.JSX.Element | null {
  if (item.icon) return <AppText style={styles.emoji}>{item.icon}</AppText>;
  if (item.type === 'loading') return <ActivityIndicator size="small" color="#616161" />;
  if (item.type === 'success') {
    return (
      <Svg width={20} height={20} viewBox="0 0 20 20">
        <Circle cx={10} cy={10} r={10} fill={brand.primary500} />
        <Path d="M6 10.5l2.6 2.5L14 7.5" stroke="#fff" strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    );
  }
  if (item.type === 'error') {
    return (
      <Svg width={20} height={20} viewBox="0 0 20 20">
        <Circle cx={10} cy={10} r={10} fill={brand.bear} />
        <Path d="M7 7l6 6M13 7l-6 6" stroke="#fff" strokeWidth={2} strokeLinecap="round" />
      </Svg>
    );
  }
  return null;
}

function ToastRow({ item }: { item: ToastItem }): React.JSX.Element {
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(enter, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 6 }).start();
  }, [enter]);

  return (
    <Animated.View
      style={{
        opacity: enter,
        transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }],
      }}
    >
      <Pressable
        onPress={() => toast.dismiss(item.id)}
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        style={styles.toast}
      >
        <TypeIcon item={item} />
        <AppText variant="body" color={STYLE.color} style={styles.msg}>{item.message}</AppText>
        {item.dismissButton ? (
          <Pressable
            onPress={() => toast.dismiss(item.id)}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            hitSlop={8}
            style={styles.x}
          >
            <Svg width={12} height={12} viewBox="0 0 24 24">
              <Path d="M18 6L6 18M6 6l12 12" stroke={STYLE.color} strokeWidth={2.6} strokeLinecap="round" />
            </Svg>
          </Pressable>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

export function ToastHost(): React.JSX.Element {
  const toasts = useStore(toastStore, (s) => s.toasts);
  const insets = useSafeAreaInsets();
  const visible = toasts.slice(0, VISIBLE);

  return (
    <Portal z={Z.toast}>
      <View pointerEvents="box-none" style={[styles.container, { top: insets.top + 72 }]}>
        {visible.map((item) => <ToastRow key={item.id} item={item} />)}
      </View>
    </Portal>
  );
}

const styles = StyleSheet.create({
  container: { position: 'absolute', left: 16, right: 16, alignItems: 'center', gap: 8 },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    maxWidth: 350,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: STYLE.border,
    backgroundColor: STYLE.background,
    // `0 6px 24px rgba(17,24,39,0.08)`
    shadowColor: '#111827',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 6,
  },
  msg: { flexShrink: 1 },
  emoji: { fontSize: 16, lineHeight: 20 },
  x: { opacity: 0.6, padding: 2 },
});
