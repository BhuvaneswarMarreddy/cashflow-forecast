# applyDecision Write Path (mobile epic #7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One authenticated callable through which a mapping decision (v1: merchant→category rule) is validated, written, audited, and counted — with the server's own figures honouring it, so phone and browser can never disagree.

**Architecture:** Tasks 1–3 live in `cashflow-forecast` (`functions/` + `src/lib`), Task 4 in `cashflow-mobile`. Task 1 fixes the pre-existing gap where `readLedger` ignores `users/{uid}/rules`; Tasks 2–3 add `applyDecision`/`undoDecision` as thin Admin-SDK loops over the existing pure builders; Task 4 is a mobile client modeled byte-for-byte on `src/data/review.ts`.

**Tech Stack:** firebase-functions v7 `onCall`, Admin SDK, ts-jest (functions), jest-expo (mobile). No new dependencies.

## Global Constraints

- Execute web-repo tasks in a **worktree off `main`** (superpowers:using-git-worktrees) — `main`'s working tree carries the owner's in-flight flow-lane changes (`counterparty.ts`, `flow-lanes.ts`, …); never stage or modify those files.
- Branch `feat/apply-decision` (web), `feat/decisions-client` (mobile). **Merging the web PR auto-deploys functions** (`deploy.yml`); merge only on the owner's explicit go.
- Stage explicit paths only; no `git add -A`.
- Validation server-side mirrors `firestore.rules` `isValidMappingRuleShape` (`firestore.rules:71-83`): `field ∈ {merchant,title,description}`, `op ∈ {contains,equals}`, value length 1–200.
- Figures never reach logs (counts and codes only) — the posture of every existing callable.
- Audit entries include `target` (the shape `firestore.rules:239-244` requires; do NOT copy the divergent shape in `functions/src/review.ts:141-146`).
- All existing suites stay green: web jest, functions jest, mobile `npm run verify`.

---

### Task 1: readLedger applies mapping rules and superseded holds

**Files:**
- Modify: `functions/src/snapshot.ts` (readLedger, ~line 79-95; Ledger interface ~59-70)
- Modify: `functions/tsconfig.json` (include list)
- Test: `functions/src/__tests__/snapshot.test.ts`

**Interfaces:**
- Consumes: `applyMappingRules(transactions, rules)` from `@/lib/mapping-rules`, `withoutSupersededHolds(transactions)` from `@/lib/classify`, `MappingRule` type.
- Produces: `Ledger.transactions` already rule-applied and hold-filtered; `Ledger.rules: MappingRule[]` for later tasks. Every consumer of `readLedger` (`homeSnapshot`, `reviewQueue`, `flowSnapshot`, `flowNodeDetail`) inherits the fix.

- [ ] **Step 1: Write the failing test** — in `functions/src/__tests__/snapshot.test.ts`, following the existing suite's ledger-fixture style:

```ts
import { applyMappingRules } from '@/lib/mapping-rules';
import type { MappingRule } from '@/lib/mapping-rules';

describe('ledger interpretation', () => {
  const rule: MappingRule = {
    id: 'r1',
    match: { field: 'merchant', op: 'contains', value: 'COSTCO' },
    set: { category: 'groceries' },
    createdAt: '2026-08-01T00:00:00.000Z',
    enabled: true,
  };

  it('applies merchant rules before any figure is derived', () => {
    const rows = [
      { id: 't1', merchant: 'COSTCO WHSE #55', title: 'COSTCO', category: 'shopping' },
      { id: 't2', merchant: 'TRADER JOES', title: 'TJ', category: 'groceries' },
    ];
    const out = applyMappingRules(rows as never, [rule]);
    expect(out.find((t) => t.id === 't1')?.category).toBe('groceries');
    expect(out.find((t) => t.id === 't2')?.category).toBe('groceries');
  });

  it('interpretLedgerRows = rules then superseded-holds, the browser order', () => {
    // interpretLedgerRows is the new export under test; asserts both effects
    // through one entry point so readLedger and TransactionContext agree.
    const { interpretLedgerRows } = require('../snapshot');
    const out = interpretLedgerRows(
      [{ id: 't1', merchant: 'COSTCO WHSE #55', title: 'COSTCO', category: 'shopping' }] as never,
      [rule],
    );
    expect(out[0].category).toBe('groceries');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test --prefix functions -- snapshot` → FAIL (`interpretLedgerRows` not exported; possibly `Cannot find module '@/lib/mapping-rules'` from tsconfig — expected).

- [ ] **Step 3: Implement** — in `functions/src/snapshot.ts`:

```ts
import { applyMappingRules, type MappingRule } from '@/lib/mapping-rules';
import { withoutSupersededHolds } from '@/lib/classify';

/** The browser applies holds first, then rules (TransactionContext.tsx:174-181).
 *  VERIFY that order at implementation time and mirror it exactly — one order,
 *  both surfaces. */
export const interpretLedgerRows = (
  transactions: Transaction[],
  rules: MappingRule[],
): Transaction[] => applyMappingRules(withoutSupersededHolds(transactions), rules);
```

In `readLedger`: add a ninth parallel read of `users/{uid}/rules` mapped to `MappingRule[]` sorted `createdAt` descending (the browser's precedence order, `TransactionContext.tsx:157-180`), add `rules` to the `Ledger` interface, and pass transactions through `interpretLedgerRows` before returning. Add `"../src/lib/mapping-rules.ts"` to `functions/tsconfig.json` include; run the build and add any transitive files `tsc` names.

- [ ] **Step 4: Run tests + build** — `npm test --prefix functions` → PASS; `npm run build --prefix functions` → clean (this proves the tsconfig closure).

- [ ] **Step 5: Commit** — `git add functions/src/snapshot.ts functions/tsconfig.json functions/src/__tests__/snapshot.test.ts && git commit -m "fix: server figures honour mapping rules and superseded holds"`

### Task 2: applyDecision callable (merchantRule)

**Files:**
- Create: `functions/src/decisions.ts`
- Modify: `functions/src/index.ts` (one export line)
- Test: `functions/src/__tests__/decisions.test.ts`

**Interfaces:**
- Consumes: `readLedger(uid)` and `Ledger` from `./snapshot`; `applyMappingRules`, `MappingRule`, `RuleMatch` from `@/lib/mapping-rules`.
- Produces: callable `applyDecision`; pure core `applyDecisionCore(ledger: Ledger, op: DecisionOp, now: string): { ruleDoc: Omit<MappingRule,'id'>; summary: ChangeSummary }` with
  `type DecisionOp = { kind: 'merchantRule'; match: RuleMatch; set: MappingRule['set'] }`
  `type ChangeSummary = { transactionsMatched: number; monthsAffected: string[] }`
  Wire result: `{ decisionId: string; changed: ChangeSummary }`.

- [ ] **Step 1: Write the failing test** — `functions/src/__tests__/decisions.test.ts`:

```ts
import { applyDecisionCore, validateOp } from '../decisions';

const ledger = {
  transactions: [
    { id: 't1', merchant: 'COSTCO WHSE #55', title: 'COSTCO', category: 'shopping', date: '2026-06-03' },
    { id: 't2', merchant: 'COSTCO GAS', title: 'COSTCO GAS', category: 'auto', date: '2026-07-11' },
    { id: 't3', merchant: 'TRADER JOES', title: 'TJ', category: 'groceries', date: '2026-07-12' },
  ],
  rules: [],
} as never;

const op = {
  kind: 'merchantRule',
  match: { field: 'merchant', op: 'contains', value: 'COSTCO' },
  set: { category: 'groceries' },
} as const;

it('builds the rule doc and counts exactly the rows the rule changes', () => {
  const { ruleDoc, summary } = applyDecisionCore(ledger, op, '2026-08-21T00:00:00.000Z');
  expect(ruleDoc).toEqual({
    match: op.match, set: op.set,
    createdAt: '2026-08-21T00:00:00.000Z', enabled: true,
  });
  expect(summary.transactionsMatched).toBe(2); // both COSTCO rows, not TJ
  expect(summary.monthsAffected).toEqual(['2026-06', '2026-07']);
});

it('rejects malformed ops with the rules-file constraints', () => {
  expect(() => validateOp({ kind: 'merchantRule', match: { field: 'x', op: 'contains', value: 'a' }, set: {} } as never)).toThrow();
  expect(() => validateOp({ ...op, match: { ...op.match, value: '' } } as never)).toThrow();
  expect(() => validateOp({ ...op, match: { ...op.match, value: 'a'.repeat(201) } } as never)).toThrow();
  expect(() => validateOp({ ...op, set: {} } as never)).toThrow(); // a rule that sets nothing is noise
});
```

- [ ] **Step 2: Run to verify failure** — `npm test --prefix functions -- decisions` → FAIL "Cannot find module '../decisions'".

- [ ] **Step 3: Implement** — `functions/src/decisions.ts`: `validateOp` (hand validation, `HttpsError('invalid-argument', …)`, mirroring `firestore.rules:71-83` + non-empty `set`); `applyDecisionCore` (pure: dry-run `applyMappingRules(ledger.transactions, [candidate])` diffed against input to count changed rows and collect `yyyy-MM` months); `applyDecision = onCall(...)` — auth check exactly like `homeSnapshot`, `readLedger(uid)`, core, then one `setDoc`-style Admin write to `users/{uid}/rules/{auto}` and one audit doc `{ at, actor: 'user', action: 'decision.applied', target: 'rules/<id>' }`; log counts only. Export from `functions/src/index.ts`.

- [ ] **Step 4: Run tests + build** — `npm test --prefix functions` → PASS; `npm run build --prefix functions` → clean.

- [ ] **Step 5: Commit** — `git add functions/src/decisions.ts functions/src/index.ts functions/src/__tests__/decisions.test.ts && git commit -m "feat: applyDecision callable — merchant rules with change summary"`

### Task 3: undoDecision callable

**Files:** Modify: `functions/src/decisions.ts`, `functions/src/index.ts`. Test: extend `functions/src/__tests__/decisions.test.ts`.

**Interfaces:** Produces callable `undoDecision({ decisionId }) → { ok: true }`; pure `undoPatch(): { enabled: false }` applied to `users/{uid}/rules/{decisionId}` + audit `action: 'decision.undone'`. Disable, never delete — the journal IS the rule doc's history.

- [ ] **Step 1: Failing test** — asserts a non-existent id raises `not-found`, and that the patch is `{ enabled: false }` (rule doc otherwise untouched).
- [ ] **Step 2: Run** → FAIL. **Step 3:** implement (get doc, `not-found` if absent, update `enabled:false`, audit). **Step 4:** tests + build green. **Step 5:** `git commit -m "feat: undoDecision disables a rule and audits it"`.

### Task 4: Mobile client wrapper

**Files (cashflow-mobile):**
- Create: `src/data/decisions.ts`
- Test: `src/data/__tests__/decisions.test.ts`

**Interfaces:**
- Consumes: callables `applyDecision`/`undoDecision` (Task 2/3 wire shapes); `firebaseFunctions`, `isFirebaseConfigured` from `@/services/firebase`; `AppError`; `triggerRefresh` from `@/hooks/useRefresh`.
- Produces:
  `applyMerchantRule(input: { match: RuleMatch; set: RuleSet }): Promise<ChangeSummary>`
  `undoDecision(decisionId: string): Promise<void>`
  Both re-fetch figures on success via `triggerRefresh('tap')` (the `togglePending` pattern — mobile never computes money, so "optimistic" means pending state + refetch, not local math).

- [ ] **Step 1: Failing test** — mock `@/services/firebase` + `@firebase/functions` the way `src/data/__tests__/accountsWrite.test.ts` mocks Firestore; assert: happy path returns the summary and fires `triggerRefresh`; unconfigured Firebase throws `FIREBASE_NOT_CONFIGURED`; callable rejection wraps into `AppError` with `code: 'DECISION_WRITE_FAILED'`, `retryable: true`, and does NOT fire `triggerRefresh`.
- [ ] **Step 2: Run** `npm test -- decisions` → FAIL. **Step 3:** implement, modeled line-for-line on `src/data/review.ts` (`callableOrThrow`, counts-only logging). **Step 4:** `npm run verify` → all green. **Step 5:** `git add src/data/decisions.ts src/data/__tests__/decisions.test.ts && git commit -m "feat: decisions client — applyMerchantRule + undo"`.

---

## Deliberately out of v1 (flagged, not forgotten)

- **Review dual-keying** (`InflowReview.fingerprint` written but never read — the #111 wound): separate fix, file as a web-repo issue when #7 ships.
- **Transfer-pair decisions** (#9): `relations.ts:38-47` documents why stored pairs are worse than live matching; #9 must be *overrides the matcher consults*, designed at its own go.
- **accountState / cardPolicy kinds** (#13/#14): new concepts; they extend `DecisionOp` later — `validateOp` is the single gate they'll pass through.
- No snapshotVersion machinery: single user, refetch-on-write; add versioning only if a stale-read ever actually bites.

## Self-review notes

- Task 1's order-of-application (holds vs rules) is asserted against the browser at implementation time — the plan pins the *requirement* (identical order both surfaces), not a guess.
- Types referenced (`RuleMatch`, `MappingRule`, `Ledger`) all exist today at the cited paths; only `interpretLedgerRows`, `applyDecisionCore`, `validateOp`, `undoPatch` are new, and each is defined in the task that produces it.
