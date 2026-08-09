/**
 * #71 — anything created offline must still reach Firestore.
 *
 * The old shape: mint a `local_…` id, write to localStorage, and skip Firestore
 * (`if (isFirestoreOnline && !id.startsWith('local_'))`). Nothing ever replayed those
 * rows, so an app offload, a reinstall, or a WebKit storage eviction destroyed real
 * financial data with no error and no indicator. The add helpers made it worse by
 * RETURNING `offline_${Date.now()}` on an offline error — reporting success for a
 * document nobody had written.
 *
 * The fix is structural: mint a real Firestore id client-side, hand the write to the
 * SDK, and let its persistent cache queue it. These pin the three ways that unravels.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { isUnsyncedId, planDrain, withoutId } from '@/lib/offline-queue';

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) ? [p] : [];
  });

const appFiles = walk('src').filter((f) => !f.includes('__tests__'));
const read = (...p: string[]) => readFileSync(join(...p), 'utf8');

describe('no code path invents an unsynced id', () => {
  it('never mints a `local_` or `offline_` id', () => {
    const offenders = appFiles.filter((f) => {
      const src = readFileSync(f, 'utf8');
      // A template literal or string that CONSTRUCTS one of these ids. Matching them
      // for detection (isUnsyncedId, the regex in offline-queue) stays legal.
      return /(['"`])(local|offline)_\$\{/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it('never returns a synthetic id when a write fails', () => {
    const src = read('src', 'lib', 'firestore.ts');
    expect(src).not.toMatch(/return\s+`offline_/);
  });

  it('mints ids through newDocId, which returns a REAL Firestore id', () => {
    const src = read('src', 'lib', 'firestore.ts');
    // doc(collection(...)) generates a valid auto-id locally — no network needed, which
    // is the whole reason the write can be handed over while offline.
    expect(src).toMatch(/export function newDocId[\s\S]{0,400}return doc\(collection\(db, 'users', userId, subcollection\)\)\.id/);
  });
});

describe('writes are handed to the SDK, not skipped', () => {
  it('adds a transaction without branching on connectivity', () => {
    const src = read('src', 'context', 'TransactionContext.tsx');
    const add = src.slice(src.indexOf('const addTransaction'), src.indexOf('const addBulkTransactions'));
    expect(add).toMatch(/newDocId\(user\.id, 'transactions'\)/);
    // The old `if (isFirestoreOnline)` gate is what dropped the row on the floor.
    expect(add).not.toMatch(/if \(isFirestoreOnline\)/);
  });

  it('adds an account and an income source without branching on connectivity', () => {
    const src = read('src', 'context', 'UserProfileContext.tsx');
    const income = src.slice(src.indexOf('const addIncomeSource'), src.indexOf('const updateIncomeSource'));
    expect(income).toMatch(/newDocId\(user\.id, 'income'\)/);
    expect(income).not.toMatch(/if \(isFirestoreOnline\)/);
    expect(src).toMatch(/newDocId\(user\.id, 'accounts'\)/);
  });
});

describe('planDrain rescues what earlier versions stranded', () => {
  const rows = [
    { id: 'local_1', amount: 10 },
    { id: 'offline_2', amount: 20 },
    { id: 'realFirestoreId', amount: 30 },
  ];

  it('persists only the orphans the server does not already have', () => {
    const { toPersist, alreadySynced } = planDrain(rows, new Set(['realFirestoreId']));
    expect(toPersist.map((r) => r.id)).toEqual(['local_1', 'offline_2']);
    expect(alreadySynced.map((r) => r.id)).toEqual(['realFirestoreId']);
  });

  it('treats an orphan the server somehow knows as synced — a duplicate is worse', () => {
    const { toPersist } = planDrain(rows, new Set(['local_1', 'realFirestoreId']));
    expect(toPersist.map((r) => r.id)).toEqual(['offline_2']);
  });

  it('is wired into the sync path, not merely exported', () => {
    // The module existed and compiled for weeks while importing nowhere, which is
    // exactly as useless as not having it.
    expect(read('src', 'context', 'TransactionContext.tsx')).toMatch(/planDrain\(/);
  });

  it('strips the synthetic id and touches nothing else', () => {
    const out = withoutId({ id: 'local_1', amount: 10, title: 'Rent' });
    expect(out).toEqual({ amount: 10, title: 'Rent' });
  });

  it('recognises both id shapes and no others', () => {
    expect(isUnsyncedId('local_abc')).toBe(true);
    expect(isUnsyncedId('offline_abc')).toBe(true);
    expect(isUnsyncedId('imp_2024-01-02%7C40.00')).toBe(false);
    expect(isUnsyncedId('AbCdEf123456')).toBe(false);
  });
});
