import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Easing,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { fetchMarketWatch } from '@/api/instruments.api';
import { FillSvg } from '@/components/common/FillSvg';
import { AppText } from '@/components/ui';
import type { AppScreenProps } from '@/navigation/types';
import { PageFooter } from '@/navigation/chromeSlots';
import { AuthHeader } from '@/screens/auth/AuthShell';
import { alpha, useAppearance, useTheme } from '@/theme';
import type { Instrument } from '@/types/trading';

import {
  BLUE_GRAD,
  CheckDot,
  FeatureIcon,
  Glow,
  GradTile,
  Gradient,
  GradientText,
  Heart,
  HeroChart,
  MarketCluster,
  ShieldArt,
  Stars,
  useLoop,
  useReduceMotion,
} from './LandingArt';
import {
  AVATARS,
  BADGES,
  BENEFITS,
  BUILT,
  FEATURES,
  LIVE_MS,
  MARKETS,
  NAV,
  PLATFORM_POINTS,
  SECURITY,
  STEPS,
  STEP_STYLES,
  TERMINAL_POSITIONS,
  TESTIMONIALS,
  TICKER,
  WHY,
  marketChange,
  marketChanges,
  signedPct,
  tickerRows,
  type TickerRow,
} from './landingData';

/**
 * The signed-out landing page — client/src/pages/Landing.jsx, the
 * Indian-market EquityHub page, section by section: the sticky header, the
 * live NSE / BSE / MCX ticker, the hero (with the NIFTY card), the trust
 * badges, Why Choose EquityHub, Everything a Trader Needs, Built for Every
 * Trader, Trade Indian Markets (live per-segment change), the Professional
 * Trading Platform terminal, the security banner, How It Works, Why Traders
 * Love EquityHub, the final call to action and the CMS footer. Every string
 * is the web's.
 *
 * The only network call is the public /instruments/watchlist feed behind the
 * ticker and the market cards, every 10 s while this screen is in front and
 * the app is active; the static INR showcase stands in until it answers, or
 * if it cannot.
 *
 * Laid out as the web lays itself out at the device's width: one column on
 * a phone, two from 640 (`sm:`), four from 1024 (`lg:`), with the web's
 * phone-only hiding (the hero's floating cards from 640, the header's
 * section links from 768).
 *
 * Not ported, on purpose: "Trade Anytime, Anywhere" — the section that
 * sends a visitor to download the app (its store badges lead to the web's
 * /download placeholder). Whoever reads this page is already in the app.
 */

const MAX_W = 1200;

interface Layout {
  width: number;
  sm: boolean;
  md: boolean;
  lg: boolean;
  /** The content width inside the page gutters. */
  inner: number;
}

const useLayout = (): Layout => {
  const { width } = useWindowDimensions();
  const sm = width >= 640;
  const gutter = sm ? 24 : 16;
  return { width, sm, md: width >= 768, lg: width >= 1024, inner: Math.min(width, MAX_W) - gutter * 2 };
};

/** The web's `grid sm:grid-cols-2 lg:grid-cols-4` — a column count and each cell's width. */
const gridCell = (l: Layout, gap: number, max = 4): number => {
  const cols = l.lg ? max : l.sm ? 2 : 1;
  return Math.floor((l.inner - gap * (cols - 1)) / cols);
};

export function LandingScreen({ navigation }: AppScreenProps<'Landing'>): React.JSX.Element {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const layout = useLayout();
  const [feed, setFeed] = useState<Instrument[]>([]);

  useEffect(() => {
    if (!focused) return undefined;
    let on = true;
    const load = (): void => {
      // Not while the app is in the background. ('unknown' at launch and
      // iOS's 'inactive' still read: the page is about to be on screen.)
      if (AppState.currentState === 'background') return;
      fetchMarketWatch()
        .then((rows) => { if (on) setFeed(rows); })
        .catch(() => { /* keep the static fallback */ });
    };
    load();
    const id = setInterval(load, LIVE_MS);
    return () => { on = false; clearInterval(id); };
  }, [focused]);

  const live = useMemo(() => tickerRows(feed), [feed]);
  const chg = useMemo(() => marketChanges(feed), [feed]);
  const register = (): void => navigation.navigate('Register');
  const login = (): void => navigation.navigate('Login');
  const Footer = PageFooter;

  // LandingHeader.jsx `sticky`: it stays put — here above the scroll, so
  // nothing passes under the status bar — lighter at the top of the page,
  // firmer with a bottom border once scrolled (window.scrollY > 8).
  const dark = useAppearance().mode === 'dark';
  const [scrolled, setScrolled] = useState(false);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    setScrolled(e.nativeEvent.contentOffset.y > 8);
  };
  const barColor = dark ? t.colors.bgCard : '#FFFFFF';

  // The header's section links (`/#features` …) scroll to their section.
  const scroller = useRef<ScrollView>(null);
  const anchors = useRef<Record<string, number>>({});
  const anchor = (key: string) => (e: LayoutChangeEvent): void => { anchors.current[key] = e.nativeEvent.layout.y; };
  const sections = useMemo(() => NAV.map(([label, key]) => ({
    label,
    onPress: () => scroller.current?.scrollTo({ y: Math.max(0, (anchors.current[key] ?? 0) - 8), animated: true }),
  })), []);

  return (
    <View style={[styles.flex, { backgroundColor: t.colors.surface }]} testID="landing-screen">
      <View
        style={[
          styles.stickyHeader,
          scrolled ? t.shadow.card : styles.topShadow,
          {
            backgroundColor: alpha(barColor, scrolled ? 0.9 : 0.7),
            borderBottomColor: scrolled ? t.colors.borderSubtle : 'transparent',
          },
        ]}
        testID="landing-header"
      >
        <AuthHeader topInset={insets.top} sections={sections} />
      </View>
      <ScrollView
        ref={scroller}
        contentContainerStyle={{ paddingBottom: insets.bottom }}
        onScroll={onScroll}
        scrollEventThrottle={32}
      >
        <Ticker rows={live.length ? live : TICKER} />
        <Hero layout={layout} onRegister={register} onLogin={login} />
        <TrustBadges layout={layout} />
        <View onLayout={anchor('why')}>
          <Section layout={layout} eyebrow="Why Choose Us" title="Why Choose EquityHub?" sub="Everything you need to trade with confidence — speed, security and total transparency.">
            {WHY.map((w) => (
              <Card key={w.title} layout={layout} padding={20}>
                <View style={styles.mb12}><GradTile icon={w.icon} id={`why-${w.icon}`} /></View>
                <AppText style={styles.cardTitle}>{w.title}</AppText>
                <AppText style={styles.cardBody} tone="secondary">{w.body}</AppText>
              </Card>
            ))}
          </Section>
        </View>
        <View onLayout={anchor('features')}>
          <Section layout={layout} band eyebrow="Features" title="Everything a Trader Needs" sub="A complete terminal built for speed, depth and control.">
            {FEATURES.map((f) => (
              <Card key={f.title} layout={layout} padding={24} surface>
                <View style={styles.mb16}><GradTile icon={f.icon} id={`feat-${f.icon}`} shine /></View>
                <AppText style={styles.cardTitle}>{f.title}</AppText>
                <AppText style={styles.cardBody} tone="secondary">{f.body}</AppText>
              </Card>
            ))}
          </Section>
        </View>
        <Section layout={layout} eyebrow="For Everyone" title="Built for Every Trader" sub="Whether you're just starting or a pro, EquityHub gives you the tools, flexibility and freedom to trade your way.">
          {BUILT.map((b) => (
            <Card key={b.title} layout={layout} padding={24} centered>
              <View style={styles.mb16}><GradTile icon={b.icon} size={56} radius={16} id={`built-${b.icon}`} /></View>
              <AppText style={styles.cardTitle} align="center">{b.title}</AppText>
              <AppText style={styles.cardBody} tone="secondary" align="center">{b.body}</AppText>
            </Card>
          ))}
        </Section>
        <View onLayout={anchor('markets')}>
          <Markets layout={layout} chg={chg} />
        </View>
        <View onLayout={anchor('platform')}>
          <Platform layout={layout} onRegister={register} />
        </View>
        <ProtectedBanner layout={layout} />
        <View onLayout={anchor('how')}>
          <Steps layout={layout} />
        </View>
        <Testimonials layout={layout} />
        <FinalCta layout={layout} onRegister={register} />
        {Footer ? <Footer /> : null}
      </ScrollView>
    </View>
  );
}

