#!/usr/bin/env python3
"""
Restore the review decisions the account reset dropped (issue #111).

The delete-and-resignup protocol restored transactions, accounts and income sources.
It never restored `users/{uid}/reviews` — 451 confirmations the owner made by hand,
gone. This puts back the ones that can be put back HONESTLY, and no more.

TWO TIERS, deliberately not the same command:

  exact       the review's transactionId still exists live. Re-writing it replays a
              decision the owner already made about that exact row. Safe.
  fingerprint the id is gone (re-imported under a new one) but a live row has the same
              amount + date + title. That is EVIDENCE, not proof, and FIN-SETTLEMENT-003
              says a guess about money gets confirmed. Needs its own flag.

The 338 reviews whose row is genuinely absent (retired `sf_` SimpleFIN rows, `imp_` rows
from CSVs that were not re-imported) are never written. There is nothing to attach them to.

CONTRACT (same as reanalyze.ts — see that file, this one follows it deliberately)
  - DRY RUN by default. Prints the plan, writes it to restore-reviews-plan.local.json.
  - An existing review in a TERMINAL state (confirmed/dismissed) is NEVER replaced.
    Anything the owner has decided since the reset beats this restore, always.
  - --apply backs up every review doc it would touch to scripts/backups/ first.
  - Every restored doc carries restoredFrom + restoreBatch, so the run is identifiable
    and reversible.

USAGE
  python scripts/restore_reviews.py                    # dry run, both tiers, no writes
  python scripts/restore_reviews.py --apply            # write the 45 exact matches only
  python scripts/restore_reviews.py --apply --include-fingerprint   # + the 68 (after review)
"""
import argparse, json, os, re, sys, time
from collections import Counter
from datetime import datetime, timezone
from urllib.parse import unquote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fsadmin import BASE, api, commit, fields, find_uid, from_py, list_sub  # noqa: E402

BACKUP = os.path.expanduser("~/cashflow-backups/pre-reset-backup-2026-08-06-19-50-30-uid-7hjLW3mz.json")
BATCH = "restore-reviews-2026-08-08"
HERE = os.path.dirname(os.path.abspath(__file__))

# The fields a review document owns. Provider data is never written from here (types/index.ts:346).
# `batchId` is not in the type but is written by reanalyze.ts, and is how that script finds and
# reverses its own writes — drop it and a restored doc silently leaves its batch.
REVIEW_FIELDS = ("transactionId", "state", "meaning", "incomeSourceId", "reasons",
                 "fingerprint", "explanation", "confirmedAt", "updatedAt", "source", "batchId")
TERMINAL = {"confirmed", "dismissed"}


def norm(s):
    """Title comparison key. The importer stores empty descriptions for some rows, so
    an empty title is not a match key at all — it would collide with every other blank."""
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def tx_date(tx):
    """The date string the app itself derived, taken from the row's own fingerprint
    (`accountId|amountCents|YYYY-MM-DD`) so no timezone is re-guessed here. Falls back to
    UTC-6 (the tz the stored midnights were written in) when the field is absent."""
    fp = tx.get("fingerprint")
    if isinstance(fp, str) and fp.count("|") == 2:
        return fp.rsplit("|", 1)[1]
    d = tx.get("date")
    if isinstance(d, dict) and "_seconds" in d:
        secs = d["_seconds"]
    elif isinstance(d, str):
        secs = datetime.fromisoformat(d.replace("Z", "+00:00")).timestamp()
    else:
        return None
    return datetime.fromtimestamp(secs - 6 * 3600, timezone.utc).strftime("%Y-%m-%d")


def cents(a):
    return None if a is None else round(float(a) * 100)


def key(tx):
    """amount + date + title — the triple issue #111 measured recoverability with."""
    t, d = norm(tx.get("title") or tx.get("merchant")), tx_date(tx)
    c = cents(tx.get("amount"))
    return (c, d, t) if (t and d and c is not None) else None


