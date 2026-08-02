# UX-IA-001 — Completion Report

**Task:** Navigation and Screen Audit (documentation only)
**Date:** 2026-08-02
**Worktree:** `../cashflow-forecast-ux-ia-001`
**Branch:** `docs/ux-ia-001-navigation-audit` (from `534a44c`, not pushed)
**Deliverables:** [`NAVIGATION-AND-SCREEN-AUDIT.md`](./NAVIGATION-AND-SCREEN-AUDIT.md) ·
[`PROPOSED-INFORMATION-ARCHITECTURE.md`](./PROPOSED-INFORMATION-ARCHITECTURE.md) · this file

No file under `src/`, `functions/`, `functions-sync/`, `scripts/` or any config was modified.
No navigation was implemented. No production data was read, captured or committed.

---

## 1. Screen inventory summary

**14 navigable routes audited** (plus 2 non-navigable API routes, both deleted by SEC-001).

| Group | Routes |
|---|---|
| Authed app screens (9) | `/dashboard` `/forecast` `/flow` `/accounts` `/history` `/cashflow` `/analytics` `/calendar` `/settings` |
| Setup (1) | `/onboarding` |
| Unauthenticated (3) | `/login` `/signup` `/forgot-password` |
| Routing gate (1) | `/` |

Two of the nine authed screens are absent from `src/lib/nav.ts`: `/settings` (correct — profile
menu only) and **`/calendar`**, which is reachable from nothing but a single mislabelled
Dashboard button (`dashboard/page.tsx:829`) and is therefore an orphan.

The mobile bottom nav already renders exactly 5 tabs and is already compliant with the ceiling.
The desktop top bar renders all 7 nav items **plus** a duplicate "Manage Accounts" link.

---

## 2. Redundancy matrix

| # | Finding | Screens | Proof |
|---|---|---|---|
| A | Monthly income-vs-spending computed 3× | Cashflow, Analytics, Dashboard | `cashflow:101-112` · `analytics:190-213` · `dashboard:119` |
| B | Top-categories computed 3×, with 2 different label sources | Cashflow, Analytics, Dashboard | `cashflow:115-126` and `analytics:217-237` use `displayCategory(t)`; `dashboard:218-228` uses the `EXPENSE_CATEGORIES` enum — same spend, two names |
| C | Cashflow is wholly redundant with Flow | Cashflow, Flow | `cashflow:58-88` hand-rolls person-transfer netting from `matchTransfers` + hardcoded `/remitly\|zelle/` regexes; `flows.ts:37-57` + `flow:603` does it in cents via `person-out:`/`person-in:` nodes. `cashflow:97` "actually kept" ≡ `flow:478-489` waterfall residual (lands on exactly $0, unit-tested) |
| D | Calendar duplicates History **and reports different money** | Calendar, History | `calendar:79-80,105-111` uses raw `t.type`; every other screen routes through `classifyTransaction` (`classify.ts:35`). A card payment — `transfer` app-wide per `classify.ts:50-52` — counts as *both* income and expense on Calendar and zero elsewhere |
| E | History's Runway duplicates Forecast's, worse | History, Forecast | Both call `generateForecast(currentCash, derivedAccounts, incomeSources, transactions, threshold, …)`; `history:286-298` hardcodes 90 days, `forecast:150-165` lets the user pick 30/90/180/365 |
| F | 5-tile summary row computed twice | Dashboard, Accounts | `dashboard:126-159,447-536` vs `accounts:408-461` — same `withDerivedBalances`/`currentOf`/`monthlyAverages`, same tiles, identical `"cash − all debt"` caption |
| G | Flow's drill-down duplicates History's row list | Flow, History | `flow:662-688` is a read-only 3-column table of the same rows History renders with full CRUD |

Root cause, recorded in the code itself: `analytics/page.tsx:98-99` — *"this screen used to carry
its own copy, so the same month could report three different Income/Expense figures across three
pages."* The **classifier** was unified into `src/lib/classify.ts`; the three separate **chart
pipelines** built on top of it never were.

---

## 3. Selected information architecture

**Four primary destinations organised by the tense of the question, plus mobile "More".**

```
Overview   /dashboard   "Am I OK right now?"        present
Forecast   /forecast    "Will I be OK?"             future
Flow       /flow        "Where did it actually go?" past   [4 tabs, review badge]
Accounts   /accounts    "What do I own and owe?"    balance sheet [8 tabs, now URL-addressable]
```

Tense matches the code exactly: `/flow` is the sole consumer of the integer-cent ledger
(`src/lib/flows.ts`), `/forecast` the sole consumer of the projection engine (`generateForecast`
+ `buildAssumptions`), `/accounts` the sole writer of account entities, `/dashboard` the only
"now" summary. Four engines, four destinations.

