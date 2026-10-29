/**
 * The landing page's copy and its two pieces of live arithmetic —
 * client/src/pages/Landing.jsx, verbatim. No React: the strings and the
 * rules are pinned against the web's own source (authScreens.logic.test).
 */
import type { Instrument } from '@/types/trading';
import { fmtNum } from '@/utils/money';

/* ── Live feed (public /instruments/watchlist) ───────────────────────── */

export interface TickerRow {
  s: string;
  p: string;
  c: number;
}

/**
 * Landing.jsx TICKER — the static showcase (illustrative INR levels), shown
 * only while the live feed loads or when it cannot be reached.
 */
export const TICKER: readonly TickerRow[] = [
  { s: 'NIFTY', p: '25,870.50', c: +0.62 },
  { s: 'BANKNIFTY', p: '58,214.35', c: +0.48 },
  { s: 'SENSEX', p: '84,562.78', c: +0.57 },
  { s: 'RELIANCE', p: '1,482.60', c: +1.12 },
  { s: 'HDFCBANK', p: '986.45', c: -0.34 },
  { s: 'TCS', p: '3,128.90', c: -0.71 },
  { s: 'INFY', p: '1,548.20', c: +0.86 },
  { s: 'CRUDEOIL', p: '5,342.00', c: -0.45 },
  { s: 'GOLD', p: '1,21,850.00', c: +0.64 },
];

/** How often the page re-reads the feed (Landing.jsx: `setInterval(load, 10000)`). */
export const LIVE_MS = 10_000;

/**
 * Landing.jsx Ticker — the feed as ticker rows: priced rows only, the first
 * 14, the price at the instrument's precision (capped at 5), the 24h change
 * or 0 without one.
 */
export const tickerRows = (rows: readonly Instrument[]): TickerRow[] =>
  rows
    .filter((x) => Number(x.lastPrice) > 0)
    .slice(0, 14)
    .map((x) => {
      const c = Number(x.change24h);
      return {
        s: x.symbol,
        p: fmtNum(Number(x.lastPrice), Math.min(x.pricePrecision || 2, 5)),
        c: Number.isFinite(c) ? c : 0,
      };
    });

type FeedRow = Pick<Instrument, 'category' | 'segment' | 'exchange' | 'change24h'>;

const segOf = (x: FeedRow): string => String(x.segment || '').toUpperCase();
const catOf = (x: FeedRow): string => String(x.category || '').toUpperCase();
const isMcx = (x: FeedRow): boolean => String(x.exchange || '').toUpperCase() === 'MCX' || catOf(x) === 'COMMODITY';

export interface MarketCard {
  name: 'Stocks' | 'Index F&O' | 'Stock Options' | 'Commodities';
  desc: string;
  /** The static fallback % while the feed loads or when a card has no live data. */
  c: number;
  /** The feed rows whose average 24h change the card shows. */
  match: (x: FeedRow) => boolean;
}

/**
 * Landing.jsx MARKETS. Options are not in the public feed, so Stock Options
 * averages the stock futures, as the web does, as a proxy for the F&O
 * stock universe.
 */
export const MARKETS: readonly MarketCard[] = [
  { name: 'Stocks', desc: 'NSE & BSE equities', c: +0.62, match: (x) => catOf(x) === 'STOCK' && segOf(x) !== 'FUT' && segOf(x) !== 'OPT' },
  { name: 'Index F&O', desc: 'NIFTY, BANKNIFTY, SENSEX', c: +0.42, match: (x) => catOf(x) === 'INDEX' },
  { name: 'Stock Options', desc: 'Option chains on F&O stocks', c: +0.38, match: (x) => catOf(x) === 'STOCK' && segOf(x) === 'FUT' },
  { name: 'Commodities', desc: 'Crude oil, gold, silver, natural gas', c: +0.42, match: isMcx },
];

/**
 * Landing.jsx Markets — each card's live average 24h change over the rows
 * its `match` picks. A row without a 24h baseline (null change) is left
 * out, not counted as a zero; a card with no live rows is absent from the
 * answer and keeps its static `c`.
 */
