# TradePro Mobile (React Native · Expo)

The customer trading app, rebuilt natively with **Expo + React Navigation**. It
talks to the **same backend** as the web client (REST + WebSocket) — the backend
and all business logic are reused; only the UI is native.

## What's in this build
- 🔐 **Login** — real `/auth/login` (customer accounts only), session persistence + token refresh
- 🔌 **Live prices over WebSocket** (`ticker:<symbol>`) — instant ticks on detail + order ticket
- 📈 **Markets** — watchlist; tap a symbol → **Instrument detail**
- 📊 **Instrument detail** — live price + **candlestick chart** (react-native-svg, 1m–1D) + Buy/Sell
- 🎫 **Order ticket** — Buy/Sell · Market/Limit · volume · SL/TP · **live fee breakdown**
  (Commission + Charges + Spread, "Pending" for Free tier) · account picker → `POST /trading/orders`
- 💹 **Trade** — active-account switcher + portfolio summary + **Positions** (live P/L, **edit SL/TP**,
  close), **Orders** (pending), **History** (closed)
- 💰 **Wallet** — Main + Bonus wallet, per-account balances, **internal transfer**, **Deposit / Withdraw**
- 🔁 **Copy Trading** — leaderboard (Discover) + **trader profile** + **start copying** (account +
  lot settings) + My Copies (running P/L, **pause / resume / stop**)
- 🪪 **KYC** — upload documents (image picker) + status; **payment-proof attach** on real deposits
- 🏷️ **Account plans** viewer · 🧾 **F&O option chain** (calls/puts by strike)
- 👤 **Profile** — user info, menu (KYC / Plans / F&O), logout
- Native tab icons (Ionicons). Bottom tabs: **Markets · Trade · Wallet · Copy · Profile**
  + a stack for detail / ticket / fund / copy-setup / trader / kyc / plans / F&O

## Run it

### 1. Install
```bash
cd mobile
npm install
npx expo install --fix     # aligns native deps to the installed Expo SDK
```

### 2. Point it at your backend
Your phone can't reach the PC's `localhost`. `src/config.js` is already set to this
machine's detected LAN IP:
```js
export const API_BASE_URL = 'http://10.175.67.103:5000/api';
```
If your Wi-Fi/IP changes, run `ipconfig` (Windows) and update that line.
(Android emulator: use `http://10.0.2.2:5000/api`.)

### 3. Make the backend reachable on the LAN  ⚠️ important
- ✅ The backend already listens on all interfaces (`server.listen(PORT)` with no
  host binds to `0.0.0.0`), so no server change is needed.
- Allow **port 5000** through the **Windows Firewall** (first run usually prompts —
  choose "Private networks"; if you missed it, add an inbound rule for TCP 5000).
- Phone and PC must be on the **same Wi-Fi**.

Quick test from the phone's browser: open `http://10.175.67.103:5000/api/health`
— you should see a 200/JSON response.

### 4. Start
```bash
npx expo start -c        # -c clears the Metro cache (needed after the reanimated babel change)
```
Install **Expo Go** on your phone (Play Store / App Store), then scan the QR code.
All native modules used (reanimated, gesture-handler, webview, flash-list, image-picker) ship
with Expo Go — no custom dev build required.

## Design system & architecture
- **Exact web tokens** — colours, dark/light surfaces and brand are ported 1:1 from the web
  `tailwind.config.js` + CSS variables (`src/theme.js`). **Dark mode** (light / dark / system)
  is a persisted store; toggle it in Settings or the drawer.
- **Navigation (per spec):** a **Drawer** (Wallet · Copy · Algo · Analytics · History · Settings ·
  Support) wraps **Bottom Tabs** (Home · Markets · Trade · Portfolio · Profile · More), with a
  native stack over it for detail / order-ticket / fund / copy-setup screens.
- **Chart:** `TradingViewChart` embeds **lightweight-charts** (the same engine as the web) in a
  WebView — crosshair, pinch-zoom, indicators (MA), fullscreen + landscape.
- **Stack:** React Navigation · React Query (server cache) · zustand (auth/account/theme) ·
  Reanimated + Gesture Handler · FlashList · react-native-webview · Ionicons.

## Remaining (optional)
- **Push notifications** — needs `expo-notifications` + a backend push-token registration
  + a physical device / dev build to test (Expo Go has limited push support). Deferred by design.

## Structure
```
mobile/
  App.js                    # entry: SafeArea + NavigationContainer + auth init
  src/
    config.js               # API base URL (set your LAN IP here)
    theme.js                # design tokens (mirrors the web palette)
    services/api.js         # axios + AsyncStorage token + refresh interceptor
    store/auth.js           # zustand auth store (init/login/logout)
    navigation/RootNavigator.js
    components/ui.js         # Card / Button / Pill / Loader primitives
    screens/                # Login, Markets, Accounts, Profile
```
