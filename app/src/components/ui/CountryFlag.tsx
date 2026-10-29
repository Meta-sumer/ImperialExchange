import React, { useState } from 'react';
import { Image, PixelRatio, type StyleProp, type ImageStyle } from 'react-native';

/**
 * A country flag from flagcdn.com, ported from client/src/components/CountryFlag.jsx.
 *
 * The web chose a CDN PNG over emoji because Windows has no flag emoji. A
 * phone has them — but Android renders some vendors' flags badly and the
 * web's forex tiles are built around this exact image, so the same source
 * keeps the two apps' icons identical.
 *
 * Accepts `country` (ISO 3166-1 alpha-2) or `currency` (ISO 4217, mapped).
 */

/** CountryFlag.jsx:15-20, verbatim. */
export const CCY_TO_COUNTRY: Record<string, string> = {
  USD: 'us', EUR: 'eu', GBP: 'gb', JPY: 'jp', CHF: 'ch',
  AUD: 'au', NZD: 'nz', CAD: 'ca', INR: 'in', CNY: 'cn',
  SGD: 'sg', HKD: 'hk', TRY: 'tr', BRL: 'br', RUB: 'ru',
  KRW: 'kr', ZAR: 'za', MXN: 'mx', SEK: 'se', NOK: 'no',
};

// flagcdn serves alpha-2 filenames only, so a three-letter code (IND, USA)
// 404s and the flag silently disappears. Map the common alpha-3 codes, and
// fall back to the currency when the country still doesn't resolve — an admin
// who types "IND"/"INR" gets the Indian flag either way. Plain truncation is
// NOT safe here: AUT (Austria) would become AU (Australia). (CountryFlag.jsx)
const ALPHA3_TO_ALPHA2: Record<string, string> = {
  USA: 'us', GBR: 'gb', DEU: 'de', FRA: 'fr', ITA: 'it', ESP: 'es',
  JPN: 'jp', CHN: 'cn', IND: 'in', AUS: 'au', NZL: 'nz', CAN: 'ca',
  CHE: 'ch', SGP: 'sg', HKG: 'hk', KOR: 'kr', BRA: 'br', RUS: 'ru',
  ZAF: 'za', MEX: 'mx', TUR: 'tr', SWE: 'se', NOR: 'no', AUT: 'at',
  NLD: 'nl', BEL: 'be', IRL: 'ie', POL: 'pl', ARE: 'ae', SAU: 'sa',
};

/** The flag code for a country or a currency, or '' when there is none. */
export const flagCode = (country?: string | null, currency?: string | null): string => {
  const raw = String(country || '').trim().toUpperCase();
  if (raw.length === 2) return raw.toLowerCase();
  if (ALPHA3_TO_ALPHA2[raw]) return ALPHA3_TO_ALPHA2[raw];
  if (currency) return CCY_TO_COUNTRY[String(currency).toUpperCase()] ?? '';
  return '';
};

export function CountryFlag({
  country,
  currency,
  width = 20,
  style,
}: {
  country?: string | null;
  currency?: string | null;
  width?: number;
  style?: StyleProp<ImageStyle>;
}): React.JSX.Element | null {
  const [failed, setFailed] = useState(false);
  const code = flagCode(country, currency);
  if (!code || failed) return null;
  const h = Math.round(width * 0.75);
  // The web's srcSet offers w40 and w80 (2x); pick by the device density.
  const size = PixelRatio.getPixelSizeForLayoutSize(width) > 40 ? 'w80' : 'w40';
  return (
    <Image
      source={{ uri: `https://flagcdn.com/${size}/${code}.png` }}
      accessibilityLabel={country ?? currency ?? undefined}
      // onError hides the image on the web (visibility:hidden); unmounting
      // is the RN equivalent and keeps the broken-image box off screen.
      onError={() => setFailed(true)}
      resizeMode="cover"
      style={[{ width, height: h, borderRadius: 2 }, style]}
    />
  );
}
