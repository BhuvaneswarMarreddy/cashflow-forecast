/**
 * The recurring bug family: never print an unbacked value as a measured one.
 * An unanchored account's balance is net movement, not a bank balance — the
 * number is still shown, but it never claims to be something it is not.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { earliestRowDate } from '@/lib/accounts';
import { UnanchoredNote } from '@/components/UnanchoredNote';
import { Transaction, PaymentAccount } from '@/types';

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

// #83 Fix 6: nothing on the branch actually mounted <UnanchoredNote> before this —
// the three screens were pinned only by a grep for the JSX open tag, which cannot
// tell "counts the right accounts" from "counts the wrong ones" (that's what Fix 1
// got wrong). These render() the component itself against the spec's own words:
// "An unanchored account renders the note; totals containing one render the count;
// an anchored account renders neither" — plus the singular/plural wording, which the
// grep also could not see.
const acct = (o: Partial<PaymentAccount> & { id: string }): PaymentAccount => ({
  name: o.id, type: 'bank_account', provider: 'chase', openingBalance: 0,
  color: '#000', isActive: true, ...o,
} as PaymentAccount);

describe('UnanchoredNote', () => {
  it('an anchored account renders neither the note nor any count', () => {
    const { container } = render(
      <UnanchoredNote accounts={[acct({ id: 'a', openingDate: '2026-01-01' })]} />
    );
    // Fails if the n === 0 guard is ever dropped or inverted — e.g. rendering
    // "includes 0 unanchored accounts" instead of nothing.
    expect(container).toBeEmptyDOMElement();
  });

  it('a single unanchored account renders the note in the singular', () => {
    render(<UnanchoredNote accounts={[acct({ id: 'a', openingDate: undefined })]} />);
    expect(screen.getByText('includes 1 unanchored account')).toBeInTheDocument();
    // Guards against the plural sneaking onto the n === 1 case.
    expect(screen.queryByText(/accounts$/)).not.toBeInTheDocument();
  });

  it('a total containing more than one unanchored account renders the count, pluralized', () => {
    render(
      <UnanchoredNote
        accounts={[
          acct({ id: 'a', openingDate: undefined }),
          acct({ id: 'b', openingDate: undefined }),
          acct({ id: 'c', openingDate: '2026-01-01' }), // anchored — must not inflate the count
        ]}
      />
    );
    expect(screen.getByText('includes 2 unanchored accounts')).toBeInTheDocument();
  });
});
