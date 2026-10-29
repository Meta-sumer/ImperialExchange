import React, { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  Animated,
  BackHandler,
  Easing,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme, Z } from '@/theme';

import { AppText } from './AppText';
import { IconButton } from './Button';
import { Portal } from './Portal';

/**
 * The modal / bottom-sheet shell, ported from client/src/components/Modal.jsx.
 *
 * What it guarantees, item for item against the web's list:
 *   • Renders in the overlay layer (Portal) — immune to the screen's own
 *     layout, like the web's portal into document.body.
 *   • Standardised layering: defaults to Z.modal (1000), modalLayers.js.
 *   • Scroll lock: not needed — the overlay covers the screen and takes the
 *     touches; there is no body behind it to scroll.
 *   • ESC + backdrop close → Android back + backdrop tap, both honouring
 *     `dismissible={false}` for flows that must require an explicit choice.
 *   • Focus: `initialFocus` (a TextInput ref) is focused on open, 40ms in,
 *     as on the web. The web's automatic "first input" search needs a DOM
 *     query that has no RN equivalent, so it is explicit here.
 *   • Safe-area inset so the sheet clears the home indicator.
 *   • Fade backdrop + slide-up panel, ~180ms, reversed on close; the node
 *     stays mounted through the exit.
 *   • accessibilityViewIsModal — the role="dialog" aria-modal equivalent.
 *
 * Layout matches too: an optional `title` renders a header with a close
 * button; `children` go in a scrollable padded body; an optional `footer`
 * is pinned below the scroll area.
 *
 * Presentation follows the web's breakpoint: below 640dp (`sm`) the panel
 * is a bottom sheet (`items-end rounded-t-2xl`), at or above it a centred
 * card capped at `size`. `BottomSheet` forces the sheet everywhere and adds
 * a drag handle.
 */

/** Tailwind's max-w-* steps, in dp. */
const MAX_W = { sm: 384, md: 448, lg: 512, xl: 576, '2xl': 672, '3xl': 768, '4xl': 896 } as const;
export type ModalSize = keyof typeof MAX_W;

/** The web's `sm` breakpoint — the point Modal.jsx stops being a sheet. */
const SM_BREAKPOINT = 640;

