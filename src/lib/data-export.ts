/**
 * Issue #144 — a full export of the owner's data: facts AND the decision layer.
 *
 * `deleteAllUserData` (firestore.ts) can destroy every users/{uid} subcollection; this
 * is its mirror, reading the SAME `USER_SUBCOLLECTIONS` list so the two can never drift
 * apart — a collection the wipe reaches is a collection this export reaches too.
 *
 * FAILS LOUDLY: no try/catch here swallows a read error. A collection that fails to
 * load throws straight out of `buildUserDataExport`, so the caller either gets the
 * whole thing or nothing — never a manifest that claims completeness over a file that
 * silently dropped a collection.
 *
 * NOT included, on purpose: `meta/plaid` (Plaid access tokens + sync cursors) is an
 * admin-only, non-user-scoped document — it is a credential, not the owner's data, and
 * must never leave this app. Named in `DATA_EXPORT_EXCLUDED` so the manifest says so
 * rather than the omission being silent.
 */
import { collection, db, doc, getDoc, getDocs, Timestamp } from './firebase';
import { USER_SUBCOLLECTIONS } from './firestore';

export const DATA_EXPORT_SCHEMA_VERSION = 1;

export const DATA_EXPORT_EXCLUDED = [
  'meta/plaid (Plaid access tokens and sync cursors) — admin-only credentials, not scoped to a single user, never exported',
] as const;

export interface DataExportManifest {
  schemaVersion: number;
  /** ISO-8601, when this export was built. */
  exportedAt: string;
  userId: string;
  /** One entry per `USER_SUBCOLLECTIONS` name, equal to `collections[name].length`. */
  collectionCounts: Record<string, number>;
  /** Anything intentionally not in this file, and why. Never a silent omission. */
  excluded: readonly string[];
}

export interface UserDataExport {
  manifest: DataExportManifest;
  /** The users/{uid} doc itself — profile fields and settings. `null` if it doesn't exist. */
  user: Record<string, unknown> | null;
  /** Keyed by `USER_SUBCOLLECTIONS` name; each doc carries its Firestore id as `id`. */
  collections: Record<string, Record<string, unknown>[]>;
}

/** Firestore Timestamps aren't valid JSON — convert to ISO strings, recursively, anywhere
 *  in the document. Everything already stored as a plain string/number passes through
 *  untouched ("ISO dates as stored", not reformatted). */
function toPlain(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(toPlain);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toPlain(v)])
    );
  }
  return value;
}

/** Alphabetical key order, recursively — so two exports of the same data are byte-
 *  identical, and a diff between backups shows only what actually changed. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeysDeep(obj[k]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Reads the user doc and every `USER_SUBCOLLECTIONS` collection, sequentially. A thrown
 * read error propagates straight out — there is no partial value to accidentally return,
 * because nothing is assembled until every read has already succeeded.
 */
export async function buildUserDataExport(userId: string): Promise<UserDataExport> {
  const userSnap = await getDoc(doc(db, 'users', userId));
  const user = userSnap.exists()
    ? (sortKeysDeep(toPlain(userSnap.data())) as Record<string, unknown>)
    : null;

  const collections: Record<string, Record<string, unknown>[]> = {};
  const collectionCounts: Record<string, number> = {};

  for (const name of USER_SUBCOLLECTIONS) {
    const snapshot = await getDocs(collection(db, 'users', userId, name));
    const docs = snapshot.docs
      .map((d) => sortKeysDeep({ id: d.id, ...(toPlain(d.data()) as Record<string, unknown>) }) as Record<string, unknown>)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    collections[name] = docs;
    collectionCounts[name] = docs.length;
  }

  return {
    manifest: {
      schemaVersion: DATA_EXPORT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      userId,
      collectionCounts,
      excluded: DATA_EXPORT_EXCLUDED,
    },
    user,
    collections,
  };
}

/** Pretty-printed JSON. Key order is already deterministic (`sortKeysDeep` above), so
 *  this is a plain stringify, not a second sorting pass. */
export function serializeUserDataExport(data: UserDataExport): string {
  return JSON.stringify(data, null, 2);
}
