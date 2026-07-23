# CSV Ground Truth — brute-force calculations from `transactionsbyaccount/`

Generated 2026-07-23 from 2,913 rows across 9 files. No app involved — pure CSV math.
Rules mirrored from the app: Monarch `Transfer`/`Credit Card Payment` → transfer; payment-shaped inflows ON a card → transfer; refunds/other card credits stay income. Signs: negative = money out.

## 1. Bottom line (whole history)

| Metric | Value |
|---|---|
| Real income (paychecks, refunds, interest…) | **$257,327.55** |
| Real expenses (counted once, at purchase) | **$164,818.03** |
| Net | **$92,509.52** |
| Transfer legs (excluded from both) | 1039 rows |
| Matched transfer pairs (net zero) | 343 pairs, $224,741.69 |
| Unmatched out-legs (other side not in these files) | 176 rows, $190,770.33 |
| Unmatched in-legs | 177 rows, $104,666.74 |

## 2. Per-account: CSV net change vs real balance (opening-balance reconciliation)

Real balances from Monarch screenshot 2026-07-23 (banks). `implied opening = real now − CSV net change`.

| Account | Rows | Period | CSV net change | Real now | Implied opening |
|---|---|---|---|---|---|
| Adv SafeBalance Banking (...2126) | 742 | 2024-05-28→2026-07-22 | +6,263.88 | $1,430.93 | **$-4,832.95** |
| Blue Cash Preferred® (...1001) | 623 | 2023-12-02→2026-07-13 | +1,033.24 | $507.96 debt | **$1,541.20** |
| Customized Cash Rewards Visa Signature (...3572) | 586 | 2024-11-20→2026-07-21 | -4,773.40 | $2,656.09 debt | **$-2,117.31** |
| TOTAL CHECKING (...7535) | 241 | 2024-11-05→2026-07-22 | +4,659.60 | $829.60 | **$-3,830.00** |
| Discover it Card (...4363) | 236 | 2024-07-02→2026-07-12 | +3.82 | $6.85 debt | **$10.67** |
| Amazon Store Card (...3282) | 189 | 2025-10-13→2026-07-18 | -1,139.87 | $3,308.57 debt | **$2,168.70** |
| Apple Card | 117 | 2025-08-10→2026-07-22 | -183.63 | $2,068.93 debt | **$1,885.30** |
| Advantage Savings (...2139) | 109 | 2024-05-28→2026-07-15 | +41.32 | $45.52 | **$4.20** |
| CHASE SAVINGS (...2591) | 70 | 2024-11-08→2026-07-08 | +500.97 | $2,600.97 | **$2,100.00** |

