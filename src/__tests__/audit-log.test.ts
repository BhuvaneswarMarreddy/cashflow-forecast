/**
 * The audit log's three promises (AUD-1, issue #114):
 *   - a decision write leaves exactly one addressable entry
 *   - a deletion is recorded even though there is no `after` to record
 *   - a failing audit write NEVER fails the write it observes
 *
 * The third is the one worth a test. Losing a confirmation because its log entry
 * failed is strictly worse than losing the log entry, and that inversion is easy to
 * reintroduce by "improving" recordAudit to rethrow.
 */
import type { InflowReview } from '@/types';

jest.mock('@/lib/firebase', () => ({
  db: {},
  collection: jest.fn((_db: unknown, ...path: string[]) => path.join('/')),
  doc: jest.fn((_db: unknown, ...path: string[]) => ({ path: path.join('/') })),
  getDoc: jest.fn(),
  getDocs: jest.fn(),
  setDoc: jest.fn(async () => undefined),
  updateDoc: jest.fn(async () => undefined),
  deleteDoc: jest.fn(async () => undefined),
  addDoc: jest.fn(async () => ({ id: 'a1' })),
  writeBatch: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  serverTimestamp: jest.fn(),
  Timestamp: {},
  enableNetwork: jest.fn(),
  disableNetwork: jest.fn(),
}));

import { addDoc, setDoc } from '@/lib/firebase';
import { setInflowReview, deleteInflowReview, USER_SUBCOLLECTIONS } from '@/lib/firestore';

const review: InflowReview = {
  transactionId: 'imp_2024-11-29|2399.24|remitly|0',
  state: 'confirmed',
  meaning: 'personal_expense',
  source: 'user',
  updatedAt: '2026-08-08T00:00:00.000Z',
};

const lastEntry = () => (addDoc as jest.Mock).mock.calls.at(-1)?.[1];
const lastPath = () => (addDoc as jest.Mock).mock.calls.at(-1)?.[0];

beforeEach(() => jest.clearAllMocks());

describe('audit log', () => {
  it('records one addressable entry when a decision is written', async () => {
    await setInflowReview('u1', review);

    expect(addDoc).toHaveBeenCalledTimes(1);
    expect(lastPath()).toBe('users/u1/audit');
    expect(lastEntry()).toMatchObject({
      actor: 'user',
      action: 'review.set',
      target: `reviews/${review.transactionId}`,
    });
    expect(typeof lastEntry().at).toBe('string');
    expect(lastEntry().after).toMatchObject({ meaning: 'personal_expense', state: 'confirmed' });
  });

  it('carries the actor and batchId of a machine-driven write', async () => {
    await setInflowReview('u1', review, { actor: 'restore', batchId: 'restore-reviews-2026-08-08' });

    expect(lastEntry()).toMatchObject({
      actor: 'restore',
      batchId: 'restore-reviews-2026-08-08',
    });
  });

  it('records a deletion, with no `after` to record', async () => {
    await deleteInflowReview('u1', review.transactionId);

    expect(lastEntry()).toMatchObject({
      action: 'review.delete',
      target: `reviews/${review.transactionId}`,
    });
    // Firestore rejects undefined; the field must be absent, not present-and-undefined.
    expect(Object.keys(lastEntry())).not.toContain('after');
  });

  it('does NOT fail the decision when the audit write fails', async () => {
    (addDoc as jest.Mock).mockRejectedValueOnce(new Error('audit collection unavailable'));

    await expect(setInflowReview('u1', review)).resolves.toBeUndefined();
    expect(setDoc).toHaveBeenCalledTimes(1); // the decision still landed
  });

  it('is covered by the account-deletion sweep', () => {
    // Privacy beats forensics on the owner's own data: "everything is gone" includes
    // this. The integrity guarantee is `allow update: if false` in firestore.rules,
    // not survival of a delete.
    expect(USER_SUBCOLLECTIONS).toContain('audit');
  });
});
