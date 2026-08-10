import { withDerivedBalances } from '@/lib/forecast';
import type { PaymentAccount, Transaction } from '@/types';

import { mapAccount, mapTransaction } from '../snapshot';

/**
 * The one invariant `homeSnapshot` exists to hold.
 *
 * The mobile client renders a balance and a list of signed amounts side by
 * side. If the sign it shows on a row disagrees with the effect that row had on
 * the balance, the screen contradicts itself and neither figure can be trusted.
 * Both come from `isPositive()` here — this asserts they still reconcile.
 *
 * Dates sit in the past on purpose: `deriveAccountBalance` treats anything after
 * today as forecast and excludes it.
 */
const txn = (over: Partial<Transaction>): Transaction => ({
  id: 't',
  title: 'Row',
  amount: 0,
  type: 'expense',
  category: 'other',
  paymentMethod: 'bank-transfer',
  date: '2026-02-01',
  ...over,
});

describe('snapshot mapping', () => {
  it('reconciles a cash account: opening + every mapped amount = the balance shown', () => {
    const checking: PaymentAccount = {
      id: 'chk',
      name: 'Checking',
      type: 'bank_account',
      provider: 'bank-transfer',
      color: '#000000',
      isActive: true,
      openingBalance: 1000,
      openingDate: '2026-01-01',
    };
    const transactions = [
      txn({ id: 'rent', title: 'Rent', amount: 250, type: 'expense', category: 'rent', accountId: 'chk' }),
      txn({ id: 'pay', title: 'Salary', amount: 500, type: 'income', accountId: 'chk', date: '2026-02-02' }),
    ];

    const [derived] = withDerivedBalances([checking], transactions, {});
    const rows = transactions.map((t) => mapTransaction(t, [checking]));

    expect(rows.map((r) => r.amountCents)).toEqual([-25_000, 50_000]);
    expect(mapAccount(derived).balanceCents).toBe(
      100_000 + rows.reduce((sum, r) => sum + r.amountCents, 0),
    );
  });

  it('keeps a card balance as the amount OWED, so a purchase raises it', () => {
    const card: PaymentAccount = {
      id: 'card',
      name: 'Amex',
      type: 'credit_card',
      provider: 'amex',
      color: '#000000',
      isActive: true,
      openingBalance: 100,
      openingDate: '2026-01-01',
      creditLimit: 5000,
      lastFourDigits: '1234',
    };
    const purchase = txn({ id: 'buy', title: 'Groceries', amount: 40, category: 'food', accountId: 'card' });

    const [derived] = withDerivedBalances([card], [purchase], {});
    const mapped = mapAccount(derived);

    expect(mapped.balanceCents).toBe(14_000);
    expect(mapped.availableCents).toBe(500_000 - 14_000);
    expect(mapped.kind).toBe('credit-card');
    expect(mapped.mask).toBe('1234');
  });

  it('flags an account with no opening anchor as stale rather than quoting it flatly', () => {
    const unanchored: PaymentAccount = {
      id: 'x',
      name: 'Old savings',
      type: 'bank_account',
      provider: 'bank-transfer',
      color: '#000000',
      isActive: true,
      openingBalance: 0,
    };
    expect(mapAccount(unanchored).status).toBe('stale');
  });
});
