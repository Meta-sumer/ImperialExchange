import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  Line,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
  SvgAst,
  Text as SvgText,
  parse,
  type JsxAST,
} from 'react-native-svg';

import { useTheme } from '@/theme';

import {
  resolveAssetIcon,
  type AssetIconInput,
  type CommodityIcon,
  type TilePair,
} from './assetIconResolve';
import { CountryFlag } from './CountryFlag';

/**
 * An instrument's icon, ported from client/src/components/AssetIcon.jsx.
 *
 *   • admin logo URL   → that image (falls back if it fails to load)
 *   • CRYPTO           → the coin's SVG from the cryptocurrency-icons CDN
 *   • COMMODITY        → a drawn icon: gold bars, silver / copper coins, an
 *                        oil drop, a blue gas flame
 *   • FOREX            → two overlapping country flags (base, quote)
 *   • INDEX / STOCK    → a white chart glyph on a gradient tile whose colour
 *                        is derived from the underlying
 *   • anything else    → a coloured tile with a short text glyph
 *
 * The decision lives in assetIconResolve.ts; this file only draws. Every
 * SVG below is the web's, path for path.
 */
export interface AssetIconProps extends AssetIconInput {
  /** An instrument-like row; explicit props win over its fields. */
  row?: AssetIconInput | null;
  size?: number;
  round?: boolean;
}

function GoldIcon({ size }: { size: number }): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40">
      <Defs>
        <LinearGradient id="face" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%" stopColor="#FFE17F" />
          <Stop offset="45%" stopColor="#E8B923" />
          <Stop offset="100%" stopColor="#8B6914" />
        </LinearGradient>
        <LinearGradient id="top" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%" stopColor="#FFF4C2" />
          <Stop offset="100%" stopColor="#F4C430" />
        </LinearGradient>
        <LinearGradient id="side" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0%" stopColor="#A67C00" />
          <Stop offset="100%" stopColor="#6B5410" />
        </LinearGradient>
      </Defs>
      <Ellipse cx="20" cy="34.5" rx="17" ry="1.6" fill="rgba(0,0,0,0.18)" />
      <Path d="M2.5 23 L18.5 23 L17 33 L5 33 Z" fill="url(#face)" stroke="#5C4500" strokeWidth={0.5} />
      <Path d="M5 19 L17 19 L18.5 23 L2.5 23 Z" fill="url(#top)" stroke="#5C4500" strokeWidth={0.5} />
      <Line x1="7" y1="20.5" x2="15" y2="20.5" stroke="#FFF8D6" strokeWidth={0.5} opacity={0.7} />
      <Path d="M21.5 23 L37.5 23 L35 33 L23 33 Z" fill="url(#face)" stroke="#5C4500" strokeWidth={0.5} />
      <Path d="M23 19 L35 19 L37.5 23 L21.5 23 Z" fill="url(#top)" stroke="#5C4500" strokeWidth={0.5} />
      <Path d="M37.5 23 L35 33 L33.5 32.6 L36 22.8 Z" fill="url(#side)" opacity={0.7} />
      <Line x1="25" y1="20.5" x2="33" y2="20.5" stroke="#FFF8D6" strokeWidth={0.5} opacity={0.7} />
      <Path d="M11 9 L29 9 L27 19 L13 19 Z" fill="url(#face)" stroke="#5C4500" strokeWidth={0.5} />
      <Path d="M13 4 L27 4 L29 9 L11 9 Z" fill="url(#top)" stroke="#5C4500" strokeWidth={0.5} />
      <SvgText x="20" y="7.5" textAnchor="middle" fontSize="3" fontWeight="800" fill="#5C4500">999.9</SvgText>
      <Line x1="15" y1="14" x2="25" y2="14" stroke="#FFF8D6" strokeWidth={0.4} opacity={0.5} />
    </Svg>
  );
}

function CoinIcon({ size, stops, ring, ink, glyph }: {
  size: number;
  stops: [string, string, string];
  ring: string;
  ink: string;
  glyph: string;
}): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40">
      <Defs>
        <RadialGradient id="coin" cx="35%" cy="35%" r="75%">
          <Stop offset="0%" stopColor={stops[0]} />
          <Stop offset="45%" stopColor={stops[1]} />
          <Stop offset="100%" stopColor={stops[2]} />
        </RadialGradient>
      </Defs>
      <Circle cx="20" cy="20" r="19" fill="url(#coin)" stroke={ring} strokeWidth={1} />
      <Circle cx="20" cy="20" r="14" fill="none" stroke={ring} strokeWidth={0.6} opacity={0.45} />
      <SvgText x="20" y="25" textAnchor="middle" fontSize="13" fontWeight="900" fill={ink}>{glyph}</SvgText>
    </Svg>
  );
}

