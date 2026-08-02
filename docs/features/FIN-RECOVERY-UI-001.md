# FIN-RECOVERY-UI-001 — Flow Review surface for refunds and duplicates

**Status:** Specification only. Nothing under `src/`, `functions/`, `functions-sync/` or any
config file is modified by this task.

**Branch:** `docs/fin-recovery-specs`, worktree `../cashflow-forecast-recovery-specs`,
baseline `2aaf4e5` on `feat/transfer-type-monarch-ingest`. `main` is stale and is never used.

**Position in the programme:** **FIN-RELATION-001 merges FIRST.** FIN-REFUND-001 and
FIN-DUPLICATE-001 may then run in parallel only because their file ownership is disjoint.
**FIN-RECOVERY-UI-001 is LAST and is the SOLE OWNER of `src/app/flow/page.tsx`.** No other
task in this programme writes that file, and this task writes no library module that another
task owns.

All sample data is invented: "Demo Amazon Lens", `$1,100.00`, `demo-card-9021`. No real
balance, merchant, account number, provider id or description appears here or in any fixture
this task produces. No screenshot with a live balance is ever committed.

---

## 1. Purpose

Give the owner one place to answer, about their own money:

- *What is this credit on my card?*
- *Did that $1,100.00 purchase come back?*
- *Am I being charged twice?*

