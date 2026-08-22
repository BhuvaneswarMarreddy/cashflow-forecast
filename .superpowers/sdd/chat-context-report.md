# cashflow-mobile#22 — chat sees state (server/web half)

Owner symptom: the chat could WRITE bills (`record_bill`) but not SEE them — "is it
existing?" and "what are current recurring payments" both got "I do not have that
information". Root cause: `ChatContext` (functions/src/prompts.ts) never carried the
Bills register, the forecast's Upcoming events, or the app's own recurring-merchant
detection.

## Changes

1. **functions/src/prompts.ts** — `ChatContext` gains `bills?`, `upcoming?`, `recurring?`.
   `buildChatMessages` renders three new compact sections (BILLS REGISTER, UPCOMING,
   DETECTED RECURRING MERCHANTS) between FREQUENT MERCHANTS and LEDGER TOTALS, capped
   (60/30/40) and clipped exactly like the existing sections, each reporting what was
   omitted via the existing `omitted()` helper. Two prompt-teaching additions: (a)
   "ANSWERING QUESTIONS ABOUT MONEY" now tells the model these sections are also
   app-computed, not samples, and to answer bill/recurring/upcoming questions from them
   directly instead of claiming no information; (b) the RECORD A BILL block now says to
   check BILLS REGISTER and DETECTED RECURRING MERCHANTS for a match BEFORE proposing
   `record_bill`, and to report an existing match (with amount/cadence) instead of
   proposing a duplicate. The "never claim a change not emitted" rule is untouched.

   Sanity-bound test (`chat.test.ts`, worst-case system-prompt length) updated honestly:
   measured 16506 → 17775 (+1269 chars) for the new headers/placeholders/teaching text
   alone (that test's context carries no bills/upcoming/recurring); bound moved
   16700 → 18000.

2. **src/lib/chat-actions.ts** (web parity) — `buildChatContext` gains a third param
   `bills: Bill[]`, filtered to `isCharging` (not cancelled, not past `endDate` — the
   same rule `billUpcomingEvents` already uses, now exported from `src/lib/bills.ts`),
   capped at 60 and mapped to the same field subset as the server context. `recurring`
   is `behavior.ts`'s `buildAssumptions(transactions, accounts).fixedBills` (detectRecurring's
   active set), capped at 40, both counts matching the server-side caps. **No `upcoming`
   on web** — homeSnapshot's forecast-events + bill-events merge is computed only in
   functions/src/snapshot.ts; nothing on the web client derives that today, and the task
   explicitly allows omitting it with a note. Two pre-existing size-guard tests
   (`chat-actions.test.ts`) needed their bounds raised honestly for the same reason as
   the server one — documented deltas are in the test file comments.

3. **src/components/DataChatSheet.tsx** — added a `bills` state fetched via
   `getBills(profile.id)` on mount/profile-id-change (same read `dashboard/page.tsx`
   already does for the locked-bills chip), threaded into `buildChatContext`'s new third
   argument.

4. **functions/src/snapshot.ts** — `buildSnapshot`'s payload gains a `bills` array (via
   new exported `mapBill`): `{ id, vendor, amountCents, frequency, nonNegotiable, endDate,
   installmentsRemaining, method }`, filtered the same `isCharging` way, cents where the
   payload uses cents, `null` (never omitted) for absent optional fields — matching the
   payload's existing conventions (`mapAccount`/`mapTransaction`/`upcoming`). Pure
   addition: no existing figure (`avgMonthlySpendCents`, `runway.*`, `lockedMonthlyCents`,
   `upcoming`) changed — covered by a DOUBLE-COUNT GUARD test modeled on the existing one
   in `bill-upcoming.test.ts`.

5. **src/lib/bills.ts** — exported `isCharging` (was private), so chat-actions.ts and
   snapshot.ts share the one "is this bill current" rule with `billUpcomingEvents`
   instead of a second definition drifting from it. One-line change; `counterparty.ts` /
   `flow-lanes.ts` / `flow-simple.ts` were never touched.

## Tests (TDD red-first)

Every new/changed assertion was run red (compile error or wrong value) before the
matching implementation edit, then green after. New tests:

