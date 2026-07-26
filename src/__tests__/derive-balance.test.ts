import { PaymentAccount, Transaction } from '@/types';
import { deriveAccountBalance } from '@/lib/forecast';

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
