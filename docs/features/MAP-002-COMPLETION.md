# MAP-002 — Intelligent Analysis — completion

Branch `feat/map-002-intelligent-analysis`, off `d6f72a9`.

MAP-001 collapsed 332 unmapped rows into 80 answerable groups and then said *"no
evidence, you decide"* for almost all of them. Everything the owner and an agent worked
out by hand in an hour — *that payer is an employer, that series stopped in May, five
paychecks are missing, that credit already has a refund proposal, that deposit is a loan*
— was derivable from the ledger. This task derives it.

**Headline, measured on the real export read-only:** of the **50 unknown-inflow groups,
32 now carry a suggestion, against 5 before** (the task brief's estimate was ~2). Across
all 80 groups: **46 of 80, against 17**.

| | before | after |
|---|---|---|
| unknown-inflow groups with a suggestion | 5 / 50 | **32 / 50** |
| unpaired-leg groups with a suggestion | 12 / 30 | **14 / 30** |
| of which came from the rung that was WRONG | 17 | 14 (and only where both legs are owned) |
| groups carrying an informational finding | 0 | 2 |
| groups offering a pre-filled income source | 0 | 3 |

---

## 1. The bug: salary was being called an internal transfer

`same_day_opposite_leg` suggested `internal_transfer` at **0.9 confidence** whenever a row
had "the same amount going the other way in another account on the same day". It never
consulted the account list at all — *any* other `accountId`, owned or not, qualified as
"another account of yours".

Measured against the PHXAgile shape (21 semi-monthly salary deposits over twelve months,
each swept the same day into a second owned account), captured by running the fixture
against the baseline module:

```
BASELINE : EVIDENCE=same_day_opposite_leg  MEANING=internal_transfer  CONF=0.9   ROWS=21
FIXED    : EVIDENCE=payroll_shape          MEANING=earned_income      CONF=0.85  ROWS=21
```

Salary lands and is immediately moved on to meet an obligation. The signature is
identical to a transfer; the meaning is the opposite.

**Two guards, both derived, both required:**

1. **Both accounts must be ones the owner holds.** `accounts` is now consulted on both
   legs. An inflow whose counterpart sits in an account the owner does not hold is not a
   leg of anything.
2. **A payer who pays on a cadence is an EXTERNAL PAYER.** Their money arriving and then
   being spent is two facts, not one movement. This guard stands on its own rather than
   relying on the payroll rung running first — the payroll rung declines for a payer who
   pays into a card, and the answer there is still *not a transfer*, not *probably a
   transfer*.

Regression tests: `E1` in `src/__tests__/mapping-evidence.test.ts` — the PHXAgile shape is
not a transfer, an unowned counterpart yields no suggestion at all, a cadenced payer is
refused even when the payroll rung stands down, and a genuine one-off move between two
owned accounts still works.

---

## 2. The detectors

New module `src/lib/mapping-evidence.ts`. Pure, no I/O, no clock, **no vendor list and no
name list** — asserted the same way `service-identity.ts` is, extended with MAP-002's own
temptations (lenders, employers, tax agencies).

### 2.1 Payroll shape → `earned_income` + an income-source offer

Signals, all facts on the rows: one payer · a cadence from `detectRecurring()`'s rule set
· a deposit account · at least two distinct months.

The **cadence rules are not reinvented** — `detectPayerSeries()` is `detectRecurring()`'s
rule set applied to the other side of the ledger: ≥ 3 unique days, median ≥ $5, median gap
inside a `BANDS` band, ≥ 60% of gaps in that band.

**The one rule that had to move, and why.** `detectRecurring()` also requires the amounts
to sit within 25% of their median. The owner's real 21-payment salary series scatters
**44%** around its median — small extra payments from the same employer land in the same
merchant group as the paychecks. Gating on 25% rejected the very series the detector
exists to find. So the amount band survives as a **confidence signal** (`bandTight`), not
a gate: a tight band scores +0.1 and the sentence reads *"typically $X"*; a scattered one
is still found and reads *"varying around $X"*.

Confidence ladder — four independent signals over a base of 0.5, capped at 0.85 so
inference can never reach the 0.9 an owner's own confirmed answer carries:

```
0.5  base
+0.1 six or more payments
+0.1 six or more distinct months
+0.1 amounts inside detectRecurring()'s 25% band
+0.05 80% or more of gaps inside the cadence band
```

**Fired on the real export: three series.**

| rows | window | cadence | confidence | endDate | still running |
|---|---|---|---|---|---|
| 18 | 2024-05-31 → 2025-05-30 | monthly | 0.80 | **2025-05-30** | no |
| 21 | 2025-06-19 → 2026-03-06 | biweekly | 0.75 | 2026-03-06 | no |
| 7 | 2026-04-07 → 2026-07-07 | biweekly | 0.75 | *none* | **yes** |

The first is the employer the owner remembered as ending *"about April 2025"*. The ledger
says **2025-05-30**, and the app now says it too.

### 2.2 `endDate` — how a stopped series is decided

`seriesEndDate()` reuses `detectRecurring()`'s own *still active* test rather than
inventing a second staleness rule: a series is alive if it was seen within **1.5 of its
own cycle length** — so a quarterly series is not declared dead at the 45-day mark a
monthly one would be. It is measured against the **ledger's last day**, never the wall
clock: an export that ends in May must not make every series look dead.

Stopped → `endDate` is the last occurrence and the offer is `isActive: false`. Still
running → no `endDate` at all. Both cases are tested.

### 2.3 Missing periods — a finding, never a candidate

For a detected series, each real gap is divided by the series' median gap and rounded: one
cycle is a payment that arrived, two cycles is one that did not. Counting this way rather
than walking a fixed grid from the first date is what stops semi-monthly pay — whose gaps
alternate 13 and 16 days — accumulating drift into phantom absences. Nothing after the
last occurrence is counted; a series that simply stopped is answered by `endDate`, not by
claiming a year of missed pay.

Surfaced as `MappingGroup.findings` — rendered with **no button**, because there is nothing
to confirm. It tells the owner their import may be incomplete.

**Reported on the real export: 2 groups, 1 absent payment each** — `2025-01` for the
2024→2025 employer, `2026-01` for the 2025→2026 one.

> This is fewer than the ~5 the hand analysis estimated, and the reason is worth
> recording: the hand analysis attributed a semi-monthly cadence to the 2024→2025 payer.
> Measured over the whole ledger, that payer has **18 rows on 14 unique days with a median
> gap of 29 days** — monthly. The semi-monthly payer with 21 unmapped rows (26 in the
> ledger, median gap 15) is a **different, later employer**. The detector reports what the
> ledger shows. `2025-01` is one of the three months the hand analysis flagged.

### 2.4 Refund shape → FIN-REFUND-001's own generator

`refundEvidenceFor()` does **no matching**. It reads `generateRefundCandidates()`'s output
— the proposals live on `proposedLinks`, whose `sourceTransactionId` is the credit — and
cites the generator's own score as the confidence, capped at 0.9. Candidates the owner has
already decided are not evidence of an open question.

`/flow` hands over the run it already computes for the recovery queue, so there is one
refund matcher and one result. A caller that passes nothing gets the generator called once
here rather than silently losing the evidence.

**Fired on the real export: 25 unknown-inflow groups and 3 leg groups**, out of 428
candidates over 380 evaluated credits. This is the single largest contributor to the
headline number, and every one of those groups previously read *"you decide"* while the
answer sat one screen away.

### 2.5 Loan proceeds → a new meaning

Two derived routes, neither needing a lender's name:

- the payer is one of the owner's **own** `personal_loan` accounts (their account list,
  not a catalogue) — 0.75, or 0.85 with repayments too;
