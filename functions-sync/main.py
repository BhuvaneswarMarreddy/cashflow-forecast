"""Firebase 2nd-gen Python functions — codebase "sync" (marreddy-cashflow).

monarch_sync      daily 07:30 America/Chicago scheduled Monarch -> Firestore sync
monarch_sync_now  manual trigger, guarded by the SYNC_TRIGGER_KEY shared secret
simplefin_sync    daily 07:30 America/Chicago scheduled SimpleFIN -> Firestore sync
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

import simplefin
import sync_core

firebase_admin.initialize_app()

MONARCH_SECRETS = ["MONARCH_EMAIL", "MONARCH_PASSWORD", "MONARCH_MFA_SECRET"]


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


@scheduler_fn.on_schedule(
    schedule="every day 07:30",
    timezone=scheduler_fn.Timezone("America/Chicago"),
    secrets=["SIMPLEFIN_ACCESS_URL"],
    memory=options.MemoryOption.MB_512,
    timeout_sec=540,
)
def simplefin_sync(event: scheduler_fn.ScheduledEvent) -> None:
    _run_simplefin(reraise=True)  # a failed sync must show as a FAILED invocation


@https_fn.on_call(
    secrets=["SIMPLEFIN_ACCESS_URL"],
    memory=options.MemoryOption.MB_512,
    timeout_sec=300,
)
def sync_now(req: https_fn.CallableRequest) -> dict:
    """On-demand refresh from the app's own Refresh button.

    A CALLABLE, not the shared-key HTTP endpoint: the browser is already signed
    in, so Firebase verifies the ID token for us and no secret has to live in
    client code. Only the owner's uid may run it — this writes their ledger.
    Never raises: the button shows the returned error string instead of a
    console stack the user can't see.
    """
    if not req.auth:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.UNAUTHENTICATED,
                                  "Sign in to refresh.")
    try:
        owner_uid = auth.get_user_by_email(sync_core.OWNER_EMAIL).uid
    except Exception:
        owner_uid = None
    if owner_uid and req.auth.uid != owner_uid:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.PERMISSION_DENIED,
                                  "Not your data.")
    status = _run_simplefin()
    # Only what the button needs to render; never echo the access URL.
    return {k: status.get(k) for k in
            ("added", "enriched", "pendingLive", "pendingCleared", "reanchored",
             "unmatchedAccounts", "lastSuccess", "error")}


