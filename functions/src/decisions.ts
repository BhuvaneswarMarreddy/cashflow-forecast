/**
 * applyDecision — the single validated write path for a merchant→category
 * rule, called by the mobile app today and, later, an AI chat that proposes
 * the same operation. Both must go through here rather than writing
 * `users/{uid}/rules` directly, because a rule is not just a document: it
 * silently recolors every past AND future row that matches it, so the write
 * path is also where "what did that just do?" has to be answerable.
 *
 * Two things are pure and unit-tested without an emulator (`applyDecisionCore`,
 * `validateOp`); the callable itself is the thin auth + read + write shell
 * around them, following `homeSnapshot`'s auth pattern and `resolveReview`'s
 * hand-validation + audit-write pattern.
 */

import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { applyMappingRules, definedSet, type MappingRule, type RuleMatch } from '@/lib/mapping-rules';
import { EXPENSE_CATEGORIES, type ResolvedCategory, type TransactionType } from '@/types';

import { readLedger, type Ledger } from './snapshot';

/**
 * Today there is exactly one kind of decision. `kind` exists anyway —
 * discriminated from day one — because the second kind (e.g. "always split
 * this payee") is a certainty, not a maybe, and adding a union member is a
 * smaller diff than introducing the discriminant retroactively once two
 * write paths already assume there's only one shape.
 */
export type DecisionOp = { kind: 'merchantRule'; match: RuleMatch; set: MappingRule['set'] };

/** What the write actually did, in numbers the owner can check against their
 *  own sense of "about how many". Never the rows themselves — see readLedger's
 *  callers, none of which send a transaction list to a log either. */
export type ChangeSummary = { transactionsMatched: number; monthsAffected: string[] };

