#!/usr/bin/env python3
"""Phase-0 audit loop for the Flow page. Recomputes frozen targets from the raw
Monarch CSVs. Exit 0 = all pass. On failure: fix comprehension, never targets."""
import csv, glob, os, re, sys
from collections import defaultdict
from datetime import date

DIR = os.path.join(os.path.dirname(__file__), "..", "transactionsbyaccount")
TODAY = date(2026, 7, 22)  # last CSV date; 'active' means seen within 45 days

EXPECTED_ACCOUNTS = {  # account -> (rows, net_cents)
    "Adv SafeBalance Banking (...2126)": (742, 626388),
    "Blue Cash Preferred® (...1001)": (623, 103324),
    "Customized Cash Rewards Visa Signature (...3572)": (586, -477340),
    "TOTAL CHECKING (...7535)": (241, 465960),
    "Discover it Card (...4363)": (236, 382),
    "Amazon Store Card (...3282)": (189, -113987),
    "Apple Card": (117, -18363),
    "Advantage Savings (...2139)": (109, 4132),
    "CHASE SAVINGS (...2591)": (70, 50097),
}
EXPECTED_TOTAL_ROWS = 2913
# person -> (sent_cents, received_cents); +/- $1 tolerance
EXPECTED_PEOPLE = {
    "REMITLY": (12056236, 0),
    "SRIDEVI GOGINENI": (1861200, 0),
    "LOK PULUKURI": (238000, 1778800),
    "RISHIKESH KATTA": (0, 1106400),
    "VENU GUNTUPALLI": (250000, 985750),
}
EXPECTED_SELF = (8490265, 8179565)  # out, in
# merchant -> (cadence, median_cents, occurrences, active)
EXPECTED_RECURRING = {
    # occurrences = unique charge DAYS (rule 1): 21 payments, but 2025-12-01 has two
    # real payments ($3,200 + $500) on one day -> 20 days.
    "UPSTART": ("monthly", 90000, 20, False),
    "MERCEDES-BENZ": ("monthly", 83690, 5, False),
    "VERIZON": ("monthly", 49994, 19, True),
    "COMCAST": ("monthly", 5528, 26, True),
}
FORBIDDEN_RECURRING = {"QUIKTRIP", "FEDERAL WITHHOLDING"}

def cents(s):
    return round(float(s) * 100)

def rows():
    for f in sorted(glob.glob(os.path.join(DIR, "*.csv"))):
        with open(f, newline="", encoding="utf-8-sig") as fh:
            yield from csv.DictReader(fh)

fails = []
def check(ok, msg):
    print(("PASS " if ok else "FAIL ") + msg)
    if not ok:
        fails.append(msg)

# --- 1. per-account rows + net ---
acct = defaultdict(lambda: [0, 0])
total = 0
for r in rows():
    total += 1
    a = acct[r["Account"]]
    a[0] += 1
    a[1] += cents(r["Amount"])
check(total == EXPECTED_TOTAL_ROWS, f"total rows {total} == {EXPECTED_TOTAL_ROWS}")
for name, (er, en) in EXPECTED_ACCOUNTS.items():
    got = acct.get(name)
    check(got is not None and got[0] == er and got[1] == en,
          f"{name}: rows {got and got[0]}=={er}, net {got and got[1]}=={en}")

# --- 2. people (Zelle names + Remitly) ---
ZELLE = re.compile(
    r"zelle\s+(?:payment\s+|transfer\s+)?(?:to|from)[:\s]+([a-z .'’-]+?)"
    r"(?=\s+(?:conf|jpm|bac\w{5,}|for\b|\d)|;|$)", re.I)  # bac…: Chase glues a BACxxxx token after the name
BOFA = re.compile(r"zelle transfer conf# \w+;\s*(.+)$", re.I)

def person(stmt):
    if re.search(r"rmtly|remitly", stmt, re.I):
        return "REMITLY"
    m = ZELLE.search(stmt) or BOFA.search(stmt)
    if not m:
        return None
    name = re.sub(r'\s*for\s*".*$', "", m.group(1), flags=re.I)
    name = re.sub(r"\s+", " ", name).strip(" .;'-").upper()
    parts = name.split(" ")
    if len(parts) >= 3:
        name = parts[0] + " " + parts[-1]
    return name or None

def is_self(name):
    return "BHUVANESWAR" in name or "MARREDDY" in name or name == "ME"

sent, recv = defaultdict(int), defaultdict(int)
self_out = self_in = 0
for r in rows():
    p = person(r.get("Original Statement") or "")
    if not p:
        continue
    c = cents(r["Amount"])
    if is_self(p):
        if c < 0: self_out += -c
        else: self_in += c
    elif c < 0:
        sent[p] += -c
    else:
        recv[p] += c
for name, (es, er) in EXPECTED_PEOPLE.items():
    check(abs(sent[name] - es) <= 100 and abs(recv[name] - er) <= 100,
          f"person {name}: sent {sent[name]}~{es}, recv {recv[name]}~{er}")
check(abs(self_out - EXPECTED_SELF[0]) <= 100 and abs(self_in - EXPECTED_SELF[1]) <= 100,
      f"self transfers out {self_out}~{EXPECTED_SELF[0]}, in {self_in}~{EXPECTED_SELF[1]}")

# --- 3. recurring (the four spec rules) ---
def norm_merchant(s):
    s = re.sub(r"[#*]\S*", "", s.upper())
    s = re.sub(r"\s+\d{3,}$", "", s)
    return re.sub(r"\s+", " ", s).strip()

BANDS = {"weekly": (6, 8, 4.33), "biweekly": (12, 16, 2.17),
         "monthly": (26, 35, 1.0), "quarterly": (80, 100, 1/3),
         "yearly": (350, 380, 1/12)}

def median(xs):
    xs = sorted(xs); n = len(xs)
    return (xs[n//2] if n % 2 else (xs[n//2 - 1] + xs[n//2]) / 2)

groups = defaultdict(list)
for r in rows():
    if r["Category"] in ("Transfer", "Credit Card Payment"):
        continue
    if cents(r["Amount"]) >= 0:
        continue
    groups[norm_merchant(r["Merchant"])].append(r)

detected = {}
for m, rs in groups.items():
    dates = sorted({date.fromisoformat(r["Date"]) for r in rs})   # rule 1: unique dates
    if len(dates) < 3:
        continue
    amts = [-cents(r["Amount"]) for r in rs]
    med = median(amts)
    if med < 500:                                                  # rule 3
        continue
    mad = median([abs(a - med) for a in amts])
    if mad > med * 0.25:
        continue
    gaps = [(b - a).days for a, b in zip(dates, dates[1:])]
    mg = median(gaps)
    hit = next(((c, b) for c, b in BANDS.items() if b[0] <= mg <= b[1]), None)
    if not hit:
        continue
    cad, (lo, hi, mult) = hit
    if sum(1 for g in gaps if lo <= g <= hi) / len(gaps) < 0.6:    # rule 2
        continue
    detected[m] = (cad, med, len(dates), (TODAY - dates[-1]).days <= 45)

for m, (ec, em, eo, ea) in EXPECTED_RECURRING.items():
    got = detected.get(m)
    check(got == (ec, em, eo, ea), f"recurring {m}: {got} == {(ec, em, eo, ea)}")
for m in FORBIDDEN_RECURRING:
    check(m not in detected, f"recurring must NOT contain {m}")

print(f"\n{'ALL CHECKS PASSED' if not fails else str(len(fails)) + ' FAILURES'}")
sys.exit(1 if fails else 0)
