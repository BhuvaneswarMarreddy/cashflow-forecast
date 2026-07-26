#!/usr/bin/env python3
"""Seed real balances by anchoring each account at the 2026-07-23 Monarch values.
openingDate=2026-07-23 so derivation ADDS transactions since then. Backed up; --apply to write."""
import sys,json,datetime; sys.path.insert(0,'scripts')
from fsadmin import find_uid, list_sub, commit
EMAIL='bhuvaneswar.marreddy@gmail.com'; APPLY='--apply' in sys.argv
ANCHOR_DATE='2026-07-23'
# name -> openingBalance (debt as positive amount owed)
VALUES={'TOTAL CHECKING':829.60,'Adv SafeBalance Banking':1430.93,'Advantage Savings':45.52,'CHASE SAVINGS':2600.97,
 'Customized Cash Rewards Visa Signature':2656.09,'Blue Cash Preferred®':507.96,'Amazon Store Card':3308.57,'Apple Card':2068.93,'Discover it Card':6.85}
uid=find_uid(EMAIL); acc=list_sub(uid,'accounts')
def sv(d,k): return d.get('fields',{}).get(k,{}).get('stringValue')
json.dump(acc, open(f'scripts/backups/pre_seed_{datetime.date.today()}.json','w'))
writes=[]
for d in acc:
    name=sv(d,'name'); 
    if name not in VALUES: continue
    writes.append({'update':{'name':d['name'],'fields':{
        'openingBalance':{'doubleValue':VALUES[name]}, 'openingDate':{'stringValue':ANCHOR_DATE}}},
        'updateMask':{'fieldPaths':['openingBalance','openingDate']}})
    print(f"  {name[:40]:40s} openingBalance={VALUES[name]:>10.2f} @ {ANCHOR_DATE}")
print(f"\n{len(writes)} accounts"+('' if APPLY else ' (DRY RUN — pass --apply)'))
if APPLY and writes: commit(writes); print('done')
