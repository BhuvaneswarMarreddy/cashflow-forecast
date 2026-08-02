# FIN-RELATION-001 — Transaction relations, allocations and review candidates

**Status:** Specification only. Nothing under `src/`, `functions/`, `functions-sync/` or any
config file is modified by this task.

**Branch:** `docs/fin-recovery-specs`, worktree `../cashflow-forecast-recovery-specs`,
baseline `2aaf4e5` (tag `INTEGRATION_BASELINE_AFTER_LEDGER_AND_CI`) on
`feat/transfer-type-monarch-ingest`. `main` is stale and is never used.

**Position in the programme:** FIN-RELATION-001 **merges FIRST**. FIN-REFUND-001 and
FIN-DUPLICATE-001 may then run in parallel *only because their file ownership is disjoint*
(§14). FIN-RECOVERY-UI-001 is last and is the sole owner of `src/app/flow/page.tsx`.

All sample data in this document is invented: `demo-purchase-a`, "Demo Amazon Lens",
`$1,100.00`. No real balance, merchant, account number, provider id, token or key appears
here, and none may appear in any test fixture this task produces.

---

## 1. Purpose

Two persistent models, one owner, one merge:

1. **`TransactionLink`** — an auditable, integer-cent statement that transaction *A* does
   something to transaction *B*: this credit refunds that purchase; this bank debit settles
   that card statement; this charge duplicates that one.
2. **`ReviewCandidate`** — a deterministic, *unapplied* proposal produced by application
   code, carrying a stable identity so that a decision the owner has already made can never
   be asked again.

Nothing else in the Refunds / Returns / Duplicates programme persists a relationship.
FIN-REFUND-001 and FIN-DUPLICATE-001 are *generators* that emit `ReviewCandidate`s and
*consumers* that read confirmed `TransactionLink`s. FIN-RECOVERY-UI-001 renders both. None
of the three defines a second link model, a second candidate model, a second parser or a
second telemetry system.

### 1.1 This task IS FIN-REVIEW-002's "FIN-SETTLEMENT-003"

`docs/features/FIN-REVIEW-002.md:526-585` (§8) specifies a link *interface* it needs and
assigns the model to a task called FIN-SETTLEMENT-003, which has no branch and no worktree.
FIN-RELATION-001 is that task, renamed. §4.6 below reconciles the two field lists
name-by-name so FIN-REVIEW-002 can import this model unchanged rather than stub a
"temporary" one — which `FIN-REVIEW-002.md:583-585` correctly calls out as a permanent
second link model.

### 1.2 What this task is *not*

- Not a refund matcher (FIN-REFUND-001).
- Not a duplicate detector (FIN-DUPLICATE-001).
- Not a UI (FIN-RECOVERY-UI-001).
- Not a classifier. `interpretTransaction()` (`src/lib/classify.ts:206`) remains the one
  ledger-level interpretation. FIN-RELATION-001 adds no `LedgerMeaning` member and changes
  no existing classification.
- Not an income authority. Whether any inflow is *earned income* is FIN-INCOME-001's, and
  the link model deliberately has no field that could express it.

---

## 2. Money representation — integer cents, no exceptions

Already the house rule: `src/lib/flows.ts:1-3` — "Everything here is integer CENTS —
dollars exist only at the render layer" — with `toCents()` at `src/lib/flows.ts:8` and
`formatMoneyCents()` at `src/lib/money.ts:15`.

- Every amount on a `TransactionLink` or a `ReviewCandidate` is a `number` holding integer
  cents. `Number.isInteger(v)` is asserted at every write and every parse.
- `Transaction.amount` stays dollars (`src/types/index.ts:295`, unchanged). Conversion
  happens at the boundary through `toCents()`, never by hand and never with `parseFloat`.
- No float arithmetic anywhere in allocation logic. `4120`, never `41.2`; `41.20 * 100`
  is a defect (it is `4119.999999999999`).
- Multi-currency is **out of scope**. Single currency, integer cents. A link between two
  transactions of different currencies is rejected as unvalidatable rather than silently
  summed. (Deferred — §15.)

---

## 3. The link model

### 3.1 Shape

```ts
// src/lib/relations.ts — owned exclusively by FIN-RELATION-001.
export type LinkType =
  | 'refund_of'             // credit reverses a specific purchase, in full
  | 'partial_refund_of'     // credit reverses part of a specific purchase
  | 'reversal_of'           // merchant/processor voided its own charge
  | 'chargeback_for'        // disputed charge; outcome not final
  | 'card_payment_pair'     // bank debit settles a card statement credit
  | 'reimbursement_for'     // inbound share against a shared/reimbursable expense
  | 'repayment_of'          // inbound against money previously lent
  | 'duplicate_candidate'   // two real posted charges for one economic event
  | 'subscription_overlap'; // two live subscriptions to one service family

export type LinkStatus =
  | 'suggested'    // system proposed it; affects no displayed number
  | 'confirmed'    // the owner accepted it; the only status that changes money
  | 'rejected'     // the owner refused it; suppresses regeneration
  | 'superseded'   // replaced by a later link over the same pair
  | 'provisional'; // real but not final — dispute credits only

export interface TransactionLink {
  id: string;                     // deterministic, = Firestore doc id (§3.3)
  linkType: LinkType;
  sourceTransactionId: string;    // the row that ACTS (the credit, the debit, the later charge)
  targetTransactionId: string;    // the row acted UPON (the purchase, the statement, the earlier charge)
  allocatedAmountCents: number;   // INTEGER CENTS, strictly > 0
  status: LinkStatus;
  algorithmVersion: string;       // the generator version that first proposed it (§8)
  candidateId?: string;           // the ReviewCandidate this came from, for audit
  confirmedAt?: string;           // ISO-8601, present iff status is confirmed | provisional
  confirmedBy?: 'user' | 'system';// 'system' ONLY for card_payment_pair (§3.5)
  supersededByLinkId?: string;
  note?: string;                  // the owner's own words, ≤ 280 chars
  createdAt: string;              // ISO-8601
  updatedAt: string;              // ISO-8601
}
```

No other fields. No `amount` in dollars, no `merchant`, no `description`, no copy of any
provider payload. A link points at rows; it never re-states them.

### 3.2 Direction convention — load-bearing

`sourceTransactionId` is **the row that acts**; `targetTransactionId` is **the row acted
upon**. This matches `FIN-REVIEW-002.md:540` ("`refund_of` // credit ← original purchase")
so the two specs agree without translation.

