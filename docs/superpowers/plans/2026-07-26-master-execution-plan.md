# Master Execution Plan — Mobile-First → AI Chat + Functions Backend → Capacitor

**Date:** 2026-07-26 · **Repo:** `/Users/bhuvaneswarmarreddy/Desktop/Projects/cashflow-forecast` · **Stack:** Next.js 16 / React 19 / TS / Tailwind 4 / Firebase (Firestore + Hosting) / recharts / jest (248 green)

**Source specs (locked, not re-litigated):**
- `docs/superpowers/specs/2026-07-26-mobile-first-design.md` (Track 1)
- `docs/superpowers/specs/2026-07-26-capacitor-roadmap.md` (Tracks 2–3 + hosting = static export)
- `docs/superpowers/specs/2026-07-25-accounts-redesign-design.md` (existing patterns: anchor+derive, reconcile, dnd-kit)

**Already shipped (do not re-plan):** viewport export, BottomNav, FAB lift, reduced-motion/text-size base, flow accuracy+a11y, /flow month picker + legend + drill-down + plain labels, `isAnimationActive` on /flow.

---

## 0. Program-wide conventions

### 0.1 Verification stack (every phase)
Local dev server is broken in this environment (Turbopack sandbox), so **no localhost dev verification**. The loop is:

1. `npx tsc --noEmit` && `npm test` per commit.
2. `sh scripts/predeploy.sh` per phase (full gate: tsc + jest + react-hooks JSON scan + prod build + boot smoke — `next start` today, static serve after Phase 7).
3. **Preview channel** for anything visual: `npx firebase hosting:channel:deploy <phase-name> --expires 7d` → owner opens the channel URL **on their phone** (and desktop, to confirm pixel-stability) → **explicit owner confirmation** → `npm run deploy` to live. This is the standing rule; no visual change goes live without it.
   - Note: preview channels work with the current `frameworksBackend` config and become trivially fast after the static flip.
4. Phone checks are listed per phase gate below (iPhone Safari + one Android/Chrome pass minimum; VoiceOver/TalkBack where flagged).

### 0.2 Desktop pixel-stability rule (Track 1)
Every mobile change is gated: Tailwind `sm:`/`md:` variants, `@media (max-width:640px)` / `(pointer:coarse)` / `(max-height:480px)`, or pointer-type **event** guards (`e.pointerType === 'mouse'` — never `matchMedia` in render/initializer). The Sheet must render the migrated modals **visually identical on desktop** (reuse `.modal-content` styles inside `<dialog>`; style `::backdrop` to match `.modal-overlay`). Verification: side-by-side desktop screenshot of preview vs prod on each phase.

### 0.3 Commit discipline
Every task below = **one commit**, self-contained, tests green. Phases end in a deployable increment.

### 0.4 Rollback baseline (applies to all phases; per-phase deltas noted)
- Hosting: `git revert` the phase's commits → `npm run deploy`; or one-click release rollback in Firebase console (Hosting → release history) for instant restore while the revert lands.
- Functions (Phase 6+): callables are additive; rollback = redeploy previous `functions/` tag or leave the callable dark (client revert stops calling it).

---

## 1. Decision-point register (owner input, and when it blocks)

| ID | Decision | Options / recommendation | Blocks |
|---|---|---|---|
| **D1** | Orphan routes `/analytics` and `/payment-methods` (zero inbound links today) | (a) link into nav "More" set, (b) delete routes. Rec: link `/analytics` into More; fold `/payment-methods` content into Accounts and delete the route | Phase 3 task T3.2 (nav source) and T3.4 (confirm-delete on payment-methods) |
| **D2** | Currency: honor `profile.currency` (USD/INR) in the shared `money()` or drop the picker and hardcode USD | Rec: honor it — `Intl.NumberFormat` makes it free | Phase 3 task T3.1 |
| **D3** | Post-onboarding home: Dashboard vs Forecast | Rec: Forecast (the "can I spend?" answer) | Phase 4 task T4.4 (onboarding commit) |
| **D4** | Light theme approval | Per-screen preview sign-off during Phase 5 (both themes, every screen) | Phase 5 live deploy |
| **D5** | Chat entry point/surface | Rec: Sheet opened from a Navbar/More chat icon + Settings row; no new bottom tab | Phase 8 task T8.5 (UI wiring; rules+callable tasks proceed regardless) |
| **D6** | App Check: owner creates reCAPTCHA v3 key in Firebase console; approve monitor→enforce flip | One console step + one go/no-go | Phase 6 tasks T6.6/T6.9 |
| **D7** | Native App Check strategy if reCAPTCHA-in-WebView proves flaky | (a) `@capacitor-firebase/app-check` (App Attest / Play Integrity), (b) drop to monitor-mode on native | Phase 10 task T10.6 |
| **D8** | Store inputs: Apple team/cert, rotated upload keystore path+passwords, support contact email, app names | Owner provides; privacy policy page is built in-app (T11.1) | Phase 11 |

None of these block **starting** their phase — each blocks exactly one named task, so sequencing around them is possible.

**Resolved 2026-07-27 (owner):**
- **D1** = link `/analytics` into the nav More set; fold `/payment-methods` content into Accounts and delete that route.
- **D2** = honor `profile.currency` in the shared `money()` (Intl.NumberFormat).
- **D3** = post-onboarding home (and app home destination) = **Forecast**.
- **D5** = chat entry = Navbar icon opening the Sheet + a Settings row for rules management; no new bottom tab.
- D4, D6, D7, D8 remain open (each gates a later phase as tabled).

---

# TRACK 1 — Mobile-first completion

## Phase 1 — P0-A: Sheet primitive, modal migrations, kill prompt/alert (the riskiest single change; do first)

The spec's biggest risk is a partial modal migration leaving two modal systems. This phase lands the primitive and **all four** target migrations in one deployable increment.

