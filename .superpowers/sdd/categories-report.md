# cashflow-mobile#24 — custom categories: add/rename/remove from chat (server/web half)

Owner (2026-08-22): "add any category and vacations expense… remove this category then
keep an Others category, like that." `ExpenseCategory` was a closed 13-value union
(`src/types/index.ts:12-25`), validated server-side (`functions/src/decisions.ts`
`validateOp`) and client-side (`src/lib/chat-actions.ts` `parseRule`), mirrored verbatim
on mobile. This task makes the set the OWNER's own — still closed, just closed over their
resolved set instead of a hardcoded one.

## Design adjustments made against the spec (with reasons)

- **`resolveCategories` home**: spec suggested a new shared file + a `functions/tsconfig.json`
  include-list edit. Put it in `src/types/index.ts` instead — already on that include list
  (colocated with `EXPENSE_CATEGORIES`/`displayCategory`, the same pure-function idiom
  already there) — zero build-config change needed.
- **`validateOp`'s cheap pre-`readLedger` guard**: the spec's "validate before the nine
  reads" optimization is structurally incompatible with a per-owner category set — the
  owner's custom categories live IN the ledger this guard exists to avoid reading. Fix:
  `categories` is now an optional param; omitted defers ONLY the category-membership
  check (every other malformed field — kind/match/set-keys/type/sourceCategory/merchant
  bounds — is still caught early). `applyDecisionCore`'s call, which always has the
  ledger, is the one authoritative gate. One pre-existing test asserted the bare-call
  behavior directly; updated to pass an explicit categories Set for that assertion, new
  tests added for the omitted-defers-then-ledger-decides behavior.
- **rename/remove scope**: restricted to CUSTOM categories only (never one of the 13
  built-in defaults) — the storage model is "settings.categories absent = defaults only,
  never written just to have a row," and renaming/archiving a default would need a
  shadow/override mechanic the task didn't ask for. The owner's own example (add
  "vacations", later remove it) is entirely a custom-category flow; a built-in default
  can't be targeted by `rename_category`/`remove_category` (parser rejects it, tested).
- **`remove_category`'s soft delete**: sets `archived: true` on the settings.categories
  entry rather than removing it from the array — matches the shape's own `archived` field
  and "still resolvable for display" intent; the value can never be reassigned into again
  (excluded from every assignable-set check) but a row that happens to still show it
  mid-flight (e.g. import lag) doesn't render blank.
- **Pickers (AddTransactionModal/BudgetSettingsPanel/PlannedPaymentsPanel/CSVImportModal/
  ReceiptScannerModal/AccountTransactions)**: NOT updated to read `resolveCategories`.
  These UI dropdowns still show only the 13 defaults. Not in the orchestrator's explicit
  file list or the required test list; flagged as a follow-up below rather than expanding
  scope. The chat surface (the owner's literal ask) and the snapshot payload (mobile's
  future consumer) both fully support custom categories.
- **`mcp/load-firestore.ts`**: NOT updated. `oneOf(d.category, CATEGORIES, 'other')`
  would silently display a custom category as "other" when read through this dev-only
  introspection tool. Read-only, no live project configured per its own docs, not in the
  validator sense the spec's point 3 addresses (that's about write trust boundaries).
  Flagged as a known gap, not fixed.

## Changes

1. **`src/types/index.ts`** — `CustomCategory` (`{value, label, icon?, archived?}`),
   `ResolvedCategory` (uniform shape), `resolveCategories(settings?)` = the 13 defaults +
   `settings.categories`, defaults always win a value collision, `slugForCategoryLabel(label,
   taken)` — collision-safe `[a-z0-9-]{1,32}` slug (linear probe `-2`, `-3`, … capped at
   1000 tries, `ponytail:` comment on the ceiling). `UserProfile.settings.categories?`
   added.

2. **`functions/src/decisions.ts`** — `validateOp(op, categories?: ReadonlySet<string>)`:
   category membership checked against `categories` when given, always still checking
   it's a string. `applyDecisionCore` computes `assignableCategoryValues(ledger.categories)`
   (archived excluded, `undefined` → the 13 defaults) and passes it — the authoritative,
   ledger-aware gate. `applyDecision`'s early call stays bare (defers only the category
   check, as above).

3. **`functions/src/snapshot.ts`** — `Ledger.categories?: ResolvedCategory[]`, populated by
   `readLedger` via `resolveCategories(settings)`. `buildSnapshot`'s payload gains
   `categories: {value,label,icon,archived}[]` — pure addition, double-count-guard test
   proves every other figure is unchanged.

4. **`functions/src/prompts.ts`** — three new JSON-shape-plus-requirements blocks
   (`add_category`/`rename_category`/`remove_category`), same idiom as `record_bill`/
   `set_monthly_spend`. ALLOWED CATEGORIES documented as the owner's own set. Sanity-bound
   tests in `chat.test.ts` bumped honestly with the measured deltas (+1995 chars, same
   convention every prior prompt addition used).

