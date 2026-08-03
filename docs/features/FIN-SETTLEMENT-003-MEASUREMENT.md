# FIN-SETTLEMENT-003 — Phase 1 measurement report

**Status.** Measurement only. No product code, no schema, no migration, nothing applied.
**Date.** 2026-08-02. **Branch.** `feat/fin-settlement-003-shared-expenses`.
**Baseline.** 947 tests / 57 suites green before and after this document.

## 0. Method, and what is safe to read here

Every number below was measured **read-only** against the owner's real Monarch export
(2,913 rows, 2023-12-02 → 2026-07-22) using this repo's own functions — `personFrom()`,
`classifyTransaction()`, `interpretTransaction()`, `buildFlowGraph()`,
`buildMappingGroups()` — loaded exactly the way `src/__tests__/flows.integration.test.ts`
loads them. Nothing was written to Firestore, nothing was recategorised, no sync was run.
The measurement scripts are throwaway and live outside the repo.

**No real person's name appears in this document.** Counterparties are referred to by
stable labels (`P1`…`P9`) or by aggregate. Service names already in the project record
(REMITLY) are used as-is. Totals are already in the project record and are safe.

Rules of this document, same as `docs/data/DATA-MAPPING-GAPS.md`: **verified findings
only.** Anything not measured is marked as such and says what would settle it.

---

## 1. What the "people lines" actually are

`personFrom()` resolves an external counterparty on **284 of 2,913 rows**
(**$280,790.64**, 24.1% of all gross movement in the ledger).

| | rows | amount |
|---|---|---|
| outbound (money leaving) | 155 | $187,178.36 |
| inbound (money arriving) | 129 | $93,612.28 |

Those 284 rows carry **81 distinct counterparty keys**:

| shape | keys | amount |
|---|---|---|
| seen in **both** directions | 9 | $36,395.50 in / $12,992.00 out |
| **inbound only** | 40 | $57,216.78 |
| **outbound only** (incl. REMITLY) | 32 | $174,186.36 |
| outbound only, excluding REMITLY | 31 | $53,624.00 |

Of the one-way keys, **20 outbound and 27 inbound are a single row each** ($12,385.00 and
$22,597.15). A single row with no counterpart is not a settlement; it is a fact with no
shape, and no amount of analysis will give it one.

What `/flow` renders today (from `buildFlowGraph()`, verified against the live node ids):

| node | amount | rows |
|---|---|---|
| `person-out:REMITLY` | $120,562.36 | 78 |
| `person-out:` largest named | $18,612.00 | 8 |
| `person-out:others` | $40,124.00 | 57 |
| `person-in:` four named | $44,259.50 | 48 |
| `person-in:others` | $49,352.78 | 81 |

---

## 2. THE critical question: did people-line money come back?

Every one of the 9 accounts in the export is owned, so "did it return to an account the
owner controls" reduces to "is there a matching **inbound row anywhere in this ledger**".
750 inbound rows were available to match against.

A raw match rate is meaningless without a null model, so the same test was run over
**ordinary non-people spending**. Most people rows are round hundreds, so a round-amount
control was run too — that turns out to be the only honest comparison.

### 2.1 REMITLY — 78 rows, $120,562.36, **100% outbound**

Same amount, inbound, into a **different** account:

| window | REMITLY | control: expenses ≥ $100 | control: **round-$100** expenses |
|---|---|---|---|
| ±0d | **0 / 78 — 0.0%** | 0.0% | 0.0% |
| ±1d | 1 / 78 — 1.3% | 0.7% | 2.6% |
| ±3d | 3 / 78 — 3.8% | 3.0% | 18.4% |
| ±7d | 5 / 78 — 6.4% | 5.1% | 34.2% |
| ±14d | 5 / 78 — 6.4% | 5.4% | 36.8% |
| ±30d | 9 / 78 — 11.5% | 6.1% | 42.1% |
| ±90d | 15 / 78 — 19.2% | 7.4% | 52.6% |
| any date at all | 16 / 78 — 20.5% | 13.8% | 94.7% |

Restricted to the 21 REMITLY rows that **are** round hundreds — the like-for-like
comparison — REMITLY matches at **23.8% at ±7d against a control of 34.2%**: *below*
chance. Allowing the return into the same account raises REMITLY to 12.8% at ±7d, still
inside the noise. The apparent ±30d/±90d signal is entirely round-number collision.

