/**
 * Profile settings validation — sanitizeAssumedSpend (FIN-SPEND-001).
 * The guard must reject 0, negative, NaN, Infinity, and non-numeric types,
 * returning only positive finite numbers or null. This matches the snapshot.ts
 * server-side enforcement so web and mobile never diverge on the same input.
 */
import { sanitizeAssumedSpend } from '@/lib/profile-settings';

describe('sanitizeAssumedSpend', () => {
  it('returns positive finite numbers unchanged', () => {
    expect(sanitizeAssumedSpend(100)).toBe(100);
    expect(sanitizeAssumedSpend(0.01)).toBe(0.01);
    expect(sanitizeAssumedSpend(9999.99)).toBe(9999.99);
  });

  it('rejects zero', () => {
    expect(sanitizeAssumedSpend(0)).toBe(null);
  });

  it('rejects negative numbers', () => {
    expect(sanitizeAssumedSpend(-100)).toBe(null);
    expect(sanitizeAssumedSpend(-0.01)).toBe(null);
  });

  it('rejects NaN', () => {
    expect(sanitizeAssumedSpend(NaN)).toBe(null);
  });

  it('rejects Infinity', () => {
    expect(sanitizeAssumedSpend(Infinity)).toBe(null);
    expect(sanitizeAssumedSpend(-Infinity)).toBe(null);
  });

  it('rejects strings', () => {
    expect(sanitizeAssumedSpend('100')).toBe(null);
    expect(sanitizeAssumedSpend('abc')).toBe(null);
  });

  it('rejects null and undefined', () => {
    expect(sanitizeAssumedSpend(null)).toBe(null);
    expect(sanitizeAssumedSpend(undefined)).toBe(null);
  });

  it('rejects other types', () => {
    expect(sanitizeAssumedSpend({})).toBe(null);
    expect(sanitizeAssumedSpend([])).toBe(null);
    expect(sanitizeAssumedSpend(true)).toBe(null);
  });
});
