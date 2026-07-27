# Road to 100% Capacitor + /flow improvements

**Date:** 2026-07-26 · **Source:** 20-agent analysis (6 Capacitor lenses + 10 per-screen + /flow + journey), synthesized + reality-checked.

## Verdict
Literal 100% is achievable — **one static bundle running identically on desktop web, mobile web, and native iOS/Android** — because the app is already an SPA in everything but its build config: all 15 pages are `"use client"`, zero SSR features (no `headers/cookies`, `generateMetadata`, dynamic segments, Server Actions, middleware, `next/image`), all data is client-side Firebase, and Firestore offline persistence is **already on**. Honest caveats: (1) `output:'export'` drops SSR/SEO — moot here, but a one-way door for web; (2) AI/OCR hold secret keys → must live in remote callables → **online-only** in native (degrade gracefully); (3) Apple 4.2 thin-wrapper risk (owner already hit a 2.1/5 on AntarChit) → mitigated by shipping real native features (local notifications, camera, offline data, file share). "100%" = ships & passes review with AI/OCR as online enhancements, **not** 100% offline.

## Hosting decision: static-export SPA (Path a)
Set `output:'export'` + `images.unoptimized` + `trailingSlash`. NOT Capacitor `server.url` (forfeits offline, pays SSR per nav, invites 4.2 rejection). The only blockers are the 3 API routes; all 3 have clean migrations.

## Road to 100% (with reality-check corrections folded in)
**Backend-free quick wins (pull into mobile-first / anytime):**
1. Self-host fonts — replace the `globals.css:1` Google-Fonts `@import` with `next/font` (kills the only remote runtime asset; offline + review requirement).
2. Delete `/api/export`; build the xlsx client-side (`XLSX.write type:'array'` → Blob). No secrets, pure compute.

**Stand up the backend, then flip (do EARLY — critique: flip export at top of Track 2, not late):**
3. Scaffold `functions/` (2nd-gen `onCall`, TS) — the repo has **no** functions dir/block today, so this is net-new infra (size **M–L**, not M). Port `/api/ai/decision` + `/api/parse-receipt` to callables; secrets in Secrets Manager; **require auth + Firebase App Check + per-uid rate-limit** (auth alone does NOT close quota abuse — signup is free & unverified). Fix the `emergency_fund` type (that panel's AI is silently dead today).
4. Delete all 3 route.ts, flip `output:'export'`, add `next build` (export) to the predeploy gate so export-breaking regressions fail immediately.
5. Rewire `firebase.json`: serve static `out/`, drop `frameworksBackend`, add SPA rewrites/404 (web refreshes 404 otherwise — native unaffected), swap predeploy gate-4 `next start`→static serve. Blaze stays for callables only.

**Native scaffolding + plugins (Track 3):**
6. `cap init` (appId `app.marreddy.cashflow`, `webDir:'out'`, no `server.url`) + ios/android; StatusBar/SplashScreen (#14161a), App back-button, Keyboard.
7. Native **save/share** (`@capacitor/filesystem`+`share`) for export/CSV-template (anchor `.click()` is a WebView no-op). **Skip `@capacitor/camera`** — the receipt scanner already uses `<input capture>` which opens the native camera in both WebViews; only the save side is broken.
8. Native auth: **hide Google on native, ship email/password/reset** (all WebView-safe; sidesteps Apple 4.8 Sign-in-with-Apple obligation). Google/Apple parity later only if wanted.
9. Local notifications for reminders (`@capacitor/local-notifications`) — turns the display-only reminders panel into the native payoff; de-risks 4.2.
10. **In-app account deletion** (Apple 5.1.1(v), guaranteed rejection without it) — as an Admin-SDK `recursiveDelete` **callable** (client SDK can't delete subcollections); client does reauth + `deleteUser` + local clear.
11. Icons/splash — flatten alpha on 512/1024 (App Store refuses alpha at upload); `@capacitor/assets`; set manifest `theme_color` #14161a (currently mismatched #b08d3f).
12. Store compliance — privacy policy + support URL, App Privacy / Play Data Safety (disclose OpenAI/Azure sharing), Play financial-features declaration, sign AAB with the **already-rotated** upload keystore, pre-submission checklist.

## Three-track sequence (minimal rework)
- **Track 1 — mobile-first (NOW):** the responsive/a11y rebuild. Fold in cheap global wins (shared `money()` formatter, single nav source, Loader/EmptyState, terminology) + the two backend-free Capacitor quick-wins (fonts, delete export route).
- **Track 2 — AI data-mapping chat (NEXT):** the natural home for the callable/Secrets/App Check infra — the data-mapping chat is one more callable on the same rails as aiDecision/parseReceipt/account-deletion. Flip `output:'export'` here.
- **Track 3 — Capacitor packaging (LAST):** by now UI is mobile-correct and no `/api` routes remain, so export "just works"; remaining work is native scaffolding + plugins + store compliance (mechanical).

## /flow improvements (owner ask — buildable now, independent of Capacitor)
1. **Month picker** (~12 lines): a native `<select>` of every month `maxMonth→minMonth` ("March 2025"), shown under the "Monthly" range; keep ◀/▶ for ±1 nudge. minMonth/maxMonth already derived (`flow/page.tsx:177-185`); native select = real iOS/Android wheel + free a11y.
2. **Color legend**: prepend a swatch to each kind-chip so the filter row doubles as the key + one caption for the two grays ("money that stayed / moved between your own accounts").
3. **Tap-to-drill-down**: carry a `Map<nodeId, Transaction[]>` through `buildFlowGraph` (root-cause, so top-N merges follow), return `nodeTxnIds`; on pin, render an inline `<details>` table (Date · Merchant · Amount) — "N transactions behind {label}". Precision preserved (tests key on ids/verdicts, not labels).
4. **Plain-language labels** (display strings only): "Held today"→"Still in your accounts", "Opening balance"→"Starting balance", "Card balance ↑"→"New card charges", "⚠ Missing from export"→"⚠ Not in your data yet", etc.
5. **"How to read this"** `<details>` + "Money in →" / "→ Where it went" captions on the Sankey.
6. Replace the reconcile `window.prompt/alert` with an inline balance row + live drift preview.

## Top net-new UX backlog (high-impact)
Shared `money()` honoring `profile.currency` · single nav source (analytics + payment-methods are currently **unreachable** — zero inbound links) · history bulk recategorize/assign after import · confirm-before-delete on calendar/payment-methods (touch data-loss) · cashflow/analytics loading+empty states (flash $0 today) · analytics `budget===0` fabricates $3,000 → treat as "no budget".

## Open questions (owner)
Google auth on native (rec: email-only v1) · AI/OCR online-only (rec: yes) · web installable-offline PWA (rec: skip until promised) · consolidate/delete the orphan routes analytics+payment-methods (needs sign-off — deletes routes) · post-onboarding home (Dashboard vs Forecast) · honor `profile.currency` or drop the picker.
