# FIN-DUPLICATE-001 — Completion report

**Status:** Complete. Detection engine only — no UI, no refund matching, no card-credit
classification, no migration, no deploy.

**Baseline commit:** `63839d5` (tag `INTEGRATION_BASELINE_AFTER_RELATION`) on
`feat/transfer-type-monarch-ingest`. `main` is stale and was never used.

**Branch:** `feat/fin-duplicate-001-charge-detection`

**Worktree:** `../cashflow-forecast-fin-duplicate-001`, isolated from the integration
directory and from every other task's worktree. Nothing outside it was written.

**Final commit:** see §14 — the branch head at the time of writing is the documentation
commit; the three implementation commits are `6370abe`, `4f7ad3e`, `3203f05`.

---

## 1. Files changed

| File | New? | What |
|---|---|---|
| `src/lib/service-identity.ts` | new, 186 lines | `ServiceFamily`, the four-rule resolution ladder, the generic-token stoplist, alias index, `confirmAlias` |
| `src/lib/duplicates.ts` | new, 993 lines | `detectRecurringByAccount()`, the immediate-duplicate sweep, cross-account pairing, price-drift segmentation, the avoidable-cost estimate, the run span and events |
| `src/__tests__/duplicates.test.ts` | new | U1–U12 |
| `src/__tests__/duplicate-subscriptions.test.ts` | new | S1–S16 + the rule-drift pin |
| `src/__tests__/duplicate-decisions.test.ts` | new | A1–A9 |
| `src/lib/flows.ts` | **one token** | `export` added to `const BANDS` (line 360). Nothing else. |

Nothing else in the repository was modified. In particular: `src/types/index.ts`,
`classify.ts`, `forecast.ts`, `firestore.ts`, `UserProfileContext.tsx`, `chat-actions.ts`,
`firestore.rules`, `functions/src/prompts.ts`, `fingerprint.ts`, `functions-sync/*`,
`SubscriptionsPanel.tsx`, `src/app/flow/page.tsx`, `.github/`, `scripts/predeploy.sh` and
the package `scripts` block are all byte-identical to the baseline.

`src/lib/subscription-overlap.ts` was **not** created — see the deviations appendix.

---

## 2. Business rules

### 2.1 Three meanings of "duplicate", and how they stay distinct

| | Technical | Immediate economic | Duplicate subscription |
|---|---|---|---|
| What happened | one real event, two ingestion sightings | two real posted charges for one economic event | two live recurring series for one service |
| Owned by | `src/lib/fingerprint.ts` (shipped, untouched) | this task | this task |
| Surfaces as an alert | **never** | `immediate_duplicate_charge` | `duplicate_subscription`, `subscription_overlap`, `continued_charge_after_cancellation` |
| Mechanism keeping it distinct | `earlier.t.fingerprint && earlier.t.fingerprint === later.t.fingerprint` → the pair is skipped before any scoring, so no charge candidate and no subscription candidate can exist for it | same account only; a cross-account same-amount pair is never an immediate duplicate | different accounts only (E5); a same-account repetition never becomes a subscription candidate |

The technical layer is consumed, never re-implemented and never second-guessed:
`fingerprint.ts` and its byte-for-byte Python mirror `functions-sync/simplefin.py`
(`signed_cents_of`) are both unmodified. The comparison reads the **stored** `fingerprint`
field, not a recomputed one — recomputing it would suppress two genuinely separate same-day
same-amount charges, which is the precise failure `findTwin`'s `claimed` set exists to
prevent.

### 2.2 Nothing is ever deleted, and no decision moves a total

There is no delete call anywhere in either module (asserted structurally by U9), no delete
action in the parser, and `firestore.rules` denies delete on both new collections (also
asserted by U9). A confirmed duplicate is an annotation on real money: both rows stay
counted in `sumExpenseCents`, `getAllCategorySpending` and `buildFlowGraph` (U8, A7, A9).
`mark_different_owner` in particular leaves the expense **fully counted** — it is a shared
or separate expense, not a mistake.

### 2.3 Review decisions

Persisted as the candidate's `status` through FIN-RELATION-001's `recordCandidateDecision`
— no parallel store, no third collection.

