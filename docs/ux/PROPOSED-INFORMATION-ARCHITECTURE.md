# Proposed Information Architecture (UX-IA-001)

**Date:** 2026-08-02
**Baseline:** `feat/transfer-type-monarch-ingest` @ `534a44c`
**Status:** decided. One architecture, not a menu of options.
**Evidence:** [`NAVIGATION-AND-SCREEN-AUDIT.md`](./NAVIGATION-AND-SCREEN-AUDIT.md)

---

## 1. The decision

**Four primary destinations, organised by the question's tense, plus a "More" overflow on
mobile only.**

```
Overview   /dashboard   "Am I OK right now?"          — present tense
Forecast   /forecast    "Will I be OK?"               — future tense
Flow       /flow        "Where did it actually go?"   — past tense   [tabbed, badged]
Accounts   /accounts    "What do I own and owe?"      — balance sheet [tabbed]
```

Nine authed routes collapse to four. Four routes are consolidated (`/history`, `/analytics`,
`/cashflow`, `/calendar`); Settings and Onboarding stay out of primary navigation, as required.

### Why tense is the organising axis

Every alternative axis fails on evidence:

- **By data type** (transactions / accounts / charts) fails because Analytics, Cashflow and
  Dashboard all read the *same* `transactions` array through the *same* `classifyTransaction`
  — a "charts" destination would just be a fourth copy of §5A/§5B of the audit.
- **By task** (review / plan / manage) fails because reviewing and planning share
  `withDerivedBalances` and would fight over Forecast.
- **By tense** matches the code exactly: `/flow` is the only consumer of the integer-cent past
  ledger (`src/lib/flows.ts`); `/forecast` is the only consumer of the projection engine
  (`generateForecast` + `buildAssumptions`); `/accounts` is the only writer of account
  entities; `/dashboard` is the only "now" summary. Four engines, four destinations.

### Why Flow is the container, not a peer

Flow already owns the most rigorous representation of the past ledger — cent-exact, with
unit-tested conservation and a reconciliation gap detector. History, Analytics and Cashflow are
all float-precision re-derivations over the same rows (audit §5A–§5C). Making Flow the container
means the aggregate and the rows finally live behind one URL, and Flow's own stunted drill-down
table (`flow/page.tsx:662-688`) gets deleted rather than maintained.

---

## 2. Primary destinations

### 1. Overview — `/dashboard`, label "Overview"

Landing surface. Re-scoped to only what it uniquely does: **status and alerts**, not previews.

- Keep: setup-incomplete banner, upcoming-bill alert, the 5-tile summary row, the forecast
  status card as a *link*.
- Change: `<h1>` becomes "Overview" (today it reads "Welcome back, {name}!"), so nav label,
  page title and top-bar title agree.
- Change: "View All Transactions" (`dashboard:829`) repoints from `/calendar` to
  `/flow?tab=transactions`.
- **Route is not renamed.** `/overview` would break the root redirect (`page.tsx:47`), the logo
  link (`Navbar.tsx:62`) and every bookmark, and buys nothing.

### 2. Forecast — `/forecast`

Unchanged in scope. Gains History's abandoned Runway concern only insofar as it already answers
it (Runway-days and Runway-months tiles at `forecast:356-394`).

### 3. Flow — `/flow`, label "Flow", tabbed, **carries the review badge**

| Tab | `?tab=` | Content | Source |
|---|---|---|---|
| **Flow** (default) | `flow` | Sankey / treemap / waterfall, story tiles, reconciliation table, between-accounts, recurring, "at this rate" | today's `/flow` |
| **Transactions** | `transactions` | full ledger: filters, grouping, search, add / edit / delete-with-paired-leg-guard, CSV import, receipt scan | today's `/history` **minus** its Runway toggle |
| **Insights** | `insights` | period stepper, pace projection, merchant ranking + merchant pie, category breakdown, 12-period trend | today's `/analytics` + the two charts worth keeping from `/cashflow` |
| **Review** | `review` | *(future — UX-REVIEW task)* unclassified inflows, uncategorised expenses, AI discussion | new |

