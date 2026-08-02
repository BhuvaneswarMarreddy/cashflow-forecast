# FIN-REFUND-001 — Completion report

**Status:** COMPLETE, unmerged. Two new library modules, four new test suites, no
existing file modified.

**Baseline commit:** `63839d5` (tag `INTEGRATION_BASELINE_AFTER_RELATION`) on
`feat/transfer-type-monarch-ingest`. `main` is stale and was never used.

**Branch:** `feat/fin-refund-001-return-linking`
**Worktree:** `../cashflow-forecast-fin-refund-001`
**Final commit:** see `git log -1` on the branch (this doc is the last commit).

> **Note on the report template.** The task brief asks for this report "per umbrella §35".
> `docs/features/REFUNDS-RETURNS-AND-DUPLICATES.md` has sixteen sections and no §35, so the
> structure below follows `FIN-RELATION-001-COMPLETION.md` — the established pattern in this
> programme — plus every heading the brief enumerates.

---

## 1. Files changed

| File | New? | Lines |
|---|---|---|
| `src/lib/card-credit.ts` | new | 271 |
| `src/lib/refunds.ts` | new | 617 |
| `src/__tests__/card-credit.test.ts` | new | 33 cases |
| `src/__tests__/refunds.test.ts` | new | 38 cases |
| `src/__tests__/refund-economics.test.ts` | new | 14 cases |
| `src/__tests__/refund-flow-contract.test.ts` | new | 6 cases |
| `docs/features/FIN-REFUND-001-COMPLETION.md` | new | this file |

`git diff --stat 63839d5` over tracked files is **empty**: every one of the six code files is
an addition. No read-only file, no closed file, no other worktree and no file in the
integration directory was touched. `src/lib/refund-analytics.ts` was **not** created — spec
§12.2 lists two library files and `netCategorySpendingCents()` belongs with the economics it
derives from. Fewer files, one source of truth.

## 2. Business rules encoded

1. **A credit-card credit is NEVER automatically earned income.** Enforced structurally, not
   by a branch (§3 below).
2. **A refund reverses economic cost.** It is not income: it raises bank cash, lowers card
   liability, and both rows stay in history linked by an explicit allocation.
3. **Gross history is never destroyed to show net.** Neither module writes to a transaction
   document. `grossPurchaseCents` is read from the row every time; net is derived.
4. **Nothing auto-applies.** No `REFUND_AUTOCONFIRM_THRESHOLD` exists. Every candidate is
   emitted `unreviewed`; no score, at any confidence, writes a link.
5. **Provisional dispute credits reduce no final spending.** A chargeback credit is money the
   bank may take back; subtracting it would report a saving the owner has not made.
6. **Card-payment pairing outranks refund matching.** A $300 credit that coincides with a
   $300 purchase is debt settlement, and generates no refund candidate.
7. **Nothing is silently clamped.** Over-allocation is refused by FIN-RELATION-001's V5 or
   surfaces as the explicit `over_refunded` state.

## 3. The ten kinds and the total function

`CardCreditKind` and its ten values are **imported** from `src/lib/relations.ts`.
FIN-RELATION-001 merged first and owns the parser that validates the list, so declaring a
second copy is exactly the duplicate-source-of-truth defect this programme exists to remove.
The inflow taxonomy is FIN-INCOME-001's `FinancialMeaning`, imported through `src/lib/classify.ts`.

```
card_payment        -> internal_transfer
merchant_refund     -> refund
partial_refund      -> refund
charge_reversal     -> refund
chargeback_credit   -> refund                     (provisional; see §6)
statement_credit    -> other_non_income_credit
cashback_reward     -> other_non_income_credit
promotional_credit  -> other_non_income_credit
manual_adjustment   -> other_non_income_credit
unknown_card_credit -> unknown_inflow
```

`CARD_CREDIT_TO_INFLOW_MEANING` is `Record<CardCreditKind, FinancialMeaning>` — **total** by
type. `earned_income` is not in its range, so no card credit can become earned income by any
path through this module, and adding an eleventh kind without deciding its meaning is a
compile error rather than a silent default. Test D1 proves it by enumerating all ten keys.

