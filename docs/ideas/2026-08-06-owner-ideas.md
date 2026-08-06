# Owner ideas — 2026-08-06

Captured verbatim-in-spirit during a theater run. Not designed yet; input for the
next brainstorm session.

## 1. MIT license — DONE
Public repo, portfolio piece for job interviews. `LICENSE` added, `package.json`
carries `"license": "MIT"`.

## 2. Presentable README + architecture docs
The repo should demonstrate architecture skill and point of view, not just work.
Candidates worth showing: derived-on-read classification (no computed category is
ever stored), multi-source ingest with one-to-one fingerprint dedupe, the
balance-anchoring rule, and the habit of tracing a single questioned number down
to the row that caused it.

## 3. Pull request process — DONE
Branch → PR → merge for every change; template in `.github/pull_request_template.md`
asks for what/why/evidence/risk. History should read as reviewed work.

## 4. Internal AI structure: decisions become standing instructions
**The big one.**

Today the owner can ask about a transaction and tell the app what it means, but
that knowledge does not compound: the same shape of transaction can ask again.

Wanted:
- A **base analysis** produced by the engine (what the data says on its own).
- On top of it, a **stored set of the owner's instructions** — every decision made
  through "Ask about this transaction" or the chat, kept as durable, reusable
  guidance rather than a single-row edit.
- A **daily analysis** that re-runs and *follows those instructions automatically*,
  so the owner never re-answers a question they have already answered.

Existing pieces that already point this way and should be unified rather than
duplicated: `users/{uid}/reviews` (per-row confirmed meanings), `users/{uid}/rules`
(mapping rules from chat), `users/{uid}/income` (approved sources), and the
review queue that selects unknown inflows.

Open questions for the brainstorm:
- What is an "instruction" exactly — a predicate over rows (shape-based) or a
  restatement in the owner's words the model re-applies?
- How does an instruction get corrected or retired when it turns out wrong?
- What runs daily, what runs on ingest, and what stays on-demand?
- How does the owner *see* the instructions the app is following, in one place?

## 5. Personalised AI per user
Same model for everyone, different stored context per user — `users/{uid}` already
isolates it. Three layers wanted: what the user told it (instructions), what it
learned by watching them (behavioural, always shown before acting), and who they
are (a few onboarding answers that change which analyses run at all).

**Discipline:** personalisation may change the CONVERSATION, never the NUMBERS.
Two users with identical transactions must see identical totals.

## 6. India connectivity + multi-currency
Live sync is legally closed to individuals (Account Aggregator needs an
RBI/SEBI-regulated FIU). So India is a monthly IMPORT rhythm, all free:
Axis CSV/Excel (366 days per pull) or the emailed e-statement; CDSL/NSDL **CAS**
(one PDF/month covering every demat + mutual fund under a PAN, open-source
parsers exist); Zerodha Kite Connect personal tier (free since 2025) for live
holdings; family members forward their own statements (never shared logins).

Multi-currency is the real engineering:
- per-account currency; every amount stored in its NATIVE currency
- FX rate captured at the TRANSACTION'S date, so history never rewrites itself
- totals convert explicitly and show both: "₹85,000 (≈$1,020)"
- never silently add currencies — Monarch renders 10,000 CAD + 10,000 USD as
  "$20,000", which is the exact bug to avoid

This is the differentiator: no app today does US banks + Indian accounts +
remittances + chit funds together.

## 7. Statement vault — files as first-class input
Drop in ANY financial document (bank PDF, card CSV, Axis Excel, CDSL/NSDL CAS,
possibly loan statements) and have the app:
1. **store the file** (Storage), not just parse and discard it
2. **parse it into the ledger** through the SAME fingerprint dedupe and engine, so
   an imported row and a Plaid row for the same charge enrich rather than duplicate
3. **keep the link**, so any row can answer "where did this come from" with
   "your July Amex statement" — provenance, not just data
4. **be askable** — questions about the document itself, and about how it changed
   the picture
5. **flow into everything** — same categories, same Sankey, same forecast

Hard parts to design: password-protected Indian PDFs (CAS uses PAN+DOB), wildly
varied layouts, and deciding when a parse is confident enough to import versus
when to show the owner a preview first. Likely shape: deterministic parsers for
known formats (already exist for 11 CSV layouts), AI-assisted extraction for
unknown PDFs, and NEVER an import without a preview the owner confirms.