const MATCH_FIELDS: RuleMatch['field'][] = ['merchant', 'title', 'description'];
const MATCH_OPS: RuleMatch['op'][] = ['contains', 'equals'];
const MATCH_DIRECTIONS: NonNullable<RuleMatch['direction']>[] = ['inflow', 'outflow'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// The exact four keys `MappingRule['set']` has — anything else must never reach
// Firestore, since the Admin SDK write below is the ONLY gate (firestore.rules
// does not check `set` at all, see isValidMappingRuleShape).
const SET_KEYS: (keyof MappingRule['set'])[] = ['category', 'sourceCategory', 'type', 'merchant'];
// cashflow-mobile#24. The fallback used whenever a caller has no owner-resolved set
// to check against — see validateOp's `categories` param and assignableCategoryValues.
const DEFAULT_CATEGORY_VALUES: ReadonlySet<string> = new Set(EXPENSE_CATEGORIES.map((c) => c.value));
const SET_TYPES: TransactionType[] = ['expense', 'income', 'transfer'];

/**
 * cashflow-mobile#24. The owner's resolved category set (defaults + custom),
 * narrowed to what a NEW row may be filed under — archived entries are excluded.
 * `undefined` (no ledger yet) falls back to the 13 defaults, which is what keeps
 * `validateOp`'s cheap pre-`readLedger` guard in `applyDecision` meaningful: it
 * cannot know the owner's custom categories without reading their settings, so it
 * defers the category-membership check specifically (still catches every other
 * malformed field), and this function is only ever called with the real ledger.
 */
function assignableCategoryValues(categories?: readonly ResolvedCategory[]): ReadonlySet<string> {
  if (!categories) return DEFAULT_CATEGORY_VALUES;
  return new Set(categories.filter((c) => !c.archived).map((c) => c.value));
}

const isBoundedString = (v: unknown, max = 200): boolean =>
  typeof v === 'string' && v.length >= 1 && v.length <= max;

/**
 * Hand validation at the trust boundary, mirroring `firestore.rules:71-83`
 * (`isValidMappingRuleShape`) exactly for `match`: field/op whitelist, a
 * needle 1-200 chars — empty would `.includes()`-match the entire ledger,
 * 201+ is already rejected on write, so reject it here with a message the
 * app can show instead of a rules-engine PERMISSION_DENIED.
 *
 * The one thing the security rules do NOT check, because "at least one
 * recognised key" is awkward to express there: `set` must be non-empty. A
 * rule that matches rows and changes nothing is silent noise sitting in the
 * list forever, so this callable is the only place that catches it before
 * it's written.
 *
 * Every field is read defensively (`op?.match` etc.) because `request.data`
 * on the real callable is attacker-controlled JSON, not a `DecisionOp` —
 * the type only documents the *valid* shape.
 *
 * cashflow-mobile#24: `categories` is the owner's resolved, assignable set
 * (defaults + their own, minus anything archived). OMITTED means "not known
 * yet" — the category-membership check is skipped (every other check still
 * runs), which is what lets `applyDecision`'s early, pre-`readLedger` guard
 * stay cheap without hard-coding the 13 defaults as if they were still the
 * only valid answer. The one caller that has a resolved set (`applyDecisionCore`,
 * via `assignableCategoryValues`) always passes it, and that call is the
 * authoritative gate — a hallucinated or unknown category is still rejected,
 * just against the OWNER's set instead of a fixed one.
 */
export function validateOp(op: DecisionOp, categories?: ReadonlySet<string>): void {
  if (!op || (op as { kind?: unknown }).kind !== 'merchantRule') {
    throw new HttpsError('invalid-argument', 'Unknown decision kind.');
  }

  const match = op.match as RuleMatch | undefined;
  if (!match || !MATCH_FIELDS.includes(match.field) || !MATCH_OPS.includes(match.op)) {
    throw new HttpsError('invalid-argument', 'Malformed match.');
  }
  if (typeof match.value !== 'string' || match.value.length < 1 || match.value.length > 200) {
    throw new HttpsError('invalid-argument', 'Match value must be 1-200 characters.');
  }
  // MAP-001's optional qualifiers — absent is always valid (any direction, any
  // account, all history); present means it must be well-formed.
  if (match.direction !== undefined && !MATCH_DIRECTIONS.includes(match.direction)) {
    throw new HttpsError('invalid-argument', 'Malformed match direction.');
  }
  if (match.accountId !== undefined && !isBoundedString(match.accountId)) {
    throw new HttpsError('invalid-argument', 'Malformed match account.');
  }
  if (match.onOrAfter !== undefined && (typeof match.onOrAfter !== 'string' || !ISO_DATE.test(match.onOrAfter))) {
    throw new HttpsError('invalid-argument', 'Malformed match date.');
  }

  // `set` itself: exactly the four keys MappingRule['set'] has, and each present
  // value well-formed. Every field is read defensively — `op.set` is
  // attacker-controlled JSON, not a `MappingRule['set']`.
  const set = (op.set ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(set)) {
    if (!SET_KEYS.includes(key as keyof MappingRule['set'])) {
      throw new HttpsError('invalid-argument', `Unknown set field "${key}".`);
    }
  }
  if (set.category !== undefined) {
    if (typeof set.category !== 'string') {
      throw new HttpsError('invalid-argument', 'Malformed category.');
    }
    if (categories && !categories.has(set.category)) {
      throw new HttpsError('invalid-argument', 'Malformed category.');
    }
  }
  if (set.type !== undefined && !SET_TYPES.includes(set.type as TransactionType)) {
    throw new HttpsError('invalid-argument', 'Malformed type.');
  }
  if (set.sourceCategory !== undefined && !isBoundedString(set.sourceCategory)) {
    throw new HttpsError('invalid-argument', 'Malformed sourceCategory.');
  }
  if (set.merchant !== undefined && !isBoundedString(set.merchant)) {
    throw new HttpsError('invalid-argument', 'Malformed merchant.');
  }

  if (!op.set || Object.keys(definedSet(op.set)).length === 0) {
    throw new HttpsError('invalid-argument', 'A rule must set at least one field.');
  }
}

/**
 * Pure core: builds the rule document that would be written, and previews
 * its effect by running it — ONLY it, not the owner's existing rules — over
 * every ledger row. `applyMappingRules` takes one transaction at a time and
 * returns the same reference when the candidate doesn't match (see
 * `@/lib/mapping-rules`), so `mapped !== txn` means the rule matched. However,
 * a match is not the same as a change: ledger transactions arrive already
 * rule-applied, so a row whose values already equal the rule's `set` must not
 * be counted as changed. We must check that at least one key in the rule's
 * `set` actually differs from the transaction's current value. Existing rules
 * are irrelevant to that question — this answers "what does the NEW rule do",
 * not "what does the final precedence chain produce."
 *
 * `now` is a parameter, not `new Date()` inline, so this stays pure and
 * testable without freezing the clock.
 */
export function applyDecisionCore(
  ledger: Ledger,
  op: DecisionOp,
  now: string,
): { ruleDoc: Omit<MappingRule, 'id'>; summary: ChangeSummary } {
  // cashflow-mobile#24: the authoritative category check — the owner's resolved,
  // assignable set, not the hardcoded 13. `ledger.categories` is always populated
  // by readLedger in production; a fixture that omits it (see decisions.test.ts)
  // falls back to the defaults via assignableCategoryValues.
  validateOp(op, assignableCategoryValues(ledger.categories));

  const ruleDoc: Omit<MappingRule, 'id'> = {
    match: op.match,
    // Firestore rejects `undefined` values outright; `definedSet` is the same
    // guard the browser applies at TransactionContext.tsx:193 before its own
    // `setDoc`, so neither write path can persist an undefined/null-laden set.
    set: definedSet(op.set),
    createdAt: now,
    enabled: true,
  };
  const candidate = { ...ruleDoc, id: '__candidate__' } as MappingRule;

  const monthsAffected = new Set<string>();
  let transactionsMatched = 0;
  for (const txn of ledger.transactions) {
    const mapped = applyMappingRules(txn, [candidate]);
    if (mapped !== txn) {
      // Rule matched. Now check if any value actually differs from what's
      // already set on the transaction. Only count it if at least one field
      // in the rule's `set` differs from the current value.
      const wouldChange = Object.entries(candidate.set)
        .filter(([, v]) => v !== undefined)
        .some(([k, v]) => (txn as unknown as Record<string, unknown>)[k] !== v);
      if (wouldChange) {
        transactionsMatched += 1;
        monthsAffected.add(txn.date.slice(0, 7)); // yyyy-MM
      }
    }
  }

  return {
    ruleDoc,
    summary: { transactionsMatched, monthsAffected: Array.from(monthsAffected).sort() },
  };
}

/**
 * The callable. Auth check copied verbatim from `homeSnapshot` — every
 * callable in this codebase enforces it the same way, not a shared wrapper,
 * because there is exactly one line of it.
 *
 * One rule doc write, one audit entry — the audit shape is deliberately NOT
 * `resolveReview`'s (`{ action, at, actor, after }`); it's the minimal shape
 * `firestore.rules:239-244` actually requires: `{ at, actor, action, target }`.
 * `resolveReview`'s extra `after` field is that callable's own choice, not a
 * house style to copy forward.
 */
export const applyDecision = onCall({ cors: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to apply a decision.');
  }

  const op = (request.data ?? {}) as DecisionOp;
  // Validate before paying for `readLedger`'s nine parallel reads — a
  // malformed request should fail cheaply. `applyDecisionCore` validates
  // again as its own precondition (it has no other caller to trust); calling
  // a pure, cheap function twice is not the duplication worth avoiding here.
  //
  // cashflow-mobile#24: `categories` is omitted here on purpose — the owner's
  // resolved set lives in their settings, inside the ledger this guard is
  // specifically trying to avoid reading yet. Every OTHER malformed field
  // (kind, match, set keys, type, sourceCategory/merchant bounds) is still
  // caught cheaply here; only the category-membership check is deferred to
  // applyDecisionCore's call below, which has the real ledger.
  validateOp(op);

  const ledger = await readLedger(request.auth.uid);
  const now = new Date().toISOString();
  const { ruleDoc, summary } = applyDecisionCore(ledger, op, now);

  const user = getFirestore().collection('users').doc(request.auth.uid);
  const ruleRef = user.collection('rules').doc();
  await ruleRef.set(ruleDoc);

  // Immutable trail beside the mutable rule, same reasoning as resolveReview:
  // a rule can be superseded (disabled, replaced by a newer one) but never
  // quietly rewritten without a record that it happened.
  await user.collection('audit').add({
    at: Timestamp.now(),
    actor: 'user',
    action: 'decision.applied',
    target: `rules/${ruleRef.id}`,
  });

  // Counts only — never merchant names, category values, or the affected
  // months array itself. Same discipline as the rest of this codebase: a
  // figure belongs to the owner's screen, not to a log line.
  console.log('applyDecision', {
    transactionsMatched: summary.transactionsMatched,
    monthsAffectedCount: summary.monthsAffected.length,
  });

  return { decisionId: ruleRef.id, changed: summary };
});

