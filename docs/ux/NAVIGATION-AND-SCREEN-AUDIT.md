# Navigation and Screen Audit (UX-IA-001)

**Date:** 2026-08-02
**Baseline:** `feat/transfer-type-monarch-ingest` @ `534a44c`
**Method:** static reading of every route under `src/app/` and every shared calculation
in `src/lib/`. No sign-in, no production data captured. Screens were judged by the
calculations they run, not by their route name.

All money figures in this document are invented illustrations, never real balances.

---

## 1. Current navigation configuration

`src/lib/nav.ts` is the single source of truth. It declares 7 items:

| # | href | label | `tab` (mobile bottom nav) |
|---|---|---|---|
| 1 | `/dashboard` | **Overview** | yes |
| 2 | `/forecast` | Forecast | yes |
| 3 | `/flow` | Flow | yes |
| 4 | `/accounts` | Accounts | yes |
| 5 | `/history` | History | yes |
| 6 | `/cashflow` | Cashflow | no |
| 7 | `/analytics` | Analytics | no |

- `src/components/BottomNav.tsx` renders `NAV_ITEMS.filter(n => n.tab)` → **5 mobile tabs**.
  Already compliant with the 5-tab ceiling. Has `aria-label="Primary"`, `aria-current="page"`,
  `min-h-[56px]` targets, `env(safe-area-inset-bottom)` padding.
- `src/components/Navbar.tsx` renders **all 7** items in the desktop top bar (line 78), plus a
  user dropdown containing Settings and a second "Manage Accounts" link (lines 150-165) that
  duplicates nav item #4, plus an AI chat trigger, plus a live "Net Balance" readout.
- `src/components/ClientLayout.tsx` suppresses chrome on `['/', '/login', '/signup',
  '/forgot-password', '/onboarding']`.

### Two routes are not in `NAV_ITEMS`

- **`/settings`** — reachable only from the profile dropdown (`Navbar.tsx:151`) and the mobile
  menu (`Navbar.tsx:243`). This is already the correct placement.
- **`/calendar`** — reachable from **nothing in the nav at all**. Its only inbound link in the
  entire codebase is the Dashboard's *"View All Transactions"* button
  (`src/app/dashboard/page.tsx:829`), which is mislabelled: it sends the user to a month grid,
  not a transaction list. `/calendar` is an orphan.

### Post-authentication landing is inconsistent

| Origin | Destination |
|---|---|
| `src/app/page.tsx:47` (root, authed + onboarded) | `/dashboard` |
| `src/components/Navbar.tsx:62` (logo) | `/dashboard` |
| `src/app/login/page.tsx:34,46,61` | `/forecast` |
| `src/app/signup/page.tsx:38,79,104` | `/forecast` |
| `src/app/onboarding/page.tsx:190,521,538,1808` | `/forecast` |

Three different code paths disagree about where a signed-in user belongs.

---

## 2. The two calculation universes

This is the decisive fact for every merge decision below.

**Universe A — float dollars.** `classifyTransaction` / `isPositive` / `isReward` / `isRefund`
(`src/lib/classify.ts`), `withDerivedBalances` / `calculateCurrentCash` / `generateForecast` /
`monthlyAverages` (`src/lib/forecast.ts`), `matchTransfers` (`src/lib/transfers.ts`),
`buildAssumptions` (`src/lib/behavior.ts`).
Consumed by: Dashboard, Forecast, Accounts, History, Cashflow, Analytics, Calendar.

**Universe B — integer cents.** `buildFlowGraph` / `detectRecurring` / `projectNetWorth` /
`signedCents` / `balanceAtEndOfDay` / `personFrom` (`src/lib/flows.ts`), `formatMoneyCents`
(`src/lib/money.ts`).
Consumed by: **`/flow` only**. Conservation ("every dollar lands on exactly $0") is unit-tested
in `src/__tests__/flows.test.ts` and `src/__tests__/flows.integration.test.ts`.

