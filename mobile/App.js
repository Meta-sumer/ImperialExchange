import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from './src/store/auth';
import { ThemeProvider, useTheme, useThemeMode } from './src/theme';
import RootNavigator from './src/navigation/RootNavigator';

// React Query = server-state cache (lists, balances, positions…). Global UI
// state (auth, active account, theme) stays in lightweight zustand stores.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15000, retry: 1, refetchOnWindowFocus: false } },
});

function Nav() {
  const { colors, dark } = useTheme();
  const base = dark ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...base,
    colors: { ...base.colors, background: colors.bg, card: colors.card, text: colors.textPrimary, border: colors.border, primary: colors.primary500 },
  };
  return (
    <NavigationContainer theme={navTheme}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <RootNavigator />
    </NavigationContainer>
  );
}

export default function App() {
  const init = useAuth((s) => s.init);
  const initMode = useThemeMode((s) => s.init);
  useEffect(() => { initMode(); init(); }, [initMode, init]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <SafeAreaProvider>
            <Nav />
          </SafeAreaProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