| Decision | Action (parser, already closed) | Status | Effect on alerts |
|---|---|---|---|
| double charge | `confirm_duplicate_charge` | `confirmed` | terminal → suppressed forever |
| paying twice | `confirm_duplicate_subscription` (+ `keepTransactionId`) | `confirmed` | terminal → suppressed forever |
| on purpose | `mark_intentional_duplicate` | `intentional` | terminal → suppressed, both series still tracked independently |
| another person's | `mark_different_owner` | `intentional` (`different_owner`) | as above; expense stays fully counted |
| for the business | `mark_business_subscription` | `intentional` (`business`) | a label only: no tax field, no deduction claim, no export column (A8) |
| cancelled on ⟨date⟩ | `mark_subscription_cancelled` | `confirmed` | arms `continued_charge_after_cancellation` from that date |
| not now | `dismiss_review_candidate` | `dismissed` | terminal → suppressed forever |
| can't tell yet | UI control, no AI action | `needs_more_information` | stays in the queue, ranked last |

Suppression is mechanical, not conventional: the candidate's **document id is the
identityKey**, which carries no algorithm version, and `mergeCandidateRun` drops any
generated candidate whose stored status is terminal. A version bump is therefore incapable
of reinterpreting a decision (A6 proves it across `duplicate-subscription-v1` → `v2`), and
because both series keep flowing through `detectRecurringByAccount` untouched, an
`intentional` pair continues to be tracked while asking nothing.

---

## 3. Algorithms

### 3.1 `detectRecurringByAccount()` — what was reused, what was superseded

**Superseded: `detectRecurring()`'s grouping key. Nothing else.**

`flows.ts:380-387` groups by `normalizeMerchant(t.merchant || t.title)` alone and then
reports `accountId` as the modal account (`:404-412`). Two live subscriptions to one
service on two cards therefore collapse into a single `RecurringItem`: the occurrence count
sums, the modal account wins, and the second subscription is invisible **by construction** —
the data structure has no place to put it. `detectRecurringByAccount()` keys on
`(serviceFamilyId, accountId, currency)` instead.

**Reused verbatim, imported not copied:** `normalizeMerchant`, `median`, `daysBetween`,
`toCents`, `day`, the `BANDS` cadence table (weekly/biweekly/monthly/quarterly/yearly with
their monthly multipliers), the `RecurringItem` field vocabulary, and `interpretTransaction`
as the single authority on what counts as spending at all.

**Reused, re-declared as named constants:** the four rules at `flows.ts:391-402` — ≥3 unique
days, amount dispersion ≤25% of the median, median ≥ $5, in-band gap ratio ≥0.6 — plus the
`1.5 × cadence upper bound` active rule at `:411`. They are re-declared rather than imported
only because `flows.ts` does not export them and the single sanctioned write into that file
was the `export` keyword on `BANDS`. **They are not loosened, not re-tuned and not
re-derived**; each one killed a verified false result on the real data. A test named "the
reused detectRecurring rules are pinned to flows.ts" reads `flows.ts`'s own literals and
fails the moment either copy drifts.

`detectRecurring()` itself and `SubscriptionsPanel` are **not modified** and keep working
exactly as they do. The cross-account view is purely additive.

A series that clears the relaxed ≥2-charge bar but not the full rule set is still returned,
with `anchor: false`. E3 is what makes that safe: the relaxed bar never stands alone.

### 3.2 Price drift and continuity (`segmentPriceDrift`)

A change smaller than the amount band is not a price change at all — that is tax and
rounding noise, and treating it as a new product would split every real subscription. Above
the band, one run of charges splits into two series when:

- a single step exceeds **+25%** of the current level → `price_step_exceeded`;
- the cumulative rise from the segment's first level exceeds **+40%** → `price_drift_exceeded`;
- an increase follows a decrease → `price_non_monotonic`.

A lone decrease does **not** split: a price cut is still the same service, and the spec's
stated trigger is a decrease *followed by* an increase. Splits are reported on the series'
`reasonCodes`, never applied silently.

### 3.3 The immediate-duplicate sweep