/* ── Frame ───────────────────────────────────────────────────────────── */

/** `max-w-[1200px] mx-auto px-4 sm:px-6`. */
function Container({ layout, children, style }: { layout: Layout; children: React.ReactNode; style?: object }): React.JSX.Element {
  return (
    <View style={[styles.container, { width: layout.inner + (layout.sm ? 48 : 32), paddingHorizontal: layout.sm ? 24 : 16 }, style]}>
      {children}
    </View>
  );
}

function SectionHead({ eyebrow, title, sub }: { eyebrow?: string; title: string; sub?: string }): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={styles.head}>
      {eyebrow ? <AppText style={styles.eyebrow} color={t.colors.primaryText} align="center">{eyebrow.toUpperCase()}</AppText> : null}
      <AppText style={styles.h2} align="center" accessibilityRole="header">{title}</AppText>
      {sub ? <AppText style={styles.sub} tone="secondary" align="center">{sub}</AppText> : null}
    </View>
  );
}

/** A `py-16` section: the head, then a `grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-10`. */
function Section({
  layout,
  eyebrow,
  title,
  sub,
  band = false,
  children,
}: {
  layout: Layout;
  eyebrow?: string;
  title: string;
  sub?: string;
  /** `bg-bg-card/50 border-y border-border-subtle`. */
  band?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <View
      style={band
        ? { backgroundColor: t.alpha(t.colors.bgCard, 0.5), borderTopWidth: 1, borderBottomWidth: 1, borderColor: t.colors.borderSubtle }
        : null}
    >
      <Container layout={layout} style={styles.py64}>
        <SectionHead eyebrow={eyebrow} title={title} sub={sub} />
        <View style={styles.grid}>{children}</View>
      </Container>
    </View>
  );
}

