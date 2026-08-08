"""SimpleFIN Bridge -> Firestore sync (project: marreddy-cashflow).

The daily heartbeat half of the dual-source ingest
(docs/superpowers/specs/2026-08-02-dual-source-ingest.md). SimpleFIN gives raw
statement text and the bank's own balance every morning; it gives NO categories,
so this file deliberately never writes `sourceCategory` — leaving the field
absent is exactly what lets a later Monarch CSV enrich the same row.

The same real charge arrives from both sources with different identities, so
every write goes through fingerprint matching (account + signed cents, +/-3 days,
one-to-one) and ENRICHES an existing row rather than inserting a twin.

Protocol: a base64 SETUP TOKEN decodes to a claim URL; POSTing it ONCE returns a
long-lived access URL with HTTP Basic credentials embedded. After that it is one
`GET <access>/accounts?start-date=&end-date=` a day.

HTTP is stdlib urllib, not requests: two calls, no retries worth a dependency.
Mapping/anchoring rules are reused from sync_core so both sources agree on what
"never guess an account" and "never trust a stale balance" mean.
"""
from __future__ import annotations

import base64
import datetime as dt
import json
import urllib.request
from collections import defaultdict
from decimal import ROUND_HALF_UP, Decimal
from urllib.parse import unquote, urlsplit, urlunsplit

import sync_core
# Moved to sync_core (they were never SimpleFIN-specific); re-exported so this
# module and its tests keep their existing names.
from sync_core import (DOC_FIELDS, MATCH_DAYS, date_key_of, fingerprint,  # noqa: F401
                       merge_fields, pick_match, signed_cents_of, to_cents)

SOURCE = "simplefin"
# SimpleFIN's documented ceiling: no history older than 90 days, <=24 requests/day.
HISTORY_DAYS = 90
# The date axis is the unreliable one — banks post on a different day than the
# aggregator records — so amount+account match exactly and the date gets slack.
# Fields of a mapped row that belong in the Firestore doc; everything else on the
# row (sf_id / signed_cents / date_key) is sync bookkeeping and must not be written.


# ---------------------------------------------------------------------------
# HTTP (injectable — the tests never touch the network)
# ---------------------------------------------------------------------------

# urllib's default UA ("Python-urllib/3.x") is 403'd by the CDN in front of
# bridge.simplefin.org. Identify the app instead — this is their documented
# developer API, it just wants a real User-Agent.
UA = "CashFlowForecast/1.0 (+https://cashflowforcast.com)"


