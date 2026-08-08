/**
 * #71 — rows that were created offline and never reached Firestore.
 *
 * The app used to mint `local_…` / `offline_…` ids for anything written while
 * `isFirestoreOnline` was false, and every write path then skipped Firestore for
 * exactly those ids. Nothing ever replayed them. A row created offline lived
 * only in a localStorage JSON blob, so an app offload, a reinstall, or a WebKit
 * storage eviction destroyed real financial data with no error and no indicator.
 *
 * The queue is gone: writes now carry a client-minted Firestore id and are fired
 * without awaiting, so the SDK's own persistent cache durably queues and replays
 * them. What remains is this module — the predicate for spotting the orphans
 * that earlier versions already created, and the plan for draining them.
 *
 * Draining matters as much as the fix. Shipping the new write path alone would
 * stop making orphans while permanently abandoning the ones the bug produced,
 * which is the data the user is most likely to miss.
 */

/** The id shapes previous versions used for a row that never reached Firestore. */
const UNSYNCED_ID = /^(local|offline)_/;

export function isUnsyncedId(id: string): boolean {
  return UNSYNCED_ID.test(id);
}

export interface DrainPlan<T extends { id: string }> {
  /** Rows that were never persisted and should now be written under a real id. */
  toPersist: T[];
  /** Rows Firestore already knows about; left exactly as they are. */
  alreadySynced: T[];
}

/**
 * Splits locally-mirrored rows into those still owed a write and those the
 * server already has.
 *
 * `serverIds` is the authoritative set from Firestore. An orphan whose id
 * somehow appears there is treated as synced — re-persisting it would duplicate
 * the row, and a duplicate transaction is worse than a stale id.
 */
export function planDrain<T extends { id: string }>(
  localRows: readonly T[],
  serverIds: ReadonlySet<string>
): DrainPlan<T> {
  const toPersist: T[] = [];
  const alreadySynced: T[] = [];
  for (const row of localRows) {
    if (isUnsyncedId(row.id) && !serverIds.has(row.id)) toPersist.push(row);
    else alreadySynced.push(row);
  }
  return { toPersist, alreadySynced };
}

/**
 * Strips the synthetic id so the row can be written under a real one.
 *
 * Deliberately returns the rest of the row untouched: whatever the user entered
 * offline is the thing being rescued, and re-deriving any of it here would be a
 * second chance to lose it.
 */
export function withoutId<T extends { id: string }>(row: T): Omit<T, 'id'> {
  const { id: _id, ...rest } = row;
  return rest;
}
