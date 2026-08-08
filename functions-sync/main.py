"""Firebase 2nd-gen Python functions — codebase "sync" (marreddy-cashflow).

monarch_sync      daily 07:30 America/Chicago scheduled Monarch -> Firestore sync
monarch_sync_now  manual trigger, guarded by the SYNC_TRIGGER_KEY shared secret
plaid_sync        07:00/13:00/19:00 America/Chicago scheduled Plaid -> Firestore sync

SimpleFIN was RETIRED 2026-08-06. It read MX's once-a-day cache (3-5 day lag,
no manual refresh possible) and, once Plaid covered the same four banks, every
one of its 310 rows duplicated a Plaid row while none was unique — $122,194.67
of phantom money. simplefin.py stays: plaid_ingest imports its mapping and
fingerprint helpers, and _run_simplefin remains callable by hand if a bank ever
needs it back.
plaid_link_token  callable (owner only): Link token, incl. update mode
plaid_exchange    callable (owner only): public_token -> stored access_token
sync_now          callable (owner only): on-demand Plaid refresh
"""
import asyncio
import hmac
import json
import os
import traceback
from urllib.parse import urlsplit

import firebase_admin
from firebase_admin import auth, firestore
from firebase_functions import https_fn, options, scheduler_fn

import plaid_ingest
import simplefin
import sync_core

firebase_admin.initialize_app()

MONARCH_SECRETS = ["MONARCH_EMAIL", "MONARCH_PASSWORD", "MONARCH_MFA_SECRET"]
PLAID_SECRETS = ["PLAID_CLIENT_ID", "PLAID_SECRET"]


def _require_owner(req: https_fn.CallableRequest) -> None:
    """Callable guard: signed in AND the owner. Every Plaid callable writes or
    reads the owner's ledger/credentials, so nobody else may call them."""
    if not req.auth:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.UNAUTHENTICATED,
                                  "Sign in first.")
    try:
        owner_uid = auth.get_user_by_email(sync_core.OWNER_EMAIL).uid
    except Exception:
        owner_uid = None
    if owner_uid and req.auth.uid != owner_uid:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.PERMISSION_DENIED,
                                  "Not your data.")


def _guarded(meta_doc: str, coro_factory, log=print, reraise: bool = False) -> dict:
    """One sync. Records any failure on meta/<meta_doc>, then (for the scheduled
    caller) RE-RAISES so the invocation is marked failed and Cloud alerting fires.
    Swallowing here once made a permanently-broken sync look like a green streak."""
    db = firestore.client()
    try:
        uid = auth.get_user_by_email(sync_core.OWNER_EMAIL).uid
        return asyncio.run(coro_factory(db, uid, log))
    except Exception as e:
        log(traceback.format_exc())
        status = {"lastRun": sync_core.now_iso(), "error": f"{type(e).__name__}: {e}"}
        try:
            db.collection("meta").document(meta_doc).set(status, merge=True)
        except Exception:
            log(f"could not record error on meta/{meta_doc}")
        if reraise:
            raise
        return status


def _authorized(req: https_fn.Request) -> bool:
    key = os.environ.get("SYNC_TRIGGER_KEY", "")
    given = req.headers.get("X-Sync-Key", "")
    # compare bytes: compare_digest on str raises TypeError for a non-ASCII header
    return bool(key) and hmac.compare_digest(given.encode("utf-8", "replace"), key.encode())


def _run(log=print, reraise: bool = False) -> dict:
    return _guarded("monarchSync", lambda db, uid, lg: sync_core.run_sync(
        db, uid,
        os.environ.get("MONARCH_EMAIL", ""),
        os.environ.get("MONARCH_PASSWORD", ""),
        os.environ.get("MONARCH_MFA_SECRET", ""),
        log=lg,
    ), log, reraise)


def _run_simplefin(log=print, reraise: bool = False) -> dict:
    return _guarded("simplefinSync", lambda db, uid, lg: simplefin.run_simplefin_sync(
        db, uid, os.environ.get("SIMPLEFIN_ACCESS_URL", ""), log=lg,
    ), log, reraise)


@scheduler_fn.on_schedule(
    schedule="every day 07:30",
    timezone=scheduler_fn.Timezone("America/Chicago"),
    secrets=MONARCH_SECRETS,
    memory=options.MemoryOption.MB_512,
    timeout_sec=540,
)
def monarch_sync(event: scheduler_fn.ScheduledEvent) -> None:
    _run(reraise=True)  # a failed sync must show as a FAILED invocation


@https_fn.on_request(
    secrets=MONARCH_SECRETS + ["SYNC_TRIGGER_KEY"],
    memory=options.MemoryOption.MB_512,
    timeout_sec=540,
)
def monarch_sync_now(req: https_fn.Request) -> https_fn.Response:
    if not _authorized(req):
        return https_fn.Response("forbidden", status=403)
    status = _run()
    return https_fn.Response(json.dumps(status, default=str, indent=2),
                             mimetype="application/json")


def _run_plaid(log=print, reraise: bool = False) -> dict:
    return _guarded("plaidSync", lambda db, uid, lg: plaid_ingest.run_plaid_sync(
        db, uid,
        os.environ.get("PLAID_CLIENT_ID", ""),
        os.environ.get("PLAID_SECRET", ""),
        log=lg,
    ), log, reraise)


@scheduler_fn.on_schedule(
    # Same three-a-day cadence as SimpleFIN; Plaid data is fresh enough that
    # each run actually moves the picture forward.
    schedule="0 7,13,19 * * *",
    timezone=scheduler_fn.Timezone("America/Chicago"),
    secrets=PLAID_SECRETS,
    memory=options.MemoryOption.MB_512,
    timeout_sec=540,
)
def plaid_sync(event: scheduler_fn.ScheduledEvent) -> None:
    _run_plaid(reraise=True)  # a failed sync must show as a FAILED invocation


