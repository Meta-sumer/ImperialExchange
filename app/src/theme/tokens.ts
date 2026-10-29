import {
  alpha,
  brand,
  cardShadow,
  font,
  palette,
  radius as baseRadius,
  type ThemeColors,
  type ThemeMode,
} from '@/constants/theme';

/**
 * The runtime theme object every component reads through `useTheme()`.
 *
 * constants/theme.ts holds the two palettes transcribed from index.css; this
 * file adds what the UI kit needs on top — spacing, the type scale, shadows,
 * the layer scale — and a small set of SEMANTIC colours so a component asks
 * for "the header surface" rather than re-deriving which hex the web's
 * `bg-white` turns into in dark mode.
 */

/**
 * Stock Tailwind colours the chrome uses by name. Not tokens on the web
 * (plain utility classes), so there is nowhere else to take them from.
 */
export const tw = {
  /** DEMO chip — Layout.jsx:528 `bg-amber-100 text-amber-700`. */
  amber100: '#FEF3C7',
  amber700: '#B45309',
  /** LIVE chip — Layout.jsx:528 `bg-emerald-100 text-emerald-700`. */
  emerald100: '#D1FAE5',
  emerald700: '#047857',
  /** The avatar's "online" dot — Layout.jsx:460. */
  green600: '#16A34A',
  /** ImpersonationBanner.jsx gradient. */
  impersonationFrom: '#B45309',
  impersonationTo: '#92400E',
  /** btn-bull / btn-bear hover shades — index.css. */
  bullPressed: '#00A847',
  bearPressed: '#E62E48',
  /** Fallback asset tile — AssetIcon.jsx. */
  slate600: '#475569',
} as const;

/**
 * The avatar gradient — Layout.jsx:449, inline so it survives the web's
 * light-mode text overrides. Theme-independent.
 */
export const avatarGradient = ['#3B82F6', '#1D4ED8', '#1E3A8A'] as const;

/** tailwind spacing is 4px per step; these are the steps the web actually uses. */
export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  /** Page side gutter — Layout.jsx:706 `px-4` on phones. */
  gutter: 16,
  /** Page top/bottom padding — Layout.jsx:706 `py-6`. */
  page: 24,
} as const;

/** tailwind.config.js:57-63 plus the stock `rounded-2xl` (1rem) the modals use. */
export const radius = {
  ...baseRadius,
  xxl: 16,
} as const;

/**
 * Tailwind's type scale with its paired line heights. The web uses
 * arbitrary 10px and 11px sizes heavily (`text-[10px]`), so they are steps
 * here too.
 */
export const text = {
  micro: { fontSize: 10, lineHeight: 14 },
  caption: { fontSize: 11, lineHeight: 15 },
  xs: { fontSize: 12, lineHeight: 16 },
  sm: { fontSize: 14, lineHeight: 20 },
  base: { fontSize: 16, lineHeight: 24 },
  lg: { fontSize: 18, lineHeight: 28 },
  xl: { fontSize: 20, lineHeight: 28 },
  xxl: { fontSize: 24, lineHeight: 32 },
  xxxl: { fontSize: 30, lineHeight: 36 },
} as const;

/** tailwind.config.js:64-68, per-platform. */
export const shadow = {
  card: cardShadow,
  /** `shadow-elevated` — menus, the profile dropdown. */
  elevated: {
    shadowColor: '#111827',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 14,
    elevation: 8,
  },
  /** `shadow-2xl` — the modal panel. */
  modal: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.25,
    shadowRadius: 24,
    elevation: 16,
  },
  none: {
    shadowColor: 'transparent',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
} as const;

/**
 * client/src/components/modalLayers.js, verbatim, plus the two layers the
 * web leaves to libraries: react-hot-toast's container and the impersonation
 * banner (both 9999 on the web).
 */
export const Z = {
  dropdown: 100,
  tooltip: 200,
  menu: 300,
  drawer: 500,
  modal: 1000,
  critical: 1100,
  toast: 9998,
  banner: 9999,
} as const;

export interface SemanticColors {
  primary: string;
  primaryPressed: string;
  /** Active nav text — `text-primary-600`. */
  primaryText: string;
  /** Active nav wash — `bg-primary-500/10`. */
  primarySoft: string;
  onPrimary: string;
  bull: string;
  bear: string;
  bullSoft: string;
  bearSoft: string;
  warn: string;
  info: string;
  /**
   * The chrome surface. The web paints the header, the page and the modal
   * panel `bg-white`, and index.css:139 remaps every `bg-white` to the card
   * colour in dark mode — so this is white in light and bgCard in dark.
   */
  surface: string;
  /** Modal backdrop — `bg-black/50`. */
  overlay: string;
  /** Skeleton block. */
  skeleton: string;
}

export type AppColors = ThemeColors & SemanticColors;

export interface AppTheme {
  mode: ThemeMode;
  isDark: boolean;
  colors: AppColors;
  brand: typeof brand;
  tw: typeof tw;
  space: typeof space;
  radius: typeof radius;
  text: typeof text;
  shadow: typeof shadow;
  z: typeof Z;
  font: typeof font;
  alpha: typeof alpha;
}

const semantic = (mode: ThemeMode, base: ThemeColors): SemanticColors => ({
  primary: brand.primary500,
  primaryPressed: brand.primary600,
  // The web keeps primary-600 in dark mode too, which is #1E40AF on #161B22
  // — a contrast ratio under 2:1. The lighter step is the one readable blue.
  primaryText: mode === 'dark' ? brand.primary400 : brand.primary600,
  primarySoft: alpha(brand.primary500, mode === 'dark' ? 0.2 : 0.1),
  onPrimary: brand.white,
  bull: brand.bull,
  bear: brand.bear,
  bullSoft: alpha(brand.bull, 0.1),
  bearSoft: alpha(brand.bear, 0.1),
  warn: brand.warn,
  info: brand.info,
  surface: mode === 'dark' ? base.bgCard : '#FFFFFF',
  overlay: 'rgba(0,0,0,0.5)',
  skeleton: base.bgHover,
});

/** Build the theme for a mode. Pure; memoised by the provider. */
export const buildTheme = (mode: ThemeMode): AppTheme => {
  const base = palette[mode];
  return {
    mode,
    isDark: mode === 'dark',
    colors: { ...base, ...semantic(mode, base) },
    brand,
    tw,
    space,
    radius,
    text,
    shadow,
    z: Z,
    font,
    alpha,
  };
};

/** Both themes, built once — a theme switch swaps a reference, not a rebuild. */
export const themes: Record<ThemeMode, AppTheme> = {
  light: buildTheme('light'),
  dark: buildTheme('dark'),
};
