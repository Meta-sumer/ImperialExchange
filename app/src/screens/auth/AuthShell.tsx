import React, { type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText, BrandLogo, Card, Icon } from '@/components/ui';
import { useAppNavigation, useAppRoute } from '@/navigation/types';
import { PageFooter } from '@/navigation/chromeSlots';
import { useAppearance, useTheme, type AppTheme } from '@/theme';

import { AuthBackground } from './components/AuthBackground';

/**
 * Shared chrome for the auth pages — client/src/components/AuthShell.jsx.
 *
 *   AuthShell     Login / Register / ForgotPassword: the marketing header
 *                 (with the theme toggle), the live trading background and
 *                 the CMS footer, with the card as children.
 *   AuthCentered  ResetPassword / VerifyEmail: the web renders these
 *                 without AuthShell — a centred card on the page
 *                 background — so they get the same here.
 *
 * Both are keyboard-safe: a KeyboardAvoidingView with `padding` on BOTH
 * platforms (under Android's edge-to-edge the window no longer resizes for
 * the keyboard, so nothing else would lift the form), around a ScrollView
 * that keeps taps on the form while the keyboard is up.
 *
 * Everything follows the app theme, so header, card, footer and background
 * flip together with the toggle — as on the web.
 */

/** The web's link blue (`text-teal-accent` / `text-primary-500`), readable in dark mode too. */
export const linkColor = (t: AppTheme): string => (t.isDark ? t.brand.primary400 : t.brand.tealAccent);