- `functions/src/__tests__/chat.test.ts` — 6 new tests: sections render with real data,
  sections say "(none recorded)/(none detected)" when empty, caps+omitted-reporting,
  garbage-context survival, the "answer from these sections" teaching, the "check before
  proposing record_bill / never duplicate" teaching.
- `functions/src/__tests__/bill-upcoming.test.ts` — 5 new tests: full field subset in
  cents, endDate/installmentsRemaining passthrough, cancelled/ended bills absent, and the
  double-count guard (modeled directly on the existing one in that file).
- `src/__tests__/chat-actions.test.ts` — 4 new tests: bills filtered/mapped correctly,
  optional-key omission, empty-list default, recurring merchants from `behavior.ts`
  separate from the Bills register.
- `src/__tests__/data-chat-sheet.test.tsx` — 2 new tests: `getBills` fetch feeds
  `context.bills` on the actual `aiChat` call payload; empty-list default before/without
  a fetch result. `jest.mock('@/lib/firestore', ...)` extended with `getBills`.

## Verification

- `cd functions && npx jest` — 103 passed (was 92; +11), 7 suites.
- `npx jest` (web) — 1514 passed (was 1508; +6), 1 pre-existing skipped suite unchanged.
- `npx tsc --noEmit` (root) — clean.
- `cd functions && npm run build` (tsc + tsc-alias) — clean.
- `npm run build` (next build) — clean, all routes generated.
- `git status --porcelain` — only the 9 files listed above; `counterparty.ts`,
  `flow-lanes.ts`, `flow-simple.ts` untouched.

## Known gap (by design, not an oversight)

Web has no `upcoming` equivalent in chat context — homeSnapshot's forecast-events +
bill-register merge is mobile/server-only. The owner's two observed failures ("is it
existing" / "current recurring payment monthly") are both answerable from
BILLS REGISTER + DETECTED RECURRING MERCHANTS alone, so this gap does not block the
reported bug. Flagging it here in case a future "what's due next" web question surfaces
the same way.

---

## Review-findings follow-up (2026-08-22)

A full review of the #22 PR raised 2 IMPORTANT + 5 MINOR findings. All 7 fixed on this
branch, 4 commits, `counterparty.ts`/`flow-lanes.ts`/`flow-simple.ts` untouched.

### IMPORTANT 1 — `bills` state never refreshed after a chat-recorded save

`DataChatSheet.tsx`'s `bills` state was fetched once via `getBills()` on mount and never
again. Recording a bill through `applyBill` wrote it to Firestore but never updated local
state, so within the same session `buildChatContext` kept building from the pre-write
list — the owner could record a bill, then ask "is it existing?" in the same session and
get told no. Fixed by appending the just-created row to `bills` state right after
`addBill()` resolves (`id` from the write, `createdAt`/`updatedAt` stamped locally with
`new Date().toISOString()`), the exact pattern `BillsTab.tsx`'s `handleSave` already uses
for the same "server timestamp isn't known client-side yet" situation — no new pattern
introduced. Test: `src/__tests__/data-chat-sheet.test.tsx` — record a bill via Apply, then
send a second turn, and assert the second `aiChat` call's `context.bills` contains the new
row, with `getBills` still called exactly once (proving it's a state update, not a
re-fetch).

### IMPORTANT 2 — web's absent UPCOMING read as "you have none"

`functions/src/prompts.ts` rendered a UPCOMING section (falling back to `"(none)"`)
whenever `ctx.upcoming` was falsy, collapsing two different claims: `undefined` (this
client never computed it — web) and `[]` (computed, and there are genuinely none —
mobile). The prompt then told the model all three sections were "computed by the
application" and complete, so a web chat could confidently answer "you have no upcoming
payments" having never actually looked. Fixed honestly: `buildChatMessages` now omits the
UPCOMING section entirely when `ctx.upcoming === undefined`, and the ANSWERING QUESTIONS
ABOUT MONEY block explains what an absent section means ("I can't see upcoming payments
on this client") versus a present-but-empty one (genuinely none — answer directly).
Mobile, which always supplies `upcoming`, renders identically to before. Tests (both
shapes): `functions/src/__tests__/chat.test.ts` — a new `describe` block asserts (a) the
web shape (no `upcoming` key) omits the section header entirely and surfaces the
"can't see it on this client" teaching text, (b) the mobile shape with `upcoming: []`
renders the header reading `"(none)"`, (c) the mobile shape with real rows renders them.
One pre-existing test (`teaches the model to answer bills/upcoming/recurring questions...`)
was updated to pass a context that supplies `upcoming`, since it specifically asserts the
UPCOMING header appears — that's a real behavioural change (an absent section no longer
appears at all), not a loosened assertion.