export interface ModalProps {
  open?: boolean;
  onClose?: () => void;
  title?: ReactNode;
  /** Controls in the header, just before the close button (ProfileMenu's bell). */
  headerRight?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** The web's `maxW` prop — 'md' is its default `max-w-md`. */
  size?: ModalSize;
  dismissible?: boolean;
  zIndex?: number;
  initialFocus?: RefObject<{ focus: () => void } | null>;
  /** 'auto' follows the web's breakpoint. */
  presentation?: 'auto' | 'sheet' | 'center';
  /** Body padding; the web's default `bodyClassName="p-5"` is 20. */
  bodyPadding?: number;
  /**
   * Set false when the body is itself a virtualised list (FlatList inside a
   * ScrollView breaks virtualisation and warns).
   */
  scrollable?: boolean;
  /** Drag handle + swipe down to close. BottomSheet turns it on. */
  handle?: boolean;
  bodyStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

const DURATION = 180;

export function Modal({
  open = true,
  onClose,
  title,
  headerRight,
  children,
  footer,
  size = 'md',
  dismissible = true,
  zIndex = Z.modal,
  initialFocus,
  presentation = 'auto',
  bodyPadding = 20,
  scrollable = true,
  handle = false,
  bodyStyle,
  testID,
}: ModalProps): React.JSX.Element | null {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const [render, setRender] = useState(open);
  const shown = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;

  // Latest-value refs so the back handler and pan responder, which are
  // created once, never call a stale onClose.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  // Keep the node mounted through the exit transition.
  useEffect(() => {
    if (open) {
      setRender(true);
      return undefined;
    }
    if (!render) return undefined;
    const anim = Animated.timing(shown, {
      toValue: 0,
      duration: DURATION,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start(({ finished }) => { if (finished) setRender(false); });
    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Enter, focus, and the back button — while the node is on screen.
  useEffect(() => {
    if (!render || !open) return undefined;
    drag.setValue(0);
    const anim = Animated.timing(shown, {
      toValue: 1,
      duration: DURATION,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start();

    const focusTimer = setTimeout(() => initialFocus?.current?.focus(), 40);

    // Android back = the web's ESC. Returning true swallows it either way:
    // a non-dismissible modal must not let the screen underneath go back.
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (dismissibleRef.current) onCloseRef.current?.();
      return true;
    });

    if (__DEV__ && typeof onCloseRef.current !== 'function' && dismissibleRef.current) {
      // The web's dev diagnostic, kept: without it a modal that cannot be
      // closed is discovered by a user, not a developer.
      // eslint-disable-next-line no-console
      console.warn('[Modal] no onClose handler provided — back / backdrop close will not work.');
    }

    return () => {
      anim.stop();
      clearTimeout(focusTimer);
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [render, open]);

  const isSheet = presentation === 'sheet' || (presentation === 'auto' && width < SM_BREAKPOINT);

  // Swipe-down-to-close on the handle / header. Only for sheets, only when
  // dismissible — a destructive flow must not be dismissible by a flick.
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => dismissibleRef.current && g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_e, g) => { if (g.dy > 0) drag.setValue(g.dy); },
      onPanResponderRelease: (_e, g) => {
        if (g.dy > 90 || g.vy > 0.9) {
          onCloseRef.current?.();
        } else {
          Animated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;

  // Built once — both inputs are stable Animated.Values.
  const translateY = useMemo(() => Animated.add(
    shown.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }),
    drag,
  ), [shown, drag]);

  if (!render) return null;

  const draggable = isSheet && handle && dismissible;

  const header = title != null ? (
    <View
      {...(draggable ? pan.panHandlers : null)}
      style={[styles.header, { borderBottomColor: t.colors.borderSubtle }]}
    >
      <View style={styles.headerTitle}>
        {typeof title === 'string'
          ? <AppText variant="title" numberOfLines={1}>{title}</AppText>
          : title}
      </View>
      {headerRight}
      <IconButton
        name="close"
        accessibilityLabel="Close"
        onPress={onClose}
        color={t.colors.textMuted}
        style={styles.close}
      />
    </View>
  ) : null;

  const body = scrollable ? (
    <ScrollView
      style={styles.bodyScroll}
      contentContainerStyle={[{ padding: bodyPadding }, bodyStyle]}
      keyboardShouldPersistTaps="handled"
      bounces={false}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.bodyScroll, { padding: bodyPadding }, bodyStyle]}>{children}</View>
  );

  return (
    <Portal z={zIndex}>
      <View
        style={[StyleSheet.absoluteFill, isSheet ? styles.alignSheet : styles.alignCenter]}
        accessibilityViewIsModal
        testID={testID}
      >
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: shown }]}>
          <Pressable
            style={[StyleSheet.absoluteFill, { backgroundColor: t.colors.overlay }]}
            onPress={dismissible ? onClose : undefined}
            accessibilityRole={dismissible ? 'button' : undefined}
            accessibilityLabel={dismissible ? 'Close' : undefined}
          />
        </Animated.View>

        <KeyboardAvoidingView
          // iOS needs the lift; Android resizes the window for the keyboard
          // (adjustResize), and padding on top of that would lift it twice.
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={isSheet ? styles.kavSheet : styles.kavCenter}
          pointerEvents="box-none"
        >
          <Animated.View
            style={[
              styles.panel,
              t.shadow.modal,
              {
                backgroundColor: t.colors.surface,
                borderColor: t.colors.borderDark,
                maxHeight: height * 0.9,
                paddingBottom: insets.bottom,
                opacity: shown,
                transform: [{ translateY }],
              },
              isSheet
                ? { width: '100%', borderTopLeftRadius: t.radius.xxl, borderTopRightRadius: t.radius.xxl }
                : { width: '100%', maxWidth: MAX_W[size], borderRadius: t.radius.xxl },
            ]}
          >
            {handle && isSheet ? (
              <View {...(draggable ? pan.panHandlers : null)} style={styles.handleZone}>
                <View style={[styles.handle, { backgroundColor: t.colors.borderDark }]} />
              </View>
            ) : null}
            {header}
            {body}
            {footer ? (
              <View style={[styles.footer, { borderTopColor: t.colors.borderSubtle }]}>{footer}</View>
            ) : null}
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Portal>
  );
}

/**
 * A modal that is always a bottom sheet, with a drag handle and swipe-down
 * to close. For pickers, action menus and anything list-shaped.
 */
export function BottomSheet(props: Omit<ModalProps, 'presentation' | 'handle'>): React.JSX.Element | null {
  return <Modal {...props} presentation="sheet" handle />;
}

const styles = StyleSheet.create({
  alignSheet: { justifyContent: 'flex-end' },
  alignCenter: { justifyContent: 'center', alignItems: 'center', padding: 16 },
  kavSheet: { width: '100%', justifyContent: 'flex-end' },
  kavCenter: { width: '100%', alignItems: 'center' },
  panel: { borderWidth: 1, overflow: 'hidden', flexShrink: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerTitle: { flex: 1, minWidth: 0 },
  close: { marginRight: -6 },
  bodyScroll: { flexGrow: 0, flexShrink: 1 },
  footer: { padding: 16, borderTopWidth: 1 },
  handleZone: { alignItems: 'center', paddingTop: 8, paddingBottom: 4 },
  handle: { width: 40, height: 4, borderRadius: 2 },
});