Screens inside the same universe over the same input array are merge candidates. Screens across
universes are not automatically mergeable — but where universe B computes the *same answer* more
rigorously than universe A, the universe-A screen is the one to retire.

---

## 3. Screen matrix

| Screen | Route | Primary User Question | Unique Capability | Overlap With | Frequency | Primary/Secondary | Recommended Home |
|---|---|---|---|---|---|---|---|
| Root gate | `/` | — (routing only) | Auth + onboarding branch | — | every cold start | infrastructure | stays `/` |
| Login | `/login` | "Let me in" | Email/password + reset entry | — | setup-only | unauthenticated | stays `/login` |
| Signup | `/signup` | "Create my account" | Registration | — | setup-only | unauthenticated | stays `/signup` |
| Forgot password | `/forgot-password` | "I'm locked out" | Password reset email | — | rare | unauthenticated | stays `/forgot-password` |
| Onboarding | `/onboarding` | "Set up my accounts, income, budget" | 1,865-line guided setup wizard | Accounts (income/budget tabs) | setup-only | **out of nav entirely** | stays `/onboarding`, never in nav |
| Overview | `/dashboard` | "Am I OK right now?" | Setup-incomplete banner; upcoming-bill alert; single landing surface | Accounts (tile row), Forecast (preview card), Insights (category chart), Transactions (recent list) | daily | **Primary** | stays `/dashboard`, re-scoped |
| Forecast | `/forecast` | "Will I be OK, and can I afford X?" | Behavior-engine assumptions + overrides; per-account forecasts; savings goals; decision check; emergency fund; planned payments | History runway view | daily/weekly | **Primary** | stays `/forecast` |
| Flow | `/flow` | "Where did every dollar actually go, and does it reconcile?" | Cent-exact Sankey/treemap/waterfall; reconciliation gap detector; recurring-payment detection; per-account reconcile | Cashflow (entirely) | weekly | **Primary** (container) | stays `/flow`, gains tabs |
| Accounts | `/accounts` | "What do I own and owe, and what are my setup numbers?" | Account CRUD; reconcile; sync trigger; income sources; budgets; category budgets; debt planner; subscriptions | Dashboard (tile row), Settings (routes here) | weekly + setup | **Primary** | stays `/accounts` |
| History | `/history` | "What exactly happened — and let me fix / add / import it" | The **only** transaction CRUD + ingestion surface (add, edit, delete-with-paired-leg-guard, CSV import, receipt scan); account/category/date/type/search filters | Calendar, Flow drill-down, Forecast (runway sub-view) | daily | Secondary → **tab** | `/flow?tab=transactions` |
| Cashflow | `/cashflow` | "Where does my income go, month by month?" | *(none that survives — see §5C)* | Flow (person nodes, rewards, waterfall), Analytics (monthly + category), Dashboard | occasional | Secondary → **retire** | folded into `/flow?tab=insights` |
| Analytics | `/analytics` | "Am I on pace this week/month, and where do I shop?" | Merchant ranking + merchant pie; week/month period stepper; pace projection vs budget | Cashflow, Dashboard | occasional | Secondary → **tab** | `/flow?tab=insights` |
| Calendar | `/calendar` | "What happened on a given day?" | Month grid; add-transaction pre-dated to a clicked day | History (same array), and **computes totals differently — see §5D** | rare (unreachable) | Secondary → **retire** | folded into `/flow?tab=transactions` |
| Settings | `/settings` | "Change my profile, theme, category rules; export my data" | Display-name edit; theme toggle; XLSX export; AI category-rule management | Accounts (routes to it) | setup-only | **Secondary — never primary** | stays `/settings`, profile menu only |

---

## 4. Per-screen answers

### `/dashboard` — Overview

- **Unique decision:** "Is anything on fire today?" — the setup-incomplete banner (`:297`) and
  the upcoming-credit-card-bill alert (`:539`) exist nowhere else.