**The taxonomy name differs from the spec.** §3.3 imports `InflowMeaning`; FIN-INCOME-001
actually shipped `FinancialMeaning` (`src/types/index.ts:249`, re-exported from
`src/lib/classify.ts:578`). Same concept, same values, different name — the spec was written
before FIN-INCOME-001 merged. Nothing else changed.

## 4. The evaluation ladder, as built

First rung that holds wins. Rule order is load-bearing; D13 asserts it rung by rung.

| # | Rung | Evidence | Kind | Confidence |
|---|---|---|---|---|
| 1 | card-payment pair | `interpretTransaction().transfer === 'card_settlement'`, **or** `matchTransfers()` paired the row, **or** a `confirmed` `card_payment_pair` link | `card_payment` | 0.9 / 1.0 |
| 2 | confirmed merchant refund | `confirmed` `refund_of` / `partial_refund_of` sourced here | `merchant_refund` / `partial_refund` | 1.0 |
| 3 | confirmed reversal | `confirmed` `reversal_of` | `charge_reversal` | 1.0 |
| 4 | chargeback | `confirmed` **or** `provisional` `chargeback_for` | `chargeback_credit` | 0.8 / 1.0 |
| 5 | reward split | `isReward()` true, sub-split by text | `statement_credit` / `promotional_credit` / `cashback_reward` | 0.6 |
| 6 | manual adjustment | non-empty `sources` naming no provider, or `userEdited.amount === true` | `manual_adjustment` | 0.7 |
| 7 | fallthrough | nothing above held | `unknown_card_credit` | 0.3 |

Two properties this buys, both tested:

- **Rungs 2–4 require a CONFIRMED link**, so an unconfirmed suggestion cannot change a row's
  classification. The ladder literally cannot see a `suggested` link (D12).
- **Rung 1 fires before rung 2 ever looks** (D10), and generates no refund candidate.

`isReward()` and `isCardSettlement()` are consumed unchanged. `interpretTransaction()` is the
only source of settlement detection — none of it is re-implemented.

## 5. Candidate selection and scoring

**Selection.** A credit qualifies when it is posted, its direction is `inflow`, its kind is
one of `{merchant_refund, partial_refund, charge_reversal, unknown_card_credit}` (or it sits
on a non-debt account and `isRefund()` is true), and it is not already the source of a
confirmed link. Settlements and rewards are excluded — they are refunds of nothing.

**Window.** Posted outflows dated in `[D − 180 days, D + 5 days]`, same normalized merchant,
same account preferred, purchases with no remaining unrefunded balance dropped, top **12** by
score.

**Scoring ladder** — deterministic, explainable, hand-written; never merchant text alone
(every tier requires an amount relationship):

```
1.00  exact cents, same merchant, <= 30 days
0.85  exact cents, <= 90 days
0.70  exact cents, <= 180 days
0.60  exact combined sum
0.50  partial (credit < purchase), <= 90 days
0.35  partial, <= 180 days          [spec silent; tapered on the same shape as `exact`]
0.30  merchant matched by alias only
      then: −0.20 if the refund is on a DIFFERENT account
```

Confidence bands: `high >= 0.8`, `medium >= 0.5`, `low < 0.5`. **High-confidence candidates
may be preselected but always require confirmation.** Ties break by fewest purchases, then
closest date, then transaction id ascending.

**Ambiguity.** If two or more candidates for one credit score within `0.05`, all of them are
marked `ambiguous_match` and none is presented as the answer.

## 6. The combined-refund algorithm and its measured bound

DFS over **integer cents**, descending sort, two prunes (`runningSum + next > target`;
`runningSum + remaining < target`), size cap 4, result cap 5, subsets of size 1 excluded
(that is a `refund_match`). Ranked: exact sum → fewest purchases → same account → closest
dates → strongest reference overlap → ids ascending.

**The bound is measured, not asserted in prose.** `findCombinations()` returns
`subsetsVisited`, an instrumented counter of every subset the walk actually forms.

| Fixture | Credits (R) | Subsets | Per credit |
|---|---|---|---|
| 1,000 rows | 40 | 422 | 10.6 |
| 2,000 rows | 80 | 1,219 | 15.2 |
| 5,000 rows | 200 | 2,758 | 13.8 |

Per-credit work is bounded and does not grow with the ledger — 5x the rows does not multiply
it. Adversarial single-credit worst cases (twelve identical purchases against a target no
subset can hit, which defeats both prunes for longest):