| linkType | source | target |
|---|---|---|
| `refund_of`, `partial_refund_of` | the credit | the purchase |
| `reversal_of` | the reversing credit | the voided charge |
| `chargeback_for` | the dispute credit | the disputed charge |
| `card_payment_pair` | the bank-account debit leg | the card-account credit leg |
| `reimbursement_for` | the inbound reimbursement | the shared/reimbursable expense |
| `repayment_of` | the inbound repayment | the outbound loan |
| `duplicate_candidate` | the **later**-dated charge | the earlier charge |
| `subscription_overlap` | the **later**-starting series' representative charge | the earlier series' representative charge |

The last two are symmetric relations forced into an ordered pair so the identity in §3.3 is
unique. Tie on identical dates → the lexicographically **greater** transaction id is the
source. Deterministic, order-independent, and testable (test R7).

### 3.3 Deterministic link id — idempotency for free

```
linkId = `${linkType}~${sourceTransactionId}~${targetTransactionId}`
```

- Composed, never hashed. A hash buys nothing here and costs collision risk on money.
- Re-proposing the same relation writes to the same document — an upsert, not a duplicate.
  This is the whole of "idempotent duplicate links" (test R8): there is no dedupe pass
  because there is nothing to dedupe.
- Firestore document-id constraints: no `/`, not `.` or `..`, and not matching `__.*__`.
  `~` satisfies all three and appears in no transaction id this app produces — Firestore
  auto-ids are `[A-Za-z0-9]{20}`, and `functions-sync/simplefin.py` writes `sf_<id>` and
  `pending_<id>`. The builder **throws** if either id contains `~`; it never silently
  produces an ambiguous id and it never falls back to a hash.
- Length: `linkType` ≤ 20 + two ids ≤ 128 each + 2 separators < 300 bytes, well inside
  Firestore's 1500-byte limit.

### 3.4 Validation — every rule, and what happens when it fails

Enforced in **three** places, all reading the same predicate module: the pure validator in
`src/lib/relations.ts`, the store before a write (`src/lib/relations-store.ts`), and
`firestore.rules` (§6). Client-side validation is authoritative for what gets written;
rules are the boundary that survives a hand-rolled request.

| # | Rule | Failure mode |
|---|---|---|
| V1 | `Number.isInteger(allocatedAmountCents) && allocatedAmountCents > 0` | reject. Floats, `0`, negatives, `NaN`, `Infinity` all rejected. A `$0.00` fee-reversal row cannot be *allocated* even though it can be *stored* (`firestore.rules:125-127`). |
| V2 | `sourceTransactionId !== targetTransactionId` | reject — self-link. |
| V3 | both ids resolve in the caller's current ledger | reject. A link whose partner later disappears is not deleted: the survivor is flagged (§3.7). |
| V4 | **Refund-side total.** Σ `allocatedAmountCents` of all `confirmed` links whose *source* is this credit, over `refund_of \| partial_refund_of \| reversal_of \| chargeback_for`, ≤ `toCents(credit.amount)` | reject, **unless** the caller passes the explicit conflict state `over_allocated_credit`, which stores the link and marks the credit for review. Never silently clamped. |
| V5 | **Purchase-side total.** Σ `allocatedAmountCents` of all `confirmed` links whose *target* is this purchase ≤ `toCents(purchase.amount)` | reject, **unless** the explicit state `over_refunded` is set (FIN-REFUND-001 §6 owns the resulting status). Never silently clamped. |
| V6 | under-allocation is **allowed** | a $1,100.00 purchase with a $900.00 confirmed refund is valid and normal. Nothing pads it to full. |
| V7 | `status` ∈ the closed set; transitions per §3.6 | reject. |
| V8 | `confirmedAt` present iff `status ∈ {confirmed, provisional}` | reject. |
| V9 | a `rejected` link is **never deleted** | it is the suppression record. Deleting it makes the same suggestion return. |
| V10 | currencies of both rows match | reject (single-currency scope, §2). |

**V4/V5 are computed over `confirmed` links only.** A `suggested` link contributes to no
total, which is the mechanical form of "nothing applies before confirmation": the
arithmetic literally cannot see an unconfirmed proposal.

### 3.5 `confirmedBy: 'system'` — exactly one permitted case

`card_payment_pair` may be written `confirmed` by the system when `matchTransfers()`
(`src/lib/transfers.ts:56`) has already paired the two legs *and* `interpretTransaction()`
returns `transfer: 'card_settlement'` for both (`src/lib/classify.ts:271`). This records a
fact the deterministic code already computes; it changes no number, because card-payment
detection is already correct and tested (`src/__tests__/ledger-classification.test.ts:50-135`)
and this task does not respecify it.

Every other link type requires `confirmedBy: 'user'`. There is no confidence threshold at
which the system confirms a refund, a duplicate or a chargeback.

### 3.6 Status transitions

```
suggested  → confirmed | rejected | provisional
provisional→ confirmed | rejected          (the dispute resolves)
confirmed  → superseded | rejected         (the owner changes their mind)
rejected   → suggested                     (ONLY by explicit owner re-open)
superseded → (terminal)
```

- A generator may create `suggested` and may create `provisional`. It may **never** write
  `confirmed`, except §3.5.
- `superseded` requires `supersededByLinkId` to point at an existing link over the same
  ordered pair. Superseding is how an allocation is *adjusted*: the old link is preserved
  for audit rather than mutated in place, so "what did I confirm, and when" stays
  answerable.
- A version bump never changes a status (§8).

### 3.7 A link whose partner vanishes

If `targetTransactionId` or `sourceTransactionId` no longer resolves (row deleted, or a
`pending_` row replaced by its posted twin under a different id — `src/types/index.ts:310-315`):

1. The link is **not** deleted.
2. The surviving row is surfaced with reason `link_partner_missing`, which maps onto
   FIN-REVIEW-002's `needs_attention` state (`FIN-REVIEW-002.md:90`) exactly as its L7 test
   requires (`FIN-REVIEW-002.md:1056`).
3. Before flagging, the store attempts **one** re-attach by `Transaction.fingerprint`
   (`src/types/index.ts:324`), which is the field that exists precisely so a re-imported row
   under a new provider id can be recognised. A successful re-attach writes a new link id
   and marks the old one `superseded`.

Re-attach is by fingerprint only. It never guesses by amount+merchant, because
`src/lib/fingerprint.ts:26-29` already states why the sign is load-bearing: "a $50 refund
and a $50 charge are the same |amount| on the same card in the same week, and merging them
erases a real expense."

---

## 4. The review-candidate model

### 4.1 Shape

