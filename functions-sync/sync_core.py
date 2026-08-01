"""Monarch Money -> Firestore sync core (project: marreddy-cashflow).

Pure mapping logic + the orchestrator. Deliberately mirrors the app's CSV import
(src/components/CSVImportModal.tsx, 'monarch' format) so synced rows are
indistinguishable from CSV-imported ones to the classifier (src/lib/classify.ts)
and the Flow engine:

  - title        = Monarch merchant name (the CSV path had no Description column,
                   so title fell through to Merchant)
  - amount       = abs(signed), sign -> type income/expense
  - 'Transfer' / 'Credit Card Payment' (exact) -> type transfer + direction by sign
  - sourceCategory = Monarch category VERBATIM
  - category     = same keyword heuristic as mapCategory()
  - description  = plaidName (original statement) else notes else absent — the
                   statement text feeds personFrom() Zelle attribution (flows.ts)
  - date         = America/New_York midnight, stored as a Firestore timestamp
                   (same instant the browser importer produced)

Doc id: mm_{monarch_txn_id} (idempotent; Monarch edits flow through on re-sync).
Cross-scheme guard: before writing, the CSV importKey() twin id is computed
byte-for-byte and the row is skipped if that doc already exists.

Module-level imports are stdlib only so test_sync.py runs without the cloud deps.
"""
from __future__ import annotations

import datetime as dt
import re
from collections import defaultdict
from urllib.parse import quote
from zoneinfo import ZoneInfo

OWNER_EMAIL = "bhuvaneswar.marreddy@gmail.com"
PROJECT = "marreddy-cashflow"
CUTOVER = "2026-07-23"  # last full CSV import — first-run cursor
OVERLAP_DAYS = 5  # re-fetch window for late-posting rows
TZ = ZoneInfo("America/New_York")
DEBT_TYPES = {"credit_card", "personal_loan"}


def now_iso() -> str:
    return dt.datetime.now(TZ).isoformat()


def today_key() -> str:
    return dt.datetime.now(TZ).date().isoformat()


# ---------------------------------------------------------------------------
# importKey — byte-for-byte port of CSVImportModal.importKey (TypeScript)
# ---------------------------------------------------------------------------

def to_fixed_2(x: float) -> str:
    """JS Number.prototype.toFixed(2). (-0).toFixed(2) === '0.00' in JS."""
    if x == 0:
        return "0.00"
    # Monarch money is exact at 2dp, so no JS-vs-Python tie-rounding divergence.
    return f"{x:.2f}"


def encode_uri_component(s: str) -> str:
    """JS encodeURIComponent: escapes all but A-Za-z0-9 - _ . ! ~ * ' ( )."""
    return quote(s, safe="!'()*-._~")


def import_key(date_key: str, signed_amount: float, account: str,
               statement: str, occurrence: int) -> str:
    """Port of importKey() — the CSV importer's deterministic Firestore doc id."""
    m = re.search(r"(\d{4})\D*$", account)
    account_part = m.group(1) if m else account.strip().lower()
    material = "|".join([
        date_key,
        to_fixed_2(signed_amount),
        account_part,
        re.sub(r"\s+", " ", statement.strip().lower()),
        str(occurrence),
    ])
    return "imp_" + encode_uri_component(material)


# ---------------------------------------------------------------------------
# Transaction mapping — mirrors parseCSV()'s 'monarch' branch
# ---------------------------------------------------------------------------

def is_transfer_category(category: str) -> bool:
    """Exact match only — 'Transfer Fee' is a genuine expense."""
    lower = category.strip().lower()
    return lower in ("transfer", "credit card payment")


_CATEGORY_RULES = [
    (("food", "restaurant", "dining", "groceries"), "food"),
    (("transport", "uber", "lyft", "gas", "fuel"), "transportation"),
    (("entertainment", "movie", "netflix", "spotify"), "entertainment"),
    (("shopping", "amazon", "retail"), "shopping"),
    (("health", "medical", "pharmacy", "doctor"), "healthcare"),
    (("utility", "electric", "water", "internet", "phone"), "utilities"),
    (("rent", "mortgage", "housing"), "rent"),
    (("insurance",), "insurance"),
    (("subscription", "membership"), "subscriptions"),
    (("travel", "hotel", "flight", "airbnb"), "travel"),
    (("education", "tuition", "book"), "education"),
    (("invest", "saving"), "investments"),
]


