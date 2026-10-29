import { useTheme } from '@/theme';

/**
 * The order panel's own palette — OrderForm.jsx:1185-1211, value for value.
 *
 * The web's order form does not use the app tokens for its surfaces; it keeps
 * a light and a dark set of its own (the trading terminal's look) and flips
 * between them with the theme. The accents stay the same in both modes. The
 * palette follows the app's applied theme here exactly as it follows the
 * web's theme store.
 */
export interface OrderPalette {
  pageBg: string;
  cardBg: string;
  cardBg2: string;
  border: string;
  text: string;
  dim: string;
  muted: string;
  sell: string;
  sellHi: string;
  buy: string;
  buyHi: string;
}

export const ORDER_PALETTE: { dark: OrderPalette; light: OrderPalette } = {
  dark: {
    pageBg: '#131A29',
    cardBg: '#1A2235',
    cardBg2: '#1F2A40',
    border: '#2A3548',
    text: '#F8FAFC',
    dim: '#94A3B8',
    muted: '#64748B',
    sell: '#EF4444',
    sellHi: '#F87171',
    buy: '#22C55E',
    buyHi: '#4ADE80',
  },
  light: {
    pageBg: '#F8FAFC',
    cardBg: '#FFFFFF',
    cardBg2: '#F1F5F9',
    border: '#E5E7EB',
    text: '#0F172A',
    dim: '#64748B',
    muted: '#94A3B8',
    sell: '#EF4444',
    sellHi: '#F87171',
    buy: '#22C55E',
    buyHi: '#4ADE80',
  },
};

/** Stock Tailwind shades the form uses by value (amber notices, orange banners, slate CTA). */
export const ORDER_TONES = {
  amberBg: 'rgba(245,158,11,0.12)',
  amberBorder: 'rgba(245,158,11,0.40)',
  amberText: '#d97706',
  /** The Trading-disabled banner (rose). */
  disabled: '#E11D48',
  disabledBg: 'rgba(225,29,72,0.10)',
  orange: '#EA580C',
  orangeBg: 'rgba(234,88,12,0.10)',
  sellBg: 'rgba(229,102,85,0.08)',
  instrumentPillBg: 'rgba(245,158,11,0.12)',
  instrumentPillText: '#B45309',
  demoPillBg: 'rgba(16,185,129,0.12)',
  demoPillText: '#047857',
  slate: '#94A3B8',
  activeModeBg: 'rgba(59,130,246,0.08)',
  white: '#FFFFFF',
  onActiveDim: 'rgba(255,255,255,0.85)',
} as const;

export const useOrderPalette = (): OrderPalette => {
  const t = useTheme();
  return t.isDark ? ORDER_PALETTE.dark : ORDER_PALETTE.light;
};