```ts
// src/lib/candidates.ts — owned exclusively by FIN-RELATION-001.
export type CandidateType =
  | 'refund_match'
  | 'combined_refund_match'
  | 'partial_refund_match'
  | 'unknown_card_credit'
  | 'immediate_duplicate_charge'
  | 'duplicate_subscription'
  | 'subscription_overlap'
  | 'continued_charge_after_cancellation';

export type CandidateStatus =
  | 'unreviewed'              // generated, never looked at
  | 'suggested'               // the UI or an AI turn surfaced a specific proposal
  | 'confirmed'               // the owner accepted it; links were written
  | 'dismissed'               // the owner refused it; never regenerate
  | 'intentional'             // real, deliberate, and not a problem (two accounts on purpose)
  | 'needs_more_information'; // the owner cannot decide yet; stays in the queue, ranked last

export interface ReviewCandidate {
  id: string;                   // = identityKey, the Firestore doc id (§4.2)
  candidateId: string;          // type + version + ids — the audit form (§4.2)
  candidateType: CandidateType;
  algorithmVersion: string;
  transactionIds: string[];     // SORTED ascending, 2..13 entries
  status: CandidateStatus;
  proposedLinks: ProposedLink[];// ≤ 12; never written to the link collection until confirmed
  evidence: CandidateEvidence;  // structured, safe, no raw text (§4.4)
  score: number;                // 0..1, an explainable ladder — never a model output
  generatedAt: string;          // ISO-8601
  reviewedAt?: string;
  reviewedBy?: 'user';
  linkIds?: string[];           // written on confirmation, for undo and audit
}

export interface ProposedLink {
  linkType: LinkType;
  sourceTransactionId: string;
  targetTransactionId: string;
  allocatedAmountCents: number; // integer, > 0
}
```

### 4.2 Deterministic identity — and the version trap

The brief for this programme requires candidate ids "derived from candidate type + SORTED
transaction ids + algorithm version, so a dismissed candidate cannot resurface." Taken
literally as a single string, those two clauses **contradict each other**: if the version is
part of the document id, then bumping `refund-match-v1` → `v2` mints a new id, the dismissal
lives on the old id, and every dismissed candidate resurfaces on the next release. That is
the exact failure the requirement exists to prevent.

Resolved with a two-part identity, both derived, neither optional:

```
identityKey (doc id) = `${candidateType}~${sortedTransactionIds.join('~')}`
candidateId (field)  = `${candidateType}~${algorithmVersion}~${sortedTransactionIds.join('~')}`
```

- **`identityKey` is the document id.** It omits the version, so a decision is attached to
  *the relationship between these rows*, which is what the owner actually decided about.
  A dismissal is permanent across every future algorithm version.
- **`candidateId` is stored in the document** and is what telemetry logs and what an audit
  reads. It answers "which generator version produced this instance".
- Same `~` separator, same throw-on-`~`-in-an-id guard, same no-hash rule as §3.3.
- `transactionIds` sorted ascending **before** joining, so the same set of rows in any
  discovery order produces the same id (test C1).
- Length bound: 13 ids × ≤128 chars + separators < 1800 bytes. **Cap `transactionIds` at
  13** (12 candidate purchases + 1 credit, §5 of FIN-REFUND-001) and assert it; that keeps
  the id inside Firestore's 1500-byte limit for the id shapes this app actually produces
  (`sf_<id>`, `pending_<id>`, 20-char auto-ids: 13 × 24 + 13 ≈ 325 bytes).

### 4.3 Suppression — the one rule that makes the queue trustworthy

Before emitting anything, a generator **reads the existing candidate documents for the
window** and drops any candidate whose stored `status` is terminal:

```
terminal = confirmed | dismissed | intentional
```

`unreviewed`, `suggested` and `needs_more_information` are re-emitted (and may be updated
in place). Terminal candidates are never rewritten, never re-scored, and never re-ranked.

Consequences that must hold (tests C3–C6):

- Dismissing a candidate suppresses it forever, including across an algorithm version bump.
- Marking a duplicate `intentional` suppresses it forever, and the underlying transactions
  stay ordinary, fully-counted expenses — "intentional" is a statement about the *alert*,
  not about the money.
- A confirmed candidate is not re-proposed, but its links remain live and its confirmation
  timestamp is preserved.

### 4.4 Evidence — structured, safe, no raw text

```ts
export interface CandidateEvidence {
  amountsCents: number[];          // the amounts involved, integer cents
  dayGaps: number[];               // whole days between the rows
  sameAccount: boolean;
  accountTypes: AccountType[];     // 'credit_card' | 'bank_account' | … NEVER account names/ids-as-labels
  merchantMatch: 'exact' | 'family' | 'alias' | 'none';
  referenceOverlap: 'strong' | 'weak' | 'none';
  cadence?: RecurringItem['cadence'];
  overlappingPeriods?: number;
  pendingInvolved: boolean;
  reasonCodes: string[];           // stable ids, e.g. 'exact_amount', 'different_account'
}
```

No merchant strings, no titles, no descriptions, no account names, no `lastFourDigits`. The
UI renders merchant text by looking the transaction up locally; the candidate document never
carries it. That is what makes the whole collection safe to log a *count* of and safe to
show in a diagnostics bundle.

### 4.5 Ranking and score

`score` is a hand-written explainable ladder in the style of `FIN-REVIEW-002.md:158-171`,
not a model output. Each generator (FIN-REFUND-001 §5, FIN-DUPLICATE-001 §7) publishes its
own ladder; FIN-RELATION-001 only requires that:

- it is a pure function of `evidence`;
- it is deterministic — equal evidence gives an equal score, always;
- ties break by `generatedAt` ascending then `id` ascending, so list order never depends on
  Firestore's return order;
- it is displayed as words, never as a bare number (`FIN-REVIEW-002.md:168-170`).

### 4.6 Reconciliation with FIN-REVIEW-002 §8.1

`FIN-REVIEW-002.md:536-551` reproduces a five-member `linkType` union. Mapping, so neither
document needs a second model:

| `FIN-REVIEW-002.md:538-542` | FIN-RELATION-001 | Note |
|---|---|---|
| `refund_of` | `refund_of` / `partial_refund_of` | split so a partial is visible in the type, not only in the arithmetic |
| `reimbursement_of` | `reimbursement_for` | rename only |
| `repayment_of` | `repayment_of` | identical |
| `card_payment_of` | `card_payment_pair` | rename only |
| `internal_transfer_leg` | **not in the set** | see below |

