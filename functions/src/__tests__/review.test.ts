jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(),
  Timestamp: { now: jest.fn(() => 'TS') },
}));

import { getFirestore } from 'firebase-admin/firestore';

import { resolveReview } from '../review';

// FIX 3: both guards are hand validation at the trust boundary — request.data
// is attacker-controlled JSON, not the typed shape the destructure pretends.
describe('resolveReview — trust-boundary guards', () => {
  it('rejects a transactionId containing "/" without touching Firestore, same guard decisions.ts applies to decisionId', async () => {
    const fakeDb = { collection: jest.fn() };
    (getFirestore as jest.Mock).mockReturnValue(fakeDb);

    await expect(
      resolveReview.run({
        auth: { uid: 'u1' },
        data: { transactionId: 'transactions/evil', decision: 'dismiss' },
      } as never),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(fakeDb.collection).not.toHaveBeenCalled();
  });

  it('rejects a non-string explanation without touching Firestore', async () => {
    const fakeDb = { collection: jest.fn() };
    (getFirestore as jest.Mock).mockReturnValue(fakeDb);

    await expect(
      resolveReview.run({
        auth: { uid: 'u1' },
        data: { transactionId: 't1', decision: 'dismiss', explanation: { not: 'a string' } },
      } as never),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(fakeDb.collection).not.toHaveBeenCalled();
  });

  it('a well-formed transactionId and string explanation still reach Firestore, sliced to 500 chars, unchanged behaviour', async () => {
    const writes: unknown[] = [];
    const audits: unknown[] = [];
    const fakeDb = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          collection: jest.fn((name: string) => {
            if (name === 'transactions') {
              return {
                doc: jest.fn(() => ({
                  get: jest.fn(async () => ({ exists: true, data: () => ({ fingerprint: 'fp1' }) })),
                })),
              };
            }
            if (name === 'reviews') {
              return {
                doc: jest.fn(() => ({
                  set: jest.fn(async (val: unknown) => {
                    writes.push(val);
                  }),
                })),
              };
            }
            return { add: jest.fn(async (entry: unknown) => audits.push(entry)) };
          }),
        })),
      })),
    };
    (getFirestore as jest.Mock).mockReturnValue(fakeDb);

    const longExplanation = 'x'.repeat(600);
    const result = await resolveReview.run({
      auth: { uid: 'u1' },
      data: { transactionId: 't1', decision: 'dismiss', explanation: longExplanation },
    } as never);

    expect(result).toEqual({ transactionId: 't1', state: 'dismissed' });
    expect((writes[0] as { explanation: string }).explanation).toHaveLength(500);
    expect(audits).toHaveLength(1);
  });
});