- **True destination?** Partly. Roughly 80% of its surface is a preview of another screen: the
  forecast card (`:325-365`) is a link to `/forecast`; the account cards (`:400-441`) are links
  to `/accounts`; the category chart (`:679`) duplicates Insights; the recent-transactions list
  (`:776`) duplicates Transactions.
- **Duplicated content, with citations:**
  - `withDerivedBalances` + `currentOf` + `monthlyAverages` → the 5-tile row at `:447-536`
    (Net Worth, Cash Available, Credit Used, Monthly Income, Budget Remaining) is recomputed
    tile-for-tile in `src/app/accounts/page.tsx:408-461`, down to the identical
    `"cash − all debt"` caption string.
  - `generateForecast(..., 90)` at `:168-175` runs the full forecast solely to render two
    numbers in a card that links to `/forecast`.
  - `getTotalByCategory()` at `:118` produces the same chart as Analytics' `categoryBreakdown`
    and Cashflow's `byCategory` — except Dashboard labels via the `EXPENSE_CATEGORIES` enum
    while both others use `displayCategory(t)`, so **the same category can be labelled two
    different ways on two screens**.
- **Could it be a tab/panel?** No. It is the landing surface; demoting it means cold-starting a
  user into a Sankey diagram. Keep it, re-scope it to status + alerts + entry points.
- **Deep links that must keep working:** `/dashboard` (root redirect target at `page.tsx:47`,
  logo target at `Navbar.tsx:62`), `/onboarding?continue=true` (emitted at `:314`).

### `/forecast`

- **Unique decision:** "Can I afford this, and when do I go below my safety threshold?"
- **True destination?** Yes. It is the only consumer of `buildAssumptions`
  (`src/lib/behavior.ts:183`), `loadOverrides`/`saveOverrides`
  (`src/lib/assumption-overrides.ts`), `generateAccountForecast` / `getAllAccountForecasts`
  (`src/lib/forecast.ts:835,1123`), and `firestoreService.getSavingsGoals`. Eleven panels hang
  off it, none of which appear anywhere else.
- **Duplicated content:** its Runway tiles (`:356-394`) duplicate History's Runway sub-view —
  but History's copy is the weaker one (see §5E). Its `BudgetStatusPanel` (`:445`) also renders
  in `/accounts` (`accounts/page.tsx` import line 15).
- **Could it be a tab?** No — it is the only future-tense surface in the app.
- **Deep links:** `/forecast` (post-login, post-signup and post-onboarding landing today).

### `/flow`

- **Unique decision:** "Does my money story add up, and where are the gaps in my data?"
- **True destination?** Yes, and it is the most rigorous screen in the app. Sole consumer of
  universe B. Its reconciliation table (`:753-803`) surfaces per-account drift and offers an
  inline `ReconcileSheet` write — the only write on the page.
- **Duplicated content:** its own pinned-node drill-down table (`:662-688`) is a stunted,
  read-only, three-column re-implementation of History's transaction list.
- **Could it be a tab?** It should be the *container*, not a tab.
- **Deep links:** `/flow` only. No query-param state today — all view state
  (`range`, `month`, `chart`, `focusKind`, `pinLabel`) is `useState`, so nothing is currently
  shareable or restorable.

### `/accounts`

- **Unique decision:** "What is my balance sheet, and what are the numbers the forecast runs on?"
- **True destination?** Yes — the only account/income-source CRUD surface and the only
  `syncNow` trigger (`src/lib/sync-client.ts`).
- **Already tabbed:** 8 in-page tabs (`:465-473`) — Accounts, Subscriptions, Spending,
  Transfers, Income, Budget, Categories, Debt Plan — held in `useState` at `:63` with **no URL
  state**. This is the app's existing precedent for tabs-within-a-destination, and also proof
  that the precedent currently loses deep-linkability.
