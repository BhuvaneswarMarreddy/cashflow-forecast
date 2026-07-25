# Accounts redesign — derived balances + drag-drop ordering (design spec)

Owner-approved 2026-07-25. Two features, independently shippable.

Locked decisions:
- **Balance model:** anchor + derive. `Current = openingBalance ± net(date ≥ openingDate)`.
  Derived in memory, never persisted. Reconciliation re-anchors.
- **Reconcile:** ship **anchor-only** first; audit-mode adjustment rows are a deferred
  phase (Phase D), not built now.
- **Ordering:** ships **first** (Phase A) — zero dependency on the balance work.
- **Ordering storage:** per-account `sortIndex`, batch-written; NOT an `accountOrder`
  array in settings (that gets dropped by the sync whitelist — see Rejected below).

Background context that drove this: `deriveAccountBalance` already computes
`opening ± net`, but `opening = account.balance || 0` and the sum runs over the *entire*
incomplete Monarch history from $0 — which produced impossible negative openings
(BofA −$4,832.95, checking −$3,830.00). The identity is correct; the premise (opening=0
over incomplete history) was wrong. `withDerivedBalances` was neutered to return stored
balances unchanged as a workaround.

---

## Part 1 — Balance model

### The model
Three quantities; only the first is stored.

| Quantity | Where | Definition |
|---|---|---|
| **`openingBalance`** @ **`openingDate`** | stored on account doc | last known-true balance and its date. Cash positive; debt = positive amount owed. |
| **net flow** | derived (integer cents) | signed sum of the account's own transactions with `openingDate ≤ day(date) ≤ today`. Future rows are forecast, not balance. |
| **current balance** | derived, in memory only | cash: `openingBalance + net`; debt: `openingBalance − net` (a purchase raises owed, a payment lowers it). A negative debt result is a legitimate credit balance — **do not clamp**. |

The only change vs today's `deriveAccountBalance`: base is `openingBalance` (a real
number) and the sum is gated to `day(date) ≥ openingDate` instead of all-history-from-$0.
That single change makes derivation correct — the anchor absorbs everything (including
dropped rows) before `openingDate`, so only *post-anchor* completeness must hold, which
monthly reconcile guarantees.

### Store vs derive
**Derive in memory; do not persist `currentBalance`.** Every balance-showing screen
already loads the full ledger (`TransactionContext`), so derivation is a free pass over
already-fetched data; persisting current balance buys zero Firestore reads and adds
write-amplification + staleness + offline-merge conflicts. Un-neuter `withDerivedBalances`
to attach a derived `currentBalance` — **and memoize it**: `Navbar` currently calls it
inline, unmemoized, on every render (O(accounts × transactions) app-wide).

### The critical constraint — keep the missing-rows detector alive
The Flow page detects dropped rows by comparing **two independent sensors**: the
user-entered real balance (`signedRealNowCents` → `balanceAtEndOfDay`) vs the sum of
transactions. **Deriving "now" from the transactions would collapse that comparison and
permanently blind the detector.** Resolution: the *reconciliation* is the independent
sensor — the user periodically types their real balance (a measurement not derived from
transactions), which re-anchors and reveals drift. Between reconciles the app trusts the
ledger (as every real finance app does); the Flow gap node + a "last reconciled N days
ago" nudge tell the user when to reconcile.

`flows.ts` therefore keeps reading the **anchor** as its independent number: the Flow
reconciliation computes `openingCents` from `signedRealNowCents` which must read the value
the user last reconciled to. Practically: `signedRealNowCents` reads `openingBalance`
rolled forward to today by the ledger for *display*, but the missing-rows math compares
the user's reconcile input against the derived value at reconcile time. See Phase C.

### CSV interaction
Imports are idempotent additive upserts (deterministic ids; overwrite-or-append, never
delete). Because correctness depends only on post-anchor completeness:
- Corrected row on re-upload → net recomputes, current shifts by exactly the delta.
- New post-anchor row → flows into net automatically.
- Old pre-anchor row → excluded by the `date ≥ openingDate` guard; current unchanged.
No manual balance editing, ever. Residual risk (a post-anchor row the export permanently
drops) is what reconcile catches.

### Reconciliation (anchor-only)
A **Reconcile** action per account replaces today's "set balance" button:
1. Prompt "What's your real balance right now?"
2. `drift = entered − derivedCurrent`.
3. `drift == 0` → "Reconciled, nothing changed."
4. `drift ≠ 0` → **re-anchor:** `openingBalance = entered`, `openingDate = today`. Net
   resets forward; older transactions stay for history but no longer feed current. This
   makes all subsequently-imported pre-today rows automatically harmless.

### Database changes (account doc `users/{uid}/accounts/{accountId}`)
- **Rename** `balance` → `openingBalance` (same units; now means value *at* `openingDate`).
  Rename (not add) so TypeScript flags every reader — converting silent stale-balance bugs
  into compile errors.
- **Add** `openingDate: string` (ISO `yyyy-MM-dd`).
- **Add** `sortIndex: number` (Part 2).
- **Do not** add `currentBalance` (derived).
- Transaction `isAdjustment?: boolean` — Phase D only.

