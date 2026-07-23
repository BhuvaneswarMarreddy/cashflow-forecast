# Flow page — money-trace audit (design spec)

Owner-approved 2026-07-23. Decisions locked with the owner:

- **Data**: current CSVs in `transactionsbyaccount/` (already loaded in Firestore as 2,914
  transactions). Known export gaps are **shown explicitly**, never hidden.
- **Visual**: Sankey diagram (recharts, already installed).
- **People**: top counterparties as named nodes; rest fold into "Others".
- **Placement**: new `/flow` page, nav item "Flow" after Cashflow.

## Purpose

Answer, visually and to the cent: *where did every dollar since 2024 come from, how did it
move between my accounts, where did it leave, and does it all add up to what I hold today
(net worth −$3,641.38)?* Plus: which payments recur (and cost how much per month), and
where the current run-rate puts net worth in 12 months.

## One honest deviation from the sketch

d3-sankey (what recharts wraps) rejects cyclic links, so **two opposite ribbons between
the same two accounts are impossible** (checking→savings→checking is a cycle). Worse,
the real data contains a 3-cycle even after netting each pair: net flows run
TOTAL CHECKING → BofA → Advantage Savings → TOTAL CHECKING. So:

- **Bank↔bank** moves route through a single hub node "⇄ between accounts": each bank
  gets ONE link to (net sender) or from (net receiver) the hub, sized by its net
  inter-bank position. Provably acyclic (each bank connects to the hub in exactly one
  direction). Hover shows the bank's gross both-ways totals.
- **Bank→card/loan** payments stay as direct ribbons (net per pair; the tooltip shows
  gross both directions, e.g. Upstart: `→ $21,622.45 paid · ← $16,110.00 disbursed`).
  In the rare case a card/loan pair nets backwards (card→bank), it routes via the hub.
- A **"Between your accounts" matrix** directly below the Sankey lists every account
  pair, gross both directions, to the cent. Nothing is lost, only the drawing is acyclic.
- **People appear as split nodes** — "from NAME" on the source side, "to NAME" on the
  destination side — because one node doing both would also create cycles.

## Architecture

### New: `src/lib/flows.ts` — pure functions, all money in integer cents

```
buildFlowGraph(transactions, accounts, period) -> { nodes, links, reconciliation, betweenAccounts }
detectRecurring(transactions, today) -> RecurringItem[]
projectNetWorth(transactions, accounts, months) -> { points, monthlyRate }
periodStartBalance(account, transactions, periodStart) -> cents   // roll back from real balance
```

Reuses existing code — no new logic where it already lives: `matchTransfers`
(`src/lib/transfers.ts`) for account↔account legs, `classifyTransaction` / `isPositive` /
`isReward` (`src/lib/classify.ts`), `displayCategory` (`src/types`). `CAT_COLORS` moves
out of `src/app/cashflow/page.tsx` into a shared `src/lib/palette.ts` (cashflow page
imports from there; only extraction, no color changes yet).

### Sankey columns (left → right)

1. **Sources**: Paychecks · Other income · Refunds · Rewards · Loan disbursement
   (Upstart $16,110) · one node per top-5 person (money received) · "Others (people)" ·
   "Opening balance" (see reconciliation).
2. **Bank accounts**: the 4 banks. Income rows land on the bank of their `accountId`.
3. **Cards & loans** (pass-through): 5 cards + Upstart + Mercedes. Bank→card ribbons are
   the matched card payments; card→category ribbons are the purchases. A card's period
   imbalance (payments ≠ purchases) renders as a stub: "debt ↑/↓ $X".
4. **Destinations**: spending category groups (same grouping as cashflow page, top N +
   Other) · one node per top-5 person (money sent) · "Others (people)" ·
   "Missing from export ⚠" stubs · "Balance kept" stubs (Δbalance of each bank).

Self-Zelle (counterparty name matches BHUVANESWAR/MARREDDY in `description`) is never a
person-flow: if `matchTransfers` pairs it → normal bank↔bank ribbon; if unpaired → a
"Self transfers (unpaired)" node, not People.

### Reconciliation — the audit guarantee

