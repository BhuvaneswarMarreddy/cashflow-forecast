"""Plaid -> Firestore sync (project: marreddy-cashflow).

The REAL-TIME half of the ingest. SimpleFIN reads MX's once-a-day cache and can
never produce today's balance; Plaid's /accounts/balance/get is a documented
live extraction from the bank at call time (p50 ~3s, p95 ~11s), and
/transactions/sync pulls up to 730 days of history with cursor-exact deltas.

Trial-plan discipline (10 PRODUCTION ITEMS, LIFETIME — deleting does NOT free a
slot): this module never calls /item/remove. A broken connection is repaired
with Link UPDATE MODE (create_link_token with the existing access_token), never
by re-linking, because a fresh link burns a slot forever.

Credentials: PLAID_CLIENT_ID / PLAID_SECRET are Firebase secrets. Access tokens
live in meta/plaid (default-deny to clients; admin SDK only) and are NEVER
returned to the browser, logged, or written into the status doc — the status
doc is meta/plaidSync, a separate document, so a status merge can never leak a
token. Same rule as the SimpleFIN access URL.

Sign conventions (both flipped here, nowhere else):
- transactions: Plaid amount is POSITIVE for money OUT; the app is the reverse.
- balances: Plaid reports credit-card debt as POSITIVE owed; the shared
  opening_balance_for() expects Monarch's liabilities-negative convention, so
  the adapter negates debt balances to keep ONE definition of that rule.

Mapping/anchoring/dedupe reuse simplefin.py + sync_core so all three sources
agree on "never guess an account", "never trust the wrong balance", and
"one-to-one fingerprint matching, never a twin".
"""
from __future__ import annotations

import datetime as dt
import json
import urllib.request
from collections import defaultdict

import simplefin
import sync_core
from simplefin import (DOC_FIELDS, MATCH_DAYS, date_key_of, fingerprint,
                       merge_fields, pick_match, signed_cents_of, to_cents)

SOURCE = "plaid"
HOST = "https://production.plaid.com"
# Link-token-time knob: how much history the FIRST /transactions/sync returns.
# 730 is Plaid's maximum — this is what finally reaches past SimpleFIN's 90-day wall.
DAYS_REQUESTED = 730
UA = "CashFlowForecast/1.0 (+https://cashflowforcast.com)"

DEBT_PLAID_TYPES = ("credit", "loan")


# ---------------------------------------------------------------------------
# HTTP (injectable — the tests never touch the network)
# ---------------------------------------------------------------------------

def _post(path: str, payload: dict, timeout: int = 60) -> dict:
    req = urllib.request.Request(
        HOST + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "User-Agent": UA},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        # Plaid errors are JSON with error_code/error_message — surface those,
        # never the request body (it carries the secret).
        body = e.read().decode(errors="replace")
        try:
            err = json.loads(body)
            raise RuntimeError(
                f"plaid {path}: {err.get('error_code')} {err.get('error_message')}") from None
        except json.JSONDecodeError:
            raise RuntimeError(f"plaid {path}: HTTP {e.code}") from None


# ---------------------------------------------------------------------------
# Link + exchange (called from main.py callables)
# ---------------------------------------------------------------------------

def link_token_payload(client_id: str, secret: str, uid: str,
                       access_token: str | None = None) -> dict:
    """The /link/token/create body. UPDATE MODE (access_token set) repairs an
    existing Item in place — the only sanctioned fix on a 10-lifetime-Item plan."""
    body = {
        "client_id": client_id,
        "secret": secret,
        "client_name": "CashFlow Forecast",
        "language": "en",
        "country_codes": ["US"],
        "user": {"client_user_id": uid},
    }
    if access_token:
        body["access_token"] = access_token  # update mode: no products key
    else:
        body["products"] = ["transactions"]
        body["transactions"] = {"days_requested": DAYS_REQUESTED}
    return body


def create_link_token(client_id: str, secret: str, uid: str,
                      access_token: str | None = None, post=_post) -> str:
    out = post("/link/token/create",
               link_token_payload(client_id, secret, uid, access_token))
    return out["link_token"]


def exchange_public_token(client_id: str, secret: str, public_token: str,
                          post=_post) -> tuple[str, str]:
    out = post("/item/public_token/exchange",
               {"client_id": client_id, "secret": secret, "public_token": public_token})
    return out["access_token"], out["item_id"]


# ---------------------------------------------------------------------------
# Mapping
# ---------------------------------------------------------------------------