function KeyboardSafeScroll({
  children,
  contentStyle,
  testID,
}: {
  children: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
}): React.JSX.Element {
  return (
    <KeyboardAvoidingView behavior="padding" style={styles.flex}>
      <ScrollView
        testID={testID}
        style={styles.flex}
        contentContainerStyle={[styles.grow, contentStyle]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function AuthShell({ children, testID }: { children: ReactNode; testID?: string }): React.JSX.Element {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const Footer = PageFooter;
  return (
    <View style={[styles.flex, { backgroundColor: t.colors.bgDark, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <KeyboardSafeScroll testID={testID}>
        <View style={styles.region}>
          <AuthBackground />
          <AuthHeader topInset={insets.top} />
          <View style={styles.main}>{children}</View>
        </View>
        {Footer ? <Footer /> : null}
        <View style={{ height: insets.bottom }} />
      </KeyboardSafeScroll>
    </View>
  );
}

export function AuthCentered({ children, testID }: { children: ReactNode; testID?: string }): React.JSX.Element {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.flex, { backgroundColor: t.colors.bgDark }]}>
      <KeyboardSafeScroll
        testID={testID}
        contentStyle={{
          alignItems: 'center',
          justifyContent: 'center',
          paddingTop: insets.top + t.space.lg,
          paddingBottom: insets.bottom + t.space.lg,
          paddingLeft: insets.left + t.space.lg,
          paddingRight: insets.right + t.space.lg,
        }}
      >
        <View style={styles.column}>{children}</View>
      </KeyboardSafeScroll>
    </View>
  );
}

/** `card p-8 w-full max-w-md`. */
export function AuthCard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }): React.JSX.Element {
  const t = useTheme();
  return (
    <Card padded={t.space.xxxl} style={[styles.card, style]}>
      {children}
    </Card>
  );
}

/**
 * BrandMark.jsx — the brand block on every auth page: the EquityHub logo in
 * its STACKED form (icon over the wordmark, the logo as designed), 112 high
 * (136 at `lg`). `wordmark={false}` is the icon alone, 48 (56) square —
 * VerifyEmail, where the heading carries the name. The art is transparent
 * and theme-aware, so it sits on the card as is; the wordmark is part of
 * the image, so no brand text is printed beside it.
 */
export function BrandMark({ size = 'md', wordmark = true }: { size?: 'md' | 'lg'; wordmark?: boolean }): React.JSX.Element {
  if (!wordmark) {
    return <BrandLogo variant="icon" height={size === 'lg' ? 56 : 48} style={styles.mark} />;
  }
  return <BrandLogo variant="stacked" height={size === 'lg' ? 136 : 112} style={styles.mark} />;
}

/** An inline text link in the web's link blue. */
export function TextLink({
  label,
  onPress,
  variant = 'small',
  weight,
  style,
  accessibilityLabel,
  disabled,
}: {
  label: string;
  onPress: () => void;
  variant?: 'small' | 'body' | 'caption';
  weight?: TextStyle['fontWeight'];
  style?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
  disabled?: boolean;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <AppText
      variant={variant}
      weight={weight}
      color={linkColor(t)}
      onPress={disabled ? undefined : onPress}
      accessibilityRole="link"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      suppressHighlighting
      style={[disabled ? styles.dim : null, style]}
    >
      {label}
    </AppText>
  );
}

/**
 * LandingHeader.jsx — the marketing header of the landing and auth pages.
 *
 * An 80-high bar (`h-20`) with the horizontal logo at 36 (`!h-9`, the phone
 * size: room for the toggle and "Get Started" on a 375 wide screen), the
 * theme toggle and "Get Started". On a phone the section links are
 * `hidden md:flex` and "Sign In" is `hidden sm:inline-flex`, so neither
 * appears below 640 wide; from 640 up "Sign In" is drawn too, and from 768
 * the section links (`sections`, which only the landing page passes — they
 * scroll it). The logo art is theme-aware, so it needs no tile on the dark
 * theme; the controls turn white there.
 */
export function AuthHeader({
  topInset,
  sections,
}: {
  topInset: number;
  /** LandingHeader NAV — Features, Markets, Platform, How it works. */
  sections?: ReadonlyArray<{ label: string; onPress: () => void }>;
}): React.JSX.Element {
  const t = useTheme();
  const nav = useAppNavigation();
  const route = useAppRoute();
  const { mode, toggle } = useAppearance();
  const { width } = useWindowDimensions();
  const dark = mode === 'dark';
  const wide = width >= 640;

  return (
    <View style={[styles.header, { paddingTop: topInset }]}>
      <View style={styles.headerBar}>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Imperial Exchange home"
          onPress={() => nav.navigate('Landing', undefined, { pop: true })}
        >
          <BrandLogo variant="full" height={wide ? 44 : 36} />
        </Pressable>

        {sections && width >= 768 ? (
          <View style={styles.headerNav}>
            {sections.map((s) => (
              <Pressable key={s.label} accessibilityRole="link" onPress={s.onPress} hitSlop={4} style={styles.headerNavItem}>
                <AppText variant="bodyStrong" color={dark ? 'rgba(255,255,255,0.85)' : t.colors.textSecondary}>{s.label}</AppText>
              </Pressable>
            ))}
          </View>
        ) : null}

        <View style={styles.headerRight}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={dark ? 'Switch to light theme' : 'Switch to dark theme'}
            onPress={toggle}
            hitSlop={4}
            style={({ pressed }) => [
              styles.toggle,
              {
                borderRadius: t.radius.lg,
                borderColor: dark ? 'rgba(255,255,255,0.4)' : t.colors.borderDark,
                backgroundColor: pressed ? (dark ? 'rgba(255,255,255,0.1)' : t.colors.bgHover) : 'transparent',
              },
            ]}
          >
            <Icon name={dark ? 'sun' : 'moon'} size={17} strokeWidth={2} color={dark ? '#FFFFFF' : t.colors.textSecondary} />
          </Pressable>

          {wide ? (
            <Pressable
              accessibilityRole="link"
              onPress={() => { if (route.name !== 'Login') nav.navigate('Login', undefined, { pop: true }); }}
              style={({ pressed }) => [
                styles.getStarted,
                {
                  borderRadius: t.radius.lg,
                  borderWidth: 1,
                  borderColor: dark ? 'rgba(255,255,255,0.55)' : t.colors.borderDark,
                  backgroundColor: pressed ? (dark ? 'rgba(255,255,255,0.1)' : t.colors.bgHover) : (dark ? 'transparent' : t.colors.surface),
                },
              ]}
            >
              <AppText variant="body" weight="600" color={dark ? '#FFFFFF' : t.colors.textPrimary}>Sign In</AppText>
            </Pressable>
          ) : null}

          <Pressable
            accessibilityRole="link"
            onPress={() => { if (route.name !== 'Register') nav.navigate('Register', undefined, { pop: true, merge: true }); }}
            style={({ pressed }) => [
              styles.getStarted,
              {
                borderRadius: t.radius.lg,
                backgroundColor: dark ? '#FFFFFF' : pressed ? t.colors.primaryPressed : t.colors.primary,
                opacity: dark && pressed ? 0.9 : 1,
              },
            ]}
          >
            <AppText variant="body" weight={dark ? '700' : '600'} color={dark ? t.brand.primary600 : t.colors.onPrimary}>
              Get Started
            </AppText>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  grow: { flexGrow: 1 },
  region: { flexGrow: 1, position: 'relative' },
  main: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 40,
    zIndex: 10,
  },
  column: { width: '100%', maxWidth: 448 },
  card: { width: '100%', maxWidth: 448 },
  mark: { alignSelf: 'center' },
  header: { zIndex: 10 },
  headerBar: {
    height: 80,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerNav: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerNavItem: { paddingHorizontal: 12, paddingVertical: 8 },
  toggle: { width: 36, height: 36, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  getStarted: { paddingHorizontal: 16, paddingVertical: 8, minHeight: 36, justifyContent: 'center' },
  dim: { opacity: 0.5 },
});
