# Screen-porting contract

How to port a web page into this app so it fits the shell, the kit and the
rulings. Read `docs/PORT-RULINGS.md` first; this file assumes it.

The goal is **feature-for-feature parity with `client/`**: same data, same
wording, same behaviour. No mock data, no simplified versions, no invented
endpoints.

---

## 1. Where things go

```
src/
  screens/<area>/<Name>Screen.tsx   one screen per web page, NAMED export
  screens/<area>/components/…       pieces only that screen uses
  components/ui/                    the UI kit — import from '@/components/ui'
  components/<area>/…               pieces shared by several screens of an area
  api/<domain>.api.ts               every HTTP call (already written — use them)
  store/                            app-wide zustand stores
  theme/                            the theme runtime — import from '@/theme'
  navigation/                       routes, header, rail, deep links
  utils/money.ts                    ALL money / number formatting
  __tests__/<area>*.test.ts         jest tests for pure logic
```

- A screen file exports `export function WalletScreen(props: AppScreenProps<'Wallet'>)`.
  Named, not default.
- One web page → one screen. A web modal (`DepositModal.jsx`) → a component
  that renders `<Modal>` / `<BottomSheet>`, next to the screen that opens it.
- Do not edit `src/components/ui`, `src/theme`, `src/navigation` (except the
  two registries below), `App.tsx`, or another area's files. Ask for a kit
  change instead of forking a component.

## 2. Registering a screen

Every route already exists; the ones not ported yet point at
`ComingSoonScreen` (13 of 35 are ported after stage 2 — RESUME.md lists the
rest). To plug yours in, edit **`src/navigation/screenRegistry.ts`** only:

```ts
import { WalletScreen } from '@/screens/wallet/WalletScreen';
…
  Wallet: WalletScreen,
```

That is the whole change. The navigator, the header, the pill rail and the deep
links read from the registry and from `src/navigation/types.ts`.

Routes (`RootStackParamList` in `navigation/types.ts`), one per web route:

| Route | Web path(s) | Params |
|---|---|---|
| Landing | `/` (visitor) | — |
| Login | `/login` | — |
| Register | `/register` | `ref?` |
| ForgotPassword | `/forgot-password` | — |
| ResetPassword | `/reset-password` | `token?` |
| VerifyEmail | `/verify-email` | `token?` |
| CmsPage | `/page/:slug` | `slug` |
| News / NewsArticle | `/news`, `/news/:slug` | `slug` |
| Explore | `/explore` | `section?: 'market-news'` (`/explore#market-news`) |
| Dashboard | `/dashboard` | — |
| MarketList | `/markets` | `view?`, `sector?` |
| Options | `/options`, `/option-chain` | `underlying?`, `expiry?` |
| Watchlist | `/watchlist`, `/wishlist`, `/favorites` | `share?` |
| Trade | `/trade` | `symbol?`, `view?: 'terminal'` |
| StockDetail | `/stock/:symbol` | `symbol` |
| Orders, Reports | `/orders`, `/reports` | — |
| Alerts | `/alerts` | `symbol?` (emitted by StockDetail, ignored by the web — prefill or ignore deliberately) |
| Partner | `/partner`, `/affiliate`, `/ib-room` | — |
| Plans | `/plans`, `/bonuses` | — |
| BonusWallet | `/bonus-wallet`, `/subscription-wallet` (the web redirects the retired Main Wallet here) | — |
| CopyTrading | `/copy-trading` | — |
| TraderDashboard | `/copy-trading/trader/:id` | `id`, `account?` |
| Wallet | `/wallet`, `/accounts`, `/funds` | `action?: 'deposit'\|'withdraw'\|'transfer'`, `view?` (ignored by the web; the port opens that hub view — §13) |
| NewAccountTiers | `/accounts/new` | — |
| NewAccountConfigure | `/accounts/new/:tierCode` | `tierCode` |
| Profile | `/profile` | `tab?: 'profile'\|'kyc'\|'security'\|'devices'` |
| Helpdesk | `/helpdesk` | `tab?: 'chat'\|'faq'\|'tickets'\|'new'`, `q?` |
| HelpdeskChat | `/helpdesk/chat` | — |
| Feedback | `/feedback` | — |

