# FIN-DUPLICATE-001 — Duplicate charges and duplicate subscriptions

**Status:** Specification only. Nothing under `src/`, `functions/`, `functions-sync/` or any
config file is modified by this task.

**Branch:** `docs/fin-recovery-specs`, worktree `../cashflow-forecast-recovery-specs`,
baseline `2aaf4e5` on `feat/transfer-type-monarch-ingest`. `main` is stale and is never used.

**Position in the programme:** **FIN-RELATION-001 merges FIRST.** FIN-REFUND-001 and
FIN-DUPLICATE-001 may then run **in parallel ONLY because their file ownership is disjoint**
(§12). FIN-RECOVERY-UI-001 is last and is the sole owner of `src/app/flow/page.tsx`.

All sample data is invented and clearly marked demo: `DEMO OPENAI*CHATGPT`,
`DEMO CHATGPT SUBSCRIPTION`, `demo-card-9021`, `demo-card-4410`. **No service named in this
document is special-cased anywhere in the design** — §5 is an extensible model and the
examples are illustrative only.

---

## 1. Three different things called "duplicate"

Conflating them is how a detector deletes real money. They are separated here, permanently.

| | **Technical duplicate** | **Economic duplicate** | **Duplicate subscription** |
|---|---|---|---|
| What happened | one real event, two ingestion sightings | **two real posted charges** for one economic event | two live recurring series for one service |
| Truth | one of the rows should not exist as a separate row | both rows are real; one is probably avoidable | both series are real; one is probably avoidable |
| Who owns it | `src/lib/fingerprint.ts` (already shipped) | FIN-DUPLICATE-001 | FIN-DUPLICATE-001 |
| Resolution | merge/enrich at ingest, before the app ever sees two rows | surface for review; **never delete** | surface for review; **never delete** |
| Surfaces as an alert? | **No** | Yes — `immediate_duplicate_charge` | Yes — `duplicate_subscription` |

### 1.1 The technical layer, which sits BELOW this work

`src/lib/fingerprint.ts:46-51` computes `${accountId}|${signedCents}|${yyyy-MM-dd}` and
`findTwin()` (`src/lib/fingerprint.ts:65`) matches within a ±3-day window, with a shared
`claimed` set so "two genuinely separate $5.00 coffees on one day can never collapse onto a
single stored row" (`src/lib/fingerprint.ts:58-64`). `mergeFields()`
(`src/lib/fingerprint.ts:108`) then enriches rather than overwrites, respecting
`userEdited` (`src/types/index.ts:326`).

This is mirrored byte-for-byte in Python by `functions-sync/simplefin.py:138`
(`signed_cents_of`), whose docstring states the mirroring explicitly. **Neither may be
changed independently** — a change to one without the other silently splits or merges rows on
the next sync. **FIN-DUPLICATE-001 changes neither.**

The economic-duplicate work sits strictly **above** this layer. It runs on the rows that
survived ingest dedupe, and it must never re-implement, extend or second-guess the
fingerprint. Test U1 pins the boundary: a technical duplicate suppressed by ingestion
identity produces **no** economic-duplicate alert and **no** subscription alert.

### 1.2 The hard rule

**Duplicate detection never deletes a transaction.** There is no delete path in this task, no
delete action in the parser (FIN-RELATION-001 §7.3), and `firestore.rules` denies delete on
both new collections (FIN-RELATION-001 §6). A confirmed duplicate is an *annotation on real
money*, and the money stays in every total until the owner separately deletes the row through
the ordinary transaction UI, which this task does not touch.

---

## 2. What is reused, and what is superseded (with reasons)

### 2.1 Reused verbatim

| Primitive | Where | Used for |
|---|---|---|
| `normalizeMerchant()` | `src/lib/flows.ts:374` | the first and cheapest identity rule (§5.2) |
| `median()` | `src/lib/flows.ts:365` | amount and gap medians |
| `daysBetween()` | `src/lib/flows.ts:370` | integer whole-day gaps |
| `BANDS` cadence table | `src/lib/flows.ts:360-363` | weekly/biweekly/monthly/quarterly/yearly bands and their monthly multipliers |
| the four `detectRecurring` rules | `src/lib/flows.ts:391-402` | ≥3 unique days; amount dispersion ≤ 25% of median; median ≥ $5; in-band gap ratio ≥ 0.6 |
| `RecurringItem` shape | `src/lib/flows.ts:347-358` | cadence, `medianCents`, `monthlyCents`, `nextDue`, `confidence`, `active` |
| `toCents()`, `day()` | `src/lib/flows.ts:8`, `:9` | integer cents, local calendar day |
| `interpretTransaction()` | `src/lib/classify.ts:206` | what counts as spending at all |