Cards: `implied opening debt = real debt now + CSV net change` (a card's net + means more paid in than charged). Fill the real column from Monarch's Credit Cards section to complete.

## 3. Per-account flow breakdown

| Account | Income in | Expenses out | Transfers in | Transfers out | Refunds in |
|---|---|---|---|---|---|
| Adv SafeBalance Banking (...2126) | 128,101 | 65,396 | 166,013 | 222,455 | 0 |
| Blue Cash Preferred® (...1001) | 0 | 34,950 | 31,978 | 0 | 4,005 |
| Customized Cash Rewards Visa Signature (.. | 0 | 24,627 | 20,626 | 2,110 | 1,338 |
| TOTAL CHECKING (...7535) | 112,223 | 12,134 | 43,583 | 139,013 | 0 |
| Discover it Card (...4363) | 0 | 11,305 | 9,554 | 0 | 1,755 |
| Amazon Store Card (...3282) | 0 | 10,186 | 4,302 | 0 | 4,744 |
| Apple Card | 0 | 6,162 | 4,737 | 0 | 1,242 |
| Advantage Savings (...2139) | 3,919 | 48 | 28,710 | 32,540 | 0 |
| CHASE SAVINGS (...2591) | 0 | 10 | 19,905 | 19,394 | 0 |

## 4. Transfer routes (matched pairs — money between YOUR accounts, nets to zero)

| From | To | Moves | Total |
|---|---|---|---|
| TOTAL CHECKING (...7535) | Adv SafeBalance Banking (...2126) | 64 | $52,187.65 |
| Adv SafeBalance Banking (...2126) | Advantage Savings (...2139) | 53 | $28,710.46 |
| Adv SafeBalance Banking (...2126) | Blue Cash Preferred® (...1001) | 55 | $27,017.20 |
| Adv SafeBalance Banking (...2126) | Customized Cash Rewards Visa Signa | 27 | $17,151.14 |
| Advantage Savings (...2139) | Adv SafeBalance Banking (...2126) | 22 | $16,390.41 |
| CHASE SAVINGS (...2591) | TOTAL CHECKING (...7535) | 18 | $14,794.06 |
| TOTAL CHECKING (...7535) | CHASE SAVINGS (...2591) | 22 | $13,405.00 |
| Advantage Savings (...2139) | TOTAL CHECKING (...7535) | 7 | $13,300.00 |
| Adv SafeBalance Banking (...2126) | TOTAL CHECKING (...7535) | 11 | $12,689.00 |
| Adv SafeBalance Banking (...2126) | Discover it Card (...4363) | 26 | $8,262.28 |
| CHASE SAVINGS (...2591) | Adv SafeBalance Banking (...2126) | 7 | $4,600.00 |
| Adv SafeBalance Banking (...2126) | CHASE SAVINGS (...2591) | 5 | $4,500.00 |
| Adv SafeBalance Banking (...2126) | Amazon Store Card (...3282) | 5 | $2,758.39 |
| TOTAL CHECKING (...7535) | Apple Card | 7 | $2,027.85 |
| Adv SafeBalance Banking (...2126) | Apple Card | 4 | $1,965.34 |
| Advantage Savings (...2139) | Customized Cash Rewards Visa Signa | 4 | $1,682.91 |
| TOTAL CHECKING (...7535) | Customized Cash Rewards Visa Signa | 3 | $1,500.00 |
| TOTAL CHECKING (...7535) | Discover it Card (...4363) | 2 | $1,000.00 |
| TOTAL CHECKING (...7535) | Blue Cash Preferred® (...1001) | 1 | $800.00 |

## 5. Monthly income vs expense (last 12 months with data)

| Month | Income | Expenses | Net |
|---|---|---|---|
| 2025-08 | 7,309 | 7,732 | -423 |
| 2025-09 | 2,813 | 5,519 | -2,705 |
| 2025-10 | 5,910 | 8,052 | -2,142 |
| 2025-11 | 15,194 | 6,181 | +9,014 |
| 2025-12 | 10,662 | 10,760 | -98 |
| 2026-01 | 10,717 | 10,176 | +541 |
| 2026-02 | 8,841 | 10,332 | -1,492 |
| 2026-03 | 16,737 | 5,408 | +11,329 |
| 2026-04 | 14,385 | 11,107 | +3,278 |
| 2026-05 | 9,364 | 4,699 | +4,665 |
| 2026-06 | 10,957 | 5,080 | +5,877 |
| 2026-07 | 9,804 | 6,539 | +3,265 |
| **avg/mo** | **8,041** | **5,151** | **+2,891** |

## 6. Income by category (real income only)

| Category | Total |
|---|---|
| Paychecks | $180,055.19 |
| Other Income | $49,774.37 |
| Business Income | $7,862.83 |
| Loan Repayment | $3,200.00 |
| Balance Adjustments | $2,356.68 |
| Loan Payment | $700.00 |
| Insurance | $154.00 |
| Shopping | $94.23 |
| Internet & Cable | $46.00 |
| Interest | $0.37 |

## 7. Top expense categories / merchants

| Category | Total | | Merchant | Total |
|---|---|---|---|---|
| Shopping | $42,133 | | Amazon | $23,921 |
| Loan Repayment | $19,677 | | Upstart | $21,622 |
| Travel & Vacation | $14,018 | | Verizon | $9,809 |
| Phone | $10,159 | | Zelle | $7,807 |
| Restaurants & Bars | $9,766 | | Mercedes-Benz | $5,348 |
| Groceries | $8,049 | | Remitly | $5,208 |
| Cash & ATM | $6,783 | | Apple | $4,618 |
| Send to India | $6,466 | | Cross Creek Ranch | $4,200 |
| Rent | $6,120 | | Walmart | $3,882 |
| Loan Payment | $5,972 | | Costco | $3,281 |
| Insurance | $5,105 | | USHEALTH Group | $3,136 |
| Home Improvement | $3,831 | | The Home Depot | $2,814 |

## 8. Validation targets for the app

After import + cleanup rules, the app should show (whole history):
- History totals: In ≈ **$257,328**, Out ≈ **$164,818** (small drift from the Discover file, which is in the app but not in this folder)
- Accounts → Transfers: ≈ **343 matched pairs**, unmatched ≈ 176 out / 177 in
- Cash total once real balances entered: **$4,907.02** (matches Monarch)
- No credit card shows positive income except refunds
## 9. Reconciliation verdict (does the data match the balances?)

Categories do NOT affect balance math — every row moves its account by its signed
amount regardless of label. So a balance mismatch means MISSING ROWS, not
miscategorisation. Verdict per account:

| Account | Implied opening | Verdict |
|---|---|---|
| Advantage Savings (…2139) | $4.20 | ✅ reconciles — export complete |
| CHASE SAVINGS (…2591) | $2,100.00 | ✅ reconciles — plausible opening |
| Adv SafeBalance / BofA (…2126) | −$4,832.95 | ❌ impossible — export missing ≈ $4.8k+ of net outflows |
| TOTAL CHECKING (…7535) | −$3,830.00 | ❌ impossible — export missing ≈ $3.8k+ of net outflows |
| Discover it Card (…4363) | $10.67 | ✅ reconciles |
| Blue Cash Preferred® (…1001) | $1,541.20 | ✅ reconciles — plausible opening debt |
| Amazon Store Card (…3282) | $2,168.70 | ✅ plausible (debt predates export window) |
| Apple Card | $1,885.30 | ✅ plausible (debt predates export window) |
| Customized Cash Rewards Visa (…3572) | −$2,117.31 | ❌ impossible — export missing ≈ $2.1k+ of payments/credits |

Likely causes for the checkings: Monarch "hidden from reports" rows are excluded from
CSV export, and history before the account was linked to Monarch was never captured.

**Net position (2026-07-23):** cash $4,907.02 − card debt $8,548.40 = **net worth −$3,641.38**.

**Consequence for the app (already built this way):** balances must stay USER-ENTERED —
no transaction-derived balance can ever match reality when the source export is
incomplete. The CSVs are authoritative for FLOWS (income, spend, transfers), the
screenshot/user is authoritative for BALANCES.