/** `.card` — a grid cell (`bg-white` when `surface`). */
function Card({
  layout,
  padding,
  surface = false,
  centered = false,
  children,
}: {
  layout: Layout;
  padding: number;
  surface?: boolean;
  centered?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const t = useTheme();
  return (
    <View
      style={[
        styles.card,
        t.shadow.card,
        {
          width: gridCell(layout, 16),
          padding,
          backgroundColor: surface ? t.colors.surface : t.colors.bgCard,
          borderColor: t.colors.borderDark,
        },
        centered ? styles.centered : null,
      ]}
    >
      {children}
    </View>
  );
}

/* ── Ticker ──────────────────────────────────────────────────────────── */

/** Landing.jsx Ticker — the marquee (`lnd-marquee`, 32 s a lap; still under reduced motion). */
function Ticker({ rows }: { rows: readonly TickerRow[] }): React.JSX.Element {
  const t = useTheme();
  const reduce = useReduceMotion();
  const x = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(0);
  useEffect(() => {
    x.setValue(0);
    if (!width || reduce) return undefined;
    const anim = Animated.loop(Animated.timing(x, { toValue: -width, duration: 32_000, easing: Easing.linear, useNativeDriver: true }));
    anim.start();
    return () => anim.stop();
  }, [width, x, reduce]);
  const onLayout = (e: LayoutChangeEvent): void => setWidth(e.nativeEvent.layout.width);
  const strip = (key: string): React.JSX.Element => (
    <View key={key} style={styles.tickerStrip} onLayout={key === 'a' ? onLayout : undefined}>
      {rows.map((r, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <View key={`${key}-${i}`} style={styles.tickerItem}>
          <AppText variant="bodyStrong" weight="700">{r.s}</AppText>
          <AppText variant="body" mono tone="secondary">{r.p}</AppText>
          <AppText variant="body" weight="700" color={r.c >= 0 ? t.colors.bull : t.colors.bear}>
            {`${r.c >= 0 ? '▲' : '▼'} ${Math.abs(r.c).toFixed(2)}%`}
          </AppText>
        </View>
      ))}
    </View>
  );
  return (
    <View style={[styles.ticker, { borderColor: t.colors.borderSubtle, backgroundColor: t.alpha(t.colors.bgCard, 0.6) }]} accessibilityLabel="Live prices">
      <Animated.View style={[styles.tickerTrack, { transform: [{ translateX: x }] }]}>
        {strip('a')}
        {strip('b')}
      </Animated.View>
    </View>
  );
}

/* ── Hero ────────────────────────────────────────────────────────────── */

function Hero({ layout, onRegister, onLogin }: { layout: Layout; onRegister: () => void; onLogin: () => void }): React.JSX.Element {
  const t = useTheme();
  const dark = useAppearance().mode === 'dark';
  const copy = (
    <View style={layout.lg ? styles.half : null}>
      <View style={[styles.badge, { backgroundColor: 'rgba(29,78,216,0.10)', borderColor: 'rgba(29,78,216,0.25)' }]}>
        <AppText variant="smallStrong" color={dark ? t.colors.primaryText : '#1E40AF'}>
          ● Secure &amp; safe · NSE · BSE · MCX · Low fees on trades
        </AppText>
      </View>
      <AppText style={[styles.h1, layout.sm ? styles.h1Sm : null]} accessibilityRole="header">
        {'Trade '}
        <GradientText text="Free" from={BLUE_GRAD[0]} to={BLUE_GRAD[1]} />
        {' Forever'}
      </AppText>
      <View style={[styles.subline, styles.mt8]}>
        <AppText style={[styles.sublineText, layout.sm ? styles.sublineSm : null]}>
          <GradientText text="Always Secure" from={BLUE_GRAD[0]} to={BLUE_GRAD[1]} />
        </AppText>
        <View style={[styles.heroShield, layout.sm ? styles.heroShieldSm : null]}><FeatureIcon name="shield" color="#FFFFFF" /></View>
        <AppText style={[styles.sublineText, layout.sm ? styles.sublineSm : null]}>
          <GradientText text="Always Free" from="#10B981" to="#14B8A6" />
        </AppText>
      </View>
      <AppText style={styles.lead} tone="secondary">
        Your gateway to Indian markets — NSE &amp; BSE stocks, index and stock F&amp;O, and MCX commodities with ultra-low commissions. With live prices, option chains and round-the-clock support, you can learn, practice and trade — simple, secure and built for traders of all levels.
      </AppText>
      <View style={[styles.ctaRow, styles.mt32]}>
        <Pressable accessibilityRole="button" onPress={onRegister} style={({ pressed }) => [styles.ctaPrimary, t.shadow.elevated, { opacity: pressed ? 0.92 : 1 }]}>
          <Gradient from="#2563EB" to="#10B981" id="hero-cta" horizontal />
          <AppText style={styles.ctaText} color="#FFFFFF">Start trading free →</AppText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onLogin}
          style={({ pressed }) => [
            styles.ctaGhost,
            { borderColor: pressed ? t.colors.primary : t.colors.borderDark, backgroundColor: pressed ? t.colors.bgHover : 'transparent' },
          ]}
        >
          <AppText style={styles.ctaText} weight="600" tone="secondary">Sign in</AppText>
        </Pressable>
      </View>
      <View style={[styles.row, styles.mt28]}>
        <View style={styles.avatars}>
          {AVATARS.map((a, i) => (
            <View key={a.src} style={[styles.avatar, { backgroundColor: a.bg, marginLeft: i ? -10 : 0, borderColor: t.colors.surface }]}>
              <Image source={{ uri: a.src }} style={styles.avatarImg} accessibilityLabel="Trader" />
            </View>
          ))}
        </View>
        <View>
          <Stars />
          <AppText variant="body" weight="500" tone="muted">Trusted by traders across India</AppText>
        </View>
      </View>
    </View>
  );

  return (
    <View style={styles.heroWrap}>
      {/* The two soft blobs behind the hero. */}
      <View pointerEvents="none" style={styles.blobBlue}><Glow color="#1D4ED8" opacity={0.18} id="hero-blob-blue" /></View>
      <View pointerEvents="none" style={styles.blobGreen}><Glow color="#00C853" opacity={0.12} id="hero-blob-green" /></View>
      <Container layout={layout} style={[styles.heroInner, layout.lg ? styles.heroRow : null]}>
        {copy}
        <View style={[layout.lg ? styles.half : styles.mt40]}>
          <HeroVisual wide={layout.sm} />
        </View>
      </Container>
    </View>
  );
}

/** Landing.jsx HeroVisual — the NIFTY 50 card, and from 640 up its two floating cards. */
function HeroVisual({ wide }: { wide: boolean }): React.JSX.Element {
  const t = useTheme();
  const reduce = useReduceMotion();
  const a = useLoop(5000, wide && !reduce);
  const b = useLoop(6000, wide && !reduce);
  const floatA = a.interpolate({ inputRange: [0, 1], outputRange: [0, -10] });
  const floatB = b.interpolate({ inputRange: [0, 1], outputRange: [0, 8] });
  return (
    <View>
      <View style={[styles.card, styles.heroCard, t.shadow.elevated, { backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark }]}>
        <View style={[styles.row, styles.between, styles.mb12]}>
          <View style={styles.row}>
            <View style={[styles.nTile, { backgroundColor: t.alpha(t.colors.primary, 0.1) }]}>
              <AppText variant="small" weight="700" color={t.colors.primaryText}>N</AppText>
            </View>
            <View>
              <AppText variant="bodyStrong" weight="700">NIFTY 50</AppText>
              <AppText variant="caption" tone="muted">NSE Index</AppText>
            </View>
          </View>
          <View style={styles.alignEnd}>
            <AppText style={styles.heroPrice} mono>25,870.50</AppText>
            <AppText variant="caption" weight="700" color={t.colors.bull}>+0.62%</AppText>
          </View>
        </View>
        <HeroChart id="hero" />
        <View style={[styles.row, styles.mt12]}>
          <View style={[styles.fakeBtn, { backgroundColor: '#00C853' }]}><AppText variant="bodyStrong" weight="700" color="#FFFFFF">Buy</AppText></View>
          <View style={[styles.fakeBtn, { backgroundColor: '#FF3B57' }]}><AppText variant="bodyStrong" weight="700" color="#FFFFFF">Sell</AppText></View>
        </View>
      </View>
      {wide ? (
        <>
          <Animated.View style={[styles.floatPnl, { transform: [{ translateY: floatA }] }]}>
            <View style={[styles.card, styles.floatCard, t.shadow.elevated, { backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark }]}>
              <AppText variant="micro" weight="600" tone="muted" style={styles.upper}>Today&apos;s P&amp;L</AppText>
              <AppText style={styles.floatPnlValue} color={t.colors.bull}>+₹12,847.20</AppText>
            </View>
          </Animated.View>
          <Animated.View style={[styles.floatFill, { transform: [{ translateY: floatB }] }]}>
            <View style={[styles.card, styles.floatCard, t.shadow.elevated, styles.row, { backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark }]}>
              <View style={[styles.fillCheck, { backgroundColor: t.alpha(t.colors.bull, 0.15) }]}><CheckDot color={t.colors.bull} /></View>
              <View>
                <AppText variant="small" weight="700">Order filled</AppText>
                <AppText variant="micro" tone="muted">NIFTY FUT · 2 lots · market</AppText>
              </View>
            </View>
          </Animated.View>
        </>
      ) : null}
    </View>
  );
}