Those four rules exist because "each killed a verified false result on the real data"
(`src/lib/flows.ts:343-345`). They are not re-derived, not loosened and not re-tuned.

### 2.2 Superseded — one thing only, and here is why

**`detectRecurring()`'s grouping key is superseded. Nothing else is.**

`src/lib/flows.ts:380-387` groups by `normalizeMerchant(t.merchant || t.title)` **alone**, and
then reports `accountId` as "the account most of this merchant's charges hit"
(`src/lib/flows.ts:404-412`). That means two live subscriptions to one service on two
different cards **collapse into a single `RecurringItem`**: the occurrence count is summed,
the modal account wins, and the second subscription becomes invisible. `SubscriptionsPanel`
(`src/components/SubscriptionsPanel.tsx:23-30`) consumes that output directly, so today the
app *cannot* show a cross-account duplicate — not because it is hidden, but because the data
structure has no place to put it.

FIN-DUPLICATE-001 therefore adds `detectRecurringByAccount()` in its **own** module, keyed by
`(serviceFamilyId, accountId)`, reusing every rule and primitive above. `src/lib/flows.ts`'s
`detectRecurring()` is **not modified** and `SubscriptionsPanel` is **not modified** — both
keep working exactly as they do, and the cross-account view is additive.

The one exception, declared as an overlap (§12.3): **`BANDS` is `const` and not exported**
(`src/lib/flows.ts:360`). FIN-DUPLICATE-001 needs a one-token `export` added there. That is a
single additive keyword and it is the **only** write into `flows.ts` in this entire
programme. Copying the table instead would create two cadence definitions that drift — the
exact failure mode this section exists to prevent.

`src/lib/reminders.ts` is likewise reused and not superseded: `generateTransactionReminders()`
(`src/lib/reminders.ts:175`) already routes recurring rows through
`interpretTransaction(t, accounts).expense === 'counted'` (`src/lib/reminders.ts:199`) so a
recurring card payment never becomes a phantom bill. FIN-DUPLICATE-001 adds no reminder, no
notification and no second cadence engine.

---

## 3. Economic duplicate: the immediate duplicate charge

### 3.1 Definition

Two **posted** outflows that are almost certainly one economic event charged twice — a
double-tap at a terminal, a retried payment, a merchant that captured twice.

### 3.2 Detection

Within one `(accountId)` bucket, for posted rows where
`interpretTransaction(t, accounts).expense === 'counted'`:

| Signal | Requirement |
|---|---|
| amount | **exact integer-cent equality**. No tolerance — a $12.00 and a $12.01 charge are two charges |
| date gap | `daysBetween(a, b) <= 3` (`src/lib/flows.ts:370`) |
| merchant | same `normalizeMerchant()` value, or same service family (§5) |
| account | **same account only.** A cross-account "duplicate" of one charge is not a thing; that is a duplicate *subscription* (§4) |
| ingest identity | the two rows must have **different** fingerprints (`src/types/index.ts:324`). Equal fingerprints mean the ingest layer already decided they are one row, and this detector must stay out of it |
| pending | both posted. A hold plus its posted twin is never a duplicate charge (`src/types/index.ts:310-315`) |

Score ladder — explainable, deterministic, never a model output:

```
0.90  exact cents, same account, same normalized merchant, gap ≤ 1 day
0.75  exact cents, same account, same normalized merchant, gap ≤ 3 days
0.60  exact cents, same account, same service family (alias-resolved), gap ≤ 3 days
0.30  exact cents, same account, same merchant, gap ≤ 3 days, but the merchant has ≥ 4
      same-amount charges in the trailing 90 days  ← a legitimate repeat pattern
```