### MINOR 3 — DOUBLE-COUNT GUARD test didn't actually cover `lockedMonthlyCents`

Added exact-value assertions to the existing test in `bill-upcoming.test.ts`:
`lockedMonthlyCents` is `0` with no bills, and equals `nonNegotiableMonthly([installmentBill])`
in cents with the fixture bill — replacing reliance on the separate BILLS-003 test's
`toBeGreaterThan(0)`, which a mutation test showed would not catch a wrong formula.

### MINOR 4 — `chat-actions.ts`'s `recurring` ignored the owner's Forecast overrides

`buildChatContext` called `buildAssumptions(transactions, accounts)` with no
`AssumptionOverrides`, so a merchant the owner disabled or amount-corrected on the
Forecast page (`forecast/page.tsx:150` passes `loadOverrides()`) still showed in the
chat's DETECTED RECURRING MERCHANTS with its raw detected amount — the chat could
contradict the Forecast page for the identical merchant. Fixed by passing
`loadOverrides()` the same way. On the safety question: `loadOverrides()`
(`src/lib/assumption-overrides.ts`) already wraps `localStorage` access in try/catch,
returning `{}` on SSR/private-mode/corrupt JSON, and `chat-actions.ts` is never imported
outside the browser — only `DataChatSheet.tsx` (`'use client'`) pulls in its runtime code,
and `functions/tsconfig.json`'s explicit file list does not include it — so no additional
guard was needed; confirmed no new `localStorage`-related warnings in `next build` (the
one `ExperimentalWarning: localStorage is not available...` line was already present
before this change, from the pre-existing `railWidth` `window.localStorage` read). Tests:
`src/__tests__/chat-actions.test.ts` — a merchant disabled via a saved override is
omitted from `ctx.recurring`; a merchant with an overridden amount shows that amount, not
the raw detected one.

### MINOR 5 — worst-case bound excluded the new sections

The existing `bounds a hand-rolled oversized request` test supplies no
bills/upcoming/recurring, so its measured worst case only ever covered the new sections'
fixed headers/placeholders — never an actual maxed-out payload. Added a new test that
feeds bills/upcoming/recurring over their caps (200 rows each, max-length fields)
alongside everything else already maxed: measured **40346** chars, bound set to **41000**
(modest headroom). The pre-existing no-bills/upcoming/recurring bound also moved,
honestly, from 18000 to **18700** (measured **18455**) — the ANSWERING QUESTIONS ABOUT
MONEY rewrite (IMPORTANT 2) and the fuzzy-match sentence (MINOR 7) are constant text
present on every prompt regardless of context.

### MINOR 6 — 5 unawaited-act warnings in `data-chat-sheet.test.tsx`

All 5 traced to renders of `<DataChatSheet>` that fired the mount-time `getBills` effect
but never awaited its resolution before the test ended: the "portals the rail to body"
test, all 3 rail-resize tests (drag/keyboard/double-click — all fully synchronous `it`
bodies), and the second, independent `render()` inside the "rejects corrupt values" test.
Fixed by making each `it` async and adding `await waitFor(() => expect(getBills)...)`
right after `render()`, the same flush pattern the pre-existing "fetches the Bills
register" tests already used (which is why those never warned). Verified 0 occurrences of
"not wrapped in act" in the suite's output after the fix.

### MINOR 7 — dedupe guidance had no fuzzy-match instruction

Added one sentence to the RECORD A BILL block in `functions/src/prompts.ts`: a
vendor/merchant that plainly refers to the same service counts as a match even when
spelled differently, and the model should ASK rather than propose a duplicate when
unsure. Test: `functions/src/__tests__/chat.test.ts` asserts both halves of the sentence
are present in the system prompt.

### Verification (final, on the committed state)

- `cd functions && npx jest` — **108 passed** (baseline 103, +5), 7 suites, 0 failures.
- `npx jest` (web) — **1517 passed** (baseline 1514, +3), 9 skipped, 1 pre-existing skipped
  suite unchanged, 0 failures.
