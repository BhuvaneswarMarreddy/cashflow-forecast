# Balance Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Revision 2 — rebased onto `76c3f0e`, 2026-08-08

Main advanced nine commits while this plan was being written. Three tasks are now
superseded and one is absorbed:

| Task | Status |
|---|---|
| **1** | **SUPERSEDED by #117.** `CSVImportModal` no longer stamps `openingDate`, and `PaymentAccount.openingDate` is already optional (`types/index.ts:191`). |
| **4** | **ABSORBED by #115.** `src/lib/audit.ts` shipped an append-only log with a free-form `after` payload and a `recordAudit()` that never throws. A parallel `driftObservations` collection would be a second history beside the one that exists. No new collection, no `firestore.rules` change, no manual rules deploy. |
| **9** | **SUPERSEDED by #117.** `scripts/fix_opening_anchor.py` shipped. It has **not** been run with `--apply`: it found one account (Amazon Store Card, $0 anchored 2026-08-08, 204 rows hidden, +$10,458.03) and the owner held it, because stored data cannot distinguish "typed 0" from "left blank". **That ambiguity is what Tasks 2/6/7 resolve** — an unanchored account stops claiming to be a balance, so the $0 becomes answerable instead of guessed. |

**Remaining: Tasks 2, 3, 5, 6, 7, 8.** #83 is closed; the half that stops a net-movement
figure reading as a bank balance, and INV-1, are not built.

**Goal:** Stop CSV-imported accounts asserting a false "$0.00 as of today" anchor that hides their entire history, surface unanchored accounts honestly, and persist the reconciliation drift the code currently discards.

**Architecture:** No new concepts. `openingAnchor()` already encodes the correct anchor semantics and is used at 4 of 5 creation sites — route the fifth through it. "Unanchored" is the already-possible state `openingDate === undefined`, surfaced rather than invented. INV-1 persists the `driftCents` that `reconcile()` computes and throws away, at the only moment the derived and provider balances are independent.

**Tech Stack:** Next.js 15 App Router, TypeScript, Firestore, Jest + Testing Library, Python 3.12 for scripts.

## Global Constraints

- Money math in **integer cents**. Never compare floats. `Math.round(x * 100)`.
- Every money function takes `FinancialPolicy` as a **required** argument. Use `POSTED_ONLY` where posted-only is deliberate.
- **FIN-SETTLEMENT-003: nothing auto-applies.** Only a confirmation moves a number.
- Never render an unset or unbackable value as a measured one.
- Test command: `npm test -- <path> -t "<name>"`. Full suite: `npm test`.
- Do **not** add `driftObservations` to `USER_SUBCOLLECTIONS`.
- Spec: `docs/superpowers/specs/2026-08-08-balance-correctness-design.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/types/index.ts` | `PaymentAccount.openingDate` becomes optional; `DriftObservation` interface |
| `src/lib/accounts.ts` | `isUnanchored()`; `reconcile()` returns a drift observation |
| `src/components/CSVImportModal.tsx` | Auto-created accounts get no anchor |
| `src/lib/firestore.ts` | `addDriftObservation()`; explicit delete of `driftObservations` |
| `src/context/UserProfileContext.tsx` | `reconcileAccount` persists the observation |
| `src/app/accounts/page.tsx` | Per-row + totals unanchored notes |
| `src/app/dashboard/page.tsx`, `src/app/forecast/page.tsx` | Totals note |
| `src/lib/forecast.ts` | AI context names unanchored accounts |
| `firestore.rules` | `driftObservations` create-only |
| `scripts/reanchor.py` | Dry-run-default migration |

---

### Task 1: Auto-created accounts carry no anchor — SUPERSEDED BY #117, DO NOT IMPLEMENT

Shipped on main. `CSVImportModal.tsx:41` returns no `openingDate`, and
`PaymentAccount.openingDate` is optional at `types/index.ts:191`. Original text below
for provenance only.

#### Task 1 (original)

**Files:**
- Modify: `src/types/index.ts:183`
- Modify: `src/components/CSVImportModal.tsx:28-42`
- Test: `src/__tests__/csv-import-anchor.test.ts`

**Interfaces:**
- Consumes: `openingAnchor(raw, todayISO): { openingBalance: number; openingDate?: string }` from `src/lib/accounts.ts:37`
- Produces: `inferAccountFromCsv(csvName)` returns an account with **no** `openingDate`

`PaymentAccount.openingDate` is currently required, so returning an object without it will not compile. `deriveAccountBalance` already reads `account.openingDate || '0000-00-00'`, and both display sites (`accounts/page.tsx:653`, `AccountDetailModal.tsx:89`) already guard with `account.openingDate &&`, so making it optional is safe.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/csv-import-anchor.test.ts`:

```ts
/**
 * #83 — an account auto-created by CSV import must assert NOTHING about its
 * starting balance. Stamping `openingDate: today` with `openingBalance: 0`
 * claims "this account held $0.00 today" and makes deriveAccountBalance skip
 * the entire history the import just created the account from.
 */
