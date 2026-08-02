# FIN-RELATION-001 — Completion report

**Status:** Implemented, tested, ready to merge. Not pushed, not merged, not deployed.

**Baseline commit:** `732d51d` (tag `INTEGRATION_BASELINE_AFTER_INCOME`) on
`feat/transfer-type-monarch-ingest`. `main` is stale and was never used.

**Branch:** `feat/fin-relation-001-transaction-links`

**Worktree:** `../cashflow-forecast-fin-relation-001` — created with
`git worktree add -b feat/fin-relation-001-transaction-links ../cashflow-forecast-fin-relation-001 732d51d`.
No file in the integration directory or in any other worktree was modified.

**Final commit:** see `git log -1` on the branch. Commits, in order:

| Commit | Subject |
|---|---|
| `e1137c6` | test(relation): failing tests for links, candidates, rules and the action parser |
| `1369850` | feat(relation): transaction link + allocation model |
| `95476b1` | feat(relation): deterministic review-candidate identity |
| `32c8755` | feat(relation): firestore rules for links, candidates and service families |
| `300e77d` | feat(relation): thirteen structured review actions |
| (this file) | docs(relation): completion report |

---

## 1. Files changed

**New, owned exclusively by FIN-RELATION-001**

| File | What |
|---|---|
| `src/lib/relations.ts` | link model, id builders, status machine, allocation totals, the V1–V11 validator |
| `src/lib/candidates.ts` | candidate model, two-part identity, suppression, ranking, evidence sanitiser |
| `src/lib/relations-store.ts` | Firestore access for both collections |
| `src/__tests__/relations.test.ts` | R1–R16 |
| `src/__tests__/candidates.test.ts` | C1–C8 |
| `src/__tests__/relations-rules.test.ts` | F1–F8 (see §7 for what actually runs) |
| `src/__tests__/recovery-actions.test.ts` | P1–P13 |

**Existing, owned exclusively by FIN-RELATION-001 for this programme**

| File | Change |
|---|---|
| `src/lib/chat-actions.ts` | `ChatAction` union extended with the thirteen recovery actions; `RecoveryContext`; `explanationOf()`. No second parser, no schema library. |
| `functions/src/prompts.ts` | `RECOVERY_ACTIONS_PROMPT`, appended once in `buildChatMessages()`. One allowed-action list. |
| `firestore.rules` | `links`, `reviewCandidates` and `serviceFamilies` blocks. |

**Existing, touched incidentally — two lines, no behaviour change**

| File | Change | Why |
|---|---|---|
| `src/components/DataChatSheet.tsx` | `explanationOf(reply)` instead of `reply?.explanation` | the widened `ChatAction` union has members with no `explanation`; this is the type narrowing that keeps the build green. Recovery actions have no card here yet — FIN-RECOVERY-UI-001 owns that surface. |
| `src/__tests__/chat-actions.test.ts` | two `parsed?.explanation` reads became `explanationOf(parsed)` | same narrowing. **Every expected value is unchanged**; nothing was relaxed to make new code pass. |

**Never written** (upstream-owned, read only): `src/types/index.ts`, `src/lib/classify.ts`,
`src/lib/forecast.ts`, `src/lib/firestore.ts`, `src/context/UserProfileContext.tsx`,
`src/lib/flows.ts`, `src/app/flow/page.tsx`, `.github/`, `scripts/`, package `scripts`.

---

## 2. Business rules

1. **A link is a statement about rows, never a copy of them.** No merchant, description,
   dollar amount, or provider payload appears on a link or a candidate.
2. **Raw transactions are never modified.** FIN-RELATION-001 writes zero fields on
   `users/{uid}/transactions/{id}`. Provider description, provider category, provider
   amount, provider transaction id and original posted date are unreachable from this
   code. Test R14 asserts the transaction documents are byte-identical across
   create → confirm → supersede → reject.
3. **Nothing applies before confirmation.** Only `confirmed` links enter any total; a
   `suggested` link is arithmetically invisible (R16). The parser returns a proposal and
   never a mutation (P13).
4. **Nothing is ever silently clamped.** An over-allocation is rejected with a stated
   rule id, or stored under an explicit named conflict state that surfaces for review.
5. **A decision is permanent.** Terminal candidate statuses are never rewritten, never
   re-scored, never re-ranked — including across an algorithm version bump.
6. **No delete path exists.** Not in the store, not in the parser, not in the rules.
7. **The system confirms exactly one link type.** `card_payment_pair` may be written
   `confirmed` by the system, because the deterministic pairer already computes it.
   Everything else requires `confirmedBy: 'user'`. There is no confidence threshold at
   which the system confirms a refund, a duplicate or a chargeback.
