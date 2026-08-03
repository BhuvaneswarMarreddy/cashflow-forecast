# Data mapping gaps — the standing ledger

Every place the app currently fails to give a transaction a meaning, with the evidence
that established it. Findings came from several agents hours apart during the
2026-08-02 session; without this file they would be lost.

**Rules for this document**
- Only VERIFIED findings. Anything unconfirmed is marked `TO CONFIRM` and says how to check.
- Counts come from the owner's real export, measured read-only. **No real merchant,
  amount, description or account identifier is recorded here** — aggregates only.
- When a gap is closed, move it to §7 with the commit that closed it. Do not delete it;
  the history is what stops a fix being undone by accident.

Baseline when written: `8bbfddc` (INTEGRATION_BASELINE_AFTER_FLOW_TRUTH), deployed
2026-08-02 18:10:47.

---

## 1. Unclassified inflows — 205 rows

**What.** 205 positive transactions match no approved income source and no other
confirmed classification, so they resolve to `unknown_inflow`.

**Why it is correct that they are unknown.** FIN-INCOME-001 made earned income
conditional on an approved source. That is the intended rule — money entering an account
is not income until it matches a source or the owner says so. The gap is not the rule,
it is that **205 is too many to answer by hand**.

**Evidence.** `Unknown deposits · 205` chip, live `/flow`, 2026-08-02.

**Where.** `selectInflowReviewQueue()` in `src/lib/classify.ts`; rendered by
`src/lib/review-queue.ts` under `/flow?tab=review`.

**What would close it.** Pattern grouping (one decision covering N rows), not 205
individual answers. See §6.

**Status: the ask is closed, the rows are not.** MAP-001 (`src/lib/mapping-suggestions.ts`)
groups them. Measured on the real export, read-only, 2026-08-02: the 229 unknown inflows
this repo's own selector produces collapse to **50 groups**. In the shipped impact order
(rows x amount) **29 groups cover 80% of the rows and 8 cover 80% of the money**; ordered
by row count alone it is **16**. Every row still needs an answer eventually — but it is now
50 questions, not 229.

---

## 2. Unpaired transfer legs — 103 rows

**What.** 103 transfer legs that `matchTransfers()` could not pair.

**The important finding.** Only **15 of 103** have an opposite-direction leg anywhere in
the data at the same amount, and those sit **6–798 days apart** — coincidences, not
near-misses. So roughly **85% genuinely have no counterpart**: the far account was never
imported, or the export cut the pair in half.

**This means widening the pairing window will not help.** That was tested and rejected
during FIN-FLOW-001, and `transfers.ts` is consumed by both refunds and duplicates, so
loosening it carries real risk for no measured gain.

**Split.** 38/22 inbound, 17/26 outbound across the four direction/kind combinations.

**Where.** `matchTransfers()` in `src/lib/transfers.ts`; lanes now named in
`src/lib/flow-lanes.ts:209-214` (`Transfer in/out · other leg not found`,
`Card payment in/out · other leg not found`).

**What would close it.** Importing the missing accounts, or letting the owner say
"this leg's counterpart is outside my data" once per pattern so it stops asking.

**Status: the second half is closed.** MAP-001 groups the 103 into **30 groups**, of which
**13 cover 80% of the rows and 7 cover 80% of the money**, and gives each group a terminal
"I can't classify these — stop asking" answer that persists to the existing review record
and suppresses the PATTERN, rows imported later included. `transfers.ts` is untouched and
the pairing window is unchanged.

---

## 3. Refund detection misses — 9 rows

**What.** 9 bank credits fell through `isRefund()`'s text regex and were routed to
`inc:${sourceCategory}`, which is how expense category names — *Insurance*, *Shopping*,
*Internet & Cable*, *Loan Payment* — appeared as income sources on the left of the Flow
Sankey.

**Status.** Partially closed. `src/lib/flow-lanes.ts` now uses a data-derived rule (if
the ledger also SPENDS in that category, an inflow tagged with it is money back) instead
of relying on the regex alone. The underlying regex is unchanged.

**Where.** `isRefund()` in `src/lib/classify.ts`.

---

## 4. Category coverage

| Gap | Measured | Status |
|---|---|---|
| `TOP_CATEGORIES` was 8 | left **23.6%** of spending in the residual | closed — raised to 20, residual now **4.1%** |
| Residual bucket | **39 smaller categories** | named, not eliminated |
| `Other` as a category | it is the export's OWN category name, passed through by `displayCategory()` | not ours to rename; surfaced honestly |
| Vague category values | `''`, `other`, `others`, `uncategorized`, `uncategorised`, `misc`, `miscellaneous`, `no category` | fall back to `MERCHANT · no category`, else `No category in your export` |

**Where.** `src/lib/flow-lanes.ts:228-252`.

---

## 5. Mapping-rule engine limits

The rule engine is narrower than the gaps require.

**Can match:** `merchant | title | description` × `contains | equals`.
**Can set:** `category`, `sourceCategory`, `type`, `merchant`.