Per account: `implied opening = real balance now − CSV net change`. Real balances are the
user-entered ones (Monarch 2026-07-23: cash $4,907.02, card debt $8,548.40, net worth
−$3,641.38). Verdicts are data-driven, computed per account (a checking account cannot
have a negative opening): plausible → "Opening balance" source node; impossible →
"Missing from export ⚠" node with the exact amount. Current values (whole history, from
`CSV_GROUND_TRUTH.md` §9, must be recomputed in Phase 0, not trusted):

| Account | Implied opening | Verdict |
|---|---|---|
| Adv SafeBalance / BofA | −$4,832.95 | ⚠ missing rows |
| TOTAL CHECKING | −$3,830.00 | ⚠ missing rows |
| Customized Cash Visa | −$2,117.31 | ⚠ missing rows |
| CHASE SAVINGS | $2,100.00 | opening balance |
| Advantage Savings | $4.20 | opening balance |
| Discover | $10.67 | opening balance |
| Blue Cash Preferred | $1,541.20 | pre-export debt |
| Amazon Store Card | $2,168.70 | pre-export debt |
| Apple Card | $1,885.30 | pre-export debt |

The page shows this as a "Does it add up?" table: opening + in − out = computed now vs
real now, difference highlighted red. Totals row must tie to **−$3,641.38 exactly**; a
unit test enforces the conservation identity (every node: inflow = outflow + stub) so the
build fails if the graph ever leaks a cent.

For sub-periods (e.g. "2026"), the period-start balance is exact, not guessed:
`real balance now − net of transactions after period start`. The missing-rows problem
only contaminates the whole-history view, where it is shown as the ⚠ node.

### Recurring payments

`detectRecurring`: group expenses (excluding transfers/card payments) by normalized
merchant; cadence by median date-gap (6–8d weekly · 12–16d biweekly · 26–35d monthly ·
80–100d quarterly · 350–380d yearly); amount stability MAD ≤ 25% of median; `active` =
last seen ≤ 45 days ago. Four rules added after an adversarial verification pass over
the real CSVs caught failure modes:

1. **Dedupe same-day charges** before computing gaps (a Perplexity double-charge made
   n=3 look "biweekly" and inflated its monthly cost 2×). ≥ 3 *unique* dates required.
2. **≥ 60% of gaps must fall inside the cadence band** — a bare median is spoofable:
   QuikTrip gas (gaps 572/86/13/22/29d) medians to "monthly" but is ad-hoc fuel.
