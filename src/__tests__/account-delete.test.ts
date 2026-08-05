/**
 * Account deletion is a privacy promise: "everything is gone". These tests pin the
 * two ways that promise can silently rot — a subcollection the wipe list forgot,
 * and the 500-writes-per-batch ceiling a big ledger would trip over.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

jest.mock('@/lib/firebase', () => ({
  db: {},
  collection: jest.fn((_db: unknown, ...path: string[]) => path.join('/')),
  doc: jest.fn((_db: unknown, ...path: string[]) => ({ path: path.join('/') })),
  getDocs: jest.fn(),
  deleteDoc: jest.fn(async () => undefined),
  writeBatch: jest.fn(),
}));

import { DELETE_CHUNK, USER_SUBCOLLECTIONS, deleteAllUserData } from '@/lib/firestore';
import { getDocs, writeBatch, deleteDoc } from '@/lib/firebase';

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) ? [p] : [];
  });

describe('USER_SUBCOLLECTIONS', () => {
  it('covers every users/{uid} subcollection the source code touches', () => {
    const found = new Set<string>();
    for (const file of walk('src')) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/'users',\s*[A-Za-z_.]+,\s*'([A-Za-z]+)'/g)) found.add(m[1]);
      for (const m of src.matchAll(/users\/\$\{[^}]+\}\/([A-Za-z]+)/g)) found.add(m[1]);
    }
    expect(found.size).toBeGreaterThanOrEqual(9); // the scan itself must keep finding things
    const missing = [...found].filter((c) => !(USER_SUBCOLLECTIONS as readonly string[]).includes(c));
    expect(missing).toEqual([]); // a new subcollection must be added to the wipe list
  });

  it('chunk size respects the Firestore 500-writes ceiling', () => {
    expect(DELETE_CHUNK).toBeLessThanOrEqual(500);
  });
});

describe('deleteAllUserData', () => {
  it('deletes a big collection in chunks and the user doc last', async () => {
    const commits: number[] = [];
    let pending = 0;
    (writeBatch as jest.Mock).mockImplementation(() => ({
      delete: () => { pending += 1; },
      commit: async () => { commits.push(pending); pending = 0; },
    }));
    (getDocs as jest.Mock).mockImplementation(async (path: string) => ({
      docs: path.endsWith('/transactions')
        ? Array.from({ length: 1000 }, (_, i) => ({ ref: i }))
        : [],
    }));

    await deleteAllUserData('u1');

    expect(commits).toEqual([450, 450, 100]); // 1000 docs, no batch over the ceiling
    expect((getDocs as jest.Mock).mock.calls).toHaveLength(USER_SUBCOLLECTIONS.length);
    expect((deleteDoc as jest.Mock).mock.calls).toHaveLength(1); // the users/{uid} doc itself
  });
});