@https_fn.on_call(
    secrets=PLAID_SECRETS,
    memory=options.MemoryOption.MB_512,
    timeout_sec=60,
)
def plaid_link_token(req: https_fn.CallableRequest) -> dict:
    """Link token for the in-app Plaid Link flow. With `itemId`, UPDATE MODE —
    repairs that Item in place (a fresh link burns a lifetime Trial slot)."""
    _require_owner(req)
    db = firestore.client()
    access_token = None
    item_id = (req.data or {}).get("itemId")
    if item_id:
        items = (db.collection("meta").document("plaid").get().to_dict() or {}).get("items") or {}
        entry = items.get(str(item_id))
        if not entry:
            raise https_fn.HttpsError(https_fn.FunctionsErrorCode.NOT_FOUND,
                                      "No such linked bank.")
        access_token = entry["accessToken"]
    token = plaid_ingest.create_link_token(
        os.environ.get("PLAID_CLIENT_ID", ""), os.environ.get("PLAID_SECRET", ""),
        req.auth.uid, access_token)
    return {"linkToken": token}


@https_fn.on_call(
    secrets=PLAID_SECRETS,
    memory=options.MemoryOption.MB_512,
    timeout_sec=60,
)
def plaid_exchange(req: https_fn.CallableRequest) -> dict:
    """public_token -> access_token, stored server-side in meta/plaid (clients
    can never read it); returns only the institution name. The first data pull
    happens on the next refresh/scheduled run — Plaid needs a moment to prepare
    history after linking anyway."""
    _require_owner(req)
    public_token = str((req.data or {}).get("publicToken") or "")
    institution = str((req.data or {}).get("institution") or "").strip() or "Bank"
    if not public_token:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
                                  "Missing publicToken.")
    access_token, item_id = plaid_ingest.exchange_public_token(
        os.environ.get("PLAID_CLIENT_ID", ""), os.environ.get("PLAID_SECRET", ""),
        public_token)
    db = firestore.client()
    db.collection("meta").document("plaid").set({
        "items": {item_id: {
            "accessToken": access_token,
            "institution": institution,
            "cursor": "",
            "linkedAt": sync_core.now_iso(),
        }},
    }, merge=True)
    return {"institution": institution}


@https_fn.on_call(
    secrets=PLAID_SECRETS,
    memory=options.MemoryOption.MB_512,
    timeout_sec=120,
)
def plaid_unlink_all(req: https_fn.CallableRequest) -> dict:
    """Revoke every linked Item at Plaid, then forget the tokens (#72).

    Account deletion is a privacy promise, and it used to keep this promise only on
    our side: `deleteAllUserData` wiped the ledger while the access tokens in
    meta/plaid stayed valid and the bank consent stayed granted. Clients cannot fix
    this themselves — meta/plaid is default-deny to them by design — so it takes a
    callable, and it has to run BEFORE the Auth user goes away or there is nothing
    left to authenticate with.

    FAILS CLOSED. If Plaid will not revoke an Item, this raises and the account is
    NOT deleted. A user can retry a deletion; nobody can un-leak a live bank
    credential. Deleting our token while the Item survived would be the worst
    outcome of the three — the connection would live on with no way left to revoke
    it.
    """
    _require_owner(req)
    db = firestore.client()
    ref = db.collection("meta").document("plaid")
    items = (ref.get().to_dict() or {}).get("items") or {}
    if not items:
        return {"removed": 0}

    client_id = os.environ.get("PLAID_CLIENT_ID", "")
    secret = os.environ.get("PLAID_SECRET", "")
    removed, failed = [], []
    for item_id, item in items.items():
        try:
            plaid_ingest.remove_item(client_id, secret, item["accessToken"])
            removed.append(item_id)
        except Exception as e:  # noqa: BLE001 — the message is Plaid's, never the token
            failed.append(f"{item.get('institution') or item_id}: {e}")

    # Forget only what Plaid confirmed revoked. A token whose Item still exists must
    # stay stored, or the Item becomes unreachable and unremovable forever.
    if removed:
        ref.update({f"items.{i}": firestore.DELETE_FIELD for i in removed})
    if failed:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.UNAVAILABLE,
            "Could not disconnect: " + "; ".join(failed))
    return {"removed": len(removed)}


@https_fn.on_call(
    # SIMPLEFIN_ACCESS_URL was bound here and never read — the body calls _run_plaid()
    # only. A retired provider's live credential was mounted into the function the
    # Refresh button runs, for nothing.
    secrets=PLAID_SECRETS,
    memory=options.MemoryOption.MB_512,
    timeout_sec=300,
)
def sync_now(req: https_fn.CallableRequest) -> dict:
    """On-demand refresh from the app's own Refresh button — PLAID ONLY.

    A CALLABLE, not the shared-key HTTP endpoint: the browser is already signed
    in, so Firebase verifies the ID token for us and no secret has to live in
    client code. Never raises: the button shows the returned error string
    instead of a console stack the user can't see.

    This docstring used to say "BOTH sources … then SimpleFIN enriches/backfills".
    The body has called _run_plaid() alone since SimpleFIN was retired on
    2026-08-06, so the description was inviting someone to debug a second sync
    that does not run.
    """
    _require_owner(req)
    status = _run_plaid()
    # Only what the button needs to render; never echo credentials.
    return {k: status.get(k) for k in
            ("added", "enriched", "pendingLive", "pendingCleared", "reanchored",
             "unmatchedAccounts", "createdAccounts", "lastSuccess", "error")}


