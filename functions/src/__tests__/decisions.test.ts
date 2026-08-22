import { applyDecisionCore, validateOp } from '../decisions';

const ledger = {
  transactions: [
    { id: 't1', merchant: 'COSTCO WHSE #55', title: 'COSTCO', category: 'shopping', date: '2026-06-03' },
    { id: 't2', merchant: 'COSTCO GAS', title: 'COSTCO GAS', category: 'auto', date: '2026-07-11' },
    { id: 't3', merchant: 'TRADER JOES', title: 'TJ', category: 'groceries', date: '2026-07-12' },
  ],
  rules: [],
} as never;

const op = {
  kind: 'merchantRule',
  match: { field: 'merchant', op: 'contains', value: 'COSTCO' },
  set: { category: 'groceries' },
} as const;

it('builds the rule doc and counts exactly the rows the rule changes', () => {
  // 'groceries' is not a member of ExpenseCategory in this codebase (see
  // src/types/index.ts) — irrelevant to applyDecisionCore, which never
  // validates `set` values, only that `set` is non-empty. `as never` matches
  // `ledger`'s cast above for the same reason: this fixture is a plain
  // literal, not a typed MappingRule.
  const { ruleDoc, summary } = applyDecisionCore(ledger, op as never, '2026-08-21T00:00:00.000Z');
  expect(ruleDoc).toEqual({
    match: op.match, set: op.set,
    createdAt: '2026-08-21T00:00:00.000Z', enabled: true,
  });
  expect(summary.transactionsMatched).toBe(2); // both COSTCO rows, not TJ
  expect(summary.monthsAffected).toEqual(['2026-06', '2026-07']);
});

it('rejects malformed ops with the rules-file constraints', () => {
  expect(() => validateOp({ kind: 'merchantRule', match: { field: 'x', op: 'contains', value: 'a' }, set: {} } as never)).toThrow();
  expect(() => validateOp({ ...op, match: { ...op.match, value: '' } } as never)).toThrow();
  expect(() => validateOp({ ...op, match: { ...op.match, value: 'a'.repeat(201) } } as never)).toThrow();
  expect(() => validateOp({ ...op, set: {} } as never)).toThrow(); // a rule that sets nothing is noise
});