Bucketed by account, sorted by `(date, id)`, then a moving window that stops the moment the
gap exceeds 3 days. Requirements, all mandatory: exact integer-cent equality (no tolerance),
gap ≤ 3 days, same account, same `normalizeMerchant` value **or** same service family,
different stored fingerprints, both posted.

Score ladder — explainable, deterministic, never a model output:

```
0.90  exact cents, same account, same normalized merchant, gap <= 1 day
0.75  exact cents, same account, same normalized merchant, gap <= 3 days
0.60  exact cents, same account, same service family (alias-resolved), gap <= 3 days
0.30  any of the above when the merchant has >= 4 same-amount charges in a 90-day window
```

The 0.30 rung is the legitimate-repeated-purchase guard. A daily same-amount purchase from
one shop scores 0.30 and ranks below every other candidate, because the same-amount
frequency is itself counter-evidence — scored as such rather than hardcoded as a merchant
exception. The 90-day window ends at the later charge and slides forward when the ledger
does not yet hold 90 days of history for that merchant; without that, the first weeks of any
import score 0.90 purely because nothing had been imported yet, which is an artefact of the
import date rather than a fact about the money.

### 3.4 Cross-account pairing — the evidence bar

All five must hold, checked in the order that fails cheapest first:

| # | Threshold | As built |
|---|---|---|
| E5 | different accounts | `a.accountId !== b.accountId` |
| — | same currency | a differing currency **splits** the group; never converted, never assumed |
| E1 | ≥2 charges on **each** account | `occurrences` = unique charge **days**, matching how `detectRecurring` counts |
| E3 | an anchor series on at least one account | `a.anchor \|\| b.anchor` — the full reused rule set |
| E4 | both series active | the reused `1.5 × cadence upper bound` rule |
| E2 | ≥2 overlapping billing periods | integer set intersection of calendar period keys |

Overlapping periods are counted in the pair's cadence: months for monthly, ISO-anchored
7-day buckets for weekly, 14-day buckets for biweekly, year-quarters for quarterly, years
for yearly. When the two cadences differ, the **coarser** one is used — fewer, larger
periods, so E2 becomes harder to satisfy rather than easier.

Candidate type: same cadence **and** same amount band → `duplicate_subscription`; otherwise
→ `subscription_overlap`, whose whole point is that the annualized figures are what make a
monthly and a yearly comparable. Unrelated subscriptions are never paired merely because
their amounts match — the service family is required first, and it is never inferred from an
amount.

Score ladder: `0.85` exact merchant + same product · `0.75` confirmed alias + same product ·
`0.60` cadence or amount differs · `0.40` a rule-3 proposal (which is also
`needs_more_information`).

### 3.5 Tolerances as built

| Rule | Value |
|---|---|
| amount band | `abs(a-b) <= max(tol(a), tol(b))` where `tol(c) = max(300, round(abs(c) × 0.15))` — ±15% or ±$3.00, whichever is **wider**, and symmetric so the answer never depends on which series is asked about first |
| single price step | ≤ **25%** of the current level |
| cumulative price drift | ≤ **40%** across the segment |
| currency | **splits**, never converts |
| immediate-duplicate amount | **exact integer cents**, no tolerance at all |
| immediate-duplicate gap | ≤ **3** days (4 is not a duplicate) |
| repeat-purchase guard | ≥ **4** same-amount charges in a **90**-day window |

### 3.6 Avoidable cost

```
duplicateMonthlyCents             = the CHEAPER series' monthlyCents
                                    ( = Math.round(medianCents × BANDS multiplier) )
potentialAnnualDuplicateCostCents = duplicateMonthlyCents × 12
label                             = "potential annual duplicate cost"
```

The **cheaper** side — not the dearer, not the sum: if the owner cancels one, the
conservative figure is the smaller of the two. Integer cents throughout, with `Math.round`
appearing exactly once, at the `monthlyCents` step, so `× 12` cannot compound a float. A
yearly series annualizes through the reused `BANDS` multiplier (`1/12`), not a hand-written
division.

The figure never enters `generateForecast()`, produces no `ForecastEvent`, adjusts no
balance and touches no budget (A5). It is a number beside a question, not a number in the
ledger.

