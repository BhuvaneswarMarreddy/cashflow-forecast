/**
 * Issue #144 — the owner must be able to take their data out, not just destroy it.
 *
 * These tests pin the three promises the export makes:
 *   - the manifest's counts are the data actually written (never guessed, never stale)
 *   - a collection read that fails ABORTS the whole export — no partial file that
 *     looks complete (a silently-incomplete backup is worse than none)
 *   - the JSON round-trips a representative fixture of every collection, faithfully
 *     (Firestore Timestamps become ISO strings; nothing else is reshaped or lost)
 */
jest.mock('@/lib/firebase', () => {
  class FakeTimestamp {
    constructor(private iso: string) {}
    toDate() {
      return new Date(this.iso);
    }
  }
  return {
    db: {},
    collection: jest.fn((_db: unknown, ...path: string[]) => path.join('/')),
    doc: jest.fn((_db: unknown, ...path: string[]) => ({ path: path.join('/') })),
    getDoc: jest.fn(),
    getDocs: jest.fn(),
    Timestamp: FakeTimestamp,
  };
});

import { getDoc, getDocs, Timestamp } from '@/lib/firebase';
import { USER_SUBCOLLECTIONS } from '@/lib/firestore';
import {
  buildUserDataExport,
  serializeUserDataExport,
  DATA_EXPORT_SCHEMA_VERSION,
} from '@/lib/data-export';

const fakeDoc = (id: string, data: Record<string, unknown>) => ({ id, data: () => data });

describe('buildUserDataExport', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports a per-collection count that is the data actually written, for every USER_SUBCOLLECTIONS entry', async () => {
    (getDoc as jest.Mock).mockResolvedValue({ exists: () => false, data: () => undefined });
    (getDocs as jest.Mock).mockImplementation(async (path: string) => {
      const name = path.split('/').pop();
      const n = USER_SUBCOLLECTIONS.indexOf(name as (typeof USER_SUBCOLLECTIONS)[number]) + 1;
      return { docs: Array.from({ length: n }, (_, i) => fakeDoc(`${name}-${i}`, { i })) };
    });

    const result = await buildUserDataExport('u1');

    for (const name of USER_SUBCOLLECTIONS) {
      const expected = USER_SUBCOLLECTIONS.indexOf(name) + 1;
      expect(result.collections[name]).toHaveLength(expected);
      expect(result.manifest.collectionCounts[name]).toBe(expected);
    }
  });

  it('aborts instead of returning a partial export when one collection read fails', async () => {
    (getDoc as jest.Mock).mockResolvedValue({ exists: () => false, data: () => undefined });
    let calls = 0;
    (getDocs as jest.Mock).mockImplementation(async (path: string) => {
      calls += 1;
      if (path.endsWith('/links')) throw new Error('offline');
      return { docs: [] };
    });

    await expect(buildUserDataExport('u1')).rejects.toThrow('offline');
    // Must have stopped AT the failing collection, not raced ahead past it.
    expect(calls).toBe(USER_SUBCOLLECTIONS.indexOf('links') + 1);
  });

  it('converts Firestore Timestamps to ISO strings, recursively, in the user doc and in collection docs', async () => {
    const ts = new (Timestamp as unknown as new (iso: string) => { toDate(): Date })(
      '2026-03-01T12:00:00.000Z'
    );
    (getDoc as jest.Mock).mockResolvedValue({
      exists: () => true,
      data: () => ({ createdAt: ts, metadata: { lastLoginAt: ts } }),
    });
    (getDocs as jest.Mock).mockImplementation(async (path: string) => ({
      docs: path.endsWith('/transactions') ? [fakeDoc('t1', { date: ts, amount: 500 })] : [],
    }));

    const result = await buildUserDataExport('u1');

    expect(result.user?.createdAt).toBe('2026-03-01T12:00:00.000Z');
    expect((result.user?.metadata as Record<string, unknown>).lastLoginAt).toBe(
      '2026-03-01T12:00:00.000Z'
    );
    expect(result.collections.transactions[0].date).toBe('2026-03-01T12:00:00.000Z');
  });

  it('names anything excluded (e.g. admin-only Plaid tokens) in the manifest, rather than omitting it silently', async () => {
    (getDoc as jest.Mock).mockResolvedValue({ exists: () => false, data: () => undefined });
    (getDocs as jest.Mock).mockResolvedValue({ docs: [] });

    const result = await buildUserDataExport('u1');

    expect(result.manifest.excluded.length).toBeGreaterThan(0);
    expect(result.manifest.excluded.join(' ')).toMatch(/plaid/i);
    expect(result.manifest.schemaVersion).toBe(DATA_EXPORT_SCHEMA_VERSION);
    expect(result.manifest.userId).toBe('u1');
  });

  it('sorts documents within a collection by id, regardless of Firestore return order', async () => {
    (getDoc as jest.Mock).mockResolvedValue({ exists: () => false, data: () => undefined });
    (getDocs as jest.Mock).mockImplementation(async (path: string) => ({
      docs: path.endsWith('/accounts') ? [fakeDoc('b', { x: 1 }), fakeDoc('a', { x: 2 })] : [],
    }));

    const result = await buildUserDataExport('u1');
    expect(result.collections.accounts.map((d) => d.id)).toEqual(['a', 'b']);
  });
});

describe('serializeUserDataExport', () => {
  beforeEach(() => jest.clearAllMocks());

  it('round-trips a representative fixture of every collection exactly, through JSON', async () => {
    (getDoc as jest.Mock).mockResolvedValue({
      exists: () => true,
      data: () => ({ email: 'owner@example.com', settings: { currency: 'USD' } }),
    });
    (getDocs as jest.Mock).mockImplementation(async (path: string) => {
      const name = path.split('/').pop();
      return { docs: [fakeDoc(`${name}-1`, { note: `fixture for ${name}`, amount: 12.5, active: true })] };
    });

    const built = await buildUserDataExport('u1');
    const parsed = JSON.parse(serializeUserDataExport(built));

    expect(parsed).toEqual(built);
    for (const name of USER_SUBCOLLECTIONS) {
      expect(parsed.collections[name]).toHaveLength(1);
      expect(parsed.collections[name][0].note).toBe(`fixture for ${name}`);
    }
  });

  it('is deterministic — the same export data serializes to the identical string twice', async () => {
    (getDoc as jest.Mock).mockResolvedValue({ exists: () => false, data: () => undefined });
    (getDocs as jest.Mock).mockResolvedValue({
      docs: [fakeDoc('b', { z: 1, a: 2 }), fakeDoc('a', { b: 1 })],
    });

    const built = await buildUserDataExport('u1');
    expect(serializeUserDataExport(built)).toBe(serializeUserDataExport(built));
  });
});