/**
 * The patch `undoDecision` applies — a plain function, not a `new Date()`-style
 * inline literal, so a test can assert its exact shape the same way
 * `applyDecisionCore` lets a test assert the rule doc's shape without an
 * emulator. `enabled: false` and nothing else: undo is a toggle, not a
 * rewrite. Deleting the rule doc would also erase `match`/`set`/`createdAt` —
 * the only record of what the rule ever did — so disabling is the only
 * correct undo. A disabled rule simply stops being picked up wherever rules
 * are read (`applyMappingRules` et al.), same mechanism `firestore.rules:189`
 * already assumes when it calls enable/disable "an update".
 */
export function undoPatch(): { enabled: false } {
  return { enabled: false };
}

/**
 * The callable. Same auth + not-found + audit shape as `resolveReview`'s
 * `transactionId` lookup: read the doc first so a missing id is a clean
 * `not-found` instead of `update()`'s own (less clear) failure, then write
 * the patch and the audit entry beside it.
 */
export const undoDecision = onCall({ cors: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to undo a decision.');
  }

  const { decisionId } = (request.data ?? {}) as { decisionId?: string };
  if (!decisionId) {
    throw new HttpsError('invalid-argument', 'Which decision?');
  }
  // A doc id containing '/' changes the path .doc() resolves — e.g.
  // `rules/evil` would target a different collection entirely, not the rule
  // it looks like it names. Reject before it ever reaches a ref.
  if (decisionId.includes('/')) {
    throw new HttpsError('invalid-argument', 'Malformed decision id.');
  }

  const user = getFirestore().collection('users').doc(request.auth.uid);
  const ruleRef = user.collection('rules').doc(decisionId);

  const rule = await ruleRef.get();
  if (!rule.exists) {
    throw new HttpsError('not-found', 'No such decision.');
  }

  await ruleRef.update(undoPatch());

  // Same immutable-trail reasoning as applyDecision's own audit write, and
  // the exact shape `firestore.rules:239-244` requires.
  await user.collection('audit').add({
    at: Timestamp.now(),
    actor: 'user',
    action: 'decision.undone',
    target: `rules/${decisionId}`,
  });

  return { ok: true };
});