- money went back to that payer afterwards, **repeatedly and on a cadence**, for far less
  each time than arrived — 0.7.

The size guard (the credit must be ≥ 3× the median repayment, and ≥ $1,000) is what keeps
a refund out: a refund is never many times larger than the payments that follow it,
because there are no payments that follow it.

**Fired on the real export: 1 group, confidence 0.70** (the repayment route — the CSV
replay's account list carries no loan accounts, so the owned-account route could not
apply there; it does in the app, where the loan account exists).

### 2.6 Government/tax refund — DELIBERATELY NOT BUILT

The brief allowed for it *"derived from payer shape and cadence, not a list of agency
names — if you cannot do it without a name list, DO NOT DO IT"*.

It cannot be done. An annual cadence needs three occurrences under this app's own rule set,
which is three years of data; the export spans about two. And even with three, nothing
distinguishes an annual credit from a tax agency from an annual bonus, an insurance
dividend or a birthday gift **except the agency's name**. A name list is the one thing
this codebase consistently refuses. Those groups are left unsuggested.

---

## 3. `loan_proceeds` — added, additively

Added to `FINANCIAL_MEANINGS` in `src/types/index.ts`. It needs its own value because it
is the only credit that **creates a liability**: a refund returns money already spent, a
gift is kept, a sale converts an asset; loan proceeds arrive with an obligation to send
them back.