- **Duplicated content:** the 5-tile summary row (`:408-461`) vs Dashboard `:447-536`.
  `BudgetStatusPanel` shared with Forecast.
- **Naming smell:** the `<h1>` reads **"Account Settings"** (`:383`) while the nav label reads
  "Accounts" — and `/settings` has a row that simply routes here (`settings/page.tsx:110-119`).
- **Deep links:** `/accounts`. Tab state is not addressable and should become so.

### `/history`

- **Unique decision:** "Show me the actual row, and let me correct it." It is the app's **only**
  write surface for transactions: `AddTransactionModal` in edit mode (`:791-793`),
  `CSVImportModal` (`:843`), `ReceiptScannerModal` (`:844`), and delete with the paired-leg
  guard via `pairedLegId` (`:303-311`) — that guard exists nowhere else and prevents the
  two-legs-one-delete balance desync documented in the accounts redesign spec.
- **True destination?** It is a real destination in capability, but it answers the same
  *tense-question* as Flow: "what already happened".
- **Duplicated content:**
  - Its `totals` (`:223-238`) and `groupedTransactions` (`:185-220`) call
    `classifyTransaction` — the same function Analytics (`:100-103`), Cashflow (`:43`) and
    Accounts use.
  - Its Runway sub-view (`:260-298`, `:824-831`) calls
    `generateForecast(currentCash, derivedAccounts, incomeSources, transactions, threshold, 90)`
    — hardcoded to 90 days — which is exactly Forecast's call at `forecast/page.tsx:156-164`
    with a user-selectable horizon. Strictly weaker duplicate.
- **Could it be a tab?** Yes — as the Transactions tab of Flow. Its Runway half should not come
  along.
- **Deep links that must keep working:** **`/history?account=<id>`** — read in the state
  initializer at `:63-65` and documented at `:58` as "Deep-link from the Accounts page".
  Note: **no producer of this URL exists anywhere in the codebase.** It is a live, documented,
  currently-unreachable contract. It must be preserved through any consolidation and should be
  re-linked from Accounts.

### `/cashflow`

- **Unique decision:** none that survives inspection.
- **True destination?** No. It owns no entity, performs no write, and computes nothing that is
  not computed better elsewhere. See §5C for the full evidence.
- **Could it be a tab?** Its two charts belong in Insights; its differentiating tiles are
  already answered by Flow.
- **Deep links:** `/cashflow`, plus its empty-state CTA which links to `/history` (`:157`).

### `/analytics`

- **Unique decision:** "Am I on pace this period, and which merchants take my money?"
- **True destination?** No — it owns no data and performs no writes. Every number derives from
  `transactions` + `classifyTransaction` + `displayCategory` + `getMerchantColor`.
- **Genuinely unique content worth preserving:** the merchant breakdown and merchant pie
  (`:240-274`, `:740-827`) — nothing else in the app ranks merchants; and the pace projection
  (`:296-325`: `avgDailySpend`, `projectedTotal`, `willExceedBudget`).
- **Duplicated content:** `monthlyComparison` (`:190-213`) vs Cashflow `monthly` (`:101-112`)
  vs Dashboard `getMonthlyTotals()`; `categoryBreakdown` (`:217-237`) vs Cashflow `byCategory`
  (`:115-126`) vs Dashboard `categoryChartData` (`:218-228`). The file's own comment at
  `:98-99` records why: *"this screen used to carry its own copy, so the same month could
  report three different Income/Expense figures across three pages."* The classifier was
  unified; the three separate chart pipelines were not.
- **Could it be a tab?** Yes. It also mounts nine `ResponsiveContainer`s — flagged as a
  weak-GPU risk in the mobile-first spec — so making it a lazily-mounted tab is a performance
  improvement, not just an IA one.
- **Deep links:** `/analytics`. No query-param state.

### `/calendar`