### 3.7 Continued charge after cancellation

Armed by the owner's `mark_subscription_cancelled` effective date, supplied to the detector
as `SubscriptionCancellation[]`. The first charge in that family dated after the effective
date produces one candidate at score **0.95** — the top of the queue — pairing the charge
that should not have happened with the last one that should have. No charge after the
effective date → **no candidate and nothing said**; silence is the correct output for a
cancellation that worked.

---

## 4. Algorithm version

`duplicate-charge-v1` and `duplicate-subscription-v1` (the latter also stamps
`continued_charge_after_cancellation`, which is a subscription-lifecycle fact).

The version lives in `ReviewCandidate.algorithmVersion` and inside `candidateId` — the audit
form. It is deliberately **absent from the document id**, which is `identityKey`. That is
what makes a bump re-evaluate only `unreviewed` candidates while leaving every terminal
decision untouched, and it is enforced by the merged `mergeCandidateRun`, not re-implemented
here.

---

## 5. Data model

No new collection is written by this task. It consumes:

- `users/{uid}/reviewCandidates/{identityKey}` — `ReviewCandidate` (FIN-RELATION-001)
- `users/{uid}/links/{linkId}` — `TransactionLink`, written only on confirmation
- `users/{uid}/serviceFamilies/{familyId}` — `ServiceFamily`, whose rules block was added by
  FIN-RELATION-001's single rules pass

`ServiceFamily.id` is **derived** from the first observed normalized merchant
(`serviceFamilyId()` slugs it), so two runs over the same ledger agree without anything
having been persisted first. The collection therefore exists for **confirmed aliases**, not
for id stability — an important property, because it means the detector is fully functional
before the owner has confirmed anything.

`DuplicateCostEstimate` is returned beside the candidates and deliberately **not** stored: it
is derived, recomputed on demand, and persisting it beside a decision would let a stale
figure keep making a claim the data no longer supports. `ReviewCandidate.evidence` has no
field for it either, and `sanitizeEvidence` would strip one.

Candidate identity is anchored on the **earliest** charge of each account's series, not the
latest, so a new charge next month cannot mint a new identityKey and resurrect an alert the
owner already decided.

---

## 6. Privacy controls

- **No production data was read, queried or accessed** at any point. No authenticated
  session was obtained, no sync was triggered, no test points anywhere but at invented
  fixtures.
- Every fixture is invented and marked demo: `NOVACAST`, `TIDEWATER SUPPLY`,
  `TIDEWATER COFFEE BAR`, `HARBORLIGHT CLOUD`, `demo-card-9021`, `demo-card-4410`. No real
  merchant, balance, account number, token or key appears in any file this task added.
- `ServiceFamily.aliases` hold merchant strings and live **only** in the owner's uid-scoped
  documents and in memory. They are never emitted in a diagnostic event, never written into
  `ReviewCandidate.evidence` (which has no free-text field and is runtime-stripped to
  declared keys), and never sent to the model outside the existing capped context builder.
- Events carry reason codes, enum values, small integers and counts only. Asserted in U2:
  the merchant string of the fixture appears nowhere in the emitted events.
  `potentialAnnualDuplicateCostCents` is **not** logged.
- No second telemetry system, no `console.log` of a financial payload. Everything goes
  through OBS-001's `emit`/`startSpan`, which redacts before an event exists.

---

## 7. Tests

**38 new tests in 3 new suites**, red before the implementation existed (verified: all three
suites failed with `Cannot find module '../lib/duplicates'`).

| Suite | Tests |
|---|---|
| `src/__tests__/duplicates.test.ts` | U1–U12 (12) |
| `src/__tests__/duplicate-subscriptions.test.ts` | S1–S16 (16) + the rule-drift pin (1) |
| `src/__tests__/duplicate-decisions.test.ts` | A1–A9 (9) |

The 38th is additive and not in the spec: it reads `flows.ts`'s own rule literals and pins
them against `duplicates.ts`'s re-declared constants. It exists because §2.1 requires the
four rules to be reused wholesale while `flows.ts` exports only `BANDS`, so something has to
fail when one copy drifts.