def map_category(category: str) -> str:
    """Port of mapCategory() — order is load-bearing, keep in sync with the TS."""
    lower = category.lower()
    for needles, cat in _CATEGORY_RULES:
        if any(n in lower for n in needles):
            return cat
    return "other"


def map_txn(t: dict):
    """Monarch API transaction -> app row dict, or None for unusable rows
    (no date/amount, or zero amount — the CSV marks those invalid)."""
    date_key = str(t.get("date") or "")[:10]
    amt = t.get("amount")
    if not date_key or amt is None:
        return None
    signed = float(amt)
    if signed == 0:
        return None  # 'Zero amount' rows never import
    ttype = "expense" if signed < 0 else "income"

    merchant = ((t.get("merchant") or {}).get("name") or "").strip()
    # CSV monarch rows have no Description column, so title falls to Merchant.
    # ponytail: CSV's last fallback is 'Transaction {rowIndex}' — no stable index
    # exists here, so plain 'Transaction'; the id is mm_<id> so nothing re-keys.
    title = merchant or "Transaction"

    category_str = ((t.get("category") or {}).get("name") or "")
    category = map_category(category_str or title)

    # Loan auto-detect (verbatim from parseCSV).
    lt = title.lower()
    if "loan" in lt or "upstart" in lt or "sofi" in lt or "lending" in lt:
        category, ttype = "other", "expense"

    lc = category_str.strip().lower()
    if "income" in lc or "salary" in lc or "paycheck" in lc:
        ttype = "income"

    direction = None
    if is_transfer_category(category_str):
        ttype = "transfer"
        direction = "out" if signed < 0 else "in"

    plaid = (t.get("plaidName") or "").strip()
    notes = (t.get("notes") or "").strip()
    acct = t.get("account") or {}
    return {
        "monarch_id": str(t.get("id")),
        "monarch_account_id": str(acct.get("id") or ""),
        "monarch_account_name": (acct.get("displayName") or ""),
        "pending": bool(t.get("pending")),
        "date_key": date_key,
        "signed": signed,
        "amount": abs(signed),
        "type": ttype,
        "transferDirection": direction,
        "title": title,
        "category": category,
        "sourceCategory": category_str.strip() or None,  # verbatim, like the CSV
        "merchant": merchant or None,
        # Statement text first — it feeds personFrom() Zelle attribution, matching
        # the 2026-07-23 backfill that set description = Original Statement.
        "description": plaid or notes or None,
        "statement": plaid,  # the importKey 'statement' component
    }


# ---------------------------------------------------------------------------
# Account matching / balances / cursor
# ---------------------------------------------------------------------------

def match_account(monarch_name: str, monarch_mask, app_accounts: list):
    """Mirror of matchAccountByName(): last-4 wins (survives renames), then
    name-contains. The CSV's provider-contains fallback is dropped — too guessy
    for an unattended job; unmatched accounts are reported, never guessed."""
    lower = (monarch_name or "").lower()
    mask = str(monarch_mask or "")
    if not lower:
        return None
    for a in app_accounts:
        l4 = a.get("lastFourDigits")
        if l4 and (l4 == mask or l4 in lower):
            return a
    for a in app_accounts:
        name = (a.get("name") or "").lower()
        if name and name in lower:
            return a
    return None


def opening_balance_for(account_type, monarch_balance: float) -> float:
    """App stores debt as POSITIVE amount owed (seed_balances.py); Monarch reports
    liabilities as negative currentBalance. Negate for debt — never clamp, a
    negative owed is a legitimate credit balance (accounts-redesign spec)."""
    b = float(monarch_balance)
    return round(-b, 2) if account_type in DEBT_TYPES else round(b, 2)


