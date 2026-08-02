#!/usr/bin/env python3
"""Backfill fingerprint + sources onto every stored transaction (all ~2,941 arrived via
CSV import, so the source is 'monarch'). Must stay byte-identical to fingerprintOf() in
src/lib/fingerprint.ts: `${accountId ?? 'none'}|${signedCents}|${yyyy-MM-dd}`, sign
negative for expense / transfer-out. Backed up; --dry-run by default, --apply to write."""
import sys, json, datetime, os; sys.path.insert(0, 'scripts')
from fsadmin import find_uid, list_sub, commit, fields
EMAIL = 'bhuvaneswar.marreddy@gmail.com'; APPLY = '--apply' in sys.argv
SOURCE = 'monarch'


def day_key(v):
    # Stored as a Firestore timestamp (UTC) but written from LOCAL midnight, and every
    # date consumer in the app reads it back in local time — so convert, don't slice.
    if isinstance(v, str) and len(v) > 10 and v.endswith('Z'):
        return datetime.datetime.fromisoformat(v[:-1] + '+00:00').astimezone().strftime('%Y-%m-%d')
    return str(v)[:10]


def signed_cents(f):
    # int(x+0.5), not round(): Python rounds halves to even, JS Math.round does not.
    cents = int(abs(float(f.get('amount') or 0)) * 100 + 0.5)
    inflow = f.get('type') == 'income' or (f.get('type') == 'transfer' and f.get('transferDirection') == 'in')
    return cents if inflow else -cents


if '--selftest' in sys.argv:  # offline check of the two rules the TS side must agree with
    assert signed_cents({'amount': 50, 'type': 'expense'}) == -5000
    assert signed_cents({'amount': 50, 'type': 'income'}) == 5000
    assert signed_cents({'amount': 50, 'type': 'transfer', 'transferDirection': 'in'}) == 5000
    assert signed_cents({'amount': 50, 'type': 'transfer'}) == -5000
    assert signed_cents({'amount': 8.55, 'type': 'expense'}) == -855  # 8.55*100 == 854.9999...
    assert day_key('2026-08-01T06:00:00Z') == '2026-08-01' and day_key('2026-08-01') == '2026-08-01'
    print('selftest ok'); raise SystemExit

uid = find_uid(EMAIL); docs = list_sub(uid, 'transactions')
os.makedirs('scripts/backups', exist_ok=True)
json.dump(docs, open(f'scripts/backups/pre_fingerprint_{datetime.date.today()}.json', 'w'))

writes = []
for d in docs:
    f = fields(d)
    if f.get('fingerprint') and f.get('sources'):
        continue
    fp = f"{f.get('accountId') or 'none'}|{signed_cents(f)}|{day_key(f.get('date'))}"
    writes.append({'update': {'name': d['name'], 'fields': {
        'fingerprint': {'stringValue': fp},
        'sources': {'arrayValue': {'values': [{'stringValue': SOURCE}]}}}},
        'updateMask': {'fieldPaths': ['fingerprint', 'sources']}})
    if len(writes) <= 10:
        print(f"  {fp:>44s}  {str(f.get('title', ''))[:34]}")

print(f"\n{len(writes)} of {len(docs)} transactions need a fingerprint"
      + ('' if APPLY else ' (DRY RUN — pass --apply)'))
if APPLY and writes:
    commit(writes); print('done')