**Flow tab contract:** `?tab=flow` (default) · `?tab=transactions` · `?tab=insights` ·
`?tab=review` *(reserved for the future Money Review workspace)*.

---

## 4. Primary destinations

| # | Label | Route | Badge |
|---|---|---|---|
| 1 | Overview | `/dashboard` | — |
| 2 | Forecast | `/forecast` | — |
| 3 | Flow | `/flow` | **review count** |
| 4 | Accounts | `/accounts` | — |
| 5 | More | *(mobile only, opens a `Sheet`)* | — |

---

## 5. Secondary destinations

| Capability | Placement |
|---|---|
| Settings | desktop profile menu / mobile More sheet — **never primary** |
| Export data | inside Settings + contextual page action |
| Theme toggle | top bar (desktop) / More sheet (mobile) |
| Sign out | profile menu / More sheet |
| AI data chat | global sparkle in the top bar, until the Review tab absorbs it |
| Onboarding | **never in navigation**; reached only via `?continue=true` from the setup banner. Already self-guarding at `onboarding:188-192` |
| Runway | Forecast's existing tiles (History's copy deleted) |
| Calendar month grid | retired — wrong math, and its unique affordance is covered by `AddTransactionModal`'s `defaultDate` |

---

## 6. Consolidated routes

| Consolidated | Into | Reason |
|---|---|---|
| `/history` | Flow → Transactions tab | Same tense-question over the same array; enables the pin→drill→fix→re-aggregate loop that currently crosses a route boundary; deletes Flow's duplicate drill-down (finding G). **Its Runway sub-view is dropped, not moved** (finding E) |
| `/analytics` | Flow → Insights tab | Owns no data, no writes; findings A + B. Lazy tab mounting also removes its 9 simultaneous `ResponsiveContainer`s, flagged as a weak-GPU risk in the mobile-first spec |
| `/cashflow` | Flow → Insights tab | Finding C — a float re-derivation of Flow's cent-exact graph |
| `/calendar` | Flow → Transactions tab | Finding D — retired rather than relocated |

### Deliberately kept separate

| Kept | Why |
|---|---|
| `/forecast` | `projectNetWorth` (`flows.ts:419`, linear extrapolation) and `generateForecast` (behaviour-classified, per-account, cadence-aware, user-overridable) answer different questions. Not redundant with Flow |
| `/accounts` | Only account/income-source CRUD, only `syncNow` trigger, only reconcile-from-list |
| `/dashboard` | Setup banner and bill alert have no home elsewhere; a cold start must not open on a Sankey |
| `/settings` | Owns identity, theme, AI category rules, export — none are account entities. Naming collision with Accounts' `<h1>` ("Account Settings") is a copy fix, not a merge |
| `/onboarding` | Already correctly outside nav and self-guarding |

**Not renamed:** `/dashboard` (label is already "Overview"; renaming breaks `page.tsx:47`,
`Navbar.tsx:62` and bookmarks) and `/flow` (the brief itself names the future workspace
"Money Review **inside Flow**").

---

## 7. Redirect strategy

Implement in **`async redirects()` in `next.config.ts`** (currently an empty config).
**Do not use `src/middleware.ts`** — that file does not exist at this baseline but OBS-001
creates it; using it guarantees a conflict for no benefit. Firebase Hosting uses
`frameworksBackend` (SSR), not `output: 'export'`, so `redirects()` is honoured in production
(verified in `firebase.json`).

| Former URL | New URL | Type |
|---|---|---|
| `/history` | `/flow?tab=transactions` | 308 |
| `/history?account=<id>` | `/flow?tab=transactions&account=<id>` | 308 — **contract-critical** |
| `/history?<other>` | `/flow?tab=transactions&<other>` | 308 (params passed through) |
| `/analytics` | `/flow?tab=insights` | 308 |
| `/cashflow` | `/flow?tab=insights` | 308 |
| `/calendar` | `/flow?tab=transactions` | 308 |
| `/flow` (no `tab`) | renders the Flow tab | no redirect |
| all other routes | unchanged | — |

Next.js forwards unmatched query params automatically — **this must be covered by a test, not
assumed.** `/history?account=<id>` is read in a state initializer at `history:63-65` and is a
documented contract with, notably, **no producer anywhere in the codebase today**; it must
survive and should finally be linked from Accounts.

In-app links not covered by redirects: `dashboard:829` (`/calendar` → `/flow?tab=transactions`),
`cashflow:157` (dies with the page), `src/lib/nav.ts:18-26` (7 items → 4 + More).

