# Pending-inclusion policy, calculation consistency, and Account Details

**Date:** 2026-08-08
**Status:** design — awaiting approval
**Scope note:** the brief covers twelve parts. Parts 1–4 are one coherent change and are
specified here in full. Parts 5–10 are separate features that each need their own spec;
they are decomposed into issues at the end rather than folded into this one.

---

## 1. Current-state findings

### 1.1 The architecture is better than the symptom suggests

There is already a single interpretation layer. `interpretTransaction()` in
`src/lib/classify.ts` is the one place that decides what a row *means*
(`internal_transfer`, `card_payment`, `refund`, `earned_income`, `spending`, …) and what
it *counts toward* — it returns `income`, `expense`, `forecast` and `budget` treatments
as `'counted' | 'excluded'`. `sumIncomeCents` / `sumExpenseCents` are thin wrappers over
it. Card payments are already excluded from spending, transfers already excluded from
both sides, refunds already net against spending.

So Part 2's `FinancialCalculationContext` does not need to be built. It exists. What it
lacks is the pending dimension, and it has leaks around it.

### 1.2 Where pending is decided today — ten sites, three kinds

| # | Site | Kind | Honours a setting today? |
|---|---|---|---|
| 1 | `classify.ts:378` → `held` | **central** — gates income, expense, budget, money-roles | no, hard-coded |
| 2 | `forecast.ts:132` `deriveAccountBalance` | **central** — every account balance | yes (flag added 2026-08-07) |
| 3 | `forecast.ts:74` | recurrence detection for the forecast | no |
| 4 | `forecast.ts:405` | behaviour projections | no |
| 5 | `flows.ts:113` | Flow Sankey window | no |
| 6 | `flow-lanes.ts:162` | Flow lanes | no |
| 7 | `flow-netting.ts:56` | Flow netting | no |
| 8 | `refunds.ts:335` | refund matching | no |
| 9 | `bills.ts:180` | bill matcher (`t.pending` → never matches) | no |
| 10 | `review-queue.ts:609` | review queue | no |
| — | `export-xlsx.ts:68,109,133` | prints "Pending (not in the totals above)" | must stay honest |

Sites 1 and 2 are the ones the user sees. Sites 3–10 are independent `isPosted` filters
that each re-decide the question locally — this is the duplication the brief asks about.

### 1.3 A leak in the other direction

`detectRecurring()` (`flows.ts:505`) does **not** filter `isPosted`. Pending rows already
feed subscription detection today, while they are excluded from every total. So the app
is already inconsistent about pending — in both directions at once.

### 1.4 Duplicate headline-number logic

`calculateCurrentCash()` (`forecast.ts:105`) filters `bank_account | debit_card | cash`
and reduces `currentOf`. `accounts/page.tsx:386` does the same filter and the same reduce
inline, as `totalBankBalance`. Two copies of one definition:

- Dashboard (`dashboard/page.tsx:113,128`) and Forecast (`forecast/page.tsx:173,209`) use
  the shared helper.
- Accounts uses its own copy.

They agreed until 2026-08-07, when the Accounts page gained an `includePending` flag the
other two do not have. **That is the exact mechanism of the reported inconsistency**: not
a rounding drift, but one screen passing a parameter its siblings cannot see.

`netWorth` is defined only on Accounts (`totalBankBalance - totalDebt`). Nowhere else
computes it, so there is no divergence to fix — but it also means the definition is not
shared and will drift the moment a second screen wants it.

### 1.5 Plaid pending lifecycle

`functions-sync/plaid_ingest.py` writes holds under a `pending_pl_<id>` doc id, refreshes
them each run, and deletes them set-wise (`stale_pending`, line 509). Posted rows land
under `pl_<id>`. Removal is honoured from Plaid's `removed` list as well.

Two gaps:

- **`pending_transaction_id` is never captured.** Plaid returns it on the posted
  transaction that replaces a hold. It is the explicit linkage the brief asks for, and the
  ingest currently discards it. Without it, any client-side twin detection would fall back
  to amount+date matching, which is precisely the fragile approach the brief rules out.
- **The set-based delete assumes a full pending set, but the fetch is a cursor delta.**
  `/transactions/sync` reports a still-pending transaction once, not on every run.
  `pending_seen` therefore holds only holds present in *this* delta, while `existing_ids`
  covers every doc within `MATCH_DAYS`(=3) of any fetched row. Reading the code, a delta
  carrying any recent posted row can delete live pending docs that were simply not
  re-reported.

  **This is a hypothesis from code reading, not an observed failure.** All 7 holds
  currently in the ledger were still intact on re-check 2026-08-08, so the path has not
  been caught firing. It needs a targeted test before any claim is made about it — but it
  must be resolved before pending-inclusion ships, because under the new mode a
  disappearing hold silently moves the headline balance.