def _post(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(
        url, data=b"", method="POST",
        headers={"User-Agent": UA, "Content-Length": "0", "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode()


def _get(url: str, auth: str | None = None, timeout: int = 60) -> str:
    headers = {"User-Agent": UA, "Accept": "application/json"}
    if auth:
        headers["Authorization"] = auth
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode()


def claim_setup_token(setup_token: str, post=_post) -> str:
    """Setup token -> access URL. The token is SINGLE USE: a second claim burns it
    and returns 403, so the caller must persist what comes back."""
    tok = (setup_token or "").strip()
    if not tok:
        raise ValueError("empty setup token")
    claim_url = base64.b64decode(tok + "=" * (-len(tok) % 4)).decode().strip()
    if not claim_url.startswith("https://"):
        raise ValueError(f"setup token did not decode to an https claim URL: {claim_url[:60]!r}")
    access = (post(claim_url) or "").strip()
    if not access.startswith("http") or "@" not in access:
        raise RuntimeError(f"claim returned no access URL: {access[:80]!r}")
    return access


def split_auth(access_url: str):
    """(base_url, basic_header). SimpleFIN embeds credentials in the URL
    (https://user:pass@host/simplefin); urllib ignores userinfo, so it has to move
    into an Authorization header or every request 401s."""
    p = urlsplit(access_url.strip())
    netloc = p.hostname or ""
    if p.port:
        netloc = f"{netloc}:{p.port}"
    base = urlunsplit((p.scheme, netloc, p.path.rstrip("/"), "", ""))
    if not p.username:
        return base, None
    raw = f"{unquote(p.username)}:{unquote(p.password or '')}".encode()
    return base, "Basic " + base64.b64encode(raw).decode()


def fetch_accounts(access_url: str, start_ts: int, end_ts: int, get=_get) -> dict:
    """GET /accounts for the window. A non-empty `errors` array means at least one
    institution needs attention — raised loudly rather than syncing a partial day
    that would look like a normal (quiet) drop in activity."""
    base, auth = split_auth(access_url)
    url = f"{base}/accounts?start-date={int(start_ts)}&end-date={int(end_ts)}"
    data = json.loads(get(url, auth))
    errs, warns = [], []
    for e in (data.get("errors") or []):
        if not e:
            continue
        # Advisory, not a failure: the server still returns the capped range.
        (warns if "capped" in str(e).lower() else errs).append(str(e))
    if warns:
        data["warnings"] = warns
    if errs:
        raise RuntimeError("SimpleFIN errors: " + "; ".join(errs))
    return data


# ---------------------------------------------------------------------------
# Mapping
# ---------------------------------------------------------------------------

def map_sf_txn(t: dict, account_id: str, provider: str):
    """SimpleFIN transaction -> app row dict, or None for rows that must not be
    written (pending, zero amount, no posted date). Mirrors sync_core.map_txn's
    conventions; the deliberate difference is NO sourceCategory."""
    posted = t.get("posted") or t.get("transacted_at")
    if posted in (None, ""):
        return None
    cents = to_cents(t.get("amount") or 0)
    if cents == 0:
        return None

    date_key = dt.datetime.fromtimestamp(int(posted), sync_core.TZ).date().isoformat()
    y, m, d = (int(p) for p in date_key.split("-"))

    payee = (t.get("payee") or "").strip()
    statement = (t.get("description") or "").strip()
    title = payee or statement or "Transaction"
    return {
        "title": title,
        "amount": abs(cents) / 100,
        "type": "income" if cents > 0 else "expense",
        "category": sync_core.map_category(title),
        "merchant": payee or None,
        # Raw statement text, never the cleaned payee — personFrom() Zelle
        # attribution (flows.ts) reads this field.
        "description": statement or None,
        "paymentMethod": provider or "other",
        "accountId": account_id,
        "date": dt.datetime(y, m, d, tzinfo=sync_core.TZ),
        "fingerprint": fingerprint(account_id, cents, date_key),
        # bookkeeping (never written — see DOC_FIELDS)
        "sf_id": str(t.get("id")),
        "signed_cents": cents,
        "date_key": date_key,
    }


def adapt_account(sa: dict) -> dict:
    """SimpleFIN account -> the shape sync_core's matcher and balance guards read,
    so 'refuse ambiguity' and 'never trust a stale balance' have ONE definition
    across both ingest sources. `balance` (posted) is used, not available-balance:
    the anchor has to line up with posted transactions."""
    org = (sa.get("org") or {}).get("name") or ""
    stamp = sa.get("balance-date")
    return {
        "id": str(sa.get("id")),
        # org + name widens what the last-4 / name-contains matcher can see
        "displayName": f"{org} {sa.get('name') or ''}".strip(),
        "mask": None,
        "currentBalance": sa.get("balance"),
        "displayLastUpdatedAt": (
            dt.datetime.fromtimestamp(int(stamp), dt.timezone.utc).isoformat()
            if stamp else None),
    }


# ---------------------------------------------------------------------------
# Window + matching
# ---------------------------------------------------------------------------

def _midnight_ts(d: dt.date) -> int:
    return int(dt.datetime(d.year, d.month, d.day, tzinfo=sync_core.TZ).timestamp())


def fetch_window(last_sync_date, today: dt.date | None = None):
    """(start_ts, end_ts) unix seconds. Reaches back OVERLAP_DAYS for late-posting
    rows — clamped to SimpleFIN's 90-day history, which is a hard server limit, not
    a preference — and ends TOMORROW so today's rows are always in range."""
    today = today or dt.date.fromisoformat(sync_core.today_key())
    # The window ENDS tomorrow, so the floor must be HISTORY_DAYS-1 back or the
    # span is 91 days and the server caps it (and complains).
    floor = today - dt.timedelta(days=HISTORY_DAYS - 1)
    start = floor
    if last_sync_date:
        start = (dt.date.fromisoformat(str(last_sync_date)[:10])
                 - dt.timedelta(days=sync_core.OVERLAP_DAYS))
    return _midnight_ts(max(start, floor)), _midnight_ts(today + dt.timedelta(days=1))


# ---------------------------------------------------------------------------
# The sync
# ---------------------------------------------------------------------------

async def run_simplefin_sync(db, uid: str, access_url: str,
                             dry_run: bool = False, log=print) -> dict:
    """One SimpleFIN pass. Raises on failure — the caller (main.py) decides how to
    record it. dry_run: Firestore reads only, every write logged."""
    from google.cloud import firestore as gcf
    from google.cloud.firestore_v1.base_query import FieldFilter

    today = sync_core.today_key()
    meta_ref = db.collection("meta").document("simplefinSync")
    meta_snap = meta_ref.get()
    meta = meta_snap.to_dict() if meta_snap.exists else {}

    # The secret wins; the claim endpoint's stored URL is the fallback so the owner
    # can claim once and never touch a secret.
    access_url = (access_url or meta.get("accessUrl") or "").strip()
    if not access_url:
        raise RuntimeError("no SimpleFIN access URL (set SIMPLEFIN_ACCESS_URL "
                           "or run the simplefin_claim endpoint once)")

    user_ref = db.collection("users").document(uid)
    acc_col = user_ref.collection("accounts")
    app_accounts = [{"id": d.id, **(d.to_dict() or {})} for d in acc_col.stream()]

    start_ts, end_ts = fetch_window(meta.get("lastSyncDate"))
    start_key = dt.datetime.fromtimestamp(start_ts, sync_core.TZ).date().isoformat()
    data = fetch_accounts(access_url, start_ts, end_ts)

    raw_accounts = data.get("accounts") or []
    matched, unmatched, ambiguous = sync_core.resolve_matches(
        [adapt_account(a) for a in raw_accounts], app_accounts)
    if ambiguous:
        log(f"AMBIGUOUS account matches (skipped, never guessed): {ambiguous}")
    log(f"fetched SimpleFIN since {start_key} "
        f"({len(matched)} matched / {len(unmatched)} unmatched accounts)")

    # One range read per run. Widened by MATCH_DAYS on both ends so a row that
    # posted just outside the fetch window is still available to enrich.
    tx_col = user_ref.collection("transactions")
    lo = dt.datetime.fromtimestamp(start_ts, sync_core.TZ) - dt.timedelta(days=MATCH_DAYS)
    hi = dt.datetime.fromtimestamp(end_ts, sync_core.TZ) + dt.timedelta(days=MATCH_DAYS)
    cands = defaultdict(list)  # (accountId, signed cents) -> candidate rows
    existing_ids = set()
    for d in (tx_col.where(filter=FieldFilter("date", ">=", lo))
                    .where(filter=FieldFilter("date", "<", hi)).stream()):
        doc = d.to_dict() or {}
        existing_ids.add(d.id)
        if not doc.get("accountId"):
            continue
        cands[(doc["accountId"], signed_cents_of(doc))].append({
            "id": d.id,
            "date_key": date_key_of(doc.get("date")),
            "sources": set(doc.get("sources") or []),
            "doc": doc,
        })

    added = enriched = fetched = 0
    skip_pending = skip_unmatched = skip_existing = 0
    pending_seen: set[str] = set()          # pending_ ids present in THIS fetch
    pending_rows: list[tuple[dict, dict]] = []  # (app_account, row) to upsert
    max_written_date = ""
    writes = []  # (doc_ref, fields)
    for sa in raw_accounts:
        txns = sa.get("transactions") or []
        fetched += len(txns)
        pair = matched.get(str(sa.get("id")))
        if pair is None:
            skip_unmatched += len(txns)  # unmatched/ambiguous account — never guess
            continue
        app = pair[1]
        provider = app.get("provider") or "other"
        for t in sorted(txns, key=lambda x: (int(x.get("posted") or 0), str(x.get("id")))):
            row = map_sf_txn(t, app["id"], provider)
            if row is None:
                continue

            # PENDING rows are live state, not history: the same charge re-posts
            # later with a different id AND often a different amount (tip, fuel
            # hold), so they can never be fingerprint-matched to their posted
            # twin. They are written under a pending_ id, refreshed every run,
            # and deleted the moment they stop being pending — see the
            # reconciliation pass below.
            if t.get("pending"):
                pending_seen.add("pending_" + row["sf_id"])
                pending_rows.append((app, row))
                skip_pending += 1
                continue

            doc_id = "sf_" + row["sf_id"]
            # Our own row already exists: leave it alone, re-writing would revert
            # the owner's manual edits every morning.
            if doc_id in existing_ids:
                skip_existing += 1
                continue

            bucket = cands[(app["id"], row["signed_cents"])]
            hit = pick_match(bucket, row["date_key"], source=SOURCE)
            if hit is not None:
                bucket.remove(hit)  # one-to-one: one row can never absorb two
                patch = merge_fields(hit["doc"], row)
                patch["sources"] = gcf.ArrayUnion([SOURCE])
                patch["updatedAt"] = gcf.SERVER_TIMESTAMP
                enriched += 1
                writes.append((tx_col.document(hit["id"]), patch))
                if dry_run:
                    log(f"  would enrich {hit['id']}: +{SOURCE} "
                        f"{row['date_key']} {row['signed_cents'] / 100:>10.2f} "
                        f"{row['title'][:32]!r}")
                continue

            fields = {k: v for k, v in row.items() if k in DOC_FIELDS and v is not None}
            fields["sources"] = [SOURCE]
            fields["updatedAt"] = gcf.SERVER_TIMESTAMP
            added += 1
            if row["date_key"] > max_written_date:
                max_written_date = row["date_key"]
            writes.append((tx_col.document(doc_id), fields))
            if dry_run:
                log(f"  would write {doc_id}: {row['date_key']} "
                    f"{row['signed_cents'] / 100:>10.2f} {row['type']:<8} "
                    f"{row['title'][:32]!r} -> {app.get('name')}")

    # --- pending reconciliation -------------------------------------------
    # Pending charges are a SET, not a log: upsert everything currently pending,
    # then delete every pending_ doc we previously wrote that is absent now (it
    # either posted — and arrived above under its real id — or was declined).
    # This is what stops a $50 hold and its $58 posted twin both surviving.
    pending_writes = []
    for app, row in pending_rows:
        fields = {k: row[k] for k in DOC_FIELDS if row.get(k) is not None}
        fields.update({"pending": True, "sources": [SOURCE],
                       "updatedAt": gcf.SERVER_TIMESTAMP})
        pending_writes.append((tx_col.document("pending_" + row["sf_id"]), fields))
        if dry_run:
            log(f"  would write PENDING pending_{row['sf_id']}: {row['date_key']} "
                f"{row['signed_cents'] / 100:>10.2f} {row['title'][:32]!r} -> {app.get('name')}")

    stale_pending = [i for i in existing_ids
                     if i.startswith("pending_") and i not in pending_seen]
    if stale_pending and dry_run:
        log(f"  would clear {len(stale_pending)} pending row(s) that posted or were declined")

    if not dry_run:
        for i in range(0, len(writes) + len(pending_writes), 450):
            batch = db.batch()
            for ref, fields in (writes + pending_writes)[i:i + 450]:
                batch.set(ref, fields, merge=True)
            batch.commit()
        for i in range(0, len(stale_pending), 450):
            batch = db.batch()
            for doc_id in stale_pending[i:i + 450]:
                batch.delete(tx_col.document(doc_id))
            batch.commit()

    # Balance re-anchor, guarded exactly like the Monarch path: (1) first run only
    # SEEDS lastBalances, (2) an untrustworthy (manual/disabled/stale) balance never
    # overwrites a good anchor, (3) it fires only when the balance moved.
    # openingDate is TOMORROW: deriveAccountBalance counts rows with day >=
    # openingDate and the bank balance already contains today's rows.
    last_bal = meta.get("lastBalances") or {}
    first_run = not last_bal
    new_bal, reanchored, balance_skips = {}, [], []
    for sid, (adapted, app) in matched.items():
        cur = adapted.get("currentBalance")
        if cur is None:
            continue
        cur = float(cur)
        ok, why = sync_core.balance_is_trustworthy(adapted)
        if not ok:
            balance_skips.append(f"{app.get('name')}: {why}")
            continue
        new_bal[sid] = cur
        if first_run:
            continue  # seed only — never re-anchor everything on the first pass
        if sid in last_bal and float(last_bal[sid]) == cur:
            continue
        # Anchored at the balance's OWN date (see sync_core.anchor_when), never
        # behind the stored anchor.
        anchor_date = sync_core.anchor_when(adapted, today)
        stored_anchor = str(app.get("openingDate") or "")[:10]
        if stored_anchor and anchor_date < stored_anchor:
            balance_skips.append(
                f"{app.get('name')}: balance dated {anchor_date} is older than its anchor {stored_anchor}")
            continue
        opening = sync_core.opening_balance_for(app.get("type"), cur)
        reanchored.append(f"{app.get('name')}: {opening} @ {anchor_date}")
        if dry_run:
            log(f"  would re-anchor {app.get('name')!r}: "
                f"openingBalance={opening} openingDate={anchor_date}")
        else:
            acc_col.document(app["id"]).set(
                {"openingBalance": opening, "openingDate": anchor_date,
                 "updatedAt": gcf.SERVER_TIMESTAMP}, merge=True)
    if first_run:
        log("first run: seeded balances, re-anchored nothing (changes act from the next run)")
    if balance_skips:
        log(f"balances NOT trusted (anchor left alone): {balance_skips}")

    # Never advance to wall-clock today: a run that returned nothing would silently
    # skip the gap.
    prev_cursor = str(meta.get("lastSyncDate") or "")[:10]
    next_cursor = max(filter(None, [max_written_date, prev_cursor, start_key])) or today

    status = {
        "lastRun": sync_core.now_iso(),
        "lastSuccess": sync_core.now_iso(),
        "lastSyncDate": next_cursor,
        "fetched": fetched,
        "added": added,
        "enriched": enriched,
        "pendingLive": len(pending_rows),
        "pendingCleared": len(stale_pending),
        "skippedUnmatched": skip_unmatched,
        "skippedAlreadySynced": skip_existing,
        "unmatchedAccounts": sorted(set(unmatched)),
        "ambiguousAccounts": ambiguous,
        "untrustedBalances": balance_skips,
        "lastBalances": new_bal,
        "reanchored": reanchored,
        "error": "",
    }
    if not dry_run:
        meta_ref.set(status, merge=True)
    log(f"simplefin done: fetched {fetched}, +{added} added, {enriched} enriched, "
        f"pending live {len(pending_rows)} / cleared {len(stale_pending)}, "
        f"skipped(unmatched {skip_unmatched} / "
        f"already {skip_existing}), {len(reanchored)} re-anchored, "
        f"cursor -> {next_cursor}, unmatched={sorted(set(unmatched))}")
    return status
