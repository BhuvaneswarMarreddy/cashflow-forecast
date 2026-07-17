/**
 * Budget Calculation Utility
 * 
 * Calculates spending by category and projects month-end totals.
 * Supports the primary question: "Can I afford this today?"
 */

import { Transaction, CategoryBudget, CategoryBudgetStatus, ExpenseCategory, EXPENSE_CATEGORIES } from '@/types';
import { startOfMonth, endOfMonth, format, parseISO, differenceInDays, isWithinInterval } from 'date-fns';

/**
 * Get spending for a specific category in the current month
 */
export function getCategorySpending(
  transactions: Transaction[],
  categoryId: ExpenseCategory,
  month: Date = new Date()
): number {
  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  
  return transactions
    .filter(t => {
      const txnDate = parseISO(t.date);
      return (
        t.type === 'expense' &&
        t.category === categoryId &&
        isWithinInterval(txnDate, { start: monthStart, end: monthEnd })
      );
    })
    .reduce((sum, t) => sum + t.amount, 0);
}

/**
 * Get all category spending for the current month
 */
export function getAllCategorySpending(
  transactions: Transaction[],
  month: Date = new Date()
): Record<ExpenseCategory, number> {
  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  
  const spending: Record<string, number> = {};
  
  // Initialize all categories to 0
  EXPENSE_CATEGORIES.forEach(cat => {
    spending[cat.value] = 0;
  });
  
  // Sum up spending
  transactions
    .filter(t => {
      const txnDate = parseISO(t.date);
      return (
        t.type === 'expense' &&
        isWithinInterval(txnDate, { start: monthStart, end: monthEnd })
      );
    })
    .forEach(t => {
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
  month: Date = new Date()
): CategoryBudgetStatus[] {
  const spending = getAllCategorySpending(transactions, month);
  
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
  month: Date = new Date()
): CategoryBudgetStatus[] {
  const statuses = calculateBudgetStatuses(budgets, transactions, month);
  
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
  month: Date = new Date()
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
  
  const spending = getAllCategorySpending(transactions, month);
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


