/**
 * The observation must be written BEFORE the anchor moves. Afterwards derived and
 * entered agree by construction and there is nothing left to record (INV-1).
 */
import { reconcile } from '@/lib/accounts';
import { PaymentAccount } from '@/types';

const acc = { id: 'a', name: 'Chase', type: 'bank_account', provider: 'chase', color: '#000', isActive: true, openingBalance: 100, openingDate: '2026-01-01' } as PaymentAccount;

describe('reconcile ordering', () => {
  it('reports the pre-re-anchor drift alongside the re-anchor', () => {
    const { observation, reanchor } = reconcile(acc, 9235, 8770, '2026-08-08',
      { includePending: false, source: 'user' });
    expect(observation.driftCents).toBe(46500);
    expect(reanchor?.openingBalance).toBe(9235);
    // The observation describes the world BEFORE reanchor is applied.
    expect(observation.derivedCents).toBe(877000);
  });
});

// --- What actually changes in THIS task: wiring, not the pure function above. ---
//
// The pure `reconcile()` math was already correct after Task 3; the test above cannot
// fail from Task 5's own change and would pass even if `reconcileAccount` never called
// `recordAudit` at all. This suite renders the real UserProfileProvider (only Firestore
// and Auth are mocked) and drives `reconcileAccount` through it, so a regression that
// drops the audit call — or reorders it after the reanchor write — turns it red.
import React from 'react';
import { render, act, waitFor } from '@testing-library/react';
import { UserProfileProvider, useUserProfile, UserProfileContextType } from '@/context/UserProfileContext';

const TEST_USER = { id: 'u1', email: 'a@b.com', name: 'A', createdAt: '2026-01-01T00:00:00.000Z' };

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: TEST_USER, isAuthenticated: true, isLoading: false }),
}));

jest.mock('@/lib/firestore', () => ({
  getUserProfile: jest.fn(),
  getAccounts: jest.fn(),
  getIncomeSources: jest.fn().mockResolvedValue([]),
  getInflowReviews: jest.fn().mockResolvedValue({}),
  updateAccount: jest.fn().mockResolvedValue(undefined),
  updateLastLogin: jest.fn().mockResolvedValue(undefined),
  createUserProfile: jest.fn().mockResolvedValue(undefined),
  newDocId: jest.fn(() => 'acc1'),
}));

jest.mock('@/lib/audit', () => {
  const actual = jest.requireActual('@/lib/audit');
  // auditEntry stays real (it stamps `at` and shapes the record); only the Firestore
  // write is replaced so the test does not need a live audit collection.
  return { ...actual, recordAudit: jest.fn().mockResolvedValue(undefined) };
});

const firestoreMock = jest.requireMock('@/lib/firestore');
const { recordAudit } = jest.requireMock('@/lib/audit') as { recordAudit: jest.Mock };

/** Firestore's addDoc rejects a literal `undefined` at ANY depth, not just the top
 *  level — stripUndefined() in src/lib/audit.ts only strips the entry's own keys, so
 *  an undefined nested inside `after` (e.g. a DriftObservation's providerCheckedAt)
 *  reaches addDoc unstripped and throws. */
function assertNoUndefinedDeep(value: unknown, path: string): void {
  if (value === undefined) throw new Error(`${path} is undefined`);
  if (value === null || typeof value !== 'object') return;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    assertNoUndefinedDeep(v, `${path}.${key}`);
  }
}

const SEED_ACCOUNT = {
  id: 'acc1', name: 'Chase', type: 'bank_account', provider: 'chase',
  color: '#000', isActive: true, openingBalance: 100, openingDate: '2026-01-01',
};

function Harness({ onReady }: { onReady: (ctx: UserProfileContextType) => void }) {
  const ctx = useUserProfile();
  onReady(ctx);
  return null;
}

describe('reconcileAccount persists the drift observation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // A resolved profile doc with the account already attached, so the provider
    // settles into a known state without racing addPaymentAccount's own write.
    firestoreMock.getUserProfile.mockResolvedValue({
      uid: TEST_USER.id, email: TEST_USER.email, displayName: TEST_USER.name,
      createdAt: { toDate: () => new Date('2026-01-01') },
      metadata: { isOnboarded: true },
      settings: { includePendingInCalculations: true },
    });
    firestoreMock.getAccounts.mockResolvedValue([SEED_ACCOUNT]);
  });

  it('records account.reconcile with the observation before the reanchor write', async () => {
    let ctx: UserProfileContextType | undefined;
    render(
      React.createElement(UserProfileProvider, null,
        React.createElement(Harness, { onReady: (c) => { ctx = c; } }))
    );

    await waitFor(() => expect(ctx?.profile?.paymentAccounts.length).toBe(1));

    let driftCents = 0;
    await act(async () => {
      driftCents = await ctx!.reconcileAccount('acc1', 9235, 8770);
    });

    expect(driftCents).toBe(46500);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith('u1', expect.objectContaining({
      action: 'account.reconcile',
      target: 'accounts/acc1',
      after: expect.objectContaining({ driftCents: 46500, derivedCents: 877000, includePending: true }),
    }));

    // recordAudit is mocked above (jest.mock('@/lib/audit')), so the real
    // stripUndefined()/addDoc() never run in this suite and a literal `undefined`
    // anywhere in `after` would sail through unnoticed — exactly why the production
    // bug (ctx.providerCheckedAt undefined -> addDoc throws -> recordAudit's own
    // catch swallows it -> every drift observation silently dropped) had no test
    // catching it. Walk the real payload recordAudit was called with instead of
    // trusting the shape.
    const [, entry] = recordAudit.mock.calls[0];
    assertNoUndefinedDeep(entry.after, 'after');

    // Order is the whole point of this task: the audit write must be observed to
    // happen before the account update that moves openingBalance/openingDate,
    // because once that update lands the drift is gone by construction.
    const auditOrder = recordAudit.mock.invocationCallOrder[0];
    const reanchorOrder = firestoreMock.updateAccount.mock.invocationCallOrder[0];
    expect(auditOrder).toBeLessThan(reanchorOrder);
  });

  it('records audit on zero drift without re-anchoring', async () => {
    let ctx: UserProfileContextType | undefined;
    render(
      React.createElement(UserProfileProvider, null,
        React.createElement(Harness, { onReady: (c) => { ctx = c; } }))
    );

    await waitFor(() => expect(ctx?.profile?.paymentAccounts.length).toBe(1));

    await act(async () => {
      await ctx!.reconcileAccount('acc1', 100, 100);
    });

    // Zero drift still calls recordAudit (a clean check is evidence too, per
    // reconcile()'s contract) but never calls updateAccount, since there is no
    // reanchor to apply.
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(firestoreMock.updateAccount).not.toHaveBeenCalled();
  });
});