/* ── Trust badges ────────────────────────────────────────────────────── */

function TrustBadges({ layout }: { layout: Layout }): React.JSX.Element {
  const t = useTheme();
  const cols = layout.lg ? 4 : layout.sm ? 2 : 1;
  const pad = layout.sm ? 24 : 20;
  const cell = Math.floor((layout.inner - pad * 2 - 24 * (cols - 1)) / cols);
  return (
    <Container layout={layout} style={styles.trustSection}>
      <View style={[styles.card, t.shadow.card, { padding: pad, backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark }]}>
        <View style={styles.trustGrid}>
          {BADGES.map((b, i) => (
            <View
              key={b.title}
              style={[
                { width: cell },
                // divide-y on one column; divide-x from lg.
                cols === 1 && i > 0 ? [styles.trustDivTop, { borderTopColor: t.colors.borderSubtle }] : null,
                cols === 4 && i > 0 ? [styles.trustDivLeft, { borderLeftColor: t.colors.borderSubtle }] : null,
              ]}
            >
              <View style={[styles.row, styles.alignTop]}>
                <View style={[styles.badgeIcon, { backgroundColor: `${b.color}15` }]}><FeatureIcon name={b.icon} color={b.color} /></View>
                <View style={styles.flex}>
                  <AppText variant="bodyStrong" weight="700">{b.title}</AppText>
                  <AppText variant="caption" tone="muted" style={styles.mt2}>{b.body}</AppText>
                </View>
              </View>
              <View style={[styles.trustTag, { borderTopColor: t.colors.borderSubtle }]}>
                <AppText variant="caption" weight="600" tone="secondary">{b.tag}</AppText>
              </View>
            </View>
          ))}
        </View>
      </View>
    </Container>
  );
}

/* ── Trade Indian Markets ────────────────────────────────────────────── */

function Markets({ layout, chg }: { layout: Layout; chg: Record<string, number> }): React.JSX.Element {
  const t = useTheme();
  const basis = layout.lg ? 0.21 : layout.md ? 0.3 : layout.sm ? 0.43 : 0.72;
  const cardW = Math.round(layout.inner * basis);
  // The rail's prev / next: they scroll by 80% of its width and fade at each end.
  const rail = useRef<ScrollView>(null);
  const [x, setX] = useState(0);
  const [contentW, setContentW] = useState(0);
  const [viewW, setViewW] = useState(0);
  const canL = x > 4;
  const canR = x < contentW - viewW - 4;
  const scrollByDir = useCallback((dir: 1 | -1): void => {
    const next = Math.max(0, Math.min(contentW - viewW, x + dir * viewW * 0.8));
    rail.current?.scrollTo({ x: next, animated: true });
  }, [contentW, viewW, x]);

  const arrow = (dir: 1 | -1, enabled: boolean): React.JSX.Element => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={dir < 0 ? 'Scroll left' : 'Scroll right'}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      onPress={() => scrollByDir(dir)}
      style={({ pressed }) => [
        styles.arrow,
        t.shadow.elevated,
        dir < 0 ? styles.arrowLeft : styles.arrowRight,
        {
          backgroundColor: '#FFFFFF',
          borderColor: pressed ? t.alpha(t.colors.primary, 0.5) : t.colors.borderDark,
          opacity: enabled ? 1 : 0.4,
        },
      ]}
    >
      {({ pressed }) => (
        <FeatureIcon name={dir < 0 ? 'chevronLeft' : 'chevronRight'} color={pressed ? '#1D4ED8' : '#475569'} size={18} strokeWidth={2.5} />
      )}
    </Pressable>
  );

  return (
    <Container layout={layout} style={styles.marketsSection}>
      <AppText style={styles.h2} align="center" accessibilityRole="header">
        {'Trade '}
        <GradientText text="Indian Markets" from={BLUE_GRAD[0]} to={BLUE_GRAD[1]} />
      </AppText>
      <View style={styles.mt32}>
        <ScrollView
          ref={rail}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.marketRail}
          onScroll={(e) => setX(e.nativeEvent.contentOffset.x)}
          onContentSizeChange={(w) => setContentW(w)}
          onLayout={(e) => setViewW(e.nativeEvent.layout.width)}
          scrollEventThrottle={32}
        >
          {MARKETS.map((m) => {
            const c = marketChange(m, chg);
            return (
              <View
                key={m.name}
                testID="market-card"
                style={[styles.card, styles.marketCard, t.shadow.card, { width: cardW, backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark }]}
              >
                <View style={styles.marketArt}><MarketCluster name={m.name} /></View>
                <View style={[styles.row, styles.center, styles.wrap]}>
                  <AppText variant="bodyStrong" weight="700">{m.name}</AppText>
                  <AppText variant="small" weight="700" color={c >= 0 ? t.colors.bull : t.colors.bear}>{signedPct(c)}</AppText>
                </View>
                <AppText variant="caption" tone="muted" align="center" numberOfLines={1} style={styles.mt2}>{m.desc}</AppText>
              </View>
            );
          })}
        </ScrollView>
        {arrow(-1, canL)}
        {arrow(1, canR)}
      </View>
    </Container>
  );
}

/* ── Professional Trading Platform ───────────────────────────────────── */

const TERM = {
  bg: '#0B1220',
  panel: '#0E1626',
  line: 'rgba(255,255,255,0.08)',
  muted: '#64748B',
} as const;

