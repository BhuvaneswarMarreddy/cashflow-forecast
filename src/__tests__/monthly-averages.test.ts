/**
 * monthlyAverages() — the "Monthly Income" / suggested-budget figure.
 *
 * FIN-INCOME-001 replaced the rule this file used to pin. It preferred rows whose
 * `sourceCategory` was the literal 'Paychecks' and otherwise summed EVERY
 * income-classified row, so refunds, Zelle credits and one-off deposits inflated
 * income. Income now comes from APPROVED SOURCES only.
 */
import { IncomeSource, PaymentAccount, Transaction } from '@/types';
import { monthlyAverages } from '@/lib/forecast';

const acct = (o: Partial<PaymentAccount> & { id: string }): PaymentAccount => ({
  name: o.id, type: 'bank_account', provider: 'chase', openingBalance: 0, openingDate: '2000-01-01',
  color: '#000', isActive: true, ...o,
} as PaymentAccount);
const tx = (o: Partial<Transaction> & { id: string; amount: number; date: string }): Transaction => ({
  title: o.id, type: 'expense', category: 'other', paymentMethod: 'bank-transfer', ...o,
} as Transaction);

const EMPLOYER: IncomeSource = {
  id: 'src1', name: 'Larkspur Studio', amount: 4000, frequency: 'monthly', isActive: true,
};

const now = new Date();
const m = (back: number) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 15)).toISOString().slice(0, 10);

describe('monthlyAverages', () => {
  it('averages EARNED income and spending over the last N full months, ignoring transfers & this month', () => {
    const A = [acct({ id: 'b' })];
    const txns = [
      tx({ id: 'i1', title: 'LARKSPUR STUDIO PAYROLL', amount: 3000, type: 'income', accountId: 'b', date: m(1) }),
      tx({ id: 'i2', title: 'LARKSPUR STUDIO PAYROLL', amount: 3000, type: 'income', accountId: 'b', date: m(2) }),
      tx({ id: 'e1', amount: 1000, type: 'expense', accountId: 'b', date: m(1) }),
      tx({ id: 'e2', amount: 500, type: 'expense', accountId: 'b', date: m(2) }),
      tx({ id: 'xfer', amount: 999, type: 'transfer', transferDirection: 'out', accountId: 'b', date: m(1) }), // ignored
      tx({ id: 'now', title: 'LARKSPUR STUDIO PAYROLL', amount: 9999, type: 'income', accountId: 'b', date: m(0) }), // current month excluded
    ];
    const r = monthlyAverages(txns, A, 3, { sources: [EMPLOYER] });
    expect(r.income).toBe(Math.round(6000 / 3));   // 2000
    expect(r.spending).toBe(Math.round(1500 / 3)); // 500
  });

  it('counts ONLY what an approved source explains — no provider category involved', () => {
    const A = [acct({ id: 'b' })];
    const txns = [
      // The importer sent no category at all on the real paychecks...
      tx({ id: 'p1', title: 'ACH CREDIT LARKSPUR STUDIO', amount: 4000, type: 'income', accountId: 'b', date: m(1) }),
      tx({ id: 'p2', title: 'ACH CREDIT LARKSPUR STUDIO', amount: 4000, type: 'income', accountId: 'b', date: m(2) }),
      // ...and DID tag these, which used to be enough to make them income.
      tx({ id: 'zelle', title: 'ZELLE FROM ROWAN ASHDOWN', amount: 5000, type: 'income', accountId: 'b', date: m(1), sourceCategory: 'Paychecks' }),
      tx({ id: 'refund', title: 'AB-4471 CREDIT', amount: 200, type: 'income', accountId: 'b', date: m(2), sourceCategory: 'Paychecks' }),
    ];
    expect(monthlyAverages(txns, A, 2, { sources: [EMPLOYER] }).income).toBe(4000);
  });

  it('claims NO income at all when no approved source is configured', () => {
    const A = [acct({ id: 'b' })];
    const txns = [
      tx({ id: 'z1', title: 'ZELLE FROM ROWAN ASHDOWN', amount: 5000, type: 'income', accountId: 'b', date: m(1) }),
      tx({ id: 'z2', title: 'DEPOSIT', amount: 5000, type: 'income', accountId: 'b', date: m(2), sourceCategory: 'Paychecks' }),
      tx({ id: 'e1', amount: 600, type: 'expense', accountId: 'b', date: m(1) }),
    ];
    const r = monthlyAverages(txns, A, 2, { sources: [] });
    expect(r.income).toBe(0);
    expect(r.spending).toBe(300); // spending is unaffected
  });

  it('a PAUSED source stops counting without deleting its history', () => {
    const A = [acct({ id: 'b' })];
    const txns = [tx({ id: 'p1', title: 'ACH CREDIT LARKSPUR STUDIO', amount: 4000, type: 'income', accountId: 'b', date: m(1) })];
    expect(monthlyAverages(txns, A, 1, { sources: [EMPLOYER] }).income).toBe(4000);
    expect(monthlyAverages(txns, A, 1, { sources: [{ ...EMPLOYER, isActive: false }] }).income).toBe(0);
  });
});
