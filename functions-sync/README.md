# functions-sync — daily Monarch Money → Firestore sync

Python 3.12 Firebase Cloud Functions (2nd gen), codebase `sync` — separate from the
Node `api` codebase in `functions/`. Runs every day at **07:30 America/New_York**,
pulls accounts + transactions from Monarch, and writes them exactly the way the
in-app CSV import does (same fields, same classifier conventions, dedup against
CSV-imported rows via the `importKey` twin id).

Files:

- `main.py` — `monarch_sync` (schedule) + `monarch_sync_now` (manual HTTPS trigger)
- `sync_core.py` — all sync/mapping logic
- `dryrun.py` — run the same logic locally, dry-run or apply
- `test_sync.py` — pure-logic unit tests

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
