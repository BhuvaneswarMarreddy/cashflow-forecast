# Balance correctness — #83 anchor fix + INV-1 drift evidence

**Status:** approved 2026-08-08
**Issues:** #83 (P0), INV-1 (new)
**Out of scope:** transaction-specific category override (separate issue, and it is gated on
durable decision re-attachment #111b landing first).

---

## 1. Problem

`deriveAccountBalance` (`src/lib/forecast.ts:117`) skips every row dated before
`openingDate`, on the grounds that those rows are already inside `openingBalance`:

```ts
const openingKey = account.openingDate || '0000-00-00';
…
if (day < openingKey) return sum;   // pre-anchor = already inside openingBalance
```

That is correct **only when a human actually made the claim**. An anchor is an assertion:
"as of THIS date, the balance was THIS."

`openingAnchor()` (`src/lib/accounts.ts:37`) already encodes the right semantics — a blank
balance field asserts nothing, so it returns `{ openingBalance: 0 }` with **no `openingDate`**,
`openingKey` falls back to `'0000-00-00'`, and the whole history counts. It is wired at four
of five account-creation sites:

| Site | Uses `openingAnchor()` |
|---|---|
| `src/app/accounts/page.tsx:251` | ✔ |
| `src/app/onboarding/page.tsx:258` | ✔ |
| `src/app/onboarding/page.tsx:392` | ✔ |
| `src/app/onboarding/page.tsx:447` | ✔ |
| **`src/components/CSVImportModal.tsx:41`** | **✘ — hardcodes `{ openingBalance: 0, openingDate: today }`** |

That pair asserts "this account held $0.00 today", and then excludes the entire history the
import just created the account from.

### Live evidence

`scripts/opening-anchor-plan.local.json` (dry run, 2026-08-08):

```json
[{ "id": "bubv211Aeva9zVq34Rh5", "name": "Amazon Store Card", "type": "credit_card",
   "openingDate": "2026-08-08", "hiddenRows": 204, "hiddenNet": -10458.029999999997 }]
```

**One account affected. 204 rows excluded, net −$10,458.03.** The migration is therefore
small and verifiable by hand.

### Second problem: the drift is discarded

`reconcile()` (`src/lib/accounts.ts:64`) computes the only independent accuracy measurement
in the system and throws it away:

```ts
const driftCents = Math.round((enteredCurrent - derivedCurrent) * 100);
if (driftCents === 0) return { driftCents: 0 };
return { driftCents, reanchor: { openingBalance: enteredCurrent, openingDate: todayISO } };
```

`PaymentAccount` stores no provider balance — sync consumes it by *writing* the anchor — so
after a re-anchor, derived and provider agree by construction. The moment inside `reconcile()`
is the only point at which the two numbers are independent.

---

## 2. Design

### 2.1 Route the last call site through `openingAnchor()`

`CSVImportModal.tsx:41` stops constructing the anchor inline and calls `openingAnchor('', today)`
— an auto-created account asserts nothing, so it receives `{ openingBalance: 0 }` and no
`openingDate`.

No change to `openingAnchor`, `deriveAccountBalance`, or any other creation site.

### 2.2 "Unanchored" is `openingDate === undefined`

No new field, no new flag, no migration of the account schema. The state already exists in the
data model; it has never been surfaced.

```ts
// src/lib/accounts.ts
/** True when nobody has ever asserted a starting balance for this account. */
export const isUnanchored = (a: PaymentAccount): boolean => !a.openingDate;
```

Semantics: an unanchored account's derived balance is **net movement across the rows we hold**,
not a bank balance. It is a real number and it is shown — it simply never claims to be
something it is not.

### 2.3 Surface it wherever a total could look authoritative

This is the recurring bug family (#68, #77): *never print an unbacked value as a measured one.*

| Surface | Behaviour |
|---|---|
| Accounts, per row | Below the balance: `net since {earliest row date} · no starting balance set`, plus a **Set balance** action opening the existing reconcile sheet |
| Accounts, totals | `calculateCurrentCash` / `netWorthOf` render a note: `includes N unanchored account(s)` |
| Dashboard | Same note wherever cash or net worth appears |
| Forecast | Same note on the starting-cash figure |
| AI context | `prepareFullContextForAI` includes the unanchored account names so the model never asserts an exact spendable figure without the caveat |

The number is never suppressed and never replaced with `null` — an unanchored account has a
defensible value, unlike a runway with no burn. The claim is what gets corrected, not the math.

**Earliest row date** is the minimum `date` among the account's transactions; when the account
has no transactions the note reads `no starting balance set` alone.

### 2.4 INV-1 — persist the drift instead of discarding it

`reconcile()` gains a third return member and the caller persists it.

```ts
export interface DriftObservation {
  accountId: string;
  at: string;              // ISO, when the observation was made
  enteredCents: number;    // the balance the human or provider asserted
  derivedCents: number;    // deriveAccountBalance at that moment
  driftCents: number;      // entered − derived, integer cents
  includePending: boolean; // the policy in force when derived was computed
  providerCheckedAt?: string;  // meta/<source>.lastSuccess at observation time
  anchored: boolean;       // false when openingDate was absent
  source: 'user' | 'sync';
}
```

Stored at `users/{uid}/driftObservations/{autoId}`.

**Definition.** For an anchored account, `driftCents` **must** be `0`; a non-zero value is a
reconciliation violation and is recorded and surfaced. Tolerance is **exact integer cents** —
the existing code already rounds to cents specifically to avoid float drift, so there is no
epsilon to choose.

| Condition | Result |
|---|---|
| `anchored === false` | **NOT_APPLICABLE.** Never `PASS`. An unanchored account has no claim to violate |
| `driftCents === 0` | `PASS` |
| `driftCents !== 0`, provider data fresh | `VIOLATION` — record and surface |
| `driftCents !== 0`, `providerCheckedAt` older than the last scheduled run that should have succeeded | `STALE_INPUT` — record, do **not** surface as a violation |
| Debt accounts | No special case. Both sides are on the `currentOf` scale, which already handles the debt sign inside `deriveAccountBalance` |
| Pending | `includePending` is recorded with the observation. A drift measured under one policy is not comparable to one measured under the other |

**Staleness threshold is derived, not configured:** an observation is `STALE_INPUT` when
`providerCheckedAt` predates the most recent scheduled sync slot (07:00 / 13:00 / 19:00 CT)
that has already passed. This avoids a fixed 6h/12h rule, which would mark every account stale
each morning because the overnight gap is itself 12 hours.

Firestore rules: `driftObservations` is **create-only** (`allow create: if isOwner(userId);
allow update, delete: if false`) — an accuracy record that can be edited is not evidence.

⚠️ **`driftObservations` is NOT added to `USER_SUBCOLLECTIONS`.** That array drives
`deleteAllUserData` (`firestore.ts:1089`); the observation history is deleted by a separate
explicit line in that function so the omission is deliberate and visible rather than a bug.

### 2.5 Re-anchor migration

`scripts/reanchor.py`, following `scripts/restore_reviews.py` conventions: **dry run by
default**, `--apply` required to write, per-account before/after report.

**Corrected during planning.** An earlier draft of this section described a hybrid — auto
re-anchor where a provider balance exists, prompt where it does not. **`PaymentAccount` stores
no provider balance**; sync consumes it by writing the anchor. The script therefore has nothing
to re-anchor *from* and does exactly one thing:

| Action | Result |
|---|---|
| Clear the bogus `openingDate` | The account becomes unanchored, its full history counts, and the UI asks for a real starting balance |

Re-anchoring then happens through the **existing reconcile sheet**, where the owner confirms a
real balance — which writes the `DriftObservation` (§2.4) and keeps FIN-SETTLEMENT-003 intact,
because nothing auto-applies. Simpler than the hybrid, and correct.

The script records what was hidden **before** removing the anchor, because that is the only
moment the concealed history is measurable.

Expected scope from the existing dry run: **one account** (Amazon Store Card, 204 hidden rows).
The script reports per-account row counts and net change; it does not predict a final balance,
because the debt sign convention makes that worth reading from the report rather than asserting
here.

---

## 3. Testing

New tests:

| Test | Asserts |
|---|---|
| `csv-import-anchor.test.ts` | An account auto-created by CSV import has **no** `openingDate`; a full history import derives the full net |
| `unanchored-surfacing.test.tsx` | An unanchored account renders the note; totals containing one render the count; an anchored account renders neither |
| `drift-observation.test.ts` | Every row of the table in §2.4 — including `NOT_APPLICABLE` for unanchored and `STALE_INPUT` against a pre-slot `providerCheckedAt` |
| `reanchor-script.test.ts` | Dry run writes nothing; `--apply` records the observation **before** moving the anchor |

Existing tests that must stay green: `opening-anchor.test.ts`, `derive-balance.test.ts`,
`csv-import.test.ts`, `accounts.test.ts`, `cross-surface-consistency.test.ts`,
`one-spending-definition.test.ts`, `pending-cross-surface.test.ts`, `policy-wiring.test.ts`.

**Probe before believing any screen-level finding** — write a throwaway
`src/__tests__/zz-probe.test.ts` calling the library directly. One fixture previously produced
three false findings in a single session.

---

## 4. Files that change

| File | Change |
|---|---|
| `src/components/CSVImportModal.tsx` | Call `openingAnchor()` instead of building the anchor inline |
| `src/lib/accounts.ts` | Add `isUnanchored()`; extend `reconcile()` to return a `DriftObservation` |
| `src/types/index.ts` | Add the `DriftObservation` interface |
| `src/lib/firestore.ts` | Add the `driftObservations` writer; add the explicit delete line in `deleteAllUserData` |
| `src/context/UserProfileContext.tsx` | `reconcileAccount` persists the observation |
| `firestore.rules` | `driftObservations` create-only |
| `src/app/accounts/page.tsx`, `dashboard/page.tsx`, `forecast/page.tsx` | Surface the unanchored note |
| `src/lib/forecast.ts` | `prepareFullContextForAI` includes unanchored account names |
| `scripts/reanchor.py` | New; dry-run default |

---

## 5. Explicitly not in this spec

- Asking for a balance during CSV import. The correctness fix does not need it, and adding a
  required step to an import the user may not be able to answer is a separate product decision.
- Storing a `providerBalance` field on `PaymentAccount`. The drift observation captures the
  comparison at the only moment it is meaningful; a stored field would go stale and become a
  second source of truth for a number that already has one.
- Any category, rule, chat or audit work.
