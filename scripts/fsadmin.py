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
import argparse, json, os, subprocess, time, urllib.request, urllib.error
from collections import Counter

PROJECT = "marreddy-cashflow"
BASE = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"


def token():
    # The stored access_token lasts an hour; past that every call here 401s. A firebase
    # CLI command that actually REACHES the API refreshes it in place from the
    # refresh_token in the same file, so borrow that instead of re-implementing the
    # OAuth exchange (and embedding a client secret).
    #
    # `projects:list`, not `login:list`: login:list only prints the locally cached
    # identity and touches no endpoint, so it leaves the expired token exactly as it
    # found it. Measured — expires_at was unchanged after login:list and moved an hour
    # forward after projects:list.
    p = os.path.expanduser("~/.config/configstore/firebase-tools.json")
    t = json.load(open(p))["tokens"]
    if t.get("expires_at", 0) < time.time() * 1000 + 60_000:
        subprocess.run(["firebase", "projects:list"], capture_output=True, timeout=120)
        t = json.load(open(p))["tokens"]
    return t["access_token"]


def api(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token()}", "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=120))


def commit(writes):
    # Batch delete/update via :commit. The doc name goes in the BODY, not the URL, so
    # ids containing %2F / %7C (encodeURIComponent of '/' and '|' in the source) are not
    # re-decoded into path separators — which silently made URL-path DELETE/PATCH no-op.
    # Also faster: up to 500 writes per call.
    for i in range(0, len(writes), 450):
        api("POST", BASE + ":commit", {"writes": writes[i:i + 450]})


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
    # Resolve via Firebase Auth, not the users collection: a user's transactions/accounts
    # subcollections can exist under a profile doc that was never created, and Firestore's
    # listDocuments does NOT return such a "missing parent" — so an email lookup there sees 0.
    r = api("POST", "https://identitytoolkit.googleapis.com/v1/projects/marreddy-cashflow/accounts:query", {})
    for u in r.get("userInfo", []):
        if (u.get("email") or "").lower() == email.lower():
            return u["localId"]
    infos = r.get("userInfo", [])
    if len(infos) == 1:
        return infos[0]["localId"]
    raise SystemExit(f"No Firebase Auth user for {email!r} ({len(infos)} users). Sign up first.")


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
    # backup then patch via :commit (name in body — see commit() for the id-encoding bug)
    os.makedirs("scripts/backups", exist_ok=True)
    bpath = f"scripts/backups/{uid}_reclassify_{args.stamp}.json"
    json.dump(hits, open(bpath, "w"), indent=2)
    fields_body = {k: from_py(v) for k, v in updates.items()}
    commit([
        {"update": {"name": d["name"], "fields": fields_body},
         "updateMask": {"fieldPaths": list(updates.keys())}}
        for d in hits
    ])
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
    commit([{"delete": d["name"]} for ds in docs.values() for d in ds])
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
