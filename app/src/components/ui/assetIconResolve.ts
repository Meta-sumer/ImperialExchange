/**
 * Which icon an instrument gets — the decision half of
 * client/src/components/AssetIcon.jsx, kept apart from the drawing so it can
 * be tested without rendering SVG.
 *
 * The order of the checks is the web's, and it matters: an admin logo beats
 * everything, a known coin beats the category, a commodity code beats a
 * FOREX category, and so on.
 */

/** Bases with an icon in atomiclabs/cryptocurrency-icons — AssetIcon.jsx:24-30. */
export const CRYPTO_LIST = new Set([
  'btc', 'eth', 'sol', 'xrp', 'doge', 'ada', 'bnb', 'avax', 'matic', 'link',
  'ltc', 'uni', 'aave', 'atom', 'dot', 'trx', 'shib', 'near', 'algo', 'fil',
  'apt', 'op', 'arb', 'sui', 'mkr', 'comp', 'snx', 'crv', 'sand', 'mana',
  'icp', 'etc', 'bch', 'xlm', 'xmr', 'xtz', 'vet', 'fet', 'hbar', 'rune',
  'inj', 'imx', 'grt', 'egld', 'ftm', 'axs', 'sushi', 'enj', 'knc', 'yfi',
]);

export const CRYPTO_CDN = 'https://cdn.jsdelivr.net/gh/atomiclabs/cryptocurrency-icons@0.18.1/svg/color/';

export type CommodityIcon = 'gold' | 'silver' | 'copper' | 'oil' | 'gas';

/** AssetIcon.jsx:195-201. */
const COMMODITY_ICONS: Record<string, CommodityIcon> = {
  XAU: 'gold', GOLD: 'gold', GOLDM: 'gold',
  XAG: 'silver', SILVER: 'silver', SILVERM: 'silver',
  WTI: 'oil', BRENT: 'oil', USOIL: 'oil', OIL: 'oil', CRUDEOIL: 'oil',
  NGAS: 'gas', GAS: 'gas', NATURALGAS: 'gas',
  COPPER: 'copper', COP: 'copper',
};

/** Text tiles for commodities without a drawn icon — AssetIcon.jsx:205-212. */
const COMMODITY: Record<string, { glyph: string; bg: string }> = {
  WHEAT: { glyph: 'WHE', bg: '#A16207' },
  CORN: { glyph: 'COR', bg: '#CA8A04' },
  ZINC: { glyph: 'Zn', bg: '#64748B' },
  ALUMINIUM: { glyph: 'Al', bg: '#94A3B8' },
  LEAD: { glyph: 'Pb', bg: '#475569' },
  NICKEL: { glyph: 'Ni', bg: '#6B7280' },
};

/** Global indices keep their short text glyph — AssetIcon.jsx:214-223. */
const INDEX: Record<string, { glyph: string; bg: string }> = {
  NAS100: { glyph: 'NQ', bg: '#0EA5E9' },
  US30: { glyph: 'DJ', bg: '#475569' },
  SPX500: { glyph: 'SP', bg: '#22C55E' },
  GER40: { glyph: 'DAX', bg: '#1F2937' },
  UK100: { glyph: 'FT', bg: '#7C3AED' },
  JPN225: { glyph: 'N', bg: '#DC2626' },
  HK50: { glyph: 'HK', bg: '#EA580C' },
  AUS200: { glyph: 'AU', bg: '#0EA5E9' },
};

export type TilePair = readonly [string, string];

/** AssetIcon.jsx:236-241. */
const TILE_PALETTE: readonly TilePair[] = [
  ['#2563EB', '#1E40AF'], ['#7C3AED', '#5B21B6'], ['#0891B2', '#155E75'],
  ['#16A34A', '#15803D'], ['#EA580C', '#C2410C'], ['#DB2777', '#9D174D'],
  ['#0D9488', '#115E59'], ['#CA8A04', '#92600A'], ['#DC2626', '#991B1B'],
  ['#4F46E5', '#3730A3'], ['#0EA5E9', '#0369A1'], ['#9333EA', '#6B21A8'],
];

/** AssetIcon.jsx:243-247. */
const INDEX_TINT: Record<string, TilePair> = {
  NIFTY: ['#2563EB', '#1E40AF'],
  BANKNIFTY: ['#7C3AED', '#5B21B6'],
  FINNIFTY: ['#0D9488', '#115E59'],
  MIDCPNIFTY: ['#EA580C', '#C2410C'],
  SENSEX: ['#DC2626', '#991B1B'],
};