- `countsAsEarnedIncome('loan_proceeds')` → **false**. Borrowing is not earning, and
  `FINANCIAL_MEANINGS.filter(countsAsEarnedIncome)` is still exactly `['earned_income']`.
- `personalCostSign('loan_proceeds')` → **0**, decided deliberately. The borrowing is
  neither a cost nor a cost returning; the repayments are the cost, and they are their own
  rows. Signing it `-1` would net borrowed money against spending and understate the
  owner's costs.
- Nothing broke: there is no `Record<FinancialMeaning, …>` and no exhaustive `switch` on
  the type anywhere in `src/` or `functions/src/`. `tsc --noEmit` is clean.

---

## 4. Honesty rules held

- Every suggestion carries an evidence kind, a `supportCount` of real ledger facts, a
  confidence from an explainable ladder, and **one checkable sentence**. Asserted for
  every evidence kind: no mid-sentence full stop, no trailing full stop, confidence in
  `(0, 0.9]`.
- `null` is still a common and correct answer — 18 of 50 inflow groups get nothing,
  including two multi-row groups whose gaps fail `detectRecurring()`'s 60%-in-band rule.
  Irregular is not a cadence.
- **Nothing auto-applies.** A suggestion never touches a row or a review record. The
  income source is a **proposal with no id**, shown behind a checkbox that defaults to
  off, and reaches `addIncomeSource` only when that box is ticked *and* the chosen meaning
  is the one the offer was derived for.
- Observability reuses OBS-001: `Mapping.GroupsBuilt` gains `byEvidence`, `withFinding`
  and `withIncomeSourceOffer` — **counts of this module's own vocabulary words**, never a
  merchant, a counterparty, an amount or an id.

---

## 5. Verification (observed)

| command | result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx jest` (no CSV) | **940 passed, 7 skipped, 947 total**, 56 suites |
| `npx jest` (CSV symlinked) | **947 passed, 947 total**, 57 suites |
| conservation | `ties the closing total to net worth −$3,641.38` ✓ before and after |
| `npm run build` | passes |
| `npm test --prefix functions` | 26/26 |
| `npx eslint src` | 149 problems (53 errors, 96 warnings) — **unchanged**; `react-hooks/rules-of-hooks` **0**, set-state-in-effect **0** |
| python | 62 OK (`unittest discover`, integration interpreter, read-only) |

Baseline was 919 tests / 149 eslint / 0 hooks. **+29 tests** (28 new in
`mapping-evidence.test.ts`, +1 net in `mapping-suggestions.test.ts`).

---

## 6. Deviations, and why

1. **Three MAP-001 tests changed.** Two of them asserted behaviour this task exists to
   change: three equal monthly deposits from one payer into a checking account used to be
   "no evidence" and are now a payer series. The tests were rewritten to say so honestly —
   one now uses a genuinely evidence-free fixture (irregular dates, unrelated amounts), the
   other asserts that the payroll shape is found *and* that the owner's approved source
   still outranks it. The third, the no-vendor-list assertion, moved from substring to
   word-boundary matching: `"PURCHASE"` contains `"CHASE"` and `"FIRST"` contains `"IRS"`,
   and a test that cannot tell a bank from a purchase is a test nobody trusts.
2. **The amount band became a signal, not a gate** (§2.1) — forced by the measured 44%
   scatter in the owner's own salary series.
3. **The government-refund detector was not built** (§2.6).
4. **No size floor on the payroll shape.** A small regular deposit scores the same as a
   salary. Marked `ponytail:` in the source; the upgrade path if it proves noisy is a
   floor derived from the ledger's own inflow distribution, never a hard-coded figure.
5. **`refundCandidates` has a fallback.** Absent and with accounts present,
   `generateRefundCandidates` is called inside `buildMappingGroups` — one extra run for a
   caller that has not wired it. `/flow` passes its own, so the app pays nothing.
