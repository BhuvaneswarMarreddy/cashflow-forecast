import { BATCH_LIMIT, buildRemovalPlan, chunk, validateRemoveCategoryOp } from '../categoryRemoval';
import { EXPENSE_CATEGORIES } from '@/types';
import type { CategoryBudget, PlannedTransaction, ResolvedCategory } from '@/types';
import type { Ledger } from '../snapshot';

// Same idea as decisions.test.ts's fixture: a plain object shaped like the bits
// of `Ledger` this file's pure core actually reads (transactions/rules/bills),
// cast `as never` at the call site rather than satisfying the full interface.
const ledger = {
  transactions: [
    { id: 't1', category: 'vacations' },
    { id: 't2', category: 'vacations' },
    { id: 't3', category: 'food' },
  ],
  rules: [
    { id: 'r1', set: { category: 'vacations' } },
    { id: 'r2', set: { category: 'other' } },
  ],
  bills: [
    { id: 'b1', category: 'vacations' },
    { id: 'b2', category: 'shopping' },
  ],
} as unknown as Ledger;

describe('buildRemovalPlan — exactly the rows filed under `value`, nothing else', () => {
  it('collects matching transaction/rule/bill ids and only those', () => {
    expect(buildRemovalPlan(ledger, 'vacations')).toEqual({
      transactionIds: ['t1', 't2'],
      ruleIds: ['r1'],
      billIds: ['b1'],
      budgetIndexes: [],
      plannedTransactionIds: [],
    });
  });

  it('a category nothing is filed under returns empty everywhere', () => {
    expect(buildRemovalPlan(ledger, 'no-such-category')).toEqual({
      transactionIds: [], ruleIds: [], billIds: [], budgetIndexes: [], plannedTransactionIds: [],
    });
  });
});

/**
 * The sweep used to stop at transactions/rules/bills. Two more stores hold a
 * removable category value and were left pointing at an archived one:
 * settings.categoryBudgets[].categoryId (BudgetSettingsPanel.tsx) and
 * plannedTransactions/{id}.category (PlannedPaymentsPanel.tsx). Neither lives
 * on `Ledger` (readLedger never fetches either), so they arrive as `extra`,
 * read separately by the callable.
 */
describe('buildRemovalPlan — categoryBudgets and plannedTransactions sweep', () => {
  const categoryBudgets = [
    { categoryId: 'vacations', monthlyLimit: 200, isEnabled: true },
    { categoryId: 'food', monthlyLimit: 400, isEnabled: true },
    { categoryId: 'vacations', monthlyLimit: 50, isEnabled: false },
  ] as unknown as CategoryBudget[];
  const plannedTransactions = [
    { id: 'p1', category: 'vacations' },
    { id: 'p2', category: 'food' },
  ] as unknown as PlannedTransaction[];

  it('collects the index of every budget row and the id of every planned row filed under `value`', () => {
    const plan = buildRemovalPlan(ledger, 'vacations', { categoryBudgets, plannedTransactions });
    expect(plan.budgetIndexes).toEqual([0, 2]);
    expect(plan.plannedTransactionIds).toEqual(['p1']);
  });

  it('a budget/planned row filed under a DIFFERENT category is left out — untouched', () => {
    const plan = buildRemovalPlan(ledger, 'vacations', { categoryBudgets, plannedTransactions });
    expect(plan.budgetIndexes).not.toContain(1); // the 'food' budget at index 1
    expect(plan.plannedTransactionIds).not.toContain('p2'); // the 'food' planned row
  });

  it('a category nothing is filed under returns empty budget/planned lists too', () => {
    const plan = buildRemovalPlan(ledger, 'no-such-category', { categoryBudgets, plannedTransactions });
    expect(plan.budgetIndexes).toEqual([]);
    expect(plan.plannedTransactionIds).toEqual([]);
  });

  it('omitted `extra` defaults to no budget/planned rows in the plan', () => {
    expect(buildRemovalPlan(ledger, 'vacations')).toEqual({
      transactionIds: ['t1', 't2'],
      ruleIds: ['r1'],
      billIds: ['b1'],
      budgetIndexes: [],
      plannedTransactionIds: [],
    });
  });
});

