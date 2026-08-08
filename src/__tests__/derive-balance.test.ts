import { PaymentAccount, Transaction } from '@/types';
import { deriveAccountBalance, withDerivedBalances } from '@/lib/forecast';

const acct = (o: Partial<PaymentAccount> & { id: string }): PaymentAccount => ({
  name: o.id, type: 'bank_account', provider: 'chase', openingBalance: 0,
  openingDate: '2026-01-01', color: '#000', isActive: true, ...o,
} as PaymentAccount);
const tx = (o: Partial<Transaction> & { id: string; amount: number }): Transaction => ({
  title: o.id, type: 'expense', category: 'other', paymentMethod: 'bank-transfer',
  date: '2026-02-01', ...o,
} as Transaction);

describe('deriveAccountBalance with opening anchor', () => {
  const bank = acct({ id: 'b', openingBalance: 1000, openingDate: '2026-02-01' });
  it('cash: opening + net of rows dated >= openingDate', () => {
    const txns = [
      tx({ id: 'i', amount: 200, type: 'income', accountId: 'b', date: '2026-02-10' }),
      tx({ id: 'e', amount: 50, type: 'expense', accountId: 'b', date: '2026-02-11' }),
      tx({ id: 'old', amount: 999, type: 'expense', accountId: 'b', date: '2026-01-15' }), // pre-anchor, ignored
    ];
    expect(deriveAccountBalance(bank, txns)).toBe(1000 + 200 - 50);
  });
  it('debt: opening - net; a payment lowers owed, a purchase raises it', () => {
    const card = acct({ id: 'c', type: 'credit_card', provider: 'amex', openingBalance: 500, openingDate: '2026-02-01' });
    const txns = [
      tx({ id: 'buy', amount: 100, type: 'expense', accountId: 'c', date: '2026-02-05' }),
      tx({ id: 'pay', amount: 300, type: 'transfer', transferDirection: 'in', accountId: 'c', date: '2026-02-06' }),
    ];
    // owed = 500 - (payment 300 - purchase 100) = 500 - 200 = 300
    expect(deriveAccountBalance(card, txns)).toBe(300);
  });
  it('debt can go negative (credit balance) and is not clamped', () => {
    const card = acct({ id: 'c', type: 'credit_card', provider: 'amex', openingBalance: 100, openingDate: '2026-02-01' });
    const txns = [tx({ id: 'pay', amount: 300, type: 'transfer', transferDirection: 'in', accountId: 'c', date: '2026-02-06' })];
    expect(deriveAccountBalance(card, txns)).toBe(-200);
  });
});

// The Accounts page's "include pending holds" toggle. Holds stay OUT by default —
// the opening anchor is the provider's POSTED balance, so folding them in by
// default would double-count. The flag is the owner asking "and once these clear?".
describe('deriveAccountBalance includePending', () => {
  const bank = acct({ id: 'b', openingBalance: 1000, openingDate: '2026-02-01' });
  const txns = [
    tx({ id: 'posted', amount: 50, type: 'expense', accountId: 'b', date: '2026-02-10' }),
    tx({ id: 'hold-in', amount: 4334.93, type: 'income', accountId: 'b', date: '2026-02-11', pending: true }),
    tx({ id: 'hold-out', amount: 92.73, type: 'expense', accountId: 'b', date: '2026-02-11', pending: true }),
  ];

  it('excludes holds by default', () => {
    expect(deriveAccountBalance(bank, txns)).toBe(950);
  });

  it('folds holds in — both directions — when asked', () => {
    expect(deriveAccountBalance(bank, txns, true)).toBeCloseTo(950 + 4334.93 - 92.73, 2);
  });

  it('a debt account nets holds the other way', () => {
    const card = acct({ id: 'c', type: 'credit_card', provider: 'amex', openingBalance: 500, openingDate: '2026-02-01' });
    const holds = [tx({ id: 'buy', amount: 40, type: 'expense', accountId: 'c', date: '2026-02-05', pending: true })];
    expect(deriveAccountBalance(card, holds)).toBe(500);       // hold ignored
    expect(deriveAccountBalance(card, holds, true)).toBe(540); // a pending purchase raises owed
  });

  it('withDerivedBalances passes the flag through', () => {
    expect(withDerivedBalances([bank], txns)[0].currentBalance).toBe(950);
    expect(withDerivedBalances([bank], txns, true)[0].currentBalance).toBeCloseTo(5192.20, 2);
  });
});