**Landing-route inconsistency to resolve in the same change:** `login:34,46,61`,
`signup:38,79,104` and `onboarding:190,521,538,1808` land on `/forecast` while `page.tsx:47` and
`Navbar.tsx:62` land on `/dashboard`. Standardise on **`/dashboard`**.

---

## 8. Desktop navigation decision

**Compact persistent left rail (4 items) + a top bar that stops repeating it.**

- Rail: Overview · Forecast · Flow *(badge)* · Accounts. `aria-current="page"`, collapsible to
  icons at narrower widths.
- Top bar carries **only**: page title, sync/data-freshness (promote Accounts' `describeSync`
  output to the shell), global search, review count, theme + profile menu (Settings, Export,
  Sign out), and contextual page actions.
- **Removed from the top bar:** the seven route links (`Navbar.tsx:78`), the duplicate
  "Manage Accounts" entry (`Navbar.tsx:159`), and the always-on Net Balance readout.
- Tabs render inside the destination under the page title — never in the rail.

---

## 9. Mobile navigation decision

**Bottom tab bar, 5 items, no left sidebar. `BottomNav.tsx` structure is kept; only
`NAV_ITEMS` changes.**

```
[ Overview ]  [ Forecast ]  [ Flow• ]  [ Accounts ]  [ More ]
```

- Honours the locked owner decision in the mobile-first spec (bottom tab bar, thumb-reach, max 5).
- The consolidation frees the fifth slot → **More**, an explicit destination opening the existing
  `Sheet` (focus trap, Esc, iOS scroll lock) with Settings, Export, Theme, Sign out, profile.
- The hamburger at `Navbar.tsx:194-201` is **deleted** — More owns everything it held.
- In-destination tabs use the horizontally scrollable chip row Accounts already uses
  (`accounts:464`, `.scroll-x-mobile`). Flow's four tabs fit a 360px viewport without scrolling.
- `QuickAddFAB` keeps its `bottom-24` lift; after a save it should land the user on
  `/flow?tab=transactions`.

---

## 10. Accessibility impact

### Must be preserved (regression checklist)

BottomNav `aria-label="Primary"` + `aria-current` + 56px targets + safe-area padding
(`BottomNav.tsx:16-36`) · Flow's maximised-overlay focus trap, Esc unwind and focus restore
(`flow:130-165`) · `role="img"` + `ChartSrTable` text alternatives on every chart · Sankey node
`tabIndex`/`role="button"`/`aria-label`/`aria-pressed` + 44px transparent hit rects
(`flow:297-344`) · the `e.pointerType === 'mouse'` hover guard (`flow:311-312`) · 44px targets
(`Navbar.tsx:102,190,195`; `history:776,783,796,804`; `<summary>` elements) ·
`prefers-reduced-motion` (`globals.css:899`) + `isAnimationActive={false}` · global
`:focus-visible` (`globals.css:871-874`) and `.flow-node:focus-visible` (`:911`) · live regions
(`accounts:399`, `DataChatSheet:120`, `ReconcileSheet:60`) · pre-paint theme script ·
`viewportFit: 'cover'` with pinch-zoom intact.

Two specific carry-forwards: History's mobile filter disclosure with `aria-expanded` + active
count (`history:438-449`) must survive into the Transactions tab; Calendar's per-day `aria-label`
pattern (`calendar:216`) should be reused for date-group headers so its retirement loses no
screen-reader information.

### New obligations

1. Real tab semantics — `role="tablist"/"tab"/"tabpanel"`, `aria-selected`, `aria-controls`,
   `aria-labelledby`, roving tabindex, arrows + Home/End. **Do not copy Accounts' current plain
   `<button>` tabs** (`accounts:477-489`), which express no relationship.
2. Announce tab changes via a shared polite `aria-live` region.
3. Move focus to the revealed `tabpanel` (`tabIndex={-1}` + `.focus()`) on tab change.
4. **Skip-to-content link** — still missing.
5. **Route-change focus reset + page announcement** via `usePathname` — still missing.
6. Review badge must carry an accessible name including the count
   (`aria-label="Flow, 7 items to review"`), never colour alone.
7. Browser back/forward must move between tabs (guaranteed by `?tab=`).

Items 4 and 5, plus the live region in item 2, are the three P0 shell items from the mobile-first
spec that are **not present** in the current 25-line `ClientLayout.tsx`. A tabbed architecture
makes them mandatory rather than optional.

---

## 11. Files likely affected during implementation (UX-NAV-002)

