# Bills v1.1 — merchant drill-down and target-vs-actual (BILLS-002)

**Date:** 2026-08-07 · **Status:** approved by owner (conversation), built same day

## Problem

After one day of real use the owner hit two walls:

1. **"What in the heck is to do or done? These are transactions, right?"** —
   the migration-workflow labels (To do / Done) read as a transaction list,
   and "Fixed bills" became wrong the moment variable "(average)" rows joined
   the register.
2. **"On click on it, I would refer those merchants... this is kinda vague"** —
   the average rows are opaque numbers. The owner edited them into *targets*
   (Amazon $442 actual → $100 target) and needs to see the actual merchants
   and run rate behind each target to hold the line.

## Design

**Renames.** Header "Fixed bills" → "Recurring bills". Filters "To do/Done" →
"Autopay to-do / Autopay done". No behavior change.

**`BillMatcher`** (optional field on Bill): `{ categories?, merchants?,
excludeMerchants?, excludeOver? }`, rules AND together. Matches settled
income/expense rows only — transfers and pending holds never count.
`excludeOver` drops one-off purchases (the $2,271 lens) from run rate.

**`spendBreakdown(matcher, transactions, today)`** (pure, tested): last 3
FULL months windowed by calendar month; expenses add, income rows subtract as
refunds EXCEPT titles matching /no details/i (store-card payment credits, not
refunds); current month reported separately ("Aug so far"); per-merchant net
monthly, descending, title fallback when merchant is absent.

**UI.** Rows with a matcher show `actual $X/mo` under the target (amber when
over) and expand in place on tap (chevron button carries the a11y contract;
row-body click is convenience; inner link/status controls stopPropagation).
The panel shows target vs actual, top-8 merchants with bars + "N others",
and the month trend line. Transactions come from the already-loaded
TransactionContext — zero extra Firestore reads. Fixture routes inject
`initialTransactions` the same way they inject `initialBills`.

**Data migration.** The six live "(average)" rows get their matcher via a
one-time REST PATCH (updateMask=matcher) after deploy. firestore.rules needs
no change: the bills match block validates required keys; `matcher` is an
optional map and update rules evaluate the merged document.

## Rejected alternatives

- Per-category analytics screen — more taps, new route, duplicates /analytics.
- Monthly script refreshing remark text — stale, not interactive.

## Acceptance

- 6 new unit tests green (matcher rules, windowing, refund netting,
  no-details guard, merchant ranking, title fallback); suite total 1,079.
- Fixture screenshots verified by hand-math (Groceries $368.33 actual,
  Amazon $102.67 with one-off excluded and refund netted).
