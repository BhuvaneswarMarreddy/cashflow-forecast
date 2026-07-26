/**
 * User Flow Tests
 * Tests complete user flows and integration scenarios
 */

import { PaymentAccount, IncomeSource, Transaction } from '@/types';

// Simulated user profile
interface UserProfile {
  id: string;
  email: string;
  name: string;
  isOnboarded: boolean;
  monthlyBudget: number;
  currency: string;
  paymentAccounts: PaymentAccount[];
  incomeSources: IncomeSource[];
  settings?: {
    safetyThreshold?: number;
    emergencyFundGoal?: number;
    emergencyFundGoalType?: 'months_expenses' | 'fixed_amount';
  };
}

// Helper functions that mirror app logic
function calculateTotalBalance(accounts: PaymentAccount[]): number {
  return accounts.reduce((sum, acc) => {
    // Credit cards and loans show negative balance (what you owe)
    // Bank accounts show positive balance
    if (acc.type === 'credit_card' || acc.type === 'personal_loan') {
      return sum + acc.openingBalance; // Already negative
    }
    return sum + acc.openingBalance;
  }, 0);
}

function calculateCashOnHand(accounts: PaymentAccount[]): number {
  return accounts
    .filter(acc => acc.type === 'bank_account' || acc.type === 'cash' || acc.type === 'debit_card')
    .filter(acc => acc.isActive)
    .reduce((sum, acc) => sum + acc.openingBalance, 0);
}

function calculateTotalDebt(accounts: PaymentAccount[]): number {
  return accounts
    .filter(acc => acc.type === 'credit_card' || acc.type === 'personal_loan')
    .filter(acc => acc.isActive)
    .reduce((sum, acc) => sum + Math.abs(acc.openingBalance), 0);
}

function calculateMonthlyIncome(incomeSources: IncomeSource[]): number {
  return incomeSources
    .filter(inc => inc.isActive)
    .reduce((sum, inc) => {
      switch (inc.frequency) {
        case 'weekly':
          return sum + (inc.amount * 4.33); // Average weeks per month
        case 'biweekly':
          return sum + (inc.amount * 2.17);
        case 'monthly':
          return sum + inc.amount;
        case 'yearly':
          return sum + (inc.amount / 12);
        default:
          return sum;
      }
    }, 0);
}

function calculateRunwayDays(
  cashOnHand: number,
  monthlyExpenses: number
): number {
  if (monthlyExpenses <= 0) return Infinity;
  const dailyExpenses = monthlyExpenses / 30;
  return Math.floor(cashOnHand / dailyExpenses);
}