- **Unique decision:** "What hit my account on the 14th?" plus "add a transaction dated to this
  day".
- **True destination?** No, and it is currently unreachable from navigation.
- **Duplicated content — and a correctness divergence:** Calendar computes its month totals from
  the **raw stored type**: `t.type === 'income'` / `t.type === 'expense'` at `:79-80` and
  `:105-111`. It never calls `classifyTransaction`. It imports `isPositive` (`:11`) but uses it
  only for row colouring (`:312`), never for the totals. Every other screen classifies first.
  Consequence: a credit-card payment — classified `transfer` app-wide via
  `classify.ts:50-52` — is counted as **both income and expense** in Calendar's monthly summary,
  while contributing zero on History, Analytics, Cashflow and Accounts. Calendar is not merely
  redundant; it is a divergent duplicate that reports different money than the rest of the app.
- **Could it be a tab?** Its month-grid form is not worth porting a wrong calculation for. Its
  one unique affordance — a transaction dated to a chosen day — is already supported by
  `AddTransactionModal`'s `defaultDate` prop and its own date field. Nothing is lost by retiring
  the grid.
- **Deep links:** `/calendar`, reached only from `dashboard/page.tsx:829`.

### `/settings`

- **Unique decision:** "Change my name/theme, manage my AI category rules, export my data."
- **True destination?** Yes, but low-frequency and correctly already outside `NAV_ITEMS`.
- **Duplicated content:** its "Accounts & Budget" row (`:110-119`) is a bare `router.push`
  to `/accounts`.
- **Deep links:** `/settings`.

### `/onboarding`

- **Unique decision:** first-run setup.
- **Already correct:** absent from `NAV_ITEMS`, excluded from chrome in `ClientLayout.tsx:9`,
  and **self-guarding** — `:188-192` redirects an already-onboarded user away unless
  `?continue=true` is present. No IA change needed.
- **Deep links that must keep working:** `/onboarding` and **`/onboarding?continue=true`**
  (emitted from `dashboard/page.tsx:314` and `forecast/page.tsx:325`).

### `/`, `/login`, `/signup`, `/forgot-password`

- Unauthenticated / routing only. Excluded from chrome. No change, other than resolving the
  landing-route inconsistency in §1.

---

## 5. Redundancy findings, with evidence

### 5A — Monthly income-vs-spending is computed three times
| Screen | Code | Method |
|---|---|---|
| Cashflow | `cashflow/page.tsx:101-112` (`monthly`) | groups by `yyyy-MM`, via `classifyTransaction` |
| Analytics | `analytics/page.tsx:190-213` (`monthlyComparison`) | 12 months back, via `classifyTransaction` |
| Dashboard | `dashboard/page.tsx:119` (`getMonthlyTotals()`) | from `TransactionContext` |

Three pipelines, three chances to disagree.

### 5B — Top-spending-categories is computed three times, with two different label sources
| Screen | Code | Labels from |
|---|---|---|
| Cashflow | `cashflow/page.tsx:115-126` | `displayCategory(t)` |
| Analytics | `analytics/page.tsx:217-237` | `displayCategory(t)` |
| Dashboard | `dashboard/page.tsx:218-228` | `EXPENSE_CATEGORIES` enum |

Dashboard will show the coarse enum label where the other two show the user's own Monarch
category — the same spend, two names.

### 5C — Cashflow is redundant with Flow (hypothesis CONFIRMED)

Cashflow's four differentiating tiles map one-for-one onto work Flow already does, in cents,
with tested conservation:

| Cashflow tile | Cashflow implementation | Flow equivalent |
|---|---|---|
| "Net to family / others" | `cashflow/page.tsx:58-88` — calls `matchTransfers`, then hand-rolls self-detection from `profile.name` word-splitting and `/\bto me\b/`, and buckets destinations with hardcoded `/remitly\|rmtly/` and `/zelle/` regexes | `flows.ts:37-57` (`personFrom`, `isSelfPerson`, `displayPerson`) builds `person-out:` / `person-in:` nodes; `flow/page.tsx:603,435` renders "Sent to people & family" as `sum(l => l.target.startsWith('person-out:'))` |
| "Card rewards earned" | `cashflow/page.tsx:129-139` via `isReward` | Flow has a `rewards` source node (`flow/page.tsx:433`); History's per-account summary also shows "Rewards earned" per card (`history/page.tsx:615`) |
| "Actually kept" (`income − spent − net given`) | `cashflow/page.tsx:97` — float subtraction over hand-picked exclusions | Flow's waterfall (`flow/page.tsx:478-489`) starts from all money available and subtracts every destination, landing on exactly `$0` — the residual *is* what stayed; the treemap explicitly includes "what stayed in your accounts" (`:657`) |
| Monthly bars + category bars | `:101-126` | duplicates Analytics (§5A, §5B) |

Cashflow is a float-precision, regex-hardcoded re-derivation of Flow's cent-exact, unit-tested
graph. **Retire it.**

### 5D — Calendar duplicates History *and gets a different answer*

`calendar/page.tsx:79-80,105-111` uses raw `t.type`; every other screen routes through
`classifyTransaction` (`classify.ts:35`). A card payment counts twice on Calendar and zero times
elsewhere. Retiring Calendar removes a wrong number rather than porting it.

### 5E — History's Runway duplicates Forecast's Runway, worse

`history/page.tsx:286-298` calls `generateForecast(..., 90)` with the horizon hardcoded;
`forecast/page.tsx:150-165` calls the same function with a user-selected 30/90/180/365 horizon
and renders Runway-in-days and Runway-in-months tiles (`:356-394`). History's toggle should be
deleted, not carried forward. `src/components/RunwayCalculator.tsx` becomes orphaned unless
Forecast adopts it.

### 5F — Dashboard's and Accounts' 5-tile summary rows are the same computation

`dashboard/page.tsx:126-159` + `:447-536` vs `accounts/page.tsx:408-461`. Same
`withDerivedBalances` / `currentOf` / `monthlyAverages` inputs, same five tiles, same caption
strings. This is a shared-component extraction, not a route merge — both screens legitimately
need the row.

### 5G — Flow's drill-down duplicates History's row list

`flow/page.tsx:662-688` renders a read-only Date/Merchant/Amount table for a pinned node.
Merging History into Flow lets a pin filter the real transaction list instead, and deletes this
second implementation.

---

## 6. Hypothesis verdicts

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| 1 | History becomes a Flow transactions tab | **Yes, with one correction** | History and Flow answer the same tense-question ("what already happened") over the same `transactions` array, and the real user loop — *see an aggregate → drill into rows → fix a category → watch the aggregate move* — currently crosses a route boundary and loses all state. Merging also deletes Flow's duplicate drill-down table (§5G). **Correction:** History is not "a filtered view of data owned elsewhere" — it is the app's only transaction CRUD and ingestion surface (`CSVImportModal`, `ReceiptScannerModal`, edit mode, `pairedLegId` delete guard). The tab must carry all of that, and its **Runway sub-view must NOT come along** (§5E). |
| 2 | Analytics becomes Flow Insights | **Yes** | Owns no data, performs no writes, derives everything from `transactions` + `classifyTransaction` + `displayCategory`. Its unique merchant ranking and pace projection survive as the tab's centrepiece. Lazy tab mounting also fixes its nine-`ResponsiveContainer` weak-GPU cost flagged in the mobile-first spec. |
| 3 | Calendar becomes a Forecast tab | **NO — hypothesis is wrong** | Calendar renders only past/actual rows (`transactions.filter(isSameDay(...))`, `:72-74`). It never calls `generateForecast`, holds no projected data, and has no future-tense content. It is a past-tense browser and belongs with Transactions, not Forecast — which already has a future-dated timeline in `ForecastTimeline` (`forecast/page.tsx:428`). Separately, Calendar's totals are computed with the wrong rule (§5D), so it should be **retired**, not relocated. Its one unique affordance (a transaction dated to a chosen day) is already covered by `AddTransactionModal`'s `defaultDate`. |
| 4 | Cash Flow is redundant with Flow and/or Forecast | **Yes — redundant with Flow** (not with Forecast) | Full evidence in §5C. Note it is **not** redundant with Forecast: Flow's `projectNetWorth` (`flows.ts:419`) is a linear extrapolation of the historical rate, whereas Forecast's `generateForecast` + `buildAssumptions` is behaviour-classified, per-account, cadence-aware and user-overridable. Those two projections answer different questions and must both survive. |
| 5 | Dashboard becomes "Overview" | **Already half-true; finish it, don't rename the route** | `nav.ts:19` already labels `/dashboard` as **"Overview"**, while the page `<h1>` says "Welcome back, {name}!" (`:371`). Fix the `<h1>` so nav label, page title and top-bar title agree. **Do not rename the route** to `/overview`: it buys nothing and breaks the root redirect (`page.tsx:47`), the logo link (`Navbar.tsx:62`), and every existing bookmark. |