The 0.30 rung is the **legitimate repeated purchase** guard (test U3). A daily $6.50 coffee
from the same shop generates no high-confidence duplicate: the same-amount frequency itself is
counter-evidence, and it is scored as such rather than being hardcoded as a merchant
exception.

### 3.3 What it emits

One `immediate_duplicate_charge` candidate per pair, with one proposed
`duplicate_candidate` link (later → earlier, per FIN-RELATION-001 §3.2) whose
`allocatedAmountCents` is the later charge's cents — the amount that would be recovered if it
is a genuine double charge.

**Confirming it changes no total.** Both charges remain counted expenses. The candidate's
value is that the owner now knows to contact the merchant; the app makes no claim that the
money is coming back until a refund actually posts and is matched by FIN-REFUND-001.

---

## 4. Duplicate subscriptions across accounts

### 4.1 Grouping

A **subscription series** is identified by:

```
(serviceFamilyId, accountId, currency, cadence, amountBand, activeDateRange)
```

- `serviceFamilyId` — §5. Never a raw merchant string, never a hardcoded vendor.
- `accountId` — **the whole point.** Grouping across accounts is what
  `detectRecurring()` cannot express (§2.2).
- `currency` — single-currency in scope; a mismatch splits the group rather than merging it.
- `cadence` — from the reused `BANDS` (`src/lib/flows.ts:360-363`).
- `amountBand` — §4.3.
- `activeDateRange` — `[firstSeen, lastSeen]`, from the reused `RecurringItem` fields.

Two series in the same `serviceFamilyId` on **different** accounts, whose active date ranges
overlap, are a `duplicate_subscription` candidate.

### 4.2 Minimum evidence — the thresholds

A candidate is emitted only when **all** hold:

| # | Threshold | Why |
|---|---|---|
| E1 | **≥ 2 charges on each account** | one charge is a trial, a one-off or a mis-tagged purchase, not a subscription |
| E2 | **≥ 2 overlapping billing periods** | one overlapping period is a migration month — the owner moved the subscription from one card to another and both were charged once. Two is the first point at which "still paying twice" is the better explanation |
| E3 | **an anchor series exists** — at least one of the two accounts satisfies the full reused `detectRecurring` rule set (≥3 unique days, dispersion ≤ 25%, median ≥ $5, in-band ≥ 0.6) | this is how the hard part stays with the engine that was tuned on real data; only the *second* account is allowed the relaxed ≥2 bar |
| E4 | both series `active` by the reused rule — seen within `1.5 × cadenceUpperBound` (`src/lib/flows.ts:411`) | a lapsed series is not a live duplicate |
| E5 | the two series are on **different** `accountId`s | same-account repetition is §3's problem |

E3 is the reconciliation between "≥2 charges per account" and `detectRecurring`'s "≥3 unique
days": the pair as a whole carries ≥5 charges and at least one properly-detected cadence, so
the relaxed bar never stands alone.

**Overlapping billing periods** are counted as calendar periods of the anchor's cadence in
which *both* series have at least one charge. Monthly cadence → months; weekly → ISO weeks;
yearly → years. Integer count, computed from `day()` values, no fuzzy overlap.

### 4.3 Tolerating tax, currency and price drift

Real subscriptions do not charge the same cents forever.

- **Amount band:** two charges are the same band when they are within **±15% or ±$3.00,
  whichever is wider**, of the series median. `±$3.00` covers sales-tax variation on a small
  subscription; `±15%` covers a larger one. This is deliberately looser than
  `detectRecurring`'s own dispersion rule (`median(|a − med|) ≤ med × 0.25`,
  `src/lib/flows.ts:395`), which continues to gate whether a *series* exists at all — the band
  only decides whether two *series* are the same product.
- **Gradual price increases** keep continuity: a monotonically non-decreasing sequence of
  medians whose total rise is ≤ 40% across the observed span, with no single step > 25%,
  is one series, not two. A single step > 25% or any decrease-then-increase pattern splits
  the series and is reported as such rather than silently merged (test U8).
- **Currency:** a differing currency splits the group. Never converted, never assumed.

### 4.4 Cadence overlap and the two neighbours