describe('User Flows', () => {
  describe('Onboarding Flow', () => {
    test('new user should start with empty profile', () => {
      const newUser: UserProfile = {
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        isOnboarded: false,
        monthlyBudget: 3000,
        currency: 'USD',
        paymentAccounts: [],
        incomeSources: [],
      };

      expect(newUser.isOnboarded).toBe(false);
      expect(newUser.paymentAccounts).toHaveLength(0);
      expect(newUser.incomeSources).toHaveLength(0);
    });

    test('should add bank account during onboarding', () => {
      const user: UserProfile = {
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        isOnboarded: false,
        monthlyBudget: 3000,
        currency: 'USD',
        paymentAccounts: [],
        incomeSources: [],
      };

      // Add bank account
      const newAccount: PaymentAccount = {
        id: 'acc-1',
        name: 'Chase Checking',
        type: 'bank_account',
        provider: 'chase',
        openingBalance: 5000, openingDate: '2000-01-01',
        color: '#1e88e5',
        isActive: true,
      };

      user.paymentAccounts.push(newAccount);

      expect(user.paymentAccounts).toHaveLength(1);
      expect(calculateCashOnHand(user.paymentAccounts)).toBe(5000);
    });

    test('should add credit card with linked payment account', () => {
      const accounts: PaymentAccount[] = [
        {
          id: 'acc-1',
          name: 'Chase Checking',
          type: 'bank_account',
          provider: 'chase',
          openingBalance: 5000, openingDate: '2000-01-01',
          color: '#1e88e5',
          isActive: true,
        },
        {
          id: 'cc-1',
          name: 'AMEX Card',
          type: 'credit_card',
          provider: 'amex',
          openingBalance: -1500, openingDate: '2000-01-01',
          creditLimit: 10000,
          apr: 24.99,
          dueDate: 15,
          color: '#7c3aed',
          isActive: true,
          paymentFromAccountId: 'acc-1', // Linked to checking
        },
      ];

      expect(accounts).toHaveLength(2);
      expect(calculateCashOnHand(accounts)).toBe(5000);
      expect(calculateTotalDebt(accounts)).toBe(1500);
      expect(accounts[1].paymentFromAccountId).toBe('acc-1');
    });

    test('should complete onboarding with income source', () => {
      const user: UserProfile = {
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        isOnboarded: false,
        monthlyBudget: 3000,
        currency: 'USD',
        paymentAccounts: [
          {
            id: 'acc-1',
            name: 'Chase Checking',
            type: 'bank_account',
            provider: 'chase',
            openingBalance: 5000, openingDate: '2000-01-01',
            color: '#1e88e5',
            isActive: true,
          },
        ],
        incomeSources: [],
      };

      // Add income source
      const income: IncomeSource = {
        id: 'inc-1',
        name: 'Salary',
        amount: 5000,
        frequency: 'monthly',
        payDate: 1,
        isActive: true,
      };

      user.incomeSources.push(income);
      user.isOnboarded = true;

      expect(user.isOnboarded).toBe(true);
      expect(user.incomeSources).toHaveLength(1);
      expect(calculateMonthlyIncome(user.incomeSources)).toBe(5000);
    });
  });

  describe('Balance Calculations', () => {
    const testAccounts: PaymentAccount[] = [
      {
        id: 'acc-1',
        name: 'Chase Checking',
        type: 'bank_account',
        provider: 'chase',
        openingBalance: 5000, openingDate: '2000-01-01',
        color: '#1e88e5',
        isActive: true,
      },
      {
        id: 'acc-2',
        name: 'Chase Savings',
        type: 'bank_account',
        provider: 'chase',
        openingBalance: 10000, openingDate: '2000-01-01',
        color: '#43a047',
        isActive: true,
      },
      {
        id: 'cc-1',
        name: 'AMEX Card',
        type: 'credit_card',
        provider: 'amex',
        openingBalance: -1500, openingDate: '2000-01-01',
        color: '#7c3aed',
        isActive: true,
      },
      {
        id: 'loan-1',
        name: 'Car Loan',
        type: 'personal_loan',
        provider: 'other',
        openingBalance: -15000, openingDate: '2000-01-01',
        color: '#ef4444',
        isActive: true,
      },
    ];

    test('should calculate cash on hand (excluding debt)', () => {
      expect(calculateCashOnHand(testAccounts)).toBe(15000); // 5000 + 10000
    });

    test('should calculate total debt', () => {
      expect(calculateTotalDebt(testAccounts)).toBe(16500); // 1500 + 15000
    });

    test('should calculate net worth', () => {
      const netWorth = calculateTotalBalance(testAccounts);
      expect(netWorth).toBe(-1500); // 15000 - 16500
    });

    test('should exclude inactive accounts', () => {
      const accountsWithInactive: PaymentAccount[] = [
        ...testAccounts,
        {
          id: 'acc-3',
          name: 'Old Account',
          type: 'bank_account',
          provider: 'other',
          openingBalance: 1000, openingDate: '2000-01-01',
          color: '#9e9e9e',
          isActive: false, // Inactive
        },
      ];

      expect(calculateCashOnHand(accountsWithInactive)).toBe(15000); // Unchanged
    });
  });

  describe('Runway Calculations', () => {
    test('should calculate runway in days', () => {
      const cashOnHand = 6000;
      const monthlyExpenses = 3000;
      const runway = calculateRunwayDays(cashOnHand, monthlyExpenses);
      
      expect(runway).toBe(60); // 6000 / 100 per day = 60 days
    });

    test('should handle zero expenses', () => {
      const cashOnHand = 6000;
      const monthlyExpenses = 0;
      const runway = calculateRunwayDays(cashOnHand, monthlyExpenses);
      
      expect(runway).toBe(Infinity);
    });

    test('should handle zero cash', () => {
      const cashOnHand = 0;
      const monthlyExpenses = 3000;
      const runway = calculateRunwayDays(cashOnHand, monthlyExpenses);
      
      expect(runway).toBe(0);
    });
  });

  describe('Income Calculations', () => {
    test('should calculate monthly income from various frequencies', () => {
      const incomeSources: IncomeSource[] = [
        {
          id: 'inc-1',
          name: 'Salary',
          amount: 5000,
          frequency: 'monthly',
          isActive: true,
        },
        {
          id: 'inc-2',
          name: 'Side Gig',
          amount: 500,
          frequency: 'weekly',
          isActive: true,
        },
        {
          id: 'inc-3',
          name: 'Bonus',
          amount: 12000,
          frequency: 'yearly',
          isActive: true,
        },
      ];

      const monthlyIncome = calculateMonthlyIncome(incomeSources);
      
      // 5000 + (500 * 4.33) + (12000 / 12) = 5000 + 2165 + 1000 = 8165
      expect(monthlyIncome).toBeCloseTo(8165, 0);
    });

    test('should exclude inactive income sources', () => {
      const incomeSources: IncomeSource[] = [
        {
          id: 'inc-1',
          name: 'Active Job',
          amount: 5000,
          frequency: 'monthly',
          isActive: true,
        },
        {
          id: 'inc-2',
          name: 'Old Job',
          amount: 3000,
          frequency: 'monthly',
          isActive: false,
        },
      ];

      expect(calculateMonthlyIncome(incomeSources)).toBe(5000);
    });
  });

  describe('Emergency Fund Scenarios', () => {
    test('should calculate months of expenses covered', () => {
      const cashOnHand = 9000;
      const monthlyExpenses = 3000;
      const monthsCovered = cashOnHand / monthlyExpenses;
      
      expect(monthsCovered).toBe(3);
    });

    test('should check if emergency fund goal is met', () => {
      const cashOnHand = 9000;
      const monthlyExpenses = 3000;
      const goalMonths = 3;
      
      const requiredFund = monthlyExpenses * goalMonths;
      const isMet = cashOnHand >= requiredFund;
      
      expect(requiredFund).toBe(9000);
      expect(isMet).toBe(true);
    });

    test('should calculate shortfall', () => {
      const cashOnHand = 6000;
      const monthlyExpenses = 3000;
      const goalMonths = 6;
      
      const requiredFund = monthlyExpenses * goalMonths;
      const shortfall = Math.max(0, requiredFund - cashOnHand);
      
      expect(requiredFund).toBe(18000);
      expect(shortfall).toBe(12000);
    });
  });

  describe('Safety Threshold Scenarios', () => {
    test('should identify when balance is below safety threshold', () => {
      const currentBalance = 500;
      const safetyThreshold = 1000;
      
      expect(currentBalance < safetyThreshold).toBe(true);
    });

    test('should calculate days until unsafe', () => {
      const currentBalance = 2000;
      const safetyThreshold = 500;
      const dailyExpenses = 50;
      
      const bufferAmount = currentBalance - safetyThreshold;
      const daysUntilUnsafe = Math.floor(bufferAmount / dailyExpenses);
      
      expect(daysUntilUnsafe).toBe(30);
    });
  });

  describe('Spending Decision Flow', () => {
    test('should simulate safe spending', () => {
      const currentBalance = 5000;
      const safetyThreshold = 1000;
      const spendAmount = 500;
      
      const newBalance = currentBalance - spendAmount;
      const isSafe = newBalance >= safetyThreshold;
      
      expect(newBalance).toBe(4500);
      expect(isSafe).toBe(true);
    });

    test('should simulate risky spending', () => {
      const currentBalance = 2000;
      const safetyThreshold = 1000;
      const spendAmount = 1500;
      
      const newBalance = currentBalance - spendAmount;
      const isSafe = newBalance >= safetyThreshold;
      const isRisky = newBalance < safetyThreshold && newBalance > 0;
      
      expect(newBalance).toBe(500);
      expect(isSafe).toBe(false);
      expect(isRisky).toBe(true);
    });

    test('should simulate unsafe spending', () => {
      const currentBalance = 1000;
      const spendAmount = 1200;
      
      const newBalance = currentBalance - spendAmount;
      const isUnsafe = newBalance < 0;
      
      expect(newBalance).toBe(-200);
      expect(isUnsafe).toBe(true);
    });
  });
});

