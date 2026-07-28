import { nextWindowState, todayKey, checkRateLimit, LIMITS, RateLimitDoc } from '../rate-limit';
import { HttpsError } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(),
}));

describe('todayKey', () => {
  it('formats as YYYY-MM-DD UTC', () => {
    expect(todayKey(new Date('2026-07-28T23:59:59Z'))).toBe('2026-07-28');
    expect(todayKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01');
  });
});

describe('nextWindowState (pure window math)', () => {
  const DAY = '2026-07-28';

  it('starts a fresh window when no doc exists', () => {
    expect(nextWindowState(undefined, 'aiDecision', 50, DAY)).toEqual({
      day: DAY,
      counts: { aiDecision: 1 },
    });
  });

  it('increments within the same day', () => {
    const doc: RateLimitDoc = { day: DAY, counts: { aiDecision: 7 } };
    expect(nextWindowState(doc, 'aiDecision', 50, DAY)).toEqual({
      day: DAY,
      counts: { aiDecision: 8 },
    });
  });

  it('resets the window on a new day', () => {
    const doc: RateLimitDoc = { day: '2026-07-27', counts: { aiDecision: 50 } };
    expect(nextWindowState(doc, 'aiDecision', 50, DAY)).toEqual({
      day: DAY,
      counts: { aiDecision: 1 },
    });
  });

  it('allows the call that reaches exactly the limit', () => {
    const doc: RateLimitDoc = { day: DAY, counts: { aiDecision: 49 } };
    expect(nextWindowState(doc, 'aiDecision', 50, DAY)).toEqual({
      day: DAY,
      counts: { aiDecision: 50 },
    });
  });

  it('returns null once the limit is reached', () => {
    const doc: RateLimitDoc = { day: DAY, counts: { aiDecision: 50 } };
    expect(nextWindowState(doc, 'aiDecision', 50, DAY)).toBeNull();
  });

  it('tracks functions independently and preserves sibling counts', () => {
    const doc: RateLimitDoc = { day: DAY, counts: { aiDecision: 50 } };
    expect(nextWindowState(doc, 'parseReceipt', 60, DAY)).toEqual({
      day: DAY,
      counts: { aiDecision: 50, parseReceipt: 1 },
    });
  });
});

describe('checkRateLimit (mocked transaction)', () => {
  let stored: RateLimitDoc | undefined;

  beforeEach(() => {
    stored = undefined;
    const fakeDb = {
      collection: jest.fn(() => ({ doc: jest.fn(() => ({ path: 'rateLimits/u1' })) })),
      runTransaction: jest.fn(async (cb: (tx: unknown) => Promise<void>) => {
        const tx = {
          get: jest.fn(async () => ({ data: () => stored })),
          set: jest.fn((_ref: unknown, val: RateLimitDoc) => {
            stored = val;
          }),
        };
        await cb(tx);
      }),
    };
    (getFirestore as jest.Mock).mockReturnValue(fakeDb);
  });

  it('increments the count on each call', async () => {
    await checkRateLimit('u1', 'aiDecision');
    await checkRateLimit('u1', 'aiDecision');
    expect(stored).toEqual({ day: todayKey(), counts: { aiDecision: 2 } });
  });

  it('throws resource-exhausted when over the limit', async () => {
    stored = { day: todayKey(), counts: { aiDecision: LIMITS.aiDecision } };
    await expect(checkRateLimit('u1', 'aiDecision')).rejects.toThrow(HttpsError);
    await expect(checkRateLimit('u1', 'aiDecision')).rejects.toMatchObject({
      code: 'resource-exhausted',
    });
    // Count untouched by rejected calls
    expect(stored.counts.aiDecision).toBe(LIMITS.aiDecision);
  });

  it('uses the configured default limits', () => {
    expect(LIMITS.aiDecision).toBe(50);
    expect(LIMITS.parseReceipt).toBe(60);
  });
});
