/**
 * The design tokens, ported from client/tailwind.config.js and
 * client/src/index.css.
 *
 * ── WHY THE VALUES LIVE HERE AS HEX ───────────────────────────────────
 * The web resolves its surface colours through CSS custom properties —
 * `rgb(var(--color-bg-card) / <alpha-value>)` — and flips the whole app by
 * setting `data-theme` on <html>. There is no cascade in React Native, so
 * the two `:root` blocks in index.css (light at :14, dark at :29) are
 * transcribed here as two complete palettes and selected in JS instead.
 *
 * Every number below is copied from the web source. Nothing is eyeballed.
 * ──────────────────────────────────────────────────────────────────────
 */

/* ── Brand ────────────────────────────────────────────────────────────
 * tailwind.config.js:10-40. These are theme-independent on the web (plain
 * hex there, not CSS variables), so they are theme-independent here too.
 */
export const brand = {
  primary50: '#EFF6FF',
  primary100: '#DBEAFE',
  primary200: '#BFDBFE',
  primary300: '#93C5FD',
  primary400: '#3B82F6',
  /** primary-500 — dark royal blue, THE brand colour. */
  primary500: '#1D4ED8',
  primary600: '#1E40AF',
  primary700: '#1E3A8A',
  primary800: '#172554',
  primary900: '#0F172A',

  /**
   * `teal-accent` is a LEGACY ALIAS that now resolves to the same blue as
   * primary-500 (tailwind.config.js:31-34). The auth pages use it heavily for
   * links, so it keeps its own name rather than being silently rewritten to
   * primary500 — if the web ever un-aliases it, one line changes here instead
   * of thirty call sites.
   */
  tealAccent: '#1D4ED8',
  tealDark: '#1E3A8A',

  bull: '#00C853',
  bear: '#FF3B57',
  /** Re-tinted to blue in the redesign — it is NOT amber any more. */
  warn: '#3B82F6',
  info: '#3B82F6',

  white: '#FFFFFF',
} as const;

/**
 * The three Tailwind defaults the password-strength meter needs
 * (Register.jsx:341 uses bg-bear, bg-orange-500, bg-amber-400, bg-lime-500,
 * bg-bull). They are stock Tailwind on the web so no token exists for them;
 * without them the meter has no colours at all.
 */
export const meterColors = {
  orange500: '#F97316',
  amber400: '#FBBF24',
  lime500: '#84CC16',
} as const;

/* ── Surfaces ─────────────────────────────────────────────────────────── */

const lightColors = {
  /**
   * Page background. `--color-bg-dark` is WHITE in light mode — the name is
   * historical (the app was dark first) and is kept so a reader can grep
   * `bg-bg-dark` in the web source and land here.
   */
  bgDark: '#FFFFFF',
  bgCard: '#F8F9FB',
  bgPanel: '#F8F9FB',
  bgHover: '#F3F4F6',
  bgSidebar: '#FFFFFF',

  borderDark: '#D1D5DB',
  borderSubtle: '#E5E7EB',

  textPrimary: '#0F172A',
  textSecondary: '#1F2937',
  textMuted: '#4B5563',

  /**
   * ── THE COMPAT GROUP, AND WHY IT IS NOT DECORATION ──────────────────
   * The auth pages were authored against the original DARK theme and still
   * hard-code `text-white` and `text-gray-300/400/500`. index.css:88-97 does
   * not leave those alone: in LIGHT mode it overrides each one with
   * `!important` so they stay readable on white —
   *
   *   text-white    → rgb(15 23 42)     text-gray-400 → rgb(31 41 55)
   *   text-gray-300 → rgb(17 24 39)     text-gray-500 → rgb(55 65 81)
   *
   * Porting those classes as literal Tailwind greys would put near-white
   * text on a white card: invisible. So light mode carries the OVERRIDDEN
   * values and dark mode carries the stock ones, which is exactly what the
   * browser computes in each theme.
   */
  compatWhite: '#0F172A',
  compatGray200: '#0F172A',
  compatGray300: '#111827',
  compatGray400: '#1F2937',
  compatGray500: '#374151',

  /** `.input` is literally `bg-white`, not a token (index.css:195). */
  inputBg: '#FFFFFF',
} as const;