**Room for Money Review is reserved now:** `?tab=review` is allocated in the tab contract even
though the tab ships empty or hidden initially, and the "Flow" primary destination carries a
**count badge** (see §6). The badge belongs on the destination, not on the tab, so an unreviewed
count is visible from anywhere in the app. The existing `DataChatSheet` (the sparkle trigger in
`Navbar.tsx:100`) is the seed of the Review tab's AI discussion pane and should keep its global
entry point until Review absorbs it.

Cross-tab behaviour that justifies the merge: pinning a node on the **Flow** tab sets the filter
on the **Transactions** tab. That loop is impossible today because the two live on different
routes.

### 4. Accounts — `/accounts`

Unchanged in scope; its 8 existing in-page tabs (`accounts:465-473`) gain URL state via the same
`?tab=` contract so they become deep-linkable and back-button-correct. Its `<h1>` changes from
"Account Settings" to "Accounts" so it stops colliding with `/settings`.

---

## 3. Secondary destinations and where they live

| Capability | Placement | Rationale |
|---|---|---|
| Settings (`/settings`) | Desktop: profile menu in the top bar. Mobile: **More** sheet. | Required — must not hold a primary position. Already correct today. |
| Export data | Inside Settings (already there) + top-bar page action where relevant | Low frequency. |
| Theme toggle | Top bar (desktop) / More sheet (mobile), plus its existing Settings row | Per the brief's top-bar contents. |
| Sign out | Profile menu (desktop) / More sheet (mobile) | Unchanged. |
| AI data chat | Global sparkle button in the top bar (unchanged) until Review absorbs it | Preserves an existing global affordance. |
| Onboarding (`/onboarding`) | **Never in navigation.** Reached only from the setup-incomplete banner via `?continue=true`. Already self-guarding at `onboarding:188-192`. | Required. No change needed. |
| Runway | Forecast's existing tiles | History's copy is deleted (audit §5E). |
| Calendar month grid | **Retired.** | Wrong math (audit §5D) and its unique affordance is already covered by `AddTransactionModal`'s `defaultDate`. |
| Account transaction drill-down | Transactions tab via `?account=<id>` | Preserves the documented `/history?account=` contract and finally gives it a producer (a link from Accounts). |

---

## 4. Consolidated routes and full redirect strategy

All consolidations preserve query parameters. `/flow` gains a `?tab=` parameter; unknown or
missing values fall back to `tab=flow`.

| Former URL | New URL | Type | Notes |
|---|---|---|---|
| `/history` | `/flow?tab=transactions` | 308 permanent | Runway sub-view not carried (was React state, no URL to preserve) |
| `/history?account=<id>` | `/flow?tab=transactions&account=<id>` | 308 permanent | **Contract-critical.** Read at `history:63-65`; must survive verbatim |
| `/history?<other>` | `/flow?tab=transactions&<other>` | 308 permanent | Pass unmatched params through unchanged |
| `/analytics` | `/flow?tab=insights` | 308 permanent | No query state exists today |
| `/cashflow` | `/flow?tab=insights` | 308 permanent | Its `range` state (`12m`/`ytd`/`all`) was React state, not URL |
| `/calendar` | `/flow?tab=transactions` | 308 permanent | Grid retired |
| `/flow` | `/flow?tab=flow` | none — default | No redirect; absent `tab` renders the Flow tab |
| `/dashboard`, `/forecast`, `/accounts`, `/settings`, `/onboarding`, `/`, `/login`, `/signup`, `/forgot-password` | unchanged | — | — |

### Where to implement the redirects

Use **`async redirects()` in `next.config.ts`** — which is currently an empty config object.

Do **not** use `src/middleware.ts`. That file does not exist at this baseline but the OBS-001
branch (`feat/obs-001-accounts-observability`) creates it. Putting redirects there guarantees a
merge conflict for no benefit. `redirects()` is also evaluated before rendering, so it costs
nothing at runtime.

Firebase Hosting is configured with `frameworksBackend` (SSR), not `output: 'export'`, so
`redirects()` is honoured in production. Verified in `firebase.json`.