The specific claim — *money came back from Remitly* — is measured directly:

| window | REMITLY outflow → an inbound row naming REMITLY |
|---|---|
| ±0d … ±90d | **0 / 78** |
| any date at all | **0 / 78** |

**There are zero inbound REMITLY rows in the entire ledger.**

Supporting shape:

- **Cadence: none.** 64 unique days across 23 of the 26 months in the window. Median gap
  7 days, min 1, max 54; the weekly band holds only **10%** of gaps. Irregular, not
  scheduled.
- **Amounts: not repeated.** $16.59 → $7,000.00, median $1,189.25, **59 distinct amounts
  in 78 rows**. Not the fixed-sum signature of a standing transfer.
- **Funding:** 75 rows / $120,196.52 from bank accounts, **3 rows / $365.84 from a credit
  card**.
- **The owner's own words, in their own export:** 73 rows are Monarch `Transfer`, **4 are
  `Send to India`**, and **1 is `Loan Repayment`**. Three different meanings inside one
  line, typed by the owner.
- Scale: 20.8% of all gross outflow; **46.8% of everything the app classifies as income**.

**VERDICT — high confidence (measured): the money left all nine accounts and never came
back to any of them.** It is not an internal transfer between the accounts this app can
see. Calling it `internal_transfer`, which is what the app does today, is factually
wrong.

**VERDICT — the remaining question is NOT answerable from this data.** Whether the
destination is an account the owner still controls (their own Indian bank account) or a
transfer of value to someone else (family support, a debt, a purchase) is invisible: no
row in this export describes the far side. `Send to India` names the *destination
country*, not the *owner of the destination*. **This one needs owner intent.** See §5.

### 2.2 Named people (non-REMITLY) — 77 outbound rows

| window | named-person outflows | round-$100 subset (46 rows) | round-$100 control |
|---|---|---|---|
| ±0d | 6 / 77 — 7.8% | 13.0% | 0.0% |
| ±3d | 9 / 77 — 11.7% | 17.4% | 18.4% |
| ±7d | 17 / 77 — 22.1% | 34.8% | 34.2% |
| ±30d | 28 / 77 — 36.4% | 58.7% | 42.1% |
| any | 51 / 77 — 66.2% | 97.8% | 94.7% |

Against the naive control this looks like a 4× signal. Against the **correct** control it
is **34.8% vs 34.2%** — indistinguishable. The whole apparent effect was round numbers
colliding.

The specific claim again — *the same person sent it back*:

| window | named outflow → inbound from the **same counterparty** |
|---|---|
| ±0d … ±14d | **0 / 77** |
| ±30d | 1 / 77 |
| ±90d | 3 / 77 |
| any date | 6 / 77 — 7.8% |

**VERDICT: same-amount round-tripping does not happen at these lines either.** Money to a
named person does not come back as the same figure. Settlement between these people, where
it happens at all, happens at **different amounts over months** — which is exactly what
§3 shows.

---

## 3. Per-line verdicts

### 3.1 The 9 two-way counterparties — the genuine settlement relationships

`net` is outbound minus inbound: negative means the owner received more than they sent.
`signFlips` counts how often the running balance changes sign — once means *lend, then get
repaid*; repeatedly means *a running tab*.

| label | rows | span | out | in | net | signFlips | shape |
|---|---|---|---|---|---|---|---|
| P1 | 21 | 2024-07 → 2026-06 | 4 / $2,380.00 | 17 / $17,788.00 | **−$15,408.00** | 1 | 3 sends, then a 17-row run of receipts |
| P2 | 20 | 2024-05 → 2025-12 | 4 / $2,500.00 | 16 / $9,857.50 | −$7,357.50 | **4** | genuine running tab, both directions throughout |
| P3 | 9 | 2024-06 → 2026-04 | 4 / $3,000.00 | 5 / $5,550.00 | −$2,550.00 | 0 | received $5,550 first, then repaid $3,000 |
| P4 | 3 | 2025-12 → 2026-05 | 2 / $2,200.00 | 1 / $330.00 | +$1,870.00 | 0 | sent, part came back |
| P5 | 3 | 2024-06 → 2024-09 | 2 / $312.00 | 1 / $170.00 | +$142.00 | 1 | received, then two repayments |
| P6 | 2 | 2024-12 → 2026-03 | 1 / $1,000.00 | 1 / $800.00 | +$200.00 | 0 | 15 months apart |
| P7 | 2 | 2025-08 → 2026-03 | 1 / $1,000.00 | 1 / $1,200.00 | −$200.00 | 1 | 7 months apart |
| P8 | 2 | 2024-11 → 2024-12 | 1 / $100.00 | 1 / $200.00 | −$100.00 | 0 | 14 days apart |
| P9 | 2 | 2024-10 → 2024-11 | 1 / $500.00 | 1 / $500.00 | **$0.00** | 0 | sent $500, received $500 back 16 days later |

