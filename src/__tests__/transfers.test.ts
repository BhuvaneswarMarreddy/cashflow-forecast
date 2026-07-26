import { matchTransfers } from '@/lib/transfers';
import { PaymentAccount, Transaction } from '@/types';

const bank = (id: string): PaymentAccount => ({
  id, name: id, type: 'bank_account', provider: 'chase', openingBalance: 0, openingDate: '2000-01-01', color: '#000', isActive: true,
});
const card = (id: string): PaymentAccount => ({
  id, name: id, type: 'credit_card', provider: 'visa', openingBalance: 0, openingDate: '2000-01-01', color: '#000', isActive: true,
});
const leg = (o: Partial<Transaction>): Transaction => ({
  id: Math.random().toString(), title: '', amount: 0, type: 'transfer',
  category: 'other', paymentMethod: 'chase', date: '2026-06-28', ...o,
});

describe('matchTransfers', () => {
  const accounts = [bank('bofa'), card('visa'), bank('chase')];

  test('pairs the two legs of one movement (bank -> card) into a net-zero pair', () => {
    const txns = [
      leg({ accountId: 'bofa', amount: 700, transferDirection: 'out', title: 'Payment to Visa' }),
      leg({ accountId: 'visa', amount: 700, transferDirection: 'in', title: 'Payment from BofA' }),
    ];
    const m = matchTransfers(txns, accounts);
    expect(m.pairs).toHaveLength(1);
    expect(m.pairs[0].fromAccountId).toBe('bofa');
    expect(m.pairs[0].toAccountId).toBe('visa');
    expect(m.unmatchedOut).toHaveLength(0);
    expect(m.unmatchedIn).toHaveLength(0);
  });

  test('a leg whose counterpart account is not imported stays UNMATCHED', () => {
    // Money left BofA to an external account that was never imported — only one leg exists.
    const txns = [leg({ accountId: 'bofa', amount: 500, transferDirection: 'out', title: 'Zelle to landlord' })];
    const m = matchTransfers(txns, accounts);
    expect(m.pairs).toHaveLength(0);
    expect(m.unmatchedOut).toHaveLength(1);
  });

  test('does not pair two legs on the same account, or mismatched amounts', () => {
    const txns = [
      leg({ accountId: 'bofa', amount: 500, transferDirection: 'out' }),
      leg({ accountId: 'bofa', amount: 500, transferDirection: 'in' }),   // same account
      leg({ accountId: 'visa', amount: 499, transferDirection: 'in' }),    // wrong amount
    ];
    const m = matchTransfers(txns, accounts);
    expect(m.pairs).toHaveLength(0);
  });

  test('matches within the date window but not outside it', () => {
    const near = [
      leg({ accountId: 'bofa', amount: 200, transferDirection: 'out', date: '2026-06-28' }),
      leg({ accountId: 'visa', amount: 200, transferDirection: 'in', date: '2026-06-30' }),
    ];
    expect(matchTransfers(near, accounts).pairs).toHaveLength(1);

    const far = [
      leg({ accountId: 'bofa', amount: 200, transferDirection: 'out', date: '2026-06-01' }),
      leg({ accountId: 'visa', amount: 200, transferDirection: 'in', date: '2026-06-30' }),
    ];
    expect(matchTransfers(far, accounts).pairs).toHaveLength(0);
  });

  test('real income and expenses are never treated as transfer legs', () => {
    const txns = [
      leg({ accountId: 'bofa', amount: 3000, type: 'income', title: 'Paycheck' }),
      leg({ accountId: 'visa', amount: 80, type: 'expense', title: 'Home Depot' }),
    ];
    const m = matchTransfers(txns, accounts);
    expect(m.pairs).toHaveLength(0);
    expect(m.unmatchedOut).toHaveLength(0);
    expect(m.unmatchedIn).toHaveLength(0);
  });
});