| # | Task | Files | Approach | Effort | Depends on |
|---|---|---|---|---|---|
| T1.1 | Remaining P0 globals base | `src/app/globals.css` | Add the not-yet-shipped P0 base: element-level `font-size:16px` on `input/select/textarea` under `@media (pointer:coarse)` (kills iOS focus zoom app-wide), `overscroll-behavior-y: none` on body, `-webkit-tap-highlight-color: transparent`, and a `.below-fold-chart { content-visibility:auto; contain-intrinsic-size: 0 320px }` utility for T2.3. Pure additive CSS under mobile-only media queries — desktop untouched. | S | — |
| T1.2 | `Sheet` component (the one `<dialog>`) | **new** `src/components/Sheet.tsx`, `src/app/globals.css` | Native `<dialog>` + `showModal()` (free focus trap + Esc via `cancel` event + top layer). Props: `open, onClose, title, maxWidth?, children`. iOS body-scroll-lock on open: `body{position:fixed; top:-scrollY; width:100%}`, restore + `scrollTo` on close (native dialog does NOT lock iOS Safari scroll — P0 correctness per spec). Backdrop click closes (`e.target === dialog`). CSS: desktop = current `.modal-content` look centered (pixel-stable); `max-width:640px` = bottom sheet (slide-up, rounded top, safe-area bottom padding); `::backdrop` matches `.modal-overlay`. | M | T1.1 |
| T1.3 | Sheet jest tests | **new** `src/__tests__/sheet.test.tsx` | Component tests: renders children when open, `onClose` fired on cancel/backdrop, body position:fixed applied on open and restored on close (jsdom: assert style mutations; mock `showModal`/`close` since jsdom lacks them). This is the check the primitive leaves behind. | S | T1.2 |
| T1.4 | Migrate `AccountDetailModal` (smallest, proves the pattern) | `src/components/AccountDetailModal.tsx` | Replace the hand-rolled fixed overlay div (lines 80–96) with `<Sheet>`; keep interior markup untouched. Adds `isAnimationActive={false}` to its Bar/Line while in the file (spec P0). | S | T1.2 |
| T1.5 | Migrate `ReceiptScannerModal` | `src/components/ReceiptScannerModal.tsx` | Swap `modal-overlay` wrapper for `<Sheet>`; the `<input capture>` camera path is untouched (it already opens native camera — locked decision to skip @capacitor/camera later). | M | T1.4 |
| T1.6 | Migrate `AddTransactionModal` | `src/components/AddTransactionModal.tsx` | Swap wrapper for `<Sheet>`; preserve the `isOpen/onClose` contract so all 6 call sites (QuickAddFAB, dashboard, calendar, accounts, history, payment-methods) need zero changes. Keep the merchant-suggestion dropdown inside the dialog's top layer (it's absolutely positioned within — verify stacking). | M | T1.4 |
| T1.7 | Migrate `CSVImportModal` (largest, 1029 lines) | `src/components/CSVImportModal.tsx` | Same wrapper swap; the multi-step import flow content is untouched. Verify tall-content scroll inside the sheet on phone (this is the modal most likely to exceed viewport height). | M | T1.6 |
| T1.8 | `ReconcileSheet` — kill both `window.prompt`/`alert` flows | **new** `src/components/ReconcileSheet.tsx`, `src/app/accounts/page.tsx` (~lines 160–170), `src/app/flow/page.tsx` (lines 109–121) | One shared Sheet: account name, `inputMode="decimal"` balance field prefilled with derived current, **live drift preview** ("entered − derived = +$57 → will re-anchor today" — roadmap /flow item 6), confirm button, result announced via the existing polite `aria-live` region instead of `alert()`. Both pages call the same component; `reconcileAccount` context math unchanged (already covered by derive-balance tests). | M | T1.2 |

**Phase 1 verification gate**
- Commands: `sh scripts/predeploy.sh`; `npx firebase hosting:channel:deploy p0-sheet --expires 7d`.
- Phone checks (owner): open each of the 4 migrated modals + ReconcileSheet on iPhone — background does **not** scroll behind the sheet (the iOS lock working is the whole point); Esc/back closes; decimal keyboard appears on reconcile; VoiceOver announces dialog title on open and reconcile result on confirm; desktop screenshots of all four modals match prod pixel-for-pixel.
- Owner confirms → `npm run deploy`.
- **Rollback:** revert T1.4–T1.8 individually (each modal migration is standalone); `Sheet.tsx` can remain dark in the tree.

## Phase 2 — P0-B: real controls, chart perf, fonts, client-side export

All independent of Phase 1 (parallelizable with it, except nothing here touches Sheet).

