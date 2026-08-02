# functions-sync — daily bank → Firestore sync

Python 3.12 Firebase Cloud Functions (2nd gen), codebase `sync` — separate from the
Node `api` codebase in `functions/`. Runs every day at **07:30 America/Chicago**,
pulls accounts + transactions from Monarch, and writes them exactly the way the
in-app CSV import does (same fields, same classifier conventions, dedup against
CSV-imported rows via the `importKey` twin id).

Files:

- `main.py` — `monarch_sync` (schedule) + `monarch_sync_now` (manual HTTPS trigger),
  `simplefin_sync` (schedule) + `simplefin_claim` (one-time HTTPS setup)
- `sync_core.py` — all Monarch sync/mapping logic, plus the account matching and
  balance-trust rules both sources share
- `simplefin.py` — the SimpleFIN Bridge client and its sync (see §5)
- `dryrun.py` — run the Monarch logic locally, dry-run or apply
- `test_sync.py` / `test_simplefin.py` — pure-logic unit tests

## 1. One-time setup (owner)

Set the four secrets (each command prompts for the value):

```sh
cd /Users/bhuvaneswarmarreddy/Desktop/Projects/cashflow-forecast
firebase functions:secrets:set MONARCH_EMAIL
firebase functions:secrets:set MONARCH_PASSWORD
firebase functions:secrets:set MONARCH_MFA_SECRET   # your TOTP secret; enter a single space if you have no MFA
firebase functions:secrets:set SYNC_TRIGGER_KEY     # any long random string, e.g.: openssl rand -hex 24
```

A blank/whitespace `MONARCH_MFA_SECRET` means "log in without MFA".

The Firebase CLI needs a local Python 3.12 venv to discover the functions at
deploy time (this Mac only has 3.9 — `brew install python@3.12` first):

```sh
python3.12 -m venv functions-sync/venv
functions-sync/venv/bin/pip install -r functions-sync/requirements.txt
```

## 2. Validate locally BEFORE deploying

```sh
export MONARCH_EMAIL='...' MONARCH_PASSWORD='...' MONARCH_MFA_SECRET='...'
python3 functions-sync/dryrun.py --dry-run   # no writes; prints every row and
                                             # balance re-anchor it WOULD write
```

Check the output — especially the `would re-anchor` lines (debt accounts must show
positive amount-owed) and `unmatchedAccounts` (their transactions are skipped, never
guessed; rename the app account or ignore). Then, optionally, one real local pass:

```sh
python3 functions-sync/dryrun.py --apply     # uses the firebase-CLI OAuth token,
                                             # same admin rails as scripts/fsadmin.py
```

Tests (no network, no credentials):

```sh
python3 -m pytest functions-sync/test_sync.py      # or: python3 -m unittest discover -s functions-sync
```

## 3. Deploy

```sh
firebase deploy --only functions:sync
```

(The Node `api` codebase is untouched; deploy it separately as before.)

## 4. Manual trigger

```sh
curl -X POST \
  -H "X-Sync-Key: <your SYNC_TRIGGER_KEY value>" \
  https://us-central1-marreddy-cashflow.cloudfunctions.net/monarch_sync_now
```

Wrong/missing key → 403. Response is the JSON status (also stored on the
`meta/monarchSync` doc: lastRun, lastSuccess, added/updated/skipped counts,
unmatchedAccounts, reanchored, error).

## How it behaves

- **Session reuse** — the Monarch session token is persisted in `meta/monarchSync.session`
  and reused; credentials are only used when the saved session stops working.
- **Cursor** — fetches since `lastSyncDate − 5 days` (late-posting overlap); first run
  starts at the CSV cutover `2026-07-23`.
- **Dedup** — doc id `mm_<monarch txn id>` (Monarch edits flow through on re-sync);
  rows the CSV import already owns are detected via the ported `importKey` id and skipped.
- **Balances** — when a Monarch balance changes vs the last sync, the account is
  re-anchored: `openingBalance = current` (debt as positive owed), `openingDate = today`.
- **Never crashes the schedule** — errors are recorded in `meta/monarchSync.error`.

---

