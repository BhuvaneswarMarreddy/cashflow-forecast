/**
 * Dual-source ingest matching (src/lib/fingerprint.ts).
 * The expensive failure is a wrong merge: it deletes a real expense silently.
 */

import { fingerprintOf, fingerprintOfRow, findTwin, mergeFields } from '@/lib/fingerprint';
import { Transaction } from '@/types';

// Local midnight, matching what the CSV importer stores.
const at = (day: string) => new Date(`${day}T00:00:00`).toISOString();

const tx = (over: Partial<Transaction> = {}): Transaction => ({
  id: 'existing-1',
  title: 'AMZN Mktp US*2H4KJ',
  amount: 50,
  type: 'expense',
  category: 'other',
  paymentMethod: 'chase',
  accountId: 'acc-1',
  date: at('2026-08-01'),
  ...over,
});

describe('fingerprintOf', () => {
  it('signs the cents by direction and keys on the calendar day', () => {
    expect(fingerprintOf('acc-1', 50, 'expense', at('2026-08-01'))).toBe('acc-1|-5000|2026-08-01');
    expect(fingerprintOf('acc-1', 50, 'income', at('2026-08-01'))).toBe('acc-1|5000|2026-08-01');
    expect(fingerprintOf('acc-1', 50, 'transfer-in', at('2026-08-01'))).toBe('acc-1|5000|2026-08-01');
    expect(fingerprintOf('acc-1', 50, 'transfer-out', at('2026-08-01'))).toBe('acc-1|-5000|2026-08-01');
    expect(fingerprintOf(undefined, 12.34, 'expense', '2026-08-01')).toBe('none|-1234|2026-08-01');
  });

  it('reads the leg direction off the row', () => {
    expect(fingerprintOfRow(tx({ type: 'transfer', transferDirection: 'in' })))
      .toBe('acc-1|5000|2026-08-01');
  });
});

describe('findTwin', () => {
  it('matches the same charge on the same day', () => {
    const existing = [tx()];
    expect(findTwin({ accountId: 'acc-1', amount: 50, type: 'expense', date: at('2026-08-01') }, existing)?.id)
      .toBe('existing-1');
  });

  it('matches across the ±3 day posting window and picks the nearest date', () => {
    const existing = [tx({ id: 'far', date: at('2026-07-29') }), tx({ id: 'near', date: at('2026-07-31') })];
    expect(findTwin({ accountId: 'acc-1', amount: 50, type: 'expense', date: at('2026-08-01') }, existing)?.id)
      .toBe('near');
    expect(findTwin({ accountId: 'acc-1', amount: 50, type: 'expense', date: at('2026-07-26') }, existing)?.id)
      .toBe('far'); // three days on the other side
  });

  it('does not match 4 days out', () => {
    const existing = [tx({ date: at('2026-07-28') })];
    expect(findTwin({ accountId: 'acc-1', amount: 50, type: 'expense', date: at('2026-08-01') }, existing))
      .toBeNull();
  });

  it('never matches across the sign — a $50 refund is not a $50 charge', () => {
    const existing = [tx({ type: 'expense' })];
    expect(findTwin({ accountId: 'acc-1', amount: 50, type: 'income', date: at('2026-08-01') }, existing))
      .toBeNull();
  });

  it('does not match a different account', () => {
    const existing = [tx({ accountId: 'acc-2' })];
    expect(findTwin({ accountId: 'acc-1', amount: 50, type: 'expense', date: at('2026-08-01') }, existing))
      .toBeNull();
  });

  it('claims one-to-one: two identical $5.00 same-day charges stay two rows', () => {
    // The spec's named risk. If one stored row absorbed both, a real expense would
    // disappear and spending would be understated.
    const existing = [tx({ id: 'a', amount: 5 }), tx({ id: 'b', amount: 5 })];
    const incoming = [
      { accountId: 'acc-1', amount: 5, type: 'expense' as const, date: at('2026-08-01') },
      { accountId: 'acc-1', amount: 5, type: 'expense' as const, date: at('2026-08-01') },
    ];
    const claimed = new Set<string>();
    const hits = incoming.map(c => findTwin(c, existing, 3, claimed));
    expect(hits.map(t => t?.id)).toEqual(['a', 'b']);

    // A third sighting has nothing left to claim, so it inserts rather than merging.
    expect(findTwin(incoming[0], existing, 3, claimed)).toBeNull();
  });

  it('leaves a pre-claimed row alone', () => {
    const existing = [tx({ id: 'already-imported' })];
    const claimed = new Set(['already-imported']);
    expect(findTwin({ accountId: 'acc-1', amount: 50, type: 'expense', date: at('2026-08-01') }, existing, 3, claimed))
      .toBeNull();
  });
});

describe('mergeFields', () => {
  const monarch: Partial<Transaction> = {
    title: 'Amazon',
    merchant: 'Amazon',
    category: 'shopping',
    sourceCategory: 'Shopping',
    description: 'AMZN Mktp US*2H4KJ',
    amount: 50,
    date: at('2026-08-02'),
    accountId: 'acc-9',
  };

  it('lets Monarch fill categories and clean the merchant, never amount/date/account', () => {
    const patch = mergeFields(tx({ category: 'other', sources: ['simplefin'] }), monarch, 'monarch');
    expect(patch).toEqual({
      title: 'Amazon',
      merchant: 'Amazon',
      category: 'shopping',
      sourceCategory: 'Shopping',
      description: 'AMZN Mktp US*2H4KJ',
      sources: ['simplefin', 'monarch'],
    });
    expect(patch).not.toHaveProperty('amount');
    expect(patch).not.toHaveProperty('date');
    expect(patch).not.toHaveProperty('accountId');
  });

  it('never overwrites a field the owner edited by hand', () => {
    const existing = tx({ category: 'food', merchant: 'Whole Foods', userEdited: { category: true, merchant: true } });
    const patch = mergeFields(existing, monarch, 'monarch');
    expect(patch.category).toBeUndefined();
    expect(patch.merchant).toBeUndefined();
    expect(patch.sourceCategory).toBe('Shopping');
  });

  it('keeps the raw statement text as the description', () => {
    const existing = tx({ description: 'ZELLE FROM RAVI' });
    expect(mergeFields(existing, monarch, 'monarch').description).toBeUndefined();
  });

  it('only fills blanks for a source without categories', () => {
    const existing = tx({ merchant: 'Amazon', sourceCategory: 'Shopping' });
    const patch = mergeFields(existing, { merchant: 'AMZN MKTP US', title: 'AMZN MKTP US*2H4KJ' }, 'simplefin');
    expect(patch).toEqual({ sources: ['simplefin'] }); // title/merchant left alone
  });

  it('is empty when there is nothing to add — the caller skips the write', () => {
    const existing = tx({
      title: 'Amazon', merchant: 'Amazon', category: 'shopping', sourceCategory: 'Shopping',
      description: 'AMZN Mktp US*2H4KJ', sources: ['monarch'],
    });
    expect(mergeFields(existing, monarch, 'monarch')).toEqual({});
  });
});