| # | Task | Files | Approach | Effort | Depends on |
|---|---|---|---|---|---|
| T2.1 | `div onClick` → real controls on primary cards | `src/app/dashboard/page.tsx` (onClick divs at ~308, 322, 387, 399, 682, 786), `src/app/accounts/page.tsx`, `src/app/payment-methods/page.tsx` (~155, 223) | Convert navigation cards to `<Link>` (they call `router.push`) and action cards/expanders to `<button className="w-full text-left">`; preserve exact classes so desktop rendering is unchanged. Gives keyboard/SR access + focus-visible for free. One commit per page. | M | — |
| T2.2 | `isAnimationActive={false}` everywhere remaining | `src/app/cashflow/page.tsx`, `src/app/dashboard/page.tsx`, `src/app/analytics/page.tsx`, `src/components/ForecastChart.tsx`, `src/components/RunwayCalculator.tsx` (AccountDetailModal done in T1.4; /flow already done) | Mechanical: add the prop to every Bar/Line/Area/Pie. recharts JS mount animations ignore the CSS reduced-motion kill-switch — this is P0 correctness per the spec's reality-check. | S | — |
| T2.3 | `content-visibility` on below-fold charts | `src/app/analytics/page.tsx` (9 ResponsiveContainers), `src/app/dashboard/page.tsx`, `src/app/cashflow/page.tsx` | Apply the `.below-fold-chart` utility from T1.1 to chart-card wrappers that start below the first viewport. Weak-GPU phones skip layout/paint for offscreen charts. | S | T1.1 |
| T2.4 | Self-host fonts via `next/font` | `src/app/layout.tsx`, `src/app/globals.css` (line 1 + `@theme inline`) | Delete the Google-Fonts `@import`; add `Outfit` + `Space_Mono` from `next/font/google` in layout.tsx with `variable:` CSS custom properties; point `--font-sans`/`--font-mono` at them. Kills the only remote runtime asset (Capacitor offline/review requirement) and works under `output:'export'` (fonts are inlined at build). | S | — |
| T2.5 | Client-side xlsx export; delete `/api/export` | **new** `src/lib/export-xlsx.ts`, `src/components/ExportButton.tsx`, **delete** `src/app/api/export/route.ts` | Move the workbook builder verbatim from the route into `buildExportWorkbook(data): XLSX.WorkBook` (keep the load-bearing transfer-sign rule and `withDerivedBalances` call); ExportButton does `XLSX.write(wb, {type:'array'})` → `Blob` → anchor click. No secrets, pure compute; first of the three API routes dies here. Native save path swaps in at T10.1 behind the same lib. | M | — |
| T2.6 | Export lib test | **new** `src/__tests__/export-xlsx.test.ts` | Feed a fixture (accounts incl. a debt card, transfers in/out, goals, budgets); assert sheet names, the Summary totals, and that a `transfer` with `transferDirection:'out'` lands negative in Amount (the documented $10,000 bug class). | S | T2.5 |

**Phase 2 verification gate**
- Commands: `sh scripts/predeploy.sh`; preview channel `p0-controls`.
- Phone/desktop checks: fonts render identically (Outfit/Space Mono, all weights used); charts appear instantly with no mount sweep under "Reduce Motion"; every converted card reachable by keyboard Tab on desktop; Export downloads a valid .xlsx opened in Numbers/Excel with identical sheets to a pre-change export.
- Confirm → live deploy.
- **Rollback:** all tasks independently revertible; T2.5 revert restores the route file (still SSR-hosted at this point, so it works again).

## Phase 3 — Global cheap wins

| # | Task | Files | Approach | Effort | Depends on |
|---|---|---|---|---|---|
| T3.1 | Shared `money()` formatter honoring `profile.currency` | **new** `src/lib/money.ts` + adoption in `src/app/{flow,forecast,cashflow,dashboard,accounts,history,calendar,analytics,payment-methods}/page.tsx`, `src/components/{Navbar,ForecastChart,ForecastTimeline,AccountDetailModal,...}.tsx` | `formatMoney(n, currency)` via `Intl.NumberFormat` (+ `formatMoneyCents`). Replace the ~20 ad-hoc `$${x.toLocaleString()}` / local `money()` helpers; call sites pass `profile?.currency ?? 'USD'`. Adopt incrementally — one commit per page-group; the two cents-based helpers (flow, AccountDetailModal) route through `formatMoneyCents`. | M | **D2** |
| T3.2 | Single nav source | **new** `src/lib/nav.ts`, `src/components/Navbar.tsx`, `src/components/BottomNav.tsx` | One `NAV_ITEMS` array (href/label/icon/`tab:boolean`); Navbar renders all, BottomNav filters `tab`. Per **D1**: either add `/analytics` (+ `/calendar`, currently also nav-orphaned from primary nav) to the Navbar/More set, or delete `src/app/payment-methods/` and `src/app/analytics/` outright. Deleting routes is its own commit with owner sign-off. | S–M | **D1** |
| T3.3 | Confirm-before-delete: calendar | `src/app/calendar/page.tsx` (line ~330) | Wrap `deleteTransaction(txn.id)` in `window.confirm` — matches the existing two-leg-delete confirm pattern at `history/page.tsx:302` (native confirm is acceptable for destructive guards; the prompt/alert kill was reconcile-specific). One line. | S | — |
| T3.4 | Confirm-before-delete: payment-methods | `src/app/payment-methods/page.tsx` (line ~305) | Same one-line guard — or moot if D1 deletes the route. | S | **D1** |
| T3.5 | Loading/empty states: cashflow + analytics | `src/app/cashflow/page.tsx`, `src/app/analytics/page.tsx` | Gate render on `TransactionContext.isLoading` (both pages flash $0 today): spinner while loading, empty state with an "Import CSV" CTA when `transactions.length === 0`. Copy the pattern the dashboard already uses. | S | — |

**Phase 3 verification gate**: `sh scripts/predeploy.sh`; preview `global-wins`; phone check: INR profile shows ₹ everywhere (if D2=honor), bottom tabs + Navbar agree, analytics reachable (if D1=link), deleting from calendar asks first, cashflow no longer flashes $0 on cold load. Confirm → live. **Rollback:** all independent one-commit reverts.

## Phase 4 — P1 per-screen passes

Each task = one commit; all depend on Phase 1–2 foundations; all mobile changes breakpoint/pointer-gated.

