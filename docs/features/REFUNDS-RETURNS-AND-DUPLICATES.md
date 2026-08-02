# Refunds, Returns and Duplicates — programme umbrella

**Status:** Specification only. Five documents, zero implementation. Nothing under `src/`,
`functions/`, `functions-sync/` or any config file is modified by this work.

**Branch:** `docs/fin-recovery-specs`, worktree `../cashflow-forecast-recovery-specs`,
baseline `2aaf4e5` (tag `INTEGRATION_BASELINE_AFTER_LEDGER_AND_CI`) on
`feat/transfer-type-monarch-ingest`, which is live in production. **`main` is stale and is
never used.**

**The documents**

| Doc | Owns |
|---|---|
| this file | the economics, the rules, the merge order, the validation procedure |
| [FIN-RELATION-001](FIN-RELATION-001.md) | the link + allocation model, the candidate model, persistence, rules, the action parser |
| [FIN-REFUND-001](FIN-REFUND-001.md) | card-credit classification, refund matching, net economic cost |
| [FIN-DUPLICATE-001](FIN-DUPLICATE-001.md) | duplicate charges, duplicate subscriptions, service identity |
| [FIN-RECOVERY-UI-001](FIN-RECOVERY-UI-001.md) | the Flow Review surface, cards, badges, confirmation UI |

All sample data everywhere in this set is invented: "Demo Amazon Lens", "Demo Amazon Filter",
`demo-card-9021`, `$1,100.00`. **No real balance, merchant, provider id, account number,
description, screenshot or live financial value appears in any of the five documents or in any
fixture they specify.**

---

## 1. Economic purpose

The app currently answers "how much money moved" well and "what did this actually cost me"
not at all. Three concrete gaps, each already visible in the code:

1. **A credit on a credit card is guessed at by regex.** `isRefund()`
   (`src/lib/classify.ts:127`) matches `/refund|reimburse|reversal/i`; `isReward()`
   (`src/lib/classify.ts:114`) matches `/reward|cashback|…/i`. The `ponytail:` comment at
   `src/lib/classify.ts:122-125` names the hole outright: a refund filed under the original
   spend category with no "refund" word "still reads as income".
2. **Nothing links a refund to what it refunded.** `story.refunds`
   (`src/app/flow/page.tsx:431`) nets refunds out of *aggregate* spending — correct at the
   top, useless at the row. The app cannot say that a $1,100.00 purchase came back in full, or
   that $200.00 of it did not.
3. **Two subscriptions to one service on two cards are invisible.** `detectRecurring()`
   groups by merchant alone (`src/lib/flows.ts:383`) and reports "the account most of this
   merchant's charges hit" (`src/lib/flows.ts:404-412`), so the two collapse into one item.
   `SubscriptionsPanel` (`src/components/SubscriptionsPanel.tsx:23`) consumes that output, so
   the duplicate has nowhere to appear.

The purpose of this programme is to answer, honestly and auditably:

> **What did this actually cost me, and am I paying for anything twice?**

without deleting a row, without inventing a number, and without ever letting a card credit
become income by accident.

---

## 2. Credit-card semantics

### 2.1 A credit-card credit is NEVER automatically earned income

A positive on a card can be any of ten things:

`card_payment` · `merchant_refund` · `partial_refund` · `statement_credit` ·
`cashback_reward` · `promotional_credit` · `charge_reversal` · `chargeback_credit` ·
`manual_adjustment` · `unknown_card_credit`

**None of them is earned income.** FIN-REFUND-001 §3.3 encodes this as a property rather than
a policy: `CARD_CREDIT_TO_INFLOW_MEANING` is a total function from the ten kinds onto
FIN-INCOME-001's inflow taxonomy, and `earned_income` **is not in its range**. There is no
branch to forget, and a single test enumerating the map proves it.

The default when nothing is known is `unknown_card_credit` → `unknown_inflow`. Not income.
An unexplained credit surfaces for review; it never inflates a total while nobody is looking.

### 2.2 The evaluation order

First rung that holds wins. Load-bearing — the same discipline as `src/lib/classify.ts:1-5`
("Rule order is load-bearing … do not reorder without a failing test").

1. **confirmed card-payment pair** → `card_payment`
2. **confirmed merchant refund** → `merchant_refund` / `partial_refund`
3. **confirmed reversal** → `charge_reversal`
4. **confirmed chargeback** → `chargeback_credit` *(provisional)*
5. **cashback / reward / statement credit** → `cashback_reward` / `statement_credit` / `promotional_credit`
6. **manual adjustment** → `manual_adjustment`
7. **fallthrough** → `unknown_card_credit`

Two properties fall out of the order, both tested:

- **Card-payment pairing beats refund matching.** A $300.00 settlement that happens to equal a
  $300.00 purchase is a settlement. Rung 1 fires before rung 2 looks.
- **Rungs 2–4 require a *confirmed* link**, so an unconfirmed suggestion cannot change a
  classification. "Nothing applies before confirmation" is enforced by the ladder's own
  structure, not by a reminder.

### 2.3 A card payment is debt settlement

**$0 aggregate income impact. $0 aggregate spending impact. The purchases are the expenses.**

This is already correct and already tested — both the card leg and the bank leg
(`src/__tests__/ledger-classification.test.ts:50-135`, including the case where a purchase at
"PAYMENT PROCESSING SOLUTIONS LLC" was read as a settlement, hiding the spend *and* reducing
the card balance, "wrong twice for one row", `src/lib/classify.ts:64-70`).

**This programme does not respecify card-payment detection.** It consumes
`interpretTransaction(...).transfer === 'card_settlement'` (`src/lib/classify.ts:271`) and
`matchTransfers()` (`src/lib/transfers.ts:56`) as rung 1 and changes neither.

