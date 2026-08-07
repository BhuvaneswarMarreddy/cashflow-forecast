# Design: the instructions layer (issue #8)

Three independent designs were proposed and each attacked twice — once by a reviewer
hunting for how it produces a **wrong number**, once by a reviewer judging only the
owner's **simplicity** rule. Scores landed at 5.0–6.0 across the board, which is the
useful result: no design was safe as written, and the critics converged on the same
three blockers in *existing* code.

---

## Decision

**An instruction is a shape-based predicate. The owner's sentence is stored beside it
and displayed, never executed.**

The natural-language design was rejected on accuracy by its own reviewer, and the
reason generalises: two model passes over one ledger can differ, and *"no screen may
disagree with another"* forbids a non-deterministic read path. The hybrid's seam is
correct but describes the same thing with more machinery.

So the seam sits at **write time**: the model compiles a sentence into a predicate,
the owner confirms it, and from then on **no model token participates in classifying
anything**. Words are re-read only when a row escapes every predicate, and the result
of re-reading is always a new predicate — never a number.

### Why this is smaller than it looks

The predicate system already exists and is used on every read: `RuleMatch`
(field/op/value + direction + accountId + onOrAfter), `applyMappingRules`,
`rulePreview`, `describeRule`, `buildGroupRule`, and a closed parser that already
drafts a rule from a sentence. `buildGroupRule()` already emits exactly the
*"money I send Ramesh"* shape.

What is missing is one thing: **a rule cannot state a meaning.**
`ruleSetForMeaning()` returns `null` for 9 of 11 inflow answers, so *"these Zelle
payments are my chit fund"* can only become N per-row review documents — a snapshot
of eight rows, not a standing answer. **That single `null` is why next March re-asks.**

### The shape

Two optional fields on the existing `MappingRule`; no new collection, no migration:

```ts
meaning?: FinancialMeaning;  // the owner's ANSWER for every row this matches
note?: string;               // the owner's own sentence — DISPLAYED, never executed
```

`firestore.rules` uses `hasAll`, not `hasOnly`, so both fields pass with zero rules
changes.

**Three collections stay three collections**, because each is already the right shape:
`reviews` is the degenerate predicate `id == txnId` (a one-row fact is honestly a
one-row document); `income` is an alias predicate whose answer is fixed at
`earned_income` and which carries forecast facts a rule has nowhere to put;
`rules` becomes the general predicate that can now carry an answer. The screen unions
them; the storage does not merge them.

**`earned_income` is refused as an instruction meaning** — "my paycheck is from
Canton" routes to the existing income-source action, keeping `users/{uid}/income` the
single authority and the amount/cadence derived from real deposits.

### Evaluation

Instructions resolve **once, at the context boundary**, into
`Record<txnId, MappingRule>` on `IncomeContext` — mirroring how `reviews` already
works. Passing the rule *list* instead would make every total O(rows × rules) at 74
call sites. Precedence, four rungs:

1. provider `type` — an instruction changes what a row **means**, never what it **is**
2. a confirmed row review — "this one row is different" always beats a pattern
3. the first enabled instruction whose predicate matches
4. approved income source, then the derived ladder

Among instructions, **newest wins** — the ordering `applyMappingRules` already uses,
explainable in six words, and how a person actually corrects themselves.

---

## The three blockers (fix before any of the above ships)

All six critics found these independently, in current code.

### 1. The confirmation card would say "matches 0 transactions" — for exactly the new kind

`rulePreview()` filters on `ruleMatches(rule, t) && wouldChange(t, rule.set)`, and
`wouldChange` compares `set` fields. A meaning-only instruction has an **empty `set`**,
so it "changes" nothing and previews as zero.

That is the *only* gate protecting rule #1, and it would be blind precisely when it
matters. **Fix first:** teach the preview to count meaning changes, and make the
count come from the same resolution the screen uses so two screens can never disagree
about one instruction.

### 2. The flagship case would still re-ask

Counterparty groups reach the review queue from the flow graph's node ids
(`counterpartyRowIds`), not from rules. So even with a standing instruction saved,
the chit-fund group re-appears — the exact bug this feature exists to kill.
**The queue must consult instructions before asking.**

### 3. The write path silently drops the new fields

`TransactionContext.addRule` does not persist the rule object; it writes a hand-built
whitelist (`{ match, set, createdAt, enabled }`). `meaning` and `note` would vanish on
save, and today's total would differ from tomorrow's after a refresh — with no user
action. **Add both to the whitelist, and a test that saves and reloads.**

---

## Also worth keeping (from the designs that lost)

- **Default to the compounding scope.** "Answer once" should be what happens when the
  owner does nothing, not something he opts into on every answer.
- **The note is his own chat message, taken client-side** — never the model's
  paraphrase. The cheapest guarantee that the record of what he said cannot be quietly
  reworded by the thing that compiled it.
- **Two distinguishable reason strings** — *"you told me"* vs *"I suggested this and
  you confirmed"* — with a test that an instruction-derived confirmation never renders
  as the latter.
- **Honest refusal:** *"I could not turn that into a standing answer — this covers
  these 6 rows only."* Do not extend the predicate language until the same shape has
  been refused twice.
- **Group answers become ONE instruction instead of N review documents** for any scope
  broader than "only this group". That is a deletion, and it is the mechanism that
  makes an answer apply to rows that do not exist yet.

## What the predicate deliberately cannot express

One field, one operator, no OR/AND/NOT, no amount conditions, no closing date, no
cadence, nothing relating two rows (that stays `TransactionLink`), and nothing outside
the row's text ("the ones for the trip"). These are **refused, not half-honoured** —
refusing is what keeps a wrong number from being invented.

---

## Sequence

1. Fix blocker 3 (write path) — smallest, and everything else depends on it
2. Fix blocker 1 (preview counts meaning) — the safety gate
3. Add `meaning` + `note`, and the `interpretTransaction` branch
4. Fix blocker 2 (queue consults instructions) — the case that proves the feature
5. Group answers write one instruction instead of N reviews
6. The visible-memory screen, then traceability strings
