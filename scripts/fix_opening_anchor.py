#!/usr/bin/env python3
"""
#83 — find (and clear) the opening anchors nobody actually set.

`deriveAccountBalance` skips every transaction dated before an account's `openingDate`,
because a real anchor means "as of this date the balance was THIS, and everything older
is already inside it". Accounts created before the fix got `openingBalance: 0` with
`openingDate: today` regardless of whether anyone claimed a balance — so all their
history sits behind a zero anchor and never reaches the displayed number.

A broken anchor looks like: openingBalance == 0, openingDate set, and transactions
exist BEFORE that date. Clearing openingDate lets the whole history count again.

An account whose owner genuinely typed 0 is indistinguishable from a blank one in the
stored data, which is why this reports the balance change per account and writes
nothing without --apply.

  python scripts/fix_opening_anchor.py            # dry run
  python scripts/fix_opening_anchor.py --apply    # clear the bogus anchors
"""
import argparse, json, os, sys, time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fsadmin import BASE, api, commit, fields, find_uid, list_sub  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DEBT = {"credit_card", "personal_loan"}


def tx_day(tx):
    d = tx.get("date")
    if isinstance(d, str):
        return d[:10]
    if isinstance(d, dict) and "_seconds" in d:
        return datetime.fromtimestamp(d["_seconds"] - 6 * 3600, timezone.utc).strftime("%Y-%m-%d")
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", default="bhuvaneswar.marreddy@gmail.com")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    uid = find_uid(args.email)
    accounts = {d["name"].rsplit("/", 1)[1]: fields(d) for d in list_sub(uid, "accounts")}
    txs = [fields(d) for d in list_sub(uid, "transactions")]

    by_account = {}
    for t in txs:
        by_account.setdefault(t.get("accountId"), []).append(t)

    broken, healthy = [], []
    for aid, a in accounts.items():
        anchor = a.get("openingDate")
        opening = a.get("openingBalance") or 0
        rows = by_account.get(aid, [])
        if not anchor:
            healthy.append((a.get("name"), "no anchor — full history counts"))
            continue
        hidden = [t for t in rows if (tx_day(t) or "9999") < anchor]
        if not hidden or opening != 0:
            healthy.append((a.get("name"), f"anchor {anchor} @ {opening:,.2f}, {len(hidden)} rows behind it"))
            continue
        # Zero anchor with history behind it: the anchor claims nothing and hides everything.
        net = sum((t.get("amount") or 0) if t.get("type") == "income" else -(t.get("amount") or 0)
                  for t in hidden)
        broken.append({"id": aid, "name": a.get("name"), "type": a.get("type"),
                       "openingDate": anchor, "hiddenRows": len(hidden), "hiddenNet": net})

    print(f"uid={uid}  accounts={len(accounts)}  transactions={len(txs)}\n")
    print(f"BROKEN — zero anchor with history behind it: {len(broken)}")
    for b in broken:
        sign = -1 if b["type"] in DEBT else 1
        print(f"  {b['name'][:34]:<34} anchored {b['openingDate']}  "
              f"{b['hiddenRows']:>5} rows hidden  balance would move {sign * b['hiddenNet']:>+12,.2f}")
    print(f"\nHEALTHY: {len(healthy)}")
    for n, why in healthy:
        print(f"  {n[:34]:<34} {why}")

    out = os.path.join(HERE, "opening-anchor-plan.local.json")
    json.dump(broken, open(out, "w"), indent=1)
    print(f"\nplan → {out}")

    if not args.apply:
        print(f"\nDRY RUN — nothing written. --apply would clear openingDate on {len(broken)} accounts.")
        return
    if not broken:
        print("\nnothing to fix.")
        return

    stamp = time.strftime("%Y-%m-%d-%H-%M-%S")
    bdir = os.path.join(HERE, "backups")
    os.makedirs(bdir, exist_ok=True)
    bpath = os.path.join(bdir, f"accounts-before-anchor-fix-{stamp}.json")
    json.dump({b["id"]: accounts[b["id"]] for b in broken}, open(bpath, "w"), indent=1)
    print(f"\nbacked up {len(broken)} account docs → {bpath}")

    # Field-scoped update: clearing openingDate must not rewrite anything else on the doc.
    commit([{"update": {
        "name": f"projects/marreddy-cashflow/databases/(default)/documents/users/{uid}/accounts/{b['id']}",
        "fields": {}},
        "updateMask": {"fieldPaths": ["openingDate"]}} for b in broken])
    print(f"cleared openingDate on {len(broken)} accounts. Reopen the app: the hidden history now counts.")


if __name__ == "__main__":
    main()
