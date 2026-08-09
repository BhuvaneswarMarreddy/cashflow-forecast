/**
 * The full-picture context every AI call should carry: debts, budget, goals.
 * The callables merge these into the prompt when present (buildPrompt), so a
 * "can I afford this?" answer weighs card utilization and loan obligations —
 * not just the checking-account forecast.
 */
import { UserProfile, Transaction } from '@/types';
import { withDerivedBalances, monthlyAverages } from './forecast';
import { sumExpenseCents, IncomeContext } from './classify';
import { isUnanchored } from './accounts';

/**
 * `policy` is required (#102): the AI must be told the same financial state the owner is
 * looking at. Answering "can I afford this?" from posted-only balances while the screen
 * shows an effective one is worse than not answering.
 */
export function financialContext(
  profile: UserProfile | null,
  transactions: Transaction[],
  policy: IncomeContext
) {
  if (!profile) return {};
  const accounts = withDerivedBalances(profile.paymentAccounts || [], transactions, policy);

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
  // STATE-002 (#104): the app's ONE spending total, not a private reduce. The old
  // filter used classifyTransaction, which cannot see the owner's confirmed reviews —
  // so the AI answered "can I afford this?" from a figure that excluded every transfer
  // the owner had personally marked as real spending.
  const spentThisMonth =
    sumExpenseCents(transactions.filter((t) => t.date.slice(0, 7) === month), accounts, policy) / 100;
  const derived = monthlyAverages(transactions, accounts, 6, { ...policy, sources: profile.incomeSources });
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

  // #83: an unanchored account (no openingDate) has a `currentOf`/`currentBalance` that is
  // net movement over the rows we hold, not a confirmed bank balance — already baked into
  // debtContext/budgetContext above with no flag. Accounts, Dashboard, and Forecast all
  // disclose this on screen; without it here the AI is the one surface left that can still
  // say "you have $X available" with false confidence. Gated on accounts alone (not on
  // debtContext/budgetContext existing) because an unanchored bank account with no budget
  // set must still be disclosed. Named, not just counted, so the model can say WHICH
  // figure is soft instead of hedging every number in the response.
  const unanchored = accounts.filter(isUnanchored);
  const dataCaveats = unanchored.length > 0
    ? { unanchoredAccounts: unanchored.map((a) => a.name), reason: 'balance is net movement over imported history, not a confirmed bank balance' }
    : undefined;

  return { debtContext, budgetContext, goalsContext, dataCaveats };
}
