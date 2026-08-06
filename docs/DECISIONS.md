# Architecture decisions

Each entry is a decision that could reasonably have gone the other way, the reason it went this way, and — where one exists — the measured defect that settled it. Written so a future reader knows what breaks if they "simplify" it.

The house rule behind most of them: **an app that reports money must never guess, and must never disagree with itself.**

---

## 1. Classification is derived on read; nothing computed is ever stored

**Alternative:** write a `category` / `meaning` field onto each transaction at import time, as most finance apps do.

**Why not:** stored classifications rot. The moment the rules improve, two years of history carries the old answer, and fixing it becomes a migration with no rollback. Worse, an importer's guess becomes indistinguishable from the owner's decision.

**Instead:** provider fields are immutable; the owner's decisions live beside the row in `users/{uid}/reviews/{txnId}`. Classification is recomputed on read from `(row, approved sources, reviews)`.

**Cost accepted:** every screen pays CPU per render, and totals must never be cached carelessly. Worth it — improving a rule re-classifies all history for free, and a test asserts rows are byte-identical before and after classification runs.

---

## 2. One interpretation function, one income total, one spending total

**The defect:** Flow, Analytics, Cashflow and History called the classifier while Calendar, Dashboard, Budgets, Reminders and Export read the stored `type`. A credit-card payment was a transfer on one screen and **both income and expense** on another.

**Decision:** `interpretTransaction()` is the only interpretation, and `sumIncomeCents()` / `sumExpenseCents()` are the only totals. Each returns an explicit `counted | excluded` treatment per total — *omission is never accidental*.

**Enforcement:** a cross-surface test asserts the same fixture produces identical figures on every surface, including the exported workbook.

---

## 3. A deposit is income only when the owner has said so

**Alternative:** infer income — large, recurring, matches payday, provider tagged it "Paychecks".

**Why not:** every one of those heuristics is wrong often enough to be dangerous. A one-off Zelle from a friend, a tax refund, a loan disbursement and a chit-fund payout all look like income to a heuristic, and each one inflates the figure a person makes decisions on.

**Decision:** earned income requires a match against an approved source in `users/{uid}/income`, or an explicit confirmation. Ambiguity (two sources match) resolves to unknown, not to a guess. Everything unmatched is an `unknown_inflow` — **real money on the balance, zero in every income total** — and lands in a review queue that asks.

**Measured:** applying this rule changed the authoritative income total by removing a $15.00 refund and an $88.00 unexplained credit that had counted as income *merely because they were positive*.

**Cost accepted:** a new user sees `$0` income until they name their payer. That is honest, and the chat makes it one sentence to fix.

---

## 4. Evidence for an income match is deliberately narrow

**Decision:** a match requires the source's alias to appear in the row's **own text** (title / merchant / description). The provider's category is excluded from the haystack — *an importer's "Paychecks" label is a suggestion and must never decide*. Amount is **supporting only**: a tolerance can reject a name match, but no amount ever creates one. Size, cadence, sender and payday proximity are not evidence at all.

Aliases under 3 characters are rejected, because a 1–2 character alias matches nearly every statement line and would turn one sloppy source into *"everything is my salary"*.

---

## 5. A transfer means the owner's own accounts — nothing else

**The defect (twice, in one evening):**
1. Bank rows arrived with no transfer notion at all → every card payment counted as spending *plus* the purchases it settled. Two years read **$357,639.72**.
2. The first fix trusted the provider's broad `TRANSFER_IN` / `TRANSFER_OUT` categories — which that provider also applies to payroll ACH, Zelle to a person, remittances and ATM cash. **18 of 36 paychecks** stopped counting as income, and mistyped inflows silently bypassed the review queue.

**Decision:** match on the provider's **detailed** category, whitelisted to values that actually name an own-account move (`*_ACCOUNT_TRANSFER`, `*_SAVINGS`, `*_INVESTMENT_AND_RETIREMENT_FUNDS`) plus the credit-card settlement. Everything else stays income/expense and the engine decides.

**Principle extracted:** when a provider's taxonomy is broader than your concept, do not adopt their word — adopt the narrowest value that means what you mean.

---