describe('Transaction History Scenarios', () => {
  describe('Grouping', () => {
    test('should group transactions by month', () => {
      const transactions: Transaction[] = [
        { id: '1', title: 'T1', amount: 100, type: 'expense', category: 'food', paymentMethod: 'bank-transfer', date: '2025-12-15' },
        { id: '2', title: 'T2', amount: 200, type: 'expense', category: 'shopping', paymentMethod: 'amex', date: '2025-12-20' },
        { id: '3', title: 'T3', amount: 150, type: 'expense', category: 'food', paymentMethod: 'cash', date: '2025-11-10' },
      ];

      const groups: { [key: string]: Transaction[] } = {};
      
      transactions.forEach(t => {
        const month = t.date.substring(0, 7); // YYYY-MM
        if (!groups[month]) groups[month] = [];
        groups[month].push(t);
      });

      expect(Object.keys(groups)).toHaveLength(2);
      expect(groups['2025-12']).toHaveLength(2);
      expect(groups['2025-11']).toHaveLength(1);
    });

    test('should group transactions by year', () => {
      const transactions: Transaction[] = [
        { id: '1', title: 'T1', amount: 100, type: 'expense', category: 'food', paymentMethod: 'bank-transfer', date: '2025-12-15' },
        { id: '2', title: 'T2', amount: 200, type: 'expense', category: 'shopping', paymentMethod: 'amex', date: '2024-06-20' },
      ];

      const groups: { [key: string]: Transaction[] } = {};
      
      transactions.forEach(t => {
        const year = t.date.substring(0, 4);
        if (!groups[year]) groups[year] = [];
        groups[year].push(t);
      });

      expect(Object.keys(groups)).toHaveLength(2);
      expect(groups['2025']).toHaveLength(1);
      expect(groups['2024']).toHaveLength(1);
    });
  });

  describe('Filtering', () => {
    const transactions: Transaction[] = [
      { id: '1', title: 'Salary', amount: 5000, type: 'income', category: 'other', paymentMethod: 'bank-transfer', date: '2025-12-01', accountId: 'acc-1' },
      { id: '2', title: 'Groceries', amount: 150, type: 'expense', category: 'food', paymentMethod: 'bank-transfer', date: '2025-12-05', accountId: 'acc-1' },
      { id: '3', title: 'Amazon', amount: 75, type: 'expense', category: 'shopping', paymentMethod: 'amex', date: '2025-12-10', accountId: 'cc-1' },
    ];

    test('should filter by type = income', () => {
      const filtered = transactions.filter(t => t.type === 'income');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe('Salary');
    });

    test('should filter by type = expense', () => {
      const filtered = transactions.filter(t => t.type === 'expense');
      expect(filtered).toHaveLength(2);
    });

    test('should filter by account', () => {
      const filtered = transactions.filter(t => t.accountId === 'acc-1');
      expect(filtered).toHaveLength(2);
    });

    test('should filter by search query', () => {
      const query = 'amazon';
      const filtered = transactions.filter(t => 
        t.title.toLowerCase().includes(query.toLowerCase())
      );
      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe('Amazon');
    });
  });

  describe('Sorting', () => {
    const transactions: Transaction[] = [
      { id: '1', title: 'T1', amount: 100, type: 'expense', category: 'food', paymentMethod: 'bank-transfer', date: '2025-12-15' },
      { id: '2', title: 'T2', amount: 300, type: 'expense', category: 'shopping', paymentMethod: 'amex', date: '2025-12-10' },
      { id: '3', title: 'T3', amount: 200, type: 'expense', category: 'food', paymentMethod: 'cash', date: '2025-12-20' },
    ];

    test('should sort by date newest first', () => {
      const sorted = [...transactions].sort((a, b) => b.date.localeCompare(a.date));
      expect(sorted[0].id).toBe('3'); // Dec 20
      expect(sorted[2].id).toBe('2'); // Dec 10
    });

    test('should sort by date oldest first', () => {
      const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
      expect(sorted[0].id).toBe('2'); // Dec 10
      expect(sorted[2].id).toBe('3'); // Dec 20
    });

    test('should sort by amount highest first', () => {
      const sorted = [...transactions].sort((a, b) => b.amount - a.amount);
      expect(sorted[0].amount).toBe(300);
      expect(sorted[2].amount).toBe(100);
    });

    test('should sort by amount lowest first', () => {
      const sorted = [...transactions].sort((a, b) => a.amount - b.amount);
      expect(sorted[0].amount).toBe(100);
      expect(sorted[2].amount).toBe(300);
    });
  });
});