| Target | Subsets formed |
|---|---|
| 3500 | 219 |
| 4500 | **494** (the highest observed) |
| 5500 | 329 |
| 11500 | 4 |

`Σ(k=1..4) C(12,k) = 12 + 66 + 220 + 495 = 793` is asserted arithmetically and holds as an
**upper bound that is never met** — the worst case actually observed is 494. There is no
exponential term and no `n²` term.

> **A correction to the first version of this test.** The original 5,000-row fixture reported
> `subsetsVisited = 0`: every credit found an exact single-purchase match, which
> short-circuits the combined walk, so the bound assertion passed against a counter that had
> counted nothing. Mutation testing caught it. The fixture now makes every credit larger than
> every single purchase at its merchant, so the walk genuinely runs, and the test asserts
> `subsetsVisited > 0` before asserting the bound.

**Measured complexity, stated honestly.** Indexing is one `O(n)` pass plus an `O(b log b)`
sort per merchant bucket. Per credit: `O(log b)` binary search to the window start, `O(w)`
over the window, `O(K log K)` to sort and cap at 12, and `≤ 793` bounded subset evaluations.
Total `O(n log n + R·(log b + w + K log K + 793))`. The spec's §5.3 states `O(n + R·c)`; that
is the same shape but omits the `w` term, which is real — the window scan is bounded by how
many purchases share one merchant, not by a constant. It is not an `n²` term over the ledger
and no pairwise comparison happens outside a merchant×account bucket capped at 12.

## 7. Economics, statuses and transitions

```ts
grossPurchaseCents                    // never changes, never written back to the row
confirmedRefundedCents                // Σ CONFIRMED refund_of | partial_refund_of | reversal_of | chargeback_for
provisionalRefundedCents              // Σ PROVISIONAL chargeback_for
netEconomicCostCents                  // gross − confirmed  (provisional deliberately absent)
netEconomicCostIfDisputeUpheldCents   // net − provisional; render only beside the word "provisional"
```

Refund side: `refundAmountCents`, `allocatedRefundCents`, `unallocatedRefundCents`.

**How provisional credits stay out of final net spending:** `netEconomicCostCents` is computed
from `confirmedRefundedCents` alone. `provisionalRefundedCents` accumulates in its own field
and is subtracted only into the separately named `netEconomicCostIfDisputeUpheldCents`, which
never feeds Analytics, Budgets or the forecast baseline. N3 and N4 pin both halves.

| Status | Condition | Label |
|---|---|---|
| `not_refunded` | `confirmed === 0` | (no badge) |
| `partially_refunded` | `0 < confirmed < gross` | "Partially refunded" |
| `fully_refunded` | `confirmed === gross` | **"Returned"** |
| `over_refunded` | `confirmed > gross` | "Over-refunded — needs review" |
| `provisional_dispute_credit` | `provisional > 0` | "Provisional dispute credit" |

`provisional_dispute_credit` **composes**: `statuses` is an array, so a purchase can be
`partially_refunded` *and* carry a provisional credit without either collapsing the other (N7).

**Chargeback lifecycle.** provisional → `provisionalRefundedCents` rises, net does **not**
move → confirmed → provisional falls to 0, confirmed rises, net moves **exactly once** →
reversed_again: the bank's reversal arrives as a *new charge*, the link becomes `rejected`,
and all three rows remain. Nothing is ever deleted (N5, N6).

A purchase is **never** marked fully returned on a provisional credit alone.

## 8. Data model

FIN-RELATION-001's, consumed and never forked: `TransactionLink`, `LinkType`, `LinkStatus`,
`ReviewCandidate`, `ProposedLink`, `CandidateEvidence`, `buildIdentityKey`,
`buildCandidateId`, `mergeCandidateRun`, `rankCandidates`, `sanitizeEvidence`,
`confirmedAllocatedFromSource`, `linkIndex`, `validateLink`, `toTxRef`, `REFUND_SOURCE_TYPES`,
`CARD_CREDIT_KINDS`, `CardCreditKind`. This task declares **no** link model, **no** candidate
model and **no** taxonomy of its own, and writes to no collection.

## 9. Algorithm versioning