function OilIcon({ size }: { size: number }): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40">
      <Defs>
        <RadialGradient id="oil" cx="40%" cy="35%" r="70%">
          <Stop offset="0%" stopColor="#475569" />
          <Stop offset="60%" stopColor="#1F2937" />
          <Stop offset="100%" stopColor="#0B0F17" />
        </RadialGradient>
      </Defs>
      <Circle cx="20" cy="20" r="19" fill="url(#oil)" />
      <Path d="M20 8c-4 5-6 9-6 13a6 6 0 0 0 12 0c0-4-2-8-6-13z" fill="#0B0F17" stroke="#1F2937" strokeWidth={0.6} />
      <Circle cx="17.5" cy="19" r="1.5" fill="#94A3B8" opacity={0.7} />
    </Svg>
  );
}

function GasIcon({ size }: { size: number }): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40">
      <Defs>
        <LinearGradient id="gas" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%" stopColor="#60A5FA" />
          <Stop offset="55%" stopColor="#2563EB" />
          <Stop offset="100%" stopColor="#1E3A8A" />
        </LinearGradient>
      </Defs>
      <Circle cx="20" cy="20" r="19" fill="#EFF6FF" stroke="#93C5FD" strokeWidth={1} />
      <Path
        d="M20 7c-1 4-5 5-5 11a5 5 0 0 0 10 0c0-3-2-4-2-7 2 2 4 3 4 7a7 7 0 0 1-14 0c0-5 4-7 7-11z"
        fill="url(#gas)"
      />
    </Svg>
  );
}

function Commodity({ icon, size }: { icon: CommodityIcon; size: number }): React.JSX.Element {
  switch (icon) {
    case 'gold': return <GoldIcon size={size} />;
    case 'silver':
      return <CoinIcon size={size} stops={['#F5F7FA', '#B7BFC9', '#5B6470']} ring="#4B5563" ink="#374151" glyph="Ag" />;
    case 'copper':
      return <CoinIcon size={size} stops={['#FFC089', '#C2733A', '#7A3F12']} ring="#5C2F0E" ink="#3D1F09" glyph="Cu" />;
    case 'oil': return <OilIcon size={size} />;
    case 'gas':
    default: return <GasIcon size={size} />;
  }
}