- `subscription_overlap` — the two series are in the same family and their active ranges
  overlap, but the cadences differ (a monthly on one card, a yearly on another). Same
  evidence bar, different presentation: the annualized figures are what make them
  comparable (§6).
- `continued_charge_after_cancellation` — the owner marked a series cancelled (via
  `mark_subscription_cancelled` with an `effectiveDate`, FIN-RELATION-001 §7.3) and a charge
  in that family posts **after** that date. Emitted on the first such charge. If no charge
  posts after the effective date, **no candidate is emitted and nothing is said** (test U11) —
  silence is the correct output for a cancellation that worked.

---

## 5. Service identity — extensible, never hardcoded

### 5.1 The rule

**No service is special-cased in code.** There is no `if (merchant.includes('CHATGPT'))`
anywhere, and no bundled vendor list. `COMMON_MERCHANTS` (`src/types/index.ts:379-461`)
exists for colours and category suggestions and is **not** used as a service registry — it is
a display aid, and reusing it as identity would make identity depend on a colour table.

### 5.2 Resolution order

```ts
// src/lib/service-identity.ts — owned exclusively by FIN-DUPLICATE-001.
export interface ServiceFamily {
  id: string;            // stable, generated from the first observed normalized merchant
  label: string;         // display only
  aliases: string[];     // normalized merchant strings the owner has confirmed
  createdAt: string;
  updatedAt: string;
}
```

Stored at `users/{uid}/serviceFamilies/{familyId}` — uid-scoped, owner-editable, and
**seeded from what the owner's own data contains**, never from a shipped list.

| # | Rule | Cost | Auto? |
|---|---|---|---|
| 1 | `normalizeMerchant()` equality (`src/lib/flows.ts:374`) | free, already computed | **yes** |
| 2 | the normalized string appears in a `ServiceFamily.aliases` the owner confirmed | one map lookup | **yes** |
| 3 | token-overlap heuristic between two normalized strings (≥1 shared token of ≥4 chars, after removing generic tokens: `SUBSCRIPTION`, `SUBSCR`, `MONTHLY`, `ANNUAL`, `PLUS`, `PRO`, `PREMIUM`, `INC`, `LLC`, `COM`) | small | **no — proposes a merge for review** |
| 4 | anything else | — | **no — distinct families** |

Rule 3 **never merges silently.** It emits a `duplicate_subscription` candidate with
`status: 'needs_more_information'` and reason code `alias_unconfirmed`. Confirming it writes
the alias into the family, so the same question is never asked twice.

### 5.3 Worked example — illustrative only, never encoded

Three normalized strings the owner's data might contain. Note what `normalizeMerchant()` does
to each, since it strips `[#*]\S*` and trailing digit runs (`src/lib/flows.ts:374-375`):

| Raw statement text | `normalizeMerchant()` | Resolution |
|---|---|---|
| `DEMO OPENAI*CHATGPT SUBSCR` | `DEMO OPENAI` | family seeded as `DEMO OPENAI` |
| `DEMO OPENAI` | `DEMO OPENAI` | **rule 1** — same family, free |
| `DEMO CHATGPT SUBSCRIPTION` | `DEMO CHATGPT SUBSCRIPTION` | **rule 3** — `DEMO` is shared but generic-adjacent; the merge is *proposed*, `needs_more_information`, until the owner confirms |

That third row is exactly the "unknown aliases require review" case (test U7). It is not a
failure of the model; it is the model refusing to guess about money.

---

## 6. The avoidable-cost estimate

### 6.1 Computation, integer cents

```
duplicateMonthlyCents = the CHEAPER series' monthlyCents
                        (RecurringItem.monthlyCents, src/lib/flows.ts:407,
                         = round(medianCents × BANDS multiplier))
potentialAnnualDuplicateCostCents = duplicateMonthlyCents × 12
```

The **cheaper** side, not the dearer, and not the sum. If the owner cancels one, the
conservative saving is the smaller of the two. Claiming the larger would overstate it.

All integer cents (test U12 asserts the rounding is `Math.round` at the `monthlyCents` step
and nowhere else, so `× 12` cannot compound a float).

### 6.2 The label — non-negotiable

Rendered as **"potential annual duplicate cost"**. Never:

- "savings", "you will save", "guaranteed savings", "money back";
- a projection into the forecast — this figure **never** enters `generateForecast()`, never
  becomes a `ForecastEvent`, and never adjusts a balance;
- a budget adjustment.

It is a number beside a question, not a number in the ledger. This matches the app's existing
discipline of not making claims it cannot back — the reconciliation table says "⚠ Not in your
data yet" rather than inventing an opening balance (`src/lib/flows.ts:311`,
`:318`), and `FIN-REVIEW-002.md:736-740` refuses tax-deductibility claims on the same grounds.

---

## 7. Performance

**Duplicate-subscription analysis runs on refresh, on demand, or memoized — never per
render.** `SubscriptionsPanel` already demonstrates the pattern
(`src/components/SubscriptionsPanel.tsx:22-30`: one `useMemo` keyed on
`[transactions, accounts, todayISO]`), and `/flow` does the same for `detectRecurring`
(`src/app/flow/page.tsx:193`).

Complexity, with `n` = posted expense rows, `F` = distinct service families, `A` = accounts:

| Step | Cost |
|---|---|
| normalize + bucket by `(family, account)` | **O(n)**, one pass, one `Map` |
| per-bucket series detection (reused rules) | **O(n log n)** total — each row is in exactly one bucket, and the only sort is per bucket by date |
| immediate-duplicate scan | **O(Σ b·w)** where `b` = bucket size and `w` = rows inside the ±3-day window; implemented as a sorted-by-date sweep with a moving window, so it is **O(n log n)**, never `O(n²)` |
| cross-account pairing | **O(F · A²)** with `A` = the owner's account count (single digits). Bounded by a constant in practice, and `A²` is over accounts, never over transactions |
| overlap counting | **O(periods)** per pair, ≤ the span in months |

No step iterates the ledger inside another iteration over the ledger. The `O(A²)` term is the
only quadratic anything, and it is quadratic in *accounts*.

Incremental re-evaluation: a new sync re-runs only families touched by the new rows, and every
candidate whose stored status is terminal is skipped via the O(1) `Set` check of
FIN-RELATION-001 §4.3.

---

## 8. Review decisions

The owner's five answers, all reached through FIN-RELATION-001's action parser (its §7.3) and
all requiring explicit confirmation:

| Decision | Action | Candidate status | Effect |
|---|---|---|---|
| "Yes, that's a double charge" | `confirm_duplicate_charge` | `confirmed` | writes a `duplicate_candidate` link; **no total changes** |
| "Yes, I'm paying twice — I'll cancel one" | `confirm_duplicate_subscription` (+ `keepTransactionId`) | `confirmed` | writes a `subscription_overlap` link; records which side to keep; **no total changes** |
| "I do that on purpose" | `mark_intentional_duplicate` | `intentional` | permanently suppressed, including across version bumps |
| "That one is my partner's / a different person's" | `mark_different_owner` | `intentional` (reason `different_owner`) | **stays a real, fully-counted expense.** It is a shared or separate expense, not a mistake. No total changes, no reduction, no "saving" |
| "That one is for the business" | `mark_business_subscription` | `intentional` (reason `business`) | a **label only**: no tax category, no deductibility claim, no export column implying one — per `FIN-REVIEW-002.md:736-740` |
| "I cancelled it on ⟨date⟩" | `mark_subscription_cancelled` | `confirmed` | arms `continued_charge_after_cancellation` from that date |
| "Not now" | `dismiss_review_candidate` | `dismissed` | permanently suppressed |
| "I can't tell yet" | (UI control, no AI action) | `needs_more_information` | stays in the queue, ranked last |

Every one of these is a statement about **the alert**, not about the money. No decision here
deletes, hides, reduces or reclassifies a transaction.

---

## 9. Observability

Reuse OBS-001 (merged; `src/lib/obs/`). `component: 'RecoveryDuplicates'`, `route: '/flow'`.