`refund-match-v1` (exact, partial, unknown) and `combined-refund-v1` (the walk), stamped onto
`ReviewCandidate.algorithmVersion` and `candidateId`. A version bump re-evaluates **only**
`unreviewed` candidates and can never reinterpret a confirmed decision — that is
`mergeCandidateRun()`'s guarantee, used as-is and not re-implemented. The document id carries
no version, so a dismissed candidate cannot resurface on a bump (M14 asserts the suppression).

## 10. Privacy controls

- Reuses OBS-001 (`emit`, `startSpan`). No second telemetry system, no `console.log` of any
  financial payload.
- Events: `CardCredit.Classified` (kind, rung, confidence), `Refund.CandidateGenerated`
  (counts, versions, duration, `creditsEvaluated`, `subsetsVisited`), and
  `Refund.MatchConfirmed` / `Refund.AllocationAdjusted` / `Refund.MatchRejected` via the
  exported `emitRefundDecision()` helper, for the surfaces that own the owner's decisions.
  One span, `Refund.GenerateCandidates`; one event per run, never one per candidate.
- **Never logged:** descriptions, titles, merchant strings, amounts as free values, account
  names or numbers, `lastFourDigits`, provider payloads, credentials, tokens, AI context.
- Reference-overlap analysis runs locally on strings already in memory; only the enum
  `strong | weak | none` is stored, never the tokens. `sanitizeEvidence()` is applied to every
  candidate's evidence, so a generator that spread a working object could not ship merchant
  text into the collection.
- No production data was read. No test signs in, reads Firestore, triggers a sync or writes to
  a live collection. Every fixture is invented.

## 11. Tests

**766 total (759 passed, 7 skipped) across 44 suites**, up from the baseline's **675
(668 passed, 7 skipped) across 40 suites** — **+91 tests, +4 suites**.

| Suite | Spec | Cases |
|---|---|---|
| `card-credit.test.ts` | D1–D14 | 33 |
| `refunds.test.ts` | M1–M21 | 38 |
| `refund-economics.test.ts` | N1–N7 | 14 |
| `refund-flow-contract.test.ts` | G1–G4 | 6 |

The 46 specified cases expand to 91 jest cases through `it.each` tables and multi-assertion
splits (D1, D2, D3, D13, N2, M20).

**No existing expectation was rewritten.** `git diff --stat 63839d5` over tracked files is
empty — the 675 baseline tests are byte-identical and were re-run unchanged.
`cross-surface-consistency.test.ts` still passes with `EXPECTED_EXPENSE_CENTS = 22920` and
`EXPECTED_INCOME_CENTS = 320000`.

### Mutation testing — the tests were checked for vacuity

Green on the first run is a warning sign, so six deliberate defects were injected and the
suites re-run:

| Mutation | Caught |
|---|---|
| provisional credits reduce `netEconomicCostCents` | ✅ 4 failures (N3, N4, N5, N7) |
| a `suggested` link counts as confirmed | ✅ 2 failures (M18, M21) |
| confirmed refund link (rung 2) evaluated before the card-payment pair | ✅ D13 |
| scores ≥ 0.9 auto-confirm | ✅ 4 failures (M1, M11 ×2, M13) |
| pending holds generate candidates | ✅ 2 failures (M12, M14) |
| the combined walk accepts a ±1 cent tolerance | ❌ **initially survived** |

The last one exposed a genuinely weak test: M6's original fixture (`[3000, 1999]` against
`5000`) is killed by the "cannot reach the target" prune before any subset is formed, so the
equality check was never reached. M6 now carries a third purchase that keeps the remaining sum
above the target, forcing the walk to form `4999` and reject it on exactness alone. The mutant
is caught. M20 was strengthened for the same reason (§6).

## 12. Build result — actual observed output

| Command | Observed |
|---|---|
| `npx tsc --noEmit` | clean, exit 0 |
| `npx jest` | `Test Suites: 1 skipped, 43 passed, 43 of 44 total` · `Tests: 7 skipped, 759 passed, 766 total` |
| `npm run build` | `✓ Compiled successfully in 3.4s` · `✓ Generating static pages (19/19)` |
| `npm test --prefix functions` | `Test Suites: 3 passed` · `Tests: 26 passed, 26 total` |
| `python -m unittest discover -s functions-sync` | `Ran 62 tests in 0.048s` · `OK` |
| `npx eslint` (the six new files) | 0 errors, 0 warnings |