def prettify_pfc(category) -> str | None:
    """FOOD_AND_DRINK -> 'Food And Drink'. Feeds sourceCategory (the label the
    charts prefer); coarse enum category still comes from map_category."""
    primary = (category or {}).get("primary") if isinstance(category, dict) else None
    if not primary:
        return None
    return " ".join(w.capitalize() for w in str(primary).split("_")) or None


def map_pl_txn(t: dict, account_id: str, provider: str):
    """Plaid transaction -> app row dict, or None for rows that must not be
    written (zero amount, no date). Plaid amount sign is FLIPPED here."""
    date_key = str(t.get("date") or t.get("authorized_date") or "")[:10]
    if not date_key:
        return None
    cents = -to_cents(t.get("amount") or 0)  # Plaid: positive = money OUT
    if cents == 0:
        return None
    y, m, d = (int(p) for p in date_key.split("-"))

    merchant = (t.get("merchant_name") or "").strip()
    statement = (t.get("original_description") or t.get("name") or "").strip()
    title = merchant or statement or "Transaction"
    row = {
        "title": title,
        "amount": abs(cents) / 100,
        "type": "income" if cents > 0 else "expense",
        "category": sync_core.map_category(title),
        "merchant": merchant or None,
        # Raw statement text — personFrom() Zelle attribution reads this field.
        "description": statement or None,
        "paymentMethod": provider or "other",
        "accountId": account_id,
        "date": dt.datetime(y, m, d, tzinfo=sync_core.TZ),
        "fingerprint": fingerprint(account_id, cents, date_key),
        # bookkeeping (never written — DOC_FIELDS filters)
        "pl_id": str(t.get("transaction_id")),
        "signed_cents": cents,
        "date_key": date_key,
        "pending": bool(t.get("pending")),
    }
    source_category = prettify_pfc(t.get("personal_finance_category"))
    if source_category:
        row["sourceCategory"] = source_category
    return row


def adapt_pl_account(acct: dict, institution: str) -> dict:
    """Plaid account -> the shape sync_core's matcher and balance guards read.
    Balance sign converted to Monarch's liabilities-negative convention so
    opening_balance_for() keeps its one definition. balance/get is a live pull,
    so the balance's own date is NOW."""
    balances = acct.get("balances") or {}
    current = balances.get("current")
    if current is not None and str(acct.get("type")) in DEBT_PLAID_TYPES:
        current = -float(current)
    name = f"{institution} {acct.get('name') or ''} {acct.get('official_name') or ''}".strip()
    return {
        "id": str(acct.get("account_id")),
        "displayName": name,
        "mask": acct.get("mask"),
        "currentBalance": current,
        "displayLastUpdatedAt": sync_core.now_iso(),
    }


# PLAID_DOC_FIELDS: DOC_FIELDS plus sourceCategory (SimpleFIN deliberately never
# writes it; Plaid's personal_finance_category is real evidence and may).
PLAID_DOC_FIELDS = DOC_FIELDS + ("sourceCategory",)


# ---------------------------------------------------------------------------
# The sync
# ---------------------------------------------------------------------------

def _sync_item_transactions(client_id: str, secret: str, access_token: str,
                            cursor: str, post=_post):
    """Full cursor walk of /transactions/sync. Returns (added+modified rows,
    removed ids, next_cursor). `modified` is folded into added — the write loop
    upserts our own docs by id, which is exactly what a modification needs."""
    added, removed = [], []
    while True:
        body = {"client_id": client_id, "secret": secret,
                "access_token": access_token, "count": 500,
                "options": {"include_original_description": True}}
        if cursor:
            body["cursor"] = cursor
        out = post("/transactions/sync", body)
        added.extend(out.get("added") or [])
        added.extend(out.get("modified") or [])
        removed.extend(str(r.get("transaction_id")) for r in (out.get("removed") or []))
        cursor = out.get("next_cursor") or cursor
        if not out.get("has_more"):
            return added, removed, cursor


