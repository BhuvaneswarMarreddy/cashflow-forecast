# Data change log — marreddy-cashflow (uid 7hjLW3…)

Every direct DB change, so nothing is a mystery later. All writes go via Firestore
`:commit`; each destructive step takes a backup first (`scripts/backups/`).

## 2026-07-23 — Full clean reload from CSVs + screenshots
- Purged all data; reloaded **2,913 transactions** from the 9 CSVs in `transactionsbyaccount/`
  (Discover added by the owner mid-session), 0 unlinked, deterministic `imp_` ids.
- Created **9 accounts** with real balances from the Monarch screenshots:
  - Cash (banks): TOTAL CHECKING $829.60 · Adv SafeBalance/BofA $1,430.93 · Advantage Savings
    $45.52 · CHASE SAVINGS $2,600.97 → **cash $4,907.02** (matches Monarch)
  - Cards (debt): Visa $2,656.09 · Blue Cash $507.96 · Amazon $3,308.57 · Apple $2,068.93 ·
    Discover $6.85 → **card debt $8,548.40** (matches Monarch)
  - **Net worth −$3,641.38**
- Cleanup rules applied at load: Monarch Transfer/Credit Card Payment → transfer;
  payment-shaped inflows on a card → transfer; refunds kept as income; category mapping.
- Snapshot before purge: `scripts/backups/pre_reload_snapshot.json`.

## 2026-07-23 — Phantom card-payment income fix (pre-reload, now baked into the reload)
- 31 income-typed rows sitting ON a credit card reclassified to transfer (payment-shaped +
  AI-confirmed); genuine refunds kept as income. Backup: `…_cardfix.json`.
- Code: `classify.ts` payment regex widened (`pymt|pmt|epay`) so future imports auto-handle.

## 2026-07-23 — Upstart loan cleaned up + closed
- Created **Upstart Loan** account (`personal_loan`), then set **CLOSED** (`isActive=false`,
  balance $0 — loan is paid off: borrowed $16,110 on 2024-08-16, repaid $21,622.45 total,
  ~$5,512 cost above principal).
- Reclassified **22 Upstart rows** on BofA checking to **transfers** (they were distorting cashflow):
  - +$16,110 disbursement (was **income**) → transfer in — it's borrowed money, not income
  - 21 payments (was **expense**) → transfer out — settling debt, not new spending
- Effect on whole-history totals:
  - Income **$257,328 → $241,218** (−$16,110)
  - Expenses **$164,818 → $143,196** (−$21,622)
  - Net **+$92,510 → +$98,022**
- Balances unaffected (user-entered). Loan payments still show as real cash-out in the forecast.

### Still open / to revisit
- Other loans in the same Monarch "Loan Payment/Repayment" category not yet separated:
  **Mercedes-Benz** ($1,673.80 paid) and **Zolve** ($1,204.60 paid) — could get their own
  loan accounts the same way if wanted.
- The 7 "Zelle … for upstart" self-funding inflows were NOT touched (their "upstart" text is
  only in Original Statement, which isn't stored). Minor; reclassify to transfer-in if they
  bother you in income.

## 2026-07-23 (later) — Upstart rows moved onto the loan account + made visible
- Moved all **22 Upstart rows** from BofA checking → **Upstart Loan** account (accountId
  = acct_upstart), so the loan's activity (disbursement + 21 payments) lives under the loan,
  where you'd expect to find it.
- Made the account **visible** again: the app hard-filters `where isActive == true`, so a
  truly-closed account disappears entirely. Kept it active but named
  **"Upstart Loan (closed · paid off)"**, balance $0 (no net-worth impact).
- Note: this shifts BofA checking's CSV-net-change reconciliation (those 22 rows left it),
  but balances are user-entered so nothing displayed changes.
- **Reminder:** the browser keeps a Firestore offline cache — after any server-side change,
  clear site data (DevTools → Application → Clear site data) or use Incognito to see it.

## 2026-07-23 — Mercedes-Benz closed auto loan
- Car sold to Carvana ~6 months in (paid ~$5k to close, went underwater). Created
  **Mercedes-Benz Auto Loan (closed · sold to Carvana)** (`personal_loan`, $0, visible).
- Linked its 6 rows (2 on Amex, 4 on Chase checking) → the loan account as payments.
  Total paid in the data: $5,357.39 ($2,000 down + $9.79 fee + 4 × $836.90). No
  disbursement (auto loan financed the car directly), and Feb/Mar payments are missing
  from the export.