| # | Task | Files | Approach | Effort | Depends on |
|---|---|---|---|---|---|
| T4.1 | Forms baseline | `src/components/AddTransactionModal.tsx`, `src/app/accounts/page.tsx` (inline account/income forms), `src/app/settings/page.tsx`, `src/app/{login,signup,forgot-password}/page.tsx` | Label↔input `htmlFor`/`id` association, `autocomplete` (email/name/new-password), `inputMode="decimal"` on every amount field, `enterKeyHint`. No layout change. | M | T1.6 |
| T4.2 | Chart a11y convention (role=img + sr-only table) | **new** `src/components/ChartSrTable.tsx`; apply in `src/components/ForecastChart.tsx`, `src/app/cashflow/page.tsx`, `src/app/analytics/page.tsx`, `src/app/dashboard/page.tsx`, `src/components/AccountDetailModal.tsx` | Tiny helper: `<ChartSrTable caption columns rows/>` rendering an sr-only `<table>`; chart wrapper gets `role="img"` + `aria-label` summary. Charts get a text alternative, not a better tooltip — hover is unreliable on touch. One commit per screen. | M | — |
| T4.3 | Stack/enlarge rows | `src/app/accounts/page.tsx`, `src/app/history/page.tsx`, `src/app/payment-methods/page.tsx` (if kept) | Under `sm:` rows become `flex-col` + `role="list"` (per spec correction: NOT a generic `.stacked-table` pillar); icon actions get `min-w-11 min-h-11` (44px) + `aria-label`. Desktop markup preserved via responsive classes. One commit per screen. | M | T2.1 |
| T4.4 | Onboarding wizard fixes | `src/app/onboarding/page.tsx` | Add-form opens with `scrollIntoView` + autofocus; wrap steps in a real `<form onSubmit>`; stepper becomes an accessible `<ol>` with `aria-current="step"`; drop the redundant Skip buttons. Set the post-completion redirect per **D3**. | M | **D3** |
| T4.5 | Calendar pass | `src/app/calendar/page.tsx` | Day cell is already a `<button>` (spec's agent-miscall correction) — reclaim horizontal width on ≤640px (drop the aspect-ratio lock, shrink padding) and add per-day `aria-label` ("July 14, 2 transactions, net −$120"). | S | — |
| T4.6 | History filters | `src/app/history/page.tsx` | On mobile, collapse the filter block into a sticky compact bar + native `<details>` "Filters (N active)"; desktop layout untouched. | M | — |
| T4.7 | /flow Sankey-hero touch fixes | `src/app/flow/page.tsx` (`renderNode`, lines ~303–340) | Inside the node `<g>`, add a transparent hit `<rect>` expanded to ≥44px (`y − (44−height)/2`, `height ≥ 44`, width + label zone) so taps land; replace `onMouseEnter/Leave` with `onPointerEnter/Leave` gated on `e.pointerType === 'mouse'` (EVENT guard — tap goes straight to pin/trace, no ghost-hover). Keep focus/keyboard handlers as-is. | M | — |
| T4.8 | Chart reflows: dashboard/forecast/cashflow/analytics | same pages + `src/components/ForecastChart.tsx` | Under `sm:`: reduce chart heights, thin axis ticks (`interval`, smaller `fontSize`, `tickFormatter` $1.2k), trim margins; horizontal scrollers inset from x=0 (iOS back-swipe). One commit per screen. | S each | T2.2 |

**Phase 4 verification gate**
- Commands: `sh scripts/predeploy.sh`; preview `p1-screens`.
- Phone checks: Sankey nodes trace on first tap (no double-tap hover ghost); every row action hittable with a thumb; onboarding form autofocuses and submits from the keyboard's Go; VoiceOver reads a data table for the forecast chart; history filters collapse; desktop diff = pixel-stable.
- Confirm → live. **Rollback:** per-screen commits revert independently.

## Phase 5 — P2: fluid type, light theme, PWA, landscape

| # | Task | Files | Approach | Effort | Depends on |
|---|---|---|---|---|---|
| T5.1 | Fluid `clamp()` type scale | `src/app/globals.css` | Token vars (`--text-h1: clamp(1.6rem, 4vw+1rem, 2.25rem)` etc.) applied to h1/h2/h3/body; delete the `!important` mobile heading overrides (lines 666–676). Visual → preview. | S | — |
| T5.2 | Light-theme token layer | `src/app/globals.css`, `src/app/layout.tsx` (or ClientLayout for `data-theme`) | Keep `:root` dark default; add `@media (prefers-color-scheme: light)` + `[data-theme="light"]`/`[data-theme="dark"]` override blocks redefining every token (backgrounds, foregrounds, borders, shadows, glass-card rgba, bg-pattern alphas) + `color-scheme: light` (replaces the hardcoded `color-scheme: dark` input rule). Also fix hardcoded `#16181c` text-on-gold and chart hexes to tokens where they'd break in light. | L | — |
| T5.3 | Light-theme per-screen tuning | every `src/app/*/page.tsx` visual + panels | Screen-by-screen sweep in light mode; adjust the handful of hardcoded colors per screen (recharts fills, treemap strokes, badges). One commit per screen, previewed per **D4** with both themes. Add a minimal Auto/Dark/Light toggle in Settings persisted to `localStorage` (no profile schema change). | L | T5.2 |
| T5.4 | PWA installability + manifest fix | `public/manifest.json`, `public/logos/*` | Fix `theme_color` `#b08d3f` → `#14161a` (matches the viewport export); regenerate 512/1024 icons **alpha-flattened** (also required by App Store later — do once here, reuse in T10.5); verify maskable purpose icons; no service worker (offline-web not promised — locked). Lighthouse installability check on the preview channel. | S–M | — |
| T5.5 | Landscape / short-viewport | `src/app/globals.css` + chart pages | `@media (max-height: 480px)`: cap chart heights (~220px), reduce vertical paddings so charts + axis fit without scroll-trap. | S | T4.8 |

**Phase 5 verification gate**
- Commands: `sh scripts/predeploy.sh`; preview `p2-polish`; Lighthouse (installability + a11y ≥ 95) against the channel URL.
- Phone checks: install to home screen (Android + iOS Add-to-Home), status-bar/browser chrome color correct, light mode on every screen (D4 sign-off screen-by-screen), landscape charts usable, pinch-zoom still works.
- Confirm → live. **Track 1 done.**
- **Rollback:** T5.2/T5.3 are the wide ones — the `[data-theme]` layer is additive; reverting tuning commits leaves dark default intact.

---

# TRACK 2 — Functions backend + static flip + AI data-mapping chat

## Phase 6 — Stand up the Functions backend (net-new infra), port both AI routes

| # | Task | Files | Approach | Effort | Depends on |
|---|---|---|---|---|---|
| T6.1 | Scaffold `functions/` (2nd-gen, TS) | **new** `functions/package.json` (node 20, `firebase-functions` v6, `firebase-admin`, `openai`), `functions/tsconfig.json`, `functions/src/index.ts`, `functions/.gitignore`; `firebase.json` (add `functions` block with `predeploy: tsc` build) | Net-new infra (repo has no functions dir — sized accordingly). `initializeApp()` once in index; export nothing yet; `firebase deploy --only functions` succeeds empty. Blaze already active (frameworksBackend uses it). | M | — |
| T6.2 | Move prompts server-side | **new** `functions/src/ai-config.ts` (copy of `src/lib/ai-config.ts`) | `src/lib/ai-config.ts` is imported **only** by the API route (verified) — prompts belong server-side; the client copy dies with the routes in T6.8. | S | T6.1 |
| T6.3 | Per-uid rate limiter | **new** `functions/src/rate-limit.ts`, **new** `functions/src/__tests__/rate-limit.test.ts`, `functions/jest.config.js` | Fixed-window Firestore transaction on `rateLimits/{uid}` (`{day, counts:{fn:n}}`); throw `resource-exhausted` over limit (aiDecision 50/day, parseReceipt 60/day, aiChat 100/day). Auth alone does NOT close quota abuse — signup is free & unverified (roadmap correction). Top-level `rateLimits` collection is client-inaccessible under default-deny rules; admin SDK bypasses rules — **no firestore.rules change needed**. Standalone ts-jest config in `functions/`; wire `cd functions && npm test` into predeploy gate 2. | S | T6.1 |
| T6.4 | `aiDecision` callable + **emergency_fund fix** | **new** `functions/src/ai.ts` (+ pure `functions/src/prompts.ts`), `functions/src/index.ts` | Port the route's type router (`decision_check` / `question` / `comprehensive` / `insights`) as a pure prompt-builder + `onCall({secrets:['OPENAI_API_KEY'], enforceAppCheck:false initially})` with `request.auth` guard + limiter. **Add the missing `emergency_fund` branch** (EmergencyFundPanel.tsx:115 sends it; the route 400s it today — that panel's AI is silently dead): a short prompt over the fund context. Unit-test the builder covering all five types. Secrets: `firebase functions:secrets:set OPENAI_API_KEY`. | M | T6.2, T6.3 |
| T6.5 | `parseReceipt` callable | **new** `functions/src/receipt.ts`, `functions/src/index.ts` | Port the Azure-primary/OpenAI-fallback vision call; input `{imageBase64, mimeType}` (callable payloads cap at 10MB — see T6.7 downscale). Secrets: `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, `AZURE_OPENAI_DEPLOYMENT`. Same auth + limiter. | M | T6.3 |
| T6.6 | App Check client registration | `src/lib/firebase.ts` | `initializeAppCheck(app, {provider: new ReCaptchaV3Provider(SITE_KEY), isTokenAutoRefreshEnabled: true})`; `FIREBASE_APPCHECK_DEBUG_TOKEN` for local/jest. Owner console step = **D6**. Deploy in **monitor mode first** (callables `enforceAppCheck:false`, watch the App Check metrics), flip to `true` after a clean week or after preview verification. | S | **D6** |
| T6.7 | Client swap to callables + image downscale | **new** `src/lib/callables.ts`; `src/components/{DecisionCheckPanel,AIInsightsPanel,AIQuestionPanel,EmergencyFundPanel,ReceiptScannerModal}.tsx` | `httpsCallable` wrappers replacing the five `fetch('/api/...')` sites (verified list); ReceiptScannerModal gains a canvas downscale (max edge 1600px, JPEG q0.8) before base64 — keeps under the 10MB callable cap and cuts vision cost. Error mapping preserves the existing graceful-fallback copy. | M | T6.4, T6.5 |
| T6.8 | Delete the two remaining routes + client prompt file | **delete** `src/app/api/ai/decision/route.ts`, `src/app/api/parse-receipt/route.ts`, `src/lib/ai-config.ts` | Only after T6.7 is verified in production (dual-run window: callables live, routes still present as instant rollback). After this commit `src/app/api/` is empty — precondition for Phase 7. | S | T6.7 verified live |
| T6.9 | Enforce App Check | `functions/src/{ai,receipt}.ts` | Flip `enforceAppCheck: true` once monitor metrics show verified traffic (D6 go/no-go). | S | T6.6 + monitoring window |

**Phase 6 verification gate**
- Commands: `sh scripts/predeploy.sh` (unchanged gate — still SSR at this point) + `cd functions && npm test` + `firebase deploy --only functions`; preview channel `callables`.
- Phone/desktop checks: Decision Check, AI Question, AI Insights, **Emergency Fund panel now answers** (was dead), receipt scan round-trips a photo; a signed-out fetch to the callable URL is rejected; hammering aiDecision 51× returns the rate-limit message.
- Not a visual change (except none) — but deploy sequence is functions → hosting.
- **Rollback:** client revert of T6.7 restores route usage (routes still deployed until T6.8); functions are additive.

## Phase 7 — Flip to static export (one-way door for hosting; callables make it safe)

| # | Task | Files | Approach | Effort | Depends on |
|---|---|---|---|---|---|
| T7.1 | `output:'export'` | `next.config.ts` | `{output:'export', trailingSlash:true, images:{unoptimized:true}}`. All 15 pages are `"use client"` with zero SSR features (roadmap-verified), so the build succeeds iff T6.8 removed the last routes. | S | T6.8 |
| T7.2 | Hosting rewire | `firebase.json` | Hosting: `"public":"out"`, drop `"source"`/`"frameworksBackend"`, keep functions block, add SPA fallback `"rewrites":[{"source":"**","destination":"/index.html"}]` (each route has its own `out/<route>/index.html`; the rewrite only catches unknown deep links, which 404 otherwise). Add `emulators.hosting.port: 3000` for the gate. Post-deploy cleanup: delete the orphaned frameworks SSR function from the console. | S | T7.1 |
| T7.3 | Predeploy gate swap (and keep the export build forever) | `scripts/predeploy.sh` | Gate 4 becomes: `npm run build` (now produces `out/`) → `npx firebase emulators:start --only hosting` in background → curl `/`, `/login/`, `/accounts/`, `/flow/`, `/forecast/`, `/history/`, `/cashflow/` expecting 200 → kill. This exercises the **real** firebase.json rewrites, not a generic static server. Add gate 5: `grep -rn "fetch('/api" src` must return nothing (dead-API tripwire). Export-breaking regressions (a future route.ts, an SSR API) now fail the gate immediately. | M | T7.2 |

**Phase 7 verification gate**
- Commands: `sh scripts/predeploy.sh` (new gates); `npx firebase hosting:channel:deploy static-flip --expires 7d`.
- Phone checks: hard-refresh on `/flow` deep link (no 404), login → data loads, AI panels + receipt scan still work (callables), export downloads, airplane-mode after first load still renders cached data (Firestore persistence).
- Confirm → live deploy (`firebase deploy --only hosting`).
- **Rollback:** revert T7.1–T7.3 → SSR hosting builds again with zero API routes (callables keep serving) — the flip itself is fully reversible even though the *architecture* decision is one-way for SSR features.

## Phase 8 — AI data-mapping chat (NEW feature)

User defines/changes records, analysis, and data-mapping rules in natural language. AI returns a **structured action**; the client previews it; nothing mutates without explicit confirm. Rides the exact rails Phase 6 built.

| # | Task | Files | Approach | Effort | Depends on |
|---|---|---|---|---|---|
| T8.1 | Mapping-rules engine | **new** `src/lib/mapping-rules.ts`, **new** `src/__tests__/mapping-rules.test.ts` | `MappingRule = {id, match:{field:'merchant'\|'title', contains:string}, set:{category?, type?, merchant?}, createdAt}`; `applyMappingRules(txn, rules)` runs **before** `classifyTransaction` (user override beats heuristics — same "one classifier" discipline as `classify.ts`, whose rule order is load-bearing and untouched). Tests: precedence over classify, case-insensitivity, first-match-wins, no-match passthrough. | M | — |
| T8.2 | Rules storage + wiring | `firestore.rules` (add `users/{uid}/rules/{ruleId}` owner-only match), `src/context/TransactionContext.tsx` (or a small `useMappingRules` hook), `src/components/CSVImportModal.tsx` (preview applies rules) | Own subcollection, NOT `profile.settings` — `syncFromFirestore` rebuilds settings from a hardcoded whitelist and would drop it (the exact trap the accounts spec documented for `accountOrder`). Apply rules once at transaction load + in CSV import preview. Deploy rules: `firebase deploy --only firestore:rules`. | M | T8.1 |
| T8.3 | `aiChat` callable | **new** `functions/src/chat.ts` + prompt in `functions/src/ai-config.ts`, `functions/src/index.ts` | Input: `{message, history[], context}` where context is compact (account names/types, category list, top merchants, N recent txn samples — no full ledger). System prompt demands strict JSON: `{action:'create_rule'\|'edit_transactions'\|'add_transaction'\|'answer', ...fields, explanation}` at temperature 0. Reuses secrets/auth/App Check/limiter from Phase 6. Pure response-parser unit-tested in functions. | M | T6.4 |
| T8.4 | Action validator + executor | **new** `src/lib/chat-actions.ts`, **new** `src/__tests__/chat-actions.test.ts` | `parseChatAction(json)` — strict client-side validation (unknown kinds/fields rejected; server output is untrusted input; never simplified away). `describeAction(action, transactions)` computes the preview ("Rule: merchant contains 'AMZN' → Shopping. Matches 37 existing transactions."). Executors call existing mutators only: `addRule`, `updateTransaction`, `addTransaction` — the AI never writes directly. | M | T8.1 |
| T8.5 | Chat UI | **new** `src/components/DataChatSheet.tsx`; entry wiring in `src/components/Navbar.tsx` + `src/app/settings/page.tsx` (per **D5**) | Sheet-based chat (reuses T1.2): message list, input with `enterKeyHint="send"`, streaming not required (short answers); each actionable reply renders a preview card with Confirm/Cancel; confirms execute T8.4 and append a receipt message; `aria-live` on replies. Rules management list (view/delete existing rules) lives in Settings. | L | T1.2, T8.3, T8.4, **D5** |

**Phase 8 verification gate**
- Commands: `sh scripts/predeploy.sh` + functions tests + `firebase deploy --only functions,firestore:rules`; preview `ai-chat`.
- Phone checks: "put everything from AMZN under shopping" → preview shows match count → confirm → history reflects it and the rule survives reload + a CSV re-import; "how much did I spend on food in June" answers from context; malformed/refused model output shows a graceful "couldn't turn that into an action" message, never a mutation.
- Confirm → live. **Rollback:** feature is additive end-to-end — revert T8.5 hides it; rules collection is inert without the engine.

---

# TRACK 3 — Capacitor packaging

## Phase 9 — Native scaffold

| # | Task | Files | Approach | Effort | Depends on |
|---|---|---|---|---|---|
| T9.1 | `cap init` + platforms | **new** `capacitor.config.ts` (`appId:'app.marreddy.cashflow'`, `webDir:'out'`, **no `server.url`**), **new** `ios/`, `android/` dirs, `package.json` (`@capacitor/core`, `@capacitor/cli`, `@capacitor/ios`, `@capacitor/android`), `.gitignore` | `npx cap add ios && npx cap add android`; commit both platform dirs. `webDir:'out'` = the same static bundle web ships — the 100% goal. Add npm script `"cap:sync": "npm run build && npx cap sync"`. | M | Phase 7 |
| T9.2 | Core plugins + platform lib | `capacitor.config.ts`, **new** `src/lib/platform.ts`, `src/app/layout.tsx` or `ClientLayout.tsx` (init hook) | `@capacitor/status-bar` (bg `#14161a`, light content), `@capacitor/splash-screen` (bg `#14161a`), `@capacitor/app` (Android back: `history.back()` else minimize), `@capacitor/keyboard` (resize `native`). `platform.ts` exports `isNative = Capacitor.isNativePlatform()` — the one gate every native fork uses. | M | T9.1 |

