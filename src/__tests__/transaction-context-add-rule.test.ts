/**
 * #130 — TransactionContext.addRule must go through the applyDecision callable
 * (functions/src/decisions.ts), the SAME validated write path the mobile app uses,
 * instead of writing users/{uid}/rules directly. This suite renders the real
 * TransactionProvider (only @/lib/callables, @/lib/firebase and @/lib/firestore are
 * mocked — never the context itself) and drives addRule() through it, the same
 * pattern reconcile-persists-drift.test.ts uses for UserProfileProvider.
 */
import React from 'react';
import { render, act, waitFor } from '@testing-library/react';
import {
  TransactionProvider,
  TransactionContextType,
  useTransactions,
} from '@/context/TransactionContext';
import { MappingRule, NewMappingRule } from '@/lib/mapping-rules';
import type { ChangeSummary } from '@/lib/callables';

const TEST_USER = { id: 'u1', email: 'a@b.com', name: 'A', createdAt: '2026-01-01T00:00:00.000Z' };

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: TEST_USER, isAuthenticated: true, isLoading: false }),
}));

// The rules-loading effect (getDocs) and addRule's own doc()-for-an-id call are the
// only things TransactionContext still touches on '@/lib/firebase' after #130 — no
// setDoc anywhere in this file, because addRule no longer writes the collection
// directly. This mock overrides jest.setup.js's global (auth/db-only) one.
let autoId = 0;
const getDocsMock = jest.fn();
const RULES_DOCS = Promise.resolve({ docs: [] as { id: string; data: () => unknown }[] });
getDocsMock.mockReturnValue(RULES_DOCS);
const updateDocMock = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/firebase', () => ({
  db: {},
  collection: jest.fn(() => ({ __collection: true })),
  doc: jest.fn((...args: unknown[]) => {
    const last = args[args.length - 1];
    return { id: typeof last === 'string' ? last : `auto-${++autoId}`, __path: args };
  }),
  getDocs: (...args: unknown[]) => getDocsMock(...args),
  updateDoc: (...args: unknown[]) => updateDocMock(...args),
  deleteDoc: jest.fn(),
}));

const updateTransactionMock = jest.fn();
const addTransactionMock = jest.fn();
const newDocIdMock = jest.fn((userId, collection) => `${collection}-${userId}-${Date.now()}`);
jest.mock('@/lib/firestore', () => ({
  getTransactions: jest.fn().mockResolvedValue([]),
  updateTransaction: (...args: unknown[]) => updateTransactionMock(...args),
  addTransaction: (...args: unknown[]) => addTransactionMock(...args),
  newDocId: (...args: unknown[]) => newDocIdMock(...args),
}));

const applyDecisionMock = jest.fn();
jest.mock('@/lib/callables', () => ({
  applyDecision: (...args: unknown[]) => applyDecisionMock(...args),
}));

const RULE: NewMappingRule = {
  match: { field: 'merchant', op: 'contains', value: 'COSTCO' },
  set: { category: 'shopping' },
  enabled: true,
};

function Harness({ onReady }: { onReady: (ctx: TransactionContextType) => void }) {
  const ctx = useTransactions();
  onReady(ctx);
  return null;
}

/** Mounts the provider and waits for the rules-load effect to settle, so an
 *  addRule() call in the test body is never racing getDocs's own setRules(). */
async function mount(): Promise<{ get: () => TransactionContextType }> {
  let ctx: TransactionContextType | undefined;
  render(
    React.createElement(TransactionProvider, null,
      React.createElement(Harness, { onReady: (c) => { ctx = c; } }))
  );
  await act(async () => {
    await RULES_DOCS;
  });
  await waitFor(() => expect(ctx).toBeDefined());
  return { get: () => ctx! };
}

beforeEach(() => {
  applyDecisionMock.mockReset();
  getDocsMock.mockClear();
  updateDocMock.mockClear().mockResolvedValue(undefined);
  updateTransactionMock.mockReset().mockResolvedValue(undefined);
  addTransactionMock.mockReset().mockResolvedValue(undefined);
  newDocIdMock.mockClear();
});

