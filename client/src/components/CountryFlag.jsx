/**
 * <CountryFlag /> — renders a country flag PNG from flagcdn.com.
 *
 * Why an <img> and not an emoji? Windows ships without the regional-
 * indicator emoji set, so emoji flags fall back to the two-letter ISO
 * code on most Windows browsers. A CDN-served PNG renders identically on
 * macOS, Windows, Linux, iOS and Android. flagcdn.com is free and
 * aggressively cached by browsers.
 *
 * Accepts either:
 *   • `country` — ISO 3166-1 alpha-2 code (US, GB, EU, JP, …)
 *   • `currency` — ISO 4217 code (USD, GBP, EUR, JPY, …) which we map.
 */

const CCY_TO_COUNTRY = {
  USD: 'us',  EUR: 'eu',  GBP: 'gb',  JPY: 'jp',  CHF: 'ch',
  AUD: 'au',  NZD: 'nz',  CAD: 'ca',  INR: 'in',  CNY: 'cn',
  SGD: 'sg',  HKD: 'hk',  TRY: 'tr',  BRL: 'br',  RUB: 'ru',
  KRW: 'kr',  ZAR: 'za',  MXN: 'mx',  SEK: 'se',  NOK: 'no',
};

// flagcdn serves alpha-2 filenames only, so a three-letter code (IND, USA)
// 404s and the flag silently disappears. Map the common alpha-3 codes, and
// fall back to the row's currency when the country still doesn't resolve —
// an admin who types "IND"/"INR" gets the Indian flag either way. Plain
// truncation is NOT safe here: AUT (Austria) would become AU (Australia).
const ALPHA3_TO_ALPHA2 = {
  USA: 'us', GBR: 'gb', DEU: 'de', FRA: 'fr', ITA: 'it', ESP: 'es',
  JPN: 'jp', CHN: 'cn', IND: 'in', AUS: 'au', NZL: 'nz', CAN: 'ca',
  CHE: 'ch', SGP: 'sg', HKG: 'hk', KOR: 'kr', BRA: 'br', RUS: 'ru',
  ZAF: 'za', MEX: 'mx', TUR: 'tr', SWE: 'se', NOR: 'no', AUT: 'at',
  NLD: 'nl', BEL: 'be', IRL: 'ie', POL: 'pl', ARE: 'ae', SAU: 'sa',
};

const resolveCode = (country, currency) => {
  const raw = String(country || '').trim().toUpperCase();
  if (raw.length === 2) return raw.toLowerCase();
  if (ALPHA3_TO_ALPHA2[raw]) return ALPHA3_TO_ALPHA2[raw];
  return CCY_TO_COUNTRY[String(currency || '').toUpperCase()] || '';
};

export default function CountryFlag({ country, currency, width = 20, className = '' }) {
  const code = resolveCode(country, currency);
  if (!code) return null;
  const h = Math.round(width * 0.75);
  return (
    <img
      src={`https://flagcdn.com/w40/${code}.png`}
      srcSet={`https://flagcdn.com/w80/${code}.png 2x`}
      width={width}
      height={h}
      alt={country || currency}
      loading="lazy"
      className={`inline-block rounded-sm align-middle ${className}`}
      style={{ objectFit: 'cover' }}
      onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
    />
  );
}
