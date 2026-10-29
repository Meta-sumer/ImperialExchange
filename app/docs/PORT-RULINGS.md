# Port rulings — one answer per contested number

Two audit passes over `client/src` found places where the web client computes
a number more than one way. This file rules on each, from the code, so the
mobile app has a single answer. Every ruling names the file and line it was
decided from.

The rule behind all of them: **where the server computes a number, the app
displays the server's.** A client that computes its own can show a trader a
margin level the engine does not agree with, right up until a stop-out they
were not expecting.

---

## 1. Margin level — NOT a divergence

Reported as "three incompatible denominators". It is one formula in four
places:

| Where | Formula | Zero case | Denominator source |
|---|---|---|---|
| `backend/src/services/riskService.js:62` | `(equity / usedMargin) × 100` | `'0'` | `sum(position.margin)` — locked at fill |
| `client/src/pages/Wallet.jsx:236` | same | `null` | `wallet.locked` |
| `client/src/pages/Trade.jsx:1497` | same | `null` | recomputed in the page |
| `client/src/hooks/useAccountMetrics.js:51` | same | `0` | recomputed in the page |

The arithmetic agrees. What differs is the **denominator's source** and the
**zero case**.

**RULING.** The app reads `GET /api/trading/account-metrics` and displays what
it returns. It computes no margin level of its own.

The server returns `'0'` when no margin is in use. The app renders that as
"no margin in use", not as 0% — the absence of a margin level and a level of
zero are different things, and only the display layer should decide how to
say so.

> That endpoint did not exist when the audit ran. `calculateAccountMetrics`
> was reachable only at `GET /api/admin/accounts/:accountId/metrics`, which is
> admin-only — which is *why* the three client copies grew. It was added as
> part of this port.

---

## 2. Unrealised P&L sign — NOT a divergence

Reported as "two different sign discriminators":

- `client/src/pages/Trade.jsx:1030` keys off `positionSide` (`LONG`/`SHORT`)
- `backend/src/services/riskService.js:52` keys off `side` (`BUY`/`SELL`)

They cannot disagree. `backend/src/models/Position.js:18-21` defines:

```js
positionSide: {
  default: function () { return this.side === 'BUY' ? 'LONG' : 'SHORT'; },
}
```

and `Trade.jsx:1022` applies the same fallback for legacy documents without
the field: `p.positionSide || (p.side === 'BUY' ? 'LONG' : 'SHORT')`.

`BUY ↔ LONG` and `SELL ↔ SHORT` by construction.

**RULING.** No action. The app displays `unrealizedPnl` from the server and
does not re-derive the sign. If it ever needs the side for display, either
field is correct; prefer `positionSide`, because hedge mode makes it the
position's identity.

---

## 3. Real vs demo account — A REAL DIVERGENCE

Three predicates, and one of them is wrong:

| Where | Predicate |
|---|---|
| `client/src/pages/Wallet.jsx:163` | `accountType === 'REAL'` |
| `client/src/pages/Wallet.jsx:920` | `accountType !== 'DEMO' && accountType !== 'VIRTUAL'` |
| `backend/src/controllers/walletController.js:110` | `isDemoLike = accountType === 'DEMO' \|\| accountType === 'VIRTUAL'; isRealMoney = !isDemoLike` |

`REAL` is a **legacy tier**. Modern accounts carry `STANDARD`, `PRO`, `FREE`
and their `_IC` variants. So `=== 'REAL'` is false for every modern live
account, and `Wallet.jsx:163` classifies real money as demo.

**RULING.** Test demo-ness, never equality with `REAL`:

```ts
const isDemoLike = (t: string) => t === 'DEMO' || t === 'VIRTUAL';
const isRealMoney = (t: string) => !isDemoLike(t);
```

One predicate, in one module, matching the server. Do not port
`client/src/utils/accountTypes.js` — it has zero importers and is dead.

---

## 4. USD→INR fallback — A REAL DIVERGENCE

| Where | Value |
|---|---|
| `client/src/utils/walletTotals.js:16` | `88` |
| `client/src/hooks/useFxRate.js:17` | `83` (or `VITE_USDINR_RATE`) |

Two hardcoded rates in one client. A balance converted with one and a total
with the other do not add up, and neither is today's rate.

**RULING.** The app hardcodes no rate. It reads `GET /api/fx/usdinr` — the
same endpoint the web client's own `useFxRate` prefers before falling back.

When the rate is unavailable the app **shows the unconverted figure with its
own currency**, and does not convert. A converted number carries no mark
saying which rate produced it; an unconverted one is at least true.

> Mostly this should not arise. Account money is USD — `userController` and
> `authController` refuse any other base currency at creation
> (`UNSUPPORTED_BASE_CURRENCY`). FX applies to instrument prices, which are
> genuinely quoted in their own currency: an NSE stock is ₹120, not $120.

---

## 5. Number and date locale

~60 hardcoded `toLocaleString` call sites, split between `'en-IN'` (21) and
`'en-US'` (39).

**RULING.** Grouping follows the **currency**, not the device:

- `₹` → `en-IN` grouping (`12,34,567.89`)
- everything else → `en-US` grouping (`1,234,567.89`)

This is not cosmetic. `en-IN` grouping on a dollar figure reads as a
different number to anyone who knows either convention.

Dates use the device locale and the device time zone, except where the
server has already formatted a value — then it is shown verbatim.

---

## 6. Fees and statutory charges

`client/src/components/OrderForm.jsx` computes a charges preview.
`backend/src/services/indianCharges.js` and `accountFeeService.js` are
authoritative.

**RULING.** A preview may be shown, and it must be **labelled an estimate**.
The booked figure comes from the order/position the server returns, and that
is what history, P&L and statements display. The app never presents its own
arithmetic as the charge.

---

## What the app must NOT port

Found dead during the audit — zero importers, or imported but never rendered:

| File | Evidence |
|---|---|
| `client/src/pages/Affiliate.jsx` | imported at `App.jsx:33`, but `/affiliate`, `/partner` and `/ib-room` all render **Partner** |
| `client/src/components/OrderBook.jsx` | zero importers |
| `client/src/components/FundingQuote.jsx` | zero importers; owns the `/wallet/fx/*` calls |
| `client/src/utils/accountTypes.js` | zero importers |
| `client/src/utils/currency.js` | zero importers |
| `client/src/hooks/useAccountMetrics.js` | superseded by the new endpoint |

Three entry points are emitted but never read, so they do nothing today and
must not be reproduced as if they worked:

- `/wallet?view=<id>` — emitted by `WalletSidebar.jsx:80`, `Wallet.jsx` reads only `?action=`
- `/alerts?symbol=` — emitted by `StockDetail.jsx:202`, `PriceAlerts.jsx` reads no params
- `/explore?welcome=1` — emitted by `OAuthCallback.jsx:40`, `Explore.jsx` never reads it

These are listed so the port gives them a working destination or leaves them
out deliberately — not so it copies a link that goes nowhere.