```ts
// next.config.ts — sketch only; UX-NAV-002 owns the implementation
async redirects() {
  return [
    { source: '/history',   destination: '/flow?tab=transactions', permanent: true },
    { source: '/analytics', destination: '/flow?tab=insights',     permanent: true },
    { source: '/cashflow',  destination: '/flow?tab=insights',     permanent: true },
    { source: '/calendar',  destination: '/flow?tab=transactions', permanent: true },
  ];
}
```

Next.js `redirects()` forwards unmatched query parameters automatically, so
`/history?account=abc` lands on `/flow?tab=transactions&account=abc` without extra work. This
must be covered by a test rather than assumed.

### Also update these in-app links (they are not covered by redirects)

| File | Line | Today | Becomes |
|---|---|---|---|
| `src/app/dashboard/page.tsx` | 829 | `router.push('/calendar')` | `/flow?tab=transactions` |
| `src/app/cashflow/page.tsx` | 157 | `<Link href="/history">` | route is deleted with the page |
| `src/lib/nav.ts` | 18-26 | 7 items | 4 items + `More` (mobile) |

### Resolve the landing-route inconsistency

`login`, `signup` and `onboarding` land on `/forecast` while the root gate and the logo land on
`/dashboard` (audit §1). Pick **`/dashboard`** for all of them — the Overview is the "am I OK"
glance and the correct cold-start surface; opening a new user onto a 90-day projection is worse.
Files: `login:34,46,61`, `signup:38,79,104`, `onboarding:190,521,538,1808`.

---

## 5. Desktop navigation decision

**A compact left navigation rail, and a top bar that stops repeating it.**

Today `Navbar.tsx:78` renders all seven routes in the top bar *and* the profile dropdown adds an
eighth link ("Manage Accounts") that duplicates one of them. That is the exact duplication the
brief forbids.

**Left rail** (persistent, `md:` and up, icon + label, collapsible to icons at `lg:` and below):
1. Overview 2. Forecast 3. Flow *(badge)* 4. Accounts

Four items is well inside the 4–5 ceiling and leaves the rail visually calm. It uses
`aria-current="page"`, mirroring the existing BottomNav pattern.

**Top bar** carries only:
- page title (matching the nav label — this is why the Overview `<h1>` fix matters)
- sync / data-freshness indicator (Accounts' `describeSync` already produces this text; promote
  it to the shell so freshness is visible everywhere, not only on `/accounts`)
- global search
- review count (the badge's canonical home; the rail badge mirrors it)
- theme + profile menu → Settings, Export, Sign out
- contextual page actions (e.g. Flow's Maximize, Accounts' "Refresh from banks")

**Removed from the top bar:** the seven route links, the duplicate "Manage Accounts" entry, and
the always-on "Net Balance" readout (that number is Overview's and Accounts' job; the top bar is
not a dashboard).

**Tabs render inside the destination**, below the page title — never in the rail. Rail = *where
am I*; tabs = *which view of here*.

---

## 6. Mobile navigation decision

**Bottom tab bar, five items, no left sidebar ever.**

```
[ Overview ]  [ Forecast ]  [ Flow• ]  [ Accounts ]  [ More ]
```

- Keeps the locked owner decision from the mobile-first spec (bottom tab bar, max 5,
  thumb-reach) and keeps the current `BottomNav.tsx` structure — only `NAV_ITEMS` changes.
- The consolidation **frees the fifth slot**, which becomes **More** — an explicit destination
  rather than today's top hamburger. More opens the existing `Sheet` component (bottom sheet,
  focus trap, Esc, iOS scroll lock) containing: Settings, Export, Theme, Sign out, and the
  profile block.
- The hamburger in `Navbar.tsx:194-201` is **deleted**. Its mobile menu currently duplicates
  every route plus Settings plus Sign out — all of which More now owns.
- **Flow carries a numeric badge** for the pending review count, rendered as a small pill on the
  tab icon. It must be announced, not merely painted — see §7.
- In-destination tabs are a horizontally scrollable chip row under the page title, the pattern
  Accounts already uses (`accounts:464`, `.scroll-x-mobile` in `globals.css:771`). With four
  Flow tabs all four fit on a 360px viewport without scrolling, which is an improvement over
  Accounts' eight.
- The `QuickAddFAB` keeps its `bottom-24` lift above the bar (`QuickAddFAB.tsx:31`). Since
  Transactions is now a tab rather than a route, the FAB's "Add Expense" should route the user
  to `/flow?tab=transactions` after a save so the new row is visible.