**Cannot match:** account, amount, amount range, direction, date window, regex,
pending state, or the source that produced the row.
**Cannot set:** transfer pairing, income-source linkage, pending treatment,
exclude-from-forecast, or a review decision.

**No management surface.** Rules can only be created through the AI chat sheet
(`DataChatSheet.tsx:95` → `addRule`). They cannot be listed, previewed, edited,
reordered, disabled or deleted afterwards. Precedence is creation order (newest wins)
and is invisible to the owner.

**Where.** `src/lib/mapping-rules.ts:15-24`, applied in `src/context/TransactionContext.tsx`.

---

## 6. What "map the unmapped" has to solve

Ranked by how much of the picture each unlocks.

1. **Bulk decisions over patterns, not rows.** 205 + 103 individual answers is not a
   workable ask. Group by normalized merchant / counterparty / account / cadence and let
   one confirmation cover the group, with the affected count shown before it applies.
2. **Suggestions derived from the owner's own data**, never invented categories — the
   same discipline `service-identity.ts` follows (no vendor seed list).
3. **A terminal "leave it unknown" answer.** Some rows genuinely have no counterpart
   (§2). The queue must accept "this is outside my data" and stop asking, or it becomes
   noise the owner learns to ignore.
4. **Rule scope must be visible before it applies** — what changes, how many rows, which
   date range, and whether future rows are included. This is already the standing rule in
   `docs/features/FIN-REVIEW-002.md` §12 and must not be relaxed.

---

## 7. Closed gaps (kept for history)

| Gap | Closed by | Commit |
|---|---|---|
| 205 + 103 individual answers was not a workable ask | pattern grouping — 332 rows into 80 groups, one decision each | MAP-001 |
| The queue had no terminal "I can't classify this" | `markGroupUnknown()` -> `dismissed` + `group_marked_unknown` on the existing review record; suppresses the pattern, not just the row | MAP-001 |
| A rule could not be scoped to a direction, an account or future rows | three OPTIONAL fields on `MappingRule.match` (`direction`, `accountId`, `onOrAfter`); every pre-existing rule unchanged | MAP-001 |
| `sourceCategory === 'Paychecks'` was the income test | approved income sources | `6ca3dd3` |
| Income source could not match a differently-worded bank line | `matchAliases` + the "Bank description contains" field | `d904e5c` |
| Card payment counted as both income and expense on some screens | one shared `interpretTransaction()` | `98ed70a` |
| Pending rows treated as posted truth | typed `pending` + explicit per-consumer decisions | `98ed70a` |
| Refunds appeared as an income source | non-income lanes + confirmed-link netting | `8bbfddc` |
| Refund matched across accounts on merchant+amount alone | matching scoped to the credited account | `6b04f1c` |
| Two subscriptions on two cards collapsed into one row | `detectRecurringByAccount()` | `0be9533` |
| `$233k` in anonymous "other" buckets | four named lanes + top-20 + honest residual | `8bbfddc` |

---

## 8. Answered (was TO CONFIRM)

- **Monarch CSV `Tags` column — CONFIRMED PRESENT, and immaterial.** The export header is
  `Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Owner,Reviewed`, so
  `Tags` does exist and the importer does drop it. Measured across all 2,913 rows:
  **2 rows carry a non-empty tag.** Wiring it up would recover 0.07% of the ledger, so it
  is recorded as answered and NOT worth an ingest change. Re-measure if the owner starts
  tagging in Monarch.

- **Are the unknown deposits the missing counterparts of the unpaired legs? MOSTLY NOT.**
  Measured 2026-08-02, read-only, matching each unknown inflow against an unpaired OUT leg
  of the same amount in a *different* account:

  | Window | Matches (of 229 unknown inflows / 176 unpaired out legs) |
  |---|---|
  | same day (±1d) | **10** |
  | ±3d | 12 |
  | ±7d | 12 |
  | ±30d | 14 |
  | any date at all | 28 |

  So **at most ~4–6% overlap**, and the "any date" figure is the same coincidence class
  §2 already documented (6–798 days apart). **This does not justify widening the pairing
  window** — it confirms §2's conclusion from the other direction. What it DOES justify is
  surfacing the same-day case as evidence, which MAP-001 does: `same_day_opposite_leg` is
  one of the four suggestion sources, and on the real export it fires for **17 of the 80
  groups** (12 of the 30 leg groups). The owner decides; nothing is paired automatically.

## 9. Still open

- **The 39 smaller categories in the spending residual** are named but not eliminated (§4).
  MAP-001 covers unknown INFLOWS and unpaired LEGS; vague-category *spending* rows
  (measured: 55 rows, 52 of them spending, in 23 merchant groups) are not in the queue and
  would be a straightforward third `UnmappedKind` on the same machinery.
- **Rules still have no management surface** (§5): MAP-001 creates them with a preview but
  they still cannot be listed, edited, reordered or disabled after the fact.
