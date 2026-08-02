/**
 * User-defined mapping rules — "anything from Instacart is Groceries".
 *
 * The owner's explicit intent, stored durably at users/{uid}/rules/{ruleId} and applied
 * to every row as it enters TransactionContext, so a rule fixes existing history and
 * every future sync at once. Pure module: no Firestore import, so it stays testable.
 *
 * Ordering is precedence: the FIRST enabled matching rule wins. TransactionContext
 * prepends new rules, so a later correction ("no, Instacart is actually Groceries")
 * beats the older one without anyone having to delete anything.
 */

import { EXPENSE_CATEGORIES, ExpenseCategory, Transaction, TransactionType } from '@/types';

export interface MappingRule {
  id: string;
  match: { field: 'merchant' | 'title' | 'description'; op: 'contains' | 'equals'; value: string };
  set: { category?: ExpenseCategory; sourceCategory?: string; type?: TransactionType; merchant?: string };
  createdAt: string; // ISO
  enabled: boolean;
}

/** What a caller hands to addRule — id/createdAt are filled in by the store. */
export type NewMappingRule = Omit<MappingRule, 'id' | 'createdAt'> &
  Partial<Pick<MappingRule, 'id' | 'createdAt'>>;

/** The `set` minus undefined keys — Firestore rejects undefined, and so does a clean merge. */
export function definedSet(set: MappingRule['set']): Partial<Transaction> {
  return Object.fromEntries(Object.entries(set).filter(([, v]) => v !== undefined));
}

function ruleMatches(rule: MappingRule, txn: Partial<Transaction>): boolean {
  const needle = rule.match.value.trim().toLowerCase();
  // An empty needle would `includes()`-match the entire ledger and recategorize
  // everything on one stray keystroke. Matches nothing instead.
  if (!needle) return false;

  const field = txn[rule.match.field];
  if (typeof field !== 'string') return false; // field absent on this row → no match

  const haystack = field.toLowerCase();
  return rule.match.op === 'equals' ? haystack.trim() === needle : haystack.includes(needle);
}

/**
 * Applies the first enabled matching rule. Pure — returns the input untouched (same
 * reference) when nothing matches or the rule changes nothing.
 *
 * ponytail: `category`, `sourceCategory` and `merchant` are final, because nothing
 * downstream re-derives them. `type` is not: screens call classifyTransaction() on the
 * row afterwards, and that re-derives type from the title for everything except a stored
 * 'transfer'. So `set.type: 'transfer'` sticks; `set.type: 'expense'` on a row titled
 * "...TRANSFER FROM..." does not. Upgrade needs one guard in classify.ts (not owned here).
 */
export function applyMappingRules<T extends Partial<Transaction>>(txn: T, rules: MappingRule[]): T {
  const hit = rules.find((r) => r.enabled && ruleMatches(r, txn));
  if (!hit) return txn;
  const changes = definedSet(hit.set);
  return Object.keys(changes).length ? { ...txn, ...changes } : txn;
}

/** Whether applying this rule's `set` would actually alter the row. */
function wouldChange(txn: Partial<Transaction>, set: MappingRule['set']): boolean {
  const row = txn as Record<string, unknown>;
  return Object.entries(definedSet(set)).some(([k, v]) => row[k] !== v);
}

/**
 * How many EXISTING rows this rule would change, so the UI can say "matches 37
 * transactions". Ignores `enabled` on purpose — this answers "what would this do?",
 * which is asked about rules that are not saved (let alone enabled) yet.
 */
export function rulePreview(
  rule: MappingRule,
  transactions: Transaction[]
): { matches: number; sample: Transaction[] } {
  const hits = transactions.filter((t) => ruleMatches(rule, t) && wouldChange(t, rule.set));
  return { matches: hits.length, sample: hits.slice(0, 5) };
}

const categoryLabel = (c: ExpenseCategory): string =>
  EXPENSE_CATEGORIES.find((x) => x.value === c)?.label ?? c;

/** Plain English: `merchant contains "AMZN" → category Shopping`. */
export function describeRule(rule: MappingRule): string {
  const { category, sourceCategory, type, merchant } = rule.set;
  const effects = [
    category && `category ${categoryLabel(category)}`,
    sourceCategory && `label "${sourceCategory}"`,
    type && `type ${type}`,
    merchant && `merchant "${merchant}"`,
  ].filter(Boolean);

  return `${rule.match.field} ${rule.match.op} "${rule.match.value}" → ${
    effects.length ? effects.join(', ') : 'no change'
  }`;
}
