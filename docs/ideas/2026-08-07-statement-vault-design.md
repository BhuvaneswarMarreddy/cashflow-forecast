# Design: statement vault, Phase 3a — US documents (issue #10)

Three designs, each attacked twice. Scores 3.0–7.0 — lower than the instructions-layer
pass, and for a good reason: **every design claimed a dedupe guarantee that does not
exist in this codebase.** The reviewers ran the code and proved it.

---

## Decision

**Extend `CSVImportModal` with a `.pdf` branch. Do not build a second import flow.**

A parallel import path is how the 310-duplicate incident happens again. One preview,
one dedupe, one `addBulkTransactions`, one place where a human presses the button.

The spine, kept verbatim from the winning design: **the callable returns JSON and
writes nothing**; rows land in the existing `parsedData` state; the only write path
stays `addBulkTransactions` behind a click. A PDF-derived row that has been through
the preview is indistinguishable from a CSV row that has been through the preview —
which is the entire point of the confirmation step.

---

## The seven corrections (each closes a proven flaw)

### 1. `importKey()` cannot dedupe a PDF row — stop pretending it can

Its account component keys off the CSV's account *cell*; a PDF row has none. So the
exact-match net is dead **100% of the time** for PDFs, not merely when descriptions
differ. Every design assumed otherwise.

**Fix:** PDF rows get a document-scoped id — `stm_<sha256>_<ordinal>` — so
re-importing the same document is idempotent *by construction*. `findTwin()`
(account + signed cents, ±3 days) becomes the **only** cross-source dedupe, and it is
declared as such rather than treated as a backstop.

### 2. There is already a second PDF door, and it does not dedupe at all

`ReceiptScannerModal` accepts `application/pdf` today and is reachable from the
globally-mounted quick-add button. A statement dropped there bypasses everything.

**Fix:** one line — `accept="image/*"`. Receipts are photos; statements go through
the importer.

### 3. A PDF row defaults to "No Link", and no account breaks dedupe entirely

The account picker's warning is gated on a condition a PDF can never satisfy, so the
unlinked state renders as an affirmative, highlighted choice.

**Fix:** for PDFs the account is **required** — no default, no import until chosen.
Importing a statement to the wrong account duplicates the whole document, and nothing
downstream would catch it.

### 4. The preview must say what the import will actually do

Today the button reads *"Import 42 transactions"* while the truth — *"39 imported, 3
enriched"* — only appears afterwards. `handleImport` already computes exactly this.

**Fix:** run that same loop at preview time and put the answer on the button:
**"Import 39 new · 3 already known"**. Consent needs to be informed *before* the press.

### 5. Reconciliation must be independent, and asymmetric

Reading both the rows *and* the statement's printed total from the same model is not a
check — it is the same guess twice.

**Fix:** read the printed total **deterministically**, by regex over the pdf.js text
layer, never from the model that produced the rows. Then:

- **short** → warn and name the exact gap; import allowed (legitimate misses exist,
  and the failure mode is understatement)
- **over** → **block**; a positive gap is invented money, which is the cardinal sin
- **no total found** → grey, *"couldn't find the statement's own total, so these rows
  are unchecked"* — and this must never render as the green case

Disclosure at the moment of consent, in the button itself: *"Import anyway — $12.40
unaccounted"*.

### 6. There must be a repair path, or this regresses on what exists

`ReceiptScannerModal` already lets the owner fix date, amount, merchant and category
inline. The CSV preview table is read-only, so reusing it unchanged means his only
repair is *cancel*.

**Fix:** per-row strike-out plus inline amount/date edit — **gated on
`confidence !== 'high'`**. A clean statement renders as a plain readable table with
zero controls; only the flagged rows grow them. That satisfies the simplicity rule
without leaving him stuck.

### 7. Provenance gets its own fields

`sources: string[]` has live readers; smuggling `doc_<sha>#p2` into it as a string
convention breaks them.

**Fix:** two optional fields, `sourceDocId` and `sourcePage`, linked one direction
(row → document) and queried back with `where('sourceDocId', '==', docId)`. No array
to drift, no 1MB ceiling.

---

## Also decided

- **Parse before upload.** The PDF is already read client-side for pdf.js, so parsing
  first costs nothing and gives the preview without waiting on a 4MB upload over cell
  data. Upload happens on the import press.
- **Content-addressed document id** (`doc_<sha256>`), so re-uploading July's statement
  overwrites its record and short-circuits: *"already imported Aug 2 — 47 rows"*.
- **Encrypted PDFs stay encrypted in Storage.** No decrypted copy is ever written; the
  password lives in memory for one call.
- **Account numbers are never stored** — last-4 only, and `\d{6,}` is masked before any
  text reaches the model.
- **Storage is not configured in this project at all today** — `storage.rules` and a
  `"storage"` block in `firebase.json` are part of this work, not an assumption.

---

## Sequence

1. `accept="image/*"` on the receipt scanner *(one line, closes the near-door duplicate)*
2. Storage setup: rules + `firebase.json`
3. `parseStatement` callable — pdf.js text layer, line regex, deterministic totals, AI only for leftover lines
4. Document record + content-hash short-circuit
5. `.pdf` branch in the importer: required account, `stm_` ids, preview twin-loop, three-state reconciliation
6. Repair affordances on low-confidence rows only
7. `sourceDocId` / `sourcePage` provenance, surfaced on the row

**Then #7 closes:** Apple Card and Amazon statements land, and spending stops being
understated.