**`internal_transfer_leg` is deliberately absent.** `matchTransfers()`
(`src/lib/transfers.ts:56`) pairs both legs live from the current transaction set and
`pairedLegId()` (`src/lib/transfers.ts:45`) already answers "what is the other leg of this
row" for the deletion guard. Storing that as a link would create a second, staler source of
truth for a fact that self-updates on every re-import (`src/lib/transfers.ts:11` — "Live
match: computed from the current transaction set, so it self-updates on re-import").
`FIN-REVIEW-002.md:629-637` (§9.3) already relies on the live pairer and explicitly says
confirming an internal transfer "makes an unmatched leg *become* a paired leg, which the
existing code then renders correctly with no new drawing logic" — so nothing there needs the
stored form.

Other field-level differences, all resolved in favour of this document, which FIN-REVIEW-002
should adopt verbatim:

- `status: 'proposed' | 'confirmed' | 'rejected'` → `suggested | confirmed | rejected |
  superseded | provisional`. `proposed` is renamed `suggested` to match the candidate
  vocabulary; `superseded` and `provisional` are additions FIN-REVIEW-002 has no reason to
  refuse.
- `userConfirmed: boolean` → dropped, replaced by `status === 'confirmed'` +
  `confirmedBy`. A boolean beside a status is two sources of truth for one fact.
- `expenseGroupId` / `counterpartyId` → **deferred** (§15). They belong to shared-expense
  work, which this programme does not touch. FIN-REVIEW-002 may add them additively later;
  nothing here forecloses it.
- `FIN-REVIEW-002.md:557-559` requires exactly one source → one target per record, integer
  cents, and Σ allocations on a target ≤ target cents, enforced at write time and
  unit-tested. §3.1, §3.4/V5 and test R11 satisfy all three.

---

## 5. Persistence

### 5.1 Collections

```
users/{uid}/links/{linkId}                     — TransactionLink  (§3)
users/{uid}/reviewCandidates/{identityKey}     — ReviewCandidate  (§4)
```

Both uid-scoped under the existing structure documented at `firestore.rules:7-12`. No
collection-group query, no top-level collection, no path that could escape the uid scope.

### 5.2 A new store module, not an edit to `src/lib/firestore.ts`

`src/lib/firestore.ts` is 1190 lines and is **owned by FIN-INCOME-001 for the duration of
this programme** (§14). FIN-RELATION-001 therefore adds `src/lib/relations-store.ts`, a new
module that:

- imports `db` from `src/lib/firebase.ts` (read-only dependency);
- follows the existing repository-span pattern —
  `startSpan(...)` with `repository`, `dataSource: 'Firestore'` and, in `metadata`, the
  collection path and filter **shape** only, exactly as
  `docs/observability/ADDING-A-TRACEABLE-FLOW.md:62-72` requires and as
  `src/lib/firestore.ts:388` already does (`metadata: { collection: 'users/{uid}/accounts' }`);
- never logs a document, a row, or a provider response.

This is a deliberate structural choice to keep ownership disjoint, not accidental
duplication. It is not a second data layer: it is two collections that did not exist before,
in their own file.

### 5.3 Writes are optimistic, matching the existing contract

`src/context/TransactionContext.tsx` already documents why: with offline persistence
enabled, awaiting the server ack hangs until the network comes back. Link and candidate
writes follow the same pattern — update local state, fire the write, `.catch` it. A failed
write surfaces as a visible error, never as a silent revert.

### 5.4 Raw transactions are never modified

FIN-RELATION-001 writes **zero** fields on `users/{uid}/transactions/{transactionId}`. Not
`category`, not `type`, not `merchant`, not `userEdited`. A relationship is stored beside a
transaction, never inside it. This is stronger than FIN-REVIEW-002's rule
(`FIN-REVIEW-002.md:967-971`, which permits hand-edited category writes) because a link is
never a hand edit.

Test R14 asserts the transaction document is byte-identical before and after a link is
created, confirmed, superseded and rejected.

---

## 6. Firestore rules

Added to `firestore.rules` inside the existing `match /users/{userId}` block, in the file's
existing style (`firestore.rules:144-163` is the closest precedent). `firestore.rules` is
owned by FIN-RELATION-001 for this programme; no other task in it writes that file.

```
// =========================================
// Transaction Links Subcollection (FIN-RELATION-001)
// =========================================
// An auditable statement that one transaction acts on another: a refund against a
// purchase, a bank debit against a card statement, a duplicate against its twin.
// Amounts are INTEGER CENTS. See src/lib/relations.ts.

match /links/{linkId} {
  allow read: if isOwner(userId);

  allow create: if isOwner(userId) &&
    request.resource.data.keys().hasAll([
      'linkType', 'sourceTransactionId', 'targetTransactionId',
      'allocatedAmountCents', 'status', 'algorithmVersion', 'createdAt', 'updatedAt'
    ]) &&
    request.resource.data.linkType in [
      'refund_of', 'partial_refund_of', 'reversal_of', 'chargeback_for',
      'card_payment_pair', 'reimbursement_for', 'repayment_of',
      'duplicate_candidate', 'subscription_overlap'
    ] &&
    request.resource.data.status in
      ['suggested', 'confirmed', 'rejected', 'superseded', 'provisional'] &&
    isValidString(request.resource.data.sourceTransactionId, 1, 128) &&
    isValidString(request.resource.data.targetTransactionId, 1, 128) &&
    // No self-link. The cheapest correctness rule in the file.
    request.resource.data.sourceTransactionId != request.resource.data.targetTransactionId &&
    // Integer cents, strictly positive. A float allocation is how a ledger drifts.
    request.resource.data.allocatedAmountCents is int &&
    request.resource.data.allocatedAmountCents > 0;

  // Update re-asserts every create-time invariant: an update path that only checks
  // ownership is a validator with a hole in it.
  allow update: if isOwner(userId) &&
    request.resource.data.linkType == resource.data.linkType &&
    request.resource.data.sourceTransactionId == resource.data.sourceTransactionId &&
    request.resource.data.targetTransactionId == resource.data.targetTransactionId &&
    request.resource.data.status in
      ['suggested', 'confirmed', 'rejected', 'superseded', 'provisional'] &&
    request.resource.data.allocatedAmountCents is int &&
    request.resource.data.allocatedAmountCents > 0;

  // A rejected link is the suppression record. Deleting it makes the suggestion return.
  allow delete: if false;
}

// =========================================
// Review Candidates Subcollection (FIN-RELATION-001)
// =========================================

match /reviewCandidates/{candidateId} {
  allow read: if isOwner(userId);

  allow create, update: if isOwner(userId) &&
    request.resource.data.keys().hasAll([
      'candidateId', 'candidateType', 'algorithmVersion',
      'transactionIds', 'status', 'score', 'generatedAt'
    ]) &&
    request.resource.data.candidateType in [
      'refund_match', 'combined_refund_match', 'partial_refund_match',
      'unknown_card_credit', 'immediate_duplicate_charge', 'duplicate_subscription',
      'subscription_overlap', 'continued_charge_after_cancellation'
    ] &&
    request.resource.data.status in [
      'unreviewed', 'suggested', 'confirmed', 'dismissed',
      'intentional', 'needs_more_information'
    ] &&
    request.resource.data.transactionIds is list &&
    request.resource.data.transactionIds.size() >= 2 &&
    request.resource.data.transactionIds.size() <= 13;

  allow delete: if false;
}
```

Notes:

- `allow delete: if false` on both. A decision is a record. Nothing in this programme
  deletes one — which is also the mechanical enforcement of "duplicate detection never
  deletes a transaction" one level up: there is no delete path to reach.
- The rules validate **shape and ownership**. They do not re-implement V4/V5 (cross-document
  sums are not expressible in rules without reads that cost money on every write); the
  store and the pure validator own those, and tests R11/R12 prove it.
- `is int` is the rules-language integer check and is the boundary enforcement of §2. A
  client that sends `41.2` is rejected by the database, not only by the client.
- The `__.*__` reserved-id pattern cannot be produced by §3.3/§4.2 because both ids begin
  with a lowercase letter.
- The existing deny-all at `firestore.rules:178-180` continues to cover everything else.

---

## 7. AI boundary — extend the existing parser, add nothing

### 7.1 One parser, one trust boundary

`src/lib/chat-actions.ts` is already the trust boundary and its design is correct
(`src/lib/chat-actions.ts:1-12`): unknown actions, unknown keys, invented categories and
empty match values are rejected outright rather than coerced, and a rejected payload is
`null` so the UI shows raw text instead of offering something nobody asked for.

**FIN-RELATION-001 owns `src/lib/chat-actions.ts` for this programme** and lands all
thirteen recovery actions in one pass. FIN-REFUND-001 and FIN-DUPLICATE-001 add **no**
parser code — that is precisely what makes them safe to run in parallel. There is no second
parser, no schema library, no `zod`, no `ajv`. The existing `record(v, allowed)`
(`src/lib/chat-actions.ts:92`) and `str(v, max)` (`src/lib/chat-actions.ts:99`) primitives
are reused verbatim.

`functions/src/prompts.ts` is likewise owned here, for the same reason: the allowed-action
list injected into `CHAT_SYSTEM_PROMPT` (`functions/src/prompts.ts:197`) must be one list.

### 7.2 What the AI may and may not do

**May:** explain a candidate in plain language; summarise a group; suggest which purchases a
combined refund covers *from the ids it was given*; ask **one** focused clarifying question
and return no proposal; propose a structured action.

**May not:**

- perform authoritative arithmetic. `src/lib/forecast.ts:1-7` already states the rule: the
  calculation modules are the source of truth and "AI only interprets these results — it
  never calculates". Every cent the UI shows is computed by `src/lib/relations.ts`,
  `src/lib/refunds.ts`, `src/lib/duplicates.ts` or `buildFlowGraph()`, never parsed out of a
  model reply;
- apply a link. There is no code path from a model response to a Firestore write;
- mark a card credit as income. No action in the union can set an income meaning, and the
  card-credit projection has no path to `earned_income` (FIN-REFUND-001 §3.3);
- delete a transaction. No action can, and no rule allows it;
- create a broad merchant rule silently. Rule creation stays FIN-REVIEW-002 §7's, gated on
  scope + affected-count preview;
- receive the full ledger. Context is built by the capped builder at
  `src/lib/chat-actions.ts:58` (`MAX` at `src/lib/chat-actions.ts:34`) and re-clipped
  server-side by `buildChatMessages()` (`functions/src/prompts.ts:227`);
- treat transaction descriptions as instructions. `functions/src/prompts.ts:213-214` already
  carries the clause; the closed-value parser is the actual enforcement.

There is **no public AI route**. SEC-001 deleted `src/app/api/ai/decision` and
`src/app/api/parse-receipt`, and `src/__tests__/no-public-ai-routes.test.ts` pins it. All AI
traffic goes through the authenticated `aiChat` callable (`functions/src/chat.ts:23-27`),
which rejects unauthenticated callers and applies `checkRateLimit(uid, 'aiChat',
LIMITS.aiChat)` (`functions/src/rate-limit.ts:12-16,49`). This task adds no route and no
second callable.

### 7.3 The thirteen actions

Added to the `ChatAction` union (`src/lib/chat-actions.ts:30-32`) as one discriminated
extension:

| Action | Payload keys (exhaustive) |
|---|---|
| `confirm_refund_allocation` | `candidateId`, `allocations[]`, `reason` |
| `adjust_refund_allocation` | `candidateId`, `allocations[]`, `reason` |
| `reject_refund_candidate` | `candidateId`, `reason` |
| `classify_card_credit` | `transactionId`, `cardCreditKind`, `reason` |
| `mark_reward_credit` | `transactionId`, `reason` |
| `mark_chargeback_credit` | `transactionId`, `targetTransactionId`, `allocatedAmountCents`, `reason` |
| `confirm_duplicate_charge` | `candidateId`, `reason` |
| `confirm_duplicate_subscription` | `candidateId`, `keepTransactionId`, `reason` |
| `mark_intentional_duplicate` | `candidateId`, `reason` |
| `mark_different_owner` | `candidateId`, `reason` |
| `mark_business_subscription` | `candidateId`, `reason` |
| `mark_subscription_cancelled` | `candidateId`, `effectiveDate`, `reason` |
| `dismiss_review_candidate` | `candidateId`, `reason` |

`allocations[]` entries have exactly `{ targetTransactionId, allocatedAmountCents }`.

`mark_business_subscription` and `mark_different_owner` are **labels on the candidate**, not
tax or ownership claims. They set `status: 'intentional'` with a distinguishing reason code.
Following `FIN-REVIEW-002.md:736-740`, a business label makes no claim of deductibility,
produces no tax category and adds no export column implying one, and the UI says so in
words.

### 7.4 Validation — all failures produce `null`, never a partial action

Reusing the existing rejection discipline. Each row is a red test in §11.4.

| # | Rejected | How |
|---|---|---|
| P1 | unknown `action` | switch over the closed set; anything else → `null` (the existing `if (o.action !== 'create_rule') return null` pattern at `src/lib/chat-actions.ts:160` generalised) |
| P2 | unknown keys at **any** depth | `record()` with an explicit `allowed` list per level. Never `Object.assign`, never a spread of raw input |
| P3 | `__proto__` / `constructor` / `prototype` as an own key at any depth | explicit check **in addition to** `record()`'s unknown-key rejection, so a later `allowed`-list edit cannot reopen it. Parse with `JSON.parse`; never merge raw input into an existing object |
| P4 | a `candidateId` that does not exist in the caller's loaded candidates | → `null`. Not a lookup, not a redirect |
| P5 | a `transactionId` / `targetTransactionId` not in the caller's current ledger | → `null` |
| P6 | a transaction id not part of the referenced candidate's `transactionIds` | → `null`. **This is the containment rule**: the model can only act on rows the application already chose for it |
| P7 | non-integer, zero, negative, `NaN` or `Infinity` `allocatedAmountCents` | `Number.isInteger(v) && v > 0` |
| P8 | Σ `allocations[].allocatedAmountCents` > the credit's cents | → `null` (V4). Rejected, never clamped |
| P9 | any single allocation > its target purchase's cents | → `null` (V5) |
| P10 | `allocations.length > 12`, or `transactionIds` implied > 13 | → `null`. **Rejected, not truncated** — truncating an allocation list silently changes what the owner is agreeing to |
| P11 | unsupported `cardCreditKind` | closed membership against FIN-REFUND-001's exported list |
| P12 | `reason` empty after clipping (`MAX.explanation`, `src/lib/chat-actions.ts:40`) | → `null`, mirroring the existing "a rule that changes nothing" guard at `src/lib/chat-actions.ts:138` |
| P13 | a candidate not owned by the signed-in user | unreachable by construction — candidates are loaded from `users/{uid}/…` — and asserted anyway |

**Nothing applies before confirmation.** A parsed action renders a confirmation card and
stops. This is the existing `RulePreviewCard` contract in `src/components/DataChatSheet.tsx`
(apply is gated on an explicit button press) and it is preserved exactly. There is no
"auto-apply high confidence" mode, no "apply all", and no setting that disables the gate.

---

## 8. Algorithm versioning

Four independent version strings, each owned by its generator:

| Version string | Owner | Governs |
|---|---|---|
| `refund-match-v1` | FIN-REFUND-001 | `refund_match`, `partial_refund_match` |
| `combined-refund-v1` | FIN-REFUND-001 | `combined_refund_match` |
| `duplicate-charge-v1` | FIN-DUPLICATE-001 | `immediate_duplicate_charge` |
| `duplicate-subscription-v1` | FIN-DUPLICATE-001 | `duplicate_subscription`, `subscription_overlap`, `continued_charge_after_cancellation` |

Rules FIN-RELATION-001 enforces for all four:

1. A version bump re-evaluates **only** candidates whose stored status is `unreviewed`.
   `suggested`, `confirmed`, `dismissed`, `intentional` and `needs_more_information` are
   left exactly as they are.
2. A version bump **never** reinterprets a confirmed decision, never re-scores it, never
   changes its links, and never changes its `algorithmVersion` field — that field records
   which generator produced the instance the owner actually saw.
3. Because the document id omits the version (§4.2), a bump cannot resurrect a dismissal.
4. A bump is a code change, so it is reviewable. No version string is ever computed at
   runtime, read from config, or derived from a date.
5. Existing `confirmed` links keep the `algorithmVersion` they were created under, which is
   how "which version produced this $200 allocation" stays answerable a year later.

---

## 9. Observability — reuse OBS-001, no second system

OBS-001 is **merged at this baseline** — `src/lib/obs/` exists on
`feat/transfer-type-monarch-ingest` (`events.ts`, `redact.ts`, `trace.ts`, `provenance.ts`,
`fixtures.ts`, `store.ts`, `sync-metadata.ts`). This is a change from
`FIN-REVIEW-002.md:869-876`, which was written when OBS-001 was unmerged: **the "instrument
in a follow-up" fallback does not apply to this programme.** Instrumentation ships with the
code.

Use `emit()` (`src/lib/obs/events.ts:154`) with the single `DiagEvent` shape
(`src/lib/obs/events.ts:13-40`), which has no free-text `message` field by design, and
`startSpan()` (`src/lib/obs/trace.ts:120`). Everything passes through the one redactor
(`src/lib/obs/redact.ts:79`) before it exists. Severity is gated and **off in production by
default** (`src/lib/obs/events.ts:58-63`).

### 9.1 Events owned by FIN-RELATION-001

`eventCategory: 'activity'`, `component: 'RecoveryRelations'`.

| Event | When | Safe properties |
|---|---|---|
| `Relation.LinkConfirmed` | a link reaches `confirmed` | `metadata.linkType`, `metadata.allocationCount`, `metadata.sameAccount`, `resultStatus` |
| `Relation.LinkSuperseded` | an allocation is adjusted | `metadata.linkType`, `metadata.previousStatus`, `resultStatus` |
| `Relation.LinkRejected` | a link reaches `rejected` | `metadata.linkType`, `metadata.rejectionRule`, `resultStatus` |
| `Relation.ValidationRejected` | V1–V10 or P1–P13 fires | `metadata.ruleId` (`'V4'`, `'P7'`, …), `resultStatus: 'error'` — the **reason code**, never the payload |
| `Relation.PartnerMissing` | §3.7 fires | `metadata.linkType`, `metadata.reattached` (bool), `resultStatus` |

The generator-side events (`Refund.*`, `DuplicateCharge.*`, `DuplicateSubscription.*`,
`DuplicateCandidate.*`, `CardCredit.Classified`) are owned by FIN-REFUND-001 and
FIN-DUPLICATE-001 and listed in their specs. One namespace, one emitter, no second system.

One span: `Relation.ConfirmCandidate` (layer: application service), wrapping validate +
persist links + update candidate. One event per span on `end()`.

### 9.2 Never logged

Full descriptions, merchant strings, transaction titles, account numbers, `lastFourDigits`,
account names, credentials, tokens, provider payloads, the full AI context, the owner's typed
message, the model's reply text, complete action payloads, complete transaction objects, or
any amount as a free value in metadata.

Transaction ids are logged only as `hashId()` output (`src/lib/obs/events.ts:73`), matching
how `userIdHash` is handled. Counts, enum values, reason codes, booleans, durations and
result statuses only. `redact()` masks `lastFourDigits` rather than destroying it
(`src/lib/obs/redact.ts:19-21`), and no new sensitive key is introduced by this task — if a
future field needs one, it goes in `SECRET_KEYS`/`MASK_KEYS`, never a local filter
(`docs/observability/ADDING-A-TRACEABLE-FLOW.md:88-94`).

---

## 10. Performance

No full-ledger O(n²) work on render. Concretely, for FIN-RELATION-001:

- **Link lookup is a Map, built once.** `Map<transactionId, TransactionLink[]>` keyed on
  both endpoints, built in one O(L) pass over links (L = link count, orders of magnitude
  smaller than n) inside a `useMemo`. Answering "is this row refunded?" is then O(1).
- **Allocation totals are memoized per transaction id**, invalidated only when the link
  array identity changes. V4/V5 read the memo, never the whole collection.
- **Candidate loading is windowed.** Candidates are fetched for the period on screen, not
  the whole history, and cached by period key.
- **No generator runs per render.** Generation is triggered by an explicit refresh, an
  ingest completion, or an on-demand button — never in a render path, never in an effect
  without a guard.
- **Decisions are cached.** The terminal-status set (§4.3) is loaded once per session into a
  `Set<identityKey>` so suppression is an O(1) check inside every generator's inner loop.
- Nothing here iterates the ledger inside another iteration over the ledger. Where a
  generator needs pairwise comparison, it does it inside a *bucket* (same account, same
  merchant family, same month), which is what makes the bound in FIN-REFUND-001 §5 and
  FIN-DUPLICATE-001 §7 hold.

---

## 11. Test matrix — failing tests first

Jest, `npm test`, alongside the 34 existing suites in `src/__tests__/`. Pure-module tests
mirror `src/__tests__/flows.test.ts` and `src/__tests__/ledger-classification.test.ts`;
fixture style follows `src/__tests__/ledger-classification.test.ts:27-45` (invented
accounts, a `txn()` helper, invented merchants). **Every fixture is invented. No production
value, provider id, account number or real description appears in any test.**

### 11.1 Link model — `src/__tests__/relations.test.ts` (16)

| # | Test |
|---|---|
| R1 | one-to-one: one credit fully refunds one purchase; one link; totals agree |
| R2 | one-to-many: one $1,200.00 credit allocates across two purchases ($1,100.00 + $100.00); two links; Σ = credit cents exactly |
| R3 | many-to-one: three credits allocate against one purchase; three links; Σ ≤ purchase cents |
| R4 | partial allocation: a $900.00 credit against a $1,100.00 purchase stores `partial_refund_of` with `allocatedAmountCents: 90000` and leaves $200.00 unrefunded |
| R5 | integer cents: an allocation of `41.2` is rejected; `4120` is accepted; no float ever reaches storage |
| R6 | `Number.isInteger` guards reject `NaN`, `Infinity`, `-1` and `0` |
| R7 | direction convention: `duplicate_candidate` always points later → earlier, and identical dates tie-break on the greater id — asserted on both discovery orders |
| R8 | duplicate-link idempotency: proposing the same relation twice yields **one** document with the same id, not two |
| R9 | self-link rejection: `source === target` is rejected for every one of the nine link types |
| R10 | id builder throws when a transaction id contains `~`, rather than emitting an ambiguous id |
| R11 | over-allocation on the **purchase** side (Σ confirmed > purchase cents) is rejected without an explicit `over_refunded` state, and accepted with it |
| R12 | over-allocation on the **credit** side (Σ confirmed > credit cents) is rejected without an explicit `over_allocated_credit` state, and accepted with it |
| R13 | under-allocation is allowed and produces no warning, no padding and no phantom link |
| R14 | **the raw transaction document is byte-identical** before and after create → confirm → supersede → reject |
| R15 | confirm / reject / supersede transitions: every legal transition succeeds, every illegal one is rejected, and `superseded` requires a resolvable `supersededByLinkId` |
| R16 | a `suggested` link contributes **zero** to every allocation total; only `confirmed` counts |

### 11.2 Candidate model — `src/__tests__/candidates.test.ts` (8)

| # | Test |
|---|---|
| C1 | deterministic id: the same transaction set in three different discovery orders yields one identical `identityKey` |
| C2 | `candidateId` carries the algorithm version while `identityKey` does not — asserted as distinct strings on the same document |
| C3 | **dismissed-candidate suppression**: a dismissed candidate is not re-emitted by a second generator run |
| C4 | **suppression survives a version bump**: bumping `refund-match-v1` → `v2` does not resurrect a dismissed candidate |
| C5 | a version bump re-evaluates `unreviewed` candidates and leaves `confirmed`, `dismissed`, `intentional` and `needs_more_information` untouched, including their `algorithmVersion` field |
| C6 | `intentional` suppresses the alert while the underlying transactions stay fully-counted expenses |
| C7 | `transactionIds` > 13 is rejected; exactly 13 is accepted; the resulting doc id is under Firestore's 1500-byte limit |
| C8 | `evidence` contains no merchant string, title, description, account name or `lastFourDigits` — asserted structurally over a fixture with hostile values in all of them |

### 11.3 Firestore rules — `src/__tests__/relations-rules.test.ts` (8)

Run against the Firestore emulator in the style the repo already uses for rules-adjacent
assertions; if no emulator harness exists at implementation time, this file is a precondition
(§14.4), not an excuse to skip the tests.

| # | Test |
|---|---|
| F1 | the owner may read and write links and candidates under their own uid |
| F2 | another signed-in user may not read or write them — create, read, update and list all denied |
| F3 | an unauthenticated request is denied |
| F4 | a create missing any required field is denied (asserted per field) |
| F5 | a create with an unknown `linkType`, unknown `status` or unknown `candidateType` is denied |
| F6 | `allocatedAmountCents` of `41.2`, `0` or `-100` is denied; `4120` is allowed |
| F7 | a self-link create is denied at the rules layer, not only in the client |
| F8 | **an update cannot bypass validation**: changing `linkType`, either endpoint, `status` to an unknown value, or `allocatedAmountCents` to a float is denied; and `delete` is denied outright |

### 11.4 Action parser — `src/__tests__/recovery-actions.test.ts` (13)

Extends `src/__tests__/chat-actions.test.ts` conventions; one test per rejection rule.

| # | Test |
|---|---|
| P1 | an unknown `action` → `null` |
| P2 | an unknown key at the top level **and** inside `allocations[]` → `null` |
| P3 | `__proto__`, `constructor` and `prototype` at any depth → `null`, and `Object.prototype` is unpolluted afterwards |
| P4 | an unknown `candidateId` → `null` |
| P5 | a `transactionId` not in the ledger → `null` |
| P6 | a transaction id in the ledger but **not in the referenced candidate** → `null` |
| P7 | a float, zero, negative, `NaN` or `Infinity` allocation → `null` |
| P8 | Σ allocations > the credit's cents → `null`, and the ledger is unchanged |
| P9 | one allocation > its target purchase's cents → `null` |
| P10 | `allocations.length` of 13 → `null` (**rejected, not truncated** — assert the returned value is `null`, not a 12-element list) |
| P11 | an unsupported `cardCreditKind` → `null` |
| P12 | an empty `reason` after clipping → `null` |
| P13 | a valid action parses, and **no write occurs** until an explicit confirm — asserted by a store spy with zero calls |

**FIN-RELATION-001 total: 45 specified tests.**

---

## 12. Privacy

- No production data is read, queried or accessed by this task, at specification time or at
  implementation time. There is no authenticated session and none is to be obtained.
- No test may mutate production or trigger a SimpleFIN sync
  (`docs/observability/ADDING-A-TRACEABLE-FLOW.md:110-120` already forbids both for
  Playwright; the same rule applies here).
- Candidate `evidence` is structured and text-free (§4.4), so the collection cannot become a
  shadow copy of the ledger.
- Events carry hashed ids, counts and enum values only (§9.2).
- Every fixture is invented, following `src/lib/obs/fixtures.ts`'s existing rule.

---

## 13. Cross-surface effect of this task alone

FIN-RELATION-001 changes **no displayed number**. It adds two collections, a validator, a
store, thirteen parser actions and a rules block. Every existing test must still pass
unchanged — in particular `src/__tests__/cross-surface-consistency.test.ts`, whose
hand-computed totals (`EXPECTED_EXPENSE_CENTS = 22920`, `EXPECTED_INCOME_CENTS = 330300`,
`src/__tests__/cross-surface-consistency.test.ts:68-69`) must be **byte-identical** after
this merge.

That is the acceptance criterion for merging first: a foundation that moves a number is not
a foundation.

---

## 14. Ready to implement when…

### 14.1 Preconditions

1. **FIN-INCOME-001 has merged**, or is on a branch this work can be based on, and exports
   the inflow-taxonomy type, its value list and its earned-income predicate from a known
   module path. FIN-RELATION-001 does not import the taxonomy itself, but FIN-REFUND-001
   (which merges next) does, and the parser's `cardCreditKind` membership check (P11) reads
   FIN-REFUND-001's list, which projects onto FIN-INCOME-001's.
2. **FIN-INCOME-001 has released `src/lib/firestore.ts`, `src/lib/classify.ts`,
   `src/types/index.ts`, `src/lib/forecast.ts` and `src/context/UserProfileContext.tsx`**, or
   has confirmed it will not touch the two files this task needs to read
   (`src/lib/classify.ts`, `src/types/index.ts`) in a conflicting way. This task writes none
   of them.
3. **A Firestore rules test harness exists** (emulator + a runner), or one is stood up as
   the first commit of this task. §11.3 is not optional: the rules block is a trust boundary
   and an untested trust boundary is a claim, not a control.
4. **The owner has confirmed the two-part candidate identity in §4.2** — specifically that
   the document id omits the algorithm version so a dismissal survives a version bump.
5. **The owner has confirmed the over-allocation policy in §3.4/V4–V5** — reject by default,
   store only under an explicit named conflict state, never silently clamp.
6. **The owner has confirmed `internal_transfer_leg` stays out of the link set** (§4.6) and
   that FIN-REVIEW-002 will adopt this model's names when it is implemented.
7. **The 45 tests in §11 are written first and are red**, per the repo's TDD practice.
8. **A worktree exists** for the implementation branch, isolated from the owner's integration
   working directory and from `../cashflow-forecast-fin-income-001`.

### 14.2 File ownership — FIN-RELATION-001 owns these exclusively

| File | New? |
|---|---|
| `src/lib/relations.ts` | new — link model, validator, id builders |
| `src/lib/candidates.ts` | new — candidate model, identity, suppression |
| `src/lib/relations-store.ts` | new — Firestore access for both collections |
| `src/lib/chat-actions.ts` | **existing, exclusive for this programme** — all 13 actions land here in one pass |
| `functions/src/prompts.ts` | **existing, exclusive for this programme** — one allowed-action list |
| `firestore.rules` | **existing, exclusive for this programme** |
| `src/__tests__/relations.test.ts` | new |
| `src/__tests__/candidates.test.ts` | new |
| `src/__tests__/relations-rules.test.ts` | new |
| `src/__tests__/recovery-actions.test.ts` | new |

### 14.3 Overlap warnings

- **FIN-INCOME-001 (running now, `../cashflow-forecast-fin-income-001`)** owns
  `src/types/index.ts`, `src/lib/classify.ts`, `src/lib/forecast.ts`, `src/lib/firestore.ts`,
  `src/context/UserProfileContext.tsx` and the inflow taxonomy. FIN-RELATION-001 **reads**
  those files and **writes none of them**. Its worktree is read-only to this task. The link
  and candidate types live in new modules precisely so no line of `src/types/index.ts` is
  contended.
- **`src/lib/chat-actions.ts` and `functions/src/prompts.ts` are the collision risk of the
  whole programme.** Both FIN-REFUND-001 and FIN-DUPLICATE-001 need actions in them. That is
  why FIN-RELATION-001 lands all thirteen in one pass and why it merges first: after it, the
  parser is closed and the other two tasks touch neither file.
- **`firestore.rules`** — same reasoning. One task, one pass, no contention.
- **FIN-REVIEW-002** (specified, unimplemented) expects a link interface at
  `users/{uid}/links/{linkId}`. §4.6 is the reconciliation; when FIN-REVIEW-002 is
  implemented it imports this model. If both are implemented concurrently, FIN-REVIEW-002
  must not write `src/lib/relations.ts`.
- **`src/lib/flows.ts`** — FIN-RELATION-001 does not touch it. FIN-DUPLICATE-001 needs one
  additive `export` there (its §12.3); that is the only write into `flows.ts` in the
  programme.
- **`src/app/flow/page.tsx`** — FIN-RECOVERY-UI-001 is its sole owner. FIN-RELATION-001 adds
  no UI.

### 14.4 Deferred — explicitly not in FIN-RELATION-001

- Multi-currency links and cross-currency allocation.
- `expenseGroupId` / `counterpartyId` and shared-expense groups (`FIN-REVIEW-002.md:546-547`).
  Additive later; nothing here forecloses them.
- Receivable lifecycle, settlement closure, netting order, unequal group splits.
- Bulk confirmation ("confirm all 12 of these"). One at a time.
- Automatic confirmation at any confidence, for any link type except the single
  system-confirmed `card_payment_pair` of §3.5.
- A machine-learned scorer. §4.5's ladder is hand-written and explainable, deliberately.
- Retroactive re-generation over the entire ledger on every ingest. Generation is windowed
  and on-demand (§10).
- Undo beyond a single step. FIN-RECOVERY-UI-001 §8 owns what undo exists.