describe('TransactionContext.addRule (#130 — applyDecision write path)', () => {
  it('prepends an optimistic entry immediately, before the callable resolves', async () => {
    let resolveApply!: (v: { decisionId: string; changed: ChangeSummary }) => void;
    applyDecisionMock.mockReturnValueOnce(new Promise((resolve) => { resolveApply = resolve; }));

    const { get } = await mount();
    let pending!: Promise<{ rule: MappingRule; changed: ChangeSummary } | undefined>;
    act(() => {
      pending = get().addRule(RULE);
    });

    // Optimistic: visible NOW, keyed by a provisional client-side id — the server
    // has not answered yet (resolveApply has not been called).
    expect(get().rules).toHaveLength(1);
    expect(get().rules[0]).toMatchObject({ match: RULE.match, set: RULE.set, enabled: true });
    expect(get().rules[0].id).toEqual(expect.any(String));
    expect(applyDecisionMock).toHaveBeenCalledWith({
      kind: 'merchantRule', match: RULE.match, set: RULE.set,
    });

    // Settle so the pending promise doesn't leak into the next test.
    await act(async () => {
      resolveApply({ decisionId: 'srv-1', changed: { transactionsMatched: 0, monthsAffected: [] } });
      await pending;
    });
  });

  it('reconciles the optimistic id to the server decisionId and returns { rule, changed }', async () => {
    const changed: ChangeSummary = { transactionsMatched: 2, monthsAffected: ['2026-07'] };
    applyDecisionMock.mockResolvedValueOnce({ decisionId: 'srv-42', changed });

    const { get } = await mount();
    const result = await act(async () => get().addRule(RULE));

    // Exactly one row — reconciled in place, never duplicated alongside the
    // provisional entry.
    expect(get().rules).toHaveLength(1);
    expect(get().rules[0].id).toBe('srv-42');
    expect(result).toEqual({
      rule: expect.objectContaining({ id: 'srv-42', match: RULE.match, set: RULE.set }),
      changed,
    });
  });

  it('rolls back the optimistic entry when applyDecision rejects, and rejects the caller', async () => {
    const err = Object.assign(new Error('nope'), { code: 'functions/invalid-argument' });
    applyDecisionMock.mockRejectedValueOnce(err);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { get } = await mount();
    let pending!: Promise<unknown>;
    act(() => {
      pending = get().addRule(RULE);
    });
    expect(get().rules).toHaveLength(1); // optimistic entry present, pre-rejection

    await act(async () => {
      await expect(pending).rejects.toBe(err);
    });

    // Today's direct-write code swallowed the failure and left the optimistic row
    // sitting in `rules` forever — a rule that looked saved but never was. #130's
    // fix: nothing durable happened, so nothing stays.
    expect(get().rules).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    // Codes and counts only in a log line — never the merchant string being ruled on.
    const loggedText = warn.mock.calls.flat().map(String).join(' ');
    expect(loggedText).not.toContain('COSTCO');

    warn.mockRestore();
  });
});

/**
 * cashflow-mobile#24 — remove_category's rule-reassignment write: an EXISTING
 * rule's set.category moves to the owner's chosen target, direct-write style
 * (same as toggleRule), not through applyDecision (that path is for NEW rules).
 */
describe('TransactionContext.updateRuleCategory (cashflow-mobile#24)', () => {
  it('updates local state immediately and writes only set.category via a dot-path update', async () => {
    applyDecisionMock.mockResolvedValueOnce({
      decisionId: 'r1',
      changed: { transactionsMatched: 0, monthsAffected: [] },
    });
    const { get } = await mount();
    await act(async () => { await get().addRule(RULE); });
    expect(get().rules[0]).toMatchObject({ id: 'r1', set: { category: 'shopping' } });

    await act(async () => { await get().updateRuleCategory('r1', 'other'); });

    // Local state: only `set.category` changed, match untouched.
    expect(get().rules[0]).toMatchObject({ id: 'r1', match: RULE.match, set: { category: 'other' } });
    // Firestore: a dot-path update, never a whole-document overwrite.
    expect(updateDocMock).toHaveBeenCalledWith(expect.anything(), { 'set.category': 'other' });
  });
});

/**
 * cashflow-mobile#24 — updateRuleCategoryAwaited and updateTransactionAwaited
 * are the primitives used by remove_category's reassignment sweep. They write
 * FIRST, then update local state (reverse of the optimistic siblings), so a
 * failed Firestore write is not masked by a local update — the next sweep
 * retry finds the row again. This test suite proves those implementations
 * carry the truthfulness guarantee: on rejection, they return false AND leave
 * state untouched; on resolution, they return true AND state reflects the change.
 */
