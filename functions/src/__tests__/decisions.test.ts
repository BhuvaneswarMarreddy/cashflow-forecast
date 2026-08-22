import { getFirestore } from 'firebase-admin/firestore';

import { applyDecisionCore, undoDecision, undoPatch, validateOp } from '../decisions';
import { EXPENSE_CATEGORIES } from '@/types';

const DEFAULT_CATEGORIES = new Set(EXPENSE_CATEGORIES.map((c) => c.value));

// Only undoDecision (the callable) touches Firestore in this file — the mock
// exists purely for its two tests below, same shape as rate-limit.test.ts.
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(),
  Timestamp: { now: jest.fn(() => 'TS') },
}));

const ledger = {
  transactions: [
    { id: 't1', merchant: 'COSTCO WHSE #55', title: 'COSTCO', category: 'shopping', date: '2026-06-03' },
    { id: 't2', merchant: 'COSTCO GAS', title: 'COSTCO GAS', category: 'auto', date: '2026-07-11' },
    { id: 't3', merchant: 'TRADER JOES', title: 'TJ', category: 'groceries', date: '2026-07-12' },
    { id: 't4', merchant: 'COSTCO BUSINESS', title: 'COSTCO', category: 'food', date: '2026-08-02' },
  ],
  rules: [],
} as never;

const op = {
  kind: 'merchantRule',
  match: { field: 'merchant', op: 'contains', value: 'COSTCO' },
  // 'food' — a real member of ExpenseCategory (src/types/index.ts) — now that
  // validateOp enforces set.category membership. t4 above is pre-set to
  // 'food' on purpose, to keep exercising "already has the target value".
  set: { category: 'food' },
} as const;

it('builds the rule doc and counts exactly the rows the rule changes', () => {
  const { ruleDoc, summary } = applyDecisionCore(ledger, op as never, '2026-08-21T00:00:00.000Z');
  expect(ruleDoc).toEqual({
    match: op.match, set: op.set,
    createdAt: '2026-08-21T00:00:00.000Z', enabled: true,
  });
  expect(summary.transactionsMatched).toBe(2); // t1 (shopping→food) and t2 (auto→food), not t3 (no match) or t4 (already food)
  expect(summary.monthsAffected).toEqual(['2026-06', '2026-07']);
});

describe('applyDecisionCore — validates against the LEDGER\'s resolved categories (cashflow-mobile#24)', () => {
  it('accepts a custom category present in ledger.categories', () => {
    const withCustom = {
      ...(ledger as unknown as Record<string, unknown>),
      categories: [
        ...EXPENSE_CATEGORIES.map((c) => ({ ...c, archived: false })),
        { value: 'vacations', label: 'Vacations', icon: '🏖️', archived: false },
      ],
    };
    expect(() =>
      applyDecisionCore(withCustom as never, { ...op, set: { category: 'vacations' } } as never, '2026-08-21T00:00:00.000Z')
    ).not.toThrow();
  });

  it('still rejects a category outside even the ledger\'s resolved set', () => {
    expect(() =>
      applyDecisionCore(ledger, { ...op, set: { category: 'not-a-real-category' } } as never, '2026-08-21T00:00:00.000Z')
    ).toThrow();
  });

  it('rejects an ARCHIVED category — no new row may be filed under it', () => {
    const withArchived = {
      ...(ledger as unknown as Record<string, unknown>),
      categories: [
        ...EXPENSE_CATEGORIES.map((c) => ({ ...c, archived: false })),
        { value: 'vacations', label: 'Vacations', icon: '🏖️', archived: true },
      ],
    };
    expect(() =>
      applyDecisionCore(withArchived as never, { ...op, set: { category: 'vacations' } } as never, '2026-08-21T00:00:00.000Z')
    ).toThrow();
  });

  it('a ledger with no categories field falls back to the 13 defaults, exactly today\'s behaviour', () => {
    expect(() =>
      applyDecisionCore(ledger, { ...op, set: { category: 'food' } } as never, '2026-08-21T00:00:00.000Z')
    ).not.toThrow();
  });
});

it('rejects malformed ops with the rules-file constraints', () => {
  expect(() => validateOp({ kind: 'merchantRule', match: { field: 'x', op: 'contains', value: 'a' }, set: {} } as never)).toThrow();
  expect(() => validateOp({ ...op, match: { ...op.match, value: '' } } as never)).toThrow();
  expect(() => validateOp({ ...op, match: { ...op.match, value: 'a'.repeat(201) } } as never)).toThrow();
  expect(() => validateOp({ ...op, set: {} } as never)).toThrow(); // a rule that sets nothing is noise
});

// FIX 1: `set` is unconstrained today and the Admin SDK bypasses firestore.rules, so
// validateOp is the ONLY gate on what a decision can write.
it('rejects a set key outside category/sourceCategory/type/merchant', () => {
  expect(() => validateOp({ ...op, set: { category: 'food', notAKey: 'x' } } as never)).toThrow();
});

