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
CUTOVER = "2026-07-18"  # before the last full CSV import — twin guard dedups the overlap
# Re-fetch window. Wide on purpose: writes are idempotent (mm_ doc ids), so the
# only cost is reads, while a narrow window PERMANENTLY loses any row that posts
# late (a hold released after N days is never seen again).
OVERLAP_DAYS = 45
# Must match what the browser importer produced: `new Date(y, m-1, d)` is LOCAL
# midnight, and the owner's machine runs America/Chicago. Writing any other zone
# shifts the rendered calendar day of every synced row.
TZ = ZoneInfo("America/Chicago")
DEBT_TYPES = {"credit_card", "personal_loan"}
# A Monarch balance older than this is a broken/stale bank connection — never let
# it overwrite a good anchor.
STALE_BALANCE_HOURS = 36


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


def resolve_matches(monarch_accounts: list, app_accounts: list):
    """Match Monarch accounts -> app accounts, refusing ambiguity.

    Two Monarch accounts claiming one app account would make the balance
    re-anchor last-write-wins and misattribute transactions, so a collision
    demotes ALL of its claimants to unmatched (the same 'never guess' rule
    already applied to no-match accounts)."""
    claims = defaultdict(list)
    unmatched = []
    for ma in monarch_accounts:
        name = ma.get("displayName") or ""
        # A closed/hidden/manual Monarch account must never claim a live one.
        if ma.get("deactivatedAt") or ma.get("isHidden"):
            continue
        app = match_account(name, ma.get("mask"), app_accounts)
        if app:
            claims[app["id"]].append((ma, app))
        else:
            unmatched.append(name or str(ma.get("id")))

    matched, ambiguous = {}, []
    for app_id, pairs in claims.items():
        if len(pairs) > 1:
            names = sorted((ma.get("displayName") or str(ma.get("id"))) for ma, _ in pairs)
            ambiguous.append(f"{pairs[0][1].get('name')} <- {', '.join(names)}")
            unmatched.extend(names)
            continue
        ma, app = pairs[0]
        matched[str(ma.get("id"))] = (ma, app)
    return matched, unmatched, ambiguous


def balance_is_trustworthy(ma: dict, now: dt.datetime | None = None):
    """(ok, reason). A manual/disabled account's currentBalance must never
    overwrite a good anchor — a broken bank connection reporting 0.00 would
    otherwise wipe the account's real balance.

    STALENESS is deliberately no longer a rejection. It used to be, and the
    combination — skip the stale balance, but stamp fresh ones with TOMORROW —
    is exactly how the owner's Chase anchor ended up $2,000 wrong: a 71h-stale
    balance had been anchored with a fresh date on an earlier run, going blind
    to withdrawals dated in between. A stale balance is TRUE AS OF ITS OWN
    DATE, and anchor_when() now stamps it there, so age stops being a threat.
    (`now` stays in the signature for call-site compatibility.)"""
    del now  # no longer consulted — see docstring
    if ma.get("isManual"):
        return False, "manual account"
    if ma.get("syncDisabled"):
        return False, "sync disabled"
    return True, ""


def anchor_when(ma: dict, today: str) -> str:
    """The openingDate for a re-anchor: the day AFTER the balance's own
    timestamp. The bank's figure already contains everything through its own
    day (deriveAccountBalance counts rows with day >= openingDate), and rows
    dated later are counted on top. No parseable stamp -> tomorrow, the old
    behaviour, correct for a balance the source reports as current."""
    stamp = ma.get("displayLastUpdatedAt") or ma.get("updatedAt")
    if stamp:
        try:
            seen = dt.datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
            return (seen.date() + dt.timedelta(days=1)).isoformat()
        except ValueError:
            pass
    return (dt.date.fromisoformat(today) + dt.timedelta(days=1)).isoformat()


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
    # Firestore meta/monarchSync.session is the session store; the library's own
    # on-disk session would resurrect a stale token on a warm instance.
    await mm.login(email, password, mfa_secret_key=mfa or None,
                   use_saved_session=False, save_session=False)
    return mm, await mm.get_accounts(), True


