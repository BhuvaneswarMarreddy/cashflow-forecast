import { PaymentAccount, Transaction } from '@/types';
import { monthlyAverages } from '@/lib/forecast';

const acct = (o: Partial<PaymentAccount> & { id: string }): PaymentAccount => ({
  name: o.id, type: 'bank_account', provider: 'chase', openingBalance: 0, openingDate: '2000-01-01',
  color: '#000', isActive: true, ...o,
} as PaymentAccount);
const tx = (o: Partial<Transaction> & { id: string; amount: number; date: string }): Transaction => ({
  title: o.id, type: 'expense', category: 'other', paymentMethod: 'bank-transfer', ...o,
} as Transaction);

describe('monthlyAverages', () => {
  it('averages income and spending over the last N full months, ignoring transfers & this month', () => {
    const A = [acct({ id: 'b' })];
    // build 3 full prior months relative to a fixed "now"
    const now = new Date();
    const m = (back: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 15)).toISOString().slice(0, 10);
    const txns = [
      tx({ id: 'i1', amount: 3000, type: 'income', accountId: 'b', date: m(1) }),
      tx({ id: 'i2', amount: 3000, type: 'income', accountId: 'b', date: m(2) }),
      tx({ id: 'e1', amount: 1000, type: 'expense', accountId: 'b', date: m(1) }),
      tx({ id: 'e2', amount: 500, type: 'expense', accountId: 'b', date: m(2) }),
      tx({ id: 'xfer', amount: 999, type: 'transfer', transferDirection: 'out', accountId: 'b', date: m(1) }), // ignored
      tx({ id: 'now', amount: 9999, type: 'income', accountId: 'b', date: m(0) }), // current month excluded
    ];
    const r = monthlyAverages(txns, A, 3);
    expect(r.income).toBe(Math.round(6000 / 3));   // 2000
    expect(r.spending).toBe(Math.round(1500 / 3)); // 500
  });
});
