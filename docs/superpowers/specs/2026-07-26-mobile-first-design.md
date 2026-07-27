# Mobile-First + Accessibility — App-Wide Design

**Date:** 2026-07-26
**Source:** two multi-agent analyses (24 agents) — `/flow` deep-dive (8) + app-wide sweep (16), each synthesized and reality-checked against iPhone SE / low-end Android.

## Owner decisions (locked)
1. **Mobile nav:** bottom tab bar (thumb-reach), top hamburger demoted to a "More" affordance.
2. **/flow on mobile:** Sankey stays the hero — make nodes tappable (≥44px hit rects), gate hover so a tap traces, keep the flow-as-table below. (NOT the answer-first inversion.)
3. **Scope:** Foundation + all per-screen passes.
4. **Extras — all in:** fluid `clamp()` type scale, **light theme**, PWA installable.

## North star
Fix the shared shell **once**; every route inherits it. Today 10 authed pages re-implement the same broken primitives (fixed Navbar + `pt-24` wrapper, `div onClick` cards, hover-only recharts, `prompt()`/`alert()`, sub-44px icon buttons, dead safe-area CSS). Consolidate into an inherited foundation, then give each screen a thin mobile pass. Desktop must not regress — gate every mobile change on `max-width:640px` / `pointer:coarse` / `md:`/`sm:` or preserve existing wide markup.

## Principles
- Fix in the foundation, inherit everywhere. Native platform over library (`<dialog>`, `env(safe-area-inset-*)`, `<details>`, `100dvh`, `next/font`).
- Charts get a **text alternative** (role=img + sr-only table), not a better tooltip — hover is unreliable on touch.
- Real controls, not clickable divs. Delete before you add (redundant Skip buttons, duplicate CTAs the FAB covers).
- Accessibility basics are never the cut corner: names on icon buttons, dialog roles, label/input association, live regions, 44×44 targets, focus-visible.

## Reality-check corrections (baked into the plan)
- **Pointer-type EVENT guard** (`e.pointerType==='mouse'`), never `matchMedia` in a render/initializer path.
- Native `<dialog>`+`showModal()` does **not** lock background scroll on iOS Safari → the shared Sheet must set `body{position:fixed;top:-scrollY}` on open. **P0.**
- recharts mount animations ignore the CSS reduced-motion kill-switch → `isAnimationActive={false}` on every Bar/Line/Area/Pie. **P0 correctness, not P1.**
- Weak-GPU: `content-visibility:auto` (+ `contain-intrinsic-size`) on below-fold charts; analytics mounts 9 `ResponsiveContainer`s.
- `.stacked-table` is over-scoped — the repo has ~2 real `<table>`s (flow, history-ish); use plain `flex-col` + `role=list` stacking, not a "foundation pillar".
- 16px input-zoom fix as an **element base rule** under `@media(pointer:coarse)`, not class-scoped.
- Horizontal scrollers inset from `x=0` (iOS left-edge back-swipe conflict).
- Calendar day cell is **already a `<button>`** (agent miscall) — just reclaim width + add per-day `aria-label`.
- `html{scroll-behavior:auto}` inside `prefers-reduced-motion:reduce`.

## Phases

### P0 — Foundation (build once, inherited)
- **Viewport export** in `layout.tsx`: `width=device-width, initialScale:1, viewportFit:'cover', themeColor:'#14161a'` — keystone; activates the dead safe-area CSS + themes browser chrome. Keep pinch-zoom (no `maximumScale`/`userScalable`).
- **globals.css mobile base:** element-level 16px inputs under `pointer:coarse`; `overscroll-behavior`; `text-size-adjust`; `-webkit-tap-highlight`; reduced-motion also stops `scroll-behavior:smooth`; **fluid `clamp()` type tokens**; **light-theme token layer** (`:root` dark default + `prefers-color-scheme:light` + `[data-theme]` overrides — dark stays default; light tuned in its own pass).
- **Cross-cutting shell** (in `ClientLayout`, no dir moves): skip-to-content link, one polite `aria-live` region, route-change focus reset + page announce via `usePathname`.
- **Bottom tab bar** (`md:hidden`, safe-area padded, lucide icons); demote the top nav on mobile; ensure `main` bottom padding clears it + the FAB.
- **One `<dialog>` Sheet** component (bottom-sheet, focus-trap, Esc, iOS scroll-lock) → migrate AddTransaction / CSVImport / ReceiptScanner / AccountDetail modals.
- **`div onClick` → `<button>`/`<Link>`** for primary cards (dashboard, accounts, payment-methods).
- **Kill the 2 `prompt()`/`alert()` reconcile flows** (flow, accounts) → Sheet + `inputmode=decimal`.
- recharts `isAnimationActive={false}` everywhere + below-fold `content-visibility`.

### P1 — Per-screen passes
Forms baseline (labels+ids, autocomplete, inputmode, MoneyInput) · chart a11y+responsive convention (role=img + sr-only table, thinned axes) · stack/enlarge rows (accounts/history/payment-methods, 44px actions) · history sticky compact filter + `<details>` · **onboarding** (scroll-into-view+autofocus on add-form open, real `<form>`, accessible `<ol>` stepper w/ `aria-current`, drop redundant Skip) · calendar (width + per-day aria-label) · **/flow** (Sankey-hero: 44px transparent node hit rects, pointer-gated hover→tap trace, promoted table) · analytics/cashflow/dashboard/forecast chart reflows.

### P2 — Extras & polish
Light-theme visual tuning + per-screen both-theme verification · PWA (manifest orientation, `next/font` self-host, installable) · landscape/short-viewport chart heights · per-control ergonomics.

## Risks
- Modal→`<dialog>` migration is the largest single change (10+ call sites); partial migration leaves two modal systems.
- Light theme touches every color token and must be verified on every screen (design both themes with equal care).
- Foundation PRs are wide-reaching — land P0 behind manual VoiceOver/TalkBack + iOS Safari landscape smoke before P1.
- Keep desktop pixel-identical: the shared wrapper must reproduce `pt-24`/padding/bg-pattern exactly.

## Sequencing
P0 ships first as a testable shell increment (viewport + globals + shell + bottom nav), then the riskier P0 migrations (Sheet, div→button, prompt/alert), then P1 per-screen, then P2 light-theme tuning + PWA. Device smoke + deploy checkpoint between phases.
