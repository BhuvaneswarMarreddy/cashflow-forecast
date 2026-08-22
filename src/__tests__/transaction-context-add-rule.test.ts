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
jest.mock('@/lib/firebase', () => ({
  db: {},
  collection: jest.fn(() => ({ __collection: true })),
  doc: jest.fn((...args: unknown[]) => {
    const last = args[args.length - 1];
    return { id: typeof last === 'string' ? last : `auto-${++autoId}` };
  }),
  getDocs: (...args: unknown[]) => getDocsMock(...args),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
}));

jest.mock('@/lib/firestore', () => ({
  getTransactions: jest.fn().mockResolvedValue([]),
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
