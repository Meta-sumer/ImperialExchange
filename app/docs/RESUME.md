# EquityHub — mobile port, resume notes

Stage 1 finished and verified 2026-09-29. Stages 2–5 finished 2026-09-30:
**all 35 routes are ported.** Nothing here is committed. Nothing has run on
a phone or an emulator yet — see "What remains".

## What this is

A **new React Native app** that is a feature-for-feature mobile port of the
existing web client at `client/`. It is a separate app from `mobile/`, which
is untouched and stays untouched.

- **App name:** EquityHub (from `client/index.html` `<title>`)
- **Directory:** `advance-ai-trader/`
- **Bundle id / package:** `com.equityhub.app`
- **Expo slug:** `advance-ai-trader`, scheme `equityhub://`

Read before touching anything: `docs/PORT-RULINGS.md` (one answer per
contested number) and `docs/CONTRACT.md` (how a screen is ported: where files
go, the registry, the UI kit, theme, API modules, stores, money, tests).

## Stack

Chosen to match what already runs on this machine against this backend.

| | Web | This app |
|---|---|---|
| State | zustand 4 | zustand 5 |
| HTTP | axios 1.7 | axios 1.7 |
| Routing | react-router-dom 6 | React Navigation 7 (one native stack) |
| Chart | lightweight-charts 4.2 | **the same library, in a WebView** (stage 5) |
| Runtime | Vite | Expo 54 / RN 0.81.5 / React 19 |
| Tokens | localStorage | expo-secure-store (`services/tokenStore` only) |

## Status

| Check | Result (2026-09-30, after stage 5) |
|---|---|
| `npx tsc --noEmit` | clean, exit 0 |
| `npx jest` | 51 suites, **1626 / 1626** passed (~35 s) |
| `npx expo export --platform android` | bundles (7.66 MB HBC; 6.66 MB after stage 4 — see Stage 5 → bundle) |
| Every HTTP call in `src/api` matched against `backend/src/routes` | still enforced by `apiA_endpoints` |

