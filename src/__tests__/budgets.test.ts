/**
 * Budget Calculation Tests
 */

import {
  getCategorySpending,
  getAllCategorySpending,
  projectMonthEndSpending,
  calculateBudgetStatuses,
  getTopBudgetRisks,
  simulateBudgetImpact,
  getSuggestedBudgets,
} from '../lib/budgets';
import { Transaction, CategoryBudget, ExpenseCategory } from '../types';

// Helper to create mock transaction
const mockTransaction = (
  category: ExpenseCategory,
  amount: number,
  type: 'expense' | 'income' = 'expense',
  daysAgo: number = 0
): Transaction => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return {
    id: `txn_${Math.random().toString(36).substr(2, 9)}`,
    title: `Test ${category}`,
    amount,
    type,
    category,
    paymentMethod: 'chase',
    date: date.toISOString(),
  };
};

describe('Budget Calculations', () => {
  describe('getCategorySpending', () => {
    it('should calculate spending for a specific category', () => {
      const transactions = [
        mockTransaction('food', 50),
        mockTransaction('food', 30),
        mockTransaction('shopping', 100),
      ];
      
      const spending = getCategorySpending(transactions, 'food');
      expect(spending).toBe(80);
    });
    
    it('should only count expenses, not income', () => {
      const transactions = [
        mockTransaction('food', 50),
        mockTransaction('food', 100, 'income'),
      ];
      
      const spending = getCategorySpending(transactions, 'food');
      expect(spending).toBe(50);
    });
    
    it('should return 0 for category with no transactions', () => {
      const transactions = [
        mockTransaction('food', 50),
      ];
      
      const spending = getCategorySpending(transactions, 'shopping');
      expect(spending).toBe(0);
    });
  });
  
  describe('getAllCategorySpending', () => {
    it('should return spending for all categories', () => {
      const transactions = [
        mockTransaction('food', 50),
        mockTransaction('food', 30),
        mockTransaction('shopping', 100),
        mockTransaction('utilities', 75),
      ];
      
      const spending = getAllCategorySpending(transactions);
      expect(spending.food).toBe(80);
      expect(spending.shopping).toBe(100);
      expect(spending.utilities).toBe(75);
      expect(spending.entertainment).toBe(0);
    });
  });
  
  describe('projectMonthEndSpending', () => {
    it('should project spending based on current rate', () => {
      // If we've spent $100 in 10 days of a 30-day month
      // We'd project $300 by month end
      const projected = projectMonthEndSpending(100, new Date());
      
      // Projection should be higher than current spending
      expect(projected).toBeGreaterThanOrEqual(100);
    });
  });
  
  describe('calculateBudgetStatuses', () => {
    const budgets: CategoryBudget[] = [
      { categoryId: 'food', monthlyLimit: 500, isEnabled: true },
      { categoryId: 'shopping', monthlyLimit: 200, isEnabled: true },
      { categoryId: 'entertainment', monthlyLimit: 100, isEnabled: false },
    ];
    
    it('should calculate status for enabled budgets only', () => {
      const transactions = [
        mockTransaction('food', 250),
        mockTransaction('shopping', 210),
      ];
      
      const statuses = calculateBudgetStatuses(budgets, transactions);
      
      // Should only have 2 statuses (entertainment is disabled)
      expect(statuses.length).toBe(2);
    });
    
    it('should mark over-budget categories', () => {
      const transactions = [
        mockTransaction('shopping', 250), // Over $200 budget
      ];
      
      const statuses = calculateBudgetStatuses(budgets, transactions);
      const shoppingStatus = statuses.find(s => s.categoryId === 'shopping');
      
      expect(shoppingStatus?.isOverBudget).toBe(true);
      expect(shoppingStatus?.remaining).toBeLessThan(0);
    });
    
    it('should calculate percentage used correctly', () => {
      const transactions = [
        mockTransaction('food', 250), // 50% of $500
      ];
      
      const statuses = calculateBudgetStatuses(budgets, transactions);
      const foodStatus = statuses.find(s => s.categoryId === 'food');
      
      expect(foodStatus?.percentUsed).toBe(50);
    });
    
    it('should sort by percent used (highest first)', () => {
      const transactions = [
        mockTransaction('food', 250), // 50%
        mockTransaction('shopping', 180), // 90%
      ];
      
      const statuses = calculateBudgetStatuses(budgets, transactions);
      
      // Shopping (90%) should come before food (50%)
      expect(statuses[0].categoryId).toBe('shopping');
    });
  });
  
  describe('getTopBudgetRisks', () => {
    it('should return top N overspending risks', () => {
      const budgets: CategoryBudget[] = [
        { categoryId: 'food', monthlyLimit: 500, isEnabled: true },
        { categoryId: 'shopping', monthlyLimit: 200, isEnabled: true },
        { categoryId: 'utilities', monthlyLimit: 100, isEnabled: true },
      ];
      
      const transactions = [
        mockTransaction('food', 450), // 90% - at risk
        mockTransaction('shopping', 210), // Over
        mockTransaction('utilities', 40), // 40% - safe
      ];
      
      const risks = getTopBudgetRisks(budgets, transactions, 2);
      
      // Should only return food and shopping (utilities is safe)
      expect(risks.length).toBeLessThanOrEqual(2);
      expect(risks.some(r => r.categoryId === 'shopping')).toBe(true);
    });
  });
  
  describe('simulateBudgetImpact', () => {
    const budgets: CategoryBudget[] = [
      { categoryId: 'food', monthlyLimit: 500, isEnabled: true },
    ];
    
    it('should simulate spending impact', () => {
      const transactions = [
        mockTransaction('food', 400),
      ];
      
      const impact = simulateBudgetImpact(budgets, transactions, 'food', 150);
      
      expect(impact.currentStatus?.spent).toBe(400);
      expect(impact.afterSpend?.spent).toBe(550);
      expect(impact.wouldExceedBudget).toBe(true);
    });
    
    it('should return null for unbudgeted category', () => {
      const transactions: Transaction[] = [];
      
      const impact = simulateBudgetImpact(budgets, transactions, 'shopping', 100);
      
      expect(impact.currentStatus).toBeNull();
      expect(impact.wouldExceedBudget).toBe(false);
    });
  });
  
  describe('getSuggestedBudgets', () => {
    it('should calculate suggested budgets based on income', () => {
      const monthlyIncome = 5000;
      const suggested = getSuggestedBudgets(monthlyIncome);
      
      // Housing should be ~30%
      expect(suggested.rent).toBe(1500);
      
      // Total suggestions should not exceed income
      const total = Object.values(suggested).reduce((sum, v) => sum + v, 0);
      expect(total).toBeLessThanOrEqual(monthlyIncome);
    });
  });
});