**Phase 9 verification gate**
- Commands: `sh scripts/predeploy.sh` → `npm run cap:sync` → `npx cap run ios` (simulator + owner's iPhone via Xcode) and `npx cap run android`.
- Phone checks: app boots to login, status bar/splash correct, all screens navigate, Firestore data loads and survives airplane mode, back button behaves on Android, keyboard doesn't cover inputs (bottom sheet + safe areas already handled by Track 1).
- No web deploy in this phase (zero web-visible change). **Rollback:** platform dirs are inert additions.

## Phase 10 — Native features (the "not-a-thin-wrapper" payload for Apple 4.2)

| # | Task | Files | Approach | Effort | Depends on |
|---|---|---|---|---|---|
| T10.1 | Native save/share for export + CSV template | `src/components/ExportButton.tsx`, `src/components/CSVImportModal.tsx` (template anchor at ~690), `package.json` (`@capacitor/filesystem`, `@capacitor/share`) | Anchor `.click()` is a WebView no-op: when `isNative`, write base64 to `Directory.Cache` via Filesystem then `Share.share({url})` (xlsx from T2.5's lib; CSV template string same path). Web path unchanged. **Skip @capacitor/camera** — `<input capture>` already opens the native camera (locked). | M | T9.2, T2.5 |
| T10.2 | Hide Google auth on native | `src/app/login/page.tsx`, `src/app/signup/page.tsx` | `{!isNative && <GoogleButton/>}` — email/password/reset are WebView-safe and sidestep the Apple 4.8 Sign-in-with-Apple obligation (locked: email-only v1). | S | T9.2 |
| T10.3 | Local notifications from reminders | **new** `src/lib/notifications.ts`, **new** `src/__tests__/notifications.test.ts`, `src/app/settings/page.tsx` (toggle), ClientLayout (resume hook), `package.json` (`@capacitor/local-notifications`) | Pure mapper `remindersToNotifications(getAllUpcomingReminders(...))` → deterministic int ids (hash of reminder id+date) — unit-tested; runtime: request permission from a Settings toggle, cancel-all + reschedule on app resume and after data mutations (debounced). Turns the display-only reminders panel into the native payoff; primary 4.2 de-risk. | M–L | T9.2 |
| T10.4 | In-app account deletion (Apple 5.1.1(v) — guaranteed rejection without it) | **new** `functions/src/delete-account.ts`, `functions/src/index.ts`, `src/app/settings/page.tsx`, `src/lib/callables.ts` | Callable: verify `request.auth`, `getFirestore().recursiveDelete(users/{uid})` (client SDK can't delete subcollections), then `admin.auth().deleteUser(uid)`. Client flow: type-DELETE confirm → reauthenticate (password) → call → clear local storage → signed-out landing. Ship on **web too** (good hygiene + Play parity). Can be built any time after T6.1 — parallelizable. | M | T6.1 |
| T10.5 | Icons/splash via `@capacitor/assets` | **new** `assets/icon-1024.png` (opaque — App Store refuses alpha at upload), `assets/splash.png`, generated ios/android resources, `package.json` (dev dep) | Reuse the alpha-flattened art from T5.4; `npx capacitor-assets generate`. Manifest `theme_color` already fixed in T5.4. | S | T9.1, T5.4 |
| T10.6 | Native App Check | `src/lib/firebase.ts`, `package.json` (`@capacitor-firebase/app-check`), ios/android config | reCAPTCHA v3 inside a WebView is unreliable: first **test** T6.9 enforcement from the device build; if callables are blocked, install `@capacitor-firebase/app-check` (App Attest / Play Integrity) behind `isNative`, else per **D7** drop native to monitor-mode temporarily. | M | T6.9, T9.2, **D7** |

**Phase 10 verification gate**
- Commands: `sh scripts/predeploy.sh` → `npm run cap:sync` → device installs (both platforms).
- Phone checks: export shares a real .xlsx to Files/Drive; CSV template saves; Google button absent on native, present on web; a reminder due tomorrow fires a local notification (set device clock forward); delete-account nukes data + auth (verify in console) on a throwaway account; AI + receipt callables pass App Check from the device.
- Web-facing bits (T10.2 gating, T10.4 settings row) go through a preview channel + confirmation like any visual change.
- **Rollback:** each task独立 revertible; account-deletion callable is additive.

## Phase 11 — Store compliance + submission

| # | Task | Files / venue | Approach | Effort | Depends on |
|---|---|---|---|---|---|
| T11.1 | Privacy policy + support pages (served by the app itself) | **new** `src/app/privacy/page.tsx`, **new** `src/app/support/page.tsx` | Static pages (export-safe) covering: data stored (Firestore, per-user), processors (**OpenAI + Azure OpenAI** for AI text and receipt images), no sale of data, deletion path (in-app, T10.4). URLs go in both store listings. | S | Phase 7 |
| T11.2 | iOS submission pack | Xcode project, App Store Connect | Signing with owner's Apple team (**D8**); `PrivacyInfo.xcprivacy` privacy manifest (required-reason APIs: UserDefaults etc.); App Privacy questionnaire disclosing financial data + images shared with OpenAI/Azure; screenshots; TestFlight build first; review notes pre-empting 4.2 by listing native features (notifications, offline data, share, deletion) and demo account. | M–L | Phase 10, **D8** |
| T11.3 | Android submission pack | Play Console, `android/` signing config | Sign AAB with the **already-rotated upload keystore** (D8 supplies path/passwords — never committed); Data Safety form (same disclosures); **Play financial-features declaration** (personal finance management, not lending); internal testing track first. | M | Phase 10, **D8** |
| T11.4 | Pre-submission checklist run | `docs/superpowers/specs/` (checklist doc) | One doc: both stores' checklists (icons opaque, deletion visible, privacy URLs live, App Check enforced, permissions minimal — notifications + camera-via-input only), walked and checked before each submit. | S | T11.2, T11.3 |

**Phase 11 gate:** TestFlight + Play internal installs verified by owner on real devices → submit. **Rollback:** n/a (store process); app updates are forward-only, hosting/web unaffected.

---

## Critical path & parallelization

```
T1.1 → T1.2 → T1.4..T1.7 → T1.8 ─┐
                                  ├→ Phase 4 (T4.*) → Phase 5 (T5.2→T5.3 is the long pole)
Phase 2, Phase 3 (parallel lane) ─┘
Phase 6 (T6.1→T6.4/T6.5→T6.7→T6.8) → Phase 7 (T7.1→T7.2→T7.3) → Phase 8 (T8.5 last)
Phase 7 → Phase 9 → Phase 10 → Phase 11
```

- **Critical path:** Sheet (T1.2) → modal migrations → P1 → light theme (T5.2/T5.3) ‖ then Functions (T6.1→T6.7→T6.8) → static flip (Phase 7) → Capacitor (9→10→11). The flip is the program's hinge: everything native waits on it; nothing in Track 1 does.
- **Parallel lanes:** Phase 2 + Phase 3 tasks are independent of the Sheet (run alongside Phase 1). T6.1–T6.5 (pure `functions/` work, zero UI files) can start during Phase 4/5 without violating the locked track order of *shipping*. T10.4's callable can be written any time after T6.1. T5.4's flattened icons feed T10.5.
- **Serialize:** T6.8 (route deletion) strictly after T6.7 is verified **live**; T7.1 strictly after T6.8; light-theme tuning (T5.3) after all P1 screen passes (or you tune screens that then change).

## Test strategy & deploy-gate evolution

**New jest tests by phase** (baseline 248 stays green throughout):
- P1: `sheet.test.tsx` (open/close/scroll-lock) — the reconcile math is already covered by `derive-balance.test.ts`.
- P2: `export-xlsx.test.ts` (sheet structure + transfer-sign rule).
- P3: `money.test.ts` (USD/INR, cents helper); nav source is exercised by existing component renders.
- P4: extend flow tests only if `renderNode` logic moves (hit-rect is markup; keep tests keyed on ids/verdicts per the drill-down convention).
- P6: `functions/src/__tests__/`: rate-limit window math; prompt-builder covering **all five** types incl. `emergency_fund` (the regression that was silently dead).
- P8: `mapping-rules.test.ts` (precedence over `classifyTransaction`, first-match, passthrough); `chat-actions.test.ts` (validator rejects unknown kinds; preview counts).
- P10: `notifications.test.ts` (reminder→schedule mapping, deterministic ids).

**Deploy gate stages** (`scripts/predeploy.sh`):
- **Stage A (now → Phase 6):** tsc · jest (+ `cd functions && npm test` from T6.3) · react-hooks JSON scan · `next build` + `next start` smoke.
- **Stage B (Phase 7 onward, permanent):** tsc · jest (root + functions) · hooks scan · `next build` **(export — regressions that break static export fail here forever)** · `firebase emulators:start --only hosting` smoke of `/ /login/ /accounts/ /flow/ /forecast/ /history/ /cashflow/` (validates the real rewrites) · gate 5 `grep fetch('/api` tripwire.
- **Stage C (Phase 9 onward, release builds):** Stage B + `npx cap sync` succeeds (drift between web build and native shells caught before store builds).

## Risk register (top 6)

1. **Two modal systems** if migration stalls mid-Phase-1 → all four migrations land inside one phase; other `modal-overlay` users (calendar day sheet, accounts inline forms, SavingsGoalsPanel) migrate opportunistically in their Phase-4 screen commits.
2. **iOS scroll-lock regressions** (`<dialog>` doesn't lock iOS) → body-fixation is inside Sheet, unit-tested, and phase-gated on a real-iPhone check.
3. **Callable payload cap (10MB)** kills large receipt photos → client canvas downscale in T6.7.
4. **App Check in WebView** blocks native AI → staged monitor→enforce (T6.6/T6.9) + explicit native test before enforcement matters (T10.6, D7 fallback).
5. **Light theme regressions** across hardcoded hexes → token layer first (additive), per-screen tuning commits with per-screen preview sign-off (D4).
6. **Export flip surprises** → the flip is only 3 small commits after routes are gone, gate rehearses the exact hosting config via the emulator, and revert restores SSR hosting harmlessly.

---

### Critical Files for Implementation
- /Users/bhuvaneswarmarreddy/Desktop/Projects/cashflow-forecast/src/components/Sheet.tsx (new — the P0 primitive every modal, reconcile flow, and the chat UI build on)
- /Users/bhuvaneswarmarreddy/Desktop/Projects/cashflow-forecast/src/app/globals.css (mobile base, fluid type, light-theme token layer, sheet/bottom-sheet styles)
- /Users/bhuvaneswarmarreddy/Desktop/Projects/cashflow-forecast/functions/src/index.ts (new — aiDecision, parseReceipt, aiChat, deleteAccount callables; the entire Track-2 backend)
- /Users/bhuvaneswarmarreddy/Desktop/Projects/cashflow-forecast/scripts/predeploy.sh (the gate that evolves at the static flip and guards every deploy)
- /Users/bhuvaneswarmarreddy/Desktop/Projects/cashflow-forecast/firebase.json (hosting rewire to static `out/` + functions block — the program's hinge commit)