# Transaction cleanup rules

Standing instructions for fixing imported transactions in bulk — so the owner never
edits rows one by one. Applied with `scripts/fsadmin.py` (owner/admin access, preview
by default, backs up before writing) and **re-run after every monthly import**, so the
cleanup is repeatable.

Each rule = a match (fields to look for) + a set (fields to change). Run order matters;
apply top to bottom.

## How to run a rule

```
# preview (always first):
python3 scripts/fsadmin.py reclassify --email <owner> <match/set flags>
# apply (writes a backup to scripts/backups/ first):
python3 scripts/fsadmin.py reclassify --email <owner> <match/set flags> --apply
```

Fields on a transaction: `type` (income|expense|transfer), `transferDirection` (in|out),
`category` (13-value enum), `sourceCategory` (Monarch's own label), `title`, `merchant`,
`amount`, `accountId`, `date`.

---

## Rules

Status legend: ✅ confirmed & applied · 📝 draft (needs the owner's OK / real data to pin the exact strings)

### R1 — Credit-card payments miscategorised as income → transfer  📝
Monarch's own "Credit Card Payment" rows already import as transfers. This rule catches
the ones that landed in **Other Income** instead.
> match: `sourceCategory == "Other Income"` AND `title contains` one of {payment, autopay, epay, card pmt}
> set: `type=transfer`
Exact command pinned once the real rows are visible (`fsadmin.py summary` shows them).

### R2 — Zelle transfers between the owner's own accounts → transfer  📝
A Zelle to another **person** is a real expense/income; a Zelle **between the owner's own
accounts** is a transfer. Distinguish by the counterparty (owner will tell me which Zelle
names/last-4 are their own accounts).
> match: `title contains "zelle"` AND counterparty ∈ {owner's own accounts}
> set: `type=transfer`, `transferDirection=` (out if leaving, in if arriving)

### R3 — (add here) bulk category remaps  📝
e.g. "all `AI Tools` → keep as-is", "merge `Coffee Shops` into `Restaurants & Bars`",
"everything in `Miscellaneous` → `Shopping`". The owner names the from→to; I run:
> match: `sourceCategory == "<from>"`  → set: `sourceCategory=<to>` (and `category=<enum>` if needed)

---

## Owner-owned (NOT cleanup — the owner enters these)
- Account list + current/opening balances
- Credit-card payment amounts & due dates
- Paycheck dates & amounts (income sources)

## Notes
- Every `--apply` writes a backup to `scripts/backups/<uid>_*.json`. To revert, PATCH the
  saved values back.
- The owner's email for `--email`: bhuvaneswar.marreddy@gmail.com