**No existing test or expectation was modified, weakened or rewritten.** The 40 pre-existing
suites are byte-identical to the baseline; the only pre-existing file this task touched is
`flows.ts`, and only to add the `export` keyword.

---

## 8. Build result — actual observed output

```
$ npx tsc --noEmit
(no output — clean)

$ npx jest
Test Suites: 1 skipped, 42 passed, 42 of 43 total
Tests:       7 skipped, 706 passed, 713 total

  baseline in the same worktree (same command, new suites excluded):
  Test Suites: 1 skipped, 39 passed, 39 of 40 total
  Tests:       7 skipped, 668 passed, 675 total

$ npm run build
✓ Generating static pages using 9 workers (19/19)
19 routes, the same set as the baseline

$ npm test --prefix functions
Test Suites: 3 passed, 3 total
Tests:       26 passed, 26 total

$ (integration venv, read-only, against this worktree's sources)
  .../cashflow-forecast/functions-sync/venv/bin/python -m unittest discover
Ran 62 tests in 0.021s
OK

$ npm run lint
✖ 153 problems (57 errors, 96 warnings)   — all pre-existing; the two new modules and
                                            the three new suites produce ZERO lint output
```

---

## 9. Known limitations

1. **The cancellation effective date has nowhere to live yet.** FIN-RELATION-001's
   `recordCandidateDecision` stores a status, a reviewer and a timestamp, but no
   `effectiveDate`, while `mark_subscription_cancelled` parses one. This task therefore
   takes cancellations as an **input** (`DuplicateOptions.cancellations`) rather than
   reading them back. FIN-RECOVERY-UI-001 must persist the date and pass it in. Until it
   does, `continued_charge_after_cancellation` is reachable but never armed in production.
2. **`Transaction` carries no currency field.** "A differing currency splits the group" is
   therefore implemented through the injectable `DuplicateOptions.currencyOf`, defaulting to
   a single currency. Multi-currency families were already out of scope (§12.4); this is the
   extension point when a currency field arrives.
3. **A continued-charge alert needs a prior charge.** If a family's only charges post after
   the cancellation date, no candidate is emitted — a `ReviewCandidate` requires ≥2
   transaction ids by construction. In practice a cancelled subscription always has prior
   charges.
4. **The immediate sweep is O(b²) inside one window.** If a ledger genuinely contains many
   same-day charges on one account, that window is quadratic — but every pair in it *is* a
   candidate, so the cost is inherent to the answer rather than to the algorithm.
5. **Rule 3 proposals are gated by the full evidence bar.** A token-overlap merge is only
   proposed when both sides already carry qualifying, overlapping series. This keeps the
   review queue quiet; the cost is that an alias between two services the owner is *not*
   double-paying for is never proposed.
6. **`biweekly` has no calendar period.** Overlap for a biweekly cadence uses deterministic
   14-day buckets anchored on the epoch, not a billing anchor. Off-by-one against a real
   biweekly billing cycle is possible; monthly, quarterly and yearly are exact calendar
   periods.
7. **No behavioural Firestore rules test.** U9 asserts the rules **text** denies delete on
   both new collections, exactly as `relations-rules.test.ts` does, because no emulator is
   configured and installing one was out of scope. The rules ENGINE evaluating a request
   remains unproven — a blocker inherited from FIN-RELATION-001, not introduced here.

---

## 10. Manual verification

None performed against production, by design (§10 of the spec: no production data is read
or accessed at implementation time, and no authenticated session is to be obtained). The
engine is reachable from no UI at this commit, so there is nothing to click.

What was verified by hand: `normalizeMerchant`'s actual output for the spec's worked example
(§5.3), run through node against the real implementation. It disagrees with the spec — see
the deviations appendix — and the fixtures were built against the real behaviour rather than
the documented one.

---

## 11. Overlapping files

