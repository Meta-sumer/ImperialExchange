import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';

import { cmsApi } from '@/api/cms.api';
import { AppText, Button, ErrorView, Screen, Skeleton } from '@/components/ui';
import { HtmlContent } from '@/components/news/HtmlContent';
import { resolveMediaUrl } from '@/components/news/htmlParse';
import { API_URL, WEB_ORIGIN } from '@/constants/env';
import type { AppScreenProps } from '@/navigation/types';
import { useAuthStore } from '@/store/auth';
import { useTheme } from '@/theme';
import type { CmsPage } from '@/types/cms';
import { cmsPageFailure, cmsPagePath, fmtCmsDate } from '@/utils/cms';

/**
 * A CMS page — client/src/pages/CmsPageView.jsx at /page/:slug: an
 * admin-authored page (About, Terms, Privacy…). The loading skeleton, "Page
 * not found" with Go Home, "Members only" with Sign In for an AUTH page read
 * signed out, and the page: featured image, title, "Updated <date>", body.
 *
 * The body is the admin's HTML, which the web injects raw; here it is drawn
 * natively from an allow-list (components/news/HtmlContent), so it cannot run
 * code, and its links open app screens or the browser. The web's SEO tags
 * have no phone equivalent. Difference, on purpose: a dropped connection
 * offers Retry; the web says "Page not found" for every failure but AUTH.
 */

const MEDIA_ORIGIN = WEB_ORIGIN ?? API_URL.replace(/\/api\/?$/, '');

type State = 'loading' | 'ok' | 'notfound' | 'auth' | 'error';

export function CmsPageScreen({ navigation, route }: AppScreenProps<'CmsPage'>): React.JSX.Element {
  const t = useTheme();
  const signedIn = useAuthStore((s) => !!s.user);
  const slug = String(route.params?.slug ?? '').trim();
  const [page, setPage] = useState<CmsPage | null>(null);
  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState<unknown>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    if (!slug) { setState('notfound'); return; }
    setState((s) => (s === 'ok' ? s : 'loading'));
    try {
      const p = await cmsApi.page(slug);
      if (mine !== seq.current) return;
      setPage(p);
      setError(null);
      setState('ok');
    } catch (err) {
      if (mine !== seq.current) return;
      setError(err);
      setState(cmsPageFailure(err));
    }
  }, [slug]);

  // Signing in on the "Members only" page brings the reader back here with a
  // session — read the page again.
  useEffect(() => {
    setPage(null);
    setState('loading');
    void load();
    return () => { seq.current += 1; };
  }, [load, signedIn]);

  const goHome = (): void => {
    if (signedIn) navigation.navigate('Explore', undefined, { pop: true });
    else navigation.navigate('Landing', undefined, { pop: true });
  };

  const image = page ? resolveMediaUrl(page.featuredImageUrl, MEDIA_ORIGIN) : null;

  return (
    <Screen onRefresh={state === 'ok' || state === 'error' ? load : undefined} testID="cms-page-screen">
      <View style={styles.page}>
        {state === 'loading' ? (
          <View style={styles.skeleton} accessibilityLabel="Loading page">
            <Skeleton width="66%" height={32} />
            {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} width={`${90 - i * 8}%` as `${number}%`} height={16} />)}
          </View>
        ) : null}

        {state === 'notfound' ? (
          <View style={styles.center}>
            <AppText variant="h1" align="center">Page not found</AppText>
            <AppText variant="body" tone="secondary" align="center" style={styles.sub}>
              This page may have been moved or unpublished.
            </AppText>
            <Button title="Go Home" onPress={goHome} style={styles.cta} />
          </View>
        ) : null}

        {state === 'auth' ? (
          <View style={styles.center}>
            <AppText variant="h1" align="center">Members only</AppText>
            <AppText variant="body" tone="secondary" align="center" style={styles.sub}>
              Please sign in to view this page.
            </AppText>
            <Button title="Sign In" onPress={() => navigation.navigate('Login')} style={styles.cta} />
          </View>
        ) : null}

        {state === 'error' ? (
          <ErrorView error={error} title="Couldn't load this page" onRetry={() => { void load(); }} />
        ) : null}

        {state === 'ok' && page ? (
          <View>
            {image ? (
              <Image
                source={{ uri: image }}
                accessibilityLabel={page.title}
                resizeMode="cover"
                style={[styles.hero, { borderColor: t.colors.borderDark }]}
              />
            ) : null}
            <AppText variant="display" accessibilityRole="header">{page.title}</AppText>
            <AppText variant="small" tone="muted" style={styles.updated}>
              {`Updated ${fmtCmsDate(page.updatedAt || page.publishedAt)}`}
            </AppText>
            <View style={styles.body}>
              <HtmlContent html={page.content || ''} basePath={cmsPagePath(page.slug || slug)} testID="cms-page-body" />
            </View>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: { paddingTop: 8 },
  skeleton: { gap: 12 },
  center: { alignItems: 'center', paddingVertical: 80 },
  sub: { marginTop: 8 },
  cta: { marginTop: 24 },
  hero: { width: '100%', height: 220, borderRadius: 12, borderWidth: 1, marginBottom: 24 },
  updated: { marginTop: 8 },
  body: { marginTop: 24 },
});
