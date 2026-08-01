"""Firebase 2nd-gen Python functions — codebase "sync" (marreddy-cashflow).

monarch_sync      daily 07:30 America/Chicago scheduled Monarch -> Firestore sync
monarch_sync_now  manual trigger, guarded by the SYNC_TRIGGER_KEY shared secret
"""
import asyncio
import hmac
import json
import os
import traceback

import firebase_admin
from firebase_admin import auth, firestore
from firebase_functions import https_fn, options, scheduler_fn

import sync_core

firebase_admin.initialize_app()

MONARCH_SECRETS = ["MONARCH_EMAIL", "MONARCH_PASSWORD", "MONARCH_MFA_SECRET"]


def _run(log=print, reraise: bool = False) -> dict:
    """One sync. Records any failure on meta/monarchSync, then (for the scheduled
    caller) RE-RAISES so the invocation is marked failed and Cloud alerting fires.
    Swallowing here once made a permanently-broken sync look like a green streak."""
    db = firestore.client()
    try:
        uid = auth.get_user_by_email(sync_core.OWNER_EMAIL).uid
        return asyncio.run(sync_core.run_sync(
            db, uid,
            os.environ.get("MONARCH_EMAIL", ""),
            os.environ.get("MONARCH_PASSWORD", ""),
            os.environ.get("MONARCH_MFA_SECRET", ""),
            log=log,
        ))
    except Exception as e:
        log(traceback.format_exc())
        status = {"lastRun": sync_core.now_iso(), "error": f"{type(e).__name__}: {e}"}
        try:
            db.collection("meta").document("monarchSync").set(status, merge=True)
        except Exception:
            log("could not record error on meta/monarchSync")
        if reraise:
            raise
        return status


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
    key = os.environ.get("SYNC_TRIGGER_KEY", "")
    given = req.headers.get("X-Sync-Key", "")
    # compare bytes: compare_digest on str raises TypeError for a non-ASCII header
    if not key or not hmac.compare_digest(given.encode("utf-8", "replace"), key.encode()):
        return https_fn.Response("forbidden", status=403)
    status = _run()
    return https_fn.Response(json.dumps(status, default=str, indent=2),
                             mimetype="application/json")