### Merges deliberately NOT made

- **Accounts into anything.** It owns account and income-source CRUD, the `syncNow` trigger, and
  reconcile. Distinct entity, distinct writes.
- **Forecast into Flow.** Different tense, different engine, no shared calculation beyond
  `withDerivedBalances`.
- **Dashboard into Forecast.** Dashboard's setup banner and bill alert have no home in Forecast,
  and a landing surface that opens on a 90-day projection chart is worse for a cold start.
- **Settings into Accounts.** Tempting given `settings/page.tsx:110-119` just routes to
  `/accounts` and Accounts' `<h1>` reads "Account Settings" — but Settings owns identity, theme,
  AI category rules and export, none of which are account entities. Flagged as a naming cleanup,
  not a merge.

---

## 7. Deep links that must keep working

| URL | Producer | Consumer |
|---|---|---|
| `/dashboard` | `page.tsx:47`, `Navbar.tsx:62` | root redirect + logo |
| `/forecast` | `login:34,46,61`; `signup:38,79,104`; `onboarding:190,521,538,1808`; `dashboard:327` | post-auth landing |
| `/onboarding?continue=true` | `dashboard:314`, `forecast:325` | resumes setup at the bank-accounts step (`onboarding:186-188`) |
| `/history?account=<id>` | **none** (documented at `history:58`, unreachable today) | pre-selects an account filter (`history:63-65`) |
| `/accounts` | `dashboard:393,403,725`; `Navbar.tsx:159`; `settings:116` | account management |
| `/history` | `cashflow:157` (empty-state CTA) | import entry point |
| `/calendar` | `dashboard:829` ("View All Transactions" — mislabelled) | month grid |
| `/settings` | `Navbar.tsx:151,243` | profile menu |
| `/login` | every page's unauthenticated guard | auth |

---

## 8. Accessibility strengths the implementation must preserve

These are already shipped and must survive any nav rework:

- **Bottom nav semantics** — `aria-label="Primary"`, `aria-current="page"` on the active tab,
  `min-h-[56px]` targets, `env(safe-area-inset-bottom)` padding (`BottomNav.tsx:16-36`).
- **Focus management in Flow's maximised overlay** — `role="dialog"`, `aria-modal="true"`,
  focus moved in on open, Tab cycled inside, focus restored to the trigger on close, Esc
  unwinds pin-then-maximise (`flow/page.tsx:130-165`). Explicitly cited as WCAG 2.4.3 / 2.1.2.
- **Chart text alternatives** — `role="img"` with a data-bearing `aria-label` plus a real
  `<table>` alternative via `ChartSrTable` on Dashboard, Analytics and Cashflow, and Flow's
  "View the flow as a table" `<details>` (`flow:691-716`) with an `sr-only` `<caption>`.
