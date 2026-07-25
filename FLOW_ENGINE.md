# 🔀 Flow Engine — How a Dollar Flows Through the App

The Flow page (`/flow`) and the money-tracing pipeline behind it are the heart of the app.
They answer: *where did every dollar since 2024 come from, how did it move between my
accounts, where did it leave, and does it all add up to what I hold today?*

← Back to [README](README.md) · see also [ARCHITECTURE.md](ARCHITECTURE.md)

---

## The pipeline, stage by stage

```
Monarch CSVs ──▶ import & de-dupe ──▶ classify ──▶ pair transfers ──▶ reconcile ──▶ visualize
 (per account)    CSVImportModal      classify.ts    transfers.ts     flows.ts      /flow page
```

### 1. Import — `src/components/CSVImportModal.tsx`
Native Monarch CSV parsing via `xlsx` (handles quoted commas, embedded newlines, `®`, and
the `…,Tags,Owner` header). Each row gets a **deterministic id** —
`imp_` + `date|signedAmount|last4|statement|occurrence` — so re-importing the cumulative
export **overwrites instead of duplicating**. You can re-upload your full export every
month safely. Accounts are auto-created from the `Account` column.

### 2. Classify — `src/lib/classify.ts`
One shared classifier assigns every row a `type: 'income' | 'expense' | 'transfer'`:
- A Monarch `Transfer` / `Credit Card Payment`, or a payment-shaped inflow landing **on a
  card**, becomes a **transfer** — never counted as income or spending.
- `isPositive(t, accounts)` decides the sign for the account the row sits on (a card
  payment reduces debt, so it shows positive on the card).
- `isReward(t)` surfaces card rewards/cashback distinct from refunds.

Rule order is load-bearing — there is a test for it; don't reorder without a failing test.

### 3. Pair transfers — `src/lib/transfers.ts`
`matchTransfers(transactions, accounts, windowDays = 4)` matches the two legs of every
internal move (opposite amount, ≤ 4 days apart, different accounts):
- **Matched pairs** = money moving **between your own accounts**, net zero.
- **Unmatched legs** = the signal that the other side is external (a person, a loan
  servicer, an untracked account) — surfaced, never hidden.

This leg-matching is the feature Monarch itself lacks.

### 4. Reconcile + build the graph — `src/lib/flows.ts` (integer cents throughout)
`buildFlowGraph(transactions, accounts, period?)` returns the Sankey `{nodes, links}`, a
per-account `reconciliation`, and a gross `between`-accounts matrix.

- **Reconciliation:** `opening = today's real balance − net of this period`. A bank
  account can't have a negative opening, so an impossible one means the **export is
  missing rows** — rendered as a red **⚠ "Missing from export"** node with the exact gap,
  never silently absorbed.
- **Acyclic by construction:** bank↔bank moves route through one **"⇄ between accounts"
  hub** node, because the real data contains a bank cycle (checking → savings → checking)
  that a Sankey — a DAG — can't draw. People are split into `from`/`to` nodes for the
  same reason.
- **Conservation:** a unit-tested identity guarantees every intermediate node's inflow
  equals its outflow. The graph never leaks a cent, and the reconciliation total ties to
  net worth **exactly**.

Also in `flows.ts`: `detectRecurring` (cadence + amount-stability with four
adversarially-derived guard rules), `projectNetWorth` (trailing-6-month run rate), and the
`personFrom` / `isSelfPerson` counterparty parser (Zelle/Remitly statement shapes,
including Chase's `NAME BACxxxx` form and self-transfers to "Me").

### 5. Visualize — `src/app/flow/page.tsx`
Three views of the **same** links, toggleable:

- **Flow** — the Sankey. Click an income source to trace it **end-to-end** (downstream +
  upstream, strict on-path highlighting so bypass edges stay dim); hover for a one-hop
  peek; kind chips (Banks / Cards / Loans / People / Spending / Income / ⚠ Gaps);
  maximize/minimize; a monthly ◀ ▶ stepper.
- **Where it went** — a treemap sized by dollars; the view non-technical viewers read
  instantly.
- **Step by step** — a waterfall that subtracts each destination and lands on exactly
  **$0** — the on-screen proof that every dollar is accounted for.

Plus a recurring-payment table, a 12-month net-worth projection, the gross
between-accounts matrix, and plain-language headline tiles. **Refunds count as reduced
spending, never as income.**

---

## Trust the balance, not the flow

Because CSV exports drop rows, **user-entered account balances are the source of truth**
(they match Monarch to the cent); the CSVs are authoritative for *flows* only.

> "Actually kept" is a **flow** (a change over a period), not a **balance**. The money you
> *have* is your **net worth** — shown on the reconciliation table, not any single "kept"
> figure. For anyone with large two-way transfers (e.g. family remittances), the
> balance-sheet number is the honest one.

---

## Verification — the "run it in loops" guarantee

- **`scripts/verify_flow_groundtruth.py`** re-derives every audited number straight from
  the raw CSVs and exits non-zero on any drift: per-account row counts and net change, the
  top counterparties, self-transfer totals, and recurring anchors.
- **`src/__tests__/flows.integration.test.ts`** replays **all real CSVs through the engine
  on every `npm test`**, asserting: the reconciliation to the cent, global conservation,
  DAG-ness (the sankey has no cycle), the audited people totals (±$1), and recurring
  detection — all against **frozen** ground truth. When a check fails, fix the code or
  your understanding; never the target.

---

## Ship safety

Deploys go through **`npm run deploy`**, which gates on **tsc + the full jest suite + a
React-hooks crash-rule scan** before `firebase deploy` — added after a conditional-hook
bug once shipped a white screen. Admin data ops (backup / purge / reclassify) live in
`scripts/fsadmin.py` and always take a backup before a destructive step. See
[CONTRIBUTING.md](CONTRIBUTING.md) for details.
