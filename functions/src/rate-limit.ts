/**
 * Fixed-window per-uid daily rate limiter backed by Firestore.
 *
 * Doc shape at rateLimits/{uid}: { day: 'YYYY-MM-DD', counts: { [fn]: n } }
 * ponytail: fixed daily window (UTC), resets at midnight UTC; move to sliding
 * window only if burst abuse at the boundary ever matters.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

export const LIMITS = {
  aiDecision: 50,
  parseReceipt: 60,
  aiChat: 100,
} as const;

export interface RateLimitDoc {
  day: string;
  counts: Record<string, number>;
}

/** UTC day key, YYYY-MM-DD. */
export function todayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Pure window math: given the stored doc (or undefined), return the next doc
 * to write, or null when the call would exceed the limit.
 */
export function nextWindowState(
  existing: RateLimitDoc | undefined,
  fn: string,
  limit: number,
  day: string
): RateLimitDoc | null {
  const doc: RateLimitDoc =
    existing && existing.day === day ? existing : { day, counts: {} };
  const count = doc.counts[fn] || 0;
  if (count >= limit) return null;
  return { day, counts: { ...doc.counts, [fn]: count + 1 } };
}

/**
 * Consume one call for uid/fn inside a Firestore transaction.
 * Throws HttpsError('resource-exhausted') when the daily limit is reached.
 */
export async function checkRateLimit(
  uid: string,
  fn: keyof typeof LIMITS,
  limit: number = LIMITS[fn]
): Promise<void> {
  const db = getFirestore();
  const ref = db.collection('rateLimits').doc(uid);
  const day = todayKey();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const next = nextWindowState(
      snap.data() as RateLimitDoc | undefined,
      fn,
      limit,
      day
    );
    if (!next) {
      throw new HttpsError(
        'resource-exhausted',
        `Daily limit of ${limit} requests reached for ${fn}. Try again tomorrow.`
      );
    }
    tx.set(ref, next);
  });
}