describe('TransactionContext.updateRuleCategoryAwaited (cashflow-mobile#24 — write-first primitive)', () => {
  it('returns false and leaves local state untouched when updateDoc rejects', async () => {
    const err = new Error('Network timeout');
    updateDocMock.mockRejectedValueOnce(err);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    applyDecisionMock.mockResolvedValueOnce({
      decisionId: 'r1',
      changed: { transactionsMatched: 0, monthsAffected: [] },
    });
    const { get } = await mount();
    await act(async () => { await get().addRule(RULE); });
    expect(get().rules[0]).toMatchObject({ id: 'r1', set: { category: 'shopping' } });

    let result: boolean | undefined;
    await act(async () => {
      result = await get().updateRuleCategoryAwaited('r1', 'other');
    });

    // Returns false to signal the failure to the caller (e.g., remove_category
    // needs to retry this row).
    expect(result).toBe(false);
    // State is UNTOUCHED — no optimistic update survives a failed write. The row
    // still shows 'shopping', so a subsequent retry sweep finds it again.
    expect(get().rules[0]).toMatchObject({ id: 'r1', set: { category: 'shopping' } });
    expect(warn).toHaveBeenCalledWith('Mapping rule category update (awaited) failed:', err);

    warn.mockRestore();
  });

  it('returns true and updates local state when updateDoc resolves', async () => {
    updateDocMock.mockResolvedValueOnce(undefined);

    applyDecisionMock.mockResolvedValueOnce({
      decisionId: 'r1',
      changed: { transactionsMatched: 0, monthsAffected: [] },
    });
    const { get } = await mount();
    await act(async () => { await get().addRule(RULE); });
    expect(get().rules[0]).toMatchObject({ id: 'r1', set: { category: 'shopping' } });

    let result: boolean | undefined;
    await act(async () => {
      result = await get().updateRuleCategoryAwaited('r1', 'other');
    });

    // Returns true to signal success.
    expect(result).toBe(true);
    // State reflects the change AFTER Firestore confirmed it.
    expect(get().rules[0]).toMatchObject({ id: 'r1', set: { category: 'other' } });
  });
});

/**
 * cashflow-mobile#24 — updateTransactionAwaited is used by remove_category's
 * sweep to move rows to a new category. It must return false on write failure
 * so the caller knows the row was not moved, and crucially, must NOT update
 * local state on failure so a retry finds the row still at its old category.
 */
describe('TransactionContext.updateTransactionAwaited (cashflow-mobile#24 — write-first primitive)', () => {
  it('returns false and leaves local state untouched when updateTransaction rejects', async () => {
    const err = new Error('Firestore write failed');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    updateTransactionMock.mockRejectedValueOnce(err);

    const { get } = await mount();
    // Add a transaction manually to the raw state.
    await act(async () => {
      await get().addTransaction({
        date: '2026-08-21',
        merchant: 'SHOP',
        amount: 100,
        category: 'shopping' as any,
        paymentMethod: 'credit_card' as any,
        description: 'Test',
        notes: '',
      });
    });

    // Find the transaction we just added.
    const txn = get().transactions.find((t) => t.merchant === 'SHOP');
    expect(txn).toBeDefined();
    expect(txn?.category).toBe('shopping');

    let result: boolean | undefined;
    await act(async () => {
      result = await get().updateTransactionAwaited(txn!.id, { category: 'other' as any });
    });

    // Returns false to signal the failure.
    expect(result).toBe(false);
    // State is UNTOUCHED — the transaction still shows 'shopping'.
    const stillThere = get().transactions.find((t) => t.id === txn!.id);
    expect(stillThere?.category).toBe('shopping');
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('returns true and updates local state when updateTransaction resolves', async () => {
    updateTransactionMock.mockResolvedValueOnce(undefined);

    const { get } = await mount();
    // Add a transaction.
    await act(async () => {
      await get().addTransaction({
        date: '2026-08-21',
        merchant: 'SHOP2',
        amount: 200,
        category: 'shopping' as any,
        paymentMethod: 'credit_card' as any,
        description: 'Test 2',
        notes: '',
      });
    });

    const txn = get().transactions.find((t) => t.merchant === 'SHOP2');
    expect(txn).toBeDefined();
    expect(txn?.category).toBe('shopping');

    let result: boolean | undefined;
    await act(async () => {
      result = await get().updateTransactionAwaited(txn!.id, { category: 'other' as any });
    });

    // Returns true to signal success.
    expect(result).toBe(true);
    // State reflects the change.
    const updated = get().transactions.find((t) => t.id === txn!.id);
    expect(updated?.category).toBe('other');
  });
});