3. **Median amount ≥ $5** (kills a $0.01×3 payroll artifact).
4. Merchant normalization strips only **trailing** digit runs and `#…`/`*…` suffixes —
   never leading digits ("650 Industries" is the Expo subscription's real name).

UI: table sorted by monthly cost (merchant, cadence, median amount, cost/mo, last seen,
active/lapsed badge) + tile "recurring costs $X/mo".

Verified anchors the implementation must reproduce (whole history, from the CSV brute
force + independent adversarial recheck):

| Merchant | Cadence | Median | Occurrences | Last seen | Active |
|---|---|---|---|---|---|
| UPSTART | monthly | $900.00 | 21 | 2026-01-23 | no |
| MERCEDES-BENZ | monthly | $836.90 | 5 | 2026-04-28 | no |
| VERIZON | monthly | $499.94 | 19 | 2026-07-10 | yes |
| COMCAST | monthly | $55.28 | 26 | 2026-07-14 | yes |
| OPENAI | monthly | $20.00 | 12 | 2026-07-14 | yes |
| ADOBE | monthly | ~$7.34 | 15 | 2026-07-09 | yes |

QUIKTRIP and FEDERAL WITHHOLDING must NOT appear (rules 2 and 3). Known borderline
exclusions (correct to exclude): CURSOR (amount varies), USHEALTH GROUP / INTEREST
CHARGE (17–20d gaps fall between the biweekly and monthly bands), CINEMARK / GREAT
CLIPS (~44d gaps). Habit spending that mechanically qualifies (e.g. WHATABURGER
~$15.73/mo) stays in the list — surfacing "unnecessary recurring spend" is the point;
the owner judges.

### Projection — "at this rate"

Monthly rate = mean of the trailing 6 full calendar months of (income − expenses − net
sent to people) from the flow data. Line chart from real net worth today, 12 months
forward, with a headline tile "at this rate: $X by 2027-07". Reuses recharts LineChart
like the forecast page. No scenario toggles (YAGNI).

### People nodes (top counterparties, from CSV brute force)

463 person-movement rows exist across the 9 CSVs: 182 are self-transfers between the
owner's own accounts, 281 involve 79 distinct real counterparties. Independently
verified whole-history totals the implementation must reproduce (±$1):

| Counterparty | Sent to | Received from | Rows |
|---|---|---|---|
| Sent to India (Remitly — no payee name in statements) | $120,562.36 | $0 | 78 |
| Sridevi Gogineni | $18,612.00 | $0 | 8 |
| Lok Pulukuri | $2,380.00 | $17,788.00 | 21 |
| Rishikesh Katta | $0 | $11,064.00 | 10 |
| Venu Guntupalli | $2,500.00 | $9,857.50 | 20 |
| Mallikarjuna Muddana | $3,000.00 | $5,550.00 | 9 |
| **Self-transfers (own name / "to Me")** | **$84,902.65** | **$81,795.65** | **182** |

Grand non-self totals: sent **$183,892.36**, received **$93,612.28**. Remitly gets its
own permanent node ("Sent to India"); the top-5 *named people* nodes are computed
per-period by sent+received volume, everyone else folds into "Others (people)".

Name handling rules (all discovered in the real data): extract the payee from
`description` (Original Statement) for the patterns `Zelle payment to/from NAME Conf#…`,
`Zelle payment to NAME JPM…`, and BofA's `Zelle Transfer Conf# X; NAME`; canonicalize
3+-word names to FIRST + LAST ("Venu Gopal Guntupalli" = "Venu Guntupalli"); strip memo
suffixes (`for "RENT"` etc.). Self = name contains BHUVANESWAR or MARREDDY, or is
literally "Me" (Chase writes "Zelle payment to Me" for own-account moves). Rows whose
counterparty can't be parsed stay in their category bucket — never dropped.

### Page layout, top to bottom

1. Filter row: period selector (All time · 2024 · 2025 · 2026 · Last 12 months).
2. Sankey + legend (nodes ≥ 2 groups ⇒ legend present; direct labels on the big nodes).
3. "Does it add up?" reconciliation table with verdict badges.
4. "Between your accounts" gross matrix.
5. Recurring payments table + monthly-cost tile.
6. Projection chart + tile.

### Color

Sankey nodes get categorical colors from `src/lib/palette.ts` by node *kind* (banks /
cards / loans / people / categories / warning stubs), assigned in fixed order, never
cycled. The ⚠ missing-data stub uses the reserved warning status color with an icon +
label, never color alone. The final palette is validated with the dataviz skill's
`validate_palette.js` in both light and dark modes before shipping; a FAIL blocks.

### Error handling

- Empty period → empty-state card, not a crashed chart.
- Unknown/dangling `accountId` rows → grouped under "Unlinked" node (never dropped).
- All amounts flow as integer cents; render via the shared `money()` formatter.

### Testing

`src/__tests__/flows.test.ts`:
- Conservation identity on a synthetic fixture (in = out + stub for every node, exact cents).
- Missing-rows fixture produces the exact gap node amount.
- Period-start rollback math.
- Recurring detector: monthly fixture detected; ad-hoc shopping rejected; lapsed flagged.
- Projection arithmetic.

Phase 0 of the implementation plan re-derives all ground-truth numbers from the CSVs in a
loop and diffs against `CSV_GROUND_TRUTH.md` + the tables in this spec before any UI work
(the owner's "run the scenarios in loops before confirming" rule).

## Known caveats carried in, deliberately

- Carvana payoff on Mercedes is a **$5,000 / 2026-05-15 placeholder** — it will show at
  that value in the Sankey until the owner supplies exact figures.
- The 7 "Zelle … for upstart" self-funding inflows are still typed income (see
  `DATA_CHANGES.md`); they will appear as people-inflows unless the self-name match
  catches them. Acceptable; revisit only if they distort the People column.