def cursor_start(last_sync_date) -> str:
    """Fetch-from date: lastSyncDate minus the overlap window; CUTOVER on first run
    (the CSV import already covers everything through CUTOVER)."""
    if not last_sync_date:
        return CUTOVER
    d = dt.date.fromisoformat(str(last_sync_date)[:10])
    return (d - dt.timedelta(days=OVERLAP_DAYS)).isoformat()


def twin_label(app_account: dict, monarch_name: str) -> str:
    """The 'account' string fed to import_key for the twin check. The CSV label
    carried '(...1234)', so its key component was the last-4 — which is exactly
    the app account's lastFourDigits. Accounts without one (Apple Card) fell back
    to the whole label lowercased, which equals the Monarch display name."""
    return app_account.get("lastFourDigits") or monarch_name


# ---------------------------------------------------------------------------
# Monarch client (lazy imports — cloud/venv only)
# ---------------------------------------------------------------------------

async def connect_monarch(saved_token, email, password, mfa_secret, log=print):
    """Returns (mm, accounts_response, fresh_login). Reuses the saved session
    token when it still works; logs in with credentials only when it doesn't
    (avoids daily fresh logins / bot flags)."""
    from monarchmoney import MonarchMoney

    if saved_token:
        mm = MonarchMoney(token=saved_token)
        try:
            return mm, await mm.get_accounts(), False
        except Exception as e:  # expired/revoked session — fall through to login
            log(f"saved Monarch session rejected ({type(e).__name__}: {e}); logging in fresh")
    if not email or not password:
        raise RuntimeError("no valid Monarch session and MONARCH_EMAIL/MONARCH_PASSWORD not set")
    mm = MonarchMoney()
    mfa = (mfa_secret or "").strip()  # empty/whitespace secret -> login without MFA
    await mm.login(email, password, mfa_secret_key=mfa or None)
    return mm, await mm.get_accounts(), True


async def fetch_transactions(mm, start_date: str, page: int = 500) -> list:
    out, offset = [], 0
    while True:
        resp = await mm.get_transactions(limit=page, offset=offset, start_date=start_date)
        block = resp.get("allTransactions") or {}
        results = block.get("results") or []
        out.extend(results)
        offset += len(results)
        total = block.get("totalCount")
        if not results or (total is not None and offset >= int(total)):
            return out


# ---------------------------------------------------------------------------
# The sync
# ---------------------------------------------------------------------------