export const marketChanges = (rows: readonly FeedRow[]): Record<string, number> => {
  const live = rows.filter((x) => x.change24h != null && Number.isFinite(Number(x.change24h)));
  const out: Record<string, number> = {};
  for (const m of MARKETS) {
    const vals = live.filter(m.match).map((x) => Number(x.change24h));
    if (vals.length) out[m.name] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  return out;
};

/** The % a market card shows: the live average, else its static fallback. */
export const marketChange = (m: Pick<MarketCard, 'name' | 'c'>, chg: Readonly<Record<string, number>>): number => {
  const live = chg[m.name];
  return typeof live === 'number' && Number.isFinite(live) ? live : m.c;
};

/** `+0.62%` / `-0.45%` — Landing.jsx's card and ticker figure. */
export const signedPct = (c: number): string => `${c >= 0 ? '+' : ''}${c.toFixed(2)}%`;

/* ── Copy ────────────────────────────────────────────────────────────── */

export const FEATURES = [
  { icon: 'bolt', title: 'Lightning execution', body: 'Ultra-low-latency matching engine fills your orders in milliseconds, even at peak volume.' },
  { icon: 'chart', title: 'Pro charting', body: '100+ indicators, full TradingView-style drawing tools and multi-chart layouts.' },
  { icon: 'copy', title: 'Copy trading', body: 'Mirror top traders automatically — set your allocation and let it run.' },
  { icon: 'shield', title: 'Bank-grade security', body: '2FA, encrypted sessions and segregated funds keep your capital protected.' },
  { icon: 'coins', title: 'Low brokerage', body: 'Transparent, low charges across stocks, F&O and commodities.' },
  { icon: 'support', title: '24/7 support', body: 'Real humans, round the clock, in chat and helpdesk whenever you need them.' },
  { icon: 'risk', title: 'Risk management', body: 'Built-in stop-loss, take-profit and margin alerts to protect your capital.' },
  { icon: 'phone', title: 'Mobile trading', body: 'Full-featured apps on iOS and Android — trade and monitor on the go.' },
] as const;

export const BADGES = [
  { icon: 'shield', color: '#3B82F6', title: 'Bank-level Security', body: 'Your funds and data are always protected with top-tier security.', tag: 'Across all markets' },
  { icon: 'bolt', color: '#22C55E', title: 'Indian Market Access', body: 'NSE & BSE stocks, F&O and MCX commodities from one account.', tag: 'NSE · BSE · MCX' },
  { icon: 'percent', color: '#F59E0B', title: 'Low Trading Fees', body: 'Enjoy ultra-low fees and keep more of what you earn.', tag: 'Transparent pricing' },
  { icon: 'support', color: '#8B5CF6', title: '24/7 Live Support', body: 'Our support team is always here to help you succeed.', tag: 'Reliable & secure' },
] as const;

/** The "Trusted by traders across India" faces (a tinted circle stands in when one fails). */
export const AVATARS = [
  { src: 'https://i.pravatar.cc/80?img=12', bg: '#60A5FA' },
  { src: 'https://i.pravatar.cc/80?img=45', bg: '#F472B6' },
  { src: 'https://i.pravatar.cc/80?img=32', bg: '#34D399' },
  { src: 'https://i.pravatar.cc/80?img=5', bg: '#FBBF24' },
] as const;

export const WHY = [
  { icon: 'globe', title: 'Indian Market Access', body: 'Trade NSE & BSE stocks, index and stock F&O, and MCX commodities — all from one account.' },
  { icon: 'bolt', title: 'Lightning-Fast Execution', body: 'Orders filled in milliseconds by a low-latency engine, even during peak volume.' },
  { icon: 'coins', title: 'Zero Hidden Fees', body: 'Transparent pricing with no surprise charges. What you see is what you pay.' },
  { icon: 'lock', title: '256-bit Encryption', body: 'Bank-grade encryption and 2FA keep your account and funds fully protected.' },
  { icon: 'rupee', title: '₹0 Free to Start', body: 'No signup fees and a free demo balance to practice risk-free before going live.' },
  { icon: 'clock', title: 'Always-On Platform', body: 'Charts, watchlists and your account available any time — trade live during exchange hours.' },
  { icon: 'grid', title: 'Live Option Chains', body: 'Option chains for NIFTY, BANKNIFTY, SENSEX, F&O stocks and MCX commodities.' },
  { icon: 'deposit', title: 'Instant Deposits & Withdrawals', body: 'Fund and cash out quickly with multiple secure payment methods.' },
] as const;

export const BUILT = [
  { icon: 'coins', title: 'Spot Trading', body: 'Buy and sell your favourite assets instantly.' },
  { icon: 'chart', title: 'Advanced Charts', body: 'Pro tools with real-time data and market depth.' },
  { icon: 'shield', title: 'Safe & Reliable', body: 'Industry-leading security you can depend on.' },
  { icon: 'bolt', title: 'Quick Execution', body: 'Fast order execution with zero delays.' },
] as const;

export const STEPS = [
  { n: '1', title: 'Create Account', body: 'Sign up in under two minutes — instant demo balance, no paperwork.' },
  { n: '2', title: 'Verify Identity', body: 'Quick KYC unlocks real-money trading and fast withdrawals.' },
  { n: '3', title: 'Deposit Funds', body: 'Top up securely with your preferred payment method.' },
  { n: '4', title: 'Start Trading', body: 'Trade NSE & BSE stocks, F&O and MCX commodities with pro tools, copy trading and live analytics.' },
] as const;

/** Landing.jsx Steps STEP_STYLES — each step's own gradient, shadow and accent. */
export const STEP_STYLES = [
  { icon: 'user', g: ['#818CF8', '#6366F1'], sh: 'rgba(99,102,241,0.42)', accent: '#6366F1' },
  { icon: 'verify', g: ['#34D399', '#10B981'], sh: 'rgba(16,185,129,0.42)', accent: '#059669' },
  { icon: 'wallet', g: ['#FBBF24', '#F97316'], sh: 'rgba(249,115,22,0.42)', accent: '#EA580C' },
  { icon: 'trend', g: ['#22D3EE', '#3B82F6'], sh: 'rgba(37,99,235,0.42)', accent: '#2563EB' },
] as const;

export const TESTIMONIALS = [
  { name: 'Rahul Sharma', role: 'Professional Trader', init: 'RS', img: 'https://i.pravatar.cc/96?img=13', quote: 'EquityHub is by far the best platform I have used. The execution speed and low fees are unmatched — I have moved all my trading here.' },
  { name: 'Sarah Williams', role: 'Options Trader', init: 'SW', img: 'https://i.pravatar.cc/96?img=47', quote: 'I trade NIFTY and BANKNIFTY options every week and this is the fastest, most reliable terminal I have come across. Highly recommended.' },
  { name: 'Michael Chen', role: 'Day Trader', init: 'MC', img: 'https://i.pravatar.cc/96?img=33', quote: 'The platform is super fast and reliable. I can trade anywhere, anytime, on any device, without any interruptions.' },
] as const;

/** Landing.jsx Testimonials BENEFITS — one under each testimonial. */
export const BENEFITS = [
  {
    icon: 'gift', title: 'Free to Start', body: 'No signup fees, no platform charges, and a free demo balance to practice risk-free.',
    g: [[0, '#F472B6'], [0.45, '#FB7185'], [1, '#F59E0B']], sh: 'rgba(251,113,133,0.40)', tint: 'rgba(251,113,133,0.08)',
  },
  {
    icon: 'clock', title: '24/7 Access', body: 'Charts, your account and live support available round the clock.',
    g: [[0, '#22D3EE'], [0.5, '#3B82F6'], [1, '#6366F1']], sh: 'rgba(59,130,246,0.40)', tint: 'rgba(59,130,246,0.08)',
  },
  {
    icon: 'shield', title: 'Forever Trustable', body: 'Bank-grade encryption, 2FA, segregated funds and 99.98% uptime.',
    g: [[0, '#34D399'], [0.5, '#10B981'], [1, '#059669']], sh: 'rgba(16,185,129,0.40)', tint: 'rgba(16,185,129,0.08)',
  },
] as const;

/** Landing.jsx ProtectedBanner items (SecIcon names: shield → the banner's own tick-shield). */
export const SECURITY = [
  { icon: 'card', title: 'Secure Payments', sub: 'Trusted deposit & withdrawal channels' },
  { icon: 'lock', title: 'SSL Encryption', sub: 'Bank-level 256-bit SSL' },
  { icon: 'secShield', title: 'Two-Factor Auth', sub: 'Extra layer on your account' },
  { icon: 'audit', title: 'Regular Audits', sub: 'Continuous security checks' },
] as const;

/** Landing.jsx Platform `points`. */
export const PLATFORM_POINTS = ['Real-time market data', 'One-click trading', 'Advanced charting tools', 'Smart portfolio management'] as const;

/** The terminal mockup's open positions (Landing.jsx Platform). */
export const TERMINAL_POSITIONS = [
  ['RELIANCE', 'BUY', '#22C55E', '+1.12%', '10'],
  ['HDFCBANK', 'BUY', '#22C55E', '+0.86%', '15'],
  ['CRUDEOIL', 'SELL', '#EF4444', '-0.80%', '1 lot'],
] as const;

/** LandingHeader NAV, in its order. */
export const NAV = [
  ['Features', 'features'],
  ['Markets', 'markets'],
  ['Platform', 'platform'],
  ['How it works', 'how'],
] as const;
