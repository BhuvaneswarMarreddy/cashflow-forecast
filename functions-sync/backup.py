"""Automated Firestore backups (#4, project: marreddy-cashflow).

Until now the only backups were the ones somebody remembered to take by hand with
scripts/fsadmin.py. On 2026-08-06 an account reset wiped 451 review decisions and the
most recent hand-taken backup is the only reason 102 of them are recoverable at all
(#111). This removes "somebody remembered" from that sentence.

Uses Firestore's own MANAGED EXPORT, not a document walk: one API call hands the whole
database to GCS server-side, with no read charges, no 500-doc batching, and no chance of
a half-written snapshot from a function that timed out two thirds of the way through.

Restore is `gcloud firestore import gs://<bucket>/<prefix>` — the exported format is
Firestore's own, so a restore needs no code from this repo. That matters: a backup whose
restore path depends on the app is a backup you cannot use when the app is the problem.

Retention is a GCS lifecycle rule on the bucket, not code here. Deleting old exports is
exactly what object lifecycle management exists for, and a cron that deletes backups is
a cron that can delete the wrong ones.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

HOST = "https://firestore.googleapis.com"
# Where under the bucket the exports land. Dated, so listing the prefix is the
# restore-point index — no separate manifest to fall out of sync with reality.
PREFIX = "firestore-backups"


def output_uri(bucket: str, day: str) -> str:
    """gs://<bucket>/firestore-backups/<YYYY-MM-DD>. One export per day; re-running
    the same day overwrites that day's folder rather than growing a second copy."""
    return f"gs://{bucket}/{PREFIX}/{day}"


def export_body(bucket: str, day: str, collections: list[str] | None = None) -> dict:
    """The :exportDocuments request.

    `collectionIds` is deliberately EMPTY by default, which means "everything".
    Naming collections would have meant maintaining a second list beside
    USER_SUBCOLLECTIONS, and a collection missing from that list is a collection
    missing from every backup — silently, and only discovered during a restore.
    """
    body: dict = {"outputUriPrefix": output_uri(bucket, day)}
    if collections:
        body["collectionIds"] = collections
    return body


def _token() -> str:
    # google-auth ships with firebase-admin; the function's own service account
    # already runs as the project, so there is no key to store or rotate.
    import google.auth
    import google.auth.transport.requests

    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/datastore"])
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token


def _post(url: str, body: dict, token: str, timeout: int = 120) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        try:
            err = json.loads(detail).get("error", {})
            raise RuntimeError(f"firestore export: {err.get('status')} {err.get('message')}") from None
        except json.JSONDecodeError:
            raise RuntimeError(f"firestore export: HTTP {e.code}") from None


def run_backup(project: str, bucket: str, day: str, post=_post, token=_token) -> dict:
    """Start the export. Returns the long-running operation name.

    Deliberately does NOT wait for completion: a Firestore export takes minutes and
    the operation is durable server-side, so blocking a function on it buys nothing
    and risks a timeout that reports failure over a backup that actually succeeded.
    """
    url = f"{HOST}/v1/projects/{project}/databases/(default):exportDocuments"
    out = post(url, export_body(bucket, day), token())
    return {"operation": out.get("name"), "outputUriPrefix": output_uri(bucket, day)}
