/**
 * Budget Calculation Utility
 * 
 * Calculates spending by category and projects month-end totals.
 * Supports the primary question: "Can I afford this today?"
 */

import { Transaction, PaymentAccount, CategoryBudget, CategoryBudgetStatus, ExpenseCategory, EXPENSE_CATEGORIES } from '@/types';
import { startOfMonth, endOfMonth, format, parseISO, differenceInDays, isWithinInterval } from 'date-fns';
import { interpretTransaction } from '@/lib/classify';
import { netCategorySpendingCents } from '@/lib/refunds';
import { TransactionLink } from '@/lib/relations';

/**
 * Does this row count against a category budget?
 *
 * The shared interpretation decides, never the stored `type`. That keeps a
 * credit-card payment out of the budget (it is a transfer, and counting it made
 * "Other" blow its limit every statement cycle).
 *
 * PENDING: EXCLUDED. A hold is not settled spending and often posts at a different
 * amount; letting it count would flip a category to over-budget and then unflip it.
 * The hold is still visible on the transaction lists — it is filtered from the
 * TOTAL, not from sight.
 *
 * `accounts` is optional: without it a card-payment leg on a card cannot be
 * recognised, which is the pre-existing behaviour of every caller that has no
 * account list to hand.
 */
const countsAgainstBudget = (t: Transaction, accounts?: PaymentAccount[]) =>
  interpretTransaction(t, accounts).budget === 'counted';

/**
 * A confirmed refund reduces consumed budget. FIN-REFUND-001 exposed
 * `netCategorySpendingCents()` but could not wire it — `budgets.ts` was not its file to
 * edit — so a returned $1,100.00 purchase still ate a Shopping budget it no longer costs.
 * FIN-RECOVERY-UI-001 owns this file and closes that gap.
 *
 * `links` is OPTIONAL and the gross path is untouched when it is absent or empty, so
 * every existing caller keeps its exact previous arithmetic. Only a caller that hands
 * over confirmed links sees net — and only CONFIRMED links move a number: a `suggested`
 * or `provisional` link is invisible to `purchaseEconomics()` by construction, which is
 * the mechanical form of "nothing applies before confirmation".
 *
 * Gross is never destroyed to show net: the row keeps its full amount in History, and
 * `getAllCategorySpending(txns, month, accounts)` still answers gross for anyone who asks.
 */
const inMonth = (transactions: Transaction[], month: Date, accounts?: PaymentAccount[]) => {
  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  return transactions.filter(t =>
    countsAgainstBudget(t, accounts) && isWithinInterval(parseISO(t.date), { start: monthStart, end: monthEnd })
  );
};

/**
 * Get spending for a specific category in the current month
 */
export function getCategorySpending(
  transactions: Transaction[],
  categoryId: ExpenseCategory,
  month: Date = new Date(),
  accounts?: PaymentAccount[],
  links?: readonly TransactionLink[]
): number {
  if (links?.length) return getAllCategorySpending(transactions, month, accounts, links)[categoryId] ?? 0;

  return inMonth(transactions, month, accounts)
    .filter(t => t.category === categoryId)
    .reduce((sum, t) => sum + t.amount, 0);
}

/**
 * Get all category spending for the current month
 */
export function getAllCategorySpending(
  transactions: Transaction[],
  month: Date = new Date(),
  accounts?: PaymentAccount[],
  links?: readonly TransactionLink[]
): Record<ExpenseCategory, number> {
  const rows = inMonth(transactions, month, accounts);

  // Net path: integer cents throughout, then one division at the boundary.
  if (links?.length) {
    const cents = netCategorySpendingCents(rows, links, accounts);
    return Object.fromEntries(
      EXPENSE_CATEGORIES.map(cat => [cat.value, (cents[cat.value] ?? 0) / 100])
    ) as Record<ExpenseCategory, number>;
  }

  const spending: Record<string, number> = {};
  EXPENSE_CATEGORIES.forEach(cat => {
    spending[cat.value] = 0;
  });
  rows.forEach(t => {
    spending[t.category] = (spending[t.category] || 0) + t.amount;
  });

  return spending as Record<ExpenseCategory, number>;
}

/**
 * Project month-end spending based on current trend
 * Uses simple linear projection from days elapsed
 */
export function projectMonthEndSpending(
  spent: number,
  month: Date = new Date()
): number {
  const today = new Date();
  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  
  const daysElapsed = differenceInDays(today, monthStart) + 1;
  const totalDays = differenceInDays(monthEnd, monthStart) + 1;
  
  if (daysElapsed <= 0) return spent;
  if (daysElapsed >= totalDays) return spent;
  
  // Simple linear projection
  const dailyRate = spent / daysElapsed;
  return Math.round(dailyRate * totalDays);
}

/**
 * Calculate budget status for all enabled categories
 */