- **Sankey node accessibility** — every node is `tabIndex={0}`, `role="button"`, with an
  `aria-label` naming the node and its amount, `aria-pressed` for the pin state, Enter/Space
  activation, and a transparent 44px minimum hit rect behind the 12px visual node
  (`flow:297-344`).
- **Pointer-type event guard** — `e.pointerType === 'mouse'` (`flow:311-312`) so a touch tap
  traces instead of firing a phantom hover. Never `matchMedia` in render.
- **44px touch targets** — `w-11 h-11` icon buttons in `Navbar.tsx:102,190,195`;
  `max-sm:min-w-[44px] max-sm:min-h-[44px]` on History's row actions
  (`history:776,783,796,804`); `min-h-[44px]` on `<summary>` elements in Flow, Assumptions,
  Subscriptions and ForecastTimeline.
- **Reduced motion** — `@media (prefers-reduced-motion: reduce)` in `globals.css:899`, plus
  `isAnimationActive={false}` on recharts series (which ignore the CSS kill-switch).
- **Focus-visible** — global `button/input/select/a:focus-visible` rules
  (`globals.css:871-874`) and a dedicated `.flow-node:focus-visible` (`:911`).
- **Live regions** — `role="status" aria-live="polite"` for the Accounts sync message
  (`accounts:399`); `role="log" aria-live="polite"` for the AI chat transcript
  (`DataChatSheet.tsx:120`); `aria-live` on `ReconcileSheet.tsx:60`.
- **Per-day calendar labels** — `aria-label` naming the date, transaction count and net
  (`calendar:216`). If the grid is retired, this pattern should be reused for any date-grouped
  list header.
- **Theme-flash prevention** — the pre-paint theme script in `layout.tsx`.
- **Viewport** — `viewportFit: 'cover'` with pinch-zoom preserved (no `maximumScale`).

### Accessibility gaps still open at this baseline

The mobile-first spec's P0 listed three shell items that are **not** present in
`ClientLayout.tsx` (which is 25 lines and renders only the FAB and BottomNav):

1. no **skip-to-content** link,
2. no shared polite **`aria-live`** region,
3. no **route-change focus reset / page announcement** via `usePathname`.

A tabbed architecture makes items 2 and 3 more important, not less — tab switches change page
content without a route change and must be announced. These are handed to UX-NAV-002.

---

## 9. Alignment with existing specs

**`docs/superpowers/specs/2026-07-26-mobile-first-design.md`** — this audit is consistent with
every locked owner decision:
- "Mobile nav: bottom tab bar, top hamburger demoted to a 'More' affordance" → the proposed
  architecture makes "More" an explicit 5th bottom-nav destination rather than a hamburger.
- "`/flow` on mobile: Sankey stays the hero" → the Flow tab remains the default tab; nothing is
  inverted.
- "Bottom tab bar, max 5" → still 5, and the 5th slot is freed by the consolidation.

**`docs/superpowers/specs/2026-07-25-accounts-redesign-design.md`** — no divergence. Accounts
stays a primary destination and its balance-anchor / reconcile model is untouched. One
observation the spec supports: Flow's reconciliation gap detector is the "independent sensor"
the spec depends on, which reinforces keeping Flow (not Cashflow) as the money-truth surface.

**No divergence from either spec is proposed.**

---

## 10. Manual visual review

A local `npm run dev` browse was deliberately **not** performed against production Firestore.
This audit is entirely static. The screens' visual behaviour was inferred from markup and is
described in prose only where the code is unambiguous (for example, Accounts' horizontally
scrolling 8-tab strip under `scroll-x-mobile` at `accounts:464`, which on a 360px viewport puts
five of the eight tabs off-screen behind a horizontal scroll with no affordance indicating
more exist).
