# FIN-RECOVERY-UI-001 — completion report

**Status:** Implemented. `/flow?tab=review` is the programme's review surface, and the
four merged domain engines are now visible to the owner for the first time.

**Branch:** `feat/fin-recovery-ui-001-flow-review`, worktree
`../cashflow-forecast-fin-recovery-ui-001`, baseline `8c53923`
(`INTEGRATION_BASELINE_AFTER_RECOVERY_DOMAIN`) on `feat/transfer-type-monarch-ingest`.
`main` is stale and was never used. Nothing was pushed, merged, rebased or deployed.

Every fixture in this task is invented. No production data was read, queried or accessed;
no authenticated session was obtained; no screenshot exists.

---

## 1. What the owner will actually see

Open `/flow`. Below the four story tiles there is now a strip:

```
Needs Review · 12    Refunds to match · 3    Unknown card credits · 2    Duplicate subscriptions · 1
```

- **`Needs Review · N`** carries the accessible name `Flow, N items to review`, and a
  `sr-only aria-live="polite"` line announces the count when it changes. Clicking it opens
  the review surface unfiltered.
- **Each group chip** opens the surface filtered to that group. A zero-count chip is not
  rendered at all.
- When every item is answered, one line replaces the strip: **"Nothing to review."**

Clicking any chip puts `?tab=review` in the URL, so browser back/forward and deep links
work. Anything else in `?tab=` — absent, `flow`, `transactions`, `insights`, or an unknown
value — renders today's Flow page unchanged.

**Desktop (≥1024px):** the Sankey stays on the left; a landmark `<section>` headed *Money
review* sits on the right and **stays open** while the owner moves through items with
Previous/Next. Selecting an item also pins the Flow node those rows already sit behind, so
the linked pair lights up through the existing trace machinery — and the drill-down table
below the chart lists them with their relation badges.

**Mobile (<1024px):** the existing `Sheet` — native `<dialog>` + `showModal()`, focus trap,
Escape via `onCancel`, backdrop click, iOS body-scroll lock. The desktop sidebar is not
ported down.

---

## 2. Sections built, and the actions on each