**Screens: 35 of 35 routes ported.** Nothing renders `ComingSoonScreen`
(`stage5_integration` asserts it). (Stage 1 notes said "37 routes"; the
param list has 35 names — the web's aliases are paths, not routes.)

## After the port — the app's own departures from the web (2026-10-05)

Asked for by the owner; the web is unchanged. 55 suites, 1655 tests, tsc clean.

- **Bottom tabs: Forex, Stocks, Crypto, F&O** (`navigation/chrome/BottomTabBar`),
  drawn by RootNavigator's `screenLayout` under every signed-in page with the
  app header — not on Trade, not on the sign-in pages; hidden while the
  keyboard is up. They go to the same Explore / Fno routes the rail did
  (`pop`), so links and paths are unchanged. The bar takes the bottom inset;
  the page above is told it is 0. `PRIMARY_NAV` stays the web's list;
  `BOTTOM_TABS` / `railNavFor` split it.
- **The rail**: Explore (lit on any market page and F&O), Positions, Broker,
  Portfolio, Wallets.
- **Positions page** (`screens/positions`, route `Positions`, `/positions` —
  app only, so 36 routes now): Explore's "Your activity" card moved whole —
  tabs, close / cancel / modify, Close All / Cancel All, the SL/TP sheet.
  Explore no longer has it.
- **Compact hero** (`PageHero compact`) on Explore and Positions.
- **Bell only in the profile menu**, before its × (`Modal headerRight`) —
  the app header no longer has it. `NotificationEngineKeeper` (GlobalOverlays)
  keeps the engine running for the whole signed-in session. Any navigation
  closes the menu.
- **No back chevron on section pages** (`SECTION_ROUTES`: Explore,
  Positions, Broker, Portfolio, Wallet, F&O) — switching section from the
  rail or a tab is not a step back; pages opened from them keep it.
- Tests: `bottomTabs`, `positionsScreen`, `shell.render` (tabs, Positions,
  bell); the route-count tests say 36.

## Stage 5 — done (the Trade page), by hand

Written without a workflow, against `client/src/pages/Trade.jsx` (5263
lines), `components/PriceChart.jsx`, `hooks/useChartDrawings.js`,
`ChartDrawingToolbar`, `indicatorCatalog`, `ChartSettings`,
`MultiChartToolbar`, `utils/indicators.js` and TradeSettingsDrawer. About
11 100 hand-written lines.

### The chart: lightweight-charts in a WebView
The page is inline HTML (`charts/chartHtml.ts`) carrying the vendored
library and a plain-JS runtime, so drawing needs no network. The runtime is
four files in `src/charts/runtime/`, each an IIFE on `window.AATChart` that
also sets `module.exports` so jest can load it:

| File | What |
|---|---|
| `indicators.js` | `utils/indicators.js`, all 23 functions, line for line |
| `candles.js` | gap fill / repair / outlier guard (`fillCandleGaps`, `analyzeCandles`), Heikin Ashi, and `mergeLiveCandle` for the forming bar |
| `drawings.js` | `useChartDrawings.js` without React: a canvas over the chart, every tool family, hit-testing, handles, 120-step history, lock / hide / layer order, measure |
| `chart.js` | series (10 chart types), volume, overlays, sub-panes (RSI / MACD / Stoch / ATR / W%R / CCI), price lines, draggable position / order pills, legend, countdown, markers, gestures |

`scripts/build-chart-runtime.mjs` bundles the four into
`runtime/generated.ts` (`postinstall` runs it after `vendor-chart.mjs`;
**after editing a runtime file run `npm run build:chart-runtime`** —
`stage5_chartRuntime` fails if the bundle is stale). The bridge is typed
both ways in `charts/protocol.ts`: the app sends JSON through
`window.__aatReceive` (as a string literal that cannot break out of the
call), the runtime posts back through `ReactNativeWebView.postMessage`, and
`parseFromChart` accepts only its own message types. Ready handshake →
`init` → deltas. The WebView may load only `about:` / `data:`.

The RN side: `charts/PriceChart.tsx` (data: cached candles first, then
`/instruments/:symbol/candles` 500 bars, then the `candles:SYM:TF` socket
coalesced to 120 ms; pauses out of focus and re-reads on return), the
catalogues (`chartCatalog`, `chartTools` — the 83 tools + 4 cursors +
emoji = the audit's 88 — `chartLayouts`), `chartOverlays` (price lines,
pills, calendar markers), `chartPersistence` (the web's storage keys), and
`charts/components/*` (toolbar, drawing rail + flyouts, drawing menu,
indicator / settings / type / timeframe sheets, layout picker, TradingView
demo). A pill drag is turned into a `PillAction`; the chart never calls a
trading endpoint itself.

### The screen
`screens/trade/TradeScreen.tsx` + `tradeLogic.ts` (pure decisions),
`tradeViewStore.ts` (tabs, layout, sync, panes, per-symbol view, split
height, filter — the web's keys), `useLiveBoard.ts`, and components:
`TradeTopBar` (tabs, account pill, deposit, "⋯"), `TradeBook` (Open /
Pending / Closed cards, fills, SL/TP edit), `TradeDialogs` (pending-order
modify, account menu, equity strip), `TradePanelsSheet` + `panels/*` (the
web's ten side panels). Reused from stage 3: `OrderForm` (in the screen's
own sheet, fed the chart's preview levels), `PositionSlTpModal`,
`SearchModal` (gained `onPick`).

Every pill / row / panel action reaches the endpoint Trade.jsx calls
(3100-3170 for the pills), with the same toasts. Broker rows are listed,
badged "On broker" and never sent to platform order endpoints or drawn as
pills. Close-all and cancel-all confirm first. The chart chip follows
Trade.jsx:1734-1745 exactly (one-click fires only outside fullscreen).

### Deliberate differences from the web (each documented where it lives)
- **Equity strip and account menu show the server's figures**
  (account-metrics, PORT-RULINGS §1); Trade.jsx re-derives them in the page.
- **Market Depth shows the real book**, only top-of-book when the feed has
  no L2; the web synthesises nine levels a side with a sine "noise".
- **A price in another quote currency keeps its own symbol** (the web
  prints `$` before a EUR / JPY rate).
- **An SL / TP pill measures from the real entry** when "Open positions"
  is hidden (the web measured from 0: a BTC stop read −$60,000).
- **Chart colours reach hollow candles and Heikin Ashi** (the web compares
  against ids no chart type has).
- **A search pick opens a tab on the terminal**; the web's SearchModal
  leaves for `/stock/:symbol`, against Trade.jsx's own intent.
- **A link's symbol is upper-cased** (`/trade?symbol=eurusd` → EURUSD; the
  web finds no instrument).
- Phone layout: the side panels are one sheet (the web shows them only
  from 1024 px); the Show-on-chart toggles, bell and theme switch sit
  behind "⋯" (the web hides them on a phone); the order ticket is a sheet;
  sub-pane heights are scaled down; text tools ask in a modal instead of
  `window.prompt`; long-press / double-tap replace right-click /
  double-click; keyboard shortcuts become toolbar buttons.
- Live ticks for the panels are coalesced to 400 ms and stop out of focus
  (the web sets state per frame per channel).

### Bundle
+1 MB since stage 4: the library (165 KB) and runtime (152 KB) ship as
strings, and Hermes stores both as UTF-16 because each contains a few
non-ASCII characters (—, ™, −, ─, ±, →, emoji). Escaping them to `\uXXXX`
in the two build scripts would save ~0.3 MB. Not done; harmless.

### Stage 5 tests — 126
| Suite | Tests |
|---|---|
| `stage5_chartRuntime` — bundle in sync; indicators, candle pipeline, measure, catalogues vs the web's own source | 45 |
| `stage5_chartRuntime.dom` — the real library + runtime booted in jsdom: every message path, pill tap / drag / +TP | 11 |
| `stage5_chartOverlays` — price lines, pills, pill keys, calendar, the bridge | 23 |
| `stage5_tradeLogic` — tabs, equity, fills (lifted from Trade.jsx), grouping, depth, movers | 31 |
| `stage5_integration` — registry 35/35, `/trade` paths, the mounted terminal over a routed axios adapter: book, equity, pills → PUT / DELETE bodies, Close All, the one-click body key-for-key against Trade.jsx, fullscreen, panels | 16 |

Not done: an adversarial review of the stage 5 code (same caveat as stages
3 and 4), and any run on a device.

## Stage 4 — done (social, partner, support, broker, public), by hand

Written without a workflow (the user's standing instruction), one screen at a
time against the web source, tsc after each:

- **Landing** (`screens/landing/LandingScreen` + `LandingArt`): every section
  of Landing.jsx with the live `/instruments/watchlist` ticker and per-category
  market changes (10 s, paused off-screen), header reused from
  `AuthShell` (`AuthHeader` is now exported). The "Trade Anytime, Anywhere"
  app-download section is left out on purpose (the reader is in the app).
- **CmsPage** + **CmsFooter** (PageFooter slot; the footer is cached for the
  session, 10 min TTL). AUTH pages → "Members only"; a dropped connection
  offers Retry (the web says "Page not found" for every failure).
- **Feedback**, **Helpdesk** (Live Chat / Knowledge Base incl. admin
  articles + YouTube/Vimeo embeds / My Tickets / New Ticket with image-or-PDF
  attachment) and **HelpdeskChat** (shared `components/helpdesk/
  HelpdeskChatPanel`: socket + 5 s poll funnelled through
  `mergeChatMessages`, load-older, typing, seen ticks, presence,
  attachments via the document picker). `TicketStatusChip` is shared.
- **Partner** (`screens/partner/*`): hero with count-up, levels, 8 stats, SVG
  charts, referral performance (search + date range + paging), commission
  overview, recent commissions, referral link + QR + share.
- **CopyTrading** + **TraderDashboard** (`screens/copy/*`,
  `components/copy/CopyModals` + `CopyAnalyticsModal`): boxes (create / edit /
  public-private / archive / restore), leaderboard (search, risk, sort,
  badges), feed, my copies (6 s running-P&L poll), start / edit / stop copy,
  analytics (presets + custom range, CSV to the share sheet), the trader
  profile with live open positions and paged history.
- **Broker** (`screens/broker/BrokerScreen`, `components/broker/*`): connect
  (catalogue-driven credential form, verify / default / disconnect), order
  pad, order book (cancel / close), portfolio (stream-aware 8 s + 3 s polls).
  **Addition:** each order attempt sends a `clientOrderId` in the server's
  `PX-YYYYMMDD-XXXXXXXX` format, reused only when the previous attempt got no
  answer — a dropped mobile response cannot become two orders (the server
  dedupes on it; the web sends none).
- `components/common/DateField` — the Bonus Wallet's calendar field, now
  shared (Partner, Copy analytics, Trader history).
- Tests: `stage4_integration.test.tsx` (36): registry (now: no stage 4 route on ComingSoon), the footer
  slot, 12 web paths, a render of every stage 4 screen's main states, the
  feedback submit body, and the broker order body checked key-by-key against
  `backend/src/brokers/validation/schemas.js` (placeOrder is `.strict()`),
  including the server's own clientOrderId pattern.
- Not done: a separate adversarial review per screen (same caveat as stage 3).

## Stage 3 — done (markets and portfolio), with a caveat

Built by 8 workflow agents on 2026-09-30, cut off twice by the session limit
before they could report; then finished by hand WITHOUT a workflow (the user
asked for no more workflows because of the limit). Consequently:

- **Built and registered:** Dashboard, Explore, MarketList, Fno, Options,
  Watchlist, StockDetail, Orders, Reports, Alerts, News, NewsArticle; chrome
  slots HeaderSearch (SearchModal), HeaderBell (NotificationCenter + push
  registration, `services/push.ts`), GlobalOverlays [GlobalAlertPopup],
  AppProviders [WatchlistModalProvider]. Shared: `components/trade/OrderForm`
  + `OrderSheet` (stage 5 reuses), `PositionSlTpModal`, `components/market/*`
  (WatchlistButton, WatchlistModal, ExecutionBadge, EconomicCalendar,
  StocksInNews), `utils/marketSession`, `utils/walletTotals`.
- **Written by hand in the finishing pass:** `screens/dashboard/DashboardScreen`
  (+ `DhanFundsCard`, `RecentClosedTrades`), `screens/watchlist/WatchlistScreen`
  (+ `SymbolRow`, `WatchlistModals`), the registry / chrome wiring, and
  `stage3_integration.test.tsx` (registry, slots, 17 web paths, Dashboard and
  Watchlist render states).
- **NOT done for stage 3:** the per-area adversarial review, and most area
  tests (only `stage3_stockDetail.logic` exists besides the integration test).
  The order payload was checked by hand against `orderController.placeOrder`
  and the web OrderForm (identical fields; destination always sent; SL/TP
  only when > 0). A review pass per area is the first thing to do if time
  and limits allow.

---

## Stage 1 — done

### Backend (in `backend/`, uncommitted, from before stage 1)
- `GET /api/trading/account-metrics` — trader-facing equity / used margin /
  free margin / floating P&L / margin level from `riskService`
  (`orderController.js`, `routes/trading.js`,
  `tests/accountMetricsEndpoint.test.js`, 14 tests). PORT-RULINGS §1 depends
  on it.

### Foundation
| File | What |
|---|---|
| `src/constants/env.ts` | API + WS URLs, absolute and validated at startup; `WEB_ORIGIN` (the one web-origin setting) |
| `src/constants/theme.ts` | Raw light + dark palettes from `index.css` / `tailwind.config.js` (render through `@/theme`, never this) |
| `src/services/tokenStore.ts` | Keychain + in-memory copy — the only place tokens live |
| `src/services/impersonation.ts` | Read-only "View As User", deep-link entry |
| `src/api/client.ts` | axios + the web's refresh queue; `errorMessage`, `onSessionEnded`, `ReadOnlyError` |
| `src/websocket/ws.ts` | ws.js port plus three fixes: `auth_error` handled, app-level heartbeat, `AppState` instead of 13 focus listeners |
| `src/types/api.ts` | Tolerant readers `rows/one/str/num/dec/bool/id` |
| `src/utils/money.ts` | All money / number formatting (grouping follows the currency) |
| `src/utils/accountType.ts` | `isDemoLike` / `isRealMoney` — the one demo predicate |
| `src/charts/vendor/chartLibrary.ts` | lightweight-charts vendored for the WebView |

### API layer — 21 modules in `src/api/`, 187 HTTP call sites
`account` · `alerts` · `auth` · `broker` · `cms` · `compliance` ·
`copyTrading` · `dashboard` · `feedback` · `helpdesk` · `instruments` ·
`market` · `news` · `notifications` · `partner` · `reports` · `subscription` ·
`trading` · `user` · `wallet` · `watchlist`, with adapters in `src/types/*`
(`user`, `wallet`, `subscription`, `trading`, `market`, `broker`, `cms`,
`copyTrading`, `helpdesk`, `notifications`, `partner`).

Hooks and shared stores screens should use instead of re-fetching:
`useAccountMetrics` (server figures, PORT-RULINGS §1), `useTicker(s)`,
`useOrderBook`, `useInstruments`, `useRecommendedMarkets`,
`useRecentlyViewed`, `useWatchlists` / `useFavorites`, `useTradeBook`,
`useDashboard`, `usePriceAlerts`, `useGlobalAlerts`, `useEconomicCalendar`,
`useChannel` / `useForeground` / `useConnectionState`
(`websocket/channels.ts`: ticker, orderbook, candles, all 13 `user:*`
channels, `recommended:refresh`, `alerts:refresh`), and `useUsdInr`
(`src/hooks/useUsdInr.ts`, no hard-coded rate).

Deliberately not ported (backend routes the web never calls, or only dead
code calls): `/wallet/fx/*`, `/compliance/affiliate/*`,
`/auth/password-reset/request`, `/user/kyc*`, `/user/account-types`,
`/bonus-wallet/summary|deposit|manual-deposit`, `/compliance/whitelist`,
`/instruments/:symbol/volume-usage`, `/copy-trading/boxes/:id/purge`,
`/chat/conversations*` (manager inbox), `/broker/health` (admin). The web's
invented economic-calendar schedule is mock data and is not ported.

### Stores (`src/store/`)
- `auth.ts` — `useAuthStore` (shared interface): USER-only role gate, 2FA
  step, bootstrap that keeps tokens through offline / 5xx, socket
  `auth_error` recovery, push unregister on logout, `hydrateFromTokens`,
  `exitImpersonation`.
- `selectedAccount.ts` — `useSelectedAccountStore` + `selectSelectedAccount`
  (shared interface); follows the auth user, remembers the pick per user.
- `sessionScope.ts` — drops per-user caches (watchlists, global alert
  popups, account metrics) when the signed-in person changes. New per-user
  stores register their reset here (CONTRACT §8).
- `theme.ts`, `tradeSettings.ts` — ported with the web's storage keys.

### Shell (`src/navigation/`, `src/components/ui/`, `src/theme/`)
One native stack, signed-in / signed-out halves swapped on auth status and
keyed by user id (a "View As User" switch rebuilds the screens, like the web's
reload). Typed `RootStackParamList` (one entry per web route) and
`useAppNavigation()`. `webPaths.ts` transcribes App.jsx's route table both
ways (aliases, redirects, catch-all → Dashboard) and drives deep links.
Header, pill rail (`PRIMARY_NAV`, Broker only when
`brokerTerminalEnabled !== false`, **no bottom tabs**), profile sheet with
the account switcher and balance, impersonation banner, per-screen
ErrorBoundary. Full UI kit behind `@/components/ui` (Modal/BottomSheet with
the web's modal layers, ConfirmProvider, toast = react-hot-toast API).

### Auth screens (`src/screens/auth/`) — 6 routes
Login (2FA / backup code, recovery panel), Register (all validators, 41
countries, `?ref=` referral kept under `tradepro:pending-ref`), ForgotPassword
(3-step OTP), ResetPassword, VerifyEmail, OAuthCallback; `AuthShell` with the
animated candle background. Broker-login buttons are built but off
(`BROKER_LOGIN_ENABLED = false`), matching the web's "TEMPORARILY OFF".

### Tests — 600
| File | Tests |
|---|---|
| `rulings.test.ts` | 25 |
| `apiA_adapters` / `apiA_endpoints` / `apiA_stores` | 54 / 37 / 34 |
| `apiB_market` / `apiB_trading` / `apiB_watchlist` / `apiB_portfolio` | 33 / 24 / 10 / 24 |
| `apiC_broker` / `apiC_cmsNotifications` / `apiC_copyTrading` / `apiC_helpdesk` / `apiC_notificationGenerators` / `apiC_partner` | 35 / 24 / 40 / 25 / 11 / 22 |
| `shell.navigation` / `shell.render` / `shell.settings` / `shell.ui` | 60 / 12 / 16 / 32 |
| `authScreens.logic` / `authScreens.render` | 49 / 22 |
| `verify1_sessionScope` / `verify1_fx` | 6 / 5 |

No test touches the network (scripted axios adapters, in-memory keychain,
AsyncStorage mock).

### What the stage-1 verify pass reconciled
1. **Per-user caches leaked across users.** Nothing called
   `resetWatchlists / resetGlobalAlerts / resetAccountMetrics`; the next user
   (or the admin leaving "View As User") saw the previous one's lists,
   popups and figures. Added `store/sessionScope.ts` (keyed on user id),
   plus generation guards so a load in flight during the switch lands
   nowhere.
2. **Two push-token registrars.** `notificationsApi.register/unregisterPushToken`
   posted on their own, so a token registered through them survived
   sign-out. They now delegate to `userApi`, which remembers the token;
   `PushPlatform` has one definition (types/notifications, incl. `'unknown'`).
3. **Three broker-login redirect parsers.** Removed `authApi.brokerLoginProviders`,
   `brokerAuthorizeUrl`, `parseOAuthCallback` (it used `URLSearchParams.get`,
   which RN's polyfill does not reliably implement) and
   `types/broker.parseBrokerLoginRedirect`; `BrokerLoginProvider` now lives
   only in types/broker. One path remains: `brokerLogin` (api/broker) +
   `oauthParamsFromUrl` (screens/auth/logic/oauth, via webPaths).
4. **Two web-origin settings.** Partner referral links read
   `EXPO_PUBLIC_PUBLIC_URL`, deep links `EXPO_PUBLIC_WEB_ORIGIN`. Now one
   `WEB_ORIGIN` in constants/env (`EXPO_PUBLIC_WEB_ORIGIN` or
   `expo.extra.webOrigin`) feeds both.
5. **Light-only colour exports.** `constants/theme` `colors` / `useThemeColors`
   always returned the light palette (zero importers) — removed so nobody
   ports a screen against them.
6. **USD→INR hidden inside ProfileMenu.** Moved to the shared
   `hooks/useUsdInr` (one request, 5-min TTL, no fallback rate) for the
   Wallet / Dashboard / Trade / StockDetail / OrderForm ports.
7. **Kit gap from the auth port.** `Input` gained `tone="bull"`; Register's
   referral field now shows the web's `bg-bull/5 border-bull/40` when the code
   came from the link.

---

## Stage 2 — done (money and account)

Seven routes, built by six areas in parallel, each reviewed against the web
source and the backend controllers, then integrated.

| Route | Web source | Screen |
|---|---|---|
| Wallet (`/wallet`, `/accounts`, `/funds`) | `pages/Wallet.jsx`, `AccountOverview.jsx`, `TransactionHistory.jsx`, `WalletSidebar.jsx`, `WithdrawalMethods.jsx` | `screens/wallet/WalletScreen.tsx` |
| BonusWallet (`/bonus-wallet`, and `/subscription-wallet`, which redirects here — the Main Wallet is retired) | `pages/BonusWallet.jsx`, `components/DepositModal.jsx`, `WithdrawModal.jsx` | `screens/wallet/BonusWalletScreen.tsx` |
| Plans (`/plans`, `/bonuses`) | `pages/Plans.jsx` | `screens/plans/PlansScreen.tsx` |
| NewAccountTiers (`/accounts/new`) | `pages/NewAccountTiers.jsx` | `screens/accounts/NewAccountTiersScreen.tsx` |
| NewAccountConfigure (`/accounts/new/:tierCode`) | `pages/NewAccountConfigure.jsx`, `LeverageDropdown.jsx` | `screens/accounts/NewAccountConfigureScreen.tsx` |
| Profile (`/profile?tab=profile\|kyc\|security\|devices`) | `pages/Profile.jsx` | `screens/profile/ProfileScreen.tsx` |

### Files by area
| Area | Views / screens | Shared components | Logic (no React) |
|---|---|---|---|
| Wallet hub | `WalletScreen`, `RecentTransactions`, `views/OverviewView`, `views/AccountDetailsView`, `views/HistoryView` | `components/wallet/WalletNav.tsx` | `utils/walletLogic.ts` |
| Money flows | `views/DepositView`, `views/WithdrawView`, `views/WithdrawalMethodsView` (re-export) | `components/wallet/PayToCard.tsx`, `WithdrawalMethods.tsx`, `RazorpayCheckout.tsx` | `utils/fundsFlows.ts`, `utils/razorpay.ts`, `services/proofImage.ts` |
| Transfer | `views/TransferView` (own accounts + to another user) | — | `utils/transferLogic.ts` |
| User wallets | `BonusWalletScreen` | `components/wallet/BonusWalletDepositSheet.tsx`, `UserWalletWithdrawSheet.tsx` | `utils/userWallets.ts` |
| Plans + accounts | `PlansScreen`, `NewAccountTiersScreen`, `NewAccountConfigureScreen` | `components/accounts/LeverageSelect.tsx` | `utils/plans.ts` |
| Profile | `ProfileScreen` + `screens/profile/components/*` (hero, tab rail, details, KYC, security, devices) | `screens/profile/components/userPatch.ts` | `utils/profile.ts` |

How later stages use the shared pieces: CONTRACT §13.

**API additions (append-only, existing routes):**
`walletApi.depositDetailsWithMins()` (GET /wallet/deposit-details, keeps each
custom rail's `min`), `accountApi.createAccountFromWizard(body)` (POST
/user/accounts with the wizard's `baseCurrency` — `accountApi.create` strips
it), `complianceApi.uploadKycDocumentTimed(upload, timeoutMs)`.

**Package:** `expo-image-manipulator ~14.0.8` (deposit-proof compression to
the server's 700 KB data-URL cap). Native module: a dev-client build must be
rebuilt; Expo Go SDK 54 already has it. `app.json`: the `expo-image-picker`
plugin now sets `microphonePermission: false` (nothing records video), so
Android's RECORD_AUDIO and iOS's microphone string are no longer added.

### Decisions carried forward
- **Razorpay:** a WebView-hosted Checkout (`react-native-webview`, already a
  dependency), not `react-native-razorpay`. Opened only for an order with a
  `keyId` whose id does not start with `mock_`; `/wallet/razorpay/verify` is
  posted only from Checkout's success handler; no `payment.failed` handler
  (Razorpay's own modal offers the retry).
- **Practice withdrawals** attach the first verified method (the server's
  verified-method gate runs before its demo branch). None → the server's
  WITHDRAWAL_METHOD_REQUIRED message with "Add withdrawal method". A stale
  method refusal re-reads the list.
- **Real money is `isRealMoney` everywhere**: wallet totals, Main-wallet
  top-up sources, the "Below minimum deposit" total on the new-account pages
  (the web sums demo seeds too — deliberate, pinned in stage2_plans.parity).
- **MAX never rounds up**: the decimal string is floored to cents
  (`maxWithdrawAmount`, `shareOf`). **Amounts** keep one decimal point and are
  posted canonical (`"10."` → `"10"`), because the server books the string.
- **History "All Time"** ignores hidden custom dates (web bug not copied).
- **No renew button** — POST /subscriptions/renew bills the Bonus Wallet.
- **`/wallet?view=<id>`** is honoured (the web's sidebar emits it and nothing
  reads it). The wallet rail goes back to an already-open Wallet / Main /
  Bonus screen (`pop: true`), like the app's pill rail.
- **Live data:** the Wallet re-reads on `user:wallet` / `user:positions`,
  foreground, pull-to-refresh and return from another screen, passing
  `refreshKey` into the open view; each source applies only its newest
  answer. Deposit / Withdraw / Transfer views also re-read on their own
  (`useLiveWalletReload`).
- **Transfer:** a confirm sheet closes if its source / destination / currency
  changes under it; a failed limits-and-fee read is shown with Retry and a
  "fee not included" note in the confirm.
- **Profile:** fields the server confirmed (2FA on/off, saved profile,
  "already verified") are applied to the signed-in user before the /auth/me
  re-read, and `refreshUser` now applies only the newest answer and nothing
  older than a write (store/auth.ts, integration pass).
- **Overview Margin Level** shows the LOWEST server margin level among live
  accounts with margin in use, not the web's pooled ratio — needs sign-off.

### Integration pass (2026-09-30)
1. Registered the seven screens; every web path above (incl. `/accounts`,
   `/funds`, `/bonuses`, `/wallet?action=` / `?view=`, `/profile?tab=`,
   `/accounts/new/:tierCode`) resolves to them — `stage2_integration`.
   The header's avatar menu already pointed at Wallet (Balance) and Profile
   (Settings), as Layout.jsx does.
2. WalletScreen passes `refreshKey` to DepositView / WithdrawView.
3. `views/WithdrawalMethodsView.tsx` re-exports the shared view (contract path).
4. WalletNav navigates with `pop: true` (two stacked Wallets each reloaded on
   every wallet event).
5. `store/auth.ts` `refreshUser` ordering guard (a late answer could undo 2FA,
   or write the previous person back after a sign-out / View-As switch).
6. `utils/plans.ts` re-exports `planPeriodEnd` from `utils/userWallets.ts`
   (was a second copy).
7. Kit `Icon` gained `arrowDown` (BonusWallet.jsx:173's Withdraw button).
8. `app.json` microphone permission off (above).

### Stage 2 tests — 719
| Suites | Tests |
|---|---|
| `stage2_walletHub` logic / api / render | 98 / 17 / 32 |
| `stage2_moneyFlows` logic / payload / proof / render | 92 / 19 / 6 / 29 |
| `stage2_transfer` logic / payload / render | 60 / 14 / 27 |
| `stage2_userWallets` logic / payload / render | 41 / 19 / 24 |
| `stage2_plans` parity / payload / render | 29 / 9 / 42 |
| `stage2_profile` logic / payload / render | 71 / 8 / 47 |
| `stage2_integration` / `stage2_integration.auth` | 29 / 6 |

Every money submit has a payload test that reads the backend controller's
`req.body` destructure from source; web logic is lifted with `new Function`
where practical; render tests mount real native stacks with a recording
axios adapter. Render suites use real timers — a full parallel run takes
~60 s; `stage2_walletHub.render` sets `jest.setTimeout(30_000)` for CPU
contention. Earlier parallel runs saw one-off timeouts in
`stage2_moneyFlows.render` / `stage2_transfer.render` while other agents
were running jest; two full runs in the integration pass were clean.

---

## What remains

No route is left on `ComingSoonScreen`. Not ported on purpose:
`/preview/order-modal` (dev page), `/download` (the web's placeholder for
this app), `pages/Affiliate.jsx` (dead — `/affiliate` renders Partner).

What is owed, in order:
1. **Finish the device run.** Started 2026-09-30 on the Android emulator
   (Pixel_8a AVD, Expo Go 54.0.8) against the live API: the app loaded,
   the socket authenticated, sign-in and several screens worked. Found and
   fixed there (pinned by `device1_layout` + `stage4_integration`):
   - gradient boxes drawn at the parent's size MINUS its padding (Landing
     CTAs, Partner cards, Profile hero, impersonation banner) — every
     full-bleed SVG is now `components/common/FillSvg`;
   - the Landing header scrolled away and the page slid under the status
     bar — it is sticky now, as LandingHeader.jsx is on the web;
   - coin logos that came back empty logged red "Unexpected end of input"
     errors (react-native-svg `SvgUri` sends parse errors to console.error,
     not `onError`) — `AssetIcon` now fetches, checks and parses them itself
     and falls back to the ticker tile.
   Still unverified on a device: the Trade screen and chart (touch, the
   WebView bridge), performance, iOS. How to run it again:
   `EXPO_PUBLIC_API_URL=https://trading.starworldz.com
   EXPO_PUBLIC_WS_URL=wss://trading.starworldz.com/ws
   EXPO_PUBLIC_WEB_ORIGIN=https://trading.starworldz.com npx expo start
   --localhost --clear`, boot the AVD, `adb reverse tcp:8081 tcp:8081`,
   `adb shell am start -a android.intent.action.VIEW -d exp://127.0.0.1:8081
   host.exp.exponent`. (The WS URL must be set too — app.json's `wsUrl`
   points at the emulator host.) Saving a file hot-reloads into whoever is
   using the app — make multi-part edits in one write.
2. **An adversarial review** of stages 3, 4 and 5, one area at a time
   (stage 2 had one; the rest were written without it).
3. The backend items under "Open issues" — they need the user's go-ahead.

Every chrome slot is filled (`src/navigation/chromeSlots.tsx`): HeaderSearch
→ SearchModal, HeaderBell → NotificationCenter, GlobalOverlays →
GlobalAlertPopup, AppProviders → WatchlistModalProvider, PageFooter →
CmsFooter.

## Stage plan

**Stage 2 — money and account. DONE** (see "Stage 2 — done" above).

Later stages that touch money start from CONTRACT §13: a link into the
Wallet is `nav.navigate('Wallet', { action } | { view }, { pop: true })`
(or `navigateToPath('/wallet?action=deposit')` for a server-sent URL);
nothing outside the wallet pages renders the flows themselves.

**Stage 3 — markets and portfolio. DONE (see "Stage 3 — done"; review pass still owed).** Was: Dashboard, Explore (GLOBAL / INDIA /
CRYPTO, Products & Tools), MarketList, Watchlist (+ WatchlistModalProvider),
StockDetail (inline-SVG chart, fundamentals, news, order book), F&O home,
Option chain, price Alerts (+ GlobalAlertPopup), News + NewsArticle, Reports
(CSV share), Orders, plus SearchModal and the NotificationCenter bell.
StockDetail's Buy / Sell opens `OrderModalUI` + `OrderForm`, which stage 5
builds — build those two first in stage 5, or pull them into the end of
stage 3; do not ship a simplified order sheet.

**Stage 4 — social, partner, support, broker, public. DONE** (see "Stage 4 — done"). Was: CopyTrading,
TraderDashboard, Partner (serves `/affiliate` and `/ib-room` too),
Helpdesk, HelpdeskChat, Feedback, Broker terminal (`components/broker/*`),
Landing, CmsPage + CmsFooter.

**Stage 5 — the Trade page. DONE** (see "Stage 5 — done"). Was:
`Trade.jsx` (5263 lines), the positions / orders / history book
(`useTradeBook`), and the `PriceChart` WebView bridge over the vendored
lightweight-charts: `ChartDrawingToolbar` (88 tools), `indicatorCatalog`,
`ChartSettings`, `MultiChartToolbar`, TradeSettingsDrawer. Trade has no
header or rail, as on the web; its own top bar's brand mark goes back.

## Open issues carried forward

Backend / infra (not app code):
- **Broker login cannot return to the app.** `brokerLoginController.callback`
  always redirects to `${FRONTEND_URL}/oauth/callback#…`. Needs an
  allow-listed app redirect carried in the signed `state`, or universal /
  app links for the web origin. App side is built and tested; the buttons
  stay off, as on the web.
- **Broker OAuth *connect* callback** (`GET /api/broker/oauth/:broker/callback`)
  requires a signed-in request, so a broker's browser redirect cannot finish
  it (same on the web).
- **Push cannot deliver yet.** `backend/src/services/pushService.js` posts to
  the legacy FCM endpoint (`fcm.googleapis.com/fcm/send`, shut down by
  Google) with the token as `to`; an `ExponentPushToken` will not deliver.
  Needs FCM v1 or Expo push server-side, or the app registers the native
  device token. No push-registration hook exists yet (stage 3, with the bell).
- **BLOCKER — every Main and Bonus Wallet withdrawal gets 400** "method must
  be UPI, BANK or CRYPTO". `subscriptionWalletController.requestWithdrawal`
  and `bonusWalletController.requestWithdrawal` call `_legacyDestination(req.body)`
  before `resolveDestination`, so the `{ amount, withdrawalMethodId }` body the
  web and the app send is always refused. Fix server-side: build the legacy
  destination only when there is no `withdrawalMethodId`. The test "the
  server still demands a legacy destination first"
  (stage2_userWallets.payload) fails once it is fixed — delete it then.
- ~~SECURITY — free Main Wallet money / practice money into real wallets~~ —
  fixed server-side with the Main Wallet's retirement (commit 678bded): the
  Main Wallet's money routes answer 410, `/subscriptions/subscribe` no longer
  reads a client `paymentRef`, and demo money only moves between demo
  accounts (PRACTICE_TRANSFER_NOT_ALLOWED).
- **Razorpay mock mode** still approves any verify, and creates a PENDING
  deposit row per mock order. The app never opens or verifies a `mock_`
  order (see memory `wallet-open-findings`).
- **Practice-account withdrawals** — the verified-destination gate runs
  before the demo branch (400 `WITHDRAWAL_METHOD_REQUIRED`). The app attaches
  the first verified method; fix the order server-side to drop that need.
- **`POST /wallet/convert`** falls back to `FX_DEFAULT_RATE` (83) when no
  `fxRate` is sent, and neither client sends one, so the credited amount can
  differ from the live-rate preview (labelled an estimate). Decide: server
  uses the live rate, or the app sends it (needs a new api method —
  `ConvertInput` has no rate field).
- **Payout rail `withdrawalEnabled`** is not enforced by `requestWithdrawal`;
  only the clients honour it.
- **`GET /api/trading/account-metrics`** is uncommitted backend work (Stage 1
  → Backend). Check it is deployed before shipping: without it the Wallet
  overview shows "Live account figures could not be loaded".
- **Base currency:** the new-account wizard offers USD / INR / EUR / GBP as
  the web does; `userController.createAccount` refuses all but USD
  (UNSUPPORTED_BASE_CURRENCY), and the app shows that refusal.
- **`POST /subscriptions/renew`** bills the Bonus Wallet, as subscribe now
  does; the web never calls renew, so neither does the app.
- 2FA at login is commented out server-side (`authController.js:233`); the
  app handles `2FA_REQUIRED` already.

Configuration:
- `WEB_ORIGIN` is unset (no `EXPO_PUBLIC_WEB_ORIGIN` / `expo.extra.webOrigin`
  in app.json). Until it is set, only `equityhub://` links open the app
  and partner referral links are built on the API host. Browser links also
  need Android App Links / iOS Universal Links (app.json + the server's
  association files).
- `app.json` `extra.apiBaseUrl` is the emulator host `http://10.0.2.2:5000`.
  Point it (or `EXPO_PUBLIC_API_URL`) at the live API to test against prod.
- Fonts are not bundled (platform default; numbers use tabular figures).

Product decisions:
- LoginScreen shows the web's demo line word for word
  (`Demo: trader@tradingplatform.local / Trader@12345`). Confirm it belongs
  in the store build.
- The name rule (web and app alike) rejects Devanagari names written with
  vowel signs (`\p{L}` without `\p{M}`); fix both together if wanted.
- The profile menu offers USD and INR only; the web's GBP / EUR use
  hard-coded 0.79 / 0.92 rates, which PORT-RULINGS §4 forbids.
- Deliberate differences from the web, documented in code: Helpdesk ticket
  list also keeps tickets filed from `/helpdesk`; feedback tickets carry the
  app version; Login toasts a `brokerError` param; VerifyEmail refreshes the
  signed-in user after success.
- Stage 2, needs sign-off:
  - Overview **Margin Level** = lowest server margin level among live
    accounts with margin in use (the web pools Σequity / Σlocked).
  - The retired Main Wallet's old history rows read **"Main Wallet (closed)"**
    (TransactionHistory / AccountOverview), as on the web.
  - Plans' **"Top up to upgrade →"** under a plan card opens the Bonus Wallet
    (plans bill it); the web's link still points at `/wallet`.
  - The wallet rail shows **Withdrawal Methods** everywhere (Wallet.jsx
    NAV_ITEMS); the web's WalletSidebar on the new-account pages omits it.
  - Copy with no web equivalent, for product to keep or cut: the transfer
    fee notes ("Fee shown is an estimate — the server calculates the amount it
    debits.", "Couldn't load the transfer limits and fee. The server applies
    them when you send.", "The fee could not be loaded, so it is not included
    — the server calculates the amount it debits."), the Wallet's "Some
    wallet data could not be loaded" / "Live account figures could not be
    loaded" banners, the practice-withdrawal note, and Profile's camera
    wording ("Camera access is off", "…Turn it on in Settings…", "Open
    Settings").
  - PayToCard omits the web's "Pay to these details · Verified" header above
    an unconfigured rail's warning (a Verified badge over nothing).
- Stage 5, needs sign-off: the list under "Stage 5 → Deliberate
  differences" — above all the equity strip showing server figures, and
  Market Depth showing only the real book (no synthetic levels). One-click
  orders send `destination: 'PLATFORM'` explicitly (the shared order
  payload always does; the web's one-click omits it and the server
  defaults to the platform).
- Cosmetic, kit-level: the Modal's header × stays visually enabled while a
  non-dismissible sheet is busy (the web's Modal.jsx does the same; every
  caller guards `onClose`); the transfer amount field shows its error above
  the Min / Max / Fee line (the web: below).
- The web still has the transfer bugs fixed here (a peer confirm can post
  from an account the trader did not pick; a failed settings read means "no
  fee"). Worth fixing in Wallet.jsx if the web is maintained.

Guidance for later stages:
- Portfolio P&L notifications and every equity / margin figure come from
  `useAccountMetrics`, never re-derived from ticks.
- `package.json` still lists `@react-navigation/bottom-tabs` and `drawer`;
  neither is used (the product has no bottom tab bar). Harmless; remove when
  convenient.

## Verify

```bash
cd advance-ai-trader
npx tsc --noEmit     # expect clean
npx jest             # expect 51 suites, 1626 passed (~35–70 s)
npx expo export --platform android --output-dir <temp dir outside the repo>
npm start            # Expo dev server
```

Backend:

```bash
cd backend && node tests/accountMetricsEndpoint.test.js   # 14 passed
```

## To restart

All five stages are done. Say **"advance-ai-trader device test karo"** (run
it on a phone / emulator against the live API) or **"advance-ai-trader
review karo"** (the owed review of stages 3–5). Start by reading
`docs/PORT-RULINGS.md`, `docs/CONTRACT.md` and this file.
