/**
 * Transaction Classification Tests
 * Tests the smart logic for classifying transactions as income, expense, or transfer
 */

import { Transaction, PaymentAccount } from '@/types';

// Helper function to classify transactions (mirrors the logic in history page)
function classifyTransaction(
  transaction: Transaction,
  accounts: PaymentAccount[]
): 'income' | 'expense' | 'transfer' {
  const titleLower = transaction.title.toLowerCase();
  const linkedAccount = transaction.accountId 
    ? accounts.find(a => a.id === transaction.accountId) 
    : null;
  const isCreditCard = linkedAccount?.type === 'credit_card';
  
  // Internal transfers between accounts - don't count in totals
  if (titleLower.includes('transfer from') || titleLower.includes('transfer to') || 
      titleLower.includes('online transfer')) {
    return 'transfer';
  }
  
  // Credit card payments - also transfers (from bank to card)
  const paymentKeywords = ['payment', 'autopay', 'auto pay'];
  if (isCreditCard && paymentKeywords.some(kw => titleLower.includes(kw))) {
    return 'transfer';
  }
  
  // Real deposits/income
  if (titleLower.includes('deposit') || titleLower.includes('direct dep') || 
      titleLower.includes('payroll') || titleLower.includes('salary')) {
    return 'income';
  }
  
  return transaction.type === 'income' ? 'income' : 'expense';
}

// Helper to determine display sign
function getDisplaySign(
  transaction: Transaction,
  accounts: PaymentAccount[]
): { isPositive: boolean; amount: string } {
  const titleLower = transaction.title.toLowerCase();
  const linkedAccount = transaction.accountId 
    ? accounts.find(a => a.id === transaction.accountId) 
    : null;
  const isCreditCard = linkedAccount?.type === 'credit_card';
  const isLoan = linkedAccount?.type === 'personal_loan';
  const isDebtAccount = isCreditCard || isLoan;
  
  const paymentKeywords = ['payment', 'autopay', 'auto pay', 'statement credit'];
  const isPaymentByName = paymentKeywords.some(kw => titleLower.includes(kw));
  
  const isTransferIn = titleLower.includes('transfer from') || titleLower.includes('online transfer from');
  const isTransferOut = titleLower.includes('transfer to') || titleLower.includes('online transfer to');
  const isDeposit = titleLower.includes('deposit') || titleLower.includes('direct dep');
  
  let isPositive = transaction.type === 'income';
  
  if (isTransferIn || isDeposit) {
    isPositive = true;
  } else if (isTransferOut) {
    isPositive = false;
  } else if (isDebtAccount && isPaymentByName) {
    isPositive = true;
  }
  
  return {
    isPositive,
    amount: `${isPositive ? '+' : '-'}$${transaction.amount.toLocaleString()}`
  };
}