function Platform({ layout, onRegister }: { layout: Layout; onRegister: () => void }): React.JSX.Element {
  const t = useTheme();
  const column = layout.lg ? (layout.inner - 48) / 2 : layout.inner;
  const pointW = layout.sm ? Math.floor((column - 12) / 2) : undefined;
  return (
    <Container layout={layout} style={[styles.py64, layout.lg ? styles.heroRow : null]}>
      <View style={layout.lg ? styles.half : null}>
        <AppText style={styles.h2} accessibilityRole="header">
          {'Professional Trading '}
          <GradientText text="Platform" from={BLUE_GRAD[0]} to={BLUE_GRAD[1]} />
        </AppText>
        <AppText style={styles.sub} tone="secondary">Powerful tools, advanced charts and real-time data to help you trade smarter and faster.</AppText>
        <View style={[styles.points, styles.mt24]}>
          {PLATFORM_POINTS.map((p) => (
            <View key={p} style={[styles.row, styles.point, pointW ? { width: pointW } : null]}>
              <View style={[styles.checkDot, { backgroundColor: t.alpha(t.colors.bull, 0.15) }]}><CheckDot color={t.colors.bull} /></View>
              <AppText variant="body" tone="secondary">{p}</AppText>
            </View>
          ))}
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onRegister}
          style={({ pressed }) => [styles.ctaSolid, { backgroundColor: pressed ? t.colors.primaryPressed : t.colors.primary }]}
        >
          <AppText style={styles.ctaText} color={t.colors.onPrimary}>Explore Platform →</AppText>
        </Pressable>
      </View>

      {/* Right — the dark terminal mockup (laptop + phone). */}
      <View style={[layout.lg ? styles.half : styles.mt40, styles.mockup, { paddingRight: layout.sm ? 24 : 8 }]}>
        <View style={[styles.laptop, t.shadow.elevated]}>
          <View style={styles.chrome}>
            {['#FF5F57', '#FEBC2E', '#28C840'].map((c) => <View key={c} style={[styles.termDot, { backgroundColor: c }]} />)}
            <Text style={styles.chromeLabel}>EquityHub Terminal</Text>
          </View>
          <View style={styles.termBody}>
            <View style={[styles.termPanel, styles.flex]}>
              <View style={[styles.row, styles.between, styles.gap4]}>
                <View style={styles.termQuote}>
                  <Text style={styles.termSym}>NIFTY</Text>
                  <Text style={styles.termPx}>25,870.50</Text>
                  <Text style={styles.termChg}>+0.62%</Text>
                </View>
                {layout.sm ? (
                  <View style={styles.termOhlc}>
                    {['O 25,712', 'H 25,904', 'L 25,688'].map((s) => <Text key={s} style={styles.termTiny}>{s}</Text>)}
                  </View>
                ) : null}
              </View>
              <HeroChart id="terminal" />
            </View>
            <View style={[styles.termPanel, styles.orderPanel]}>
              <View style={styles.row2}>
                <Text style={[styles.orderTab, { backgroundColor: '#16A34A', color: '#FFFFFF' }]}>Buy</Text>
                <Text style={[styles.orderTab, { backgroundColor: 'rgba(239,68,68,0.16)', color: '#F87171' }]}>Sell</Text>
              </View>
              {['Amount', 'Price', 'SL', 'TP'].map((l) => (
                <View key={l} style={styles.orderField}>
                  <Text style={styles.orderFieldLabel}>{l}</Text>
                  <View style={styles.orderFieldBar} />
                </View>
              ))}
              <View style={styles.placeOrder}>
                <Gradient from="#2563EB" to="#3B82F6" id="place-order" horizontal />
                <Text style={styles.placeOrderText}>Place Order</Text>
              </View>
            </View>
          </View>
          <View style={styles.positionsWrap}>
            <View style={styles.positions}>
              <Text style={styles.positionsHead}>Open Positions</Text>
              {TERMINAL_POSITIONS.map((r, i) => (
                <View key={r[0]} style={[styles.positionRow, i < TERMINAL_POSITIONS.length - 1 ? styles.positionLine : null]}>
                  <Text style={styles.positionSym}>{r[0]}</Text>
                  <Text style={[styles.positionSide, { backgroundColor: `${r[2]}22`, color: r[2] }]}>{r[1]}</Text>
                  <Text style={styles.termTiny}>{r[4]}</Text>
                  <Text style={[styles.positionPnl, { color: r[2] }]}>{r[3]}</Text>
                </View>
              ))}
            </View>
          </View>
        </View>
        {/* laptop base / hinge */}
        <View style={styles.hinge} />
        <View style={styles.hingeFoot} />
        {/* phone in front */}
        <View style={[styles.phone, t.shadow.elevated, { right: layout.sm ? 8 : 0 }]}>
          <View style={[styles.row, styles.between, styles.phoneHead]}>
            <Text style={styles.phoneSym}>NIFTY</Text>
            <Text style={styles.termChgSmall}>+0.62%</Text>
          </View>
          <View style={styles.phoneChart}><HeroChart id="phone" /></View>
          <View style={[styles.row2, styles.phoneBtns]}>
            <Text style={[styles.phoneBtn, { backgroundColor: '#16A34A' }]}>Buy</Text>
            <Text style={[styles.phoneBtn, { backgroundColor: '#EF4444' }]}>Sell</Text>
          </View>
        </View>
      </View>
    </Container>
  );
}

/* ── Your Assets. Protected Around The Clock ─────────────────────────── */

