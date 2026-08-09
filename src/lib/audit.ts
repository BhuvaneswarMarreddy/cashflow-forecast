/**
 * The write-side of explainability (AUD-1, issue #114).
 *
 * `src/lib/obs/provenance.ts` is the READ side: how a number was computed from the
 * inputs it has right now. It is recomputed per render and remembers nothing. This
 * module is its counterpart — a durable record of what CHANGED. Provenance can say
 * why today's balance is $9,200; only this can say that 451 decisions were deleted
 * on 2026-08-06, and by what.
 *
 * THREE RULES
 *  1. `interpret()` never reads this. It answers forensic and explain questions
 *     only, which is why entries may be wide and the collection may be slow.
 *  2. Entries are immutable once written — `firestore.rules` denies update. Delete
 *     is allowed, because account deletion is a privacy promise and the owner's data
 *     is the owner's to erase. You cannot falsify this log, only erase it wholesale.
 *  3. **Recording must never fail the write it observes.** Losing a confirmation
 *     because its log entry failed is strictly worse than losing the log entry.
 *
 * Only `after` is recorded, never `before`: the previous entry for the same target
 * IS the before, so reading the current doc first would double the cost of every
 * write to reconstruct something the log already holds.
 */
import { db, collection, addDoc } from '@/lib/firebase';

/** Who caused the change. `user` is a person clicking; the rest are machinery. */
export type AuditActor = 'user' | 'sync' | 'import' | 'batch' | 'restore';

export interface AuditEntry {
  at: string; // ISO
  actor: AuditActor;
  /** Dotted, past-tense-free: `review.set`, `review.delete`, `transactions.import`. */
  action: string;
  /** `collection/docId` — the thing that changed, addressable. */
  target: string;
  /** The state written. Absent for deletes: the action and target are the record. */
  after?: unknown;
  /** Ties an entry to the run that produced it — `reanalysis-2026-08-04` and friends. */
  batchId?: string;
}

/**
 * Append one entry. Never throws: a failure here is logged and swallowed so the
 * primary write still counts. See rule 3 above.
 */
export async function recordAudit(userId: string, entry: AuditEntry): Promise<void> {
  try {
    await addDoc(collection(db, 'users', userId, 'audit'), stripUndefined(entry));
  } catch (error) {
    // ponytail: console only. Route to the obs pipeline if a dropped entry ever
    // needs to be detectable rather than merely absent.
    console.warn('audit entry not recorded:', entry.action, entry.target, error);
  }
}

/** Firestore rejects `undefined`; optional fields are simply absent instead. */
function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** `at` is stamped here so no caller can backdate an entry. */
export function auditEntry(
  action: string,
  target: string,
  opts: { actor?: AuditActor; after?: unknown; batchId?: string } = {}
): AuditEntry {
  return {
    at: new Date().toISOString(),
    actor: opts.actor ?? 'user',
    action,
    target,
    after: opts.after,
    batchId: opts.batchId,
  };
}