and to answer it **without the app having already decided**. Every number this surface shows
is computed by `src/lib/relations.ts`, `src/lib/refunds.ts`, `src/lib/duplicates.ts`,
`buildFlowGraph()` (`src/lib/flows.ts:91`) or `generateForecast()` — never parsed out of a
model reply (`src/lib/forecast.ts:1-7` is the standing rule: "AI only interprets these results
— it never calculates").

---

## 2. Where it lives, and how it composes with FIN-REVIEW-002

### 2.1 `/flow?tab=review` — already reserved

`docs/ux/PROPOSED-INFORMATION-ARCHITECTURE.md:69-86` allocates the tab contract on `/flow`
(`flow` | `transactions` | `insights` | `review`), states that "**Room for Money Review is
reserved now:** `?tab=review` is allocated in the tab contract even though the tab ships empty
or hidden initially", and puts a **count badge on the Flow destination**, not on the tab, so
an unreviewed count is visible from anywhere. `docs/ux/PROPOSED-INFORMATION-ARCHITECTURE.md:115-116`
adds: unknown or missing `tab` values fall back to `tab=flow`.

FIN-RECOVERY-UI-001 implements **only** the `review` tab and the `?tab=` read, exactly to that
contract:

- read `tab` from the URL; `review` renders the review surface; anything else — including
  `transactions`, `insights`, an unknown value, or no value — renders today's Flow content
  unchanged;
- `?tab=` is in the URL, so browser back/forward and deep links work
  (`docs/ux/PROPOSED-INFORMATION-ARCHITECTURE.md:274`);
- **the wider IA consolidation is NOT in scope.** No redirect from `/history`, `/analytics`,
  `/cashflow` or `/calendar`; no `next.config` change; no `src/lib/nav.ts` change; no removal
  of the hamburger. Those belong to the UX-IA task
  (`docs/ux/PROPOSED-INFORMATION-ARCHITECTURE.md:120-148`). This task adds one tab and leaves
  the other three to it.

### 2.2 ONE review queue — composing with FIN-REVIEW-002, not duplicating it

`docs/features/FIN-REVIEW-002.md:36-39` is explicit: "**One review queue, one review state
machine, one AI discussion surface, one confirmation gate, one persistence path, one telemetry
namespace.** Money type is a *property of the item*, not a reason for a second system."

Recovery items obey that rule. They are a second **item source**, never a second queue:

| | FIN-REVIEW-002 items | FIN-RECOVERY-UI-001 items |
|---|---|---|
| Keyed on | one transaction | a **relationship** between 2..13 transactions |
| Stored at | `users/{uid}/reviews/{transactionId}` (`FIN-REVIEW-002.md:932`) | `users/{uid}/reviewCandidates/{identityKey}` (FIN-RELATION-001 §5.1) |
| Asks | "what is this row?" | "do these rows belong together?" |

Both render through **one** view model, owned by this task:

```ts
// src/lib/review-queue.ts — owned exclusively by FIN-RECOVERY-UI-001.
export interface ReviewQueueItem {
  key: string;                       // review record id OR candidate identityKey
  source: 'transaction' | 'candidate';
  transactionIds: string[];          // 1 for a transaction item, 2..13 for a candidate
  headline: string;                  // plain language, built locally from the ledger
  reasonCodes: string[];
  state: QueueState;                 // §2.3
  rank: number;
}
```

**Whichever of the two tasks ships first builds the shell** — the tab, the list, the panel,
the confirmation gate, the `aria-live` region, the empty state — and the second one adds an
item source to it. FIN-REVIEW-002 is unimplemented and hard-blocked on FIN-INCOME-001
(`FIN-REVIEW-002.md:1076-1085`), so on current sequencing that shell is this task's. If
FIN-REVIEW-002 lands first, **this task adds a source to its shell and builds no second
list.**

### 2.3 State vocabulary — one alignment table, no translation layer

FIN-REVIEW-002 §2.2 (`FIN-REVIEW-002.md:83-95`) and FIN-RELATION-001 §4.1 name their states
slightly differently. Aligned once, here, and rendered from one vocabulary:

| Queue state | FIN-REVIEW-002 | FIN-RELATION-001 candidate | In queue? |
|---|---|---|---|
| `unreviewed` | `unreviewed` | `unreviewed` | yes |
| `suggested` | `suggested` | `suggested` | yes, after `unreviewed` |
| `needs_more_information` | *(no equivalent)* | `needs_more_information` | yes, ranked last |
| `needs_attention` | `needs_attention` | *(derived — link partner missing, FIN-RELATION-001 §3.7)* | yes, ranked **first** |
| `confirmed` | `confirmed` | `confirmed` | no |
| `dismissed` | `dismissed` | `dismissed` | no |
| `intentional` | *(no equivalent)* | `intentional` | no |

Neither underlying model is changed to fit the other. The queue reads both and renders one
vocabulary. Test Q3 asserts a round trip in both directions.

### 2.4 The badge

One count, one canonical home. `docs/ux/PROPOSED-INFORMATION-ARCHITECTURE.md:193` puts the
review count in the top bar and mirrors it on the rail; `:222` puts a numeric pill on the
mobile Flow tab; `:270-273` requires it to be **announced, not merely painted** —
`aria-label="Flow, 7 items to review"` plus a live-region update when the count changes.

FIN-RECOVERY-UI-001 exports the count from `src/lib/review-queue.ts` and renders it on the
`/flow` page. **It does not edit `src/lib/nav.ts`, `Navbar.tsx` or `BottomNav.tsx`** — those
are the UX-IA task's. Until that lands, the badge lives on the tab strip inside `/flow`, with
the same accessible name and the same live region. Wiring it into the shell is a one-line
follow-up for whoever owns the nav.

---

## 3. Entry point on `/flow`

A compact strip below the four story tiles (`src/app/flow/page.tsx:599-614`), in the existing
tile voice. Each chip is a real `<button>` that opens the review tab filtered to that group:

```
Refunds to match · 3    Unknown card credits · 2    Possible duplicates · 1
```

- Zero-count chips are hidden.
- When everything is reviewed, one calm line replaces the strip — **"Nothing to review."** —
  matching the existing "Data complete / every dollar accounted for" tile at
  `src/app/flow/page.tsx:605`.
- The chips compose with FIN-REVIEW-002's chip strip (`FIN-REVIEW-002.md:762-769`): same row,
  same component, more chips. Not a second strip.

**Hook-order hazard.** `/flow` returns `null` only *after* every hook
(`src/app/flow/page.tsx:581`, with the note "shipped once; never again" about React error
#310). Every hook this task adds goes **above** that line. Test R1 asserts it by rendering
unauthenticated and authenticated in the same suite without a hook-order warning.

---

## 4. The review surface

### 4.1 Layout

**Desktop (≥1024px)** — the Flow visualization stays on the left; a **persistent review panel**
(380–420px) sits on the right and **stays open** while the owner moves through items.
Next/Previous change the selection without closing it, so the Sankey stays visible and the
selected item's endpoints stay highlighted. This is `FIN-REVIEW-002.md:771-781`'s layout,
adopted unchanged.

**Mobile (<1024px)** — the existing `Sheet` component (`src/components/Sheet.tsx`), a native
`<dialog>` with `showModal()`. **Do not port the desktop sidebar to mobile**
(`FIN-REVIEW-002.md:785-786`). `Sheet` already gives focus trap, Escape via `cancel`, the top
layer, and the iOS body-scroll lock that "is the load-bearing part, don't remove it"
(`src/components/Sheet.tsx:5-12`). `DataChatSheet` already composes it and
`src/__tests__/sheet.test.tsx` already covers it.

### 4.2 The refund card

One card per refund candidate. Everything on it is text and numbers; nothing is a chart.

```
┌──────────────────────────────────────────────────────────────┐
│ Credit · $1,200.00 · 31 Jul · Demo Card ••9021               │
│ This looks like a refund for two purchases.                  │
│                                                              │
│  Demo Amazon Lens      12 Jul   $1,100.00   ← $1,100.00      │
│  Demo Amazon Filter    14 Jul     $100.00   ← $100.00        │
│  ───────────────────────────────────────────────────────     │
│  Allocated $1,200.00 of $1,200.00 · nothing left over        │
│                                                              │
│  Why we think so: the two amounts add up to this credit       │
│  exactly, same card, same merchant, within 20 days.          │
│                                                              │
│  [ Confirm ]  [ Change amounts ]  [ Not a refund ]  [ Later ]│
└──────────────────────────────────────────────────────────────┘
```

Required elements:

1. **The credit**, with amount, date and account. Account is shown by its **name as the owner
   set it**, which is local data; nothing about the account leaves the browser.
2. **Each proposed purchase**, with its own amount and the amount allocated to it. Both are
   shown even when equal — "allocated $100.00 of $100.00" is not noise, it is the thing being
   confirmed.
3. **The remainder**, always, in words: "nothing left over" / "$200.00 of this purchase is
   still unrefunded" / "$50.00 of this credit is unaccounted for".
4. **The reason in plain language**, built from `CandidateEvidence.reasonCodes`
   (FIN-RELATION-001 §4.4) — never a bare score (`FIN-REVIEW-002.md:168-170`).
5. **Alternatives when ambiguous.** If FIN-REFUND-001 §4.4 emitted more than one candidate
   within 0.05, the card shows them as a labelled choice — *"Two purchases could match this
   credit"* — with **no** pre-selection. Confirm is disabled until the owner picks.
6. **A partial-refund card** additionally states the net: *"You paid $1,100.00, got $900.00
   back. Net cost $200.00."*

### 4.3 The duplicate card

```
┌──────────────────────────────────────────────────────────────┐
│ Possible duplicate subscription                              │
│ Demo Service · Demo Card ••9021 and Demo Card ••4410         │
│                                                              │
│  ••9021   $20.00/mo   since Feb   last charge 18 Jul         │
│  ••4410   $20.00/mo   since Apr   last charge 20 Jul         │
│  Both charged in 4 of the same months.                       │
│                                                              │
│  Potential annual duplicate cost: $240.00                    │
│  This is what a second subscription costs in a year, not a   │
│  saving — you may be paying for both on purpose.             │
│                                                              │
│  [ Yes, cancel one ] [ On purpose ] [ Different person ]      │
│  [ For business ] [ Not a duplicate ]                        │
└──────────────────────────────────────────────────────────────┘
```

Required:

1. **Both series**, per account, with cadence, amount, first-seen and last-seen — never one
   collapsed row.
2. **The evidence**, in words: overlapping period count, charge counts.
3. **The avoidable-cost figure labelled "Potential annual duplicate cost"**, with the
   disclaimer sentence *rendered adjacent to the number, not in a tooltip*. The strings
   "savings", "you will save" and "guaranteed" appear nowhere (test C6).
4. **All five decisions visible**, not behind an overflow menu. "Different person" and "For
   business" are first-class, because they are the honest answers for a shared or a business
   card, and burying them makes "yes, cancel one" the path of least resistance.
5. For an `immediate_duplicate_charge` card: both charges with dates and the day gap, and the
   line *"Both charges are still counted in your spending. Confirming this does not change
   any total — it is a note to yourself to check with the merchant."*

### 4.4 The unknown-card-credit card

The smallest card. The credit, the account, and a closed set of choices rendered from
FIN-REFUND-001's exported `CardCreditKind` list — never a hand-written `<option>` list
(`FIN-REVIEW-002.md:236`). Above the choices, one line:

> **This is money that arrived on a credit card. It is not income until you say what it is.**

That sentence is the product rule made visible.

### 4.5 Deterministic ordering

`needs_attention` → `unreviewed` → `suggested` → `needs_more_information`, then by candidate
score descending, then `generatedAt` ascending, then key ascending. Fully deterministic, so
the list never reshuffles between renders (test Q4).

---

## 5. Transaction badges

Rendered wherever a transaction row appears that this task owns the rendering of — the review
panel and the `/flow` drill-down table (`src/app/flow/page.tsx:668-685`).

| Badge | Condition | Text |
|---|---|---|
| Returned | `fully_refunded` | "Returned" |
| Partially refunded | `partially_refunded` | "Partly refunded · $200.00 net" |
| Over-refunded | `over_refunded` | "Over-refunded — needs review" |
| Provisional | `provisional_dispute_credit` | "Provisional dispute credit" |
| Refund of… | the row is a confirmed refund source | "Refund of Demo Amazon Lens, 12 Jul" |
| Possible duplicate | an unreviewed `immediate_duplicate_charge` involves the row | "Possible duplicate" |
| Pending | `interpretTransaction().pending === 'pending'` | "Pending" (existing behaviour, unchanged) |

Rules:

- **Text plus icon, never colour alone** (`FIN-REVIEW-002.md:921`).
- A badge is **never** a claim the app cannot back. "Returned" appears only when confirmed
  links sum exactly to the purchase.
- **Provisional badges always carry the word "provisional"** and never appear on a figure
  that has been netted (FIN-REFUND-001 §6.1).
- Badges are derived, never stored on the transaction. No transaction document is written by
  this task (test R5).

### 5.1 Where badges are *not* added by this task

Dashboard, Accounts, Analytics, Budgets, Forecast, History, Calendar and Export are **not
edited here**. Badge data is exported as a pure helper from `src/lib/review-queue.ts` so those
surfaces can adopt it later without a second derivation. Adding it to them is a follow-up with
its own ownership, not a silent widening of this task.

---

## 6. Analytics presentation

`/flow`'s Insights content is not owned by this task. What this task adds is confined to the
review panel and the Flow drill-down:

- **Gross and net side by side, always.** A category line reads
  `$1,640.00 gross · $1,440.00 after refunds`. Never net alone — the governing rule is
  preserve both (`FIN-REVIEW-002.md:596-600`), and a net-only figure makes the ledger
  unauditable.
- **The Sankey is unchanged.** No new node, no new edge, no conservation change
  (FIN-REFUND-001 §7.1). The relationship renders as a **linked-pair affordance**: selecting
  either row highlights both endpoints through the existing trace machinery
  (`isNodeBright` / `isLinkBright`, `src/app/flow/page.tsx:267`, `:280`), and the drill-down
  table gains a "Refund of …" line.
- **The text alternative is updated in step.** `/flow` already carries a flow-as-a-table
  `<details>` (`src/app/flow/page.tsx:691-716`) because "the diagram is unreadable to a screen
  reader" (`src/app/flow/page.tsx:460-461`). Any relationship shown in the SVG must also appear
  there (`FIN-REVIEW-002.md:918-920`). Test A6.
- **Recovery totals** in the panel header: *"3 refunds matched this period · $1,215.00
  returned"*, and separately *"$240.00 potential annual duplicate cost"* — the second never
  added to the first, never presented as money recovered.

---

## 7. Confirmation UI

### 7.1 The gate

**Nothing applies before confirmation.** A parsed AI action (FIN-RELATION-001 §7) renders a
confirmation card and stops. This is the existing `RulePreviewCard` contract in
`src/components/DataChatSheet.tsx` — apply is gated on an explicit button press — and it is
preserved exactly. There is no "auto-apply high confidence" mode, no "apply all", no setting
that disables the gate, and no confidence at which the gate is skipped.

Before **Confirm** is enabled, the card shows:

1. **what changes** — in plain language, every allocation with its target;
2. **the money effect** — "this marks $1,200.00 of purchases as returned; your Shopping total
   for July falls from $1,640.00 to $440.00", or, for a duplicate, "this changes no total";
3. **what does not change** — "both transactions stay in your history at their full amounts";
4. **the scope** — this candidate only. Recovery confirmations never create merchant rules.
   A rule proposal, if the owner wants one, goes through FIN-REVIEW-002 §7's scope + affected
   count preview, unchanged.

### 7.2 Adjusting an allocation

The owner may edit allocated amounts before confirming. The editor:

- accepts dollars, stores **integer cents** via `toCents()` (`src/lib/flows.ts:8`), and
  displays through `formatMoneyCents()` (`src/lib/money.ts:15`);
- validates live against FIN-RELATION-001 §3.4 — positive integers, Σ ≤ the credit, each ≤ its
  purchase — and **disables Confirm with a stated reason** rather than clamping. "That is
  $50.00 more than the credit" is a sentence; a silently adjusted number is a lie;
- uses `<input type="number" inputMode="decimal">`, the native control, with a visible label.

An adjustment to an already-confirmed allocation writes a new link and marks the old one
`superseded` (FIN-RELATION-001 §3.6), so the audit trail survives.

### 7.3 After confirming

In order, matching `FIN-REVIEW-002.md:649-687`:

1. **persist** through the store — optimistic, `.catch`'d, never awaited into a hang;
2. **recompute** — the queue and the economics are `useMemo`s over the same inputs, so
   `buildFlowGraph()`'s existing memo (`src/app/flow/page.tsx:189`) recomputes for free;
3. **update counts** — the chips and the badge re-render in the same pass;
4. **remove from the queue** — a consequence of 3, not a separate mutation;
5. **announce** — one `aria-live="polite"` line: "Confirmed — $1,200.00 marked as returned.";
6. **offer one-step undo** while the panel stays open. Undo restores the previous candidate
   status and marks the created links `rejected` (never deletes them —
   FIN-RELATION-001 §6 denies delete). Undo is not offered after the panel closes; a stale undo
   is worse than none.

**Hard constraints:** no `window.location.reload()`, no `router.refresh()`, no full page
reload. **No in-place mutation** of any transaction, link or candidate object — new objects,
new arrays, functional `setState`. A `t.category = …` anywhere in this feature is a defect
(`FIN-REVIEW-002.md:681-685`).

---

## 8. AI discussion pane

One surface, reusing what exists. `DataChatSheet` (`src/components/DataChatSheet.tsx`) is
already the AI discussion component and already composes `Sheet`;
`docs/ux/PROPOSED-INFORMATION-ARCHITECTURE.md:84-86` names it "the seed of the Review tab's AI
discussion pane". The review panel embeds that component, passing a candidate context.

- Transport is the authenticated `aiChat` callable (`functions/src/chat.ts:23-27`), with
  auth rejection and `checkRateLimit(uid, 'aiChat', LIMITS.aiChat)`
  (`functions/src/rate-limit.ts:12-16`). `callableErrorMessage()`
  (`src/lib/callables.ts:33`) already maps `resource-exhausted` / `unauthenticated` /
  `unavailable` to owner-facing text. **No new route, no new callable, no public endpoint** —
  SEC-001 removed the two that existed and `src/__tests__/no-public-ai-routes.test.ts` pins it.
- Context is built by the capped builder (`src/lib/chat-actions.ts:58`, `MAX` at `:34`) and
  re-clipped server-side (`functions/src/prompts.ts:227`). **The full ledger is never sent.**
  For a recovery item the model receives: the candidate's ids and evidence, the ≤13 involved
  rows clipped, and account **type** rather than account name or number
  (`FIN-REVIEW-002.md:292-296`).
- Model output is untrusted and goes through the one parser (FIN-RELATION-001 §7.4). A
  rejected payload renders the raw text; it never renders a half-valid proposal.
- The thread is `role="log" aria-live="polite"`, as `DataChatSheet` already does.

---

## 9. Accessibility

Non-negotiable, and mostly already the house standard.

- **One dialog primitive on mobile**: `Sheet`, native `<dialog>` + `showModal()`, focus trap,
  Escape via `onCancel` with parent state as the source of truth
  (`src/components/Sheet.tsx:59`), focus restoration on close, backdrop click closes, iOS
  body-scroll lock preserved. No hand-rolled portal, no `role="dialog"` div.
- **Desktop panel** is a landmark `<section>` with a heading, keyboard reachable, visible
  focus.
- **44px minimum touch targets** on every actionable element — already the standard here
  (`min-h-[44px]` throughout `DataChatSheet`, and even the 12px Sankey nodes get an invisible
  44px hit rect, `src/app/flow/page.tsx:323-330`).
- **Keyboard**: Next/Previous are real buttons with labels; the card's decisions are buttons
  in DOM order; the allocation editor is a labelled native input; nothing is reachable by
  mouse only.
- **`aria-live="polite"`** for confirmation results and queue-count changes, announced once
  per action, never on every keystroke.
- **Colour never carries meaning alone** — every badge and state is text plus icon.
- **`prefers-reduced-motion`** respected; chart animation is already disabled on this page
  (`isAnimationActive={false}`).
- **Every chart affordance has a text alternative.** The flow-as-a-table `<details>`
  (`src/app/flow/page.tsx:691-716`) and the Sankey's descriptive `aria-label`
  (`src/app/flow/page.tsx:651`) both stay accurate as relationships are added.
- **The review badge is announced**, not merely painted:
  `aria-label="Flow, 7 items to review"` plus a live-region update on change
  (`docs/ux/PROPOSED-INFORMATION-ARCHITECTURE.md:270-273`).

---

## 10. Observability

Reuse OBS-001 (merged; `src/lib/obs/`). A page hook
`src/lib/obs/useRecoveryObservability.ts`, modelled on `useAccountsObservability.ts` per
`docs/observability/ADDING-A-TRACEABLE-FLOW.md:15-32`:

- continue the document's trace with `startTrace(documentTraceparent())` — never mint a fresh
  id when the server supplied one;
- emit `RecoveryReview.PageViewed` and `RecoveryReview.QueueOpened` on mount, **once**, not
  per render;
- `track*` callbacks for meaningful clicks only — no scrolls, no hovers, no keystrokes;
- publish `window.__OBS__` for Playwright;
- **call the hook above every early return** (`src/app/flow/page.tsx:581`).

| Event | Safe properties |
|---|---|
| `RecoveryReview.QueueOpened` | `recordCount`, `metadata.countsByType`, `route` |
| `RecoveryReview.ItemSelected` | `metadata.candidateType`, `metadata.queuePosition`, `metadata.state` |
| `RecoveryReview.AllocationEdited` | `metadata.allocationCount`, `metadata.validationRejected` (bool) |
| `RecoveryReview.UndoCompleted` | `metadata.undoneEventName`, `durationMs`, `resultStatus` |

The domain events (`Refund.*`, `CardCredit.Classified`, `DuplicateCharge.*`,
`DuplicateSubscription.*`, `DuplicateCandidate.*`, `Relation.*`) are emitted by the modules
that own them; this task emits none of them a second time. One namespace, one emitter.

**Never logged:** merchant strings, titles, descriptions, account names or numbers,
`lastFourDigits`, amounts as free values, the owner's typed message, the model's reply, the
AI context, or any transaction id unhashed (`hashId()`, `src/lib/obs/events.ts:73`).

---

## 11. Performance

- **Nothing generates in a render path.** Candidate generation is triggered by ingest
  completion, an explicit refresh, or the review tab's first open — never by a render, never
  by an unguarded effect.
- **Every derived structure is a `useMemo`** keyed on `[transactions, accounts, links,
  candidates, period]`, following the page's existing pattern
  (`src/app/flow/page.tsx:189-192`).
- **The queue is virtualized past 100 items.** Below that, plain rendering; a virtualizer for
  a 20-item list is complexity nobody asked for.
- **The link map is built once** (FIN-RELATION-001 §10) and shared by badges, cards and the
  drill-down. Badge lookup is O(1).
- **No full-ledger O(n²) on render.** The panel reads memoized results; it never scans.
- **Duplicate-subscription analysis is never per render** (FIN-DUPLICATE-001 §7).

---

## 12. Privacy

- **No production data is read, queried or accessed by this task.** No authenticated session
  is obtained. Any manual verification is the owner's, following
  `docs/features/REFUNDS-RETURNS-AND-DUPLICATES.md` §11, read-only.
- **No screenshot containing a live balance, merchant, account number or amount is ever
  committed** — not to the repo, not to `test-results/`, not to a CI artifact.
- Playwright coverage, if added, uses a fixture route under `src/app/dev/` with sanitized
  contexts. **Never sign in, never read live Firestore, never trigger a provider sync**
  (`docs/observability/ADDING-A-TRACEABLE-FLOW.md:110-120`) — "production is also the
  development environment".
- Every fixture is invented.

---

## 13. Test matrix — failing tests first

Jest + Testing Library, `npm test`. Component tests mirror
`src/__tests__/data-chat-sheet.test.tsx` and `src/__tests__/sheet.test.tsx`.

### 13.1 Queue and routing — `src/__tests__/recovery-queue.test.ts` (7)

| # | Test |
|---|---|
| Q1 | `?tab=review` renders the review surface; absent, unknown, `transactions` and `insights` all render today's Flow content unchanged |
| Q2 | the chip strip hides zero-count chips and shows "Nothing to review." when the queue is empty |
| Q3 | the state alignment table (§2.3) round-trips both ways: every FIN-REVIEW-002 state and every candidate status maps to exactly one queue state, and back |
| Q4 | ordering is deterministic across three shuffled inputs — `needs_attention` first, `needs_more_information` last, then score, then `generatedAt`, then key |
| Q5 | terminal-status items (`confirmed`, `dismissed`, `intentional`) never appear in the queue |
| Q6 | the count is the queue length, and the accessible name reads "Flow, N items to review" |
| Q7 | confirming an item updates the count in the same pass, with **no refetch** |

### 13.2 Cards — `src/__tests__/recovery-cards.test.tsx` (11)

| # | Test |
|---|---|
| C1 | the refund card shows the credit, every proposed purchase, every allocation, and the remainder in words |
| C2 | a combined refund shows **two** allocations totalling the credit exactly, and states "nothing left over" |
| C3 | a partial refund states the net: "You paid $1,100.00, got $900.00 back. Net cost $200.00." |
| C4 | an ambiguous candidate renders alternatives with **no pre-selection**, and Confirm is disabled until one is chosen |
| C5 | the duplicate card shows **both** series per account, never one collapsed row |
| C6 | the avoidable cost is labelled "Potential annual duplicate cost", the disclaimer is adjacent to the number, and the strings "savings", "you will save" and "guaranteed" appear nowhere in the rendered output |
| C7 | all five duplicate decisions are visible, none behind an overflow menu |
| C8 | the immediate-duplicate card states "Confirming this does not change any total" |
| C9 | the unknown-card-credit card renders its choices **from FIN-REFUND-001's exported list**, not a hand-written `<option>` list, and carries the "not income until you say what it is" line |
| C10 | a provisional dispute credit renders with the word "provisional" and never on a netted figure |
| C11 | reason text is plain language built from reason codes; **no bare score is rendered anywhere** |

### 13.3 Confirmation and editing — `src/__tests__/recovery-confirm.test.tsx` (8)

| # | Test |
|---|---|
| F1 | **no write occurs until Confirm is pressed** — a store spy records zero calls through render, selection, AI turn and proposal display |
| F2 | the confirmation card states what changes, the money effect, what does not change, and the scope |
| F3 | editing an allocation stores integer cents; entering `41.2` stores `4120` and never a float |
| F4 | an over-allocation **disables Confirm with a stated reason** and does not clamp the entered value |
| F5 | adjusting a confirmed allocation writes a new link and marks the old one `superseded` — nothing is deleted |
| F6 | after confirming: the queue count updates, the item leaves the list, and an `aria-live` line announces the result — with **no page reload and no `router.refresh()`** |
| F7 | undo restores the previous candidate status and marks the created links `rejected`, and is not offered after the panel closes |
| F8 | no transaction object is mutated in place — asserted by frozen fixtures |

### 13.4 Flow, badges and analytics — `src/__tests__/recovery-flow-view.test.tsx` (6)

| # | Test |
|---|---|
| A1 | **Flow conservation is unchanged** with confirmed links present — same nodes, same links, same cents as without them |
| A2 | selecting a linked row highlights both endpoints through the existing trace machinery, adding no node and no edge |
| A3 | the drill-down table gains a "Refund of …" line for a linked pair |
| A4 | badges render as text plus icon, never colour alone, and "Returned" appears only when confirmed links sum exactly to the purchase |
| A5 | gross and net are shown **side by side**; a net-only figure appears nowhere |
| A6 | **the flow-as-a-table text alternative reflects every relationship shown in the SVG** |

### 13.5 Accessibility and page integrity — `src/__tests__/recovery-a11y.test.tsx` (6)

| # | Test |
|---|---|
| R1 | **no hook-order violation** — the page renders unauthenticated and authenticated in one suite with no React error #310 and no hook warning |
| R2 | the mobile path uses the existing `Sheet`: native `<dialog>`, focus trap, Escape closes via `onCancel`, focus restored, backdrop closes |
| R3 | every actionable element meets the 44px minimum |
| R4 | the queue is fully keyboard operable; Next/Previous are labelled buttons; the allocation input has a visible label |
| R5 | **no transaction document is written by this task** — a Firestore spy records zero transaction writes across every interaction |
| R6 | `prefers-reduced-motion` is respected and chart animation stays disabled |

### 13.6 Programme cross-surface suite — `src/__tests__/recovery-cross-surface.test.ts` (12)

Owned here because this is the only task with every dependency merged. **One** sanitized
scenario — card purchase, card payment, exact refund, partial refund, combined refund, cashback
credit, unknown card credit, immediate duplicate charge, duplicate subscription across
accounts, intentional duplicate — asserted identically across **Dashboard, Accounts, Flow,
Analytics, Budgets, Forecast, History, Export and AI context**. The twelve assertions X1–X12
are enumerated in `docs/features/REFUNDS-RETURNS-AND-DUPLICATES.md` §13; the fixture is §11.3.
The pattern is `src/__tests__/cross-surface-consistency.test.ts` — one ledger, hand-computed
integer-cent truth, every surface checked against it.

**FIN-RECOVERY-UI-001 total: 50 specified tests** (38 + the 12-test cross-surface suite).

---

## 14. Ready to implement when…

### 14.1 Preconditions

1. **FIN-RELATION-001 has merged** — the link and candidate models, the store, the parser and
   the rules block. Hard blocker.
2. **FIN-REFUND-001 has merged** — `CardCreditKind`, the exported kind list the §4.4 card
   renders from, `PurchaseEconomics` and the refund statuses the badges read. Hard blocker for
   the refund card and every refund badge.
3. **FIN-DUPLICATE-001 has merged** — the duplicate candidates, the service-family labels and
   the avoidable-cost figure. Hard blocker for the duplicate card. If it has not, the review
   tab ships with refunds only and the duplicate card is added later; **the shell is not
   forked**.
4. **FIN-INCOME-001 has merged**, transitively (FIN-REFUND-001 depends on its taxonomy).
5. **The shell question is settled**: whether FIN-REVIEW-002 or this task builds the queue
   shell (§2.2). On current sequencing it is this task, because FIN-REVIEW-002 is hard-blocked
   (`FIN-REVIEW-002.md:1076-1085`). **Confirm before the first commit**, because two shells is
   the failure this whole section exists to prevent.
6. **The UX-IA task's tab decision is confirmed** — this task implements `?tab=review` and the
   `?tab=` read only, and does **not** perform the `/history`, `/analytics`, `/cashflow`,
   `/calendar` consolidation (§2.1). If UX-IA lands first, this task adopts its tab component
   instead of adding one.
7. **Badge placement in the app shell is assigned.** This task renders the count inside
   `/flow`. Wiring it into `Navbar.tsx` / `BottomNav.tsx` / `src/lib/nav.ts` belongs to
   whoever owns those files (§2.4).
8. **The owner has confirmed the card copy** — specifically the "not income until you say what
   it is" line (§4.4), the "potential annual duplicate cost" disclaimer (§4.3), and the
   "confirming this does not change any total" line on duplicate charges.
9. **The owner has confirmed that no confidence auto-confirms** and that all five duplicate
   decisions stay first-class (§4.3).
10. **The 38 tests in §13 are written first and are red.**
11. **A worktree exists** for the implementation branch, isolated from every other worktree in
    the programme.

### 14.2 File ownership — FIN-RECOVERY-UI-001 owns these exclusively

| File | New? |
|---|---|
| `src/app/flow/page.tsx` | **existing — SOLE OWNER for this programme** |
| `src/lib/review-queue.ts` | new — `ReviewQueueItem`, ordering, counts, badge helpers |
| `src/components/RecoveryReviewPanel.tsx` | new |
| `src/components/RefundCandidateCard.tsx` | new |
| `src/components/DuplicateCandidateCard.tsx` | new |
| `src/components/CardCreditCard.tsx` | new |
| `src/components/TransactionRelationBadge.tsx` | new |
| `src/lib/obs/useRecoveryObservability.ts` | new |
| `src/__tests__/recovery-queue.test.ts` | new |
| `src/__tests__/recovery-cards.test.tsx` | new |
| `src/__tests__/recovery-confirm.test.tsx` | new |
| `src/__tests__/recovery-flow-view.test.tsx` | new |
| `src/__tests__/recovery-a11y.test.tsx` | new |
| `src/__tests__/recovery-cross-surface.test.ts` | new — the programme's 12-test cross-surface suite |

### 14.3 Overlap warnings

- **`src/app/flow/page.tsx` — sole ownership is the point.** It is 902 lines, it is the
  programme's most contended file, and every other task in this set writes zero UI. If any
  other task needs a change there, it goes through this task.
- **FIN-RELATION-001** owns `src/lib/chat-actions.ts`, `functions/src/prompts.ts` and
  `firestore.rules`. This task writes none of them; it *consumes* the parser.
- **FIN-REFUND-001** owns `src/lib/card-credit.ts` and `src/lib/refunds.ts`;
  **FIN-DUPLICATE-001** owns `src/lib/duplicates.ts` and `src/lib/service-identity.ts`. This
  task imports all four read-only.
- **FIN-INCOME-001** owns `src/types/index.ts`, `src/lib/classify.ts`, `src/lib/forecast.ts`,
  `src/lib/firestore.ts`, `src/context/UserProfileContext.tsx`. This task reads them and
  writes none.
- **`src/components/DataChatSheet.tsx` and `src/components/Sheet.tsx`** — **composed, not
  edited.** If the discussion pane needs a prop `DataChatSheet` does not have, that is a small
  additive change to a file this task must claim explicitly before starting, because
  FIN-REVIEW-002 also plans to build on it (`FIN-REVIEW-002.md:790-793`).
- **`src/lib/nav.ts`, `Navbar.tsx`, `BottomNav.tsx`, `next.config`** — the UX-IA task's. Not
  touched here (§2.1, §2.4).
- **`src/lib/budgets.ts`, `src/lib/export-xlsx.ts`, `src/app/dashboard`, `src/app/accounts`** —
  not touched. Badge adoption there is a follow-up (§5.1).

### 14.4 Deferred — explicitly not in FIN-RECOVERY-UI-001

- The full IA consolidation: redirects, the four-tab shell, nav changes, the hamburger
  removal.
- Badges on Dashboard, Accounts, Analytics, Budgets, Forecast, History, Calendar and Export
  (§5.1).
- Bulk review ("confirm all 12"). One at a time.
- Multi-step undo. One step, panel-scoped.
- A dedicated Refunds or Subscriptions page. The review tab is the surface; if a standalone
  page proves needed, it is a separate, deliberate task.
- Charts of refund or duplicate history. Text and tables first; a chart with nothing to
  compare is decoration.
- Push notifications or email about a detected duplicate.
- Any surface that shows a "savings" figure.
- Playwright coverage beyond the sanitized fixture route, and any e2e run that signs in or
  touches live data.
