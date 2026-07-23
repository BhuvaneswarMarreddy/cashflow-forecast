#!/usr/bin/env python3
"""
Firestore data-ops for the cashflow app (project: marreddy-cashflow).

Owner/admin access via the firebase CLI's OAuth token — bypasses security rules,
so it can bulk-fix transactions the way the user asks instead of them editing each
one by hand. SAFE BY DEFAULT: every mutating command is a dry-run preview until you
pass --apply, and --apply first writes a timestamped JSON backup of every doc it
touches (to scripts/backups/) so any change is reversible.

Rules the user gives are recorded in CLEANUP_INSTRUCTIONS.md and re-run after each
monthly import, so the cleanup is repeatable, not one-off.

Usage:
  python scripts/fsadmin.py summary   --email you@example.com
  python scripts/fsadmin.py backup    --email you@example.com
  python scripts/fsadmin.py reclassify --email you@example.com \
      --eq sourceCategory "Other Income" --contains title zelle \
      --set type transfer --set transferDirection out            # preview
  # add --apply to actually write (backs up first)
"""
import argparse, json, os, time, urllib.request, urllib.error
from collections import Counter

PROJECT = "marreddy-cashflow"
BASE = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"


def token():
    p = os.path.expanduser("~/.config/configstore/firebase-tools.json")
    return json.load(open(p))["tokens"]["access_token"]


def api(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token()}", "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=60))


def to_py(v):
    if "stringValue" in v: return v["stringValue"]
    if "booleanValue" in v: return v["booleanValue"]
    if "integerValue" in v: return int(v["integerValue"])
    if "doubleValue" in v: return v["doubleValue"]
    if "timestampValue" in v: return v["timestampValue"]
    if "nullValue" in v: return None
    return v


def from_py(x):
    if isinstance(x, bool): return {"booleanValue": x}
    if isinstance(x, int): return {"integerValue": str(x)}
    if isinstance(x, float): return {"doubleValue": x}
    return {"stringValue": str(x)}


def fields(doc):
    return {k: to_py(v) for k, v in doc.get("fields", {}).items()}


def find_uid(email):
    docs = api("GET", BASE + "/users").get("documents", [])
    for d in docs:
        if to_py(d.get("fields", {}).get("email", {})) == email:
            return d["name"].split("/")[-1]
    if len(docs) == 1:
        return docs[0]["name"].split("/")[-1]
    raise SystemExit(f"No user for {email!r} (found {len(docs)} users). Sign up + import first.")


def list_sub(uid, sub):
    out, url = [], f"{BASE}/users/{uid}/{sub}?pageSize=300"
    while True:
        r = api("GET", url)
        out += r.get("documents", [])
        tok = r.get("nextPageToken")
        if not tok:
            return out
        url = f"{BASE}/users/{uid}/{sub}?pageSize=300&pageToken={tok}"


def all_tx(uid):
    return list_sub(uid, "transactions")


# Every data subcollection the app writes under a user (from firestore.ts).
DATA_SUBS = ["accounts", "income", "transactions", "goals", "reminders"]


def matches(f, eqs, contains):
    for k, v in eqs:
        if str(f.get(k, "")) != v:
            return False
    for k, sub in contains:
        if sub.lower() not in str(f.get(k, "")).lower():
            return False
    return True


def cmd_summary(args):
    uid = find_uid(args.email)
    docs = all_tx(uid)
    fs = [fields(d) for d in docs]
    print(f"uid={uid}  transactions={len(docs)}")
    print("\nby type:", dict(Counter(f.get("type") for f in fs)))
    print("\ntop sourceCategory:")
    for c, n in Counter(f.get("sourceCategory") or f.get("category") for f in fs).most_common(20):
        print(f"  {n:4d}  {c}")


def cmd_backup(args):
    uid = find_uid(args.email)
    docs = all_tx(uid)
    os.makedirs("scripts/backups", exist_ok=True)
    path = f"scripts/backups/{uid}_{args.stamp}.json"
    json.dump(docs, open(path, "w"), indent=2)
    print(f"backed up {len(docs)} transactions -> {path}")


def cmd_reclassify(args):
    uid = find_uid(args.email)
    docs = all_tx(uid)
    hits = [d for d in docs if matches(fields(d), args.eq, args.contains)]
    updates = dict(args.set)
    print(f"{len(hits)} of {len(docs)} transactions match; would set {updates}")
    for d in hits[:15]:
        f = fields(d)
        print(f"  - {f.get('date','')[:10]} {str(f.get('amount','')):>9} "
              f"[{f.get('type')}] {str(f.get('title',''))[:40]} | src={f.get('sourceCategory')}")
    if len(hits) > 15:
        print(f"  ... +{len(hits)-15} more")
    if not args.apply:
        print("\nDRY RUN — re-run with --apply to write (a backup is taken first).")
        return
    # backup then patch
    os.makedirs("scripts/backups", exist_ok=True)
    bpath = f"scripts/backups/{uid}_reclassify_{args.stamp}.json"
    json.dump(hits, open(bpath, "w"), indent=2)
    mask = "&".join(f"updateMask.fieldPaths={k}" for k in updates)
    for d in hits:
        name = d["name"]
        body = {"fields": {k: from_py(v) for k, v in updates.items()}}
        api("PATCH", f"https://firestore.googleapis.com/v1/{name}?{mask}", body)
    print(f"applied to {len(hits)} docs. backup: {bpath}")


def cmd_purge(args):
    uid = find_uid(args.email)
    docs = {s: list_sub(uid, s) for s in DATA_SUBS}
    counts = {s: len(d) for s, d in docs.items()}
    total = sum(counts.values())
    print(f"uid={uid}  would delete: {counts}  (total {total})")
    if total == 0:
        print("Nothing to delete — already clean.")
        return
    if not args.apply:
        print("\nDRY RUN — re-run with --apply to delete (a full backup is taken first).")
        return
    os.makedirs("scripts/backups", exist_ok=True)
    bpath = f"scripts/backups/{uid}_purge_{args.stamp}.json"
    json.dump(docs, open(bpath, "w"), indent=2)
    for s, ds in docs.items():
        for d in ds:
            api("DELETE", f"https://firestore.googleapis.com/v1/{d['name']}")
    print(f"deleted {total} docs across {DATA_SUBS}. backup: {bpath}")


def kv(s):
    k, _, v = s.partition("=")
    return (k, v) if "=" in s else (s, "")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("summary", "backup", "reclassify", "purge"):
        p = sub.add_parser(name)
        p.add_argument("--email", required=True)
        if name == "purge":
            p.add_argument("--apply", action="store_true")
        if name == "reclassify":
            p.add_argument("--eq", nargs=2, action="append", default=[], metavar=("FIELD", "VALUE"))
            p.add_argument("--contains", nargs=2, action="append", default=[], metavar=("FIELD", "SUBSTR"))
            p.add_argument("--set", nargs=2, action="append", default=[], metavar=("FIELD", "VALUE"))
            p.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    # ponytail: caller passes a stamp so runs are traceable (Date.now() is fine in a CLI).
    args.stamp = time.strftime("%Y%m%d-%H%M%S")
    {"summary": cmd_summary, "backup": cmd_backup, "reclassify": cmd_reclassify, "purge": cmd_purge}[args.cmd](args)


if __name__ == "__main__":
    main()
