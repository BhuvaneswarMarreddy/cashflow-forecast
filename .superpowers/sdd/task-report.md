# Task report — route the browser's rule writes through applyDecision (issue #130)

Worktree: `/Users/bhuvaneswarmarreddy/Desktop/Projects/cashflow-forecast/.worktrees/web-parity`
Branch: `feat/web-decisions-parity`

## Summary

`TransactionContext.addRule` no longer writes `users/{uid}/rules` directly via `setDoc`.
It now calls the `applyDecision` callable (the same validated write path the mobile app
uses), keeps its optimistic prepend, reconciles the optimistic row to the server's
`decisionId` on success, rolls it back on failure, and returns `{ rule, changed }` so
callers can show the server's real `ChangeSummary`. Both callers (`flow/page.tsx`,
`DataChatSheet.tsx`) were updated to use the new return shape and to surface failures
instead of swallowing them. An `undoDecision` wrapper was added to `callables.ts` for
mobile/web parity (no caller yet — `deleteRule`/`toggleRule` are explicitly out of scope
per the brief).

## Files changed

- `src/lib/callables.ts` — added `applyDecision`, `undoDecision`, `ChangeSummary` type;
  extended `callableErrorMessage` with a `fallback` parameter; made the `Functions`
  instance lazy (see "Unplanned fix" below).
- `src/context/TransactionContext.tsx` — `addRule` swapped to the callable write path;
  `TransactionContextType.addRule`'s return type updated; `setDoc` import dropped
  (no longer used in this file).
- `src/app/flow/page.tsx` (`onGroupDecide`, ~1304) — uses the returned `changed` to
  update the announcement live-region on success; announces a failure instead of the
  old silent `.catch(() => {})`.
- `src/components/DataChatSheet.tsx` (`apply`, ~198) — applied message now includes the
  server's transaction count; failure path uses `callableErrorMessage` with a
  decision-specific fallback instead of the AI one.
- `src/__tests__/transaction-context-add-rule.test.ts` — new. Context-level test for the
  swapped `addRule`, mocking `@/lib/callables` (not Firestore for the write itself —
  `@/lib/firebase`/`@/lib/firestore` are still mocked minimally so the provider can
  mount, per the brief's "mock callables, NOT firestore" instruction being about the
  *write path*, not about suppressing the provider's other Firestore reads).
- `src/__tests__/data-chat-sheet.test.tsx` — updated the `addRule` mock return shape to
  `{ rule, changed }` and added an assertion that the applied message includes the
  server's count.

## TDD — red states

**1. New context test, run against the unmodified `addRule` (still direct `setDoc`):**

```
$ npx jest src/__tests__/transaction-context-add-rule.test.ts --silent
```
```
● ... reconciles the optimistic id ...
  TypeError: (0 , _firebase.setDoc) is not a function
    at Object.addRule (src/context/TransactionContext.tsx:200:13)
● ... rolls back the optimistic entry when applyDecision rejects ...
  expect(received).rejects.toBe(expected)
  Expected: [Error: nope]
  Received: [TypeError: (0 , _firebase.setDoc) is not a function]
● ... prepends an optimistic entry immediately ...
  expect(jest.fn()).toHaveBeenCalledWith(...)   // applyDecisionMock never called
  Number of calls: 0

Test Suites: 1 failed, 1 total
Tests:       3 failed, 3 total
```
Red for the right reason: `addRule` never calls `applyDecision`, and the mocked
`@/lib/firebase` (deliberately missing `setDoc`, since the fix removes that call)
throws when the old code path still tries to use it.

**2. Updated `data-chat-sheet.test.tsx` mock/assertion, run against unmodified `DataChatSheet.tsx`:**
```
$ npx jest src/__tests__/data-chat-sheet.test.tsx --silent
```
```
● DataChatSheet › previews a proposed rule with a match count and writes NOTHING until Apply
  Unable to find an element with the text: /^Saved —.*2 existing transactions changed/.
Test Suites: 1 failed, 1 total
Tests:       1 failed, 14 passed, 15 total
```
Red for the right reason: the old code called `describeRule(saved)` treating the
mock's new `{ rule, changed }` shape as if it were the bare `MappingRule`, so the
message never included the count.

## Green — after implementation

```
$ npx jest src/__tests__/data-chat-sheet.test.tsx src/__tests__/transaction-context-add-rule.test.ts src/__tests__/mapping-rules.test.ts --silent
PASS src/__tests__/mapping-rules.test.ts
PASS src/__tests__/transaction-context-add-rule.test.ts
PASS src/__tests__/data-chat-sheet.test.tsx
Test Suites: 3 passed, 3 total
Tests:       39 passed, 39 total
```

## Unplanned fix — eager `getFunctions()` in `callables.ts`

After swapping `addRule`, `npm run test:ci` broke one suite that TDD on the two named
files didn't catch:

```
FAIL src/__tests__/csv-import.test.ts
  ● Test suite failed to run
    FirebaseError: Firebase: No Firebase App '[DEFAULT]' has been created - call initializeApp() first (app/no-app).
      at Object.<anonymous> (src/lib/callables.ts:7:31)
      at Object.<anonymous> (src/context/TransactionContext.tsx:29:20)
      at Object.<anonymous> (src/components/CSVImportModal.tsx:42:29)
      at Object.<anonymous> (src/__tests__/csv-import.test.ts:5:25)
```

Root cause: `callables.ts` called `getFunctions(app, 'us-central1')` at module top
level. Before this task, `TransactionContext.tsx` never imported `callables.ts`, so
that eager call was only reachable from the handful of AI-panel components, all of
which mock `@/lib/callables` wholesale in their tests. Adding
`import { applyDecision } from '@/lib/callables'` to `TransactionContext.tsx` put that
eager call in the import graph of nearly every page (`TransactionContext` is imported
almost everywhere). `csv-import.test.ts` renders `CSVImportModal` (→ `TransactionContext`)
without mocking `@/lib/firebase`'s `app` export (it relies on `jest.setup.js`'s global
`{ auth, db }`-only mock), so `getFunctions(undefined, ...)` threw at module load —
before any test even ran.