## 6. Ingest never guesses which account a row belongs to

**Decision:** match by last-4 first (survives renames), then name-contains. If two provider accounts claim one app account, **all** claimants are demoted to unmatched and reported — never resolved by picking one.

**Why:** a wrong account attribution is invisible. The balance still reconciles, the row still appears; it is simply attributed to the wrong card, forever.

**Exception, deliberately:** Plaid *creates* an unmatched account rather than skipping it, because the owner personally authorised that exact account seconds earlier in Plaid Link. That is a consent record, not a guess. Batch sources keep the strict rule.

---

## 7. The same charge from two sources enriches; it never duplicates

**Decision:** content fingerprint — account + signed cents, ±3 days, strictly **one-to-one** with the winner removed from the candidate pool. Import ids are bijective and content-keyed (not hashed), so re-importing a cumulative export overwrites rather than duplicating, with zero collision probability.

**Enrichment precedence is source-aware:** only the richest source may replace a populated field; others may fill blanks only, and a hand-edited field is never touched by any source.

**Measured:** when a second live source became redundant, 310 of its 310 rows duplicated the primary source and none was unique — **$122,194.67 of phantom money**. The dedupe caught most of it; the residue is why that source was retired rather than kept "just in case".

---

## 8. Balance anchoring is dated to the balance, not to today

**The defect:** a balance that was 71 hours stale got stamped with today's date, so every withdrawal in between was counted twice — one account went **$2,000 wrong**.

**Decision:** `anchor_when()` dates the anchor to the day after the balance's *own* timestamp. Staleness stopped being a rejection reason, because a stale balance is *true as of its own date*. Anchors never move backwards, a manual or disconnected account can never overwrite a good anchor, and the first run seeds only.

---

## 9. The model proposes; the application writes

**Decision:** LLM output passes through a **closed parser** into a fixed action set, becomes a confirmation card, and is applied only by a button press. There is no path from a model token to a Firestore write.

Specifically:
- **Account names never come from the model** — the proposal names an account, the client resolves it against the real list, and anything ambiguous renders no button at all.
- **Figures never come from the model.** For an income source, amount and cadence are derived from the deposits that actually match: median amount, median gap between deposits. A model guessing "monthly" where the truth is biweekly overstates income by 2.17×.
- **Rejected, never repaired.** Out-of-range values are refused, not clamped or truncated — a clamped number is a wrong number wearing a valid costume.
- The callable's own return value is treated as untrusted input and validated client-side; prototype-pollution keys are checked before any key is read.

**Cost accepted:** the assistant cannot "just do it". That is the feature.

---

## 10. Integer cents everywhere; dollars only at the render layer

Floating-point dollars accumulate error over thousands of rows and produce totals that disagree by pennies across surfaces — which, in a money app, destroys trust faster than a missing feature. Money is integer cents through parsing, classification, the graph and the totals; formatting to dollars happens once, at the edge, through one formatter that carries the owner's currency and two decimals.

---

## 11. Firestore rules ship by human hand

**Decision:** CI deploys functions and hosting on every green push, and deliberately **does not** deploy `firestore.rules`.

**Why:** a bad ruleset locks the owner out of their own financial data, and the rollback is a console visit under stress, not a `git revert`. The 180-test emulator suite runs in CI so drift is caught; publishing stays a deliberate act.

**Related:** that suite was written after discovering the rules file had never been executed by any test — and that the live rules were an older revision than the repository's.

---

## 12. A failed scheduled sync must fail loudly

**The defect:** a sync recorded its error to a status document and returned normally, so the platform showed a green streak while the job had been broken for days. Nobody was told.

**Decision:** scheduled syncs re-raise after recording, so a failure is a failed invocation that alerting can see. Swallowing an error to keep a dashboard green is how silent data loss survives.

---

## 13. Provider HTTP uses the standard library, with the transport injected

Two or three calls per provider do not justify a dependency, and an injected transport means the entire ingest suite runs with **no network** — which is why 87 Python tests execute in under a tenth of a second and can assert on exact request bodies.

---

*Every decision here is reversible; several already were. What is not negotiable is that a number shown to a person must be traceable to the rows that produced it.*