### 2.4 A refund reverses economic cost

- **Not income.** It reduces what something cost; it does not add to what was earned.
- **Increases cash** on a bank account; **reduces liability** on a card. `isPositive()`
  (`src/lib/classify.ts:133`) already signs it correctly on a debt account.
- **Both rows stay in history**, at full amount, with their original dates, descriptions,
  provider ids and categories.
- **Linked with an explicit allocation** — full, partial, one-to-many or many-to-one — in
  integer cents.

---

## 3. Raw history versus personal economic cost

**The governing rule: preserve BOTH gross cash movement and personal economic cost. Never
destroy gross history to show net.**

This is already how the app thinks. `buildFlowGraph()` keeps `grossForwardCents` /
`grossReverseCents` alongside the net `cents` on a `FlowLink` (`src/lib/flows.ts:72-75`), and
the between-accounts table shows gross both directions. `FIN-REVIEW-002.md:596-600` states the
same rule for links.

| | Gross | Net |
|---|---|---|
| What it is | every dollar that actually moved | what the owner is actually out of pocket |
| Where it lives | History, Export, the Sankey, account balances | the review panel, per-category net, the "returned" badges |
| Changed by a refund? | **never** | yes, by the confirmed allocation |
| Auditable against a statement? | **yes — this is why it is untouchable** | it is a derived view, always shown beside gross |

Concretely, for the sanitized anchor:

- **Gross:** a $1,100.00 purchase, a $100.00 purchase, a $1,200.00 credit. Three rows, three
  amounts, forever.
- **Net:** both purchases cost $0.00. Shopping for that month falls by $1,200.00.
- **Income:** unchanged. Not one cent of the $1,200.00 is earned income.
- **Flow:** unchanged. No node, no edge, no conservation change — the credit already reaches
  the `refunds` node (`src/lib/flows.ts:224-228`, "a refund is not income (owner rule)"), and
  the relationship renders as a highlight affordance, not a ribbon.

**Never shown net-only.** A category line reads `$1,640.00 gross · $1,440.00 after refunds`.
A net figure standing alone makes the ledger unauditable against a bank statement, which is
the one thing the owner can independently check.

---

## 4. Refund matching

Three shapes, all in integer cents, none of them auto-confirmed at any score.

| Shape | Condition | Result |
|---|---|---|
| **exact** | credit cents == one purchase's cents | one `refund_of` |
| **partial** | credit cents < one purchase's cents | one `partial_refund_of`; the remainder is stated in words |
| **combined** | credit cents == the sum of 2..4 purchases' cents | one `refund_of` per purchase; allocations sum exactly to the credit |
| **many-to-one** | several credits against one purchase | accumulate, capped by the purchase (FIN-RELATION-001 V5) |

**Window:** purchases in `[credit − 180 days, credit + 5 days]`. **Scope:** same normalized
merchant (`normalizeMerchant()`, `src/lib/flows.ts:374`) or same service family; same account
preferred, a different account allowed at −0.2 confidence. **Cap:** the top 12 purchases.

### 4.1 The combined-refund bound

Bounded subset-sum on integers. `MAX_CANDIDATE_PURCHASES = 12`, `MAX_COMBINATION_SIZE = 4`,
`MAX_COMBINATIONS = 5`. Depth-first with two prunes (`runningSum + next > target`;
`runningSum + remaining < target`) and a size cap.

**Why it is not exponential:** the search space is a constant, because `n` is never the
ledger.

```
Σ(k=1..4) C(12,k) = 12 + 66 + 220 + 495 = 793 subsets
                  ≤ 3,172 integer additions per credit, worst case

Total = O(n)  index build (once per period)
      + O(R · log n)  windowed lookup per credit
      + O(R · 793)    the bounded walk
      = linear in n, linear in R, CONSTANT per credit
```

Even with the size cap removed the ceiling is `2^12 − 1 = 4,095` — still a constant. There is
no exponential term and no `n²` term. FIN-REFUND-001 test M20 asserts it empirically on 1k /
2k / 5k fixtures with an instrumented subset counter.

**Ranking:** exact combined amount → fewest purchases → same account → closest dates →
strongest reference overlap → transaction ids ascending (the deterministic final tie-break).

### 4.2 Ambiguity never resolves itself

If two candidates score within 0.05 of each other for the same credit, **all** are emitted
`unreviewed` with an `ambiguous_match` reason code and **none** is presented as the answer.
The UI shows them as alternatives with no pre-selection and Confirm disabled until the owner
picks. There is no confidence at which the system decides for them.

---

## 5. The allocation model

Owned by [FIN-RELATION-001](FIN-RELATION-001.md). Summary of the contract every other document
depends on:

**Nine link types:** `refund_of` · `partial_refund_of` · `reversal_of` · `chargeback_for` ·
`card_payment_pair` · `reimbursement_for` · `repayment_of` · `duplicate_candidate` ·
`subscription_overlap`.

**Five statuses:** `suggested` · `confirmed` · `rejected` · `superseded` · `provisional`.

**Integer cents only.** `4120`, never `41.2`. `Number.isInteger` at the pure validator, at the
store, and as `is int` in `firestore.rules`.

**Validation, all of it:**

- positive amounts (`> 0`, integer);
- refund total ≤ the refund's amount, without an explicit `over_allocated_credit` state;
- purchase refunded total ≤ the purchase's amount, without an explicit `over_refunded` state;
- no self-links;
- idempotent duplicate links — the link id is `linkType~source~target`, so re-proposing is an
  upsert and there is nothing to dedupe;
- auditable confirmations — `confirmedAt`, `confirmedBy`, `algorithmVersion`, `candidateId`;
- suppressible rejections — a `rejected` link is never deleted, because it *is* the suppression
  record.

