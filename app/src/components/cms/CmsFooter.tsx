import React, { useEffect, useMemo } from 'react';
import { Image, Linking, Pressable, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { create } from 'zustand';

import { cmsApi } from '@/api/cms.api';
import { AppText } from '@/components/ui';
import { navigateToPath } from '@/navigation/linking';
import { useTheme } from '@/theme';
import type { Footer } from '@/types/cms';
import {
  activeSocials,
  footerBrand,
  footerColumns,
  footerCopyright,
  footerTarget,
  type FooterItem,
  type SocialNetwork,
} from '@/utils/cms';

/**
 * The site footer under every scrolling screen — client/src/components/
 * CmsFooter.jsx, for the PageFooter chrome slot: the brand (logo or its
 * initial), tagline, address and social icons; the admin's link columns
 * (grouped by each page's footer column, "Daily News Updates" first); and
 * the copyright line. Everything is admin-managed.
 *
 * The web fetches /cms/footer-links on every page load. The footer is drawn
 * under EVERY screen here, so the answer is kept for the session (refreshed
 * after FOOTER_TTL_MS); a failure keeps the defaults, as on the web.
 */

const FOOTER_TTL_MS = 10 * 60_000;

interface FooterState { data: Footer | null; at: number }
const useFooterStore = create<FooterState>(() => ({ data: null, at: 0 }));
let inflight: Promise<void> | null = null;

const loadFooter = (): Promise<void> => {
  const { data, at } = useFooterStore.getState();
  if (data && Date.now() - at < FOOTER_TTL_MS) return Promise.resolve();
  if (inflight) return inflight;
  inflight = cmsApi.footer()
    .then((f) => { useFooterStore.setState({ data: f, at: Date.now() }); })
    .catch(() => { /* the footer is non-critical */ })
    .finally(() => { inflight = null; });
  return inflight;
};

/**
 * The admin's brand logo from the same cached footer config — the Trade
 * chart lays it where TradingView's attribution sat (PriceChart.jsx:1088).
 * '' until it loads, or when none is set.
 */
export function useFooterLogoUrl(): string {
  const url = useFooterStore((s) => s.data?.config?.logoUrl ?? '');
  useEffect(() => { void loadFooter(); }, []);
  return url || '';
}

/** Tests only. */
export const __resetFooterForTests = (): void => {
  useFooterStore.setState({ data: null, at: 0 });
  inflight = null;
};

// Brand icons, the web's own paths (CmsFooter.jsx SOCIAL_ICONS).
const SOCIAL_ICONS: Record<SocialNetwork, string> = {
  facebook: 'M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.78-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.44 2.89h-2.34v6.99A10 10 0 0 0 22 12z',
  twitter: 'M18.9 2H22l-7.5 8.6L23 22h-6.9l-5.4-7-6.2 7H1.4l8-9.2L1 2h7l4.9 6.5L18.9 2zm-1.2 18h1.9L7.1 4H5.1l12.6 16z',
  youtube: 'M23 12s0-3.2-.4-4.7a2.5 2.5 0 0 0-1.8-1.8C19.3 5 12 5 12 5s-7.3 0-8.8.5A2.5 2.5 0 0 0 1.4 7.3C1 8.8 1 12 1 12s0 3.2.4 4.7a2.5 2.5 0 0 0 1.8 1.8C4.7 19 12 19 12 19s7.3 0 8.8-.5a2.5 2.5 0 0 0 1.8-1.8c.4-1.5.4-4.7.4-4.7zM9.8 15.3V8.7l5.7 3.3-5.7 3.3z',
  linkedin: 'M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9h4v12H3zM10 9h3.8v1.7h.05c.53-1 1.83-2.05 3.77-2.05 4.03 0 4.78 2.65 4.78 6.1V21h-4v-5.4c0-1.3 0-2.95-1.8-2.95s-2.07 1.4-2.07 2.85V21h-4z',
  instagram: 'M12 2.2c3.2 0 3.6 0 4.85.07 1.17.05 1.8.25 2.23.42.56.22.96.48 1.38.9.42.42.68.82.9 1.38.17.42.37 1.06.42 2.23.06 1.25.07 1.65.07 4.85s0 3.6-.07 4.85c-.05 1.17-.25 1.8-.42 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.17-1.06.37-2.23.42-1.25.06-1.65.07-4.85.07s-3.6 0-4.85-.07c-1.17-.05-1.8-.25-2.23-.42-.56-.22-.96-.48-1.38-.9-.42-.42-.68-.82-.9-1.38-.17-.42-.37-1.06-.42-2.23C2.21 15.6 2.2 15.2 2.2 12s0-3.6.07-4.85c.05-1.17.25-1.8.42-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.17 1.06-.37 2.23-.42C8.4 2.21 8.8 2.2 12 2.2zm0 1.8c-3.15 0-3.52.01-4.76.07-.9.04-1.38.19-1.7.32-.43.16-.74.36-1.06.68-.32.32-.52.63-.68 1.06-.13.32-.28.8-.32 1.7C3.21 8.48 3.2 8.85 3.2 12s.01 3.52.07 4.76c.04.9.19 1.38.32 1.7.16.43.36.74.68 1.06.32.32.63.52 1.06.68.32.13.8.28 1.7.32 1.24.06 1.61.07 4.76.07s3.52-.01 4.76-.07c.9-.04 1.38-.19 1.7-.32.43-.16.74-.36 1.06-.68.32-.32.52-.63.68-1.06.13-.32.28-.8.32-1.7.06-1.24.07-1.61.07-4.76s-.01-3.52-.07-4.76c-.04-.9-.19-1.38-.32-1.7a2.86 2.86 0 0 0-.68-1.06 2.86 2.86 0 0 0-1.06-.68c-.32-.13-.8-.28-1.7-.32C15.52 4.01 15.15 4 12 4zm0 3.06A4.94 4.94 0 1 0 12 17a4.94 4.94 0 0 0 0-9.88zm0 8.14A3.2 3.2 0 1 1 12 8.8a3.2 3.2 0 0 1 0 6.4zm5.13-8.34a1.15 1.15 0 1 1-2.3 0 1.15 1.15 0 0 1 2.3 0z',
  whatsapp: 'M12 2a10 10 0 0 0-8.6 15l-1.3 4.8 4.9-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.15l-.3-.18-2.9.76.77-2.83-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.13c-.25-.12-1.47-.72-1.7-.8-.23-.09-.4-.13-.56.12s-.64.8-.79.97c-.14.16-.29.18-.54.06a6.7 6.7 0 0 1-3.35-2.93c-.25-.43.25-.4.72-1.33.08-.16.04-.3-.02-.42-.06-.12-.56-1.34-.76-1.84-.2-.48-.4-.41-.56-.42h-.48c-.16 0-.42.06-.64.3-.22.25-.84.83-.84 2.02s.86 2.35.98 2.51c.12.16 1.7 2.6 4.12 3.65.58.25 1.02.4 1.37.5.58.19 1.1.16 1.52.1.46-.07 1.47-.6 1.68-1.18.2-.58.2-1.07.14-1.18-.05-.1-.22-.16-.47-.28z',
  telegram: 'M21.94 4.6 18.7 19.9c-.24 1.08-.88 1.35-1.78.84l-4.92-3.63-2.38 2.29c-.26.26-.48.48-.99.48l.35-5 9.1-8.22c.4-.35-.09-.55-.62-.2L4.62 13.1l-4.85-1.52c-1.05-.33-1.07-1.05.22-1.56L20.6 3.07c.88-.33 1.65.2 1.34 1.53z',
  skype: 'M12 2a4 4 0 0 0-3.9 4.86A6 6 0 0 0 6 12a6 6 0 0 0 6 6 4 4 0 0 0 3.9-4.86A6 6 0 0 0 18 8a6 6 0 0 0-6-6zm.2 13.2c-2 0-3.4-.95-3.4-2.06 0-.45.34-.79.8-.79.95 0 .9 1.42 2.6 1.42.86 0 1.36-.46 1.36-.92 0-1.5-4.93-.58-4.93-3.55 0-1.32 1.18-2.27 3.1-2.27 1.86 0 3.16.87 3.16 1.9 0 .47-.36.78-.82.78-.85 0-.78-1.18-2.4-1.18-.78 0-1.22.35-1.22.83 0 1.4 4.92.52 4.92 3.52 0 1.43-1.22 2.59-3.13 2.59z',
};

const GLOBE = 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-2.8a15.7 15.7 0 0 0-1.3-3.4A8 8 0 0 1 18.9 8zM12 4c.8 1.2 1.5 2.5 1.9 4h-3.8c.4-1.5 1.1-2.8 1.9-4zM4.3 14a8 8 0 0 1 0-4h3.2a17 17 0 0 0 0 4H4.3zm.8 2h2.8c.3 1.2.8 2.4 1.3 3.4A8 8 0 0 1 5.1 16zM7.9 8H5.1a8 8 0 0 1 4.1-3.4C8.7 5.6 8.2 6.8 7.9 8zM12 20c-.8-1.2-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.8-1.9 4zm2.4-6H9.6a15 15 0 0 1 0-4h4.8a15 15 0 0 1 0 4zm.3 5.4c.5-1 1-2.2 1.3-3.4h2.8a8 8 0 0 1-4.1 3.4zM16.5 14a17 17 0 0 0 0-4h3.2a8 8 0 0 1 0 4h-3.2z';

const openUrl = (url: string): void => {
  if (!url || url === '#') return;
  Linking.openURL(url).catch(() => undefined);
};

const openItem = (item: FooterItem): void => {
  const target = footerTarget(item);
  if (target.kind === 'external') openUrl(target.url);
  else if (target.kind === 'internal') navigateToPath(target.path);
};

export function CmsFooter(): React.JSX.Element {
  const t = useTheme();
  const data = useFooterStore((s) => s.data);
  useEffect(() => { void loadFooter(); }, []);

  const config = data?.config ?? null;
  const brand = footerBrand(config);
  const socials = useMemo(() => activeSocials(config?.socials), [config]);
  const customSocials = useMemo(() => (config?.customSocials ?? []).filter((c) => c && c.url), [config]);
  const columns = useMemo(() => footerColumns(data?.links ?? []), [data]);
  const year = new Date().getFullYear();

  return (
    <View
      testID="cms-footer"
      style={[styles.footer, { borderTopColor: t.colors.borderDark, backgroundColor: t.alpha(t.colors.surface, 0.4) }]}
    >
      <View style={styles.brandRow}>
        {config?.logoUrl ? (
          <Image source={{ uri: config.logoUrl }} accessibilityLabel={brand} resizeMode="contain" style={styles.logo} />
        ) : (
          <View style={[styles.initial, { backgroundColor: '#2563EB' }]}>
            <AppText variant="title" weight="800" color="#FFFFFF">{brand.slice(0, 1).toUpperCase()}</AppText>
          </View>
        )}
        <AppText variant="h3" weight="800" style={styles.brand}>{brand}</AppText>
      </View>

      {config?.tagline ? <AppText variant="body" tone="secondary" style={styles.para}>{config.tagline}</AppText> : null}
      {config?.address ? <AppText variant="body" tone="secondary" style={styles.para}>{config.address}</AppText> : null}

      {socials.length || customSocials.length ? (
        <View style={styles.socials}>
          {socials.map((k) => (
            <Pressable
              key={k}
              accessibilityRole="link"
              accessibilityLabel={k}
              hitSlop={6}
              onPress={() => openUrl(String(config?.socials[k] ?? ''))}
            >
              <Svg width={20} height={20} viewBox="0 0 24 24"><Path d={SOCIAL_ICONS[k]} fill={t.colors.textMuted} /></Svg>
            </Pressable>
          ))}
          {customSocials.map((c, i) => (
            <Pressable
              key={`c-${i}`}
              accessibilityRole="link"
              accessibilityLabel={c.label || 'link'}
              hitSlop={6}
              onPress={() => openUrl(c.url)}
            >
              {c.icon ? (
                <Image source={{ uri: c.icon }} accessibilityLabel={c.label || ''} resizeMode="contain" style={styles.customIcon} />
              ) : (
                <Svg width={20} height={20} viewBox="0 0 24 24"><Path d={GLOBE} fill={t.colors.textMuted} /></Svg>
              )}
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={styles.columns}>
        {columns.map((col) => (
          <View key={col.name} style={styles.column}>
            <AppText variant="caption" weight="700" style={styles.colTitle}>{col.name.toUpperCase()}</AppText>
            {col.items.map((l, i) => (
              <Pressable
                key={l.slug || `${l.label}-${i}`}
                accessibilityRole="link"
                onPress={() => openItem(l)}
                hitSlop={4}
                style={({ pressed }) => (pressed ? { opacity: 0.6 } : null)}
              >
                <AppText variant="body" tone="secondary">{l.label}</AppText>
              </Pressable>
            ))}
          </View>
        ))}
      </View>

      <View style={[styles.bottom, { borderTopColor: t.colors.borderSubtle }]}>
        <AppText variant="small" tone="muted" align="center">{footerCopyright(config, year)}</AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  footer: { borderTopWidth: 1, marginTop: 48, paddingHorizontal: 16, paddingVertical: 40 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: { height: 36, width: 150 },
  initial: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  brand: { flexShrink: 1 },
  para: { marginTop: 12, maxWidth: 320 },
  socials: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 16 },
  customIcon: { width: 20, height: 20 },
  columns: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 32, rowGap: 24 },
  column: { width: '50%', gap: 10, paddingRight: 12 },
  colTitle: { letterSpacing: 1.2, marginBottom: 2 },
  bottom: { marginTop: 40, paddingTop: 24, borderTopWidth: 1 },
});
