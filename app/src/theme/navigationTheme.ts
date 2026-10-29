import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native';

import type { AppTheme } from './tokens';

/**
 * The palette React Navigation paints with — the screen background behind a
 * transition, the card a native-stack screen sits on. Without it a push
 * flashes the library's own grey between two white screens.
 */
export const navigationTheme = (t: AppTheme): Theme => {
  const base = t.isDark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    dark: t.isDark,
    colors: {
      ...base.colors,
      primary: t.colors.primary,
      background: t.colors.surface,
      card: t.colors.surface,
      text: t.colors.textPrimary,
      border: t.colors.borderDark,
      notification: t.colors.bear,
    },
  };
};