// cashflow-mobile#24: `categories` omitted defers the membership check (see the one
// after this), but a non-string category is ALWAYS malformed regardless.
it('rejects a non-string category, including null, even with no categories set given', () => {
  expect(() => validateOp({ ...op, set: { category: null } } as never)).toThrow();
  expect(() => validateOp({ ...op, set: { category: 3 } } as never)).toThrow();
});

// cashflow-mobile#24: validateOp is now closed over the OWNER's resolved set, not a
// hardcoded one — a custom category the owner actually has is accepted, and one
// they don't is still rejected. Omitting `categories` entirely (the pre-`readLedger`
// cheap guard in `applyDecision`) skips this check rather than wrongly assuming the
// 13 defaults are the only valid answer.
describe('validateOp — the owner\'s resolved category set (cashflow-mobile#24)', () => {
  it('rejects a category not in the given set', () => {
    expect(() => validateOp({ ...op, set: { category: 'not-a-real-category' } } as never, DEFAULT_CATEGORIES)).toThrow();
  });

  it('accepts a custom category when it is in the given set, and still rejects one outside it', () => {
    const owner = new Set(['food', 'other', 'vacations']);
    expect(() => validateOp({ ...op, set: { category: 'vacations' } } as never, owner)).not.toThrow();
    expect(() => validateOp({ ...op, set: { category: 'not-real' } } as never, owner)).toThrow();
  });

  it('omitted categories skips the membership check — deferred to the ledger-aware caller', () => {
    expect(() => validateOp({ ...op, set: { category: 'a-category-nobody-has' } } as never)).not.toThrow();
  });
});

it('rejects a type outside expense/income/transfer', () => {
  expect(() => validateOp({ ...op, set: { type: 'nonsense' } } as never)).toThrow();
});

it('rejects sourceCategory/merchant outside 1-200 characters', () => {
  expect(() => validateOp({ ...op, set: { sourceCategory: '' } } as never)).toThrow();
  expect(() => validateOp({ ...op, set: { merchant: 'a'.repeat(201) } } as never)).toThrow();
});

it('rejects malformed optional match qualifiers: direction, accountId, onOrAfter', () => {
  expect(() => validateOp({ ...op, match: { ...op.match, direction: 'sideways' } } as never)).toThrow();
  expect(() => validateOp({ ...op, match: { ...op.match, accountId: '' } } as never)).toThrow();
  expect(() => validateOp({ ...op, match: { ...op.match, onOrAfter: '08-21-2026' } } as never)).toThrow();
});

it('accepts valid optional match qualifiers and every allowed set field', () => {
  expect(() =>
    validateOp({
      ...op,
      match: { ...op.match, direction: 'inflow', accountId: 'acc1', onOrAfter: '2026-01-01' },
      set: { category: 'food', sourceCategory: 'Groceries', type: 'expense', merchant: 'Costco' },
    } as never)
  ).not.toThrow();
});

describe('undoPatch', () => {
  it('is exactly {enabled: false} — disable, never delete, never touch other fields', () => {
    expect(undoPatch()).toEqual({ enabled: false });
  });
});

describe('undoDecision', () => {
  it('rejects a decisionId containing "/" without touching Firestore', async () => {
    const fakeDb = { collection: jest.fn() };
    (getFirestore as jest.Mock).mockReturnValue(fakeDb);

    await expect(
      undoDecision.run({ auth: { uid: 'u1' }, data: { decisionId: 'rules/evil' } } as never),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(fakeDb.collection).not.toHaveBeenCalled();
  });

  it('raises not-found when the rule doc does not exist', async () => {
    const fakeDb = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            doc: jest.fn(() => ({ get: jest.fn(async () => ({ exists: false })) })),
          })),
        })),
      })),
    };
    (getFirestore as jest.Mock).mockReturnValue(fakeDb);

    await expect(
      undoDecision.run({ auth: { uid: 'u1' }, data: { decisionId: 'missing' } } as never),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('updates only enabled:false and writes the decision.undone audit entry', async () => {
    const updates: unknown[] = [];
    const audits: unknown[] = [];
    const fakeDb = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn((name: string) =>
            name === 'rules'
              ? {
                  doc: jest.fn(() => ({
                    get: jest.fn(async () => ({ exists: true })),
                    update: jest.fn(async (patch: unknown) => {
                      updates.push(patch);
                    }),
                  })),
                }
              : { add: jest.fn(async (entry: unknown) => audits.push(entry)) },
          ),
        })),
      })),
    };
    (getFirestore as jest.Mock).mockReturnValue(fakeDb);

    const result = await undoDecision.run({
      auth: { uid: 'u1' },
      data: { decisionId: 'r1' },
    } as never);

    expect(result).toEqual({ ok: true });
    expect(updates).toEqual([{ enabled: false }]); // rule doc otherwise untouched
    expect(audits).toEqual([{ at: 'TS', actor: 'user', action: 'decision.undone', target: 'rules/r1' }]);
  });
});
