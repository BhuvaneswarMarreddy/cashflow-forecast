/**
 * removeCategory — cashflow-mobile#28. Removing a category used to sweep
 * client-side (DataChatSheet.tsx): N transaction writes + M rule writes + bill
 * writes + the settings archive, none of it atomic and none of it reachable
 * from mobile (which could only render remove_category as an explanation, not
 * an action). This callable does the whole sweep server-side, one request.
 *
 * Same split as decisions.ts: a pure core (`buildRemovalPlan`,
 * `validateRemoveCategoryOp`, `chunk`) unit-tested without an emulator, and a
 * thin auth + read + write shell around it, following `homeSnapshot`'s auth
 * pattern and `resolveReview`'s hand-validation + audit-write pattern.
 */

import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import type { CustomCategory } from '@/types';
import { EXPENSE_CATEGORIES, type ResolvedCategory } from '@/types';

import { readLedger, type Ledger } from './snapshot';

// Mirrors chat-actions.ts's MAX.categoryValue (32) — the same cap
// slugForCategoryLabel (src/types/index.ts) enforces on every value a
// category can ever have.
const MAX_VALUE_LEN = 32;

const DEFAULT_CATEGORY_VALUES: ReadonlySet<string> = new Set(EXPENSE_CATEGORIES.map((c) => c.value));

// A Firestore batch caps at 500 write ops. A sweep bigger than that commits in
// more than one batch — see `chunk` below — which means the sweep as a whole
// is no longer a single atomic transaction (each chunk still is). Acceptable
// here: a partial sweep leaves the archived-but-still-referenced rows
// re-targetable by a repeat call, same retry contract DataChatSheet's old
// client-side sweep already relied on.
export const BATCH_LIMIT = 500;

export interface RemovalPlan {
  transactionIds: string[];
  ruleIds: string[];
  billIds: string[];
}

/**
 * Everything currently filed under `value` — same three collections
 * DataChatSheet.tsx's own `planCategoryRemoval` previews client-side, computed
 * fresh here from the server's own ledger read so the callable never trusts a
 * client-supplied count.
 */
export function buildRemovalPlan(ledger: Ledger, value: string): RemovalPlan {
  return {
    transactionIds: ledger.transactions.filter((t) => t.category === value).map((t) => t.id),
    ruleIds: ledger.rules.filter((r) => r.set.category === value).map((r) => r.id),
    billIds: ledger.bills.filter((b) => b.category === value).map((b) => b.id),
  };
}

/**
 * Cheap shape check, then (when `categories` is given — the owner's resolved
 * set) the authoritative membership check, mirroring chat-actions.ts's
 * remove_category parsing exactly: `value` must be a CUSTOM entry the owner
 * already has (a default, one of the 13 EXPENSE_CATEGORIES, can never be
 * removed — that's #27's job, not this one); `reassignTo` defaults to
 * 'other', must differ from `value`, and must resolve to a live, assignable
 * (non-archived) category.
 *
 * `categories` omitted (the pre-`readLedger` guard, same reasoning as
 * decisions.ts's `validateOp`) skips the membership check — every other
 * malformed shape is still caught cheaply before paying for the ledger read.
 */
export function validateRemoveCategoryOp(
  op: { value?: unknown; reassignTo?: unknown },
  categories?: readonly ResolvedCategory[],
): { value: string; reassignTo: string } {
  const value = typeof op.value === 'string' ? op.value : '';
  if (!value || value.length > MAX_VALUE_LEN) {
    throw new HttpsError('invalid-argument', 'Malformed category value.');
  }

  let reassignTo = 'other';
  if (op.reassignTo !== undefined) {
    if (typeof op.reassignTo !== 'string' || !op.reassignTo || op.reassignTo.length > MAX_VALUE_LEN) {
      throw new HttpsError('invalid-argument', 'Malformed reassignTo.');
    }
    reassignTo = op.reassignTo;
  }
  if (reassignTo === value) {
    throw new HttpsError('invalid-argument', 'Cannot reassign a category to itself.');
  }

  if (categories) {
    const isDefault = DEFAULT_CATEGORY_VALUES.has(value);
    if (isDefault || !categories.some((c) => c.value === value)) {
      throw new HttpsError('invalid-argument', 'Not a removable category.');
    }
    if (!categories.some((c) => c.value === reassignTo && !c.archived)) {
      throw new HttpsError('invalid-argument', 'reassignTo is not an assignable category.');
    }
  }

  return { value, reassignTo };
}

/** Splits a list into groups of at most `size` (BATCH_LIMIT by default) — one
 *  Firestore batch per group, since a single batch caps at 500 write ops. */
export function chunk<T>(items: readonly T[], size = BATCH_LIMIT): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const removeCategory = onCall({ cors: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to remove a category.');
  }

  const raw = (request.data ?? {}) as { value?: unknown; reassignTo?: unknown };
  // Cheap shape check before readLedger's nine parallel reads — see
  // decisions.ts's applyDecision for the same reasoning.
  validateRemoveCategoryOp(raw);

  const ledger = await readLedger(request.auth.uid);
  const { value, reassignTo } = validateRemoveCategoryOp(raw, ledger.categories);
  const plan = buildRemovalPlan(ledger, value);

  const db = getFirestore();
  const user = db.collection('users').doc(request.auth.uid);

  const writes: { ref: FirebaseFirestore.DocumentReference; patch: Record<string, unknown> }[] = [
    ...plan.transactionIds.map((id) => ({
      ref: user.collection('transactions').doc(id),
      patch: { category: reassignTo },
    })),
    // Dot-path update — same field TransactionContext.updateRuleCategoryAwaited
    // writes client-side — touches only `set.category`, never the rest of the
    // rule doc (match, enabled, createdAt).
    ...plan.ruleIds.map((id) => ({
      ref: user.collection('rules').doc(id),
      patch: { 'set.category': reassignTo },
    })),
    ...plan.billIds.map((id) => ({
      ref: user.collection('bills').doc(id),
      patch: { category: reassignTo },
    })),
  ];

  for (const group of chunk(writes)) {
    const batch = db.batch();
    for (const { ref, patch } of group) batch.update(ref, patch);
    await batch.commit();
  }

  // Archived, not deleted — a row that (despite the sweep above) still carries
  // the old value must still resolve a label. Read raw settings.categories
  // fresh rather than reusing ledger.categories, which is the RESOLVED set
  // (13 defaults folded in) and must never itself be persisted back.
  const userDoc = await user.get();
  const settings = (userDoc.data()?.settings ?? {}) as { categories?: CustomCategory[] };
  const current = Array.isArray(settings.categories) ? settings.categories : [];
  const nextCategories = current.map((c) => (c.value === value ? { ...c, archived: true } : c));
  await user.update({ 'settings.categories': nextCategories });

  // Immutable trail, same shape firestore.rules:239-244 requires and the same
  // pattern decisions.ts's applyDecision uses.
  await user.collection('audit').add({
    at: Timestamp.now(),
    actor: 'user',
    action: 'category.removed',
    target: `settings/categories/${value}`,
  });

  const moved = {
    transactions: plan.transactionIds.length,
    rules: plan.ruleIds.length,
    bills: plan.billIds.length,
  };

  // Counts only — never the rows or the category value itself. Same discipline
  // as applyDecision's own console.log.
  console.log('removeCategory', moved);

  return { moved };
});