/** A white chart glyph on a 140° gradient tile — AssetIcon.jsx GlyphTile. */
function GlyphTile({ size, round, colors, kind }: {
  size: number;
  round: boolean;
  colors: TilePair;
  kind: 'index' | 'stock';
}): React.JSX.Element {
  const g = Math.round(size * 0.58);
  const offset = (size - g) / 2;
  const s = g / 24;
  return (
    <Svg width={size} height={size}>
      <Defs>
        <LinearGradient id="tile" x1="0.18" y1="0.03" x2="0.82" y2="0.97">
          <Stop offset="0" stopColor={colors[0]} />
          <Stop offset="1" stopColor={colors[1]} />
        </LinearGradient>
      </Defs>
      <Rect width={size} height={size} rx={round ? size / 2 : 14} fill="url(#tile)" />
      <G transform={`translate(${offset} ${offset}) scale(${s})`}>
        {kind === 'index' ? (
          <>
            <Rect x="3.5" y="13" width="4" height="7.5" rx="1" fill="#FFFFFF" />
            <Rect x="10" y="8.5" width="4" height="12" rx="1" fill="#FFFFFF" opacity={0.85} />
            <Rect x="16.5" y="4" width="4" height="16.5" rx="1" fill="#FFFFFF" />
          </>
        ) : (
          <>
            <Path d="M4 16.5 L9.5 11 L13 14 L20 6.5" stroke="#FFFFFF" strokeWidth={2.2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <Path d="M15.5 6.5 H20 V11" stroke="#FFFFFF" strokeWidth={2.2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
      </G>
    </Svg>
  );
}

function TextTile({ size, round, glyph, bg }: { size: number; round: boolean; glyph: string; bg: string }): React.JSX.Element {
  return (
    <View
      style={[
        styles.center,
        { width: size, height: size, backgroundColor: bg, borderRadius: round ? size / 2 : 14 },
      ]}
    >
      <Text
        allowFontScaling={false}
        style={{
          color: '#FFFFFF',
          fontWeight: '700',
          fontSize: Math.round(size * (glyph.length > 2 ? 0.32 : 0.4)),
          letterSpacing: glyph.length > 2 ? -0.3 : 0,
          textShadowColor: 'rgba(0,0,0,0.25)',
          textShadowOffset: { width: 0, height: 1 },
          textShadowRadius: 1,
        }}
      >
        {glyph}
      </Text>
    </View>
  );
}

/**
 * Coin logos, fetched and parsed once per URL for the session.
 *
 * Not `SvgUri`: in react-native-svg 15 it hands only a failed FETCH to
 * `onError`. An answer that does not parse goes to console.error — a red
 * banner in a dev build — and draws nothing, never the fallback. On the
 * Android emulator (2026-09-30) four logos came back as 2xx with an empty
 * body ("Unexpected end of input (1:0)"). A failure is not remembered, so
 * the next mount tries again.
 */
const coinLogos = new Map<string, Promise<JsxAST | null>>();
const loadCoinLogo = (uri: string): Promise<JsxAST | null> => {
  let pending = coinLogos.get(uri);
  if (!pending) {
    pending = fetch(uri)
      .then((r) => (r.ok ? r.text() : ''))
      .then((xml) => (/<svg[\s>]/i.test(xml) ? parse(xml) : null))
      .catch(() => null);
    coinLogos.set(uri, pending);
    void pending.then((ast) => { if (!ast) coinLogos.delete(uri); });
  }
  return pending;
};

function CryptoImage({ uri, size, fallbackGlyph }: { uri: string; size: number; fallbackGlyph: string }): React.JSX.Element {
  // Some coin logos aren't on the CDN — the web falls back to a round slate
  // tile with the ticker when the request fails, and so does this.
  // undefined = still loading, null = no logo.
  const [ast, setAst] = useState<JsxAST | null | undefined>(undefined);
  useEffect(() => {
    let on = true;
    setAst(undefined);
    void loadCoinLogo(uri).then((a) => { if (on) setAst(a); });
    return () => { on = false; };
  }, [uri]);
  if (ast === null) return <TextTile size={size} round glyph={fallbackGlyph} bg="#475569" />;
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden' }}>
      {ast ? <SvgAst ast={ast} override={{ width: size, height: size }} /> : null}
    </View>
  );
}

export function AssetIcon({
  row,
  symbol,
  baseCurrency,
  quoteCurrency,
  category,
  underlying,
  logoUrl,
  size = 32,
  round = false,
}: AssetIconProps): React.JSX.Element {
  const t = useTheme();
  const [logoFailed, setLogoFailed] = useState(false);
  const spec = resolveAssetIcon({
    symbol: symbol ?? row?.symbol,
    category: category ?? row?.category,
    baseCurrency: baseCurrency ?? row?.baseCurrency,
    quoteCurrency: quoteCurrency ?? row?.quoteCurrency,
    underlying: underlying ?? row?.underlying,
    logoUrl: logoUrl ?? row?.logoUrl,
  }, logoFailed);

  switch (spec.kind) {
    case 'logo':
      return (
        <Image
          source={{ uri: spec.uri }}
          onError={() => setLogoFailed(true)}
          resizeMode="contain"
          accessibilityIgnoresInvertColors
          style={{
            width: size,
            height: size,
            // `keep-white bg-white` — logos are drawn for a white ground.
            backgroundColor: '#FFFFFF',
            borderRadius: round ? size / 2 : Math.round(size * 0.28),
          }}
        />
      );
    case 'crypto':
      return <CryptoImage uri={spec.uri} size={size} fallbackGlyph={spec.fallbackGlyph} />;
    case 'commodity':
      return <Commodity icon={spec.icon} size={size} />;
    case 'forex': {
      const inner = Math.round(size * 0.72);
      const flagW = Math.round(inner * 0.78);
      const disc = {
        width: inner,
        height: inner,
        borderRadius: inner / 2,
        backgroundColor: '#FFFFFF',
        borderColor: t.colors.borderDark,
      };
      return (
        <View style={{ width: size, height: size }}>
          <View style={[styles.disc, disc, styles.topLeft]}>
            <CountryFlag currency={spec.base} width={flagW} />
          </View>
          <View style={[styles.disc, disc, styles.bottomRight]}>
            <CountryFlag currency={spec.quote} width={flagW} />
          </View>
        </View>
      );
    }
    case 'indexGlyph':
      return <GlyphTile size={size} round={round} colors={spec.colors} kind="index" />;
    case 'stockGlyph':
      return <GlyphTile size={size} round={round} colors={spec.colors} kind="stock" />;
    case 'tile':
    default:
      return <TextTile size={size} round={round} glyph={spec.glyph} bg={spec.bg} />;
  }
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  disc: { position: 'absolute', borderWidth: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  topLeft: { left: 0, top: 0 },
  bottomRight: { right: 0, bottom: 0 },
});