/**
 * The KEYS are the contract, not the values.
 *
 * `typeof lightColors` would carry light mode's literal hexes into the type,
 * so `darkColors` could not hold a different colour for the same token — the
 * whole point of having two palettes. Widening the values to `string` keeps
 * the useful half of the check: a token missing from either palette, or a
 * typo in its name, is still a compile error.
 */
export type ThemeColors = { readonly [K in keyof typeof lightColors]: string };

const darkColors: ThemeColors = {
  bgDark: '#0D1117',
  bgCard: '#161B22',
  bgPanel: '#1E242C',
  bgHover: '#2A313A',
  bgSidebar: '#11151B',

  borderDark: '#30363D',
  borderSubtle: '#21262D',

  textPrimary: '#F0F6FC',
  textSecondary: '#ADB5BF',
  textMuted: '#7D8590',

  // Dark mode leaves the hard-coded classes alone — index.css:87: "in dark
  // mode they're left alone so light-on-dark works as authored" — so these
  // are the stock Tailwind values.
  compatWhite: '#FFFFFF',
  compatGray200: '#E5E7EB',
  compatGray300: '#D1D5DB',
  compatGray400: '#9CA3AF',
  compatGray500: '#6B7280',

  // index.css:139 remaps every hard-coded `bg-white` surface onto the dark
  // card colour in dark mode, so the input follows.
  inputBg: '#161B22',
} as const;

export type ThemeMode = 'light' | 'dark';

export const palette: Record<ThemeMode, ThemeColors> = {
  light: lightColors,
  dark: darkColors,
};

/**
 * Light, matching store/theme.js:11 — `readInitial()` returns 'light' when
 * nothing is saved, and index.css:1-3 records that the dark variant was
 * retired for everything but the trading terminal.
 */
export const DEFAULT_THEME_MODE: ThemeMode = 'light';

// The palette to RENDER with is not chosen here. Screens call useTheme() /
// makeStyles from '@/theme', which follow store/theme (the applied mode, which
// store/tradeSettings sets from a 'system' intent too). A module-level
// `colors` constant here would always
// be the light palette and silently ignore dark mode, so there is none.

/**
 * A translucent colour.
 *
 * Tailwind writes these as `bg-bull/15`; RN has no such syntax, so the alpha
 * is appended as the 8-digit hex the platform does understand. Kept as a
 * function so the call site still reads as "bull at 15%".
 */
export const alpha = (hex: string, fraction: number): string => {
  const clamped = Math.max(0, Math.min(1, fraction));
  const byte = Math.round(clamped * 255).toString(16).padStart(2, '0');
  return `${hex}${byte}`;
};

/** tailwind.config.js:57-63. */
export const radius = {
  sm: 6,
  md: 8,
  lg: 10,
  xl: 14,
  full: 999,
} as const;

/**
 * tailwind.config.js:64-68 `shadow-card`, translated to the per-platform
 * props RN honours. A two-layer CSS box-shadow has no direct equivalent: iOS
 * takes the offset/opacity/radius, Android takes an elevation that
 * approximates the same lift.
 */
export const cardShadow = {
  shadowColor: '#111827',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.07,
  shadowRadius: 6,
  elevation: 2,
} as const;

/**
 * index.css:68-70 and tailwind.config.js:52-55. The families are loaded from
 * Google Fonts on the web; until they are bundled here `undefined` means the
 * platform default, which is the right fallback — naming a font the device
 * does not have silently changes metrics instead.
 */
export const font: { sans: string | undefined; mono: string | undefined } = {
  sans: undefined,
  /** `.font-mono` — the 2FA, referral and OTP fields all use it. */
  mono: undefined,
};

export const typeScale = {
  /** `.label` — text-xs, uppercase, tracking-wider, font-medium. */
  label: { fontSize: 12, letterSpacing: 0.6, fontWeight: '500' as const },
  /** `.input` — text-sm. */
  input: { fontSize: 14 },
  body: { fontSize: 14 },
  small: { fontSize: 12 },
  tiny: { fontSize: 11 },
} as const;