---

## 7. Accessibility impact

### Preserved as-is (regression risk — verify each)

Everything in §8 of the audit: BottomNav's `aria-label="Primary"` / `aria-current` / 56px
targets / safe-area padding; Flow's maximised-overlay focus trap and restore; `role="img"` +
`ChartSrTable` text alternatives on every chart; Sankey node `tabIndex`/`role="button"`/
`aria-label`/`aria-pressed`/44px hit rects; the `e.pointerType === 'mouse'` hover guard; 44px
touch targets across Navbar, History rows and `<summary>` elements; `prefers-reduced-motion` plus
`isAnimationActive={false}`; global `:focus-visible`; the `role="status"` / `role="log"` live
regions; the pre-paint theme script; `viewportFit: 'cover'` with pinch-zoom intact.

Two specific carry-forwards:
- **History's mobile filter disclosure** (`history:438-449`) — `aria-expanded`, 44px, with an
  active-filter count — must survive into the Transactions tab unchanged.
- **Calendar's per-day `aria-label`** pattern (`calendar:216`, naming date + count + net) should
  be reused for date-group headers in the Transactions tab, so the retirement loses no
  screen-reader information.

### New obligations created by this architecture

1. **Tabs must be a real tab pattern.** `role="tablist"` / `role="tab"` with
   `aria-selected` and `aria-controls`, panels with `role="tabpanel"` and `aria-labelledby`,
   arrow-key roving tabindex, Home/End. Today Accounts' tabs are plain buttons with no
   relationship expressed — do not copy that.
2. **Tab changes must be announced.** A tab switch changes the whole page body without a route
   change, so a screen reader gets nothing by default. This needs the shared polite `aria-live`
   region that the mobile-first spec's P0 listed but which is **not present** in the current
   25-line `ClientLayout.tsx`. Announce e.g. "Transactions. 412 rows."
3. **Focus must move on tab change** to the newly revealed `tabpanel` (`tabIndex={-1}` +
   `.focus()`), not stay on the tab strip — otherwise a keyboard user tabs through the entire
   strip again to reach content.
4. **Skip-to-content link** — still absent. A four-item rail plus a tab strip is more to skip
   past than today's flat nav, so this moves from nice-to-have to required.
5. **Route-change focus reset and page announcement** via `usePathname` — the third missing P0
   shell item; a rail navigation leaves focus on the rail otherwise.
6. **The review badge must be accessible.** A bare number pill is invisible to assistive tech.
   Give the Flow destination an accessible name that includes the count — e.g.
   `aria-label="Flow, 7 items to review"` — and update the shared live region when the count
   changes. Never encode the state in colour alone.
7. **Back button must restore tab state.** `?tab=` in the URL makes browser back/forward move
   between tabs, which is the correct expectation once a tab looks like a page.
8. **More sheet** reuses the existing `Sheet` component so it inherits the focus trap, Esc
   handling and the iOS `body{position:fixed}` scroll lock the mobile-first spec identified as
   P0.

### Net accessibility change

Positive. Four rail items instead of seven top-bar links plus a duplicate; one hamburger menu
deleted; three long-outstanding shell gaps (skip link, live region, focus reset) forced into
scope by the tab pattern. The main new risk is the tab pattern itself, which is well-specified
above and must not be shipped as bare `<button>`s.

---

## 8. What this architecture deliberately does not do

- **Does not rename `/dashboard` or `/flow`.** Renaming buys nothing and breaks bookmarks, the
  root redirect and the logo link.
- **Does not merge Accounts into anything.** It owns distinct entities and the only sync trigger.
- **Does not merge Forecast into Flow.** Different tense, different engine (audit §6, hypothesis 4).
- **Does not merge Settings into Accounts** despite the naming collision. Flagged as a copy fix
  ("Account Settings" → "Accounts"), not a route change.
- **Does not restructure Accounts' eight internal tabs.** Some are arguably setup-only and belong
  under Settings; that is a separate product question, out of scope for a navigation audit.
- **Does not reduce route count for its own sake.** Every consolidation above is backed by a
  named shared calculation that two screens both call.
