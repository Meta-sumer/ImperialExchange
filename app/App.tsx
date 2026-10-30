import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View, useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { brand } from '@/constants/theme';
import { probeFeatures } from '@/store/features';
import { AppNavigation } from '@/navigation';
import { hydrate } from '@/services/tokenStore';
import { useAuthStore } from '@/store/auth';
// Side effect: per-user caches are dropped when the signed-in person changes.
import '@/store/sessionScope';
import { ThemeProvider, hydrateAppearance, themes } from '@/theme';

/**
 * The app shell.
 *
 * ── WHY THERE IS A GATE BEFORE ANYTHING RENDERS ───────────────────────
 * The web client reads `localStorage.getItem('accessToken')` synchronously,
 * so by the time React runs, the session either exists or it does not and
 * the first render is already correct.
 *
 * A keychain read is asynchronous. Rendering before it finishes means the
 * first frame is drawn signed-out, every screen fires its first request
 * anonymous, and the app then flips to signed-in — a visible flash and a
 * burst of 401s on every launch. So nothing renders until `hydrate()` has
 * put the session in memory.
 *
 * The saved theme is read in the same gate for the same reason: main.jsx
 * stamps the theme on <html> before React renders so there is no flash of
 * the wrong palette, and AsyncStorage is just as asynchronous as the
 * keychain.
 *
 * It is one await at launch, and it removes a whole class of races that
 * the web version never had to think about.
 * ──────────────────────────────────────────────────────────────────────
 *
 * After the gate, `bootstrap()` resolves the session (App.jsx's `init()`),
 * and navigation shows a splash until it settles. A session the HTTP layer
 * gives up on is handled by store/auth, which listens for it and flips the
 * status; the navigator follows.
 */
export default function App(): React.JSX.Element {
  const [ready, setReady] = useState(false);
  // The saved theme is not known yet — that is what the gate is waiting for.
  // The default intent is 'system', so the OS scheme is the best guess for
  // the few frames this is on screen, and it avoids a white flash in dark mode.
  const osScheme = useColorScheme();

  useEffect(() => {
    let cancelled = false;
    // The F&O probe rides in the same gate so the tab bar's first frame is
    // already right; it is capped at 3 s so a slow network cannot hold launch.
    const probe = Promise.race([probeFeatures(), new Promise<void>((r) => { setTimeout(r, 3000); })]);
    void Promise.all([hydrate(), hydrateAppearance(), probe]).finally(() => {
      if (cancelled) return;
      setReady(true);
      void useAuthStore.getState().bootstrap();
    });
    return () => { cancelled = true; };
  }, []);

  if (!ready) {
    return (
      <View style={[styles.boot, { backgroundColor: themes[osScheme === 'dark' ? 'dark' : 'light'].colors.surface }]}>
        <ActivityIndicator color={brand.primary500} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={styles.flex}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AppNavigation />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