8. **"For business" and "different person" are labels on the ALERT.** No tax category, no
   deductibility claim, and the expense stays fully counted.

## 3. Algorithms

**Link id** — `linkType~sourceTransactionId~targetTransactionId`. Composed, never hashed:
a hash buys nothing here and costs collision risk on money. Because the id is derived,
re-proposing the same relation is an upsert against one document, so idempotency is free
and there is no dedupe pass. The builder **throws** if either id contains `~` rather than
emitting an ambiguous id, and never falls back to a hash (R10).

**Symmetric-pair ordering** — `duplicate_candidate` and `subscription_overlap` are
symmetric relations forced into an ordered pair so the id is unique: the later-dated row
is the source; a same-date tie breaks on the lexicographically greater id. Both discovery
orders give the same answer (R7).

**Candidate identity** — see §5.

**Allocation totals** — `confirmedAllocatedFromSource` / `confirmedAllocatedAgainstTarget`
fold over `confirmed` links only. `linkIndex()` builds `Map<transactionId, links[]>` keyed
on both endpoints in one O(L) pass, so "is this row refunded?" is O(1) rather than a scan
per render.

**Suppression / version bump** — `mergeCandidateRun(generated, stored)`:

| Stored status | Outcome |
|---|---|
| `confirmed` / `dismissed` / `intentional` | **suppressed** — dropped from the run, document untouched |
| `unreviewed` | re-evaluated: the new version and score are written |
| `suggested` / `needs_more_information` | untouched, `algorithmVersion` included — still in the queue, never rewritten |
| not stored | written as new, `unreviewed` |

## 4. Algorithm version

FIN-RELATION-001 declares **no** version string of its own — it has no generator. It
enforces the rules for the four that FIN-REFUND-001 and FIN-DUPLICATE-001 own
(`refund-match-v1`, `combined-refund-v1`, `duplicate-charge-v1`,
`duplicate-subscription-v1`): a bump re-evaluates only `unreviewed` candidates, never
reinterprets a confirmed decision, never changes a stored `algorithmVersion`, and cannot
resurrect a dismissal. No version string is computed at runtime, read from config, or
derived from a date.

## 5. Data model

```
users/{uid}/links/{linkId}                     linkId = `${linkType}~${source}~${target}`
users/{uid}/reviewCandidates/{identityKey}     identityKey = `${candidateType}~${sortedIds}`
users/{uid}/serviceFamilies/{familyId}         (rules only; engine is FIN-DUPLICATE-001's)
```

**`TransactionLink`** — `id`, `linkType` (9), `sourceTransactionId`,
`targetTransactionId`, `allocatedAmountCents` (integer cents, > 0), `status` (5),
`algorithmVersion`, `candidateId?`, `confirmedAt?`, `confirmedBy?`,
`supersededByLinkId?`, `note?`, `createdAt`, `updatedAt`.

`source` is the row that ACTS; `target` is the row acted UPON.

**`internal_transfer_leg` is deliberately excluded.** `matchTransfers()` pairs both legs
live from the current transaction set and self-updates on re-import; `pairedLegId()`
already answers "what is the other leg". A stored link would be a staler second source of
truth for a fact the deterministic code recomputes for free. The reasoning is in a comment
on `LinkType`, and F5 asserts the rules list does not contain it either.

**`ReviewCandidate`** — `id` (= identityKey), `candidateId`, `candidateType` (8),
`algorithmVersion`, `transactionIds` (sorted, 2..13), `status` (6), `proposedLinks` (≤12),
`evidence`, `score`, `generatedAt`, `reviewedAt?`, `reviewedBy?`, `linkIds?`.

### The two-part identity, and the version trap

```
identityKey (doc id) = `${candidateType}~${sortedTransactionIds.join('~')}`     NO version
candidateId (field)  = `${candidateType}~${algorithmVersion}~${sortedIds}`      the audit trail
```

The original brief asked for an id derived from candidate type + sorted transaction ids
**+ algorithm version**, "so a dismissed candidate cannot resurface". Read as one string
those clauses contradict each other: with the version in the document id, bumping
`refund-match-v1` → `v2` mints a **new** id, the dismissal stays attached to the old one,
and every dismissed candidate resurfaces on the next release — the exact failure the
requirement exists to prevent.

So the decision attaches to *the relationship between these rows*, which is what the owner
actually decided about, and the version lives in a field for audit. **Test C4** is the
proof: it dismisses a candidate at `v1`, regenerates it at `v2`, asserts the `candidateId`
changed and the `identityKey` did not, and asserts `mergeCandidateRun` returns zero writes
and one suppression.