### 1.6 Recurring / subscription classification (Part 7 — confirms the brief)

`detectRecurring()` is a pure heuristic: ≥3 distinct dates, median ≥ $5, amount stability
within 25%, a cadence band, ≥60% of gaps in band. It emits a `confidence` score.
`SubscriptionsPanel` renders the output under the heading **"Active subscriptions"** with
no confirmation step. There is no lifecycle state — nothing distinguishes detected from
suggested from confirmed, and nothing distinguishes a subscription (Netflix) from a
recurring bill (electric) from an obligation (loan). The brief's diagnosis is correct.

Note this is separate from `bills.ts`, which is an owner-declared register with explicit
matchers. Two systems describe overlapping concepts and do not talk to each other.

---

## 2. Proposed architecture

### 2.1 Extend the seam that already exists — do not add a parallel one

`IncomeContext` is already constructed once in `UserProfileContext` and threaded into
every calculation that needs owner intent. Widen it rather than introducing a second
context object:

```ts
/** Owner intent, resolved once and threaded everywhere. */
export interface FinancialPolicy {
  sources?: IncomeSource[];                    // existing
  reviews?: Record<string, InflowReview>;      // existing
  /** FIN-PENDING-001: treat holds as effective activity. Never mutates stored state. */
  includePending?: boolean;                    // new
}

/** @deprecated name kept so no call site has to change. */
export type IncomeContext = FinancialPolicy;
```

One line in `UserProfileContext` populates it:

```ts
const incomeContext = useMemo<FinancialPolicy>(
  () => ({
    sources: profile?.incomeSources ?? [],
    reviews: inflowReviews,
    includePending: profile?.settings?.includePendingInCalculations ?? false,
  }),
  [profile?.incomeSources, inflowReviews, profile?.settings?.includePendingInCalculations]
);
```

Every screen that already passes `incomeContext` inherits the setting with no edit. That
is the whole point of choosing this seam.

### 2.2 The central gate

`classify.ts` — one expression changes:

```ts
const held = pending === 'pending' && !income?.includePending;
```

This alone makes income, spending, budgets and money-roles agree with the setting, on
every screen, because they all read `interpretTransaction`.

### 2.3 Balances

`deriveAccountBalance` / `withDerivedBalances` take the policy instead of the bare boolean
added on 2026-08-07, so there is one parameter type rather than two conventions.

### 2.4 Each remaining gate makes an explicit, documented decision

| Site | Decision |
|---|---|
| `forecast.ts` baseline, `flows.ts`, `flow-lanes`, `flow-netting`, `refunds` | honour the policy |
| `forecast.ts:74,405` recurrence + behaviour, `detectRecurring` | **posted only, always** — a $1 gas pre-auth must never seed a recurring bill, and averages must not wobble daily on transient rows |
| `review-queue.ts` | posted only — reviewing a hold that may change amount wastes the owner's decision |
| `export-xlsx.ts` | keeps its explicit pending column; the summary label becomes mode-aware rather than a fixed claim |
| `bills.ts:180` | posted only — a bill is paid when it is paid |

The asymmetry is deliberate and is the answer to "how far does the setting reach":
**state, yes; pattern inference, no.**

### 2.5 Duplication removal

Delete the inline `totalBankBalance` on Accounts; call `calculateCurrentCash`. Move
`netWorth` into `src/lib/accounts.ts` beside `currentOf` so one definition serves any
screen that later wants it.

### 2.6 Double-count safety

1. **Ingest** (`plaid_ingest.py`): capture `pending_transaction_id` onto the posted row as
   `pendingTransactionId`, and record `plPendingId` on hold docs.
2. **Read side**: when `includePending` is on, drop any hold whose id is referenced by a
   posted row's `pendingTransactionId`. Explicit linkage only — no amount matching.
3. **Fallback** (linkage absent, e.g. SimpleFIN history): keep the hold, and surface the
   suspected twin in the existing duplicate-candidate flow rather than guessing silently.
   Documented confidence: low; owner decides.
4. **Over-deletion**: bound `stale_pending` to holds Plaid actually re-reported in a
   window it covers, rather than every hold inside `MATCH_DAYS` of any fetched row.

### 2.7 What the setting must never do

