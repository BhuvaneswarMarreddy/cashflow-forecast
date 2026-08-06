# Implementation plan — ideas 4 to 7

Sequenced by **dependency first, value second**. The ordering argument matters more
than the estimates: two of these change every amount in the system, so they cannot
follow the features built on top of them.

---

## Phase 0 — finish what is half-done (small)

Spending is currently **understated**: the Upstart loan, the Mercedes loan, the
Amazon Store Card and the Apple Card are absent from the new account.

1. Retry Synchrony in Plaid (their integration was erroring); if it stays down, import the activity CSV.
2. Apple Card: monthly statement export from Wallet → import (support already shipped).
3. Closed loans (Upstart, Mercedes): add as accounts with their real history, or
   accept them as out of scope and say so on screen — an absent account must never
   look like an account with no spending.
4. Re-audit every headline number against the engine and record the figures.

**Done when** the spending total is one the owner recognises as his own.

---

## Phase 1 — the instructions layer (the one that compounds)

*Idea 4. No dependencies. Highest daily value.*

Today three collections hold the owner's knowledge separately — `reviews` (per-row
decisions), `rules` (chat-created mapping rules), `income` (approved sources) — and
none of them is visible in one place or reusable as a general instruction.

1. **Define the instruction record.** One shape: a shape-based predicate (what it
   matches), the resulting meaning, the owner's own words, provenance (when, from
   which conversation, from which transaction) and a state (`active` / `retired`).
   Keep the existing three collections as the *storage* they already are; the
   instruction is the thing that generates them.
2. **Write path.** Every chat decision and every ✨ Ask answer creates an instruction,
   not just a row edit. Same closed-parser + confirmation-card discipline as today.
3. **Apply path.** Instructions run in the derived-on-read pipeline, after the base
   engine and before display, so they re-apply to history automatically and cost no
   migration. Order and precedence must be explicit and tested.
4. **The visible memory.** One screen: *everything the app knows about your money*,
   grouped, searchable, each row editable and retirable, each showing how many
   transactions it currently claims.
5. **Traceability.** Any classified row can say *"counted as chit fund — you told me
   on 6 Aug"*, linking back to the instruction.
6. **Drift detection.** When a row matches an instruction but deviates materially
   (a $1,000 pattern arriving as $2,000), ask rather than assume.

**Design question to settle first:** is an instruction a *pattern* or *the owner's
words re-applied by the model?* Recommendation: patterns are the spine (predictable,
testable, free to run), the words are stored alongside as the explanation and as the
fallback for cases the pattern cannot express.

**Done when** the owner can answer a question once, see it in the memory screen, and
never be asked it again — and can undo it in one click.

---

## Phase 2 — multi-currency foundation (do it BEFORE any INR arrives)

*Idea 6, first half. Touches every amount in the system.*

Sequencing note: building the statement vault first would mean importing Indian
statements into a single-currency ledger and re-doing both.

1. **Per-account currency.** Every account carries its own; every transaction stores
   its amount in that native currency, in integer minor units.
2. **Rate at the transaction's date.** Store the FX rate used, on the row, so history
   never rewrites itself when the rupee moves. A daily rate table, one fetch a day.
3. **Explicit conversion at the totals boundary.** `sumIncomeCents` and friends gain a
   display currency; conversion happens once, where formatting happens.
4. **Never silently add currencies** — the invariant, and a test that proves it.
   (Monarch renders 10,000 CAD + 10,000 USD as "$20,000". That is the bug to avoid.)
5. **Show both** where it matters: "₹85,000 (≈$1,020)".
6. **Remittance linking** (the piece nobody else has): a Remitly/Wise outflow in USD
   and the INR arrival in an Indian account are *one* movement. Link them like the
   refund-allocation links already work, so the money is not counted twice.

**Done when** a mixed-currency ledger produces one net-worth number the owner trusts,
and every screen agrees on it.

---

## Phase 3 — statement vault

*Idea 7. Needs Phase 2 for Indian documents.*

1. **Upload + store.** Firebase Storage, per-user, with the document kept — not
   parsed and discarded. Password-protected PDFs (CAS uses PAN + DOB) handled at
   upload, never stored decrypted.
2. **Parse by tier.** Known CSV layouts use the deterministic parsers that already
   exist (11 formats today). Unknown PDFs use AI-assisted extraction.
3. **Preview before import, always.** A PDF parse is a guess until confirmed. This is
   the boundary that protects rule #1 — never import a document blind.
4. **Same dedupe, same engine.** Imported rows go through the existing fingerprint
   matching, so a statement row and a Plaid row for the same charge enrich rather
   than duplicate.
5. **Provenance.** Every imported row links back to its document and page, so any
   number can answer *"where did this come from"*.
6. **Askable documents.** Questions about the statement itself, and about how it
   changed the picture.
7. **India specifics:** CDSL/NSDL CAS parser (one PDF a month covers every demat and
   mutual fund under a PAN), Axis CSV/Excel, and an email-forwarding ingest address
   so family members can share their own statements without sharing logins.

**Done when** dropping in a statement is as trustworthy as a bank feed — and slower
only by the confirmation step.

---

## Phase 4 — personalisation

*Idea 5. Builds on Phase 1; mostly UX and prompt context, not new infrastructure.*

1. Instructions become the per-user AI context — same model, different notebook.
2. Behavioural layer: patterns the app notices (always reviews Amazon, never cares
   about sub-$5 items), always surfaced before being acted on.
3. Profile layer: a few onboarding answers (NRI sending remittances vs student vs
   family CFO) that change which analyses run at all.
4. **The invariant:** personalisation may change the conversation, never the numbers.
   Two users with identical transactions must see identical totals. Test it.

---

## What this sequence protects

- Multi-currency lands **before** the data that needs it, so nothing is rebuilt.
- The instructions layer lands **first among features**, because every later feature
  gets better when the app stops asking the same question twice.
- Every phase keeps the two fundamentals intact: **numbers accurate, surface simple.**
  Nothing here adds a control the owner has to learn — the visible-memory screen
  *removes* repeated questions, and the vault replaces manual data entry entirely.
