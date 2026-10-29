import { createNavigationContainerRef } from '@react-navigation/native';

import type { RootStackParamList } from './types';

/**
 * The navigator, reachable from outside React — a push-notification tap, a
 * store reacting to a server event, the deep-link helper.
 *
 * Inside a component use `useAppNavigation()` instead. Check `isReady()`
 * first: before the container mounts (the boot splash) there is nothing to
 * navigate.
 */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();
