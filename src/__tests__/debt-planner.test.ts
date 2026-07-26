/**
 * Debt Planner Tests
 */

import {
  accountsToDebts,
  simulateMinimumPayments,
  generateDebtPayoffPlan,
  compareStrategies,
  getDebtFreeDate,
} from '../lib/debt-planner';
import { PaymentAccount, DebtAccount } from '../types';

// Helper to create mock credit card
const mockCreditCard = (
  balance: number,
  apr: number,
  name: string = 'Credit Card'
): PaymentAccount => ({
  id: `card_${Math.random().toString(36).substr(2, 9)}`,
  name,
  type: 'credit_card',
  provider: 'visa',
  openingBalance: balance, openingDate: '2000-01-01',
  creditLimit: 5000,
  apr,
  dueDate: 15,
  color: '#1a1f71',
  isActive: true,
});

// Helper to create mock loan
const mockLoan = (
  balance: number,
  apr: number,
  monthlyPayment: number,
  name: string = 'Loan'
): PaymentAccount => ({
  id: `loan_${Math.random().toString(36).substr(2, 9)}`,
  name,
  type: 'personal_loan',
  provider: 'bank-transfer',
  openingBalance: balance, openingDate: '2000-01-01',
  apr,
  monthlyPayment,
  dueDate: 1,
  color: '#f59e0b',
  isActive: true,
});

describe('Debt Planner', () => {
  describe('accountsToDebts', () => {
    it('should convert credit cards to debt accounts', () => {
      const accounts = [
        mockCreditCard(1000, 24.99, 'Chase Card'),
        mockCreditCard(500, 19.99, 'Citi Card'),
      ];
      
      const debts = accountsToDebts(accounts);
      
      expect(debts.length).toBe(2);
      expect(debts[0].name).toBe('Chase Card');
      expect(debts[0].balance).toBe(1000);
      expect(debts[0].apr).toBe(24.99);
    });
    
    it('should convert loans to debt accounts', () => {
      const accounts = [
        mockLoan(10000, 8.5, 500, 'Auto Loan'),
      ];
      
      const debts = accountsToDebts(accounts);
      
      expect(debts.length).toBe(1);
      expect(debts[0].minimumPayment).toBe(500);
    });
    
    it('should filter out zero-balance accounts', () => {
      const accounts = [
        mockCreditCard(1000, 24.99),
        mockCreditCard(0, 19.99), // Zero balance
      ];
      
      const debts = accountsToDebts(accounts);
      
      expect(debts.length).toBe(1);
    });
    
    it('should calculate minimum payment for credit cards', () => {
      const accounts = [
        mockCreditCard(1000, 24.99),
      ];
      
      const debts = accountsToDebts(accounts);
      
      // Minimum should be 2% or $25, whichever is higher
      expect(debts[0].minimumPayment).toBe(25); // 2% of 1000 = 20, so $25 minimum
    });
  });
  
  describe('simulateMinimumPayments', () => {
    it('should calculate time to pay off with minimum payments', () => {
      const debts: DebtAccount[] = [
        {
          id: '1',
          name: 'Card',
          balance: 1000,
          apr: 24,
          minimumPayment: 25,
          dueDate: 15,
        },
      ];
      
      const result = simulateMinimumPayments(debts);
      
      expect(result.totalMonths).toBeGreaterThan(0);
      expect(result.totalInterest).toBeGreaterThan(0);
    });
  });
  
  describe('generateDebtPayoffPlan', () => {
    const debts: DebtAccount[] = [
      { id: '1', name: 'High APR Card', balance: 500, apr: 29.99, minimumPayment: 25, dueDate: 15 },
      { id: '2', name: 'Low Balance Card', balance: 200, apr: 19.99, minimumPayment: 25, dueDate: 1 },
      { id: '3', name: 'Medium Card', balance: 1000, apr: 24.99, minimumPayment: 30, dueDate: 20 },
    ];
    
    it('should generate snowball plan (smallest first)', () => {
      const plan = generateDebtPayoffPlan(debts, 'snowball', 100);
      
      // Snowball: smallest balance first
      expect(plan.debts[0].accountName).toBe('Low Balance Card');
      expect(plan.debts[0].payoffOrder).toBe(1);
    });
    
    it('should generate avalanche plan (highest APR first)', () => {
      const plan = generateDebtPayoffPlan(debts, 'avalanche', 100);
      
      // Avalanche: highest APR first
      expect(plan.debts[0].accountName).toBe('High APR Card');
      expect(plan.debts[0].payoffOrder).toBe(1);
    });
    
    it('should calculate interest savings vs minimum payments', () => {
      const plan = generateDebtPayoffPlan(debts, 'avalanche', 100);
      
      expect(plan.interestSaved).toBeGreaterThanOrEqual(0);
    });
    
    it('should return debt-free timeline', () => {
      const plan = generateDebtPayoffPlan(debts, 'avalanche', 200);
      
      expect(plan.totalMonths).toBeGreaterThan(0);
      expect(plan.totalMonths).toBeLessThan(360); // Less than 30 years
    });
    
    it('should handle empty debt list', () => {
      const plan = generateDebtPayoffPlan([], 'snowball', 100);
      
      expect(plan.debts.length).toBe(0);
      expect(plan.totalMonths).toBe(0);
    });
  });
  
  describe('compareStrategies', () => {
    const debts: DebtAccount[] = [
      { id: '1', name: 'High APR', balance: 2000, apr: 29.99, minimumPayment: 50, dueDate: 15 },
      { id: '2', name: 'Low APR', balance: 500, apr: 15.99, minimumPayment: 25, dueDate: 1 },
    ];
    
    it('should compare both strategies', () => {
      const comparison = compareStrategies(debts, 100);
      
      expect(comparison.snowball).toBeDefined();
      expect(comparison.avalanche).toBeDefined();
      expect(comparison.recommendation).toBeDefined();
    });
    
    it('should recommend avalanche when it saves significant money', () => {
      const comparison = compareStrategies(debts, 50);
      
      // Avalanche typically saves more on high-interest debt
      expect(comparison.avalanche.interestSaved).toBeGreaterThanOrEqual(comparison.snowball.interestSaved);
    });
    
    it('should calculate savings difference', () => {
      const comparison = compareStrategies(debts, 100);
      
      const expectedDiff = comparison.avalanche.interestSaved - comparison.snowball.interestSaved;
      expect(comparison.savingsDifference).toBe(expectedDiff);
    });
  });
  
  describe('getDebtFreeDate', () => {
    it('should return formatted debt-free date', () => {
      const debts: DebtAccount[] = [
        { id: '1', name: 'Card', balance: 1000, apr: 20, minimumPayment: 50, dueDate: 15 },
      ];
      
      const plan = generateDebtPayoffPlan(debts, 'avalanche', 100);
      const debtFreeDate = getDebtFreeDate(plan);
      
      // Should be a valid date string like "March 2026"
      expect(debtFreeDate).toMatch(/^[A-Z][a-z]+ \d{4}$/);
    });
  });
});


