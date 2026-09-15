# CashFlow — standing brief for Claude

You are a senior product engineer + UI implementer on a solo personal-finance system. Ship professional, mobile-first, bug-free work that can sit next to Copilot / Monarch / Linear — not another dashboard template.

## Repos
- Engine + web (source of truth): https://github.com/BhuvaneswarMarreddy/cashflow-forecast
  Live: https://marreddy-cashflow.web.app
- Phone client: https://github.com/BhuvaneswarMarreddy/cashflow-mobile
  Expo / RN. Computes NO money. Every figure is integer cents from callables that run web `src/lib/**`.

Current web `main` was deployed at `1a5a9a2`. iOS fixes (e.g. #58) are in git, not on TestFlight until a human uploads.

## The product question
Where did my money actually go, and what happens in the next 90 days?

## Money invariants (stop if a change would break these)
1. Classification is derived on read. Provider fields are immutable. Owner decisions live in `users/{uid}/reviews/{txnId}`.
2. `interpretTransaction()` is the only interpretation. Totals only via `sumIncomeCents` / `sumExpenseCents`. Never re-sum from a stored `type`.
3. Integer cents. Unknown is `null`, never `0`.
4. Earned income only if it matches `users/{uid}/income` or the owner confirmed it. Else `unknown_inflow` + review queue. Ambiguous → unknown. Do not guess.
5. A transfer is movement between the owner’s own accounts in the same currency. Card payments to my cards are transfers, not spend.
6. AI proposes; a confirmation button writes. Closed parser. No ledger writes from the model. No invented amounts or account names.
7. Fingerprint dedupe: two feeds of the same charge enrich one row. Ambiguous account match demotes every claimant.
8. Balance anchors use the bank figure dated to the bank’s timestamp, not today.
9. One engine. If mobile needs a number, add or extend a callable. Never a second formula on the phone.

If a rule has a dollar figure in a source comment, that measurement is why the rule exists. Do not “simplify” it.

## Architecture constraints
- Web first for any money behaviour. Mobile renders after the callable matches the web page to the cent.
- Plaid for US institutions (Transactions + Balance). Charles Schwab is in scope: OAuth, accounts start unchecked, ONE live Schwab Item per app — never Link Schwab twice. Tokens in Secret Manager / server docs only. Never `NEXT_PUBLIC_` secrets.
- India (NRE / NRO / FDs / leftover resident) = CSV / statement import. No Plaid. Do not auto-pair US↔India wires (different cents / FX). Multi-currency is designed, not built — do not silently convert INR into USD runway.
- `/calendar` is a redirect to `/forecast?tab=cashflow`. Do not revive a sixth tab. Month up/down lives in Forecast, then the widget snapshots that payload.
- `getAccounts` filtering `isActive == true` must not erase legacy history. Use a `legacy` role, do not delete.

## Design system (UI-100) — contract, not mood
Midnight Ledger dark `#101014` / Paper & Gold light `#FAF7EF`.
Three meanings only:
- Gold `#D9A521` dark / `#8A6D0B` light = brand, progress, warning (not a 4th hue)
- Teal `--money-in` `#1FA2A8` / `#177864` = money in (NEVER green; old red/green was deutan ΔE 2.4)
- Red `--money-out` `#E5484D` / `#C0393F` = money out / hard error

Radii: control 10 / card 16 / pill 999.
Type: serif (Iowan Old Style / Palatino) for hero numbers and screen titles; sans for UI; tabular nums on money.
Touch: 44px minimum. Web `.tap-target` grows hit box without growing layout.
Measure: `max-w-content` 896px.
Tokens are pinned by `design-tokens.test.ts` and mobile `src/theme/palette.ts` (hexes copied from `globals.css`). Do not introduce a second teal or a chart-green on the calendar.
Flow/Sankey `FLOW_COLORS` stay on Flow nodes only. Calendar and widget use `--money-in` / `--money-out` / muted only.
Auth may stay Paper; after login default to Midnight unless the user toggle says otherwise. Do not let `prefers-color-scheme` fight `data-theme`.
Gold as small tab text on cream fails contrast — active tab needs weight + indicator, not 10px gold-only.

## UI bar (mobile-first, professional)
Compete with Copilot / Monarch on the phone and Linear on the desktop.

IA — four thumb destinations, not five plus a colliding FAB:
- Home `/dashboard` — “Am I OK now?” Runway hero, what changed, next bills. Not a widget junk drawer.
- Forecast `/forecast` — “Will I be OK?” Includes the month up/down grid (cashflow tab).
- Activity `/history` — the ledger list. Flow (`/flow`) is the picture of the same past; do not give Flow its own tab. Keep the route.
- Accounts `/accounts` — own / owe, Plaid connect, import.

FAB = add transaction only, must not cover Accounts. Prefer header action or a center-tab gap on mobile web.
Desktop: change structure at `md`/`lg` (split auth, side column on Home). Do not only hide the tab bar.
Own every system surface in theme: 404, loading, empty, offline. The stock Next 404 on white with gold FAB still mounted is unacceptable.
One CTA per job. Login must not say “Sign up” twice.
Signup: primary button fully visible on a 390pt screen without scrolling past the card clip.
Copy: calm, precise. Empty/error states say what happened and the next tap. Never show $0 when the value is unknown.

## Month calendar + widget (shared contract)
Callable `getCalendarMonthCents`:

Input: `{ year, month, accountIds?: string[] }`
Omitted `accountIds` = US operating cash only (no legacy / NRE / NRO until currency ships).

> **Open question before building — #188.** Card purchases post on the card account, and card payments are transfers, so an operating-only scope drops card spending entirely (probe: same ledger, month net +$3,000.00 operating-only vs +$2,915.88 with cards). Resolve the default scope in #188 first.

Output:

```ts
{
  year: number;
  month: number;
  currency: "USD";
  monthNetCents: number | null;
  monthIncomeCents: number | null;
  monthExpenseCents: number | null;
  days: Array<{
    date: string; // YYYY-MM-DD
    netCents: number | null;
    incomeCents: number | null;
    expenseCents: number | null;
    hasActivity: boolean;
  }>;
  asOf: string; // ISO
}
```

Posted rows only. Day net = income − expense after interpret. Transfers do not paint a day red. Null month → “Not available”.

Web grid: 7 columns, teal / red / muted, serif month net, tap → that day’s activity.

Widget (mobile, later): App Group JSON only. Small = week + month net. Medium = month grid. Tap `cashflow://calendar?date=`. No Plaid, no Firestore, no re-sum in the extension. Reload on sync / review flush, not a 1-minute timer.

## How to work
- Read README, FLOW_ENGINE.md, ARCHITECTURE.md, `src/lib/classify.ts`, transfers, forecast, `nav.ts`, `globals.css`, and existing tests before touching money or chrome.
- Small PR. Match file layout and names. Prefer fixing the root (one interpreter, one token) over a screen-local patch.
- Every classification / sum / forecast / calendar change gets a Jest test that names the user-visible lie it prevents.
- No new Plaid products (Investments / Schwab positions) unless the slice says so.
- No logs of tokens, account numbers, or raw Plaid payloads.
- If DATABASE.md disagrees with README, follow README and fix the doc in the same PR.
- Do not rewrite the design system or add screens. Fold into the four destinations.

## Definition of done
- Mobile-width (390) and desktop (1280) both look intentional.
- Web totals agree across Home, Forecast, Activity, Flow, export.
- Tests green for the slice.
- Callable contract updated if mobile will need the field.
- No second money path on iOS.

## Do not do in a random slice
FX / INR conversion, Schwab Investments product, multi-tenant billing, restoring Analytics/Calendar/Cashflow as top-nav tabs, a second classifier, decorative extra hues, fake “Record cash” buttons.

## Slice protocol
I will start each session with one line, for example:
- Slice: designed 404 + empty + loading in theme. No money changes.
- Slice: Home `/dashboard` = runway-first mobile layout matching the iOS Home question order.
- Slice: tab bar four destinations; Flow reachable from Activity; FAB must not cover Accounts.
- Slice: `getCalendarMonthCents` + Forecast month grid + tests. No widget native yet.
- Slice: Plaid Link Schwab on web only; transfers checking↔brokerage are not spend.

Do that slice. Stop. List what you changed and what you did not.

---

# UI implementation spec — CashFlow web (mobile-first)

You implement pixels. You do not invent money math, Plaid products, FX, or new top-level routes.

Read before any edit:
- `src/lib/nav.ts`
- `src/components/ClientLayout.tsx`
- `src/components/BottomNav.tsx`
- `src/components/Navbar.tsx`
- `src/components/QuickAddFAB.tsx`
- `src/app/globals.css`
- `src/app/dashboard/page.tsx` (already has UI-102 runway hero — extend, do not replace with a widget wall)
- `src/app/login/page.tsx` `signup/page.tsx` `forgot-password/page.tsx`
- `src/app/not-found.tsx` if it exists; if not, create it
- `src/__tests__/design-tokens.test.ts`
- `src/__tests__/home-screen-contract.test.ts` if present

Do not edit `src/lib/classify.ts`, `transfers.ts`, `forecast.ts`, ingest, Firestore rules, or callables in a UI-only slice.

## 0. Design constants (use these numbers; do not freestyle)

### Breakpoints
- `sm` 640 / `md` 768 / `lg` 1024
- Phone chrome: `< md` = BottomNav + FAB rules below
- `md+` = top Navbar only, no BottomNav, FAB at `bottom-6 right-6`

### Space (4px grid only)
- Screen inset: `px-4` (16). `lg:px-8` (32) on desktop.
- Section gap: 24 (`mb-6` / `gap-6`). Tight stack inside a card: 12.
- Card padding: 16 phone / 20 desktop (`p-4 lg:p-5`) — dashboard hero already does this.
- Content width: `max-w-content` (896px) centered. Do not make Home full-bleed.

### Type
- Screen title / hero number: `.hero-number` (serif, 28px → 40px at 1024, tabular).
- Section label: 11px, 700, uppercase, tracking 0.08em, `--accent-primary`.
- Body: 14–16px sans, `--foreground`.
- Secondary: 14px `--foreground-secondary`.
- Tab label: 11px minimum (today 10px — raise it). Font-weight 600 when active.
- Never put a money figure in the Navbar.

### Color roles
- Surfaces: `--background` page, `--background-secondary` cards, `--background-tertiary` inputs/wells.
- Border: `--border-color`. Focus: 3px ring using `color-mix(in srgb, var(--accent-primary) 25%, transparent)` — not the leftover `rgba(201,162,78,…)`.
- Money on UI: `--money-in` / `--money-out` only. No `#22c55e`, no Flow `#0d9488` on Home/calendar.
- Filled gold buttons: dark text `#16181c` or `palette.gold.onGold`. Never white on `#D9A521` in dark theme.
- Active tab: `--accent-primary` + 2px gold indicator on the TOP edge of the tab item (not color-only).

### Radius / hit
- Inputs, chips, tab items: `rounded-control` (10)
- Cards, sheets, 404 panel: `rounded-card` (16)
- FAB, avatars: `rounded-pill`
- Hit target ≥ 44×44. Icon-only controls use `.tap-target`.

### Motion
- 120ms color, 200ms transform. FAB hover `scale(1.05)` already exists; add `active:scale-95`.
- `@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }` if missing.

## Phase A — system surfaces (do first; no IA change)

### A1. `src/app/not-found.tsx` (create if missing)
Must use app theme, not default Next white.

Layout:
- Same excluded-chrome rule as login: NO BottomNav, NO FAB on 404. Today 404 still mounts FAB+tabs because `ClientLayout` only excludes a hard list. Fix: treat unknown routes as no-chrome OR add a `not-found` path to the exclude list and render a self-contained page.

Content:
- LogoMark 36
- Title (serif): “Page not found”
- Body: “That link does not exist in CashFlow.”
- One button: Link to `/dashboard` labeled “Go home”, `btn-primary`, min-h 44
- Paper or Midnight via existing `data-theme`. No raw black/white.

### A2. Loading
Any full-page wait (auth spinner on login already exists): gold coin pulse is OK. Do not invent a second spinner style. Skeleton blocks = `bg-[var(--background-tertiary)] rounded-control` as dashboard already does.

### A3. Empty / error copy contract
If a number is missing: sentence + one link. Pattern already on Home: “Not measured yet” + “Connect an account”. Reuse that voice. Never “N/A”, never `$0.00` for unknown.

### A4. Auth copy cleanup — `login/page.tsx`
Remove the duplicate footer. Keep ONE of:
- In-card: “Don’t have an account? Sign up”
- Delete “New here? Create an account — it takes about a minute.”

Tagline: change to “See where the money went, and what the next 90 days look like.” (product question, not Mint).

### A5. Signup — `signup/page.tsx`
Phone 390×844: primary submit must be fully visible without scrolling past the card. Do this, in order, until it fits:
1. Shrink LogoMark + wordmark stack (less margin above the card).
2. Reduce field vertical padding to 12/16, label `text-sm`, gap-3 between fields.
3. If still clipped: make the gold button `sticky bottom-0` inside the card with a 16px paper fade — last resort.

Confirm password stays. Do not drop fields.

**Acceptance A**
- `/does-not-exist` is themed, no FAB, one CTA.
- Login has a single signup line.
- Signup CTA fully on screen at 390 width (Playwright or a screenshot note).

## Phase B — chrome (tabs + FAB)

### B1. `src/lib/nav.ts`
Keep all five *routes*. Change what is a *tab*.

```ts
export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Home',     icon: LayoutDashboard, tab: true },
  { href: '/forecast',  label: 'Forecast', icon: LineChart,       tab: true },
  { href: '/history',   label: 'Activity', icon: History,         tab: true },
  { href: '/flow',      label: 'Flow',     icon: GitBranch,       tab: false }, // not a thumb tab
  { href: '/accounts',  label: 'Accounts', icon: CreditCard,      tab: true },
];
```

Navbar desktop may still show Flow (or put Flow as a text link on Activity). BottomNav uses `tab: true` only → four tabs.
On Activity (`/history`), add a local text control: “View as flow” → `/flow`. Do not add a sixth tab.
Update the comment in `nav.ts` so it matches the code (it already says four destinations; the array still has five `tab: true`).

### B2. `BottomNav.tsx`
- Four equal columns.
- `min-h-[56px]` plus `env(safe-area-inset-bottom)`.
- Label `text-[11px] leading-none`.
- Active: `font-semibold text-[var(--accent-primary)]` + `border-t-2 border-[var(--accent-primary)]` on the link.
- Inactive: `--foreground-secondary`.
- `aria-current="page"` already there; keep it.
- Active match: `pathname === href || pathname.startsWith(href + '/')`.
- `/flow` is not in the bar; if you are on `/flow`, highlight Activity (same tense). Implement: if pathname starts with `/flow`, treat `/history` as active.

### B3. `QuickAddFAB.tsx`
Problem: `bottom-20 right-4` sits on Accounts.

Phone (< md):
- Hide the corner FAB.
- Add a center action in BottomNav instead: four tabs with a 56×56 gold plus in the middle visually? That is 5 slots again.

Preferred (simpler, fewer bugs):
- Phone: do not render FAB. Put “Add” as a 44×44 gold plus in the top Navbar right on phone (Navbar already has a hamburger). One add affordance in the header.
- md+: keep current corner FAB at `bottom-6 right-6`.

If you keep a phone FAB: `bottom-[calc(56px+env(safe-area-inset-bottom)+12px)] right-4` AND add padding-right on the Accounts tab so the last label is tappable. Measure: FAB circle must not overlap the Accounts icon hit box. Write a comment with the px math.

`aria-label="Add transaction"` stays. Plus icon `#16181c`.

### B4. `ClientLayout.tsx`
Exclude: `/`, `/login`, `/signup`, `/forgot-password`, `/onboarding`, and not-found. Do not show FAB on phone if you moved Add to the header (useMedia or CSS `hidden md:flex` on the FAB).

### B5. Body padding
`globals.css` already pads phone body for the 56px bar. After FAB moves, keep `padding-bottom: calc(56px + env(safe-area-inset-bottom))`. Do not also add `pb-40` unless Home still needs it for a leftover FAB; dashboard currently uses `pb-40 md:pb-16` — reduce phone to `pb-24` if FAB is gone so Home does not feel short.

**Acceptance B**
- Phone tab count is 4.
- Flow still works via Activity link + desktop nav.
- Accounts tab is fully tappable.
- Add transaction still opens `AddTransactionModal`.

## Phase C — Home `/dashboard` as a phone product
The runway hero already exists (UI-102). Do not rebuild from a Dribbble dashboard.

Phone order, top → bottom (one column):
1. Optional “Finish setting up” banner (already there) — keep, full width.
2. Runway card (already there).
   - Label “Runway”
   - `.hero-number` + `.tnum` for the days string
   - One sentence of context (already)
   - Progress track: gold `--progress` on tertiary well; `rounded-pill`; height 8px
   - If no burn: “Not measured yet” + link to `/accounts` (already). Do not show 0 days.
3. “What changed” — last sync delta. If you have no change list on web yet, add a short list of at most 5 rows (merchant + signed amount). Use `--money-in` / `--money-out`. Empty: omit the section, do not fake rows.
4. Next bills — at most 3 rows: name, due date, amount. Link “All bills” into Forecast/plan if that route exists; else omit the link.
5. Stop. No analytics pie, no seven metric cards, no second forecast chart on Home.

Desktop lg+:
- Same content, not a different product.
- Optional: two-column under the hero (`grid lg:grid-cols-2 gap-6`) — changes | bills.
- Hero stays full measure.

Do not put filters “all / past / future” above the hero. If that filter exists on this page, move it to Activity.

**Acceptance C**
- First screenful on 390 height shows runway without scrolling past the hero.
- Unknown runway ≠ “0”.
- No pie charts on Home.

## Phase D — Forecast month grid (calendar replacement)
`/calendar` stays a redirect. Implement the grid as a section on `/forecast?tab=cashflow` (or the cashflow tab component that already exists).

### Visual
- Header: month name (serif heading) + month net (`.tnum`). Net uses `--money-in` / `--money-out` / muted if null.
- Weekday row: S M T W T F S, 11px muted, 7 columns `grid-cols-7 gap-1`.
- Day cell: min 44×44 (`min-h-11`), `rounded-control`.
  - `hasActivity && net > 0`: bg `color-mix(in srgb, var(--money-in) 18%, transparent)`, text `--money-in`
  - `hasActivity && net < 0`: same with `--money-out`
  - `hasActivity && net === 0`: tertiary well, secondary text
  - no activity: transparent, muted day number
  - today: 1px gold border, not a gold fill (gold is progress, not spend)
- Tap cell → `/history?date=YYYY-MM-DD` or existing day drill-down. Do not open a modal of 30 rows on the grid.
- Phone: grid is full content width. Do not squeeze 7 columns into a card with 32px padding both sides — use `p-3` on that card.

### Data
If `getCalendarMonthCents` does not exist yet, this phase STOPS after the layout with a fixture/mock that matches the contract. Do not compute a new day-total in the page. Prefer wiring a helper that already uses `sumIncomeCents` / `sumExpenseCents` per day — if that helper does not exist, leave a TODO and a fixture; do not copy-paste forecast math into JSX.

**Acceptance D**
- Transfer-only day is not red (test, when data is wired).
- Null month net renders “Not available”.
- No sixth tab.

## Phase E — desktop auth (optional, after A–C)
Login lg+: `grid lg:grid-cols-2`
- Left: wordmark + one sentence + optional static preview (CSS card, not a live chart).
- Right: existing form card. Phone stays single column as now.

## Tests you must add or extend
1. `nav.ts`: exactly four items with `tab: true`; `/flow` has `tab: false`.
2. BottomNav: on pathname `/flow`, Activity link has `aria-current="page"`.
3. not-found page exists and contains “Go home”.
4. Login page source does not contain the deleted “takes about a minute” string.
5. Home contract: hero uses `.hero-number`; no second budget in Navbar (existing UI-101 idea).
6. Do not weaken `design-tokens.test.ts`.

Prefer Playwright/screen tests only if the repo already has them (home-fixture). Do not add a new e2e stack in a UI slice.

## Explicit non-goals for UI slices
- Plaid / Schwab
- INR / FX / account role schema
- Native widget / App Group
- New color tokens
- Restoring Analytics, Calendar, Cashflow as tabs
- Replacing `interpretTransaction`
- Dark-mode marketing landing page
- Animating the Sankey

## How to report when you finish a phase
1. Files touched
2. Screenshot notes: 390 and 1280 for each changed surface
3. What you did not do
4. Any existing test that failed and why

Work Phase A only unless I name another phase. One phase per PR: A, then B, then C, then D.

---

## Appendix — repo operations (verified 2026-09-14)

### Shipping
- **A push to `main` deploys** `functions:api` + hosting (`.github/workflows/deploy.yml`), then smoke-tests the live pages and every callable. Never run `npm run deploy` after a merge. Pushes that change only `*.md` / `docs/**` do not deploy.
- `firestore.rules` and `functions-sync/` are **never** deployed by CI, on purpose. When main carries a change to them since the last successful deploy, the deploy opens (or comments on) a "Hand deploy needed" issue. Deploy from a fresh `git checkout main && git pull --ff-only` — `firebase deploy` ships the local tree.
- There is one Firebase project, and it is production. Tests use fixtures, mocks and the emulator only; screens are exercised through `/dev/*-fixture` routes.

### Checks (all run in `validate.yml` on every PR)

```
npx tsc --noEmit
npx jest                          # web
npm test --prefix functions       # Cloud Functions
python -m pytest functions-sync -q
npm run test:rules                # Firestore rules on the emulator
npm run test:e2e                  # Playwright: observability + every fixture screen
```

`e2e/screens.spec.ts` marks known screen defects with `test.fail` (#176, #177, #178). When you fix one, delete its line in `KNOWN`.

### The phone contract
`contracts/homeSnapshot.json` is recorded by `functions/src/__tests__/contract-homeSnapshot.test.ts`. If that test fails, you changed what the phone receives: re-record with `UPDATE_CONTRACTS=1 npm test --prefix functions -- contract`. The `mobile contract` CI job then runs cashflow-mobile's checks against it; if it fails, ship the mobile change first or keep the old field. A new callable the phone reads (e.g. `getCalendarMonthCents`) gets the same treatment.

### Engine habits
- **Nothing auto-applies.** Read `src/__tests__/counterparty-settlement.test.ts` before touching classification.
- **Pass the income policy** (`IncomeContext`) to `interpretTransaction` and friends. Omitting it silently creates a different income rule.
- Before believing a screen-level money bug, probe the engine: call `src/lib` directly in a throwaway test.

### CSS gotchas
- Tailwind v4 owns `--radius-*` and `--container-*`: declare them in `@theme`, not `:root`.
- Component classes go in `@layer components`. Unlayered CSS beats every utility.
- Turbopack serves stale CSS across restarts: `rm -rf .next` before judging a style.