**VERDICT — measurable, medium-to-high confidence:** these nine are two-way relationships,
not one-way spending. P9 is a **fully settled** loan the ledger can prove on its own. P3
and P5 are **received-then-repaid** (a liability the owner took on and paid down). P1 and
P2 are **large open positions in the owner's favour**. These are the rows that justify a
settlement model at all.

**What measurement cannot decide for them:** *what kind* of two-way relationship. A rent
share, a lent-and-repaid loan and a family pool all produce the same signature. `signFlips`
separates *lend-then-repay* (0–1) from *a running tab* (≥2) — that is real, derivable
evidence and it is a proposal, not an answer.

### 3.2 The 31 non-REMITLY one-way outbound lines — $53,624.00

Includes the largest named one-way line (**8 rows, $18,612.00, 2024-06 → 2025-03, median
gap 31 days but only 33% of gaps in the monthly band — irregular**), and 20 keys that are a
single row each ($12,385.00 total).

**VERDICT: no return flow exists, at any window, for any of them.** They are money that
left. Whether each is a gift, a shared cost, a loan the owner is still owed, or a payment
for something is **not in the data** — the amounts are irregular, the cadences fail this
app's own in-band rule, and 20 of 31 have exactly one row.

The one honest lever measurement gives here: **the owner's own Monarch category.** Where
they typed something other than `Transfer` — `Rent`, `Home Improvement`, `Travel &
Vacation`, `Auto Maintenance`, `Financial & Legal Services`, `Garbage`, `Send to India` —
they have already said what it was. Sixteen people rows ($15,420.93) carry such a category
and the app already classifies those as spending. That is evidence, and it is verbatim.

### 3.3 The 40 one-way inbound lines — $57,216.78

**VERDICT: 27 are single rows ($22,597.15) and cannot be settled by data.** Seven of them
(those Monarch typed `Other Income`) already reach the review queue as `unknown_inflow`; the
other 33 do not (§4). None is earned income under FIN-INCOME-001 unless the owner says so.

### 3.4 The brief's ZELLE and BANK OF AMERICA lines — **they do not reproduce**

Reported in the brief as `ZELLE ~$10,026 across 11 rows` and `BANK OF AMERICA 12 rows /
$1,494.43`. Measured against the current `personFrom()`:

- **There is no `ZELLE` counterparty key and no `BANK OF AMERICA` counterparty key.**
  Neither figure reproduces.
- **182 rows ($166,698.30) whose merchant is `Zelle` resolve to the OWNER'S OWN NAME** and
  are caught by `isSelfPerson()`. They split 90 outbound / $84,902.65 and 92 inbound /
  $81,795.65 — near-balanced, the signature of the owner moving money between their own
  institutions. They land in the `self-ext-in`/`self-ext-out` lanes, not in any people
  line, and they are **out of FIN-SETTLEMENT-003's scope**.
- 52 rows ($22,628.03) mention "bank of america" anywhere in their text. The nearest thing
  to the brief's row count is 12 inbound `Transfer` rows totalling **$7,376.61** — not
  $1,494.43.

**Treat both brief figures as superseded by this measurement.** They appear to come from an
earlier extractor. This is the same class of error the `5 missing paychecks → 1` correction
came from.

### 3.5 Two duplicate-shaped REMITLY pairs, found in passing

Two $1,000.00 rows on the same day on two different accounts, and two $2,238.39 rows on the
same day both categorised `Send to India`. These are **FIN-DUPLICATE-001 questions, not
settlement questions**, and are recorded here only so they are not lost.

---

## 4. The architectural finding: none of this money can be asked about

This is the most important result in the report and it is not about classification.