**Nothing is ever silently clamped.** An over-allocation is rejected with a stated reason, or
stored under an explicit named conflict state that surfaces for review.

### 5.1 Deterministic candidate identity — and the version trap

Candidate types: `refund_match` · `combined_refund_match` · `partial_refund_match` ·
`unknown_card_credit` · `immediate_duplicate_charge` · `duplicate_subscription` ·
`subscription_overlap` · `continued_charge_after_cancellation`.

Review statuses: `unreviewed` · `suggested` · `confirmed` · `dismissed` · `intentional` ·
`needs_more_information`.

Identity is **two parts**, because one string cannot satisfy both requirements:

```
identityKey (doc id) = `${candidateType}~${sortedTransactionIds.join('~')}`
candidateId (field)  = `${candidateType}~${algorithmVersion}~${sortedTransactionIds.join('~')}`
```

If the version were in the document id, bumping `refund-match-v1` → `v2` would mint a new id
and **every dismissed candidate would resurface** — the exact failure the requirement exists
to prevent. The doc id therefore omits the version; the version lives in a field for audit.
FIN-RELATION-001 §4.2 states this in full, and tests C3/C4 pin both halves.

### 5.2 Algorithm versioning

`refund-match-v1` · `combined-refund-v1` · `duplicate-charge-v1` ·
`duplicate-subscription-v1`.

A version bump **re-evaluates only `unreviewed` candidates**. `suggested`, `confirmed`,
`dismissed`, `intentional` and `needs_more_information` are untouched, including their stored
`algorithmVersion` — that field records which generator produced the instance the owner
actually saw. **A version bump never silently reinterprets a confirmed decision.**

---

## 6. Duplicate detection

**Duplicate detection never deletes a transaction.** No delete path, no delete action in the
parser, and `firestore.rules` denies delete on both new collections.

### 6.1 Three different things

| | Technical duplicate | Economic duplicate | Duplicate subscription |
|---|---|---|---|
| | one event, two ingestion sightings | **two real posted charges** | two live series for one service |
| Owned by | `src/lib/fingerprint.ts` (shipped) | FIN-DUPLICATE-001 | FIN-DUPLICATE-001 |
| Alert? | **no** | yes | yes |

**The technical layer sits BELOW this work.** `src/lib/fingerprint.ts:46-51` computes
`${accountId}|${signedCents}|${yyyy-MM-dd}` and `findTwin()` matches within ±3 days with a
shared `claimed` set. It is **mirrored byte-for-byte** by
`functions-sync/simplefin.py:138` (`signed_cents_of`), whose docstring says so.
**Neither may be changed independently** — a change to one without the other silently splits
or merges rows on the next sync. **This programme changes neither.**

### 6.2 Duplicate subscriptions — the evidence bar

Grouped by `(serviceFamilyId, accountId, currency, cadence, amountBand, activeDateRange)` and
compared **across accounts**. All of these must hold:

- **≥ 2 charges on each account** — one charge is a trial, not a subscription;
- **≥ 2 overlapping billing periods** — one overlap is a migration month;
- **an anchor series** satisfying the full reused `detectRecurring` rule set on at least one
  account (≥3 unique days, dispersion ≤ 25% of median, median ≥ $5, in-band ratio ≥ 0.6 —
  `src/lib/flows.ts:391-402`, rules that exist because "each killed a verified false result on
  the real data");
- **both series active** by the reused rule (`src/lib/flows.ts:411`);
- **different accounts** — same-account repetition is the economic-duplicate case.

Tolerances: amount band ±15% or ±$3.00, whichever is wider (tax and currency variation);
gradual price increases keep continuity up to ≤40% cumulative with no single step >25%; a
differing currency splits the group and is never converted.

### 6.3 No service is hardcoded

There is no `if (merchant.includes('CHATGPT'))` anywhere and no bundled vendor list.
`COMMON_MERCHANTS` (`src/types/index.ts:379-461`) is a colour and category aid and is **not**
used as a service registry.

Service identity is a four-rule ladder over an owner-owned, uid-scoped `ServiceFamily`
collection seeded from the owner's own data:

1. `normalizeMerchant()` equality → same family, automatic;
2. a confirmed alias → same family, automatic;
3. token overlap (≥1 shared token ≥4 chars, generic tokens removed) → **proposes a merge for
   review**, `needs_more_information`, never automatic;
4. otherwise → distinct families.

The ChatGPT example is illustrative only. `DEMO OPENAI*CHATGPT SUBSCR` normalizes to
`DEMO OPENAI` (because `normalizeMerchant()` strips `[#*]\S*`), so it unifies with
`DEMO OPENAI` for free under rule 1 — while `DEMO CHATGPT SUBSCRIPTION` normalizes to itself
and must go through rule 3 and be confirmed. That third case is the model working, not
failing: it refuses to guess about money.

### 6.4 Avoidable cost

```
potentialAnnualDuplicateCostCents = cheaperSeries.monthlyCents × 12
```

The **cheaper** side, not the dearer and not the sum. Labelled **"potential annual duplicate
cost"** — never "savings", never "you will save", never "guaranteed". It never enters the
forecast, never becomes a `ForecastEvent`, never adjusts a balance and never touches a budget.
It is a number beside a question.

### 6.5 The decisions

Confirm duplicate charge · Confirm duplicate subscription (with which side to keep) · **On
purpose** · **Different person** · **For business** · Cancelled on ⟨date⟩ · Dismiss · Can't
tell yet.

Every one is a statement about **the alert**, not about the money. In particular
**"different person" leaves the expense fully counted** — it is a real shared expense, not a
mistake, and nothing is reduced. "For business" is a label only: no tax category, no
deductibility claim, no export column implying one.

---

## 7. AI boundaries

**One parser, one trust boundary, one callable, no public route.**

`src/lib/chat-actions.ts` is already the trust boundary and its design is correct
(`src/lib/chat-actions.ts:1-12`): unknown actions, unknown keys and invented values are
rejected outright rather than coerced, and a rejected payload returns `null` so the UI shows
raw text instead of offering something nobody asked for. This programme **extends** the
`ChatAction` union using the existing `record()` / `str()` primitives
(`src/lib/chat-actions.ts:92`, `:99`). **No second parser. No schema library.**

Transport is the authenticated `aiChat` callable (`functions/src/chat.ts:23-27`) with its
auth guard and `checkRateLimit(uid, 'aiChat', LIMITS.aiChat)`
(`functions/src/rate-limit.ts:12-16`). **There is no public AI route** — SEC-001 deleted
`src/app/api/ai/decision` and `src/app/api/parse-receipt`, and
`src/__tests__/no-public-ai-routes.test.ts` pins it. This programme adds no route and no
second callable.

### 7.1 What the AI may do

Operate **only on deterministic candidates chosen by application code**. Explain, summarise,
suggest an allocation from the ids it was given, ask **one** focused clarifying question, and
propose a structured action.

### 7.2 What it may not do

- perform authoritative arithmetic (`src/lib/forecast.ts:1-7`: "AI only interprets these
  results — it never calculates");
- apply a link — there is no code path from a model response to a Firestore write;
- mark a card credit as income — no action can, and the projection map has no path to
  `earned_income`;
- delete a transaction — no action, no rule permits it;
- create a broad merchant rule silently;
- receive the full ledger — context is capped by one builder (`src/lib/chat-actions.ts:58`,
  `MAX` at `:34`) and re-clipped server-side (`functions/src/prompts.ts:227`);
- treat transaction descriptions as instructions — `functions/src/prompts.ts:213-214` carries
  the clause; the closed-value parser is the enforcement.

### 7.3 The thirteen structured actions

`confirm_refund_allocation` · `adjust_refund_allocation` · `reject_refund_candidate` ·
`classify_card_credit` · `mark_reward_credit` · `mark_chargeback_credit` ·
`confirm_duplicate_charge` · `confirm_duplicate_subscription` · `mark_intentional_duplicate` ·
`mark_different_owner` · `mark_business_subscription` · `mark_subscription_cancelled` ·
`dismiss_review_candidate`

All thirteen land in **one pass, in FIN-RELATION-001**, which is a large part of why it merges
first: after it, the parser is closed and the parallel tasks touch it not at all.

**Validation:** known action · known keys only, at every depth · existing transaction ids ·
integer cents · positive allocations · allocation totals within both caps · ownership ·
**candidate relationship** (an id must belong to the referenced candidate) · max list size,
**rejected not truncated** · no prototype-pollution keys (`__proto__` / `constructor` /
`prototype`), with an explicit check *in addition to* the unknown-key rejection so a later
`allowed`-list edit cannot reopen it.

**Nothing applies before confirmation.** A parsed action renders a confirmation card and
stops. No auto-apply mode, no "apply all", no setting that disables the gate.

---

## 8. Flow Review behaviour

`/flow?tab=review` — **already reserved** by
`docs/ux/PROPOSED-INFORMATION-ARCHITECTURE.md:69-86`, which allocates the tab contract, ships
it empty initially, and puts a count badge on the Flow destination rather than the tab so the
count is visible from anywhere.

**One review queue.** `FIN-REVIEW-002.md:36-39` requires "one review queue, one review state
machine, one AI discussion surface, one confirmation gate, one persistence path, one telemetry
namespace". Recovery candidates are a second **item source** in that one queue, never a second
queue. FIN-RECOVERY-UI-001 §2.2 defines the shared `ReviewQueueItem` view model and §2.3 the
state-vocabulary alignment; **whichever of the two tasks ships first builds the shell and the
other adds a source to it.** On current sequencing that is FIN-RECOVERY-UI-001, because
FIN-REVIEW-002 is hard-blocked on FIN-INCOME-001 (`FIN-REVIEW-002.md:1076-1085`).

The surface: a chip strip below the story tiles; a persistent right-hand panel on desktop; the
existing `Sheet` (native `<dialog>`, focus trap, Escape, iOS scroll lock) on mobile; refund,
duplicate and card-credit cards; a confirmation card that states the money effect *and* what
does not change; one `aria-live` announcement; one-step undo while the panel is open. No page
reload, no `router.refresh()`, no in-place mutation.

---

## 9. Analytics

- **Gross and net side by side, always.** `$1,640.00 gross · $1,440.00 after refunds`. Never
  net alone.
- **Per-category net** falls by confirmed refunds and by nothing else. A `suggested` link
  moves no number.
- **The Sankey is unchanged.** No node, no edge, no conservation change; conservation stays
  unit-tested by `src/__tests__/flows.integration.test.ts`. The relationship renders as a
  linked-pair highlight through the existing trace machinery
  (`src/app/flow/page.tsx:267`, `:280`) plus a drill-down line.
- **The text alternative stays accurate.** Anything shown in the SVG appears in the
  flow-as-a-table `<details>` (`src/app/flow/page.tsx:691-716`), which exists because "the
  diagram is unreadable to a screen reader".
- **Recovery totals** are reported separately and never summed together: *"$1,215.00
  returned"* is money that came back; *"$240.00 potential annual duplicate cost"* is not.

---

## 10. Forecast treatment

| Thing | Forecast treatment | Why |
|---|---|---|
| A refund | **never a recurring income stream** | `detectRecurring()` only groups `classifyTransaction() === 'expense'` rows (`src/lib/flows.ts:382`), so it structurally cannot; the `monthlyAverages()` path is FIN-INCOME-001's to fix |
| A refund's effect on the spending baseline | reduces the net cost of the purchase, and therefore the category baseline | net is what will recur, not gross |
| A provisional dispute credit | **excluded from every baseline** | it may be taken back |
| A confirmed duplicate charge | **no forecast change** | both charges are real and already counted |
| A confirmed duplicate subscription | **no forecast change** | the owner has not cancelled anything yet; the app does not project a decision it did not observe |
| `potentialAnnualDuplicateCostCents` | **never enters the forecast** | it is a question, not a cash flow |

A refund is not a recurring inflow. A detected duplicate is not a future saving. The forecast
projects what the data shows, and this programme adds no projection at all.

---

## 11. Production-data validation — SAFETY CRITICAL

The owner has a real Amazon-related transaction dated **2026-07-31**, plus other Amazon
purchases and refunds. It is the reason this programme exists and it is the thing that must
never enter the repository.

> **No agent working on this programme reads, queries or accesses production data.** There is
> no authenticated session and none is to be obtained. No test may mutate production or
> trigger a SimpleFIN sync.
>
> **Never committed, anywhere, ever:** the real transaction, its provider id, the account
> number, the raw description, screenshots containing live balances, or any live financial
> value.

Validation happens in two separate places, and they never meet.

### 11.1 The manual procedure — the owner runs this, read-only

**Nobody but the owner performs this. It is read-only, in the app's own UI, with no console
query, no export of raw rows into a shared location, and no sync trigger.**

**Window.** 120 days before and 60 days after the anchor date **2026-07-31** — that is
**2026-04-02 through 2026-09-29**. The 120-day lookback comfortably exceeds any retailer
return window; the 60-day lookahead catches a refund that posts long after the return.

**For the anchor transaction and every Amazon-family row in the window, inspect:**

| # | What to look at | Why it matters |
|---|---|---|
| 1 | **posted date** (not the order date) | the matcher windows on posted dates |
| 2 | **merchant family** — the raw text, and what `normalizeMerchant()` would make of it (`[#*]…` and trailing digit runs are stripped, `src/lib/flows.ts:374`) | decides whether two rows are even compared |
| 3 | **account type** — card or bank | rung 1 and the sign rule both depend on it |
| 4 | **nearby purchases** — every outflow in the same family within 180 days before | the candidate pool |
| 5 | **nearby credits** — every inflow in the same family within the window | the credits to be explained |
| 6 | **categories** — both `category` and `sourceCategory` (`src/types/index.ts:308`) | a refund filed under the spend category is the documented failure case |
| 7 | **pending status** (`src/types/index.ts:315`) | a hold is never a finalized refund |
| 8 | **provider direction** — how the source signed it, and `transferDirection` if present | `isPositive()` reads it first (`src/lib/classify.ts:139`) |
| 9 | **the current classifier result** — what `interpretTransaction()` says today: `meaning`, `income`, `expense`, `confidence`, `reason` | the "before" half of the report |

**Then answer, per credit:** does any single purchase match it exactly? Does any combination of
2–4 purchases sum to it exactly? Is there more than one plausible answer?

### 11.2 The sanitized report template — the ONLY thing that comes back

Fill this in with **counts and yes/no answers only**. No merchant, no id, no account, no date,
no amount.

```
RECOVERY VALIDATION REPORT — sanitized
Window inspected:            120 days before / 60 days after the anchor
Card-account credits found:                        __
  of which card payments:                          __
  of which text-detectable refunds:                __
  of which NOT text-detectable:                    __
  of which rewards / statement credits:            __
  of which unexplained:                            __
Refund candidates a human can match:               __
  exact single-purchase matches:                   __
  partial matches:                                 __
  combined (2-4 purchase) matches:                 __
  ambiguous (more than one plausible answer):      __
Combined match present in the real data?           yes / no
Combined match size (number of purchases):         __
Refund on a DIFFERENT account than the purchase?   yes / no
Any refund filed under the original spend
  category with no "refund" word?                  yes / no
Immediate duplicate charges observed:              __
Services billed on more than one account:          __
  with >= 2 charges on each account:               __
  with >= 2 overlapping billing periods:           __
Merchant aliases that a human unified but
  normalizeMerchant() would NOT:                   __

CURRENT vs EXPECTED interpretation
  credits currently counted as income:             __
  credits that SHOULD be counted as income:        __   (expected: 0)
  purchases showing a net cost equal to gross
    that a human would call fully returned:        __
```

That table contains no live identifier and no live value. It is the whole of what crosses from
production into the design.

### 11.3 The sanitized fixture — what automated tests actually use

Structure preserved, content invented. Committed to the repo; used by FIN-REFUND-001 tests
M3/M4 and by the cross-surface suite (§13).

```ts
// Sanitized. Invented ids, invented descriptions, clearly-marked demo accounts.
// Preserves ONLY the structural pattern: two purchases, one combined credit.
const DEMO_CARD = {
  id: 'demo-card-9021', name: 'Demo Rewards Card', type: 'credit_card',
  provider: 'amex', lastFourDigits: '9021', creditLimit: 500000,
  openingBalance: 0, openingDate: '2000-01-01', color: '#222', isActive: true,
};

const PURCHASE_A = tx({
  id: 'demo-purchase-a', title: 'Demo Amazon Lens', merchant: 'DEMO AMAZON',
  amount: 1100, category: 'shopping', accountId: 'demo-card-9021', date: '2026-07-12',
});
const PURCHASE_B = tx({
  id: 'demo-purchase-b', title: 'Demo Amazon Filter', merchant: 'DEMO AMAZON',
  amount: 100, category: 'shopping', accountId: 'demo-card-9021', date: '2026-07-14',
});
const COMBINED_CREDIT = tx({
  id: 'demo-refund-ab', title: 'Demo Amazon Refund', merchant: 'DEMO AMAZON',
  amount: 1200, type: 'income', accountId: 'demo-card-9021', date: '2026-07-31',
});

// Hand-computed truth, integer cents:
//   110000 + 10000 === 120000   → one combined_refund_match, two allocations
//   netEconomicCostCents        → 0 on both purchases
//   earned income contribution  → 0
//   gross history               → three rows, unchanged
```

Everything real about the anchor is gone: the ids are fake, the descriptions are fake, the
account is a clearly-marked demo, and the amounts are round invented numbers. What survives is
the only thing the tests need — **the shape**: two purchases on one card, one credit equal to
their sum, posted after both.

### 11.4 What is never specified as a test

- A test that reads production Firestore.
- A test that signs in.
- A test that triggers a SimpleFIN sync or any provider call.
- A test that writes to any live collection.
- A Playwright run against production. `docs/observability/ADDING-A-TRACEABLE-FLOW.md:110-120`
  already forbids it — "**Never** sign in and never read live Firestore — production is also
  the development environment" — and this programme adds nothing that weakens it.

---

## 12. Privacy and observability

**Reuse OBS-001. Never a second telemetry system.** OBS-001 is **merged at this baseline** —
`src/lib/obs/` exists on `feat/transfer-type-monarch-ingest`, so the "instrument later"
fallback in `FIN-REVIEW-002.md:869-876` does not apply here. Instrumentation ships with the
code, and never `console.log`.

`emit()` (`src/lib/obs/events.ts:154`) with the single `DiagEvent` shape — no free-text
`message` field by design — gated off in production by default
(`src/lib/obs/events.ts:58-63`), through the one redactor (`src/lib/obs/redact.ts:79`).

**Events:** `Refund.CandidateGenerated` · `Refund.MatchConfirmed` ·
`Refund.AllocationAdjusted` · `Refund.MatchRejected` · `CardCredit.Classified` ·
`DuplicateCharge.CandidateGenerated` · `DuplicateSubscription.CandidateGenerated` ·
`DuplicateCandidate.Confirmed` · `DuplicateCandidate.MarkedIntentional` ·
`DuplicateCandidate.Dismissed`, plus `Relation.*` (FIN-RELATION-001 §9.1) and
`RecoveryReview.*` (FIN-RECOVERY-UI-001 §10).

**Safe properties only:** counts, enum values, reason codes, booleans, small integers,
durations, result statuses. Transaction ids only as `hashId()` (`src/lib/obs/events.ts:73`).

**Never logged:** full descriptions, merchant strings, titles, service-family labels, aliases,
full account numbers, account names, `lastFourDigits`, amounts as free values, provider
payloads, credentials, tokens, the full AI context, the owner's typed message, or the model's
reply.

**Candidate documents carry no free text at all** (FIN-RELATION-001 §4.4): evidence is
amounts, day gaps, booleans, enums and reason codes. The collection cannot become a shadow
copy of the ledger, which is what makes it safe to count in a diagnostics bundle.

---

## 13. Cross-surface consistency — ONE sanitized scenario

`src/__tests__/cross-surface-consistency.test.ts` is the pattern
(one fixture ledger, hand-computed integer-cent truth, every surface asserted against it,
`:62-69`). This programme extends that discipline with one scenario containing every case:

| Row | Shape |
|---|---|
| card purchase | $1,100.00, `demo-card-9021`, shopping |
| card purchase | $100.00, `demo-card-9021`, shopping |
| card payment | bank leg + card leg, $300.00 |
| exact refund | $45.00 against a $45.00 purchase |
| partial refund | $900.00 against a $1,100.00 purchase |
| combined refund | $1,200.00 against $1,100.00 + $100.00 |
| cashback credit | $12.50 on the card |
| unknown card credit | $88.00, no text signal |
| immediate duplicate charge | two $64.20 charges, same card, 1 day apart |
| duplicate subscription | $20.00/mo on two demo cards, 4 overlapping months |
| intentional duplicate | the same, marked `intentional` |

Asserted **identically** across **Dashboard, Accounts, Flow, Analytics, Budgets, Forecast,
History, Export and AI context** — the same nine-surface discipline
`src/__tests__/cross-surface-consistency.test.ts` already applies:

| # | Test |
|---|---|
| X1 | all nine surfaces report the same income total, and **no card credit contributes to it** |
| X2 | all nine report the same **gross** expense total |
| X3 | all nine report the same **net** expense total after confirmed refunds |
| X4 | a card payment contributes zero to income and zero to expenses on all nine |
| X5 | a refund increases income **nowhere** and reduces spending **everywhere** consistently |
| X6 | a combined refund reduces exactly two purchases to $0.00 net, on all nine |
| X7 | a provisional credit reduces net cost **nowhere**, and is labelled provisional wherever shown |
| X8 | a confirmed duplicate charge changes **no** total on any surface |
| X9 | an `intentional` duplicate leaves both transactions fully counted on all nine |
| X10 | Flow conservation is unchanged with every link confirmed — same nodes, same links, same cents |
| X11 | gross history is byte-identical before and after every confirmation in the scenario |
| X12 | no surface contains its own recovery branch — asserted structurally, as `src/__tests__/cross-surface-consistency.test.ts` does for classification |

**Owner:** FIN-RECOVERY-UI-001, in `src/__tests__/recovery-cross-surface.test.ts`, because it
is the only task that has every dependency merged.

---

## 14. Task dependencies and merge order

```
FIN-INCOME-001  (running now, ../cashflow-forecast-fin-income-001)
        │  owns: src/types/index.ts, src/lib/classify.ts, src/lib/forecast.ts,
        │        src/lib/firestore.ts, src/context/UserProfileContext.tsx,
        │        the INFLOW TAXONOMY
        ▼
FIN-RELATION-001   ← MERGES FIRST. Link + allocation model, candidate model,
        │            store, firestore.rules, all 13 parser actions.
        │            Changes NO displayed number.
        ├──────────────┬──────────────┐
        ▼              ▼              │
FIN-REFUND-001   FIN-DUPLICATE-001    │  ← PARALLEL, and parallel ONLY because
 card-credit      duplicate charges   │    their file ownership is disjoint.
 classification,  + subscriptions,    │
 refund matching, service identity    │
 net cost         avoidable cost      │
        └──────────────┴──────────────┘
                       ▼
              FIN-RECOVERY-UI-001   ← LAST. SOLE OWNER of src/app/flow/page.tsx.
                                      Owns the cross-surface suite (§13).
```

**Stated plainly, everywhere it matters:**

- **FIN-RELATION-001 merges FIRST.** Everything else writes links and candidates, and the
  parser, the rules and the store must exist and be closed before two tasks run at once.
- **FIN-REFUND-001 and FIN-DUPLICATE-001 may then run in parallel ONLY because their file
  ownership is disjoint.** Not because they are unrelated — they share a queue, a parser and a
  telemetry namespace — but because after FIN-RELATION-001 lands, neither writes a file the
  other writes.
- **FIN-RECOVERY-UI-001 is last and is the sole owner of `src/app/flow/page.tsx`.** No other
  task in this programme touches any UI file.

### 14.1 File-ownership map across all four tasks

| File | FIN-RELATION-001 | FIN-REFUND-001 | FIN-DUPLICATE-001 | FIN-RECOVERY-UI-001 |
|---|:--:|:--:|:--:|:--:|
| `src/lib/relations.ts` *(new)* | **own** | read | read | read |
| `src/lib/candidates.ts` *(new)* | **own** | read | read | read |
| `src/lib/relations-store.ts` *(new)* | **own** | read | read | read |
| `src/lib/chat-actions.ts` | **own** | — | — | read |
| `functions/src/prompts.ts` | **own** | — | — | — |
| `firestore.rules` | **own** | — | — | — |
| `src/lib/card-credit.ts` *(new)* | — | **own** | — | read |
| `src/lib/refunds.ts` *(new)* | — | **own** | — | read |
| `src/lib/duplicates.ts` *(new)* | — | — | **own** | read |
| `src/lib/service-identity.ts` *(new)* | — | read | **own** | read |
| `src/lib/flows.ts` | — | read | **1-token `export`** | read |
| `src/lib/review-queue.ts` *(new)* | — | — | — | **own** |
| `src/app/flow/page.tsx` | — | — | — | **SOLE OWNER** |
| `src/components/Recovery*.tsx`, `*Card.tsx`, `*Badge.tsx` *(new)* | — | — | — | **own** |
| `src/lib/obs/useRecoveryObservability.ts` *(new)* | — | — | — | **own** |
| `src/types/index.ts` | read | read | read | read |
| `src/lib/classify.ts` | read | read | read | read |
| `src/lib/forecast.ts` | read | read | read | read |
| `src/lib/firestore.ts` | read | read | read | read |
| `src/lib/transfers.ts`, `fingerprint.ts`, `money.ts`, `mapping-rules.ts` | read | read | read | read |
| `src/components/SubscriptionsPanel.tsx`, `src/lib/reminders.ts` | read | read | read | read |
| `functions-sync/simplefin.py` | — | — | — | — |

### 14.2 Overlap warnings

1. **FIN-INCOME-001 is running now** in `../cashflow-forecast-fin-income-001` and owns
   `src/types/index.ts`, `src/lib/classify.ts`, `src/lib/forecast.ts`, `src/lib/firestore.ts`,
   `src/context/UserProfileContext.tsx` and the inflow taxonomy. **Every task in this
   programme reads those files and writes none of them.** Its worktree is read-only. The link
   and candidate types live in new modules precisely so no line of `src/types/index.ts` is
   contended, and `src/lib/relations-store.ts` exists precisely so no line of
   `src/lib/firestore.ts` is.
2. **Card-credit categories EXTEND FIN-INCOME-001's taxonomy — they never fork it.**
   `CardCreditKind` is a narrower second dimension that projects onto the inflow taxonomy
   through one total function whose range excludes `earned_income`. No local copy of the
   taxonomy, no local `as const` array, no local string union "just for the parser". The
   places a duplicate would otherwise appear are catalogued at `FIN-REVIEW-002.md:227-236`.
3. **`src/lib/chat-actions.ts` + `functions/src/prompts.ts` are the programme's biggest
   collision risk.** Both FIN-REFUND-001 and FIN-DUPLICATE-001 need actions there. Resolved by
   FIN-RELATION-001 landing all thirteen in one pass and merging first.
4. **`firestore.rules`** — same resolution. One task, one pass. FIN-DUPLICATE-001's
   `serviceFamilies` rules block must therefore be included in FIN-RELATION-001's pass;
   confirm before either starts.
5. **`src/lib/flows.ts:360`** — FIN-DUPLICATE-001 needs `export` added to `const BANDS`. One
   additive keyword, and **the only write into `flows.ts` in the entire programme**. Copying
   the cadence table instead would create two definitions that drift.
6. **`src/lib/budgets.ts`** — possibly edited so category spending reads net (FIN-REFUND-001
   test M18). Ownership must be confirmed; if it is held, M18 is deferred **with the reason
   recorded**, not silently dropped.
7. **`src/components/DataChatSheet.tsx` / `Sheet.tsx`** — composed, not edited. If the
   discussion pane needs a new prop, FIN-RECOVERY-UI-001 must claim the file explicitly,
   because FIN-REVIEW-002 also plans to build on it (`FIN-REVIEW-002.md:790-793`).
8. **`src/lib/fingerprint.ts` and `functions-sync/simplefin.py`** are a mirrored pair
   (`functions-sync/simplefin.py:138` says so in its docstring). **Neither may be changed
   independently.** No task in this programme changes either.
9. **FIN-REVIEW-002** is specified and unimplemented. This programme **composes** with it:
   FIN-RELATION-001 §4.6 reconciles the link interface name-by-name, and FIN-RECOVERY-UI-001
   §2.2–2.3 defines the one queue and the one state vocabulary. **Whichever ships first builds
   the shell.**
10. **UX-IA-001** owns `src/lib/nav.ts`, `Navbar.tsx`, `BottomNav.tsx`, `next.config` and the
    `/history` · `/analytics` · `/cashflow` · `/calendar` consolidation.
    FIN-RECOVERY-UI-001 implements **only** `?tab=review` and the `?tab=` read.

---

## 15. Test coverage specified

| Document | Suites | Tests |
|---|---|---|
| FIN-RELATION-001 | `relations`, `candidates`, `relations-rules`, `recovery-actions` | **45** |
| FIN-REFUND-001 | `card-credit`, `refunds`, `refund-economics`, `refund-flow-contract` | **46** |
| FIN-DUPLICATE-001 | `duplicates`, `duplicate-subscriptions`, `duplicate-decisions` | **37** |
| FIN-RECOVERY-UI-001 | `recovery-queue`, `recovery-cards`, `recovery-confirm`, `recovery-flow-view`, `recovery-a11y` | **38** |
| Cross-surface (§13) | `recovery-cross-surface` | **12** |
| | | **178** |

All red first, per the repo's TDD practice. All fixtures invented. None reads production, none
signs in, none triggers a sync.

---

## 16. Preconditions still blocking implementation

Nothing in `src/` changes until every one of these is true.

**Blocking the whole programme**

1. **FIN-INCOME-001 has merged** and exports the inflow-taxonomy type, its value list and its
   earned-income predicate from a known module path.
2. **FIN-INCOME-001 has released** `src/types/index.ts`, `src/lib/classify.ts`,
   `src/lib/forecast.ts`, `src/lib/firestore.ts` and `src/context/UserProfileContext.tsx`.
3. **FIN-INCOME-001 has ruled on today's refund-counted-as-income behaviour**, documented at
   `src/__tests__/cross-surface-consistency.test.ts:63-69`. Until then FIN-REFUND-001 test M17
   ("earned income unchanged by a refund") cannot be written, and no task may pre-empt the
   decision by editing `sumIncomeCents`.
4. **The owner has run the manual validation procedure** (§11.1) and returned the sanitized
   report (§11.2). The programme is designed around a structural pattern that has not yet been
   confirmed against the owner's own data.
5. **A Firestore rules test harness exists** (emulator + runner), or standing one up is the
   first commit of FIN-RELATION-001. The rules block is a trust boundary; an untested trust
   boundary is a claim.

**Blocking FIN-RELATION-001**

6. Owner confirmation of the **two-part candidate identity** (§5.1) — the doc id omits the
   algorithm version so a dismissal survives a version bump.
7. Owner confirmation of the **over-allocation policy** — reject by default, store only under
   an explicit named conflict state, never silently clamp.
8. Owner confirmation that **`internal_transfer_leg` stays out of the link set**, because
   `matchTransfers()` computes leg pairing live and a stored copy would be staler.
9. Agreement that **FIN-RELATION-001's rules pass includes the `serviceFamilies` block**
   FIN-DUPLICATE-001 needs.

**Blocking FIN-REFUND-001**

10. **FIN-RELATION-001 has merged.**
11. Owner confirmation of the caps: `MAX_CANDIDATE_PURCHASES = 12`,
    `MAX_COMBINATION_SIZE = 4`, `MAX_COMBINATIONS = 5`, the 180-day/+5-day window, the −0.2
    different-account penalty.
12. Owner confirmation that **no score auto-confirms** and that **provisional dispute credits
    never reduce final personal spending**.
13. Ownership of `src/lib/budgets.ts` confirmed, or test M18 explicitly deferred with its
    reason recorded.

**Blocking FIN-DUPLICATE-001**

14. **FIN-RELATION-001 has merged.**
15. The one-token `export` on `src/lib/flows.ts:360` is agreed and its owner for the release
    window is known.
16. Owner confirmation of the **evidence thresholds** (≥2 charges per account, ≥2 overlapping
    billing periods, the anchor-series requirement, both series active).
17. Owner confirmation of the **tolerance policy** (±15% or ±$3.00 band; ≤40% cumulative /
    ≤25% single-step price drift; currency never converted).
18. Owner confirmation of the **"cheaper side" avoidable-cost rule** and the mandatory
    "potential annual duplicate cost" label.
19. Owner confirmation that **no duplicate decision changes a total**, in particular that
    "different person" leaves the expense fully counted.

**Blocking FIN-RECOVERY-UI-001**

20. **FIN-RELATION-001, FIN-REFUND-001 and FIN-DUPLICATE-001 have merged.** (Without
    FIN-DUPLICATE-001 the tab ships refunds-only and the duplicate card follows — the shell is
    never forked.)
21. **The shell question is settled** — whether FIN-REVIEW-002 or FIN-RECOVERY-UI-001 builds
    the queue shell (§8). Two shells is the failure this is written to prevent.
22. **The UX-IA tab decision is confirmed**, and badge placement in the app shell is assigned.
23. Owner confirmation of the **card copy**: "not income until you say what it is", the
    "potential annual duplicate cost" disclaimer, and "confirming this does not change any
    total".

**Blocking every task**

24. **The tests are written first and are red** — 178 of them.
25. **A worktree exists** per implementation branch, isolated from the owner's integration
    working directory and from every other agent's worktree.