async def run_sync(db, uid: str, email: str, password: str, mfa_secret: str,
                   dry_run: bool = False, log=print) -> dict:
    """One sync pass. Raises on failure — the callers (main.py / dryrun.py)
    decide how to record it. dry_run: Firestore reads only, every write logged."""
    from google.cloud import firestore as gcf

    today = today_key()
    meta_ref = db.collection("meta").document("monarchSync")
    meta_snap = meta_ref.get()
    meta = meta_snap.to_dict() if meta_snap.exists else {}

    mm, accounts_resp, fresh = await connect_monarch(
        meta.get("session"), email, password, mfa_secret, log=log)
    if fresh and not dry_run:
        meta_ref.set({"session": mm.token}, merge=True)

    monarch_accounts = accounts_resp.get("accounts") or []

    user_ref = db.collection("users").document(uid)
    acc_col = user_ref.collection("accounts")
    app_accounts = [{"id": d.id, **(d.to_dict() or {})} for d in acc_col.stream()]

    matched, unmatched = {}, []
    for ma in monarch_accounts:
        name = ma.get("displayName") or ""
        app = match_account(name, ma.get("mask"), app_accounts)
        if app:
            matched[str(ma.get("id"))] = (ma, app)
        else:
            unmatched.append(name or str(ma.get("id")))

    start = cursor_start(meta.get("lastSyncDate"))
    log(f"fetching Monarch transactions since {start} "
        f"({len(matched)} matched / {len(unmatched)} unmatched accounts)")
    txns = await fetch_transactions(mm, start)
    log(f"fetched {len(txns)} transactions")

    tx_col = user_ref.collection("transactions")
    existing = {r.id for r in tx_col.list_documents(page_size=1000)}

    added = updated = skipped = 0
    writes = []  # (doc_id, fields)
    # Occurrence counter mirrors the CSV importer: content-keyed on the same base
    # material, assigned in a deterministic order.
    occ = defaultdict(int)
    for t in sorted(txns, key=lambda x: (str(x.get("date") or ""), str(x.get("id")))):
        row = map_txn(t)
        if row is None or row["pending"]:
            skipped += 1
            continue
        pair = matched.get(row["monarch_account_id"])
        if pair is None:
            skipped += 1  # unmatched account — never guess
            continue
        ma, app = pair

        # Cross-scheme overlap guard: skip rows the CSV import already owns.
        label = twin_label(app, row["monarch_account_name"])
        base = import_key(row["date_key"], row["signed"], label, row["statement"], 0)
        k = occ[base]
        occ[base] += 1
        twin = import_key(row["date_key"], row["signed"], label, row["statement"], k)
        if twin in existing:
            skipped += 1
            continue

        y, m, d = (int(p) for p in row["date_key"].split("-"))
        fields = {
            "title": row["title"],
            "amount": row["amount"],
            "type": row["type"],
            "category": row["category"],
            "paymentMethod": app.get("provider") or "other",
            "date": dt.datetime(y, m, d, tzinfo=TZ),  # NY midnight, like the browser importer
            "accountId": app["id"],
            "updatedAt": gcf.SERVER_TIMESTAMP,
        }
        # Optional fields omitted (not blanked) when absent — merge semantics.
        for opt in ("transferDirection", "sourceCategory", "merchant", "description"):
            if row[opt] is not None:
                fields[opt] = row[opt]

        doc_id = f"mm_{row['monarch_id']}"
        if doc_id in existing:
            updated += 1
        else:
            added += 1
        writes.append((doc_id, fields))
        if dry_run:
            log(f"  would write {doc_id}: {row['date_key']} "
                f"{row['signed']:>10.2f} {row['type']:<8} {row['title'][:32]!r} "
                f"-> {app.get('name')}")

    if not dry_run:
        for i in range(0, len(writes), 450):  # Firestore batch limit is 500
            batch = db.batch()
            for doc_id, fields in writes[i:i + 450]:
                batch.set(tx_col.document(doc_id), fields, merge=True)
            batch.commit()

    # Balance re-anchor: only when the Monarch balance moved since the last sync
    # (avoids daily churn). openingBalance = current, openingDate = today — the
    # same re-anchor the app itself performs on drift (src/lib/accounts.ts).
    # ponytail: rows dated today double-count against a today-anchored balance
    # until tomorrow; identical ceiling to the app's own drift re-anchor.
    last_bal = meta.get("lastBalances") or {}
    new_bal, reanchored = {}, []
    for mid, (ma, app) in matched.items():
        cur = ma.get("currentBalance")
        if cur is None:
            continue
        cur = float(cur)
        new_bal[mid] = cur
        if mid in last_bal and float(last_bal[mid]) == cur:
            continue
        opening = opening_balance_for(app.get("type"), cur)
        reanchored.append(f"{app.get('name')}: {opening} @ {today}")
        if dry_run:
            log(f"  would re-anchor {app.get('name')!r}: openingBalance={opening} openingDate={today}")
        else:
            acc_col.document(app["id"]).set(
                {"openingBalance": opening, "openingDate": today,
                 "updatedAt": gcf.SERVER_TIMESTAMP},
                merge=True)

    status = {
        "lastRun": now_iso(),
        "lastSuccess": now_iso(),
        "lastSyncDate": today,
        "added": added,
        "updated": updated,
        "skipped": skipped,
        "unmatchedAccounts": sorted(unmatched),
        "lastBalances": new_bal,
        "reanchored": reanchored,
        "error": "",
    }
    if not dry_run:
        meta_ref.set(status, merge=True)
    log(f"sync done: +{added} added, {updated} updated, {skipped} skipped, "
        f"{len(reanchored)} re-anchored, unmatched={sorted(unmatched)}")
    return status
