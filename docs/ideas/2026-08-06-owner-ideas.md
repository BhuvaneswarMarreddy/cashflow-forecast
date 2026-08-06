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
