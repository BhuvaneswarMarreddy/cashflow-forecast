# Dual-Source Ingest: SimpleFIN (daily, raw) + Monarch CSV (enrichment)

**Date:** 2026-08-02 · **Decision:** run BOTH sources. They compose — they don't compete.

## Why both
- **SimpleFIN** = the heartbeat. Direct from the banks, one `GET /accounts` a day, ~$15/yr, documented API, no ToS conflict. Gives fresh transactions and **true bank balances** every morning. Gives *raw* descriptions and no categories.
- **Monarch CSV** = the enrichment. Manual, whenever you feel like it, explicitly blessed by Monarch. Carries their categories, cleaned merchant names, rules and splits — which the app's `sourceCategory` pipeline already consumes.
- **Apple Card** is unavailable to any aggregator (Apple exposes it only through FinanceKit, entitlement-gated). It arrives ONLY via Monarch CSV or the Wallet app's own export — which is by itself a reason to keep the CSV path permanently.

Net effect: data is never more than a day stale, and gets *better* (categorized) whenever a CSV lands.

## The core problem
The same real-world charge arrives twice with different identities:

| | doc id | date | merchant | category |
|---|---|---|---|---|
| SimpleFIN | `sf_<id>` | posted date | `AMZN Mktp US*2H4KJ` | none |
| Monarch CSV | `imp_<key>` | Monarch's date | `Amazon` | `Shopping` |

Naive double-insert double-counts spending and breaks every screen.

## Solution: fingerprint + enrich (never duplicate)

**Fingerprint** on every transaction, written by both paths:
```
fingerprint = `${accountId}|${amountCents}|${yyyy-MM-dd}`
```
Matching uses **exact account + exact cents**, with a **±3 day** window on the date (banks post on different days than the aggregator records; amount is the reliable axis, dates are not).

**Ingest rule (both paths):**
1. Compute the fingerprint.
2. Look for an existing row: same account, same cents, date within ±3 days, **not already claimed by this same source**.
3. **Match → ENRICH** the existing doc (never insert).
4. **No match → INSERT** with `sources: [<thisSource>]`.

**Field precedence when enriching** — richer data wins, user edits win over everything:
| field | winner |
|---|---|
| `sourceCategory`, `category` | Monarch (only it has real categories) — unless `userEdited.category` |
| `merchant`, `title` | Monarch's cleaned name > SimpleFIN raw |
| `description` | keep the raw statement text (feeds Zelle/person attribution) |
| `amount`, `date`, `accountId` | first writer (they match by definition) |
| `sources` | union — the audit trail of where it came from |

**User edits are sacred.** Any field the owner changed by hand carries `userEdited.<field> = true` and no source may overwrite it. This is the same rule the Monarch sync already follows by leaving existing rows alone.

**Balances:** SimpleFIN is authoritative (it's the bank's own number, refreshed daily). Same anchor rules already hardened in `sync_core.py`: anchor to *tomorrow* so same-day rows aren't double-counted, never trust a stale/manual/disabled feed, seed-only on first run.

## Categorization without Monarch
For accounts Monarch never sees (or before a CSV lands), rows arrive uncategorized. Two existing pieces cover it:
1. **`src/lib/behavior.ts`** already classifies behaviorally (recurring/one-time/transfer/refund) from amount+cadence+account — no category string needed.
2. **The AI data-mapping chat (Phase 8)** becomes the categorizer: "put everything from AMZN under Shopping" writes a rule that applies to existing *and* future rows. Rules run BEFORE `classifyTransaction`, so the user's intent always beats the heuristic.

This is the piece that makes direct-to-bank viable as a standalone product rather than a downgrade.

## Build order
1. **Fingerprint foundation** — add `fingerprint` + `sources` + `userEdited` to the transaction shape; teach the CSV importer to enrich-or-insert. Backfill fingerprints onto the existing ~2,941 rows. *(No new dependency; unblocks everything.)*
2. **CSV import polish** — drag-anywhere, auto-detect, and a real result summary ("142 new · 2,799 enriched · 3 balances re-anchored"). Makes the manual path a 20-second non-event.
3. **SimpleFIN client** — `functions-sync/` gains a `simplefin.py` fetcher reusing `sync_core`'s mapping/anchoring; the daily 07:30 schedule finally has something legitimate to run. **Gated on the owner confirming institution coverage.**
4. **AI data-mapping chat** — the categorizer, and the thing that makes source #1 optional.

## Risks
- **Fingerprint false-positive:** two genuinely distinct same-amount charges to one account within 3 days (two $5.00 coffees). Mitigation: match one-to-one and prefer the nearest date; never let one row absorb two. A wrongly-merged pair understates spending, so this needs a test with duplicate same-day amounts.
- **SimpleFIN coverage** for the owner's 5 institutions is UNVERIFIED — check before paying.
- **Apple Card** never automates. Accept it; the CSV path stays.