/**
 * The same tile colour for the same key, every time — AssetIcon.jsx:248-252
 * verbatim, so NIFTY is the same blue on the web and here.
 */
export const tileColor = (key: string): TilePair => {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return TILE_PALETTE[h % TILE_PALETTE.length] ?? TILE_PALETTE[0]!;
};

/** AssetIcon.jsx:344. */
const QUOTE_SUFFIXES = ['USDT', 'USDC', 'USD', 'BUSD', 'INR', 'EUR', 'GBP', 'JPY', 'AUD', 'BTC', 'ETH'];
const BY_LENGTH = [...QUOTE_SUFFIXES].sort((a, b) => b.length - a.length);

/**
 * The base currency of a symbol that did not carry one: strip a known quote
 * suffix, longest first (so BTCUSDT loses USDT, not USD) — AssetIcon.jsx:346-357.
 */
export const inferBaseFromSymbol = (sym: string | null | undefined): string => {
  if (!sym) return '';
  const upper = sym.toUpperCase().replace(/[/\-_.]/g, '');
  for (const suf of BY_LENGTH) {
    if (upper.endsWith(suf) && upper.length > suf.length) {
      return upper.slice(0, upper.length - suf.length);
    }
  }
  return upper;
};

export interface AssetIconInput {
  symbol?: string | null;
  category?: string | null;
  baseCurrency?: string | null;
  quoteCurrency?: string | null;
  underlying?: string | null;
  logoUrl?: string | null;
}

export type AssetIconSpec =
  | { kind: 'logo'; uri: string }
  | { kind: 'crypto'; coin: string; uri: string; fallbackGlyph: string }
  | { kind: 'commodity'; icon: CommodityIcon }
  | { kind: 'forex'; base: string; quote: string }
  | { kind: 'indexGlyph'; colors: TilePair }
  | { kind: 'stockGlyph'; colors: TilePair }
  | { kind: 'tile'; glyph: string; bg: string };

const up = (v: string | null | undefined): string => String(v ?? '').toUpperCase();

/**
 * Decide the icon. `logoFailed` is set once an admin logo has failed to
 * load, so the generated icon takes over — as the web's onError does.
 */
export const resolveAssetIcon = (input: AssetIconInput, logoFailed = false): AssetIconSpec => {
  const sym = up(input.symbol);
  const cat = up(input.category);
  const quote = up(input.quoteCurrency);
  let base = up(input.baseCurrency);
  if (!base) base = inferBaseFromSymbol(sym);
  // F&O rows carry the underlying — the colour key, so every NIFTY contract
  // shares one tile colour whatever its expiry or strike.
  const under = up(input.underlying);

  const logo = input.logoUrl ?? null;
  if (logo && !logoFailed) return { kind: 'logo', uri: logo };

  if (base) {
    const lower = base.toLowerCase();
    if (CRYPTO_LIST.has(lower) && (cat === 'CRYPTO' || cat === '' || cat === 'OTHER')) {
      return { kind: 'crypto', coin: lower, uri: `${CRYPTO_CDN}${lower}.svg`, fallbackGlyph: lower.slice(0, 3).toUpperCase() };
    }
  }

  const commodity = COMMODITY_ICONS[under] ?? COMMODITY_ICONS[base] ?? COMMODITY_ICONS[sym];
  if ((cat === 'COMMODITY' || commodity) && commodity) {
    return { kind: 'commodity', icon: commodity };
  }

  if (cat === 'FOREX' && base && quote) return { kind: 'forex', base, quote };

  if (cat === 'INDEX' && !INDEX[sym]) {
    const colorKey = under || base || sym;
    return { kind: 'indexGlyph', colors: INDEX_TINT[colorKey] ?? INDEX_TINT[under] ?? tileColor(colorKey) };
  }

  if (cat === 'STOCK') return { kind: 'stockGlyph', colors: tileColor(under || base || sym) };

  // Use the resolved BASE for the fallback so BTCUSD shows "BTC" rather
  // than "BT", which reads as a country code.
  const fallbackGlyph = under && under.length >= 3
    ? under.slice(0, 3)
    : base.length >= 3
      ? base.slice(0, 3)
      : base || sym.slice(0, 2) || '?';
  const meta = COMMODITY[under] ?? COMMODITY[base] ?? COMMODITY[sym] ?? INDEX[sym]
    ?? { glyph: fallbackGlyph, bg: '#475569' };
  return { kind: 'tile', glyph: meta.glyph, bg: meta.bg };
};
