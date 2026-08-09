/**
 * The recurring bug family: never print an unbacked value as a measured one.
 * An unanchored account's balance is net movement, not a bank balance — the
 * number is still shown, but it never claims to be something it is not.
 */
import { earliestRowDate } from '@/lib/accounts';
import { Transaction } from '@/types';

const txns = [
  { id: 't1', accountId: 'a', date: '2026-04-02', amount: 1, type: 'expense' },
  { id: 't2', accountId: 'a', date: '2026-03-14', amount: 1, type: 'expense' },
  { id: 't3', accountId: 'b', date: '2026-01-01', amount: 1, type: 'expense' },
] as unknown as Transaction[];

describe('earliestRowDate', () => {
  it('finds the account\'s own earliest row', () => {
    expect(earliestRowDate('a', txns)).toBe('2026-03-14');
  });

  it('is undefined when the account has no rows', () => {
    expect(earliestRowDate('zzz', txns)).toBeUndefined();
  });
});