| Event | When | Safe properties |
|---|---|---|
| `DuplicateCharge.CandidateGenerated` | an immediate-duplicate run emits | `recordCount`, `metadata.algorithmVersion`, `metadata.dayGap`, `metadata.score`, `durationMs`, `resultStatus` |
| `DuplicateSubscription.CandidateGenerated` | a subscription run emits | `recordCount`, `metadata.algorithmVersion`, `metadata.cadence`, `metadata.overlappingPeriods`, `metadata.accountCount`, `metadata.aliasResolution` (`'exact' \| 'alias' \| 'proposed'`), `durationMs`, `resultStatus` |
| `DuplicateCandidate.Confirmed` | the owner confirms | `metadata.candidateType`, `metadata.decision`, `resultStatus` |
| `DuplicateCandidate.MarkedIntentional` | `intentional` is set | `metadata.candidateType`, `metadata.reasonCode` (`'intentional' \| 'different_owner' \| 'business'`), `resultStatus` |
| `DuplicateCandidate.Dismissed` | `dismissed` is set | `metadata.candidateType`, `metadata.reasonCode`, `resultStatus` |

One span: `Duplicate.GenerateCandidates`, one event on `end()`.

**Never logged:** merchant strings, service-family labels, aliases, titles, descriptions,
account names or numbers, `lastFourDigits`, amounts as free values, provider payloads,
credentials, tokens, the AI context or the model's reply. Transaction ids only as `hashId()`
(`src/lib/obs/events.ts:73`). `metadata.overlappingPeriods` and `metadata.dayGap` are small
integers; `potentialAnnualDuplicateCostCents` is **not** logged.

---

## 10. Privacy

- **No production data is read, queried or accessed by this task**, at specification time or
  at implementation time. There is no authenticated session and none is to be obtained.
- No test may mutate production or trigger a SimpleFIN sync.
- `ServiceFamily.aliases` contain merchant strings and therefore live **only** in the owner's
  uid-scoped Firestore documents and in memory. They are never emitted in an event, never
  written into a `ReviewCandidate.evidence` block (FIN-RELATION-001 §4.4 forbids merchant text
  there), and never sent to the model except as the capped context the existing builder
  produces (`src/lib/chat-actions.ts:58`, `MAX` at `:34`).
- Every fixture is invented and marked demo.

---

## 11. Test matrix — failing tests first

Jest, `npm test`. Fixture style follows `src/__tests__/flows.test.ts` and
`src/__tests__/ledger-classification.test.ts:27-45`.

### 11.1 Duplicate charges — `src/__tests__/duplicates.test.ts` (12)

| # | Test |
|---|---|
| U1 | **a technical duplicate is suppressed by ingestion identity and is NOT surfaced** — two rows with the same fingerprint produce no `immediate_duplicate_charge` and no subscription alert |
| U2 | **an immediate duplicate candidate is generated** — two $64.20 charges, same account, same merchant, 1 day apart, different fingerprints, score ≥ 0.75 |
| U3 | **a legitimate repeated purchase produces no high-confidence duplicate** — a daily same-amount coffee scores ≤ 0.30 and is ranked below every other candidate |
| U4 | amounts differing by one cent are **not** a duplicate |
| U5 | a 4-day gap is **not** a duplicate (the ≤3-day boundary is exact at 3 and 4) |
| U6 | a pending hold plus its posted twin is **not** a duplicate |
| U7 | two same-amount charges on **different accounts** produce no `immediate_duplicate_charge` (that path belongs to §4) |
| U8 | confirming a duplicate charge **changes no total** — `sumExpenseCents`, `getAllCategorySpending` and `buildFlowGraph` conservation are identical before and after |
| U9 | **no transaction is deleted** by any path in this module — asserted by a store spy with zero delete calls, plus a rules test that delete is denied |
| U10 | the sweep is **O(n log n)** — subset comparisons on 1k/2k/5k fixtures grow linearly, not quadratically |
| U11 | candidate ids are deterministic across discovery orders (FIN-RELATION-001 §4.2) |
| U12 | a dismissed duplicate charge does not reappear on a second run |

### 11.2 Duplicate subscriptions — `src/__tests__/duplicate-subscriptions.test.ts` (16)

