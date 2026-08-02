# FIN-REFUND-001 — Card credits, refund matching and net economic cost

**Status:** Specification only. Nothing under `src/`, `functions/`, `functions-sync/` or any
config file is modified by this task.

**Branch:** `docs/fin-recovery-specs`, worktree `../cashflow-forecast-recovery-specs`,
baseline `2aaf4e5` on `feat/transfer-type-monarch-ingest`. `main` is stale and is never used.

**Position in the programme:** **FIN-RELATION-001 merges FIRST.** FIN-REFUND-001 and
FIN-DUPLICATE-001 may then run **in parallel ONLY because their file ownership is disjoint**
(§12). FIN-RECOVERY-UI-001 is last and is the sole owner of `src/app/flow/page.tsx`.

All sample data is invented: "Demo Amazon Lens", "Demo Amazon Filter", `demo-card-9021`,
`$1,100.00`. No real balance, merchant, provider id, account number or description appears
here or in any fixture this task produces.

---

## 1. Purpose

Answer two questions the app currently gets wrong or cannot answer at all:

1. **What is this credit on my credit card?** Today the answer is a pair of regexes.
   `isRefund()` (`src/lib/classify.ts:127`) matches `/refund|reimburse|reversal/i` and
   `isReward()` (`src/lib/classify.ts:114`) matches
   `/reward|cashback|cash back|redemption|redeem|points|statement credit|bonus/i`, both over
   `title + merchant + sourceCategory`. The `ponytail:` comment at
   `src/lib/classify.ts:122-125` names the gap outright: "a refund Monarch files under the
   original spend category with no 'refund' word still reads as income — upgrade needs a
   same-merchant-prior-expense match if that proves common." It does prove common.
2. **What did this purchase actually cost me?** Nowhere in the app. `story.refunds`
   (`src/app/flow/page.tsx:431`) nets refunds out of *aggregate* spending, which is right at
   the top level and useless at the row level: it cannot say that a $1,100.00 purchase came
   back in full, or that $200.00 of it did not.

**The owner's rule, encoded:** a credit-card credit is **never** automatically earned income.
A refund **reverses economic cost** — it is not income; it increases cash on a bank account
and reduces liability on a card; both the original purchase and the refund remain in history;
the two are linked with an explicit allocation.

### 1.1 What this task does not do

- Does **not** respecify card-payment detection. `isCardSettlement()`
  (`src/lib/classify.ts:72`) is correct and tested for **both** the card leg and the bank leg
  (`src/__tests__/ledger-classification.test.ts:50-135`), including the headline defect where
  a purchase at a merchant named "PAYMENT PROCESSING SOLUTIONS LLC" was read as a settlement.
  FIN-REFUND-001 *consumes* that result as step 1 of its ladder and changes none of it.
- Does **not** define what counts as earned income. That is FIN-INCOME-001's, and this task
  imports its taxonomy rather than forking it (§3.3).
- Does **not** own the link or candidate model. That is FIN-RELATION-001's (§2).
- Does **not** touch `src/lib/classify.ts`, `src/types/index.ts` or `src/lib/forecast.ts` —
  all owned by FIN-INCOME-001 while it runs.

---

## 2. Dependencies it consumes, does not redefine

| From | What | Where |
|---|---|---|
| FIN-LEDGER-001 (merged) | `interpretTransaction()` → `{ type, direction, meaning, income, expense, transfer, pending, forecast, budget, confidence, reason }` | `src/lib/classify.ts:206` |
| FIN-LEDGER-001 (merged) | `meaning ∈ 'spending' \| 'income_candidate' \| 'internal_transfer' \| 'card_payment' \| 'refund' \| 'reward'` | `src/lib/classify.ts:175-181` |
| FIN-LEDGER-001 (merged) | `isCardSettlement()` via `classifyTransaction()`; `transfer: 'card_settlement'` | `src/lib/classify.ts:72`, `:271` |
| FIN-LEDGER-001 (merged) | `isRefund()`, `isReward()` — **signals**, not verdicts | `src/lib/classify.ts:127`, `:114` |
| FIN-LEDGER-001 (merged) | `isPosted()` / `postedOnly()` | `src/lib/classify.ts:281`, `:284` |
| existing | `matchTransfers()` — both legs of a settlement | `src/lib/transfers.ts:56` |
| existing | `toCents()`, `day()`, `normalizeMerchant()` | `src/lib/flows.ts:8`, `:9`, `:374` |
| existing | dual-source dedupe fingerprint | `src/lib/fingerprint.ts:46` |
| FIN-RELATION-001 | `TransactionLink`, `ReviewCandidate`, validators, store, parser | `src/lib/relations.ts`, `src/lib/candidates.ts` |
| FIN-INCOME-001 | the inflow taxonomy type + value list + earned-income predicate | its module, imported |
| OBS-001 (merged) | `emit()`, `startSpan()`, `redact()`, `hashId()` | `src/lib/obs/` |

### 2.1 The technical duplicate layer is below this work

`src/lib/fingerprint.ts:46-51` computes `${accountId}|${signedCents}|${yyyy-MM-dd}` and
`findTwin()` (`src/lib/fingerprint.ts:65`) collapses the same charge arriving from the bank
feed and from a Monarch CSV. That is the **technical** duplicate layer: one real-world event,
two ingestion sightings.

It is mirrored byte-for-byte in Python by `functions-sync/simplefin.py:138`
(`signed_cents_of`), whose docstring says so explicitly. **Neither may be changed
independently.** A change to one without the other silently splits or merges rows on the next
sync. FIN-REFUND-001 changes neither, and its sign convention (a refund is a positive on a
card, `centsOf()` at `src/lib/fingerprint.ts:30`) is the reason a $50 refund and a $50 charge
on the same card in the same week are never merged — the comment at
`src/lib/fingerprint.ts:26-29` states the cost of getting that wrong.