- Never write `pending: false`. Storage keeps provider truth; the policy is a read-time
  interpretation. This preserves auditability and lets the toggle flip back losslessly.
- Never remove the `Pending` badge. Rows stay marked regardless of mode — shipped
  2026-08-07 and retained.

---

## 3. Files to modify (Parts 1–4 only)

| File | Change |
|---|---|
| `src/types/index.ts` | `settings.includePendingInCalculations?: boolean` |
| `src/lib/classify.ts` | `FinancialPolicy`, `IncomeContext` alias, `held` expression |
| `src/lib/forecast.ts` | policy param on balance derivation; gates 3–4 stay posted-only with comments |
| `src/lib/flows.ts`, `flow-lanes.ts`, `flow-netting.ts`, `refunds.ts` | honour policy |
| `src/lib/bills.ts`, `review-queue.ts`, `export-xlsx.ts` | documented posted-only / mode-aware label |
| `src/lib/accounts.ts` | `netWorthOf()` |
| `src/context/UserProfileContext.tsx` | populate `includePending` |
| `src/app/settings/page.tsx` | Financial Calculations section + toggle |
| `src/app/accounts/page.tsx` | remove local checkbox; use shared helpers |
| `functions-sync/plaid_ingest.py` | capture linkage; bound stale-pending deletion |

---

## 4. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Anchor double-count.** Balances are `openingBalance` (re-anchored from the provider's *posted* balance) + net of rows. If a provider's reported balance already nets a hold, adding it again double-counts. | Verify per provider against `balance_is_trustworthy`; test with a known account before enabling by default. Highest-severity risk in this change. |
| R2 | Holds post at different amounts (tips, gas pre-auth). "Effective" balance is an estimate, not a promise. | UI wording says projected, never settled; badge retained. |
| R3 | Hold deleted while still live (§1.5). Balance silently drops. | Fix ingest before shipping the mode; add a regression test. |
| R4 | Pending + posted twin both counted during transition. | Explicit `pending_transaction_id` linkage (§2.6). |
| R5 | Owner forgets the mode is on and misreads a number weeks later. | Persistent mode indicator wherever an effective balance is shown, not only in Settings. |
| R6 | Turning the setting on rewrites the *appearance* of history. | Pattern inference stays posted-only (§2.4), so trends and detections do not move. |

---

## 5. Test plan

Invariant under test: **for a given user, dataset and setting, every screen reports the
same effective financial state.**

1. Setting OFF — totals identical to today (regression guard on all 1262 existing tests).
2. Setting ON — pending inflow raises balance and income.
3. Setting ON — pending outflow lowers balance and spending.
4. Pending replaced by posted twin (explicit linkage) — counted once, both modes.
5. Pending replaced by posted twin at a *different amount* — posted wins.
6. Pending cancelled/removed — disappears, no residue.
7. Internal transfer pending — moves neither income nor spending, either mode.
8. Card payment pending — never income, never spending, either mode.
9. Refund pending — offsets spending only when the mode is on.
10. Account-scoped totals equal the sum of that account's rows under the policy.
11. Forecast opening balance equals Accounts' balance, both modes.
12. Net worth equals bank − debt from the same policy, both modes.
13. **Cross-screen**: Accounts, Dashboard and Forecast agree on cash, both modes.
14. Setting persists across logout/login and refresh.
15. Recurrence detection output is *identical* in both modes (proves §2.4's asymmetry).

---

## 6. Decomposition into issues

**This change (Parts 1–4):**

- `PEND-001` Financial policy seam — `FinancialPolicy`, central `held` gate, balances
- `PEND-002` Settings toggle, persistence, remove the Accounts checkbox
- `PEND-003` Reconcile the remaining eight pending gates; delete duplicated headline math
- `PEND-004` Plaid pending lifecycle — capture linkage, bound stale deletion, twin guard
- `PEND-005` Cross-screen consistency invariant tests

**Separate specs (Parts 5–10):**

- `ACCT-001` Account Details view — header, period summary, chart, scoped transactions,
  type-specific panels
- `ACCT-002` Accounts summary-card information architecture
- `REC-001` Recurring / subscription lifecycle classification
- `BUD-001` Budget model — separate income, obligations, debt, savings, spending
- `DEBT-001` Intelligent cash allocation ("I have an extra $X")
- `EXPL-001` Explainability and provenance for derived numbers

**Order:** PEND-004 first (data integrity underneath everything), then PEND-001 →
PEND-002 → PEND-003 → PEND-005. ACCT-001 after the policy lands, so Account Details is
built on the shared rules rather than inventing its own.