`buildMappingGroups()` is fed from exactly two places — the unknown-inflow queue and the
Flow graph's unpaired-leg lanes. **People rows are in neither.**

- `selectInflowReviewQueue()` only admits rows whose `financialMeaning` is
  `unknown_inflow`, which requires `classifyTransaction() === 'income'`. 261 of the 284
  people rows are `transfer`.
- `buildFlowGraph()` routes an external-counterparty leg to a `person-in:`/`person-out:`
  node **instead of** an unpaired-leg lane, so it never appears in
  `UNPAIRED_LEG_LANE_IDS`.

Measured on the real export:

> **7 of 284 people rows reach the mapping queue. Zero of the 155 outbound rows do.**
> The 7 that do arrive carry `refund_candidate` suggestions, which is the wrong evidence
> for a person-to-person row.

By counterparty key: **0 of the 32 outbound-only keys**, **6 of the 40 inbound-only keys**,
and **1 of the 9 two-way keys** have a single row in the queue. The six that get in do so
only because Monarch happened to label them `Other Income` rather than `Transfer`.

The person lane is a **terminal** lane: money enters it and no question is ever attached.
$280,790.64 is unaskable.

### What the misclassification asserts today

| `financialMeaning` today | rows | amount |
|---|---|---|
| `internal_transfer` | 261 | **$259,206.71** |
| `personal_expense` | 16 | $15,420.93 |
| `unknown_inflow` | 7 | $6,163.00 |

The app currently states that **$259,206.71 moved between the owner's own accounts** across
81 distinct counterparties. `personalCostSign('internal_transfer')` is 0, so every one of
those dollars is asserted to have cost the owner nothing.

### The size of the decision

| | |
|---|---|
| outbound people rows classified `transfer` (counted as neither income nor spending) | **139 rows / $171,757.43** |
| of which REMITLY | 73 rows / $112,948.43 |
| whole-ledger `sumExpenseCents()` today | $164,818.03 |
| …if every outbound people transfer became spending | $336,575.46 — **+104.2%** |

**The Sankey does not move.** `buildFlowGraph()` routes a person row to the same
`person-out:` node whether it classifies as `transfer` or `expense`, and the reconciliation
holds either way. The six figures are at stake in **spending totals, budgets, the forecast
baseline, and net worth** — not in the picture the owner is looking at. That is worth
saying out loud before anyone changes the chart.

---

## 5. What genuinely needs owner intent — and the one question for each

Four questions. Nothing else in §1–§4 needs the owner.

1. **REMITLY — $120,562.36, 78 rows.**
   *"When you send money through Remitly, does it land in an account that is still yours,
   or has it become someone else's the moment it arrives?"*
   Data cannot answer this. It settles 46.8%-of-income worth of ledger.
   Follow-up only if the answer is "someone else's": the 4 rows the owner typed
   `Send to India` and the 1 they typed `Loan Repayment` say the line is not one thing.

2. **The 31 non-REMITLY one-way outbound lines — $53,624.00, biggest is $18,612.00.**
   *"When you send money to a person and nothing comes back — is that a gift, your share of
   something, or money you still expect back?"*
   Ask it **per counterparty**, not per row; 20 of the 31 are a single row and only the
   biggest few are worth a question at all.

3. **The 9 two-way counterparties — net $15,408.00 owed to the owner on the largest.**
   *"With this person, are you settling shared costs, or lending and being repaid?"*
   The app can propose the answer from `signFlips` and the ordering (§3.1) and should. It
   must not decide it.

4. **The 40 inbound-only lines — $57,216.78, 27 of them single rows, and only 6 of the 40
   currently reach the review queue at all.**
   *"Money arriving from a person that you never sent anything to — is that someone paying
   you back, or income?"*
   FIN-INCOME-001's default already answers it safely (not income). The question exists so
   the queue can be *cleared*, not so a number changes.

---

## 6. Proposed model

**The ladder was run. Almost nothing new is needed.** The taxonomy, the link model, the
grouping surface, the confirm record and the rule scope for this feature all already exist
and are unused. FIN-SETTLEMENT-003 should be four small additions to existing machinery,
not a counterparty subsystem.

### Already present — do not rebuild