## 5. SimpleFIN — the daily direct-from-the-bank feed

The second ingest source (spec: `docs/superpowers/specs/2026-08-02-dual-source-ingest.md`).
SimpleFIN gives fresh transactions and **true bank balances** every morning but **no
categories**; the Monarch CSV path stays for enrichment (and is the only way Apple Card
data ever arrives). The two never double-count: every row is matched on
`accountId | signed cents | yyyy-MM-dd` with a ±3-day window, and a match **enriches**
the existing row instead of inserting a twin.

### 5.1 Owner setup (one time)

1. Create an account at <https://bridge.simplefin.org> (~$15/yr) and **connect your
   banks** there. Confirm all five institutions are supported *before* paying —
   coverage is the one thing this design cannot work around.
2. In the Bridge UI, generate a **setup token** — a long base64 string. It is
   **single use**: claiming it returns the long-lived access URL and burns the token.
3. Store the token and the trigger key as secrets:

```sh
cd /Users/bhuvaneswarmarreddy/Desktop/Projects/cashflow-forecast
firebase functions:secrets:set SIMPLEFIN_SETUP_TOKEN   # paste the base64 setup token
firebase functions:secrets:set SYNC_TRIGGER_KEY        # already set if Monarch sync is live
firebase deploy --only functions:sync
```

4. Claim it **once**. This POSTs the decoded claim URL and stores the resulting access
   URL on `meta/simplefinSync.accessUrl`:

```sh
curl -X POST \
  -H "X-Sync-Key: <your SYNC_TRIGGER_KEY value>" \
  https://us-central1-marreddy-cashflow.cloudfunctions.net/simplefin_claim
```

Replies `{"claimed": true, "host": "bridge.simplefin.org"}` — the access URL itself is
never returned, since it carries HTTP Basic credentials. A second call replies
`409 already claimed` rather than burning a fresh token; wrong/missing key → 403.

5. *(optional)* Pin the access URL as a secret so the sync does not depend on the
   Firestore doc. Read it from `meta/simplefinSync.accessUrl`, then:

```sh
firebase functions:secrets:set SIMPLEFIN_ACCESS_URL    # takes precedence when set
firebase deploy --only functions:sync
```

### 5.2 Daily schedule

`simplefin_sync` runs **every day at 07:30 America/Chicago** — one
`GET /accounts?start-date=&end-date=` (the bridge allows ≤24 requests/day). Status,
counters and any error land on `meta/simplefinSync`:

```
fetched · added · enriched · skippedPending · skippedUnmatched · skippedAlreadySynced
unmatchedAccounts · ambiguousAccounts · untrustedBalances · reanchored · lastSyncDate
```

### 5.3 How it behaves

- **Window** — `lastSyncDate − 45 days`, clamped to SimpleFIN's hard **90-day** history
  limit; the end bound is *tomorrow* so today's rows are always in range. Writes are
  idempotent, so a wide overlap only costs reads while a narrow one permanently loses
  late-posting rows.
- **Enrich-or-insert** — a matching existing row gets `sources: [… , 'simplefin']`, a
  fingerprint if it had none, and *blank* fields filled in. Monarch's cleaned merchant,
  title and category always win; `description` keeps the raw statement text (it feeds
  Zelle person-attribution); anything with `userEdited.<field>` is never touched.
  New rows are written as `sf_<simplefin txn id>` with `sources: ['simplefin']`.
- **Never guesses an account** — SimpleFIN accounts are matched by last-4 then
  name-contains, and two accounts claiming one app account demotes *both* to unmatched
  (`ambiguousAccounts`). Their transactions are skipped, never assigned.
- **Balances** — re-anchored to `openingDate = tomorrow` only when the balance moved;
  first run seeds and anchors nothing; a `balance-date` older than 36h is treated as a
  broken connection and left alone.
- **Pending rows are skipped** — they re-post later with a different id.
- **A bank needing re-auth fails the run loudly.** SimpleFIN reports it in `errors[]`
  and the whole pass raises rather than syncing a partial day, which would otherwise
  look like a normal quiet day. Fix the connection in the Bridge UI and re-run.
