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

import { withoutSupersededHolds } from '@/lib/classify';
import { EXPENSE_CATEGORIES, ExpenseCategory, Transaction, TransactionType } from '@/types';

/**
 * MAP-001 added three OPTIONAL qualifiers to `match`. Absent — which is every rule
 * written before they existed — means exactly what it always meant: any direction, any
 * account, any date. So no stored rule changes behaviour, and `applyMappingRules` keeps
 * its signature.
 *
 * `direction` exists because it was measured to be necessary, not because it was tidy:
 * on the owner's real export, a `merchant contains ⟨normalized⟩` rule generated from an
 * unknown-INFLOW group reached 1,104 extra rows across 29 of 43 groups, 604 of them
 * OUTFLOWS to the same merchant. Without this field the only honest scope would have
 * been "this group only", i.e. no persistent learning at all.
 */
export interface RuleMatch {
  field: 'merchant' | 'title' | 'description';
  op: 'contains' | 'equals';
  value: string;
  /** Money in or money out. Absent = both, the pre-MAP-001 meaning. */
  direction?: 'inflow' | 'outflow';
  /** One account. Absent = every account. */
  accountId?: string;
  /** ISO day. Absent = all history; present = rows dated on or after it only. */
  onOrAfter?: string;
}

export interface MappingRule {
  id: string;
  match: RuleMatch;
  set: { category?: ExpenseCategory; sourceCategory?: string; type?: TransactionType; merchant?: string };
  createdAt: string; // ISO
  enabled: boolean;
}

/**
 * Which way the money went, from the row alone — no `accounts`, no `classify` import, so
 * this module stays the pure leaf it has always been. A stored `transferDirection` is
 * provider-sourced and wins; otherwise the ingest `type` says it. A row that answers
 * neither (a transfer with no stored direction) matches no direction-scoped rule, which
 * is the safe way to be unsure.
 */
export function rowDirection(txn: Partial<Transaction>): 'inflow' | 'outflow' | null {
  if (txn.transferDirection) return txn.transferDirection === 'in' ? 'inflow' : 'outflow';
  if (txn.type === 'income') return 'inflow';
  if (txn.type === 'expense') return 'outflow';
  return null;
}

/** What a caller hands to addRule — id/createdAt are filled in by the store. */
export type NewMappingRule = Omit<MappingRule, 'id' | 'createdAt'> &
  Partial<Pick<MappingRule, 'id' | 'createdAt'>>;

/** The `set` minus undefined keys — Firestore rejects undefined, and so does a clean merge. */
export function definedSet(set: MappingRule['set']): MappingRule['set'] {
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
  if (rule.match.op === 'equals' ? haystack.trim() !== needle : !haystack.includes(needle)) return false;

  // The optional qualifiers. Each one only ever NARROWS, and an absent one is skipped —
  // that is what keeps every pre-existing rule matching exactly what it used to.
  const { direction, accountId, onOrAfter } = rule.match;
  if (direction && rowDirection(txn) !== direction) return false;
  if (accountId && txn.accountId !== accountId) return false;
  if (onOrAfter && (txn.date ?? '').slice(0, 10) < onOrAfter) return false;
  return true;
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

/**
 * Rules then holds — TransactionContext's exact order, verified at
 * src/context/TransactionContext.tsx:176-181: every row is passed through the
 * owner's mapping rules first, and the superseded-hold guard runs on THAT
 * result. Neither step is order-sensitive today — no rule's `set` touches the
 * `pending`/`pendingTransactionId` fields the hold guard reads — but the
 * browser and every server derivation built on this (`readLedger` and, through
 * it, `homeSnapshot`/`reviewQueue`/`flowSnapshot`/`flowNodeDetail`) must share
 * ONE derivation, not two orders that happen to agree by coincidence.
 */
export const interpretLedgerRows = (
  transactions: Transaction[],
  rules: MappingRule[],
): Transaction[] =>
  withoutSupersededHolds(
    rules.length ? transactions.map((t) => applyMappingRules(t, rules)) : transactions,
  );

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

/**
 * Plain English: `merchant contains "AMZN" → category Shopping`.
 *
 * A qualifier that is set is SAID. A rule whose scope is invisible is the thing
 * FIN-REVIEW-002 §7.3 exists to prevent, and a silent narrowing is as misleading as a
 * silent widening.
 */
export function describeRule(rule: MappingRule): string {
  const { category, sourceCategory, type, merchant } = rule.set;
  const effects = [
    category && `category ${categoryLabel(category)}`,
    sourceCategory && `label "${sourceCategory}"`,
    type && `type ${type}`,
    merchant && `merchant "${merchant}"`,
  ].filter(Boolean);

  const { direction, accountId, onOrAfter } = rule.match;
  const qualifiers = [
    direction && (direction === 'inflow' ? 'money in only' : 'money out only'),
    accountId && 'one account only',
    onOrAfter && `dated ${onOrAfter} or later`,
  ].filter(Boolean);

  return `${rule.match.field} ${rule.match.op} "${rule.match.value}"${
    qualifiers.length ? ` (${qualifiers.join(', ')})` : ''
  } → ${effects.length ? effects.join(', ') : 'no change'}`;
}
