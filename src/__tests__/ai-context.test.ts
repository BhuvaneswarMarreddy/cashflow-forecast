import { POSTED_ONLY } from '@/lib/classify';
import { financialContext } from '@/lib/ai-context';
import { UserProfile, Transaction } from '@/types';

const profile = {
  monthlyBudget: 3000,
  paymentAccounts: [
    { id: 'card', name: 'Amex', type: 'credit_card', provider: 'amex', openingBalance: 800, openingDate: '2000-01-01', creditLimit: 2000, dueDate: 15, color: '#000', isActive: true },
    { id: 'loan', name: 'Upstart', type: 'personal_loan', provider: 'other', openingBalance: 5000, openingDate: '2000-01-01', monthlyPayment: 250, apr: 9.5, dueDate: 3, color: '#000', isActive: true },
    { id: 'bank', name: 'Chase', type: 'bank_account', provider: 'chase', openingBalance: 4000, openingDate: '2000-01-01', color: '#000', isActive: true },
  ],
} as unknown as UserProfile;

const thisMonth = new Date().toISOString().slice(0, 7);
const txns = [
  { id: 'e1', title: 'groceries', type: 'expense', amount: 120, category: 'other', paymentMethod: 'chase', date: `${thisMonth}-05`, accountId: 'bank' },
] as Transaction[];

describe('financialContext', () => {
  it('assembles debts with utilization, budget with month-to-date, and omits empty goals', () => {
    const ctx = financialContext(profile, txns, POSTED_ONLY);
    expect(ctx.debtContext?.creditCards[0]).toMatchObject({ name: 'Amex', owed: 800, utilizationPct: 40 });
    expect(ctx.debtContext?.loans[0]).toMatchObject({ name: 'Upstart', monthlyPayment: 250, apr: 9.5 });
    expect(ctx.debtContext?.totalDebt).toBe(5800);
    expect(ctx.debtContext?.totalMonthlyLoanObligation).toBe(250);
    expect(ctx.budgetContext).toMatchObject({ monthlyBudget: 3000, spentThisMonth: 120, remainingThisMonth: 2880, budgetSource: 'user-set' });
    expect(ctx.goalsContext).toBeUndefined();
  });

  it('returns empty for a null profile', () => {
    expect(financialContext(null, [], POSTED_ONLY)).toEqual({});
  });
});