def load_live(uid):
    live = {}
    for doc in list_sub(uid, "transactions"):
        live[doc["name"].rsplit("/", 1)[1]] = fields(doc)
    return live


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", default="bhuvaneswar.marreddy@gmail.com")
    ap.add_argument("--apply", action="store_true", help="actually write (exact tier)")
    ap.add_argument("--include-fingerprint", action="store_true",
                    help="also write the fingerprint-matched tier — a guess, confirm it first")
    args = ap.parse_args()

    backup = json.load(open(BACKUP))
    reviews, old_tx = backup["reviews"], backup["transactions"]
    uid = find_uid(args.email)
    live = load_live(uid)
    live_reviews = {d["name"].rsplit("/", 1)[1]: fields(d) for d in list_sub(uid, "reviews")}

    # Live rows indexed by the match triple. A triple hitting >1 live row is ambiguous and
    # is NOT a match — restoring one of two identical rows silently picks the wrong one.
    by_key = {}
    for tid, tx in live.items():
        k = key(tx)
        if k:
            by_key.setdefault(k, []).append(tid)

    exact, fingerprint, absent, ambiguous, held = [], [], [], [], []
    for rid, rev in reviews.items():
        target, why = None, None
        if rid in live:
            target, why = rid, "exact"
        else:
            k = key(old_tx.get(rid, {}))
            hits = by_key.get(k, []) if k else []
            if len(hits) == 1:
                target, why = hits[0], "fingerprint"
            elif len(hits) > 1:
                ambiguous.append((rid, len(hits)))
                continue
            else:
                absent.append(rid)
                continue
        existing = live_reviews.get(target)
        if existing and existing.get("state") in TERMINAL:
            held.append((rid, target, existing.get("meaning")))   # owner already re-decided
            continue
        (exact if why == "exact" else fingerprint).append((rid, target, rev))

    def tally(rows):
        return Counter(r[2].get("meaning") or r[2].get("state") for r in rows).most_common()

    print(f"backup reviews {len(reviews)}   live rows {len(live)}   live reviews {len(live_reviews)}\n")
    print(f"  exact id match       {len(exact):>4}   {tally(exact)}")
    print(f"  fingerprint match    {len(fingerprint):>4}   {tally(fingerprint)}")
    print(f"  row absent live      {len(absent):>4}   (not restorable — nothing to attach to)")
    print(f"  ambiguous triple     {len(ambiguous):>4}   (>1 identical live row — refused)")
    print(f"  already re-decided   {len(held):>4}   (terminal review live — left alone)\n")

    plan = {"batch": BATCH, "uid": uid,
            "exact": [{"from": a, "to": b, "review": c} for a, b, c in exact],
            "fingerprint": [{"from": a, "to": b, "review": c,
                             "oldTitle": (old_tx.get(a) or {}).get("title"),
                             "newTitle": live[b].get("title"),
                             "amount": live[b].get("amount"), "date": tx_date(live[b])}
                            for a, b, c in fingerprint],
            "absent": absent, "ambiguous": ambiguous,
            "held": [{"from": a, "to": b, "liveMeaning": m} for a, b, m in held]}
    out = os.path.join(HERE, "restore-reviews-plan.local.json")
    json.dump(plan, open(out, "w"), indent=1)
    print(f"plan → {out}")

    writing = list(exact) + (list(fingerprint) if args.include_fingerprint else [])
    if not args.apply:
        print(f"\nDRY RUN — nothing written. --apply would write {len(exact)} exact"
              f"{' + %d fingerprint' % len(fingerprint) if args.include_fingerprint else ''}.")
        return
    if not writing:
        print("\nnothing to write.")
        return

    stamp = time.strftime("%Y-%m-%d-%H-%M-%S")
    bdir = os.path.join(HERE, "backups")
    os.makedirs(bdir, exist_ok=True)
    prior = {t: live_reviews[t] for _, t, _ in writing if t in live_reviews}
    bpath = os.path.join(bdir, f"reviews-before-restore-{stamp}.json")
    json.dump(prior, open(bpath, "w"), indent=1)
    print(f"\nbacked up {len(prior)} existing review docs → {bpath}")

    writes = []
    for rid, target, rev in writing:
        doc = {k: rev[k] for k in REVIEW_FIELDS if rev.get(k) is not None and k != "reasons"}
        doc["transactionId"] = target           # re-point at the row that exists NOW
        doc["restoredFrom"] = rid
        doc["restoreBatch"] = BATCH
        writes.append({"update": {
            "name": f"projects/marreddy-cashflow/databases/(default)/documents/users/{uid}/reviews/{target}",
            "fields": {k: from_py(v) for k, v in doc.items()}}})
    commit(writes)
    print(f"wrote {len(writes)} review documents (batch {BATCH}).")
    print("Reopen the app: the restored confirmations are live, and #104's $138k question returns with them.")


if __name__ == "__main__":
    main()