| # | Test |
|---|---|
| S1 | **a duplicate subscription across accounts is detected** — the same family on `demo-card-9021` and `demo-card-4410`, 3 charges each, 3 overlapping months |
| S2 | E1: 1 charge on the second account → **no candidate** |
| S3 | E2: only 1 overlapping billing period (a migration month) → **no candidate** |
| S4 | E3: neither account satisfies the anchor rules → **no candidate**, even with 2 charges each |
| S5 | E4: one series lapsed (outside `1.5 × cadence upper bound`) → **no candidate** |
| S6 | E5: both series on the same account → **no candidate** (that is §3's job) |
| S7 | **merchant aliases map to one service family** — `DEMO OPENAI*CHATGPT SUBSCR` and `DEMO OPENAI` resolve to one family with no configuration, via rule 1 |
| S8 | **an unknown alias requires review** — `DEMO CHATGPT SUBSCRIPTION` proposes a merge with `status: 'needs_more_information'` and reason `alias_unconfirmed`, and does **not** auto-merge |
| S9 | confirming the alias writes it into the family and the same question is not asked again |
| S10 | **no service is hardcoded** — asserted structurally: no vendor name string literal appears in `src/lib/service-identity.ts` or `src/lib/duplicates.ts` outside test fixtures |
| S11 | **a modest price increase preserves continuity** — medians of `2000 → 2200 → 2400` remain one series |
| S12 | a single step > 25% splits the series and is reported, not silently merged |
| S13 | tax variation within ±$3.00 stays one band; a differing currency splits the group |
| S14 | **cancellation + a new charge alerts** — `mark_subscription_cancelled` with an effective date, then a later charge in that family, emits `continued_charge_after_cancellation` |
| S15 | **cancellation with no later charge produces no alert and says nothing** |
| S16 | `subscription_overlap` is emitted when the two series' cadences differ, and the annualized figures are what the candidate carries |

### 11.3 Avoidable cost and decisions — `src/__tests__/duplicate-decisions.test.ts` (9)

| # | Test |
|---|---|
| A1 | **the annualized estimate is correct in integer cents** — monthly `2000` → `24000`, computed as `monthlyCents × 12` with no float step |
| A2 | the **cheaper** series is used, not the dearer and not the sum |
| A3 | a yearly cadence annualizes through the reused `BANDS` multiplier, not a hand-written `/12` |
| A4 | **the estimate is labelled "potential annual duplicate cost"** — asserted on the returned label field, and the strings "savings", "you will save" and "guaranteed" appear nowhere |
| A5 | the estimate **never** enters `generateForecast()`, produces no `ForecastEvent` and adjusts no balance |
| A6 | **`intentional` marking suppresses reappearance** — including across a `duplicate-subscription-v1` → `v2` bump |
| A7 | **the different-owner case stays a real, shared expense** — the transactions remain fully counted in `sumExpenseCents`, `getAllCategorySpending` and Flow after `mark_different_owner` |
| A8 | `mark_business_subscription` produces no tax field, no deduction claim and no export column implying deductibility |
| A9 | every decision leaves both transaction documents byte-identical |

**FIN-DUPLICATE-001 total: 37 specified tests.**

---

## 12. Ready to implement when…

### 12.1 Preconditions

1. **FIN-RELATION-001 has merged.** `ReviewCandidate`, `TransactionLink`, the store, the
   deterministic identity, the suppression rule and the five duplicate-related parser actions
   all live there. Hard blocker.
2. **The one-token `export` on `src/lib/flows.ts:360` (`BANDS`) is agreed**, and its owner for
   the release window is confirmed (§12.3). Without it the alternative is a second cadence
   table, which §2.2 rules out.
3. **FIN-INCOME-001 has released `src/lib/classify.ts` and `src/types/index.ts`**, which this
   task reads and never writes.
4. **The owner has confirmed the evidence thresholds** in §4.2 — ≥2 charges per account, ≥2
   overlapping billing periods, the anchor-series requirement, and the active-series rule.
5. **The owner has confirmed the tolerance policy** in §4.3 — ±15% or ±$3.00 amount band,
   ≤40% cumulative / ≤25% single-step price drift, currency never converted.
6. **The owner has confirmed the "cheaper side" avoidable-cost rule and the mandatory
   "potential annual duplicate cost" label** (§6).
7. **The owner has confirmed that no duplicate decision changes a total** (§8) — in
   particular that `mark_different_owner` leaves the expense fully counted.
8. **`serviceFamilies` rules are in place** — the collection needs a rules block in the same
   style as FIN-RELATION-001 §6. Since `firestore.rules` is owned by FIN-RELATION-001 for this
   programme, **that block must be added by FIN-RELATION-001 in its single pass**, not by this
   task. Confirm before starting.
9. **The 37 tests in §11 are written first and are red.**
10. **A worktree exists** for the implementation branch, isolated from
    `../cashflow-forecast-fin-income-001` and from FIN-REFUND-001's worktree.

### 12.2 File ownership — FIN-DUPLICATE-001 owns these exclusively

| File | New? |
|---|---|
| `src/lib/duplicates.ts` | new — `detectRecurringByAccount()`, the immediate-duplicate sweep, cross-account pairing, the avoidable-cost estimate |
| `src/lib/service-identity.ts` | new — `ServiceFamily`, the four-rule resolution order |
| `src/__tests__/duplicates.test.ts` | new |
| `src/__tests__/duplicate-subscriptions.test.ts` | new |
| `src/__tests__/duplicate-decisions.test.ts` | new |

Five files, three of them tests, plus one declared one-token edit (§12.3).

### 12.3 Overlap warnings

- **`src/lib/flows.ts:360` — the single declared write.** FIN-DUPLICATE-001 adds `export` to
  `const BANDS`. One keyword, additive, no behaviour change. **This is the only write into
  `flows.ts` in the entire programme**, and it must be coordinated: `flows.ts` is not listed
  as FIN-INCOME-001's, but it is a high-traffic file. If any other task holds it at
  implementation time, the fallback is to import the cadence table through a re-export from
  the new module and revisit — **never** to copy the table.
- **FIN-INCOME-001** owns `src/types/index.ts`, `src/lib/classify.ts`, `src/lib/forecast.ts`,
  `src/lib/firestore.ts`, `src/context/UserProfileContext.tsx`. FIN-DUPLICATE-001 **reads and
  writes none of them**. Its worktree `../cashflow-forecast-fin-income-001` is read-only.
- **FIN-RELATION-001** owns `src/lib/chat-actions.ts`, `functions/src/prompts.ts` and
  `firestore.rules`, including the `serviceFamilies` rules block (precondition 8).
  FIN-DUPLICATE-001 writes none of them.
- **FIN-REFUND-001** (parallel) owns `src/lib/card-credit.ts` and `src/lib/refunds.ts` and
  **imports `src/lib/service-identity.ts` read-only** for merchant-family scope. Publish that
  module's export surface early so FIN-REFUND-001 can code against it; if FIN-DUPLICATE-001
  lands second, FIN-REFUND-001 falls back to exact `normalizeMerchant()` equality and adds the
  import afterwards.
- **`src/components/SubscriptionsPanel.tsx`** and **`src/lib/reminders.ts`** — read and
  reasoned about, **not modified**. Both keep working unchanged.
- **`src/lib/fingerprint.ts` and `functions-sync/simplefin.py`** — the mirrored technical-dedupe
  pair (§1.1). **Neither may be changed independently, and FIN-DUPLICATE-001 changes neither.**
- **`src/app/flow/page.tsx`** — FIN-RECOVERY-UI-001 is the sole owner. FIN-DUPLICATE-001 adds
  no UI and no component.

### 12.4 Deferred — explicitly not in FIN-DUPLICATE-001

- Cancelling a subscription, opening a dispute, or contacting a merchant. The app surfaces;
  the owner acts.
- Any bundled vendor/service registry, logo set or third-party merchant database.
- Fuzzy amount matching for immediate duplicates. Exact integer cents, on purpose.
- Multi-currency families and currency conversion.
- Duplicate detection across *households* or shared ledgers.
- Predicting a future duplicate before it is charged.
- Merging service families automatically from token overlap (rule 3 proposes; it never
  applies).
- Rewriting `detectRecurring()` or `SubscriptionsPanel` to be account-aware. Additive only,
  for now; if the cross-account view proves to be the one people want, that consolidation is
  a separate, deliberate task.
- A machine-learned identity model. §5's four rules are hand-written and explainable,
  deliberately.