- `cd functions && npm run build` (tsc + tsc-alias) — clean.
- `npx tsc --noEmit` (root) — clean.
- `npm run build` (next build) — clean, all routes generated (the one `localStorage`
  `ExperimentalWarning` is pre-existing, confirmed via `git stash` against the same build).
- `git status --porcelain` — clean after 4 commits; `counterparty.ts`, `flow-lanes.ts`,
  `flow-simple.ts` untouched throughout.

### Commits

1. `fix(data-chat-sheet): refresh bills state after a chat-recorded save` — IMPORTANT 1 + MINOR 6.
2. `fix(chat-actions): thread the owner's forecast overrides into recurring` — MINOR 4.
3. `fix(prompts): distinguish an absent UPCOMING section from a genuinely empty one` — IMPORTANT 2 + MINOR 5 + MINOR 7 (same two files).
4. `test(bill-upcoming): pin the lockedMonthlyCents double-count guard` — MINOR 3.

---

## CI follow-up: lazy bills fetch (2026-08-22)

The merged fix wave (`8df82f6`, PR #137) blocked deploy: CI's Playwright suite,
`e2e/accounts-observability.spec.ts`, failed at line 109 —
`expect(liveHits, 'requests to live Firebase/SimpleFIN endpoints').toEqual([])`.

### Root cause

`Navbar.tsx` renders `<DataChatSheet open={isChatOpen} seed={chatSeed}
onClose={...} />` **unconditionally**, on every page. Inside `DataChatSheet`,
`open` only gates the component's final `if (!open) return null;` — every hook
above that line, including IMPORTANT 1's `bills` fetch effect, runs regardless
of whether the sheet is open. So the `getBills(profile.id)` effect (deps:
`[profile?.id]`) fired on **every page mount**, whether or not the owner ever
opened the chat. `e2e/accounts-observability.spec.ts` opens the fixture-backed
`/dev/accounts-fixture` route (which renders the real `Navbar`) and asserts
zero requests to `firestore.googleapis.com` et al. before the user acts — it
correctly caught a real behavioural regression, not a flaky test.

Reproduced directly: ran the spec against the pre-fix tree (`git stash`) and
got a real `firestore.googleapis.com/.../Listen/channel?...` hit in `liveHits`;
re-ran against the fixed tree and got 0 hits, 2/2 tests green.

### Fix

`src/components/DataChatSheet.tsx` — the bills-fetch effect now gates on
`open` (`if (!open || !profile?.id || ...) return;`) instead of firing
unconditionally on mount. A `billsFetchedFor` ref (keyed by `profile.id`) skips
re-fetching on a later close/reopen for the same profile — IMPORTANT 1's
Apply-time local append already keeps `bills` current within a session, so a
reopen has nothing stale to correct and doesn't need a second read.

Tests added, `src/__tests__/data-chat-sheet.test.tsx` (new describe block,
"the bills fetch is LAZY"):
- mounted with `open={false}` (the exact shape Navbar always renders) never
  calls `getBills`, even after a microtask flush.
- flipping `open` from `false` to `true` (via `rerender`) triggers exactly one
  `getBills` call.
- closing and reopening again does NOT trigger a second `getBills` call — the
  already-loaded list is kept.

All pre-existing tests render with `open` (shorthand for `true`), so none
needed changes — they already exercised the "open" path.

### Verification

- `npx jest src/__tests__/data-chat-sheet.test.tsx` — **47 passed** (was 44,
  +3), 0 "not wrapped in act" warnings.
- `npx jest` (web, full suite) — **1520 passed** (was 1517, +3), 9 skipped, 1
  pre-existing skipped suite unchanged, 0 failures.
- `cd functions && npx jest` — 108 passed, unaffected (this fix touches no
  functions/ code).
- `npx tsc --noEmit` (root) — clean.
- `npm run build` (next build) — clean, all routes generated.
- `npx playwright test e2e/accounts-observability.spec.ts --project=chromium`
  — **2 passed** (was 1 failed / 1 passed on the pre-fix tree, reproduced via
  `git stash`), 0 live-endpoint hits.

### Commit

- `1e59c93` `fix(data-chat-sheet): fetch bills lazily, gated on open, not on mount`