5. **`src/lib/chat-actions.ts`** — `ChatContext.categories` widened to `string[]` (a custom
   slug is never a member of the closed `ExpenseCategory` union). `buildChatContext` gains
   an optional 4th `categories` param (default = the 13 defaults, so every existing 2/3-arg
   call site is unchanged) and emits only ASSIGNABLE (non-archived) values. `parseChatAction`
   gains an optional 3rd `categories` param threaded into `create_rule`'s category check
   (default = 13, unchanged behavior when omitted) and the three new verbs — `add_category`
   (label/icon only, no model-picked `value`), `rename_category`/`remove_category` (`value`
   must be a CUSTOM category the owner has; `remove_category` defaults `reassignTo` to
   `'other'`, rejects reassigning to itself or to anything archived; both refused outright
   with no `categories` context, mirroring the recovery-actions'-with-no-`ctx` contract).

6. **`src/context/TransactionContext.tsx`** — `updateRuleCategory(id, category)`: a dot-path
   Firestore update (`{'set.category': category}`, touches nothing else on the rule) plus
   the matching local-state update, same shape as the existing `toggleRule`.

7. **`src/components/DataChatSheet.tsx`** — `resolvedCategories` (one `useMemo`, feeds the
   chat context, the parser, and the cards). One `CategoryProposalCard`, three kinds:
   `add`/`rename` always offer Apply (nothing to resolve against real data); `remove` shows
   the exact `{transactions, rules, bills}` counts BEFORE applying via the new pure,
   exported `planCategoryRemoval(value, transactions, rules, bills)` — same preview-before-
   write contract `RulePreviewCard` already has. Apply: `Promise.all` of
   `updateTransaction`/`updateRuleCategory`/`updateBill` over exactly the previewed ids,
   then `archived: true` on the settings entry via the same `updateProfile` round trip
   FIN-SPEND-001 uses (no new write path) — never orphaning the removed value. `add`/`rename`
   write the same way. Unresolvable `value` (already removed) renders words, no button —
   same contract every other card here uses.

## Tests (TDD, red-first where practical)

- `src/__tests__/types.test.ts` — `resolveCategories` (absent/defaults, custom appended,
  custom icon kept, archived passed through, default-collision dropped, duplicate-value
  collision collapses); `slugForCategoryLabel` (normalize, empty-label fallback, 32-char
  cap, collision suffixing).
- `functions/src/__tests__/decisions.test.ts` — non-string category always rejected;
  `validateOp` with an explicit set rejects/accepts correctly; omitted `categories` defers
  (doesn't wrongly reject); `applyDecisionCore` accepts a ledger-resolved custom category,
  rejects one outside even that set, rejects an ARCHIVED one, and falls back to the 13
  defaults when the ledger fixture has no `categories` field at all.
- `functions/src/__tests__/categories.test.ts` (new) — snapshot payload: defaults-only
  fallback, a custom entry rides through verbatim, an archived one stays present and
  marked, double-count guard (every other payload field byte-for-byte unchanged whether or
  not a custom category exists).
- `functions/src/__tests__/chat.test.ts` — teaches the three new verbs; prompt-length
  ceilings bumped with measured deltas (two tests).
- `src/__tests__/chat-actions.test.ts` — `buildChatContext` default/custom/archived-excluded;
  `create_rule` rejects a custom category with no owner set, accepts it when given one,
  still rejects one outside even the custom set, rejects an archived one; full parse
  matrices for `add_category` (valid, minimal, empty label/reason/icon, unknown key, no
  model-supplied `value`), `rename_category` (valid, no context, unowned value, built-in
  default rejected, empty label/reason, unknown key), `remove_category` (default
  `reassignTo`, explicit `reassignTo`, no context, unowned value, built-in default
  rejected, reassign-to-self rejected, reassign-to-unowned rejected, reassign-to-archived
  rejected, empty reason, unknown key).
- `src/__tests__/transaction-context-add-rule.test.ts` — `updateRuleCategory` updates local
  state and writes exactly `{'set.category': ...}` via a dot-path update.
- `src/__tests__/data-chat-sheet.test.tsx` — `add_category` (shows + writes only on Apply,
  icon omitted-not-undefined, collision-safe slug derivation, Cancel writes nothing);
  `rename_category` (current→new, writes only on Apply, Cancel); `remove_category` (exact
  counts shown BEFORE applying with nothing written yet; Apply moves exactly the previewed
  plan across all three collections then archives the category and reports what moved;
  explicit `reassignTo` honored; Cancel writes nothing; the zero-everywhere case previews
  and applies cleanly).

## Verification

- `functions`: 108 → **120** tests, all green. `npm run build` (tsc + tsc-alias) clean.
- web (`npx jest`): 1520 → **1571** tests, all green (9 pre-existing skips unrelated).
- `npx tsc --noEmit -p tsconfig.json`: clean.
- `npm run build` (`next build`, production): compiles and prerenders clean.
- `counterparty.ts` / `flow-lanes.ts` / `flow-simple.ts`: untouched (verified via
  per-commit `git show --stat`).

## Follow-ups (not built here)

- Web pickers (Add Transaction, Budget Settings, Planned Payments, CSV Import, Receipt
  Scanner, Account Transactions) still hardcode the 13 defaults — a custom category the
  owner adds via chat has no manual-entry picker yet.
- `mcp/load-firestore.ts`'s dev-only category coercion still only recognizes the 13.
- Mobile's own `categories.ts` mirror (the other half of cashflow-mobile#24) is out of
  scope for this server/web half — the snapshot payload it needs (`categories:
  {value,label,icon,archived}[]`) is now shipping.
- No `undo` affordance on the three new verbs — matches `record_bill`'s existing precedent
  (no undo there either), not epic #23's aspirational "every applied change offers Undo"
  standard, which this task's concrete design spec did not ask for.