| need | what already exists |
|---|---|
| the meanings | `FinancialMeaning` already has `shared_expense`, `reimbursable_expense`, `shared_expense_reimbursement`, `receivable_repayment`, `gift_or_personal_transfer`, `loan_proceeds`, `sale_proceeds`. **No new enum value is required.** |
| the pairwise link | `LINK_TYPES` already declares `reimbursement_for` and `repayment_of`. No generator emits them yet. `validateLink()`'s V1–V11 already cover them. |
| the counterparty identity | `signalOf()` in `mapping-suggestions.ts` already returns `{ signal: 'counterparty' }`, and `GROUP_SCOPES` already has `same_counterparty`. |
| the propose→confirm surface | `MappingGroup` / `MappingSuggestion` / `groupPreview()` / `confirmGroupMeaning()` / `markGroupUnknown()`. |
| the store | `users/{uid}/reviews/{transactionId}`. One decision record, unchanged. |
| the answer vocabulary | `GROUP_MEANINGS` already lists all three settlement answers. |

### The four additions

**(1) Let the people rows into the queue — a third `UnmappedKind`.**
`buildFlowGraph()` already returns `nodeTxnIds` keyed by `person-in:*` / `person-out:*`.
Add a `counterpartyRowIds?: readonly string[]` field to `UnmappedContext`, fed the same way
`unpairedLegIds` is fed today, and a `'counterparty_line'` member of `UnmappedKind`. This is
the whole fix for §4: **no new store, no new grouping code** — `signalOf()` already keys
these rows by counterparty. Groups then come out at ~81 questions, dominated by the ~10
that carry real money.

**(2) One new detector in `mapping-evidence.ts`, alongside `detectPayerSeries()`.**

```
detectCounterpartyLedger(rows) -> {
  outRows, inRows, outCents, inCents, netCents,
  signFlips,                      // 0-1 = lend-then-repay, >=2 = running tab
  firstDirection, settled,        // settled = netCents === 0
  spanDays, ownerCategories       // the owner's own non-Transfer Monarch labels
} | null
```

Pure, cents-only, shape-only, **no name list** — same discipline as every other detector in
that file. It is the direct output of §3.1 and it is the only new arithmetic in the feature.

**(3) Two new `SuggestionEvidence` kinds, additive.**

- `counterparty_settlement` — fires when a counterparty has rows in **both** directions.
  Proposes `receivable_repayment` when `signFlips <= 1` and the owner sent first;
  `shared_expense_reimbursement` when `signFlips >= 2`; nothing when the counts are 1-and-1
  and months apart. Confidence ladder over a 0.5 base, capped at 0.85 like `payroll_shape`,
  so it can never outrank the owner's own confirmed answer.
- `owner_stated_category` — fires when the owner's own Monarch category on a people row is
  something other than `Transfer`. Highest non-owner confidence available, because it *is*
  the owner's words. Covers 16 rows / $15,420.93 today, including 4 REMITLY rows.

**One-way lines get NO suggestion**, deliberately. §3.2 and §3.3 measured that no evidence
exists for them; `suggestFor()` returning `null` is already the correct and common answer
in this codebase.

**(4) The one change outside the mapping module — and it is the root cause.**

`interpretTransaction()` currently reads:

```ts
const confirmed =
  type !== 'transfer' && review?.state === 'confirmed' && review.meaning ? review.meaning : undefined;
```

That gate means **261 of the 284 people rows would ignore the owner's confirmed answer**,
because the provider called them `Transfer`. Every screen routes through this one function,
so this is where all callers meet and the fix is one predicate: a confirmed review may
override when the row names an **external counterparty** (`personFrom()` non-null and not
`isSelfPerson`). The provider saying `Transfer` means *money moved*; it does not mean *money
moved between accounts you own*, and only an external-counterparty row can tell those apart.
Every other transfer keeps the existing gate untouched.

### Explicitly NOT proposed

- **No `Counterparty` collection, no per-person entity, no balances document.** Net position
  is derivable on read from the ledger, exactly like `matchTransfers()` and the reason
  `internal_transfer_leg` is deliberately not a link type (`relations.ts:38`). A stored
  balance is a second, staler source of truth for money.
- **No `reimbursement_for` / `repayment_of` link generation in Phase 2.** Those link types
  are for allocating a *specific* inbound row against a *specific* outbound one. §2.2
  measured that same-amount pairing between people **does not occur** (0/77 within ±14
  days), so a generator would produce nothing. Build it if and when the owner asks to link
  a pair by hand.