const CATEGORIES: ResolvedCategory[] = [
  ...EXPENSE_CATEGORIES.map((c) => ({ ...c, archived: false })),
  { value: 'vacations', label: 'Vacations', icon: '🏖️', archived: false },
  { value: 'retired-thing', label: 'Retired Thing', icon: '🗑️', archived: true },
];

describe('validateRemoveCategoryOp — shape, refusals, and reassignTo default (cashflow-mobile#28)', () => {
  it('rejects a missing or empty value', () => {
    expect(() => validateRemoveCategoryOp({})).toThrow();
    expect(() => validateRemoveCategoryOp({ value: '' })).toThrow();
    expect(() => validateRemoveCategoryOp({ value: 123 })).toThrow();
  });

  it('rejects a value or reassignTo over 32 characters', () => {
    expect(() => validateRemoveCategoryOp({ value: 'a'.repeat(33) })).toThrow();
    expect(() => validateRemoveCategoryOp({ value: 'vacations', reassignTo: 'b'.repeat(33) })).toThrow();
  });

  it('defaults reassignTo to "other" when omitted', () => {
    expect(validateRemoveCategoryOp({ value: 'vacations' })).toEqual({ value: 'vacations', reassignTo: 'other' });
  });

  it('rejects reassignTo equal to value, default or explicit', () => {
    expect(() => validateRemoveCategoryOp({ value: 'vacations', reassignTo: 'vacations' })).toThrow();
  });

  it('omitted categories skips the membership check — every shape-valid op passes', () => {
    expect(() => validateRemoveCategoryOp({ value: 'anything-shape-valid' })).not.toThrow();
  });

  it('rejects one of the 13 defaults as `value` — defaults are #27\'s job, not this one\'s', () => {
    expect(() => validateRemoveCategoryOp({ value: 'food' }, CATEGORIES)).toThrow();
  });

  it('rejects a `value` the owner does not actually have', () => {
    expect(() => validateRemoveCategoryOp({ value: 'not-a-real-category' }, CATEGORIES)).toThrow();
  });

  it('accepts a real custom `value`, including one already archived (retry-safe)', () => {
    expect(validateRemoveCategoryOp({ value: 'vacations' }, CATEGORIES)).toEqual({ value: 'vacations', reassignTo: 'other' });
    expect(validateRemoveCategoryOp({ value: 'retired-thing', reassignTo: 'other' }, CATEGORIES))
      .toEqual({ value: 'retired-thing', reassignTo: 'other' });
  });

  it('rejects a reassignTo the owner does not have', () => {
    expect(() => validateRemoveCategoryOp({ value: 'vacations', reassignTo: 'not-real' }, CATEGORIES)).toThrow();
  });

  it('rejects a reassignTo that IS a real category but archived — never file a fresh move into a removed one', () => {
    expect(() => validateRemoveCategoryOp({ value: 'vacations', reassignTo: 'retired-thing' }, CATEGORIES)).toThrow();
  });

  it('accepts an explicit, live reassignTo', () => {
    expect(validateRemoveCategoryOp({ value: 'vacations', reassignTo: 'shopping' }, CATEGORIES))
      .toEqual({ value: 'vacations', reassignTo: 'shopping' });
  });
});

describe('chunk — the >500-op batching boundary (cashflow-mobile#28)', () => {
  it('an empty list chunks to nothing', () => {
    expect(chunk([])).toEqual([]);
  });

  it('exactly BATCH_LIMIT items stay in one chunk', () => {
    const items = Array.from({ length: BATCH_LIMIT }, (_, i) => i);
    const chunks = chunk(items);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(BATCH_LIMIT);
  });

  it('one over BATCH_LIMIT spills into a second chunk', () => {
    const items = Array.from({ length: BATCH_LIMIT + 1 }, (_, i) => i);
    const chunks = chunk(items);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(BATCH_LIMIT);
    expect(chunks[1]).toHaveLength(1);
  });

  it('a custom size is honoured (used by the callable\'s own default only)', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