async def run_plaid_sync(db, uid: str, client_id: str, secret: str,
                         dry_run: bool = False, log=print, post=_post) -> dict:
    """One Plaid pass over every linked Item. Raises on total failure; a single
    broken Item is recorded and the rest still sync."""
    from google.cloud import firestore as gcf
    from google.cloud.firestore_v1.base_query import FieldFilter

    today = sync_core.today_key()
    cred_ref = db.collection("meta").document("plaid")      # tokens + cursors
    status_ref = db.collection("meta").document("plaidSync")  # status ONLY
    cred = (cred_ref.get().to_dict() or {})
    items = cred.get("items") or {}
    if not items:
        status = {"lastRun": sync_core.now_iso(), "lastSuccess": sync_core.now_iso(),
                  "added": 0, "error": "", "note": "no linked banks yet"}
        if not dry_run:
            status_ref.set(status, merge=True)
        return status

    user_ref = db.collection("users").document(uid)
    acc_col = user_ref.collection("accounts")
    tx_col = user_ref.collection("transactions")
    app_accounts = [{"id": d.id, **(d.to_dict() or {})} for d in acc_col.stream()]

    # ---- fetch: per-item, isolated ----------------------------------------
    adapted_accounts, rows_by_account = [], defaultdict(list)
    removed_ids: list[str] = []
    next_cursors: dict[str, str] = {}
    item_errors: list[str] = []
    account_owner_item: dict[str, str] = {}
    for item_id, item in items.items():
        label = item.get("institution") or item_id[:8]
        try:
            bal = post("/accounts/balance/get",
                       {"client_id": client_id, "secret": secret,
                        "access_token": item["accessToken"]})
            for a in bal.get("accounts") or []:
                adapted_accounts.append(adapt_pl_account(a, label))
                account_owner_item[str(a.get("account_id"))] = item_id
            added, removed, next_cursor = _sync_item_transactions(
                client_id, secret, item["accessToken"], str(item.get("cursor") or ""), post)
            for t in added:
                rows_by_account[str(t.get("account_id"))].append(t)
            removed_ids.extend(removed)
            next_cursors[item_id] = next_cursor
        except Exception as e:  # one dead bank must not kill the others
            item_errors.append(f"{label}: {e}")
            log(f"item {label} failed: {e}")

    matched, unmatched, ambiguous = sync_core.resolve_matches(adapted_accounts, app_accounts)
    if ambiguous:
        log(f"AMBIGUOUS account matches (skipped, never guessed): {ambiguous}")
    log(f"plaid: {len(matched)} matched / {len(unmatched)} unmatched accounts, "
        f"{sum(len(v) for v in rows_by_account.values())} fetched rows")

    # ---- candidates for fingerprint matching ------------------------------
    all_dates = [str(t.get("date") or "")[:10]
                 for ts in rows_by_account.values() for t in ts if t.get("date")]
    writes, pending_writes = [], []
    added_n = enriched_n = skip_existing = skip_unmatched = 0
    pending_n = 0
    max_written_date = ""
    existing_ids: set[str] = set()
    cands = defaultdict(list)
    if all_dates:
        lo_d = dt.date.fromisoformat(min(all_dates)) - dt.timedelta(days=MATCH_DAYS)
        hi_d = dt.date.fromisoformat(max(all_dates)) + dt.timedelta(days=MATCH_DAYS + 1)
        lo = dt.datetime(lo_d.year, lo_d.month, lo_d.day, tzinfo=sync_core.TZ)
        hi = dt.datetime(hi_d.year, hi_d.month, hi_d.day, tzinfo=sync_core.TZ)
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

    for account_id, txns in rows_by_account.items():
        pair = matched.get(account_id)
        if pair is None:
            skip_unmatched += len(txns)  # unmatched/ambiguous account — never guess
            continue
        app = pair[1]
        provider = app.get("provider") or "other"
        for t in sorted(txns, key=lambda x: (str(x.get("date")), str(x.get("transaction_id")))):
            row = map_pl_txn(t, app["id"], provider)
            if row is None:
                continue
            if row["pending"]:
                # Pending is a SET, refreshed every run; /transactions/sync's
                # `removed` list clears entries when they post or are declined.
                fields = {k: row[k] for k in PLAID_DOC_FIELDS if row.get(k) is not None}
                fields.update({"pending": True, "sources": [SOURCE],
                               "updatedAt": gcf.SERVER_TIMESTAMP})
                pending_writes.append((tx_col.document("pending_pl_" + row["pl_id"]), fields))
                pending_n += 1
                continue
            doc_id = "pl_" + row["pl_id"]
            if doc_id in existing_ids:
                # Ours already — a `modified` delta may legitimately update it.
                fields = {k: row[k] for k in PLAID_DOC_FIELDS if row.get(k) is not None}
                fields["updatedAt"] = gcf.SERVER_TIMESTAMP
                writes.append((tx_col.document(doc_id), fields))
                skip_existing += 1
                continue
            bucket = cands[(app["id"], row["signed_cents"])]
            hit = pick_match(bucket, row["date_key"], source=SOURCE)
            if hit is not None:
                bucket.remove(hit)  # one-to-one: one row can never absorb two
                patch = merge_fields(hit["doc"], row)
                if row.get("sourceCategory") and not hit["doc"].get("sourceCategory"):
                    patch["sourceCategory"] = row["sourceCategory"]
                patch["sources"] = gcf.ArrayUnion([SOURCE])
                patch["updatedAt"] = gcf.SERVER_TIMESTAMP
                enriched_n += 1
                writes.append((tx_col.document(hit["id"]), patch))
                if dry_run:
                    log(f"  would enrich {hit['id']}: +{SOURCE} {row['date_key']} "
                        f"{row['signed_cents'] / 100:>10.2f} {row['title'][:32]!r}")
                continue
            fields = {k: v for k, v in row.items()
                      if k in PLAID_DOC_FIELDS and v is not None}
            fields["sources"] = [SOURCE]
            fields["updatedAt"] = gcf.SERVER_TIMESTAMP
            added_n += 1
            if row["date_key"] > max_written_date:
                max_written_date = row["date_key"]
            writes.append((tx_col.document(doc_id), fields))
            if dry_run:
                log(f"  would write {doc_id}: {row['date_key']} "
                    f"{row['signed_cents'] / 100:>10.2f} {row['type']:<8} "
                    f"{row['title'][:32]!r} -> {app.get('name')}")

    # removed deltas: clear pending docs; a removed POSTED row is a bank-side
    # reversal — logged, never auto-deleted (history is the owner's to edit).
    pending_deletes = ["pending_pl_" + rid for rid in removed_ids]

    if not dry_run:
        for i in range(0, len(writes) + len(pending_writes), 450):
            batch = db.batch()
            for ref, fields in (writes + pending_writes)[i:i + 450]:
                batch.set(ref, fields, merge=True)
            batch.commit()
        for i in range(0, len(pending_deletes), 450):
            batch = db.batch()
            for doc_id in pending_deletes[i:i + 450]:
                batch.delete(tx_col.document(doc_id))
            batch.commit()

    # ---- balance re-anchor (same guards as every other source) ------------
    last_bal = cred.get("lastBalances") or {}
    first_run = not last_bal
    new_bal, reanchored, balance_skips = {}, [], []
    for aid, (adapted, app) in matched.items():
        cur = adapted.get("currentBalance")
        if cur is None:
            continue
        cur = float(cur)
        ok, why = sync_core.balance_is_trustworthy(adapted)
        if not ok:
            balance_skips.append(f"{app.get('name')}: {why}")
            continue
        new_bal[aid] = cur
        if first_run:
            continue  # seed only — never re-anchor everything on the first pass
        if aid in last_bal and float(last_bal[aid]) == cur:
            continue
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

    # cursors advance ONLY for items that completed their walk
    if not dry_run:
        patch = {"lastBalances": new_bal}
        for item_id, cur in next_cursors.items():
            patch[f"items.{item_id}.cursor"] = cur
        cred_ref.update(patch)

    status = {
        "lastRun": sync_core.now_iso(),
        "lastSuccess": sync_core.now_iso(),
        "fetched": sum(len(v) for v in rows_by_account.values()),
        "added": added_n,
        "enriched": enriched_n,
        "pendingLive": pending_n,
        "pendingCleared": len(pending_deletes),
        "skippedUnmatched": skip_unmatched,
        "skippedAlreadySynced": skip_existing,
        "unmatchedAccounts": sorted(set(unmatched)),
        "ambiguousAccounts": ambiguous,
        "untrustedBalances": balance_skips,
        "reanchored": reanchored,
        "itemErrors": item_errors,
        "error": "" if not item_errors or len(item_errors) < len(items) else
                 "; ".join(item_errors),
    }
    if not dry_run:
        status_ref.set(status, merge=True)
    log(f"plaid done: fetched {status['fetched']}, +{added_n} added, {enriched_n} enriched, "
        f"pending {pending_n}/cleared {len(pending_deletes)}, {len(reanchored)} re-anchored, "
        f"itemErrors={item_errors}")
    if item_errors and len(item_errors) == len(items):
        raise RuntimeError("every Plaid item failed: " + "; ".join(item_errors))
    return status