async def fetch_transactions(mm, start_date: str, page: int = 500,
                             end_date: str | None = None) -> list:
    """end_date is REQUIRED by the library: monarchmoney raises
    'You must specify both a startDate and endDate' when only one is given, which
    would make every run a silent no-op. Default reaches a year ahead so Monarch's
    future-dated manual rows stay in scope."""
    if not end_date:
        end_date = (dt.date.today() + dt.timedelta(days=365)).isoformat()
    out, offset = [], 0
    while True:
        resp = await mm.get_transactions(limit=page, offset=offset,
                                         start_date=start_date, end_date=end_date)
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

    matched, unmatched, ambiguous = resolve_matches(monarch_accounts, app_accounts)
    if ambiguous:
        log(f"AMBIGUOUS account matches (skipped, never guessed): {ambiguous}")

    # Reach back far enough to catch anything still pending at the last run.
    start = cursor_start(meta.get("lastSyncDate"))
    oldest_pending = meta.get("oldestPending")
    if oldest_pending and str(oldest_pending)[:10] < start:
        start = str(oldest_pending)[:10]
    log(f"fetching Monarch transactions since {start} "
        f"({len(matched)} matched / {len(unmatched)} unmatched accounts)")
    txns = await fetch_transactions(mm, start)
    log(f"fetched {len(txns)} transactions")

    tx_col = user_ref.collection("transactions")
    existing = {r.id for r in tx_col.list_documents(page_size=1000)}

    added = updated = 0
    skip_pending = skip_unmatched = skip_twin = skip_existing = 0
    pending_dates = []
    max_written_date = ""
    writes = []  # (doc_id, fields)
    # Occurrence counter mirrors the CSV importer: content-keyed on the same base
    # material, assigned in a deterministic order.
    occ = defaultdict(int)
    for t in sorted(txns, key=lambda x: (str(x.get("date") or ""), str(x.get("id")))):
        row = map_txn(t)
        if row is None:
            continue
        if row["pending"]:
            # Not written (it re-posts with a different id), but remember how far
            # back to reach next run so a long hold can never fall out of range.
            skip_pending += 1
            pending_dates.append(row["date_key"])
            continue
        pair = matched.get(row["monarch_account_id"])
        if pair is None:
            skip_unmatched += 1  # unmatched/ambiguous account — never guess
            continue
        ma, app = pair

        doc_id = f"mm_{row['monarch_id']}"

        # Our own row already exists: leave it alone. Re-writing would silently
        # revert the owner's manual edits every single morning.
        if doc_id in existing:
            skip_existing += 1
            continue

        # Cross-scheme overlap guard: skip rows the CSV import already owns.
        label = twin_label(app, row["monarch_account_name"])
        base = import_key(row["date_key"], row["signed"], label, row["statement"], 0)
        k = occ[base]
        occ[base] += 1
        twin = import_key(row["date_key"], row["signed"], label, row["statement"], k)
        if twin in existing:
            skip_twin += 1
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

        added += 1
        if row["date_key"] > max_written_date:
            max_written_date = row["date_key"]
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

    # Balance re-anchor — the most destructive write in this file, so it is
    # guarded three ways: (1) first run only SEEDS lastBalances and anchors
    # nothing, (2) an untrustworthy balance (manual/disabled/stale connection)
    # never overwrites a good anchor, (3) it fires only when the balance moved.
    #
    # openingDate is TOMORROW, not today: deriveAccountBalance counts rows with
    # day >= openingDate, and Monarch's currentBalance already contains today's
    # rows — anchoring at today would count them twice.
    last_bal = meta.get("lastBalances") or {}
    first_run = not last_bal
    new_bal, reanchored, balance_skips = {}, [], []
    for mid, (ma, app) in matched.items():
        cur = ma.get("currentBalance")
        if cur is None:
            continue
        cur = float(cur)
        ok, why = balance_is_trustworthy(ma)
        if not ok:
            balance_skips.append(f"{app.get('name')}: {why}")
            continue
        new_bal[mid] = cur
        if first_run:
            continue  # seed only — never re-anchor everything on the first pass
        if mid in last_bal and float(last_bal[mid]) == cur:
            continue
        # The balance is anchored AT ITS OWN DATE, and never behind the stored
        # anchor: moving an anchor backwards would trade a newer truth for an
        # older one and multiply same-day edge cases.
        anchor_date = anchor_when(ma, today)
        stored_anchor = str(app.get("openingDate") or "")[:10]
        if stored_anchor and anchor_date < stored_anchor:
            balance_skips.append(
                f"{app.get('name')}: balance dated {anchor_date} is older than its anchor {stored_anchor}")
            continue
        opening = opening_balance_for(app.get("type"), cur)
        reanchored.append(f"{app.get('name')}: {opening} @ {anchor_date}")
        if dry_run:
            log(f"  would re-anchor {app.get('name')!r}: openingBalance={opening} openingDate={anchor_date}")
        else:
            acc_col.document(app["id"]).set(
                {"openingBalance": opening, "openingDate": anchor_date,
                 "updatedAt": gcf.SERVER_TIMESTAMP},
                merge=True)
    if first_run:
        log("first run: seeded balances, re-anchored nothing (changes act from the next run)")
    if balance_skips:
        log(f"balances NOT trusted (anchor left alone): {balance_skips}")

    # Advance the cursor only as far as data we actually wrote (or, when nothing
    # was new, to the fetch window's own start). Never to wall-clock today —
    # that would silently skip the gap if a run returned nothing.
    prev_cursor = str(meta.get("lastSyncDate") or "")[:10]
    next_cursor = max(filter(None, [max_written_date, prev_cursor, start])) or today

    status = {
        "lastRun": now_iso(),
        "lastSuccess": now_iso(),
        "lastSyncDate": next_cursor,
        "oldestPending": min(pending_dates) if pending_dates else "",
        "fetched": len(txns),
        "added": added,
        "skippedPending": skip_pending,
        "skippedUnmatched": skip_unmatched,
        "skippedCsvTwin": skip_twin,
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
    log(f"sync done: fetched {len(txns)}, +{added} added, "
        f"skipped(pending {skip_pending} / unmatched {skip_unmatched} / "
        f"csv-twin {skip_twin} / already {skip_existing}), "
        f"{len(reanchored)} re-anchored, cursor -> {next_cursor}, "
        f"unmatched={sorted(set(unmatched))}")
    return status
