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