function ProtectedBanner({ layout }: { layout: Layout }): React.JSX.Element {
  const itemCols = layout.sm && !layout.lg ? 4 : 2;
  return (
    <Container layout={layout} style={styles.protectedSection}>
      <View style={[styles.protected, { padding: layout.sm ? 40 : 24 }]}>
        {/* radial-gradient(120% 140% at 12% 18%, #16223B 0%, #0B1220 55%, #070C18 100%) */}
        <FillSvg>
          <Defs>
            <RadialGradient id="protected-bg" cx="12%" cy="18%" rx="120%" ry="140%" fx="12%" fy="18%">
              <Stop offset="0" stopColor="#16223B" />
              <Stop offset="0.55" stopColor="#0B1220" />
              <Stop offset="1" stopColor="#070C18" />
            </RadialGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" fill="url(#protected-bg)" />
        </FillSvg>
        <View pointerEvents="none" style={styles.protectedGlowL}><Glow color="#3B82F6" opacity={0.28 * 0.6} id="protected-glow-l" /></View>
        <View pointerEvents="none" style={styles.protectedGlowR}><Glow color="#2563EB" opacity={0.3 * 0.4} id="protected-glow-r" /></View>
        <View style={styles.center}><ShieldArt /></View>
        <AppText style={styles.protectedTitle} color="#FFFFFF" align="center">{'Your Assets.\nProtected Around The Clock'}</AppText>
        <AppText variant="body" color="rgba(255,255,255,0.68)" align="center" style={styles.mt8}>
          We use industry-leading security measures — cold storage, SSL encryption and 2FA protection — to ensure your assets are always safe with us.
        </AppText>
        <View style={styles.secGrid}>
          {SECURITY.map((it) => (
            <View key={it.title} style={[styles.secItem, { width: `${100 / itemCols}%` }]}>
              <View style={styles.secIcon}><FeatureIcon name={it.icon} color="#60A5FA" size={20} /></View>
              <AppText variant="small" weight="700" color="#FFFFFF" align="center">{it.title}</AppText>
              <AppText variant="micro" color="rgba(255,255,255,0.5)" align="center" style={styles.mt2}>{it.sub}</AppText>
            </View>
          ))}
        </View>
      </View>
    </Container>
  );
}

/* ── How It Works ────────────────────────────────────────────────────── */

function Steps({ layout }: { layout: Layout }): React.JSX.Element {
  const t = useTheme();
  const cell = gridCell(layout, 20);
  return (
    <View style={{ backgroundColor: t.alpha(t.colors.bgCard, 0.4), borderTopWidth: 1, borderBottomWidth: 1, borderColor: t.colors.borderSubtle }}>
      <Container layout={layout} style={layout.sm ? styles.py56 : styles.py48}>
        <SectionHead eyebrow="Get started" title="How It Works" sub="From sign-up to your first trade in minutes." />
        <View style={[styles.grid, styles.gridSteps]}>
          {STEPS.map((s, i) => {
            const st = STEP_STYLES[i] ?? STEP_STYLES[0];
            return (
              <View
                key={s.n}
                style={[styles.card, t.shadow.card, { width: cell, padding: layout.sm ? 28 : 24, backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark }]}
              >
                <View style={styles.stepIcon}>
                  <GradTile icon={st.icon} size={56} radius={16} colors={st.g} shadow={st.sh} shine iconSize={26} id={`step-${s.n}`} />
                  <View style={[styles.stepNum, t.shadow.card, { borderColor: t.colors.borderSubtle }]}>
                    <AppText variant="caption" weight="800" color={st.accent}>{s.n}</AppText>
                  </View>
                </View>
                <AppText style={styles.cardTitle}>{s.title}</AppText>
                <AppText style={[styles.cardBody, styles.mt8]} tone="secondary">{s.body}</AppText>
                {layout.lg && i < STEPS.length - 1 ? (
                  <View style={styles.connector}><FeatureIcon name="chevronRight" color={t.alpha(t.colors.textMuted, 0.5)} size={18} strokeWidth={2.5} /></View>
                ) : null}
              </View>
            );
          })}
        </View>
      </Container>
    </View>
  );
}

/* ── Why Traders Love EquityHub ──────────────────────────────────────── */

function Testimonials({ layout }: { layout: Layout }): React.JSX.Element {
  const t = useTheme();
  const cols = layout.lg ? 3 : layout.sm ? 2 : 1;
  const cell = Math.floor((layout.inner - 20 * (cols - 1)) / cols);
  return (
    <Container layout={layout} style={layout.sm ? styles.py80 : styles.py64}>
      <View style={styles.head}>
        <View style={styles.lovedPill}>
          <Heart color="#4F46E5" />
          <AppText variant="smallStrong" weight="700" color="#4F46E5">Loved by thousands of traders</AppText>
        </View>
        <AppText style={[styles.h2Big, layout.sm ? styles.h2BigSm : null]} align="center" accessibilityRole="header">Why Traders Love EquityHub</AppText>
        <AppText style={styles.sub} tone="secondary" align="center">Join thousands of traders who trust EquityHub every day.</AppText>
      </View>
      <View style={[styles.grid, styles.gridTestimonials]}>
        {TESTIMONIALS.map((p, i) => {
          const b = BENEFITS[i];
          return (
            <View
              key={p.name}
              style={[styles.card, t.shadow.card, styles.testimonial, { width: cell, padding: layout.sm ? 28 : 24, backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark }]}
            >
              <View style={styles.row}>
                <View style={[styles.personAvatar, { backgroundColor: t.alpha(t.colors.primary, 0.1) }]}>
                  <AppText variant="body" weight="700" color={t.colors.primaryText}>{p.init}</AppText>
                  <Image source={{ uri: p.img }} style={StyleSheet.absoluteFill} accessibilityLabel={p.name} />
                </View>
                <View>
                  <AppText style={styles.personName}>{p.name}</AppText>
                  <AppText variant="small" tone="muted">{p.role}</AppText>
                </View>
              </View>
              <View style={styles.mt16}><Stars size={16} /></View>
              <AppText style={[styles.cardBody, styles.mt16, styles.flexGrow]} tone="secondary">{`"${p.quote}"`}</AppText>
              {b ? (
                <View style={[styles.benefitWrap, { borderTopColor: t.colors.borderSubtle }]}>
                  <View style={[styles.benefit, { backgroundColor: b.tint }]}>
                    <GradTile icon={b.icon} size={44} radius={12} colors={b.g} shadow={b.sh} shine id={`benefit-${b.icon}`} />
                    <View style={styles.flex}>
                      <AppText variant="bodyStrong" weight="700">{b.title}</AppText>
                      <AppText style={styles.benefitBody} tone="secondary">{b.body}</AppText>
                    </View>
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    </Container>
  );
}

/* ── Final call to action ────────────────────────────────────────────── */

function FinalCta({ layout, onRegister }: { layout: Layout; onRegister: () => void }): React.JSX.Element {
  return (
    <Container layout={layout} style={styles.py32}>
      <View style={[styles.finalCta, layout.md ? styles.finalRow : null, { paddingHorizontal: layout.sm ? 40 : 24, paddingVertical: layout.sm ? 36 : 32 }]}>
        <Gradient stops={[[0, '#2563EB'], [0.45, '#3B82F6'], [1, '#10B981']]} id="final-cta" horizontal />
        <FinalShine />
        <View style={layout.md ? styles.flex : null}>
          <AppText style={[styles.finalTitle, layout.sm ? styles.finalTitleSm : null]} color="#FFFFFF" align={layout.md ? 'left' : 'center'}>
            Ready To Start Your Trading Journey?
          </AppText>
          <AppText style={[styles.finalSub, layout.sm ? styles.finalSubSm : null]} color="rgba(255,255,255,0.88)" align={layout.md ? 'left' : 'center'}>
            Trade Smart. Invest Better. Grow with EquityHub.
          </AppText>
        </View>
        <Pressable accessibilityRole="button" onPress={onRegister} style={({ pressed }) => [styles.finalBtn, { opacity: pressed ? 0.92 : 1 }]}>
          <AppText style={styles.ctaText} color="#0F172A">Start Trading Free →</AppText>
        </Pressable>
      </View>
    </Container>
  );
}

/** `radial-gradient(120% 120% at 15% 10%, rgba(255,255,255,.35), transparent 55%)` at 25%. */
function FinalShine(): React.JSX.Element {
  return (
    <FillSvg>
      <Defs>
        <RadialGradient id="final-shine" cx="15%" cy="10%" rx="120%" ry="120%" fx="15%" fy="10%">
          <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.35 * 0.25} />
          <Stop offset="0.55" stopColor="#FFFFFF" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#final-shine)" />
    </FillSvg>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  flexGrow: { flexGrow: 1 },
  stickyHeader: { zIndex: 1, borderBottomWidth: 1 },
  topShadow: { boxShadow: '0 4px 18px rgba(15,23,42,0.08)' },
  container: { alignSelf: 'center', maxWidth: MAX_W, width: '100%' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  row2: { flexDirection: 'row', gap: 4 },
  wrap: { flexWrap: 'wrap' },
  between: { justifyContent: 'space-between' },
  center: { alignItems: 'center', justifyContent: 'center' },
  centered: { alignItems: 'center' },
  alignEnd: { alignItems: 'flex-end' },
  alignTop: { alignItems: 'flex-start' },
  gap4: { gap: 4 },
  upper: { textTransform: 'uppercase', letterSpacing: 0.6 },
  mt2: { marginTop: 2 },
  mt8: { marginTop: 8 },
  mt12: { marginTop: 12 },
  mt16: { marginTop: 16 },
  mt24: { marginTop: 24 },
  mt28: { marginTop: 28 },
  mt32: { marginTop: 32 },
  mt40: { marginTop: 40 },
  mb12: { marginBottom: 12 },
  mb16: { marginBottom: 16 },
  py32: { paddingVertical: 32 },
  py48: { paddingVertical: 48 },
  py56: { paddingVertical: 56 },
  py64: { paddingVertical: 64 },
  py80: { paddingVertical: 80 },
  half: { flex: 1, minWidth: 0 },

  // Type — the web's sizes.
  h1: { fontSize: 40, lineHeight: 43, fontWeight: '800', letterSpacing: -0.8 },
  h1Sm: { fontSize: 56, lineHeight: 60 },
  subline: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  sublineText: { fontSize: 24, lineHeight: 30, fontWeight: '800', letterSpacing: -0.4 },
  sublineSm: { fontSize: 36, lineHeight: 40 },
  lead: { fontSize: 18, lineHeight: 28, marginTop: 20 },
  h2: { fontSize: 30, lineHeight: 36, fontWeight: '800', letterSpacing: -0.5 },
  h2Big: { fontSize: 36, lineHeight: 40, fontWeight: '800', letterSpacing: -0.6 },
  h2BigSm: { fontSize: 48, lineHeight: 52 },
  eyebrow: { fontSize: 12, lineHeight: 16, fontWeight: '700', letterSpacing: 0.6, marginBottom: 8 },
  sub: { fontSize: 16, lineHeight: 24, marginTop: 12 },
  cardTitle: { fontSize: 16, lineHeight: 24, fontWeight: '700' },
  cardBody: { fontSize: 14, lineHeight: 22, marginTop: 6 },
  ctaText: { fontSize: 16, lineHeight: 22, fontWeight: '700' },

  head: { alignItems: 'center', alignSelf: 'center', maxWidth: 672 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 40 },
  gridSteps: { gap: 20, marginTop: 36 },
  gridTestimonials: { gap: 20, marginTop: 48, alignItems: 'stretch' },
  card: { borderWidth: 1, borderRadius: 12 },

  // Ticker
  ticker: { borderTopWidth: 1, borderBottomWidth: 1, paddingVertical: 12, overflow: 'hidden' },
  tickerTrack: { flexDirection: 'row' },
  tickerStrip: { flexDirection: 'row' },
  tickerItem: { flexDirection: 'row', alignItems: 'center', gap: 8, marginRight: 32 },

  // Hero
  heroWrap: { position: 'relative', overflow: 'hidden' },
  heroInner: { paddingTop: 32, paddingBottom: 24 },
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: 48 },
  blobBlue: { position: 'absolute', top: -96, right: -96, width: 480, height: 480 },
  blobGreen: { position: 'absolute', top: 160, left: -128, width: 420, height: 420 },
  badge: { alignSelf: 'flex-start', borderRadius: 6, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2, marginBottom: 20 },
  heroShield: { width: 32, height: 32, borderRadius: 12, backgroundColor: '#1D4ED8', alignItems: 'center', justifyContent: 'center' },
  heroShieldSm: { width: 40, height: 40 },
  ctaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  ctaPrimary: { borderRadius: 8, paddingHorizontal: 28, paddingVertical: 14, overflow: 'hidden' },
  ctaGhost: { borderRadius: 8, paddingHorizontal: 28, paddingVertical: 13, borderWidth: 1 },
  ctaSolid: { alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 28, paddingVertical: 14, marginTop: 32 },
  avatars: { flexDirection: 'row' },
  avatar: { width: 32, height: 32, borderRadius: 16, borderWidth: 2, overflow: 'hidden' },
  avatarImg: { width: '100%', height: '100%' },
  heroCard: { padding: 20, zIndex: 10 },
  nTile: { width: 32, height: 32, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  heroPrice: { fontSize: 16, lineHeight: 22, fontWeight: '700' },
  fakeBtn: { flex: 1, alignItems: 'center', borderRadius: 8, paddingVertical: 10 },
  floatPnl: { position: 'absolute', left: -24, bottom: 40, zIndex: 20 },
  floatFill: { position: 'absolute', right: -16, top: 24, zIndex: 20 },
  floatCard: { paddingHorizontal: 16, paddingVertical: 12 },
  floatPnlValue: { fontSize: 18, lineHeight: 26, fontWeight: '800' },
  fillCheck: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },

  // Trust badges
  trustSection: { paddingTop: 8, paddingBottom: 24 },
  trustGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 24 },
  trustDivTop: { borderTopWidth: 1, paddingTop: 20 },
  trustDivLeft: { borderLeftWidth: 1, paddingLeft: 20 },
  badgeIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  trustTag: { marginTop: 10, paddingTop: 8, borderTopWidth: 1 },

  // Markets
  marketsSection: { paddingTop: 64, paddingBottom: 16 },
  marketRail: { gap: 12, paddingBottom: 4 },
  marketCard: { padding: 16, alignItems: 'center' },
  marketArt: { height: 48, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  arrow: {
    position: 'absolute',
    top: '50%',
    marginTop: -20,
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  arrowLeft: { left: 0 },
  arrowRight: { right: 0 },

  // Platform
  points: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  point: { gap: 10 },
  checkDot: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  mockup: { position: 'relative', paddingBottom: 48 },
  laptop: { borderRadius: 12, overflow: 'hidden', backgroundColor: TERM.bg, borderWidth: 1, borderColor: '#1E293B' },
  chrome: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 28, backgroundColor: TERM.panel, borderBottomWidth: 1, borderBottomColor: TERM.line },
  chromeLabel: { marginLeft: 8, fontSize: 9, fontWeight: '600', color: TERM.muted },
  termDot: { width: 10, height: 10, borderRadius: 5 },
  termBody: { flexDirection: 'row', gap: 8, padding: 10 },
  termPanel: { backgroundColor: TERM.panel, borderWidth: 1, borderColor: TERM.line, borderRadius: 8, padding: 8 },
  termQuote: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  termSym: { fontSize: 11, fontWeight: '700', color: '#FFFFFF' },
  termPx: { fontSize: 11, fontWeight: '700', color: '#22C55E' },
  termChg: { fontSize: 9, fontWeight: '700', color: '#22C55E' },
  termChgSmall: { fontSize: 7, fontWeight: '700', color: '#22C55E' },
  termOhlc: { flexDirection: 'row', gap: 6 },
  termTiny: { fontSize: 7, color: TERM.muted },
  orderPanel: { width: 86, padding: 6, gap: 4 },
  orderTab: { flex: 1, textAlign: 'center', fontSize: 8, fontWeight: '700', borderRadius: 4, paddingVertical: 4, overflow: 'hidden' },
  orderField: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: TERM.bg,
    borderWidth: 1,
    borderColor: TERM.line,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  orderFieldLabel: { fontSize: 6.5, color: TERM.muted },
  orderFieldBar: { width: 20, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.14)' },
  placeOrder: { marginTop: 'auto', borderRadius: 4, paddingVertical: 6, overflow: 'hidden', alignItems: 'center' },
  placeOrderText: { fontSize: 8, fontWeight: '700', color: '#FFFFFF' },
  positionsWrap: { paddingHorizontal: 10, paddingBottom: 10 },
  positions: { backgroundColor: TERM.panel, borderWidth: 1, borderColor: TERM.line, borderRadius: 8, overflow: 'hidden' },
  positionsHead: { paddingHorizontal: 8, paddingVertical: 4, fontSize: 8, fontWeight: '700', color: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: TERM.line },
  positionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, paddingVertical: 4 },
  positionLine: { borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  positionSym: { width: 56, fontSize: 8, fontWeight: '600', color: '#E2E8F0' },
  positionSide: { fontSize: 7, fontWeight: '700', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, overflow: 'hidden' },
  positionPnl: { fontSize: 8, fontWeight: '700' },
  hinge: { height: 10, width: '82%', alignSelf: 'center', backgroundColor: '#1E293B', borderBottomLeftRadius: 6, borderBottomRightRadius: 6 },
  hingeFoot: { height: 4, width: '34%', alignSelf: 'center', backgroundColor: 'rgba(30,41,59,0.7)', borderBottomLeftRadius: 8, borderBottomRightRadius: 8 },
  phone: {
    position: 'absolute',
    bottom: -8,
    width: 96,
    borderRadius: 21,
    borderWidth: 4,
    borderColor: '#1E293B',
    backgroundColor: TERM.bg,
    overflow: 'hidden',
  },
  phoneHead: { paddingHorizontal: 8, paddingTop: 8, paddingBottom: 4 },
  phoneSym: { fontSize: 8, fontWeight: '700', color: '#FFFFFF' },
  phoneChart: { paddingHorizontal: 4 },
  phoneBtns: { padding: 6 },
  phoneBtn: { flex: 1, textAlign: 'center', fontSize: 8, fontWeight: '700', color: '#FFFFFF', borderRadius: 4, paddingVertical: 4, overflow: 'hidden' },

  // Protected
  protectedSection: { paddingBottom: 64 },
  protected: { borderRadius: 16, overflow: 'hidden', gap: 8, boxShadow: '0 8px 28px rgba(17,24,39,0.12)' },
  protectedGlowL: { position: 'absolute', left: -40, top: '50%', marginTop: -144, width: 288, height: 288 },
  protectedGlowR: { position: 'absolute', right: -64, bottom: -64, width: 288, height: 288 },
  protectedTitle: { fontSize: 24, lineHeight: 30, fontWeight: '800', marginTop: 8 },
  secGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 20, marginTop: 24 },
  secItem: { alignItems: 'center', paddingHorizontal: 6 },
  secIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
    backgroundColor: 'rgba(59,130,246,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(96,165,250,0.25)',
  },

  // Steps
  stepIcon: { width: 56, height: 56, marginBottom: 20 },
  stepNum: {
    position: 'absolute',
    top: -8,
    right: -8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  connector: { position: 'absolute', top: '50%', right: -13, marginTop: -9, zIndex: 10 },

  // Testimonials
  lovedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginBottom: 16,
    backgroundColor: 'rgba(99,102,241,0.10)',
  },
  testimonial: { flexDirection: 'column' },
  personAvatar: { width: 48, height: 48, borderRadius: 24, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  personName: { fontSize: 15, lineHeight: 20, fontWeight: '700' },
  benefitWrap: { marginTop: 24, paddingTop: 20, borderTopWidth: 1 },
  benefit: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, borderRadius: 12, padding: 12 },
  benefitBody: { fontSize: 12, lineHeight: 16, marginTop: 2 },

  // Final CTA
  finalCta: { borderRadius: 16, overflow: 'hidden', alignItems: 'center', gap: 24 },
  finalRow: { flexDirection: 'row', justifyContent: 'space-between' },
  finalTitle: { fontSize: 24, lineHeight: 30, fontWeight: '800' },
  finalTitleSm: { fontSize: 30, lineHeight: 36 },
  finalSub: { fontSize: 14, lineHeight: 20, fontWeight: '500', marginTop: 8 },
  finalSubSm: { fontSize: 16, lineHeight: 24 },
  finalBtn: { backgroundColor: '#FFFFFF', borderRadius: 12, paddingHorizontal: 28, paddingVertical: 14 },
});