Not ported on purpose: `/preview/order-modal` (dev preview), `/download` (the
web's "get the mobile app" placeholder).

## 3. Navigation

```ts
import { useAppNavigation, useAppRoute, navigateToPath } from '@/navigation';

const nav = useAppNavigation();
nav.navigate('StockDetail', { symbol: 'RELIANCE' });   // typed: wrong name/params = compile error
const { params } = useAppRoute<'StockDetail'>();

navigateToPath('/wallet?action=deposit');   // web URLs: CMS links, notification `link`s, server redirects
```

- **Web `navigate('/x')` / `<Link to="/x">`** → `nav.navigate('X', …)`. When the
  source is a string URL you did not write (CMS HTML, a notification payload),
  use `navigateToPath` — it applies the web's aliases and redirects and parks
  protected paths behind Login.
- **Never navigate after login, register or logout.** The root navigator swaps
  the signed-in / signed-out halves when `useAuthStore` status changes; a
  protected deep link opened while signed out is taken automatically after
  sign-in (the web's `location.state.from`).
- **A change of signed-in user rebuilds every signed-in screen at Explore**
  (a "View As User" link, or "Return to Admin" falling back to the device's
  own sign-in — both are page loads on the web). A screen does not need to
  watch `user.id` to drop the previous user's data; it is unmounted.
- **`Trade` has no header and no rail** (Layout.jsx hides both on `/trade`).
  The Trade screen must draw its own top bar with a way back
  (`nav.goBack()`), because iOS has no hardware back.
- Every other signed-in screen gets the app header (logo, search slot, theme
  toggle, bell slot, avatar → profile menu), the pill strip (Watchlist · Copy
  Trading) and the bottom tabs (Explore · Option Chain · Positions · Portfolio ·
  Wallets) — together the EquityHub web's mobile nav, in its order. Do not draw
  your own page header above `Screen` — use `PageHero` inside it.
- Outside React (a push-notification tap, a store): `navigationRef` from
  `@/navigation`; check `navigationRef.isReady()` first.

### Chrome slots — `src/navigation/chromeSlots.tsx`

The second shared edit point. Replace the `null` / add to the list when your
feature lands:

| Slot | Web component | Renders |
|---|---|---|
| `HeaderSearch` | SearchModal + its trigger | its own `IconButton name="search"` and its modal |
| `HeaderBell` | NotificationCenter | the bell + badge, panel as a `BottomSheet` |
| `PageFooter` | CmsFooter | footer under every scrolling app screen |
| `GlobalOverlays` | GlobalAlertPopup | mounted once, above the navigator |
| `AppProviders` | WatchlistModalProvider | wraps the navigator, outermost first |

## 4. Anatomy of a screen

```tsx
import { useCallback } from 'react';
import { Button, Card, ErrorView, KeyValueRow, LoadingView, PageHero, Screen, toast } from '@/components/ui';
import { errorMessage } from '@/api/client';
import { walletApi } from '@/api/wallet.api';
import type { AppScreenProps } from '@/navigation';
import { fmtMoney } from '@/utils/money';

export function BonusWalletScreen({ navigation }: AppScreenProps<'BonusWallet'>) {
  // load with the api module; keep loading / error / data states explicit
  …
  if (loading && !data) return <Screen><LoadingView /></Screen>;
  if (error && !data) return <Screen><ErrorView error={error} onRetry={load} /></Screen>;
  return (
    <Screen onRefresh={load}>
      <PageHero eyebrow="Wallets" title="Bonus Wallet" subtitle="…web copy verbatim…" />
      <Card>
        <KeyValueRow label="Balance" value={fmtMoney(data.balance, data.currency)} mono />
      </Card>
    </Screen>
  );
}
```

- **Always root the screen in `<Screen>`** (or use `useSafeAreaInsets()` for a
  fully custom root). Never `<SafeAreaView>` — the read-only impersonation
  banner zeroes the top inset through context and SafeAreaView bypasses it.
- `Screen` handles the background, safe area, the web's page padding
  (`px-4 py-6`), keyboard avoidance, pull-to-refresh and the page footer.
  `scroll={false}` when the screen owns a `FlatList`; `padded={false}` for
  edge-to-edge content.
- Lists: `FlatList` / `SectionList`, never `.map` over an unbounded server list
  inside a ScrollView.
- Copy: use the web's strings verbatim — labels, empty states, button text,
  toasts, confirm messages.

## 5. UI kit — `@/components/ui`

| Component | One-line use |
|---|---|
| `Screen` | `<Screen onRefresh={load} scroll padded>…</Screen>` — root of every screen |
| `AppText` | `<AppText variant="h1\|h2\|h3\|title\|body\|bodyStrong\|small\|caption\|micro\|label\|eyebrow" tone="muted\|bull\|bear\|brand" mono>` |
| `Icon` | `<Icon name="wallet" size={18} color={t.colors.textMuted} />` — the web's inline stroke icons (`ICON_NAMES`) |
| `Button` | `<Button title="Deposit" variant="primary\|secondary\|ghost\|danger\|bull\|bear" size="sm\|md\|lg" loading leftIcon="plus" fullWidth />` |
| `IconButton` | `<IconButton name="close" accessibilityLabel="Close" onPress={…} />` — header-style `p-2 rounded-lg` |
| `Card` | `<Card variant="card\|panel\|plain" padded onPress>` — `.card` / `.panel` |
| `Divider` | `<Divider strong spacing={8} />` |
| `PageHero` | `<PageHero eyebrow="Trading" title="Orders" subtitle="…" actions={<Button …/>}>chips</PageHero>` |
| `Input` | `<Input label="Amount" value onChangeText error={err} hint keyboardType="decimal-pad" mono left right />` |
| `PasswordInput` | `<PasswordInput label="Password" autoComplete="new-password" />` — eye toggle built in |
| `Select` | `<Select label="Account" value options={[{value,label,description}]} onChange />` — bottom-sheet picker, auto search > 8 |
| `Segmented` | `<Segmented options={[{value:'MARKET',label:'Market'},…]} value onChange size="sm" />` |
| `Tabs` | `<Tabs tabs={[{key:'kyc',label:'KYC',badge:2}]} value onChange variant="underline\|pill" fill />` |
| `Toggle` / `SwitchRow` / `Checkbox` | `<SwitchRow label="Alerts sound" description value onValueChange />` — the web's Toggle |
| `Badge` / `Pill` | `<Badge label="PENDING" tone="primary\|bull\|bear\|neutral\|warn\|info\|demo\|live" solid size="xs" />` |
| `KeyValueRow` | `<KeyValueRow label="Leverage" value={fmtLeverage(a.leverage)} mono divider onPress />` |
| `StatTile` | `<StatTile label="Equity" value={fmtMoney(m.equity,'USD')} sub="…" tone="bull" loading />` — `.stat-card` |
| `MenuItem` | `<MenuItem icon="reports" label="Reports" onPress chevron danger />` |
| `SectionHeader` | `<SectionHeader title="Open positions" actionLabel="See all" onAction />` |
| `LoadingView` | `<LoadingView />` (block) or `<LoadingView fullScreen />` — spinner + "Loading…" |
| `ErrorView` | `<ErrorView error={caught} onRetry={load} compact />` — shows the server's message |
| `EmptyState` | `<EmptyState icon="inbox" title="No orders yet" message="…" actionLabel="Trade" onAction />` |
| `Skeleton` / `SkeletonText` | `<Skeleton width="60%" height={14} />` — pulse placeholder |
| `Spinner` | inline `ActivityIndicator` in the brand colour |
| `ErrorBoundary` | already wraps every screen; use it around a risky widget if you want a smaller blast radius |
| `Modal` | `<Modal open onClose title="Deposit" footer={…} size="md" dismissible={false} initialFocus={ref} scrollable>` — Modal.jsx port; sheet on phones, centred ≥ 640dp |
| `BottomSheet` | same props as Modal, always a sheet, drag handle + swipe-down |
| `ConfirmDialog` | controlled confirm with a `loading` state |
| `useConfirm` | `if (await confirm({ title, message, confirmText, danger: true })) …` — also takes a bare string |
| `toast` | `toast.success('…')`, `toast.error(errorMessage(e))`, `toast('…', { icon: '🔐' })`, `toast.loading` + `{ id }`, `toast.dismiss(id)` |
| `orderToast` | `orderToast('Order placed')` — 4s success with a × (utils/toast.jsx) |
| `AssetIcon` | `<AssetIcon row={instrument} size={32} round />` — AssetIcon.jsx logic (logo, coin CDN, commodity art, flag pair, index/stock tiles) |
| `CountryFlag` | `<CountryFlag currency="EUR" width={20} />` |
| `BrandLogo` | `<BrandLogo variant="icon\|full\|stacked" height={36} />` — EquityHub's transparent art with light/dark twins |
| `Portal` | render into the overlay layer at a `Z` level — the Modal already does this |

**Overlays render in a portal above the navigator.** Their content sees the
app-level providers (theme, navigation, confirm, toasts, selected account)
but **not** a React context your screen created itself — pass such values as
props. Stacking follows `Z` (`@/theme`): modal 1000 < critical 1100 (confirm)
< toast. A modal opened from a modal just works.

## 6. Theme — `@/theme`

```ts
import { makeStyles, useTheme, useAppearance } from '@/theme';

const useStyles = makeStyles((t) => ({
  row: { backgroundColor: t.colors.bgCard, borderColor: t.colors.borderDark, borderRadius: t.radius.xl, padding: t.space.lg },
}));
…
const t = useTheme();      // t.colors, t.space, t.radius, t.text, t.shadow, t.z, t.alpha(hex, 0.1)
const s = useStyles();
```

- **Never** import colours from `@/constants/theme` inside a component. It
  holds the raw palettes only (the static `colors` / `useThemeColors` that
  always returned LIGHT were removed in the stage-1 verify pass). Use
  `useTheme()` / `makeStyles`, which follow the user's theme.
- Colour names are the web's tokens: `bgDark, bgCard, bgPanel, bgHover,
  borderDark, borderSubtle, textPrimary, textSecondary, textMuted, inputBg`,
  plus `primary, primaryText, primarySoft, onPrimary, bull, bear, bullSoft,
  bearSoft, surface, overlay`. `surface` is the web's `bg-white` (white in
  light, the card colour in dark — index.css:139).
- Web `text-white` / `text-gray-*` on auth pages: use `compatWhite`,
  `compatGray300/400/500` — they carry the light-mode overrides from index.css.
- Theme controls (settings screen): `useAppearance()` → `{ mode, appearance,
  setAppearance('light'|'dark'|'system'), toggle }`.

## 7. Calling the API

Every endpoint is already wrapped in `src/api/<domain>.api.ts`:

`account` (accountApi) · `alerts` · `auth` (authApi) ·
`cms` (cmsApi) · `compliance` (complianceApi) · `copyTrading` ·
`dashboard` · `feedback` · `helpdesk` · `instruments` · `market` · `news` ·
`notifications` · `partner` · `reports` · `subscription` · `trading` ·
`user` (userApi) · `wallet` (walletApi) · `watchlist`.

- Use those functions. Do not call `api.get('/…')` from a screen; if an
  endpoint is missing, it is added to the api module (with a tolerant adapter
  using `rows/one/str/num/dec/bool/id` from `@/types/api`), and it must be an
  endpoint the web or `backend/src/routes` actually has.
- Errors: `errorMessage(err)` from `@/api/client` (the server's wording first).
  Show it with `toast.error` for actions, `ErrorView` for failed loads.
- Read-only "View As User": mutating calls reject with `ReadOnlyError` before
  leaving the app. Catch it like any error — `errorMessage` has the web's text.
- Live data: prefer the api modules' hooks/stores (`useAccountMetrics`,
  `useTicker(s)`, `useInstruments`, `useWatchlists`, `useTradeBook`, …) — they
  share one socket subscription per channel and refetch on foreground.

## 8. Stores

| Store | Use |
|---|---|
| `useAuthStore` (`@/store/auth`) | `user` (AuthUser), `status`, `error`, `login`, `register`, `logout`, `refreshUser`, `setUser`, `hydrateFromTokens`. Call `refreshUser()` after a profile/KYC/2FA change; it is silent on failure and applies only its newest answer, and nothing sent before another write of the user. When the server's answer already confirms the change, lay it over the held user first — `applyToSignedInUser(user.id, fields)` (`screens/profile/components/userPatch.ts`) — so a lost re-read cannot show the old state. If `error` is set on the signed-out stack after launch, the session may be intact but offline — offer a retry that calls `bootstrap()`. |
| `useSelectedAccountStore` (`@/store/selectedAccount`) | `accounts`, `selectedId`, `select(id)`; `selectSelectedAccount(state)` for the account object. Loads itself on sign-in and on wallet events — do not refetch `/user/accounts` in a screen for "the" account. |
| `useThemeStore`, `useTradeSettings` | theme / trade settings (TradeSettingsDrawer, OrderForm prefs). `useTradeSettings(s => s.autoTrading.confirmOrder)`, `set('showOnChart.tpsl', v)` — typed dot paths. |
| `useUsdInr()` (`@/hooks/useUsdInr`) | The live USD→INR rate or `null` — the web's `useFxRate` without its hard-coded 83. `null` means show the figure unconverted, in its own currency (PORT-RULINGS §4). One request app-wide, 5-minute TTL. |

Screen-local state stays in the screen. A new app-wide store needs a reason.

**Per-user state must be dropped when the person changes.** The web got this
free from the page reload on sign-out; here the JS context survives. A new
module-level store that holds one user's data adds its reset to
`resetUserScopedState()` in `src/store/sessionScope.ts` (keyed on the user id,
so a `refreshUser()` of the same person keeps it). Watchlists, global alert
popups and account metrics are registered there; `useSelectedAccountStore`
follows the user itself.

## 9. Money and numbers

`@/utils/money` only: `fmtMoney(v, currency)`, `fmtPnl`, `fmtNum`, `fmtPrice(v,
precision, quoteCurrency)`, `fmtPercent`, `fmtMarginLevel`, `fmtLeverage`,
`currencySymbol`, `EMPTY` (—).

- Never `toLocaleString`, never `toFixed` for display, never a hand-built `$`.
- Decimals from the server are strings (`Decimal`); keep them strings to the
  formatter. Parse only to compare.
- Instrument prices use the INSTRUMENT's quote currency (₹ for NSE), account
  money uses the account's currency.

## 10. PORT-RULINGS in one screen

1. **Margin level / equity / free margin**: display `GET /trading/account-metrics`
   (`useAccountMetrics(accountId)`); compute none of it. `'0'` margin level =
   "no margin in use" → `fmtMarginLevel` shows —.
2. **P&L sign**: display the server's `unrealizedPnl`; prefer `positionSide`.
3. **Demo vs real**: `isDemoLike` / `isRealMoney` from `@/utils/accountType`.
   Never `accountType === 'REAL'`.
4. **USD→INR**: `walletApi.usdInr()`; `rate` null ⇒ show the unconverted figure
   in its own currency. No hard-coded rate anywhere (not 83, not 88).
5. **Grouping follows the currency** (₹ → 12,34,567.89; else 1,234,567.89) —
   `utils/money` does it. Dates: device locale + time zone unless the server
   formatted them.
6. **Charges**: a client-side preview must be labelled an estimate; history and
   P&L show the booked server figure.
- Do not port: `Affiliate.jsx`, `OrderBook.jsx`, `FundingQuote.jsx`,
  `utils/accountTypes.js`, `utils/currency.js`, `hooks/useAccountMetrics.js`.

## 11. Tests

- `src/__tests__/<area>*.test.ts`, jest (`jest-expo` preset). Run
  `npx jest src/__tests__/<area>` and `npx tsc --noEmit` before handing over.
- Test the pure logic you write: adapters, reducers, formatters, validators,
  anything that decides a number or a label. Pin it against the web's
  behaviour, and where the port deliberately differs, assert the difference
  (see `rulings.test.ts`).
- No network: mock the api module or pass fixtures. For AsyncStorage:
  `jest.mock('@react-native-async-storage/async-storage', () => jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'))`.
- Keep pure logic in a file without React imports when you can — it tests
  faster and more reliably.

## 12. Deep links

Scheme `equityhub://<web path>` (app.json). Web URLs open the same
screen when `EXPO_PUBLIC_WEB_ORIGIN` (or `expo.extra.webOrigin`) names the web
origin (read once, as `WEB_ORIGIN` in `@/constants/env`; partner referral
links are built on the same value) — universal links / app links also need the platform association,
which is not configured yet. Admin "View As User" links
(`equityhub://imp?token=…&info=…`, or the web's `#imp=…`) start a
read-only session and never navigate. All of it resolves through
`navigation/webPaths.ts`, the transcription of App.jsx's route table.

## 13. Money: the shared wallet pieces (stage 2)

Every money flow is built once, in the Wallet family. A later screen **links
to it**; it does not re-implement a deposit, withdrawal, transfer or plan
purchase, and it does not render the hub's views.

### Linking into money

| To open | Call |
|---|---|
| Deposit / withdraw / transfer (trading account) | `nav.navigate('Wallet', { action: 'deposit' \| 'withdraw' \| 'transfer' }, { pop: true })` |
| A hub view | `nav.navigate('Wallet', { view }, { pop: true })` — `view`: `details`, `overview` (default), `grow` (deposit), `withdraw`, `withdrawal-methods`, `transfer`, `history` |
| Bonus Wallet (plans are billed from it; the Main Wallet is retired) | `'BonusWallet'` |
| Plans / open a new account | `'Plans'` / `'NewAccountTiers'` (→ `'NewAccountConfigure', { tierCode }`) |
| A Profile tab | `nav.navigate('Profile', { tab: 'kyc' \| 'security' \| 'devices' })` |
| A server-sent URL | `navigateToPath('/wallet?action=deposit')` — aliases resolve as on the web |

`pop: true` goes back to a Wallet already in the stack instead of stacking
a second one (each mounted Wallet reloads on every wallet event). The
Wallet re-reads everything when it is come back to, and clears
`action` / `view` after opening the view, so a later visit starts on its
current view.

### Components

| Import | Props / behaviour |
|---|---|
| `WalletNav` — `@/components/wallet/WalletNav` | `{ activeId: WalletViewId \| null; onSelect?: (id) => void }`. The web's WalletSidebar as a horizontal pill rail. With `onSelect` (the hub) hub items switch the view; without it they navigate to the Wallet on that view (`pop: true`). Bonus Wallet always navigates to its own screen (the retired Main Wallet has no item). Put it at the top of wallet-family pages only (the new-account pages pass `activeId={null}`). |
| `WithdrawalMethodPicker` — `@/components/wallet/WithdrawalMethods` | `{ value; onChange(id); onManage(); allowTypes?; emptyNote? }`. VERIFIED methods only; checks the pick only against a loaded list; empty → the web's "No verified withdrawal method available." + "Add Withdrawal Method" (`onManage` → `nav.navigate('Wallet', { view: 'withdrawal-methods' })`). A withdrawal body names `withdrawalMethodId` only — never a typed destination. Also exports `WithdrawalMethodsView` (the management view) and `useWithdrawalMethods()`. |
| `PayToCard`, `ProofPicker` — `@/components/wallet/PayToCard` | `PayToCard { rail: PaymentRail \| null; label }`: the admin's pay-to rows with copy buttons, or the "not set up yet" warning. `ProofPicker { value: ProofImage \| null; onChange }` → `{ dataUrl, mimeType, uri }`, compressed (expo-image-manipulator, `services/proofImage`) under the server's 700 × 1024-char data-URL cap. The same file holds the flow chrome (`FlowHeader`, `StepBar`, `StepTitle`, `ChoiceCard`, `AccountChoiceCard`, `PresetGrid`, `AmountInput`, `SummaryStrip`, `FxRateRow`, `Notice`, `ReviewCard`, `FlowFooter`, `TxStatusBadge`, `FlowGlyph`, `MethodGlyph`) and `useLiveWalletReload(reload, refreshKey?)` — re-read on `user:wallet` / `user:positions` (one per burst), on foreground and when `refreshKey` changes. |
| `RazorpayCheckout` — `@/components/wallet/RazorpayCheckout` | `{ keyId, orderId, amount, currency, description, onSuccess, onDismiss, onFailure }`: Razorpay's hosted Checkout in a full-screen WebView portal. Open it only when `isLiveRazorpayOrder(order)` (a `keyId`, and an id not starting `mock_` — the server's mock mode approves any verify). POST `/wallet/razorpay/verify` from `onSuccess` and nowhere else. No `payment.failed` handling: Checkout offers the retry. |
| `BonusWalletDepositSheet`, `UserWalletWithdrawSheet` — `@/components/wallet/*` | The Bonus Wallet's Add Funds (four steps: a LIVE trading account, or UPI / bank with proof → `/bonus-wallet/deposit`, `/bonus-wallet/manual-deposit`) and its withdraw sheet (`/bonus-wallet/withdraw`). |
| `LeverageSelect` — `@/components/accounts/LeverageSelect` | `{ value: number; onChange; maxLeverage }` — LeverageDropdown.jsx, with a Custom field. |
| Hub views — `@/screens/wallet/views/*View` | Rendered by `WalletScreen` only, never registered as routes: `DepositView` / `WithdrawView` `{ onDone; onCancel; refreshKey? }`, `TransferView` `{ onDone; refreshKey? }`, `WithdrawalMethodsView` (re-export). |

### Rules the logic modules encode

- **Bodies** come from the builders and nowhere else: `utils/fundsFlows`
  (`buildDepositPayload`, `buildWithdrawalPayload`, `buildConvertPayload`,
  `buildAddMethodBody`), `utils/userWallets` (`instantTopUpBody`,
  `manualDepositBody`, `withdrawBody`), `utils/transferLogic`
  (`selfTransferPayload`, `peerTransferPayload`). A new money submit adds a
  payload test that reads the controller's `req.body` destructure from
  `backend/src` (see `stage2_*.payload.test.ts`).
- **Amount fields**: `sanitizeAmountInput` on change (one decimal point),
  `canonicalAmount` when sending (`"10."` → `"10"`; the server books the
  string). **MAX** is `maxWithdrawAmount` / `shareOf`: the decimal string
  floored to cents, never above the balance.
- **Practice accounts** (`isDemoLike`) still need a verified method to
  withdraw (the server checks it before its demo branch): attach the first
  one (`demoWithdrawalMethodId`); none → `WITHDRAWAL_METHOD_REQUIRED_MESSAGE`
  and an Add action. `isStaleMethodRefusal(err)` → re-read the methods.
- **Server codes**: `apiErrorCode(err)`; show the text with `errorMessage`.
- **Plan period**: `planPeriodEnd`, `planCountdown`, `planPeriodLabel`
  (`utils/userWallets`; `utils/plans` re-exports `planPeriodEnd`). A postpaid
  billing date in the past is "Billing due", never "Expired".
- **Overlapping loads** of one source (socket nudges, focus, pull-to-refresh):
  `createSourceSequencer` / `withSourceError` (`utils/walletLogic`) — only the
  newest request's answer lands, and a success clears that source's error.
- **No renew button** — the web never calls `POST /subscriptions/renew`.
- **The Main Wallet is retired.** Plans bill the Bonus Wallet
  (`MySubscription.billingWallet`, read from `billingWallet` or its
  deprecated alias `subscriptionWallet`); nothing calls `/subscription-wallet`
  (its money routes answer 410 MAIN_WALLET_RETIRED). Its old rows still come
  on `/subscriptions/history` (`wallet: 'MAIN'`) and show read-only as
  "Main Wallet (closed)"; `wallet: 'BONUS'` rows the Bonus ledger already
  holds are listed once.
- **Transfers** (`utils/transferLogic`): demo accounts only to demo accounts;
  live accounts and the Bonus Wallet only to each other
  (`selfFromOptions` / `selfToOptions`). A peer transfer leaves one of the
  sender's LIVE accounts and lands in the recipient's primary live account.

## 14. The price chart (stage 5)

`PriceChart` — `@/charts/PriceChart` — is PriceChart.jsx for a screen:
lightweight-charts in a WebView, with its own toolbar, drawing rail and
sheets. The Trade screen is the only user today; StockDetail keeps its
inline-SVG chart.

| | |
|---|---|
| Required props | `symbol`, `instrument` (or `null` while loading), `timeframe` + `onTimeframeChange`, `chartType` + `onChartTypeChange`, `indicators` + `onIndicatorsChange`. The screen owns these (Trade remembers them per symbol, `tradeViewStore`). |
| The book on the chart | `positions` / `orders` (build them with `chartPositionRows` / `chartOrderRows`, `screens/trade/tradeLogic`), `show` (the Show-on-chart toggles), `pendingPreview` / `orderPreview` (the order form's draft). |
| Actions | `onPillAction(a: PillAction)` — `edit`, `close` (a level), `move` (a level to a price; `live: true` while the finger is still down). **The chart never calls a trading endpoint; the screen does, in this callback.** A `PREVIEW_ID` target is the order form's draft, not a server order. |
| Chip / toolbar | `orderSide` + `onOrderSideChange` (the Buy / Sell chip), `onCloseAll` + `openPositionsCount`, `onToggleFullscreen`, `toolbarExtra`; `hideHeader` / `hideDrawingToolbar` / `hideQuickTrade` to drop pieces. |
| Multi-chart | `sync`, `onCrosshair` / `onRange` out, `crosshairIn` / `rangeIn` in (bump `n` to re-send). |
| Lifecycle | The chart pauses itself while the app is in the background. Pass `paused` for anything else — at least `!useIsFocused()`. History is re-read when it resumes, so the gap the socket missed is filled. |

Changing the chart itself:

- **The runtime is plain JS that runs inside the WebView** —
  `src/charts/runtime/{indicators,candles,drawings,chart}.js`, no imports,
  each an IIFE on `window.AATChart`. After editing one, run
  `npm run build:chart-runtime` (regenerates `runtime/generated.ts`;
  `stage5_chartRuntime` fails on a stale bundle).
- **A new message** goes in `charts/protocol.ts` — the `ToChart` /
  `FromChart` union AND the `parseFromChart` whitelist (anything else is
  dropped) — and is handled in `chart.js`. Send with `deliverScript`, never
  by building script text by hand.
- **Nothing remote in the chart's WebView**: `onShouldStartLoadWithRequest`
  allows `about:` / `data:` only. The library is vendored
  (`scripts/vendor-chart.mjs`).
- **Catalogues are the web's**, pinned by deep-equal tests against its
  source: tools (`chartTools`), indicators (`chartCatalog`), layouts
  (`chartLayouts`). Storage keys are the web's (`chartPersistence`).
- Test runtime changes the way `stage5_chartRuntime.dom.test.ts` does: boot
  the real library and runtime in jsdom and drive them with messages.
