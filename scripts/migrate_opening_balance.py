#!/usr/bin/env python3
"""One-time: anchor every account at TODAY. openingBalance = current stored balance,
openingDate = today. Additive (keeps the old `balance` field so old code still reads
during the deploy window). Idempotent: skips accounts that already have openingDate."""
import sys, datetime
sys.path.insert(0, 'scripts')
from fsadmin import find_uid, list_sub, commit

EMAIL = 'bhuvaneswar.marreddy@gmail.com'
TODAY = datetime.date.today().isoformat()
APPLY = '--apply' in sys.argv

uid = find_uid(EMAIL)
accts = list_sub(uid, 'accounts')
writes = []
for d in accts:
    f = d['fields']
    if 'openingDate' in f:
        continue  # already anchored
    bal = f.get('balance', {})
    val = float(bal.get('doubleValue') or bal.get('integerValue') or 0)
    writes.append({'update': {
        'name': d['name'],
        'fields': {
            'openingBalance': {'doubleValue': val},
            'openingDate': {'stringValue': TODAY},
        },
    }, 'updateMask': {'fieldPaths': ['openingBalance', 'openingDate']}})
    print(f"  anchor {f.get('name', {}).get('stringValue', '?')}: openingBalance={val} openingDate={TODAY}")

print(f"\n{len(writes)} accounts to anchor" + ("" if APPLY else " (DRY RUN — pass --apply)"))
if APPLY and writes:
    commit(writes)
    print("done")