| File | Owner | This task |
|---|---|---|
| `src/lib/flows.ts` | high-traffic, unowned | **one token**: `export` on `const BANDS`. Additive, no behaviour change, the only write into this file in the whole programme. |
| `src/lib/chat-actions.ts`, `functions/src/prompts.ts`, `firestore.rules` | FIN-RELATION-001 | not written. The `serviceFamilies` rules block was already in place. |
| `src/types/index.ts`, `classify.ts`, `forecast.ts`, `firestore.ts`, `UserProfileContext.tsx` | FIN-INCOME-001 | read only. |
| `src/lib/fingerprint.ts`, `functions-sync/simplefin.py` | the mirrored technical-dedupe pair | neither changed. |
| `src/components/SubscriptionsPanel.tsx`, `src/lib/reminders.ts` | — | read and reasoned about, not modified. Both keep working unchanged. |
| `src/app/flow/page.tsx` | FIN-RECOVERY-UI-001 | not touched. No UI, no component, no route added. |
| `src/lib/card-credit.ts`, `src/lib/refunds.ts` | FIN-REFUND-001 | not created. No refund matching, no card-credit classification. |

**For FIN-REFUND-001:** `src/lib/service-identity.ts` is landed and stable. Import
`resolveServiceIdentity`, `buildAliasIndex`, `serviceFamilyId`, `normalizedMerchantOf`,
`significantTokens`, `proposeFamilyMerge`, `ServiceFamily`, `AliasResolution`.

---

## 12. Merge recommendation

**Merge.** It moves no number: no classification changed, no total recomputed, no
`LedgerMeaning` added, no forecast input touched, and every pre-existing test passes
byte-identically (675 → 713 tests, +38, none rewritten). The one edit to a shared file is a
single additive keyword.

Order relative to FIN-REFUND-001 does not matter — their file ownership is disjoint and
neither imports the other, except that FIN-REFUND-001 gains `service-identity.ts` if this
lands first (and falls back to exact `normalizeMerchant` equality if it does not).

FIN-RECOVERY-UI-001 depends on this and should land after.

---

## 13. Deployment impact

**Zero at runtime.** Nothing calls `generateDuplicateCandidates()` yet — no page, no hook,
no effect, no scheduled function.

- No migration, no backfill, no document rewrite.
- No new index. `serviceFamilies` is read whole and uid-scoped.
- `firestore.rules` was already deployed by FIN-RELATION-001 and needs no further change;
  the `serviceFamilies` block is already in the deployed text.
- Bundle: the two modules are pure and tree-shakeable, and nothing imports them yet, so the
  build output is unchanged in shape — 19 routes, the same set as the baseline.
- The AI system prompt is unchanged; the parser was already closed.

**What FIN-RECOVERY-UI-001 needs to do:**

1. Call `generateDuplicateCandidates(transactions, accounts, { todayISO, families, cancellations })`
   inside **one `useMemo`** keyed on `[transactions, accounts, todayISO]`, or on refresh —
   never per render.
2. Reconcile with `mergeCandidateRun(result.candidates, storedCandidates)` and persist
   `writes` through `saveReviewCandidate`.
3. Render `result.estimates` using the `label` field verbatim. Never "savings".
4. Call `emitDuplicateDecision(candidateType, status, reasonCode)` beside every
   `recordCandidateDecision`, since this module writes nothing itself.
5. **Persist the `mark_subscription_cancelled` effective date** and feed it back as
   `DuplicateOptions.cancellations` — see limitation 1.
6. On a confirmed rule-3 alias proposal, call `confirmAlias(family, normalizedAlias, now)`
   and write the family to `users/{uid}/serviceFamilies/{familyId}`.

---

## 14. Commits

| Commit | Contents |
|---|---|
| `6370abe` | `feat(fin-duplicate-001): service identity, and the one-token BANDS export` |
| `4f7ad3e` | `feat(fin-duplicate-001): duplicate charge and subscription detection` |
| `3203f05` | `test(fin-duplicate-001): the 37 specified tests, plus a rule-drift pin` |
| *(this file)* | `docs(fin-duplicate-001): completion report` |

Nothing was pushed, merged, rebased or deployed.

---

## Appendix — spec deviations, with reasoning

