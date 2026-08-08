/**
 * FIN-PENDING-001 (#86/#87) — the app-wide "treat holds as settled" policy.
 *
 * The invariant these pin: the setting changes CALCULATION only. It never mutates a
 * row, and it reaches every screen through one object, so no two screens can disagree.
 *
 * The asymmetry is deliberate and is tested here too: state honours the policy,
 * pattern inference never does.
 */
import { IncomeSource, PaymentAccount, Transaction } from '@/types';
import {
  FinancialPolicy, interpretTransaction, sumExpenseCents, sumIncomeCents,
} from '@/lib/classify';
import { monthlyAverages } from '@/lib/forecast';

const bank: PaymentAccount = {
  id: 'b', name: 'Checking', type: 'bank_account', provider: 'chase',
  openingBalance: 0, openingDate: '2026-01-01', color: '#000', isActive: true,
} as PaymentAccount;
const card: PaymentAccount = { ...bank, id: 'c', name: 'Card', type: 'credit_card' } as PaymentAccount;
const accounts = [bank, card];

const source: IncomeSource = {
  id: 'src1', name: 'Acme', amount: 4000, frequency: 'monthly',
  isActive: true, matchAliases: ['acme'],
} as IncomeSource;

const tx = (o: Partial<Transaction> & { id: string; amount: number }): Transaction => ({
  title: o.id, type: 'expense', category: 'other', paymentMethod: 'bank-transfer',
  date: '2026-07-10', accountId: 'b', ...o,
} as Transaction);

const OFF: FinancialPolicy = { sources: [source], includePending: false };
const ON: FinancialPolicy = { sources: [source], includePending: true };

describe('FIN-PENDING-001: the policy gates income and spending', () => {
  const pendingPay = tx({ id: 'pay', title: 'ACME PAYROLL', amount: 4334.93, type: 'income', pending: true });
  const pendingBuy = tx({ id: 'buy', title: 'Xfinity', amount: 92.73, pending: true });
  const postedBuy = tx({ id: 'posted', title: 'Link', amount: 15.96 });

  it('OFF: a pending inflow counts for nothing', () => {
    expect(sumIncomeCents([pendingPay], accounts, OFF)).toBe(0);
  });

  it('ON: the same inflow counts as earned income', () => {
    expect(sumIncomeCents([pendingPay], accounts, ON)).toBe(433493);
  });

  it('OFF: a pending outflow counts for nothing; the posted one still does', () => {
    expect(sumExpenseCents([pendingBuy, postedBuy], accounts, OFF)).toBe(1596);
  });

  it('ON: both outflows count', () => {
    expect(sumExpenseCents([pendingBuy, postedBuy], accounts, ON)).toBe(1596 + 9273);
  });

  it('ON never invents income: an unmatched pending credit is still not earned income', () => {
    const mystery = tx({ id: 'zelle', title: 'Zelle from a friend', amount: 500, type: 'income', pending: true });
    expect(sumIncomeCents([mystery], accounts, ON)).toBe(0);
    expect(interpretTransaction(mystery, accounts, ON).financialMeaning).toBe('unknown_inflow');
  });
});

describe('FIN-PENDING-001: movement is never money, in either mode', () => {
  it('a pending internal transfer is neither income nor spending', () => {
    const move = tx({ id: 'mv', title: 'Online Transfer to SAV', amount: 500, type: 'transfer', pending: true });
    for (const policy of [OFF, ON]) {
      expect(sumIncomeCents([move], accounts, policy)).toBe(0);
      expect(sumExpenseCents([move], accounts, policy)).toBe(0);
    }
  });

  it('a pending card payment is neither — it settles spending already counted row by row', () => {
    const pay = tx({
      id: 'cc', title: 'Payment to Card', amount: 1000, type: 'transfer',
      transferDirection: 'in', accountId: 'c', pending: true,
    });
    for (const policy of [OFF, ON]) {
      expect(sumIncomeCents([pay], accounts, policy)).toBe(0);
      expect(sumExpenseCents([pay], accounts, policy)).toBe(0);
    }
  });
});

describe('FIN-PENDING-001: the policy is read-time only', () => {
  it('interpreting a row under either policy leaves the row untouched', () => {
    const row = tx({ id: 'imm', title: 'Xfinity', amount: 92.73, pending: true });
    const snapshot = JSON.stringify(row);
    interpretTransaction(row, accounts, OFF);
    interpretTransaction(row, accounts, ON);
    expect(JSON.stringify(row)).toBe(snapshot);
    expect(row.pending).toBe(true); // still a hold, whatever the totals say
  });

  it('the row is still reported as pending so the UI can badge it', () => {
    const row = tx({ id: 'p', amount: 10, pending: true });
    expect(interpretTransaction(row, accounts, ON).pending).toBe('pending');
  });
});

describe('FIN-PENDING-001: pattern inference ignores the policy', () => {
  // The asymmetry. A $1 fuel pre-auth must never seed a recurring bill, and a
  // 6-month average must not move daily on rows that post at a different amount.
  it('monthly averages are identical in both modes', () => {
    const rows = [
      tx({ id: 'a', title: 'ACME PAYROLL', amount: 4000, type: 'income', date: '2026-07-01' }),
      tx({ id: 'b', title: 'Rent', amount: 1850, date: '2026-07-02' }),
      tx({ id: 'hold', title: 'Xfinity', amount: 92.73, date: '2026-07-03', pending: true }),
    ];
    expect(monthlyAverages(rows, accounts, 6, ON))
      .toEqual(monthlyAverages(rows, accounts, 6, OFF));
  });
});