## 6. Privacy controls

- Candidate `evidence` is structured and text-free: amounts, day gaps, booleans, account
  **types**, enums and reason codes. `sanitizeEvidence()` strips anything else at the
  store boundary, so a generator that spreads a working object cannot leak merchant text
  into the collection. C8 asserts this against a fixture carrying hostile values in
  `merchant`, `title`, `description`, `accountName`, `lastFourDigits`,
  `serviceFamilyLabel` and `aliases`.
- Telemetry reuses OBS-001 only — `emit()` / `startSpan()`, one `DiagEvent` shape, one
  redactor, off in production by default. No second telemetry system, no `console.log` of
  a financial payload.
- Events emitted: `Relation.LinkConfirmed`, `Relation.LinkSuperseded`,
  `Relation.LinkRejected`, `Relation.ValidationRejected` (reason **code** only, never the
  payload), and the span `Relation.ConfirmCandidate`. Properties are limited to link type,
  candidate type, algorithm version, status, allocation count, record count, rule id,
  duration and result status.
- Never logged: descriptions, merchant strings, titles, account names, `lastFourDigits`,
  amounts as free values, provider payloads, credentials, tokens, the AI context, the
  owner's message, or the model's reply.
- No test reads production, signs in, triggers a sync, or writes to a live collection.
  Every fixture is invented.

## 7. Tests

`npx jest` — **675 total (668 passed, 7 skipped) across 40 suites**, up from the
baseline's **545 (538 passed, 7 skipped) across 36 suites**. The 130 new tests are the
45 specified cases; the count is higher because `it.each` tables expand (R6, R9, R15, C5,
F4, P1, P7, P11, P12).

The pre-existing 545 were re-run in isolation and are **unchanged**: 36 suites, 538
passed, 7 skipped. No existing expectation was rewritten to make new code green — the only
edit to an existing test file was two type narrowings with identical expected values.

| Suite | Spec | Result |
|---|---|---|
| `relations.test.ts` | R1–R16 | 51 passed |
| `candidates.test.ts` | C1–C8 | 18 passed |
| `relations-rules.test.ts` | F1–F8 | 25 passed (see below) |
| `recovery-actions.test.ts` | P1–P13 | 36 passed |

### Which Firestore rules tests actually ran — and which did not

**RAN, and are real controls:**

- The deployed `firestore.rules` text is parsed with a brace matcher and each required
  constraint asserted **inside the correct block**: every `allow` conjoined with
  `isOwner(userId)`, the required-field lists, `is int` + `> 0` on create *and* update,
  the self-link inequality, the immutable-field re-assertions on update,
  `allow delete: if false`, the 2..13 `transactionIds` cap, and the catch-all deny.
- The closed value sets in the rules are asserted **equal to the TypeScript constants**
  (`LINK_TYPES`, `LINK_STATUSES`, `CANDIDATE_TYPES`, `CANDIDATE_STATUSES`). This is the
  assertion that catches the regression that actually happens: a link type added to the
  model and forgotten in the rules.
- The client-side half of every invariant, against the same pure validator the store runs.

**UNRUN — blocked:** the rules **engine** evaluating an actual request. Nothing here
proves the deployed rules deny a second user's read, an unauthenticated write, or a float
allocation *at the database*. That is F1, F2, F3 and the database half of F5–F8.

**Why:** `@firebase/rules-unit-testing` is not installed, `firebase.json` configures no
emulator, and production is also the development environment. The task brief forbids
installing an emulator and forbids pointing any test at production, so the honest outcome
is to write the rules, test what can be tested offline, and record this.