import { inferAccountFromCsv } from '@/components/CSVImportModal';
import { deriveAccountBalance } from '@/lib/forecast';
import { POSTED_ONLY } from '@/lib/classify';
import { PaymentAccount, Transaction } from '@/types';

describe('CSV auto-created accounts (#83)', () => {
  it('sets no openingDate, so nothing is hidden behind an anchor', () => {
    expect(inferAccountFromCsv('Chase Checking (1234)').openingDate).toBeUndefined();
    expect(inferAccountFromCsv('Chase Checking (1234)').openingBalance).toBe(0);
  });

  it('derives the full net of imported history instead of $0.00', () => {
    const account = { ...inferAccountFromCsv('Chase Checking (1234)'), id: 'acc-1' } as PaymentAccount;
    const txns = [
      { id: 't1', accountId: 'acc-1', amount: 500, type: 'income', date: '2026-03-14', title: 'Deposit', category: 'other', paymentMethod: 'bank-transfer' },
      { id: 't2', accountId: 'acc-1', amount: 200, type: 'expense', date: '2026-04-02', title: 'Groceries', category: 'groceries', paymentMethod: 'bank-transfer' },
    ] as unknown as Transaction[];

    expect(deriveAccountBalance(account, txns, POSTED_ONLY)).toBe(300);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/csv-import-anchor.test.ts`
Expected: FAIL — `openingDate` is today's date, and the derived balance is `0` because both rows are dated before it.

- [ ] **Step 3: Make `openingDate` optional**

In `src/types/index.ts`, change line 183:

```ts
  openingBalance: number; // balance AT openingDate; cash +, debt = amount owed
  /** ISO yyyy-MM-dd; net is summed from here forward. ABSENT = no anchor was ever
   *  asserted, so the whole history counts (see openingAnchor in lib/accounts.ts). */
  openingDate?: string;
```

- [ ] **Step 4: Route the import through `openingAnchor()`**

In `src/components/CSVImportModal.tsx`, add to the imports at the top of the file:

```ts
import { openingAnchor } from '@/lib/accounts';
```

Replace line 41:

```ts
  return { name, type, provider, openingBalance: 0, openingDate: new Date().toISOString().slice(0, 10), lastFourDigits, color: getMerchantColor(csvName), isActive: true };
```

with:

```ts
  // An imported account asserts NOTHING about its starting balance, so it gets no
  // anchor and its whole history counts. openingAnchor('') is that assertion-free
  // case — the same helper every other creation site uses (#83).
  return {
    name, type, provider,
    ...openingAnchor('', new Date().toISOString().slice(0, 10)),
    lastFourDigits, color: getMerchantColor(csvName), isActive: true,
  };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/__tests__/csv-import-anchor.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Run the suites this could break**

Run: `npm test -- src/__tests__/csv-import.test.ts src/__tests__/derive-balance.test.ts src/__tests__/opening-anchor.test.ts src/__tests__/accounts.test.ts`
Expected: PASS. If a test asserted `openingDate` was today on an imported account, it was pinning the bug — update it and note that in the commit message.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. If a call site assumed `openingDate` was always a string, guard it with `account.openingDate &&`.

- [ ] **Step 8: Commit**

```bash
git add src/types/index.ts src/components/CSVImportModal.tsx src/__tests__/csv-import-anchor.test.ts
git commit -m "fix(#83): CSV-imported accounts assert no opening anchor

inferAccountFromCsv stamped openingBalance 0 + openingDate today, which
asserts 'this account held \$0.00 today' and makes deriveAccountBalance skip
every imported row. Route it through openingAnchor(), the helper the other
four creation sites already use, and make openingDate optional to match."
```

---

### Task 2: `isUnanchored()`

**Files:**
- Modify: `src/lib/accounts.ts`
- Test: `src/__tests__/accounts.test.ts`

**Interfaces:**
- Produces: `isUnanchored(a: PaymentAccount): boolean`

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/accounts.test.ts`:

```ts
import { isUnanchored } from '@/lib/accounts';

describe('isUnanchored', () => {
  const base = { id: 'a', name: 'A', type: 'bank_account', provider: 'chase', color: '#000', isActive: true, openingBalance: 0 } as PaymentAccount;

  it('is true when nobody ever asserted a starting balance', () => {
    expect(isUnanchored(base)).toBe(true);
  });

  it('is false once an anchor date exists', () => {
    expect(isUnanchored({ ...base, openingDate: '2026-01-01' })).toBe(false);
  });

  it('is true for an empty-string date, which asserts nothing', () => {
    expect(isUnanchored({ ...base, openingDate: '' })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/accounts.test.ts -t "isUnanchored"`
Expected: FAIL — `isUnanchored is not a function`.

- [ ] **Step 3: Implement**

Add to `src/lib/accounts.ts`, directly below `currentOf`:

```ts
/**
 * True when nobody has ever asserted a starting balance for this account.
 *
 * Its derived balance is then NET MOVEMENT across the rows we hold, not a bank
 * balance. Real, defensible, and it must never be presented as the latter.
 */
export const isUnanchored = (a: PaymentAccount): boolean => !a.openingDate;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/__tests__/accounts.test.ts -t "isUnanchored"`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/accounts.ts src/__tests__/accounts.test.ts
git commit -m "feat: isUnanchored() names the no-anchor account state"
```

---

### Task 3: `DriftObservation` and `reconcile()`

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/lib/accounts.ts:64-72`
- Test: `src/__tests__/drift-observation.test.ts`

**Interfaces:**
- Consumes: `isUnanchored` (Task 2)
- Produces: `DriftObservation`; `reconcile(account, enteredCurrent, derivedCurrent, todayISO, ctx)` returns `{ driftCents, reanchor?, observation }`; `driftStatus(o: DriftObservation, lastScheduledSlotISO: string): DriftStatus`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/drift-observation.test.ts`:

```ts
/**
 * INV-1. reconcile() computes the only independent accuracy measurement in the
 * system — entered/provider balance minus derived balance — and throws it away.
 * After a re-anchor the two agree by construction, so this is the ONLY moment
 * the comparison exists.
 */
import { reconcile, driftStatus } from '@/lib/accounts';
import { PaymentAccount } from '@/types';

const anchored = { id: 'a', name: 'Chase', type: 'bank_account', provider: 'chase', color: '#000', isActive: true, openingBalance: 100, openingDate: '2026-01-01' } as PaymentAccount;
const unanchored = { ...anchored, openingDate: undefined };
const CTX = { includePending: false, providerCheckedAt: '2026-08-08T13:05:00Z', source: 'user' as const };
const NOW = '2026-08-08';
const LAST_SLOT = '2026-08-08T13:00:00Z';

describe('reconcile drift observation (INV-1)', () => {
  it('records an exact-cent drift', () => {
    const { driftCents, observation } = reconcile(anchored, 9235.00, 8770.00, NOW, CTX);
    expect(driftCents).toBe(46500);
    expect(observation.driftCents).toBe(46500);
    expect(observation.enteredCents).toBe(923500);
    expect(observation.derivedCents).toBe(877000);
    expect(observation.anchored).toBe(true);
    expect(observation.includePending).toBe(false);
  });

  it('records the observation even when the drift is zero', () => {
    const { driftCents, observation } = reconcile(anchored, 9235.00, 9235.00, NOW, CTX);
    expect(driftCents).toBe(0);
    expect(observation.driftCents).toBe(0);
  });

  it('marks an unanchored account as unanchored, never as passing', () => {
    const { observation } = reconcile(unanchored, 9235.00, 1200.00, NOW, CTX);
    expect(observation.anchored).toBe(false);
    expect(driftStatus(observation, LAST_SLOT)).toBe('NOT_APPLICABLE');
  });
});

describe('driftStatus', () => {
  const obs = (over: Partial<ReturnType<typeof reconcile>['observation']>) =>
    ({ accountId: 'a', at: '2026-08-08T13:05:00Z', enteredCents: 0, derivedCents: 0,
       driftCents: 0, includePending: false, anchored: true, source: 'user' as const,
       providerCheckedAt: '2026-08-08T13:05:00Z', ...over });

  it('PASS when an anchored account reconciles exactly', () => {
    expect(driftStatus(obs({ driftCents: 0 }), LAST_SLOT)).toBe('PASS');
  });

  it('VIOLATION when it does not and the provider data is fresh', () => {
    expect(driftStatus(obs({ driftCents: 1 }), LAST_SLOT)).toBe('VIOLATION');
  });

  it('STALE_INPUT when the provider was last checked before the latest slot', () => {
    expect(driftStatus(obs({ driftCents: 1, providerCheckedAt: '2026-08-05T07:00:00Z' }), LAST_SLOT))
      .toBe('STALE_INPUT');
  });

  it('NOT_APPLICABLE beats everything for an unanchored account', () => {
    expect(driftStatus(obs({ driftCents: 999, anchored: false }), LAST_SLOT)).toBe('NOT_APPLICABLE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/drift-observation.test.ts`
Expected: FAIL — `driftStatus is not a function`, and `reconcile` takes 4 arguments.

- [ ] **Step 3: Add the types**

Add to `src/types/index.ts`, after the `PaymentAccount` interface:

```ts
/**
 * INV-1 — one reconciliation measurement, kept.
 *
 * `reconcile()` compares an asserted balance against the derived one and then
 * re-anchors, after which the two agree BY CONSTRUCTION. No provider balance is
 * stored anywhere, so this record is the only surviving evidence that the
 * derivation was ever checked. Create-only; never edited.
 */
export interface DriftObservation {
  accountId: string;
  at: string;                  // ISO instant the observation was made
  enteredCents: number;        // the balance a human or provider asserted
  derivedCents: number;        // deriveAccountBalance at that moment
  driftCents: number;          // entered − derived, integer cents
  includePending: boolean;     // the policy in force when derived was computed
  providerCheckedAt?: string;  // meta/<source>.lastSuccess at observation time
  anchored: boolean;           // false when openingDate was absent
  source: 'user' | 'sync';
}

export type DriftStatus = 'PASS' | 'VIOLATION' | 'STALE_INPUT' | 'NOT_APPLICABLE';
```

- [ ] **Step 4: Extend `reconcile()` and add `driftStatus()`**

In `src/lib/accounts.ts`, replace the whole `reconcile` function (lines 64-72) with:

```ts
export interface DriftContext {
  includePending: boolean;
  providerCheckedAt?: string;
  source: 'user' | 'sync';
}

/**
 * Reconcile an account against a real balance. Anchor-only: any drift re-anchors
 * (openingBalance = the entered balance, openingDate = today), which resets
 * net-since-anchor to zero and makes later pre-today imports harmless.
 *
 * The observation is returned ALWAYS, including at zero drift — a clean check is
 * evidence too, and callers persist it before applying `reanchor`.
 */
export function reconcile(
  account: PaymentAccount,
  enteredCurrent: number,
  derivedCurrent: number,
  todayISO: string,
  ctx: DriftContext
): { driftCents: number; reanchor?: { openingBalance: number; openingDate: string }; observation: DriftObservation } {
  const enteredCents = Math.round(enteredCurrent * 100);
  const derivedCents = Math.round(derivedCurrent * 100);
  const driftCents = enteredCents - derivedCents;
  const observation: DriftObservation = {
    accountId: account.id,
    at: new Date().toISOString(),
    enteredCents,
    derivedCents,
    driftCents,
    includePending: ctx.includePending,
    providerCheckedAt: ctx.providerCheckedAt,
    anchored: !isUnanchored(account),
    source: ctx.source,
  };
  if (driftCents === 0) return { driftCents: 0, observation };
  return { driftCents, reanchor: { openingBalance: enteredCurrent, openingDate: todayISO }, observation };
}

/**
 * An unanchored account has no claim to violate, so it is never PASS.
 * Staleness is DERIVED from the sync schedule rather than a fixed hour count:
 * the overnight gap between the 19:00 and 07:00 runs is itself 12 hours, so any
 * fixed 6h/12h threshold would mark every account stale every morning.
 */
export function driftStatus(o: DriftObservation, lastScheduledSlotISO: string): DriftStatus {
  if (!o.anchored) return 'NOT_APPLICABLE';
  if (o.driftCents === 0) return 'PASS';
  if (o.providerCheckedAt && o.providerCheckedAt < lastScheduledSlotISO) return 'STALE_INPUT';
  return 'VIOLATION';
}
```

Add `DriftObservation`, `DriftStatus` to the existing `@/types` import at the top of the file.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/__tests__/drift-observation.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Fix the existing caller so the suite compiles**

`src/context/UserProfileContext.tsx:352` calls `reconcile` with 4 arguments. Add the fifth temporarily so typecheck passes; Task 5 replaces it properly:

```ts
    const { driftCents, reanchor } = reconcile(acc, enteredCurrent, derivedCurrent, today,
      { includePending: false, source: 'user' });
```

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/lib/accounts.ts src/context/UserProfileContext.tsx src/__tests__/drift-observation.test.ts
git commit -m "feat(INV-1): reconcile() returns a DriftObservation instead of discarding drift"
```

---

### Task 4: Persist observations — SUPERSEDED, DO NOT IMPLEMENT

**Absorbed by the audit log that shipped in #115.** A drift observation is recorded as an
audit entry in Task 5; there is no `driftObservations` collection, no new `firestore.rules`
block, and nothing to deploy by hand. The original text is kept below for provenance only.

<details><summary>Superseded original</summary>

#### Task 4 (original): Persist observations

**Files:**
- Modify: `src/lib/firestore.ts` (writer near `setInflowReview` ~line 628; `deleteAllUserData` ~line 1089)
- Modify: `firestore.rules`
- Test: `src/__tests__/drift-store.test.ts`

**Interfaces:**
- Consumes: `DriftObservation` (Task 3)
- Produces: `addDriftObservation(userId: string, o: DriftObservation): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/drift-store.test.ts`:

```ts
/**
 * driftObservations is create-only and is NOT in USER_SUBCOLLECTIONS — that array
 * drives deleteAllUserData, and accuracy evidence must be deleted by an explicit,
 * visible line rather than by silently joining a loop.
 */
import { USER_SUBCOLLECTIONS } from '@/lib/firestore';
import * as fs from 'node:fs';

describe('driftObservations storage contract', () => {
  it('is not swept up by the USER_SUBCOLLECTIONS loop', () => {
    expect(USER_SUBCOLLECTIONS).not.toContain('driftObservations');
  });

  it('is deleted explicitly by deleteAllUserData', () => {
    const src = fs.readFileSync('src/lib/firestore.ts', 'utf8');
    const body = src.slice(src.indexOf('export async function deleteAllUserData'));
    expect(body).toContain('driftObservations');
  });

  it('is create-only in firestore.rules', () => {
    const rules = fs.readFileSync('firestore.rules', 'utf8');
    const block = rules.slice(rules.indexOf('match /driftObservations/'));
    expect(block).toMatch(/allow update, delete: if false/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/drift-store.test.ts`
Expected: FAIL — `deleteAllUserData` body has no mention, and the rules block is missing.

- [ ] **Step 3: Add the writer**

In `src/lib/firestore.ts`, below `deleteInflowReview`:

```ts
/** INV-1 evidence. Create-only: one document per observation, never updated. */
export async function addDriftObservation(userId: string, o: DriftObservation): Promise<void> {
  await addDoc(collection(db, 'users', userId, 'driftObservations'), o);
}
```

Add `addDoc` to the `firebase/firestore` import if it is not already there, and `DriftObservation` to the `@/types` import.

- [ ] **Step 4: Delete it explicitly**

In `deleteAllUserData`, after the `USER_SUBCOLLECTIONS` loop and before `await deleteDoc(doc(db, 'users', userId))`:

```ts
  // driftObservations is deliberately NOT in USER_SUBCOLLECTIONS: an accuracy
  // record that a routine loop can erase is not evidence. Account deletion still
  // removes it — visibly, here.
  const drift = await getDocs(collection(db, 'users', userId, 'driftObservations'));
  for (let i = 0; i < drift.docs.length; i += DELETE_CHUNK) {
    const batch = writeBatch(db);
    for (const d of drift.docs.slice(i, i + DELETE_CHUNK)) batch.delete(d.ref);
    await batch.commit();
  }
```

- [ ] **Step 5: Add the rule**

In `firestore.rules`, inside `match /users/{userId}`, alongside `match /links/{linkId}`:

```
      match /driftObservations/{observationId} {
        allow read: if isOwner(userId);
        allow create: if isOwner(userId);
        allow update, delete: if false;
      }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- src/__tests__/drift-store.test.ts`
Expected: PASS, 3 tests.

Run: `npm test -- src/__tests__/account-delete.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/firestore.ts firestore.rules src/__tests__/drift-store.test.ts
git commit -m "feat(INV-1): create-only driftObservations store"
```

---

</details>

---

### Task 5: `reconcileAccount` records the drift before re-anchoring

**Files:**
- Modify: `src/context/UserProfileContext.tsx:347-360`
- Test: `src/__tests__/reconcile-persists-drift.test.ts`

**Interfaces:**
- Consumes: `reconcile` (Task 3); `recordAudit`, `auditEntry` from `src/lib/audit.ts` (shipped in #115)

**Revision 2:** persist through the existing audit log, not a new collection.

```ts
recordAudit(uid, auditEntry('account.reconcile', `accounts/${acc.id}`, {
  actor: 'user',
  after: observation,   // the DriftObservation from Task 3
}));
```

`recordAudit` never throws by design — a failed log entry must not lose the reconciliation
it observes. That is the same property INV-1 wants, so no extra error handling is needed.

Order matters: **write the observation first.** After `reanchor` is applied the two balances agree by construction and the evidence no longer exists.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/reconcile-persists-drift.test.ts`:

```ts
/**
 * The observation must be written BEFORE the anchor moves. Afterwards derived and
 * entered agree by construction and there is nothing left to record.
 */
import { reconcile } from '@/lib/accounts';
import { PaymentAccount } from '@/types';

const acc = { id: 'a', name: 'Chase', type: 'bank_account', provider: 'chase', color: '#000', isActive: true, openingBalance: 100, openingDate: '2026-01-01' } as PaymentAccount;

describe('reconcile ordering', () => {
  it('reports the pre-re-anchor drift alongside the re-anchor', () => {
    const { observation, reanchor } = reconcile(acc, 9235, 8770, '2026-08-08',
      { includePending: false, source: 'user' });
    expect(observation.driftCents).toBe(46500);
    expect(reanchor?.openingBalance).toBe(9235);
    // The observation describes the world BEFORE reanchor is applied.
    expect(observation.derivedCents).toBe(877000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npm test -- src/__tests__/reconcile-persists-drift.test.ts`
Expected: PASS (Task 3 already satisfies it). This test exists to pin the ordering contract against future edits — if it fails, Task 3 regressed.

- [ ] **Step 3: Wire the persistence**

In `src/context/UserProfileContext.tsx`, replace the `reconcile` call in `reconcileAccount`:

```ts
    const { driftCents, reanchor, observation } = reconcile(
      acc, enteredCurrent, derivedCurrent, today,
      { includePending: incomeContext.includePending ?? false, source: 'user' }
    );
    // Evidence first: once `reanchor` lands, entered and derived agree by
    // construction and the measurement is gone (INV-1). recordAudit never throws,
    // so a lost log entry can never cost us the reconciliation itself.
    if (user?.id) {
      await recordAudit(user.id, auditEntry('account.reconcile', `accounts/${acc.id}`, {
        actor: 'user',
        after: observation,
      }));
    }
```

Add `import { recordAudit, auditEntry } from '@/lib/audit';` at the top of the file.
Leave the existing `reanchor` application below unchanged.

- [ ] **Step 4: Run the reconcile suites**

Run: `npm test -- src/__tests__/reconcile-persists-drift.test.ts src/__tests__/accounts.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/context/UserProfileContext.tsx src/__tests__/reconcile-persists-drift.test.ts
git commit -m "feat(INV-1): persist the drift observation before re-anchoring"
```

---

### Task 6: Surface unanchored accounts in Accounts

**Files:**
- Modify: `src/app/accounts/page.tsx` (row ~line 653; totals ~lines 380-390)
- Test: `src/__tests__/unanchored-surfacing.test.tsx`

**Interfaces:**
- Consumes: `isUnanchored` (Task 2)
- Produces: `earliestRowDate(accountId, transactions): string | undefined` exported from `src/lib/accounts.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/unanchored-surfacing.test.tsx`:

```tsx
/**
 * The recurring bug family: never print an unbacked value as a measured one.
 * An unanchored account's balance is net movement, not a bank balance — the
 * number is still shown, but it never claims to be something it is not.
 */
import { earliestRowDate } from '@/lib/accounts';
import { Transaction } from '@/types';

const txns = [
  { id: 't1', accountId: 'a', date: '2026-04-02', amount: 1, type: 'expense' },
  { id: 't2', accountId: 'a', date: '2026-03-14', amount: 1, type: 'expense' },
  { id: 't3', accountId: 'b', date: '2026-01-01', amount: 1, type: 'expense' },
] as unknown as Transaction[];

describe('earliestRowDate', () => {
  it('finds the account\'s own earliest row', () => {
    expect(earliestRowDate('a', txns)).toBe('2026-03-14');
  });

  it('is undefined when the account has no rows', () => {
    expect(earliestRowDate('zzz', txns)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/unanchored-surfacing.test.tsx`
Expected: FAIL — `earliestRowDate is not a function`.

- [ ] **Step 3: Implement the helper**

Add to `src/lib/accounts.ts`:

```ts
/** The earliest transaction date on an account, for the "net since …" caption. */
export function earliestRowDate(
  accountId: string,
  transactions: readonly { accountId?: string; date: string }[]
): string | undefined {
  let earliest: string | undefined;
  for (const t of transactions) {
    if (t.accountId !== accountId) continue;
    const day = t.date.slice(0, 10);
    if (!earliest || day < earliest) earliest = day;
  }
  return earliest;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/__tests__/unanchored-surfacing.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 5: Render the per-row caption**

In `src/app/accounts/page.tsx`, at the block around line 653 that renders `as of {account.openingDate…}`, add the alternative branch:

```tsx
{account.openingDate ? (
  <span className="text-xs text-[var(--foreground-muted)] font-normal">
    as of {account.openingDate.slice(0, 10)}
  </span>
) : (
  <span className="text-xs text-[var(--foreground-muted)] font-normal">
    {earliestRowDate(account.id, transactions)
      ? `net since ${earliestRowDate(account.id, transactions)} · no starting balance set`
      : 'no starting balance set'}
  </span>
)}
```

Import `earliestRowDate` and `isUnanchored` from `@/lib/accounts`.

- [ ] **Step 6: Extract the shared note component, then use it**

**Revision 2:** the same block is needed on three screens, so it is a component, not
three copies. Create `src/components/UnanchoredNote.tsx`:

```tsx
import { PaymentAccount } from '@/types';
import { isUnanchored } from '@/lib/accounts';

/**
 * Disclosure for totals that contain an account nobody ever anchored. Its balance is
 * net movement over the rows we hold, not a bank balance — so a total containing one
 * must not read as measured. Renders nothing when every account is anchored.
 */
export function UnanchoredNote({ accounts }: { accounts: readonly PaymentAccount[] }) {
  const n = accounts.filter(isUnanchored).length;
  if (n === 0) return null;
  return (
    <p className="text-xs text-[var(--foreground-muted)] mt-1">
      includes {n} unanchored account{n === 1 ? '' : 's'}
    </p>
  );
}
```

Then near the totals at lines 380-390, after the existing cash/debt figures:

```tsx
<UnanchoredNote accounts={derivedAccounts} />
```

- [ ] **Step 7: Verify in the real app**

Run: `rm -rf .next && NEXT_PUBLIC_OBS_LEVEL=off npx next dev -p 3111`
Visit `http://localhost:3111/dev/accounts-fixture`. Expected: anchored fixture accounts show `as of …`; an account with `openingDate` removed shows the `net since …` caption and the totals note appears.

- [ ] **Step 8: Commit**

```bash
git add src/lib/accounts.ts src/app/accounts/page.tsx src/__tests__/unanchored-surfacing.test.tsx
git commit -m "feat(#83): surface unanchored accounts in Accounts rows and totals"
```

---

### Task 7: Surface it on Dashboard and Forecast

**Files:**
- Modify: `src/app/dashboard/page.tsx` (~line 100)
- Modify: `src/app/forecast/page.tsx` (~line 141)
- Test: `src/__tests__/cross-surface-consistency.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/cross-surface-consistency.test.ts`:

```ts
import * as fs from 'node:fs';

describe('unanchored disclosure is not one screen only (#83)', () => {
  it.each(['src/app/accounts/page.tsx', 'src/app/dashboard/page.tsx', 'src/app/forecast/page.tsx'])(
    '%s discloses unanchored accounts',
    (path) => {
      expect(fs.readFileSync(path, 'utf8')).toContain('isUnanchored');
    }
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/cross-surface-consistency.test.ts -t "unanchored disclosure"`
Expected: FAIL for `dashboard/page.tsx` and `forecast/page.tsx`.

- [ ] **Step 3: Add the note to both screens**

**Revision 2:** reuse the component from Task 6 — do not re-inline the markup.

In each file, `import { UnanchoredNote } from '@/components/UnanchoredNote';` and render
it beneath the cash / starting-cash figure:

```tsx
<UnanchoredNote accounts={derivedAccounts} />
```

On Forecast the accounts variable is the memo at line 141; on Dashboard it is
`derivedAccounts` at line 94.

The Step 1 test greps for `isUnanchored`; since the screens now import `UnanchoredNote`
instead, update that test to grep for `UnanchoredNote` on the two screens and
`isUnanchored` on `src/components/UnanchoredNote.tsx`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/__tests__/cross-surface-consistency.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/page.tsx src/app/forecast/page.tsx src/__tests__/cross-surface-consistency.test.ts
git commit -m "feat(#83): disclose unanchored accounts on Dashboard and Forecast"
```

---

### Task 8: AI context names unanchored accounts

**Files:**
- Modify: `src/lib/forecast.ts:816` (`prepareFullContextForAI`)
- Test: `src/__tests__/ai-context.test.ts`

The AI must never assert an exact spendable figure while an account has no anchor.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/ai-context.test.ts`:

```ts
describe('AI context discloses unanchored accounts (#83)', () => {
  it('names them so the model cannot claim an exact spendable figure', () => {
    const ctx = prepareFullContextForAI({
      ...baseContext,
      accounts: [
        { id: 'a', name: 'Chase Checking', type: 'bank_account', provider: 'chase', color: '#000', isActive: true, openingBalance: 0 },
      ],
    } as AIUserContext);
    expect(ctx).toContain('Chase Checking');
    expect(ctx.toLowerCase()).toContain('no starting balance');
  });
});
```

Use whatever `baseContext` fixture the file already defines; if there is none, build the minimal `AIUserContext` the existing tests in that file use.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/ai-context.test.ts -t "unanchored"`
Expected: FAIL — the string is absent.

- [ ] **Step 3: Implement**

In `prepareFullContextForAI`, before the closing return, append:

```ts
  const unanchored = context.accounts.filter(isUnanchored);
  if (unanchored.length > 0) {
    lines.push(
      `DATA CAVEAT: ${unanchored.length} account(s) have no starting balance set — ` +
      `${unanchored.map((a) => a.name).join(', ')}. Their balances are net movement over ` +
      `the imported history, NOT bank balances. Do not state an exact spendable figure ` +
      `without naming this caveat.`
    );
  }
```

Use the file's existing accumulator name if it is not `lines`. Import `isUnanchored` from `./accounts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/__tests__/ai-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/forecast.ts src/__tests__/ai-context.test.ts
git commit -m "feat(#83): AI context discloses unanchored accounts"
```

---

### Task 9: migration — SUPERSEDED BY #117, DO NOT IMPLEMENT

`scripts/fix_opening_anchor.py` shipped on main and has **not** been applied. Owner
decision pending: one account (Amazon Store Card, $0 anchored 2026-08-08, 204 rows,
+$10,458.03), held because stored data cannot distinguish "typed 0" from "left blank".
Tasks 2/6/7 are what make that answerable. Original text below for provenance only.

#### Task 9 (original): `scripts/reanchor.py` migration

**Files:**
- Create: `scripts/reanchor.py`
- Test: manual dry run against live data

Modelled on `scripts/restore_reviews.py`: **dry run by default, `--apply` required to write.**

⚠️ **Correction to spec §2.5.** The spec describes a hybrid — auto re-anchor where a provider
balance exists, prompt where it does not. **No provider balance is stored on `PaymentAccount`**;
sync consumes it by writing the anchor. So the script has nothing to re-anchor *from*, and it
does one thing: **clear the bad `openingDate`** so the account becomes unanchored and the full
history counts. Re-anchoring then happens through the existing reconcile sheet, where the owner
confirms a real balance — which also writes the `DriftObservation` (Task 5) and keeps
FIN-SETTLEMENT-003 intact, since nothing auto-applies. Simpler, and correct.

- [ ] **Step 1: Write the script**

Create `scripts/reanchor.py`:

```python
"""Clear anchors that hide an account's own history (#83).

Dry run by default. --apply writes.

ONE action: delete the bogus openingDate. The account becomes unanchored, its
whole history counts, and the UI asks for a real starting balance. There is no
auto-re-anchor branch because NO provider balance is stored on the account —
sync consumes it by writing the anchor, so there is nothing to re-anchor from.
The owner re-anchors through the reconcile sheet, which records the drift.

Existing dry run (scripts/opening-anchor-plan.local.json) found ONE affected
account: Amazon Store Card, 204 rows / net -10458.03 hidden.
"""
import argparse
import datetime as dt
import json

import fsadmin  # same admin/token plumbing every other script uses


def hidden_rows(db, uid: str, account: dict) -> tuple[int, float]:
    """Rows excluded purely because they predate openingDate."""
    opening = account.get("openingDate") or ""
    if not opening:
        return 0, 0.0
    rows = db.collection(f"users/{uid}/transactions").where("accountId", "==", account["id"]).stream()
    count, net = 0, 0.0
    for r in rows:
        d = r.to_dict()
        if (d.get("date") or "")[:10] < opening:
            count += 1
            net += d["amount"] if d.get("type") == "income" else -d["amount"]
    return count, round(net, 2)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    ap.add_argument("--uid", required=True)
    args = ap.parse_args()

    db = fsadmin.client()
    today = dt.date.today().isoformat()
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    plan = []

    for snap in db.collection(f"users/{args.uid}/accounts").stream():
        acc = {**snap.to_dict(), "id": snap.id}
        count, net = hidden_rows(db, args.uid, acc)
        if count == 0:
            continue
        plan.append({
            "id": acc["id"], "name": acc.get("name"), "type": acc.get("type"),
            "openingDate": acc.get("openingDate"), "hiddenRows": count, "hiddenNet": net,
        })

    print(json.dumps(plan, indent=1))
    print(f"\n{len(plan)} account(s) affected. {'APPLYING' if args.apply else 'DRY RUN — no writes'}")
    if not args.apply:
        return

    for row in plan:
        ref = db.document(f"users/{args.uid}/accounts/{row['id']}")
        # Record WHAT WAS HIDDEN before removing the anchor — this is the only
        # moment the concealed history is measurable (INV-1 evidence).
        db.collection(f"users/{args.uid}/driftObservations").add({
            "accountId": row["id"], "at": now,
            "enteredCents": 0, "derivedCents": round(row["hiddenNet"] * 100),
            "driftCents": -round(row["hiddenNet"] * 100),
            "includePending": False, "anchored": False, "source": "sync",
        })
        ref.update({"openingDate": fsadmin.DELETE_FIELD})
        print(f"  unanchored: {row['name']} (+{row['hiddenRows']} rows now counted)")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Dry run**

Run: `python3 scripts/reanchor.py --uid <owner-uid>`
Expected: a JSON plan naming **Amazon Store Card** with `hiddenRows: 204`, and `DRY RUN — no writes`. If more than one account appears, stop and report — the earlier dry run found exactly one.

- [ ] **Step 3: Verify `fsadmin` exposes what the script needs**

Run: `python3 -c "import sys; sys.path.insert(0,'scripts'); import fsadmin; print(hasattr(fsadmin,'client'), hasattr(fsadmin,'DELETE_FIELD'))"`
Expected: `True True`. If either is False, add the missing helper to `scripts/fsadmin.py` rather than inlining credentials here.

- [ ] **Step 4: Commit the script (do not run --apply yet)**

```bash
git add scripts/reanchor.py
git commit -m "feat(#83): dry-run-default re-anchor migration script"
```

- [ ] **Step 5: Apply — requires explicit owner approval**

**STOP. This writes to live financial data.** Only after the owner has read the dry-run output:

Run: `python3 scripts/reanchor.py --uid <owner-uid> --apply`

Then confirm in the app that Amazon Store Card's balance moved and that Accounts, Dashboard and Forecast all show the same figure.

---

## Final verification

- [ ] Run the full suite: `npm test`
- [ ] Typecheck: `npx tsc --noEmit`
- [ ] Lint: `npm run lint`
- [ ] Rules tests: `npm run test:rules`
- [ ] Confirm `#83`'s original symptom is gone: import a CSV for a new account and check the balance reflects the imported history, not `$0.00`.