### Certain
| File | Change |
|---|---|
| `src/lib/nav.ts` | 7 items → 4 primary + a `More` entry; add a `badge` field |
| `src/components/Navbar.tsx` | strip route links + duplicate "Manage Accounts" + Net Balance; add page title, freshness, search, review count; delete the mobile hamburger |
| `src/components/BottomNav.tsx` | add the More item + badge rendering |
| `src/components/ClientLayout.tsx` | add skip link, shared `aria-live` region, route-change focus reset; mount the desktop rail |
| `src/app/flow/page.tsx` | becomes a tabbed container; read `?tab=`; delete the pinned-node drill-down table (`:662-688`) in favour of the Transactions tab |
| `next.config.ts` | add `async redirects()` |
| `src/app/dashboard/page.tsx` | `<h1>` → "Overview"; `:829` `/calendar` → `/flow?tab=transactions`; drop preview blocks that now duplicate tabs |

### New files
- a desktop left rail component (e.g. `src/components/SideRail.tsx`)
- a shared, accessible tabs component (used by both Flow and Accounts)
- `src/components/MoreSheet.tsx` (wrapping the existing `Sheet`)
- tab bodies extracted from the retiring pages

### Deleted / relocated
| File | Fate |
|---|---|
| `src/app/history/page.tsx` | → Flow Transactions tab (**minus** the Runway toggle) |
| `src/app/analytics/page.tsx` | → Flow Insights tab |
| `src/app/cashflow/page.tsx` | deleted; keep only its two charts if Insights lacks them |
| `src/app/calendar/page.tsx` | deleted |
| `src/components/RunwayCalculator.tsx` | orphaned once History's toggle goes — delete or adopt into Forecast |

### Touched for consistency
- `src/app/login/page.tsx`, `src/app/signup/page.tsx`, `src/app/onboarding/page.tsx` — land on
  `/dashboard` instead of `/forecast`
- `src/app/accounts/page.tsx` — `<h1>` "Account Settings" → "Accounts"; adopt the shared tabs
  component + `?tab=`; add the `/flow?tab=transactions&account=<id>` link that finally gives the
  deep-link contract a producer
- `src/app/settings/page.tsx` — unchanged in scope; verify the profile-menu path still reaches it

---

## 12. Conflict and dependency analysis

Diffed against both active branches at `534a44c`.

### `feat/obs-001-accounts-observability` (OBS-001) — **real overlap**

| File | Conflict risk |
|---|---|
| `src/app/accounts/page.tsx` | **Medium.** OBS-001 changes 24 lines (adds `AccountsDiagnostics`). UX-NAV-002 changes the `<h1>` and the tab strip. Different regions of the file; expect a textual conflict, not a semantic one |
| `src/middleware.ts` | **Avoidable — and avoided.** OBS-001 creates this file (39 lines). This architecture deliberately puts redirects in `next.config.ts` instead. Do not change that decision |
| `src/context/*.tsx`, `src/lib/firestore.ts` | **None.** UX-NAV-002 does not touch data plumbing |
| `src/app/dev/accounts-fixture/*`, `src/lib/obs/*`, `e2e/`, `playwright.config.ts` | **None** — new files, no overlap |
| `jest.config.js`, `jest.setup.js`, `package.json` | **Low.** UX-NAV-002 should add no dependencies; if it adds tests, merge OBS-001's jest changes first |

**Recommendation:** land OBS-001 before UX-NAV-002 so its `middleware.ts` and jest setup are
already in the integration branch when nav work rebases.

### `hotfix/sec-001-remove-public-ai-routes` (SEC-001) — **no overlap**

Touches only `src/app/api/ai/decision/route.ts` and `src/app/api/parse-receipt/route.ts`
(both deleted), `AI.md`, and one new test. Neither is a navigable route; neither appears in
`nav.ts` or any nav component. **Zero conflict. Can land in any order.**

One downstream note: `ReceiptScannerModal` is used by History (`history:844`) and `QuickAddFAB`.
If SEC-001's deletion of `/api/parse-receipt` leaves that modal without a backend, the
Transactions tab inherits the problem. That is SEC-001's concern, not a nav blocker, but
UX-NAV-002 should verify the scanner still works after both branches land.

### Owner's uncommitted work

The integration working directory has uncommitted edits to `src/components/DataChatSheet.tsx`
and `src/__tests__/data-chat-sheet.test.tsx`. **Not touched by this task.** UX-NAV-002 keeps the
sparkle chat trigger in the top bar and should not restructure `DataChatSheet` — that component
is the seed of the future Review tab and is actively being edited.

### Dependency on the future Money Review task

