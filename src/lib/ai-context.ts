/**
 * The full-picture context every AI call should carry: debts, budget, goals.
 * The callables merge these into the prompt when present (buildPrompt), so a
 * "can I afford this?" answer weighs card utilization and loan obligations —
 * not just the checking-account forecast.
 */
import { UserProfile, Transaction } from '@/types';
import { withDerivedBalances, monthlyAverages } from './forecast';
import { classifyTransaction } from './classify';

export function financialContext(profile: UserProfile | null, transactions: Transaction[]) {
  if (!profile) return {};
  const accounts = withDerivedBalances(profile.paymentAccounts || [], transactions);

  const cards = accounts.filter((a) => a.type === 'credit_card');
  const loans = accounts.filter((a) => a.type === 'personal_loan');
  const debtContext = (cards.length || loans.length) ? {
    creditCards: cards.map((c) => ({
      name: c.name,
      owed: c.currentBalance ?? 0,
      creditLimit: c.creditLimit ?? null,
      utilizationPct: c.creditLimit ? Math.round(((c.currentBalance ?? 0) / c.creditLimit) * 100) : null,
      paymentDueDayOfMonth: c.dueDate ?? null,
    })),
    loans: loans.map((l) => ({
      name: l.name,
      owed: l.currentBalance ?? 0,
      monthlyPayment: l.monthlyPayment ?? null,
      apr: l.apr ?? null,
      paymentDueDayOfMonth: l.dueDate ?? null,
    })),
    totalDebt: [...cards, ...loans].reduce((s, a) => s + (a.currentBalance ?? 0), 0),
    totalMonthlyLoanObligation: loans.reduce((s, l) => s + (l.monthlyPayment ?? 0), 0),
  } : undefined;

  const month = new Date().toISOString().slice(0, 7);
  const spentThisMonth = transactions
    .filter((t) => t.date.slice(0, 7) === month && classifyTransaction(t, accounts) === 'expense')
    .reduce((s, t) => s + t.amount, 0);
  const derived = monthlyAverages(transactions, accounts, 6, { sources: profile.incomeSources });
  const budget = profile.monthlyBudget > 0 ? profile.monthlyBudget : derived.spending;
  const budgetContext = budget > 0 ? {
    monthlyBudget: budget,
    budgetSource: profile.monthlyBudget > 0 ? 'user-set' : 'typical spend (6-month average)',
    spentThisMonth: Math.round(spentThisMonth),
    remainingThisMonth: Math.round(budget - spentThisMonth),
  } : undefined;

  const goalsContext = profile.savingsGoals?.length
    ? profile.savingsGoals.map((g) => ({ name: g.name, target: g.targetAmount, saved: g.currentAmount }))
    : undefined;

  return { debtContext, budgetContext, goalsContext };
}
