import type { ComponentType, ReactNode } from 'react';

import { GlobalAlertPopup } from '@/components/alerts/GlobalAlertPopup';
import { HeaderBell as Bell, NotificationEngineKeeper } from '@/components/chrome/HeaderBell';
import { HeaderSearch as Search } from '@/components/chrome/HeaderSearch';
import { CmsFooter } from '@/components/cms/CmsFooter';
import { WatchlistModalProvider } from '@/components/market/WatchlistModal';

/**
 * Plug points in the app chrome for features other agents own.
 *
 * Like screenRegistry.ts, this file is the one shared edit point: when the
 * feature lands, replace its `null` (or add to its list) with the
 * component, import it at the top, and nothing else in navigation/ needs to
 * change. Each slot names the web component it stands for.
 *
 * Until then a slot renders nothing — not a dead button. A bell that opens
 * nothing is worse than no bell.
 */

/**
 * Header, right cluster, left of the theme toggle — the web's search button
 * (Layout.jsx:396-403) and the SearchModal it opens. Renders its own
 * trigger (an IconButton "search") and owns its modal.
 */
export const HeaderSearch: ComponentType | null = Search;

/**
 * Header, right cluster, left of the avatar — NotificationCenter.jsx: the
 * bell with its unread count and its panel (render the panel as a
 * BottomSheet from '@/components/ui').
 */
export const HeaderBell: ComponentType | null = Bell;

/**
 * The page footer under every scrolling app screen — CmsFooter.jsx
 * (admin-managed links). Screen renders it after the content.
 */
export const PageFooter: ComponentType | null = CmsFooter;

/**
 * Overlays mounted once for the whole signed-in app — GlobalAlertPopup.jsx
 * (the price-alert popup). Rendered inside the navigation container, above
 * the navigator.
 */
// NotificationEngineKeeper draws nothing: it keeps the bell's engine running
// while signed in, now that the bell is only in the profile menu.
export const GlobalOverlays: ComponentType[] = [GlobalAlertPopup, NotificationEngineKeeper];

/**
 * Providers wrapping the signed-in app — WatchlistModalProvider.jsx.
 * Outermost first.
 */
export const AppProviders: ComponentType<{ children: ReactNode }>[] = [WatchlistModalProvider];