**To unblock** (owner's call, one-time):

```
npm i -D @firebase/rules-unit-testing
# add an "emulators": { "firestore": { "port": 8080 } } block to firebase.json
firebase emulators:exec --only firestore "npx jest src/__tests__/relations-rules.test.ts"
```

Until that exists, the rules block is a **reviewed** trust boundary, not a **proven** one.

## 8. Build result

| Command | Observed |
|---|---|
| `npx tsc --noEmit` | clean, exit 0 |
| `npx jest` | 40 suites (1 skipped), 675 tests: 668 passed, 7 skipped |
| `npm run build` | `✓ Compiled successfully in 3.6s`, 19/19 static pages generated |
| `npm test --prefix functions` | 3 suites, **26/26 passed** |
| `python -m unittest discover -s functions-sync` | **Ran 62 tests … OK** |

react-hooks lint: unchanged — this task adds no React code.

The Python interpreter came from the integration directory's gitignored venv
(`../cashflow-forecast/functions-sync/venv/bin/python`) run **read-only** against this
worktree's sources; no file in the integration directory was modified. `pytest` is not
installed locally, hence the `unittest` form.

## 9. Known limitations

1. **The rules-engine tests are unrun** (§7). The single most important follow-up.
2. **Partner re-attach by fingerprint (§3.7) is not implemented.** The link model does not
   delete a link whose partner vanishes, and the rules have no delete path, so no data can
   be lost — but the `link_partner_missing` surfacing and the one fingerprint re-attach
   belong to a consumer with a live transaction set. Recorded for FIN-RECOVERY-UI-001.
   `Relation.PartnerMissing` is specified and not yet emitted by anything.
3. **V4/V5 in the parser see only transaction amounts, not stored links.** `RecoveryContext`
   carries candidates and rows, not the link collection, so a parsed proposal is checked
   against the credit and the purchase but not against allocations confirmed earlier. The
   store re-validates with the real link set before any write, which is the authoritative
   check; the parser's job is to refuse an obviously impossible proposal early.
4. **`score` is not computed here.** Each generator publishes its own explainable ladder;
   FIN-RELATION-001 only requires purity, determinism and a stable tie-break.
5. **Multi-currency is out of scope.** V10 rejects a cross-currency link as unvalidatable.
   `Transaction` carries no currency field today, so `TxRef.currency` is optional and V10
   is inert on real rows — it becomes live the moment a currency lands on the row.
6. **No UI.** No `/flow` change, no review queue, no confirmation card. By design.
7. **`src/types/index.ts` still declares the old stub `TransactionLink`** (the
   FIN-SETTLEMENT-003 interface-only placeholder). It is unreferenced by any code. This
   task may not write that file; whoever owns it next should delete the stub so there is
   one link type in the codebase.

## 10. Manual verification

None performed, and none is possible without production data or a signed-in session, both
of which this task is forbidden to use. Every assertion in this report is either an
observed command output (§8) or a test (§7).

For the owner, after merge: the rules blocks are inert until something writes to
`users/{uid}/links` or `users/{uid}/reviewCandidates`, and nothing does yet. Deploying
this changes no displayed number.

## 11. Overlapping files

| File | Status |
|---|---|
| `src/lib/chat-actions.ts` | **closed.** All thirteen actions have landed. FIN-REFUND-001 and FIN-DUPLICATE-001 must add no parser code. |
| `functions/src/prompts.ts` | **closed.** One allowed-action list. |
| `firestore.rules` | **closed**, including the `serviceFamilies` block FIN-DUPLICATE-001 needs. |
| `src/lib/relations.ts` / `candidates.ts` / `relations-store.ts` | imported by everyone, written by FIN-RELATION-001 only. FIN-REVIEW-002 imports this model instead of stubbing a second one (its §8 "FIN-SETTLEMENT-003" is this task). |
| `src/components/DataChatSheet.tsx` | two-line narrowing only; unclaimed by any other task. |
| `src/__tests__/chat-actions.test.ts` | two-line narrowing only. |
| `src/lib/flows.ts`, `src/app/flow/page.tsx` | untouched. |

## 12. Merge recommendation

**Merge first**, as specified. The acceptance criterion for merging first is that a
foundation must move no number, and it moves none: no classification changed, no
`LedgerMeaning` added, no total recomputed, and
`src/__tests__/cross-surface-consistency.test.ts` passes byte-identically
(`EXPECTED_EXPENSE_CENTS = 22920`, `EXPECTED_INCOME_CENTS = 330300` unchanged).

FIN-REFUND-001 and FIN-DUPLICATE-001 can then run in parallel, importing:

- `src/lib/relations.ts` — `LinkType`, `LinkStatus`, `TransactionLink`, `TxRef`,
  `LinkDraft`, `buildLink`, `buildLinkId`, `validateLink`, `orderSymmetricPair`,
  `canTransition`, `confirmedAllocatedFromSource`, `confirmedAllocatedAgainstTarget`,
  `linkIndex`, `toTxRef`, `REFUND_SOURCE_TYPES`, `CARD_CREDIT_KINDS`, `CardCreditKind`;
- `src/lib/candidates.ts` — `CandidateType`, `CandidateStatus`, `ReviewCandidate`,
  `ProposedLink`, `CandidateEvidence`, `buildIdentityKey`, `buildCandidateId`,
  `mergeCandidateRun`, `isTerminalCandidateStatus`, `rankCandidates`, `sanitizeEvidence`,
  `MAX_CANDIDATE_TRANSACTIONS`, `MAX_PROPOSED_LINKS`;
- `src/lib/relations-store.ts` — `getLinks`, `getReviewCandidates`, `saveLink`,
  `saveReviewCandidate`, `recordCandidateDecision`, `confirmCandidate`;
- `src/lib/chat-actions.ts` — `RecoveryAction`, `RecoveryContext`, `Allocation`,
  `explanationOf`.

**FIN-REFUND-001 note:** `CARD_CREDIT_KINDS` is declared in `src/lib/relations.ts`, not in
`src/lib/card-credit.ts`. The spec's §14.1 precondition 1 says P11 "reads FIN-REFUND-001's
list", but FIN-RELATION-001 merges **first** and owns the parser that must validate it, so
the list cannot yet live in a file that does not exist. FIN-REFUND-001 should
`import { CARD_CREDIT_KINDS, CardCreditKind } from './relations'` and build
`CARD_CREDIT_TO_INFLOW_MEANING` over it — **not** declare a second copy.

## 13. Deployment impact

**Zero at runtime.** Two new collections that nothing writes to yet, one new rules block,
a validator, a store and thirteen parser actions that no UI can currently reach.

- No migration. Nothing backfills, nothing rewrites an existing document.
- No index required — both collections are read whole, uid-scoped.
- `firestore.rules` must be deployed (`firebase deploy --only firestore:rules`) **before**
  FIN-REFUND-001 or FIN-DUPLICATE-001 ships, or their writes will be denied. Deploying the
  rules alone is safe and inert: the new blocks only widen access to collections that do
  not exist yet, and the existing deny-all still covers everything else.
- The AI system prompt grows by `RECOVERY_ACTIONS_PROMPT` (~2 kB) on every chat turn. It
  is injected unconditionally, which is the simple option; if prompt cost ever matters,
  make it conditional on the context carrying candidates.
- Hosting/build output is unchanged in shape: 19 routes, same set as the baseline.

---

## Appendix — spec deviations, with reasoning

| # | Deviation | Reasoning |
|---|---|---|
| 1 | **`CARD_CREDIT_KINDS` lives in `src/lib/relations.ts`**, not FIN-REFUND-001's `src/lib/card-credit.ts` | The spec has a genuine ordering contradiction: §14.1.1 says P11 reads FIN-REFUND-001's list, while §1 and the umbrella §14 both require FIN-RELATION-001 to merge **first**. The parser cannot import a file that will not exist for two merges. Declaring it once in the foundation and having FIN-REFUND-001 import it keeps the "never a second enum" discipline the spec actually cares about. |
| 2 | **`RuleId` includes `V11`** (note length ≤ 280) | The spec numbers V1–V10 and separately requires `note?: string; // ≤ 280 chars`. Rather than reject an over-long note under a rule that means something else, it gets its own id so a telemetry reason code stays legible. Additive; no V1–V10 semantics changed. |
| 3 | **No third "review decisions" collection** | The task prompt lists "links, candidates and review decisions" blocks. Spec §5.1 defines two collections, and the decision *is* the candidate's `status` + `reviewedAt` + `reviewedBy`. A third collection would be a second source of truth for one fact. Spec wins. |
| 4 | **`serviceFamilies` rules block added** | Not in spec §6, but required by umbrella §16 precondition 9 and FIN-DUPLICATE-001 §12.1 precondition 8, both of which say FIN-RELATION-001's single rules pass must include it. Rules only; the engine stays FIN-DUPLICATE-001's. |
| 5 | **`suggested` / `needs_more_information` candidates are left untouched by a bump** | §4.3 says they "are re-emitted (and may be updated in place)" while §8.1 and test C5 say a bump re-evaluates **only** `unreviewed` and leaves `needs_more_information` untouched including its `algorithmVersion`. Resolved in favour of §8.1/C5: they stay in the queue (not suppressed) but the stored document is not rewritten, so `algorithmVersion` keeps recording the instance the owner saw. |
| 6 | **`relations-rules.test.ts` asserts rules TEXT, not rules BEHAVIOUR** | §11.3 asks for emulator tests; §14.1 precondition 3 allows standing up a harness as the first commit. The task brief forbids installing an emulator and forbids pointing tests at production. Documented in full in §7 rather than skipped silently or faked. |
| 7 | **`ProposedLink` is exported from `candidates.ts`** | As the spec's §4.1 code block shows, even though it is link-shaped. Kept where the spec put it so FIN-REFUND-001's imports match the document. |