| Section | Candidate types | Actions |
|---|---|---|
| **Refund Matches** | `refund_match`, `combined_refund_match` | Confirm links · Adjust allocation · Choose different purchase · Mark as reward · Mark as card payment · Mark as chargeback · Keep unclassified |
| **Returned Purchases** | `partial_refund_match` | the same seven; the card additionally states *"You paid $1,100.00, got $900.00 back. Net cost $200.00."* |
| **Unknown Card Credits** | `unknown_card_credit` | one radio per exported `CardCreditKind`, then Confirm · Keep unclassified |
| **Possible Duplicate Charges** | `immediate_duplicate_charge` | Yes, a duplicate · Both intentional · Different owners · Business vs personal · Already cancelled (with a date) · Dismiss |
| **Possible Duplicate Subscriptions** | `duplicate_subscription`, `subscription_overlap` | the same six |
| **Continued Charges After Cancellation** | `continued_charge_after_cancellation` | the same six |
| **Unknown Deposits** | *(no candidate — FIN-REVIEW-002's source)* | the card-credit choices, then Confirm · Keep unclassified |

**Refund card** shows: the credit with amount, date and masked account
(`Credit · $1,200.00 · 31 Jul · Demo Rewards Card ••9021`); the merchant; the confidence as
a WORD (`high`/`medium`/`low`, never a bare score); every proposed purchase with **both**
its own amount and the amount allocated to it; the remainder always, in words ("nothing
left over" / "$50.00 of this credit is unaccounted for" / "$200.00 of this purchase is
still unrefunded"); a `Why?` disclosure with plain-language reasons built from reason codes
and the raw codes plus algorithm version in an expandable evidence line.

**Duplicate card** shows: both series per account with amount, cadence, first-seen,
last-seen and charge count — never one collapsed row; the overlap count in words; the
avoidable cost rendered from FIN-DUPLICATE-001's own `label` field as *"potential annual
duplicate cost: $240.00"* with the disclaimer **adjacent to the number, not in a tooltip**.
The strings "savings", "you will save" and "guaranteed" appear nowhere (test C6 asserts it
over the whole rendered output). An immediate-duplicate card states *"Both charges are
still counted in your spending. Confirming this does not change any total — it is a note to
yourself to check with the merchant."*

**Transaction badges** (derived on read, never stored on a row): `Returned` ·
`Partly refunded · $200.00 net` · `Over-refunded — needs review` · `Provisional dispute
credit` · `Refund of Demo Amazon Lens, 12 Jul` · `Unallocated $50.00` · `Possible
duplicate` · `Pending`. Text **plus** an `aria-hidden` icon; colour never carries meaning
alone. A card credit never shows a generic "income" label — `CARD_CREDIT_MEANING` maps all
ten kinds to sentences that each end in "not income".

---

## 3. The confirmation gate

**Nothing applies before confirmation, at any confidence.** There is no auto-apply mode, no
"apply all", and no setting that disables the gate.

- A single unambiguous candidate is **preselected**, which is not application: the store is
  untouched until a button is pressed. Test F1 spies on `saveLink`, `saveReviewCandidate`
  and `recordCandidateDecision` through render, selection, allocation editing and the whole
  proposal display, and asserts **zero** calls.
- An **ambiguous** candidate (FIN-REFUND-001 §4.4's 0.05 band) renders its alternatives as
  a radio group with **nothing checked**, and Confirm is disabled until the owner picks
  (test C4).
- Before Confirm is reachable, the card shows a labelled *"What confirming will do"*
  region: every allocation with its target in plain language · how many transactions are
  affected · the date range · the **budget** effect (*"Your Shopping total for July falls
  from $1,200.00 to $0.00."*, computed through `getAllCategorySpending` with and without
  the links this confirmation would write) · the **forecast** effect · the **Flow** effect
  · what does **not** change · the scope ("this candidate only; no merchant rule").
- The allocation editor validates live through `validateLink` — the same validator the
  store, the parser and `firestore.rules` agree with — and **disables Confirm with a
  sentence** ("That is $100.00 more than that purchase.") rather than clamping. The typed
  value stays on screen (test F4).
- Amounts are read through `toCents()`: typing `41.2` stores `4120`, never a float
  (test F3).

---

## 4. How the counts refresh without a reload

1. **Persist** — optimistic. Links are built locally with the pure `buildLink` (same
   validator, same derived ids), pushed into React state, and the store call is fired with
   `.catch`, never awaited into a hang.
2. **Recompute** — the queue, the counts, the economics and the badges are all `useMemo`s
   over `[transactions, accounts, links, candidates, …]`. Changing the `links` and
   `storedCandidates` state recomputes them in the same render pass, for free.
3. **Counts update** and the item leaves the queue as a *consequence* of 2, not as a
   separate mutation: `buildReviewQueue` drops terminal statuses by construction.
4. **Announce** — one `aria-live="polite"` line: *"Confirmed — $1,200.00 marked as
   returned."*
5. **Undo** — offered while the panel stays on that item. Undo restores the previous
   candidate status and marks the created links `rejected`; it **never deletes** one, and
   it is withdrawn when the panel closes or the selection changes.

No `window.location.reload()`, no `router.refresh()`, no full page reload — asserted
structurally in F6. No in-place mutation of any transaction, link or candidate: new
objects, new arrays, functional `setState`, asserted with frozen fixtures (F8, X11).

---

## 5. The two gaps, closed

### 5.1 `budgets.ts` is wired to net — YES

`getCategorySpending`, `getAllCategorySpending` and `calculateBudgetStatuses` take an
**optional** `links` argument. Absent or empty, the gross path is byte-identical and every
existing caller keeps its exact previous arithmetic — which is why no existing budget test
changed. Supplied, the month's counted rows go through FIN-REFUND-001's
`netCategorySpendingCents()` in integer cents, with one division at the render boundary.

Only **confirmed** links move a number; a `suggested` or `provisional` link is invisible to
`purchaseEconomics()` by construction, which is the mechanical form of "nothing applies
before confirmation". Gross is never destroyed to show net.

**Live caller today:** the confirmation gate's budget line, which calls it twice — once
with the stored links and once with the links the confirmation would write — to produce
*"Your Shopping total for July falls from $1,200.00 to $0.00."* The **Budgets page** itself
does not yet pass links: spec §5.1/§14.3 defers badge and net adoption on Dashboard,
Accounts, Analytics, Budgets, Forecast, History and Export to a follow-up with its own
ownership, and widening this task to edit `BudgetStatusPanel.tsx` would have been a silent
scope grab. The function is wired, tested and one argument away on every one of those
surfaces.

**The net-budget tests** are X3 and X6 in `recovery-cross-surface.test.ts`: the whole
scenario's net total through `getAllCategorySpending(..., LINKS)` equals the hand-computed
`68840`, July shopping falls `132840 → 12840`, and the gross call still answers `283340`.

### 5.2 The cancellation effective date is persisted — YES

`recordCandidateDecision` has no field for it, and `relations-store.ts`, `candidates.ts`
and `firestore.rules` are all closed to this task. The rules validate `reviewCandidates`
with `keys().hasAll([...])`, so an **additional** key on the document is legal. The
effective date therefore rides on the candidate document as `cancelledEffectiveDate`,
written through the existing `saveReviewCandidate`, and is read back at load time into
`DuplicateOptions.cancellations` — resolving each candidate's `serviceFamilyId` from the
**local ledger** via `resolveServiceIdentity`, because a candidate document deliberately
carries no merchant text.

`continued_charge_after_cancellation` is therefore **armed** for the first time. The owner
supplies the date with a native `<input type="date">` beside the "Already cancelled"
decision, which stays disabled until a date is entered — a cancellation with no date arms
nothing, so asking for it is not optional.

The whole family is armed (`accountId` omitted), which is the conservative reading of "I
cancelled it": any later charge in that family raises the alert.

### 5.3 The `TransactionLink` stub is deleted — YES

`src/types/index.ts` no longer declares it. A comment in its place points at
`@/lib/relations`. There is now exactly one link type in the codebase, and `tsc --noEmit`
confirms nothing referenced the stub.

---

## 6. FIN-REVIEW-002 — the unknown-inflow queue COMPOSED

It plugs in cleanly and needed no seam:

- `selectInflowReviewQueue(transactions, accounts, incomeContext)` is called in a `useMemo`
  and its items become the **Unknown Deposits** section — a second *item source* in the one
  queue, exactly as `FIN-REVIEW-002.md:36-39` demands. No second shell, no second list, no
  second state machine.
- The state vocabularies are aligned once, in `review-queue.ts` §2.3, with a round trip in
  both directions (test Q3). The two genuine gaps — `needs_attention` has no stored
  candidate status, `needs_more_information` has no FIN-REVIEW-002 equivalent — return
  `null` rather than an invented value.
- Persistence reuses `useUserProfile().setInflowReview`, which already writes
  `users/{uid}/reviews/{transactionId}`. No new collection, no rules change.
- **FIN-REVIEW-002's AI discussion workspace is NOT implemented**, per the owner's ruling.
  `DataChatSheet` is not embedded and not edited. When that task lands it adds a pane to
  this shell.

---

## 7. Accessibility

- **One dialog primitive on mobile**: the existing `Sheet`. Native `<dialog>`,
  `showModal()`, focus trap, Escape via `onCancel` with parent state as the source of
  truth, backdrop click, iOS body-scroll lock. No hand-rolled portal, no `role="dialog"`
  div (test R2).
- **Desktop panel** is a landmark `<section aria-labelledby>` with a heading, keyboard
  reachable, visible focus.
- **44px minimum** on every actionable element in the surface — every button, input,
  summary and label carries `min-h-[44px]`, asserted node by node in R3, along with the
  Flow entry chips.
- **Keyboard**: Previous/Next are real buttons with `aria-label`s; the decisions are
  buttons in DOM order; the allocation editor is a native `<input type="number"
  inputMode="decimal">` with a **visible** `<label for>`; nothing is mouse-only (R4).
- **`aria-live="polite"`** once for confirmation results, once for the queue count. Never
  per keystroke.
- **Colour never alone** — every badge is text plus an `aria-hidden` icon.
- **`prefers-reduced-motion`** untouched and intact; chart animation stays disabled
  (`isAnimationActive={false}`) (R6).
- **The text alternative stays accurate**: the flow-as-a-table `<details>` gains a *Linked
  transactions* table — credit, what it reverses, allocated — so no relationship the
  diagram highlights is invisible to a screen reader (A6).
- **Masked accounts only**: an account is rendered as the owner's own name plus `••9021`.
  `PaymentAccount` stores four digits and nothing longer, so a full number cannot reach the
  UI.

---

## 8. Performance — what actually happens

- `generateRefundCandidates` and `generateDuplicateCandidates` each sit in **one `useMemo`**
  keyed on their real inputs (`[recoveryLoaded, transactions, accounts, links, income]` and
  `[recoveryLoaded, transactions, accounts, todayISO, cancellations, income]`). They run on
  a data change and at no other time — not on hover, not on a filter change, not on a
  re-render, and never in an unguarded effect.
- Both are gated on `recoveryLoaded`, so nothing generates until the two collections have
  been read once. The read happens once per signed-in session.
- The derived queue, counts, badge context, confirmed-pair table and recovery totals are
  each their own `useMemo` over the memoized results. The panel reads them; it never scans
  the ledger.
- A confirmation changes `links`/`storedCandidates` state, which re-runs the generators
  once. That is the intended trigger — "on data change".
- `buildFlowGraph`'s existing memo is untouched and recomputes for free.
- **Not implemented:** queue virtualization past 100 items (spec §11). A virtualizer for a
  queue that is empty when the work is done is complexity nobody asked for; the list is
  `max-h-72 overflow-y-auto` and renders plainly. Add it when a real queue exceeds 100.

---

## 9. Observability

`src/lib/obs/useRecoveryObservability.ts`, modelled on `useAccountsObservability`. It
continues the document's trace with `startTrace(documentTraceparent())`, publishes
`window.__OBS__`, is called **above** the early return, and emits `MoneyReview.PageViewed`
once on mount.

| Event | Safe properties |
|---|---|
| `MoneyReview.QueueOpened` | `recordCount`, `metadata.countsByType`, `route` |
| `MoneyReview.TransactionSelected` | `candidateType`, `queuePosition`, `state` |
| `MoneyReview.ClassificationConfirmed` | `candidateType`, `decisionStatus`, `confidence` |
| `MoneyReview.LinkConfirmed` | `candidateType`, `allocationCount`, `algorithmVersion`, `durationMs` |
| `MoneyReview.AllocationEdited` | `allocationCount`, `validationRejected` |
| `MoneyReview.UndoCompleted` | `undoneEventName`, `durationMs`, `resultStatus` |

`emitRefundDecision()` (`Refund.MatchConfirmed` / `Refund.MatchRejected`) and
`emitDuplicateDecision()` fire beside every `recordCandidateDecision`, since those modules
write nothing themselves. The domain events (`Refund.CandidateGenerated`,
`CardCredit.Classified`, `Duplicate*`, `Relation.*`) come from the modules that own them
and are not emitted a second time.

**Never logged:** merchant strings, titles, descriptions, account names or numbers,
`lastFourDigits`, amounts as free values, provider payloads, credentials, tokens, the
owner's typed message, the model's reply, the AI context, or an unhashed transaction id.

---

## 10. Verification — actual observed output

```
$ npx tsc --noEmit
(no output)

$ npx jest
Test Suites: 1 skipped, 52 passed, 52 of 53 total
Tests:       7 skipped, 847 passed, 854 total

$ npm run build
✓ Generating static pages using 9 workers (19/19)
19 routes — the same set as the baseline

$ npm test --prefix functions
Test Suites: 3 passed, 3 total
Tests:       26 passed, 26 total

$ npx eslint src
✖ 149 problems (53 errors, 96 warnings)          — IDENTICAL to the baseline
  react-hooks/rules-of-hooks:  0
  set-state-in-effect:         0

$ (integration venv, read-only, against this worktree's sources)
  .../cashflow-forecast/functions-sync/venv/bin/python -m unittest discover
Ran 62 tests in 0.020s
OK
```

**804 → 854 web tests (+50).** Every one of the baseline's 804 still passes and **not one
existing expectation was rewritten** — the gross budget path was deliberately left
byte-identical so that could be true. eslint is at the baseline number exactly: the three
findings this task first introduced (an unstable `useMemo` dependency, a `prefer-const`,
and an unused eslint-disable) were fixed rather than absorbed, and the trace id moved from
a ref written during render to a lazy `useState` initializer specifically so
`react-hooks/refs` — which the deploy gate blocks on — stays at zero.

**Hook order was checked explicitly.** Every hook this task adds is above
`if (authLoading || !isAuthenticated) return null;`. Test R1 renders the page loading,
unauthenticated and authenticated in one file, fails on any React hook-order message, and
additionally asserts structurally that no `useState|useEffect|useMemo|useCallback|useRef|
useContext` call appears after that line in the source.

---

## 11. Test inventory — 50

| Suite | Tests |
|---|---|
| `src/__tests__/recovery-queue.test.tsx` | Q1–Q7 (7) |
| `src/__tests__/recovery-cards.test.tsx` | C1–C11 (11) |
| `src/__tests__/recovery-confirm.test.tsx` | F1–F8 (8) |
| `src/__tests__/recovery-flow-view.test.tsx` | A1–A6 (6) |
| `src/__tests__/recovery-a11y.test.tsx` | R1–R6 (6) |
| `src/__tests__/recovery-cross-surface.test.ts` | X1–X12 (12) |

The cross-surface suite is ONE sanitized scenario — card purchase, card payment, exact
refund, partial refund, combined refund, cashback credit, unknown card credit, provisional
dispute credit, immediate duplicate charge, duplicate subscription across accounts,
intentional duplicate — with hand-computed integer-cent truth
(`gross 283340`, `confirmed refunds 214500`, `net 68840`, `income 320000`) asserted across
Dashboard, Accounts, Flow, Analytics, Budgets, Forecast, History, Export and AI context.

Required outcomes, all asserted: card credits are earned income nowhere (X1) · card
payments are aggregate-neutral (X4) · refunds reduce net economic spending everywhere and
income nowhere (X5, X6) · gross history stays visible and byte-identical (X2, X11) ·
duplicate candidates delete no transaction and change no total (X8, X9) · Export carries
the same financial meaning (X1, X2, X9) · AI context reads the same shared interpretation
and no surface has its own recovery branch (X12).

---

## 12. Files

**Created**

| File | Purpose |
|---|---|
| `src/lib/review-queue.ts` | the one view model, the state alignment, ordering, counts, badges, plain language, the confirmation preview, the supersede rule |
| `src/lib/obs/useRecoveryObservability.ts` | the page hook |
| `src/components/RecoveryReviewPanel.tsx` | the shell (desktop `<section>` / mobile `Sheet`) |
| `src/components/RefundCandidateCard.tsx` | the refund card and the allocation editor |
| `src/components/DuplicateCandidateCard.tsx` | the duplicate card |
| `src/components/CardCreditCard.tsx` | the unknown-card-credit card |
| `src/components/TransactionRelationBadge.tsx` | text-plus-icon badges |
| six `src/__tests__/recovery-*` suites | 50 tests |

**Modified**

| File | Change |
|---|---|
| `src/app/flow/page.tsx` | the `?tab=` read, the chip strip, the panel, the decision/undo handlers, drill-down badges, the linked-transactions text alternative |
| `src/lib/budgets.ts` | the optional `links` argument, netting through `netCategorySpendingCents()` |
| `src/types/index.ts` | the `TransactionLink` stub deleted |

**Read but never written:** `refunds.ts`, `card-credit.ts`, `duplicates.ts`,
`service-identity.ts`, `relations.ts`, `candidates.ts`, `relations-store.ts`,
`chat-actions.ts`, `classify.ts`, `forecast.ts`, `flows.ts`, `firestore.ts`,
`fingerprint.ts`, `functions-sync/*`, `firestore.rules`, `functions/src/prompts.ts`,
`.github/`, `scripts/predeploy.sh`, package `scripts`. `Sheet.tsx` and `DataChatSheet.tsx`
were composed, not edited. `nav.ts`, `Navbar.tsx`, `BottomNav.tsx`, `ClientLayout.tsx` and
`next.config.ts` were not touched — UX-NAV-002 owns the consolidation.

---

## 13. Manual validation procedure — the owner runs this, read-only

**Nobody but the owner performs this.** It is read-only, in the app's own UI. No console
query, no export of raw rows, no sync trigger, no screenshot. What comes back is **counts
and yes/no only** — no merchant, no id, no account, no date, no amount.

**Window:** 120 days before and 60 days after the anchor date **2026-07-31**, i.e.
**2026-04-02 through 2026-09-29**.

**Steps**

1. Open `/flow`. Set the range so the window above is covered (**All time** is fine).
2. Read the review strip. Record the number on **Needs Review** and on each group chip.
3. Click **Needs Review**. On desktop the panel opens beside the diagram; on a phone the
   bottom sheet opens.
4. Walk the queue with **Next**. For each item, **without pressing any decision button**:
   - confirm the credit line shows an amount, a date and an account ending in `••NNNN` —
     and **never** a full account number;
   - confirm every proposed purchase shows both its own amount and its allocation;
   - confirm the remainder line reads in words;
   - open **Why?** and confirm the explanation is a sentence, not a score;
   - confirm the *"What confirming will do"* block names the budget, forecast and Flow
     effect and says what does **not** change.
5. Find the anchor credit dated **2026-07-31**. Answer, from the card alone:
   - does it propose a single purchase, a combination, or nothing?
   - if a combination, do the allocations add to the credit exactly, with "nothing left
     over"?
   - is more than one answer offered? If so, confirm **nothing is preselected** and
     **Confirm is disabled** until you pick.
6. Pick one item you are sure about and press its decision. Confirm, in order: the
   announcement line appears, the item leaves the queue, **the counts drop by one**, the
   page does **not** reload, and an **Undo** button appears. Press **Undo** and confirm the
   item comes back.
7. Open **View the flow as a table**. Confirm the **Linked transactions** table lists the
   relationship you just confirmed (then undid), and that the flow row count is unchanged
   from before step 6.
8. Open `/budgets` (or the budget panel) and confirm the categories still read **gross** —
   they are the deferred follow-up in §5.1, and a changed number there at this commit would
   be a defect.

**Sanitized report template — the only thing that comes back**

```
FIN-RECOVERY-UI-001 VALIDATION — sanitized
Needs Review count:                                __
  Refunds to match:                                __
  Returned purchases:                              __
  Unknown card credits:                            __
  Possible duplicate charges:                      __
  Duplicate subscriptions:                         __
  Charges after cancelling:                        __
  Unknown deposits:                                __
Anchor credit appears in the queue?                yes / no
  proposes a single purchase?                      yes / no
  proposes a combination?                          yes / no   size: __
  allocations add to the credit exactly?           yes / no
  more than one answer offered?                    yes / no
  nothing preselected when ambiguous?              yes / no
  Confirm disabled until a choice is made?         yes / no
Every account shown masked (••NNNN only)?          yes / no
Any full account number visible anywhere?          yes / no   (expected: no)
Any credit labelled generically as "income"?       yes / no   (expected: no)
Any bare 0.xx score visible?                       yes / no   (expected: no)
Words "savings"/"you will save"/"guaranteed" seen? yes / no   (expected: no)
After one confirmation:
  announcement appeared?                           yes / no
  item left the queue?                             yes / no
  counts dropped by one?                           yes / no
  page reloaded?                                   yes / no   (expected: no)
  Undo offered, and it restored the item?          yes / no
  flow row count unchanged?                        yes / no
Linked transactions table lists the pair?          yes / no
Budgets still gross at this commit?                yes / no   (expected: yes)
44px targets comfortable on the phone?             yes / no
```

---

## 14. Known limitations

1. **Queue virtualization is not implemented** (spec §11's "past 100 items"). Plain
   rendering inside a scroll container. Add it if a real queue ever exceeds 100.
2. **Badges are not yet on Dashboard, Accounts, Analytics, Budgets, Forecast, History,
   Calendar or Export**, and the Budgets page does not yet pass `links`. Deferred by spec
   §5.1/§14.4 to a follow-up with its own ownership. `relationBadges()` and the `links`
   argument are exported and ready; adoption is one call each.
3. **The re-adjustment flow of spec §7.2 is implemented but not reachable from the queue.**
   `generateRefundCandidates` skips any credit that already carries a confirmed link
   (`refunds.ts` §4.1.4), so a confirmed allocation never comes back as a candidate to
   adjust. The supersede rule (`supersededLinks()`) is implemented, used by the confirm
   path for any stored link a confirmation replaces, and unit-tested (F5) — it will fire
   the moment a re-open path exists. Note also that a link id is derived from
   `linkType~source~target`, so changing only the **amount** on the same pair is an upsert
   against one document and needs no supersede at all.
4. **Service families are not read.** `generateDuplicateCandidates` is called with no
   `families`, so every merchant is its own family and FIN-DUPLICATE-001's rule-2 alias
   path is inert. There is no store function for `users/{uid}/serviceFamilies` at this
   baseline, and writing one meant touching a module this task does not own. Rule 1 (exact
   normalized merchant) and rule 3 (token-overlap proposals, emitted as
   `needs_more_information`) both work.
5. **Rule-3 alias confirmation is not wired.** `confirmAlias()` + a `serviceFamilies` write
   is the same missing store as (4).
6. **`mark as card payment` and `mark as reward` write a review record, not a link.** There
   is no link type for a reward, and a `card_payment_pair` needs a funding leg the UI does
   not know. Both are recorded as `users/{uid}/reviews/{transactionId}` with the right
   `FinancialMeaning`, which is what every income total already reads.
7. **No Playwright coverage.** Spec §12 permits it only against a sanitized fixture route;
   adding one was not required and every guarantee here is covered by Jest.
8. **No behavioural Firestore rules test.** Inherited from FIN-RELATION-001 — no emulator
   is configured and installing one was out of scope. The extra `cancelledEffectiveDate`
   key is legal under the deployed `keys().hasAll([...])` rule by inspection, not by an
   engine evaluation.

---

## Appendix — spec deviations, with reasoning

| # | Deviation | Reasoning |
|---|---|---|
| 1 | **`budgets.ts` and `types/index.ts` were edited**, though spec §14.3 lists both as "not touched". | The task prompt assigns both explicitly as gaps this task owns and must close. §14.3 was written before the gaps were found; the prompt is the owner amending their own spec, not contradicting it. Both edits are additive-and-optional (budgets) or a deletion of dead code (types). |
| 2 | **`recovery-queue.test.ts` is `.tsx`.** | Spec §14.2's filename table says `.ts`, but four of the seven tests it enumerates (Q1, Q2, Q6, Q7) require rendering the page. JSX needs `.tsx`. |
| 3 | **The observability namespace is `MoneyReview.*`, not `RecoveryReview.*`.** | The task prompt names `MoneyReview.QueueOpened`, `MoneyReview.TransactionSelected`, `MoneyReview.ClassificationConfirmed`, `MoneyReview.LinkConfirmed` and `MoneyReview.UndoCompleted`; spec §10 names `RecoveryReview.*`. Both cannot be right and one namespace is the whole point, so the prompt's explicit list wins. The spec's `ItemSelected` / `AllocationEdited` shapes are preserved under the prompt's prefix. |
| 4 | **"Returned Purchases" holds `partial_refund_match`.** | The prompt lists six sections; the eight candidate types map onto them one way that leaves no type homeless. A partial refund *is* the "partly returned purchase" case, and the card states the net explicitly. |
| 5 | **The account line is "Demo Rewards Card ••9021", not the bare account name.** | Spec §4.2.1 says the name as the owner set it; the prompt says "masked account". Both are satisfied by name + masked tail, and `PaymentAccount` holds no longer number to leak. |
| 6 | **Selecting an item pins the Flow node the rows sit behind, not the account node.** | Spec §6 asks for "selecting either row highlights both endpoints through the existing trace machinery". `graph.nodeTxnIds` is what maps rows to nodes; pinning the account node produced an empty drill-down because `buildFlowGraph` does not hang transactions off account nodes. Pinning the node that actually holds the rows lights up the pair *and* makes the drill-down real, still adding no node and no edge. |
| 7 | **The purchase list names rows by `title`, the headlines by `merchant`.** | Two Amazon purchases are both "DEMO AMAZON"; an allocation card that prints the same word twice is useless. `rowLabel()` (title first) names a row, `merchantOf()` (merchant first) names a family. |
| 8 | **The completion report follows FIN-RELATION-001-COMPLETION.md's structure.** | The prompt cites "umbrella §35"; `REFUNDS-RETURNS-AND-DUPLICATES.md` has 16 sections and no §35. FIN-DUPLICATE-001's report recorded the same discrepancy and made the same choice. |
| 9 | **The cross-surface suite's AI-context assertions live inside X12** rather than a 13th test. | The spec fixes the suite at twelve. X12's subject — "no surface carries its own recovery branch" — is exactly where "the AI context reads the same shared interpretation" belongs. |
| 10 | **`selectInflowReviewQueue` reports the provisional dispute credit as unexplained.** | Not a deviation so much as a finding worth recording: `interpretTransaction()` cannot see a `provisional` link by design, so a dispute credit is `unknown_inflow` to the ledger layer while the recovery queue knows exactly what it is. X12 pins both behaviours, and it is the clearest demonstration of why the two item sources compose instead of competing. |