describe('Transaction Classification', () => {
  const mockAccounts: PaymentAccount[] = [
    {
      id: 'checking-1',
      name: 'Chase Checking',
      type: 'bank_account',
      provider: 'chase',
      balance: 5000,
      color: '#1e88e5',
      isActive: true,
    },
    {
      id: 'savings-1',
      name: 'Chase Savings',
      type: 'bank_account',
      provider: 'chase',
      balance: 10000,
      color: '#43a047',
      isActive: true,
    },
    {
      id: 'credit-1',
      name: 'AMEX Card',
      type: 'credit_card',
      provider: 'amex',
      balance: -1500,
      creditLimit: 10000,
      color: '#7c3aed',
      isActive: true,
    },
    {
      id: 'loan-1',
      name: 'Upstart Loan',
      type: 'personal_loan',
      provider: 'other',
      balance: -5000,
      color: '#ef4444',
      isActive: true,
    },
  ];

  describe('Transfer Detection', () => {
    test('should classify "Online Transfer from" as transfer', () => {
      const txn: Transaction = {
        id: '1',
        title: 'Online Transfer from Checking 7535',
        amount: 500,
        type: 'expense',
        category: 'other',
        paymentMethod: 'bank-transfer',
        accountId: 'savings-1',
        date: '2025-12-01',
      };

      expect(classifyTransaction(txn, mockAccounts)).toBe('transfer');
    });

    test('should classify "Online Transfer to" as transfer', () => {
      const txn: Transaction = {
        id: '2',
        title: 'Online Transfer to Checking 7535',
        amount: 500,
        type: 'expense',
        category: 'other',
        paymentMethod: 'bank-transfer',
        accountId: 'savings-1',
        date: '2025-12-01',
      };

      expect(classifyTransaction(txn, mockAccounts)).toBe('transfer');
    });

    test('should classify credit card payment as transfer', () => {
      const txn: Transaction = {
        id: '3',
        title: 'Payment Thank You',
        amount: 1500,
        type: 'income',
        category: 'other',
        paymentMethod: 'bank-transfer',
        accountId: 'credit-1', // On credit card
        date: '2025-12-01',
      };

      expect(classifyTransaction(txn, mockAccounts)).toBe('transfer');
    });

    test('should classify autopay as transfer on credit card', () => {
      const txn: Transaction = {
        id: '4',
        title: 'AutoPay Payment',
        amount: 500,
        type: 'income',
        category: 'other',
        paymentMethod: 'bank-transfer',
        accountId: 'credit-1',
        date: '2025-12-01',
      };

      expect(classifyTransaction(txn, mockAccounts)).toBe('transfer');
    });
  });

  describe('Income Detection', () => {
    test('should classify direct deposit as income', () => {
      const txn: Transaction = {
        id: '5',
        title: 'Direct Deposit - ACME Corp',
        amount: 5000,
        type: 'income',
        category: 'salary',
        paymentMethod: 'bank-transfer',
        accountId: 'checking-1',
        date: '2025-12-01',
      };

      expect(classifyTransaction(txn, mockAccounts)).toBe('income');
    });

    test('should classify payroll as income', () => {
      const txn: Transaction = {
        id: '6',
        title: 'Payroll Deposit',
        amount: 3000,
        type: 'income',
        category: 'salary',
        paymentMethod: 'bank-transfer',
        accountId: 'checking-1',
        date: '2025-12-01',
      };

      expect(classifyTransaction(txn, mockAccounts)).toBe('income');
    });

    test('should classify salary as income', () => {
      const txn: Transaction = {
        id: '7',
        title: 'Salary Payment',
        amount: 4500,
        type: 'income',
        category: 'salary',
        paymentMethod: 'bank-transfer',
        accountId: 'checking-1',
        date: '2025-12-01',
      };

      expect(classifyTransaction(txn, mockAccounts)).toBe('income');
    });
  });

  describe('Expense Detection', () => {
    test('should classify regular purchase as expense', () => {
      const txn: Transaction = {
        id: '8',
        title: 'Amazon Purchase',
        amount: 150,
        type: 'expense',
        category: 'shopping',
        paymentMethod: 'credit',
        accountId: 'credit-1',
        date: '2025-12-01',
        merchant: 'Amazon',
      };

      expect(classifyTransaction(txn, mockAccounts)).toBe('expense');
    });

    test('should classify restaurant charge as expense', () => {
      const txn: Transaction = {
        id: '9',
        title: 'Starbucks Coffee',
        amount: 6.50,
        type: 'expense',
        category: 'food',
        paymentMethod: 'debit',
        accountId: 'checking-1',
        date: '2025-12-01',
        merchant: 'Starbucks',
      };

      expect(classifyTransaction(txn, mockAccounts)).toBe('expense');
    });
  });

  describe('Display Sign Logic', () => {
    test('should show + for transfer FROM (money coming in)', () => {
      const txn: Transaction = {
        id: '10',
        title: 'Online Transfer from Checking 7535',
        amount: 500,
        type: 'expense',
        category: 'other',
        paymentMethod: 'bank-transfer',
        accountId: 'savings-1',
        date: '2025-12-01',
      };

      const result = getDisplaySign(txn, mockAccounts);
      expect(result.isPositive).toBe(true);
      expect(result.amount).toBe('+$500');
    });

    test('should show - for transfer TO (money going out)', () => {
      const txn: Transaction = {
        id: '11',
        title: 'Online Transfer to Checking 7535',
        amount: 500,
        type: 'expense',
        category: 'other',
        paymentMethod: 'bank-transfer',
        accountId: 'savings-1',
        date: '2025-12-01',
      };

      const result = getDisplaySign(txn, mockAccounts);
      expect(result.isPositive).toBe(false);
      expect(result.amount).toBe('-$500');
    });

    test('should show + for credit card payment (reduces debt)', () => {
      const txn: Transaction = {
        id: '12',
        title: 'Payment - Thank You',
        amount: 1500,
        type: 'income',
        category: 'other',
        paymentMethod: 'bank-transfer',
        accountId: 'credit-1',
        date: '2025-12-01',
      };

      const result = getDisplaySign(txn, mockAccounts);
      expect(result.isPositive).toBe(true);
      expect(result.amount).toBe('+$1,500');
    });

    test('should show + for deposits', () => {
      const txn: Transaction = {
        id: '13',
        title: 'Direct Deposit',
        amount: 5000,
        type: 'income',
        category: 'salary',
        paymentMethod: 'bank-transfer',
        accountId: 'checking-1',
        date: '2025-12-01',
      };

      const result = getDisplaySign(txn, mockAccounts);
      expect(result.isPositive).toBe(true);
      expect(result.amount).toBe('+$5,000');
    });

    test('should show - for regular expenses', () => {
      const txn: Transaction = {
        id: '14',
        title: 'Grocery Store',
        amount: 150,
        type: 'expense',
        category: 'groceries',
        paymentMethod: 'debit',
        accountId: 'checking-1',
        date: '2025-12-01',
      };

      const result = getDisplaySign(txn, mockAccounts);
      expect(result.isPositive).toBe(false);
      expect(result.amount).toBe('-$150');
    });
  });

  describe('Totals Calculation', () => {
    test('transfers should not count in income or expense totals', () => {
      const transactions: Transaction[] = [
        {
          id: '15',
          title: 'Online Transfer from Checking',
          amount: 500,
          type: 'expense',
          category: 'other',
          paymentMethod: 'bank-transfer',
          accountId: 'savings-1',
          date: '2025-12-01',
        },
        {
          id: '16',
          title: 'Online Transfer to Checking',
          amount: 500,
          type: 'expense',
          category: 'other',
          paymentMethod: 'bank-transfer',
          accountId: 'savings-1',
          date: '2025-12-02',
        },
      ];

      let income = 0;
      let expenses = 0;

      transactions.forEach(txn => {
        const classification = classifyTransaction(txn, mockAccounts);
        if (classification === 'income') {
          income += txn.amount;
        } else if (classification === 'expense') {
          expenses += txn.amount;
        }
        // 'transfer' transactions don't count
      });

      expect(income).toBe(0);
      expect(expenses).toBe(0);
    });

    test('real income and expenses should count in totals', () => {
      const transactions: Transaction[] = [
        {
          id: '17',
          title: 'Direct Deposit',
          amount: 5000,
          type: 'income',
          category: 'salary',
          paymentMethod: 'bank-transfer',
          accountId: 'checking-1',
          date: '2025-12-01',
        },
        {
          id: '18',
          title: 'Grocery Store',
          amount: 150,
          type: 'expense',
          category: 'groceries',
          paymentMethod: 'debit',
          accountId: 'checking-1',
          date: '2025-12-02',
        },
      ];

      let income = 0;
      let expenses = 0;

      transactions.forEach(txn => {
        const classification = classifyTransaction(txn, mockAccounts);
        if (classification === 'income') {
          income += txn.amount;
        } else if (classification === 'expense') {
          expenses += txn.amount;
        }
      });

      expect(income).toBe(5000);
      expect(expenses).toBe(150);
    });
  });
});