Fix (root cause, in the one shared place, not a per-test patch): made the `Functions`
instance lazy — computed on first actual call via a memoized accessor `functions()`,
not at import time. `getFunctions` is cheap to call repeatedly (the SDK caches by
app+region), so this costs nothing on the path that does invoke a callable, and it
means any future importer of `callables.ts` — direct or transitive — no longer needs a
live Firebase app just to load the module.

Verified this was NOT a pre-existing failure: `git stash` back to the base commit
(08fbce6) and `npm run test:ci` both before and after confirmed `csv-import.test.ts`
only fails with my `TransactionContext.tsx` changes present and the eager
`getFunctions()`; the lazy fix resolves it without touching `csv-import.test.ts` itself
or any other test file.

## Full gates

```
$ npm run test:ci
Test Suites: 100 passed, 100 total
Tests:       1435 passed, 1435 total
```

```
$ npx tsc --noEmit 2>&1 | grep -vc '^functions/'
0
```
(`functions/` itself reports 21 pre-existing `TS2307`/`TS7006` errors — confirmed via
`git stash` against the base commit that these exist unmodified on `main` too, because
`functions/node_modules` is not installed in this environment. Nothing under `functions/`
was touched by this task.)

```
$ npx eslint src/lib/callables.ts src/context/TransactionContext.tsx src/app/flow/page.tsx \
    src/components/DataChatSheet.tsx src/__tests__/transaction-context-add-rule.test.ts \
    src/__tests__/data-chat-sheet.test.tsx
✖ 2 problems (0 errors, 2 warnings)
```
Both remaining warnings (`DataChatSheet.tsx:535` unused `money` param,
`TransactionContext.tsx:488` unused `id` param in `deleteRule`) are pre-existing —
confirmed via `git stash` diff against the base commit; same warnings, same code,
different line numbers.

## Constraint check

- `counterparty.ts`, `flow-lanes.ts`, `flow-simple.ts` and their tests: `git diff --stat`
  against those paths is empty — untouched, never appeared as modified.
- `deleteRule`/`toggleRule` in `TransactionContext.tsx`: byte-for-byte unchanged (only
  the file-level `import` line above them lost `setDoc`, which they don't use).
- `setInflowReview` loop in `flow/page.tsx` (~1298-1302): untouched, only the line
  immediately after it (`decision.rule` block) was edited.
- Figures/merchant strings never reach console/log lines: `addRule`'s `console.warn`
  logs only the error object (Firebase error codes/messages, never the rule's
  match value); the new test asserts the logged text does not contain the fixture's
  merchant string ("COSTCO").
- Commit uses explicit paths, lowercase conventional style, and ends with the
  `Claude Fable 5` co-author trailer.

## Self-review

- Re-read `functions/src/decisions.ts`'s `validateOp`/`applyDecisionCore` to confirm the
  exact request/response shapes (`{ kind, match, set }` → `{ decisionId, changed }`)
  before writing `callables.ts`'s wrapper types, rather than guessing from the brief
  alone.
- Confirmed via `functions/tsconfig.json` that `functions/src/decisions.ts` is not
  reachable from the web app's `@/*` path (separate `rootDir`, separate build, and the
  web `tsconfig.json`'s `paths` only maps to `./src/*`), so `ChangeSummary` had to be
  redefined in `callables.ts` rather than imported — documented why in the type's
  own comment so a future reader doesn't "fix" it into a broken import.
- Deliberately did not memoize/dedupe `applyDecision` calls or add retry logic —
  not asked for, and `functions/src/decisions.ts` gives no signal that duplicate
  submissions need client-side guarding beyond what the server already validates.
- Chose to keep `deleteRule`/`toggleRule` completely untouched even though they now
  sit next to a very different `addRule` — the brief is explicit that they're out of
  scope, and leaving an inconsistency between sibling functions is the correct call
  here (matches the brief's own reasoning: "zero callers").
- The lazy-`getFunctions()` fix is the one piece of scope not explicitly named in the
  brief. Treated it as in-scope because it was a direct, mechanical consequence of the
  brief's own required change (importing `callables.ts` into `TransactionContext.tsx`)
  and the fix lives entirely inside `callables.ts`, one of the four files the brief
  already names.

## Concerns

- None blocking. The one thing worth flagging: `flow/page.tsx`'s success announcement
  for a saved rule now updates asynchronously, after the synchronous "Saved for N
  rows..." announcement already set by the rest of `onGroupDecide`. This is
  intentional per the brief ("use the returned changed to set the existing
  announcement live-region on success") but means a screen-reader user hears two
  announcements in quick succession for a rule-creating decision — the immediate
  "Saved for N rows" and then, a beat later, "Rule saved — N transactions
  re-categorised." No existing test exercises this path's announcement text (verified
  via grep across `recovery-*`/`flow-reconciliation-*` test files), so this is a
  genuinely new, currently-untested UX detail; happy to add a targeted test if wanted,
  but the brief's test list didn't call for one and `onGroupDecide`'s existing test
  coverage is zero in this repo today (pre-existing gap, not introduced here).