- **No new `FinancialMeaning`.** The taxonomy already covers every answer measured here.
- **No auto-application, no threshold at which the app decides.** Same rule as everywhere
  else in this codebase.

---

## 6b. Phase 2 — what shipped, and what it measures on the real export

The owner answered the two blocking questions: **Remitly is "gone — it's an expense"**, and
the one-way named lines are **"ask me per person"**. Neither answer was applied. Both set
the DEFAULT a proposal carries; the owner still confirms, one group at a time.

Built exactly as §6 proposed, plus three guards the real data forced (below).

| | before | after |
|---|---|---|
| counterparty rows reaching the queue | 7 of 284 | **284 of 284** |
| outbound counterparty rows reaching the queue | **0 of 155** | **155 of 155** |
| counterparty money with a question attached | $6,163.00 | **$274,627.64** |
| groups in the queue | 80 | 165 |

**What the owner sees:** **85 `counterparty_line` groups** (277 rows, $274,627.64) alongside
the 7 that already arrived as unknown inflows. **18 carry a suggestion; 67 honestly carry
none.**

| | groups | amount | evidence |
|---|---|---|---|
| outflow | 41 | $187,178.36 | `owner_stated_category` ×9, none ×32 |
| inflow | 44 | $87,449.28 | `counterparty_settlement` ×8, `payroll_shape` ×1, none ×35 |

That 67-with-nothing figure is the honest one and it matches §3: 20 of the one-way outbound
keys and 27 of the inbound keys are a single row, and no evidence exists for them. The
owner's "ask me per person" is satisfied by a per-counterparty group, not by a default.

**Three guards, each fixing the same category error.** Wiring the person lanes in put 85 new
groups in front of rungs that had never seen a person-to-person row, and each answered with
something structurally impossible:

| rung | wrong answers it gave | why it is wrong |
|---|---|---|
| `refund_candidate` | **30** inflow groups | a refund reverses a *purchase*; both legs of a person row carry the same transport string ("Zelle"), the same collision that cost the FIN-FLOW-001 audit $2,000 |
| `same_day_opposite_leg` | **5** groups, one of them 10 rows / $11,064 | a row naming an external party is not money between accounts the owner holds — `signalOf()` has already said the opposite |
| `interpretTransaction()`'s confirm veto | would have ignored **261 of 284** confirmations | the provider's `Transfer` means "money moved", not "money moved between accounts you own" |

`payroll_shape` fires on one inflow group and was **deliberately left alone**: a named
individual paying on a cadence into a deposit account really is that shape, and
`earned_income` is a suggestion the owner confirms, not an assertion.

**Confirming the Remitly proposal** (78 rows, $120,562.36, suggested `personal_expense` at
0.71 confidence from the owner's own category words plus the one-way evidence):

- 73 rows move `internal_transfer` → `personal_expense`; 5 were already `personal_expense`.
- Lifetime spending **$164,818.03 → $277,766.46** (+$112,948.43, **+68.5%**).
- **The Flow chart does not move** — links and nodes byte-identical. `buildFlowGraph()`
  reads `classifyTransaction()`, which never re-derives a provider transfer. Confirming
  changes totals, budgets and the forecast baseline, not the picture.
- **Undo is "I can't classify these"**, the terminal answer the card already offers: it
  writes `dismissed`, which is not `confirmed`, so every row falls back to exactly the
  derived behaviour. Answering the group back to `internal_transfer` is a *different
  answer*, not an undo — it also suppresses the 5 rows the importer had already made
  spending, taking the total to $157,204.10.

## 7. What this measurement could NOT settle

Stated plainly so nobody later mistakes silence for evidence.

1. **Whether Remitly money is still the owner's.** No row describes the far side. Owner
   intent, question 1 in §5. Everything *else* about Remitly is settled: it left all nine
   accounts, none of it returned, ever.
2. **What kind of two-way relationship each of the 9 counterparties is.** The shape is
   measurable; the meaning is not.
3. **Whether any one-way outbound line is a gift, a share, or an unpaid loan.** No return
   flow exists to distinguish them and 20 of 31 are single rows.
4. **Whether the export is complete for these lines.** The ledger already carries a
   "not in your data yet" plug; nothing here narrows it.
