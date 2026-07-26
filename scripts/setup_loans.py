#!/usr/bin/env python3
"""Create Upstart / Mercedes / Zolve loan accounts and re-link their transactions.

Each matched row becomes a TRANSFER on the loan account:
  - the Upstart disbursement (an income row) -> transfer IN  (money borrowed)
  - every payment (an expense row)           -> transfer OUT (debt repaid)
This is what the History loan summary reads for Borrowed / Paid back / Interest.

Loans are created paid-off/closed but VISIBLE: openingBalance 0, openingDate today
(so derived "balance owed" = 0), isActive true, name marked closed.

Backs up transactions+accounts before writing. Dry-run unless --apply. Idempotent:
skips loan accounts that already exist and rows already on a loan account.
"""
import sys, re, json, datetime
sys.path.insert(0, 'scripts')
from fsadmin import find_uid, list_sub, commit

EMAIL = 'bhuvaneswar.marreddy@gmail.com'
TODAY = datetime.date.today().isoformat()
NOW = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
APPLY = '--apply' in sys.argv

LOANS = {  # id -> (regex, display name, sortIndex)
    'acct_upstart':  (re.compile(r'upstart', re.I),  'Upstart Loan (closed · paid off)', 9),
    'acct_mercedes': (re.compile(r'mercedes', re.I), 'Mercedes-Benz Auto Loan (closed · sold to Carvana)', 10),
    'acct_zolve':    (re.compile(r'zolve', re.I),    'Zolve Loan (closed · paid off)', 11),
}
LOAN_COLOR = '#7c3aed'

uid = find_uid(EMAIL)
tx = list_sub(uid, 'transactions')
acc = list_sub(uid, 'accounts')
accounts_base = acc[0]['name'].rsplit('/', 1)[0]  # .../accounts
existing_ids = {d['name'].rsplit('/', 1)[-1] for d in acc}

def sv(d, k):
    v = d.get('fields', {}).get(k, {})
    return v.get('stringValue')

# backup
import os
os.makedirs('scripts/backups', exist_ok=True)
bpath = f'scripts/backups/pre_loans_{TODAY}.json'
json.dump({'transactions': tx, 'accounts': acc}, open(bpath, 'w'))
print(f'backup -> {bpath}\n')

writes = []

# 1. create loan account docs (skip if present)
for aid, (_, name, idx) in LOANS.items():
    if aid in existing_ids:
        print(f'account {aid} already exists — skip create')
        continue
    writes.append({'update': {
        'name': f'{accounts_base}/{aid}',
        'fields': {
            'type': {'stringValue': 'personal_loan'},
            'name': {'stringValue': name},
            'provider': {'stringValue': 'other'},
            'openingBalance': {'doubleValue': 0},
            'openingDate': {'stringValue': TODAY},
            'balance': {'integerValue': '0'},
            'color': {'stringValue': LOAN_COLOR},
            'isActive': {'booleanValue': True},
            'sortIndex': {'integerValue': str(idx)},
            'createdAt': {'timestampValue': NOW},
            'updatedAt': {'timestampValue': NOW},
        },
    }})
    print(f'CREATE {aid}: {name}')

# 2. re-link + reclassify matching transactions
counts = {aid: {'in': 0, 'out': 0} for aid in LOANS}
for t in tx:
    hay = f"{sv(t,'title')} {sv(t,'merchant')} {sv(t,'description')} {sv(t,'sourceCategory')}"
    aid = next((a for a, (rx, _, _) in LOANS.items() if rx.search(hay)), None)
    if not aid:
        continue
    if sv(t, 'accountId') == aid and sv(t, 'type') == 'transfer':
        continue  # already done
    direction = 'in' if sv(t, 'type') == 'income' else 'out'
    counts[aid][direction] += 1
    writes.append({'update': {
        'name': t['name'],
        'fields': {
            'accountId': {'stringValue': aid},
            'type': {'stringValue': 'transfer'},
            'transferDirection': {'stringValue': direction},
        },
    }, 'updateMask': {'fieldPaths': ['accountId', 'type', 'transferDirection']}})

for aid, c in counts.items():
    print(f'  {aid}: {c["in"]} borrowed-in, {c["out"]} paid-out')

print(f'\n{len(writes)} writes' + ('' if APPLY else ' (DRY RUN — pass --apply)'))
if APPLY and writes:
    commit(writes)
    print('done')
