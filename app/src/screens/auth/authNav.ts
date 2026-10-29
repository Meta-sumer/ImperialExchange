import { navigateToPath } from '@/navigation/linking';
import type { AppNavigation as AppNavigationProp } from '@/navigation/types';

/**
 * The auth pages' `navigate('/login', { replace: true })`.
 *
 * Login lives only in the signed-out half of the navigator. Signed out, go
 * BACK to it when it is in the stack (Login → Forgot password → done), or
 * put it in place of this screen when it is not (a reset link opened cold) —
 * either way there is one Login, not a pile of them. Signed in, there is no
 * Login to go to, and the web path resolves as the web's router would send a
 * signed-in visitor.
 */
export const goToLogin = (navigation: Pick<AppNavigationProp, 'getState' | 'popTo'>): void => {
  const state = navigation.getState();
  if (state?.routeNames?.includes('Login')) {
    navigation.popTo('Login');
    return;
  }
  navigateToPath('/login');
};