export function calculateBudgetStatuses(
  budgets: CategoryBudget[],
  transactions: Transaction[],
  month: Date = new Date(),
  accounts?: PaymentAccount[],
  links?: readonly TransactionLink[]
): CategoryBudgetStatus[] {
  const spending = getAllCategorySpending(transactions, month, accounts, links);
  
  return budgets
    .filter(b => b.isEnabled && b.monthlyLimit > 0)
    .map(budget => {
      const spent = spending[budget.categoryId] || 0;
      const remaining = budget.monthlyLimit - spent;
      const percentUsed = budget.monthlyLimit > 0 ? (spent / budget.monthlyLimit) * 100 : 0;
      const projectedMonthEnd = projectMonthEndSpending(spent, month);
      
      const categoryInfo = EXPENSE_CATEGORIES.find(c => c.value === budget.categoryId);
      
      return {
        categoryId: budget.categoryId,
        categoryLabel: categoryInfo?.label || budget.categoryId,
        monthlyLimit: budget.monthlyLimit,
        spent,
        remaining,
        percentUsed,
        projectedMonthEnd,
        isOverBudget: spent > budget.monthlyLimit,
        isAtRisk: projectedMonthEnd > budget.monthlyLimit && !spent // Will likely exceed
      };
    })
    .sort((a, b) => b.percentUsed - a.percentUsed); // Sort by percent used (highest first)
}

/**
 * Get top N overspending risks (for compact forecast display)
 */
export function getTopBudgetRisks(
  budgets: CategoryBudget[],
  transactions: Transaction[],
  limit: number = 3,
  month: Date = new Date(),
  accounts?: PaymentAccount[]
): CategoryBudgetStatus[] {
  const statuses = calculateBudgetStatuses(budgets, transactions, month, accounts);
  
  // Filter to categories that are over budget or at risk
  const atRisk = statuses.filter(s => s.isOverBudget || s.isAtRisk || s.percentUsed >= 80);
  
  return atRisk.slice(0, limit);
}

/**
 * Calculate how a potential spend affects budget
 */
export function simulateBudgetImpact(
  budgets: CategoryBudget[],
  transactions: Transaction[],
  categoryId: ExpenseCategory,
  amount: number,
  month: Date = new Date(),
  accounts?: PaymentAccount[]
): {
  currentStatus: CategoryBudgetStatus | null;
  afterSpend: CategoryBudgetStatus | null;
  wouldExceedBudget: boolean;
} {
  const budget = budgets.find(b => b.categoryId === categoryId && b.isEnabled);
  
  if (!budget) {
    return {
      currentStatus: null,
      afterSpend: null,
      wouldExceedBudget: false,
    };
  }
  
  const spending = getAllCategorySpending(transactions, month, accounts);
  const currentSpent = spending[categoryId] || 0;
  const afterSpent = currentSpent + amount;
  
  const categoryInfo = EXPENSE_CATEGORIES.find(c => c.value === categoryId);
  
  const currentStatus: CategoryBudgetStatus = {
    categoryId,
    categoryLabel: categoryInfo?.label || categoryId,
    monthlyLimit: budget.monthlyLimit,
    spent: currentSpent,
    remaining: budget.monthlyLimit - currentSpent,
    percentUsed: (currentSpent / budget.monthlyLimit) * 100,
    projectedMonthEnd: projectMonthEndSpending(currentSpent, month),
    isOverBudget: currentSpent > budget.monthlyLimit,
    isAtRisk: false,
  };
  
  const afterStatus: CategoryBudgetStatus = {
    categoryId,
    categoryLabel: categoryInfo?.label || categoryId,
    monthlyLimit: budget.monthlyLimit,
    spent: afterSpent,
    remaining: budget.monthlyLimit - afterSpent,
    percentUsed: (afterSpent / budget.monthlyLimit) * 100,
    projectedMonthEnd: projectMonthEndSpending(afterSpent, month),
    isOverBudget: afterSpent > budget.monthlyLimit,
    isAtRisk: false,
  };
  
  return {
    currentStatus,
    afterSpend: afterStatus,
    wouldExceedBudget: afterSpent > budget.monthlyLimit && currentSpent <= budget.monthlyLimit,
  };
}

/**
 * Get default budgets for all categories (disabled by default)
 */
export function getDefaultBudgets(): CategoryBudget[] {
  return EXPENSE_CATEGORIES.map(cat => ({
    categoryId: cat.value,
    monthlyLimit: 0,
    isEnabled: false,
  }));
}

/**
 * Suggested budget amounts based on income
 */
export function getSuggestedBudgets(monthlyIncome: number): Record<ExpenseCategory, number> {
  // Based on common budgeting guidelines (50/30/20 rule variations)
  return {
    rent: Math.round(monthlyIncome * 0.30), // 30% for housing
    utilities: Math.round(monthlyIncome * 0.05),
    food: Math.round(monthlyIncome * 0.12),
    transportation: Math.round(monthlyIncome * 0.10),
    insurance: Math.round(monthlyIncome * 0.05),
    healthcare: Math.round(monthlyIncome * 0.05),
    subscriptions: Math.round(monthlyIncome * 0.03),
    entertainment: Math.round(monthlyIncome * 0.05),
    shopping: Math.round(monthlyIncome * 0.05),
    education: Math.round(monthlyIncome * 0.02),
    travel: Math.round(monthlyIncome * 0.03),
    investments: Math.round(monthlyIncome * 0.10),
    other: Math.round(monthlyIncome * 0.05),
  };
}


