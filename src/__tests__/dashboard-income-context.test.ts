/**
 * The dashboard's Monthly Overview chart showed $0 income over the entire ledger,
 * for every user. Not a wrong number — a structurally impossible one: the three
 * TransactionContext getters took only (accounts?), so interpretTransaction ran with
 * no approved income sources and counted nothing as income. Two lines above,
 * pastExpenses passed incomeContext; these had no parameter to pass it to.
 *
 * Measured on the real export: $0.00 across 0 rows without the context, $100,967.96
 * across 31 rows with it.
 */
import { PaymentAccount, Transaction } from '@/types';
import { IncomeContext, interpretTransaction } from '@/lib/classify';

const ACCOUNTS: PaymentAccount[] = [
  { id: 'bank', name: 'Checking', type: 'bank_account', isActive: true } as PaymentAccount,
];

const paycheck = (date: string): Transaction => ({
  id: `p-${date}`, title: 'ACME PAYROLL PPD', merchant: 'ACME PAYROLL',
  description: 'ACME PAYROLL PPD ID 123', amount: 4000, type: 'income',
  category: 'other', paymentMethod: 'other', date, accountId: 'bank',
} as Transaction);

const SOURCES: IncomeContext = {
  sources: [{
    id: 's1', name: 'ACME', amount: 4000, frequency: 'biweekly',
    isActive: true, matchAliases: ['acme payroll'],
  }],
} as IncomeContext;

/** Exactly what getMonthlyTotals does per row. */
const countedIncome = (rows: Transaction[], income?: IncomeContext) =>
  rows.filter((t) => interpretTransaction(t, ACCOUNTS, income).income === 'counted')
    .reduce((s, t) => s + t.amount, 0);

describe('dashboard monthly totals need the income context', () => {
  const rows = [paycheck('2026-06-05'), paycheck('2026-06-19'), paycheck('2026-07-03')];

  it('counts nothing as income when the context is withheld — the shipped bug', () => {
    expect(countedIncome(rows, undefined)).toBe(0);
  });

  it('counts every matching paycheck once the context is supplied', () => {
    expect(countedIncome(rows, SOURCES)).toBe(12000);
  });

  it('still refuses an inflow no approved source explains', () => {
    // The fix must not turn "pass the context" into "count everything".
    const mystery = { ...paycheck('2026-06-10'), id: 'm1', title: 'UNKNOWN DEPOSIT', merchant: 'UNKNOWN', description: 'UNKNOWN DEPOSIT' } as Transaction;
    expect(countedIncome([mystery], SOURCES)).toBe(0);
  });
});