The Python interpreter is the integration directory's gitignored venv
(`../cashflow-forecast/functions-sync/venv/bin/python`), run **read-only** against this
worktree's sources. `git status --porcelain` in the integration directory is empty afterwards.
`pytest` is not installed locally, hence the `unittest` form.

react-hooks lint: **unchanged** — this task adds no React code. The repository's 153
pre-existing lint findings (57 errors, 96 warnings) are all in files this task did not touch;
none is in the six new files.

## 13. Known limitations

1. **Merchant family is exact-normalized-merchant only.** FIN-DUPLICATE-001 is unmerged, so
   `src/lib/service-identity.ts` does not exist at this baseline. Per spec §12.3 the matcher
   falls back to exact `normalizeMerchant()` equality and creates **no** copy of the
   service-identity model. The `family` and `alias` scoring tiers are therefore unreachable
   today; they light up when the import is added after FIN-DUPLICATE-001 merges.
2. **A credit with no same-merchant purchase in its window produces no candidate.**
   FIN-RELATION-001's identity requires 2..13 transaction ids, and a wholly unexplained credit
   has only itself. It still classifies as `unknown_card_credit` through
   `classifyCardCredit()`, so FIN-RECOVERY-UI-001 can surface it from the classification —
   there is simply no *relationship* to review.
3. **`budgets.ts` is not wired to net.** Spec §12.1 precondition 8 leaves budget consumption
   out of scope; `netCategorySpendingCents()` is exposed here and M16/M18 assert against it,
   but `getCategorySpending()` still returns gross. Recorded, not silently dropped.
4. **The combined walk stops at 5 results before the §5.5 refusals are applied**, so a run
   where several of the first five are refused returns fewer than five rather than
   backfilling. Faithful to §5.2 step 5; a backfill would need the walk to over-collect.
5. **`Refund.MatchConfirmed` / `AllocationAdjusted` / `MatchRejected` are not yet emitted by
   anything.** The owner's decisions happen in `relations-store.ts` and `chat-actions.ts`,
   both closed to this task. `emitRefundDecision()` is exported for FIN-RECOVERY-UI-001.
6. **No UI, by design.** No `/flow` change, no component, no review queue.
7. **`over_refunded` is reachable only through an explicit `allow: ['over_refunded']`** on
   FIN-RELATION-001's validator; `purchaseEconomics()` reports the state but never creates it.

## 14. Manual verification

**None performed, and none is possible** without production data or a signed-in session, both
of which this task is forbidden to use. Every claim in this report is either an observed
command output (§12) or a test (§11).

The owner-run validation procedure in `REFUNDS-RETURNS-AND-DUPLICATES.md` §11 remains
outstanding. It is manual and read-only, and the structural pattern it confirms is exactly
what M3/M4 encode.

## 15. Overlapping files

| File | Status |
|---|---|
| `src/lib/card-credit.ts`, `src/lib/refunds.ts` | **owned exclusively by this task.** |
| `src/lib/duplicates.ts`, `src/lib/service-identity.ts` | FIN-DUPLICATE-001's. Neither created, edited nor duplicated. |
| `src/lib/flows.ts` | **not touched.** `toCents`, `day`, `normalizeMerchant`, `daysBetween`, `detectRecurring` imported read-only. The one-token `BANDS` export is FIN-DUPLICATE-001's and was left alone. |
| `src/lib/chat-actions.ts`, `functions/src/prompts.ts`, `firestore.rules` | **closed.** Not opened. No parser action added. |
| `src/types/index.ts`, `classify.ts`, `forecast.ts`, `firestore.ts`, `UserProfileContext.tsx`, `fingerprint.ts`, `functions-sync/*`, `budgets.ts` | read-only; imported, never written. |
| `src/app/flow/page.tsx`, every review component | FIN-RECOVERY-UI-001's. No UI added. |
| `src/lib/relations.ts`, `candidates.ts`, `relations-store.ts` | FIN-RELATION-001's; consumed, never modified. |

File ownership with FIN-DUPLICATE-001 (`feat/fin-duplicate-001-charge-detection`) is
**disjoint**. The two branches share no file.

## 16. Merge recommendation