---

## 3. Card-credit classification

### 3.1 The ten kinds

```ts
// src/lib/card-credit.ts — owned exclusively by FIN-REFUND-001.
export type CardCreditKind =
  | 'card_payment'          // debt settlement — the purchases are the expenses
  | 'merchant_refund'       // a merchant returned the full charge
  | 'partial_refund'        // a merchant returned part of a charge
  | 'statement_credit'      // issuer credit against the balance (annual-fee credits, perks)
  | 'cashback_reward'       // earned on the card, redeemed to the balance
  | 'promotional_credit'    // issuer promo / sign-up credit
  | 'charge_reversal'       // the merchant or processor voided its own charge
  | 'chargeback_credit'     // disputed; PROVISIONAL until the dispute resolves
  | 'manual_adjustment'     // the owner entered or corrected it by hand
  | 'unknown_card_credit';  // the honest default
```

### 3.2 Evaluation order — load-bearing, do not permute

Mirroring the comment that opens `src/lib/classify.ts:1-5` ("Rule order is load-bearing …
do not reorder without a failing test"). `classifyCardCredit(t, ctx)` runs the ladder and
returns `{ kind, confidence, reason, evidence }`. First rung that holds wins.

| # | Rung | Evidence required | Kind |
|---|---|---|---|
| 1 | **confirmed card-payment pair** | `interpretTransaction(t, accounts).transfer === 'card_settlement'` (`src/lib/classify.ts:271`), **or** `matchTransfers()` paired this row (`src/lib/transfers.ts:56`), **or** a `confirmed` `card_payment_pair` link exists | `card_payment` |
| 2 | **confirmed merchant refund** | a `confirmed` `refund_of` or `partial_refund_of` link whose *source* is this row | `merchant_refund` / `partial_refund` |
| 3 | **confirmed reversal** | a `confirmed` `reversal_of` link | `charge_reversal` |
| 4 | **confirmed chargeback** | a `confirmed` **or** `provisional` `chargeback_for` link | `chargeback_credit` |
| 5 | **cashback / reward / statement credit** | `isReward(t)` (`src/lib/classify.ts:114`) is true, sub-split by §3.4 | `statement_credit` / `cashback_reward` / `promotional_credit` |
| 6 | **manual adjustment** | the row's `sources` (`src/types/index.ts:325`) contain no provider path, or `userEdited.amount === true` (`src/types/index.ts:326`) | `manual_adjustment` |
| 7 | **fallthrough** | nothing above held | `unknown_card_credit` |

Two properties this ordering buys, both tested:

- **Card-payment pairing takes precedence over refund matching** (test D7). A $300.00 card
  credit titled "AUTOPAY PAYMENT - THANK YOU" that happens to equal a $300.00 purchase from
  last week is a settlement, not a refund. Rung 1 fires before rung 2 ever looks.
- **Rungs 2–4 require a *confirmed* link.** An unconfirmed refund suggestion therefore cannot
  change a row's classification, which is the mechanical form of "nothing applies before
  confirmation": the ladder cannot see a `suggested` link.

`unknown_card_credit` is also a `ReviewCandidate` type (FIN-RELATION-001 §4.1), so an
unexplained credit surfaces in the queue rather than sitting silently in a total.

### 3.3 Extending FIN-INCOME-001's taxonomy — never forking it

FIN-INCOME-001 owns the **inflow taxonomy**: `earned_income`, `internal_transfer`, `refund`,
`shared_expense_reimbursement`, `receivable_repayment`, `sale_proceeds`,
`gift_or_personal_transfer`, `other_non_income_credit`, `unknown_inflow`.

`CardCreditKind` is **not a competing enum**. It is a strictly narrower dimension that
**projects onto** FIN-INCOME-001's taxonomy through one exported total function:

```ts
// src/lib/card-credit.ts — the type and the values are IMPORTED from FIN-INCOME-001.
import type { InflowMeaning } from '<FIN-INCOME-001 module>';

export const CARD_CREDIT_TO_INFLOW_MEANING: Record<CardCreditKind, InflowMeaning> = {
  card_payment:         'internal_transfer',
  merchant_refund:      'refund',
  partial_refund:       'refund',
  charge_reversal:      'refund',
  chargeback_credit:    'refund',                    // provisional; see §6.3
  statement_credit:     'other_non_income_credit',
  cashback_reward:      'other_non_income_credit',
  promotional_credit:   'other_non_income_credit',
  manual_adjustment:    'other_non_income_credit',
  unknown_card_credit:  'unknown_inflow',
};
```

Three consequences, all asserted:

1. **`earned_income` is not in the range of this map.** "A credit-card credit is NEVER
   automatically earned income" stops being a policy sentence and becomes a property of a
   total function, provable by enumerating the map (test D1). There is no branch to forget.
2. **FIN-REFUND-001 declares no inflow-taxonomy value of its own.** No local `as const`
   array, no local string union "just for the parser", no re-typed copy. It imports the type
   and the list. This is the same discipline `FIN-REVIEW-002.md:200-210` states, and the
   locations where a duplicate would otherwise appear are catalogued at
   `FIN-REVIEW-002.md:227-236`.
3. **The earned-income question is answered in exactly one place** — FIN-INCOME-001's
   predicate, applied to the projected value. FIN-REFUND-001 never answers it.

`CardCreditKind` also never contradicts FIN-LEDGER-001's `LedgerMeaning`
(`src/lib/classify.ts:175-181`), which stays the authoritative ledger-level interpretation
and is not modified. Invariant, tested (D2):

| `interpretTransaction().meaning` | permitted `CardCreditKind` |
|---|---|
| `card_payment` | `card_payment` |
| `reward` | `statement_credit`, `cashback_reward`, `promotional_credit` |
| `refund` | `merchant_refund`, `partial_refund`, `charge_reversal`, `chargeback_credit` |
| `income_candidate` | any of the ten (this is the ambiguous case the ladder exists to resolve) |
| `spending`, `internal_transfer` | not a card credit; `classifyCardCredit` is not called |

### 3.4 Sub-splitting rung 5 without touching `isReward()`

`isReward()` (`src/lib/classify.ts:114`) stays exactly as it is and remains the gate. The
sub-split runs **only when it is already true**, so the split can never widen or narrow what
the app currently treats as a reward:

- text contains `statement credit` → `statement_credit`
- else text contains `promo`, `promotional`, `welcome`, `intro` → `promotional_credit`
- else → `cashback_reward` (the `reward|cashback|cash back|redemption|redeem|points|bonus`
  remainder of `src/lib/classify.ts:113`)

Same haystack as `isReward()`: `title + merchant + sourceCategory`. Test D3 asserts the
partition is total over `isReward()`-true inputs and empty over `isReward()`-false ones.

---

## 4. Refund candidate generation

### 4.1 Which rows are candidate *credits*

A row is a refund-credit candidate when **all** hold:

1. `isPosted(t)` (`src/lib/classify.ts:281`) — a pending hold is never a finalized refund
   (§4.5, test M12);
2. `interpretTransaction(t, accounts).direction === 'inflow'` (`src/lib/classify.ts:267`);
3. `classifyCardCredit()` returns a kind in `{ merchant_refund, partial_refund,
   charge_reversal, unknown_card_credit }`, **or** the row sits on a non-debt account and
   `isRefund(t)` is true (`src/lib/classify.ts:127` — the bank-side refund path that
   `buildFlowGraph()` already routes to the `refunds` node, `src/lib/flows.ts:226-228`);
4. it is not already the *source* of a `confirmed` link.

Rung 1 and rung 5 credits are excluded: a settlement and a cashback credit are not refunds
of anything and must not generate a match.

### 4.2 The candidate window

For a credit dated `D` on account `A`:

- **Purchases considered:** posted outflows dated in `[D − 180 days, D + 5 days]`.
  180 days covers a long return window and a slow merchant; the +5 covers posting-order
  inversion, where the credit lands before the charge finishes settling.
- **Merchant scope:** same `normalizeMerchant()` value (`src/lib/flows.ts:374`) — which
  strips `#…`/`*…` suffixes and trailing digit runs but keeps "650 INDUSTRIES" — **or** the
  same service family (FIN-DUPLICATE-001 §5, imported read-only; if FIN-DUPLICATE-001 has
  not merged, exact-normalized-merchant only, and the combined matcher is correspondingly
  narrower).
- **Account scope:** same `accountId` first. A different account of the same owner is
  allowed but scores lower (§4.4, test M13) — a refund on a different card than the purchase
  is real (merchant refunds to a replaced card) but it is genuinely weaker evidence.
- **Hard cap:** the top **12** purchases by score. This is `MAX_CANDIDATE_PURCHASES` and is
  what makes §5's bound hold.

### 4.3 The three match shapes

| Candidate type | Shape | Link(s) proposed |
|---|---|---|
| `refund_match` | credit cents **exactly equal** one purchase's cents | one `refund_of` |
| `partial_refund_match` | credit cents **<** one purchase's cents | one `partial_refund_of` |
| `combined_refund_match` | credit cents equal the **sum** of 2..4 purchases' cents (§5) | one `refund_of` per purchase, allocations summing exactly to the credit |

A credit **greater** than every candidate purchase and than every reachable combination
generates `unknown_card_credit`, not a forced over-allocation.

Multiple partial refunds against one purchase accumulate through V5 (FIN-RELATION-001
§3.4): three confirmed `partial_refund_of` links against one purchase are legal as long as
their sum stays ≤ the purchase (test M9).

### 4.4 Scoring ladder — explainable, deterministic, not a model output

```
1.00  exact cents on the same account, same normalized merchant, ≤ 30 days apart
0.85  exact cents, same account, same merchant family, ≤ 90 days
0.70  exact cents, same account, same merchant family, ≤ 180 days
0.60  exact combined-sum match (§5), same account, same merchant family
0.50  partial: credit < purchase, same account, same merchant, ≤ 90 days
0.40  any of the above on a DIFFERENT account          (the −0.2 different-account penalty)
0.30  merchant family matched by alias only, not by normalized equality
```

`REFUND_AUTOCONFIRM_THRESHOLD` does not exist. **No score auto-confirms anything.** The
ladder ranks the queue and phrases the reason; the owner confirms. A tie breaks by fewest
purchases, then closest date, then transaction id ascending — deterministic list order, which
is what makes the tests reproducible.

**Ambiguity rule (test M11):** if two or more candidates score within `0.05` of each other
for the same credit, all of them are emitted with `status: 'unreviewed'` and an
`ambiguous_match` reason code, and **none** is presented as the answer. The UI shows them as
alternatives (FIN-RECOVERY-UI-001 §4.2). Nothing auto-confirms, ever, at any score.

### 4.5 Pending, replacements and idempotency

- A **pending credit** (`Transaction.pending`, `src/types/index.ts:315`) is not a finalized
  refund. It may be *shown* with a `Pending` label but it generates no candidate, writes no
  link and reduces no cost. `interpretTransaction()` already excludes holds from every total
  (`src/lib/classify.ts:259-263`) and says so in its `reason` string.
- When the hold is replaced by its posted row — `functions-sync/simplefin.py` writes holds
  under a `pending_` doc id and deletes them the moment the charge posts, often at a
  different amount (`src/types/index.ts:310-315`) — the **posted** row generates the
  candidate, exactly once (test M14).
- Re-running the generator over the same window produces byte-identical candidate ids
  (FIN-RELATION-001 §4.2), so nothing duplicates and nothing dismissed returns.

---

## 5. Combined refund matching — bounded subset-sum in integer cents

### 5.1 The problem

A single credit settles several purchases at once. The sanitized anchor: purchase A "Demo
Amazon Lens" `110000` cents plus purchase B "Demo Amazon Filter" `10000` cents come back as
one credit "Demo Amazon Refund" `120000` cents. Neither purchase matches the credit; their
sum does. Without combined matching the credit is `unknown_card_credit` forever and neither
purchase is ever marked returned.

### 5.2 The algorithm

```
Input:  targetCents        (the credit, a positive integer)
        purchases[]        (≤ MAX_CANDIDATE_PURCHASES = 12, positive integer cents, §4.2)
Output: ≤ MAX_COMBINATIONS = 5 subsets, ranked

1. Drop any purchase with cents > targetCents.        (all amounts positive → it can never fit)
2. Sort remaining purchases by cents DESCENDING.
3. Depth-first walk with two prunes and one cap:
     - prune: runningSum + thisPurchase > targetCents        → skip the branch
     - prune: runningSum + sumOfAllRemaining < targetCents    → abandon the branch
     - cap:   |subset| > MAX_COMBINATION_SIZE = 4             → abandon the branch
4. On runningSum === targetCents, record the subset.
5. Stop early once MAX_COMBINATIONS results are recorded.
6. Rank (§5.4) and return the top 5.
```

All arithmetic is integer addition on cents. No floats, no tolerance, no epsilon: a combined
refund either sums exactly or it is not a combined refund. `$1,100.00 + $100.00 = $1,200.00`
is `110000 + 10000 === 120000`, exactly.

### 5.3 The bound — proof that it is not exponential in the ledger

The concern with subset-sum is `2^n`. It does not arise, because **`n` here is never the
ledger.**

**Step 1 — the input is a constant-size set.** §4.2 caps candidate purchases at
`K = MAX_CANDIDATE_PURCHASES = 12`, selected by score from an indexed window. `K` is a
compile-time constant and does not grow with the ledger.

**Step 2 — the search space is a constant.** With the subset-size cap
`S = MAX_COMBINATION_SIZE = 4`, the number of subsets the walk can *ever* visit is

```
Σ(k=1..4) C(12,k) = 12 + 66 + 220 + 495 = 793
```

793 subsets, each requiring at most 4 integer additions: **≤ 3,172 integer additions per
credit**, worst case, before the two prunes remove anything. Even with the size cap removed
entirely, the ceiling is `2^12 − 1 = 4,095` subsets — still a constant. Both numbers are
independent of ledger size.

**Step 3 — total work is linear.** Let `n` = transactions in the period, `R` = refund credits
in the period. Total cost is

```
O(n)            build the merchant/account/date indexes, once per period   (§9)
+ O(R · log n)  window lookup per credit (binary search on a sorted date array)
+ O(R · K log K) score and sort the ≤ 12 candidates per credit
+ O(R · 793)    the bounded walk
= O(n + R · c)  where c is a constant ≤ 3,172 integer additions
```

Linear in `n`, linear in `R`, constant per credit. **There is no exponential term, and there
is no `n²` term.** Test M20 asserts it empirically: on a 5,000-row fixture ledger the walk
executes fewer than `R × 793` subset evaluations, counted by an instrumented callback.

**Step 4 — the prunes only help.** Descending sort plus "runningSum + next > target" removes
most branches on real data (a $12.00 credit against a $1,100.00 purchase is dropped at step 1
before the walk starts). The prunes are an optimisation; the bound in step 2 holds without
them, which is why the bound is stated without them.

**Why not a DP over cents?** Classic subset-sum DP is `O(K · targetCents)` — for a $1,200.00
credit that is 12 × 120,000 = 1.44M cells, *worse* than 793 subset evaluations and it also
loses the "which purchases" answer without backtracking. The bounded walk is both smaller and
directly produces the allocation. Meet-in-the-middle (`2^(K/2) = 64` per half) is available
if `K` ever needs to exceed 12; it is deferred (§12.4) because 793 is already fast enough to
run synchronously in a `useMemo`.

### 5.4 Ranking, in this order

1. **Exact combined amount.** Non-exact never appears — the walk only records exact sums.
2. **Fewest purchases.** A 2-purchase explanation beats a 4-purchase one for the same total.
3. **Same account.** All-purchases-on-the-credit's-account beats a mixed set.
4. **Closest dates.** Smallest span between the earliest purchase and the credit.
5. **Strongest reference overlap.** Shared order/reference tokens between the purchase
   descriptions and the credit description — computed locally, never sent anywhere, and
   scored as `strong | weak | none` in `CandidateEvidence.referenceOverlap`
   (FIN-RELATION-001 §4.4) rather than stored as text.
6. **Transaction ids ascending** — the final deterministic tie-break, so the returned order
   never depends on Firestore's or the walk's incidental ordering.

### 5.5 What it must refuse

- A combination that includes a purchase already fully covered by `confirmed` links.
- A combination spanning more than 180 days from the earliest purchase to the credit.
- A combination whose purchases sit on more than two distinct accounts.
- Any subset of size 1 — that is a `refund_match`, produced by §4.3, not by this walk.
- Auto-confirmation. A combined match is *always* `unreviewed` until the owner confirms it,
  regardless of how exact the sum is.

---

## 6. Net economic cost

### 6.1 The four numbers

Computed per purchase in `src/lib/refunds.ts`, integer cents, from `confirmed` links only:

```ts
export interface PurchaseEconomics {
  grossPurchaseCents: number;        // toCents(purchase.amount) — never changes
  confirmedRefundedCents: number;    // Σ confirmed refund_of | partial_refund_of | reversal_of
  provisionalRefundedCents: number;  // Σ provisional chargeback_for
  netEconomicCostCents: number;      // grossPurchaseCents − confirmedRefundedCents
  status: RefundStatus;
}
```

**`provisionalRefundedCents` is deliberately absent from `netEconomicCostCents`.** A dispute
credit is money the bank may take back. Subtracting it from final personal spending would
report a saving the owner has not made.

A second, separately named figure exists for the "if the dispute is upheld" view:

```
netEconomicCostIfDisputeUpheldCents = netEconomicCostCents − provisionalRefundedCents
```

It may be rendered **only** alongside the word *provisional* (FIN-RECOVERY-UI-001 §5.3). It
never feeds Analytics totals, Budgets or the forecast baseline.

### 6.2 Statuses

| Status | Condition | Label |
|---|---|---|
| `not_refunded` | `confirmedRefundedCents === 0` | (no badge) |
| `partially_refunded` | `0 < confirmedRefundedCents < grossPurchaseCents` | "Partially refunded" |
| `fully_refunded` | `confirmedRefundedCents === grossPurchaseCents` | **"Returned"** |
| `over_refunded` | `confirmedRefundedCents > grossPurchaseCents` | "Over-refunded — needs review" |
| `provisional_dispute_credit` | `provisionalRefundedCents > 0` | "Provisional dispute credit" |

`over_refunded` is reachable only through FIN-RELATION-001's explicit `over_refunded` conflict
state (its §3.4/V5) — it is never produced by silent clamping, and it always surfaces for
review rather than being absorbed.

`provisional_dispute_credit` composes with the others: a purchase can be
`partially_refunded` *and* carry a provisional credit. The UI shows both, never one collapsed
into the other.

### 6.3 The chargeback lifecycle

1. The dispute credit posts. `classifyCardCredit()` rung 4 gives `chargeback_credit`; a
   `chargeback_for` link is written with `status: 'provisional'`.
2. `provisionalRefundedCents` rises; `netEconomicCostCents` **does not move**.
3. The dispute resolves. The owner confirms → link becomes `confirmed`,
   `provisionalRefundedCents` falls to 0, `confirmedRefundedCents` rises, and
   `netEconomicCostCents` moves exactly once.
4. The dispute is lost and the bank reverses its credit. The reversal arrives as a *new
   charge*; the link is `rejected`; gross history retains all three rows. Nothing is deleted.

---

## 7. Cross-surface contracts

### 7.1 Gross history is preserved everywhere

The governing rule, already the app's practice (`FIN-REVIEW-002.md:596-600`): **preserve both
gross cash movement and personal economic cost; never destroy gross history to show net.**

- The purchase row stays in History at its full amount, with its original date, description,
  provider id and category. `src/lib/refunds.ts` writes **nothing** to a transaction document.
- The refund row stays too. Both are visible; the relationship is an annotation.
- `buildFlowGraph()` (`src/lib/flows.ts:91`) is untouched. The purchase ribbon into its
  category stays full size; the credit still reaches the `refunds` node
  (`src/lib/flows.ts:224-228` — "a refund is not income (owner rule)"). Conservation, which
  is unit-tested in `src/__tests__/flows.integration.test.ts`, is unchanged because **no node
  and no edge is added**.
- The relationship renders as a linked-pair *affordance* — selecting either row highlights
  both through the existing trace machinery (`isNodeBright` / `isLinkBright`,
  `src/app/flow/page.tsx:267`, `:280`) and adds a line to the drill-down table. This is
  FIN-RECOVERY-UI-001's to build; FIN-REFUND-001 supplies the data.

### 7.2 What net cost changes, and what it must not

| Surface | Effect | Owner |
|---|---|---|
| **Analytics** | per-category spending reads **net** of confirmed refunds; the gross figure stays available beside it | FIN-RECOVERY-UI-001 renders; FIN-REFUND-001 computes |
| **Budgets** | a refunded purchase reduces the category's consumed budget by the confirmed refund | FIN-REFUND-001 exposes `netCategorySpendingCents()`; `src/lib/budgets.ts` consumption is a follow-up, see §12.1 |
| **Flow story tiles** | `story.spending` already subtracts `story.refunds` at aggregate level (`src/app/flow/page.tsx:433`) — unchanged, and now reconcilable per row | — |
| **Earned income** | **unchanged.** No refund ever adds to earned income | FIN-INCOME-001 |
| **Forecast** | a refund never becomes recurring income. `detectRecurring()` only groups `classifyTransaction() === 'expense'` rows (`src/lib/flows.ts:382`), so it structurally cannot; the `monthlyAverages()` path is FIN-INCOME-001's | FIN-INCOME-001 |
| **History / Export** | gross rows, unchanged; a relationship column may be added by FIN-RECOVERY-UI-001 | — |
| **AI context** | candidate ids and capped evidence only; never the full ledger | FIN-RELATION-001 §7 |

**A note on today's income total, which FIN-REFUND-001 does not change.**
`src/__tests__/cross-surface-consistency.test.ts:63-69` documents that a refund currently
*does* count toward `sumIncomeCents` (`EXPECTED_INCOME_CENTS = 330300` includes the $15.00
refund), with the comment "refund/unknown stay counted until FIN-INCOME-001 rules on earned
income". That is FIN-INCOME-001's to fix and this task does not pre-empt it. The consequence
is a hard precondition: **test M17 ("earned income unchanged by a refund") cannot be written
until FIN-INCOME-001 has landed its predicate** (§12.1).

### 7.3 A refund on a bank account vs on a card

- **Bank account:** cash goes up. The row already routes to the `refunds` node
  (`src/lib/flows.ts:226-228`), so it is not counted as income in the Flow story.
- **Credit card:** liability goes down. `isPositive()` (`src/lib/classify.ts:133`) already
  signs it as a gain on a debt account, and `deriveAccountBalance()` consumes that — see
  `src/__tests__/cross-surface-consistency.test.ts:137-138`, where the fixture card balance
  `−205.80` includes `− refund 15`.

Neither is income. Both preserve the original purchase.

---

## 8. Observability

Reuse OBS-001 (merged; `src/lib/obs/`). `component: 'RecoveryRefunds'`, `route: '/flow'`.

| Event | When | Safe properties |
|---|---|---|
| `Refund.CandidateGenerated` | a run emits candidates | `recordCount`, `metadata.candidateType`, `metadata.exactCount`, `metadata.partialCount`, `metadata.combinedCount`, `metadata.algorithmVersion`, `durationMs`, `resultStatus` |
| `Refund.MatchConfirmed` | the owner confirms | `metadata.candidateType`, `metadata.allocationCount`, `metadata.sameAccount`, `metadata.dayGap`, `resultStatus` |
| `Refund.AllocationAdjusted` | an allocation is superseded | `metadata.allocationCount`, `metadata.direction: 'increase' \| 'decrease'`, `resultStatus` |
| `Refund.MatchRejected` | the owner rejects | `metadata.candidateType`, `metadata.rejectionReasonCode`, `resultStatus` |
| `CardCredit.Classified` | the ladder resolves a credit | `metadata.cardCreditKind`, `metadata.rung` (1–7), `metadata.confidence`, `resultStatus` |

One span: `Refund.GenerateCandidates`, one event on `end()` per OBS-001's performance rule.

**Never logged:** amounts as free values, merchant strings, titles, descriptions, account
names or numbers, `lastFourDigits`, provider payloads, credentials, tokens, the AI context,
the owner's typed message or the model's reply. Transaction ids only as `hashId()`
(`src/lib/obs/events.ts:73`). `metadata.dayGap` is a small integer, not a date.

---

## 9. Performance

- **Index once per period, not per row.** `Map<normalizedMerchant, Transaction[]>`,
  `Map<accountId, Transaction[]>`, and a date-sorted array per bucket for binary-search
  windowing. One O(n) pass, memoized on `[transactions, accounts, period]` — the same
  `useMemo` discipline `/flow` already uses for `buildFlowGraph()`
  (`src/app/flow/page.tsx:189`).
- **No generator in a render path.** Candidate generation runs on ingest completion, on an
  explicit refresh, or on demand. Never per render, never in an unguarded effect.
- **Bounded matching**, §5.3: constant work per credit.
- **Incremental re-evaluation.** A new sync re-evaluates only credits in the affected window,
  and skips every candidate whose stored status is terminal (FIN-RELATION-001 §4.3) via an
  O(1) `Set` check.
- **Cached decisions.** Confirmed links are read once into the `Map` of FIN-RELATION-001 §10;
  `PurchaseEconomics` is memoized per transaction id.
- **No `O(n²)` anywhere.** Pairwise comparison happens only inside a merchant×account bucket
  capped at 12 candidates.

---

## 10. Privacy

- **No production data is read, queried or accessed by this task.** There is no authenticated
  session and none is to be obtained. The owner-run validation procedure lives in
  `docs/features/REFUNDS-RETURNS-AND-DUPLICATES.md` §11 and is manual and read-only.
- No test may mutate production or trigger a SimpleFIN sync.
- Reference-overlap analysis (§5.4 rank 5) runs locally on strings already in memory; the
  result stored is the enum `strong | weak | none`, never the tokens.
- Every fixture is invented, per `src/lib/obs/fixtures.ts`'s existing rule.

---

## 11. Test matrix — failing tests first

Jest, `npm test`. Fixture style follows
`src/__tests__/ledger-classification.test.ts:27-45` (invented accounts, a `txn()` helper) and
`src/__tests__/cross-surface-consistency.test.ts:23-60` (one shared ledger, hand-computed
integer-cent truth).

### 11.1 Card-credit classification — `src/__tests__/card-credit.test.ts` (14)

| # | Test |
|---|---|
| D1 | **`earned_income` is not in the range of `CARD_CREDIT_TO_INFLOW_MEANING`** — asserted by enumerating all ten keys |
| D2 | every `CardCreditKind` is consistent with `interpretTransaction().meaning` per §3.3's table |
| D3 | the rung-5 sub-split is total over `isReward()`-true inputs and empty over `isReward()`-false ones |
| D4 | **a card payment is NOT income** — `sumIncomeCents` contribution is 0 and the kind is `card_payment` |
| D5 | **a card refund is NOT income** |
| D6 | **cashback is NOT income** |
| D7 | **a statement credit is NOT income** |
| D8 | **an unknown card credit is NOT income**, and it generates an `unknown_card_credit` candidate rather than sitting silent |
| D9 | **a chargeback credit is NOT income**, and its link is `provisional` |
| D10 | **card-payment pairing takes precedence over refund matching** — a $300.00 settlement that coincides with a $300.00 purchase resolves to `card_payment`, and no refund candidate is generated |
| D11 | a purchase titled "PAYMENT PROCESSING SOLUTIONS LLC" is still spending and still reduces nothing — the FIN-LEDGER-001 behaviour is not regressed |
| D12 | rungs 2–4 require a **confirmed** link: with only a `suggested` refund link the kind stays `unknown_card_credit` |
| D13 | ladder order is asserted rung by rung; a permuted ladder fails at least one case |
| D14 | a manual row with no provider source resolves to `manual_adjustment`, not `unknown_card_credit` |

### 11.2 Refund matching — `src/__tests__/refunds.test.ts` (21)

The sanitized anchor fixture (see `REFUNDS-RETURNS-AND-DUPLICATES.md` §11.2) is used by
M2–M4: Purchase A "Demo Amazon Lens" `110000`, Purchase B "Demo Amazon Filter" `10000`,
credit "Demo Amazon Refund" `120000`, all on `demo-card-9021`.

| # | Test |
|---|---|
| M1 | **exact refund**: a $45.00 credit against a $45.00 purchase → one `refund_of`, `netEconomicCostCents === 0`, status `fully_refunded` ("Returned") |
| M2 | **partial refund**: $1,100.00 purchase, $900.00 credit → one `partial_refund_of` of `90000`, `netEconomicCostCents === 20000` ($200.00 net), status `partially_refunded` |
| M3 | **combined refund**: `110000 + 10000` → `120000` produces **two** allocations totalling exactly `120000`, and `netEconomicCostCents === 0` on both purchases |
| M4 | the combined match survives reversed discovery order and reversed input order — same candidate id, same allocations |
| M5 | a purchase larger than the credit is dropped before the walk (step 1) |
| M6 | the walk records **only exact sums**; a combination off by `1` cent is not returned |
| M7 | `MAX_COMBINATIONS = 5`: a fixture with 7 valid combinations returns exactly 5, ranked by §5.4 |
| M8 | `MAX_COMBINATION_SIZE = 4`: a valid 5-purchase combination is **not** returned |
| M9 | **multiple partial refunds accumulate**: three confirmed partials of `30000 + 30000 + 20000` against `110000` leave `netEconomicCostCents === 30000` |
| M10 | a fourth partial that would exceed the purchase is **rejected** (V5), not clamped |
| M11 | **an ambiguous refund goes to review with no auto-confirm** — two candidates within 0.05 both emit `unreviewed`, and no link is written |
| M12 | **a pending credit is not a finalized refund** — no candidate, no link, no cost reduction |
| M13 | **a different-account refund gets lower confidence** — same evidence, −0.2, and it still requires confirmation |
| M14 | **a posted replacement appears once** — the `pending_` hold and its posted twin never both generate a candidate |
| M15 | **gross history is preserved** — both transaction documents are byte-identical after confirm |
| M16 | **net spending is reduced** — `netCategorySpendingCents()` for the category falls by exactly the confirmed refund |
| M17 | **earned income is unchanged** by a confirmed refund *(activates when FIN-INCOME-001's predicate lands — §12.1)* |
| M18 | **budget impact is reduced** — the category's consumed budget falls by the confirmed refund and by nothing else |
| M19 | **the forecast does not treat a refund as recurring income** — a monthly refund series produces no recurring income projection |
| M20 | **the bound holds**: on a 5,000-row fixture, subset evaluations counted by an instrumented callback are `< R × 793`, and total runtime is linear in `n` across 1k/2k/5k fixtures |
| M21 | a `suggested` link contributes zero to `PurchaseEconomics`; only `confirmed` moves a number |

### 11.3 Net economic cost — `src/__tests__/refund-economics.test.ts` (7)

| # | Test |
|---|---|
| N1 | the four fields are integer cents; no float appears in any of them |
| N2 | `not_refunded` / `partially_refunded` / `fully_refunded` / `over_refunded` boundaries are exact at `0`, `1`, `gross − 1`, `gross`, `gross + 1` |
| N3 | **a provisional dispute credit does NOT reduce `netEconomicCostCents`** |
| N4 | `netEconomicCostIfDisputeUpheldCents` is a separate field and is never substituted for the net figure |
| N5 | the chargeback lifecycle (§6.3) moves `netEconomicCostCents` exactly once, on confirmation |
| N6 | a lost dispute leaves all three rows in history and deletes nothing |
| N7 | `provisional_dispute_credit` composes with `partially_refunded` — both statuses are reported, neither collapses the other |

### 11.4 Flow contract — `src/__tests__/refund-flow-contract.test.ts` (4)

| # | Test |
|---|---|
| G1 | **Flow conservation is unchanged** — `buildFlowGraph()` output over a ledger with confirmed refund links is identical to the same ledger without them (no node, no edge, no cent moves) |
| G2 | the credit still reaches the `refunds` node on both a card account and a bank account |
| G3 | **Flow shows the relationship** — the linked pair is resolvable from `graph.nodeTxnIds` (`src/lib/flows.ts:85`) plus the link map, with no change to the graph itself |
| G4 | `story.spending` (`src/app/flow/page.tsx:433`) and the sum of per-row `netEconomicCostCents` agree to the cent over the fixture |

**FIN-REFUND-001 total: 46 specified tests.**

---

## 12. Ready to implement when…

### 12.1 Preconditions

1. **FIN-RELATION-001 has merged.** Without `TransactionLink`, `ReviewCandidate`, the
   validators, the store, the thirteen parser actions and the rules block, this task has
   nowhere to write and would be forced to invent a second model. Hard blocker.
2. **FIN-INCOME-001 has merged** and exports the inflow-taxonomy type, its value list and its
   earned-income predicate from a known module path. `CARD_CREDIT_TO_INFLOW_MEANING` (§3.3)
   cannot be typed without it, and D1 cannot be asserted without it. Hard blocker.
3. **FIN-INCOME-001 has ruled on today's refund-counted-as-income behaviour** documented at
   `src/__tests__/cross-surface-consistency.test.ts:63-69`. Until it does, **M17 cannot be
   written**. FIN-REFUND-001 must not pre-empt that decision by editing `sumIncomeCents`.
4. **FIN-INCOME-001 has released `src/lib/classify.ts`, `src/types/index.ts` and
   `src/lib/forecast.ts`**, which this task reads and never writes.
5. **The owner has confirmed the caps**: `MAX_CANDIDATE_PURCHASES = 12`,
   `MAX_COMBINATION_SIZE = 4`, `MAX_COMBINATIONS = 5`, the 180-day/+5-day window, and the
   −0.2 different-account penalty.
6. **The owner has confirmed that no score auto-confirms** (§4.4) and that provisional
   dispute credits never reduce final personal spending (§6.1).
7. **The owner has run the manual validation procedure** in
   `docs/features/REFUNDS-RETURNS-AND-DUPLICATES.md` §11 against their own data and returned
   the sanitized report. The structural pattern it confirms is what M3/M4 encode.
8. **Budget consumption is agreed as in-scope or out.** `src/lib/budgets.ts:26,56` computes
   category spending; making it read net requires editing it. If FIN-INCOME-001 or another
   task holds that file, M18 is deferred with the reason recorded — it is **not** silently
   dropped.
9. **The 46 tests in §11 are written first and are red.**
10. **A worktree exists** for the implementation branch, isolated from
    `../cashflow-forecast-fin-income-001` and from FIN-DUPLICATE-001's worktree.

### 12.2 File ownership — FIN-REFUND-001 owns these exclusively

| File | New? |
|---|---|
| `src/lib/card-credit.ts` | new — `CardCreditKind`, the ladder, the projection map |
| `src/lib/refunds.ts` | new — candidate generation, the bounded walk, `PurchaseEconomics` |
| `src/__tests__/card-credit.test.ts` | new |
| `src/__tests__/refunds.test.ts` | new |
| `src/__tests__/refund-economics.test.ts` | new |
| `src/__tests__/refund-flow-contract.test.ts` | new |

Six files, four of them tests. That is the whole write surface, and it is why this task can
run beside FIN-DUPLICATE-001.

### 12.3 Overlap warnings

- **FIN-INCOME-001** owns `src/types/index.ts`, `src/lib/classify.ts`, `src/lib/forecast.ts`,
  `src/lib/firestore.ts`, `src/context/UserProfileContext.tsx`. FIN-REFUND-001 **reads all of
  them and writes none**. Its worktree `../cashflow-forecast-fin-income-001` is read-only.
- **FIN-RELATION-001** owns `src/lib/chat-actions.ts`, `functions/src/prompts.ts` and
  `firestore.rules`. FIN-REFUND-001 writes **none** of them — the four refund actions
  (`confirm_refund_allocation`, `adjust_refund_allocation`, `reject_refund_candidate`,
  `classify_card_credit`, `mark_reward_credit`, `mark_chargeback_credit`) land in
  FIN-RELATION-001's single pass.
- **FIN-DUPLICATE-001** (parallel) owns `src/lib/duplicates.ts` and
  `src/lib/service-identity.ts`. FIN-REFUND-001 **imports** `service-identity.ts` read-only
  for merchant-family scope (§4.2). **If FIN-DUPLICATE-001 has not merged, FIN-REFUND-001
  falls back to exact `normalizeMerchant()` equality** and the import is added later — it
  does not create its own copy of the service-identity model.
- **`src/lib/flows.ts`** — FIN-REFUND-001 imports `toCents`, `day`, `normalizeMerchant` and
  writes nothing. The one additive `export` that programme needs there belongs to
  FIN-DUPLICATE-001 (its §12.3).
- **`src/lib/budgets.ts`** — potentially edited for M18; see precondition 8. Confirm
  ownership before touching it.
- **`src/app/flow/page.tsx`** — FIN-RECOVERY-UI-001 is the sole owner. FIN-REFUND-001 adds no
  UI and no component.
- **`src/lib/fingerprint.ts` / `functions-sync/simplefin.py`** — the mirrored technical-dedupe
  pair (§2.1). **Neither may be changed independently, and FIN-REFUND-001 changes neither.**

### 12.4 Deferred — explicitly not in FIN-REFUND-001

- Meet-in-the-middle subset-sum, needed only if `MAX_CANDIDATE_PURCHASES` ever exceeds 12.
- Combined refunds spanning more than four purchases or more than two accounts.
- Tolerance-based matching (matching within a cent). Exact integers only, on purpose.
- Currency conversion; foreign-transaction-fee refunds as a distinct kind.
- Return-shipping deductions modelled as their own entity — today they simply make a refund
  partial, which is correct and sufficient.
- Merchant-specific refund-window knowledge ("this retailer allows 90 days"). One 180-day
  window for everyone.
- Automatic confirmation at any confidence.
- Rewriting `sumIncomeCents` / `monthlyAverages()` — FIN-INCOME-001's, always.
- A machine-learned matcher. §4.4's ladder is hand-written and explainable, deliberately.