**Migration (one-time, per account):** `openingBalance = current stored balance`,
`openingDate = today`. Anchor at **today, not earliest-transaction** — earliest-txn
anchoring leaves accounts unprotected against dropped re-imports (a re-added old hidden
row would be `≥ openingDate` and corrupt the balance). Anchoring at today means net starts
≈ 0 and every future import is trustworthy. Must be coordinated with `forecast.ts`
(`opening = account.balance || 0` → `openingBalance`, add the date gate) and `flows.ts` in
the same change.

### Edge cases derivation introduces
1. **Two legs, one delete** — a card payment is two paired legs; deleting one desyncs both
   derived balances. → deleting a matched transfer leg offers to delete both / warns.
2. **Sign-ambiguous transfer leg** (no `transferDirection`, no direction word) → mis-signed
   into balance. Reconcile is the backstop; flag in UI copy.
3. **`merge:true` preserves a stale `transferDirection`** on a re-typed row → mis-moves the
   balance. Reconcile backstop.
4. **Same-day late import after a midday re-anchor** — rows dated today importing after you
   re-anchored today get counted on top. Rare; next reconcile bounds it.
5. **Inactive account keeps debt but vanishes from `getAccounts`** → silently drops from net
   worth. Pre-existing; note it.

### Trade-offs accepted
Between reconciles you trust the ledger, not a live independent measurement (standard for
finance apps; mitigated by easy reconcile + monthly nudge). Re-anchoring collapses
pre-anchor history into one number (those balances were never trustworthy anyway).

---

## Part 2 — Drag-and-drop ordering

### Library
`dnd-kit` (`@dnd-kit/core` + `/sortable` + `/modifiers`, ~12 kb). Native HTML5 DnD is
disqualified (no touch, no keyboard/SR). dnd-kit gives PointerSensor (mouse+touch),
KeyboardSensor, and an `aria-live` region out of the box.

### UX
`GripVertical` handle per row (listeners on the handle only, so Edit/Delete stay
clickable); `DragOverlay` clone follows the pointer while the original dims; sibling rows
slide to open a live gap (the drop indicator); vertical-axis restriction; edge autoscroll.
Enabled only when `paymentAccounts.length > 1`.

### Desktop vs mobile
Same PointerSensor, different activation: desktop `{distance: 4}` (a click never drags);
mobile `{delay: 200, tolerance: 5}` (long-press to drag; a quick swipe still scrolls). The
handle gets `touch-action: none` **and** `-webkit-touch-callout: none; user-select: none`
(iOS fires the system callout mid-press otherwise).

### Accessibility
`KeyboardSensor` + `sortableKeyboardCoordinates`: Space pick up, arrows move, Space drop,
Esc cancel. `aria-live` announcements ("Moved Chase Checking to position 2 of 6"); each
handle a real `<button>` with `aria-label`; animations gated behind
`prefers-reduced-motion`.

### Storage — per-account `sortIndex`, batch-written
Store `sortIndex: number` on each account doc. It rides the existing wholesale
`...doc.data()` spread in `getAccounts`, so it survives the sync path with **no whitelist
edit and no composite index** (sorting stays client-side). On reorder, write **all changed
indices in one Firestore `writeBatch`** (one atomic op, not N). A missing `sortIndex` sorts
to the end (new/legacy accounts degrade gracefully). Read: sort `paymentAccounts` by
`sortIndex` (undefined → end, tie-break by name).

**Rejected: `accountOrder: string[]` in settings.** `syncFromFirestore` rebuilds
`profile.settings` from a hardcoded whitelist that omits it, and `getAccounts` has no
`orderBy` — the saved order would reshuffle after every background sync.

### Optimistic + rollback
New context method `reorderPaymentAccounts(orderedIds)`: reorder `paymentAccounts` +
`setProfile` + `saveLocalProfile` immediately (mirrors existing mutators), snapshot prior
order, batch-write `sortIndex`; on non-offline failure restore + toast. Offline tolerated
like every other write. New account on create → append with `sortIndex = max + 1`.

### Concurrency ceiling (honest)
No realtime sync (`onSnapshot`) exists — convergence needs a reload. Simultaneous reorders
on two devices are last-writer-wins; an add-on-B-while-reorder-on-A can drop A's move.
Acceptable at this scale; upgrade path (fractional/lexicographic ranks) only matters at
hundreds of accounts.

### Ordering edge cases
Single/zero accounts (DnD disabled); account added on another device (missing sortIndex →
end); deleted account (gone from `paymentAccounts`, stale index harmless); mid-drag
background sync (withhold server order until `onDragEnd`); not-yet-synced `local_` account
(disable its handle until synced); no-op drop (`active.id === over.id` → skip write).

---

## Testing
- `deriveAccountBalance` with `openingDate` gate (cash + debt, pre/post-anchor rows,
  negative-debt credit balance, future-row exclusion).
- Reconcile drift + re-anchor math.
- Reorder/sort: `sortIndex` ordering with undefined → end, `reorderPaymentAccounts`
  reassigns contiguous indices, no-op guard.
- Migration idempotency (running twice doesn't re-anchor an already-anchored account).
- DnD keyboard/touch behavior is a manual render check (documented in the plan).

## Phasing
- **Phase A — Ordering** (independent, ship first).
- **Phase B — Balance schema + derivation** (rename, openingDate, fix derive, memoized
  un-neuter, migration).
- **Phase C — Reconcile flow** (anchor-only) + two-leg-delete guard + Flow gap wiring.
- **Phase D — Audit-mode adjustments** (deferred; only if wanted).