`?tab=review` is reserved in the tab contract and the Flow destination carries the badge, so the
review workspace can land without another nav change. UX-NAV-002 should ship the badge plumbing
(a count prop, an accessible name, a live-region update) even if the count is hardcoded to 0.

---

## 13. Exact recommendation handed to UX-NAV-002

1. **Implement four primary destinations** — Overview `/dashboard`, Forecast `/forecast`,
   Flow `/flow`, Accounts `/accounts` — in `src/lib/nav.ts`. Add a fifth `More` entry rendered
   on mobile only.
2. **Desktop:** build a compact left rail with those four items. Strip the route links, the
   duplicate "Manage Accounts" entry and the Net Balance readout from `Navbar.tsx`; the top bar
   keeps only page title, sync freshness, search, review count, theme/profile menu, and
   contextual page actions.
3. **Mobile:** keep `BottomNav` at five items with `More` in the fifth slot opening the existing
   `Sheet`. Delete the hamburger at `Navbar.tsx:194-201`.
4. **Make `/flow` a tabbed container** with `?tab=flow|transactions|insights|review`, default
   `flow`. Move History's full CRUD/ingest surface into `transactions`; move Analytics plus
   Cashflow's two surviving charts into `insights`; reserve `review` (empty or hidden, but
   routed). Delete Flow's own drill-down table at `:662-688` and have a pinned node filter the
   Transactions tab instead.
5. **Do not carry History's Runway toggle across.** Forecast already answers it, with a
   selectable horizon. Delete `RunwayCalculator.tsx` or adopt it into Forecast.
6. **Retire `/calendar` and `/cashflow` entirely.** Do not port Calendar's raw-`t.type` math.
7. **Add `async redirects()` to `next.config.ts`** per §7. Do **not** use `src/middleware.ts` —
   OBS-001 owns it. Add a test proving `/history?account=abc` reaches
   `/flow?tab=transactions&account=abc`.
8. **Build one shared, accessible tabs component** (`role="tablist"`, roving tabindex,
   `aria-controls`/`aria-labelledby`, focus moved to the panel on change) and use it for both
   Flow and Accounts. Give Accounts' eight existing tabs URL state with the same `?tab=`
   contract.
9. **Close the three P0 shell gaps** while the shell is open: skip-to-content link, shared polite
   `aria-live` region, route-change focus reset via `usePathname` in `ClientLayout.tsx`.
10. **Ship the review-badge plumbing** on the Flow destination — count prop, accessible name
    including the count, live-region update — even with the count hardcoded to 0.
11. **Copy fixes:** Overview `<h1>` "Welcome back, {name}!" → "Overview"; Accounts `<h1>`
    "Account Settings" → "Accounts"; Dashboard `:829` "View All Transactions" → the Transactions
    tab.
12. **Standardise the post-auth landing on `/dashboard`** across `login:34,46,61`,
    `signup:38,79,104`, `onboarding:190,521,538,1808`.
13. **Link the account drill-down from Accounts** to `/flow?tab=transactions&account=<id>`,
    giving that documented contract a producer for the first time.
14. **Sequencing:** land OBS-001 first (it creates `src/middleware.ts` and edits jest setup);
    SEC-001 can land in any order.

### Explicitly out of scope for UX-NAV-002

Restructuring Accounts' eight internal tabs; merging Settings into Accounts; unifying the three
duplicated chart pipelines (findings A/B) into one shared component; extracting the shared
5-tile summary row (finding F). All four are worth doing and all four are separate tasks.

---

## 14. Could not be determined

- **Real usage frequency.** The frequency column in the audit matrix is inferred from what each
  screen computes and how it is linked, not from analytics — the app has no usage telemetry at
  this baseline (OBS-001 adds diagnostics, not product analytics). If the owner disagrees with
  any frequency call, that judgement should win over this inference.
- **Whether Accounts' setup-only tabs (Budget, Category Budgets, Income Sources) belong under
  Settings.** Answering it requires a product conversation about the Accounts/Settings boundary
  that a navigation audit cannot settle. Flagged, not decided.
- **Whether the Cashflow "Actually kept" tile is a framing the owner values.** Flow's waterfall
  computes the same residual more rigorously, but Flow does not surface it as a single headline
  number. If the owner likes the framing, add one story tile to Flow computed from the graph;
  this was not assumed.
- **Whether `ReceiptScannerModal` still functions after SEC-001 deletes `/api/parse-receipt`.**
  Not verified — outside this task's read scope and not a navigation blocker.
- **Visual/interaction behaviour on real devices.** No local server was run and no signed-in
  session was opened, per the privacy constraint. All findings are static-analysis findings.
