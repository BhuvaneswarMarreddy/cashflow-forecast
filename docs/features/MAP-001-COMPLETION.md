# MAP-001 — Map the Unmapped · completion

Branch `feat/map-001-map-the-unmapped`, worktree `../cashflow-forecast-map-001`, from
baseline `40b24c8`.

## The number this task exists to produce

Measured on the owner's real export, read-only, 2026-08-02. No merchant, amount,
description or account identifier from that export appears in this document, in the
committed fixtures, or in any emitted event.

| | rows | groups | decisions for 80% of ROWS | decisions for 80% of MONEY |
|---|---|---|---|---|
| Unknown inflows | 229 | **50** | 29 (16 if ordered by row count) | **8** |
| Unpaired legs (the ledger's 103) | 103 | **30** | 13 | 7 |
| Both | 332 | **80** | 40 | 14 |

The queue used to be 332 questions. It is now 80, and the first eight answers settle 80%
of the money.

Two notes on the figures:

- The ledger records **205** unknown inflows from the live app. This replay produces
  **229**, because the replay has no approved income sources configured — the owner's real
  profile explains 24 of them. The grouping ratio is what matters and it is the same.
- **103 is reproduced exactly** (38 `self-ext-in` / 17 `self-ext-out` / 22 `cardpay-in` /
  26 `cardpay-out`). The ledger's 103 counts rows in the four `flow-lanes.ts` stub lanes,
  not raw `matchTransfers()` output — that returns 352, because person-to-person legs go
  to named counterparty nodes instead. The module reads the stub lanes, so it groups the
  same 103 rows the owner sees.

The shipped ranking is `rowCount × |totalCents|`, as specified. The row-count-only figure
is reported above because the difference is real and the owner should not be told 29 when
16 was available; the money figure is why the impact order was kept.

## The cross-reference §8 asked for

**Are the unknown deposits the missing counterparts of the unpaired legs? Mostly not.**
Matching each unknown inflow to an unpaired OUT leg of the same amount in a *different*
account: **10** on the same day, 12 within a week, 14 within a month, 28 at any date.
So **4–6% overlap**. This confirms §2's finding from the other side and is a further
argument against widening the pairing window. `transfers.ts` was read and not modified.

What it does justify: the same-day case is real evidence, so it became one of the four
suggestion sources. On the real export it fires for **17 of the 80 groups**, 12 of them
leg groups. It suggests; it never pairs.

## How grouping works

`buildMappingGroups()` in `src/lib/mapping-suggestions.ts`. One key per group:

    `${kind}~${signal}:${value}~${direction}`

- **signal** — a named external counterparty (`personFrom()`, `isSelfPerson()` excluded)
  when the row has one, otherwise the normalized merchant (`normalizeMerchant()`).
  Counterparty wins because a Zelle-shaped row's meaning lives in the person, not the
  transport — FIN-REVIEW-002 §7.3's worked rejection. Measured cost of the split: 7 rows,
  43 merchant groups → 50. Measured cost of *not* splitting: money to family and money
  from a friend answered as one thing.
- **direction** — from `rowDirection()`, so an inbound and an outbound leg of the same
  merchant are never one question.
- **kind** — `unknown_inflow` (from `selectInflowReviewQueue()`) or `unpaired_leg` (from
  the four `unpairedLegLane()` stub ids, asked of the module that owns them rather than
  copied).

Everything else — account set, source categories, amount range, cadence, date span — is
carried on the group and shown, not folded into the key. Adding them to the key was
measured and rejected: `+sourceCategory` took 50 groups to 66, `+account` to 72,
`+amount band` to 85, for information the owner can already see on the card.

Cadence is computed off `flows.ts`'s existing `BANDS` table and its 0.6 in-band rule.
`detectRecurring()` itself could not be reused: it only looks at expenses.

Ranking is `rowCount × |totalCents|`, tie-broken by row count then key — fully
deterministic.

## How suggestions stay derived

Four evidence kinds, tried in confidence order, and `null` is a normal answer:

1. `existing_rule` — an enabled `MappingRule` of the owner's already matches these rows.
2. `prior_confirmation` — the owner has confirmed a meaning for other rows with the same
   group key. The `why` states the count: *"You have already answered X the same way 4
   times"*.
3. `approved_income_source` — the group's median amount is within tolerance of an approved
   `IncomeSource` and the cadence agrees. Amount can only narrow, never create.
4. `same_day_opposite_leg` — the same amount going the other way in another owned account
   on the same day.

**The test that proves it is not a list**: `mapping-suggestions.test.ts` reads the module's
own source and asserts the absence of 24 vendor literals plus
`KNOWN_MERCHANTS|VENDOR_LIST|MERCHANT_REGISTRY|MERCHANT_CATALOGUE|SEED_MERCHANTS`, and that
no `category:` is assigned from a string literal anywhere in the file. This is the same
discipline `duplicate-subscriptions.test.ts` applies to `service-identity.ts`.

Confidence is a fixed ladder (0.6 / 0.7 / 0.9). `why` is one sentence naming a fact the
owner can go and check. No model output touches any of it.

## "Leave it unknown", made terminal

`markGroupUnknown()` returns one `InflowReview` per row: `state: 'dismissed'`,
`reasons: ['group_marked_unknown']`, `source: 'user'`. That is the **existing** decision
record at `users/{uid}/reviews/{transactionId}` — no second store was created.

`dismissed` was already terminal for the row (`selectInflowReviewQueue` drops it,
`queueStateOfReview` returns `null`). The added reason code is what makes it terminal for
the **pattern**: `buildMappingGroups()` suppresses any group key for which *any* ledger row
carries that marker, so a matching row imported next month does not re-open a closed
question. Tested directly — dismiss five rows, add two more of the same pattern, re-run,
the group does not come back.

Unpaired legs use the same record. `classify.ts`'s guard stops a review turning a transfer
into income, but it does not stop the record existing, and this module reads the state
itself.

## The `mapping-rules.ts` extension — what and why

**Three optional fields on `MappingRule.match`:** `direction?: 'inflow' | 'outflow'`,
`accountId?: string`, `onOrAfter?: string`. Plus one exported pure helper, `rowDirection()`,
which reads `transferDirection` then `type` — no `accounts`, no `classify` import, so the
module stays the pure leaf it was.

**Why it could not be expressed otherwise.** Measured on the real export: a
`merchant contains ⟨normalized⟩` rule generated from an unknown-inflow group reached
**1,104 extra rows across 29 of the 43 merchant groups, 604 of them OUTFLOWS to the same
merchant**. Without `direction`, the only honest scope for an inflow group was "these rows
only" — i.e. no persistent learning at all, which is the point of part D. `accountId` and
`onOrAfter` are the same shape and are required by the brief's scope list
(`merchant + account`, `future rows only`).

**Backward compatibility.** Absent means what it always meant: any direction, any account,
any date. `applyMappingRules()` keeps its signature; each qualifier only ever *narrows*,
and only after the existing field/op test has already passed. `TransactionContext.addRule`
writes `match` wholesale, so the new fields persist with no migration. Four tests pin the
old behaviour: a legacy rule still matches every row it used to across all three row types,
precedence is still "first enabled matching rule wins" in both orders, a disabled rule is
still ignored, an empty needle still matches nothing. `describeRule()` now says the
qualifiers out loud — a silent narrowing is as misleading as a silent widening.

**What was NOT added**: `merchant_and_amount_range`, `same_shared_expense_group`,
`selected_historical_and_future` from §7.1. No group in the data needed them.

## What a confirmation can and cannot persist

`ruleSetForMeaning()` returns `{type: 'transfer'}` for *money between my own accounts* and
*a payment to one of my cards*, and **`null` for everything else**. The engine sets
`category | sourceCategory | type | merchant`; a meaning like "someone paying me back" has
no rule form. When it is `null` the card says so in words — *"A saved rule can only change
a row's category or mark it a transfer, so this answer is recorded on these N rows and no
rule is created"* — and the scope collapses to `only_this_group`. Returning `null` rather
than inventing a category is the discipline of the whole file.

`set.type: 'transfer'` is the one `set.type` value that survives, because
`classifyTransaction()` never re-derives a stored transfer — the ceiling already documented
in `mapping-rules.ts`.

## What the owner sees

`/flow?tab=review` gains a **Patterns to map** section and a header line: *"332 unmapped
rows in 80 patterns · answer 14 to clear 80%"*. Each card shows, before Confirm is
enabled:

- the pattern's name, row count, total, direction, date span, per-row amount range,
  cadence, accounts, and the export's own category words;
- the suggestion, if the ledger has one, with its one-sentence reason and a **Use this**
  button — never pre-selected;
- the answer (a closed list of nine meanings) and the scope (only the scopes that group can
  actually express);
- a live preview computed **from the generated rule**, not from the group: what changes in
  `describeRule()` English, how many transactions, the date range, whether future rows are
  included, and the budget / forecast / Flow effects;
- for a broad rule (§7.3: 25 rows or 10% of the ledger, whichever is smaller) an extra
  explicit acknowledgement that blocks the one-click path;
- **I can't classify these — stop asking**, always available.

`buildReviewQueue()` drops a row's individual item when a group covers it, so the queue
does not double. With no `groups` in the context it behaves exactly as before — tested.

## Observability

`Mapping.GroupsBuilt` (group count, row count, decisions-for-80%, counts by kind, how many
carry a suggestion, silenced key count), `Mapping.GroupConfirmed`, `Mapping.MarkedUnknown`
(kind, scope, evidence id, confidence, row count, duration), `Mapping.RuleCreated` (scope,
whether a direction was set). Counts, ids and enum values only — no merchant, no
counterparty, no amount, no transaction id, no account.

## Verification — observed output

| Command | Result |
|---|---|
| `npx tsc --noEmit` | clean, no output |
| `npx jest` (no CSV) | 55 passed, 1 skipped · **912 passed, 7 skipped, 919 total** |
| `npx jest` (with CSV symlink) | **56 suites, 919 passed, 919 total** |
| conservation | `✓ ties the closing total to net worth −$3,641.38` — **unchanged** |
| `npm run build` | passes, all 18 routes |
| `npm test --prefix functions` | 3 suites, **26/26** |
| `npx eslint src` | **149 problems** (53 errors, 96 warnings) — identical to baseline |
| react-hooks/rules-of-hooks + set-state-in-effect | **0** |
| `functions-sync` unittest discover | **62 tests, OK** |

Baseline was 881 tests / 149 eslint / 0 react-hooks. **+38 tests** (29 module, 9 card and
queue). No existing test's expectation was rewritten; no existing test file was edited.

## Deviations

- **Groups are ranked by `rowCount × amount` as specified**, which needs 29 inflow
  decisions to clear 80% of the rows where a row-count ranking needs 16. Kept the specified
  formula, and reported both numbers rather than quoting the flattering one.
- **Vague-category spending rows are not grouped.** Measured: 55 rows, 52 spending, 23
  merchant groups. They are not in the review queue today and pulling them in is a scope
  and a UI question, not a grouping one. Recorded in the ledger's new §9.
- **`Tags` was confirmed present and deliberately not wired up** — 2 rows of 2,913.
- Rules still have no management surface. Out of scope and recorded.