| # | Deviation | Reasoning |
|---|---|---|
| 1 | **No `src/lib/subscription-overlap.ts`.** The task prompt lists it as an owned file; spec §12.2 lists only `duplicates.ts` and `service-identity.ts`, and says `duplicates.ts` holds `detectRecurringByAccount()`, the sweep, the pairing and the cost estimate. | The spec wins where the two disagree. Splitting the pairing away from the series detection that feeds it would also have put two halves of one algorithm in two files for no benefit. |
| 2 | **No shipped seed alias set.** The prompt asks to "ship an extensible alias model with a small seed set"; spec §5.2 says families are "seeded from what the owner's own data contains, **never** from a shipped list", §12.4 defers "any bundled vendor/service registry", and test S10 asserts structurally that no vendor name literal exists in either module. | Three spec clauses and a required test all forbid a shipped vendor list. The only shipped seed is `GENERIC_TOKENS` — the ten filler words from §5.2 rule 3, which name no service. Families seed themselves from the first observed normalized merchant. |
| 3 | **The spec's §5.3 worked example is factually wrong**, and the fixtures follow the real code instead. `normalizeMerchant('DEMO OPENAI*CHATGPT SUBSCR')` returns `'DEMO OPENAI SUBSCR'`, not `'DEMO OPENAI'` — `[#*]\S*` strips `*CHATGPT` but ` SUBSCR` survives, so rule 1 does **not** unify it with `DEMO OPENAI`. Verified by running the real function. | Building S7 on the documented-but-false output would have produced a test that passes only against a fiction. The invented fixtures preserve the example's *intent* exactly: `NOVACAST*BILL` → `NOVACAST` unifies under rule 1 for free (S7), and `NOVACAST STUDIOS` must go through rule 3 and be confirmed (S8). The three-rung structure the example illustrates is implemented in full. |
| 4 | **Same cadence but a different amount band → `subscription_overlap`, not silence.** §4.4 introduces `subscription_overlap` as the cadence-differs case; §4.1 makes `amountBand` part of the grouping key, which read strictly would emit nothing for two same-cadence tiers of one service. | Emitting nothing would hide a real duplicate at two price tiers. `subscription_overlap` is exactly the right vehicle — its stated purpose is that "the annualized figures are what make them comparable" — so the weaker signal gets the weaker candidate type and a 0.60 score rather than disappearing. |
| 5 | **Overlap counted in the COARSER cadence when the two differ.** §4.2 says "calendar periods of the anchor's cadence"; with two anchors of different cadences that is ambiguous. | The coarser cadence yields fewer, larger periods, so E2 becomes harder to satisfy. Ambiguity resolved toward the conservative reading. |
| 6 | **The repeat-purchase window slides forward at the start of history.** §3.2 says "≥4 same-amount charges in the trailing 90 days"; taken literally, the first charges of any import have no trailing history and score 0.90. | Test U3 requires *every* pair in a daily-purchase fixture to be capped. Anchoring the 90-day window at the merchant's first same-amount charge when history is shorter than 90 days makes the guard measure the merchant's behaviour instead of the import date. Identical to the literal rule once 90 days of history exist. |
| 7 | **`occurrences` counts unique charge DAYS, not rows.** §4.2 E1 says "≥2 charges on each account". | `detectRecurring` counts unique days (`flows.ts:391`), and E3 reconciles E1 against that same counting. Using rows would let two same-day charges satisfy E1 while failing the anchor rules for a different reason. |
| 8 | **One aggregate event per candidate type per run**, not one per candidate. §9's table says "an immediate-duplicate run emits" but lists singular `metadata.dayGap` / `metadata.score`. | Per-candidate emission is unbounded in a large ledger. The aggregate carries `recordCount` plus the singular fields describing the **highest-ranked** candidate, which is both what the table's shape asks for and what a diagnostic actually needs. |
| 9 | **A 38th test**, beyond the specified 37. | The four reused rules had to be re-declared as constants (`flows.ts` exports only `BANDS`), which creates exactly the two-definitions-that-drift risk §2.2 exists to prevent. The pin makes the drift fail loudly. |
| 10 | **The completion report follows FIN-RELATION-001-COMPLETION.md's structure.** The task prompt cites "umbrella §35"; `REFUNDS-RETURNS-AND-DUPLICATES.md` has 16 sections and no §35. | The prompt's enumerated section list matches FIN-RELATION-001's completion report exactly, so that document was used as the template. |
