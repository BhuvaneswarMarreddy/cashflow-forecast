#!/usr/bin/env python3
"""Phantom-income fix on EXISTING data: income-typed rows sitting ON a credit card are
card payments (-> transfer/in) unless they are refunds (stay income). Deterministic
regexes decide the clear cases; the ambiguous tail goes to ONE gpt-4o-mini batch call.
Dry-run by default; --apply backs up then writes via :commit."""
import json, os, re, sys, urllib.request

APPLY = "--apply" in sys.argv
uid = "7hjLW3mzpVfEN4k0msL53njDvXr1"
BASE = "https://firestore.googleapis.com/v1/projects/marreddy-cashflow/databases/(default)/documents"
tok = json.load(open(os.path.expanduser("~/.config/configstore/firebase-tools.json")))["tokens"]["access_token"]

def get(u): return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"Authorization": f"Bearer {tok}"}), timeout=60))
def commit(writes):
    for i in range(0, len(writes), 450):
        body = json.dumps({"writes": writes[i:i+450]}).encode()
        urllib.request.urlopen(urllib.request.Request(BASE + ":commit", data=body, method="POST",
            headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}), timeout=120)
def V(x):
    for k in ("stringValue", "booleanValue"):
        if k in x: return x[k]
    if "integerValue" in x: return int(x["integerValue"])
    if "doubleValue" in x: return x.get("doubleValue")
    return None

accts = get(f"{BASE}/users/{uid}/accounts").get("documents", [])
cards = {a["name"].split("/")[-1] for a in accts if V(a["fields"]["type"]) == "credit_card"}

out = []; u = f"{BASE}/users/{uid}/transactions?pageSize=300"
while True:
    r = get(u); out += r.get("documents", []); t = r.get("nextPageToken")
    if not t: break
    u = f"{BASE}/users/{uid}/transactions?pageSize=300&pageToken={t}"

PAY = re.compile(r"payment|pymt|pmt|epay|autopay|auto pay|thank you|ach|bill pay|billpay|e-payment", re.I)
REFUND = re.compile(r"refund|return|reversal|revers|credit voucher|cashback|cash back|reward|redemption|adjustment|dispute|rebate|cr memo|credit memo", re.I)

transfer_w, refund_keep, ambiguous = [], [], []
for d in out:
    f = d["fields"]
    if V(f.get("type", {})) != "income": continue
    aid = V(f.get("accountId", {})) if f.get("accountId") else None
    if aid not in cards: continue
    text = f"{V(f.get('title',{})) or ''} {V(f.get('merchant',{})) or ''} {V(f.get('sourceCategory',{})) or ''}"
    if REFUND.search(text): refund_keep.append(d)
    elif PAY.search(text): transfer_w.append(d)
    else: ambiguous.append(d)

print(f"Cards: {len(cards)} | income-on-card rows: {len(transfer_w)+len(refund_keep)+len(ambiguous)}")
print(f"  -> transfer (payment-shaped): {len(transfer_w)}")
print(f"  -> keep income (refund):      {len(refund_keep)}")
print(f"  -> ambiguous, to AI:          {len(ambiguous)}")

ai_transfer = []
if ambiguous:
    key = None
    for line in open("/Users/bhuvaneswarmarreddy/Desktop/Projects/cashflow-forecast/.env"):
        if line.startswith("OPENAI_API_KEY="): key = line.split("=", 1)[1].strip()
    items = [{"i": i, "title": V(d["fields"].get("title", {})), "merchant": V(d["fields"].get("merchant", {})),
              "amount": V(d["fields"].get("amount", {})), "cat": V(d["fields"].get("sourceCategory", {}))}
             for i, d in enumerate(ambiguous)]
    prompt = ("These are positive-amount rows ON credit card accounts. For each, answer 'transfer' if it is a "
              "payment toward the card balance (money from a bank account), or 'income' if it is a genuine refund/"
              "reimbursement/reward credit. Reply ONLY a JSON array like [{\"i\":0,\"v\":\"transfer\"}].\n"
              + json.dumps(items))
    body = json.dumps({"model": "gpt-4o-mini", "temperature": 0,
                       "messages": [{"role": "user", "content": prompt}]}).encode()
    r = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    resp = json.load(urllib.request.urlopen(r, timeout=120))
    txt = resp["choices"][0]["message"]["content"]
    verdicts = json.loads(re.search(r"\[.*\]", txt, re.S).group(0))
    for v in verdicts:
        if v.get("v") != "transfer": continue
        d = ambiguous[v["i"]]; f = d["fields"]
        # Guard: a merchant-named small credit on a card is a refund, whatever the AI says
        # (card payments come from banks, not from "Walmart"). Keep those as income.
        merch = (V(f.get("merchant", {})) or "").strip()
        amt = V(f.get("amount", {})) or 0
        if merch and amt < 200 and not PAY.search(merch):
            continue
        ai_transfer.append(d)
    print(f"  AI verdicts: transfer {len(ai_transfer)}, income {len(ambiguous)-len(ai_transfer)}")
    for v in verdicts[:12]:
        d = ambiguous[v["i"]]; f = d["fields"]
        print(f"     [{v['v']:8}] {V(f.get('title',{}))[:44]:44} ${V(f.get('amount',{}))}")

to_fix = transfer_w + ai_transfer
print(f"\nTOTAL flipping to transfer/in: {len(to_fix)}")
if not APPLY:
    print("DRY RUN — pass --apply to write."); sys.exit(0)

os.makedirs("/Users/bhuvaneswarmarreddy/Desktop/Projects/cashflow-forecast/scripts/backups", exist_ok=True)
bp = f"/Users/bhuvaneswarmarreddy/Desktop/Projects/cashflow-forecast/scripts/backups/{uid}_cardfix.json"
json.dump(to_fix, open(bp, "w"))
commit([{"update": {"name": d["name"], "fields": {"type": {"stringValue": "transfer"},
                    "transferDirection": {"stringValue": "in"}}},
         "updateMask": {"fieldPaths": ["type", "transferDirection"]}} for d in to_fix])
print(f"applied {len(to_fix)}. backup: {bp}")
