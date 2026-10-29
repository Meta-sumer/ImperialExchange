import React, {
  createContext,
  useCallback,
  useContext,
  useState,
  type ComponentType,
  type ReactNode,
  type Ref,
} from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';

/**
 * What the navigator tells a screen about the chrome around it. Set by
 * navigation/RootNavigator for every route; screens never set it.
 *
 *   hasHeader  the app header (or the public header) is drawn above this
 *              screen and has already taken the top safe-area inset.
 *   headerHeight  its measured height, so the keyboard offset is exact.
 *   Footer     the page footer — the web's CmsFooter under every Layout
 *              page — or null where there is none.
 */
export interface ScreenChrome {
  hasHeader: boolean;
  headerHeight: number;
  Footer: ComponentType | null;
}

export const ScreenChromeContext = createContext<ScreenChrome>({ hasHeader: false, headerHeight: 0, Footer: null });

export const useScreenChrome = (): ScreenChrome => useContext(ScreenChromeContext);

type Edge = 'top' | 'bottom' | 'left' | 'right';

export interface ScreenProps {
  children?: ReactNode;
  /** Scroll the content (default). Off for screens that own a FlatList. */
  scroll?: boolean;
  /**
   * Pull to refresh. Give `onRefresh` alone and the spinner tracks the
   * returned promise; give `refreshing` too to drive it yourself.
   */
  onRefresh?: () => unknown;
  refreshing?: boolean;
  /**
   * The page container padding — Layout.jsx:706 `px-4 py-6`. Off for
   * edge-to-edge content (the terminal, a full-bleed chart).
   */
  padded?: boolean;
  /** The page footer (CmsFooter). Default on for scrolling screens. */
  footer?: boolean;
  /**
   * Safe-area edges to pad. By default: top only when no header is drawn
   * above (the header already took it), plus bottom, left and right.
   */
  edges?: Edge[];
  /** Lift content above the keyboard. Default on. */
  keyboardAvoiding?: boolean;
  contentContainerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
  scrollRef?: Ref<ScrollView>;
  testID?: string;
}

/**
 * The root of every screen: background, safe area, the page padding, the
 * page footer, optional scroll and pull-to-refresh.
 *
 * Always use this (or `useSafeAreaInsets()` for a custom root), never
 * <SafeAreaView>: the read-only impersonation banner zeroes the top inset
 * through context while it is showing, and SafeAreaView measures natively,
 * so it would pad under a banner that has already taken that space.
 */
export function Screen({
  children,
  scroll = true,
  onRefresh,
  refreshing,
  padded = true,
  footer = true,
  edges,
  keyboardAvoiding = true,
  contentContainerStyle,
  style,
  scrollRef,
  testID,
}: ScreenProps): React.JSX.Element {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const chrome = useScreenChrome();
  const [selfRefreshing, setSelfRefreshing] = useState(false);

  const pad = new Set<Edge>(edges ?? (chrome.hasHeader ? ['bottom', 'left', 'right'] : ['top', 'bottom', 'left', 'right']));
  const safe: ViewStyle = {
    paddingTop: pad.has('top') ? insets.top : 0,
    paddingLeft: pad.has('left') ? insets.left : 0,
    paddingRight: pad.has('right') ? insets.right : 0,
  };
  const bottom = pad.has('bottom') ? insets.bottom : 0;
  const pagePad: ViewStyle = padded
    ? { paddingHorizontal: t.space.gutter, paddingTop: t.space.page, paddingBottom: t.space.page }
    : {};

  const handleRefresh = useCallback(async () => {
    if (!onRefresh) return;
    if (refreshing !== undefined) { onRefresh(); return; }
    setSelfRefreshing(true);
    try { await onRefresh(); } finally { setSelfRefreshing(false); }
  }, [onRefresh, refreshing]);

  const Footer = footer && scroll ? chrome.Footer : null;

  const body = scroll ? (
    <ScrollView
      ref={scrollRef}
      testID={testID}
      style={styles.flex}
      contentContainerStyle={[styles.grow, { paddingBottom: bottom }]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshControl={onRefresh ? (
        <RefreshControl
          refreshing={refreshing ?? selfRefreshing}
          onRefresh={handleRefresh}
          tintColor={t.colors.primary}
          colors={[t.colors.primary]}
          progressBackgroundColor={t.colors.surface}
        />
      ) : undefined}
    >
      <View style={[pagePad, contentContainerStyle]}>{children}</View>
      {Footer ? <Footer /> : null}
    </ScrollView>
  ) : (
    <View testID={testID} style={[styles.flex, pagePad, { paddingBottom: (padded ? t.space.page : 0) + bottom }, contentContainerStyle]}>
      {children}
    </View>
  );

  return (
    <View style={[styles.flex, { backgroundColor: t.colors.surface }, safe, style]}>
      {keyboardAvoiding ? (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          // KeyboardAvoidingView compares the keyboard's WINDOW position with
          // its own frame relative to its PARENT. The header sits above the
          // screen, so without its height the lift comes up that much short
          // and the focused field stays under the keyboard.
          keyboardVerticalOffset={chrome.hasHeader ? chrome.headerHeight : 0}
        >
          {body}
        </KeyboardAvoidingView>
      ) : body}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  grow: { flexGrow: 1 },
});
