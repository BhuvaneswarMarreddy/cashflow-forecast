#!/usr/bin/env python3
"""Local dry-run / one-shot apply for the Monarch sync — validate BEFORE deploying.

Runs the exact same sync logic as the deployed function, with Monarch creds from
the shell and Firestore admin access via the firebase CLI's OAuth token (the same
credentials scripts/fsadmin.py uses).

  export MONARCH_EMAIL='you@example.com'
  export MONARCH_PASSWORD='...'
  export MONARCH_MFA_SECRET='...'          # omit or leave empty if no MFA

  python3 functions-sync/dryrun.py --dry-run   # Firestore reads only; prints every
                                               # row + re-anchor it WOULD write
  python3 functions-sync/dryrun.py --apply     # one real sync pass

Needs the deps installed (see README): pip install -r functions-sync/requirements.txt
"""
import argparse
import asyncio
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.join(_HERE, "..", "scripts"))  # fsadmin rails

import fsadmin  # noqa: E402  (find_uid + firebase CLI OAuth token)
import sync_core  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true",
                   help="no Firestore writes; print what would be written")
    g.add_argument("--apply", action="store_true", help="run one real sync pass")
    g.add_argument("--set-token", metavar="TOKEN",
                   help="seed the Monarch session token grabbed from a browser "
                        "(sidesteps the programmatic login, which Monarch throttles "
                        "with HTTP 429). Stored at meta/monarchSync.session.")
    g.add_argument("--check-token", action="store_true",
                   help="verify the stored session token still works (no writes)")
    args = ap.parse_args()

    from google.cloud import firestore
    from google.oauth2.credentials import Credentials

    db = firestore.Client(project=sync_core.PROJECT,
                          credentials=Credentials(token=fsadmin.token()))

    meta_ref = db.collection("meta").document("monarchSync")
    if args.set_token:
        token = args.set_token.strip().strip('"').strip("'")
        meta_ref.set({"session": token}, merge=True)
        print(f"stored session token ({len(token)} chars) at meta/monarchSync.session")
        print("now run:  functions-sync/venv/bin/python functions-sync/dryrun.py --check-token")
        return

    if args.check_token:
        snap = meta_ref.get()
        token = (snap.to_dict() or {}).get("session") if snap.exists else None
        if not token:
            print("no stored session token — seed one with --set-token")
            return
        from monarchmoney import MonarchMoney
        mm = MonarchMoney(token=token)
        accounts = asyncio.run(mm.get_accounts()).get("accounts") or []
        print(f"token OK — Monarch returned {len(accounts)} accounts:")
        for a in accounts:
            print(f"  {a.get('displayName')!r}  mask={a.get('mask')}  "
                  f"balance={a.get('currentBalance')}")
        return

    uid = fsadmin.find_uid(sync_core.OWNER_EMAIL)
    print(f"uid={uid}  mode={'DRY RUN' if args.dry_run else 'APPLY'}")

    status = asyncio.run(sync_core.run_sync(
        db, uid,
        os.environ.get("MONARCH_EMAIL", ""),
        os.environ.get("MONARCH_PASSWORD", ""),
        os.environ.get("MONARCH_MFA_SECRET", ""),
        dry_run=args.dry_run,
    ))
    print("\nstatus:")
    for k, v in status.items():
        if k != "session":
            print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