**Merge.** It is additive and moves no existing number: six new files, zero modifications, the
675 baseline tests byte-identical, `cross-surface-consistency.test.ts` unchanged, Flow
conservation asserted unchanged (G1), and `buildFlowGraph()` untouched.

Order relative to FIN-DUPLICATE-001 does not matter — disjoint files, no conflict. After
FIN-DUPLICATE-001 merges, one follow-up import (`service-identity.ts`) widens merchant scope to
families; limitation 1 tracks it.

FIN-RECOVERY-UI-001 should merge after both.

## 17. Deployment impact

**Zero at runtime.** Two pure modules that nothing calls yet.

- No migration, no backfill, no rewritten document.
- No new collection and no new index — this task writes to no collection at all.
- No Firestore rules change. FIN-RELATION-001's rules must still be deployed before any
  consumer writes links or candidates.
- No new dependency. Bundle shape unchanged: 19 routes, same set as the baseline.
- Nothing displayed changes until FIN-RECOVERY-UI-001 renders it.

---

## Appendix — spec deviations, with reasoning

| # | Deviation | Reasoning |
|---|---|---|
| 1 | **`FinancialMeaning`, not `InflowMeaning`** | Spec §3.3 imports `InflowMeaning` from "FIN-INCOME-001's module". What actually shipped is `FinancialMeaning` (`src/types/index.ts:249`, re-exported from `classify.ts`). Same concept, same values; the spec predates the merge. Importing the real name is the whole point of not forking the taxonomy. |
| 2 | **`CARD_CREDIT_KINDS` imported from `src/lib/relations.ts`** | As the task brief and `FIN-RELATION-001-COMPLETION.md` §12 both direct. FIN-RELATION-001 merged first and its parser needed the closed list. No second copy declared. |
| 3 | **`unknown_card_credit` and `manual_adjustment` added to `PERMITTED_KINDS_BY_LEDGER_MEANING.refund`** | §3.3's table and §3.2's ladder contradict each other: rungs 2–4 require a *confirmed* link, so a credit whose text says "refund" and which carries no confirmed link **must** fall through to rung 6 or 7. A table excluding them would be violated by the ladder two sections earlier. Rungs 1–4 are link-derived facts that outrank text by construction, which is correct and is documented in the module. |
| 4 | **Rung 6 requires positive evidence of manual origin** | §3.2 says "the row's `sources` contain no provider path". Read literally, an *absent* `sources` array satisfies that, so rung 6 would swallow every row predating the dual-source ingest and leave rung 7 — the spec's own "honest default" — unreachable. Implemented as: a non-empty `sources` naming no provider, **or** `userEdited.amount === true`. Uses the same non-provider vocabulary (`manual`, `csv`) as `src/lib/obs/provenance.ts:96`. |
| 5 | **`src/lib/refund-analytics.ts` not created** | The brief allows it "if the spec calls for it"; spec §12.2 lists exactly two library files. `netCategorySpendingCents()` lives with the economics it derives from. |
| 6 | **A partial match beyond 90 days scores 0.35** | §4.4's ladder is silent between 90 and 180 days for the partial shape while §4.2's window runs to 180. Tapered on the same shape as the `exact` tiers rather than invented afresh, and it stays inside the window either way. |
| 7 | **The ambiguity rule applies across all candidate shapes, not only exact matches** | §4.4 says "two or more candidates ... for the same credit", without restricting shape, so two equally-plausible *partial* matches are just as ambiguous as two exact ones. Applied as a post-pass over everything proposed for one credit. |
| 8 | **M17 ("earned income unchanged") is written, not deferred** | Spec §7.2/§12.1 precondition 3 makes M17 conditional on FIN-INCOME-001 ruling on refund-as-income. It has since ruled: a refund contributes **zero** to `sumIncomeCents` already (`cross-surface-consistency.test.ts:80-84` records the change from 330300 to 320000). M17 asserts zero contribution **before and after** linking — the real point being that linking moves net *spending*, never income. `sumIncomeCents` was not edited. |
| 9 | **Complexity documented as `O(n log n + R·(log b + w + K log K + 793))`** | §5.3 claims `O(n + R·c)`. The `w` (window scan) term is real and omitting it would overstate the result. It is still linear in the ledger with constant bounded work per credit, and there is no `n²` term. |
